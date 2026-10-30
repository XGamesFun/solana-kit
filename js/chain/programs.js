// Instructions for the built-in programs, as plain data. An instruction is
//   { programId: base58, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array }
// shared by browser apps and Node, which both serialize it with chain/tx.js.
import { addressBytes } from './base58.js';
import { concat, uintLE } from './bytes.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  COMPUTE_BUDGET_PROGRAM,
  NATIVE_MINT,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './pda.js';

const SYSTEM_TRANSFER = 2;
const REQUEST_HEAP_FRAME = 1;
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const ATA_CREATE_IDEMPOTENT = 1;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_SYNC_NATIVE = 17;

/** An account as an instruction lists it. */
export const meta = (pubkey, isSigner, isWritable) => {
  addressBytes(pubkey);
  return { pubkey, isSigner, isWritable };
};

export function transferLamports(from, to, lamports) {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [meta(from, true, true), meta(to, false, true)],
    data: concat(uintLE(SYSTEM_TRANSFER, 4), uintLE(lamports, 8)),
  };
}

/** Compute Budget `RequestHeapFrame`: the transaction's programs get a heap of `bytes` (a multiple of 1 KiB, 32 KiB to 256 KiB). */
export const requestHeapFrame = (bytes) => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: concat(Uint8Array.of(REQUEST_HEAP_FRAME), uintLE(bytes, 4)),
});

export const computeUnitLimit = (units) => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: concat(Uint8Array.of(SET_COMPUTE_UNIT_LIMIT), uintLE(units, 4)),
});

export const computeUnitPrice = (microLamports) => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: concat(Uint8Array.of(SET_COMPUTE_UNIT_PRICE), uintLE(microLamports, 8)),
});

/** Create `owner`'s token account for `mint` unless it already exists; `payer` pays the rent. */
export function createAssociatedTokenAccountIdempotent(payer, owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      meta(payer, true, true),
      meta(associatedTokenAddress(owner, mint, tokenProgram), false, true),
      meta(owner, false, false),
      meta(mint, false, false),
      meta(SYSTEM_PROGRAM, false, false),
      meta(tokenProgram, false, false),
    ],
    data: Uint8Array.of(ATA_CREATE_IDEMPOTENT),
  };
}

export const syncNative = (account) => ({
  programId: TOKEN_PROGRAM,
  keys: [meta(account, false, true)],
  data: Uint8Array.of(TOKEN_SYNC_NATIVE),
});

export const closeTokenAccount = (account, destination, owner) => ({
  programId: TOKEN_PROGRAM,
  keys: [meta(account, false, true), meta(destination, false, true), meta(owner, true, false)],
  data: Uint8Array.of(TOKEN_CLOSE_ACCOUNT),
});

/**
 * A purchase from a shop priced in SOL: wrap exactly the price into the player's wrapped-SOL account first and close
 * that account after, so the player pays and keeps plain SOL. Other mints pass through. Compute-budget instructions
 * stay in front.
 */
export function withSolWrap(player, mint, price, instructions) {
  if (mint !== NATIVE_MINT) return instructions;
  const wrapped = associatedTokenAddress(player, NATIVE_MINT);
  const budget = instructions.filter((ix) => ix.programId === COMPUTE_BUDGET_PROGRAM);
  const rest = instructions.filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM);
  return [
    ...budget,
    createAssociatedTokenAccountIdempotent(player, player, NATIVE_MINT),
    transferLamports(player, wrapped, price),
    syncNative(wrapped),
    ...rest,
    closeTokenAccount(wrapped, player, player),
  ];
}
