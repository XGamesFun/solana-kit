// The command line is read by the developer, the MCP server by an agent. A named command's text (check, review,
// publish…) says nothing that steers an agent ("Tell the person, in your own words…"), and keeps every finding;
// `--json` and `xsolana tool` keep the agent's words, whose "Ask the person" and "Tell the person" blocks other tools
// parse (xcore's review reads `xsolana check --json`'s text).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { examples } from '../economy/examples.mjs';
import { AGENT_ONLY, personWords, terminalWords } from '../mcp/person.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;
/** What a terminal's words name each tool by (bin/xsolana.mjs TERMINAL), for the tools these tests run. */
const TERMINAL = Object.fromEntries(
  ['check', 'simulate', 'cost', 'explain', 'review', 'publish', 'status'].map(c => [c, ['file']]),
);
const TERMINAL_ALL = { ...TERMINAL, guide: ['part'], examples: ['name', 'query'], token: ['mint'], client: [] };
const person = { terminal: TERMINAL_ALL, reader: 'person', verbose: true, now: NOW };

test('what a named command prints for each worked example says nothing that steers an agent', async () => {
  for (const { name } of examples())
    for (const tool of ['check', 'simulate', 'cost', 'explain', 'review', 'publish']) {
      const r = await runTool(`xsolana_${tool}`, { example: name }, person);
      // (“the program cannot tell them apart”, “rewards follow the stake, not the person”: plain facts)
      const said = String(r.text).replace(/tell them apart|not the person\b/g, '');
      assert.doesNotMatch(said, AGENT_ONLY, `xsolana ${tool} on ${name}`);
      assert.doesNotMatch(said, /\bTell the person\b|\bAsk the person\b/, `xsolana ${tool} on ${name}`);
    }
  for (const input of [{}, { query: 'a fishing game with a monthly draw' }, { name: 'nft-raffle' }]) {
    const r = await runTool('xsolana_examples', input, person);
    assert.doesNotMatch(r.text, AGENT_ONLY, JSON.stringify(input));
  }
  assert.doesNotMatch((await runTool('xsolana_guide', {}, person)).text, AGENT_ONLY, 'xsolana guide');
});

test('check for a person keeps every warning and question, and --verbose adds what players should know', async () => {
  for (const name of ['community-coin', 'shelter-fair']) {
    const agent = await runTool('xsolana_check', { example: name }, { terminal: TERMINAL_ALL, now: NOW });
    const short = await runTool('xsolana_check', { example: name }, { ...person, verbose: false });
    const long = await runTool('xsolana_check', { example: name }, person);
    for (const w of agent.warnings) assert.ok(short.text.includes(w.code), `${name}: ${w.code}`);
    // (a question a line, wrapped: read as one)
    const flat = short.text.replace(/\n\s*(· )?/g, ' ');
    for (const ask of agent.warnings.map(w => w.ask).filter(Boolean))
      assert.ok(flat.includes(`? ${ask}`), `${name}: the question “${ask}”`);
    assert.match(short.text, /^Ready: no refusals, \d+ warnings/, name);
    assert.match(short.text.replace(/\s+/g, ' '), /Add --verbose for each warning in full with its fix/, name);
    assert.ok(short.text.length < long.text.length, name);
    assert.match(long.text, /^What players should know/m, name);
    // the lines the agent is told to pass on are all in the person's verbose text
    const told = [...agent.text.matchAll(/^> (.*)$/gm)].map(m => m[1]);
    assert.ok(told.length, name);
    const flatLong = long.text.replace(/\n\s*(· )?/g, ' ');
    for (const line of told) assert.ok(flatLong.includes(line), `${name}: “${line}”`);
  }
});

/** Runs `xsolana …` in `cwd`: { code, out }. */
const xsolana = (args, cwd) =>
  new Promise(resolve =>
    execFile(
      process.execPath,
      [fileURLToPath(new URL('../../bin/xsolana.mjs', import.meta.url)), ...args],
      { cwd, timeout: 30_000 },
      (error, out) => resolve({ code: error ? error.code : 0, out }),
    ),
  );

test('xsolana check speaks to the developer; --json and xsolana tool keep the agent’s blocks', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-person-'));
  const spec = examples().find(e => e.name === 'community-coin').spec;
  writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(spec));
  const plain = await xsolana(['check'], dir);
  assert.equal(plain.code, 0);
  assert.doesNotMatch(plain.out, /Tell the person|Ask the person|your own words/);
  assert.match(plain.out, /^Questions for you \(settle them before you build on this spec/m);
  const json = JSON.parse((await xsolana(['check', '--json'], dir)).out);
  assert.match(json.text, /^Ask the person\b/m);
  assert.match(json.text, /^Tell the person\b/m);
  assert.match(json.text, /^> /m);
  const tool = await xsolana(['tool', 'xsolana_check', '{"file":"xsolana.json"}'], dir);
  assert.match(tool.out, /^Tell the person\b/m);
});

test('a named command prints a summary and tables that fit a terminal; --verbose adds the words, the agent keeps them', async () => {
  for (const { name } of examples()) {
    for (const tool of ['check', 'simulate', 'cost', 'review', 'explain']) {
      const short = await runTool(`xsolana_${tool}`, { example: name }, { ...person, verbose: false });
      for (const line of short.text.split('\n'))
        assert.ok(line.length <= 120, `xsolana ${tool} on ${name}: ${line.length} columns: ${line}`);
      if (tool === 'check') continue;
      const long = await runTool(`xsolana_${tool}`, { example: name }, person);
      if (tool !== 'explain') assert.match(long.text, /^In full$/m, `xsolana ${tool} --verbose on ${name}`);
      assert.ok(short.text.length < long.text.length, `xsolana ${tool} on ${name}`);
      // the agent's answer is the words alone, as before
      const agent = await runTool(`xsolana_${tool}`, { example: name }, { terminal: TERMINAL_ALL, now: NOW });
      assert.doesNotMatch(agent.text, /^(In full|What a player pays.*|Add --verbose.*)$/m, `${tool} on ${name}`);
      if (tool === 'explain')
        assert.equal(long.text, personWords(terminalWords(agent.text, TERMINAL_ALL)), `explain --verbose on ${name}`);
    }
  }
  const sim = await runTool('xsolana_simulate', { example: 'partner-vault' }, { ...person, verbose: false });
  assert.match(sim.text, /^ {2}Purchase +Price +On top, devnet +On top, mainnet +Mainnet extra +Returns$/m);
  const cost = await runTool('xsolana_cost', { example: 'shelter-fair' }, { ...person, verbose: false });
  assert.match(cost.text, /^A player pays [\d.]+ to [\d.]+ SOL on top of each price on mainnet/m);
});

test('a terminal line is cut only between words: refusals, warnings and tables keep every word whole', async () => {
  const flat = t => ` ${t.replace(/\s+/g, ' ')} `;
  const bad = { ...examples().find(e => e.name === 'shelter-fair').spec };
  bad.items = bad.items.map((it, i) => (i ? it : { ...it, opens: 'yesterday at noon', closes: 'when it opens' }));
  for (const input of [{ spec: bad }, ...examples().map(e => ({ example: e.name }))]) {
    const agent = await runTool('xsolana_check', input, { terminal: TERMINAL_ALL, now: NOW });
    const said = flat((await runTool('xsolana_check', input, person)).text);
    for (const f of [...(agent.refusals ?? []), ...(agent.warnings ?? [])])
      for (const word of personWords(terminalWords(`${f.message} ${f.fix ?? ''}`, TERMINAL_ALL))
        .split(/\s+/)
        .filter(w => w.length > 2))
        assert.ok(said.includes(word), `${JSON.stringify(input).slice(0, 40)}: “${word}” is cut`);
  }
});

test('a default view never cuts inside a sentence or a parenthesis', async () => {
  for (const { name } of examples())
    for (const tool of ['check', 'simulate', 'explain', 'review']) {
      const { text } = await runTool(`xsolana_${tool}`, { example: name }, { ...person, verbose: false });
      for (const line of text.split('\n'))
        assert.doesNotMatch(line, /[\w,;:(]…$/, `xsolana ${tool} on ${name} cuts a sentence: ${line}`);
      // each bullet, its lines together: as many ( as )
      const bullets = text.split(/\n(?=[-!?✗] )/).map(b => b.replace(/\s+/g, ' '));
      for (const b of bullets) {
        const open = (b.match(/\(/g) ?? []).length;
        const close = (b.match(/\)/g) ?? []).length;
        assert.equal(open, close, `xsolana ${tool} on ${name} leaves a parenthesis open: ${b.slice(0, 200)}`);
      }
    }
});

test('check never says a plain "Ready" over a high warning, puts it first, and folds low and unrated ones', async () => {
  const { personCheck } = await import('../mcp/views.mjs');
  const { withCluster } = await import('../mcp/with-cluster.mjs');
  const warnings = [
    {
      code: 'W-FEE',
      where: 'a',
      message: 'Every opening pays the player fee. On mainnet the player fee alone is 0.0005 SOL.',
    },
    { code: 'W-ASSUMPTION', where: 'b', severity: 'low', message: 'Unknown: how many claim it.' },
    { code: 'W-CHANCE-PRIZE', where: 'c', message: 'Players pay for a chance at money.' },
    { code: 'W-VALUE', where: 'd', severity: 'high', message: 'GEM is minted for free with no cap at all.' },
  ];
  const verdict = { ok: true, refusals: [], warnings };
  const text = withCluster('mainnet', () => personCheck(verdict, { refusals: [], warnings }));
  assert.match(
    text,
    /^Ready to go live, with 1 high warning: read it first \(this economy is on mainnet: real money\)\./,
  );
  assert.doesNotMatch(text, /^Ready: /m);
  const lines = text.split('\n').filter(l => l.startsWith('! '));
  assert.match(lines[0], /^! W-VALUE \(high\)/, 'the high warning first');
  assert.match(lines[1], /^! W-CHANCE-PRIZE/, 'then the law’s flag');
  assert.match(lines.at(-1), /^! \+2 more warnings, low or unrated \(W-FEE, W-ASSUMPTION\): --verbose shows them\./);
  const all = withCluster('mainnet', () => personCheck(verdict, { refusals: [], warnings }, { verbose: true }));
  for (const w of warnings) assert.ok(all.includes(w.code), w.code);
  // no high warning: a plain Ready, with the counts
  const calm = personCheck(
    { ok: true, refusals: [], warnings: warnings.slice(0, 3) },
    { refusals: [], warnings: warnings.slice(0, 3) },
  );
  assert.match(calm, /^Ready: no refusals, 3 warnings \(1 low, 2 unrated\)\./);
});

test('warnings about players’ money and who they trust are rated, and shown in the default view, not folded', async () => {
  const { SEVERITY } = await import('../economy/check.mjs');
  for (const code of ['W-ON-TOP', 'W-MINT-POWERS', 'W-AUTHORITY', 'W-VOUCHERS', 'W-STASH-TRANSFER', 'W-GRANT-OPEN'])
    assert.equal(SEVERITY[code], 'medium', code);
  for (const [example, code] of [
    ['partner-vault', 'W-ON-TOP'],
    ['blind-forge', 'W-MINT-POWERS'],
    ['level-ladder', 'W-AUTHORITY'],
  ]) {
    const agent = await runTool('xsolana_check', { example }, { now: NOW });
    assert.equal(agent.warnings.find(w => w.code === code)?.severity, 'medium', `${example}: ${code} in --json`);
    const shown = (await runTool('xsolana_check', { example }, { ...person, verbose: false })).text;
    assert.match(shown, new RegExp(`^! ${code} \\(medium\\)`, 'm'), `${example}: ${code} shown`);
  }
});
