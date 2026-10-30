#!/usr/bin/env node
// Binds the program build, the IDL and the browser-safe client into one release manifest (release.json).
//
//   node scripts/release-manifest.mjs           writes release.json from the program binary: a local build's
//                                               target/deploy/loot.so in XSOLANA_PROGRAM_DIR, else js/test/fixtures/loot.so
//   node scripts/release-manifest.mjs --check   checks release.json against this checkout: the version, the IDL and
//                                               the client always; the program binary only when one is there (it
//                                               says so when it is not)
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function files(dir, base = root) {
  const entries = await readdir(path.join(base, dir), { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(`${dir}/${entry.name}`, base) : [`${dir}/${entry.name}`]))).flat();
}
const client = createHash('sha256');
for (const name of [...await files('js/client'), ...await files('js/chain')].sort()) {
  client.update(name).update('\0').update(await readFile(path.join(root, name)));
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const idlBytes = await readFile(path.join(root, 'js/client/idl/loot.json'));
const idl = JSON.parse(idlBytes);
const sbfFile = process.env.XSOLANA_PROGRAM_DIR
  ? path.resolve(process.env.XSOLANA_PROGRAM_DIR, 'target/deploy/loot.so')
  : path.join(root, 'js/test/fixtures/loot.so');
const checking = process.argv.includes('--check');
const target = path.join(root, 'release.json');
if (pkg.version !== idl.metadata.version) throw new Error('Package and IDL versions differ. Rebuild and sync the IDL.');
const held = { version: pkg.version, programId: idl.address, idlSha256: sha(idlBytes), clientSha256: client.digest('hex') };

if (checking) {
  const release = JSON.parse(await readFile(target, 'utf8'));
  const differ = Object.keys(held).filter((k) => release[k] !== held[k]);
  if (differ.length) throw new Error(`release.json does not match this checkout (${differ.join(', ')}). Rebuild, test, then regenerate release.json.`);
  if (existsSync(sbfFile)) {
    const sbf = await readFile(sbfFile);
    if (release.sbfBytes !== sbf.length || release.sbfSha256 !== sha(sbf)) throw new Error(`release.json does not match the program build at ${sbfFile}. Rebuild, test, then regenerate release.json.`);
    console.log(`Verified loot ${held.version} release: version, IDL, client and program build.`);
  } else {
    console.log(`Verified loot ${held.version} release: version, IDL and client. The program build was not checked: there is none at ${sbfFile}.`);
  }
} else {
  if (!existsSync(sbfFile)) throw new Error(`No program build at ${sbfFile}: release.json binds one. Run npm run fixtures, or set XSOLANA_PROGRAM_DIR to a program build, then run this again.`);
  const sbf = await readFile(sbfFile);
  const manifest = { version: held.version, programId: held.programId, sbfBytes: sbf.length, sbfSha256: sha(sbf), idlSha256: held.idlSha256, clientSha256: held.clientSha256 };
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote loot ${manifest.version} release manifest (${manifest.sbfBytes} program bytes).`);
}
