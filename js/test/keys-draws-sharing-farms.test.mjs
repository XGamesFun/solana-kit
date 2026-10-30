// What the client builds for the program's guards: the project's keys come with their accounts, a badge's receipt has
// a seed of its own, a draw keeps the ticket of its first ask, the routes that read a mint's default account state once
// refuse one that can start frozen, and a sharing farm releases its pool over its longest lock and stops at its end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE } from '../chain/bytes.js';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from '../chain/pda.js';
import { mayStartFrozen } from '../chain/token2022.js';
import { checkMints, MintMismatch } from '../approve/live-check.mjs';
import { check } from '../economy/check.mjs';
import { model } from '../economy/model.mjs';
import * as loot from '../client/index.js';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const fails = (fn, error) => assert.throws(fn, (e) => (e.logs ?? []).some((l) => l.includes(error)) || String(e.message).includes(error), error);

/** A Token-2022 mint with `DefaultAccountState` set to `state` (1 initialized, 2 frozen), and a freeze authority or not. */
function defaultStateMint(w, { state = 1, freezer = w.creator } = {}) {
  const mint = newAddress(w.random);
  const base = new Uint8Array(166);
  base.set(uintLE(1, 4)); base.set(addressBytes(w.creator), 4); base[44] = 6; base[45] = 1; base[165] = 1;
  if (freezer) { base.set(uintLE(1, 4), 46); base.set(addressBytes(freezer), 50); }
  const data = concat(base, uintLE(6, 2), uintLE(1, 2), Uint8Array.of(state));
  w.chain.put(mint, { owner: TOKEN_2022_PROGRAM, lamports: w.chain.rent(data.length), data });
  return { mint, account: { owner: TOKEN_2022_PROGRAM, data } };
}

test('a project\'s authority and treasury come with their accounts, and one nobody can sign for is refused', { skip }, () => {
  const w = world({ project: false, seed: 'guards-keys' });
  const create = (treasury) => loot.createProjectIx({ owner: w.creator, id: 0, collections: [w.collection], treasury, authority: w.authority });
  const ix = create(w.treasury);
  const names = loot.IDL.instructions.find((i) => i.name === 'create_project').accounts.map((a) => a.name);
  assert.equal(ix.keys[names.indexOf('authority')].pubkey, w.authority);
  assert.equal(ix.keys[names.indexOf('treasury')].pubkey, w.treasury);
  assert.ok(!ix.keys[names.indexOf('treasury')].isSigner, 'only the owner signs');
  // A mint, a token account, the project itself: none of them signs for what a split leaves.
  for (const treasury of [w.mint, w.tokenAccount(w.creator, w.mint), loot.pda.project(w.creator, 0)]) fails(() => w.chain.send(w.creator, [create(treasury)]), 'BadKey');
  w.chain.send(w.creator, [create(w.treasury)]);
  const project = loot.pda.project(w.creator, 0);
  // An update names the new key's account too; a fresh wallet nobody funded yet is fine.
  fails(() => w.chain.send(w.creator, [loot.updateProjectIx({ owner: w.creator, project, treasury: w.mint })]), 'BadKey');
  fails(() => w.chain.send(w.creator, [loot.updateProjectIx({ owner: w.creator, project, authority: loot.LOOT_PROGRAM })]), 'BadKey');
  const fresh = newAddress(w.random);
  const update = loot.updateProjectIx({ owner: w.creator, project, treasury: fresh });
  const updateNames = loot.IDL.instructions.find((i) => i.name === 'update_project').accounts.map((a) => a.name);
  assert.equal(update.keys[updateNames.indexOf('new_treasury')].pubkey, fresh);
  assert.equal(update.keys[updateNames.indexOf('new_authority')].pubkey, loot.LOOT_PROGRAM, 'an authority left as it is passes none');
  w.chain.send(w.creator, [update]);
  assert.equal(w.read('Project', project).treasury, fresh);
});

test('an open grant gated by an NFT counts the NFT at a badge\'s address, never a person\'s', () => {
  const [project, wallet, nft] = ['So11111111111111111111111111111111111111112', 'Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111'];
  const grant = { incarnation: 3n, open: true, gate: { Holds: { of: { Collection: [project] }, key: '', test: { Any: {} } } }, limits: { per_person: 0, per_key: 0 }, gives: { Item: [1] } };
  const address = loot.pda.grant(project, 1);
  const ix = loot.claimGrantIx({ project, id: 1, grant, wallet, signer: wallet, shown: { asset: nft }, item: null });
  const keys = ix.keys.map((k) => k.pubkey);
  assert.ok(keys.includes(loot.pda.badge(address, 3n, nft)));
  assert.ok(!keys.includes(loot.pda.person(address, 3n, addressBytes(nft))));
});

test('a draw asked again after the oracle went stale is answered on the ticket of its first ask', { skip }, () => {
  const w = world({ seed: 'guards-ticket' });
  const id = 9;
  const address = loot.pda.lottery(w.project, id);
  w.upsert({ Lottery: { id, args: { price: 1000n, mint: w.mint, shares: [], places: [10_000], ticket_mint: SYSTEM_PROGRAM, every: 0n, draws_at: BigInt(w.chain.now() + 60), gate: null, per_wallet: 0 } } });
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery: w.read('Lottery', address), count: 1n, nonce: 1n })]);
  w.chain.warp(w.chain.now() + 61);
  w.chain.sendRaw(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id })]); // the oracle never answers
  const first = w.read('Lottery', address);
  w.chain.nextSlot(Number(loot.STALE_SLOTS) + 1);
  w.chain.sendRaw(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id })]); // asked again, no answer yet
  const asked = w.read('Lottery', address);
  assert.equal(asked.asked_first, first.asked_first, 'the round keeps the ticket of its first ask');
  assert.ok(asked.asked_slot > asked.asked_first);
  // An answer to either request names the round's ticket, and the first to land draws the round.
  const answer = loot.callbackLotteryIx({ project: w.project, id, lottery: asked, randomness: new Uint8Array(32).fill(7) });
  assert.equal(answer.keys[2].pubkey, loot.ticketOf(address, first.asked_first));
  w.chain.sendRaw(w.chain.oracle, [answer]);
  assert.notEqual(w.read('Lottery', address).status, 'Drawing');
});

test('an auction refuses a mint whose freeze authority could switch its default account state to frozen', { skip }, () => {
  const w = world({ seed: 'guards-frozen' });
  w.upsert({ Item: { id: 1, args: collectible('Painting') } });
  const open = (mint, id) => {
    const art = w.make(1, w.authority);
    const now = w.chain.now();
    return () => w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, collection: w.collection, id, mint, programs: { [mint]: TOKEN_2022_PROGRAM },
      args: { lot: { Asset: [art] }, reserve: 0n, min_raise_bps: 0, starts_at: BigInt(now), ends_at: BigInt(now + 60), extend: 0, shares: [], gate: null } })]);
  };
  const switchable = defaultStateMint(w);
  assert.ok(mayStartFrozen(switchable.account));
  fails(open(switchable.mint, 1), 'BadAuction');
  // With no freeze authority, nobody can switch it: the auction opens.
  const fixed = defaultStateMint(w, { freezer: null });
  assert.equal(mayStartFrozen(fixed.account), false);
  open(fixed.mint, 2)();
  assert.ok(w.chain.get(loot.pda.auction(w.project, w.authority, 2)));
});

test('the checker and the approval refuse such a mint on a route that reads it once', { skip }, async () => {
  const w = world({ seed: 'guards-frozen-check', platform: false });
  const { mint } = defaultStateMint(w);
  const spec = (powers) => ({
    version: 2, network: 'devnet', name: 'Frozen', currency: 'gem',
    tokens: [{ key: 'gem', source: 'existing', mint, decimals: 6, program: 'token-2022', ...(powers && { powers }) }],
    collection: { name: 'Studio' },
    items: [{ key: 'art', name: 'Art', supply: 1, uri: 'https://example.invalid/art.json' }],
    auctions: [{ key: 'art', name: 'Art', lot: { item: 'art' }, reserve: 1, runs: '24h' }],
  });
  const codes = (s) => check(s).refusals.map((r) => r.code);
  assert.ok(codes(spec({ defaultState: true, freeze: true })).includes('E-AUCTION'));
  assert.ok(!codes(spec({ defaultState: true })).includes('E-AUCTION'), 'with no freeze authority it cannot be switched');
  await assert.rejects(checkMints({ m: model(spec(null)), chain: { account: async (a) => w.chain.get(a) } }), (e) => e instanceof MintMismatch && /auction/.test(e.message));
});

test('the tools say a sharing farm releases what lands in its pool over its longest lock, a day at least', async () => {
  const { simulate } = await import('../economy/simulate.mjs');
  const { releaseWords } = await import('../economy/model.mjs');
  const spec = {
    version: 2, network: 'devnet', name: 'Release', currency: 'gem',
    tokens: [{ key: 'gem', source: 'game', symbol: 'GEM', decimals: 6 }],
    pools: [{ key: 'rewards', currency: 'gem', seed: 1000 }],
    farms: [{ key: 'stake', name: 'Stake', stakes: 'gem', rewards: 'rewards', tiers: [{ lock: '1h', multiplier: 1 }, { lock: '30d', multiplier: 3 }] }],
    scenario: { days: 30, staked: { stake: 1000 } },
  };
  assert.equal(releaseWords(spec.farms[0]), '30 days');
  assert.equal(releaseWords({ tiers: [{ lock: '1h' }] }), 'a day');
  const result = check(spec);
  assert.ok(!result.warnings.some((w) => w.code === 'W-FARM-LOCK'), 'no lock rule for rewards that land: the release spreads them');
  const first = result.warnings.find((w) => w.code === 'W-FARM-FIRST');
  assert.match(first.message, /released over 30 days/);
  assert.match(simulate(spec).farms[0].says, /released over 30 days/);
});

test('the player module offers no stake at a farm\'s end or after it, nor one whose lock runs past it', { skip }, async () => {
  const { solanaApp } = await import('../play/index.js');
  const w = world({ seed: 'guards-farm-end' });
  const rewards = w.newMint();
  w.pool(5, rewards);
  const endsAt = BigInt(w.chain.now() + 3_600);
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 2, rewardsMint: rewards, stakedMint: w.mint,
    args: { custody: 'Escrow', rewards_pool: 5, tiers: [{ lock: 0, bps: 10_000 }, { lock: 7_200, bps: 20_000 }], boosts: [], max_boost_bps: 0, gate: null, ends_at: endsAt } })]);
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'season', name: 'Season', id: 2, stakes: 'coin' }] };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: w.player, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  const farm = w.read('Farm', loot.pda.farm(w.project, 2));
  assert.ok(loot.farmOpenFor(farm, 0, endsAt - 1n) && !loot.farmOpenFor(farm, 0, endsAt) && !loot.farmOpenFor(farm, 1, endsAt - 3_600n));
  await assert.rejects(app.stake('season', '1', 1), /would run past it/);
  await app.stake('season', '1', 0);
  // At the end itself the program refuses a stake (`now < ends_at`), and the module refuses it first.
  w.chain.warp(Number(endsAt));
  const seat = w.read('Seat', loot.pda.seat(loot.pda.farm(w.project, 2), w.player));
  fails(() => w.chain.send(w.player, [loot.stakeTokensIx({ player: w.player, project: w.project, id: 2, farm, amount: 1_000_000n, tier: 0 })]), 'FarmOver');
  await assert.rejects(app.stake('season', '1', 0), /ended at .*takes no stake/);
  w.chain.warp(Number(endsAt) + 86_400);
  await assert.rejects(app.stake('season', '1', 0), /takes no stake/);
  assert.equal(w.read('Seat', loot.pda.seat(loot.pda.farm(w.project, 2), w.player)).amount, seat.amount, 'the seat is as it was');
  await app.unstake('season', '1');
  assert.equal(w.chain.get(loot.pda.seat(loot.pda.farm(w.project, 2), w.player)), null, 'a seat still leaves after the end');
});

test('the tools say what the end of a sharing farm keeps in its pool', async () => {
  const { simulate } = await import('../economy/simulate.mjs');
  const { explainEconomy } = await import('../economy/explain.mjs');
  const spec = {
    version: 2, network: 'devnet', name: 'Season', currency: 'gem',
    tokens: [{ key: 'gem', source: 'game', symbol: 'GEM', decimals: 6 }],
    collection: { name: 'Studio' },
    pools: [{ key: 'rewards', currency: 'gem', seed: 1000 }],
    farms: [{ key: 'season', name: 'Season', stakes: 'collectibles', custody: 'watch', rewards: 'rewards', runs: '14d', tiers: [{ lock: '0s', multiplier: 1 }, { lock: '14d', multiplier: 2 }] }],
    scenario: { days: 30 },
  };
  const result = check(spec);
  assert.deepEqual(result.refusals, []);
  const runs = result.warnings.find((x) => x.code === 'W-FARM' && x.where.endsWith('.runs'));
  assert.match(runs.message, /takes no stake at its end/);
  assert.match(runs.message, /not released by its end stays in the pool, the project’s/);
  assert.match(runs.message, /fund it at least 14 days before its end/);
  assert.match(runs.message, /refresh a seat you suspect is dead \(a watched NFT sold\) at least 14 days before the end/);
  assert.ok(result.warnings.some((x) => x.where === 'economy.farms.season.tiers[1].lock'), 'a lock as long as the farm runs is never taken: the farm takes no seat at its end');
  const sim = simulate(spec);
  assert.match(sim.farms[0].end, /fund it at least 14 days before its end/);
  assert.ok(sim.notes.some((n) => /runs 14d, less than the scenario’s 30 days/.test(n)));
  assert.match(explainEconomy(spec).text, /taking no stake at its end or after it/);
  // A farm at a fixed rate has no release to keep.
  const rated = { ...spec, farms: [{ ...spec.farms[0], rate: { perDay: 1, minted: true } }] };
  assert.doesNotMatch(check(rated).warnings.find((x) => x.code === 'W-FARM' && x.where.endsWith('.runs')).message, /not released/);
});

test('W-FARM-ROUNDING: a sharing farm of a token with a great many base units, paying a reward of few, is warned', () => {
  const spec = (stake, reward, seed = 2000, extra = {}) => ({
    version: 2, network: 'devnet', name: 'Meme', currency: 'pts',
    tokens: [{ key: 'meme', source: 'existing', mint: 'Stake11111111111111111111111111111111111111', symbol: 'MEME', ...stake }, { key: 'pts', source: 'game', symbol: 'PTS', ...reward }],
    pools: [{ key: 'rewards', currency: 'pts', seed }],
    farms: [{ key: 'stake', name: 'Stake', stakes: 'meme', rewards: 'rewards', tiers: [{ lock: '1d', multiplier: 1 }, { lock: '7d', multiplier: 7 }], ...extra }],
  });
  const rounding = (s) => check(s).warnings.find((x) => x.code === 'W-FARM-ROUNDING');
  // A billion MEME at 6 decimals and x7 weighs 7×10¹⁵: a step of 7,000 PTS, more than the 2,000 a release.
  const w = rounding(spec({ decimals: 6 }, { decimals: 0 }));
  assert.match(w.message, /7×10¹⁵ base units of MEME/);
  assert.match(w.message, /steps of about 7,000 base units of PTS/);
  assert.match(w.message, /rounds down to nothing/);
  assert.match(w.fix, /Stake a token with fewer base units/);
  assert.match(w.fix, /about 700,000 base units of PTS/);
  // Larger than a step but under a hundred: part of each release waits.
  assert.match(rounding(spec({ decimals: 6 }, { decimals: 0 }, 70_000)).message, /lose up to 10% of a release/);
  // Rewards with decimals of their own, a stake of few base units, a known small supply, or a fixed rate: no warning.
  assert.equal(rounding(spec({ decimals: 6 }, { decimals: 6 })), undefined);
  assert.equal(rounding(spec({ decimals: 0 }, { decimals: 0 })), undefined);
  assert.equal(rounding(spec({ decimals: 6, source: 'game', mint: undefined, supply: 1000 }, { decimals: 0 })), undefined);
  assert.equal(rounding(spec({ decimals: 6 }, { decimals: 0 }, 2000, { rate: { perDay: 1, minted: true } })), undefined);
});

test('W-FARM-FEE: a farm whose rewards keep a transfer fee says a refresh that changes nothing releases a chunk at a time', () => {
  const spec = (rate) => ({
    version: 2, network: 'devnet', name: 'Fee', currency: 'gem',
    tokens: [{ key: 'gem', source: 'existing', mint: 'Stake11111111111111111111111111111111111111', symbol: 'GEM', decimals: 6, program: 'token-2022', powers: { transferFeePercent: 1 } }],
    pools: [{ key: 'rewards', currency: 'gem', seed: 1000 }],
    farms: [{ key: 'stake', name: 'Stake', stakes: 'gem', rewards: 'rewards', tiers: [{ lock: '1d', multiplier: 1 }], ...(rate && { rate }) }],
  });
  const fee = (s) => check(s).warnings.find((x) => x.code === 'W-FARM-FEE');
  assert.match(fee(spec()).message, /releases a chunk at a time, 10,000 base units/);
  assert.match(fee(spec({ perDay: 1, minted: false })).message, /every move pays from the pool/);
  assert.equal(fee(spec({ perDay: 1, minted: true })), undefined, 'a minted rate moves nothing out of a pool');
});
