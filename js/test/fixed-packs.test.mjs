// A fixed pack (a box of one entry, nothing random, any number of draws) sells in one step: `buy` with a `count`, each
// sale at the price the one before it left, its prizes given once for each draw of each sale, a fixed amount of tokens
// once with all of it. js/play buys it so: no order, no oracle, no settle; one too big for a transaction it opens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUnitLimit } from '../chain/programs.js';
import { setAuthorityIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { boxArgs, cannotRun, collectible, drop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;

test('buy gives a fixed pack’s prizes once for each draw of each sale, and its tokens once with all of them', () => {
  const box = { box_id: 1, version: 0, price: 10n, currency: pda.project('11111111111111111111111111111111', 0), slots: [{ count: 3 }], entries: [{ prizes: [{ Item: [1] }, { Tokens: { from: { Mint: ['So11111111111111111111111111111111111111112'] }, amount: { Fixed: [5n] } } }] }] };
  const gives = loot.buyGives(box, 2);
  assert.deepEqual(gives.map((g) => [Object.keys(g.prize)[0], g.k, g.times]), [['Item', 0, 1], ['Item', 1, 1], ['Item', 2, 1], ['Item', 3, 1], ['Item', 4, 1], ['Item', 5, 1], ['Tokens', 6, 6]]);
});

test('on chain: two packs of three cards and a coin bundle, in one instruction, counted against the wallet’s limit', { skip }, () => {
  const w = world({ seed: 'fixed-packs' });
  const coin = w.newMint(w.creator);
  w.chain.send(w.creator, [setAuthorityIx({ account: coin, current: w.creator, newAuthority: w.project })]);
  w.upsert({ Item: { id: 1, args: collectible('Card') } });
  const minted = { Tokens: { from: { Mint: [coin] }, amount: { Fixed: [7n] } } };
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([{ Item: [1] }, minted])], { slots: [{ count: 3, only: [], distinct: false }], per_wallet: { total: 2, per_window: 0, window: 0 } }) } });
  const box = w.read('LootBox', pda.box(w.project, 1));
  const items = { 1: w.read('Item', pda.item(w.project, 1)) };
  const before = w.balance(w.player);
  const buy = (count) => loot.buyIx({ player: w.player, project: w.project, box: w.read('LootBox', pda.box(w.project, 1)), treasury: w.treasury, count, items: { 1: w.read('Item', pda.item(w.project, 1)) }, programs: {} });
  const r = w.chain.send(w.player, [computeUnitLimit(1_400_000), loot.buyIx({ player: w.player, project: w.project, box, treasury: w.treasury, count: 2, items })]);
  assert.deepEqual(r.receipts.map((x) => x.name), ['Bought', ...Array(6).fill('PrizeGiven'), 'PrizeGiven']);
  assert.equal(r.receipts[0].data.count, 2);
  assert.equal(w.balance(w.player), before - 2n * PRICE);
  assert.equal(w.balance(w.player, coin), 6n * 7n, 'one payment of every draw’s tokens');
  for (let serial = 1; serial <= 6; serial++) assert.ok(w.chain.get(pda.itemAsset(pda.item(w.project, 1), serial)), `card ${serial}`);
  assert.throws(() => w.chain.send(w.player, [computeUnitLimit(1_400_000), buy(1)]), /OverWallet/, 'two sales counted');
});

test('js/play buys a fixed pack in one step, and opens one too big for a transaction', { skip }, async () => {
  const w = world({ seed: 'fixed-packs-play' });
  w.upsert({ Item: { id: 1, args: collectible('Card') } });
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([{ Item: [1] }])], { slots: [{ count: 3, only: [], distinct: false }] }) } });
  w.upsert({ Box: { id: 2, args: boxArgs(PRICE, [drop([{ Item: [1] }])], { slots: [{ count: 30, only: [], distinct: false }] }) } });
  const spec = { version: 2, currency: 'gold', tokens: [{ key: 'gold', source: 'existing', mint: w.mint, decimals: 6 }], boxes: [{ key: 'pack', id: 1, name: 'Pack' }, { key: 'crate', id: 2, name: 'Crate' }], live: { project: w.project, collection: w.collection, mints: { gold: w.mint } } };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: w.player, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  const small = await app.openBox('pack', { maxPrice: 2n * PRICE, count: 2 });
  assert.equal(small.assets.length, 6, 'six cards, bought');
  assert.equal(small.orderAddress, undefined, 'no order');
  assert.ok(small.assets.every((a) => w.chain.get(a)), 'each minted');
  const big = await app.openBox('crate', { maxPrice: PRICE });
  assert.ok(big.order, 'thirty cards: opened, rolled by the oracle and settled');
  assert.equal(big.won.length, 30);
});
