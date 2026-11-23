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
//
// solanaApp() builds what its parts share once (`ctx`) and puts the app together from them: the modules beside this
// one, one a feature (boxes.js, farms.js, lotteries.js…), on the reads, the NFTs and the sending they share (reads.js,
// nfts.js, sending.js…).
import { decodeBase58, encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { COMPUTE_BUDGET_PROGRAM, NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import {
  computeUnitLimit,
  createAssociatedTokenAccountIdempotent,
  requestHeapFrame,
  withSolWrap,
} from '../chain/programs.js';
import { rightCluster, rpcClient } from '../chain/rpc.js';
import { mintPowers } from '../chain/token2022.js';
import {
  closeTableIx,
  deactivateTableIx,
  readTable,
  sendPlan,
  tablesOf,
  tableStep,
  LOOKUP_TABLE_PROGRAM,
} from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { browserStore, keyring } from './keys.js';
import { freshKey, isProveLeaf, MPL_CORE, NO_OPTIONS, only, show, units } from './common.js';
import { addNfts } from './nfts.js';
import { addGates } from './gates.js';
import { addReads } from './reads.js';
import { addSending } from './sending.js';
import { addRolls } from './rolls.js';
import { addLeftovers } from './leftovers.js';
import { addFarms } from './farms.js';
import { addLotteries } from './lotteries.js';
import { addAuctions } from './auctions.js';
import { addContests } from './contests.js';
import { addListings } from './listings.js';
import { addBoxes } from './boxes.js';

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

/** A lottery's steps in `claims()`: each depends on the one before, so `claimAll` takes one of a lottery's a call. */
const LOTTERY_STEPS = new Set(['reveal', 'cancel-draw', 'pull', 'payout']);
/** The claims that are one transaction of the wallet's: `claimAll` signs them together. */
const BATCHED = new Set(['contest', 'release', 'lookup-table', 'close-leaf', ...LOTTERY_STEPS]);

/** A table made this many slots ago whose transaction never landed was never sent: its blockhashes ran out long since. */
const TABLE_UNSENT_SLOTS = 300n;

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

export { units } from './common.js';

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
 * by (Unix seconds). The RPC must be of the cluster this build is for (`onCluster`: devnet, or mainnet for an economy
 * whose file says so); another cluster's is refused. `keyStore`: where a settle key that can't
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

  /** What closing a hold whose NFT is gone does, in words, for `claims()`. */
  const goneHoldSays = hold =>
    `The project no longer holds this NFT: whoever controls its collection took it back or burned it while it was held. Its hold can be closed now, by anyone: closing it sends nothing, and the hold's rent goes back to whoever paid it (${hold.payer}).${hold.debt ? ' It was a loan: nothing is repaid, the borrower keeps what they borrowed, and the lender gets neither the NFT nor the repayment.' : ''}`;

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
   * What the app's parts share (the modules beside this one): the spec, the RPC, the wallet, the clock and the reads
   * above. Each part's factory adds the helpers a later part uses, in the order they run here, and returns its methods;
   * the state the parts keep (the project's record, the standing tables, a link voucher waiting) lives on it, one copy
   * an app.
   */
  const ctx = {
    spec,
    wallet,
    programs,
    now,
    sponsor,
    live,
    client,
    project,
    keys,
    jobKey,
    collections,
    ours,
    tokens,
    currencyKey,
    mintOf,
    decimalsOf,
    programOf,
    part,
    read,
    readMaybe,
  };
  const nfts = addNfts(ctx);
  const gates = addGates(ctx);
  const reads = addReads(ctx);
  const sending = addSending(ctx);
  addRolls(ctx);
  addLeftovers(ctx);
  const farms = addFarms(ctx);
  const lotteries = addLotteries(ctx);
  const auctions = addAuctions(ctx);
  const contests = addContests(ctx);
  const listings = addListings(ctx);
  const boxes = addBoxes(ctx);
  const {
    personFor,
    collectionOf,
    nftOf,
    heldNow,
    heldEach,
    goneProof,
    leaving,
    releaseOwed,
    tokenSettings,
    prizeInputs,
    projectNow,
    auctionAt,
    escrowedIn,
    lockedIn,
    passing,
    listProofOf,
    send,
    sendNow,
    sendBatch,
    dryRun,
    emptyKey,
    sendRolling,
    collect,
    freshNonce,
    asksFor,
    slotNow,
    recentSlots,
    chainNow,
    endsOf,
    clearLeftovers,
    closesFirst,
    holdersOf,
    roundOf,
    hookTail,
    drawStep,
    contestNfts,
    roundNfts,
    cancelPulls,
    pullSettles,
    pulls,
  } = ctx;

  return {
    project,
    get address() {
      return wallet?.address ?? null;
    },

    ...boxes,

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

    ...lotteries,
    proveTraits: gates.proveTraits,
    ...farms,

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
      const linked = await personFor(recipe.per_wallet);
      const before = [...proving, ...given.before, ...linked.ixs].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      let instructions = [
        computeUnitLimit(rolls ? 1_400_000 : 1_000_000),
        ...before,
        loot.craftIx({
          person: linked.person,
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
      // What the token's own settings let a lender do: the program takes these, so the kit says them.
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

    ...contests,
    ...auctions,

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

    ...listings,
    ...sending,
    link: gates.link,

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
      // Tickets a grant gives go into its lottery's current round, read now.
      const lotteries = grant.gives.Ticket
        ? {
            [grant.gives.Ticket.lottery]: await read('Lottery', loot.pda.lottery(project, grant.gives.Ticket.lottery)),
          }
        : {};
      // A grant counted by person: the person the voucher names, else the wallet's link (sent first when the server
      // gave one), else none (refused).
      const { issuer } = await projectNow();
      const byPerson = Boolean(grant.limits.wallet.by_person);
      // Who is who is the issuer's word: the person a voucher of the issuer's names, or the list's; else the link's.
      const some = p => Boolean(p) && !/^0+$/.test(typeof p === 'string' ? p : Array.from(p).join(''));
      const named = voucher ? voucher.publicKey === issuer && some(voucher.personHash) : some(listPerson);
      const linked =
        byPerson && !named ? await personFor({ ...grant.limits.wallet, total: 1 }) : { person: null, ixs: [] };
      const pool = grant.gives.Tokens?.from.Pool?.[0];
      const poolMint = pool !== undefined ? prized.poolMints[pool] : null;
      const item = prized.items[grant.gives.Item?.[0] ?? grant.gives.Compressed?.item] ?? null;
      const instructions = [...prized.before, ...linked.ixs];
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
          lotteries,
          issuer,
          linkedPerson: linked.person,
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
        if (listing.deal.Rent && listing.user !== NO_ADDRESS && !loot.renterOf(listing, chainTime))
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

    ...nfts,
    ...reads,
  };
}
