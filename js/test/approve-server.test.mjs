// The approval server as a process: the spec file written whole, a wallet that is no address answered in words, and
// the server stopping once the economy is live.
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { approve, writeWhole } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_790_000_000;

test('the spec file is written whole: renamed over the old one, its permissions kept, a link followed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-whole-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, 'old', { mode: 0o600 });
  const was = statSync(file).ino;
  await writeWhole(file, 'new');
  assert.equal(readFileSync(file, 'utf8'), 'new');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.notEqual(statSync(file).ino, was, 'a new file took the old one’s place');
  assert.deepEqual(readdirSync(dir), ['xsolana.json'], 'nothing left beside it');
  const link = path.join(dir, 'link.json');
  symlinkSync(file, link);
  await writeWhole(link, 'through the link');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(file, 'utf8'), 'through the link');
});

/** The approval server for `file`, and a call to its API with the session's token. */
async function served(file, chain) {
  const { server, link } = await approve({ file, open: false, chain, log: () => {} });
  const token = new URL(link).searchParams.get('t');
  const api = async (at, body) => {
    const r = await fetch(new URL(at, link), { method: body ? 'POST' : 'GET', headers: { 'x-xsolana-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { server, api };
}

test('the approval server answers a wallet that is no Solana address with 400, in words', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-guard-')), 'xsolana.json');
  writeFileSync(file, readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url)));
  const { server, api } = await served(file, {});
  try {
    for (const r of [await api('/api/state?wallet=xyz'), await api('/api/prepare', { wallet: 'xyz' }), await api('/api/complete', { wallet: 'xyz', id: 'a', transactions: [] })]) {
      assert.equal(r.status, 400);
      assert.match(r.body.error, /not a Solana address/);
    }
  } finally {
    server.close();
  }
});

test('the approval server stops once the economy is live, after the page has its answer', { skip }, async () => {
  const w = world({ project: false, seed: 'guard-stops' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-guard-')), 'xsolana.json');
  writeFileSync(file, readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url)));
  const { server, api } = await served(file, approvalChain(w));
  const closed = new Promise((resolve) => server.once('close', resolve));
  try {
    let state = { done: false };
    for (let i = 0; i < 10 && !state.done; i++) {
      assert.ok(server.listening, 'it serves while there is something to approve');
      const batch = (await api('/api/prepare', { wallet: owner.address })).body;
      const transactions = batch.transactions.map((b64) => {
        const t = readTransaction(fromBase64(b64));
        const sigs = [...t.signatures];
        sigs[t.signers.indexOf(owner.address)] = owner.sign(t.message);
        return toBase64(wireTransaction(t.message, sigs));
      });
      const r = await api('/api/complete', { wallet: owner.address, id: batch.id, transactions });
      assert.equal(r.status, 200, r.body.error);
      state = r.body;
    }
    assert.ok(state.done, 'live');
    await closed;
    assert.equal(server.listening, false);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(new Set(saved.live.transactions.map((t) => t.signature)).size, saved.live.transactions.length, 'each signature once');
  } finally {
    server.close();
  }
});
