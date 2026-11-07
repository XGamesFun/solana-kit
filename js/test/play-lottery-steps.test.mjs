// A lottery's public steps ride in a player's own transaction: a due round's draw goes in front of the next purchase,
// and a draw that cancels a round (short of its least tickets, or the oracle never answered) pulls the sender's own
// refund right after it. A refund is then two transactions: the ticket, and the cancel that pays it back.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;

const asWallet = (kp) => ({
  address: kp.address,
  prompts: 0,
  async signTransaction(wire) {
    this.prompts++;
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-lottery-steps-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    }));
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function setup(seed, lottery) {
  const w = world({ project: false, seed });
  w.chain.warp(NOW);
  const [owner, player, rival] = [freshKeypair(), freshKeypair(), freshKeypair()];
  for (const k of [owner, player, rival]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, { version: 2, network: 'devnet', name: 'Steps', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], lotteries: [{ key: 'daily', pot: 0, name: 'Daily', price: 0.001, every: '1h', ...lottery }] });
  const [mine, theirs] = [asWallet(player), asWallet(rival)];
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: mine, now: () => w.chain.now() });
  const other = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: theirs, now: () => w.chain.now() });
  const address = loot.pda.lottery(live.live.project, live.lotteries[0].id);
  const lottery_ = () => w.read('Lottery', address);
  const roundAt = (n) => {
    const held = w.chain.get(loot.pda.round(address, lottery_().incarnation, n));
    return held?.owner === loot.LOOT_PROGRAM && held.data.length ? loot.decodeRound(held.data) : null;
  };
  const listing = async (a) => (await a.lotteries()).find((l) => l.key === 'daily');
  return { w, app, other, mine, player, lottery: lottery_, roundAt, listing };
}

test('a due round’s draw goes in front of the next purchase, in the buyer’s one transaction', { skip }, async () => {
  const { w, app, other, mine, player, lottery, roundAt, listing } = await setup('steps-due');
  await other.buyTickets('daily', 2, { listing: await listing(other) });
  w.chain.warp(NOW + 3_600);
  const before = mine.prompts;
  await app.buyTickets('daily', 1, { listing: await listing(app) });
  assert.equal(mine.prompts - before, 1, 'one prompt: the draw, then the ticket');
  assert.equal(roundAt(0).status, 'Drawn', 'the due round was drawn (and the oracle answered)');
  assert.equal(lottery().round, 1, 'the lottery moved on');
  assert.equal(roundAt(1).entries[0].buyer, player.address);
  assert.equal(roundAt(1).sold, 1n, 'the ticket is the next round’s');
});

test('a round short of its least tickets: whoever calls it off gets their payment back in the same transaction', { skip }, async () => {
  const { w, app, other, mine, player, roundAt, listing } = await setup('steps-short', { minSold: 5 });
  await app.buyTickets('daily', 2, { listing: await listing(app) });
  await other.buyTickets('daily', 1, { listing: await listing(other) });
  w.chain.warp(NOW + 3_600);
  const claims = await app.claims();
  assert.deepEqual(claims.map((c) => c.kind), ['reveal']);
  assert.match(claims[0].says, /fewer tickets.*take your ticket payment back, in one step/);
  const before = w.chain.get(player.address).lamports;
  const prompts = mine.prompts;
  await app.claim(claims[0]);
  assert.equal(mine.prompts - prompts, 1);
  const r = roundAt(0);
  assert.equal(r.status, 'Cancelled');
  assert.ok(r.entries[0].paid & loot.OWN_PAID, 'the caller’s own entry is paid back');
  assert.ok(!(r.entries[1].paid & loot.OWN_PAID), 'the other buyer’s waits for them');
  assert.ok(w.chain.get(player.address).lamports > before + 1_000_000n, 'two tickets back, less the fee');
  assert.deepEqual((await other.claims()).map((c) => c.kind), ['pull']);
});

test('a draw the oracle never answered: the cancel after the timeout pulls the sender’s refund too', { skip }, async () => {
  const { w, app, mine, lottery, roundAt, listing } = await setup('steps-timeout');
  await app.buyTickets('daily', 1, { listing: await listing(app) });
  w.chain.warp(NOW + 3_600);
  const round = roundAt(0);
  w.chain.sendRaw(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: round.project, id: round.id, lottery: lottery(), round })]); // never answered
  assert.equal(roundAt(0).status, 'Drawing');
  w.chain.warp(w.chain.now() + Number(loot.LOTTERY_TIMEOUT_SECONDS) + 1);
    w.chain.nextSlot();
  const claims = await app.claims();
  const cancel = claims.find((c) => c.kind === 'cancel-draw');
  assert.ok(cancel, JSON.stringify(claims.map((c) => c.kind)));
  const prompts = mine.prompts;
  await app.claim(cancel);
  assert.equal(mine.prompts - prompts, 1);
  assert.equal(roundAt(0), null, 'its one entry paid back, the round closed in the same transaction');
});
