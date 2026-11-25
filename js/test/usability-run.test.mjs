// What a new developer reads from the commands about a plain shop and box, held to one answer: a box's roll costs one
// wallet prompt (and, the first time a session opens one, a message to sign), never a "collect wins" approval; a
// warning or a cheat fires only where the spec has what it is about; the late-oracle refund is in review's table.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../../', import.meta.url).pathname;
const SHOP = {
  version: 2,
  network: 'devnet',
  name: 'Potion Shop',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  treasury: 'wallet:HNrmEKgvsam9eynhm1wTGuVfCtJbKmp11TnWWxyuJEks',
  items: [
    { key: 'potion', name: 'Potion', price: 0.01 },
    { key: 'rare-sword', name: 'Rare Sword', value: 0.5 },
  ],
  boxes: [
    {
      key: 'crate',
      name: 'Loot Box',
      price: 0.05,
      outcomes: [
        { gives: 'item', item: 'rare-sword', chance: 5 },
        { gives: 'item', item: 'potion', chance: 95 },
      ],
    },
  ],
};

const run = (args, spec = SHOP) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-ux-'));
  writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(spec));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/xsolana.mjs'), ...args, 'xsolana.json'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\s*\n\s*/g, ' ');
};

test('a box costs one prompt everywhere, and a shop with no lottery is told of no wins to collect', () => {
  const check = run(['check', '--verbose']);
  assert.doesNotMatch(check, /collect wins/);
  assert.doesNotMatch(check, /claimAll/);
  assert.match(check, /about 2 wallet approvals, plus one message to sign the first time a session opens a box/);
  const explain = run(['explain']);
  assert.match(explain, /“Loot Box”: 1 wallet prompt, and the first open of a session also asks the wallet to sign/);
});

test('one item through two routes is a warning only when a limit, a list or a supply makes it one', () => {
  assert.doesNotMatch(run(['check', '--verbose']), /reaches players through/);
  const limited = {
    ...SHOP,
    grants: [
      {
        key: 'daily',
        name: 'Daily potion',
        prize: { gives: 'item', item: 'potion' },
        keys: ['H6kDt47WNDdMLainm7bbMkGt5TmzvGszi2uzxub8DYgT'],
        limits: { perWallet: 3 },
        fund: 0.01,
      },
    ],
  };
  const said = run(['check', '--verbose'], limited);
  assert.match(said, /reaches players through .*each route's limits count on their own/);
  assert.doesNotMatch(said, /early list/);
});

test("review's table says the late-oracle refund, and no bots for stock that can't run out", () => {
  const review = run(['review', '--verbose']);
  assert.match(review, /a buyer who sees a poor answer coming more than 10 minutes late can take the refund instead/);
  assert.doesNotMatch(review, /bots can buy limited stock/);
});

test('cost gives the going-live total at mainnet’s fees too', () => {
  assert.match(
    run(['cost']),
    /^Going live: \d+ transactions?, about [\d.]+ SOL in all(, the same on mainnet| \(about [\d.]+ SOL on mainnet\)):/,
  );
});
