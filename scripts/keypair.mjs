// A keypair from a Solana secret key file's bytes, for the devnet scripts and the live evals only: it is not part of
// the published package, and no tool in it reads a person's key.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { encodeBase58 } from '../js/chain/base58.js';

/** A keypair from a 64-byte Solana secret key (seed then public key): { address, sign(message) }. */
export function keypairFromSecret(secret) {
  const seed = Buffer.from(secret.slice(0, 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { address: encodeBase58(new Uint8Array(raw)), sign: (message) => new Uint8Array(sign(null, Buffer.from(message), privateKey)) };
}
