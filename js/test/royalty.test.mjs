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
    lines.some(l => /^Royalty: 5% of resales goes to the signing wallet \(w\)/.test(l)),
    lines.join('\n'),
  );
});

test('approve’s printout says where sales land when the file names no treasury, and whose the royalty is', () => {
  const state = steps => ({
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
    steps,
  });
  const make = {
    says: 'Make the collection “Hello Shop”, with 5% resale royalty to you; the project may mint into it',
  };
  const sale = {
    says: 'Put “Potion” in the shop at 0.1 SOL',
    details: ['Pays: all of it to the treasury (your wallet (w))'],
  };
  const keyIs = approvalText(
    state([make, { says: 'Open the project; your wallet signs its decisions, and your wallet is its treasury' }, sale]),
    { keyFile: 'k.json' },
  );
  assert.ok(
    keyIs.some(l => /^Treasury: the file names none, so what players pay lands at this key’s address/.test(l)),
    keyIs.join('\n'),
  );
  assert.ok(keyIs.some(l => /signing wallet \(w\) on marketplaces/.test(l)));
  const named = approvalText(
    state([make, { says: 'Open the project; your wallet signs its decisions, and T is its treasury' }, sale]),
    {
      keyFile: 'k.json',
    },
  );
  assert.ok(!named.some(l => /^Treasury:/.test(l)));
  assert.ok(
    named.some(l => /signing wallet \(w\).*different treasury leaves royalties with this wallet/.test(l)),
    named.join('\n'),
  );
});
