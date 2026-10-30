// What a player does with a live economy, from an app: list the shop and the boxes, buy, open a box and collect what
// it rolled, pay, buy tickets, stake and harvest, craft, enter a contest, bid in an auction, claim a grant, see their
// collectibles.
// Browser-safe, no Solana SDK. The player's wallet signs every transaction; this module never holds a key (a craft's
// new collectibles get fresh keys made here, which sign only their own creation; a box's settle is signed by a
// throwaway key the open funded with just enough for its fee, which hands the rest back in the same transaction).
//
//   import { solanaApp, walletStandardSigner } from '@xgamesfun/solana/play';
//   const app = solanaApp({ spec, rpcUrl: 'https://api.devnet.solana.com', wallet: walletStandardSigner(wallet, account) });
//   const items = await app.shop();               // [{ key, name, price, priceUnits, currency, left }]
//   const { asset } = await app.buy('sword', { listing: items[0] });  // the price shown is the most it pays
//   const { won } = await app.openBox('chest', { listing });           // waits for the roll, settles it: one prompt
//   for (const c of await app.claims()) await app.claim(c);   // what this player can finish: wins, payouts, refunds
//   await app.claimWins({ server, token });         // prizes a results server vouched for
//
// Nothing here waits on a server. Whatever a player is owed, they can take themselves (`claims`), and public work
// that is due rides along in the next player's own transaction (an empty lottery round is moved on by the next
// ticket buyer).
//
// `spec` is the live xsolana.json (its `live` section names the project). `wallet` is { address, signTransaction(wire) →
// signed wire }: `walletStandardSigner` makes one from a Wallet Standard wallet (Phantom, Solflare, Backpack).
import { decodeBase58, encodeBase58 } from '../chain/base58.js';
import { ownedAssetFilters, parseCoreAsset } from '../chain/core.js';
import { ASSOCIATED_TOKEN_PROGRAM, associatedTokenAddress, COMPUTE_BUDGET_PROGRAM, NATIVE_MINT, SYSVAR_SLOT_HASHES, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { closeTokenAccount, computeUnitLimit, createAssociatedTokenAccountIdempotent, requestHeapFrame, syncNative, transferLamports, withSolWrap } from '../chain/programs.js';
import { checkCluster, notMainnet, rpcClient } from '../chain/rpc.js';
import { MEMO_PROGRAM, mintPowers, resolveTransfers } from '../chain/token2022.js';
import { compileFitting, closeTableIx, deactivateTableIx, readTable, sendFitting, sendPlan, slotHashes, tablesOf, tableStep, transactionLocks, LOOKUP_TABLE_PROGRAM } from '../chain/lookup.js';
import { compileMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const CHAIN = 'solana:devnet';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MPL_CORE = loot.MPL_CORE_PROGRAM;
const NOBODY = '11111111111111111111111111111111';
/** A table made this many slots ago whose transaction never landed was never sent: its blockhashes ran out long since. */
const TABLE_UNSENT_SLOTS = 300n;
/** A compressed NFT's `prove_leaf`: its record stays good while the leaf is unchanged, so it may go in a transaction of its own first. */
const PROVE_LEAF = loot.IDL.instructions.find((i) => i.name === 'prove_leaf').discriminator;
const isProveLeaf = (ix) => ix.programId === loot.LOOT_PROGRAM && PROVE_LEAF.every((b, i) => ix.data[i] === b);
/** A system account must keep this much (rent for 0 bytes) or be emptied. */
const RENT_EMPTY = 890_880n;
const SIGNATURE_FEE = 5_000n;
/** What a box's open puts in its throwaway key: its one signature's fee, and the rent it must hold until then. */
const BURNER_LAMPORTS = RENT_EMPTY + SIGNATURE_FEE;

/** A signer from a Wallet Standard wallet and one of its accounts: the wallet signs, the app sends. */
export function walletStandardSigner(wallet, account, chain = CHAIN) {
  const feature = wallet.features?.['solana:signTransaction'];
  if (!feature) throw new Error(`${wallet.name} cannot sign transactions.`);
  return {
    address: account.address,
    async signTransaction(wire) {
      const [out] = await feature.signTransaction({ account, transaction: wire, chain });
      return out.signedTransaction;
    },
  };
}

/** A fresh ed25519 key (WebCrypto) that signs only its own account's creation: a crafted collectible's. */
async function freshKey() {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  return { address: encodeBase58(raw), sign: async (message) => new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', pair.privateKey, message)) };
}

/**
 * An amount in whole units of a token ("12", "0.5", or a number) in its base units. Only a plain decimal is taken, with
 * at most the token's decimals: "0x10", "1.2.3", "", "1e3", "-1" and an extra decimal place are refused, never read as
 * some other amount.
 */
export const units = (amount, decimals) => {
  const text = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? plainNumber(amount) : typeof amount === 'string' ? amount.trim() : null;
  const m = text === null ? null : /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`${typeof amount === 'string' ? JSON.stringify(amount) : String(amount)} is not an amount: write a plain number like 12 or 0.5.`);
  const fraction = m[2] ?? '';
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error(`${text} has more decimals than the token's ${decimals}.`);
  return BigInt(m[1] + fraction.padEnd(decimals, '0').slice(0, decimals));
};
/** A number as plain decimal text (1e-7 → "0.0000001"). */
const plainNumber = (n) => (/e/i.test(String(n)) ? n.toFixed(20).replace(/\.?0+$/, '') : String(n));
const show = (u, decimals) => {
  const s = BigInt(u).toString().padStart(decimals + 1, '0');
  const f = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${s.slice(0, s.length - decimals)}${f ? `.${f}` : ''}`;
};

/**
 * `client`, kept to devnet: a URL that names mainnet is refused at once, and before its first request goes out the
 * chain's genesis block is checked, once (`checkCluster`), so an RPC whose URL hides mainnet or testnet is refused
 * whatever it says. Every RPC reached over http(s) is checked: the app's own client, and one given whose `url` is
 * http(s). A client with no such URL (a local chain of the caller's own, like the tests' LiteSVM) is used as it is.
 */
function devnetOnly(client) {
  if (typeof client.url === 'string') notMainnet(client.url);
  if (!/^(https?|wss?):/i.test(String(client.url ?? ''))) return client;
  let checked = null;
  // A check that could not be made (the network did not answer) is made again on the next request.
  const ready = () => (checked ??= checkCluster(client).catch((e) => {
    checked = null;
    throw e;
  }));
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? async (...args) => {
        await ready();
        return value.apply(target, args);
      } : value;
    },
  });
}

/**
 * The player's side of a live economy. `rpc` may be given instead of `rpcUrl` (any object with the client's rpc
 * methods: accounts, account, latestBlockhash, send, confirm, programAccounts, and call(method, params), the raw JSON
 * RPC request the devnet check, the slot and the compressed-NFT reads go through). `now` is the clock auctions are read
 * by (Unix seconds). Devnet only (`devnetOnly`): mainnet waits for an audit.
 */
export function solanaApp({ spec, rpcUrl = 'https://api.devnet.solana.com', rpc = null, wallet, programs = {}, now = () => Math.floor(Date.now() / 1000) }) {
  const live = spec?.live;
  if (!live?.project) throw new Error('This economy is not live yet: its xsolana.json has no "live" section.');
  if (rpc && typeof rpc.call !== 'function') throw new Error('The rpc given has no call(method, params): a custom rpc needs it (the devnet check, the slot and compressed NFTs are read through it), as well as accounts, account, latestBlockhash, send, confirm and programAccounts.');
  const client = devnetOnly(rpc ?? rpcClient(notMainnet(rpcUrl)));
  const project = live.project;
  /** The project's Core collections: an NFT of one of them is the project's own (a project may have none). */
  const collections = live.collections ?? (live.collection ? [live.collection] : []);
  const ours = (collection) => collection != null && collections.includes(collection);
  const tokens = new Map((spec.tokens ?? []).map((t) => [t.key, t]));
  const currencyKey = spec.currency;
  const mintOf = (key) => {
    const t = tokens.get(key ?? currencyKey);
    if (!t) throw new Error(`No token “${key}”.`);
    return t.source === 'sol' ? NATIVE_MINT : spec.live.mints?.[t.key] ?? t.mint;
  };
  const decimalsOf = (key) => {
    const t = tokens.get(key ?? currencyKey);
    return t?.source === 'sol' ? 9 : t?.decimals ?? 0;
  };
  programs = { ...Object.fromEntries([...tokens.values()].map(t => [mintOf(t.key), t.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM])), ...programs };
  const programOf = (mint) => programs[mint] ?? TOKEN_PROGRAM;
  const part = (list, key) => {
    const p = (spec[list] ?? []).find((x) => x.key === key);
    if (!p) throw new Error(`No ${list.replace(/s$/, '')} “${key}” in this economy.`);
    return p;
  };
  const read = async (name, address) => {
    const a = await client.account(address);
    if (!a) throw new Error(`Nothing at ${address}: is the economy live on this cluster?`);
    if (a.owner !== loot.LOOT_PROGRAM) throw new Error(`${address} is not a loot account.`);
    return loot.decode(name, a.data);
  };
  /** A loot account, or null when there is none yet. */
  const readMaybe = async (name, address) => {
    const a = await client.account(address);
    return a?.owner === loot.LOOT_PROGRAM ? loot.decode(name, a.data) : null;
  };
  /** The key of the token a lottery's tickets are paid in: the spec's `ticketCurrency`, or the token of its mint. */
  const ticketCurrencyOf = (l, lottery) => l.ticketCurrency ?? [...tokens.keys()].find((k) => mintOf(k) === lottery.mint) ?? currencyKey;
  /** Farm hooks shared by all actions. Static lists resolve automatically. For dynamic hooks,
   * transfers[mint] describes every actual transfer, including fee-adjusted reward credit/payout, and in a farm that
   * shares its pool the move's last one when a seat gave rewards back in it (an early exit, a lapsed upkeep, a watched
   * NFT gone): from the farm's rewards vault back to its pool, the project the authority.
   * Explicit extra replaces resolution and must include all token hook/memo and Core adapter accounts. */
  const farmTokens = async (mints, create, { extra, transfers = {} } = {}) => {
    const selected = [...new Set(mints)];
    const resolved = await Promise.all(selected.map(async (mint) => {
      if (extra !== undefined) {
        const account = await client.account(mint);
        if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(account?.owner)) throw new Error(`There is no supported token ${mint} on this network.`);
        return { mint, tokenProgram: account.owner, extraAccounts: [] };
      }
      try {
        return { mint, ...await resolveTransfers(client, mint, transfers[mint] ?? []) };
      } catch (cause) {
        throw new Error(`Cannot resolve farm transfers for ${mint}: ${cause.message} Supply exact transfers keyed by mint, or explicit extra hook/memo accounts.`, { cause });
      }
    }));
    const tokenPrograms = { ...programs, ...Object.fromEntries(resolved.map(({ mint, tokenProgram }) => [mint, tokenProgram])) };
    return {
      programs: tokenPrograms,
      extra: extra ?? resolved.flatMap((r) => r.extraAccounts),
      before: [...new Set(create)].map((mint) => createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, mint, tokenPrograms[mint])),
    };
  };
  const farmCollection = async (asset) => {
    const account = await client.account(asset);
    // Core tombstones and missing assets remain valid farm-cleanup paths.
    return account?.owner === MPL_CORE && account.data[0] === 1
      ? parseCoreAsset(account.data).collection ?? collections[0]
      : collections[0];
  };
  /** The Core collection an asset is in, or null. */
  const collectionOf = async (asset) => {
    const account = await client.account(asset);
    return account?.owner === MPL_CORE && account.data[0] === 1 ? parseCoreAsset(account.data).collection ?? null : null;
  };
  /** A Token Metadata NFT's { programmable, ruleSet } from its metadata, or null for anything else (a Core asset). */
  const tokenMetadataOf = async (asset) => {
    const account = await client.account(asset);
    if (account?.owner !== TOKEN_PROGRAM) return null;
    return loot.decodeTokenMetadata((await client.account(loot.tokenMetadata.metadata(asset)))?.data);
  };
  /**
   * Where a Token Metadata NFT handed to `holder` goes: { into, before }. Into their associated account (`into` null)
   * while it is not there (the program opens it) or takes it; when it is there but another key owns it or it is frozen,
   * Token Metadata refuses it and the hand-out would fail for everyone (an outbid NFT bid, a cancelled round's ticket),
   * so `payer` opens a fresh account of the holder's in the same transaction (`loot.freshNftAccount`) and it goes there.
   */
  async function nftInto(asset, holder, payer) {
    const own = await client.account(loot.ata(holder, asset));
    if (!own || loot.takesNft(own, holder, asset)) return { into: null, before: [] };
    // (the rent is the fixed one for 165 bytes, never the RPC's figure: the account is the holder's)
    for (let index = 0; index < loot.FRESH_NFT_ACCOUNTS; index++) {
      const { address } = loot.freshNftAccount({ payer, holder, mint: asset, index });
      // nothing there, only lamports someone sent there, or one opened before (a hand-out that did not land) that takes it
      const fresh = loot.freshNftAccount({ payer, holder, mint: asset, index, there: await client.account(address) });
      if (fresh) return { into: fresh.address, before: fresh.instructions };
    }
    throw new Error(`${holder}'s accounts of the NFT ${asset} can't take it (owned by another key, or frozen), and no fresh one could be opened.`);
  }
  /**
   * What a route needs of an NFT, whatever its kind: { collection, hasAuthority, tokenMetadata, compressed, before }.
   * A compressed NFT (no account at its address) is read from the RPC's DAS methods (`getAsset`, `getAssetProof`),
   * which the page's RPC must offer, and proven first in the same transaction (`before`). `to`: the wallet the route
   * hands it to, when it hands it to one: a Token Metadata NFT then names the account it goes into (`nftInto`), a fresh
   * one opened by `payer` (the signer by default).
   */
  async function nftOf(asset, signer = wallet.address, { to, payer = signer } = {}) {
    const account = await client.account(asset);
    if (!account) {
      const das = await client.call('getAsset', { id: asset }).catch(() => null);
      if (das?.compression?.compressed) {
        const proof = await client.call('getAssetProof', { id: asset });
        const tree = await client.account(das.compression.tree);
        const compressed = loot.compressedFromDas({ asset: das, proof, treeData: tree.data });
        return { compressed, hasAuthority: false, before: [computeUnitLimit(1_000_000), loot.proveLeafIx({ signer, compressed })] };
      }
    }
    const tokenMetadata = await tokenMetadataOf(asset);
    // A Token Metadata mint is taken only as an NFT: one token, no decimals, none more ever minted (NotAnNft).
    if (tokenMetadata && account && !loot.isNftMint(asset, account.data)) throw new Error(`${asset} is a semi-fungible item (several units, or a mint that can still mint): only an NFT is taken.`);
    const { into, before } = tokenMetadata && to ? await nftInto(asset, to, payer) : { into: null, before: [] };
    return {
      collection: await farmCollection(asset),
      hasAuthority: ours(await collectionOf(asset)),
      tokenMetadata: tokenMetadata && into ? { ...tokenMetadata, into } : tokenMetadata,
      before: tokenMetadata ? [computeUnitLimit(400_000), ...before] : [],
    };
  }
  /**
   * What `loot.prizeMetas` needs to give these prizes (`null`s are skipped): each pool's mint, each item (its kind, its
   * collection and its next serial; null for one never written), each NFT's kind (`nfts`, and `nft` for one), the
   * project's first collection, a compressed NFT's proof, which goes first in the transaction (`before`), and for a
   * roll its box (`boxes`, null for one never written) and the mint of each pool its prizes name (`rollPools`, null for
   * one never opened): a route the player pays or asks for passes the box's prize mints (`loot.rollMints`).
   */
  async function prizeInputs(prizes, signer = wallet.address, winner = wallet.address) {
    const out = { poolMints: {}, items: {}, nfts: {}, nft: undefined, collection: collections[0], before: [], boxes: {}, rollPools: {} };
    for (const prize of prizes.filter(Boolean)) {
      const rolled = prize.Roll?.[0];
      if (rolled !== undefined && !(rolled in out.boxes)) {
        const box = (out.boxes[rolled] = await readMaybe('LootBox', loot.pda.box(project, rolled)));
        if (box) Object.assign(out.rollPools, await poolMintsOf(box));
      }
      const pool = prize.Tokens?.from.Pool?.[0];
      if (pool !== undefined && !(pool in out.poolMints)) {
        const account = await client.account(loot.pda.pool(project, pool));
        // A pool never opened gives nothing; the economy's currency stands in for its mint's place.
        out.poolMints[pool] = account ? encodeBase58(account.data.subarray(0, 32)) : mintOf();
      }
      const id = prize.Item?.[0] ?? prize.Compressed?.item;
      if (id !== undefined && !(id in out.items)) out.items[id] = await readMaybe('Item', loot.pda.item(project, id));
      // An NFT of a stash, or one a lottery's place holds in the lottery's own stash.
      const asset = prize.Nft?.nft ?? prize.Held?.[0];
      if (asset && !out.nfts[asset]) {
        const { before, hasAuthority: _, ...nft } = await nftOf(asset, signer, { to: winner });
        out.nfts[asset] = out.nft = nft;
        out.before.push(...before);
      }
    }
    return out;
  }
  /** The Sheet the project keeps of an NFT it has no authority over: { key: value } of what the project wrote. */
  const sheetOf = async (nft) => {
    const found = await client.account(loot.pda.sheet(project, nft));
    return Object.fromEntries((loot.decodeSheet(found?.owner === loot.LOOT_PROGRAM ? found.data : null)?.attributes ?? []).map((a) => [a.key, a.value]));
  };
  let projectState = null;
  const projectNow = async () => (projectState ??= await read('Project', project));
  /** A spec auction's address: it names the seller, which xsolana.json records once it is live. */
  const auctionAt = (a) => {
    if (!a.seller) throw new Error(`The auction “${a.key}” has no seller in xsolana.json: publish the economy again.`);
    return loot.pda.auction(project, a.seller, a.id);
  };

  const itemKeyOf = (id) => (spec.items ?? []).find((it) => it.id === Number(id))?.key ?? null;
  /** Who holds a collectible now. */
  const ownerOf = async (asset) => parseCoreAsset((await client.account(asset)).data).owner;
  /** `{ asset, farm }` for a Core asset on its seat in one of the economy's farms of these custodies, or null. */
  const seatedIn = async (asset, custodies = ['escrow', 'freeze']) => {
    for (const f of (spec.farms ?? []).filter((x) => x.stakes === 'collectibles' && custodies.includes(x.custody ?? 'escrow'))) {
      if (await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset))) return { asset, farm: f.id };
    }
    return null;
  };
  /** The same for one the project holds: staked in escrow. */
  const escrowedIn = async (asset) => ((await ownerOf(asset).catch(() => null)) === project ? seatedIn(asset, ['escrow']) : null);
  /** The player's collectibles of this project (in any of its collections), each with the item it is (its "item_id" attribute). */
  async function owned(owner = wallet?.address) {
    const found = (await Promise.all(collections.map((c) => client.programAccounts(MPL_CORE, ownedAssetFilters(owner, c))))).flat();
    return found.map(({ pubkey, account }) => {
      const a = parseCoreAsset(account.data);
      const itemId = a.attributes?.item_id !== undefined ? Number(a.attributes.item_id) : null;
      return { asset: pubkey, ...a, itemId, item: itemId === null ? null : itemKeyOf(itemId) };
    });
  }
  /**
   * For a gate (the program's Gate: a Rule an NFT must pass, or a list of wallets), one of the player's NFTs that
   * passes it, so a page needn't find it; null when nothing is to be shown. A rule naming a collection the project has no
   * authority over finds the player's Core assets of it (with what the project wrote in their Sheets); a Token Metadata NFT
   * is not looked for: pass it as `shown: { mint, owner }`. Throws a plain sentence when none passes, or the wallet is not on the list.
   * A stake gate shows nothing: the client passes the wallet's seat in its farm; here it is only read, to say plainly
   * when it holds too little or its lock is over (the program counts a stake only while its tier's lock runs, and
   * only one made before this second).
   */
  async function passing(gate, what) {
    if (!gate) return null;
    // A list is passed with a proof, not an NFT (`listProofOf`).
    if (gate.List) return null;
    if (gate.Staked) {
      const { farm, at_least: atLeast } = gate.Staked;
      const seat = await readMaybe('Seat', loot.pda.seat(farm, wallet.address));
      const f = (spec.farms ?? []).find((x) => loot.pda.farm(project, x.id) === farm);
      const t = f ? tokens.get(f.stakes) : null;
      const needs = t ? `${show(atLeast, decimalsOf(t.key))} ${t.symbol ?? t.key}` : `${atLeast} (in base units)`;
      const where = f ? `“${f.name}”` : 'its farm';
      if (!seat || BigInt(seat.amount) < BigInt(atLeast)) throw new Error(`You need at least ${needs} staked in ${where} to ${what}.`);
      // Only a locked stake counts: its tier's lock still running.
      const lock = BigInt((await read('Farm', farm)).tiers[seat.tier]?.lock ?? 0);
      if (lock === 0n || BigInt(now()) >= BigInt(seat.since) + lock) throw new Error(`Your stake in ${where} counts only while it is locked: stake in a tier with a lock (staking again starts a new one) to ${what}.`);
      return null;
    }
    if (gate.Wallets) {
      if (gate.Wallets[0].includes(wallet.address)) return null;
      throw new Error(`Only the wallets this names may ${what}.`);
    }
    // A farm's gate is a list of rules one NFT must all pass; any other gate one rule.
    const rules = Array.isArray(gate) ? gate : [gate.Holds ? gate.Holds[0] : gate];
    if (!rules.length) return null;
    const rule = rules[0];
    const atLeast = rule.test?.AtLeast?.[0];
    const equals = rule.test?.Equals?.text;
    const item = rule.of?.Item?.[0];
    const named = rules.map((r) => r.of?.Collection?.[0]).find((c) => c && !ours(c));
    const other = named ?? null;
    const passes = (r, c) => {
      if (r.of?.Item?.[0] !== undefined && c.itemId !== Number(r.of.Item[0])) return false;
      const value = c.attributes?.[r.key];
      if (r.test?.AtLeast?.[0] !== undefined) return Number(value) >= Number(r.test.AtLeast[0]);
      if (r.test?.Equals?.text !== undefined) return String(value) === String(r.test.Equals.text);
      return true;
    };
    const pass = (c) => rules.every((r) => passes(r, c));
    if (other) {
      const found = await client.programAccounts(MPL_CORE, ownedAssetFilters(wallet.address, other));
      for (const { pubkey, account } of found) {
        const a = parseCoreAsset(account.data);
        if (pass({ attributes: { ...a.attributes, ...(await sheetOf(pubkey)) } })) return { asset: pubkey };
      }
      throw new Error(`You need an NFT of the collection ${other}${atLeast !== undefined ? ` with ${rule.key} ${atLeast} or more` : equals !== undefined ? ` whose ${rule.key} is ${equals}` : ''} to ${what}.`);
    }
    const found = (await owned()).find(pass);
    if (found) return found.asset;
    const needs = item !== undefined ? `a ${(spec.items ?? []).find((it) => it.id === Number(item))?.name ?? 'collectible of this project'}` : 'a collectible of this project';
    throw new Error(`You need ${needs}${atLeast !== undefined ? ` with ${rule.key} ${atLeast} or more` : equals !== undefined ? ` whose ${rule.key} is ${equals}` : ''} to ${what}.`);
  }

  /**
   * For a list gate (`List`: a Merkle root of wallets, `sha256("loot-list-v1" | wallet)`), the proof that the player is
   * on it: `given` (as a page or a results server hands it over), or made from the wallets xsolana.json lists for the part
   * (`list`, its gate's `list`). Undefined for any other gate. Throws a plain sentence when the wallet is not on it.
   */
  function listProofOf(gate, list, given) {
    if (!gate?.List) return undefined;
    if (given) return given;
    if (!(list ?? []).includes(wallet.address)) throw new Error('This wallet is not on the list for this.');
    // The list as the plan wrote its root: filled to a power of two (`gateList`).
    return loot.gateList(list).proofOf(wallet.address);
  }

  /**
   * SOL paid out to the player (a prize, rewards, a refund, a grant) lands in their wrapped-SOL account: close it at
   * the end, so the player keeps plain SOL. When the transaction pays into it and nothing opens it first, the player
   * opens it here (the program would otherwise open it, unseen), and has the rent back at the close.
   */
  async function unwrapAfter(instructions) {
    const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
    const opens = instructions.some((ix) => ix.programId === ASSOCIATED_TOKEN_PROGRAM && ix.keys[1]?.pubkey === wrapped);
    const closes = instructions.some((ix) => ix.programId === TOKEN_PROGRAM && ix.data?.[0] === 9 && ix.keys[0]?.pubkey === wrapped);
    if (closes) return instructions;
    const close = closeTokenAccount(wrapped, wallet.address, wallet.address);
    if (opens || (await client.account(wrapped))) return [...instructions, close];
    const touches = instructions.some((ix) => ix.keys?.some((k) => k.pubkey === wrapped));
    return touches ? [createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, NATIVE_MINT), ...instructions, close] : instructions;
  }

  /**
   * Build, have the wallet sign, send and confirm. Extra signers (fresh keys) sign first. Returns the signature.
   * `keepWrapped`: leave the player's wrapped-SOL account open (a bid's: what is topped comes back there).
   * Its size is checked before the wallet signs (`sendFitting`): a transaction too big for a legacy one goes as one v0
   * transaction with a lookup table the wallet makes first (one to three more approvals, and the table's rent until the
   * player closes it, which `claims()` lists); only when even that is too big does each compressed NFT's `prove_leaf`
   * go alone, after the table and before the rest.
   */
  async function send(instructions, extra = [], { keepWrapped = false } = {}) {
    if (!wallet?.address) throw new Error('Connect a wallet first.');
    if (!keepWrapped) instructions = await unwrapAfter(instructions);
    const sign = async (message) => {
      const { signers } = readTransaction(wireTransaction(message));
      const sigs = await Promise.all(signers.map(async (s) => (extra.find((k) => k.address === s) ? extra.find((k) => k.address === s).sign(message) : new Uint8Array(64))));
      return wallet.signTransaction(wireTransaction(message, sigs));
    };
    // The project first in a table, so claims() knows a table whose later steps were never sent as this project's.
    return (await sendFitting({ rpc: client, payer: wallet.address, instructions, sign, alone: isProveLeaf, first: [project] }).catch(inWords)).signature;
  }

  /**
   * Throws `e` with loot's reason in words in place of a bare code: a wallet whose own dry run failed often says only
   * "custom program error: 0x17b5". A code is loot's when the logs name loot as the program that failed, or, with no
   * logs, when it is one of loot's (Anchor's codes start at 6000; the token programs' are small).
   */
  function inWords(e) {
    const said = String(e?.message ?? '');
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(said);
    const failed = e?.logs?.find((line) => / failed: custom program error: 0x/i.test(line));
    const known = m && (!failed || failed.includes(loot.LOOT_PROGRAM)) ? loot.ERRORS[parseInt(m[1], 16)] : null;
    if (!known) throw e;
    throw Object.assign(new Error(`${known.msg} (${known.name}).`, { cause: e }), { code: parseInt(m[1], 16), name: known.name, logs: e.logs });
  }

  /**
   * Build, sign with `key` alone (it pays), send and confirm: a throwaway key's transaction. No wallet prompt. Legacy
   * only: the key holds no rent for a lookup table.
   */
  async function sendAs(key, instructions) {
    return (await sendFitting({ rpc: client, payer: key.address, instructions, sign: async (message) => wireTransaction(message, [await key.sign(message)]), table: false }).catch(inWords)).signature;
  }

  /**
   * Refuses, in words, to stake `asset` in tier `tier` of farm `f` when its unstake (with the tier's prize, and as a
   * forfeit) couldn't be sent even as a v0 transaction with a lookup table, its proof sent first (`sendPlan`).
   */
  async function exitFits(f, farm, asset, nft, before, tier, staking) {
    const prize = farm.tiers[tier]?.prize ?? null;
    const given = await prizeInputs([prize]);
    // The rewards' accounts as the stake resolved them (a hook that needs each transfer named is sized without them).
    const token = { ...staking, before: [createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, farm.rewards_mint, staking.programs[farm.rewards_mint] ?? TOKEN_PROGRAM)] };
    const exit = (forfeit) => [...before, ...(forfeit ? [] : [...given.before, ...token.before]), loot.unstakeNftIx({ player: wallet.address, project, id: f.id, farm, asset, ...nft, forfeit, roll: farm.tiers[tier]?.roll ?? null, nonce: 1n, tier, projectCollection: given.collection, poolMints: given.poolMints, items: given.items, nft: given.nft, ...token })];
    for (const forfeit of [false, true]) {
      const instructions = exit(forfeit).filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM);
      if (!sendPlan({ payer: wallet.address, instructions: [computeUnitLimit(1_400_000), ...instructions], alone: isProveLeaf }))
        throw new Error(`Not staked: this NFT couldn't come back out of “${f.name ?? f.key}”. Its unstake${forfeit ? ', even giving up the rewards,' : ''} would lock more accounts than one transaction can (${transactionLocks(wallet.address, [computeUnitLimit(1_400_000), ...instructions], { asV0: true })} with its lookup table; at most 64), so it would stay in the farm.`);
    }
  }

  /** An NFT's kind as a route's `ticket` or `nft` takes it: without its asset. */
  const kindOnly = ({ asset: _, ...kind }) => kind;

  /** A throwaway key's leftover back to the player: all it holds less its own fee, so the key ends empty. */
  const giveBack = (burner) => transferLamports(burner.address, wallet.address, BURNER_LAMPORTS - SIGNATURE_FEE);

  /**
   * Waits for an order's roll (the oracle answers a moment after the open), then settles it. With `burner` (the
   * throwaway key the open funded), the burner signs and pays the settle, and gives the rest back: no wallet prompt.
   * Anyone may settle a rolled order: when someone did first, the burner only gives its lamports back. `putBack`: NFTs
   * won that the player puts back into their stash in place of taking them (one whose collection now refuses to let it
   * move); the player signs that settle.
   */
  async function collect(orderAddress, options = {}) {
    only(options, ['timeoutMs', 'burner', 'putBack', 'opened', 'landed'], 'collect');
    try {
      return await collectOnce(orderAddress, options);
    } catch (e) {
      // The throwaway key is never left holding the player's SOL: whatever stopped the collect (a roll not in yet, a
      // settle someone else sent first), it gives its lamports back before the error is said. Collecting again later
      // needs no burner: the player signs that settle.
      const { burner } = options;
      if (!burner) throw e;
      // All it holds now. While it can pay its own fee and stay rent-exempt until the transfer empties it, it sends it
      // itself; after a settle of its that failed on chain (its fee taken) it holds only its rent, and the player's
      // wallet pays the fee of the transaction that empties it (one more prompt, only then).
      const left = BigInt(await client.balance(burner.address).catch(() => 0n));
      if (left >= BURNER_LAMPORTS) await sendAs(burner, [transferLamports(burner.address, wallet.address, left - SIGNATURE_FEE)]).catch(() => null);
      else if (left > 0n) await send([transferLamports(burner.address, wallet.address, left)], [burner]).catch(() => null);
      if (!(await client.account(orderAddress))) return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
      throw e;
    }
  }

  async function collectOnce(orderAddress, { timeoutMs = 60_000, burner = null, putBack = [], opened = false, landed = null } = {}) {
    const started = Date.now();
    // `landed`: the slot one's own open landed in; the order is read from a node that has seen it.
    const current = async () => {
      const account = await client.account(orderAddress, 'confirmed', landed != null ? { minContextSlot: landed } : {});
      return account?.owner === loot.LOOT_PROGRAM ? loot.decode('Order', account.data) : null;
    };
    let order = await current();
    // Right after one's own confirmed open, no order is "not seen yet", never "settled already": a node of the RPC may
    // lag behind the one that confirmed it. It is read again for a few seconds first.
    for (let i = 0; !order && opened && i < 6; i++) {
      await sleep(1000);
      order = await current();
    }
    // A roll a mission or a recipe made waits to be asked for (or asked again, the oracle never having answered):
    // anyone asks, here the player.
    if (order && loot.rollAskable(order, await slotNow())) {
      await askRoll(orderAddress);
      order = await current();
    }
    while (['Pending', 'Asked'].includes(order?.status) && Date.now() - started < timeoutMs) {
      await sleep(1500);
      order = await current();
    }
    if (!order) {
      if (burner) await sendAs(burner, [giveBack(burner)]);
      // One's own open still not seen after that: say so plainly, never that it was settled (claims() lists it).
      if (opened) return { order: orderAddress, settled: null, says: 'The network doesn’t show this order yet: collect it again in a moment (claims() lists it).' };
      return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
    }
    if (order.status === 'Pending') throw new Error('The oracle has not rolled yet: try collecting again in a minute (an order never rolled refunds after about 10 minutes).');
    if (order.status === 'Asked') throw new Error('The oracle has not rolled yet: try collecting again in a minute (a roll never answered is asked again after about 10 minutes).');
    if (order.status === 'Failed') throw new Error('The roll failed (the box changed or ran out): refund the order.');
    // An order closes only in a later slot than the one it was opened in.
    for (let i = 0; i < 20 && client.call; i++) {
      const slot = BigInt(await client.call('getSlot', [{ commitment: 'confirmed' }]));
      if (slot > order.requested_slot) break;
      await sleep(400);
    }
    const g = await projectNow();
    // What the roll set aside: each item it gave (its kind and collection) and each NFT's kind (a compressed one
    // proven first).
    const items = {};
    for (const won of order.won) if (won.Item && !(won.Item.item in items)) items[won.Item.item] = await read('Item', loot.pda.item(project, won.Item.item));
    const holders = await holdersOf(order.shares);
    // Given by its fate to a wallet that is an account of the loot program, the NFT goes back to the player.
    const gives = order.held ? order.fate?.then?.Give?.[0] : undefined;
    const handBack = gives !== undefined && loot.handsBack(await client.account(gives));
    /** The settle as `signer` sends it, and what goes before it: each compressed NFT's proof, a fresh token account. */
    const settleBy = async (signer) => {
      const nfts = {};
      const proving = [];
      for (const won of order.won) {
        if (won.Nft && !putBack.includes(won.Nft.nft)) {
          // A Token Metadata NFT's settle is the wallet's to send (it pays rent: `paysRent`), so the wallet opens any fresh account.
          const { before, hasAuthority: _, ...kind } = await nftOf(won.Nft.nft, signer, { to: order.player, payer: wallet.address });
          nfts[won.Nft.nft] = kind;
          proving.push(...before);
        }
      }
      // The NFT the roll was on: its kind, and for a compressed one a proof first.
      const { before: subjectProof, ...subject } = order.subject !== NOBODY ? await nftOf(order.subject, signer) : { before: [] };
      const ix = loot.settleIx({ signer, orderAddress, order, projectState: g, items, nfts, putBack, subject, handBack, holders, programs });
      return { ix, nfts, before: [...subjectProof, ...proving].filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM) };
    };
    // Room for every move the shape makes (`loot.settleComputeUnits`), and for a settle of several NFTs the bigger heap
    // the program's allocator uses (`loot.settleHeapFrame`).
    const heap = loot.settleHeapFrame(order);
    const budget = [computeUnitLimit(loot.settleComputeUnits(order)), ...(heap ? [requestHeapFrame(heap)] : [])];
    // The settle opens any account it pays into that is not there, paid by whoever signs it. A burner holds no rent
    // to spare: the open made the player's accounts of the prizes' mints and of the payees, so it settles alone unless
    // the settle pays rent of its own (a roll won makes an order; a Token Metadata NFT goes into a new token account),
    // needs a proof first, or doesn't fit a legacy transaction (a lookup table's rent is the wallet's to pay). An NFT put
    // back into its stash (one its collection no longer lets move) is the player's own choice: they sign.
    let signature;
    const byBurner = burner && !putBack.length ? await settleBy(burner.address) : null;
    const paysRent = (built) => order.won.some((w) => w.Roll || (w.Nft && built.nfts[w.Nft.nft]?.tokenMetadata));
    const alone = byBurner && !paysRent(byBurner) && !byBurner.before.length ? [...budget, byBurner.ix, giveBack(burner)] : null;
    // The burner's transaction counts its compute limit: a settle within about 40 bytes of the legacy limit goes from the
    // wallet (one prompt) rather than without one, as a settle with the default limit can run out (205,794 units on
    // devnet) and the burner holds the fee of one try only.
    if (alone && compileFitting({ payer: burner.address, blockhash: NOBODY, instructions: alone })) signature = await sendAs(burner, alone);
    else {
      // The wallet's settle: as a v0 transaction with a lookup table when it doesn't fit a legacy one (`send`).
      const { ix, before } = await settleBy(wallet.address);
      signature = await send([...budget, ...before, ix]);
      if (burner) await sendAs(burner, [giveBack(burner)]);
    }
    const assets = wonAssets(orderAddress, order).map((a) => (putBack.includes(a) ? null : a));
    return { order: orderAddress, won: order.won, assets, settled: signature, ...(assets.find(Boolean) ? { asset: assets.find(Boolean) } : {}) };
  }

  /**
   * For each prize an order won, what it is now: the collectible minted (`["asset", item, serial]`), the NFT handed
   * over, the order a roll won is made in; null for tokens. A normal item is the project's backend's to deliver.
   */
  function wonAssets(orderAddress, order) {
    return order.won.map((won, k) => {
      if (won.Item) return loot.pda.itemAsset(loot.pda.item(project, won.Item.item), won.Item.serial);
      if (won.Nft) return won.Nft.nft;
      if (won.Roll) return loot.pda.order(project, order.player, loot.rollNonce(orderAddress, order.requested_slot, k));
      return null;
    });
  }

  /** A nonce for an order no other order of the player's is at. */
  const freshNonce = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

  /** The mint of each pool a box's tokens come from (null for a pool not opened). */
  async function poolMintsOf(box) {
    const prizePools = [...new Set(box.entries.flatMap((e) => e.prizes).map((p) => p.Tokens?.from.Pool?.[0]).filter((p) => p !== undefined))];
    const pools = prizePools.length ? await client.accounts(prizePools.map((p) => loot.pda.pool(project, p))) : [];
    return Object.fromEntries(prizePools.map((p, i) => [p, pools[i] ? encodeBase58(pools[i].data.subarray(0, 32)) : null]));
  }

  /** Asks the oracle for a roll a mission, a recipe or a prize made (`Waiting`): the player pays the oracle. */
  async function askRoll(orderAddress) {
    const order = await read('Order', orderAddress);
    const box = await read('LootBox', order.loot_box);
    const poolMints = await poolMintsOf(box);
    return send([computeUnitLimit(400_000), ...loot.askRollIx({ payer: wallet.address, orderAddress, order, box, poolMints, programs })]);
  }

  /**
   * The most the player agreed to pay for `box`, in base units: `maxPrice` (base units), or the `listing` that
   * `shop()` or `boxes()` showed them (its `priceUnits`). Never the price read now: a price the owner or other buyers
   * moved since the player saw it would be paid without their say. A price above it is refused here, in words, before
   * the wallet is asked.
   */
  function boundOf(box, name, { maxPrice, listing } = {}, key) {
    if (listing && key !== undefined && listing.key !== undefined && listing.key !== key) throw new Error(`That listing is “${listing.key}”, not “${key}”.`);
    const given = maxPrice ?? listing?.priceUnits;
    if (given === undefined || given === null) throw new Error(`Say the most the player agreed to pay for “${name}”: pass the listing shop() or boxes() showed (listing), or maxPrice in base units. The price read now is never the bound.`);
    const bound = BigInt(given);
    if (BigInt(box.price) > bound) throw new Error(`The price of “${name}” is now ${show(box.price, decimalsOf(box.currencyKey))}, more than the ${show(bound, decimalsOf(box.currencyKey))} the player was shown: show them the new price first.`);
    return bound;
  }

  /**
   * Refuses an option a method doesn't take, so a misspelled or outdated one fails here instead of being ignored (a page
   * passing `{ choice }` for a referrer would send every referral share to the treasury). `options`: what the method
   * was given, or what is left of it once the options it takes are read; `takes`: those it takes, said in the error.
   */
  function only(options, takes, method) {
    const unknown = Object.keys(options ?? {}).filter((k) => !takes.includes(k) && options[k] !== undefined);
    if (!unknown.length) return;
    const hint = unknown.includes('choice') && takes.includes('chosenRecipient') ? ' (a buyer’s choice is `chosenRecipient`)' : '';
    throw new Error(`${method} doesn’t take ${unknown.map((k) => `“${k}”`).join(', ')}${hint}. It takes: ${takes.join(', ')}.`);
  }
  /** What `buy` and `openBox` take: a box bought at once (`buyBox`) or opened (`open`). */
  const BOX_OPTIONS = ['shown', 'listProof', 'maxPrice', 'listing', 'chosenRecipient', 'on', 'oneSignature'];

  /**
   * Buys a box that needs no roll (a shop item, a bundle: one entry, nothing random, no NFT rolled on) in one
   * transaction: the price is split and every prize given at once, with no order to settle. `shown` (an NFT for its
   * gate), `listProof` (for a list gate), `chosenRecipient` (the wallet, or collectible, a share the box lets the buyer
   * name goes to). Returns { signature, assets }: for each prize, the collectible minted or the NFT given (null for
   * tokens or a normal item), and for a roll the order it is made in.
   */
  async function buyBox(boxId, part, { shown = null, listProof, maxPrice, listing, chosenRecipient = null } = {}) {
    const g = await projectNow();
    const box = await read('LootBox', loot.pda.box(project, boxId));
    const bound = boundOf({ ...box, currencyKey: part?.currency }, part?.name ?? `box ${boxId}`, { maxPrice, listing }, part?.key);
    shown ??= await passing(box.gate, 'buy this');
    listProof = listProofOf(box.gate, part?.gate?.list, listProof);
    const mint = box.currency;
    const [entry] = box.entries;
    const given = await prizeInputs(entry.prizes);
    const nonce = freshNonce();
    const choosesHolder = box.shares.some((s) => s.to.Chosen && s.to.Chosen.item != null);
    const holders = await holdersOf(loot.chosenShares(box.shares, chosenRecipient));
    const ix = loot.buyIx({ player: wallet.address, project, box, maxPrice: bound, treasury: g.treasury, chosenRecipient, chosen: choosesHolder ? chosenRecipient : null, nonce, shown, listProof, items: given.items, poolMints: given.poolMints, nfts: given.nfts, boxes: given.boxes, rollPools: given.rollPools, holders, programs });
    const made = {};
    const assets = entry.prizes.map((prize, k) => {
      if (prize.Item) {
        const id = prize.Item[0];
        const item = given.items[id];
        made[id] = (made[id] ?? 0) + 1;
        return item?.kind === 'Collectible' ? loot.pda.itemAsset(loot.pda.item(project, id), Number(item.issued) + made[id]) : null;
      }
      if (prize.Nft) return prize.Nft.nft;
      if (prize.Roll) return loot.pda.order(project, wallet.address, loot.prizeRollNonce(nonce + BigInt(k)));
      return null;
    });
    const signature = await send(withSolWrap(wallet.address, mint, box.price, [computeUnitLimit(600_000), ...given.before.filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM), ix]));
    return { signature, assets, ...(assets.find(Boolean) ? { asset: assets.find(Boolean) } : {}) };
  }

  /**
   * Opens a box that rolls. `oneSignature` (the default): the same transaction funds a throwaway key with its settle's
   * fee, and makes the player's account of each mint the box's tokens are in, so the settle needs no second wallet
   * prompt. `chosenRecipient`: the wallet (or collectible) the player names for a share the box lets them choose (a
   * referrer, a plot). `on`: the NFT a box that rolls on one takes (an NFT whose price it is, a sword to enchant).
   * `listProof`: for a list gate.
   */
  async function open(boxId, part, { shown = null, on = null, maxPrice, listing, oneSignature = true, chosenRecipient = null, listProof } = {}) {
    const g = await projectNow();
    const box = await read('LootBox', loot.pda.box(project, boxId));
    const bound = boundOf({ ...box, currencyKey: part?.currency }, part?.name ?? `box ${boxId}`, { maxPrice, listing }, part?.key);
    // A box that rolls on an NFT takes the one the player brings (`on`), whatever its kind.
    if (box.subject && !on) throw new Error('This box rolls on an NFT: say which (on).');
    const brought = box.subject ? await nftOf(on) : { before: [] };
    const { before: proving, hasAuthority, ...kind } = brought;
    const subject = box.subject ? { asset: on, hasAuthority, ...kind, collection: kind.collection ?? (await collectionOf(on)) ?? MPL_CORE } : undefined;
    if (!box.subject) shown ??= await passing(box.gate, 'buy this');
    listProof = listProofOf(box.gate, part?.gate?.list, listProof);
    const mint = box.currency;
    // A roll that moves the numbers of the NFT it rolls on is at that NFT's nonce: one at a time on it.
    const nonce = box.subject && loot.boxHolds(box) ? loot.nonceOn(on) : freshNonce();
    // Each pool's mint, and each mint tokens are minted from: what is won waits in the project's vault for its mint.
    const poolMints = await poolMintsOf(box);
    const minted = box.entries.flatMap((e) => e.prizes).map((p) => p.Tokens?.from.Mint?.[0]).filter(Boolean);
    const prizeMints = [...new Set([...Object.values(poolMints).filter(Boolean), ...minted])];
    const choosesHolder = box.shares.some((s) => s.to.Chosen && s.to.Chosen.item != null);
    const chosen = chosenRecipient && choosesHolder ? chosenRecipient : null;
    const ix = loot.openBoxIx({ player: wallet.address, project, box, nonce, maxPrice: bound, shown, listProof, subject, chosenRecipient, chosen, poolMints, programs });
    const before = [...proving, createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, mint, programOf(mint))];
    // (A compressed NFT's proof brings its own compute limit, the transaction's only one.)
    let burner = null;
    let solPrize = false;
    if (oneSignature) {
      // The burner's settle pays no rent: the player opens here every account it will pay into (their prize's, and
      // each wallet a share of the sale pays: a referrer, a plot's holder, the treasury).
      burner = await freshKey();
      for (const prizeMint of prizeMints) {
        solPrize ||= prizeMint === NATIVE_MINT;
        before.push(createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, prizeMint, programOf(prizeMint)));
      }
      const shares = loot.chosenShares(box.shares, chosenRecipient);
      const holders = await holdersOf(shares);
      const payees = shares.flatMap((s) => (s.to === 'Treasury' ? [g.treasury] : s.to.Wallet ? [s.to.Wallet[0]] : s.to.Holder && holders[s.to.Holder[0]] ? [holders[s.to.Holder[0]]] : []));
      const paid = new Set([g.treasury, ...payees]);
      for (const payee of paid) before.push(createAssociatedTokenAccountIdempotent(wallet.address, payee, mint, programOf(mint)));
      // A sale that pays the player themselves (the owner buying from their own shop) pays into their wrapped-SOL
      // account: it stays open for the settle too.
      solPrize ||= mint === NATIVE_MINT && paid.has(wallet.address);
    }
    const after = burner ? [transferLamports(wallet.address, burner.address, BURNER_LAMPORTS)] : [];
    // A SOL prize, or a share of the sale, lands in the player's wrapped-SOL account, which the prompt-less settle
    // can't open: it stays open, and the player's next transaction unwraps it.
    let instructions = withSolWrap(wallet.address, mint, box.price, [...before, ix, ...after]);
    if (solPrize) instructions = instructions.filter((x) => !(x.programId === TOKEN_PROGRAM && x.data?.[0] === 9 && x.keys[0]?.pubkey === associatedTokenAddress(wallet.address, NATIVE_MINT)));
    const signature = await send(instructions, [], { keepWrapped: solPrize });
    // The slot it landed in: the order is read from a node that has seen it (a load-balanced RPC's node lagging
    // behind answers nothing for an order just opened).
    const landed = (await client.signatureStatus?.(signature).catch(() => null))?.slot ?? null;
    return { signature, orderAddress: loot.pda.order(project, wallet.address, nonce), burner, landed };
  }

  /**
   * A prize of a share of a pool that comes to nothing is refused when it is given at once (a buy's, a craft's:
   * PrizeNotCovered): say the pool is empty before the player signs.
   */
  async function poolShareGiven(prizes) {
    for (const p of prizes) {
      const bps = p?.Tokens?.amount.Bps?.[0];
      const pool = p?.Tokens?.from.Pool?.[0];
      if (bps === undefined || pool === undefined) continue;
      const data = (await client.account(loot.pda.pool(project, pool)))?.data;
      const held = data ? data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
      if ((held * BigInt(bps)) / 10_000n === 0n) throw new Error(`Its prize is a share of pool ${pool}, and the pool is empty: nothing to give yet.`);
    }
  }

  /**
   * Holds the listing the player was shown against the one listed now: refused, in words, when none is given, when it
   * is of another NFT or another kind of deal (`Sell`, `Rent`), and when its terms differ from those listed now (the
   * program would refuse them too: TermsChanged).
   */
  async function shownListing(asset, listing, kind) {
    if (!listing) throw new Error('Say the terms the player was shown: pass the listing listing() or listings() showed (listing). The listing read now is never signed in its place.');
    if (listing.asset !== asset) throw new Error(`That listing is of ${listing.asset}, not ${asset}.`);
    if (!listing.deal?.[kind]) throw new Error(kind === 'Sell' ? 'That listing is for rent, not for sale.' : 'That listing is for sale, not for rent.');
    const listed = await readMaybe('Listing', loot.pda.listing(project, asset));
    if (!listed) throw new Error(`${asset} is not listed any more.`);
    const [was, is] = [loot.listingTerms(listing), loot.listingTerms(listed)];
    if (was.some((b, i) => b !== is[i])) throw new Error('This listing has changed since the player was shown it: show them its terms as they are now first.');
  }

  /** A box bought at once when it needs no roll (`buyBox`), or opened and collected. */
  async function buyOrOpen(boxId, part, options) {
    const box = await read('LootBox', loot.pda.box(project, boxId));
    if (!loot.boxRolls(box.entries) && !box.subject) {
      await poolShareGiven(box.entries.flatMap((e) => e.prizes ?? []));
      return buyBox(boxId, part, options);
    }
    const { orderAddress, burner, landed } = await open(boxId, part, options);
    return collect(orderAddress, { burner, opened: true, landed });
  }

  /** The current slot (an order's deadlines count in slots). */
  const slotNow = async () => BigInt(await client.call('getSlot', [{ commitment: 'confirmed' }]));
  /** The slots the SlotHashes sysvar holds now (a lookup table closes once its deactivation slot has left them). */
  const recentSlots = async () => slotHashes((await client.account(SYSVAR_SLOT_HASHES))?.data);
  /** The chain's clock (Unix seconds), read from its Clock sysvar; the computer's (`now`) when it can't be read. */
  const chainNow = async () => {
    const clock = await client.account('SysvarC1ock11111111111111111111111111111111').catch(() => null);
    if (!clock?.data || clock.data.length < 40) return BigInt(now());
    const v = clock.data.subarray(32, 40).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n);
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  };

  /**
   * Refuses a stake a farm would refuse (`FarmOver`) before anything is signed: a farm with an end takes none at its end
   * or after it, nor one at a tier whose lock would run past it. `f` is the spec's farm, `farm` the decoded one.
   */
  async function openFor(f, farm, tier) {
    const at = await chainNow();
    if (loot.farmOpenFor(farm, tier, at)) return;
    const ends = new Date(Number(farm.ends_at) * 1000).toISOString();
    if (at >= BigInt(farm.ends_at)) throw new Error(`“${f.name ?? f.key}” ended at ${ends}: it takes no stake any more. Stakes in it can still leave and harvest.`);
    throw new Error(`“${f.name ?? f.key}” ends at ${ends}, and lock tier ${tier} would run past it: stake at a tier with a shorter lock.`);
  }

  /** Who holds each collectible a split's holder shares name now: { asset: holder }. */
  async function holdersOf(shares) {
    const holders = {};
    for (const s of shares) if (s.to.Holder) holders[s.to.Holder[0]] = await ownerOf(s.to.Holder[0]).catch(() => null);
    return holders;
  }

  /**
   * A lottery's current round: the lottery, its purchases ([{ address, value }], each a LotteryContribution; every one
   * still there is of this round), and for a drawn round whose purchases are all finished, the winning purchases still
   * to be paid ([{ contribution, winner }]).
   */
  async function roundOf(l) {
    const address = loot.pda.lottery(project, l.id);
    const lottery = await read('Lottery', address);
    const found = await client.programAccounts(loot.LOOT_PROGRAM, [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.LotteryContribution)) } }, { memcmp: { offset: 1, bytes: address } }]);
    const contributions = found.map(({ pubkey, account }) => ({ address: pubkey, value: loot.decode('LotteryContribution', account.data) }));
    if (lottery.status !== 'Drawn' || BigInt(lottery.pending) > 0n) return { lottery, contributions, winners: [] };
    // Once every purchase is finished, those left are the winners not paid yet.
    const winners = contributions.filter(({ value }) => value.done).map((contribution) => ({ contribution, winner: contribution.value.player }));
    return { lottery, contributions, winners };
  }

  return {
    project,
    get address() {
      return wallet?.address ?? null;
    },

    /** The shop: every item with a price (or free), its price now and what is left. */
    async shop() {
      const items = (spec.items ?? []).filter((it) => Number.isInteger(it.shopBox));
      const accounts = await client.accounts(items.flatMap((it) => [loot.pda.box(project, it.shopBox), loot.pda.item(project, it.id)]));
      return items.map((it, i) => {
        const box = accounts[2 * i] && loot.decode('LootBox', accounts[2 * i].data);
        const item = accounts[2 * i + 1] && loot.decode('Item', accounts[2 * i + 1].data);
        const dec = decimalsOf(currencyKey);
        return { key: it.key, name: it.name, price: box ? show(box.price, dec) : null, priceUnits: box?.price ?? null, currency: tokens.get(currencyKey)?.symbol ?? currencyKey, active: Boolean(box?.active && item?.active), left: item?.max_supply ? item.max_supply - item.issued : null };
      });
    },

    /** The boxes: price now and each outcome's chance. */
    async boxes() {
      const list = spec.boxes ?? [];
      const accounts = await client.accounts(list.map((b) => loot.pda.box(project, b.id)));
      return list.map((b, i) => {
        const box = accounts[i] && loot.decode('LootBox', accounts[i].data);
        const total = box ? box.entries.reduce((n, e) => n + e.weight, 0) : 0;
        return { key: b.key, name: b.name, price: box ? show(box.price, decimalsOf(b.currency)) : null, priceUnits: box?.price ?? null, currency: tokens.get(b.currency ?? currencyKey)?.symbol, active: Boolean(box?.active), outcomes: (b.outcomes ?? []).map((o, j) => ({ ...o, chancePercent: box ? (100 * box.entries[j].weight) / total : o.chance })) };
      });
    },

    /**
     * Buys a shop item, in one transaction (`buy`: the price split and the item given at once). A listing that rolls
     * (an NFT at random, or one it rolls on) is opened and settled instead. Returns { signature, assets, asset } for a
     * purchase, or what `collect` returns for an open.
     */
    async buy(itemKey, options = {}) {
      only(options, BOX_OPTIONS, 'buy');
      const it = part('items', itemKey);
      if (!Number.isInteger(it.shopBox)) throw new Error(`“${it.name}” is not in the shop.`);
      return buyOrOpen(it.shopBox, it, options);
    },

    /**
     * Opens a box (shows a collectible for its gate or odds when given): a box that needs no roll is bought at once
     * (`buy`); one that rolls waits for the roll and collects it.
     */
    async openBox(boxKey, options = {}) {
      only(options, BOX_OPTIONS, 'openBox');
      const b = part('boxes', boxKey);
      return buyOrOpen(b.id, b, options);
    },

    /** Collects an order opened earlier (its roll arrived after the app stopped waiting). */
    collect,

    /** Gives an order's payment back once its time has come (a roll that failed or never came). */
    async refund(orderAddress) {
      const order = await read('Order', orderAddress);
      // An NFT the project held for the roll goes back.
      const { before = [], hasAuthority: _, ...subject } = order.held ? await nftOf(order.subject, wallet.address, { to: order.player }) : {};
      return send([...before, loot.refundIx({ signer: wallet.address, orderAddress, order, subject, programs })]);
    },

    /** Asks the oracle for a roll a mission, a recipe or a prize made (anyone may; the asker pays the oracle). */
    askRoll: (orderAddress) => askRoll(orderAddress),

    /**
     * Pays a payment of the economy (an entry, an attempt, a tip). `amount`: what the player chose, in whole units, for
     * a payment with `any` (at least its `amount`). `chosenRecipient`: the wallet the player names for a share the
     * payment lets them choose (a referrer), never their own. `holders`: asset → holder, for a holder's share (read
     * now when not given).
     */
    async pay(paymentKey, { amount: chosen, holders, chosenRecipient = null, ...others } = NO_OPTIONS) {
      only(others, ['amount', 'holders', 'chosenRecipient'], 'pay');
      const p = part('payments', paymentKey);
      const g = await projectNow();
      const mint = mintOf(p.currency);
      const least = units(p.amount, decimalsOf(p.currency));
      if (chosen !== undefined && !p.any) throw new Error(`“${p.name}” has a set amount: ${p.amount}.`);
      const amount = chosen === undefined ? least : units(chosen, decimalsOf(p.currency));
      if (amount < least || amount <= 0n) throw new Error(`“${p.name}” takes at least ${p.amount}.`);
      const pools = new Map((spec.pools ?? []).map((x) => [x.key, x.index]));
      // `pay` takes its shares from the payer each time: a "chosen" share pays the wallet they name, and with none named
      // it is left out, so what it would pay goes to the treasury with the rest (as a purchase's does).
      if (chosenRecipient && chosenRecipient === wallet.address) throw new Error('A payer can’t name their own wallet for a share they choose.');
      const shares = (p.split ?? []).flatMap((s) => {
        const [kind, key] = s.to.split(':');
        const bps = Math.round(s.percent * 100);
        if (kind === 'chosen' && key) throw new Error(`“${p.name}” pays the holder of a “${key}” the payer names: a payment can’t check the collectible, so its split takes a chosen wallet only.`);
        if (kind === 'chosen') return chosenRecipient ? [{ to: { Wallet: [chosenRecipient] }, bps }] : [];
        const pot = (lotteryKey) => loot.pda.pot(loot.pda.lottery(project, part('lotteries', lotteryKey).id));
        const to = kind === 'burn' ? 'Burn' : kind === 'pool' ? { Pool: [pools.get(key)] } : kind === 'account' ? { Account: [key] } : kind === 'wallet' ? { Wallet: [key] } : kind === 'treasury' ? 'Treasury' : kind === 'lottery' ? { Account: [pot(key)] } : { Holder: [key] };
        return [{ to, bps }];
      });
      holders ??= shares.some((x) => x.to.Holder) ? await holdersOf(shares) : undefined;
      const ix = loot.payIx({ player: wallet.address, project, mint, treasury: g.treasury, amount, shares, holders, programs });
      return send(withSolWrap(wallet.address, mint, amount, [ix]));
    },

    /**
     * Pays with one of the player's NFTs, any kind (`pay_nft`): burned (`to` null), or given to the wallet `to` (the
     * treasury, a partner), straight from the player. The receipt (`PaidNft`) is the record an app admits the player
     * by, with `reference` (32 bytes, or text the client hashes). Returns the signature.
     */
    async payNft(asset, { to = null, reference, ...others } = NO_OPTIONS) {
      only(others, ['to', 'reference'], 'payNft');
      // An NFT paid goes to a wallet: never the project's address or an account of the program (ToTheProject).
      if (to && (to === project || (await client.account(to))?.owner === loot.LOOT_PROGRAM)) throw new Error('An NFT paid can’t go to the project or an account of the program: name a wallet, or burn it.');
      const { before, ...nft } = await nftOf(asset);
      return send([...before, loot.payNftIx({ player: wallet.address, project, asset, to, ...nft, reference })]);
    },

    /**
     * The lotteries: each one's ticket price now, its round and status, and its terms (`incarnation`, `revision`),
     * which `buyTickets` takes as the terms the player was shown. A lottery not written yet (a raffle still to open)
     * has a null price.
     */
    async lotteries() {
      const list = spec.lotteries ?? [];
      const accounts = await client.accounts(list.map((l) => loot.pda.lottery(project, l.id)));
      return list.map((l, i) => {
        const lottery = accounts[i]?.owner === loot.LOOT_PROGRAM ? loot.decode('Lottery', accounts[i].data) : null;
        const currency = lottery ? ticketCurrencyOf(l, lottery) : l.ticketCurrency ?? currencyKey;
        return {
          key: l.key, name: l.name, price: lottery ? show(lottery.price, decimalsOf(currency)) : null, priceUnits: lottery?.price ?? null,
          currency: tokens.get(currency)?.symbol ?? currency, status: lottery?.status ?? null, round: lottery?.round ?? null, sold: lottery?.sold ?? null,
          drawsAt: lottery ? Number(lottery.draws_at) : null, nftTicket: Boolean(lottery?.nft_ticket), incarnation: lottery?.incarnation ?? null, revision: lottery?.revision ?? null,
        };
      });
    },

    /**
     * Buys `count` tickets of a lottery, on the terms the player was shown: `listing`, the lottery as `lotteries()`
     * showed it (a lottery changed since, its price or anything else, is refused rather than paid), or `maxPrice`, the
     * most a ticket may cost, in base units. One of them is required: the price read now is never the bound.
     * `chosenRecipient`: the wallet (or collectible) the player names for a share the lottery lets them choose (a
     * referrer). A lottery whose ticket costs an NFT (`nft_ticket`) sells one ticket for one of the player's NFTs that
     * passes its rule: `nft`, its address (held by the project until the draw, then burned, given on or stashed; back to
     * the player if the round is cancelled). `listProof`: for a list gate.
     */
    async buyTickets(lotteryKey, count = 1, { shown, chosenRecipient = null, listProof, nft: paidWith, listing, maxPrice, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'chosenRecipient', 'listProof', 'nft', 'listing', 'maxPrice'], 'buyTickets');
      const l = part('lotteries', lotteryKey);
      const name = l.name ?? lotteryKey;
      if (listing && listing.key !== undefined && listing.key !== l.key) throw new Error(`That listing is “${listing.key}”, not “${l.key}”.`);
      const given = maxPrice ?? listing?.priceUnits;
      if (given === undefined || given === null) throw new Error(`Say the terms the player was shown for “${name}”: pass the lottery lotteries() showed (listing), or maxPrice (a ticket's most, in base units). The price read now is never the bound.`);
      const current = await read('Lottery', loot.pda.lottery(project, l.id));
      // The terms signed are those shown: a lottery written again or changed since is refused here, and by the
      // program (TermsChanged) if it changes after this read.
      if (listing && (listing.incarnation == null || listing.revision == null)) throw new Error(`That listing of “${name}” names no terms (incarnation, revision): pass the lottery lotteries() showed.`);
      if (listing && (BigInt(listing.incarnation) !== BigInt(current.incarnation) || Number(listing.revision) !== Number(current.revision))) throw new Error(`“${name}” has changed since the player was shown it: show them the lottery as it is now first.`);
      const lottery = listing ? { ...current, incarnation: BigInt(listing.incarnation), revision: Number(listing.revision) } : current;
      const currency = ticketCurrencyOf(l, lottery);
      if (BigInt(lottery.price) > BigInt(given)) throw new Error(`A ticket of “${name}” now costs ${show(lottery.price, decimalsOf(currency))}, more than the ${show(BigInt(given), decimalsOf(currency))} the player was shown: show them the new price first.`);
      if (lottery.status === 'Ended') throw new Error(`“${l.name}” has drawn and ended.`);
      shown ??= await passing(lottery.gate, 'buy a ticket');
      listProof = listProofOf(lottery.gate, l.gate?.list, listProof);
      let nft;
      const before = [];
      if (lottery.nft_ticket) {
        if (!paidWith) throw new Error(`A ticket of “${l.name}” costs an NFT: say which (nft).`);
        if (BigInt(count) !== 1n) throw new Error('An NFT pays for one ticket at a time.');
        const { before: proof, ...kind } = await nftOf(paidWith);
        nft = { asset: paidWith, ...kind };
        before.push(...proof);
      }
      const mint = l.ticketCurrency ? mintOf(l.ticketCurrency) : lottery.mint;
      const choosesHolder = lottery.shares.some((s) => s.to.Chosen && s.to.Chosen.item != null);
      const nonce = freshNonce();
      const ix = loot.buyTicketsIx({ player: wallet.address, project, id: l.id, lottery, mint, count: BigInt(count), nonce, shown, listProof, chosenRecipient, chosen: choosesHolder ? chosenRecipient : null, nft, programs });
      // A round that reached its date with no ticket sold moves on by itself when a ticket is bought.
      const due = lottery.status === 'Open' && BigInt(now()) >= BigInt(lottery.draws_at);
      if (due && BigInt(lottery.sold) > 0n) throw new Error('This round’s draw is due: reveal it first (claims() lists it), then buy for the next one.');
      // A ticket paid with an NFT: its way out must land too, the NFT handed on at the draw or back to its
      // buyer when the round is cancelled, each sized before the NFT goes in.
      if (nft) {
        const g = await projectNow();
        const contribution = { player: wallet.address, asset: paidWith, done: false, round: lottery.round, count: 1n, shares: lottery.shares };
        const contributionAddress = loot.pda.contribution(loot.pda.lottery(project, l.id), wallet.address, nonce);
        for (const status of ['Drawn', 'Cancelled']) {
          const exit = [computeUnitLimit(1_400_000), ...before.filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM), loot.finishLotteryContributionIx({ payer: wallet.address, project, id: l.id, lottery: { ...lottery, status }, contributionAddress, contribution, treasury: g.treasury, ticket: kindOnly(nft), programs })];
          if (!sendPlan({ payer: wallet.address, instructions: exit, alone: isProveLeaf }))
            throw new Error(`Not bought: this NFT couldn't come out of “${l.name}” again (${status === 'Drawn' ? 'handed on at the draw' : 'back to you if the round is cancelled'}): that transaction would lock more accounts than one can (${transactionLocks(wallet.address, exit, { asV0: true })} with its lookup table; at most 64), so it would stay with the lottery.`);
        }
      }
      return send([...before, ...withSolWrap(wallet.address, mint, lottery.price * BigInt(count), [ix])]);
    },

    /**
     * Writes an NFT's traits from the project's traits tree (`traits` in the spec) into its Sheet, where rules read them:
     * anyone may, paying the Sheet's rent. `attributes` ([{ key, value }]) and `proof` come from the project's tree
     * (`loot.traitsTree`); `key` names the tree (a collection's address), the spec's first when left out. Traits the
     * Sheet already has are left as they are.
     */
    async proveTraits(nft, attributes, proof, key = spec.traits?.[0]?.collection) {
      return send([loot.proveTraitsIx({ signer: wallet.address, project, key, nft, attributes, proof })]);
    },

    /**
     * Stakes `amount` (whole units) of a farm's token at lock tier `tier`. A farm with an end takes no stake at its end
     * or after it, nor one whose lock would run past it: refused here, before the wallet signs.
     */
    async stake(farmKey, amount, tier = 0, { shown, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'extra', 'transfers'], 'stake');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      await openFor(f, farm, tier);
      shown ??= await passing(farm.gates, 'stake here');
      const mint = farm.farmed.Tokens.mint;
      const value = units(amount, decimalsOf(f.stakes));
      // Moving to, or topping up on, a tier whose rewards wait for its lock (an early exit) first takes what the seat
      // may take now (HarvestFirst), in the same transaction; a seat can't move to a larger exit fee while locked.
      const mine = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address));
      let harvestFirst = false;
      if (mine && BigInt(mine.amount) > 0n) {
        const [from, to] = [farm.tiers[mine.tier], farm.tiers[tier]];
        const locked = (await chainNow()) < BigInt(mine.since) + BigInt(from.lock);
        if (locked && Number(to.exit_bps) > Number(from.exit_bps)) throw new Error('While its lock runs, this stake can\'t move to a tier with a larger early-exit fee.');
        harvestFirst = Number(to.exit_bps) > 0 && !(Number(from.exit_bps) > 0 && locked);
      }
      const token = await farmTokens([mint, farm.rewards_mint], harvestFirst ? [farm.rewards_mint] : [], { extra, transfers });
      const ix = loot.stakeTokensIx({ player: wallet.address, project, id: f.id, farm, amount: value, tier, shown, ...token });
      const harvest = harvestFirst ? [...token.before, loot.harvestIx({ player: wallet.address, project, id: f.id, farm, ...token })] : [];
      // A new tier on a seat with a booster that grows: its growth so far is written first, in the same transaction.
      const seat = farm.growth.length ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address)) : null;
      const before = [];
      if (seat && seat.tier !== tier && seat.asset !== NOBODY) {
        const { before: proof, ...nft } = await nftOf(seat.asset);
        before.push(...proof, loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by: wallet.address, seat, ...nft }));
      }
      return send([...before, ...harvest, ...withSolWrap(wallet.address, mint, value, [ix])]);
    },

    /**
     * Takes `amount` out once its lock has run (0: only rewards); `forfeit` gives up rewards that cannot move. Before the
     * lock, a tier with an early exit lets it leave for its fee, and gives up what the seat is owed; in a farm that
     * unbonds, what is taken out waits first (`withdraw` takes it out once free).
     */
    async unstake(farmKey, amount = 0, { forfeit = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['forfeit', 'extra', 'transfers'], 'unstake');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const value = units(amount, decimalsOf(f.stakes));
      const mints = [...(value > 0n ? [farm.farmed.Tokens.mint] : []), ...(!forfeit ? [farm.rewards_mint] : [])];
      const token = await farmTokens(mints, mints, { extra, transfers });
      return send([...token.before, loot.unstakeTokensIx({ player: wallet.address, project, id: f.id, farm, amount: value, forfeit, ...token })]);
    },

    /**
     * Stakes one of the player's NFTs in a farm (its own seat, or as the booster of their token seat), of any kind: a
     * Core asset, a Token Metadata NFT's mint (legacy or pNFT), or a compressed NFT's asset id. In a farm that watches,
     * an NFT whose last staker sold it takes their seat over. A farm with an end takes none at its end or after it.
     */
    async stakeNft(farmKey, asset, tier = 0, { extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['extra', 'transfers'], 'stakeNft');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      await openFor(f, farm, tier);
      const token = await farmTokens([farm.rewards_mint], [], { extra, transfers });
      const { before, ...nft } = await nftOf(asset);
      const seat = farm.custody === 'Watch' && farm.farmed === 'Collectibles' ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset)) : null;
      const previous = seat && seat.player !== wallet.address ? seat.player : null;
      // A booster boosts a stake: a farm of tokens takes one only on a seat with tokens staked (NotFarmed). Putting
      // one on starts the lock again, so on a tier whose rewards wait for its lock what the seat may take now is
      // harvested first, in the same transaction (HarvestFirst).
      const harvest = [];
      if (farm.farmed.Tokens) {
        const mine = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address));
        if (!mine || BigInt(mine.amount) === 0n) throw new Error(`Stake some ${f.stakes} in “${f.name ?? f.key}” first: a booster boosts a stake.`);
        const t = farm.tiers[mine.tier];
        if (Number(t.exit_bps) > 0 && (await chainNow()) >= BigInt(mine.since) + BigInt(t.lock)) {
          const rewards = await farmTokens([farm.rewards_mint], [farm.rewards_mint], { extra, transfers });
          harvest.push(...rewards.before, loot.harvestIx({ player: wallet.address, project, id: f.id, farm, ...rewards }));
        }
      }
      // Its way out must land too: its unstake from this tier, with the tier's
      // prize and as a forfeit, is sized before it goes in, and an NFT that could never come back out isn't staked.
      if (!farm.farmed.Tokens) await exitFits(f, farm, asset, nft, before, tier, token);
      return send([...before, ...harvest, loot.stakeNftIx({ player: wallet.address, project, id: f.id, farm, asset, ...nft, previous, tier, ...token })]);
    },

    /**
     * Releases the collectible after its lock: it grows on its way out (a farm with `growth`), and from its own seat
     * takes its tier's prize (a mission: `prize.rs`). `forfeit` gives up rewards, and the prize, that cannot move.
     * Returns the signature, or { signature, roll } when it makes a roll (a mission's result on the NFT, or a chest),
     * which `collect` then finishes.
     */
    async unstakeNft(farmKey, asset, { forfeit = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['forfeit', 'extra', 'transfers'], 'unstakeNft');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const token = await farmTokens(forfeit ? [] : [farm.rewards_mint], forfeit || farm.farmed.Tokens ? [] : [farm.rewards_mint], { extra, transfers });
      // Held in escrow, it comes back into the player's account (frozen in place, it never left it).
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: farm.custody === 'Escrow' ? wallet.address : undefined });
      // Leaving a mission that rolls: its roll is made in an order of the player's, which `collect` then finishes; its
      // prize's roll (a chest) at the next nonce.
      const seat = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset));
      const roll = farm.tiers[seat.tier]?.roll ?? null;
      const prize = farm.tiers[seat.tier]?.prize ?? null;
      // A forfeit takes no prize: none of its accounts (`unstakeNftIx`).
      const given = await prizeInputs([forfeit ? null : prize]);
      // A mission's roll on the NFT is at the NFT's nonce (`nonceOn`): one at a time on it.
      const nonce = roll != null ? loot.nonceOn(asset) : freshNonce();
      const ix = loot.unstakeNftIx({ player: wallet.address, project, id: f.id, farm, asset, ...nft, forfeit, roll, nonce, tier: seat.tier, projectCollection: given.collection, poolMints: given.poolMints, items: given.items, nft: given.nft, ...token });
      const signature = await send([...before, ...given.before, ...token.before, ix]);
      if (roll != null) return { signature, roll: loot.pda.order(project, wallet.address, nonce) };
      return prize?.Roll && !forfeit ? { signature, roll: loot.pda.order(project, wallet.address, loot.prizeRollNonce(nonce + 1n)) } : signature;
    },

    /**
     * Writes what a staked collectible has grown (a farm with `growth`: its points and level, on it or in its Sheet)
     * and reads its boosts again. Anyone may send it; the player pays for what the write adds. `by`: the collectible,
     * or the player for their token seat's booster.
     */
    async refresh(farmKey, by, { extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['extra', 'transfers'], 'refresh');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const seat = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
      const held = seat.asset !== NOBODY;
      const { before, ...nft } = held ? await nftOf(seat.asset) : { before: [], hasAuthority: true };
      // Like every move, it brings the farm's rewards in (and sends back what a seat gave up): the mint's hook accounts.
      const token = await farmTokens([farm.rewards_mint], [], { extra, transfers });
      return send([...before, loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by, seat, ...nft, extra: token.extra })]);
    },

    /**
     * Collects what a seat owes (the player's own, or one of their collectibles' seats). In a farm that watches, it
     * shows the seat's NFT is still theirs: the Core asset, or their token account of a Token Metadata NFT.
     */
    async harvest(farmKey, by = wallet.address, { compound = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['compound', 'extra', 'transfers'], 'harvest');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      // A tier with an early exit keeps its rewards until its lock has run (RewardsLocked).
      if (farm.farmed.Tokens) {
        const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
        const tier = seat && farm.tiers[seat.tier];
        const ends = tier ? BigInt(seat.since) + BigInt(tier.lock) : 0n;
        if (tier && Number(tier.exit_bps) > 0 && (await chainNow()) < ends) throw new Error(`This stake can leave early, so its rewards wait for its lock: harvest after ${new Date(Number(ends) * 1000).toISOString()}. Leaving early gives them up.`);
      }
      const token = await farmTokens([farm.rewards_mint], [farm.rewards_mint], { extra, transfers });
      // In a farm that watches: what shows the seat's NFT is still the player's (a compressed one proven first).
      let [held, tree, before] = [null, null, []];
      if (farm.custody === 'Watch') {
        const { asset } = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
        if (asset !== NOBODY) {
          const nft = await nftOf(asset);
          held = nft.compressed ? loot.pda.leaf(asset) : nft.tokenMetadata ? loot.ata(wallet.address, asset) : asset;
          tree = nft.compressed?.tree ?? null;
          before = nft.compressed ? nft.before : [];
        }
      }
      return send([...before, ...token.before, loot.harvestIx({ player: wallet.address, project, id: f.id, farm, by, held, tree, compound, ...token })]);
    },

    /**
     * Adds what a token seat is owed to its stake, without restarting its lock (a farm of tokens whose rewards are the
     * staked token). The farm's toll, if any, is taken first.
     */
    async compound(farmKey, opts = {}) {
      only(opts, ['extra', 'transfers'], 'compound');
      return this.harvest(farmKey, wallet.address, { ...opts, compound: true });
    },

    /** Takes out the tokens whose unbonding wait is over (a farm with `unbond`), and what the seat is owed. */
    async withdraw(farmKey, opts = {}) {
      only(opts, ['forfeit', 'extra', 'transfers'], 'withdraw');
      return this.unstake(farmKey, 0, opts);
    },

    /**
     * The player's seats in a farm (the wallet's, or `player`'s): each one's NFT (`asset`, null for a token seat with
     * no booster), what it holds staked (`amount`, in whole units of the staked token, a number for display that can
     * round past 2^53 base units; `amountUnits`, in base units exactly, a bigint; 1 for an NFT), its tier, when it
     * came in (`since`) and when its lock is over (`freeAt`, unix seconds; null when the NFT says it, `lockKey`), its
     * boost in percent, and what it is owed now: `waiting` (whole units of the rewards, `rewards` their token) and
     * `owedUnits` (base units). What it is owed is the program's own sum, from a refresh of the seat dry-run on the
     * network (nothing is signed or sent): what the farm released or its rate paid since its last move is in it, by the
     * farm's rounding. When the dry run fails, it is what the seat was last credited, and `counted` is false.
     * One search of the chain, and one dry run per seat: read it when the page opens and after a stake or a harvest.
     */
    async staked(farmKey, player = wallet?.address) {
      if (!player) throw new Error('Connect a wallet first.');
      const f = part('farms', farmKey);
      const farmAddress = loot.pda.farm(project, f.id);
      const farm = await read('Farm', farmAddress);
      const rewards = [...tokens.values()].find((t) => mintOf(t.key) === farm.rewards_mint);
      const nfts = f.stakes === 'collectibles';
      const found = await client.programAccounts(loot.LOOT_PROGRAM, [
        { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Seat)) } },
        { memcmp: { offset: 1, bytes: farmAddress } },
        { memcmp: { offset: 33, bytes: player } },
      ]);
      const token = await farmTokens([farm.rewards_mint], []).catch(() => ({ extra: [] }));
      const { blockhash } = await client.latestBlockhash();
      // Who the dry run names as the refresh's signer and fee payer: the network wants one that holds SOL, whoever it is
      // (nothing is signed): the player, else the wallet looking, else the project's authority.
      let payer;
      const funded = async () => {
        for (const a of [player, wallet?.address, live.authority].filter(Boolean)) if ((await client.balance(a).catch(() => 0n)) > 0n) return a;
        return player;
      };
      const out = [];
      for (const { pubkey, account } of found) {
        let seat = loot.decode('Seat', account.data);
        const held = seat.asset !== NOBODY;
        let counted = false;
        try {
          payer ??= await funded();
          const { before, ...nft } = held ? await nftOf(seat.asset, payer) : { before: [] };
          const by = nfts ? seat.asset : player;
          const ix = loot.refreshSeatIx({ signer: payer, project, id: f.id, farm, by, seat, ...nft, extra: token.extra });
          const message = compileMessage({ payer, blockhash, instructions: [...before, ix] });
          const after = (await client.simulate(wireTransaction(message), { accounts: [pubkey], replaceBlockhash: true })).accounts[0];
          if (after?.data) [seat, counted] = [loot.decode('Seat', after.data), true];
        } catch {
          // The seat as it was last credited.
        }
        const lock = BigInt(farm.tiers[seat.tier]?.lock ?? 0);
        out.push({
          asset: held ? seat.asset : null,
          amount: nfts ? 1 : Number(show(seat.amount, decimalsOf(f.stakes))),
          amountUnits: nfts ? 1n : BigInt(seat.amount),
          tier: seat.tier,
          since: Number(seat.since),
          freeAt: farm.lock_key ? null : Number(BigInt(seat.since) + lock),
          ...(farm.lock_key ? { lockKey: farm.lock_key } : {}),
          boostPercent: Number(seat.boost_bps) / 100,
          rewards: rewards?.key ?? null,
          waiting: show(seat.owed, rewards ? decimalsOf(rewards.key) : 0),
          owedUnits: BigInt(seat.owed),
          counted,
        });
      }
      return out;
    },

    /** The recipes: whether each is on, and its version now (what `craft` takes as the terms the player was shown). */
    async recipes() {
      const list = spec.recipes ?? [];
      const accounts = await client.accounts(list.map((r) => loot.pda.recipe(project, r.id)));
      return list.map((r, i) => {
        const recipe = accounts[i] && loot.decode('Recipe', accounts[i].data);
        return { key: r.key, name: r.name, active: Boolean(recipe?.active), version: recipe ? recipe.version : null };
      });
    },

    /**
     * Crafts a recipe, handing in `assets` (the collectibles it burns or uses, in the recipe's order). `version`: the
     * recipe's version the page showed the player (`recipes()`, or the listing itself as `listing`), so a recipe the
     * owner changed since is refused rather than crafted on terms the player never saw. It is required: the version
     * read now is never signed in its place.
     */
    async craft(recipeKey, assets = [], times = 1, { version, listing, ...others } = NO_OPTIONS) {
      only(others, ['version', 'listing'], 'craft');
      const r = part('recipes', recipeKey);
      version ??= listing?.version ?? undefined;
      if (version === undefined || version === null) throw new Error(`Say which version of “${r.name ?? recipeKey}” the player was shown: pass the listing recipes() showed (listing), or its version. The version read now is never signed in its place.`);
      const current = await read('Recipe', loot.pda.recipe(project, r.id));
      const recipe = { ...current, version };
      await poolShareGiven(recipe.outputs.filter((o) => o.Prize).map((o) => o.Prize[0] ?? o.Prize));
      const pays = recipe.inputs.filter((i) => i.Pay).map((i) => i.Pay);
      const holders = await holdersOf(pays.map((p) => ({ to: p.to })));
      const treasury = (await projectNow()).treasury;
      // An NFT a `show` line takes, by its address: as the project's, a Core asset of another collection, or a Token
      // Metadata mint, which the craft reads differently.
      // Where the collectibles of input `i` start among those handed in.
      const at = (i) => recipe.inputs.slice(0, i).reduce((n, x) => n + (x.Burn?.count ?? (x.Use || x.Renew || x.Show || x.Staked || x.Trade ? 1 : 0)), 0);
      const shownAt = new Set(recipe.inputs.flatMap((input, i) => (input.Show ? [at(i)] : [])));
      // An NFT a `trade` line takes in, any kind: read for its kind (a compressed one proven first).
      const tradedAt = new Set(recipe.inputs.flatMap((input, i) => (input.Trade ? [at(i)] : [])));
      const proving = [];
      // A collectible used or renewed that is staked in escrow, in the project's hands: its farm, found by its seat.
      const keptAt = new Set(recipe.inputs.flatMap((input, i) => (input.Use || input.Renew ? [at(i)] : [])));
      // One a `staked` line takes: on its seat in the farm the line names, escrowed or frozen there.
      const stakedAt = new Map(recipe.inputs.flatMap((input, i) => (input.Staked ? [[at(i), input.Staked.farm]] : [])));
      const handed = await Promise.all(assets.map(async (nft, i) => {
        if (stakedAt.has(i) && typeof nft === 'string') {
          const farm = stakedAt.get(i);
          if (!(await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, farm), nft)))) {
            const name = (spec.farms ?? []).find((f) => f.id === farm)?.name ?? `farm ${farm}`;
            throw new Error(`${nft} is not staked in “${name}”, where this recipe takes it.`);
          }
          return { asset: nft, farm };
        }
        if (keptAt.has(i) && typeof nft === 'string') return (await escrowedIn(nft)) ?? nft;
        if (tradedAt.has(i) && typeof nft === 'string') {
          const { before, ...kind } = await nftOf(nft);
          proving.push(...before);
          return { asset: nft, ...kind };
        }
        if (!shownAt.has(i) || typeof nft !== 'string') return nft;
        const account = await client.account(nft);
        if (account?.owner !== MPL_CORE) return { mint: nft, owner: wallet.address };
        const theirs = await collectionOf(nft);
        return ours(theirs) ? nft : { asset: nft, collection: theirs };
      }));
      // A recipe that rolls makes its roll in an order of the player's, which `collect` then finishes.
      const rolls = recipe.outputs.some((o) => o.RollOn || o.Prize?.[0]?.Roll);
      // A roll on a collectible kept is at that collectible's nonce (`nonceOn`): one at a time on it.
      const rollOn = recipe.outputs.find((o) => o.RollOn)?.RollOn;
      const nonce = rollOn ? loot.nonceOn(typeof assets[rollOn.place] === 'string' ? assets[rollOn.place] : assets[rollOn.place].asset) : freshNonce();
      // A roll on a kept collectible (`RollOn`) passes its box's prize mints as a roll given does.
      const given = await prizeInputs(recipe.outputs.map((o) => o.Prize?.[0] ?? (o.RollOn ? { Roll: [o.RollOn.box_id] } : null)));
      // Each item a line takes passes its collection.
      const items = { ...given.items };
      for (const input of recipe.inputs) {
        const id = (input.Burn ?? input.Use ?? input.Renew ?? input.Staked)?.item;
        if (id !== undefined && !(id in items)) items[id] = await read('Item', loot.pda.item(project, id));
      }
      // The collectibles it makes, each at its item's next serial.
      const counts = {};
      const made = recipe.outputs.flatMap((o) => {
        const id = o.Prize?.[0]?.Item?.[0];
        if (id === undefined || items[id]?.kind !== 'Collectible') return [];
        counts[id] = (counts[id] ?? 0) + 1;
        return [loot.pda.itemAsset(loot.pda.item(project, id), Number(items[id].issued) + counts[id])];
      });
      const before = [...proving, ...given.before].filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM);
      let instructions = [computeUnitLimit(1_000_000), ...before, loot.craftIx({ player: wallet.address, project, collection: collections[0], id: r.id, recipe, assets: handed, times, nonce, holders, programs, treasury, poolMints: given.poolMints, items, nfts: given.nfts, boxes: given.boxes, rollPools: given.rollPools })];
      // Fuel bought for a staked collectible counts once its seat is refreshed: in the same transaction.
      for (const raise of recipe.raises ?? []) {
        const asset = assets[raise.place];
        if (typeof asset !== 'string') continue;
        for (const f of (spec.farms ?? []).filter((x) => x.upkeepAttribute === raise.key)) {
          const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset));
          if (!seat) continue;
          const farm = await read('Farm', loot.pda.farm(project, f.id));
          const { before, ...nft } = await nftOf(asset);
          instructions.push(...before, loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by: asset, seat, ...nft }));
        }
      }
      for (const p of pays) instructions = withSolWrap(wallet.address, p.mint, p.amount * BigInt(times), instructions);
      const signature = await send(instructions);
      // A roll on a collectible kept is at its nonce; a prize's roll at `prizeRollNonce` of the craft's.
      return { signature, made, ...(rolls ? { roll: loot.pda.order(project, wallet.address, rollOn ? nonce : loot.prizeRollNonce(nonce)) } : {}) };
    },

    /**
     * Hands an NFT of any kind to the project until a time (a hold): `seconds` from now, or `{ until }` (Unix seconds).
     * The hold's address names its end. Returns { signature, freeAt }.
     */
    async hold(asset, seconds) {
      const freeAt = BigInt(typeof seconds === 'object' ? seconds.until : now() + Number(seconds));
      const { before, hasAuthority: _, ...nft } = await nftOf(asset);
      const signature = await send([...before, loot.holdIx({ player: wallet.address, project, asset, ...nft, collection: nft.collection ?? (await collectionOf(asset)) ?? MPL_CORE, freeAt })]);
      return { signature, freeAt };
    },

    /**
     * A lender's offer to borrow against: `maker`'s offer number `id` in this project. Returns { address, offer, mint,
     * amount, repay, lasts, risks }: `risks`, in words, each power over the loan's token that could make repaying fail
     * (its freeze authority, a Token-2022 pause, a transfer hook, a permanent delegate) and who holds it. The program
     * takes such tokens, and a lender who holds one can stop every repayment and take the NFT once it is due: show the
     * risks before the player borrows.
     */
    async loanOffer(maker, id) {
      const address = loot.pda.offer(project, maker, id);
      const offer = await read('Offer', address);
      if (!offer.deal.Lend) throw new Error(`The offer ${address} buys NFTs; it lends nothing.`);
      const account = await client.account(offer.mint);
      if (!account) throw new Error(`The loan's token ${offer.mint} is not on this cluster.`);
      const lender = (who) => (who === maker ? ' That is the lender: they could keep you from repaying and take your NFT when the loan is due.' : '');
      const risks = mintPowers(account).map((p) => {
        if (p.power === 'freeze') return { ...p, says: `${p.holder} can freeze accounts of the loan's token, which makes repaying fail.${lender(p.holder)}` };
        if (p.power === 'pause') return { ...p, says: `${p.holder ?? 'Its pause authority'} can pause every transfer of the loan's token, which makes repaying fail${p.paused ? ' (it is paused now)' : ''}.${lender(p.holder)}` };
        if (p.power === 'hook') return { ...p, says: `Every transfer of the loan's token runs the program ${p.holder}${p.authority ? `, which ${p.authority} can change` : ''}; it can refuse a repayment.${lender(p.authority)}` };
        return { ...p, says: `${p.holder} can move anyone's tokens of the loan's token, the ones you would repay with too.${lender(p.holder)}` };
      });
      const { amount, repay, lasts } = offer.deal.Lend;
      return { address, offer, mint: offer.mint, program: account.owner, amount, repay, lasts, risks };
    },

    /**
     * Borrows against the player's NFT `asset` from `maker`'s offer `id`: the NFT is held until the loan is repaid, or
     * goes to the lender once it is due (`due`, Unix seconds; by default the longest the offer allows, less a minute).
     * A loan whose token someone could freeze, pause, hook or move (`loanOffer`'s `risks`) is refused unless
     * `acceptRisks` is true: the page shows the player who holds that power first. `extra`: a transfer hook's accounts.
     */
    async borrow(maker, id, asset, { due, acceptRisks = false, extra = [], ...others } = NO_OPTIONS) {
      only(others, ['due', 'acceptRisks', 'extra'], 'borrow');
      const loan = await this.loanOffer(maker, id);
      if (loan.risks.length && acceptRisks !== true) throw new Error(`Repaying this loan can be blocked. ${loan.risks.map((r) => r.says).join(' ')} Borrow only if the player accepts this: pass acceptRisks: true.`);
      const lasts = BigInt(loan.lasts);
      due = BigInt(due ?? BigInt(now()) + lasts - (lasts > 120n ? 60n : 0n));
      const { before, ...nft } = await nftOf(asset);
      const collection = nft.collection ?? (await collectionOf(asset)) ?? MPL_CORE;
      const loanPrograms = { ...programs, [loan.mint]: loan.program };
      const ix = loot.borrowIx({ borrower: wallet.address, project, id, offer: loan.offer, due, asset, ...nft, collection, programs: loanPrograms, extra });
      const signature = await send([...before, createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, loan.mint, loan.program), ix]);
      return { signature, due, hold: loot.pda.hold(asset, due) };
    },

    /**
     * Backs `side` of contest number `id` (the authority opens contests while the project runs) with `amount`; a contest
     * of NFTs takes one of the player's NFTs that passes its rule instead (`nft`, its address), held until it is
     * claimed. `listProof`: for a list gate.
     */
    async enter(id, side, amount, { shown, listProof, nft: staked, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'listProof', 'nft'], 'enter');
      const contest = await read('Contest', loot.pda.contest(project, id));
      shown ??= await passing(contest.gate, 'enter');
      listProof = listProofOf(contest.gate, null, listProof);
      if (contest.nft) {
        if (!staked) throw new Error('This contest takes an NFT: say which (nft).');
        const { before, ...kind } = await nftOf(staked);
        return send([...before, loot.enterIx({ player: wallet.address, project, id, contest, side, amount: 1n, shown, listProof, nft: { asset: staked, ...kind }, programs })]);
      }
      const t = [...tokens.values()].find((x) => mintOf(x.key) === contest.mint);
      const value = units(amount, t?.source === 'sol' ? 9 : t?.decimals ?? 0);
      return send(withSolWrap(wallet.address, contest.mint, value, [loot.enterIx({ player: wallet.address, project, id, contest, side, amount: value, shown, listProof, programs })]));
    },

    /**
     * The auctions: each one's lot, high bid, the least the next bid must be, when it ends and how long is left, and
     * whether the player leads. One no longer on chain has ended. `waiting`: SOL that came back to the player's
     * wrapped-SOL account from a bid that was topped (`unwrap` turns it into plain SOL).
     */
    async auctions() {
      const list = spec.auctions ?? [];
      const accounts = await client.accounts(list.map((a) => auctionAt(a)));
      const at = BigInt(now());
      const wrapped = wallet?.address ? await client.account(associatedTokenAddress(wallet.address, NATIVE_MINT)) : null;
      const waiting = wrapped ? show(new DataView(wrapped.data.buffer, wrapped.data.byteOffset).getBigUint64(64, true), 9) : '0';
      return list.map((a, i) => {
        const x = accounts[i] && loot.decode('Auction', accounts[i].data);
        const base = { key: a.key, name: a.name, lot: a.lot, currency: tokens.get(a.currency ?? currencyKey)?.symbol ?? a.currency ?? currencyKey };
        if (!x) return { ...base, ended: true };
        // Bids of NFTs count NFTs.
        const dec = x.nft_bids ? 0 : decimalsOf(a.currency);
        const ends = loot.auctionEnds(x);
        const bid = x.high > 0n;
        const nextBid = loot.leastBid(x);
        return {
          ...base,
          ended: false,
          reserve: show(x.reserve, dec),
          high: bid ? show(x.high, dec) : null,
          highBidder: bid ? x.high_bidder : null,
          leading: bid && x.high_bidder === wallet?.address,
          nextBid: nextBid === null ? null : show(nextBid, dec),
          nextBidUnits: nextBid,
          startsAt: Number(x.starts_at),
          endsAt: Number(ends),
          secondsLeft: Number(ends > at ? ends - at : 0n),
          open: nextBid !== null && at >= x.starts_at && at < ends,
          over: at >= ends,
          ...(x.nft_bids ? { nftBids: true, held: x.held } : {}),
          ...(tokens.get(a.currency ?? currencyKey)?.source === 'sol' ? { waiting } : {}),
        };
      });
    },

    /**
     * Bids `amount` (whole units) on an auction. The bid it tops goes back to its bidder in the same transaction
     * (the program opens their account again if they closed it, paid by this bidder). In SOL, only what the player's
     * wrapped-SOL account does not hold already is wrapped, and the account stays open: if this bid is topped, it comes
     * back there.
     */
    async bid(auctionKey, amount, { shown, listProof, nfts, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'listProof', 'nfts'], 'bid');
      const a = part('auctions', auctionKey);
      const auction = await read('Auction', auctionAt(a));
      shown ??= await passing(auction.gate, 'bid');
      listProof = listProofOf(auction.gate, a.gate?.list, listProof);
      // An auction of NFT bids: a bid is a bundle of the player's NFTs (`nfts`, their addresses, or `amount` read as
      // them), and the bid it tops goes back to its bidder in the same transaction.
      if (auction.nft_bids) {
        const bundle = nfts ?? (Array.isArray(amount) ? amount : null);
        if (!bundle?.length) throw new Error('This auction takes NFTs as bids: say which (nfts).');
        const before = [];
        const kindOf = async (asset, to) => {
          const { before: proof, ...kind } = await nftOf(asset, wallet.address, { to });
          before.push(...proof);
          return { asset, ...kind };
        };
        const bid = [];
        for (const asset of bundle) bid.push(await kindOf(asset));
        // The bid it tops goes back to its bidder: into a fresh account of theirs when their own can't take it.
        const held = [];
        for (const asset of auction.held) held.push(await kindOf(asset, auction.high_bidder));
        const ix = loot.bidIx({ bidder: wallet.address, project, id: a.id, auction, shown, listProof, nfts: bid, held, programs });
        return send([computeUnitLimit(800_000), ...before.filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM), ix]);
      }
      const mint = auction.mint;
      const value = units(amount, decimalsOf(a.currency));
      const instructions = [];
      if (mint === NATIVE_MINT) {
        const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
        const have = await client.account(wrapped);
        const held = have ? new DataView(have.data.buffer, have.data.byteOffset).getBigUint64(64, true) : 0n;
        instructions.push(createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, NATIVE_MINT));
        if (value > held) instructions.push(transferLamports(wallet.address, wrapped, value - held), syncNative(wrapped));
      }
      // A Token-2022 account can ask for a memo on every transfer into it: the Memo program rides along.
      const memo = programOf(mint) === TOKEN_2022_PROGRAM ? [{ pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false }] : [];
      instructions.push(loot.bidIx({ bidder: wallet.address, project, id: a.id, auction, amount: value, shown, listProof, programs, extra: memo }));
      return send(instructions, [], { keepWrapped: true });
    },

    /**
     * Ends an auction that is over (anyone can; the winner usually does): the lot to the highest bidder, a new
     * collectible minted for them at the address its item and serial name, however long after the end it is sent. A
     * roll lot makes the winner's roll of its box (`order`), which `collect` asks for and settles.
     */
    async endAuction(auctionKey, { holders, ...others } = NO_OPTIONS) {
      only(others, ['holders'], 'endAuction');
      const a = part('auctions', auctionKey);
      const auction = await read('Auction', auctionAt(a));
      const g = await projectNow();
      const sold = auction.high > 0n;
      const item = auction.lot.Item ? await read('Item', loot.pda.item(project, auction.lot.Item[0])) : null;
      const made = sold && item?.kind === 'Collectible' ? loot.pda.itemAsset(loot.pda.item(project, auction.lot.Item[0]), auction.serial) : null;
      const memo = programOf(auction.mint) === TOKEN_2022_PROGRAM ? [{ pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false }] : [];
      holders ??= sold ? await holdersOf(auction.shares) : {};
      const lot = auction.lot.Asset?.[0];
      // The lot goes to its winner (back to its seller, unsold); a winning bid of NFTs to whoever the rest of a bid in
      // tokens would go to: the seller of an NFT, the treasury for a new item.
      const { before, hasAuthority: _, ...nft } = lot ? await nftOf(lot, wallet.address, { to: sold ? auction.high_bidder : auction.seller }) : { before: [] };
      const collection = lot && !nft.compressed && !nft.tokenMetadata ? (await collectionOf(lot)) ?? MPL_CORE : undefined;
      const proceeds = auction.lot.Asset ? auction.seller : g.treasury;
      const held = [];
      if (sold && auction.nft_bids) {
        for (const asset of auction.held) {
          const { before: proof, ...kind } = await nftOf(asset, wallet.address, { to: proceeds });
          before.push(...proof);
          held.push(kind);
        }
      }
      const ix = loot.endAuctionIx({ signer: wallet.address, project, projectState: g, id: a.id, auction, item, ...nft, collection, held, holders, programs, extra: memo });
      const signature = await send([computeUnitLimit(800_000), ...before.filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM), ix]);
      // A roll lot sold: the winner's roll, made at the default nonce, waits for anyone to ask it (`collect`).
      const roll = sold && auction.lot.Roll ? loot.pda.order(project, auction.high_bidder, loot.prizeRollNonce(loot.prizeNonce(auctionAt(a), BigInt(auction.last_bid_at)))) : null;
      return { signature, ...(sold ? { winner: auction.high_bidder } : {}), ...(made ? { asset: made } : {}), ...(roll ? { order: roll } : {}) };
    },

    /**
     * Runs a schedule that is due (an emission into a pool, a rent or a drip): anyone may, and nothing is paid to
     * whoever sends it but the network fee. `holders`: asset → holder, for a schedule that pays a collectible's holder.
     * Returns null when it isn't due yet.
     */
    async runSchedule(scheduleKey, { holders, most = 20, ...others } = NO_OPTIONS) {
      only(others, ['holders', 'most'], 'runSchedule');
      const sc = part('schedules', scheduleKey);
      const address = loot.pda.schedule(project, sc.id);
      const schedule = await read('Schedule', address);
      const from = schedule.action.from;
      // A sealed schedule's vault: past its last run, whatever arrived since is due once more.
      const vault = from.Vest ? await client.account(loot.pda.vest(address)) : null;
      const held = vault ? vault.data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
      // Runs due by the chain's clock, each its own instruction: one too many would fail them all.
      const due = Math.min(loot.runsDue(schedule, await chainNow(), held), most);
      if (!due) return null;
      const poolMint = from.Pool ? encodeBase58((await client.account(loot.pda.pool(project, from.Pool[0]))).data.subarray(0, 32)) : null;
      holders ??= await holdersOf([{ to: schedule.action.to }]);
      const treasury = (await projectNow()).treasury;
      return send(Array.from({ length: due }, () => loot.runScheduleIx({ payer: wallet.address, project, id: sc.id, schedule, poolMint, holders, programs, treasury })));
    },

    // ---------------------------------------------------------------- listings

    /**
     * Lists one of the player's NFTs (any kind) for sale at `price` (whole units of `currency`, the economy's by
     * default), `shares` taken first (a royalty, a platform's cut). The project holds it until it sells or is unlisted.
     */
    async listForSale(asset, { price, currency, shares = [], ...others } = NO_OPTIONS) {
      only(others, ['price', 'currency', 'shares'], 'listForSale');
      const mint = mintOf(currency);
      const { before, ...nft } = await nftOf(asset);
      return send([...before, loot.openListingIx({ maker: wallet.address, project, asset, mint, deal: { Sell: { price: units(price, decimalsOf(currency)) } }, shares, ...nft })]);
    },

    /**
     * Lists one of the player's NFTs for rent: `price` (whole units) a period of `lasts` seconds, a renter taking 1 to
     * `maxPeriods` at once. Nobody can end a rental early; the next renter takes it once one is over, until it is unlisted.
     */
    async listForRent(asset, { price, lasts, maxPeriods = 1, currency, shares = [], ...others } = NO_OPTIONS) {
      only(others, ['price', 'lasts', 'maxPeriods', 'currency', 'shares'], 'listForRent');
      const mint = mintOf(currency);
      const { before, ...nft } = await nftOf(asset);
      return send([...before, loot.openListingIx({ maker: wallet.address, project, asset, mint, deal: { Rent: { price: units(price, decimalsOf(currency)), lasts, max_periods: maxPeriods } }, shares, ...nft })]);
    },

    /** The listing of `asset` (one account read), or null: { listing, asset, maker, mint, deal, renter, until }. */
    async listing(asset) {
      const listing = await readMaybe('Listing', loot.pda.listing(project, asset));
      if (!listing) return null;
      return { listing: loot.pda.listing(project, asset), ...listing, renter: loot.renterOf(listing, await chainNow()) };
    },

    /** Who rents `asset` now (one account read, then a check that the project still holds it), or null. */
    async rentedTo(asset) {
      const listing = await readMaybe('Listing', loot.pda.listing(project, asset));
      const renter = loot.renterOf(listing, await chainNow());
      if (!renter) return null;
      const account = await client.account(asset);
      const holds = account?.owner === MPL_CORE ? parseCoreAsset(account.data).owner === project : true;
      return holds ? renter : null;
    },

    /** The project's listings, a maker's (`maker`) or all: one search of the program's accounts. */
    async listings({ maker, ...others } = NO_OPTIONS) {
      only(others, ['maker'], 'listings');
      const filters = [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Listing)) } }, { memcmp: { offset: 1, bytes: project } }, ...(maker ? [{ memcmp: { offset: 33, bytes: maker } }] : [])];
      const time = await chainNow();
      return (await client.programAccounts(loot.LOOT_PROGRAM, filters)).map(({ pubkey, account }) => {
        const listing = loot.decode('Listing', account.data);
        return { listing: pubkey, ...listing, renter: loot.renterOf(listing, time) };
      });
    },

    /**
     * Buys a listed NFT at the terms the player saw: `listing`, as `listing()` or `listings()` showed it. It is
     * required: the terms signed are those, never the listing read now, so a price or a share changed since is refused.
     */
    async buyListing(asset, { listing, ...others } = NO_OPTIONS) {
      only(others, ['listing'], 'buyListing');
      await shownListing(asset, listing, 'Sell');
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: wallet.address });
      const holders = await holdersOf(listing.shares ?? []);
      return send([...before, ...withSolWrap(wallet.address, listing.mint, listing.deal.Sell.price, [loot.takeListingIx({ taker: wallet.address, project, projectState: await projectNow(), listing, holders, programs, ...nft })])]);
    },

    /**
     * Rents a listed NFT for `periods` periods, at the terms the player saw: `listing`, as `listing()` or `listings()`
     * showed it (required, as for `buyListing`).
     */
    async rentListing(asset, { periods = 1, listing, ...others } = NO_OPTIONS) {
      only(others, ['periods', 'listing'], 'rentListing');
      await shownListing(asset, listing, 'Rent');
      const holders = await holdersOf(listing.shares ?? []);
      const total = BigInt(listing.deal.Rent.price) * BigInt(periods);
      // A compressed NFT is read by its record, proven first in the same transaction.
      const { before, compressed } = await nftOf(asset);
      return send([...(compressed ? before : []), ...withSolWrap(wallet.address, listing.mint, total, [loot.takeListingIx({ taker: wallet.address, project, projectState: await projectNow(), listing, periods, compressed, holders, programs })])]);
    },

    /** Takes a listed NFT home (its maker). While a rental runs it only stops the listing; call again once it is over. */
    async unlist(asset) {
      const listing = await read('Listing', loot.pda.listing(project, asset));
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: wallet.address });
      return send([...before, loot.closeListingIx({ maker: wallet.address, project, listing, ...nft })]);
    },

    // ---------------------------------------------------------------- raffles

    /**
     * The project's owner raffles an NFT they hold, as lottery `id`: the NFT goes into the lottery's own stash, where
     * nothing but the lottery can take it while a place names it; the winner gets it before any ticket money moves.
     * `price` (whole units of `currency`) a ticket, `drawsAt` (Unix seconds) its one draw, `minSold` the least tickets
     * (fewer: the round is cancelled and refunded), `shares` where the ticket money goes (the seller's own wallet by
     * default: the treasury). A seller runs it in a project of their own, whose owner they are.
     */
    async raffle(id, nft, { price, currency, drawsAt, minSold = 0, perWallet = 0, shares = [{ to: 'Treasury', bps: 10_000 }], ...others } = NO_OPTIONS) {
      only(others, ['price', 'currency', 'drawsAt', 'minSold', 'perWallet', 'shares'], 'raffle');
      const kind = await nftOf(nft);
      const { before, hasAuthority: _, ...piece } = kind;
      await send([...before, loot.stashIx({ signer: wallet.address, project, lottery: id, asset: nft, ...piece })]);
      const args = {
        price: units(price, decimalsOf(currency)), mint: mintOf(currency), shares, places: [{ bps: 0, prize: { Held: [nft] } }],
        ticket_mint: NOBODY, every: 0n, draws_at: BigInt(drawsAt), gate: null, per_wallet: perWallet, min_sold: BigInt(minSold),
      };
      return send([loot.upsertIx({ owner: wallet.address, project, def: { Lottery: { id, args } } })]);
    },

    /** The raffle's owner takes the NFT back out of lottery `id`'s own stash once nothing promises it (the lottery ended, or no place names it). */
    async unraffle(id, nft) {
      const { before, hasAuthority: _, ...piece } = await nftOf(nft, wallet.address, { to: wallet.address });
      return send([...before, loot.stashIx({ signer: wallet.address, project, lottery: id, asset: nft, out: wallet.address, ...piece })]);
    },

    /** Turns what waits in the player's wrapped-SOL account (a bid that was topped) into plain SOL. */
    async unwrap() {
      const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
      if (!(await client.account(wrapped))) return null;
      return send([closeTokenAccount(wrapped, wallet.address, wallet.address)]);
    },

    /**
     * Claims a grant for the connected wallet: from the approved list (the proof comes from xsolana.json, or is given:
     * `proof`, `personHash` and the `round` the list pays, as a results server's list answers them), or with a voucher
     * a server signed ({ publicKey, signature, incarnation, round, expires, personHash, amount }). A list in xsolana.json names
     * no round (zeros). `amount` (a voucher's, or `options.amount` for a list's leaf): the tokens this claim gives, in
     * base units, up to the grant's own, for a grant of a fixed amount of tokens (a reward by rank); absent or 0 gives
     * the grant's prize as it is. A grant that gives a roll of a box makes the wallet's roll, which `claims()` then
     * lists and `collect` asks for and settles.
     */
    async claimGrant(grantKey, options = {}) {
      only(options, ['voucher', 'proof', 'personHash', 'round', 'amount', 'shown', 'listProof'], 'claimGrant');
      let { voucher = null, proof: given = null, personHash: listPerson = null, round: listRound = null, amount: listAmount = 0n, shown } = options;
      const gspec = part('grants', grantKey);
      const address = loot.pda.grant(project, gspec.id);
      const grant = await read('Grant', address);
      shown ??= await passing(grant.gate, 'claim this');
      const gateProof = listProofOf(grant.gate, gspec.gate?.list, options.listProof);
      const receipt = await client.account(loot.pda.grantReceipt(address, grant.incarnation, wallet.address));
      const count = loot.readReceiptAccount(receipt)?.count ?? 0;
      // What its prize needs: a pool's mint, the item, an NFT's kind (a compressed one proven first).
      const prized = await prizeInputs([grant.gives]);
      const pool = grant.gives.Tokens?.from.Pool?.[0];
      const poolMint = pool !== undefined ? prized.poolMints[pool] : null;
      const item = prized.items[grant.gives.Item?.[0] ?? grant.gives.Compressed?.item] ?? null;
      const instructions = [...prized.before];
      let proof = [];
      const keys = gspec.keys ?? [];
      if (voucher) {
        if (voucher.incarnation == null || BigInt(voucher.incarnation) !== grant.incarnation) throw new Error('This voucher belongs to a different grant incarnation.');
        const message = loot.voucherBytes({ grant: address, incarnation: grant.incarnation, wallet: wallet.address, personHash: voucher.personHash, round: voucher.round, expires: voucher.expires, amount: BigInt(voucher.amount ?? 0) });
        const signature = typeof voucher.signature === 'string' ? decodeBase58(voucher.signature) : voucher.signature;
        instructions.push(loot.ed25519Ix({ publicKey: voucher.publicKey, signature, message }));
        // A key under the grant's key root (a promo code's) proves it is one of them.
        const at = keys.indexOf(voucher.publicKey);
        proof = given ?? (at >= 0 ? loot.merkleProof(keys.map((k) => loot.keyLeaf(k)), at) : []);
      } else if (given) {
        proof = given;
      } else if ((gspec.list ?? []).length) {
        // An entry is an address (the grant's amount, round 0), or { wallet, amount, round } (whole units of the grant's
        // token): a wallet listed under several rounds claims each once (`options.round`, a number; the first by default).
        const list = gspec.list.map((e) => (typeof e === 'string' ? { wallet: e } : e));
        const mint = grant.gives.Tokens?.from.Mint?.[0] ?? poolMint;
        const decimals = mint && list.some((e) => e.amount !== undefined) ? (await client.account(mint))?.data?.[44] ?? 0 : 0;
        const leaves = list.map((e) => loot.listLeaf(e.wallet, null, loot.listRound(e.round ?? 0), e.amount !== undefined ? units(e.amount, decimals) : 0n));
        const at = list.findIndex((e) => e.wallet === wallet.address && (typeof listRound !== 'number' || (e.round ?? 0) === listRound));
        if (at < 0) throw new Error('This wallet is not on the list for this grant.');
        proof = loot.merkleProof(leaves, at);
        listRound = loot.listRound(list[at].round ?? 0);
        if (list[at].amount !== undefined) listAmount = units(list[at].amount, decimals);
      } else if ((gspec.vouchers ?? []).length || keys.length) {
        throw new Error('This grant pays a wallet a voucher key signs for: pass the voucher.');
      }
      // A share of a pool that comes to nothing is refused (PrizeNotCovered): say the pool is empty instead.
      if (grant.gives.Tokens?.amount.Bps && pool !== undefined) {
        const held = (await client.account(loot.pda.pool(project, pool)))?.data;
        const amount = held ? held.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
        if (amount * BigInt(grant.gives.Tokens.amount.Bps[0]) / 10_000n === 0n) throw new Error('This grant pays a share of its pool, and the pool is empty: nothing to claim yet.');
      }
      // What this claim gives: the amount the voucher or the list's leaf names (0: the grant's prize as it is).
      const amount = BigInt((voucher ? voucher.amount : listAmount) ?? 0);
      const most = grant.gives.Tokens?.amount.Fixed?.[0];
      if (amount > 0n && (most === undefined || amount > BigInt(most))) throw new Error(`This claim names ${amount} tokens, more than this grant gives${most === undefined ? ' (it gives no fixed amount of tokens)' : ` (${most})`}.`);
      instructions.push(loot.claimGrantIx({ project, id: gspec.id, grant, wallet: wallet.address, signer: wallet.address, count, round: voucher?.round ?? listRound, expires: voucher?.expires, personHash: voucher?.personHash ?? listPerson, amount, proof, poolMint, item, nft: prized.nft, boxes: prized.boxes, rollPools: prized.rollPools, shown, listProof: gateProof, programs, voucherKey: voucher?.publicKey }));
      return send(instructions);
    },

    /**
     * Takes every prize a results server vouched for this wallet's wins, or put on a list (`server`: its URL;
     * a results server), page by page. Each pays only this wallet, within the grant's limits. Returns [{ round, grant,
     * signature }] for each claim made, and [{ round, grant, error }] for one that failed, without stopping the rest;
     * wins already claimed are skipped (the program pays a wallet each round once per grant incarnation).
     *
     * `token`: the player's play-host sign-in for this game. A drop that gives NFTs from a stash gives one only at a
     * signed-in claim, first come first served (the server answers `R-SIGN-IN` to a voucher request with no sign-in, so
     * a stranger can't hand them out): with the token such a win is claimed through `POST /v1/claims`; without it, it is
     * [{ round, grant, error }].
     */
    async claimWins({ server, token = null, fetchImpl = globalThis.fetch, ...others } = NO_OPTIONS) {
      only(others, ['server', 'token', 'fetchImpl'], 'claimWins');
      const base = server.replace(/\/$/, '');
      const ask = async (path, init) => {
        const r = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, init);
        // The status first: a proxy's error page is no JSON, and says nothing a player can act on but its status.
        const body = await r.json().catch(() => null);
        if (!r.ok) throw Object.assign(new Error(body?.error?.why ?? `The results server answered ${r.status}.`), { code: body?.error?.code, status: r.status });
        if (body === null || typeof body !== 'object') throw new Error(`The results server answered ${r.status} with no JSON.`);
        return body;
      };
      const get = (path) => ask(path);
      // Where a list's proof is, as the server named it: a path on the server itself, or a whole URL on the server's own
      // origin. Any other place is refused before anything is fetched, so a server's answer can't send the page to
      // another host. A server given as a path (such as "/results") is on the page's own origin.
      const proofAt = (proof) => {
        const said = String(proof ?? '');
        let origin = null;
        let url = null;
        try {
          const home = new URL(`${base}/`, globalThis.location?.href);
          origin = home.origin;
          url = new URL(said.startsWith('/') && !said.startsWith('//') ? `${home.href.replace(/\/$/, '')}${said}` : said, home);
        } catch {
          // not a URL at all: refused below
        }
        if (!url || origin === null || origin === 'null' || url.origin !== origin) throw new Error(`The results server named a list's proof at “${said}”, which is not on the server itself (${origin ?? base}): it was not fetched.`);
        return url.href;
      };
      // Each value in a query is encoded: a round or a page the server named can't change the request's path.
      const q = (value) => encodeURIComponent(String(value));
      // A win's vouchers; a stash drop's NFT not given yet: the signed-in claim's, those for this wallet
      const vouchersOf = async (round) => {
        try {
          return (await get(`/v1/vouchers?game=${q(project)}&round=${q(round)}&wallet=${q(wallet.address)}`)).vouchers;
        } catch (e) {
          if (e.code !== 'R-SIGN-IN' || !token) throw e;
          const { vouchers } = await ask('/v1/claims', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ game: project, round, token }) });
          return vouchers.filter((v) => v.wallet === wallet.address);
        }
      };
      const claimed = async (grantId, incarnation, round) => {
        const grant = loot.pda.grant(project, grantId);
        incarnation ??= (await read('Grant', grant)).incarnation;
        return loot.readReceiptAccount(await client.account(loot.pda.grantReceipt(grant, incarnation, wallet.address)))?.claimed(round) ?? false;
      };
      const out = [];
      const take = async (round, grant, claim) => {
        try {
          out.push({ round, grant, signature: await claim() });
        } catch (e) {
          out.push({ round, grant, error: e.message });
        }
      };
      // Page by page, until a page names no next one (null, or left out) or one already read: a server that leaves it
      // out, or names the same page again, must not have it read again and again.
      let page = { next: '' };
      const pagesRead = new Set();
      for (let first = true; first || (page.next && !pagesRead.has(page.next)); first = false) {
        pagesRead.add(page.next);
        page = await get(`/v1/wins?game=${q(project)}&wallet=${q(wallet.address)}${page.next ? `&before=${q(page.next)}` : ''}`);
        for (const win of page.wins.filter((x) => x.grant !== null && x.grant !== undefined)) {
          // one win that fails (its vouchers refused, a sign-in run out, a list not there) is its own error line, and
          // the rest go on (a refused POST /v1/claims must not stop every later win)
          try {
            for (const v of await vouchersOf(win.round)) {
              const grantKey = (spec.grants ?? []).find((x) => x.id === v.grant)?.key;
              if (!grantKey) continue;
              if (v.list) {
                // Paid by a list the owner wrote from the draw: its proof names the round.
                const list = await get(proofAt(v.proof));
                const mine = list.winners.find((w) => w.wallet === wallet.address);
                if (!mine || (await claimed(v.grant, null, list.round))) continue;
                await take(win.round, v.grant, () => this.claimGrant(grantKey, { proof: mine.proof, personHash: mine.personHash, round: list.round, amount: mine.amount ?? 0 }));
              } else if (v.signature && !(await claimed(v.grant, v.incarnation, v.round))) {
                await take(win.round, v.grant, () => this.claimGrant(grantKey, { voucher: v }));
              }
            }
          } catch (e) {
            out.push({ round: win.round, grant: win.grant, error: e.message });
          }
        }
      }
      return out;
    },

    /**
     * What this player can finish now, themselves: a box to settle or refund, a contest entry to claim, a held
     * collectible to take home, an auction they won (or one off by the clock: their bid back), a lottery place they
     * won, a draw that is due (anyone may reveal it, or ask again when the oracle never answered; it takes 0.0005
     * SOL), and a drawn lottery's unpaid places, which anyone may pay so the next round can open. [{ kind, says, … }];
     * pass one to `claim`.
     */
    async claims() {
      const me = wallet.address;
      const out = [];
      const tag = (t) => ({ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS[t])) } });
      const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
      const slot = await slotNow();
      const time = BigInt(now());
      for (const { pubkey, account } of await client.programAccounts(loot.LOOT_PROGRAM, [tag('Order'), at(1, project), at(33, me)])) {
        const o = loot.decode('Order', account.data);
        const opened = BigInt(o.requested_slot);
        const refundAt = loot.orderRefundSlot(o);
        if (refundAt !== null && slot >= refundAt) out.push({ kind: 'refund', order: pubkey, says: 'Your payment back for an order that never finished.' });
        else if (o.status === 'Rolled' && slot > opened) out.push({ kind: 'settle', order: pubkey, says: 'What your box rolled.' });
        else if (loot.rollAskable(o, slot)) out.push({ kind: 'settle', order: pubkey, says: 'A roll you won (a mission’s, a recipe’s, a prize’s): ask for it and see what it gives (one whose box has nothing left to give waits until it has).' });
      }
      for (const { pubkey, account } of await client.programAccounts(loot.LOOT_PROGRAM, [tag('Entry'), at(33, me)])) {
        const entry = loot.decode('Entry', account.data);
        const c = await client.account(entry.contest);
        if (!c) continue;
        const contest = loot.decode('Contest', c.data);
        const off = loot.contestOff(contest, time);
        if (contest.project !== project || !(off || contest.verdict === 'Won')) continue;
        const won = contest.winner === entry.side;
        // A loser's NFT waits for the winners: it goes to the opener once they have all claimed.
        if (contest.nft && !off && !won && entry.asset !== NOBODY && BigInt(contest.unclaimed) > 0n) continue;
        const says = off ? 'Your entry back: the contest is off.' : won ? (contest.nft ? 'Your NFT back, and one of the losers’.' : contest.prize != null ? 'Your share of the pot, and your prize.' : 'Your share of the pot.') : 'Close your entry (your side lost).';
        out.push({ kind: 'contest', entry: pubkey, id: contest.id, side: entry.side, says });
      }
      for (const { pubkey, account } of await client.programAccounts(loot.LOOT_PROGRAM, [tag('Hold'), at(1, project), at(65, me)])) {
        const hold = loot.decode('Hold', account.data);
        // A repaid loan's NFT goes home whenever; an unpaid one's is the lender's once due.
        if (hold.debt?.paid) out.push({ kind: 'release', asset: hold.asset, hold: pubkey, says: 'Your collectible back: your loan is repaid.' });
        else if (!hold.debt && time >= BigInt(hold.free_at)) out.push({ kind: 'release', asset: hold.asset, hold: pubkey, says: 'Your collectible back: its hold is over.' });
      }
      const auctions = spec.auctions ?? [];
      const found = await client.accounts(auctions.map((a) => auctionAt(a)));
      auctions.forEach((a, i) => {
        const x = found[i] && loot.decode('Auction', found[i].data);
        if (!x || x.high_bidder !== me || time < loot.auctionEnds(x)) return;
        out.push({ kind: 'auction', key: a.key, says: `You won “${a.name}”: take it.` });
      });
      for (const l of spec.lotteries ?? []) {
        // A lottery the page names but nobody has written yet (a raffle still to open) has nothing to finish.
        if (!(await client.account(loot.pda.lottery(project, l.id)))) continue;
        const { lottery, contributions, winners } = await roundOf(l);
        if (loot.lotteryCancellable(lottery, slot)) out.push({ kind: 'cancel-draw', key: l.key, says: `The oracle never answered the draw of “${l.name}”: make ticket payments refundable.` });
        else if (lottery.status === 'Open' && time >= BigInt(lottery.draws_at) && BigInt(lottery.sold) > 0n) out.push({ kind: 'reveal', key: l.key, says: `The draw of “${l.name}” is due: reveal the winners.` });
        else if (loot.lotteryDrawStuck(lottery, slot)) out.push({ kind: 'reveal', key: l.key, says: `The oracle never answered the draw of “${l.name}”: ask it again.` });
        const open = contributions.filter(({ value }) => !value.done);
        // A drawn round gives every place's prize first; its money moves after.
        const owed = contributions.filter(({ value }) => loot.lotteryStep(lottery, value) === 'prizes');
        if (owed.length) {
          const mine = owed.find(({ value }) => value.player === me);
          out.push({ kind: 'lottery-prize', key: l.key, contribution: (mine ?? owed[0]).address,
            says: mine ? `Take your prize in “${l.name}”.` : `Give the winners of “${l.name}” their prizes, so its draw can complete.` });
        } else if (lottery.status === 'Drawn' && open.length) {
          out.push({ kind: 'complete-draw', key: l.key, contribution: open[0].address, says: `Complete the draw of “${l.name}” so its winners can collect.` });
        }
        if (lottery.status === 'Cancelled' && open.length) {
          const mine = open.find(({ value }) => value.player === me) ?? open[0];
          out.push({ kind: 'ticket-refund', key: l.key, contribution: mine.address,
            says: mine.value.player === me ? `Recover your ticket payment for “${l.name}”.` : `Return a ticket payment for “${l.name}” so its next round can open.` });
        }
        if (winners.some((w) => w.winner === me)) out.push({ kind: 'prize', key: l.key, says: `You won a place in “${l.name}”.` });
        else if (winners.length) {
          // A place that rolls makes its winner's roll, whose order the payer funds (its rent and SOL go to the winner).
          const rolls = lottery.places.some((p) => p.prize?.Roll) ? ', and about 0.005 SOL (0.011 when its box can give an item) for each place won that gives a roll, which goes to the winner' : '';
          out.push({ kind: 'payout', key: l.key, says: `Pay the winners of “${l.name}” so its next round can open (about 0.002 SOL of account rent for each winner who has no account for the prize yet${rolls}; it stays with the winner).` });
        }
      }
      // Tokens whose unbonding wait is over, in a farm of tokens.
      const chainTime = await chainNow();
      for (const f of (spec.farms ?? []).filter((x) => x.stakes !== 'collectibles')) {
        const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), me));
        const free = seat ? loot.withdrawable(seat, chainTime) : 0n;
        if (free > 0n) out.push({ kind: 'withdraw', key: f.key, says: `Your tokens leaving “${f.name ?? f.key}” are free: take them out.` });
      }
      // A sealed schedule that pays this wallet: its runs that are due (vesting nobody can take back).
      for (const sc of spec.schedules ?? []) {
        const schedule = await readMaybe('Schedule', loot.pda.schedule(project, sc.id));
        if (!schedule?.action.from.Vest || schedule.action.to.Wallet?.[0] !== me) continue;
        const vault = await client.account(loot.pda.vest(loot.pda.schedule(project, sc.id)));
        const held = vault ? vault.data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
        if (loot.runsDue(schedule, chainTime, held) > 0) out.push({ kind: 'vest', key: sc.key, says: `What has vested of “${sc.name ?? sc.key}”: claim it.` });
      }
      // The player's listings whose rental is over: their NFT can go home (or wait for the next renter).
      const mineListed = await client.programAccounts(loot.LOOT_PROGRAM, [tag('Listing'), at(1, project), at(33, me)]);
      for (const { account } of mineListed) {
        const listing = loot.decode('Listing', account.data);
        if (listing.deal.Rent && listing.user !== NOBODY && !loot.renterOf(listing, chainTime)) out.push({ kind: 'unlist', asset: listing.asset, says: listing.stopped ? 'The rental of your stopped listing is over: take your NFT home.' : 'A rental of yours is over: take your NFT home, or leave it listed for the next renter.' });
      }
      // The lookup tables a transaction of this player's too big for a legacy one made (`send`): each is deactivated by
      // the transaction it was made for, and its rent comes back once it has cooled down (about 513 slots). One of this
      // project's whose transaction was never sent (the wallet declined it) is retired first. A table that names no
      // account of this project is another app's: left alone.
      const mineTables = await client.programAccounts(LOOKUP_TABLE_PROGRAM, tablesOf(me)).catch(() => []);
      // A table closes once its deactivation slot has left the recent slot hashes (skipped slots keep it there longer).
      const recent = mineTables.length ? await recentSlots() : [];
      for (const { pubkey, account } of mineTables) {
        const table = readTable({ ...account, owner: account.owner ?? LOOKUP_TABLE_PROGRAM });
        if (!table || table.authority !== me) continue;
        const step = tableStep(table, slot, recent);
        const rent = show(BigInt(account.lamports ?? 0), 9);
        if (step === 'close') out.push({ kind: 'lookup-table', table: pubkey, says: `${rent} SOL of rent back from a lookup table a large transaction of yours used.` });
        else if (step === 'active' && table.addresses[0] === project && slot > table.lastExtendedSlot + TABLE_UNSENT_SLOTS)
          out.push({ kind: 'lookup-table', table: pubkey, says: `A lookup table made for a large transaction of yours that was never sent: retire it, and its ${rent} SOL of rent comes back about two minutes later.` });
      }
      return out;
    },

    /**
     * Finishes one of `claims()`, signed by this player. Returns the signature. A winner of a contest of NFTs picks
     * which loser's NFT they take (`{ take: asset }`, the NFT of a losing entry that still holds one; the first found by default):
     * only the winner can, while any are left.
     */
    async claim(c, { take, ...others } = NO_OPTIONS) {
      only(others, ['take'], 'claim');
      const me = wallet.address;
      const g = await projectNow();
      if (c.kind === 'settle') return (await collect(c.order)).settled;
      if (c.kind === 'refund') return this.refund(c.order);
      if (c.kind === 'contest') {
        const contestAddress = loot.pda.contest(project, c.id);
        const contest = await read('Contest', contestAddress);
        const won = contest.verdict === 'Won' && contest.winner === c.side;
        const given = await prizeInputs([won ? contest.prize : null]);
        // A contest of NFTs: the entry's own NFT, and for a winner while losers' NFTs are left, a losing entry's.
        const nfts = {};
        if (contest.nft) {
          const entry = await read('Entry', loot.pda.entry(contestAddress, me));
          nfts.entry = entry;
          const kindOf = async (asset, to = me) => {
            const { before, hasAuthority: _, ...kind } = await nftOf(asset, me, { to });
            given.before.push(...before);
            return kind;
          };
          // A losing entry's own NFT goes to the contest's opener once winners have taken theirs.
          const lost = contest.verdict === 'Won' && !won;
          if (entry.asset !== NOBODY) nfts.own = await kindOf(entry.asset, lost ? contest.opener : me);
          if (won && Number(contest.losers) > 0) {
            const found = await client.programAccounts(loot.LOOT_PROGRAM, [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Entry)) } }, { memcmp: { offset: 1, bytes: contestAddress } }]);
            const left = found.map(({ account }) => loot.decode('Entry', account.data)).filter((e) => e.side !== contest.winner && e.asset !== NOBODY);
            const losing = take ? left.find((e) => e.asset === take) : left[0];
            if (take && !losing) throw new Error(`${take} is not a loser’s NFT left in this contest.`);
            if (losing) nfts.taking = { player: losing.player, side: losing.side, asset: losing.asset, kind: await kindOf(losing.asset) };
          }
        }
        return send([computeUnitLimit(800_000), ...given.before.filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM), loot.claimIx({ payer: me, project, id: c.id, contest, player: me, side: c.side, collection: given.collection, poolMints: given.poolMints, items: given.items, nft: given.nft, ...nfts, programs })]);
      }
      if (c.kind === 'release') {
        const hold = await read('Hold', c.hold);
        const { before, hasAuthority: _, ...nft } = await nftOf(c.asset, me, { to: me });
        return send([...before, loot.releaseIx({ signer: me, project, asset: c.asset, ...nft, collection: (await collectionOf(c.asset)) ?? MPL_CORE, hold })]);
      }
      if (c.kind === 'auction') return (await this.endAuction(c.key)).signature;
      if (c.kind === 'withdraw') return this.withdraw(c.key);
      if (c.kind === 'vest') return this.runSchedule(c.key);
      if (c.kind === 'unlist') return this.unlist(c.asset);
      if (c.kind === 'lookup-table') {
        const table = readTable(await client.account(c.table));
        const step = table && tableStep(table, await slotNow(), await recentSlots());
        if (!step || step === 'cooling') return null;
        return send([step === 'close' ? closeTableIx({ table: c.table, authority: me }) : deactivateTableIx({ table: c.table, authority: me })], [], { keepWrapped: true });
      }
      const l = part('lotteries', c.key);
      if (c.kind === 'reveal') return send([loot.drawLotteryIx({ payer: me, project, id: l.id })]);
      if (c.kind === 'cancel-draw') return send([loot.cancelLotteryIx({ project, id: l.id })]);
      if (c.kind === 'lottery-prize') {
        const { lottery, contributions } = await roundOf(l);
        const found = contributions.find(({ address }) => address === c.contribution);
        if (!found || loot.lotteryStep(lottery, found.value) !== 'prizes') return null;
        const given = await prizeInputs(lottery.places.map((p) => p.prize), me, found.value.player);
        return send([computeUnitLimit(600_000), ...given.before.filter((x) => x.programId !== COMPUTE_BUDGET_PROGRAM), loot.finishLotteryContributionIx({ payer: me, project, id: l.id, lottery, contributionAddress: found.address, contribution: found.value, collection: given.collection, poolMints: given.poolMints, items: given.items, nfts: given.nfts, programs })]);
      }
      if (c.kind === 'complete-draw' || c.kind === 'ticket-refund') {
        const { lottery, contributions } = await roundOf(l);
        const found = contributions.find(({ address }) => address === c.contribution);
        if (!found || found.value.done || lottery.status !== (c.kind === 'ticket-refund' ? 'Cancelled' : 'Drawn') || !loot.lotteryStep(lottery, found.value)) return null;
        // A ticket an NFT paid for passes that NFT, which the project holds: back to its buyer when the round is
        // cancelled or gives tickets back, to the wallet its price names when it is given on.
        const then = lottery.status === 'Drawn' ? lottery.nft_ticket?.then : null;
        // Given to a wallet that is an account of the loot program, it goes back to its buyer.
        const handBack = Boolean(then?.Give) && loot.handsBack(await client.account(then.Give[0]));
        const to = !then || handBack ? found.value.player : then.Give ? then.Give[0] : undefined;
        const { before = [], hasAuthority: _, ...ticket } = found.value.asset !== NOBODY ? await nftOf(found.value.asset, me, { to }) : {};
        return send([...before, loot.finishLotteryContributionIx({ payer: me, project, id: l.id, lottery, contributionAddress: found.address, contribution: found.value, treasury: g.treasury, ticket, handBack, programs })]);
      }
      if (c.kind === 'prize' || c.kind === 'payout') {
        // Every unpaid winner, three a transaction, each paid every place's share of the pot they won (their prizes went
        // first): the round ends once all are paid, and the next opens. Each winner's account of the pot's mint is
        // opened when they have none, paid by whoever sends it.
        const { lottery, winners } = await roundOf(l);
        const mine = winners.filter((w) => w.winner === me);
        const chosen = [...mine, ...winners.filter((w) => w.winner !== me)].slice(0, 3);
        if (!chosen.length) return null;
        const pay = (w) => loot.finishLotteryContributionIx({ payer: me, project, id: l.id, lottery, contributionAddress: w.contribution.address, contribution: w.contribution.value, treasury: g.treasury, programs });
        return send(chosen.map(pay));
      }
      throw new Error(`Nothing to do for a claim of kind ${c.kind}.`);
    },

    /** The player's collectibles of this project: [{ asset, item, itemId, name, uri, attributes, frozen }]. `item` is its key in the spec. */
    collectibles: owned,

    /** What the player holds of each of the economy's tokens, in whole units. */
    async balances(owner = wallet?.address) {
      const out = {};
      for (const t of tokens.values()) {
        const mint = mintOf(t.key);
        if (t.source === 'sol') out[t.key] = show(await client.balance(owner), 9);
        else if (mint) {
          const a = await client.account(loot.ata(owner, mint, programOf(mint)));
          out[t.key] = a ? show(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true), t.decimals ?? 0) : '0';
        }
      }
      return out;
    },
  };
}

