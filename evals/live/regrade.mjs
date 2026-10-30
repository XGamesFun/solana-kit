#!/usr/bin/env node
// Grades saved runs again with the current grader, from what each run recorded: after a change to grade.mjs or
// cards.json, see how earlier rounds come out without running them again. Changes nothing on disk.
//
//   node evals/live/regrade.mjs evals/results/live-<time> [more run folders]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonOf } from './agents.mjs';
import { grade } from './grade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_CARDS = JSON.parse(readFileSync(path.join(ROOT, 'evals/live/cards.json'), 'utf8')).cards;
// A round run with --cards keeps its own copy of the cards beside it.
const cardsOf = (runDir) => (existsSync(path.join(runDir, 'cards.json')) ? JSON.parse(readFileSync(path.join(runDir, 'cards.json'), 'utf8')).cards : BASE_CARDS);
const lines = (f) =>
  readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
const codes = (l) => [...new Set(l.map((x) => x.code))].join(' ');

for (const runDir of process.argv.slice(2)) {
  const cards = cardsOf(runDir);
  for (const harness of readdirSync(runDir).filter((d) => ['claude', 'codex'].includes(d)))
    for (const id of readdirSync(path.join(runDir, harness))) {
      const where = path.join(runDir, harness, id);
      const card = cards.find((c) => c.id === id);
      if (!card || !existsSync(path.join(where, 'conversation.json'))) continue;
      const conversation = JSON.parse(readFileSync(path.join(where, 'conversation.json'), 'utf8'));
      const files = readdirSync(where);
      const turns = files.filter((f) => /^turn-\d+\.jsonl$/.test(f)).map((f) => ({ events: lines(path.join(where, f)) }));
      const approvals = conversation.filter((m) => m.from === 'system' && /^You ran it/.test(m.text)).map((m) => ({ ok: /approved in your wallet/.test(m.text), said: m.text }));
      const players = files.filter((f) => /^player-\d+\.jsonl$/.test(f)).sort().map((f) => {
        const text = lines(path.join(where, f)).filter((e) => e.type === 'result').map((e) => e.result).join('\n');
        return { text, report: jsonOf(text.slice(text.lastIndexOf('{"tasks"'))) ?? jsonOf(text) };
      });
      const walletLogs = files.filter((f) => /^wallet-.*\.jsonl$/.test(f)).map((f) => ({ role: f.includes('owner') ? 'owner' : 'player', findings: lines(path.join(where, f)).flatMap((l) => l.findings ?? []) }));
      // The player's test wallet, for the checks that name {PLAYER}. An older grade.json may not have it; those checks
      // are then skipped.
      const before = existsSync(path.join(where, 'grade.json')) ? JSON.parse(readFileSync(path.join(where, 'grade.json'), 'utf8')) : {};
      const playerAddress = before.player ?? '';
      const g = grade({ card, dir: path.join(where, 'project'), conversation, turns, approvals, players, walletLogs, playerAddress });
      const result = g.pass ? 'clean   ' : g.secure ? 'mistakes' : 'SECURITY';
      console.log(`${harness.padEnd(6)} ${id.padEnd(15)} ${result} | ${codes(g.security)} | ${codes(g.mistakes)} | ${g.notes.map((n) => n.split(':')[0]).join(' ')}`);
    }
}
