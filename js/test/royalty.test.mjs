// The resale royalty the setup writes into the collection it makes (5% to the owner unless the spec says) is said in
// check, cost, explain and approve's printout, never only inside a step.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalText } from '../approve/with-key.mjs';
import { examples } from '../economy/examples.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;
const T = { check: ['file'], cost: ['file'], explain: ['file'] };
const spec = examples().find(e => e.name === 'hello-shop').spec;
const flat = t => t.replace(/\s+/g, ' ');

test('check, cost and explain say the collection’s royalty, its default and how to set it', async () => {
  for (const tool of ['check', 'cost', 'explain']) {
    const r = await runTool(`xsolana_${tool}`, { spec }, { terminal: T, reader: 'person', now: NOW });
    assert.match(
      flat(r.text),
      /The collection “Hello Shop” is made with a 5% resale royalty to your wallet \(the default: "collection": \{ "royaltyPercent": n \} sets it, 0 for none\)/,
      tool,
    );
  }
  const none = { ...spec, collection: { name: 'Hello Shop', royaltyPercent: 0 } };
  const r = await runTool('xsolana_explain', { spec: none }, { now: NOW });
  assert.match(flat(r.text), /a 0% resale royalty to your wallet \("royaltyPercent" in the spec\)/);
  const tokensOnly = await runTool(
    'xsolana_explain',
    { spec: { ...spec, items: [], boxes: [], collection: false } },
    { now: NOW },
  );
  assert.doesNotMatch(tokensOnly.text, /resale royalty/);
});

test('approve’s printout gives the royalty a line of its own', () => {
  const lines = approvalText(
    {
      cluster: 'devnet',
      mode: 'new',
      name: 'Hello Shop',
      file: 'xsolana.json',
      program: 'p',
      wallet: 'w',
      fresh: [],
      setupSol: null,
      legal: [],
      warnings: [],
      landed: [],
      remaining: 1,
      steps: [
        { says: 'Make the collection “Hello Shop”, with 5% resale royalty to you; the project may mint into it' },
      ],
    },
    { keyFile: 'k.json' },
  );
  assert.ok(
    lines.some(l => /^Royalty: the new collection takes 5% of each resale for your wallet/.test(l)),
    lines.join('\n'),
  );
});
