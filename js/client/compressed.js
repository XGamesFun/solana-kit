// Compressed NFTs (Bubblegum v2) as loot takes them: a leaf as an indexer gives it, read into the shape `proveLeafIx`
// and the routes take. The chain keeps only a tree's root, changelog and canopy; the leaf and its proof come from an
// indexer (DAS `getAsset` and `getAssetProof`). Browser-safe.
import { decodeBase58 } from '../chain/base58.js';

const NOBODY = '11111111111111111111111111111111';
/** mpl-account-compression's tree header: type, version, max buffer size (u32), max depth (u32), authority, slot, padding. */
const HEADER = 56;

/**
 * How many of a proof's nodes a transaction passes for this tree: the levels its canopy does not keep. `treeData` is
 * the tree account's bytes.
 */
export function proofLength(treeData) {
  const u32 = at => treeData[at] | (treeData[at + 1] << 8) | (treeData[at + 2] << 16) | (treeData[at + 3] * 2 ** 24);
  const [buffer, depth] = [u32(2), u32(6)];
  const canopyAt = HEADER + 24 + buffer * (32 * depth + 40) + 32 * depth + 40;
  const canopy = Math.max(0, treeData.length - canopyAt);
  const cached = Math.log2(canopy / 32 + 2) - 1;
  return Math.max(0, depth - Math.round(cached));
}

const bytes = value =>
  value == null ? null : typeof value === 'string' ? decodeBase58(value) : Uint8Array.from(value);

/**
 * A compressed NFT from an indexer's answers: `asset` (DAS `getAsset`), `proof` (DAS `getAssetProof`) and the tree
 * account's bytes (`treeData`, for how much of the proof to pass). Returns { id, tree, nonce, owner, delegate,
 * collection (or null), dataHash, creatorHash, assetDataHash (or null), flags, root, proof: [node, …], burnt }. The
 * proof must be against the tree's current root when it lands: fetch it just before sending. A burned NFT (DAS says
 * `burnt`) is described as the program takes one: a data hash of all zeros, which `proveLeafIx` then proves against
 * the leaf's empty slot, so its record names no owner (a record that holds it lets go of it on that proof).
 */
export function compressedFromDas({ asset, proof, treeData }) {
  const c = asset.compression;
  const burnt = asset.burnt === true || c.burnt === true;
  // A burned leaf names nobody: any address stands in for an owner an indexer no longer gives.
  const owner = asset.ownership?.owner || (burnt ? NOBODY : asset.ownership.owner);
  return {
    id: asset.id,
    tree: c.tree,
    nonce: BigInt(c.leaf_id),
    owner,
    delegate: asset.ownership?.delegate ?? owner,
    collection: asset.grouping?.find(g => g.group_key === 'collection')?.group_value ?? null,
    dataHash: burnt ? new Uint8Array(32) : bytes(c.data_hash),
    creatorHash: bytes(c.creator_hash),
    assetDataHash: bytes(c.asset_data_hash ?? null),
    flags: Number(c.flags ?? 0),
    root: bytes(proof.root),
    proof: proof.proof.slice(0, proofLength(treeData)),
    burnt,
  };
}
