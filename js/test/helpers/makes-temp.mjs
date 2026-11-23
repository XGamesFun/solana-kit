// A test file for js/test/run.test.mjs to run through the suite's starter: it makes a temp folder and removes nothing,
// as most test files do, and so does a process it starts. It prints both paths (`temp <path>`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const make = `console.log(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'xsolana-made-')))`;

test('a temp folder is made here and by a process started here, and none is removed', () => {
  console.log(`temp ${mkdtempSync(path.join(tmpdir(), 'xsolana-made-'))}`);
  console.log(`temp ${execFileSync(process.execPath, ['-e', make], { encoding: 'utf8' }).trim()}`);
});
