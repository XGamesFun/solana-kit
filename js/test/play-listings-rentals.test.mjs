// Listings, rentals, raffles, unbonding and sealed schedules through js/play, against the real program: a rental listed
// and taken, its renter read with one account and its NFT home once it is over; a raffle whose winner gets the NFT
// before the seller is paid, each step offered by claims(); tokens out of an unbonding farm once their wait is over;
// and a sealed schedule's vested runs claimed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { mintToIx } from '../chain/token.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;

function fixture(seed) {
  const w = world({ seed });
  w.upsert({ Item: { id: 1, args: collectible('Cabin') } });
  const spec = {
    version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }],
    live: { project: w.project, collection: w.collection },
    farms: [{ key: 'vault', name: 'Vault', id: 1, stakes: 'coin' }],
    schedules: [{ key: 'team', name: 'Team vesting', id: 1 }],
    lotteries: [{ key: 'raffle', name: 'Artwork raffle', id: 1 }],
  };
  const appOf = (address) => solanaApp({ spec, rpc: w.chain.rpc, wallet: { address, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  return { w, spec, appOf };
}
/** Sends every claim a wallet has until none is left (at most `rounds`). */
async function claimAll(app, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    const [c] = await app.claims();
    if (!c) return;
    await app.claim(c);
  }
}

test('a rental: listed, taken for two periods, its renter read, and its NFT home once it is over', { skip }, async () => {
  const { w, appOf } = fixture('play-rent');
  const cabin = w.make(1, w.player);
  const owner = appOf(w.player);
  await owner.listForRent(cabin, { price: 1, lasts: 100, maxPeriods: 2 });
  const renter = w.who();
  w.fund(renter, w.mint, 5n * PRICE);
  await appOf(renter).rentListing(cabin, { periods: 2, listing: await owner.listing(cabin) });
  assert.equal(await owner.rentedTo(cabin), renter);
  assert.ok(!(await owner.claims()).some((c) => c.kind === 'unlist'), 'nothing to do while it runs');
  w.chain.warp(w.chain.now() + 201);
  assert.equal(await owner.rentedTo(cabin), null);
  const [c] = (await owner.claims()).filter((x) => x.kind === 'unlist');
  await owner.claim(c);
  assert.equal(ownerOf(w, cabin), w.player);
});

test('a raffle through the page: the winner’s NFT first, then the seller’s money, each step a claim', { skip }, async () => {
  const { w, appOf } = fixture('play-raffle');
  const art = w.make(1, w.creator);
  const seller = appOf(w.creator);
  await seller.raffle(1, art, { price: 1, drawsAt: w.chain.now() + 3600 });
  const buyers = [w.player, w.who()];
  w.fund(buyers[1], w.mint, 5n * PRICE);
  for (const b of buyers) await appOf(b).buyTickets('raffle', 2, { listing: (await appOf(b).lotteries()).find((l) => l.key === 'raffle') });
  w.chain.warp(w.chain.now() + 3601);
  const before = w.balance(w.creator);
  await claimAll(appOf(w.cranker));
  const winner = ownerOf(w, art);
  assert.ok(buyers.includes(winner), 'a buyer won the NFT');
  assert.equal(w.balance(w.creator) - before, 4n * PRICE, 'and the seller was paid every ticket');
});

test('an unbonding farm’s tokens come out once their wait is over; a sealed schedule’s vested runs are claimed', { skip }, async () => {
  const { w, appOf } = fixture('play-wait');
  w.pool(3, w.mint, 0n);
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, rewardsMint: w.mint, stakedMint: w.mint,
    args: { custody: 'Escrow', rewards_pool: 3, tiers: [{ lock: 0, bps: 10_000 }], boosts: [], max_boost_bps: 0, unbond: 600 } })]);
  // A wallet someone holds the key of (on the curve): a sealed schedule pays no other.
  const me = freshKeypair().address;
  w.chain.airdrop(me, 10_000_000_000n);
  w.fund(me, w.mint, 100n * PRICE);
  const app = appOf(me);
  await app.stake('vault', 10);
  await app.unstake('vault', 4);
  assert.ok(!(await app.claims()).some((c) => c.kind === 'withdraw'), 'still waiting');
  // Vesting for the player, sealed: nothing for a minute, then 3 runs a minute apart.
  const now = w.chain.now();
  const action = { from: { Vest: [w.mint] }, to: { Wallet: [me] }, amount: { Fixed: [2n * PRICE] }, halve_every: 0 };
  w.upsert({ Schedule: { id: 1, args: { active: true, action, every: 60n, next_at: BigInt(now + 60), max_runs: 3 } } });
  w.chain.send(w.creator, [mintToIx({ mint: w.mint, to: loot.pda.vest(loot.pda.schedule(w.project, 1)), authority: w.creator, amount: 6n * PRICE })]);
  w.chain.warp(now + 601);
  const held = w.balance(me);
  const kinds = (await app.claims()).map((c) => c.kind);
  assert.ok(kinds.includes('withdraw') && kinds.includes('vest'), kinds.join());
  await claimAll(app);
  assert.equal(w.balance(me) - held, 4n * PRICE + 6n * PRICE, 'the unbonded 4 and all 3 vested runs');
});

test('moving a stake onto a tier whose rewards wait for its lock harvests first, in the same transaction', { skip }, async () => {
  const { w, appOf } = fixture('play-harvest-first');
  w.pool(3, w.mint, 0n);
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, rewardsMint: w.mint, stakedMint: w.mint,
    args: { custody: 'Escrow', rewards_pool: 3, tiers: [{ lock: 0, bps: 10_000 }, { lock: 3600, bps: 20_000, exit_bps: 1000 }], boosts: [], max_boost_bps: 0, exit_to: 'Burn' } })]);
  const app = appOf(w.player);
  // Funded before the stake, which counts it: the farm releases it over a day, its longest lock being shorter.
  w.fund(w.creator, w.mint, 1_000n);
  w.payIn(w.creator, w.mint, 1_000n, [{ to: { Pool: [3] }, bps: 10_000 }]);
  await app.stake('vault', 10, 0);
  w.chain.warp(w.chain.now() + 86_401);
  const held = w.balance(w.player);
  await app.stake('vault', 1, 1);
  // It staked 1 more and was paid what it was owed (the 1,000 released, less rounding) in the same transaction.
  const paid = w.balance(w.player) - held + PRICE;
  assert.ok(paid >= 999n && paid <= 1_000n, `paid ${paid}`);
  assert.equal(w.read('Seat', loot.pda.seat(loot.pda.farm(w.project, 1), w.player)).tier, 1);
});
