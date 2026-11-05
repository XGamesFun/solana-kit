// Packs through js/play (loot 0.22): a box whose slots draw several cards an open, and a purchase of several opens,
// from one wallet prompt and one oracle answer; the throwaway key settles it in as many parts as the chain needs. A
// fresh item's traits are drawn from the spec's table and written on each card.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;

/** A wallet that signs what it is handed, and counts its prompts. */
const counting = (kp) => {
  const wallet = {
    address: kp.address,
    prompts: 0,
    async signTransaction(wire) {
      wallet.prompts++;
      const t = readTransaction(wire);
      const sigs = [...t.signatures];
      sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
      return wireTransaction(t.message, sigs);
    },
  };
  return wallet;
};

const SPEC = {
  version: 2,
  network: 'devnet',
  name: 'Packs',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'Packs' },
  tables: [{ key: 'colors', kind: 'labels', rows: [{ label: 'red', weight: 3 }, { label: 'blue', weight: 3 }, { label: 'gold', weight: 1, stock: 5 }] }],
  items: [
    { key: 'common', name: 'Common' },
    { key: 'rare', name: 'Rare' },
    { key: 'hero', name: '{color} Hero', uri: 'https://example.invalid/hero/{color}/{power}.json', drawn: [{ attribute: 'color', table: 'colors' }, { attribute: 'power', min: 1, max: 100 }] },
  ],
  boxes: [
    { key: 'booster', name: 'Booster', price: 0.01, slots: [{ count: 4 }, { count: 1, from: [1] }], outcomes: [{ gives: 'item', item: 'common', weight: 9 }, { gives: 'item', item: 'rare', weight: 1 }] },
    { key: 'heroes', name: 'Heroes', price: 0.01, slots: [{ count: 3 }], outcomes: [{ gives: 'item', item: 'hero', weight: 1 }] },
  ],
};

async function live(w, owner) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-packs-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(SPEC));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 8 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const sigs = [...t.signatures];
      sigs[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, sigs));
    }));
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('a pack spec checks: slots, a table and a fresh item', () => {
  const r = check(SPEC, { now: NOW });
  assert.ok(r.ok, JSON.stringify(r.refusals));
  const bad = structuredClone(SPEC);
  bad.boxes[0].slots[1].from = [5];
  assert.ok(check(bad, { now: NOW }).refusals.some((x) => x.where === 'economy.boxes.booster.slots[1].from[0]'));
  const sold = structuredClone(SPEC);
  sold.items[2].price = 0.01;
  assert.ok(check(sold, { now: NOW }).refusals.some((x) => /PrizeNotCovered/.test(x.message)), 'a fresh item is not sold in the shop');
  // As a lottery's prize it is never given (a warning); as an auction's lot it is refused (LotRefused).
  const fresh = SPEC.items[2].key;
  const placed = structuredClone(SPEC);
  placed.lotteries = [{ key: 'draw', name: 'Draw', price: 1, places: [50, { percent: 0, prize: { gives: 'item', item: fresh } }] }];
  const r2 = check(placed, { now: NOW });
  assert.ok(r2.warnings.some((x) => x.code === 'W-ITEM' && x.where === 'economy.lotteries.draw.places[1].prize'), JSON.stringify(r2.refusals));
  assert.ok(!r2.refusals.some((x) => /PrizeNotCovered/.test(x.message)));
  const lot = structuredClone(SPEC);
  lot.auctions = [{ key: 'one', name: 'One', lot: { item: fresh }, reserve: 1, runs: '1h' }];
  assert.ok(check(lot, { now: NOW }).refusals.some((x) => x.where === 'economy.auctions.one.lot.item' && /LotRefused/.test(x.message)));
});

test('four boosters in one purchase: one prompt, twenty cards, settled in parts by the throwaway key', { skip }, async () => {
  const w = world({ project: false, seed: 'packs' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  w.chain.airdrop(player.address, 100_000_000_000n);
  const spec = await live(w, owner);
  const wallet = counting(player);
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  const listing = (await app.boxes()).find((l) => l.key === 'booster');
  const got = await app.openBox('booster', { listing, count: 4 });
  assert.equal(wallet.prompts, 1, 'one wallet prompt for four packs');
  assert.equal(got.won.length, 20);
  assert.ok(got.parts.length >= 2, `settled in ${got.parts?.length} parts`);
  assert.ok(got.won.slice(4, 5).every((x) => x.Item.item === spec.items[1].id) && got.won.slice(9, 10).every((x) => x.Item.item === spec.items[1].id), 'each pack’s fifth card a rare');
  const mine = await app.collectibles();
  assert.equal(mine.length, 20);
  assert.equal(await w.chain.rpc.account(got.order), null, 'the order closed');
});

test('a pack of fresh heroes: each one’s color from the table, its power in its range, its name made of them', { skip }, async () => {
  const w = world({ project: false, seed: 'packs-fresh' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  w.chain.airdrop(player.address, 100_000_000_000n);
  const spec = await live(w, owner);
  const table = loot.decodeTable((await w.chain.rpc.account(loot.pda.table(spec.live.project, spec.tables[0].id))).data);
  assert.deepEqual([table.sealed, table.count, table.rows.map((r) => r.label)], [true, 3, ['red', 'blue', 'gold']]);
  const wallet = counting(player);
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  const got = await app.openBox('heroes', { listing: (await app.boxes()).find((l) => l.key === 'heroes') });
  assert.equal(wallet.prompts, 1);
  assert.equal(got.won.length, 3);
  const mine = await app.collectibles();
  assert.equal(mine.length, 3);
  for (const c of mine) {
    const color = c.attributes.color;
    const power = Number(c.attributes.power);
    assert.ok(['red', 'blue', 'gold'].includes(color), JSON.stringify(c.attributes));
    assert.ok(power >= 1 && power <= 100);
    assert.ok(c.name.startsWith(`${color} Hero`), c.name);
  }
});

test('a purchase of more cards than one answer holds is several orders in one transaction: still one prompt', { skip }, async () => {
  const w = world({ project: false, seed: 'packs-many' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  w.chain.airdrop(player.address, 100_000_000_000n);
  const spec = await live(w, owner);
  const wallet = counting(player);
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
  const listing = (await app.boxes()).find((l) => l.key === 'booster');
  const got = await app.openBox('booster', { listing, count: 10 });
  assert.equal(wallet.prompts, 1, 'one wallet prompt for ten packs');
  assert.equal(got.orders.length, 2, 'fifty cards: two orders of thirty at most');
  assert.equal(got.won.length, 50);
  assert.equal((await app.collectibles()).length, 50);
});
