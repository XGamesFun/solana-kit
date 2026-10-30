#!/usr/bin/env node
// Sends what test wallets have left back to the eval funder. A run sweeps its own wallets when it ends; a run that was
// killed leaves its keys in the temp folder, and this finds them there.
//
//   node evals/live/sweep.mjs                 every wallet a killed run left (<tmp>/xsolana-eval-keys-*), then their folders
//   node evals/live/sweep.mjs <key.json>…     those wallets only
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rpcClient } from '../../js/chain/rpc.js';
import { keypairFromSecret } from '../../scripts/keypair.mjs';
import { funder, sweep } from './funds.mjs';

const RPC = process.env.XSOLANA_EVAL_RPC_URL || process.env.XSOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (/mainnet/i.test(RPC)) throw new Error('Live evals run on devnet only.');
const rpc = rpcClient(RPC);
const to = funder().address;

const left = process.argv.length > 2 ? null : readdirSync(os.tmpdir()).filter((d) => d.startsWith('xsolana-eval-keys-')).map((d) => path.join(os.tmpdir(), d));
const files = left ? left.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.key.json')).map((f) => path.join(d, f))) : process.argv.slice(2);
for (const file of files) {
  const who = keypairFromSecret(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
  const had = await rpc.balance(who.address);
  await sweep(rpc, who, to);
  console.log(`${who.address} had ${Number(had) / 1e9} SOL`);
}
// A folder goes only once its wallets are empty: a sweep that failed above has stopped the script before this.
for (const d of left ?? []) rmSync(d, { recursive: true, force: true });
console.log(`${files.length} wallet${files.length === 1 ? '' : 's'}; the funder ${to} holds ${Number(await rpc.balance(to)) / 1e9} SOL`);
