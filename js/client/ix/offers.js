// Offers: opening, closing and selling to one, and a loan's borrowing and repaying.
import { toBigInt } from '../../chain/bytes.js';
import { ata, pda, vault } from '../pda.js';
import { heldPiece, ONLY_MOVES, passedOn, recordTerms, stored, tokenProgramOf, twoAccounts } from './shared.js';
import { lootIx, tailOf } from './base.js';
import { shareAccounts, sharesBurn } from './tail.js';
import { piece } from './piece.js';

// ---------------------------------------------------------------- offers
//
// An offer's rule reads an NFT outside the project's collections without the project's Sheet: a Core NFT by its own
// attributes, a Token Metadata or compressed NFT with none, so an attribute test fails for an NFT that doesn't carry
// the key itself (every Token Metadata or compressed one).

/** What a taker signs: the offer's bytes but `left`, its last 2 (what a take changes). `offer`: the decoded Offer, or its
 * account's bytes. */
export const offerTerms = offer => recordTerms('Offer', offer, data => [data.length - 2, data.length]);

/** What one take of a deal pays out of its offer's money: a bid's price, a loan's amount. */
export const dealUnit = deal => BigInt(deal.Buy?.price ?? deal.Lend.amount);

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
    {
      maker,
      project,
      offer: pda.offer(project, maker, id),
      mint,
      maker_token: makerToken ?? ata(maker, mint, tokenProgram),
      vault: vault(project, mint, tokenProgram),
    },
    { remaining: tailOf(extra) },
  );
}

/** Its maker calls offer `id` off (`offer` the decoded Offer): what is left of its money goes back to them. Free. */
export function closeOfferIx({ maker, project, id, offer, programs, extra = [] }) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  return lootIx(
    'close_offer',
    {},
    {
      maker,
      project,
      offer: pda.offer(project, maker, id),
      mint: offer.mint,
      vault: vault(project, offer.mint, tokenProgram),
      maker_token: ata(maker, offer.mint, tokenProgram),
    },
    { remaining: tailOf(extra) },
  );
}

/**
 * `seller` sells an NFT that passes the bid's rule into offer `id` (`offer` the decoded Offer, its deal a `Buy`),
 * signing its terms: the NFT goes straight to the maker, the price through the shares, the rest to the seller. The NFT is
 * any kind, as `piece` takes it (`collection`, `hasAuthority` false for a Core asset of another collection,
 * `tokenMetadata`, or `compressed` after a `proveLeafIx`).
 */
export function sellToOfferIx({
  seller,
  project,
  projectState,
  id,
  offer,
  asset,
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  holders,
  programs,
  extra = [],
}) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  // A Token Metadata NFT goes straight from the seller's account into the maker's: never one account in both places.
  const p = twoAccounts(
    passedOn({
      project,
      owner: seller,
      receiver: offer.maker,
      burns: false,
      asset,
      collection,
      hasAuthority,
      tokenMetadata: tm,
      compressed,
      reads: true,
    }),
  );
  return lootIx(
    'sell_to_offer',
    { terms: offerTerms(offer) },
    {
      seller,
      project,
      offer: pda.offer(project, offer.maker, id),
      maker: offer.maker,
      ...p.accounts,
      mint: offer.mint,
      vault: vault(project, offer.mint, tokenProgram),
      seller_token: ata(seller, offer.mint, tokenProgram),
    },
    {
      remaining: [
        ...p.proof,
        ...shareAccounts(project, offer.shares, offer.mint, { holders, programs, treasury: projectState?.treasury }),
        ...tailOf(extra),
      ],
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
export function borrowIx({
  borrower,
  project,
  id,
  offer,
  due,
  asset,
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  programs,
  extra = [],
}) {
  const tokenProgram = tokenProgramOf(programs, offer.mint);
  const p = piece({
    project,
    asset,
    wallet: borrower,
    collection,
    hasAuthority,
    tokenMetadata: tm,
    compressed,
    ...ONLY_MOVES,
    reads: true,
  });
  return lootIx(
    'borrow',
    { due: toBigInt(due), terms: offerTerms(offer) },
    {
      borrower,
      project,
      offer: pda.offer(project, offer.maker, id),
      maker: offer.maker,
      hold: pda.hold(p.accounts.asset, due),
      ...p.accounts,
      mint: offer.mint,
      vault: vault(project, offer.mint, tokenProgram),
      borrower_token: ata(borrower, offer.mint, tokenProgram),
    },
    { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable },
  );
}

/**
 * Anyone (`payer`: the borrower, a friend) repays a loan before it is due (`hold` the decoded Hold, with its debt): the
 * debt's `repay` goes to the lender. With `home` (the default), the NFT goes home to its borrower in the same
 * instruction and the hold closes, its rent (and a Token Metadata NFT's emptied account's) to the borrower; an NFT that
 * can't move now (frozen, its collection's rule refuses, a proof out of date) fails the whole call, and nobody pays.
 * Without `home`, only the money moves: the hold becomes a plain one that is over, and anyone sends the NFT home with
 * `releaseIx` whenever it can move (for an NFT frozen for now, so the loan does not fall due meanwhile). Free.
 * The NFT is any kind: `collection` for a Core asset, `tokenMetadata` for a Token Metadata NFT (`into`: the borrower's
 * account it goes into, when their associated one can't take it), `compressed` for a compressed one. Either way its
 * accounts must show the project still holds it: the program takes no repayment for an NFT its collection took back
 * or burned (`NotTheNft`), nor one nothing shows (`NotProven`). Going home, a compressed NFT is proven
 * (`proveLeafIx`, in the same transaction) and its proof goes first after the repayment's accounts; the money alone
 * passes its record and tree, and goes through when the record shows nothing, so prove it in the same transaction when
 * that fits and the repayment of an NFT that is gone is refused. `repay`: the debt the payer was shown
 * (`hold.debt.repay` as read): any other amount is refused (`TermsChanged`). `address`: the hold's, when its `free_at`
 * changed since its loan named it. `extra`: a transfer hook's accounts.
 */
export function repayIx({
  payer,
  project,
  hold,
  repay,
  home = true,
  address = null,
  collection,
  tokenMetadata: tm,
  compressed,
  payerToken,
  programs,
  extra = [],
}) {
  if (repay === undefined || repay === null)
    throw new Error('A repay names the debt the payer was shown (repay: hold.debt.repay as read).');
  const { lender, mint } = hold.debt;
  const tokenProgram = tokenProgramOf(programs, mint);
  const asset = hold.asset;
  // Going home, all its move takes (a Token Metadata NFT's `token` the borrower's); the money alone, only what shows
  // the project holds it: the Core asset, the mint and the project's token account of it, a compressed NFT's record and
  // tree (no proof: nothing moves, and the program reads the proof only for a move).
  const p = home
    ? twoAccounts(
        piece({ project, asset, wallet: hold.player, collection, tokenMetadata: tm, compressed, ...ONLY_MOVES }),
      )
    : { ...heldPiece({ project, asset, tokenMetadata: tm, compressed }), proof: [] };
  return lootIx(
    'repay',
    { home, repay: toBigInt(repay) },
    {
      payer,
      project,
      hold: address ?? pda.hold(asset, hold.free_at),
      lender,
      lender_token: ata(lender, mint, tokenProgram),
      payer_token: payerToken ?? ata(payer, mint, tokenProgram),
      mint,
      borrower: hold.player,
      ...p.accounts,
    },
    { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable },
  );
}
