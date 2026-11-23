// The lint rule that keeps js/chain, js/client, js/play and js/results running in a browser page as they are
// (eslint.config.mjs) refuses each way Node can come into a module there, and lets through what a page has too.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: root });
/** The rules a module with this code would break, in each of the four folders. */
const broken = async code => {
  const each = [];
  for (const folder of ['js/chain', 'js/client', 'js/play', 'js/results']) {
    const [result] = await eslint.lintText(code, { filePath: path.join(root, folder, 'a-module-of-the-test.js') });
    each.push([...new Set(result.messages.map(m => m.ruleId))].sort().join(' '));
  }
  assert.equal(new Set(each).size, 1, `the four folders are held to one rule: ${each.join(' | ')}`);
  return each[0];
};

test('a browser-safe module is refused each way Node can come in', async () => {
  for (const [code, rule] of [
    ["import fs from 'node:fs';\nexport const a = fs;", 'no-restricted-imports'],
    ["import os from 'os';\nexport const a = os;", 'no-restricted-imports'],
    ["import fs from 'fs/promises';\nexport const a = fs;", 'no-restricted-imports'],
    ["export const a = await import('node:fs');", 'no-restricted-syntax'],
    ["export const a = await import('os');", 'no-restricted-syntax'],
    ['export const a = name => import(name);', 'no-restricted-syntax'],
    ["export const a = Buffer.from('x');", 'no-restricted-globals no-undef'],
    ['export const a = process.env.X;', 'no-restricted-globals no-undef'],
    ["export const a = require('x');", 'no-restricted-globals no-undef'],
    ['export const a = __dirname;', 'no-undef'],
    ['export const a = global;', 'no-undef'],
    ['export const a = setImmediate;', 'no-undef'],
    ['export const a = globalThis.process.env.X;', 'no-restricted-syntax'],
    ["export const a = globalThis.Buffer.from('x');", 'no-restricted-syntax'],
    ['export const a = globalThis.process;', 'no-restricted-syntax'],
  ])
    assert.equal(await broken(code), rule, code);
});

test('a browser-safe module may import its neighbours and read what a page has, or what it asks for with `?.`', async () => {
  for (const code of [
    "import { utf8 } from '../chain/bytes.js';\nexport const a = utf8;",
    "export const a = await import('./bytes.js');",
    'export const a = [globalThis.crypto, fetch, TextEncoder, AbortSignal, atob];',
    'export const a = globalThis.process?.env?.X ?? null;',
  ])
    assert.equal(await broken(code), '', code);
});
