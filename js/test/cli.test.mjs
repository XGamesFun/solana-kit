// The command line (bin/xsolana.mjs) and `xsolana connect`: flags in both forms, failures said in one line with exit 1, and
// connect's scopes and skill folder (it never replaces a folder that is not xsolana's own skill).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connect, runAgent, serverCommand, skillFolder } from '../connect/connect.mjs';

const bin = fileURLToPath(new URL('../../bin/xsolana.mjs', import.meta.url));
const posix = process.platform !== 'win32';

/** Runs `xsolana …` in `cwd`: { code, out, err }. */
const xsolana = (args, { cwd = tmpdir(), env = {} } = {}) =>
  new Promise((resolve) => execFile(process.execPath, [bin, ...args], { cwd, env: { ...process.env, XSOLANA_NO_OPEN: '1', ...env }, timeout: 30_000 }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err })));

/** A folder of stand-in `claude` and `codex` commands that write each call into `log` and succeed. */
function fakeAgents() {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-agents-'));
  const log = path.join(dir, 'calls.log');
  for (const name of ['claude', 'codex']) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n[ "$1 $2" = "mcp get" ] && exit 1\nexit 0\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

describe('xsolana (the command line)', () => {
  test('a failure is one line on stderr and exit 1, never a stack', async () => {
    const cases = [
      [['tool', 'xsolana_check', 'notjson'], /not JSON/],
      [['approve', 'missing.json', '--no-open'], /missing\.json does not exist/],
      [['approve', 'xsolana.json', '--port', 'abc'], /--port must be a whole number/],
      [['approve', 'xsolana.json', '--port=99999'], /--port must be a whole number/],
      [['connect', '--agent'], /--agent needs a value/],
    ];
    for (const [args, said] of cases) {
      const r = await xsolana(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, said, args.join(' '));
      assert.doesNotMatch(r.err, /\n\s+at /, `${args.join(' ')}: no stack`);
      assert.equal(r.err.trim().split('\n').length, 1, `${args.join(' ')}: one line`);
    }
  });

  test('an unknown command prints the usage and exits 1; help exits 0', async () => {
    const bad = await xsolana(['bogus']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /no command “bogus”/);
    assert.match(bad.err, /xsolana check \[file\]/);
    const help = await xsolana(['help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /xsolana check \[file\]/);
  });

  test('a tool runs from the terminal with its arguments given inline or as --args-file=', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-cli-'));
    writeFileSync(path.join(dir, 'args.json'), JSON.stringify({ part: 'boxes' }));
    const inline = await xsolana(['tool', 'xsolana_guide', '{"part":"boxes"}'], { cwd: dir });
    const fromFile = await xsolana(['tool', 'xsolana_guide', '--args-file=args.json'], { cwd: dir });
    assert.equal(inline.code, 0, inline.err);
    assert.equal(fromFile.code, 0, fromFile.err);
    assert.equal(fromFile.out, inline.out);
  });

  test('--agent=claude connects Claude Code only, as --agent claude does', { skip: !posix && 'stand-in agents are shell scripts' }, async () => {
    for (const form of [['--agent=claude'], ['--agent', 'claude']]) {
      const agents = fakeAgents();
      const home = mkdtempSync(path.join(tmpdir(), 'xsolana-home-'));
      const r = await xsolana(['connect', ...form, '--dry-run'], { env: { PATH: `${agents.dir}${path.delimiter}${process.env.PATH}`, HOME: home } });
      assert.equal(r.code, 0, r.err + r.out);
      const calls = agents.calls();
      assert.ok(calls.length && calls.every((c) => c.startsWith('claude ')), `${form.join(' ')}: ${calls.join(' | ')}`);
      assert.match(r.out, /claude mcp add --transport stdio --scope user xsolana/);
      assert.ok(!existsSync(path.join(home, '.claude')), 'a dry run writes nothing');
    }
  });
});

describe('xsolana connect', () => {
  /** Stand-in agents for connect's `run`: every call recorded, `mcp get` finds nothing. */
  const recorder = () => {
    const calls = [];
    return { calls, run: async (bin, args) => (calls.push([bin, ...args].join(' ')), { code: args[1] === 'get' ? 1 : 0, out: '' }) };
  };

  test('an unknown scope is refused before anything runs', async () => {
    const { calls, run } = recorder();
    const said = [];
    assert.equal(await connect({ scope: 'everywhere', run, log: (l) => said.push(l) }), 1);
    assert.deepEqual(calls, []);
    assert.match(said.join('\n'), /No scope called “everywhere” \(user, project\)/);
  });

  test('--scope project registers the server for the project and copies the skill into it', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'xsolana-project-'));
    const { calls, run } = recorder();
    const said = [];
    assert.equal(await connect({ agent: 'claude', scope: 'project', cwd, run, log: (l) => said.push(l) }), 0, said.join('\n'));
    assert.ok(calls.some((c) => c.startsWith('claude mcp add --transport stdio --scope project xsolana')), calls.join('\n'));
    assert.equal(await skillFolder(path.join(cwd, '.claude', 'skills', 'xsolana-economy')), 'ours');
    // and --remove takes it out of the same project, not the user's folder
    assert.equal(await connect({ agent: 'claude', scope: 'project', cwd, remove: true, run, log: () => {} }), 0);
    assert.equal(await skillFolder(path.join(cwd, '.claude', 'skills', 'xsolana-economy')), 'none');
  });

  test('Codex has no project scope: it is left as it is, and says so', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'xsolana-project-'));
    const { calls, run } = recorder();
    const said = [];
    assert.equal(await connect({ agent: 'codex', scope: 'project', cwd, run, log: (l) => said.push(l) }), 1);
    assert.ok(!calls.some((c) => c.includes('mcp add')));
    assert.match(said.join('\n'), /only for the whole user/);
    assert.equal(await skillFolder(path.join(cwd, '.agents', 'skills', 'xsolana-economy')), 'none');
  });

  test('a skill folder that is not xsolana’s own is never replaced or removed', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'xsolana-project-'));
    const mine = path.join(cwd, '.claude', 'skills', 'xsolana-economy');
    mkdirSync(mine, { recursive: true });
    writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: my-own-skill\n---\nmine\n');
    for (const remove of [false, true]) {
      const said = [];
      assert.equal(await connect({ agent: 'claude', scope: 'project', cwd, remove, run: recorder().run, log: (l) => said.push(l) }), 1);
      assert.match(said.join('\n'), /is not xsolana's xsolana-economy skill/);
      assert.equal(readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), '---\nname: my-own-skill\n---\nmine\n');
    }
    // the dry run says the same, and what it would do with xsolana's own
    const said = [];
    await connect({ agent: 'claude', scope: 'project', cwd, dryRun: true, run: recorder().run, log: (l) => said.push(l) });
    assert.match(said.join('\n'), /not xsolana's xsolana-economy skill/);
  });

  test('xsolana’s own skill is replaced, and the dry run says so', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'xsolana-project-'));
    const skill = path.join(cwd, '.claude', 'skills', 'xsolana-economy');
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: xsolana-economy\ndescription: an older copy\n---\nold\n');
    writeFileSync(path.join(skill, 'stale.md'), 'gone after');
    const said = [];
    await connect({ agent: 'claude', scope: 'project', cwd, dryRun: true, run: recorder().run, log: (l) => said.push(l) });
    assert.match(said.join('\n'), /replace the xsolana skill at/);
    assert.ok(existsSync(path.join(skill, 'stale.md')), 'a dry run changes nothing');
    assert.equal(await connect({ agent: 'claude', scope: 'project', cwd, run: recorder().run, log: () => {} }), 0);
    assert.ok(!existsSync(path.join(skill, 'stale.md')));
    assert.doesNotMatch(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /an older copy/);
  });

  test('on Windows an agent runs through cmd.exe (its .cmd shim), each word quoted as it needs', async () => {
    let line = null;
    const r = await runAgent('claude', ['mcp', 'add', '--', 'C:\\Program Files\\nodejs\\node.exe', 'a"b'], {
      platform: 'win32',
      execImpl: (command, options, done) => {
        line = command;
        done(null, 'ok', '');
      },
      execFileImpl: () => assert.fail('execFile cannot start a .cmd shim'),
    });
    assert.equal(r.code, 0);
    assert.equal(line, 'claude mcp add -- "C:\\Program Files\\nodejs\\node.exe" "a""b"');
    const npx = await serverCommand({ platform: 'win32' });
    assert.equal(npx.command, 'cmd');
    assert.deepEqual(npx.args.slice(0, 2), ['/c', 'npx']);
  });
});
