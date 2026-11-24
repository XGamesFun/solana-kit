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
import { AGENT_ONLY } from '../mcp/person.mjs';
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
    const flat = short.text.replace(/\n {2}/g, ' ');
    for (const ask of agent.warnings.map(w => w.ask).filter(Boolean))
      assert.ok(flat.includes(`? ${ask}`), `${name}: the question “${ask}”`);
    assert.match(short.text, /^Ready: no refusals, \d+ warnings/, name);
    assert.match(short.text.replace(/\s+/g, ' '), /Add --verbose for each warning in full with its fix/, name);
    assert.ok(short.text.length < long.text.length, name);
    assert.match(long.text, /^What players should know/m, name);
    // the lines the agent is told to pass on are all in the person's verbose text
    const told = [...agent.text.matchAll(/^> (.*)$/gm)].map(m => m[1]);
    assert.ok(told.length, name);
    const flatLong = long.text.replace(/\n {2}/g, ' ');
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
    for (const tool of ['check', 'simulate', 'cost', 'review']) {
      const short = await runTool(`xsolana_${tool}`, { example: name }, { ...person, verbose: false });
      for (const line of short.text.split('\n'))
        assert.ok(line.length <= 120, `xsolana ${tool} on ${name}: ${line.length} columns: ${line}`);
      if (tool === 'check') continue;
      const long = await runTool(`xsolana_${tool}`, { example: name }, person);
      assert.match(long.text, /^In full$/m, `xsolana ${tool} --verbose on ${name}`);
      assert.ok(short.text.length < long.text.length, `xsolana ${tool} on ${name}`);
      // the agent's answer is the words alone, as before
      const agent = await runTool(`xsolana_${tool}`, { example: name }, { terminal: TERMINAL_ALL, now: NOW });
      assert.doesNotMatch(agent.text, /^(In full|What a player pays.*|Add --verbose.*)$/m, `${tool} on ${name}`);
    }
  }
  const sim = await runTool('xsolana_simulate', { example: 'partner-vault' }, { ...person, verbose: false });
  assert.match(sim.text, /^ {2}Purchase +Price +On top, devnet +On top, mainnet +Mainnet extra +Returns$/m);
  const cost = await runTool('xsolana_cost', { example: 'shelter-fair' }, { ...person, verbose: false });
  assert.match(cost.text, /^A player pays [\d.]+ to [\d.]+ SOL on top of each price on mainnet/m);
});
