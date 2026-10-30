// Collections, bundles, list gates and NFT prices, as the client builds them and the program takes them in LiteSVM: a
// project of several collections, `buy` (a box with no roll, sold in one instruction), a bundle a roll sets aside and
// `settle` hands over, a list gate, a hold addressed by its end, and an NFT as the price: `pay_nft`, a recipe's
// trade-in, a lottery's ticket, a contest's stake, an auction's bid.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM, parseCoreAsset } from '../chain/core.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, meta } from '../chain/programs.js';
import { setAuthorityIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { newAddress } from '../sim/chain.mjs';
import { boxArgs, cannotRun, collectible, drop, fromPool, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const names = (record) => record.receipts.map((r) => r.name);
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const fails = (fn, why) => assert.throws(fn, (e) => String(e.message).includes(why) || (e.logs ?? []).join('\n').includes(why), why);
const stashOf = (w, id) => loot.decodeStash(w.chain.get(pda.stash(w.project, id))?.data)?.nfts ?? [];

/** A Core collection `maker` controls, and `n` of its assets for `owner`. */
function partner(w, owner, n) {
  const maker = w.who();
  const collection = newAddress(w.random);
  const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
  w.chain.send(maker, [{ programId: MPL_CORE_PROGRAM, keys: [meta(collection, true, true), meta(maker, false, false), meta(maker, true, true), meta(SYSTEM_PROGRAM, false, false)], data: concat(Uint8Array.of(21), str('Partners'), str('x'), Uint8Array.of(0, 0)) }]);
  const mint = (to) => {
    const asset = newAddress(w.random);
    const data = concat(Uint8Array.of(20, 0), str('Partner'), str('x'), Uint8Array.of(0, 0));
    w.chain.send(maker, [{ programId: MPL_CORE_PROGRAM, keys: [meta(asset, true, true), meta(collection, false, true), meta(maker, true, false), meta(maker, true, true), meta(to, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false), meta(MPL_CORE_PROGRAM, false, false)], data }]);
    return asset;
  };
  return { collection, nfts: Array.from({ length: n }, () => mint(owner)), mint };
}

t('a project takes a second collection, and each item is minted into its own', () => {
  const w = world({ seed: 'prices-collections' });
  const second = newAddress(w.random);
  w.chain.send(w.creator, [createCollectionInstruction({ collection: second, creator: w.creator, name: 'Second', uri: 'x', project: w.project })]);
  w.chain.send(w.creator, [loot.updateProjectIx({ owner: w.creator, project: w.project, collections: [w.collection, second] })]);
  assert.deepEqual(w.projectState().collections, [w.collection, second]);
  assert.equal(w.chain.get(w.project).data.length, loot.projectBytes(2));
  w.upsert({ Item: { id: 5, args: collectible('Banner', 0, { collection: second }) } });
  const banner = newAddress(w.random);
  w.chain.send(w.authority, [loot.collectibleIx({ authority: w.authority, project: w.project, collection: second, asset: banner, item: 5, owner: w.player, change: { Make: { attributes: [] } } })]);
  assert.equal(parseCoreAsset(w.chain.get(banner).data).collection, second);
  // A second project of the same owner, numbered 1, with no collection at all.
  w.chain.send(w.creator, [loot.createProjectIx({ owner: w.creator, id: 1, authority: w.authority, treasury: w.treasury })]);
  const other = w.read('Project', pda.project(w.creator, 1));
  assert.deepEqual([other.creator, other.collections], [w.creator, []]);
});

t('buy sells a box with no roll in one instruction: the price split at once, a bundle given', () => {
  const w = world({ seed: 'prices-buy' });
  w.pool(1, w.mint, 1_000n);
  w.upsert({ Item: { id: 1, args: collectible('Crown') } });
  w.upsert({ Item: { id: 2, args: { ...collectible('Potion'), kind: 'Normal' } } });
  // Two crowns, a potion and 300 coins from pool 1; 20% of the price burned.
  w.upsert({ Box: { id: 7, args: boxArgs(PRICE, [drop([{ Item: [1] }, { Item: [1] }, fromPool(1, 300n)])], { shares: [{ to: 'Burn', bps: 2000 }] }) } });
  w.upsert({ Box: { id: 8, args: boxArgs(PRICE, [itemDrop(2), itemDrop(1)]) } });
  const items = () => ({ 1: w.read('Item', pda.item(w.project, 1)), 2: w.read('Item', pda.item(w.project, 2)) });
  const buy = (id) => loot.buyIx({ player: w.player, project: w.project, box: w.read('LootBox', pda.box(w.project, id)), treasury: w.treasury, items: items(), poolMints: { 1: w.mint } });
  const [coins, treasury] = [w.balance(w.player), w.balance(w.treasury)];
  const r = w.chain.send(w.player, [computeUnitLimit(600_000), buy(7)]);
  assert.deepEqual(names(r), ['PrizeGiven', 'PrizeGiven', 'PrizeGiven', 'Bought']);
  const item = pda.item(w.project, 1);
  assert.deepEqual([ownerOf(w, pda.itemAsset(item, 1)), ownerOf(w, pda.itemAsset(item, 2))], [w.player, w.player]);
  assert.equal(w.balance(w.player), coins - PRICE + 300n);
  assert.equal(w.balance(w.treasury) - treasury, (PRICE * 8n) / 10n);
  assert.equal(w.chain.get(pda.order(w.project, w.player, 0n)), null, 'no order');
  // A box that rolls is opened, not bought.
  fails(() => w.chain.send(w.player, [buy(8)]), 'Rolls');
});

t('a rolled bundle: the roll sets each prize aside, settle hands them all over and makes the roll it won', () => {
  const w = world({ seed: 'prices-bundle' });
  const coin = w.newMint(w.creator);
  w.chain.send(w.creator, [setAuthorityIx({ account: coin, current: w.creator, newAuthority: w.project })]);
  w.upsert({ Item: { id: 1, args: collectible('Gem') } });
  w.upsert({ Box: { id: 9, args: boxArgs(0n, [itemDrop(1)], { active: false }) } });
  const minted = { Tokens: { from: { Mint: [coin] }, amount: { Fixed: [40n] } } };
  // The bundle all but always: a weight of 1,000,000 against 1.
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([{ Item: [1] }, minted, { Roll: [9] }], 1_000_000), drop([])]) } });
  const box = w.read('LootBox', pda.box(w.project, 1));
  assert.equal(loot.orderEscrow(box), loot.ESCROW_LAMPORTS);
  const r = w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, box, nonce: 1n })]);
  assert.equal(r.answers.length, 1);
  const orderAddress = pda.order(w.project, w.player, 1n);
  const order = w.read('Order', orderAddress);
  assert.deepEqual(order.won, [{ Item: { item: 1, serial: 1 } }, { Tokens: { mint: coin, amount: 40n } }, { Roll: [9] }]);
  w.chain.nextSlot();
  const s = w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.settleIx({ signer: w.cranker, orderAddress, order, projectState: w.projectState(), items: { 1: w.read('Item', pda.item(w.project, 1)) } })]);
  const settled = s.receipts.find((x) => x.name === 'OrderSettled').data;
  const roll = pda.order(w.project, w.player, loot.rollNonce(orderAddress, order.requested_slot, 2));
  assert.deepEqual(settled.assets, [pda.itemAsset(pda.item(w.project, 1), 1), NOBODY, roll]);
  assert.equal(w.balance(w.player, coin), 40n);
  assert.equal(w.read('Order', roll).status, 'Waiting');
});

t('a list gate lets in the wallets on it, its proof passed where an NFT shown would be', () => {
  const w = world({ seed: 'prices-list' });
  w.upsert({ Item: { id: 2, args: { ...collectible('Ticket'), kind: 'Normal' } } });
  const wallets = [w.who(), w.player, w.who()];
  const leaves = wallets.map(loot.gateListLeaf);
  const gate = { List: { root: loot.merkleRoot(leaves), depth: loot.merkleProof(leaves, 1).length } };
  w.upsert({ Box: { id: 3, args: boxArgs(10n, [itemDrop(2)], { gate }) } });
  const box = w.read('LootBox', pda.box(w.project, 3));
  const items = { 2: w.read('Item', pda.item(w.project, 2)) };
  const buy = (listProof) => loot.buyIx({ player: w.player, project: w.project, box, treasury: w.treasury, items, listProof });
  fails(() => w.chain.send(w.player, [buy(loot.merkleProof(leaves, 0))]), 'GateNotMet');
  w.chain.send(w.player, [buy(loot.merkleProof(leaves, 1))]);
  assert.equal(w.read('Item', pda.item(w.project, 2)).issued, 1);
});

t('a hold is addressed by its end, and its release names nothing more', () => {
  const w = world({ seed: 'prices-hold' });
  w.upsert({ Item: { id: 1, args: collectible('Sword') } });
  const sword = w.make(1, w.player);
  const freeAt = w.chain.now() + 60;
  w.chain.send(w.player, [loot.holdIx({ player: w.player, project: w.project, collection: w.collection, asset: sword, freeAt })]);
  const hold = w.read('Hold', pda.hold(sword, freeAt));
  assert.equal(hold.free_at, BigInt(freeAt));
  w.chain.warp(freeAt);
  w.chain.send(w.cranker, [loot.releaseIx({ signer: w.cranker, project: w.project, collection: w.collection, asset: sword, hold })]);
  assert.equal(ownerOf(w, sword), w.player);
});

t('an NFT as the price: a payment, a trade-in, a ticket, a stake and a bid', () => {
  const w = world({ seed: 'prices-nfts' });
  const { collection, nfts, mint } = partner(w, w.player, 4);
  const kind = { collection, hasAuthority: false };
  // pay_nft: given to the treasury, then one burned.
  const r = w.chain.send(w.player, [loot.payNftIx({ player: w.player, project: w.project, asset: nfts[0], to: w.treasury, collection, reference: 'entry' })]);
  assert.deepEqual(names(r), ['PaidNft']);
  assert.equal(ownerOf(w, nfts[0]), w.treasury);
  w.chain.send(w.player, [loot.payNftIx({ player: w.player, project: w.project, asset: nfts[1], collection })]);
  assert.ok(w.chain.get(nfts[1]).data.length <= 1, 'burned');

  // A recipe's trade-in: the partner NFT into the chest, a ticket out.
  w.upsert({ Item: { id: 2, args: { ...collectible('Ticket'), kind: 'Normal' } } });
  w.upsert({ Recipe: { id: 1, args: { active: true, inputs: [{ Trade: { collection, then: { Stash: [4] } } }], outputs: [{ Prize: [{ Item: [2] }] }], needs: [], keeps: [], raises: [] } } });
  const items = { 2: w.read('Item', pda.item(w.project, 2)) };
  w.chain.send(w.player, [computeUnitLimit(400_000), loot.craftIx({ player: w.player, project: w.project, id: 1, recipe: w.read('Recipe', pda.recipe(w.project, 1)), assets: [{ asset: nfts[2], ...kind }], items })]);
  assert.deepEqual(stashOf(w, 4), [nfts[2]]);

  // A lottery whose ticket costs one NFT, burned.
  const rule = { of: { Collection: [collection] }, key: '', test: 'Any' };
  w.upsert({ Lottery: { id: 1, args: { price: 0n, mint: w.mint, shares: [], places: [], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null, nft_ticket: { rule, then: 'Burn' } } } });
  const lottery = w.read('Lottery', pda.lottery(w.project, 1));
  const bought = w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 1, lottery, count: 1n, nonce: 1n, nft: { asset: nfts[3], ...kind } })]);
  assert.equal(bought.receipts.find((x) => x.name === 'TicketsBought').data.asset, nfts[3]);
  assert.equal(ownerOf(w, nfts[3]), w.project, 'held until the draw');
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1 })]);
  const contributionAddress = pda.contribution(pda.lottery(w.project, 1), w.player, 1n);
  const contribution = w.read('LotteryContribution', contributionAddress);
  w.chain.send(w.cranker, [computeUnitLimit(400_000), loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 1, lottery: w.read('Lottery', pda.lottery(w.project, 1)), contributionAddress, contribution, ticket: kind })]);
  assert.ok(w.chain.get(nfts[3]).data.length <= 1, 'drawn, the ticket burned it');

  // A contest of NFTs: the winner takes its own back and the loser's.
  const [a, b] = [mint(w.player), mint(w.cranker)];
  const now = w.chain.now();
  const args = { sides: 2, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [], gate: null, nft: rule };
  w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id: 1, mint: w.mint, args })]);
  let contest = w.read('Contest', pda.contest(w.project, 1));
  w.chain.send(w.player, [loot.enterIx({ player: w.player, project: w.project, id: 1, contest, side: 0, nft: { asset: a, ...kind } })]);
  w.chain.send(w.cranker, [loot.enterIx({ player: w.cranker, project: w.project, id: 1, contest, side: 1, nft: { asset: b, ...kind } })]);
  w.chain.warp(now + 150);
  w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest: w.read('Contest', pda.contest(w.project, 1)), side: 0 })]);
  contest = w.read('Contest', pda.contest(w.project, 1));
  const entry = (player) => w.read('Entry', pda.entry(pda.contest(w.project, 1), player));
  w.chain.send(w.player, [loot.claimIx({ payer: w.player, project: w.project, id: 1, contest, player: w.player, side: 0, entry: entry(w.player, 0), own: kind, taking: { player: w.cranker, side: 1, asset: b, kind } })]);
  assert.deepEqual([ownerOf(w, a), ownerOf(w, b)], [w.player, w.player]);

  // An auction whose bids are NFTs: a bundle of two tops one of one, which goes back.
  const [c, d, e] = [mint(w.player), mint(w.cranker), mint(w.cranker)];
  const lot = { lot: { Roll: [9] }, reserve: 1n, min_raise_bps: 0, starts_at: BigInt(w.chain.now()), ends_at: BigInt(w.chain.now() + 600), extend: 0, shares: [], gate: null, nft_bids: rule };
  w.upsert({ Box: { id: 9, args: boxArgs(0n, [itemDrop(2)], { active: false }) } });
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, id: 1, mint: w.mint, args: lot })]);
  const auction = () => w.read('Auction', pda.auction(w.project, w.authority, 1));
  w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: auction(), nfts: [{ asset: c, ...kind }] })]);
  w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.bidIx({ bidder: w.cranker, project: w.project, id: 1, auction: auction(), nfts: [{ asset: d, ...kind }, { asset: e, ...kind }], held: [kind] })]);
  assert.equal(ownerOf(w, c), w.player, 'the bid it topped went back');
  assert.deepEqual(auction().held, [d, e]);
  w.chain.warp(w.chain.now() + 601);
  w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.endAuctionIx({ signer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, auction: auction(), held: [kind, kind] })]);
  assert.deepEqual([ownerOf(w, d), ownerOf(w, e)], [w.treasury, w.treasury], 'the winning NFTs went to the treasury, for the project’s roll');
});
