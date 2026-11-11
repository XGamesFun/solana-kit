// NFTs whose collection's controller can take them back, for the tests of a record whose NFT is gone from the project:
// a Core collection the project does not control, whose permanent transfer delegate and permanent burn delegate are
// its controller's (Metaplex Core's own plugins, on the real Core program), an asset of it, and the controller's take
// and burn, which need nobody else's signature. The instructions are plain builders, so a script sends them on devnet
// as they are; the `seizing*` helpers send them on a test world.
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { MPL_CORE_PROGRAM, parseCoreAsset } from '../chain/core.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import { newAddress } from '../sim/chain.mjs';

const str = s => concat(uintLE(utf8(s).length, 4), utf8(s));
/** Core's plugins by their number (`Plugin`). */
const PLUGIN = { PermanentTransferDelegate: 7, PermanentBurnDelegate: 8, BubblegumV2: 15 };
/** A plugin with no fields, managed by `address` (`PluginAuthority::Address`) or by its default authority. */
const plugin = (type, address = null) =>
  concat(Uint8Array.of(type), address ? concat(Uint8Array.of(1, 3), addressBytes(address)) : Uint8Array.of(0));

/**
 * Core's CreateCollectionV2 of a collection `controller` controls: its update authority, and the one address that
 * may move or burn any NFT of it, whoever holds the NFT (a permanent transfer delegate and a permanent burn delegate).
 * `compressed`: it also carries Bubblegum's plugin, so compressed NFTs can be minted into it. The collection signs.
 */
export function seizingCollectionIx({ collection, controller, name = 'Taken Back', compressed = false }) {
  const plugins = [
    ...(compressed ? [plugin(PLUGIN.BubblegumV2)] : []),
    plugin(PLUGIN.PermanentTransferDelegate, controller),
    plugin(PLUGIN.PermanentBurnDelegate, controller),
  ];
  return {
    programId: MPL_CORE_PROGRAM,
    keys: [
      meta(collection, true, true),
      meta(controller, false, false),
      meta(controller, true, true),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    data: concat(
      Uint8Array.of(21),
      str(name),
      str('https://example.invalid/taken-back.json'),
      Uint8Array.of(1),
      uintLE(plugins.length, 4),
      ...plugins,
      Uint8Array.of(0),
    ),
  };
}

/** Core's CreateV2 of an asset of `collection` for `owner`, made by the collection's `controller`. The asset signs. */
export function seizingAssetIx({ asset, collection, controller, owner, name = 'Taken Back #1' }) {
  return {
    programId: MPL_CORE_PROGRAM,
    keys: [
      meta(asset, true, true),
      meta(collection, false, true),
      meta(controller, true, false),
      meta(controller, true, true),
      meta(owner, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
      meta(SYSTEM_PROGRAM, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
    ],
    data: concat(
      Uint8Array.of(20, 0),
      str(name),
      str('https://example.invalid/taken-back/1.json'),
      Uint8Array.of(0, 0),
    ),
  };
}

/** Core's TransferV1 of `asset` to `to`, signed by its collection's permanent transfer delegate alone. */
export function takeBackIx({ asset, collection, controller, to = controller }) {
  return {
    programId: MPL_CORE_PROGRAM,
    keys: [
      meta(asset, false, true),
      meta(collection, false, false),
      meta(controller, true, true),
      meta(controller, true, false),
      meta(to, false, false),
      meta(SYSTEM_PROGRAM, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
    ],
    data: Uint8Array.of(14, 0),
  };
}

/** Core's BurnV1 of `asset`, signed by its collection's permanent burn delegate alone. */
export function burnIx({ asset, collection, controller }) {
  return {
    programId: MPL_CORE_PROGRAM,
    keys: [
      meta(asset, false, true),
      meta(collection, false, true),
      meta(controller, true, true),
      meta(controller, true, false),
      meta(SYSTEM_PROGRAM, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
    ],
    data: Uint8Array.of(12, 0),
  };
}

/** A collection `controller` can take NFTs back out of, on the world `w`. Returns its address. */
export function seizingCollection(w, controller, { compressed = false } = {}) {
  const collection = newAddress(w.random);
  w.chain.send(controller, [seizingCollectionIx({ collection, controller, compressed })]);
  return collection;
}

/** An asset of it for `owner`. Returns its address. */
export function seizingAsset(w, controller, collection, owner) {
  const asset = newAddress(w.random);
  w.chain.send(controller, [seizingAssetIx({ asset, collection, controller, owner })]);
  return asset;
}

/** The controller takes `asset` out of whoever's hands it is in, to `to` (its own wallet by default). */
export const takeBack = (w, controller, collection, asset, to = controller) =>
  w.chain.send(controller, [takeBackIx({ asset, collection, controller, to })]);

/** The controller burns `asset`, whoever holds it. */
export const burn = (w, controller, collection, asset) =>
  w.chain.send(controller, [burnIx({ asset, collection, controller })]);

/** Who holds a Core asset now, or null once it is burned. */
export function coreOwner(w, asset) {
  const data = w.chain.get(asset)?.data;
  return data?.[0] === 1 ? parseCoreAsset(data).owner : null;
}
