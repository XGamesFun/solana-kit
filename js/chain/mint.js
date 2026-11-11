// What a token mint is: its program, decimals, supply and authorities, plus a name, ticker and metadata link from
// Metaplex token metadata or Token-2022's metadata extension. Used to link a token a project's owner already has and to
// price a shop in any token (classic SPL or Token-2022: the loot program takes both).
import { encodeBase58 } from './base58.js';
import { fromUtf8, readUintLE } from './bytes.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './pda.js';
import { MINT_BYTES, TOKEN_ACCOUNT_BYTES } from './token.js';
import { powersOf } from './token2022.js';

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
  const value = fromUtf8(data.subarray(at + 4, at + 4 + length))
    .replaceAll('\0', '')
    .trim();
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
  const mintLayout =
    data.length === MINT_BYTES ||
    (program === 'token-2022' && data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT);
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

/** A ticker as a spec's key: lower case, the letters a key takes, a letter first; null when nothing is left. */
function keyOf(symbol) {
  const key = String(symbol ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32);
  return key || null;
}
/** The first `most` characters of a text (whole characters, not halves of one). */
const clip = (text, most) => [...String(text)].slice(0, most).join('');

/**
 * A token made elsewhere as an economy spec names it: its `tokens` entry (`source: "existing"`), every field read from
 * the chain so nothing is typed in by hand: the mint, its decimals and token program, its name and ticker when it has
 * a name record, and `powers` (token2022.js `powersOf`: what the mint's own keys can do). `account`: the mint's
 * ({ owner, data }); `record`: its Token Metadata record's data, when there is one. `key`: what the spec will call it
 * (default: its ticker in the letters a key takes, else "token"). `project`: the loot project, whose own tokens read
 * `mintAuthority: "project"`. Wrapped SOL is SOL (`{ key: "sol", source: "sol" }`). Null when `account` is no mint.
 */
export function tokenEntry(address, account, record = null, { key = null, project = null } = {}) {
  const mint = account ? parseMint(address, account.owner, account.data, record) : null;
  if (!mint) return null;
  if (mint.native) return { key: key ?? 'sol', source: 'sol' };
  return {
    key: key ?? keyOf(mint.symbol) ?? 'token',
    source: 'existing',
    ...(mint.name ? { name: clip(mint.name, 32) } : {}),
    ...(mint.symbol ? { symbol: clip(mint.symbol, 10) } : {}),
    decimals: mint.decimals,
    program: mint.program,
    mint: mint.mint,
    powers: powersOf(account, { project }),
  };
}
