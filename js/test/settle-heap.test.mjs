// The checker warns of a box whose settle doesn't fit the heap once a payee turns on required memos, and of prizes
// naming NFTs of a stash players fill without end; the approval refuses a treasury that is a multisig's own account
// rather than its vault; a large settle asks for the 256 KiB heap the program's own allocator uses; a staked recipe
// line names its farm, and a raise on its piece moves that farm's lock; a rate farm's give-back goes back to the pool.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMints, checkTreasury, MintMismatch } from '../approve/live-check.mjs';
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import { parseCoreAsset } from '../chain/core.js';
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { requestHeapFrame } from '../chain/programs.js';
import { readMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { model } from '../economy/model.mjs';
import { recipeArgs } from '../economy/plan.mjs';
import { simulate } from '../economy/simulate.mjs';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const NOW = 1_790_000_000;
const WALLET = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const NFT = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
const warned = (spec) => check(spec, { now: NOW }).warnings.map((w) => `${w.code} ${w.where}`);
const refused = (spec) => check(spec, { now: NOW }).refusals.map((r) => `${r.code} ${r.where}`);

/** A box of `picks` NFTs of one stash an outcome, giving the NFT it rolls on away (`subject`), with `holders` holders' and `wallets` wallets' shares. */
const heavyBox = ({ hooked = true, picks = 3, holders = 3, wallets = 0, subject = true } = {}) => ({
  version: 2, network: 'devnet', name: 'Heavy', currency: 'gem',
  tokens: [{ key: 'gem', source: 'existing', mint: NFT, decimals: 6, program: 'token-2022', ...(hooked ? { powers: { transferHook: true } } : {}) }],
  collection: { name: 'Heavy' },
  stashes: [{ key: 'chest', name: 'Chest', nfts: [] }],
  boxes: [{ key: 'triple', name: 'Triple', price: 1, ...(subject ? { rollsOn: { collection: WALLET }, then: { giveTo: WALLET } } : {}),
    split: [...Array.from({ length: holders }, () => ({ to: `holder:${WALLET}`, percent: 1 })), ...Array.from({ length: wallets }, () => ({ to: `wallet:${WALLET}`, percent: 1 }))],
    outcomes: [{ gives: 'bundle', prizes: Array.from({ length: picks }, () => ({ gives: 'stash', stash: 'chest' })), chance: 50 }, { gives: 'nothing', chance: 50 }] }],
});

test('W-BOX-HEAP for the shapes measured not to fit once a payee turns on memos, and not for those that fit', () => {
  const heap = 'W-BOX-HEAP economy.boxes.triple.outcomes';
  for (const shape of [{}, { holders: 4 }, { holders: 1, wallets: 2 }]) {
    assert.deepEqual(refused(heavyBox(shape)), [], JSON.stringify(shape));
    assert.ok(warned(heavyBox(shape)).includes(heap), `three picks, the subject given away, three or more payees, a hooked coin: ${JSON.stringify(shape)}`);
  }
  for (const shape of [{ holders: 2 }, { picks: 2, holders: 4 }, { hooked: false, holders: 4 }, { subject: false, holders: 4 }])
    assert.ok(!warned(heavyBox(shape)).includes(heap), `fits (SIZE3 table): ${JSON.stringify(shape)}`);
  const words = check(heavyBox({ holders: 4 }), { now: NOW }).warnings.find((w) => w.code === 'W-BOX-HEAP').message;
  assert.match(words, /required memos/);
});

test('a large settle asks for a 256 KiB heap frame; a small one asks for none', () => {
  assert.deepEqual([...requestHeapFrame(256 * 1024).data], [1, 0, 0, 4, 0]);
  const order = { won: [{ Nft: { nft: NFT } }, { Nft: { nft: NFT } }, { Nft: { nft: NFT } }], subject: WALLET };
  assert.equal(loot.LARGE_SETTLE_HEAP, 256 * 1024);
  assert.equal(loot.settleHeapFrame(order), 256 * 1024);
  assert.equal(loot.settleHeapFrame({ won: [{ Nft: { nft: NFT } }, { Nft: { nft: NFT } }], subject: WALLET }), 256 * 1024, 'two prizes and the NFT rolled on are three moves');
  assert.equal(loot.settleHeapFrame({ won: [{ Nft: { nft: NFT } }], subject: SYSTEM_PROGRAM }), 0, 'a small settle never asks');
});

test('js/play settles a roll that won three NFTs with the 256 KiB heap frame, on the program', { skip: cannotRun() ?? false }, async () => {
  const w = world({ seed: 'settle-heap' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const nfts = [0, 1, 2].map(() => w.make(1, w.authority));
  for (const asset of nfts) w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset, collection: w.collection })]);
  w.upsert({ Box: { id: 5, args: { price: 0n, currency: null, rise: null, fall: null, stock_odds: false, active: false, shares: [], entries: [{ prizes: [{ Stash: [1] }, { Stash: [1] }, { Stash: [1] }], burns: false, weight: 1 }], odds: [] } } });
  const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 1, args: { gives: { Roll: [5] }, vouchers: [SYSTEM_PROGRAM, SYSTEM_PROGRAM, SYSTEM_PROGRAM], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true } } });
  const player = freshKeypair();
  w.chain.airdrop(player.address, 10_000_000_000n);
  // The wallet keeps each transaction it signs, to read what the settle asked for.
  const signed = [];
  const wallet = { address: player.address, async signTransaction(wire) {
    const t = readTransaction(wire);
    signed.push(readMessage(t.message));
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(player.address)] = player.sign(t.message);
    return wireTransaction(t.message, sigs);
  } };
  const spec = { version: 2, name: 'Heap', currency: 'gold', tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }], grants: [{ key: 'chest', id: 1 }], live: { project: w.project, collection: w.collection, mints: { gold: w.mint } } };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  await app.claimGrant('chest');
  const [roll] = (await app.claims()).filter((c) => c.kind === 'settle');
  signed.length = 0;
  await app.claim(roll);
  assert.equal(w.chain.get(roll.order), null, 'settled: the order closed');
  assert.ok(nfts.every((nft) => parseCoreAsset(w.chain.get(nft).data).owner === player.address), 'all three NFTs are the player’s');
  const frames = signed.flatMap((msg) => msg.instructions.filter((ix) => msg.keys[ix.programIndex] === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 1));
  assert.deepEqual(frames.map((ix) => [...ix.data]), [[1, 0, 0, 4, 0]], 'one RequestHeapFrame of 256 KiB, on the settle');
});

/** A set bound into a badge: two pieces taken staked in `farm` (null: none named), the recipe raising `keys` on each. */
const setSpec = ({ farm = 'altar', keys = ['bound', 'free_at'], custody, lockAttribute = 'free_at', line = {} } = {}) => ({
  version: 2, network: 'devnet', name: 'Set', currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }, { key: 'spark', source: 'game', symbol: 'SPARK', decimals: 0 }],
  collection: { name: 'Set' },
  items: [{ key: 'fire', name: 'Fire', price: 0.01 }, { key: 'water', name: 'Water', price: 0.01 }, { key: 'badge', name: 'Badge' }],
  pools: [{ key: 'spark-rewards', currency: 'spark' }],
  recipes: [{ key: 'bind', name: 'Bind', in: ['fire', 'water'].map((item) => ({ takes: 'staked', item, ...(farm === null ? {} : { farm }), ...line })), out: [{ gives: 'item', item: 'badge' }],
    raises: [0, 1].flatMap((place) => keys.map((key) => (key === 'free_at' ? { place, key, by: '20000d' } : { place, key, by: 1, upTo: 1 }))) }],
  farms: [
    { key: 'altar', name: 'The altar', stakes: 'collectibles', rewards: 'spark-rewards', rate: { perDay: 10, minted: true }, tiers: [{ lock: '1d' }], ...(lockAttribute ? { lockAttribute } : {}), ...(custody ? { custody } : {}) },
    { key: 'vault', name: 'The vault', stakes: 'spark', rewards: 'spark-rewards', tiers: [{ lock: '1d' }] },
  ],
});

test('a staked line names its farm, in the spec, the plan and the checker', () => {
  const m = model(setSpec(), { now: NOW });
  assert.deepEqual(refused(setSpec()), []);
  assert.deepEqual(recipeArgs(m.recipe.get('bind'), m).inputs, [{ Staked: { item: m.item.get('fire').id, farm: m.farm.get('altar').id } }, { Staked: { item: m.item.get('water').id, farm: m.farm.get('altar').id } }]);
  const says = (spec) => check(spec, { now: NOW }).refusals.filter((r) => r.where.startsWith('economy.recipes.bind.in')).map((r) => r.message);
  assert.match(says(setSpec({ farm: null }))[0], /does not say in which farm/);
  assert.match(says(setSpec({ farm: 'nowhere' }))[0], /not a farm/);
  assert.match(says(setSpec({ farm: 'vault' }))[0], /a farm of tokens/);
  assert.match(says(setSpec({ custody: 'watch' }))[0], /watches NFTs/);
  // A raise on the piece must move the lock its farm reads (BadRecipe).
  assert.match(says(setSpec({ keys: ['bound'] }))[0], /keeps its lock under “free_at”.*BadRecipe/);
  assert.match(says(setSpec({ lockAttribute: null }))[0], /keeps no lock on the NFT.*BadRecipe/);
  // No raise at all moves no lock: taken, with a word that nothing keeps it staked when its farm reads no lock.
  assert.deepEqual(refused(setSpec({ keys: [], lockAttribute: null })), []);
  assert.ok(warned(setSpec({ keys: [], lockAttribute: null })).includes('W-STAKED economy.recipes.bind.in[0].farm'));
  assert.ok(!warned(setSpec()).some((w) => w.startsWith('W-STAKED')));
});

test('a rate farm’s give-back goes back to its pool, or is burned when the rate mints; never to the other seats', () => {
  const minted = simulate(setSpec(), { now: NOW }).farms.find((f) => f.key === 'altar');
  assert.match(minted.says, /gives back.*burned.*never to the other seats/);
  const fromPool = structuredClone(setSpec());
  fromPool.farms[0].rate.minted = false;
  fromPool.pools[0].seed = 1000;
  assert.match(simulate(fromPool, { now: NOW }).farms.find((f) => f.key === 'altar').says, /gives back.*back to “spark-rewards”.*never to the other seats/);
  assert.match(explainEconomy(fromPool, { now: NOW }).text.split('\n').find((a) => a.includes('Stake collectibles in “The altar”')), /gives back.*back to “spark-rewards”.*never to the other seats/);
});

test('W-STASH-NAMED when prizes name NFTs of a stash that players fill; not when only the owner fills it', () => {
  const spec = (fed) => ({
    version: 2, network: 'devnet', name: 'Named', currency: 'gem',
    tokens: [{ key: 'gem', source: 'game', symbol: 'GEM', decimals: 6 }],
    collection: { name: 'Named' },
    stashes: [{ key: 'chest', name: 'Chest', collection: WALLET, nfts: [NFT] }],
    boxes: [
      { key: 'pick', name: 'Pick', price: 1, outcomes: [{ gives: 'nft', stash: 'chest', nft: NFT, chance: 50 }, { gives: 'nothing', chance: 50 }] },
      ...(fed ? [{ key: 'trade', name: 'Trade in', price: 1, rollsOn: { collection: WALLET }, then: { stash: 'chest' }, outcomes: [{ gives: 'nothing', chance: 100 }] }] : []),
    ],
  });
  assert.deepEqual(refused(spec(true)), []);
  assert.ok(warned(spec(true)).includes('W-STASH-NAMED economy.stashes.chest'), warned(spec(true)).join());
  const words = check(spec(true), { now: NOW }).warnings.find((w) => w.code === 'W-STASH-NAMED').message;
  assert.match(words, /52 compute units/);
  assert.match(words, /11,500 NFTs/, 'a roll naming one NFT: 1.2M / (52 × 2)');
  assert.ok(!warned(spec(false)).includes('W-STASH-NAMED economy.stashes.chest'));
});

test('the approval refuses a treasury that is a multisig’s own account, a token account or a program', async () => {
  const spec = { version: 2, network: 'devnet', name: 'Vault', currency: 'gem', treasury: `wallet:${WALLET}`, tokens: [{ key: 'gem', source: 'game', symbol: 'GEM', decimals: 6 }], collection: { name: 'Vault' }, items: [{ key: 'a', name: 'A', price: 1 }] };
  const on = (account) => ({ account: async (a) => (a === WALLET ? account : null) });
  const m = model(spec, { now: NOW });
  const multisig = { owner: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', data: new Uint8Array(200), lamports: 1n, executable: false };
  await assert.rejects(checkTreasury({ m, chain: on(multisig) }), (e) => e instanceof MintMismatch && /Squads multisig’s own account, not its vault/.test(e.message));
  await assert.rejects(checkMints({ m, chain: on(multisig) }), MintMismatch, 'part of the mints’ check the approval runs first');
  await assert.rejects(checkTreasury({ m, chain: on({ owner: TOKEN_PROGRAM, data: new Uint8Array(165), lamports: 1n }) }), /an account of the program/);
  await checkTreasury({ m, chain: on({ owner: SYSTEM_PROGRAM, data: new Uint8Array(0), lamports: 1n, executable: false }) });
  await checkTreasury({ m, chain: on(null) });
});
