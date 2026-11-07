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
import { addressBytes, encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { encodeAccount, encodeInstruction } from '../chain/borsh.js';
import { compareBytes, concat, intLE, readUintLE, toBigInt, uintLE, utf8 } from '../chain/bytes.js';
import { addressWithSeed, ASSOCIATED_TOKEN_PROGRAM, findProgramAddress, METAPLEX_METADATA_PROGRAM, SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, SYSVAR_SLOT_HASHES, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { allocateWithSeedIx, createAccountWithSeedIx, initializeAccount3Ix, MINT_BYTES, TOKEN_ACCOUNT_BYTES } from '../chain/token.js';
import { createAssociatedTokenAccountIdempotent, meta, transferLamports } from '../chain/programs.js';
import { sha256 } from '../chain/sha256.js';
import { MEMO_PROGRAM } from '../chain/token2022.js';
import IDL from './idl/loot.js';
import { chosenAtPurchase, CLAIMED, decode, ENDED, idleRound, nftSlot, ownStash, paymentMint, placesPulled, prizePlacesOwed, roundFinished, roundWinners, shareOf, tokenRun } from './accounts.js';
import { stream, TAG, weighted } from './random.js';
import { tableBudget } from './sizes.js';
import { ata, BUBBLEGUM_PROGRAM, COMPRESSION_PROGRAM, LOOT_PROGRAM, MPL_CORE_PROGRAM, NOOP_PROGRAM, pda, vault, VRF_QUEUE } from './pda.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

export { IDL, ASSOCIATED_TOKEN_PROGRAM };

/** Token Metadata: a legacy NFT's or a pNFT's metadata lives at an address of its (`METAPLEX_METADATA_PROGRAM`). */
export const TOKEN_METADATA_PROGRAM = METAPLEX_METADATA_PROGRAM;

const ZERO_REFERENCE = new Uint8Array(32);
/** The default address: names nobody, and nobody signs as it. */
const NOBODY_KEY = '11111111111111111111111111111111';
const hashToAddress = (hash) => encodeBase58(hash);

/** 32 bytes a project names a call by (a match id, a payout's reason). Zeros when not given. */
export function reference(value) {
  if (value == null) return ZERO_REFERENCE;
  if (typeof value === 'string') return sha256(utf8(value));
  const bytes = Uint8Array.from(value);
  if (bytes.length !== 32) throw new Error('A reference is 32 bytes, or a string that is hashed to 32.');
  return bytes;
}

// ---------------------------------------------------------------- any instruction

const instructionDef = (name) => {
  const def = IDL.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`Unknown loot instruction ${name}`);
  return def;
};

/** The IDL's instructions, the longest tags first: the oracle's three callbacks keep 8-byte tags, every other
 * instruction has a 1-byte one, which the first byte of an 8-byte tag may equal. */
const BY_TAG = [...IDL.instructions].sort((a, b) => b.discriminator.length - a.discriminator.length);

/** The IDL entry of the loot instruction whose data is `data` (its tag first), or null. */
export const instructionOf = (data) => BY_TAG.find((i) => i.discriminator.length <= data.length && i.discriminator.every((b, j) => data[j] === b)) ?? null;

/**
 * An instruction's tail (`tokens::tail`): the accounts every NFT move hands Core (what a check its collection carries
 * reads, an oracle's account) and every token transfer hands a transfer hook, after the route's own. It starts at the
 * Memo program's account, which serves a transfer into an account that requires a memo; with none, it is empty. So
 * `extra` (hook accounts, Core's adapters) goes after the Memo program, which this puts first.
 */
export function tailOf(extra = []) {
  if (!extra.length) return [];
  return [meta(MEMO_PROGRAM, false, false), ...extra.filter((m) => m.pubkey !== MEMO_PROGRAM)];
}

/** The accounts of an instruction in order, each with its group (`checkout`, `fee`, `side`, `piece`) or ''. */
function leaves(list, group = '') {
  return list.flatMap((a) => (a.accounts ? leaves(a.accounts, a.name) : [{ ...a, group }]));
}

/** Accounts that are the same wherever an instruction names them. The program checks each by address, which the
 * IDL doesn't carry. */
const DEFAULTS = {
  platform: () => pda.platform(),
  fees: (known) => known.project && pda.fees(known.project),
  program_identity: () => pda.identity(),
  vrf_program_identity: () => pda.oracleIdentity(),
  oracle_queue: () => VRF_QUEUE,
  slot_hashes: () => SYSVAR_SLOT_HASHES,
  instructions: () => SYSVAR_INSTRUCTIONS,
  program_data: () => pda.programData(),
  token_2022_program: () => TOKEN_2022_PROGRAM,
  mpl_core_program: () => MPL_CORE_PROGRAM,
  item_core_program: () => MPL_CORE_PROGRAM,
  token_metadata_program: () => TOKEN_METADATA_PROGRAM,
  bubblegum_program: () => BUBBLEGUM_PROGRAM,
  compression_program: () => COMPRESSION_PROGRAM,
  log_wrapper: () => NOOP_PROGRAM,
};

const SEED_SIZES = { u8: 1, u16: 2, u32: 4, u64: 8 };

/** The bytes of one IDL seed, or null when it can't be had from what is known (it reads an account's data). */
function seedBytes(seed, known, args, def) {
  if (seed.kind === 'const') return Uint8Array.from(seed.value);
  if (seed.kind === 'arg') {
    const arg = def.args.find((a) => a.name === seed.path);
    if (!arg || !(seed.path in args)) return null;
    if (arg.type === 'pubkey') return addressBytes(args[seed.path]);
    if (SEED_SIZES[arg.type]) return uintLE(args[seed.path], SEED_SIZES[arg.type]);
    return null;
  }
  if (seed.kind === 'account') {
    // "side.farm" names the account `farm` of the group `side`; a path into an account's data ("order.requested_slot")
    // can't be resolved here.
    const parts = seed.path.split('.');
    const groups = new Set(def.accounts.filter((a) => a.accounts).map((a) => a.name));
    const name = parts.length === 1 ? parts[0] : groups.has(parts[0]) && parts.length === 2 ? parts[1] : null;
    return name && known[name] ? addressBytes(known[name]) : null;
  }
  return null;
}

/**
 * Any loot instruction. `accounts` names accounts by their IDL leaf name; `null` for an optional one passes "None".
 * Options: `remaining` (metas after the instruction's own), `writable` and `signer` (leaf names whose flag is set
 * on, beyond the IDL's), `readonly` (leaf names whose writable flag is set off).
 */
export function lootIx(name, args = {}, accounts = {}, { remaining = [], writable = [], signer = [], readonly = [] } = {}) {
  const def = instructionDef(name);
  const list = leaves(def.accounts);
  const known = {};
  for (const a of list) {
    if (accounts[a.name] !== undefined) known[a.name] = accounts[a.name];
    else if (a.address) known[a.name] = a.address;
  }
  // Defaults and PDAs, until nothing more resolves (a PDA's seeds may name an account derived the same way).
  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    for (const a of list) {
      if (a.name in known) continue;
      const fallback = DEFAULTS[a.name]?.(known);
      if (fallback) {
        known[a.name] = fallback;
        progress = true;
        continue;
      }
      if (a.pda && !a.pda.program) {
        const seeds = a.pda.seeds.map((s) => seedBytes(s, known, args, def));
        if (seeds.every(Boolean)) {
          known[a.name] = findProgramAddress(seeds, LOOT_PROGRAM)[0];
          progress = true;
        }
      }
    }
    if (!progress) break;
  }
  const keys = list.map((a) => {
    const key = known[a.name];
    if (key === null || (key === undefined && a.optional)) {
      if (!a.optional) throw new Error(`${name}: ${a.name} is not optional`);
      return meta(LOOT_PROGRAM, false, false);
    }
    if (key === undefined) throw new Error(`${name}: missing account ${a.group ? `${a.group}.` : ''}${a.name}`);
    const isWritable = (a.writable === true || writable.includes(a.name)) && !readonly.includes(a.name);
    return meta(key, a.signer === true || signer.includes(a.name), isWritable);
  });
  return { programId: LOOT_PROGRAM, keys: [...keys, ...remaining], data: encodeInstruction(IDL, name, args) };
}

// ---------------------------------------------------------------- the accounts after an instruction's own

const tokenProgramOf = (programs, mint) => programs?.[mint] ?? TOKEN_PROGRAM;

/** A wallet, then its associated token account of `mint`: where money owed to it goes. */
const walletAccounts = (wallet, mint, programs) => [meta(wallet, false, false), meta(ata(wallet, mint, tokenProgramOf(programs, mint)), false, true)];

/**
 * The accounts one destination needs, in the order the program reads them: a pool, a named token account, a wallet
 * and its associated token account of `mint` (the project's `treasury` wallet for `Treasury`), or whoever holds a
 * collectible (its asset, then the holder and their associated token account). The program opens a wallet's account
 * or a pool when it is not there, paid by whoever sends the instruction. `holders` maps an asset to its holder now;
 * for one nobody holds, the default address fills the holder's two places. A buyer's choice (`Chosen`) is written as
 * what was chosen first (`chosenShares`).
 */
export function destinationAccounts(project, to, mint, { holders = {}, programs, treasury } = NO_OPTIONS) {
  if (to === 'Burn') return [];
  if (to === 'Treasury') {
    if (!treasury) throw new Error('A treasury share needs the project\'s treasury wallet (pass `treasury`).');
    return walletAccounts(treasury, mint, programs);
  }
  if (to.Pool) return [meta(pda.pool(project, to.Pool[0]), false, true)];
  if (to.Account) return [meta(to.Account[0], false, true)];
  if (to.Wallet) return walletAccounts(to.Wallet[0], mint, programs);
  if (to.Holder) {
    const asset = to.Holder[0];
    const holder = holders[asset];
    return [meta(asset, false, false), ...(holder ? walletAccounts(holder, mint, programs) : [meta(NO_ADDRESS, false, false), meta(NO_ADDRESS, false, false)])];
  }
  if (to.Chosen) return [];
  throw new Error(`Unknown destination ${JSON.stringify(to)}`);
}

/** A split's destinations, in order. */
/** The most shares a split kept to be paid later holds (`MAX_SHARES`, not in the IDL): a box's, a lottery's, a contest's,
 * an auction's, an offer's or a listing's (a ninth is `BadShares`); a payment's own split has no such cap. */
export const MAX_SHARES = 8;
/** `shares`, refused here when a split kept to be paid later holds more than `MAX_SHARES`. */
const stored = (shares = []) => {
  if (shares.length > MAX_SHARES) throw new Error(`A split kept to be paid later holds at most ${MAX_SHARES} shares; this one has ${shares.length} (BadShares).`);
  return shares;
};

/** The most traits a fresh item draws (`MAX_ITEM_TRAITS`, not in the IDL): each is written as its unit is minted, which
 * one transaction must hold. */
export const MAX_ITEM_TRAITS = 64;
/** The longest name a fresh item's trait has, in bytes (`MAX_TRAIT_KEY`, not in the IDL). */
export const MAX_TRAIT_KEY = 64;
/** An item's `traits`, refused here past the program's caps (`BadItem` when the owner signs). */
const traitsInCaps = (traits = []) => {
  if (traits.length > MAX_ITEM_TRAITS) throw new Error(`An item draws at most ${MAX_ITEM_TRAITS} traits; this one draws ${traits.length} (BadItem).`);
  const long = traits.find((t) => utf8(String(t.key)).length > MAX_TRAIT_KEY);
  if (long) throw new Error(`A trait's name is at most ${MAX_TRAIT_KEY} bytes; “${String(long.key).slice(0, 24)}…” is ${utf8(String(long.key)).length} (BadItem).`);
  return traits;
};

export const shareAccounts = (project, shares, mint, options) => shares.flatMap((s) => destinationAccounts(project, s.to, mint, options));

/**
 * A split with the buyer's choice written in, as the program does at `open_box` and `buy_tickets`: a wallet, the
 * holder of the collectible chosen (a share with an item, which needs one), or the treasury with no choice. A
 * contest's decision names its wallet the same way (`decideIx`).
 */
export const chosenShares = (shares, choice) =>
  shares.map((s) => {
    if (!s.to.Chosen) return s;
    if (!choice && s.to.Chosen.item != null) throw new Error('This share pays the holder of a collectible the buyer names: name one (`chosenRecipient`, `chosen`).');
    if (!choice) return { ...s, to: 'Treasury' };
    return { ...s, to: s.to.Chosen.item == null ? { Wallet: [choice] } : { Holder: [choice] } };
  });

/** Whether a split burns, so the mint is written: it has a burn share. */
export const sharesBurn = (shares) => shares.some((s) => s.to === 'Burn');

/**
 * The account each prize of a box's entries comes with at the roll, in entry order and each entry's prizes in order:
 * its item for an item, its pool for tokens from one, its stash for an NFT of one (a named one, or one at random). All
 * written: the roll takes from them. Tokens minted and rolls take none here. A fresh item's tables follow it while
 * they fit the box's table budget (`tableBudget`), walked in entry order; an item whose tables don't fit what is left
 * takes none, and is out of stock for that roll.
 */
export function entryAccounts(project, entries, items = {}) {
  let budget = Math.max(0, tableBudget(entries));
  return entries.flatMap(({ prizes }) => prizes.flatMap((prize) => {
    // An item, compressed or not; a fresh one's tables after it, in the order of its traits (`items` maps an item's id
    // to its decoded Item: one left out is taken as not fresh).
    const id = prize.Item?.[0] ?? prize.Compressed?.item;
    if (id !== undefined) {
      const tables = traitTables(items[id]);
      const fits = tables.length <= budget;
      if (fits) budget -= tables.length;
      return [meta(pda.item(project, id), false, true), ...(fits ? tables : []).map((t) => meta(pda.table(project, t), false, true))];
    }
    if (prize.Tokens?.from.Pool) return [meta(pda.pool(project, prize.Tokens.from.Pool[0]), false, true)];
    const stash = prize.Nft?.stash ?? prize.Stash?.[0];
    return stash === undefined ? [] : [meta(pda.stash(project, stash), false, true)];
  }));
}

/**
 * For each mint a box's tokens are in, in the order their prizes first name them, the mint (written when the roll
 * mints from it) and the project's vault for it, where tokens won wait. `poolMints` maps a pool index to its mint (a
 * pool not opened yet has none and is left out).
 */
export function prizeAccounts(project, entries, poolMints = {}, programs) {
  return prizeMints(entries, poolMints).map(({ mint, minted }) => [meta(mint, false, minted), meta(vault(project, mint, tokenProgramOf(programs, mint)), false, true)]).flat();
}

/** The mints a box's tokens are in, in the order their prizes first name them: { mint, minted }. */
function prizeMints(entries, poolMints = {}) {
  const mints = [];
  for (const prize of entries.flatMap((e) => e.prizes)) {
    const from = prize.Tokens?.from;
    if (!from) continue;
    const mint = from.Mint ? from.Mint[0] : poolMints[from.Pool[0]];
    if (!mint) continue;
    const seen = mints.find((m) => m.mint === mint);
    if (seen) seen.minted ||= Boolean(from.Mint);
    else mints.push({ mint, minted: Boolean(from.Mint) });
  }
  return mints;
}

/** Each pool a box's prizes name, mapped to its mint: `poolMints`'s, or the box's own currency when it isn't given. */
function boxPoolMints(box, poolMints) {
  const pools = box.entries.flatMap((e) => e.prizes.flatMap((p) => (p.Tokens?.from.Pool ? [p.Tokens.from.Pool[0]] : [])));
  return Object.fromEntries(pools.map((pool) => [pool, poolMints && pool in poolMints ? poolMints[pool] : box.currency]));
}

/** Whether a box leaves its outcome to the oracle: more than one entry, or an entry gives a stash's NFT at random. */
export const boxRolls = (entries) => entries.length > 1 || entries.some((e) => e.prizes.some((p) => p.Stash));

/** The tables a fresh item's traits draw from, in the order of its traits (none for an item whose units are alike). */
export const traitTables = (item) => (item?.traits ?? []).flatMap((t) => (t.from?.Table ? [t.from.Table[0]] : []));

/** Whether a box gives a fresh item (one with traits): its units' traits are drawn by the oracle (`items` maps an
 * item's id to its decoded Item, as `entryAccounts`). */
export const boxFresh = (entries, items = {}) => entries.some((e) => e.prizes.some((p) => (items[p.Item?.[0] ?? p.Compressed?.item]?.traits ?? []).length > 0));

/**
 * What one prize a settle hands over may open or mint, at most: a collectible's Core asset with the program's plugins
 * (about 0.004 SOL), a stash's NFT's new token account, a fresh compressed NFT's Sheet, a token account of a mint, the
 * NFT rolled on's numbers or its stash row. A client's own figure (the program keeps no reserve): what a throwaway key
 * that settles is funded with for each, and gives back unspent.
 */
export const SETTLE_RENT_UNIT = 6_000_000n;

/**
 * What a settle of an order of `opens` opens of `box` may open or mint, at most, in lamports: whoever settles pays it
 * (the order lends nothing). For each draw of each open, each prize of the entry with the most of them that opens an
 * account (a collectible, a stash's NFT, a fresh compressed NFT's Sheet: `items` maps an item's id to its decoded
 * Item); once an order, each source of tokens it may pay, and the fate of the NFT it rolls on; one `SETTLE_RENT_UNIT`
 * each. A throwaway key that settles is funded with it, and gives back what it doesn't spend.
 */
export function settleRent(box, opens = 1, items = {}) {
  const rents = (p) => Boolean(p.Item || p.Nft || p.Stash || (p.Compressed && (items[p.Compressed.item]?.traits ?? []).length));
  const most = Math.max(0, ...box.entries.map((e) => e.prizes.filter(rents).length));
  const sources = new Set(box.entries.flatMap((e) => e.prizes.flatMap((p) => (p.Tokens ? [JSON.stringify(p.Tokens.from)] : []))));
  return SETTLE_RENT_UNIT * (BigInt(most * boxDraws(box) * Math.max(1, opens)) + BigInt(sources.size) + (box.subject ? 1n : 0n));
}

/**
 * The nonce the `k`th roll an order won is named by when it settles: the first 8 bytes, little
 * endian, of sha256("roll" | order | its requested slot (u64 LE) | k (u32 LE)). Like every prize's roll, its order is at
 * `prizeRollNonce` of it.
 */
export function rollNonce(order, requestedSlot, k) {
  const hash = sha256(concat(utf8('roll'), addressBytes(order), uintLE(requestedSlot, 8), uintLE(k, 4)));
  return readUintLE(hash, 0, 8);
}

/**
 * The nonce of a roll on an NFT whose box moves its numbers, burns it or gives it away: the first
 * 8 bytes, little endian, of its address. Its player has one such roll open on it at a time: the order's address is
 * taken until it settles or is refunded. `openBoxIx` makes a box's roll on one there; a mission's roll (`unstakeNftIx`)
 * and a recipe's (`craftIx`) take it as their `nonce`.
 */
export const nonceOn = (asset) => readUintLE(addressBytes(asset), 0, 8);

/** Whether a box's roll holds the NFT it rolls on, or moves its numbers: an entry burns it, gives it
 * away or moves its numbers. Its order is at the NFT's nonce (`nonceOn`). */
export const boxHolds = (box) => (box.fates ?? []).some((f) => f.then != null || (f.shifts ?? []).length > 0);

/**
 * The nonce of the order a roll a sender names is made in: a craft's roll on a collectible kept (`RollOn`) and a
 * mission's roll on the NFT leaving it. On an NFT its box holds (`boxHolds`), the NFT's own (`nonceOn`), whatever was
 * named; otherwise `prizeRollNonce` of the named one, so no sender reaches the address of a roll an order won.
 */
export const namedRollNonce = (box, asset, named) => {
  if (!box) throw new Error('A roll on an NFT needs its box, decoded (boxes), to know where its order is made.');
  return boxHolds(box) ? nonceOn(asset) : prizeRollNonce(named);
};

/** Whether a limit for each wallet ({ total, per_window, window }) limits anything. */
const limits = (perWallet) => Boolean(perWallet && (Number(perWallet.total) || Number(perWallet.per_window)));

/**
 * The accounts of an NFT the player shows, for a gate or for odds: right after the instruction's other accounts.
 * `shown` is a Core asset the project has authority over (its address), one it has no authority over (`{ asset }`: then
 * its Sheet's address), a Token Metadata NFT (`{ mint, owner }`: its mint, its metadata, the owner's token account of
 * it, its Sheet's address), or a compressed NFT (`{ compressed: assetId, tree }`: its asset id, its record, which a
 * `proveLeafIx` earlier in the same transaction writes, its tree, and its Sheet's address).
 */
export function shownAccounts(project, shown) {
  if (!shown) return [];
  if (typeof shown === 'string') return [meta(shown, false, false)];
  if (shown.asset) return [meta(shown.asset, false, false), meta(pda.sheet(project, shown.asset), false, false)];
  if (shown.compressed) return [shown.compressed, pda.leaf(shown.compressed), shown.tree, pda.sheet(project, shown.compressed)].map((key) => meta(key, false, false));
  return [shown.mint, tokenMetadata.metadata(shown.mint), ata(shown.owner, shown.mint, TOKEN_PROGRAM), pda.sheet(project, shown.mint)].map((key) => meta(key, false, false));
}

/**
 * What a player passes a gate with, right after an instruction's own accounts: a list's proof (`Gate::List`: its
 * nodes as accounts, from `merkleProof` of `gateListLeaf`s), then an NFT shown (`shownAccounts`) for a gate that reads
 * one, or for a box's odds.
 */
export const gateAccounts = (project, { gate, wallet, shown, listProof = [] } = NO_OPTIONS) => [
  ...listProof.map((node) => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)),
  // A stake gate reads the wallet's token seat in its farm, then the farm (its tiers' locks), where an NFT shown would be.
  ...(gate?.Staked ? [meta(pda.seat(gate.Staked.farm, wallet), false, false), meta(gate.Staked.farm, false, false)] : []),
  ...shownAccounts(project, shown),
];

/**
 * A nonce a prize route names (its `nonce` argument), from what names the prize: a grant, its wallet and rounds, a
 * contest and its player, an auction and its last bid. Any nonce works (the sender picks it); the roll's order
 * is then at `prizeRollNonce` of it (plus the place where the route says so), which no roll on an NFT is at.
 */
export const prizeNonce = (...parts) => {
  const hash = sha256(concat(utf8('loot:prize'), ...parts.map((p) => (typeof p === 'string' ? addressBytes(p) : p instanceof Uint8Array ? p : uintLE(p, 8)))));
  return readUintLE(hash, 0, 8);
};

/**
 * The nonce a roll given as a prize is made at: the first 8 bytes, little endian, of
 * sha256("prize" | n (u64 LE)), `n` the nonce the route names (its argument, plus the place or `k` where it says so).
 * Every roll given as a prize (a grant's, a lottery place's, a contest's, an auction's roll lot, a mission's chest, a
 * recipe's `Prize::Roll`, a box's prize roll) is at `["order", project, winner, prizeRollNonce(n)]`. A roll an order
 * won is made at settle at `rollNonce(order, slot, k)` as it is (hashed under "roll", so no named nonce reaches it). A roll on an NFT (`nonceOn`, a recipe's `RollOn`, a mission's
 * `roll`) and a box's own order are not. Not `prizeNonce`, which makes the `n` a route names from its parts.
 */
export const prizeRollNonce = (n) => {
  // The program adds the place or `k` with `wrapping_add`: the same here.
  const hash = sha256(concat(utf8('prize'), uintLE(BigInt.asUintN(64, toBigInt(n)), 8)));
  return readUintLE(hash, 0, 8);
};

/** The NFT accounts every route takes as a `Piece`, in the program's order, with the writable flags the IDL has. */
const PIECE = leaves(instructionDef('hold').accounts).filter((a) => a.group === 'piece');

/** A `piece`'s accounts as metas, in the program's order: what a prize of an NFT names after its stash. */
function pieceMetas(p) {
  return PIECE.map((a) => {
    const key = p.accounts[a.name];
    if (key == null) return meta(LOOT_PROGRAM, false, false);
    return meta(key, false, a.writable === true || p.writable.includes(a.name));
  });
}

/**
 * The accounts a prize takes after a route's own, given to `winner`:
 *   Tokens  the mint (written when minted), the pool when they come from one, the winner's account of the mint;
 *   Item    the item; for a collectible, its collection (the Item's), its address at the item's next serial, Metaplex Core;
 *   Nft     the stash, the NFT as `piece` takes it, then a compressed NFT's proof;
 *   Roll    the box, then the order its roll is made in, at `prizeRollNonce(nonce)` (what the roll can give is read
 *           when it is asked: `askRollIx`);
 *   Held    the lottery's own stash (`lottery`: the lottery's address), the NFT as `piece` takes it, then its proof.
 * `poolMints` maps a pool's index to its mint (null for a pool never opened, which gives nothing: `projectMint` stands in
 * for its mint); `items` an item's id to its decoded Item (for its next serial; `made`
 * collectibles of the same item already made earlier in the instruction); `nft` the NFT's kind, as `piece` takes it
 * ({ collection, tokenMetadata, compressed }).
 */
export function prizeMetas({ project, collection, prize, winner, nonce = 0n, poolMints = {}, items = {}, nft = {}, made = 0, projectMint, programs, lottery }) {
  if (prize.Tokens) {
    const { from } = prize.Tokens;
    // A pool never opened (its mint given as null) gives nothing: any mint stands in for its place, the project's.
    const pool = from.Pool?.[0];
    const mint = from.Mint ? from.Mint[0] : (poolMints[pool] ?? (pool in poolMints ? projectMint : undefined));
    if (!mint) throw new Error(`a prize from pool ${pool} needs that pool's mint (poolMints; null for a pool never opened, with projectMint)`);
    const pooled = from.Pool ? [meta(pda.pool(project, pool), false, true)] : [];
    return [meta(mint, false, Boolean(from.Mint)), ...pooled, meta(ata(winner, mint, tokenProgramOf(programs, mint)), false, true)];
  }
  if (prize.Item) {
    const id = prize.Item[0];
    const item = items[id];
    if (item === undefined) throw new Error(`a prize of item ${id} needs the item (items: its decoded Item, or null for none written), for its kind and next serial`);
    const address = pda.item(project, id);
    // A normal item, or one never written, is its address alone; a collectible is minted into its own collection.
    if (!item || item.kind !== 'Collectible') return [meta(address, false, true)];
    const serial = Number(item.issued) + 1 + made;
    return [meta(address, false, true), meta(item.collection ?? collection, false, true), meta(pda.itemAsset(address, serial), false, true), meta(MPL_CORE_PROGRAM, false, false)];
  }
  if (prize.Nft) {
    const { stash, nft: asset } = prize.Nft;
    const p = piece({ project, asset, wallet: winner, ...nft, ...ONLY_MOVES });
    return [meta(pda.stash(project, stash), false, true), ...pieceMetas(p), ...p.proof];
  }
  if (prize.Held) {
    // An NFT a lottery's place promises, from that lottery's own stash.
    if (!lottery) throw new Error('A held NFT is a lottery\'s prize: name the lottery (`lottery`, its address).');
    const p = piece({ project, asset: prize.Held[0], wallet: winner, ...nft, ...ONLY_MOVES });
    return [meta(pda.lotteryStash(lottery), false, true), ...pieceMetas(p), ...p.proof];
  }
  if (prize.Stash) throw new Error('A stash\'s NFT at random is a box entry\'s prize only: elsewhere, a roll of a box that gives it.');
  if (prize.Compressed) {
    // A compressed NFT of the item, minted into the project's tree, in the item's collection.
    const { item: id, tree } = prize.Compressed;
    const item = items[id];
    if (!item) throw new Error(`a compressed prize of item ${id} needs the item (items: its decoded Item), for its collection`);
    return [
      meta(pda.item(project, id), false, true), meta(pda.treeConfig(tree), false, true), meta(tree, false, true), meta(item.collection, false, true),
      meta(BUBBLEGUM_PROGRAM, false, false), meta(COMPRESSION_PROGRAM, false, false), meta(NOOP_PROGRAM, false, false), meta(MPL_CORE_PROGRAM, false, false),
      meta(BUBBLEGUM_CORE_SIGNER, false, false),
    ];
  }
  return [meta(pda.box(project, prize.Roll[0]), false, false), meta(pda.order(project, winner, prizeRollNonce(nonce)), false, true)];
}

/**
 * The roll accounts of a box, as `open_box`, `ask_roll` and the oracle's answer take them after their own: each entry's
 * prizes' (`entryAccounts`: an item, its tables when it is fresh and they fit the box's table budget; a pool; a stash),
 * then each mint its tokens are in and the project's vault for it (`prizeAccounts`). `box` is the decoded LootBox (null
 * for one never written: none). `rolls`: { items (an item's id to its decoded Item, null for none written), poolMints
 * (a pool's index to its mint, null for one never opened), programs }.
 */
export function rollAccounts(project, box, rolls = {}) {
  if (!box) return [];
  const { items = {}, poolMints = {}, programs } = /** @type {{ items?: any, poolMints?: any, programs?: any }} */ (rolls);
  for (const p of box.entries.flatMap((e) => e.prizes)) {
    const id = p.Item?.[0] ?? p.Compressed?.item;
    if (id !== undefined && items[id] === undefined) throw new Error(`a roll of box ${box.box_id ?? ''} needs item ${id} (rolls.items: its decoded Item, or null for none written), for its tables`);
    const pool = p.Tokens?.from.Pool?.[0];
    if (pool !== undefined && !(pool in poolMints)) throw new Error(`a roll of box ${box.box_id ?? ''} needs the mint of pool ${pool} (rolls.poolMints; null for a pool never opened)`);
  }
  return [...entryAccounts(project, box.entries, items), ...prizeAccounts(project, box.entries, poolMints, programs)];
}

/**
 * What a write or a route that names boxes to roll later passes for them (`order::rollables`): each box once, in the
 * order they first come, and nothing after it. What a roll can give is read when it is asked.
 */
export function boxesAccounts(project, ids) {
  return [...new Set(ids)].map((id) => meta(pda.box(project, id), false, false));
}

/** The boxes a record names to roll later (`Def::rolls`), in order: a box's entries' rolls, a recipe's rolls and
 * `RollOn`s, a grant's, a lottery's places'. */
export function defRolls(def) {
  const [kind] = Object.keys(def ?? {});
  const args = def?.[kind]?.args ?? {};
  const prizes = kind === 'Box' ? (args.entries ?? []).flatMap((e) => e.prizes ?? [])
    : kind === 'Recipe' ? (args.outputs ?? []).map((o) => o.Prize?.[0] ?? (o.RollOn ? { Roll: [o.RollOn.box_id] } : null))
    : kind === 'Grant' ? [args.gives]
    : kind === 'Lottery' ? (args.terms?.places ?? args.places ?? []).map((p) => (typeof p === 'object' ? p.prize : null))
    : [];
  return prizes.flatMap((p) => (p?.Roll ? [p.Roll[0]] : []));
}

/** Bubblegum's signer for its calls to Core, `["mpl_core_cpi_signer"]`. */
export const BUBBLEGUM_CORE_SIGNER = 'CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk';

/**
 * The project's owner or authority (`signer`) makes a Bubblegum v2 tree the project alone mints compressed prizes into
 * (`Prize::Compressed`). `tree` is a new account of mpl-account-compression of `treeSize(maxDepth, maxBufferSize,
 * canopy)` bytes, made empty first in the same transaction (a System `createAccount` owned by mpl-account-compression, the tree's keypair signing).
 */
export const openTreeIx = ({ signer, project, tree, maxDepth, maxBufferSize }) =>
  lootIx('open_tree', { max_depth: maxDepth, max_buffer_size: maxBufferSize }, {
    signer, project, tree, tree_config: pda.treeConfig(tree), bubblegum_program: BUBBLEGUM_PROGRAM, compression_program: COMPRESSION_PROGRAM, log_wrapper: NOOP_PROGRAM,
  });

/** The bytes an mpl-account-compression tree of this shape takes (its header, changelog, rightmost path and canopy). */
export function treeSize(maxDepth, maxBufferSize, canopy) {
  const canopyNodes = canopy === 0 ? 0 : 2 ** (canopy + 1) - 2;
  return 56 + 24 + maxBufferSize * (32 + 32 * maxDepth + 8) + (32 * maxDepth + 32 + 8) + canopyNodes * 32;
}

/** The ticket that names what an oracle request is for: sha256("ticket" | order or lottery | the slot of its first ask).
 * Every request of one roll, or of one round's draw, names it. Nothing lives there. */
export const ticketOf = (requester, slot) => {
  const hash = sha256(concat(utf8('ticket'), addressBytes(requester), uintLE(slot, 8)));
  return hashToAddress(hash);
};


// ---------------------------------------------------------------- the platform

/** Signed by the program's upgrade authority, once. `fees`: { player, project } lamports. */
export const initPlatformIx = ({ admin, fees }) => lootIx('init_platform', { fees }, { admin });

/** `nextAdmin` signs too when it is another key. */
export const setPlatformIx = ({ admin, fees, nextAdmin = admin }) => lootIx('set_platform', { fees }, { admin, next_admin: nextAdmin });

/** The platform collects the fees waiting in each project's fee box, into `to`. */
export const collectFeesIx = ({ admin, to, projects }) =>
  lootIx('collect_fees', {}, { admin, to }, { remaining: projects.map((project) => meta(pda.fees(project), false, true)) });

export const setSuspendedIx = ({ admin, project, suspended }) => lootIx('set_suspended', { suspended }, { admin, project });

// ---------------------------------------------------------------- a project's settings

/**
 * Opens project `id` (any number of `owner`'s own) at `pda.project(owner, id)`. `authority` signs payouts and makes,
 * `treasury` is the wallet the remainder of every split goes to (its associated token account of each mint, which the
 * program opens when it is not there). `collections`: the Metaplex Core collections it has authority over (none at
 * all is fine; at most 8), each one whose update authority is the owner or the project, passed after the
 * instruction's own accounts. A project names no token: each mechanic names the mint it takes or pays. Only the owner
 * signs; the authority's and the treasury's accounts are passed too, and the program refuses a key nobody can sign
 * for that it can tell (an account of loot or of a token program, a program: `BadKey`).
 */
export const createProjectIx = ({ owner, id = 0, authority, treasury, collections = [] }) =>
  lootIx('create_project', { id: toBigInt(id), authority, treasury, collections }, { owner, authority, treasury, project: pda.project(owner, id) }, { remaining: collections.map((c) => meta(c, false, false)) });

/**
 * `update`: { authority?, treasury?, paused?, collections? }. `collections` replaces the project's list; every one in
 * it is passed after the instruction's own accounts (the program reads the new ones). The owner pays for the project
 * growing with its collections, and gets back what it shrinks by. A new owner (who signs too) is optional. A new
 * authority or treasury comes with the account at its key (`new_authority`, `new_treasury`), which the program checks
 * as `createProjectIx`'s.
 */
export const updateProjectIx = ({ owner, project, authority = null, paused = null, treasury = null, collections = null, newOwner = null }) =>
  lootIx('update_project', { update: { authority, treasury, paused, collections } }, { owner, project, new_owner: newOwner, new_authority: authority, new_treasury: treasury }, { remaining: (collections ?? []).map((c) => meta(c, false, false)) });

export const openPoolIx = ({ owner, project, index, mint }) => lootIx('open_pool', { index }, { owner, project, mint, pool: pda.pool(project, index) });

/** Where a record of the owner's lives: its kind's seed, the project and its id. */
export function recordAddress(project, def) {
  const [kind] = Object.keys(def);
  const body = def[kind];
  switch (kind) {
    case 'Item':
      return pda.item(project, body.id);
    case 'Box':
      return pda.box(project, body.id);
    case 'Schedule':
      return pda.schedule(project, body.id);
    case 'Lottery':
      return pda.lottery(project, body.id);
    case 'Recipe':
      return pda.recipe(project, body.id);
    case 'Grant':
      return pda.grant(project, body.id);
    case 'Table':
      return pda.table(project, body.id);
    default:
      throw new Error(`Unknown record kind ${kind}`);
  }
}

const NO_WINDOW = { opens_at: 0n, closes_at: 0n };
const NO_LIMIT = { total: 0, per_window: 0, window: 0 };
/**
 * `def` with optional fields filled in (no window, no limit for each wallet, no key root, a fall on its own clock).
 */
export function withDefaults(def) {
  const [kind] = Object.keys(def);
  const body = def[kind];
  const args = { ...body.args };
  if (kind === 'Box' || kind === 'Lottery' || kind === 'Grant') args.gate ??= null;
  if (kind === 'Item') {
    args.collection ??= NO_ADDRESS;
    // A fresh item's traits (`Item::traits`): none for one whose units are all alike.
    args.traits = traitsInCaps(args.traits ?? []);
  }
  if (kind === 'Box') {
    stored(args.shares);
    if (!args.currency) throw new Error('A box names the mint its price is in (`currency`).');
    // What one open draws (`LootBox::slots`): none is one draw among every entry.
    args.slots = (args.slots ?? []).map((s) => ({ only: [], distinct: false, share: 0, ...s }));
    // An entry: its prizes (`prizeMetas`) and its weight. A box burns its price with a share to `Burn`.
    if (!Array.isArray(args.entries)) throw new Error('A box needs its entries (`entries`): what its roll can give, each with its weight.');
    args.entries = args.entries.map((e) => ({ prizes: [], ...e }));
    args.subject ??= null;
    // What it does once an entry can't be given (`WhenOut`): stop selling while any entry couldn't cover the draws of
    // a purchase and those waiting for their answer (the default), or draw among what is left ('DrawLeft').
    args.when_out ??= 'StopSales';
    // A fate's `then`: null sends the NFT back to its player; 'Burn', { Give: [wallet] } or { Stash: [id] }.
    args.fates = (args.fates ?? []).map((f) => ({ ...f, then: f.then ?? null, shifts: (f.shifts ?? []).map((s) => ({ from_now: false, ...s })) }));
  }
  if (kind === 'Box' || kind === 'Recipe') {
    args.window ??= NO_WINDOW;
    args.per_wallet ??= NO_LIMIT;
  }
  if (kind === 'Recipe') {
    // A raise moves a number on a kept collectible (`place`) as a box's fate does (`Shift`); a need tests one (`Test`).
    args.raises = (args.raises ?? []).map(({ place, shift, ...flat }) => ({ place, shift: { from_now: false, most: 0, ...(shift ?? flat) } }));
    args.needs = (args.needs ?? []).map(({ place, key, test, at_least: least }) => ({ place, key, test: test ?? { AtLeast: [least ?? 0] } }));
  }
  if (kind === 'Box' && args.fall) args.fall = { shared: false, ...args.fall };
  if (kind === 'Lottery') {
    // Its terms (`LotteryTerms`, what a round copies at its first purchase), given in `terms` or beside `every`.
    const { every, gate, per_wallet: perWallet, terms: given, ...flat } = args;
    const terms = { nft_ticket: null, returns: false, min_sold: 0, ticket_mint: NO_ADDRESS, ...flat, ...given };
    // A run of places alike is { bps, prize, times }; a number is one place's share of the pot that gives nothing else.
    terms.places = (terms.places ?? []).map((p) => (typeof p === 'object' ? { prize: null, times: 1, ...p } : { bps: p, prize: null, times: 1 }));
    terms.shares = stored(terms.shares ?? []);
    return { [kind]: { ...body, args: { terms, every: every ?? 0n, gate: gate ?? null, per_wallet: perWallet ?? 0 } } };
  }
  if (kind === 'Grant') {
    args.key_root ??= new Uint8Array(32);
    args.open ??= false;
    args.shard_bits ??= 0;
  }
  return { [kind]: { ...body, args } };
}

/**
 * The owner writes one record (`def`: { Item: { id, args } }, { Box: … }, …), at its own address. A lottery names
 * its pot's mint, its pot (which its first write opens), its ticket mint, both token programs and the round it waits on
 * (`lotteryState`: the lottery as it is, null for a new one; `idleRound`: its current round's record, or round 0's once
 * it drew once and ended: a lottery made again, edited once ended or made to repeat waits while that round runs or
 * still owes NFTs of its own stash), then its own stash when a place holds or draws an NFT of it. A box, a recipe, a grant or a lottery that
 * names a box to roll later passes that box after (`boxesAccounts`), which must be written: a box is written before
 * anything names it (it may name itself).
 */
export function upsertIx({ owner, project, def: given, lotteryState = null }) {
  const def = withDefaults(given);
  const [kind] = Object.keys(def);
  const { args } = def[kind];
  let remaining = [];
  // A collectible names its collection, read for Bubblegum's plugin (`Item::compressed`: its compressed prizes can be
  // minted only when the collection carries it).
  if (kind === 'Item' && args.kind === 'Collectible') remaining = [meta(args.collection, false, false)];
  // A new sealed schedule opens its own vault: its mint, the vault and both token programs.
  const vest = kind === 'Schedule' ? args.action?.from?.Vest?.[0] : null;
  if (vest) {
    // It pays a wallet, the treasury or a burn: no account it pays is named.
    remaining = [meta(vest, false, false), meta(pda.vest(recordAddress(project, def)), false, true), meta(TOKEN_PROGRAM, false, false), meta(TOKEN_2022_PROGRAM, false, false)];
  }
  if (kind === 'Lottery') {
    remaining = [
      meta(args.terms.mint, false, false),
      meta(pda.pot(recordAddress(project, def)), false, true),
      meta(paymentMint(args.terms), false, false),
      meta(TOKEN_PROGRAM, false, false),
      meta(TOKEN_2022_PROGRAM, false, false),
      meta(lotteryState ? idleRound(recordAddress(project, def), lotteryState) : SYSTEM_PROGRAM, false, false),
    ];
    // A place that holds or draws an NFT of its own stash (`Prize::Held`, `Prize::Raffled`): that stash, after them.
    if (args.terms.places.some((p) => p.prize?.Held || p.prize === 'Raffled')) remaining.push(meta(pda.lotteryStash(recordAddress(project, def)), false, false));
  }
  // Each box it names to roll later (a box's, a recipe's, a grant's, a lottery's places'), once.
  remaining.push(...boxesAccounts(project, defRolls(def)));
  return lootIx('upsert', { def }, { owner, project, target: recordAddress(project, def) }, { remaining });
}

/**
 * The owner closes the record at `target`, and its rent comes back: a grant's with the funds it held. A lottery
 * (`lottery`: its decoded record) sends what its pot holds to `to`, a token account of the pot's mint (the owner's own
 * by default), and closes the pot, once its current round has no record (one that drew once and ended: once its round 0
 * gave out every NFT of its own stash, `idleRound`).
 */
export function closeRecordIx({ owner, project, target, lottery, schedule, programs, to, extra = [] }) {
  // A sealed schedule never closes (CannotClose): its address, and its vault's, stay bound to its terms.
  if (schedule?.action?.from?.Vest) throw new Error('A sealed schedule never closes: its vault stays bound to its terms.');
  if (!lottery) return lootIx('upsert', { def: null }, { owner, project, target });
  const { mint } = lottery.terms;
  const tokenProgram = tokenProgramOf(programs, mint);
  const remaining = [
    meta(idleRound(target, lottery), false, false),
    meta(pda.pot(target), false, true),
    meta(mint, false, true),
    meta(to ?? ata(owner, mint, tokenProgram), false, true),
    meta(TOKEN_PROGRAM, false, false),
    meta(TOKEN_2022_PROGRAM, false, false),
    ...tailOf(extra),
  ];
  return lootIx('upsert', { def: null }, { owner, project, target }, { remaining });
}

// ---------------------------------------------------------------- in: money comes in

/**
 * `player` (or a sponsor, or the project's own keys funding a pool) pays `amount` of `mint`, split at once by `shares`.
 * The rest goes to the project's `treasury` wallet. The player opens any account this pays into that is not there.
 */
export function payIx({ player, project, mint, treasury, amount, shares = [], reference: ref, playerToken, holders, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, mint);
  return lootIx(
    'pay',
    { amount, shares, reference: reference(ref) },
    { player, project, mint, treasury, treasury_token: ata(treasury, mint, tokenProgram), player_token: playerToken ?? ata(player, mint, tokenProgram) },
    { remaining: [...shareAccounts(project, shares, mint, { holders, programs, treasury }), ...tailOf(extra)], writable: sharesBurn(shares) ? ['mint'] : [] },
  );
}

/**
 * Opens a loot box (`box` the decoded LootBox at `boxAddress`), in an order at `nonce` (a box whose roll moves the
 * numbers of the NFT it rolls on: at that NFT's, `nonceOn`, whatever `nonce` says). `poolMints` maps each pool its
 * prizes take tokens from to its mint (a pool's tokens won wait in the project's vault for that mint); one not given
 * is taken to be in the box's currency, one given as null is closed. `shown`: an NFT the player shows for the box's
 * gate or odds; `listProof`: for a list gate, the proof's nodes. `chosenRecipient`: the wallet (or, for a share with an
 * item, the collectible, `chosen`) the buyer names for a share the box lets them choose. Every open asks the oracle,
 * even of a box with nothing random (which sells in one step with `buyIx`, when it rolls on no NFT).
 * The player opens the project's vault for the price's mint, and for each prize's, when it is not there. A box that
 * limits each wallet counts the purchase in the player's counts (`pda.counts`, its rent theirs).
 */
export function openBoxIx({ player, project, box, boxAddress, nonce, maxPrice, count = 1, items = {}, shown, listProof, subject, chosenRecipient = null, chosen = null, settler = NOBODY_KEY, poolMints, playerToken, programs, extra = [] }) {
  const mint = box.currency;
  poolMints = boxPoolMints(box, poolMints);
  const tokenProgram = tokenProgramOf(programs, mint);
  // `count` opens in one purchase (a box that packs), signed for `maxPrice` (the price times `count` when not given:
  // pass the sum for a box whose price rises with each sale); `items` maps an item a prize names to its decoded Item,
  // for a fresh one's tables (a box whose prizes are all alike needs none).
  const address = boxAddress ?? pda.box(project, box.box_id);
  // A box that rolls on an NFT takes it (`subject`: { asset, collection, hasAuthority, tokenMetadata, compressed }, as
  // `piece` takes it); any other, its own address stands in.
  // It is held until the roll settles when an entry burns it, gives it away or moves its numbers, and the roll is at its
  // nonce.
  const holds = boxHolds(box);
  const on = box.subject ? piece({ project, wallet: player, ...subject, moves: holds, locks: false, writes: false }) : standIn(address);
  if (box.subject && holds) nonce = nonceOn(on.accounts.asset);
  // A list's proof, then the NFT shown for the gate and the odds (for a box that rolls on an NFT, a compressed one's
  // proof instead: that NFT is the piece).
  const gate = [...gateAccounts(project, { gate: box.gate, wallet: player, listProof }), ...(box.subject ? on.proof : shownAccounts(project, shown))];
  return lootIx(
    'open_box',
    { nonce, max_price: maxPrice ?? box.price * BigInt(count), chosen_recipient: chosenRecipient, version: box.version, count, settler },
    {
      loot_box: address,
      player,
      project,
      mint,
      player_token: playerToken ?? ata(player, mint, tokenProgram),
      vault: vault(project, mint, tokenProgram),
      chosen,
      counts: limits(box.per_wallet) ? pda.counts(project, player) : null,
      ...on.accounts,
    },
    { remaining: [...entryAccounts(project, box.entries, items), ...prizeAccounts(project, box.entries, poolMints, programs), ...gate, ...tailOf(extra)], writable: on.writable },
  );
}

/**
 * Buys `count` of a box that needs no roll (one entry, nothing random, no NFT to roll on: `boxRolls` false and no
 * subject) in one instruction, any number of draws each (a fixed pack): each at the price the one before it left, all
 * within `maxPrice` (the price times `count` when not given: pass the sum for a box whose price rises with each sale).
 * The price is split at once (a share may burn it) and the entry's prizes are given to the player: a fixed amount of
 * tokens once, the whole of every draw's, and every other prize once for each draw of each sale, its accounts repeated
 * (`prizeMetas`: `items` maps an item's id to its decoded Item, `poolMints` a pool's index to its mint, `nfts` an NFT a
 * prize names to its kind). No order. A prize that can't be given refuses the purchase. `treasury` is the project's
 * treasury wallet; `holders` maps a collectible a share pays to its holder; each roll the entry gives is made at the
 * next nonce from `nonce` (`buyRolls`). `shown`/`listProof` pass the box's gate.
 */
export function buyIx({ player, project, box, boxAddress, maxPrice, count = 1, treasury, chosenRecipient = null, chosen = null, nonce = 0n, shown, listProof, items = {}, poolMints = {}, nfts = {}, holders, playerToken, programs, extra = [] }) {
  const mint = box.currency;
  const tokenProgram = tokenProgramOf(programs, mint);
  const address = boxAddress ?? pda.box(project, box.box_id);
  const shares = chosenShares(box.shares, chosenRecipient);
  const made = {};
  const prizes = buyGives(box, count).flatMap(({ prize, k }) => {
    const item = prize.Item?.[0];
    const lines = prizeMetas({ project, prize, winner: player, nonce: toBigInt(nonce) + BigInt(k), poolMints, items, nft: nfts[prize.Nft?.nft], made: made[item] ?? 0, projectMint: mint, programs });
    if (item !== undefined) made[item] = (made[item] ?? 0) + 1;
    return lines;
  });
  return lootIx(
    'buy',
    { max_price: maxPrice ?? box.price * BigInt(count), chosen_recipient: chosenRecipient, version: box.version, nonce: toBigInt(nonce), count },
    {
      player, project, loot_box: address, mint,
      player_token: playerToken ?? ata(player, mint, tokenProgram),
      treasury, treasury_token: ata(treasury, mint, tokenProgram),
      chosen, counts: limits(box.per_wallet) ? pda.counts(project, player) : null,
    },
    {
      remaining: [...gateAccounts(project, { gate: box.gate, wallet: player, shown, listProof }), ...shareAccounts(project, shares, mint, { holders, programs, treasury }), ...prizes, ...tailOf(extra)],
      writable: sharesBurn(box.shares) ? ['mint'] : [],
    },
  );
}

/**
 * What a `buy` of `count` of `box` gives, in the order it gives it (`buy.rs`): each prize of its one entry in turn, a
 * fixed amount of tokens once (`times` the box's draws × `count`), any other prize once for each of those draws. `k`
 * counts the gives: a roll given at `k` is made at the buy's `nonce + k` (its order at `prizeRollNonce` of it).
 */
export function buyGives(box, count = 1) {
  const draws = boxDraws(box) * count;
  const out = [];
  for (const prize of box.entries[0]?.prizes ?? []) {
    const once = Boolean(prize.Tokens);
    for (let i = 0; i < (once ? 1 : draws); i++) out.push({ prize, k: out.length, times: once ? draws : 1 });
  }
  return out;
}

/**
 * The oracle's answer to a box order (for a local simulation: on chain MagicBlock's oracle sends it). The accounts
 * are the ones `open_box` handed the oracle: the order, the box, the roll's ticket (named by its first ask,
 * `asked_first`, which a stale re-ask keeps), every prize's account (written); for a
 * box with tokens the two token programs, the project, and each mint with its vault (a mint it mints from written);
 * for a prize in a mint with a transfer hook, the hook's accounts (`extra`). The buyer's odds boosts were fixed at
 * purchase.
 */
export function callbackRollIx({ order, orderState, box, boxAddress, randomness, project, poolMints, items = {}, programs, extra = [] }) {
  const projectAddress = project ?? orderState.project;
  const keys = [
    meta(pda.oracleIdentity(), true, false),
    meta(order, false, true),
    // Written: the order's draws leave the box's `in_flight`.
    meta(boxAddress ?? orderState.loot_box, false, true),
    meta(ticketOf(order, orderState.asked_first), false, false),
    ...entryAccounts(orderState.project, box.entries, items),
  ];
  const prizes = prizeAccounts(orderState.project, box.entries, boxPoolMints(box, poolMints), programs);
  if (prizes.length) keys.push(meta(TOKEN_PROGRAM, false, false), meta(TOKEN_2022_PROGRAM, false, false), meta(projectAddress, false, false), ...prizes);
  keys.push(...tailOf(extra));
  return { programId: LOOT_PROGRAM, keys, data: encodeInstruction(IDL, 'callback_roll', { randomness: Uint8Array.from(randomness) }) };
}

/**
 * The accounts of what an order won (`order.won`), in order, as `settle` hands each over:
 *   Item    the item; for a collectible (`items[id]` its decoded Item), its collection, its address, Metaplex Core;
 *           for a fresh one (`drawn` set), then the table of each of its table traits
 *   Tokens  the mint, the project's vault for it, the player's account of it (`prizeTo`, when given)
 *   Nft     the NFT as `piece` takes it (`nfts[nft]` its kind), going to the player, then a compressed NFT's proof
 *   Compressed  the item, the tree's config, the tree, the collection, Bubblegum's programs; for a fresh one, then its
 *           tables and the Sheet of the NFT it mints
 */
export function wonAccounts({ order, items = {}, nfts = {}, prizeTo, putBack = [], programs, from = 0, upto = order.won.length, tree, treeMinted = 0n, unminted = [] }) {
  const project = order.project;
  // A compressed prize is minted into `tree` (any of the project's with room), the next NFT it mints: after
  // `treeMinted`, and the compressed prizes before it in this part that were minted. One of an item whose collection
  // lacks Bubblegum's plugin (`unminted`: those collections) gives nothing and mints nothing: the next takes its place.
  let minted = BigInt(treeMinted);
  const skips = new Set(unminted);
  return order.won.slice(from, upto).flatMap((won) => {
    if (won.Compressed) {
      const { item: id, drawn } = won.Compressed;
      const address = pda.item(project, id);
      const item = items[id];
      if (!item) throw new Error(`settling item ${id} needs the item (items), for its collection and its traits`);
      const tables = drawn != null ? traitTables(item).map((t) => meta(pda.table(project, t), false, false)) : [];
      if (!tree) throw new Error('settling a compressed prize needs the project tree it is minted into (tree, treeMinted)');
      const asset = pda.compressedAsset(tree, minted);
      if (!skips.has(item.collection)) minted += 1n;
      return [
        meta(address, false, true), meta(pda.treeConfig(tree), false, true), meta(tree, false, true), meta(item.collection, false, true),
        meta(BUBBLEGUM_PROGRAM, false, false), meta(COMPRESSION_PROGRAM, false, false), meta(NOOP_PROGRAM, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(BUBBLEGUM_CORE_SIGNER, false, false),
        // A fresh one's traits are written in the project's Sheet for the NFT it mints.
        ...(drawn != null ? [...tables, meta(pda.sheet(project, asset), false, true)] : []),
      ];
    }
    if (won.Item) {
      const { item: id, serial, drawn } = won.Item;
      const address = pda.item(project, id);
      const item = items[id];
      if (!item) throw new Error(`settling item ${id} needs the item (items), for its kind and collection`);
      if (item.kind !== 'Collectible') return [meta(address, false, true)];
      // A fresh unit's traits come from the rows its tables drew at the roll.
      const tables = drawn != null ? traitTables(item).map((t) => meta(pda.table(project, t), false, false)) : [];
      return [meta(address, false, true), meta(item.collection, false, true), meta(pda.itemAsset(address, serial), false, true), meta(MPL_CORE_PROGRAM, false, false), ...tables];
    }
    if (won.Tokens) {
      const { mint } = won.Tokens;
      const program = tokenProgramOf(programs, mint);
      return [meta(mint, false, false), meta(vault(project, mint, program), false, true), meta(prizeTo ?? ata(order.player, mint, program), false, true)];
    }
    if (won.Nft) {
      const { stash, nft: asset } = won.Nft;
      // The player, settling their own order, may put an NFT its collection won't let move back into its stash.
      if (putBack.includes(asset)) return [meta(pda.stash(project, stash), false, true)];
      const p = piece({ project, asset, wallet: order.player, ...nfts[asset], ...ONLY_MOVES });
      return [...pieceMetas(p), ...p.proof];
    }
    throw new Error(`settling an order: a prize of a kind this client doesn't know (${Object.keys(won)[0]})`);
  });
}

/** The calls a transaction may make, its own instructions and every call inside them (Solana's instruction trace). */
export const TRACE_LIMIT = 64;
/** The calls a settle makes before its prizes: the compute budget's, its own, and the payment's at most. */
const SETTLE_BASE_CALLS = 6;

/** The calls one prize makes when a settle hands it over, measured on the program (`tests/limits.rs`): a collectible's
 * mint by Core (4, so 14 a transaction), a compressed one's by Bubblegum (5) and with its Sheet (7), tokens (2), an NFT
 * moved (3). `items` maps an item's id to its decoded Item (a normal item makes none). */
export function prizeCalls(won, items = {}) {
  if (won.Item) return won.Item.drawn == null && items[won.Item.item]?.kind === 'Normal' ? 0 : 4;
  if (won.Compressed) return won.Compressed.drawn != null ? 7 : 5;
  if (won.Tokens) return 2;
  return 3;
}

/** Where a settle part that starts at `from` ends: as many of the order's prizes as fit the instruction trace (an
 * NFT's move asks for the bigger heap, so at most three a part). Each part is its own transaction; anyone sends any. */
export function settlePartEnd(order, from = Number(order.settled ?? 0), items = {}) {
  let calls = SETTLE_BASE_CALLS;
  let nfts = 0;
  let end = from;
  while (end < order.won.length) {
    const won = order.won[end];
    const next = prizeCalls(won, items);
    if (end > from && (calls + next > TRACE_LIMIT || (won.Nft && nfts >= 3))) break;
    calls += next;
    nfts += won.Nft ? 1 : 0;
    end++;
  }
  return end;
}

/** How many draws one open of `box` makes: its slots' counts, or one. */
export const boxDraws = (box) => (box.slots?.length ? box.slots.reduce((n, s) => n + Number(s.count), 0) : 1);

/** How many settle parts an order of `opens` opens of `box` takes at most: each card, at its most calls, and with
 * shares one more (the first call splits the payment, alone when no prize fits beside its shares: `upto` 0). */
export function settleParts(box, opens = 1) {
  const draws = box.slots?.length ? box.slots.reduce((n, s) => n + Number(s.count), 0) : 1;
  const cards = Math.max(1, ...box.entries.map((e) => e.prizes.length)) * draws * Math.max(1, opens);
  return Math.max(1, Math.ceil(cards / Math.floor((TRACE_LIMIT - SETTLE_BASE_CALLS) / 7))) + ((box.shares ?? []).length ? 1 : 0);
}

/** The heap a settle that moves three or more NFTs asks for (`settleHeapFrame`): all a transaction may have, 256 KiB. */
export const LARGE_SETTLE_HEAP = 256 * 1024;

/** Whether an order rolled on an NFT: its `subject` names one (null for none). */
const rolledOn = (order) => Boolean(order.subject) && order.subject !== NO_ADDRESS;

/**
 * The heap a settle of `order` asks for with Compute Budget's `RequestHeapFrame` (`requestHeapFrame`), in bytes; 0 for
 * none (the 32 KiB every transaction has). A settle hands every account to each NFT's move, so one that moves three or
 * more NFTs (the prizes and the NFT rolled on) can outgrow 32 KiB, for good once a payee turns on required memos
 * (a known limit of the program).
 *
 * loot's own allocator uses the frame a transaction asks for, up to
 * 256 KiB, so such a settle asks for all of it (`LARGE_SETTLE_HEAP`, about 1,000 compute units more). Every settle
 * `js/play` sends for such an order asks for it, and so does the keeper's sweep: put `requestHeapFrame(heap)` before
 * the settle when `settleHeapFrame(order)` is not 0. A prize step of a lottery gives one place a call and needs none.
 */
export function settleHeapFrame(order) {
  const moves = (order.won ?? []).filter((w) => w.Nft).length + (rolledOn(order) ? 1 : 0);
  return moves >= 3 ? LARGE_SETTLE_HEAP : 0;
}

/** All the compute units a transaction may have: what a settle that moves an NFT asks for (`settleComputeUnits`). */
export const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * The compute limit a settle of `order` asks for. A settle that moves an NFT asks for all a transaction may have
 * (1,400,000 units): up to 986,000 were measured for three pNFTs of stashes, the NFT rolled on and
 * four holders' shares. Any other asks for 800,000 (tokens to the player and up to four payees, accounts opened for
 * them). A limit costs nothing more when no priority fee is set.
 */
export function settleComputeUnits(order) {
  // An NFT moved, an NFT rolled on, a compressed mint (Bubblegum's 60,000 to 90,000 units each) or a pack's part of
  // many cards takes all a transaction may have.
  const won = order.won ?? [];
  const moves = won.some((w) => w.Nft || w.Compressed) || won.length > 8 || rolledOn(order);
  return moves ? MAX_COMPUTE_UNITS : 800_000;
}

/** `settle`'s `upto` for its last part: past the end of any order. The last part gives what is left, pays back the share
 * of the draws the roll didn't make, carries out the roll on an NFT and closes the order. */
export const SETTLE_LAST = 4_294_967_295;

/**
 * Carries out a rolled order: hands over what its roll set aside (`wonAccounts`: a collectible minted, the project's
 * backend delivering a normal item from the receipt; tokens from the project's vault; an NFT taken out of its stash),
 * then splits the payment (a share may burn it). The order's player, its settler or the project's keys send it, for the order at `orderAddress`; `signer` pays all
 * the settle opens or mints (Core assets, token accounts, Sheets, a stash's row, the fate's writes: the order lends
 * nothing, `settleRent`). `order` is the decoded Order; `projectState` the decoded Project; `items` and `nfts` as
 * `wonAccounts` takes them. `putBack`: NFTs won that the player, signing, puts back into their stash in place of taking
 * them (one its collection won't let move). `handBack`: the wallet the box's fate gives the NFT rolled on to
 * (`receiverOf`) is an account of the loot program (`handsBack` of it as read), so the program gives it back to the
 * player, and a Token Metadata NFT's `token` is the player's. `extra`: a hook's or a memo's accounts.
 *
 * `upto`, the part (`settle.rs`): `SETTLE_LAST` (the default, past the end) is the last part, all that is left (maybe
 * nothing); 0 gives no prize and only splits the payment; any other gives the prizes from where the last part stopped
 * (`settled`) up to it, and nothing more. The first call, whichever it is, splits the payment (its shares' accounts
 * ride on it).
 */
export function settleIx({ signer, orderAddress, order, projectState, items, nfts, prizeTo, putBack, subject, handBack = false, holders, programs, upto = SETTLE_LAST, tree, treeMinted, unminted, extra = [] }) {
  const project = order.project;
  const from = Number(order.settled ?? 0);
  const last = Number(upto) > order.won.length;
  const end = last ? order.won.length : Math.max(from, Number(upto));
  // The payment is split once, by the first call (`drew` is 0 once it is made).
  const splits = Number(order.drew ?? 0) > 0;
  const prizes = wonAccounts({ order, items, nfts, prizeTo, putBack, programs, from, upto: end, tree, treeMinted, unminted });
  const tokenProgram = tokenProgramOf(programs, order.mint);
  // The NFT it rolled on, as the settle moves it: given to a wallet that is an account of the loot program, it goes
  // back to its player (`handsBack`), into the player's token account for a Token Metadata NFT.
  // A part before the last gives only its prizes (and the first, the split): no NFT rolled on (its piece a stand-in).
  const receiver = last ? receiverOf(order) : null;
  const on = last ? orderPiece(project, orderAddress, order, subject, handBack && order.fate?.then?.Give ? order.player : receiver) : standIn(orderAddress);
  return lootIx(
    'settle',
    { upto: Number(upto), prize_accounts: prizes.length },
    {
      signer,
      order: orderAddress,
      player: order.player,
      project,
      mint: order.mint,
      vault: vault(project, order.mint, tokenProgram),
      treasury: projectState.treasury,
      treasury_token: ata(projectState.treasury, order.mint, tokenProgram),
      ...on.accounts,
      receiver,
      // The last part of an order whose roll left a draw unmade or part given gives its share of the payment back here.
      player_token: BigInt(order.back ?? 0) > 0n && last ? ata(order.player, order.mint, tokenProgram) : null,
    },
    {
      remaining: [...on.proof, ...prizes, ...(splits ? shareAccounts(project, order.shares, order.mint, { holders, programs, treasury: projectState.treasury }) : []), ...tailOf(extra)],
      writable: [...(sharesBurn(order.shares) && splits ? ['mint'] : []), ...on.writable],
    },
  );
}

/**
 * Where a held NFT a roll was on goes, when not back to its player: the wallet its fate names, the stash it goes into,
 * or the incinerator.
 */
export function receiverOf(order) {
  const then = order.fate?.then;
  if (!order.held || then == null) return null;
  if (then.Give) return then.Give[0];
  if (then.Stash) return pda.stash(order.project, then.Stash[0]);
  return then === 'Burn' ? INCINERATOR : null;
}

/**
 * The accounts of the NFT an order rolled on (`order.subject`, the default address for none): as its receiver holds
 * it after the settle (its player, or `receiverOf`). `subject`: its kind, as `piece` takes it ({ collection,
 * hasAuthority, tokenMetadata, compressed }).
 */
function orderPiece(project, orderAddress, order, subject = {}, receiver) {
  if (!rolledOn(order)) return standIn(orderAddress);
  // The numbers its roll moves are written on it (a Core asset is burned the same way); a held one is sent on, unless
  // a stash keeps it where it is.
  const shifts = Boolean(order.fate?.shifts?.length);
  const then = order.fate?.then;
  const burned = order.held && then === 'Burn';
  const stays = Boolean(then?.Stash);
  return piece({ project, asset: order.subject, wallet: stays ? order.player : receiver ?? order.player, ...subject, moves: order.held && !stays, locks: false, writes: shifts, burns: burned, reads: shifts });
}

/**
 * Whether an NFT the project holds, given to the wallet whose account is `account` (as read: `{ owner }`, or null for
 * none), goes back to its player instead: when that account is the loot program's (the project's
 * own address, a record, a stash, a fee box), where nothing could move it again. A settle's fate and an NFT lottery
 * ticket's price take it as `handBack`.
 */
export const handsBack = (account) => account?.owner === LOOT_PROGRAM;

/** Where an NFT that is burned but can't be (any kind but Core) is sent: an address nobody holds the key to. */
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

/**
 * Gives an order's payment back to its player, into their account of the mint (`signer`, anyone, opens it when it is
 * not there): an order whose roll failed or never came. A rolled order is settled, never refunded
 * (`orderRefundable`). A purchase counted against a box's limit for each
 * wallet is given back. A purchase that counts its draws in its box's `in_flight` (`order.reserved`, a box that stops
 * selling when an entry runs out) names the box, whose count it leaves. `extra`: a hook's or a memo's accounts.
 */
export function refundIx({ signer, orderAddress, order, subject, programs, extra = [] }) {
  const project = order.project;
  const tokenProgram = tokenProgramOf(programs, order.mint);
  // A held NFT goes back to its player.
  const on = order.held && rolledOn(order)
    ? piece({ project, asset: order.subject, wallet: order.player, ...subject, ...ONLY_MOVES })
    : standIn(orderAddress);
  return lootIx(
    'refund',
    {},
    {
      signer,
      order: orderAddress,
      player: order.player,
      project,
      mint: order.mint,
      vault: vault(project, order.mint, tokenProgram),
      player_token: ata(order.player, order.mint, tokenProgram),
      counts: order.counted != null ? pda.counts(project, order.player) : null,
      // Required while the order counts draws in its box (`reserved`); an order read without the field names it too.
      loot_box: order.reserved == null || BigInt(order.reserved) > 0n ? order.loot_box : null,
      ...on.accounts,
    },
    { remaining: [...on.proof, ...tailOf(extra)], writable: on.writable },
  );
}

/**
 * Its player or the project's keys (`payer`, who pays the oracle) ask for the roll a mission's return, a recipe or a prize made (`order.status`
 * Waiting): the box's roll accounts, as `openBoxIx` passes them (`items` maps an item a prize names to its decoded
 * Item, for a fresh one's tables). It lands in `callback_roll`. Returns a list of instructions: first `payer` opens the
 * project's vault for each prize mint when it is not there (idempotent; the program refuses the ask without them,
 * since tokens won wait there), then the ask. A box with nothing in stock is refused (`SoldOut`) unless the order's own
 * player asks in a later slot than the order was made or last asked in: a route that makes a roll and asks for it in
 * the same transaction fails whole on an empty box, and the player keeps what the route took. The player's own ask on
 * an empty box ends the roll there, with no oracle: rolled with nothing (an NFT it holds goes home as it was), or failed
 * for its refund when its winner paid for it (an auction's roll lot). An answer that finds nothing at all in stock puts
 * a free roll back to waiting (`Waiting`), for a restock or for its player to end it so. Once asked, every later ask
 * comes in a later slot than the last (`SameSlot`, `rollAskable`).
 */
export function askRollIx({ payer, orderAddress, order, box, settler = NOBODY_KEY, poolMints, items = {}, programs }) {
  poolMints = boxPoolMints(box, poolMints);
  const opens = prizeMints(box.entries, poolMints).map(({ mint }) => createAssociatedTokenAccountIdempotent(payer, order.project, mint, tokenProgramOf(programs, mint)));
  const ask = lootIx('ask_roll', { settler }, { payer, order: orderAddress, loot_box: order.loot_box, project: order.project }, {
    remaining: [...entryAccounts(order.project, box.entries, items), ...prizeAccounts(order.project, box.entries, poolMints, programs)],
  });
  return [...opens, ask];
}

// ---------------------------------------------------------------- out: the project's tokens move

/**
 * The authority moves the project's tokens: `from` { Pool: [i] }, { Mint: [mint] } (newly minted) or { Farm: [id] } (what
 * that farm's rewards vault holds free, beyond what it owes its seats: a fixed amount; `farm`: the farm decoded, so its
 * record of ends comes when it keeps one), `to` a pool, a wallet, an account, the treasury (`treasury`, the project's
 * wallet), a collectible's holder or 'Burn', `amount` { Fixed: [n] } or { Bps: [bps] } of a pool. The authority opens the
 * account it pays into when it is not there; a collectible nobody holds gets nothing.
 */
export function moveTokensIx({ authority, project, mint, from, to, amount, reference: ref, holders, programs, treasury, farm = null, extra = [] }) {
  const writes = Boolean(from.Mint) || to === 'Burn';
  return lootIx(
    'move_tokens',
    { from, to, amount, reference: reference(ref) },
    // What a farm holds free comes out of its rewards vault, passed as the pool, with the farm.
    { authority, project, mint, pool: from.Pool ? pda.pool(project, from.Pool[0]) : from.Farm ? pda.rewards(pda.farm(project, from.Farm[0])) : null, farm: from.Farm ? pda.farm(project, from.Farm[0]) : null, farm_ends: from.Farm && farm?.keeps_ends ? pda.ends(pda.farm(project, from.Farm[0])) : null },
    { remaining: [...destinationAccounts(project, to, mint, { holders, programs, treasury }), ...tailOf(extra)], writable: writes ? ['mint'] : [] },
  );
}

// ---------------------------------------------------------------- make: collectibles

/**
 * The authority rewrites or burns a collectible, or writes a wallet's profile. `change`: { Set: [attributes] }, 'Burn'
 * (`owner`: whoever holds it, who gets its rent) or { Profile: [attributes] } (`asset` the wallet). `collection`: for a
 * Burn the project's; for a Set the asset's own (`MPL_CORE_PROGRAM` for one in none). `hasAuthority` false for a `Set`
 * on an NFT the project has no authority over (a Core asset of another collection, or a Token Metadata NFT's mint):
 * what it writes goes in the NFT's Sheet, or on the NFT itself when its Attributes plugin names the project. A `Make`
 * goes to `makeIx`.
 */
export function collectibleIx({ authority, project, collection, asset, change, owner = null, hasAuthority = true, reference: ref, ...make }) {
  if (change.Make) return makeIx({ authority, project, ...change.Make, ...make, owners: make.owners ?? [owner], reference: ref });
  const sheet = change.Set && !hasAuthority ? pda.sheet(project, asset) : change.Profile ? pda.profile(project, asset) : null;
  const burn = change === 'Burn' || Boolean(change.Burn);
  return lootIx(
    'collectible',
    { change, reference: reference(ref) },
    { authority, project, collection, asset, owner: burn ? owner : null, sheet },
    { writable: change.Set || change.Profile || collection === MPL_CORE_PROGRAM ? [] : ['collection'] },
  );
}

/**
 * The authority makes one of item `item` (`itemState`: its decoded Item, for its collection and next serial) for each
 * of `owners`, in serial order (an owner may come more than once), with `attributes` written over the program's own: a
 * collectible at `pda.itemAsset(item, serial)` (`madeAssets` says which), or with `tree`, a compressed NFT minted into
 * that tree of the project's (no attributes: they go in its Sheet). A switched-off item still makes; one sold out
 * refuses the whole call (`PrizeNotCovered`).
 */
export function makeIx({ authority, project, item, itemState, owners, attributes = [], tree = null, reference: ref }) {
  if (!itemState) throw new Error(`a make of item ${item} needs the item (itemState: its decoded Item), for its collection and next serial`);
  if (!owners?.length || owners.some((o) => !o)) throw new Error('A make names who gets each one (`owners`).');
  const prize = tree ? { Compressed: { item, tree } } : { Item: [item] };
  const remaining = owners.flatMap((owner, made) => [meta(owner, false, false), ...prizeMetas({ project, prize, winner: owner, items: { [item]: itemState }, made })]);
  return lootIx(
    'collectible',
    { change: { Make: { item, tree, attributes } }, reference: reference(ref) },
    { authority, project, collection: itemState.collection, asset: pda.item(project, item), owner: null, sheet: null },
    { remaining, writable: ['collection'] },
  );
}

/** The collectibles a `makeIx` of `count` mints (not compressed): at the item's next serials. */
export const madeAssets = (project, item, itemState, count = 1) => Array.from({ length: count }, (_, k) => pda.itemAsset(pda.item(project, item), Number(itemState.issued) + 1 + k));

// ---------------------------------------------------------------- decide

/**
 * A held NFT goes to `to`: the authority's choice while the hold runs, home to its player (anyone) after; a repaid
 * loan's home (anyone, whenever), an unpaid one's to its lender once due. `hold` is the
 * decoded Hold: its address names its end (`pda.hold(asset, free_at)`), so a release sent late never lands on a later
 * hold; `address` names it when its `free_at` changed since (a repaid loan's is 0, at the address its loan named). The
 * NFT is any kind
 * (`piece`): `asset` and `collection` for a Core asset, with `tokenMetadata` for a Token Metadata NFT, or `compressed`
 * (after a `proveLeafIx`).
 */
export function releaseIx({ signer, project, collection, asset, tokenMetadata: tm, compressed, hold, address = null, to, treasury, reference: ref, more = [] }) {
  // A hold whose player is the project's own address is owed to the treasury, as the project names it now (`treasury`,
  // the decoded Project's).
  if (!to && hold.player === project && !treasury) throw new Error('This hold is owed to the treasury: pass treasury (the project’s, as it is now).');
  const receiver = to ?? (hold.player === project ? treasury : hold.player);
  // Never to the project's own address, nor any account of the program, where nothing could move it again (ToTheProject).
  if (receiver === project) throw new Error('A held NFT can’t go to the project’s own address: name a wallet.');
  // Several holds of one player's with one end, payer and rent wallet (`more`: each { asset, collection, tokenMetadata,
  // compressed }) go to one `to` together, in ascending order of their holds' addresses.
  const [first, ...rest] = ascending([{ asset, collection, tokenMetadata: tm, compressed, address }, ...more].map((n) => {
    const p = piece({ project, asset: n.asset, wallet: receiver, collection: n.collection, tokenMetadata: n.tokenMetadata, compressed: n.compressed, ...ONLY_MOVES });
    return { p, hold: n.address ?? pda.hold(p.accounts.asset, hold.free_at) };
  }), (x) => x.hold);
  const p = withPrograms(first.p, rest.map((x) => x.p));
  const groups = rest.flatMap((x) => [meta(x.hold, false, true), ...anotherMetas(x.p)]);
  // The hold's rent goes back to whoever made it (`payer`), a Token Metadata NFT's emptied account's to whoever paid it.
  return lootIx('release', { reference: reference(ref) }, { signer, project, ...p.accounts, hold: first.hold, payer: hold.payer, rent_to: hold.rent_to, to: receiver }, { remaining: [...p.proof, ...groups], writable: p.writable });
}

/** The mint of a contest's split prize (its `prize`, tokens): minted, or a pool's (`poolMint`). */
const splitMint = (prize, poolMint) => prize?.Tokens?.from.Mint?.[0] ?? poolMint;

/**
 * The authority opens contest `id` in `mint` (`projectState`: the decoded Project, whose next incarnation names the
 * contest's list of entries). `args`: { sides, closes_at, result_by, shares, gate, deciders, min_pot, stake, prize, nft,
 * prize_split, cap }: `prize`, what each winning entry gets with its first claim (`prizeMetas`); `nft`, a rule an NFT
 * each entry stakes passes, in place of tokens (no shares then, no stake: the NFTs are the pot), each winner sharing the
 * losers' NFTs, at most `cap` each (null: no cap). With `args.prize_split`, its token prize is set aside whole when it
 * is decided, in the contest's own vault (`pda.prizeVault`, opened now at the authority's rent), and each winning entry
 * takes its part by what it put in: `prizeMint` names the prize's mint when it comes from a pool.
 */
export const openContestIx = ({ authority, project, projectState, id, mint, args, prizeMint }) => {
  stored(args.shares);
  const contest = pda.contest(project, id);
  const split = Boolean(args.prize_split);
  return lootIx('open_contest', { id, args: { deciders: [], min_pot: 0, stake: 0, prize: null, nft: null, prize_split: false, cap: null, ...args, gate: args.gate ?? null } }, {
    authority, project, mint, contest,
    prize_mint: split ? splitMint(args.prize, prizeMint) : null, prize_vault: split ? pda.prizeVault(contest) : null,
    entries: pda.entries(contest, BigInt(projectState.incarnations) + 1n),
    // A split prize from a pool names the pool at its index (`WrongPool` without it; a prize mint not the pool's is
    // `WrongMint`).
    prize_pool: split && args.prize?.Tokens?.from?.Pool ? pda.pool(project, args.prize.Tokens.from.Pool[0]) : null,
  }, {
    // A prize that is a roll: its box.
    remaining: args.prize?.Roll ? boxesAccounts(project, [args.prize.Roll[0]]) : [],
  });
};

/** A contest's list of entries, from its decoded Contest. */
export const contestEntries = (contestAddress, contest) => pda.entries(contestAddress, contest.incarnation);

/** The prefix of a contest's verdict (`verdictBytes`). */
export const VERDICT_DOMAIN = 'loot-verdict-v4';

/**
 * The bytes a contest's decider key signs: "loot-verdict-v4" | sha256(program (32) | contest (32) | incarnation (u64
 * LE) | side (u16 LE; 65535 calls it off) | expires (i64 LE), then | recipient (32) when the verdict names the wallet
 * the contest's chosen share pays). `incarnation` is the contest's (the decoded Contest's), so a verdict decides only
 * the contest it was signed for, never one opened later at the same id. `decide` rebuilds them from its own accounts
 * and arguments.
 */
export function verdictBytes({ program = LOOT_PROGRAM, contest, incarnation, side, expires, recipient = null }) {
  if (incarnation == null) throw new Error('A verdict signs the contest’s incarnation (the decoded Contest’s).');
  const named = recipient == null ? new Uint8Array(0) : addressBytes(recipient);
  return concat(utf8(VERDICT_DOMAIN), sha256(concat(addressBytes(program), addressBytes(contest), uintLE(incarnation, 8), uintLE(side ?? 0xffff, 2), intLE(expires, 8), named)));
}

/**
 * Names the side that won (`side`), or calls the contest off (`side: null`). `signer` is the authority; or anyone
 * sending a decider's verdict (`verdict: { expires }`, taken once entries have closed): then this instruction goes
 * right after the Ed25519 check of the decider's signature over `verdictBytes` (`ed25519Ix` in grant.js), and
 * `signer` pays the fee, as the authority does. A contest that is off by itself (overdue) needs no decision, and takes
 * none (`ResultOverdue`): `claim` closes it. The contest's incarnation names it, so a
 * decision sent late never decides a contest opened later at the same id. A call-off takes no share accounts. A
 * contest with a chosen share is decided naming its `recipient`, a wallet (a bounty's worker); a decider's verdict
 * signs it too (`verdictBytes`).
 */
export function decideIx({ signer, project, projectState, contestAddress, contest, side, recipient = null, verdict, reference: ref, holders, prizeMint, programs, extra = [] }) {
  const address = contestAddress ?? pda.contest(project, contest.id);
  const named = recipient == null ? contest.shares : chosenShares(contest.shares, recipient);
  const shares = side == null ? [] : shareAccounts(project, named, contest.mint, { holders, programs, treasury: projectState?.treasury });
  // A split prize is set aside when a side is named (minted, or from its pool). A decision never closes the contest:
  // `claim` does, entered or not.
  const split = Boolean(contest.prize_split);
  const from = contest.prize?.Tokens?.from;
  return lootIx(
    'decide',
    { side: side ?? null, expires: toBigInt(verdict?.expires ?? 0), reference: reference(ref), incarnation: contest.incarnation, recipient },
    {
      signer, project, contest: address, mint: contest.mint, instructions: verdict ? SYSVAR_INSTRUCTIONS : null,
      prize_mint: split ? splitMint(contest.prize, prizeMint) : null,
      // Its pool: the prize set aside from it when a side is named.
      prize_pool: split && side != null && from?.Pool ? pda.pool(project, from.Pool[0]) : null,
      prize_vault: split ? pda.prizeVault(address) : null,
    },
    // The mint is written by a burn share; the prize's mint when it is minted.
    { remaining: [...shares, ...tailOf(extra)], writable: [...(side != null && sharesBurn(contest.shares) ? ['mint'] : []), ...(split && side != null && from?.Mint ? ['prize_mint'] : [])] },
  );
}

/** The authority asks the oracle for a random number, for a rule of the project's own. */
export const rollIx = ({ authority, project, reference: ref }) => lootIx('roll', { reference: reference(ref) }, { authority, project });

/** The oracle's answer to a `roll` (for a local simulation). */
export const callbackRandomIx = ({ project, reference: ref, randomness }) => ({
  programId: LOOT_PROGRAM,
  keys: [meta(pda.oracleIdentity(), true, false), meta(project, false, false), meta(hashToAddress(reference(ref)), false, false)],
  data: encodeInstruction(IDL, 'callback_random', { randomness: Uint8Array.from(randomness) }),
});

// ---------------------------------------------------------------- schedules and lotteries

/**
 * The project's keys or who it pays (`payer`; a sealed burn: anyone) run a schedule that is due, and open the account it
 * pays into when that is not there. A run missed is missed: it pays once, for the latest run due, and the runs before it
 * lapse; only a sealed schedule's fixed amount pays every run due, up to `upto` runs made (`scheduleCatchesUp`).
 * `poolMint`: the mint of the pool it moves from (when it moves from one). `extra`: a hook's or a memo's accounts.
 */
export function runScheduleIx({ payer, project, id, schedule, poolMint, holders, programs, treasury, upto = 0, extra = [] }) {
  const { from, to } = schedule.action;
  const address = pda.schedule(project, id);
  // A sealed schedule pays from its own vault (`pda.vest`), passed where a pool would be.
  const mint = from.Mint?.[0] ?? from.Vest?.[0] ?? poolMint;
  const writes = Boolean(from.Mint) || to === 'Burn';
  const pool = from.Pool ? pda.pool(project, from.Pool[0]) : from.Vest ? pda.vest(address) : null;
  // `upto` (the runs it has plus those due, `runsDue`; 0: no bound) has an effect only on what pays every run due.
  return lootIx(
    'run_schedule',
    { upto },
    { payer, project, schedule: address, pool, mint },
    { remaining: [...destinationAccounts(project, to, mint, { holders, programs, treasury }), ...tailOf(extra)], writable: writes ? ['mint'] : [] },
  );
}


// A lottery's rounds (`accounts.js`: `decodeRound`, `partsOwed`, `commonOwed`): each round is a record of its own, opened
// by its first purchase. Its ask (`draw_lottery`) fixes its money and moves the lottery on; after the answer, `pull`
// pays one part at a time, in any order, and the pull that leaves nothing owed closes it. Every builder takes the
// decoded records it acts on, so each is pure.

/** The address of a lottery's current round's record (there or not), from its decoded Lottery. */
export const currentRound = (lotteryAddress, lottery) => pda.round(lotteryAddress, lottery.incarnation, lottery.round);

/**
 * `player` buys `count` tickets of lottery `id`'s current round (`lottery` decoded; `round` its decoded record, null when
 * nobody bought into it yet: then this purchase opens it, and the lottery's spare SOL pays its rent, or the buyer fronts
 * it, back at the close). It buys only at the revision the round copied (`TermsChanged` otherwise), and its round's
 * address names the lottery's incarnation and round (a purchase that lands as the round moves on fails, and is sent
 * again). A share the buyer chooses is paid now, out of the price, from the buyer's own account: to the wallet they name
 * (`chosenRecipient`), the holder of the collectible `chosen` (its holder in `holders`), or with no choice the project's
 * `treasury` wallet. A lottery whose ticket costs an NFT sells one at a time, for `nft` ({ asset, collection,
 * tokenMetadata, compressed }, as `piece` takes it).
 */
export function buyTicketsIx({ player, project, id, lottery, round = null, mint, count, shown, listProof, chosenRecipient = null, chosen = null, nft, holders = {}, treasury, playerToken, programs, extra = [] }) {
  const address = pda.lottery(project, id);
  const key = currentRound(address, lottery);
  // The terms the round copied, or for its first purchase the lottery's.
  const terms = round ? round.terms : lottery.terms;
  mint ??= paymentMint(terms);
  const paying = !terms.nft_ticket && BigInt(terms.price) > 0n;
  const choices = paying ? chosenShares(terms.shares.filter(chosenAtPurchase), chosenRecipient) : [];
  const recipients = shareAccounts(project, choices, mint, { holders, programs, treasury });
  const held = terms.nft_ticket ? piece({ project, wallet: player, ...nft, ...ONLY_MOVES, reads: true }) : null;
  return lootIx(
    'buy_tickets',
    { count, chosen_recipient: chosenRecipient, revision: round ? round.revision : lottery.revision },
    {
      player, project, lottery: address, round: key,
      player_token: playerToken ?? ata(player, mint, tokenProgramOf(programs, mint)),
      payment_vault: pda.roundTokens(key, mint), mint, chosen,
      counts: Number(lottery.per_wallet) ? pda.counts(project, player) : null,
      associated_token_program: choices.length ? ASSOCIATED_TOKEN_PROGRAM : null,
    },
    { remaining: [...gateAccounts(project, { gate: lottery.gate, wallet: player, shown, listProof }), ...recipients, ...(held ? [...pieceMetas(held), ...held.proof] : []), ...tailOf(extra)] },
  );
}

/**
 * Anyone asks for the draw of a lottery's round once it is due (`lottery` decoded). `round`: the decoded record of the
 * round asked for (null when nobody bought into the current one: it moves on, or a lottery that draws once ends, with
 * no ask), and `roundAddress` its address when it is not the current round's (an older round still waiting for its
 * answer: asked again after `STALE_SECONDS`, or after the timeout cancelled, with no lottery account, so `lottery` may be
 * null then; without `round`, the current round's, with the lottery's terms). A round's first ask fixes its money: it takes
 * the lottery's pot, its mint and the round's account of it, then each run of token prizes in place order, its mint and
 * for a pool, the pool and the round's account of the mint (`poolMints`: a pool's index to its mint). With `skipHooked`
 * (the project's authority only) a hooked pool or pot gives the round nothing. `extra`: hook accounts.
 */
export function drawLotteryIx({ payer, project, id, lottery, round = null, roundAddress = null, skipHooked = false, poolMints = {}, extra = [] }) {
  const address = id === undefined || id === null ? null : pda.lottery(project, id);
  const key = roundAddress ?? currentRound(address, lottery);
  const rest = [];
  // A round with no record moves on and a round asked before is asked again, reading none of these: they are passed
  // unless the round is known to have been asked.
  const current = !round || round.status === 'Open';
  if (current) {
    const { terms } = round ?? lottery;
    rest.push(meta(pda.pot(address), false, true), meta(terms.mint, false, false), meta(pda.roundTokens(key, terms.mint), false, true));
    for (const place of terms.places) {
      const from = place.prize?.Tokens?.from;
      if (from?.Mint) rest.push(meta(from.Mint[0], false, false));
      else if (from?.Pool) {
        const mint = poolMints[from.Pool[0]];
        if (!mint) throw new Error(`The ask of a round whose place gives tokens from pool ${from.Pool[0]} needs that pool's mint (poolMints).`);
        rest.push(meta(mint, false, false), meta(pda.pool(project, from.Pool[0]), false, true), meta(pda.roundTokens(key, mint), false, true));
      }
    }
  }
  // The lottery goes with its current round only: a round whose draw waits is asked again or cancelled without it, so a
  // lottery closed since never strands it.
  return lootIx('draw_lottery', { skip_hooked: skipHooked }, { payer, project, lottery: current ? address : null, round: key }, { remaining: [...rest, ...tailOf(extra)] });
}

/** The oracle's answer to a round's draw (for a local simulation): the round's record is its only account. */
export const callbackLotteryIx = ({ round, randomness }) => ({
  programId: LOOT_PROGRAM,
  keys: [meta(pda.oracleIdentity(), true, false), meta(round, false, true)],
  data: encodeInstruction(IDL, 'callback_lottery', { randomness: Uint8Array.from(randomness) }),
});

/** The accounts a round's close takes after a pull's own: each of its token accounts, its mint and who opened it (the
 * lottery, which gets its spare back, or a buyer who fronted it; `owner` for one the lottery opened, once it is closed). */
export const roundCloseMetas = (key, r, owner = null) =>
  r.accounts.filter((o) => o.mint !== NO_ADDRESS).flatMap((o) => [meta(pda.roundTokens(key, o.mint), false, true), meta(o.mint, false, true), meta(owner && o.by === r.lottery ? owner : o.by, false, true)]);

/** The NFT a raffle's place draws from the lottery's own stash (`stash` decoded, as it is now) with the round's answer. */
export const raffledNft = (stash, answer, place) => stash?.nfts[weighted(stream(answer, [TAG.LOTTERY, place]), stash.weights)] ?? null;

/**
 * The NFT of the lottery's own stash each place of a drawn round that holds or draws one gets, in place order, as the
 * pulls take them out (`LotteryRound::assign`): the ones already taken out (`r.nfts`), then the rest as the stash
 * (`stash`, decoded as it is now) gives them, a named one found or one drawn by weight with the round's answer, each
 * taken out before the next. null for a place whose NFT isn't there (it gets nothing).
 */
export function stashNfts(r, stash) {
  const nfts = r.nfts.map((n, k) => (k < Number(r.assigned) ? (n === NO_ADDRESS ? null : n) : undefined));
  const rows = { nfts: [...(stash?.nfts ?? [])], weights: [...(stash?.weights ?? [])] };
  const take = (row) => {
    if (row == null || row < 0) return null;
    const nft = rows.nfts[row];
    const last = rows.nfts.length - 1;
    [rows.nfts[row], rows.weights[row]] = [rows.nfts[last], rows.weights[last]];
    rows.nfts.pop();
    rows.weights.pop();
    return nft;
  };
  const w = roundWinners(r);
  let [k, first] = [0, 0];
  for (const p of r.terms.places) {
    const times = Number(p.times);
    if (ownStash(p)) {
      for (let place = first; place < first + times && place < w; place++, k++) {
        if (nfts[k] !== undefined) continue;
        nfts[k] = p.prize?.Held ? take(rows.nfts.indexOf(p.prize.Held[0])) : take(weighted(stream(r.answer, [TAG.LOTTERY, place]), rows.weights));
      }
      k += Math.max(0, first + times - Math.max(first, w));
    }
    first += times;
  }
  return nfts.map((n) => n ?? null);
}

/** The program's rule for where a part nobody can take goes: the treasury's wallet, then its account of the mint. */
const treasuryAccounts = (treasury, mint, programs) => walletAccounts(treasury, mint, programs);

/**
 * Anyone (`payer`) pulls `part` of the round at `roundAddress` (`round` decoded; `partsOwed` and `commonOwed` say what is
 * owed):
 *   'Own'            entry `entry`'s own part: a refund, a no-loss ticket's price, or its NFT ticket back or where its
 *                    price sends it (`ticket` its kind as `piece` takes it; `handBack` when the wallet its price gives
 *                    it to is an account of the loot program; `hold`: made a hold for whoever it is owed to instead);
 *   { Pot: [run] }   the entry's places in the run, their part of the pot, paid into the buyer's account;
 *   { Prize: [run] } their prize: tokens into the buyer's account, or each place's prize (`prize`: { stash, the lottery's
 *                    own stash decoded, for NFTs not taken out yet (`stashNfts`); stashes, a project stash's id to its
 *                    decoded stash; nfts, an NFT's kind by its asset; hold, NFTs made holds; most, the most places a
 *                    pull carries; and what `prizeMetas` takes: collection, poolMints, items, projectMint }), a roll's
 *                    order at `prizeRollNonce(nonce + place)` (ask it in the same transaction: `pullRolls`);
 *   { Common: [i] }  a part owed in common: share `i`, the pot's (`i` = the shares' count), a pool's prize back after a
 *                    cancel (past it), paid where it goes (`holders`, `programs`); `toTreasury` when that can't take it
 *                    (a pool never opened, the pot closed since or made again in another mint, an account gone: a
 *                    holder nobody is is found here).
 * The pull that leaves nothing owed closes the round (`projectState`: its treasury and owner; `lotteryClosed` when the
 * lottery is gone, so rent it lent goes to the owner). A round that owes nothing and waits only for its close is closed
 * by any pull.
 */
export function pullIx({ payer, project, roundAddress: key, round: r, entry = 0, part = 'Own', projectState, ticket = {}, handBack = false, hold = false, nonce = 0n, prize = {}, holders = {}, toTreasury = false, lotteryClosed = false, programs, extra = [] }) {
  const rest = [];
  let [mint, to, settled, buyer, partial] = [null, null, 1, payer, false];
  const account = (m, wallet) => ata(wallet, m, tokenProgramOf(programs, m));
  const finished = roundFinished(r);
  const e = part.Common || finished ? null : r.entries[entry];
  if (e) buyer = e.buyer;
  if (finished) settled = 0;
  else if (part === 'Own' && e.nft !== NO_ADDRESS) {
    const back = r.status === 'Cancelled' || r.terms.returns;
    const then = back ? null : r.terms.nft_ticket?.then;
    if (hold) {
      rest.push(meta(pda.hold(e.nft, 0), false, true));
      if (then?.Give) rest.push(meta(then.Give[0], false, true));
    } else {
      // Where its price sends it (a stash keeps it where it is), or back to its buyer.
      const receiver = then ? spentTo(project, then) : null;
      const holder = then?.Stash || (handBack && then?.Give) ? e.buyer : receiver ?? e.buyer;
      const p = piece({ project, asset: e.nft, wallet: holder, ...ticket, moves: !then?.Stash, locks: false, burns: then === 'Burn' || Boolean(then?.Burn), reads: false });
      rest.push(...pieceMetas(p), ...p.proof, ...(receiver ? [meta(receiver, false, true)] : []));
    }
  } else if (part === 'Own') [mint, to] = [paymentMint(r.terms), account(paymentMint(r.terms), e.buyer)];
  else if (part.Common) {
    const i = Number(part.Common[0]);
    const n = r.terms.shares.length;
    let dest;
    if (i < n) [mint, dest] = [paymentMint(r.terms), r.terms.shares[i].to];
    else if (i === n) [mint, dest] = [r.terms.mint, { Account: [pda.pot(r.lottery)] }];
    else {
      const p = r.prizes[i - n - 1];
      [mint, dest] = [p.mint, r.terms.places[Number(p.run)].prize.Tokens.from];
    }
    rest.push(...destinationAccounts(project, dest, mint, { holders, programs, treasury: projectState?.treasury }));
    const nobody = dest.Holder && !holders[dest.Holder[0]];
    if (toTreasury || nobody) rest.push(...treasuryAccounts(projectState?.treasury, mint, programs));
  } else if (part.Pot || tokenRun(r, Number(part.Prize[0]))) {
    const run = Number((part.Pot ?? part.Prize)[0]);
    const p = part.Prize ? r.prizes.find((x) => Number(x.run) === run) : null;
    mint = p ? p.mint : r.terms.mint;
    to = account(mint, e.buyer);
    settled = placesPulled(r, entry, run, Boolean(part.Prize));
  } else {
    // Each of the entry's places in the run whose prize is not given yet, lowest first.
    const run = Number(part.Prize[0]);
    const given = r.terms.places[run].prize;
    const places = prizePlacesOwed(r, entry, run);
    const own = ownStash(r.terms.places[run]);
    const nfts = own ? stashNfts(r, prize.stash) : [];
    if (own) rest.push(meta(pda.lotteryStash(r.lottery), false, true));
    const handed = (asset) => (prize.hold ? [meta(pda.hold(asset, 0), false, true)] : (() => {
      const p = piece({ project, asset, wallet: e.buyer, ...(prize.nfts?.[asset] ?? {}), ...ONLY_MOVES });
      return [...pieceMetas(p), ...p.proof];
    })());
    let [carried, made, stashed] = [0, 0, false];
    for (const place of places) {
      if (own && nfts[nftSlot(r, place)] == null) continue;
      if (prize.most != null && carried >= prize.most) {
        partial = true;
        break;
      }
      carried += 1;
      if (own) rest.push(...handed(nfts[nftSlot(r, place)]));
      else if (given.Nft) {
        // A project stash's NFT, while the stash holds it: its stash, then the NFT (once: one place takes it).
        const { stash, nft: asset } = given.Nft;
        const holds = prize.stashes?.[stash] ? prize.stashes[stash].nfts.includes(asset) : true;
        rest.push(meta(pda.stash(project, stash), false, true));
        if (holds && !stashed) rest.push(...handed(asset));
        stashed ||= holds;
      } else {
        rest.push(...prizeMetas({ project, collection: prize.collection, prize: given, winner: e.buyer, nonce: BigInt.asUintN(64, toBigInt(nonce) + BigInt(place)), poolMints: prize.poolMints, items: prize.items, nft: prize.nfts?.[given.Item?.[0]], made, projectMint: prize.projectMint, programs }));
        if (given.Item) made += 1;
      }
    }
    settled = places.length;
  }
  const closes = finished || (!partial && (r.status === 'Drawn' || r.status === 'Cancelled') && Number(r.owed) <= settled);
  const owner = lotteryClosed ? projectState?.owner : null;
  if (closes) rest.push(...roundCloseMetas(key, r, owner));
  const opener = owner && r.opener === r.lottery ? owner : r.opener;
  return lootIx(
    'pull',
    { entry: part.Common || finished ? 0 : entry, part, nonce: toBigInt(nonce) },
    { payer, project, round: key, buyer, mint, vault: mint ? pda.roundTokens(key, mint) : null, to, opener: closes ? opener : null, treasury: closes ? projectState?.treasury : null },
    { remaining: [...rest, ...tailOf(extra)] },
  );
}

/** The orders the rolls a `{ Prize: [run] }` pull of entry `entry` makes (a place's prize that is a roll), each with its
 * box: [{ order, box }], at `prizeRollNonce(nonce + place)` for the entry's buyer. Ask each in the pull's transaction. */
export function pullRolls({ project, round: r, entry, part, nonce = 0n }) {
  const run = Number(part?.Prize?.[0] ?? -1);
  const given = r.terms.places[run]?.prize;
  if (!given?.Roll) return [];
  const buyer = r.entries[entry].buyer;
  return prizePlacesOwed(r, entry, run).map((place) => ({ order: pda.order(project, buyer, prizeRollNonce(BigInt.asUintN(64, toBigInt(nonce) + BigInt(place)))), box: given.Roll[0] }));
}

// ---------------------------------------------------------------- farms

/**
 * The owner opens farm `id`: of `stakedMint`'s tokens, or of collectibles when it is null. Its rewards are `rewardsMint`'s,
 * in its own rewards vault (`pda.rewards(farm)`), which anything funds by a plain transfer (a share or a schedule paying
 * `{ Account: [vault] }`): all that lands there, shared, or with `args.rate` ({ per_day, mints, shared, halve_every }) a
 * fixed rate, for each seat at x1 or with `shared` the whole farm's shared by weight, halving every `halve_every`
 * seconds from the farm's opening (0: never), minted when a seat is paid or paid from what the vault holds free while it
 * lasts (a rate of 0 pays nothing: a farm that only grows or gives prizes). `args.gates`: the rules an NFT must all
 * pass. `args.growth`: any number of { key, per_day, level, steps, streak, profile, at_least }, each writing points (and
 * a level) on what is staked, or with `profile` on the staker's profile (a token seat only while it stakes `at_least`);
 * a tier's `earns_for`: seconds a seat earns and grows after its lock started (0: no end). `args.ends_at`: when it ends
 * (0: never). For a farm of collectibles, `args.lock_key`: the attribute a staked NFT's lock is written under, as the
 * time it ends, so recipes and rolls can move it; `args.upkeep_key`: the attribute that says until when it earns and
 * grows (fuel). Empty: none. `args.exit_to`: where early-exit fees go, 'Burn', { Pool: [index] } or 'Rewards' (the
 * farm's own vault: a farm whose staked token is its rewards'). A farm whose seats can stop earning and that pays keeps a
 * record of when (`farmKeepsEnds`, `pda.ends`), made here at the owner's rent; each new time costs its writer `END_BYTES`.
 */
export const openFarmIx = ({ owner, project, id, args, rewardsMint, stakedMint = null }) => {
  if (!Array.isArray(args?.tiers)) throw new Error('A farm needs its lock tiers (`args.tiers`: [{ lock, bps }, …]).');
  const full = {
    gates: [], ends_at: 0, lock_key: '', upkeep_key: '', exit_to: null, ...args,
    rate: args.rate ? { mints: false, shared: false, halve_every: 0, ...args.rate } : null,
    tiers: args.tiers.map((t) => ({ prize: null, roll: null, exit_bps: 0, earns_for: 0, ...t })),
    growth: (args.growth ?? []).map((g) => ({ profile: false, at_least: 0n, ...g })),
  };
  return lootIx('open_farm', { id, args: full }, {
    owner, project, rewards_mint: rewardsMint, staked_mint: stakedMint,
    staked_vault: stakedMint ? pda.staked(pda.farm(project, id)) : null,
    exit_pool: sinkPool(project, full.exit_to),
    ends: farmKeepsEnds(full) ? pda.ends(pda.farm(project, id)) : null,
  }, {
    // Each box its tiers name to roll, tier by tier (its roll, then a prize that is a roll), once.
    remaining: boxesAccounts(project, full.tiers.flatMap((t) => [t.roll, t.prize?.Roll?.[0]].filter((x) => x != null))),
  });
};

/**
 * Whether a farm with these args keeps a record of when its seats stop earning (`Farm::keeps_ends`): a tier has a term
 * (`earns_for`) or the farm reads an upkeep (`upkeep_key`), and it pays something (no rate, or a rate above 0). The farm
 * and every move of it then pass the record (`WrongEnds` otherwise).
 */
export const farmKeepsEnds = (args) =>
  ((args.tiers ?? []).some((t) => BigInt(t.earns_for ?? 0) > 0n) || Boolean(args.upkeep_key)) && (!args.rate || BigInt(args.rate.per_day ?? 0) > 0n);

/** Where a farm's fee goes (`Sink`): the pool's address for `{ Pool: [index] }`, null for a burn, its own vault or none. */
const sinkPool = (project, sink) => (sink?.Pool ? pda.pool(project, sink.Pool[0]) : null);

const farmSide = (project, id, farm) => ({
  project,
  farm: pda.farm(project, id),
  rewards_mint: farm.rewards_mint,
  ends: farm.keeps_ends ? pda.ends(pda.farm(project, id)) : null,
});

/**
 * What a farm has to walk (`Farm::walk`): the times of its record of ends (`ends`, from `decodeEnds`; an empty list for none)
 * past its clock, up to `now` (Unix seconds, the chain's clock) or the farm's end. Every move walks all of them first, each a
 * little compute, so a farm idle past many ends may leave a move no room: `farmNeedsWalk`.
 */
export function endsToWalk(farm, ends, now) {
  const clock = BigInt(farm.clock ?? 0);
  const over = BigInt(farm.ends_at ?? 0);
  const stop = over > 0n && over < BigInt(now) ? over : BigInt(now);
  return ends.filter((e) => e.at > clock && e.at <= stop).length;
}

/** How many ends `walk_farm` walks in one transaction at `WALK_COMPUTE_UNITS`: an end takes at most some 2,300 units, with a
 * halving rate (`js/test/farm-ends.test.mjs` measures it). */
export const WALK_PER_TX = 500;
/** The compute units a transaction that walks ends asks for: `walk_farm`, or a move with ends to walk first. */
export const WALK_COMPUTE_UNITS = 1_400_000;
/** How many ends a move can walk first at `WALK_COMPUTE_UNITS` and still do its own work: past this, the farm is walked
 * first (`farmNeedsWalk`). */
export const MOVE_WALK_ROOM = 400;

/**
 * Whether a farm has passed more ends than a move can walk in its own transaction (`endsToWalk`, `MOVE_WALK_ROOM`): such
 * a move fails on compute until `walk_farm` has caught the farm up. Nothing is lost by waiting: what a seat earned by
 * its end is written when the farm walks past it, however late.
 */
export const farmNeedsWalk = (farm, ends, now) => endsToWalk(farm, ends, now) > MOVE_WALK_ROOM;

/**
 * The transactions that walk a farm up to now, oldest ends first: one `walkFarmIx` each, `perTx` ends at most, `[]` when
 * it has nothing to walk. Anyone may send them, in order; each is free but for its network fee.
 */
export function walkFarmParts({ project, id, farm, ends, now, perTx = WALK_PER_TX }) {
  const left = endsToWalk(farm, ends, now);
  const parts = [];
  for (let done = 0; done < left; done += perTx) parts.push(walkFarmIx({ project, id, farm, most: Math.min(perTx, left - done) }));
  return parts;
}

/**
 * Credits a farm up to at most `most` of the times its seats stopped earning. Anyone may send it, signing nothing but its
 * network fee: it decides nothing, every move walks the same times the same way. For a farm that has passed more of them
 * than a move's transaction can walk (`farmNeedsWalk`, `walkFarmParts`).
 */
export const walkFarmIx = ({ project, id, farm, most = WALK_PER_TX }) =>
  lootIx('walk_farm', { most }, farmSide(project, id, farm));
/** Whether a farm reads or writes its seats' players' profiles (`Farm::uses_profile`): a gate or a boost on a profile,
 * or a growth written on one. Its moves then pass the player's profile. */
const usesProfile = (farm) => [...(farm.gates ?? []), ...(farm.boosts ?? []).map((b) => b.rule)].some((r) => r?.of === 'Profile') || (farm.growth ?? []).some((g) => g.profile);
const profileOf = (project, farm, player) => (usesProfile(farm) ? pda.profile(project, player) : null);

/** What a move that pays a seat writes: the rewards' mint, when the farm mints at a fixed rate (it mints at payout). */
const payWrites = (farm) => (farm.rate?.mints ? ['rewards_mint'] : []);

/** A token seat's accounts; `paid`: rewards may be paid (an unstake), so the player's account of them comes. */
function tokenSeat({ player, project, id, farm, programs, paid = false }) {
  const mint = farm.farmed.Tokens.mint;
  const farmAddress = pda.farm(project, id);
  return {
    ...farmSide(project, id, farm),
    player,
    seat: pda.seat(farmAddress, player),
    staked_vault: pda.staked(farmAddress),
    mint,
    player_tokens: ata(player, mint, tokenProgramOf(programs, mint)),
    player_rewards: paid ? ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)) : null,
    exit_pool: sinkPool(project, farm.exit_to),
    profile: profileOf(project, farm, player),
  };
}

/**
 * `player` stakes `amount` at lock tier `tier`. `farm` is decoded; `extra` carries token hook/memo accounts. A seat with
 * a booster on, or one whose growth the stake changes, needs a `refreshSeatIx` of it first, in the same transaction
 * (`stakeRefreshFirst`).
 */
export const stakeTokensIx = ({ player, project, id, farm, amount, tier = 0, programs, shown, extra = [] }) =>
  lootIx('stake_tokens', { amount, tier }, tokenSeat({ player, project, id, farm, programs }), { remaining: [...shownAccounts(project, shown), ...tailOf(extra)] });

/**
 * `player` takes `amount` out (0: only collects what is owed); `forfeit` gives up rewards that can't move. Before the
 * tier's lock has run, a tier with an early-exit fee (`exit_bps`) lets it leave, leaving that share of `amount` to the
 * farm's `exit_to`; it keeps the rewards it was credited.
 */
export const unstakeTokensIx = ({ player, project, id, farm, amount, forfeit = false, programs, extra = [] }) =>
  lootIx('unstake_tokens', { amount, forfeit }, tokenSeat({ player, project, id, farm, programs, paid: !forfeit }), {
    remaining: tailOf(extra),
    // An exit fee that burns writes the staked mint; a farm that mints, its rewards' mint when it pays.
    writable: [...(forfeit ? [] : payWrites(farm)), ...(farm.exit_to === 'Burn' ? ['mint'] : [])],
  });

/**
 * Whether taking `amount` out of a token seat (decoded `seat`) needs a `refreshSeatIx` of it first, in the same
 * transaction (`RefreshFirst`): the farm grows, and the exit closes the seat or drops it below a growth's least stake, so
 * what it grew since its last refresh is written before it goes. Never under `forfeit`.
 */
export const refreshFirst = (farm, seat, amount, forfeit = false) =>
  !forfeit && BigInt(amount) > 0n && (farm.growth ?? []).some((g) => {
    const least = BigInt(g.at_least ?? 0) > 0n ? BigInt(g.at_least) : 1n;
    return BigInt(seat.amount) >= least && BigInt(seat.amount) - BigInt(amount) < least;
  });

/**
 * Whether a stake of tokens at `tier` in a token seat (decoded `seat`; null for a new one), or with `compound` a
 * compound of what it is owed, needs a `refreshSeatIx` of it first, in the same transaction (`RefreshFirst`), at `now`
 * (Unix seconds, the chain's clock): a seat with a booster on (its boost is read again there, so a top-up never stakes
 * more at a boost its booster no longer gives), or a seat that grows (a booster's growth, or its player's profile's)
 * when the stake changes how: a new tier, a farm whose growth reads the amount, a seat past its term; a compound when
 * that growth reads the amount.
 * @param {any} farm
 * @param {any} seat
 * @param {{ tier?: number, now?: bigint | number, compound?: boolean }} [options]
 */
export function stakeRefreshFirst(farm, seat, { tier = seat?.tier, now, compound = false } = {}) {
  if (!seat) return false;
  const growth = farm.growth ?? [];
  const booster = seat.asset !== undefined && seat.asset !== NO_ADDRESS;
  const grows = BigInt(seat.amount) > 0n && growth.some((g) => g.profile || booster);
  const amountGrows = growth.some((g) => g.profile || BigInt(g.at_least ?? 0) > 0n);
  if (compound) return BigInt(seat.amount) > 0n && (booster || (grows && amountGrows));
  const changes = Number(tier) !== Number(seat.tier) || amountGrows || (now !== undefined && BigInt(seat.earns_until ?? 0) <= BigInt(now));
  return booster || (grows && changes);
}

/**
 * Whether a booster put on a token seat of `farm` (decoded) needs the seat refreshed first, in the same transaction
 * (`stake_nft`'s `RefreshFirst`): in a farm of tokens whose growth writes its players' profiles, the booster's growth
 * starts from now, so what the seat grew before is written first.
 */
export const boosterRefreshFirst = (farm) => Boolean(farm.farmed?.Tokens) && (farm.growth ?? []).some((g) => g.profile);

/**
 * Whether a farm (decoded) takes a stake at lock tier `tier` at `now` (Unix seconds, the chain's clock), as the program
 * judges it: a farm with an end (`ends_at`, 0 for never) takes none at its end or after it, nor one whose lock
 * would run past it (`FarmOver`). A stake of tokens, a booster, a new tier and a watched NFT's takeover all ask it.
 */
export function farmOpenFor(farm, tier, now) {
  const ends = BigInt(farm.ends_at ?? 0);
  if (ends === 0n) return true;
  const t = BigInt(now);
  return t < ends && t + BigInt(farm.tiers[tier]?.lock ?? 0) <= ends;
}

export const AUTH_RULES_PROGRAM = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';

// ---------------------------------------------------------------- an NFT on a route (a `Piece`)

const NO_PIECE = {
  sheet: null, collection: null, mpl_core_program: null, metadata: null, edition: null, token: null, token_record: null, project_token: null, project_record: null,
  rule_set: null, rules_program: null, token_metadata_program: null, instructions: null, spl_token_program: null,
  spl_ata_program: null, leaf: null, tree: null, tree_config: null, leaf_delegate: null, bubblegum_program: null,
  compression_program: null, log_wrapper: null,
};

/**
 * Any NFT's accounts on a route (a farm, a hold, an auction's lot): `{ accounts, proof, writable }`, the proof going
 * first among the instruction's remaining accounts, `writable` the accounts to pass writable (`lootIx`'s option). The
 * NFT is one of:
 *   a Core asset (`asset`; `collection` its collection now; `hasAuthority` false for one the project has no authority
 *     over, whose Sheet is passed);
 *   a Token Metadata NFT (`asset` its mint, `tokenMetadata` { programmable, ruleSet } from `decodeTokenMetadata`): the
 *     token account of `wallet` (its holder, or whoever the project sends it to) and the project's own;
 *   a compressed NFT (`compressed`, from `compressedFromDas`), proven by a `proveLeafIx` earlier in the transaction.
 * A Token Metadata or compressed NFT passes its Sheet: the project writes nothing on it.
 * What the route does with it, so only the accounts it takes are passed (each true when left out):
 *   `moves`: hands it to the project or sends it on; `locks`: locks or unlocks it in its wallet; `writes`: writes on it;
 *   `burns`: burns a Core asset (false when left out); `reads`: reads its Sheet; `held`: reads it in the project's token
 *   account (an escrow farm).
 */
export function piece({ project, asset, wallet, collection, hasAuthority = true, tokenMetadata: tm, compressed: c, moves = true, locks = true, writes = true, burns = false, reads = true, held = moves }) {
  const sheetOf = (nft) => (reads || writes || burns ? pda.sheet(project, nft) : null);
  if (c) {
    // Bubblegum is called (and writes the leaf, its tree and its config) only to lock or move it.
    const calls = moves || locks;
    const delegate = calls && c.delegate !== c.owner && c.delegate !== project ? c.delegate : null;
    const bubblegum = calls
      ? { collection: c.collection ?? null, tree_config: pda.treeConfig(c.tree), leaf_delegate: delegate, bubblegum_program: BUBBLEGUM_PROGRAM, compression_program: COMPRESSION_PROGRAM, log_wrapper: NOOP_PROGRAM }
      : {};
    return {
      kind: 'compressed',
      accounts: { ...NO_PIECE, asset: c.id, sheet: sheetOf(c.id), leaf: pda.leaf(c.id), tree: c.tree, ...bubblegum },
      proof: c.proof.map((node) => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)),
      writable: calls ? ['leaf', 'tree', 'tree_config'] : [],
    };
  }
  if (tm) {
    // `tm.into`: the token account of `wallet`'s the NFT goes into when it is not their associated one (`freshNftAccount`).
    const token = tm.into ?? ata(wallet, asset, TOKEN_PROGRAM);
    const projectToken = ata(project, asset, TOKEN_PROGRAM);
    const pnft = Boolean(tm.programmable);
    // Token Metadata is called to lock it or move it; a move also takes the project's token account (and record) and the
    // ATA program, a pNFT's every call its records, rule set and the instructions sysvar.
    const calls = moves || locks;
    const records = calls && pnft;
    return {
      kind: 'tokenMetadata',
      accounts: {
        ...NO_PIECE, asset, sheet: sheetOf(asset), metadata: tokenMetadata.metadata(asset), token,
        edition: calls ? tokenMetadata.edition(asset) : null,
        token_record: records ? tokenMetadata.record(asset, token) : null,
        project_token: held || moves ? projectToken : null,
        project_record: records && moves ? tokenMetadata.record(asset, projectToken) : null,
        rule_set: records ? tm.ruleSet ?? TOKEN_METADATA_PROGRAM : null,
        rules_program: records ? (tm.ruleSet ? AUTH_RULES_PROGRAM : TOKEN_METADATA_PROGRAM) : null,
        token_metadata_program: calls ? TOKEN_METADATA_PROGRAM : null,
        instructions: moves || records ? SYSVAR_INSTRUCTIONS : null,
        spl_token_program: calls ? TOKEN_PROGRAM : null,
        spl_ata_program: moves ? ASSOCIATED_TOKEN_PROGRAM : null,
      },
      proof: [],
      writable: [],
    };
  }
  // A Core asset: its collection now (left out for one in none: the program supplies Core's own address). Core is
  // called to move, lock, write on or burn it; only a burn writes the collection.
  const inNone = !collection || collection === MPL_CORE_PROGRAM;
  const calls = moves || locks || writes || burns;
  return {
    kind: 'core',
    accounts: {
      ...NO_PIECE, asset, sheet: hasAuthority ? null : sheetOf(asset),
      collection: calls && !inNone ? collection : null, mpl_core_program: calls ? MPL_CORE_PROGRAM : null,
    },
    proof: [],
    writable: burns && !inNone ? ['collection'] : [],
  };
}

/** The accounts a further NFT of a call of several takes (`Piece::another`), after the first NFT's: only what its kind
 * needs, the program's own address for one left out, then its proof. The first NFT passes every program any needs. */
const ANOTHER = {
  core: ['asset', 'sheet', 'collection'],
  tokenMetadata: ['asset', 'sheet', 'metadata', 'edition', 'token', 'token_record', 'project_token', 'project_record', 'rule_set'],
  compressed: ['asset', 'sheet', 'collection', 'leaf', 'tree', 'tree_config', 'leaf_delegate'],
};
export function anotherMetas(p) {
  const writable = new Set([...p.writable, ...PIECE.filter((a) => a.writable).map((a) => a.name)]);
  return [...ANOTHER[p.kind].map((name) => (p.accounts[name] == null ? meta(LOOT_PROGRAM, false, false) : meta(p.accounts[name], false, writable.has(name)))), ...p.proof];
}

/** The programs every NFT of a call of several needs, on the first NFT's piece (the call's own): Core, Token Metadata's
 * and Bubblegum's, by what the others are. */
function withPrograms(first, others) {
  const kinds = new Set(others.map((p) => p.kind));
  const a = { ...first.accounts };
  if (kinds.has('core')) a.mpl_core_program ??= MPL_CORE_PROGRAM;
  if (kinds.has('tokenMetadata')) {
    a.token_metadata_program ??= TOKEN_METADATA_PROGRAM;
    a.spl_token_program ??= TOKEN_PROGRAM;
    a.spl_ata_program ??= ASSOCIATED_TOKEN_PROGRAM;
    a.instructions ??= SYSVAR_INSTRUCTIONS;
    a.rules_program ??= others.some((p) => p.accounts.rule_set && p.accounts.rule_set !== TOKEN_METADATA_PROGRAM) ? AUTH_RULES_PROGRAM : others.some((p) => p.accounts.token_record) ? TOKEN_METADATA_PROGRAM : null;
  }
  if (kinds.has('compressed')) Object.assign(a, { bubblegum_program: a.bubblegum_program ?? BUBBLEGUM_PROGRAM, compression_program: a.compression_program ?? COMPRESSION_PROGRAM, log_wrapper: a.log_wrapper ?? NOOP_PROGRAM });
  return { ...first, accounts: a };
}

/**
 * Several NFTs on one call (a hold, a stash, a farm's seats): their groups sorted by key (`keyOf`), the first the
 * call's own and each further one after it, in ascending order (`OutOfOrder` otherwise). Returns [first, ...rest].
 */
const ascending = (items, keyOf) => [...items].sort((a, b) => compareBytes(addressBytes(keyOf(a)), addressBytes(keyOf(b))));

/** The account an NFT paid goes to: the wallet it is given to, the stash it goes into, or the
 * incinerator for a burn (any account stands in for a Core asset, which Core burns). `then`: 'Burn', { Give: [wallet] }
 * or { Stash: [id] }. */
export function spentTo(project, then) {
  if (then.Give) return then.Give[0];
  if (then.Stash) return pda.stash(project, then.Stash[0]);
  return INCINERATOR;
}

/**
 * The accounts of an NFT `owner` pays with, after a route's own: the NFT as `piece` takes it, its proof,
 * then where it goes (`spentTo`). Given on or burned it moves straight from its owner: a Token Metadata NFT's
 * receiver's token account (and a pNFT's record of it) take the project's places; stashed, it is handed to the
 * project first. A Core asset burned writes its collection.
 */
export function nftPaid({ project, owner, then, asset, collection, hasAuthority, tokenMetadata: tm, compressed }) {
  const to = spentTo(project, then);
  // The route reads it first (its Sheet, for one the project has no authority over: `hasAuthority` false).
  const p = then.Stash
    ? piece({ project, asset, wallet: owner, collection, hasAuthority, tokenMetadata: tm, compressed, ...ONLY_MOVES, reads: true })
    : passedOn({ project, owner, receiver: to, burns: then === 'Burn' || Boolean(then.Burn), asset, collection, hasAuthority, tokenMetadata: tm, compressed, reads: true });
  return [...pieceMetas(p), ...p.proof, meta(to, false, Boolean(then.Stash))];
}

/** An NFT moving straight from `owner` to `receiver`, or burned by its owner (`burns`). */
function passedOn({ project, owner, receiver, burns, asset, collection, hasAuthority, tokenMetadata: tm, compressed, reads = false }) {
  // `tm.into` is the receiver's account here: the NFT leaves the owner's associated one.
  const p = piece({ project, asset, wallet: owner, collection, hasAuthority, tokenMetadata: tm && { ...tm, into: undefined }, compressed, ...ONLY_MOVES, burns: burns && !tm && !compressed, reads });
  if (tm) {
    const token = tm.into ?? ata(receiver, asset, TOKEN_PROGRAM);
    p.accounts.project_token = token;
    p.accounts.project_record = tm.programmable ? tokenMetadata.record(asset, token) : null;
  }
  return p;
}

/**
 * `player` pays with an NFT, any kind (as `piece` takes it): burned (`to` null: the incinerator's address goes in its
 * place), or given to the wallet `to` (the treasury, a partner). The receipt (`PaidNft`) is the record: an app admits the player when the NFT, where it went (`to`: a payment to the player's own wallet pays nothing) and the reference
 * are the ones it asked for. `extra`: Core's transfer adapters.
 */
export function payNftIx({ player, project, asset, to = null, collection, hasAuthority, tokenMetadata: tm, compressed, reference: ref, extra = [] }) {
  // An NFT paid goes to a wallet, never to the project's own address, where nothing could ever move it (ToTheProject).
  if (to === project) throw new Error('An NFT paid can’t go to the project’s own address: name a wallet, or burn it.');
  const receiver = to ?? INCINERATOR;
  const p = passedOn({ project, owner: player, receiver, burns: receiver === INCINERATOR, asset, collection, hasAuthority, tokenMetadata: tm, compressed });
  return lootIx('pay_nft', { reference: reference(ref) }, { player, project, ...p.accounts, to: receiver }, { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable });
}

/**
 * Whether a classic token account (its `{ owner, data }` as read) takes a Token Metadata NFT `mint` for `holder`: an
 * account of the Token program, of that mint, that `holder` owns, not frozen. Token Metadata refuses one another key
 * owns (a holder can hand their own associated account to another key) and a frozen one, so a route that hands the
 * NFT into it fails: then the NFT goes into a fresh account of the holder's (`freshNftAccount`).
 */
export function takesNft(account, holder, mint) {
  if (!account || account.owner !== TOKEN_PROGRAM || account.data.length < TOKEN_ACCOUNT_BYTES) return false;
  const data = account.data;
  return encodeBase58(data.subarray(0, 32)) === mint && encodeBase58(data.subarray(32, 64)) === holder && data[108] === 1;
}

/**
 * A fresh token account of `mint` that `holder` holds, which `payer` opens (and pays the rent of, the fixed
 * `TOKEN_ACCOUNT_RENT`, never an RPC's figure) at an address of its key and a seed (`addressWithSeed`): no new key
 * signs. Pass it as the NFT's `tokenMetadata.into` when the holder's associated account can't take it (`takesNft`).
 *
 * The seed names the holder and the mint (a hash of both), so each holder has their own 8 addresses (`index` 0 to 7) of
 * a payer's. `there` is the account at the address now, as read (null: nothing there): nothing there is opened with
 * `CreateAccountWithSeed`; an address that holds only lamports someone sent it (System's, no data), which
 * `CreateAccountWithSeed` refuses, is topped up to the rent (never more than `TOKEN_ACCOUNT_RENT`, whatever the RPC says
 * it holds) and allocated as the payer's seed account instead; a token account there that takes the NFT
 * needs nothing (`instructions` []). Anything else at the address (an account of the holder's that no longer takes it,
 * or lamports no account can hold: negative, or not a whole number) answers null: try the next `index`.
 */
export function freshNftAccount({ payer, holder, mint, index = 0, there = null }) {
  const seed = freshNftSeed(holder, mint, index);
  const address = addressWithSeed(payer, seed, TOKEN_PROGRAM);
  const init = initializeAccount3Ix({ account: address, mint, owner: holder });
  if (!there) return { address, instructions: [createAccountWithSeedIx({ from: payer, address, seed, lamports: TOKEN_ACCOUNT_RENT, space: TOKEN_ACCOUNT_BYTES, owner: TOKEN_PROGRAM }), init] };
  if (takesNft(there, holder, mint)) return { address, instructions: [] };
  if (there.owner !== SYSTEM_PROGRAM || there.data.length) return null;
  // The RPC's figure only lowers the top-up, never raises it past the rent: lamports that are negative or not a whole
  // number are no account's (a lying RPC), so the address is refused (a negative figure would have the payer send
  // that much more into the holder's account).
  const lamports = there.lamports ?? 0;
  const had = typeof lamports === 'bigint' ? lamports : Number.isSafeInteger(lamports) ? BigInt(lamports) : -1n;
  if (had < 0n) return null;
  const short = had < TOKEN_ACCOUNT_RENT ? TOKEN_ACCOUNT_RENT - had : 0n;
  return {
    address,
    instructions: [
      ...(short > 0n ? [transferLamports(payer, address, short)] : []),
      allocateWithSeedIx({ base: payer, address, seed, space: TOKEN_ACCOUNT_BYTES, owner: TOKEN_PROGRAM }),
      init,
    ],
  };
}

/** The seed of a holder's fresh account of a mint: `nft<index>:` and 26 base58 characters of sha256(holder | mint). */
const freshNftSeed = (holder, mint, index) => `nft${index}:${encodeBase58(sha256(concat(addressBytes(holder), addressBytes(mint)))).slice(0, 26)}`;

/** How many fresh accounts a payer may open for one holder and mint (`freshNftAccount`'s `index`). */
export const FRESH_NFT_ACCOUNTS = 8;

/** A token account's rent on every cluster (165 bytes). */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;

/** A route that only hands the NFT to the project or sends it on (a hold, an auction's lot, a refund): no Sheet, no write. */
const ONLY_MOVES = { moves: true, locks: false, writes: false, reads: false };

/** Whether `asset` goes as its hold (`["hold", asset, 0]`, passed in its piece's place): `hold` true for every NFT a
 * route owes, or a list of the assets to hold. */
const holds = (hold, asset) => (Array.isArray(hold) ? hold.includes(asset) : Boolean(hold));

/** A piece that reads no NFT: `at` (an auction's or a seat's own address) stands in for one. */
const standIn = (at) => ({ accounts: { ...NO_PIECE, asset: at }, proof: [], writable: [] });

/**
 * A compressed NFT's record (`pda.leaf`) closes, its rent back to `payer`, who paid it: at any time with `payer` signing
 * (`signs`, the default), or by anyone once it no longer matches its tree. A route that finds no record asks for a proof
 * again (`NotProven`), so a client closes it in the transaction that used it (`withLeafCloses`).
 */
export const closeLeafIx = ({ asset, tree, payer, signs = true }) => lootIx('close_leaf', {}, { record: pda.leaf(asset), tree, payer, project: null, edition: null }, { signer: signs ? ['payer'] : [] });

const PROVE_LEAF = leaves(instructionDef('prove_leaf').accounts).map((a) => a.name);
const CLOSE_LEAF = leaves(instructionDef('close_leaf').accounts).map((a) => a.name);
const isLoot = (ix, name) => ix.programId === LOOT_PROGRAM && instructionOf(ix.data)?.name === name;

/**
 * `instructions` with a `close_leaf` after them for each compressed NFT's record a `prove_leaf` among them makes, its
 * prover signing as the record's payer, so the record's rent comes back in the same transaction (one closed already is
 * left alone).
 */
export function withLeafCloses(instructions) {
  const at = (ix, names, name) => ix.keys[names.indexOf(name)]?.pubkey;
  const closed = new Set(instructions.filter((ix) => isLoot(ix, 'close_leaf')).map((ix) => at(ix, CLOSE_LEAF, 'record')));
  const closes = [];
  for (const ix of instructions.filter((x) => isLoot(x, 'prove_leaf'))) {
    const record = at(ix, PROVE_LEAF, 'record');
    if (closed.has(record)) continue;
    closed.add(record);
    closes.push(closeLeafIx({ asset: at(ix, PROVE_LEAF, 'asset'), tree: at(ix, PROVE_LEAF, 'tree'), payer: at(ix, PROVE_LEAF, 'signer') }));
  }
  return closes.length ? [...instructions, ...closes] : instructions;
}

/**
 * Anyone closes the Sheet of an NFT that is burned: `burned` is what shows it (the Core asset's own address, burned to
 * one byte; a Token Metadata mint holding none; or a compressed NFT's record proving its leaf burned). Its rent goes to
 * the project's `treasury` wallet. A compressed NFT's (`tree`: the tree it was minted in) closes only on a record proven
 * empty (its data hash all zeros: a live leaf of the default owner is not burned) that still reads against that tree,
 * or whose tree is gone: the tree goes in the edition's place, and `burned` defaults to the NFT's record
 * (`pda.leaf`). A Token Metadata NFT's (`tokenMetadata`: true, or its kind) names its edition, which must be closed
 * too: its mint holds none, with no mint authority but its edition (`NotBurned` otherwise).
 */
export const closeSheetIx = ({ project, nft, tree = null, burned = tree ? pda.leaf(nft) : nft, treasury, tokenMetadata: tm = null }) =>
  lootIx('close_leaf', {}, { record: pda.sheet(project, nft), tree: burned, payer: treasury, project, edition: tm ? tokenMetadata.edition(nft) : tree });

/**
 * Anyone proves a compressed NFT's leaf (`compressed` from `compressedFromDas`): put it before the instruction that
 * uses the NFT, in the same transaction. The proof must be against the tree's current root (`StaleProof` otherwise:
 * fetch it again). Its record is read only while the tree is as it was then. Bubblegum's config of the tree comes
 * with it: only a tree Bubblegum made has one.
 */
export const proveLeafIx = ({ signer, compressed: c }) =>
  lootIx('prove_leaf', {
    leaf: { root: c.root, data_hash: c.dataHash, creator_hash: c.creatorHash, asset_data_hash: c.assetDataHash ?? null, flags: c.flags, nonce: c.nonce },
  }, {
    signer, asset: c.id, record: pda.leaf(c.id), owner: c.owner, delegate: c.delegate, collection: c.collection ?? BUBBLEGUM_PROGRAM, tree: c.tree,
    tree_config: pda.treeConfig(c.tree),
  }, { remaining: c.proof.map((node) => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)) });

/** The project's owner or authority vouches for NFTs' off-chain traits: `root` of a `traitsTree`, under `key`. */
export const setTraitsIx = ({ signer, project, key, root }) => lootIx('set_traits', { key, root }, { signer, project, traits: pda.traits(project, key) });

/** Anyone writes `nft`'s traits ([{ key, value }]) into its Sheet in `project`, by its `proof` in the tree under `key`. */
export const proveTraitsIx = ({ signer, project, key, nft, attributes, proof }) =>
  lootIx('prove_traits', { attributes, proof }, { signer, traits: pda.traits(project, key), nft, sheet: pda.sheet(project, nft) });

/** What a farm does with a seat's NFT (`piece`'s flags): kept as its custody says, written on as it grows. */
const farmKeeps = (farm, { writes = false, rolls = false } = {}) => ({
  moves: farm.custody === 'Escrow' || rolls,
  locks: farm.custody === 'Freeze',
  writes,
  held: farm.custody === 'Escrow',
});

function nftSeat({ player, project, id, farm, asset, collection, hasAuthority = true, tokenMetadata: tm, compressed, previous = null, programs, leaving = false, keeps }) {
  const farmAddress = pda.farm(project, id);
  const p = piece({ project, asset, wallet: player, collection, hasAuthority, tokenMetadata: tm, compressed, ...keeps });
  const key = compressed ? compressed.id : asset;
  return {
    kind: p.kind,
    accounts: {
      ...farmSide(project, id, farm),
      player,
      ...p.accounts,
      previous,
      seat: pda.seat(farmAddress, farm.farmed.Tokens ? player : key),
      // Rewards are paid only as an NFT's own seat leaves.
      player_rewards: leaving && !farm.farmed.Tokens ? ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)) : null,
      profile: profileOf(project, farm, player),
    },
    proof: p.proof,
    writable: p.writable,
  };
}

/** A further seat's group of a call of several (`NftSeat`): the seat, its NFT's accounts (`anotherMetas`), its box and
 * order leaving a mission that rolls (the program's address for none), then its proof (and an unstake's prize's). */
const seatGroup = (seat, p, box = null, order = null) => [meta(seat, false, true), ...anotherMetas({ ...p, proof: [] }), meta(box ?? LOOT_PROGRAM, false, false), meta(order ?? LOOT_PROGRAM, false, Boolean(order)), ...p.proof];

/**
 * `player` stakes an NFT: on a seat of its own in a farm of collectibles, or as the booster of the player's token seat
 * in a farm of tokens. Any kind (`piece`): a Core asset, a Token Metadata NFT's mint with `tokenMetadata`, or
 * `compressed` (after a `proveLeafIx` in the same transaction). `previous`: in a farm that watches, the last staker of
 * an NFT that changed hands, whose seat this takes over (alone). In a farm of collectibles, `more` NFTs (each { asset,
 * collection, hasAuthority, tokenMetadata, compressed }) go in the same call at the same tier, one fee, by their seats'
 * addresses. `extra` carries reward token hooks/memos and Core transfer adapter accounts.
 */
export const stakeNftIx = ({ player, project, id, farm, asset, collection, hasAuthority = true, tokenMetadata: tm, compressed, previous = null, tier = 0, programs, more = [], extra = [] }) => {
  // Its lock's end, when the farm keeps one, is written on it.
  const keeps = farmKeeps(farm, { writes: Boolean(farm.lock_key) });
  const [first, ...rest] = ascending([{ asset, collection, hasAuthority, tokenMetadata: tm, compressed }, ...more].map((n) => nftSeat({ player, project, id, farm, ...n, previous, programs, keeps })), (x) => x.accounts.seat);
  const seat = withPrograms({ ...first, kind: first.kind }, rest);
  const groups = rest.flatMap((x) => seatGroup(x.accounts.seat, x));
  return lootIx('stake_nft', { tier }, seat.accounts, { remaining: [...seat.proof, ...groups, ...tailOf(extra)], writable: seat.writable });
};

/**
 * `player` takes an NFT out once its lock has run: it grows on its way out (a farm with growth writes on it, or on its
 * Sheet), and from its own seat takes its tier's prize. `forfeit` gives up the rewards and the prize. Leaving a tier
 * that rolls (`roll`: its box id, `boxes` its decoded box by id), the NFT is rolled on that box, in an order named by
 * `nonce` (`namedRollNonce`: the NFT's own on a box that holds it; its player or the project's keys then ask the oracle,
 * `askRollIx`, and settles); a box that can burn it or give it away keeps it in the project's hands until then. `more`
 * NFTs of the player's in the farm (each { asset, collection, hasAuthority, tokenMetadata, compressed, tier, roll }) leave
 * in the same call, one fee, one transfer of rewards: by their seats' addresses, the `i`th's roll at `nonce + 2i` and its
 * prize's at `nonce + 2i + 1` (`seatNonces` says which NFT has which). One still locked refuses the whole call.
 */
export const unstakeNftIx = ({ player, project, id, farm, asset, collection, hasAuthority = true, tokenMetadata: tm, compressed, forfeit = false, roll = null, nonce = 0n, tier, projectCollection, poolMints, items, nft, boxes = {}, programs, more = [], extra = [] }) => {
  const seats = ascending([{ asset, collection, hasAuthority, tokenMetadata: tm, compressed, tier, roll }, ...more].map((n) => {
    // It grows on its way out; a mission that rolls may hand it to the project.
    const keeps = farmKeeps(farm, { writes: Boolean(farm.growth?.length), rolls: n.roll != null });
    return { n, seat: nftSeat({ player, project, id, farm, ...n, programs, leaving: true, keeps }) };
  }), (x) => x.seat.accounts.seat);
  const several = seats.length > 1;
  // Each seat's mission: the box and the order its roll is made in, at `nonce + 2i`; its prize (its tier's) after its
  // proof, a roll's order at `nonce + 2i + 1`. A forfeit takes neither the prize nor the rewards (the program reads
  // neither), so a call of one passes neither: the smallest way out. In a call of several each seat with a prize passes
  // its accounts, given or not, so the next seat's start where the program looks.
  const parts = seats.map(({ n, seat }, i) => {
    const at = BigInt.asUintN(64, toBigInt(nonce) + 2n * BigInt(i));
    const prize = n.tier != null && (!forfeit || several) ? farm.tiers[n.tier]?.prize : null;
    const prized = prize ? prizeMetas({ project, collection: projectCollection ?? n.collection, prize, winner: player, nonce: BigInt.asUintN(64, at + 1n), poolMints, items, nft, programs }) : [];
    const rolls = n.roll != null ? { box: pda.box(project, n.roll), order: pda.order(project, player, namedRollNonce(boxes[n.roll], seat.accounts.asset, at)) } : { box: null, order: null };
    return { seat, prize, prized, rolls };
  });
  const [first, ...rest] = parts;
  const seat = withPrograms(first.seat, rest.map((x) => x.seat));
  if (forfeit) seat.accounts.player_rewards = null;
  const groups = rest.flatMap((x) => [...seatGroup(x.seat.accounts.seat, x.seat, x.rolls.box, x.rolls.order), ...x.prized]);
  return lootIx('unstake_nft', { forfeit, nonce }, { ...seat.accounts, loot_box: first.rolls.box, order: first.rolls.order, associated_token_program: parts.some((x) => x.prize?.Tokens) ? ASSOCIATED_TOKEN_PROGRAM : null }, {
    remaining: [...seat.proof, ...first.prized, ...groups, ...tailOf(extra)],
    writable: [...(forfeit ? [] : payWrites(farm)), ...seat.writable],
  });
};

/** The nonce each NFT's mission roll is named by in an `unstakeNftIx` of several (`assets`), in the order the call
 * takes them: the `i`th by its seat's address `nonce + 2i` (its order at `namedRollNonce` of it), its prize's roll
 * `nonce + 2i + 1` (at `prizeRollNonce`). */
export const seatNonces = (project, id, farm, player, assets, nonce = 0n) =>
  Object.fromEntries(ascending(assets, (a) => pda.seat(pda.farm(project, id), farm.farmed.Tokens ? player : a)).map((a, i) => [a, toBigInt(nonce) + 2n * BigInt(i)]));

/**
 * `player` collects what the seat of `by` owes (their own address for tokens, a collectible's asset); with `compound`, a
 * token seat's is staked instead (a seat with a booster on needs a `refreshSeatIx` of it first: `stakeRefreshFirst`). `held`: in a farm
 * that watches, what shows the player still holds the seat's NFT (the Core asset, their token account of a Token
 * Metadata NFT, or a compressed NFT's record, `pda.leaf`, with its `tree`), which such a farm refuses to go without
 * (`NotProven`). `more` seats of the player's in the farm (each { by, held, tree }) collect in the same call, one fee,
 * one transfer.
 */
export const harvestIx = ({ player, project, id, farm, by = player, held = null, tree = null, compound = false, programs, more = [], extra = [] }) => {
  const farmAddress = pda.farm(project, id);
  const [first, ...rest] = ascending([{ by, held, tree }, ...more].map((x) => ({ ...x, seat: pda.seat(farmAddress, x.by) })), (x) => x.seat);
  const groups = rest.flatMap((x) => [meta(x.seat, false, true), meta(x.held ?? LOOT_PROGRAM, false, false), meta(x.tree ?? LOOT_PROGRAM, false, false)]);
  return lootIx('harvest', { compound }, {
    ...farmSide(project, id, farm),
    player,
    seat: first.seat,
    player_rewards: ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)),
    held: first.held,
    tree: first.tree,
    // Compounding moves what is owed into the staked vault (a farm of tokens whose rewards are the staked token).
    staked_vault: compound ? pda.staked(farmAddress) : null,
  }, { remaining: [...groups, ...tailOf(extra)], writable: payWrites(farm) });
};

/**
 * Anyone (`signer`) writes what a seat's NFT grew (a farm with growth), then reads its boosts again. `seat` is the
 * decoded Seat of `by`. Its NFT is any kind (`piece`): a Core asset (`collection` its collection now, the project's when
 * left out; `hasAuthority` false for one the project has no authority over), a Token Metadata NFT (`tokenMetadata`), or
 * `compressed` (after a `proveLeafIx`). What shows where it is must come: a compressed NFT's proof, and a Token Metadata
 * NFT's token account that holds it, `holder`'s (its staker's, or a watched NFT's buyer's). `signer` pays for what the
 * write adds. `extra`: the reward mint's hook accounts.
 */
export const refreshSeatIx = ({ signer, project, id, farm, by, seat, collection, hasAuthority = true, tokenMetadata: tm, compressed, holder = seat.player, extra = [] }) => {
  const address = pda.seat(pda.farm(project, id), by);
  // A token seat with no booster: its own address stands in for the NFT.
  const p = seat.asset === NO_ADDRESS
    ? standIn(address)
    : piece({ project, asset: seat.asset, wallet: holder, collection, hasAuthority, tokenMetadata: tm, compressed, ...farmKeeps(farm, { writes: Boolean(farm.growth?.length) }), moves: false, locks: false });
  return lootIx('refresh_seat', {}, { signer, ...farmSide(project, id, farm), seat: address, ...p.accounts, profile: profileOf(project, farm, seat.player) }, { remaining: tailOf(extra), writable: p.writable });
};

// ---------------------------------------------------------------- recipes and holds

/**
 * `player` crafts recipe `id` (`recipe` decoded, the version shown to them), `times` over. `assets`: the
 * collectibles handed in, in the recipe's order (the burned, the used, and for a `Show` line the NFT shown: its address
 * when it is the project's, `{ asset, collection }` for a Core NFT of another collection, `{ mint, owner }` for a Token
 * Metadata one, `{ compressed, tree }` for a compressed one; with `farm` (a farm's id: `{ asset, farm }` for the
 * project's own) when the project locks it in the player's wallet on a seat of that farm, which freezes, and a raise on
 * it lowers a number: its seat and farm follow it, and the raise may not lower a number that farm reads; for a `Trade` line the NFT traded in, as `piece` takes it: `{ asset, collection, tokenMetadata,
 * compressed }`). A collectible used that is staked in a farm holding it for the player (escrow) or locking it in their
 * wallet (freeze) is `{ asset, farm }`, `farm` that farm's id: its seat and farm follow it (a raise on it may not lower a
 * number its farm reads: `BadRecipe`). A `Staked` line names the farm its collectible
 * is staked in (`Input::Staked { item, farm }`, escrowed or frozen there): its address, or `{ asset, farm }` with that
 * farm, and its seat and that farm follow it. Each item line passes its item's collection
 * (`items[id].collection`, the decoded Items; `collection` when not given), written for a burn: Core writes it as it
 * burns a collectible. A recipe's `raises` write on the kept ones, in their Sheet when the project has no
 * authority over them. The player opens any account a line pays into that is not there. A roll it makes (a
 * `Prize::Roll` or a `RollOn`) passes its box and its order, nothing more; a `RollOn`'s order is where `namedRollNonce`
 * says, which reads the rolled box (`boxes`: a box's id to its decoded LootBox). Its player or the project's keys then ask for the roll
 * (`askRollIx`, in the same transaction when it fits).
 * A craft makes several Core calls: raise the compute limit. `extra`: a token's hook accounts.
 */
export function craftIx({ player, project, collection, id, recipe, assets = [], times = 1, nonce = 0n, holders, programs, treasury, poolMints, items = {}, nfts = {}, boxes = {}, extra = [] }) {
  const remaining = [];
  const given = [...assets];
  const tokens = (mint) => ata(player, mint, tokenProgramOf(programs, mint));
  const itemLine = (itemId, burns = false) => [meta(pda.item(project, itemId), false, false), meta(items[itemId]?.collection ?? collection, false, burns)];
  for (const input of recipe.inputs) {
    if (input.Burn) {
      remaining.push(...itemLine(input.Burn.item, true));
      for (let i = 0; i < input.Burn.count; i++) remaining.push(meta(take(given, 'a collectible to burn'), false, true));
    } else if (input.Use || input.Staked) {
      remaining.push(...itemLine((input.Use ?? input.Staked).item));
      const used = take(given, 'a collectible to use');
      // A staked one is on its seat in the farm its line names.
      if (input.Staked && typeof used !== 'string' && used.farm !== undefined && Number(used.farm) !== input.Staked.farm)
        throw new Error(`craft: the recipe takes this collectible staked in farm ${input.Staked.farm}, not farm ${used.farm}`);
      const seated = input.Staked ? { asset: typeof used === 'string' ? used : used.asset, farm: input.Staked.farm } : used;
      if (typeof seated === 'string') remaining.push(meta(seated, false, true));
      else {
        // On a seat: its seat and its farm follow it.
        const farm = pda.farm(project, seated.farm);
        remaining.push(meta(seated.asset, false, true), meta(pda.seat(farm, seated.asset), false, false), meta(farm, false, false));
      }
    } else if (input.Pay) {
      const { mint, to } = input.Pay;
      remaining.push(meta(mint, false, true), meta(tokens(mint), false, true), ...destinationAccounts(project, to, mint, { holders, programs, treasury }));
    } else if (input.Trade) {
      // Any NFT of the line's collection, traded in: burned, given on or stashed (`nftPaid`).
      const nft = take(given, 'an NFT to trade in');
      remaining.push(...nftPaid({ project, owner: player, then: input.Trade.then, ...(typeof nft === 'string' ? { asset: nft, collection: input.Trade.collection } : nft) }));
    } else if (input.Show) {
      // Any NFT, kept: one of the project's (its address), a Core asset of another collection ({ asset, collection }:
      // with its Sheet, then its collection), a Token Metadata NFT ({ mint, owner }: its metadata, the holder's
      // token account and its Sheet), or a compressed NFT ({ compressed, tree }: its record, proven earlier in the
      // transaction, its tree and its Sheet). What a raise writes on is writable.
      // One the project locks in the player's wallet on a seat of a farm that freezes (`farm`, that farm's id) has its
      // seat and farm after its accounts, when a raise on it lowers a number.
      const place = assets.length - given.length;
      const nft = take(given, 'an NFT to show');
      if (typeof nft === 'string' || (nft.asset && nft.farm !== undefined && !('collection' in nft))) remaining.push(meta(nft.asset ?? nft, false, true), meta(input.Show.collection, false, false));
      else if (nft.asset) remaining.push(meta(nft.asset, false, true), meta(pda.sheet(project, nft.asset), false, true), meta(nft.collection ?? MPL_CORE_PROGRAM, false, false));
      else if (nft.compressed) remaining.push(...[nft.compressed, pda.leaf(nft.compressed), nft.tree].map((key) => meta(key, false, false)), meta(pda.sheet(project, nft.compressed), false, true));
      else remaining.push(...[nft.mint, tokenMetadata.metadata(nft.mint), ata(nft.owner ?? player, nft.mint, TOKEN_PROGRAM)].map((key) => meta(key, false, false)), meta(pda.sheet(project, nft.mint), false, true));
      const lowers = (recipe.raises ?? []).some((raise) => Number(raise.place) === place && BigInt(raise.shift.by) < 0n);
      if (lowers && typeof nft !== 'string' && nft.farm !== undefined && nft.farm !== null) {
        const farm = pda.farm(project, nft.farm);
        remaining.push(meta(pda.seat(farm, nft.asset ?? nft.compressed ?? nft.mint), false, false), meta(farm, false, false));
      }
    }
  }
  const made = {};
  for (const output of recipe.outputs) {
    if (output.Prize) {
      // A prize (`prizeMetas`): collectibles of one item made in order, each at the next serial.
      const prize = output.Prize[0];
      const item = prize.Item?.[0];
      remaining.push(...prizeMetas({ project, collection, prize, winner: player, nonce, poolMints, items, nft: nfts[prize.Nft?.nft], made: made[item] ?? 0, programs }));
      if (item !== undefined) made[item] = (made[item] ?? 0) + 1;
    } else if (output.RollOn) {
      // The box, then the order its roll is made in (`namedRollNonce` of the craft's `nonce`).
      const on = assets[output.RollOn.place];
      const order = pda.order(project, player, namedRollNonce(boxes[output.RollOn.box_id], typeof on === 'string' ? on : on?.asset ?? on?.mint ?? on?.compressed, nonce));
      remaining.push(meta(pda.box(project, output.RollOn.box_id), false, false), meta(order, false, true));
    }
  }
  const address = pda.recipe(project, id);
  const counts = limits(recipe.per_wallet) ? pda.counts(project, player) : null;
  return lootIx('craft', { version: recipe.version, times, nonce }, { player, project, recipe: address, counts }, { remaining: [...remaining, ...tailOf(extra)] });
}

function take(list, what) {
  if (!list.length) throw new Error(`craft: missing ${what}`);
  return list.shift();
}

/** The collectibles a craft of `recipe` makes: one per `Item` prize among its outputs. */
export const craftNewAssets = (recipe) => recipe.outputs.filter((o) => o.Prize?.[0]?.Item).length;

/**
 * `player` hands an NFT to the project until `freeAt` (Unix seconds; the hold's address names it, `pda.hold`): a Core
 * asset (`collection` its own, Core's address for none), a Token Metadata NFT (`tokenMetadata`), or `compressed` (after
 * a `proveLeafIx`).
 */
export function holdIx({ player, project, collection, asset, tokenMetadata: tm, compressed, freeAt, reference: ref, more = [] }) {
  // Several NFTs (`more`: each { asset, collection, tokenMetadata, compressed }) go on holds of their own with one end, one
  // fee: by their holds' addresses, the first the call's own.
  const [first, ...rest] = ascending([{ asset, collection, tokenMetadata: tm, compressed }, ...more].map((n) => {
    const p = piece({ project, asset: n.asset, wallet: player, collection: n.collection, tokenMetadata: n.tokenMetadata, compressed: n.compressed, ...ONLY_MOVES });
    return { p, hold: pda.hold(p.accounts.asset, freeAt) };
  }), (x) => x.hold);
  const p = withPrograms(first.p, rest.map((x) => x.p));
  const groups = rest.flatMap((x) => [meta(x.hold, false, true), ...anotherMetas(x.p)]);
  return lootIx('hold', { free_at: toBigInt(freeAt), reference: reference(ref) }, { player, project, ...p.accounts, hold: first.hold }, { remaining: [...p.proof, ...groups], writable: p.writable });
}

// ---------------------------------------------------------------- stashes

/**
 * The project's owner or authority (`signer`) puts an NFT it holds into stash `id`, or (`out`: a wallet) takes one the
 * stash holds out to that wallet. The NFT is any kind, as `piece` takes it: `collection` a Core asset's own,
 * `tokenMetadata`, or `compressed` after a `proveLeafIx` in the same transaction. The signer pays what the stash grows
 * by, and gets back the rent it no longer needs. `drop`: the NFT leaves the stash and stays where it is, owed to the
 * treasury in its hold (`["hold", nft, 0]`, the signer paying its rent until anyone `release`s it to the treasury, one
 * NFT a call). `out` is never the project's own address nor another account of the program (`ToTheProject`).
 */
export function stashIx({ signer, project, id, lottery = null, lotteryState = null, asset, out = null, drop = false, weight = 1, collection, tokenMetadata: tm, compressed, more = [] }) {
  if (drop && more.length) throw new Error('A stash drops one NFT a call.');
  if (drop) out = pda.hold(compressed?.id ?? asset, 0);
  const to = out ?? signer;
  // A lottery's own stash (`lottery`: the lottery's id): an NFT its place names leaves only as that prize, or once the
  // lottery has ended; taking one out passes the lottery.
  const own = lottery != null ? pda.lottery(project, lottery) : null;
  const stash = own ? pda.lotteryStash(own) : pda.stash(project, id);
  // Out to a wallet or the project's own address, never another account of the program (a record, a stash, a fee
  // box), where no record names the NFT and nothing could move it again (ToTheProject): the ones this call names are
  // refused before sending, and the program refuses any other (js/play only takes one out to the signer's wallet).
  if (out && !drop && [project, stash, own, pda.fees(project), pda.platform()].includes(out))
    throw new Error('An NFT taken out of a stash can’t go to the project or an account of the program: name a wallet, or drop it (`drop`: it stays, owed to the treasury).');
  // Several NFTs (`more`: each { asset, weight, collection, tokenMetadata, compressed }) go in or out in one call, one
  // fee, in ascending order of their addresses; put in, each weighs its `weight` in the stash's draws.
  const [first, ...rest] = ascending([{ asset, weight, collection, tokenMetadata: tm, compressed }, ...more].map((n) => ({
    n, p: piece({ project, asset: n.asset, wallet: drop ? project : to, collection: n.collection, tokenMetadata: n.tokenMetadata, compressed: n.compressed, ...ONLY_MOVES }),
  })), (x) => x.p.accounts.asset);
  const p = withPrograms(first.p, rest.map((x) => x.p));
  const weights = out ? [] : [first, ...rest].map((x) => x.n.weight ?? 1);
  // A lottery's own stash names the lottery, and the round it waits on (`idleRound`; `lotteryState`: the decoded
  // Lottery; none for one never written), whose places say what it locks.
  const round = own && lotteryState ? idleRound(own, lotteryState) : null;
  return lootIx('stash', { of: own ? { Lottery: [lottery] } : { Project: [id] }, out: Boolean(out), weights }, { signer, project, stash, to, ...p.accounts, lottery: own, round }, { remaining: [...p.proof, ...rest.flatMap((x) => anotherMetas(x.p))], writable: p.writable });
}

// ---------------------------------------------------------------- contests

/**
 * `player` backs `side` with `amount`, naming the contest's incarnation (which fixes its terms). `contest` is the
 * decoded Contest. A contest of NFTs (`contest.nft`) takes one NFT instead (`nft`: { asset, collection, tokenMetadata,
 * compressed }, as `piece` takes it), which the contest holds until it is claimed. `shown`/`listProof` pass its gate.
 * A new entry's record is the player's to pay (not refunded). `extra`: a hook's accounts.
 */
export function enterIx({ player, project, id, contest, side, amount, shown, listProof, nft, playerToken, programs, extra = [] }) {
  const address = pda.contest(project, id);
  // Read for its rule (with its Sheet, for an NFT the project has no authority over), then handed to the project.
  const staked = contest.nft ? piece({ project, wallet: player, ...nft, ...ONLY_MOVES, reads: true }) : null;
  return lootIx(
    'enter',
    { side, amount: contest.nft ? 1n : amount, incarnation: contest.incarnation },
    {
      player,
      project,
      contest: address,
      entries: contestEntries(address, contest),
      player_token: playerToken ?? ata(player, contest.mint, tokenProgramOf(programs, contest.mint)),
      mint: contest.mint,
    },
    { remaining: [...gateAccounts(project, { gate: contest.gate, wallet: player, shown, listProof }), ...(staked ? [...pieceMetas(staked), ...staked.proof] : []), ...tailOf(extra)] },
  );
}

/**
 * Anyone (`payer`) claims `player`'s entry (`entries`: the contest's decoded entries, `decodeEntries`), into the
 * player's account of the mint, which `payer` opens when it is not there. A winner's first claim also gives the
 * contest's prize (`prizeMetas`: `collection`, `poolMints`, `items`, `nft`; a roll's order at `nonce`, `prizeNonce` of the
 * contest and the player by default), unless the player (signing) `forgo`es it. In a contest of NFTs it moves the NFTs of
 * the entries `nfts` names by their place in the list (the player's own by default, while the contest holds it): an
 * entry's own back to its player (anyone sends it); a loser's to the winner while it has picks left of its share (only
 * the winner sends it, and picks which: `WinnerPicks`), or to the opener once no winner has picks left. `kinds` maps an
 * NFT to its kind, as `piece` takes it. With `hold` (true, or a list of assets), each becomes a hold for the wallet it goes to (an NFT that can't
 * move now); with `end`, the winner leaves the rest of its share to the opener. The claim that leaves nothing owed
 * closes the contest (`projectState`: its treasury); a contest that owes nothing (nobody entered, every part claimed,
 * off by itself with none in) is closed by any claim, the `payer`'s. `extra`: a hook's accounts.
 */
export function claimIx({ payer, project, projectState, id, contest, entries, player, nfts, kinds = {}, nonce, collection, poolMints, items, nft, prizeMint, forgo = false, end = false, hold = false, programs, extra = [] }) {
  const address = pda.contest(project, id);
  // A contest that owes nothing (nobody entered, or every part claimed) is only closed: by any claim, entry 0, any player.
  const closing = BigInt(contest.owed) === 0n;
  player ??= payer;
  const i = closing ? 0 : entries.findIndex((e) => e.player === player);
  if (i < 0) throw new Error(`${player} has no entry in this contest.`);
  const me = closing ? { side: 0, bits: CLAIMED | ENDED, amount: 0n, taken: 0 } : entries[i];
  nonce = toBigInt(nonce ?? prizeNonce(address, player));
  const won = contest.verdict === 'Won' && Number(contest.winner) === Number(me.side);
  const first = won && !(me.bits & CLAIMED);
  // A winner's first claim of a contest with a prize: the prize's accounts, after the NFTs'. A split prize is paid from
  // the contest's vault (named accounts below), not given as a prize line.
  const split = Boolean(contest.prize_split);
  const prize = contest.prize != null && first && !split && !forgo ? prizeMetas({ project, collection, prize: contest.prize, winner: player, nonce, poolMints, items, nft, programs }) : [];
  const pMint = split ? splitMint(contest.prize, prizeMint ?? poolMints?.[contest.prize?.Tokens?.from.Pool?.[0]]) : null;
  nfts ??= !closing && contest.nft && Number(me.amount) === 1 ? [i] : [];
  const moved = [];
  let taken = Number(me.taken);
  for (const j of nfts) {
    const theirs = entries[j];
    let to = contest.opener;
    if (contest.verdict !== 'Won' || Number(theirs.side) === Number(contest.winner)) to = theirs.player;
    else if (won && payer === player && !(me.bits & ENDED) && taken < shareOf(contest, me)) [to, taken] = [player, taken + 1];
    moved.push(meta(theirs.player, false, true));
    if (holds(hold, theirs.nft)) moved.push(meta(pda.hold(theirs.nft, 0), false, true));
    else {
      const p = piece({ project, asset: theirs.nft, wallet: to, ...kinds[theirs.nft], ...ONLY_MOVES });
      moved.push(...pieceMetas(p), ...p.proof);
    }
  }
  // What it leaves owed: at 0 it closes the contest, burning what its pot (and a split prize's vault) still hold.
  const owed = BigInt(contest.owed);
  const left = closing ? 0n : !contest.nft ? owed - (contest.verdict === 'Won' ? (first ? BigInt(me.amount) : 0n) : 1n) : owed - BigInt(nfts.length) - (first && contest.prize ? 1n : 0n);
  // The claim that leaves nothing owed closes the contest, its rent and what is left to the treasury: it names it.
  if (left <= 0n && !projectState?.treasury) throw new Error('This claim closes the contest: pass projectState, for its treasury.');
  return lootIx(
    'claim',
    { entry: i, nonce, forgo, end, nfts },
    {
      payer,
      project,
      contest: address,
      entries: contestEntries(address, contest),
      player,
      opener: contest.opener,
      to: ata(player, contest.mint, tokenProgramOf(programs, contest.mint)),
      mint: contest.mint,
      prize_mint: pMint,
      // A split prize from a pool: what its vault holds at the close goes back to that pool (`WrongPool` without it).
      prize_pool: split && contest.prize?.Tokens?.from?.Pool ? pda.pool(project, contest.prize.Tokens.from.Pool[0]) : null,
      prize_vault: split ? pda.prizeVault(address) : null,
      prize_to: split ? ata(player, pMint, tokenProgramOf(programs, pMint)) : null,
      treasury: projectState?.treasury ?? null,
    },
    { writable: left <= 0n ? ['mint', ...(split ? ['prize_mint'] : [])] : [], remaining: [...moved, ...prize, ...tailOf(extra)] },
  );
}

// ---------------------------------------------------------------- auctions

/**
 * What a taker signs for an auction, an offer or a listing, as the program works it out (`rail::terms`): sha256 of the
 * record's bytes, all but the span `[start, end)` that changes as it is taken. `record` is the account's bytes as read,
 * or its decoded value, written back to the same bytes (`encodeAccount`).
 */
function recordTerms(name, record, span) {
  const data = record instanceof Uint8Array ? record : encodeAccount(IDL, name, record);
  const [start, end] = span(data);
  return sha256(concat(data.subarray(0, start), data.subarray(end)));
}

/**
 * What a bid signs: the auction's bytes but the bid, which sits last (`high_bidder`, `high`, `last_bid_at`, `held`:
 * 60 bytes, and an auction of NFT bids' room for `MAX_BID_NFTS` after them). `auction`: the decoded Auction, or its
 * account's bytes.
 */
export function auctionTerms(auction) {
  if (auction instanceof Uint8Array) {
    const room = decode('Auction', auction).nft_bids ? 32 * MAX_BID_NFTS : 0;
    return recordTerms('Auction', auction, (data) => [data.length - 60 - room, data.length]);
  }
  // Written back with no bid's NFTs, its bytes end at the bid's 60.
  return recordTerms('Auction', { ...auction, gate: auction.gate ?? null, nft_bids: auction.nft_bids ?? null, held: [] }, (data) => [data.length - 60, data.length]);
}

/** When bids close, as the program reckons it: `ends_at`, or `extend` seconds after the last bid when that is later. */
export const auctionEnds = (auction) => {
  if (BigInt(auction.last_bid_at) === 0n) return BigInt(auction.ends_at);
  const late = BigInt(auction.last_bid_at) + BigInt(auction.extend);
  return late > BigInt(auction.ends_at) ? late : BigInt(auction.ends_at);
};

/** The least next bid the program takes, or null when nothing can top it (no u64 amount; a bid of NFTs past `MAX_BID_NFTS`). */
export function leastBid(auction) {
  const high = BigInt(auction.high);
  if (high === 0n) return BigInt(auction.reserve) > 0n ? BigInt(auction.reserve) : 1n;
  const raise = (high * BigInt(auction.min_raise_bps) + 9_999n) / 10_000n;
  const next = high + (raise > 0n ? raise : 1n);
  // A bid of NFTs holds at most `MAX_BID_NFTS`: past it, nobody can top the high bid.
  return next <= (auction.nft_bids ? BigInt(MAX_BID_NFTS) : (1n << 64n) - 1n) ? next : null;
}

/**
 * `seller` opens its auction `id` of `args.lot` ({ Item: [id] }, { Asset: [address] } or { Roll: [box id] }), alone,
 * and pays its rent: a player for an NFT of the project's own collection they hold; the project's owner or authority for an
 * NFT of any kind it holds (`piece`: `collection` a Core asset's own, `tokenMetadata`, or `compressed` after a
 * `proveLeafIx`), a new unit of its item, or a roll of one of its boxes (a mystery lot: the box must be written, burn
 * no share of its price, and make an order with the auction's shares within one call's growth: `LotRefused`). Its
 * address names the seller, so an id is the seller's own.
 */
export function openAuctionIx({ seller, project, collection, tokenMetadata: tm, compressed, id, mint, args }) {
  stored(args.shares);
  const auction = pda.auction(project, seller, id);
  const asset = args.lot.Asset?.[0] ?? null;
  // An item lot reads no NFT: the auction's own address stands in.
  const p = asset ? piece({ project, asset, wallet: seller, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES }) : standIn(auction);
  return lootIx(
    'open_auction',
    { id, args: { ...args, gate: args.gate ?? null, nft_bids: args.nft_bids ?? null } },
    { seller, project, auction, mint, item: args.lot.Item ? pda.item(project, args.lot.Item[0]) : null, loot_box: args.lot.Roll ? pda.box(project, args.lot.Roll[0]) : null, ...p.accounts },
    { remaining: p.proof, writable: p.writable },
  );
}

/** The most NFTs one bid of an auction of NFT bids holds (`MAX_BID_NFTS`, not in the IDL): a bid of more fails
 * (`BidTooLow`), and a high bid of this many can't be topped. Its reserve is 1 to this many (`BadAuction`). */
export const MAX_BID_NFTS = 3;

/**
 * `bidder` bids `amount` on auction `id`, signing its terms; the bid it tops goes back to the high bidder's account
 * of the mint, which `bidder` opens when it is not there. `auction` is the decoded Auction. `shown`/`listProof`: what
 * passes the auction's gate. An auction of NFT bids (`auction.nft_bids`) takes `nfts` instead ([{ asset, collection,
 * tokenMetadata }], as `piece` takes each; never a compressed NFT: `CompressedBid`), handed to the project, and gives the high bid's NFTs
 * (`held`, the kinds of `auction.held`, in order) back to its bidder; one that can't move now (`hold`: true for all, or a
 * list of assets) becomes a hold for them instead, `bidder` paying its rent until its release. `extra`: a hook's accounts.
 */
export function bidIx({ bidder, project, id, auction, amount, shown, listProof, nfts = [], held = [], hold = false, bidderToken, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, auction.mint);
  const outbid = BigInt(auction.high) > 0n;
  const bundle = [];
  if (auction.nft_bids) {
    for (const nft of nfts) {
      if (nft.compressed) throw new Error('A bid can’t be a compressed NFT: bid Core or Token Metadata NFTs.');
      const p = piece({ project, wallet: bidder, ...nft, ...ONLY_MOVES, reads: true });
      bundle.push(...pieceMetas(p), ...p.proof);
    }
    (auction.held ?? []).forEach((asset, i) => {
      if (holds(hold, asset)) return bundle.push(meta(pda.hold(asset, 0), false, true));
      const p = piece({ project, asset, wallet: auction.high_bidder, ...held[i], ...ONLY_MOVES });
      bundle.push(...pieceMetas(p), ...p.proof);
    });
  }
  return lootIx(
    'bid',
    { amount: auction.nft_bids ? BigInt(nfts.length) : amount, terms: auctionTerms(auction) },
    {
      bidder,
      project,
      auction: pda.auction(project, auction.seller, id),
      vault: vault(project, auction.mint, tokenProgram),
      bidder_token: bidderToken ?? ata(bidder, auction.mint, tokenProgram),
      outbid: outbid ? auction.high_bidder : null,
      outbid_token: outbid ? ata(auction.high_bidder, auction.mint, tokenProgram) : null,
      mint: auction.mint,
    },
    // The vault takes a bid in tokens; NFT bids leave it alone, unlocked.
    { remaining: [...gateAccounts(project, { gate: auction.gate, wallet: bidder, shown, listProof }), ...bundle, ...tailOf(extra)], writable: auction.nft_bids ? [] : ['vault'] },
  );
}

/**
 * Anyone ends auction `id` once it is over (its seller calls off one with no bid). Sold: the lot goes to the high
 * bidder (an item that is a collectible is minted to them at `pda.itemAsset(item, serial)`; a roll of a box is made
 * for them in an order at `prizeRollNonce(nonce)`, `nonce` being `prizeNonce(auction, last_bid_at)` by default, which `signer` pays for), the price
 * through the shares, the rest to whoever owned the lot (the seller of an NFT, the treasury for the project's item or
 * roll), however long after the end it is sent. With no bid, the lot goes home. `signer` opens any account the end pays into that is
 * not there. `item` is the decoded Item of an item lot; for an NFT lot, `collection` its Core collection now (the
 * project's when left out), `tokenMetadata` for a Token Metadata NFT, or `compressed` (after a `proveLeafIx`).
 * `hold` (anyone may; true for all, or a list of assets): an end that wouldn't fit otherwise (a compressed lot's long
 * proof, a hooked mint, many shares) makes the NFT lot a hold for whoever it goes to (its hold passed as `order`, no
 * piece nor proof), and a winning NFT of a bid a hold for `proceeds` (its hold's address in its piece's place); anyone
 * then delivers each with `releaseIx`, and the end's sender gets the rent back then.
 */
export function endAuctionIx({ signer, project, projectState, id, auction, item = null, collection, tokenMetadata: tm, compressed, held = [], hold = false, reference: ref, nonce, holders, programs, extra = [] }) {
  // The lot went at an earlier end, and its seller's account couldn't take the money then (`proceeds_owed`): this end pays
  // it and closes the auction, naming no lot, share or winning NFT.
  const owed = BigInt(auction.proceeds_owed ?? 0) > 0n;
  const lotHeld = !owed && Boolean(auction.lot.Asset) && holds(hold, auction.lot.Asset[0]);
  const tokenProgram = tokenProgramOf(programs, auction.mint);
  const sold = BigInt(auction.high) > 0n;
  const itemId = owed ? undefined : auction.lot.Item?.[0];
  const made = !owed && sold && item?.kind === 'Collectible' ? pda.itemAsset(pda.item(project, itemId), auction.pin) : null;
  const asset = owed ? null : auction.lot.Asset?.[0] ?? made;
  const proceeds = auction.lot.Asset ? auction.seller : projectState.treasury;
  const address = pda.auction(project, auction.seller, id);
  const receiver = sold ? auction.high_bidder : auction.seller;
  // A roll lot sold: its box, and the order the winner's roll is made in. The winning bid stays in the vault as that
  // order's payment, split by the auction's shares when it settles (no shares' accounts here).
  const roll = sold && !owed ? auction.lot.Roll?.[0] : undefined;
  nonce = toBigInt(nonce ?? prizeNonce(address, BigInt(auction.last_bid_at)));
  // An NFT lot is sent on; a collectible sold is minted into its item's collection, which Core writes.
  // With `hold`, an NFT lot is its address alone (no proof), and becomes a hold for whoever it goes to.
  const p = owed
    ? standIn(address)
    : lotHeld
    ? standIn(asset)
    : auction.lot.Asset
    ? piece({ project, asset, wallet: receiver, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES })
    : asset
      ? { ...piece({ project, asset, collection: item.collection, moves: false, locks: false, reads: false }), writable: ['collection'] }
      : standIn(address);
  // A winning bid of NFTs: each to where the rest of a bid in tokens would go (`held`, their kinds in order).
  const winning = !owed && sold && auction.nft_bids
    ? (auction.held ?? []).flatMap((nft, i) => {
      if (holds(hold, nft)) return [meta(pda.hold(nft, 0), false, true)];
      const q = piece({ project, asset: nft, wallet: proceeds, ...held[i], ...ONLY_MOVES });
      return [...pieceMetas(q), ...q.proof];
    })
    : [];
  return lootIx(
    'end_auction',
    { reference: reference(ref), nonce },
    {
      signer,
      project,
      auction: address,
      seller: auction.seller,
      bidder: sold ? auction.high_bidder : auction.seller,
      mint: auction.mint,
      vault: vault(project, auction.mint, tokenProgram),
      proceeds,
      proceeds_token: ata(proceeds, auction.mint, tokenProgram),
      item: itemId !== undefined ? pda.item(project, itemId) : null,
      ...p.accounts,
      loot_box: roll !== undefined ? pda.box(project, roll) : null,
      order: roll !== undefined ? pda.order(project, auction.high_bidder, prizeRollNonce(nonce)) : lotHeld ? pda.hold(asset, 0) : null,
    },
    {
      remaining: [...p.proof, ...(!owed && sold && roll === undefined ? shareAccounts(project, auction.shares, auction.mint, { holders, programs, treasury: projectState.treasury }) : []), ...winning, ...tailOf(extra)],
      writable: [...(!owed && sold && sharesBurn(auction.shares) ? ['mint'] : []), ...(sold && !auction.nft_bids ? ['vault'] : []), ...p.writable],
    },
  );
}

// ---------------------------------------------------------------- offers
//
// An offer's rule reads an NFT outside the project's collections without the project's Sheet: a Core NFT by its own
// attributes, a Token Metadata or compressed NFT with none, so an attribute test fails for an NFT that doesn't carry
// the key itself (every Token Metadata or compressed one).

/** What a taker signs: the offer's bytes but `left`, its last 2 (what a take changes). `offer`: the decoded Offer, or its
 * account's bytes. */
export const offerTerms = (offer) => recordTerms('Offer', offer, (data) => [data.length - 2, data.length]);

/** What one take of a deal pays out of its offer's money: a bid's price, a loan's amount. */
export const dealUnit = (deal) => BigInt(deal.Buy?.price ?? deal.Lend.amount);

/**
 * `maker` (any wallet, signing alone) opens offer `id` in `mint`, and puts all of its money (`left` times the deal's
 * price or amount) into the project's vault now. `args`: { rule, deal: { Buy: { price } } or { Lend: { amount, repay,
 * lasts } }, left, shares } (shares only on a price). Its address names the maker, so an id is the maker's own.
 */
export function openOfferIx({ maker, project, id, mint, args, makerToken, programs, extra = [] }) {
  stored(args.shares);
  const tokenProgram = tokenProgramOf(programs, mint);
  return lootIx(
    'open_offer',
    { id, args: { shares: [], ...args } },
    { maker, project, offer: pda.offer(project, maker, id), mint, maker_token: makerToken ?? ata(maker, mint, tokenProgram), vault: vault(project, mint, tokenProgram) },
    { remaining: tailOf(extra) },
  );
}

/** Its maker calls offer `id` off (`offer` the decoded Offer): what is left of its money goes back to them. Free. */
export function closeOfferIx({ maker, project, id, offer, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  return lootIx(
    'close_offer',
    {},
    { maker, project, offer: pda.offer(project, maker, id), mint: offer.mint, vault: vault(project, offer.mint, tokenProgram), maker_token: ata(maker, offer.mint, tokenProgram) },
    { remaining: tailOf(extra) },
  );
}

/**
 * `seller` sells an NFT that passes the bid's rule into offer `id` (`offer` the decoded Offer, its deal a `Buy`),
 * signing its terms: the NFT goes straight to the maker, the price through the shares, the rest to the seller. The NFT is
 * any kind, as `piece` takes it (`collection`, `hasAuthority` false for a Core asset of another collection,
 * `tokenMetadata`, or `compressed` after a `proveLeafIx`).
 */
export function sellToOfferIx({ seller, project, projectState, id, offer, asset, collection, hasAuthority, tokenMetadata: tm, compressed, holders, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  const p = passedOn({ project, owner: seller, receiver: offer.maker, burns: false, asset, collection, hasAuthority, tokenMetadata: tm, compressed, reads: true });
  return lootIx(
    'sell_to_offer',
    { terms: offerTerms(offer) },
    { seller, project, offer: pda.offer(project, offer.maker, id), maker: offer.maker, ...p.accounts, mint: offer.mint, vault: vault(project, offer.mint, tokenProgram), seller_token: ata(seller, offer.mint, tokenProgram) },
    {
      remaining: [...p.proof, ...shareAccounts(project, offer.shares, offer.mint, { holders, programs, treasury: projectState?.treasury }), ...tailOf(extra)],
      writable: [...(sharesBurn(offer.shares) ? ['mint'] : []), ...p.writable],
    },
  );
}

/**
 * `borrower` borrows against an NFT that passes the offer's rule (`offer` the decoded Offer, its deal a `Lend`), due at
 * `due` (Unix seconds: after now, at most the deal's `lasts` from now), signing its terms. The NFT is held at
 * `pda.hold(asset, due)` until it is repaid (`repayIx`, then `releaseIx` sends it home) or, once due, sent to the
 * lender (`releaseIx` with `to` the lender); the loan goes to the borrower. The NFT is any kind, as `sellToOfferIx` takes it.
 */
export function borrowIx({ borrower, project, id, offer, due, asset, collection, hasAuthority, tokenMetadata: tm, compressed, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  const p = piece({ project, asset, wallet: borrower, collection, hasAuthority, tokenMetadata: tm, compressed, ...ONLY_MOVES, reads: true });
  return lootIx(
    'borrow',
    { due: toBigInt(due), terms: offerTerms(offer) },
    {
      borrower, project, offer: pda.offer(project, offer.maker, id), maker: offer.maker, hold: pda.hold(p.accounts.asset, due), ...p.accounts,
      mint: offer.mint, vault: vault(project, offer.mint, tokenProgram), borrower_token: ata(borrower, offer.mint, tokenProgram),
    },
    { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable },
  );
}

/**
 * Anyone (`payer`: the borrower, a friend) repays a loan before it is due (`hold` the decoded Hold, with its debt): the
 * debt's `repay` goes to the lender, and the NFT is the borrower's again. Only money moves: anyone then sends the NFT
 * home with `releaseIx` (in the same transaction, or later: a repaid loan's release has no deadline). Free. `repay`: the
 * debt the payer was shown (`hold.debt.repay` as read): any other amount is refused (`TermsChanged`). `extra`: a
 * transfer hook's accounts.
 */
export function repayIx({ payer, project, hold, repay, payerToken, programs, extra = [] }) {
  if (repay === undefined || repay === null) throw new Error('A repay names the debt the payer was shown (repay: hold.debt.repay as read).');
  const { lender, mint } = hold.debt;
  const tokenProgram = tokenProgramOf(programs, mint);
  return lootIx(
    'repay',
    { repay: toBigInt(repay) },
    {
      payer, project, hold: pda.hold(hold.asset, hold.free_at), lender,
      lender_token: ata(lender, mint, tokenProgram), payer_token: payerToken ?? ata(payer, mint, tokenProgram), mint,
    },
    { remaining: tailOf(extra) },
  );
}

// ---------------------------------------------------------------- listings

/** What a taker signs: the listing's bytes but `user`, `until` and `stopped` (bytes 129 to 170, what a rental changes).
 * `listing`: the decoded Listing, or its account's bytes. */
export const listingTerms = (listing) => recordTerms('Listing', listing, () => [129, 170]);

/**
 * `maker` (any wallet, signing alone) lists an NFT they hold, of any kind (as `piece` takes it), for sale
 * (`deal: { Sell: { price } }`) or for rent (`{ Rent: { price, lasts, max_periods } }`: `price` a period of `lasts`
 * seconds, a renter taking 1 to `max_periods` at once), paid in `mint`, `shares` taken before the maker's part. The NFT
 * goes to the project until it is sold or the listing is closed. The listing's address names the NFT
 * (`pda.listing(project, asset)`), so a game finds it, and its renter, with one account read.
 */
export function openListingIx({ maker, project, asset, mint, deal, shares = [], collection, hasAuthority, tokenMetadata: tm, compressed, extra = [] }) {
  const p = piece({ project, asset, wallet: maker, collection, hasAuthority, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  return lootIx('open_listing', { deal, shares: stored(shares) }, { maker, project, listing: pda.listing(project, p.accounts.asset), ...p.accounts, mint }, { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable });
}

/**
 * `taker` takes a listing (`listing`: the decoded Listing), signing its terms: a sale pays its price through the shares
 * to the maker and hands the NFT over; a rental of `periods` periods (1 to its `max_periods`) pays `price` each and
 * makes the taker its user until `periods × lasts` from now, refused while another runs. A rental moves no NFT, so it
 * takes none of the NFT's accounts but its address. `holders`, `programs`, `treasury` as for any split. After the
 * take's own accounts come a sale's compressed NFT's proof, then the shares' accounts, then (in `extra`) Core's
 * transfer adapters and any transfer hook's accounts, which the program finds by address after the shares'.
 */
export function takeListingIx({ taker, project, projectState, listing, periods = 1, collection, hasAuthority, tokenMetadata: tm, compressed, holders, programs, takerToken, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, listing.mint);
  const sale = Boolean(listing.deal.Sell);
  // A rental moves nothing: a Core or Token Metadata NFT by its address; a compressed one by its record and tree
  // (`proveLeafIx` first, in the same transaction), with no proof.
  const p = sale ? piece({ project, asset: listing.asset, wallet: taker, collection, hasAuthority, tokenMetadata: tm, compressed, ...ONLY_MOVES })
    : compressed ? { ...piece({ project, asset: listing.asset, wallet: taker, compressed, ...ONLY_MOVES, moves: false }), proof: [] } : standIn(listing.asset);
  return lootIx(
    'take_listing',
    { terms: listingTerms(listing), periods },
    {
      taker, project, listing: pda.listing(project, listing.asset), maker: listing.maker, maker_token: ata(listing.maker, listing.mint, tokenProgram),
      ...p.accounts, mint: listing.mint, taker_token: takerToken ?? ata(taker, listing.mint, tokenProgram),
    },
    {
      remaining: [...p.proof, ...shareAccounts(project, listing.shares ?? [], listing.mint, { holders, programs, treasury: projectState?.treasury }), ...tailOf(extra)],
      writable: [...(sharesBurn(listing.shares ?? []) ? ['mint'] : []), ...p.writable],
    },
  );
}

/**
 * Its maker closes a listing (`listing` the decoded Listing): the NFT goes home. While a rental runs it only stops (no
 * renter takes it again), and the same call once the rental is over takes it home. Free.
 */
export function closeListingIx({ maker, project, listing, collection, hasAuthority, tokenMetadata: tm, compressed, extra = [] }) {
  const p = piece({ project, asset: listing.asset, wallet: maker, collection, hasAuthority, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  return lootIx('close_listing', {}, { maker, project, listing: pda.listing(project, listing.asset), ...p.accounts }, { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable });
}

// ---------------------------------------------------------------- Token Metadata NFTs

const tmPda = (seeds) => findProgramAddress(seeds.map((s) => (typeof s === 'string' ? utf8(s) : s)), TOKEN_METADATA_PROGRAM)[0];

/**
 * Whether a classic mint's account data (`data`, 82 bytes) is an NFT's, as the program takes one:
 * exactly one token, no decimals, initialized, and no mint authority or only its edition's. A semi-fungible item's
 * mint (several units, or one that can still mint) is refused when handed in (`NotAnNft`).
 */
export function isNftMint(mint, data) {
  if (!data || data.length !== MINT_BYTES || data[44] !== 0 || data[45] !== 1) return false;
  if (data.subarray(36, 44).some((b, i) => b !== (i === 0 ? 1 : 0))) return false;
  const tag = data.subarray(0, 4);
  if (tag.every((b) => b === 0)) return true;
  return tag[0] === 1 && tag[1] === 0 && tag[2] === 0 && tag[3] === 0 && encodeBase58(data.subarray(4, 36)) === tokenMetadata.edition(mint);
}

/** A Token Metadata NFT's own addresses: its metadata, its edition, and a pNFT's record of a token account. */
export const tokenMetadata = {
  metadata: (mint) => tmPda(['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint)]),
  edition: (mint) => tmPda(['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint), 'edition']),
  record: (mint, token) => tmPda(['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint), 'token_record', addressBytes(token)]),
};
