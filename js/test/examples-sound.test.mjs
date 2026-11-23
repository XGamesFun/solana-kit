// Every bundled example passes the kit's own tools, as an agent would run them on it: it checks, a review finds
// nothing high, and its simulation at its own scenario stays in the world: every number finite, no price run out of
// reach, and no more SOL moved than there is. (That each one goes live on the program is economy.test.mjs.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { examples } from '../economy/examples.mjs';
import { model } from '../economy/model.mjs';
import { review } from '../economy/review.mjs';
import { explain, simulate } from '../economy/simulate.mjs';

const NOW = 1_790_000_000;
/** About all the SOL there is: a scenario that moves more is not one any economy meets. */
const ALL_SOL = 600_000_000;
/** The simulator's own words for a rising price the scenario's sales carry out of reach (ten times its start, or more). */
const OUT_OF_REACH = /players stop buying long before that/;

/** Every number in a value, with where it is. */
function numbersIn(value, path = 'simulation', found = []) {
  if (typeof value === 'number') found.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, n) => numbersIn(v, `${path}[${n}]`, found));
  else if (value && typeof value === 'object')
    for (const [key, v] of Object.entries(value)) numbersIn(v, `${path}.${key}`, found);
  return found;
}

for (const { name, spec } of examples())
  test(`${name}: checks, reviews with nothing high, and simulates within bounds`, () => {
    const verdict = check(spec, { now: NOW });
    assert.ok(verdict.ok, verdict.refusals.map(r => `${r.code} ${r.message}`).join('\n'));

    const high = review(spec, { now: NOW }).findings.filter(f => f.severity === 'high');
    assert.ok(!high.length, high.map(f => `${f.id} (${f.route}): ${f.message}`).join('\n'));

    const sim = simulate(spec, { now: NOW });
    for (const [where, n] of numbersIn(sim)) assert.ok(Number.isFinite(n), `${where} is ${n}`);
    for (const note of sim.notes) assert.doesNotMatch(note, OUT_OF_REACH);
    // SOL moved over the scenario: what players pay and get back and what the treasury gets in SOL, and every fee.
    const m = model(spec, { now: NOW });
    const solKeys = [...m.tokens.values()].filter(t => t.source === 'sol').map(t => t.key);
    const days = sim.scenario.days ?? 30;
    for (const [where, n] of numbersIn(sim.perDay, 'simulation.perDay')) {
      const field = where.split('.').at(-1);
      if (field.endsWith('Sol') || solKeys.includes(field))
        assert.ok(Math.abs(n) * days < ALL_SOL, `${where}: ${n} SOL a day for ${days} days is more SOL than there is`);
    }
    assert.ok(explain(sim, spec).length > 0);
  });

test('the simulator still says so when a price runs out of reach, in the words this test reads', () => {
  const spec = structuredClone(examples().find(e => e.name === 'blind-forge').spec);
  spec.scenario.perDay['box:forge-box'] = 200;
  assert.ok(simulate(spec, { now: NOW }).notes.some(note => OUT_OF_REACH.test(note)));
});
