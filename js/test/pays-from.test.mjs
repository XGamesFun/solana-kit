// loot 0.25: where a lottery's places are paid from (a pot kept from round to round, or each round's own ticket money
// with what the places leave sent to `rest`), the round before's leftover moved into its pot by the next ask, a contest's
// winnings written at the decision, a box that stops selling and names a stash's NFT beside a random one of it, and a
// token seat's booster used by a recipe. Each run on the real program where it can be, and in the spec's tools.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUnitLimit } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { plan } from '../economy/plan.mjs';
import { simulate } from '../economy/simulate.mjs';
import { boxArgs, cannotRun, collectible, drop, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const pda = loot.pda;
const NOW = 1_790_000_000;
const NOBODY = '11111111111111111111111111111111';
const WALLET = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const fails = (fn, name) => assert.throws(fn, (e) => (e.logs ?? []).join(' ').includes(name) || e.message.includes(name));
const names = (record) => record.receipts.map((r) => r.name);
const solSpec = (more) => ({ version: 2, network: 'devnet', name: 'T', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'T' }, ...more });
const said = (spec) => {
  const r = check(spec, { now: NOW });
  return { ok: r.ok, refused: r.refusals.map((x) => `${x.code} ${x.where}`), warned: r.warnings.map((x) => `${x.code} ${x.where}`), refusals: r.refusals, warnings: r.warnings };
};
const draw = { key: 'draw', name: 'Draw', price: 0.01, places: [60], every: '1d' };

// ---------------------------------------------------------------- the spec

test('a lottery names where its places are paid from: exactly one of "pot" and "rest", never a default', () => {
  const neither = said(solSpec({ lotteries: [draw] }));
  assert.deepEqual(neither.refused, ['E-LOTTERY-PAYS economy.lotteries[0]'], 'said once, in words, not again by the schema');
  assert.match(neither.refusals[0].message, /does not say where its places are paid from/);
  assert.match(neither.refusals[0].fix, /"pot": 0/);
  assert.deepEqual(said(solSpec({ lotteries: [{ ...draw, pot: 0, rest: 'treasury' }] })).refused, ['E-LOTTERY-PAYS economy.lotteries[0]']);
  assert.ok(said(solSpec({ lotteries: [{ ...draw, pot: 0 }] })).ok);
  assert.ok(said(solSpec({ lotteries: [{ ...draw, pot: 15 }] })).ok);
  assert.deepEqual(said(solSpec({ lotteries: [{ ...draw, pot: 16 }] })).refused, ['E-SCHEMA economy.lotteries[0].pot'], 'a lottery keeps 16 pots at most');
  const own = said(solSpec({ lotteries: [{ ...draw, rest: 'treasury' }] }));
  assert.ok(own.ok, own.refused.join());
  assert.ok(own.warnings.some((x) => x.code === 'W-LOTTERY' && /goes to “treasury”/.test(x.message)), 'what the places leave goes to its rest');
});

test('a round paid from its own money sends its leftover where no later prize reads it', () => {
  const pools = [{ key: 'house', currency: 'sol', seed: 1 }];
  const refusedFor = (lottery, more = {}) => said(solSpec({ pools, ...more, lotteries: [{ ...draw, ...lottery }] })).refused;
  assert.deepEqual(refusedFor({ rest: 'pool:house' }), ['E-LOTTERY economy.lotteries.draw.rest'], 'never a pool');
  assert.deepEqual(refusedFor({ rest: 'chosen' }), ['E-LOTTERY economy.lotteries.draw.rest'], 'never a share the buyer chooses');
  assert.deepEqual(refusedFor({ rest: 'lottery:draw' }), ['E-LOTTERY economy.lotteries.draw.rest'], 'never its own pot');
  assert.deepEqual(refusedFor({ rest: 'burn' }), ['E-WSOL-BURN economy.lotteries.draw.rest'], 'SOL is not burned');
  assert.deepEqual(refusedFor({ rest: 'treasury', noLoss: true }), ['E-LOTTERY economy.lotteries.draw.noLoss'], 'a no-loss lottery needs a pot');
  assert.deepEqual(refusedFor({ rest: 'treasury', seed: 1 }), ['E-LOTTERY economy.lotteries.draw.seed'], 'no pot to seed');
  assert.deepEqual(refusedFor({ rest: `wallet:${WALLET}` }), []);
  // Nothing can pay into a lottery that keeps no pot: a share, a schedule.
  const shares = { payments: [{ key: 'p', name: 'P', amount: 0.1, split: [{ to: 'lottery:draw', percent: 10 }] }] };
  assert.deepEqual(refusedFor({ rest: 'treasury' }, shares), ['E-LOTTERY economy.payments.p.split[0].to']);
  assert.deepEqual(refusedFor({ pot: 0 }, shares), []);
  const schedule = { schedules: [{ key: 's', name: 'S', does: 'pay', from: 'house', to: 'lottery:draw', amount: 0.01, every: '1d' }] };
  assert.deepEqual(refusedFor({ rest: 'treasury' }, schedule), ['E-LOTTERY economy.schedules.s.to']);
  // Tickets that bring no money (burned, or an NFT) leave a round's percents nothing to pay.
  const burned = said({ ...solSpec({ lotteries: [{ ...draw, rest: 'treasury', ticketCurrency: 'gem' }] }), tokens: [{ key: 'sol', source: 'sol' }, { key: 'gem', source: 'project', name: 'Gem', symbol: 'GEM', decimals: 6 }] });
  assert.ok(burned.warnings.some((x) => x.code === 'W-LOTTERY' && /percents pay nothing/.test(x.message)), burned.warned.join());
});

test('the plan, the simulation and the explainer follow where a lottery pays from', () => {
  const spec = (lottery) => solSpec({ lotteries: [{ ...draw, ...lottery }], scenario: { days: 10, perDay: { 'lottery:draw': 100 } } });
  // The setup: a pot is opened only for a lottery that keeps one, and its terms name it.
  const steps = (lottery) => plan(spec(lottery), { now: NOW }).steps.find((s) => s.id === 'lottery:draw:Lottery');
  assert.deepEqual(steps({ pot: 2 }).creates.map((c) => c.what), ['the lottery “Draw”', 'the lottery “Draw”’s pot']);
  assert.deepEqual(steps({ rest: 'treasury' }).creates.map((c) => c.what), ['the lottery “Draw”']);
  // A round's own money: 100 tickets a day of 0.01, 60% to the places, the rest to the treasury.
  const own = simulate(spec({ rest: 'treasury' }), { now: NOW });
  assert.equal(own.lotteries[0].potBeforeDraw, 1);
  assert.deepEqual(own.lotteries[0].prizes, [0.6]);
  assert.ok(!own.pools.some((p) => p.key === 'lottery:draw'), 'no pot to fill');
  assert.deepEqual([own.perDay.players.getBack.sol, own.perDay.creator.treasury.sol], [0.6, 0.4], 'the places’ part to the winners, the rest to the treasury');
  const pot = simulate(spec({ pot: 0 }), { now: NOW });
  assert.ok(pot.pools.some((p) => p.key === 'lottery:draw'), 'a pot of its own');
  // In words: a round's own money can't be changed from outside; a pot counts gifts and what earlier rounds left.
  const ownWords = explainEconomy(spec({ rest: 'treasury' }), { now: NOW }).text;
  assert.match(ownWords, /each round’s own ticket money alone, which nothing sent from outside can change/);
  const potWords = explainEconomy(spec({ pot: 0 }), { now: NOW }).text;
  assert.match(potWords, /what earlier rounds’ places left/);
  assert.match(potWords, /the next round always starts with it/);
});

// ---------------------------------------------------------------- the program

test('a lottery paid from a pot: the next ask moves in what the round before left, from whichever pot it paid', { skip }, () => {
  const w = world({ seed: 'pays-from-pot' });
  const id = 1;
  const address = pda.lottery(w.project, id);
  const args = (pot) => ({ price: 1000n, mint: w.mint, pays_from: { Pot: [pot] }, shares: [], places: [3000], ticket_mint: NOBODY, every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null, per_wallet: 0 });
  w.upsert({ Lottery: { id, args: args(0) } });
  assert.equal(w.read('Lottery', address).pots, 1, 'its write opened pot 0');
  const lotteryNow = () => w.read('Lottery', address);
  const round = (n) => pda.round(address, lotteryNow().incarnation, n);
  const buy = () => {
    const lottery = lotteryNow();
    const current = w.chain.get(loot.currentRound(address, lottery))?.data?.length ? loot.decodeRound(w.chain.get(loot.currentRound(address, lottery)).data) : null;
    w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery, round: current, mint: w.mint, count: 10n })]);
  };
  const ask = (more = {}) => {
    const lottery = lotteryNow();
    const key = loot.currentRound(address, lottery);
    return w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.drawLotteryIx({ payer: w.cranker, project: w.project, id, lottery, round: loot.decodeRound(w.chain.get(key).data), ...more })]);
  };
  const decoded = (n) => loot.decodeRound(w.chain.get(round(n)).data);
  // Round 0: 10,000 of ticket money, its place takes 30%; 7,000 is owed to pot 0, and nobody pulls it.
  buy();
  w.chain.warp(w.chain.now() + 3601);
  ask();
  assert.equal(decoded(0).pot_owed, 7000n);
  assert.equal(lotteryNow().owing, round(0), 'the lottery names the round that may owe its pot');
  // Round 1's ask, without that round, is refused: it must move the leftover in first.
  buy();
  w.chain.warp(w.chain.now() + 3601);
  assert.throws(() => ask({ lottery: { ...lotteryNow(), owing: NOBODY } }));
  ask({ owing: decoded(0) });
  assert.equal(decoded(0).pot_owed, 0n, 'moved in by the ask');
  assert.equal(w.chain.tokens(pda.lotteryPot(address, 0)), 7000n);
  const r1 = decoded(1);
  assert.equal(r1.pot_total, 17_000n, 'the pot with the round’s own money');
  assert.equal(r1.pot_owed, 10_000n - 5100n);
  // Between rounds it moves to pot 1: round 2's ask still moves round 1's leftover into pot 0, the pot that round paid.
  w.upsert({ Lottery: { id, args: { ...args(1), draws_at: lotteryNow().terms.draws_at } } });
  assert.equal(lotteryNow().pots, 3, 'pots 0 and 1 opened');
  buy();
  w.chain.warp(w.chain.now() + 3601);
  fails(() => ask({ owing: null }), 'WrongPool');
  ask({ owing: r1 });
  assert.equal(w.chain.tokens(pda.lotteryPot(address, 0)), 7000n + 4900n);
  assert.equal(decoded(2).pot_total, 10_000n, 'a fresh pot: only the round’s own money');
  // Each round pays out; then the close empties every pot it opened to the owner, and closes each.
  const finish = (n) => {
    for (let guard = 0; w.chain.get(round(n))?.data?.length && guard < 20; guard++) {
      const r = decoded(n);
      const common = loot.commonOwed(r)[0];
      const own = r.entries.map((_, i) => ({ entry: i, part: loot.partsOwed(r, i)[0] })).find((x) => x.part);
      const pick = loot.roundFinished(r) ? { entry: 0, part: 'Own' } : common ? { entry: 0, part: common } : own;
      w.chain.send(w.cranker, [computeUnitLimit(1_400_000), loot.pullIx({ payer: w.cranker, project: w.project, roundAddress: round(n), round: r, ...pick, projectState: w.projectState() })]);
    }
    assert.equal(w.chain.get(round(n)), null, `round ${n} paid out and closed`);
  };
  finish(0);
  finish(1);
  w.finishRound(id);
  assert.equal(w.chain.tokens(pda.lotteryPot(address, 1)), 7000n, 'round 2’s leftover pulled into pot 1');
  w.chain.warp(w.chain.now() + 3601);
  const lottery = lotteryNow();
  const had = w.balance(w.creator);
  w.chain.send(w.creator, [loot.closeRecordIx({ owner: w.creator, project: w.project, target: address, lottery })]);
  assert.equal(w.balance(w.creator) - had, 11_900n + 7000n, 'both pots, to the owner');
  assert.equal(w.chain.get(pda.lotteryPot(address, 0)), null);
  assert.equal(w.chain.get(pda.lotteryPot(address, 1)), null);
});

test('a lottery paid from each round’s own money keeps no pot: its leftover goes to its rest, or is burned at the close', { skip }, () => {
  const w = world({ seed: 'pays-from-round' });
  const charity = w.who();
  const args = (id, rest, more = {}) => ({ price: 1000n, mint: w.mint, pays_from: { Round: { rest } }, shares: [{ to: 'Treasury', bps: 1000 }], places: [6000], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null, per_wallet: 0, ...more });
  // The program refuses a pool, a share the buyer chooses and a no-loss lottery paid from its rounds.
  w.pool(1);
  fails(() => w.upsert({ Lottery: { id: 9, args: args(9, { Pool: [1] }) } }), 'BadLottery');
  fails(() => w.upsert({ Lottery: { id: 9, args: args(9, 'Treasury', { returns: true, shares: [] }) } }), 'BadLottery');
  for (const [id, rest] of [[1, { Wallet: [charity] }], [2, 'Burn']]) {
    w.upsert({ Lottery: { id, args: args(id, rest) } });
    const address = pda.lottery(w.project, id);
    const lottery = w.read('Lottery', address);
    assert.equal(lottery.pots, 0);
    assert.equal(w.chain.get(pda.lotteryPot(address, 0)), null, 'no pot opened');
    w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery, mint: w.mint, count: 10n })]);
    w.chain.warp(w.chain.now() + 3601);
    const key = loot.currentRound(address, lottery);
    const ix = loot.drawLotteryIx({ payer: w.cranker, project: w.project, id, lottery, round: loot.decodeRound(w.chain.get(key).data) });
    assert.equal(ix.keys.length, loot.drawLotteryIx({ payer: w.cranker, project: w.project, id, lottery, round: { status: 'Drawing', terms: lottery.terms } }).keys.length, 'no pot accounts');
    w.chain.send(w.cranker, [ix]);
    const r = loot.decodeRound(w.chain.get(key).data);
    // 10,000 paid, 1,000 to the treasury: 9,000 for the places, which take 60%.
    assert.deepEqual([r.pot_total, r.pot_owed], [9000n, 3600n]);
    assert.deepEqual(loot.commonOwed(r), rest === 'Burn' ? [{ Common: [0] }] : [{ Common: [0] }, { Common: [1] }], 'a burned rest is no part owed');
    const supply = () => new DataView(w.chain.get(w.mint).data.buffer, w.chain.get(w.mint).data.byteOffset).getBigUint64(36, true);
    const before = supply();
    w.finishRound(id);
    assert.equal(w.chain.get(key), null, 'paid out and closed');
    if (rest === 'Burn') assert.equal(before - supply(), 3600n, 'burned at the close');
    else assert.equal(w.balance(charity), 3600n, 'to the wallet its rest names');
    // A lottery that opened no pot closes with the round it waits on alone.
    const ended = w.read('Lottery', address);
    w.chain.send(w.creator, [loot.closeRecordIx({ owner: w.creator, project: w.project, target: address, lottery: ended })]);
    assert.equal(w.chain.get(address), null);
  }
});

test('a contest’s winners share what the decision wrote: a gift after it is nobody’s, and the parts add up whatever the order', { skip }, () => {
  const w = world({ seed: 'contest-won' });
  const now = w.chain.now();
  const args = { sides: 2, closes_at: BigInt(now + 100), result_by: BigInt(now + 200), shares: [], gate: null };
  w.chain.send(w.authority, [loot.openContestIx({ authority: w.authority, project: w.project, projectState: w.projectState(), id: 1, mint: w.mint, args })]);
  const contest = () => w.read('Contest', pda.contest(w.project, 1));
  const list = () => loot.decodeEntries(w.chain.get(loot.contestEntries(pda.contest(w.project, 1), contest())).data);
  const [a, b, loser] = [w.player, w.who(), w.who()];
  for (const p of [b, loser]) w.fund(p, w.mint, 10n * PRICE);
  w.chain.send(a, [loot.enterIx({ player: a, project: w.project, id: 1, contest: contest(), side: 0, amount: 1000n })]);
  w.chain.send(b, [loot.enterIx({ player: b, project: w.project, id: 1, contest: contest(), side: 0, amount: 2000n })]);
  w.chain.send(loser, [loot.enterIx({ player: loser, project: w.project, id: 1, contest: contest(), side: 1, amount: 1001n })]);
  w.chain.warp(now + 150);
  w.chain.send(w.authority, [loot.decideIx({ signer: w.authority, project: w.project, contest: contest(), side: 0 })]);
  assert.equal(contest().pot_won, 4001n, 'what the pot held for the winners, written');
  // A gift after the decision changes no claim.
  w.fund(w.creator, w.mint, 500n);
  w.payIn(w.creator, w.mint, 500n, [{ to: { Account: [pda.pot(pda.contest(w.project, 1))] }, bps: 10_000 }]);
  const parts = [];
  for (const p of [b, a]) {
    const expected = loot.contestWinnings(contest(), list().find((e) => e.player === p).amount).pot;
    const had = w.balance(p);
    w.chain.send(w.cranker, [loot.claimIx({ payer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, contest: contest(), entries: list(), player: p })]);
    assert.equal(w.balance(p) - had, expected);
    parts.push(expected);
  }
  assert.deepEqual(parts, [2667n, 1334n], 'floor(4001 × 2/3), then the rest');
  assert.equal(parts[0] + parts[1], 4001n);
});

test('a box that stops selling can’t name a stash’s NFT beside a random one of it; one that draws what is left can', { skip }, () => {
  const spec = (whenOut) => solSpec({
    stashes: [{ key: 'vault', name: 'Vault', nfts: [WALLET] }],
    boxes: [{ key: 'b', name: 'B', price: 0.1, ...(whenOut ? { whenOut } : {}), outcomes: [{ gives: 'stash', stash: 'vault', chance: 50 }, { gives: 'nft', stash: 'vault', nft: WALLET, chance: 50 }] }],
  });
  assert.ok(said(spec()).refused.includes('E-ODDS economy.boxes.b.outcomes'));
  assert.ok(!said(spec('drawLeft')).refused.includes('E-ODDS economy.boxes.b.outcomes'));
  const w = world({ seed: 'stash-mix' });
  w.upsert({ Item: { id: 1, args: collectible('Crown') } });
  const write = (when_out) => () => w.upsert({ Box: { id: 2, args: boxArgs(1n, [drop([{ Stash: [1] }]), drop([{ Nft: { stash: 1, nft: WALLET } }]), itemDrop(1)], { when_out }) } });
  fails(write('StopSales'), 'BadEntries');
  write('DrawLeft')();
});

test('a recipe uses an NFT boosting a token seat: the player’s token seat and its farm follow it', { skip }, () => {
  const w = world({ seed: 'booster-use' });
  w.upsert({ Item: { id: 1, args: collectible('Badge') } });
  const boost = { rule: { of: { Item: [1] }, key: 'level', test: 'Any' }, effect: { PerPoint: { bps: 1000, most: 9 } } };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, args: { custody: 'Escrow', tiers: [{ lock: 0, bps: 10_000 }], boosts: [boost], max_boost_bps: 10_000, gate: null }, rewardsMint: w.mint, stakedMint: w.mint })]);
  const farm = w.read('Farm', pda.farm(w.project, 1));
  w.chain.send(w.player, [loot.stakeTokensIx({ player: w.player, project: w.project, id: 1, farm, amount: PRICE, tier: 0 })]);
  const badge = w.make(1, w.player, [{ key: 'level', value: '2' }]);
  w.chain.send(w.player, [loot.stakeNftIx({ player: w.player, project: w.project, id: 1, farm, asset: badge, collection: w.collection })]);
  assert.equal(w.read('Seat', pda.seat(pda.farm(w.project, 1), w.player)).asset, badge);
  w.upsert({ Recipe: { id: 3, args: { active: true, inputs: [{ Use: { item: 1 } }, { Pay: { mint: w.mint, amount: 10n, to: 'Burn' } }], outputs: [], needs: [], keeps: [], raises: [{ place: 0, key: 'xp', by: 1, most: 100 }] } } });
  const recipe = w.read('Recipe', pda.recipe(w.project, 3));
  const craft = (asset) => [computeUnitLimit(800_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 3, recipe, assets: [asset] })];
  const ix = craft({ asset: badge, farm: 1, booster: true })[1];
  assert.ok(ix.keys.some((k) => k.pubkey === pda.seat(pda.farm(w.project, 1), w.player)), 'the token seat');
  const r = w.chain.send(w.player, craft({ asset: badge, farm: 1, booster: true }));
  assert.ok(names(r).includes('Crafted'), names(r).join());
  // A `staked` line takes a collectible on a seat of its own, never a booster.
  assert.throws(() => loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 3, recipe: { ...recipe, inputs: [{ Staked: { item: 1, farm: 1 } }] }, assets: [{ asset: badge, farm: 1, booster: true }] }), /kept line/);
  // Rewards keep flowing to the seat: its booster is still on it.
  w.chain.send(w.creator, [mintToIx({ mint: w.mint, to: pda.rewards(pda.farm(w.project, 1)), authority: w.creator, amount: PRICE })]);
  assert.equal(w.read('Seat', pda.seat(pda.farm(w.project, 1), w.player)).asset, badge);
});
