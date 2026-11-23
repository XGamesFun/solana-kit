// Schedules and lotteries: a schedule's run, a lottery's tickets, its draw, and the prizes pulled.
import { NO_ADDRESS } from '../../chain/base58.js';
import { encodeInstruction } from '../../chain/borsh.js';
import { toBigInt } from '../../chain/bytes.js';
import { ASSOCIATED_TOKEN_PROGRAM } from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import IDL from '../idl/loot.js';
import {
  chosenAtPurchase,
  leftoverTo,
  nftSlot,
  ownStash,
  paymentMint,
  placesIn,
  placesPulled,
  potIdOf,
  prizePlacesOwed,
  roundFinished,
  roundWinners,
  tokenRun,
} from '../accounts.js';
import { stream, TAG, weighted } from '../random.js';
import { ata, lootProgram, pda } from '../pda.js';
import { ONLY_MOVES, pieceMetas, tokenProgramOf, treasuryAccounts } from './shared.js';
import { lootIx, tailOf } from './base.js';
import {
  chosenShares,
  destinationAccounts,
  gateAccounts,
  limitAccounts,
  prizeMetas,
  prizeRollNonce,
  shareAccounts,
  shownFor,
} from './tail.js';
import { piece, spentTo } from './piece.js';

// ---------------------------------------------------------------- schedules and lotteries

/**
 * The project's keys or who it pays (`payer`; a sealed burn: anyone) run a schedule that is due, and open the account it
 * pays into when that is not there. A run missed is missed: it pays once, for the latest run due, and the runs before it
 * lapse; only a sealed schedule's fixed amount pays every run due, up to `upto` runs made (`scheduleCatchesUp`).
 * `poolMint`: the mint of the pool it moves from (when it moves from one). `extra`: a hook's or a memo's accounts.
 */
export function runScheduleIx({
  payer,
  project,
  id,
  schedule,
  poolMint,
  holders,
  programs,
  treasury,
  upto = 0,
  extra = [],
}) {
  const { from, to } = schedule.action;
  const address = pda.schedule(project, id);
  // A sealed schedule pays from its own vault (`pda.vest`), passed where a pool would be.
  const mint = from.Mint?.[0] ?? from.Vest?.[0] ?? poolMint;
  const writes = Boolean(from.Mint) || to === 'Burn';
  const pool = from.Pool ? pda.pool(project, from.Pool[0]) : from.Vest ? pda.vest(address) : null;
  // `upto` (the runs it has plus those due, `runsDue`; 0: no bound) has an effect only on what pays every run due.
  return lootIx(
    'run_schedule',
    { upto },
    { payer, project, schedule: address, pool, mint },
    {
      remaining: [...destinationAccounts(project, to, mint, { holders, programs, treasury }), ...tailOf(extra)],
      writable: writes ? ['mint'] : [],
    },
  );
}

// A lottery's rounds (`accounts.js`: `decodeRound`, `partsOwed`, `commonOwed`): each round is a record of its own, opened
// by its first purchase. Its ask (`draw_lottery`) fixes its money and moves the lottery on; after the answer, `pull`
// pays one part at a time, in any order, and the pull that leaves nothing owed closes it. Every builder takes the
// decoded records it acts on, so each is pure.

/** The address of a lottery's current round's record (there or not), from its decoded Lottery. */
export const currentRound = (lotteryAddress, lottery) => pda.round(lotteryAddress, lottery.incarnation, lottery.round);

/**
 * `player` buys `count` tickets of lottery `id`'s current round (`lottery` decoded; `round` its decoded record, null when
 * nobody bought into it yet: then this purchase opens it, and the lottery's spare SOL pays its rent, or the buyer fronts
 * it, back at the close). It buys only at the revision the round copied (`TermsChanged` otherwise), and its round's
 * address names the lottery's incarnation and round (a purchase that lands as the round moves on fails, and is sent
 * again). A share the buyer chooses is paid now, out of the price, from the buyer's own account: to the wallet they name
 * (`chosenRecipient`), the holder of the collectible `chosen` (its holder in `holders`), or with no choice the project's
 * `treasury` wallet. A lottery whose ticket costs an NFT sells one at a time, for `nft` ({ asset, collection,
 * tokenMetadata, compressed }, as `piece` takes it).
 */
export function buyTicketsIx({
  player,
  project,
  id,
  lottery,
  round = null,
  mint,
  count,
  shown,
  listProof,
  chosenRecipient = null,
  chosen = null,
  nft,
  holders = {},
  treasury,
  playerToken,
  programs,
  extra = [],
  person = null,
}) {
  const address = pda.lottery(project, id);
  const key = currentRound(address, lottery);
  // The terms the round copied, or for its first purchase the lottery's.
  const terms = round ? round.terms : lottery.terms;
  mint ??= paymentMint(terms);
  const paying = !terms.nft_ticket && BigInt(terms.price) > 0n;
  const choices = paying ? chosenShares(terms.shares.filter(chosenAtPurchase), chosenRecipient) : [];
  const recipients = shareAccounts(project, choices, mint, { holders, programs, treasury });
  const held = terms.nft_ticket ? piece({ project, wallet: player, ...nft, ...ONLY_MOVES, reads: true }) : null;
  return lootIx(
    'buy_tickets',
    { count, chosen_recipient: chosenRecipient, revision: round ? round.revision : lottery.revision },
    {
      player,
      project,
      lottery: address,
      round: key,
      player_token: playerToken ?? ata(player, mint, tokenProgramOf(programs, mint)),
      payment_vault: pda.roundTokens(key, mint),
      mint,
      chosen,
      ...limitAccounts(project, player, lottery.per_wallet, person),
      associated_token_program: choices.length ? ASSOCIATED_TOKEN_PROGRAM : null,
    },
    {
      remaining: [
        ...gateAccounts(project, {
          gate: lottery.gate,
          wallet: player,
          shown: shownFor(project, lottery.gate, player, shown),
          listProof,
        }),
        ...recipients,
        ...(held ? [...pieceMetas(held), ...held.proof] : []),
        ...tailOf(extra),
      ],
    },
  );
}

/**
 * Anyone asks for the draw of a lottery's round once it is due (`lottery` decoded). `round`: the decoded record of the
 * round asked for (null when nobody bought into the current one: it moves on, or a lottery that draws once ends, with
 * no ask), and `roundAddress` its address when it is not the current round's (an older round still waiting for its
 * answer: asked again after `STALE_SECONDS`, or after the timeout cancelled, with no lottery account, so `lottery` may be
 * null then; without `round`, the current round's, with the lottery's terms). A round's first ask fixes its money. Paid
 * from a pot, it takes the pot, its mint and the round's account of it, then, when the lottery names a round that may
 * still owe a pot (`lottery.owing`), that round, its account of the mint and its pot (`owing`: that round's decoded
 * record, whose terms name its pot; without it, or when the record is gone, the pot this round pays from). A round paid
 * from its own money takes none of these. Then each run of token prizes in place order, its mint and for a pool, the
 * pool and the round's account of the mint (`poolMints`: a pool's index to its mint). With `skipHooked` (the project's
 * authority only) a hooked pool or pot gives the round nothing. `extra`: hook accounts.
 */
export function drawLotteryIx({
  payer,
  project,
  id,
  lottery,
  round = null,
  roundAddress = null,
  owing = null,
  skipHooked = false,
  poolMints = {},
  extra = [],
}) {
  const address = id === undefined || id === null ? null : pda.lottery(project, id);
  const key = roundAddress ?? currentRound(address, lottery);
  const rest = [];
  // A round with no record moves on and a round asked before is asked again, reading none of these: they are passed
  // unless the round is known to have been asked.
  const current = !round || round.status === 'Open';
  if (current) {
    const { terms } = round ?? lottery;
    const potId = potIdOf(terms);
    if (potId != null) {
      rest.push(
        meta(pda.lotteryPot(address, potId), false, true),
        meta(terms.mint, false, false),
        meta(pda.roundTokens(key, terms.mint), false, true),
      );
      // What the round before left its pot moves in first: that round, its account of the mint, and its pot.
      const earlier = lottery?.owing;
      if (earlier && earlier !== NO_ADDRESS) {
        const earlierPot = potIdOf(owing?.terms) ?? potId;
        rest.push(
          meta(earlier, false, true),
          meta(pda.roundTokens(earlier, terms.mint), false, true),
          meta(pda.lotteryPot(address, earlierPot), false, true),
        );
      }
    }
    for (const place of terms.places) {
      const from = place.prize?.Tokens?.from;
      if (from?.Mint) rest.push(meta(from.Mint[0], false, false));
      else if (from?.Pool) {
        const mint = poolMints[from.Pool[0]];
        if (!mint)
          throw new Error(
            `The ask of a round whose place gives tokens from pool ${from.Pool[0]} needs that pool's mint (poolMints).`,
          );
        rest.push(
          meta(mint, false, false),
          meta(pda.pool(project, from.Pool[0]), false, true),
          meta(pda.roundTokens(key, mint), false, true),
        );
      }
    }
  }
  // The lottery goes with its current round only: a round whose draw waits is asked again or cancelled without it, so a
  // lottery closed since never strands it.
  return lootIx(
    'draw_lottery',
    { skip_hooked: skipHooked },
    { payer, project, lottery: current ? address : null, round: key },
    { remaining: [...rest, ...tailOf(extra)] },
  );
}

/** The oracle's answer to a round's draw (for a local simulation): the round's record is its only account. */
export const callbackLotteryIx = ({ round, randomness }) => ({
  programId: lootProgram(),
  keys: [meta(pda.oracleIdentity(), true, false), meta(round, false, true)],
  data: encodeInstruction(IDL, 'callback_lottery', { randomness: Uint8Array.from(randomness) }),
});

/** The accounts a round's close takes after a pull's own: each of its token accounts, its mint and who opened it (the
 * lottery, which gets its spare back, or a buyer who fronted it; `owner` for one the lottery opened, once it is closed). */
export const roundCloseMetas = (key, r, owner = null) =>
  r.accounts
    .filter(o => o.mint !== NO_ADDRESS)
    .flatMap(o => [
      meta(pda.roundTokens(key, o.mint), false, true),
      meta(o.mint, false, true),
      meta(owner && o.by === r.lottery ? owner : o.by, false, true),
    ]);

/** The NFT a raffle's place draws from the lottery's own stash (`stash` decoded, as it is now) with the round's answer. */
export const raffledNft = (stash, answer, place) =>
  stash?.nfts[weighted(stream(answer, [TAG.LOTTERY, place]), stash.weights)] ?? null;

/**
 * The NFT of the lottery's own stash each place of a drawn round that holds or draws one gets, in place order, as the
 * pulls take them out (`LotteryRound::assign`): the ones already taken out (`r.nfts`), then the rest as the stash
 * (`stash`, decoded as it is now) gives them, a named one found or one drawn by weight with the round's answer, each
 * taken out before the next. null for a place whose NFT isn't there (it gets nothing).
 */
export function stashNfts(r, stash) {
  const nfts = r.nfts.map((n, k) => (k < Number(r.assigned) ? (n === NO_ADDRESS ? null : n) : undefined));
  const rows = { nfts: [...(stash?.nfts ?? [])], weights: [...(stash?.weights ?? [])] };
  const take = row => {
    if (row == null || row < 0) return null;
    const nft = rows.nfts[row];
    const last = rows.nfts.length - 1;
    [rows.nfts[row], rows.weights[row]] = [rows.nfts[last], rows.weights[last]];
    rows.nfts.pop();
    rows.weights.pop();
    return nft;
  };
  const w = roundWinners(r);
  let [k, first] = [0, 0];
  for (const p of r.terms.places) {
    const times = Number(p.times);
    if (ownStash(p)) {
      for (let place = first; place < first + times && place < w; place++, k++) {
        if (nfts[k] !== undefined) continue;
        nfts[k] = p.prize?.Held
          ? take(rows.nfts.indexOf(p.prize.Held[0]))
          : take(weighted(stream(r.answer, [TAG.LOTTERY, place]), rows.weights));
      }
      k += Math.max(0, first + times - Math.max(first, w));
    }
    first += times;
  }
  return nfts.map(n => n ?? null);
}

/** The most of the lottery's own stash's NFTs one pull takes out for its places (`ASSIGN_DRAWS`), counted in draws: a
 * named NFT's search counts one, and one more for each `ASSIGN_ROWS_A_DRAW` rows of the stash. A pull after carries on. */
export const ASSIGN_DRAWS = 64;
export const ASSIGN_ROWS_A_DRAW = 1_000;

/**
 * How many of a drawn round's places that win an NFT of the lottery's own stash have theirs out of the stash after one
 * more pull for a place up to `upto` (`LotteryRound::assign`): `r.assigned`, plus as many as one pull takes, in place
 * order. `stash` is the lottery's own stash, decoded as it is now (its rows count for a named NFT's search). A pull
 * stops at a place whose NFT is not out yet, so it carries accounts only for places below this.
 */
export function pullAssigns(r, stash, upto) {
  const rows = BigInt(stash?.nfts?.length ?? 0);
  const end = Math.min(roundWinners(r), Number(upto) + 1);
  let [k, first, work, assigned] = [0, 0, 0n, Number(r.assigned)];
  for (const p of r.terms.places) {
    const times = Number(p.times);
    const run = [first, first + times];
    first += times;
    if (!ownStash(p)) continue;
    for (let place = run[0]; place < run[1]; place++, k++) {
      if (place >= end) return assigned;
      if (k !== assigned) continue;
      const cost = p.prize?.Held ? 1n + rows / BigInt(ASSIGN_ROWS_A_DRAW) : 1n;
      if (work > 0n && work + cost > BigInt(ASSIGN_DRAWS)) return assigned;
      work += cost;
      assigned += 1;
    }
  }
  return assigned;
}

/**
 * Anyone (`payer`) pulls `part` of the round at `roundAddress` (`round` decoded; `partsOwed` and `commonOwed` say what is
 * owed):
 *   'Own'            entry `entry`'s own part: a refund, a no-loss ticket's price, or its NFT ticket back or where its
 *                    price sends it (`ticket` its kind as `piece` takes it; `handBack` when the wallet its price gives
 *                    it to is an account of the loot program; `hold`: made a hold for whoever it is owed to instead);
 *   { Pot: [run] }   the entry's places in the run, their part of what the round pays from, paid into the buyer's account;
 *   { Prize: [run] } their prize: tokens into the buyer's account, or each place's prize (`prize`: { stash, the lottery's
 *                    own stash decoded, for NFTs not taken out yet (`stashNfts`); stashes, a project stash's id to its
 *                    decoded stash; nfts, an NFT's kind by its asset; hold, NFTs made holds; most, the most places a
 *                    pull carries; and what `prizeMetas` takes: collection, poolMints, items, projectMint }), a roll's
 *                    order at `prizeRollNonce(nonce + place)` (ask it in the same transaction: `pullRolls`);
 *   { Common: [i] }  a part owed in common: share `i`, what the places leave (`i` = the shares' count: to the pot, or
 *                    to `rest` for a round paid from its own money; never owed when that burns), a pool's prize back after a
 *                    cancel (past it), paid where it goes (`holders`, `programs`); `toTreasury` when that can't take it
 *                    (a pool never opened, the pot closed since or made again in another mint, an account gone: a
 *                    holder nobody is is found here).
 * The pull that leaves nothing owed closes the round (`projectState`: its treasury and owner). While the lottery is
 * there, the close names it for the rent it lent; once it is gone (`lotteryClosed`), that rent goes to the project's
 * owner, and only the owner's own closing pull may send it: anyone else's leaves the close off and the round waits. A
 * round that owes nothing and waits only for its close is closed by any pull. A place's prize that is not tokens is
 * given as far as `prize.most` places a pull (a run of rolls: two accounts a place; size it from a dry run), and the
 * lottery's own stash's NFTs as far as one pull takes them out (`pullAssigns`): a pull that stops short carries no
 * close, and the next carries on. Every pull of one entry's places names the same `nonce`: a place's roll is made at
 * `prizeRollNonce(nonce + place)`, so a later pull with another nonce can land on an order an earlier pull made and fail
 * ("already in use"). js/play names `prizeNonce(round, entry)` for every pull of an entry, whoever sends it.
 * An NFT ticket proven gone from the project (`ticket`, as `piece` takes it) goes nowhere: its part settles and
 * nothing moves (`LotteryPulled` with amount 0 beside `NftGone`).
 */
export function pullIx({
  payer,
  project,
  roundAddress: key,
  round: r,
  entry = 0,
  part = 'Own',
  projectState,
  ticket = {},
  handBack = false,
  hold = false,
  nonce = 0n,
  prize = {},
  holders = {},
  toTreasury = false,
  lotteryClosed = false,
  programs,
  extra = [],
}) {
  const rest = [];
  let [mint, to, settled, buyer, partial] = [null, null, 1, payer, false];
  const account = (m, wallet) => ata(wallet, m, tokenProgramOf(programs, m));
  const finished = roundFinished(r);
  const e = part.Common || finished ? null : r.entries[entry];
  if (e) buyer = e.buyer;
  if (finished) settled = 0;
  else if (part === 'Own' && e.nft !== NO_ADDRESS) {
    const back = r.status === 'Cancelled' || r.terms.returns;
    const then = back ? null : r.terms.nft_ticket?.then;
    if (hold) {
      rest.push(meta(pda.hold(e.nft, 0), false, true));
      if (then?.Give) rest.push(meta(then.Give[0], false, true));
    } else {
      // Where its price sends it (a stash keeps it where it is), or back to its buyer.
      const receiver = then ? spentTo(project, then) : null;
      const holder = then?.Stash || (handBack && then?.Give) ? e.buyer : (receiver ?? e.buyer);
      const p = piece({
        project,
        asset: e.nft,
        wallet: holder,
        ...ticket,
        moves: !then?.Stash,
        locks: false,
        burns: then === 'Burn' || Boolean(then?.Burn),
        reads: false,
      });
      rest.push(...pieceMetas(p), ...p.proof, ...(receiver ? [meta(receiver, false, true)] : []));
    }
  } else if (part === 'Own') [mint, to] = [paymentMint(r.terms), account(paymentMint(r.terms), e.buyer)];
  else if (part.Common) {
    const i = Number(part.Common[0]);
    const n = r.terms.shares.length;
    let dest;
    if (i < n) [mint, dest] = [paymentMint(r.terms), r.terms.shares[i].to];
    else if (i === n) [mint, dest] = [r.terms.mint, leftoverTo(r.lottery, r.terms)];
    else {
      const p = r.prizes[i - n - 1];
      [mint, dest] = [p.mint, r.terms.places[Number(p.run)].prize.Tokens.from];
    }
    rest.push(...destinationAccounts(project, dest, mint, { holders, programs, treasury: projectState?.treasury }));
    const nobody = dest.Holder && !holders[dest.Holder[0]];
    if (toTreasury || nobody) rest.push(...treasuryAccounts(projectState?.treasury, mint, programs));
  } else if (part.Pot || tokenRun(r, Number(part.Prize[0]))) {
    const run = Number((part.Pot ?? part.Prize)[0]);
    const p = part.Prize ? r.prizes.find(x => Number(x.run) === run) : null;
    mint = p ? p.mint : r.terms.mint;
    to = account(mint, e.buyer);
    settled = placesPulled(r, entry, run, Boolean(part.Prize));
  } else {
    // Each of the entry's places in the run whose prize is not given yet, lowest first.
    const run = Number(part.Prize[0]);
    const given = r.terms.places[run].prize;
    const places = prizePlacesOwed(r, entry, run);
    const own = ownStash(r.terms.places[run]);
    const nfts = own ? stashNfts(r, prize.stash) : [];
    // A pull takes out at most `ASSIGN_DRAWS` of the stash's NFTs, up to the entry's last place in the run, and stops at
    // a place whose NFT is not out yet: accounts only for the places out after it (`pullAssigns`).
    const out = own
      ? pullAssigns(r, prize.stash, placesIn(r, run, r.entries[entry].start, r.entries[entry].end).at(-1) ?? 0)
      : 0;
    if (own) rest.push(meta(pda.lotteryStash(r.lottery), false, true));
    const handed = asset =>
      prize.hold
        ? [meta(pda.hold(asset, 0), false, true)]
        : (() => {
            const p = piece({ project, asset, wallet: e.buyer, ...(prize.nfts?.[asset] ?? {}), ...ONLY_MOVES });
            return [...pieceMetas(p), ...p.proof];
          })();
    let [carried, made, stashed] = [0, 0, false];
    for (const place of places) {
      if (own && nftSlot(r, place) >= out) {
        partial = true;
        break;
      }
      if (own && nfts[nftSlot(r, place)] == null) continue;
      if (prize.most != null && carried >= prize.most) {
        partial = true;
        break;
      }
      carried += 1;
      if (own) rest.push(...handed(nfts[nftSlot(r, place)]));
      else if (given.Nft) {
        // A project stash's NFT, while the stash holds it: its stash, then the NFT (once: one place takes it).
        const { stash, nft: asset } = given.Nft;
        const holds = prize.stashes?.[stash] ? prize.stashes[stash].nfts.includes(asset) : true;
        rest.push(meta(pda.stash(project, stash), false, true));
        if (holds && !stashed) rest.push(...handed(asset));
        stashed ||= holds;
      } else {
        rest.push(
          ...prizeMetas({
            project,
            collection: prize.collection,
            prize: given,
            winner: e.buyer,
            nonce: BigInt.asUintN(64, toBigInt(nonce) + BigInt(place)),
            poolMints: prize.poolMints,
            items: prize.items,
            nft: prize.nfts?.[given.Item?.[0]],
            made,
            projectMint: prize.projectMint,
            programs,
          }),
        );
        if (given.Item) made += 1;
      }
    }
    settled = places.length;
  }
  // Rent the lottery lent goes back to it, or once it is closed, to the project's owner, and only when the owner sends
  // the close: anyone else's closing pull of such a round leaves the close off, and the round waits for the owner.
  const lent = r.opener === r.lottery || r.accounts.some(o => o.mint !== NO_ADDRESS && o.by === r.lottery);
  const waitsForOwner = lotteryClosed && lent && payer !== projectState?.owner;
  const closes =
    !waitsForOwner &&
    (finished || (!partial && (r.status === 'Drawn' || r.status === 'Cancelled') && Number(r.owed) <= settled));
  const owner = lotteryClosed ? projectState?.owner : null;
  if (closes) rest.push(...roundCloseMetas(key, r, owner));
  const opener = owner && r.opener === r.lottery ? owner : r.opener;
  return lootIx(
    'pull',
    { entry: part.Common || finished ? 0 : entry, part, nonce: toBigInt(nonce) },
    {
      payer,
      project,
      round: key,
      buyer,
      mint,
      vault: mint ? pda.roundTokens(key, mint) : null,
      to,
      opener: closes ? opener : null,
      treasury: closes ? projectState?.treasury : null,
    },
    { remaining: [...rest, ...tailOf(extra)] },
  );
}

/** The orders the rolls a `{ Prize: [run] }` pull of entry `entry` makes (a place's prize that is a roll), each with its
 * box: [{ order, box }], at `prizeRollNonce(nonce + place)` for the entry's buyer, the first `most` of its places owed
 * when the pull carries no more (`pullIx`'s `prize.most`). Ask each in the pull's transaction. Every pull of one entry's
 * places names the same `nonce` (a different one can land on an order an earlier pull made, "already in use"): js/play
 * names `prizeNonce(round, entry)` for all of them. */
export function pullRolls({ project, round: r, entry, part, nonce = 0n, most = null }) {
  const run = Number(part?.Prize?.[0] ?? -1);
  const given = r.terms.places[run]?.prize;
  if (!given?.Roll) return [];
  const buyer = r.entries[entry].buyer;
  const places = prizePlacesOwed(r, entry, run);
  return (most == null ? places : places.slice(0, most)).map(place => ({
    order: pda.order(project, buyer, prizeRollNonce(BigInt.asUintN(64, toBigInt(nonce) + BigInt(place)))),
    box: given.Roll[0],
  }));
}
