import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64, toHex } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { sha256 } from '../chain/sha256.js';
import { solanaApp } from '../play/index.js';
import { newKey, newRound, signLink, signVoucher } from '../results/index.js';
import { approvalChain, asWallet, cannotRun, world } from './helpers/world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;
async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-r029-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 8 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map(b64 => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
const specFor = server => ({
  version: 2,
  network: 'devnet',
  name: 'Daily Draw',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: false,
  keys: { issuer: server },
  lotteries: [{ key: 'draw', name: 'The Draw', pot: 0, price: 0.001, every: '1d', perPerson: 3 }],
  grants: [
    {
      key: 'login',
      name: 'Login bonus',
      prize: { gives: 'ticket', lottery: 'draw' },
      vouchers: [server],
      limits: { perPersonEach: { count: 1, every: '1d' } },
    },
  ],
});

test(
  'a link voucher outlives a step that fails; a linked wallet claims with a voucher naming no person',
  { skip },
  async () => {
    const w = world({ project: false, seed: 'review-029-a' });
    w.chain.warp(NOW);
    const [owner, alice, bob] = [freshKeypair(), freshKeypair(), freshKeypair()];
    for (const k of [owner, alice, bob]) w.chain.airdrop(k.address, 100_000_000_000n);
    const server = await newKey();
    const spec = specFor(server.address);
    assert.deepEqual(check(spec).refusals, []);
    const live = await goLive(w, owner, spec);
    const project = live.live.project;
    const now = () => w.chain.now();
    const app = k => solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(k), now });
    const grantId = live.grants.find(g => g.key === 'login').id;
    const { incarnation } = w.read('Grant', loot.pda.grant(project, grantId));
    const person = toHex(sha256(new TextEncoder().encode('x:1')));
    const listing = async a => (await a.lotteries()).find(x => x.key === 'draw');

    // Bob is given a link voucher; his first purchase fails on chain (4 > 3 a person). The voucher stays, and his next
    // purchase links him with it.
    const b = app(bob);
    b.link(await signLink({ signer: server, game: project, wallet: bob.address, person, now: now() }));
    await assert.rejects(b.buyTickets('draw', 4, { listing: await listing(b) }), /Over/);
    await b.buyTickets('draw', 1, { listing: await listing(b) });
    assert.ok(w.read('Link', loot.pda.link(project, bob.address)), 'Bob is linked');
    // A voucher for another wallet, or one that has run out, is refused at once.
    assert.throws(
      () =>
        b.link({
          wallet: alice.address,
          person,
          expires: now() + 60,
          publicKey: server.address,
          signature: new Uint8Array(64),
        }),
      /not this wallet/,
    );
    assert.throws(
      () =>
        b.link({
          wallet: bob.address,
          person,
          expires: now() - 1,
          publicKey: server.address,
          signature: new Uint8Array(64),
        }),
      /expired/,
    );

    // A: Alice gets linked by a link voucher, then claims with a voucher of the issuer naming no person.
    const a = app(alice);
    a.link(await signLink({ signer: server, game: project, wallet: alice.address, person, now: now() }));
    await a.buyTickets('draw', 1, { listing: await listing(a) });
    assert.ok(w.read('Link', loot.pda.link(project, alice.address)), 'alice is linked');
    // A voucher naming no person (zeros): the claim counts the wallet's link.
    const v = await signVoucher({
      signer: server,
      game: project,
      grant: grantId,
      incarnation,
      wallet: alice.address,
      round: newRound(),
      now: now(),
    });
    await app(alice).claimGrant('login', { voucher: v });
  },
);

test('a voucher with no person hash at all claims by the link too', { skip }, async () => {
  const w = world({ project: false, seed: 'review-029-a2' });
  w.chain.warp(NOW);
  const [owner, alice] = [freshKeypair(), freshKeypair()];
  for (const k of [owner, alice]) w.chain.airdrop(k.address, 100_000_000_000n);
  const server = await newKey();
  const live = await goLive(w, owner, specFor(server.address));
  const project = live.live.project;
  const now = () => w.chain.now();
  const app = k => solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(k), now });
  const grantId = live.grants.find(g => g.key === 'login').id;
  const { incarnation } = w.read('Grant', loot.pda.grant(project, grantId));
  const person = toHex(sha256(new TextEncoder().encode('x:1')));
  const a = app(alice);
  a.link(await signLink({ signer: server, game: project, wallet: alice.address, person, now: now() }));
  await a.buyTickets('draw', 1, { listing: (await a.lotteries()).find(x => x.key === 'draw') });
  const v = await signVoucher({
    signer: server,
    game: project,
    grant: grantId,
    incarnation,
    wallet: alice.address,
    round: newRound(),
    now: now(),
  });
  delete v.personHash;
  await app(alice).claimGrant('login', { voucher: v });
});

test('a token cap on a grant that gives no tokens is refused by the checker', { skip }, async () => {
  const w = world({ project: false, seed: 'review-029-c' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const server = await newKey();
  const spec = specFor(server.address);
  spec.grants[0].limits.tokens = 5;
  assert.ok(check(spec).refusals.some(r => r.code === 'E-GRANT' && /counts tokens only/.test(r.message)));
  const _ = [w, owner];
});
