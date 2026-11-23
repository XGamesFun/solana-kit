// How the tools print a number (js/economy/format.mjs): thousands grouped, the whole part never rounded, at most six
// significant digits (four for a percent), and so no raw float in what simulate, cost, explain and review say.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { examples } from '../economy/examples.mjs';
import { numeral, percentage, plural } from '../economy/format.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;
const PRINTERS = ['xsolana_simulate', 'xsolana_cost', 'xsolana_explain', 'xsolana_review'];

test('a number is printed grouped, its whole part whole, with at most six significant digits', () => {
  for (const [x, said] of [
    [661112079143.5319, '661,112,079,144'],
    [344737203260.09955, '344,737,203,260'],
    [74081.822068, '74,081.8'],
    [1234567.25, '1,234,567'],
    [6000, '6,000'],
    [999, '999'],
    [5.33381685, '5.33382'],
    [0.176670648, '0.176671'],
    [0.02353564, '0.0235356'],
    [0.00203928, '0.00203928'],
    [0.000005, '0.000005'],
    [0.1 + 0.2, '0.3'],
    [0, '0'],
    [-0, '0'],
    [-1e-12, '0'],
    [-2.5, '-2.5'],
    [1e21, '1,000,000,000,000,000,000,000'],
    // (written as a string in a spec, to be exact)
    ['1000000', '1,000,000'],
    ['0.5', '0.5'],
    [12345678901234567890n, '12,345,678,901,234,567,890'],
  ])
    assert.equal(numeral(x), said, String(x));
  // Fewer digits when asked, and what is no number as it is.
  assert.equal(numeral(12.3456, 3), '12.3');
  assert.equal(numeral(Infinity), 'Infinity');
  assert.equal(numeral(undefined), 'undefined');
  assert.equal(numeral('soon'), 'soon');
});

test('a percent keeps four significant digits, and is 0 or 100 only when it is', () => {
  for (const [x, said] of [
    [75.8948, '75.89'],
    [13.636363, '13.64'],
    [66.666666, '66.67'],
    [50, '50'],
    [100, '100'],
    [0, '0'],
    [99.995, '99.995'],
    [99.99999, '99.99999'],
    [100.004, '100.004'],
    [0.005, '0.005'],
    [0.0000001, '0.0000001'],
    [66111207914353.19, '66,111,207,914,353'],
    [-3.25, '-3.25'],
    ['12.5', '12.5'],
  ])
    assert.equal(percentage(x), said, String(x));
});

test('a count takes its noun, grouped like any number', () => {
  assert.equal(plural(1, 'box'), '1 box');
  assert.equal(plural(0, 'box', 'boxes'), '0 boxes');
  assert.equal(plural(60_000, 'item'), '60,000 items');
});

/** Every number with a decimal point in `text` that keeps more digits than the tools print: [] when none does. */
function rawFloats(text) {
  const found = [];
  // (a number standing alone: not part of an address, a key or a version)
  for (const [n] of text.matchAll(/(?<![\w.,])\d[\d,]*\.\d+(?![\w.])/g)) {
    const [whole, fraction] = n.replaceAll(',', '').split('.');
    const significant = `${whole}${fraction}`.replace(/^0+/, '').length;
    if (fraction.length > 9 || significant > 6) found.push(n);
  }
  return found;
}

test('the check itself finds a raw float, and passes a printed number', () => {
  assert.deepEqual(rawFloats('worth 661112079143.5319 FORGE on average (66111207914353.19%), 75.8948% back'), [
    '661112079143.5319',
    '66111207914353.19',
  ]);
  assert.deepEqual(rawFloats('about 0.176670648 SOL'), ['0.176670648']);
  assert.deepEqual(rawFloats('worth 661,112,079,144 FORGE, 75.89% back, 0.176671 SOL; loot 0.29.0 · @x/y@0.29.10'), []);
});

test('simulate, cost, explain and review print no raw float, for every bundled example', async () => {
  for (const { name } of examples())
    for (const tool of PRINTERS) {
      const r = await runTool(tool, { example: name }, { now: NOW });
      assert.ok(!r.isError && !r.refusals, `${tool} on ${name}: ${r.text}`);
      assert.deepEqual(rawFloats(r.text), [], `${tool} on ${name}`);
    }
});

/** coin-flip-arena with its flip at `price`, paying 0.5, opened `flips` times a day. */
function arena(price, flips) {
  const { spec } = examples().find(e => e.name === 'coin-flip-arena');
  const [win, miss] = spec.boxes[0].outcomes;
  return {
    ...spec,
    boxes: [{ ...spec.boxes[0], price, outcomes: [{ ...win, amount: 0.5 }, miss] }],
    scenario: { ...spec.scenario, perDay: { ...spec.scenario.perDay, 'box:flip': flips } },
  };
}

test('large and uneven figures are printed grouped and cut, never as the float they are', async () => {
  // 987,653 flips a day at 0.3 SOL: sums in the hundreds of thousands, and thirds wherever one is divided.
  const big = arena(0.3, 987_653);
  for (const tool of PRINTERS) {
    const r = await runTool(tool, { spec: big }, { now: NOW });
    assert.ok(!r.isError && !r.refusals, `${tool}: ${r.text}`);
    assert.deepEqual(rawFloats(r.text), [], tool);
  }
  const { text } = await runTool('xsolana_simulate', { spec: big }, { now: NOW });
  assert.match(text, /^Assuming 987,653 × box:flip, /);
  assert.match(text, /gives back 0\.25 SOL on average \(83\.33%\); the game keeps 16\.67% of each price/);
  assert.match(text, /Each day players pay 296,297 SOL and get back 282,470 SOL on average/);
});

test('a price is said as it was written, by every tool that says it', async () => {
  const exact = arena(0.123456789, 100);
  const said = async tool => (await runTool(tool, { spec: exact }, { now: NOW })).text;
  assert.match(await said('xsolana_simulate'), /Box “Coin flip”: costs 0\.123456789 SOL /);
  assert.match(await said('xsolana_explain'), /Open “Coin flip”: 0\.123456789 SOL, /);
  assert.match(await said('xsolana_review'), /any wallet that pays 0\.123456789 SOL/);
});
