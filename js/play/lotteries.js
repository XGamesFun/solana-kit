// Lotteries, for the page client (solanaApp): the rounds and their tickets, a ticket's weight, buying tickets, and the
// draw and pulls that settle a round.
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, requestHeapFrame, withSolWrap } from '../chain/programs.js';
import { compileFitting, sendPlan, transactionLocks } from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { isProveLeaf, NO_OPTIONS, only, show } from './common.js';

/**
 * Puts on `ctx` a lottery's rounds, draws and pulls. Returns `ctx`.
 * @param {ReturnType<typeof import('./farms.js').addFarms>} ctx
 */
export function addLotteries(ctx) {
  const {
    programs,
    now,
    client,
    project,
    tokens,
    currencyKey,
    mintOf,
    read,
    leaving,
    releaseOwed,
    prizeInputs,
    projectNow,
    standing,
    dryRun,
    chainNow,
    holdersOf,
    hookTail,
  } = ctx;

  /** The key of the token a lottery's tickets are paid in: the spec's `ticketCurrency`, or the token of its mint. */
  const ticketCurrencyOf = (l, lottery) =>
    l.ticketCurrency ?? [...tokens.keys()].find(k => mintOf(k) === lottery.terms.mint) ?? currencyKey;

  /**
   * A lottery and its rounds that have a record: the current one (null when nobody bought into it yet), and the two
   * before it while they wait for their draw or still pay out (the ask moves the lottery on, so a round drawing or
   * owing parts is an older one). Each { address, round } (`loot.decodeRound`).
   */
  async function roundOf(l) {
    const address = loot.pda.lottery(project, l.id);
    const lottery = await read('Lottery', address);
    const back = [1, 2]
      .filter(k => lottery.round >= k)
      .map(k => loot.pda.round(address, lottery.incarnation, lottery.round - k));
    const keys = [loot.currentRound(address, lottery), ...back];
    const found = await client.accounts(keys);
    const rounds = keys.map((key, i) => ({
      address: key,
      round: found[i]?.owner === loot.lootProgram() ? loot.decodeRound(found[i].data) : null,
    }));
    return { address, lottery, current: rounds[0].round, rounds: rounds.filter(r => r.round) };
  }
  /** The mints a round's ask and pulls move: its pot's, its payment's and each token run's. */
  const roundMints = (r, poolMints = {}) => [
    r.terms.mint,
    loot.paymentMint(r.terms),
    ...r.terms.places
      .map(p => p.prize?.Tokens?.from)
      .filter(Boolean)
      .map(from => (from.Pool ? poolMints[from.Pool[0]] : (from.Mint?.[0] ?? from.Vest?.[0]))),
  ];

  /** Each pool a round's places give tokens from, mapped to its mint (one never opened: the economy's currency). */
  async function roundPoolMints(terms) {
    const out = {};
    for (const p of terms.places) {
      const pool = p.prize?.Tokens?.from.Pool?.[0];
      if (pool === undefined || pool in out) continue;
      const account = await client.account(loot.pda.pool(project, pool));
      out[pool] = account ? encodeBase58(account.data.subarray(0, 32)) : mintOf();
    }
    return out;
  }

  /** The ask for a round's draw (`round` decoded, `key` its address; null for the current round with no record). A
   * round paid from a pot first moves in what the round before left it (`lottery.owing`): that round's record says
   * which pot (gone, any will do). */
  async function drawStep(l, lottery, key, round, signer) {
    const terms = round?.terms ?? lottery.terms;
    const poolMints = await roundPoolMints(terms);
    const extra = await hookTail(roundMints({ terms }, poolMints));
    const first = !round || round.status === 'Open';
    const owingAt =
      first && lottery?.owing && lottery.owing !== NO_ADDRESS && loot.potIdOf(terms) != null
        ? await client.account(lottery.owing)
        : null;
    const owing = owingAt?.owner === loot.lootProgram() ? loot.decodeRound(owingAt.data) : null;
    // That round's answer says what it left the pot: until it lands (or the round is cancelled), this draw waits.
    if (owing?.status === 'Drawing')
      throw new Error(
        `The round of “${l.name ?? l.key}” before this one still waits for the oracle’s answer, and this round is paid from the same pot: its draw waits until that answer lands, or that round is cancelled (anyone may ask again after ${loot.STALE_SECONDS} seconds).`,
      );
    // Settling the round before loads both rounds' records, each with a bit for every place it gives: with many
    // places that outgrows the default 32 KiB heap, so such a draw asks for the most.
    return [
      computeUnitLimit(600_000),
      ...(owing ? [requestHeapFrame(loot.LARGE_SETTLE_HEAP)] : []),
      loot.drawLotteryIx({
        payer: signer,
        project,
        id: l.id,
        lottery,
        round,
        roundAddress: key,
        owing,
        poolMints,
        extra,
      }),
    ];
  }

  /**
   * The NFTs the pulls of a wallet's parts of round `r` (`mine`: [{ entry, parts }]) are to hand out: each entry's NFT
   * ticket ('Own'), and each NFT its places are still owed (`Prize`: the lottery's own stash's, as the pulls take them
   * out; a project stash's named one). Returns { tickets, prizes }, their addresses.
   */
  async function roundNfts(r, mine) {
    const [tickets, prizes] = [[], []];
    let own;
    for (const { entry, parts } of mine) {
      const e = r.entries[entry];
      for (const part of parts) {
        if (part === 'Own' && e.nft !== NO_ADDRESS) tickets.push(e.nft);
        if (!part.Prize || loot.tokenRun(r, Number(part.Prize[0]))) continue;
        const run = Number(part.Prize[0]);
        const place = r.terms.places[run];
        if (place.prize?.Nft) prizes.push(place.prize.Nft.nft);
        if (!loot.ownStash(place)) continue;
        own ??= { stash: loot.decodeStash((await client.account(loot.pda.lotteryStash(r.lottery)))?.data ?? null) };
        const predicted = loot.stashNfts(r, own.stash);
        for (const p of loot.prizePlacesOwed(r, entry, run)) {
          const nft = predicted[loot.nftSlot(r, p)];
          if (nft) prizes.push(nft);
        }
      }
    }
    return { tickets, prizes };
  }

  /**
   * When a draw of round `r` (at `key`) would cancel it (an open round short of its least tickets; a waiting one past
   * the timeout), the pulls of `who`'s own parts as the cancelled round owes them (a few entries' worth), to go right
   * after the draw in its transaction; none otherwise. The round's close rides on them when they are all it owes.
   */
  async function cancelPulls(key, r, who) {
    const short =
      r.status === 'Open' &&
      BigInt(r.sold) < BigInt(r.terms.min_sold ?? 0) &&
      BigInt(now()) >= BigInt(r.terms.draws_at);
    if (!short && !loot.lotteryCancellable(r, await chainNow())) return [];
    // As the program cancels it: every entry's own part owed, and what the ask moved in owed back.
    const potOwed = BigInt(r.pot_arrived) > BigInt(r.to_pot) ? BigInt(r.pot_arrived) - BigInt(r.to_pot) : 0n;
    const pools = r.prizes.filter(p => !p.minted && BigInt(p.arrived) > 0n).length;
    const cancelled = {
      ...r,
      status: 'Cancelled',
      pot_owed: potOwed,
      owed: Number(r.owns) + (potOwed > 0n ? 1 : 0) + pools,
    };
    const mine = r.entries
      .flatMap((e, i) =>
        e.buyer === who && loot.partsOwed(cancelled, i).length
          ? [{ entry: i, parts: loot.partsOwed(cancelled, i) }]
          : [],
      )
      .slice(0, 4);
    const settles = mine.reduce(
      (n, { entry, parts }) => n + parts.reduce((m, p) => m + pullSettles(cancelled, entry, p), 0),
      0,
    );
    const out = [];
    for (const [k, { entry, parts }] of mine.entries())
      out.push(
        ...(
          await pulls(key, cancelled, entry, parts, who, { closes: settles >= cancelled.owed && k === mine.length - 1 })
        ).instructions,
      );
    return out;
  }

  /** The nonce a pull of entry `i` of the round at `key` names: a place's roll is made at `prizeRollNonce(nonce + place)`.
   * The one nonce of that entry: every pull of it (the winner's, a payout's, a cancel's, a run of rolls in parts) names
   * this and no other, so no later pull lands on an order an earlier one made. */
  const pullNonce = (key, i) => loot.prizeNonce(key, BigInt(i));

  /** How many of a round's owed parts a pull of `part` (of entry `i`) settles. */
  const pullSettles = (r, i, part) => {
    if (part === 'Own' || part.Common) return 1;
    const run = Number((part.Pot ?? part.Prize)[0]);
    return part.Pot || loot.tokenRun(r, run)
      ? loot.placesPulled(r, i, run, Boolean(part.Prize))
      : loot.prizePlacesOwed(r, i, run).length;
  };

  /**
   * The pulls of `parts` of entry `i` of a round (`partsOwed`; `i` null for parts owed in common, `commonOwed`), signed by
   * `signer`, and the rolls they make ([{ order, box }], `loot.pullRolls`). With `closes`, the last pull carries the
   * round's close (when the parts it pays are the last owed).
   * An NFT of a part that is proven gone from the project is not sent anywhere. A ticket whose price sends it on
   * passes what proves it gone, and its part settles (`NftGone`, the round its record). A ticket going back to its
   * buyer and a place's NFT are only handed out by the program: the pull passes each as its hold, and a release on
   * the proof follows it here, which closes the hold (`NftGone`, the hold its record). A pull makes holds of all its
   * prize NFTs or of none, so with one of them gone the others are made holds too and released on to their winner.
   */
  async function pulls(key, r, i, parts, signer, { closes = false, lotteryClosed = false } = {}) {
    const e = i == null ? null : r.entries[i];
    const out = [];
    const rolls = [];
    // Whether a pull here wants the largest heap (a run of rolls, or several NFTs out of the round's own stash), and
    // whether one stops short of the part (a raffle's NFTs past what one pull takes out or one transaction carries, a
    // run of rolls past what one transaction carries): a next pull carries on.
    let heap = false;
    let partial = false;
    const g = await projectNow();
    // A run's token prize is in its own mint: the prizes the round recorded name each.
    const extra = await hookTail([...roundMints(r), ...r.prizes.map(p => p.mint)]);
    for (const [k, part] of parts.entries()) {
      const more = {};
      // The NFTs this pull makes holds in place of handing them out (`hold::owe`: for whom, and whose its NFT's
      // account's rent is), each released right after it. The round only hands an NFT out and reads nothing, so one
      // proven gone from the project is made a hold, and that hold closes on the proof.
      const holdsMade = new Map();
      if (part === 'Own' && e.nft !== NO_ADDRESS) {
        const then = r.status === 'Cancelled' || r.terms.returns ? null : r.terms.nft_ticket?.then;
        more.handBack = Boolean(then?.Give) && loot.handsBack(await client.account(then.Give[0]));
        const to = !then || more.handBack ? e.buyer : then.Give ? then.Give[0] : undefined;
        const { before = [], hasAuthority: _, gone, ...kind } = await leaving(e.nft, signer, { to });
        out.push(...before);
        // Where its price sends it on (burned, given, stashed) the round reads the ticket itself: proven gone, it goes
        // nowhere and the part settles. Going back to its buyer it is only handed out: made a hold, closed below.
        if (gone && !then) {
          more.hold = true;
          holdsMade.set(e.nft, { kind, player: e.buyer, rentTo: e.buyer });
        } else more.ticket = kind;
      } else if (part.Prize && !loot.tokenRun(r, Number(part.Prize[0]))) {
        // Each of the entry's places in the run: an NFT of the lottery's own stash (which one, as the pull takes them
        // out), a project stash's NFT, an item, or a roll (asked in the same transaction).
        const run = Number(part.Prize[0]);
        const given = r.terms.places[run].prize;
        // An NFT's kind is read below, with whether the project still holds it.
        const inputs = await prizeInputs([given.Nft || given.Held ? null : given], signer, e.buyer);
        out.push(...inputs.before);
        const handed = new Map();
        const hand = async nft => {
          if (inputs.nfts[nft]) return;
          const { before, hasAuthority: _, gone, ...kind } = await leaving(nft, signer, { to: e.buyer });
          inputs.nfts[nft] = kind;
          out.push(...before);
          handed.set(nft, { kind, gone, player: e.buyer, rentTo: signer });
        };
        const stash = loot.ownStash(r.terms.places[run])
          ? loot.decodeStash((await client.account(loot.pda.lotteryStash(r.lottery)))?.data ?? null)
          : null;
        if (stash) {
          // One pull takes out at most so many of the stash's NFTs (`loot.pullAssigns`): the places past them wait.
          const owedPlaces = loot.prizePlacesOwed(r, i, run);
          const last = loot.placesIn(r, run, e.start, e.end).at(-1) ?? 0;
          if (owedPlaces.some(p => loot.nftSlot(r, p) >= loot.pullAssigns(r, stash, last))) partial = true;
          const predicted = loot.stashNfts(r, stash);
          for (const place of loot.prizePlacesOwed(r, i, run)) {
            const nft = predicted[loot.nftSlot(r, place)];
            if (nft) await hand(nft);
          }
        }
        const stashes = given.Nft
          ? {
              [given.Nft.stash]: loot.decodeStash(
                (await client.account(loot.pda.stash(project, given.Nft.stash)))?.data ?? null,
              ) ?? { nfts: [] },
            }
          : {};
        // A project stash's named NFT is handed out only while that stash lists it.
        if (given.Nft && stashes[given.Nft.stash].nfts.includes(given.Nft.nft)) await hand(given.Nft.nft);
        // One of them gone: a pull makes holds of all its NFTs or of none, so each becomes a hold, and its release
        // below closes the one that is gone and sends any other on to its winner.
        const holds = [...handed.values()].some(x => x.gone);
        if (holds) for (const [nft, x] of handed) holdsMade.set(nft, x);
        more.prize = {
          stash,
          stashes,
          nfts: inputs.nfts,
          hold: holds,
          collection: inputs.collection,
          poolMints: inputs.poolMints,
          items: inputs.items,
          projectMint: mintOf(),
        };
        more.nonce = pullNonce(key, i);
        // A run of places that each give a roll (two accounts a place), or several NFTs out of the round's own stash
        // (each NFT's accounts, and heap the program does not give back: 8 Core moves in a round of some 125 places or
        // more run past the default 32 KiB): as many places as one transaction carries, on the largest heap. The pull
        // is sized from a dry run, largest first; the next pull carries on while the round still owes the entry, and
        // only the last carries the close.
        if (given.Roll || (stash && loot.prizePlacesOwed(r, i, run).length > 1)) {
          const owed = loot.prizePlacesOwed(r, i, run).length;
          const sized = async most => {
            const ix = loot.pullIx({
              payer: signer,
              project,
              roundAddress: key,
              round: { ...r, owed: Number.MAX_SAFE_INTEGER },
              entry: i,
              part,
              projectState: g,
              programs,
              extra,
              ...more,
              prize: { ...more.prize, most },
            });
            const tx = [computeUnitLimit(1_400_000), requestHeapFrame(loot.LARGE_SETTLE_HEAP), ix];
            return (
              Boolean(
                compileFitting({ payer: signer, blockhash: NO_ADDRESS, instructions: tx, tables: await standing() }),
              ) && (await dryRun(signer, tx)).ok
            );
          };
          // (Made holds, each NFT's release follows the pull in its transaction: a few places a pull then.)
          let most = holds ? Math.min(owed, 4) : owed;
          while (most > 1 && !(await sized(most))) most = Math.max(1, Math.floor(most * 0.75));
          if (most < owed) [more.prize.most, partial] = [most, true];
          heap = true;
        }
        rolls.push(...loot.pullRolls({ project, round: r, entry: i, part, nonce: more.nonce, most: more.prize.most }));
      } else if (part.Common) {
        // Where a part owed in common goes: a share's payee (a collectible's holder now), what the places leave (the
        // pot, or the `rest` a round paid from its own money names), a pool; one that can't take it (a pool never
        // opened, the pot closed since, an account gone) sends it to the treasury.
        const c = Number(part.Common[0]);
        const n = r.terms.shares.length;
        const to =
          c < n
            ? r.terms.shares[c].to
            : c === n
              ? loot.leftoverTo(r.lottery, r.terms)
              : r.terms.places[Number(r.prizes[c - n - 1].run)].prize.Tokens.from;
        if (to.Holder) more.holders = await holdersOf([{ to }]);
        const target = to.Pool ? loot.pda.pool(project, to.Pool[0]) : to.Account?.[0];
        // A pot or pool made again in another mint can't take it either: the program sends it to the treasury.
        const mint = c < n ? loot.paymentMint(r.terms) : c === n ? r.terms.mint : r.prizes[c - n - 1].mint;
        const held = target ? await client.account(target) : null;
        if (target && (!held || encodeBase58(held.data.subarray(0, 32)) !== mint)) more.toTreasury = true;
      }
      const last = k === parts.length - 1;
      const round = closes && last ? { ...r, owed: pullSettles(r, i, part) } : { ...r, owed: Number.MAX_SAFE_INTEGER };
      const pull = loot.pullIx({
        payer: signer,
        project,
        roundAddress: key,
        round,
        entry: i ?? 0,
        part,
        projectState: g,
        lotteryClosed,
        programs,
        extra,
        ...more,
      });
      out.push(pull);
      // Each hold this pull makes (a pull that stops short carries only some) is released at once: one whose NFT is
      // gone closes on the proof and nothing is sent, any other goes on to its winner, and the hold's rent comes back
      // to the signer, who paid it.
      for (const [nft, { kind, player, rentTo }] of holdsMade)
        if (pull.keys.some(x => x.pubkey === loot.pda.hold(nft, 0)))
          out.push(releaseOwed(nft, kind, { player, rentTo }, signer, g));
    }
    return { instructions: out, rolls, heap, partial };
  }
  return Object.assign(ctx, { ticketCurrencyOf, roundOf, drawStep, roundNfts, cancelPulls, pullSettles, pulls });
}

/**
 * The lottery methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function lotteryMethods(ctx) {
  const {
    spec,
    wallet,
    programs,
    now,
    client,
    project,
    tokens,
    currencyKey,
    decimalsOf,
    part,
    personFor,
    ticketCurrencyOf,
    nftOf,
    projectNow,
    passing,
    listProofOf,
    send,
    kindOnly,
    chainNow,
    clearLeftovers,
    closesFirst,
    holdersOf,
    roundOf,
    hookTail,
    drawStep,
  } = ctx;

  return {
    /**
     * The lotteries: each one's ticket price now, its round and status, and its terms (`incarnation`, `revision`),
     * which `buyTickets` takes as the terms the player was shown. A lottery not written yet (a raffle still to open)
     * has a null price.
     */
    async lotteries() {
      const list = spec.lotteries ?? [];
      const out = [];
      for (const l of list) {
        const there = await client.account(loot.pda.lottery(project, l.id));
        // The terms on sale are the round's own copy once someone bought into it, the lottery's before.
        const { lottery, current } =
          there?.owner === loot.lootProgram() ? await roundOf(l) : { lottery: null, current: null };
        const copy = current ?? lottery;
        const terms = copy?.terms;
        const currency = lottery ? ticketCurrencyOf(l, lottery) : (l.ticketCurrency ?? currencyKey);
        const ended = lottery && loot.lotteryEnded(lottery);
        // A lottery that weighs tickets by time: what one ticket bought now weighs, and its share of the round's weight
        // (the same ticket bought later weighs less: show it on the buy screen).
        const odds = terms && !ended ? loot.purchaseOdds(current, terms, 1n, await chainNow()) : null;
        out.push({
          key: l.key,
          name: l.name,
          price: terms ? show(terms.price, decimalsOf(currency)) : null,
          priceUnits: terms?.price ?? null,
          currency: tokens.get(currency)?.symbol ?? currency,
          status: !lottery ? null : ended ? 'Ended' : (current?.status ?? 'Open'),
          round: lottery?.round ?? null,
          sold: lottery ? (current?.sold ?? 0n) : null,
          drawsAt: terms ? Number(terms.draws_at) : null,
          salesCloseAt: terms ? Number(loot.salesCloseAt(terms)) : null,
          timeWeighted: Boolean(terms?.time_weighted),
          weight: current ? loot.roundTotal(current) : null,
          ticketWeight: odds?.weight ?? null,
          ticketShare: odds?.share ?? null,
          nftTicket: Boolean(lottery?.terms.nft_ticket),
          incarnation: lottery?.incarnation ?? null,
          revision: copy?.revision ?? null,
        });
      }
      return out;
    },

    /**
     * What `count` tickets of a lottery bought now would weigh in its current round's draw, before they are bought:
     * { tickets, weight, total, share, salesCloseAt, timeWeighted }. In a lottery that weighs tickets by time, each
     * ticket weighs the seconds from its purchase to the close of sales, so the same tickets bought later weigh less;
     * `share` is the purchase's part of the round's weight with it (0 to 1), its chance at each place as things stand.
     */
    async ticketWeight(lotteryKey, count = 1) {
      const l = part('lotteries', lotteryKey);
      const { lottery, current } = await roundOf(l);
      const terms = (current ?? lottery).terms;
      const odds = loot.purchaseOdds(current, terms, BigInt(count), await chainNow());
      return {
        tickets: BigInt(count),
        ...odds,
        salesCloseAt: Number(loot.salesCloseAt(terms)),
        timeWeighted: Boolean(terms.time_weighted),
      };
    },

    /**
     * Buys `count` tickets of a lottery, on the terms the player was shown: `listing`, the lottery as `lotteries()`
     * showed it (a lottery changed since, its price or anything else, is refused rather than paid), or `maxPrice`, the
     * most a ticket may cost, in base units. One of them is required: the price read now is never the bound.
     * `chosenRecipient`: the wallet (or collectible) the player names for a share the lottery lets them choose (a
     * referrer). A lottery whose ticket costs an NFT (`nft_ticket`) sells one ticket for one of the player's NFTs that
     * passes its rule: `nft`, its address (held by the project until the draw, then burned, given on or stashed; back to
     * the player if the round is cancelled). `listProof`: for a list gate. `make`: { recipe, times, listing (or
     * version), assets }, a recipe crafted first in the same transaction, so a player short of what a ticket costs (an
     * entry a recipe makes) approves once for both; a recipe that rolls can't ride along.
     */
    async buyTickets(
      lotteryKey,
      count = 1,
      {
        shown,
        chosenRecipient = null,
        listProof,
        nft: paidWith,
        listing,
        maxPrice,
        acceptLeftover,
        make,
        ...others
      } = NO_OPTIONS,
    ) {
      only(
        others,
        ['shown', 'chosenRecipient', 'listProof', 'nft', 'listing', 'maxPrice', 'acceptLeftover', 'make'],
        'buyTickets',
      );
      const l = part('lotteries', lotteryKey);
      const name = l.name ?? lotteryKey;
      if (listing && listing.key !== undefined && listing.key !== l.key)
        throw new Error(`That listing is “${listing.key}”, not “${l.key}”.`);
      const given = maxPrice ?? listing?.priceUnits;
      if (given === undefined || given === null)
        throw new Error(
          `Say the terms the player was shown for “${name}”: pass the lottery lotteries() showed (listing), or maxPrice (a ticket's most, in base units). The price read now is never the bound.`,
        );
      const { lottery: onChain, current: openRound } = await roundOf(l);
      // A round whose draw is due takes no more tickets: its draw goes first, in this same transaction (the buyer pays
      // the oracle's fee for it), and moves the lottery on, so this purchase is the next round's first. A lottery that
      // draws once has no next round.
      const due = openRound?.status === 'Open' && BigInt(now()) >= BigInt(openRound.terms.draws_at) ? openRound : null;
      if (due && Number(onChain.every) === 0)
        throw new Error(`The one draw of “${l.name}” is due: it takes no more tickets. Reveal it (claims() lists it).`);
      const draw = due
        ? (await drawStep(l, onChain, null, due, wallet.address)).filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)
        : [];
      const current = due ? { ...onChain, round: onChain.round + 1 } : onChain;
      const round = due ? null : openRound;
      // The terms signed are those shown: the round's own copy once someone bought into it, the lottery's before. A
      // lottery written again or changed since is refused here, and by the program (TermsChanged) if it changes after
      // this read.
      const { terms, revision } = round ?? current;
      if (listing && (listing.incarnation == null || listing.revision == null))
        throw new Error(
          `That listing of “${name}” names no terms (incarnation, revision): pass the lottery lotteries() showed.`,
        );
      if (
        listing &&
        (BigInt(listing.incarnation) !== BigInt(current.incarnation) || Number(listing.revision) !== Number(revision))
      )
        throw new Error(
          `“${name}” has changed since the player was shown it: show them the lottery as it is now first.`,
        );
      const lottery = current;
      const currency = ticketCurrencyOf(l, lottery);
      if (BigInt(terms.price) > BigInt(given))
        throw new Error(
          `A ticket of “${name}” now costs ${show(terms.price, decimalsOf(currency))}, more than the ${show(BigInt(given), decimalsOf(currency))} the player was shown: show them the new price first.`,
        );
      if (loot.lotteryEnded(lottery)) throw new Error(`“${l.name}” has drawn and ended.`);
      // Sales close `closes_before` seconds before the draw (SalesClosed after).
      // (A repeating lottery's current round nobody bought into moves to its next date as this purchase opens it.)
      const movesOn = !round && Number(lottery.every) > 0 && BigInt(now()) >= BigInt(terms.draws_at);
      if (!due && !movesOn && BigInt(now()) >= loot.salesCloseAt(terms))
        throw new Error(
          `Sales of “${name}” closed at ${new Date(Number(loot.salesCloseAt(terms)) * 1000).toISOString()}, before its draw: wait for the next round.`,
        );
      shown ??= await passing(lottery.gate, 'buy a ticket');
      listProof = listProofOf(lottery.gate, l.gate?.list, listProof);
      let nft;
      let clears = [];
      const before = [];
      if (terms.nft_ticket) {
        if (!paidWith) throw new Error(`A ticket of “${l.name}” costs an NFT: say which (nft).`);
        if (BigInt(count) !== 1n) throw new Error('An NFT pays for one ticket at a time.');
        // The project holds an NFT ticket until the round is drawn: what an earlier owner left of it goes first.
        clears = await clearLeftovers(paidWith, acceptLeftover);
        const { before: proof, ...kind } = await nftOf(paidWith);
        nft = { asset: paidWith, ...kind };
        before.push(...proof);
      }
      const mint = loot.paymentMint(terms);
      const { shares } = terms;
      const choosesHolder = shares.some(s => s.to.Chosen && s.to.Chosen.item != null);
      // A share the buyer chooses is paid now, from their own account: to the holder of the collectible they chose (read
      // now), the wallet they named, or with no choice the treasury.
      const holders = choosesHolder && chosenRecipient ? await holdersOf([{ to: { Holder: [chosenRecipient] } }]) : {};
      // A payment mint with a transfer hook: its accounts ride along.
      const extra = await hookTail([mint]);
      const linked = await personFor(lottery.per_wallet);
      before.push(...linked.ixs);
      const ix = loot.buyTicketsIx({
        player: wallet.address,
        project,
        id: l.id,
        lottery,
        person: linked.person,
        round,
        mint,
        count: BigInt(count),
        shown,
        listProof,
        chosenRecipient,
        chosen: choosesHolder ? chosenRecipient : null,
        nft,
        holders,
        treasury: (await projectNow()).treasury,
        programs,
        extra,
      });
      // An overdue round nobody bought into moves to its next date by itself when a ticket is bought.
      // A ticket paid with an NFT: its way out must land too, the NFT handed on once the round is drawn or back to its
      // buyer when it is cancelled, each sized before the NFT goes in.
      if (nft) {
        const g = await projectNow();
        const entry = { buyer: wallet.address, nft: paidWith, start: 0n, end: 1n, amount: 0n, paid: 0n };
        for (const status of ['Drawn', 'Cancelled']) {
          const r = {
            lottery: loot.pda.lottery(project, l.id),
            status,
            terms,
            accounts: [],
            owed: 2,
            opener: wallet.address,
            entries: [entry],
          };
          const exit = [
            computeUnitLimit(1_400_000),
            ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
            loot.pullIx({
              payer: wallet.address,
              project,
              roundAddress: loot.currentRound(r.lottery, lottery),
              round: r,
              entry: 0,
              part: 'Own',
              projectState: g,
              ticket: kindOnly(nft),
              programs,
            }),
          ];
          if (!sendPlan({ payer: wallet.address, instructions: exit, alone: isProveLeaf }))
            throw new Error(
              `Not bought: this NFT couldn't come out of “${l.name}” again (${status === 'Drawn' ? 'handed on once the round is drawn' : 'back to you if the round is cancelled'}): that transaction would lock more accounts than one can (${transactionLocks(wallet.address, exit, { asV0: true })} with its lookup table; at most 64), so it would stay with the lottery.`,
            );
        }
      }
      // `make`: { recipe, times, listing (or version), assets }: a recipe crafted first in the same transaction, so a
      // player short of what a ticket costs (an entry a recipe makes) approves once for both. Its outputs land before
      // the purchase takes them; if either fails, neither happens.
      const made = make
        ? (
            await this.craft(make.recipe, make.assets ?? [], make.times ?? 1, {
              listing: make.listing,
              version: make.version,
              build: true,
            })
          ).instructions.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)
        : [];
      const buy = [
        ...(made.length ? [computeUnitLimit(1_400_000)] : []),
        ...made,
        ...before,
        ...withSolWrap(wallet.address, mint, BigInt(terms.price) * BigInt(count), [ix]),
      ];
      return send(
        await closesFirst(
          clears,
          draw.length
            ? [computeUnitLimit(800_000), ...draw, ...buy.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)]
            : buy,
        ),
      );
    },
  };
}
