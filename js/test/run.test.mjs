// How the suite starts (js/test/run.mjs, `npm test`): a run leaves no temp folder behind, and a run whose chain tests
// can't run stops once, saying why, unless it is told to go on without them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLiteSVM } from '../sim/chain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const MAKES_TEMP = 'js/test/helpers/makes-temp.mjs';
const SKIP = 'XSOLANA_SKIP_CHAIN_TESTS';
/**
 * The starter over one test file, as `npm test -- <file>` runs it, with `env` on top of this process's. Two variables
 * of this process are left out: the one that tells `node --test` it is a test file's own process, which that run is
 * not, and the one that lets this run go on without the chain tests, which each test here sets or leaves out itself.
 */
const start = (env = {}) => {
  const { NODE_TEST_CONTEXT: _, [SKIP]: __, ...mine } = process.env;
  return spawnSync(process.execPath, [path.join(root, 'js/test/run.mjs'), MAKES_TEMP], {
    cwd: root,
    encoding: 'utf8',
    env: { ...mine, ...env },
  });
};
/** The temp folders the test file said it made. */
const made = out => [...out.matchAll(/^temp (.+)$/gm)].map(m => m[1]);
// A program checkout that is not there: the chain tests can't run with it (`cannotRun`), whatever is installed here.
const NO_BUILD = { XSOLANA_PROGRAM_DIR: path.join(tmpdir(), 'xsolana-no-such-checkout') };

test('`npm test` is the starter, so every run of the suite starts through it', () => {
  assert.equal(pkg.scripts.test, 'node js/test/run.mjs');
  assert.match(pkg.scripts.check, /&& npm test$/);
});

test('a run leaves no temp folder behind: what its tests and the processes they start make is removed', () => {
  // (the test file it runs needs no chain, so this holds on a machine with no fixtures too)
  const r = start({ [SKIP]: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const folders = made(r.stdout);
  assert.equal(folders.length, 2, r.stdout);
  for (const folder of folders) {
    assert.match(path.basename(path.dirname(folder)), /^xsolana-test-/, 'made inside the run’s own folder');
    assert.equal(existsSync(path.dirname(folder)), false, `${path.dirname(folder)} is still there`);
  }
});

test('a run whose chain tests can’t run stops before any test, once, with why and how to go on without them', () => {
  const r = start(NO_BUILD);
  assert.equal(r.status, 1);
  assert.deepEqual(made(r.stdout), [], 'no test ran');
  assert.match(
    r.stderr,
    /^The tests that run the real program can’t run here: .*xsolana-no-such-checkout.* is missing: /,
  );
  assert.match(r.stderr, /No test was run\. .*XSOLANA_SKIP_CHAIN_TESTS=1 \(CONTRIBUTING\.md\)\.\n$/);
  assert.equal(r.stderr.trim().split('\n').length, 2, 'said once');
});

test('XSOLANA_SKIP_CHAIN_TESTS runs the rest without the chain tests, and the run says it did', () => {
  const r = start({ ...NO_BUILD, [SKIP]: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(made(r.stdout).length, 2, 'the tests ran');
  assert.match(
    r.stderr,
    /^XSOLANA_SKIP_CHAIN_TESTS is set: the tests that run the real program are skipped \(.* is missing: /,
  );
});

test('the way to run without the chain tests is in CONTRIBUTING.md', () => {
  assert.match(readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8'), /`XSOLANA_SKIP_CHAIN_TESTS`/);
});

test('a LiteSVM that does not load is said with why and the command that installs the pinned version', () => {
  assert.ok(pkg.devDependencies.litesvm, 'LiteSVM is a dev dependency');
  assert.throws(
    () => loadLiteSVM(new URL('file:///xsolana-no-such-folder/x.mjs').href),
    error =>
      /^LiteSVM did not load \(Cannot find module 'litesvm'\): run `npm ci`\. It is a dev dependency/.test(
        error.message,
      ) &&
      // no version of its own to fall behind package.json's
      !/\d+\.\d+\.\d+|optional/.test(error.message),
  );
});
