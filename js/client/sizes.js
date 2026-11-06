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
 * at its upsert (`BadEntries`): about 243 one-prize draws of tokens or NFTs, 91 of a box of one item entry. */
export const MAX_ORDER_BYTES = 10_240;

/**
 * The bytes of an order of `lootBox` with `shares` shares and `opens` opens, as the program sizes it at the purchase
 * (`Order::space_for`): the largest order it can be, every prize its draws can set aside the largest kind of `Won`,
 * its odds, and its largest fate; and for a box that gives items, 4 bytes for each table row a draw may carry (the
 * box's table budget, `tableBudget`, for each draw of each open). A pack's order grows with its cards.
 */
export function orderBytes(lootBox, shares = 0, opens = 1) {
  const most = Math.max(0, ...lootBox.entries.map((e) => e.prizes.length));
  const drawn = draws(lootBox) * Math.max(1, opens);
  const won = most * drawn;
  const items = lootBox.entries.some((e) => e.prizes.some((p) => p.Item || p.Compressed));
  const rows = items ? Math.max(0, tableBudget(lootBox.entries)) : 0;
  const fates = lootBox.fates ?? [];
  const fate = fates.reduce((a, f) => (a && encodeBorsh(IDL, { defined: { name: 'Fate' } }, a).length >= encodeBorsh(IDL, { defined: { name: 'Fate' } }, f).length ? a : f), null);
  const largest = {
    project: ZERO, player: ZERO, mint: ZERO, loot_box: ZERO, box_version: 0,
    odds_bps: new Array(lootBox.odds?.length ?? 0).fill(0),
    status: 'Waiting',
    won: new Array(won).fill({ Tokens: { mint: ZERO, amount: 0n } }),
    paid: 0n, fee: 0n,
    shares: new Array(shares).fill({ to: { Account: [ZERO] }, bps: 0 }),
    opens: 0, settled: 0, undrawn: 0, drew: 0, answer: new Uint8Array(32), drawn: [],
    requested_slot: 0n, asked_first: 0n, counted: 0, subject: lootBox.subject ? ZERO : null, held: false, fate,
  };
  return encodeAccount(IDL, 'Order', largest).length + drawn * rows * 4;
}

// Lists of records (tag 26, `list.rs`): a tag byte and a 6-byte header, then fixed-width records.
export const LIST_HEAD_BYTES = 7;
/** A limit record (a wallet's count of a box, a recipe or a lottery round; a grant's claim count): key, count, window, in it. */
export const LIMIT_RECORD_BYTES = 28;
/** A round a grant paid a wallet: its key alone. */
export const ROUND_RECORD_BYTES = 16;
/** A contest's entry: of tokens, and of NFTs (the NFT, its place on its side, the picks taken). */
export const CONTEST_ENTRY_BYTES = Object.freeze({ tokens: 43, nfts: 83 });
