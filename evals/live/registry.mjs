// A local npm registry for the evals: it serves this checkout's @xgamesfun/solana (packed with `npm pack`) under its
// real name and redirects every other package to registry.npmjs.org, so a fresh agent installs and runs
// `@xgamesfun/solana` exactly as it would once the package is published.
//
// `kitDir` packs another checkout of this kit instead (another checkout with a newer js/play). `extra` serves more packages the
// same way, each packed from its folder with its `file:` dependencies turned into the versions served here (the// results server, which depends on the kit checkout beside it).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UPSTREAM = 'https://registry.npmjs.org';

/** Packs `from` into `dir`; with `versions`, a copy whose `file:` dependencies name those versions. → package entry */
function pack(from, dir, versions = {}) {
  let at = from;
  let scratch = null;
  const pkg = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'));
  const deps = Object.entries(pkg.dependencies ?? {});
  if (deps.some(([, v]) => String(v).startsWith('file:'))) {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'xsolana-eval-pack-'));
    for (const f of [...(pkg.files ?? []), 'package.json', 'README.md', 'LICENSE']) if (existsSync(path.join(from, f))) cpSync(path.join(from, f), path.join(scratch, f), { recursive: true });
    pkg.dependencies = Object.fromEntries(deps.map(([n, v]) => [n, String(v).startsWith('file:') ? versions[n] ?? v : v]));
    delete pkg.private;
    writeFileSync(path.join(scratch, 'package.json'), JSON.stringify(pkg, null, 2));
    at = scratch;
  }
  // Without the prepack release check: it checks the program's binary, which the agents never use
  // (they reach the program on devnet), and an eval packs the checkout to test it, not to release it.
  const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: at, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  const [{ filename }] = JSON.parse(out.slice(out.indexOf('[')));
  const tarball = readFileSync(path.join(dir, filename));
  const readme = existsSync(path.join(from, 'README.md')) ? readFileSync(path.join(from, 'README.md'), 'utf8') : '';
  return { pkg, readme, filename, tarball, shasum: createHash('sha1').update(tarball).digest('hex'), integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` };
}

/** Packs the checkout (and `extra` folders) into `dir` and serves them. → { url, tarball, close() } */
export async function startRegistry(dir, { kitDir = ROOT, extra = [] } = {}) {
  const loot = pack(kitDir, dir);
  const served = [loot, ...extra.map((from) => pack(from, dir, { [loot.pkg.name]: loot.pkg.version }))];
  let base = '';
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    for (const p of served) {
      const { name, version } = p.pkg;
      if (url === `/${name}` || url === `/${name.replace('/', '%2f')}`) {
        const manifest = { ...p.pkg, readme: p.readme, _id: `${name}@${version}`, dist: { tarball: `${base}/-/${p.filename}`, shasum: p.shasum, integrity: p.integrity } };
        delete manifest.devDependencies;
        delete manifest.scripts;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ name, readme: p.readme, 'dist-tags': { latest: version }, versions: { [version]: manifest } }));
      }
      if (url === `/-/${p.filename}`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': p.tarball.length });
        return res.end(p.tarball);
      }
    }
    res.writeHead(302, { location: `${UPSTREAM}${req.url}` });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/`, tarball: path.join(dir, loot.filename), close: () => new Promise((r) => server.close(r)) };
}
