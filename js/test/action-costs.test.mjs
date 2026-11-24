// What one player action costs on top of its price is the same figure in explain, cost and simulate: the player
// fee, the oracle, the network and rent that never comes back (on average across the outcomes), at the economy's
// network's fees, said in the same words.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost } from '../economy/cost.mjs';
import { examples } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { inAll, simulate } from '../economy/simulate.mjs';

const NOW = 1_790_000_000;
const flat = t => t.replace(/\s+/g, ' ');

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
