// The player module (js/play) against the real program: an economy goes live through the approval session, then a
// player with their own wallet buys from the shop, opens a box the oracle rolls, pays, buys tickets, stakes and
// harvests, claims a grant from the list, and lists their collectibles.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { associatedTokenAddress, NATIVE_MINT } from '../chain/pda.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

/** A wallet: the signer signs its own slot of whatever it is handed. */
const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

test('a player uses a live economy through js/play', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'play' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  w.chain.airdrop(player.address, 100_000_000_000n);
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Play test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Play test' },
    items: [
      { key: 'badge', name: 'Badge', price: 0.01, supply: 10 },
      { key: 'gem', name: 'Gem' },
      { key: 'starter', name: 'Starter pet' },
      { key: 'art', name: 'Sunset', supply: 1 },
    ],
    auctions: [{ key: 'sunset', name: 'Sunset', lot: { item: 'art' }, reserve: 0.01, runs: '1h', extendBy: '5m' }],
    pools: [{ key: 'house', currency: 'sol', seed: 1 }, { key: 'rewards', currency: 'sol', seed: 0.5 }],
    boxes: [{ key: 'chest', name: 'Chest', price: 0.02, split: [{ to: 'pool:house', percent: 90 }], outcomes: [{ gives: 'item', item: 'gem', chance: 50 }, { gives: 'pay', pool: 'house', amount: 0.03, chance: 50 }] }],
    payments: [{ key: 'entry', name: 'Entry', amount: 0.005, split: [{ to: 'lottery:weekly', percent: 100 }] }],
    lotteries: [{ key: 'weekly', name: 'Weekly', price: 0.001, every: '7d' }],
    farms: [{ key: 'stake', name: 'Stake SOL', stakes: 'sol', rewards: 'rewards', tiers: [{ lock: '1h', multiplier: 1 }] }],
    grants: [{ key: 'welcome', name: 'Welcome', gives: { item: 'starter' }, list: [player.address], limits: { perWallet: 1 }, fund: 0.05 }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-play-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, batch.transactions.map((b64) => toBase64(wireTransaction(readTransaction(fromBase64(b64)).message, (() => { const t = readTransaction(fromBase64(b64)); const s = [...t.signatures]; s[t.signers.indexOf(owner.address)] = owner.sign(t.message); return s; })()))));
  }
  const live = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok((live.live?.project ?? live.live?.game));

  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  const shop = await app.shop();
  assert.deepEqual(shop.map((s) => [s.key, s.price, s.left]), [['badge', '0.01', 10]]);
  const bought = await app.buy('badge', { listing: (await app.shop()).find((l) => l.key === 'badge') });
  assert.ok(bought.asset, 'the badge was minted');
  const opened = await app.openBox('chest', { listing: (await app.boxes()).find((l) => l.key === 'chest') });
  assert.ok(opened.settled);
  await app.pay('entry');
  w.chain.nextSlot();
  await app.buyTickets('weekly', 3, { listing: (await app.lotteries()).find((l) => l.key === 'weekly') });
  await app.stake('stake', '0.1');
  w.chain.warp(NOW + 60);
  await app.harvest('stake');
  // SOL prizes and rewards come out as plain SOL: no wrapped-SOL account is left behind.
  assert.equal(await w.chain.rpc.account(associatedTokenAddress(player.address, NATIVE_MINT)), null);
  await app.claimGrant('welcome');
  const mine = await app.collectibles();
  assert.ok(mine.some((c) => c.name.startsWith('Badge')), JSON.stringify(mine.map((c) => c.name)));
  assert.ok(mine.some((c) => c.name.startsWith('Starter pet')));
  const boxes = await app.boxes();
  assert.equal(boxes[0].outcomes[0].chancePercent, 50);

  // An auction in SOL: the player bids, a rival tops it and the player's SOL is back at once, waiting in their
  // wrapped-SOL account until they unwrap it; the rival ends it and has the collectible.
  const rival = freshKeypair();
  w.chain.airdrop(rival.address, 100_000_000_000n);
  const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(rival), now: () => w.chain.now() });
  let [sunset] = await app.auctions();
  assert.deepEqual([sunset.open, sunset.high, sunset.nextBid], [true, null, '0.01']);
  await app.bid('sunset', '0.01');
  [sunset] = await theirs.auctions();
  assert.deepEqual([sunset.high, sunset.nextBid, sunset.leading], ['0.01', '0.0105', false]);
  await theirs.bid('sunset', '0.02');
  [sunset] = await app.auctions();
  assert.equal(sunset.waiting, '0.01', 'the topped bid is back in the wrapped-SOL account');
  const before = await w.chain.rpc.balance(player.address);
  await app.unwrap();
  assert.ok((await w.chain.rpc.balance(player.address)) > before, 'and it is plain SOL again');
  w.chain.warp(w.chain.now() + 3_700);
  const ended = await theirs.endAuction('sunset');
  assert.equal(ended.winner, rival.address);
  assert.ok((await theirs.collectibles()).some((c) => c.name.startsWith('Sunset')));
  assert.deepEqual((await app.auctions()).map((x) => x.ended), [true]);
});
