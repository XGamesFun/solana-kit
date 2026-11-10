// Compressed NFTs on the local chain, for the client's tests: a Bubblegum v2 tree of the maker's own, leaves minted
// into the project's collection (which carries Bubblegum's plugin in a `world({ compressed: true })`), and an indexer
// that mirrors every leaf as DAS keeps it (`getAsset`, `getAssetProof`), so `compressedFromDas`, `proveLeafIx` and the
// player module's `nftOf` read them as they read a real indexer. The chain keeps only the tree's root and changelog: a
// change on chain is mirrored here once it landed (`moved`). Hashes are Keccak-256, as Bubblegum's.
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, meta } from '../chain/programs.js';
import { createAccountIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { newAddress } from '../sim/chain.mjs';

// ---------------------------------------------------------------- Keccak-256 (the original padding, not SHA-3's)

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
// Each lane's rotation, by its x then y.
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map(x => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    const d = [0, 1, 2, 3, 4].map(x => c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1));
    for (let i = 0; i < 25; i++) s[i] ^= d[i % 5];
    const b = new Array(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

/** Keccak-256 of the parts, one after another. */
export function keccak(...parts) {
  const rate = 136;
  const input = concat(...parts);
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let at = 0; at < padded.length; at += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[at + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i] >> BigInt(8 * k)) & 0xffn);
  return out;
}

// ---------------------------------------------------------------- Bubblegum v2

const CREATE_TREE_V2 = Uint8Array.of(55, 99, 95, 215, 142, 203, 227, 205);
const MINT_V2 = Uint8Array.of(120, 121, 23, 146, 173, 110, 199, 205);
const str = s => concat(uintLE(utf8(s).length, 4), utf8(s));
/** `asset_data_hash` of a leaf with no asset data: Keccak-256 of nothing. */
const NO_ASSET_DATA = keccak(new Uint8Array(0));

/** A leaf's hash (LeafSchema V2). */
const leafHash = n =>
  keccak(
    Uint8Array.of(2),
    addressBytes(n.id),
    addressBytes(n.owner),
    addressBytes(n.delegate),
    uintLE(n.nonce, 8),
    n.dataHash,
    n.creatorHash,
    keccak(addressBytes(n.collection)),
    NO_ASSET_DATA,
    Uint8Array.of(n.flags),
  );

/** mpl-account-compression's tree: its header, then the sequence, the active changelog index and the buffer size. */
export function onChainRoot(w, tree) {
  const data = w.chain.get(tree.address).data;
  const active = Number(new DataView(data.buffer, data.byteOffset).getBigUint64(56 + 8, true));
  const at = 56 + 24 + active * (40 + 32 * tree.depth);
  return data.subarray(at, at + 32);
}

/**
 * `maker`'s own tree (depth 5, a changelog of 8, no canopy: a proof of 5 nodes), and the indexer that mirrors it.
 * `mint(owner)` mints a leaf of `collection` (whose update authority `maker` is) to `owner`; `moved(n, to)` records a
 * leaf that went to `to` on chain; `das(n)` is what an indexer answers for it; `rpc` the world's RPC answering DAS too.
 */
export function cnftTree(w, { maker = w.creator, collection = w.collection, depth = 5, buffer = 8 } = {}) {
  const address = newAddress(w.random);
  const space = loot.treeSize(depth, buffer, 0);
  const config = loot.pda.treeConfig(address);
  w.chain.send(maker, [
    computeUnitLimit(1_400_000),
    createAccountIx({
      from: maker,
      address,
      lamports: w.chain.rent(space),
      space,
      owner: loot.COMPRESSION_PROGRAM,
    }),
    {
      programId: loot.BUBBLEGUM_PROGRAM,
      keys: [
        meta(config, false, true),
        meta(address, false, true),
        meta(maker, true, true),
        meta(maker, true, false),
        meta(loot.NOOP_PROGRAM, false, false),
        meta(loot.COMPRESSION_PROGRAM, false, false),
        meta(SYSTEM_PROGRAM, false, false),
      ],
      data: concat(CREATE_TREE_V2, uintLE(depth, 4), uintLE(buffer, 4), Uint8Array.of(1, 0)),
    },
  ]);
  const leaves = new Map();
  const empty = [new Uint8Array(32)];
  for (let l = 1; l <= depth; l++) empty.push(keccak(empty[l - 1], empty[l - 1]));
  const node = (level, i) => {
    if (level === 0) return leaves.get(i) ?? empty[0];
    if (![...leaves.keys()].some(k => k >> level === i)) return empty[level];
    return keccak(node(level - 1, 2 * i), node(level - 1, 2 * i + 1));
  };
  const tree = { address, config, depth, minted: 0, nfts: new Map() };
  tree.root = () => node(depth, 0);
  tree.proof = index => Array.from({ length: depth }, (_, l) => node(l, (index >> l) ^ 1));
  tree.mint = owner => {
    const nonce = tree.minted;
    const creators = concat(addressBytes(maker), Uint8Array.of(1, 100));
    const metadata = concat(
      str(`Outside cNFT #${nonce}`),
      str('OCN'),
      str('https://example.invalid/outside/compressed.json'),
      uintLE(500, 2),
      Uint8Array.of(0, 1), // primary sale not happened, mutable
      Uint8Array.of(1, 0), // Some(NonFungible)
      uintLE(1, 4),
      creators,
      Uint8Array.of(1),
      addressBytes(collection),
    );
    w.chain.send(maker, [
      computeUnitLimit(1_400_000),
      {
        programId: loot.BUBBLEGUM_PROGRAM,
        keys: [
          meta(config, false, true),
          meta(maker, true, true),
          meta(maker, true, false),
          meta(maker, true, false),
          meta(owner, false, false),
          meta(loot.BUBBLEGUM_PROGRAM, false, false),
          meta(address, false, true),
          meta(collection, false, true),
          meta(loot.BUBBLEGUM_CORE_SIGNER, false, false),
          meta(loot.NOOP_PROGRAM, false, false),
          meta(loot.COMPRESSION_PROGRAM, false, false),
          meta(loot.MPL_CORE_PROGRAM, false, false),
          meta(SYSTEM_PROGRAM, false, false),
        ],
        data: concat(MINT_V2, metadata, Uint8Array.of(0, 0)),
      },
    ]);
    const n = {
      id: loot.pda.compressedAsset(address, nonce),
      nonce: BigInt(nonce),
      owner,
      delegate: owner,
      collection,
      dataHash: keccak(keccak(metadata), uintLE(500, 2)),
      creatorHash: keccak(creators),
      flags: 0,
    };
    tree.minted += 1;
    tree.nfts.set(n.id, n);
    leaves.set(nonce, leafHash(n));
    return n.id;
  };
  /** The leaf of `id` went to `to` on chain: a move sets its owner and delegate to them. */
  tree.moved = (id, to) => {
    const n = tree.nfts.get(id);
    Object.assign(n, { owner: to, delegate: to });
    leaves.set(Number(n.nonce), leafHash(n));
  };
  /** What DAS answers for `id`: { asset, proof }, as `getAsset` and `getAssetProof` do. */
  tree.das = id => {
    const n = tree.nfts.get(id);
    return {
      asset: {
        id,
        compression: {
          compressed: true,
          tree: address,
          leaf_id: Number(n.nonce),
          data_hash: encodeBase58(n.dataHash),
          creator_hash: encodeBase58(n.creatorHash),
          asset_data_hash: null,
          flags: n.flags,
          burnt: false,
        },
        ownership: { owner: n.owner, delegate: n.delegate },
        grouping: [{ group_key: 'collection', group_value: n.collection }],
      },
      proof: { root: encodeBase58(tree.root()), proof: tree.proof(Number(n.nonce)).map(x => encodeBase58(x)) },
    };
  };
  /** `id` as the client's routes take it (`compressedFromDas`), against the root now. */
  tree.compressed = id => loot.compressedFromDas({ ...tree.das(id), treeData: w.chain.get(address).data });
  /** The world's RPC, answering DAS's `getAsset` and `getAssetProof` from this indexer. */
  tree.rpc = {
    ...w.chain.rpc,
    async call(method, params) {
      const id = params?.id;
      if (method === 'getAsset' && tree.nfts.has(id)) return tree.das(id).asset;
      if (method === 'getAssetProof' && tree.nfts.has(id)) return tree.das(id).proof;
      return w.chain.rpc.call(method, params);
    },
  };
  return tree;
}
