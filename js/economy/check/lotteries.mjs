// The checks of lotteries (lottery.rs).
import IDL from '../../client/idl/loot.js';
import { entryWidth, MAX_POTS } from '../../client/accounts.js';
import {
  feesOf,
  LIMITS,
  destination,
  fromUnits,
  keepsPot,
  lotterySplit,
  placeOf,
  limitsPlayers,
  prizePool,
  prizeToken,
  prizeWords,
  SpecError,
  toUnits,
} from '../model.mjs';
// plan.mjs imports check() in turn: each module only calls the other's functions, never at load time.
import { entryShape, roundSize } from '../plan.mjs';
import { label } from '../format.mjs';

/** A lottery's token accounts at most (lottery.rs MAX_MINTS), and what one instruction grows an account by (MAX_GROW). */
const LOTTERY_MINTS = 8;
const LOTTERY_ROUND_GROW = 10_240;

/** The most a u64 holds. */
const U64_MAX = 2n ** 64n - 1n;

/** The most places a run of a lottery's places given one by one holds (lottery.rs). */
const MAX_RUN_PLACES = Number(IDL.constants.find(c => c.name === 'MAX_RUN_PLACES').value);

/** Checks the lotteries. */
export function checkLotteries(c) {
  const {
    economy,
    now,
    refuse,
    warn,
    m,
    units,
    fromNowSeconds,
    timeAt,
    farTime,
    tooMany,
    percent,
    built,
    token,
    prizeCheck,
    holdsUp,
    lotteryPotFilled,
    rule,
    thenCheck,
    split,
    perWalletWindow,
  } = c;
  // ---- lotteries (lottery.rs)
  for (const l of m.lotteries) {
    const where = `economy.lotteries.${l.key}`;
    const potToken = token(l.currency, `${where}.currency`);
    const ticket = l.ticketCurrency ? token(l.ticketCurrency, `${where}.ticketCurrency`) : potToken;
    holdsUp(potToken, `${where}.currency`, label(l), 'lottery');
    if (ticket !== potToken) holdsUp(ticket, `${where}.ticketCurrency`, `${label(l)}’s ticket`, 'lottery');
    if (l.ticketCurrency && ticket?.wsol)
      refuse(
        'E-LOTTERY',
        `${where}.ticketCurrency`,
        'Wrapped SOL cannot be burned as a ticket token.',
        'Use SOL as the lottery currency, or use a burnable non-native ticket token.',
      );
    // Where its places are paid from (lottery.rs `PaysFrom`): a pot of its own, or each round's own money with what the
    // places leave sent to `rest`, never where a later prize could read it.
    if (keepsPot(l) && l.pot >= MAX_POTS)
      refuse(
        'E-LOTTERY',
        `${where}.pot`,
        `${label(l)} names pot ${l.pot}: a lottery keeps at most ${MAX_POTS} pots, numbered 0 to ${MAX_POTS - 1} (BadLottery).`,
        'Use pot 0, or another number below 16.',
      );
    if (!keepsPot(l) && l.rest !== undefined) {
      const rest = destination(l.rest);
      if (rest.kind === 'chosen')
        refuse(
          'E-LOTTERY',
          `${where}.rest`,
          `${label(l)} sends what its places leave to a wallet the buyer chooses: no buyer chooses a leftover (BadLottery).`,
          'Send it to "treasury", a wallet, a holder, a pool, an account, or "burn" it.',
        );
      else if (rest.kind === 'lottery' && rest.key === l.key)
        refuse(
          'E-LOTTERY',
          `${where}.rest`,
          `${label(l)} sends what its places leave into its own pot, and it keeps none (SameAccount).`,
          'To carry the leftover over to the next round, write "pot": 0 in place of "rest".',
        );
      else {
        if (['pool', 'lottery', 'farm'].includes(rest.kind))
          warn(
            'W-LOTTERY',
            `${where}.rest`,
            `${label(l)} sends what its places leave to ${rest.kind === 'pool' ? `the pool “${rest.key}”` : rest.kind === 'farm' ? 'a farm' : `the lottery “${rest.key}”`}: it lands when someone pulls it, so a prize or reward that reads ${rest.kind === 'farm' ? 'that farm' : rest.kind === 'pool' ? 'that pool' : 'that pot'} counts it only from then.`,
            'Fine for a pool you top up anyway; send it to "treasury" if a later prize must not depend on when it is pulled.',
          );
        split([{ to: l.rest, percent: 100 }], potToken, `${where}.rest`, {
          what: `${label(l)}’s leftover`,
          single: true,
        });
      }
      // A no-loss lottery that pays from its own money: every ticket goes back, so its places take no money and give
      // only their prizes.
      if (l.noLoss && (l.places ?? [100]).some(p => placeOf(p).percent > 0))
        warn(
          'W-LOTTERY',
          `${where}.places`,
          `${label(l)} gives every ticket back and pays each round from that round's own ticket money ("rest"): there is no money left for its places, so a place's percent wins nothing from it, and only its prize is won.`,
          'Give the places prizes, or keep a pot ("pot": 0) that the owner or other sales fill.',
        );
      if (Number(l.seed ?? 0) > 0)
        refuse(
          'E-LOTTERY',
          `${where}.seed`,
          `${label(l)} pays each round from that round's own ticket money: it keeps no pot to seed.`,
          'Leave "seed" out, or write "pot": 0 in place of "rest" so a seed and gifts can fill a pot.',
        );
      const percents = (l.places ?? [100]).some(p => placeOf(p).percent > 0);
      if (percents && (l.ticketNft || l.ticketCurrency) && !l.noLoss)
        warn(
          'W-LOTTERY',
          `${where}.places`,
          `${label(l)} pays each round from its own ticket money, but its tickets ${l.ticketNft ? 'cost an NFT' : 'are burned'}: no ticket money reaches its places, so their percents pay nothing and only their prizes are won.`,
          'Keep a pot ("pot": 0) that the owner or other sales fill, or give the places prizes and no percent.',
        );
    }
    if (l.ticketNft) {
      // A ticket paid with an NFT: no price, no split, no ticket token (lottery.rs BadLottery).
      if (l.price !== undefined && Number(l.price) > 0)
        refuse(
          'E-LOTTERY',
          `${where}.price`,
          `${label(l)}’s tickets cost an NFT, and a price too: a ticket costs one or the other (BadLottery).`,
          'Leave "price" out.',
        );
      if (l.ticketCurrency)
        refuse(
          'E-LOTTERY',
          `${where}.ticketCurrency`,
          `${label(l)}’s tickets cost an NFT: there is no ticket token (BadLottery).`,
          'Leave "ticketCurrency" out.',
        );
      if (lotterySplit(l).length)
        refuse(
          'E-LOTTERY',
          `${where}.split`,
          `${label(l)}’s tickets cost an NFT: there is no ticket money to split (BadLottery).`,
          'Remove the split and the cut.',
        );
      rule(l.ticketNft.rule, `${where}.ticketNft.rule`, `${label(l)}’s ticket`);
      thenCheck(l.ticketNft.then, `${where}.ticketNft.then`, label(l));
      if (!l.noLoss)
        warn(
          'W-NFT-PRICE',
          `${where}.ticketNft`,
          `${label(l)}’s tickets cost one NFT each, ${!l.ticketNft.then || l.ticketNft.then === 'burn' ? 'burned' : l.ticketNft.then.stash ? `put in “${l.ticketNft.then.stash}”` : 'given on'} once the round is drawn (the project holds it until then, and hands it back if the draw is cancelled). The pot is what the owner seeds and what its places' prizes give.`,
          Number(l.seed ?? 0) > 0 || (l.places ?? []).some(p => typeof p === 'object' && p.prize)
            ? undefined
            : 'Seed the pot ("seed"), or give its places prizes.',
        );
      else if (l.ticketNft.then)
        warn(
          'W-LOTTERY',
          `${where}.ticketNft.then`,
          `${label(l)} gives every ticket back, so each NFT paid goes back to its buyer after the draw and "then" is never used.`,
          'Leave "then" out.',
        );
    } else if (l.price === undefined || units(l.price, ticket, `${where}.price`, `${label(l)}’s ticket`) === 0n)
      warn(
        'W-LOTTERY',
        `${where}.price`,
        `${label(l)}’s tickets are free: a buyer pays only the player fee (${fromUnits(feesOf(economy).player, 9)} SOL)${limitsPlayers(l) ? '' : ', and with no "perWallet" one wallet can hold most of the tickets'}. Its pot is only what is paid into it.`,
        'Give a ticket a "price" if it should cost something, or set "perWallet".',
      );
    units(l.seed, potToken, `${where}.seed`, `${label(l)}’s seed`);
    if (l.roundRent !== undefined)
      units(l.roundRent, { decimals: 9, symbol: 'SOL' }, `${where}.roundRent`, `${label(l)}’s round rent`);
    // Its rhythm and its first draw are times the program keeps in 8 bytes.
    const every = fromNowSeconds(l.every, `${where}.every`);
    if (every <= 0 && !l.firstDraw)
      warn(
        'W-LOTTERY',
        `${where}.every`,
        `${label(l)} draws once (no "every"), and the draw is due at go-live.`,
        'Give it a "firstDraw" (like "publish+1d"), or an "every" to draw again and again.',
      );
    // A draw far off is taken, and warned of with its date: the tickets wait until then.
    const firstDraw = l.firstDraw ? timeAt(l.firstDraw, `${where}.firstDraw`) : now + every;
    farTime(
      firstDraw,
      l.firstDraw ? `${where}.firstDraw` : `${where}.every`,
      `${label(l)}’s first draw`,
      l.firstDraw ?? l.every,
      'its tickets and their money wait in it',
    );
    // Sales close this long before each draw (lottery.rs `closes_before`): never a whole rhythm or more before it.
    const closesBefore = fromNowSeconds(l.closesBefore, `${where}.closesBefore`);
    if (every > 0 && closesBefore >= every)
      refuse(
        'E-LOTTERY',
        `${where}.closesBefore`,
        `${label(l)} draws every ${l.every} and closes its sales ${l.closesBefore} before each draw: sales would never open (BadLottery).`,
        `Close sales less than ${l.every} before the draw.`,
      );
    else if (closesBefore > 0 && firstDraw - closesBefore <= now)
      warn(
        'W-LOTTERY',
        `${where}.closesBefore`,
        `${label(l)} closes its sales ${l.closesBefore} before its first draw, which is sooner than that after go-live: its first round sells no ticket (SalesClosed).`,
        'Draw later, or close sales closer to the draw.',
      );
    // Tickets weighed by the time they are held (lottery.rs `time_weighted`): a no-loss lottery only (BadLottery).
    if (l.timeWeighted && !l.noLoss)
      refuse(
        'E-LOTTERY',
        `${where}.timeWeighted`,
        `${label(l)} weighs its tickets by the time they are held, but keeps its ticket money: only a lottery that gives every ticket back may weigh them by time (BadLottery).`,
        'Make it "noLoss": true, or leave "timeWeighted" out.',
      );
    else if (l.timeWeighted)
      warn(
        'W-LOTTERY-WEIGHT',
        `${where}.timeWeighted`,
        `${label(l)} weighs a purchase by its tickets times the seconds from it to the close of sales${closesBefore ? ` (${l.closesBefore} before each draw)` : ' (at the draw: set "closesBefore" to the close you mean)'}: a ticket’s chance grows with the time it is held. Tell every buyer, on the buy screen, what their purchase weighs now and that the same tickets bought later weigh less. ${Number(l.price ?? 0) > 0 || l.ticketNft ? '' : 'Tickets are free: give it a "perWallet" limit or a gate, as any free lottery wants. '}"winners", "minSold" and "perWallet" still count tickets.`,
      );
    else if (l.noLoss && !closesBefore)
      warn(
        'W-LOTTERY',
        `${where}.closesBefore`,
        `${label(l)} gives every ticket back and sells until the draw: tickets bought seconds before it have the same chance at the pot as tickets held all period, and their price comes back.`,
        'Set "closesBefore" (sales close that long before the draw), or "timeWeighted": true so a ticket counts for the time it is held.',
      );
    // A place takes a share of the pot, a roll of a box for its winner, or both (lottery.rs Place).
    // A lottery keeps one limit on each buyer: tickets in a round, or tickets in a window of time (counter.rs; model.mjs
    // lotteryLimitOf). With both, the window would be kept and the round's cap dropped, though the spec says both.
    for (const [round, each] of [
      ['perWallet', 'perWalletEach'],
      ['perPerson', 'perPersonEach'],
    ])
      if (l[round] !== undefined && l[each] !== undefined)
        refuse(
          'E-LOTTERY',
          `${where}.${each}`,
          `${label(l)} limits each buyer to ${l[round]} tickets a round and to ${l[each].count} every ${l[each].every ?? '1h'}: a lottery keeps one of them, never both, and the program would keep only the second.`,
          `Keep "${round}" (tickets in a round) or "${each}" (tickets in a window of time).`,
        );
    // (a lottery's window is the same 4 bytes as any part's)
    perWalletWindow(l, where);
    const placed = (l.places ?? [100]).map(placeOf);
    tooMany(
      placed.length,
      LIMITS.lotteryRuns,
      'E-LOTTERY',
      `${where}.places`,
      `${label(l)} has ${placed.length} runs of places`,
      'BadLottery',
      'Put alike places into one run with "times".',
    );
    const places = placed.map((p, i) =>
      percent(p.percent, `${where}.places[${i}]${typeof (l.places ?? [])[i] === 'object' ? '.percent' : ''}`),
    );
    // The token accounts a round keeps (lottery.rs, MAX_MINTS): the pot's mint, the tickets', each minted prize's once,
    // and one for each run of places paid from a pool, two runs of one pool included.
    {
      const potKey = l.currency ?? m.currencyKey;
      const mints = new Set([potKey, l.ticketNft ? potKey : (l.ticketCurrency ?? potKey)]);
      let poolRuns = 0;
      for (const p of placed)
        if (p.prize?.gives === 'tokens')
          if (prizePool(p.prize)) poolRuns += 1;
          else mints.add(p.prize.currency ?? m.currencyKey);
      if (mints.size + poolRuns > LOTTERY_MINTS)
        refuse(
          'E-LOTTERY',
          `${where}.places`,
          `${label(l)}’s rounds would keep ${mints.size + poolRuns} token accounts (${mints.size} tokens, and one for each of its ${poolRuns} runs of places paid from a pool): the program keeps at most ${LOTTERY_MINTS} (BadLottery).`,
          'Pay alike places from one pool in one run ("times"), or pay fewer places in tokens.',
        );
    }
    // A round's header (two bits a place, a copy of its terms…) and its widest first entry are written by one
    // instruction, within 10,240 bytes (lottery.rs; plan.mjs `roundSize`).
    {
      const head = built(() => roundSize(l, m).head, where, `${label(l)}’s round`);
      const widest = head === null ? 0 : head + 6 + entryWidth(...entryShape(l));
      if (widest > LOTTERY_ROUND_GROW)
        refuse(
          'E-LOTTERY',
          `${where}.places`,
          `${label(l)}’s round header and its first entry come to ${widest.toLocaleString('en-US')} bytes, past the ${LOTTERY_ROUND_GROW.toLocaleString('en-US')} one instruction writes (BadLottery): every place adds two bits, every run of tokens 59 bytes.`,
          'Give it fewer places, or fewer runs.',
        );
    }
    for (const [i, p] of placed.entries()) {
      const raw = (l.places ?? [])[i];
      if (!places[i] && !p.prize)
        refuse(
          'E-LOTTERY',
          `${where}.places[${i}]`,
          `${label(l)}’s place ${i + 1} wins nothing: no share of the pot and no prize (BadLottery).`,
          'Give it a "percent" above 0, a "prize", or remove it.',
        );
      if (typeof raw === 'object' && raw?.prize)
        prizeCheck(raw.prize, `${where}.places[${i}].prize`, `${label(l)}’s place ${i + 1}`, 'E-LOTTERY');
      // A run holds places alike: a named NFT is one place's (a roll may repeat: each place its own roll).
      if (p.times > 1 && p.prize?.gives === 'nft')
        refuse(
          'E-LOTTERY',
          `${where}.places[${i}].times`,
          `${label(l)}’s place ${i + 1} repeats ${p.times} times a named NFT, which one place gives (BadLottery).`,
          'Give it to one place, or make it a prize places can share alike (tokens, an item, a roll, an NFT drawn from the lottery’s stash).',
        );
      // What a place of tokens from a pool gets when the pool is short (lottery.rs `WhenShort`).
      if (raw?.whenShort !== undefined && !(p.prize?.gives === 'tokens' && prizePool(p.prize)))
        warn(
          'W-LOTTERY',
          `${where}.places[${i}].whenShort`,
          `${label(l)}’s place ${i + 1} says what it gets when its pool is short, but it is not paid in tokens from a pool: "whenShort" changes nothing there.`,
          'Leave "whenShort" out.',
        );
      // A run of places given one by one (anything but tokens: a collectible, a compressed NFT, a raffled NFT) holds at
      // most MAX_RUN_PLACES places: a pull walks the run from its first place (BadLottery).
      if (p.prize && p.prize.gives !== 'tokens' && p.times > MAX_RUN_PLACES)
        refuse(
          'E-LOTTERY',
          `${where}.places[${i}].times`,
          `${label(l)}’s place ${i + 1} gives ${prizeWords(p.prize, m)} to ${p.times.toLocaleString('en-US')} places in a row: a run of places given one by one holds at most ${MAX_RUN_PLACES.toLocaleString('en-US')}, since each pull walks it from its first place (BadLottery).`,
          `Split it into runs of ${MAX_RUN_PLACES.toLocaleString('en-US')} places or fewer, one after another.`,
        );
      // A run's token prize in all, each place's amount times its places, fits a u64 (BadLottery).
      const t = p.prize?.amount !== undefined ? prizeToken(p.prize, m) : null;
      let each = 0n;
      try {
        each = t ? toUnits(p.prize.amount, t.decimals ?? 0) : 0n;
      } catch (error) {
        // An amount that doesn't read is refused where the prize is checked.
        if (!(error instanceof SpecError)) throw error;
      }
      if (each * BigInt(p.times ?? 1) > U64_MAX)
        refuse(
          'E-LOTTERY',
          `${where}.places[${i}].times`,
          `${label(l)}’s place ${i + 1} gives ${p.prize.amount} ${p.times} times: more tokens in all than the program can count (BadLottery).`,
          'Fewer places in the run, or a smaller prize.',
        );
    }
    // A raffle of many NFTs: its places draw from the lottery's own stash, which holds at least as many; it draws once,
    // and never also names NFTs of it (lottery.rs).
    const raffled = placed.filter(p => p.prize?.gives === 'raffled').reduce((n, p) => n + p.times, 0);
    if (raffled && l.every)
      refuse(
        'E-LOTTERY',
        `${where}.every`,
        `${label(l)} draws NFTs from its own stash, so it draws once (BadLottery).`,
        'Leave "every" out.',
      );
    if (raffled && placed.some(p => p.prize?.held))
      refuse(
        'E-LOTTERY',
        `${where}.places`,
        `${label(l)} both names NFTs of its own stash and draws from it: a draw could take a named one (BadLottery).`,
        'Raffle them all at random, or name each one.',
      );
    if (raffled > (l.nfts ?? []).length)
      refuse(
        'E-LOTTERY',
        `${where}.nfts`,
        `${label(l)} draws ${raffled} NFTs from its own stash, which holds ${(l.nfts ?? []).length} (NotInStash).`,
        'List at least as many in "nfts".',
      );
    // A raffle's NFT: one place each, and a lottery that holds one draws once (lottery.rs).
    const held = placed.map(p => (p.prize?.held ? p.prize.nft : null)).filter(Boolean);
    if (held.length && l.every)
      refuse(
        'E-LOTTERY',
        `${where}.every`,
        `${label(l)} holds an NFT as a prize, so it draws once: a next round would sell a prize already won (BadLottery).`,
        'Leave "every" out.',
      );
    if (new Set(held).size < held.length)
      refuse(
        'E-LOTTERY',
        `${where}.places`,
        `${label(l)} gives the same NFT on two places: the second could never be given (BadLottery).`,
        'Name each NFT once.',
      );
    // The places from its own stash, raffled or named, are what its draw's answer loads (lottery.rs `MOST_OWN`).
    if (raffled + held.length > LIMITS.ownStashPlaces)
      refuse(
        'E-LOTTERY',
        `${where}.places`,
        `${label(l)} has ${raffled + held.length} places from its own stash: a raffle has at most ${LIMITS.ownStashPlaces}, the most the oracle’s answer loads on the chain’s default memory (BadLottery).`,
        `Raffle at most ${LIMITS.ownStashPlaces} NFTs a lottery: run a second lottery for the rest.`,
      );
    // Every run paying from one pool says the same about a short pool (lottery.rs, BadLottery), and the project hears
    // what its setting does.
    const byPool = new Map();
    for (const [i, p] of placed.entries()) {
      const key = p.prize?.gives === 'tokens' ? prizePool(p.prize) : null;
      if (!key) continue;
      byPool.set(key, [...(byPool.get(key) ?? []), [i, p.whenShort ?? 'inOrder']]);
    }
    for (const [key, runs] of byPool) {
      const said = [...new Set(runs.map(([, w]) => w))];
      if (said.length > 1)
        refuse(
          'E-LOTTERY',
          `${where}.places`,
          `${label(l)}’s places paid from the pool “${key}” say different things about a short pool (${said.join(', ')}): every run paying from one pool must say the same (BadLottery).`,
          `Give each place paid from “${key}” the same "whenShort".`,
        );
      else
        warn(
          'W-LOTTERY-POOL',
          `${where}.places`,
          `${label(l)}’s places paid from the pool “${key}” read it once, when the draw is asked, and the project can spend the pool until then. When it holds less than the places with a winner win, each place gets what "whenShort" says, here ${said[0] === 'inProportion' ? '"inProportion": each place a share in proportion to its prize' : said[0] === 'nothing' ? '"nothing": no place of that pool gets anything' : '"inOrder" (the default): the first places in full, the rest what is left'}. Prizes of 1,000, 500 and 500 from a pool holding 1,700 give 1,000, 500 and 0 in order, 850, 425 and 425 in proportion, or nothing.`,
          'Keep the pool stocked for every place before the draw, or pay from the lottery’s own pot.',
        );
    }
    // A named NFT of a stash the project holds: the first winner whose prize is pulled gets it.
    const named = placed.filter(p => p.prize?.gives === 'nft' && !p.prize.held);
    const nftNames = named.map(p => p.prize.nft);
    if (named.length && (every > 0 || new Set(nftNames).size < nftNames.length))
      warn(
        'W-LOTTERY',
        `${where}.places`,
        `${label(l)} ${every > 0 ? 'draws again and again and names' : 'names'} ${new Set(nftNames).size < nftNames.length ? 'one NFT of a stash for several places' : 'NFTs of a stash as prizes'}: the first winner whose prize is pulled gets the NFT, and later winners get nothing.`,
        'Raffle NFTs from the lottery’s own stash ("raffled", or "raffle"), or give each place its own NFT in a lottery that draws once.',
      );
    if (l.ticketNft?.rule?.oneOf && l.ticketNft.rule.oneOf.length > LIMITS.ticketOneOf)
      refuse(
        'E-LOTTERY',
        `${where}.ticketNft.rule.oneOf`,
        `${label(l)}’s NFT ticket rule lists ${l.ticketNft.rule.oneOf.length} "one of" texts: the oracle’s answer reads the rule, and holds at most ${LIMITS.ticketOneOf} (BadLottery).`,
        `List at most ${LIMITS.ticketOneOf}, or test a number ("atLeast") instead.`,
      );
    if (l.ticketNft?.rule?.items && l.ticketNft.rule.items.length > LIMITS.ticketOneOf)
      refuse(
        'E-LOTTERY',
        `${where}.ticketNft.rule.items`,
        `${label(l)}’s NFT ticket rule names ${l.ticketNft.rule.items.length} items: the oracle’s answer reads the rule, and holds at most ${LIMITS.ticketOneOf} (BadLottery).`,
        `Name at most ${LIMITS.ticketOneOf}.`,
      );
    if (held.length)
      warn(
        'W-RAFFLE',
        `${where}.places`,
        `${label(l)} holds ${held.length === 1 ? 'its NFT' : 'its NFTs'} in its own stash: nobody, the owner included, can take ${held.length === 1 ? 'it' : 'them'} out while a place names ${held.length === 1 ? 'it' : 'them'}, and the winner pulls ${held.length === 1 ? 'it' : 'them'} after the draw, in any order with the money. If the NFT's collection lets someone freeze or move it (a permanent freeze, transfer or burn delegate), they could stop the prize: anyone may then make it a hold for its winner, so the rest of the round pays out.`,
      );
    // (a least sale against how many wallets and players it takes: W-ASSUMPTION, challenge.mjs)
    const total = places.reduce((a, b, i) => a + b * placed[i].times, 0);
    if (total > 10_000)
      refuse(
        'E-LOTTERY',
        `${where}.places`,
        `${label(l)}’s places add up to ${total / 100}% of the pot, more than all of it.`,
        'Make them add up to 100% or less.',
      );
    else if (total < 10_000 && !(l.noLoss && !keepsPot(l)))
      warn(
        'W-LOTTERY',
        `${where}.places`,
        keepsPot(l)
          ? `${label(l)}’s places add up to ${total / 100}%: the other ${(10_000 - total) / 100}% of each pot stays in it for the next round, as do places nobody won.`
          : `${label(l)}’s places add up to ${total / 100}%: the other ${(10_000 - total) / 100}% of each round's ticket money, and the part of places nobody won, goes to “${l.rest}”${l.rest === 'burn' ? ' (burned when the round closes)' : ''}.`,
      );
    const ticketSplit = lotterySplit(l);
    if (ticketSplit.length && l.ticketCurrency)
      refuse(
        'E-LOTTERY',
        `${where}.split`,
        `${label(l)}’s tickets are burned, so there is no ticket money to split.`,
        'Remove the split and the cut.',
      );
    split(ticketSplit, potToken, `${where}.split`, { what: `${label(l)}’s ticket money`, chosen: true });
    // No share pays into a pot of its own lottery (lottery.rs: its 16 pots are refused as destinations, SameAccount).
    for (const [i, share] of (l.split ?? []).entries())
      if (destination(share.to).kind === 'lottery' && destination(share.to).key === l.key)
        refuse(
          'E-LOTTERY',
          `${where}.split[${i}]`,
          `${label(l)} sends a share of its ticket money into its own pot: the program refuses a share into any pot of the lottery it is paid from (SameAccount).`,
          keepsPot(l)
            ? 'Leave the share out: what the split doesn’t take goes into the pot already.'
            : 'Keep a pot instead ("pot": 0), or send the share elsewhere.',
        );
    if (ticket?.wsol && l.ticketCurrency)
      refuse(
        'E-WSOL-BURN',
        `${where}.ticketCurrency`,
        `${label(l)}’s tickets are burned, and wrapped SOL cannot be burned.`,
        'Sell tickets into the pot instead (no ticketCurrency).',
      );
    // No loss (lottery.rs `returns`): every ticket goes back whole after the draw, so nothing of it can be split or burned.
    if (l.noLoss) {
      if (ticketSplit.length)
        refuse(
          'E-LOTTERY',
          `${where}.split`,
          `${label(l)} gives every ticket back to its buyer after the draw, so no part of the ticket money can go anywhere else (BadLottery).`,
          'Remove the split and the cut, or make it a lottery that keeps its tickets (no "noLoss").',
        );
      if (l.ticketCurrency)
        refuse(
          'E-LOTTERY',
          `${where}.ticketCurrency`,
          `${label(l)} gives every ticket back, and tickets in "ticketCurrency" are burned: a ticket can’t be both (BadLottery).`,
          'Leave "ticketCurrency" out: tickets are paid in the pot’s currency and come back.',
        );
      if (!lotteryPotFilled(l))
        warn(
          'W-LOTTERY',
          where,
          `${label(l)} gives every ticket back, so its pot holds only what is paid into it, and nothing is: its winners would win nothing.`,
          `Seed the pot ("seed"), send it a share of a sale or payment ("lottery:${l.key}" in a split, or a schedule that pays "to": "lottery:${l.key}"), or give its places prizes.`,
        );
      else
        warn(
          'W-LOTTERY',
          where,
          `${label(l)} loses nobody their tickets: every ticket goes back to its buyer once the round is drawn (anyone can finish each purchase), and the winners take only the pot, what is paid into it (the seed, a sponsor, a share of other sales). Ticket money waits in the lottery’s own vault until then.${l.timeWeighted ? '' : ` Tickets are not weighted by how long they were held: someone may buy most of a round’s tickets ${closesBefore ? `just before sales close (${l.closesBefore} before the draw)` : 'right before the draw'} and risk only the fees.`}`,
          l.timeWeighted
            ? undefined
            : 'Weigh tickets by the time they are held ("timeWeighted": true), close sales a while before the draw ("closesBefore"), keep the pot small next to what a late buyer would put in, or gate it (a stake, a list).',
        );
    }
    rule(l.gate, `${where}.gate`, label(l));
    c.chance = true;
  }
}
