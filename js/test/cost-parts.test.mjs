// What going live costs, part by part: rent, fees, and every SOL put in (seeds, grants' funds, a lottery's reserve for
// its rounds' rent, a sealed schedule's funds) add up to the total, to the lamport, on every worked example, and
// `xsolana cost` lists each one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost } from '../economy/cost.mjs';
import { examples } from '../economy/examples.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;
const lamports = x => BigInt(Math.round(Number(x) * 1e9));

test('the parts of going live add up to its total on every example', async () => {
  for (const { name, spec } of examples()) {
    const { setup } = cost(spec, { now: NOW });
    const sum = setup.parts.reduce((n, p) => n + BigInt(p.lamports), 0n);
    assert.equal(sum, lamports(setup.totalSol), `${name}: ${setup.parts.map(p => `${p.sol} ${p.what}`).join(' + ')}`);
    const shown = await runTool(
      'xsolana_cost',
      { example: name },
      { terminal: { cost: ['file'] }, reader: 'person', now: NOW },
    );
    for (const p of setup.parts)
      assert.ok(shown.text.replace(/\s+/g, ' ').includes(p.what.replace(/\s+/g, ' ')), `${name}: ${p.what}`);
  }
});

test('the parts are not in the tools’ answers, which stay as they were', async () => {
  const r = await runTool('xsolana_cost', { example: 'blind-forge' }, { now: NOW });
  assert.ok(!('parts' in JSON.parse(JSON.stringify(r.setup))));
  assert.match(
    cost(examples().find(e => e.name === 'blind-forge').spec, { now: NOW }).setup.parts.at(-1).what,
    /reserve/,
  );
});
