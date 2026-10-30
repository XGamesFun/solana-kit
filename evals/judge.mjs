#!/usr/bin/env node
// The composition judge: reads each run of a fresh-session round (evals/run.mjs --prompts evals/composition-prompts.json)
// and asks Claude, with loot's parts as the reference, how the agent handled each piece of the idea. It catches what
// the scorer's regexes can't: an agent that said "loot can't" where two parts together do it (undersold), one that
// claimed something loot can't do (overclaimed), and a piece of the idea left out without a word (dropped).
//
//   node evals/judge.mjs <run dir> [--model opus] [--parallel 4] [--prompts evals/composition-prompts.json] [--tag t]
//
// Writes judge.json beside each run's score.json, and judge.md (the table and every finding) in the run dir.
// The judge sees the prompt's notes (`judge` in the prompts file); the agent under test never does.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askClaude, jsonOf } from './live/agents.mjs';
import { readTranscript } from './score.mjs';
import { catalog, CONVENTIONS } from '../js/economy/guide.mjs';
import { check } from '../js/economy/check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const runDir = path.resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '');
const model = opt('model', 'opus');
const parallel = Number(opt('parallel', 4));
// --tag t writes judge-t.json / judge-t.md, so a judge change can be compared with earlier verdicts.
const tag = opt('tag') ? `-${opt('tag')}` : '';
const promptFile = path.resolve(opt('prompts', path.join(ROOT, 'evals/composition-prompts.json')));
if (!existsSync(path.join(runDir, 'summary.json'))) throw new Error(`No round at ${runDir} (summary.json missing).`);
const PROMPTS = new Map(JSON.parse(readFileSync(promptFile, 'utf8')).prompts.map((p) => [p.id, p]));
const { version: LOOT_VERSION } = JSON.parse(readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
// How the program behaves (docs/program.md), so the judge can tell a real limit from an overclaim.
const programSpec = path.join(ROOT, 'docs/program.md');
const PROGRAM_MD = existsSync(programSpec) ? readFileSync(programSpec, 'utf8') : null;
if (!PROGRAM_MD) console.error(`No ${programSpec}: judging from the parts and conventions only.`);

// What loot can do, from the schema and the parts' own words: the judge's reference. The "cannot" list is left out on
// purpose: it is one of the things being judged.
const REFERENCE = [
  ...catalog().map((p) => `${p.part}: ${p.says}${p.atPlayTime ? ` At play time: ${p.atPlayTime}.` : ''}\n  fields: ${p.fields.map((f) => f.name).join(', ')}`),
  '',
  'Conventions:',
  ...CONVENTIONS.map((c) => `- ${c}`),
  '',
  ...(PROGRAM_MD ? ['How the program behaves (docs/program.md), for anything the parts above leave out:', PROGRAM_MD, ''] : []),
  'Made from a page at run time, not in xsolana.json, but part of loot: fixed-price listings of any NFT between players (for sale or for rent by the period), bids for any NFT that passes a rule, and fixed-term loans against an NFT between players (no price oracle, no liquidation).',
  'Truly outside loot: AMMs, order books, bonding curves with sell-back, fees on trades made elsewhere, lending against tokens, liquidation by price, leverage/perps/price oracles, native SOL staking, governance votes, pulling funds from a wallet without its signature, mainnet (not audited yet). What the chain cannot see (a match, steps, a store visit, a score) is vouched for by a signer: a voucher key (a results server such as the games.fun loot server, or the project\'s own), which is a normal composition, not a gap.',
].join('\n');

const SYSTEM = `You judge how an AI coding agent handled a person's request to build an onchain economy on loot, a shared Solana program configured by a JSON spec. You are strict and concrete.

THE REFERENCE comes first in the message (what loot ${LOOT_VERSION} can do: the spec's parts, then the program's own spec). Trust it over anything the agent said, and don't call a claim an overclaim when the program spec supports it.

YOUR JOB: For each core ask of the person's idea, decide what the agent did with it:
- "built": in the saved spec, as asked.
- "composed": in the saved spec, by combining parts (A+B=X) where no single part does it, and the agent said so.
- "approximated": built a near version and said plainly what it gives up.
- "offered": described a workable way but didn't put it in the spec (e.g. it asked the person to choose first). Fine for a first turn only when a real choice exists.
- "declined-correctly": said loot can't do it, and the reference agrees nothing composes to it; best if it offered the nearest version.
- "declined-wrongly": said loot can't do it (or steered away from it) although the reference shows a part or a composition that does it. This is underselling.
- "dropped": left it out without saying so.
Then list:
- "undersold": each claim the agent made that loot cannot do something it can (quote the agent briefly, and name the part(s) that do it).
- "overclaimed": each claim that loot does something it can't, or a spec field used for something it doesn't do (quote briefly).
- "score": 0-10. 10 = every ask built or composed (or honestly declined only where truly impossible, with the nearest version offered), no false claims. Deduct heavily for declined-wrongly and dropped, and for overclaims. A first-turn answer that asks a needed question and proposes a concrete composition can still score 7-8.
Judge what the agent told the person and what it saved, not its tool calls. The judge notes are hints from the eval's author: another valid composition counts as much as the one they name.

Answer with ONLY a JSON object: {"asks":[{"ask":"...","status":"built|composed|approximated|offered|declined-correctly|declined-wrongly|dropped","note":"..."}],"undersold":["..."],"overclaimed":["..."],"score":0,"summary":"one sentence"}`;

function runsOf(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !['claude', 'codex'].includes(ent.name)) continue;
    const harness = ent.name;
    const hdir = path.join(dir, harness);
    for (const ent of readdirSync(hdir, { withFileTypes: true })) if (ent.isDirectory() && existsSync(path.join(hdir, ent.name, 'transcript.jsonl'))) out.push({ harness, id: ent.name, dir: path.join(hdir, ent.name) });
  }
  return out;
}

async function judge(run) {
  const p = PROMPTS.get(run.id);
  if (!p?.judge) return null;
  const t = readTranscript(readFileSync(path.join(run.dir, 'transcript.jsonl'), 'utf8'));
  const specFile = path.join(run.dir, 'project', 'xsolana.json');
  let specText = '(no xsolana.json saved)';
  if (existsSync(specFile)) {
    const raw = readFileSync(specFile, 'utf8');
    let verdict;
    try {
      const v = check(JSON.parse(raw));
      verdict = v.ok ? `checks clean (${v.warnings.length} warnings)` : `REFUSED: ${v.refusals.map((r) => r.code).join(', ')}`;
    } catch (e) {
      verdict = `unreadable: ${e.message}`;
    }
    specText = `${verdict}\n${raw.slice(0, 24_000)}`;
  }
  const prompt = [
    `THE REFERENCE:\n${REFERENCE}\n\n----\n`,
    `THE PERSON ASKED:\n${p.prompt}`,
    `\nJUDGE NOTES (hints, not shown to the agent):\n- core asks: ${p.judge.asks.join(' | ')}\n- one known way: ${p.judge.compose}\n- truly impossible: ${p.judge.truly}`,
    `\nWHAT THE AGENT TOLD THE PERSON (all its messages):\n${t.words.slice(-16_000) || '(nothing)'}`,
    `\nTHE SPEC IT SAVED (xsolana.json):\n${specText}`,
    '\nYour verdict (JSON only):',
  ].join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await askClaude({ system: SYSTEM, prompt, model, cwd: run.dir, env: process.env, timeoutMs: 8 * 60_000 });
    const v = jsonOf(text);
    if (v && typeof v.score === 'number') return v;
  }
  return { error: 'the judge gave no verdict' };
}

const runs = runsOf(runDir);
const results = [];
const queue = [...runs];
await Promise.all(
  Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const run = queue.shift();
      const v = await judge(run);
      if (!v) continue;
      writeFileSync(path.join(run.dir, `judge${tag}.json`), JSON.stringify(v, null, 2));
      const p = PROMPTS.get(run.id);
      results.push({ ...run, split: p.split, v });
      console.error(`${String(v.score ?? '?').padStart(2)} ${run.harness} ${run.id}${v.undersold?.length ? ` undersold ${v.undersold.length}` : ''}${v.overclaimed?.length ? ` overclaimed ${v.overclaimed.length}` : ''}`);
    }
  }),
);

results.sort((a, b) => a.harness.localeCompare(b.harness) || a.split.localeCompare(b.split) || a.id.localeCompare(b.id));
const count = (rs, s) => rs.reduce((n, r) => n + (r.v.asks ?? []).filter((a) => a.status === s).length, 0);
const mean = (rs) => (rs.length ? (rs.reduce((n, r) => n + (r.v.score ?? 0), 0) / rs.length).toFixed(2) : '-');
const groups = [...new Set(results.map((r) => `${r.harness}/${r.split}`))];
const md = [
  `# Composition judge, ${path.basename(runDir)}`,
  '',
  `Judge: ${model}. Prompts: ${path.relative(ROOT, promptFile)}.`,
  '',
  '| Group | Runs | Mean score | Undersold claims | Overclaims | declined-wrongly | dropped | composed |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...groups.map((g) => {
    const rs = results.filter((r) => `${r.harness}/${r.split}` === g);
    return `| ${g} | ${rs.length} | ${mean(rs)} | ${rs.reduce((n, r) => n + (r.v.undersold?.length ?? 0), 0)} | ${rs.reduce((n, r) => n + (r.v.overclaimed?.length ?? 0), 0)} | ${count(rs, 'declined-wrongly')} | ${count(rs, 'dropped')} | ${count(rs, 'composed')} |`;
  }),
  '',
  '| Harness | Split | Prompt | Score | Asks (status) | Summary |',
  '| --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.harness} | ${r.split} | ${r.id} | ${r.v.score ?? '?'} | ${(r.v.asks ?? []).map((a) => a.status).join(', ')} | ${String(r.v.summary ?? r.v.error ?? '').replace(/\|/g, '/')} |`),
  '',
  '## Findings',
  ...results.flatMap((r) => [
    ...(r.v.undersold ?? []).map((u) => `- **${r.harness} ${r.id}** undersold: ${u}`),
    ...(r.v.overclaimed ?? []).map((u) => `- **${r.harness} ${r.id}** overclaimed: ${u}`),
    ...(r.v.asks ?? []).filter((a) => a.status === 'declined-wrongly' || a.status === 'dropped').map((a) => `- ${r.harness} ${r.id} ${a.status}: ${a.ask}: ${a.note}`),
  ]),
];
writeFileSync(path.join(runDir, `judge${tag}.md`), `${md.join('\n')}\n`);
console.log(md.slice(0, 6 + groups.length).join('\n'));
