// Ed25519 with node:crypto: the fresh keys a setup needs (a new collection, a project's own mint), and checking
// a wallet's signature. loot never holds a user's key; these fresh keys sign their part of one transaction, live
// in memory only, and are dropped when the approval ends (the economy is live, or the server closes).
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { addressBytes, encodeBase58 } from '../chain/base58.js';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A fresh keypair: { address, sign(message) → 64-byte signature }. The private key never leaves this object. */
export function freshKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const address = encodeBase58(new Uint8Array(raw));
  let key = privateKey;
  return {
    address,
    sign(message) {
      if (!key) throw new Error('This key was dropped.');
      return new Uint8Array(sign(null, Buffer.from(message), key));
    },
    drop() {
      key = null;
    },
  };
}

/** Whether `signature` is `address`'s ed25519 signature of `message`. */
export function verifySignature(address, message, signature) {
  if (!signature || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(addressBytes(address))]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}
