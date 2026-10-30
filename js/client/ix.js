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
import { encodeBorsh, encodeInstruction } from '../chain/borsh.js';
import { concat, intLE, readUintLE, toBigInt, uintLE, utf8 } from '../chain/bytes.js';
import { addressWithSeed, ASSOCIATED_TOKEN_PROGRAM, findProgramAddress, METAPLEX_METADATA_PROGRAM, SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, SYSVAR_SLOT_HASHES, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { allocateWithSeedIx, createAccountWithSeedIx, initializeAccount3Ix, MINT_BYTES, TOKEN_ACCOUNT_BYTES } from '../chain/token.js';
import { createAssociatedTokenAccountIdempotent, meta, transferLamports } from '../chain/programs.js';
import { sha256 } from '../chain/sha256.js';
import IDL from './idl/loot.js';
import { lotteryOwed, lotteryStep } from './accounts.js';
import { ata, BUBBLEGUM_PROGRAM, COMPRESSION_PROGRAM, LOOT_PROGRAM, MPL_CORE_PROGRAM, NOOP_PROGRAM, pda, vault, VRF_QUEUE } from './pda.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

export { IDL, ASSOCIATED_TOKEN_PROGRAM };

/** Token Metadata: a legacy NFT's or a pNFT's metadata lives at an address of its (`METAPLEX_METADATA_PROGRAM`). */
export const TOKEN_METADATA_PROGRAM = METAPLEX_METADATA_PROGRAM;

const ZERO_REFERENCE = new Uint8Array(32);
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
 * written: the roll takes from them. Tokens minted and rolls take none here.
 */
export function entryAccounts(project, entries) {
  return entries.flatMap(({ prizes }) => prizes.flatMap((prize) => {
    if (prize.Item) return [meta(pda.item(project, prize.Item[0]), false, true)];
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

/** What an order of `box` holds for the collectibles its roll may mint: a collectible's rent for each item the entry
 * with the most of them gives. */
export const orderEscrow = (box) => ESCROW_LAMPORTS * BigInt(Math.max(0, ...box.entries.map((e) => e.prizes.filter((p) => p.Item).length)));

/**
 * The nonce the `k`th roll an order won is named by when it settles: the first 8 bytes, little
 * endian, of sha256("roll" | order | its requested slot (u64 LE) | k (u8)). Like every prize's roll, its order is at
 * `prizeRollNonce` of it.
 */
export function rollNonce(order, requestedSlot, k) {
  const hash = sha256(concat(utf8('roll'), addressBytes(order), uintLE(requestedSlot, 8), uintLE(k, 1)));
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
export const boxHolds = (box) => (box.fates ?? []).some((f) => f.then !== 'Back' || (f.shifts ?? []).length > 0);

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
 * A nonce a prize route names (its `nonce` argument), from what names the prize: a grant and its round, a lottery's
 * contribution, a contest's entry, an auction and its last bid. Any nonce works (the sender picks it); the roll's order
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
 *   Roll    the box, then the order its roll is made in, at `prizeRollNonce(nonce)`; on a route the player pays or
 *           asks for (`strict`: a buy, a craft, a grant's claim), then the box's prize mints (`rollMints`);
 *   Held    the lottery's own stash (`lottery`: the lottery's address), the NFT as `piece` takes it, then its proof.
 * `poolMints` maps a pool's index to its mint (null for a pool never opened, which gives nothing: `projectMint` stands in
 * for its mint); `items` an item's id to its decoded Item (for its next serial; `made`
 * collectibles of the same item already made earlier in the instruction); `nft` the NFT's kind, as `piece` takes it
 * ({ collection, tokenMetadata, compressed }). A strict roll's `boxes` maps the box's id to its decoded LootBox (null
 * for one never written), and `rollPools` each pool its prizes name to its mint (null for one never opened;
 * `poolMints` when not given).
 */
export function prizeMetas({ project, collection, prize, winner, nonce = 0n, poolMints = {}, items = {}, nft = {}, made = 0, projectMint, programs, lottery, strict = false, boxes = {}, rollPools = poolMints }) {
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
  const roll = [meta(pda.box(project, prize.Roll[0]), false, false), meta(pda.order(project, winner, prizeRollNonce(nonce)), false, true)];
  return strict ? [...roll, ...strictRollMints(project, prize.Roll[0], boxes, rollPools)] : roll;
}

/**
 * The accounts the program reads after a roll's box and order, to check the roll can be asked for, on a route the
 * player pays or asks for (a craft's `Prize::Roll` or `RollOn`, a buy's roll, a grant's claim of one): for each of the
 * box's token prizes, in order, its pool and then, for a pool opened, the pool's mint; for tokens minted, their mint. The program refuses the whole
 * transaction (PrizeHasHook) when any of those mints has a transfer hook, so the player keeps what the route takes.
 * `box` is the decoded LootBox (null for one never written: no roll is made, and nothing follows); `pools` maps each
 * pool its prizes name to its mint, or null for a pool never opened (its address alone).
 */
export function rollMints(project, box, pools = {}) {
  if (!box) return [];
  return box.entries.flatMap((e) => e.prizes).flatMap((prize) => {
    const from = prize.Tokens?.from;
    if (from?.Mint) return [meta(from.Mint[0], false, false)];
    if (!from?.Pool) return [];
    const index = from.Pool[0];
    if (!(index in pools)) throw new Error(`a roll of box ${box.box_id} needs the mint of pool ${index} its prizes name (rollPools; null for a pool never opened)`);
    return [meta(pda.pool(project, index), false, false), ...(pools[index] ? [meta(pools[index], false, false)] : [])];
  });
}

/** `rollMints` of box `id` on a strict route: `boxes` must hold it (its decoded LootBox, or null for none written). */
function strictRollMints(project, id, boxes, pools) {
  if (!(id in boxes)) throw new Error(`a roll of box ${id} on a route the player pays or asks for needs the box (boxes: its decoded LootBox, or null for one never written), for its prize mints`);
  return rollMints(project, boxes[id], pools);
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
  if (kind === 'Item') args.collection ??= NO_ADDRESS;
  if (kind === 'Box') {
    if (!args.currency) throw new Error('A box names the mint its price is in (`currency`).');
    // An entry: up to three prizes (`prizeMetas`), whether it burns the payment, and its weight.
    if (!Array.isArray(args.entries)) throw new Error('A box needs its entries (`entries`): what its roll can give, each with its weight.');
    args.entries = args.entries.map((e) => ({ prizes: [], burns: false, ...e }));
    args.subject ??= null;
    args.fates = (args.fates ?? []).map((f) => ({ ...f, shifts: (f.shifts ?? []).map((s) => ({ from_now: false, ...s })) }));
  }
  if (kind === 'Box' || kind === 'Recipe') {
    args.window ??= NO_WINDOW;
    args.per_wallet ??= NO_LIMIT;
  }
  if (kind === 'Recipe') args.raises = (args.raises ?? []).map((r) => ({ from_now: false, ...r }));
  if (kind === 'Box' && args.fall) args.fall = { shared: false, ...args.fall };
  if (kind === 'Lottery') {
    args.per_wallet ??= 0;
    args.nft_ticket ??= null;
    args.returns ??= false;
    args.min_sold ??= 0;
    // A place is { bps, roll }; a number is a share of the pot that rolls nothing.
    args.places = (args.places ?? []).map((p) => (typeof p === 'object' ? { prize: null, ...p } : { bps: p, prize: null }));
  }
  if (kind === 'Grant') {
    args.key_root ??= new Uint8Array(32);
    args.open ??= false;
  }
  return { [kind]: { ...body, args } };
}

/**
 * The owner writes one record (`def`: { Item: { id, args } }, { Box: … }, …), at its own address. A lottery names
 * its pot's mint, its pot (which its first write opens), its ticket mint, its
 * funds and both token programs.
 */
export function upsertIx({ owner, project, def: given, lottery = null }) {
  const def = withDefaults(given);
  const [kind] = Object.keys(def);
  const { args } = def[kind];
  let remaining = [];
  // A new sealed schedule opens its own vault: its mint, the vault and both token programs.
  const vest = kind === 'Schedule' ? args.action?.from?.Vest?.[0] : null;
  if (vest) {
    remaining = [meta(vest, false, false), meta(pda.vest(recordAddress(project, def)), false, true), meta(TOKEN_PROGRAM, false, false), meta(TOKEN_2022_PROGRAM, false, false)];
    // A pool or a token account it pays comes next, checked now to be of the vault's mint (`open_vest`).
    const to = args.action.to;
    if (to?.Pool) remaining.push(meta(pda.pool(project, to.Pool[0]), false, false));
    else if (to?.Account) remaining.push(meta(to.Account[0], false, false));
    // A lottery's pot (the only account of the project's it may pay) comes with its lottery (`lottery`).
    if (to?.Account && lottery) remaining.push(meta(lottery, false, false));
  }
  if (kind === 'Lottery') {
    remaining = [
      meta(args.mint, false, false),
      meta(pda.pot(recordAddress(project, def)), false, true),
      meta(args.ticket_mint === NO_ADDRESS ? args.mint : args.ticket_mint, false, false),
      meta(pda.lotteryFunds(recordAddress(project, def)), false, true),
      meta(TOKEN_PROGRAM, false, false),
      meta(TOKEN_2022_PROGRAM, false, false),
    ];
    // A place that holds an NFT (`Prize::Held`): the lottery's own stash, anywhere after them.
    if (args.places.some((p) => p.prize?.Held)) remaining.push(meta(pda.lotteryStash(recordAddress(project, def)), false, false));
  }
  return lootIx('upsert', { def }, { owner, project, target: recordAddress(project, def) }, { remaining });
}

/**
 * The owner closes the record at `target`, and its rent comes back: a grant's with the funds it held. A lottery
 * (`lottery`: its decoded record) sends what its pot holds to `to`, a token account of the pot's mint (the owner's own
 * by default), and closes the pot.
 */
export function closeRecordIx({ owner, project, target, lottery, schedule, programs, to, paymentTo, extra = [] }) {
  // A sealed schedule never closes (CannotClose): its address, and its vault's, stay bound to its terms.
  if (schedule?.action?.from?.Vest) throw new Error('A sealed schedule never closes: its vault stays bound to its terms.');
  if (!lottery) return lootIx('upsert', { def: null }, { owner, project, target });
  const tokenProgram = tokenProgramOf(programs, lottery.mint);
  const paymentMint = lotteryPaymentMint(lottery);
  const remaining = [
    meta(pda.pot(target), false, true),
    meta(lottery.mint, false, true),
    meta(to ?? ata(owner, lottery.mint, tokenProgram), false, true),
    meta(pda.lotteryFunds(target), false, true),
    meta(paymentMint, false, true),
    meta(paymentTo ?? ata(owner, paymentMint, tokenProgramOf(programs, paymentMint)), false, true),
    meta(TOKEN_PROGRAM, false, false),
    meta(TOKEN_2022_PROGRAM, false, false),
    ...extra,
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
    { remaining: [...shareAccounts(project, shares, mint, { holders, programs, treasury }), ...extra], writable: sharesBurn(shares) ? ['mint'] : [] },
  );
}

/**
 * Opens a loot box (`box` the decoded LootBox at `boxAddress`), in an order at `nonce` (a box whose roll moves the
 * numbers of the NFT it rolls on: at that NFT's, `nonceOn`, whatever `nonce` says). `poolMints` maps each pool its
 * prizes take tokens from to its mint (a pool's tokens won wait in the project's vault for that mint); one not given
 * is taken to be in the box's currency, one given as null is closed. `shown`: an NFT the player shows for the box's
 * gate or odds; `listProof`: for a list gate, the proof's nodes. `chosenRecipient`: the wallet (or, for a share with an
 * item, the collectible, `chosen`) the buyer names for a share the box lets them choose. A box of one entry with
 * nothing random is rolled at once and takes no oracle accounts (a box that needs no roll at all sells with `buyIx`).
 * The player opens the project's vault for the price's mint, and for each prize's, when it is not there. A box that
 * limits each wallet counts the purchase in the player's receipt (its rent theirs).
 */
export function openBoxIx({ player, project, box, boxAddress, nonce, maxPrice, shown, listProof, subject, chosenRecipient = null, chosen = null, poolMints, playerToken, programs, extra = [] }) {
  const mint = box.currency;
  poolMints = boxPoolMints(box, poolMints);
  const tokenProgram = tokenProgramOf(programs, mint);
  const rolled = boxRolls(box.entries);
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
    { nonce, max_price: maxPrice ?? box.price, chosen_recipient: chosenRecipient, version: box.version },
    {
      loot_box: address,
      player,
      project,
      mint,
      player_token: playerToken ?? ata(player, mint, tokenProgram),
      vault: vault(project, mint, tokenProgram),
      oracle_queue: rolled ? undefined : null,
      program_identity: rolled ? undefined : null,
      vrf_program: rolled ? undefined : null,
      slot_hashes: rolled ? undefined : null,
      chosen,
      receipt: limits(box.per_wallet) ? pda.receipt(address, player) : null,
      ...on.accounts,
    },
    { remaining: [...entryAccounts(project, box.entries), ...prizeAccounts(project, box.entries, poolMints, programs), ...gate, ...extra], writable: on.writable },
  );
}

/**
 * Buys a box that needs no roll (one entry, nothing random, no NFT to roll on: `boxRolls` false and no subject) in one
 * instruction: the price is split at once (or burned, for an entry that burns) and the entry's prizes are given to
 * the player (`prizeMetas`: `items` maps an item's id to its decoded Item, `poolMints` a pool's index to its mint,
 * `nfts` an NFT a prize names to its kind; a roll's `boxes` and `rollPools`, for the rolled box's prize mints). No
 * order. A prize that can't be given refuses the purchase. `treasury` is
 * the project's treasury wallet; `holders` maps a collectible a share pays to its holder; a roll the entry gives is
 * made at `nonce` (the next one for each roll after). `shown`/`listProof` pass the box's gate.
 */
export function buyIx({ player, project, box, boxAddress, maxPrice, treasury, chosenRecipient = null, chosen = null, nonce = 0n, shown, listProof, items = {}, poolMints = {}, nfts = {}, boxes = {}, rollPools = poolMints, holders, playerToken, programs, extra = [] }) {
  const mint = box.currency;
  const tokenProgram = tokenProgramOf(programs, mint);
  const address = boxAddress ?? pda.box(project, box.box_id);
  const [entry] = box.entries;
  const shares = chosenShares(box.shares, chosenRecipient);
  const made = {};
  const prizes = entry.prizes.flatMap((prize, k) => {
    const item = prize.Item?.[0];
    const lines = prizeMetas({ project, prize, winner: player, nonce: toBigInt(nonce) + BigInt(k), poolMints, items, nft: nfts[prize.Nft?.nft], made: made[item] ?? 0, projectMint: mint, programs, strict: true, boxes, rollPools });
    if (item !== undefined) made[item] = (made[item] ?? 0) + 1;
    return lines;
  });
  return lootIx(
    'buy',
    { max_price: maxPrice ?? box.price, chosen_recipient: chosenRecipient, version: box.version, nonce: toBigInt(nonce) },
    {
      player, project, loot_box: address, mint,
      player_token: playerToken ?? ata(player, mint, tokenProgram),
      treasury, treasury_token: ata(treasury, mint, tokenProgram),
      chosen, receipt: limits(box.per_wallet) ? pda.receipt(address, player) : null,
    },
    {
      remaining: [...gateAccounts(project, { gate: box.gate, wallet: player, shown, listProof }), ...shareAccounts(project, shares, mint, { holders, programs, treasury }), ...prizes, ...extra],
      writable: entry.burns || sharesBurn(box.shares) ? ['mint'] : [],
    },
  );
}

/**
 * The oracle's answer to a box order (for a local simulation: on chain MagicBlock's oracle sends it). The accounts
 * are the ones `open_box` handed the oracle: the order, the box, the roll's ticket (named by its first ask,
 * `asked_first`, which a stale re-ask keeps), every prize's account (written); for a
 * box with tokens the two token programs, the project, and each mint with its vault (a mint it mints from written);
 * for a prize in a mint with a transfer hook, the hook's accounts (`extra`). The buyer's odds boosts were fixed at
 * purchase.
 */
export function callbackRollIx({ order, orderState, box, boxAddress, randomness, project, poolMints, programs, extra = [] }) {
  const projectAddress = project ?? orderState.project;
  const keys = [
    meta(pda.oracleIdentity(), true, false),
    meta(order, false, true),
    meta(boxAddress ?? orderState.loot_box, false, false),
    meta(ticketOf(order, orderState.asked_first), false, false),
    ...entryAccounts(orderState.project, box.entries),
  ];
  const prizes = prizeAccounts(orderState.project, box.entries, boxPoolMints(box, poolMints), programs);
  if (prizes.length) keys.push(meta(TOKEN_PROGRAM, false, false), meta(TOKEN_2022_PROGRAM, false, false), meta(projectAddress, false, false), ...prizes);
  keys.push(...extra);
  return { programId: LOOT_PROGRAM, keys, data: encodeInstruction(IDL, 'callback_roll', { randomness: Uint8Array.from(randomness) }) };
}

/**
 * The accounts of what an order won (`order.won`), in order, as `settle` hands each over:
 *   Item    the item; for a collectible (`items[id]` its decoded Item), its collection, its address, Metaplex Core
 *   Tokens  the mint, the project's vault for it, the player's account of it (`prizeTo`, when given)
 *   Nft     the NFT as `piece` takes it (`nfts[nft]` its kind), going to the player, then a compressed NFT's proof
 *   Roll    the box, then the order its roll is made in (`rollNonce`)
 */
export function wonAccounts({ orderAddress, order, items = {}, nfts = {}, prizeTo, putBack = [], programs }) {
  const project = order.project;
  return order.won.flatMap((won, k) => {
    if (won.Item) {
      const { item: id, serial } = won.Item;
      const address = pda.item(project, id);
      const item = items[id];
      if (!item) throw new Error(`settling item ${id} needs the item (items), for its kind and collection`);
      if (item.kind !== 'Collectible') return [meta(address, false, true)];
      return [meta(address, false, true), meta(item.collection, false, true), meta(pda.itemAsset(address, serial), false, true), meta(MPL_CORE_PROGRAM, false, false)];
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
    return [meta(pda.box(project, won.Roll[0]), false, false), meta(pda.order(project, order.player, rollNonce(orderAddress, order.requested_slot, k)), false, true)];
  });
}

/** The heap a settle that moves three or more NFTs asks for (`settleHeapFrame`): all a transaction may have, 256 KiB. */
export const LARGE_SETTLE_HEAP = 256 * 1024;

/** Whether an order rolled on an NFT: its `subject` names one (the default address for none). */
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
  const moves = (order.won ?? []).some((w) => w.Nft) || rolledOn(order);
  return moves ? MAX_COMPUTE_UNITS : 800_000;
}

/**
 * Carries out a rolled order: hands over what its roll set aside (`wonAccounts`: a collectible minted, the project's
 * backend delivering a normal item from the receipt; tokens from the project's vault; an NFT taken out of its stash;
 * a roll made for the player), then splits the payment, or burns it for an entry that burns. Anyone sends it, for the
 * order at `orderAddress`; `signer` opens any account it pays into that is not there, and pays a roll's order. `order`
 * is the decoded Order; `projectState` the decoded Project; `items` and `nfts` as `wonAccounts` takes them. `putBack`:
 * NFTs won that the player, signing, puts back into their stash in place of taking them (one its collection won't let move).
 * `handBack`: the wallet the box's fate gives the NFT rolled on to (`receiverOf`) is an account of the loot program
 * (`handsBack` of it as read), so the program gives it back to the player, and a Token Metadata NFT's `token` is the
 * player's. `extra`: a hook's or a memo's accounts.
 */
export function settleIx({ signer, orderAddress, order, projectState, items, nfts, prizeTo, putBack, subject, handBack = false, holders, programs, extra = [] }) {
  const project = order.project;
  const tokenProgram = tokenProgramOf(programs, order.mint);
  const burns = order.burns || sharesBurn(order.shares);
  // The NFT it rolled on, as the settle moves it: given to a wallet that is an account of the loot program, it goes
  // back to its player (`handsBack`), into the player's token account for a Token Metadata NFT.
  const receiver = receiverOf(order);
  const on = orderPiece(project, orderAddress, order, subject, handBack && order.fate?.then?.Give ? order.player : receiver);
  return lootIx(
    'settle',
    {},
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
    },
    {
      remaining: [...on.proof, ...wonAccounts({ orderAddress, order, items, nfts, prizeTo, putBack, programs }), ...shareAccounts(project, order.shares, order.mint, { holders, programs, treasury: projectState.treasury }), ...extra],
      writable: [...(burns ? ['mint'] : []), ...on.writable],
    },
  );
}

/**
 * Where a held NFT a roll was on goes, when not back to its player: the wallet its fate names, the stash it goes into,
 * or the incinerator.
 */
export function receiverOf(order) {
  const then = order.fate?.then;
  if (!order.held || !then) return null;
  if (then.Give) return then.Give[0];
  if (then.Stash) return pda.stash(order.project, then.Stash[0]);
  return then === 'Burn' || then.Burn ? INCINERATOR : null;
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
  const burned = order.held && (then === 'Burn' || Boolean(then?.Burn));
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
 * (`orderRefundSlot`). A purchase counted against a box's limit for each
 * wallet is given back. `extra`: a hook's or a memo's accounts.
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
      receipt: order.counted != null ? pda.receipt(order.loot_box, order.player) : null,
      ...on.accounts,
    },
    { remaining: [...on.proof, ...extra], writable: on.writable },
  );
}

/**
 * Anyone (`payer`, who pays the oracle) asks for the roll a mission's return, a recipe or a prize made (`order.status`
 * Waiting): the box's prizes' accounts, as `openBoxIx` passes them. It lands in `callback_roll`. Returns a list of
 * instructions: first `payer` opens the project's vault for each prize mint when it is not there (idempotent; the
 * program refuses the ask without them, since tokens won wait there), then the ask.
 */
export function askRollIx({ payer, orderAddress, order, box, poolMints, programs }) {
  poolMints = boxPoolMints(box, poolMints);
  const opens = prizeMints(box.entries, poolMints).map(({ mint }) => createAssociatedTokenAccountIdempotent(payer, order.project, mint, tokenProgramOf(programs, mint)));
  const ask = lootIx('ask_roll', {}, { payer, order: orderAddress, loot_box: order.loot_box }, {
    remaining: [...entryAccounts(order.project, box.entries), ...prizeAccounts(order.project, box.entries, poolMints, programs)],
  });
  return [...opens, ask];
}

/** The SOL a box order holds for each collectible its roll may mint (`orderEscrow`): its rent, given back unspent. The
 * IDL's `ESCROW_LAMPORTS`. */
export const ESCROW_LAMPORTS = BigInt(IDL.constants.find((c) => c.name === 'ESCROW_LAMPORTS').value);

// ---------------------------------------------------------------- out: the project's tokens move

/**
 * The authority moves the project's tokens: `from` { Pool: [i] } or { Mint: [mint] } (newly minted), `to` a pool, a
 * wallet, an account, the treasury (`treasury`, the project's wallet), a collectible's holder or 'Burn', `amount`
 * { Fixed: [n] } or { Bps: [bps] } of a pool. The authority opens the account it pays into when it is not there; a
 * collectible nobody holds gets nothing.
 */
export function moveTokensIx({ authority, project, mint, from, to, amount, reference: ref, holders, programs, treasury, extra = [] }) {
  const writes = Boolean(from.Mint) || to === 'Burn';
  return lootIx(
    'move_tokens',
    { from, to, amount, reference: reference(ref) },
    { authority, project, mint, pool: from.Pool ? pda.pool(project, from.Pool[0]) : null },
    { remaining: [...destinationAccounts(project, to, mint, { holders, programs, treasury }), ...extra], writable: writes ? ['mint'] : [] },
  );
}

// ---------------------------------------------------------------- make: collectibles

/**
 * The authority makes, rewrites or burns a collectible. `change`: { Make: { attributes } } (then `item` is the item id
 * it makes one of, `asset` is a new key that signs, and `owner` receives it), { Set: [attributes] } or 'Burn'. `collection`: the project's for a Make
 * or a Burn; for a Set, the asset's own (`MPL_CORE_PROGRAM` for one in none). `hasAuthority` false for a `Set` on an
 * NFT the project has no authority over (a Core asset of another collection, or a Token Metadata NFT's mint): what it
 * writes goes in the NFT's Sheet, or on the NFT itself when its Attributes plugin names the project.
 */
export function collectibleIx({ authority, project, collection, asset, change, item = null, owner = null, hasAuthority = true, reference: ref }) {
  const make = Boolean(change.Make);
  const sheet = change.Set && !hasAuthority ? pda.sheet(project, asset) : null;
  return lootIx(
    'collectible',
    { change, reference: reference(ref) },
    { authority, project, collection, asset, item: make ? pda.item(project, item) : null, owner: make ? owner : null, sheet },
    { signer: make ? ['asset'] : [], writable: change.Set || collection === MPL_CORE_PROGRAM ? [] : ['collection'] },
  );
}

// ---------------------------------------------------------------- decide

/**
 * A held NFT goes to `to`: the authority's choice while the hold runs, home to its player (anyone) after; a repaid
 * loan's home (anyone, whenever), an unpaid one's to its lender once due. `hold` is the
 * decoded Hold: its address names its end (`pda.hold(asset, free_at)`), so a release sent late never lands on a later
 * hold. The NFT is any kind
 * (`piece`): `asset` and `collection` for a Core asset, with `tokenMetadata` for a Token Metadata NFT, or `compressed`
 * (after a `proveLeafIx`).
 */
export function releaseIx({ signer, project, collection, asset, tokenMetadata: tm, compressed, hold, to, reference: ref }) {
  const receiver = to ?? hold.player;
  // Never to the project's own address, nor any account of the program, where nothing could move it again (ToTheProject).
  if (receiver === project) throw new Error('A held NFT can’t go to the project’s own address: name a wallet.');
  const p = piece({ project, asset, wallet: receiver, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  return lootIx('release', { reference: reference(ref) }, { signer, project, ...p.accounts, hold: pda.hold(p.accounts.asset, hold.free_at), player: hold.player, to: receiver }, { remaining: p.proof, writable: p.writable });
}

/** The mint of a contest's split prize (its `prize`, tokens): minted, or a pool's (`poolMint`). */
const splitMint = (prize, poolMint) => prize?.Tokens?.from.Mint?.[0] ?? poolMint;

/**
 * The authority opens contest `id` in `mint`. `args`: { sides, closes_at, result_by, shares, gate, deciders,
 * min_pot, stake, prize, nft, prize_split }: `prize`, what each winning entry gets when it is claimed (`prizeMetas`);
 * `nft`, a rule an NFT each entry stakes passes, in place of tokens (no shares then, no stake: the NFTs are the pot).
 * With `args.prize_split`, its token prize is set aside whole when it is
 * decided, in the contest's own vault (`pda.prizeVault`, opened now at the authority's rent), and each winning entry
 * takes its part by what it put in: `prizeMint` names the prize's mint when it comes from a pool.
 */
export const openContestIx = ({ authority, project, id, mint, args, prizeMint }) => {
  const contest = pda.contest(project, id);
  const split = Boolean(args.prize_split);
  return lootIx('open_contest', { id, args: { deciders: [], min_pot: 0, stake: 0, prize: null, nft: null, prize_split: false, ...args, gate: args.gate ?? null } }, {
    authority, project, mint, contest,
    prize_mint: split ? splitMint(args.prize, prizeMint) : null, prize_vault: split ? pda.prizeVault(contest) : null,
  });
};

/** The prefix of a contest's verdict (`verdictBytes`). */
export const VERDICT_DOMAIN = 'loot-verdict-v3';

/**
 * The bytes a contest's decider key signs: "loot-verdict-v3" | program (32) | contest (32) | incarnation (u64 LE) |
 * side (1; 255 calls it off) | expires (i64 LE), then | recipient (32) when the verdict names the wallet the
 * contest's chosen share pays. `incarnation` is the contest's (the decoded Contest's), so a verdict decides only the
 * contest it was signed for, never one opened later at the same id. `decide` rebuilds them from its own accounts and
 * arguments.
 */
export function verdictBytes({ program = LOOT_PROGRAM, contest, incarnation, side, expires, recipient = null }) {
  if (incarnation == null) throw new Error('A verdict signs the contest’s incarnation (the decoded Contest’s).');
  const named = recipient == null ? new Uint8Array(0) : addressBytes(recipient);
  return concat(utf8(VERDICT_DOMAIN), addressBytes(program), addressBytes(contest), uintLE(incarnation, 8), uintLE(side ?? 255, 1), intLE(expires, 8), named);
}

/**
 * Names the side that won (`side`), or calls the contest off (`side: null`). `signer` is the authority; or anyone
 * sending a decider's verdict (`verdict: { expires }`, taken once entries have closed): then this instruction goes
 * right after the Ed25519 check of the decider's signature over `verdictBytes` (`ed25519Ix` in grant.js), and
 * `signer` pays the fee. Anyone writes down a contest that is off by itself. The contest's incarnation names it, so a
 * decision sent late never decides a contest opened later at the same id. A call-off takes no share accounts. A
 * contest with a chosen share is decided naming its `recipient`, a wallet (a bounty's worker); a decider's verdict
 * signs it too (`verdictBytes`).
 */
export function decideIx({ signer, project, projectState, contestAddress, contest, side, recipient = null, verdict, reference: ref, holders, prizeMint, programs, extra = [] }) {
  const address = contestAddress ?? pda.contest(project, contest.id);
  const named = recipient == null ? contest.shares : chosenShares(contest.shares, recipient);
  const shares = side == null ? [] : shareAccounts(project, named, contest.mint, { holders, programs, treasury: projectState?.treasury });
  // A split prize is set aside when a side is named (minted, or from its pool), and its vault closes with a contest
  // called off before anyone entered.
  const split = Boolean(contest.prize_split);
  const from = contest.prize?.Tokens?.from;
  const closes = side == null && Number(contest.entries) === 0;
  return lootIx(
    'decide',
    { side: side ?? null, expires: toBigInt(verdict?.expires ?? 0), reference: reference(ref), incarnation: contest.incarnation, recipient },
    {
      signer, project, contest: address, opener: contest.opener, mint: contest.mint, instructions: verdict ? SYSVAR_INSTRUCTIONS : null,
      prize_mint: split ? splitMint(contest.prize, prizeMint) : null,
      prize_pool: split && side != null && from?.Pool ? pda.pool(project, from.Pool[0]) : null,
      prize_vault: split ? pda.prizeVault(address) : null,
    },
    // The mint is written by a burn share, or by closing the pot of a contest nobody entered; the prize's mint when it
    // is minted, or when its vault closes.
    { remaining: [...shares, ...extra], writable: [...((side == null ? closes : sharesBurn(contest.shares)) ? ['mint'] : []), ...(split && ((side != null && from?.Mint) || closes) ? ['prize_mint'] : [])] },
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
 * Anyone (`payer`) runs a schedule that is due, and opens the account it pays into when that is not there.
 * `poolMint`: the mint of the pool it moves from (when it moves from one). `extra`: a hook's or a memo's accounts.
 */
export function runScheduleIx({ payer, project, id, schedule, poolMint, holders, programs, treasury, extra = [] }) {
  const { from, to } = schedule.action;
  const address = pda.schedule(project, id);
  // A sealed schedule pays from its own vault (`pda.vest`), passed where a pool would be.
  const mint = from.Mint?.[0] ?? from.Vest?.[0] ?? poolMint;
  const writes = Boolean(from.Mint) || to === 'Burn';
  const pool = from.Pool ? pda.pool(project, from.Pool[0]) : from.Vest ? pda.vest(address) : null;
  return lootIx(
    'run_schedule',
    {},
    { payer, project, schedule: address, pool, mint },
    { remaining: [...destinationAccounts(project, to, mint, { holders, programs, treasury }), ...extra], writable: writes ? ['mint'] : [] },
  );
}

export const lotteryPaymentMint = (lottery) => lottery.ticket_mint && lottery.ticket_mint !== NO_ADDRESS ? lottery.ticket_mint : lottery.mint;

/**
 * `player` buys `count` tickets: a contribution of their own at `nonce` (any number they have no contribution at in
 * this lottery), whose rent they pay and get back once it is finished. The ticket money waits in the lottery's
 * escrow until the draw. Whoever holds a collectible a fixed share pays is fixed now, from that collectible. It buys
 * only at the `lottery`'s incarnation and revision (`TermsChanged` once the owner edits or recreates it). A lottery
 * whose ticket costs an NFT (`lottery.nft_ticket`) sells one at a time, for `nft` ({ asset, collection, tokenMetadata,
 * compressed }, as `piece` takes it), which the project holds until the round is drawn (then it goes where its `then`
 * says, `spentTo`) or cancelled (then back to its buyer).
 */
export function buyTicketsIx({ player, project, id, lottery, mint, count, nonce, shown, listProof, chosenRecipient = null, chosen = null, nft, playerToken, programs, extra = [] }) {
  const address = pda.lottery(project, id);
  mint ??= lotteryPaymentMint(lottery);
  const holderAssets = (lottery.shares ?? []).flatMap((s) => (s.to.Holder ? [meta(s.to.Holder[0], false, false)] : []));
  const held = lottery.nft_ticket ? piece({ project, wallet: player, ...nft, ...ONLY_MOVES, reads: true }) : null;
  const paid = held ? [...pieceMetas(held), ...held.proof] : [];
  return lootIx(
    'buy_tickets',
    { nonce, count, chosen_recipient: chosenRecipient, incarnation: lottery.incarnation, revision: lottery.revision },
    {
      player, project, lottery: address, contribution: pda.contribution(address, player, nonce),
      player_token: playerToken ?? ata(player, mint, tokenProgramOf(programs, mint)),
      payment_vault: pda.lotteryFunds(address), mint, chosen,
      receipt: Number(lottery.per_wallet) ? pda.lotteryReceipt(address, lottery.incarnation, player) : null,
    },
    { remaining: [...gateAccounts(project, { gate: lottery.gate, wallet: player, shown, listProof }), ...holderAssets, ...paid, ...extra] },
  );
}

/** Anyone asks for a lottery's draw once it is due. */
export const drawLotteryIx = ({ payer, project, id }) => lootIx('draw_lottery', {}, { payer, lottery: pda.lottery(project, id) });

/** The oracle's answer to a draw (for a local simulation). Every request of a round names the round's ticket, fixed
 * at its first ask (`asked_first`): a re-ask keeps it, so the first answer to land draws the round. */
export function callbackLotteryIx({ project, id, lottery, askedFirst = lottery?.asked_first, randomness }) {
  const address = pda.lottery(project, id);
  return {
    programId: LOOT_PROGRAM,
    keys: [meta(pda.oracleIdentity(), true, false), meta(address, false, true), meta(ticketOf(address, askedFirst), false, false)],
    data: encodeInstruction(IDL, 'callback_lottery', { randomness: Uint8Array.from(randomness) }),
  };
}

export const cancelLotteryIx = ({ project, id }) => lootIx('cancel_lottery', {}, { lottery: pda.lottery(project, id) });

/** Where a decoded contribution's shares go: as fixed when it was bought. */
export function lotteryContributionShares(lottery, contribution) {
  return (lottery.shares ?? []).flatMap((share, i) => {
    const recipient = contribution.recipients[i];
    if (recipient.kind === 2) return [];
    const to = recipient.kind === 1 ? { Wallet: [recipient.wallet] } : share.to?.Chosen ? 'Treasury' : share.to;
    return [{ ...share, to }];
  });
}

/**
 * Anyone (`payer`) sends a contribution's next step (`lotteryStep`; `contributionAddress`, decoded `contribution`):
 *   - a drawn round gives every place's prize first: the step of a contribution that won a place with a prize gives
 *     the first such prize not given yet to its buyer, one place a call (`prizeMetas`: `collection`, `poolMints`, `items`, `nfts` as it takes them; a roll's
 *     order at `nonce` plus the place, `prizeNonce(contributionAddress)` by default), and nothing else moves;
 *   - once every prize is given, it is routed through its shares into the pot (or its tickets burned, or its NFT ticket
 *     spent); a cancelled round's, or a lottery's that returns its tickets, goes back to its buyer, never waiting;
 *   - one that holds a winning ticket stays (`done`): once every contribution is finished, it pays its buyer every
 *     place's share of the pot it won, into their account of the pot's mint.
 * `payer` opens any account it pays into that is not there. `treasury`: the project's treasury wallet, for a share
 * that names it. A ticket an NFT paid for passes that NFT (`ticket`: its kind, as `piece` takes it); `handBack` when the
 * wallet its price gives it to is an account of the loot program (`handsBack`), where it goes back to its buyer (a
 * Token Metadata NFT into the buyer's token account).
 */
export function finishLotteryContributionIx({ payer, project, id, lottery, contributionAddress, contribution, treasury, nonce, collection, poolMints, items, nfts = {}, ticket = {}, handBack = false, programs, extra = [] }) {
  const address = pda.lottery(project, id);
  const step = lotteryStep(lottery, contribution) ?? (contribution.done ? 'pay' : lottery.status === 'Drawn' ? 'finish' : 'refund');
  nonce = toBigInt(nonce ?? prizeNonce(contributionAddress));
  const accounts = { payer, project, lottery: address, contribution: contributionAddress, payment_vault: pda.lotteryFunds(address), pot: pda.pot(address), player: contribution.player };
  if (step === 'prizes') {
    // One place a call: the first it won whose prize is not given yet. The places go in order, so collectibles of one
    // item are made in place order, each at the next serial.
    const [place] = lotteryOwed(lottery, contribution);
    const prize = lottery.places[place].prize;
    const prizes = prizeMetas({ project, collection, prize, winner: contribution.player, nonce: BigInt.asUintN(64, nonce + BigInt(place)), poolMints, items, nft: nfts[prize.Nft?.nft ?? prize.Held?.[0]], programs, lottery: address });
    return lootIx('finish_lottery_contribution', { nonce }, { ...accounts, to: null, mint: lottery.mint }, { remaining: [...prizes, ...extra] });
  }
  if (step === 'pay') {
    return lootIx('finish_lottery_contribution', { nonce }, { ...accounts, to: ata(contribution.player, lottery.mint, tokenProgramOf(programs, lottery.mint)), mint: lottery.mint }, { remaining: extra });
  }
  const mint = lotteryPaymentMint(lottery);
  // Drawn, its tickets go through the shares into the pot; in a lottery that returns them, back to the buyer.
  const routed = step === 'finish';
  const burns = routed && lottery.ticket_mint !== NO_ADDRESS;
  // Burning the tickets, or a share that burns, writes the mint's supply.
  const writesMint = burns || (routed && sharesBurn(lottery.shares ?? []));
  const nft = contribution.asset && contribution.asset !== NO_ADDRESS;
  let remaining = routed && !burns ? shareAccounts(project, lotteryContributionShares(lottery, contribution), mint, { programs, treasury }) : [];
  if (nft) {
    // Drawn: where its price sends it (it stays with the project in a stash); cancelled: back to its buyer.
    const then = routed ? lottery.nft_ticket?.then : null;
    const receiver = then ? spentTo(project, then) : null;
    const burned = then === 'Burn' || Boolean(then?.Burn);
    // Given to a wallet that is an account of the loot program (`handBack`), it goes back to its buyer instead.
    const holder = then?.Stash || (handBack && then?.Give) ? contribution.player : receiver ?? contribution.player;
    const p = piece({ project, asset: contribution.asset, wallet: holder, ...ticket, moves: !then?.Stash, locks: false, burns: burned, reads: false });
    remaining = [...pieceMetas(p), ...p.proof, ...(receiver ? [meta(receiver, false, Boolean(then.Stash))] : [])];
  }
  // A free ticket gives nothing back, and needs no account to give it into.
  const back = !routed && !nft && BigInt(contribution.amount ?? 0) > 0n;
  return lootIx('finish_lottery_contribution', { nonce }, { ...accounts, to: back ? ata(contribution.player, mint, tokenProgramOf(programs, mint)) : null, mint }, { remaining: [...remaining, ...extra], writable: writesMint ? ['mint'] : [] });
}

// ---------------------------------------------------------------- farms

/**
 * The owner opens farm `id`: of `stakedMint`'s tokens, or of collectibles when it is null. Its rewards come from pool
 * `args.rewards_pool`, whose mint is `rewardsMint`: all it receives, shared, or with `args.rate` ({ per_day, mints })
 * a fixed rate, minted or from that pool (a rate of 0 pays nothing: a farm that only grows or gives prizes).
 * `args.gates`: the rules an NFT must all pass. `args.growth`: up to 4 of { key, per_day, level, steps, streak }, each
 * writing points (and a level) on what is staked; tiers' `prize` is paid from `args.prize` ({ Mint: [mint] } or
 * { Pool: [index] }), whose mint is `prizeMint`. `args.ends_at`: when it ends (0: never). For a farm of collectibles,
 * `args.lock_key`: the attribute a staked NFT's lock is written under, as the time it ends, so recipes and rolls can
 * move it; `args.upkeep_key`: the attribute that says until when it earns and grows (fuel). Empty: none.
 */
export const openFarmIx = ({ owner, project, id, args, rewardsMint, stakedMint = null }) => {
  if (!Array.isArray(args?.tiers)) throw new Error('A farm needs its lock tiers (`args.tiers`: [{ lock, bps }, …]).');
  const full = { gates: [], rate: null, growth: [], ends_at: 0, lock_key: '', upkeep_key: '', exit_to: null, unbond: 0, toll: null, ...args, tiers: args.tiers.map((t) => ({ prize: null, roll: null, exit_bps: 0, ...t })) };
  return lootIx('open_farm', { id, args: full }, {
    owner, project, rewards_pool: pda.pool(project, args.rewards_pool), rewards_mint: rewardsMint, staked_mint: stakedMint,
    staked_vault: stakedMint ? pda.staked(pda.farm(project, id)) : null,
    exit_pool: sinkPool(project, full.exit_to), toll_pool: sinkPool(project, full.toll?.to),
  });
};

/** Where a farm's fee goes (`Sink`): the pool's address for `{ Pool: [index] }`, null for a burn or none. */
const sinkPool = (project, sink) => (sink?.Pool ? pda.pool(project, sink.Pool[0]) : null);
/** The pools a farm's early-exit fees and toll go to, when they go to one (`exit_pool`, `toll_pool`). */
const farmSinks = (project, farm) => ({ exit_pool: sinkPool(project, farm.exit_to), toll_pool: sinkPool(project, farm.toll?.to) });
/** A toll that burns writes the rewards' mint. */
const tollWrites = (farm) => (farm.toll?.to === 'Burn' ? ['rewards_mint'] : []);

const farmSide = (project, id, farm) => ({
  project,
  farm: pda.farm(project, id),
  rewards_pool: pda.pool(project, farm.rewards_pool),
  rewards_mint: farm.rewards_mint,
});
/** What every move of a farm writes: its rewards' mint when it mints at a fixed rate, its rewards pool otherwise. */
const farmWrites = (farm) => (farm.rate?.mints ? ['rewards_mint'] : ['rewards_pool']);

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
    ...farmSinks(project, farm),
  };
}

/**
 * `player` stakes `amount` at lock tier `tier`. `farm` is decoded; `extra` carries token hook/memo accounts. A new tier
 * on a seat with a booster, in a farm with growth, needs the booster's growth written first: put a `refreshSeatIx` of
 * the seat before it, in the same transaction.
 */
export const stakeTokensIx = ({ player, project, id, farm, amount, tier = 0, programs, shown, extra = [] }) =>
  lootIx('stake_tokens', { amount, tier }, tokenSeat({ player, project, id, farm, programs }), { remaining: [...shownAccounts(project, shown), ...extra], writable: [...farmWrites(farm), ...tollWrites(farm)] });

/**
 * `player` takes `amount` out (0: only collects what is owed, and takes out tokens whose unbonding wait is over);
 * `forfeit` gives up rewards that can't move. Before the tier's lock has run, a tier with an early-exit fee
 * (`exit_bps`) lets it leave, leaving that share of `amount` to the farm's `exit_to`. In a farm that unbonds
 * (`unbond`), what is taken out waits that long first, earning nothing (`withdrawable`).
 */
export const unstakeTokensIx = ({ player, project, id, farm, amount, forfeit = false, programs, extra = [] }) =>
  lootIx('unstake_tokens', { amount, forfeit }, tokenSeat({ player, project, id, farm, programs, paid: !forfeit }), {
    remaining: extra,
    // An exit fee that burns writes the staked mint; a toll that burns, the rewards' mint.
    writable: [...farmWrites(farm), ...tollWrites(farm), ...(farm.exit_to === 'Burn' ? ['mint'] : [])],
  });

/** What a token seat may take out now (Unix seconds `now`): its unbonded tokens once their wait is over, else 0. */
export const withdrawable = (seat, now) => (BigInt(seat.leaving ?? 0) > 0n && BigInt(now) >= BigInt(seat.leaving_at) ? BigInt(seat.leaving) : 0n);

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
    accounts: {
      ...NO_PIECE, asset, sheet: hasAuthority ? null : sheetOf(asset),
      collection: calls && !inNone ? collection : null, mpl_core_program: calls ? MPL_CORE_PROGRAM : null,
    },
    proof: [],
    writable: burns && !inNone ? ['collection'] : [],
  };
}

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
  return lootIx('pay_nft', { reference: reference(ref) }, { player, project, ...p.accounts, to: receiver }, { remaining: [...p.proof, ...extra], writable: p.writable });
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

/** A piece that reads no NFT: `at` (an auction's or a seat's own address) stands in for one. */
const standIn = (at) => ({ accounts: { ...NO_PIECE, asset: at }, proof: [], writable: [] });

/** Anyone closes a compressed NFT's record (`pda.leaf`) that no longer matches its tree; its rent goes to `payer`, who paid it. */
export const closeLeafIx = ({ asset, tree, payer }) => lootIx('close_leaf', {}, { record: pda.leaf(asset), tree, payer });

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
    accounts: {
      ...farmSide(project, id, farm),
      player,
      ...p.accounts,
      previous,
      seat: pda.seat(farmAddress, farm.farmed.Tokens ? player : key),
      // Rewards are paid only as an NFT's own seat leaves.
      player_rewards: leaving && !farm.farmed.Tokens ? ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)) : null,
    },
    proof: p.proof,
    writable: p.writable,
  };
}

/**
 * `player` stakes an NFT: on a seat of its own in a farm of collectibles, or as the booster of the player's token seat
 * in a farm of tokens. Any kind (`piece`): a Core asset, a Token Metadata NFT's mint with `tokenMetadata`, or
 * `compressed` (after a `proveLeafIx` in the same transaction). `previous`: in a farm that watches, the last staker of
 * an NFT that changed hands, whose seat this takes over. `extra` carries reward token hooks/memos and Core transfer
 * adapter accounts.
 */
export const stakeNftIx = ({ player, project, id, farm, asset, collection, hasAuthority = true, tokenMetadata: tm, compressed, previous = null, tier = 0, programs, extra = [] }) => {
  // Its lock's end, when the farm keeps one, is written on it.
  const keeps = farmKeeps(farm, { writes: Boolean(farm.lock_key) });
  const seat = nftSeat({ player, project, id, farm, asset, collection, hasAuthority, tokenMetadata: tm, compressed, previous, programs, keeps });
  return lootIx('stake_nft', { tier }, { ...seat.accounts, toll_pool: farmSinks(project, farm).toll_pool }, { remaining: [...seat.proof, ...extra], writable: [...farmWrites(farm), ...tollWrites(farm), ...seat.writable] });
};

/**
 * `player` takes an NFT out once its lock has run: it grows on its way out (a farm with growth writes on it, or on its
 * Sheet), and from its own seat takes its tier's prize. `forfeit` gives up the rewards and the prize. Leaving a tier
 * that rolls (`roll`: its box id), the NFT is rolled on that box, in an order at `nonce` (anyone then asks the oracle,
 * `askRollIx`, and settles); a box that can burn it or give it away keeps it in the project's hands until then.
 */
export const unstakeNftIx = ({ player, project, id, farm, asset, collection, hasAuthority = true, tokenMetadata: tm, compressed, forfeit = false, roll = null, nonce = 0n, tier, projectCollection, poolMints, items, nft, programs, extra = [] }) => {
  // It grows on its way out; a mission that rolls may hand it to the project.
  const keeps = farmKeeps(farm, { writes: Boolean(farm.growth?.length), rolls: roll != null });
  const seat = nftSeat({ player, project, id, farm, asset, collection, hasAuthority, tokenMetadata: tm, compressed, programs, leaving: true, keeps });
  // Leaving a mission that rolls (its tier's `roll`, a box id): the box, and the order the roll is made in.
  const rolls = roll != null ? { loot_box: pda.box(project, roll), order: pda.order(project, player, nonce) } : { loot_box: null, order: null };
  // A mission's prize (its tier's, `tier` the seat's): its accounts after the proof, unread when it is not earned; a
  // roll's order at `nonce` plus 1. A forfeit takes neither the prize nor the rewards (the program reads neither), so it
  // passes neither: the smallest way out.
  const prize = tier != null && !forfeit ? farm.tiers[tier]?.prize : null;
  const prized = prize ? prizeMetas({ project, collection: projectCollection ?? collection, prize, winner: player, nonce: toBigInt(nonce) + 1n, poolMints, items, nft, programs }) : [];
  if (forfeit) seat.accounts.player_rewards = null;
  return lootIx('unstake_nft', { forfeit, nonce }, { ...seat.accounts, ...rolls, associated_token_program: prize?.Tokens ? ASSOCIATED_TOKEN_PROGRAM : null, toll_pool: farmSinks(project, farm).toll_pool }, {
    remaining: [...seat.proof, ...prized, ...extra],
    writable: [...farmWrites(farm), ...tollWrites(farm), ...seat.writable],
  });
};

/**
 * `player` collects what the seat of `by` owes (their own address for tokens, a collectible's asset). `held`: in a farm
 * that watches, what shows the player still holds the seat's NFT (the Core asset, their token account of a Token
 * Metadata NFT, or a compressed NFT's record, `pda.leaf`, with its `tree`), which such a farm refuses to go without.
 */
export const harvestIx = ({ player, project, id, farm, by = player, held = null, tree = null, compound = false, programs, extra = [] }) =>
  lootIx('harvest', { compound }, {
    ...farmSide(project, id, farm),
    player,
    seat: pda.seat(pda.farm(project, id), by),
    player_rewards: ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)),
    held,
    tree,
    // Compounding moves what is owed into the staked vault (a farm of tokens whose rewards are the staked token).
    staked_vault: compound ? pda.staked(pda.farm(project, id)) : null,
    toll_pool: farmSinks(project, farm).toll_pool,
  }, { remaining: extra, writable: [...farmWrites(farm), ...tollWrites(farm)] });

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
  return lootIx('refresh_seat', {}, { signer, ...farmSide(project, id, farm), seat: address, ...p.accounts }, { remaining: extra, writable: [...farmWrites(farm), ...p.writable] });
};

// ---------------------------------------------------------------- recipes and holds

/**
 * `player` crafts recipe `id` (`recipe` decoded, the version shown to them), `times` over. `assets`: the
 * collectibles handed in, in the recipe's order (the burned, the used, and for a `Show` line the NFT shown: its address
 * when it is the project's, `{ asset, collection }` for a Core NFT of another collection, `{ mint, owner }` for a Token
 * Metadata one; for a `Trade` line the NFT traded in, as `piece` takes it: `{ asset, collection, tokenMetadata,
 * compressed }`). A collectible used or renewed that is staked in a farm holding it for the player (escrow) is
 * `{ asset, farm }`, `farm` that farm's id: its seat and farm follow it. A `Staked` line names the farm its collectible
 * is staked in (`Input::Staked { item, farm }`, escrowed or frozen there): its address, or `{ asset, farm }` with that
 * farm, and its seat and that farm follow it. Each item line passes its item's collection
 * (`items[id].collection`, the decoded Items; `collection` when not given), written for a burn: Core writes it as it
 * burns a collectible. A recipe's `raises` write on the kept ones, in their Sheet when the project has no
 * authority over them. The player opens any account a line pays into that is not there. A roll it makes (a
 * `Prize::Roll` or a `RollOn`) passes its box's prize mints (`rollMints`): `boxes` maps the box's id to its decoded
 * LootBox, `rollPools` each pool its prizes name to its mint (null for one never opened; `poolMints` when not given).
 * A craft makes several Core calls: raise the compute limit. `extra`: a token's hook accounts.
 */
export function craftIx({ player, project, collection, id, recipe, assets = [], times = 1, nonce = 0n, holders, programs, treasury, poolMints, items = {}, nfts = {}, boxes = {}, rollPools = poolMints, extra = [] }) {
  const remaining = [];
  const given = [...assets];
  const tokens = (mint) => ata(player, mint, tokenProgramOf(programs, mint));
  const itemLine = (itemId, burns = false) => [meta(pda.item(project, itemId), false, false), meta(items[itemId]?.collection ?? collection, false, burns)];
  for (const input of recipe.inputs) {
    if (input.Burn) {
      remaining.push(...itemLine(input.Burn.item, true));
      for (let i = 0; i < input.Burn.count; i++) remaining.push(meta(take(given, 'a collectible to burn'), false, true));
    } else if (input.Use || input.Renew || input.Staked) {
      remaining.push(...itemLine((input.Use ?? input.Renew ?? input.Staked).item));
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
      const nft = take(given, 'an NFT to show');
      if (typeof nft === 'string') remaining.push(meta(nft, false, true), meta(input.Show.collection, false, false));
      else if (nft.asset) remaining.push(meta(nft.asset, false, true), meta(pda.sheet(project, nft.asset), false, true), meta(nft.collection ?? MPL_CORE_PROGRAM, false, false));
      else if (nft.compressed) remaining.push(...[nft.compressed, pda.leaf(nft.compressed), nft.tree].map((key) => meta(key, false, false)), meta(pda.sheet(project, nft.compressed), false, true));
      else remaining.push(...[nft.mint, tokenMetadata.metadata(nft.mint), ata(nft.owner ?? player, nft.mint, TOKEN_PROGRAM)].map((key) => meta(key, false, false)), meta(pda.sheet(project, nft.mint), false, true));
    }
  }
  const made = {};
  for (const output of recipe.outputs) {
    if (output.Prize) {
      // A prize (`prizeMetas`): collectibles of one item made in order, each at the next serial.
      const prize = output.Prize[0];
      const item = prize.Item?.[0];
      remaining.push(...prizeMetas({ project, collection, prize, winner: player, nonce, poolMints, items, nft: nfts[prize.Nft?.nft], made: made[item] ?? 0, programs, strict: true, boxes, rollPools }));
      if (item !== undefined) made[item] = (made[item] ?? 0) + 1;
    } else if (output.RollOn) {
      // The box, then the order its roll is made in, at the craft's `nonce`, then the box's prize mints (`rollMints`).
      remaining.push(meta(pda.box(project, output.RollOn.box_id), false, false), meta(pda.order(project, player, nonce), false, true), ...strictRollMints(project, output.RollOn.box_id, boxes, rollPools ?? {}));
    }
  }
  const address = pda.recipe(project, id);
  const receipt = limits(recipe.per_wallet) ? pda.receipt(address, player) : null;
  return lootIx('craft', { version: recipe.version, times, nonce }, { player, project, recipe: address, receipt }, { remaining: [...remaining, ...extra] });
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
export function holdIx({ player, project, collection, asset, tokenMetadata: tm, compressed, freeAt, reference: ref }) {
  const p = piece({ project, asset, wallet: player, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  return lootIx('hold', { free_at: toBigInt(freeAt), reference: reference(ref) }, { player, project, ...p.accounts, hold: pda.hold(p.accounts.asset, freeAt) }, { remaining: p.proof, writable: p.writable });
}

// ---------------------------------------------------------------- stashes

/**
 * The project's owner or authority (`signer`) puts an NFT it holds into stash `id`, or (`out`: a wallet) takes one the
 * stash holds out to that wallet. The NFT is any kind, as `piece` takes it: `collection` a Core asset's own,
 * `tokenMetadata`, or `compressed` after a `proveLeafIx` in the same transaction. The signer pays what the stash grows
 * by, and gets back the rent it no longer needs. Taken out with `out` the project's own address, the entry is only dropped
 * from the stash and the NFT stays where it is. `out` is never another account of the program (`ToTheProject`).
 */
export function stashIx({ signer, project, id, lottery = null, asset, out = null, collection, tokenMetadata: tm, compressed }) {
  const to = out ?? signer;
  // A lottery's own stash (`lottery`: the lottery's id): an NFT its place names leaves only as that prize, or once the
  // lottery has ended; taking one out passes the lottery.
  const own = lottery != null ? pda.lottery(project, lottery) : null;
  const stash = own ? pda.lotteryStash(own) : pda.stash(project, id);
  // Out to a wallet or the project's own address, never another account of the program (a record, a stash, a fee
  // box), where no record names the NFT and nothing could move it again (ToTheProject): the ones this call names are
  // refused before sending, and the program refuses any other (js/play only takes one out to the signer's wallet).
  if (out && out !== project && [stash, own, pda.fees(project), pda.platform()].includes(out))
    throw new Error('An NFT taken out of a stash can’t go to an account of the program: name a wallet, or the project’s own address to only drop it from the stash.');
  const p = piece({ project, asset, wallet: to, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  return lootIx('stash', { of: own ? { Lottery: [lottery] } : { Project: [id] }, out: Boolean(out) }, { signer, project, stash, to, ...p.accounts, lottery: own && out ? own : null }, { remaining: p.proof, writable: p.writable });
}

// ---------------------------------------------------------------- contests

/**
 * `player` backs `side` with `amount`, naming the contest's incarnation (which fixes its terms). `contest` is the
 * decoded Contest. A contest of NFTs (`contest.nft`) takes one NFT instead (`nft`: { asset, collection, tokenMetadata,
 * compressed }, as `piece` takes it), which the contest holds until it is claimed. `shown`/`listProof` pass its gate.
 * `extra`: a hook's accounts.
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
      entry: pda.entry(address, player),
      player_token: playerToken ?? ata(player, contest.mint, tokenProgramOf(programs, contest.mint)),
      mint: contest.mint,
    },
    { remaining: [...gateAccounts(project, { gate: contest.gate, wallet: player, shown, listProof }), ...(staked ? [...pieceMetas(staked), ...staked.proof] : []), ...extra] },
  );
}

/**
 * Anyone (`payer`) claims `player`'s entry on `side`, into the player's account of the mint, which `payer` opens when
 * it is not there (the last entry's claim closes the pot and writes the mint). A winning entry of a contest with a
 * prize (`contest.prize`) also gets it (`prizeMetas`: `collection`, `poolMints`, `items`, `nft`; a roll's order at
 * `nonce`, `prizeNonce(entry)` by default), `payer` paying what it opens. For a contest of NFTs, `entry` is the decoded
 * Entry: its own NFT (`own`, its kind as `piece` takes it) goes back to its player, or to the opener for a loser's NFT
 * no winner took; a winner, while losers' NFTs are left, also takes one (`taking`: { player, side } of a losing entry
 * that still holds one, and `kind`, its NFT's kind). While losers' NFTs are left only the winner sends their claim, and
 * picks which (`payer` the player; `WinnerPicks` otherwise). `extra`: a hook's accounts.
 */
export function claimIx({ payer, project, id, contest, player, side, entry, own = {}, taking, nonce, collection, poolMints, items, nft, prizeMint, forgo = false, programs, extra = [] }) {
  const address = pda.contest(project, id);
  const entryAddress = pda.entry(address, player);
  nonce = toBigInt(nonce ?? prizeNonce(entryAddress));
  const won = contest.verdict === 'Won' && Number(contest.winner) === Number(side);
  // A winning entry of a contest with a prize: the prize's accounts, after the NFTs'.
  // A split prize is paid from the contest's vault (named accounts below), not given as a prize line.
  const split = Boolean(contest.prize_split);
  const prize = contest.prize != null && won && !split && !forgo ? prizeMetas({ project, collection, prize: contest.prize, winner: player, nonce, poolMints, items, nft, programs }) : [];
  const pMint = split ? splitMint(contest.prize, prizeMint ?? poolMints?.[contest.prize?.Tokens?.from.Pool?.[0]]) : null;
  const nfts = [];
  if (contest.nft && entry && entry.asset !== NO_ADDRESS) {
    const lost = contest.verdict === 'Won' && !won;
    const mine = piece({ project, asset: entry.asset, wallet: lost ? contest.opener : player, ...own, ...ONLY_MOVES });
    nfts.push(...pieceMetas(mine), ...mine.proof);
    if (won && taking) {
      const theirs = pda.entry(address, taking.player);
      const p = piece({ project, asset: taking.asset, wallet: player, ...taking.kind, ...ONLY_MOVES });
      nfts.push(meta(theirs, false, true), ...pieceMetas(p), ...p.proof);
    }
  }
  return lootIx(
    'claim',
    { nonce, forgo },
    {
      payer,
      project,
      contest: address,
      entry: entryAddress,
      player,
      opener: contest.opener,
      to: ata(player, contest.mint, tokenProgramOf(programs, contest.mint)),
      mint: contest.mint,
      prize_mint: pMint,
      prize_vault: split ? pda.prizeVault(address) : null,
      prize_to: split ? ata(player, pMint, tokenProgramOf(programs, pMint)) : null,
    },
    // The last claim closes the pot (and a split prize's vault), writing their mints.
    { writable: Number(contest.entries) === 1 ? ['mint', ...(split ? ['prize_mint'] : [])] : [], remaining: [...nfts, ...prize, ...extra] },
  );
}

// ---------------------------------------------------------------- auctions

/** What a bid signs: sha256(mint | Borsh(AuctionArgs)). */
export function auctionTerms(mint, args) {
  return sha256(concat(addressBytes(mint), encodeBorsh(IDL, { defined: { name: 'AuctionArgs' } }, args)));
}

/** An auction's AuctionArgs from its decoded account (what `open_auction` fixed). */
export const auctionArgsOf = (auction) => ({
  lot: auction.lot,
  reserve: auction.reserve,
  min_raise_bps: auction.min_raise_bps,
  starts_at: auction.starts_at,
  ends_at: auction.ends_at,
  extend: auction.extend,
  shares: auction.shares,
  gate: auction.gate ?? null,
  nft_bids: auction.nft_bids ?? null,
});

/** When bids close, as the program reckons it: `ends_at`, or `extend` seconds after the last bid when that is later. */
export const auctionEnds = (auction) => {
  if (BigInt(auction.last_bid_at) === 0n) return BigInt(auction.ends_at);
  const late = BigInt(auction.last_bid_at) + BigInt(auction.extend);
  return late > BigInt(auction.ends_at) ? late : BigInt(auction.ends_at);
};

/** The least next bid the program takes, or null when no u64 amount can top it. */
export function leastBid(auction) {
  const high = BigInt(auction.high);
  if (high === 0n) return BigInt(auction.reserve) > 0n ? BigInt(auction.reserve) : 1n;
  const raise = (high * BigInt(auction.min_raise_bps) + 9_999n) / 10_000n;
  const next = high + (raise > 0n ? raise : 1n);
  return next <= (1n << 64n) - 1n ? next : null;
}

/**
 * `seller` opens its auction `id` of `args.lot` ({ Item: [id] }, { Asset: [address] } or { Roll: [box id] }), alone,
 * and pays its rent: a player for an NFT of the project's own collection they hold; the project's owner or authority for an
 * NFT of any kind it holds (`piece`: `collection` a Core asset's own, `tokenMetadata`, or `compressed` after a
 * `proveLeafIx`), a new unit of its item, or a roll of one of its boxes (a mystery lot). Its address names the seller, so an
 * id is the seller's own.
 */
export function openAuctionIx({ seller, project, collection, tokenMetadata: tm, compressed, id, mint, args }) {
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

/**
 * `bidder` bids `amount` on auction `id`, signing its terms; the bid it tops goes back to the high bidder's account
 * of the mint, which `bidder` opens when it is not there. `auction` is the decoded Auction. `shown`/`listProof`: what
 * passes the auction's gate. An auction of NFT bids (`auction.nft_bids`) takes `nfts` instead ([{ asset, collection,
 * tokenMetadata }], as `piece` takes each; never a compressed NFT: `CompressedBid`), handed to the project, and gives the high bid's NFTs
 * (`held`, the kinds of `auction.held`, in order) back to its bidder. `extra`: a hook's accounts.
 */
export function bidIx({ bidder, project, id, auction, amount, shown, listProof, nfts = [], held = [], bidderToken, programs, extra = [] }) {
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
      const p = piece({ project, asset, wallet: auction.high_bidder, ...held[i], ...ONLY_MOVES });
      bundle.push(...pieceMetas(p), ...p.proof);
    });
  }
  return lootIx(
    'bid',
    { amount: auction.nft_bids ? BigInt(nfts.length) : amount, terms: auctionTerms(auction.mint, auctionArgsOf(auction)) },
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
    { remaining: [...gateAccounts(project, { gate: auction.gate, wallet: bidder, shown, listProof }), ...bundle, ...extra], writable: auction.nft_bids ? [] : ['vault'] },
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
 */
export function endAuctionIx({ signer, project, projectState, id, auction, item = null, collection, tokenMetadata: tm, compressed, held = [], reference: ref, nonce, holders, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, auction.mint);
  const sold = BigInt(auction.high) > 0n;
  const itemId = auction.lot.Item?.[0];
  const made = sold && item?.kind === 'Collectible' ? pda.itemAsset(pda.item(project, itemId), auction.serial) : null;
  const asset = auction.lot.Asset?.[0] ?? made;
  const proceeds = auction.lot.Asset ? auction.seller : projectState.treasury;
  const address = pda.auction(project, auction.seller, id);
  const receiver = sold ? auction.high_bidder : auction.seller;
  // A roll lot sold: its box, and the order the winner's roll is made in.
  const roll = sold ? auction.lot.Roll?.[0] : undefined;
  nonce = toBigInt(nonce ?? prizeNonce(address, BigInt(auction.last_bid_at)));
  // An NFT lot is sent on; a collectible sold is minted into its item's collection, which Core writes.
  const p = auction.lot.Asset
    ? piece({ project, asset, wallet: receiver, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES })
    : asset
      ? { ...piece({ project, asset, collection: item.collection, moves: false, locks: false, reads: false }), writable: ['collection'] }
      : standIn(address);
  // A winning bid of NFTs: each to where the rest of a bid in tokens would go (`held`, their kinds in order).
  const winning = sold && auction.nft_bids
    ? (auction.held ?? []).flatMap((nft, i) => {
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
      order: roll !== undefined ? pda.order(project, auction.high_bidder, prizeRollNonce(nonce)) : null,
    },
    {
      remaining: [...p.proof, ...(sold ? shareAccounts(project, auction.shares, auction.mint, { holders, programs, treasury: projectState.treasury }) : []), ...winning, ...extra],
      writable: [...(sold && sharesBurn(auction.shares) ? ['mint'] : []), ...(sold && !auction.nft_bids ? ['vault'] : []), ...p.writable],
    },
  );
}

// ---------------------------------------------------------------- offers
//
// An offer's rule reads an NFT outside the project's collections without the project's Sheet: a Core NFT by its own
// attributes, a Token Metadata or compressed NFT with none, so an attribute test fails for an NFT that doesn't carry
// the key itself (every Token Metadata or compressed one).

/** The hash a taker signs, as the program rebuilds it: sha256(mint | rule | deal | shares), Borsh. `offer` is the decoded Offer. */
export function offerTerms(offer) {
  const borsh = (name, value) => encodeBorsh(IDL, { defined: { name } }, value);
  return sha256(concat(addressBytes(offer.mint), borsh('Rule', offer.rule), borsh('Deal', offer.deal), encodeBorsh(IDL, { vec: { defined: { name: 'Share' } } }, offer.shares)));
}

/** What one take of a deal pays out of its offer's money: a bid's price, a loan's amount. */
export const dealUnit = (deal) => BigInt(deal.Buy?.price ?? deal.Lend.amount);

/**
 * `maker` (any wallet, signing alone) opens offer `id` in `mint`, and puts all of its money (`left` times the deal's
 * price or amount) into the project's vault now. `args`: { rule, deal: { Buy: { price } } or { Lend: { amount, repay,
 * lasts } }, left, shares } (shares only on a price). Its address names the maker, so an id is the maker's own.
 */
export function openOfferIx({ maker, project, id, mint, args, makerToken, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, mint);
  return lootIx(
    'open_offer',
    { id, args: { shares: [], ...args } },
    { maker, project, offer: pda.offer(project, maker, id), mint, maker_token: makerToken ?? ata(maker, mint, tokenProgram), vault: vault(project, mint, tokenProgram) },
    { remaining: extra },
  );
}

/** Its maker calls offer `id` off (`offer` the decoded Offer): what is left of its money goes back to them. Free. */
export function closeOfferIx({ maker, project, id, offer, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  return lootIx(
    'close_offer',
    {},
    { maker, project, offer: pda.offer(project, maker, id), mint: offer.mint, vault: vault(project, offer.mint, tokenProgram), maker_token: ata(maker, offer.mint, tokenProgram) },
    { remaining: extra },
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
      remaining: [...p.proof, ...shareAccounts(project, offer.shares, offer.mint, { holders, programs, treasury: projectState?.treasury }), ...extra],
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
    { remaining: [...p.proof, ...extra], writable: p.writable },
  );
}

/**
 * Anyone (`payer`: the borrower, a friend) repays a loan before it is due (`hold` the decoded Hold, with its debt): the
 * debt's `repay` goes to the lender, and the NFT is the borrower's again. Only money moves: anyone then sends the NFT
 * home with `releaseIx` (in the same transaction, or later: a repaid loan's release has no deadline). Free. `extra`: a
 * transfer hook's accounts.
 */
export function repayIx({ payer, project, hold, payerToken, programs, extra = [] }) {
  const { lender, mint } = hold.debt;
  const tokenProgram = tokenProgramOf(programs, mint);
  return lootIx(
    'repay',
    {},
    {
      payer, project, hold: pda.hold(hold.asset, hold.free_at), lender,
      lender_token: ata(lender, mint, tokenProgram), payer_token: payerToken ?? ata(payer, mint, tokenProgram), mint,
    },
    { remaining: extra },
  );
}

// ---------------------------------------------------------------- listings

/** What a taker signs: sha256(maker | asset | mint | Borsh(ListingDeal) | Borsh(shares)). */
export function listingTerms(listing) {
  const deal = encodeBorsh(IDL, { defined: { name: 'ListingDeal' } }, listing.deal);
  const shares = encodeBorsh(IDL, { vec: { defined: { name: 'Share' } } }, listing.shares ?? []);
  return sha256(concat(addressBytes(listing.maker), addressBytes(listing.asset), addressBytes(listing.mint), deal, shares));
}

/**
 * `maker` (any wallet, signing alone) lists an NFT they hold, of any kind (as `piece` takes it), for sale
 * (`deal: { Sell: { price } }`) or for rent (`{ Rent: { price, lasts, max_periods } }`: `price` a period of `lasts`
 * seconds, a renter taking 1 to `max_periods` at once), paid in `mint`, `shares` taken before the maker's part. The NFT
 * goes to the project until it is sold or the listing is closed. The listing's address names the NFT
 * (`pda.listing(project, asset)`), so a game finds it, and its renter, with one account read.
 */
export function openListingIx({ maker, project, asset, mint, deal, shares = [], collection, hasAuthority, tokenMetadata: tm, compressed, extra = [] }) {
  const p = piece({ project, asset, wallet: maker, collection, hasAuthority, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  return lootIx('open_listing', { deal, shares }, { maker, project, listing: pda.listing(project, p.accounts.asset), ...p.accounts, mint }, { remaining: [...p.proof, ...extra], writable: p.writable });
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
      remaining: [...p.proof, ...shareAccounts(project, listing.shares ?? [], listing.mint, { holders, programs, treasury: projectState?.treasury }), ...extra],
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
  return lootIx('close_listing', {}, { maker, project, listing: pda.listing(project, listing.asset), ...p.accounts }, { remaining: [...p.proof, ...extra], writable: p.writable });
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
