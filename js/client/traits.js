// The traits a project vouches for (`set_traits`, `prove_traits`): a Merkle tree of what NFTs' off-chain metadata says
// of them (a background, a class), whose root the project's owner or authority signs once. Anyone then writes an NFT's
// traits into its Sheet with its proof. Leaves and nodes are hashed exactly as the program hashes them. Browser-safe.
import { addressBytes } from '../chain/base58.js';
import { compareBytes, concat, uintLE, utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';

const text = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));

/** A leaf: an NFT's address and its traits ([{ key, value }], in order). */
export const traitsLeaf = (nft, attributes) =>
  sha256(concat(Uint8Array.of(0), addressBytes(nft), uintLE(attributes.length, 4), ...attributes.map((a) => concat(text(a.key), text(a.value)))));

/** Two nodes joined, the smaller first, so a proof needs no left or right. */
export const traitsNode = (a, b) => (compareBytes(a, b) <= 0 ? sha256(concat(Uint8Array.of(1), a, b)) : sha256(concat(Uint8Array.of(1), b, a)));

/**
 * The tree of `entries` ([{ nft, attributes }]): { root, proof(nft) → [node, …] bottom up }. A node left without a pair
 * at a level goes up as it is.
 */
export function traitsTree(entries) {
  const levels = [entries.map((e) => traitsLeaf(e.nft, e.attributes))];
  while (levels.at(-1).length > 1) {
    const below = levels.at(-1);
    const up = [];
    for (let i = 0; i < below.length; i += 2) up.push(i + 1 < below.length ? traitsNode(below[i], below[i + 1]) : below[i]);
    levels.push(up);
  }
  const at = new Map(entries.map((e, i) => [e.nft, i]));
  return {
    root: levels.at(-1)[0],
    proof(nft) {
      let i = at.get(nft);
      if (i === undefined) throw new Error(`${nft} is not in this traits tree.`);
      const out = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = i ^ 1;
        if (sibling < level.length) out.push(level[sibling]);
        i >>= 1;
      }
      return out;
    },
  };
}
