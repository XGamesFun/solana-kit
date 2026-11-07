// What loot 0.24 changed for clients after the strict rules: what a box does once an entry runs out (`when_out`, its
// count of draws waiting, a refund that names the box), a compressed NFT's Sheet closed against its tree, a print read as
// in no collection, a forfeit that writes nothing, and the caps on an item's traits. Each run on the real program where
// it can be.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { encodeInstruction } from '../chain/borsh.js';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { computeUnitLimit } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { LIMITS, model } from '../economy/model.mjs';
import { boxArgs as specBoxArgs } from '../economy/plan.mjs';
import { simulate } from '../economy/simulate.mjs';
import { solanaApp } from '../play/index.js';
import { approvalChain, boxArgs, cannotRun, collectible, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const pda = loot.pda;
const NOW = 1_790_000_000;
const WALLET = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const box = (w, id) => w.read('LootBox', pda.box(w.project, id));
const fails = (fn, name) => assert.throws(fn, (e) => (e.logs ?? []).join(' ').includes(name) || e.message.includes(name));
const open = (w, id, nonce) => loot.openBoxIx({ player: w.player, project: w.project, box: box(w, id), nonce });

/** A pack economy of a rare of 10 and a common of 1,000, in SOL. */
const spec = (whenOut) => ({
  version: 2, network: 'devnet', name: 'Out', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'Out' },
  items: [{ key: 'common', name: 'Common', supply: 1000 }, { key: 'rare', name: 'Rare', supply: 10 }],
  boxes: [{ key: 'crate', name: 'Crate', price: 0.01, ...(whenOut ? { whenOut } : {}), outcomes: [{ gives: 'item', item: 'common', weight: 90 }, { gives: 'item', item: 'rare', weight: 1 }, { gives: 'nothing', weight: 9 }] }],
  scenario: { days: 30, perDay: { 'box:crate': 100 } },
});

test('a box that stops selling counts the draws still waiting; one that draws among what is left sells on, never landing on what is gone', { skip }, () => {
  const w = world({ seed: 'when-out' });
  w.upsert({ Item: { id: 1, args: collectible('Crown', 1) } });
  w.upsert({ Item: { id: 2, args: collectible('Shard') } });
  // The default: one crown left covers one purchase waiting for its answer, not a second.
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(1, 1_000_000_000), itemDrop(2)]) } });
  assert.equal(box(w, 1).when_out, 'StopSales');
  w.chain.sendRaw(w.player, [open(w, 1, 1n)]);
  const first = pda.order(w.project, w.player, 1n);
  assert.equal(w.read('Order', first).reserved, 1n);
  assert.equal(box(w, 1).in_flight, 1n);
  fails(() => w.chain.sendRaw(w.player, [open(w, 1, 2n)]), 'SoldOut');
  // Its answer takes its draw out of the count: the crown, as weighted, so the box is out now.
  const items = { 1: w.read('Item', pda.item(w.project, 1)), 2: w.read('Item', pda.item(w.project, 2)) };
  w.chain.sendRaw(w.chain.oracle, [computeUnitLimit(400_000), loot.callbackRollIx({ order: first, orderState: w.read('Order', first), box: box(w, 1), randomness: new Uint8Array(32).fill(1), items })]);
  assert.deepEqual(w.read('Order', first).won.map((x) => x.Item.item), [1]);
  assert.equal(box(w, 1).in_flight, 0n);
  fails(() => w.chain.sendRaw(w.player, [open(w, 1, 3n)]), 'SoldOut');

  // Drawing among what is left: it sells with the crown gone, and gives the shard.
  w.upsert({ Box: { id: 2, args: boxArgs(PRICE, [itemDrop(1, 1_000_000_000), itemDrop(2)], { when_out: 'DrawLeft' }) } });
  assert.equal(box(w, 2).when_out, 'DrawLeft');
  w.chain.send(w.player, [open(w, 2, 4n)]);
  const order = w.read('Order', pda.order(w.project, w.player, 4n));
  assert.equal(order.reserved, 0n, 'nothing counted');
  assert.deepEqual(order.won.map((x) => x.Item.item), [2]);
});

test('a refund of a purchase still counted in its box names the box, and takes its draws out of the count', { skip }, () => {
  const w = world({ seed: 'when-out-refund' });
  w.upsert({ Item: { id: 1, args: collectible('Crown', 1) } });
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(1), { prizes: [], weight: 1 }]) } });
  const before = w.balance(w.player);
  w.chain.sendRaw(w.player, [open(w, 1, 1n)]);
  const orderAddress = pda.order(w.project, w.player, 1n);
  const order = w.read('Order', orderAddress);
  assert.equal(order.reserved, 1n);
  // The refund builder names the box, written; an order counting nothing names none.
  const keys = loot.refundIx({ signer: w.cranker, orderAddress, order }).keys;
  const at = loot.IDL.instructions.find((i) => i.name === 'refund').accounts.findIndex((a) => a.name === 'loot_box');
  assert.deepEqual([keys[at].pubkey, keys[at].isWritable], [pda.box(w.project, 1), true]);
  assert.equal(loot.refundIx({ signer: w.cranker, orderAddress, order: { ...order, reserved: 0n } }).keys[at].pubkey, loot.LOOT_PROGRAM, 'none: the program id');
  // The oracle never answers: a stale purchase is refunded.
  while (!loot.orderRefundable(order, w.chain.slot(), w.chain.now())) w.chain.warp(w.chain.now() + 60), w.chain.nextSlot();
  fails(() => w.chain.send(w.cranker, [loot.refundIx({ signer: w.cranker, orderAddress, order: { ...order, reserved: 0n } })]), 'ItemMismatch');
  w.chain.send(w.cranker, [loot.refundIx({ signer: w.cranker, orderAddress, order })]);
  assert.equal(w.balance(w.player), before, 'the price back');
  assert.equal(box(w, 1).in_flight, 0n);
  // The crown covers a purchase again.
  w.chain.sendRaw(w.player, [open(w, 1, 2n)]);
});

test('the oracle’s answer to a roll writes its box', () => {
  const orderState = { project: WALLET, loot_box: WALLET, asked_first: 1n };
  const ix = loot.callbackRollIx({ order: WALLET, orderState, box: { entries: [{ prizes: [], weight: 1 }] }, randomness: new Uint8Array(32) });
  assert.equal(ix.keys[2].pubkey, WALLET);
  assert.equal(ix.keys[2].isWritable, true);
});

test('whenOut goes from the spec to the box written, is shown to players, and explained both ways', { skip }, async () => {
  for (const whenOut of [undefined, 'stopSales', 'drawLeft']) {
    const r = check(spec(whenOut), { now: NOW });
    assert.ok(r.ok, JSON.stringify(r.refusals));
    const m = model(spec(whenOut), { now: NOW });
    assert.equal(specBoxArgs(m.boxes[0], m).when_out, whenOut === 'drawLeft' ? 'DrawLeft' : 'StopSales');
  }
  // Live: the box as written, and the player's listing.
  const w = world({ project: false, seed: 'when-out-live' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-when-out-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec('drawLeft')));
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
  const live = JSON.parse(readFileSync(file, 'utf8'));
  const written = loot.decode('LootBox', (await w.chain.rpc.account(pda.box(live.live.project, live.boxes[0].id))).data);
  assert.equal(written.when_out, 'DrawLeft');
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, now: () => w.chain.now() });
  assert.equal((await app.boxes())[0].whenOut, 'drawLeft');

  // The words: the trade-off, in each.
  const stop = explainEconomy(spec(), { now: NOW }).text;
  const left = explainEconomy(spec('drawLeft'), { now: NOW }).text;
  assert.match(stop, /stops selling/);
  assert.match(stop, /nobody can buy their way to a refund on every miss/);
  assert.match(left, /draws among the outcomes still there/);
  assert.match(left, /make a rare one likelier/);
  // The checker says what a player can do with the rare once the common is gone.
  const warned = check(spec('drawLeft'), { now: NOW }).warnings.find((x) => x.code === 'W-WHEN-OUT');
  assert.match(warned.message, /once outcome 0 runs out, outcome 1’s chance goes from 1% to 10%/);
  assert.ok(!check(spec(), { now: NOW }).warnings.some((x) => x.code === 'W-WHEN-OUT'));
  // A live box whose setting changes fails a purchase still waiting.
  const changed = { ...spec('drawLeft'), live: { program: loot.LOOT_PROGRAM, project: WALLET, published: spec() } };
  assert.ok(check(changed, { now: NOW }).warnings.some((x) => x.code === 'W-LIVE-ROLLS' && /what it does when an outcome runs out/.test(x.message)));
});

test('the quick simulation walks the stock: the day a box stops selling, or each outcome runs out and the odds after', () => {
  const stop = simulate(spec(), { now: NOW });
  assert.deepEqual(stop.boxes[0].stock, { whenOut: 'stopSales', stopsSellingInDays: 10, by: [{ outcome: 1, gives: 'rare' }] });
  assert.ok(stop.notes.some((n) => /“Crate” stops selling in about 10 days, when outcome 1 \(rare\) runs out/.test(n)));
  const left = simulate(spec('drawLeft'), { now: NOW });
  const { runsOut } = left.boxes[0].stock;
  assert.deepEqual(runsOut.map((r) => [r.inDays, r.outcomes.map((o) => o.outcome)]), [[10, [1]], [11.1, [0]]]);
  assert.deepEqual(runsOut[0].chancesAfter.map((c) => Math.round(c * 100) / 100), [90.91, 0, 9.09]);
  assert.ok(left.notes.some((n) => /keeps selling as its outcomes run out/.test(n)));
  // A box that sells in one step has nothing to walk.
  const shop = { ...spec(), boxes: [{ key: 'one', name: 'One', price: 0.01, outcomes: [{ gives: 'item', item: 'rare' }] }], scenario: { days: 30 } };
  assert.equal(simulate(shop, { now: NOW }).boxes[0].stock, undefined);
});

test('a box that stops selling: an outcome that can never be given, and an empty stash, keep it from selling at all, in words', () => {
  const never = { ...spec(), items: [{ key: 'common', name: 'Common' }, { key: 'rare', name: 'Rare', supply: 1 }] };
  never.boxes[0].outcomes[1] = { gives: 'bundle', prizes: [{ gives: 'item', item: 'rare' }, { gives: 'item', item: 'rare' }], weight: 1 };
  assert.match(check(never, { now: NOW }).warnings.find((x) => x.code === 'W-OUT-OF-STOCK').message, /is never sold/);
  const empty = { ...spec(), stashes: [{ key: 'vault', name: 'Vault', nfts: [] }] };
  empty.boxes[0].outcomes[2] = { gives: 'stash', stash: 'vault', weight: 9 };
  assert.match(check(empty, { now: NOW }).warnings.find((x) => x.code === 'W-STASH' && /starts empty/.test(x.message)).message, /“Crate” isn’t sold at all/);
  // One that sells in one step changes nothing with the setting.
  const shop = { ...spec(), boxes: [{ key: 'one', name: 'One', price: 0.01, whenOut: 'drawLeft', outcomes: [{ gives: 'item', item: 'rare' }] }] };
  assert.ok(check(shop, { now: NOW }).warnings.some((x) => x.code === 'W-WHEN-OUT' && /changes nothing/.test(x.message)));
});

test('a compressed NFT’s Sheet closes against its tree, passed in the edition’s place', () => {
  const tree = loot.pda.platform();
  const keys = loot.closeSheetIx({ project: WALLET, nft: WALLET, treasury: WALLET, tree }).keys.map((k) => k.pubkey);
  assert.deepEqual(keys, [pda.sheet(WALLET, WALLET), pda.leaf(WALLET), WALLET, WALLET, tree], 'the Sheet, the record proven empty, the treasury, the project, the tree');
  const record = loot.closeSheetIx({ project: WALLET, nft: WALLET, treasury: WALLET, tree, burned: WALLET }).keys[1].pubkey;
  assert.equal(record, WALLET, 'a record named outright');
});

test('a rule on a collection doesn’t count a Token Metadata print, in words', () => {
  const s = { ...spec(), boxes: [{ ...spec().boxes[0], gate: { collection: WALLET } }] };
  const warned = check(s, { now: NOW }).warnings.filter((x) => x.code === 'W-RULE-PRINTS');
  assert.equal(warned.length, 1);
  assert.match(warned[0].message, /a print of one of its NFTs \(an edition of a master\) doesn’t count/);
  assert.match(explainEconomy(s, { now: NOW }).text, /not a Token Metadata print/);
});

test('an item’s traits are capped at 64, each name at 64 bytes: refused before anything is signed, as the program refuses them', { skip }, () => {
  assert.deepEqual([LIMITS.itemTraits, LIMITS.traitKeyBytes, loot.MAX_ITEM_TRAITS, loot.MAX_TRAIT_KEY], [64, 64, 64, 64]);
  const traits = (n, key = (i) => `t${i}`) => Array.from({ length: n }, (_, i) => ({ attribute: key(i), min: 0, max: 9 }));
  const item = (drawn) => ({ ...spec(), items: [{ key: 'hero', name: 'Hero', drawn }], boxes: [{ key: 'crate', name: 'Crate', price: 0.01, outcomes: [{ gives: 'item', item: 'hero', weight: 1 }, { gives: 'nothing', weight: 1 }] }] });
  const refused = (s) => check(s, { now: NOW }).refusals.filter((r) => r.code === 'E-ITEM').map((r) => r.where);
  assert.deepEqual(refused(item(traits(64))), []);
  assert.deepEqual(refused(item(traits(65))), ['economy.items.hero.drawn']);
  assert.deepEqual(refused(item(traits(1, () => 'k'.repeat(64)))), []);
  assert.deepEqual(refused(item(traits(1, () => 'k'.repeat(65)))), ['economy.items.hero.drawn[0].attribute']);

  // The client refuses them too, and the program agrees at the cap and one past it.
  const w = world({ seed: 'trait-caps' });
  const fresh = (n, key = (i) => `t${i}`) => collectible('Hero', 0, { traits: Array.from({ length: n }, (_, i) => ({ key: key(i), from: { Range: { min: 0n, max: 9n } } })) });
  w.upsert({ Item: { id: 1, args: fresh(64) } });
  w.upsert({ Item: { id: 2, args: fresh(1, () => 'k'.repeat(64)) } });
  assert.throws(() => loot.upsertIx({ owner: w.creator, project: w.project, def: { Item: { id: 3, args: { ...fresh(65), collection: w.collection } } } }), /at most 64 traits.*BadItem/);
  assert.throws(() => loot.upsertIx({ owner: w.creator, project: w.project, def: { Item: { id: 3, args: { ...fresh(1, () => 'k'.repeat(65)), collection: w.collection } } } }), /at most 64 bytes.*BadItem/);
  // Past the client's check: the same accounts, the refused args.
  const raw = (args) => {
    const ix = loot.upsertIx({ owner: w.creator, project: w.project, def: { Item: { id: 3, args: { ...fresh(1), collection: w.collection } } } });
    return { ...ix, data: encodeInstruction(loot.IDL, 'upsert', { def: { Item: { id: 3, args: { ...args, collection: w.collection } } } }) };
  };
  fails(() => w.chain.send(w.creator, [raw(fresh(65))]), 'BadItem');
  fails(() => w.chain.send(w.creator, [raw(fresh(1, () => 'k'.repeat(65)))]), 'BadItem');
});
