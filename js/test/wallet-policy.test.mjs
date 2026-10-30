// The live evals' test wallet refuses what a drainer or a careless app would slip in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE } from '../chain/bytes.js';
import { createAssociatedTokenAccountIdempotent, meta, transferLamports } from '../chain/programs.js';
import { compileMessage } from '../chain/tx.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import * as loot from '../client/index.js';
import { checkTransaction } from '../../evals/live/wallet.mjs';

const me = freshKeypair().address;
const thief = freshKeypair().address;
const mint = freshKeypair().address;
const bh = freshKeypair().address;
const verdict = (instructions, role = 'player') => checkTransaction(compileMessage({ payer: me, blockhash: bh, instructions }), { address: me, role });

test('signs a plain purchase', () => {
  const box = { box_id: 1, version: 0, price: 10n, currency: mint, entries: [{ prizes: [], burns: false, weight: 1 }] };
  const v = verdict([createAssociatedTokenAccountIdempotent(me, me, mint), loot.openBoxIx({ player: me, project: loot.pda.project(mint), box, nonce: 1n })]);
  assert.equal(v.ok, true, v.findings.join(' '));
});

test('refuses SOL sent to a stranger, a delegate approval, a foreign program, and an authority instruction from a player', () => {
  assert.equal(verdict([transferLamports(me, thief, 1_000_000n)]).ok, false);
  const approveIx = { programId: TOKEN_PROGRAM, keys: [meta(loot.ata(me, mint), false, true), meta(thief, false, false), meta(me, true, false)], data: concat(Uint8Array.of(4), uintLE(1_000_000n, 8)) };
  assert.match(verdict([approveIx]).findings.join(' '), /delegate/);
  assert.match(verdict([{ programId: thief, keys: [meta(me, true, true)], data: new Uint8Array(1) }]).findings.join(' '), /program the economy does not use/);
  const upsert = loot.upsertIx({ owner: me, project: loot.pda.project(mint), def: { Item: { id: 1, args: { kind: 'Collectible', rarity: 0, soulbound: false, burnable: false, name: 'x', uri: '', max_supply: 0, life: null, active: true } } } });
  assert.equal(verdict([upsert], 'player').ok, false);
  assert.equal(verdict([upsert], 'owner').ok, true);
  assert.ok(addressBytes(thief));
});

test('signs a bid, and an auction of a collectible of their own, as a player or an owner', () => {
  const project = loot.pda.project(mint);
  const auction = { mint, seller: me, high: 0n, high_bidder: me, lot: { Item: [1] }, reserve: 1n, min_raise_bps: 500, starts_at: 0n, ends_at: 10n, extend: 0, shares: [], gate: null };
  assert.equal(verdict([loot.bidIx({ bidder: me, project, id: 1, auction, amount: 1n })]).ok, true);
  const open = loot.openAuctionIx({ seller: me, project, collection: mint, id: 1, mint, args: { ...auction, lot: { Asset: [thief] } } });
  assert.equal(verdict([open], 'player').ok, true);
  assert.equal(verdict([open], 'owner').ok, true);
});

test('signs the wallet’s own lookup table’s steps (js/play’s v0 sends), not a frozen table or another authority’s', async () => {
  const { createTableIx, extendTableIx, deactivateTableIx, closeTableIx, freezeTableIx } = await import('../chain/lookup.js');
  const { address, instruction } = createTableIx({ authority: me, slot: 7n });
  const v = verdict([instruction, extendTableIx({ table: address, authority: me, addresses: [mint, thief] })]);
  assert.equal(v.ok, true, v.findings.join(' '));
  assert.equal(verdict([deactivateTableIx({ table: address, authority: me })]).ok, true);
  assert.equal(verdict([closeTableIx({ table: address, authority: me })]).ok, true);
  assert.match(verdict([freezeTableIx({ table: address, authority: me })]).findings.join(' '), /unexpected lookup-table/);
  const theirs = createTableIx({ authority: thief, payer: me, slot: 7n });
  assert.match(verdict([theirs.instruction]).findings.join(' '), /authority is/);
});

test('reads a v0 transaction’s accounts from its lookup tables: a SOL-priced open is signed, a close to another wallet is not', async () => {
  const { closeTableIx, planTable } = await import('../chain/lookup.js');
  const { withSolWrap } = await import('../chain/programs.js');
  const { NATIVE_MINT } = await import('../chain/pda.js');
  const box = { box_id: 1, version: 0, price: 10n, currency: NATIVE_MINT, entries: [{ prizes: [], burns: false, weight: 1 }] };
  const open = loot.openBoxIx({ player: me, project: loot.pda.project(mint), box, nonce: 1n });
  // Wide enough to go as v0: forty more accounts of the box's own.
  const wide = { ...open, keys: [...open.keys, ...Array.from({ length: 40 }, () => meta(freshKeypair().address, false, false))] };
  const plan = planTable({ payer: me, blockhash: bh, slot: 5n, instructions: withSolWrap(me, NATIVE_MINT, 10n, [wide]) });
  const message = compileMessage({ payer: me, blockhash: bh, instructions: plan.final, version: 0, lookupTables: [plan.table] });
  const read = checkTransaction(message, { address: me, role: 'player', tables: { [plan.table.address]: plan.table.addresses } });
  assert.equal(read.ok, true, read.findings.join(' '));
  assert.match(checkTransaction(message, { address: me, role: 'player' }).findings.join(' '), /lookup table the wallet couldn't read/);
  assert.match(verdict([closeTableIx({ table: plan.table.address, authority: me, recipient: thief })]).findings.join(' '), /rent to/);
});
