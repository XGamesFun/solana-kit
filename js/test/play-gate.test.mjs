// A members-only shop: the hat's gate is just { item: "pass" } (no attribute), and the player module finds the pass
// to show by itself. In the live evals pages matched NFTs by name, and agents invented a "rarity" test to gate on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { solanaApp } from '../play/index.js';
import { goLive } from './helpers/live.mjs';
import { asWallet, cannotRun, world } from './helpers/world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

test('a gate on an item alone, and the module shows the pass by itself', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'gate' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, {
    version: 2,
    network: 'devnet',
    name: 'Members test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Members test' },
    items: [
      { key: 'pass', name: 'Member Pass', price: 0.005, supply: 500 },
      { key: 'hat', name: 'Gold Hat', price: 0.002, gate: { item: 'pass' } },
    ],
  });
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  await assert.rejects(
    app.buy('hat', { listing: (await app.shop()).find(l => l.key === 'hat') }),
    /You need a Member Pass to buy this/,
  );
  await app.buy('pass', { listing: (await app.shop()).find(l => l.key === 'pass') });
  const [pass] = await app.collectibles();
  assert.equal(pass.item, 'pass');
  assert.ok(
    (await app.buy('hat', { listing: (await app.shop()).find(l => l.key === 'hat') })).asset,
    'with a pass, the hat sells',
  );
  assert.deepEqual((await app.collectibles()).map(c => c.item).sort(), ['hat', 'pass']);
});
