// What loot 0.23 does in one call that took many, built by js/client and run on the program: several NFTs a call
// (holds, stashes, a farm's seats, makes), a grant voucher of several rounds, a lottery's places as runs and a raffle of
// many NFTs, a contest whose winners share the losers' NFTs, and a burned NFT's Sheet closed by anyone.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { test } from 'node:test';
import { encodeBase58 } from '../chain/base58.js';
import { concat } from '../chain/bytes.js';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit, requestHeapFrame } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { boxArgs, cannotRun, collectible, drop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const names = (record) => record.receipts.map((r) => r.name);

/** An Ed25519 key from a 32-byte seed (a voucher key the test holds). */
function keyFromSeed(seed) {
  const key = createPrivateKey({ key: concat(Uint8Array.from(Buffer.from('302e020100300506032b657004220420', 'hex')), seed), format: 'der', type: 'pkcs8' });
  return { publicKey: encodeBase58(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)), sign: (m) => new Uint8Array(sign(null, m, key)) };
}

t('several NFTs a call: made for three owners, held and released together, stashed with a weight each and taken out', () => {
  const w = world({ seed: 'several-nfts' });
  w.upsert({ Item: { id: 1, args: collectible('Token') } });
  const item = w.read('Item', pda.item(w.project, 1));
  // One make, three owners (one twice), in serial order.
  const [a, b] = [w.who(), w.who()];
  const made = w.chain.send(w.authority, [loot.makeIx({ authority: w.authority, project: w.project, item: 1, itemState: item, owners: [w.player, a, w.player] })]);
  const assets = loot.madeAssets(w.project, 1, item, 3);
  assert.deepEqual(assets.map((x) => ownerOf(w, x)), [w.player, a, w.player]);
  assert.equal(names(made).filter((n) => n === 'PrizeGiven').length, 3);
  // A sold-out item refuses the whole make.
  w.upsert({ Item: { id: 2, args: collectible('Rare', 1) } });
  assert.throws(() => w.chain.send(w.authority, [loot.makeIx({ authority: w.authority, project: w.project, item: 2, itemState: w.read('Item', pda.item(w.project, 2)), owners: [a, b] })]), /PrizeNotCovered/);

  // Three of the player's NFTs on holds of their own, one fee; released together once over.
  const mine = [assets[0], assets[2], w.make(1, w.player)];
  const freeAt = w.chain.now() + 60;
  const [first, ...more] = mine.map((asset) => ({ asset, collection: w.collection }));
  w.chain.send(w.player, [loot.holdIx({ player: w.player, project: w.project, ...first, freeAt, more })]);
  assert.deepEqual(mine.map((x) => ownerOf(w, x)), mine.map(() => w.project));
  w.chain.warp(freeAt);
  const hold = w.read('Hold', pda.hold(mine[0], freeAt));
  assert.deepEqual([hold.player, hold.payer, hold.rent_to], [w.player, w.player, w.player]);
  w.chain.send(w.cranker, [loot.releaseIx({ signer: w.cranker, project: w.project, ...first, hold, more })]);
  assert.deepEqual(mine.map((x) => ownerOf(w, x)), mine.map(() => w.player));
  assert.ok(mine.every((x) => !w.chain.get(pda.hold(x, freeAt))), 'every hold closed');

  // The owner stashes three NFTs, each with its weight, in one call; takes two out in another.
  const stocked = [w.make(1, w.creator), w.make(1, w.creator), w.make(1, w.creator)];
  const [s0, ...sMore] = stocked.map((asset, i) => ({ asset, collection: w.collection, weight: i + 1 }));
  w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, id: 4, ...s0, more: sMore })]);
  const stash = loot.decodeStash(w.chain.get(pda.stash(w.project, 4)).data);
  assert.deepEqual(stocked.map((x) => stash.weights[stash.nfts.indexOf(x)]), [1, 2, 3]);
  w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, id: 4, asset: stocked[0], collection: w.collection, out: w.creator, more: [{ asset: stocked[1], collection: w.collection }] })]);
  assert.deepEqual(loot.decodeStash(w.chain.get(pda.stash(w.project, 4)).data).nfts, [stocked[2]]);
  assert.deepEqual([ownerOf(w, stocked[0]), ownerOf(w, stocked[1])], [w.creator, w.creator]);
});

t('a farm of collectibles takes three NFTs, pays their rewards and lets them out, a call each', () => {
  const w = world({ seed: 'several-seats' });
  w.pool(6, w.mint, 10n * PRICE);
  w.upsert({ Item: { id: 1, args: collectible('Miner') } });
  const args = { custody: 'Escrow', rewards_pool: 6, tiers: [{ lock: 60, bps: 10_000 }], boosts: [], max_boost_bps: 0, gate: null };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 2, args, rewardsMint: w.mint })]);
  const farm = w.read('Farm', pda.farm(w.project, 2));
  w.tokenAccount(w.player, w.mint);
  const miners = [w.make(1, w.player), w.make(1, w.player), w.make(1, w.player)];
  const [first, ...more] = miners.map((asset) => ({ asset, collection: w.collection }));
  const staked = w.chain.send(w.player, [computeUnitLimit(1_400_000), loot.stakeNftIx({ player: w.player, project: w.project, id: 2, farm, ...first, more })]);
  assert.equal(names(staked).filter((n) => n === 'Seated').length, 3);
  assert.deepEqual(miners.map((x) => ownerOf(w, x)), miners.map(() => w.project));
  w.chain.warp(w.chain.now() + 61);
  const harvested = w.chain.send(w.player, [loot.harvestIx({ player: w.player, project: w.project, id: 2, farm, by: miners[0], more: miners.slice(1).map((by) => ({ by })) })]);
  assert.equal(names(harvested).filter((n) => n === 'Harvested').length, 3, 'three seats, one call, one transfer');
  const out = w.chain.send(w.player, [computeUnitLimit(1_400_000), loot.unstakeNftIx({ player: w.player, project: w.project, id: 2, farm, ...first, more })]);
  assert.equal(names(out).filter((n) => n === 'Unseated').length, 3);
  assert.deepEqual(miners.map((x) => ownerOf(w, x)), miners.map(() => w.player));
});

t('a voucher of several rounds pays each once, in one claim; a grant keeps its records in shards', () => {
  const w = world({ seed: 'several-rounds' });
  w.pool(1, w.mint, 100n);
  const signer = keyFromSeed(new Uint8Array(32).fill(3));
  const limits = { wallet: { total: 0, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 1, args: { gives: { Tokens: { from: { Pool: [1] }, amount: { Fixed: [5n] } } }, vouchers: [signer.publicKey, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, shard_bits: 2 } } });
  const address = pda.grant(w.project, 1);
  w.chain.airdrop(address, 1_000_000_000n);
  const grant = w.read('Grant', address);
  assert.equal(grant.shard_bits, 2);
  const wallet = w.who();
  const rounds = [1, 2, 3].map((n) => ({ id: new Uint8Array(16).fill(n), amount: n === 3 ? 2n : 0n }));
  const expires = BigInt(w.chain.now() + 600);
  const voucher = (list) => {
    const message = loot.voucherBytes({ grant: address, incarnation: grant.incarnation, wallet, personHash: null, rounds: list, expires });
    return loot.ed25519Ix({ publicKey: signer.publicKey, signature: signer.sign(message), message });
  };
  const claim = (list) => loot.claimGrantIx({ project: w.project, id: 1, grant: w.read('Grant', address), wallet, signer: wallet, rounds: list, expires, poolMint: w.mint, voucherKey: signer.publicKey,
    paidRounds: loot.readListAccount(w.chain.get(pda.rounds(address, grant.incarnation, loot.walletShard(grant, wallet)))) });
  const r = w.chain.send(wallet, [computeUnitLimit(loot.CLAIM_COMPUTE_UNITS), voucher(rounds), claim(rounds)]);
  assert.equal(names(r).filter((n) => n === 'GrantClaimed').length, 3, 'one claim, three rounds');
  assert.equal(w.balance(wallet), 5n + 5n + 2n, 'the third names its own amount');
  // Signed again, and with a new round: only the new one pays.
  const again = [...rounds, { id: new Uint8Array(16).fill(4), amount: 0n }];
  const later = w.chain.send(wallet, [computeUnitLimit(loot.CLAIM_COMPUTE_UNITS), voucher(again), claim(again)]);
  assert.equal(names(later).filter((n) => n === 'GrantClaimed').length, 1);
  assert.throws(() => w.chain.send(wallet, [computeUnitLimit(loot.CLAIM_COMPUTE_UNITS), voucher(again), claim(again)]), /AlreadyClaimed/);
  const shard = loot.readListAccount(w.chain.get(pda.rounds(address, grant.incarnation, loot.walletShard(grant, wallet))));
  assert.ok(again.every((x) => loot.roundPaid(shard, wallet, x.id)));
});

t('a lottery’s places as a run, and a raffle of many NFTs drawn from its own stash', () => {
  const w = world({ seed: 'runs-raffle' });
  w.upsert({ Item: { id: 1, args: collectible('Art') } });
  const art = [w.make(1, w.creator), w.make(1, w.creator), w.make(1, w.creator)];
  // The three NFTs go into the lottery's own stash in one call, then the lottery is written drawing from them.
  const [s0, ...sMore] = art.map((asset) => ({ asset, collection: w.collection }));
  w.chain.send(w.creator, [loot.stashIx({ signer: w.creator, project: w.project, lottery: 1, ...s0, more: sMore })]);
  const places = [{ bps: 4000, prize: null, times: 1 }, { bps: 2000, prize: 'Raffled', times: 3 }];
  w.upsert({ Lottery: { id: 1, args: { price: 1000n, mint: w.mint, shares: [], places, ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null } } });
  const address = pda.lottery(w.project, 1);
  const lottery = w.read('Lottery', address);
  const buyers = [w.player, w.who(), w.who(), w.who()];
  for (const [i, buyer] of buyers.entries()) {
    if (i) w.fund(buyer, w.mint, 10n * PRICE);
    w.chain.send(buyer, [loot.buyTicketsIx({ player: buyer, project: w.project, id: 1, lottery, round: w.round(1)?.round ?? null, count: 1n })]);
  }
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1, lottery })]);
  const r = w.round(1).round;
  assert.equal(loot.roundWinners(r), 4, 'one place and a run of three');
  const winners = [1, 2, 3].map((p) => r.entries[loot.entryOf(r, loot.ticketOfPlace(r, p))].buyer);
  // A step a raffled place, each NFT drawn as the program draws it; the last sweeps; then each place's pot part pulled.
  const kinds = Object.fromEntries(art.map((x) => [x, { collection: w.collection }]));
  for (let at = w.round(1); at.round.status === 'Drawn'; at = w.round(1)) {
    const stash = loot.decodeStash(w.chain.get(pda.lotteryStash(address)).data);
    w.chain.send(w.cranker, [computeUnitLimit(1_400_000), loot.settleRoundIx({ payer: w.cranker, project: w.project, roundAddress: at.address, round: at.round, projectState: w.projectState(), nfts: kinds, stash })]);
  }
  assert.deepEqual(art.map((x) => ownerOf(w, x)).sort(), [...winners].sort(), 'each raffled place took one NFT');
  w.finishRound(1);
  assert.equal(w.round(1), null, 'every place paid, the round closed');
  assert.equal(w.chain.tokens(pda.pot(address)), 0n, 'the places took the whole pot: 40% and three times 20%');
});

t('a contest of NFTs: the winners share the losers’ NFTs, the extras by time of entry; with a cap the rest go to its opener', () => {
  for (const cap of [null, 1]) {
    const w = world({ seed: `contest-picks-${cap}` });
    w.upsert({ Item: { id: 1, args: collectible('Fighter') } });
    const now = w.chain.now();
    const rule = { of: { Item: [1] }, key: '', test: 'Any' };
    const args = { sides: 2, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [], gate: null, nft: rule, cap };
    w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, projectState: w.projectState(), id: 1, mint: w.mint, args })]);
    const contest = () => w.read('Contest', pda.contest(w.project, 1));
    // Two winners, three losers.
    const players = [w.who(), w.who(), w.who(), w.who(), w.who()];
    const nfts = players.map((p) => w.make(1, p));
    players.forEach((p, i) => w.chain.send(p, [loot.enterIx({ player: p, project: w.project, id: 1, contest: contest(), side: i < 2 ? 0 : 1, nft: { asset: nfts[i], collection: w.collection } })]));
    w.chain.warp(now + 150);
    w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest: contest(), side: 0 })]);
    const c = contest();
    assert.deepEqual([c.share, c.extras, c.picks], cap ? [1, 0, 2] : [1, 1, 3], 'three losers for two winners: 2 and 1, or 1 each with a cap of 1');
    const entries = w.entries(1);
    const losers = entries.map((e, j) => ({ e, j })).filter(({ e }) => e.side === 1);
    const kinds = Object.fromEntries(nfts.map((x) => [x, { collection: w.collection }]));
    // A stranger can't pick a winner's share.
    assert.throws(() => w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, contest: c, entries, player: players[0], nfts: [losers[0].j], kinds })]), /WinnerPicks/);
    // Each winner takes its own back and picks its share.
    let taken = 0;
    for (const winner of players.slice(0, 2)) {
      const list = w.entries(1);
      const me = list.find((e) => e.player === winner);
      const share = loot.shareOf(contest(), me);
      const picks = list.map((e, j) => ({ e, j })).filter(({ e }) => e.side === 1 && Number(e.amount) === 1).slice(0, share).map(({ j }) => j);
      w.chain.send(winner, [computeUnitLimit(1_400_000), loot.claimIx({ payer: winner, project: w.project, projectState: w.projectState(), id: 1, contest: contest(), entries: list, player: winner, nfts: [list.indexOf(me), ...picks], kinds })]);
      taken += picks.length;
    }
    assert.equal(taken, cap ? 2 : 3);
    // What the winners leave goes to the opener: anyone sends it, and the last claim closes the contest.
    const left = w.chain.get(pda.contest(w.project, 1)) ? w.entries(1).map((e, j) => ({ e, j })).filter(({ e }) => e.side === 1 && Number(e.amount) === 1) : [];
    if (left.length) w.chain.send(w.cranker, [computeUnitLimit(1_400_000), loot.claimIx({ payer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, contest: contest(), entries: w.entries(1), player: left[0].e.player, nfts: left.map(({ j }) => j), kinds })]);
    assert.equal(left.length, cap ? 1 : 0);
    assert.equal(w.chain.get(pda.contest(w.project, 1)), null, 'nothing owed: closed');
  }
});

t('anyone closes a burned NFT’s Sheet, its rent to the project’s treasury', () => {
  const w = world({ seed: 'sheet-close' });
  w.upsert({ Item: { id: 1, args: collectible('Pet', 0, { burnable: true }) } });
  const pet = w.make(1, w.player);
  // A Sheet the project's traits wrote for it (anyone proves an NFT's traits into its Sheet).
  const tree = loot.traitsTree([{ nft: pet, attributes: [{ key: 'Class', value: 'Mage' }] }]);
  w.chain.send(w.authority, [loot.setTraitsIx({ signer: w.authority, project: w.project, key: w.collection, root: tree.root })]);
  w.chain.send(w.player, [loot.proveTraitsIx({ signer: w.player, project: w.project, key: w.collection, nft: pet, attributes: [{ key: 'Class', value: 'Mage' }], proof: tree.proof(pet) })]);
  const sheet = pda.sheet(w.project, pet);
  assert.ok(w.chain.get(sheet), 'a Sheet');
  const close = loot.closeSheetIx({ project: w.project, nft: pet, treasury: w.treasury });
  assert.throws(() => w.chain.send(w.cranker, [close]), /NotBurned/);
  w.chain.send(w.authority, [loot.collectibleIx({ authority: w.authority, project: w.project, collection: w.collection, asset: pet, change: 'Burn', owner: w.player })]);
  const had = w.chain.get(w.treasury).lamports;
  w.chain.send(w.cranker, [close]);
  assert.equal(w.chain.get(sheet), null);
  assert.ok(w.chain.get(w.treasury).lamports > had);
});

t('a token exit that would lose what its seat grew writes it first, in the same transaction', () => {
  const w = world({ seed: 'refresh-first' });
  w.pool(5, w.mint, 10n * PRICE);
  const growth = [{ key: 'xp', per_day: 86_400, level: '', steps: [], streak: false, profile: true, at_least: 0n }];
  const args = { custody: 'Freeze', rewards_pool: 5, tiers: [{ lock: 0, bps: 10_000 }], boosts: [], max_boost_bps: 0, gate: null, growth };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, args, rewardsMint: w.mint, stakedMint: w.mint })]);
  const farm = w.read('Farm', pda.farm(w.project, 1));
  w.chain.send(w.player, [loot.stakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: 100n })]);
  w.chain.warp(w.chain.now() + 100);
  const seat = w.read('Seat', pda.seat(pda.farm(w.project, 1), w.player));
  assert.equal(loot.refreshFirst(farm, seat, 100n), true, 'all of it out: the seat closes');
  assert.equal(loot.refreshFirst(farm, seat, 100n, true), false, 'never under forfeit');
  assert.equal(loot.refreshFirst(farm, seat, 0n), false);
  const exit = loot.unstakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: 100n });
  assert.throws(() => w.chain.send(w.player, [exit]), /RefreshFirst/);
  w.chain.send(w.player, [loot.refreshSeatIx({ signer: w.player, project: w.project, id: 1, farm, by: w.player, seat }), exit]);
  const xp = loot.decodeProfile(w.chain.get(pda.profile(w.project, w.player)).data).attributes.find((a) => a.key === 'xp');
  assert.ok(Number(xp.value) >= 100, 'what it grew is on the profile');
});

t('an auction ended with hold leaves its NFT lot in a hold for the winner, which anyone then releases; the ender gets the rent back', () => {
  const w = world({ seed: 'end-hold' });
  w.upsert({ Item: { id: 1, args: collectible('Painting') } });
  const seller = w.who();
  const art = w.make(1, seller);
  const now = w.chain.now();
  w.chain.send(seller, [loot.openAuctionIx({ seller, project: w.project, collection: w.collection, id: 1, mint: w.mint, args: { lot: { Asset: [art] }, reserve: 10n, min_raise_bps: 500, starts_at: BigInt(now), ends_at: BigInt(now + 600), extend: 0, shares: [], gate: null } })]);
  const address = pda.auction(w.project, seller, 1);
  w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: w.read('Auction', address), amount: 100n })]);
  w.chain.warp(now + 601);
  const ender = w.who();
  w.chain.send(ender, [loot.endAuctionIx({ signer: ender, project: w.project, projectState: w.projectState(), id: 1, auction: w.read('Auction', address), collection: w.collection, hold: true })]);
  const at = pda.hold(art, 0);
  const hold = w.read('Hold', at);
  assert.deepEqual([hold.player, hold.payer], [w.player, ender], 'held for the winner, its rent the ender’s');
  assert.equal(ownerOf(w, art), w.project);
  const [before, rent] = [w.chain.get(ender).lamports, w.chain.get(at).lamports];
  w.chain.send(w.cranker, [loot.releaseIx({ signer: w.cranker, project: w.project, asset: art, collection: w.collection, hold })]);
  assert.equal(ownerOf(w, art), w.player, 'released to the winner');
  assert.equal(w.chain.get(at), null);
  assert.equal(w.chain.get(ender).lamports, before + rent, 'the hold’s rent came back to the ender');
});

t('a box of one entry and 150 draws an open asks for the larger heap: without it the open fails, with it the order is made', () => {
  const w = world({ seed: 'big-open' });
  w.upsert({ Item: { id: 1, args: { ...collectible('Card'), kind: 'Normal' } } });
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([{ Item: [1] }])], { slots: [{ count: 150, only: [], distinct: false }] }) } });
  const box = w.read('LootBox', pda.box(w.project, 1));
  assert.equal(loot.boxHeapFrame(box), loot.LARGE_SETTLE_HEAP);
  assert.equal(loot.boxHeapFrame({ ...box, slots: [{ count: 100 }] }), 0, '100 draws fit');
  const items = { 1: w.read('Item', pda.item(w.project, 1)) };
  const open = (nonce) => loot.openBoxIx({ player: w.player, project: w.project, box, nonce, maxPrice: PRICE, items });
  assert.throws(() => w.chain.send(w.player, [computeUnitLimit(1_400_000), open(1n)]));
  w.chain.send(w.player, [computeUnitLimit(1_400_000), requestHeapFrame(loot.boxHeapFrame(box)), open(2n)]);
  assert.ok(w.chain.get(pda.order(w.project, w.player, 2n)), 'the order is made');
});

test('settle_round gives at most `runs` token runs a call: the rest wait for the next call from the cursor', () => {
  const MINT = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
  const tokens = (n) => ({ bps: 0, prize: { Tokens: { from: { Pool: [n] }, amount: { Fixed: [10n] } } }, times: 1 });
  const r = { status: 'Drawn', lottery: MINT, terms: { mint: MINT, places: [tokens(1), tokens(2), tokens(3)], shares: [], ticket_mint: NOBODY }, sold: 9n, first: 0n, cursor: 0, answer: new Uint8Array(32), entries: [], accounts: [], paid: new Uint8Array(2), prizes: [] };
  const keys = (runs) => loot.settleRoundIx({ payer: MINT, project: MINT, roundAddress: MINT, round: r, projectState: { treasury: MINT }, poolMints: { 1: MINT, 2: MINT, 3: MINT }, runs }).keys.length;
  assert.equal(keys(2) - keys(1), 3, 'one more run: its pool’s mint, the pool, the round’s account of it');
  assert.ok(keys(3) > keys(2), 'all three, and the sweep after them');
});

test('the authority’s mark of a pool’s run carries its mint and pool alone: no round account, sweep or close', () => {
  const MINT = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
  const run = { bps: 0, prize: { Tokens: { from: { Pool: [1] }, amount: { Fixed: [10n] } } }, times: 1 };
  const r = { status: 'Drawn', lottery: MINT, opener: MINT, terms: { mint: MINT, places: [run], shares: [], ticket_mint: NOBODY }, sold: 3n, first: 0n, cursor: 0, owed: 3, answer: new Uint8Array(32), entries: [], accounts: [], paid: new Uint8Array(1), prizes: [] };
  const ix = loot.settleRoundIx({ payer: MINT, project: MINT, roundAddress: MINT, round: r, projectState: { treasury: MINT }, poolMints: { 1: MINT }, hold: true });
  assert.equal(ix.keys.length, 12, 'the 10 named accounts, then the run’s mint and pool');
  assert.equal(ix.keys[11].pubkey, pda.pool(MINT, 1));
});
