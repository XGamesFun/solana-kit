// The README and docs/ are read on npm as well as on GitHub: every relative link in them leads to a file (or a
// folder) the package ships, so it works in the tarball as it does in the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('every relative link of the README and docs/ is to a file the package ships', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const [packed] = JSON.parse(
    execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }),
  );
  const files = new Set(packed.files.map(f => f.path));
  const shipped = target => files.has(target) || [...files].some(f => f.startsWith(`${target}/`));
  for (const doc of ['README.md', ...readdirSync(path.join(root, 'docs')).map(f => `docs/${f}`)]) {
    assert.ok(shipped(doc), `${doc} is not in the package`);
    const text = readFileSync(path.join(root, doc), 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:|^#/.test(link)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(doc), link.split('#')[0]));
      assert.ok(existsSync(path.join(root, target)), `${doc} links to ${link}, which is not in the repository`);
      assert.ok(shipped(target), `${doc} links to ${link}, which the package does not ship`);
    }
  }
});
