// A farm that watches, through the player module: a harvest shows the seat's NFT is still the player's (`held`), and a
// new holder of a staked NFT takes its seat over, paying its last staker back (`previous`). The decoder gives a farm's
// custody and what it farms as variant names ('Watch', 'Collectibles'), which the module must read as such.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat } from '../chain/bytes.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;

/** Core's TransferV1: `owner` hands `asset` (of `collection`) to `to`. */
const transferCore = (asset, collection, owner, to) => ({
  programId: loot.MPL_CORE_PROGRAM,
  keys: [meta(asset, false, true), meta(collection, false, false), meta(owner, true, true), meta(owner, true, false), meta(to, false, false), meta(SYSTEM_PROGRAM, false, false), meta(loot.MPL_CORE_PROGRAM, false, false)],
  data: concat(Uint8Array.of(14, 0)),
});

test('in a watch farm the player module harvests with `held` and a new holder takes the seat over', { skip }, async () => {
  const w = world({ seed: 'watch-browser' });
  w.pool(5, w.mint);
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, args: { custody: 'Watch', rewards_pool: 5, tiers: [{ lock: 60, bps: 10_000 }], boosts: [], max_boost_bps: 0, gates: [] }, rewardsMint: w.mint, stakedMint: null })]);
  const farm = w.read('Farm', loot.pda.farm(w.project, 1));
  assert.equal(farm.custody, 'Watch', 'a variant without data decodes as its name');
  assert.equal(farm.farmed, 'Collectibles');
  w.upsert({ Item: { id: 1, args: collectible('Watched') } });
  const asset = w.make(1, w.player);
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'watch', id: 1, stakes: 'collectibles', custody: 'watch' }] };
  const appOf = (address) => solanaApp({ spec, rpc: w.chain.rpc, wallet: { address, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });

  // Funded before the stake: the stake counts it, and the farm releases it over a day.
  w.fund(w.creator, w.mint, 1_000_000n);
  w.payIn(w.creator, w.mint, 1_000_000n, [{ to: { Pool: [5] }, bps: 10_000 }]);
  await appOf(w.player).stakeNft('watch', asset);
  const seatAddress = loot.pda.seat(loot.pda.farm(w.project, 1), asset);
  assert.equal(w.read('Seat', seatAddress).player, w.player);
  w.chain.warp(w.chain.now() + 86_401);

  // The harvest names the NFT the seat watches; without it the program refuses (NotTheNft).
  const before = w.balance(w.player);
  await appOf(w.player).harvest('watch', asset);
  assert.ok(w.balance(w.player) > before, 'the harvest paid the staker');

  // Sold while staked: its new holder takes the seat over, naming the last staker, who gets the seat's rent back.
  const buyer = w.who();
  w.chain.send(w.player, [transferCore(asset, w.collection, w.player, buyer)]);
  const lamports = await w.chain.rpc.balance(w.player);
  await appOf(buyer).stakeNft('watch', asset);
  assert.equal(w.read('Seat', seatAddress).player, buyer, 'the new holder holds the seat');
  assert.ok((await w.chain.rpc.balance(w.player)) > lamports, 'the last staker was paid back the seat’s rent');
});
