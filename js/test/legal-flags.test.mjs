// The legal flags: xsolana_publish's answer starts with them, the approval page's state carries them in a block of their
// own (not among the other warnings), and an economy that raises none gets neither.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApproval } from '../approve/server.mjs';
import { check } from '../economy/check.mjs';
import { example } from '../economy/examples.mjs';
import { LEGAL, legalFlags } from '../economy/legal.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;

test('each legal flag once, in plain words, and none for an economy that raises none', () => {
  const flags = legalFlags(check(example('coin-flip-arena').spec, { now: NOW }));
  assert.deepEqual(flags.map((f) => f.code).sort(), ['W-CHANCE-PRIZE', 'W-REVENUE-SHARE']);
  for (const f of flags) assert.equal(f.says, LEGAL[f.code]);
  assert.deepEqual(legalFlags(check(example('fair-presale').spec, { now: NOW })), []);
  assert.deepEqual(legalFlags({ warnings: [{ code: 'W-CHANCE-PRIZE' }, { code: 'W-CHANCE-PRIZE' }, { code: 'toString' }] }), [{ code: 'W-CHANCE-PRIZE', says: LEGAL['W-CHANCE-PRIZE'] }]);
});

test('xsolana_publish leads its answer with the legal flags', async () => {
  const r = await runTool('xsolana_publish', { example: 'coin-flip-arena' }, { now: NOW });
  assert.equal(r.ok, true);
  const lines = r.text.split('\n');
  assert.match(lines[0], /^Before anything else, tell the person/);
  assert.equal(lines[1], `- ${LEGAL['W-REVENUE-SHARE']}`);
  assert.equal(lines[2], `- ${LEGAL['W-CHANCE-PRIZE']}`);
  // with no flags, the answer starts with what going live does
  const plain = (await runTool('xsolana_publish', { example: 'fair-presale' }, { now: NOW })).text;
  assert.match(plain, /^Going live: /);
  // and with or without, it says the program is unaudited, as is, at their own risk, and the law is theirs
  for (const text of [r.text, plain]) assert.match(text, /not independently audited and comes as is, with no warranty; they use it at their own risk, and making sure the economy is legal/);
});

test('the approval state carries the legal flags apart from the other warnings', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-legal-'));
  const file = path.join(dir, 'xsolana.json');
  const chain = { latestBlockhash: async () => ({}), rent: async () => 0, send: async () => '', confirm: async () => true };
  writeFileSync(file, JSON.stringify(example('coin-flip-arena').spec));
  const flagged = (await createApproval({ file, chain, now: () => NOW })).state();
  assert.deepEqual(flagged.legal.map((f) => f.code).sort(), ['W-CHANCE-PRIZE', 'W-REVENUE-SHARE']);
  for (const f of flagged.legal) assert.ok(!flagged.warnings.some((w) => w.includes(f.says)), 'not said twice');
  assert.ok(!flagged.warnings.some((w) => /gambling|security/.test(w)), flagged.warnings.join('\n'));
  writeFileSync(file, JSON.stringify(example('fair-presale').spec));
  assert.deepEqual((await createApproval({ file, chain, now: () => NOW })).state().legal, []);
});
