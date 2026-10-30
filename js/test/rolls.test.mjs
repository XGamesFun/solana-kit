// A roll on an NFT, as the client builds it and the program takes it: a box that rolls on the NFT a player brings,
// and a mission that rolls on the NFT leaving it, asked for by anyone and settled by anyone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;
const hero = { of: { Item: [1] }, key: '', test: 'Any' };
// Entry 0: a level up, back home; entry 1: burned.
const fates = [{ entry: 0, shifts: [{ key: 'level', by: 1, most: 0 }], then: 'Back' }, { entry: 1, shifts: [], then: 'Burn' }];
const box = (active) => ({
  price: 0n, currency: null, rise: null, fall: null, stock_odds: false, active, shares: [],
  entries: [{ outcome: 'Nothing', weight: 1 }, { outcome: 'Nothing', weight: 1 }], odds: [], subject: hero, fates,
});
const levelOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).attributes.level;
const gone = (w, asset) => !w.chain.get(asset) || w.chain.get(asset).data.length <= 1;

test('a box rolls on the NFT a player brings: held until settled, then a level up or burned', { skip }, () => {
  const w = world({ seed: 'rolls-box' });
  w.upsert({ Item: { id: 1, args: collectible('Hero') } });
  w.upsert({ Box: { id: 5, args: box(true) } });
  const asset = w.make(1, w.player, [{ key: 'level', value: '3' }]);
  const lb = w.read('LootBox', pda.box(w.project, 5));
  const g = w.projectState();
  const ix = loot.openBoxIx({ player: w.player, project: w.project, projectMint: g.mint, box: lb, nonce: 1n, subject: { asset, collection: w.collection } });
  w.chain.send(w.player, [computeUnitLimit(400_000), ix]);
  // A roll that moves the NFT's numbers is at the NFT's own nonce, whatever nonce was asked for.
  const orderAddress = pda.order(w.project, w.player, loot.nonceOn(asset));
  const order = w.read('Order', orderAddress);
  assert.deepEqual([order.subject, order.held, order.status], [asset, true, 'Rolled']);
  assert.equal(parseCoreAsset(w.chain.get(asset).data).owner, w.project, 'the project holds it until the roll is settled');
  w.chain.nextSlot();
  w.chain.send(w.cranker, [computeUnitLimit(400_000), loot.settleIx({ signer: w.cranker, orderAddress, order, projectState: g, subject: { collection: w.collection } })]);
  if (order.fate?.then === 'Burn') assert.ok(gone(w, asset));
  else assert.deepEqual([parseCoreAsset(w.chain.get(asset).data).owner, levelOf(w, asset)], [w.player, '4']);
});

test('a mission rolls on the NFT leaving it: the roll waits for anyone to ask, then settles', { skip }, () => {
  const w = world({ seed: 'rolls-mission' });
  w.upsert({ Item: { id: 1, args: collectible('Hero') } });
  w.upsert({ Box: { id: 6, args: box(false) } });
  const dust = w.newMint(w.creator);
  w.pool(7, dust);
  const args = {
    custody: 'Escrow', rewards_pool: 7, tiers: [{ lock: 60, bps: 10_000, roll: 6 }], boosts: [], max_boost_bps: 0,
    gates: [hero], rate: { per_day: 0n, mints: true },
  };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 3, args, rewardsMint: dust })]);
  const farm = w.read('Farm', pda.farm(w.project, 3));
  const asset = w.make(1, w.player, [{ key: 'level', value: '1' }]);
  w.tokenAccount(w.player, dust);
  w.chain.send(w.player, [loot.stakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset, collection: w.collection })]);
  w.chain.warp(w.chain.now() + 61);
  w.chain.send(w.player, [computeUnitLimit(400_000), loot.unstakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset, collection: w.collection, roll: 6, nonce: loot.nonceOn(asset) })]);
  const orderAddress = pda.order(w.project, w.player, loot.nonceOn(asset));
  let order = w.read('Order', orderAddress);
  assert.deepEqual([order.status, order.held], ['Waiting', true]);
  assert.equal(parseCoreAsset(w.chain.get(asset).data).owner, w.project);
  const lb = w.read('LootBox', pda.box(w.project, 6));
  w.chain.send(w.cranker, loot.askRollIx({ payer: w.cranker, orderAddress, order, box: lb }));
  order = w.read('Order', orderAddress);
  assert.equal(order.status, 'Rolled', 'the oracle answered');
  w.chain.nextSlot();
  w.chain.send(w.cranker, [computeUnitLimit(400_000), loot.settleIx({ signer: w.cranker, orderAddress, order, projectState: w.projectState(), subject: { collection: w.collection } })]);
  if (order.fate?.then === 'Burn') assert.ok(gone(w, asset));
  else assert.equal(levelOf(w, asset), '2');
});

test('the checker keeps rolls a mission or a recipe makes from being bought or skipped', async () => {
  const { readFileSync } = await import('node:fs');
  const { check } = await import('../economy/check.mjs');
  const spec = JSON.parse(readFileSync(new URL('../../examples/hero-trials.json', import.meta.url), 'utf8'));
  const now = 1_790_000_000;
  const codes = (s) => check(s, { now }).refusals.map((e) => `${e.code} ${e.where}`);
  assert.deepEqual(codes(spec), []);
  const edit = (f) => {
    const s = structuredClone(spec);
    f(s);
    return codes(s);
  };
  const result = (s) => s.boxes.find((b) => b.key === 'expedition-result');
  assert.ok(edit((s) => { result(s).active = true; }).includes('E-ROLL economy.boxes.expedition-result.active'), 'for sale, anyone could skip the mission');
  assert.ok(edit((s) => { delete result(s).rollsOn; }).some((e) => e.startsWith('E-ROLL')), 'a fate needs an NFT to act on');
  assert.ok(edit((s) => { s.farms[0].tiers[0].lock = 0; }).includes('E-FARM economy.farms.expedition.tiers[0].roll'), 'a roll with no lock');
  assert.ok(edit((s) => { s.recipes[0].out[0].on = 1; }).includes('E-RECIPE economy.recipes.risky-forge.out[0].on'), 'it rolls on one it does not keep');
  assert.ok(edit((s) => { s.recipes[0].out.push({ gives: 'roll', box: 'forge', on: 0 }); }).includes('E-RECIPE economy.recipes.risky-forge.out'), 'one roll a craft');
});
