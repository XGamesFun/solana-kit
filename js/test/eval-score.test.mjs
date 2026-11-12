// The single-turn eval's scorer scores what the skill asks for: where a prompt expects the choice put to the person
// first ("offer": true), a run that stops to ask passes; elsewhere a build still needs a spec that checks.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { offers, score } from '../../evals/score.mjs';
import { example } from '../economy/examples.mjs';

/** A Claude Code stream-json transcript: one xsolana tool call, then the words. */
const transcript = words =>
  [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__xsolana__xsolana_check', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: words }] } },
  ]
    .map(e => JSON.stringify(e))
    .join('\n');
const ASK =
  'The simplest version takes the page’s word within caps. Which would you rather: your server decides each result, or it only bounds what the page reports?';
const quest = { id: 'quest', expect: 'build', offer: true, parts: ['grants'], prompt: 'a quest reward' };

test('a question to the person counts as an offer; a statement does not', () => {
  assert.ok(offers(ASK));
  assert.ok(!offers('I built it. It checks.'));
});

test('an offer prompt passes a run that stops to ask, and a build prompt does not', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'xsolana-score-'));
  const r = score(quest, empty, transcript(ASK));
  assert.equal(r.pass, true, r.failed.join());
  assert.equal(r.offered, true);
  const build = score({ ...quest, offer: undefined }, empty, transcript(ASK));
  assert.equal(build.pass, false);
  assert.ok(build.failed.includes('specChecks'));
});

test('an offer prompt still scores a run that built as a build, and fails a spec that does not check', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-score-'));
  writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify({ version: 2, boxes: {} }));
  const bad = score(quest, dir, transcript(ASK));
  assert.equal(bad.pass, false);
  assert.equal(bad.offered, false);
  const built = mkdtempSync(path.join(tmpdir(), 'xsolana-score-'));
  writeFileSync(path.join(built, 'xsolana.json'), JSON.stringify(example('coin-flip-arena').spec));
  const ok = score({ ...quest, parts: ['boxes'] }, built, transcript('Built it: the coin flip checks.'));
  assert.equal(ok.pass, true, ok.failed.join());
});
