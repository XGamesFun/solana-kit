// The economy tools for the program's final fixes (8938ee0): the checker refuses what the program refuses (an outcome no
// slot draws, a pack one answer can't draw, a run of places too long to walk), an open's order is sized as `open_box`
// sizes it, and a lottery holds SOL for its rounds and every entry by default, so a buyer pays no program rent.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { NATIVE_MINT } from '../chain/pda.js';
import { createAssociatedTokenAccountIdempotent, withSolWrap } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import IDL from '../client/idl/loot.js';
import { check } from '../economy/check.mjs';
import { FEES, model } from '../economy/model.mjs';
import { boxArgs, boxOrderBytes, itemArgs, roundRentOf, roundSize } from '../economy/plan.mjs';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;
const solSpec = (more) => ({ version: 2, network: 'devnet', name: 'T', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'T' }, ...more });
const refused = (spec) => check(spec, { now: NOW }).refusals.map((r) => `${r.code} ${r.where}`);

test('the checker refuses an outcome no slot draws (BadEntries) and a pack one answer can’t draw (PackTooLarge)', () => {
  const items = [{ key: 'common', name: 'Common' }, { key: 'rare', name: 'Rare' }, { key: 'epic', name: 'Epic' }];
  const outcomes = [{ gives: 'item', item: 'common', weight: 8 }, { gives: 'item', item: 'rare', weight: 2 }, { gives: 'item', item: 'epic', weight: 1 }];
  const pack = (slots) => solSpec({ items, boxes: [{ key: 'pack', name: 'Pack', price: 0.01, slots, outcomes }] });
  assert.deepEqual(refused(pack([{ count: 4, from: [0], share: 50 }, { count: 1, from: [1], share: 50 }])), ['E-ODDS economy.boxes.pack.slots'], 'the epic is drawn by no slot');
  assert.deepEqual(refused(pack([{ count: 4, from: [0], share: 50 }, { count: 1, share: 50 }])), [], 'a slot that names none draws among all');
  assert.deepEqual(refused(pack([{ count: 4, from: [0], share: 50 }, { count: 1, from: [1, 2], share: 50 }])), []);
  // Three entries of an item: one answer draws 65 (the program's `draws_fit`, `loot.drawsFit`).
  const m = model(pack([{ count: 64 }]), { now: NOW });
  assert.ok(loot.drawsFit(boxArgs(m.boxes[0], m).entries, 65) && !loot.drawsFit(boxArgs(m.boxes[0], m).entries, 66));
  assert.deepEqual(refused(pack([{ count: 65 }])), []);
  const big = check(pack([{ count: 66 }]), { now: NOW }).refusals;
  assert.deepEqual(big.map((r) => `${r.code} ${r.where}`), ['E-ODDS economy.boxes.pack.slots']);
  assert.match(big[0].message, /about 65 here.*PackTooLarge/);
});

test('the checker asks what a slot that names outcomes is worth, and a pack sharing a pool counts its rereads', () => {
  const items = [{ key: 'common', name: 'Common' }, { key: 'rare', name: 'Rare' }];
  const outcomes = [{ gives: 'item', item: 'common', weight: 8 }, { gives: 'item', item: 'rare', weight: 2 }];
  const pack = (slots) => solSpec({ items, boxes: [{ key: 'pack', name: 'Pack', price: 0.01, slots, outcomes }] });
  assert.deepEqual(refused(pack([{ count: 4, from: [0] }, { count: 1, from: [1] }])), ['E-ODDS economy.boxes.pack.slots'], 'no shares');
  assert.deepEqual(refused(pack([{ count: 4, from: [0], share: 20 }, { count: 1, from: [1], share: 70 }])), ['E-ODDS economy.boxes.pack.slots'], 'not the whole price');
  assert.deepEqual(refused(pack([{ count: 4, from: [0], share: 20 }, { count: 1, from: [1], share: 80 }])), []);
  assert.deepEqual(refused(pack([{ count: 3, share: 100 }])), ['E-ODDS economy.boxes.pack.slots'], 'draws among all are alike');
  const shared = Array.from({ length: 13 }, (_, i) => ({ prizes: [{ Tokens: { from: { Pool: [3] }, amount: BigInt(i + 1) } }] }));
  assert.ok(loot.drawsFit(shared, 9) && !loot.drawsFit(shared, 10), 'as the program counts it');
  assert.ok(loot.drawsFit(shared, [{ count: 4, only: [] }], 2) && !loot.drawsFit(shared, [{ count: 5, only: [] }], 2), 'by the opens');
});

test('the checker refuses a run of places given one by one past MAX_RUN_PLACES (BadLottery); a run of tokens has no cap', () => {
  const MAX = Number(IDL.constants.find((c) => c.name === 'MAX_RUN_PLACES').value);
  assert.equal(MAX, 4096);
  const spec = (prize, times) => solSpec({
    items: [{ key: 'badge', name: 'Badge' }],
    pools: [{ key: 'house', currency: 'sol', seed: 10 }],
    lotteries: [{ key: 'draw', name: 'Draw', price: 0.001, every: '1d', places: [{ percent: 50 }, { percent: 0, prize, times }] }],
  });
  assert.deepEqual(refused(spec({ gives: 'item', item: 'badge' }, MAX)), []);
  assert.deepEqual(refused(spec({ gives: 'item', item: 'badge' }, MAX + 1)), ['E-LOTTERY economy.lotteries.draw.places[1].times']);
  assert.ok(!refused(spec({ gives: 'tokens', from: 'pool:house', amount: 0.000001 }, MAX + 1)).includes('E-LOTTERY economy.lotteries.draw.places[1].times'));
});

test('an open’s order is sized as open_box sizes it; a roll made in another call keeps the table budget', () => {
  const spec = solSpec({
    items: [{ key: 'hero', name: 'Hero', drawn: [{ attribute: 'color', table: 'colors' }] }, { key: 'gem', name: 'Gem' }],
    tables: [{ key: 'colors', kind: 'labels', rows: [{ label: 'red', weight: 1 }, { label: 'blue', weight: 1 }] }],
    boxes: [{ key: 'heroes', name: 'Heroes', price: 0.01, slots: [{ count: 3 }], outcomes: [{ gives: 'item', item: 'hero', weight: 1 }, { gives: 'item', item: 'gem', weight: 1 }] }],
  });
  assert.ok(check(spec, { now: NOW }).ok, refused(spec).join());
  const m = model(spec, { now: NOW });
  const b = m.boxes[0];
  const items = Object.fromEntries(m.items.map((it) => [it.id, itemArgs(it, m)]));
  assert.deepEqual(loot.entryRows(boxArgs(b, m).entries, items), [1, 0], 'the hero draws one table row');
  const opened = boxOrderBytes(b, m, 1, { opened: true });
  const inAnotherCall = boxOrderBytes(b, m);
  assert.equal(inAnotherCall - opened, 3 * 4 * (loot.tableBudget(boxArgs(b, m).entries) - 1), 'three draws, each the rest of the table budget');
});

/** Puts `spec` live for `owner` through the approval page's session, as the tests of going live do. */
async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-final-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('a lottery holds SOL for its rounds by default: its round’s header is the size the tools say, and a buyer pays no entry rent', { skip }, async () => {
  const w = world({ project: false, seed: 'round-rent' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const spec = solSpec({
    items: [{ key: 'badge', name: 'Badge' }],
    pools: [{ key: 'house', currency: 'sol', seed: 1 }],
    lotteries: [{
      key: 'daily', name: 'Daily', price: 0.001, every: '1d', split: [{ to: 'treasury', percent: 10 }],
      places: [{ percent: 50 }, { percent: 1, times: 20 }, { percent: 0, prize: { gives: 'item', item: 'badge' }, times: 3 }, { percent: 0, prize: { gives: 'tokens', from: 'pool:house', amount: 0.01 } }],
    }],
  });
  const m = model(spec, { now: NOW });
  const expected = roundRentOf(m.lotteries[0], m);
  assert.ok(expected > 0n);
  const live = await goLive(w, owner, spec);
  const project = live.live.project;
  const address = loot.pda.lottery(project, live.lotteries[0].id);
  const lottery = w.read('Lottery', address);
  assert.ok(BigInt(w.chain.get(address).lamports) - w.chain.rent(w.chain.get(address).data.length) >= expected, 'the lottery holds its rounds’ SOL');

  const before = BigInt(w.chain.get(player.address).lamports);
  const price = BigInt(lottery.terms.price);
  w.chain.send(player.address, withSolWrap(player.address, NATIVE_MINT, price, [createAssociatedTokenAccountIdempotent(player.address, player.address, NATIVE_MINT), loot.buyTicketsIx({ player: player.address, project, id: live.lotteries[0].id, lottery, mint: NATIVE_MINT, count: 1n, treasury: live.live.treasury })]));
  const r = loot.decodeRound(w.chain.get(loot.currentRound(address, lottery)).data);
  assert.equal(Number(r.head), roundSize(m.lotteries[0], m).head, 'the header as the tools size it');
  assert.equal(r.opener, address, 'the lottery opened the round');
  assert.equal(BigInt(r.lent), BigInt(loot.entryWidth(r.fee, false)) * (w.chain.rent(1000) - w.chain.rent(999)), 'the entry’s bytes, lent by the lottery');
  const spent = before - BigInt(w.chain.get(player.address).lamports);
  assert.ok(spent <= price + FEES.player + 20_000n, `the buyer paid the price, the fee and the network only: ${spent}`);
});

test('going live always makes the standing lookup table: without a recent slot it is refused when a part needs the table', async () => {
  const { prepare, wideParts } = await import('../economy/live.mjs');
  const spec = JSON.parse(readFileSync(new URL('../../examples/artwork-auction.json', import.meta.url), 'utf8'));
  const owner = freshKeypair().address;
  const keys = (p) => Object.fromEntries(p.freshKeys.map((k) => [k, freshKeypair().address]));
  const rent = (bytes) => (BigInt(bytes) + 128n) * 6_960n;
  const { plan } = await import('../economy/plan.mjs');
  const plain = prepare(spec, { owner, keys: keys(plan(spec, { now: NOW })), now: NOW, rent });
  assert.ok(plain.ok, 'nothing needs the table: it goes live, the table left for a slot');
  assert.deepEqual(wideParts(model(spec, { now: NOW }), plain.warnings), []);
  const nftBids = structuredClone(spec);
  nftBids.auctions[0].bidNfts = { attribute: 'level' };
  nftBids.auctions[0].reserve = 3;
  delete nftBids.auctions[0].minRaise;
  delete nftBids.auctions[0].split;
  const k = keys(plan(nftBids, { now: NOW }));
  const refusedNow = prepare(nftBids, { owner, keys: k, now: NOW, rent });
  assert.equal(refusedNow.ok, false);
  assert.deepEqual(refusedNow.refusals.map((r) => `${r.code} ${r.where}`), [`E-NO-TABLE economy.auctions.${spec.auctions[0].key}`]);
  const withSlot = prepare(nftBids, { owner, keys: k, now: NOW, rent, slot: 1_000n });
  assert.ok(withSlot.ok && withSlot.transactions.some((t) => t.steps.some((s) => s.id === 'table')), 'with a slot the table is made');
});
