// What a token mint is: its program, decimals, supply and authorities, plus a name, ticker and metadata link from
// Metaplex token metadata or Token-2022's metadata extension. Used to link a token a project's owner already has and to
// price a shop in any token (classic SPL or Token-2022: the loot program takes both).
import { encodeBase58 } from './base58.js';
import { fromUtf8, readUintLE } from './bytes.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './pda.js';
import { MINT_BYTES, TOKEN_ACCOUNT_BYTES } from './token.js';

/** Where Token-2022 writes what an account with extensions is (1 a mint, 2 a token account): right after a token
 * account's classic bytes. */
const ACCOUNT_TYPE_OFFSET = TOKEN_ACCOUNT_BYTES;
const ACCOUNT_TYPE_MINT = 1;
const TOKEN_METADATA_EXTENSION = 19;

function option(data, at) {
  return readUintLE(data, at, 4) === 1n ? encodeBase58(data.subarray(at + 4, at + 36)) : null;
}

/** A Borsh string padded with NULs, as Metaplex stores names. */
function paddedString(data, at) {
  const length = Number(readUintLE(data, at, 4));
  if (at + 4 + length > data.length) throw new RangeError('string past the end');
  const value = fromUtf8(data.subarray(at + 4, at + 4 + length)).replaceAll('\0', '').trim();
  return { value, next: at + 4 + length };
}

/** Metaplex token metadata: key, update authority and mint come before name, symbol and uri. */
export function parseMetaplexMetadata(data) {
  const mint = encodeBase58(data.subarray(33, 65));
  const name = paddedString(data, 65);
  const symbol = paddedString(data, name.next);
  const uri = paddedString(data, symbol.next);
  return { mint, name: name.value, symbol: symbol.value, uri: uri.value };
}

/** Token-2022's TokenMetadata extension, if the mint carries one. */
function token2022Metadata(data) {
  if (data.length <= ACCOUNT_TYPE_OFFSET || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return null;
  let at = ACCOUNT_TYPE_OFFSET + 1;
  while (at + 4 <= data.length) {
    const type = Number(readUintLE(data, at, 2));
    const length = Number(readUintLE(data, at + 2, 2));
    at += 4;
    if (type === TOKEN_METADATA_EXTENSION) {
      const name = paddedString(data, at + 64);
      const symbol = paddedString(data, name.next);
      const uri = paddedString(data, symbol.next);
      return { name: name.value, symbol: symbol.value, uri: uri.value };
    }
    if (type === 0) break;
    at += length;
  }
  return null;
}

/**
 * A mint account read: `owner` is the account's program. Returns null when it is not a mint: a classic mint is exactly
 * 82 bytes; a Token-2022 mint is 82 bytes, or longer than a token account with its account type saying mint (a
 * Token-2022 token account with extensions is longer too, and says it is an account).
 * metadataData: the Metaplex metadata account's data, when there is one.
 */
export function parseMint(address, owner, data, metadataData = null) {
  const program = owner === TOKEN_PROGRAM ? 'spl-token' : owner === TOKEN_2022_PROGRAM ? 'token-2022' : null;
  if (!program) return null;
  const mintLayout = data.length === MINT_BYTES || (program === 'token-2022' && data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT);
  if (!mintLayout || data[45] !== 1) return null;
  let meta = null;
  if (metadataData) {
    try {
      const m = parseMetaplexMetadata(metadataData);
      if (m.mint === address) meta = m;
    } catch {
      meta = null;
    }
  }
  if (!meta && program === 'token-2022') {
    try {
      meta = token2022Metadata(data);
    } catch {
      meta = null;
    }
  }
  const native = address === NATIVE_MINT;
  return {
    mint: address,
    program,
    native,
    decimals: data[44],
    supply: readUintLE(data, 36, 8).toString(),
    mintAuthority: option(data, 0),
    freezeAuthority: option(data, 46),
    name: native ? 'Solana' : meta?.name || null,
    symbol: native ? 'SOL' : meta?.symbol || null,
    uri: meta?.uri || null,
  };
}
