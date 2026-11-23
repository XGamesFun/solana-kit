// Claims, for the page client (solanaApp): everything a player can finish themselves (wins, payouts, refunds, rolls to
// settle, rent to take back), each said in words, and taking one or all of them.
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, requestHeapFrame } from '../chain/programs.js';
import {
  closeTableIx,
  deactivateTableIx,
  readTable,
  tablesOf,
  tableStep,
  LOOKUP_TABLE_PROGRAM,
} from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { MPL_CORE, NO_OPTIONS, only, show } from './common.js';

/** A lottery's steps in `claims()`: each depends on the one before, so `claimAll` takes one of a lottery's a call. */
const LOTTERY_STEPS = new Set(['reveal', 'cancel-draw', 'pull', 'payout']);
/** The claims that are one transaction of the wallet's: `claimAll` signs them together. */
const BATCHED = new Set(['contest', 'release', 'lookup-table', 'close-leaf', ...LOTTERY_STEPS]);

/** A table made this many slots ago whose transaction never landed was never sent: its blockhashes ran out long since. */
const TABLE_UNSENT_SLOTS = 300n;

/**
 * The claim methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function claimMethods(ctx) {
  const {
    spec,
    wallet,
    programs,
    now,
    client,
    project,
    keys,
    part,
    read,
    readMaybe,
    collectionOf,
    nftOf,
    heldEach,
    goneProof,
    leaving,
    releaseOwed,
    prizeInputs,
    projectNow,
    auctionAt,
    sendNow,
    sendBatch,
    dryRun,
    emptyKey,
    sendRolling,
    collect,
    asksFor,
    slotNow,
    recentSlots,
    chainNow,
    endsOf,
    roundOf,
    drawStep,
    contestNfts,
    roundNfts,
    cancelPulls,
    pullSettles,
    pulls,
  } = ctx;

  /** What closing a hold whose NFT is gone does, in words, for `claims()`. */
  const goneHoldSays = hold =>
    `The project no longer holds this NFT: whoever controls its collection took it back or burned it while it was held. Its hold can be closed now, by anyone: closing it sends nothing, and the hold's rent goes back to whoever paid it (${hold.payer}).${hold.debt ? ' It was a loan: nothing is repaid, the borrower keeps what they borrowed, and the lender gets neither the NFT nor the repayment.' : ''}`;

  /**
   * What ending an auction does when its lot or an NFT of its winning bid is gone, in words, for `claims()`: `x` the
   * auction, `me` the wallet told (its seller, or its high bidder), `lot` the lot when it is gone, `bids` the NFTs of
   * the winning bid that are gone.
   */
  function goneSaleSays(name, x, me, lot, bids) {
    const [sold, owed] = [BigInt(x.high) > 0n, BigInt(x.proceeds_owed) > 0n];
    const mine = sold && x.high_bidder === me;
    const why = 'whoever controls its collection took it back or burned it while the auction held it';
    const lostBids = `${bids.length === 1 ? 'an NFT' : 'NFTs'} of ${mine ? 'your' : 'the winning'} bid (${bids.join(', ')})`;
    if (lot && !sold)
      return `The project no longer holds its lot (${lot}): ${why}. “${name}” ended with no bid, and nothing comes back to you: ending it closes the auction, and its rent comes back to you.`;
    if (lot) {
      const back = x.nft_bids
        ? `the NFTs of ${mine ? 'your' : 'the winning'} bid that the project still holds go back to ${mine ? 'you' : 'their bidder'}`
        : mine
          ? 'your bid comes back to you'
          : 'the winning bid goes back to its bidder';
      return `The project no longer holds its lot (${lot}): ${why}. The sale of “${name}” is called off by its end, which anyone may send: ${back}, and ${mine ? 'the lot is not yours' : 'you are paid nothing'}.${bids.length ? ` It no longer holds ${lostBids} either: nothing comes back for it.` : ''}`;
    }
    const first = `The project no longer holds ${lostBids}: ${why}.`;
    // A player's lot that has not moved: the two sides move together or not at all, so the sale is called off.
    if (x.lot.Asset && !owed)
      return `${first} The sale of “${name}” is called off by its end, which anyone may send: the lot goes home to ${mine ? 'its seller' : 'you'}, and the rest of the bid back to ${mine ? 'you' : 'its bidder'}. Nothing comes back for the one gone.`;
    // The lot went first, or it is the project's own: the end passes that NFT over and pays the rest.
    return owed
      ? `${first} The winner of “${name}” has the lot: ending it again pays you the rest of the bid, and nothing for the one gone.`
      : `${first} Ending “${name}” gives the lot to ${mine ? 'you' : 'its winner'} and pays the rest of the bid: nothing is paid for the one gone.`;
  }
  /** What claiming does about the NFTs of a round's parts that are gone, in words, for `claims()`: `tickets` the NFTs
   * that paid for the wallet's tickets, `prizes` the NFTs its places won; `back` when its tickets go back to their
   * buyers (a round called off, a lottery that returns its tickets). */
  const goneRoundSays = (tickets, prizes, back) =>
    [
      tickets.length
        ? `The project no longer holds the NFT that paid for your ticket (${tickets.join(', ')}): whoever controls its collection took it back or burned it while the lottery held it. ${back ? 'It can’t come back to you' : 'It goes nowhere'}: claiming settles that part and sends nothing.`
        : '',
      prizes.length
        ? `The project no longer holds an NFT you won (${prizes.join(', ')}): whoever controls its collection took it back or burned it. It can’t be given: claiming closes that prize and sends nothing.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  /** What a contest's claim does about its NFTs that are gone, in words, for `claims()`: `own` the wallet's own NFT
   * when it is gone, `picks` the losers' NFTs gone that its picks land on. */
  const goneContestSays = (own, picks) =>
    [
      own
        ? `The project no longer holds the NFT you entered (${own}): whoever controls its collection took it back or burned it while the contest held it. It can’t come back to you: claiming closes your entry and sends nothing.`
        : '',
      picks.length
        ? `The project no longer holds ${picks.length === 1 ? 'the loser’s NFT' : 'the losers’ NFTs'} left for you to pick (${picks.join(', ')}): whoever controls its collection took it back or burned it. A pick of it takes nothing: claiming closes it and sends nothing.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

  return {
    /**
     * What this player can finish now, themselves: a box to settle or refund, a contest entry to claim, a held
     * collectible to take home, a hold of theirs or a loan they made or took whose NFT the project no longer holds (its
     * collection took it back or burned it: listed at any time, also while the hold runs, as a `release` flagged
     * `gone`, whose claim closes the hold and sends nothing), an auction they won (or one off by the clock: their bid back), a lottery place they
     * won, a draw that is due (anyone may reveal it, or ask again when the oracle never answered; it takes 0.0008
     * SOL), and a drawn lottery's unpaid places, which anyone may pay so the next round can open. [{ kind, says, … }];
     * a winner's first claim of a contest of tokens carries `potUnits` and `prizeUnits`, its part as the decision wrote
     * it (base units, as text). Pass one to `claim`.
     * A `pull`, a `contest` or an `auction` whose claim would hand out an NFT the project no longer holds is flagged
     * `gone` too, with `assets` (those NFTs) and `says`, what the claim does about each in words: a ticket's NFT, a
     * place's NFT, a contest's entry or a loser's NFT picked is not sent anywhere and its part closes; an auction with
     * its lot or an NFT of its winning bid gone is called off, or ended without it. Show `says` before the player signs.
     */
    async claims() {
      const me = wallet.address;
      const out = [];
      const tag = t => ({ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS[t])) } });
      const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
      const slot = await slotNow();
      const time = BigInt(now());
      const chainTime = await chainNow();
      for (const { pubkey, account } of await client.programAccounts(loot.lootProgram(), [
        tag('Order'),
        at(1, project),
        at(33, me),
      ])) {
        const o = loot.decode('Order', account.data);
        const opened = BigInt(o.requested_slot);
        if (loot.orderRefundable(o, slot, chainTime))
          out.push({ kind: 'refund', order: pubkey, says: 'Your payment back for an order that never finished.' });
        else if (o.status === 'Rolled' && slot > opened)
          out.push({ kind: 'settle', order: pubkey, says: 'What your box rolled.' });
        else if (loot.rollAskable(o, slot, chainTime))
          out.push({
            kind: 'settle',
            order: pubkey,
            says: 'A roll you won (a mission’s, a recipe’s, a prize’s): ask for it and see what it gives (one whose box has nothing left to give waits until it has).',
          });
      }
      for (const { pubkey, account } of await client.programAccounts(loot.lootProgram(), [
        tag('Contest'),
        at(1, project),
      ])) {
        const contest = loot.decode('Contest', account.data);
        const off = loot.contestOff(contest, time);
        if (!(off || contest.verdict === 'Won')) continue;
        const list = await client.account(loot.contestEntries(pubkey, contest));
        const entries = list?.owner === loot.lootProgram() ? loot.decodeEntries(list.data) : [];
        const entry = entries.find(e => e.player === me);
        if (!entry) continue;
        const won = !off && Number(contest.winner) === Number(entry.side);
        const first = won && !(entry.bits & loot.CLAIMED);
        // Owed: its money back (off) or its part of the pot (won), its own NFT while the contest holds it, a winner's
        // prize with its first claim, and the losers' NFTs its share still lets it pick. A loser of a contest of tokens
        // is owed nothing, and never sends a transaction.
        const picks =
          won && contest.nft && !(entry.bits & loot.ENDED) && Number(entry.taken) < loot.shareOf(contest, entry);
        const owed =
          (contest.nft ? Number(entry.amount) === 1 && (off || won) : BigInt(entry.amount) > 0n && (off || first)) ||
          first ||
          picks;
        if (!owed) continue;
        const says = off
          ? 'Your entry back: the contest is off.'
          : contest.nft
            ? `Your NFT back${picks ? ', and your pick of the losers’' : ''}.`
            : contest.prize != null
              ? 'Your share of the pot, and your prize.'
              : 'Your share of the pot.';
        // A winner's part of a contest of tokens is what the decision wrote, whoever claims first (`contestWinnings`).
        const winnings = first && !contest.nft ? loot.contestWinnings(contest, entry.amount) : null;
        // A contest of NFTs: what its claim moves, and which of those the project no longer holds (its collection
        // took it back or burned it). Such an NFT is not sent anywhere: the claim closes it, and says so here first.
        const moves = contest.nft ? await contestNfts(contest, entries, entries.indexOf(entry), undefined) : [];
        const lost = moves.filter(m => m.gone);
        const mine = lost.find(m => m.nft === entry.nft && entries[m.j] === entry);
        const there = [
          moves.some(m => entries[m.j] === entry && !m.gone) ? 'your NFT back' : '',
          moves.some(m => entries[m.j] !== entry && !m.gone) ? 'your pick of the losers’' : '',
        ]
          .filter(Boolean)
          .join(', and ');
        const goneSays = [
          off ? 'The contest is off.' : '',
          there ? `${there[0].toUpperCase()}${there.slice(1)}.` : '',
          goneContestSays(
            mine?.nft,
            lost.filter(m => m !== mine).map(m => m.nft),
          ),
        ]
          .filter(Boolean)
          .join(' ');
        out.push({
          kind: 'contest',
          id: contest.id,
          side: entry.side,
          ...(lost.length ? { gone: true, assets: lost.map(m => m.nft), says: goneSays } : { says }),
          ...(winnings ? { potUnits: String(winnings.pot), prizeUnits: String(winnings.prize) } : {}),
        });
      }
      // The player's holds; the project's treasury wallet's also those owed to the treasury (a hold whose player is the
      // project's own address: a dropped stash NFT, a lottery's or an auction's NFT owed to it). And the loans this
      // wallet made: one search of the project's holds finds them all.
      const g = await projectNow();
      const holdsOf = [me, ...(g.treasury === me ? [project] : [])];
      const holds = (await client.programAccounts(loot.lootProgram(), [tag('Hold'), at(1, project)]))
        .map(({ pubkey, account }) => ({ pubkey, hold: loot.decode('Hold', account.data) }))
        .filter(({ hold }) => holdsOf.includes(hold.player) || hold.debt?.lender === me);
      // Whether the project still holds each one's NFT: whoever controls its collection can take it back or burn it.
      const heldOf = await heldEach(holds.map(({ hold }) => hold.asset));
      for (const { pubkey, hold } of holds) {
        const claim = { kind: 'release', asset: hold.asset, hold: pubkey };
        // An NFT proven gone: its hold closes at any time, also while it runs and for a loan before it is due.
        if (heldOf.get(hold.asset)?.held === false) out.push({ ...claim, gone: true, says: goneHoldSays(hold) });
        // A repaid loan is a plain hold that is over (no debt, `free_at` 0): its NFT goes home whenever.
        else if (!hold.debt && holdsOf.includes(hold.player) && time >= BigInt(hold.free_at))
          out.push({
            ...claim,
            says:
              hold.player === project
                ? 'An NFT owed to the treasury: send it there.'
                : 'Your collectible back: its hold is over.',
          });
        // A loan this wallet made that is overdue and unpaid: its NFT is the lender's to take.
        else if (hold.debt?.lender === me && time >= BigInt(hold.free_at))
          out.push({ ...claim, says: 'A loan you made is overdue and unpaid: take its NFT.' });
      }
      // A compressed NFT's proof record this wallet paid for and left open: closing it brings its rent back. Found by its
      // payer, which sits at one of two places (without an asset data hash, and with one: `loot.PROVEN_PAYER_AT`): a
      // scan of every proof record of the program is refused by the play host's relay, and by any RPC that bounds what
      // a scan may ask. These records only give rent back, so a scan that is refused leaves them out and lists the rest.
      const proven = new Map();
      for (const offset of loot.PROVEN_PAYER_AT) {
        const found = await client.programAccounts(loot.lootProgram(), [tag('Proven'), at(offset, me)]).catch(() => []);
        for (const x of found) proven.set(x.pubkey, x);
      }
      for (const { account } of proven.values()) {
        const leaf = (() => {
          try {
            return loot.decodeProven(account.data);
          } catch {
            return null;
          }
        })();
        if (leaf?.payer === me)
          out.push({
            kind: 'close-leaf',
            asset: leaf.asset,
            tree: leaf.tree,
            says: 'A compressed NFT’s proof record you paid for: close it, and its rent comes back.',
          });
      }
      const auctions = spec.auctions ?? [];
      const found = await client.accounts(auctions.map(a => auctionAt(a)));
      for (const [i, a] of auctions.entries()) {
        const x = found[i] && loot.decode('Auction', found[i].data);
        if (!x || time < loot.auctionEnds(x)) continue;
        const [sold, owed] = [BigInt(x.high) > 0n, BigInt(x.proceeds_owed) > 0n];
        if (!(x.seller === me || (sold && !owed && x.high_bidder === me))) continue;
        // Its lot, or an NFT of the winning bid, that the project no longer holds (its collection took it back or
        // burned it): the end does not send it anywhere, and this says what the end does instead.
        const lot = owed ? null : (x.lot.Asset?.[0] ?? null);
        const bids = sold && x.nft_bids ? x.held : [];
        const heldOf = lot || bids.length ? await heldEach([...(lot ? [lot] : []), ...bids]) : new Map();
        const lostBids = bids.filter(nft => heldOf.get(nft)?.held === false);
        if ((lot && heldOf.get(lot)?.held === false) || lostBids.length) {
          const lotGone = lot && heldOf.get(lot)?.held === false;
          out.push({
            kind: 'auction',
            key: a.key,
            gone: true,
            assets: [...(lotGone ? [lot] : []), ...lostBids],
            says: goneSaleSays(a.name, x, me, lotGone ? lot : null, lostBids),
          });
          continue;
        }
        // The lot went first (an end too wide for one transaction, or a seller's account that couldn't take the money
        // then): only the money is left to pay.
        if (owed)
          out.push({
            kind: 'auction',
            key: a.key,
            says: `The winner of “${a.name}” has the lot, and the winning bid is still to be paid to you: end it again, and it is paid (once your account can take it).`,
          });
        else if (x.high_bidder === me) out.push({ kind: 'auction', key: a.key, says: `You won “${a.name}”: take it.` });
        // The seller's own auction, over: ending it pays them (or brings an unsold lot home).
        else
          out.push({
            kind: 'auction',
            key: a.key,
            says: sold
              ? `Your auction “${a.name}” is over: end it, and the winning bid is paid to you.`
              : `Your auction “${a.name}” ended with no bid: take your lot back.`,
          });
      }
      for (const l of spec.lotteries ?? []) {
        // A lottery the page names but nobody has written yet (a raffle still to open) has nothing to finish.
        if (!(await client.account(loot.pda.lottery(project, l.id)))) continue;
        const { current, rounds } = await roundOf(l);
        const bought = r => r.entries.some(e => e.buyer === me);
        if (current?.status === 'Open' && time >= BigInt(current.terms.draws_at)) {
          const short = BigInt(current.sold) < BigInt(current.terms.min_sold ?? 0);
          out.push({
            kind: 'reveal',
            key: l.key,
            says: short
              ? `“${l.name}” sold fewer tickets than it needs: call it off${bought(current) ? ' and take your ticket payment back, in one step' : ''}.`
              : `The draw of “${l.name}” is due: reveal the winners.`,
          });
        }
        for (const { address: round, round: r } of rounds) {
          // The ask moved the lottery on: a round waiting for the oracle is an older one, asked again by its address,
          // and after the timeout the next ask cancels it.
          if (loot.lotteryCancellable(r, chainTime))
            out.push({
              kind: 'cancel-draw',
              key: l.key,
              round,
              says: `The oracle never answered the draw of “${l.name}”: call it off${bought(r) ? ' and take your ticket payment back, in one step' : ', so every ticket is refunded'}.`,
            });
          else if (loot.lotteryDrawStuck(r, chainTime))
            out.push({
              kind: 'reveal',
              key: l.key,
              round,
              says: `The oracle never answered the draw of “${l.name}”: ask it again.`,
            });
          if (r.status !== 'Drawn' && r.status !== 'Cancelled') continue;
          // What this wallet is owed: a refund, its NFT ticket, its places' parts of the pot and their prizes.
          const mine = r.entries.flatMap((e, i) => {
            const parts = e.buyer === me ? loot.partsOwed(r, i) : [];
            return parts.length ? [{ entry: i, parts }] : [];
          });
          if (mine.length) {
            // An NFT of these parts that the project no longer holds (its collection took it back or burned it) is
            // not sent anywhere: the claim settles its part without it, and says so here first.
            const { tickets, prizes } = await roundNfts(r, mine);
            const heldOf = tickets.length + prizes.length ? await heldEach([...tickets, ...prizes]) : new Map();
            const lost = list => [...new Set(list)].filter(nft => heldOf.get(nft)?.held === false);
            const [lostTickets, lostPrizes] = [lost(tickets), lost(prizes)];
            const back = r.status === 'Cancelled' || Boolean(r.terms.returns);
            const owed =
              r.status === 'Cancelled'
                ? `Recover your ticket payment for “${l.name}”.`
                : `Take what you are owed in “${l.name}”.`;
            out.push({
              kind: 'pull',
              key: l.key,
              round,
              pulls: mine,
              ...(lostTickets.length + lostPrizes.length
                ? {
                    gone: true,
                    assets: [...lostTickets, ...lostPrizes],
                    says: `${owed} ${goneRoundSays(lostTickets, lostPrizes, back)}`,
                  }
                : { says: owed }),
            });
          }
          // Anyone may pay everyone else what they are owed, and the parts owed in common (about 0.002 SOL of account
          // rent for each payee who has no account for it yet, which stays with them): the last pull closes the round,
          // and its rent goes back to whoever fronted it (the lottery, or its first buyer).
          const others = r.entries.flatMap((e, i) =>
            loot.partsOwed(r, i).length && !mine.some(m => m.entry === i) ? [i] : [],
          );
          const fronted = r.opener === me;
          if (others.length || loot.commonOwed(r).length || (loot.roundFinished(r) && !mine.length))
            out.push({
              kind: 'payout',
              key: l.key,
              round,
              says: fronted
                ? `Pay everyone of “${l.name}” what they are owed: the round then closes, and your deposit for it comes back.`
                : `Pay the others of “${l.name}” what they are owed, so its round can close.`,
            });
        }
      }
      // A farm idle past more ends than a move can walk: anyone may walk it, in parts.
      for (const f of spec.farms ?? []) {
        const farm = await readMaybe('Farm', loot.pda.farm(project, f.id));
        if (!farm?.keeps_ends) continue;
        const { left } = await endsOf(f, farm);
        if (left > loot.MOVE_WALK_ROOM)
          out.push({
            kind: 'walk',
            key: f.key,
            says: `“${f.name ?? f.key}” must be caught up before anyone can move it: ${left} seats’ end times to walk, in ${Math.ceil(left / loot.WALK_PER_TX)} transactions. It is free but for the network fee, and nothing is lost by the wait.`,
          });
      }
      // A sealed schedule that pays this wallet: its runs that are due (vesting nobody can take back).
      for (const sc of spec.schedules ?? []) {
        const schedule = await readMaybe('Schedule', loot.pda.schedule(project, sc.id));
        if (!schedule) continue;
        if (!schedule.action.from.Vest) {
          // Any other schedule that is due: it waits for the project's keys or whoever it pays.
          const state = await projectNow();
          const to = schedule.action.to;
          if (
            [state.owner, state.authority].includes(me) ||
            to.Wallet?.[0] === me ||
            (to.Treasury !== undefined && state.treasury === me)
          ) {
            if (loot.runsDue(schedule, chainTime) > 0)
              out.push({ kind: 'schedule', key: sc.key, says: `“${sc.name ?? sc.key}” is due to run: send it.` });
          }
          continue;
        }
        if (schedule.action.to.Wallet?.[0] !== me) continue;
        const vault = await client.account(loot.pda.vest(loot.pda.schedule(project, sc.id)));
        const held = vault ? vault.data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
        if (loot.runsDue(schedule, chainTime, held) > 0)
          out.push({ kind: 'vest', key: sc.key, says: `What has vested of “${sc.name ?? sc.key}”: claim it.` });
      }
      // The player's listings whose rental is over: their NFT can go home (or wait for the next renter).
      const mineListed = await client.programAccounts(loot.lootProgram(), [tag('Listing'), at(1, project), at(33, me)]);
      for (const { account } of mineListed) {
        const listing = loot.decode('Listing', account.data);
        if (listing.deal.Rent && listing.user !== NO_ADDRESS && !loot.renterOf(listing, chainTime))
          out.push({
            kind: 'unlist',
            asset: listing.asset,
            says: listing.stopped
              ? 'The rental of your stopped listing is over: take your NFT home.'
              : 'A rental of yours is over: take your NFT home, or leave it listed for the next renter.',
          });
      }
      // The lookup tables a transaction of this player's too big for a legacy one made (`send`): each is deactivated by
      // the transaction it was made for, and its rent comes back once it has cooled down (about 513 slots). One of this
      // project's whose transaction was never sent (the wallet declined it) is retired first. A table that names no
      // account of this project is another app's: left alone.
      const mineTables = await client.programAccounts(LOOKUP_TABLE_PROGRAM, tablesOf(me)).catch(() => []);
      // A table closes once its deactivation slot has left the recent slot hashes (skipped slots keep it there longer).
      const recent = mineTables.length ? await recentSlots() : [];
      for (const { pubkey, account } of mineTables) {
        const table = readTable({ ...account, owner: account.owner ?? LOOKUP_TABLE_PROGRAM });
        // The project's standing tables are never a transaction's own: never retired here.
        if (!table || table.authority !== me || (spec.live?.tables ?? []).includes(pubkey)) continue;
        const step = tableStep(table, slot, recent);
        const rent = show(BigInt(account.lamports ?? 0), 9);
        if (step === 'close')
          out.push({
            kind: 'lookup-table',
            table: pubkey,
            says: `${rent} SOL of rent back from a lookup table a large transaction of yours used.`,
          });
        else if (
          step === 'active' &&
          table.addresses[0] === project &&
          slot > table.lastExtendedSlot + TABLE_UNSENT_SLOTS
        )
          out.push({
            kind: 'lookup-table',
            table: pubkey,
            says: `A lookup table made for a large transaction of yours that was never sent: retire it, and its ${rent} SOL of rent comes back about two minutes later.`,
          });
      }
      return out;
    },

    /**
     * Finishes one of `claims()`, signed by this player. Returns the signature. A `release` flagged `gone` closes its
     * hold on the proof that the project no longer holds the NFT: nothing is sent, the hold's rent goes back to whoever
     * paid it, and a loan's debt ends unpaid. A winner of a contest of NFTs picks
     * which loser's NFT they take (`{ take: asset }`, the NFT of a losing entry that still holds one; by default the
     * first found that the project still holds): only the winner can, while any are left.
     * An NFT a lottery's round or a contest owes that the project no longer holds (its collection took it back or
     * burned it) is not sent anywhere, and the claim still finishes. A ticket whose price sends it on (burned, given,
     * stashed) settles on the proof with nothing moved. A ticket going back to its buyer, a place's NFT and a
     * contest's NFT are only handed out by the program, which reads nothing first: the claim has it make a hold of
     * that NFT (`["hold", nft, 0]`) and closes that hold on the proof right after, in the same transaction when it
     * fits. The signer pays that hold's rent and gets it back at once. The program's receipts for it are those of a
     * hold made (`Held`, and `PrizeGiven` for a place's prize) and then `NftGone`: no `Released`.
     */
    async claim(c, { take, build = false, ...others } = NO_OPTIONS) {
      only(others, ['take', 'build'], 'claim');
      const me = wallet.address;
      // `build`: its instructions, unsent, for a step that is one transaction of the wallet's (`claimAll` signs several
      // at once); null for one that is not (a roll to wait for, a refund, a step of another flow).
      if (build && !BATCHED.has(c.kind)) return null;
      const send = build ? async instructions => instructions : sendNow;
      const g = await projectNow();
      if (c.kind === 'settle' || c.kind === 'refund') {
        // A settle key this order's open funded (made again from this session's signature, or stored): it settles with
        // no prompt, or gives its SOL back before the refund.
        const key = keys ? await keys.again(c.order, { ask: false }) : null;
        const funded = key && BigInt(await client.balance(key.address).catch(() => 0n)) > 0n ? key : null;
        if (c.kind === 'settle') return (await collect(c.order, funded ? { burner: funded } : {})).settled;
        if (funded) await emptyKey(funded);
        return this.refund(c.order);
      }
      if (c.kind === 'contest') {
        const contestAddress = loot.pda.contest(project, c.id);
        const contest = await read('Contest', contestAddress);
        const entries = loot.decodeEntries((await client.account(loot.contestEntries(contestAddress, contest))).data);
        const i = entries.findIndex(e => e.player === me);
        const own = entries[i];
        const won = contest.verdict === 'Won' && Number(contest.winner) === Number(own.side);
        const given = await prizeInputs([won && !(own.bits & loot.CLAIMED) ? contest.prize : null]);
        // A contest of NFTs: the entry's own NFT while the contest holds it, and for a winner the losers' NFTs its share
        // lets it pick (`take`: one asset, or several; the first left by default), as many as fit.
        const nfts = [];
        const kinds = {};
        // The NFTs of this claim that are proven gone from the project, each with what shows it and who staked it.
        // The contest only hands an NFT out and reads nothing, so each is passed as its hold (`["hold", nft, 0]`, made
        // for this player, who gets it), and that hold closes on the proof right after the claim: nothing is sent.
        const lost = new Map();
        if (contest.nft) {
          const proofs = {};
          for (const { j, nft } of await contestNfts(contest, entries, i, take)) {
            const { before, hasAuthority: _, gone, ...kind } = await leaving(nft, me, { to: me });
            proofs[nft] = before;
            kinds[nft] = kind;
            if (gone) lost.set(nft, { kind, player: me, rentTo: entries[j].player });
            nfts.push(j);
          }
          // A compressed NFT's proof is long (up to 17 nodes): such a claim moves one NFT, as a v0 transaction with a
          // lookup table (`send`), and the next claim takes the next.
          if (nfts.length > 1 && nfts.some(j => kinds[entries[j].nft]?.compressed)) nfts.splice(1);
          for (const j of nfts) given.before.push(...proofs[entries[j].nft]);
        }
        const closes = nfts.map(j => entries[j].nft).filter(nft => lost.has(nft));
        const claimed = [
          computeUnitLimit(800_000),
          ...given.before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
          loot.claimIx({
            payer: me,
            project,
            projectState: g,
            id: c.id,
            contest,
            entries,
            player: me,
            nfts: contest.nft ? nfts : undefined,
            kinds,
            hold: closes,
            collection: given.collection,
            poolMints: given.poolMints,
            items: given.items,
            nft: given.nft,
            programs,
          }),
          ...closes.map(nft => releaseOwed(nft, lost.get(nft).kind, lost.get(nft), me, g)),
        ];
        // A prize that rolls: asked for in the claim's own transaction and settled by a key after (one prompt).
        return contest.prize?.Roll && !build ? (await sendRolling(claimed)).signature : send(claimed);
      }
      if (c.kind === 'release') {
        const hold = await read('Hold', c.hold);
        // Its NFT proven gone from the project: the hold closes on that proof, at any time, and nothing is sent. Its
        // rent goes back to whoever paid it; a loan's debt ends unpaid.
        const proof = await goneProof(c.asset, me);
        if (proof)
          return send([
            ...proof.before,
            loot.releaseIx({
              signer: me,
              project,
              asset: c.asset,
              ...proof.kind,
              hold,
              address: c.hold,
              treasury: g.treasury,
              ...(hold.debt ? { to: hold.debt.lender } : {}),
            }),
          ]);
        const { before, hasAuthority: _, ...nft } = await nftOf(c.asset, me, { to: me });
        // An overdue loan's NFT goes to its lender.
        return send([
          ...before,
          loot.releaseIx({
            signer: me,
            project,
            asset: c.asset,
            ...nft,
            collection: (await collectionOf(c.asset)) ?? MPL_CORE,
            hold,
            address: c.hold,
            treasury: g.treasury,
            ...(hold.debt ? { to: hold.debt.lender } : {}),
          }),
        ]);
      }
      if (c.kind === 'auction') {
        const ended = await this.endAuction(c.key);
        // A lot that can't move now: the sale waits, and nothing was sent.
        if (ended.waiting) throw new Error(ended.says);
        return ended.signature;
      }
      if (c.kind === 'close-leaf') return send([loot.closeLeafIx({ asset: c.asset, tree: c.tree, payer: me })]);
      if (c.kind === 'walk') return this.walkFarm(c.key);
      if (c.kind === 'vest' || c.kind === 'schedule') return this.runSchedule(c.key);
      if (c.kind === 'unlist') return this.unlist(c.asset);
      if (c.kind === 'lookup-table') {
        const table = readTable(await client.account(c.table));
        const step = table && tableStep(table, await slotNow(), await recentSlots());
        if (!step || step === 'cooling') return null;
        return send(
          [
            step === 'close'
              ? closeTableIx({ table: c.table, authority: me })
              : deactivateTableIx({ table: c.table, authority: me }),
          ],
          [],
          { keepWrapped: true },
        );
      }
      if (!LOTTERY_STEPS.has(c.kind)) throw new Error(`Nothing to do for a claim of kind ${c.kind}.`);
      const l = part('lotteries', c.key);
      // An older round, named by its address, needs no lottery: one closed since never strands it.
      const lottery = c.round
        ? await readMaybe('Lottery', loot.pda.lottery(project, l.id))
        : await read('Lottery', loot.pda.lottery(project, l.id));
      const key = c.round ?? loot.currentRound(loot.pda.lottery(project, l.id), lottery);
      const found = await client.account(key);
      const r = found?.owner === loot.lootProgram() ? loot.decodeRound(found.data) : null;
      // The ask: the current round's once due, or an older round's again (after the timeout, it cancels the round).
      if (c.kind === 'reveal' || c.kind === 'cancel-draw') {
        const steps = await drawStep(l, lottery, c.round ?? null, r, me);
        // A draw that cancels the round (short of its least tickets, or the oracle never answered by the timeout)
        // refunds in the same transaction: this wallet's own parts are pulled right after it.
        const refunds = r ? await cancelPulls(key, r, me) : [];
        if (refunds.length) {
          const all = [
            computeUnitLimit(1_400_000),
            ...[...steps, ...refunds].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
          ];
          if ((await dryRun(me, all)).ok) return build ? all : send(all);
        }
        return build ? steps : send(steps);
      }
      if (!r) return null;
      // A round whose lottery was closed since: its lent rent is the owner's, on the owner's own close.
      const lotteryClosed = !lottery;
      // Pulls: this wallet's own parts, or (`payout`) everyone's and the parts owed in common, a few to a transaction;
      // when they are the last owed, the last pull closes the round. A round that owes nothing is only closed.
      // A named stash NFT that is gone refuses a stranger's pull: only its winner or a project key passes it over.
      const projectKey = me === g.owner || me === g.authority;
      const stranger = async (i, p) => {
        if (projectKey || r.entries[i].buyer === me) return false;
        // A minted prize the project can't mint now (not the mint's authority): a stranger's pull fails, so it is left
        // for later, when the project can; its winner or the project's keys may pass it over for nothing.
        const prized = p.Prize ? r.prizes.find(x => Number(x.run) === Number(p.Prize[0])) : null;
        if (prized?.minted) {
          const data = (await client.account(prized.mint))?.data;
          const authority = data && data[0] === 1 ? encodeBase58(data.subarray(4, 36)) : null;
          if (authority !== project) return true;
        }
        const named = p.Prize ? r.terms.places[Number(p.Prize[0])].prize?.Nft : null;
        if (!named) return false;
        const stash = loot.decodeStash((await client.account(loot.pda.stash(project, named.stash)))?.data ?? null);
        return !stash?.nfts.includes(named.nft);
      };
      const theirs = [];
      if (c.kind !== 'pull')
        for (const i of r.entries.keys()) {
          const parts = [];
          for (const p of loot.partsOwed(r, i)) if (!(await stranger(i, p))) parts.push(p);
          if (parts.length) theirs.push({ entry: i, parts });
        }
      const owed =
        c.kind === 'pull' ? c.pulls : [...loot.commonOwed(r).map(p => ({ entry: null, parts: [p] })), ...theirs];
      if (!owed.length) {
        if (!loot.roundFinished(r)) return null;
        // Rent the lottery lent goes to the owner once it is closed, and only on the owner's own close.
        const close = [
          loot.pullIx({ payer: me, project, roundAddress: key, round: r, projectState: g, lotteryClosed, programs }),
        ];
        return build ? close : send(close);
      }
      const batch = owed.slice(0, 4);
      const settles = batch.reduce(
        (n, { entry, parts }) => n + parts.reduce((m, p) => m + pullSettles(r, entry, p), 0),
        0,
      );
      const closes = settles >= Number(r.owed);
      const instructions = [computeUnitLimit(1_400_000)];
      const rolls = [];
      let heap = false;
      let partial = false;
      for (const [k, { entry, parts }] of batch.entries()) {
        const built = await pulls(key, r, entry, parts, me, {
          closes: closes && k === batch.length - 1,
          lotteryClosed,
        });
        instructions.push(...built.instructions.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM));
        rolls.push(...built.rolls);
        heap ||= built.heap;
        partial ||= built.partial;
      }
      // A run of rolls, or several NFTs out of the round's own stash, asks for the largest heap.
      if (heap) instructions.splice(1, 0, requestHeapFrame(loot.LARGE_SETTLE_HEAP));
      // A pull that stopped short of its part (a raffle's NFTs, 64 a pull; a run of rolls): sent, then the next carries
      // on while the round moves (its NFTs out, its places paid) and still owes it.
      const carryOn = async signature => {
        if (build || !partial) return signature;
        const after = await client.account(key);
        const r2 = after?.owner === loot.lootProgram() ? loot.decodeRound(after.data) : null;
        const moved = r2 && (Number(r2.assigned) > Number(r.assigned) || Number(r2.owed) < Number(r.owed));
        if (!moved) return signature;
        const left =
          c.kind === 'pull'
            ? r2.entries.flatMap((e, i) => {
                const parts = e.buyer === me ? loot.partsOwed(r2, i) : [];
                return parts.length ? [{ entry: i, parts }] : [];
              })
            : null;
        if (left && !left.length) return signature;
        await this.claim(left ? { ...c, pulls: left } : c);
        return signature;
      };
      // A place's roll is asked for in the pull's own transaction (catalog P1): the winner's own, with a key that settles
      // it after (one prompt); someone else's, asked for when the box can give, else left for its winner to ask.
      if (!rolls.length) return build ? instructions : carryOn(await send(instructions));
      if (c.kind === 'pull' && !build) return carryOn((await sendRolling(instructions)).signature);
      const asks = [];
      for (const { order, box } of rolls)
        asks.push(...(await asksFor(me, order, { project, loot_box: loot.pda.box(project, box) })));
      const all = [...instructions, ...asks];
      const asked = (await dryRun(me, all)).ok ? all : instructions;
      return build ? asked : carryOn(await send(asked));
    },

    /**
     * Everything in `list` (by default `claims()`) taken in as few prompts as it can: each step that is one transaction
     * of the wallet's is built first and the lot signed in one prompt when the wallet signs several at once
     * (`wallet.signTransactions`); a lottery's steps depend on each other, so one of each lottery a call. The rest (a roll
     * to settle, a refund, an auction to end…) go one by one after. Returns [{ claim, signature } | { claim, error }].
     */
    async claimAll(list) {
      list ??= await this.claims();
      const [built, alone, lotteries] = [[], [], new Set()];
      const out = [];
      for (const c of list) {
        if (!BATCHED.has(c.kind)) {
          alone.push(c);
          continue;
        }
        const lottery = LOTTERY_STEPS.has(c.kind) ? c.key : null;
        if (lottery !== null && lotteries.has(lottery)) continue;
        const instructions = await this.claim(c, { build: true }).catch(
          e => (out.push({ claim: c, error: e.message }), null),
        );
        if (!instructions?.length) continue;
        if (lottery !== null) lotteries.add(lottery);
        built.push([c, instructions]);
      }
      const sent = await sendBatch(built.map(([, instructions]) => instructions));
      out.push(...built.map(([claim], i) => ({ claim, ...sent[i] })));
      for (const claim of alone)
        out.push(
          await this.claim(claim).then(
            signature => ({ claim, signature }),
            e => ({ claim, error: e.message }),
          ),
        );
      return out;
    },
  };
}
