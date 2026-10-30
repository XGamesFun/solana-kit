// Traits from NFTs' off-chain metadata, as the client builds their tree and the program takes it: the project's authority
// sets the root once (`set_traits`); anyone proves an NFT's traits into its Sheet (`prove_traits`), once.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { encodeBase58 } from '../chain/base58.js';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const fresh = () => encodeBase58(randomBytes(32));

test('the program takes a traits tree the client builds, and writes each NFT’s traits into its Sheet once', { skip }, () => {
  const w = world({ seed: 'traits' });
  const club = newAddress(w.random);
  const colours = ['Blue', 'Red', 'Green'];
  const entries = colours.map((value) => ({ nft: newAddress(w.random), attributes: [{ key: 'Background', value }, { key: 'Class', value: 'Mage' }] }));
  const tree = loot.traitsTree(entries);
  w.chain.send(w.authority, [loot.setTraitsIx({ signer: w.authority, project: w.project, key: club, root: tree.root })]);
  assert.deepEqual(loot.decodeAny(w.chain.get(loot.pda.traits(w.project, club)).data).value, { project: w.project, key: club, root: Buffer.from(tree.root).toString('hex') });

  const prove = (who, entry, attributes = entry.attributes) =>
    w.chain.send(who, [loot.proveTraitsIx({ signer: who, project: w.project, key: club, nft: entry.nft, attributes, proof: tree.proof(entry.nft) })]);
  assert.throws(() => prove(w.player, entries[2], [{ key: 'Background', value: 'Blue' }, { key: 'Class', value: 'Mage' }]), /NotTheTraits/);
  for (const entry of entries) prove(w.player, entry);
  const sheet = (nft) => loot.decodeSheet(w.chain.get(loot.pda.sheet(w.project, nft)).data).attributes;
  assert.deepEqual(sheet(entries[2].nft), entries[2].attributes);
  // What the project wrote since is never set back by a proof, whoever sends it.
  w.chain.send(w.authority, [loot.collectibleIx({ authority: w.authority, project: w.project, collection: loot.MPL_CORE_PROGRAM, asset: entries[0].nft, hasAuthority: false, change: { Set: [[{ key: 'Class', value: 'Archmage' }]] } })]);
  prove(w.cranker, entries[0]);
  assert.deepEqual(sheet(entries[0].nft), [{ key: 'Background', value: 'Blue' }, { key: 'Class', value: 'Archmage' }]);
});

test('a compressed NFT’s indexer answers become what prove_leaf and the routes take', () => {
  // A tree of depth 14, a changelog of 64, a canopy of 10 levels: a proof of 4 nodes.
  const [depth, buffer, canopy] = [14, 64, 10];
  const size = 56 + 24 + buffer * (32 * depth + 40) + 32 * depth + 40 + ((1 << (canopy + 1)) - 2) * 32;
  const treeData = new Uint8Array(size);
  new DataView(treeData.buffer).setUint32(2, buffer, true);
  new DataView(treeData.buffer).setUint32(6, depth, true);
  assert.equal(loot.proofLength(treeData), 4);
  const [id, tree, owner, collection, project, player] = Array.from({ length: 6 }, fresh);
  const nodes = Array.from({ length: depth }, fresh);
  const hash = loot.pda.leaf(id); // any base58 32 bytes
  const asset = { id, compression: { tree, leaf_id: 7, data_hash: hash, creator_hash: hash, flags: 0 }, ownership: { owner, delegate: null }, grouping: [{ group_key: 'collection', group_value: collection }] };
  const c = loot.compressedFromDas({ asset, proof: { root: hash, proof: nodes }, treeData });
  assert.deepEqual([c.id, c.owner, c.delegate, c.collection, c.nonce, c.proof], [id, owner, owner, collection, 7n, nodes.slice(0, 4)]);

  const prove = loot.proveLeafIx({ signer: player, compressed: c });
  assert.deepEqual(prove.keys.slice(-4).map((k) => k.pubkey), nodes.slice(0, 4), 'the proof last, as remaining accounts');
  const shown = loot.shownAccounts(project, { compressed: id, tree }).map((k) => k.pubkey);
  assert.deepEqual(shown, [id, loot.pda.leaf(id), tree, loot.pda.sheet(project, id)]);
  const p = loot.piece({ project, compressed: c });
  assert.deepEqual([p.accounts.asset, p.accounts.leaf, p.accounts.tree, p.accounts.tree_config, p.accounts.sheet, p.accounts.leaf_delegate], [id, loot.pda.leaf(id), tree, loot.pda.treeConfig(tree), loot.pda.sheet(project, id), null]);
  assert.deepEqual(p.writable, ['leaf', 'tree', 'tree_config'], 'Bubblegum writes them when it moves or locks the leaf');
  assert.equal(p.proof.length, 4);
  // Only read (a watch farm): no Bubblegum accounts, and the tree read-only.
  const read = loot.piece({ project, compressed: c, moves: false, locks: false, writes: false });
  assert.deepEqual([read.accounts.tree_config, read.accounts.bubblegum_program, read.accounts.collection, read.writable], [null, null, null, []]);
});

test('a compressed prize names the project tree, its config, the item’s collection and Bubblegum’s programs; open_tree the tree', () => {
  const [project, tree, collection, signer, winner] = Array.from({ length: 5 }, fresh);
  const item = { kind: 'Collectible', collection, issued: 0 };
  const metas = loot.prizeMetas({ project, prize: { Compressed: { item: 60, tree } }, winner, items: { 60: item } });
  assert.deepEqual(metas.map((m) => m.pubkey), [
    loot.pda.item(project, 60), loot.pda.treeConfig(tree), tree, collection,
    loot.BUBBLEGUM_PROGRAM, loot.COMPRESSION_PROGRAM, loot.NOOP_PROGRAM, loot.MPL_CORE_PROGRAM, loot.BUBBLEGUM_CORE_SIGNER,
  ]);
  assert.deepEqual(metas.slice(0, 4).map((m) => m.isWritable), [true, true, true, true]);
  const ix = loot.openTreeIx({ signer, project, tree, maxDepth: 14, maxBufferSize: 64 });
  assert.equal(ix.keys[2].pubkey, tree);
  assert.equal(loot.treeSize(14, 64, 10), 97_272, 'depth 14, buffer 64, canopy 10, as the Rust tests make it');
});
