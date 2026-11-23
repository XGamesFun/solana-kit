// Money coming in (a payment, a box opened, a purchase, its roll and its settle, a refund), and the project's tokens
// moving out.
import { NO_ADDRESS } from '../../chain/base58.js';
import { encodeInstruction } from '../../chain/borsh.js';
import { toBigInt } from '../../chain/bytes.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../chain/pda.js';
import { createAssociatedTokenAccountIdempotent, meta } from '../../chain/programs.js';
import IDL from '../idl/loot.js';
import {
  ata,
  BUBBLEGUM_PROGRAM,
  COMPRESSION_PROGRAM,
  lootProgram,
  MPL_CORE_PROGRAM,
  NOOP_PROGRAM,
  pda,
  vault,
} from '../pda.js';
import { boxPoolMints, ONLY_MOVES, pieceMetas, prizeMints, standIn, tokenProgramOf } from './shared.js';
import { lootIx, reference, tailOf } from './base.js';
import {
  boxHolds,
  boxReads,
  BUBBLEGUM_CORE_SIGNER,
  chosenShares,
  destinationAccounts,
  entryAccounts,
  gateAccounts,
  limitAccounts,
  nonceOn,
  prizeAccounts,
  prizeMetas,
  shareAccounts,
  sharesBurn,
  shownAccounts,
  shownFor,
  ticketOf,
  traitTables,
} from './tail.js';
import { piece } from './piece.js';

// ---------------------------------------------------------------- in: money comes in

/**
 * `player` (or a sponsor, or the project's own keys funding a pool) pays `amount` of `mint`, split at once by `shares`.
 * The rest goes to the project's `treasury` wallet. The player opens any account this pays into that is not there.
 * @param {{ player: any, project: any, mint: any, treasury: any, amount: any, shares?: any[], reference?: any,
 *   playerToken?: any, holders?: any, programs?: any, extra?: any[] }} options
 */
export function payIx({
  player,
  project,
  mint,
  treasury,
  amount,
  shares = [],
  reference: ref,
  playerToken,
  holders,
  programs,
  extra = [],
}) {
  const tokenProgram = tokenProgramOf(programs, mint);
  return lootIx(
    'pay',
    { amount, shares, reference: reference(ref) },
    {
      player,
      project,
      mint,
      treasury,
      treasury_token: ata(treasury, mint, tokenProgram),
      player_token: playerToken ?? ata(player, mint, tokenProgram),
    },
    {
      remaining: [...shareAccounts(project, shares, mint, { holders, programs, treasury }), ...tailOf(extra)],
      writable: sharesBurn(shares) ? ['mint'] : [],
    },
  );
}

/**
 * Opens a loot box (`box` the decoded LootBox at `boxAddress`), in an order at `nonce` (a box whose roll moves the
 * numbers of the NFT it rolls on: at that NFT's, `nonceOn`, whatever `nonce` says). `poolMints` maps each pool its
 * prizes take tokens from to its mint (a pool's tokens won wait in the project's vault for that mint); one not given
 * is taken to be in the box's currency, one given as null is closed. `shown`: an NFT the player shows for the box's
 * gate or odds; the player's profile goes before it whenever the box's gate or odds read one (`boxReads`); `listProof`:
 * for a list gate, the proof's nodes. `chosenRecipient`: the wallet (or, for a share with an
 * item, the collectible, `chosen`) the buyer names for a share the box lets them choose. Every open asks the oracle,
 * even of a box with nothing random (which sells in one step with `buyIx`, when it rolls on no NFT).
 * The player opens the project's vault for the price's mint, and for each prize's, when it is not there. A box that
 * limits each wallet counts the purchase in the player's counts (`pda.counts`, its rent theirs).
 * @param {{ player: any, project: any, box: any, nonce: any, boxAddress?: any, maxPrice?: any, count?: number,
 *   items?: Record<string, any>, shown?: any, profile?: any, listProof?: any, subject?: any, chosenRecipient?: any,
 *   chosen?: any, settler?: string, poolMints?: any, playerToken?: any, programs?: any, extra?: any[],
 *   person?: any }} options
 */
export function openBoxIx({
  player,
  project,
  box,
  boxAddress,
  nonce,
  maxPrice,
  count = 1,
  items = {},
  shown,
  profile,
  listProof,
  subject,
  chosenRecipient = null,
  chosen = null,
  settler = NO_ADDRESS,
  poolMints,
  playerToken,
  programs,
  extra = [],
  person = null,
}) {
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
  const on = box.subject
    ? piece({ project, wallet: player, ...subject, moves: holds, locks: false, writes: false })
    : standIn(address);
  if (box.subject && holds) nonce = nonceOn(on.accounts.asset);
  // A list's proof (or a stake gate's seat and farm); then the player's own profile, for a box whose gate or odds read
  // one (`profile`: its address, the player's by default); then the NFT shown, for one whose gate or odds read an NFT
  // (for a box that rolls on an NFT, a compressed one's proof instead: that NFT is the piece).
  const gate = [
    ...gateAccounts(project, { gate: box.gate, wallet: player, listProof }),
    ...(boxReads(box, true) ? [meta(profile ?? pda.profile(project, player), false, false)] : []),
    ...(box.subject ? on.proof : boxReads(box, false) ? shownAccounts(project, shown) : []),
  ];
  return lootIx(
    'open_box',
    {
      nonce,
      max_price: maxPrice ?? box.price * BigInt(count),
      chosen_recipient: chosenRecipient,
      version: box.version,
      count,
      settler,
    },
    {
      loot_box: address,
      player,
      project,
      mint,
      player_token: playerToken ?? ata(player, mint, tokenProgram),
      vault: vault(project, mint, tokenProgram),
      chosen,
      ...limitAccounts(project, player, box.per_wallet, person),
      ...on.accounts,
    },
    {
      remaining: [
        ...entryAccounts(project, box.entries, items),
        ...prizeAccounts(project, box.entries, poolMints, programs),
        ...gate,
        ...tailOf(extra),
      ],
      writable: on.writable,
    },
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
export function buyIx({
  player,
  project,
  box,
  boxAddress,
  maxPrice,
  count = 1,
  treasury,
  chosenRecipient = null,
  chosen = null,
  nonce = 0n,
  shown,
  listProof,
  items = {},
  poolMints = {},
  nfts = {},
  holders,
  playerToken,
  programs,
  extra = [],
  person = null,
}) {
  const mint = box.currency;
  const tokenProgram = tokenProgramOf(programs, mint);
  const address = boxAddress ?? pda.box(project, box.box_id);
  const shares = chosenShares(box.shares, chosenRecipient);
  const made = {};
  const prizes = buyGives(box, count).flatMap(({ prize, k }) => {
    const item = prize.Item?.[0];
    const lines = prizeMetas({
      project,
      prize,
      winner: player,
      nonce: toBigInt(nonce) + BigInt(k),
      poolMints,
      items,
      nft: nfts[prize.Nft?.nft],
      made: made[item] ?? 0,
      projectMint: mint,
      programs,
    });
    if (item !== undefined) made[item] = (made[item] ?? 0) + 1;
    return lines;
  });
  return lootIx(
    'buy',
    {
      max_price: maxPrice ?? box.price * BigInt(count),
      chosen_recipient: chosenRecipient,
      version: box.version,
      nonce: toBigInt(nonce),
      count,
    },
    {
      player,
      project,
      loot_box: address,
      mint,
      player_token: playerToken ?? ata(player, mint, tokenProgram),
      treasury,
      treasury_token: ata(treasury, mint, tokenProgram),
      chosen,
      ...limitAccounts(project, player, box.per_wallet, person),
    },
    {
      remaining: [
        // Only the gate's own account: the player's profile for a gate that reads one, else the NFT shown.
        ...gateAccounts(project, {
          gate: box.gate,
          wallet: player,
          shown: shownFor(project, box.gate, player, shown),
          listProof,
        }),
        ...shareAccounts(project, shares, mint, { holders, programs, treasury }),
        ...prizes,
        ...tailOf(extra),
      ],
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
export function callbackRollIx({
  order,
  orderState,
  box,
  boxAddress,
  randomness,
  project,
  poolMints,
  items = {},
  programs,
  extra = [],
}) {
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
  if (prizes.length)
    keys.push(
      meta(TOKEN_PROGRAM, false, false),
      meta(TOKEN_2022_PROGRAM, false, false),
      meta(projectAddress, false, false),
      ...prizes,
    );
  keys.push(...tailOf(extra));
  return {
    programId: lootProgram(),
    keys,
    data: encodeInstruction(IDL, 'callback_roll', { randomness: Uint8Array.from(randomness) }),
  };
}

/**
 * The accounts of what an order won (`order.won`), in order, as `settle` hands each over:
 *   Item    the item; for a collectible (`items[id]` its decoded Item), its collection, its address, Metaplex Core;
 *           for a fresh one (`drawn` set), then the table of each of its table traits
 *   Tokens  the mint, the project's vault for it, the player's account of it (`prizeTo`, when given)
 * `giveUp`: the places in `won` of the prizes the player, settling their own order, gives up (tokens they can't receive
 * stay in the project's vault; a collectible's serial is voided): the vault, or the item, goes in the receiver's place.
 *   Nft     the NFT as `piece` takes it (`nfts[nft]` its kind), going to the player, then a compressed NFT's proof
 *   Compressed  the item, the tree's config, the tree, the collection, Bubblegum's programs; for a fresh one, then its
 *           tables and the Sheet of the NFT it mints
 */
export function wonAccounts({
  order,
  items = {},
  nfts = {},
  prizeTo,
  putBack = [],
  giveUp = [],
  programs,
  from = 0,
  upto = order.won.length,
  tree,
  treeMinted = 0n,
  unminted = [],
}) {
  const project = order.project;
  // A compressed prize is minted into `tree` (any of the project's with room), the next NFT it mints: after
  // `treeMinted`, and the compressed prizes before it in this part that were minted. One of an item whose collection
  // lacks Bubblegum's plugin (`unminted`: those collections) gives nothing and mints nothing: the next takes its place.
  let minted = BigInt(treeMinted);
  const skips = new Set(unminted);
  // The player, settling their own order, gives up the prizes at these places in `won` (tokens: the project's vault in
  // their account's place, so they stay there; a collectible: the item in its address's place, its serial voided).
  const givesUp = new Set(giveUp.map(Number));
  return order.won.slice(from, upto).flatMap((won, k) => {
    const up = givesUp.has(from + k);
    if (won.Compressed) {
      const { item: id, drawn } = won.Compressed;
      const address = pda.item(project, id);
      const item = items[id];
      if (!item) throw new Error(`settling item ${id} needs the item (items), for its collection and its traits`);
      const tables = drawn != null ? traitTables(item).map(t => meta(pda.table(project, t), false, false)) : [];
      if (!tree)
        throw new Error('settling a compressed prize needs the project tree it is minted into (tree, treeMinted)');
      const asset = pda.compressedAsset(tree, minted);
      if (!skips.has(item.collection)) minted += 1n;
      return [
        meta(address, false, true),
        meta(pda.treeConfig(tree), false, true),
        meta(tree, false, true),
        meta(item.collection, false, true),
        meta(BUBBLEGUM_PROGRAM, false, false),
        meta(COMPRESSION_PROGRAM, false, false),
        meta(NOOP_PROGRAM, false, false),
        meta(MPL_CORE_PROGRAM, false, false),
        meta(BUBBLEGUM_CORE_SIGNER, false, false),
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
      const tables = drawn != null ? traitTables(item).map(t => meta(pda.table(project, t), false, false)) : [];
      return [
        meta(address, false, true),
        meta(item.collection, false, true),
        meta(up ? address : pda.itemAsset(address, serial), false, true),
        meta(MPL_CORE_PROGRAM, false, false),
        ...tables,
      ];
    }
    if (won.Tokens) {
      const { mint } = won.Tokens;
      const program = tokenProgramOf(programs, mint);
      const kept = vault(project, mint, program);
      return [
        meta(mint, false, false),
        meta(kept, false, true),
        meta(up ? kept : (prizeTo ?? ata(order.player, mint, program)), false, true),
      ];
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
export const boxDraws = box => (box.slots?.length ? box.slots.reduce((n, s) => n + Number(s.count), 0) : 1);

/** How many settle parts an order of `opens` opens of `box` takes at most: each card, at its most calls, and with
 * shares one more (the first call splits the payment, alone when no prize fits beside its shares: `upto` 0). */
export function settleParts(box, opens = 1) {
  const draws = box.slots?.length ? box.slots.reduce((n, s) => n + Number(s.count), 0) : 1;
  const cards = Math.max(1, ...box.entries.map(e => e.prizes.length)) * draws * Math.max(1, opens);
  return (
    Math.max(1, Math.ceil(cards / Math.floor((TRACE_LIMIT - SETTLE_BASE_CALLS) / 7))) +
    ((box.shares ?? []).length ? 1 : 0)
  );
}

/** The heap a settle that moves three or more NFTs asks for (`settleHeapFrame`): all a transaction may have, 256 KiB. */
export const LARGE_SETTLE_HEAP = 256 * 1024;

/** Whether an order rolled on an NFT: its `subject` names one (null for none). */
const rolledOn = order => Boolean(order.subject) && order.subject !== NO_ADDRESS;

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
  const moves = (order.won ?? []).filter(w => w.Nft).length + (rolledOn(order) ? 1 : 0);
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
  const moves = won.some(w => w.Nft || w.Compressed) || won.length > 8 || rolledOn(order);
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
 * them (one its collection won't let move). `giveUp`: the places in `won` of tokens or collectibles the player,
 * signing, gives up because they can't receive them (an account its issuer froze, a collection that refuses the mint),
 * so the rest of the order is not held up: tokens given up stay in the project's vault (`PrizeForgone` says which).
 * An NFT proven gone from the project is passed over the same way, with no choice of the player's (`piece`: the Core
 * asset itself, `tokenMetadata.evidence` in its kind, a compressed NFT's record proven again): the NFT the order rolled
 * on is not sent back, burned, given or stashed (`NftGone`), and a stash's NFT it won is not given (`PrizeForgone`
 * for it beside `NftGone`: read it as not given); everything else settles as rolled.
 * `handBack`: the wallet the box's fate gives the NFT rolled on to
 * (`receiverOf`) is an account of the loot program (`handsBack` of it as read), so the program gives it back to the
 * player, and a Token Metadata NFT's `token` is the player's. `extra`: a hook's or a memo's accounts.
 *
 * `upto`, the part (`settle.rs`): `SETTLE_LAST` (the default, past the end) is the last part, all that is left (maybe
 * nothing); 0 gives no prize and only splits the payment; any other gives the prizes from where the last part stopped
 * (`settled`) up to it, and nothing more. The first call, whichever it is, splits the payment (its shares' accounts
 * ride on it whenever `order.drew` is above 0, a roll that gave nothing included), and moves the numbers on an NFT
 * rolled on that the project does not hold (that NFT's accounts ride on it, not on the last part).
 */
export function settleIx({
  signer,
  orderAddress,
  order,
  projectState,
  items,
  nfts,
  prizeTo,
  putBack,
  giveUp,
  subject,
  handBack = false,
  holders,
  programs,
  upto = SETTLE_LAST,
  tree,
  treeMinted,
  unminted,
  extra = [],
}) {
  const project = order.project;
  const from = Number(order.settled ?? 0);
  const last = Number(upto) > order.won.length;
  const end = last ? order.won.length : Math.max(from, Number(upto));
  // The payment is split once, by the first call (`drew` is 0 once it is made).
  const splits = Number(order.drew ?? 0) > 0;
  const prizes = wonAccounts({
    order,
    items,
    nfts,
    prizeTo,
    putBack,
    giveUp,
    programs,
    from,
    upto: end,
    tree,
    treeMinted,
    unminted,
  });
  const tokenProgram = tokenProgramOf(programs, order.mint);
  // The NFT it rolled on, as the settle moves it: given to a wallet that is an account of the loot program, it goes
  // back to its player (`handsBack`), into the player's token account for a Token Metadata NFT.
  // One the project holds goes with the last part; one it doesn't hold has its numbers moved by the first call (the one
  // that splits), its Sheet with it when they go there. Any other part's piece is a stand-in.
  const carries = order.held ? last : splits;
  const receiver = last ? receiverOf(order) : null;
  const on = carries
    ? orderPiece(project, orderAddress, order, subject, handBack && order.fate?.then?.Give ? order.player : receiver)
    : standIn(orderAddress);
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
      remaining: [
        ...on.proof,
        ...prizes,
        ...(splits
          ? shareAccounts(project, order.shares, order.mint, { holders, programs, treasury: projectState.treasury })
          : []),
        ...tailOf(extra),
      ],
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
  return piece({
    project,
    asset: order.subject,
    wallet: stays ? order.player : (receiver ?? order.player),
    ...subject,
    moves: order.held && !stays,
    locks: false,
    writes: shifts,
    burns: burned,
    reads: shifts,
  });
}

/**
 * Whether an NFT the project holds, given to the wallet whose account is `account` (as read: `{ owner }`, or null for
 * none), goes back to its player instead: when that account is the loot program's (the project's
 * own address, a record, a stash, a fee box), where nothing could move it again. A settle's fate and an NFT lottery
 * ticket's price take it as `handBack`.
 */
export const handsBack = account => account?.owner === lootProgram();

/** Where an NFT that is burned but can't be (any kind but Core) is sent: an address nobody holds the key to. */
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

/**
 * Gives an order's payment back to its player, into their account of the mint (`signer`, anyone, opens it when it is
 * not there): an order whose roll failed or never came. A rolled order is settled, never refunded
 * (`orderRefundable`). A purchase counted against a box's limit for each
 * wallet is given back. A purchase that counts its draws in its box's `in_flight` (`order.reserved`, a box that stops
 * selling when an entry runs out) names the box, whose count it leaves. `extra`: a hook's or a memo's accounts.
 * An NFT the order holds that is proven gone from the project (`subject`, as `piece` takes it) is not looked for: the
 * whole payment goes back all the same (`NftGone` beside `OrderRefunded`).
 */
export function refundIx({ signer, orderAddress, order, subject, programs, extra = [] }) {
  const project = order.project;
  const tokenProgram = tokenProgramOf(programs, order.mint);
  // A held NFT goes back to its player.
  const on =
    order.held && rolledOn(order)
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
      counts:
        order.counted == null
          ? null
          : order.person
            ? pda.persons(project, Uint8Array.from(order.person))
            : pda.counts(project, order.player),
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
export function askRollIx({
  payer,
  orderAddress,
  order,
  box,
  settler = NO_ADDRESS,
  poolMints,
  items = {},
  programs,
  shown = null,
  first = firstAsk(order, box),
}) {
  poolMints = boxPoolMints(box, poolMints);
  const opens = prizeMints(box.entries, poolMints).map(({ mint }) =>
    createAssociatedTokenAccountIdempotent(payer, order.project, mint, tokenProgramOf(programs, mint)),
  );
  // A roll's odds are fixed at its first ask: then its player's profile, when the box's odds read one, and an NFT its
  // player shows, when they read an NFT and the roll is on none. A later ask reads nothing.
  const reads = askReads(box, order);
  const player = order.player ?? payer;
  const odds = first
    ? [
        ...(reads.profile ? [meta(pda.profile(order.project, player), false, false)] : []),
        ...(reads.nft ? shownAccounts(order.project, shown) : []),
      ]
    : [];
  const ask = lootIx(
    'ask_roll',
    { settler },
    { payer, order: orderAddress, loot_box: order.loot_box, project: order.project },
    {
      remaining: [
        ...entryAccounts(order.project, box.entries, items),
        ...prizeAccounts(order.project, box.entries, poolMints, programs),
        ...odds,
      ],
    },
  );
  return [...opens, ask];
}

/**
 * What a roll's first ask reads for its box's odds (`ask_roll`): `profile`, the order's player's profile, when any odds
 * rule of the box reads a profile; `nft`, an NFT the player shows, when any reads an NFT and the roll is on none (neither
 * the box nor the order names one). Unlike a purchase, a gate is not read at the ask.
 */
export function askReads(box, order = {}) {
  const rules = (box.odds ?? []).map(o => o.boost.rule);
  const onNft = Boolean(box.subject) || (Boolean(order.subject) && order.subject !== NO_ADDRESS);
  return {
    profile: rules.some(r => r.of === 'Profile' || r.of?.Profile !== undefined),
    nft: !onNft && rules.some(r => !(r.of === 'Profile' || r.of?.Profile !== undefined)),
  };
}

/**
 * Whether the next ask of `order` is its first, the one that reads the odds' accounts: it was never asked
 * (`asked_first` 0, or an order not made yet), or its box was edited since (the edit cleared what it read).
 */
export const firstAsk = (order, box) =>
  !order.asked_first ||
  BigInt(order.asked_first) === 0n ||
  (order.box_version != null && order.box_version !== box.version);

/**
 * How much each NFT of `nfts` would raise a box's odds at a roll's first ask, by the box's rules on an NFT, and the one
 * that raises the most: { best, raised }. `nfts`: [{ asset, itemId, attributes }] as read (a Core collectible of the
 * project's: its item and its attributes). `raised` maps each asset to the basis points its rules add in all. A rule
 * on time (`Ahead`, `Passed`, `Within`, `Older`) or on another collection counts nothing here; pass such an NFT by name.
 */
export function bestShown(box, nfts) {
  const value = (nft, key) => (key === 'item_id' ? nft.itemId : nft.attributes?.[key]);
  const passes = (rule, nft) => {
    if (rule.of?.Item !== undefined && Number(nft.itemId) !== Number(rule.of.Item[0])) return false;
    if (rule.of?.Collection !== undefined || rule.of === 'Profile' || rule.of?.Profile !== undefined) return false;
    const v = value(nft, rule.key);
    const t = rule.test;
    if (t === 'Any' || t?.Any !== undefined) return true;
    if (t?.AtLeast) return v !== undefined && Number(v) >= Number(t.AtLeast[0]);
    if (t?.AtMost) return v !== undefined && Number(v) <= Number(t.AtMost[0]);
    if (t?.OneOf) return v !== undefined && t.OneOf.texts.map(String).includes(String(v));
    return false;
  };
  const raise = (boost, nft) => {
    const e = boost.effect;
    if (e.Flat) return BigInt(e.Flat[0]);
    const points = BigInt(Math.max(0, Math.floor(Number(value(nft, boost.rule.key)) || 0)));
    return BigInt(e.PerPoint.bps) * (points < BigInt(e.PerPoint.most) ? points : BigInt(e.PerPoint.most));
  };
  const raised = {};
  let best = null;
  for (const nft of nfts) {
    const total = (box.odds ?? []).reduce((n, o) => n + (passes(o.boost.rule, nft) ? raise(o.boost, nft) : 0n), 0n);
    raised[nft.asset] = total;
    if (total > 0n && (best === null || total > raised[best])) best = nft.asset;
  }
  return { best, raised };
}

// ---------------------------------------------------------------- out: the project's tokens move

/**
 * The authority moves the project's tokens: `from` { Pool: [i] }, { Mint: [mint] } (newly minted) or { Farm: [id] } (what
 * that farm's rewards vault holds free, beyond what it owes its seats: a fixed amount; `farm`: the farm decoded, so its
 * record of ends comes when it keeps one), `to` a pool, a wallet, an account, the treasury (`treasury`, the project's
 * wallet), a collectible's holder or 'Burn', `amount` { Fixed: [n] } or { Bps: [bps] } of a pool. The authority opens the
 * account it pays into when it is not there; a collectible nobody holds gets nothing.
 */
export function moveTokensIx({
  authority,
  project,
  mint,
  from,
  to,
  amount,
  reference: ref,
  holders,
  programs,
  treasury,
  farm = null,
  extra = [],
}) {
  const writes = Boolean(from.Mint) || to === 'Burn';
  return lootIx(
    'move_tokens',
    { from, to, amount, reference: reference(ref) },
    // What a farm holds free comes out of its rewards vault, passed as the pool, with the farm.
    {
      authority,
      project,
      mint,
      pool: from.Pool
        ? pda.pool(project, from.Pool[0])
        : from.Farm
          ? pda.rewards(pda.farm(project, from.Farm[0]))
          : null,
      farm: from.Farm ? pda.farm(project, from.Farm[0]) : null,
      farm_ends: from.Farm && farm?.keeps_ends ? pda.ends(pda.farm(project, from.Farm[0])) : null,
    },
    {
      remaining: [...destinationAccounts(project, to, mint, { holders, programs, treasury }), ...tailOf(extra)],
      writable: writes ? ['mint'] : [],
    },
  );
}
