// How many bytes a Solana transaction takes, from what is in it, without building it. Pure.
//
// A legacy transaction is: the signatures (a count, then 64 bytes each), a 3-byte header, the account keys (a
// count, then 32 bytes each, every account once), a 32-byte blockhash, and the instructions (a count, then for
// each: its program's index, a count and one byte per account, a length and the data). Counts are compact-u16
// (1 byte below 128, 2 below 16,384).
//
// Why the estimate never comes out smaller than the real transaction:
// - accounts are counted once per distinct name, and two names never stand for one address less often than the
//   real transaction would share them (two names for one address only makes the real one smaller);
// - instruction data is sized byte for byte from the program's IDL (idl.mjs), and other programs' data from their
//   documented layouts at its longest;
// - no address lookup tables are assumed.
// A wallet may add its own compute-budget instructions (a price and a limit: about 52 bytes), so the plan keeps
// WALLET_ROOM free below the network's 1,232-byte limit.

export const MAX_TRANSACTION_BYTES = 1232;
export const WALLET_ROOM = 64;
export const BUDGET = MAX_TRANSACTION_BYTES - WALLET_ROOM;

export const compact = (n) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/**
 * instructions: [{ program: name, accounts: [names], data: bytes }]; signers: [names] (the fee payer first).
 * Returns the estimated wire size in bytes.
 */
export function transactionSize({ instructions, signers }) {
  const keys = new Set(signers);
  for (const ix of instructions) {
    for (const a of ix.accounts) keys.add(a);
    keys.add(`program:${ix.program}`);
  }
  const body = instructions.reduce((n, ix) => n + 1 + compact(ix.accounts.length) + ix.accounts.length + compact(ix.data) + ix.data, 0);
  return compact(signers.length) + 64 * signers.length + 3 + compact(keys.size) + 32 * keys.size + 32 + compact(instructions.length) + body;
}

/** How many accounts the transaction locks: each account once, its programs and signers included. */
export function transactionLocks({ instructions, signers }) {
  const keys = new Set(signers);
  for (const ix of instructions) {
    for (const a of ix.accounts) keys.add(a);
    keys.add(`program:${ix.program}`);
  }
  return keys.size;
}
