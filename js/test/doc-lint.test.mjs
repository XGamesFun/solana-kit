// What the agent reads names only what exists: every xsolana_* tool, CLI command and guide part named in the skill,
// its references, the MCP instructions and the README is real, every tool is named in the instructions, and the
// always-loaded texts stay within their budgets.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IDL, MAX_SHARES } from '../client/ix.js';
import { LOTTERY_TIMEOUT_SECONDS, STALE_SECONDS } from '../client/policy.js';
import { cost } from '../economy/cost.mjs';
import { ideas, ideasRated } from '../economy/examples.mjs';
import { catalog, guideText, PARTS, PLAIN_VALUES, TOPICS } from '../economy/guide.mjs';
import { SCHEMA } from '../economy/validate.mjs';
import { INSTRUCTIONS, REMOTE_INSTRUCTIONS, runTool } from '../mcp/server.mjs';
import { REMOTE_TOOLS, tools, VERSION } from '../mcp/tools.mjs';

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

test('a guide part shows every shape its fields name, but for the plain values the writing topic describes', () => {
  const shapes = Object.keys(SCHEMA.$defs);
  for (const name of Object.keys(PARTS)) {
    const [part] = catalog(name);
    const shown = new Set([...(part.nested ?? []).map(n => n.name), PARTS[name].def, ...PLAIN_VALUES]);
    const fields = [...part.fields, ...(part.nested ?? []).flatMap(n => n.fields)];
    for (const f of fields) {
      // a type as the guide prints it: a shape's name stands bare, outside a field list ({ a, b? }) and a quoted value
      const bare = f.type.replace(/\{[^}]*\}|"[^"]*"/g, '');
      for (const word of bare.match(/[A-Za-z]+/g) ?? [])
        if (shapes.includes(word))
          assert.ok(
            shown.has(word),
            `xsolana_guide {"part": "${name}"} says ${f.name} is a ${word}, and shows no ${word}`,
          );
    }
  }
  // (how an amount, a percent, a time and a key are written is in the writing topic)
  const writing = guideText('writing');
  for (const word of ['Amounts', 'percents', 'durations', '`key`'])
    assert.ok(writing.includes(word), `the writing topic says nothing of ${word}`);
});

test('the guide says how many shares a split holds as the client counts them', () => {
  assert.ok(
    SCHEMA.$defs.split.description.includes(`at most ${MAX_SHARES} shares`),
    `schema.json's split says another number than the client's MAX_SHARES (${MAX_SHARES})`,
  );
  // said once, where the shape is: no other text an agent reads gives a split a size
  const others = {
    ...Object.fromEntries(
      [...Object.keys(PARTS), ...Object.keys(TOPICS)].map(name => [
        `xsolana_guide {"part": "${name}"}`,
        guideText(name).replace(SCHEMA.$defs.split.description, ''),
      ]),
    ),
    ...Object.fromEntries(Object.entries(TEXTS).filter(([name]) => name.startsWith(skill))),
    'examples/ideas.json': ideas()
      .map(i => i.how)
      .join('\n'),
  };
  for (const [name, text] of Object.entries(others))
    assert.doesNotMatch(text, /(up to|at most) (four|eight|\d+) (ways|shares)/, name);
});

test('the rated ideas are shown with the version of loot they were rated against', async () => {
  const file = JSON.parse(read('examples/ideas.json'));
  assert.equal(ideasRated(), file.rated);
  assert.ok(
    file.about.includes(`rated against loot ${file.rated}`),
    'ideas.json: `about` and `rated` name two versions',
  );
  const found = await runTool('xsolana_examples', { query: 'liquid staking of SOL with a validator' });
  assert.ok(found.ideas.length, 'the query finds a rated idea');
  assert.ok(
    found.text.includes(
      file.rated === VERSION
        ? 'rated against this version of loot'
        : `rated against loot ${file.rated}, an earlier version`,
    ),
    found.text,
  );
});

test('the documents and the tools give the client’s deadlines for a roll the oracle never answers', async () => {
  const minutes = String(Number(STALE_SECONDS) / 60);
  const days = String(Number(LOTTERY_TIMEOUT_SECONDS) / 86_400);
  // what explain says of a box that is sold: a purchase is refunded, a roll won another way asked again
  const explained = (await runTool('xsolana_explain', { example: 'partner-vault' })).text;
  assert.ok(explained.includes(`hasn't answered ${minutes} minutes after it was asked can be refunded`), explained);
  assert.ok(explained.includes(`can be refunded ${days} days after its first ask`), explained);
  const said = (file, pattern, number) => {
    const found = pattern.exec(read(file).replace(/\s+/g, ' '));
    assert.ok(found, `${file} no longer says ${pattern}`);
    assert.equal(found[1], number, `${file}: “${found[0]}”`);
  };
  said(
    'docs/tutorial-loot-box.md',
    /not answered (\d+) minutes after it was asked, the purchase can be refunded/,
    minutes,
  );
  said('docs/before-you-use.md', /not been answered (\d+) minutes after it was asked can be refunded/, minutes);
  said('docs/before-you-use.md', /can be refunded (\d+) days after its first ask/, days);
  said('docs/program.md', /refunds after (\d+) minutes \(`STALE_SECONDS`/, minutes);
  said('docs/program.md', /refunds (\d+) days after its first ask \(`LOTTERY_TIMEOUT_SECONDS`/, days);
});

test('the numbers the skill quotes for its worked example are the tools’ own', () => {
  const NOW = 1_790_000_000;
  const draft = JSON.parse(/```json\n([\s\S]*?)```/.exec(TEXTS[`${skill}references/sentence-to-spec.md`])[1]);
  const cast = cost(draft, { now: NOW }).actions.find(a => a.part === 'box:cast').inAllSol;
  const live = seed => cost({ ...draft, pools: [{ ...draft.pools[0], seed }] }, { now: NOW }).setup.totalSol;
  const rounded = (n, places) => String(Number(n.toFixed(places)));
  const says = (file, words) =>
    assert.ok(
      TEXTS[`${skill}references/${file}`].replace(/\s+/g, ' ').includes(words),
      `${file} does not say “${words}”, which is what the tools answer for its example`,
    );
  for (const file of ['sentence-to-spec.md', 'telling-the-person.md']) {
    says(file, `cast costs about ${rounded(cast, 4)} SOL in all`);
    says(file, `bout ${rounded(live(12.5), 2)} SOL`);
  }
  says('sentence-to-spec.md', `about ${rounded(live(2), 2)} SOL to go live`);
});

test('the program reference counts the instructions the IDL has, and names no other as one', () => {
  const page = read('docs/program.md');
  const names = IDL.instructions.map(i => i.name);
  assert.match(page, new RegExp(`\\b${names.length} instructions\\b`), `the IDL has ${names.length} instructions`);
  const table = page.slice(page.indexOf('## Every instruction'), page.indexOf('## Money in, and where it goes'));
  for (const name of names) assert.ok(table.includes(`\`${name}\``), `“Every instruction” has no row for ${name}`);
  // the compute table's rows are instructions too
  const compute = page.slice(page.indexOf('**Compute units**'));
  const rows = compute.slice(compute.indexOf('\n| '), compute.indexOf('\n\n', compute.indexOf('\n| ')));
  for (const [, name] of rows.matchAll(/`([a-z_]+)`/g))
    assert.ok(names.includes(name), `the compute table measures ${name}, which the program does not have`);
});

test('a tool’s two descriptions agree: every number and named term the hosted one gives is in the local one', () => {
  // a number, a term in code, a term in double quotes
  const terms = text => new Set([...text.matchAll(/`[^`]+`|"[^"]+"|\b\d[\d,.]*\b/g)].map(m => m[0]));
  for (const tool of tools.filter(t => t.hosted)) {
    const local = terms(tool.description);
    for (const term of terms(tool.hosted))
      assert.ok(local.has(term), `${tool.name}: its hosted description says ${term}, and its local one does not`);
  }
  // what a tool reads is said by the cluster it reads, never by one cluster's name
  for (const tool of tools)
    for (const text of [tool.description, tool.hosted ?? ''])
      assert.doesNotMatch(text, /\bReads (devnet|mainnet)\b/, `${tool.name} reads the cluster its call is for`);
});

test('the eval judge counts nothing loot runs on as outside loot', () => {
  const outside = /Truly outside loot:([^.]*)\./.exec(read('evals/judge.mjs'));
  assert.ok(outside, 'evals/judge.mjs no longer lists what is outside loot');
  assert.doesNotMatch(outside[1], /\b(devnet|mainnet)\b/);
});
