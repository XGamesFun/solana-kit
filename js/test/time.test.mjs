// Times a farm keeps on the NFT, as the client builds them and the program takes them: a lock written as the time it
// ends, which a recipe takes a day off; and fuel that lasts until a time, bought by a recipe for a ship staked in
// escrow (its seat and farm follow it into the craft) and counted once its seat is refreshed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { recipeArgs, farmArgs } from '../economy/plan.mjs';
import { model } from '../economy/model.mjs';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;
const DAY = 86_400;
const numberOf = (w, asset, key) => Number(parseCoreAsset(w.chain.get(asset).data).attributes[key] ?? 0);

test('a ship staked in escrow is refuelled and let out early by recipes, its seat and farm passed along', { skip }, () => {
  const w = world({ seed: 'time-farm' });
  w.upsert({ Item: { id: 1, args: collectible('Ship') } });
  const gem = w.newMint(w.creator);
  w.pool(7, gem, 1_000_000n);
  const args = {
    custody: 'Escrow', rewards_pool: 7, tiers: [{ lock: 3 * DAY, bps: 10_000 }], boosts: [], max_boost_bps: 0,
    rate: { per_day: 1_000n, mints: false }, lock_key: 'free_at', upkeep_key: 'fuel',
  };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 3, args, rewardsMint: gem })]);
  const coin = w.mint;
  const use = { Use: { item: 1 } }, burn = { Pay: { mint: coin, amount: 10n, to: 'Burn' } };
  w.upsert({ Recipe: { id: 1, args: { active: true, inputs: [use, burn], outputs: [], needs: [], keeps: [], raises: [{ place: 0, key: 'fuel', by: DAY, most: 3 * DAY, from_now: true }] } } });
  w.upsert({ Recipe: { id: 2, args: { active: true, inputs: [use, burn], outputs: [], needs: [], keeps: [], raises: [{ place: 0, key: 'free_at', by: -3 * DAY, most: 0 }] } } });
  const farm = w.read('Farm', pda.farm(w.project, 3));
  assert.deepEqual([farm.lock_key, farm.upkeep_key], ['free_at', 'fuel']);
  const ship = w.make(1, w.player);
  w.tokenAccount(w.player, gem);
  w.chain.send(w.player, [loot.stakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset: ship, collection: w.collection })]);
  const staked = w.chain.now();
  assert.equal(numberOf(w, ship, 'free_at'), staked + 3 * DAY);

  const craft = (id) => {
    const recipe = w.read('Recipe', pda.recipe(w.project, id));
    w.chain.send(w.player, [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id, recipe, assets: [{ asset: ship, farm: 3 }] })]);
  };
  const refresh = () => {
    const seat = w.read('Seat', pda.seat(pda.farm(w.project, 3), ship));
    w.chain.send(w.cranker, [loot.refreshSeatIx({ signer: w.cranker, project: w.project, id: 3, farm, by: ship, seat, collection: w.collection })]);
  };
  craft(1);
  refresh();
  assert.equal(numberOf(w, ship, 'fuel'), w.chain.now() + DAY);
  w.chain.warp(w.chain.now() + 2 * DAY);
  w.chain.send(w.player, [loot.harvestIx({ player: w.player, project: w.project, id: 3, farm, by: ship })]);
  assert.equal(w.balance(w.player, gem), 1_000n, 'one day of fuel, one day of pay');

  craft(2);
  w.chain.send(w.player, [computeUnitLimit(400_000), loot.unstakeNftIx({ player: w.player, project: w.project, id: 3, farm, asset: ship, collection: w.collection })]);
  assert.equal(parseCoreAsset(w.chain.get(ship).data).owner, w.player, 'out two days in, its lock bought off');
});

test('the spec carries a farm’s lock and upkeep, time raises and time rules to the program, and the checker guards them', () => {
  const spec = {
    version: 2, network: 'devnet', name: 'Fleet', currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }, { key: 'fuel', source: 'game', name: 'Fuel', symbol: 'FUEL', decimals: 0 }, { key: 'ore', source: 'game', name: 'Ore', symbol: 'ORE', decimals: 0 }],
    collection: { name: 'Fleet' },
    items: [{ key: 'ship', name: 'Ship', price: 0.05 }],
    pools: [{ key: 'ore-rewards', currency: 'ore' }],
    farms: [{
      key: 'mine', name: 'Mine', stakes: 'collectibles', item: 'ship', rewards: 'ore-rewards', rate: { perDay: 10, minted: true },
      tiers: [{ lock: '3d' }], lockAttribute: 'free_at', upkeepAttribute: 'fuel_until',
      gate: [{ item: 'ship', attribute: 'jailed', time: 'passed' }],
    }],
    recipes: [
      { key: 'refuel', name: 'Refuel', in: [{ takes: 'use', item: 'ship' }, { takes: 'pay', currency: 'fuel', amount: 10, to: 'burn' }], raises: [{ place: 0, key: 'fuel_until', by: '1d', upTo: '3d', fromNow: true }] },
      { key: 'leave', name: 'Leave early', in: [{ takes: 'use', item: 'ship' }, { takes: 'pay', currency: 'ore', amount: 50, to: 'burn' }], raises: [{ place: 0, key: 'free_at', by: '-1d', fromNow: true }] },
    ],
  };
  const result = check(spec);
  assert.ok(result.ok, JSON.stringify(result.refusals));
  assert.ok(result.warnings.some((x) => x.code === 'W-FARM-UPKEEP'));
  const m = model(spec);
  const farm = farmArgs(spec.farms[0], m);
  assert.deepEqual([farm.lock_key, farm.upkeep_key, farm.gates.at(-1).test], ['free_at', 'fuel_until', 'Passed']);
  assert.deepEqual(recipeArgs(spec.recipes[0], m).raises, [{ place: 0, key: 'fuel_until', by: DAY, most: 3 * DAY, from_now: true }]);
  assert.equal(recipeArgs(spec.recipes[1], m).raises[0].by, -DAY);

  const refused = (change) => {
    const s = structuredClone(spec);
    change(s);
    return check(s).refusals.map((r) => r.code);
  };
  assert.ok(refused((s) => { Object.assign(s.recipes[0].raises[0], { key: 'power', fromNow: false }); }).includes('E-RECIPE'), 'a duration on a number that is not a time');
  assert.deepEqual(refused((s) => { s.recipes[0].raises[0].fromNow = false; delete s.recipes[0].raises[0].upTo; }), [], 'a farm’s time, moved as written');
  assert.ok(refused((s) => { s.recipes[0].raises[0].fromNow = false; }).includes('E-RECIPE'), 'a cap from now, not counted from now');
  assert.ok(refused((s) => { s.farms[0].upkeepAttribute = 'free_at'; }).includes('E-FARM'), 'one name for two times');
  assert.ok(refused((s) => { s.farms[0].gate[0].atLeast = 3; }).includes('E-RULE'), 'a time and a number at once');
});

// A seat reads new fuel only at its next move: the player module's craft refreshes the seat of a
// collectible it fuels in the same transaction, so the fuel counts at once, with no refresh of the player's own after.
test('the player module’s refuel refreshes the ship’s seat in the same transaction', { skip }, async () => {
  const w = world({ seed: 'time-refuel-refresh' });
  w.upsert({ Item: { id: 1, args: collectible('Ship') } });
  const gem = w.newMint(w.creator);
  w.pool(7, gem, 1_000_000n);
  const args = {
    custody: 'Escrow', rewards_pool: 7, tiers: [{ lock: 3 * DAY, bps: 10_000 }], boosts: [], max_boost_bps: 0,
    rate: { per_day: 1_000n, mints: false }, lock_key: 'free_at', upkeep_key: 'fuel',
  };
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 3, args, rewardsMint: gem })]);
  const use = { Use: { item: 1 } }, burn = { Pay: { mint: w.mint, amount: 10n, to: 'Burn' } };
  w.upsert({ Recipe: { id: 1, args: { active: true, inputs: [use, burn], outputs: [], needs: [], keeps: [], raises: [{ place: 0, key: 'fuel', by: DAY, most: 3 * DAY, from_now: true }] } } });
  const kp = freshKeypair();
  w.chain.airdrop(kp.address, 10_000_000_000n);
  w.fund(kp.address, w.mint, 1_000n);
  w.tokenAccount(kp.address, gem);
  const ship = w.make(1, kp.address);
  const farm = w.read('Farm', pda.farm(w.project, 3));
  w.chain.send(kp.address, [loot.stakeNftIx({ player: kp.address, project: w.project, id: 3, farm, asset: ship, collection: w.collection })]);
  const seatAt = pda.seat(pda.farm(w.project, 3), ship);
  assert.equal(Number(w.read('Seat', seatAt).upkeep_until), 0, 'staked dry');
  const wallet = {
    address: kp.address,
    async signTransaction(wire) {
      const t = readTransaction(wire);
      const sigs = [...t.signatures];
      sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
      return wireTransaction(t.message, sigs);
    },
  };
  const spec = { version: 2, tokens: [], farms: [{ key: 'mine', name: 'Mine', id: 3, stakes: 'collectibles', item: 'ship', upkeepAttribute: 'fuel' }], recipes: [{ key: 'refuel', name: 'Refuel', id: 1 }], live: { project: w.project, collection: w.collection } };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  const [listing] = await app.recipes();
  await app.craft('refuel', [ship], 1, { listing });
  const fuel = numberOf(w, ship, 'fuel');
  assert.equal(fuel, w.chain.now() + DAY, 'fuelled a day');
  assert.equal(Number(w.read('Seat', seatAt).upkeep_until), fuel, 'and the seat read it in the same transaction');
});
