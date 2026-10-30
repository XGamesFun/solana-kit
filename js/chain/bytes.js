// Byte helpers shared by browser apps and Node. Plain Uint8Array, never Node's Buffer, so they run in a browser page
// too.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** btoa/atob take strings of at most this many code units comfortably. */
const BASE64_CHUNK = 0x8000;

/** UTF-8 bytes of a string. */
export const utf8 = (text) => encoder.encode(text);

/** A string from UTF-8 bytes. */
export const fromUtf8 = (bytes) => decoder.decode(bytes);

/** The parts, one after another. */
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Lexicographic order of two byte strings (like Buffer.compare): -1, 0 or 1. */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Whether two byte strings are equal. */
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  return btoa(text);
}

/** Standard base64 to bytes; throws on anything that is not base64. */
export function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Not base64');
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(text) {
  if (typeof text !== 'string' || text.length % 2 || /[^0-9a-f]/i.test(text)) throw new Error('Not hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Little-endian unsigned integer of `size` bytes, as Borsh and the Solana wire format write them. `value` is a bigint,
 * or a number that is a safe integer: a larger number has already lost its low digits, so it is refused rather than
 * written as some other value.
 */
export function uintLE(value, size) {
  const out = new Uint8Array(size);
  let rest = toBigInt(value);
  if (rest < 0n || rest >= 1n << BigInt(size * 8)) throw new RangeError(`${value} does not fit in ${size} bytes`);
  for (let i = 0; i < size; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * Little-endian signed (two's complement) integer of `size` bytes, as Borsh writes an i32 or an i64. `value` as
 * `uintLE` takes it; one outside the signed range is refused rather than wrapped.
 */
export function intLE(value, size) {
  const v = toBigInt(value);
  const bits = BigInt(size * 8);
  if (v < -(1n << (bits - 1n)) || v >= 1n << (bits - 1n)) throw new RangeError(`${value} does not fit in a signed ${size}-byte integer`);
  return uintLE(v < 0n ? v + (1n << bits) : v, size);
}

/**
 * `value` as a bigint: a bigint, a number that is a safe integer, or a string of digits. A number past 2^53 has already
 * lost its low digits, so it is refused rather than turned into some other value.
 */
export function toBigInt(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError(`${value} is not a safe integer: pass it as a bigint`);
  return BigInt(value);
}

/** A little-endian unsigned integer of `size` bytes at `offset`, as a bigint. */
export function readUintLE(bytes, offset, size) {
  if (offset < 0 || offset + size > bytes.length) throw new RangeError('read past the end of the data');
  let value = 0n;
  for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

/** Solana's compact-u16 length prefix. */
export function compactU16(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError('compact-u16 out of range');
  const out = [];
  let rest = value;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return Uint8Array.from(out);
    }
    out.push(low | 0x80);
  }
}

/**
 * A compact-u16 at `offset`: its value and how many bytes it took. Like Solana, it refuses a value past 0xffff and a
 * longer form of a value that has a shorter one.
 */
export function readCompactU16(bytes, offset) {
  let value = 0;
  for (let size = 0; size < 3; size++) {
    const byte = bytes[offset + size];
    if (byte === undefined) throw new RangeError('truncated length prefix');
    if (size > 0 && byte === 0) throw new RangeError('length prefix is longer than it needs to be');
    value |= (byte & 0x7f) << (7 * size);
    if ((byte & 0x80) === 0) {
      if (value > 0xffff) throw new RangeError('length prefix past 0xffff');
      return { value, size: size + 1 };
    }
  }
  throw new RangeError('length prefix too long');
}

/** Random bytes from the platform's CSPRNG (WebCrypto in browsers and Node 24). */
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
