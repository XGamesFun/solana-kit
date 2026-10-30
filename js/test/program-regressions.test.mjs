// Behaviours of the program the client relies on, each pinned by a test against the real program: ticket allowances
// per round, treasury remainder receipts, auction ends, and NFT-gated open grants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import * as loot from '../client/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;

test('a full per-round ticket allowance does not exhaust future rounds', { skip }, () => {
  const w = world({ seed: 'ticket-counter-regression' });
  const cap = 4_294_967_295;
  const id = 712;
  const address = loot.pda.lottery(w.project, id);
  w.upsert({ Lottery: { id, args: {
    price: 1n, mint: w.mint, shares: [], places: [], ticket_mint: SYSTEM_PROGRAM,
    every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null, per_wallet: cap,
  } } });
  w.fund(w.player, w.mint, BigInt(cap));
  let lottery = w.read('Lottery', address);
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery, count: BigInt(cap), nonce: 1n })]);
  const receipt = loot.pda.lotteryReceipt(address, lottery.incarnation, w.player);
  assert.equal(loot.decodeReceipt(w.chain.get(receipt).data).count, 0);
  assert.equal(loot.decodeReceipt(w.chain.get(receipt).data).inWindow, cap);
  w.chain.warp(Number(lottery.draws_at));
  w.chain.sendRaw(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id })]); // the oracle never answers
  w.chain.nextSlot(Number(loot.LOTTERY_TIMEOUT_SLOTS) + 1);
  w.chain.send(w.cranker, [loot.cancelLotteryIx({ project: w.project, id })]);
  lottery = w.read('Lottery', address);
  const contribution = loot.pda.contribution(address, w.player, 1n);
  w.chain.send(w.cranker, [loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id, lottery, contributionAddress: contribution, contribution: w.read('LotteryContribution', contribution) })]);
  lottery = w.read('Lottery', address);
  assert.equal(lottery.round, 1);
  assert.equal(lottery.status, 'Open');
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery, count: 1n, nonce: 2n })]);
  assert.equal(w.read('Lottery', address).sold, 1n);
  assert.equal(loot.decodeReceipt(w.chain.get(receipt).data).inWindow, 1);
  assert.equal(loot.decodeReceipt(w.chain.get(receipt).data).count, 0);
});

test('treasury remainder receipts distinguish explicit treasury shares from the remainder', { skip }, () => {
  const w = world({ seed: 'treasury-remainder-regression' });
  const before = w.balance(w.creator);
  const paid = w.payIn(w.player, w.mint, 100n, [{ to: 'Treasury', bps: 10_000 }]);
  const event = paid.receipts.find(value => value.name === 'Paid');
  assert.equal(event.data.treasury_remainder, 0n);
  assert.equal(w.balance(w.creator) - before, 100n);
  const remainder = w.payIn(w.player, w.mint, 100n);
  assert.equal(remainder.receipts.find(value => value.name === 'Paid').data.treasury_remainder, 100n);
});

test('an unbid auction ends at its configured time even with a large extension', { skip }, () => {
  const w = world({ seed: 'unbid-auction-timing-regression' });
  const id = 701;
  w.upsert({ Item: { id, args: collectible('Review', 1, { kind: 'Normal' }) } });
  const now = w.chain.now();
  // the largest extension the program takes: five years (it refuses more, BadAuction)
  const args = { lot: { Item: [id] }, reserve: 1n, min_raise_bps: 0,
    starts_at: BigInt(now), ends_at: BigInt(now + 60), extend: 157_680_000, shares: [], gate: null };
  assert.throws(() => w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project,
    collection: w.collection, id, mint: w.mint, args: { ...args, extend: 4_294_967_295 } })]), /BadAuction/);
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project,
    collection: w.collection, id, mint: w.mint, args })]);
  const address = loot.pda.auction(w.project, w.authority, id);
  const auction = w.read('Auction', address);
  assert.equal(loot.auctionEnds(auction), BigInt(now + 60));
  w.chain.warp(now + 61);
  w.chain.send(w.cranker, [loot.endAuctionIx({ signer: w.cranker, project: w.project,
    projectState: w.projectState(), id, auction, now: now + 61 })]);
  assert.equal(w.chain.get(address), null);
});

test('an open grant gated by an NFT counts a compressed NFT shown, as it does any other', () => {
  const [project, wallet, nft, tree] = ['So11111111111111111111111111111111111111112', 'Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111', 'Config1111111111111111111111111111111111111'];
  const grant = { incarnation: 3n, open: true, gate: { Holds: { of: { Collection: [project] }, key: '', test: { Any: {} } } }, limits: { per_person: 0, per_key: 0 }, gives: { Item: [1] } };
  const badge = loot.pda.badge(loot.pda.grant(project, 1), 3n, nft);
  for (const shown of [{ asset: nft }, { compressed: nft, tree }]) {
    const ix = loot.claimGrantIx({ project, id: 1, grant, wallet, signer: wallet, shown, item: null });
    assert.ok(ix.keys.some((k) => k.pubkey === badge), `the badge's receipt is passed for ${Object.keys(shown)[0]}`);
  }
});
