// Devnet SOL for a run: the eval funder (its own key, never the deployer's) tops up a fresh owner and player, and
// takes back what they have left at the end.
import { readFileSync, writeFileSync } from 'node:fs';
import { freshKeypair } from '../../js/approve/ed25519.mjs';
import { keypairFromSecret } from '../../scripts/keypair.mjs';
import { transferLamports } from '../../js/chain/programs.js';
import { compileMessage, readTransaction, wireTransaction } from '../../js/chain/tx.js';
import { randomBytes } from 'node:crypto';
import { createPublicKey, createPrivateKey } from 'node:crypto';
import { encodeBase58 } from '../../js/chain/base58.js';

/** The eval funder's keypair file: a devnet keypair of its own (Solana's JSON format), named by XSOLANA_EVAL_FUNDER. */
export const FUNDER_FILE = process.env.XSOLANA_EVAL_FUNDER;

export function funder(file = FUNDER_FILE) {
  if (!file) throw new Error('Set XSOLANA_EVAL_FUNDER to the path of a devnet keypair file (Solana\'s JSON format) that funds the eval wallets: a key of its own, never a deployer\'s.');
  return keypairFromSecret(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
}

/** A throwaway keypair written to `file` (Solana's JSON format), so a separate process (the browser) can sign with it. */
export function throwaway(file) {
  const seed = randomBytes(32);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const pub = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x, 'base64url');
  writeFileSync(file, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  return { ...keypairFromSecret(Uint8Array.from([...seed, ...pub])), address: encodeBase58(new Uint8Array(pub)) };
}

export async function send(rpc, signer, instructions) {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const message = compileMessage({ payer: signer.address, blockhash, instructions });
  readTransaction(wireTransaction(message));
  const signature = await rpc.send(wireTransaction(message, [signer.sign(message)]));
  await rpc.confirm(signature, { lastValidBlockHeight });
  return signature;
}

export const fund = (rpc, from, to, sol) => send(rpc, from, [transferLamports(from.address, to, BigInt(Math.round(sol * 1e9)))]);

/** Sends what `who` has left (less the fee) back to `to`. */
export async function sweep(rpc, who, to) {
  const balance = await rpc.balance(who.address);
  if (balance <= 10_000n) return null;
  return send(rpc, who, [transferLamports(who.address, to, balance - 5_000n)]);
}

export { freshKeypair };
