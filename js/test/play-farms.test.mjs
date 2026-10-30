// js/play on farms with transfer hooks: NFT exits, static and dynamic reward hooks, early exits that give rewards back,
// and the hook accounts every farm builder keeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { concat, readUintLE, uintLE } from '../chain/bytes.js';
import { createCollectionInstruction, parseCoreAsset } from '../chain/core.js';
import { pdaOf, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from '../chain/pda.js';
import { closeTokenAccount, meta } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import { EXECUTE_DISCRIMINATOR, validationAddress } from '../chain/token2022.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, collectible, pinned, world } from './world.mjs';

const skip = cannotRun() ?? false;
const HOOK = 'Hook111111111111111111111111111111111111111';
function hookedMint(w, dynamic) {
  const mint = newAddress(w.random);
  w.chain.svm.addProgram(HOOK, pinned('test_hook.so'));
  const base = new Uint8Array(166);
  base.set(uintLE(1, 4)); base.set(addressBytes(w.creator), 4); base[44] = 6; base[45] = 1; base[165] = 1;
  const fees = concat(new Uint8Array(72), uintLE(0, 8), uintLE(1000, 8), uintLE(1000, 2), uintLE(0, 8), uintLE(1000, 8), uintLE(1000, 2));
  const hook = concat(new Uint8Array(32), addressBytes(HOOK));
  const data = concat(base, uintLE(1, 2), uintLE(fees.length, 2), fees, uintLE(14, 2), uintLE(hook.length, 2), hook);
  w.chain.put(mint, { owner: TOKEN_2022_PROGRAM, lamports: w.chain.rent(data.length), data });
  const counter = newAddress(w.random), config = new Uint8Array(32);
  config.set(dynamic ? Uint8Array.of(3, 2, 2, 8, 8) : addressBytes(counter));
  const list = concat(EXECUTE_DISCRIMINATOR, uintLE(39, 4), uintLE(1, 4), Uint8Array.of(dynamic ? 1 : 0), config, Uint8Array.of(0, 1));
  w.chain.put(validationAddress(mint, HOOK), { owner: HOOK, lamports: w.chain.rent(list.length), data: list });
  w.chain.put(counter, { owner: HOOK, lamports: w.chain.rent(16), data: new Uint8Array(16) });
  return { mint, counter };
}
function fixture({ hook = false, dynamic = false } = {}) {
  const w = world({ seed: `farm-browser-${hook}-${dynamic}` });
  const reward = hook ? hookedMint(w, dynamic) : { mint: w.newMint() };
  w.pool(5, reward.mint);
  for (const id of [1, 2]) w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id, rewardsMint: reward.mint, stakedMint: id === 2 ? w.mint : null,
    args: { custody: 'Freeze', rewards_pool: 5, tiers: [{ lock: 0, bps: 10_000 }], boosts: [], max_boost_bps: 0, gate: null } })]);
  w.upsert({ Item: { id: 1, args: collectible('Miner') } });
  const asset = w.make(1, w.player), calls = { sign: 0 }, denied = new Set();
  const rpc = { ...w.chain.rpc,
    async accounts(keys) { for (const key of keys) assert.ok(!denied.has(key), `must not read ${key}`); return w.chain.rpc.accounts(keys); },
    async account(key) { return (await this.accounts([key]))[0]; },
  };
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'nfts', id: 1, stakes: 'collectibles' }, { key: 'tokens', id: 2, stakes: 'coin' }] };
  const app = solanaApp({ spec, rpc, wallet: { address: w.player, async signTransaction(wire) { calls.sign++; return wire; } }, now: () => w.chain.now() });
  const seed = (amount) => w.chain.send(w.creator, [mintToIx({ mint: reward.mint, to: loot.pda.pool(w.project, 5), authority: w.creator, amount, tokenProgram: hook ? TOKEN_2022_PROGRAM : undefined })]);
  // A sharing farm releases what lands in its pool over its release span (its longest lock, a day at least), counted at
  // the first move after it lands: fund it before the stake, then let the day run.
  const releaseDay = () => w.chain.warp(w.chain.now() + 86_401);
  return { w, app, asset, calls, denied, seed, releaseDay, ...reward };
}

test('NFT exit recreates a closed reward ATA and pays its claim', { skip }, async () => {
  const { w, app, asset, mint, seed, releaseDay } = fixture();
  seed(37n);
  await app.stakeNft('nfts', asset);
  const destination = w.tokenAccount(w.player, mint);
  w.chain.send(w.player, [closeTokenAccount(destination, w.player, w.player)]);
  releaseDay();
  await app.unstakeNft('nfts', asset);
  assert.equal(w.chain.tokens(destination), 37n);
});

for (const kind of ['nfts', 'tokens']) test(`${kind} forfeiture exits without reading a closed reward mint or creating its ATA`, { skip }, async () => {
  const { w, app, asset, mint, denied } = fixture();
  if (kind === 'nfts') await app.stakeNft(kind, asset);
  else await app.stake(kind, '1');
  w.chain.put(mint, { owner: SYSTEM_PROGRAM, lamports: 0n, data: new Uint8Array() });
  denied.add(mint);
  if (kind === 'nfts') await app.unstakeNft(kind, asset, { forfeit: true });
  else await app.unstake(kind, '1', { forfeit: true });
  assert.equal(w.chain.get(loot.pda.seat(loot.pda.farm(w.project, kind === 'nfts' ? 1 : 2), kind === 'nfts' ? asset : w.player)), null);
  assert.equal(w.chain.get(loot.ata(w.player, mint)), null);
});

for (const loose of [false, true]) test(`NFT exit follows the asset's ${loose ? 'absent' : 'changed'} collection`, { skip }, async () => {
  const { w, app, asset } = fixture();
  await app.stakeNft('nfts', asset);
  const other = newAddress(w.random);
  if (!loose) w.chain.send(w.creator, [createCollectionInstruction({ collection: other, creator: w.creator, project: loot.pda.project(w.creator, 0), name: 'Moved', uri: '' })]);
  // Model the issuer's permitted UpdateV2 mutation; the Rust regression executes that CPI.
  const account = w.chain.get(asset), data = Uint8Array.from(account.data);
  data[33] = loose ? 1 : 2; data.set(addressBytes(loose ? w.creator : other), 34);
  w.chain.put(asset, { ...account, data });
  await app.unstakeNft('nfts', asset);
  assert.equal(parseCoreAsset(w.chain.get(asset).data).frozen, false);
});

test('static reward hooks run for pool credit and the fee-adjusted NFT payout', { skip }, async () => {
  const { w, app, asset, mint, counter, seed, releaseDay } = fixture({ hook: true });
  seed(100n);
  await app.stakeNft('nfts', asset);
  releaseDay();
  await app.unstakeNft('nfts', asset);
  assert.equal(w.chain.tokens(loot.ata(w.player, mint, TOKEN_2022_PROGRAM)), 81n, '10% incoming fee leaves 90 owed; payout fee leaves 81');
  assert.equal(readUintLE(w.chain.get(counter).data, 0, 8), 2n, 'hook runs for both transfers');
});

test('an early exit gives its rewards back to the pool through the reward hook, in the same move', { skip }, async () => {
  const { w, mint, counter, seed } = fixture({ hook: true });
  // A farm of the project's coin whose only tier leaves early for 10%: its rewards wait for the lock, and leaving early
  // gives them back to the pool, a transfer out of the rewards vault that runs the reward mint's hook.
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 3, rewardsMint: mint, stakedMint: w.mint,
    args: { custody: 'Escrow', rewards_pool: 5, tiers: [{ lock: 3600, bps: 10_000, exit_bps: 1000 }], boosts: [], max_boost_bps: 0, exit_to: 'Burn' } })]);
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'early', id: 3, stakes: 'coin' }] };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: w.player, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  seed(100_000n);
  await app.stake('early', '1', 0);
  w.chain.warp(w.chain.now() + 1800);
  const [runs, pool] = [readUintLE(w.chain.get(counter).data, 0, 8), w.chain.tokens(loot.pda.pool(w.project, 5))];
  await app.unstake('early', '1');
  const vault = loot.pda.rewards(loot.pda.farm(w.project, 3));
  assert.equal(readUintLE(w.chain.get(counter).data, 0, 8) - runs, 2n, 'the hook ran for the release in and for the give-back out');
  assert.equal(w.chain.tokens(vault), 0n, 'nothing the seat gave up stays in the rewards vault');
  assert.ok(w.chain.tokens(loot.pda.pool(w.project, 5)) < pool, 'the pool lost only the transfer fees of the round trip');
  assert.equal(w.chain.tokens(loot.ata(w.player, mint, TOKEN_2022_PROGRAM)), 0n, 'leaving early pays no rewards');
});

test('dynamic reward hooks require exact transfer plans before signing and use fee-adjusted payout amounts', { skip }, async () => {
  const { w, app, asset, mint, calls, seed, releaseDay } = fixture({ hook: true, dynamic: true });
  seed(100n);
  // No reward transfer on first admission; an explicit empty extras list avoids requesting a dynamic plan.
  await app.stakeNft('nfts', asset, 0, { extra: [] });
  releaseDay();
  const before = calls.sign;
  await assert.rejects(app.unstakeNft('nfts', asset), /exact transfers keyed by mint/);
  assert.equal(calls.sign, before);
  const vault = loot.pda.rewards(loot.pda.farm(w.project, 1)), destination = loot.ata(w.player, mint, TOKEN_2022_PROGRAM);
  const transfers = [
    { source: loot.pda.pool(w.project, 5), destination: vault, authority: w.project, amount: 100n },
    { source: vault, destination, authority: w.project, amount: 90n },
  ];
  const counters = transfers.map((t) => pdaOf([addressBytes(t.destination), uintLE(t.amount, 8)], HOOK));
  for (const counter of counters) w.chain.put(counter, { owner: HOOK, lamports: w.chain.rent(16), data: new Uint8Array(16) });
  await app.unstakeNft('nfts', asset, { transfers: { [mint]: transfers } });
  assert.equal(w.chain.tokens(destination), 81n);
  for (const counter of counters) assert.equal(readUintLE(w.chain.get(counter).data, 0, 8), 1n);
});

test('all farm builders retain explicit hook and adapter account metas', { skip }, () => {
  const { w, asset } = fixture();
  const extra = [meta(newAddress(w.random), false, true)], farm = w.read('Farm', loot.pda.farm(w.project, 2));
  const base = { player: w.player, project: w.project, id: 2, farm, amount: 1n, asset, collection: w.collection, extra };
  for (const build of [loot.stakeTokensIx, loot.unstakeTokensIx, loot.stakeNftIx, loot.unstakeNftIx, loot.harvestIx]) assert.deepEqual(build(base).keys.slice(-1), extra);
});

test("staked lists the player's seats with what each is owed by the program's own sum, sending nothing", { skip }, async () => {
  const { w, app, asset, calls, seed, releaseDay } = fixture();
  seed(37n);
  await app.stakeNft('nfts', asset);
  await app.stake('tokens', '2.5');
  releaseDay();
  const signed = calls.sign;
  const [seat] = await app.staked('nfts');
  assert.equal(seat.asset, asset);
  assert.equal(seat.amount, 1);
  assert.equal(seat.counted, true);
  // The release since the stake, counted by the dry run: the seat on chain was credited nothing yet.
  assert.equal(seat.owedUnits, 37n);
  assert.equal(seat.waiting, '37');
  assert.equal(loot.decode('Seat', w.chain.get(loot.pda.seat(loot.pda.farm(w.project, 1), asset)).data).owed, 0n);
  assert.equal(calls.sign, signed);
  const [tokens] = await app.staked('tokens');
  assert.deepEqual([tokens.asset, tokens.amount, tokens.freeAt], [null, 2.5, tokens.since]);
  assert.deepEqual(await app.staked('nfts', w.creator), []);
  // An RPC that can't dry-run: what the seat was last credited.
  const plain = solanaApp({ spec: { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'nfts', id: 1, stakes: 'collectibles' }] }, rpc: { ...w.chain.rpc, simulate: undefined }, wallet: { address: w.player }, now: () => w.chain.now() });
  assert.deepEqual((await plain.staked('nfts')).map((s) => [s.owedUnits, s.counted]), [[0n, false]]);
  await app.harvest('nfts', asset);
  assert.equal((await app.staked('nfts'))[0].owedUnits, 0n);
});
