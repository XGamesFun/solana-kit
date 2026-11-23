#!/usr/bin/env node
// How the suite starts (`npm test`, and `npm run test:mainnet` through scripts/test-mainnet.mjs): `node --test` over
// every test file, or over the files named. Arguments go to `node --test` (a test file, --test-name-pattern=…).
//
// Two things hold for a run started here:
//
// - It leaves no temp folder behind. Every folder a test makes, and every one made by a command a test starts, goes in
//   one folder of this run's own (it is those processes' temp folder: `os.tmpdir()`), removed when the run ends.
// - It says so when the chain tests can't run. Those tests skip themselves (`cannotRun`: no fixtures, a LiteSVM that
//   does not load), so a run without them would pass with nearly half the suite skipped. Here it stops before any test,
//   once, with why and the command that fixes it. XSOLANA_SKIP_CHAIN_TESTS=1 runs the rest without them, on purpose.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cannotRun } from './helpers/world.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVERY_TEST = 'js/test/**/*.test.mjs';
const SKIP = 'XSOLANA_SKIP_CHAIN_TESTS';

const why = cannotRun()?.replace(/\.$/, '');
if (why && !process.env[SKIP]) {
  console.error(
    `The tests that run the real program can’t run here: ${why}.\nNo test was run. To run the others without them, on purpose, set ${SKIP}=1 (CONTRIBUTING.md).`,
  );
  process.exit(1);
}
if (why) console.error(`${SKIP} is set: the tests that run the real program are skipped (${why}).`);

const temp = mkdtempSync(path.join(tmpdir(), 'xsolana-test-'));
process.on('exit', () => {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`The run's temp folder ${temp} could not be removed: ${error.message}`);
  }
});

// Flags first, as node reads them, then the test files named, or every test file when none is: flags alone (a name
// pattern, a reporter) are about the whole suite.
const given = process.argv.slice(2);
const flags = given.filter(arg => arg.startsWith('-'));
const named = given.filter(arg => !arg.startsWith('-'));
const run = spawn(process.execPath, ['--test', ...flags, ...(named.length ? named : [EVERY_TEST])], {
  cwd: root,
  stdio: 'inherit',
  // os.tmpdir() reads the first of these that is set (TEMP and TMP on Windows).
  env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
});
// A signal to stop goes on to the tests, and this process ends when they have: the temp folder is removed either way.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => run.kill(signal));
run.on('exit', code => process.exit(code ?? 1));
