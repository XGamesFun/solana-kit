#!/usr/bin/env node
// The programs the client's LiteSVM tests run, downloaded from the Solana clusters and checked against the hashes in
// js/test/fixtures/pinned.txt. Read-only RPC (getAccountInfo): nothing is signed or sent, so reading mainnet here is
// not going live there. Node only, no Solana CLI, no dependencies.
//
//   node scripts/fetch-fixtures.mjs           downloads every pinned program that is missing or differs here, and
//                                             keeps it only if its sha256 is the pinned one. Needed once before
//                                             `npm test` (and again when a pin changes).
//   node scripts/fetch-fixtures.mjs --check   checks every pinned file here against its hash. No network.
//
// Mainnet rows are read from public mainnet. Devnet rows are read from XSOLANA_RPC_URL, else public devnet; the URL is
// never printed (it may carry a key), and a mainnet URL there is refused. Public RPCs rate-limit: a 429 is retried
// with a growing wait. Account rows (the oracle's queue) and `local` rows (the test hook) are committed: an account is
// downloaded only when missing, and a cluster's account seldom keeps its pinned hash for long, so `git checkout` it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBase58 } from '../js/chain/base58.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'js/test/fixtures');
const shown = (file) => `js/test/fixtures/${file}`;

const mode = process.argv[2] ?? 'fetch';
if (!['fetch', '--check'].includes(mode) || process.argv.length > 3) {
  console.error('usage: node scripts/fetch-fixtures.mjs [--check]');
  process.exit(2);
}

const devnet = process.env.XSOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (/mainnet/i.test(devnet)) {
  console.error('XSOLANA_RPC_URL names mainnet: refusing it for devnet rows (devnet only)');
  process.exit(1);
}
const RPC = { mainnet: 'https://api.mainnet-beta.solana.com', devnet };
/** The upgradeable loader's ProgramData header: a 4-byte tag, the 8-byte slot, then an optional 32-byte authority. */
const PROGRAM_DATA_HEADER = 45;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The rows of pinned.txt: { file, address, cluster, loader, sha256, bytes }. */
function rows() {
  return readFileSync(path.join(dir, 'pinned.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => {
      const [file, address, cluster, loader, sha, bytes] = l.trim().split(/\s+/);
      return { file, address, cluster, loader, sha256: sha, bytes: Number(bytes) };
    });
}

/** One JSON-RPC call; a 429 or a 5xx or a dropped connection is retried with a growing wait. Returns the raw text. */
async function call(cluster, method, params) {
  const url = RPC[cluster];
  if (!url) throw new Error(`no RPC for cluster ${cluster}`);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let attempt = 0, wait = 1000; ; attempt++, wait *= 2) {
    let retry;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (res.ok) {
        const text = await res.text();
        const error = JSON.parse(text).error;
        if (error) throw Object.assign(new Error(`${cluster} ${method}: ${error.message}`), { final: true });
        return text;
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`${cluster} ${method}: HTTP ${res.status}`), { final: true });
      retry = `HTTP ${res.status}`;
      const after = Number(res.headers.get('retry-after'));
      if (after > 0) wait = Math.max(wait, after * 1000);
    } catch (e) {
      if (e.final) throw e;
      retry = e.message;
    }
    if (attempt >= 6) throw new Error(`${cluster} ${method}: ${retry}, still after ${attempt + 1} tries`);
    console.error(`  ${cluster}: ${retry}, trying again in ${Math.round(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** An account's base64 data, owner and the raw response text, or a plain error when it does not exist. */
async function account(cluster, address) {
  const text = await call(cluster, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  const value = JSON.parse(text).result?.value;
  if (!value) throw new Error(`${address} does not exist on ${cluster}`);
  return { value, data: Buffer.from(value.data[0], 'base64'), text };
}

/** The bytes a pinned row's file should hold, read from its cluster. */
async function download({ address, cluster, loader, bytes }) {
  if (loader === 'v2') return (await account(cluster, address)).data; // BPFLoader2: the account's data is the ELF
  if (loader === 'upgradeable') {
    // The program account holds a 4-byte tag and its ProgramData's address; the ELF follows ProgramData's header, padded
    // to the space it was given, so take the pinned length.
    const program = (await account(cluster, address)).data;
    if (program.length < 36 || program.readUInt32LE(0) !== 2) throw new Error(`${address} on ${cluster} is not an upgradeable program`);
    const data = (await account(cluster, encodeBase58(program.subarray(4, 36)))).data;
    return data.subarray(PROGRAM_DATA_HEADER, PROGRAM_DATA_HEADER + bytes);
  }
  if (loader === 'account') {
    // As `solana account --output json-compact` writes it, which is what the tests read. rentEpoch is a u64 that a JS
    // number can't hold, so it is copied from the response's text.
    const { value, text } = await account(cluster, address);
    const rentEpoch = /"rentEpoch":(\d+)/.exec(text)?.[1] ?? '0';
    const json = `{"account":{"data":${JSON.stringify(value.data)},"executable":${value.executable},"lamports":${value.lamports},"owner":${JSON.stringify(value.owner)},"rentEpoch":${rentEpoch},"space":${value.space}},"pubkey":${JSON.stringify(address)}}\n`;
    return Buffer.from(json);
  }
  throw new Error(`${address} has loader ${loader}: it is not read from a cluster`);
}

/** Problems with the loot.so row against release.json, which pins the build this client is for. */
function releaseMismatch(all) {
  const row = all.find((r) => r.file === 'loot.so');
  const release = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'));
  if (!row) return 'pinned.txt has no loot.so row';
  if (row.address !== release.programId || row.sha256 !== release.sbfSha256 || row.bytes !== release.sbfBytes) {
    return `pinned.txt's loot.so row (${row.address}, sha256 ${row.sha256}, ${row.bytes} bytes) is not release.json's build (${release.programId}, sha256 ${release.sbfSha256}, ${release.sbfBytes} bytes): update the row`;
  }
  return null;
}

const all = rows();
let bad = 0;
const mismatch = releaseMismatch(all);
if (mismatch) {
  console.error(mismatch);
  bad++;
}
for (const row of all) {
  const at = path.join(dir, row.file);
  const have = existsSync(at) ? sha256(readFileSync(at)) : null;
  if (have === row.sha256) continue;
  const what = have ? `sha256 ${have}, pinned ${row.sha256}` : 'missing';
  if (mode === '--check' || row.loader === 'local' || (row.loader === 'account' && have)) {
    const hint = row.loader === 'local' || row.loader === 'account' ? ` (committed: git checkout -- ${shown(row.file)})` : '';
    console.error(`${shown(row.file)}: ${what}${hint}`);
    bad++;
    continue;
  }
  console.error(`${shown(row.file)}: ${what}; reading ${row.address} from ${row.cluster}`);
  let bytes;
  try {
    bytes = await download(row);
  } catch (e) {
    console.error(`  could not read it: ${e.message}`);
    bad++;
    continue;
  }
  mkdirSync(path.dirname(at), { recursive: true });
  const got = sha256(bytes);
  if (got === row.sha256 && bytes.length === row.bytes) {
    writeFileSync(`${at}.download`, bytes);
    renameSync(`${at}.download`, at);
    continue;
  }
  writeFileSync(`${at}.download`, bytes);
  console.error(`  ${row.cluster} now has another ${row.loader === 'account' ? 'state of this account' : 'build of this program'} (sha256 ${got}, ${bytes.length} bytes; pinned ${row.sha256}, ${row.bytes} bytes).`);
  console.error(`  Kept as ${shown(row.file)}.download. To test against it, pin it in pinned.txt and rerun every suite.`);
  if (row.loader === 'account') console.error(`  The pinned one is committed: git checkout -- ${shown(row.file)}`);
  bad++;
}
if (bad) {
  if (mode === '--check') console.error('run `npm run fixtures` (node scripts/fetch-fixtures.mjs) to download the pinned programs');
  process.exit(1);
}
// A stale download from an earlier run is no longer needed once its file matches.
for (const row of all) rmSync(path.join(dir, `${row.file}.download`), { force: true });
console.log(mode === '--check' ? 'every pinned fixture matches js/test/fixtures/pinned.txt' : 'the fixtures in js/test/fixtures match pinned.txt');
