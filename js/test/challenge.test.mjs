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
  assert.equal(w.ask, undefined);
  // Burned for an entry: nothing can give it back, so even a rare cancel is the person's to decide when they ask.
  const burn = structuredClone(none);
  burn.recipes[0].in[0].to = 'burn';
  const [b] = check(burn, { now: NOW }).warnings.filter(x => x.code === 'W-VALUE' && x.message.includes('cancelled:'));
  assert.equal(b.severity, 'medium');
  assert.match(b.ask, /burned, and a cancelled round .* can only refund ENTRY/);
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
  // A box priced in the crafted token, which rolls.
  const box = spec();
  box.boxes = [
    {
      key: 'chest',
      name: 'Chest',
      price: 2,
      currency: 'entry',
      outcomes: [
        { gives: 'item', item: 'winner', weight: 1 },
        { gives: 'nothing', weight: 9 },
      ],
    },
  ];
  // Craft, then buy: two approvals (the roll is settled by the page's own key, no prompt), within the two a loop takes.
  assert.ok(!found(box, 'W-STEPS').includes('economy.boxes.chest'));
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

test('follow the value: a loop of recipes that gains, and a valued token minted for free faster than it burns', () => {
  const loop = spec();
  loop.recipes[1].out[0].amount = 150; // an entry back for 150 BUBL, bought for 100
  loop.recipes[1].active = true;
  const w = check(loop, { now: NOW }).warnings.find(x => x.code === 'W-VALUE' && x.message.includes('around a loop:'));
  assert.ok(w, 'a loop that gives 1.5 for 1');
  assert.equal(w.severity, 'high');
  assert.match(w.message, /gives back 1\.5 for each 1/);
  // ENTRY, which turns back into BUBL, minted free by a grant with no daily cap: net flow.
  const mint = spec();
  delete mint.grants[1].limits.perDay;
  delete mint.grants[1].limits.total;
  const flow = check(mint, { now: NOW }).warnings.find(x => x.code === 'W-VALUE' && x.message.includes('net flow:'));
  assert.ok(flow && /with no cap at all/.test(flow.message), flow?.message);
  // Its voucher server decides who earns: the bound lives there, one level lower, and the finding says so.
  assert.equal(flow.severity, 'medium');
  assert.match(flow.message, /the server holds this bound in practice/);
  // Capped at 5 a day, below the 8 a day the scenario burns (the first draw's "rest": "burn"): no flag.
  mint.grants[1].limits.perDay = 5;
  assert.ok(!check(mint, { now: NOW }).warnings.some(x => x.message.includes('net flow:')));
});

test('check every assumption: one item through two routes, a cap against the audience, who runs each step, a link fixed at mint', () => {
  const ws = check(spec(), { now: NOW }).warnings.filter(x => x.code === 'W-ASSUMPTION');
  assert.ok(ws.some(w => w.where === 'economy.items.winner' && /supply of 1 is shared/.test(w.message)));
  const asks = ws.filter(w => w.ask).map(w => w.ask);
  assert.equal(
    asks.filter(a => a.startsWith('Who runs the results server')).length,
    1,
    'one question for the voucher server',
  );
  assert.ok(asks.some(a => a.includes('who delivers the off-chain prize of “draw” and “draw2”')));
  assert.ok(asks.some(a => a.startsWith('Who asks for “draw”')));
  const few = spec();
  few.scenario.players = 20000;
  assert.ok(check(few, { now: NOW }).warnings.some(w => w.where === 'economy.grants.free-entry.limits.total'));
  const card = spec();
  card.items[0].kind = 'collectible';
  assert.ok(check(card, { now: NOW }).warnings.some(w => w.where === 'economy.items.winner.uri'));
});

test('the check tool asks the questions and shows each route’s cancel and change of mind', async () => {
  const { runTool } = await import('../mcp/server.mjs');
  const r = await runTool('xsolana_check', { spec: spec() }, { now: NOW });
  assert.match(r.text, /Ask the person before building on it[^\n]*:\n\? /);
  assert.match(r.text, /When it goes wrong or a player changes their mind/);
  assert.match(r.text, /“draw”, cancelled or failed: Anyone: refunds every ticket in ENTRY/);
});

test('follow the value through a farm: growth when rewards are staked again, payback of what a seat costs', () => {
  const farm = JSON.parse(readFileSync(new URL('../../examples/paper-hands-farm.json', import.meta.url), 'utf8'));
  // 5% a day minted on a stake of the same token, for 90 days: it doubles in about 14 days.
  farm.farms[0] = { ...farm.farms[0], rate: { perDay: 0.05, minted: true }, runs: '90d' };
  const grows = check(farm, { now: NOW }).warnings.find(w => w.message.includes('growth:'));
  assert.ok(grows, 'growth is reported');
  assert.match(grows.message, /doubling every 14\.2 days/);
  assert.equal(grows.severity, 'high');
  // No rate given and no stake in the scenario: what a seat earns is a question for the person.
  const plain = JSON.parse(readFileSync(new URL('../../examples/paper-hands-farm.json', import.meta.url), 'utf8'));
  assert.ok(check(plain, { now: NOW }).warnings.some(w => w.code === 'W-ASSUMPTION' && w.ask?.includes('staked')));
});

test('follow the value through a farm: a seat that earns back more than it costs, and earning items given away', () => {
  const s = JSON.parse(readFileSync(new URL('../../examples/paper-hands-farm.json', import.meta.url), 'utf8'));
  s.collection = { name: 'Land' };
  s.items = [{ key: 'deed', name: 'Deed', kind: 'collectible', uri: 'https://example.com/deed.json', price: 10 }];
  s.farms.push({
    key: 'land',
    name: 'The land',
    stakes: 'collectibles',
    item: 'deed',
    rewards: 'gem',
    custody: 'escrow',
    rate: { perDay: 1, minted: true },
    runs: '30d',
    tiers: [{ lock: 0, multiplier: 1 }],
  });
  s.grants = [
    { key: 'drop', name: 'Deed drop', prize: { gives: 'item', item: 'deed' }, limits: { total: 50, perWallet: 1 } },
  ];
  const ws = check(s, { now: NOW }).warnings;
  const payback = ws.find(w => w.message.includes('payback:'));
  assert.match(payback.message, /earns 30 GEM over 30 days at x1, against the 10 GEM it costs: 3× back/);
  assert.equal(payback.severity, 'high', 'some are given away free');
  assert.match(
    ws.find(w => w.message.includes('given away:')).message,
    /its 50 claims print up to 1500 GEM over 30 days\./,
  );
});

test('where each rule is kept: a contest’s decider, what it gains, and when the outcome can first be known', () => {
  const duel = JSON.parse(readFileSync(new URL('../../examples/duel-arena.json', import.meta.url), 'utf8'));
  const ws = check(duel, { now: NOW }).warnings.filter(w => w.code === 'W-ENFORCED');
  const key = ws.find(w => w.where === 'economy.contests.duel');
  assert.match(key.message, /authority key, which can also mint/);
  assert.equal(key.severity, 'medium');
  assert.ok(ws.some(w => w.ask?.includes('when can someone first learn the outcome of “Duel”')));
  // With a decider key, only the trust remains.
  duel.contests[0].deciders = ['HUQP6e86RqbkpPoKaAddwpe8bn81jVMqeTZbrrXm5VpD'];
  const decided = check(duel, { now: NOW }).warnings.find(
    w => w.code === 'W-ENFORCED' && w.where === 'economy.contests.duel',
  );
  assert.equal(decided.severity, 'low');
  assert.match(decided.message, /decider keys' signed verdict/);
});

test('the largest holder takes part: the owner’s fixed supply staked in a farm shared by stake', () => {
  const coin = JSON.parse(readFileSync(new URL('../../examples/community-coin.json', import.meta.url), 'utf8'));
  const w = check(coin, { now: NOW }).warnings.find(x => x.message.startsWith('The largest holder takes part'));
  assert.ok(w, 'the owner’s holding is followed into the farm');
  assert.match(w.message, /60% of its supply/);
  assert.equal(w.severity, 'high');
  assert.ok(w.ask);
});

test('loops across routes, the biggest payout, every way a round ends', async () => {
  const s = JSON.parse(readFileSync(new URL('../../examples/paper-hands-farm.json', import.meta.url), 'utf8'));
  s.collection = { name: 'Land' };
  s.items = [
    { key: 'deed', name: 'Deed', kind: 'collectible', uri: 'https://example.com/deed.json', price: 10, perWallet: 5 },
  ];
  s.farms.push({
    key: 'land',
    name: 'The land',
    stakes: 'collectibles',
    item: 'deed',
    rewards: 'gem',
    custody: 'escrow',
    rate: { perDay: 1, minted: true },
    runs: '30d',
    tiers: [{ lock: 0, multiplier: 1 }],
  });
  s.grants = [
    {
      key: 'spin',
      name: 'Daily spin',
      prize: { gives: 'tokens', amount: 5, from: 'mint', currency: 'gem' },
      limits: { perWalletEach: { count: 1, every: '1d' } },
    },
  ];
  const ws = check(s, { now: NOW }).warnings;
  const loop = ws.find(w => w.message.includes('around a loop:'));
  assert.match(
    loop.message,
    /buying “Deed” .* then staking in “The land” for 30 days .* One turn gives back 3 for each 1 put in/,
  );
  assert.match(loop.message, /5 a wallet bounds how often, not the edge/);
  assert.match(
    ws.find(w => w.message.includes('a day: the free')).message,
    /“Daily spin” pays a player about 5 GEM a day/,
  );
  const { runTool } = await import('../mcp/server.mjs');
  const text = (await runTool('xsolana_check', { spec: spec() }, { now: NOW })).text;
  assert.match(
    text,
    /> Every way “draw” ends: nothing sold: .* nobody asks for the draw: .* the oracle never answers: /,
  );
});

test('round 4: what to tell the person, scarce supply, a loop through the server, an outside token’s holders', async () => {
  const { runTool } = await import('../mcp/server.mjs');
  const text = (await runTool('xsolana_check', { spec: spec() }, { now: NOW })).text;
  assert.match(text, /Tell the person, as written/);
  assert.match(text, /> If “draw” is cancelled, a ticket's refund is ENTRY, not the 100 BUBL it was bought with\./);
  assert.match(
    text,
    /> “Popped bubbles”: each claim gives up to 12000 BUBL from “taps”; the caps count claims: .*2000 a person in all \(up to 24000000 BUBL\)/,
  );

  // A capped item for sale, demand unknown: ask; demand far over supply, resellable: high.
  const drop = spec();
  drop.items.push({ key: 'card', name: 'Card', price: 50, supply: 10 });
  delete drop.scenario.players;
  assert.ok(check(drop, { now: NOW }).warnings.some(w => w.where === 'economy.items.card.supply' && w.ask));
  drop.scenario.perDay = { ...drop.scenario.perDay, 'item:card': 100 };
  assert.equal(check(drop, { now: NOW }).warnings.find(w => w.where === 'economy.items.card.supply').severity, 'high');

  // The server turns ENTRY into 150 BUBL: a loop with the entry recipe, followed through "offchain".
  const server = spec();
  server.recipes.pop();
  server.offchain = [{ key: 'boost', name: 'Entry bonus', takes: 'entry', gives: 'bubl', rate: 150 }];
  const loop = check(server, { now: NOW }).warnings.find(w => w.message.includes('around a loop:'));
  assert.match(loop.message, /“Entry bonus” off chain/);

  // An outside token staked in a shared farm: who holds it is asked, then followed.
  const farm = JSON.parse(readFileSync(new URL('../../examples/paper-hands-farm.json', import.meta.url), 'utf8'));
  farm.tokens.push({
    key: 'gld',
    source: 'existing',
    mint: 'HUQP6e86RqbkpPoKaAddwpe8bn81jVMqeTZbrrXm5VpD',
    symbol: 'GLD',
    decimals: 6,
  });
  farm.farms.push({ key: 'vault', name: 'Vault', stakes: 'gld', rewards: 'gem', tiers: [{ lock: 0, multiplier: 1 }] });
  assert.ok(
    check(farm, { now: NOW }).warnings.some(
      w => w.where === 'economy.tokens.gld' && w.ask?.startsWith('Who holds GLD'),
    ),
  );
  farm.scenario = { holders: { gld: { supply: 1000, owner: 600 } } };
  assert.match(
    check(farm, { now: NOW }).warnings.find(w => w.message.startsWith('The largest holder')).message,
    /holds 600 GLD, 60% of its supply/,
  );
});

test('lessons: the cheapest of several paths, every ending told, odds that move, several at once, who controls what', async () => {
  // A Hat sold in the shop for 100 BUBL, and crafted from 2 ENTRY (100 BUBL each to buy, so 200): the shop is cheaper.
  const s = spec();
  s.collection = { name: 'Hats' };
  s.items.push({
    key: 'hat',
    name: 'Hat',
    kind: 'collectible',
    uri: 'https://example.com/hat.json',
    price: 40,
    supply: 50,
  });
  s.recipes.push({
    key: 'make-hat',
    name: 'Hat from entries',
    in: [{ takes: 'pay', amount: 2, currency: 'entry', to: 'burn' }],
    out: [{ gives: 'item', item: 'hat' }],
  });
  const paths = check(s, { now: NOW }).warnings.find(w => w.code === 'W-VALUE' && w.message.includes('its paths:'));
  assert.ok(paths, 'the paths to the Hat are compared');
  assert.match(
    paths.message,
    /buying “Hat” costs about 40 BUBL for one; crafting “Hat from entries” costs about 200 BUBL for one/,
  );
  assert.equal(paths.severity, 'medium', 'a Hat has a supply');
  const { runTool } = await import('../mcp/server.mjs');
  const text = (await runTool('xsolana_check', { spec: s }, { now: NOW })).text;
  assert.match(text, /> Every way “draw” ends: nothing sold: /);
  assert.match(text, /> Buying or opening several of “Hat from the shop” at once is one approval \(count: N\)/);
  const explained = explainEconomy(s, { now: NOW }).text;
  assert.match(explained, /Who controls what: the chain, your server, your owner key/);
  assert.match(explained, /any cap above can be raised or lowered/);
});

test('a limit the server keeps: declared, the tools count it; undeclared, they ask', async () => {
  // Popped bubbles takes the page's word within caps its server keeps, and says nothing of them: ask.
  const s = spec();
  s.grants[0].trust = 'bounds';
  assert.ok(
    check(s, { now: NOW }).warnings.some(
      w => w.where === 'economy.grants.pops' && w.ask?.includes('How much does your server let one person'),
    ),
  );
  // Declared: the Tell line says what it really pays beside what a leaked key could take, and the question is gone.
  s.grants[0].serverLimit = { per: 'person', amount: 1750, every: '1h' };
  const { runTool } = await import('../mcp/server.mjs');
  const text = (await runTool('xsolana_check', { spec: s }, { now: NOW })).text;
  assert.match(
    text,
    /Its server signs at most 1750 a person every 1h: that is what it really pays\. If its voucher key leaks/,
  );
  assert.ok(
    !check(s, { now: NOW }).warnings.some(
      w => w.where === 'economy.grants.pops' && w.ask?.includes('How much does your server'),
    ),
  );
  // A minted reward counted at its server's rate in the net flow: 50 a day for everyone, against what burns.
  const mint = spec();
  mint.grants[1] = {
    ...mint.grants[1],
    limits: { perWallet: 1 },
    serverLimit: { per: 'all', amount: 50, every: '1d' },
  };
  const flow = check(mint, { now: NOW }).warnings.find(w => w.message.includes('net flow:'));
  if (flow)
    assert.match(flow.message, /“Free entry”'s server signs at most 50 for everyone together every 1d, about 50 a day/);
});

test('a server conversion with no rate is asked about; a server’s total bounds what is given away', () => {
  const server = spec();
  server.recipes.pop();
  server.offchain = [{ key: 'boost', name: 'Entry bonus', takes: 'entry', gives: 'bubl' }];
  const ws = check(server, { now: NOW }).warnings;
  assert.ok(ws.some(w => w.ask?.startsWith('How much does “Entry bonus” give for each one it takes?')));
  const loop = ws.find(w => w.message.includes('around a loop:'));
  if (loop) assert.match(loop.message, /its rate not given: one for one/);
});

test('round 5: a fund against its audience, a contest’s every ending, who else holds the supply, a returning day', async () => {
  // Free entry's funds pay a few claims; 20000 players claim one each.
  const s = spec();
  s.grants[1].fund = 0.01;
  s.scenario.players = 20000;
  assert.ok(
    check(s, { now: NOW }).warnings.some(
      w => w.where === 'economy.grants.free-entry.fund' && /run out after about/.test(w.message),
    ),
  );
  delete s.scenario.players;
  assert.ok(check(s, { now: NOW }).warnings.some(w => w.where === 'economy.grants.free-entry.fund' && w.ask));
  // A contest: a tie, and a side nobody backed.
  const duel = JSON.parse(readFileSync(new URL('../../examples/duel-arena.json', import.meta.url), 'utf8'));
  const text = explainEconomy(duel, { now: NOW }).text;
  assert.match(text, /A tie, or a result nobody can call: /);
  assert.match(text, /Nobody on the winning side: naming a side nobody backed is refused \(NoWinner\)/);
  // A returning player's day.
  const { runTool } = await import('../mcp/server.mjs');
  assert.match(
    (await runTool('xsolana_check', { spec: spec() }, { now: NOW })).text,
    /> A returning player's day, doing each thing once: buy tickets of “draw” \(2\), buy tickets of “draw2” \(2\), collect wins \(1\): about 5 wallet approvals/,
  );
});

test('every cap against the pace the game allows: lifetime, a day’s, the server’s count against the chain’s', () => {
  const s = spec();
  Object.assign(s.grants[0], {
    serverLimit: { per: 'person', amount: 12000, claims: 1, every: '4m' },
    limits: { perPerson: 60, perDay: 500, total: 100000 },
  });
  const at = (x, end) => check(x, { now: NOW }).warnings.find(w => w.where === `economy.grants.pops.${end}`);
  const mine = at(s, 'limits.perPerson');
  assert.equal(mine.severity, 'medium');
  assert.match(mine.message, /reaches the cap in about 4 hours/);
  assert.match(
    mine.ask,
    /claim 60 times in all \(claims, not BUBL\).*done in about 4 hours\. Is 60 meant for good, or for a day\?/,
  );
  // Two players, each done after 60: 120 claims, under the day's 500; at 100, used up in hours, asked in their numbers.
  assert.equal(at(s, 'limits.perDay'), undefined);
  s.grants[0].limits.perDay = 100;
  const day = at(s, 'limits.perDay');
  assert.match(day.message, /about 120 a day, so the day's cap is used up about 3.3 hours into each day/);
  assert.match(day.ask, /^2 players claiming .* about 120 claims a day, and the chain takes 100 a day/);
  // The server counts BUBL only: how many claims is the question, and the caps are reached at least as soon.
  delete s.grants[0].serverLimit.claims;
  assert.match(at(s, 'serverLimit').ask, /server counts BUBL, while the chain counts claims .*how many times a day/);
  assert.match(at(s, 'limits.perPerson').message, /reaches the cap within about 4 hours/);
  // A server that signs more claims a day than the chain's window takes.
  const w = spec();
  Object.assign(w.grants[0], {
    serverLimit: { per: 'wallet', amount: 12000, claims: 1, every: '4m' },
    limits: { perWalletEach: { count: 5, every: '1d' } },
  });
  assert.match(at(w, 'limits.perWalletEach').message, /the server signs and counts a claim the chain refuses/);
  // A grant with no end: a lifetime cap reached after the scenario's days is still said, as low.
  const slow = spec();
  Object.assign(slow.grants[0], {
    serverLimit: { per: 'person', amount: 12000, claims: 2, every: '1d' },
    limits: { perPerson: 200 },
  });
  const far = at(slow, 'limits.perPerson');
  assert.equal(far.severity, 'low');
  assert.match(far.message, /no end \("until"\).*in about 100 days/);
  // A pace the spec doesn't state is not guessed.
  const none = spec();
  none.grants[0].limits = { perPerson: 60 };
  assert.equal(at(none, 'limits.perPerson'), undefined);
});
