// Listings: opening one, taking it and closing it.
import { ata, pda } from '../pda.js';
import { heldPiece, ONLY_MOVES, recordTerms, standIn, stored, tokenProgramOf } from './shared.js';
import { lootIx, tailOf } from './base.js';
import { shareAccounts, sharesBurn } from './tail.js';
import { piece } from './piece.js';

// ---------------------------------------------------------------- listings

/** What a taker signs: the listing's bytes but `user`, `until` and `stopped` (bytes 129 to 170, what a rental changes).
 * `listing`: the decoded Listing, or its account's bytes. */
export const listingTerms = listing => recordTerms('Listing', listing, () => [129, 170]);

/**
 * `maker` (any wallet, signing alone) lists an NFT they hold, of any kind (as `piece` takes it), for sale
 * (`deal: { Sell: { price } }`) or for rent (`{ Rent: { price, lasts, max_periods } }`: `price` a period of `lasts`
 * seconds, a renter taking 1 to `max_periods` at once), paid in `mint`, `shares` taken before the maker's part. The NFT
 * goes to the project until it is sold or the listing is closed. The listing's address names the NFT
 * (`pda.listing(project, asset)`), so a game finds it, and its renter, with one account read.
 */
export function openListingIx({
  maker,
  project,
  asset,
  mint,
  deal,
  shares = [],
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  extra = [],
}) {
  const p = piece({
    project,
    asset,
    wallet: maker,
    collection,
    hasAuthority,
    tokenMetadata: tm,
    compressed,
    ...ONLY_MOVES,
  });
  return lootIx(
    'open_listing',
    { deal, shares: stored(shares) },
    { maker, project, listing: pda.listing(project, p.accounts.asset), ...p.accounts, mint },
    { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable },
  );
}

/**
 * `taker` takes a listing (`listing`: the decoded Listing), signing its terms: a sale pays its price through the shares
 * to the maker and hands the NFT over; a rental of `periods` periods (1 to its `max_periods`) pays `price` each and
 * makes the taker its user until `periods × lasts` from now, refused while another runs. A rental moves no NFT, so it
 * takes none of the NFT's accounts but its address. `holders`, `programs`, `treasury` as for any split. After the
 * take's own accounts come a sale's compressed NFT's proof, then the shares' accounts, then (in `extra`) Core's
 * transfer adapters and any transfer hook's accounts, which the program finds by address after the shares'.
 * A listing whose NFT is proven gone from the project (`piece`: the Core asset itself, `tokenMetadata.evidence`, a
 * compressed NFT's record proven again) closes instead, whoever sends this: the taker pays nothing and no fee, the
 * listing's rent goes to its maker, and the receipt is `NftGone`. It is refused while a rental runs (`Rented`), and
 * closes once the rental has run.
 */
export function takeListingIx({
  taker,
  project,
  projectState,
  listing,
  periods = 1,
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  holders,
  programs,
  takerToken,
  extra = [],
}) {
  const tokenProgram = tokenProgramOf(programs, listing.mint);
  const sale = Boolean(listing.deal.Sell);
  // A rental moves nothing: a Core or Token Metadata NFT by its address; a compressed one by its record and tree
  // (`proveLeafIx` first, in the same transaction), with no proof.
  const p = sale
    ? piece({
        project,
        asset: listing.asset,
        wallet: taker,
        collection,
        hasAuthority,
        tokenMetadata: tm,
        compressed,
        ...ONLY_MOVES,
      })
    : compressed
      ? {
          ...piece({ project, asset: listing.asset, wallet: taker, compressed, ...ONLY_MOVES, moves: false }),
          proof: [],
        }
      : tm?.evidence
        ? // A rented Token Metadata NFT shown gone: the project's token account of it, and the one that holds it now.
          heldPiece({ project, asset: listing.asset, tokenMetadata: tm, evidence: tm.evidence })
        : standIn(listing.asset);
  return lootIx(
    'take_listing',
    { terms: listingTerms(listing), periods },
    {
      taker,
      project,
      listing: pda.listing(project, listing.asset),
      maker: listing.maker,
      maker_token: ata(listing.maker, listing.mint, tokenProgram),
      ...p.accounts,
      mint: listing.mint,
      taker_token: takerToken ?? ata(taker, listing.mint, tokenProgram),
    },
    {
      remaining: [
        ...p.proof,
        ...shareAccounts(project, listing.shares ?? [], listing.mint, {
          holders,
          programs,
          treasury: projectState?.treasury,
        }),
        ...tailOf(extra),
      ],
      writable: [...(sharesBurn(listing.shares ?? []) ? ['mint'] : []), ...p.writable],
    },
  );
}

/**
 * Its maker closes a listing (`listing` the decoded Listing): the NFT goes home. While a rental runs it only stops (no
 * renter takes it again), and the same call once the rental is over takes it home. Free. A listing whose NFT is proven
 * gone from the project (`piece`: the Core asset itself, `tokenMetadata.evidence`, a compressed NFT's record proven
 * again) closes without it once no rental runs, its rent to its maker (`NftGone`, no `Unlisted`); anyone else closes
 * such a listing with `takeListingIx`.
 */
export function closeListingIx({
  maker,
  project,
  listing,
  collection,
  hasAuthority,
  tokenMetadata: tm,
  compressed,
  extra = [],
}) {
  const p = piece({
    project,
    asset: listing.asset,
    wallet: maker,
    collection,
    hasAuthority,
    tokenMetadata: tm,
    compressed,
    ...ONLY_MOVES,
  });
  return lootIx(
    'close_listing',
    {},
    { maker, project, listing: pda.listing(project, listing.asset), ...p.accounts },
    { remaining: [...p.proof, ...tailOf(extra)], writable: p.writable },
  );
}
