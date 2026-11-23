// Holds and loans, for the page client (solanaApp): an NFT held for a time, a loan offer, a loan taken against an NFT
// and its repayment.
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, withSolWrap } from '../chain/programs.js';
import { mintPowers } from '../chain/token2022.js';
import { sendPlan } from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { isProveLeaf, MPL_CORE, NO_OPTIONS, only } from './common.js';

/**
 * The hold and loan methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function holdMethods(ctx) {
  const {
    wallet,
    programs,
    now,
    client,
    project,
    read,
    readMaybe,
    collectionOf,
    nftOf,
    heldNow,
    tokenSettings,
    send,
    dryRun,
    clearLeftovers,
    closesFirst,
    hookTail,
  } = ctx;

  return {
    /**
     * Hands an NFT of any kind to the project until a time (a hold): `seconds` from now, or `{ until }` (Unix seconds).
     * The hold's address names its end. Returns { signature, freeAt }.
     *
     * Like every route that hands an NFT in (`stakeNft` in escrow, `borrow`, `enter`, `bid`, `listForSale`,
     * `listForRent`, a ticket paid with an NFT, a box that rolls on one), it first clears what an earlier owner of the
     * NFT left in this project: a hold or a listing that stayed open when whoever controls the NFT's collection took it
     * out of the project's hands. Left open, such a record could take the NFT once the project holds it again. The
     * player holds the NFT now, so the program closes each on that proof (a hold by `release`, a listing by
     * `take_listing`, no NFT moved and nothing paid), in front of the deposit in the same transaction, or in a
     * transaction of their own before it when the two do not fit one. The closes cost the player their transaction fee
     * only: each record's rent goes to whoever that record names (a hold's payer, a listing's maker), never to the
     * player. Only what can't be closed still refuses the deposit, in words (a listing whose rental still runs: the
     * program keeps it until the rental has run); `acceptLeftover: true` goes ahead all the same. NFTs of the project's
     * own collections are not read.
     */
    async hold(asset, seconds, { acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['acceptLeftover'], 'hold');
      const clears = await clearLeftovers(asset, acceptLeftover);
      const freeAt = BigInt(typeof seconds === 'object' ? seconds.until : now() + Number(seconds));
      const { before, hasAuthority: _, ...nft } = await nftOf(asset);
      const signature = await send(
        await closesFirst(clears, [
          ...before,
          loot.holdIx({
            player: wallet.address,
            project,
            asset,
            ...nft,
            collection: nft.collection ?? (await collectionOf(asset)) ?? MPL_CORE,
            freeAt,
          }),
        ]),
      );
      return { signature, freeAt };
    },

    /**
     * A lender's offer to borrow against: `maker`'s offer number `id` in this project. Returns { address, offer, mint,
     * amount, repay, lasts, risks }: `risks`, in words, each power over the loan's token that could make repaying fail
     * (its freeze authority, a Token-2022 pause, a transfer hook, a permanent delegate) and who holds it, and each setting
     * of the token that lets the lender turn the repayment away (accounts that start frozen or can be made to,
     * confidential transfers) or blocks it (a token that can't be transferred). The program takes such tokens, and a
     * lender who can stop every repayment takes the NFT once it is due: show the risks before the player borrows.
     */
    async loanOffer(maker, id) {
      const address = loot.pda.offer(project, maker, id);
      const offer = await read('Offer', address);
      if (!offer.deal.Lend) throw new Error(`The offer ${address} buys NFTs; it lends nothing.`);
      const account = await client.account(offer.mint);
      if (!account) throw new Error(`The loan's token ${offer.mint} is not on this cluster.`);
      const lender = who =>
        who === maker
          ? ' That is the lender: they could keep you from repaying and take your NFT when the loan is due.'
          : '';
      const risks = mintPowers(account).map(p => {
        if (p.power === 'freeze')
          return {
            ...p,
            says: `${p.holder} can freeze accounts of the loan's token, which makes repaying fail.${lender(p.holder)}`,
          };
        if (p.power === 'pause')
          return {
            ...p,
            says: `${p.holder ?? 'Its pause authority'} can pause every transfer of the loan's token, which makes repaying fail${p.paused ? ' (it is paused now)' : ''}.${lender(p.holder)}`,
          };
        if (p.power === 'hook')
          return {
            ...p,
            says: `Every transfer of the loan's token runs the program ${p.holder}${p.authority ? `, which ${p.authority} can change` : ''}; it can refuse a repayment.${lender(p.authority)}`,
          };
        return {
          ...p,
          says: `${p.holder} can move anyone's tokens of the loan's token, the ones you would repay with too.${lender(p.holder)}`,
        };
      });
      // What the token's own settings let a lender do: the program takes these, so the kit says them.
      risks.push(...tokenSettings(account, 'repaying', 'the lender', 'and take your NFT when the loan is due'));
      const { amount, repay, lasts } = offer.deal.Lend;
      return { address, offer, mint: offer.mint, program: account.owner, amount, repay, lasts, risks };
    },

    /**
     * Borrows against the player's NFT `asset` from `maker`'s offer `id`: the NFT is held until the loan is repaid, or
     * goes to the lender once it is due (`due`, Unix seconds; by default the longest the offer allows, less a minute).
     * A loan whose token someone could freeze, pause, hook or move, or whose own settings let the lender turn the
     * repayment away (`loanOffer`'s `risks`), is refused unless `acceptRisks` is true: the page shows the player each
     * risk first. `extra`: a transfer hook's accounts.
     */
    async borrow(maker, id, asset, { due, acceptRisks = false, acceptLeftover, extra, ...others } = NO_OPTIONS) {
      only(others, ['due', 'acceptRisks', 'acceptLeftover', 'extra'], 'borrow');
      const clears = await clearLeftovers(asset, acceptLeftover);
      const loan = await this.loanOffer(maker, id);
      extra ??= await hookTail([loan.mint]);
      if (loan.risks.length && acceptRisks !== true)
        throw new Error(
          `Repaying this loan can be blocked. ${loan.risks.map(r => r.says).join(' ')} Borrow only if the player accepts this: pass acceptRisks: true.`,
        );
      const lasts = BigInt(loan.lasts);
      due = BigInt(due ?? BigInt(now()) + lasts - (lasts > 120n ? 60n : 0n));
      const { before, ...nft } = await nftOf(asset);
      const collection = nft.collection ?? (await collectionOf(asset)) ?? MPL_CORE;
      const loanPrograms = { ...programs, [loan.mint]: loan.program };
      const ix = loot.borrowIx({
        borrower: wallet.address,
        project,
        id,
        offer: loan.offer,
        due,
        asset,
        ...nft,
        collection,
        programs: loanPrograms,
        extra,
      });
      const signature = await send(
        await closesFirst(clears, [
          ...before,
          createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, loan.mint, loan.program),
          ix,
        ]),
      );
      return { signature, due, hold: loot.pda.hold(asset, due) };
    },

    /**
     * The loan on `asset` (held until `due`), as a page shows it before anyone repays: { lender, mint, repay (base units),
     * due, paid }. `repay` is what `repay` then takes as the amount shown. Null when it holds no loan.
     */
    async loan(asset, due) {
      const hold = await readMaybe('Hold', loot.pda.hold(asset, due));
      if (!hold?.debt) return null;
      return {
        lender: hold.debt.lender,
        mint: hold.debt.mint,
        repay: BigInt(hold.debt.repay),
        due: Number(hold.free_at),
        borrower: hold.player,
      };
    },

    /**
     * Repays the loan on `asset` (held until `due`), the player's own or a friend's, and brings the NFT home to its
     * borrower in the same instruction: one prompt. `repay`: the debt the payer was shown (`loan()`'s, in base units);
     * the program refuses any other (`TermsChanged`). An NFT its collection took back or burned while the project held
     * it is refused here, before anything is signed: the program takes no repayment for it, and the borrower keeps what
     * they borrowed. Such a loan is closed for nothing instead: `claims()` lists it for its borrower and its lender, and
     * `claim` of it closes the hold (nothing is repaid, and the hold's rent goes back to whoever paid it). When the NFT
     * can't move now (frozen for now, or its collection refuses the move), or `home` is
     * false, the money goes alone, so the loan does not fall due: the hold is then over, and anyone sends the NFT home
     * once it can move (`claims()` lists it). A compressed NFT is proven in the same transaction; the money alone for one
     * whose proof keeps going out of date goes without it. Returns { signature, home }, and `says` when the NFT waits.
     */
    async repay(asset, due, { repay, home = true, extra, ...others } = NO_OPTIONS) {
      only(others, ['repay', 'home', 'extra'], 'repay');
      const at = loot.pda.hold(asset, due);
      const hold = await read('Hold', at);
      if (!hold.debt) throw new Error('This NFT is held for no loan left to repay.');
      extra ??= await hookTail([hold.debt.mint]);
      if (repay === undefined || repay === null)
        throw new Error(
          'Say the debt the payer was shown (repay, from loan()): the amount read now is never paid in its place.',
        );
      if (BigInt(repay) !== BigInt(hold.debt.repay))
        throw new Error(
          `This loan now asks ${hold.debt.repay}, not the ${repay} shown: show the payer the loan as it is now first.`,
        );
      if ((await heldNow(asset)).held === false)
        throw new Error(
          `The project no longer holds the NFT ${asset}: whoever controls its collection took it back or burned it while it was held. The program takes no repayment for it (NotTheNft), so nothing was sent: the borrower keeps what they borrowed. This loan can be closed for nothing: claims() lists it for its borrower and for its lender, and claim() of it closes the hold (nothing is repaid, and the hold's rent goes back to whoever paid it).`,
        );
      const { before, hasAuthority: _, ...nft } = await nftOf(asset, wallet.address, { to: hold.player });
      const kind = nft.compressed || nft.tokenMetadata ? nft : { collection: (await collectionOf(asset)) ?? MPL_CORE };
      // A Token Metadata NFT's move and a compressed NFT's proof take more than the default compute.
      const budget = nft.compressed || nft.tokenMetadata ? [computeUnitLimit(1_000_000)] : [];
      const opens = before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      const repaying = (goesHome, first = []) =>
        withSolWrap(wallet.address, hold.debt.mint, BigInt(hold.debt.repay), [
          ...budget,
          ...first,
          loot.repayIx({
            payer: wallet.address,
            project,
            hold,
            repay,
            home: goesHome,
            address: at,
            ...kind,
            programs,
            extra,
          }),
        ]);
      if (home) {
        const all = repaying(true, opens);
        // Too big for a dry run as one legacy transaction (a compressed NFT's long proof): sent as it is, the wallet's
        // one transaction made to fit.
        const plan = sendPlan({ payer: wallet.address, instructions: all, alone: isProveLeaf });
        if (plan && !plan.legacy) return { signature: await send(all), home: true };
        const tried = await dryRun(wallet.address, all);
        if (tried.ok) return { signature: await send(all), home: true };
        // What would refuse the money alone too is said now.
        if (['TermsChanged', 'LoanDue', 'NotALoan', 'NotTheNft'].includes(tried.error?.name))
          throw Object.assign(new Error(`${tried.error.msg} (${tried.error.name}).`), tried.error);
      }
      // The money alone: a compressed NFT proven in the same transaction when that lands, so one that is gone is refused.
      const proven = nft.compressed ? repaying(false, opens.filter(isProveLeaf)) : null;
      const money = proven && (await dryRun(wallet.address, proven)).ok ? proven : repaying(false);
      const signature = await send(money);
      return {
        signature,
        home: false,
        says: 'The loan is repaid. The NFT stays with the project until it can move (frozen for now, or its collection refuses the move): anyone sends it home to its borrower then, and claims() lists it.',
      };
    },
  };
}
