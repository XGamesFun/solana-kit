// The program numbers of a live economy's parts stay what they were when they landed, whatever a later version of the
// spec removes or reorders: every part with a record of its own keeps its number in the spec (`recordLanded`), and
// xsolana_save carries it into a new version (`carryIds`). A contest is the exception that needs none: the spec only
// describes it, and the authority opens each one while the project runs under a number it picks, which the player module
// then reads from the record. This file holds both to it.
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
import { changedParts } from '../economy/live.mjs';
import { model, WSOL } from '../economy/model.mjs';
import { contestArgs } from '../economy/plan.mjs';
import { carryIds } from '../mcp/tools.mjs';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;
const example = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));
const contest = (key, name, sides) => ({ key, name, sides, entriesClose: '10m', resultDue: '1h', decidedBy: 'the game server' });

/** A wallet: signs each prepared wire in its own slot, as signTransaction does. */
const signAll = (wallet, wires) =>
  wires.map((b64) => {
    const t = readTransaction(fromBase64(b64));
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(wallet.address)] = wallet.sign(t.message);
    return toBase64(wireTransaction(t.message, sigs));
  });
const asWallet = (kp) => ({ address: kp.address, signTransaction: async (wire) => fromBase64(signAll(kp, [toBase64(wire)])[0]) });

/** The spec put live through the approval page, in LiteSVM: the world, the owner and the file it wrote. */
async function goLive(spec) {
  const w = world({ project: false, seed: 'stable-numbers' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-numbers-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  const chain = approvalChain(w, { send: async (wire) => w.chain.sendWire(wire) });
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 10 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
  }
  return { w, owner, file, chain, saved: JSON.parse(readFileSync(file, 'utf8')) };
}

test('removing a live economy’s first contest changes no contest a player or a publish addresses', { skip }, async () => {
  const spec = { ...example, contests: [contest('first', 'First match', 2), contest('second', 'Second match', 3)] };
  const { w, owner, file, chain, saved } = await goLive(spec);
  const project = saved.live.project;
  assert.ok(project && !saved.live.partial);
  // The setup opens no contest: the spec only describes them.
  for (const id of [1, 2, 3]) assert.equal(w.chain.get(loot.pda.contest(project, id)), null, `no contest ${id} after the setup`);

  // The authority (the owner here) opens the second match while the project runs, under a number it picks.
  const m = model(saved, { now: NOW });
  const opened = 7;
  w.chain.send(owner.address, [loot.openContestIx({ authority: owner.address, project, id: opened, mint: WSOL, args: contestArgs(m.contest.get('second'), m, NOW) })]);
  assert.equal(w.read('Contest', loot.pda.contest(project, opened)).sides.length, 3);

  // A player backs side 2 of it.
  const player = freshKeypair();
  w.chain.airdrop(player.address, 10_000_000_000n);
  const before = solanaApp({ spec: saved, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  await before.enter(opened, 2, 0.5);

  // The first match is taken out of xsolana.json.
  const trimmed = { ...saved, contests: saved.contests.filter((c) => c.key !== 'first') };
  writeFileSync(file, JSON.stringify(trimmed, null, 2));

  // A publish plans nothing: a contest has no record of the setup's to add, change or leave behind.
  const change = changedParts(trimmed);
  assert.deepEqual([...change.only], []);
  assert.deepEqual(change.removed, []);
  assert.equal((await createApproval({ file, chain, now: () => NOW })).state().done, true, 'nothing to publish');

  // The player module, with the trimmed spec, still finds the same contest: its number is the record's.
  const after = solanaApp({ spec: trimmed, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  w.chain.warp(NOW + 20 * 60);
  w.chain.send(owner.address, [loot.decideIx({ signer: owner.address, project, contest: w.read('Contest', loot.pda.contest(project, opened)), side: 2 })]);
  const claims = (await after.claims()).filter((c) => c.kind === 'contest');
  assert.deepEqual(claims.map((c) => [c.id, c.side]), [[opened, 2]]);
  await after.claim(claims[0]);
  assert.deepEqual((await after.claims()).filter((c) => c.kind === 'contest'), [], 'claimed');
});

test('xsolana_save keeps every number a live part landed with, so removing an earlier part renumbers none', () => {
  const seller = 'SysvarC1ock11111111111111111111111111111111';
  const live = {
    version: 2,
    currency: 'coin',
    tokens: [{ key: 'coin', source: 'existing', mint: WSOL, decimals: 9 }],
    pools: [{ key: 'a', currency: 'coin', index: 0 }, { key: 'b', currency: 'coin', index: 1 }],
    // A farm that pays nothing: the empty pool made for it took number 2.
    farms: [{ key: 'club', name: 'Club', stakes: 'coin', id: 1, rewardsIndex: 2 }],
    auctions: [{ key: 'lot', name: 'Lot', id: 1, seller, lot: { roll: 'chest' } }],
    live: { project: seller, published: {} },
  };
  // The next version as an agent writes it: no numbers, and pool "a" taken out.
  const next = { ...live, pools: [{ key: 'b', currency: 'coin' }], farms: [{ key: 'club', name: 'Club', stakes: 'coin' }], auctions: [{ key: 'lot', name: 'Lot', lot: { roll: 'chest' } }] };
  delete next.live;
  const saved = carryIds(live, next);
  assert.equal(saved.pools[0].index, 1);
  assert.equal(saved.farms[0].rewardsIndex, 2, 'the farm’s empty pool keeps its number');
  assert.equal(saved.auctions[0].seller, seller, 'the auction keeps the seller its address names');
  const m = model(saved);
  assert.equal(m.pool.get('club-rewards').index, 2, 'not the number pool “a” left free');
  // A pool added later takes a free number, never the farm's.
  const added = model({ ...saved, pools: [...saved.pools, { key: 'c', currency: 'coin' }] });
  assert.notEqual(added.pool.get('c').index, 2);
  assert.notEqual(added.pool.get('c').index, 1);
});
