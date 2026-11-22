// What an audit of the kit against loot 0.29.0 found (2026-11-22), each as the program does it: a box's draws, runs of
// lottery places, a schedule paying a farm, halving over the scenario, a rise grown in base units; and what check let
// through that the program refuses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { simulate } from '../economy/simulate.mjs';

const NOW = 1_800_000_000;
const example = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
const sol = more => ({
  version: 2,
  network: 'devnet',
  name: 'T',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'T' },
  ...more,
});
const refused = s => check(s, { now: NOW }).refusals.map(r => `${r.code} ${r.where}`);

test('an open of a box gives as many prizes as its slots draw, each slot among the outcomes it names', () => {
  const pack = slots =>
    sol({
      pools: [{ key: 'prizes', currency: 'sol', seed: 100 }],
      boxes: [
        {
          key: 'pack',
          name: 'Pack',
          price: 1,
          ...(slots ? { slots } : {}),
          split: [{ to: 'pool:prizes', percent: 100 }],
          outcomes: [
            { gives: 'pay', pool: 'prizes', amount: 0.1, chance: 50 },
            { gives: 'pay', pool: 'prizes', amount: 0.2, chance: 50 },
          ],
        },
      ],
      scenario: { days: 30, perDay: { 'box:pack': 100 } },
    });
  const back = slots => simulate(pack(slots), { now: NOW }).boxes[0].expectedBack;
  assert.equal(back(undefined), 0.15);
  assert.equal(back([{ count: 5 }]), 0.75);
  assert.equal(back([{ count: 4 }, { count: 1, from: [1] }]), 0.8);
});

test('a run of lottery places pays each of its places', () => {
  const s = sol({
    lotteries: [
      { key: 'draw', name: 'Draw', rest: 'treasury', price: 1, places: [50, { percent: 5, times: 6 }], every: '1d' },
    ],
    scenario: { days: 30, perDay: { 'lottery:draw': 100 } },
  });
  const l = simulate(s, { now: NOW }).lotteries[0];
  assert.equal(l.expectedPerTicket, 0.8);
  assert.equal(l.returnPercent, 80);
});

test('a schedule paying a share into a farm reaches the farm’s stakers', () => {
  const sim = simulate(example('halving-seasons'), { now: NOW });
  assert.equal(sim.farms[0].rewardsPerDay, 500);
});

test('a halving rate pays, a day, what it pays on average over the scenario', () => {
  const farm = {
    version: 2,
    network: 'devnet',
    name: 'H',
    currency: 'gem',
    tokens: [
      { key: 'sol', source: 'sol' },
      { key: 'gem', source: 'game', name: 'Gem', symbol: 'GEM', decimals: 6 },
    ],
    collection: { name: 'H' },
    farms: [
      {
        key: 'vault',
        name: 'Vault',
        stakes: 'gem',
        rewards: 'gem',
        rate: { perDay: 1, minted: true, halveEvery: '7d' },
      },
    ],
    scenario: { days: 28, staked: { vault: 100 } },
  };
  assert.equal(simulate(farm, { now: NOW }).farms[0].rewardsPerDay, 46.875);
  const issue = {
    ...farm,
    farms: [],
    pools: [{ key: 'season', currency: 'gem' }],
    schedules: [{ key: 'mint', name: 'Mint', does: 'issue', pool: 'season', amount: 1000, halveEvery: 7, every: '1d' }],
    recipes: [
      {
        key: 'claim',
        name: 'Claim',
        in: [{ pay: 0.001, currency: 'sol' }],
        out: [{ gives: 'tokens', amount: 10, from: 'pool:season' }],
      },
    ],
    scenario: { days: 28, perDay: { 'recipe:claim': 50 } },
  };
  const sim = simulate(issue, { now: NOW });
  assert.equal(sim.schedules[0].perDay, 468.75);
  // The pool fills while the mint outruns the claims, then runs dry once it has halved below them.
  const pool = sim.pools.find(p => p.key === 'season');
  assert.equal(pool.lasts, 'runs dry');
  assert.ok(pool.lastsDays > 14 && pool.lastsDays < 28, String(pool.lastsDays));
});

test('a price grows in its token’s base units, rounded down, as the program grows it', () => {
  const s = {
    version: 2,
    network: 'devnet',
    name: 'R',
    currency: 'gold',
    tokens: [
      { key: 'sol', source: 'sol' },
      { key: 'gold', source: 'game', name: 'Gold', symbol: 'GLD', decimals: 0 },
    ],
    collection: { name: 'R' },
    items: [{ key: 'throne', name: 'Throne', price: 10, rise: { growthPercent: 5 } }],
    scenario: { days: 1, perDay: { 'item:throne': 20 } },
  };
  const it = simulate(s, { now: NOW }).items[0];
  assert.equal(it.averagePrice ?? it.price, 10);
  assert.equal(it.nextPrice, undefined);
});

test('check refuses what the program refuses: a compressed link at a ten-digit serial, a lottery’s share into its own pot, a boost per point with no cap, one NFT handed over twice', () => {
  const uri = `https://x.example/${'a'.repeat(170)}/{serial}.json`;
  const badge = sol({
    items: [
      { key: 'gem', name: 'Gem', price: 0.01 },
      { key: 'badge', name: 'Badge', supply: 100, uri },
    ],
    boxes: [
      { key: 'b', name: 'B', price: 0.01, outcomes: [{ gives: 'item', item: 'badge', compressed: true, chance: 100 }] },
    ],
  });
  assert.ok(
    Buffer.byteLength(uri.replace('{serial}', '100')) <= 200 &&
      Buffer.byteLength(uri.replace('{serial}', '9'.repeat(10))) > 200,
  );
  assert.ok(
    refused(badge).some(r => r.endsWith('.compressed')),
    refused(badge).join(),
  );

  const draw = example('stakers-draw');
  draw.lotteries[0].split = [{ to: 'lottery:draw', percent: 10 }];
  assert.ok(refused(draw).includes('E-LOTTERY economy.lotteries.draw.split[0]'), refused(draw).join());

  const guild = example('expedition-guild');
  delete guild.farms[0].boosts[0].add.upTo;
  assert.ok(
    refused(guild).some(r => r.startsWith('E-RULE') && r.endsWith('.upTo')),
    refused(guild).join(),
  );

  const raffle = example('nft-raffle');
  raffle.auctions = [{ key: 'a', name: 'A', lot: { asset: raffle.lotteries[0].raffle.nft }, reserve: 1, runs: '1d' }];
  assert.ok(refused(raffle).includes('E-NFT-TWICE economy.auctions.a.lot.asset'), refused(raffle).join());
});

test('check says what a spec writes that does nothing or contradicts itself, and warns of a live item’s fixed fields', () => {
  const codes = s => {
    const v = check(s, { now: NOW });
    return [...v.refusals, ...v.warnings].map(x => `${x.code} ${x.where}`);
  };
  const draw = example('stakers-draw');
  draw.items[0].free = true;
  assert.ok(codes(draw).includes('E-ITEM economy.items.badge.free'), codes(draw).join());

  const halving = example('halving-seasons');
  halving.schedules[1].fund = 100;
  assert.ok(codes(halving).includes('W-SCHEDULE economy.schedules.drip.fund'), codes(halving).join());

  const stud = example('stud-farm');
  stud.recipes[0].out[0].on = 0;
  assert.ok(
    codes(stud).some(c => c.startsWith('W-RECIPE') && c.endsWith('.out[0].on')),
    codes(stud).join(),
  );

  const race = example('stakers-draw');
  race.grants[0].prize.held = true;
  assert.ok(codes(race).includes('W-PRIZE economy.grants.race.prize.held'), codes(race).join());

  const live = example('stakers-draw');
  live.live = { project: '4vd1uA3jK28MwhufZnbtQpyJkVMXEVpKHzDRPUH9DT3v', published: structuredClone(live) };
  live.items[0].soulbound = false;
  assert.ok(codes(live).includes('W-ITEM-LOCKED economy.items.badge'), codes(live).join());
});

test('a duration of 0 stays none: a farm that runs 0 never ends, a lottery that draws every 0 draws once', async () => {
  const { farmArgs } = await import('../economy/plan.mjs');
  const { model } = await import('../economy/model.mjs');
  const farm = example('paper-hands-farm');
  farm.farms[0].runs = 0;
  const m = model(farm, { now: NOW });
  assert.equal(farmArgs(m.farms[0], m).ends_at, 0n);
  const raffle = example('nft-raffle');
  raffle.lotteries[0].every = 0;
  assert.deepEqual(refused(raffle), []);
});

test('a limit in a window shorter than a day is counted a day as the chain allows it', () => {
  const s = sol({
    items: [{ key: 'gem', name: 'Gem', price: 0.01 }],
    grants: [
      {
        key: 'g',
        name: 'G',
        prize: { gives: 'item', item: 'gem' },
        fund: 0.1,
        limits: { perWalletEach: { count: 1, every: '1h' }, perDay: 1000 },
      },
    ],
  });
  assert.equal(simulate(s, { now: NOW }).grants[0].many.one, 24);
});
