// Auctions: opening one, bidding, and ending it.
import { toBigInt } from '../../chain/bytes.js';
import { meta } from '../../chain/programs.js';
import { decode } from '../accounts.js';
import { ata, pda, vault } from '../pda.js';
import {
  heldPiece,
  holds,
  ONLY_MOVES,
  pieceMetas,
  recordTerms,
  standIn,
  stored,
  tokenProgramOf,
  twoAccounts,
} from './shared.js';
import { lootIx, reference, tailOf } from './base.js';
import { gateAccounts, prizeNonce, prizeRollNonce, shareAccounts, sharesBurn, shownFor } from './tail.js';
import { piece } from './piece.js';

// ---------------------------------------------------------------- auctions

/**
 * What a bid signs: the auction's bytes but the bid, which sits last (`high_bidder`, `high`, `last_bid_at`, `held`:
 * 60 bytes, and an auction of NFT bids' room for `MAX_BID_NFTS` after them). `auction`: the decoded Auction, or its
 * account's bytes.
 */
export function auctionTerms(auction) {
  if (auction instanceof Uint8Array) {
    const room = decode('Auction', auction).nft_bids ? 32 * MAX_BID_NFTS : 0;
    return recordTerms('Auction', auction, data => [data.length - 60 - room, data.length]);
  }
  // Written back with no bid's NFTs, its bytes end at the bid's 60.
  return recordTerms(
    'Auction',
    { ...auction, gate: auction.gate ?? null, nft_bids: auction.nft_bids ?? null, held: [] },
    data => [data.length - 60, data.length],
  );
}

/** When bids close, as the program reckons it: `ends_at`, or `extend` seconds after the last bid when that is later. */
export const auctionEnds = auction => {
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
 * and pays its rent: anyone for an NFT of any kind and any collection they hold (`piece`: `collection` a Core asset's
 * own, `tokenMetadata`, or `compressed` after a `proveLeafIx`); the project's owner or authority also for a new unit
 * of its item (one the shop has switched off too), or a roll of one of its boxes (a mystery lot: the box must be
 * written and make an order with the auction's shares within one call's growth, `LotRefused`; the auction's shares
 * split the winning bid, so a share of the box that burns burns nothing here). Its address names the seller, so an id
 * is the seller's own. An NFT lot of another collection can be stopped or taken back by whoever controls that
 * collection while the project holds it: its seller is paid only when it reaches the winner (`endAuctionIx`).
 */
export function openAuctionIx({ seller, project, collection, tokenMetadata: tm, compressed, id, mint, args }) {
  stored(args.shares);
  const auction = pda.auction(project, seller, id);
  const asset = args.lot.Asset?.[0] ?? null;
  // An item lot reads no NFT: the auction's own address stands in.
  const p = asset
    ? piece({ project, asset, wallet: seller, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES })
    : standIn(auction);
  return lootIx(
    'open_auction',
    { id, args: { ...args, gate: args.gate ?? null, nft_bids: args.nft_bids ?? null } },
    {
      seller,
      project,
      auction,
      mint,
      item: args.lot.Item ? pda.item(project, args.lot.Item[0]) : null,
      loot_box: args.lot.Roll ? pda.box(project, args.lot.Roll[0]) : null,
      ...p.accounts,
    },
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
export function bidIx({
  bidder,
  project,
  id,
  auction,
  amount,
  shown,
  listProof,
  nfts = [],
  held = [],
  hold = false,
  bidderToken,
  programs,
  extra = [],
}) {
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
    {
      remaining: [
        ...gateAccounts(project, {
          gate: auction.gate,
          wallet: bidder,
          shown: shownFor(project, auction.gate, bidder, shown),
          listProof,
        }),
        ...bundle,
        ...tailOf(extra),
      ],
      writable: auction.nft_bids ? [] : ['vault'],
    },
  );
}

/** How an auction's end goes, as `end_auction`'s `ending` takes it. With no bid each is the same: the lot goes home. */
export const ENDINGS = Object.freeze(['Deliver', 'LotFirst', 'CallOff']);

/**
 * An NFT lot's or bid's piece on its way to `wallet`, with `evidence` (a Token Metadata NFT's account that holds it now,
 * or its mint when burned) in the receiver's account's place: the end reads the project's account first, and only when
 * that shows nothing does it read this one, which then shows the NFT gone.
 */
function evidencedPiece({ project, asset, wallet, collection, tokenMetadata: tm, compressed, evidence = null }) {
  const p = piece({ project, asset, wallet, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES });
  if (tm && evidence) p.accounts.token = evidence;
  return twoAccounts(p);
}

/**
 * Anyone ends auction `id` once it is over (its seller calls off one with no bid). `auction` is the decoded Auction,
 * `ending` one of `ENDINGS` (with no bid each is the same: the lot goes home to its seller, or stays where it is when it
 * is proven gone). With a bid in:
 *   'Deliver' (the default): the lot goes to the high bidder and the winning bid through the shares to whoever owned the
 *     lot (the seller of an NFT, the treasury for the project's item or roll), in one instruction, however long after the
 *     end it is sent. An item that is a collectible is minted to the winner at `pda.itemAsset(item, serial)`; a roll of a
 *     box is made for them in an order at `prizeRollNonce(nonce)`, `nonce` being `prizeNonce(auction, last_bid_at)` by
 *     default, which `signer` pays for. An NFT lot that can't move now fails the end, which waits: send it again later.
 *     Once the lot went first (`auction.proceeds_owed` above 0), it pays what the bid still owes and closes the auction:
 *     the auction's address stands in for the lot, then the shares' accounts, then a bid's NFTs to the seller.
 *   'LotFirst': an NFT lot only, for an end too wide for one transaction (a compressed lot's long proof with many shares
 *     and a hooked coin): the lot goes to the winner now and the whole bid is written as owed; a later 'Deliver' pays it.
 *     Its accounts are the lot's piece and proof, then the tail: no shares, no winning NFT.
 *   'CallOff': an NFT lot's sale, before the lot moved (`CantCallOff` after): the winning bid goes back to its bidder
 *     (tokens into their account, or its NFTs, each moved or made a hold for them) and the lot home to its seller (moved,
 *     or made a hold for them). Anyone may when the lot or an NFT of the bid is proven gone (its collection took it back
 *     or burned it): that one stays gone. Otherwise only the project's owner or authority, for the project fee.
 * `signer` opens any account the end pays into that is not there. `item` is the decoded Item of an item lot; for an NFT
 * lot, `collection` its Core collection now, `tokenMetadata` for a Token Metadata NFT, or `compressed` (after a
 * `proveLeafIx`: a compressed lot's record must be current whenever it is read, with no bid too). The lot's accounts
 * also show whether the project still holds it: for a Token Metadata lot that left, `evidence` names the token account
 * that holds it now, or its mint when it was burned. `held`: the kinds of a winning bid's NFTs (`auction.held`, in order:
 * { collection, tokenMetadata, evidence }).
 * `hold` (true for every NFT it may apply to, or a list of assets): a lot going home (no bid, or the sale called off) is
 * made a hold for its seller (its hold passed as `order`, the lot's accounts only showing it is held); an NFT of a bid
 * going back on a call-off, or paid to the seller after the lot went first, or to the treasury for the project's own
 * lot, is made a hold for whoever it goes to (its hold's address in its piece's place). Anyone then delivers each with
 * `releaseIx`, and the end's sender gets the rent back then. A sold lot is never made a hold (`LotRefused`), nor an NFT
 * of a bid that buys a player's lot: the two move together, or the end waits.
 */
export function endAuctionIx({
  signer,
  project,
  projectState,
  id,
  auction,
  item = null,
  collection,
  tokenMetadata: tm,
  compressed,
  evidence = null,
  held = [],
  hold = false,
  ending = 'Deliver',
  reference: ref,
  nonce,
  holders,
  programs,
  extra = [],
}) {
  if (!ENDINGS.includes(ending)) throw new Error(`An auction ends as one of ${ENDINGS.join(', ')}, not “${ending}”.`);
  // The lot went at an earlier end (`LotFirst`, or a seller's account that couldn't take the money): this end pays what
  // the bid still owes and closes the auction.
  const owed = BigInt(auction.proceeds_owed ?? 0) > 0n;
  const sold = BigInt(auction.high) > 0n;
  const lot = auction.lot.Asset?.[0] ?? null;
  if (sold && owed && ending === 'CallOff')
    throw new Error(
      'The lot went to its winner already: the sale stands, and only Deliver pays what it owes (CantCallOff).',
    );
  if (sold && !owed && ending !== 'Deliver' && !lot)
    throw new Error(
      `Only an NFT lot is sent first or called off: an item's or a roll's sale ends with Deliver (${ending === 'CallOff' ? 'CantCallOff' : 'LotRefused'}).`,
    );
  const calledOff = sold && !owed && ending === 'CallOff';
  const first = sold && !owed && ending === 'LotFirst';
  // The lot goes home: no bid, or the sale called off.
  const home = !sold || calledOff;
  const nfts = sold && auction.nft_bids && !first ? (auction.held ?? []) : [];
  // Where a hold may stand in: the lot going home; a bid's NFTs going back, paid after the lot went first, or to the
  // treasury for the project's own lot.
  const mayHold = new Set([
    ...(lot && home && !owed ? [lot] : []),
    ...(calledOff || owed || (sold && !lot) ? nfts : []),
  ]);
  if (hold && (Array.isArray(hold) ? hold.some(a => !mayHold.has(a)) : !mayHold.size))
    throw new Error(
      'A sold lot is never made a hold, nor an NFT of the bid that buys a player’s lot: the two move together, or the end waits (LotRefused). Only a lot going home, or a bid’s NFTs going back or paid after the lot went first, may be held.',
    );
  const holding = asset => Boolean(hold) && mayHold.has(asset) && holds(hold, asset);
  const tokenProgram = tokenProgramOf(programs, auction.mint);
  const itemId = owed ? undefined : auction.lot.Item?.[0];
  const made =
    !owed && sold && item?.kind === 'Collectible' ? pda.itemAsset(pda.item(project, itemId), auction.pin) : null;
  // What the shares leave, to whoever owned the lot; called off, the whole bid back to its bidder.
  const owner = lot ? auction.seller : projectState.treasury;
  const proceeds = calledOff ? auction.high_bidder : owner;
  const address = pda.auction(project, auction.seller, id);
  const receiver = home ? auction.seller : auction.high_bidder;
  // A roll lot sold: its box, and the order the winner's roll is made in. The winning bid stays in the vault as that
  // order's payment, split by the auction's shares when it settles (no shares' accounts here).
  const roll = sold && !owed ? auction.lot.Roll?.[0] : undefined;
  nonce = toBigInt(nonce ?? prizeNonce(address, BigInt(auction.last_bid_at)));
  const nft = { project, asset: lot, collection, tokenMetadata: tm, compressed, evidence };
  // An NFT lot is sent on (and shows whether the project still holds it); made a hold, it only shows that. A
  // collectible sold is minted into its item's collection, which Core writes. After the lot went first, the auction's
  // own address stands in for it.
  const p = owed
    ? standIn(address)
    : lot
      ? holding(lot)
        ? heldPiece(nft)
        : evidencedPiece({ ...nft, wallet: receiver })
      : made
        ? {
            ...piece({ project, asset: made, collection: item.collection, moves: false, locks: false, reads: false }),
            writable: ['collection'],
          }
        : standIn(address);
  // A bid's NFTs: each to where the rest of a bid in tokens would go, or back to its bidder on a call-off.
  const to = calledOff ? auction.high_bidder : owner;
  const bid = nfts.flatMap((asset, i) => {
    if (holding(asset)) return [meta(pda.hold(asset, 0), false, true)];
    const q = evidencedPiece({ project, asset, wallet: to, ...held[i] });
    return [...pieceMetas(q), ...q.proof];
  });
  // Money moves on a Deliver of a bid in tokens (the shares' accounts, but for a roll lot's, whose order splits it
  // later; after the lot went first, every end is the one that pays) and on a call-off (back to the bidder, no shares).
  const pays = sold && !auction.nft_bids && (ending === 'Deliver' || owed);
  return lootIx(
    'end_auction',
    { reference: reference(ref), nonce, ending },
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
      loot_box: roll !== undefined && ending === 'Deliver' ? pda.box(project, roll) : null,
      order:
        roll !== undefined && ending === 'Deliver'
          ? pda.order(project, auction.high_bidder, prizeRollNonce(nonce))
          : lot && holding(lot)
            ? pda.hold(lot, 0)
            : null,
    },
    {
      remaining: [
        ...p.proof,
        ...(pays && roll === undefined
          ? shareAccounts(project, auction.shares, auction.mint, { holders, programs, treasury: projectState.treasury })
          : []),
        ...bid,
        ...tailOf(extra),
      ],
      writable: [
        ...(pays && sharesBurn(auction.shares) ? ['mint'] : []),
        ...(pays || (calledOff && !auction.nft_bids) ? ['vault'] : []),
        ...p.writable,
      ],
    },
  );
}
