// Listings and raffles, for the page client (solanaApp): an NFT listed for sale or for rent, bought, rented, unlisted
// or closed once it is gone; and a raffle of an NFT.
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { parseCoreAsset } from '../chain/core.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { withSolWrap } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { MPL_CORE, NO_OPTIONS, only, units } from './common.js';

/** Returns the listing and raffle methods. */
export function addListings(ctx) {
  const {
    wallet,
    programs,
    client,
    project,
    mintOf,
    decimalsOf,
    read,
    readMaybe,
    nftOf,
    coreHeld,
    heldNow,
    goneProof,
    leaving,
    projectNow,
    send,
    chainNow,
    recordsOf,
    stashesOf,
    closesOf,
    clearLeftovers,
    closesFirst,
    holdersOf,
  } = ctx;

  /**
   * Holds the listing the player was shown against the one listed now: refused, in words, when none is given, when it
   * is of another NFT or another kind of deal (`Sell`, `Rent`), and when its terms differ from those listed now (the
   * program would refuse them too: TermsChanged).
   */
  async function shownListing(asset, listing, kind) {
    if (!listing)
      throw new Error(
        'Say the terms the player was shown: pass the listing listing() or listings() showed (listing). The listing read now is never signed in its place.',
      );
    if (listing.asset !== asset) throw new Error(`That listing is of ${listing.asset}, not ${asset}.`);
    if (!listing.deal?.[kind])
      throw new Error(
        kind === 'Sell' ? 'That listing is for rent, not for sale.' : 'That listing is for sale, not for rent.',
      );
    const listed = await readMaybe('Listing', loot.pda.listing(project, asset));
    if (!listed) throw new Error(`${asset} is not listed any more.`);
    const [was, is] = [loot.listingTerms(listing), loot.listingTerms(listed)];
    if (was.some((b, i) => b !== is[i]))
      throw new Error(
        'This listing has changed since the player was shown it: show them its terms as they are now first.',
      );
  }

  /**
   * Refuses, in words, to buy or rent the listing of an NFT the project no longer holds (whoever controls its
   * collection took it back or burned it): nothing is there. Sent all the same, the take would only close the listing.
   */
  async function listedStill(asset) {
    if ((await heldNow(asset)).held === false)
      throw new Error(
        `The project no longer holds the NFT ${asset}: whoever controls its collection took it back or burned it while it was listed. There is nothing to buy or rent, and nothing was sent. Anyone can close this listing for nothing (closeGone): its rent goes back to its maker.`,
      );
  }
  /** The same for a listing. */
  const GONE_LISTING =
    'The project no longer holds this NFT: whoever controls its collection took it back or burned it while it was listed. There is nothing to buy or rent. The listing can be closed for nothing, by its maker (unlist) or by anyone (closeGone), once no rental runs: its rent goes back to its maker.';

  return {
    // ---------------------------------------------------------------- listings

    /**
     * Lists one of the player's NFTs (any kind) for sale at `price` (whole units of `currency`, the economy's by
     * default), `shares` taken first (a royalty, a platform's cut). The project holds it until it sells or is unlisted.
     */
    async listForSale(asset, { price, currency, shares = [], acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['price', 'currency', 'shares', 'acceptLeftover'], 'listForSale');
      const clears = await clearLeftovers(asset, acceptLeftover, { listing: true });
      const mint = mintOf(currency);
      const { before, ...nft } = await nftOf(asset);
      return send(
        await closesFirst(clears, [
          ...before,
          loot.openListingIx({
            maker: wallet.address,
            project,
            asset,
            mint,
            deal: { Sell: { price: units(price, decimalsOf(currency)) } },
            shares,
            ...nft,
          }),
        ]),
      );
    },

    /**
     * Lists one of the player's NFTs for rent: `price` (whole units) a period of `lasts` seconds, a renter taking 1 to
     * `maxPeriods` at once. Nobody can end a rental early; the next renter takes it once one is over, until it is unlisted.
     */
    async listForRent(
      asset,
      { price, lasts, maxPeriods = 1, currency, shares = [], acceptLeftover, ...others } = NO_OPTIONS,
    ) {
      only(others, ['price', 'lasts', 'maxPeriods', 'currency', 'shares', 'acceptLeftover'], 'listForRent');
      const clears = await clearLeftovers(asset, acceptLeftover, { listing: true });
      const mint = mintOf(currency);
      const { before, ...nft } = await nftOf(asset);
      return send(
        await closesFirst(clears, [
          ...before,
          loot.openListingIx({
            maker: wallet.address,
            project,
            asset,
            mint,
            deal: { Rent: { price: units(price, decimalsOf(currency)), lasts, max_periods: maxPeriods } },
            shares,
            ...nft,
          }),
        ]),
      );
    },

    /**
     * The listing of `asset` (one account read), or null: { listing, asset, maker, mint, deal, renter, until }. One more
     * read says whether the project still holds the NFT: when whoever controls its collection took it back or burned
     * it, the listing is flagged `gone` with `says`, what that means in words. There is then nothing to buy or rent,
     * and the listing can be closed for nothing (`unlist` by its maker, `closeGone` by anyone).
     */
    async listing(asset) {
      const listing = await readMaybe('Listing', loot.pda.listing(project, asset));
      if (!listing) return null;
      const gone = (await heldNow(asset)).held === false;
      return {
        listing: loot.pda.listing(project, asset),
        ...listing,
        renter: loot.renterOf(listing, await chainNow()),
        ...(gone ? { gone: true, says: GONE_LISTING } : {}),
      };
    },

    /** Who rents `asset` now (one account read, then a check that the project still holds it), or null. */
    async rentedTo(asset) {
      const listing = await readMaybe('Listing', loot.pda.listing(project, asset));
      const renter = loot.renterOf(listing, await chainNow());
      if (!renter) return null;
      const account = await client.account(asset);
      const holds = account?.owner === MPL_CORE ? parseCoreAsset(account.data).owner === project : true;
      return holds ? renter : null;
    },

    /**
     * The project's listings, a maker's (`maker`) or all: one search of the program's accounts, then one read of the
     * listed NFTs together, which flags a listing `gone` (with `says`) when the project no longer holds its NFT: a
     * Core asset held by another or burned, a Token Metadata NFT whose token left the project's account. A compressed
     * NFT is not read here (an indexer's answer for each): `listing(asset)` says it for one.
     */
    async listings({ maker, ...others } = NO_OPTIONS) {
      only(others, ['maker'], 'listings');
      const filters = [
        { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Listing)) } },
        { memcmp: { offset: 1, bytes: project } },
        ...(maker ? [{ memcmp: { offset: 33, bytes: maker } }] : []),
      ];
      const time = await chainNow();
      const found = (await client.programAccounts(loot.lootProgram(), filters)).map(({ pubkey, account }) => {
        const listing = loot.decode('Listing', account.data);
        return { listing: pubkey, ...listing, renter: loot.renterOf(listing, time) };
      });
      // Each NFT and the project's token account of it, all in one read.
      const read = found.length ? await client.accounts(found.flatMap(l => [l.asset, loot.ata(project, l.asset)])) : [];
      return found.map((l, i) => {
        const [nft, held] = [read[2 * i], read[2 * i + 1]];
        const gone =
          nft?.owner === MPL_CORE
            ? !coreHeld(nft)
            : nft?.owner === TOKEN_PROGRAM &&
              !(
                held?.data?.length >= 72 &&
                new DataView(held.data.buffer, held.data.byteOffset).getBigUint64(64, true) === 1n
              );
        return gone ? { ...l, gone: true, says: GONE_LISTING } : l;
      });
    },

    /**
     * Buys a listed NFT at the terms the player saw: `listing`, as `listing()` or `listings()` showed it. It is
     * required: the terms signed are those, never the listing read now, so a price or a share changed since is refused.
     * A listing whose NFT the project no longer holds (its collection took it back or burned it) is refused in words
     * before anything is signed: nothing is there to buy, and anyone can close that listing for nothing (`closeGone`).
     */
    async buyListing(asset, { listing, ...others } = NO_OPTIONS) {
      only(others, ['listing'], 'buyListing');
      await shownListing(asset, listing, 'Sell');
      await listedStill(asset);
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: wallet.address });
      const holders = await holdersOf(listing.shares ?? []);
      return send([
        ...before,
        ...withSolWrap(wallet.address, listing.mint, listing.deal.Sell.price, [
          loot.takeListingIx({
            taker: wallet.address,
            project,
            projectState: await projectNow(),
            listing,
            holders,
            programs,
            ...nft,
          }),
        ]),
      ]);
    },

    /**
     * Rents a listed NFT for `periods` periods, at the terms the player saw: `listing`, as `listing()` or `listings()`
     * showed it (required, as for `buyListing`). One whose NFT the project no longer holds is refused in words, as
     * `buyListing` refuses it.
     */
    async rentListing(asset, { periods = 1, listing, ...others } = NO_OPTIONS) {
      only(others, ['periods', 'listing'], 'rentListing');
      await shownListing(asset, listing, 'Rent');
      await listedStill(asset);
      const holders = await holdersOf(listing.shares ?? []);
      const total = BigInt(listing.deal.Rent.price) * BigInt(periods);
      // A compressed NFT is read by its record, proven first in the same transaction.
      const { before, compressed } = await nftOf(asset);
      return send([
        ...(compressed ? before : []),
        ...withSolWrap(wallet.address, listing.mint, total, [
          loot.takeListingIx({
            taker: wallet.address,
            project,
            projectState: await projectNow(),
            listing,
            periods,
            compressed,
            holders,
            programs,
          }),
        ]),
      ]);
    },

    /**
     * Takes a listed NFT home (its maker). While a rental runs it only stops the listing; call again once it is over.
     * A listing whose NFT the project no longer holds (its collection took it back or burned it) closes without it, on
     * that proof: nothing is sent, and the listing's rent comes back to its maker. While a rental of it still runs,
     * that close too only stops the listing, and closes it once the rental has run.
     */
    async unlist(asset) {
      const listing = await read('Listing', loot.pda.listing(project, asset));
      const proof = await goneProof(asset);
      if (proof)
        return send([...proof.before, loot.closeListingIx({ maker: wallet.address, project, listing, ...proof.kind })]);
      const { before, ...nft } = await nftOf(asset, wallet.address, { to: wallet.address });
      return send([...before, loot.closeListingIx({ maker: wallet.address, project, listing, ...nft })]);
    },

    /**
     * Closes what this project still records of an NFT it no longer holds (`asset`: whoever controls its collection
     * took it out of the project's hands or burned it): each hold of it (`release`), its listing (`take_listing`),
     * and its row on each of the project's stashes that lists it (`stash`, out), on the proof that it is gone. Anyone
     * may, at any time, also while a hold runs and for a loan before it is due: nothing is sent or paid, and a loan's
     * debt ends unpaid. The sender pays the transaction's fee only; each record's rent goes to whoever that record
     * names (a hold's payer, a listing's maker), never to the sender, and a stash keeps the rent its row no longer
     * needs (it goes to the sender only when that is one of the project's keys). With its row off a stash, no roll
     * draws the NFT, and a prize that names it is passed over in place of failing on an NFT that can't move.
     * What is left is in `waits`: a listing whose rental still runs (the program keeps a running rental, and the
     * listing closes once it has run), and a lottery's own stash that lists the NFT (`kind` 'lottery-stash', with its
     * `lottery`, the lottery's id): only the project's keys take a row out of that one (`unraffle`), gone or not.
     * Refused in words, with nothing sent, when the project still holds the NFT or nothing shows it gone.
     * Besides one search of the NFT's holds, this makes one search of the project's stashes, which returns every
     * stash of the project whole (36 bytes for each NFT a stash lists): a stash's rows have no fixed place to look in.
     * Returns { signature, closed: [{ kind, address }], unstashed: [{ address, id }], waits: [{ kind, address }] }:
     * `closed` the holds and the listing it closed, `unstashed` the project's stashes it took the row off;
     * `signature` is null when there was nothing to close.
     */
    async closeGone(asset) {
      const [records, stashes] = [await recordsOf(asset), await stashesOf(asset)];
      if (!records.length && !stashes.length) return { signature: null, closed: [], unstashed: [], waits: [] };
      const proof = await goneProof(asset);
      if (!proof)
        throw new Error(
          `Nothing shows that the project no longer holds the NFT ${asset}: its records close this way only once it is proven gone (its collection took it back or burned it). Nothing was sent.`,
        );
      const { closes, closed, waits } = await closesOf(asset, records, proof);
      const listed = stashes.filter(x => x.kind === 'stash');
      // The row comes off each of the project's stashes: free, nothing moves, and where it would go is not read.
      const offs = listed.map(({ id }) =>
        loot.stashIx({ signer: wallet.address, project, id, asset, out: wallet.address, ...proof.kind }),
      );
      const left = [
        ...waits.map(({ kind, address }) => ({ kind, address })),
        ...stashes
          .filter(x => x.kind === 'lottery-stash')
          .map(({ kind, address, id }) => ({ kind, address, lottery: id })),
      ];
      const unstashed = listed.map(({ address, id }) => ({ address, id }));
      const instructions = [...(closes.length ? closes : offs.length ? proof.before : []), ...offs];
      if (!instructions.length) return { signature: null, closed, unstashed, waits: left };
      return { signature: await send(instructions), closed, unstashed, waits: left };
    },

    // ---------------------------------------------------------------- raffles

    /**
     * The project's owner raffles an NFT they hold, as lottery `id`: the NFT goes into the lottery's own stash, where
     * nothing but the lottery can take it while a place names it; the winner gets it before any ticket money moves.
     * `price` (whole units of `currency`) a ticket, `drawsAt` (Unix seconds) its one draw, `minSold` the least tickets
     * (fewer: the round is cancelled and refunded), `shares` where the ticket money goes (the seller's own wallet by
     * default: the treasury). Its one place takes no money, so it keeps no pot: the round pays from its own ticket
     * money, and what the shares leave goes to the treasury too. A seller runs it in a project of their own, whose
     * owner they are.
     */
    async raffle(
      id,
      nft,
      {
        price,
        currency,
        drawsAt,
        minSold = 0,
        perWallet = 0,
        shares = [{ to: 'Treasury', bps: 10_000 }],
        ...others
      } = NO_OPTIONS,
    ) {
      only(others, ['price', 'currency', 'drawsAt', 'minSold', 'perWallet', 'shares'], 'raffle');
      const kind = await nftOf(nft);
      const { before, hasAuthority: _, ...piece } = kind;
      const lotteryState = await readMaybe('Lottery', loot.pda.lottery(project, id));
      await send([
        ...before,
        loot.stashIx({ signer: wallet.address, project, lottery: id, lotteryState, asset: nft, ...piece }),
      ]);
      const args = {
        price: units(price, decimalsOf(currency)),
        mint: mintOf(currency),
        pays_from: { Round: { rest: 'Treasury' } },
        shares,
        places: [{ bps: 0, prize: { Held: [nft] } }],
        ticket_mint: NO_ADDRESS,
        every: 0n,
        draws_at: BigInt(drawsAt),
        gate: null,
        per_wallet: perWallet,
        min_sold: BigInt(minSold),
      };
      return send([loot.upsertIx({ owner: wallet.address, project, def: { Lottery: { id, args } }, lotteryState })]);
    },

    /**
     * The raffle's owner takes the NFT back out of lottery `id`'s own stash once nothing promises it (the lottery
     * ended, or no place names it). When the project no longer holds the NFT (its collection took it back or burned
     * it), only its row comes off the stash, on that proof: nothing is sent, and the owner gets no NFT back. Only the
     * project's owner or authority may, gone or not: a lottery's own stash is theirs alone (`NotAuthority` for anyone
     * else; `closeGone` leaves it and says so). Returns the signature.
     */
    async unraffle(id, nft) {
      const {
        before,
        hasAuthority: _,
        gone: _g,
        ...piece
      } = await leaving(nft, wallet.address, { to: wallet.address });
      const lotteryState = await readMaybe('Lottery', loot.pda.lottery(project, id));
      return send([
        ...before,
        loot.stashIx({
          signer: wallet.address,
          project,
          lottery: id,
          lotteryState,
          asset: nft,
          out: wallet.address,
          ...piece,
        }),
      ]);
    },
  };
}
