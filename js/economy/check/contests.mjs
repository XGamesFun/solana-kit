// The checks of contests (contest.rs).
import { realMoney } from '../../client/pda.js';
import { LIMITS, isAddress, prizePool, prizeToken, prizeWords, sharesOf, wholeCount } from '../model.mjs';
import { label } from '../format.mjs';

/** Checks the contests. */
export function checkContests(c) {
  const {
    now,
    refuse,
    warn,
    m,
    units,
    seconds,
    farTime,
    tooMany,
    quietUnits,
    token,
    prizeCheck,
    holdsUp,
    rule,
    split,
  } = c;
  // ---- contests (contest.rs)
  for (const c of m.contests) {
    const where = `economy.contests.${c.key}`;
    tooMany(
      (c.deciders ?? []).length,
      LIMITS.deciders,
      'E-CONTEST',
      `${where}.deciders`,
      `${label(c)} has ${(c.deciders ?? []).length} deciders`,
      'BadContest',
      'Name fewer deciders.',
    );
    const tok = token(c.currency, `${where}.currency`);
    holdsUp(tok, `${where}.currency`, label(c), 'contest');
    // Entries close no later than the result is due, and with deciders before it: a decider's verdict is taken only
    // once entries close (contest.rs, BadContest). With deciders, a side left out is an hour from the other (plan.mjs
    // `contestArgs`).
    const closes = seconds(c.entriesClose, `${where}.entriesClose`);
    const due = seconds(c.resultDue, `${where}.resultDue`);
    if (c.entriesClose !== undefined && c.resultDue !== undefined && closes > due)
      refuse(
        'E-CONTEST',
        where,
        `${label(c)}’s entries close after its result is due (BadContest).`,
        'Close entries before the result is due.',
      );
    else if ((c.deciders ?? []).length && c.entriesClose !== undefined && c.resultDue !== undefined && closes >= due)
      refuse(
        'E-CONTEST',
        where,
        `${label(c)} has deciders, whose verdict is taken only once entries close, and its entries close when its result is due: the program refuses to open it (BadContest).`,
        'Close entries before the result is due, or leave one of "entriesClose" and "resultDue" out (an hour apart).',
      );
    // A result far off is taken, and warned of with its date: the stakes wait until then.
    farTime(
      now + Math.max(closes, due),
      c.resultDue !== undefined ? `${where}.resultDue` : `${where}.entriesClose`,
      `${label(c)}’s result`,
      c.resultDue ?? c.entriesClose,
      'every entry’s stake waits in its pot',
    );
    // Whoever names the winner: W-ENFORCED (challenge.mjs).
    // One prize a winning entry, and nothing that costs an entry anything: one person's many wallets take one each.
    const stakeUnits = c.stakeNft ? 1n : quietUnits(c.stake, tok);
    if (c.prize && !c.prize.split && !c.gate && !c.stakeNft && !(stakeUnits > 0n))
      warn(
        'W-CONTEST-PRIZE',
        `${where}.prize`,
        `${label(c)} gives a prize to each winning entry, with no fixed stake and no gate: one person with many wallets enters from each and collects one prize a wallet.`,
        'Set a "stake" that makes an entry cost something, gate it, or split one prize by stake ("split": true).',
      );
    if (c.stakeNft && c.losersEach === 0)
      warn(
        'W-ZERO',
        `${where}.losersEach`,
        `${label(c)} takes 0 losers’ NFTs a winner: every loser’s NFT goes to whoever opened it, and the winners get only their own back.`,
        'Give "losersEach" a number above 0, or leave it out for no cap.',
      );
    if (c.sideNames && c.sideNames.length !== c.sides)
      warn(
        'W-CONTEST',
        `${where}.sideNames`,
        `${label(c)} has ${c.sides} sides and ${c.sideNames.length} names for them.`,
        'Name each side once.',
      );
    // A contest's chosen share is a wallet its verdict names (a bounty's worker: contest.rs), never an item's holder.
    split(c.split, tok, `${where}.split`, { what: label(c), chosen: 'wallet' });
    const bounty = (c.split ?? []).find(s => s.to === 'chosen');
    if (bounty)
      warn(
        'W-CONTEST',
        `${where}.split`,
        `${label(c)} pays ${bounty.percent}% to a wallet its verdict names (a bounty): whoever decides the contest names that wallet as they name the side, and the program pays it, so the share is only as fair as ${(c.deciders ?? []).length ? 'its deciders' : 'your keys'}. A verdict that names no wallet is refused (BadChoice), and so is one naming the project.`,
        'Tell the person who decides it and how they pick the wallet; with deciders, a verdict carries the wallet in what they sign (loot.verdictBytes with "recipient").',
      );
    rule(c.gate, `${where}.gate`, label(c));
    const cp = c.prize ? prizeCheck(c.prize, `${where}.prize`, label(c), 'E-CONTEST') : null;
    // A prize split among the winners is set aside when the winner is named, and the program sets aside only an amount
    // above 0 (contest.rs `set_aside`: PrizeNotCovered). The contest opens, but no winner can ever be named.
    if (cp && c.prize.split && cp.gives === 'tokens' && Number(cp.amount) === 0)
      refuse(
        'E-CONTEST',
        `${where}.prize.amount`,
        `${label(c)} splits a prize of 0 among its winners: the program opens the contest but can never name its winner (PrizeNotCovered), so it runs past its result and is called off, every entry refunded.`,
        'Give the prize an amount above 0, or leave the prize out.',
      );
    // A presale: one side, entries paid in money (SOL, or a coin made elsewhere), and another token split among the
    // backers by what each put in: people pay for a share of a token, which is what the law on selling securities
    // looks at first. The prize's own token is read (a pool's is what the pool holds), and entries paid in points
    // the project mints are no sale.
    const sold = cp?.gives === 'tokens' ? prizeToken(c.prize, m) : null;
    if (
      c.prize?.split &&
      c.sides === 1 &&
      sold &&
      !sold.wsol &&
      sold.source !== 'sol' &&
      tok &&
      tok.source !== 'game' &&
      sold.key !== tok.key
    )
      warn(
        'W-TOKEN-SALE',
        `${where}.prize`,
        `${label(c)} sells ${sold.symbol ?? sold.key} for ${tok.symbol ?? tok.key}: each backer pays in and takes a share of the tokens by what they put in. Selling a token to raise money is what securities law looks at first, and many places limit who may buy.`,
        realMoney()
          ? 'This economy is on mainnet, where that is real money: ask counsel first.'
          : 'Fine on devnet. Before mainnet, ask counsel.',
      );
    // One NFT, the last units of an item, a pool's prize: the winning entries share it in the order they are claimed.
    const scarce =
      cp &&
      (cp.gives === 'nft' || (cp.gives === 'item' && Number(m.item.get(cp.item)?.supply ?? 0) > 0) || prizePool(cp));
    // A prize split by stake is set aside whole when the winner is named, or that decision is refused: no entry takes
    // another's part, but the pool must hold all of it by then.
    if (scarce && c.prize.split && prizePool(cp))
      warn(
        'W-CONTEST-PRIZE',
        `${where}.prize`,
        `${label(c)} splits ${prizeWords(cp, m)} among its winners: all of it is set aside when the winner is named, and naming one is refused while “${prizePool(cp)}” holds less (PrizeNotCovered), so the contest would run past its result and be called off.`,
        'Keep the pool holding the whole prize until the winner is named: seed it with that much, and let nothing else pay out of it.',
      );
    else if (scarce)
      warn(
        'W-CONTEST-PRIZE',
        `${where}.prize`,
        `${label(c)} gives ${prizeWords(cp, m)} to each winning entry as it is claimed: ${cp.gives === 'nft' ? 'there is one, so the first winning entry claimed takes it and the others get none' : 'when it runs short, the entries claimed first take it'}, and anyone may claim the entries in any order.`,
        cp.gives === 'nft'
          ? 'For one winner, use a contest whose sides are the players (a gate of wallets), or give a roll of a box instead.'
          : 'Keep enough for every winner, or give a roll of a box.',
      );
    if (c.stakeNft) {
      // A pot of NFTs: no split and no stake of tokens (contest.rs BadContest).
      if (sharesOf(c.split).length)
        refuse(
          'E-CONTEST',
          `${where}.split`,
          `${label(c)}’s entries stake NFTs: there is no money to take shares of (BadContest).`,
          'Remove the split.',
        );
      if (c.stake !== undefined)
        refuse(
          'E-CONTEST',
          `${where}.stake`,
          `${label(c)}’s entries stake one NFT each, not tokens (BadContest).`,
          'Remove "stake".',
        );
      rule(c.stakeNft, `${where}.stakeNft`, `${label(c)}’s stake`);
      warn(
        'W-NFT-PRICE',
        `${where}.stakeNft`,
        `${label(c)}’s entries each stake one NFT, and the NFTs are the pot: each winner takes its own back and its share of the losers’ (${c.losersEach ? `at most ${c.losersEach}` : 'all of them, shared'}; the first to enter on the winning side take one more when they don’t divide evenly), each picking which, and the losers’ NFTs the winners leave go to whoever opened it. Losers send nothing. The project holds every NFT until it is claimed.`,
      );
    }
    const deciders = c.deciders ?? [];
    deciders.forEach(
      (k, i) =>
        isAddress(k) ||
        refuse(
          'E-REF',
          `${where}.deciders[${i}]`,
          `${label(c)}’s decider “${k}” is not a public address.`,
          'Write the results server’s public key (never its private key).',
        ),
    );
    // A contest of NFTs counts its pot in NFTs, so its least pot is a whole number of them.
    const minPot = c.stakeNft
      ? wholeCount(c.minPot)
      : units(c.minPot, tok, `${where}.minPot`, `${label(c)}’s least pot`);
    if (c.stakeNft && minPot === null)
      refuse(
        'E-CONTEST',
        `${where}.minPot`,
        `${label(c)}’s entries stake NFTs, so its least pot counts NFTs: ${c.minPot} is not a whole number of them.`,
        'Write how many NFTs its sides must hold, like 4.',
      );
    units(c.stake, tok, `${where}.stake`, `${label(c)}’s stake`);
    if (c.sides === 1) {
      if (!minPot)
        warn(
          'W-CONTEST',
          `${where}.minPot`,
          `${label(c)} has one side and no goal: it is a collection that pays its split whatever it raises.`,
          'Give it a "minPot": short of it, everyone takes their money back (an all-or-nothing crowdfund).',
        );
      if (sharesOf(c.split).reduce((n, s) => n + (s.bps ?? 0), 0) < 10_000)
        warn(
          'W-CONTEST',
          `${where}.split`,
          `${label(c)} has one side, so its backers share back what its split leaves: a crowdfund’s split sends all of it to whoever it funds.`,
          'Send 100% to the wallet it funds.',
        );
    } else
      warn(
        'W-CHANCE-PRIZE',
        where,
        `${label(c)} lets players put money on an outcome: that is betting, which is regulated in most places once it is real money (state rules on prediction markets are in flux). ${realMoney() ? 'This economy is on mainnet: it is real money.' : 'This economy is on devnet, which is not real money.'}`,
        'Before mainnet: counsel, an age and region gate, and a name that does not call it an investment.',
      );
  }
}
