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
import { ownedAssetFilters, parseCoreAsset, parseCoreCollection } from '../chain/core.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  COMPUTE_BUDGET_PROGRAM,
  NATIVE_MINT,
  SYSVAR_SLOT_HASHES,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from '../chain/pda.js';
import {
  closeTokenAccount,
  computeUnitLimit,
  createAssociatedTokenAccountIdempotent,
  requestHeapFrame,
  syncNative,
  transferLamports,
  withComputeBudget,
  withSolWrap,
} from '../chain/programs.js';
import { rightCluster, rpcClient } from '../chain/rpc.js';
import { extension, mayStartFrozen, mintPowers, resolveTransfers } from '../chain/token2022.js';
import {
  compileFitting,
  compileKeepingKind,
  closeTableIx,
  deactivateTableIx,
  readTable,
  sendFitting,
  sendPlan,
  slotHashes,
  tablesOf,
  tableStep,
  transactionLocks,
  WALLET_ADDS_BYTES,
  LOOKUP_TABLE_PROGRAM,
} from '../chain/lookup.js';
import { compileMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { browserStore, keyring } from './keys.js';
import { SPONSOR_MAX_LAMPORTS, sponsoredCost, sponsorGiveBack, sponsorTopUp, stepShape, topUpFor } from './sponsor.js';

export {
  checkSponsored,
  httpSponsor,
  sponsoredCost,
  sponsorGiveBack,
  sponsorHandler,
  sponsorSigner,
  sponsorTopUp,
  stepShape,
  topUpFor,
  SPONSOR_MAX_LAMPORTS,
} from './sponsor.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
/** A lottery's steps in `claims()`: each depends on the one before, so `claimAll` takes one of a lottery's a call. */
/** The compute units a sponsored step asks for: all a transaction can have. It sets a price of 0, so they cost nothing. */
const SPONSORED_UNITS = 1_400_000;

const LOTTERY_STEPS = new Set(['reveal', 'cancel-draw', 'pull', 'payout']);
/** The claims that are one transaction of the wallet's: `claimAll` signs them together. */
const BATCHED = new Set(['contest', 'release', 'lookup-table', 'close-leaf', ...LOTTERY_STEPS]);
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MPL_CORE = loot.MPL_CORE_PROGRAM;
const NOBODY = '11111111111111111111111111111111';
/** A table made this many slots ago whose transaction never landed was never sent: its blockhashes ran out long since. */
const TABLE_UNSENT_SLOTS = 300n;
/** A compressed NFT's `prove_leaf`: its record stays good while the leaf is unchanged, so it may go in a transaction of its own first. */
const isProveLeaf = ix => ix.programId === loot.lootProgram() && loot.instructionOf(ix.data)?.name === 'prove_leaf';
/** A system account must keep this much (rent for 0 bytes) or be emptied. */
const RENT_EMPTY = 890_880n;
const SIGNATURE_FEE = 5_000n;

/**
 * A signer from a Wallet Standard wallet and one of its accounts: the wallet signs, the app sends. With the wallet's
 * `solana:signMessage`, also `signMessage(bytes)`: the app's settle keys are made from one signature of it a session,
 * so a page that closes can make them again (`recover`).
 */
export function walletStandardSigner(wallet, account, chain = loot.walletChain()) {
  const feature = wallet.features?.['solana:signTransaction'];
  if (!feature) throw new Error(`${wallet.name} cannot sign transactions.`);
  const messages = wallet.features?.['solana:signMessage'];
  return {
    address: account.address,
    // The kinds of transaction the wallet says it signs ('legacy', 0, …): `send` hands it a v0 one for room's sake
    // only when it names 0. A wallet that says nothing is taken to sign both, as every send too big for a legacy
    // transaction always took it to.
    versions: Array.from(feature.supportedTransactionVersions ?? ['legacy', 0]),
    async signTransaction(wire) {
      const [out] = await feature.signTransaction({ account, transaction: wire, chain });
      return out.signedTransaction;
    },
    ...(messages
      ? {
          async signMessage(message) {
            const [out] = await messages.signMessage({ account, message });
            return out.signature;
          },
        }
      : {}),
  };
}

/** A fresh ed25519 key (WebCrypto) that signs only its own account's creation: a crafted collectible's. */
async function freshKey() {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    address: encodeBase58(raw),
    sign: async message => new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', pair.privateKey, message)),
  };
}

/**
 * An amount in whole units of a token ("12", "0.5", or a number) in its base units. Only a plain decimal is taken, with
 * at most the token's decimals: "0x10", "1.2.3", "", "1e3", "-1" and an extra decimal place are refused, never read as
 * some other amount.
 */
export const units = (amount, decimals) => {
  const text =
    typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
      ? plainNumber(amount)
      : typeof amount === 'string'
        ? amount.trim()
        : null;
  const m = text === null ? null : /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m)
    throw new Error(
      `${typeof amount === 'string' ? JSON.stringify(amount) : String(amount)} is not an amount: write a plain number like 12 or 0.5.`,
    );
  const fraction = m[2] ?? '';
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals)))
    throw new Error(`${text} has more decimals than the token's ${decimals}.`);
  return BigInt(m[1] + fraction.padEnd(decimals, '0').slice(0, decimals));
};
/** A number as plain decimal text (1e-7 → "0.0000001"). */
const plainNumber = n => (/e/i.test(String(n)) ? n.toFixed(20).replace(/\.?0+$/, '') : String(n));
const show = (u, decimals) => {
  const s = BigInt(u)
    .toString()
    .padStart(decimals + 1, '0');
  const f = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${s.slice(0, s.length - decimals)}${f ? `.${f}` : ''}`;
};

/**
 * `client`, kept to this page's cluster: a URL that names another is refused at once, and before its first request goes
 * out the chain's genesis block is checked, once (`checkCluster`), so an RPC whose URL hides another cluster is refused
 * whatever it says. Every RPC reached over http(s) is checked: the app's own client, and one given whose `url` is
 * http(s). A client with no such URL (a local chain of the caller's own, like the tests' LiteSVM) is used as it is.
 */
function onCluster(client) {
  if (typeof client.url === 'string') rightCluster(client.url, loot.cluster());
  if (!/^(https?|wss?):/i.test(String(client.url ?? ''))) return client;
  let checked = null;
  // A check that could not be made (the network did not answer) is made again on the next request.
  const ready = () =>
    (checked ??= loot.checkOnCluster(client).catch(e => {
      checked = null;
      throw e;
    }));
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? async (...args) => {
            await ready();
            return value.apply(target, args);
          }
        : value;
    },
  });
}

/**
 * The player's side of a live economy. `rpc` may be given instead of `rpcUrl` (any object with the client's rpc
 * methods: accounts, account, latestBlockhash, send, confirm, programAccounts, and call(method, params), the raw JSON
 * RPC request the devnet check, the slot and the compressed-NFT reads go through). `now` is the clock auctions are read
 * by (Unix seconds). Devnet only (`devnetOnly`): mainnet waits for an audit. `keyStore`: where a settle key that can't
 * be made again from the wallet's signature is kept, encrypted (`browserStore()` in a browser; null keeps keys in memory
 * only).
 */
export function solanaApp({
  spec,
  rpcUrl = null,
  rpc = null,
  wallet,
  programs = {},
  now = () => Math.floor(Date.now() / 1000),
  keyStore = browserStore(),
  sponsor = null,
}) {
  const live = spec?.live;
  if (!live?.project) throw new Error('This economy is not live yet: its xsolana.json has no "live" section.');
  if (rpc && typeof rpc.call !== 'function')
    throw new Error(
      'The rpc given has no call(method, params): a custom rpc needs it (the devnet check, the slot and compressed NFTs are read through it), as well as accounts, account, latestBlockhash, send, confirm and programAccounts.',
    );
  // The economy's file names its cluster (devnet when it names none), and this page works on it and no other.
  loot.useCluster(loot.networkOf(spec));
  if (live.program && live.program !== loot.lootProgram())
    throw new Error(
      `This economy went live on the program ${live.program}, which is not loot’s on ${loot.cluster()} (${loot.lootProgram()}): its "network" and its "live" section name two clusters.`,
    );
  const client = onCluster(rpc ?? rpcClient(loot.clusterRpcUrl(rpcUrl)));
  const project = live.project;
  /** The settle keys, each named by its job's account (`keys.js`): made again after a reload (`recover`). */
  const keys = wallet?.address ? keyring({ wallet, project, store: keyStore }) : null;
  /** The key for a job about `name` (an order's, a hold's address): one that can be made again, or a fresh one. */
  const jobKey = async name => (keys ? keys.key(name) : freshKey());
  /** The project's Core collections: an NFT of one of them is the project's own (a project may have none). */
  const collections = live.collections ?? (live.collection ? [live.collection] : []);
  const ours = collection => collection != null && collections.includes(collection);
  const tokens = new Map((spec.tokens ?? []).map(t => [t.key, t]));
  const currencyKey = spec.currency;
  const mintOf = key => {
    const t = tokens.get(key ?? currencyKey);
    if (!t) throw new Error(`No token “${key}”.`);
    return t.source === 'sol' ? NATIVE_MINT : (spec.live.mints?.[t.key] ?? t.mint);
  };
  const decimalsOf = key => {
    const t = tokens.get(key ?? currencyKey);
    return t?.source === 'sol' ? 9 : (t?.decimals ?? 0);
  };
  programs = {
    ...Object.fromEntries(
      [...tokens.values()].map(t => [mintOf(t.key), t.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM]),
    ),
    ...programs,
  };
  const programOf = mint => programs[mint] ?? TOKEN_PROGRAM;
  const part = (list, key) => {
    const p = (spec[list] ?? []).find(x => x.key === key);
    if (!p) throw new Error(`No ${list.replace(/s$/, '')} “${key}” in this economy.`);
    return p;
  };
  const read = async (name, address) => {
    const a = await client.account(address);
    if (!a) throw new Error(`Nothing at ${address}: is the economy live on this cluster?`);
    if (a.owner !== loot.lootProgram()) throw new Error(`${address} is not a loot account.`);
    return loot.decode(name, a.data);
  };
  /** A loot account, or null when there is none yet. */
  const readMaybe = async (name, address) => {
    const a = await client.account(address);
    return a?.owner === loot.lootProgram() ? loot.decode(name, a.data) : null;
  };
  /** The key of the token a lottery's tickets are paid in: the spec's `ticketCurrency`, or the token of its mint. */
  const ticketCurrencyOf = (l, lottery) =>
    l.ticketCurrency ?? [...tokens.keys()].find(k => mintOf(k) === lottery.terms.mint) ?? currencyKey;
  /** Farm hooks shared by all actions. Static lists resolve automatically. For dynamic hooks,
   * transfers[mint] describes every actual transfer, including fee-adjusted reward credit/payout, and in a farm that
   * shares its pool the move's last one when a seat gave rewards back in it (an early exit, a watched
   * NFT gone): from the farm's rewards vault back to its pool, the project the authority.
   * Explicit extra replaces resolution and must include all token hook/memo and Core adapter accounts. */
  const farmTokens = async (mints, create, { extra, transfers = {} } = {}) => {
    const selected = [...new Set(mints)];
    const resolved = await Promise.all(
      selected.map(async mint => {
        if (extra !== undefined) {
          const account = await client.account(mint);
          if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(account?.owner))
            throw new Error(`There is no supported token ${mint} on this network.`);
          return { mint, tokenProgram: account.owner, extraAccounts: [] };
        }
        try {
          return { mint, ...(await resolveTransfers(client, mint, transfers[mint] ?? [])) };
        } catch (cause) {
          throw new Error(
            `Cannot resolve farm transfers for ${mint}: ${cause.message} Supply exact transfers keyed by mint, or explicit extra hook/memo accounts.`,
            { cause },
          );
        }
      }),
    );
    const tokenPrograms = {
      ...programs,
      ...Object.fromEntries(resolved.map(({ mint, tokenProgram }) => [mint, tokenProgram])),
    };
    return {
      programs: tokenPrograms,
      extra: extra ?? resolved.flatMap(r => r.extraAccounts),
      before: [...new Set(create)].map(mint =>
        createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, mint, tokenPrograms[mint]),
      ),
    };
  };
  const farmCollection = async asset => {
    const account = await client.account(asset);
    // Core tombstones and missing assets remain valid farm-cleanup paths.
    return account?.owner === MPL_CORE && account.data[0] === 1
      ? (parseCoreAsset(account.data).collection ?? collections[0])
      : collections[0];
  };
  /** The Core collection an asset is in, or null. */
  const collectionOf = async asset => {
    const account = await client.account(asset);
    return account?.owner === MPL_CORE && account.data[0] === 1
      ? (parseCoreAsset(account.data).collection ?? null)
      : null;
  };
  /** A Token Metadata NFT's { programmable, ruleSet } from its metadata, or null for anything else (a Core asset). */
  const tokenMetadataOf = async asset => {
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
    throw new Error(
      `${holder}'s accounts of the NFT ${asset} can't take it (owned by another key, or frozen), and no fresh one could be opened.`,
    );
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
        return {
          compressed,
          hasAuthority: false,
          before: [computeUnitLimit(1_000_000), loot.proveLeafIx({ signer, compressed })],
        };
      }
    }
    const tokenMetadata = await tokenMetadataOf(asset);
    // A Token Metadata mint is taken only as an NFT: one token, no decimals, none more ever minted (NotAnNft).
    if (tokenMetadata && account && !loot.isNftMint(asset, account.data))
      throw new Error(
        `${asset} is a semi-fungible item (several units, or a mint that can still mint): only an NFT is taken.`,
      );
    const { into, before } = tokenMetadata && to ? await nftInto(asset, to, payer) : { into: null, before: [] };
    return {
      collection: await farmCollection(asset),
      hasAuthority: ours(await collectionOf(asset)),
      tokenMetadata: tokenMetadata && into ? { ...tokenMetadata, into } : tokenMetadata,
      before: tokenMetadata ? [computeUnitLimit(400_000), ...before] : [],
    };
  }
  /** Whether a Core asset's account shows the project holds it: held by another, or burned (one byte left), it is gone. */
  const coreHeld = account => account.data[0] === 1 && parseCoreAsset(account.data).owner === project;
  /**
   * Whether the project still holds `asset`, as the program reads it (`piece::held`): { held, evidence, das }. A Core
   * asset by its owner (one burned is gone); a Token Metadata NFT by the project's token account of it, and when that
   * holds none, by the account that holds it now or by its mint when it was burned (`evidence`, what shows it gone); a
   * compressed NFT by the RPC's DAS record of it (`das`, proven again on chain before anything relies on it). `held` is
   * null when nothing shows either way. `holder`: a wallet thought to hold it now (a player handing it in), whose own
   * token account is read before any search.
   */
  async function heldNow(asset, { holder = null } = {}) {
    const account = await client.account(asset);
    if (account?.owner === MPL_CORE) return { held: coreHeld(account) };
    if (account?.owner === TOKEN_PROGRAM) {
      const u64 = (data, at) => new DataView(data.buffer, data.byteOffset).getBigUint64(at, true);
      const amount = data => (data?.length >= 72 ? u64(data, 64) : 0n);
      if (amount((await client.account(loot.ata(project, asset)))?.data) === 1n) return { held: true };
      // Burned: its mint holds none.
      if (account.data.length >= 44 && u64(account.data, 36) === 0n) return { held: false, evidence: asset };
      const own = holder ? loot.ata(holder, asset) : null;
      if (own && amount((await client.account(own))?.data) === 1n) return { held: false, evidence: own };
      const found = await client.programAccounts(TOKEN_PROGRAM, [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: asset } },
      ]);
      const now = found.find(x => amount(x.account.data) === 1n);
      return now ? { held: false, evidence: now.pubkey } : { held: null };
    }
    if (account) return { held: null };
    const das = await client.call('getAsset', { id: asset }).catch(() => null);
    if (!das?.compression?.compressed) return { held: null };
    // DAS says a burned NFT at the asset's top level (`burnt`).
    const burnt = das.burnt === true || das.compression.burnt === true;
    return { held: !burnt && das.ownership?.owner === project, das };
  }
  /** `heldNow` of several NFTs: the Core assets from one read of them all, any other kind one by one. By asset. */
  async function heldEach(assets) {
    const unique = [...new Set(assets)];
    const found = unique.length ? await client.accounts(unique) : [];
    const out = new Map();
    for (const [i, asset] of unique.entries())
      out.set(asset, found[i]?.owner === MPL_CORE ? { held: coreHeld(found[i]) } : await heldNow(asset));
    return out;
  }
  /**
   * What proves `asset` gone from the project, as the instruction that lets go of it takes it (loot 0.27: a record
   * whose NFT is proven gone closes): { before, kind }, or null when the project still holds it or nothing shows either
   * way. Whoever controls a collection the project does not can take an NFT out of the project's hands or burn it. A
   * Core asset shows it by itself (`kind`: its collection now); a Token Metadata NFT by the token account that holds it
   * now, or its mint once burned (`kind.tokenMetadata.evidence`); a compressed NFT by its record, proven again as its
   * leaf is now (`before`, by `signer`). `holder`: as `heldNow` takes it. `now`: what `heldNow` read of it already.
   */
  async function goneProof(asset, signer = wallet.address, { holder = null, now = null } = {}) {
    now ??= await heldNow(asset, { holder });
    if (now.held !== false) return null;
    if (now.das) {
      const proof = await client.call('getAssetProof', { id: asset });
      const tree = await client.account(now.das.compression.tree);
      const compressed = loot.compressedFromDas({ asset: now.das, proof, treeData: tree.data });
      return { before: [computeUnitLimit(1_000_000), loot.proveLeafIx({ signer, compressed })], kind: { compressed } };
    }
    if (now.evidence)
      return { before: [], kind: { tokenMetadata: { programmable: false, ruleSet: null, evidence: now.evidence } } };
    return { before: [], kind: { collection: (await collectionOf(asset)) ?? MPL_CORE } };
  }
  /**
   * An NFT a record of the project's is to send on (`nftOf`, to `to`), or, when it is proven gone from the project
   * (`goneProof`), what shows that, with `gone` true: the instruction then finishes without it and nothing is sent.
   * `now`: what `heldNow` read of it already.
   */
  async function leaving(asset, signer = wallet.address, { to, payer = signer, now = null } = {}) {
    const proof = await goneProof(asset, signer, { now });
    if (!proof) return { ...(await nftOf(asset, signer, { to, payer })), gone: false };
    // A Core asset shows it by itself, with the accounts it always took.
    if (!proof.kind.tokenMetadata && !proof.kind.compressed) return { ...(await nftOf(asset, signer)), gone: true };
    return { before: proof.before, hasAuthority: false, ...proof.kind, gone: true };
  }
  /**
   * The release of a hold a route just made of `asset`, an NFT it owed and could only hand out (`kind`: from
   * `leaving`). The program makes such a hold at `["hold", asset, 0]` for `player`, the route's `signer` paying its
   * rent and `rentTo` named for its NFT's account's (`hold::owe`). The release right after it, by the same signer,
   * ends it: for an NFT proven gone from the project it closes the hold on the proof and nothing is sent (`NftGone`);
   * for any other it sends the NFT on to `player` (`Released`). Either way the hold's rent comes back to the signer.
   * `g`: the project, for a hold owed to the treasury.
   */
  const releaseOwed = (asset, kind, { player, rentTo }, signer, g) =>
    loot.releaseIx({
      signer,
      project,
      asset,
      ...kind,
      hold: { player, payer: signer, rent_to: rentTo, free_at: 0n },
      address: loot.pda.hold(asset, 0),
      treasury: g.treasury,
    });
  /**
   * A token's own settings that let whoever is to be paid turn a payment away, for a page to say before a player puts
   * money in: accounts that start frozen or can be switched to it (a payee closes their own account, and the one
   * opened again in its place is frozen), confidential transfers (a payee's account can refuse plain ones), and a token
   * that can't be transferred at all. `what`: the payment ("repaying", "a higher bid"); `who` and `then`: who could and
   * what they gain. Each is { power, says }.
   */
  function tokenSettings(account, what, who, then) {
    if (account?.owner !== TOKEN_2022_PROGRAM || account.data.length <= 166 || account.data[165] !== 1) return [];
    const out = [];
    if (mayStartFrozen(account))
      out.push({
        power: 'startsFrozen',
        says: `New accounts of this token start frozen, or can be switched to start frozen: ${who} can close their own account so that ${what} cannot arrive, ${then}.`,
      });
    if (extension(account.data, 4))
      out.push({
        power: 'confidential',
        says: `This token has confidential transfers: ${who} can turn plain transfers into their account off so that ${what} cannot arrive, ${then}.`,
      });
    if (extension(account.data, 9))
      out.push({
        power: 'nonTransferable',
        says: `This token can't be transferred: nothing can be paid in it, ${what} included.`,
      });
    return out;
  }
  /**
   * What `loot.prizeMetas` needs to give these prizes (`null`s are skipped): each pool's mint, each item (its kind, its
   * collection and its next serial; null for one never written), each NFT's kind (`nfts`, and `nft` for one), the
   * project's first collection, a compressed NFT's proof, which goes first in the transaction (`before`), and for a
   * roll its box, decoded (`boxes`, `boxesOf`).
   */
  async function prizeInputs(prizes, signer = wallet.address, winner = wallet.address) {
    const out = { poolMints: {}, items: {}, nfts: {}, nft: undefined, collection: collections[0], before: [] };
    out.boxes = await boxesOf(prizes.filter(Boolean).flatMap(p => (p.Roll ? [p.Roll[0]] : [])));
    for (const prize of prizes.filter(Boolean)) {
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
  const sheetOf = async nft => {
    const found = await client.account(loot.pda.sheet(project, nft));
    return Object.fromEntries(
      (loot.decodeSheet(found?.owner === loot.lootProgram() ? found.data : null)?.attributes ?? []).map(a => [
        a.key,
        a.value,
      ]),
    );
  };
  let projectState = null;
  const projectNow = async () => (projectState ??= await read('Project', project));
  /** A spec auction's address: it names the seller, which xsolana.json records once it is live. */
  const auctionAt = a => {
    if (!a.seller) throw new Error(`The auction “${a.key}” has no seller in xsolana.json: publish the economy again.`);
    return loot.pda.auction(project, a.seller, a.id);
  };

  const itemKeyOf = id => (spec.items ?? []).find(it => it.id === Number(id))?.key ?? null;
  /** Who holds a collectible now. */
  const ownerOf = async asset => parseCoreAsset((await client.account(asset)).data).owner;
  /** `{ asset, farm }` for a Core asset on its seat in one of the economy's farms of these custodies, or null. */
  const seatedIn = async (asset, custodies = ['escrow', 'freeze']) => {
    for (const f of (spec.farms ?? []).filter(
      x => x.stakes === 'collectibles' && custodies.includes(x.custody ?? 'escrow'),
    )) {
      if (await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset))) return { asset, farm: f.id };
    }
    // Or boosting the player's token seat in a farm of tokens: that seat, not one of its own (`booster`).
    for (const f of (spec.farms ?? []).filter(
      x => x.stakes !== 'collectibles' && custodies.includes(x.custody ?? 'escrow'),
    )) {
      const seat = wallet?.address
        ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address))
        : null;
      if (seat?.asset === asset) return { asset, farm: f.id, booster: true };
    }
    return null;
  };
  /** The same for one the project holds: staked in escrow. */
  const escrowedIn = async asset =>
    (await ownerOf(asset).catch(() => null)) === project ? seatedIn(asset, ['escrow']) : null;
  /** The same for one the project locks in the player's wallet: staked in a farm that freezes (a soulbound Core asset
   * carries no lock to tell it is staked, so it goes alone). */
  const lockedIn = async asset => {
    const seated = await seatedIn(asset, ['freeze']);
    if (!seated) return null;
    const account = await client.account(asset);
    return account?.owner === MPL_CORE && parseCoreAsset(account.data).soulbound ? null : seated;
  };
  /** The player's collectibles of this project (in any of its collections), each with the item it is (its "item_id" attribute). */
  async function owned(owner = wallet?.address) {
    const found = (
      await Promise.all(collections.map(c => client.programAccounts(MPL_CORE, ownedAssetFilters(owner, c))))
    ).flat();
    return found.map(({ pubkey, account }) => {
      const a = parseCoreAsset(account.data);
      const itemId = a.attributes?.item_id !== undefined ? Number(a.attributes.item_id) : null;
      return { asset: pubkey, ...a, itemId, item: itemId === null ? null : itemKeyOf(itemId) };
    });
  }
  /** A token seat's refresh (`seat` decoded), with its booster's accounts (a compressed one proven first), to go first in
   * a stake or a compound's transaction (`loot.stakeRefreshFirst`). */
  async function refreshOf(f, farm, seat) {
    const { before, ...nft } = seat.asset !== NOBODY ? await nftOf(seat.asset) : { before: [] };
    return [
      ...before,
      loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by: seat.player, seat, ...nft }),
    ];
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
      const f = (spec.farms ?? []).find(x => loot.pda.farm(project, x.id) === farm);
      const t = f ? tokens.get(f.stakes) : null;
      const needs = t ? `${show(atLeast, decimalsOf(t.key))} ${t.symbol ?? t.key}` : `${atLeast} (in base units)`;
      const where = f ? `“${f.name}”` : 'its farm';
      if (!seat || BigInt(seat.amount) < BigInt(atLeast))
        throw new Error(`You need at least ${needs} staked in ${where} to ${what}.`);
      // Only a locked stake counts: its tier's lock still running.
      const lock = BigInt((await read('Farm', farm)).tiers[seat.tier]?.lock ?? 0);
      if (lock === 0n || BigInt(now()) >= BigInt(seat.since) + lock)
        throw new Error(
          `Your stake in ${where} counts only while it is locked: stake in a tier with a lock (staking again starts a new one) to ${what}.`,
        );
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
    const equals = rule.test?.OneOf?.texts?.length === 1 ? rule.test.OneOf.texts[0] : undefined;
    const item = rule.of?.Item?.[0];
    const named = rules.map(r => r.of?.Collection?.[0]).find(c => c && !ours(c));
    const other = named ?? null;
    const passes = (r, c) => {
      if (r.of?.Item?.[0] !== undefined && c.itemId !== Number(r.of.Item[0])) return false;
      const value = c.attributes?.[r.key];
      if (r.test?.AtLeast?.[0] !== undefined) return Number(value) >= Number(r.test.AtLeast[0]);
      if (r.test?.OneOf?.texts)
        return r.test.OneOf.texts.map(String).includes(String(r.key === 'item_id' ? c.itemId : value));
      return true;
    };
    const pass = c => rules.every(r => passes(r, c));
    // A rule on the player's profile: the client passes the profile itself (`loot.shownFor`); here it is only read, to
    // say plainly when it falls short.
    if (loot.readsProfile(rule)) {
      const found = await client.account(loot.pda.profile(project, wallet.address));
      const attributes = Object.fromEntries(
        (loot.decodeProfile(found?.owner === loot.lootProgram() ? found.data : null)?.attributes ?? []).map(a => [
          a.key,
          a.value,
        ]),
      );
      if (passes(rule, { attributes })) return null;
      throw new Error(
        `You need ${rule.key} ${atLeast !== undefined ? `${atLeast} or more` : equals !== undefined ? equals : 'set'} on your profile to ${what}.`,
      );
    }
    if (other) {
      const found = await client.programAccounts(MPL_CORE, ownedAssetFilters(wallet.address, other));
      for (const { pubkey, account } of found) {
        const a = parseCoreAsset(account.data);
        if (pass({ attributes: { ...a.attributes, ...(await sheetOf(pubkey)) } })) return { asset: pubkey };
      }
      throw new Error(
        `You need an NFT of the collection ${other}${atLeast !== undefined ? ` with ${rule.key} ${atLeast} or more` : equals !== undefined ? ` whose ${rule.key} is ${equals}` : ''} to ${what}.`,
      );
    }
    const found = (await owned()).find(pass);
    if (found) return found.asset;
    const needs =
      item !== undefined
        ? `a ${(spec.items ?? []).find(it => it.id === Number(item))?.name ?? 'collectible of this project'}`
        : 'a collectible of this project';
    throw new Error(
      `You need ${needs}${atLeast !== undefined ? ` with ${rule.key} ${atLeast} or more` : equals !== undefined ? ` whose ${rule.key} is ${equals}` : ''} to ${what}.`,
    );
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
    const opens = instructions.some(ix => ix.programId === ASSOCIATED_TOKEN_PROGRAM && ix.keys[1]?.pubkey === wrapped);
    const closes = instructions.some(
      ix => ix.programId === TOKEN_PROGRAM && ix.data?.[0] === 9 && ix.keys[0]?.pubkey === wrapped,
    );
    if (closes) return instructions;
    const close = closeTokenAccount(wrapped, wallet.address, wallet.address);
    if (opens || (await client.account(wrapped))) return [...instructions, close];
    const touches = instructions.some(ix => ix.keys?.some(k => k.pubkey === wrapped));
    return touches
      ? [createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, NATIVE_MINT), ...instructions, close]
      : instructions;
  }

  /**
   * Build, have the wallet sign, send and confirm. Extra signers (fresh keys) sign first. Returns the signature.
   * `keepWrapped`: leave the player's wrapped-SOL account open (a bid's: what is topped comes back there).
   * Its size is checked before the wallet signs (`sendFitting`): one that fits a legacy transaction and leaves the
   * wallet less than `WALLET_ADDS_BYTES` for the checks it adds goes as v0 with the project's standing tables, when
   * they make it smaller (the same one prompt); a transaction too big for a legacy one goes as one v0
   * transaction with a lookup table the wallet makes first (one to three more approvals, and the table's rent until the
   * player closes it, which `claims()` lists); only when even that is too big does each compressed NFT's `prove_leaf`
   * go alone, after the table and before the rest. A compressed NFT's record closes in the same transaction, its prover
   * signing (`loot.withLeafCloses`), so its rent comes straight back.
   */
  /**
   * The project's standing lookup tables (made at go-live, `spec.live.tables`), each as the chain holds it now: one
   * deactivated (or gone) is left out, and a transaction then makes a table of its own as before.
   */
  let standingTables = null;
  async function standing() {
    standingTables ??= (async () => {
      const addresses = spec.live?.tables ?? [];
      const found = addresses.length ? await client.accounts(addresses) : [];
      return addresses.flatMap((address, i) => {
        const table = readTable(found[i] && { ...found[i], owner: found[i].owner ?? LOOKUP_TABLE_PROGRAM });
        return table && table.deactivationSlot === null ? [{ address, addresses: table.addresses }] : [];
      });
    })();
    return standingTables;
  }

  /**
   * The room kept in a step the player's wallet signs, for what the wallet adds before it signs (`WALLET_ADDS_BYTES`);
   * none for a wallet that says it signs no v0 transaction (`wallet.versions`), which gets a legacy one as before.
   */
  const walletRoom = () => (wallet?.versions && !wallet.versions.includes(0) ? 0 : WALLET_ADDS_BYTES);

  async function send(instructions, extra = [], { keepWrapped = false } = {}) {
    if (!wallet?.address) throw new Error('Connect a wallet first.');
    // A compressed NFT's record is closed in the transaction that used it, its prover signing: its rent comes back.
    instructions = loot.withLeafCloses(instructions);
    if (!keepWrapped) instructions = await unwrapAfter(instructions);
    if (sponsor) {
      const sponsored = await sendSponsored(instructions, extra);
      if (sponsored) return sponsored;
    }
    return sendUnsponsored(instructions, extra);
  }

  /** The player's step as they pay for it themselves: their wallet the fee payer (`sendFitting`). */
  async function sendUnsponsored(instructions, extra = []) {
    const sign = async message => {
      const { signers } = readTransaction(wireTransaction(message));
      const sigs = await Promise.all(
        signers.map(async s =>
          extra.find(k => k.address === s) ? extra.find(k => k.address === s).sign(message) : new Uint8Array(64),
        ),
      );
      return wallet.signTransaction(wireTransaction(message, sigs));
    };
    // The project first in a table, so claims() knows a table whose later steps were never sent as this project's.
    return (
      await sendFitting({
        rpc: client,
        payer: wallet.address,
        instructions,
        sign,
        alone: isProveLeaf,
        first: [project],
        standing: await standing(),
        room: walletRoom(),
        // read again just before a step goes as v0 for the room's sake: a table retired since is passed by
        fresh: () => ((standingTables = null), standing()),
      }).catch(inWords)
    ).signature;
  }

  const sendNow = (...args) => send(...args);

  /** The most the sponsor pays a transaction (its top-up and network fee), as the app was told. */
  // It lends the player that, less room for the network fee, and takes back what the step didn't need.
  const sponsorMax = sponsor ? BigInt(sponsor.maxLamports ?? SPONSOR_MAX_LAMPORTS) - SIGNATURE_FEE * 4n : 0n;

  /** Every account a list of instructions names, its programs too. */
  const namedIn = instructions => [
    ...new Set(instructions.flatMap(ix => [ix.programId, ...ix.keys.map(k => k.pubkey)])),
  ];

  /**
   * The player's step with the sponsor paying (`sponsor`, js/play/sponsor.js): the sponsor the fee payer and the
   * player topped up first by what the step costs them in fees and rent (a dry run, as the sponsor's server will
   * check it), the player's wallet signing, then the sponsor's server. Null when it can't be sponsored as one
   * transaction (it needs a lookup table of its own, or proofs sent first), or the sponsor refused it and the player
   * pays instead (`sponsor.playerPaysIfRefused`, the default): the step then goes as the player's own.
   */
  async function sendSponsored(instructions, extra) {
    const me = wallet.address;
    const tables = await standing();
    const { blockhash, lastValidBlockHeight } = await client.latestBlockhash();
    // Lent the most, the step is tried; then sent lent the same, the player giving back last all but what it costs in
    // fees and rent: a step can need more SOL midway than it costs (a wrapped-SOL account it opens and closes).
    // It leads with a compute unit limit (all a transaction can have) and a unit price of 0, the price a sponsor
    // pays unless its server says more: a wallet that adds its own priority fee only where a transaction sets none
    // (Phantom does, to one with no signature on it yet) is then handed one it signs as it stands, and the sponsor's
    // server, which refuses a price it did not agree to, takes it. A step keeps the kind of transaction it had: one
    // that fits a legacy transaction stays one (without the two where they would not fit), and only a step that
    // needed the project's lookup tables before goes as v0.
    const compile = (back = 0n) => {
      const list = [
        sponsorTopUp(sponsor.address, me, sponsorMax),
        ...instructions,
        ...(back > 0n ? [sponsorGiveBack(sponsor.address, me, back)] : []),
      ];
      return compileKeepingKind({
        payer: sponsor.address,
        blockhash,
        led: withComputeBudget(list, { units: SPONSORED_UNITS, microLamports: 0n }),
        plain: list,
        tables,
      });
    };
    const tried = compile();
    if (!tried) return null;
    const addresses = namedIn([sponsorTopUp(sponsor.address, me, 0n), ...instructions]);
    const pre = await client.accounts(addresses);
    // A step loot refuses is refused in words; one that fails otherwise (the sponsor short of SOL) goes as the player's.
    const run = await client
      .simulate(wireTransaction(tried), { accounts: addresses, replaceBlockhash: true })
      .catch(e => (loot.lootError(e?.logs ?? []) ? inWords(e) : null));
    if (!run) return null;
    const post = run.accounts;
    const at = a => addresses.indexOf(a);
    const balance = a => (a ? BigInt(a.lamports) : 0n);
    const cost = sponsoredCost({
      addresses,
      pre,
      post,
      project,
      skip: [sponsor.address, me],
      ...stepShape(instructions),
    });
    const spend = balance(pre[at(me)]) + sponsorMax - balance(post[at(me)]);
    const message = compile(sponsorMax - topUpFor({ spend, cost }));
    if (!message) return null;
    const { signers } = readTransaction(wireTransaction(message));
    const sigs = await Promise.all(
      signers.map(async s => extra.find(k => k.address === s)?.sign(message) ?? new Uint8Array(64)),
    );
    const signed = await wallet.signTransaction(wireTransaction(message, sigs));
    let wire;
    try {
      wire = await sponsor.sign(signed);
    } catch (e) {
      if (sponsor.playerPaysIfRefused === false) throw e;
      return null;
    }
    const signature = await client.send(wire).catch(inWords);
    await client.confirm?.(signature, { lastValidBlockHeight });
    return signature;
  }

  /**
   * Several independent steps of the player's, each one transaction (`lists`: their instructions), signed in one wallet
   * prompt when the wallet signs several at once (`wallet.signTransactions`), then sent in order; one by one otherwise,
   * and for a step too big for one transaction. Returns each step's { signature } or { error }.
   */
  async function sendBatch(lists) {
    const settled = p =>
      p.then(
        signature => ({ signature }),
        e => ({ error: e.message }),
      );
    let signed = null;
    let messages = [];
    let lastValidBlockHeight = null;
    if (wallet?.signTransactions && lists.length > 1 && !sponsor) {
      const latest = await client.latestBlockhash();
      lastValidBlockHeight = latest.lastValidBlockHeight;
      const tables = await standing();
      for (const l of lists)
        messages.push(
          compileFitting({
            payer: wallet.address,
            blockhash: latest.blockhash,
            instructions: await unwrapAfter(loot.withLeafCloses(l)),
            tables,
            room: walletRoom(),
          }),
        );
      const wires = messages.filter(Boolean).map(m => wireTransaction(m));
      const back = wires.length > 1 ? await wallet.signTransactions(wires).catch(() => null) : null;
      if (back) signed = messages.map(m => (m ? back.shift() : null));
    }
    const out = [];
    for (const [i, l] of lists.entries()) {
      const wire = signed?.[i];
      const confirmed = async () => {
        const signature = await client.send(wire).catch(inWords);
        await client.confirm?.(signature, { lastValidBlockHeight });
        return signature;
      };
      out.push(await settled(wire ? confirmed() : send(l)));
    }
    return out;
  }

  /**
   * Throws `e` with loot's reason in words in place of a bare code: a wallet whose own dry run failed often says only
   * "custom program error: 0x17b5". A code is loot's when the logs name loot as the program that failed, or, with no
   * logs, when it is one of loot's (Anchor's codes start at 6000; the token programs' are small).
   */
  function inWords(e) {
    // The program logs an error's name only (its text is compiled out): the IDL's sentence for it.
    const logged = e?.logs ? loot.lootError(e.logs) : null;
    if (logged)
      throw Object.assign(new Error(`${logged.msg} (${logged.name}).`, { cause: e }), {
        code: logged.code,
        name: logged.name,
        logs: e.logs,
      });
    const said = String(e?.message ?? '');
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(said);
    const failed = e?.logs?.find(line => / failed: custom program error: 0x/i.test(line));
    const known = m && (!failed || failed.includes(loot.lootProgram())) ? loot.ERRORS[parseInt(m[1], 16)] : null;
    if (!known) throw e;
    throw Object.assign(new Error(`${known.msg} (${known.name}).`, { cause: e }), {
      code: parseInt(m[1], 16),
      name: known.name,
      logs: e.logs,
    });
  }

  /**
   * Build, sign with `key` alone (it pays), send and confirm: a throwaway key's transaction. No wallet prompt. Legacy,
   * or v0 with the project's standing tables (which cost it nothing); the key holds no rent for a table of its own.
   */
  async function sendAs(key, instructions) {
    instructions = loot.withLeafCloses(instructions);
    return (
      await sendFitting({
        rpc: client,
        payer: key.address,
        instructions,
        sign: async message => wireTransaction(message, [await key.sign(message)]),
        table: false,
        standing: await standing(),
      }).catch(inWords)
    ).signature;
  }

  /**
   * Refuses, in words, to stake `asset` in tier `tier` of farm `f` when its unstake (with the tier's prize, and as a
   * forfeit) couldn't be sent even as a v0 transaction with a lookup table, its proof sent first (`sendPlan`).
   */
  async function exitFits(f, farm, asset, nft, before, tier, staking) {
    const prize = farm.tiers[tier]?.prize ?? null;
    const given = await prizeInputs([prize]);
    // The rewards' accounts as the stake resolved them (a hook that needs each transfer named is sized without them).
    const token = {
      ...staking,
      before: [
        createAssociatedTokenAccountIdempotent(
          wallet.address,
          wallet.address,
          farm.rewards_mint,
          staking.programs[farm.rewards_mint] ?? TOKEN_PROGRAM,
        ),
      ],
    };
    const exit = forfeit => [
      ...before,
      ...(forfeit ? [] : [...given.before, ...token.before]),
      loot.unstakeNftIx({
        player: wallet.address,
        project,
        id: f.id,
        farm,
        asset,
        ...nft,
        forfeit,
        roll: farm.tiers[tier]?.roll ?? null,
        nonce: 1n,
        tier,
        projectCollection: given.collection,
        poolMints: given.poolMints,
        items: given.items,
        nft: given.nft,
        ...token,
      }),
    ];
    for (const forfeit of [false, true]) {
      const instructions = exit(forfeit).filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      if (
        !sendPlan({
          payer: wallet.address,
          instructions: [computeUnitLimit(1_400_000), ...instructions],
          alone: isProveLeaf,
        })
      )
        throw new Error(
          `Not staked: this NFT couldn't come back out of “${f.name ?? f.key}”. Its unstake${forfeit ? ', even giving up the rewards,' : ''} would lock more accounts than one transaction can (${transactionLocks(wallet.address, [computeUnitLimit(1_400_000), ...instructions], { asV0: true })} with its lookup table; at most 64), so it would stay in the farm.`,
        );
    }
  }

  /** An NFT's kind as a route's `ticket` or `nft` takes it: without its asset. */
  const kindOnly = ({ asset: _, ...kind }) => kind;

  /**
   * The key job rule (AGENTS.md). A step after the wallet's prompt (a settle, an ask for a roll, a release) is sent by a
   * throwaway key made in memory for that one job. `keyFor(pays)` makes it, and the transfer that funds it, which goes
   * in the wallet's own transaction: what its steps pay (`pays`: their fees, an ask's oracle fee, the rent of what a
   * settle opens or mints, `loot.settleRent`) and the rent minimum read from the cluster, plus one spare fee so it can
   * always empty itself. A key pays for an account only with lamports the wallet gave it for that, and never makes a
   * proof record: then the wallet sends that step. `key`: one made already (a box's open names it before it knows how
   * many settles it funds).
   */
  async function keyFor(pays = SIGNATURE_FEE, key = null) {
    key ??= await freshKey();
    return {
      key,
      fund: transferLamports(wallet.address, key.address, (await rentEmpty()) + BigInt(pays) + SIGNATURE_FEE),
    };
  }

  /** The rent minimum of an account of no data, as the cluster says it (once). A key must hold it, past its fee, to pay
   * a transaction's fee: a fee payer stays rent-exempt or ends empty. */
  let rentMinimum = null;
  const rentEmpty = async () =>
    (rentMinimum ??= BigInt(
      await client.call('getMinimumBalanceForRentExemption', [0]).catch(() => Number(RENT_EMPTY)),
    ));

  /** Whether `instructions` would land as `payer` sends them now (a dry run, with the standing tables when they need
   * them), and the accounts `watch` as they would be after: { ok, accounts, error }, `error` loot's when it refused
   * ({ code, name, msg }, `loot.lootError`). */
  async function dryRun(payer, instructions, watch = []) {
    // A sponsored player's step is tried as it will be sent: the sponsor pays, and tops the player up (here by the
    // most it pays, so a player with no SOL is tried as one the sponsor covers).
    if (sponsor && payer === wallet?.address) {
      instructions = [sponsorTopUp(sponsor.address, payer, sponsorMax), ...instructions];
      payer = sponsor.address;
    }
    const { blockhash } = await client.latestBlockhash();
    const message = compileFitting({ payer, blockhash, instructions, tables: await standing() });
    if (!message) return { ok: false, accounts: [], error: null };
    let error = null;
    const r = await client.simulate(wireTransaction(message), { accounts: watch, replaceBlockhash: true }).catch(e => {
      error = loot.lootError(e?.logs ?? []);
      return null;
    });
    return { ok: Boolean(r), accounts: r?.accounts ?? [], error };
  }

  /** A throwaway key empties itself back to the wallet: all it holds now, less its own fee. Nothing when it holds no more
   * than that fee (a settle of its that failed on chain took its fee: the wallet then pays the move, one more prompt). */
  async function emptyKey(key) {
    const left = BigInt(await client.balance(key.address).catch(() => 0n));
    if (left >= (await rentEmpty()) + SIGNATURE_FEE)
      await sendAs(key, [transferLamports(key.address, wallet.address, left - SIGNATURE_FEE)]).catch(() => null);
    else if (left > 0n) await send([transferLamports(key.address, wallet.address, left)], [key]).catch(() => null);
    // A key kept in storage is dropped once it holds nothing.
    if (key.name && !(BigInt(await client.balance(key.address).catch(() => 1n)) > 0n)) keys?.forget(key.name);
  }

  /**
   * Rolls in one prompt: a step that makes orders waiting for their roll (a craft, a buy, a mission left, a grant or a
   * contest prize, a lot won) asks for each in the same transaction, and a throwaway key it funds then settles each (the
   * key job rule: funded with each settle's fees and what it may open or mint, `loot.settleRent`). A dry run finds them:
   * the accounts the step writes that come out as orders waiting (a limit can hold a round back, so only what it would
   * make). A box with nothing in stock refuses the ask, and with it the step (`SoldOut`): nothing is sent, and the
   * player is told. When the step and its asks would not land together for any other reason (a missing prize vault,
   * too big a transaction), the step goes alone and its rolls wait in `claims()`. Returns { signature, rolls }.
   */
  async function sendRolling(instructions) {
    const watch = [
      ...new Set(
        instructions
          .filter(ix => ix.programId === loot.lootProgram())
          .flatMap(ix => ix.keys.filter(k => k.isWritable && !k.isSigner).map(k => k.pubkey)),
      ),
    ];
    const after = (await dryRun(wallet.address, instructions, watch)).accounts;
    const waiting = watch.flatMap((address, i) => {
      const a = after[i];
      if (a?.owner !== loot.lootProgram() || loot.accountKind(a.data) !== 'Order') return [];
      const order = loot.decode('Order', a.data);
      return order.status === 'Waiting' && order.player === wallet.address ? [[address, order]] : [];
    });
    if (!waiting.length) return { signature: await send(instructions), rolls: [] };
    // Sponsored, a settle key isn't funded (a plain account the player could empty is never sponsored): the step asks
    // for each roll, and the player's wallet settles it once it is answered (one more prompt, sponsored too).
    if (sponsor) {
      const asked = [...instructions];
      for (const [orderAddress, order] of waiting) asked.push(...(await asksFor(wallet.address, orderAddress, order)));
      const tried = await dryRun(wallet.address, asked);
      const signature = await send(tried.ok ? asked : instructions);
      const rolls = [];
      if (tried.ok) for (const [orderAddress] of waiting) rolls.push(await collect(orderAddress, { opened: true }));
      return { signature, rolls };
    }
    const asks = [];
    const funds = [];
    const burners = [];
    for (const [orderAddress, order] of waiting) {
      const box = await read('LootBox', order.loot_box);
      // Each order its own key, named by it (it can be made again after a reload, `recover`): its settle's fee, a spare
      // for its parts and its give-back, and what its settle may open or mint. The ask names it as the order's settler.
      const { key, fund } = await keyFor(
        SIGNATURE_FEE * 3n + loot.settleRent(box, Number(order.opens ?? 1), await itemsOf(box)),
        await jobKey(orderAddress),
      );
      asks.push(...(await asksFor(wallet.address, orderAddress, order, key.address)));
      funds.push(fund);
      burners.push(key);
    }
    const all = [...instructions, ...asks, ...funds];
    const tried = await dryRun(wallet.address, all);
    if (tried.error?.name === 'SoldOut')
      throw Object.assign(
        new Error(
          'The box this rolls has nothing left to give right now (SoldOut): nothing was sent. Try again once it is restocked.',
        ),
        { code: tried.error.code, name: 'SoldOut' },
      );
    // Too heavy to be answered: a step sent alone would pay for a roll that can only fail.
    if (tried.error?.name === 'PackTooLarge')
      throw Object.assign(
        new Error(
          "The box this rolls is too heavy for the oracle's answer as it stands (PackTooLarge): nothing was sent.",
        ),
        { code: tried.error.code, name: 'PackTooLarge' },
      );
    if (!tried.ok) return { signature: await send(instructions), rolls: [] };
    const signature = await send(all);
    const rolls = [];
    for (const [k, [orderAddress]] of waiting.entries())
      rolls.push(await collect(orderAddress, { burner: burners[k], opened: true }));
    return { signature, rolls };
  }

  /**
   * Waits for an order's roll (the oracle answers a moment after the open), then settles it. With `burner` (the
   * throwaway key the open funded), the burner signs and pays the settle, and gives the rest back: no wallet prompt.
   * The order names it (`settler`), so it may settle; when the player or the project did first, the burner only gives its lamports back.
   * An NFT of the order the project no longer holds (its collection took it back or burned it) is passed over: a
   * stash's NFT won is not given (its place in `assets` is null) and the NFT rolled on is not sent back; `gone` lists
   * them, with `says`. `putBack`: NFTs
   * won that the player puts back into their stash in place of taking them (one whose collection now refuses to let it
   * move); `giveUp`: the places in the order's `won` of tokens or collectibles the player gives up because they can't
   * receive them (an account the token's issuer froze, a collection that refuses the mint): tokens given up stay in the
   * project's vault, a collectible is never made. The player signs either settle. A settle that fails because the player
   * can't receive a prize says which (`error.giveUp`), so a page can offer to give them up and take the rest.
   */
  async function collect(orderAddress, options = {}) {
    only(options, ['timeoutMs', 'burner', 'putBack', 'giveUp', 'opened', 'landed', 'keepBurner'], 'collect');
    try {
      return await collectOnce(orderAddress, options);
    } catch (e) {
      // The throwaway key is never left holding the player's SOL: whatever stopped the collect (a roll not in yet, a
      // settle someone else sent first), it gives its lamports back before the error is said. Collecting again later
      // needs no burner: the player signs that settle.
      const { burner } = options;
      if (!burner) throw e;
      await emptyKey(burner);
      if (!(await client.account(orderAddress)))
        return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
      throw e;
    }
  }

  async function collectOnce(
    orderAddress,
    {
      timeoutMs = 60_000,
      burner = null,
      putBack = [],
      giveUp = [],
      opened = false,
      landed = null,
      keepBurner = false,
    } = {},
  ) {
    // The player's own choices (an NFT put back, a prize given up) are theirs to sign: no burner settles them.
    const chooses = putBack.length > 0 || giveUp.length > 0;
    const started = Date.now();
    // `landed`: the slot one's own open landed in; the order is read from a node that has seen it.
    const current = async () => {
      const account = await client.account(orderAddress, 'confirmed', landed != null ? { minContextSlot: landed } : {});
      return account?.owner === loot.lootProgram() ? loot.decode('Order', account.data) : null;
    };
    let order = await current();
    // Right after one's own confirmed open, no order is "not seen yet", never "settled already": a node of the RPC may
    // lag behind the one that confirmed it. It is read again for a few seconds first.
    for (let i = 0; !order && opened && i < 6; i++) {
      await sleep(1000);
      order = await current();
    }
    // A roll a mission or a recipe made waits to be asked for (or asked again, the oracle never having answered):
    // its player or the project's keys ask, here the player.
    if (order && loot.rollAskable(order, await slotNow(), await chainNow())) {
      await askRoll(orderAddress);
      order = await current();
    }
    while (['Pending', 'Asked'].includes(order?.status) && Date.now() - started < timeoutMs) {
      await sleep(1500);
      order = await current();
    }
    // A free roll whose answer found nothing at all in stock waits again: for a restock, or for its player to end it.
    if (order?.status === 'Waiting') {
      throw new Error(
        "The box this rolls had nothing left to give when the roll landed, so the roll waits: collect it again once the box is restocked. Collected while the box is still empty, the player's own ask ends it with nothing.",
      );
    }
    if (!order) {
      if (burner && !keepBurner) await emptyKey(burner);
      // One's own open still not seen after that: say so plainly, never that it was settled (claims() lists it).
      if (opened)
        return {
          order: orderAddress,
          settled: null,
          says: 'The network doesn’t show this order yet: collect it again in a moment (claims() lists it).',
        };
      return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
    }
    if (order.status === 'Pending')
      throw new Error(
        'The oracle has not rolled yet: try collecting again in a minute (an order never rolled refunds after about 10 minutes).',
      );
    if (order.status === 'Asked')
      throw new Error(
        'The oracle has not rolled yet: try collecting again in a minute (a roll never answered is asked again after about 10 minutes).',
      );
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
    for (const won of order.won) {
      const id = won.Item?.item ?? won.Compressed?.item;
      if (id !== undefined && !(id in items)) items[id] = await read('Item', loot.pda.item(project, id));
    }
    // A compressed prize is minted into the tree its box names (any of the project's with room), the next NFT it mints.
    const treeOf = async () => {
      if (!order.won.some(w => w.Compressed)) return {};
      const box = await read('LootBox', order.loot_box);
      const tree = box.entries.flatMap(e => e.prizes).find(p => p.Compressed)?.Compressed.tree;
      const config = (await client.account(loot.pda.treeConfig(tree)))?.data;
      // An item's collection without Bubblegum's plugin mints nothing: the prizes after it take its place in the tree.
      const unminted = [];
      for (const c of new Set(
        order.won
          .filter(w => w.Compressed)
          .map(w => items[w.Compressed.item]?.collection)
          .filter(Boolean),
      )) {
        const data = (await client.account(c))?.data;
        if (!data || !parseCoreCollection(data).bubblegum) unminted.push(c);
      }
      return {
        tree,
        unminted,
        treeMinted: config ? config.subarray(80, 88).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n,
      };
    };
    const holders = await holdersOf(order.shares);
    // NFTs of this order the project no longer holds (their collection took them back or burned them): the settle
    // passes each over on that proof. A stash's NFT won is then not given; the NFT rolled on is not sent back.
    const lost = new Set();
    // Given by its fate to a wallet that is an account of the loot program, the NFT goes back to the player.
    const gives = order.held ? order.fate?.then?.Give?.[0] : undefined;
    const handBack = gives !== undefined && loot.handsBack(await client.account(gives));
    /** The settle's part up to `upto` (`loot.SETTLE_LAST`: all that is left; 0: the split alone) as `signer` sends it,
     * and what goes before it: each compressed NFT's proof, a fresh token account. */
    const settleBy = async (signer, upto = loot.SETTLE_LAST) => {
      const nfts = {};
      const proving = [];
      const end = Math.min(order.won.length, upto);
      for (const won of order.won.slice(Number(order.settled ?? 0), end)) {
        if (won.Nft && !putBack.includes(won.Nft.nft)) {
          // A fresh token account a Token Metadata NFT needs (its holder's own can't take it) is the wallet's to open: a
          // settle with anything before it is the wallet's to send.
          const {
            before,
            hasAuthority: _,
            gone,
            ...kind
          } = await leaving(won.Nft.nft, signer, { to: order.player, payer: wallet.address });
          if (gone) lost.add(won.Nft.nft);
          nfts[won.Nft.nft] = kind;
          proving.push(...before);
        }
      }
      // The NFT the roll was on: its kind, and for a compressed one a proof first. One the order holds may be gone.
      const {
        before: subjectProof,
        gone: subjectGone,
        ...subject
      } = order.subject && order.subject !== NOBODY
        ? order.held
          ? await leaving(order.subject, signer)
          : await nftOf(order.subject, signer)
        : { before: [] };
      if (subjectGone) lost.add(order.subject);
      const ix = loot.settleIx({
        signer,
        orderAddress,
        order,
        projectState: g,
        items,
        nfts,
        putBack,
        giveUp,
        subject,
        handBack,
        holders,
        programs,
        upto,
        ...(await treeOf()),
      });
      return { ix, nfts, before: [...subjectProof, ...proving].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM) };
    };
    // An order whose settle doesn't fit one transaction (the instruction trace, 64 accounts, 1,232 bytes) settles in
    // parts, each its own transaction, from where the last stopped. The first splits the payment, its shares' accounts
    // with it (alone, `upto` 0, when not even one prize fits beside them); parts that hand prizes over (`upto` where
    // each stops), as many as the trace holds (`settlePartEnd`) and fewer until they fit; then a last part
    // (`SETTLE_LAST`) with the NFT rolled on. The burner sends each, paying what each mints with what the open funded it
    // with; the player's wallet, a part it can't.
    const signatures = [];
    // A key the order doesn't name can't settle it (`Order::settler`): then the player signs.
    const by = burner && !chooses && order.settler === burner.address ? burner.address : wallet.address;
    const fits = async instructions =>
      Boolean(compileFitting({ payer: by, blockhash: NOBODY, instructions, tables: await standing() })) &&
      transactionLocks(by, instructions) <= 64;
    const part = async end => [computeUnitLimit(loot.settleComputeUnits(order)), (await settleBy(by, end)).ix];
    const sendPart = async end =>
      signatures.push(by === wallet.address ? await send(await part(end)) : await sendAs(burner, await part(end)));
    for (;;) {
      const from = Number(order.settled ?? 0);
      if (from >= order.won.length) break;
      let end = loot.settlePartEnd(order, from, items);
      if (end >= order.won.length && (await fits(await part(loot.SETTLE_LAST)))) break;
      while (end > from + 1 && !(await fits(await part(end)))) end--;
      await sendPart(Number(order.drew ?? 0) > 0 && !(await fits(await part(end))) ? 0 : end);
      order = await current();
      if (!order) return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
    }
    // Room for every move the shape makes (`loot.settleComputeUnits`), and for a settle of several NFTs the bigger heap
    // the program's allocator uses (`loot.settleHeapFrame`).
    const heap = loot.settleHeapFrame(order);
    const budget = [computeUnitLimit(loot.settleComputeUnits(order)), ...(heap ? [requestHeapFrame(heap)] : [])];
    // The settle opens or mints what the order won (a collectible, a token account, a Sheet, the fate's writes), paid by
    // whoever signs it: the burner, with what the open funded it with (`loot.settleRent`). It settles alone unless the
    // settle needs something first (a proof, a fresh token account) or doesn't fit a legacy transaction (a lookup
    // table's rent is the wallet's to pay), and only when a dry run says it lands as the burner sends it; else the
    // wallet settles (one more prompt). An NFT put back into its stash (one its collection no longer lets move) is the
    // player's own choice: they sign.
    let signature = null;
    let emptied = false;
    const byBurner = burner && !chooses && order.settler === burner.address ? await settleBy(burner.address) : null;
    const alone = byBurner && !byBurner.before.length ? [...budget, byBurner.ix] : null;
    const legacy = instructions => Boolean(compileFitting({ payer: burner.address, blockhash: NOBODY, instructions }));
    const tried = alone && legacy(alone) ? await dryRun(burner.address, alone, [burner.address]) : null;
    if (tried?.ok) {
      // Its last settle gives back all the burner holds after it, in the same transaction, as the dry run says it will
      // hold (its fee and what the settle opened taken); when that doesn't land as one, the burner empties itself after.
      const left = BigInt(tried.accounts[0]?.lamports ?? 0);
      const back = !keepBurner && left > 0n ? [...alone, transferLamports(burner.address, wallet.address, left)] : null;
      if (back && legacy(back) && (await dryRun(burner.address, back)).ok)
        signature = await sendAs(burner, back).catch(() => null);
      emptied = Boolean(signature);
      signature ??= await sendAs(burner, alone).catch(() => null);
    }
    if (!signature) {
      // The wallet's settle: as a v0 transaction with a lookup table when it doesn't fit a legacy one (`send`).
      const { ix, before } = await settleBy(wallet.address);
      signature = await send([...budget, ...before, ix]).catch(async e => {
        throw await cannotReceive(order, e);
      });
    }
    // The burner gives back what it holds after its last settle (a purchase of several orders: after the last order's).
    if (burner && !keepBurner && !emptied) await emptyKey(burner);
    else if (burner && emptied) keys?.forget(burner.name);
    const given = new Set(giveUp.map(Number));
    const assets = wonAssets(order).map((a, k) => (putBack.includes(a) || given.has(k) || lost.has(a) ? null : a));
    return {
      order: orderAddress,
      won: order.won,
      assets,
      settled: signature,
      ...(signatures.length ? { parts: [...signatures, signature] } : {}),
      ...(assets.find(Boolean) ? { asset: assets.find(Boolean) } : {}),
      // What the settle passed over: not given (a stash's NFT won), not sent back (the NFT rolled on).
      ...(lost.size
        ? {
            gone: [...lost],
            says: 'The project no longer holds an NFT of this order (whoever controls its collection took it back or burned it): it was not given or sent back. Everything else settled as rolled.',
          }
        : {}),
    };
  }

  /**
   * A settle of `order` that failed (`e`): when a prize can't reach the player (their token account of its mint frozen by
   * the token's issuer; a collectible whose collection refuses the mint), an error that says so in words and names the
   * places in `won` they may give up (`giveUp`, for `collect`); otherwise `e` itself.
   */
  async function cannotReceive(order, e) {
    const from = Number(order.settled ?? 0);
    const stuck = [];
    for (const [k, won] of order.won.entries()) {
      if (k < from || !won.Tokens) continue;
      const account = await client.account(loot.ata(order.player, won.Tokens.mint, programOf(won.Tokens.mint)));
      // A token account's state is its byte 108: 2 is frozen.
      if (account && account.data?.[108] === 2) stuck.push(k);
    }
    // Core refusing the mint (a collection's plugin): the collectibles of the order are what it would not take.
    const core = (e?.logs ?? []).some(line => line.startsWith(`Program ${MPL_CORE} failed`));
    if (!stuck.length && core)
      for (const [k, won] of order.won.entries()) if (k >= from && won.Item?.serial != null) stuck.push(k);
    if (!stuck.length) return e;
    const err = new Error(
      `This order can't be settled as it is: ${stuck.length === 1 ? 'one prize' : `${stuck.length} prizes`} can't reach your wallet (a token account its issuer froze, or a collection that refuses the mint). Give ${stuck.length === 1 ? 'it' : 'them'} up to take the rest (collect again with giveUp: [${stuck.join(', ')}]): tokens given up stay in the project's vault, and a collectible given up is never made.`,
    );
    Object.assign(err, { giveUp: stuck, cause: e, logs: e?.logs });
    return err;
  }

  /**
   * For each prize an order won, what it is now: the collectible minted (`["asset", item, serial]`), the NFT handed
   * over; null for tokens. A normal item is the project's backend's to deliver.
   */
  function wonAssets(order) {
    return order.won.map(won => {
      if (won.Item) return loot.pda.itemAsset(loot.pda.item(project, won.Item.item), won.Item.serial);
      if (won.Nft) return won.Nft.nft;
      // A compressed NFT's asset id is the tree's count when it was minted: read from its settle's receipt or the
      // player's assets (`claims`), not from the order.
      return null;
    });
  }

  /** A nonce for an order no other order of the player's is at. */
  const freshNonce = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

  /** Each box of `ids`, decoded (null for one never written), by id. */
  async function boxesOf(ids) {
    const out = {};
    for (const id of new Set(ids)) out[id] = await readMaybe('LootBox', loot.pda.box(project, id));
    return out;
  }

  /** Each item a box's prizes name, decoded (null for one never written), by id: a fresh one's tables go with its roll. */
  async function itemsOf(box) {
    const out = {};
    for (const p of box.entries.flatMap(e => e.prizes)) {
      const id = p.Item?.[0] ?? p.Compressed?.item;
      if (id !== undefined && !(id in out)) out[id] = await readMaybe('Item', loot.pda.item(project, id));
    }
    return out;
  }

  /** The mint of each pool a box's tokens come from (null for a pool not opened). */
  async function poolMintsOf(box) {
    const prizePools = [
      ...new Set(
        box.entries
          .flatMap(e => e.prizes)
          .map(p => p.Tokens?.from.Pool?.[0])
          .filter(p => p !== undefined),
      ),
    ];
    const pools = prizePools.length ? await client.accounts(prizePools.map(p => loot.pda.pool(project, p))) : [];
    return Object.fromEntries(
      prizePools.map((p, i) => [p, pools[i] ? encodeBase58(pools[i].data.subarray(0, 32)) : null]),
    );
  }

  /** The instructions that ask the oracle for the roll of `order` (at `orderAddress`), `payer` paying it. Each prize
   * mint's token program is read from the mint when the app wasn't given it (`programs`): the ask opens the project's
   * vault of it. Its first ask fixes its odds (`loot.askReads`): it passes the order's player's profile when the box's
   * odds read one, and for a roll on no NFT, when they read an NFT, `shown` (an NFT the player holds, as `openBox` takes
   * it), or else the player's collectible of this project that raises them the most (`loot.bestShown`). */
  async function asksFor(payer, orderAddress, order, settler, shown = null) {
    const box = await read('LootBox', order.loot_box);
    const player = order.player ?? payer;
    if (!shown && loot.firstAsk(order, box) && loot.askReads(box, order).nft && player === wallet?.address)
      shown = loot.bestShown(box, await owned(player)).best;
    const poolMints = await poolMintsOf(box);
    const mints = [
      ...Object.values(poolMints),
      ...box.entries.flatMap(e => e.prizes.map(p => p.Tokens?.from.Mint?.[0])),
    ].filter(x => x && !programs[x]);
    const owners = mints.length ? await client.accounts(mints) : [];
    const known = { ...programs, ...Object.fromEntries(mints.map((x, i) => [x, owners[i]?.owner ?? TOKEN_PROGRAM])) };
    return loot.askRollIx({
      payer,
      orderAddress,
      order: { ...order, player },
      box,
      settler,
      shown,
      poolMints,
      items: await itemsOf(box),
      programs: known,
    });
  }

  /** Asks the oracle for a roll a mission, a recipe or a prize made (`Waiting`): the player pays the oracle. `shown`: an
   * NFT the player shows for the box's odds at its first ask (by default the one of theirs that raises them most). */
  async function askRoll(orderAddress, { shown = null } = {}) {
    return send([
      computeUnitLimit(400_000),
      ...(await asksFor(wallet.address, orderAddress, await read('Order', orderAddress), undefined, shown)),
    ]);
  }

  /**
   * The most the player agreed to pay for `box`, in base units: `maxPrice` (base units), or the `listing` that
   * `shop()` or `boxes()` showed them (its `priceUnits`). Never the price read now: a price the owner or other buyers
   * moved since the player saw it would be paid without their say. A price above it is refused here, in words, before
   * the wallet is asked.
   */
  function boundOf(box, name, { maxPrice, listing } = {}, key) {
    if (listing && key !== undefined && listing.key !== undefined && listing.key !== key)
      throw new Error(`That listing is “${listing.key}”, not “${key}”.`);
    const given = maxPrice ?? listing?.priceUnits;
    if (given === undefined || given === null)
      throw new Error(
        `Say the most the player agreed to pay for “${name}”: pass the listing shop() or boxes() showed (listing), or maxPrice in base units. The price read now is never the bound.`,
      );
    const bound = BigInt(given);
    if (BigInt(box.price) > bound)
      throw new Error(
        `The price of “${name}” is now ${show(box.price, decimalsOf(box.currencyKey))}, more than the ${show(bound, decimalsOf(box.currencyKey))} the player was shown: show them the new price first.`,
      );
    return bound;
  }

  /**
   * Refuses an option a method doesn't take, so a misspelled or outdated one fails here instead of being ignored (a page
   * passing `{ choice }` for a referrer would send every referral share to the treasury). `options`: what the method
   * was given, or what is left of it once the options it takes are read; `takes`: those it takes, said in the error.
   */
  function only(options, takes, method) {
    const unknown = Object.keys(options ?? {}).filter(k => !takes.includes(k) && options[k] !== undefined);
    if (!unknown.length) return;
    const hint =
      unknown.includes('choice') && takes.includes('chosenRecipient') ? ' (a buyer’s choice is `chosenRecipient`)' : '';
    throw new Error(
      `${method} doesn’t take ${unknown.map(k => `“${k}”`).join(', ')}${hint}. It takes: ${takes.join(', ')}.`,
    );
  }
  /** What `buy` and `openBox` take: a box bought at once (`buyBox`) or opened (`open`). */
  const BOX_OPTIONS = [
    'shown',
    'listProof',
    'maxPrice',
    'listing',
    'chosenRecipient',
    'on',
    'oneSignature',
    'count',
    'acceptLeftover',
  ];

  /**
   * Buys `count` of a box that needs no roll (a shop item, a bundle, a fixed pack: one entry, nothing random, no NFT
   * rolled on) in one transaction: the price is split and every prize given at once, once for each draw of each, with
   * no order to settle. A roll the box gives (`Prize::Roll`) is asked for in the same transaction and settled by a
   * throwaway key after (`sendRolling`: still one prompt). `shown` (an NFT for its gate), `listProof` (for a list gate),
   * `chosenRecipient` (the wallet, or collectible, a share the box lets the buyer name goes to). Returns { signature,
   * assets }: for each prize given, the collectible minted or the NFT given (null for tokens or a normal item), and for
   * a roll the order it is made in; with `rolls`, what each roll gave. `orNull`: a pack (more than one draw in all)
   * whose purchase doesn't fit one legacy transaction, or the instruction trace, returns null, sending nothing.
   */
  async function buyBox(
    boxId,
    part,
    { shown = null, listProof, maxPrice, listing, chosenRecipient = null, count = 1, orNull = false } = {},
  ) {
    const g = await projectNow();
    const box = await read('LootBox', loot.pda.box(project, boxId));
    if (!Number.isInteger(count) || count < 1) throw new Error('Buy a whole number, one at least (count).');
    // One `buy` prices at most so many sales (`PackTooLarge` past it): more is several purchases.
    if (count > loot.MOST_SALES_A_BUY)
      throw new Error(
        `One purchase buys at most ${loot.MOST_SALES_A_BUY.toLocaleString('en-US')} (count): buy the rest in another.`,
      );
    const bound =
      boundOf({ ...box, currencyKey: part?.currency }, part?.name ?? `box ${boxId}`, { maxPrice, listing }, part?.key) *
      BigInt(count);
    shown ??= await passing(box.gate, 'buy this');
    listProof = listProofOf(box.gate, part?.gate?.list, listProof);
    const mint = box.currency;
    const [entry] = box.entries;
    const given = await prizeInputs(entry.prizes);
    const nonce = freshNonce();
    const choosesHolder = box.shares.some(s => s.to.Chosen && s.to.Chosen.item != null);
    const holders = await holdersOf(loot.chosenShares(box.shares, chosenRecipient));
    const ix = loot.buyIx({
      player: wallet.address,
      project,
      box,
      maxPrice: bound,
      count,
      treasury: g.treasury,
      chosenRecipient,
      chosen: choosesHolder ? chosenRecipient : null,
      nonce,
      shown,
      listProof,
      items: given.items,
      poolMints: given.poolMints,
      nfts: given.nfts,
      holders,
      programs,
    });
    const made = {};
    const gives = loot.buyGives(box, count);
    const assets = gives.map(({ prize, k }) => {
      if (prize.Item) {
        const id = prize.Item[0];
        const item = given.items[id];
        made[id] = (made[id] ?? 0) + 1;
        return item?.kind === 'Collectible'
          ? loot.pda.itemAsset(loot.pda.item(project, id), Number(item.issued) + made[id])
          : null;
      }
      if (prize.Nft) return prize.Nft.nft;
      if (prize.Roll) return loot.pda.order(project, wallet.address, loot.prizeRollNonce(nonce + BigInt(k)));
      return null;
    });
    const rollsMade = gives.filter(x => x.prize.Roll).length;
    const instructions = withSolWrap(wallet.address, mint, bound, [
      computeUnitLimit(rollsMade || gives.length > 2 ? 1_400_000 : 600_000),
      ...given.before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ix,
    ]);
    if (orNull && gives.length > 1) {
      const fits =
        compileFitting({ payer: wallet.address, blockhash: NOBODY, instructions }) &&
        transactionLocks(wallet.address, instructions) <= 64;
      if (!fits || !(await dryRun(wallet.address, instructions)).ok) return null;
    }
    const { signature, rolls } = rollsMade
      ? await sendRolling(instructions)
      : { signature: await send(instructions), rolls: [] };
    return {
      signature,
      assets,
      ...(assets.find(Boolean) ? { asset: assets.find(Boolean) } : {}),
      ...(rolls.length ? { rolls } : {}),
    };
  }

  /**
   * Opens a box that rolls. `oneSignature` (the default): the same transaction funds a throwaway key with its settle's
   * fee, and makes the player's account of each mint the box's tokens are in, so the settle needs no second wallet
   * prompt. `chosenRecipient`: the wallet (or collectible) the player names for a share the box lets them choose (a
   * referrer, a plot). `on`: the NFT a box that rolls on one takes (an NFT whose price it is, a sword to enchant).
   * `listProof`: for a list gate.
   */
  async function open(
    boxId,
    part,
    {
      shown = null,
      on = null,
      maxPrice,
      listing,
      oneSignature = !sponsor,
      chosenRecipient = null,
      listProof,
      count = 1,
      acceptLeftover,
    } = {},
  ) {
    const g = await projectNow();
    const box = await read('LootBox', loot.pda.box(project, boxId));
    // `count` packs in one purchase: one wallet prompt, one oracle answer, each at the price the one before it left.
    if (!Number.isInteger(count) || count < 1) throw new Error('Open a whole number of packs, one at least (count).');
    const bound =
      boundOf({ ...box, currencyKey: part?.currency }, part?.name ?? `box ${boxId}`, { maxPrice, listing }, part?.key) *
      BigInt(count);
    // Each item a prize names: a fresh one's tables go with the purchase.
    const items = await itemsOf(box);
    // A box that rolls on an NFT takes the one the player brings (`on`), whatever its kind.
    if (box.subject && !on) throw new Error('This box rolls on an NFT: say which (on).');
    // A box that burns it, gives it away or moves its numbers takes it into the project's hands until the roll settles.
    // What an earlier owner of it left in the project is cleared first (`clearLeftovers`).
    const clears = box.subject && loot.boxHolds(box) ? await clearLeftovers(on, acceptLeftover) : [];
    const brought = box.subject ? await nftOf(on) : { before: [] };
    const { before: proving, hasAuthority, ...kind } = brought;
    const subject = box.subject
      ? { asset: on, hasAuthority, ...kind, collection: kind.collection ?? (await collectionOf(on)) ?? MPL_CORE }
      : undefined;
    if (!box.subject) shown ??= await passing(box.gate, 'buy this');
    listProof = listProofOf(box.gate, part?.gate?.list, listProof);
    const mint = box.currency;
    // A roll that moves the numbers of the NFT it rolls on is at that NFT's nonce: one at a time on it.
    const nonce = box.subject && loot.boxHolds(box) ? loot.nonceOn(on) : freshNonce();
    // Each pool's mint, and each mint tokens are minted from: what is won waits in the project's vault for its mint.
    const poolMints = await poolMintsOf(box);
    const minted = box.entries
      .flatMap(e => e.prizes)
      .map(p => p.Tokens?.from.Mint?.[0])
      .filter(Boolean);
    const prizeMints = [...new Set([...Object.values(poolMints).filter(Boolean), ...minted])];
    const choosesHolder = box.shares.some(s => s.to.Chosen && s.to.Chosen.item != null);
    const chosen = chosenRecipient && choosesHolder ? chosenRecipient : null;
    // A purchase of more opens than one order takes (`loot.opensAnOrder`: what one oracle answer draws, and an order's
    // rent and fee within 0.01 SOL) is several orders, each its own answer, all in this one transaction: one prompt.
    const each = loot.opensAnOrder(box, { items });
    const orders = [];
    for (let left = count, k = 0n; left > 0; left -= each, k++) {
      const n = Math.min(each, left);
      // Its key, named by the order as its settler (made again after a reload: `recover`), when the settle needs no prompt.
      const settlerKey = oneSignature
        ? ((await jobKey(loot.pda.order(project, wallet.address, nonce + k))) ?? (await freshKey()))
        : null;
      orders.push({
        nonce: nonce + k,
        n,
        settlerKey,
        ix: loot.openBoxIx({
          settler: settlerKey?.address,
          player: wallet.address,
          project,
          box,
          nonce: nonce + k,
          maxPrice: (bound / BigInt(count)) * BigInt(n),
          count: n,
          items,
          shown,
          listProof,
          subject,
          chosenRecipient,
          chosen,
          poolMints,
          programs,
        }),
      });
    }
    const before = [
      ...proving,
      createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, mint, programOf(mint)),
    ];
    // (A compressed NFT's proof brings its own compute limit, the transaction's only one.)
    let solPrize = false;
    if (oneSignature) {
      // The player opens here every account the settle will pay into (their prize's, and each wallet a share of the
      // sale pays: a referrer, a plot's holder, the treasury), so the burner's settle opens none of them.
      for (const prizeMint of prizeMints) {
        solPrize ||= prizeMint === NATIVE_MINT;
        before.push(
          createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, prizeMint, programOf(prizeMint)),
        );
      }
      const shares = loot.chosenShares(box.shares, chosenRecipient);
      const holders = await holdersOf(shares);
      const payees = shares.flatMap(s =>
        s.to === 'Treasury'
          ? [g.treasury]
          : s.to.Wallet
            ? [s.to.Wallet[0]]
            : s.to.Holder && holders[s.to.Holder[0]]
              ? [holders[s.to.Holder[0]]]
              : [],
      );
      const paid = new Set([g.treasury, ...payees]);
      for (const payee of paid)
        before.push(createAssociatedTokenAccountIdempotent(wallet.address, payee, mint, programOf(mint)));
      // A sale that pays the player themselves (the owner buying from their own shop) pays into their wrapped-SOL
      // account: it stays open for the settle too.
      solPrize ||= mint === NATIVE_MINT && paid.has(wallet.address);
    }
    // Each order's burner, named by the order (made again after a reload: `recover`), holds the fee of each settle part
    // its order may take (`settleParts`) and of its give-back, and what its settle may mint or open (`settleRent`: the
    // order lends nothing); it gives back what it doesn't use.
    const addresses = orders.map(o => loot.pda.order(project, wallet.address, o.nonce));
    const burners = [];
    const after = [];
    if (oneSignature) {
      for (const o of orders) {
        const { key, fund } = await keyFor(
          SIGNATURE_FEE * BigInt(loot.settleParts(box, o.n) + 1) + loot.settleRent(box, o.n, items),
          o.settlerKey,
        );
        burners.push(key);
        after.push(fund);
      }
    }
    // A SOL prize, or a share of the sale, lands in the player's wrapped-SOL account, which the prompt-less settle
    // can't open: it stays open, and the player's next transaction unwraps it.
    let instructions = withSolWrap(wallet.address, mint, BigInt(box.price) * BigInt(count), [
      ...before,
      ...orders.map(o => o.ix),
      ...after,
    ]);
    if (solPrize)
      instructions = instructions.filter(
        x =>
          !(
            x.programId === TOKEN_PROGRAM &&
            x.data?.[0] === 9 &&
            x.keys[0]?.pubkey === associatedTokenAddress(wallet.address, NATIVE_MINT)
          ),
      );
    const signature = await send(await closesFirst(clears, instructions), [], { keepWrapped: solPrize });
    // The slot it landed in: the order is read from a node that has seen it (a load-balanced RPC's node lagging
    // behind answers nothing for an order just opened).
    const landed = (await client.signatureStatus?.(signature).catch(() => null))?.slot ?? null;
    return {
      signature,
      orderAddress: addresses[0],
      orderAddresses: addresses,
      burner: burners[0] ?? null,
      burners,
      landed,
    };
  }

  /**
   * Holds the listing the player was shown against the one listed now: refused, in words, when none is given, when it
   * is of another NFT or another kind of deal (`Sell`, `Rent`), and when its terms differ from those listed now (the
   * program would refuse them too: TermsChanged).
   */
  async function shownListing(asset, listing, kind) {
    if (!listing)
      throw new Error(
        'Say the terms the player was shown: pass the listing listing() or listings() showed (listing). The listing read now is never signed in its place.',
      );
    if (listing.asset !== asset) throw new Error(`That listing is of ${listing.asset}, not ${asset}.`);
    if (!listing.deal?.[kind])
      throw new Error(
        kind === 'Sell' ? 'That listing is for rent, not for sale.' : 'That listing is for sale, not for rent.',
      );
    const listed = await readMaybe('Listing', loot.pda.listing(project, asset));
    if (!listed) throw new Error(`${asset} is not listed any more.`);
    const [was, is] = [loot.listingTerms(listing), loot.listingTerms(listed)];
    if (was.some((b, i) => b !== is[i]))
      throw new Error(
        'This listing has changed since the player was shown it: show them its terms as they are now first.',
      );
  }

  /**
   * Refuses, in words, to buy or rent the listing of an NFT the project no longer holds (whoever controls its
   * collection took it back or burned it): nothing is there. Sent all the same, the take would only close the listing.
   */
  async function listedStill(asset) {
    if ((await heldNow(asset)).held === false)
      throw new Error(
        `The project no longer holds the NFT ${asset}: whoever controls its collection took it back or burned it while it was listed. There is nothing to buy or rent, and nothing was sent. Anyone can close this listing for nothing (closeGone): its rent goes back to its maker.`,
      );
  }

  /** A box bought at once when it needs no roll (`buyBox`: a shop item, a bundle, a fixed pack of any count), or
   * opened and collected: one that rolls, gives a fresh item (its traits are rolled), or rolls on an NFT. A fixed pack
   * too big for one transaction is opened instead (the oracle answers it like any box). */
  async function buyOrOpen(boxId, part, options) {
    const box = await read('LootBox', loot.pda.box(project, boxId));
    if (!loot.boxRolls(box.entries) && !box.subject && !loot.boxFresh(box.entries, await itemsOf(box))) {
      const { on: _on, oneSignature: _one, ...buying } = options ?? {};
      const bought = await buyBox(boxId, part, { ...buying, orNull: true });
      if (bought) return bought;
    }
    const { orderAddresses, burners, landed } = await open(boxId, part, options);
    if (orderAddresses.length === 1)
      return collect(orderAddresses[0], { burner: burners[0] ?? null, opened: true, landed });
    // Several orders of one purchase: each collected in turn by its own burner.
    const got = [];
    for (const [k, address] of orderAddresses.entries())
      got.push(await collect(address, { burner: burners[k] ?? null, opened: true, landed }));
    return {
      ...got.at(-1),
      orders: got,
      won: got.flatMap(g => g.won ?? []),
      assets: got.flatMap(g => g.assets ?? []),
      parts: got.flatMap(g => g.parts ?? [g.settled]),
    };
  }

  /** The current slot (a later ask or a refund of a failed order needs a later slot; an order's deadlines count in seconds: `chainNow`). */
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

  /** How many ends farm `f` has passed and not walked yet (`loot.endsToWalk`), and its decoded record: 0 for one that keeps none. */
  async function endsOf(f, farm) {
    if (!farm.keeps_ends) return { left: 0, ends: [] };
    const data = (await client.account(loot.pda.ends(loot.pda.farm(project, f.id))))?.data;
    const ends = data ? loot.decodeEnds(data) : [];
    return { left: loot.endsToWalk(farm, ends, await chainNow()), ends };
  }

  /**
   * A move of farm `f` as it can land: every move walks the ends the farm has passed first, each some compute, so one with
   * ends to walk asks for all a transaction has, and one with more than that holds is refused in words, nothing signed.
   */
  async function walking(f, farm, instructions) {
    const { left } = await endsOf(f, farm);
    if (!left) return instructions;
    if (left > loot.MOVE_WALK_ROOM)
      throw Object.assign(
        new Error(
          `“${f.name ?? f.key}” has passed ${left} times seats stop earning since anyone last moved it, more than one transaction can walk: walk it first (app.walkFarm: anyone may, it is free, and nothing is lost by the wait).`,
        ),
        { name: 'FarmNeedsWalk' },
      );
    return [
      computeUnitLimit(loot.WALK_COMPUTE_UNITS),
      ...instructions.filter(x => !(x.programId === COMPUTE_BUDGET_PROGRAM && x.data[0] === 2)),
    ];
  }

  /**
   * Refuses a stake a farm would refuse (`FarmOver`) before anything is signed: a farm with an end takes none at its end
   * or after it, nor one at a tier whose lock would run past it. `f` is the spec's farm, `farm` the decoded one.
   */
  async function openFor(f, farm, tier) {
    const at = await chainNow();
    if (loot.farmOpenFor(farm, tier, at)) return;
    const ends = new Date(Number(farm.ends_at) * 1000).toISOString();
    if (at >= BigInt(farm.ends_at))
      throw new Error(
        `“${f.name ?? f.key}” ended at ${ends}: it takes no stake any more. Stakes in it can still leave and harvest.`,
      );
    throw new Error(
      `“${f.name ?? f.key}” ends at ${ends}, and lock tier ${tier} would run past it: stake at a tier with a shorter lock.`,
    );
  }

  /**
   * An auction's end, as `endAuction` and `callOffSale` send it (`a`: the auction's part of the spec). Each step is
   * checked before the wallet signs: a dry run when it is one legacy transaction, the size otherwise.
   */
  async function endSale(a, { holders, callOff = false } = {}) {
    const at = auctionAt(a);
    let auction = await read('Auction', at);
    const g = await projectNow();
    // What a transfer of the bids' coin carries: the Memo program for Token-2022, and a transfer hook's accounts.
    const memo = await hookTail([auction.mint]);
    const sold = auction.high > 0n;
    const lot = auction.lot.Asset?.[0] ?? null;
    const owner = lot ? auction.seller : g.treasury;
    // The bids' coin's token program, read from the mint when the app wasn't told it.
    const coin = programs[auction.mint] ?? (await client.account(auction.mint))?.owner ?? TOKEN_PROGRAM;
    const base = {
      signer: wallet.address,
      project,
      projectState: g,
      id: a.id,
      programs: { ...programs, [auction.mint]: coin },
      extra: memo,
    };
    if (callOff && (!sold || !lot))
      throw new Error('Only the sale of an NFT lot that has a bid is called off: end this auction with endAuction.');
    // The lot went at an earlier end: this one pays what the bid still owes and closes the auction.
    if (BigInt(auction.proceeds_owed) > 0n) {
      if (callOff)
        throw new Error(
          'The lot went to its winner already: the sale stands (CantCallOff). End it to pay what it owes.',
        );
      return { ...(await payOwed(a, auction, base, holders)), owedPaid: auction.proceeds_owed };
    }
    const item = auction.lot.Item ? await read('Item', loot.pda.item(project, auction.lot.Item[0])) : null;
    const made =
      sold && item?.kind === 'Collectible'
        ? loot.pda.itemAsset(loot.pda.item(project, auction.lot.Item[0]), auction.pin)
        : null;
    // Gone (taken back or burned by whoever controls its collection): the lot, or an NFT of the winning bid.
    const lotNow = lot ? await heldNow(lot) : { held: null };
    const bidNow = [];
    if (sold && auction.nft_bids) for (const nft of auction.held) bidNow.push(await heldNow(nft));
    const lostBids = sold && auction.nft_bids ? auction.held.filter((_, i) => bidNow[i].held === false) : [];
    const gone = lotNow.held === false || lostBids.length > 0;
    const ending = sold && lot && (callOff || gone) ? 'CallOff' : 'Deliver';
    const home = !sold || ending === 'CallOff';
    // The lot to its winner, or home to its seller; a bid's NFTs to whoever owned the lot, or back to their bidder.
    // One that is gone is not sent: its accounts only show the end that the project no longer holds it.
    const before = [];
    const lotKind = lot ? await kindFor(lot, home ? auction.seller : auction.high_bidder, lotNow, before) : {};
    const bidTo = ending === 'CallOff' ? auction.high_bidder : owner;
    const held = [];
    if (sold && auction.nft_bids)
      for (const [i, nft] of auction.held.entries()) held.push(await kindFor(nft, bidTo, bidNow[i], before));
    if (sold && !home) holders ??= await holdersOf(auction.shares);
    const end = (ending, hold = false) =>
      loot.endAuctionIx({ ...base, auction, item, ...lotKind, held, holders, ending, hold });
    const steps = ix => [
      computeUnitLimit(1_000_000),
      ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ix,
    ];
    const fits = ix => Boolean(sendPlan({ payer: wallet.address, instructions: steps(ix), alone: isProveLeaf }));
    const result = {
      ...(sold && ending === 'Deliver' ? { winner: auction.high_bidder } : {}),
      ...(made ? { asset: made } : {}),
    };
    if (ending === 'CallOff') Object.assign(result, { calledOff: true, gone });
    // What the end did about an NFT that is gone, in words: nothing here says it moved.
    if (gone) {
      const which =
        lotNow.held === false
          ? `the lot (${lot})`
          : `${lostBids.length === 1 ? 'an NFT' : 'NFTs'} of the winning bid (${lostBids.join(', ')})`;
      const did = !sold
        ? 'Nothing went home: the auction is closed, and its rent went back to its seller.'
        : ending === 'Deliver'
          ? 'Nothing was paid for it: the lot went to its winner, and the rest of the bid was paid.'
          : lotNow.held === false
            ? `The sale was called off: ${auction.nft_bids ? 'the NFTs of the winning bid the project still held' : 'the winning bid'} went back to its bidder, and nothing went home to the seller.`
            : 'The sale was called off: the lot went home to its seller, and the rest of the bid went back to its bidder.';
      Object.assign(result, {
        gone: true,
        says: `The project no longer holds ${which}: whoever controls its collection took it back or burned it while the auction held it. ${did}`,
      });
    }

    // An end that may make holds: a lot going home, a bid's NFTs going back or to the treasury for the project's lot.
    const outs = [
      ...(lot && home && lotNow.held !== false ? [[lot, auction.seller]] : []),
      ...(sold && auction.nft_bids && (home || !lot)
        ? auction.held.filter((_, i) => bidNow[i].held !== false).map(x => [x, bidTo])
        : []),
    ];
    const holding = async () => ({
      ...(await heldThenReleased(
        at,
        steps(
          end(
            ending,
            outs.map(([x]) => x),
          ),
        ),
        outs,
      )),
      ...result,
    });
    if (fits(end(ending))) {
      if (await stuck(steps(end(ending)))) {
        // What can't move now goes home or back as a hold, sent on once it can; a sold lot waits instead.
        if (outs.length) return holding();
        return {
          waiting: true,
          says: 'The lot can’t move to its winner now (its collection froze it, or refuses the move): the sale waits, the winning bid in the project’s vault. End it again later; the project’s keys can call it off (callOffSale), and if the lot is taken back or burned anyone can.',
        };
      }
      // A roll lot sold: the winner's roll, made at the default nonce, waits for its winner or the project's keys to ask it
      // (`collect`); the winner ending it asks in the same transaction and a key settles it.
      const roll =
        sold && auction.lot.Roll
          ? loot.pda.order(
              project,
              auction.high_bidder,
              loot.prizeRollNonce(loot.prizeNonce(at, BigInt(auction.last_bid_at))),
            )
          : null;
      const { signature, rolls } =
        roll && auction.high_bidder === wallet.address
          ? await sendRolling(steps(end(ending)))
          : { signature: await send(steps(end(ending))), rolls: [] };
      return {
        signature,
        ...result,
        ...(roll ? { order: roll } : {}),
        ...(rolls.length ? { rolled: rolls[0] } : {}),
      };
    }
    // Too wide for one transaction. A sold NFT lot goes first, and a second end pays the bid.
    if (sold && lot && ending === 'Deliver') {
      const first = steps(end('LotFirst'));
      if (await stuck(first))
        return {
          waiting: true,
          says: 'The lot can’t move to its winner now (its collection froze it, or refuses the move): the sale waits, the winning bid in the project’s vault. End it again later; the project’s keys can call it off (callOffSale).',
        };
      const signature = await send(first);
      auction = await read('Auction', at);
      return { signature, ...result, lotFirst: true, ...(await payOwed(a, auction, base, holders)) };
    }
    // Otherwise each NFT that may be a hold becomes one, and is sent on with a release after.
    return holding();
  }

  /** An NFT's kind on an auction's end, going to `to`: what `nftOf` reads, its proof put in `before`. `now`: what
   * `heldNow` read of it; one that is gone carries what shows it instead (a Token Metadata NFT's account that holds it
   * now, or its mint; a compressed NFT's leaf as it is now), and is sent nowhere. */
  async function kindFor(asset, to, now, before) {
    const { before: proof, hasAuthority: _h, gone: _g, ...kind } = await leaving(asset, wallet.address, { to, now });
    before.push(...proof);
    return {
      ...kind,
      collection: kind.compressed || kind.tokenMetadata ? undefined : ((await collectionOf(asset)) ?? MPL_CORE),
    };
  }

  /**
   * Whether an end can't move an NFT now: dry-run as the wallet would send it (one legacy transaction; a bigger one is
   * sent as it is, and counts as one that can). A refusal of loot's is said in words; a failure in the NFT's own program
   * (it is frozen, or its collection refuses the move) is one that is stuck: true, and nothing is sent.
   */
  async function stuck(instructions) {
    const plan = sendPlan({ payer: wallet.address, instructions, alone: isProveLeaf });
    if (!plan?.legacy) return false;
    const tried = await dryRun(wallet.address, instructions);
    if (tried.ok) return false;
    if (tried.error) throw Object.assign(new Error(`${tried.error.msg} (${tried.error.name}).`), tried.error);
    return true;
  }

  /**
   * After an NFT lot went first: the end that pays what the bid still owes and closes the auction. The accounts its
   * money goes into (each share's wallet and the seller's) are opened first, in a transaction of their own when any is
   * missing: the end itself can make up to 64 calls. A bid's NFTs go to the seller, made holds and released after when
   * they don't all fit. Returns { paid } (its signature), and `releases`.
   */
  async function payOwed(a, auction, base, holders) {
    const at = auctionAt(a);
    holders ??= await holdersOf(auction.shares);
    const opens = [];
    if (!auction.nft_bids) {
      const payees = [
        auction.seller,
        ...auction.shares.flatMap(sh =>
          sh.to.Wallet
            ? [sh.to.Wallet[0]]
            : sh.to.Holder
              ? [holders[sh.to.Holder[0]]]
              : sh.to === 'Treasury'
                ? [base.projectState.treasury]
                : [],
        ),
      ].filter(Boolean);
      const program = base.programs[auction.mint];
      const accounts = await client.accounts(payees.map(w => loot.ata(w, auction.mint, program)));
      for (const [i, w] of payees.entries())
        if (!accounts[i]) opens.push(createAssociatedTokenAccountIdempotent(wallet.address, w, auction.mint, program));
    }
    if (opens.length) await send([...new Map(opens.map(x => [x.keys[1].pubkey, x])).values()]);
    const before = [];
    const held = [];
    // An NFT of the bid that is gone (its collection took it back or burned it) is not paid: its accounts show the
    // end that the project no longer holds it, and the end passes it over.
    const lost = [];
    if (auction.nft_bids)
      for (const nft of auction.held) {
        const now = await heldNow(nft);
        if (now.held === false) lost.push(nft);
        held.push(await kindFor(nft, auction.seller, now, before));
      }
    const end = (hold = false) => loot.endAuctionIx({ ...base, auction, held, holders, hold });
    const steps = ix => [
      computeUnitLimit(1_000_000),
      ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ix,
    ];
    const passed = lost.length
      ? {
          gone: true,
          says: `The project no longer holds ${lost.length === 1 ? 'an NFT' : 'NFTs'} of the winning bid (${lost.join(', ')}): whoever controls its collection took it back or burned it while the auction held it. Nothing was paid for it: the rest of the bid was paid to the seller.`,
        }
      : {};
    if (sendPlan({ payer: wallet.address, instructions: steps(end()), alone: isProveLeaf }))
      try {
        return { paid: await send(steps(end())), ...passed };
      } catch (e) {
        // The lot is the winner's already: what is owed waits until the account it goes into can take it.
        return {
          paid: null,
          says: `The lot is the winner’s; the money waits (${e.message}): end the auction again to pay it.`,
        };
      }
    const outs = auction.held.filter(x => !lost.includes(x)).map(x => [x, auction.seller]);
    const { signature, releases } = await heldThenReleased(at, steps(end(outs.map(([x]) => x))), outs);
    return { paid: signature, releases, ...passed };
  }

  /**
   * An end that makes NFTs holds (`outs`: [asset, to]), sent by the wallet with a transfer that funds a throwaway key; the
   * key then sends each on with a release (anyone may), funded for what each may open (a pNFT's token account and record,
   * a compressed NFT's proof record). One the key can't send, the wallet does. Returns { signature, releases }.
   */
  async function heldThenReleased(at, instructions, outs) {
    const { key, fund } = await keyFor(
      BigInt(outs.length) * (2n * SIGNATURE_FEE + loot.SETTLE_RENT_UNIT),
      await jobKey(at),
    );
    const signature = await send([...instructions, fund]);
    const releases = [];
    for (const [asset, to] of outs) {
      // Taken back or burned since the end made it a hold: its release closes the hold on that proof, and sends nothing.
      let lost = false;
      const release = async signer => {
        const hold = await read('Hold', loot.pda.hold(asset, 0));
        const { before: proof, hasAuthority: _h, gone, ...kind } = await leaving(asset, signer, { to });
        lost = gone;
        return [
          ...proof,
          loot.releaseIx({
            signer,
            project,
            asset,
            ...kind,
            collection: kind.compressed || kind.tokenMetadata ? undefined : ((await collectionOf(asset)) ?? MPL_CORE),
            hold,
            to,
          }),
        ];
      };
      const steps = await release(key.address);
      const byKey = (await dryRun(key.address, steps)).ok ? await sendAs(key, steps).catch(() => null) : null;
      // One that still can't move (frozen for now) stays a hold: claims() lists it for whoever it is owed to.
      const sent = byKey ?? (await send(await release(wallet.address)).catch(e => ({ asset, waits: e.message })));
      releases.push(lost && typeof sent === 'string' ? { asset, gone: true, closed: sent } : sent);
    }
    await emptyKey(key);
    return { signature, releases };
  }

  /** What closing a hold whose NFT is gone does, in words, for `claims()`. */
  const goneHoldSays = hold =>
    `The project no longer holds this NFT: whoever controls its collection took it back or burned it while it was held. Its hold can be closed now, by anyone: closing it sends nothing, and the hold's rent goes back to whoever paid it (${hold.payer}).${hold.debt ? ' It was a loan: nothing is repaid, the borrower keeps what they borrowed, and the lender gets neither the NFT nor the repayment.' : ''}`;
  /** The same for a listing. */
  const GONE_LISTING =
    'The project no longer holds this NFT: whoever controls its collection took it back or burned it while it was listed. There is nothing to buy or rent. The listing can be closed for nothing, by its maker (unlist) or by anyone (closeGone), once no rental runs: its rent goes back to its maker.';

  /**
   * What ending an auction does when its lot or an NFT of its winning bid is gone, in words, for `claims()`: `x` the
   * auction, `me` the wallet told (its seller, or its high bidder), `lot` the lot when it is gone, `bids` the NFTs of
   * the winning bid that are gone.
   */
  function goneSaleSays(name, x, me, lot, bids) {
    const [sold, owed] = [BigInt(x.high) > 0n, BigInt(x.proceeds_owed) > 0n];
    const mine = sold && x.high_bidder === me;
    const why = 'whoever controls its collection took it back or burned it while the auction held it';
    const lostBids = `${bids.length === 1 ? 'an NFT' : 'NFTs'} of ${mine ? 'your' : 'the winning'} bid (${bids.join(', ')})`;
    if (lot && !sold)
      return `The project no longer holds its lot (${lot}): ${why}. “${name}” ended with no bid, and nothing comes back to you: ending it closes the auction, and its rent comes back to you.`;
    if (lot) {
      const back = x.nft_bids
        ? `the NFTs of ${mine ? 'your' : 'the winning'} bid that the project still holds go back to ${mine ? 'you' : 'their bidder'}`
        : mine
          ? 'your bid comes back to you'
          : 'the winning bid goes back to its bidder';
      return `The project no longer holds its lot (${lot}): ${why}. The sale of “${name}” is called off by its end, which anyone may send: ${back}, and ${mine ? 'the lot is not yours' : 'you are paid nothing'}.${bids.length ? ` It no longer holds ${lostBids} either: nothing comes back for it.` : ''}`;
    }
    const first = `The project no longer holds ${lostBids}: ${why}.`;
    // A player's lot that has not moved: the two sides move together or not at all, so the sale is called off.
    if (x.lot.Asset && !owed)
      return `${first} The sale of “${name}” is called off by its end, which anyone may send: the lot goes home to ${mine ? 'its seller' : 'you'}, and the rest of the bid back to ${mine ? 'you' : 'its bidder'}. Nothing comes back for the one gone.`;
    // The lot went first, or it is the project's own: the end passes that NFT over and pays the rest.
    return owed
      ? `${first} The winner of “${name}” has the lot: ending it again pays you the rest of the bid, and nothing for the one gone.`
      : `${first} Ending “${name}” gives the lot to ${mine ? 'you' : 'its winner'} and pays the rest of the bid: nothing is paid for the one gone.`;
  }
  /** What claiming does about the NFTs of a round's parts that are gone, in words, for `claims()`: `tickets` the NFTs
   * that paid for the wallet's tickets, `prizes` the NFTs its places won; `back` when its tickets go back to their
   * buyers (a round called off, a lottery that returns its tickets). */
  const goneRoundSays = (tickets, prizes, back) =>
    [
      tickets.length
        ? `The project no longer holds the NFT that paid for your ticket (${tickets.join(', ')}): whoever controls its collection took it back or burned it while the lottery held it. ${back ? 'It can’t come back to you' : 'It goes nowhere'}: claiming settles that part and sends nothing.`
        : '',
      prizes.length
        ? `The project no longer holds an NFT you won (${prizes.join(', ')}): whoever controls its collection took it back or burned it. It can’t be given: claiming closes that prize and sends nothing.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

  /**
   * This project's records of `asset`: its listing at `["listing", project, asset]` (one read) and its holds (one
   * search, by the asset's address). Each is { kind: 'listing' | 'hold', address, record }.
   */
  async function recordsOf(asset) {
    const out = [];
    const listingAt = loot.pda.listing(project, asset);
    const listing = await readMaybe('Listing', listingAt);
    if (listing) out.push({ kind: 'listing', address: listingAt, record: listing });
    const tag = { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Hold)) } };
    const holds = await client.programAccounts(loot.lootProgram(), [
      tag,
      { memcmp: { offset: 1, bytes: project } },
      { memcmp: { offset: 33, bytes: asset } },
    ]);
    for (const { pubkey, account } of holds)
      out.push({ kind: 'hold', address: pubkey, record: loot.decode('Hold', account.data) });
    return out;
  }

  /**
   * The stashes of this project that list `asset`: a project's stash (`kind` 'stash') or a lottery's own
   * ('lottery-stash'), each { kind, address, id } (`id`: the stash's, or the lottery's). A stash keeps its NFTs in
   * rows of no fixed place, so no filter finds one NFT's row: this is one search of the project's stashes
   * (`getProgramAccounts` by tag, project and payload), which returns every stash of the project whole, 36 bytes for
   * each NFT a stash lists, and reads them here.
   */
  async function stashesOf(asset) {
    const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
    const found = await client.programAccounts(loot.lootProgram(), [
      at(0, encodeBase58(Uint8Array.of(loot.TAGS.Table))),
      at(1, project),
      at(37, encodeBase58(Uint8Array.of(loot.PAYLOAD.Nft))),
    ]);
    const out = [];
    for (const { pubkey, account } of found) {
      const stash = loot.decodeStash(account.data);
      if (!stash?.nfts.includes(asset)) continue;
      const own = pubkey === loot.pda.stash(project, stash.id);
      out.push({ kind: own ? 'stash' : 'lottery-stash', address: pubkey, id: stash.id });
    }
    return out;
  }

  /**
   * The records of this project an earlier owner of `asset` left behind (`recordsOf`), each that names a wallet other
   * than the player's: { kind, address, record, says }. Such a record is left when whoever controls the NFT's
   * collection moved it out of the project's hands without the program. Until it is closed, the program hands out
   * whatever the project holds at that address: once this player's deposit puts the NFT back in the project's hands, the
   * record can send it to the wallet it names. `own`: the player's own listing of it counts too (a route that lists:
   * the program takes no second listing of an NFT while one is open). NFTs of the project's own collections are not
   * read: those collections refuse the permanent delegates that take an NFT out.
   */
  async function leftovers(asset, { own = false } = {}) {
    if (ours(await collectionOf(asset))) return [];
    const me = wallet.address;
    const out = [];
    const time = BigInt(await chainNow());
    const iso = at => new Date(Number(at) * 1000).toISOString();
    for (const r of await recordsOf(asset)) {
      if (r.kind === 'listing') {
        const listing = r.record;
        const mine = listing.maker === me;
        if (mine && !own) continue;
        const sale = Boolean(listing.deal.Sell);
        // A running rental is kept: nobody but its maker can even stop the listing until it has run.
        const rented =
          time < BigInt(listing.until)
            ? ` It is rented until ${iso(listing.until)}: the program keeps a running rental, so nobody can close this listing before then (anyone can after, for nothing).`
            : '';
        out.push({
          ...r,
          says: mine
            ? `Your own earlier listing of this NFT (${r.address}) is still open in this project.${rented}`
            : `A listing of this NFT (${r.address}) is still open in this project, left by an earlier owner, ${listing.maker}. Once the project holds the NFT again, ${listing.maker} can take it home by closing that listing${sale ? `, and anyone can buy it at the listing's price, which is paid to ${listing.maker}` : ''}.${rented}`,
        });
        continue;
      }
      const hold = r.record;
      const to = hold.player === project ? 'the project’s treasury' : hold.player;
      const names = [hold.player, hold.debt?.lender].filter(Boolean);
      if (names.every(x => x === me)) continue;
      const due = time >= BigInt(hold.free_at);
      const what = hold.debt
        ? due
          ? `a loan's hold whose loan is overdue: anyone can send the NFT to its lender, ${hold.debt.lender}`
          : `a loan's hold: anyone who repays it (${hold.debt.repay} to ${hold.debt.lender}) sends the NFT to ${to}, and once it is due anyone sends it to the lender`
        : due
          ? `a hold that is over: anyone can send the NFT to ${to} at once`
          : `a hold that runs until ${iso(hold.free_at)}: the project's authority decides where the NFT goes until then, and anyone sends it to ${to} after`;
      out.push({
        ...r,
        says: `This project still has ${what} (${r.address}), left from an earlier owner of this NFT. Once the project holds the NFT again, it can be sent there.`,
      });
    }
    return out;
  }

  /**
   * The instructions that close `records` of `asset` (`recordsOf`) on the proof that the project no longer holds it
   * (`proof`, from `goneProof`), as `signer` sends them: a hold by `release`, a listing by `take_listing`. Anyone may
   * send either, at any time; nothing is sent or paid, and no project fee is taken. A listing whose rental still runs
   * can't be closed (`Rented`): the program keeps a running rental, and the listing closes once it has run.
   * Returns { closes, closed: [{ kind, address }], waits: the records left }.
   */
  async function closesOf(asset, records, proof, signer = wallet.address) {
    const g = await projectNow();
    const time = BigInt(await chainNow());
    const closes = [];
    const closed = [];
    const waits = [];
    for (const r of records) {
      if (r.kind === 'listing') {
        if (time < BigInt(r.record.until)) {
          waits.push(r);
          continue;
        }
        closes.push(
          loot.takeListingIx({
            taker: signer,
            project,
            projectState: g,
            listing: r.record,
            holders: await holdersOf(r.record.shares ?? []),
            programs,
            ...proof.kind,
          }),
        );
      } else {
        const hold = r.record;
        closes.push(
          loot.releaseIx({
            signer,
            project,
            asset,
            ...proof.kind,
            hold,
            address: r.address,
            treasury: g.treasury,
            ...(hold.debt ? { to: hold.debt.lender } : {}),
          }),
        );
      }
      closed.push({ kind: r.kind, address: r.address });
    }
    return { closes: closes.length ? [...proof.before, ...closes] : [], closed, waits };
  }

  /**
   * The deposit guard. Before the player hands `asset` to the project, what an earlier owner left of it there
   * (`leftovers`) is cleared: the player holds the NFT, so it is provably gone from the project, and each leftover hold
   * closes by `release` on that proof and a leftover listing by `take_listing` on it (anyone may, at any time, and
   * nothing is paid). Returns those instructions, tried in a dry run, to go in front of the deposit (`closesFirst`);
   * none when nothing was left. The closes cost the player their transaction fee only: each record's rent goes to
   * whoever that record names (a hold's payer, a listing's maker), never to the player.
   * What can't be closed still refuses the deposit, in words, with nothing sent: a listing whose rental still runs
   * (the program keeps it until the rental has run), or a record of an NFT nothing shows gone. `accept` true goes
   * ahead all the same (the closes that can be made still go first). `listing`: the route is a listing, which the
   * program refuses outright while a listing of the NFT is open (its address is taken), whatever the option says.
   */
  async function clearLeftovers(asset, accept, { listing = false } = {}) {
    const found = await leftovers(asset, { own: listing });
    if (!found.length) return [];
    const proof = await goneProof(asset, wallet.address, { holder: wallet.address });
    let { closes, waits } = proof ? await closesOf(asset, found, proof) : { closes: [], waits: found };
    let why = '';
    if (closes.length) {
      const trial = [computeUnitLimit(1_400_000), ...closes.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)];
      // Tried in a dry run when they are one transaction as they stand; a longer list is made to fit as it is sent.
      const one = compileFitting({
        payer: wallet.address,
        blockhash: NOBODY,
        instructions: trial,
        tables: await standing(),
      });
      const tried = one ? await dryRun(wallet.address, trial) : { ok: true };
      if (!tried.ok) {
        why = tried.error ? ` Closing it was refused in a dry run: ${tried.error.msg} (${tried.error.name}).` : '';
        [closes, waits] = [[], found];
      }
    }
    const open = waits.find(x => x.kind === 'listing');
    if (listing && open)
      throw new Error(
        `${open.says}${why} The program refuses another listing of this NFT while that one is open (its address is taken): nothing was sent.`,
      );
    if (waits.length && accept !== true)
      throw new Error(
        `${waits.map(x => x.says).join(' ')}${why} This deposit would put the NFT where that record can take it: it would be lost to you. Nothing was sent. Go ahead only if the player accepts this: pass acceptLeftover: true.`,
      );
    return closes;
  }

  /**
   * A deposit's `instructions` with `closes` (`clearLeftovers`) in front of them: in the same transaction when both
   * fit one as the wallet sends it (a legacy one, or one with the project's standing tables); when they do not, the
   * closes are sent first in a transaction of their own, and the deposit's instructions come back alone.
   */
  async function closesFirst(closes, instructions) {
    if (!closes.length) return instructions;
    const isLimit = ix => ix.programId === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2;
    // One proof of a compressed NFT serves both: the closes read its record first, then the deposit moves it.
    const proven = new Set(closes.filter(isProveLeaf).map(ix => ix.keys[1].pubkey));
    const together = [
      computeUnitLimit(1_400_000),
      ...closes.filter(ix => !isLimit(ix)),
      ...instructions.filter(ix => !isLimit(ix) && !(isProveLeaf(ix) && proven.has(ix.keys[1].pubkey))),
    ];
    const fits =
      Boolean(
        compileFitting({
          payer: wallet.address,
          blockhash: NOBODY,
          instructions: loot.withLeafCloses(together),
          tables: await standing(),
        }),
      ) && transactionLocks(wallet.address, together) <= 64;
    if (fits) return together;
    await send(closes);
    return instructions;
  }

  /** Who holds each collectible a split's holder shares name now: { asset: holder }. */
  async function holdersOf(shares) {
    const holders = {};
    for (const s of shares) if (s.to.Holder) holders[s.to.Holder[0]] = await ownerOf(s.to.Holder[0]).catch(() => null);
    return holders;
  }

  /**
   * A lottery and its rounds that have a record: the current one (null when nobody bought into it yet), and the two
   * before it while they wait for their draw or still pay out (the ask moves the lottery on, so a round drawing or
   * owing parts is an older one). Each { address, round } (`loot.decodeRound`).
   */
  async function roundOf(l) {
    const address = loot.pda.lottery(project, l.id);
    const lottery = await read('Lottery', address);
    const back = [1, 2]
      .filter(k => lottery.round >= k)
      .map(k => loot.pda.round(address, lottery.incarnation, lottery.round - k));
    const keys = [loot.currentRound(address, lottery), ...back];
    const found = await client.accounts(keys);
    const rounds = keys.map((key, i) => ({
      address: key,
      round: found[i]?.owner === loot.lootProgram() ? loot.decodeRound(found[i].data) : null,
    }));
    return { address, lottery, current: rounds[0].round, rounds: rounds.filter(r => r.round) };
  }

  /**
   * The tail a round's transfers need: each mint's transfer-hook accounts (its extra-account metas, read as every
   * hooked transfer of the client reads them), once each; none for a mint with no hook. A hook whose list names each
   * transfer can't be resolved ahead and is left out (the call then fails on it).
   */
  async function hookTail(mints) {
    const out = new Map();
    for (const mint of new Set(mints.filter(x => x && x !== NOBODY))) {
      const resolved = await resolveTransfers(client, mint).catch(() => null);
      for (const m of resolved?.extraAccounts ?? []) {
        const had = out.get(m.pubkey);
        out.set(m.pubkey, had ? { ...had, isWritable: had.isWritable || m.isWritable } : m);
      }
    }
    return [...out.values()];
  }
  /** The mints a round's ask and pulls move: its pot's, its payment's and each token run's. */
  const roundMints = (r, poolMints = {}) => [
    r.terms.mint,
    loot.paymentMint(r.terms),
    ...r.terms.places
      .map(p => p.prize?.Tokens?.from)
      .filter(Boolean)
      .map(from => (from.Pool ? poolMints[from.Pool[0]] : (from.Mint?.[0] ?? from.Vest?.[0]))),
  ];

  /** Each pool a round's places give tokens from, mapped to its mint (one never opened: the economy's currency). */
  async function roundPoolMints(terms) {
    const out = {};
    for (const p of terms.places) {
      const pool = p.prize?.Tokens?.from.Pool?.[0];
      if (pool === undefined || pool in out) continue;
      const account = await client.account(loot.pda.pool(project, pool));
      out[pool] = account ? encodeBase58(account.data.subarray(0, 32)) : mintOf();
    }
    return out;
  }

  /** The ask for a round's draw (`round` decoded, `key` its address; null for the current round with no record). A
   * round paid from a pot first moves in what the round before left it (`lottery.owing`): that round's record says
   * which pot (gone, any will do). */
  async function drawStep(l, lottery, key, round, signer) {
    const terms = round?.terms ?? lottery.terms;
    const poolMints = await roundPoolMints(terms);
    const extra = await hookTail(roundMints({ terms }, poolMints));
    const first = !round || round.status === 'Open';
    const owingAt =
      first && lottery?.owing && lottery.owing !== NOBODY && loot.potIdOf(terms) != null
        ? await client.account(lottery.owing)
        : null;
    const owing = owingAt?.owner === loot.lootProgram() ? loot.decodeRound(owingAt.data) : null;
    // That round's answer says what it left the pot: until it lands (or the round is cancelled), this draw waits.
    if (owing?.status === 'Drawing')
      throw new Error(
        `The round of “${l.name ?? l.key}” before this one still waits for the oracle’s answer, and this round is paid from the same pot: its draw waits until that answer lands, or that round is cancelled (anyone may ask again after ${loot.STALE_SECONDS} seconds).`,
      );
    return [
      computeUnitLimit(600_000),
      loot.drawLotteryIx({
        payer: signer,
        project,
        id: l.id,
        lottery,
        round,
        roundAddress: key,
        owing,
        poolMints,
        extra,
      }),
    ];
  }

  /** How many of the losers' NFTs left a winner's claim reads to choose its picks among. */
  const PICKS_READ = 8;
  /**
   * The NFTs a claim of entry `i` of a contest of NFTs moves, as `claim` sends it: the entry's own while the contest
   * holds it, and for a winner the losers' NFTs its share still lets it pick, at most 4 a claim. `take` names the
   * picks (one asset, or several). With none named, the first of the losers' NFTs left that the project still holds
   * are picked (the first `PICKS_READ` are read), and one that is gone only when no other is left there: a pick of an
   * NFT gone takes nothing. Each is { j, nft, gone }: its entry's place in the list, and whether the project no longer
   * holds it (its collection took it back or burned it).
   */
  async function contestNfts(contest, entries, i, take) {
    const own = entries[i];
    const won = contest.verdict === 'Won' && Number(contest.winner) === Number(own.side);
    const out = Number(own.amount) === 1 ? [{ j: i, nft: own.nft }] : [];
    const share = won && !(own.bits & loot.ENDED) ? loot.shareOf(contest, own) - Number(own.taken) : 0;
    const left = entries
      .map((e, j) => ({ j, nft: e.nft, e }))
      .filter(({ e }) => Number(e.side) !== Number(contest.winner) && Number(e.amount) === 1);
    const wanted = take ? [take].flat() : [];
    const among =
      share <= 0 ? [] : wanted.length ? left.filter(x => wanted.includes(x.nft)) : left.slice(0, PICKS_READ);
    if (wanted.length && among.length < Math.min(wanted.length, share))
      throw new Error(`${wanted.join(', ')} is not a loser’s NFT left in this contest for you to pick.`);
    const heldOf = await heldEach([...out, ...among].map(x => x.nft));
    const isGone = x => heldOf.get(x.nft)?.held === false;
    const picks = wanted.length ? among : [...among.filter(x => !isGone(x)), ...among.filter(isGone)];
    out.push(...picks.slice(0, Math.min(share, 4)));
    return out.map(x => ({ j: x.j, nft: x.nft, gone: isGone(x) }));
  }
  /** What a contest's claim does about its NFTs that are gone, in words, for `claims()`: `own` the wallet's own NFT
   * when it is gone, `picks` the losers' NFTs gone that its picks land on. */
  const goneContestSays = (own, picks) =>
    [
      own
        ? `The project no longer holds the NFT you entered (${own}): whoever controls its collection took it back or burned it while the contest held it. It can’t come back to you: claiming closes your entry and sends nothing.`
        : '',
      picks.length
        ? `The project no longer holds ${picks.length === 1 ? 'the loser’s NFT' : 'the losers’ NFTs'} left for you to pick (${picks.join(', ')}): whoever controls its collection took it back or burned it. A pick of it takes nothing: claiming closes it and sends nothing.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

  /**
   * The NFTs the pulls of a wallet's parts of round `r` (`mine`: [{ entry, parts }]) are to hand out: each entry's NFT
   * ticket ('Own'), and each NFT its places are still owed (`Prize`: the lottery's own stash's, as the pulls take them
   * out; a project stash's named one). Returns { tickets, prizes }, their addresses.
   */
  async function roundNfts(r, mine) {
    const [tickets, prizes] = [[], []];
    let own;
    for (const { entry, parts } of mine) {
      const e = r.entries[entry];
      for (const part of parts) {
        if (part === 'Own' && e.nft !== NOBODY) tickets.push(e.nft);
        if (!part.Prize || loot.tokenRun(r, Number(part.Prize[0]))) continue;
        const run = Number(part.Prize[0]);
        const place = r.terms.places[run];
        if (place.prize?.Nft) prizes.push(place.prize.Nft.nft);
        if (!loot.ownStash(place)) continue;
        own ??= { stash: loot.decodeStash((await client.account(loot.pda.lotteryStash(r.lottery)))?.data ?? null) };
        const predicted = loot.stashNfts(r, own.stash);
        for (const p of loot.prizePlacesOwed(r, entry, run)) {
          const nft = predicted[loot.nftSlot(r, p)];
          if (nft) prizes.push(nft);
        }
      }
    }
    return { tickets, prizes };
  }

  /**
   * When a draw of round `r` (at `key`) would cancel it (an open round short of its least tickets; a waiting one past
   * the timeout), the pulls of `who`'s own parts as the cancelled round owes them (a few entries' worth), to go right
   * after the draw in its transaction; none otherwise. The round's close rides on them when they are all it owes.
   */
  async function cancelPulls(key, r, who) {
    const short =
      r.status === 'Open' &&
      BigInt(r.sold) < BigInt(r.terms.min_sold ?? 0) &&
      BigInt(now()) >= BigInt(r.terms.draws_at);
    if (!short && !loot.lotteryCancellable(r, await chainNow())) return [];
    // As the program cancels it: every entry's own part owed, and what the ask moved in owed back.
    const potOwed = BigInt(r.pot_arrived) > BigInt(r.to_pot) ? BigInt(r.pot_arrived) - BigInt(r.to_pot) : 0n;
    const pools = r.prizes.filter(p => !p.minted && BigInt(p.arrived) > 0n).length;
    const cancelled = {
      ...r,
      status: 'Cancelled',
      pot_owed: potOwed,
      owed: Number(r.owns) + (potOwed > 0n ? 1 : 0) + pools,
    };
    const mine = r.entries
      .flatMap((e, i) =>
        e.buyer === who && loot.partsOwed(cancelled, i).length
          ? [{ entry: i, parts: loot.partsOwed(cancelled, i) }]
          : [],
      )
      .slice(0, 4);
    const settles = mine.reduce(
      (n, { entry, parts }) => n + parts.reduce((m, p) => m + pullSettles(cancelled, entry, p), 0),
      0,
    );
    const out = [];
    for (const [k, { entry, parts }] of mine.entries())
      out.push(
        ...(
          await pulls(key, cancelled, entry, parts, who, { closes: settles >= cancelled.owed && k === mine.length - 1 })
        ).instructions,
      );
    return out;
  }

  /** The nonce a pull of entry `i` of the round at `key` names: a place's roll is made at `prizeRollNonce(nonce + place)`.
   * The one nonce of that entry: every pull of it (the winner's, a payout's, a cancel's, a run of rolls in parts) names
   * this and no other, so no later pull lands on an order an earlier one made. */
  const pullNonce = (key, i) => loot.prizeNonce(key, BigInt(i));

  /** How many of a round's owed parts a pull of `part` (of entry `i`) settles. */
  const pullSettles = (r, i, part) => {
    if (part === 'Own' || part.Common) return 1;
    const run = Number((part.Pot ?? part.Prize)[0]);
    return part.Pot || loot.tokenRun(r, run)
      ? loot.placesPulled(r, i, run, Boolean(part.Prize))
      : loot.prizePlacesOwed(r, i, run).length;
  };

  /**
   * The pulls of `parts` of entry `i` of a round (`partsOwed`; `i` null for parts owed in common, `commonOwed`), signed by
   * `signer`, and the rolls they make ([{ order, box }], `loot.pullRolls`). With `closes`, the last pull carries the
   * round's close (when the parts it pays are the last owed).
   * An NFT of a part that is proven gone from the project is not sent anywhere. A ticket whose price sends it on
   * passes what proves it gone, and its part settles (`NftGone`, the round its record). A ticket going back to its
   * buyer and a place's NFT are only handed out by the program: the pull passes each as its hold, and a release on
   * the proof follows it here, which closes the hold (`NftGone`, the hold its record). A pull makes holds of all its
   * prize NFTs or of none, so with one of them gone the others are made holds too and released on to their winner.
   */
  async function pulls(key, r, i, parts, signer, { closes = false, lotteryClosed = false } = {}) {
    const e = i == null ? null : r.entries[i];
    const out = [];
    const rolls = [];
    // Whether a pull here wants the largest heap (a run of rolls, or several NFTs out of the round's own stash), and
    // whether one stops short of the part (a raffle's NFTs past what one pull takes out or one transaction carries, a
    // run of rolls past what one transaction carries): a next pull carries on.
    let heap = false;
    let partial = false;
    const g = await projectNow();
    // A run's token prize is in its own mint: the prizes the round recorded name each.
    const extra = await hookTail([...roundMints(r), ...r.prizes.map(p => p.mint)]);
    for (const [k, part] of parts.entries()) {
      const more = {};
      // The NFTs this pull makes holds in place of handing them out (`hold::owe`: for whom, and whose its NFT's
      // account's rent is), each released right after it. The round only hands an NFT out and reads nothing, so one
      // proven gone from the project is made a hold, and that hold closes on the proof.
      const holdsMade = new Map();
      if (part === 'Own' && e.nft !== NOBODY) {
        const then = r.status === 'Cancelled' || r.terms.returns ? null : r.terms.nft_ticket?.then;
        more.handBack = Boolean(then?.Give) && loot.handsBack(await client.account(then.Give[0]));
        const to = !then || more.handBack ? e.buyer : then.Give ? then.Give[0] : undefined;
        const { before = [], hasAuthority: _, gone, ...kind } = await leaving(e.nft, signer, { to });
        out.push(...before);
        // Where its price sends it on (burned, given, stashed) the round reads the ticket itself: proven gone, it goes
        // nowhere and the part settles. Going back to its buyer it is only handed out: made a hold, closed below.
        if (gone && !then) {
          more.hold = true;
          holdsMade.set(e.nft, { kind, player: e.buyer, rentTo: e.buyer });
        } else more.ticket = kind;
      } else if (part.Prize && !loot.tokenRun(r, Number(part.Prize[0]))) {
        // Each of the entry's places in the run: an NFT of the lottery's own stash (which one, as the pull takes them
        // out), a project stash's NFT, an item, or a roll (asked in the same transaction).
        const run = Number(part.Prize[0]);
        const given = r.terms.places[run].prize;
        // An NFT's kind is read below, with whether the project still holds it.
        const inputs = await prizeInputs([given.Nft || given.Held ? null : given], signer, e.buyer);
        out.push(...inputs.before);
        const handed = new Map();
        const hand = async nft => {
          if (inputs.nfts[nft]) return;
          const { before, hasAuthority: _, gone, ...kind } = await leaving(nft, signer, { to: e.buyer });
          inputs.nfts[nft] = kind;
          out.push(...before);
          handed.set(nft, { kind, gone, player: e.buyer, rentTo: signer });
        };
        const stash = loot.ownStash(r.terms.places[run])
          ? loot.decodeStash((await client.account(loot.pda.lotteryStash(r.lottery)))?.data ?? null)
          : null;
        if (stash) {
          // One pull takes out at most so many of the stash's NFTs (`loot.pullAssigns`): the places past them wait.
          const owedPlaces = loot.prizePlacesOwed(r, i, run);
          const last = loot.placesIn(r, run, e.start, e.end).at(-1) ?? 0;
          if (owedPlaces.some(p => loot.nftSlot(r, p) >= loot.pullAssigns(r, stash, last))) partial = true;
          const predicted = loot.stashNfts(r, stash);
          for (const place of loot.prizePlacesOwed(r, i, run)) {
            const nft = predicted[loot.nftSlot(r, place)];
            if (nft) await hand(nft);
          }
        }
        const stashes = given.Nft
          ? {
              [given.Nft.stash]: loot.decodeStash(
                (await client.account(loot.pda.stash(project, given.Nft.stash)))?.data ?? null,
              ) ?? { nfts: [] },
            }
          : {};
        // A project stash's named NFT is handed out only while that stash lists it.
        if (given.Nft && stashes[given.Nft.stash].nfts.includes(given.Nft.nft)) await hand(given.Nft.nft);
        // One of them gone: a pull makes holds of all its NFTs or of none, so each becomes a hold, and its release
        // below closes the one that is gone and sends any other on to its winner.
        const holds = [...handed.values()].some(x => x.gone);
        if (holds) for (const [nft, x] of handed) holdsMade.set(nft, x);
        more.prize = {
          stash,
          stashes,
          nfts: inputs.nfts,
          hold: holds,
          collection: inputs.collection,
          poolMints: inputs.poolMints,
          items: inputs.items,
          projectMint: mintOf(),
        };
        more.nonce = pullNonce(key, i);
        // A run of places that each give a roll (two accounts a place), or several NFTs out of the round's own stash
        // (each NFT's accounts, and heap the program does not give back: 8 Core moves in a round of some 125 places or
        // more run past the default 32 KiB): as many places as one transaction carries, on the largest heap. The pull
        // is sized from a dry run, largest first; the next pull carries on while the round still owes the entry, and
        // only the last carries the close.
        if (given.Roll || (stash && loot.prizePlacesOwed(r, i, run).length > 1)) {
          const owed = loot.prizePlacesOwed(r, i, run).length;
          const sized = async most => {
            const ix = loot.pullIx({
              payer: signer,
              project,
              roundAddress: key,
              round: { ...r, owed: Number.MAX_SAFE_INTEGER },
              entry: i,
              part,
              projectState: g,
              programs,
              extra,
              ...more,
              prize: { ...more.prize, most },
            });
            const tx = [computeUnitLimit(1_400_000), requestHeapFrame(loot.LARGE_SETTLE_HEAP), ix];
            return (
              Boolean(
                compileFitting({ payer: signer, blockhash: NOBODY, instructions: tx, tables: await standing() }),
              ) && (await dryRun(signer, tx)).ok
            );
          };
          // (Made holds, each NFT's release follows the pull in its transaction: a few places a pull then.)
          let most = holds ? Math.min(owed, 4) : owed;
          while (most > 1 && !(await sized(most))) most = Math.max(1, Math.floor(most * 0.75));
          if (most < owed) [more.prize.most, partial] = [most, true];
          heap = true;
        }
        rolls.push(...loot.pullRolls({ project, round: r, entry: i, part, nonce: more.nonce, most: more.prize.most }));
      } else if (part.Common) {
        // Where a part owed in common goes: a share's payee (a collectible's holder now), what the places leave (the
        // pot, or the `rest` a round paid from its own money names), a pool; one that can't take it (a pool never
        // opened, the pot closed since, an account gone) sends it to the treasury.
        const c = Number(part.Common[0]);
        const n = r.terms.shares.length;
        const to =
          c < n
            ? r.terms.shares[c].to
            : c === n
              ? loot.leftoverTo(r.lottery, r.terms)
              : r.terms.places[Number(r.prizes[c - n - 1].run)].prize.Tokens.from;
        if (to.Holder) more.holders = await holdersOf([{ to }]);
        const target = to.Pool ? loot.pda.pool(project, to.Pool[0]) : to.Account?.[0];
        // A pot or pool made again in another mint can't take it either: the program sends it to the treasury.
        const mint = c < n ? loot.paymentMint(r.terms) : c === n ? r.terms.mint : r.prizes[c - n - 1].mint;
        const held = target ? await client.account(target) : null;
        if (target && (!held || encodeBase58(held.data.subarray(0, 32)) !== mint)) more.toTreasury = true;
      }
      const last = k === parts.length - 1;
      const round = closes && last ? { ...r, owed: pullSettles(r, i, part) } : { ...r, owed: Number.MAX_SAFE_INTEGER };
      const pull = loot.pullIx({
        payer: signer,
        project,
        roundAddress: key,
        round,
        entry: i ?? 0,
        part,
        projectState: g,
        lotteryClosed,
        programs,
        extra,
        ...more,
      });
      out.push(pull);
      // Each hold this pull makes (a pull that stops short carries only some) is released at once: one whose NFT is
      // gone closes on the proof and nothing is sent, any other goes on to its winner, and the hold's rent comes back
      // to the signer, who paid it.
      for (const [nft, { kind, player, rentTo }] of holdsMade)
        if (pull.keys.some(x => x.pubkey === loot.pda.hold(nft, 0)))
          out.push(releaseOwed(nft, kind, { player, rentTo }, signer, g));
    }
    return { instructions: out, rolls, heap, partial };
  }

  return {
    project,
    get address() {
      return wallet?.address ?? null;
    },

    /** The shop: every item with a price (or free), its price now and what is left. */
    async shop() {
      const items = (spec.items ?? []).filter(it => Number.isInteger(it.shopBox));
      const accounts = await client.accounts(
        items.flatMap(it => [loot.pda.box(project, it.shopBox), loot.pda.item(project, it.id)]),
      );
      return items.map((it, i) => {
        const box = accounts[2 * i] && loot.decode('LootBox', accounts[2 * i].data);
        const item = accounts[2 * i + 1] && loot.decode('Item', accounts[2 * i + 1].data);
        const dec = decimalsOf(currencyKey);
        return {
          key: it.key,
          name: it.name,
          price: box ? show(box.price, dec) : null,
          priceUnits: box?.price ?? null,
          currency: tokens.get(currencyKey)?.symbol ?? currencyKey,
          active: Boolean(box?.active && item?.active),
          left: item?.max_supply ? item.max_supply - item.issued : null,
        };
      });
    },

    /** The boxes: price now, each outcome's chance as written, and what the box does once an outcome runs out
     * (`whenOut`: 'stopSales', it isn't sold until restocked; 'drawLeft', it draws among what is left). */
    async boxes() {
      const list = spec.boxes ?? [];
      const accounts = await client.accounts(list.map(b => loot.pda.box(project, b.id)));
      return list.map((b, i) => {
        const box = accounts[i] && loot.decode('LootBox', accounts[i].data);
        const total = box ? box.entries.reduce((n, e) => n + e.weight, 0) : 0;
        return {
          key: b.key,
          name: b.name,
          price: box ? show(box.price, decimalsOf(b.currency)) : null,
          priceUnits: box?.price ?? null,
          currency: tokens.get(b.currency ?? currencyKey)?.symbol,
          active: Boolean(box?.active),
          whenOut: box?.when_out === 'DrawLeft' ? 'drawLeft' : 'stopSales',
          outcomes: (b.outcomes ?? []).map((o, j) => ({
            ...o,
            chancePercent: box ? (100 * box.entries[j].weight) / total : o.chance,
          })),
        };
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
     * (`buy`); one that rolls waits for the roll and collects it, settling a pack in as many parts as it needs. `count`
     * opens several packs in one purchase: one wallet prompt and one oracle answer (`maxPrice` is a pack's).
     */
    async openBox(boxKey, options = {}) {
      only(options, BOX_OPTIONS, 'openBox');
      const b = part('boxes', boxKey);
      return buyOrOpen(b.id, b, options);
    },

    /** Collects an order opened earlier (its roll arrived after the app stopped waiting). */
    collect,

    /**
     * Finds the settle keys a page that closed left holding the player's SOL, and finishes their jobs: a key whose order
     * has rolled settles it (no prompt); one whose order is gone, failed or due its refund sends its SOL back; one whose
     * order still waits for its roll keeps it for later. Each key is made again from the wallet's signature (asked once
     * a session, `walletStandardSigner`'s `signMessage`), or read from the page's storage (`keyStore`) when the wallet
     * signs no messages. Returns [{ name, key, settled } | { name, key, swept } | { name, key, waiting }].
     */
    async recover() {
      if (!keys) throw new Error('Connect a wallet first.');
      const me = wallet.address;
      const tag = t => ({ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS[t])) } });
      const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
      const orders = new Map();
      for (const { pubkey, account } of await client.programAccounts(loot.lootProgram(), [
        tag('Order'),
        at(1, project),
        at(33, me),
      ]))
        orders.set(pubkey, loot.decode('Order', account.data));
      const holds = (await client.programAccounts(loot.lootProgram(), [tag('Hold'), at(1, project), at(65, me)])).map(
        h => h.pubkey,
      );
      // Keys are named by an order of the wallet's, a hold (a loan's release), or an auction (the releases after its end).
      const names = [
        ...new Set([...orders.keys(), ...holds, ...(spec.auctions ?? []).map(a => auctionAt(a)), ...keys.stored()]),
      ];
      if (!names.length) return [];
      const made = (await Promise.all(names.map(name => keys.again(name)))).filter(Boolean);
      const held = made.length ? await client.accounts(made.map(k => k.address)) : [];
      const [slot, time] = [await slotNow(), await chainNow()];
      const out = [];
      for (const [i, key] of made.entries()) {
        const lamports = BigInt(held[i]?.lamports ?? 0);
        if (lamports === 0n) {
          keys.forget(key.name);
          continue;
        }
        const order = orders.get(key.name);
        const due = order ? loot.orderRefundable(order, slot, time) : false;
        if (order?.status === 'Rolled' && slot > BigInt(order.requested_slot) && !due) {
          const got = await collect(key.name, { burner: key }).catch(e => ({ error: e.message }));
          out.push({
            name: key.name,
            key: key.address,
            ...(got.error ? { error: got.error } : { settled: got.settled, won: got.won }),
          });
        } else if (order && ['Pending', 'Asked', 'Waiting'].includes(order.status) && !due) {
          out.push({ name: key.name, key: key.address, waiting: order.status });
        } else {
          await emptyKey(key);
          out.push({ name: key.name, key: key.address, swept: lamports });
        }
      }
      return out;
    },

    /** Gives an order's payment back once its time has come (a roll that failed or never came). An NFT the project
     * held for the roll goes back with it; one it no longer holds (its collection took it back or burned it) is not
     * looked for, and the whole payment goes back all the same. */
    async refund(orderAddress) {
      const order = await read('Order', orderAddress);
      // An NFT the project held for the roll goes back.
      const {
        before = [],
        hasAuthority: _,
        gone: _gone,
        ...subject
      } = order.held ? await leaving(order.subject, wallet.address, { to: order.player }) : {};
      return send([...before, loot.refundIx({ signer: wallet.address, orderAddress, order, subject, programs })]);
    },

    /** Asks the oracle for a roll a mission, a recipe or a prize made (its player or the project's keys may; the asker
     * pays the oracle). Its first ask fixes its odds: the player's profile, and an NFT they show (`shown`; by default
     * their collectible that raises the box's odds the most), count then. On a box with nothing in stock only the order's
     * player may ask, a slot after it was made or last asked, and that ends the roll there with nothing, no oracle (a lot
     * its winner paid for fails, for its refund). */
    askRoll: (orderAddress, options = {}) => {
      only(options, ['shown'], 'askRoll');
      return askRoll(orderAddress, options);
    },

    /**
     * Pays a payment of the economy (an entry, an attempt, a tip). `amount`: what the player chose, in whole units, for
     * a payment with `any` (at least its `amount`). `chosenRecipient`: the wallet the player names for a share the
     * payment lets them choose (a referrer; their own wallet too, which then pays them back their share). `holders`: asset → holder, for a holder's share (read
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
      const pools = new Map((spec.pools ?? []).map(x => [x.key, x.index]));
      // `pay` takes its shares from the payer each time: a "chosen" share pays the wallet they name, and with none named
      // it is left out, so what it would pay goes to the treasury with the rest (as a purchase's does).
      const shares = (p.split ?? []).flatMap(s => {
        const [kind, key] = s.to.split(':');
        const bps = Math.round(s.percent * 100);
        if (kind === 'chosen' && key)
          throw new Error(
            `“${p.name}” pays the holder of a “${key}” the payer names: a payment can’t check the collectible, so its split takes a chosen wallet only.`,
          );
        if (kind === 'chosen') return chosenRecipient ? [{ to: { Wallet: [chosenRecipient] }, bps }] : [];
        const pot = lotteryKey => {
          const l = part('lotteries', lotteryKey);
          if (!Number.isInteger(l.pot))
            throw new Error(
              `“${l.name ?? lotteryKey}” pays each round from its own ticket money: it keeps no pot to pay into.`,
            );
          return loot.pda.lotteryPot(loot.pda.lottery(project, l.id), l.pot);
        };
        const to =
          kind === 'burn'
            ? 'Burn'
            : kind === 'pool'
              ? { Pool: [pools.get(key)] }
              : kind === 'account'
                ? { Account: [key] }
                : kind === 'wallet'
                  ? { Wallet: [key] }
                  : kind === 'treasury'
                    ? 'Treasury'
                    : kind === 'lottery'
                      ? { Account: [pot(key)] }
                      : { Holder: [key] };
        return [{ to, bps }];
      });
      holders ??= shares.some(x => x.to.Holder) ? await holdersOf(shares) : undefined;
      const ix = loot.payIx({
        player: wallet.address,
        project,
        mint,
        treasury: g.treasury,
        amount,
        shares,
        holders,
        programs,
      });
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
      if (to && (to === project || (await client.account(to))?.owner === loot.lootProgram()))
        throw new Error('An NFT paid can’t go to the project or an account of the program: name a wallet, or burn it.');
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
      const out = [];
      for (const l of list) {
        const there = await client.account(loot.pda.lottery(project, l.id));
        // The terms on sale are the round's own copy once someone bought into it, the lottery's before.
        const { lottery, current } =
          there?.owner === loot.lootProgram() ? await roundOf(l) : { lottery: null, current: null };
        const copy = current ?? lottery;
        const terms = copy?.terms;
        const currency = lottery ? ticketCurrencyOf(l, lottery) : (l.ticketCurrency ?? currencyKey);
        const ended = lottery && loot.lotteryEnded(lottery);
        // A lottery that weighs tickets by time: what one ticket bought now weighs, and its share of the round's weight
        // (the same ticket bought later weighs less: show it on the buy screen).
        const odds = terms && !ended ? loot.purchaseOdds(current, terms, 1n, await chainNow()) : null;
        out.push({
          key: l.key,
          name: l.name,
          price: terms ? show(terms.price, decimalsOf(currency)) : null,
          priceUnits: terms?.price ?? null,
          currency: tokens.get(currency)?.symbol ?? currency,
          status: !lottery ? null : ended ? 'Ended' : (current?.status ?? 'Open'),
          round: lottery?.round ?? null,
          sold: lottery ? (current?.sold ?? 0n) : null,
          drawsAt: terms ? Number(terms.draws_at) : null,
          salesCloseAt: terms ? Number(loot.salesCloseAt(terms)) : null,
          timeWeighted: Boolean(terms?.time_weighted),
          weight: current ? loot.roundTotal(current) : null,
          ticketWeight: odds?.weight ?? null,
          ticketShare: odds?.share ?? null,
          nftTicket: Boolean(lottery?.terms.nft_ticket),
          incarnation: lottery?.incarnation ?? null,
          revision: copy?.revision ?? null,
        });
      }
      return out;
    },

    /**
     * What `count` tickets of a lottery bought now would weigh in its current round's draw, before they are bought:
     * { tickets, weight, total, share, salesCloseAt, timeWeighted }. In a lottery that weighs tickets by time, each
     * ticket weighs the seconds from its purchase to the close of sales, so the same tickets bought later weigh less;
     * `share` is the purchase's part of the round's weight with it (0 to 1), its chance at each place as things stand.
     */
    async ticketWeight(lotteryKey, count = 1) {
      const l = part('lotteries', lotteryKey);
      const { lottery, current } = await roundOf(l);
      const terms = (current ?? lottery).terms;
      const odds = loot.purchaseOdds(current, terms, BigInt(count), await chainNow());
      return {
        tickets: BigInt(count),
        ...odds,
        salesCloseAt: Number(loot.salesCloseAt(terms)),
        timeWeighted: Boolean(terms.time_weighted),
      };
    },

    /**
     * Buys `count` tickets of a lottery, on the terms the player was shown: `listing`, the lottery as `lotteries()`
     * showed it (a lottery changed since, its price or anything else, is refused rather than paid), or `maxPrice`, the
     * most a ticket may cost, in base units. One of them is required: the price read now is never the bound.
     * `chosenRecipient`: the wallet (or collectible) the player names for a share the lottery lets them choose (a
     * referrer). A lottery whose ticket costs an NFT (`nft_ticket`) sells one ticket for one of the player's NFTs that
     * passes its rule: `nft`, its address (held by the project until the draw, then burned, given on or stashed; back to
     * the player if the round is cancelled). `listProof`: for a list gate. `make`: { recipe, times, listing (or
     * version), assets }, a recipe crafted first in the same transaction, so a player short of what a ticket costs (an
     * entry a recipe makes) approves once for both; a recipe that rolls can't ride along.
     */
    async buyTickets(
      lotteryKey,
      count = 1,
      {
        shown,
        chosenRecipient = null,
        listProof,
        nft: paidWith,
        listing,
        maxPrice,
        acceptLeftover,
        make,
        ...others
      } = NO_OPTIONS,
    ) {
      only(
        others,
        ['shown', 'chosenRecipient', 'listProof', 'nft', 'listing', 'maxPrice', 'acceptLeftover', 'make'],
        'buyTickets',
      );
      const l = part('lotteries', lotteryKey);
      const name = l.name ?? lotteryKey;
      if (listing && listing.key !== undefined && listing.key !== l.key)
        throw new Error(`That listing is “${listing.key}”, not “${l.key}”.`);
      const given = maxPrice ?? listing?.priceUnits;
      if (given === undefined || given === null)
        throw new Error(
          `Say the terms the player was shown for “${name}”: pass the lottery lotteries() showed (listing), or maxPrice (a ticket's most, in base units). The price read now is never the bound.`,
        );
      const { lottery: onChain, current: openRound } = await roundOf(l);
      // A round whose draw is due takes no more tickets: its draw goes first, in this same transaction (the buyer pays
      // the oracle's fee for it), and moves the lottery on, so this purchase is the next round's first. A lottery that
      // draws once has no next round.
      const due = openRound?.status === 'Open' && BigInt(now()) >= BigInt(openRound.terms.draws_at) ? openRound : null;
      if (due && Number(onChain.every) === 0)
        throw new Error(`The one draw of “${l.name}” is due: it takes no more tickets. Reveal it (claims() lists it).`);
      const draw = due
        ? (await drawStep(l, onChain, null, due, wallet.address)).filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)
        : [];
      const current = due ? { ...onChain, round: onChain.round + 1 } : onChain;
      const round = due ? null : openRound;
      // The terms signed are those shown: the round's own copy once someone bought into it, the lottery's before. A
      // lottery written again or changed since is refused here, and by the program (TermsChanged) if it changes after
      // this read.
      const { terms, revision } = round ?? current;
      if (listing && (listing.incarnation == null || listing.revision == null))
        throw new Error(
          `That listing of “${name}” names no terms (incarnation, revision): pass the lottery lotteries() showed.`,
        );
      if (
        listing &&
        (BigInt(listing.incarnation) !== BigInt(current.incarnation) || Number(listing.revision) !== Number(revision))
      )
        throw new Error(
          `“${name}” has changed since the player was shown it: show them the lottery as it is now first.`,
        );
      const lottery = current;
      const currency = ticketCurrencyOf(l, lottery);
      if (BigInt(terms.price) > BigInt(given))
        throw new Error(
          `A ticket of “${name}” now costs ${show(terms.price, decimalsOf(currency))}, more than the ${show(BigInt(given), decimalsOf(currency))} the player was shown: show them the new price first.`,
        );
      if (loot.lotteryEnded(lottery)) throw new Error(`“${l.name}” has drawn and ended.`);
      // Sales close `closes_before` seconds before the draw (SalesClosed after).
      // (A repeating lottery's current round nobody bought into moves to its next date as this purchase opens it.)
      const movesOn = !round && Number(lottery.every) > 0 && BigInt(now()) >= BigInt(terms.draws_at);
      if (!due && !movesOn && BigInt(now()) >= loot.salesCloseAt(terms))
        throw new Error(
          `Sales of “${name}” closed at ${new Date(Number(loot.salesCloseAt(terms)) * 1000).toISOString()}, before its draw: wait for the next round.`,
        );
      shown ??= await passing(lottery.gate, 'buy a ticket');
      listProof = listProofOf(lottery.gate, l.gate?.list, listProof);
      let nft;
      let clears = [];
      const before = [];
      if (terms.nft_ticket) {
        if (!paidWith) throw new Error(`A ticket of “${l.name}” costs an NFT: say which (nft).`);
        if (BigInt(count) !== 1n) throw new Error('An NFT pays for one ticket at a time.');
        // The project holds an NFT ticket until the round is drawn: what an earlier owner left of it goes first.
        clears = await clearLeftovers(paidWith, acceptLeftover);
        const { before: proof, ...kind } = await nftOf(paidWith);
        nft = { asset: paidWith, ...kind };
        before.push(...proof);
      }
      const mint = loot.paymentMint(terms);
      const { shares } = terms;
      const choosesHolder = shares.some(s => s.to.Chosen && s.to.Chosen.item != null);
      // A share the buyer chooses is paid now, from their own account: to the holder of the collectible they chose (read
      // now), the wallet they named, or with no choice the treasury.
      const holders = choosesHolder && chosenRecipient ? await holdersOf([{ to: { Holder: [chosenRecipient] } }]) : {};
      // A payment mint with a transfer hook: its accounts ride along.
      const extra = await hookTail([mint]);
      const ix = loot.buyTicketsIx({
        player: wallet.address,
        project,
        id: l.id,
        lottery,
        round,
        mint,
        count: BigInt(count),
        shown,
        listProof,
        chosenRecipient,
        chosen: choosesHolder ? chosenRecipient : null,
        nft,
        holders,
        treasury: (await projectNow()).treasury,
        programs,
        extra,
      });
      // An overdue round nobody bought into moves to its next date by itself when a ticket is bought.
      // A ticket paid with an NFT: its way out must land too, the NFT handed on once the round is drawn or back to its
      // buyer when it is cancelled, each sized before the NFT goes in.
      if (nft) {
        const g = await projectNow();
        const entry = { buyer: wallet.address, nft: paidWith, start: 0n, end: 1n, amount: 0n, paid: 0n };
        for (const status of ['Drawn', 'Cancelled']) {
          const r = {
            lottery: loot.pda.lottery(project, l.id),
            status,
            terms,
            accounts: [],
            owed: 2,
            opener: wallet.address,
            entries: [entry],
          };
          const exit = [
            computeUnitLimit(1_400_000),
            ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
            loot.pullIx({
              payer: wallet.address,
              project,
              roundAddress: loot.currentRound(r.lottery, lottery),
              round: r,
              entry: 0,
              part: 'Own',
              projectState: g,
              ticket: kindOnly(nft),
              programs,
            }),
          ];
          if (!sendPlan({ payer: wallet.address, instructions: exit, alone: isProveLeaf }))
            throw new Error(
              `Not bought: this NFT couldn't come out of “${l.name}” again (${status === 'Drawn' ? 'handed on once the round is drawn' : 'back to you if the round is cancelled'}): that transaction would lock more accounts than one can (${transactionLocks(wallet.address, exit, { asV0: true })} with its lookup table; at most 64), so it would stay with the lottery.`,
            );
        }
      }
      // `make`: { recipe, times, listing (or version), assets }: a recipe crafted first in the same transaction, so a
      // player short of what a ticket costs (an entry a recipe makes) approves once for both. Its outputs land before
      // the purchase takes them; if either fails, neither happens.
      const made = make
        ? (
            await this.craft(make.recipe, make.assets ?? [], make.times ?? 1, {
              listing: make.listing,
              version: make.version,
              build: true,
            })
          ).instructions.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)
        : [];
      const buy = [
        ...(made.length ? [computeUnitLimit(1_400_000)] : []),
        ...made,
        ...before,
        ...withSolWrap(wallet.address, mint, BigInt(terms.price) * BigInt(count), [ix]),
      ];
      return send(
        await closesFirst(
          clears,
          draw.length
            ? [computeUnitLimit(800_000), ...draw, ...buy.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)]
            : buy,
        ),
      );
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
      // While its lock runs, a seat moves only to a tier with no early exit, or one whose early exit costs at least as
      // much as its own (`ExitWhileLocked`): never to a way out it didn't have, or a cheaper one.
      const mine = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address));
      if (mine && BigInt(mine.amount) > 0n && Number(mine.tier) !== Number(tier)) {
        const [from, to] = [Number(farm.tiers[mine.tier].exit_bps), Number(farm.tiers[tier].exit_bps)];
        const locked = (await chainNow()) < BigInt(mine.since) + BigInt(farm.tiers[mine.tier].lock);
        if (locked && !(to === 0 || (from > 0 && to >= from)))
          throw new Error(
            'While its lock runs, this stake can only move to a tier with no early exit, or one whose early exit costs at least as much as its own.',
          );
      }
      const token = await farmTokens([mint], [], { extra, transfers });
      const ix = loot.stakeTokensIx({
        player: wallet.address,
        project,
        id: f.id,
        farm,
        amount: value,
        tier,
        shown,
        ...token,
      });
      // A seat with a booster on (its boost is read again), or one whose growth the stake changes, is refreshed first, in
      // the same transaction.
      const before = loot.stakeRefreshFirst(farm, mine, { tier, now: await chainNow() })
        ? await refreshOf(f, farm, mine)
        : [];
      return send(await walking(f, farm, [...before, ...withSolWrap(wallet.address, mint, value, [ix])]));
    },

    /**
     * Takes `amount` out once its lock has run (0: only rewards); `forfeit` gives up rewards that cannot move. Before the
     * lock, a tier with an early exit lets it leave for its fee, keeping what the seat was credited.
     */
    async unstake(farmKey, amount = 0, { forfeit = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['forfeit', 'extra', 'transfers'], 'unstake');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const value = units(amount, decimalsOf(f.stakes));
      const mints = [...(value > 0n ? [farm.farmed.Tokens.mint] : []), ...(!forfeit ? [farm.rewards_mint] : [])];
      const token = await farmTokens(mints, mints, { extra, transfers });
      // An exit that would lose what the seat grew since its last refresh writes it first, in the same transaction.
      const by = wallet.address;
      const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
      const first = [];
      if (seat && loot.refreshFirst(farm, seat, value, forfeit)) {
        const { before, ...nft } = seat.asset !== NOBODY ? await nftOf(seat.asset) : { before: [] };
        first.push(
          ...before,
          loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by, seat, ...nft, extra: token.extra }),
        );
      }
      return send(
        await walking(f, farm, [
          ...token.before,
          ...first,
          loot.unstakeTokensIx({ player: wallet.address, project, id: f.id, farm, amount: value, forfeit, ...token }),
        ]),
      );
    },

    /**
     * Stakes one of the player's NFTs in a farm (its own seat, or as the booster of their token seat), of any kind: a
     * Core asset, a Token Metadata NFT's mint (legacy or pNFT), or a compressed NFT's asset id. In a farm that watches,
     * an NFT whose last staker sold it takes their seat over. A farm with an end takes none at its end or after it.
     */
    async stakeNft(farmKey, asset, tier = 0, { extra, transfers, acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['extra', 'transfers', 'acceptLeftover'], 'stakeNft');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      // A farm that keeps its NFTs in escrow hands this one to the project (what an earlier owner left of it there is
      // cleared first); one that freezes or watches leaves it in the wallet, where no record of the project's can move it.
      const clears = farm.custody === 'Escrow' ? await clearLeftovers(asset, acceptLeftover) : [];
      await openFor(f, farm, tier);
      const token = await farmTokens([farm.rewards_mint], [], { extra, transfers });
      const { before, ...nft } = await nftOf(asset);
      const seat =
        farm.custody === 'Watch' && farm.farmed === 'Collectibles'
          ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset))
          : null;
      const previous = seat && seat.player !== wallet.address ? seat.player : null;
      // A booster boosts a stake: a farm of tokens takes one only on a seat with tokens staked (NotFarmed). In a farm
      // whose growth writes the profile, the seat is refreshed first, in the same transaction (`boosterRefreshFirst`).
      const refresh = [];
      if (farm.farmed.Tokens) {
        const mine = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address));
        if (!mine || BigInt(mine.amount) === 0n)
          throw new Error(`Stake some ${f.stakes} in “${f.name ?? f.key}” first: a booster boosts a stake.`);
        if (loot.boosterRefreshFirst(farm)) refresh.push(...(await refreshOf(f, farm, mine)));
      }
      // Its way out must land too: its unstake from this tier, with the tier's
      // prize and as a forfeit, is sized before it goes in, and an NFT that could never come back out isn't staked.
      if (!farm.farmed.Tokens) await exitFits(f, farm, asset, nft, before, tier, token);
      return send(
        await closesFirst(
          clears,
          await walking(f, farm, [
            ...refresh,
            ...before,
            loot.stakeNftIx({
              player: wallet.address,
              project,
              id: f.id,
              farm,
              asset,
              ...nft,
              previous,
              tier,
              ...token,
            }),
          ]),
        ),
      );
    },

    /**
     * Releases the collectible after its lock: it grows on its way out (a farm with `growth`), and from its own seat
     * takes its tier's prize (a mission: `prize.rs`). `forfeit` gives up rewards, and the prize, that cannot move. A
     * prize that can't be given now refuses the leave and the NFT stays (`needPrize`, true by default); `needPrize: false`
     * leaves without it (the receipt says `prize_missed`). Returns the signature, or { signature, roll } when it makes a roll (a mission's result on the NFT, or a chest),
     * which `collect` then finishes.
     */
    async unstakeNft(
      farmKey,
      asset,
      { forfeit = false, needPrize = true, extra, transfers, acceptLeftover, ...others } = NO_OPTIONS,
    ) {
      only(others, ['forfeit', 'needPrize', 'extra', 'transfers', 'acceptLeftover'], 'unstakeNft');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const token = await farmTokens(
        forfeit ? [] : [farm.rewards_mint],
        forfeit || farm.farmed.Tokens ? [] : [farm.rewards_mint],
        { extra, transfers },
      );
      // Held in escrow, it comes back into the player's account (frozen in place, it never left it).
      const { before, ...nft } = await nftOf(asset, wallet.address, {
        to: farm.custody === 'Escrow' ? wallet.address : undefined,
      });
      // Leaving a mission that rolls: its roll is made in an order of the player's, which `collect` then finishes; its
      // prize's roll (a chest) at the next nonce.
      const seat = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset));
      const roll = farm.tiers[seat.tier]?.roll ?? null;
      const prize = farm.tiers[seat.tier]?.prize ?? null;
      // A forfeit takes no prize: none of its accounts (`unstakeNftIx`).
      const given = await prizeInputs([forfeit ? null : prize]);
      // A mission's roll on the NFT: on a box that holds it, at the NFT's own nonce (one at a time on it), else at
      // `prizeRollNonce` of the one named (`namedRollNonce`).
      const nonce = roll != null ? loot.nonceOn(asset) : freshNonce();
      const boxes = roll != null ? { [roll]: await read('LootBox', loot.pda.box(project, roll)) } : {};
      // A mission whose box holds the NFT it rolls on takes it into the project's hands on the way out, from a farm that
      // left it in the wallet.
      const clears =
        roll != null && farm.custody !== 'Escrow' && loot.boxHolds(boxes[roll])
          ? await clearLeftovers(asset, acceptLeftover)
          : [];
      // A roll still at the NFT's order address blocks the leave, unless it was asked and came back with nothing to give
      // (Waiting, asked once): that one stands in for this. Any other is asked (its player or the project's keys), answered and settled first.
      if (roll != null) {
        const at = loot.pda.order(project, wallet.address, loot.namedRollNonce(boxes[roll], asset, nonce));
        const there = await readMaybe('Order', at);
        if (there && !(there.status === 'Waiting' && BigInt(there.asked_first) !== 0n))
          throw new Error(
            `This NFT's last mission roll (${at}) hasn't finished: it must be asked, answered and settled before the NFT can leave. claims() lists the step; collect it (app.collect), then leave.`,
          );
      }
      const ix = loot.unstakeNftIx({
        player: wallet.address,
        project,
        id: f.id,
        farm,
        asset,
        ...nft,
        forfeit,
        needPrize,
        roll,
        nonce,
        tier: seat.tier,
        projectCollection: given.collection,
        poolMints: given.poolMints,
        items: given.items,
        nft: given.nft,
        boxes,
        ...token,
      });
      const steps = await walking(f, farm, [...before, ...given.before, ...token.before, ix]);
      // A mission prize that can't be given now (its pool short, an item sold out) refuses the leave and the NFT stays
      // (PrizeNotCovered): say so, and offer to leave without it (`needPrize: false`).
      if (prize != null && !forfeit && needPrize) {
        const tried = await dryRun(wallet.address, steps);
        if (!tried.ok && tried.error?.name === 'PrizeNotCovered')
          throw Object.assign(
            new Error(
              `This NFT's mission prize can't be given now, so it stays staked. Leave without the prize (needPrize: false) to take the NFT home now; the prize is then not given.`,
            ),
            { code: tried.error.code, name: 'PrizeNotCovered' },
          );
      }
      const { signature, rolls } = await sendRolling(await closesFirst(clears, steps));
      const rolled = rolls.length ? { rolled: rolls[0] } : {};
      if (roll != null)
        return {
          signature,
          roll: loot.pda.order(project, wallet.address, loot.namedRollNonce(boxes[roll], asset, nonce)),
          ...rolled,
        };
      return prize?.Roll && !forfeit
        ? { signature, roll: loot.pda.order(project, wallet.address, loot.prizeRollNonce(nonce + 1n)), ...rolled }
        : signature;
    },

    /**
     * What farm `farmKey` has to walk: `{ ends, needsWalk, parts }`, the times its seats stop earning it has passed and not
     * yet credited up to, whether a move can no longer do them in its own transaction, and how many transactions
     * `walkFarm` would take. Every move walks them first; nothing is lost however long they wait.
     */
    async farmWalk(farmKey) {
      const f = part('farms', farmKey);
      const { left } = await endsOf(f, await read('Farm', loot.pda.farm(project, f.id)));
      return { ends: left, needsWalk: left > loot.MOVE_WALK_ROOM, parts: Math.ceil(left / loot.WALK_PER_TX) };
    },

    /**
     * Walks a farm up to now in parts (`walk_farm`), for one that has passed more ends than a move can walk: one transaction
     * for every `loot.WALK_PER_TX` ends, oldest first. Anyone may send it, and it costs only the network fee. Returns their
     * signatures, none when there is nothing to walk.
     */
    async walkFarm(farmKey, { perTx = loot.WALK_PER_TX, ...others } = NO_OPTIONS) {
      only(others, ['perTx'], 'walkFarm');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const { ends } = await endsOf(f, farm);
      const out = [];
      for (const ix of loot.walkFarmParts({ project, id: f.id, farm, ends, now: await chainNow(), perTx }))
        out.push(await send([computeUnitLimit(loot.WALK_COMPUTE_UNITS), ix]));
      return out;
    },

    /**
     * Writes what a staked collectible has grown (a farm with `growth`: its points and level, on it or in its Sheet)
     * and reads its boosts again. Anyone may send it; the player pays for what the write adds. `by`: the collectible,
     * or the player for their token seat's booster.
     */
    async refresh(farmKey, by, { extra, ...others } = NO_OPTIONS) {
      // `transfers` (a token's transfer plan) is taken and needs nothing: a refresh moves no tokens.
      only(others, ['extra', 'transfers'], 'refresh');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const seat = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
      const held = seat.asset !== NOBODY;
      const { before, ...nft } = held ? await nftOf(seat.asset) : { before: [], hasAuthority: true };
      // A refresh moves no tokens (a farm's rewards are numbers until a seat is paid): only a collectible's own tail.
      return send(
        await walking(f, farm, [
          ...before,
          loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by, seat, ...nft, extra: extra ?? [] }),
        ]),
      );
    },

    /**
     * Collects what a seat owes (the player's own, or one of their collectibles' seats). In a farm that watches, it
     * shows the seat's NFT is still theirs: the Core asset, or their token account of a Token Metadata NFT.
     */
    async harvest(farmKey, by = wallet.address, { compound = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['compound', 'extra', 'transfers'], 'harvest');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
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
      // A compound stakes more: a seat with a booster on, or whose growth reads the amount, is refreshed first.
      const seat = compound ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by)) : null;
      const first = loot.stakeRefreshFirst(farm, seat, { compound: true }) ? await refreshOf(f, farm, seat) : [];
      return send(
        await walking(f, farm, [
          ...before,
          ...token.before,
          ...first,
          loot.harvestIx({ player: wallet.address, project, id: f.id, farm, by, held, tree, compound, ...token }),
        ]),
      );
    },

    /**
     * Adds what a token seat is owed to its stake, without restarting its lock (a farm of tokens whose rewards are the
     * staked token).
     */
    async compound(farmKey, opts = {}) {
      only(opts, ['extra', 'transfers'], 'compound');
      return this.harvest(farmKey, wallet.address, { ...opts, compound: true });
    },

    /**
     * The player's seats in a farm (the wallet's, or `player`'s): each one's NFT (`asset`, null for a token seat with
     * no booster), what it holds staked (`amount`, in whole units of the staked token, a number for display that can
     * round past 2^53 base units; `amountUnits`, in base units exactly, a bigint; 1 for an NFT), its tier, when it
     * came in (`since`) and when its lock is over (`freeAt`, unix seconds; null when the NFT says it, `lockKey`), its
     * boost in percent, until when it earns (`earnsUntil`, unix seconds, null for no end: a tier's term, an upkeep), and
     * what it is owed now: `waiting` (whole units of the rewards, `rewards` their token) and `owedUnits` (base units). What it is owed is the program's own sum, from a refresh of the seat dry-run on the
     * network (nothing is signed or sent): what the farm released or its rate paid since its last move is in it, by the
     * farm's rounding. When the dry run fails, it is what the seat was last credited, and `counted` is false.
     * One search of the chain, and one dry run per seat: read it when the page opens and after a stake or a harvest.
     */
    async staked(farmKey, player = wallet?.address) {
      if (!player) throw new Error('Connect a wallet first.');
      const f = part('farms', farmKey);
      const farmAddress = loot.pda.farm(project, f.id);
      const farm = await read('Farm', farmAddress);
      const rewards = [...tokens.values()].find(t => mintOf(t.key) === farm.rewards_mint);
      const nfts = f.stakes === 'collectibles';
      // A seat names its player (offset 1), not its farm: a seat of this farm is the one at its own address here.
      const found = (
        await client.programAccounts(loot.lootProgram(), [
          { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Seat)) } },
          { memcmp: { offset: 1, bytes: player } },
        ])
      ).filter(({ pubkey, account }) => {
        const seat = loot.decode('Seat', account.data);
        return pubkey === loot.pda.seat(farmAddress, nfts ? seat.asset : player);
      });
      const { blockhash } = await client.latestBlockhash();
      // Who the dry run names as the refresh's signer and fee payer: the network wants one that holds SOL, whoever it is
      // (nothing is signed): the player, else the wallet looking, else the project's authority.
      let payer;
      const funded = async () => {
        for (const a of [player, wallet?.address, live.authority].filter(Boolean))
          if ((await client.balance(a).catch(() => 0n)) > 0n) return a;
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
          const ix = loot.refreshSeatIx({ signer: payer, project, id: f.id, farm, by, seat, ...nft });
          const message = compileMessage({ payer, blockhash, instructions: [...before, ix] });
          const after = (
            await client.simulate(wireTransaction(message), { accounts: [pubkey], replaceBlockhash: true })
          ).accounts[0];
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
          // Its weight in the farm, as the seat holds it: near the farm's total cap a seat weighs only what is left, so
          // it is read, never worked out from the tier and the boost.
          weight: BigInt(seat.weight),
          rewards: rewards?.key ?? null,
          waiting: show(seat.owed, rewards ? decimalsOf(rewards.key) : 0),
          owedUnits: BigInt(seat.owed),
          // Until when it earns and grows (unix seconds): its tier's term or its fuel, the sooner; null for no end.
          earnsUntil: BigInt(seat.earns_until) >= loot.NO_END ? null : Number(seat.earns_until),
          counted,
        });
      }
      return out;
    },

    /** The recipes: whether each is on, and its version now (what `craft` takes as the terms the player was shown). */
    async recipes() {
      const list = spec.recipes ?? [];
      const accounts = await client.accounts(list.map(r => loot.pda.recipe(project, r.id)));
      return list.map((r, i) => {
        const recipe = accounts[i] && loot.decode('Recipe', accounts[i].data);
        return { key: r.key, name: r.name, active: Boolean(recipe?.active), version: recipe ? recipe.version : null };
      });
    },

    /**
     * Crafts a recipe, handing in `assets` (the collectibles it burns or uses, in the recipe's order). `version`: the
     * recipe's version the page showed the player (`recipes()`, or the listing itself as `listing`), so a recipe the
     * owner changed since is refused rather than crafted on terms the player never saw. It is required: the version
     * read now is never signed in its place. `extra`: the tail a Core collection's plugins need when the craft moves or
     * rolls on a Core NFT (sent after the Memo program's account, as on every other Core move).
     */
    async craft(
      recipeKey,
      assets = [],
      times = 1,
      { version, listing, extra = [], build = false, ...others } = NO_OPTIONS,
    ) {
      only(others, ['version', 'listing', 'extra', 'build'], 'craft');
      const r = part('recipes', recipeKey);
      version ??= listing?.version ?? undefined;
      if (version === undefined || version === null)
        throw new Error(
          `Say which version of “${r.name ?? recipeKey}” the player was shown: pass the listing recipes() showed (listing), or its version. The version read now is never signed in its place.`,
        );
      const current = await read('Recipe', loot.pda.recipe(project, r.id));
      const recipe = { ...current, version };
      const pays = recipe.inputs.filter(i => i.Pay).map(i => i.Pay);
      const holders = await holdersOf(pays.map(p => ({ to: p.to })));
      const treasury = (await projectNow()).treasury;
      // An NFT a `show` line takes, by its address: as the project's, a Core asset of another collection, or a Token
      // Metadata mint, which the craft reads differently.
      // Where the collectibles of input `i` start among those handed in.
      const at = i =>
        recipe.inputs
          .slice(0, i)
          .reduce((n, x) => n + (x.Burn?.count ?? (x.Use || x.Show || x.Staked || x.Trade ? 1 : 0)), 0);
      const shownAt = new Set(recipe.inputs.flatMap((input, i) => (input.Show ? [at(i)] : [])));
      // An NFT a `trade` line takes in, any kind: read for its kind (a compressed one proven first).
      const tradedAt = new Set(recipe.inputs.flatMap((input, i) => (input.Trade ? [at(i)] : [])));
      const proving = [];
      // A collectible used or renewed that is staked in escrow, in the project's hands: its farm, found by its seat.
      const keptAt = new Set(recipe.inputs.flatMap((input, i) => (input.Use ? [at(i)] : [])));
      // One a `staked` line takes: on its seat in the farm the line names, escrowed or frozen there.
      const stakedAt = new Map(recipe.inputs.flatMap((input, i) => (input.Staked ? [[at(i), input.Staked.farm]] : [])));
      // The places a raise lowers a number on.
      const lowered = new Set(
        (recipe.raises ?? []).filter(raise => BigInt(raise.shift.by) < 0n).map(raise => Number(raise.place)),
      );
      const handed = await Promise.all(
        assets.map(async (nft, i) => {
          if (stakedAt.has(i) && typeof nft === 'string') {
            const farm = stakedAt.get(i);
            if (!(await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, farm), nft)))) {
              const name = (spec.farms ?? []).find(f => f.id === farm)?.name ?? `farm ${farm}`;
              throw new Error(`${nft} is not staked in “${name}”, where this recipe takes it.`);
            }
            return { asset: nft, farm };
          }
          if (keptAt.has(i) && typeof nft === 'string') return (await escrowedIn(nft)) ?? (await lockedIn(nft)) ?? nft;
          if (tradedAt.has(i) && typeof nft === 'string') {
            const { before, ...kind } = await nftOf(nft);
            proving.push(...before);
            return { asset: nft, ...kind };
          }
          if (!shownAt.has(i) || typeof nft !== 'string') return nft;
          // Shown on a seat of a farm that freezes, with a raise lowering a number on it: its seat and farm go with it.
          const seated = lowered.has(i) ? await lockedIn(nft) : null;
          const on = seated ? { farm: seated.farm } : {};
          const account = await client.account(nft);
          if (account?.owner !== MPL_CORE) return { mint: nft, owner: wallet.address, ...on };
          const theirs = await collectionOf(nft);
          return ours(theirs) ? (seated ? { asset: nft, ...on } : nft) : { asset: nft, collection: theirs, ...on };
        }),
      );
      // A recipe that rolls makes its roll in an order of the player's, which `collect` then finishes.
      const rolls = recipe.outputs.some(o => o.RollOn || o.Prize?.[0]?.Roll);
      // A roll on a collectible kept is named by that collectible's nonce (`nonceOn`): on a box that holds it, its
      // order is there, one at a time on it (`namedRollNonce`).
      const rollOn = recipe.outputs.find(o => o.RollOn)?.RollOn;
      const nonce = rollOn
        ? loot.nonceOn(typeof assets[rollOn.place] === 'string' ? assets[rollOn.place] : assets[rollOn.place].asset)
        : freshNonce();
      // A roll on a kept collectible (`RollOn`) passes its box's prize mints as a roll given does.
      const given = await prizeInputs(
        recipe.outputs.map(o => o.Prize?.[0] ?? (o.RollOn ? { Roll: [o.RollOn.box_id] } : null)),
      );
      // Each item a line takes passes its collection.
      const items = { ...given.items };
      for (const input of recipe.inputs) {
        const id = (input.Burn ?? input.Use ?? input.Renew ?? input.Staked)?.item;
        if (id !== undefined && !(id in items)) items[id] = await read('Item', loot.pda.item(project, id));
      }
      // The collectibles it makes, each at its item's next serial.
      const counts = {};
      const made = recipe.outputs.flatMap(o => {
        const id = o.Prize?.[0]?.Item?.[0];
        if (id === undefined || items[id]?.kind !== 'Collectible') return [];
        counts[id] = (counts[id] ?? 0) + 1;
        return [loot.pda.itemAsset(loot.pda.item(project, id), Number(items[id].issued) + counts[id])];
      });
      const before = [...proving, ...given.before].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      let instructions = [
        computeUnitLimit(rolls ? 1_400_000 : 1_000_000),
        ...before,
        loot.craftIx({
          player: wallet.address,
          project,
          collection: collections[0],
          id: r.id,
          recipe,
          assets: handed,
          times,
          nonce,
          holders,
          programs,
          treasury,
          poolMints: given.poolMints,
          items,
          nfts: given.nfts,
          boxes: given.boxes,
          extra,
        }),
      ];
      // Fuel bought for a staked collectible counts once its seat is refreshed: in the same transaction.
      for (const raise of recipe.raises ?? []) {
        const asset = assets[raise.place];
        if (typeof asset !== 'string') continue;
        for (const f of (spec.farms ?? []).filter(x => x.upkeepAttribute === raise.shift.key)) {
          const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset));
          if (!seat) continue;
          const farm = await read('Farm', loot.pda.farm(project, f.id));
          const { before, ...nft } = await nftOf(asset);
          instructions.push(
            ...before,
            loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by: asset, seat, ...nft }),
          );
        }
      }
      for (const p of pays) instructions = withSolWrap(wallet.address, p.mint, p.amount * BigInt(times), instructions);
      // A roll on a collectible kept is at its nonce; a prize's roll at `prizeRollNonce` of the craft's. Asked for in the
      // craft's own transaction and settled by a key after: one prompt.
      const on =
        rollOn && (typeof assets[rollOn.place] === 'string' ? assets[rollOn.place] : assets[rollOn.place].asset);
      const roll = rolls
        ? loot.pda.order(
            project,
            wallet.address,
            rollOn ? loot.namedRollNonce(given.boxes[rollOn.box_id], on, nonce) : loot.prizeRollNonce(nonce),
          )
        : null;
      // `build`: its instructions, unsent, for a step that rides in another's transaction (buyTickets' `make`). A recipe
      // that rolls is settled after its transaction, so it can't ride along.
      if (build) {
        if (rolls)
          throw new Error(`“${r.name ?? recipeKey}” rolls: it is crafted on its own (craft), not with another step.`);
        return { instructions, made };
      }
      const { signature, rolls: rolled } = await sendRolling(instructions);
      return { signature, made, ...(roll ? { roll } : {}), ...(rolled.length ? { rolled: rolled[0] } : {}) };
    },

    /**
     * Hands an NFT of any kind to the project until a time (a hold): `seconds` from now, or `{ until }` (Unix seconds).
     * The hold's address names its end. Returns { signature, freeAt }.
     *
     * Like every route that hands an NFT in (`stakeNft` in escrow, `borrow`, `enter`, `bid`, `listForSale`,
     * `listForRent`, a ticket paid with an NFT, a box that rolls on one), it first clears what an earlier owner of the
     * NFT left in this project: a hold or a listing that stayed open when whoever controls the NFT's collection took it
     * out of the project's hands. Left open, such a record could take the NFT once the project holds it again. The
     * player holds the NFT now, so the program closes each on that proof (a hold by `release`, a listing by
     * `take_listing`, nothing sent or paid), in front of the deposit in the same transaction, or in a transaction of
     * their own before it when the two do not fit one. The closes cost the player their transaction fee only: each
     * record's rent goes to whoever that record names (a hold's payer, a listing's maker), never to the player. Only
     * what can't be closed still refuses the deposit, in words (a listing whose rental still runs: the program keeps
     * it until the rental has run); `acceptLeftover: true` goes ahead all the same. NFTs of the project's own
     * collections are not read.
     */
    async hold(asset, seconds, { acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['acceptLeftover'], 'hold');
      const clears = await clearLeftovers(asset, acceptLeftover);
      const freeAt = BigInt(typeof seconds === 'object' ? seconds.until : now() + Number(seconds));
      const { before, hasAuthority: _, ...nft } = await nftOf(asset);
      const signature = await send(
        await closesFirst(clears, [
          ...before,
          loot.holdIx({
            player: wallet.address,
            project,
            asset,
            ...nft,
            collection: nft.collection ?? (await collectionOf(asset)) ?? MPL_CORE,
            freeAt,
          }),
        ]),
      );
      return { signature, freeAt };
    },

    /**
     * A lender's offer to borrow against: `maker`'s offer number `id` in this project. Returns { address, offer, mint,
     * amount, repay, lasts, risks }: `risks`, in words, each power over the loan's token that could make repaying fail
     * (its freeze authority, a Token-2022 pause, a transfer hook, a permanent delegate) and who holds it, and each setting
     * of the token that lets the lender turn the repayment away (accounts that start frozen or can be made to,
     * confidential transfers) or blocks it (a token that can't be transferred). The program takes such tokens, and a
     * lender who can stop every repayment takes the NFT once it is due: show the risks before the player borrows.
     */
    async loanOffer(maker, id) {
      const address = loot.pda.offer(project, maker, id);
      const offer = await read('Offer', address);
      if (!offer.deal.Lend) throw new Error(`The offer ${address} buys NFTs; it lends nothing.`);
      const account = await client.account(offer.mint);
      if (!account) throw new Error(`The loan's token ${offer.mint} is not on this cluster.`);
      const lender = who =>
        who === maker
          ? ' That is the lender: they could keep you from repaying and take your NFT when the loan is due.'
          : '';
      const risks = mintPowers(account).map(p => {
        if (p.power === 'freeze')
          return {
            ...p,
            says: `${p.holder} can freeze accounts of the loan's token, which makes repaying fail.${lender(p.holder)}`,
          };
        if (p.power === 'pause')
          return {
            ...p,
            says: `${p.holder ?? 'Its pause authority'} can pause every transfer of the loan's token, which makes repaying fail${p.paused ? ' (it is paused now)' : ''}.${lender(p.holder)}`,
          };
        if (p.power === 'hook')
          return {
            ...p,
            says: `Every transfer of the loan's token runs the program ${p.holder}${p.authority ? `, which ${p.authority} can change` : ''}; it can refuse a repayment.${lender(p.authority)}`,
          };
        return {
          ...p,
          says: `${p.holder} can move anyone's tokens of the loan's token, the ones you would repay with too.${lender(p.holder)}`,
        };
      });
      // What the token's own settings let a lender do: the program no longer refuses these, so the kit says them.
      risks.push(...tokenSettings(account, 'repaying', 'the lender', 'and take your NFT when the loan is due'));
      const { amount, repay, lasts } = offer.deal.Lend;
      return { address, offer, mint: offer.mint, program: account.owner, amount, repay, lasts, risks };
    },

    /**
     * Borrows against the player's NFT `asset` from `maker`'s offer `id`: the NFT is held until the loan is repaid, or
     * goes to the lender once it is due (`due`, Unix seconds; by default the longest the offer allows, less a minute).
     * A loan whose token someone could freeze, pause, hook or move, or whose own settings let the lender turn the
     * repayment away (`loanOffer`'s `risks`), is refused unless `acceptRisks` is true: the page shows the player each
     * risk first. `extra`: a transfer hook's accounts.
     */
    async borrow(maker, id, asset, { due, acceptRisks = false, acceptLeftover, extra, ...others } = NO_OPTIONS) {
      only(others, ['due', 'acceptRisks', 'acceptLeftover', 'extra'], 'borrow');
      const clears = await clearLeftovers(asset, acceptLeftover);
      const loan = await this.loanOffer(maker, id);
      extra ??= await hookTail([loan.mint]);
      if (loan.risks.length && acceptRisks !== true)
        throw new Error(
          `Repaying this loan can be blocked. ${loan.risks.map(r => r.says).join(' ')} Borrow only if the player accepts this: pass acceptRisks: true.`,
        );
      const lasts = BigInt(loan.lasts);
      due = BigInt(due ?? BigInt(now()) + lasts - (lasts > 120n ? 60n : 0n));
      const { before, ...nft } = await nftOf(asset);
      const collection = nft.collection ?? (await collectionOf(asset)) ?? MPL_CORE;
      const loanPrograms = { ...programs, [loan.mint]: loan.program };
      const ix = loot.borrowIx({
        borrower: wallet.address,
        project,
        id,
        offer: loan.offer,
        due,
        asset,
        ...nft,
        collection,
        programs: loanPrograms,
        extra,
      });
      const signature = await send(
        await closesFirst(clears, [
          ...before,
          createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, loan.mint, loan.program),
          ix,
        ]),
      );
      return { signature, due, hold: loot.pda.hold(asset, due) };
    },

    /**
     * The loan on `asset` (held until `due`), as a page shows it before anyone repays: { lender, mint, repay (base units),
     * due, paid }. `repay` is what `repay` then takes as the amount shown. Null when it holds no loan.
     */
    async loan(asset, due) {
      const hold = await readMaybe('Hold', loot.pda.hold(asset, due));
      if (!hold?.debt) return null;
      return {
        lender: hold.debt.lender,
        mint: hold.debt.mint,
        repay: BigInt(hold.debt.repay),
        due: Number(hold.free_at),
        borrower: hold.player,
      };
    },

    /**
     * Repays the loan on `asset` (held until `due`), the player's own or a friend's, and brings the NFT home to its
     * borrower in the same instruction: one prompt. `repay`: the debt the payer was shown (`loan()`'s, in base units);
     * the program refuses any other (`TermsChanged`). An NFT its collection took back or burned while the project held
     * it is refused here, before anything is signed: the program takes no repayment for it, and the borrower keeps what
     * they borrowed. Such a loan is closed for nothing instead: `claims()` lists it for its borrower and its lender, and
     * `claim` of it closes the hold (nothing is repaid, and the hold's rent goes back to whoever paid it). When the NFT
     * can't move now (frozen for now, or its collection refuses the move), or `home` is
     * false, the money goes alone, so the loan does not fall due: the hold is then over, and anyone sends the NFT home
     * once it can move (`claims()` lists it). A compressed NFT is proven in the same transaction; the money alone for one
     * whose proof keeps going out of date goes without it. Returns { signature, home }, and `says` when the NFT waits.
     */
    async repay(asset, due, { repay, home = true, extra, ...others } = NO_OPTIONS) {
      only(others, ['repay', 'home', 'extra'], 'repay');
      const at = loot.pda.hold(asset, due);
      const hold = await read('Hold', at);
      if (!hold.debt) throw new Error('This NFT is held for no loan left to repay.');
      extra ??= await hookTail([hold.debt.mint]);
      if (repay === undefined || repay === null)
        throw new Error(
          'Say the debt the payer was shown (repay, from loan()): the amount read now is never paid in its place.',
        );
      if (BigInt(repay) !== BigInt(hold.debt.repay))
        throw new Error(
          `This loan now asks ${hold.debt.repay}, not the ${repay} shown: show the payer the loan as it is now first.`,
        );
      if ((await heldNow(asset)).held === false)
        throw new Error(
          `The project no longer holds the NFT ${asset}: whoever controls its collection took it back or burned it while it was held. The program takes no repayment for it (NotTheNft), so nothing was sent: the borrower keeps what they borrowed. This loan can be closed for nothing: claims() lists it for its borrower and for its lender, and claim() of it closes the hold (nothing is repaid, and the hold's rent goes back to whoever paid it).`,
        );
      const { before, hasAuthority: _, ...nft } = await nftOf(asset, wallet.address, { to: hold.player });
      const kind = nft.compressed || nft.tokenMetadata ? nft : { collection: (await collectionOf(asset)) ?? MPL_CORE };
      // A Token Metadata NFT's move and a compressed NFT's proof take more than the default compute.
      const budget = nft.compressed || nft.tokenMetadata ? [computeUnitLimit(1_000_000)] : [];
      const opens = before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      const repaying = (goesHome, first = []) =>
        withSolWrap(wallet.address, hold.debt.mint, BigInt(hold.debt.repay), [
          ...budget,
          ...first,
          loot.repayIx({
            payer: wallet.address,
            project,
            hold,
            repay,
            home: goesHome,
            address: at,
            ...kind,
            programs,
            extra,
          }),
        ]);
      if (home) {
        const all = repaying(true, opens);
        // Too big for a dry run as one legacy transaction (a compressed NFT's long proof): sent as it is, the wallet's
        // one transaction made to fit.
        const plan = sendPlan({ payer: wallet.address, instructions: all, alone: isProveLeaf });
        if (plan && !plan.legacy) return { signature: await send(all), home: true };
        const tried = await dryRun(wallet.address, all);
        if (tried.ok) return { signature: await send(all), home: true };
        // What would refuse the money alone too is said now.
        if (['TermsChanged', 'LoanDue', 'NotALoan', 'NotTheNft'].includes(tried.error?.name))
          throw Object.assign(new Error(`${tried.error.msg} (${tried.error.name}).`), tried.error);
      }
      // The money alone: a compressed NFT proven in the same transaction when that lands, so one that is gone is refused.
      const proven = nft.compressed ? repaying(false, opens.filter(isProveLeaf)) : null;
      const money = proven && (await dryRun(wallet.address, proven)).ok ? proven : repaying(false);
      const signature = await send(money);
      return {
        signature,
        home: false,
        says: 'The loan is repaid. The NFT stays with the project until it can move (frozen for now, or its collection refuses the move): anyone sends it home to its borrower then, and claims() lists it.',
      };
    },

    /**
     * Backs `side` of contest number `id` (the authority opens contests while the project runs) with `amount`; a contest
     * of NFTs takes one of the player's NFTs that passes its rule instead (`nft`, its address), held until it is
     * claimed. `listProof`: for a list gate.
     */
    async enter(id, side, amount, { shown, listProof, nft: staked, acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'listProof', 'nft', 'acceptLeftover'], 'enter');
      const contest = await read('Contest', loot.pda.contest(project, id));
      shown ??= await passing(contest.gate, 'enter');
      listProof = listProofOf(contest.gate, null, listProof);
      if (contest.nft) {
        if (!staked) throw new Error('This contest takes an NFT: say which (nft).');
        const clears = await clearLeftovers(staked, acceptLeftover);
        const { before, ...kind } = await nftOf(staked);
        return send(
          await closesFirst(clears, [
            ...before,
            loot.enterIx({
              player: wallet.address,
              project,
              id,
              contest,
              side,
              amount: 1n,
              shown,
              listProof,
              nft: { asset: staked, ...kind },
              programs,
            }),
          ]),
        );
      }
      const t = [...tokens.values()].find(x => mintOf(x.key) === contest.mint);
      const value = units(amount, t?.source === 'sol' ? 9 : (t?.decimals ?? 0));
      return send(
        withSolWrap(wallet.address, contest.mint, value, [
          loot.enterIx({
            player: wallet.address,
            project,
            id,
            contest,
            side,
            amount: value,
            shown,
            listProof,
            programs,
          }),
        ]),
      );
    },

    /**
     * The auctions: each one's lot, high bid, the least the next bid must be, when it ends and how long is left, and
     * whether the player leads. One no longer on chain has ended. `waiting`: SOL that came back to the player's
     * wrapped-SOL account from a bid that was topped (`unwrap` turns it into plain SOL). `warnings`: what to show every
     * bidder before a bid (a token whose accounts can be frozen, a lot of another collection).
     */
    async auctions() {
      const list = spec.auctions ?? [];
      const accounts = await client.accounts(list.map(a => auctionAt(a)));
      const at = BigInt(now());
      const wrapped = wallet?.address
        ? await client.account(associatedTokenAddress(wallet.address, NATIVE_MINT))
        : null;
      const waiting = wrapped
        ? show(new DataView(wrapped.data.buffer, wrapped.data.byteOffset).getBigUint64(64, true), 9)
        : '0';
      const auctions = accounts.map(x => x && loot.decode('Auction', x.data));
      // What every bidder is told before a bid: what the bids' token lets the high bidder do, and what whoever
      // controls an NFT lot of another collection can do to it.
      const mints = [...new Set(auctions.filter(Boolean).map(x => x.mint))];
      const mintAccounts = Object.fromEntries((await client.accounts(mints)).map((m, k) => [mints[k], m]));
      const warningsOf = async x => {
        const out = tokenSettings(
          mintAccounts[x.mint],
          'the refund of the bid a higher one tops',
          'the high bidder',
          'so every higher bid fails and they win at their price',
        ).map(r => r.says);
        const lot = x.lot.Asset?.[0];
        if (lot && !ours(await collectionOf(lot)))
          out.push(
            'This lot is an NFT outside the project’s collections: whoever controls its collection can stop it moving or take it back while the project holds it. The seller is paid only when the lot reaches the winner; while it can’t move, the winning bid waits in the project’s vault, until it can or the project calls the sale off, and a lot taken back or burned sends the bid back. A bid can be tied up, not lost.',
          );
        return out;
      };
      const warned = await Promise.all(auctions.map(x => (x ? warningsOf(x) : [])));
      return list.map((a, i) => {
        const x = auctions[i];
        const base = {
          key: a.key,
          name: a.name,
          lot: a.lot,
          currency: tokens.get(a.currency ?? currencyKey)?.symbol ?? a.currency ?? currencyKey,
        };
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
          // The lot went at its end, and its seller's account couldn't take the money then: the next end pays it and closes it.
          ...(BigInt(x.proceeds_owed) > 0n ? { delivered: true, proceedsOwed: show(x.proceeds_owed, dec) } : {}),
          // A bid of NFTs: a picker of 1 to `maxNfts` (and at least `nextBid`) of the player's NFTs.
          ...(x.nft_bids ? { nftBids: true, held: x.held, maxNfts: loot.MAX_BID_NFTS } : {}),
          ...(tokens.get(a.currency ?? currencyKey)?.source === 'sol' ? { waiting } : {}),
          ...(warned[i].length ? { warnings: warned[i] } : {}),
        };
      });
    },

    /**
     * Bids `amount` (whole units) on an auction. The bid it tops goes back to its bidder in the same transaction
     * (the program opens their account again if they closed it, paid by this bidder). In SOL, only what the player's
     * wrapped-SOL account does not hold already is wrapped, and the account stays open: if this bid is topped, it comes
     * back there. In an auction of NFT bids, an NFT of the topped bid that the project no longer holds (its collection
     * took it back or burned it) can't go back: the bid makes it a hold for its bidder and closes that hold on the
     * proof in the same transaction, so a high bid with an NFT gone can still be topped.
     */
    async bid(auctionKey, amount, { shown, listProof, nfts, acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'listProof', 'nfts', 'acceptLeftover'], 'bid');
      const a = part('auctions', auctionKey);
      const auction = await read('Auction', auctionAt(a));
      shown ??= await passing(auction.gate, 'bid');
      listProof = listProofOf(auction.gate, a.gate?.list, listProof);
      // An auction of NFT bids: a bid is a bundle of the player's NFTs (`nfts`, their addresses, or `amount` read as
      // them), and the bid it tops goes back to its bidder in the same transaction.
      if (auction.nft_bids) {
        const bundle = nfts ?? (Array.isArray(amount) ? amount : null);
        if (!bundle?.length) throw new Error('This auction takes NFTs as bids: say which (nfts).');
        if (bundle.length > loot.MAX_BID_NFTS) throw new Error(`A bid holds at most ${loot.MAX_BID_NFTS} NFTs.`);
        if (auction.held.length >= loot.MAX_BID_NFTS)
          throw new Error(`The high bid holds ${loot.MAX_BID_NFTS} NFTs, the most a bid holds: it can't be topped.`);
        const clears = [];
        for (const asset of bundle) clears.push(...(await clearLeftovers(asset, acceptLeftover)));
        const before = [];
        const kindOf = async (asset, to) => {
          const { before: proof, ...kind } = await nftOf(asset, wallet.address, { to });
          before.push(...proof);
          return { asset, ...kind };
        };
        const bid = [];
        for (const asset of bundle) bid.push(await kindOf(asset));
        // The bid it tops goes back to its bidder: into a fresh account of theirs when their own can't take it. An
        // NFT of it that is gone (its collection took it back or burned it) can't go back: the auction only hands it
        // out, so it is made a hold for its bidder, and that hold closes on the proof right after the bid.
        const held = [];
        const lost = new Map();
        for (const asset of auction.held) {
          const { before: proof, gone, ...kind } = await leaving(asset, wallet.address, { to: auction.high_bidder });
          before.push(...proof);
          held.push({ asset, ...kind });
          if (gone) lost.set(asset, kind);
        }
        const ix = loot.bidIx({
          bidder: wallet.address,
          project,
          id: a.id,
          auction,
          shown,
          listProof,
          nfts: bid,
          held,
          hold: [...lost.keys()],
          programs,
        });
        const g = await projectNow();
        const closes = [...lost].map(([asset, { hasAuthority: _, ...kind }]) =>
          releaseOwed(asset, kind, { player: auction.high_bidder, rentTo: auction.high_bidder }, wallet.address, g),
        );
        return send(
          await closesFirst(clears, [
            computeUnitLimit(800_000),
            ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
            ix,
            ...closes,
          ]),
        );
      }
      const mint = auction.mint;
      const value = units(amount, decimalsOf(a.currency));
      const instructions = [];
      if (mint === NATIVE_MINT) {
        const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
        const have = await client.account(wrapped);
        const held = have ? new DataView(have.data.buffer, have.data.byteOffset).getBigUint64(64, true) : 0n;
        instructions.push(createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, NATIVE_MINT));
        if (value > held)
          instructions.push(transferLamports(wallet.address, wrapped, value - held), syncNative(wrapped));
      }
      // A Token-2022 account can ask for a memo on every transfer into it: the Memo program rides along, and a transfer
      // hook's accounts.
      const memo = await hookTail([mint]);
      // The coin's token program, read from the mint when the app wasn't told it.
      const coin = programs[mint] ?? (await client.account(mint))?.owner ?? TOKEN_PROGRAM;
      instructions.push(
        loot.bidIx({
          bidder: wallet.address,
          project,
          id: a.id,
          auction,
          amount: value,
          shown,
          listProof,
          programs: { ...programs, [mint]: coin },
          extra: memo,
        }),
      );
      return send(instructions, [], { keepWrapped: true });
    },

    /**
     * Ends an auction that is over (anyone can; the winner usually does): the lot to the highest bidder and the winning
     * bid to whoever owned it, in one transaction (a new collectible minted for the winner at the address its item and
     * serial name), however long after the end it is sent. A roll lot makes the winner's roll of its box (`order`), which
     * `collect` asks for and settles. An NFT lot whose end can't fit one transaction (a compressed lot's long proof, many
     * shares, a hooked coin) goes first, and the bid is paid by a second end, the accounts it pays into opened before it.
     * When the lot can't move now (its collection froze it or refuses the move), nothing is sent: the sale waits, the
     * winning bid in the project's vault (`{ waiting: true, says }`); end it again later, or the project's keys call it
     * off (`callOffSale`). When the lot or an NFT of the winning bid is gone (its collection took it back or burned it),
     * the sale is called off on that evidence, which anyone may: the bid goes back to its bidder (`{ calledOff: true }`).
     * With no bid, the lot goes home to its seller. An end too big for one transaction otherwise makes each NFT that may
     * be a hold one, and sends each on with a release after it (`releases`).
     * An NFT that is gone is never sent, whatever its kind, and the result says so (`gone: true`, and `says`, what the
     * end did in words): a lot gone with no bid stays where it is and the auction closes, its rent to its seller; a
     * sale with the lot or an NFT of the bid gone is called off, and what the project still holds goes back; for the
     * project's own lot, or a lot that went first, the end passes the bid's NFT that is gone over and pays the rest.
     * A hold made at the end whose NFT goes before its release is closed on the proof: its entry in `releases` is
     * then `{ asset, gone: true, closed }`, `closed` the signature.
     */
    async endAuction(auctionKey, { holders, ...others } = NO_OPTIONS) {
      only(others, ['holders'], 'endAuction');
      return endSale(part('auctions', auctionKey), { holders });
    },

    /**
     * The project's owner or authority calls off the sale of an NFT lot whose auction is over and whose lot has not moved
     * (one that never thaws, say), for the project fee: the winning bid goes back to its bidder and the lot home to its
     * seller, each moved, or made a hold that anyone sends on once it can move (`releases`). Anyone may when the lot or
     * an NFT of the winning bid is gone (`endAuction` does it then). Refused once the lot went to its winner (`CantCallOff`).
     */
    async callOffSale(auctionKey, { ...others } = NO_OPTIONS) {
      only(others, [], 'callOffSale');
      return endSale(part('auctions', auctionKey), { callOff: true });
    },

    /**
     * Runs a schedule that is due (an emission into a pool, a rent or a drip): the project's owner or authority, or who it
     * pays, may (a sealed burn: anyone), and nothing is paid to whoever sends it but the network fee. A run missed is missed:
     * this pays once, for the latest run due, and the runs before it lapse; only a sealed fixed amount pays every run due. `holders`: asset → holder, for a schedule that pays a collectible's holder.
     * Returns null when it isn't due yet.
     */
    async runSchedule(scheduleKey, { holders, most, ...others } = NO_OPTIONS) {
      only(others, ['holders', 'most'], 'runSchedule');
      const sc = part('schedules', scheduleKey);
      const address = loot.pda.schedule(project, sc.id);
      const schedule = await read('Schedule', address);
      const from = schedule.action.from;
      // A sealed schedule's vault: past its last run, whatever arrived since is due once more.
      const vault = from.Vest ? await client.account(loot.pda.vest(address)) : null;
      const held = vault ? vault.data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
      // Every run due by the chain's clock (`most`: at most that many of a sealed fixed amount's, the only one paid run by
      // run; a long backlog of those takes a few calls).
      const due = Math.min(loot.runsDue(schedule, await chainNow(), held), most ?? Infinity);
      if (!due) return null;
      const poolMint = from.Pool
        ? encodeBase58((await client.account(loot.pda.pool(project, from.Pool[0]))).data.subarray(0, 32))
        : null;
      holders ??= await holdersOf([{ to: schedule.action.to }]);
      const treasury = (await projectNow()).treasury;
      // A sealed fixed amount's backlog is a step for each halving: room for the longest the program takes a call.
      return send([
        computeUnitLimit(1_400_000),
        loot.runScheduleIx({
          payer: wallet.address,
          project,
          id: sc.id,
          schedule,
          poolMint,
          holders,
          programs,
          treasury,
          upto: Number(schedule.runs) + due,
        }),
      ]);
    },

    // ---------------------------------------------------------------- listings

    /**
     * Lists one of the player's NFTs (any kind) for sale at `price` (whole units of `currency`, the economy's by
     * default), `shares` taken first (a royalty, a platform's cut). The project holds it until it sells or is unlisted.
     */
    async listForSale(asset, { price, currency, shares = [], acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['price', 'currency', 'shares', 'acceptLeftover'], 'listForSale');
      const clears = await clearLeftovers(asset, acceptLeftover, { listing: true });
      const mint = mintOf(currency);
      const { before, ...nft } = await nftOf(asset);
      return send(
        await closesFirst(clears, [
          ...before,
          loot.openListingIx({
            maker: wallet.address,
            project,
            asset,
            mint,
            deal: { Sell: { price: units(price, decimalsOf(currency)) } },
            shares,
            ...nft,
          }),
        ]),
      );
    },

    /**
     * Lists one of the player's NFTs for rent: `price` (whole units) a period of `lasts` seconds, a renter taking 1 to
     * `maxPeriods` at once. Nobody can end a rental early; the next renter takes it once one is over, until it is unlisted.
     */
    async listForRent(
      asset,
      { price, lasts, maxPeriods = 1, currency, shares = [], acceptLeftover, ...others } = NO_OPTIONS,
    ) {
      only(others, ['price', 'lasts', 'maxPeriods', 'currency', 'shares', 'acceptLeftover'], 'listForRent');
      const clears = await clearLeftovers(asset, acceptLeftover, { listing: true });
      const mint = mintOf(currency);
      const { before, ...nft } = await nftOf(asset);
      return send(
        await closesFirst(clears, [
          ...before,
          loot.openListingIx({
            maker: wallet.address,
            project,
            asset,
            mint,
            deal: { Rent: { price: units(price, decimalsOf(currency)), lasts, max_periods: maxPeriods } },
            shares,
            ...nft,
          }),
        ]),
      );
    },

    /**
     * The listing of `asset` (one account read), or null: { listing, asset, maker, mint, deal, renter, until }. One more
     * read says whether the project still holds the NFT: when whoever controls its collection took it back or burned
     * it, the listing is flagged `gone` with `says`, what that means in words. There is then nothing to buy or rent,
     * and the listing can be closed for nothing (`unlist` by its maker, `closeGone` by anyone).
     */
    async listing(asset) {
      const listing = await readMaybe('Listing', loot.pda.listing(project, asset));
      if (!listing) return null;
      const gone = (await heldNow(asset)).held === false;
      return {
        listing: loot.pda.listing(project, asset),
        ...listing,
        renter: loot.renterOf(listing, await chainNow()),
        ...(gone ? { gone: true, says: GONE_LISTING } : {}),
      };
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

    /**
     * The project's listings, a maker's (`maker`) or all: one search of the program's accounts, then one read of the
     * listed NFTs together, which flags a listing `gone` (with `says`) when the project no longer holds its NFT: a
     * Core asset held by another or burned, a Token Metadata NFT whose token left the project's account. A compressed
     * NFT is not read here (an indexer's answer for each): `listing(asset)` says it for one.
     */
    async listings({ maker, ...others } = NO_OPTIONS) {
      only(others, ['maker'], 'listings');
      const filters = [
        { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Listing)) } },
        { memcmp: { offset: 1, bytes: project } },
        ...(maker ? [{ memcmp: { offset: 33, bytes: maker } }] : []),
      ];
      const time = await chainNow();
      const found = (await client.programAccounts(loot.lootProgram(), filters)).map(({ pubkey, account }) => {
        const listing = loot.decode('Listing', account.data);
        return { listing: pubkey, ...listing, renter: loot.renterOf(listing, time) };
      });
      // Each NFT and the project's token account of it, all in one read.
      const read = found.length ? await client.accounts(found.flatMap(l => [l.asset, loot.ata(project, l.asset)])) : [];
      return found.map((l, i) => {
        const [nft, held] = [read[2 * i], read[2 * i + 1]];
        const gone =
          nft?.owner === MPL_CORE
            ? !coreHeld(nft)
            : nft?.owner === TOKEN_PROGRAM &&
              !(
                held?.data?.length >= 72 &&
                new DataView(held.data.buffer, held.data.byteOffset).getBigUint64(64, true) === 1n
              );
        return gone ? { ...l, gone: true, says: GONE_LISTING } : l;
      });
    },

    /**
     * Buys a listed NFT at the terms the player saw: `listing`, as `listing()` or `listings()` showed it. It is
     * required: the terms signed are those, never the listing read now, so a price or a share changed since is refused.
     * A listing whose NFT the project no longer holds (its collection took it back or burned it) is refused in words
     * before anything is signed: nothing is there to buy, and anyone can close that listing for nothing (`closeGone`).
     */
    async buyListing(asset, { listing, ...others } = NO_OPTIONS) {
      only(others, ['listing'], 'buyListing');
      await shownListing(asset, listing, 'Sell');
      await listedStill(asset);
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: wallet.address });
      const holders = await holdersOf(listing.shares ?? []);
      return send([
        ...before,
        ...withSolWrap(wallet.address, listing.mint, listing.deal.Sell.price, [
          loot.takeListingIx({
            taker: wallet.address,
            project,
            projectState: await projectNow(),
            listing,
            holders,
            programs,
            ...nft,
          }),
        ]),
      ]);
    },

    /**
     * Rents a listed NFT for `periods` periods, at the terms the player saw: `listing`, as `listing()` or `listings()`
     * showed it (required, as for `buyListing`). One whose NFT the project no longer holds is refused in words, as
     * `buyListing` refuses it.
     */
    async rentListing(asset, { periods = 1, listing, ...others } = NO_OPTIONS) {
      only(others, ['periods', 'listing'], 'rentListing');
      await shownListing(asset, listing, 'Rent');
      await listedStill(asset);
      const holders = await holdersOf(listing.shares ?? []);
      const total = BigInt(listing.deal.Rent.price) * BigInt(periods);
      // A compressed NFT is read by its record, proven first in the same transaction.
      const { before, compressed } = await nftOf(asset);
      return send([
        ...(compressed ? before : []),
        ...withSolWrap(wallet.address, listing.mint, total, [
          loot.takeListingIx({
            taker: wallet.address,
            project,
            projectState: await projectNow(),
            listing,
            periods,
            compressed,
            holders,
            programs,
          }),
        ]),
      ]);
    },

    /**
     * Takes a listed NFT home (its maker). While a rental runs it only stops the listing; call again once it is over.
     * A listing whose NFT the project no longer holds (its collection took it back or burned it) closes without it, on
     * that proof: nothing is sent, and the listing's rent comes back to its maker. While a rental of it still runs,
     * that close too only stops the listing, and closes it once the rental has run.
     */
    async unlist(asset) {
      const listing = await read('Listing', loot.pda.listing(project, asset));
      const proof = await goneProof(asset);
      if (proof)
        return send([...proof.before, loot.closeListingIx({ maker: wallet.address, project, listing, ...proof.kind })]);
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: wallet.address });
      return send([...before, loot.closeListingIx({ maker: wallet.address, project, listing, ...nft })]);
    },

    /**
     * Closes what this project still records of an NFT it no longer holds (`asset`: whoever controls its collection
     * took it out of the project's hands or burned it): each hold of it (`release`), its listing (`take_listing`),
     * and its row on each of the project's stashes that lists it (`stash`, out), on the proof that it is gone. Anyone
     * may, at any time, also while a hold runs and for a loan before it is due: nothing is sent or paid, and a loan's
     * debt ends unpaid. The sender pays the transaction's fee only; each record's rent goes to whoever that record
     * names (a hold's payer, a listing's maker), never to the sender, and a stash keeps the rent its row no longer
     * needs (it goes to the sender only when that is one of the project's keys). With its row off a stash, no roll
     * draws the NFT, and a prize that names it is passed over in place of failing on an NFT that can't move.
     * What is left is in `waits`: a listing whose rental still runs (the program keeps a running rental, and the
     * listing closes once it has run), and a lottery's own stash that lists the NFT (`kind` 'lottery-stash', with its
     * `lottery`, the lottery's id): only the project's keys take a row out of that one (`unraffle`), gone or not.
     * Refused in words, with nothing sent, when the project still holds the NFT or nothing shows it gone.
     * Besides one search of the NFT's holds, this makes one search of the project's stashes, which returns every
     * stash of the project whole (36 bytes for each NFT a stash lists): a stash's rows have no fixed place to look in.
     * Returns { signature, closed: [{ kind, address }], unstashed: [{ address, id }], waits: [{ kind, address }] }:
     * `closed` the holds and the listing it closed, `unstashed` the project's stashes it took the row off;
     * `signature` is null when there was nothing to close.
     */
    async closeGone(asset) {
      const [records, stashes] = [await recordsOf(asset), await stashesOf(asset)];
      if (!records.length && !stashes.length) return { signature: null, closed: [], unstashed: [], waits: [] };
      const proof = await goneProof(asset);
      if (!proof)
        throw new Error(
          `Nothing shows that the project no longer holds the NFT ${asset}: its records close this way only once it is proven gone (its collection took it back or burned it). Nothing was sent.`,
        );
      const { closes, closed, waits } = await closesOf(asset, records, proof);
      const listed = stashes.filter(x => x.kind === 'stash');
      // The row comes off each of the project's stashes: free, nothing moves, and where it would go is not read.
      const offs = listed.map(({ id }) =>
        loot.stashIx({ signer: wallet.address, project, id, asset, out: wallet.address, ...proof.kind }),
      );
      const left = [
        ...waits.map(({ kind, address }) => ({ kind, address })),
        ...stashes
          .filter(x => x.kind === 'lottery-stash')
          .map(({ kind, address, id }) => ({ kind, address, lottery: id })),
      ];
      const unstashed = listed.map(({ address, id }) => ({ address, id }));
      const instructions = [...(closes.length ? closes : offs.length ? proof.before : []), ...offs];
      if (!instructions.length) return { signature: null, closed, unstashed, waits: left };
      return { signature: await send(instructions), closed, unstashed, waits: left };
    },

    // ---------------------------------------------------------------- raffles

    /**
     * The project's owner raffles an NFT they hold, as lottery `id`: the NFT goes into the lottery's own stash, where
     * nothing but the lottery can take it while a place names it; the winner gets it before any ticket money moves.
     * `price` (whole units of `currency`) a ticket, `drawsAt` (Unix seconds) its one draw, `minSold` the least tickets
     * (fewer: the round is cancelled and refunded), `shares` where the ticket money goes (the seller's own wallet by
     * default: the treasury). Its one place takes no money, so it keeps no pot: the round pays from its own ticket
     * money, and what the shares leave goes to the treasury too. A seller runs it in a project of their own, whose
     * owner they are.
     */
    async raffle(
      id,
      nft,
      {
        price,
        currency,
        drawsAt,
        minSold = 0,
        perWallet = 0,
        shares = [{ to: 'Treasury', bps: 10_000 }],
        ...others
      } = NO_OPTIONS,
    ) {
      only(others, ['price', 'currency', 'drawsAt', 'minSold', 'perWallet', 'shares'], 'raffle');
      const kind = await nftOf(nft);
      const { before, hasAuthority: _, ...piece } = kind;
      const lotteryState = await readMaybe('Lottery', loot.pda.lottery(project, id));
      await send([
        ...before,
        loot.stashIx({ signer: wallet.address, project, lottery: id, lotteryState, asset: nft, ...piece }),
      ]);
      const args = {
        price: units(price, decimalsOf(currency)),
        mint: mintOf(currency),
        pays_from: { Round: { rest: 'Treasury' } },
        shares,
        places: [{ bps: 0, prize: { Held: [nft] } }],
        ticket_mint: NOBODY,
        every: 0n,
        draws_at: BigInt(drawsAt),
        gate: null,
        per_wallet: perWallet,
        min_sold: BigInt(minSold),
      };
      return send([loot.upsertIx({ owner: wallet.address, project, def: { Lottery: { id, args } }, lotteryState })]);
    },

    /**
     * The raffle's owner takes the NFT back out of lottery `id`'s own stash once nothing promises it (the lottery
     * ended, or no place names it). When the project no longer holds the NFT (its collection took it back or burned
     * it), only its row comes off the stash, on that proof: nothing is sent, and the owner gets no NFT back. Only the
     * project's owner or authority may, gone or not: a lottery's own stash is theirs alone (`NotAuthority` for anyone
     * else; `closeGone` leaves it and says so). Returns the signature.
     */
    async unraffle(id, nft) {
      const {
        before,
        hasAuthority: _,
        gone: _g,
        ...piece
      } = await leaving(nft, wallet.address, { to: wallet.address });
      const lotteryState = await readMaybe('Lottery', loot.pda.lottery(project, id));
      return send([
        ...before,
        loot.stashIx({
          signer: wallet.address,
          project,
          lottery: id,
          lotteryState,
          asset: nft,
          out: wallet.address,
          ...piece,
        }),
      ]);
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
     * a server signed ({ publicKey, signature, incarnation, round and amount, or rounds: [{ id, amount }], expires, personHash }). A list in xsolana.json names
     * no round (zeros). `amount` (a voucher's, or `options.amount` for a list's leaf): the tokens this claim gives, in
     * base units, up to the grant's own, for a grant of a fixed amount of tokens (a reward by rank); absent or 0 gives
     * the grant's prize as it is. A grant that gives a roll of a box makes the wallet's roll, which `claims()` then
     * lists and `collect` asks for and settles.
     */
    async claimGrant(grantKey, options = {}) {
      only(options, ['voucher', 'proof', 'personHash', 'round', 'amount', 'shown', 'listProof'], 'claimGrant');
      let {
        voucher = null,
        proof: given = null,
        personHash: listPerson = null,
        round: listRound = null,
        amount: listAmount = 0n,
        shown,
      } = options;
      const gspec = part('grants', grantKey);
      const address = loot.pda.grant(project, gspec.id);
      const grant = await read('Grant', address);
      shown ??= await passing(grant.gate, 'claim this');
      const gateProof = listProofOf(grant.gate, gspec.gate?.list, options.listProof);
      // What the grant has paid this wallet: its count of claims (an open claim's roll is named by it), and the rounds
      // paid (one paid already is skipped).
      const bits = grant.shard_bits;
      const [claimsShard, roundsShard] = await client.accounts([
        loot.pda.claims(address, grant.incarnation, loot.shardOf(loot.limitKey('wallet', wallet.address), bits)),
        loot.pda.rounds(address, grant.incarnation, loot.walletShard(grant, wallet.address)),
      ]);
      const count = loot.readLimit(loot.readListAccount(claimsShard), loot.limitKey('wallet', wallet.address)).count;
      const paidRounds = loot.readListAccount(roundsShard);
      // What its prize needs: a pool's mint, the item, an NFT's kind (a compressed one proven first).
      const prized = await prizeInputs([grant.gives]);
      const pool = grant.gives.Tokens?.from.Pool?.[0];
      const poolMint = pool !== undefined ? prized.poolMints[pool] : null;
      const item = prized.items[grant.gives.Item?.[0] ?? grant.gives.Compressed?.item] ?? null;
      const instructions = [...prized.before];
      let proof = [];
      const keys = gspec.keys ?? [];
      if (voucher) {
        if (voucher.incarnation == null || BigInt(voucher.incarnation) !== grant.incarnation)
          throw new Error('This voucher belongs to a different grant incarnation.');
        const message = loot.voucherBytes({
          grant: address,
          incarnation: grant.incarnation,
          wallet: wallet.address,
          personHash: voucher.personHash,
          rounds: voucher.rounds,
          round: voucher.round,
          expires: voucher.expires,
          amount: BigInt(voucher.amount ?? 0),
        });
        const signature = typeof voucher.signature === 'string' ? decodeBase58(voucher.signature) : voucher.signature;
        instructions.push(loot.ed25519Ix({ publicKey: voucher.publicKey, signature, message }));
        // A key under the grant's key root (a promo code's) proves it is one of them.
        const at = keys.indexOf(voucher.publicKey);
        proof =
          given ??
          (at >= 0
            ? loot.merkleProof(
                keys.map(k => loot.keyLeaf(k)),
                at,
              )
            : []);
      } else if (given) {
        proof = given;
      } else if ((gspec.list ?? []).length) {
        // An entry is an address (the grant's amount, round 0), or { wallet, amount, round } (whole units of the grant's
        // token): a wallet listed under several rounds claims each once (`options.round`, a number; the first by default).
        const list = gspec.list.map(e => (typeof e === 'string' ? { wallet: e } : e));
        const mint = grant.gives.Tokens?.from.Mint?.[0] ?? poolMint;
        const decimals =
          mint && list.some(e => e.amount !== undefined) ? ((await client.account(mint))?.data?.[44] ?? 0) : 0;
        const leaves = list.map(e =>
          loot.listLeaf(
            e.wallet,
            null,
            loot.listRound(e.round ?? 0),
            e.amount !== undefined ? units(e.amount, decimals) : 0n,
          ),
        );
        const at = list.findIndex(
          e => e.wallet === wallet.address && (typeof listRound !== 'number' || (e.round ?? 0) === listRound),
        );
        if (at < 0) throw new Error('This wallet is not on the list for this grant.');
        proof = loot.merkleProof(leaves, at);
        listRound = loot.listRound(list[at].round ?? 0);
        if (list[at].amount !== undefined) listAmount = units(list[at].amount, decimals);
      } else if ((gspec.vouchers ?? []).length || keys.length) {
        throw new Error('This grant pays a wallet a voucher key signs for: pass the voucher.');
      }
      // What this claim gives: the amount the voucher or the list's leaf names (0: the grant's prize as it is).
      const amount = BigInt((voucher ? voucher.amount : listAmount) ?? 0);
      const most = grant.gives.Tokens?.amount;
      if (amount > 0n && (most === undefined || amount > BigInt(most)))
        throw new Error(
          `This claim names ${amount} tokens, more than this grant gives${most === undefined ? ' (it gives no fixed amount of tokens)' : ` (${most})`}.`,
        );
      instructions.push(
        loot.claimGrantIx({
          project,
          id: gspec.id,
          grant,
          wallet: wallet.address,
          signer: wallet.address,
          count,
          rounds: voucher?.rounds,
          round: voucher?.round ?? listRound,
          expires: voucher?.expires,
          personHash: voucher?.personHash ?? listPerson,
          amount,
          proof,
          paidRounds,
          poolMint,
          item,
          nft: prized.nft,
          shown,
          listProof: gateProof,
          programs,
          voucherKey: voucher?.publicKey,
        }),
      );
      // A claim's records and prizes can pass the 200,000 compute units a transaction has by default.
      const all = [
        computeUnitLimit(grant.gives.Roll ? 1_400_000 : loot.CLAIM_COMPUTE_UNITS),
        ...instructions.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ];
      if (!grant.gives.Roll) return send(all);
      // A roll's orders are asked for in the claim's own transaction and settled by a key after: one prompt.
      const { signature, rolls } = await sendRolling(all);
      return rolls.length ? { signature, rolls } : signature;
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
        // (one server answers for both clusters: a request for mainnet says so, one for devnet names none, as before)
        const at = path.startsWith('http') ? path : `${base}${path}`;
        const on = loot.cluster();
        const url =
          on === 'devnet' || /[?&]cluster=/.test(at) ? at : `${at}${at.includes('?') ? '&' : '?'}cluster=${on}`;
        const r = await fetchImpl(url, init);
        // The status first: a proxy's error page is no JSON, and says nothing a player can act on but its status.
        const body = await r.json().catch(() => null);
        if (!r.ok)
          throw Object.assign(new Error(body?.error?.why ?? `The results server answered ${r.status}.`), {
            code: body?.error?.code,
            status: r.status,
          });
        if (body === null || typeof body !== 'object')
          throw new Error(`The results server answered ${r.status} with no JSON.`);
        return body;
      };
      const get = path => ask(path);
      // Where a list's proof is, as the server named it: a path on the server itself, or a whole URL on the server's own
      // origin. Any other place is refused before anything is fetched, so a server's answer can't send the page to
      // another host. A server given as a path (such as "/results") is on the page's own origin.
      const proofAt = proof => {
        const said = String(proof ?? '');
        let origin = null;
        let url = null;
        try {
          const home = new URL(`${base}/`, globalThis.location?.href);
          origin = home.origin;
          url = new URL(
            said.startsWith('/') && !said.startsWith('//') ? `${home.href.replace(/\/$/, '')}${said}` : said,
            home,
          );
        } catch {
          // not a URL at all: refused below
        }
        if (!url || origin === null || origin === 'null' || url.origin !== origin)
          throw new Error(
            `The results server named a list's proof at “${said}”, which is not on the server itself (${origin ?? base}): it was not fetched.`,
          );
        return url.href;
      };
      // Each value in a query is encoded: a round or a page the server named can't change the request's path.
      const q = value => encodeURIComponent(String(value));
      // A win's vouchers; a stash drop's NFT not given yet: the signed-in claim's, those for this wallet
      const vouchersOf = async round => {
        try {
          return (await get(`/v1/vouchers?game=${q(project)}&round=${q(round)}&wallet=${q(wallet.address)}`)).vouchers;
        } catch (e) {
          if (e.code !== 'R-SIGN-IN' || !token) throw e;
          const { vouchers } = await ask('/v1/claims', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ game: project, round, token }),
          });
          return vouchers.filter(v => v.wallet === wallet.address);
        }
      };
      const claimed = async (grantId, incarnation, round) => {
        const address = loot.pda.grant(project, grantId);
        const grant = await read('Grant', address);
        if (incarnation != null && BigInt(incarnation) !== BigInt(grant.incarnation)) return false;
        const shard = await client.account(
          loot.pda.rounds(address, grant.incarnation, loot.walletShard(grant, wallet.address)),
        );
        return loot.roundPaid(loot.readListAccount(shard), wallet.address, round);
      };
      const out = [];
      const take = async (round, grant, claim) => {
        try {
          const r = await claim();
          out.push({ round, grant, ...(typeof r === 'string' ? { signature: r } : r) });
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
        page = await get(
          `/v1/wins?game=${q(project)}&wallet=${q(wallet.address)}${page.next ? `&before=${q(page.next)}` : ''}`,
        );
        for (const win of page.wins.filter(x => x.grant !== null && x.grant !== undefined)) {
          // one win that fails (its vouchers refused, a sign-in run out, a list not there) is its own error line, and
          // the rest go on (a refused POST /v1/claims must not stop every later win)
          try {
            for (const v of await vouchersOf(win.round)) {
              const grantKey = (spec.grants ?? []).find(x => x.id === v.grant)?.key;
              if (!grantKey) continue;
              if (v.list) {
                // Paid by a list the owner wrote from the draw: its proof names the round.
                const list = await get(proofAt(v.proof));
                const mine = list.winners.find(w => w.wallet === wallet.address);
                if (!mine || (await claimed(v.grant, null, list.round))) continue;
                await take(win.round, v.grant, () =>
                  this.claimGrant(grantKey, {
                    proof: mine.proof,
                    personHash: mine.personHash,
                    round: list.round,
                    amount: mine.amount ?? 0,
                  }),
                );
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
     * collectible to take home, a hold of theirs or a loan they made or took whose NFT the project no longer holds (its
     * collection took it back or burned it: listed at any time, also while the hold runs, as a `release` flagged
     * `gone`, whose claim closes the hold and sends nothing), an auction they won (or one off by the clock: their bid back), a lottery place they
     * won, a draw that is due (anyone may reveal it, or ask again when the oracle never answered; it takes 0.0008
     * SOL), and a drawn lottery's unpaid places, which anyone may pay so the next round can open. [{ kind, says, … }];
     * a winner's first claim of a contest of tokens carries `potUnits` and `prizeUnits`, its part as the decision wrote
     * it (base units, as text). Pass one to `claim`.
     * A `pull`, a `contest` or an `auction` whose claim would hand out an NFT the project no longer holds is flagged
     * `gone` too, with `assets` (those NFTs) and `says`, what the claim does about each in words: a ticket's NFT, a
     * place's NFT, a contest's entry or a loser's NFT picked is not sent anywhere and its part closes; an auction with
     * its lot or an NFT of its winning bid gone is called off, or ended without it. Show `says` before the player signs.
     */
    async claims() {
      const me = wallet.address;
      const out = [];
      const tag = t => ({ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS[t])) } });
      const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
      const slot = await slotNow();
      const time = BigInt(now());
      const chainTime = await chainNow();
      for (const { pubkey, account } of await client.programAccounts(loot.lootProgram(), [
        tag('Order'),
        at(1, project),
        at(33, me),
      ])) {
        const o = loot.decode('Order', account.data);
        const opened = BigInt(o.requested_slot);
        if (loot.orderRefundable(o, slot, chainTime))
          out.push({ kind: 'refund', order: pubkey, says: 'Your payment back for an order that never finished.' });
        else if (o.status === 'Rolled' && slot > opened)
          out.push({ kind: 'settle', order: pubkey, says: 'What your box rolled.' });
        else if (loot.rollAskable(o, slot, chainTime))
          out.push({
            kind: 'settle',
            order: pubkey,
            says: 'A roll you won (a mission’s, a recipe’s, a prize’s): ask for it and see what it gives (one whose box has nothing left to give waits until it has).',
          });
      }
      for (const { pubkey, account } of await client.programAccounts(loot.lootProgram(), [
        tag('Contest'),
        at(1, project),
      ])) {
        const contest = loot.decode('Contest', account.data);
        const off = loot.contestOff(contest, time);
        if (!(off || contest.verdict === 'Won')) continue;
        const list = await client.account(loot.contestEntries(pubkey, contest));
        const entries = list?.owner === loot.lootProgram() ? loot.decodeEntries(list.data) : [];
        const entry = entries.find(e => e.player === me);
        if (!entry) continue;
        const won = !off && Number(contest.winner) === Number(entry.side);
        const first = won && !(entry.bits & loot.CLAIMED);
        // Owed: its money back (off) or its part of the pot (won), its own NFT while the contest holds it, a winner's
        // prize with its first claim, and the losers' NFTs its share still lets it pick. A loser of a contest of tokens
        // is owed nothing, and never sends a transaction.
        const picks =
          won && contest.nft && !(entry.bits & loot.ENDED) && Number(entry.taken) < loot.shareOf(contest, entry);
        const owed =
          (contest.nft ? Number(entry.amount) === 1 && (off || won) : BigInt(entry.amount) > 0n && (off || first)) ||
          first ||
          picks;
        if (!owed) continue;
        const says = off
          ? 'Your entry back: the contest is off.'
          : contest.nft
            ? `Your NFT back${picks ? ', and your pick of the losers’' : ''}.`
            : contest.prize != null
              ? 'Your share of the pot, and your prize.'
              : 'Your share of the pot.';
        // A winner's part of a contest of tokens is what the decision wrote, whoever claims first (`contestWinnings`).
        const winnings = first && !contest.nft ? loot.contestWinnings(contest, entry.amount) : null;
        // A contest of NFTs: what its claim moves, and which of those the project no longer holds (its collection
        // took it back or burned it). Such an NFT is not sent anywhere: the claim closes it, and says so here first.
        const moves = contest.nft ? await contestNfts(contest, entries, entries.indexOf(entry), undefined) : [];
        const lost = moves.filter(m => m.gone);
        const mine = lost.find(m => m.nft === entry.nft && entries[m.j] === entry);
        const there = [
          moves.some(m => entries[m.j] === entry && !m.gone) ? 'your NFT back' : '',
          moves.some(m => entries[m.j] !== entry && !m.gone) ? 'your pick of the losers’' : '',
        ]
          .filter(Boolean)
          .join(', and ');
        const goneSays = [
          off ? 'The contest is off.' : '',
          there ? `${there[0].toUpperCase()}${there.slice(1)}.` : '',
          goneContestSays(
            mine?.nft,
            lost.filter(m => m !== mine).map(m => m.nft),
          ),
        ]
          .filter(Boolean)
          .join(' ');
        out.push({
          kind: 'contest',
          id: contest.id,
          side: entry.side,
          ...(lost.length ? { gone: true, assets: lost.map(m => m.nft), says: goneSays } : { says }),
          ...(winnings ? { potUnits: String(winnings.pot), prizeUnits: String(winnings.prize) } : {}),
        });
      }
      // The player's holds; the project's treasury wallet's also those owed to the treasury (a hold whose player is the
      // project's own address: a dropped stash NFT, a lottery's or an auction's NFT owed to it). And the loans this
      // wallet made: one search of the project's holds finds them all.
      const g = await projectNow();
      const holdsOf = [me, ...(g.treasury === me ? [project] : [])];
      const holds = (await client.programAccounts(loot.lootProgram(), [tag('Hold'), at(1, project)]))
        .map(({ pubkey, account }) => ({ pubkey, hold: loot.decode('Hold', account.data) }))
        .filter(({ hold }) => holdsOf.includes(hold.player) || hold.debt?.lender === me);
      // Whether the project still holds each one's NFT: whoever controls its collection can take it back or burn it.
      const heldOf = await heldEach(holds.map(({ hold }) => hold.asset));
      for (const { pubkey, hold } of holds) {
        const claim = { kind: 'release', asset: hold.asset, hold: pubkey };
        // An NFT proven gone: its hold closes at any time, also while it runs and for a loan before it is due.
        if (heldOf.get(hold.asset)?.held === false) out.push({ ...claim, gone: true, says: goneHoldSays(hold) });
        // A repaid loan is a plain hold that is over (no debt, `free_at` 0): its NFT goes home whenever.
        else if (!hold.debt && holdsOf.includes(hold.player) && time >= BigInt(hold.free_at))
          out.push({
            ...claim,
            says:
              hold.player === project
                ? 'An NFT owed to the treasury: send it there.'
                : 'Your collectible back: its hold is over.',
          });
        // A loan this wallet made that is overdue and unpaid: its NFT is the lender's to take.
        else if (hold.debt?.lender === me && time >= BigInt(hold.free_at))
          out.push({ ...claim, says: 'A loan you made is overdue and unpaid: take its NFT.' });
      }
      // A compressed NFT's proof record this wallet paid for and left open: closing it brings its rent back. Found by its
      // payer, which sits at one of two places (without an asset data hash, and with one: `loot.PROVEN_PAYER_AT`): a
      // scan of every proof record of the program is refused by the play host's relay, and by any RPC that bounds what
      // a scan may ask. These records only give rent back, so a scan that is refused leaves them out and lists the rest.
      const proven = new Map();
      for (const offset of loot.PROVEN_PAYER_AT) {
        const found = await client.programAccounts(loot.lootProgram(), [tag('Proven'), at(offset, me)]).catch(() => []);
        for (const x of found) proven.set(x.pubkey, x);
      }
      for (const { account } of proven.values()) {
        const leaf = (() => {
          try {
            return loot.decodeProven(account.data);
          } catch {
            return null;
          }
        })();
        if (leaf?.payer === me)
          out.push({
            kind: 'close-leaf',
            asset: leaf.asset,
            tree: leaf.tree,
            says: 'A compressed NFT’s proof record you paid for: close it, and its rent comes back.',
          });
      }
      const auctions = spec.auctions ?? [];
      const found = await client.accounts(auctions.map(a => auctionAt(a)));
      for (const [i, a] of auctions.entries()) {
        const x = found[i] && loot.decode('Auction', found[i].data);
        if (!x || time < loot.auctionEnds(x)) continue;
        const [sold, owed] = [BigInt(x.high) > 0n, BigInt(x.proceeds_owed) > 0n];
        if (!(x.seller === me || (sold && !owed && x.high_bidder === me))) continue;
        // Its lot, or an NFT of the winning bid, that the project no longer holds (its collection took it back or
        // burned it): the end does not send it anywhere, and this says what the end does instead.
        const lot = owed ? null : (x.lot.Asset?.[0] ?? null);
        const bids = sold && x.nft_bids ? x.held : [];
        const heldOf = lot || bids.length ? await heldEach([...(lot ? [lot] : []), ...bids]) : new Map();
        const lostBids = bids.filter(nft => heldOf.get(nft)?.held === false);
        if ((lot && heldOf.get(lot)?.held === false) || lostBids.length) {
          const lotGone = lot && heldOf.get(lot)?.held === false;
          out.push({
            kind: 'auction',
            key: a.key,
            gone: true,
            assets: [...(lotGone ? [lot] : []), ...lostBids],
            says: goneSaleSays(a.name, x, me, lotGone ? lot : null, lostBids),
          });
          continue;
        }
        // The lot went first (an end too wide for one transaction, or a seller's account that couldn't take the money
        // then): only the money is left to pay.
        if (owed)
          out.push({
            kind: 'auction',
            key: a.key,
            says: `The winner of “${a.name}” has the lot, and the winning bid is still to be paid to you: end it again, and it is paid (once your account can take it).`,
          });
        else if (x.high_bidder === me) out.push({ kind: 'auction', key: a.key, says: `You won “${a.name}”: take it.` });
        // The seller's own auction, over: ending it pays them (or brings an unsold lot home).
        else
          out.push({
            kind: 'auction',
            key: a.key,
            says: sold
              ? `Your auction “${a.name}” is over: end it, and the winning bid is paid to you.`
              : `Your auction “${a.name}” ended with no bid: take your lot back.`,
          });
      }
      for (const l of spec.lotteries ?? []) {
        // A lottery the page names but nobody has written yet (a raffle still to open) has nothing to finish.
        if (!(await client.account(loot.pda.lottery(project, l.id)))) continue;
        const { current, rounds } = await roundOf(l);
        const bought = r => r.entries.some(e => e.buyer === me);
        if (current?.status === 'Open' && time >= BigInt(current.terms.draws_at)) {
          const short = BigInt(current.sold) < BigInt(current.terms.min_sold ?? 0);
          out.push({
            kind: 'reveal',
            key: l.key,
            says: short
              ? `“${l.name}” sold fewer tickets than it needs: call it off${bought(current) ? ' and take your ticket payment back, in one step' : ''}.`
              : `The draw of “${l.name}” is due: reveal the winners.`,
          });
        }
        for (const { address: round, round: r } of rounds) {
          // The ask moved the lottery on: a round waiting for the oracle is an older one, asked again by its address,
          // and after the timeout the next ask cancels it.
          if (loot.lotteryCancellable(r, chainTime))
            out.push({
              kind: 'cancel-draw',
              key: l.key,
              round,
              says: `The oracle never answered the draw of “${l.name}”: call it off${bought(r) ? ' and take your ticket payment back, in one step' : ', so every ticket is refunded'}.`,
            });
          else if (loot.lotteryDrawStuck(r, chainTime))
            out.push({
              kind: 'reveal',
              key: l.key,
              round,
              says: `The oracle never answered the draw of “${l.name}”: ask it again.`,
            });
          if (r.status !== 'Drawn' && r.status !== 'Cancelled') continue;
          // What this wallet is owed: a refund, its NFT ticket, its places' parts of the pot and their prizes.
          const mine = r.entries.flatMap((e, i) => {
            const parts = e.buyer === me ? loot.partsOwed(r, i) : [];
            return parts.length ? [{ entry: i, parts }] : [];
          });
          if (mine.length) {
            // An NFT of these parts that the project no longer holds (its collection took it back or burned it) is
            // not sent anywhere: the claim settles its part without it, and says so here first.
            const { tickets, prizes } = await roundNfts(r, mine);
            const heldOf = tickets.length + prizes.length ? await heldEach([...tickets, ...prizes]) : new Map();
            const lost = list => [...new Set(list)].filter(nft => heldOf.get(nft)?.held === false);
            const [lostTickets, lostPrizes] = [lost(tickets), lost(prizes)];
            const back = r.status === 'Cancelled' || Boolean(r.terms.returns);
            const owed =
              r.status === 'Cancelled'
                ? `Recover your ticket payment for “${l.name}”.`
                : `Take what you are owed in “${l.name}”.`;
            out.push({
              kind: 'pull',
              key: l.key,
              round,
              pulls: mine,
              ...(lostTickets.length + lostPrizes.length
                ? {
                    gone: true,
                    assets: [...lostTickets, ...lostPrizes],
                    says: `${owed} ${goneRoundSays(lostTickets, lostPrizes, back)}`,
                  }
                : { says: owed }),
            });
          }
          // Anyone may pay everyone else what they are owed, and the parts owed in common (about 0.002 SOL of account
          // rent for each payee who has no account for it yet, which stays with them): the last pull closes the round,
          // and its rent goes back to whoever fronted it (the lottery, or its first buyer).
          const others = r.entries.flatMap((e, i) =>
            loot.partsOwed(r, i).length && !mine.some(m => m.entry === i) ? [i] : [],
          );
          const fronted = r.opener === me;
          if (others.length || loot.commonOwed(r).length || (loot.roundFinished(r) && !mine.length))
            out.push({
              kind: 'payout',
              key: l.key,
              round,
              says: fronted
                ? `Pay everyone of “${l.name}” what they are owed: the round then closes, and your deposit for it comes back.`
                : `Pay the others of “${l.name}” what they are owed, so its round can close.`,
            });
        }
      }
      // A farm idle past more ends than a move can walk: anyone may walk it, in parts.
      for (const f of spec.farms ?? []) {
        const farm = await readMaybe('Farm', loot.pda.farm(project, f.id));
        if (!farm?.keeps_ends) continue;
        const { left } = await endsOf(f, farm);
        if (left > loot.MOVE_WALK_ROOM)
          out.push({
            kind: 'walk',
            key: f.key,
            says: `“${f.name ?? f.key}” must be caught up before anyone can move it: ${left} seats’ end times to walk, in ${Math.ceil(left / loot.WALK_PER_TX)} transactions. It is free but for the network fee, and nothing is lost by the wait.`,
          });
      }
      // A sealed schedule that pays this wallet: its runs that are due (vesting nobody can take back).
      for (const sc of spec.schedules ?? []) {
        const schedule = await readMaybe('Schedule', loot.pda.schedule(project, sc.id));
        if (!schedule) continue;
        if (!schedule.action.from.Vest) {
          // Any other schedule that is due: it waits for the project's keys or whoever it pays.
          const state = await projectNow();
          const to = schedule.action.to;
          if (
            [state.owner, state.authority].includes(me) ||
            to.Wallet?.[0] === me ||
            (to.Treasury !== undefined && state.treasury === me)
          ) {
            if (loot.runsDue(schedule, chainTime) > 0)
              out.push({ kind: 'schedule', key: sc.key, says: `“${sc.name ?? sc.key}” is due to run: send it.` });
          }
          continue;
        }
        if (schedule.action.to.Wallet?.[0] !== me) continue;
        const vault = await client.account(loot.pda.vest(loot.pda.schedule(project, sc.id)));
        const held = vault ? vault.data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
        if (loot.runsDue(schedule, chainTime, held) > 0)
          out.push({ kind: 'vest', key: sc.key, says: `What has vested of “${sc.name ?? sc.key}”: claim it.` });
      }
      // The player's listings whose rental is over: their NFT can go home (or wait for the next renter).
      const mineListed = await client.programAccounts(loot.lootProgram(), [tag('Listing'), at(1, project), at(33, me)]);
      for (const { account } of mineListed) {
        const listing = loot.decode('Listing', account.data);
        if (listing.deal.Rent && listing.user !== NOBODY && !loot.renterOf(listing, chainTime))
          out.push({
            kind: 'unlist',
            asset: listing.asset,
            says: listing.stopped
              ? 'The rental of your stopped listing is over: take your NFT home.'
              : 'A rental of yours is over: take your NFT home, or leave it listed for the next renter.',
          });
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
        // The project's standing tables are never a transaction's own: never retired here.
        if (!table || table.authority !== me || (spec.live?.tables ?? []).includes(pubkey)) continue;
        const step = tableStep(table, slot, recent);
        const rent = show(BigInt(account.lamports ?? 0), 9);
        if (step === 'close')
          out.push({
            kind: 'lookup-table',
            table: pubkey,
            says: `${rent} SOL of rent back from a lookup table a large transaction of yours used.`,
          });
        else if (
          step === 'active' &&
          table.addresses[0] === project &&
          slot > table.lastExtendedSlot + TABLE_UNSENT_SLOTS
        )
          out.push({
            kind: 'lookup-table',
            table: pubkey,
            says: `A lookup table made for a large transaction of yours that was never sent: retire it, and its ${rent} SOL of rent comes back about two minutes later.`,
          });
      }
      return out;
    },

    /**
     * Finishes one of `claims()`, signed by this player. Returns the signature. A `release` flagged `gone` closes its
     * hold on the proof that the project no longer holds the NFT: nothing is sent, the hold's rent goes back to whoever
     * paid it, and a loan's debt ends unpaid. A winner of a contest of NFTs picks
     * which loser's NFT they take (`{ take: asset }`, the NFT of a losing entry that still holds one; by default the
     * first found that the project still holds): only the winner can, while any are left.
     * An NFT a lottery's round or a contest owes that the project no longer holds (its collection took it back or
     * burned it) is not sent anywhere, and the claim still finishes. A ticket whose price sends it on (burned, given,
     * stashed) settles on the proof with nothing moved. A ticket going back to its buyer, a place's NFT and a
     * contest's NFT are only handed out by the program, which reads nothing first: the claim has it make a hold of
     * that NFT (`["hold", nft, 0]`) and closes that hold on the proof right after, in the same transaction when it
     * fits. The signer pays that hold's rent and gets it back at once. The program's receipts for it are those of a
     * hold made (`Held`, and `PrizeGiven` for a place's prize) and then `NftGone`: no `Released`.
     */
    async claim(c, { take, build = false, ...others } = NO_OPTIONS) {
      only(others, ['take', 'build'], 'claim');
      const me = wallet.address;
      // `build`: its instructions, unsent, for a step that is one transaction of the wallet's (`claimAll` signs several
      // at once); null for one that is not (a roll to wait for, a refund, a step of another flow).
      if (build && !BATCHED.has(c.kind)) return null;
      const send = build ? async instructions => instructions : sendNow;
      const g = await projectNow();
      if (c.kind === 'settle' || c.kind === 'refund') {
        // A settle key this order's open funded (made again from this session's signature, or stored): it settles with
        // no prompt, or gives its SOL back before the refund.
        const key = keys ? await keys.again(c.order, { ask: false }) : null;
        const funded = key && BigInt(await client.balance(key.address).catch(() => 0n)) > 0n ? key : null;
        if (c.kind === 'settle') return (await collect(c.order, funded ? { burner: funded } : {})).settled;
        if (funded) await emptyKey(funded);
        return this.refund(c.order);
      }
      if (c.kind === 'contest') {
        const contestAddress = loot.pda.contest(project, c.id);
        const contest = await read('Contest', contestAddress);
        const entries = loot.decodeEntries((await client.account(loot.contestEntries(contestAddress, contest))).data);
        const i = entries.findIndex(e => e.player === me);
        const own = entries[i];
        const won = contest.verdict === 'Won' && Number(contest.winner) === Number(own.side);
        const given = await prizeInputs([won && !(own.bits & loot.CLAIMED) ? contest.prize : null]);
        // A contest of NFTs: the entry's own NFT while the contest holds it, and for a winner the losers' NFTs its share
        // lets it pick (`take`: one asset, or several; the first left by default), as many as fit.
        const nfts = [];
        const kinds = {};
        // The NFTs of this claim that are proven gone from the project, each with what shows it and who staked it.
        // The contest only hands an NFT out and reads nothing, so each is passed as its hold (`["hold", nft, 0]`, made
        // for this player, who gets it), and that hold closes on the proof right after the claim: nothing is sent.
        const lost = new Map();
        if (contest.nft) {
          const proofs = {};
          for (const { j, nft } of await contestNfts(contest, entries, i, take)) {
            const { before, hasAuthority: _, gone, ...kind } = await leaving(nft, me, { to: me });
            proofs[nft] = before;
            kinds[nft] = kind;
            if (gone) lost.set(nft, { kind, player: me, rentTo: entries[j].player });
            nfts.push(j);
          }
          // A compressed NFT's proof is long (up to 17 nodes): such a claim moves one NFT, as a v0 transaction with a
          // lookup table (`send`), and the next claim takes the next.
          if (nfts.length > 1 && nfts.some(j => kinds[entries[j].nft]?.compressed)) nfts.splice(1);
          for (const j of nfts) given.before.push(...proofs[entries[j].nft]);
        }
        const closes = nfts.map(j => entries[j].nft).filter(nft => lost.has(nft));
        const claimed = [
          computeUnitLimit(800_000),
          ...given.before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
          loot.claimIx({
            payer: me,
            project,
            projectState: g,
            id: c.id,
            contest,
            entries,
            player: me,
            nfts: contest.nft ? nfts : undefined,
            kinds,
            hold: closes,
            collection: given.collection,
            poolMints: given.poolMints,
            items: given.items,
            nft: given.nft,
            programs,
          }),
          ...closes.map(nft => releaseOwed(nft, lost.get(nft).kind, lost.get(nft), me, g)),
        ];
        // A prize that rolls: asked for in the claim's own transaction and settled by a key after (one prompt).
        return contest.prize?.Roll && !build ? (await sendRolling(claimed)).signature : send(claimed);
      }
      if (c.kind === 'release') {
        const hold = await read('Hold', c.hold);
        // Its NFT proven gone from the project: the hold closes on that proof, at any time, and nothing is sent. Its
        // rent goes back to whoever paid it; a loan's debt ends unpaid.
        const proof = await goneProof(c.asset, me);
        if (proof)
          return send([
            ...proof.before,
            loot.releaseIx({
              signer: me,
              project,
              asset: c.asset,
              ...proof.kind,
              hold,
              address: c.hold,
              treasury: g.treasury,
              ...(hold.debt ? { to: hold.debt.lender } : {}),
            }),
          ]);
        const { before, hasAuthority: _, ...nft } = await nftOf(c.asset, me, { to: me });
        // An overdue loan's NFT goes to its lender.
        return send([
          ...before,
          loot.releaseIx({
            signer: me,
            project,
            asset: c.asset,
            ...nft,
            collection: (await collectionOf(c.asset)) ?? MPL_CORE,
            hold,
            address: c.hold,
            treasury: g.treasury,
            ...(hold.debt ? { to: hold.debt.lender } : {}),
          }),
        ]);
      }
      if (c.kind === 'auction') {
        const ended = await this.endAuction(c.key);
        // A lot that can't move now: the sale waits, and nothing was sent.
        if (ended.waiting) throw new Error(ended.says);
        return ended.signature;
      }
      if (c.kind === 'close-leaf') return send([loot.closeLeafIx({ asset: c.asset, tree: c.tree, payer: me })]);
      if (c.kind === 'walk') return this.walkFarm(c.key);
      if (c.kind === 'vest' || c.kind === 'schedule') return this.runSchedule(c.key);
      if (c.kind === 'unlist') return this.unlist(c.asset);
      if (c.kind === 'lookup-table') {
        const table = readTable(await client.account(c.table));
        const step = table && tableStep(table, await slotNow(), await recentSlots());
        if (!step || step === 'cooling') return null;
        return send(
          [
            step === 'close'
              ? closeTableIx({ table: c.table, authority: me })
              : deactivateTableIx({ table: c.table, authority: me }),
          ],
          [],
          { keepWrapped: true },
        );
      }
      if (!LOTTERY_STEPS.has(c.kind)) throw new Error(`Nothing to do for a claim of kind ${c.kind}.`);
      const l = part('lotteries', c.key);
      // An older round, named by its address, needs no lottery: one closed since never strands it.
      const lottery = c.round
        ? await readMaybe('Lottery', loot.pda.lottery(project, l.id))
        : await read('Lottery', loot.pda.lottery(project, l.id));
      const key = c.round ?? loot.currentRound(loot.pda.lottery(project, l.id), lottery);
      const found = await client.account(key);
      const r = found?.owner === loot.lootProgram() ? loot.decodeRound(found.data) : null;
      // The ask: the current round's once due, or an older round's again (after the timeout, it cancels the round).
      if (c.kind === 'reveal' || c.kind === 'cancel-draw') {
        const steps = await drawStep(l, lottery, c.round ?? null, r, me);
        // A draw that cancels the round (short of its least tickets, or the oracle never answered by the timeout)
        // refunds in the same transaction: this wallet's own parts are pulled right after it.
        const refunds = r ? await cancelPulls(key, r, me) : [];
        if (refunds.length) {
          const all = [
            computeUnitLimit(1_400_000),
            ...[...steps, ...refunds].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
          ];
          if ((await dryRun(me, all)).ok) return build ? all : send(all);
        }
        return build ? steps : send(steps);
      }
      if (!r) return null;
      // A round whose lottery was closed since: its lent rent is the owner's, on the owner's own close.
      const lotteryClosed = !lottery;
      // Pulls: this wallet's own parts, or (`payout`) everyone's and the parts owed in common, a few to a transaction;
      // when they are the last owed, the last pull closes the round. A round that owes nothing is only closed.
      // A named stash NFT that is gone refuses a stranger's pull: only its winner or a project key passes it over.
      const projectKey = me === g.owner || me === g.authority;
      const stranger = async (i, p) => {
        if (projectKey || r.entries[i].buyer === me) return false;
        // A minted prize the project can't mint now (not the mint's authority): a stranger's pull fails, so it is left
        // for later, when the project can; its winner or the project's keys may pass it over for nothing.
        const prized = p.Prize ? r.prizes.find(x => Number(x.run) === Number(p.Prize[0])) : null;
        if (prized?.minted) {
          const data = (await client.account(prized.mint))?.data;
          const authority = data && data[0] === 1 ? encodeBase58(data.subarray(4, 36)) : null;
          if (authority !== project) return true;
        }
        const named = p.Prize ? r.terms.places[Number(p.Prize[0])].prize?.Nft : null;
        if (!named) return false;
        const stash = loot.decodeStash((await client.account(loot.pda.stash(project, named.stash)))?.data ?? null);
        return !stash?.nfts.includes(named.nft);
      };
      const theirs = [];
      if (c.kind !== 'pull')
        for (const i of r.entries.keys()) {
          const parts = [];
          for (const p of loot.partsOwed(r, i)) if (!(await stranger(i, p))) parts.push(p);
          if (parts.length) theirs.push({ entry: i, parts });
        }
      const owed =
        c.kind === 'pull' ? c.pulls : [...loot.commonOwed(r).map(p => ({ entry: null, parts: [p] })), ...theirs];
      if (!owed.length) {
        if (!loot.roundFinished(r)) return null;
        // Rent the lottery lent goes to the owner once it is closed, and only on the owner's own close.
        const close = [
          loot.pullIx({ payer: me, project, roundAddress: key, round: r, projectState: g, lotteryClosed, programs }),
        ];
        return build ? close : send(close);
      }
      const batch = owed.slice(0, 4);
      const settles = batch.reduce(
        (n, { entry, parts }) => n + parts.reduce((m, p) => m + pullSettles(r, entry, p), 0),
        0,
      );
      const closes = settles >= Number(r.owed);
      const instructions = [computeUnitLimit(1_400_000)];
      const rolls = [];
      let heap = false;
      let partial = false;
      for (const [k, { entry, parts }] of batch.entries()) {
        const built = await pulls(key, r, entry, parts, me, {
          closes: closes && k === batch.length - 1,
          lotteryClosed,
        });
        instructions.push(...built.instructions.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM));
        rolls.push(...built.rolls);
        heap ||= built.heap;
        partial ||= built.partial;
      }
      // A run of rolls, or several NFTs out of the round's own stash, asks for the largest heap.
      if (heap) instructions.splice(1, 0, requestHeapFrame(loot.LARGE_SETTLE_HEAP));
      // A pull that stopped short of its part (a raffle's NFTs, 64 a pull; a run of rolls): sent, then the next carries
      // on while the round moves (its NFTs out, its places paid) and still owes it.
      const carryOn = async signature => {
        if (build || !partial) return signature;
        const after = await client.account(key);
        const r2 = after?.owner === loot.lootProgram() ? loot.decodeRound(after.data) : null;
        const moved = r2 && (Number(r2.assigned) > Number(r.assigned) || Number(r2.owed) < Number(r.owed));
        if (!moved) return signature;
        const left =
          c.kind === 'pull'
            ? r2.entries.flatMap((e, i) => {
                const parts = e.buyer === me ? loot.partsOwed(r2, i) : [];
                return parts.length ? [{ entry: i, parts }] : [];
              })
            : null;
        if (left && !left.length) return signature;
        await this.claim(left ? { ...c, pulls: left } : c);
        return signature;
      };
      // A place's roll is asked for in the pull's own transaction (catalog P1): the winner's own, with a key that settles
      // it after (one prompt); someone else's, asked for when the box can give, else left for its winner to ask.
      if (!rolls.length) return build ? instructions : carryOn(await send(instructions));
      if (c.kind === 'pull' && !build) return carryOn((await sendRolling(instructions)).signature);
      const asks = [];
      for (const { order, box } of rolls)
        asks.push(...(await asksFor(me, order, { project, loot_box: loot.pda.box(project, box) })));
      const all = [...instructions, ...asks];
      const asked = (await dryRun(me, all)).ok ? all : instructions;
      return build ? asked : carryOn(await send(asked));
    },

    /**
     * Everything in `list` (by default `claims()`) taken in as few prompts as it can: each step that is one transaction
     * of the wallet's is built first and the lot signed in one prompt when the wallet signs several at once
     * (`wallet.signTransactions`); a lottery's steps depend on each other, so one of each lottery a call. The rest (a roll
     * to settle, a refund, an auction to end…) go one by one after. Returns [{ claim, signature } | { claim, error }].
     */
    async claimAll(list) {
      list ??= await this.claims();
      const [built, alone, lotteries] = [[], [], new Set()];
      const out = [];
      for (const c of list) {
        if (!BATCHED.has(c.kind)) {
          alone.push(c);
          continue;
        }
        const lottery = LOTTERY_STEPS.has(c.kind) ? c.key : null;
        if (lottery !== null && lotteries.has(lottery)) continue;
        const instructions = await this.claim(c, { build: true }).catch(
          e => (out.push({ claim: c, error: e.message }), null),
        );
        if (!instructions?.length) continue;
        if (lottery !== null) lotteries.add(lottery);
        built.push([c, instructions]);
      }
      const sent = await sendBatch(built.map(([, instructions]) => instructions));
      out.push(...built.map(([claim], i) => ({ claim, ...sent[i] })));
      for (const claim of alone)
        out.push(
          await this.claim(claim).then(
            signature => ({ claim, signature }),
            e => ({ claim, error: e.message }),
          ),
        );
      return out;
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
          out[t.key] = a
            ? show(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true), t.decimals ?? 0)
            : '0';
        }
      }
      return out;
    },
  };
}
