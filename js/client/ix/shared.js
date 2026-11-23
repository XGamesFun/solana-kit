// Private to ix/ (ix.js does not re-export it): the helpers several parts use, each as it was where it came from.
import { addressBytes, encodeBase58 } from '../../chain/base58.js';
import { encodeAccount } from '../../chain/borsh.js';
import { compareBytes, concat, utf8 } from '../../chain/bytes.js';
import { ASSOCIATED_TOKEN_PROGRAM, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM } from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import { sha256 } from '../../chain/sha256.js';
import IDL from '../idl/loot.js';
import {
  ata,
  BUBBLEGUM_PROGRAM,
  COMPRESSION_PROGRAM,
  lootProgram,
  MPL_CORE_PROGRAM,
  NOOP_PROGRAM,
  pda,
} from '../pda.js';
import { PIECE } from './defs.js';
import { TOKEN_METADATA_PROGRAM } from './base.js';
import { MAX_ITEM_TRAITS, MAX_SHARES, MAX_TRAIT_KEY } from './tail.js';
import { AUTH_RULES_PROGRAM } from './farms.js';
import { piece, tokenMetadata } from './piece.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
export const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

export const hashToAddress = hash => encodeBase58(hash);

export const tokenProgramOf = (programs, mint) => programs?.[mint] ?? TOKEN_PROGRAM;

/** A wallet, then its associated token account of `mint`: where money owed to it goes. */
export const walletAccounts = (wallet, mint, programs) => [
  meta(wallet, false, false),
  meta(ata(wallet, mint, tokenProgramOf(programs, mint)), false, true),
];

/** `shares`, refused here when a split kept to be paid later holds more than `MAX_SHARES`. */
export const stored = (shares = []) => {
  if (shares.length > MAX_SHARES)
    throw new Error(
      `A split kept to be paid later holds at most ${MAX_SHARES} shares; this one has ${shares.length} (BadShares).`,
    );
  return shares;
};

/** An item's `traits`, refused here past the program's caps (`BadItem` when the owner signs). */
export const traitsInCaps = (traits = []) => {
  if (traits.length > MAX_ITEM_TRAITS)
    throw new Error(`An item draws at most ${MAX_ITEM_TRAITS} traits; this one draws ${traits.length} (BadItem).`);
  const long = traits.find(t => utf8(String(t.key)).length > MAX_TRAIT_KEY);
  if (long)
    throw new Error(
      `A trait's name is at most ${MAX_TRAIT_KEY} bytes; “${String(long.key).slice(0, 24)}…” is ${utf8(String(long.key)).length} (BadItem).`,
    );
  return traits;
};

/** The mints a box's tokens are in, in the order their prizes first name them: { mint, minted }. */
export function prizeMints(entries, poolMints = {}) {
  const mints = [];
  for (const prize of entries.flatMap(e => e.prizes)) {
    const from = prize.Tokens?.from;
    if (!from) continue;
    const mint = from.Mint ? from.Mint[0] : poolMints[from.Pool[0]];
    if (!mint) continue;
    const seen = mints.find(m => m.mint === mint);
    if (seen) seen.minted ||= Boolean(from.Mint);
    else mints.push({ mint, minted: Boolean(from.Mint) });
  }
  return mints;
}

/** Each pool a box's prizes name, mapped to its mint: `poolMints`'s, or the box's own currency when it isn't given. */
export function boxPoolMints(box, poolMints) {
  const pools = box.entries.flatMap(e => e.prizes.flatMap(p => (p.Tokens?.from.Pool ? [p.Tokens.from.Pool[0]] : [])));
  return Object.fromEntries(pools.map(pool => [pool, poolMints && pool in poolMints ? poolMints[pool] : box.currency]));
}

/** A `piece`'s accounts as metas, in the program's order: what a prize of an NFT names after its stash. */
export function pieceMetas(p) {
  return PIECE.map(a => {
    const key = p.accounts[a.name];
    if (key == null) return meta(lootProgram(), false, false);
    return meta(key, false, a.writable === true || p.writable.includes(a.name));
  });
}

/** The mint of a contest's split prize (its `prize`, tokens): minted, or a pool's (`poolMint`). */
export const splitMint = (prize, poolMint) => prize?.Tokens?.from.Mint?.[0] ?? poolMint;

/** The program's rule for where a part nobody can take goes: the treasury's wallet, then its account of the mint. */
export const treasuryAccounts = (treasury, mint, programs) => walletAccounts(treasury, mint, programs);

export const farmSide = (project, id, farm) => ({
  project,
  farm: pda.farm(project, id),
  rewards_mint: farm.rewards_mint,
  ends: farm.keeps_ends ? pda.ends(pda.farm(project, id)) : null,
});

/** Whether a farm reads or writes its seats' players' profiles (`Farm::uses_profile`): a gate or a boost on a profile,
 * or a growth written on one. Its moves then pass the player's profile. */
export const usesProfile = farm =>
  [...(farm.gates ?? []), ...(farm.boosts ?? []).map(b => b.rule)].some(r => r?.of === 'Profile') ||
  (farm.growth ?? []).some(g => g.profile);
export const profileOf = (project, farm, player) => (usesProfile(farm) ? pda.profile(project, player) : null);

/** What a move that pays a seat writes: the rewards' mint, when the farm mints at a fixed rate (it mints at payout). */
export const payWrites = farm => (farm.rate?.mints ? ['rewards_mint'] : []);

export const NO_PIECE = {
  sheet: null,
  collection: null,
  mpl_core_program: null,
  metadata: null,
  edition: null,
  token: null,
  token_record: null,
  project_token: null,
  project_record: null,
  rule_set: null,
  rules_program: null,
  token_metadata_program: null,
  instructions: null,
  spl_token_program: null,
  spl_ata_program: null,
  leaf: null,
  tree: null,
  tree_config: null,
  leaf_delegate: null,
  bubblegum_program: null,
  compression_program: null,
  log_wrapper: null,
};

/** The programs every NFT of a call of several needs, on the first NFT's piece (the call's own): Core, Token Metadata's
 * and Bubblegum's, by what the others are. */
export function withPrograms(first, others) {
  const kinds = new Set(others.map(p => p.kind));
  const a = { ...first.accounts };
  if (kinds.has('core')) a.mpl_core_program ??= MPL_CORE_PROGRAM;
  if (kinds.has('tokenMetadata')) {
    a.token_metadata_program ??= TOKEN_METADATA_PROGRAM;
    a.spl_token_program ??= TOKEN_PROGRAM;
    a.spl_ata_program ??= ASSOCIATED_TOKEN_PROGRAM;
    a.instructions ??= SYSVAR_INSTRUCTIONS;
    a.rules_program ??= others.some(p => p.accounts.rule_set && p.accounts.rule_set !== TOKEN_METADATA_PROGRAM)
      ? AUTH_RULES_PROGRAM
      : others.some(p => p.accounts.token_record)
        ? TOKEN_METADATA_PROGRAM
        : null;
  }
  if (kinds.has('compressed'))
    Object.assign(a, {
      bubblegum_program: a.bubblegum_program ?? BUBBLEGUM_PROGRAM,
      compression_program: a.compression_program ?? COMPRESSION_PROGRAM,
      log_wrapper: a.log_wrapper ?? NOOP_PROGRAM,
    });
  return { ...first, accounts: a };
}

/**
 * Several NFTs on one call (a hold, a stash, a farm's seats): their groups sorted by key (`keyOf`), the first the
 * call's own and each further one after it, in ascending order (`OutOfOrder` otherwise). Returns [first, ...rest].
 */
export const ascending = (items, keyOf) =>
  [...items].sort((a, b) => compareBytes(addressBytes(keyOf(a)), addressBytes(keyOf(b))));

/** An NFT moving straight from `owner` to `receiver`, or burned by its owner (`burns`). */
export function passedOn({
  project,
  owner,
  receiver,
  burns,
  asset,
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  reads = false,
}) {
  // `tm.into` is the receiver's account here: the NFT leaves the owner's associated one.
  const p = piece({
    project,
    asset,
    wallet: owner,
    collection,
    hasAuthority,
    tokenMetadata: tm && { ...tm, into: undefined },
    compressed,
    ...ONLY_MOVES,
    burns: burns && !tm && !compressed,
    reads,
  });
  if (tm) {
    const token = tm.into ?? ata(receiver, asset, TOKEN_PROGRAM);
    p.accounts.project_token = token;
    p.accounts.project_record = tm.programmable ? tokenMetadata.record(asset, token) : null;
  }
  return p;
}

/** A route that only hands the NFT to the project or sends it on (a hold, an auction's lot, a refund): no Sheet, no write. */
export const ONLY_MOVES = { moves: true, locks: false, writes: false, reads: false };

/** Whether `asset` goes as its hold (`["hold", asset, 0]`, passed in its piece's place): `hold` true for every NFT a
 * route owes, or a list of the assets to hold. */
export const holds = (hold, asset) => (Array.isArray(hold) ? hold.includes(asset) : Boolean(hold));

/** A piece that reads no NFT: `at` (an auction's or a seat's own address) stands in for one. */
export const standIn = at => ({ accounts: { ...NO_PIECE, asset: at }, proof: [], writable: [] });

/**
 * What a taker signs for an auction, an offer or a listing, as the program works it out (`rail::terms`): sha256 of the
 * record's bytes, all but the span `[start, end)` that changes as it is taken. `record` is the account's bytes as read,
 * or its decoded value, written back to the same bytes (`encodeAccount`).
 */
export function recordTerms(name, record, span) {
  const data = record instanceof Uint8Array ? record : encodeAccount(IDL, name, record);
  const [start, end] = span(data);
  return sha256(concat(data.subarray(0, start), data.subarray(end)));
}

/**
 * A Token Metadata NFT's move names two different token accounts, the one it leaves and the one it goes into: Token
 * Metadata takes a move from an account to itself as done and moves nothing, so the program refuses it (`SameAccount`).
 * Throws, in words, before anything is signed.
 */
export function twoAccounts(p) {
  const { token, project_token: other } = p.accounts;
  if (token && other && token === other)
    throw new Error(
      `The NFT ${p.accounts.asset} would move from the token account ${token} to itself: a move names two different accounts (SameAccount).`,
    );
  return p;
}

/**
 * What shows whether the project still holds an NFT, for a route that reads it and moves nothing (`piece::held`): a Core
 * asset by its own address; a Token Metadata NFT by the project's token account of it (`project_token`), and, once it
 * left, the account that holds it now or its mint when it was burned (`evidence`, in `token`'s place); a compressed NFT
 * by its record and tree (`proveLeafIx` first, in the same transaction), its proof first after the instruction's own
 * accounts, as the program reads it whenever the record and tree are passed.
 */
export function heldPiece({ project, asset, tokenMetadata: tm, compressed: c, evidence = null }) {
  if (c)
    return {
      kind: 'compressed',
      accounts: { ...NO_PIECE, asset: c.id, leaf: pda.leaf(c.id), tree: c.tree },
      proof: c.proof.map(node => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)),
      writable: [],
    };
  if (tm)
    return twoAccounts({
      kind: 'tokenMetadata',
      accounts: { ...NO_PIECE, asset, project_token: ata(project, asset, TOKEN_PROGRAM), token: evidence },
      proof: [],
      writable: [],
    });
  return { kind: 'core', ...standIn(asset) };
}
