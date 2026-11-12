// The review: an economy read the way a cheater reads it. Each finding fires where it should and stays quiet where it
// shouldn't; a grant's `trust` is checked, said in words, and changes nothing that goes live.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { changedParts } from '../economy/live.mjs';
import { plan } from '../economy/plan.mjs';
import { review, SEVERITIES } from '../economy/review.mjs';
import { runTool } from '../mcp/server.mjs';

const NOW = 1_790_000_000;
const spec = name => JSON.parse(readFileSync(new URL(`./specs/${name}.json`, import.meta.url), 'utf8'));
const edit = (s, fn) => {
  const copy = structuredClone(s);
  fn(copy);
  return copy;
};
const ids = (r, severity) =>
  r.findings.filter(f => !severity || f.severity === severity).map(f => `${f.id} ${f.route}`);
const VOUCHER = '9u6NVoFvsdCaMe2uw4n6wUSzQSh13qAuRGcjwoT5EiqL';
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

test('a bounded claim whose NFT earns minted tokens in a farm with no end is high', () => {
  const r = review(spec('review-bounds'), { now: NOW });
  assert.equal(r.ok, false);
  const high = ids(r, 'high');
  for (const g of ['found-bronze', 'found-silver', 'found-gold'])
    assert.ok(high.includes(`R-CLAIM-COMPOUNDS grant:${g}`), high.join());
  // (the farm minting with no end: the net flow of what it mints)
  assert.ok(ids(r).includes('R-VALUE token:shard'));
  // The shape another package reads.
  for (const route of r.routes)
    assert.deepEqual(Object.keys(route), [
      'kind',
      'key',
      'name',
      'trigger',
      'enforced',
      'trusts',
      'trust',
      'ceiling',
      'feeds',
    ]);
  for (const f of r.findings) {
    assert.ok(SEVERITIES.includes(f.severity));
    assert.match(f.id, /^R-[A-Z-]+$/);
    assert.equal(typeof f.message, 'string');
  }
  const gold = r.routes.find(x => x.key === 'found-gold');
  assert.equal(gold.trust, 'bounds');
  assert.deepEqual(gold.feeds, ['farm:vault']);
  assert.match(gold.ceiling, /50 SHARD a day/);
  assert.match(gold.ceiling, /with no end/);
  assert.match(r.tradeoffs, /\| bounds \|/);
  assert.match(r.tradeoffs, /\*\*bounds\*\*/);
});

test('the same economy decided by the server, or with an end and a total, has no high', () => {
  const decided = review(spec('review-decides'), { now: NOW });
  assert.equal(decided.ok, true, ids(decided, 'high').join());
  assert.deepEqual(ids(decided, 'high'), []);
  assert.ok(!ids(decided).some(x => x.startsWith('R-CLAIM-COMPOUNDS') || x.startsWith('R-TRUST-UNSAID')));
  // Bounded, but its farm ends and each grant has a total: medium, not high.
  const bounded = review(
    edit(spec('review-decides'), s => s.grants.forEach(g => (g.trust = 'bounds'))),
    { now: NOW },
  );
  assert.equal(bounded.ok, true);
  assert.ok(ids(bounded, 'medium').includes('R-CLAIM-COMPOUNDS grant:discover-gold'));
  // Decided by the server, the first economy keeps only the farm with no end.
  const first = review(
    edit(spec('review-bounds'), s => s.grants.forEach(g => (g.trust = 'decides'))),
    { now: NOW },
  );
  assert.equal(first.ok, true);
  // (and the net flow of what it mints: no cap on how many NFTs it takes)
  assert.deepEqual(ids(first, 'medium').sort(), ['R-VALUE token:shard']);
});

test('a voucher grant with no trust said is read as bounds, and says so', () => {
  const r = review(
    edit(spec('review-bounds'), s => s.grants.forEach(g => delete g.trust)),
    { now: NOW },
  );
  assert.ok(ids(r, 'medium').includes('R-TRUST-UNSAID grant:found-gold'));
  assert.ok(ids(r, 'high').includes('R-CLAIM-COMPOUNDS grant:found-gold'));
  assert.equal(r.routes.find(x => x.key === 'found-gold').trust, null);
  // A replayed result is one step less serious than a bounded one.
  const replayed = review(
    edit(spec('review-bounds'), s => s.grants.forEach(g => (g.trust = 'replays'))),
    { now: NOW },
  );
  assert.ok(ids(replayed, 'medium').includes('R-CLAIM-COMPOUNDS grant:found-gold'));
  assert.deepEqual(ids(replayed, 'high'), []);
});

test('a voucher grant that counts no person: each free wallet claims again', () => {
  const noPerson = edit(spec('review-decides'), s => s.grants.forEach(g => delete g.limits.perPerson));
  assert.ok(ids(review(noPerson, { now: NOW }), 'medium').includes('R-GRANT-PERSON grant:discover-gold'));
  assert.ok(!ids(review(spec('review-decides'), { now: NOW })).some(x => x.startsWith('R-GRANT-PERSON')));
  // One claim in all: nothing for a second wallet to take.
  const once = edit(noPerson, s => s.grants.forEach(g => (g.limits.total = 1)));
  assert.ok(!ids(review(once, { now: NOW })).some(x => x.startsWith('R-GRANT-PERSON')));
});

const pooled = trust => ({
  version: 2,
  network: 'devnet',
  name: 'Entry fees',
  currency: 'gold',
  tokens: [{ key: 'gold', source: 'project', decimals: 0 }],
  pools: [{ key: 'prizes', currency: 'gold', seed: 100 }],
  payments: [{ key: 'entry', name: 'Entry', amount: 10, split: [{ to: 'pool:prizes', percent: 90 }] }],
  grants: [
    {
      key: 'winner',
      name: 'Winner',
      prize: { gives: 'tokens', amount: 50, from: 'pool:prizes' },
      vouchers: [VOUCHER],
      limits: { perWallet: 1, perPerson: 1, perDay: 10, total: 100 },
      ...(trust ? { trust } : {}),
    },
  ],
});

test('entry fees paid out on a bounded result are high; on a decided one, nothing', () => {
  assert.ok(ids(review(pooled('bounds'), { now: NOW }), 'high').includes('R-STAKES-PAID grant:winner'));
  assert.ok(ids(review(pooled('replays'), { now: NOW }), 'medium').includes('R-STAKES-PAID grant:winner'));
  assert.ok(!ids(review(pooled('decides'), { now: NOW })).some(x => x.startsWith('R-STAKES-PAID')));
  const r = review(pooled('decides'), { now: NOW });
  assert.ok(r.routes.some(x => x.kind === 'payment' && x.key === 'entry'));
});

test('an open grant that pays something anyone can sell is high; gated, medium', () => {
  const open = edit(pooled(null), s => {
    delete s.grants[0].vouchers;
    delete s.grants[0].limits.perPerson;
  });
  const r = review(open, { now: NOW });
  assert.ok(ids(r, 'high').includes('R-GRANT-OPEN grant:winner'), ids(r).join());
  assert.equal(r.ok, false);
  const gated = edit(open, s => {
    s.collection = { name: 'Passes' };
    s.items = [{ key: 'pass', name: 'Pass', price: 5 }];
    s.grants[0].gate = { item: 'pass' };
  });
  const g = review(gated, { now: NOW });
  assert.ok(ids(g, 'medium').includes('R-GRANT-OPEN grant:winner'), ids(g).join());
  assert.deepEqual(ids(g, 'high'), []);
});

test('the authority and every voucher key are named plainly', () => {
  const r = review(spec('review-bounds'), { now: NOW });
  const authority = r.findings.find(f => f.id === 'R-AUTHORITY');
  assert.equal(authority.route, 'economy');
  assert.match(authority.message, /owner’s wallet alone changes every price, rate, grant/);
  const key = r.findings.find(f => f.id === 'R-VOUCHER-KEY');
  assert.match(key.message, new RegExp(VOUCHER));
  assert.match(key.fix, /never in a page/);
});

test('"trust" is checked: only on a grant a voucher key or a code signs for', () => {
  assert.equal(check(spec('review-bounds'), { now: NOW }).ok, true);
  const bad = check(
    edit(spec('review-bounds'), s => (s.grants[0].trust = 'trusted')),
    { now: NOW },
  );
  assert.ok(bad.refusals.some(x => x.code === 'E-SCHEMA' && x.where === 'economy.grants[0].trust'));
  const open = check(
    edit(pooled('decides'), s => delete s.grants[0].vouchers),
    { now: NOW },
  );
  assert.ok(open.refusals.some(x => x.code === 'E-GRANT-TRUST' && x.where === 'economy.grants.winner.trust'));
  const listed = check(
    edit(pooled('bounds'), s => {
      delete s.grants[0].vouchers;
      s.grants[0].list = [VOUCHER];
    }),
    { now: NOW },
  );
  assert.ok(listed.refusals.some(x => x.code === 'E-GRANT-TRUST'));
});

test('"trust" changes nothing that goes live, and a live spec that adds it publishes nothing', () => {
  const withTrust = spec('review-bounds');
  const without = edit(withTrust, s => s.grants.forEach(g => delete g.trust));
  const sent = s => {
    const p = plan(s, { now: NOW });
    assert.ok(p.ok);
    return json({ steps: p.steps, transactions: p.transactions, approvals: p.approvals });
  };
  assert.equal(sent(withTrust), sent(without));
  const live = edit(without, s => (s.live = { project: VOUCHER, published: structuredClone(without) }));
  const after = edit(live, s => s.grants.forEach(g => (g.trust = 'decides')));
  assert.equal(changedParts(after).only.size, 0);
});

test('explain says what each voucher server checks', () => {
  const text = explainEconomy(spec('review-bounds'), { now: NOW }).text;
  assert.match(text, /What its server checks: the page runs the game and reports the result/);
  const unsaid = explainEconomy(
    edit(spec('review-bounds'), s => s.grants.forEach(g => delete g.trust)),
    { now: NOW },
  ).text;
  assert.match(unsaid, /is not said \("trust"\)/);
});

test('xsolana_review answers the review; the command exits 1 on a high finding', async () => {
  const r = await runTool('xsolana_review', { spec: spec('review-bounds') }, { now: NOW });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.routes) && Array.isArray(r.findings));
  // The trade-offs are said once, in the text.
  assert.ok(!('tradeoffs' in r));
  assert.match(r.text, /Trade-offs to show the person/);
  assert.match(r.text, /Before you call it ready:\n- List what your replies promised the person/);
  assert.match(r.text, /high finding/);
  const fine = await runTool('xsolana_review', { spec: spec('review-decides') }, { now: NOW });
  assert.equal(fine.ok, true);
  const bad = await runTool('xsolana_review', { spec: { version: 2 } }, { now: NOW });
  assert.equal(bad.ok, false);
  assert.ok(bad.refusals.length);

  const bin = fileURLToPath(new URL('../../bin/xsolana.mjs', import.meta.url));
  const cwd = mkdtempSync(path.join(tmpdir(), 'xsolana-review-'));
  writeFileSync(path.join(cwd, 'high.json'), JSON.stringify(spec('review-bounds')));
  writeFileSync(path.join(cwd, 'fine.json'), JSON.stringify(spec('review-decides')));
  const high = spawnSync(process.execPath, [bin, 'review', 'high.json'], { cwd, encoding: 'utf8' });
  assert.equal(high.status, 1);
  assert.match(high.stdout, /R-CLAIM-COMPOUNDS/);
  const ok = spawnSync(process.execPath, [bin, 'review', 'fine.json', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
});
