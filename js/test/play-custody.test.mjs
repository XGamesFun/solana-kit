// Browser farm actions against loot farm accounts: the project's collectibles, another collection's Core NFTs, and the
// ways out when rewards can't move.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
/** A Core collection made by someone else, and one NFT of it for the player. */
function otherNft(w) {
  const maker = w.who(), collection = newAddress(w.random), asset = newAddress(w.random);
  w.chain.send(maker, [{ programId: loot.MPL_CORE_PROGRAM, keys: [meta(collection, true, true), meta(maker, false, false), meta(maker, true, true), meta(SYSTEM_PROGRAM, false, false)], data: concat(Uint8Array.of(21), str('Elsewhere'), str(''), Uint8Array.of(0, 0)) }]);
  w.chain.send(maker, [{ programId: loot.MPL_CORE_PROGRAM, keys: [meta(asset, true, true), meta(collection, false, true), meta(maker, true, false), meta(maker, true, true), meta(w.player, false, false), meta(loot.MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false), meta(loot.MPL_CORE_PROGRAM, false, false)], data: concat(Uint8Array.of(20, 0), str('Theirs'), str(''), Uint8Array.of(0, 0)) }]);
  return { asset, collection };
}
function fixture() {
  const w = world({ seed: 'custody-browser' });
  w.pool(5, w.mint);
  w.pool(6, w.mint);
  const other = otherNft(w);
  for (const id of [1, 2, 3]) {
    const gates = id === 3 ? [{ of: { Collection: [other.collection] }, key: '', test: 'Any' }] : [];
    const args = { custody: 'Freeze', rewards_pool: id === 3 ? 6 : 5, tiers: [{ lock: 60, bps: 10_000 }, { lock: 600, bps: 20_000 }], boosts: [], max_boost_bps: 0, gates };
    w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id, args, rewardsMint: w.mint, stakedMint: id === 2 ? w.mint : null })]);
  }
  const calls = { sign: 0, send: 0 };
  const wallet = { address: w.player, async signTransaction(wire) { calls.sign++; return wire; } };
  const rpc = { ...w.chain.rpc, async send(wire) { calls.send++; return w.chain.rpc.send(wire); } };
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'nfts', id: 1, stakes: 'collectibles' }, { key: 'tokens', id: 2, stakes: 'coin' }, { key: 'club', id: 3, stakes: 'collectibles' }] };
  const app = solanaApp({ spec, rpc, wallet, now: () => w.chain.now() });
  return { w, app, calls, other };
}

test('a Core NFT of another collection and one of the game\'s each stake with one signature', { skip }, async () => {
  const { w, app, calls, other } = fixture();
  await app.stakeNft('club', other.asset);
  assert.equal(w.read('Seat', loot.pda.seat(loot.pda.farm(w.project, 3), other.asset)).asset, other.asset);
  w.upsert({ Item: { id: 1, args: collectible('Native') } });
  const native = w.make(1, w.player);
  await app.stakeNft('nfts', native);
  assert.deepEqual(calls, { sign: 2, send: 2 });
  assert.equal(w.read('Seat', loot.pda.seat(loot.pda.farm(w.project, 1), native)).asset, native);
});

for (const kind of ['tokens', 'nfts']) test(`the browser ${kind} exit can forfeit rewards when their pool is frozen`, { skip }, async () => {
  const { w, app } = fixture();
  if (kind === 'nfts') w.upsert({ Item: { id: 1, args: collectible('Native') } });
  const imported = kind === 'nfts' ? { asset: w.make(1, w.player) } : null;
  // Funded before the stake: the stake counts it, and the farm releases it over a day.
  w.fund(w.creator, w.mint, 10n);
  w.payIn(w.creator, w.mint, 10n, [{ to: { Pool: [5] }, bps: 10_000 }]);
  if (imported) await app.stakeNft('nfts', imported.asset, 0);
  else await app.stake('tokens', '1', 0);
  const pool = loot.pda.pool(w.project, 5), account = w.chain.get(pool);
  const data = Uint8Array.from(account.data);
  data[108] = 2; // SPL token AccountState::Frozen: model an issuer freezing the reward source after admission.
  w.chain.put(pool, { ...account, data });
  w.chain.warp(w.chain.now() + 86_401);
  const exit = (options) => imported ? app.unstakeNft('nfts', imported.asset, options) : app.unstake('tokens', '1', options);
  const address = loot.pda.seat(loot.pda.farm(w.project, imported ? 1 : 2), imported?.asset ?? w.player);
  await assert.rejects(exit(), /frozen|0x11|Custom\(17\)/i);
  assert.ok(w.chain.get(address), 'failed reward credit leaves the stake intact');
  await exit({ forfeit: true });
  assert.equal(w.chain.get(address), null);
  if (!imported) assert.equal(w.balance(w.player), 100_000_000n, 'principal returned despite frozen reward pool');
});
