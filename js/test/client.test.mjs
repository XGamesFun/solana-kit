// The JS client against the real program: every instruction built by js/client, sent to the pinned loot.so (or a
// build's, with XSOLANA_PROGRAM_DIR) in LiteSVM, and its effect read back. A wrong account, flag or byte fails here the way it would on chain.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { MPL_CORE_PROGRAM, parseCoreAsset } from '../chain/core.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { closeTokenAccount, computeUnitLimit, meta } from '../chain/programs.js';
import { setAuthorityIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { newAddress } from '../sim/chain.mjs';
import { boxArgs, cannotRun, collectible, drop, FEES, fromPool, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun();
const t = (name, fn) => test(name, { skip: skip ?? false }, fn);
const pda = loot.pda;
const fails = (fn, why) => assert.throws(fn, (e) => (why ? String(e.message).includes(why) || (e.logs ?? []).join('\n').includes(why) : true), why);
const names = (record) => record.receipts.map((r) => r.name);
/** A lottery's open contributions, in ticket order: [{ address, value }]. */
const contributionsOf = (w, lottery) => w.chain.svm.getProgramAccounts(loot.LOOT_PROGRAM)
  .filter((a) => a.data[0] === loot.TAGS.LotteryContribution)
  .map((a) => ({ address: a.address, value: loot.decode('LotteryContribution', a.data) }))
  .filter(({ value }) => value.lottery === lottery)
  .sort((x, y) => Number(x.value.first_ticket - y.value.first_ticket));

/** A Core asset of any collection, made by its update authority `maker` for `owner` (Core CreateV2). */
function coreAsset(w, collection, maker, owner, name = 'Outside Ape') {
  const asset = newAddress(w.random);
  const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
  const data = concat(Uint8Array.of(20, 0), str(name), str('https://example.invalid/ape.json'), Uint8Array.of(0, 0));
  const ix = {
    programId: MPL_CORE_PROGRAM,
    keys: [
      meta(asset, true, true),
      meta(collection, false, true),
      meta(maker, true, false),
      meta(maker, true, true),
      meta(owner, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
      meta(SYSTEM_PROGRAM, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
    ],
    data,
  };
  w.chain.send(maker, [ix]);
  return asset;
}

/** An ed25519 key from a 32-byte seed, as Solana's `Keypair::new_from_array` makes it. */
function keyFromSeed(seed) {
  const key = createPrivateKey({ key: concat(Uint8Array.from(Buffer.from('302e020100300506032b657004220420', 'hex')), seed), format: 'der', type: 'pkcs8' });
  const publicKey = encodeBase58(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { publicKey, sign: (m) => new Uint8Array(sign(null, m, key)) };
}

describe('the platform', () => {
  t('init, set the fee, suspend a project and collect its fees', () => {
    const w = world();
    const p = w.read('Platform', pda.platform());
    assert.equal(p.admin, w.admin);
    assert.deepEqual(p.fees, { player: FEES.player, project: FEES.project });
    // A raise waits 7 days: it is pending.
    w.chain.send(w.admin, [loot.setPlatformIx({ admin: w.admin, fees: { player: 3_000_000n, project: 10_000n } })]);
    assert.equal(w.read('Platform', pda.platform()).pending.player, 3_000_000n);
    w.chain.send(w.admin, [loot.setSuspendedIx({ admin: w.admin, project: w.project, suspended: true })]);
    assert.equal(w.projectState().suspended, true);
    w.chain.send(w.admin, [loot.setSuspendedIx({ admin: w.admin, project: w.project, suspended: false })]);
    // A pay leaves the player fee in the project's fee box, beside the project fee its creation paid;
    // the platform collects both.
    w.payIn(w.player, w.mint, PRICE);
    const to = w.who();
    const before = w.chain.get(to).lamports;
    w.chain.send(w.admin, [loot.collectFeesIx({ admin: w.admin, to, projects: [w.project] })]);
    assert.equal(w.chain.get(to).lamports - before, FEES.player + FEES.project);
  });
});

describe("a project's settings and records", () => {
  t('update the project, open a pool, write and close every kind of record', () => {
    const w = world();
    w.chain.send(w.creator, [loot.updateProjectIx({ owner: w.creator, project: w.project, paused: true })]);
    assert.equal(w.projectState().paused, true);
    const treasury = w.who();
    w.chain.send(w.creator, [loot.updateProjectIx({ owner: w.creator, project: w.project, paused: false, treasury })]);
    assert.equal(w.projectState().treasury, treasury);
    w.treasury = treasury;
    const next = w.who();
    w.chain.send(w.creator, [loot.updateProjectIx({ owner: w.creator, project: w.project, newOwner: next })]);
    assert.equal(w.projectState().owner, next);
    w.chain.send(next, [loot.updateProjectIx({ owner: next, project: w.project, newOwner: w.creator })]);

    w.pool(3, w.mint);
    assert.ok(w.chain.get(pda.pool(w.project, 3)));

    w.upsert({ Item: { id: 7, args: collectible('Sword') } });
    const sched = { active: true, action: { from: { Mint: [w.mint] }, to: 'Burn', amount: { Fixed: [1n] }, halve_every: 0 }, every: 60n, next_at: BigInt(w.chain.now() + 60), max_runs: 0 };
    // A schedule that mints to burn could never run: it is written, and each run checks its move.
    w.upsert({ Schedule: { id: 1, args: sched } });
    w.pool(0, w.mint, 10n * PRICE);
    w.upsert({ Schedule: { id: 1, args: { ...sched, action: { ...sched.action, from: { Pool: [0] } } } } });
    const target = pda.schedule(w.project, 1);
    assert.equal(w.read('Schedule', target).every, 60n);
    const closed = w.chain.send(w.creator, [loot.closeRecordIx({ owner: w.creator, project: w.project, target })]);
    assert.deepEqual(names(closed), ['RecordClosed']);
    assert.equal(w.chain.get(target), null);
  });
});

describe('money in', () => {
  t('pay splits four ways: a pool, a burn, an account and a collectible holder', () => {
    const w = world();
    w.pool(0, w.mint);
    w.upsert({ Item: { id: 1, args: collectible('Track') } });
    const owner = w.who();
    const track = w.make(1, owner);
    w.tokenAccount(owner, w.mint);
    const account = w.tokenAccount(w.who(), w.mint);
    const shares = [
      { to: { Pool: [0] }, bps: 1000 },
      { to: 'Burn', bps: 1000 },
      { to: { Account: [account] }, bps: 1000 },
      { to: { Holder: [track] }, bps: 500 },
    ];
    const r = w.payIn(w.player, w.mint, PRICE, shares, { holders: { [track]: owner } });
    assert.deepEqual(names(r), ['Paid']);
    assert.equal(w.chain.tokens(pda.pool(w.project, 0)), PRICE / 10n);
    assert.equal(w.chain.tokens(account), PRICE / 10n);
    assert.equal(w.balance(owner), PRICE / 20n);
  });

  t('a shop item is a box of one entry: given at once, then settled', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Crown', 10) } });
    w.upsert({ Box: { id: 1001, args: boxArgs(PRICE, [itemDrop(1)]) } });
    const box = w.read('LootBox', pda.box(w.project, 1001));
    const r = w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce: 1n })]);
    assert.deepEqual(names(r), ['OrderRolled']);
    assert.equal(r.answers.length, 0);
    const orderAddress = pda.order(w.project, w.player, 1n);
    const order = w.read('Order', orderAddress);
    w.chain.nextSlot();
    const item = w.read('Item', pda.item(w.project, 1));
    w.chain.send(w.player, [loot.settleIx({ signer: w.player, orderAddress, order, projectState: w.projectState(), items: { 1: item } })]);
    const asset = pda.itemAsset(pda.item(w.project, 1), order.won[0].Item.serial);
    assert.equal(w.chain.get(asset).owner, MPL_CORE_PROGRAM);
  });

  t('a rolled box: the oracle answers, prizes come from a pool, and a price above max is refused', () => {
    const w = world();
    w.pool(1, w.mint, 50n * PRICE);
    w.upsert({ Item: { id: 1, args: collectible('Gem') } });
    const entries = [itemDrop(1, 1), drop([fromPool(1, 2n * PRICE)]), drop([], 1, true), drop([])];
    w.upsert({ Box: { id: 1, args: boxArgs(PRICE, entries, { shares: [{ to: { Pool: [1] }, bps: 5000 }] }) } });
    const box = w.read('LootBox', pda.box(w.project, 1));
    fails(() => w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce: 9n, maxPrice: PRICE - 1n })]), 'PriceAboveMax');
    const seen = new Set();
    for (let nonce = 1n; nonce <= 12n; nonce++) {
      const r = w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce })]);
      assert.equal(r.answers.length, 1, 'the oracle answered');
      const orderAddress = pda.order(w.project, w.player, nonce);
      const order = w.read('Order', orderAddress);
      assert.equal(w.chain.get(orderAddress).data.length, loot.ACCOUNT_BYTES.Order);
      assert.equal(order.status, 'Rolled');
      seen.add(order.won.length ? Object.keys(order.won[0])[0] : order.burns ? 'Burn' : 'Nothing');
      w.chain.nextSlot();
      const items = { 1: w.read('Item', pda.item(w.project, 1)) };
      const s = w.chain.send(w.player, [loot.settleIx({ signer: w.player, orderAddress, order, projectState: w.projectState(), items })]);
      assert.ok(names(s).includes('OrderSettled'));
    }
    assert.ok(seen.size >= 3, `several outcomes came up: ${[...seen]}`);
  });

  t("a box's gate and odds read the collectible a player shows", () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Badge') } });
    w.upsert({ Item: { id: 2, args: collectible('Common') } });
    w.upsert({ Item: { id: 3, args: collectible('Legend') } });
    const gate = { Holds: [{ of: { Item: [1] }, key: 'level', test: { AtLeast: [3] } }] };
    const odds = [{ entry: 1, boost: { rule: { of: { Item: [1] }, key: 'level', test: 'Any' }, effect: { PerPoint: { bps: 10_000, most: 9 } } } }];
    w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(2, 99), itemDrop(3, 1)], { gate, odds }) } });
    const box = w.read('LootBox', pda.box(w.project, 1));
    fails(() => w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce: 1n })]), 'GateNotMet');
    const badge = w.make(1, w.player, [{ key: 'level', value: '9' }]);
    const r = w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce: 1n, shown: badge })]);
    assert.equal(r.answers.length, 1);
    assert.ok(r.receipts.some((x) => x.name === 'OddsRaised'), 'the purchase snapshots the badge’s odds boost');
    assert.ok(!r.answers[0].receipts.some((x) => x.name === 'OddsRaised'), 'the roll uses the stored boost');
  });

  t('a rolled order is settled by anyone, a normal item too, and never refunded however long it waits', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Crown') } });
    w.upsert({ Item: { id: 2, args: { ...collectible('Sword'), kind: 'Normal' } } });
    w.upsert({ Box: { id: 1001, args: boxArgs(PRICE, [itemDrop(1)]) } });
    w.upsert({ Box: { id: 1002, args: boxArgs(PRICE, [itemDrop(2)]) } });
    for (const [id, nonce] of [[1001, 1n], [1002, 2n]]) {
      const box = w.read('LootBox', pda.box(w.project, id));
      w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce })]);
    }
    w.chain.nextSlot(1_512_001);
    for (const nonce of [1n, 2n]) {
      const address = pda.order(w.project, w.player, nonce);
      const order = w.read('Order', address);
      fails(() => w.chain.send(w.cranker, [loot.refundIx({ signer: w.cranker, orderAddress: address, order })]), 'BadOrderState');
      const id = order.won[0].Item.item;
      const items = { [id]: w.read('Item', pda.item(w.project, id)) };
      const r = w.chain.send(w.cranker, [loot.settleIx({ signer: w.cranker, orderAddress: address, order, projectState: w.projectState(), items })]);
      assert.deepEqual(names(r), ['OrderSettled']);
    }
  });
});

describe('the authority', () => {
  t('move_tokens: pay out of a pool, mint into one, burn a share of one', () => {
    const w = world();
    w.pool(0, w.mint, 10n * PRICE);
    const to = w.tokenAccount(w.who(), w.mint);
    w.chain.send(w.authority, [loot.moveTokensIx({ authority: w.authority, project: w.project, mint: w.mint, from: { Pool: [0] }, to: { Account: [to] }, amount: { Fixed: [PRICE] } })]);
    assert.equal(w.chain.tokens(to), PRICE);
    w.chain.send(w.authority, [loot.moveTokensIx({ authority: w.authority, project: w.project, mint: w.mint, from: { Pool: [0] }, to: 'Burn', amount: { Bps: [5000] } })]);
    assert.equal(w.chain.tokens(pda.pool(w.project, 0)), (9n * PRICE) / 2n);
    // A mint the project controls: its authority handed to the project.
    const coin = w.newMint(w.creator);
    w.chain.send(w.creator, [setAuthorityIx({ account: coin, current: w.creator, newAuthority: w.project })]);
    w.pool(2, coin);
    const r = w.chain.send(w.authority, [loot.moveTokensIx({ authority: w.authority, project: w.project, mint: coin, from: { Mint: [coin] }, to: { Pool: [2] }, amount: { Fixed: [7n] } })]);
    assert.deepEqual(names(r), ['Moved']);
    assert.equal(w.chain.tokens(pda.pool(w.project, 2)), 7n);
  });

  t('collectible: make with attributes, rewrite them, burn', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Pet', 0, { burnable: true }) } });
    const pet = w.make(1, w.player, [{ key: 'level', value: '2' }]);
    w.chain.send(w.authority, [loot.collectibleIx({ authority: w.authority, project: w.project, collection: w.collection, asset: pet, change: { Set: [[{ key: 'level', value: '3' }]] } })]);
    w.chain.send(w.authority, [loot.collectibleIx({ authority: w.authority, project: w.project, collection: w.collection, asset: pet, change: 'Burn' })]);
    assert.ok(w.chain.get(pet).data.length <= 1, 'burned');
  });

  t('roll asks the oracle; its answer lands', () => {
    const w = world();
    const r = w.chain.send(w.authority, [loot.rollIx({ authority: w.authority, project: w.project, reference: 'match-1' })]);
    assert.equal(r.answers.length, 1);
    assert.deepEqual(names(r.answers[0]), ['Rolled']);
  });
});


describe('offers', () => {
  t('a bid buys any sword of the item; a loan is repaid by a friend, another goes to its lender once due; a call-off refunds', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Sword') } });
    const owner = (asset) => parseCoreAsset(w.chain.get(asset).data).owner;
    const maker = w.who();
    w.fund(maker, w.mint, 10n * PRICE);
    const rule = { of: { Item: [1] }, key: '', test: 'Any' };
    w.chain.send(maker, [loot.openOfferIx({ maker, project: w.project, id: 1, mint: w.mint, args: { rule, deal: { Buy: { price: PRICE } }, left: 2, shares: [{ to: 'Burn', bps: 1_000 }] } })]);
    let offer = w.read('Offer', pda.offer(w.project, maker, 1));
    assert.equal(loot.dealUnit(offer.deal), PRICE);
    const a = w.make(1, w.player);
    const had = w.balance(w.player);
    const r = w.chain.send(w.player, [loot.sellToOfferIx({ seller: w.player, project: w.project, id: 1, offer, asset: a, collection: w.collection })]);
    assert.ok(names(r).includes('SoldToOffer'));
    assert.equal(owner(a), maker);
    assert.equal(w.balance(w.player) - had, (PRICE * 9n) / 10n);
    offer = w.read('Offer', pda.offer(w.project, maker, 1));
    w.chain.send(maker, [loot.closeOfferIx({ maker, project: w.project, id: 1, offer })]);
    assert.equal(w.balance(maker), 9n * PRICE, 'the second take back');

    w.chain.send(maker, [loot.openOfferIx({ maker, project: w.project, id: 2, mint: w.mint, args: { rule, deal: { Lend: { amount: PRICE, repay: 2n * PRICE, lasts: 3600 } }, left: 2 } })]);
    offer = w.read('Offer', pda.offer(w.project, maker, 2));
    const [x, y] = [w.make(1, w.player), w.make(1, w.player)];
    const due = w.chain.now() + 3600;
    w.chain.send(w.player, [loot.borrowIx({ borrower: w.player, project: w.project, id: 2, offer, due, asset: x, collection: w.collection })]);
    offer = w.read('Offer', pda.offer(w.project, maker, 2));
    w.chain.send(w.player, [loot.borrowIx({ borrower: w.player, project: w.project, id: 2, offer, due: due - 1, asset: y, collection: w.collection })]);
    assert.equal(w.chain.get(pda.offer(w.project, maker, 2)), null, 'both loans made');
    assert.equal(w.chain.get(pda.hold(x, due)).data.length, loot.ACCOUNT_BYTES.Hold);
    const friend = w.who();
    w.fund(friend, w.mint, 2n * PRICE);
    const hold = w.read('Hold', pda.hold(x, due));
    assert.equal(hold.debt.lender, maker);
    // Repaying moves only the money; the release in the same transaction sends the NFT home.
    w.chain.send(friend, [loot.repayIx({ payer: friend, project: w.project, hold }), loot.releaseIx({ signer: friend, project: w.project, collection: w.collection, asset: x, hold })]);
    assert.equal(owner(x), w.player);
    w.chain.warp(due);
    const late = w.read('Hold', pda.hold(y, due - 1));
    w.chain.send(w.cranker, [loot.releaseIx({ signer: w.cranker, project: w.project, collection: w.collection, asset: y, hold: late, to: maker })]);
    assert.equal(owner(y), maker);
    assert.equal(w.balance(maker), 9n * PRICE - 2n * PRICE + 2n * PRICE);
  });
});

describe('holds and contests', () => {
  t('hold a collectible; the authority awards it while the hold runs; anyone sends one home after', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Fighter') } });
    const a = w.make(1, w.player);
    const freeAt = w.chain.now() + 3600;
    w.chain.send(w.player, [loot.holdIx({ player: w.player, project: w.project, collection: w.collection, asset: a, freeAt })]);
    assert.equal(w.chain.get(pda.hold(a, freeAt)).data.length, loot.ACCOUNT_BYTES.Hold);
    const hold = w.read('Hold', pda.hold(a, freeAt));
    const winner = w.who();
    w.chain.send(w.authority, [loot.releaseIx({ signer: w.authority, project: w.project, collection: w.collection, asset: a, hold, to: winner })]);
    const b = w.make(1, w.player);
    const freeB = w.chain.now() + 60;
    w.chain.send(w.player, [loot.holdIx({ player: w.player, project: w.project, collection: w.collection, asset: b, freeAt: freeB })]);
    const hb = w.read('Hold', pda.hold(b, freeB));
    w.chain.warp(w.chain.now() + 61);
    const r = w.chain.send(w.cranker, [loot.releaseIx({ signer: w.cranker, project: w.project, collection: w.collection, asset: b, hold: hb })]);
    assert.deepEqual(names(r), ['Released']);
  });

  t('a contest: open, enter both sides, decide, claim; another called off pays everyone back', () => {
    const w = world();
    const now = w.chain.now();
    const args = { sides: 2, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [{ to: 'Burn', bps: 500 }], gate: null };
    w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id: 1, mint: w.mint, args })]);
    let contest = w.read('Contest', pda.contest(w.project, 1));
    const rival = w.who();
    w.fund(rival, w.mint, 10n * PRICE);
    w.chain.send(w.player, [loot.enterIx({ player: w.player, project: w.project, id: 1, contest, side: 0, amount: PRICE })]);
    assert.equal(w.chain.get(pda.entry(pda.contest(w.project, 1), w.player)).data.length, loot.ACCOUNT_BYTES.Entry);
    w.chain.send(rival, [loot.enterIx({ player: rival, project: w.project, id: 1, contest, side: 1, amount: PRICE })]);
    w.chain.warp(now + 150);
    contest = w.read('Contest', pda.contest(w.project, 1));
    w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest, side: 0 })]);
    const had = w.balance(w.player);
    contest = w.read('Contest', pda.contest(w.project, 1));
    w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, id: 1, contest, player: w.player, side: 0 })]);
    assert.equal(w.balance(w.player) - had, (2n * PRICE * 95n) / 100n);
    contest = w.read('Contest', pda.contest(w.project, 1));
    w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, id: 1, contest, player: rival, side: 1 })]);

    const args2 = { ...args, closes_at: BigInt(now + 1000), result_by: BigInt(now + 2000) };
    w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id: 2, mint: w.mint, args: args2 })]);
    let c2 = w.read('Contest', pda.contest(w.project, 2));
    w.chain.send(w.player, [loot.enterIx({ player: w.player, project: w.project, id: 2, contest: c2, side: 1, amount: PRICE })]);
    c2 = w.read('Contest', pda.contest(w.project, 2));
    w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest: c2, side: null })]);
    const before = w.balance(w.player);
    c2 = w.read('Contest', pda.contest(w.project, 2));
    w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, id: 2, contest: c2, player: w.player, side: 1 })]);
    assert.equal(w.balance(w.player) - before, PRICE);
  });

  t('a bounty: the decision names the worker its chosen share pays, a decider’s verdict signs them too', () => {
    const w = world();
    const now = w.chain.now();
    const server = keyFromSeed(new Uint8Array(32).fill(7));
    const args = { sides: 1, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [{ to: { Chosen: { item: null } }, bps: 9_000 }], gate: null, deciders: [server.publicKey] };
    for (const id of [1, 2]) {
      w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, id, mint: w.mint, args })]);
      w.chain.send(w.player, [loot.enterIx({ player: w.player, project: w.project, id, contest: w.read('Contest', pda.contest(w.project, id)), side: 0, amount: PRICE })]);
    }
    w.chain.warp(now + 150);
    const worker = w.who();
    let contest = w.read('Contest', pda.contest(w.project, 1));
    fails(() => w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest, side: 0 })]), 'BadChoice');
    w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest, side: 0, recipient: worker })]);
    assert.equal(w.balance(worker), (PRICE * 9n) / 10n);

    contest = w.read('Contest', pda.contest(w.project, 2));
    const expires = BigInt(now + 180);
    const message = loot.verdictBytes({ contest: pda.contest(w.project, 2), incarnation: contest.incarnation, side: 0, expires, recipient: worker });
    const check = loot.ed25519Ix({ publicKey: server.publicKey, signature: server.sign(message), message });
    const decide = (recipient) => loot.decideIx({ signer: w.cranker, project: w.project, contest, side: 0, recipient, verdict: { expires } });
    fails(() => w.chain.send(w.cranker, [check, decide(w.who())]), 'WrongVoucherBytes');
    w.chain.send(w.cranker, [check, decide(worker)]);
    assert.equal(w.balance(worker), (PRICE * 9n) / 5n);
  });
});

describe('auctions', () => {
  t('an item auction: bids top each other and the outbid get their tokens back at once, a late bid extends, the end mints for the winner', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Sunset', 1) } });
    w.pool(0);
    const now = w.chain.now();
    const args = { lot: { Item: [1] }, reserve: PRICE, min_raise_bps: 500, starts_at: BigInt(now), ends_at: BigInt(now + 3_600), extend: 600, shares: [{ to: { Pool: [0] }, bps: 1_000 }], gate: null };
    const opened = w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, collection: w.collection, id: 1, mint: w.mint, args })]);
    assert.deepEqual(names(opened), ['AuctionOpened']);
    const read = () => w.read('Auction', pda.auction(w.project, w.authority, 1));
    const rival = w.who();
    w.fund(rival, w.mint, 10n * PRICE);
    const had = w.balance(w.player);

    w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: read(), amount: PRICE })]);
    assert.equal(loot.leastBid(read()), (PRICE * 105n) / 100n);
    fails(() => w.chain.send(rival, [loot.bidIx({ bidder: rival, project: w.project, id: 1, auction: read(), amount: loot.leastBid(read()) - 1n })]), 'BidTooLow');
    const topped = w.chain.send(rival, [loot.bidIx({ bidder: rival, project: w.project, id: 1, auction: read(), amount: 2n * PRICE })]);
    assert.deepEqual(names(topped), ['BidRefunded', 'BidPlaced']);
    assert.equal(w.balance(w.player), had, 'the outbid player has every token back');

    // A bidder who spent all they had closes their account: the bid that tops theirs opens it again.
    const third = w.who();
    w.fund(third, w.mint, 3n * PRICE);
    w.chain.send(third, [loot.bidIx({ bidder: third, project: w.project, id: 1, auction: read(), amount: 3n * PRICE })]);
    w.chain.send(third, [closeTokenAccount(loot.ata(third, w.mint), third, third)]);
    w.chain.warp(now + 3_500);
    w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: read(), amount: 4n * PRICE })]);
    assert.equal(w.balance(third), 3n * PRICE);
    assert.equal(loot.auctionEnds(read()), BigInt(now + 3_500 + 600), 'a late bid moved the end');
    w.chain.send(rival, [loot.bidIx({ bidder: rival, project: w.project, id: 1, auction: read(), amount: 5n * PRICE })]);
    w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: read(), amount: 6n * PRICE })]);

    fails(() => w.chain.send(w.cranker, [loot.endAuctionIx({ signer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, auction: read(), item: w.read('Item', pda.item(w.project, 1)), now: w.chain.now() })]), 'AuctionRunning');
    w.chain.warp(now + 4_200);
    const asset = pda.itemAsset(pda.item(w.project, 1), read().serial);
    const ended = w.chain.send(w.cranker, [loot.endAuctionIx({ signer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, auction: read(), item: w.read('Item', pda.item(w.project, 1)), now: w.chain.now() })]);
    assert.deepEqual(names(ended), ['AuctionEnded']);
    assert.equal(ended.receipts[0].data.winner, w.player);
    assert.equal(w.chain.get(asset).owner, MPL_CORE_PROGRAM);
    assert.equal(w.balance(w.player), had - 6n * PRICE);
    assert.equal(w.balance(rival), 10n * PRICE);
    assert.equal(w.chain.tokens(pda.pool(w.project, 0)), (6n * PRICE) / 10n);
    assert.equal(w.chain.get(pda.auction(w.project, w.authority, 1)), null, 'closed');
  });

  t("a player puts their collectible up alone; with no bid it goes home; one nobody ends still sells", () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Painting') } });
    const seller = w.who();
    const send = (now, id, lot) =>
      w.chain.send(seller, [loot.openAuctionIx({ seller, project: w.project, collection: w.collection, id, mint: w.mint, args: { lot, reserve: 0n, min_raise_bps: 0, starts_at: BigInt(now), ends_at: BigInt(now + 60), extend: 0, shares: [], gate: null } })]);
    const end = (id) => w.chain.send(w.cranker, [loot.endAuctionIx({ signer: w.cranker, project: w.project, projectState: w.projectState(), id, auction: w.read('Auction', pda.auction(w.project, seller, id)), collection: w.collection })]);
    const art = w.make(1, seller);
    const ownerOf = (asset) => encodeBase58(w.chain.get(asset).data.subarray(1, 33));
    send(w.chain.now(), 1, { Asset: [art] });
    assert.equal(ownerOf(art), w.project);
    w.chain.warp(w.chain.now() + 61);
    assert.equal(end(1).receipts[0].data.winner, null);
    assert.equal(ownerOf(art), seller);

    send(w.chain.now(), 2, { Asset: [art] });
    const had = w.balance(w.player);
    w.chain.send(w.player, [loot.bidIx({ bidder: w.player, project: w.project, id: 2, auction: w.read('Auction', pda.auction(w.project, seller, 2)), amount: PRICE })]);
    // Nobody ended it for a year: it still sells to the high bidder.
    w.chain.warp(w.chain.now() + 61 + 365 * 86_400);
    assert.equal(end(2).receipts.find((r) => r.name === 'AuctionEnded').data.winner, w.player);
    assert.equal(w.balance(w.player), had - PRICE);
    assert.equal(ownerOf(art), w.player);
  });
});

describe('mechanics that run by themselves', () => {
  t('a schedule moves a share of a pool on its timer', () => {
    const w = world();
    w.pool(0, w.mint, 10n * PRICE);
    w.pool(1, w.mint);
    const args = { active: true, action: { from: { Pool: [0] }, to: { Pool: [1] }, amount: { Bps: [1000] }, halve_every: 0 }, every: 60n, next_at: BigInt(w.chain.now() + 60), max_runs: 0 };
    w.upsert({ Schedule: { id: 1, args } });
    const schedule = w.read('Schedule', pda.schedule(w.project, 1));
    fails(() => w.chain.send(w.cranker, [loot.runScheduleIx({ payer: w.cranker, project: w.project, id: 1, schedule, poolMint: w.mint })]));
    w.chain.warp(w.chain.now() + 61);
    const r = w.chain.send(w.cranker, [loot.runScheduleIx({ payer: w.cranker, project: w.project, id: 1, schedule, poolMint: w.mint })]);
    assert.deepEqual(names(r), ['ScheduleRan']);
    assert.equal(w.chain.tokens(pda.pool(w.project, 1)), PRICE);
  });

  t('a lottery: tickets, a draw on its timer, the oracle, then each place paid', () => {
    const w = world();
    const args = { price: 1000n, mint: w.mint, shares: [{ to: 'Treasury', bps: 1000 }], places: [7000, 3000], ticket_mint: '11111111111111111111111111111111', every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null };
    w.upsert({ Lottery: { id: 1, args } });
    let lottery = w.read('Lottery', pda.lottery(w.project, 1));
    const rival = w.who();
    w.fund(rival, w.mint, 10n * PRICE);
    w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 1, lottery, mint: w.mint, count: 5n, nonce: 1n })]);
    w.chain.send(rival, [loot.buyTicketsIx({ player: rival, project: w.project, id: 1, lottery, mint: w.mint, count: 5n, nonce: 1n })]);
    w.chain.warp(w.chain.now() + 3601);
    const d = w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1 })]);
    assert.equal(d.answers.length, 1);
    lottery = w.read('Lottery', pda.lottery(w.project, 1));
    assert.equal(lottery.status, 'Drawn');
    const bought = contributionsOf(w, pda.lottery(w.project, 1));
    assert.equal(lottery.pending, 2n);
    for (const { address, value } of bought) {
      w.chain.send(w.cranker, [loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 1, lottery, contributionAddress: address, contribution: value, treasury: w.treasury })]);
    }
    // Five tickets each, places five apart: each buyer won one place, and finishing their contribution again pays it.
    lottery = w.read('Lottery', pda.lottery(w.project, 1));
    const winners = contributionsOf(w, pda.lottery(w.project, 1));
    assert.deepEqual(winners.map(({ value }) => value.done), [true, true]);
    for (const place of [0, 1]) assert.ok(loot.contributionOf(winners, loot.ticketOfPlace(lottery, place)));
    for (const { address, value } of winners) {
      const r = w.chain.send(w.cranker, [loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 1, lottery: w.read('Lottery', pda.lottery(w.project, 1)), contributionAddress: address, contribution: value })]);
      assert.deepEqual(names(r), ['LotteryPaid']);
    }
    assert.deepEqual(contributionsOf(w, pda.lottery(w.project, 1)), [], 'every contribution closed, its rent back to its buyer');
  });

  t('a lottery timeout refunds fixed buyers and rejects stale terms and repeated completion', () => {
    const w = world();
    const args = { price: 1000n, mint: w.mint, shares: [], places: [], ticket_mint: '11111111111111111111111111111111', every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null, per_wallet: 5 };
    w.upsert({ Lottery: { id: 2, args } });
    const address = pda.lottery(w.project, 2);
    let lottery = w.read('Lottery', address);
    const stale = loot.buyTicketsIx({ player: w.player, project: w.project, id: 2, lottery, count: 1n, nonce: 1n });
    w.upsert({ Lottery: { id: 2, args: { ...args, price: 2000n } } });
    fails(() => w.chain.send(w.player, [stale]), 'TermsChanged');
    lottery = w.read('Lottery', address);
    const before = w.chain.tokens(loot.ata(w.player, w.mint));
    w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 2, lottery, count: 1n, nonce: 1n })]);
    w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id: 2, lottery: w.read('Lottery', address), count: 1n, nonce: 2n })]);
    const bought = contributionsOf(w, address);
    assert.deepEqual(bought.map(({ value }) => [value.first_ticket, value.end, value.amount, value.done]), [[0n, 1n, 2000n, false], [1n, 2n, 2000n, false]]);
    assert.ok(w.chain.get(pda.lotteryReceipt(address, lottery.incarnation, w.player)));
    assert.equal(w.chain.tokens(pda.pot(address)), 0n);
    assert.equal(w.chain.tokens(pda.lotteryFunds(address)), 4000n);
    fails(() => w.chain.send(w.cranker, [loot.cancelLotteryIx({ project: w.project, id: 2 })]), 'NotDue');
    // A round nobody draws waits; one whose draw the oracle never answers is refunded.
    w.chain.warp(Number(lottery.draws_at) + 30 * 86_400);
    fails(() => w.chain.send(w.cranker, [loot.cancelLotteryIx({ project: w.project, id: 2 })]), 'NotDue');
    w.chain.sendRaw(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 2 })]); // the oracle never answers
    w.chain.nextSlot(Number(loot.LOTTERY_TIMEOUT_SLOTS) + 1);
    assert.ok(loot.lotteryCancellable(w.read('Lottery', address), w.chain.slot()));
    w.chain.send(w.cranker, [loot.cancelLotteryIx({ project: w.project, id: 2 })]);
    lottery = w.read('Lottery', address);
    assert.equal(lottery.status, 'Cancelled');
    const [first, second] = bought;
    const finish = loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 2, lottery, contributionAddress: first.address, contribution: first.value });
    assert.deepEqual(finish.keys.filter((key) => key.isSigner).map((key) => key.pubkey), [w.cranker], 'only whoever sends it signs');
    const wrong = { ...finish, keys: finish.keys.map((key, index) => (index === 6 ? { ...key, pubkey: w.cranker } : key)) };
    fails(() => w.chain.send(w.cranker, [wrong]), 'ConstraintHasOne');
    w.chain.send(w.cranker, [finish]);
    fails(() => w.chain.send(w.cranker, [finish]));
    w.chain.send(w.cranker, [loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id: 2, lottery, contributionAddress: second.address, contribution: second.value })]);
    assert.equal(w.chain.tokens(loot.ata(w.player, w.mint)), before);
    assert.equal(w.chain.tokens(pda.lotteryFunds(address)), 0n);
    assert.deepEqual(contributionsOf(w, address), []);
  });

  t('a token farm with two tiers: stake, rewards arrive, harvest, unstake after the lock', () => {
    const w = world();
    w.pool(5, w.mint, 10n * PRICE);
    const args = { custody: 'Escrow', rewards_pool: 5, tiers: [{ lock: 60, bps: 10_000 }, { lock: 600, bps: 30_000 }], boosts: [], max_boost_bps: 0, gate: null };
    w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, args, rewardsMint: w.mint, stakedMint: w.mint })]);
    const farm = w.read('Farm', pda.farm(w.project, 1));
    w.chain.send(w.player, [loot.stakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: 5n * PRICE, tier: 1 })]);
    assert.equal(w.chain.get(pda.seat(pda.farm(w.project, 1), w.player)).data.length, loot.ACCOUNT_BYTES.Seat);
    w.chain.warp(w.chain.now() + 30);
    const h = w.chain.send(w.player, [loot.harvestIx({ player: w.player, project: w.project, id: 1, farm })]);
    assert.ok(names(h).includes('Harvested'));
    fails(() => w.chain.send(w.player, [loot.unstakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: 5n * PRICE })]));
    w.chain.warp(w.chain.now() + 601);
    const u = w.chain.send(w.player, [loot.unstakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: 5n * PRICE })]);
    assert.ok(names(u).includes('Unseated'));
  });

  t('a farm of collectibles with a boost: stake one, refresh, take it out', () => {
    const w = world();
    w.pool(6, w.mint, 10n * PRICE);
    w.upsert({ Item: { id: 1, args: collectible('Miner') } });
    const boost = { rule: { of: { Item: [1] }, key: 'level', test: 'Any' }, effect: { PerPoint: { bps: 1000, most: 9 } } };
    const args = { custody: 'Freeze', rewards_pool: 6, tiers: [{ lock: 60, bps: 10_000 }], boosts: [boost], max_boost_bps: 10_000, gate: { of: { Item: [1] }, key: 'level', test: 'Any' } };
    w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 2, args, rewardsMint: w.mint })]);
    const farm = w.read('Farm', pda.farm(w.project, 2));
    const miner = w.make(1, w.player, [{ key: 'level', value: '4' }]);
    w.tokenAccount(w.player, w.mint);
    w.chain.send(w.player, [loot.stakeNftIx({ player: w.player, project: w.project, id: 2, farm, asset: miner, collection: w.collection })]);
    const seatState = w.read('Seat', pda.seat(pda.farm(w.project, 2), miner));
    assert.equal(seatState.boost_bps, 4000);
    w.chain.send(w.cranker, [loot.refreshSeatIx({ signer: w.cranker, project: w.project, id: 2, farm, by: miner, seat: seatState, collection: w.collection })]);
    w.chain.warp(w.chain.now() + 61);
    const r = w.chain.send(w.player, [loot.unstakeNftIx({ player: w.player, project: w.project, id: 2, farm, asset: miner, collection: w.collection })]);
    assert.ok(names(r).includes('Unseated'));
  });

  t('a farm that runs by itself: a minted rate, points and a level written on the hero, a mission prize on the way out', () => {
    const w = world();
    const projectMint = () => {
      const mint = w.newMint();
      w.chain.send(w.creator, [setAuthorityIx({ account: mint, current: w.creator, newAuthority: w.project })]);
      return mint;
    };
    const [dust, ticket] = [projectMint(), projectMint()];
    w.pool(7, dust);
    w.upsert({ Item: { id: 1, args: collectible('Hero') } });
    const args = {
      custody: 'Escrow', rewards_pool: 7, tiers: [{ lock: 60, bps: 10_000 }, { lock: 3 * 86_400, bps: 15_000, prize: { Tokens: { from: { Mint: [ticket] }, amount: { Fixed: [2n] } } } }],
      boosts: [], max_boost_bps: 0, gates: [{ of: { Item: [1] }, key: '', test: 'Any' }],
      rate: { per_day: 1_000n, mints: true }, growth: [{ key: 'xp', per_day: 100, level: 'level', steps: [100, 300], streak: false }],
    };
    w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 3, args, rewardsMint: dust })]);
    const farm = w.read('Farm', pda.farm(w.project, 3));
    const hero = w.make(1, w.player);
    w.tokenAccount(w.player, dust);
    w.chain.send(w.player, [loot.stakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset: hero, collection: w.collection, tier: 1 })]);
    w.chain.warp(w.chain.now() + 2 * 86_400);
    const seat = w.read('Seat', pda.seat(pda.farm(w.project, 3), hero));
    const grown = w.chain.send(w.cranker, [loot.refreshSeatIx({ signer: w.cranker, project: w.project, id: 3, farm, by: hero, seat, collection: w.collection })]);
    assert.ok(names(grown).includes('Grown'));
    const written = parseCoreAsset(w.chain.get(hero).data).attributes;
    assert.deepEqual([written.xp, written.level], ['300', '2'], 'two days at x1.5');
    w.chain.warp(w.chain.now() + 86_400 + 1);
    const out = w.chain.send(w.player, [computeUnitLimit(400_000), loot.unstakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset: hero, collection: w.collection, tier: 1 })]);
    assert.equal(out.receipts.find((r) => r.name === 'PrizeGiven').data.amount, 2n);
    assert.equal(w.balance(w.player, ticket), 2n);
    assert.equal(w.balance(w.player, dust), 4_500n, 'three days at x1.5, minted');
  });

  t('a recipe raises a level bought with a payment, on a collectible used or shown, up to its cap', () => {
    const w = world();
    w.upsert({ Item: { id: 1, args: collectible('Hero') } });
    const args = {
      active: true,
      inputs: [{ Use: { item: 1 } }, { Show: { collection: w.collection } }, { Pay: { mint: w.mint, amount: 100n, to: 'Burn' } }],
      outputs: [], needs: [], keeps: [],
      raises: [{ place: 0, key: 'level', by: 1, most: 2 }, { place: 1, key: 'power', by: 5, most: 100 }],
    };
    w.upsert({ Recipe: { id: 7, args } });
    const [hero, friend] = [w.make(1, w.player), w.make(1, w.player)];
    const craft = () => loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 7, recipe: w.read('Recipe', pda.recipe(w.project, 7)), assets: [hero, friend] });
    w.chain.send(w.player, [computeUnitLimit(600_000), craft()]);
    w.chain.send(w.player, [computeUnitLimit(600_000), craft()]);
    const [a, b] = [hero, friend].map((x) => parseCoreAsset(w.chain.get(x).data).attributes);
    assert.deepEqual([a.level, b.power], ['2', '10']);
    fails(() => w.chain.send(w.player, [computeUnitLimit(600_000), craft()]), 'MaxedOut');
  });

  t('a recipe: two collectibles and a payment in, one collectible and tokens from a pool out', () => {
    const w = world();
    w.pool(0, w.mint, 10n * PRICE);
    w.upsert({ Item: { id: 1, args: collectible('Iron') } });
    w.upsert({ Item: { id: 2, args: collectible('Steel Sword') } });
    const args = {
      active: true,
      inputs: [{ Burn: { item: 1, count: 2 } }, { Pay: { mint: w.mint, amount: 100n, to: 'Burn' } }],
      outputs: [{ Prize: [{ Item: [2] }] }, { Prize: [{ Tokens: { from: { Pool: [0] }, amount: { Fixed: [50n] } } }] }],
      needs: [],
      keeps: [],
    };
    w.upsert({ Recipe: { id: 1, args } });
    const recipe = w.read('Recipe', pda.recipe(w.project, 1));
    const iron = [w.make(1, w.player), w.make(1, w.player)];
    const items = { 2: w.read('Item', pda.item(w.project, 2)) };
    const made = pda.itemAsset(pda.item(w.project, 2), 1);
    const r = w.chain.send(w.player, [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 1, recipe, assets: iron, items, poolMints: { 0: w.mint } })]);
    assert.deepEqual(names(r), ['PrizeGiven', 'PrizeGiven', 'Crafted']);
    assert.equal(w.chain.get(made).owner, MPL_CORE_PROGRAM);
  });
});

describe('grants', () => {
  t('a voucher claim mints a collectible; a list claim pays from a pool', () => {
    const w = world();
    w.upsert({ Item: { id: 7, args: collectible('Starter Pet') } });
    const signer = keyFromSeed(new Uint8Array(32).fill(9));
    const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 1, per_key: 0, per_day: 100, total: 100, window: { opens_at: 0n, closes_at: 0n } };
    const nobody = '11111111111111111111111111111111';
    w.upsert({ Grant: { id: 1, args: { gives: { Item: [7] }, vouchers: [signer.publicKey, nobody, nobody], list_root: new Uint8Array(32), limits, active: true, gate: null } } });
    const grantAddress = pda.grant(w.project, 1);
    w.chain.airdrop(grantAddress, 1_000_000_000n);
    const grant = w.read('Grant', grantAddress);
    const wallet = w.who();
    const round = new Uint8Array(16).fill(5);
    const expires = BigInt(w.chain.now() + 600);
    const message = loot.voucherBytes({ grant: grantAddress, incarnation: grant.incarnation, wallet, personHash: null, round, expires });
    const check = loot.ed25519Ix({ publicKey: signer.publicKey, signature: signer.sign(message), message });
    const item = w.read('Item', pda.item(w.project, 7));
    const claim = loot.claimGrantIx({ project: w.project, id: 1, grant, wallet, signer: w.cranker, round, expires, projectState: w.projectState(), item });
    const r = w.chain.send(w.cranker, [check, claim]);
    assert.deepEqual(names(r), ['PrizeGiven', 'GrantClaimed']);
    assert.equal(w.chain.get(pda.itemAsset(pda.item(w.project, 7), 1)).owner, MPL_CORE_PROGRAM);
    assert.ok(loot.decodeReceipt(w.chain.get(pda.grantReceipt(grantAddress, grant.incarnation, wallet)).data).claimed(round));
    // The same voucher again is refused, and so is the same round signed again with a later date.
    fails(() => w.chain.send(w.cranker, [check, claim]));
    const later = BigInt(w.chain.now() + 6_000);
    const again = loot.voucherBytes({ grant: grantAddress, incarnation: grant.incarnation, wallet, personHash: null, round, expires: later });
    fails(() => w.chain.send(w.cranker, [loot.ed25519Ix({ publicKey: signer.publicKey, signature: signer.sign(again), message: again }), loot.claimGrantIx({ project: w.project, id: 1, grant: w.read('Grant', grantAddress), wallet, signer: w.cranker, count: 1, round, expires: later, projectState: w.projectState(), item: w.read('Item', pda.item(w.project, 7)) })]), 'AlreadyClaimed');

    // A list: three wallets; the second claims with its proof.
    w.pool(2, w.mint, 10n * PRICE);
    const wallets = [w.who(), w.who(), w.who()];
    const leaves = wallets.map((x) => loot.listLeaf(x, null));
    w.upsert({ Grant: { id: 2, args: { gives: { Tokens: { from: { Pool: [2] }, amount: { Fixed: [3n] } } }, vouchers: [nobody, nobody, nobody], list_root: loot.merkleRoot(leaves), limits, active: true, gate: null } } });
    const g2 = pda.grant(w.project, 2);
    w.chain.airdrop(g2, 1_000_000_000n);
    // A list's claim is its wallet's own to send (WalletMustSign).
    const claim2 = loot.claimGrantIx({ project: w.project, id: 2, grant: w.read('Grant', g2), wallet: wallets[1], signer: wallets[1], proof: loot.merkleProof(leaves, 1), poolMint: w.mint });
    w.chain.send(wallets[1], [claim2]);
    assert.equal(w.balance(wallets[1]), 3n);
  });

  t('recreating a grant rejects the old signed voucher and gives it a new receipt namespace', () => {
    const w = world();
    w.pool(1, w.mint, 100n);
    const signer = keyFromSeed(new Uint8Array(32).fill(7));
    const nobody = '11111111111111111111111111111111';
    const args = { gives: { Tokens: { from: { Pool: [1] }, amount: { Fixed: [5n] } } }, vouchers: [signer.publicKey, nobody, nobody], list_root: new Uint8Array(32), key_root: new Uint8Array(32), limits: { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } }, active: true, gate: null };
    w.upsert({ Grant: { id: 3, args } });
    const address = pda.grant(w.project, 3), wallet = w.who();
    const first = w.read('Grant', address);
    const fields = { grant: address, incarnation: first.incarnation, wallet, round: new Uint8Array(16).fill(7), expires: BigInt(w.chain.now() + 600) };
    const message = loot.voucherBytes(fields);
    const check = loot.ed25519Ix({ publicKey: signer.publicKey, signature: signer.sign(message), message });
    w.chain.airdrop(address, 1_000_000_000n);
    w.chain.send(w.cranker, [check, loot.claimGrantIx({ project: w.project, id: 3, grant: first, wallet, signer: w.cranker, round: fields.round, expires: fields.expires, poolMint: w.mint })]);
    w.chain.send(w.creator, [loot.closeRecordIx({ owner: w.creator, project: w.project, target: address })]);
    w.upsert({ Grant: { id: 3, args } });
    const next = w.read('Grant', address);
    assert.ok(next.incarnation > first.incarnation);
    w.chain.airdrop(address, 1_000_000_000n);
    const claim = loot.claimGrantIx({ project: w.project, id: 3, grant: next, wallet, signer: w.cranker, round: fields.round, expires: fields.expires, poolMint: w.mint });
    fails(() => w.chain.send(w.cranker, [check, claim]), 'WrongVoucherBytes');
    const fresh = loot.voucherBytes({ ...fields, incarnation: next.incarnation });
    w.chain.send(w.cranker, [loot.ed25519Ix({ publicKey: signer.publicKey, signature: signer.sign(fresh), message: fresh }), claim]);
    for (const incarnation of [first.incarnation, next.incarnation]) assert.equal(loot.decodeReceipt(w.chain.get(pda.grantReceipt(address, incarnation, wallet)).data).count, 1);
    assert.equal(w.balance(wallet), 10n);
  });

  test('the voucher and list test vectors: a voucher’s bytes and signature, a list’s root and proof', () => {
    const message = loot.voucherBytes({
      grant: new Uint8Array(32).fill(0x22),
      incarnation: 7n,
      wallet: new Uint8Array(32).fill(0x33),
      personHash: new Uint8Array(32).fill(0x44),
      round: new Uint8Array(16).fill(0x55),
      expires: 1_767_225_600n,
    });
    assert.equal(Buffer.from(message).toString('hex'), '6c6f6f742d6772616e742d763402354a42305cb625d57a3039efafbd8b8fe0ac361da56671aefbbad058d158e722222222222222222222222222222222222222222222222222222222222222220700000000000000333333333333333333333333333333333333333333333333333333333333333344444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555500b95569000000000000000000000000');
    const key = keyFromSeed(new Uint8Array(32).fill(1));
    assert.equal(key.publicKey, 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9');
    assert.equal(Buffer.from(key.sign(message)).toString('hex'), '809021b02d5a442f72eb63de9acf0fc7fb5256f78987684e7130b51248455e2c831a54a39b303cd49dbc0b9f7faa7861e2530645cbf8cda9b81c5269bc01f505');
    const leaves = [0x33, 0x34, 0x35].map((b) => loot.listLeaf(new Uint8Array(32).fill(b), null));
    assert.equal(Buffer.from(loot.merkleRoot(leaves)).toString('hex'), '7e7139369d9451ae178d9bdcb87322669db7533a0482e197fbcffc96c5b357cf');
    assert.deepEqual(loot.merkleProof(leaves, 1).map((p) => Buffer.from(p).toString('hex')), [
      '34e6a712750308f305caefb024224476bc30acf6c7587f9bb1870b1101ce806d',
      '3628454bf3ef6e1031831ffec880b7c2a2bb7aef6c452e80ee08f019b2fb7d44',
    ]);
  });
});

describe('NFTs of other collections', () => {
  t('a Core NFT of another collection passes a gate that names its collection, with what the project wrote in its Sheet', () => {
    const w = world();
    const maker = w.who();
    const theirs = newAddress(w.random);
    chainCollection(w, theirs, maker);
    const nft = coreAsset(w, theirs, maker, w.player);
    w.upsert({ Item: { id: 2, args: collectible('Common') } });
    const gate = { Holds: [{ of: { Collection: [theirs] }, key: 'level', test: { AtLeast: [2] } }] };
    w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(2)], { gate }) } });
    const box = w.read('LootBox', pda.box(w.project, 1));
    const open = (nonce) => loot.openBoxIx({ player: w.player, project: w.project, projectMint: w.mint, box, nonce, shown: { asset: nft } });
    fails(() => w.chain.send(w.player, [open(1n)]), 'GateNotMet');
    const set = loot.collectibleIx({ authority: w.authority, project: w.project, collection: w.collection, asset: nft, change: { Set: [[{ key: 'level', value: '2' }]] }, hasAuthority: false });
    w.chain.send(w.authority, [set]);
    assert.deepEqual(loot.decodeSheet(w.chain.get(pda.sheet(w.project, nft)).data).attributes, [{ key: 'level', value: '2' }]);
    w.chain.send(w.player, [open(2n)]);
  });
});

/** Another project's Core collection, `maker` its update authority. */
function chainCollection(w, collection, maker) {
  const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
  const data = concat(Uint8Array.of(21), str('Outside Apes'), str('https://example.invalid/apes.json'), Uint8Array.of(0, 0));
  w.chain.send(maker, [{ programId: MPL_CORE_PROGRAM, keys: [meta(collection, true, true), meta(maker, false, false), meta(maker, true, true), meta(SYSTEM_PROGRAM, false, false)], data }]);
}
