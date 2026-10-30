// The quick simulation's money flows and words: where a recipe's and a schedule's payment lands (the treasury, a
// lottery's pot), what a lottery ticket really costs (what comes back is held, not spent), an auction of NFT bids, a
// falling price on a shared clock, a lottery that draws once, a scenario of no days, and what the scenario assumes
// for what it doesn't name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { explain, simulate } from '../economy/simulate.mjs';

const NOW = 1_000_000_000;
const exampleSpec = (name) => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
/** Checks `spec` (it must pass) and simulates it. */
const sim = (spec) => {
  const v = check(spec, { now: NOW });
  assert.ok(v.ok, v.refusals.map((r) => `${r.code} ${r.message}`).join('\n'));
  return simulate(spec, { now: NOW });
};
const solSpec = (more) => ({ version: 2, network: 'devnet', name: 'T', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'T' }, ...more });
const gold = { version: 2, network: 'devnet', name: 'G', currency: 'gold', tokens: [{ key: 'gold', source: 'game', name: 'Gold', symbol: 'GLD', decimals: 0 }], collection: false };

test('a recipe’s pay line to the treasury lands in the treasury, and one to a lottery in its pot', () => {
  const spec = solSpec({
    items: [{ key: 'sword', name: 'Sword', value: 0.1 }],
    recipes: [
      { key: 'fee', name: 'Fee', in: [{ takes: 'pay', amount: 1, currency: 'sol', to: 'treasury' }], out: [{ gives: 'item', item: 'sword' }] },
      { key: 'entry', name: 'Entry', in: [{ takes: 'pay', amount: 0.5, currency: 'sol', to: 'lottery:draw' }], out: [{ gives: 'item', item: 'sword' }] },
    ],
    lotteries: [{ key: 'draw', name: 'Draw', price: 0.01, places: [100], every: '1d' }],
    scenario: { days: 30, perDay: { 'recipe:fee': 10, 'recipe:entry': 4, 'lottery:draw': 0 } },
  });
  const s = sim(spec);
  assert.equal(s.perDay.creator.treasury.sol, 10);
  assert.deepEqual(s.perDay.accounts, {});
  const pot = s.pools.find((p) => p.key === 'lottery:draw');
  assert.equal(pot.inPerDay, 2);
  assert.deepEqual(pot.ins, [{ by: 'recipe:entry', perDay: 2 }]);
});

test('a schedule that pays a lottery fills its pot, by a fixed amount or by a share', () => {
  const base = {
    ...gold,
    pools: [{ key: 'bank', currency: 'gold', seed: 1000 }],
    lotteries: [{ key: 'draw', name: 'Draw', price: 10, places: [100], every: '1d', noLoss: true }],
    scenario: { days: 30, perDay: { 'lottery:draw': 10 } },
  };
  const fixed = sim({ ...base, schedules: [{ key: 'mint', name: 'Mint', does: 'issue', pool: 'bank', amount: 1000, every: '1d' }, { key: 'feed', name: 'Feed', does: 'pay', from: 'bank', to: 'lottery:draw', amount: 100, every: '1d' }] });
  assert.equal(fixed.pools.find((p) => p.key === 'lottery:draw').inPerDay, 100);
  assert.deepEqual(fixed.perDay.accounts, {});
  const draw = fixed.lotteries[0];
  assert.equal(draw.potBeforeDraw, 100);
  assert.equal(draw.expectedPerTicket, 10, 'ten tickets share the 100 a round');
  const share = sim({ ...base, schedules: [{ key: 'feed', name: 'Feed', does: 'pay', from: 'bank', to: 'lottery:draw', percent: 10, every: '1d' }] });
  const pot = share.pools.find((p) => p.key === 'lottery:draw');
  assert.ok(pot.inPerDay > 0, JSON.stringify(pot));
  assert.deepEqual(share.perDay.accounts, {});
});

test('a ticket’s “in all” leaves out what comes back: the purchase record’s rent, and a no-loss ticket’s price', () => {
  const plain = sim(solSpec({ lotteries: [{ key: 'draw', name: 'Draw', price: 0.01, places: [100], every: '1d' }] })).lotteries[0].realCost;
  assert.equal(plain.rentSol, 0);
  assert.equal(plain.totalSol, 0.012005, 'the price, the player fee and the network');
  assert.ok(plain.holdSol > plain.totalSol + plain.heldSol - 1e-9, 'the record is held while the round is open');
  const noLoss = sim(solSpec({ lotteries: [{ key: 'draw', name: 'Draw', price: 0.5, places: [100], every: '1d', noLoss: true, seed: 1 }] })).lotteries[0].realCost;
  assert.equal(noLoss.priceBack, true);
  assert.equal(noLoss.totalSol, 0.002005, 'only the player fee and the network leave for good');
  assert.ok(noLoss.holdSol > 0.5);
  const text = explain(sim(solSpec({ lotteries: [{ key: 'draw', name: 'Draw', price: 0.5, places: [100], every: '1d', noLoss: true, seed: 1 }] })), solSpec({ lotteries: [{ key: 'draw', name: 'Draw', price: 0.5, places: [100], every: '1d', noLoss: true, seed: 1 }] }));
  assert.match(text, /about 0\.002005 SOL in all \(the player fee, the network\); the wallet needs about [\d.]+ SOL when it signs, and the rest \(the ticket’s price and the purchase record’s rent\) comes back/);
});

test('an auction of NFT bids moves no money', () => {
  const spec = exampleSpec('artwork-auction');
  spec.auctions[0].bidNfts = { attribute: 'level' };
  spec.auctions[0].reserve = 3;
  delete spec.auctions[0].minRaise;
  delete spec.auctions[0].split;
  const s = sim(spec);
  const a = s.auctions[0];
  assert.equal(a.bidNfts, true);
  assert.equal(a.expectedPrice, null);
  assert.match(a.says, /goes for NFTs, not money/);
  assert.deepEqual(s.perDay.players.pay, {});
  assert.deepEqual(s.perDay.creator.treasury, {});
});

test('a price that falls on a shared clock keeps falling however often it sells', () => {
  const run = (clock) => {
    const spec = exampleSpec('falling-drop');
    spec.items[0].fall = { step: 0.05, every: '10m', floor: 0.2, start: 'publish', ...(clock ? { clock } : {}) };
    spec.scenario.perDay[`item:${spec.items[0].key}`] = 1000;
    spec.scenario.days = 1;
    delete spec.items[0].supply;
    const s = sim(spec);
    return { price: s.items[0].averagePrice ?? s.items[0].price, note: s.notes.find((n) => n.includes(spec.items[0].name)) };
  };
  const sale = run();
  const shared = run('shared');
  assert.equal(sale.price, 2, 'a sale every 86 s restarts a 10-minute countdown: it never falls');
  assert.ok(shared.price < 0.5, `the shared clock reaches its floor within the day: ${shared.price}`);
  assert.match(shared.note, /clock of its own, sales or not/);
  assert.doesNotMatch(shared.note, /restarts the countdown/);
});

test('a lottery that draws once is one round until its draw, with one oracle fee, and no return said for a prize with no price', () => {
  const spec = exampleSpec('nft-raffle');
  const s = sim(spec);
  const l = s.lotteries[0];
  assert.equal(l.drawsOnce, true);
  assert.equal(l.roundDays, 3, 'from going live to its first draw');
  assert.equal(l.ticketsPerRound, 300);
  assert.equal(l.unpricedPrizes, true);
  assert.equal(l.returnPercent, null);
  const days = s.scenario.days;
  assert.ok(Math.abs(s.perDay.creator.oracleFeesSol - s.fees.oracleSol / days) < 1e-9, 'one draw over the scenario');
  assert.ok(Math.abs(s.perDay.players.pay.sol - (300 * 0.1) / days) < 1e-9, 'its tickets, spread over the scenario');
  const text = explain(s, spec);
  assert.match(text, /300 tickets in its one round of 3 days \(it draws once\)/);
  assert.doesNotMatch(text, /round of 1 days|\(0%\)/);
  const words = explainEconomy(spec, { now: NOW }).text;
  assert.match(words, /a ticket is worth 0 on average, plus its chance at the places’ prizes/);
  assert.doesNotMatch(words, /\(0%\)/);
});

test('a scenario of no days gives numbers, never Infinity', () => {
  const spec = exampleSpec('artwork-auction');
  spec.scenario = { ...(spec.scenario ?? {}), days: 0 };
  const s = sim(spec);
  assert.ok(Object.values(s.perDay.players.pay).every(Number.isFinite), JSON.stringify(s.perDay.players.pay));
  assert.doesNotMatch(explain(s, spec), /Infinity/);
});

test('an item nobody buys has no sold-out day', () => {
  const s = sim(solSpec({ items: [{ key: 'sword', name: 'Sword', price: 0.1, supply: 50 }], scenario: { perDay: { 'item:sword': 0 } } }));
  assert.equal('soldOutInDays' in s.items[0], false);
  const sold = sim(solSpec({ items: [{ key: 'sword', name: 'Sword', price: 0.1, supply: 50 }], scenario: { perDay: { 'item:sword': 10 } } }));
  assert.equal(sold.items[0].soldOutInDays, 5);
});

test('what the scenario assumes for what it doesn’t name is said as it is counted', () => {
  const spec = exampleSpec('artwork-auction');
  delete spec.scenario;
  const s = sim(spec);
  assert.match(explain(s, spec), /anything not named: 100 a day \(auction bids 10 a day\)/);
  assert.match(explainEconomy(spec, { now: NOW }).text, /Each day, if 100 of each thing happen \(auction bids 10 a day\)/);
});
