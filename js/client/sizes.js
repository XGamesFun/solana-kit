// Rent sizes from the current IDL. Fixed allocations reserve the largest enum and option forms,
// matching Anchor InitSpace. Dynamic records use their actual encoded fields.
import { encodeAccount } from '../chain/borsh.js';
import IDL from './idl/loot.js';

const scalar = { bool: 1, u8: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 };
// The most an order holds: its shares, and a roll's fate (`MAX_SHIFTS` numbers, each key at most 32 bytes).
const bounds = { 'Order.shares': 4, 'Order.won': 3, 'Fate.shifts': 2, 'Project.collections': 8 };
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
export const ACCOUNT_BYTES = Object.freeze({ ...Object.fromEntries(['Order', 'Seat', 'Hold', 'Entry', 'LotteryContribution'].map((name) => [name, allocationBytes(name)])) });

/** A project's bytes with `collections` collections, as the program sizes the account. */
export const projectBytes = (collections = 0) => 153 + 32 * collections;

// A receipt is not in the IDL and is read by hand: a 17-byte head (its tag, counts and how many rounds), then 8 bytes
// for each round it holds (see docs/program.md).
export const MAX_RECEIPT_ROUNDS = Number(IDL.constants.find((entry) => entry.name === 'MAX_RECEIPT_ROUNDS').value);
export const RECEIPT_BASE_BYTES = 17;
export const RECEIPT_ROUND_BYTES = 8;
export function receiptBytes(rounds = 0) {
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > MAX_RECEIPT_ROUNDS) throw new RangeError(`A receipt retains at most ${MAX_RECEIPT_ROUNDS} distinct voucher rounds`);
  return RECEIPT_BASE_BYTES + RECEIPT_ROUND_BYTES * rounds;
}
