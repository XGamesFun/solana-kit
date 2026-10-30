// Program-derived addresses and associated token accounts, derived exactly as `PublicKey.findProgramAddressSync`
// derives them.
import { addressBytes, encodeBase58 } from './base58.js';
import { concat, utf8 } from './bytes.js';
import { isOnCurve } from './curve.js';
import { sha256 } from './sha256.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** Metaplex Core: the program of Core assets and collections. */
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
export const SYSVAR_SLOT_HASHES = 'SysvarS1otHashes111111111111111111111111111';
/** Wrapped SOL: a shop priced in SOL holds this mint, and players pay plain SOL. */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

const MARKER = utf8('ProgramDerivedAddress');
const MAX_SEED_BYTES = 32;
const MAX_SEEDS = 16;

/** The address for these seeds (bump included), or null when it lands on the curve (not a valid PDA). */
export function createProgramAddress(seeds, programId) {
  if (seeds.length > MAX_SEEDS || seeds.some((s) => s.length > MAX_SEED_BYTES)) throw new Error('Invalid PDA seeds');
  const hash = sha256(concat(...seeds, addressBytes(programId), MARKER));
  return isOnCurve(hash) ? null : encodeBase58(hash);
}

/** Addresses found already: the curve check is slow in plain BigInt, and the same few PDAs are asked for again. */
const found = new Map();

/** The canonical PDA and its bump: the highest bump whose address is off the curve. */
export function findProgramAddress(seeds, programId) {
  const key = `${programId}:${seeds.map((s) => Array.from(s).join(',')).join('|')}`;
  if (found.has(key)) return found.get(key);
  for (let bump = 255; bump >= 0; bump--) {
    const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (address) {
      if (found.size >= 20_000) found.clear();
      found.set(key, [address, bump]);
      return [address, bump];
    }
  }
  throw new Error('No program address for these seeds');
}

/** The PDA address alone. */
export const pdaOf = (seeds, programId) => findProgramAddress(seeds, programId)[0];

/** `owner`'s associated token account for `mint` (the owner may itself be a PDA). */
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return pdaOf([addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)], ASSOCIATED_TOKEN_PROGRAM);
}

/**
 * The address System's `CreateAccountWithSeed` makes from `base`, a `seed` text (32 bytes at most) and the program that
 * will own it: sha256(base | seed | owner). Only `base` signs for it, so no new key is needed.
 */
export function addressWithSeed(base, seed, owner) {
  const bytes = utf8(seed);
  if (bytes.length > MAX_SEED_BYTES) throw new Error('A seed is 32 bytes at most');
  return encodeBase58(sha256(concat(addressBytes(base), bytes, addressBytes(owner))));
}
