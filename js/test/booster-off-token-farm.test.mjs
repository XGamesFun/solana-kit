// A booster on a token farm sits on the player's own seat (farm.rs seat_by): js/play takes it off there, and then the
// stake comes back whole. Before, it looked for a seat by the NFT, found none, and the stake could never leave.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun();

test(
  'a booster on a token farm comes off through js/play, and the stake with it',
  { skip: skip ?? false },
  async () => {
    const w = world({ seed: 'booster-off' });
    w.upsert({ Item: { id: 1, args: collectible('Badge') } });
    const boost = {
      rule: { of: { Item: [1] }, key: 'level', test: 'Any' },
      effect: { PerPoint: { bps: 1000, most: 9 } },
    };
    w.chain.send(w.creator, [
      loot.openFarmIx({
        owner: w.creator,
        project: w.project,
        id: 1,
        rewardsMint: w.mint,
        stakedMint: w.mint,
        args: {
          custody: 'Escrow',
          tiers: [{ lock: 0, bps: 10_000 }],
          boosts: [boost],
          max_boost_bps: 10_000,
          gate: null,
        },
      }),
    ]);
    const app = solanaApp({
      spec: {
        version: 2,
        currency: 'coin',
        tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }],
        live: { project: w.project, collection: w.collection },
        farms: [{ key: 'xp', id: 1, stakes: 'coin' }],
      },
      rpc: w.chain.rpc,
      wallet: {
        address: w.player,
        async signTransaction(x) {
          return x;
        },
      },
      now: () => w.chain.now(),
    });
    await app.stake('xp', '1', 0);
    const badge = w.make(1, w.player, [{ key: 'level', value: '2' }]);
    await app.stakeNft('xp', badge);
    const seat = loot.pda.seat(loot.pda.farm(w.project, 1), w.player);
    assert.equal(w.read('Seat', seat).asset, badge);
    w.chain.warp(w.chain.now() + 100);
    await app.unstakeNft('xp', badge);
    assert.notEqual(w.read('Seat', seat).asset, badge, 'the booster is off');
    await app.unstake('xp', '1');
  },
);
