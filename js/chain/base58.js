// Base58 (Bitcoin alphabet): the text form of every Solana address and signature.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));
/** An address is 32 bytes: 32 to 44 base58 characters. */
const ADDRESS_TEXT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_BYTES = 32;
/** A signature is 64 bytes: 64 to 88 base58 characters. */
const SIGNATURE_TEXT = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** The address of 32 zero bytes: what an address field holds when it names no account (the System program's address too). */
export const NO_ADDRESS = '11111111111111111111111111111111';

export function encodeBase58(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    zeros += '1';
  }
  return zeros + digits.reverse().map((d) => ALPHABET[d]).join('');
}

export function decodeBase58(text) {
  const bytes = [];
  for (const char of text) {
    const value = INDEX.get(char);
    if (value === undefined) throw new Error(`Not base58: ${JSON.stringify(char)}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (text[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/** Whether the text is a Solana address: base58 that decodes to exactly 32 bytes. */
export function isAddress(text) {
  if (typeof text !== 'string' || !ADDRESS_TEXT.test(text)) return false;
  return decodeBase58(text).length === ADDRESS_BYTES;
}

/** Whether the text is a transaction signature: base58 that decodes to exactly 64 bytes. */
export function isSignature(text) {
  if (typeof text !== 'string' || !SIGNATURE_TEXT.test(text)) return false;
  return decodeBase58(text).length === 64;
}

/** The 32 bytes of an address; throws on anything else. */
export function addressBytes(address) {
  if (!isAddress(address)) throw new Error(`Not a Solana address: ${String(address).slice(0, 60)}`);
  return decodeBase58(address);
}
