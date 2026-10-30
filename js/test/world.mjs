// The chain before any loot instruction, for the client's tests: the loot program as devnet runs it (js/test/fixtures/
// loot.so, the build release.json pins; with XSOLANA_PROGRAM_DIR, that checkout's target/deploy/loot.so instead, for
// testing a local build), and from js/test/fixtures the outside programs as mainnet runs them (SPL Token, Token-2022,
// the associated token program, Memo, Metaplex Core, MagicBlock's VRF), each refused unless it is the build pinned.txt
// pins (`npm run fixtures` downloads them), the oracle's queue as it is on mainnet, and mainnet's feature set and rent
// (runtime.txt; devnet's with XSOLANA_TEST_CLUSTER=devnet); then funded keys, the project's token and the owner's Core
// collection. The same start as the program's own tests.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBase58 } from '../chain/base58.js';
import { fromBase64 } from '../chain/bytes.js';
import { createCollectionInstruction } from '../chain/core.js';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { createAssociatedTokenAccountIdempotent } from '../chain/programs.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, mintToIx } from '../chain/token.js';
import { readTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { loadLiteSVM, newAddress, seeded, simChain } from '../sim/chain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** A local build of the loot program (XSOLANA_PROGRAM_DIR), or null: the test that the IDL matches its build runs only with one. */
export const program = process.env.XSOLANA_PROGRAM_DIR ? path.resolve(process.env.XSOLANA_PROGRAM_DIR) : null;
/** The pinned programs, accounts and runtime the tests load. */
export const fixtures = path.join(root, 'js/test/fixtures');
/** The loot program the tests run: a local build when XSOLANA_PROGRAM_DIR names a checkout, else the pinned devnet build. */
const localBuild = process.env.XSOLANA_PROGRAM_DIR ? path.join(program, 'target/deploy/loot.so') : null;
const lootProgram = () => (localBuild ? readFileSync(localBuild) : pinned('loot.so'));
const FETCH = 'run `npm run fixtures`';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const BPF_LOADER_2 = 'BPFLoader2111111111111111111111111111111111';

/** The words of each line of a file of js/test/fixtures, comments left out. */
const lines = (name) =>
  readFileSync(path.join(fixtures, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => l.trim().split(/\s+/));

let pins = null;
const read = new Map();
/**
 * A file of js/test/fixtures that its pinned.txt pins (a program or an account as a cluster has it, or the test hook),
 * read once and refused unless its sha256 is the pinned one.
 */
export function pinned(name) {
  if (read.has(name)) return read.get(name);
  pins ??= new Map(lines('pinned.txt').map((w) => [w[0], w[4]]));
  const want = pins.get(name);
  if (!want) throw new Error(`js/test/fixtures/${name} is not in ${path.join(fixtures, 'pinned.txt')}`);
  const at = path.join(fixtures, name);
  if (!existsSync(at)) throw new Error(`${at} is missing: ${FETCH}`);
  const bytes = readFileSync(at);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`${at} is not the pinned build (sha256 ${got}, pinned.txt says ${want}): ${FETCH}`);
  read.set(name, bytes);
  return bytes;
}

/** The cluster whose runtime every world runs: mainnet, or devnet when XSOLANA_TEST_CLUSTER=devnet. */
export const cluster = process.env.XSOLANA_TEST_CLUSTER ?? 'mainnet';
if (!['mainnet', 'devnet'].includes(cluster)) throw new Error(`XSOLANA_TEST_CLUSTER=${cluster}: mainnet or devnet`);

/** A cluster's runtime from js/test/fixtures/runtime.txt: { off: the feature ids it has off, rent }. */
export function runtime(cluster = 'mainnet') {
  const column = cluster === 'mainnet' ? 2 : 3;
  const words = lines('runtime.txt');
  const rent = words.find((w) => w[0] === 'rent' && w[1] === cluster);
  return {
    off: words.filter((w) => w[0] === 'feature' && w[column] === 'off').map((w) => w[1]),
    rent: { lamportsPerByteYear: BigInt(rent[2]), exemptionThreshold: Number(rent[3]), burnPercent: Number(rent[4]) },
  };
}

export const PRICE = 1_000_000n;
export const FEES = { player: 2_000_000n, project: 10_000n };

/** Why the chain tests can't run here, or null when they can. */
export function cannotRun() {
  if (localBuild && !existsSync(localBuild)) return `${localBuild} is missing: run \`anchor build --ignore-keys\` in XSOLANA_PROGRAM_DIR, or unset it to test the pinned devnet build`;
  const needed = ['pinned.txt', 'runtime.txt', 'spl_token.so', 'token_2022.so', 'associated_token.so', 'memo.so', 'mpl_core.so', 'vrf.so', 'mainnet/queue.json', ...(localBuild ? [] : ['loot.so'])];
  for (const f of needed) if (!existsSync(path.join(fixtures, f))) return `${path.join(fixtures, f)} is missing: ${FETCH}`;
  try {
    loadLiteSVM();
  } catch (e) {
    return e.message;
  }
  return null;
}

function queueAccount() {
  const q = JSON.parse(pinned('mainnet/queue.json').toString('utf8'));
  return { address: q.pubkey, owner: q.account.owner, lamports: BigInt(q.account.lamports), data: fromBase64(q.account.data[0]) };
}

/** A collectible item's args. */
export const collectible = (name, maxSupply = 0, more = {}) => ({
  kind: 'Collectible',
  rarity: 3,
  soulbound: false,
  burnable: false,
  name,
  uri: `https://example.invalid/${name.toLowerCase().replace(/ /g, '-')}.json`,
  max_supply: maxSupply,
  life: null,
  active: true,
  ...more,
});

/** A box's args. */
export const boxArgs = (price, entries, more = {}) => ({
  price,
  currency: null,
  rise: null,
  fall: null,
  stock_odds: false,
  active: true,
  shares: [],
  entries,
  gate: null,
  odds: [],
  ...more,
});

/** A box entry that gives these prizes. */
export const drop = (prizes, weight = 1, burns = false) => ({ prizes, burns, weight });
export const itemDrop = (id, weight = 1) => drop([{ Item: [id] }], weight);
/** `amount` tokens from pool `pool`. */
export const fromPool = (pool, amount) => ({ Tokens: { from: { Pool: [pool] }, amount: { Fixed: [BigInt(amount)] } } });

/** Why the compressed NFT tests can't run here (Bubblegum as on mainnet, `npm run fixtures`), or null. */
export function cannotRunCompressed() {
  for (const f of ['bubblegum.so', 'mpl_account_compression.so', 'mpl_noop.so']) if (!existsSync(path.join(fixtures, f))) return `js/test/fixtures/${f} is missing: ${FETCH}`;
  return cannotRun();
}

/**
 * The chain `xsolana approve` sends to (`createApproval`'s `chain`), answered by the world's local chain: it reads accounts
 * and each sent transaction's status as an RPC would. `overrides` replaces any of its calls.
 */
export function approvalChain(w, overrides = {}) {
  // What each transaction sent through `w.chain.sendWire` came to, by its signature, as an RPC's history keeps it.
  if (!w.sent) {
    w.sent = new Map();
    const sendWire = w.chain.sendWire;
    w.chain.sendWire = (wire, options) => {
      const signature = encodeBase58(readTransaction(wire).signatures[0]);
      try {
        sendWire(wire, options);
        w.sent.set(signature, null);
        return signature;
      } catch (e) {
        w.sent.set(signature, e.message);
        throw e;
      }
    };
  }
  return {
    latestBlockhash: async () => ({ blockhash: w.chain.svm.latestBlockhash(), lastValidBlockHeight: 1e12 }),
    rent: async (bytes) => w.chain.rent(bytes),
    send: async (wire) => w.chain.sendWire(wire),
    confirm: async () => {},
    account: async (address) => w.chain.rpc.account(address),
    signatureStatus: async (signature) => (w.sent.has(signature) ? { err: w.sent.get(signature), confirmationStatus: 'confirmed' } : null),
    blockHeight: async () => 0,
    ...overrides,
  };
}

/**
 * A fresh chain with the platform and a project open (unless told not to), its owner's catalog empty. `compressed`:
 * Bubblegum, mpl-account-compression and mpl-noop too (as on mainnet), and the project's collection takes compressed
 * NFTs (Bubblegum's plugin).
 */
export function world({ seed = 'world', platform = true, project = true, compressed = false } = {}) {
  const { LiteSVM, FeatureSet, Rent } = loadLiteSVM();
  const random = seeded(seed);
  const admin = newAddress(random);
  const chain = simChain({
    LiteSVM,
    FeatureSet,
    Rent,
    random,
    runtime: runtime(cluster),
    programs: {
      // The SPL programs as mainnet runs them, in place of LiteSVM's (its SPL Token, Token-2022 v11.0.0 and Memo are
      // other builds), each under the loader it has there.
      [TOKEN_PROGRAM]: pinned('spl_token.so'),
      [TOKEN_2022_PROGRAM]: pinned('token_2022.so'),
      [ASSOCIATED_TOKEN_PROGRAM]: { bytes: pinned('associated_token.so'), loader: BPF_LOADER_2 },
      [MEMO_PROGRAM]: { bytes: pinned('memo.so'), loader: BPF_LOADER_2 },
      [loot.LOOT_PROGRAM]: lootProgram(),
      [loot.MPL_CORE_PROGRAM]: pinned('mpl_core.so'),
      [loot.VRF_PROGRAM]: pinned('vrf.so'),
      ...(compressed && {
        [loot.BUBBLEGUM_PROGRAM]: pinned('bubblegum.so'),
        [loot.COMPRESSION_PROGRAM]: pinned('mpl_account_compression.so'),
        [loot.NOOP_PROGRAM]: pinned('mpl_noop.so'),
      }),
    },
    accounts: [queueAccount()],
    upgradeAuthority: admin,
  });
  chain.airdrop(admin, 100_000_000_000n);
  const who = () => {
    const a = newAddress(random);
    chain.airdrop(a, 100_000_000_000n);
    return a;
  };
  const w = { chain, random, admin, who, creator: who(), authority: who(), player: who(), cranker: who() };

  /** A new classic mint with `authority` as its mint authority (6 decimals). */
  w.newMint = (authority = w.creator) => {
    const mint = newAddress(random);
    chain.send(authority, [
      createAccountIx({ from: authority, address: mint, lamports: chain.rent(MINT_BYTES), space: MINT_BYTES, owner: TOKEN_PROGRAM }),
      initializeMint2Ix({ mint, decimals: 6, authority }),
    ]);
    return mint;
  };
  /** Makes sure `wallet` has a token account of `mint`; returns it. */
  w.tokenAccount = (wallet, mint) => {
    const key = loot.ata(wallet, mint);
    if (!chain.get(key)) chain.send(w.cranker, [createAssociatedTokenAccountIdempotent(w.cranker, wallet, mint)]);
    return key;
  };
  /** The owner (the mint authority of the tests' mints) mints `amount` of `mint` to `wallet`. */
  w.fund = (wallet, mint, amount) => {
    const to = w.tokenAccount(wallet, mint);
    chain.send(w.creator, [mintToIx({ mint, to, authority: w.creator, amount })]);
    return to;
  };
  /** What `wallet` holds of `mint`. */
  w.balance = (wallet, mint = w.mint) => chain.tokens(loot.ata(wallet, mint));
  /** The owner writes a record: a collectible with no collection is minted into the project's, a box with no currency
   * is priced in the project's token. */
  w.upsert = (def) => {
    if (def.Item?.args.kind === 'Collectible') def = { Item: { ...def.Item, args: { collection: w.collection, ...def.Item.args } } };
    if (def.Box && !def.Box.args.currency) def = { Box: { ...def.Box, args: { ...def.Box.args, currency: w.mint } } };
    return chain.send(w.creator, [loot.upsertIx({ owner: w.creator, project: w.project, def })]);
  };
  /** The owner opens pool `index` of `mint` and puts `amount` in it. */
  w.pool = (index, mint = w.mint, amount = 0n) => {
    chain.send(w.creator, [loot.openPoolIx({ owner: w.creator, project: w.project, index, mint })]);
    if (amount > 0n) {
      w.fund(w.creator, mint, amount);
      w.payIn(w.creator, mint, amount, [{ to: { Pool: [index] }, bps: 10_000 }]);
    }
    return loot.pda.pool(w.project, index);
  };
  /** `who` pays `amount` of `mint`, split by `shares`. */
  w.payIn = (payer, mint, amount, shares = [], extra = {}) =>
    chain.send(payer, [loot.payIx({ player: payer, project: w.project, mint, treasury: w.treasury, amount, shares, ...extra })]);
  /** A decoded account. */
  w.read = (name, address) => chain.account(name, address);
  w.projectState = () => w.read('Project', w.project);
  /** The authority mints one of `itemId` to `owner`; returns the asset. */
  w.make = (itemId, owner, attributes = []) => {
    const asset = newAddress(random);
    chain.send(w.authority, [loot.collectibleIx({ authority: w.authority, project: w.project, collection: w.collection, asset, item: itemId, owner, change: { Make: { attributes } } })]);
    return asset;
  };

  // The project's token: a classic mint the owner controls; the owner's wallet is the treasury, and the player has tokens.
  w.mint = w.newMint(w.creator);
  w.tokenAccount(w.creator, w.mint);
  w.treasury = w.creator;
  w.fund(w.player, w.mint, 100n * PRICE);

  // The owner's Core collection, with the project's address as its update delegate.
  w.collection = newAddress(random);
  w.project = loot.pda.project(w.creator, 0);
  chain.send(w.creator, [createCollectionInstruction({ collection: w.collection, creator: w.creator, name: 'Gecko Zombies', uri: 'https://example.invalid/collection.json', project: w.project, compressed })]);

  if (platform) chain.send(admin, [loot.initPlatformIx({ admin, fees: FEES })]);
  if (platform && project) {
    chain.send(w.creator, [loot.createProjectIx({ owner: w.creator, id: 0, collections: [w.collection], treasury: w.treasury, authority: w.authority })]);
  }
  return w;
}
