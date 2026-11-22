// Limits per person and tickets a grant gives, through js/play against the real program: the project's issuer (here the
// grant's own voucher key, one key on the server) links a wallet to a person; a daily login bonus is one claim that
// links the wallet and puts a free ticket in the lottery's round; the lottery limits each person's tickets in a round,
// whichever of their wallets buys; a wallet with no link is refused.
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
import { approvalChain, cannotRun, world } from './helpers/world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;

const asWallet = kp => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-029-')), 'xsolana.json');
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
  'a login bonus links the wallet and gives a free ticket; a lottery limits each person, whichever wallet buys',
  { skip },
  async () => {
    const w = world({ project: false, seed: 'persons-029' });
    w.chain.warp(NOW);
    const [owner, alice, bob, carol] = [freshKeypair(), freshKeypair(), freshKeypair(), freshKeypair()];
    for (const k of [owner, alice, bob, carol]) w.chain.airdrop(k.address, 100_000_000_000n);
    const server = await newKey();
    const spec = specFor(server.address);
    const checked = check(spec);
    assert.deepEqual(checked.refusals, [], 'the spec checks');
    const live = await goLive(w, owner, spec);
    const project = live.live.project;
    assert.equal(w.read('Project', project).issuer, server.address, 'going live names the issuer');
    const now = () => w.chain.now();
    const app = k => solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(k), now });
    const grantId = live.grants.find(g => g.key === 'login').id;
    const { incarnation } = w.read('Grant', loot.pda.grant(project, grantId));
    const person = toHex(sha256(new TextEncoder().encode('x:12345')));
    const voucher = k =>
      signVoucher({
        signer: server,
        game: project,
        grant: grantId,
        incarnation,
        wallet: k.address,
        round: newRound(),
        now: now(),
        personHash: person,
      });

    // The login bonus: one claim links Alice's wallet to the person and puts a free ticket in the round.
    await app(alice).claimGrant('login', { voucher: await voucher(alice) });
    assert.equal(toHex(Uint8Array.from(w.read('Link', loot.pda.link(project, alice.address)).person)), person);
    const lottery = loot.pda.lottery(project, live.lotteries[0].id);
    const l = w.read('Lottery', lottery);
    const round = loot.pda.round(lottery, l.incarnation, l.round);
    assert.equal(w.read('LotteryRound', round).sold, 1n, 'the free ticket is in the round');
    // Once a day a person: the same person again today is held back.
    await assert.rejects(app(alice).claimGrant('login', { voucher: await voucher(alice) }), /OverWindow/);

    // Bob is the same person: the server's link voucher rides with his first purchase. Three tickets a person a round.
    const b = app(bob);
    b.link(await signLink({ signer: server, game: project, wallet: bob.address, person, now: now() }));
    const listing = async a => (await a.lotteries()).find(x => x.key === 'draw');
    await b.buyTickets('draw', 2, { listing: await listing(b) });
    assert.equal(toHex(Uint8Array.from(w.read('Link', loot.pda.link(project, bob.address)).person)), person);
    const a = app(alice);
    await assert.rejects(a.buyTickets('draw', 2, { listing: await listing(a) }), /OverWindow/);
    await a.buyTickets('draw', 1, { listing: await listing(a) });
    // A wallet linked to nobody can't buy where the limit counts persons.
    const c = app(carol);
    await assert.rejects(c.buyTickets('draw', 1, { listing: await listing(c) }), /linked to none/);
  },
);

test('the checker asks for an issuer where a limit counts persons, and for one way of counting', () => {
  const spec = specFor(freshKeypair().address);
  delete spec.keys;
  const noIssuer = check(spec);
  assert.ok(
    noIssuer.refusals.some(e => /issuer/.test(e.message)),
    'a limit per person needs keys.issuer',
  );
  const both = specFor(freshKeypair().address);
  both.lotteries[0].perWallet = 5;
  assert.ok(check(both).refusals.some(e => /per wallet and one per person/.test(e.message)));
  const ticketElsewhere = specFor(freshKeypair().address);
  ticketElsewhere.lotteries.push({
    key: 'other',
    name: 'Other',
    pot: 1,
    price: 0.001,
    every: '1d',
    places: [{ percent: 100, prize: { gives: 'ticket', lottery: 'draw' } }],
  });
  assert.ok(check(ticketElsewhere).refusals.some(e => /only a grant gives tickets/.test(e.message)));
});
