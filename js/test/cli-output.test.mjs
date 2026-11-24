// What the command line and the tools say: a tool's failure on stderr, a flag a command doesn't take refused, the
// usage naming every command and flag, `xsolana connect --remove` telling whether it removed anything, one error for an
// unknown agent, and xsolana_save making a missing folder and reading a wrapped spec as xsolana_check does. Agents are
// stand-in scripts on PATH, and HOME is a scratch folder: nothing touches the real home folder.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  new Promise(resolve =>
    execFile(
      process.execPath,
      [bin, ...args],
      {
        cwd,
        env: { ...process.env, HOME: mkdtempSync(path.join(tmpdir(), 'xsolana-home-')), XSOLANA_NO_OPEN: '1', ...env },
        timeout: 30_000,
      },
      (error, out, err) => resolve({ code: error ? error.code : 0, out, err }),
    ),
  );

/** Stand-in `claude` and `codex` commands: `mcp get` answers `getCode`, `mcp remove` answers `removeCode`, the rest 0. */
function fakeAgents({ getCode, removeCode }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-agents-'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\n[ "$1 $2" = "mcp get" ] && exit ${getCode}\n[ "$1 $2" = "mcp remove" ] && exit ${removeCode}\nexit 0\n`,
    );
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
      [['examples', '--limit', '2', 'coin'], /“examples” takes no --limit flag \(only --save, --json\)/],
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

  test('version says the package’s own version, then the program’s it is built for', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const r = await xsolana(['version']);
    assert.equal(r.code, 0);
    assert.match(
      r.out,
      new RegExp(`^@xgamesfun/solana ${pkg.version.replaceAll('.', '\\.')} · loot \\d+\\.\\d+\\.\\d+ · program `),
    );
  });

  test('the usage names version, --json and connect --local', async () => {
    const r = await xsolana(['help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /xsolana version/);
    assert.match(r.out, /--json/);
    assert.match(r.out, /--local/);
  });
});

/** Every command the CLI takes. */
const COMMANDS = [
  'mcp',
  'guide',
  'examples',
  'check',
  'simulate',
  'cost',
  'explain',
  'review',
  'publish',
  'status',
  'client',
  'token',
  'keygen',
  'approve',
  'connect',
  'tool',
  'version',
];

describe('xsolana (help, and words a command does not take)', () => {
  test('every command answers --help, -h and `xsolana help <command>` with its own usage, and exits 0', async () => {
    for (const command of COMMANDS) {
      // (`xsolana tool <name> --help` is that tool's help: tested below)
      const asked = [
        [command, '--help'],
        [command, '-h'],
        ['help', command],
      ];
      if (command !== 'tool') asked.push([command, 'extra-word', '--help']);
      const answers = await Promise.all(asked.map(args => xsolana(args)));
      for (const [i, r] of answers.entries()) {
        assert.equal(r.code, 0, `${asked[i].join(' ')}: ${r.err}`);
        assert.equal(r.err, '', asked[i].join(' '));
        assert.match(r.out, new RegExp(`^Usage: xsolana ${command}\\b`), asked[i].join(' '));
        assert.equal(r.out, answers[0].out, `${asked[i].join(' ')} says what ${command} --help says`);
      }
    }
    // A flag a command takes is in its help.
    for (const [command, flag] of [
      ['approve', '--no-open'],
      ['connect', '--local'],
      ['examples', '--save'],
      ['check', '--json'],
      ['tool', '--args-file'],
    ])
      assert.match((await xsolana([command, '--help'])).out, new RegExp(`${flag}\\b`), `${command} ${flag}`);
    const unknown = await xsolana(['help', 'bogus']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /There is no command “bogus”: xsolana help lists them all\./);
  });

  test('a tool’s help names its arguments and the command that runs it', async () => {
    const r = await xsolana(['tool', 'xsolana_guide', '--help']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^xsolana tool xsolana_guide '<json>' {3}.* \(also: xsolana guide\)\n/);
    assert.match(r.out, /\n {2}part \(string\)/);
    const none = await xsolana(['tool', 'xsolana_nope', '--help']);
    assert.equal(none.code, 1);
    assert.match(none.err, /There is no tool “xsolana_nope”/);
  });

  test('the usage names every command, design and save among the tools, in lines a terminal holds', async () => {
    const { out } = await xsolana(['help']);
    for (const command of [...COMMANDS, 'help'])
      assert.match(out, new RegExp(`^ {2}xsolana ${command}\\b`, 'm'), command);
    assert.match(out, /xsolana_design/);
    assert.match(out, /xsolana_save/);
    for (const line of out.split('\n')) assert.ok(line.length <= 120, `${line.length} columns: ${line}`);
  });

  test('a word more than a command takes, and a short flag, are refused in one line, never dropped', async () => {
    for (const [args, said] of [
      [['check', 'a.json', 'b.json'], /^xsolana check takes one file: “b\.json” is more than that\.$/],
      [['guide', 'boxes', 'lotteries'], /^xsolana guide takes one part or topic: “lotteries” is more than that\.$/],
      [['version', 'extra'], /^xsolana version takes nothing after its name: “extra” is more than that\.$/],
      [['tool', 'xsolana_check', '{}', '{}'], /“\{\}” is more than that/],
      [['check', '-v'], /^xsolana: There is no -v flag: flags are written whole \(--json\), and -h is --help\.$/],
    ]) {
      const r = await xsolana(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err.trim(), said, args.join(' '));
      assert.equal(r.err.trim().split('\n').length, 1, `${args.join(' ')}: one line`);
      assert.equal(r.out, '');
    }
  });

  test('tool --list gives each tool’s title and its command, and --json gives them as JSON', async () => {
    const text = await xsolana(['tool', '--list']);
    assert.match(text.out, /^xsolana_check\n {2}Check an economy spec \(xsolana check\)$/m);
    assert.doesNotMatch(text.out, /\.\.$/m);
    const json = JSON.parse((await xsolana(['tool', '--list', '--json'])).out);
    assert.deepEqual(
      json.find(t => t.name === 'xsolana_check'),
      {
        name: 'xsolana_check',
        title: 'Check an economy spec',
        command: 'xsolana check',
      },
    );
    assert.ok(!('command' in json.find(t => t.name === 'xsolana_design')));
  });
});

describe('xsolana (a terminal is spoken to as a terminal)', () => {
  test('a tool’s words name the command that runs it, where the MCP server names the tool', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-words-'));
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ ...spec, boxes: [{ ...spec.boxes[0], colour: 'red' }] }),
    );
    const cli = await xsolana(['check', 'bad.json'], { cwd: dir });
    assert.equal(cli.code, 1);
    assert.match(cli.err, /xsolana guide boxes gives every field of it/);
    assert.doesNotMatch(cli.err, /xsolana_[a-z]/);
    // The same tool over MCP keeps the tool's name, with its arguments.
    const mcp = await runTool('xsolana_check', { file: 'bad.json' }, { cwd: dir, now: NOW });
    assert.match(mcp.text, /xsolana_guide \{"part": "boxes"\} gives every field of it/);
  });

  test('in a folder with no spec, and for a guide part that is not one, the words are the terminal’s', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-words-'));
    const none = await xsolana(['check'], { cwd: dir });
    assert.equal(none.code, 1);
    assert.match(none.err, /There is no xsolana\.json in .* yet\. Write one \(xsolana guide says what it holds/);
    assert.doesNotMatch(none.err, /xsolana_|"spec"/);
    const part = await xsolana(['guide', 'nonsense']);
    assert.equal(part.code, 1);
    assert.match(part.err, /^xsolana guide: there is no part or topic “nonsense”\. It takes one of: tokens, /);
    assert.doesNotMatch(part.err, /arguments\.part/);
    const index = await xsolana(['guide']);
    assert.match(index.out, /Fetch what you need: xsolana guide <name> gives a part’s fields/);
    assert.doesNotMatch(index.out, /\(terminal: /);
  });

  test('a worked example by name prints its spec, and --save starts a new file from it, never over one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-start-'));
    const shown = await xsolana(['examples', 'coin-flip-arena'], { cwd: dir });
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /To start a file from it: xsolana examples coin-flip-arena --save xsolana\.json\n/);
    const json = shown.out.slice(shown.out.indexOf('\n{'), shown.out.lastIndexOf('\n}') + 2);
    assert.deepEqual(JSON.parse(json), spec);
    // Over MCP the spec is in the answer's data, not repeated in its words.
    const mcp = await runTool('xsolana_examples', { name: 'coin-flip-arena' });
    assert.deepEqual(mcp.spec, spec);
    assert.doesNotMatch(mcp.text, /--save|"version": 2/);

    const saved = await xsolana(['examples', 'coin-flip-arena', '--save', 'xsolana.json'], { cwd: dir });
    assert.equal(saved.code, 0, saved.err);
    assert.match(
      saved.out,
      /^xsolana\.json now holds the worked example “coin-flip-arena”, whole\..* xsolana check\n$/,
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'xsolana.json'), 'utf8')), spec);
    writeFileSync(path.join(dir, 'xsolana.json'), '{"mine": true}');
    const again = await xsolana(['examples', 'blind-forge', '--save', 'xsolana.json'], { cwd: dir });
    assert.equal(again.code, 1);
    assert.match(again.err, /xsolana\.json is there already, and --save writes only a new file/);
    assert.equal(readFileSync(path.join(dir, 'xsolana.json'), 'utf8'), '{"mine": true}');
    const nameless = await xsolana(['examples', 'loot', 'boxes', '--save', 'x.json'], { cwd: dir });
    assert.equal(nameless.code, 1);
    assert.match(nameless.err, /--save goes with one example’s name/);
    assert.ok(!existsSync(path.join(dir, 'x.json')));
  });

  test('the README’s terminal quick start runs from an empty folder to a spec that checks', async () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const block = readme.slice(readme.indexOf('### From a terminal')).match(/```bash\n([\s\S]*?)```/)[1];
    const steps = [...block.matchAll(/^npx -y @xgamesfun\/solana@\S+ (.+)$/gm)].map(m => m[1].split(' '));
    // (a coin's mint is read from the chain, and going live needs a key: the rest runs here)
    const offline = steps.filter(([command]) => !['token', 'keygen', 'approve'].includes(command));
    assert.deepEqual(
      offline.map(([command]) => command),
      ['examples', 'examples', 'check', 'simulate', 'cost', 'explain', 'review'],
    );
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-readme-'));
    for (const args of offline) {
      const r = await xsolana(args, { cwd: dir });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    }
    assert.ok(existsSync(path.join(dir, 'xsolana.json')), 'a step makes xsolana.json');
    assert.match((await xsolana(['check', 'xsolana.json'], { cwd: dir })).out, /^Ready\b/m);
  });
});

describe('xsolana (failures said for what they are)', () => {
  test('the folder itself, a folder, a file it may not read and one in UTF-16 are each said as such', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-fail-'));
    mkdirSync(path.join(dir, 'dir.json'));
    writeFileSync(path.join(dir, 'utf16.json'), Buffer.from(`\ufeff${JSON.stringify(spec)}`, 'utf16le'));
    const cases = [
      [['check', '.'], /^\. is the project folder itself \(.*\): name a spec file in it\.$/],
      [['check', 'dir.json'], /^dir\.json is a folder, not a spec file\.$/],
      [
        ['check', 'utf16.json'],
        /^utf16\.json is not UTF-8 text \(it reads as UTF-16\): save it as UTF-8, then try again\.$/,
      ],
    ];
    // (root reads any file whatever its mode)
    if (posix && process.getuid?.() !== 0) {
      writeFileSync(path.join(dir, 'locked.json'), JSON.stringify(spec));
      chmodSync(path.join(dir, 'locked.json'), 0o000);
      cases.push([
        ['check', 'locked.json'],
        /^locked\.json can’t be read \(EACCES\): check that it is a file this user may read\.$/,
      ]);
    }
    for (const [args, said] of cases) {
      const r = await xsolana(args, { cwd: dir });
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err.trim(), said, args.join(' '));
    }
  });

  test('a spec file that starts with a byte-order mark is read as the JSON it is', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-bom-'));
    writeFileSync(path.join(dir, 'xsolana.json'), `\ufeff${JSON.stringify(spec)}`);
    const r = await runTool('xsolana_check', {}, { cwd: dir, now: NOW });
    assert.equal(r.ok, true, r.text);
  });

  test('JSON nested thousands deep is said to be, on the command line and over MCP', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-deep-'));
    const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    writeFileSync(path.join(dir, 'deep.json'), deep);
    const cli = await xsolana(['check', 'deep.json'], { cwd: dir });
    assert.equal(cli.code, 1);
    assert.match(cli.err, /^What was given is nested too deeply to read: an economy is a few levels/);
    let nested = {};
    for (let i = 0; i < 5_000; i++) nested = { a: nested };
    const mcp = await runTool('xsolana_check', { spec: { ...spec, boxes: [nested] } }, { now: NOW });
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /nested too deeply/);
    assert.doesNotMatch(mcp.text, /call stack/);
  });

  test('a call that names no tool, and a message that names no method, are said so', async () => {
    const { handle } = await import('../mcp/server.mjs');
    for (const name of [undefined, '', 42]) {
      const r = await runTool(name, {});
      assert.equal(r.isError, true);
      assert.match(r.text, /^The call names no tool: give the tool’s name as "name"\. Tools: xsolana_guide, /);
    }
    const reply = await handle({ jsonrpc: '2.0', id: 7 });
    assert.deepEqual(reply.error, { code: -32600, message: 'Not a request: it names no method.' });
    assert.equal(reply.id, 7);
    assert.equal((await handle(42)).error.code, -32600);
    assert.equal(await handle({ jsonrpc: '2.0', id: 8, result: {} }), null, 'a reply is let go');
  });

  test('a finding repeated for thousands of parts is listed ten times, and the rest are counted', async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ key: `idle-${i}`, name: `Idle ${i}` }));
    const r = await runTool(
      'xsolana_check',
      { spec: { ...spec, items: [...(spec.items ?? []), ...items] } },
      { now: NOW },
    );
    assert.ok(!r.isError, r.text);
    const unreached = r.warnings.filter(w => w.code === 'W-ITEM');
    assert.equal(unreached.length, 11);
    assert.equal(unreached.at(-1).more, 290);
    assert.match(unreached.at(-1).message, /^290 more like the 10 W-ITEM above, each for another part of the spec/);
    assert.equal(r.text.match(/! W-ITEM/g).length, 11);
    assert.ok(r.text.length < 20_000, `${r.text.length} characters`);
  });
});

describe('xsolana connect (what it says)', { skip: !posix && 'stand-in agents are shell scripts' }, () => {
  test('--remove of a server registered at another scope says it was not found there, and exits 1', async () => {
    const r = await xsolana(['connect', '--agent', 'claude', '--remove'], {
      env: fakeAgents({ getCode: 0, removeCode: 1 }),
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /Claude Code: xsolana’s server was not found at the user scope/);
    assert.doesNotMatch(r.out, /xsolana removed/);
  });

  test('--remove says what it removed, and that nothing was registered when nothing was', async () => {
    const removed = await xsolana(['connect', '--agent', 'claude', '--remove'], {
      env: fakeAgents({ getCode: 0, removeCode: 0 }),
    });
    assert.equal(removed.code, 0, removed.out + removed.err);
    assert.match(removed.out, /Claude Code: xsolana removed\./);
    const none = await xsolana(['connect', '--agent', 'claude', '--remove'], {
      env: fakeAgents({ getCode: 1, removeCode: 0 }),
    });
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

  test('a game file’s spec that says mainnet is worked on mainnet, by a command and by `xsolana tool` alike', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-game-'));
    const game = { name: 'game', runtime: 'web', economy: { ...spec, network: 'mainnet' } };
    writeFileSync(path.join(dir, 'game.json'), JSON.stringify(game));
    for (const args of [
      ['check', 'game.json'],
      ['tool', 'xsolana_check', '{"file":"game.json"}'],
      ['tool', 'xsolana_check', JSON.stringify({ spec: game })],
    ]) {
      const r = await xsolana(args, { cwd: dir });
      assert.equal(r.code, 0, `${args.slice(0, 2).join(' ')}: ${r.err}`);
      assert.match(r.out, /· mainnet\n$/, args.slice(0, 2).join(' '));
    }
  });

  test('a worked example is checked on its own cluster, whatever the folder’s xsolana.json says', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-game-'));
    writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify({ ...spec, network: 'mainnet' }));
    const r = await runTool('xsolana_check', { example: 'coin-flip-arena' }, { cwd: dir, now: NOW });
    assert.equal(r.ok, true, r.text);
  });

  test(
    'XSOLANA_CLUSTER naming another cluster than the economy’s is refused by every tool command alike',
    // (a run of the whole suite on mainnet's address reads every economy as mainnet's: there is no clash to make)
    { skip: process.env.XSOLANA_CLUSTER ? 'the suite runs on one cluster' : false },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-clash-'));
      writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify({ ...spec, network: 'mainnet' }));
      for (const args of [
        ['check'],
        ['cost', 'xsolana.json'],
        ['tool', 'xsolana_check', '{}'],
        ['tool', 'xsolana_check', '{"file":"xsolana.json"}'],
      ]) {
        const r = await xsolana(args, { cwd: dir, env: { XSOLANA_CLUSTER: 'devnet' } });
        assert.equal(r.code, 1, args.join(' '));
        assert.match(r.err, /^xsolana: xsolana\.json is on mainnet, and XSOLANA_CLUSTER says devnet/, args.join(' '));
        assert.equal(r.out, '');
      }
    },
  );
});
