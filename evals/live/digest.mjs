#!/usr/bin/env node
// One Markdown file per saved run, for reading the conversations closely (by a person, or by reviewers in parallel):
// the card, the grade, then the conversation, each message headed USER, ASSISTANT or SYSTEM.
//
//   node evals/live/digest.mjs <out folder> <label>=evals/results/live-<time> [more label=folder]
//
// writes <out>/<label>-<harness>-<card>.md, for example before-claude-coin-flip.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [out, ...runs] = process.argv.slice(2);
if (!out || !runs.length) {
  console.error('node evals/live/digest.mjs <out folder> <label>=<run folder> [more]');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const BASE_CARDS = JSON.parse(readFileSync(new URL('./cards.json', import.meta.url), 'utf8')).cards;
// A round run with --cards keeps its own copy of the cards beside it.
const cardsOf = (runDir) => (existsSync(path.join(runDir, 'cards.json')) ? JSON.parse(readFileSync(path.join(runDir, 'cards.json'), 'utf8')).cards : BASE_CARDS);
let written = 0;
for (const run of runs) {
  const [label, runDir] = run.includes('=') ? run.split('=') : [path.basename(run), run];
  const cards = cardsOf(runDir);
  for (const harness of readdirSync(runDir).filter((d) => ['claude', 'codex'].includes(d)))
    for (const id of readdirSync(path.join(runDir, harness))) {
      const where = path.join(runDir, harness, id);
      if (!existsSync(path.join(where, 'conversation.json'))) continue;
      const conversation = JSON.parse(readFileSync(path.join(where, 'conversation.json'), 'utf8'));
      const grade = existsSync(path.join(where, 'grade.json')) ? readFileSync(path.join(where, 'grade.json'), 'utf8') : '{}';
      const text = [
        `# ${label} ${harness} ${id}`,
        `CARD: ${JSON.stringify(cards.find((c) => c.id === id) ?? null)}`,
        `GRADE: ${JSON.stringify(JSON.parse(grade))}`,
        '',
        ...conversation.map((m) => `## ${String(m.from).toUpperCase()}\n\n${m.text}\n`),
      ].join('\n');
      writeFileSync(path.join(out, `${label}-${harness}-${id}.md`), text);
      written++;
    }
}
console.log(`${written} runs written to ${out}`);
