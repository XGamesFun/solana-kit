// The player module (js/play) against the real program: a shop item and a bundle bought in one transaction (`buy`), a
// rolled bundle collected with everything it set aside, and an NFT as the price: a payment, a lottery's ticket, a
// contest's stake, an auction's bid. The economy is set up here directly, as the owner's approval would, so this test
// reads only what a live xsolana.json gives the page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { MPL_CORE_PROGRAM, parseCoreAsset } from '../chain/core.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { boxArgs, cannotRun, collectible, drop, fromPool, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;

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

/** A Core collection another maker controls, and a way to mint its NFTs. */
function partner(w) {
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
  return { collection, mint };
}

/** A player with SOL and the project's tokens, and their app. */
function playerOf(w, spec) {
  const player = freshKeypair();
  w.chain.airdrop(player.address, 10_000_000_000n);
  w.fund(player.address, w.mint, 10n * PRICE);
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  return { player, app };
}

const specOf = (w, more = {}) => ({
  version: 2,
  name: 'Bundles',
  currency: 'gold',
  tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }],
  live: { project: w.project, collections: [w.collection], mints: { gold: w.mint } },
  ...more,
});

test('a shop item and a bundle are bought in one transaction, and a rolled bundle is collected whole', { skip }, async () => {
  const w = world({ seed: 'play-buy' });
  w.pool(1, w.mint, 1_000n);
  w.upsert({ Item: { id: 1, args: collectible('Sword') } });
  // The sword's listing: the sword and 300 coins of the pool, for the price.
  w.upsert({ Box: { id: 50, args: boxArgs(PRICE, [drop([{ Item: [1] }, fromPool(1, 300n)])]) } });
  // A chest: either entry gives a sword and 200 coins.
  const bundle = drop([{ Item: [1] }, fromPool(1, 200n)]);
  w.upsert({ Box: { id: 51, args: boxArgs(PRICE, [bundle, bundle]) } });
  const spec = specOf(w, { items: [{ key: 'sword', name: 'Sword', id: 1, shopBox: 50 }], boxes: [{ key: 'chest', name: 'Chest', id: 51 }] });
  const { player, app } = playerOf(w, spec);
  const me = player.address;

  const coins = w.balance(me);
  const bought = await app.buy('sword', { listing: (await app.shop()).find((l) => l.key === 'sword') });
  const first = pda.itemAsset(pda.item(w.project, 1), 1);
  assert.equal(bought.asset, first);
  assert.equal(ownerOf(w, first), me);
  assert.equal(w.balance(me), coins - PRICE + 300n);
  assert.deepEqual((await app.claims()).filter((c) => c.kind === 'settle'), [], 'no order to finish');

  const before = w.balance(me);
  const got = await app.openBox('chest', { listing: (await app.boxes()).find((l) => l.key === 'chest') });
  assert.equal(got.won.length, 2);
  assert.deepEqual(got.won[0], { Item: { item: 1, serial: 2 } });
  assert.equal(got.assets[0], pda.itemAsset(pda.item(w.project, 1), 2));
  assert.equal(ownerOf(w, got.assets[0]), me);
  assert.equal(w.balance(me), before - PRICE + 200n);
  assert.equal(w.chain.get(got.order), null, 'settled: the order closed');
});

test('a player pays with NFTs: a payment, a lottery ticket, a contest stake, an auction bid', { skip }, async () => {
  const w = world({ seed: 'play-nft-price' });
  const { collection, mint } = partner(w);
  const rule = { of: { Collection: [collection] }, key: '', test: 'Any' };
  const now = w.chain.now();
  w.upsert({ Item: { id: 2, args: { ...collectible('Potion'), kind: 'Normal' } } });
  w.upsert({ Lottery: { id: 1, args: { price: 0n, mint: w.mint, shares: [], places: [], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(now + 3600), gate: null, nft_ticket: { rule, then: { Stash: [3] } } } } });
  w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id: 1, mint: w.mint, args: { sides: 2, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [], gate: null, nft: rule } })]);
  w.upsert({ Box: { id: 9, args: boxArgs(0n, [drop([{ Item: [2] }])], { active: false }) } });
  const lot = { lot: { Roll: [9] }, reserve: 1n, min_raise_bps: 0, starts_at: BigInt(now), ends_at: BigInt(now + 600), extend: 0, shares: [], gate: null, nft_bids: rule };
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, id: 1, mint: w.mint, args: lot })]);
  const spec = specOf(w, { lotteries: [{ key: 'raffle', name: 'Raffle', id: 1 }], auctions: [{ key: 'mystery', name: 'Mystery lot', id: 1, seller: w.authority }] });
  const p = playerOf(w, spec);
  const q = playerOf(w, spec);
  const [me, rival] = [p.player.address, q.player.address];

  // A payment: the NFT straight to the treasury.
  const paid = mint(me);
  await p.app.payNft(paid, { to: w.treasury });
  assert.equal(ownerOf(w, paid), w.treasury);

  // A lottery ticket: one NFT, into the project's stash.
  const ticket = mint(me);
  await assert.rejects(p.app.buyTickets('raffle', 1, { listing: (await p.app.lotteries()).find((l) => l.key === 'raffle') }), /costs an NFT/);
  await p.app.buyTickets('raffle', 1, { nft: ticket, listing: (await p.app.lotteries()).find((l) => l.key === 'raffle') });
  assert.equal(ownerOf(w, ticket), w.project, 'held until the draw');
  assert.equal(w.chain.get(pda.stash(w.project, 3)), null);
  assert.equal(w.read('Lottery', pda.lottery(w.project, 1)).sold, 1n);

  // A contest of NFTs: the winner's claim takes its own back and the loser's.
  const [mine, theirs] = [mint(me), mint(rival)];
  await p.app.enter(1, 0, 0, { nft: mine });
  await q.app.enter(1, 1, 0, { nft: theirs });
  assert.deepEqual([ownerOf(w, mine), ownerOf(w, theirs)], [w.project, w.project]);
  w.chain.warp(now + 150);
  w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest: w.read('Contest', pda.contest(w.project, 1)), side: 0 })]);
  assert.deepEqual((await q.app.claims()).filter((c) => c.kind === 'contest'), [], 'the loser waits for the winner');
  const [win] = (await p.app.claims()).filter((c) => c.kind === 'contest');
  await p.app.claim(win);
  assert.deepEqual([ownerOf(w, mine), ownerOf(w, theirs)], [me, me]);
  const [closing] = (await q.app.claims()).filter((c) => c.kind === 'contest');
  await q.app.claim(closing);

  // An auction of NFT bids: two top one, which goes back at once; the winner takes the lot.
  const [c, d, e] = [mint(me), mint(rival), mint(rival)];
  await p.app.bid('mystery', null, { nfts: [c] });
  assert.equal((await p.app.auctions())[0].high, '1');
  await q.app.bid('mystery', null, { nfts: [d, e] });
  assert.equal(ownerOf(w, c), me, 'the bid it topped went back');
  w.chain.warp(now + 601);
  const ended = await q.app.endAuction('mystery');
  assert.equal(ended.winner, rival);
  assert.deepEqual([ownerOf(w, d), ownerOf(w, e)], [w.treasury, w.treasury], 'the winning NFTs to the treasury, for the project’s roll');
});
