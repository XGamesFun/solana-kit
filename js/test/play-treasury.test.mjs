// A treasury trap: when the treasury is the owner's wrapped-SOL account, any wallet's "unwrap" closes it, and every
// later sale fails at settle. The treasury is by default a pool of the project's own, which no wallet can close: the
// owner buys from their own shop, unwraps, and later sales still settle.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { associatedTokenAddress, NATIVE_MINT } from '../chain/pda.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-treasury-')), 'xsolana.json');
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

test('the owner buys from their own shop and unwraps, and later sales still settle', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'treasury' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, {
    version: 2,
    network: 'devnet',
    name: 'Treasury test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Treasury test' },
    items: [{ key: 'cat', name: 'Moon Cat', price: 0.003, supply: 300 }],
  });
  assert.equal(live.live.treasury, owner.address, 'the default treasury is the owner’s wallet');
  const treasury = associatedTokenAddress(owner.address, NATIVE_MINT);

  const mine = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(owner), now: () => w.chain.now() });
  assert.ok((await mine.buy('cat', { listing: (await mine.shop()).find((l) => l.key === 'cat') })).asset);
  // Unwrapping closes the owner's wrapped-SOL account, the one sales pay into.
  await mine.unwrap();
  assert.equal(await w.chain.rpc.account(treasury), null);

  const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  assert.ok((await theirs.buy('cat', { listing: (await theirs.shop()).find((l) => l.key === 'cat') })).asset, 'a later sale settles');
  assert.equal(await w.chain.rpc.tokenBalance(treasury), 3_000_000n, 'and opens the treasury’s account again to pay it');
});
