#!/usr/bin/env node
// Runs the whole test suite on loot's mainnet address (`npm run test:mainnet`): every test process works on mainnet
// (XSOLANA_CLUSTER) and loads js/test/on-mainnet.mjs first, which has the suite's economies read as mainnet's. The
// program is the pinned build mainnet runs (js/test/fixtures/loot_mainnet.so), or a checkout's own
// (XSOLANA_PROGRAM_DIR: its target/mainnet/loot.so). Arguments are passed to `node --test` (a test file,
// --test-name-pattern).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = pathToFileURL(path.join(root, 'js/test/on-mainnet.mjs')).href;
const given = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', ...(given.length ? given : ['js/test/**/*.test.mjs'])], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    XSOLANA_CLUSTER: 'mainnet',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim(),
  },
});
process.exit(r.status ?? 1);
