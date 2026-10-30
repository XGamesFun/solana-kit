// Metaplex Core: a project's collection (created by its owner's wallet, with the loot project as update delegate) and
// reading a Core asset (owner, collection, name, uri, attributes, freeze state). The layouts are Core's own, checked
// against the real Core program in the tests.
import { addressBytes, encodeBase58 } from './base58.js';
import { concat, fromUtf8, readUintLE, uintLE, utf8 } from './bytes.js';
import { MPL_CORE_PROGRAM, SYSTEM_PROGRAM } from './pda.js';
import { meta } from './programs.js';

export { MPL_CORE_PROGRAM };
/** MPL Core `CreateCollectionV2`. */
const CREATE_COLLECTION_V2 = 21;
const PLUGIN = { Royalties: 0, FreezeDelegate: 1, UpdateDelegate: 4, PermanentFreezeDelegate: 5, Attributes: 6, BubblegumV2: 15 };
const ASSET_V1 = 1;
const COLLECTION_V1 = 5;
const PLUGIN_HEADER = 3;
const UPDATE_AUTHORITY_COLLECTION = 2;

/** A Borsh string as Core writes it. */
const coreString = (text) => {
  const bytes = utf8(text);
  return concat(uintLE(bytes.length, 4), bytes);
};

/**
 * A project's Core collection. The creator is its update authority and royalty receiver; the loot project's address
 * (`project`, for example `pda.project(creator, 0)` from the client) is an update delegate so the program can mint into it. `compressed`:
 * it also carries Bubblegum's plugin, so compressed NFTs can be minted into it. The collection address signs too (a
 * fresh key).
 */
export function createCollectionInstruction({ collection, creator, name, uri, royaltyBps = 500, project, compressed = false }) {
  if (!project) throw new Error('createCollectionInstruction needs the loot project that mints into the collection (`project`).');
  const data = concat(
    Uint8Array.of(CREATE_COLLECTION_V2),
    coreString(name),
    coreString(uri),
    Uint8Array.of(1), // plugins: Some
    uintLE(compressed ? 3 : 2, 4),
    // Royalties { basis_points, creators: [creator 100%], rule_set: None }, authority: default.
    Uint8Array.of(PLUGIN.Royalties),
    uintLE(royaltyBps, 2),
    uintLE(1, 4),
    addressBytes(creator),
    Uint8Array.of(100, 0, 0),
    // UpdateDelegate { additional_delegates: [the project] }, authority: default.
    Uint8Array.of(PLUGIN.UpdateDelegate),
    uintLE(1, 4),
    addressBytes(project),
    Uint8Array.of(0),
    // BubblegumV2 {}, authority: default.
    compressed ? Uint8Array.of(PLUGIN.BubblegumV2, 0) : new Uint8Array(0),
    Uint8Array.of(0), // external plugin adapters: None
  );
  return {
    programId: MPL_CORE_PROGRAM,
    keys: [
      meta(collection, true, true),
      meta(creator, false, false),
      meta(creator, true, true),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    data,
  };
}

function reader(data, start) {
  let at = start;
  const need = (n) => {
    if (at + n > data.length) throw new RangeError('read past the end of the account');
  };
  return {
    get at() {
      return at;
    },
    skip(n) {
      at += n;
    },
    byte() {
      need(1);
      return data[at++];
    },
    u32() {
      need(4);
      const v = Number(readUintLE(data, at, 4));
      at += 4;
      return v;
    },
    u64() {
      need(8);
      const v = readUintLE(data, at, 8);
      at += 8;
      return v;
    },
    address() {
      need(32);
      const v = encodeBase58(data.subarray(at, at + 32));
      at += 32;
      return v;
    },
    text() {
      const n = this.u32();
      need(n);
      const v = fromUtf8(data.subarray(at, at + n));
      at += n;
      return v;
    },
  };
}

function readAttributes(data, offset) {
  const r = reader(data, offset + 1);
  const out = {};
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const key = r.text();
    out[key] = r.text();
  }
  return out;
}

/** Decode a Core AssetV1: { owner, collection, name, uri, attributes, frozen, soulbound }. */
export function parseCoreAsset(data) {
  if (data[0] !== ASSET_V1) throw new Error('Not a Core asset');
  const r = reader(data, 1);
  const owner = r.address();
  const authorityKind = r.byte();
  const authority = authorityKind === 0 ? null : r.address();
  const asset = {
    owner,
    collection: authorityKind === UPDATE_AUTHORITY_COLLECTION ? authority : null,
    name: r.text(),
    uri: r.text(),
    attributes: {},
    frozen: false,
    soulbound: false,
  };
  r.skip(data[r.at] === 1 ? 9 : 1); // seq: Option<u64>
  if (r.at >= data.length || data[r.at] !== PLUGIN_HEADER) return asset;
  r.skip(1);
  const registry = reader(data, Number(r.u64()) + 1);
  const plugins = registry.u32();
  for (let i = 0; i < plugins; i++) {
    const type = registry.byte();
    if (registry.byte() === 3) registry.skip(32);
    const offset = Number(registry.u64());
    if (type === PLUGIN.Attributes) asset.attributes = readAttributes(data, offset);
    if (type === PLUGIN.PermanentFreezeDelegate) asset.soulbound = data[offset + 1] === 1;
    if (type === PLUGIN.FreezeDelegate) asset.frozen ||= data[offset + 1] === 1;
  }
  asset.frozen ||= asset.soulbound;
  return asset;
}

/** Decode the start of a Core CollectionV1: { updateAuthority, name, uri, numMinted, currentSize }. */
export function parseCoreCollection(data) {
  if (data[0] !== COLLECTION_V1) throw new Error('Not a Core collection');
  const r = reader(data, 1);
  const updateAuthority = r.address();
  const name = r.text();
  const uri = r.text();
  return { updateAuthority, name, uri, numMinted: r.u32(), currentSize: r.u32() };
}

/** getProgramAccounts filters for Core assets owned by `owner` in `collection` (no indexer needed). */
export const ownedAssetFilters = (owner, collection) => [
  { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(ASSET_V1)) } },
  { memcmp: { offset: 1, bytes: owner } },
  { memcmp: { offset: 33, bytes: encodeBase58(Uint8Array.of(UPDATE_AUTHORITY_COLLECTION)) } },
  { memcmp: { offset: 34, bytes: collection } },
];
