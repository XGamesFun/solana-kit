// The analyses that challenge a spec (follow the value, one intent one step, check every assumption) and the
// walk-through, on a game that went live with the traps they find: a prize draw whose entries are bought
// with the game's token (100 BUBL burned into a pool for an entry), one free entry for everyone, a recipe that turns an
// entry back into BUBL, two draws that draw once and need 100 tickets each, played by two people.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

/** Where `code` warned, for the warnings whose message names `situation` ("cancelled", "undone"...) before a colon. */
const found = (s, code, situation = '') =>
  check(s, { now: NOW })
    .warnings.filter(w => w.code === code && (!situation || w.message.includes(`${situation}:`)))
    .map(w => w.where);

test('three analyses, three codes: the situation each found is in its message', () => {
  const codes = new Set(
    check(spec(), { now: NOW })
      .warnings.map(w => w.code)
      .filter(c => ['W-VALUE', 'W-STEPS', 'W-ASSUMPTION'].includes(c)),
  );
  assert.deepEqual([...codes].sort(), ['W-ASSUMPTION', 'W-STEPS', 'W-VALUE']);
  const r = review(spec(), { now: NOW });
  assert.ok(r.findings.some(f => f.id === 'R-VALUE' && f.severity === 'high'));
  assert.ok(r.findings.some(f => f.id === 'R-ASSUMPTION' && f.severity === 'high'));
  assert.ok(r.findings.some(f => f.id === 'R-STEPS' && f.severity === 'low'));
});

test('follow the value, cancelled: a refund in the ticket token, not what was paid for it', () => {
  assert.deepEqual(found(spec(), 'W-VALUE', 'cancelled'), ['economy.lotteries.draw', 'economy.lotteries.draw2']);
  // Tickets priced in BUBL itself: a refund pays BUBL back.
  const own = spec();
  for (const l of own.lotteries) Object.assign(l, { currency: 'bubl', price: 100 });
  assert.deepEqual(found(own, 'W-VALUE', 'cancelled'), []);
  // No least sale: a round the oracle never answers is still cancelled, and refunded in the ticket token.
  const none = spec();
  for (const l of none.lotteries) delete l.minSold;
  const [w] = check(none, { now: NOW }).warnings.filter(x => x.code === 'W-VALUE' && x.message.includes('cancelled:'));
  assert.match(w.message, /a draw the oracle hasn't answered 7 days after it was asked/);
  assert.equal(w.severity, 'low', 'only the oracle’s timeout: rare');
  assert.doesNotMatch(w.message, /short of/);
});

test('follow the value, undone: a way back from the ticket token, open at all times', () => {
  assert.deepEqual(found(spec(), 'W-VALUE', 'undone'), ['economy.recipes.cashout']);
  const off = spec();
  off.recipes[1].active = false;
  assert.deepEqual(found(off, 'W-VALUE', 'undone'), []);
  const timed = spec();
  Object.assign(timed.recipes[1], { opens: '2026-11-12T18:00:00Z', closes: '2026-11-19T18:00:00Z' });
  assert.deepEqual(found(timed, 'W-VALUE', 'undone'), []);
});

test('follow the value, from nothing: a free entry that is also sold and turns back into BUBL', () => {
  const [w] = check(spec(), { now: NOW }).warnings.filter(
    x => x.code === 'W-VALUE' && x.message.includes('from nothing'),
  );
  assert.equal(w.where, 'economy.grants.free-entry');
  assert.match(w.message, /each claim is worth 100 BUBL/);
  // Switched off, the way back still counts: the project can switch it on.
  const off = spec();
  off.recipes[1].active = false;
  assert.match(
    check(off, { now: NOW }).warnings.find(x => x.code === 'W-VALUE' && x.message.includes('from nothing')).message,
    /once it is switched on/,
  );
  // With no way back an entry is only an entry; the game's own currency given as a reward is what grants are for.
  const oneWay = spec();
  oneWay.recipes.pop();
  assert.deepEqual(found(oneWay, 'W-VALUE', 'from nothing'), []);
});

test('follow the value, after the end: a token still given after the last draw it was good for', () => {
  // The way back is switched off: after the second draw an entry does nothing.
  const off = spec();
  off.recipes[1].active = false;
  assert.deepEqual(found(off, 'W-VALUE', 'after the end'), ['economy.grants.free-entry', 'economy.recipes.entry']);
  // The recipe closes at the last draw, the grant is switched off: nothing is given after it.
  const ends = structuredClone(off);
  ends.recipes[0].closes = '2026-11-12T17:00:00Z';
  ends.grants[1].active = false;
  assert.deepEqual(found(ends, 'W-VALUE', 'after the end'), []);
  // A lottery that repeats keeps the token useful.
  const again = structuredClone(off);
  again.lotteries[1].every = '1d';
  assert.deepEqual(found(again, 'W-VALUE', 'after the end'), []);
});

test('one intent, one step: a price the player crafts first points to make, one approval for both', () => {
  const ws = check(spec(), { now: NOW }).warnings.filter(x => x.code === 'W-STEPS');
  assert.deepEqual(
    ws.map(w => w.where),
    ['economy.lotteries.draw', 'economy.lotteries.draw2'],
  );
  assert.match(ws[0].fix, /make: \{ recipe: "entry", times: count, listing \}/);
  // Tickets in the game's currency need no craft.
  const own = spec();
  for (const l of own.lotteries) Object.assign(l, { currency: 'bubl', price: 100 });
  assert.deepEqual(found(own, 'W-STEPS'), []);
  // A box priced in the crafted token: the same two steps.
  const box = spec();
  box.boxes = [
    {
      key: 'chest',
      name: 'Chest',
      price: 2,
      currency: 'entry',
      outcomes: [{ gives: 'item', item: 'winner', weight: 1 }],
    },
  ];
  assert.ok(found(box, 'W-STEPS').includes('economy.boxes.chest'));
});

test('check every assumption: a least sale above what the scenario’s players buy, and when it can change', () => {
  const ws = check(spec(), { now: NOW }).warnings.filter(
    x => x.code === 'W-ASSUMPTION' && x.where.endsWith('.minSold'),
  );
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
    check(capped, { now: NOW }).warnings.find(x => x.code === 'W-ASSUMPTION').message,
    /about 10 \(2 players, at most 5 each\)/,
  );
  const busy = spec();
  delete busy.scenario.players;
  busy.scenario.perDay = { 'lottery:draw': 3000, 'lottery:draw2': 3000 };
  assert.deepEqual(
    found(busy, 'W-ASSUMPTION').filter(w => w.endsWith('.minSold')),
    [],
  );
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
  assert.match(draw, /refunds every ticket in ENTRY/);
  assert.match(draw, /“100 BUBL for an Entry” turns it back once the project switches it on/);
  assert.match(walk, /“100 BUBL for an Entry”: a recipe\n {2}- Before it opens: It is switched off/);
  assert.match(review(s, { now: NOW }).tradeoffs, /Each route, state by state/);
});

test('the worked example of sentence-to-spec.md checks, and explain puts every legal flag under the law', () => {
  const md = readFileSync(
    new URL('../../skills/xsolana-economy/references/sentence-to-spec.md', import.meta.url),
    'utf8',
  );
  const from = md.indexOf('```json', md.indexOf('## Worked example')) + '```json'.length;
  const fishing = JSON.parse(md.slice(from, md.indexOf('```', from)));
  const r = check(fishing, { now: NOW });
  assert.ok(r.ok, r.refusals.map(x => x.code).join());
  assert.deepEqual(r.warnings.map(w => w.code).sort(), ['W-CHANCE-PRIZE', 'W-FEE']);
  // A paid box of random collectibles a player can resell: W-CHANCE-ITEMS, a legal flag, goes in the law's section.
  const gacha = structuredClone(fishing);
  gacha.items[0].kind = 'collectible';
  delete gacha.lotteries;
  gacha.boxes[0].split = [{ to: 'pool:pond', percent: 55 }];
  gacha.boxes[0].outcomes = [
    { gives: 'item', item: 'perch', chance: 50 },
    { gives: 'nothing', chance: 50 },
  ];
  const text = explainEconomy(gacha, { now: NOW }).text;
  const law = text.slice(text.indexOf('Flagged for the law'), text.indexOf('Know before going live'));
  assert.ok(
    check(gacha, { now: NOW }).warnings.some(w => w.code === 'W-CHANCE-ITEMS'),
    'the gacha is flagged W-CHANCE-ITEMS',
  );
  assert.match(law, /resell/i);
});
