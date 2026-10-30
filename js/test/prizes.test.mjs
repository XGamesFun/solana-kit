// Prizes of every kind on every route, as the client builds them and the program takes them: NFTs the project holds in a
// stash, given at random by a box; and a roll of that box given by a grant, a lottery's place, a contest's winners and
// an auction's lot, each asked for by anyone and settled by anyone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { cannotRun, collectible, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const CHEST = 5;
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const stashOf = (w, id) => loot.decodeStash(w.chain.get(pda.stash(w.project, id))?.data)?.nfts ?? [];
const contributionsOf = (w, lottery) => w.chain.svm.getProgramAccounts(loot.LOOT_PROGRAM)
  .filter((a) => a.data[0] === loot.TAGS.LotteryContribution)
  .map((a) => ({ address: a.address, value: loot.decode('LotteryContribution', a.data) }))
  .filter(({ value }) => value.lottery === lottery)
  .sort((x, y) => Number(x.value.first_ticket - y.value.first_ticket));

/** Sends each contribution's next step until the round is done: prizes first, then the money, then the pot's shares. */
function finishRound(w, address, opts = {}) {
  for (let sent = 0; sent < 50; sent++) {
    const lottery = w.read('Lottery', address);
    const next = contributionsOf(w, address).find(({ value }) => loot.lotteryStep(lottery, value));
    if (!next) return;
    const items = opts.items?.();
    w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 1, lottery, contributionAddress: next.address, contribution: next.value, treasury: w.treasury, ...opts, items })]);
  }
  throw new Error('the round never finished');
}

/** A project with three of its collectibles in stash 1, and `CHEST`, switched off, a box of that stash alone. */
function stocked(seed) {
  const w = world({ seed });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const nfts = [0, 1, 2].map(() => w.make(1, w.authority));
  for (const asset of nfts) w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset, collection: w.collection })]);
  const chest = { price: 0n, currency: null, rise: null, fall: null, stock_odds: false, active: false, shares: [], entries: [{ prizes: [{ Stash: [1] }], burns: false, weight: 1 }], odds: [] };
  w.upsert({ Box: { id: CHEST, args: chest } });
  return { w, nfts };
}

/** Anyone asks the oracle for the prize's roll at `orderAddress`, then settles it; returns the NFT it gave. */
function rollAndSettle(w, orderAddress) {
  let order = w.read('Order', orderAddress);
  assert.equal(order.status, 'Waiting');
  w.chain.send(w.cranker, loot.askRollIx({ payer: w.cranker, orderAddress, order, box: w.read('LootBox', order.loot_box) }));
  order = w.read('Order', orderAddress);
  assert.equal(order.status, 'Rolled');
  const [{ Nft: { nft } }] = order.won;
  w.chain.nextSlot();
  w.chain.send(w.cranker, [computeUnitLimit(400_000), loot.settleIx({ signer: w.cranker, orderAddress, order, projectState: w.projectState(), nfts: { [nft]: { collection: w.collection } } })]);
  assert.equal(ownerOf(w, nft), order.player);
  return nft;
}

t('a stash takes what the project’s keys put in, and a box gives one of its NFTs at random', () => {
  const { w, nfts } = stocked('prizes-stash');
  assert.deepEqual(stashOf(w, 1), nfts);
  for (const asset of nfts) assert.equal(ownerOf(w, asset), w.project);
  // Taken out, to any wallet.
  const winner = w.who();
  w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset: nfts[0], out: winner, collection: w.collection })]);
  assert.equal(ownerOf(w, nfts[0]), winner);
  assert.equal(stashOf(w, 1).length, 2);
  // A shop of the stash alone is still rolled by the oracle.
  w.upsert({ Box: { id: 2, args: { ...w.read('LootBox', pda.box(w.project, CHEST)), active: true } } });
  const box = w.read('LootBox', pda.box(w.project, 2));
  const g = w.projectState();
  w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, box, nonce: 1n })]);
  const orderAddress = pda.order(w.project, w.player, 1n);
  const order = w.read('Order', orderAddress);
  const [{ Nft: { nft } }] = order.won;
  assert.deepEqual([order.status, order.held, nfts.slice(1).includes(nft)], ['Rolled', false, true]);
  assert.equal(stashOf(w, 1).length, 1, 'taken out of the stash at the roll');
  w.chain.nextSlot();
  w.chain.send(w.cranker, [computeUnitLimit(400_000), loot.settleIx({ signer: w.cranker, orderAddress, order, projectState: g, nfts: { [nft]: { collection: w.collection } } })]);
  assert.equal(ownerOf(w, nft), w.player);
});

t('a grant gives a roll of a box', () => {
  const { w, nfts } = stocked('prizes-grant');
  const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 1, args: { gives: { Roll: [CHEST] }, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true } } });
  const wallet = w.who();
  const grant = w.read('Grant', pda.grant(w.project, 1));
  const nonce = 77n;
  const boxes = { [CHEST]: w.read('LootBox', pda.box(w.project, CHEST)) };
  w.chain.send(wallet, [loot.claimGrantIx({ project: w.project, id: 1, grant, wallet, signer: wallet, projectState: w.projectState(), boxes, nonce })]);
  assert.ok(nfts.includes(rollAndSettle(w, pda.order(w.project, wallet, loot.prizeRollNonce(nonce)))));
});

t('a lottery’s place gives a roll of a box', () => {
  const { w, nfts } = stocked('prizes-lottery');
  const places = [7000, { bps: 0, prize: { Roll: [CHEST] } }];
  w.upsert({ Lottery: { id: 1, args: { price: 1000n, mint: w.mint, shares: [], places, ticket_mint: NOBODY, every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null } } });
  const address = pda.lottery(w.project, 1);
  let lottery = w.read('Lottery', address);
  assert.deepEqual(lottery.places.slice(0, 3), [{ bps: 7000, prize: null }, { bps: 0, prize: { Roll: [CHEST] } }, { bps: 0, prize: null }]);
  const rival = w.who();
  w.fund(rival, w.mint, 10n * PRICE);
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 1, lottery, mint: w.mint, count: 1n, nonce: 1n })]);
  w.chain.send(rival, [loot.buyTicketsIx({ player: rival, project: w.project, id: 1, lottery, mint: w.mint, count: 1n, nonce: 1n })]);
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1 })]);
  lottery = w.read('Lottery', address);
  const second = loot.contributionOf(contributionsOf(w, address), loot.ticketOfPlace(lottery, 1));
  finishRound(w, address);
  const order = pda.order(w.project, second.value.player, loot.prizeRollNonce(loot.prizeNonce(second.address) + 1n));
  assert.ok(nfts.includes(rollAndSettle(w, order)));
});

t('a contest’s winning entry gets a roll of a box with its part of the pot', () => {
  const { w, nfts } = stocked('prizes-contest');
  const now = w.chain.now();
  const args = { sides: 2, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [], gate: null, prize: { Roll: [CHEST] } };
  w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id: 1, mint: w.mint, args })]);
  let contest = w.read('Contest', pda.contest(w.project, 1));
  const rival = w.who();
  w.fund(rival, w.mint, 10n * PRICE);
  w.chain.send(w.player, [loot.enterIx({ player: w.player, project: w.project, id: 1, contest, side: 0, amount: PRICE })]);
  w.chain.send(rival, [loot.enterIx({ player: rival, project: w.project, id: 1, contest, side: 1, amount: PRICE })]);
  w.chain.warp(now + 150);
  w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest: w.read('Contest', pda.contest(w.project, 1)), side: 0 })]);
  contest = w.read('Contest', pda.contest(w.project, 1));
  w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, id: 1, contest, player: rival, side: 1 })]);
  contest = w.read('Contest', pda.contest(w.project, 1));
  w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, id: 1, contest, player: w.player, side: 0 })]);
  const entry = pda.entry(pda.contest(w.project, 1), w.player);
  assert.ok(nfts.includes(rollAndSettle(w, pda.order(w.project, w.player, loot.prizeRollNonce(loot.prizeNonce(entry))))));
});

t('an auction sells a roll of a box', () => {
  const { w, nfts } = stocked('prizes-auction');
  const now = w.chain.now();
  const args = { lot: { Roll: [CHEST] }, reserve: 10n, min_raise_bps: 500, starts_at: BigInt(now), ends_at: BigInt(now + 600), extend: 0, shares: [] };
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, id: 1, mint: w.mint, args })]);
  const address = pda.auction(w.project, w.authority, 1);
  w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: w.read('Auction', address), amount: PRICE })]);
  w.chain.warp(now + 601);
  const auction = w.read('Auction', address);
  const treasury = w.balance(w.treasury);
  w.chain.send(w.cranker, [loot.endAuctionIx({ signer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, auction })]);
  assert.equal(w.balance(w.treasury) - treasury, PRICE);
  const order = pda.order(w.project, w.player, loot.prizeRollNonce(loot.prizeNonce(address, BigInt(auction.last_bid_at))));
  assert.ok(nfts.includes(rollAndSettle(w, order)));
});

t('a specific NFT and a collectible are given at once, by a grant’s claim and by a lottery’s place', () => {
  const { w, nfts } = stocked('prizes-direct');
  const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  const grantArgs = (gives) => ({ gives, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true });
  // A grant of one NFT of the stash: the claim hands it over, in its own transaction.
  w.upsert({ Grant: { id: 1, args: grantArgs({ Nft: { stash: 1, nft: nfts[0] } }) } });
  const wallet = w.who();
  const r = w.chain.send(wallet, [computeUnitLimit(400_000), loot.claimGrantIx({ project: w.project, id: 1, grant: w.read('Grant', pda.grant(w.project, 1)), wallet, signer: wallet, projectState: w.projectState(), nft: { collection: w.collection } })]);
  assert.equal(r.receipts.find((x) => x.name === 'PrizeGiven').data.asset, nfts[0]);
  assert.equal(ownerOf(w, nfts[0]), wallet);
  assert.ok(!stashOf(w, 1).includes(nfts[0]), 'out of the stash');
  // A grant of a collectible: minted at its item's next serial.
  w.upsert({ Item: { id: 2, args: collectible('Trophy') } });
  w.upsert({ Grant: { id: 2, args: grantArgs({ Item: [2] }) } });
  const item = w.read('Item', pda.item(w.project, 2));
  w.chain.send(wallet, [computeUnitLimit(400_000), loot.claimGrantIx({ project: w.project, id: 2, grant: w.read('Grant', pda.grant(w.project, 2)), wallet, signer: wallet, projectState: w.projectState(), item })]);
  assert.equal(ownerOf(w, pda.itemAsset(pda.item(w.project, 2), 1)), wallet);

  // A lottery: first place takes the pot, second the artwork, both paid by finishing the winners' contributions.
  const places = [10_000, { bps: 0, prize: { Nft: { stash: 1, nft: nfts[1] } } }];
  w.upsert({ Lottery: { id: 1, args: { price: 1000n, mint: w.mint, shares: [], places, ticket_mint: NOBODY, every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null } } });
  const address = pda.lottery(w.project, 1);
  const rival = w.who();
  w.fund(rival, w.mint, 10n * PRICE);
  let lottery = w.read('Lottery', address);
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 1, lottery, mint: w.mint, count: 1n, nonce: 1n })]);
  w.chain.send(rival, [loot.buyTicketsIx({ player: rival, project: w.project, id: 1, lottery, mint: w.mint, count: 1n, nonce: 1n })]);
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1 })]);
  lottery = w.read('Lottery', address);
  const second = loot.contributionOf(contributionsOf(w, address), loot.ticketOfPlace(lottery, 1));
  finishRound(w, address, { collection: w.collection, nfts: { [nfts[1]]: { collection: w.collection } } });
  assert.equal(ownerOf(w, nfts[1]), second.value.player, 'given with the place');
});

t('one buyer who wins two places of the same collectible gets two, each at its own serial', () => {
  const w = world({ seed: 'prizes-lottery-twice' });
  w.upsert({ Item: { id: 9, args: collectible('Medal') } });
  const medal = { bps: 0, prize: { Item: [9] } };
  w.upsert({ Lottery: { id: 1, args: { price: 1000n, mint: w.mint, shares: [], places: [5000, medal, medal], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null } } });
  const address = pda.lottery(w.project, 1);
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 1, lottery: w.read('Lottery', address), mint: w.mint, count: 3n, nonce: 1n })]);
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1 })]);
  finishRound(w, address, { items: () => ({ 9: w.read('Item', pda.item(w.project, 9)) }) });
  const medals = [1, 2].map((serial) => pda.itemAsset(pda.item(w.project, 9), serial));
  assert.deepEqual(medals.map((m) => ownerOf(w, m)), [w.player, w.player]);
});
