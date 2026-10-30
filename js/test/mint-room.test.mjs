// A rate that mints mints only what the mint has room for under u64::MAX, and what it can't mint is not owed later:
// the checker warns when a farm's rate could come near that, and the simulation and the explainer say so. A stash's
// NFT never goes out to another account of the program: the client refuses the ones it names, and the program refuses
// any (ToTheProject).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { simulate } from '../economy/simulate.mjs';
import { cannotRun, collectible, world } from './world.mjs';

const { pda } = loot;
const NOW = 1_790_000_000;
const fails = (fn, error) => assert.throws(fn, (e) => (e.logs ?? []).some((l) => l.includes(error)) || String(e.message).includes(error));
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const stashOf = (w, id) => loot.decodeStash(w.chain.get(pda.stash(w.project, id))?.data)?.nfts ?? [];

/** A farm of MEME (a billion, 6 decimals) at x1 and x7, paying PTS at a fixed rate. */
const rated = (rate, { reward = {}, runs } = {}) => ({
  version: 2, network: 'devnet', name: 'Meme', currency: 'pts',
  tokens: [{ key: 'meme', source: 'existing', mint: 'Stake11111111111111111111111111111111111111', symbol: 'MEME', decimals: 6 }, { key: 'pts', source: 'game', symbol: 'PTS', decimals: 9, ...reward }],
  pools: [{ key: 'rewards', currency: 'pts' }],
  farms: [{ key: 'stake', name: 'Stake', stakes: 'meme', rewards: 'rewards', rate, tiers: [{ lock: '1d', multiplier: 1 }, { lock: '7d', multiplier: 7 }], ...(runs ? { runs } : {}) }],
});
const room = (spec) => check(spec, { now: NOW }).warnings.find((x) => x.code === 'W-FARM-MINT-ROOM');

test('the checker warns of a minting rate that could come near the most a mint can hold', () => {
  // 0.001 PTS a day for each MEME, a billion staked at x7, ten years: about 2.6×10¹⁹ base units, past u64::MAX.
  const w = room(rated({ perDay: 0.001, minted: true }));
  assert.equal(w.where, 'economy.farms.stake.rate');
  assert.match(w.message, /a billion MEME staked at x7, over ten years/);
  assert.match(w.message, /more than the most a mint can ever hold \(about 1\.8×10¹⁹ base units, 1\.8×10¹⁰ PTS at 9 decimals\)/);
  assert.match(w.message, /what it can’t mint is never owed later/);
  assert.match(w.fix, /Lower "perDay", give the farm an end \("runs"\)/);
  // Its run counts: 30 days of the same is about 1% of the room, under a tenth; 300 days, about 11%.
  assert.equal(room(rated({ perDay: 0.001, minted: true }, { runs: '30d' })), undefined);
  assert.match(room(rated({ perDay: 0.001, minted: true }, { runs: '300d' })).message, /over its 300d, that is about 2\.1×10¹⁸ base units, 11% of the most a mint can ever hold/);
  // Fewer decimals, a rate from a pool, or a rate of 0: no warning.
  assert.equal(room(rated({ perDay: 0.001, minted: true }, { reward: { decimals: 3 } })), undefined);
  assert.equal(room(rated({ perDay: 1, minted: false })), undefined);
  assert.equal(room(rated({ perDay: 0, minted: true })), undefined);
});

test('the simulation and the explainer say a minting rate mints only while the mint has room', () => {
  const spec = rated({ perDay: 1, minted: true }, { reward: { decimals: 0 }, runs: '30d' });
  assert.match(simulate(spec).farms[0].says, /\(minted, as far as the mint has room for: what it can’t mint is not owed later\)/);
  assert.match(explainEconomy(spec).text, /minted while the mint has room for it, never owed later past that/);
  // A rate from a pool still says it pays while the pool lasts.
  assert.match(simulate(rated({ perDay: 1, minted: false }, { reward: { decimals: 0 }, runs: '30d' })).farms[0].says, /while the pool lasts/);
});

test('stashIx refuses taking an NFT out to an account of the program it names', () => {
  const project = pda.project('5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T');
  const signer = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
  const asset = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
  const collection = 'Stake11111111111111111111111111111111111111';
  const own = pda.lottery(project, 3);
  for (const [out, args] of [[pda.stash(project, 1), { id: 1 }], [pda.lotteryStash(own), { lottery: 3 }], [own, { lottery: 3 }], [pda.fees(project), { id: 1 }], [pda.platform(), { id: 1 }]])
    assert.throws(() => loot.stashIx({ signer, project, asset, out, collection, ...args }), /can’t go to an account of the program/);
  // A wallet, and the project's own address (only dropped from the stash), are built.
  assert.ok(loot.stashIx({ signer, project, id: 1, asset, out: signer, collection }));
  assert.ok(loot.stashIx({ signer, project, id: 1, asset, out: project, collection }));
});

test('the program refuses a stash take-out to any of its accounts (ToTheProject); the project’s address only drops it', { skip: cannotRun() ?? false }, () => {
  const w = world({ seed: 'mint-room-stash' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const nfts = [0, 1].map(() => w.make(1, w.authority));
  for (const asset of nfts) w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset, collection: w.collection })]);
  // An item record is the program's, and no call of the client names it: the program refuses it.
  const record = pda.item(w.project, 1);
  assert.equal(w.chain.get(record).owner, loot.LOOT_PROGRAM);
  fails(() => w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset: nfts[0], out: record, collection: w.collection })]), 'ToTheProject');
  assert.deepEqual(stashOf(w, 1), nfts, 'still in the stash');
  assert.equal(ownerOf(w, nfts[0]), w.project);
  // To the project's own address, it only leaves the stash's list.
  w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset: nfts[0], out: w.project, collection: w.collection })]);
  assert.deepEqual(stashOf(w, 1), [nfts[1]]);
  assert.equal(ownerOf(w, nfts[0]), w.project);
  // To a wallet, it goes.
  const winner = w.who();
  w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset: nfts[1], out: winner, collection: w.collection })]);
  assert.equal(ownerOf(w, nfts[1]), winner);
});
