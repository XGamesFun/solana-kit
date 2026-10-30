// A sealed schedule paid in SOL, funded from the owner's wallet: its vault takes wrapped SOL, which the owner's wallet
// holds as plain SOL. The setup wraps it first (as a lottery's or a pool's seed does), then moves it into the vault.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { freshAddresses, prepare } from '../economy/live.mjs';
import { plan } from '../economy/plan.mjs';
import { freshKeypair } from '../approve/ed25519.mjs';
import { cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;

test('a sealed schedule in SOL funded from the owner\'s wallet wraps the SOL first, and its vault holds it', { skip }, () => {
  const teammate = freshKeypair().address;
  const spec = {
    version: 2, network: 'devnet', name: 'SOL vesting', currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    schedules: [{ key: 'team', name: 'Team', does: 'pay', sealed: true, currency: 'sol', to: `wallet:${teammate}`, amount: 1, start: 'publish+30d', every: '30d', maxRuns: 3, fund: 3 }],
  };
  const w = world({ project: false, seed: 'sealed-sol' });
  const owner = w.creator;
  w.chain.warp(NOW);
  const keys = freshAddresses(plan(spec, { now: NOW }).freshKeys, w.random);
  const p = prepare(spec, { owner, keys, now: NOW, rent: (bytes) => w.chain.rent(bytes) });
  assert.ok(p.ok, JSON.stringify(p.refusals ?? p));
  const held = w.chain.get(owner).lamports;
  for (const t of p.transactions) w.chain.send(owner, t.instructions, { label: t.steps.map((s) => s.id).join(', ') });
  const schedule = loot.pda.schedule(p.ctx.project, spec.schedules[0].id ?? 1);
  assert.equal(w.chain.tokens(loot.pda.vest(schedule)), 3_000_000_000n, 'the vault holds the 3 SOL, wrapped');
  assert.ok(held - w.chain.get(owner).lamports >= 3_000_000_000n, 'from the owner\'s own SOL');
});
