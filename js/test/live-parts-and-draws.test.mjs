// A live economy's ids are never given again, a live part's times and fixed fields hold, a table is published, a
// listing taken out of the shop is switched off, and the numbers of distinct packs, kept farm rates, a lottery's two
// limits and a seeded pot are the program's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check, STAND_IN_OWNER } from '../economy/check.mjs';
import { changedParts, recordLanded } from '../economy/live.mjs';
import { model } from '../economy/model.mjs';
import { placeholderContext } from '../economy/plan.mjs';
import { drawnWithout, simulate } from '../economy/simulate.mjs';

const NOW = 1_800_000_000;
const example = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
// recorded as a setup records it, with a wallet's address where the plan's stand-ins were (check refuses a stand-in)
const WALLET = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const landed = (spec, now = NOW, sent = null) =>
  JSON.parse(
    JSON.stringify(recordLanded(spec, { ctx: placeholderContext(model(spec, { now })), now, sent })).replaceAll(
      STAND_IN_OWNER,
      WALLET,
    ),
  );
const codes = s => {
  const v = check(s, { now: NOW });
  return [...v.refusals, ...v.warnings].map(x => `${x.code} ${x.where}`);
};

test('an id a live economy used is never given again: a removed item’s id and listing stay its own', () => {
  const e = landed(example('stud-farm'));
  const [gone, ...rest] = e.items;
  e.items = [...rest, { key: 'legend', name: 'Legend', kind: 'collectible', price: 5 }];
  const m = model(e, { now: NOW });
  const legend = m.item.get('legend');
  assert.ok(!e.live.published.items.some(it => it.id === legend.id), `id ${legend.id} was ${gone.key}'s`);
  const listing = m.shop.find(b => b.shopOf === 'legend');
  const used = [...e.live.published.items.map(it => it.shopBox), ...(e.live.published.boxes ?? []).map(b => b.id)];
  assert.ok(!used.includes(listing.id));
});

test('an item taken out of the shop while live has its listing switched off, never left selling', () => {
  const e = landed(example('stakers-draw'));
  delete e.items[0].price;
  const listing = model(e, { now: NOW }).shop.find(b => b.shopOf === e.items[0].key);
  assert.equal(listing.active, false);
  assert.ok(changedParts(e).only.has(`item:${e.items[0].key}`));
});

test('a live part’s go-live times are its dates once sent, and a change sends them again', () => {
  const spec = example('stakers-draw');
  spec.items[0].closes = 'publish+7d';
  const e = landed(spec, NOW);
  assert.equal(e.items[0].closes, new Date((NOW + 7 * 86_400) * 1000).toISOString().replace('.000Z', 'Z'));
  // a part not sent this time keeps what it says
  const other = landed(e, NOW + 5 * 86_400, new Set());
  assert.equal(other.items[0].closes, e.items[0].closes);
  // a file whose approval did not write the dates: its change is warned of
  const old = landed(example('stakers-draw'));
  old.items[0].closes = 'publish+7d';
  old.live.published.items[0].closes = 'publish+7d';
  old.items[0].price = 0.03;
  assert.ok(codes(old).includes(`W-LIVE-TIME economy.items.${old.items[0].key}`), codes(old).join());
});

test('what can’t change once live is refused when the spec changes it: a sealed schedule, a lottery’s currency, a table', () => {
  const vesting = landed(example('team-vesting'));
  const sealed = vesting.schedules.find(s => s.sealed);
  sealed.amount = Number(sealed.amount) + 1;
  assert.ok(codes(vesting).includes(`E-LIVE-FIXED economy.schedules.${sealed.key}`), codes(vesting).join());
  const draw = landed(example('stakers-draw'));
  draw.tokens.push({ key: 'gem2', source: 'project', name: 'Gem2', symbol: 'GEM2', decimals: 6 });
  draw.lotteries[0].currency = 'gem2';
  assert.ok(codes(draw).includes('E-LIVE-FIXED economy.lotteries.draw'), codes(draw).join());
  // a table is a part: new, it is published; written again it would append its rows, so a change to it is refused
  const eggs = landed(example('stakers-draw'));
  eggs.tables = [
    {
      key: 'color',
      rows: [
        { label: 'red', weight: 1 },
        { label: 'blue', weight: 1 },
      ],
    },
  ];
  eggs.items.push({ key: 'egg', name: 'Egg', kind: 'collectible', drawn: [{ attribute: 'color', table: 'color' }] });
  assert.ok(changedParts(eggs).only.has('table:color'));
  const live = landed(eggs);
  live.tables[0].rows = [...live.tables[0].rows, { label: 'green', weight: 1 }];
  assert.ok(codes(live).includes('E-LIVE-FIXED economy.tables.color'), codes(live).join());
});

test('a slot that keeps each outcome once is drawn without putting back, as the program draws it', () => {
  // 98/1/1, two distinct draws: the rare one is drawn about half the time, never 2%
  const [common, a, b] = drawnWithout([98, 1, 1], 2);
  assert.ok(Math.abs(common - (0.98 + (2 * (0.01 * 0.98)) / 0.99)) < 1e-9);
  assert.ok(Math.abs(a - (0.01 + 0.98 / 2 + 0.01 / 99)) < 1e-9 && Math.abs(a - b) < 1e-12);
  assert.deepEqual(drawnWithout([3, 0, 1], 5), [1, 0, 1]);
});

test('a farm rate the program keeps without its last digits is quoted as paid, and warned of', () => {
  const s = {
    version: 2,
    network: 'devnet',
    name: 'F',
    currency: 'gem',
    tokens: [
      { key: 'gold', source: 'project', name: 'Gold', symbol: 'GOLD', decimals: 9 },
      { key: 'gem', source: 'project', name: 'Gem', symbol: 'GEM', decimals: 6 },
    ],
    collection: false,
    farms: [{ key: 'vault', name: 'Vault', stakes: 'gold', rewards: 'gem', rate: { perDay: 0.0025, minted: true } }],
    scenario: { days: 10, staked: { vault: 100 } },
  };
  assert.equal(model(s, { now: NOW }).farm.get('vault').rate.perDay, '0.002');
  assert.equal(simulate(s, { now: NOW }).farms[0].rewardsPerDay, 0.2);
  assert.ok(codes(s).includes('W-FARM-RATE economy.farms.vault.rate.perDay'), codes(s).join());
});

test('a lottery with a cap a round and a window both is refused: the program keeps one', () => {
  const s = example('stakers-draw');
  s.lotteries[0].perWalletEach = { count: 2, every: '1h' };
  assert.ok(codes(s).includes('E-LOTTERY economy.lotteries.draw.perWalletEach'), codes(s).join());
});

test('a pot that draws again pays its seed at its first draw', () => {
  const l = simulate(example('stakers-draw'), { now: NOW }).lotteries[0];
  assert.deepEqual(l.firstPrizes, [0.144, 0.096]);
});
