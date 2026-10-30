// Every check keyed on "a box something rolls" counts the rolls a box's own outcomes (and a bundle's parts) make,
// followed through chains of rolls; the quick simulation's walk of moving prices is bounded once a simulation, not
// once a box or item, and a rise by a fixed step is summed at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { example } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { model, rollsOf } from '../economy/model.mjs';
import * as loot from '../client/index.js';
import IDL from '../client/idl/loot.js';
import { cannotRun, collectible, world } from './world.mjs';
import { salePrices, simulate, walkBudget } from '../economy/simulate.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_800_000_000;

// E-BOX refuses a hooked prize in a box a grant, a recipe, a mission, a lottery, a contest or an auction rolls, and
// also in one another box's outcome or bundle part rolls, or one a rolled box rolls in turn. On chain
// that roll is made at the outer box's settle (or a grant's round) and fails at its ask (PrizeHasHook), after the
// player paid; a one-step purchase of it is refused outright. The same list of rolls feeds W-STASH-SHARED, E-ROLL,
// W-ROLL-PRIZE and W-LIVE-ROLLS.
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const STASHED = ['4vd1uA3jK28MwhufZnbtQpyJkVMXEVpKHzDRPUH9DT3v', 'E53iEjsuDnz1jP6MJbnhecvTBRWCs5MsmjusfhYNDjD4'];
const spec = (parts, powers = { transferHook: true }) => ({
  version: 2,
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }, { key: 'pts', source: 'existing', mint: MINT, decimals: 6, program: 'token-2022', powers }],
  pools: [{ key: 'jackpot', currency: 'pts', seed: 1000 }],
  items: [{ key: 'gem', name: 'Gem', uri: 'https://example.invalid/g.json' }, { key: 'rock', name: 'Rock', uri: 'https://example.invalid/r.json' }],
  boxes: [],
  ...parts,
});
// The hooked box: one outcome (it doesn't roll by itself), switched off, free.
const vault = { key: 'vault', name: 'Vault', price: 0, active: false, outcomes: [{ gives: 'pay', pool: 'jackpot', amount: 5, chance: 100 }] };
const mid = { key: 'mid', name: 'Mid', price: 0, active: false, outcomes: [{ gives: 'roll', box: 'vault', chance: 100 }] };
const crate = (outcomes) => ({ key: 'crate', name: 'Crate', price: 0.02, outcomes });
const shapes = {
  outcome: { boxes: [vault, crate([{ gives: 'roll', box: 'vault', chance: 30 }, { gives: 'item', item: 'gem', chance: 70 }])] },
  bundle: { boxes: [vault, crate([{ gives: 'bundle', prizes: [{ gives: 'item', item: 'rock' }, { gives: 'roll', box: 'vault' }], chance: 40 }, { gives: 'item', item: 'gem', chance: 60 }])] },
  buy: { boxes: [vault, crate([{ gives: 'roll', box: 'vault', chance: 100 }])] },
  'grant through a box': { boxes: [vault, mid], grants: [{ key: 'gift', name: 'Gift', prize: { gives: 'roll', box: 'mid' }, limits: { perWallet: 1 } }] },
  'recipe through a box': { boxes: [vault, mid], recipes: [{ key: 'forge', name: 'Forge', in: [{ takes: 'burn', item: 'gem' }], out: [{ gives: 'roll', box: 'mid' }] }] },
};
const eBox = (s) => check(s, { now: NOW }).refusals.filter((r) => r.code === 'E-BOX');

test('E-BOX refuses a hooked prize in a box another box’s outcome, a bundle part or a rolled box rolls', () => {
  for (const [shape, parts] of Object.entries(shapes)) {
    const [r, ...more] = eBox(spec(parts));
    assert.equal(more.length, 0, shape);
    assert.equal(r?.where, 'economy.boxes.vault.outcomes[0]', shape);
    assert.match(r.message, /fails when it is asked for/, shape);
    assert.match(r.message, shape.includes('through') ? /box:mid/ : /box:crate/, shape);
  }
  const chained = eBox(spec(shapes['grant through a box']))[0].message;
  assert.match(chained, /grant:gift through box:mid/, 'the route at the head of the chain is named');
});

test('the controls: a grant’s direct roll is refused as before; a plain token, or a box nothing rolls, checks', () => {
  assert.equal(eBox(spec({ boxes: [vault], grants: [{ key: 'gift', name: 'Gift', prize: { gives: 'roll', box: 'vault' }, limits: { perWallet: 1 } }] }))[0]?.where, 'economy.boxes.vault.outcomes[0]');
  for (const [shape, parts] of Object.entries(shapes)) {
    const plain = spec(parts, {});
    assert.deepEqual(eBox(plain), [], shape);
    assert.equal(check(plain, { now: NOW }).ok, true, shape);
  }
  // the hooked one-outcome box sold alone: its prize moves in the purchase, with the hook's accounts
  assert.deepEqual(eBox(spec({ boxes: [{ ...vault, price: 0.01, active: true }] })), []);
  // the outer box rolls nothing hooked of its own: only the box it rolls is refused
  assert.ok(eBox(spec(shapes.outcome)).every((r) => !r.where.includes('crate')));
});

test('rollsOf follows a chain of rolls to its end, once a route, and stops on a loop', () => {
  const m = model(spec({ boxes: [vault, mid, crate([{ gives: 'roll', box: 'mid', chance: 100 }])], grants: [{ key: 'gift', name: 'Gift', prize: { gives: 'roll', box: 'crate' }, limits: { perWallet: 1 } }] }, {}), { now: NOW });
  const of = (box) => rollsOf(m).filter((r) => r.box === box).map((r) => [r.by, r.route, (r.through ?? []).join('>')]);
  assert.deepEqual(of('crate'), [['grant:gift', 'grant', '']]);
  assert.deepEqual(of('mid'), [['box:crate', 'box', ''], ['grant:gift', 'grant', 'crate']]);
  assert.deepEqual(of('vault'), [['box:mid', 'box', ''], ['box:crate', 'box', 'mid'], ['grant:gift', 'grant', 'crate>mid']]);
  // two boxes that roll each other, and one that rolls itself
  const loop = spec({ boxes: [{ ...crate([{ gives: 'roll', box: 'mid', chance: 50 }, { gives: 'roll', box: 'crate', chance: 50 }]) }, { ...mid, outcomes: [{ gives: 'roll', box: 'crate', chance: 100 }] }] }, {});
  const rolls = rollsOf(model(loop, { now: NOW }));
  assert.equal(new Set(rolls.map((r) => `${r.box}|${r.by}|${r.route}`)).size, rolls.length);
  assert.ok(Array.isArray(check(loop, { now: NOW }).refusals));
});

test('E-ROLL counts a mission’s or a recipe’s roll through a box: the box it rolls can’t be opened for free', () => {
  const free = { ...vault, outcomes: [{ gives: 'item', item: 'rock', chance: 100 }], active: true };
  const parts = { boxes: [free, mid], recipes: shapes['recipe through a box'].recipes };
  const v = check(spec(parts, {}), { now: NOW });
  const r = v.refusals.find((x) => x.code === 'E-ROLL');
  assert.equal(r?.where, 'economy.boxes.vault.active');
  assert.match(r.message, /recipe:forge through box:mid/);
  assert.ok(!v.warnings.some((w) => w.code === 'W-FREE' && w.where.startsWith('economy.boxes.vault')), 'not just a free box');
  // a recipe that rolls it directly, as before
  const direct = check(spec({ boxes: [free], recipes: [{ ...parts.recipes[0], out: [{ gives: 'roll', box: 'vault' }] }] }, {}), { now: NOW });
  assert.match(direct.refusals.find((x) => x.code === 'E-ROLL')?.message ?? '', /rolled by recipe:forge,/);
});

test('W-ROLL-PRIZE and W-STASH-SHARED count a box’s own outcome’s roll', () => {
  // a box for sale that another box's outcome rolls
  const sold = check(spec({ boxes: [{ ...vault, price: 0.01, active: true }, ...shapes.outcome.boxes.slice(1)] }, {}), { now: NOW });
  const w = sold.warnings.find((x) => x.code === 'W-ROLL-PRIZE' && x.where === 'economy.boxes.vault.active');
  assert.match(w?.message ?? '', /is a prize of box:crate/);
  // a stash a grant's roll and another box's outcome both take from
  const loot = { key: 'loot', name: 'Loot', price: 0, active: false, outcomes: [{ gives: 'stash', stash: 'vault', chance: 50 }, { gives: 'item', item: 'gem', chance: 50 }] };
  const stashes = [{ key: 'vault', name: 'Vault', nfts: STASHED }];
  const grants = [{ key: 'gift', name: 'Gift', prize: { gives: 'roll', box: 'loot' }, limits: { perWallet: 1 } }];
  const shared = (boxes) => check(spec({ boxes: [loot, ...boxes], stashes, grants }, {}), { now: NOW }).warnings.find((x) => x.code === 'W-STASH-SHARED');
  assert.equal(shared([]), undefined, 'one route alone');
  assert.match(shared([crate([{ gives: 'roll', box: 'loot', chance: 50 }, { gives: 'item', item: 'rock', chance: 50 }])])?.message ?? '', /given by box:crate, grant:gift|given by grant:gift, box:crate/);
});

test('W-LIVE-ROLLS names a box whose outcome won the rolls that now fail', () => {
  const s = spec({ boxes: [{ ...vault, outcomes: [{ gives: 'item', item: 'rock', chance: 50 }, { gives: 'item', item: 'gem', chance: 50 }] }, ...shapes.outcome.boxes.slice(1)] }, {});
  const { live: _, ...published } = structuredClone(s);
  const changed = { ...structuredClone(s), live: { program: '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ', project: 'So11111111111111111111111111111111111111112', published } };
  changed.boxes[0].outcomes[0].chance = 40;
  changed.boxes[0].outcomes[1].chance = 60;
  const w = check(changed, { now: NOW }).warnings.find((x) => x.code === 'W-LIVE-ROLLS' && x.where === 'economy.boxes.vault');
  assert.match(w?.message ?? '', /another route \(box:crate\) paid nothing in/);
});

test('the explainer says which box rolls a box that is never sold', () => {
  const s = spec({ boxes: [{ ...vault, outcomes: [{ gives: 'item', item: 'rock', chance: 100 }] }, ...shapes.outcome.boxes.slice(1)] }, {});
  const { ok, text } = explainEconomy(s, { now: NOW });
  assert.equal(ok, true, text);
  assert.match(text, /“Vault” is never sold: the box “Crate” rolls it/);
});

// One walk is bounded at 10,000,000 sales, but a simulation walks one a box and one a shop item: 32 boxes and 63
// items, each rising a lamport a sale (a price that never stops moving), would walk about 950 million sales, seconds
// of the MCP server's only thread on every check, and xsolana_explain simulates more than once. So the bound is shared.
const walkSpec = (nb, ni, rise = { step: 0.000000001 }, extra = {}) => {
  const perDay = {};
  const boxes = Array.from({ length: nb }, (_, i) => {
    perDay[`box:b${i}`] = 999_999;
    return { key: `b${i}`, name: `B${i}`, price: 0.01, rise, ...extra, outcomes: [{ gives: 'nothing', chance: 50 }, { gives: 'item', item: 'gem', chance: 50 }] };
  });
  const items = [{ key: 'gem', name: 'Gem', uri: 'https://example.invalid/g.json' }, ...Array.from({ length: ni }, (_, i) => {
    perDay[`item:i${i}`] = 999_999;
    return { key: `i${i}`, name: `I${i}`, uri: 'https://example.invalid/i.json', price: 0.01, rise, ...extra };
  })];
  return { version: 2, network: 'devnet', name: 'Walk', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'Walk' }, items, boxes, scenario: { days: 10, perDay } };
};
// A pathological input loops for seconds; a slow CI runner is given more room than a laptop.
const quick = async (what, run, ms = process.env.CI ? 5000 : 1000) => {
  const t = Date.now();
  const out = await run();
  assert.ok(Date.now() - t < ms, `${what} answered in ${Date.now() - t} ms`);
  return out;
};

test('32 boxes and 63 items rising a lamport a sale answer fast, every tool', async () => {
  const spec = walkSpec(32, 63);
  const v = await quick('check', () => check(spec, { now: NOW }));
  assert.equal(v.ok, true, JSON.stringify(v.refusals));
  const sim = await quick('simulate', () => simulate(spec, { now: NOW }));
  // 9,999,990 sales of each, from 0.01 up a lamport a sale: on average 0.01 and half of 9,999,989 lamports
  const b0 = sim.boxes.find((b) => b.key === 'b0');
  assert.ok(Math.abs(b0.averagePrice - (0.01 + (1e-9 * (9_999_990 - 1)) / 2)) < 1e-9, String(b0.averagePrice));
  for (const tool of ['xsolana_check', 'xsolana_simulate', 'xsolana_explain', 'xsolana_cost']) {
    const r = await quick(tool, () => runTool(tool, { spec }, { now: NOW }), process.env.CI ? 10_000 : 2000);
    assert.notEqual(r.isError, true, `${tool}: ${r.text}`);
  }
});

test('a rise by a step alone is summed at once, as the walk would price it, up to the cap', () => {
  const walk = (price, step, count, cap = 1e18) => {
    let p = price;
    let total = 0;
    let last = price;
    for (let k = 0; k < count; k++) {
      last = p;
      total += p;
      p = Math.min(cap, p + step);
    }
    return { count, average: total / count, first: price, last };
  };
  const close = (a, b, what) => {
    assert.equal(a.count, b.count, what);
    for (const k of ['average', 'first', 'last']) assert.ok(Math.abs(a[k] - b[k]) <= Math.abs(b[k]) * 1e-9, `${what} ${k}: ${a[k]} vs ${b[k]}`);
  };
  close(salePrices({ price: 0.01, rise: { step: 0.001 } }, 10, 3), walk(0.01, 0.001, 30), 'thirty sales');
  close(salePrices({ price: 0.01, rise: { step: 0.001 } }, 1, 1), walk(0.01, 0.001, 1), 'one sale');
  close(salePrices({ price: 1e18 - 2.5e3, rise: { step: 1e3 } }, 10, 1), walk(1e18 - 2.5e3, 1e3, 10), 'up to the cap');
  close(salePrices({ price: 1e18, rise: { step: 1 } }, 5, 1), walk(1e18, 1, 5), 'at the cap from the start');
  // a whole budget is not spent on it
  const budget = walkBudget();
  salePrices({ price: 0.01, rise: { step: 1e-9 } }, 1e6, 3650, 0, budget);
  assert.equal(budget.left, walkBudget().left);
});

test('the walk of moving prices is one budget a simulation, shared by its boxes and items', async () => {
  // a rise by a step with a fall that never lowers it (sales a second apart, a fall a day): walked one by one
  const fall = { every: '1d', step: 0.001, floor: 0.001 };
  const one = walkSpec(1, 0, { step: 0.000000001 }, { fall });
  one.scenario.days = 6;
  assert.doesNotThrow(() => simulate(one, { now: NOW }), 'six million sales of one box');
  const two = walkSpec(2, 0, { step: 0.000000001 }, { fall });
  two.scenario.days = 6;
  await quick('a second box past the budget', () => assert.throws(() => simulate(two, { now: NOW }), /10,000,000 sales of prices that still move, for all boxes and items together/));
  const r = await quick('xsolana_simulate', () => runTool('xsolana_simulate', { spec: two }, { now: NOW }));
  assert.equal(r.isError, true);
  assert.match(r.text, /fewer days or fewer a day/);
  // and every tool stays quick on the most a spec holds of them
  const most = walkSpec(32, 63, { step: 0.000000001 }, { fall });
  await quick('check of 95 walked parts', () => check(most, { now: NOW }));
  await quick('xsolana_explain of 95 walked parts', () => runTool('xsolana_explain', { spec: most }, { now: NOW }), process.env.CI ? 10_000 : 2000);
});

// Nothing but a higher bid hands a high bid back before an auction's end, so
// open_auction refuses an end more than five years off, or a push of it by a bid of more than five years (BadAuction):
// a time written in milliseconds held the bid and the lot for good. The checker refuses them first.
test('an auction that ends, or moves its end, more than five years off is refused (BadAuction)', () => {
  const auction = example('artwork-auction').spec;
  const at = (a) => {
    const v = check({ ...auction, auctions: [{ ...auction.auctions[0], ...a }] }, { now: NOW });
    return v.refusals.filter((r) => r.code === 'E-AUCTION').map((r) => `${r.where} ${/BadAuction/.test(r.message)}`);
  };
  assert.deepEqual(at({}), []);
  assert.deepEqual(at({ runs: '1825d' }), [], 'five years to the day');
  assert.deepEqual(at({ runs: '1826d' }), ['economy.auctions.sunset.runs true']);
  assert.deepEqual(at({ start: 'publish+1d', runs: '1825d' }), ['economy.auctions.sunset.runs true'], 'from a later start');
  assert.deepEqual(at({ runs: '1825d', extendBy: '1825d' }), [], 'an extension of five years');
  assert.deepEqual(at({ extendBy: '1826d' }), ['economy.auctions.sunset.extendBy true']);
  // a time written in milliseconds by mistake
  assert.deepEqual(at({ runs: 604_800_000 }), ['economy.auctions.sunset.runs true'], 'a week written in milliseconds');
});

test('the program takes an end and an extension of five years, and refuses one second more', { skip: cannotRun() ?? false }, () => {
  const MAX = BigInt(IDL.constants.find((c) => c.name === 'MAX_CONTEST_SECONDS').value);
  assert.equal(MAX, 157_680_000n, 'five years, as the checker counts them');
  const w = world({ seed: 'roll-chains-auction' });
  w.upsert({ Item: { id: 1, args: collectible('Painting') } });
  const open = (id, ends, extend) => () => {
    const now = BigInt(w.chain.now());
    w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, collection: w.collection, id, mint: w.mint, programs: {},
      args: { lot: { Asset: [w.make(1, w.authority)] }, reserve: 0n, min_raise_bps: 0, starts_at: now, ends_at: now + ends, extend, shares: [], gate: null } })]);
  };
  const fails = (fn) => assert.throws(fn, (e) => (e.logs ?? []).some((l) => l.includes('BadAuction')) || String(e.message).includes('BadAuction'));
  fails(open(1, MAX + 1n, 600));
  fails(open(2, 86_400n, Number(MAX) + 1));
  open(3, MAX, Number(MAX))();
  assert.ok(w.chain.get(loot.pda.auction(w.project, w.authority, 3)));
});
