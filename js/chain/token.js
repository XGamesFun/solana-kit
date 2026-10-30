// The System and SPL Token instructions a project's setup needs (a new mint, its first tokens, handing its authority to
// the project), as plain data. Classic Token and Token-2022 share these layouts.
import { addressBytes } from './base58.js';
import { concat, uintLE, utf8 } from './bytes.js';
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from './pda.js';
import { meta } from './programs.js';

/** A classic mint's size. */
export const MINT_BYTES = 82;
/** A classic token account's size. */
export const TOKEN_ACCOUNT_BYTES = 165;

/** System `CreateAccount`: `from` pays `lamports` for `space` bytes at `address` (which signs), owned by `owner`. */
export function createAccountIx({ from, address, lamports, space, owner }) {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [meta(from, true, true), meta(address, true, true)],
    data: concat(uintLE(0, 4), uintLE(lamports, 8), uintLE(space, 8), addressBytes(owner)),
  };
}

/**
 * System `CreateAccountWithSeed`: `from` pays `lamports` for `space` bytes at `addressWithSeed(from, seed, owner)`, owned
 * by `owner`. `from` is the base too, so it alone signs.
 */
export function createAccountWithSeedIx({ from, address, seed, lamports, space, owner }) {
  const text = utf8(seed);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [meta(from, true, true), meta(address, false, true)],
    data: concat(uintLE(3, 4), addressBytes(from), uintLE(text.length, 8), text, uintLE(lamports, 8), uintLE(space, 8), addressBytes(owner)),
  };
}

/**
 * System `AllocateWithSeed`: the account at `addressWithSeed(base, seed, owner)`, which holds only lamports (System's, no
 * data), gets `space` bytes and becomes `owner`'s. `base` alone signs. Unlike `CreateAccountWithSeed` it takes an address
 * someone already sent lamports to; whoever pays tops it up to the rent first (a System transfer).
 */
export function allocateWithSeedIx({ base, address, seed, space, owner }) {
  const text = utf8(seed);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [meta(address, false, true), meta(base, true, false)],
    data: concat(uintLE(9, 4), addressBytes(base), uintLE(text.length, 8), text, uintLE(space, 8), addressBytes(owner)),
  };
}

/** Token `InitializeAccount3`: `account` (made empty first) becomes a token account of `mint` that `owner` holds. */
export const initializeAccount3Ix = ({ account, mint, owner, tokenProgram = TOKEN_PROGRAM }) => ({
  programId: tokenProgram,
  keys: [meta(account, false, true), meta(mint, false, false)],
  data: concat(Uint8Array.of(18), addressBytes(owner)),
});

/** Token `InitializeMint2`. */
export function initializeMint2Ix({ mint, decimals, authority, freezeAuthority = null, tokenProgram = TOKEN_PROGRAM }) {
  const freeze = freezeAuthority ? concat(Uint8Array.of(1), addressBytes(freezeAuthority)) : Uint8Array.of(0);
  return {
    programId: tokenProgram,
    keys: [meta(mint, false, true)],
    data: concat(Uint8Array.of(20, decimals), addressBytes(authority), freeze),
  };
}

/** Token `MintTo`: `authority` (the mint authority, which signs) mints `amount` into the token account `to`. */
export const mintToIx = ({ mint, to, authority, amount, tokenProgram = TOKEN_PROGRAM }) => ({
  programId: tokenProgram,
  keys: [meta(mint, false, true), meta(to, false, true), meta(authority, true, false)],
  data: concat(Uint8Array.of(7), uintLE(amount, 8)),
});

/** Token `TransferChecked`. */
export const transferCheckedIx = ({ from, mint, to, owner, amount, decimals, tokenProgram = TOKEN_PROGRAM }) => ({
  programId: tokenProgram,
  keys: [meta(from, false, true), meta(mint, false, false), meta(to, false, true), meta(owner, true, false)],
  data: concat(Uint8Array.of(12), uintLE(amount, 8), Uint8Array.of(decimals)),
});

/** Token `SetAuthority` of a mint's minting (`kind` 0) or freezing (1) to `newAuthority` (null: none). */
export const setAuthorityIx = ({ account, current, kind = 0, newAuthority, tokenProgram = TOKEN_PROGRAM }) => ({
  programId: tokenProgram,
  keys: [meta(account, false, true), meta(current, true, false)],
  data: concat(Uint8Array.of(6, kind), newAuthority ? concat(Uint8Array.of(1), addressBytes(newAuthority)) : Uint8Array.of(0)),
});
