// A small Borsh codec driven by an Anchor IDL, so neither side needs Anchor. It covers what the loot program and the
// accounts this kit reads use: bool, u8–u128, i32, i64, pubkey, string, fixed arrays, vec, option, defined structs and
// enums, with or without data. Plain Uint8Array, never Node's Buffer, so it runs in browser apps and Node alike.
//
// Values: addresses are base58 strings, u64/u128/i64 bigints (u8–u32 numbers), byte arrays Uint8Arrays. An enum is
// its variant's name ('Nothing'), or for a variant with data { Name: [values] } (tuple fields) or
// { Name: { field: value } } (named fields). Account and event discriminators are whatever length the IDL gives (loot
// tags its accounts with one byte).
import { addressBytes, encodeBase58 } from './base58.js';
import { concat, equalBytes, fromBase64, fromUtf8, intLE, readUintLE, uintLE, utf8 } from './bytes.js';

const UINT = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16 };
const INT = { i32: 4, i64: 8 };
const ADDRESS_BYTES = 32;

function typeDef(idl, name) {
  const def = idl.types.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown IDL type ${name}`);
  return def;
}

function readIntLE(data, at, size) {
  const v = BigInt(readUintLE(data, at, size));
  const bits = BigInt(size * 8);
  const signed = v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
  // An i32 is a number, as u8 to u32 are; an i64 a bigint.
  return size <= 4 ? Number(signed) : signed;
}

function encodeScalar(type, value, out) {
  if (UINT[type]) out.push(uintLE(value, UINT[type]));
  else if (INT[type]) out.push(intLE(value, INT[type]));
  else if (type === 'bool') out.push(Uint8Array.of(value ? 1 : 0));
  else if (type === 'pubkey') out.push(addressBytes(String(value)));
  else if (type === 'string') {
    const bytes = utf8(String(value));
    out.push(uintLE(bytes.length, 4), bytes);
  } else throw new Error(`Unsupported IDL type ${type}`);
}

/** A variant's field list: named ({ name, type }) or tuple (bare types). */
const isNamed = (fields) => typeof fields[0] === 'object' && fields[0] !== null && 'name' in fields[0];

function encodeDefined(idl, name, value, out) {
  const def = typeDef(idl, name).type;
  if (def.kind === 'enum') {
    const variantName = typeof value === 'string' ? value : Object.keys(value ?? {})[0];
    const index = def.variants.findIndex((v) => v.name === variantName);
    if (index < 0) throw new Error(`${name} has no variant ${String(variantName)}`);
    out.push(Uint8Array.of(index));
    const fields = def.variants[index].fields ?? [];
    if (!fields.length) return;
    const payload = typeof value === 'string' ? null : value[variantName];
    if (payload == null) throw new Error(`${name}.${variantName} needs its data`);
    if (isNamed(fields)) for (const f of fields) encodeInto(idl, f.type, payload[f.name], out);
    else fields.forEach((f, i) => encodeInto(idl, f, payload[i], out));
    return;
  }
  for (const field of def.fields) {
    if (!(field.name in value)) throw new Error(`${name}.${field.name} is required`);
    encodeInto(idl, field.type, value[field.name], out);
  }
}

/**
 * A `[u8; N]`: a Uint8Array, or an array of integers from 0 to 255, of exactly `length` bytes. Anything else (a string,
 * a number past a byte) is refused rather than written as other bytes.
 */
function byteArray(value, length) {
  const bytes = value instanceof Uint8Array || (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
  if (!bytes) throw new TypeError(`Expected ${length} bytes: a Uint8Array or an array of integers from 0 to 255`);
  if (value.length !== length) throw new Error(`Expected ${length} bytes, got ${value.length}`);
  return Uint8Array.from(value);
}

function encodeInto(idl, type, value, out) {
  if (typeof type === 'string') return encodeScalar(type, value, out);
  if ('array' in type) {
    const [inner, length] = type.array;
    if (inner === 'u8') {
      out.push(byteArray(value, length));
      return;
    }
    if (value.length !== length) throw new Error(`Expected ${length} items, got ${value.length}`);
    for (const item of Array.from(value)) encodeInto(idl, inner, item, out);
    return;
  }
  if ('vec' in type) {
    out.push(uintLE(value.length, 4));
    for (const item of value) encodeInto(idl, type.vec, item, out);
    return;
  }
  if ('option' in type) {
    if (value === null || value === undefined) out.push(Uint8Array.of(0));
    else {
      out.push(Uint8Array.of(1));
      encodeInto(idl, type.option, value, out);
    }
    return;
  }
  encodeDefined(idl, type.defined.name, value, out);
}

/** The Borsh bytes of one value of `type`. */
export function encodeBorsh(idl, type, value) {
  const out = [];
  encodeInto(idl, type, value, out);
  return concat(...out);
}

/** An instruction's data: its discriminator, then each argument in IDL order. */
export function encodeInstruction(idl, name, args) {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`Unknown instruction ${name}`);
  const out = [Uint8Array.from(ix.discriminator)];
  for (const arg of ix.args) {
    if (!(arg.name in args)) throw new Error(`${name}: missing argument ${arg.name}`);
    encodeInto(idl, arg.type, args[arg.name], out);
  }
  return concat(...out);
}

/** An account's bytes as the program writes them: its discriminator, then its fields. */
export function encodeAccount(idl, name, value) {
  const account = idl.accounts.find((a) => a.name === name);
  if (!account) throw new Error(`Unknown account type ${name}`);
  return concat(Uint8Array.from(account.discriminator), encodeBorsh(idl, { defined: { name } }, value));
}

function decodeScalar(type, data, at) {
  const size = UINT[type] ?? INT[type];
  if (size && at + size > data.length) throw new RangeError('read past the end of the data');
  if (INT[type]) return [readIntLE(data, at, size), at + size];
  if (size >= 8) return [readUintLE(data, at, size), at + size];
  if (size) return [Number(readUintLE(data, at, size)), at + size];
  if (type === 'bool') {
    if (at >= data.length) throw new RangeError('read past the end of the data');
    return [data[at] !== 0, at + 1];
  }
  if (type === 'pubkey') {
    if (at + ADDRESS_BYTES > data.length) throw new RangeError('read past the end of the data');
    return [encodeBase58(data.subarray(at, at + ADDRESS_BYTES)), at + ADDRESS_BYTES];
  }
  if (type === 'string') {
    const length = Number(readUintLE(data, at, 4));
    if (at + 4 + length > data.length) throw new RangeError('string runs past the end of the data');
    return [fromUtf8(data.subarray(at + 4, at + 4 + length)), at + 4 + length];
  }
  throw new Error(`Unsupported IDL type ${type}`);
}

function decodeList(idl, inner, length, data, at) {
  const items = [];
  let offset = at;
  for (let i = 0; i < length; i++) {
    const [item, next] = decodeAt(idl, inner, data, offset);
    items.push(item);
    offset = next;
  }
  return [items, offset];
}

function decodeDefined(idl, name, data, at) {
  const def = typeDef(idl, name).type;
  if (def.kind === 'enum') {
    const variant = def.variants[data[at]];
    if (!variant) throw new Error(`${name}: unknown variant ${data[at]}`);
    const fields = variant.fields ?? [];
    if (!fields.length) return [variant.name, at + 1];
    let offset = at + 1;
    const named = isNamed(fields);
    const payload = named ? {} : [];
    fields.forEach((f, i) => {
      let value;
      [value, offset] = decodeAt(idl, named ? f.type : f, data, offset);
      if (named) payload[f.name] = value;
      else payload[i] = value;
    });
    return [{ [variant.name]: payload }, offset];
  }
  const record = {};
  let offset = at;
  for (const field of def.fields) [record[field.name], offset] = decodeAt(idl, field.type, data, offset);
  return [record, offset];
}

function decodeAt(idl, type, data, at) {
  if (typeof type === 'string') return decodeScalar(type, data, at);
  if ('array' in type) {
    const [inner, length] = type.array;
    if (inner === 'u8') {
      if (at + length > data.length) throw new RangeError('read past the end of the data');
      return [data.slice(at, at + length), at + length];
    }
    return decodeList(idl, inner, length, data, at);
  }
  if ('vec' in type) {
    const length = Number(readUintLE(data, at, 4));
    if (length > data.length) throw new RangeError('vec longer than the data');
    return decodeList(idl, type.vec, length, data, at + 4);
  }
  if ('option' in type) {
    if (at >= data.length) throw new RangeError('read past the end of the data');
    return data[at] === 0 ? [null, at + 1] : decodeAt(idl, type.option, data, at + 1);
  }
  return decodeDefined(idl, type.defined.name, data, at);
}

/** One value of `type` at `offset`: [value, next offset]. */
export const decodeBorsh = (idl, type, data, offset = 0) => decodeAt(idl, type, data, offset);

const startsWith = (data, prefix) => data.length >= prefix.length && equalBytes(data.subarray(0, prefix.length), Uint8Array.from(prefix));

/** An account of the named type, after checking its discriminator. Bytes after the fields are left alone. */
export function decodeAccount(idl, name, data) {
  const account = idl.accounts.find((a) => a.name === name);
  if (!account) throw new Error(`Unknown account type ${name}`);
  if (!startsWith(data, account.discriminator)) throw new Error(`Not a ${name} account`);
  return decodeDefined(idl, name, data, account.discriminator.length)[0];
}

/** Whether the data starts with the named account's discriminator. */
export function isAccount(idl, name, data) {
  const account = idl.accounts.find((a) => a.name === name);
  return Boolean(account) && startsWith(data, account.discriminator);
}

/**
 * The program's Anchor events in a transaction's logs (`Program data: <base64 of discriminator + Borsh>`):
 * [{ name, data }]. Only lines the program itself printed count: the log names which program each line comes from
 * (`Program <id> invoke [n]` … `success`), and any program can print a line that looks like an event. Logs alone
 * cannot say whether the transaction succeeded (the runtime can fail it after every instruction logged success), so
 * the caller decides that from the transaction's `meta.err` and reads events only when it is null.
 */
export function decodeEvents(idl, logs) {
  const out = [];
  const stack = [];
  for (const line of logs ?? []) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ failed/.test(line)) return [];
    if (/^Program \w+ success$/.test(line)) {
      stack.pop();
      continue;
    }
    const m = /^Program data: (.+)$/.exec(line);
    if (!m || stack[stack.length - 1] !== idl.address) continue;
    let bytes;
    try {
      bytes = fromBase64(m[1]);
    } catch {
      continue;
    }
    const event = (idl.events ?? []).find((e) => startsWith(bytes, e.discriminator));
    if (event) out.push({ name: event.name, data: decodeDefined(idl, event.name, bytes, event.discriminator.length)[0] });
  }
  return out;
}
