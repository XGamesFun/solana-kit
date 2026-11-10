// Rent sizes from the current IDL. Fixed allocations reserve the largest enum and option forms,
// matching Anchor InitSpace. Dynamic records use their actual encoded fields.
import { addressBytes } from '../chain/base58.js';
import { encodeAccount, encodeBorsh } from '../chain/borsh.js';
import { uintLE, utf8 } from '../chain/bytes.js';
import IDL from './idl/loot.js';
import { lootAddress } from './pda.js';

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
  const definition = IDL.types.find(entry => entry.name === name)?.type;
  if (!definition) throw new Error(`Missing current IDL type ${name}`);
  const fields = list =>
    (list ?? []).reduce((n, field) => n + maximum(field.type ?? field, `${name}.${field.name ?? ''}`), 0);
  return definition.kind === 'enum'
    ? 1 + Math.max(...definition.variants.map(variant => fields(variant.fields)))
    : fields(definition.fields);
}

/** The space reserved by a fixed-size account, including its discriminator. */
export function allocationBytes(name) {
  const account = IDL.accounts.find(entry => entry.name === name);
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
  for (const prize of entries.flatMap(e => e.prizes)) {
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
export const tableBudget = entries => MAX_CALLBACK_ACCOUNTS - callbackAccounts(entries);

const draws = lootBox => (lootBox.slots?.length ? lootBox.slots.reduce((n, s) => n + Number(s.count), 0) : 1);
const ZERO = '11111111111111111111111111111111';

/** The most an order can be (`MAX_ORDER_BYTES`, not in the IDL): a box whose one open's order would be more is refused
 * at its upsert (`BadEntries`). In practice a pack is bounded first by what one oracle answer draws (`drawsFit`). */
export const MAX_ORDER_BYTES = 10_240;

/** The bytes a draw sets aside for a prize, as the `Won` it becomes (`Order::sized`): an item 14, tokens or an NFT 41,
 * a roll, a held NFT or a raffled place nothing. */
const wonBytes = p => (p.Item || p.Compressed ? 14 : p.Tokens || p.Nft || p.Stash ? 41 : 0);
const tableCount = item => (item?.traits ?? []).filter(t => t.from?.Table).length;

/**
 * The rows of fresh items' tables a draw of each entry writes into its order (`order::rows_of`), walked with the box's
 * table budget as the roll's accounts are (`entryAccounts`: an item whose tables don't fit what is left draws none).
 * `items` maps an item's id to its decoded Item; one left out is taken as not fresh.
 */
export function entryRows(entries, items = {}) {
  let budget = Math.max(0, tableBudget(entries));
  return entries.map(({ prizes }) =>
    prizes.reduce((n, p) => {
      const id = p.Item?.[0] ?? p.Compressed?.item;
      const t = id === undefined ? 0 : tableCount(items[id]);
      if (t > budget) return n;
      budget -= t;
      return n + t;
    }, 0),
  );
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
  const aDraw = Math.max(0, ...lootBox.entries.map(e => e.prizes.reduce((n, p) => n + wonBytes(p), 0)));
  const gives = lootBox.entries.some(e => e.prizes.some(p => p.Item || p.Compressed));
  const rows = items
    ? Math.max(0, ...entryRows(lootBox.entries, items))
    : gives
      ? Math.max(0, tableBudget(lootBox.entries))
      : 0;
  const fates = lootBox.fates ?? [];
  const fate = fates.reduce(
    (a, f) =>
      a &&
      encodeBorsh(IDL, { defined: { name: 'Fate' } }, a).length >=
        encodeBorsh(IDL, { defined: { name: 'Fate' } }, f).length
        ? a
        : f,
    null,
  );
  const empty = {
    project: ZERO,
    player: ZERO,
    mint: ZERO,
    loot_box: ZERO,
    box_version: 0,
    odds_bps: new Array(lootBox.odds?.length ?? 0).fill(0),
    status: 'Waiting',
    won: [],
    paid: 0n,
    fee: 0n,
    shares: new Array(shares).fill({ to: { Account: [ZERO] }, bps: 0 }),
    opens: 0,
    settled: 0,
    undrawn: 0,
    back: 0n,
    settler: ZERO,
    drew: 0,
    answer: new Uint8Array(32),
    drawn: [],
    reserved: 0n,
    requested_slot: 0n,
    asked_first: 0n,
    asked_at: 0n,
    first_asked_at: 0n,
    counted: 0,
    subject: lootBox.subject ? ZERO : null,
    held: false,
    fate,
  };
  return encodeAccount(IDL, 'Order', empty).length + drawn * (aDraw + rows * 4);
}

// What one oracle answer's roll spends, counted at no less than each part costs (`order.rs`'s `RollCost`, measured by
// the program's `tests/roll_costs.rs` and `tests/roll_heap.rs`), against the compute and the heap the oracle gives its
// answer, less a margin. Every number of the program's count is here, and only here: a change of one is one edit.
const ROLL_BUDGET = 300_000n;
const ROLL_HEAP = 32n * 1024n - 512n;
const COST = {
  fixed: 20_000n,
  entry: 3_500n,
  blank: 1_400n,
  weigh: 1_000n,
  weighEntry: 40n,
  pair: 150n,
  item: 1_500n,
  tokens: 6_000n,
  draw: 9_000n,
  group: 250n,
  row: 10n,
  // One try of an address search, what the runtime charges (`COST_TRY`).
  try: 1_500n,
  // Reading a prize of an entry after its first (`COST_PRIZE`).
  prize: 300n,
  reread: 1_000n,
  // A draw of an entry that gives nothing, beyond its weighing (`COST_NOTHING`).
  nothing: 1_100n,
  finish: 15_000n,
  won: 150n,
  drawn: 50n,
  odds: 1_000n,
  share: 1_000n,
  fate: 1_000n,
  slot: 500n,
  slotEntry: 350n,
  openSlot: 150n,
};
/** The most draws one `open_box` takes in all, its count times the box's draws: what one answer could weigh, each draw
 * at its weighing at least (`ROLL_BUDGET / COST_WEIGH`, 300). More is refused before any price is added up
 * (`PackTooLarge`). */
export const MOST_DRAWS_A_PURCHASE = Number(ROLL_BUDGET / COST.weigh);
/** The compute one transaction has, and what adding up one sale's price costs at most (`catalog.rs` `COST_SALE`). */
const MAX_TX_CU = 1_400_000;
const COST_SALE = 50;
/** The most sales one `buy` takes (`count`): what one transaction can price (`MAX_TX_CU / COST_SALE`, 28,000). More is
 * refused before any price is added up (`PackTooLarge`). */
export const MOST_SALES_A_BUY = MAX_TX_CU / COST_SALE;
/**
 * The tries counted for finding a pool's or a stash's address when the project is not known yet (a spec checked before
 * any wallet is named): 2, what an address takes on average (half are found at the first try, a quarter at the second,
 * and so on). With the project known, the count is exact: `256 - bump` tries an address.
 */
export const ASSUMED_TRIES = 2;
const BYTES = {
  start: 6_000n,
  prizeRead: 600n,
  entryRead: 180n,
  minted: 700n,
  pooled: 1_000n,
  prize: 200n,
  draw: 40n,
  finish: 2_000n,
  won: 120n,
  boxByte: 2n,
  gateByte: 3n,
  odds: 100n,
  fate: 60n,
  slot: 64n,
};

/** The Borsh length of `value` as IDL type `type`, an address counted as 32 bytes whatever stands in for it (a spec's
 * `@mint:…` before it goes live). */
function borshLength(type, value) {
  if (typeof type === 'string')
    return type === 'string'
      ? 4 + new TextEncoder().encode(String(value)).length
      : type === 'bytes'
        ? 4 + value.length
        : scalar[type];
  if (type.array) return type.array[1] * (type.array[0] === 'u8' ? 1 : borshLength(type.array[0], value?.[0]));
  if (type.vec) return 4 + (value ?? []).reduce((n, v) => n + borshLength(type.vec, v), 0);
  if (type.option) return value == null ? 1 : 1 + borshLength(type.option, value);
  const definition = IDL.types.find(entry => entry.name === type.defined.name).type;
  if (definition.kind === 'enum') {
    const name = typeof value === 'string' ? value : Object.keys(value)[0];
    const fields = definition.variants.find(v => v.name === name)?.fields ?? [];
    const payload = typeof value === 'string' ? [] : value[name];
    return (
      1 +
      fields.reduce(
        (n, f, i) =>
          n +
          (typeof f === 'object' && 'name' in f ? borshLength(f.type, payload[f.name]) : borshLength(f, payload[i])),
        0,
      )
    );
  }
  return definition.fields.reduce((n, f) => n + borshLength(f.type, value[f.name]), 0);
}

const defined = name => ({ defined: { name } });

/** The heap reading a list of `n` values of `size` bytes takes (`order::list_bytes`): Borsh makes room for as many as
 * 4,096 bytes hold, then doubles it each time it fills, and every room it outgrew stays used beside the last. */
function listBytes(n, size) {
  if (n * size <= 4096) return n * size;
  let room = Math.min(Math.max(1, Math.floor(4096 / size)), n);
  let rooms = room;
  while (room < n) {
    room *= 2;
    rooms += room;
  }
  return rooms * size;
}
/** What `listBytes` takes beyond the `n` values themselves (`order::outgrown`). */
const outgrown = (n, size) => listBytes(n, size) - n * size;
/** The bytes a program `String` and a `DropEntry` take in memory, and an address. */
const STRING_BYTES = 24;
const ENTRY_BYTES = 32;
const ADDRESS_BYTES = 32;
/** The heap a rule's "one of" list of texts takes, read whole. */
const textsBytes = rule => (rule?.test?.OneOf ? listBytes(rule.test.OneOf.texts.length, STRING_BYTES) : 0);

/**
 * The heap reading a box takes beyond its entries (`order::box_bytes`): its odds, gate, shares, subject, slots and
 * fates, read whole with it, by their bytes and their number. `box`: the box's args, as `upsertBoxIx` takes them.
 */
export function boxBytes({ odds = [], gate = null, shares = [], subject = null, slots = [], fates = [] }) {
  const slotsWritten = slots.map(s => ({ only: [], distinct: false, share: 0, ...s }));
  const fatesWritten = fates.map(f => ({
    then: null,
    ...f,
    shifts: (f.shifts ?? []).map(x => ({ from_now: false, ...x })),
  }));
  const bytes =
    borshLength({ vec: defined('Odds') }, odds) +
    borshLength({ vec: defined('Share') }, shares) +
    borshLength({ option: defined('Rule') }, subject) +
    borshLength({ vec: defined('Slot') }, slotsWritten) +
    borshLength({ vec: defined('Fate') }, fatesWritten);
  // Each "one of" list of texts (a gate's rule, each odds rule, the subject), read whole; a gate's wallets' room past
  // what they fill.
  const rules =
    (gate?.Holds ? textsBytes(gate.Holds[0]) : 0) +
    odds.reduce((n, o) => n + textsBytes(o.boost?.rule), 0) +
    textsBytes(subject) +
    (gate?.Wallets ? outgrown(gate.Wallets[0].length, ADDRESS_BYTES) : 0);
  return (
    BYTES.boxByte * BigInt(bytes) +
    BYTES.gateByte * BigInt(borshLength({ option: defined('Gate') }, gate)) +
    BYTES.odds * BigInt(odds.length) +
    BYTES.fate * BigInt(fates.length) +
    BYTES.slot * BigInt(slots.length) +
    BigInt(rules)
  );
}

/** The account a prize reads, as a string, when it reads one the box can name: entries naming the same share it. */
const accountOf = p => {
  if (p.Item != null) return `item ${p.Item[0] ?? p.Item}`;
  if (p.Compressed) return `item ${p.Compressed.item}`;
  if (p.Tokens?.from?.Pool) return `pool ${p.Tokens.from.Pool[0] ?? p.Tokens.from.Pool}`;
  if (p.Stash != null) return `stash ${p.Stash[0] ?? p.Stash}`;
  if (p.Nft) return `stash ${p.Nft.stash}`;
  return null;
};

/**
 * The tries finding a pool's (`pool` true) or a stash's address takes (`order::searched`: `256 - bump`), for `project`'s
 * pool or stash `id`. With no project, `ASSUMED_TRIES`.
 */
export function searchTries(project, pool, id) {
  if (!project) return ASSUMED_TRIES;
  const [, bump] = pool ? lootAddress(pdaSeeds.pool(project, id)) : lootAddress(pdaSeeds.stash(project, id));
  return 256 - bump;
}
const pdaSeeds = {
  pool: (project, index) => [utf8('pool'), addressBytes(project), uintLE(index, 2)],
  stash: (project, id) => [utf8('stash'), addressBytes(project), uintLE(id, 4)],
};

/**
 * What a roll of `entries` spends, as the program's `RollCost::new` counts it from the box alone (no table rows, a
 * stash of one group, a named NFT's stash of one row): `fixed` (reading the box, every entry's accounts, finding each
 * pool's and stash's address), each entry's draw (`prizes`), its stock read again (`reread`), the prizes it gives, its
 * heap, and the heap reading the box leaves used (`start`, the box's own `bytes` included). `project`: whose pools and
 * stashes these are, to count each search exactly; without it, at `ASSUMED_TRIES` tries an address.
 */
function rollCost(entries, { odds = 0, shares = 0, fates = 0, bytes = 0n, project = null }) {
  const n = BigInt(entries.length);
  // Each address is found by what finding it takes, once a prize names it (`draws_fit`'s `reads`): what a search cost is
  // kept by the address's kind and id; once past the answer's budget nothing more is searched for (the box is refused).
  const found = new Map();
  let searched = 0n;
  const reading = p => {
    const pool = p.Tokens?.from?.Pool;
    const stash = p.Stash ?? p.Nft?.stash;
    if (pool == null && stash == null) return 0n;
    const key = pool != null ? `pool ${pool[0] ?? pool}` : `stash ${stash[0] ?? stash}`;
    let cost = found.get(key);
    if (cost === undefined) {
      if (searched > ROLL_BUDGET) cost = 0n;
      else {
        const id = Number(pool != null ? (pool[0] ?? pool) : (stash[0] ?? stash));
        cost = COST.try * BigInt(searchTries(project, pool != null, id));
        found.set(key, cost);
      }
    }
    searched += cost;
    return cost;
  };
  let fixed = COST.fixed + COST.odds * BigInt(odds) + COST.share * BigInt(shares) + COST.fate * BigInt(fates);
  let start = BYTES.start + BigInt(outgrown(entries.length, ENTRY_BYTES)) + BigInt(bytes);
  const prizes = [];
  const reread = [];
  const heap = [];
  for (const e of entries) {
    let [set, again, used] = [0n, 0n, BYTES.draw];
    fixed += e.prizes.length ? COST.entry : COST.blank;
    start += BYTES.entryRead;
    e.prizes.forEach((p, k) => {
      fixed += reading(p) + (k > 0 ? COST.prize : 0n);
      start += BYTES.prizeRead;
      if (p.Item != null || p.Compressed) [set, again] = [set + COST.item, again + COST.reread];
      else if (p.Tokens) [set, again] = [set + COST.tokens, again + (p.Tokens.from.Pool ? COST.reread : 0n)];
      else if (p.Stash != null) [set, again] = [set + COST.draw + COST.group, again + COST.reread];
      else if (p.Nft) {
        // A named NFT is searched for row by row: when its stock is read, again, and when it is taken (one row here).
        fixed += COST.row;
        [set, again] = [set + COST.item + COST.row, again + COST.reread + COST.row];
      } else set += COST.item;
      used += p.Tokens ? (p.Tokens.from.Pool ? BYTES.pooled : BYTES.minted) : BYTES.prize;
    });
    // A draw that gives nothing still draws, and keeps its draw's lists.
    prizes.push(e.prizes.length ? set : COST.nothing);
    reread.push(again);
    heap.push(used);
  }
  const weigh = COST.weigh + COST.weighEntry * n;
  const most = BigInt(Math.max(1, ...entries.map(e => e.prizes.length)));
  return { fixed, start, weigh, prizes, reread, heap, knowing: COST.pair * n * n * most * most };
}

/** The entries whose stock a draw of entry `i` reads again: itself, and each naming an account it names. */
const sharing = (entries, i) => {
  const reads = entries.map(e => e.prizes.map(accountOf));
  return entries.map((_, j) => j).filter(j => j === i || reads[i].some(a => a && reads[j].includes(a)));
};

/**
 * Whether `opens` opens by `list` (slots, never empty) fit one answer (`RollCost::fits`): each draw at the dearest its
 * slot could make, which entries share accounts found first when there are several draws. `next`: each entry's draw.
 * `heap`: the answer's heap counts too.
 */
function fitsOne(cost, entries, list, opens, next, heap) {
  const n = BigInt(entries.length);
  const draws = list.reduce((d, s) => d + BigInt(s.count), 0n) * BigInt(opens);
  let spent =
    cost.fixed +
    (COST.slot + COST.slotEntry * n) * BigInt(list.length) +
    COST.openSlot * BigInt(list.length) * BigInt(opens) +
    (draws > 1n ? cost.knowing : 0n);
  let used = cost.start;
  let won = 0n;
  for (const s of list) {
    const count = BigInt(s.count) * BigInt(opens);
    const among = entries.map((_, i) => i).filter(i => !(s.only ?? []).length || (s.only ?? []).includes(i));
    const dearest = f => among.reduce((m, i) => (f(i) > m ? f(i) : m), 0n);
    spent += count * dearest(i => next[i]);
    used += count * dearest(i => cost.heap[i]);
    won += count * dearest(i => BigInt(entries[i].prizes.length));
  }
  return (
    spent + COST.finish + COST.won * won + COST.drawn * draws <= ROLL_BUDGET &&
    (!heap || used + BYTES.finish + BYTES.won * won + draws <= ROLL_HEAP)
  );
}

/**
 * Whether all of `opens` opens of `entries` by `slots` fit one oracle answer (`order::draws_fit`), each draw at the
 * dearest its slot could make, with what is known from the box alone (no table rows, a stash of one group, a named
 * NFT's stash of one row), its `odds`, `shares` and `fates` counted, and `bytes` (`boxBytes`) of heap reading the box
 * takes beyond its entries. `slots` may be a number: that many draws among every entry. The answer's heap counts for a
 * box that rolls, or one sold through the oracle (`oracle`: a box that doesn't roll but one `buy` can't carry,
 * `buyFits`). `project`: the project the box is in, whose pools' and stashes' addresses the write searches for (each
 * search counted at `256 - bump` tries of 1,500 units); without it, at `ASSUMED_TRIES` tries an address. The program
 * refuses a box whose one open doesn't fit at its upsert (`PackTooLarge`). `purchase`: counted as `open_box` counts a
 * purchase of `opens` instead (the answer's heap always; a draw's own stock read again only when there are several; at
 * most `MOST_DRAWS_A_PURCHASE` draws in all), from what the box alone tells: the program reads the accounts too.
 */
export function drawsFit(
  entries,
  slots,
  opens = 1,
  { odds = 0, shares = 0, fates = 0, bytes = 0n, oracle = false, project = null, purchase = false } = {},
) {
  const given = typeof slots === 'number' || typeof slots === 'bigint' ? [{ count: slots, only: [] }] : (slots ?? []);
  // A box with no slots draws once among every entry.
  const list = given.length ? given : [{ count: 1, only: [] }];
  const draws = list.reduce((d, s) => d + BigInt(s.count), 0n) * BigInt(opens);
  if (purchase && draws > BigInt(MOST_DRAWS_A_PURCHASE)) return false;
  const cost = rollCost(entries, { odds, shares, fates, bytes, project });
  const heap = purchase || oracle || entries.length > 1 || entries.some(e => e.prizes.some(p => p.Stash != null));
  // Reading the box alone already past the answer: refused before its entries are compared.
  if (cost.fixed > ROLL_BUDGET || (heap && cost.start > ROLL_HEAP)) return false;
  // Each entry's draw reads again the stock of the entries sharing its accounts; a purchase of one draw, its own alone.
  const again = i => (purchase && draws <= 1n ? [] : sharing(entries, i)).reduce((s, j) => s + cost.reread[j], 0n);
  const next = entries.map((_, i) => cost.weigh + cost.prizes[i] + again(i));
  return fitsOne(cost, entries, list, opens, next, heap);
}

// What one `buy` takes, as the program counts it at the box's write (`catalog::buy_fits`): a transaction holds 64
// accounts, 64 instructions and 1,400,000 compute units.
const BUY = { accounts: 15, calls: 7, cu: 30_000, most: { accounts: 64, calls: 64, cu: MAX_TX_CU } };
const sameJson = (a, b) =>
  JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? String(v) : v)) ===
  JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? String(v) : v));

/**
 * Whether one `buy` of a box that doesn't roll (one entry, given `draws` times: its slots' counts) fits one transaction
 * (`catalog::buy_fits`): its accounts, its instructions and its compute, each prize's at the most it takes. A named NFT
 * is given once at most. A box that doesn't fit sells through the oracle (`open_box`), its answer's heap counted
 * (`drawsFit` with `oracle`), and can't give a roll (`PackTooLarge`). `box`: the box's args.
 */
export function buyFits(box, draws = box.slots?.length ? box.slots.reduce((n, s) => n + Number(s.count), 0) : 1) {
  const entry = box.entries?.[0];
  if (!entry) return true;
  let { accounts, calls, cu } = BUY;
  for (const share of box.shares ?? []) {
    const to = typeof share.to === 'string' ? share.to : Object.keys(share.to)[0];
    const [a, c] =
      to === 'Burn' ? [0, 1] : to === 'Pool' || to === 'Account' ? [1, 1] : to === 'Holder' ? [3, 6] : [2, 6];
    accounts += a;
    calls += c;
    cu += 30_000;
  }
  const gate = box.gate ? Object.keys(box.gate)[0] : null;
  accounts += gate === 'List' ? Number(box.gate.List.depth) : gate === 'Staked' ? 2 : gate === 'Holds' ? 5 : 0;
  const limit = box.per_wallet ?? {};
  if (Number(limit.total ?? 0) > 0 || Number(limit.per_window ?? 0) > 0) calls += 1;
  // A collectible's collection and Metaplex Core, named once for all of them.
  if (entry.prizes.some(p => p.Item != null)) accounts += 2;
  for (const [i, p] of entry.prizes.entries()) {
    const first = !entry.prizes
      .slice(0, i)
      .some(q => (accountOf(q) && accountOf(q) === accountOf(p)) || sameJson(q, p));
    const gives = p.Tokens ? 1 : draws;
    let once = 0,
      each = 0,
      c = 0,
      units = 0;
    if (p.Tokens) [once, c, units] = [p.Tokens.from.Pool ? 3 : 2, 5, 30_000];
    else if (p.Item != null) [once, each, c, units] = [1, 1, 4, 40_000];
    else if (p.Compressed) [once, c, units] = [9, 6, 150_000];
    else if (p.Roll != null) [once, each, c, units] = [1, 1, 1, 20_000];
    else if (p.Nft) {
      if (draws > 1) return false;
      [once, c, units] = [8, 6, 60_000];
    }
    accounts += (first ? once : 0) + each * gives;
    calls += c * gives;
    cu += units * gives;
  }
  return accounts <= BUY.most.accounts && calls <= BUY.most.calls && cu <= BUY.most.cu;
}

/** The most program rent and fee one order takes from its player, in lamports (0.01 SOL): a client cap (`opensAnOrder`). */
export const ORDER_COST_CAP = 10_000_000n;
/** Rent a byte, as devnet and mainnet-beta charge it ((bytes + 128) × 5,080 lamports). */
const RENT_PER_BYTE = 5_080n;
/** The player's fee for one order (`fee::PLAYER_FEE`, 0.002 SOL). */
const PLAYER_FEE = 2_000_000n;

/**
 * The most opens of `lootBox` a client puts in one order: what one oracle answer draws (`drawsFit` as a purchase counts
 * it, the box's project's searches counted when the box names it: a box read from the chain does), and what keeps the
 * order's rent and the player's fee within `ORDER_COST_CAP` (`orderBytes` with `items`, so with the box's shares). At
 * least one: a box whose one open is over the cap is still bought one open an order. A purchase of more is several
 * orders, each its own answer.
 */
export function opensAnOrder(
  lootBox,
  { shares = (lootBox.shares ?? []).length, items = {}, rentPerByte = RENT_PER_BYTE } = {},
) {
  const fits = n =>
    drawsFit(lootBox.entries, lootBox.slots?.length ? lootBox.slots : 1, n, {
      odds: (lootBox.odds ?? []).length,
      shares,
      fates: (lootBox.fates ?? []).length,
      bytes: boxBytes(lootBox),
      project: lootBox.project ?? null,
      purchase: true,
    }) && (BigInt(orderBytes(lootBox, shares, n, items)) + 128n) * rentPerByte + PLAYER_FEE <= ORDER_COST_CAP;
  let n = 1;
  while (n < MOST_DRAWS_A_PURCHASE && fits(n + 1)) n += 1;
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
