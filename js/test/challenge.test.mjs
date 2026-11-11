// Traps the program takes as written, each from a game that went live with it: a prize draw whose entries are bought
// with the game's token (100 BUBL burned into a pool for an entry), one free entry for everyone, a recipe that turns an
// entry back into BUBL, two draws that draw once and need 100 tickets each, played by two people.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { review } from '../economy/review.mjs';

const NOW = Date.parse('2026-11-11T11:00:00Z') / 1000;
const VOUCHER = 'HUQP6e86RqbkpPoKaAddwpe8bn81jVMqeTZbrrXm5VpD';
const draw = (key, firstDraw) => ({
  key,
  name: key,
  price: 1,
  currency: 'entry',
  rest: 'burn',
  places: [{ percent: 0, prize: { gives: 'item', item: 'winner' } }],
  firstDraw,
  minSold: 100,
});
const spec = () => ({
  version: 2,
  network: 'devnet',
  name: 'Prize Day',
  currency: 'bubl',
  tokens: [
    { key: 'sol', source: 'sol' },
    { key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL', decimals: 0, supply: 2_000_000 },
    { key: 'entry', source: 'project', name: 'Entry', symbol: 'ENTRY', decimals: 0 },
  ],
  pools: [{ key: 'taps', currency: 'bubl', seed: 2_000_000 }],
  items: [{ key: 'winner', name: 'Prize Ticket', soulbound: true, supply: 1 }],
  grants: [
    {
      key: 'pops',
      name: 'Popped bubbles',
      prize: { gives: 'tokens', amount: 12000, from: 'pool:taps', currency: 'bubl' },
      vouchers: [VOUCHER],
      trust: 'bounds',
      limits: { perPerson: 2000, perDay: 20000, total: 100000 },
    },
    {
      key: 'free-entry',
      name: 'Free entry',
      prize: { gives: 'tokens', amount: 1, from: 'mint', currency: 'entry' },
      vouchers: [VOUCHER],
      trust: 'decides',
      limits: { perPerson: 1, perWallet: 1, perDay: 5000, total: 10000 },
    },
  ],
  recipes: [
    {
      key: 'entry',
      name: 'Entry for 100 BUBL',
      in: [{ takes: 'pay', amount: 100, currency: 'bubl', to: 'pool:taps' }],
      out: [{ gives: 'tokens', amount: 1, from: 'mint', currency: 'entry' }],
    },
    {
      key: 'cashout',
      name: '100 BUBL for an Entry',
      in: [{ takes: 'pay', amount: 1, currency: 'entry', to: 'treasury' }],
      out: [{ gives: 'tokens', amount: 100, from: 'pool:taps', currency: 'bubl' }],
    },
  ],
  lotteries: [draw('draw', '2026-11-11T17:00:00Z'), draw('draw2', '2026-11-12T17:00:00Z')],
  scenario: { days: 1, players: 2, perDay: { 'lottery:draw': 8, 'lottery:draw2': 8 } },
});
const warned = (s, code) =>
  check(s, { now: NOW })
    .warnings.filter(w => w.code === code)
    .map(w => w.where);

test('a cancelled round refunds the ticket token, not what was paid for it', () => {
  assert.deepEqual(warned(spec(), 'W-REFUND-NOT-PAID'), [
    'economy.lotteries.draw.minSold',
    'economy.lotteries.draw2.minSold',
  ]);
  // Tickets priced in BUBL itself: a refund pays BUBL back.
  const own = spec();
  for (const l of own.lotteries) Object.assign(l, { currency: 'bubl', price: 100 });
  assert.deepEqual(warned(own, 'W-REFUND-NOT-PAID'), []);
  // No least sale: no round is cancelled short.
  const none = spec();
  for (const l of none.lotteries) delete l.minSold;
  assert.deepEqual(warned(none, 'W-REFUND-NOT-PAID'), []);
});

test('a way back from the ticket token, open at all times, undoes any purchase', () => {
  assert.deepEqual(warned(spec(), 'W-SWAP-BACK-OPEN'), ['economy.recipes.cashout']);
  const off = spec();
  off.recipes[1].active = false;
  assert.deepEqual(warned(off, 'W-SWAP-BACK-OPEN'), []);
  const timed = spec();
  Object.assign(timed.recipes[1], { opens: '2026-11-12T18:00:00Z', closes: '2026-11-19T18:00:00Z' });
  assert.deepEqual(warned(timed, 'W-SWAP-BACK-OPEN'), []);
});

test('a free entry that is also sold and turns back into BUBL is worth the paid one', () => {
  const [w] = check(spec(), { now: NOW }).warnings.filter(x => x.code === 'W-FREE-IS-PAID');
  assert.equal(w.where, 'economy.grants.free-entry');
  assert.match(w.message, /each claim is worth 100 BUBL/);
  // Switched off, the way back still counts: the project can switch it on.
  const off = spec();
  off.recipes[1].active = false;
  assert.match(
    check(off, { now: NOW }).warnings.find(x => x.code === 'W-FREE-IS-PAID').message,
    /once it is switched on/,
  );
  // With no way back an entry is only an entry; and the game's own currency given as a reward is what grants are for.
  const oneWay = spec();
  oneWay.recipes.pop();
  assert.deepEqual(warned(oneWay, 'W-FREE-IS-PAID'), []);
});

test('a least sale above what the scenario’s players buy before the draw, and when it can still change', () => {
  const ws = check(spec(), { now: NOW }).warnings.filter(x => x.code === 'W-MINSOLD-VS-SCENARIO');
  assert.deepEqual(
    ws.map(w => w.where),
    ['economy.lotteries.draw.minSold', 'economy.lotteries.draw2.minSold'],
  );
  assert.match(ws[0].message, /sells about 2 \(8 a day\)/);
  assert.match(ws[0].message, /only before the round's first ticket/);
  // Two players buying at most 5 tickets each.
  const capped = spec();
  for (const l of capped.lotteries) l.perWallet = 5;
  capped.scenario.perDay = { 'lottery:draw': 3000, 'lottery:draw2': 3000 };
  assert.match(
    check(capped, { now: NOW }).warnings.find(x => x.code === 'W-MINSOLD-VS-SCENARIO').message,
    /about 10 \(2 players, at most 5 each\)/,
  );
  const busy = spec();
  delete busy.scenario.players;
  busy.scenario.perDay = { 'lottery:draw': 3000, 'lottery:draw2': 3000 };
  assert.deepEqual(warned(busy, 'W-MINSOLD-VS-SCENARIO'), []);
});

test('a ticket the player crafts first points to make, one approval for both', () => {
  const ws = check(spec(), { now: NOW }).warnings.filter(x => x.code === 'W-TWO-PROMPTS');
  assert.deepEqual(
    ws.map(w => w.where),
    ['economy.lotteries.draw', 'economy.lotteries.draw2'],
  );
  assert.match(ws[0].fix, /make: \{ recipe: “entry”, times: count, listing \}/);
  // Tickets in the game's currency need no craft.
  const own = spec();
  for (const l of own.lotteries) Object.assign(l, { currency: 'bubl', price: 100 });
  assert.deepEqual(warned(own, 'W-TWO-PROMPTS'), []);
});

test('a token still given after the last draw it was good for', () => {
  // The way back is switched off: after the second draw an entry does nothing.
  const off = spec();
  off.recipes[1].active = false;
  assert.deepEqual(warned(off, 'W-AFTER-THE-END'), ['economy.grants.free-entry', 'economy.recipes.entry']);
  // The recipe closes at the last draw, the grant is switched off: nothing is given after it.
  const ends = structuredClone(off);
  ends.recipes[0].closes = '2026-11-12T17:00:00Z';
  ends.grants[1].active = false;
  assert.deepEqual(warned(ends, 'W-AFTER-THE-END'), []);
  // A lottery that repeats keeps the token useful.
  const again = structuredClone(off);
  again.lotteries[1].every = '1d';
  assert.deepEqual(warned(again, 'W-AFTER-THE-END'), []);
});

test('explain and the review end with each route, state by state, as a player, the owner and a cheater see it', () => {
  const s = spec();
  s.recipes[1].active = false;
  const text = explainEconomy(s, { now: NOW }).text;
  const walk = text.slice(text.indexOf('Each route, state by state'));
  assert.ok(text.endsWith(walk.trimEnd()) && walk.length > 0, 'the walk-through is the last part');
  const draw = walk.slice(walk.indexOf('“draw”: a lottery'), walk.indexOf('“draw2”'));
  for (const state of [
    'Before it opens',
    'While it runs',
    'Cancelled or failed',
    'Won',
    'After it ends',
    'A change of mind',
    'Only before the first ticket',
  ])
    assert.match(draw, new RegExp(`- ${state}: `), state);
  for (const who of ['Player:', 'Owner:', 'Cheater:']) assert.ok(draw.includes(who), who);
  assert.match(draw, /refunded in ENTRY/);
  assert.match(draw, /“100 BUBL for an Entry” turns it back once the project switches it on/);
  assert.match(walk, /“100 BUBL for an Entry”: a recipe\n {2}- Before it opens: It is switched off/);
  assert.match(review(s, { now: NOW }).tradeoffs, /Each route, state by state/);
  const r = review(spec(), { now: NOW });
  assert.ok(r.findings.some(f => f.id === 'R-SWAP-BACK-OPEN' && f.severity === 'medium'));
});
