// What one player action costs on top of its price is the same figure in explain, cost and simulate: the player
// fee, the oracle, the network and rent that never comes back (on average across the outcomes), at the economy's
// network's fees, said in the same words.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { examples } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { inAll, simulate } from '../economy/simulate.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;
const flat = t => t.replace(/\s+/g, ' ');
const PERSON = { terminal: { simulate: ['file'] }, reader: 'person', now: NOW };

test('explain, cost and simulate give each player action the same figure, in the same words', () => {
  let seen = 0;
  for (const { name, spec } of examples()) {
    const sim = simulate(spec, { now: NOW });
    const explained = flat(explainEconomy(spec, { now: NOW }).text);
    const actions = cost(spec, { now: NOW }).actions;
    for (const kind of ['boxes', 'items', 'payments', 'lotteries']) {
      for (const part of sim[kind] ?? []) {
        // (a box only other routes roll is never sold: no player pays for it)
        if (!part.realCost || explained.includes(`“${part.name ?? part.key}” is never sold`)) continue;
        const words = inAll(part.realCost);
        assert.ok(explained.includes(words), `${name}: explain doesn't give ${part.key} as “${words}”`);
        const action = actions.find(a => a.part?.endsWith(`:${part.key}`) && a.who === 'player');
        if (action?.onTopSol !== undefined && action?.onTopSol !== null)
          assert.equal(action.onTopSol, part.realCost.extrasSol, `${name}: cost and simulate on ${part.key}`);
        seen++;
      }
    }
    assert.doesNotMatch(explained, /plus about [\d.]+ SOL \(the player fee/, `${name}: the old fees-only figure`);
  }
  assert.ok(seen > 30, `${seen} actions compared`);
});

test('W-FEE gives the player fee alone, said as such, and never a share that disagrees with cost', () => {
  let seen = 0;
  for (const { name, spec } of examples()) {
    const fees = check(spec, { now: NOW }).warnings.filter(w => w.code === 'W-FEE');
    for (const w of fees) {
      assert.match(w.message, /the player fee alone is/, `${name}: ${w.message}`);
      assert.doesNotMatch(w.message, /% on top of its/, `${name}: ${w.message}`);
      seen++;
    }
  }
  assert.ok(seen > 3, `${seen} W-FEE warnings`);
});

test('what players get back separates money paid out from items at the value the spec gives them', async () => {
  const spec = examples().find(e => e.name === 'hello-shop').spec;
  const sim = simulate(spec, { now: NOW });
  assert.equal(sim.perDay.players.itemValue.sol, sim.perDay.players.getBack.sol, 'hello-shop gives items, no money');
  const said = (await runTool('xsolana_simulate', { example: 'hello-shop' }, PERSON)).text.replace(/\s+/g, ' ');
  assert.match(said, /they get back nothing paid out, and items worth 5 SOL by the "value" you gave them/);
  assert.doesNotMatch(said, /get back 5 SOL/);
  assert.match(
    flat(explainEconomy(spec, { now: NOW }).text),
    /items worth 5 SOL at the "value" you gave them: a value, not money paid out/,
  );
});
