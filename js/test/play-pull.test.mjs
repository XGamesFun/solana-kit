// The player pulls: nothing waits on a server. A box opens and settles with one wallet prompt (a throwaway key the
// open funded signs the settle and hands the rest back); whatever a player is owed shows in `claims()` and they take
// it themselves; an empty lottery round is moved on by the next ticket buyer.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { NATIVE_MINT } from '../chain/pda.js';
import { createAssociatedTokenAccountIdempotent, withSolWrap } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

/** A wallet that counts its prompts. */
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
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-pull-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
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

test('one prompt a box; a player finds and takes what they are owed; the next buyer moves an empty round on', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'pull' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  const rival = freshKeypair();
  for (const k of [owner, player, rival]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, {
    version: 2,
    network: 'devnet',
    name: 'Pull test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Pull test' },
    items: [{ key: 'badge', name: 'Badge', price: 0.01, supply: 10 }, { key: 'gem', name: 'Gem' }, { key: 'art', name: 'Sunset', supply: 1 }],
    pools: [{ key: 'house', currency: 'sol', seed: 1 }],
    boxes: [{ key: 'chest', name: 'Chest', price: 0.02, split: [{ to: 'pool:house', percent: 90 }], outcomes: [{ gives: 'item', item: 'gem', chance: 50 }, { gives: 'pay', pool: 'house', amount: 0.03, chance: 50 }] }],
    lotteries: [{ key: 'daily', name: 'Daily', price: 0.001, every: '1h' }],
    auctions: [{ key: 'sunset', name: 'Sunset', lot: { item: 'art' }, reserve: 0.01, runs: '1h' }],
  });
  const wallet = asWallet(player);
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(rival), now: () => w.chain.now() });

  // One prompt each: the open. The settle is the throwaway key's, which ends empty.
  const bought = await app.buy('badge', { listing: (await app.shop()).find((l) => l.key === 'badge') });
  assert.ok(bought.asset);
  assert.equal(wallet.prompts, 1);
  for (let i = 0; i < 4; i++) assert.ok((await app.openBox('chest', { listing: (await app.boxes()).find((l) => l.key === 'chest') })).settled);
  assert.equal(wallet.prompts, 5, 'five boxes, five prompts');

  // A player whose page closed after the open, before the settle: what the box rolled waits in their claims.
  assert.deepEqual(await app.claims(), []);
  const box = w.read('LootBox', loot.pda.box((live.live.project ?? live.live.game), live.boxes[0].id));
  w.chain.send(player.address, withSolWrap(player.address, NATIVE_MINT, box.price, [createAssociatedTokenAccountIdempotent(player.address, player.address, NATIVE_MINT), loot.openBoxIx({ player: player.address, project: (live.live.project ?? live.live.game), box, nonce: 77n })]));
  const left = await app.claims();
  assert.deepEqual(left.map((c) => c.kind), ['settle']);
  await app.claim(left[0]);
  assert.equal(w.chain.get(loot.pda.order((live.live.project ?? live.live.game), player.address, 77n)), null);

  // The rival bids on the auction; while it runs, there is nothing to take.
  await theirs.bid('sunset', '0.01');
  assert.deepEqual(await theirs.claims(), []);

  // A lottery: two buyers; on its date the draw shows as due, either may reveal it, the winner takes the places.
  await app.buyTickets('daily', 2, { listing: (await app.lotteries()).find((l) => l.key === 'daily') });
  await theirs.buyTickets('daily', 1, { listing: (await theirs.lotteries()).find((l) => l.key === 'daily') });
  w.chain.warp(NOW + 3_600);
  const due = await app.claims();
  assert.deepEqual(due.map((c) => c.kind), ['reveal']);
  await app.claim(due[0]);
  const lottery = () => w.read('Lottery', loot.pda.lottery((live.live.project ?? live.live.game), live.lotteries[0].id));
  assert.equal(lottery().status, 'Drawn');
  while (lottery().pending > 0) await app.claim((await app.claims()).find((c) => c.kind === 'complete-draw'));
  const mine = await app.claims();
  const yours = await theirs.claims();
  const prize = mine.find((c) => c.kind === 'prize') ?? yours.find((c) => c.kind === 'prize');
  assert.ok(prize, 'whoever won sees their place');
  await (mine.includes(prize) ? app : theirs).claim(prize);
  assert.equal(lottery().status, 'Open', 'the one claim paid every place, and the next round opened');

  // Nobody buys the next round; at its date the next buyer moves it on in their own transaction.
  w.chain.warp(Number(lottery().draws_at) + 10);
  await theirs.buyTickets('daily', 1, { listing: (await theirs.lotteries()).find((l) => l.key === 'daily') });
  assert.equal(lottery().sold, 1n);
  assert.ok(lottery().draws_at > BigInt(w.chain.now()));

  // That round has one buyer. Once it is drawn, a player who didn't win may pay the winner, so the next round opens.
  w.chain.warp(Number(lottery().draws_at) + 10);
  await app.claim((await app.claims()).find((c) => c.kind === 'reveal'));
  assert.equal(lottery().status, 'Drawn');
  while (lottery().pending > 0) await app.claim((await app.claims()).find((c) => c.kind === 'complete-draw'));
  const payout = (await app.claims()).find((c) => c.kind === 'payout');
  assert.ok(payout, 'a player who didn’t win sees the unpaid place');
  await app.claim(payout);
  assert.equal(lottery().status, 'Open', 'paying the place opened the next round');

  // The auction (bid on at the start, below, and over by now): the winner sees it and takes it.
  const won = await theirs.claims();
  assert.deepEqual(won.map((c) => c.kind), ['auction']);
  await theirs.claim(won[0]);
  assert.ok((await theirs.collectibles()).some((c) => c.name.startsWith('Sunset')));
});
