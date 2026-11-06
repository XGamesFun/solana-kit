// Rent sizes from the current IDL. Fixed allocations reserve the largest enum and option forms,
// matching Anchor InitSpace. Dynamic records use their actual encoded fields.
import { encodeAccount, encodeBorsh } from '../chain/borsh.js';
import IDL from './idl/loot.js';

const scalar = { bool: 1, u8: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 };
// What a fixed-size account reserves for its lists and strings: a roll's fate (`Fate.shifts`, each key at most 32 bytes).
const bounds = { 'Fate.shifts': 2 };
const strings = { 'Shift.key': 32 };
function maximum(type, path) {
  if (type === 'string') {
    if (!(path in strings)) throw new Error(`No allocation bound for ${path}`);
    return 4 + strings[path];
  }
  if (typeof type === 'string') {
    if (!(type in scalar)) throw new Error(`Unbounded IDL type ${path}: ${type}`);
    return scalar[type];
  }
  if (type.array) return type.array[1] * maximum(type.array[0], path);
  if (type.option) return 1 + maximum(type.option, path);
  if (type.vec) {
    if (!(path in bounds)) throw new Error(`No allocation bound for ${path}`);
    return 4 + bounds[path] * maximum(type.vec, path);
  }
  const name = type.defined.name;
  const definition = IDL.types.find((entry) => entry.name === name)?.type;
  if (!definition) throw new Error(`Missing current IDL type ${name}`);
  const fields = (list) => (list ?? []).reduce((n, field) => n + maximum(field.type ?? field, `${name}.${field.name ?? ''}`), 0);
  return definition.kind === 'enum' ? 1 + Math.max(...definition.variants.map((variant) => fields(variant.fields))) : fields(definition.fields);
}

/** The space reserved by a fixed-size account, including its discriminator. */
export function allocationBytes(name) {
  const account = IDL.accounts.find((entry) => entry.name === name);
  if (!account) throw new Error(`Missing current IDL account ${name}`);
  return account.discriminator.length + maximum({ defined: { name } }, name);
}

/** The exact bytes of a dynamically allocated account. */
export const accountBytes = (name, value) => encodeAccount(IDL, name, value).length;
/** A seat; a loan's hold (with room for its debt); a hold a player asks for, made without one (`Hold::PLAIN`). */
export const ACCOUNT_BYTES = Object.freeze({
  Seat: allocationBytes('Seat'),
  Loan: allocationBytes('Hold'),
  Hold: allocationBytes('Hold') - maximum({ defined: { name: 'Debt' } }, 'Debt'),
});

/** A project's bytes with `collections` collections, as the program sizes the account. */
export const projectBytes = (collections = 0) => 153 + 32 * collections;

/** The most accounts the oracle's answer to a roll carries (`MAX_CALLBACK_ACCOUNTS`). */
export const MAX_CALLBACK_ACCOUNTS = 21;

/**
 * The most accounts a roll of `entries` hands the oracle (`catalog::callback_accounts`): the order, the box and the
 * ticket; one for each prize that needs one at the roll (an item, a pool, a stash); and with tokens, the two token
 * programs, the project, and a mint and a vault for each source of tokens.
 */
export function callbackAccounts(entries) {
  const sources = new Set();
  let named = 0;
  for (const prize of entries.flatMap((e) => e.prizes)) {
    if (prize.Item || prize.Compressed || prize.Nft || prize.Stash) named += 1;
    else if (prize.Tokens) {
      if (prize.Tokens.from.Pool) named += 1;
      sources.add(JSON.stringify(prize.Tokens.from));
    }
  }
  return 3 + named + (sources.size ? 3 + 2 * sources.size : 0);
}

/**
 * How many fresh items' table accounts the oracle's answer to a roll of `entries` can carry (`order::table_budget`):
 * what the box's own accounts leave of `MAX_CALLBACK_ACCOUNTS`. Negative: the box can't be rolled at all.
 */
export const tableBudget = (entries) => MAX_CALLBACK_ACCOUNTS - callbackAccounts(entries);

const draws = (lootBox) => (lootBox.slots?.length ? lootBox.slots.reduce((n, s) => n + Number(s.count), 0) : 1);
const ZERO = '11111111111111111111111111111111';

/** The most an order can be (`MAX_ORDER_BYTES`, not in the IDL): a box whose one open's order would be more is refused
 * at its upsert (`BadEntries`). In practice a pack is bounded first by what one oracle answer draws (`drawsFit`). */
export const MAX_ORDER_BYTES = 10_240;

/** The bytes a draw sets aside for a prize, as the `Won` it becomes (`Order::sized`): an item 14, tokens or an NFT 41,
 * a roll, a held NFT or a raffled place nothing. */
const wonBytes = (p) => (p.Item || p.Compressed ? 14 : p.Tokens || p.Nft || p.Stash ? 41 : 0);
const tableCount = (item) => (item?.traits ?? []).filter((t) => t.from?.Table).length;

/**
 * The rows of fresh items' tables a draw of each entry writes into its order (`order::rows_of`), walked with the box's
 * table budget as the roll's accounts are (`entryAccounts`: an item whose tables don't fit what is left draws none).
 * `items` maps an item's id to its decoded Item; one left out is taken as not fresh.
 */
export function entryRows(entries, items = {}) {
  let budget = Math.max(0, tableBudget(entries));
  return entries.map(({ prizes }) => prizes.reduce((n, p) => {
    const id = p.Item?.[0] ?? p.Compressed?.item;
    const t = id === undefined ? 0 : tableCount(items[id]);
    if (t > budget) return n;
    budget -= t;
    return n + t;
  }, 0));
}

/**
 * The bytes of an order of `lootBox` with `shares` shares and `opens` opens. With `items` (an item's id to its decoded
 * Item), as `open_box` sizes it (`Order::sized`): each draw at its dearest entry's prizes as the `Won` they become (an
 * item 14 bytes, tokens or an NFT 41, a roll none) and 4 bytes for each table row its fresh items draw now
 * (`entryRows`); its odds and its largest fate. Without `items`, as a roll made inside another call sizes it (a craft,
 * a grant's claim, a mission, a roll lot: `Order::space_for`): the box's whole table budget a draw for a box that
 * gives items. A pack's order grows with its cards.
 */
export function orderBytes(lootBox, shares = 0, opens = 1, items) {
  const drawn = draws(lootBox) * Math.max(1, opens);
  const aDraw = Math.max(0, ...lootBox.entries.map((e) => e.prizes.reduce((n, p) => n + wonBytes(p), 0)));
  const gives = lootBox.entries.some((e) => e.prizes.some((p) => p.Item || p.Compressed));
  const rows = items ? Math.max(0, ...entryRows(lootBox.entries, items)) : gives ? Math.max(0, tableBudget(lootBox.entries)) : 0;
  const fates = lootBox.fates ?? [];
  const fate = fates.reduce((a, f) => (a && encodeBorsh(IDL, { defined: { name: 'Fate' } }, a).length >= encodeBorsh(IDL, { defined: { name: 'Fate' } }, f).length ? a : f), null);
  const empty = {
    project: ZERO, player: ZERO, mint: ZERO, loot_box: ZERO, box_version: 0,
    odds_bps: new Array(lootBox.odds?.length ?? 0).fill(0),
    status: 'Waiting',
    won: [],
    paid: 0n, fee: 0n,
    shares: new Array(shares).fill({ to: { Account: [ZERO] }, bps: 0 }),
    opens: 0, settled: 0, undrawn: 0, drew: 0, answer: new Uint8Array(32), drawn: [],
    requested_slot: 0n, asked_first: 0n, counted: 0, subject: lootBox.subject ? ZERO : null, held: false, fate,
  };
  return encodeAccount(IDL, 'Order', empty).length + drawn * (aDraw + rows * 4);
}

// What one oracle answer's roll spends, counted at no less than each part costs (`order.rs`'s `COST_*`, measured by
// the program's `tests/roll_costs.rs`), against the compute the oracle gives its answer, less a margin.
const ROLL_BUDGET = 270_000n;
const COST = { fixed: 20_000n, entry: 3_500n, weigh: 1_000n, weighEntry: 40n, pair: 150n, item: 1_500n, tokens: 6_000n, draw: 6_000n, group: 250n, reread: 1_000n, finish: 15_000n, won: 150n, drawn: 50n };

/**
 * Whether `draws` draws among `entries` (a pack's: each open's draws times the opens bought together) fit one oracle
 * answer (`order::draws_fit`): each at the least it could cost (no table rows, a stash of one group), with the pairs
 * of entries a roll of several draws compares first. The program refuses a box whose one open doesn't fit at its
 * upsert, and a purchase of several opens that don't at `open_box` (`PackTooLarge`).
 */
export function drawsFit(entries, draws) {
  const d = BigInt(draws);
  if (d <= 1n) return true;
  const n = BigInt(entries.length);
  const most = BigInt(Math.max(1, ...entries.map((e) => Math.max(1, e.prizes.length))));
  const least = (e) => e.prizes.reduce((c, p) => {
    if (p.Item || p.Compressed || p.Nft) return c + COST.item + COST.reread;
    if (p.Tokens) return c + COST.tokens + (p.Tokens.from.Pool ? COST.reread : 0n);
    if (p.Stash) return c + COST.draw + COST.group + COST.reread;
    return c + COST.item;
  }, 0n);
  const [draw, won] = entries.length ? entries.map((e) => [least(e), BigInt(e.prizes.length)]).reduce((a, b) => (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? b : a)) : [0n, 0n];
  const weigh = COST.weigh + COST.weighEntry * n;
  const fixed = COST.fixed + COST.entry * n + COST.pair * n * n * most * most;
  return fixed + d * (weigh + draw + COST.won * won + COST.drawn) + COST.finish <= ROLL_BUDGET;
}

/** The most program rent and fee one order takes from its player, in lamports (0.01 SOL): a client cap (`opensAnOrder`). */
export const ORDER_COST_CAP = 10_000_000n;
/** Rent a byte, as devnet and mainnet-beta charge it ((bytes + 128) × 5,080 lamports). */
const RENT_PER_BYTE = 5_080n;
/** The player's fee for one order (`fee::PLAYER_FEE`, 0.002 SOL). */
const PLAYER_FEE = 2_000_000n;

/**
 * The most opens of `lootBox` a client puts in one order: what one oracle answer draws (`drawsFit`), and what keeps the
 * order's rent and the player's fee within `ORDER_COST_CAP` (`orderBytes` with `items`, so with the box's shares). At
 * least one: a box whose one open is over the cap is still bought one open an order. A purchase of more is several
 * orders, each its own answer.
 */
export function opensAnOrder(lootBox, { shares = (lootBox.shares ?? []).length, items = {}, rentPerByte = RENT_PER_BYTE } = {}) {
  const fits = (n) => drawsFit(lootBox.entries, draws(lootBox) * n) && (BigInt(orderBytes(lootBox, shares, n, items)) + 128n) * rentPerByte + PLAYER_FEE <= ORDER_COST_CAP;
  let n = 1;
  while (n < 4096 && fits(n + 1)) n += 1;
  return n;
}

// Lists of records (tag 26, `list.rs`): a tag byte and a 6-byte header, then fixed-width records.
export const LIST_HEAD_BYTES = 7;
/** A limit record (a wallet's count of a box, a recipe or a lottery round; a grant's claim count): key, count, window, in it. */
export const LIMIT_RECORD_BYTES = 28;
/** A round a grant paid a wallet: its key alone. */
export const ROUND_RECORD_BYTES = 16;
/** A contest's entry: of tokens, and of NFTs (the NFT, its place on its side, the picks taken). */
export const CONTEST_ENTRY_BYTES = Object.freeze({ tokens: 43, nfts: 83 });
