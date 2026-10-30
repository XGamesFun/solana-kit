// Ranked grants, stake gates and lotteries that give tickets back, through js/play on the Stakers' Draw example
// (examples/stakers-draw.json), against the real program: a grant whose voucher names each claim's own amount (rewards
// by rank), a gate that asks for a locked stake, and a lottery that gives every ticket back after the draw.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { decodeBase58 } from '../chain/base58.js';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { associatedTokenAddress, NATIVE_MINT } from '../chain/pda.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { newKey, newRound, signVoucher } from '../results/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const GEM = 1_000_000n;

const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-017-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 8 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A token account's amount (0 with no account). */
const held = async (w, address) => {
  const a = await w.chain.rpc.account(address);
  return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
};

test('Stakers’ Draw: race rewards by rank from one grant, a draw only locked stakers enter, every ticket back after it', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'stakers-draw' });
  w.chain.warp(NOW);
  const [owner, alice, bob, stranger] = [freshKeypair(), freshKeypair(), freshKeypair(), freshKeypair()];
  for (const k of [owner, alice, bob, stranger]) w.chain.airdrop(k.address, 100_000_000_000n);
  // The race's results server: its key is the grant's voucher key.
  const server = await newKey();
  const spec = JSON.parse(readFileSync(new URL('../../examples/stakers-draw.json', import.meta.url), 'utf8'));
  spec.grants[0].vouchers = [server.address];
  const live = await goLive(w, owner, spec);
  const project = live.live.project;
  const now = () => w.chain.now();
  const a = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(alice), now });
  const b = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(bob), now });
  // Anyone finishes a draw: here a stranger, so what comes back lands in each buyer's account untouched.
  const k = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(stranger), now });
  const gem = live.live.mints.gem;
  const gemOf = (k) => held(w, loot.ata(k.address, gem));

  // One grant pays by rank: second place's voucher names 300 GEM, the winner's names none (the grant's 500).
  const grantId = live.grants.find((g) => g.key === 'race').id;
  const { incarnation } = w.read('Grant', loot.pda.grant(project, grantId));
  const voucher = (k, amount, round = newRound()) => signVoucher({ signer: server, game: project, grant: grantId, incarnation, wallet: k.address, round, now: now(), amount });
  await a.claimGrant('race', { voucher: await voucher(alice, 300n * GEM) });
  await b.claimGrant('race', { voucher: await voucher(bob, 0n) });
  assert.equal(await gemOf(alice), 300n * GEM);
  assert.equal(await gemOf(bob), 500n * GEM);
  // More than the grant gives is refused, by the page and by the program (`OverPrize`).
  await assert.rejects(a.claimGrant('race', { voucher: await voucher(alice, 501n * GEM) }), /more than this grant gives/);
  const over = await voucher(alice, 501n * GEM);
  const address = loot.pda.grant(project, grantId);
  const message = loot.voucherBytes({ grant: address, incarnation, wallet: alice.address, round: over.round, expires: over.expires, amount: 501n * GEM });
  const signature = loot.ed25519Ix({ publicKey: server.address, signature: decodeBase58(over.signature), message });
  const claim = loot.claimGrantIx({ project, id: grantId, grant: w.read('Grant', address), wallet: alice.address, signer: alice.address, count: 1, round: over.round, expires: over.expires, amount: 501n * GEM });
  assert.throws(() => w.chain.send(alice.address, [signature, claim], { signers: [alice] }), /OverPrize/);

  // The draw asks for 100 GEM locked in the vault: none yet.
  await assert.rejects(a.buyTickets('draw', 3, { listing: (await a.lotteries()).find((l) => l.key === 'draw') }), /You need at least 100 GEM staked in “The vault”/);
  await a.stake('vault', 150, 0);
  // A stake counts from the second after it is made: staked, used and unstaked in one go never passes.
  await assert.rejects(a.buyTickets('draw', 3, { listing: (await a.lotteries()).find((l) => l.key === 'draw') }), /GateNotMet/);
  await b.stake('vault', 100, 0);
  w.chain.warp(now() + 1);
  await a.buyTickets('draw', 3, { listing: (await a.lotteries()).find((l) => l.key === 'draw') });
  await b.buyTickets('draw', 2, { listing: (await b.lotteries()).find((l) => l.key === 'draw') });
  // The badge asks for the same stake; half its price goes into the draw's pot.
  assert.ok((await a.buy('badge', { listing: (await a.shop()).find((l) => l.key === 'badge') })).asset);

  const lotteryAddress = loot.pda.lottery(project, live.lotteries.find((l) => l.key === 'draw').id);
  const lottery = () => w.read('Lottery', lotteryAddress);
  assert.equal(lottery().returns, true);
  const pot = await held(w, loot.pda.pot(lotteryAddress));
  assert.equal(pot, 100_000_000n + 10_000_000n, 'the seed and half a badge');

  // The draw: every ticket goes back to its buyer, and the two places share the pot.
  const wrapped = (k) => held(w, associatedTokenAddress(k.address, NATIVE_MINT));
  const before = { alice: await wrapped(alice), bob: await wrapped(bob) };
  w.chain.warp(Number(lottery().draws_at));
  await k.claim((await k.claims()).find((c) => c.kind === 'reveal'));
  while (lottery().pending > 0) await k.claim((await k.claims()).find((c) => c.kind === 'complete-draw'));
  const back = { alice: (await wrapped(alice)) - before.alice, bob: (await wrapped(bob)) - before.bob };
  assert.equal(back.alice, 30_000_000n, 'three 0.01 SOL tickets back');
  assert.equal(back.bob, 20_000_000n, 'two 0.01 SOL tickets back');
  for (;;) {
    const c = (await k.claims()).find((x) => x.kind === 'payout');
    if (!c) break;
    await k.claim(c);
  }
  const won = (await wrapped(alice)) + (await wrapped(bob)) - before.alice - before.bob - 50_000_000n;
  assert.ok(won > 0n && won <= pot, `the winners take the pot: ${won}`);
  assert.equal(await held(w, loot.pda.lotteryFunds(lotteryAddress)), 0n, 'no ticket money left behind');

  // A week on, the 7-day lock is over: the stake no longer counts.
  await assert.rejects(a.buy('badge', { listing: (await a.shop()).find((l) => l.key === 'badge') }), /counts only while it is locked/);
});
