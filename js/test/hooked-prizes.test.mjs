// The checker refuses a box whose prizes move in a roll and are paid in a token with a transfer hook, which the program
// refuses only once the roll is made; the quick simulation's walk of a rising or falling price is bounded, by the
// schema and by the walk itself; xsolana_save saves over every spec it would write itself, one with no currency included.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { example } from '../economy/examples.mjs';
import { salePrices } from '../economy/simulate.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_800_000_000;

// A roll carries none of the accounts a transfer hook asks for, so the program refuses a prize in a hooked mint
// in every box that rolls (open_box, PrizeHasHook) and fails every waiting roll of such a box at its ask, whatever its
// number of outcomes: a recipe's inputs, a mission's return or a grant's round are spent by then.
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const hooked = (powers = { transferHook: true }) => ({
  version: 2,
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }, { key: 'pts', source: 'existing', mint: MINT, decimals: 6, program: 'token-2022', powers }],
  pools: [{ key: 'jackpot', currency: 'pts', seed: 1000 }],
  items: [{ key: 'hero', name: 'Hero', uri: 'https://example.invalid/h.json' }],
  boxes: [],
});
const roll = [{ gives: 'pay', pool: 'jackpot', amount: 10, chance: 50 }, { gives: 'nothing', chance: 50 }];
const one = [{ gives: 'pay', pool: 'jackpot', amount: 10 }];
const hookRefusals = (spec) => check(spec, { now: NOW }).refusals.filter((r) => r.code === 'E-BOX');

test('a box that rolls a prize in a token with a transfer hook is refused', () => {
  const spec = { ...hooked(), boxes: [{ key: 'crate', name: 'Crate', price: 0.01, outcomes: roll }] };
  const [r, ...more] = hookRefusals(spec);
  assert.equal(more.length, 0);
  assert.equal(r.where, 'economy.boxes.crate.outcomes[0]');
  assert.match(r.message, /transfer hook/);
  assert.match(r.message, /PrizeHasHook/);
  assert.match(r.message, /every opening of it fails/);
});

test('a box of one outcome is refused too once a recipe, a mission or a prize rolls it', () => {
  const forge = { key: 'forge', name: 'Forge', price: 0, active: false, outcomes: one };
  const routes = {
    recipe: { recipes: [{ key: 'sacrifice', name: 'Sacrifice', in: [{ takes: 'burn', item: 'hero' }], out: [{ gives: 'roll', box: 'forge' }] }] },
    grant: { grants: [{ key: 'gift', name: 'Gift', prize: { gives: 'roll', box: 'forge' }, limits: { total: 10, perWallet: 1 } }] },
  };
  for (const [route, parts] of Object.entries(routes)) {
    const [r, ...more] = hookRefusals({ ...hooked(), boxes: [forge], ...parts });
    assert.equal(more.length, 0, route);
    assert.equal(r?.where, 'economy.boxes.forge.outcomes[0]', route);
    assert.match(r.message, /fails when it is asked for/, route);
    assert.doesNotMatch(r.message, /every opening/, route);
  }
});

test('a box of one outcome nothing else rolls, or a token without a hook, still checks', () => {
  // one outcome, sold, rolled by nothing: its prize moves in the purchase, where the hook's accounts come along
  assert.deepEqual(hookRefusals({ ...hooked(), boxes: [{ key: 'chest', name: 'Chest', price: 0.01, outcomes: one }] }), []);
  // the same rolled box in a Token-2022 coin with no hook
  const plain = { ...hooked({}), boxes: [{ key: 'crate', name: 'Crate', price: 0.01, outcomes: roll }] };
  assert.deepEqual(hookRefusals(plain), []);
  assert.equal(check(plain, { now: NOW }).ok, true);
});

test('W-MINT-POWERS says a settle of a price waits for the hook, and a rolled box can’t give the token as a prize', () => {
  const v = check({ ...hooked(), boxes: [{ key: 'chest', name: 'Chest', price: 0.01, outcomes: one }] }, { now: NOW });
  const w = v.warnings.find((x) => x.code === 'W-MINT-POWERS');
  assert.match(w.message, /a price or its shares/);
  assert.match(w.message, /can’t give it as a prize/);
  assert.doesNotMatch(w.message, /a refused settle waits until the hook allows it\)/);
});

// salePrices walks a rising or falling price one sale at a time, days × perDay of them, both from the spec's
// scenario: unbounded, one spec would hang every tool that checks and the MCP server's only thread.
const flip = example('coin-flip-arena').spec;
const rising = (days, perDay, rise = { growthPercent: 1 }) => ({
  ...flip,
  boxes: flip.boxes.map((b) => ({ ...b, rise })),
  scenario: { ...flip.scenario, days, perDay: { ...flip.scenario.perDay, 'box:flip': perDay } },
});
const quick = async (what, run) => {
  const t = Date.now();
  const out = await run();
  // A pathological input loops for seconds; a slow CI runner is given more room than a laptop.
  assert.ok(Date.now() - t < (process.env.CI ? 5000 : 1000), `${what} answered in ${Date.now() - t} ms`);
  return out;
};

test('the schema bounds the scenario’s days and counts a day', async () => {
  const v = await quick('check', () => check(rising(1e6, 1e7), { now: NOW }));
  assert.equal(v.ok, false);
  assert.ok(v.refusals.some((r) => r.code === 'E-SCHEMA' && r.where === 'economy.scenario.days'));
  assert.ok(v.refusals.some((r) => r.code === 'E-SCHEMA' && r.where === 'economy.scenario.perDay.box:flip'));
  for (const tool of ['xsolana_check', 'xsolana_simulate', 'xsolana_explain', 'xsolana_cost']) {
    const r = await quick(tool, () => runTool(tool, { spec: rising(1e6, 1e7) }, { now: NOW }));
    assert.notEqual(r.ok, true, tool);
  }
  assert.equal(check(rising(3650, 1e6), { now: NOW }).refusals.filter((r) => r.code === 'E-SCHEMA').length, 0, 'ten years at a million a day is a scenario');
});

test('salePrices stops once the price stops moving, and throws past ten million sales of one that still moves', async () => {
  // 1% a sale reaches the cap within a few thousand sales: the rest are counted at it
  const capped = await quick('a price at its cap', () => salePrices({ price: 0.1, rise: { growthPercent: 1 } }, 1e6, 3650));
  assert.equal(capped.count, 3.65e9);
  assert.equal(capped.last, 1e18);
  assert.ok(capped.average > 0.99e18 && capped.average <= 1e18);
  // a fall to its floor with no rise stays there, and sales closer together than its steps hold the price
  const floored = await quick('a price at its floor', () => salePrices({ price: 10, fall: { every: '1s', step: 1, floor: 2 } }, 1e4, 3650));
  assert.equal(floored.last, 2);
  const held = await quick('a price sales hold', () => salePrices({ price: 10, fall: { every: '1h', step: 1, floor: 2 } }, 1e6, 3650));
  assert.deepEqual([held.first, held.last, held.average], [10, 10, 10]);
  // the walk is the same as before where it ends on its own
  const small = salePrices({ price: 0.1, rise: { growthPercent: 1 } }, 100, 30);
  assert.equal(small.count, 3000);
  assert.equal(small.first, 0.1);
  // a rise too small to reach the cap keeps moving: refused past ten million, which check skips and xsolana_simulate says
  await quick('a price still moving', () => assert.throws(() => salePrices({ price: 0.1, rise: { growthPercent: 1e-9 } }, 1e6, 3650), /10,000,000 sales/));
  const slow = rising(3650, 1e6, { growthPercent: 1e-9 });
  assert.equal((await quick('check', () => check(slow, { now: NOW }))).ok, true);
  const r = await quick('xsolana_simulate', () => runTool('xsolana_simulate', { spec: slow }, { now: NOW }));
  assert.equal(r.isError, true);
  assert.match(r.text, /10,000,000 sales/);
});

// A spec of one token checks without a `currency` (that token is its currency), so xsolana_save's test of a spec's shape
// asks for none: otherwise it would refuse to save over a file it had written itself and advise another name, which
// carries no live section.
test('xsolana_save saves over a one-token spec with no currency, live or not, and still keeps other JSON files', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-one-token-'));
  const { currency, ...spec } = example('event-badges').spec;
  assert.equal(currency, 'sol');
  assert.equal(spec.tokens.length, 1);
  assert.equal(check(spec, { now: NOW }).ok, true, 'a spec of one token checks without a currency');
  for (let i = 0; i < 2; i++) {
    const r = await runTool('xsolana_save', { spec, file: 'event-badges.json' }, { cwd: dir, now: NOW });
    assert.equal(r.ok, true, r.text);
  }
  // one that went live (`xsolana approve` writes its live section back) is saved over with its live section kept
  const { currency: _, ...ladder } = example('level-ladder').spec;
  const live = { project: '11111111111111111111111111111111' };
  const file = path.join(dir, 'level-ladder.json');
  writeFileSync(file, JSON.stringify({ ...ladder, live }));
  const r = await runTool('xsolana_save', { spec: { ...ladder, name: 'Ladder, renamed' }, file: 'level-ladder.json' }, { cwd: dir, now: NOW });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).live, live, 'the live section is kept');
  // what is not a spec stays refused: no tokens, or keys a spec doesn't have
  for (const [name, body] of [['package.json', { name: 'my-game', version: '1.0.0' }], ['vercel.json', { version: 2, name: 'my-app' }], ['bare.json', { version: 2 }], ['odd.json', { version: 2, tokens: [], currency: 1 }]]) {
    writeFileSync(path.join(dir, name), JSON.stringify(body));
    const no = await runTool('xsolana_save', { spec, file: name }, { cwd: dir, now: NOW });
    assert.equal(no.ok, false, name);
    assert.match(no.text, /is not an economy spec/, name);
  }
});
