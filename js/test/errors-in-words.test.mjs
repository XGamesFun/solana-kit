// A refusal reaches the player in words: a send whose preflight failed, and a wallet whose own dry run says only
// "custom program error: 0x…", both name loot's reason; a code that isn't loot's is left as it came.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { rpcClient } from '../chain/rpc.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const answer = (body) => ({ status: 200, ok: true, headers: new Headers(), json: async () => body });

test("a send refused in preflight says the program's reason, not the bare code", async () => {
  const logs = [
    'Program 9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ invoke [1]',
    'Program log: AnchorError occurred. Error Code: AlreadyClaimed. Error Number: 6069. Error Message: This wallet was already paid for this round, or claimed this list.',
    'Program 9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ failed: custom program error: 0x17b5',
  ];
  const fetchImpl = async () => answer({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x17b5', data: { err: { InstructionError: [0, { Custom: 6069 }] }, logs } } });
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(rpc.send(new Uint8Array(1)), (e) => /already paid for this round, or claimed this list \(AlreadyClaimed\)/.test(e.message) && e.logs === logs);
});

test("a wallet's bare loot code is named; another program's code is left as it came", { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'errors-in-words' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const spec = { version: 2, network: 'devnet', name: 'Words', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'Words' }, items: [{ key: 'badge', name: 'Badge', price: 0.01, supply: 10 }] };
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-words-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const sigs = [...t.signatures];
      sigs[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, sigs));
    }));
  }
  const live = JSON.parse(readFileSync(file, 'utf8'));
  // A wallet whose own dry run refused, saying only the code (as Phantom does).
  const refusing = (said) => ({ address: freshKeypair().address, async signTransaction() { throw new Error(said); } });
  const buy = async (said) => {
    const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: refusing(said), now: () => w.chain.now() });
    return app.buy('badge', { listing: (await app.shop()).find((l) => l.key === 'badge') });
  };
  await assert.rejects(buy('Transaction simulation failed: Error processing Instruction 1: custom program error: 0x17b5'), (e) => e.name === 'AlreadyClaimed' && /^This wallet was already paid/.test(e.message) && /0x17b5/.test(e.cause.message));
  await assert.rejects(buy('Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1'), (e) => /custom program error: 0x1$/.test(e.message));
});
