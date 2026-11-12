// A schema refusal names the fix: the shape the field takes, from the schema, and the guide's part with every field;
// an argument a tool doesn't take lists the ones it does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { runTool } from '../mcp/server.mjs';

const base = { version: 2, currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }] };
const fixOf = economy => check(economy).refusals.find(r => r.code === 'E-SCHEMA');

test('E-SCHEMA shows the shape the schema expects, and the part of the guide to fetch', () => {
  const list = fixOf({ ...base, boxes: {} });
  assert.match(list.fix, /^It takes a list, each \{ key, .*outcomes.* \}\./);
  assert.match(list.fix, /xsolana_guide \{"part": "boxes"\}/);
  const field = fixOf({ ...base, items: [{ key: 'a', name: 'A', price: 1, nope: 2 }] });
  assert.match(field.message, /economy\.items\[0\]\.nope is not a field this place takes/);
  assert.match(field.fix, /^economy\.items\[0\] takes key, id, name, .*price/);
  assert.match(field.fix, /xsolana_guide \{"part": "items"\}/);
  const top = fixOf({ ...base, wat: 1 });
  assert.match(top.fix, /^economy takes version, network, name/);
});

test('an argument a tool does not take lists the ones it does', async () => {
  const r = await runTool('xsolana_check', { nope: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'arguments.nope is not a field this place takes (it takes spec, file, example)');
  const none = await runTool('xsolana_client', { x: 1 });
  assert.match(none.text, /\(it takes none\)/);
});
