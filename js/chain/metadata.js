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
 * The mint is listed read-only: this path of Token Metadata writes nothing to a mint that exists. That is the
 * program's behaviour, not a lock: in a setup's own transaction the mint is writable all the same (the same
 * transaction makes it), so the tests read its supply and authorities back after the record is made. The record says
 * a fungible token whatever the decimals (CreateMetadataAccountV3 would call one of 0 decimals an asset, which
 * wallets list with collectibles).
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

const UPDATE_V2 = 15;
/**
 * Token Metadata's UpdateMetadataAccountV2 for a fungible token's record: a new name, ticker and link ('' for none),
 * all three written as given. `authority` is the record's update authority (for a token a setup made: the project's
 * owner) and signs; it stays the update authority, and the record stays changeable. The record's words are written
 * whole, with no royalty, creators, collection or uses: as a record a setup made has them. One that was given any of
 * those outside these tools would lose them (or refuse the write), so the approval sends this only to a record that
 * has none (`parseRecord`'s `plain`; approve/live-check.mjs readRenames). The mint is untouched, and it costs only the
 * transaction: the record keeps its size.
 */
export function updateFungibleMetadataIx({ mint, authority, name, symbol, uri = '' }) {
  for (const [field, value] of Object.entries({ name, symbol, uri })) {
    if (typeof value !== 'string') throw new TypeError(`A token's ${field} is text`);
    if (utf8(value).length > METADATA_LIMITS[field])
      throw new RangeError(`A token's ${field} is at most ${METADATA_LIMITS[field]} bytes`);
  }
  return {
    programId: METAPLEX_METADATA_PROGRAM,
    keys: [meta(metadataAddress(mint), false, true), meta(authority, true, false)],
    data: concat(
      Uint8Array.of(UPDATE_V2),
      Uint8Array.of(1), // new data
      text(name),
      text(symbol),
      text(uri),
      uintLE(0, 2), // no resale royalty
      NONE, // no creators
      NONE, // no collection
      NONE, // no uses
      NONE, // the update authority: as it is
      NONE, // primary sale: as it is
      NONE, // changeable: as it is
    ),
  };
}

/**
 * A Token Metadata record as the chain holds it, or null when the data is not one (its first byte says a metadata
 * record; the strings are padded with NULs to their full length):
 * { updateAuthority, mint, name, symbol, uri, royalty, creators, mutable, collection, uses, plain }.
 * `royalty`: its resale royalty, in hundredths of a percent. `creators`: how many it lists. `mutable`: its update
 * authority can still change it. `collection`, `uses`: whether it names one. `plain`: none of royalty, creators,
 * collection or uses, as a setup's own record is: writing its words again changes nothing else of it.
 */
export function parseRecord(data) {
  try {
    if (!data || data.length < 1 + 32 + 32 + 12 || data[0] !== 4) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 65;
    const words = [];
    for (let i = 0; i < 3; i++) {
      const length = view.getUint32(at, true);
      if (at + 4 + length > data.length) return null;
      words.push(new TextDecoder().decode(data.subarray(at + 4, at + 4 + length)).replaceAll('\0', ''));
      at += 4 + length;
    }
    if (at + 3 > data.length) return null;
    const royalty = view.getUint16(at, true);
    at += 2;
    let creators = 0;
    if (data[at++] === 1) {
      creators = view.getUint32(at, true);
      at += 4 + 34 * creators;
    }
    if (at + 2 > data.length) return null;
    const mutable = data[at + 1] === 1;
    at += 2; // sold once, and whether it can be changed
    // What follows is each there or not (a byte), with its value when it is: the edition's nonce, the token's standard,
    // then the collection (verified, and its address) and the uses (a method and two counts). A record cut short
    // before them names neither.
    for (let i = 0; i < 2 && at < data.length; i++) at += data[at] === 1 ? 2 : 1;
    const collection = at < data.length && data[at] === 1;
    at += collection ? 34 : 1;
    const uses = at < data.length && data[at] === 1;
    return {
      updateAuthority: encodeBase58(data.subarray(1, 33)),
      mint: encodeBase58(data.subarray(33, 65)),
      name: words[0],
      symbol: words[1],
      uri: words[2],
      royalty,
      creators,
      mutable,
      collection,
      uses,
      plain: royalty === 0 && creators === 0 && !collection && !uses,
    };
  } catch {
    return null;
  }
}

/** The update authority a Token Metadata record names (who can change its name, ticker and link). */
export const metadataUpdateAuthority = data => (data?.length >= 33 ? encodeBase58(data.subarray(1, 33)) : null);
