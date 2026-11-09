// Instructions in @solana/kit's shape. The builders here return { programId, keys, data } (the shape of
// @solana/web3.js 1.x, which js/chain/tx.js compiles); an app built on @solana/kit takes { programAddress, accounts,
// data } instead, with each account's role as a number. These convert one to the other, with no dependency on Kit.

/** @solana/kit's AccountRole: bit 1 is a signer, bit 0 is writable. */
export const KIT_ACCOUNT_ROLE = Object.freeze({ READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 });

/**
 * One instruction from a builder here, as @solana/kit takes it: `appendTransactionMessageInstruction(toKitInstruction(ix), m)`.
 * @param {{ programId: string, keys: { pubkey: string, isSigner: boolean, isWritable: boolean }[], data: Uint8Array }} ix
 * @returns {{ programAddress: string, accounts: { address: string, role: number }[], data: Uint8Array }}
 */
export function toKitInstruction(ix) {
  return {
    programAddress: ix.programId,
    accounts: ix.keys.map(k => ({ address: k.pubkey, role: (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0) })),
    data: ix.data,
  };
}

/**
 * A @solana/kit instruction in the shape this package's transactions take (js/chain/tx.js, js/play).
 * @param {{ programAddress: string, accounts?: { address: string, role: number }[], data?: Uint8Array }} ix
 * @returns {{ programId: string, keys: { pubkey: string, isSigner: boolean, isWritable: boolean }[], data: Uint8Array }}
 */
export function fromKitInstruction(ix) {
  return {
    programId: ix.programAddress,
    keys: (ix.accounts ?? []).map(a => ({
      pubkey: a.address,
      isSigner: (a.role & 2) !== 0,
      isWritable: (a.role & 1) !== 0,
    })),
    data: ix.data ?? new Uint8Array(),
  };
}
