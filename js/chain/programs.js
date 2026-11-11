// Instructions for the built-in programs, as plain data. An instruction is
//   { programId: base58, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array }
// shared by browser apps and Node, which both serialize it with chain/tx.js.
import { addressBytes } from './base58.js';
import { concat, readUintLE, uintLE } from './bytes.js';
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
export const requestHeapFrame = bytes => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: concat(Uint8Array.of(REQUEST_HEAP_FRAME), uintLE(bytes, 4)),
});

export const computeUnitLimit = units => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: concat(Uint8Array.of(SET_COMPUTE_UNIT_LIMIT), uintLE(units, 4)),
});

export const computeUnitPrice = microLamports => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: concat(Uint8Array.of(SET_COMPUTE_UNIT_PRICE), uintLE(microLamports, 8)),
});

/** Whether `ix` sets the transaction's compute unit limit. */
export const isComputeUnitLimit = ix =>
  ix.programId === COMPUTE_BUDGET_PROGRAM && ix.data[0] === SET_COMPUTE_UNIT_LIMIT;

/** Whether `ix` sets the transaction's compute unit price (its priority fee). */
export const isComputeUnitPrice = ix =>
  ix.programId === COMPUTE_BUDGET_PROGRAM && ix.data[0] === SET_COMPUTE_UNIT_PRICE;

/** The compute units a transaction has for each instruction when it sets no limit, and the most it may ask for. */
const DEFAULT_UNITS_AN_INSTRUCTION = 200_000n;
const MOST_UNITS = 1_400_000n;
const MICRO_LAMPORTS = 1_000_000n;

/**
 * `instructions` led by the transaction's Compute Budget instructions: its unit limit, its unit price, then any other
 * (a heap frame). A limit or a price it already carries is kept as it is; the one it lacks is added (`units`,
 * `microLamports` a unit). The rest keep their order.
 *
 * A wallet that adds its own priority fee (Phantom does) adds it only to a transaction that sets neither, so one
 * built this way comes back from the wallet with the message it was given.
 */
export function withComputeBudget(instructions, { units, microLamports }) {
  const budget = instructions.filter(ix => ix.programId === COMPUTE_BUDGET_PROGRAM);
  const limits = budget.filter(isComputeUnitLimit);
  const prices = budget.filter(isComputeUnitPrice);
  return [
    ...(limits.length ? limits : [computeUnitLimit(units)]),
    ...(prices.length ? prices : [computeUnitPrice(microLamports)]),
    ...budget.filter(ix => !isComputeUnitLimit(ix) && !isComputeUnitPrice(ix)),
    ...instructions.filter(ix => ix.programId !== COMPUTE_BUDGET_PROGRAM),
  ];
}

/**
 * The priority fee of a transaction of `instructions`, in lamports: its unit limit times its unit price (in
 * micro-lamports a unit), rounded up to a whole lamport as the network does. 0n when it sets no price. With no limit
 * set, the limit is taken at its most: 200,000 units for each other instruction, 1,400,000 at most.
 */
export function priorityFee(instructions) {
  const price = instructions.find(isComputeUnitPrice);
  if (!price) return 0n;
  const limit = instructions.find(isComputeUnitLimit);
  const others = BigInt(instructions.filter(ix => ix.programId !== COMPUTE_BUDGET_PROGRAM).length);
  const byDefault = DEFAULT_UNITS_AN_INSTRUCTION * others;
  const units = limit ? readUintLE(limit.data, 1, 4) : byDefault < MOST_UNITS ? byDefault : MOST_UNITS;
  return (units * readUintLE(price.data, 1, 8) + MICRO_LAMPORTS - 1n) / MICRO_LAMPORTS;
}

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

export const syncNative = account => ({
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
  const budget = instructions.filter(ix => ix.programId === COMPUTE_BUDGET_PROGRAM);
  const rest = instructions.filter(ix => ix.programId !== COMPUTE_BUDGET_PROGRAM);
  return [
    ...budget,
    createAssociatedTokenAccountIdempotent(player, player, NATIVE_MINT),
    transferLamports(player, wrapped, price),
    syncNative(wrapped),
    ...rest,
    closeTokenAccount(wrapped, player, player),
  ];
}
