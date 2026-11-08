// A lottery's and a farm's seed in a token the project mints (no fixed supply): the owner's wallet holds none of it, so
// going live mints the seed straight into the pot and the rewards vault, as a pool's seed is minted into the pool
// (kit snag 1.1: the seed was paid from the owner's wallet, and the setup could never finish).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { freshAddresses, prepare } from '../economy/live.mjs';
import { plan } from '../economy/plan.mjs';
import { cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_790_000_000;

test(
  'a lottery’s and a farm’s seed in a token the project mints are minted into the pot and the vault at go-live',
  { skip },
  () => {
    const spec = {
      version: 2,
      network: 'devnet',
      name: 'Minted seeds',
      currency: 'sol',
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'dust', source: 'project', name: 'Dust', symbol: 'DUST', decimals: 2 },
      ],
      collection: false,
      lotteries: [
        {
          key: 'weekly',
          name: 'Weekly',
          currency: 'dust',
          price: 10,
          seed: 5000,
          places: [100],
          every: '7d',
          firstDraw: 'publish+7d',
        },
      ],
      farms: [
        {
          key: 'vault',
          name: 'Vault',
          stakes: 'dust',
          rewards: 'dust',
          seed: 1000,
          tiers: [{ lock: '0d', multiplier: 1 }],
        },
      ],
      scenario: { days: 7, perDay: { 'lottery:weekly': 10, 'farm:vault': 2 } },
    };
    assert.ok(check(spec, { now: NOW }).ok);
    const w = world({ project: false, seed: 'minted-seeds' });
    const owner = w.creator;
    w.chain.warp(NOW);
    const keys = freshAddresses(plan(spec, { now: NOW }).freshKeys, w.random);
    const p = prepare(spec, { owner, keys, now: NOW, rent: bytes => w.chain.rent(bytes) });
    assert.ok(p.ok, JSON.stringify(p.refusals ?? p));
    for (const t of p.transactions)
      w.chain.send(t.signer === 'authority' ? p.ctx.authority : owner, t.instructions, {
        label: t.steps.map(s => s.id).join(', '),
      });
    const lottery = loot.pda.lottery(p.ctx.project, spec.lotteries[0].id ?? 1);
    const farm = loot.pda.farm(p.ctx.project, spec.farms[0].id ?? 1);
    assert.equal(w.chain.tokens(loot.pda.pot(lottery)), 500_000n, 'the pot holds the 5,000 DUST seed');
    assert.equal(w.chain.tokens(loot.pda.rewards(farm)), 100_000n, 'the rewards vault holds the 1,000 DUST seed');
  },
);
