// js/play with prizes that are a roll of a box: a grant's and an auction's lot. The player claims or ends it, finds the
// roll among what it can finish (`claims`), and `claim` asks for it and settles it: the stash's NFT is theirs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { parseCoreAsset } from '../chain/core.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOBODY = '11111111111111111111111111111111';
const CHEST = 5;

const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

test('a player claims a grant and wins an auction that each give a roll, and takes the stash’s NFT from both', { skip }, async () => {
  const w = world({ seed: 'play-prizes' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const nfts = [0, 1, 2].map(() => w.make(1, w.authority));
  for (const asset of nfts) w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset, collection: w.collection })]);
  const chest = { price: 0n, currency: null, rise: null, fall: null, stock_odds: false, active: false, shares: [], entries: [{ prizes: [{ Stash: [1] }], burns: false, weight: 1 }], odds: [] };
  w.upsert({ Box: { id: CHEST, args: chest } });
  const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 1, args: { gives: { Roll: [CHEST] }, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true } } });
  const now = w.chain.now();
  const lot = { lot: { Roll: [CHEST] }, reserve: 10n, min_raise_bps: 500, starts_at: BigInt(now), ends_at: BigInt(now + 600), extend: 0, shares: [] };
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, id: 1, mint: w.mint, args: lot })]);

  const player = freshKeypair();
  w.chain.airdrop(player.address, 10_000_000_000n);
  w.fund(player.address, w.mint, 10n * PRICE);
  const spec = {
    version: 2,
    name: 'Prizes',
    currency: 'gold',
    tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }],
    grants: [{ key: 'chest', id: 1 }],
    auctions: [{ key: 'mystery', id: 1, seller: w.authority, name: 'Mystery lot' }],
    live: { project: w.project, collection: w.collection, mints: { gold: w.mint } },
  };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  const owner = (asset) => parseCoreAsset(w.chain.get(asset).data).owner;

  // The grant's roll: listed among what the player can finish, then asked for and settled.
  await app.claimGrant('chest');
  const rolls = (await app.claims()).filter((c) => c.kind === 'settle');
  assert.equal(rolls.length, 1);
  assert.equal(loot.decode('Order', w.chain.get(rolls[0].order).data).status, 'Waiting');
  await app.claim(rolls[0]);
  assert.equal(w.chain.get(rolls[0].order), null, 'settled: the order closed');
  const won = nfts.filter((nft) => owner(nft) === player.address);
  assert.equal(won.length, 1);

  // The auction's roll: ending it names the winner's order, which `collect` asks for and settles.
  await app.bid('mystery', 1);
  w.chain.warp(now + 601);
  const ended = await app.endAuction('mystery');
  assert.equal(ended.winner, player.address);
  assert.ok(ended.order);
  const got = await app.collect(ended.order);
  assert.equal(got.won.length, 1);
  assert.equal(got.won[0].Nft.stash, 1);
  assert.ok(nfts.includes(got.asset) && !won.includes(got.asset));
  assert.equal(owner(got.asset), player.address);
});

test('a player claims grants that give an NFT and a collectible at once, through js/play', { skip }, async () => {
  const w = world({ seed: 'play-direct' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  w.upsert({ Item: { id: 2, args: collectible('Trophy') } });
  const trophy = w.make(1, w.authority);
  w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset: trophy, collection: w.collection })]);
  const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  const open = (gives) => ({ gives, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true });
  w.upsert({ Grant: { id: 1, args: open({ Nft: { stash: 1, nft: trophy } }) } });
  w.upsert({ Grant: { id: 2, args: open({ Item: [2] }) } });
  const player = freshKeypair();
  w.chain.airdrop(player.address, 10_000_000_000n);
  const spec = {
    version: 2,
    name: 'Prizes',
    currency: 'gold',
    tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }],
    grants: [{ key: 'trophy', id: 1 }, { key: 'badge', id: 2 }],
    live: { project: w.project, collection: w.collection, mints: { gold: w.mint } },
  };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  await app.claimGrant('trophy');
  assert.equal(parseCoreAsset(w.chain.get(trophy).data).owner, player.address, 'the NFT, in the claim itself');
  await app.claimGrant('badge');
  const badge = loot.pda.itemAsset(loot.pda.item(w.project, 2), 1);
  assert.equal(parseCoreAsset(w.chain.get(badge).data).owner, player.address);
  assert.deepEqual((await app.claims()).filter((c) => c.kind === 'settle'), [], 'nothing left to finish');
});
