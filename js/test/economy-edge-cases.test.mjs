// Edge cases of the economy tools (js/economy): values the checker must refuse in words rather than throw on, numbers
// that stay put once live, the simulation and the explainer counting what really happens, and secrets told apart from
// ordinary words.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { changedParts, recordLanded } from '../economy/live.mjs';
import { model } from '../economy/model.mjs';
import { contestArgs } from '../economy/plan.mjs';
import { findSecrets } from '../economy/secrets.mjs';
import { explain, simulate } from '../economy/simulate.mjs';

const NOW = 1_800_000_000;
const A = 'So11111111111111111111111111111111111111113';
const D = '11111111111111111111111111111112';
const base = (extra = {}) => ({ version: 2, network: 'devnet', name: 'Edge', currency: 'gold', tokens: [{ key: 'gold', source: 'game', decimals: 2 }], ...extra });
const codes = (r) => r.refusals.map((x) => `${x.code} ${x.where}`);
const warned = (r, code) => r.warnings.filter((w) => w.code === code);

test('a fixed supply’s seed with too many decimals is refused, not thrown on, and refused once', () => {
  const spec = base({ tokens: [{ key: 'gold', source: 'game', supply: 1000 }], pools: [{ key: 'r', currency: 'gold', seed: 0.5 }] });
  assert.deepEqual(codes(check(spec, { now: NOW })), ['E-AMOUNT economy.pools.r.seed']);
});

test('a farm’s rate with more decimals than its rewards is refused, not thrown on', () => {
  const spec = base({ pools: [{ key: 'r', currency: 'gold' }], farms: [{ key: 'f', name: 'F', stakes: 'gold', rewards: 'r', rate: { perDay: 0.001 } }] });
  assert.deepEqual(codes(check(spec, { now: NOW })), ['E-AMOUNT economy.farms.f.rate.perDay']);
});

test('a contest of NFTs counts its least pot in whole NFTs: 1.5 is refused, 2 and "2" check, and the plan counts NFTs', () => {
  const spec = (minPot) => ({ version: 2, network: 'devnet', name: 'Edge', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], contests: [{ key: 'c', name: 'C', sides: 2, stakeNft: { collection: A }, minPot }] });
  assert.deepEqual(codes(check(spec(1.5), { now: NOW })), ['E-CONTEST economy.contests.c.minPot']);
  for (const minPot of [2, '2']) {
    assert.deepEqual(codes(check(spec(minPot), { now: NOW })), []);
    const m = model(spec(minPot), { now: NOW });
    assert.equal(contestArgs(m.contests[0], m, NOW).min_pot, 2n, 'two NFTs, not two SOL in lamports');
  }
});

test('the empty pool of a farm that pays nothing keeps its number once live: a pool added later takes a free one', () => {
  const spec = base({ pools: [{ key: 'a', currency: 'gold' }], farms: [{ key: 'f', name: 'F', stakes: 'gold', tiers: [{ lock: '7d' }] }] });
  const numbers = (e) => Object.fromEntries(model(e).pools.map((p) => [p.key, p.index]));
  assert.deepEqual(numbers(spec), { a: 0, 'f-rewards': 1 });
  const landed = recordLanded(spec, { ctx: { project: A, treasury: A, authority: A, mints: { gold: A } } });
  assert.equal(landed.farms[0].rewardsIndex, 1);
  const grown = { ...landed, pools: [...landed.pools, { key: 'b', currency: 'gold' }] };
  assert.deepEqual(numbers(grown), { a: 0, b: 2, 'f-rewards': 1 });
  assert.deepEqual([...changedParts(grown).only], ['pool:b', 'seed:b']);
  assert.deepEqual(codes(check(grown, { now: NOW })), []);
  // Live before numbers were kept (an id, no rewardsIndex): the farm's pool still comes before the new one.
  const older = { ...grown, farms: [{ ...spec.farms[0], id: 1 }] };
  assert.deepEqual(numbers(older), { a: 0, b: 2, 'f-rewards': 1 });
  // A pool numbered as the farm's is refused.
  const clash = { ...grown, pools: [landed.pools[0], { key: 'b', currency: 'gold', index: 1 }] };
  assert.deepEqual(codes(check(clash, { now: NOW })), ['E-KEY-DUP economy.farms.f.rewardsIndex']);
});

test('a recipe’s tokens from a pool are counted in the pool’s token, not the game’s currency', () => {
  const spec = { version: 2, network: 'devnet', name: 'Edge', currency: 'gold', tokens: [{ key: 'gold', source: 'game' }, { key: 'gem', source: 'game' }], pools: [{ key: 'gems', currency: 'gem', seed: 1000 }], recipes: [{ key: 'r', name: 'R', in: [{ takes: 'pay', amount: 1, to: 'burn' }], out: [{ gives: 'tokens', amount: 5, from: 'pool:gems' }] }] };
  const sim = simulate(spec);
  assert.deepEqual(sim.perDay.players.getBack, { gem: 500 });
  assert.deepEqual(sim.recipes[0].gives, ['5 GEM']);
});

test('a lottery’s split leaves the rest of the ticket money to the pot, and the explainer says so', () => {
  const spec = { version: 2, network: 'devnet', name: 'Edge', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], pools: [{ key: 'dev', currency: 'sol' }], lotteries: [{ key: 'l', name: 'L', price: 0.1, every: '1d', split: [{ to: 'pool:dev', percent: 10 }], cutPercent: 5 }] };
  const line = explainEconomy(spec, { now: NOW }).text.split('\n').find((l) => /Buy tickets/.test(l));
  assert.match(line, /ticket money goes 10% to the pool “dev”, 5% to your treasury, 85% into the pot/);
  assert.doesNotMatch(line, /% to your treasury\./);
});

test('the oracle’s daily fee names the grants whose prize is a roll', () => {
  const spec = base({ items: [{ key: 'sword', name: 'Sword' }], boxes: [{ key: 'chest', name: 'Chest', price: 1, active: false, outcomes: [{ gives: 'item', item: 'sword', chance: 50 }, { gives: 'nothing', chance: 50 }] }], grants: [{ key: 'g', name: 'G', prize: { gives: 'roll', box: 'chest' }, limits: { perWallet: 1 } }], scenario: { perDay: { 'grant:g': 5 } } });
  const line = explain(simulate(spec), spec).split('\n').find((l) => /oracle also/.test(l));
  assert.match(line, /a day for the rolls grants give, from/);
});

test('a contest with deciders and only "entriesClose" gets its result due an hour later; both at once is refused', () => {
  const spec = (contest) => ({ version: 2, network: 'devnet', name: 'Edge', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], contests: [{ key: 'c', name: 'C', sides: 2, deciders: [D], ...contest }] });
  const m = model(spec({ entriesClose: '1h' }), { now: NOW });
  const args = contestArgs(m.contests[0], m, NOW);
  assert.deepEqual([args.closes_at, args.result_by], [BigInt(NOW + 3600), BigInt(NOW + 7200)]);
  assert.deepEqual(codes(check(spec({ entriesClose: '1h' }), { now: NOW })), []);
  assert.deepEqual(codes(check(spec({ entriesClose: '1h', resultDue: '1h' }), { now: NOW })), ['E-CONTEST economy.contests.c']);
  // With no deciders, entries may close when the result is due.
  const plain = { ...spec({ entriesClose: '1h', resultDue: '1h' }) };
  delete plain.contests[0].deciders;
  assert.deepEqual(codes(check(plain, { now: NOW })), []);
});

test('every percent the program counts in hundredths is refused when finer, and a fine fee says no infinite chunk', () => {
  const spec = base({
    tokens: [{ key: 'gold', source: 'game', decimals: 6 }, { key: 'fee', source: 'existing', mint: A, decimals: 6, powers: { transferFeePercent: 0.001 } }],
    items: [{ key: 'badge', name: 'Badge' }],
    pools: [{ key: 'r', currency: 'gold' }, { key: 'sink', currency: 'gold' }, { key: 'fr', currency: 'fee', seed: 1 }],
    farms: [
      { key: 'f', name: 'F', stakes: 'gold', rewards: 'r', exitFeeTo: 'pool:sink', toll: { percent: 1.234, to: 'burn' }, tiers: [{ lock: '7d', exitFee: 2.555 }], boosts: [{ when: { item: 'badge' }, add: { addPercent: 10.001 } }], maxBoostPercent: 150.005 },
      { key: 'g', name: 'G', stakes: 'gold', rewards: 'fr' },
    ],
  });
  const r = check(spec, { now: NOW });
  assert.deepEqual(codes(r).sort(), [
    'E-PERCENT economy.farms.f.boosts[0].add.addPercent',
    'E-PERCENT economy.farms.f.maxBoostPercent',
    'E-PERCENT economy.farms.f.tiers[0].exitFee',
    'E-PERCENT economy.farms.f.toll.percent',
    'E-PERCENT economy.tokens[1].powers.transferFeePercent',
  ]);
  assert.ok(!JSON.stringify(r).includes('∞'));
});

test('a craft that moves a hooked token warns of the hook’s accounts: a pay line in the default currency, tokens from a pool', () => {
  const spec = (recipe) => ({ version: 2, network: 'devnet', name: 'Edge', currency: 'hk', tokens: [{ key: 'hk', source: 'existing', mint: A, decimals: 2, powers: { transferHook: true } }], items: [{ key: 'sword', name: 'Sword' }], pools: [{ key: 'p', currency: 'hk', seed: 100 }], recipes: [{ key: 'r', name: 'R', ...recipe }] });
  const hooked = (recipe) => warned(check(spec(recipe), { now: NOW }), 'W-TX-SIZE').some((w) => /transfer hook/.test(w.message));
  assert.ok(hooked({ in: [{ takes: 'pay', amount: 1, to: 'pool:p' }], out: [{ gives: 'item', item: 'sword' }] }), 'a pay line in the default currency');
  assert.ok(hooked({ in: [], out: [{ gives: 'tokens', amount: 1, from: 'pool:p' }] }), 'tokens from a pool of the hooked token');
});

test('an item named "Secret: Blade" is no secret; a credential is still caught', () => {
  const spec = { version: 2, network: 'devnet', name: 'Edge', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], items: [{ key: 'blade', name: 'Secret: Blade', price: 1 }] };
  assert.deepEqual(codes(check(spec, { now: NOW })), []);
  for (const caught of ['api_key: abc', 'private key = x', 'secret=AbCdEf0123456789xyz', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'https://rpc.example/?api-key=1'])
    assert.equal(findSecrets(caught).length, 1, caught);
  assert.deepEqual(findSecrets({ apiKey: 'x' }), ['economy.apiKey']);
  assert.deepEqual(findSecrets({ name: 'Bearer of Light', about: 'The secret: keep walking' }), []);
});

test('a minting schedule that halves and stops counts what it mints in all', () => {
  const spec = base({ tokens: [{ key: 'gold', source: 'game' }], pools: [{ key: 'p', currency: 'gold' }], schedules: [{ key: 's', name: 'S', does: 'issue', pool: 'p', amount: 100, every: '1d', halveEvery: 10, maxRuns: 25 }] });
  // 10 runs at 100, 10 at 50, 5 at 25
  assert.equal(simulate(spec).schedules[0].mintsInAll, 1625);
  const endless = { ...spec, schedules: [{ ...spec.schedules[0], maxRuns: undefined }] };
  assert.equal(simulate(endless).schedules[0].mintsInAll, 2000);
});

test('W-PRIZE-SEED is said once for a pool two boxes pay from, naming the largest prize', () => {
  const box = (key, amount) => ({ key, name: key, price: 1, outcomes: [{ gives: 'pay', pool: 'p', amount, chance: 50 }, { gives: 'nothing', chance: 50 }] });
  const spec = base({ tokens: [{ key: 'gold', source: 'game' }], pools: [{ key: 'p', currency: 'gold', seed: 1 }], boxes: [box('small', 5), box('big', 50)] });
  const w = warned(check(spec, { now: NOW }), 'W-PRIZE-SEED');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /a win in “big” pays 50 GOLD/);
  assert.match(w[0].message, /“small” pays fixed prizes from it too/);
});

test('an old version is refused once (E-VERSION), not again by the schema', () => {
  assert.deepEqual(codes(check({ ...base(), version: 1 }, { now: NOW })), ['E-VERSION economy.version']);
});

test('a farm’s growth may not write under a name the program keeps, "origin" included', () => {
  const spec = base({ items: [{ key: 'hero', name: 'Hero' }], pools: [{ key: 'r', currency: 'gold' }], farms: [{ key: 'f', name: 'F', stakes: 'collectibles', item: 'hero', rewards: 'r', rate: { perDay: 1, minted: true }, growth: { attribute: 'origin', perDay: 1 } }] });
  assert.ok(codes(check(spec, { now: NOW })).includes('E-FARM economy.farms.f.growth'));
});

test('a mission’s roll is explained from its box’s own outcomes', () => {
  const spec = base({
    tokens: [{ key: 'gold', source: 'game' }],
    items: [{ key: 'hero', name: 'Hero' }],
    pools: [{ key: 'r', currency: 'gold' }],
    boxes: [{ key: 'quest', name: 'Quest', price: 0, active: false, rollsOn: { item: 'hero' }, outcomes: [{ gives: 'tokens', from: 'mint', amount: 5, chance: 50, shifts: [{ attribute: 'level', by: 1, upTo: 10 }] }, { gives: 'nothing', chance: 30 }, { gives: 'nothing', chance: 20, then: 'burn' }] }],
    farms: [{ key: 'f', name: 'F', stakes: 'collectibles', item: 'hero', rewards: 'r', rate: { perDay: 1, minted: true }, tiers: [{ lock: '1d', roll: 'quest' }] }],
  });
  const text = explainEconomy(spec, { now: NOW }).text;
  assert.match(text, /rolled on “Quest” \(its result: \+1 level and 5 GOLD, minted; nothing changes; or the NFT burned\)/);
  assert.doesNotMatch(text, /a stat lost/);
});
