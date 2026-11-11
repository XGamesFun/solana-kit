// A token's name on chain: its Token Metadata record (Metaplex), where wallets and explorers read a classic SPL
// token's name, ticker and picture link. Only what a setup needs: the record of a fungible token whose mint is made
// already. Token Metadata takes it only from the mint's authority, so it is made while that authority can still sign:
// once minting is handed on or turned off, no record can ever be made for the mint.
import { addressBytes, encodeBase58 } from './base58.js';
import { concat, uintLE, utf8 } from './bytes.js';
import { METAPLEX_METADATA_PROGRAM, pdaOf, SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM } from './pda.js';
import { meta } from './programs.js';

/** A record's size: Token Metadata pads every one to it, whatever its name, ticker and link. */
export const METADATA_BYTES = 607;
/** What Token Metadata keeps in each record it makes, on top of the record's rent: its own fee. */
export const METADATA_FEE = 10_000_000n;
/** The longest name, ticker and link a record takes, in UTF-8 bytes. */
export const METADATA_LIMITS = Object.freeze({ name: 32, symbol: 10, uri: 200 });

const CREATE = 42;
const CREATE_V1 = 0;
const FUNGIBLE = 2;
const NONE = Uint8Array.of(0);
const text = s => concat(uintLE(utf8(s).length, 4), utf8(s));

/** The address of a mint's Token Metadata record. */
export const metadataAddress = mint =>
  pdaOf([utf8('metadata'), addressBytes(METAPLEX_METADATA_PROGRAM), addressBytes(mint)], METAPLEX_METADATA_PROGRAM);

/**
 * Token Metadata's CreateV1 for a fungible token whose mint exists: its name, its ticker and a link to a JSON file with
 * its picture ('' for none). `authority` is the mint's authority and signs; it becomes the record's update authority,
 * the only one who can change the record later. `payer` pays its rent and Token Metadata's fee (`METADATA_FEE`).
 * The mint is passed read-only, so the instruction can't touch its supply or its authorities. The record says a
 * fungible token whatever the decimals (CreateMetadataAccountV3 would call one of 0 decimals an asset, which wallets
 * list with collectibles).
 */
export function createFungibleMetadataIx({ mint, authority, payer = authority, name, symbol, uri = '' }) {
  for (const [field, value] of Object.entries({ name, symbol, uri })) {
    if (typeof value !== 'string') throw new TypeError(`A token's ${field} is text`);
    if (utf8(value).length > METADATA_LIMITS[field])
      throw new RangeError(`A token's ${field} is at most ${METADATA_LIMITS[field]} bytes`);
  }
  return {
    programId: METAPLEX_METADATA_PROGRAM,
    keys: [
      meta(metadataAddress(mint), false, true),
      meta(METAPLEX_METADATA_PROGRAM, false, false), // no edition: a fungible token has none
      meta(mint, false, false),
      meta(authority, true, false),
      meta(payer, true, true),
      meta(authority, true, false), // the update authority
      meta(SYSTEM_PROGRAM, false, false),
      meta(SYSVAR_INSTRUCTIONS, false, false),
      meta(TOKEN_PROGRAM, false, false),
    ],
    data: concat(
      Uint8Array.of(CREATE, CREATE_V1),
      text(name),
      text(symbol),
      text(uri),
      uintLE(0, 2), // no resale royalty
      NONE, // no creators
      Uint8Array.of(0, 1), // no primary sale yet; the record can be changed
      Uint8Array.of(FUNGIBLE),
      NONE, // no collection
      NONE, // no uses
      NONE, // no collection details
      NONE, // no rule set
      NONE, // decimals: the mint's own
      NONE, // no print supply
    ),
  };
}

/** The update authority a Token Metadata record names (who can change its name, ticker and link). */
export const metadataUpdateAuthority = data => (data?.length >= 33 ? encodeBase58(data.subarray(1, 33)) : null);
