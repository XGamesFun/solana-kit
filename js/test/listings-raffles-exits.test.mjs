// Listings, raffles, contest splits, farm exits and sealed schedules, as the client builds them and the real program
// takes them (LiteSVM): listings for sale and for rent, raffles from a lottery's own stash with prizes first and a least
// sale, a contest prize split by stake, farm exits, unbonding, compounding and tolls, and a sealed schedule caught up in
// one transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import * as loot from '../client/index.js';
import { cannotRun, collectible, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const fails = (fn, error) => assert.throws(fn, (e) => (e.logs ?? []).some((l) => l.includes(error)) || String(e.message).includes(error));
const contributionsOf = (w, lottery) => w.chain.svm.getProgramAccounts(loot.LOOT_PROGRAM)
  .filter((a) => a.data[0] === loot.TAGS.LotteryContribution)
  .map((a) => ({ address: a.address, value: loot.decode('LotteryContribution', a.data) }))
  .filter(({ value }) => value.lottery === lottery)
  .sort((x, y) => Number(x.value.first_ticket - y.value.first_ticket));

/** Each contribution's next step until the round is done (prizes first, then the money, then the pot's shares). */
function finishRound(w, id, opts = {}) {
  const address = pda.lottery(w.project, id);
  for (let sent = 0; sent < 50; sent++) {
    const lottery = w.read('Lottery', address);
    const next = contributionsOf(w, address).find(({ value }) => loot.lotteryStep(lottery, value));
    if (!next) return;
    w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id, lottery, contributionAddress: next.address, contribution: next.value, treasury: w.treasury, collection: w.collection, ...opts })]);
  }
  throw new Error('the round never finished');
}

t('a listing sells an NFT at its price, and rents another by the period to one renter at a time', () => {
  const w = world({ seed: 'exits-listings' });
  w.upsert({ Item: { id: 1, args: collectible('Cabin') } });
  const maker = w.who();
  const [sword, cabin] = [w.make(1, maker), w.make(1, maker)];
  // For sale: 3 tokens, 10% to the treasury.
  w.chain.send(maker, [loot.openListingIx({ maker, project: w.project, asset: sword, mint: w.mint, deal: { Sell: { price: 3n * PRICE } }, shares: [{ to: 'Treasury', bps: 1000 }], collection: w.collection })]);
  let listing = w.read('Listing', pda.listing(w.project, sword));
  assert.equal(ownerOf(w, sword), w.project, 'the project holds it while it is listed');
  const buyer = w.who();
  w.fund(buyer, w.mint, 10n * PRICE);
  w.tokenAccount(maker, w.mint);
  const before = w.balance(maker);
  w.chain.send(buyer, [loot.takeListingIx({ taker: buyer, project: w.project, projectState: w.projectState(), listing, collection: w.collection })]);
  assert.equal(ownerOf(w, sword), buyer);
  assert.equal(w.balance(maker) - before, 2_700_000n, 'the price less the treasury’s share');
  assert.equal(w.chain.get(pda.listing(w.project, sword)), null, 'a sale closes the listing');

  // For rent: 1 token a day, up to 7 days at once.
  w.chain.send(maker, [loot.openListingIx({ maker, project: w.project, asset: cabin, mint: w.mint, deal: { Rent: { price: PRICE, lasts: 86_400, max_periods: 7 } }, collection: w.collection })]);
  listing = w.read('Listing', pda.listing(w.project, cabin));
  assert.equal(loot.renterOf(listing, w.chain.now()), null);
  const renter = w.who();
  w.fund(renter, w.mint, 10n * PRICE);
  w.chain.send(renter, [loot.takeListingIx({ taker: renter, project: w.project, listing, periods: 3 })]);
  listing = w.read('Listing', pda.listing(w.project, cabin));
  assert.equal(loot.renterOf(listing, w.chain.now()), renter, 'one account read names the renter');
  assert.equal(w.balance(renter), 7n * PRICE, 'three periods paid');
  const other = w.who();
  w.fund(other, w.mint, 10n * PRICE);
  fails(() => w.chain.send(other, [loot.takeListingIx({ taker: other, project: w.project, listing })]), 'Rented');
  // Closing while a rental runs only stops it: no renter takes it again, and it goes home once the rental is over.
  w.chain.send(maker, [loot.closeListingIx({ maker, project: w.project, listing, collection: w.collection })]);
  assert.equal(w.read('Listing', pda.listing(w.project, cabin)).stopped, true);
  assert.equal(ownerOf(w, cabin), w.project, 'still the renter’s to use');
  w.chain.warp(w.chain.now() + 3 * 86_400 + 1);
  fails(() => w.chain.send(other, [loot.takeListingIx({ taker: other, project: w.project, listing: w.read('Listing', pda.listing(w.project, cabin)) })]), 'ListingStopped');
  assert.equal(loot.renterOf(listing, w.chain.now()), null, 'over');
  w.chain.send(maker, [loot.closeListingIx({ maker, project: w.project, listing, collection: w.collection })]);
  assert.equal(ownerOf(w, cabin), maker, 'home');
});

t('a raffle: the NFT is locked in the lottery’s own stash, given before the seller is paid; a short round refunds', () => {
  const w = world({ seed: 'exits-raffle' });
  w.upsert({ Item: { id: 1, args: collectible('Artwork') } });
  const art = w.make(1, w.creator);
  // The NFT goes into lottery 1's own stash, then the lottery is written naming it.
  w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, lottery: 1, asset: art, collection: w.collection })]);
  const lotteryArgs = (more = {}) => ({ price: PRICE, mint: w.mint, shares: [{ to: 'Treasury', bps: 9000 }], places: [{ bps: 0, prize: { Held: [art] } }], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null, ...more });
  w.upsert({ Lottery: { id: 1, args: lotteryArgs() } });
  // Promised: it can't leave while a place names it.
  fails(() => w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, lottery: 1, asset: art, out: w.creator, collection: w.collection })]), 'Promised');
  const rival = w.who();
  w.fund(rival, w.mint, 10n * PRICE);
  const address = pda.lottery(w.project, 1);
  for (const buyer of [w.player, rival]) w.chain.send(buyer, [loot.buyTicketsIx({ player: buyer, project: w.project, id: 1, lottery: w.read('Lottery', address), mint: w.mint, count: 2n, nonce: 1n })]);
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1 })]);
  const lottery = w.read('Lottery', address);
  assert.equal(lottery.status, 'Drawn');
  // Money waits for the prize: finishing a contribution that won nothing is refused until the NFT is given.
  const loser = contributionsOf(w, address).find(({ value }) => loot.lotteryStep(lottery, value) !== 'prizes');
  fails(() => w.chain.send(w.cranker, [loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 1, lottery: { ...lottery, given: 1 }, contributionAddress: loser.address, contribution: loser.value, treasury: w.treasury })]), 'PrizesFirst');
  const winner = contributionsOf(w, address).find(({ value }) => loot.lotteryStep(lottery, value) === 'prizes').value.player;
  const treasuryBefore = w.balance(w.treasury);
  finishRound(w, 1, { nfts: { [art]: { collection: w.collection } } });
  assert.equal(ownerOf(w, art), winner, 'the winner has the NFT');
  assert.equal(w.balance(w.treasury) - treasuryBefore, 3_600_000n, 'then the seller is paid (90% of 4 tickets)');

  // A least sale: 5 tickets wanted, 1 sold, so the draw cancels the round and the buyer is refunded.
  const art2 = w.make(1, w.creator);
  w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, lottery: 2, asset: art2, collection: w.collection })]);
  w.upsert({ Lottery: { id: 2, args: lotteryArgs({ places: [{ bps: 0, prize: { Held: [art2] } }], min_sold: 5n }) } });
  const second = pda.lottery(w.project, 2);
  const held = w.balance(w.player);
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 2, lottery: w.read('Lottery', second), mint: w.mint, count: 1n, nonce: 2n })]);
  w.chain.warp(w.chain.now() + 3601);
  const short = w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 2 })]);
  assert.equal(short.receipts.find((r) => r.name === 'LotteryCancelled').data.short, true);
  assert.equal(short.answers?.length ?? 0, 0, 'no oracle asked');
  finishRound(w, 2);
  assert.equal(w.balance(w.player), held, 'refunded');
  w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, lottery: 2, asset: art2, out: w.creator, collection: w.collection })]);
  assert.equal(ownerOf(w, art2), w.creator, 'the seller takes it back once the lottery has ended');
});

t('a contest’s token prize is set aside at the decision and split by what each winner put in', () => {
  const w = world({ seed: 'exits-split' });
  w.pool(2, w.mint, 600n);
  const prize = { Tokens: { from: { Pool: [2] }, amount: { Fixed: [600n] } } };
  const now = w.chain.now();
  const args = { sides: 1, closes_at: BigInt(now + 100), result_by: BigInt(now + 1000), shares: [{ to: 'Treasury', bps: 10_000 }], gate: null, prize, prize_split: true };
  w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id: 1, mint: w.mint, args, prizeMint: w.mint })]);
  let contest = w.read('Contest', pda.contest(w.project, 1));
  const rival = w.who();
  w.fund(rival, w.mint, 10n * PRICE);
  w.chain.send(w.player, [loot.enterIx({ player: w.player, project: w.project, id: 1, contest, side: 0, amount: PRICE })]);
  w.chain.send(rival, [loot.enterIx({ player: rival, project: w.project, id: 1, contest, side: 0, amount: 2n * PRICE })]);
  w.chain.warp(now + 101);
  contest = w.read('Contest', pda.contest(w.project, 1));
  const decided = w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, projectState: w.projectState(), contest, side: 0, prizeMint: w.mint })]);
  assert.equal(decided.receipts.find((r) => r.name === 'Decided').data.set_aside, 600n);
  const [p0, r0] = [w.balance(w.player), w.balance(rival)];
  for (const player of [rival, w.player]) {
    contest = w.read('Contest', pda.contest(w.project, 1));
    w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, id: 1, contest, player, side: 0, prizeMint: w.mint })]);
  }
  assert.equal(w.balance(w.player) - p0, 200n, 'one part in three');
  assert.equal(w.balance(rival) - r0, 400n, 'two parts in three');
});

t('a farm of tokens: an early exit for a fee, an unbonding wait, compounding that keeps the lock, and a toll', () => {
  const w = world({ seed: 'exits-farm' });
  w.pool(3, w.mint, 0n);
  // Exit fees go to a pool of their own here; to the rewards pool, the stayers would share them.
  w.pool(4, w.mint, 0n);
  const args = {
    custody: 'Escrow', rewards_pool: 3, tiers: [{ lock: 3600, bps: 10_000, exit_bps: 1000 }, { lock: 3600, bps: 10_000 }], boosts: [], max_boost_bps: 0,
    exit_to: { Pool: [4] }, unbond: 60, toll: { bps: 500, to: 'Burn' },
  };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, args, rewardsMint: w.mint, stakedMint: w.mint })]);
  const farmAddress = pda.farm(w.project, 1);
  const farm = w.read('Farm', farmAddress);
  // The player locks in the tier with no early exit; a leaver takes the one that has one.
  const leaver = w.who();
  w.fund(leaver, w.mint, 10n * PRICE);
  // Funded before the stakes: the first counts it, and the farm releases it over a day (its locks are shorter).
  w.fund(w.creator, w.mint, 2_000n);
  w.payIn(w.creator, w.mint, 2_000n, [{ to: { Pool: [3] }, bps: 10_000 }]);
  w.chain.send(w.player, [loot.stakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: 10n * PRICE, tier: 1 })]);
  w.chain.send(leaver, [loot.stakeTokensIx({ player: leaver, project: w.project, id: 1, farm, amount: 10n * PRICE, tier: 0 })]);
  w.chain.warp(w.chain.now() + 1800);
  // Compounding keeps the lock, and pays the toll.
  const since = w.read('Seat', pda.seat(farmAddress, w.player)).since;
  const h = w.chain.send(w.player, [loot.harvestIx({ player: w.player, project: w.project, id: 1, farm, compound: true })]);
  const harvested = h.receipts.find((r) => r.name === 'Harvested').data;
  assert.ok(harvested.compounded > 0n && harvested.toll === (harvested.compounded + harvested.toll + 19n) / 20n, '5% toll, rounded up');
  const seat = w.read('Seat', pda.seat(farmAddress, w.player));
  assert.equal(seat.amount, 10n * PRICE + harvested.compounded);
  assert.equal(seat.since, since, 'the lock did not restart');
  // A tier with an early exit keeps its rewards until its lock has run (RewardsLocked).
  fails(() => w.chain.send(leaver, [loot.harvestIx({ player: leaver, project: w.project, id: 1, farm })]), 'RewardsLocked');
  // Early, for 10% (and what it was owed): what is taken out waits 60 seconds, earning nothing, then leaves.
  const held = w.balance(leaver);
  const out = w.chain.send(leaver, [loot.unstakeTokensIx({ player: leaver, project: w.project, id: 1, farm, amount: 5n * PRICE })]);
  assert.equal(out.receipts.find((r) => r.name === 'Unseated').data.fee, 500_000n);
  assert.equal(w.chain.tokens(pda.pool(w.project, 4)), 500_000n, 'the fee in its pool');
  const left = w.read('Seat', pda.seat(farmAddress, leaver));
  assert.equal(left.leaving, 4_500_000n);
  assert.equal(loot.withdrawable(left, w.chain.now()), 0n);
  w.chain.warp(w.chain.now() + 61);
  assert.equal(loot.withdrawable(left, w.chain.now()), 4_500_000n);
  w.chain.send(leaver, [loot.unstakeTokensIx({ player: leaver, project: w.project, id: 1, farm, amount: 0n })]);
  assert.equal(w.balance(leaver) - held, 4_500_000n, 'the unbonded tokens, and no rewards: leaving early forfeits them');
});

t('a sealed schedule pays from its own vault, catches up in one transaction, and its last run empties it', () => {
  const w = world({ seed: 'exits-sealed' });
  // A wallet someone holds the key of (on the curve): a sealed schedule pays no other.
  const teammate = freshKeypair().address;
  w.tokenAccount(teammate, w.mint);
  const now = w.chain.now();
  const action = { from: { Vest: [w.mint] }, to: { Wallet: [teammate] }, amount: { Fixed: [300n] }, halve_every: 0 };
  w.upsert({ Schedule: { id: 1, args: { active: true, action, every: 60n, next_at: BigInt(now + 60), max_runs: 3 } } });
  const address = pda.schedule(w.project, 1);
  w.chain.send(w.creator, [mintToIx({ mint: w.mint, to: pda.vest(address), authority: w.creator, amount: 1_000n })]);
  // Sealed: no edit.
  fails(() => w.upsert({ Schedule: { id: 1, args: { active: false, action, every: 60n, next_at: BigInt(now + 60), max_runs: 3 } } }), 'Sealed');
  w.chain.warp(now + 60 * 3 + 5);
  const schedule = w.read('Schedule', address);
  const due = loot.runsDue(schedule, w.chain.now());
  assert.equal(due, 3);
  const run = () => loot.runScheduleIx({ payer: w.cranker, project: w.project, id: 1, schedule });
  w.chain.send(w.cranker, Array.from({ length: due }, run));
  assert.equal(w.balance(teammate), 1_000n, 'two runs of 300, then the last pays the rest');
  assert.equal(w.chain.tokens(pda.vest(address)), 0n);
});
