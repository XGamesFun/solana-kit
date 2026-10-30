#!/usr/bin/env node
// Copies skills/ into the places each harness reads them: the plugin (plugin/skills, for Claude Code and Codex), and
// this repository's own .claude/skills and .agents/skills (an agent working in this checkout). Byte for byte; extra
// files there are removed. `--check` exits 1 when a copy differs. Each skill needs front matter whose `name` is its
// folder's and a `description` of at most 1,024 characters (the Agent Skills standard).
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'skills');
const MIRRORS = ['plugin/skills', '.claude/skills', '.agents/skills'].map((p) => path.join(root, p));
const check = process.argv.includes('--check');

async function files(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p, base)));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

const problems = [];
for (const skill of await readdir(SOURCE)) {
  if (!(await stat(path.join(SOURCE, skill))).isDirectory()) continue;
  const text = await readFile(path.join(SOURCE, skill, 'SKILL.md'), 'utf8').catch(() => '');
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
  if (name !== skill) problems.push(`${skill}: front matter name is "${name}", not the folder's`);
  if (!description || description.length > 1024) problems.push(`${skill}: description must be 1 to 1,024 characters (it is ${description.length})`);
}
const want = await files(SOURCE);
for (const mirror of MIRRORS) {
  const have = await files(mirror);
  for (const f of want) {
    const a = await readFile(path.join(SOURCE, f));
    const b = await readFile(path.join(mirror, f)).catch(() => null);
    if (b && a.equals(b)) continue;
    if (check) problems.push(`${path.relative(root, mirror)}/${f} differs from skills/${f}`);
    else {
      await mkdir(path.dirname(path.join(mirror, f)), { recursive: true });
      await cp(path.join(SOURCE, f), path.join(mirror, f));
    }
  }
  for (const f of have.filter((x) => !want.includes(x))) {
    if (check) problems.push(`${path.relative(root, mirror)}/${f} is not in skills/`);
    else await rm(path.join(mirror, f));
  }
}
if (problems.length) {
  for (const p of problems) console.error(p);
  if (check) console.error('Run `node scripts/sync-skills.mjs` to copy skills/ again.');
  process.exit(1);
}
console.log(check ? 'skills match their copies' : `copied skills/ to ${MIRRORS.map((m) => path.relative(root, m)).join(', ')}`);
