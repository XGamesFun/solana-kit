// Compressed NFT prizes as the client builds them and the program takes them, against Bubblegum and
// mpl-account-compression as they run on mainnet and Core as on devnet: the owner opens the project's tree, and a grant gives a compressed badge of an item
// into it per claim. The project's collection, carrying Bubblegum's plugin, takes the project's Core collectibles too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import { createAccountIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { freshAddresses, prepare, recordLanded } from '../economy/live.mjs';
import { compressedTree, model } from '../economy/model.mjs';
import { plan } from '../economy/plan.mjs';
import { newAddress } from '../sim/chain.mjs';
import { cannotRunCompressed, collectible, world } from './world.mjs';

const skip = cannotRunCompressed() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
const grantArgs = (gives) => ({ gives, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true });

/** The owner makes the tree's account empty and opens it as the project's tree, in one transaction. */
export function openTree(w, { maxDepth = 14, maxBufferSize = 64, canopy = 0 } = {}) {
  const tree = newAddress(w.random);
  const space = loot.treeSize(maxDepth, maxBufferSize, canopy);
  w.chain.send(w.creator, [
    createAccountIx({ from: w.creator, address: tree, lamports: w.chain.rent(space), space, owner: loot.COMPRESSION_PROGRAM }),
    loot.openTreeIx({ signer: w.creator, project: w.project, tree, maxDepth, maxBufferSize }),
  ]);
  return tree;
}

t('the owner opens the project’s tree, and a grant gives a compressed badge into it per claim', () => {
  const w = world({ seed: 'compressed-prizes', compressed: true });
  w.upsert({ Item: { id: 60, args: collectible('Badge') } });
  const tree = openTree(w);
  const config = w.chain.get(pda.treeConfig(tree));
  assert.equal(config.owner, loot.BUBBLEGUM_PROGRAM, 'Bubblegum’s config for it');

  w.upsert({ Grant: { id: 1, args: grantArgs({ Compressed: { item: 60, tree } }) } });
  const item = w.read('Item', pda.item(w.project, 60));
  for (const n of [1, 2]) {
    const wallet = w.who();
    const grant = w.read('Grant', pda.grant(w.project, 1));
    const r = w.chain.send(wallet, [computeUnitLimit(600_000), loot.claimGrantIx({ project: w.project, id: 1, grant, wallet, signer: wallet, item })]);
    const given = r.receipts.find((x) => x.name === 'PrizeGiven').data;
    assert.equal(given.serial, n, 'numbered by the item’s serial');
    assert.equal(given.winner, wallet);
    assert.equal(given.asset, pda.compressedAsset(tree, n - 1), 'Bubblegum’s asset id, the tree’s count before it');
  }
  assert.equal(w.read('Item', pda.item(w.project, 60)).issued, 2);

  // The same collection takes a Core collectible of the project.
  const asset = w.make(60, w.player);
  assert.equal(parseCoreAsset(w.chain.get(asset).data).owner, w.player);
});

t('a compressed prize of an item never written, or past its supply, gives nothing, and a strict claim is refused', () => {
  const w = world({ seed: 'compressed-refused', compressed: true });
  const tree = openTree(w);
  w.upsert({ Item: { id: 61, args: collectible('Rare', 1) } });
  w.upsert({ Grant: { id: 1, args: grantArgs({ Compressed: { item: 61, tree } }) } });
  const claim = () => {
    const grant = w.read('Grant', pda.grant(w.project, 1));
    const item = w.read('Item', pda.item(w.project, 61));
    const wallet = w.who();
    return w.chain.send(wallet, [computeUnitLimit(600_000), loot.claimGrantIx({ project: w.project, id: 1, grant, wallet, signer: wallet, item })]);
  };
  claim();
  assert.throws(claim, /PrizeNotCovered/, 'its one is given');
});

t('a spec whose grant gives a compressed badge goes live (its collection with Bubblegum’s plugin, its tree opened) and is claimed', () => {
  const w = world({ seed: 'compressed-spec', project: false, compressed: true });
  const NOW = w.chain.now();
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Badges',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Badges' },
    items: [{ key: 'badge', name: 'Badge', uri: 'https://example.invalid/badge/{serial}.json' }],
    grants: [{ key: 'open', name: 'Open Badge', prize: { gives: 'item', item: 'badge', compressed: true }, limits: { perWallet: 1 }, fund: 0.01 }],
  };
  const m = model(spec, { now: NOW });
  assert.deepEqual(compressedTree(m), { depth: 14, buffer: 64, canopy: 4, bytes: loot.treeSize(14, 64, 4) });
  const keys = freshAddresses(plan(spec, { now: NOW }).freshKeys, w.random);
  const p = prepare(spec, { owner: w.creator, keys, now: NOW, rent: (bytes) => w.chain.rent(bytes) });
  assert.ok(p.ok, JSON.stringify(p.refusals));
  for (const tx of p.transactions) w.chain.send(w.creator, tx.instructions, { label: tx.steps.map((s) => s.id).join(', ') });
  const tree = keys['new:tree'];
  assert.equal(w.chain.get(tree).data.length, compressedTree(m).bytes, 'the tree’s rent as planned');
  assert.equal(w.chain.get(pda.treeConfig(tree)).owner, loot.BUBBLEGUM_PROGRAM);
  const live = recordLanded(spec, { ctx: p.ctx, now: NOW });
  assert.equal(live.live.tree, tree);
  assert.ok(check(live, { now: NOW }).ok, 'live, it checks as it is');

  const grant = w.read('Grant', pda.grant(p.ctx.project, 1));
  assert.deepEqual(grant.gives, { Compressed: { item: 1, tree } });
  const wallet = w.who();
  const item = w.read('Item', pda.item(p.ctx.project, 1));
  const r = w.chain.send(wallet, [computeUnitLimit(600_000), loot.claimGrantIx({ project: p.ctx.project, id: 1, grant, wallet, signer: wallet, item })]);
  const given = r.receipts.find((x) => x.name === 'PrizeGiven').data;
  assert.equal(given.asset, pda.compressedAsset(tree, 0));

  // A live economy whose collection went out without the plugin can't give one.
  const { live: _, ...bare } = spec;
  const plain = { ...bare, grants: [{ ...spec.grants[0], prize: { gives: 'item', item: 'badge' } }] };
  const wasPlain = recordLanded(plain, { ctx: { ...p.ctx, tree: null }, now: NOW });
  const later = { ...wasPlain, grants: spec.grants };
  const refused = check(later, { now: NOW });
  assert.ok(refused.refusals.some((x) => x.where === 'economy.grants.open.prize.compressed' && /without Bubblegum’s plugin/.test(x.message)), JSON.stringify(refused.refusals));
});

t('the checker refuses a compressed prize the program would never give', () => {
  const base = {
    version: 2,
    network: 'devnet',
    name: 'Badges',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Badges' },
    items: [{ key: 'pin', name: 'Pin', soulbound: true }, { key: 'coin', name: 'Coin', kind: 'normal' }],
    pools: [{ key: 'gold', currency: 'sol' }],
  };
  const grant = (prize) => ({ ...base, grants: [{ key: 'g', name: 'G', prize, limits: { perWallet: 1 } }] });
  const why = (spec) => check(spec, { now: 1_790_000_000 }).refusals.map((x) => x.message).join(' | ');
  assert.match(why(grant({ gives: 'item', item: 'pin', compressed: true })), /soulbound/);
  assert.match(why(grant({ gives: 'item', item: 'coin', compressed: true })), /normal item/);
  assert.match(why(grant({ gives: 'tokens', amount: 1, from: 'pool:gold', compressed: true })), /only an item’s collectible/);
});
