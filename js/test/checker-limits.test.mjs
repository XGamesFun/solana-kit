// What the checker refuses in words so that the setup plan never throws on a spec it passed: a token's source as the
// model reads it, times past what the program keeps, a sealed schedule's and a grant's amounts, the schema's oneOf,
// not and uniqueItems, and a setup step too big for one transaction.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { plan } from '../economy/plan.mjs';
import { findSecrets } from '../economy/secrets.mjs';
import { validate } from '../economy/validate.mjs';

const NOW = 1_800_000_000;
const A = 'So11111111111111111111111111111111111111113';
const W = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const example = (name) => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
const codes = (r) => r.refusals.map((x) => `${x.code} ${x.where}`);
/** Checks a spec, and when it passes, plans it: a spec the checker passed must plan without throwing. */
const checkAndPlan = (spec) => {
  const r = check(spec, { now: NOW });
  if (r.ok) assert.doesNotThrow(() => plan(spec, { now: NOW }), 'a spec the checker passed plans');
  return r;
};
const sol = (extra = {}) => ({ version: 2, network: 'devnet', name: 'Limits', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: false, ...extra });

test('a token of source "project" is checked as one of source "game": its Token-2022 program, its supply and its pools’ seeds', () => {
  for (const source of ['game', 'project']) {
    const token2022 = sol({ tokens: [{ key: 'sol', source: 'sol' }, { key: 'gold', source, program: 'token-2022' }] });
    assert.deepEqual(codes(checkAndPlan(token2022)), ['E-NOT-YET economy.tokens[1].program'], source);
    const seeded = sol({ tokens: [{ key: 'sol', source: 'sol' }, { key: 'gold', source, supply: 100 }], pools: [{ key: 'p', currency: 'gold', seed: 200 }] });
    assert.deepEqual(codes(checkAndPlan(seeded)), ['E-TOKEN economy.tokens[1].supply'], source);
    const fixed = sol({ tokens: [{ key: 'sol', source: 'sol' }, { key: 'gold', source, supply: 100 }], pools: [{ key: 'p', currency: 'gold', seed: 50 }] });
    assert.deepEqual(codes(checkAndPlan(fixed)), [], source);
  }
});

test('a token the project makes names no mint of its own', () => {
  for (const source of ['game', 'project']) {
    const spec = sol({ tokens: [{ key: 'sol', source: 'sol' }, { key: 'gold', source, mint: A }] });
    assert.deepEqual(codes(checkAndPlan(spec)), ['E-TOKEN economy.tokens[1].mint'], source);
  }
});

test('a time the program keeps in 4 bytes, or counts from go-live, is refused in words past what fits', () => {
  const at = (r) => r.refusals.filter((x) => x.code === 'E-TIME').map((x) => x.where);
  const tooLong = '8000w';
  let e = example('coin-flip-arena');
  e.farms[0].tiers[0].lock = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), ['economy.farms.' + e.farms[0].key + '.tiers[0].lock']);
  e = example('paper-hands-farm');
  e.farms[0].unbond = 4_294_967_296;
  assert.deepEqual(at(checkAndPlan(e)), ['economy.farms.' + e.farms[0].key + '.unbond']);
  e = example('stud-farm');
  const living = e.items.find((it) => it.life);
  living.life.readyAfter = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.items.${living.key}.life.readyAfter`]);
  e = example('falling-drop');
  const falling = e.items.find((it) => it.fall);
  falling.fall.every = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.items.${falling.key}.fall.every`]);
  e = example('shelter-fair');
  const limited = e.boxes.find((b) => b.perWalletEach);
  limited.perWalletEach.every = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.boxes.${limited.key}.perWalletEach.every`]);
  e = example('partner-vault');
  const windowed = e.grants.find((g) => g.limits?.perWalletEach);
  windowed.limits.perWalletEach.every = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.grants.${windowed.key}.limits.perWalletEach.every`]);
  // A raise's `by` is signed: half as much each way.
  e = example('elements-set');
  const r = e.recipes.find((x) => x.raises);
  r.raises[0].by = '4000w';
  r.raises[0].upTo = 4_294_967_296;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.recipes.${r.key}.raises[0].by`, `economy.recipes.${r.key}.raises[0].upTo`]);
  e = example('hero-trials');
  const shifting = e.boxes.find((b) => b.outcomes.some((o) => o.shifts));
  const o = shifting.outcomes.findIndex((x) => x.shifts);
  shifting.outcomes[o].shifts[0].upTo = 4_294_967_296;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.boxes.${shifting.key}.outcomes[${o}].shifts[0].upTo`]);
  // Counted from go-live into 8 bytes: a farm's end, a schedule's every.
  e = example('guild-missions');
  const ending = e.farms.find((f) => f.runs);
  ending.runs = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.farms.${ending.key}.runs`]);
  e = example('halving-seasons');
  e.schedules[0].every = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.schedules.${e.schedules[0].key}.every`]);
});

test('a sealed schedule gets the checks an unsealed one gets: its amounts in its token, and where it pays', () => {
  const spec = (schedule, extra = {}) => sol({ tokens: [{ key: 'sol', source: 'sol' }, { key: 'usd', source: 'existing', mint: A, decimals: 6 }], schedules: [Object.fromEntries(Object.entries({ key: 's', name: 'S', does: 'pay', sealed: true, currency: 'usd', to: `wallet:${W}`, amount: 1, fund: 10, every: '1d', maxRuns: 10, ...schedule }).filter(([, v]) => v !== undefined))], ...extra });
  assert.equal(checkAndPlan(spec({})).ok, true);
  assert.deepEqual(codes(checkAndPlan(spec({ amount: '0.0000001' }))), ['E-AMOUNT economy.schedules.s.amount']);
  assert.deepEqual(codes(checkAndPlan(spec({ fund: '0.0000001' }))), ['E-AMOUNT economy.schedules.s.fund']);
  assert.deepEqual(codes(checkAndPlan(spec({ fund: '99999999999999999999' }))), ['E-AMOUNT economy.schedules.s.fund']);
  assert.deepEqual(codes(checkAndPlan(spec({ to: 'pool:nope' }))), ['E-REF economy.schedules.s.to']);
  assert.deepEqual(codes(checkAndPlan(spec({ to: 'lottery:nope' }))), ['E-REF economy.schedules.s.to']);
  assert.deepEqual(codes(checkAndPlan(spec({ to: 'nope' }))), ['E-SCHEDULE economy.schedules.s.to']);
  // A share of its vault into a pool of SOL: the pool holds another token.
  assert.deepEqual(codes(checkAndPlan(spec({ to: 'pool:sols', amount: undefined, percent: 10 }, { pools: [{ key: 'sols', currency: 'sol' }] }))), ['E-POOL-MINT economy.schedules.s.to']);
  assert.deepEqual(codes(checkAndPlan(spec({ to: 'lottery:l' }, { lotteries: [{ key: 'l', name: 'L', price: 0.1, every: '1d' }] }))), ['E-POOL-MINT economy.schedules.s.to']);
});

test('a grant’s funds are SOL to the lamport, and no more than the program counts', () => {
  const spec = (fund) => sol({ grants: [{ key: 'g', name: 'G', prize: { gives: 'tokens', amount: 0.01, from: 'pool:p' }, limits: { perWallet: 1 }, fund }], pools: [{ key: 'p', currency: 'sol', seed: 1 }] });
  assert.equal(checkAndPlan(spec(0.05)).ok, true);
  for (const fund of ['0.0000000001', '99999999999999999999']) assert.deepEqual(codes(checkAndPlan(spec(fund))), ['E-AMOUNT economy.grants.g.fund'], fund);
});

test('the schema’s oneOf, not and uniqueItems are kept: a lot is one of its forms, a raise moves by something, a list names each once', () => {
  let e = example('artwork-auction');
  for (const lot of [{}, { item: e.auctions[0].lot.item, roll: 'x' }]) {
    e.auctions[0].lot = lot;
    assert.deepEqual(codes(checkAndPlan(e)), ['E-SCHEMA economy.auctions[0].lot'], JSON.stringify(lot));
  }
  e = example('elements-set');
  const i = e.recipes.findIndex((r) => r.raises);
  e.recipes[i].raises[0].by = 0;
  assert.deepEqual(codes(checkAndPlan(e)), [`E-SCHEMA economy.recipes[${i}].raises[0].by`]);
  e = example('artwork-auction');
  e.collections = [A, A];
  assert.deepEqual(codes(checkAndPlan(e)), ['E-SCHEMA economy.collections[1]']);
  assert.deepEqual(validate({ version: 2, collections: [A, W] }), []);
  // The messages read as English.
  assert.deepEqual(validate({ version: 2, tokens: 'x' }).map((x) => x.message), ['must be an array']);
});

test('a setup step too big for one transaction is refused by the checker, not thrown on by the plan', () => {
  const mint = { gives: 'tokens', from: 'mint', currency: 'gold', amount: 1 };
  const spec = (n) => sol({ tokens: [{ key: 'sol', source: 'sol' }, { key: 'gold', source: 'project' }], boxes: [{ key: 'big', name: 'Big', price: 0.1, outcomes: Array.from({ length: n }, () => ({ gives: 'bundle', prizes: [mint, mint, mint], weight: 1 })) }] });
  assert.equal(checkAndPlan(spec(3)).ok, true);
  const r = checkAndPlan(spec(6));
  assert.deepEqual(codes(r), ['E-TX-SIZE economy.boxes.big']);
  assert.match(r.refusals[0].message, /The box “Big” takes \d+ bytes to set up/);
});

test('a prize’s seed is weighed in exact units', () => {
  const spec = (seed) => sol({ pools: [{ key: 'p', currency: 'sol', seed }], boxes: [{ key: 'b', name: 'B', price: 0.1, outcomes: [{ gives: 'tokens', from: 'pool:p', amount: '0.300000001', weight: 1 }, { gives: 'nothing', weight: 1 }] }] });
  const seedWarned = (seed) => check(spec(seed), { now: NOW }).warnings.some((w) => w.code === 'W-PRIZE-SEED');
  assert.equal(seedWarned('0.3'), true, 'a lamport short');
  assert.equal(seedWarned('0.300000001'), false);
});

test('a link’s ordinary query is no secret; a key in one still is', () => {
  for (const uri of ['https://example.com/meta.json?token=12', 'https://example.com/meta.json?sig=', 'https://example.com/a?key=hero']) assert.deepEqual(findSecrets(uri), [], uri);
  for (const uri of ['https://rpc.example/?api-key=1', 'https://rpc.example/?token=eyJhbGciOiJIUzI1NiJ9abcdef']) assert.equal(findSecrets(uri).length, 1, uri);
});

test('an auction of a roll says so in its setup step, and a pool a pay schedule drains is taken from', () => {
  const steps = plan(example('partner-vault'), { now: NOW }).steps.filter((s) => s.id.startsWith('auction:'));
  assert.ok(steps.length && steps.every((s) => /a roll of the box “/.test(s.says) && !/undefined/.test(s.says)), steps.map((s) => s.says).join('\n'));
  const spec = sol({ pools: [{ key: 'p', currency: 'sol', seed: 1 }], lotteries: [{ key: 'l', name: 'L', price: 0.1, every: '1d' }], schedules: [{ key: 's', name: 'S', does: 'pay', from: 'p', to: 'lottery:l', amount: 0.01, every: '1d' }] });
  const r = check(spec, { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.ok(!r.warnings.some((w) => w.code === 'W-POOL' && w.where === 'economy.pools.p'), 'the schedule takes from it');
});
