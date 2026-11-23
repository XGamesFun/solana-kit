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
//   const bought = await app.buy('sword', { listing: items[0] });  // { asset }: the price shown is the most it pays
//   const opened = await app.openBox('chest', { listing });  // { won }: waits for the roll, settles it: one prompt
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
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { rightCluster, rpcClient } from '../chain/rpc.js';
import * as loot from '../client/index.js';
import { browserStore, keyring } from './keys.js';
import { freshKey } from './common.js';
import { addNfts, nftMethods } from './nfts.js';
import { addGates, gateMethods } from './gates.js';
import { addReads, readMethods } from './reads.js';
import { addSending, sendingMethods } from './sending.js';
import { addRolls } from './rolls.js';
import { addLeftovers } from './leftovers.js';
import { addFarms, farmMethods } from './farms.js';
import { addLotteries, lotteryMethods } from './lotteries.js';
import { addAuctions, auctionMethods } from './auctions.js';
import { addContests, contestMethods } from './contests.js';
import { listingMethods } from './listings.js';
import { boxMethods } from './boxes.js';
import { paymentMethods } from './payments.js';
import { holdMethods } from './holds.js';
import { recipeMethods } from './recipes.js';
import { scheduleMethods } from './schedules.js';
import { grantMethods } from './grants.js';
import { claimMethods } from './claims.js';

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
 *
 * @returns {{ project: any, readonly address: any } & ReturnType<typeof boxMethods>
 *  & ReturnType<typeof paymentMethods> & ReturnType<typeof lotteryMethods> & ReturnType<typeof gateMethods>
 *  & ReturnType<typeof farmMethods> & ReturnType<typeof recipeMethods> & ReturnType<typeof holdMethods>
 *  & ReturnType<typeof contestMethods> & ReturnType<typeof auctionMethods> & ReturnType<typeof scheduleMethods>
 *  & ReturnType<typeof listingMethods> & ReturnType<typeof sendingMethods> & ReturnType<typeof grantMethods>
 *  & ReturnType<typeof claimMethods> & ReturnType<typeof nftMethods> & ReturnType<typeof readMethods>}
 *   The app: its project, the wallet's address, and the methods of each part (the modules beside this one).
 */
export function solanaApp({
  spec,
  rpcUrl = /** @type {string | null} */ (null),
  rpc = /** @type {any} */ (null),
  wallet,
  programs = {},
  now = () => Math.floor(Date.now() / 1000),
  keyStore = browserStore(),
  sponsor = /** @type {any} */ (null),
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
  /**
   * What the app's parts share (the modules beside this one): the spec, the RPC, the wallet, the clock and the reads
   * above. Each part's `add…` factory puts its helpers on it, in the order they run here, for the parts after it; then
   * each part's `…Methods` factory returns its methods. The state the parts keep (the project's record, the standing
   * tables, a link voucher waiting) lives on it, one copy an app.
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
  addNfts(ctx);
  addGates(ctx);
  addReads(ctx);
  addSending(ctx);
  addRolls(ctx);
  addLeftovers(ctx);
  addFarms(ctx);
  addLotteries(ctx);
  addAuctions(ctx);
  addContests(ctx);
  const nfts = nftMethods(ctx);
  const gates = gateMethods(ctx);
  const reads = readMethods(ctx);
  const sending = sendingMethods(ctx);
  const farms = farmMethods(ctx);
  const lotteries = lotteryMethods(ctx);
  const auctions = auctionMethods(ctx);
  const contests = contestMethods(ctx);
  const listings = listingMethods(ctx);
  const boxes = boxMethods(ctx);
  const payments = paymentMethods(ctx);
  const holds = holdMethods(ctx);
  const recipes = recipeMethods(ctx);
  const schedules = scheduleMethods(ctx);
  const grants = grantMethods(ctx);
  const claims = claimMethods(ctx);

  return {
    project,
    get address() {
      return wallet?.address ?? null;
    },

    ...boxes,
    ...payments,
    ...lotteries,
    proveTraits: gates.proveTraits,
    ...farms,
    ...recipes,
    ...holds,
    ...contests,
    ...auctions,
    ...schedules,
    ...listings,
    ...sending,
    link: gates.link,
    ...grants,
    ...claims,
    ...nfts,
    ...reads,
  };
}
