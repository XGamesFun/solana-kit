// An NFT on a route (a `Piece`): paying with one, a compressed NFT's proof, its Sheet and traits, NFT seats on a farm;
// and a Token Metadata NFT's own addresses.
import { addressBytes, encodeBase58, NO_ADDRESS } from '../../chain/base58.js';
import { concat, toBigInt, utf8 } from '../../chain/bytes.js';
import {
  addressWithSeed,
  ASSOCIATED_TOKEN_PROGRAM,
  findProgramAddress,
  SYSTEM_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  TOKEN_PROGRAM,
} from '../../chain/pda.js';
import {
  allocateWithSeedIx,
  createAccountWithSeedIx,
  initializeAccount3Ix,
  MINT_BYTES,
  TOKEN_ACCOUNT_BYTES,
} from '../../chain/token.js';
import { meta, transferLamports } from '../../chain/programs.js';
import { sha256 } from '../../chain/sha256.js';
import {
  ata,
  BUBBLEGUM_PROGRAM,
  COMPRESSION_PROGRAM,
  lootProgram,
  MPL_CORE_PROGRAM,
  NOOP_PROGRAM,
  pda,
} from '../pda.js';
import { instructionDef, leaves, PIECE } from './defs.js';
import {
  ascending,
  farmSide,
  NO_PIECE,
  ONLY_MOVES,
  passedOn,
  payWrites,
  pieceMetas,
  profileOf,
  standIn,
  tokenProgramOf,
  withPrograms,
} from './shared.js';
import { instructionOf, lootIx, reference, tailOf, TOKEN_METADATA_PROGRAM } from './base.js';
import { namedRollNonce, prizeMetas } from './tail.js';
import { INCINERATOR } from './money.js';
import { AUTH_RULES_PROGRAM } from './farms.js';

// ---------------------------------------------------------------- an NFT on a route (a `Piece`)

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
 * An NFT proven gone from the project (whoever controls its collection took it out of the project's hands or burned
 * it) is let go by the record that holds it, on these same accounts (receipt `NftGone`): a Core asset shows
 * it by itself; a compressed NFT by its record, proven again as the leaf is now; a Token Metadata NFT by
 * `tokenMetadata.evidence`, the token account that holds it now, or its mint when it was burned, which goes in the
 * place of `wallet`'s token account. Anything else shows nothing, and the route goes its usual way.
 * What the route does with it, so only the accounts it takes are passed (each true when left out):
 *   `moves`: hands it to the project or sends it on; `locks`: locks or unlocks it in its wallet; `writes`: writes on it;
 *   `burns`: burns a Core asset (false when left out); `reads`: reads its Sheet; `held`: reads it in the project's token
 *   account (an escrow farm).
 */
export function piece({
  project,
  asset,
  wallet,
  collection,
  hasAuthority = true,
  tokenMetadata: tm,
  compressed: c,
  moves = true,
  locks = true,
  writes = true,
  burns = false,
  reads = true,
  held = moves,
}) {
  const sheetOf = nft => (reads || writes || burns ? pda.sheet(project, nft) : null);
  if (c) {
    // Bubblegum is called (and writes the leaf, its tree and its config) only to lock or move it.
    const calls = moves || locks;
    const delegate = calls && c.delegate !== c.owner && c.delegate !== project ? c.delegate : null;
    const bubblegum = calls
      ? {
          collection: c.collection ?? null,
          tree_config: pda.treeConfig(c.tree),
          leaf_delegate: delegate,
          bubblegum_program: BUBBLEGUM_PROGRAM,
          compression_program: COMPRESSION_PROGRAM,
          log_wrapper: NOOP_PROGRAM,
        }
      : {};
    return {
      kind: 'compressed',
      accounts: { ...NO_PIECE, asset: c.id, sheet: sheetOf(c.id), leaf: pda.leaf(c.id), tree: c.tree, ...bubblegum },
      proof: c.proof.map(node => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)),
      writable: calls ? ['leaf', 'tree', 'tree_config'] : [],
    };
  }
  if (tm) {
    // `tm.into`: the token account of `wallet`'s the NFT goes into when it is not their associated one (`freshNftAccount`).
    // `tm.evidence`: what shows the NFT gone from the project (the account that holds it now, or its mint), in its place.
    const token = tm.evidence ?? tm.into ?? ata(wallet, asset, TOKEN_PROGRAM);
    const projectToken = ata(project, asset, TOKEN_PROGRAM);
    const pnft = Boolean(tm.programmable);
    // Token Metadata is called to lock it or move it; a move also takes the project's token account (and record) and the
    // ATA program, a pNFT's every call its records, rule set and the instructions sysvar.
    const calls = moves || locks;
    const records = calls && pnft;
    return {
      kind: 'tokenMetadata',
      accounts: {
        ...NO_PIECE,
        asset,
        sheet: sheetOf(asset),
        metadata: tokenMetadata.metadata(asset),
        token,
        edition: calls ? tokenMetadata.edition(asset) : null,
        token_record: records ? tokenMetadata.record(asset, token) : null,
        project_token: held || moves ? projectToken : null,
        project_record: records && moves ? tokenMetadata.record(asset, projectToken) : null,
        rule_set: records ? (tm.ruleSet ?? TOKEN_METADATA_PROGRAM) : null,
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
      ...NO_PIECE,
      asset,
      sheet: hasAuthority ? null : sheetOf(asset),
      collection: calls && !inNone ? collection : null,
      mpl_core_program: calls ? MPL_CORE_PROGRAM : null,
    },
    proof: [],
    writable: burns && !inNone ? ['collection'] : [],
  };
}

/** The accounts a further NFT of a call of several takes (`Piece::another`), after the first NFT's: only what its kind
 * needs, the program's own address for one left out, then its proof. The first NFT passes every program any needs. */
const ANOTHER = {
  core: ['asset', 'sheet', 'collection'],
  tokenMetadata: [
    'asset',
    'sheet',
    'metadata',
    'edition',
    'token',
    'token_record',
    'project_token',
    'project_record',
    'rule_set',
  ],
  compressed: ['asset', 'sheet', 'collection', 'leaf', 'tree', 'tree_config', 'leaf_delegate'],
};
export function anotherMetas(p) {
  const writable = new Set([...p.writable, ...PIECE.filter(a => a.writable).map(a => a.name)]);
  return [
    ...ANOTHER[p.kind].map(name =>
      p.accounts[name] == null ? meta(lootProgram(), false, false) : meta(p.accounts[name], false, writable.has(name)),
    ),
    ...p.proof,
  ];
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
    ? piece({
        project,
        asset,
        wallet: owner,
        collection,
        hasAuthority,
        tokenMetadata: tm,
        compressed,
        ...ONLY_MOVES,
        reads: true,
      })
    : passedOn({
        project,
        owner,
        receiver: to,
        burns: then === 'Burn' || Boolean(then.Burn),
        asset,
        collection,
        hasAuthority,
        tokenMetadata: tm,
        compressed,
        reads: true,
      });
  return [...pieceMetas(p), ...p.proof, meta(to, false, Boolean(then.Stash))];
}

/**
 * `player` pays with an NFT, any kind (as `piece` takes it): burned (`to` null: the incinerator's address goes in its
 * place), or given to the wallet `to` (the treasury, a partner). The receipt (`PaidNft`) is the record: an app admits the player when the NFT, where it went (`to`: a payment to the player's own wallet pays nothing) and the reference
 * are the ones it asked for. `extra`: Core's transfer adapters.
 */
export function payNftIx({
  player,
  project,
  asset,
  to = null,
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  reference: ref,
  extra = [],
}) {
  // An NFT paid goes to a wallet, never to the project's own address, where nothing could ever move it (ToTheProject).
  if (to === project) throw new Error('An NFT paid can’t go to the project’s own address: name a wallet, or burn it.');
  const receiver = to ?? INCINERATOR;
  const p = passedOn({
    project,
    owner: player,
    receiver,
    burns: receiver === INCINERATOR,
    asset,
    collection,
    hasAuthority,
    tokenMetadata: tm,
    compressed,
  });
  return lootIx(
    'pay_nft',
    { reference: reference(ref) },
    { player, project, ...p.accounts, to: receiver },
    { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable },
  );
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
  return (
    encodeBase58(data.subarray(0, 32)) === mint && encodeBase58(data.subarray(32, 64)) === holder && data[108] === 1
  );
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
  if (!there)
    return {
      address,
      instructions: [
        createAccountWithSeedIx({
          from: payer,
          address,
          seed,
          lamports: TOKEN_ACCOUNT_RENT,
          space: TOKEN_ACCOUNT_BYTES,
          owner: TOKEN_PROGRAM,
        }),
        init,
      ],
    };
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
const freshNftSeed = (holder, mint, index) =>
  `nft${index}:${encodeBase58(sha256(concat(addressBytes(holder), addressBytes(mint)))).slice(0, 26)}`;

/** How many fresh accounts a payer may open for one holder and mint (`freshNftAccount`'s `index`). */
export const FRESH_NFT_ACCOUNTS = 8;

/** A token account's rent on every cluster (165 bytes). */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;

/**
 * A compressed NFT's record (`pda.leaf`) closes, its rent back to `payer`, who paid it: at any time with `payer` signing
 * (`signs`, the default), or by anyone once it no longer matches its tree. A route that finds no record asks for a proof
 * again (`NotProven`), so a client closes it in the transaction that used it (`withLeafCloses`).
 */
export const closeLeafIx = ({ asset, tree, payer, signs = true }) =>
  lootIx(
    'close_leaf',
    {},
    { record: pda.leaf(asset), tree, payer, project: null, edition: null },
    { signer: signs ? ['payer'] : [] },
  );

const PROVE_LEAF = leaves(instructionDef('prove_leaf').accounts).map(a => a.name);
const CLOSE_LEAF = leaves(instructionDef('close_leaf').accounts).map(a => a.name);
const isLoot = (ix, name) => ix.programId === lootProgram() && instructionOf(ix.data)?.name === name;

/**
 * `instructions` with a `close_leaf` after them for each compressed NFT's record a `prove_leaf` among them makes, its
 * prover signing as the record's payer, so the record's rent comes back in the same transaction (one closed already is
 * left alone).
 */
export function withLeafCloses(instructions) {
  const at = (ix, names, name) => ix.keys[names.indexOf(name)]?.pubkey;
  const closed = new Set(instructions.filter(ix => isLoot(ix, 'close_leaf')).map(ix => at(ix, CLOSE_LEAF, 'record')));
  const closes = [];
  for (const ix of instructions.filter(x => isLoot(x, 'prove_leaf'))) {
    const record = at(ix, PROVE_LEAF, 'record');
    if (closed.has(record)) continue;
    closed.add(record);
    closes.push(
      closeLeafIx({
        asset: at(ix, PROVE_LEAF, 'asset'),
        tree: at(ix, PROVE_LEAF, 'tree'),
        payer: at(ix, PROVE_LEAF, 'signer'),
      }),
    );
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
export const closeSheetIx = ({
  project,
  nft,
  tree = null,
  burned = tree ? pda.leaf(nft) : nft,
  treasury,
  tokenMetadata: tm = null,
}) =>
  lootIx(
    'close_leaf',
    {},
    {
      record: pda.sheet(project, nft),
      tree: burned,
      payer: treasury,
      project,
      edition: tm ? tokenMetadata.edition(nft) : tree,
    },
  );

/**
 * Anyone proves a compressed NFT's leaf (`compressed` from `compressedFromDas`): put it before the instruction that
 * uses the NFT, in the same transaction. The proof must be against the tree's current root (`StaleProof` otherwise:
 * fetch it again). Its record is read only while the tree is as it was then. Bubblegum's config of the tree comes
 * with it: only a tree Bubblegum made has one.
 */
export const proveLeafIx = ({ signer, compressed: c }) =>
  lootIx(
    'prove_leaf',
    {
      leaf: {
        root: c.root,
        data_hash: c.dataHash,
        creator_hash: c.creatorHash,
        asset_data_hash: c.assetDataHash ?? null,
        flags: c.flags,
        nonce: c.nonce,
      },
    },
    {
      signer,
      asset: c.id,
      record: pda.leaf(c.id),
      owner: c.owner,
      delegate: c.delegate,
      collection: c.collection ?? BUBBLEGUM_PROGRAM,
      tree: c.tree,
      tree_config: pda.treeConfig(c.tree),
    },
    { remaining: c.proof.map(node => meta(typeof node === 'string' ? node : encodeBase58(node), false, false)) },
  );

/** The project's owner or authority vouches for NFTs' off-chain traits: `root` of a `traitsTree`, under `key`. */
export const setTraitsIx = ({ signer, project, key, root }) =>
  lootIx('set_traits', { key, root }, { signer, project, traits: pda.traits(project, key) });

/** Anyone writes `nft`'s traits ([{ key, value }]) into its Sheet in `project`, by its `proof` in the tree under `key`. */
export const proveTraitsIx = ({ signer, project, key, nft, attributes, proof }) =>
  lootIx(
    'prove_traits',
    { attributes, proof },
    { signer, traits: pda.traits(project, key), nft, sheet: pda.sheet(project, nft) },
  );

/** What a farm does with a seat's NFT (`piece`'s flags): kept as its custody says, written on as it grows. */
const farmKeeps = (farm, { writes = false, rolls = false } = {}) => ({
  moves: farm.custody === 'Escrow' || rolls,
  locks: farm.custody === 'Freeze',
  writes,
  held: farm.custody === 'Escrow',
});

function nftSeat({
  player,
  project,
  id,
  farm,
  asset,
  collection,
  hasAuthority = true,
  tokenMetadata: tm,
  compressed,
  previous = null,
  programs,
  leaving = false,
  keeps,
}) {
  const farmAddress = pda.farm(project, id);
  const p = piece({
    project,
    asset,
    wallet: player,
    collection,
    hasAuthority,
    tokenMetadata: tm,
    compressed,
    ...keeps,
  });
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
      player_rewards:
        leaving && !farm.farmed.Tokens
          ? ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint))
          : null,
      profile: profileOf(project, farm, player),
    },
    proof: p.proof,
    writable: p.writable,
  };
}

/** A further seat's group of a call of several (`NftSeat`): the seat, its NFT's accounts (`anotherMetas`), its box and
 * order leaving a mission that rolls (the program's address for none), then its proof (and an unstake's prize's). */
const seatGroup = (seat, p, box = null, order = null) => [
  meta(seat, false, true),
  ...anotherMetas({ ...p, proof: [] }),
  meta(box ?? lootProgram(), false, false),
  meta(order ?? lootProgram(), false, Boolean(order)),
  ...p.proof,
];

/**
 * `player` stakes an NFT: on a seat of its own in a farm of collectibles, or as the booster of the player's token seat
 * in a farm of tokens. Any kind (`piece`): a Core asset, a Token Metadata NFT's mint with `tokenMetadata`, or
 * `compressed` (after a `proveLeafIx` in the same transaction). `previous`: in a farm that watches, the last staker of
 * an NFT that changed hands, whose seat this takes over (alone). In a farm of collectibles, `more` NFTs (each { asset,
 * collection, hasAuthority, tokenMetadata, compressed }) go in the same call at the same tier, one fee, by their seats'
 * addresses. `extra` carries reward token hooks/memos and Core transfer adapter accounts.
 */
export const stakeNftIx = ({
  player,
  project,
  id,
  farm,
  asset,
  collection,
  hasAuthority = true,
  tokenMetadata: tm,
  compressed,
  previous = null,
  tier = 0,
  programs,
  more = [],
  extra = [],
}) => {
  // Its lock's end, when the farm keeps one, is written on it.
  const keeps = farmKeeps(farm, { writes: Boolean(farm.lock_key) });
  const [first, ...rest] = ascending(
    [{ asset, collection, hasAuthority, tokenMetadata: tm, compressed }, ...more].map(n =>
      nftSeat({ player, project, id, farm, ...n, previous, programs, keeps }),
    ),
    x => x.accounts.seat,
  );
  const seat = withPrograms({ ...first, kind: first.kind }, rest);
  const groups = rest.flatMap(x => seatGroup(x.accounts.seat, x));
  return lootIx('stake_nft', { tier }, seat.accounts, {
    remaining: [...seat.proof, ...groups, ...tailOf(extra)],
    writable: seat.writable,
  });
};

/**
 * `player` takes an NFT out once its lock has run: it grows on its way out (a farm with growth writes on it, or on its
 * Sheet), and from its own seat takes its tier's prize. `forfeit` gives up the rewards and the prize. `needPrize` (true
 * by default): a mission prize that can't be given refuses the unstake (`PrizeNotCovered`) and the seat stays; false
 * lets the NFT go home without it (`Unseated.prize_missed`). Leaving a tier
 * that rolls (`roll`: its box id, `boxes` its decoded box by id), the NFT is rolled on that box, in an order named by
 * `nonce` (`namedRollNonce`: the NFT's own on a box that holds it; its player or the project's keys then ask the oracle,
 * `askRollIx`, and settles); a box that can burn it or give it away keeps it in the project's hands until then. `more`
 * NFTs of the player's in the farm (each { asset, collection, hasAuthority, tokenMetadata, compressed, tier, roll }) leave
 * in the same call, one fee, one transfer of rewards: by their seats' addresses, the `i`th's roll at `nonce + 2i` and its
 * prize's at `nonce + 2i + 1` (`seatNonces` says which NFT has which). One still locked refuses the whole call.
 */
export const unstakeNftIx = ({
  player,
  project,
  id,
  farm,
  asset,
  collection,
  hasAuthority = true,
  tokenMetadata: tm,
  compressed,
  forfeit = false,
  needPrize = true,
  roll = null,
  nonce = 0n,
  tier,
  projectCollection,
  poolMints,
  items,
  nft,
  boxes = {},
  programs,
  more = [],
  extra = [],
}) => {
  const seats = ascending(
    [{ asset, collection, hasAuthority, tokenMetadata: tm, compressed, tier, roll }, ...more].map(n => {
      // It grows on its way out; a mission that rolls may hand it to the project.
      const keeps = farmKeeps(farm, { writes: Boolean(farm.growth?.length), rolls: n.roll != null });
      return { n, seat: nftSeat({ player, project, id, farm, ...n, programs, leaving: true, keeps }) };
    }),
    x => x.seat.accounts.seat,
  );
  const several = seats.length > 1;
  // Each seat's mission: the box and the order its roll is made in, at `nonce + 2i`; its prize (its tier's) after its
  // proof, a roll's order at `nonce + 2i + 1`. A forfeit takes neither the prize nor the rewards (the program reads
  // neither), so a call of one passes neither: the smallest way out. In a call of several each seat with a prize passes
  // its accounts, given or not, so the next seat's start where the program looks.
  const parts = seats.map(({ n, seat }, i) => {
    const at = BigInt.asUintN(64, toBigInt(nonce) + 2n * BigInt(i));
    const prize = n.tier != null && (!forfeit || several) ? farm.tiers[n.tier]?.prize : null;
    const prized = prize
      ? prizeMetas({
          project,
          collection: projectCollection ?? n.collection,
          prize,
          winner: player,
          nonce: BigInt.asUintN(64, at + 1n),
          poolMints,
          items,
          nft,
          programs,
        })
      : [];
    const rolls =
      n.roll != null
        ? {
            box: pda.box(project, n.roll),
            order: pda.order(project, player, namedRollNonce(boxes[n.roll], seat.accounts.asset, at)),
          }
        : { box: null, order: null };
    return { seat, prize, prized, rolls };
  });
  const [first, ...rest] = parts;
  const seat = withPrograms(
    first.seat,
    rest.map(x => x.seat),
  );
  if (forfeit) seat.accounts.player_rewards = null;
  const groups = rest.flatMap(x => [
    ...seatGroup(x.seat.accounts.seat, x.seat, x.rolls.box, x.rolls.order),
    ...x.prized,
  ]);
  return lootIx(
    'unstake_nft',
    { forfeit, nonce, need_prize: needPrize },
    {
      ...seat.accounts,
      loot_box: first.rolls.box,
      order: first.rolls.order,
      associated_token_program: parts.some(x => x.prize?.Tokens) ? ASSOCIATED_TOKEN_PROGRAM : null,
    },
    {
      remaining: [...seat.proof, ...first.prized, ...groups, ...tailOf(extra)],
      writable: [...(forfeit ? [] : payWrites(farm)), ...seat.writable],
    },
  );
};

/** The nonce each NFT's mission roll is named by in an `unstakeNftIx` of several (`assets`), in the order the call
 * takes them: the `i`th by its seat's address `nonce + 2i` (its order at `namedRollNonce` of it), its prize's roll
 * `nonce + 2i + 1` (at `prizeRollNonce`). */
export const seatNonces = (project, id, farm, player, assets, nonce = 0n) =>
  Object.fromEntries(
    ascending(assets, a => pda.seat(pda.farm(project, id), farm.farmed.Tokens ? player : a)).map((a, i) => [
      a,
      toBigInt(nonce) + 2n * BigInt(i),
    ]),
  );

/**
 * `player` collects what the seat of `by` owes (their own address for tokens, a collectible's asset); with `compound`, a
 * token seat's is staked instead (a seat with a booster on needs a `refreshSeatIx` of it first: `stakeRefreshFirst`). `held`: in a farm
 * that watches, what shows the player still holds the seat's NFT (the Core asset, their token account of a Token
 * Metadata NFT, or a compressed NFT's record, `pda.leaf`, with its `tree`), which such a farm refuses to go without
 * (`NotProven`). `more` seats of the player's in the farm (each { by, held, tree }) collect in the same call, one fee,
 * one transfer.
 */
export const harvestIx = ({
  player,
  project,
  id,
  farm,
  by = player,
  held = null,
  tree = null,
  compound = false,
  programs,
  more = [],
  extra = [],
}) => {
  const farmAddress = pda.farm(project, id);
  const [first, ...rest] = ascending(
    [{ by, held, tree }, ...more].map(x => ({ ...x, seat: pda.seat(farmAddress, x.by) })),
    x => x.seat,
  );
  const groups = rest.flatMap(x => [
    meta(x.seat, false, true),
    meta(x.held ?? lootProgram(), false, false),
    meta(x.tree ?? lootProgram(), false, false),
  ]);
  return lootIx(
    'harvest',
    { compound },
    {
      ...farmSide(project, id, farm),
      player,
      seat: first.seat,
      player_rewards: ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)),
      held: first.held,
      tree: first.tree,
      // Compounding moves what is owed into the staked vault (a farm of tokens whose rewards are the staked token).
      staked_vault: compound ? pda.staked(farmAddress) : null,
    },
    { remaining: [...groups, ...tailOf(extra)], writable: payWrites(farm) },
  );
};

/**
 * Anyone (`signer`) writes what a seat's NFT grew (a farm with growth), then reads its boosts again. `seat` is the
 * decoded Seat of `by`. Its NFT is any kind (`piece`): a Core asset (`collection` its collection now, the project's when
 * left out; `hasAuthority` false for one the project has no authority over), a Token Metadata NFT (`tokenMetadata`), or
 * `compressed` (after a `proveLeafIx`). What shows where it is must come: a compressed NFT's proof, and a Token Metadata
 * NFT's token account that holds it, `holder`'s (its staker's, or a watched NFT's buyer's). `signer` pays for what the
 * write adds. `extra`: the reward mint's hook accounts.
 */
export const refreshSeatIx = ({
  signer,
  project,
  id,
  farm,
  by,
  seat,
  collection,
  hasAuthority = true,
  tokenMetadata: tm,
  compressed,
  holder = seat.player,
  extra = [],
}) => {
  const address = pda.seat(pda.farm(project, id), by);
  // A token seat with no booster: its own address stands in for the NFT.
  const p =
    seat.asset === NO_ADDRESS
      ? standIn(address)
      : piece({
          project,
          asset: seat.asset,
          wallet: holder,
          collection,
          hasAuthority,
          tokenMetadata: tm,
          compressed,
          ...farmKeeps(farm, { writes: Boolean(farm.growth?.length) }),
          moves: false,
          locks: false,
        });
  return lootIx(
    'refresh_seat',
    {},
    {
      signer,
      ...farmSide(project, id, farm),
      seat: address,
      ...p.accounts,
      profile: profileOf(project, farm, seat.player),
    },
    { remaining: tailOf(extra), writable: p.writable },
  );
};

// ---------------------------------------------------------------- Token Metadata NFTs

const tmPda = seeds =>
  findProgramAddress(
    seeds.map(s => (typeof s === 'string' ? utf8(s) : s)),
    TOKEN_METADATA_PROGRAM,
  )[0];

/**
 * Whether a classic mint's account data (`data`, 82 bytes) is an NFT's, as the program takes one:
 * exactly one token, no decimals, initialized, and no mint authority or only its edition's. A semi-fungible item's
 * mint (several units, or one that can still mint) is refused when handed in (`NotAnNft`).
 */
export function isNftMint(mint, data) {
  if (!data || data.length !== MINT_BYTES || data[44] !== 0 || data[45] !== 1) return false;
  if (data.subarray(36, 44).some((b, i) => b !== (i === 0 ? 1 : 0))) return false;
  const tag = data.subarray(0, 4);
  if (tag.every(b => b === 0)) return true;
  return (
    tag[0] === 1 &&
    tag[1] === 0 &&
    tag[2] === 0 &&
    tag[3] === 0 &&
    encodeBase58(data.subarray(4, 36)) === tokenMetadata.edition(mint)
  );
}

/** A Token Metadata NFT's own addresses: its metadata, its edition, and a pNFT's record of a token account. */
export const tokenMetadata = {
  metadata: mint => tmPda(['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint)]),
  edition: mint => tmPda(['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint), 'edition']),
  record: (mint, token) =>
    tmPda(['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint), 'token_record', addressBytes(token)]),
};
