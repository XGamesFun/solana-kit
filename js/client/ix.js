// Every loot instruction, built from the IDL. An instruction is
//   { programId: base58, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array }
// as chain/tx.js serializes it. Browser-safe, no Solana SDK.
//
// Two layers:
//   - `lootIx(name, args, accounts, options)` builds any instruction from its IDL entry. Accounts are named by their
//     IDL leaf name (snake_case; nested groups such as an order's `checkout` are flattened). Fixed addresses, the
//     platform, the project's fee box, the program's identity and every PDA whose seeds the IDL spells out from other
//     accounts and arguments fill themselves; an optional account left out is passed as the program's own address
//     (Anchor's "None"); anything else missing throws, naming it.
//   - One builder per instruction (`payIx`, `openBoxIx`, …) that also adds the accounts that come after the
//     instruction's own (a split's destinations, a box's entries, a recipe's lines) and sets the few flags a client
//     changes (a mint written only when it burns or mints). They take the decoded account they act on (`accounts.js`)
//     instead of reading the chain, so they are pure.
//
// Values are the IDL's own shapes (`chain/borsh.js`): addresses base58 strings, u64/u128/i64 bigints (or numbers),
// enums 'Variant', { Variant: [values] } or { Variant: { field: value } }, structs with snake_case fields.
//
// The builders are in ix/, one module a part in the order they had here; this file gathers them, so `./ix.js` stays
// the one place to import them from. ix/defs.js and ix/shared.js hold the helpers several parts use: they stay private,
// as this file re-exports neither.
export * from './ix/base.js';
export * from './ix/tail.js';
export * from './ix/settings.js';
export * from './ix/money.js';
export * from './ix/make.js';
export * from './ix/decide.js';
export * from './ix/schedules.js';
export * from './ix/farms.js';
export * from './ix/piece.js';
export * from './ix/recipes.js';
export * from './ix/stashes.js';
export * from './ix/contests.js';
export * from './ix/auctions.js';
export * from './ix/offers.js';
export * from './ix/listings.js';
