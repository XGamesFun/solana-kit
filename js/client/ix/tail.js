// The accounts that come after an instruction's own: a split's destinations, a box's entries and prizes, what a call
// rolls, gates, reads or shows, and the nonces of rolls.
import { addressBytes, encodeBase58, NO_ADDRESS } from '../../chain/base58.js';
import { concat, readUintLE, toBigInt, uintLE, utf8 } from '../../chain/bytes.js';
import { TOKEN_PROGRAM } from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import { sha256 } from '../../chain/sha256.js';
import { tableBudget } from '../sizes.js';
import { ata, BUBBLEGUM_PROGRAM, COMPRESSION_PROGRAM, MPL_CORE_PROGRAM, NOOP_PROGRAM, pda, vault } from '../pda.js';
import {
  hashToAddress,
  NO_OPTIONS,
  ONLY_MOVES,
  pieceMetas,
  prizeMints,
  tokenProgramOf,
  walletAccounts,
} from './shared.js';
import { lootIx } from './base.js';
import { boxDraws } from './money.js';
import { currentRound } from './schedules.js';
import { piece, tokenMetadata } from './piece.js';

// ---------------------------------------------------------------- the accounts after an instruction's own

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
    if (!treasury) throw new Error("A treasury share needs the project's treasury wallet (pass `treasury`).");
    return walletAccounts(treasury, mint, programs);
  }
  if (to.Pool) return [meta(pda.pool(project, to.Pool[0]), false, true)];
  if (to.Account) return [meta(to.Account[0], false, true)];
  if (to.Wallet) return walletAccounts(to.Wallet[0], mint, programs);
  if (to.Holder) {
    const asset = to.Holder[0];
    const holder = holders[asset];
    return [
      meta(asset, false, false),
      ...(holder
        ? walletAccounts(holder, mint, programs)
        : [meta(NO_ADDRESS, false, false), meta(NO_ADDRESS, false, false)]),
    ];
  }
  if (to.Chosen) return [];
  throw new Error(`Unknown destination ${JSON.stringify(to)}`);
}

/** The most shares a split kept to be paid later holds (`MAX_SHARES`, not in the IDL): a box's, a lottery's, a contest's,
 * an auction's, an offer's or a listing's (a ninth is `BadShares`); a payment's own split has no such cap. */
export const MAX_SHARES = 8;

/** The most traits a fresh item draws (`MAX_ITEM_TRAITS`, not in the IDL): each is written as its unit is minted, which
 * one transaction must hold. */
export const MAX_ITEM_TRAITS = 64;
/** The longest name a fresh item's trait has, in bytes (`MAX_TRAIT_KEY`, not in the IDL). */
export const MAX_TRAIT_KEY = 64;

/** The accounts of a split's destinations, in order. */
export const shareAccounts = (project, shares, mint, options) =>
  shares.flatMap(s => destinationAccounts(project, s.to, mint, options));

/**
 * A split with the buyer's choice written in, as the program does at `open_box` and `buy_tickets`: a wallet, the
 * holder of the collectible chosen (a share with an item, which needs one), or the treasury with no choice. A
 * contest's decision names its wallet the same way (`decideIx`).
 */
export const chosenShares = (shares, choice) =>
  shares.map(s => {
    if (!s.to.Chosen) return s;
    if (!choice && s.to.Chosen.item != null)
      throw new Error(
        'This share pays the holder of a collectible the buyer names: name one (`chosenRecipient`, `chosen`).',
      );
    if (!choice) return { ...s, to: 'Treasury' };
    return { ...s, to: s.to.Chosen.item == null ? { Wallet: [choice] } : { Holder: [choice] } };
  });

/** Whether a split burns, so the mint is written: it has a burn share. */
export const sharesBurn = shares => shares.some(s => s.to === 'Burn');

/**
 * The account each prize of a box's entries comes with at the roll, in entry order and each entry's prizes in order:
 * its item for an item, its pool for tokens from one, its stash for an NFT of one (a named one, or one at random). All
 * written: the roll takes from them. Tokens minted and rolls take none here. A fresh item's tables follow it while
 * they fit the box's table budget (`tableBudget`), walked in entry order; an item whose tables don't fit what is left
 * takes none, and is out of stock for that roll.
 */
export function entryAccounts(project, entries, items = {}) {
  let budget = Math.max(0, tableBudget(entries));
  return entries.flatMap(({ prizes }) =>
    prizes.flatMap(prize => {
      // An item, compressed or not; a fresh one's tables after it, in the order of its traits (`items` maps an item's id
      // to its decoded Item: one left out is taken as not fresh).
      const id = prize.Item?.[0] ?? prize.Compressed?.item;
      if (id !== undefined) {
        const tables = traitTables(items[id]);
        const fits = tables.length <= budget;
        if (fits) budget -= tables.length;
        return [
          meta(pda.item(project, id), false, true),
          ...(fits ? tables : []).map(t => meta(pda.table(project, t), false, true)),
        ];
      }
      if (prize.Tokens?.from.Pool) return [meta(pda.pool(project, prize.Tokens.from.Pool[0]), false, true)];
      const stash = prize.Nft?.stash ?? prize.Stash?.[0];
      return stash === undefined ? [] : [meta(pda.stash(project, stash), false, true)];
    }),
  );
}

/**
 * For each mint a box's tokens are in, in the order their prizes first name them, the mint (written when the roll
 * mints from it) and the project's vault for it, where tokens won wait. `poolMints` maps a pool index to its mint (a
 * pool not opened yet has none and is left out).
 */
export function prizeAccounts(project, entries, poolMints = {}, programs) {
  return prizeMints(entries, poolMints)
    .map(({ mint, minted }) => [
      meta(mint, false, minted),
      meta(vault(project, mint, tokenProgramOf(programs, mint)), false, true),
    ])
    .flat();
}

/** Whether a box leaves its outcome to the oracle: more than one entry, or an entry gives a stash's NFT at random. */
export const boxRolls = entries => entries.length > 1 || entries.some(e => e.prizes.some(p => p.Stash));

/** The tables a fresh item's traits draw from, in the order of its traits (none for an item whose units are alike). */
export const traitTables = item => (item?.traits ?? []).flatMap(t => (t.from?.Table ? [t.from.Table[0]] : []));

/** Whether a box gives a fresh item (one with traits): its units' traits are drawn by the oracle (`items` maps an
 * item's id to its decoded Item, as `entryAccounts`). */
export const boxFresh = (entries, items = {}) =>
  entries.some(e => e.prizes.some(p => (items[p.Item?.[0] ?? p.Compressed?.item]?.traits ?? []).length > 0));

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
  const rents = p =>
    Boolean(p.Item || p.Nft || p.Stash || (p.Compressed && (items[p.Compressed.item]?.traits ?? []).length));
  const most = Math.max(0, ...box.entries.map(e => e.prizes.filter(rents).length));
  const sources = new Set(
    box.entries.flatMap(e => e.prizes.flatMap(p => (p.Tokens ? [JSON.stringify(p.Tokens.from)] : []))),
  );
  return (
    SETTLE_RENT_UNIT *
    (BigInt(most * boxDraws(box) * Math.max(1, opens)) + BigInt(sources.size) + (box.subject ? 1n : 0n))
  );
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
export const nonceOn = asset => readUintLE(addressBytes(asset), 0, 8);

/** Whether a box's roll holds the NFT it rolls on, or moves its numbers: an entry burns it, gives it
 * away or moves its numbers. Its order is at the NFT's nonce (`nonceOn`). */
export const boxHolds = box => (box.fates ?? []).some(f => f.then != null || (f.shifts ?? []).length > 0);

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
const limits = perWallet => Boolean(perWallet && (Number(perWallet.total) || Number(perWallet.per_window)));

/**
 * The counts a limit (`perWallet`, a `PerWallet`) counts `player` in, and the link it reads: none when it limits nothing;
 * the wallet's own counts; or, for a limit by person, the counts of `person` (the wallet's link's person, read with
 * `decode('Link', …)`) and the wallet's link. A wallet with no link can't pass a limit by person: link it first
 * (`linkWalletIx` in the same transaction, or a claim of the issuer's voucher).
 */
export function limitAccounts(project, player, perWallet, person) {
  if (!limits(perWallet)) return { counts: null, link: null };
  if (!perWallet.by_person) return { counts: pda.counts(project, player), link: null };
  if (!person)
    throw new Error(
      'This limit counts by person: pass the person the wallet is linked to (`person`), after linking it (linkWalletIx)',
    );
  return { counts: pda.persons(project, person), link: pda.link(project, player) };
}

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
  if (shown.compressed)
    return [shown.compressed, pda.leaf(shown.compressed), shown.tree, pda.sheet(project, shown.compressed)].map(key =>
      meta(key, false, false),
    );
  return [
    shown.mint,
    tokenMetadata.metadata(shown.mint),
    ata(shown.owner, shown.mint, TOKEN_PROGRAM),
    pda.sheet(project, shown.mint),
  ].map(key => meta(key, false, false));
}

/**
 * What a player passes a gate with, right after an instruction's own accounts: a list's proof (`Gate::List`: its
 * nodes as accounts, from `merkleProof` of `gateListLeaf`s), then an NFT shown (`shownAccounts`) for a gate that reads
 * one, or for a box's odds.
 */
export const gateAccounts = (project, { gate, wallet, shown, listProof = [] } = NO_OPTIONS) => [
  ...listProof.map(node => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)),
  // A stake gate reads the wallet's token seat in its farm, then the farm (its tiers' locks), where an NFT shown would be.
  ...(gate?.Staked
    ? [meta(pda.seat(gate.Staked.farm, wallet), false, false), meta(gate.Staked.farm, false, false)]
    : []),
  ...shownAccounts(project, shown),
];

/** Whether a rule reads the player's profile (`Of::Profile`), not an NFT. */
export const readsProfile = rule => rule?.of === 'Profile' || rule?.of?.Profile !== undefined;

/**
 * Whether a box's gate or odds read the player's profile (`profile` true) or an NFT (false), as the program's
 * `LootBox::reads` tells: a gate on a rule, then each odds rule. A box may read both.
 */
export const boxReads = (box, profile) =>
  [...(box.gate?.Holds ? [box.gate.Holds[0]] : []), ...(box.odds ?? []).map(o => o.boost.rule)].some(
    rule => readsProfile(rule) === profile,
  );

/**
 * What a player shows a gate with (`rules::shown_for`): their own profile, `["profile", project, wallet]`, for a gate on
 * a rule that reads one; the NFT `shown` otherwise.
 */
export const shownFor = (project, gate, wallet, shown) =>
  gate?.Holds && readsProfile(gate.Holds[0]) ? pda.profile(project, wallet) : shown;

/**
 * A nonce a prize route names (its `nonce` argument), from what names the prize: a grant, its wallet and rounds, a
 * contest and its player, an auction and its last bid. Any nonce works (the sender picks it); the roll's order
 * is then at `prizeRollNonce` of it (plus the place where the route says so), which no roll on an NFT is at.
 */
export const prizeNonce = (...parts) => {
  const hash = sha256(
    concat(
      utf8('loot:prize'),
      ...parts.map(p => (typeof p === 'string' ? addressBytes(p) : p instanceof Uint8Array ? p : uintLE(p, 8))),
    ),
  );
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
export const prizeRollNonce = n => {
  // The program adds the place or `k` with `wrapping_add`: the same here.
  const hash = sha256(concat(utf8('prize'), uintLE(BigInt.asUintN(64, toBigInt(n)), 8)));
  return readUintLE(hash, 0, 8);
};

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
export function prizeMetas({
  project,
  collection,
  prize,
  winner,
  nonce = 0n,
  poolMints = {},
  items = {},
  nft = {},
  made = 0,
  projectMint,
  programs,
  lottery,
  lotteries = {},
}) {
  if (prize.Ticket) {
    // Free tickets in a lottery's current round (a grant's prize): the lottery, then that round's record.
    const { lottery: id } = prize.Ticket;
    const l = lotteries[id];
    if (!l) throw new Error(`a prize of tickets in lottery ${id} needs the lottery (lotteries: its decoded Lottery)`);
    const address = pda.lottery(project, id);
    return [meta(address, false, true), meta(currentRound(address, l), false, true)];
  }
  if (prize.Tokens) {
    const { from } = prize.Tokens;
    // A pool never opened (its mint given as null) gives nothing: any mint stands in for its place, the project's.
    const pool = from.Pool?.[0];
    const mint = from.Mint ? from.Mint[0] : (poolMints[pool] ?? (pool in poolMints ? projectMint : undefined));
    if (!mint)
      throw new Error(
        `a prize from pool ${pool} needs that pool's mint (poolMints; null for a pool never opened, with projectMint)`,
      );
    const pooled = from.Pool ? [meta(pda.pool(project, pool), false, true)] : [];
    return [
      meta(mint, false, Boolean(from.Mint)),
      ...pooled,
      meta(ata(winner, mint, tokenProgramOf(programs, mint)), false, true),
    ];
  }
  if (prize.Item) {
    const id = prize.Item[0];
    const item = items[id];
    if (item === undefined)
      throw new Error(
        `a prize of item ${id} needs the item (items: its decoded Item, or null for none written), for its kind and next serial`,
      );
    const address = pda.item(project, id);
    // A normal item, or one never written, is its address alone; a collectible is minted into its own collection.
    if (!item || item.kind !== 'Collectible') return [meta(address, false, true)];
    const serial = Number(item.issued) + 1 + made;
    return [
      meta(address, false, true),
      meta(item.collection ?? collection, false, true),
      meta(pda.itemAsset(address, serial), false, true),
      meta(MPL_CORE_PROGRAM, false, false),
    ];
  }
  if (prize.Nft) {
    const { stash, nft: asset } = prize.Nft;
    const p = piece({ project, asset, wallet: winner, ...nft, ...ONLY_MOVES });
    return [meta(pda.stash(project, stash), false, true), ...pieceMetas(p), ...p.proof];
  }
  if (prize.Held) {
    // An NFT a lottery's place promises, from that lottery's own stash.
    if (!lottery) throw new Error("A held NFT is a lottery's prize: name the lottery (`lottery`, its address).");
    const p = piece({ project, asset: prize.Held[0], wallet: winner, ...nft, ...ONLY_MOVES });
    return [meta(pda.lotteryStash(lottery), false, true), ...pieceMetas(p), ...p.proof];
  }
  if (prize.Stash)
    throw new Error("A stash's NFT at random is a box entry's prize only: elsewhere, a roll of a box that gives it.");
  if (prize.Compressed) {
    // A compressed NFT of the item, minted into the project's tree, in the item's collection.
    const { item: id, tree } = prize.Compressed;
    const item = items[id];
    if (!item)
      throw new Error(`a compressed prize of item ${id} needs the item (items: its decoded Item), for its collection`);
    return [
      meta(pda.item(project, id), false, true),
      meta(pda.treeConfig(tree), false, true),
      meta(tree, false, true),
      meta(item.collection, false, true),
      meta(BUBBLEGUM_PROGRAM, false, false),
      meta(COMPRESSION_PROGRAM, false, false),
      meta(NOOP_PROGRAM, false, false),
      meta(MPL_CORE_PROGRAM, false, false),
      meta(BUBBLEGUM_CORE_SIGNER, false, false),
    ];
  }
  return [
    meta(pda.box(project, prize.Roll[0]), false, false),
    meta(pda.order(project, winner, prizeRollNonce(nonce)), false, true),
  ];
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
  const {
    items = {},
    poolMints = {},
    programs,
  } = /** @type {{ items?: any, poolMints?: any, programs?: any }} */ (rolls);
  for (const p of box.entries.flatMap(e => e.prizes)) {
    const id = p.Item?.[0] ?? p.Compressed?.item;
    if (id !== undefined && items[id] === undefined)
      throw new Error(
        `a roll of box ${box.box_id ?? ''} needs item ${id} (rolls.items: its decoded Item, or null for none written), for its tables`,
      );
    const pool = p.Tokens?.from.Pool?.[0];
    if (pool !== undefined && !(pool in poolMints))
      throw new Error(
        `a roll of box ${box.box_id ?? ''} needs the mint of pool ${pool} (rolls.poolMints; null for a pool never opened)`,
      );
  }
  return [...entryAccounts(project, box.entries, items), ...prizeAccounts(project, box.entries, poolMints, programs)];
}

/**
 * What a write or a route that names boxes to roll later passes for them (`order::rollables`): each box once, in the
 * order they first come, and nothing after it. What a roll can give is read when it is asked.
 */
export function boxesAccounts(project, ids) {
  return [...new Set(ids)].map(id => meta(pda.box(project, id), false, false));
}

/** The boxes a record names to roll later (`Def::rolls`), in order: a box's entries' rolls, a recipe's rolls and
 * `RollOn`s, a grant's, a lottery's places'. */
export function defRolls(def) {
  const [kind] = Object.keys(def ?? {});
  const args = def?.[kind]?.args ?? {};
  const prizes =
    kind === 'Box'
      ? (args.entries ?? []).flatMap(e => e.prizes ?? [])
      : kind === 'Recipe'
        ? (args.outputs ?? []).map(o => o.Prize?.[0] ?? (o.RollOn ? { Roll: [o.RollOn.box_id] } : null))
        : kind === 'Grant'
          ? [args.gives]
          : kind === 'Lottery'
            ? (args.terms?.places ?? args.places ?? []).map(p => (typeof p === 'object' ? p.prize : null))
            : [];
  return prizes.flatMap(p => (p?.Roll ? [p.Roll[0]] : []));
}

/** Bubblegum's signer for its calls to Core, `["mpl_core_cpi_signer"]`. */
export const BUBBLEGUM_CORE_SIGNER = 'CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk';

/**
 * The project's owner or authority (`signer`) makes a Bubblegum v2 tree the project alone mints compressed prizes into
 * (`Prize::Compressed`). `tree` is a new account of mpl-account-compression of `treeSize(maxDepth, maxBufferSize,
 * canopy)` bytes, made empty first in the same transaction (a System `createAccount` owned by mpl-account-compression, the tree's keypair signing).
 */
export const openTreeIx = ({ signer, project, tree, maxDepth, maxBufferSize }) =>
  lootIx(
    'open_tree',
    { max_depth: maxDepth, max_buffer_size: maxBufferSize },
    {
      signer,
      project,
      tree,
      tree_config: pda.treeConfig(tree),
      bubblegum_program: BUBBLEGUM_PROGRAM,
      compression_program: COMPRESSION_PROGRAM,
      log_wrapper: NOOP_PROGRAM,
    },
  );

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
