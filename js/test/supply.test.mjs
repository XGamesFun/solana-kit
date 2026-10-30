// A community token with a fixed supply (a game token with "supply"): going live makes it, mints all of it to the
// owner, seeds pools from that, and turns minting off for good. In the live evals agents wrote their own mint pages.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { associatedTokenAddress } from '../chain/pda.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { check } from '../economy/check.mjs';
import { solanaApp } from '../play/index.js';
import * as loot from '../client/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-supply-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('a fixed supply goes to the owner, seeds a pool, and can never be minted again', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'supply' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Supply test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }, { key: 'gem', source: 'game', symbol: 'GEM', decimals: 6, supply: 10_000_000 }],
    collection: { name: 'Supply test' },
    pools: [{ key: 'rewards', currency: 'gem', seed: 500_000 }],
  };
  assert.ok(check(spec).ok);
  const live = await goLive(w, owner, spec);
  const mint = live.live.mints.gem;
  assert.equal(await w.chain.rpc.tokenBalance(associatedTokenAddress(owner.address, mint)), 9_500_000_000_000n, 'the supply less the seed is in the owner’s wallet');
  const data = (await w.chain.rpc.account(mint)).data;
  assert.equal(data[0], 0, 'the mint has no mint authority');
  assert.equal(new DataView(data.buffer, data.byteOffset).getBigUint64(36, true), 10_000_000_000_000n, 'the supply is exactly 10 million');

  const minting = check({ ...spec, schedules: [{ key: 'drip', does: 'issue', pool: 'rewards', amount: 1000, every: '1d' }] });
  assert.ok(minting.refusals.some((r) => r.code === 'E-MINT-NOT-OURS'), 'minting more is refused');
  assert.ok(check({ ...spec, pools: [{ key: 'rewards', currency: 'gem', seed: 20_000_000 }] }).refusals.some((r) => r.code === 'E-TOKEN'), 'a seed above the supply is refused');
});

test('a page runs a schedule that is due, and not before', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'schedule' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, {
    version: 2,
    network: 'devnet',
    name: 'Schedule test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }, { key: 'ore', source: 'game', symbol: 'ORE', decimals: 6 }],
    collection: { name: 'Schedule test' },
    pools: [{ key: 'rewards', currency: 'ore' }],
    schedules: [{ key: 'drip', does: 'issue', pool: 'rewards', amount: 1000, every: '1h' }],
  });
  const wallet = { address: player.address, async signTransaction(wire) { const t = readTransaction(wire); const sigs = [...t.signatures]; sigs[t.signers.indexOf(player.address)] = player.sign(t.message); return wireTransaction(t.message, sigs); } };
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  const pool = loot.pda.pool((live.live.project ?? live.live.game), live.pools[0].index);
  assert.equal(await app.runSchedule('drip'), null, 'not due yet');
  w.chain.warp(NOW + 3601);
  assert.ok(await app.runSchedule('drip'));
  assert.equal(await w.chain.rpc.tokenBalance(pool), 1_000_000_000n);
});
