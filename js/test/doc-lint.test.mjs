// What the agent reads names only what exists: every xsolana_* tool, CLI command and guide part named in the skill,
// its references, the MCP instructions and the README is real, every tool is named in the instructions, and the
// always-loaded texts stay within their budgets.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PARTS, TOPICS } from '../economy/guide.mjs';
import { INSTRUCTIONS, REMOTE_INSTRUCTIONS, runTool } from '../mcp/server.mjs';
import { REMOTE_TOOLS, tools } from '../mcp/tools.mjs';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const skill = 'skills/xsolana-economy/';
const references = readdirSync(new URL(`${skill}references/`, root)).map(f => `${skill}references/${f}`);
/** Every agent-facing text, by name. */
const TEXTS = {
  [`${skill}SKILL.md`]: read(`${skill}SKILL.md`),
  ...Object.fromEntries(references.map(f => [f, read(f)])),
  'README.md': read('README.md'),
  'the MCP instructions': INSTRUCTIONS,
  'the hosted MCP instructions': REMOTE_INSTRUCTIONS,
};
const TOOLS = new Set(tools.map(t => t.name));
/** The CLI's commands: the keys of the flags table in bin/xsolana.mjs, and the cases its command switch takes. */
const CLI = read('bin/xsolana.mjs');
const COMMANDS = new Set([
  ...[...CLI.match(/const FLAGS = \{([\s\S]*?)\n\};/)[1].matchAll(/^ {2}([a-z]+):/gm)].map(m => m[1]),
  ...[...CLI.matchAll(/^ {4}case '([a-z]+)':/gm)].map(m => m[1]),
]);

test('the CLI commands are read from the flags table', () => {
  for (const c of ['guide', 'check', 'keygen', 'approve', 'tool', 'mcp']) assert.ok(COMMANDS.has(c), c);
});

test('every xsolana_* tool named in the skill, the references, the instructions and the README exists', () => {
  for (const [name, text] of Object.entries(TEXTS))
    for (const [tool] of text.matchAll(/\bxsolana_[a-z]+\b/g))
      assert.ok(TOOLS.has(tool), `${name} names ${tool}, which is not a tool`);
});

test('every CLI command they name exists', () => {
  for (const [name, text] of Object.entries(TEXTS)) {
    // A command as it is run: `npx … @xgamesfun/solana@<version> <command>`, or `xsolana <command>` in code.
    const code = name.endsWith('.md')
      ? [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map(m => m[0]).join('\n')
      : text;
    const said = [
      ...[...text.matchAll(/@xgamesfun\/solana@\S+ (?:xsolana )?([a-z][a-z-]*)\b/g)].map(m => m[1]),
      // (a choice of commands: <guide|examples|check>)
      ...[...text.matchAll(/@xgamesfun\/solana@\S+ <([a-z|]+)>/g)].flatMap(m => m[1].split('|')),
      ...[...code.matchAll(/(?:^|[\s`(])xsolana ([a-z][a-z-]*)\b/g)].map(m => m[1]),
    ];
    for (const command of said)
      assert.ok(COMMANDS.has(command), `${name} names the command “xsolana ${command}”, which the CLI doesn't take`);
  }
});

test('every guide part they name exists', () => {
  const parts = new Set([...Object.keys(PARTS), ...Object.keys(TOPICS)]);
  for (const [name, text] of Object.entries(TEXTS))
    for (const [, part] of text.matchAll(/"part":\s*"([a-z]+)"/g))
      assert.ok(parts.has(part), `${name} names the guide part “${part}”, which xsolana_guide doesn't take`);
});

test('every reference the skill names is there', () => {
  for (const [, file] of TEXTS[`${skill}SKILL.md`].matchAll(/`(references\/[a-z-]+\.md)`/g))
    assert.ok(existsSync(new URL(`${skill}${file}`, root)), file);
});

test('the instructions name every tool their server lists', () => {
  for (const tool of TOOLS) assert.ok(INSTRUCTIONS.includes(tool), `the MCP instructions don't name ${tool}`);
  for (const tool of REMOTE_TOOLS)
    assert.ok(REMOTE_INSTRUCTIONS.includes(tool), `the hosted MCP instructions don't name ${tool}`);
});

test('the always-loaded texts stay within their budgets', async () => {
  const body = TEXTS[`${skill}SKILL.md`];
  assert.ok(body.length <= 15_000, `SKILL.md is ${body.length} characters: at most 15,000 (replace, don't stack)`);
  const words = INSTRUCTIONS.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 260, `the MCP instructions are ${words} words: at most about 250`);
  const index = await runTool('xsolana_guide', {});
  assert.ok(index.text.length <= 6_000, `xsolana_guide {} is ${index.text.length} characters: at most 6,000`);
  // The first call names every part and topic, so the agent fetches the one it needs.
  for (const part of [...Object.keys(PARTS), ...Object.keys(TOPICS)])
    assert.match(index.text, new RegExp(`^- ${part}: `, 'm'), `the guide's index doesn't name ${part}`);
});
