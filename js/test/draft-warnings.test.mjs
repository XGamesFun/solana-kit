// What a draft saved half-done does once live, said before it goes: a part switched off (W-OFF) that nobody can use,
// except a box only prizes, missions or recipes roll; a grant whose "total" is less than its own list
// (W-GRANT-LIMITS). And a farm that only qualifies stakers for a gate may have a rewards pool nothing fills: a
// warning, never a refusal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';

const NOW = 1_790_000_000;
const example = (name) => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
const WALLETS = ['5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T', '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ', 'So11111111111111111111111111111111111111112'];
const codes = (spec) => {
  const r = check(spec, { now: NOW });
  return { refused: r.refusals.map((x) => `${x.code} ${x.where}`), warned: r.warnings.map((x) => `${x.code} ${x.where}`), ok: r.ok };
};

const base = () => ({
  version: 2,
  network: 'devnet',
  name: 'Drafts',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }, { key: 'gem', source: 'game', name: 'Gem', symbol: 'GEM', decimals: 6 }],
  collection: { name: 'Drafts' },
  items: [{ key: 'hat', name: 'Hat', price: 0.01 }],
  pools: [{ key: 'prizes', currency: 'gem', seed: 1000 }],
  boxes: [
    { key: 'chest', name: 'Chest', price: 0.01, outcomes: [{ chance: 50, gives: 'item', item: 'hat' }, { chance: 50, gives: 'nothing' }] },
    { key: 'reward', name: 'Reward chest', price: 0, active: false, outcomes: [{ chance: 50, gives: 'item', item: 'hat' }, { chance: 50, gives: 'nothing' }] },
  ],
  grants: [
    { key: 'welcome', name: 'Welcome', prize: { gives: 'roll', box: 'reward' }, list: WALLETS, limits: { perWallet: 1 }, fund: 0.05 },
    { key: 'race', name: 'Race prize', prize: { gives: 'tokens', amount: 10, from: 'pool:prizes' }, vouchers: [WALLETS[0]], limits: { perWallet: 1, total: 100 }, fund: 0.05 },
  ],
});

test('a part switched off is warned about, but not a box only a prize rolls', () => {
  const on = codes(base());
  assert.ok(on.ok, on.refused.join());
  assert.ok(!on.warned.some((w) => w.startsWith('W-OFF')), `a box only a grant rolls is meant to be off: ${on.warned.join()}`);
  const off = base();
  off.grants[1].active = false;
  off.items[0].active = false;
  off.boxes[0].active = false;
  const r = codes(off);
  for (const where of ['economy.grants.race.active', 'economy.items.hat.active', 'economy.boxes.chest.active']) assert.ok(r.warned.includes(`W-OFF ${where}`), `${where}: ${r.warned.join()}`);
  assert.ok(!r.warned.includes('W-OFF economy.boxes.reward.active'));
  const text = check(off, { now: NOW }).warnings.find((w) => w.where === 'economy.grants.race.active');
  assert.match(JSON.stringify(text), /switched off: once live, nobody can claim it/);
});

test('a grant whose total is less than its list says the rest are refused', () => {
  const short = base();
  short.grants[0].limits.total = 2;
  assert.ok(codes(short).warned.includes('W-GRANT-LIMITS economy.grants.welcome.limits.total'));
  const enough = base();
  enough.grants[0].limits.total = 3;
  assert.ok(!codes(enough).warned.includes('W-GRANT-LIMITS economy.grants.welcome.limits.total'));
});

test('a farm with no rate that only qualifies stakers for a gate may have a rewards pool nothing fills', () => {
  const spec = example('stakers-draw');
  delete spec.farms[0].rate;
  const r = codes(spec);
  assert.ok(r.ok, r.refused.join());
  assert.ok(r.warned.includes('W-POOL-DRY economy.pools.vault-rewards'), r.warned.join());
});
