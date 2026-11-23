// xsolana_status reads a live economy back from the chain: it checks the spec first, as every tool that reads one
// does, and when the project the file names is not on chain it says so, in place of “publish again”. The chain here is
// a stand-in the test hands the tool: nothing reads a network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cluster } from '../client/index.js';
import { runTool } from '../mcp/server.mjs';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, world } from './helpers/world.mjs';

const NOW = 1_790_000_000;
const NOBODY = 'So11111111111111111111111111111111111111112';
/** A small economy as its file reads once it is live at `project`. */
const live = project => ({
  version: 2,
  network: cluster(),
  name: 'Status',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  pools: [{ key: 'house', currency: 'sol', seed: 1 }],
  live: { project },
});
/** A chain that holds what `get` answers for an address, and counts what it was asked. */
const chainOf = get => {
  const asked = [];
  return { asked, rpc: () => ({ accounts: async list => (asked.push(...list), list.map(a => get(a) ?? null)) }) };
};

test('a spec that does not check is refused before the chain is read, with its refusals', async () => {
  const chain = chainOf(() => null);
  for (const spec of [
    { ...live(NOBODY), live: { project: 5 } },
    { ...live(NOBODY), pools: [{ key: 'house', currency: 'gold', seed: 1 }] },
  ]) {
    const r = await runTool('xsolana_status', { spec }, { rpc: chain.rpc, now: NOW });
    assert.equal(r.ok, false);
    assert.ok(r.refusals.length, r.text);
    assert.match(r.text, /fix (it|them) \(each says how\), then run xsolana_check again/);
  }
  assert.deepEqual(chain.asked, [], 'nothing was read');
});

test('a file that names a project the chain does not have is told so, not to publish again', async () => {
  // nothing at the address, and an account there that is not a loot project
  for (const get of [() => null, () => ({ owner: NOBODY, lamports: 1n, data: new Uint8Array(8) })]) {
    const r = await runTool('xsolana_status', { spec: live(NOBODY) }, { rpc: chainOf(get).rpc, now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.text, new RegExp(`there is no loot project at ${NOBODY}`));
    assert.match(r.text, /publishing again would not add it/);
    assert.doesNotMatch(r.text, /xsolana_publish\) to add them/);
    assert.equal(r.rows, undefined, 'no part is listed as missing from a project that is not there');
  }
});

test('a spec that is not live yet is said to be so', async () => {
  const { live: _, ...spec } = live(NOBODY);
  const r = await runTool('xsolana_status', { spec }, { rpc: chainOf(() => null).rpc, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.text, /is not live yet/);
});

test('a part missing from a project that is there is published again', { skip: cannotRun() ?? false }, async () => {
  const w = world({ seed: 'tool-status' });
  const spec = live(w.project);
  const r = await runTool('xsolana_status', { spec }, { rpc: chainOf(a => w.chain.get(a)).rpc, now: NOW });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(
    r.rows.map(row => [row.part, row.found]),
    [
      ['project', true],
      ['pool:house', false],
    ],
  );
  assert.match(r.text, /1 part not on chain: publish again \(xsolana_publish\) to add them/);
  // another address on the same chain holds no project
  const none = await runTool(
    'xsolana_status',
    { spec: live(newAddress(w.random)) },
    { rpc: chainOf(a => w.chain.get(a)).rpc, now: NOW },
  );
  assert.equal(none.ok, false);
});
