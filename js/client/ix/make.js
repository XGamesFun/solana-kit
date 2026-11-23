// Collectibles: what the authority makes, rewrites or burns.
import { meta } from '../../chain/programs.js';
import { MPL_CORE_PROGRAM, pda } from '../pda.js';
import { lootIx, reference } from './base.js';
import { prizeMetas } from './tail.js';

// ---------------------------------------------------------------- make: collectibles

/**
 * The authority rewrites or burns a collectible, or writes a wallet's profile. `change`: { Set: [attributes] }, 'Burn'
 * (`owner`: whoever holds it, who gets its rent) or { Profile: [attributes] } (`asset` the wallet). `collection`: for a
 * Burn the project's; for a Set the asset's own (`MPL_CORE_PROGRAM` for one in none). `hasAuthority` false for a `Set`
 * on an NFT the project has no authority over (a Core asset of another collection, or a Token Metadata NFT's mint):
 * what it writes goes in the NFT's Sheet, or on the NFT itself when its Attributes plugin names the project. A `Make`
 * goes to `makeIx`.
 */
export function collectibleIx({
  authority,
  project,
  collection,
  asset,
  change,
  owner = null,
  hasAuthority = true,
  reference: ref,
  ...make
}) {
  if (change.Make)
    return makeIx({ authority, project, ...change.Make, ...make, owners: make.owners ?? [owner], reference: ref });
  const sheet =
    change.Set && !hasAuthority ? pda.sheet(project, asset) : change.Profile ? pda.profile(project, asset) : null;
  const burn = change === 'Burn' || Boolean(change.Burn);
  return lootIx(
    'collectible',
    { change, reference: reference(ref) },
    { authority, project, collection, asset, owner: burn ? owner : null, sheet },
    { writable: change.Set || change.Profile || collection === MPL_CORE_PROGRAM ? [] : ['collection'] },
  );
}

/** The program's own keys on a collectible (`asset::FIXED`): which item it is. A make never writes them. */
const FIXED_KEYS = ['item_id', 'rarity', 'serial'];

/**
 * The attributes a make writes, as the program patches them onto nothing (`write_attributes`): the program's own keys
 * dropped, a repeated key once with its last value, an empty value taking the key off.
 */
export function madeAttributes(attributes = []) {
  const out = [];
  for (const a of attributes) {
    if (FIXED_KEYS.includes(a.key)) continue;
    const at = out.findIndex(x => x.key === a.key);
    if (a.value === '') {
      if (at >= 0) out.splice(at, 1);
    } else if (at >= 0) out[at] = a;
    else out.push(a);
  }
  return out;
}

/**
 * The authority makes one of item `item` (`itemState`: its decoded Item, for its collection and next serial) for each
 * of `owners`, in serial order (an owner may come more than once), with `attributes` written over the program's own: a
 * collectible at `pda.itemAsset(item, serial)` (`madeAssets` says which), or with `tree`, a compressed NFT minted into
 * that tree of the project's, whose attributes go in its Sheet (`["sheet", project, asset id]`, after its 9 prize
 * accounts): `treeMinted` is how many the tree has minted, so the first is `pda.compressedAsset(tree, treeMinted)`. A
 * switched-off item still makes; one sold out refuses the whole call (`PrizeNotCovered`).
 */
export function makeIx({
  authority,
  project,
  item,
  itemState,
  owners,
  attributes = [],
  tree = null,
  treeMinted,
  reference: ref,
}) {
  if (!itemState)
    throw new Error(
      `a make of item ${item} needs the item (itemState: its decoded Item), for its collection and next serial`,
    );
  if (!owners?.length || owners.some(o => !o)) throw new Error('A make names who gets each one (`owners`).');
  const prize = tree ? { Compressed: { item, tree } } : { Item: [item] };
  // A compressed one with attributes: its Sheet, at the asset id it is minted at.
  const sheets = Boolean(tree) && madeAttributes(attributes).length > 0;
  if (sheets && treeMinted == null)
    throw new Error(
      "A make of compressed NFTs with attributes writes each one's Sheet: pass how many the tree has minted (`treeMinted`).",
    );
  const remaining = owners.flatMap((owner, made) => [
    meta(owner, false, false),
    ...prizeMetas({ project, prize, winner: owner, items: { [item]: itemState }, made }),
    ...(sheets
      ? [meta(pda.sheet(project, pda.compressedAsset(tree, BigInt(treeMinted) + BigInt(made))), false, true)]
      : []),
  ]);
  return lootIx(
    'collectible',
    { change: { Make: { item, tree, attributes } }, reference: reference(ref) },
    { authority, project, collection: itemState.collection, asset: pda.item(project, item), owner: null, sheet: null },
    { remaining, writable: ['collection'] },
  );
}

/** The collectibles a `makeIx` of `count` mints (not compressed): at the item's next serials. */
export const madeAssets = (project, item, itemState, count = 1) =>
  Array.from({ length: count }, (_, k) => pda.itemAsset(pda.item(project, item), Number(itemState.issued) + 1 + k));
