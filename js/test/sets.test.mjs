// A set bound into a badge, as the client builds it and the program takes it: four pieces staked, taken by a recipe
// only while they are in the farm each line names (`Staked { item, farm }`, each with its seat and that farm), in one
// legacy transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import { compileMessage, MAX_TRANSACTION_BYTES, SIGNATURE_BYTES, signersOf } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;
const DAY = 86_400;
const AWAY = 20_000 * DAY;
const bytesOf = (payer, instructions) => {
  const message = compileMessage({ payer, blockhash: '11111111111111111111111111111111', instructions });
  return message.length + 1 + SIGNATURE_BYTES * signersOf(message).length;
};

test('four staked pieces bind into a badge in one transaction, and stay staked until it is burned', { skip }, () => {
  const w = world({ seed: 'sets' });
  for (const id of [1, 2, 3, 4, 5]) w.upsert({ Item: { id, args: collectible(`Piece ${id}`) } });
  const spark = w.newMint(w.creator);
  w.pool(7, spark);
  const args = { custody: 'Escrow', rewards_pool: 7, tiers: [{ lock: DAY, bps: 10_000 }], boosts: [], max_boost_bps: 0, rate: { per_day: 0n, mints: true }, growth: [{ key: 'xp', per_day: 1, level: '', steps: [], streak: false }], lock_key: 'free_at' };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 3, args, rewardsMint: spark })]);
  const raise = (place, key, by, most) => ({ place, key, by, most });
  const staked = [1, 2, 3, 4].map((item) => ({ Staked: { item, farm: 3 } }));
  w.upsert({ Recipe: { id: 1, args: { active: true, inputs: staked, outputs: [{ Prize: [{ Item: [5] }] }], needs: [], keeps: [], raises: [0, 1, 2, 3].flatMap((p) => [raise(p, 'bound', 1, 1), raise(p, 'free_at', AWAY, 4_294_967_295)]) } } });
  w.upsert({ Recipe: { id: 2, args: { active: true, inputs: [{ Burn: { item: 5, count: 1 } }, ...staked], outputs: [], needs: [1, 2, 3, 4].map((place) => ({ place, key: 'bound', at_least: 1 })), keeps: [], raises: [1, 2, 3, 4].flatMap((p) => [raise(p, 'bound', -1, 0), raise(p, 'free_at', -AWAY, 0)]) } } });
  const farm = w.read('Farm', pda.farm(w.project, 3));
  const pieces = [1, 2, 3, 4].map((item) => w.make(item, w.player));
  for (const asset of pieces) w.chain.send(w.player, [loot.stakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset, collection: w.collection })]);

  const badge = pda.itemAsset(pda.item(w.project, 5), 1);
  const items = { 5: w.read('Item', pda.item(w.project, 5)) };
  const recipe = w.read('Recipe', pda.recipe(w.project, 1));
  const bind = [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 1, recipe, assets: pieces.map((asset) => ({ asset, farm: 3 })), items })];
  assert.ok(bytesOf(w.player, bind) <= MAX_TRANSACTION_BYTES, `${bytesOf(w.player, bind)} bytes`);
  w.chain.send(w.player, bind);
  assert.equal(parseCoreAsset(w.chain.get(badge).data).owner, w.player);
  assert.ok(pieces.every((p) => parseCoreAsset(w.chain.get(p).data).attributes.bound === '1'));
  // The line names the farm: a plain address takes it from there, and another farm is refused before it is sent.
  assert.deepEqual(loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 1, recipe, assets: pieces, items }).keys, bind[1].keys);
  assert.throws(() => loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 1, recipe, assets: pieces.map((asset) => ({ asset, farm: 4 })), items }), /staked in farm 3, not farm 4/);

  w.chain.warp(w.chain.now() + 2 * DAY);
  const leave = () => w.chain.send(w.player, [computeUnitLimit(400_000), loot.unstakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset: pieces[0], collection: w.collection })]);
  assert.throws(leave, /StillLocked/);
  const unbind = w.read('Recipe', pda.recipe(w.project, 2));
  w.chain.send(w.player, [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 2, recipe: unbind, assets: [badge, ...pieces.map((asset) => ({ asset, farm: 3 }))] })]);
  leave();
  assert.equal(parseCoreAsset(w.chain.get(pieces[0]).data).owner, w.player);
});
