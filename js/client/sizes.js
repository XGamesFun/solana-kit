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
// answer, less a margin.
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
  reread: 1_000n,
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
 * Whether all of `opens` opens of `entries` by `slots` fit one oracle answer (`order::draws_fit`), each draw at the
 * dearest its slot could make, with what is known from the box alone (no table rows, a stash of one group), its `odds`,
 * `shares` and `fates` counted, and `bytes` (`boxBytes`) of heap reading the box takes beyond its entries. `slots` may
 * be a number: that many draws among every entry. The answer's heap counts for a box that rolls, or one sold through
 * the oracle (`oracle`: a box that doesn't roll but one `buy` can't carry, `buyFits`). The program refuses a box whose
 * one open doesn't fit at its upsert, and a purchase that doesn't at `open_box`, where it also reads what the accounts
 * hold (`PackTooLarge`).
 */
export function drawsFit(
  entries,
  slots,
  opens = 1,
  { odds = 0, shares = 0, fates = 0, bytes = 0n, oracle = false } = {},
) {
  const given = typeof slots === 'number' || typeof slots === 'bigint' ? [{ count: slots, only: [] }] : (slots ?? []);
  // A box with no slots draws once among every entry.
  const list = given.length ? given : [{ count: 1, only: [] }];
  const draws = list.reduce((n, s) => n + BigInt(s.count), 0n) * BigInt(opens);
  // A box of one draw is held to the same answer: one past it would be refused at every purchase.
  const n = BigInt(entries.length);
  const weigh = COST.weigh + COST.weighEntry * n;
  const reads = entries.map(e => e.prizes.map(accountOf));
  const cost = entries.map(e =>
    e.prizes.reduce(
      (c, p) => {
        if (p.Item != null || p.Compressed || p.Nft)
          return { set: c.set + COST.item, again: c.again + COST.reread, bytes: c.bytes + BYTES.prize };
        if (p.Tokens)
          return {
            set: c.set + COST.tokens,
            again: c.again + (p.Tokens.from.Pool ? COST.reread : 0n),
            bytes: c.bytes + (p.Tokens.from.Pool ? BYTES.pooled : BYTES.minted),
          };
        if (p.Stash != null)
          return { set: c.set + COST.draw + COST.group, again: c.again + COST.reread, bytes: c.bytes + BYTES.prize };
        return { set: c.set + COST.item, again: c.again, bytes: c.bytes + BYTES.prize };
      },
      { set: 0n, again: 0n, bytes: BYTES.draw },
    ),
  );
  const next = entries.map(
    (_, i) =>
      weigh +
      cost[i].set +
      cost.reduce((sum, c, j) => (j === i || reads[i].some(a => a && reads[j].includes(a)) ? sum + c.again : sum), 0n),
  );
  const most = BigInt(Math.max(1, ...entries.map(e => e.prizes.length)));
  let spent =
    COST.fixed +
    COST.pair * n * n * most * most +
    entries.reduce((c, e) => c + (e.prizes.length ? COST.entry : COST.blank), 0n);
  let used =
    BYTES.start +
    BigInt(outgrown(entries.length, ENTRY_BYTES)) +
    BigInt(bytes) +
    BYTES.entryRead * n +
    BYTES.prizeRead * BigInt(entries.reduce((c, e) => c + e.prizes.length, 0));
  let won = 0n;
  spent +=
    (COST.slot + COST.slotEntry * n) * BigInt(Math.max(1, list.length)) +
    COST.openSlot * BigInt(list.length) * BigInt(opens) +
    COST.odds * BigInt(odds) +
    COST.share * BigInt(shares) +
    COST.fate * BigInt(fates);
  for (const s of list) {
    const count = BigInt(s.count) * BigInt(opens);
    const among = entries.map((_, i) => i).filter(i => !(s.only ?? []).length || (s.only ?? []).includes(i));
    const dearest = f => among.reduce((m, i) => (f(i) > m ? f(i) : m), 0n);
    spent += count * dearest(i => next[i]);
    used += count * dearest(i => cost[i].bytes);
    won += count * dearest(i => BigInt(entries[i].prizes.length));
  }
  const rolls = oracle || entries.length > 1 || entries.some(e => e.prizes.some(p => p.Stash != null));
  return (
    spent + COST.finish + COST.won * won + COST.drawn * draws <= ROLL_BUDGET &&
    (!rolls || used + BYTES.finish + BYTES.won * won + draws <= ROLL_HEAP)
  );
}

// What one `buy` takes, as the program counts it at the box's write (`catalog::buy_fits`): a transaction holds 64
// accounts, 64 instructions and 1,400,000 compute units.
const BUY = { accounts: 15, calls: 7, cu: 30_000, most: { accounts: 64, calls: 64, cu: 1_400_000 } };
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
 * The most opens of `lootBox` a client puts in one order: what one oracle answer draws (`drawsFit`), and what keeps the
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
      oracle: true,
    }) && (BigInt(orderBytes(lootBox, shares, n, items)) + 128n) * rentPerByte + PLAYER_FEE <= ORDER_COST_CAP;
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
