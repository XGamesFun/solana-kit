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
import * as loot from '../client/index.js';
import { freshKeypair, verifySignature } from '../approve/ed25519.mjs';
import { toBase64 } from '../chain/bytes.js';
import { transferLamports } from '../chain/programs.js';
import { compileMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { KeyFileError, keyFilePath, makeKeyFile, readKeyFile } from '../approve/keyfile.mjs';
import { approvalCode, approvalText, approveWithKey, NOTICE } from '../approve/with-key.mjs';
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
      // git is asked about the folder the key is in, whatever repository the caller's own environment names.
      // (the caller's settings name another repository, whose work tree is the whole disk and which ignores
      // everything: asked with them, git would call the key ignored)
      const elsewhere = folder();
      execFileSync('git', ['init', '-q', elsewhere]);
      writeFileSync(path.join(elsewhere, '.git', 'info', 'exclude'), '*\n');
      const env = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
      process.env.GIT_DIR = path.join(elsewhere, '.git');
      process.env.GIT_WORK_TREE = path.parse(repo).root;
      try {
        const asked = spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--', path.join(repo, 'env.json')]);
        assert.equal(asked.status, 0, 'with the caller’s settings git calls the key ignored: the test bites');
        await assert.rejects(makeKeyFile(path.join(repo, 'env.json')), /inside the git repository/);
        assert.equal(existsSync(path.join(repo, 'env.json')), false);
      } finally {
        for (const [name, value] of Object.entries(env))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
      // A .git that is a file pointing at a repository that is not there (a worktree whose own repository is away)
      // is not "no repository": nobody can say what it ignores.
      const away = path.join(folder(), 'worktree');
      mkdirSync(away);
      writeFileSync(path.join(away, '.git'), `gitdir: ${path.join(away, 'gone', '.git', 'worktrees', 'w')}\n`);
      await assert.rejects(makeKeyFile(path.join(away, 'owner.json')), /inside the git repository/);
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
      assert.match(shown.code, loot.cluster() === 'mainnet' ? /^mainnet-[0-9a-f]{8}$/ : /^[0-9a-f]{8}$/);
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
      // What it sent is what it showed: the same steps, in the same words and order, in as many transactions.
      const sending = live.text
        .split('\n')
        .filter(l => l.startsWith('Sending: '))
        .map(l => l.slice('Sending: '.length));
      assert.equal(sending.join('; '), state.steps.map(s => s.says).join('; '));
      assert.equal(sending.length, state.remaining);
      assert.equal(live.sent, state.remaining);
      assert.match(live.text, new RegExp(`Live on ${loot.cluster()}: \\d+ transactions landed`));
      const file2 = saved();
      assert.ok(file2.live?.project && !file2.live.partial, 'live, and not partial');
      assert.equal(w.read('Project', file2.live.project).owner, address, 'the key is the project’s owner');
      assert.equal(file2.live.transactions.length, live.sent);

      // Once live there is nothing to send, and an old code sends nothing either.
      const again = await run({ yes: shown.code });
      assert.equal(again.ok, true);
      assert.equal(again.done, true);
      assert.equal(again.sent, 0);
      assert.match(again.text, new RegExp(`Nothing to send: “.*” is live on ${loot.cluster()}`));
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
      assert.match(
        cut.text,
        /Stopped after 1 transaction landed: .*blockhash not found.*run the command again to go on from where it stopped/s,
      );
      assert.doesNotMatch(cut.text, /not known to have landed/);
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
    assert.ok(
      shown.text.includes(
        loot.cluster() === 'mainnet'
          ? `the key holds no SOL. This economy is on mainnet: send SOL to ${address} first`
          : `the key holds no SOL. Send devnet SOL to ${address} first`,
      ),
    );
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

  test(
    'a project handed to a new owner is changed by the new owner’s key, and no more by the old one',
    { skip: skip ?? false },
    async () => {
      const { w, run, saved, sends, file, keyFile, address } = await setup(example('coin-flip-arena'));
      assert.equal((await run({ yes: true })).done, true);
      const live = saved();
      assert.equal(live.live.treasury, address);
      assert.equal(live.live.authority, address);
      // The owner hands the project on with the program's own update_project, signed by both keys: a new owner,
      // authority and treasury. A project's address is its creator's and its number, and a new owner keeps it.
      const nextFile = path.join(folder(), 'next.json');
      const next = await makeKeyFile(nextFile);
      w.chain.airdrop(next.address, 100_000_000_000n);
      const [was, now] = [await readKeyFile(keyFile), await readKeyFile(nextFile)];
      const handover = wireTransaction(
        compileMessage({
          payer: address,
          blockhash: w.chain.svm.latestBlockhash(),
          instructions: [
            loot.updateProjectIx({
              owner: address,
              project: live.live.project,
              authority: next.address,
              treasury: next.address,
              newOwner: next.address,
            }),
          ],
        }),
      );
      w.chain.sendWire(await now.signTransaction(await was.signTransaction(handover)));
      const onChain = loot.decode('Project', (await w.chain.rpc.account(live.live.project)).data);
      assert.equal(onChain.owner, next.address);
      assert.equal(onChain.creator, address);
      assert.equal(loot.pda.project(address, 0), live.live.project, 'its address is its creator’s still');

      // A change to the economy, with the file as the old owner's approve left it: the new owner's key sends it.
      writeFileSync(
        file,
        JSON.stringify({ ...live, pools: [...live.pools, { key: 'bonus', currency: 'sol' }] }, null, 2),
      );
      const before = sends();
      const changed = await run({ keyFile: nextFile, yes: true });
      assert.equal(changed.ok, true, changed.text);
      assert.equal(changed.done, true, changed.text);
      assert.ok(sends() > before, 'the change was sent');
      const after = saved();
      assert.equal(after.live.project, live.live.project, 'the same project');
      const pool = after.pools.find(x => x.key === 'bonus');
      assert.ok(await w.chain.rpc.account(loot.pda.pool(live.live.project, pool.index)), 'its new pool is on chain');
      // The file now says what the chain says of the project's keys.
      assert.equal(after.live.treasury, next.address);
      assert.equal(after.live.authority, next.address);
      // The printout said whose the project is now, so nobody reads the file's old lines as current.
      assert.ok(
        changed.text.includes(
          `On chain the project’s treasury is ${next.address} (the file said ${address}): the file is corrected when this lands.`,
        ),
        changed.text,
      );

      // The collection its creator made for it is still the project's, whoever's it is to update now.
      assert.ok(after.live.collection, 'the example has a collection');
      assert.equal(after.live.collection, live.live.collection);

      // A file that names it under another number is refused: its address is its creator's number, on chain.
      writeFileSync(file, JSON.stringify({ ...after, projectNumber: 5 }, null, 2));
      const sentSoFar = sends();
      const numbered = await run({ keyFile: nextFile, yes: true });
      assert.equal(numbered.ok, false);
      assert.equal(sends(), sentSoFar);
      assert.ok(
        numbered.text.includes(
          `The file names the project ${live.live.project}, which is not project number 5 of its creator ${address}.`,
        ),
        numbered.text,
      );

      // The key that handed it on owns it no more: it is refused as any other key is.
      writeFileSync(
        file,
        JSON.stringify({ ...after, pools: [...after.pools, { key: 'late', currency: 'sol' }] }, null, 2),
      );
      const sent = sends();
      const refused = await run({ yes: true });
      assert.equal(refused.ok, false);
      assert.equal(sends(), sent);
      assert.ok(refused.text.includes(`which belongs to ${next.address}, not to ${address}`), refused.text);
    },
  );

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
    assert.ok(refused.text.includes(`This key file’s address is ${stranger.address}: it is not the project’s key.`));
    assert.match(refused.text, /If the project is yours, sign with the key that owns it/);
    assert.match(refused.text, /xsolana\.json needs no change, and a new key can change nothing/);
    assert.match(refused.text, /don’t make a new one, and don’t change xsolana\.json to get past this/);
    assert.doesNotMatch(refused.text, /restore the file/);

    // The owner's own key refused for a mistake in the file is told to correct the file, and nothing about keys.
    writeFileSync(
      file,
      JSON.stringify(
        { ...live, tokens: live.tokens.map(t => (t.decimals === 6 ? { ...t, decimals: 9 } : t)) },
        null,
        2,
      ),
    );
    const mistaken = await run({ yes: true });
    assert.equal(mistaken.ok, false);
    assert.equal(sends(), before);
    assert.doesNotMatch(mistaken.text, /not the project’s key|new key/);
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

  test('the code changes with the key, the file and each line shown, and with nothing else', () => {
    const state = {
      cluster: 'devnet',
      program: 'P',
      wallet: 'W',
      project: 'J',
      mode: 'change',
      steps: [
        { id: 'grant:daily', says: 'Open the grant', signer: 'owner', details: ['closes 2026-12-11T08:34:11Z'] },
        { id: 'pool:bonus', says: 'Open the pool', signer: 'owner', details: [] },
      ],
      warnings: ['a warning'],
      legal: [
        { code: 'L', says: 'a flag' },
        { code: 'M', says: 'another flag' },
      ],
      unwritten: ['a name the chain can’t take'],
      read: 'r0',
      fresh: [{ name: 'mint/gold', address: 'FreshMintAddress1111111111111111111111111111' }],
    };
    const spec = { name: 'x', pools: [], live: { project: 'J', mints: { gold: 'M1' }, partial: true } };
    const code = approvalCode(state, spec);
    const step = (i, change) => ({ ...state, steps: state.steps.map((s, n) => (n === i ? { ...s, ...change } : s)) });
    const others = {
      'the key': approvalCode({ ...state, wallet: 'V' }, spec),
      'the project': approvalCode({ ...state, project: 'K' }, spec),
      'the cluster': approvalCode({ ...state, cluster: 'testnet' }, spec),
      'the program': approvalCode({ ...state, program: 'Q' }, spec),
      'new or a change': approvalCode({ ...state, mode: 'new' }, spec),
      'a warning': approvalCode({ ...state, warnings: ['another warning'] }, spec),
      'a legal line’s words': approvalCode({ ...state, legal: [state.legal[0], { code: 'M', says: 'a third' }] }, spec),
      'a name that can’t be written': approvalCode({ ...state, unwritten: [] }, spec),
      'what the chain says of the tokens': approvalCode({ ...state, read: 'r1' }, spec),
      'a step fewer': approvalCode({ ...state, steps: [state.steps[0]] }, spec),
      'a step’s words': approvalCode(step(1, { says: 'Open another pool' }), spec),
      'who signs a step': approvalCode(step(1, { signer: 'authority' }), spec),
      'what a step pays': approvalCode(step(1, { details: ['Pays: 5% to someone else'] }), spec),
      'the steps’ order': approvalCode({ ...state, steps: [...state.steps].reverse() }, spec),
      'the spec': approvalCode(state, { ...spec, name: 'y' }),
      // the addresses the file's live section gives the steps, whether or not a line names them
      'a mint in the live section': approvalCode(state, { ...spec, live: { ...spec.live, mints: { gold: 'M2' } } }),
      'the live section’s project': approvalCode(state, { ...spec, live: { ...spec.live, project: 'K' } }),
      'what has landed': approvalCode(state, { ...spec, live: { ...spec.live, landed: ['pool:bonus'] } }),
    };
    for (const [what, other] of Object.entries(others)) assert.notEqual(other, code, what);
    assert.equal(new Set(Object.values(others)).size, Object.keys(others).length, 'each its own code');
    // What is new at each run, and says nothing a person can check, is not in it: the address of an account the
    // setup makes new, and a time counted from the run's own clock.
    const again = {
      ...step(0, { details: ['closes 2026-12-11T08:35:41Z'] }),
      fresh: [{ name: 'mint/gold', address: 'AnotherFreshMint111111111111111111111111111' }],
    };
    assert.equal(approvalCode(again, spec), code);
    const named = a => step(1, { details: [`minted from ${a}`] });
    assert.equal(
      approvalCode({ ...named('AnotherFreshMint111111111111111111111111111'), fresh: again.fresh }, spec),
      approvalCode(named('FreshMintAddress1111111111111111111111111111'), spec),
    );
    // Any other address in a line is in the code (these two are real ones: nothing but times and new accounts is
    // left out of the lines).
    assert.notEqual(
      approvalCode(named('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), spec),
      approvalCode(named('So11111111111111111111111111111111111111112'), spec),
    );
    // A time years off is written by the day, with the years it is away: the same code a day on.
    const far = day =>
      step(1, { details: [`It draws on ${day} November 2030, 4 years from now: what waits on it is locked`] });
    assert.equal(approvalCode(far(11), spec), approvalCode(far(12), spec));
    assert.equal(
      approvalCode({ ...state, warnings: ['“draw” lands on 11 November 2030, 4 years after go-live'] }, spec),
      approvalCode({ ...state, warnings: ['“draw” lands on 12 November 2031, 5 years after go-live'] }, spec),
    );
    assert.notEqual(approvalCode(far(11), spec), approvalCode(step(1, { details: ['It draws in 4 days'] }), spec));
  });

  test('a time counted from “publish” is not a new code a second later', { skip: skip ?? false }, async () => {
    const fair = example('shelter-fair');
    const spec = {
      ...fair,
      grants: fair.grants.map((g, i) => (i ? g : { ...g, limits: { ...g.limits, until: 'publish+30d' } })),
    };
    const { run, saved } = await setup(spec);
    const shown = await run();
    assert.match(
      shown.code ?? '',
      loot.cluster() === 'mainnet' ? /^mainnet-[0-9a-f]{8}$/ : /^[0-9a-f]{8}$/,
      shown.text,
    );
    // Ninety seconds on, the lines that count from now say other times, and the code is the same: it sends.
    const later = await run({ now: () => NOW + 90 });
    assert.notEqual(
      later.text.replace(/--yes \w+$/, ''),
      shown.text.replace(/--yes \w+$/, ''),
      'a time in the lines moved',
    );
    assert.equal(later.code, shown.code);
    assert.equal((await run({ now: () => NOW + 90, yes: shown.code })).done, true);
    assert.ok(saved().live.project);
  });

  test(
    'the code covers the file’s live section: an address swapped in it after the show sends nothing',
    { skip: skip ?? false },
    async () => {
      const { run, saved, sends, file } = await setup(example('coin-flip-arena'));
      assert.equal((await run({ yes: true })).done, true);
      const live = saved();
      const changed = { ...live, pools: [...live.pools, { key: 'bonus', currency: 'arena' }] };
      writeFileSync(file, JSON.stringify(changed, null, 2));
      const shown = await run();
      assert.match(
        shown.code ?? '',
        loot.cluster() === 'mainnet' ? /^mainnet-[0-9a-f]{8}$/ : /^[0-9a-f]{8}$/,
        shown.text,
      );
      const before = sends();
      // Only the live section's mint is edited: no line of the printout names it.
      const other = (await makeKeyFile(path.join(folder(), 'other.json'))).address;
      writeFileSync(
        file,
        JSON.stringify(
          { ...changed, live: { ...changed.live, mints: { ...changed.live.mints, arena: other } } },
          null,
          2,
        ),
      );
      const swapped = await run({ yes: shown.code });
      assert.equal(swapped.ok, false);
      assert.equal(sends(), before, 'nothing was sent under the old code');
      // The file as it was shown still sends under its code.
      writeFileSync(file, JSON.stringify(changed, null, 2));
      assert.equal((await run({ yes: shown.code })).done, true);
      assert.equal(sends(), before + 1);
    },
  );

  test('a send the cluster took, whose answer was lost, is not sent again', { skip: skip ?? false }, async () => {
    // The node takes each transaction, and the answer to one is lost: the client's own second try is refused as
    // already processed (`refused`), or no answer comes at all (`silent`). Either way it landed, and is sent once.
    for (const lost of ['refused', 'silent']) {
      const w = world({ project: false, seed: `lost-${lost}` });
      w.chain.warp(NOW);
      const file = path.join(folder(), 'xsolana.json');
      writeFileSync(file, JSON.stringify(example('coin-flip-arena'), null, 2));
      const keyFile = path.join(folder(), 'owner.json');
      const { address } = await makeKeyFile(keyFile);
      w.chain.airdrop(address, 100_000_000_000n);
      let sends = 0;
      const chain = approvalChain(w, {
        send: async wire => {
          const signature = w.chain.sendWire(wire);
          if (++sends !== 2) return signature;
          throw lost === 'refused'
            ? Object.assign(new Error('Transaction simulation failed: This transaction has already been processed'), {
                code: -32002,
              })
            : new Error('RPC sendTransaction did not answer: fetch failed');
        },
      });
      const lines = [];
      const r = await approveWithKey({ file, keyFile, chain, now: () => NOW, yes: true, out: l => lines.push(l) });
      assert.equal(r.done, true, `${lost}: ${lines.join('\n')}`);
      assert.equal(r.sent, sends, lost);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(saved.live.transactions.length, sends, lost);
      assert.equal(saved.live.pending, undefined, lost);
      // (the pool's seed went in once)
      const again = await approveWithKey({ file, keyFile, chain, now: () => NOW, yes: true, out: () => {} });
      assert.equal(again.sent, 0, lost);
    }
  });

  test('a send whose fate is not known is not called “nothing sent”', { skip: skip ?? false }, async () => {
    const { w, address, file, keyFile } = await setup(example('coin-flip-arena'));
    let sends = 0;
    // The first send gets no answer, and the chain has not seen it (yet).
    const chain = approvalChain(w, {
      send: async () => {
        sends++;
        throw new Error('RPC sendTransaction did not answer: fetch failed');
      },
    });
    const lines = [];
    const r = await approveWithKey({ file, keyFile, chain, now: () => NOW, yes: true, out: l => lines.push(l) });
    assert.equal(r.ok, false);
    assert.equal(sends, 1);
    const last = lines.at(-1);
    assert.match(
      last,
      /^Stopped \(1 more was sent and is not known to have landed yet\): RPC sendTransaction did not answer/,
    );
    assert.match(last, /a transaction still looked for is found first, so nothing is sent twice/);
    assert.doesNotMatch(last, /Nothing was sent/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).live.pending.length, 1);
    assert.ok(address);
  });

  test('a step that was not on the printout is never signed, in the first batch or a later one', async () => {
    const keyFile = path.join(folder(), 'owner.json');
    const { address } = await makeKeyFile(keyFile);
    const other = freshKeypair().address;
    const wire = toBase64(
      wireTransaction(
        compileMessage({ payer: address, blockhash: other, instructions: [transferLamports(address, other, 1n)] }),
      ),
    );
    const step = id => ({ id, says: `Step ${id}`, signer: 'owner', details: [], done: false });
    const view = ids => ({
      name: 'x',
      file: 'xsolana.json',
      mode: 'new',
      program: 'P',
      cluster: 'devnet',
      setupSol: null,
      warnings: [],
      legal: [],
      unwritten: [],
      authority: 'owner',
      steps: ids.map(step),
      landed: [],
      signatures: [],
      project: 'J',
      wallet: address,
      fresh: [],
      remaining: ids.length,
      done: false,
    });
    // An approval that shows steps a and b, then hands out `prepared`, and after each batch says `left` is left.
    const fake = ({ prepared, left }) => {
      const signed = [];
      let turn = 0;
      const approval = async () => ({
        spec: { name: 'x' },
        state: () => ({ signatures: signed.map((_, i) => `sig${i}`) }),
        stateFor: async () => view(turn ? left : ['a', 'b']),
        prepare: async () => ({
          id: 'batch',
          transactions: [wire],
          says: prepared.map(id => `Step ${id}`),
          steps: [prepared.map(id => ({ id, says: `Step ${id}` }))],
        }),
        complete: async (_wallet, _id, wires) => {
          signed.push(...wires);
          turn++;
        },
        close() {},
      });
      return { approval, signed };
    };
    const go = async f => {
      const lines = [];
      const chain = { account: async () => ({ lamports: 1_000_000_000 }) };
      const r = await approveWithKey({
        file: 'xsolana.json',
        keyFile,
        chain,
        yes: true,
        out: l => lines.push(l),
        approval: f.approval,
      });
      return { ...r, text: lines.join('\n') };
    };
    // A first batch that carries a step the printout did not have: nothing is signed.
    const first = fake({ prepared: ['a', 'c'], left: [] });
    const one = await go(first);
    assert.equal(one.ok, false);
    assert.equal(first.signed.length, 0);
    assert.match(one.text, /Nothing was sent: what is left to send is not what was shown above/);
    // The same step under other words is not the step that was shown.
    const reworded = fake({ prepared: ['a'], left: [] });
    reworded.approval = (inner => async () => {
      const s = await inner();
      return {
        ...s,
        prepare: async () => ({ ...(await s.prepare()), steps: [[{ id: 'a', says: 'Step a, and more' }]] }),
      };
    })(reworded.approval);
    assert.equal((await go(reworded)).ok, false);
    assert.equal(reworded.signed.length, 0);
    // What is left after a batch names a step that was not shown: it stops there.
    const later = fake({ prepared: ['a'], left: ['c'] });
    const two = await go(later);
    assert.equal(two.ok, false);
    assert.equal(later.signed.length, 1, 'the batch that was shown was signed, and no other');
    assert.match(two.text, /Stopped after 1 transaction: what is left to send is not what was shown above/);
    // What the chain says of the tokens changed after a batch (a line that was not read): it stops there too.
    const reread = fake({ prepared: ['a'], left: ['b'] });
    reread.approval = (inner => async () => {
      const s = await inner();
      let turn = 0;
      return { ...s, stateFor: async w => ({ ...(await s.stateFor(w)), read: turn++ ? 'r1' : 'r0' }) };
    })(reread.approval);
    const three = await go(reread);
    assert.equal(three.ok, false);
    assert.equal(reread.signed.length, 1);
    assert.match(three.text, /what is left to send is not what was shown above/);
    // A batch that does not say which steps it carries can't be held against the printout: nothing is signed.
    const mute = fake({ prepared: ['a'], left: [] });
    mute.approval = (inner => async () => {
      const s = await inner();
      return { ...s, prepare: async () => ({ ...(await s.prepare()), steps: undefined }) };
    })(mute.approval);
    assert.equal((await go(mute)).ok, false);
    assert.equal(mute.signed.length, 0);
    // Shown steps, batch by batch, go through.
    const fine = fake({ prepared: ['a'], left: [] });
    await go(fine);
    assert.equal(fine.signed.length, 1);
  });

  test('a refused send is forgotten only when it can never land', { skip: skip ?? false }, async () => {
    const refusal = more =>
      Object.assign(new Error('Transaction simulation failed: Blockhash not found'), { code: -32002, ...more });
    const once = async (seed, { fail, statusOf }) => {
      const w = world({ project: false, seed });
      w.chain.warp(NOW);
      const file = path.join(folder(), 'xsolana.json');
      writeFileSync(file, JSON.stringify(example('coin-flip-arena'), null, 2));
      const keyFile = path.join(folder(), 'owner.json');
      w.chain.airdrop((await makeKeyFile(keyFile)).address, 100_000_000_000n);
      const held = [];
      let sends = 0;
      const real = approvalChain(w);
      const chain = {
        ...real,
        send: async wire => {
          if (++sends !== 2) return w.chain.sendWire(wire);
          return fail(wire, w, held);
        },
        signatureStatus: async signature =>
          statusOf ? statusOf(signature, real, sends) : real.signatureStatus(signature),
      };
      const lines = [];
      const run = () => approveWithKey({ file, keyFile, chain, now: () => NOW, yes: true, out: l => lines.push(l) });
      const first = await run();
      return {
        w,
        file,
        run,
        first,
        lines,
        held,
        sends: () => sends,
        saved: () => JSON.parse(readFileSync(file, 'utf8')),
      };
    };
    // An earlier try of this send got no answer (`maybeTaken`), and the node that answered was behind: kept. It
    // lands after all, the next run finds it, and it is sent once.
    const lagging = await once('refused-may-be-taken', {
      fail: (wire, _w, held) => {
        held.push(wire);
        throw refusal({ maybeTaken: true });
      },
    });
    assert.equal(lagging.first.ok, false);
    assert.equal(lagging.saved().live.pending.length, 1, 'kept, not forgotten');
    assert.match(lagging.lines.at(-1), /1 more was sent and is not known to have landed yet/);
    lagging.w.chain.sendWire(lagging.held[0]);
    const before = lagging.sends();
    const next = await lagging.run();
    assert.equal(next.done, true, lagging.lines.join('\n'));
    // (four more went, and the one that had landed was not among them: five transactions in all, each once)
    assert.equal(lagging.saved().live.transactions.length, 5);
    assert.equal(lagging.sends() - before, 3);

    // The same refusal with every try answered: no node took it, so it is forgotten and made again at once.
    const answered = await once('refused-never-taken', {
      fail: () => {
        throw refusal({});
      },
    });
    assert.equal(answered.first.ok, false);
    assert.equal(answered.saved().live.pending, undefined);
    assert.equal((await answered.run()).done, true);

    // The chain can't be asked about it just then: kept.
    const unread = await once('refused-unread', {
      fail: () => {
        throw refusal({});
      },
      statusOf: (signature, real, sends) => {
        if (sends === 2) throw new Error('RPC getSignatureStatuses did not answer');
        return real.signatureStatus(signature);
      },
    });
    assert.equal(unread.first.ok, false);
    assert.equal(unread.saved().live.pending.length, 1);

    // Refused as already processed while the node asked has not seen it yet: it goes on to wait for it, and lands.
    const hidden = new Set();
    const early = await once('already-processed-unseen', {
      fail: (wire, w) => {
        hidden.add(w.chain.sendWire(wire));
        throw Object.assign(new Error('Transaction simulation failed: This transaction has already been processed'), {
          code: -32002,
          err: 'AlreadyProcessed',
        });
      },
      statusOf: (signature, real) => (hidden.delete(signature) ? null : real.signatureStatus(signature)),
    });
    assert.equal(early.first.done, true, early.lines.join('\n'));
    assert.equal(early.saved().live.transactions.length, early.sends());
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
    assert.match(xsolana(['keygen', 'a.json', 'b.json']).stderr, /makes one key file: give one path/);
    assert.match(xsolana(['approve', '--browser=false']).stderr, /--browser takes no value/);
    assert.match(xsolana(['approve', '--keypair', 'a.json', '--keypair', 'b.json']).stderr, /--keypair is given twice/);
    assert.match(xsolana(['approve', '--keypair=a.json', '--keypair=b.json']).stderr, /--keypair is given twice/);
    // (a bare -- is not a file's name: with no way to sign named, the two ways are said)
    assert.match(xsolana(['approve', '--']).stderr, /say how going live is signed/);
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

test('on mainnet the code says mainnet and the printout says real money first: typing the code back is a step beyond the file', () => {
  const state = {
    cluster: 'mainnet',
    program: 'P',
    wallet: 'W',
    project: 'J',
    mode: 'new',
    steps: [],
    warnings: [],
    legal: [],
    unwritten: [],
  };
  const spec = { name: 'x', network: 'mainnet' };
  assert.match(approvalCode(state, spec), /^mainnet-[0-9a-f]{8}$/);
  assert.match(approvalCode({ ...state, cluster: 'devnet' }, { name: 'x' }), /^[0-9a-f]{8}$/);
  // (every list the printout reads is empty here, every other field as given)
  const shown = new Proxy(
    { ...state, name: 'x', file: 'xsolana.json', setupSol: null },
    { get: (t, k) => (k in t ? t[k] : []) },
  );
  const lines = approvalText(shown, { keyFile: 'k.json' });
  assert.match(lines[0], /^MAINNET: everything below moves real SOL and real tokens/);
});
