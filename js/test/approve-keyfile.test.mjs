// `xsolana keygen` and `xsolana approve --keypair`: a key file made on this machine, and going live signed by it with
// no browser, against the real program in LiteSVM.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freshKeypair, verifySignature } from '../approve/ed25519.mjs';
import { transferLamports } from '../chain/programs.js';
import { compileMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { KeyFileError, keyFilePath, makeKeyFile, readKeyFile } from '../approve/keyfile.mjs';
import { approvalCode, approveWithKey, NOTICE } from '../approve/with-key.mjs';
import { createApproval } from '../approve/server.mjs';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const example = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
const folder = () => mkdtempSync(path.join(tmpdir(), 'xsolana-key-'));
const posix = process.platform !== 'win32';
/**
 * git, as `execFile` runs it: `yes` answers that it ignores the path, otherwise that it does not; either way the
 * folder is a repository.
 */
const git = yes => (_cmd, args, _options, done) =>
  done(args.includes('check-ignore') && !yes ? Object.assign(new Error('exit 1'), { code: 1 }) : null, '', '');
/** A folder for a test's own files. Where the temp folder is itself inside a repository, tests that run git skip. */
const hasGit = !spawnSync('git', ['--version']).error;

describe('a key file', () => {
  test('keygen writes a new key for its user alone, and hands back its address, never the key', async () => {
    const dir = folder();
    const file = path.join(dir, 'keys', 'game.json');
    const made = await makeKeyFile(file);
    assert.deepEqual(Object.keys(made).sort(), ['address', 'file']);
    assert.equal(made.file, file);
    const bytes = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(bytes.length, 64);
    assert.ok(bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255));
    if (posix) {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'the file: its user alone');
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700, 'the folder it made: its user alone');
    }
    const key = await readKeyFile(file);
    assert.equal(key.address, made.address);
    assert.deepEqual(Object.keys(key).sort(), ['address', 'drop', 'file', 'sign', 'signTransaction']);
    const message = new TextEncoder().encode('a message');
    assert.ok(verifySignature(made.address, message, key.sign(message)), 'it signs as its address');
    // As a wallet: its own signature in its own slot of a transaction, and no other transaction.
    const other = freshKeypair().address;
    const wire = wireTransaction(
      compileMessage({
        payer: made.address,
        blockhash: other,
        instructions: [transferLamports(made.address, other, 1n)],
      }),
    );
    const signed = readTransaction(await key.signTransaction(wire));
    assert.ok(verifySignature(made.address, signed.message, signed.signatures[0]));
    const notMine = wireTransaction(
      compileMessage({ payer: other, blockhash: other, instructions: [transferLamports(other, made.address, 1n)] }),
    );
    await assert.rejects(key.signTransaction(notMine), /is not one .* signs/);
    key.drop();
    assert.throws(() => key.sign(message), /dropped/);
    // (two keys are never the same)
    assert.notEqual((await makeKeyFile(path.join(dir, 'other.json'))).address, made.address);
  });

  test('a key already there is never written over', async () => {
    const dir = folder();
    const file = path.join(dir, 'game.json');
    const made = await makeKeyFile(file);
    const before = readFileSync(file, 'utf8');
    await assert.rejects(makeKeyFile(file), e => {
      assert.ok(e instanceof KeyFileError);
      assert.match(e.message, /already there/);
      assert.ok(e.message.includes(made.address), 'it says whose key is there');
      return true;
    });
    assert.equal(readFileSync(file, 'utf8'), before);
    const notes = path.join(dir, 'notes.json');
    writeFileSync(notes, '{"mine":true}');
    await assert.rejects(makeKeyFile(notes), /already there, and nothing is ever written over/);
    assert.equal(readFileSync(notes, 'utf8'), '{"mine":true}');
  });

  test('a key file inside a git repository is refused, to make and to read, unless git ignores it', async () => {
    const repo = folder();
    mkdirSync(path.join(repo, '.git'));
    const inside = path.join(repo, 'secrets', 'deep', 'owner.json');
    await assert.rejects(makeKeyFile(inside, { run: git(false) }), e => {
      assert.ok(e instanceof KeyFileError);
      assert.match(e.message, /inside the git repository/);
      return true;
    });
    assert.equal(existsSync(path.join(repo, 'secrets')), false, 'nothing is left behind in the repository');
    // (no git to ask: refused all the same)
    await assert.rejects(
      makeKeyFile(inside, {
        run: () => {
          throw new Error('spawn git ENOENT');
        },
      }),
      /inside the git repository/,
    );
    // Ignored there (a home folder kept in git, with everything ignored): made, and read.
    const made = await makeKeyFile(inside, { run: git(true) });
    assert.equal((await readKeyFile(inside, { run: git(true) })).address, made.address);
    await assert.rejects(readKeyFile(inside, { run: git(false) }), /inside the git repository/);
    // A link from outside to a key inside a repository is the key inside the repository.
    const outside = folder();
    symlinkSync(inside, path.join(outside, 'link.json'));
    await assert.rejects(
      readKeyFile(path.join(outside, 'link.json'), { run: git(false) }),
      /inside the git repository/,
    );
  });

  test(
    'git itself decides what is ignored, and what is a repository',
    { skip: hasGit ? false : 'no git' },
    async () => {
      const repo = folder();
      execFileSync('git', ['init', '-q', repo]);
      await assert.rejects(makeKeyFile(path.join(repo, 'keys', 'owner.json')), /inside the git repository/);
      writeFileSync(path.join(repo, '.gitignore'), 'keys/\n');
      const made = await makeKeyFile(path.join(repo, 'keys', 'owner.json'));
      assert.equal((await readKeyFile(path.join(repo, 'keys', 'owner.json'))).address, made.address);
      // A folder named .git that is no repository is no repository; the one above it still is.
      const plain = path.join(repo, 'keys', 'plain');
      mkdirSync(path.join(plain, '.git'), { recursive: true });
      assert.ok((await makeKeyFile(path.join(plain, 'owner.json'))).address, 'the repository above ignores keys/');
      const open = path.join(repo, 'open');
      mkdirSync(path.join(open, '.git'), { recursive: true });
      await assert.rejects(makeKeyFile(path.join(open, 'owner.json')), /inside the git repository/);
    },
  );

  test('what is not a whole key, or can be read by others, is refused in words that quote none of it', async () => {
    const dir = folder();
    const good = path.join(dir, 'good.json');
    await makeKeyFile(good);
    const bytes = JSON.parse(readFileSync(good, 'utf8'));
    const write = (name, text, mode = 0o600) => {
      const file = path.join(dir, name);
      writeFileSync(file, text, { mode });
      chmodSync(file, mode);
      return file;
    };
    const refused = async (file, pattern, options) =>
      assert.rejects(readKeyFile(file, options), e => {
        assert.ok(e instanceof KeyFileError, e.message);
        assert.match(e.message, pattern);
        // no run of the key's numbers, however it is written
        assert.ok(!e.message.includes(bytes.slice(0, 4).join(',')), 'the refusal quotes the key');
        return true;
      });
    await refused(path.join(dir, 'missing.json'), /does not exist/);
    await refused(dir, /is not a file/);
    await refused(write('words.json', 'not json'), /is not a Solana key file/);
    await refused(write('short.json', JSON.stringify(bytes.slice(0, 32))), /is not a Solana key file/);
    await refused(write('wide.json', JSON.stringify([...bytes.slice(0, 63), 256])), /is not a Solana key file/);
    await refused(write('object.json', JSON.stringify({ secretKey: bytes })), /is not a Solana key file/);
    await refused(write('big.json', JSON.stringify(bytes).padEnd(5000, ' ')), /too big/);
    const swapped = [...bytes.slice(0, 32), ...bytes.slice(32).reverse()];
    await refused(write('damaged.json', JSON.stringify(swapped)), /damaged/);
    if (posix) {
      await refused(write('open.json', JSON.stringify(bytes), 0o644), /can be read by other users.*chmod 600/s);
      await refused(write('group.json', JSON.stringify(bytes), 0o640), /can be read by other users/);
    }
    // (where a file's mode says nothing of who reads it, it is not asked)
    const open = write('windows.json', JSON.stringify(bytes), 0o644);
    assert.ok((await readKeyFile(open, { platform: 'win32' })).address);
  });

  test('a path that starts with ~ is the home folder, whoever expands it', () => {
    assert.equal(keyFilePath('~/.config/xsolana/game.json'), path.join(homedir(), '.config/xsolana/game.json'));
    assert.equal(keyFilePath('keys/game.json'), path.resolve('keys/game.json'));
    assert.throws(() => keyFilePath(''), KeyFileError);
  });
});

/** A fresh chain, the spec in a file, and a funded key file. `fails`: see approve.test.mjs. */
async function setup(spec, { fails = null, fund = 100_000_000_000n } = {}) {
  const w = world({ project: false, seed: 'approve-key' });
  w.chain.warp(NOW);
  const dir = folder();
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  const keyFile = path.join(folder(), 'owner.json');
  const { address } = await makeKeyFile(keyFile);
  if (fund) w.chain.airdrop(address, fund);
  let sends = 0;
  const chain = approvalChain(w, {
    send: async wire => {
      sends++;
      if (fails?.on && sends === fails.send)
        throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
      return w.chain.sendWire(wire);
    },
  });
  /** One run of the command: what it printed, and what it answered. */
  const run = async (options = {}) => {
    const lines = [];
    const answer = await approveWithKey({
      file,
      keyFile,
      chain,
      now: () => NOW,
      out: line => lines.push(line),
      ...options,
    });
    return { ...answer, text: lines.join('\n') };
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  return { w, file, keyFile, address, chain, run, saved, sends: () => sends };
}

describe('xsolana approve --keypair', () => {
  test(
    'shows everything the page shows and sends nothing; the code it gives sends exactly that',
    { skip: skip ?? false },
    async () => {
      const spec = example('coin-flip-arena');
      const { w, address, run, saved, sends, file, keyFile } = await setup(spec);
      const shown = await run();
      assert.equal(shown.ok, true);
      assert.equal(shown.sent, 0);
      assert.equal(sends(), 0, 'nothing was sent');
      assert.equal(saved().live, undefined, 'the file is as it was');
      assert.match(shown.code, /^[0-9a-f]{8}$/);
      assert.match(shown.text, new RegExp(`Nothing was sent\\..*--yes ${shown.code}$`, 's'));
      // The key, the project it makes, the notice, the legal flags and every step with its details.
      assert.ok(shown.text.includes(address) && shown.text.includes(keyFile));
      for (const line of NOTICE) assert.ok(shown.text.includes(line), line);
      const state = await (await createApproval({ file, chain: approvalChain(w), now: () => NOW })).stateFor(address);
      assert.ok(state.legal.length > 0 && state.steps.length > 3);
      for (const f of state.legal) assert.ok(shown.text.includes(f.says), f.says);
      for (const w of state.warnings) assert.ok(shown.text.includes(w), w);
      for (const s of state.steps) {
        assert.ok(shown.text.includes(s.says), s.says);
        for (const d of s.details) assert.ok(shown.text.includes(d), d);
      }
      assert.ok(shown.text.includes(`Project: ${state.project}`));
      // The accounts the setup makes new, each named by what it is.
      assert.match(
        shown.text,
        /New, made by this setup: the mint of the token “arena”, at [1-9A-HJ-NP-Za-km-z]{32,44} /,
      );
      assert.match(shown.text, /New, made by this setup: the collection, at [1-9A-HJ-NP-Za-km-z]{32,44} /);
      assert.match(shown.text, /The key holds 100 SOL\. Going live takes about [\d.]+ SOL\./);
      assert.ok(!shown.text.includes(JSON.parse(readFileSync(keyFile, 'utf8')).slice(0, 4).join(',')), 'never the key');

      // The same again is the same code; a code that is not this one sends nothing.
      assert.equal((await run()).code, shown.code);
      const wrong = await run({ yes: 'deadbeef' });
      assert.equal(wrong.ok, false);
      assert.match(wrong.text, /Nothing was sent: "deadbeef" is not the code of what is above/);
      assert.equal(sends(), 0);

      const live = await run({ yes: shown.code });
      assert.equal(live.ok, true);
      assert.equal(live.done, true);
      assert.ok(live.sent > 1);
      assert.equal(live.sent, sends());
      assert.match(live.text, /Live on devnet: \d+ transactions landed/);
      const file2 = saved();
      assert.ok(file2.live?.project && !file2.live.partial, 'live, and not partial');
      assert.equal(w.read('Project', file2.live.project).owner, address, 'the key is the project’s owner');
      assert.equal(file2.live.transactions.length, live.sent);

      // Once live there is nothing to send, and an old code sends nothing either.
      const again = await run({ yes: shown.code });
      assert.equal(again.ok, true);
      assert.equal(again.done, true);
      assert.equal(again.sent, 0);
      assert.match(again.text, /Nothing to send: “.*” is live on devnet/);
      assert.equal(sends(), live.sent);
    },
  );

  test('the notice is the page’s own', () => {
    const page = readFileSync(path.join(ROOT, 'js/approve/page.html'), 'utf8').replace(/\s+/g, ' ').replace(/'/g, '’');
    for (const line of NOTICE) assert.ok(page.includes(line), line);
  });

  test(
    'a yes is for what was shown: an edit to the file after it gives another code',
    { skip: skip ?? false },
    async () => {
      const spec = example('coin-flip-arena');
      const { run, saved, sends, file } = await setup(spec);
      const first = await run();
      writeFileSync(
        file,
        JSON.stringify({ ...spec, boxes: [{ ...spec.boxes[0], price: spec.boxes[0].price * 2 }] }, null, 2),
      );
      const stale = await run({ yes: first.code });
      assert.equal(stale.ok, false);
      assert.equal(sends(), 0);
      assert.notEqual(stale.code, first.code);
      assert.ok(stale.text.includes(`its code is ${stale.code}`));
      assert.equal((await run({ yes: stale.code })).done, true);

      // A change to the live economy: only the change is shown and sent, under a code of its own.
      const live = saved();
      const before = sends();
      writeFileSync(
        file,
        JSON.stringify({ ...live, pools: [...live.pools, { key: 'bonus', currency: 'sol' }] }, null, 2),
      );
      const change = await run();
      assert.match(change.text, /a change to a live economy/);
      assert.match(change.text, /To send: 1 step in 1 transaction/);
      assert.notEqual(change.code, stale.code);
      assert.equal(sends(), before);
      const sent = await run({ yes: change.code });
      assert.equal(sent.done, true);
      assert.equal(sends(), before + 1);
      assert.ok(saved().live.published.pools.some(p => p.key === 'bonus'));
    },
  );

  test(
    'a setup cut short says what landed and stops; the next run shows what is left and goes on',
    { skip: skip ?? false },
    async () => {
      const fails = { send: 2, on: true };
      const { run, saved, sends } = await setup(example('coin-flip-arena'), { fails });
      const shown = await run();
      const cut = await run({ yes: shown.code });
      assert.equal(cut.ok, false);
      assert.equal(cut.done, false);
      assert.equal(cut.sent, 1);
      assert.match(cut.text, /Stopped after 1 transaction: .*blockhash not found.*run the command again to go on/s);
      assert.equal(saved().live.partial, true);
      fails.on = false;
      // What was shown before is not what is left: the old code sends nothing.
      const before = sends();
      const old = await run({ yes: shown.code });
      assert.equal(old.ok, false);
      assert.equal(sends(), before);
      assert.match(old.text, /a setup that was cut short goes on/);
      assert.match(old.text, /Landed already/);
      const rest = await run({ yes: old.code });
      assert.equal(rest.done, true);
      assert.ok(saved().live.project && !saved().live.partial);
    },
  );

  test('on a terminal the person is asked there, and only a yes sends', { skip: skip ?? false }, async () => {
    const { run, sends, address } = await setup(example('coin-flip-arena'));
    const asked = [];
    const no = await run({
      confirm: async question => {
        asked.push(question);
        return false;
      },
    });
    assert.equal(no.ok, true);
    assert.equal(sends(), 0);
    assert.match(no.text, /Nothing was sent\.$/);
    assert.match(asked[0], new RegExp(`Send \\d+ transactions from ${address}\\? Type yes to send: `));
    const yes = await run({ confirm: async () => true });
    assert.equal(yes.done, true);
  });

  test('a key with no SOL sends nothing, and says where to send some', { skip: skip ?? false }, async () => {
    const { run, sends, address } = await setup(example('coin-flip-arena'), { fund: 0n });
    const shown = await run({ yes: true });
    assert.equal(shown.ok, false);
    assert.equal(sends(), 0);
    assert.ok(shown.text.includes(`the key holds no SOL. Send devnet SOL to ${address} first`));
  });

  test('a key that holds less than a new setup takes starts nothing', { skip: skip ?? false }, async () => {
    // (the example's setup takes about 5.33 SOL: one SOL would land its first transactions and stop at its seeds)
    const { run, sends, saved, address } = await setup(example('coin-flip-arena'), { fund: 1_000_000_000n });
    const short = await run({ yes: true });
    assert.equal(short.ok, false);
    assert.equal(sends(), 0);
    assert.equal(saved().live, undefined);
    assert.match(
      short.text,
      new RegExp(
        `Nothing was sent: the key holds 1 SOL, less than the about 5\\.\\d+ SOL going live takes\\. Send ${address} at least 4\\.\\d+ SOL more`,
      ),
    );
  });

  test('another key than the owner’s cannot change a live economy', { skip: skip ?? false }, async () => {
    const { w, run, saved, sends, file } = await setup(example('coin-flip-arena'));
    assert.equal((await run({ yes: true })).done, true);
    const live = saved();
    writeFileSync(
      file,
      JSON.stringify({ ...live, pools: [...live.pools, { key: 'bonus', currency: 'sol' }] }, null, 2),
    );
    const strangerFile = path.join(folder(), 'stranger.json');
    const stranger = await makeKeyFile(strangerFile);
    w.chain.airdrop(stranger.address, 10_000_000_000n);
    const before = sends();
    const refused = await run({ keyFile: strangerFile, yes: true });
    assert.equal(refused.ok, false);
    assert.equal(sends(), before);
    assert.match(refused.text, /^Nothing can be sent: /);
    // It is told whose key this is, and not to make a key or cut the file to get past it.
    assert.ok(refused.text.includes(`This key file’s address is ${stranger.address}.`));
    assert.match(
      refused.text,
      /A live project is signed only by the key that owns it; xsolana\.json is not to be changed/,
    );
    assert.match(refused.text, /If another key owns this project, sign with that key/);
    assert.equal(
      saved().live.published.pools.some(p => p.key === 'bonus'),
      false,
    );
  });

  test(
    'every example gives the same code twice: a code stands for what is shown, not for one run',
    { skip: skip ?? false },
    async () => {
      let coded = 0;
      for (const name of readdirSync(path.join(ROOT, 'examples')).filter(
        f => f.endsWith('.json') && f !== 'ideas.json',
      )) {
        const { run } = await setup(example(name.slice(0, -5)));
        const [a, b] = [await run(), await run()];
        assert.equal(a.code, b.code, name);
        if (a.code) coded++;
      }
      assert.ok(coded >= 15, `${coded} examples gave a code`);
    },
  );

  test('the code changes with the key, the spec and each line shown', () => {
    const state = {
      cluster: 'devnet',
      program: 'P',
      wallet: 'W',
      project: 'J',
      mode: 'new',
      steps: [{ id: 'project', says: 'Open the project', signer: 'owner' }],
      warnings: ['a warning'],
      legal: [{ code: 'L', says: 'a flag' }],
      unwritten: [],
    };
    const spec = { name: 'x', pools: [], live: { partial: true } };
    const code = approvalCode(state, spec);
    assert.equal(approvalCode(state, { ...spec, live: { project: 'J' } }), code, 'the live section is not the spec');
    for (const other of [
      approvalCode({ ...state, wallet: 'V' }, spec),
      approvalCode({ ...state, project: 'K' }, spec),
      approvalCode({ ...state, warnings: [] }, spec),
      approvalCode({ ...state, legal: [] }, spec),
      approvalCode({ ...state, steps: [] }, spec),
      approvalCode({ ...state, steps: [{ ...state.steps[0], details: ['Pays: 5% to someone else'] }] }, spec),
      approvalCode({ ...state, read: 'r1' }, spec),
      approvalCode(state, { ...spec, name: 'y' }),
    ])
      assert.notEqual(other, code);
  });
});

describe('the command line', () => {
  const xsolana = (args, options = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, 'bin/xsolana.mjs'), ...args], { encoding: 'utf8', ...options });

  test('approve with no way to sign opens nothing: it says the two ways', () => {
    const r = xsolana(['approve'], { timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /say how going live is signed/);
    assert.match(r.stderr, /--keypair <keyfile>/);
    assert.match(
      r.stderr,
      /--keypair <keyfile> .*sends nothing; run again with --yes <code>, it sends exactly\s+that/s,
    );
    assert.match(
      r.stderr,
      /--browser .*Only\s+when the person whose economy it is asks for that; they run it themselves/s,
    );
    assert.equal(r.stdout, '');
  });

  test('the flags of one way are refused with the other', () => {
    assert.match(xsolana(['approve', '--yes', 'abc']).stderr, /--yes goes with --keypair/);
    assert.match(xsolana(['approve', '--keypair', 'k.json', '--browser']).stderr, /two ways to sign: give one/);
    assert.match(xsolana(['approve', '--keypair', 'k.json', '--port', '8000']).stderr, /go with --browser/);
    assert.match(xsolana(['approve', '--keypair']).stderr, /--keypair needs a value/);
    assert.match(xsolana(['keygen']).stderr, /say where the key file goes/);
    assert.match(xsolana(['keygen', '--force', 'k.json']).stderr, /takes no --force flag/);
  });

  test('keygen prints the address and what the key is, never the key', () => {
    const file = path.join(folder(), 'game.json');
    const r = xsolana(['keygen', file]);
    assert.equal(r.status, 0, r.stderr);
    const bytes = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!r.stdout.includes(bytes.slice(0, 4).join(',')) && !r.stdout.includes('['));
    assert.match(r.stdout, /Its address:\n {2}[1-9A-HJ-NP-Za-km-z]{32,44}\n/);
    assert.match(r.stdout, /anyone who can read that file controls the project/);
    assert.match(r.stdout, /nothing can change the project or move what its address holds/);
    const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(r.stdout.includes(`npx -y @xgamesfun/solana@${version} approve xsolana.json --keypair ${file}`));
    // A path a shell would split is in quotes; one given from the home folder is said as it was given.
    const spaced = path.join(folder(), 'my games', 'game.json');
    assert.ok(xsolana(['keygen', spaced]).stdout.includes(`--keypair "${spaced}"`));
    const again = xsolana(['keygen', file]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already there/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), bytes);
  });

  test('a key file that is missing is said in one line, before anything is read from the chain', () => {
    const dir = folder();
    writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(example('coin-flip-arena')));
    const r = xsolana(['approve', 'xsolana.json', '--keypair', path.join(dir, 'none.json')], {
      cwd: dir,
      timeout: 20_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^xsolana: .*none\.json does not exist\./);
  });
});
