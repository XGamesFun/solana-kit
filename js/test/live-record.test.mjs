// What `xsolana approve` writes back into xsolana.json once an economy is live. A project made with no collection wrote
// `live.collection: null`, which its own schema then refused (E-SCHEMA), so a go-live that landed reported an error.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { changedParts, recordLanded } from '../economy/live.mjs';
import { runTool } from '../mcp/server.mjs';

const WALLET = '8yPDcN7S2mxbFrQLqqGfUkg3fTBbZ8ZqYqJ5AD4QK6Ag';
const PROJECT = '2cis7nmNiwkBw181AXnNFLUxpR2ESE9tikkF5WHozrUy';

test('a live record for a project with no collection names none, and checks', () => {
  const spec = { version: 2, network: 'devnet', name: 'Messages', currency: 'sol', collection: false, tokens: [{ key: 'sol', source: 'sol' }], items: [{ key: 'msg', name: 'Message', kind: 'normal', price: 0.001 }] };
  const live = recordLanded(spec, { ctx: { project: PROJECT, collection: null, treasury: WALLET, authority: WALLET, mints: {} }, signatures: [] });
  assert.equal('collection' in live.live, false);
  const verdict = check(live);
  assert.deepEqual(verdict.refusals.map((r) => r.code), []);
});

// A live spec whose authority or treasury changed was once told “nothing to publish”, while the chain kept the old
// ones. Publishing still writes parts only, but it now says so.
test('a change to a live project’s authority or treasury is named, never dropped in silence', async () => {
  const example = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));
  const { live: _, ...published } = example;
  const spec = { ...example, live: { program: 'x', project: PROJECT, treasury: WALLET, authority: WALLET, published } };
  const rotated = { ...spec, keys: { ...(spec.keys ?? {}), authority: 'Fresh1111111111111111111111111111111111111' }, treasury: 'wallet:Treas111111111111111111111111111111111' };
  assert.deepEqual(changedParts(rotated).settings, ['its authority', 'its treasury']);
  assert.deepEqual(changedParts(spec).settings, []);
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-settings-'));
  writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(rotated, null, 2));
  const r = await runTool('xsolana_publish', { file: 'xsolana.json' }, { cwd: dir });
  assert.doesNotMatch(r.text, /nothing to publish|nothing in it has changed/i);
  assert.match(r.text, /its authority, its treasury, and publishing never changes those/);
});
