// What the command line and the tools say: a tool's failure on stderr, a flag a command doesn't take refused, the
// usage naming every command and flag, `xsolana connect --remove` telling whether it removed anything, one error for an
// unknown agent, and xsolana_save making a missing folder and reading a wrapped spec as xsolana_check does. Agents are
// stand-in scripts on PATH, and HOME is a scratch folder: nothing touches the real home folder.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTool } from '../mcp/server.mjs';

const bin = fileURLToPath(new URL('../../bin/xsolana.mjs', import.meta.url));
const posix = process.platform !== 'win32';
const NOW = 1_000_000_000;
const spec = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));

/** Runs `xsolana …` in `cwd` with a scratch HOME: { code, out, err }. */
const xsolana = (args, { cwd = tmpdir(), env = {} } = {}) =>
  new Promise((resolve) => execFile(process.execPath, [bin, ...args], { cwd, env: { ...process.env, HOME: mkdtempSync(path.join(tmpdir(), 'xsolana-home-')), XSOLANA_NO_OPEN: '1', ...env }, timeout: 30_000 }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err })));

/** Stand-in `claude` and `codex` commands: `mcp get` answers `getCode`, `mcp remove` answers `removeCode`, the rest 0. */
function fakeAgents({ getCode, removeCode }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-agents-'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n[ "$1 $2" = "mcp get" ] && exit ${getCode}\n[ "$1 $2" = "mcp remove" ] && exit ${removeCode}\nexit 0\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
  return { PATH: `${dir}${path.delimiter}${process.env.PATH}` };
}

describe('xsolana (what the command line says)', () => {
  test('a tool that refuses prints its answer on stderr and exits 1; --json keeps it on stdout', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-cli-'));
    const text = await xsolana(['check', 'missing.json'], { cwd: dir });
    assert.equal(text.code, 1);
    assert.equal(text.out, '');
    assert.match(text.err, /missing\.json/);
    const json = await xsolana(['check', 'missing.json', '--json'], { cwd: dir });
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.out).isError, true);
  });

  test('a flag the command doesn’t take is refused in one line, never read as words', async () => {
    for (const [args, said] of [
      [['examples', '--limit', '2', 'coin'], /“examples” takes no --limit flag \(only --json\)/],
      [['version', '--json'], /“version” takes no --json flag \(it takes none\)/],
      [['approve', '--dry-run'], /“approve” takes no --dry-run flag/],
    ]) {
      const r = await xsolana(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, said, args.join(' '));
      assert.equal(r.err.trim().split('\n').length, 1, `${args.join(' ')}: one line`);
      assert.equal(r.out, '');
    }
  });

  test('the usage names version, --json and connect --local', async () => {
    const r = await xsolana(['help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /xsolana version/);
    assert.match(r.out, /--json/);
    assert.match(r.out, /--local/);
  });
});

describe('xsolana connect (what it says)', { skip: !posix && 'stand-in agents are shell scripts' }, () => {
  test('--remove of a server registered at another scope says it was not found there, and exits 1', async () => {
    const r = await xsolana(['connect', '--agent', 'claude', '--remove'], { env: fakeAgents({ getCode: 0, removeCode: 1 }) });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /Claude Code: xsolana’s server was not found at the user scope/);
    assert.doesNotMatch(r.out, /xsolana removed/);
  });

  test('--remove says what it removed, and that nothing was registered when nothing was', async () => {
    const removed = await xsolana(['connect', '--agent', 'claude', '--remove'], { env: fakeAgents({ getCode: 0, removeCode: 0 }) });
    assert.equal(removed.code, 0, removed.out + removed.err);
    assert.match(removed.out, /Claude Code: xsolana removed\./);
    const none = await xsolana(['connect', '--agent', 'claude', '--remove'], { env: fakeAgents({ getCode: 1, removeCode: 0 }) });
    assert.equal(none.code, 0, none.out + none.err);
    assert.match(none.out, /Claude Code: xsolana’s server was not registered\./);
  });

  test('an unknown agent is one error', async () => {
    const r = await xsolana(['connect', '--agent', 'foo'], { env: fakeAgents({ getCode: 1, removeCode: 0 }) });
    assert.equal(r.code, 1);
    assert.equal(r.out.trim(), 'No agent called “foo” (claude, codex).');
  });
});

describe('xsolana_save (what it says)', () => {
  test('a folder that isn’t there yet is made inside the project folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-save-'));
    const r = await runTool('xsolana_save', { spec, file: 'economy/new/xsolana.json' }, { cwd: dir, now: NOW });
    assert.equal(r.ok, true, r.text);
    assert.ok(existsSync(path.join(dir, 'economy', 'new', 'xsolana.json')));
    // still nothing outside it
    const out = await runTool('xsolana_save', { spec, file: '../elsewhere/xsolana.json' }, { cwd: dir, now: NOW });
    assert.equal(out.ok, false);
    assert.match(out.text, /^Not saved: .*outside the project folder/);
  });

  test('a folder that can’t be made is refused in one line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-save-'));
    writeFileSync(path.join(dir, 'taken'), 'a file, not a folder');
    const r = await runTool('xsolana_save', { spec, file: 'taken/xsolana.json' }, { cwd: dir, now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.text, /^Not saved: the folder for taken\/xsolana\.json can’t be made/);
    assert.doesNotMatch(r.text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'without the absolute path');
  });

  test('a spec wrapped under `economy` is saved, as xsolana_check reads it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-save-'));
    assert.equal((await runTool('xsolana_check', { spec: { economy: spec } }, { cwd: dir, now: NOW })).ok, true);
    const r = await runTool('xsolana_save', { spec: { economy: spec }, file: 'w.json' }, { cwd: dir, now: NOW });
    assert.equal(r.ok, true, r.text);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'w.json'), 'utf8')).version, 2);
  });

  test('a game file that keeps the spec under `economy`, beside its own keys, is read as the spec', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-game-'));
    writeFileSync(path.join(dir, 'game.json'), JSON.stringify({ name: 'game', runtime: 'web', economy: spec }));
    const r = await runTool('xsolana_check', { file: 'game.json' }, { cwd: dir, now: NOW });
    assert.equal(r.ok, true, r.text);
  });
});
