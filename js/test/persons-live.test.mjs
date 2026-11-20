import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { check } from '../economy/check.mjs';
import { newKey } from '../results/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';
const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;
async function approve(w, owner, file) {
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 8 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map(b64 => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
test('a live project that names an issuer gets it set on chain by the next approval', { skip }, async () => {
  const w = world({ project: false, seed: 'review-029-b' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const server = await newKey();
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'P',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: false,
    lotteries: [{ key: 'draw', name: 'The Draw', pot: 0, price: 0.001, every: '1d', perWallet: 3 }],
    grants: [
      {
        key: 'a',
        name: 'A',
        prize: { gives: 'ticket', lottery: 'draw' },
        vouchers: [server.address],
        limits: { perWallet: 1 },
      },
    ],
  };
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-r029b-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const live = await approve(w, owner, file);
  live.keys = { issuer: server.address };
  live.grants.push({
    key: 'b',
    name: 'B',
    prize: { gives: 'ticket', lottery: 'draw' },
    vouchers: [server.address],
    limits: { perPerson: 1 },
  });
  assert.deepEqual(check(live).refusals, []);
  writeFileSync(file, JSON.stringify(live));
  const after = await approve(w, owner, file);
  // Fixed: the approval plans the owner's update_project for the issuer the spec now names.
  assert.ok(after.grants.every(g => g.id !== undefined));
  assert.equal(w.read('Project', after.live.project).issuer, server.address);
});
