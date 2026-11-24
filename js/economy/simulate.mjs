// The quick simulation: expected values from the spec alone, instant. What each box, ticket and craft is worth
// against its price, the house edge, each pool's money in and out per day and how long it lasts, and who pays what:
// players, the owner, the platform's fees. Amounts are in whole units of their token. Pure.
//
// It assumes the scenario's counts (`scenario.perDay`, default 100 of each player action a day) arrive evenly,
// odds as written (stock odds start where the table starts), and one ticket per lottery purchase. Shares of a
// pool (a schedule's, a decision's) are worked out continuously, so a pool that pays a share of itself settles at a level
// instead of emptying. A prize is a fixed amount, all of it or none. Money is counted per day while a box sells; when
// its items, stashes or named NFTs run out (its own opens alone), a box that stops selling (`whenOut` "stopSales") says
// the day it stops, and one that draws among what is left ("drawLeft") the day each outcome runs out and the odds of
// the rest from then (`stockWalk`). It is a guide, not a promise: the full simulation (js/sim) runs the real program.
import { SIGNATURE_LAMPORTS } from '../chain/tx.js';
import { entryWidth, LIMIT_RECORD_BYTES, ROUND_RECORD_BYTES } from '../client/index.js';
import { asWritten, numeral, percentage, sol } from './format.mjs';
import { boxOrderBytes, entryShape, roundRentOf } from './plan.mjs';
import {
  DAY,
  byPerson,
  boostedWeights,
  boxBuys,
  COLLECTIBLE_RENT as COLLECTIBLE_RENT_LAMPORTS,
  drawsOf,
  settleRentUnits,
  holdsRent,
  outcomeParts,
  SETTLE_RENT_UNIT,
  ORACLE_FEE,
  RENT_PER_BYTE,
  destination,
  listOf,
  keepsPot,
  lotterySplit,
  model,
  placeOf,
  prizeLine,
  prizePool,
  prizeToken,
  farmEndWords,
  lateRunWords,
  prizeWords,
  releaseWords,
  sharesOf,
  SpecError,
  toBps,
  toSeconds,
  toTime,
  purchaseWeight,
  shortPays,
  stashNfts,
  stopsSales,
  toUnits,
  weights,
  whenOutWords,
} from './model.mjs';

export const DEFAULT_PER_DAY = 100;
/** How many wallets the simulation's crowd is, next to one: what a person with many wallets could take from a grant. */
const MANY_WALLETS = 100;
/** Bids a day on an auction the scenario doesn't name (`auction:<key>`); a grant it doesn't name is claimed by nobody. */
const DEFAULT_BIDS = 10;
// The platform's two fees on the economy's cluster, in SOL: set by `simulate` as it starts, for everything it calls.
// It is synchronous, so one run never sees another's.
let PLAYER_FEE = 0;
let PROJECT_FEE = 0;
const NETWORK_FEE = sol(SIGNATURE_LAMPORTS);
/** MagicBlock's oracle, per random number: a box's open (the player), a lottery's draw, a `roll` (model.mjs ORACLE_FEE). */
const ORACLE = sol(ORACLE_FEE);
/** A lottery purchase's entry in its round: the bytes the buyer adds (not refunded: they go to the treasury when the
 * round closes), with a wallet kept for each share the buyer's own entry names (lottery.rs `entry_width`). */
const ticketLine = l => sol(BigInt(entryWidth(...entryShape(l))) * RENT_PER_BYTE);
/** A collectible's Core account, paid from the SOL the order holds: its rent and Core's creation fee (model.mjs). */
const COLLECTIBLE_RENT = sol(COLLECTIBLE_RENT_LAMPORTS);
/** What a collectible a recipe burns gives back: its rent less one byte's (Core leaves a 1-byte account that keeps
 * the creation fee). 189 bytes × 5,080 lamports, measured by the full simulation. */
const BURN_REFUND = 0.00096;
/** What a grant's claim adds to its lists: the wallet's limit record (its first claim) and a record of the round paid
 * (none for an open grant's claim). Back to the owner when the shards close after the grant. */
const claimRecordsRent = g =>
  sol(
    BigInt(
      LIMIT_RECORD_BYTES +
        ((g.vouchers ?? []).length || (g.keys ?? []).length || (g.list ?? []).length ? ROUND_RECORD_BYTES : 0),
    ) * RENT_PER_BYTE,
  );
/** A wallet's token account, which a grant that pays tokens opens from its funds when the winner has none. */
const TOKEN_ACCOUNT_RENT = sol((165n + 128n) * RENT_PER_BYTE);
/** An order of box `b`'s rent (`orderBytes`), returned at settle or refund: an open's (`opened`, sized as `open_box` sizes it), or a roll's made inside another call. */
const orderRent = (b, m, opened = false) => sol((BigInt(boxOrderBytes(b, m, 1, { opened })) + 128n) * RENT_PER_BYTE);
const num = v => (v === undefined || v === null ? 0 : Number(v));
export const round = (x, digits = 9) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : x);

/**
 * What one action takes from the player's wallet for good, and what the wallet must hold when it signs. `totalSol`
 * (only for a price in SOL) is the price, the platform's fee, the oracle's, the network's and rent that never comes
 * back (a collectible's own): the one number to tell a person. `holdSol` adds what comes back later (`held`, named by
 * `heldIs`: the SOL an order holds and its account, a ticket purchase's record) and, for SOL, the wrapped-SOL account a
 * purchase opens and closes again. A price that comes back (`priceBack`: a no-loss ticket) is held, not spent. A price
 * that rises or falls is given as listed, what the part goes live at, with how it moves in words (`moves`,
 * `priceMoves`): the number is then true whatever a scenario sells.
 */
function realCostOf({
  price,
  token,
  isSol,
  oracle = 0,
  signatures = 1,
  rent = 0,
  rentIs = '',
  held = 0,
  heldIs = '',
  priceBack = false,
  atLeast = false,
  moves = '',
}) {
  const extrasSol = PLAYER_FEE + oracle + signatures * NETWORK_FEE + rent;
  const hold = extrasSol - rent + held + (isSol ? price + TOKEN_ACCOUNT_RENT : 0);
  const spent = isSol && !priceBack ? price : 0;
  return {
    price: round(price),
    token,
    ...(atLeast ? { atLeast: true } : {}),
    ...(priceBack ? { priceBack: true } : {}),
    ...(moves ? { priceMoves: moves } : {}),
    playerFeeSol: PLAYER_FEE,
    oracleSol: oracle,
    networkSol: round(signatures * NETWORK_FEE),
    rentSol: round(rent),
    ...(rent ? { rentIs } : {}),
    ...(held && heldIs ? { heldSol: round(held), heldIs } : {}),
    extrasSol: round(extrasSol),
    ...(isSol ? { totalSol: round(spent + extrasSol) } : {}),
    holdSol: round(Math.max(hold, extrasSol + (isSol ? price : 0))),
  };
}

/** Sums { token: amount } maps. */
const add = (into, token, amount) => {
  if (!amount) return;
  into[token] = (into[token] ?? 0) + amount;
};

/** Prices are capped here so a price that compounds without end stays a number. */
const PRICE_CAP = 1e18;
/**
 * The most sales one simulation walks one by one while a price still moves, all its boxes and items together: the
 * counts come from the spec, so the walk is bounded however large they are.
 */
const MAX_WALK = 10_000_000;
/** A budget of sales to walk, shared by every salePrices call of one simulation. */
export const walkBudget = () => ({ left: MAX_WALK });

/**
 * How likely each of `weights` is to be drawn in `count` draws that each leave out what was drawn (a slot that keeps
 * each outcome once: order.rs, the slot's own copy of the weights with each one taken set to 0): exactly, over every
 * set drawn, for up to 16 outcomes; else from 20,000 opens drawn with a fixed seed, so the same spec says the same.
 */
export function drawnWithout(weights, count) {
  const n = weights.length;
  const live = weights.filter(w => w > 0).length;
  if (count >= live) return weights.map(w => (w > 0 ? 1 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total || count <= 0) return weights.map(() => 0);
  const out = new Array(n).fill(0);
  if (n <= 16) {
    // the chance of each set of outcomes drawn so far, after each draw
    let states = new Map([[0, 1]]);
    for (let d = 0; d < count; d++) {
      const next = new Map();
      for (const [mask, p] of states) {
        let left = total;
        for (let i = 0; i < n; i++) if (mask & (1 << i)) left -= weights[i];
        if (left <= 0) {
          next.set(mask, (next.get(mask) ?? 0) + p);
          continue;
        }
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i) || !(weights[i] > 0)) continue;
          const q = (p * weights[i]) / left;
          out[i] += q;
          next.set(mask | (1 << i), (next.get(mask | (1 << i)) ?? 0) + q);
        }
      }
      states = next;
    }
    return out;
  }
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const RUNS = 20_000;
  for (let r = 0; r < RUNS; r++) {
    const left = [...weights];
    let sum = total;
    for (let d = 0; d < count && sum > 0; d++) {
      let x = rnd() * sum;
      let i = 0;
      while (i < n - 1 && (x -= left[i]) >= 0) i++;
      out[i] += 1 / RUNS;
      sum -= left[i];
      left[i] = 0;
    }
  }
  return out;
}

/**
 * How the price of a part that has a rise or a fall moves, in words that go after the price: "which rises 0.5% with
 * each sale and falls 1 GOLD every 10m, to at least 5 GOLD". Nothing for a price that stays. `symbol`: its token's.
 */
function priceMoves(part, symbol) {
  const rise = [
    num(part.rise?.growthPercent) ? `${percentage(num(part.rise.growthPercent), 6)}%` : '',
    num(part.rise?.step) ? `${asWritten(num(part.rise.step))} ${symbol}` : '',
  ].filter(Boolean);
  const fall = part.fall
    ? `falls ${asWritten(num(part.fall.step))} ${symbol} every ${part.fall.every}${part.fall.floor !== undefined ? `, to at least ${asWritten(num(part.fall.floor))} ${symbol}` : ''}`
    : '';
  const how = [rise.length ? `rises ${rise.join(' and ')} with each sale` : '', fall].filter(Boolean);
  return how.length ? `which ${how.join(' and ')}` : '';
}

/**
 * What `perDay` sales a day over `days` pay, one every 1/perDay of a day (the first half a gap in), with the part's
 * rise and fall exactly as the program prices them (state.rs `Fall::sell`): each sale pays the price fallen since the
 * later of the fall's start and the last sale, and the price after it is what was paid plus the rise. A price that stops
 * moving (at its cap, or at its floor with no rise) is counted at that price for every sale after; a rise by a fixed step
 * alone (no percent, no fall) is an arithmetic series, summed at once. Every other sale walked comes out of `budget`
 * (one a simulation, shared by its calls), and the walk throws once it runs out. { count, average, first, last }, in
 * whole units.
 */
export function salePrices(part, perDay, days, fallStartsAfter = 0, budget = walkBudget(), decimals = null) {
  const listed = num(part.price);
  const count = Math.round(perDay * days);
  if (!count || (!part.rise && !part.fall)) return { count, average: listed, first: listed, last: listed };
  const gap = DAY / perDay;
  const growth = num(part.rise?.growthPercent) / 100;
  const step = num(part.rise?.step);
  const every = part.fall ? toSeconds(part.fall.every) : 0;
  const floor = num(part.fall?.floor);
  // a rise by a step alone: the k-th sale after the first pays the listed price plus k steps, up to the cap
  if (!part.fall && !growth && step > 0) {
    const below = Math.min(count - 1, Math.max(0, Math.ceil((PRICE_CAP - listed) / step) - 1));
    const total = listed * (1 + below) + (step * below * (below + 1)) / 2 + PRICE_CAP * (count - 1 - below);
    return {
      count,
      average: total / count,
      first: listed,
      last: count === 1 ? listed : below === count - 1 ? listed + below * step : PRICE_CAP,
    };
  }
  // On the sale clock (the default) a sale restarts the countdown, so after the first sale each sale comes `gap` after
  // the last, and one closer than a step of the fall never lowers it. On a shared clock the steps keep their own time.
  const shared = part.fall?.clock === 'shared';
  const falls = Boolean(part.fall && every && num(part.fall.step) && (shared || gap >= every * (1 - 1e-9)));
  // The program grows a price in its token's base units, rounded down (state.rs `Rise::next`, rail.rs `share`): a
  // price too small in base units for its growth to reach one unit never rises by it.
  const unit = decimals === null ? 0 : 10 ** -decimals;
  let price = listed;
  let since = fallStartsAfter;
  let total = 0;
  let first;
  let paid = listed;
  for (let k = 0; k < count; k++) {
    if (budget.left-- <= 0)
      throw new Error(
        `The scenario has ${count.toLocaleString('en-US')} sales of “${part.name ?? part.key}”, whose price rises or falls, and the quick simulation walks at most ${MAX_WALK.toLocaleString('en-US')} sales of prices that still move, for all boxes and items together. Give the scenario fewer days or fewer a day.`,
      );
    const at = (k + 0.5) * gap;
    paid = price;
    const steps = part.fall && every && at > since ? Math.floor((at - since) / every) : 0;
    if (steps && price > floor) paid = Math.max(floor, price - steps * num(part.fall.step));
    // the next countdown starts at this sale, or on a shared clock at the last whole step
    since = shared ? since + steps * every : Math.max(since, at);
    first ??= paid;
    total += paid;
    const more = !growth ? 0 : unit ? Math.floor((paid * growth) / unit + 1e-9) * unit : paid * growth;
    price = Math.min(PRICE_CAP, paid + more + step);
    // the next sale pays this price again, and so does every one after: no fall left, and a rise that adds nothing
    if (price === paid && (!falls || price <= floor)) {
      total += paid * (count - k - 1);
      break;
    }
  }
  return { count, average: total / count, first, last: paid };
}

export function simulate(economy, { now = 0 } = {}) {
  const m = model(economy, { now });
  PLAYER_FEE = sol(m.fees.player);
  PROJECT_FEE = sol(m.fees.project);
  const game = m.currencyKey;
  // The scenario's days, or 30, or as long as the longest farm runs when that is longer.
  const days = m.scenario.days ?? Math.max(30, ...m.farms.map(f => Math.ceil((toSeconds(f.runs) || 0) / DAY)));
  /** The days a one-off (an auction's sale, a lottery that draws once) is spread over: the scenario's, or one when it has none. */
  const scenarioDays = days > 0 ? days : 1;
  const budget = walkBudget();
  const perDay = (kind, key) => num(m.scenario.perDay?.[`${kind}:${key}`] ?? DEFAULT_PER_DAY);
  const symbol = key => m.tokens.get(key)?.symbol ?? key;

  // Per pool: fixed money in and out per day, and a rate per day for what takes a share of what it holds.
  const pools = new Map(
    m.pools.map(p => [
      p.key,
      { key: p.key, currency: p.currency, seed: num(p.seed), in: [], out: [], rate: [], variance: 0 },
    ]),
  );
  // Each lottery's pot is an account of its own, counted here as a pool named "lottery:<key>" (one that pays each round
  // from its own ticket money keeps none).
  for (const l of m.lotteries.filter(keepsPot))
    pools.set(`lottery:${l.key}`, {
      key: `lottery:${l.key}`,
      pot: l.name,
      currency: l.currency ?? game,
      seed: num(l.seed),
      in: [],
      out: [],
      rate: [],
      variance: 0,
    });
  // Each farm's rewards vault is an account of its own too, counted as a pool named "farm:<key>".
  for (const f of m.farms)
    pools.set(`farm:${f.key}`, {
      key: `farm:${f.key}`,
      farm: f.name,
      currency: f.rewardsToken,
      seed: num(f.seed),
      in: [],
      out: [],
      rate: [],
      variance: 0,
    });
  // `halves`: a schedule's flow that halves ({ amount, runsPerDay, halveEvery, maxRuns }): its pool is walked a day at a
  // time, as an average a day would hide the day it runs dry.
  const flowIn = (pool, by, amount, halves) =>
    amount && pools.get(pool)?.in.push({ by, perDay: amount, ...(halves ? { halves } : {}) });
  const flowOut = (pool, by, amount, halves) =>
    amount && pools.get(pool)?.out.push({ by, perDay: amount, ...(halves ? { halves } : {}) });
  const rateOut = (pool, by, perDayShare, to) =>
    perDayShare && pools.get(pool)?.rate.push({ by, perDay: perDayShare, ...(to ? { to } : {}) });

  const players = { pay: {}, get: {}, fees: 0, network: 0, rent: 0, oracle: 0 };
  const creator = { treasury: {}, fees: 0, network: 0, oracle: 0 };
  const burned = {};
  const accounts = {};
  const platform = { player: 0, project: 0 };
  const notes = [];
  /** What a schedule or a decision pays out as a share of a pool: counted for players once each pool's level is known. */
  const sharePrizes = [];
  /** Shares of a pool that are burned (a schedule, a decision): counted once each pool's level is known. */
  const shareBurns = [];
  /** NFTs taken out of a stash a day, by each box that gives one; and the rolls of a box prizes give a day. */
  const stashTakes = [];
  const prizeTakes = [];
  /** The SOL a prize's order holds while it waits (its rent), back to the winner at settle. Whoever settles it pays a
   * collectible's rent. */
  const orderHeld = box => orderRent(m.box.get(box), m);
  /**
   * A route gives prize line `line` `times` a day (prize.rs), `payer` ({ rent, oracle }) paying what it opens: a
   * collectible's rent, the winner's token account (the bound, not the average), a roll's order (back to the winner at
   * settle) and its oracle fee. Returns the SOL one giving costs its payer.
   */
  const givePrize = (line, times, by, payer) => {
    if (!line || !times) return 0;
    let each = 0;
    if (line.gives === 'item') {
      // A compressed one opens no account.
      each = line.compressed ? 0 : COLLECTIBLE_RENT;
      const worth = m.item.get(line.item)?.value;
      if (worth !== undefined) add(players.get, game, times * num(worth));
    } else if (line.gives === 'tokens') {
      each = TOKEN_ACCOUNT_RENT;
      const token = prizePool(line) ? m.pool.get(prizePool(line))?.currency : (line.currency ?? game);
      if (prizePool(line)) flowOut(prizePool(line), by, times * num(line.amount));
      add(players.get, token, times * num(line.amount));
    } else if (line.gives === 'nft') {
      stashTakes.push({ stash: line.stash, perDay: times, by });
    } else if (line.gives === 'roll') {
      each = orderHeld(line.box);
      prizeTakes.push({ box: line.box, perDay: times, by });
      payer.oracle = (payer.oracle ?? 0) + times * ORACLE;
    }
    payer.rent = (payer.rent ?? 0) + times * each;
    return each;
  };
  /** Seconds from going live to a fall's start. */
  const fallStart = part =>
    part.fall?.start && part.fall.start !== 'publish' ? Math.max(0, toTime(part.fall.start, now) - now) : 0;
  /** What a rising or falling price really comes to, in words. */
  const priceNote = (part, sold) => {
    if (!part.rise && !part.fall) return;
    const shared = part.fall?.clock === 'shared';
    const how =
      part.rise && part.fall
        ? `rises with each sale and falls with time${shared ? ' on a clock of its own, sales or not' : ', the countdown restarting at each sale'}`
        : part.rise
          ? 'rises with each sale'
          : shared
            ? 'falls on a clock of its own, sales or not (a sale keeps the price at what was paid, and the next step still comes on time)'
            : 'falls while nobody buys (a sale keeps the price at what was paid and restarts the countdown)';
    const said = `“${part.name}”’s price ${how}: over the scenario’s ${numeral(sold.count)} sales it averages ${numeral(sold.average)} (the first ${asWritten(sold.first)}, the last ${numeral(sold.last)}), and the money below counts that.`;
    notes.push(
      sold.last >= 10 * num(part.price)
        ? `${said} It ends ${sold.last >= PRICE_CAP ? 'beyond any price' : `${numeral(sold.last / num(part.price), 3)} times`} where it started: players stop buying long before that. A smaller growth keeps it in reach.`
        : said,
    );
  };

  /** Sends `amount` of `token` a day to one destination (model `destination`): a pool, a lottery's pot, a farm's rewards vault, a burn, the treasury or an account. */
  const sendTo = (d, token, amount, by) => {
    if (d.kind === 'pool') flowIn(d.key, by, amount);
    else if (d.kind === 'lottery') flowIn(`lottery:${d.key}`, by, amount);
    else if (d.kind === 'farm') flowIn(`farm:${d.key}`, by, amount);
    else if (d.kind === 'burn') add(burned, token, amount);
    else if (d.kind === 'treasury') add(creator.treasury, token, amount);
    else if (d.kind === 'chosen')
      add(
        accounts,
        d.key
          ? `the holder of the ${m.item.get(d.key)?.name ?? d.key} the buyer names`
          : `the wallet the ${String(by).startsWith('payment:') ? 'payer' : 'buyer'} names`,
        amount,
      );
    else add(accounts, `${d.kind}:${d.key}`, amount);
  };
  /** Where `amount` of `token` goes under `split`, per day: its shares (`sendTo`), and the rest to the treasury (or into `restTo`, a pool). */
  const carryOut = (split, token, amount, by, restTo = null) => {
    let left = amount;
    for (const s of sharesOf(split)) {
      const part = (amount * (s.bps ?? 0)) / 10_000;
      left -= part;
      sendTo(s, token, part, by);
    }
    if (restTo) flowIn(restTo, by, left);
    else add(creator.treasury, token, left);
  };
  const playerAction = (count, signatures = 1) => {
    players.fees += count * PLAYER_FEE;
    platform.player += count * PLAYER_FEE;
    players.network += count * signatures * NETWORK_FEE;
  };

  /**
   * What box `b`'s items with a supply, stashes and named NFTs come to over the scenario, with `opens` opens a day and
   * its own opens alone taking from them (pools are walked with their own rows): when an outcome runs out, a box that
   * stops selling stops (`stopsSellingInDays`), and one that draws among what is left goes on with the rest's chances
   * rising (`runsOut`: each outcome's day, and every chance from then), until nothing in it is left. An item whose odds
   * follow its stock (`stockOdds`) never runs out here: its chance shrinks instead. Null when nothing it gives runs out.
   */
  const stockWalk = (b, opens) => {
    const w = weights(b);
    const draws = drawsOf(b);
    // What each stock holds at the start, and what one draw of each outcome takes from it.
    const left = new Map();
    const stockOf = x => {
      const supply = Number(m.item.get(x.item)?.supply ?? 0);
      if (x.gives === 'item' && supply > 0 && !b.stockOdds) return [`item:${x.item}`, supply];
      // A stash with nothing that weighs is out of stock: an NFT of weight 0 is never drawn (stash.rs `drawable`).
      if (x.gives === 'stash' && m.stash.get(x.stash))
        return [`stash:${x.stash}`, stashNfts(m.stash.get(x.stash)).filter(n => n.weight > 0).length];
      if (x.gives === 'nft') return [`nft:${x.nft}`, 1];
      // A minted prize is out of stock when the mint can't take it: a token the project can't mint (a fixed supply, or
      // another's mint) mints nothing.
      if (x.gives === 'mint' && !m.tokens.get(x.currency ?? game)?.gameMints) return [`mint:${x.currency ?? game}`, 0];
      return null;
    };
    const needs = (b.outcomes ?? []).map(o => {
      const need = new Map();
      for (const [key, holds] of outcomeParts(o).map(stockOf).filter(Boolean)) {
        left.set(key, holds);
        need.set(key, (need.get(key) ?? 0) + 1);
      }
      return need;
    });
    if (!left.size || !(opens > 0)) return null;
    const stops = stopsSales(b);
    const out = i => ({
      outcome: i,
      gives: (b.outcomes[i].gives === 'bundle'
        ? (b.outcomes[i].prizes ?? []).map(x => x.item ?? x.stash ?? x.gives)
        : [b.outcomes[i].item ?? b.outcomes[i].stash ?? b.outcomes[i].gives]
      ).join(' + '),
    });
    if (stops) {
      // A box that stops selling covers each purchase by stock (order.rs `covers`): each item, stash or named NFT must
      // hold the most any outcome takes of it in one draw, times the draws of a purchase; it stops once one can't.
      const most = new Map();
      for (const need of needs) for (const [k, n] of need) most.set(k, Math.max(most.get(k) ?? 0, n));
      const short = [...most].filter(([k, n]) => left.get(k) < n * draws).map(([k]) => k);
      const by = keys =>
        w
          .map((_, i) => i)
          .filter(i => keys.some(k => needs[i].has(k)))
          .map(out);
      if (short.length) return { whenOut: 'stopSales', stopsSellingInDays: 0, by: by(short) };
      const sum = w.reduce((n, x) => n + x, 0);
      if (!sum) return null;
      const rate = new Map();
      w.forEach((x, i) => needs[i].forEach((n, k) => rate.set(k, (rate.get(k) ?? 0) + (opens * draws * x * n) / sum)));
      const next = [...rate]
        .filter(([, r]) => r > 0)
        .map(([k, r]) => ({ k, t: (left.get(k) - most.get(k) * draws + 1) / r }))
        .sort((a, z) => a.t - z.t)[0];
      return next && next.t <= days
        ? { whenOut: 'stopSales', stopsSellingInDays: round(next.t, 4), by: by([next.k]) }
        : null;
    }
    const there = i => [...needs[i]].every(([k, n]) => left.get(k) >= n);
    if (b.whenOut === 'giveNothing') {
      // A draw stays on the weights as written: one on an outcome that is out is made and gives nothing, never refunded
      // (order.rs `WhenOut::GiveNothing`). The box keeps selling; what misses grows as outcomes run out.
      const all = w.reduce((n, x) => n + x, 0);
      if (!all) return null;
      let alive = w.map((_, i) => i).filter(there);
      let day = 0;
      const runsOut = [];
      const miss = () => round((w.reduce((n, x, i) => n + (alive.includes(i) ? 0 : x), 0) / all) * 100, 6);
      const gone = w.map((_, i) => i).filter(i => !alive.includes(i));
      if (gone.length) runsOut.push({ inDays: 0, outcomes: gone.map(out), missPercent: miss() });
      while (alive.length) {
        const rate = new Map();
        for (const i of alive)
          for (const [k, n] of needs[i]) rate.set(k, (rate.get(k) ?? 0) + (opens * draws * w[i] * n) / all);
        const next = [...rate].map(([k, r]) => ({ k, t: left.get(k) / r })).sort((a, z) => a.t - z.t)[0];
        if (!next || day + next.t > days) break;
        day += next.t;
        for (const [k, r] of rate) left.set(k, Math.max(0, left.get(k) - r * next.t));
        left.set(next.k, 0);
        const ended = alive.filter(i => !there(i));
        alive = alive.filter(there);
        runsOut.push({ inDays: round(day, 4), outcomes: ended.map(out), missPercent: miss() });
      }
      return runsOut.length ? { whenOut: 'giveNothing', runsOut } : null;
    }
    const chances = alive => {
      const sum = alive.reduce((n, i) => n + w[i], 0);
      return w.map((x, i) => (sum && alive.includes(i) ? round((x / sum) * 100, 6) : 0));
    };
    let alive = w.map((_, i) => i).filter(there);
    let day = 0;
    const runsOut = [];
    const gone = w.map((_, i) => i).filter(i => !alive.includes(i));
    if (gone.length) {
      runsOut.push({ inDays: 0, outcomes: gone.map(out), chancesAfter: chances(alive) });
    }
    while (alive.length) {
      const sum = alive.reduce((n, i) => n + w[i], 0);
      // Each stock's take a day, by the outcomes still there.
      const rate = new Map();
      for (const i of alive)
        for (const [k, n] of needs[i]) rate.set(k, (rate.get(k) ?? 0) + (opens * draws * w[i] * n) / sum);
      const next = [...rate].map(([k, r]) => ({ k, t: left.get(k) / r })).sort((a, z) => a.t - z.t)[0];
      if (!next || day + next.t > days) break;
      day += next.t;
      for (const [k, r] of rate) left.set(k, Math.max(0, left.get(k) - r * next.t));
      left.set(next.k, 0);
      const ended = alive.filter(i => !there(i));
      alive = alive.filter(there);
      runsOut.push({ inDays: round(day, 4), outcomes: ended.map(out), chancesAfter: chances(alive) });
    }
    return runsOut.length
      ? { whenOut: 'drawLeft', runsOut, ...(alive.length ? {} : { stopsSellingInDays: runsOut.at(-1).inDays }) }
      : null;
  };
  /** The walk of a box's stock in words (`stockWalk`). */
  const stockNote = (b, walk) => {
    const named = list => list.map(x => `outcome ${x.outcome} (${x.gives})`).join(', ');
    if (walk.whenOut === 'giveNothing')
      return `“${b.name}” keeps selling as its outcomes run out ("whenOut": "giveNothing"; its own opens alone): ${walk.runsOut
        .map(
          r =>
            `${named(r.outcomes)} ${r.inDays ? `in about ${numeral(r.inDays)} days` : 'from the start'}, then ${percentage(r.missPercent)}% of draws give nothing`,
        )
        .join(
          '; ',
        )}. A draw on an outcome that is out is made and gives nothing: a paid one is not refunded, a free roll is over.`;
    if (walk.whenOut === 'stopSales')
      return `“${b.name}” stops selling ${walk.stopsSellingInDays ? `in about ${numeral(walk.stopsSellingInDays)} days` : 'from the start'}, when ${named(walk.by)} runs out (its own opens alone): it isn’t sold while an item, a stash or a named NFT couldn’t cover, at the most any outcome takes of it in one draw, the draws of a purchase and of those still waiting for the oracle ("whenOut": "stopSales"), so every roll is on the odds as written. Restock it, or edit the box, to sell again; "drawLeft" would keep selling, the rest’s chances rising.`;
    const steps = walk.runsOut.map(
      r =>
        `${named(r.outcomes)} ${r.inDays ? `in about ${numeral(r.inDays)} days` : 'from the start'}${
          r.chancesAfter.some(c => c > 0)
            ? `, then ${r.chancesAfter
                .map((c, i) => (c > 0 ? `outcome ${i} ${percentage(c)}%` : null))
                .filter(Boolean)
                .join(', ')}`
            : ''
        }`,
    );
    return `“${b.name}” keeps selling as its outcomes run out ("whenOut": "drawLeft"; its own opens alone): ${steps.join('; ')}${walk.stopsSellingInDays !== undefined ? `; with nothing left, it stops selling` : ''}. Each roll draws among what is left by the written weights, so a player can empty a common outcome to make a rare one likelier; "stopSales" keeps the odds as written.`;
  };

  // ---- boxes
  const boxes = m.boxes.map(b => {
    const token = b.currency ?? game;
    const opens = perDay('box', b.key);
    // A price that rises or falls is counted at what the scenario's opens really pay, on average.
    const sold = salePrices(b, opens, days, fallStart(b), budget, m.tokens.get(token)?.decimals ?? null);
    const price = sold.average;
    const w = weights(b);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    let value = 0;
    const unpriced = [];
    const other = {};
    // How many times one open gives each outcome, on average: each slot's draws among the outcomes it names (all when it
    // names none), by their weights there (state.rs `draws`, order.rs); a distinct slot that draws as many as it names
    // gives each once. One draw among them all when the box has no slots.
    const given = w.map(() => 0);
    for (const slot of (b.slots ?? []).length ? b.slots : [{ count: 1 }]) {
      const among = (slot.from ?? w.map((_, i) => i)).filter(i => i < w.length);
      const weight = among.reduce((n, i) => n + w[i], 0);
      const count = Number(slot.count ?? 1);
      const each = slot.distinct
        ? drawnWithout(
            among.map(i => w[i]),
            count,
          )
        : among.map(i => (weight ? (count * w[i]) / weight : 0));
      among.forEach((i, j) => (given[i] += each[j]));
    }
    // One part of what an outcome gives (model `outcomeParts`), landing with chance `p` a draw and `p` times an open
    // on average (`n`, its draws counted): its row, and its flows.
    const partRow = (o, p, n = p) => {
      const row = { gives: o.gives, chance: round(p * 100, 6) };
      if (o.gives === 'pay') {
        const prizeToken = m.pool.get(o.pool)?.currency;
        Object.assign(row, { pool: o.pool, amount: num(o.amount), token: prizeToken });
        if (prizeToken === token) value += n * num(o.amount);
        else add(other, prizeToken, n * num(o.amount));
        flowOut(o.pool, `box:${b.key}`, opens * n * num(o.amount));
      } else if (o.gives === 'mint') {
        // Tokens the project mints for the winner: new supply, from no pool.
        const prizeToken = o.currency ?? game;
        Object.assign(row, { amount: num(o.amount), token: prizeToken, minted: true });
        if (prizeToken === token) value += n * num(o.amount);
        else add(other, prizeToken, n * num(o.amount));
      } else if (o.gives === 'item') {
        const it = m.item.get(o.item);
        const worth = it?.value !== undefined ? num(it.value) : num(it?.price) > 0 ? num(it.price) : null;
        Object.assign(row, { item: o.item, worth });
        if (worth === null) unpriced.push(o.item);
        else if ((b.currency ?? game) === game) value += n * worth;
        else add(other, game, n * worth);
      } else if (o.gives === 'stash' || o.gives === 'nft') {
        // A stash's NFT has whatever worth its collection has: the simulation counts how fast it is given away.
        Object.assign(row, { stash: o.stash, worth: null, ...(o.nft ? { nft: o.nft } : {}) });
        unpriced.push(
          o.gives === 'nft' ? `the NFT ${String(o.nft).slice(0, 4)}… of “${o.stash}”` : `the NFTs of “${o.stash}”`,
        );
        // A box switched off is opened by nobody: only the prizes that roll it take from the stash.
        if (b.active !== false) stashTakes.push({ stash: o.stash, perDay: opens * n, by: `box:${b.key}` });
      } else if (o.gives === 'roll') {
        // A roll won is made when the order settles: whoever settles pays its order, and someone asks the oracle.
        Object.assign(row, { box: o.box, worth: null });
        unpriced.push(`a roll of “${m.box.get(o.box)?.name ?? o.box}”`);
        if (b.active !== false) prizeTakes.push({ box: o.box, perDay: opens * n, by: `box:${b.key}` });
      }
      return row;
    };
    const outcomes = (b.outcomes ?? []).map((o, i) => {
      const p = w[i] / total;
      const parts = outcomeParts(o).map(part => partRow(part, p, given[i]));
      for (const part of parts) part.perOpen = round(given[i], 6);
      if (o.gives === 'bundle') return { gives: 'bundle', chance: round(p * 100, 6), prizes: parts };
      return parts[0] ?? { gives: o.gives, chance: round(p * 100, 6) };
    });
    // Every part of every outcome, each with its outcome's chance.
    const partsOf = outcomes.flatMap(o => (o.gives === 'bundle' ? o.prizes : [o]));
    // How much the prizes swing from day to day, per pool: opens × draws × (E[prize²] − E[prize]²), each draw's odds
    // being how often an open gives each prize over its draws (one draw: its chance).
    const draws = drawsOf(b);
    for (const key of new Set(partsOf.filter(o => o.gives === 'pay').map(o => o.pool))) {
      const rows = partsOf.filter(o => o.gives === 'pay' && o.pool === key);
      const mean = rows.reduce((n, o) => n + (o.perOpen / draws) * o.amount, 0);
      const square = rows.reduce((n, o) => n + (o.perOpen / draws) * o.amount ** 2, 0);
      if (pools.has(key)) pools.get(key).variance += opens * draws * (square - mean ** 2);
    }
    // Money: the payment is split (a share may burn it).
    carryOut(b.split, token, opens * price, `box:${b.key}`);
    add(players.pay, token, opens * price);
    add(players.get, token, opens * value);
    for (const [t, v] of Object.entries(other)) add(players.get, t, opens * v);
    // Two signatures: the open, then the settle that carries the outcome out (a throwaway key the open funds sends it).
    // A box that needs no roll is bought in one (`buy`), with no order; every open asks the oracle.
    const bought = boxBuys(b, m);
    const signatures = bought ? 1 : 2;
    playerAction(opens, signatures);
    if (!bought) players.oracle += opens * ORACLE;
    const collectibles = partsOf
      .filter(o => holdsRent(o, m) && m.item.get(o.item)?.kind !== 'normal')
      .reduce((n, o) => n + o.perOpen, 0);
    players.rent += opens * collectibles * COLLECTIBLE_RENT;
    const known = !unpriced.length && !Object.keys(other).length;
    // What one open really takes from the player's wallet: the price, the platform's fee, the oracle's and the network's.
    const isSol = Boolean(m.tokens.get(token)?.wsol);
    const oracle = bought ? 0 : ORACLE;
    // A collectible's rent comes out of the SOL the open lends its settle key: on average, the chance of one.
    const realCost = realCostOf({
      price: num(b.price),
      moves: priceMoves(b, symbol(token)),
      token,
      isSol,
      oracle,
      signatures,
      rent: collectibles * COLLECTIBLE_RENT,
      rentIs: collectibles < 1 ? 'the collectible’s rent, when it gives one' : 'the collectible’s rent',
      held: bought ? 0 : sol(SETTLE_RENT_UNIT) * settleRentUnits(b, m) + orderRent(b, m, true),
    });
    const extrasSol = realCost.extrasSol;
    priceNote(b, sold);
    // What it gives that runs out, as the box says (`whenOut`): it stops selling, or draws among what is left.
    const walk = !bought && b.active !== false ? stockWalk(b, opens) : null;
    if (walk) notes.push(stockNote(b, walk));
    // Each outcome's chance for a player who passes every odds rule at its most (order.rs, rules.rs `boosted`): counted
    // in BigInt, each weight stopping at the largest. The rules count on every route, read when a roll is first asked.
    const raised = (b.odds ?? []).length ? boostedWeights(b) : null;
    const raisedSum = raised ? raised.reduce((n, x) => n + x, 0n) : 0n;
    const oddsBoosted =
      raised && raisedSum > 0n ? raised.map(x => round(Number((x * 100_000_000n) / raisedSum) / 1_000_000, 6)) : null;
    if (oddsBoosted)
      notes.push(
        `“${b.name}”’s odds rules raise its chances to ${oddsBoosted.map((c, i) => `outcome ${i} ${percentage(c)}%`).join(', ')} for a player who passes them all at their most. They count on every route: on a purchase, and on a roll another route gives, read when the roll is first asked, not when it was won.`,
      );
    return {
      key: b.key,
      name: b.name,
      price: num(b.price),
      ...(price !== num(b.price) ? { averagePrice: round(price) } : {}),
      token,
      opensPerDay: opens,
      outcomes,
      expectedBack: round(value),
      returnPercent: price && (value > 0 || !Object.keys(other).length) ? round((value / price) * 100, 4) : null,
      houseEdgePercent: known && price ? round((1 - value / price) * 100, 4) : null,
      alsoPays: other,
      unpriced,
      playerFee: PLAYER_FEE,
      oracleFee: oracle,
      realCost,
      // What it gives can run out, and what the box does then (`whenOut`, `whenOutWords`).
      ...(!bought &&
      outcomes
        .flatMap(o => (o.gives === 'bundle' ? o.prizes : [o]))
        .some(
          o =>
            o.gives === 'pay' ||
            o.gives === 'stash' ||
            o.gives === 'nft' ||
            (o.gives === 'item' && Number(m.item.get(o.item)?.supply ?? 0) > 0),
        )
        ? { limitedStock: true }
        : {}),
      ...(!bought ? { whenOut: b.whenOut ?? 'stopSales' } : {}),
      ...(oddsBoosted ? { oddsBoosted } : {}),
      ...(walk ? { stock: walk } : {}),
      ...(isSol && known && price ? { returnOfRealCostPercent: round((value / (price + extrasSol)) * 100, 4) } : {}),
    };
  });

  // ---- items sold in the shop
  const items = m.shop
    .map(b => ({ ...m.item.get(b.shopOf), shopBox: b.key }))
    .map(it => {
      const sales = perDay('item', it.key);
      const sold = salePrices(
        it,
        sales,
        days,
        fallStart(it),
        budget,
        m.tokens.get(it.currency ?? game)?.decimals ?? null,
      );
      const price = sold.average;
      priceNote(it, sold);
      carryOut(it.split, game, sales * price, `item:${it.key}`);
      add(players.pay, game, sales * price);
      // A shop item is a box of one entry, bought in one step (`buy`): the price split and the item given at once (a
      // collectible minted to them; the project's backend delivers a normal item from the receipt).
      const collectible = (it.kind ?? 'collectible') === 'collectible';
      playerAction(sales, 1);
      if (collectible) players.rent += sales * COLLECTIBLE_RENT;
      const listed = num(it.price);
      // The next price, grown in base units and rounded down as the program grows it (state.rs `Rise::next`), with
      // its token's decimals as salePrices has them (none known: not rounded).
      const decimals = m.tokens.get(it.currency ?? game)?.decimals ?? null;
      const grown = listed * (num(it.rise?.growthPercent) / 100);
      const unit = decimals === null ? 0 : 10 ** -decimals;
      const rises = it.rise ? (unit ? Math.floor(grown / unit + 1e-9) * unit : grown) + num(it.rise.step) : 0;
      const realCost = realCostOf({
        price: listed,
        moves: priceMoves(it, symbol(game)),
        token: game,
        isSol: Boolean(m.tokens.get(game)?.wsol),
        signatures: 1,
        rent: collectible ? COLLECTIBLE_RENT : 0,
        rentIs: 'the collectible’s rent',
        held: 0,
      });
      return {
        key: it.key,
        name: it.name,
        price: listed,
        ...(price !== listed ? { averagePrice: round(price) } : {}),
        token: game,
        salesPerDay: sales,
        ...(rises ? { nextPrice: round(listed + rises) } : {}),
        ...(it.supply && sales > 0 ? { soldOutInDays: round(it.supply / sales, 2) } : {}),
        realCost,
      };
    });

  // ---- payments
  const payments = m.payments.map(p => {
    const token = p.currency ?? game;
    const count = perDay('payment', p.key);
    carryOut(p.split, token, count * num(p.amount), `payment:${p.key}`);
    add(players.pay, token, count * num(p.amount));
    playerAction(count);
    const realCost = realCostOf({
      price: num(p.amount),
      token,
      isSol: Boolean(m.tokens.get(token)?.wsol),
      atLeast: Boolean(p.any),
    });
    return {
      key: p.key,
      name: p.name,
      amount: num(p.amount),
      ...(p.any ? { atLeast: true } : {}),
      token,
      perDay: count,
      realCost,
    };
  });

  // ---- recipes
  const recipes = m.recipes.map(r => {
    const crafts = perDay('recipe', r.key);
    const takes = [];
    const gives = [];
    for (const line of r.in ?? []) {
      if (line.takes === 'burn') players.rent -= crafts * (line.count ?? 1) * BURN_REFUND;
      if (line.takes !== 'pay') {
        const what =
          line.takes === 'show' || line.takes === 'trade'
            ? `an NFT of ${line.collection ? `${line.collection.slice(0, 4)}…` : 'the collection'}`
            : line.item;
        const traded = t =>
          !t || t === 'burn'
            ? ' (traded in, burned)'
            : t.stash
              ? ` (traded in, into “${t.stash}”)`
              : ' (traded in, given on)';
        takes.push(
          `${line.takes === 'burn' ? `${asWritten(line.count ?? 1)} × ` : ''}${what}${line.takes === 'burn' ? ' (burned)' : line.takes === 'trade' ? traded(line.then) : line.takes === 'renew' ? ' (renewed)' : line.takes === 'staked' ? ` (kept, and staked in “${m.farm.get(line.farm)?.name ?? line.farm}”)` : ' (kept)'}`,
        );
        continue;
      }
      const token = line.currency ?? game;
      takes.push(`${asWritten(num(line.amount))} ${symbol(token)}`);
      add(players.pay, token, crafts * num(line.amount));
      sendTo(destination(line.to), token, crafts * num(line.amount), `recipe:${r.key}`);
    }
    for (const x of r.raises ?? []) {
      if (!x.fromNow && typeof x.by === 'string')
        gives.push(
          String(x.by).startsWith('-')
            ? `${x.key} ${String(x.by).slice(1)} sooner on collectible ${x.place}`
            : `${x.key} ${x.by} later on collectible ${x.place}`,
        );
      else if (x.fromNow)
        gives.push(
          String(x.by).startsWith('-')
            ? `${x.key} ${String(x.by).slice(1)} sooner on collectible ${x.place}`
            : `${x.key} ${x.by} later on collectible ${x.place}, from now when it is past (at most ${x.upTo} ahead)`,
        );
      else
        gives.push(
          x.by > 0
            ? `+${x.by} ${x.key} on collectible ${x.place} (up to ${x.upTo})`
            : `${x.by} ${x.key} on collectible ${x.place} (never below 0)`,
        );
    }
    for (const line of r.out ?? []) {
      if (line.gives === 'item') {
        gives.push(line.item);
        if (!line.compressed) players.rent += crafts * COLLECTIBLE_RENT;
        const worth = m.item.get(line.item)?.value;
        if (worth !== undefined) add(players.get, game, crafts * num(worth));
      } else if (line.gives === 'tokens') {
        // In its pool's token, or the one it mints.
        const token = prizeToken(line, m)?.key ?? line.currency ?? game;
        gives.push(`${asWritten(num(line.amount))} ${symbol(token)}`);
        add(players.get, token, crafts * num(line.amount));
        if (line.from?.startsWith('pool:')) flowOut(line.from.slice(5), `recipe:${r.key}`, crafts * num(line.amount));
      } else if (line.gives === 'roll') {
        gives.push(`a roll of “${line.box}”${line.on !== undefined ? ` on collectible ${line.on}` : ''}`);
      } else if (line.gives === 'nft') {
        gives.push(prizeWords(line, m));
        stashTakes.push({ stash: line.stash, perDay: crafts, by: `recipe:${r.key}` });
      }
    }
    // The player's is the only signature: what a craft makes is at its item's and serial's address.
    playerAction(crafts, 1);
    return { key: r.key, name: r.name, craftsPerDay: crafts, takes, gives };
  });

  /**
   * What `span` steps pay in all, counted in steps at the first rate, when the rate halves every `every` steps (a
   * schedule's runs, schedule.rs; a farm's days from its opening, farm.rs `paid`): `span` when it never halves.
   */
  const halvedSum = (span, every) => {
    if (!every || !(span > 0)) return Math.max(0, span);
    const full = Math.floor(span / every);
    return every * (2 - 2 ** (1 - full)) + (span - full * every) * 2 ** -full;
  };
  // ---- schedules
  const schedules = m.schedules
    .filter(s => s.active !== false)
    .map(s => {
      const every = toSeconds(s.every) || DAY;
      // Runs a day on average over the scenario: each run at its amount halved once for every `halveEvery` runs before
      // it (schedule.rs), and none after `maxRuns`.
      const inScenario = (DAY / every) * days;
      const runs =
        s.sealed || !inScenario
          ? DAY / every
          : halvedSum(Math.min(inScenario, s.maxRuns ?? inScenario), s.halveEvery) / days;
      const averaged = !s.sealed && Math.abs(runs - DAY / every) > 1e-9;
      const halves = averaged
        ? { runsPerDay: DAY / every, halveEvery: s.halveEvery ?? 0, maxRuns: s.maxRuns ?? Infinity }
        : null;
      const runWords = averaged
        ? `${s.halveEvery ? `, halving every ${s.halveEvery} runs` : ''}${s.maxRuns ? `, for ${asWritten(s.maxRuns)} runs` : ''}`
        : '';
      creator.network += (DAY / every) * NETWORK_FEE; // run_schedule is free of the program's fee; whoever sends it pays the network
      if (s.does === 'issue') {
        const amount = num(s.amount);
        // (minted into a pool, in the pool's token, or straight into a farm's rewards, in the token it names)
        const intoFarm = destination(s.to ?? '').kind === 'farm';
        const issued = intoFarm ? (s.currency ?? m.currencyKey) : m.pool.get(s.pool)?.currency;
        flowIn(intoFarm ? s.to : s.pool, `schedule:${s.key}`, runs * amount, halves && { ...halves, amount });
        const halving = s.halveEvery
          ? `, halving every ${s.halveEvery} runs (every ${numeral((s.halveEvery * every) / DAY, 3)} days)`
          : '';
        // Halving every h runs: h runs at the amount, h at half, … (2 × h × amount in all, with no end); with
        // maxRuns, the full halvings it reaches and the runs after the last.
        const halvings = s.halveEvery && s.maxRuns ? Math.floor(s.maxRuns / s.halveEvery) : 0;
        const totalEver = s.halveEvery
          ? s.maxRuns
            ? amount * s.halveEvery * (2 - 2 ** (1 - halvings)) + (s.maxRuns % s.halveEvery) * amount * 2 ** -halvings
            : amount * s.halveEvery * 2
          : s.maxRuns
            ? amount * s.maxRuns
            : Infinity;
        return {
          key: s.key,
          does: 'issue',
          perDay: round(runs * amount),
          token: issued,
          says: `mints ${numeral(runs * amount)} ${symbol(issued)} a day into ${intoFarm ? `the rewards of ${s.to}` : s.pool}${halving}${averaged ? `, on average over the scenario’s ${numeral(days)} days (${asWritten(amount)} a run at first)` : ''}`,
          mintsInAll: Number.isFinite(totalEver) ? round(totalEver) : null,
        };
      }
      if (s.sealed) {
        // A sealed schedule pays from its own vault: what it was funded with, run by run, the last run the rest.
        const t = s.currency ?? m.currencyKey;
        const each =
          s.percent === undefined
            ? `${asWritten(num(s.amount))} ${symbol(t)}`
            : `${s.percent}% of what its vault holds`;
        if (s.percent === undefined) sendTo(destination(s.to), t, runs * num(s.amount), `schedule:${s.key}`);
        return {
          key: s.key,
          does: 'pay',
          sealed: true,
          perDay: s.percent === undefined ? round(runs * num(s.amount)) : 0,
          says: `sealed: pays ${s.to} ${each} every ${numeral(every / 3600, 4)} h for ${numeral(s.maxRuns)} runs from a vault of its own${s.fund ? ` (${asWritten(num(s.fund))} ${symbol(t)} put in at go-live${s.fundFrom === 'mint' ? ', minted' : s.fundFrom?.startsWith('pool:') ? ` from ${s.fundFrom.slice(5)}` : ' from the owner’s wallet'})` : ''}; the last run pays whatever is left, and nobody, the owner included, can change it, stop it or take its tokens back`,
        };
      }
      const from = s.does === 'burn' ? s.pool : s.from;
      const sym = symbol(m.pool.get(from)?.currency);
      if (s.percent === undefined) {
        // A fixed amount each run.
        const amount = num(s.amount);
        flowOut(from, `schedule:${s.key}`, runs * amount, halves && { ...halves, amount });
        if (s.does === 'move') flowIn(s.to, `schedule:${s.key}`, runs * amount, halves && { ...halves, amount });
        else if (s.does === 'burn') add(burned, m.pool.get(from)?.currency, runs * amount);
        else sendTo(destination(s.to), m.pool.get(from)?.currency, runs * amount, `schedule:${s.key}`);
        const where = s.does === 'burn' ? 'burns' : s.does === 'move' ? `moves to ${s.to}` : `pays ${s.to}`;
        return {
          key: s.key,
          does: s.does,
          perDay: round(runs * amount),
          says: `${where} ${asWritten(amount)} ${sym} from ${from} every ${numeral(every / 3600, 4)} h${runWords}${averaged ? `: about ${numeral(runs * amount)} a day on average over the scenario’s ${numeral(days)} days` : ''}`,
        };
      }
      const share = (toBps(s.percent) ?? 0) / 10_000;
      if (s.does === 'burn') {
        rateOut(s.pool, `schedule:${s.key}`, runs * share);
        shareBurns.push({ pool: s.pool, rate: runs * share });
      } else if (s.does === 'move' || ['lottery', 'farm'].includes(destination(s.to).kind)) {
        // into another pool, a lottery's pot (a pool named "lottery:<key>") or a farm's rewards vault ("farm:<key>",
        // released to its stakers): it enters there at the source's level
        rateOut(s.from, `schedule:${s.key}`, runs * share, s.to);
      } else {
        rateOut(s.from, `schedule:${s.key}`, runs * share);
        sharePrizes.push({ pool: s.from, rate: runs * share, account: s.to, by: `schedule:${s.key}` });
      }
      const where = s.does === 'burn' ? 'burns' : s.does === 'move' ? `moves to ${s.to}` : `pays ${s.to}`;
      return {
        key: s.key,
        does: s.does,
        percentPerDay: round(runs * s.percent, 6),
        says: `${where} ${s.percent}% of ${from} every ${numeral(every / 3600, 4)} h${runWords}${averaged ? `: about ${percentage(runs * s.percent)}% of it a day on average over the scenario’s ${numeral(days)} days` : ''}`,
      };
    });

  // ---- stakes: everything that arrives in a farm’s rewards vault goes to its stakers
  // ---- lotteries: in steady state each round pays out what came in (what the places leave rolls over). One that draws
  // once (no `every`) has one round, from going live to its first draw (the scenario's end at the latest): its tickets,
  // its draw and its pot happen once, spread over the scenario's days like an auction's sale.
  /** Per lottery: whether it draws once, and the days its money a day is spread over. */
  const lotteryRun = new Map();
  const lotteries = m.lotteries.map(l => {
    const once = !toSeconds(l.every);
    const untilDraw = l.firstDraw ? toTime(l.firstDraw, now) - now : 0;
    const every = once ? Math.min(untilDraw > 0 ? untilDraw : Infinity, scenarioDays * DAY) : toSeconds(l.every);
    const perRound = (perDay('lottery', l.key) * every) / DAY;
    // tickets a day: as the scenario says, or for one round, its tickets spread over the scenario
    const tickets = once ? perRound / scenarioDays : perDay('lottery', l.key);
    const drawsPerDay = once ? 1 / scenarioDays : DAY / every;
    lotteryRun.set(l.key, { once, spreadDays: once ? scenarioDays : every / DAY, seed: num(l.seed) });
    const potToken = l.currency ?? game;
    const ticketToken = l.ticketCurrency ?? potToken;
    const price = num(l.price);
    const split = lotterySplit(l);
    const cut = split.reduce((n, s) => n + (toBps(s.percent) ?? 0), 0) / 10_000;
    add(players.pay, ticketToken, tickets * price);
    // No loss: every ticket comes back to its buyer after the draw; the pot is only what is paid into it.
    if (l.noLoss) add(players.get, ticketToken, tickets * price);
    else if (l.ticketCurrency) add(burned, ticketToken, tickets * price);
    else if (keepsPot(l)) {
      // The split takes its shares as it does a sale's; the rest goes into the pot (not the treasury).
      carryOut(split, potToken, tickets * price, `lottery:${l.key}`, `lottery:${l.key}`);
    } else {
      // Paid from each round's own money: the split takes its shares, the places their percents of the rest, and
      // what they leave goes to `rest` (below, once the places are known).
      for (const share of sharesOf(split))
        sendTo(share, potToken, (tickets * price * (share.bps ?? 0)) / 10_000, `lottery:${l.key}`);
    }
    playerAction(tickets);
    // A lottery that holds SOL for its rounds (`roundRent`, on by default) pays each entry's bytes: the buyer pays none.
    const entryRent = roundRentOf(l, m) > 0n ? 0 : ticketLine(l);
    players.rent += tickets * entryRent;
    const placed = (l.places ?? [100]).map(placeOf);
    const places = placed.map(p => Number(p.percent));
    // A run of places ("times") is that many places, each taking its percent (lottery.rs: each place of a run is paid).
    const placeTimes = placed.map(p => Math.max(1, Number(p.times ?? 1)));
    const placesPercent = places.reduce((n, pct, i) => n + pct * placeTimes[i], 0);
    const placeCount = placeTimes.reduce((a, b) => a + b, 0);
    creator.network += (1 + placeCount) * NETWORK_FEE * drawsPerDay; // the draw and each place's payment
    // A place's prize, once a round, given by whoever pays the place (the game's keeper).
    for (const p of placed.filter(p => p.prize)) givePrize(p.prize, drawsPerDay, `lottery:${l.key}`, creator);
    creator.oracle += ORACLE * drawsPerDay; // the draw asks the oracle; whoever sends it (the game's keeper) pays
    // What the places' prizes are worth a round in the pot's token: tokens of it, or an item with a value in it. A
    // prize with no price (an NFT, a roll, an item with no value) leaves a ticket's return unsaid.
    const worthOf = line => {
      if (line.gives === 'tokens')
        return (prizePool(line) ? m.pool.get(prizePool(line))?.currency : (line.currency ?? game)) === potToken
          ? num(line.amount)
          : null;
      if (line.gives === 'item')
        return m.item.get(line.item)?.value !== undefined && game === potToken
          ? num(m.item.get(line.item).value)
          : null;
      return null;
    };
    const prized = placed.filter(p => prizeLine(p.prize)).map(p => worthOf(prizeLine(p.prize)));
    // A weighted round (`timeWeighted`): each purchase weighs its tickets times the seconds from it to the close of
    // sales, and a place is won by weight. With purchases spread evenly over the selling time, a ticket bought at the
    // open counts twice the average, one bought halfway the average, one in the last hour next to nothing.
    const closesBefore = toSeconds(l.closesBefore ?? 0);
    const selling = Math.max(1, every - closesBefore);
    const weighted = l.timeWeighted
      ? {
          sellsForDays: round(selling / DAY, 4),
          atOpen: 2,
          halfway: 1,
          lastHour: round(Number(purchaseWeight(1, selling - Math.min(3_600, selling), selling)) / (selling / 2), 6),
        }
      : null;
    if (weighted)
      notes.push(
        `“${l.name}” weighs each purchase by its tickets times the seconds left until sales close: a ticket bought when a round opens counts about twice the average, one bought halfway the average, one in the last hour about ${weighted.lastHour} of it. A buyer sees what their purchase weighs before they buy.`,
      );
    // Places of tokens from a pool read it once, when the draw is asked: one that starts short pays as "whenShort" says.
    const shortPools = [];
    const fromPools = new Map();
    for (const p of placed) {
      const line = prizeLine(p.prize);
      const key = line?.gives === 'tokens' ? prizePool(line) : null;
      if (key) fromPools.set(key, [...(fromPools.get(key) ?? []), p]);
    }
    for (const [key, runs] of fromPools) {
      const decimals = m.tokens.get(m.pool.get(key)?.currency)?.decimals ?? 0;
      const units = v => {
        try {
          return toUnits(v ?? 0, decimals);
        } catch (error) {
          if (!(error instanceof SpecError)) throw error;
          return 0n;
        }
      };
      const holds = units(m.pool.get(key)?.seed);
      const rows = runs.map(p => ({ each: units(prizeLine(p.prize).amount), places: p.times ?? 1 }));
      const wins = rows.reduce((n, r) => n + r.each * BigInt(r.places), 0n);
      if (holds >= wins) continue;
      const whenShort = runs[0].whenShort ?? 'inOrder';
      const pays = shortPays(rows, holds, whenShort);
      const scale = 10 ** decimals;
      shortPools.push({
        pool: key,
        holds: Number(holds) / scale,
        wins: Number(wins) / scale,
        whenShort,
        each: pays.map(x => Number(x.each) / scale),
      });
      notes.push(
        `“${l.name}”’s places paid from “${key}” win ${numeral(Number(wins) / scale)} and the pool starts with ${numeral(Number(holds) / scale)}: if it holds no more when a draw is asked, they get ${pays.map(x => numeral(Number(x.each) / scale)).join(', ')} each ("whenShort": "${whenShort}").`,
      );
    }
    // One ticket bought on its own: the fee and the record are per purchase, so a bundle of tickets shares them. The
    // record's rent comes back once the round is done with it, and a no-loss ticket's price after the draw: both held.
    const realCost = realCostOf({
      price,
      token: ticketToken,
      isSol: Boolean(m.tokens.get(ticketToken)?.wsol),
      rent: entryRent,
      rentIs: 'the purchase’s entry in the round',
      ...(l.noLoss ? { heldIs: 'the ticket’s price' } : {}),
      priceBack: Boolean(l.noLoss),
    });
    // Each round's own money a day, for its places and its `rest` (none reaches them when tickets are burned or NFTs).
    const roundMoney = keepsPot(l) || l.noLoss || l.ticketCurrency ? 0 : tickets * price * (1 - cut);
    if (!keepsPot(l))
      sendTo({ ...destination(l.rest) }, potToken, roundMoney * (1 - placesPercent / 100), `lottery:${l.key}`);
    return {
      key: l.key,
      name: l.name,
      price,
      token: ticketToken,
      potToken,
      ...(keepsPot(l) ? { pot: l.pot } : { rest: l.rest, roundMoneyPerDay: roundMoney }),
      ...(l.minSold ? { minSold: l.minSold } : {}),
      ticketsPerDay: round(tickets, 6),
      ticketsPerRound: round(perRound, 4),
      roundDays: round(every / DAY, 4),
      places,
      placeTimes,
      placesPercent,
      placePrizes: placed.map(p => (p.prize ? prizeWords(p.prize, m) : null)),
      prizeWorthPerRound: round(prized.reduce((n, w) => n + (w ?? 0), 0)),
      ...(prized.includes(null) ? { unpricedPrizes: true } : {}),
      cutPercent: num(l.cutPercent),
      splitPercent: round(cut * 100, 4),
      drawsOnce: once,
      roundRentSol: round(Number(roundRentOf(l, m)) / 1e9),
      ...(l.ticketNft ? { ticketNft: true } : {}),
      ...(l.noLoss ? { noLoss: true } : {}),
      ...(closesBefore ? { closesBeforeDays: round(closesBefore / DAY, 4) } : {}),
      ...(weighted ? { weighted } : {}),
      ...(shortPools.length ? { shortPools } : {}),
      realCost,
    };
  });

  // ---- decisions with a known rate
  for (const d of m.decisions) {
    const rate = num(d.perDay);
    if (!rate) continue;
    creator.fees += rate * PROJECT_FEE;
    platform.project += rate * PROJECT_FEE;
    creator.network += rate * NETWORK_FEE;
    if (d.does === 'roll') creator.oracle += rate * ORACLE;
    if ((d.does === 'payout' || d.does === 'burn') && d.pool) {
      if (d.percent !== undefined) {
        rateOut(d.pool, `decision:${d.key}`, rate * ((toBps(d.percent) ?? 0) / 10_000));
        if (d.does === 'payout') sharePrizes.push({ pool: d.pool, rate: rate * ((toBps(d.percent) ?? 0) / 10_000) });
        else shareBurns.push({ pool: d.pool, rate: rate * ((toBps(d.percent) ?? 0) / 10_000) });
      } else flowOut(d.pool, `decision:${d.key}`, rate * num(d.amount));
      const token = m.pool.get(d.pool)?.currency;
      if (d.does === 'payout' && d.amount !== undefined) add(players.get, token, rate * num(d.amount));
      if (d.does === 'burn' && d.amount !== undefined) add(burned, token, rate * num(d.amount));
    }
  }
  const contests = m.contests.map(c => {
    const rake = sharesOf(c.split).reduce((n, s) => n + (s.bps ?? 0), 0) / 100;
    const opened = c.every ? DAY / toSeconds(c.every) : 0;
    creator.fees += opened * 2 * PROJECT_FEE; // opened and decided
    platform.project += opened * 2 * PROJECT_FEE;
    const split = prizeLine(c.prize)?.split
      ? `, and ${prizeWords(c.prize, m)} (set aside whole when it is decided; short of it, the decision is refused; a part a winner gives up stays for the pool, not for later winners)`
      : '';
    return {
      key: c.key,
      name: c.name,
      sides: c.sides,
      rakePercent: rake,
      winnersSharePercent: 100 - rake,
      says: `the winning side shares ${100 - rake}% of the pot as it stands when the side is named, by what each put in${split}: each winner's part is written then, whoever claims first, and anything sent to the pot after it goes to nobody (burned at the close)`,
    };
  });
  // Auctions: each bid tops the last by the least raise, so a run of N bids ends near reserve × (1 + raise)^(N − 1).
  // The scenario counts bids a day (`auction:<key>`, DEFAULT_BIDS a day unless it says), while the auction runs.
  const auctions = m.auctions.map(a => {
    const runDays = toSeconds(a.runs) / DAY;
    const bids = Math.max(
      0,
      Math.round(num(m.scenario.perDay?.[`auction:${a.key}`] ?? DEFAULT_BIDS) * Math.max(runDays, 1 / 24)),
    );
    const reserve = num(a.reserve);
    const raise = (a.minRaise ?? 5) / 100;
    const price = bids ? reserve * (1 + raise) ** (bids - 1) : 0;
    const kept = sharesOf(a.split).reduce((n, s) => n + (s.bps ?? 0), 0) / 100;
    playerAction(bids / Math.max(runDays, 1));
    creator.fees += PROJECT_FEE / Math.max(runDays, 1);
    platform.project += PROJECT_FEE / Math.max(runDays, 1);
    const token = a.currency ?? game;
    // The sale happens once over the scenario: spread over its days, like everything else per day. Bids of NFTs move
    // no money: the winning bundle goes to the seller (or the treasury), and the rest back to their bidders.
    if (price && !a.bidNfts) {
      add(players.pay, token, price / scenarioDays);
      carryOut(a.split, token, price / scenarioDays, `auction:${a.key}`);
    }
    if (a.bidNfts) {
      return {
        key: a.key,
        name: a.name,
        bidNfts: true,
        runDays: round(runDays),
        bids,
        reserve: num(a.reserve ?? 1),
        expectedPrice: null,
        says: !bids
          ? 'no bids: the lot goes home'
          : `about ${numeral(bids)} bids over ${numeral(runDays)} days, each a bundle of up to three NFTs: the bundle with the most NFTs wins (at least ${asWritten(num(a.reserve ?? 1))}), so it goes for NFTs, not money, and nothing is counted in what players pay; every topped bundle goes back to its bidder at once`,
      };
    }
    return {
      key: a.key,
      name: a.name,
      token,
      runDays: round(runDays),
      bids,
      reserve,
      expectedPrice: round(bids ? price : 0),
      says: !bids
        ? 'no bids: the lot goes home'
        : `about ${numeral(bids)} bids over ${numeral(runDays)} days at a ${percentage(raise * 100)}% least raise ${reserve ? `end near ${numeral(price)} ${symbol(token)} (from a reserve of ${asWritten(reserve)})` : 'end at whatever players make it (no reserve)'}${kept ? `, of which the split takes ${kept}%` : ''}; every outbid bidder has their bid back at once`,
    };
  });
  for (const f of m.farms) playerAction(perDay('farm', f.key));
  /**
   * What many wallets could take from a grant a day, next to one: wallets are free, so per-wallet limits bound a person
   * only when the grant counts people (vouchers that name a person) or each claim must show something bought. `perDay`
   * caps it whatever happens. Leaves out a list (each entry is paid once) and codes that each pay a set number of times.
   */
  const MANY = MANY_WALLETS;
  const manyWallets = g => {
    const l = g.limits ?? {};
    const vouched = (g.vouchers ?? []).length > 0 || (g.keys ?? []).length > 0;
    const listed = (g.list ?? []).length > 0;
    if ((listed && !vouched) || ((g.keys ?? []).length && l.perKey && !(g.vouchers ?? []).length)) return {};
    // A limit per person: every wallet the issuer links to one person counts together, so more wallets take no more.
    if (byPerson(l)) {
      const each = l.perPersonEach?.count
        ? (l.perPersonEach.count * DAY) / Math.max(toSeconds(l.perPersonEach.every ?? '1d') || DAY, 1)
        : null;
      return {
        person: each !== null ? { one: round(each), per: 'a day' } : { one: l.perPerson, per: 'in all' },
      };
    }
    const who = vouched
      ? 'its voucher signer vouches for'
      : g.gate
        ? 'each showing what its gate asks'
        : '(free to make)';
    if (l.perWalletEach?.count) {
      const each = (l.perWalletEach.count * DAY) / Math.max(toSeconds(l.perWalletEach.every ?? '1d') || DAY, 1);
      const many = Math.min(MANY * each, l.perDay || Infinity);
      return {
        many: {
          one: round(each),
          all: round(many),
          per: 'a day',
          who,
          capped: Boolean(l.perDay && MANY * each > l.perDay),
        },
      };
    }
    if (!l.perWallet) return {};
    const many = Math.min(MANY * l.perWallet, l.total || Infinity);
    return {
      many: {
        one: l.perWallet,
        all: many,
        per: 'in all',
        who,
        capped: Boolean(l.total && MANY * l.perWallet > l.total),
        perDay: l.perDay ?? null,
      },
    };
  };
  // Grants: each claim's sender pays the player fee; its records' rent comes from the grant's funds (the owner's SOL, back when its shards close).
  const grants = m.grants.map(g => {
    const claims = num(m.scenario.perDay?.[`grant:${g.key}`]);
    playerAction(claims);
    creator.rent = (creator.rent ?? 0) + claims * claimRecordsRent(g);
    // Its prize, paid for by the grant's funds; a roll's order goes back to the winner at settle.
    const line = prizeLine(g.prize ?? g.gives);
    const each = givePrize(line, claims, `grant:${g.key}`, creator);
    return {
      key: g.key,
      name: g.name,
      claimsPerDay: claims,
      gives: prizeWords(line, m),
      fundsPerClaimSol: round(claimRecordsRent(g) + each),
      ...(line?.gives === 'roll' ? { orderHeldSol: round(orderHeld(line.box)) } : {}),
      ...manyWallets(g),
    };
  });
  for (const h of m.holds) playerAction(perDay('hold', h.key));
  for (const c of m.contests) playerAction(perDay('contest', c.key));

  // ---- the pools over time
  const settle = p => {
    const fixedIn = p.in.reduce((n, f) => n + f.perDay, 0);
    const fixedOut = p.out.reduce((n, f) => n + f.perDay, 0);
    const rate = p.rate.reduce((n, f) => n + f.perDay, 0);
    return { fixedIn, fixedOut, rate };
  };
  // A move schedule's share enters its target pool: three passes, so a target sees its source's level (and a chain of
  // moves two deep its source's source's).
  const levels = new Map();
  for (let pass = 0; pass < 3; pass += 1)
    for (const p of pools.values()) {
      const moved = [...pools.values()].flatMap(q =>
        q.rate.filter(r => r.to === p.key).map(r => r.perDay * (levels.get(q.key) ?? q.seed)),
      );
      const { fixedIn, fixedOut, rate } = settle(p);
      const inflow = fixedIn + moved.reduce((a, b) => a + b, 0);
      const net = inflow - fixedOut;
      const steady = rate > 0 ? net / rate : null;
      levels.set(p.key, steady !== null && steady > 0 ? steady : p.seed);
      p.inflow = inflow;
    }

  // Farms: everything that arrives in a farm's rewards vault is released to the seats over the farm's release span (its
  // longest lock, a day at least), by weight (stake × tier × boosts) as it is released; or a fixed rate for each seat,
  // or with `shared` for the whole farm (minted, or from the vault while it lasts). In a steady state the release pays
  // what arrives, a day at a time.
  /** A farm's ways out, in words (farm.rs): an early-exit fee, compounding; or null. */
  const farmExtras = f => {
    const exits = (f.tiers ?? [])
      .map((t, i) =>
        t.exitFee
          ? `tier ${i + 1} may leave before its ${t.lock} lock by leaving ${t.exitFee}% of what it takes out (${f.exitFeeTo === 'burn' ? 'burned' : f.exitFeeTo === 'rewards' ? 'into its own rewards vault' : `to ${String(f.exitFeeTo).replace(/^pool:/, '')}`}), keeping the rewards it was credited`
          : null,
      )
      .filter(Boolean);
    const parts = [
      ...exits,
      f.stakes !== 'collectibles' &&
        f.rewardsToken === f.stakes &&
        'its rewards can be compounded into the stake without restarting the lock',
      (f.tiers ?? []).some(t => t.earnsFor) &&
        `a seat earns only for its tier’s term (${(f.tiers ?? []).map(t => t.earnsFor ?? 'no end').join(', ')}) after its lock started`,
    ].filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  };
  /** What a seat of `f` can give up (farm.rs `Farm::give`): a forfeit, a watched NFT gone. */
  const giveBacks = f => ['a forfeit', f.custody === 'watch' && 'a watched NFT sold'].filter(Boolean).join(', ');
  const farmRows = m.farms.map(f => {
    const pool = pools.get(`farm:${f.key}`);
    const staked = num(m.scenario.staked?.[f.key]);
    const perUnit = f.rate ? num(f.rate.perDay) : null;
    // A rate that halves (by time from the farm's opening, farm.rs `paid`): what it pays a day on average over the scenario.
    const halving = f.rate?.halveEvery ? halvedSum(days, toSeconds(f.rate.halveEvery) / DAY) / days : 1;
    const wanted = !f.rate ? Infinity : (f.rate.shared ? (staked ? perUnit : 0) : perUnit * staked) * halving;
    const free = pool ? Math.max(0, pool.inflow - pool.out.reduce((n, x) => n + x.perDay, 0)) : 0;
    const rewards = f.rate?.minted
      ? wanted
      : Math.min(wanted, f.rate ? free + (pool?.seed ?? 0) / Math.max(1, m.scenario.days ?? 30) : free);
    if (pool && !f.rate?.minted) pool.out.push({ by: `farm:${f.key}`, perDay: rewards });
    const sameToken = f.rewardsToken === f.stakes;
    const tiers = (f.tiers ?? [{ lock: 0, multiplier: 1 }]).map(t => ({
      lock: t.lock,
      multiplier: t.multiplier ?? 1,
      ...(t.earnsFor ? { earnsFor: t.earnsFor } : {}),
      ...(prizeLine(t.prize) ? { prize: prizeWords(t.prize, m) } : {}),
    }));
    const unit = f.stakes === 'collectibles' ? 'collectible' : symbol(f.stakes);
    // Growth: the days a collectible at x1 needs for each level.
    const growth = listOf(f.growth).map(g => {
      const levels = (g.levels ?? []).map((points, i) => ({ level: i + 1, points, days: round(points / g.perDay, 2) }));
      return {
        attribute: g.attribute ?? 'xp',
        perDay: g.perDay,
        ...(levels.length ? { level: g.level ?? 'level', levels } : {}),
        streak: Boolean(g.streak),
      };
    });
    const perSeat = !f.rate ? null : f.rate.shared ? (staked ? perUnit / staked : null) : perUnit;
    return {
      key: f.key,
      name: f.name,
      stakes: f.stakes,
      rewardsToken: f.rewardsToken,
      rewardsPerDay: round(rewards),
      ...(f.rate
        ? {
            rate: {
              perDay: perUnit,
              minted: Boolean(f.rate.minted),
              ...(f.rate.shared ? { shared: true } : {}),
              ...(f.rate.halveEvery ? { halveEvery: f.rate.halveEvery } : {}),
            },
          }
        : {}),
      tiers,
      ...(staked
        ? { staked, perUnitPerDay: round(f.rate ? perSeat : rewards / staked), unit }
        : f.rate && !f.rate.shared
          ? { perUnitPerDay: perUnit, unit }
          : {}),
      ...(staked && sameToken ? { yearlyPercent: round(((rewards * 365) / staked) * 100, 4) } : {}),
      ...(growth.length ? { growth } : {}),
      ...(f.runs ? { runs: f.runs } : {}),
      ...(farmEndWords(f) ? { end: farmEndWords(f) } : {}),
      ...(f.lockAttribute ? { lockAttribute: f.lockAttribute } : {}),
      ...(f.upkeepAttribute ? { upkeepAttribute: f.upkeepAttribute } : {}),
      ...(farmExtras(f) ? { extras: farmExtras(f) } : {}),
      says: f.rate
        ? `${f.rate.shared ? `the farm pays ${numeral(perUnit)} a day in all, shared by weight while anything is staked` : `each seat earns ${numeral(perUnit)} a day for each ${unit} at x1, whoever else is in`}${f.rate.halveEvery ? `, halving every ${f.rate.halveEvery}` : ''}${f.rate.minted ? ' (minted when a seat is paid, as far as the mint has room for: what it can’t mint is not owed later)' : ', while its vault lasts'}${perUnit > 0 ? `; what a seat gives back (${giveBacks(f)}) is ${f.rate.minted ? 'never minted' : 'left free in its vault'}, never to the other seats` : ''}`
        : `what lands in its rewards vault is released over ${releaseWords(f)} to the seats there as it is released, so a stake earns only while it stays; ${tiers.length > 1 || (f.boosts ?? []).length ? 'shares are by weight: a higher tier or a boosted collectible takes more of the same rewards, so the figures are for a seat at x1 among seats at x1' : 'shares are by what each seat stakes'}`,
    };
  });
  for (const row of farmRows) add(players.get, row.rewardsToken, row.rewardsPerDay);
  // A farm that ends inside the scenario takes no stake from its end on (FarmOver), and pays nothing after it.
  for (const f of m.farms.filter(x => x.runs && toSeconds(x.runs) < days * DAY))
    notes.push(
      `“${f.name ?? f.key}” runs ${f.runs}, less than the scenario’s ${numeral(days)} days: its figures are a day while it runs; from its end it takes no stake and pays nothing.`,
    );

  // Lotteries pay what came in, once the pot is in its steady state; one that draws once pays its seed and all that
  // came in, at its one draw.
  for (const l of lotteries) {
    const pool = pools.get(`lottery:${l.key}`);
    const run = lotteryRun.get(l.key);
    const placesTotal = l.placesPercent / 100;
    // A pot pays what came in once it is steady; a round paid from its own money pays its places' percents of it, the
    // rest gone to `rest` already.
    const inflow = pool ? pool.inflow : (l.roundMoneyPerDay ?? 0) * placesTotal;
    pool?.out.push({ by: `lottery:${l.key}`, perDay: inflow });
    const potBeforeDraw = !pool
      ? (l.roundMoneyPerDay ?? 0) * (run.once ? run.spreadDays : l.roundDays)
      : run.once
        ? run.seed + inflow * run.spreadDays
        : placesTotal
          ? (inflow * l.roundDays) / placesTotal
          : 0;
    const paid = run.once || !pool ? potBeforeDraw * placesTotal : inflow * l.roundDays;
    l.potBeforeDraw = round(potBeforeDraw);
    if (!pool) l.roundMoneyPerDay = round(l.roundMoneyPerDay ?? 0);
    l.paidPerRound = round(paid);
    l.prizes = l.places.map(pct => round((potBeforeDraw * pct) / 100));
    const perTicket = l.ticketsPerRound ? (paid + l.prizeWorthPerRound) / l.ticketsPerRound : null;
    l.expectedPerTicket = perTicket === null ? null : round(perTicket);
    // A no-loss ticket comes back whole, so it returns its price and its share of the pot on top.
    l.returnPercent =
      perTicket !== null && l.price && l.token === l.potToken && !l.unpricedPrizes
        ? round((perTicket / l.price) * 100 + (l.noLoss ? 100 : 0), 4)
        : null;
    // A pot that draws again starts with its seed: its first draw pays its places' share of the seed and the round's
    // money (lottery.rs: the pot as it stands, the round's part with it), and each draw after pays its share of what
    // the one before left, so the seed is paid out over the rounds (all of it at once when the places take 100%).
    let fromSeed = 0;
    if (pool && !run.once && run.seed > 0 && placesTotal > 0) {
      const firstPot = run.seed + inflow * l.roundDays;
      l.firstPotBeforeDraw = round(firstPot);
      l.firstPrizes = l.places.map(pct => round((firstPot * pct) / 100));
      const rounds = Math.max(1, Math.floor(scenarioDays / (l.roundDays || 1)));
      fromSeed = run.seed * (1 - (1 - Math.min(1, placesTotal)) ** rounds);
    }
    add(players.get, l.potToken, (run.once ? paid / run.spreadDays : inflow) + fromSeed / scenarioDays);
  }

  const poolRows = [...pools.values()].map(p => {
    const { fixedOut, rate } = settle(p);
    const inflow = p.inflow ?? 0;
    const net = inflow - fixedOut;
    const row = {
      key: p.key,
      ...(p.pot ? { pot: p.pot } : {}),
      ...(p.farm ? { farm: p.farm } : {}),
      token: p.currency,
      seed: p.seed,
      inPerDay: round(inflow),
      outPerDay: round(fixedOut + rate * (levels.get(p.key) ?? p.seed)),
      ins: p.in.map(f => ({ by: f.by, perDay: round(f.perDay) })),
      outs: [
        ...p.out.map(f => ({ by: f.by, perDay: round(f.perDay) })),
        ...p.rate.map(f => ({ by: f.by, percentPerDay: round(f.perDay * 100, 6) })),
      ],
    };
    if (rate > 0 && Math.abs(net) < 1e-12) {
      // Only a share goes out: it shrinks by that share for ever, and never quite empties.
      row.after = round(p.seed * Math.exp(-rate * days));
      row.halfLifeDays = round(Math.log(2) / rate, 2);
      row.lasts = 'shrinks';
    } else if (rate > 0) {
      const steady = net / rate;
      if (steady > 0) {
        row.settlesAt = round(steady);
        row.after = round(steady + (p.seed - steady) * Math.exp(-rate * days));
        row.lasts = 'settles';
      } else {
        // B(t) = B* + (B0 − B*)e^(−rt) reaches 0 at t = ln((B0 − B*) / −B*) / r
        const t = p.seed > 0 ? Math.log((p.seed - steady) / -steady) / rate : 0;
        row.lastsDays = round(t, 2);
        row.after = 0;
        row.lasts = 'runs dry';
      }
    } else if (net < -1e-12) {
      row.lastsDays = round(p.seed / -net, 2);
      row.after = round(Math.max(0, p.seed + net * days));
      row.lasts = 'runs dry';
    } else {
      row.after = round(p.seed + net * days);
      row.lasts = net > 1e-12 ? 'grows' : 'holds';
    }
    // A pool a halving schedule fills or drains: walked a day at a time over the scenario, each such flow at what its
    // runs that day pay (halved once for every `halveEvery` runs before them, none after `maxRuns`), the rest at its
    // average.
    if ([...p.in, ...p.out].some(f => f.halves)) {
      const today = (f, d) => {
        if (!f.halves) return f.perDay;
        const { amount, runsPerDay, halveEvery, maxRuns } = f.halves;
        const run = d * runsPerDay;
        if (run >= maxRuns) return 0;
        return runsPerDay * amount * (halveEvery ? 2 ** -Math.floor(run / halveEvery) : 1);
      };
      const moved = inflow - p.in.reduce((n, f) => n + f.perDay, 0);
      let held = p.seed;
      let dry = null;
      for (let d = 0; d < days && dry === null; d += 1) {
        const net = moved + p.in.reduce((n, f) => n + today(f, d), 0) - p.out.reduce((n, f) => n + today(f, d), 0);
        const next = held + net - rate * held;
        if (next < 0) dry = d + held / Math.max(held - next, 1e-12);
        else held = next;
      }
      for (const k of ['settlesAt', 'halfLifeDays']) delete row[k];
      if (dry !== null) Object.assign(row, { lasts: 'runs dry', lastsDays: round(dry, 2), after: 0 });
      else Object.assign(row, { lasts: 'walked', after: round(held) });
    }
    if (p.variance > 0) {
      row.swingPerDay = round(Math.sqrt(p.variance), 6);
      const weekly = Math.sqrt(p.variance * 7);
      if (row.lasts !== 'runs dry' && p.seed < 3 * weekly)
        notes.push(
          `The pool “${p.key}” ${row.lasts === 'grows' ? 'takes in more than it pays on average' : row.lasts === 'settles' ? 'settles on average' : 'pays even on average'}, but luck moves it by about ±${numeral(row.swingPerDay, 3)} ${symbol(p.currency)} a day (±${numeral(weekly, 3)} a week), against a seed of ${asWritten(p.seed)}. While it can’t cover a fixed prize, a box that stops selling when out (the default) sells nothing, and one that draws among what is left never lands on that prize, so a bad week stalls sales or takes the big wins away until it refills. A seed of about ${numeral(3 * weekly, 3)} (three times a week’s swing) rides out almost any week.`,
        );
    }
    if (row.lasts === 'runs dry')
      notes.push(
        `The pool “${p.key}” pays out more than comes in: it lasts about ${numeral(row.lastsDays)} days from its seed of ${asWritten(p.seed)} ${symbol(p.currency)}.`,
      );
    return row;
  });

  for (const prize of sharePrizes) {
    const row = poolRows.find(r => r.key === prize.pool);
    const level = row ? (row.settlesAt ?? row.seed) : 0;
    if (prize.account) sendTo(destination(prize.account), row?.token, prize.rate * level, prize.by);
    else add(players.get, row?.token, prize.rate * level);
  }
  // A share burned is burned at the pool's level, as a share paid out is.
  for (const b of shareBurns) {
    const row = poolRows.find(r => r.key === b.pool);
    add(burned, row?.token, b.rate * (row ? (row.settlesAt ?? row.seed) : 0));
  }
  // Stashes: each roll that lands on one takes an NFT out; how long what it starts with lasts.
  for (const r of prizeTakes) {
    const b = m.box.get(r.box);
    const w = b ? weights(b) : [];
    const total = w.reduce((a, x) => a + x, 0) || 1;
    (b?.outcomes ?? []).forEach((o, i) =>
      outcomeParts(o).forEach(
        x =>
          (x.gives === 'stash' || x.gives === 'nft') &&
          stashTakes.push({ stash: x.stash, perDay: (r.perDay * w[i]) / total, by: r.by }),
      ),
    );
  }
  // What fills a stash besides its owner: NFTs paid as a price (a box's `then`, a recipe's trade-in, a lottery's ticket).
  const stashFills = [];
  for (const b of m.boxes.filter(b => b.rollsOn && b.active !== false)) {
    const w = weights(b);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    (b.outcomes ?? []).forEach(
      (o, i) =>
        (o.then ?? b.then)?.stash &&
        stashFills.push({
          stash: (o.then ?? b.then).stash,
          perDay: (perDay('box', b.key) * w[i]) / total,
          by: `box:${b.key}`,
        }),
    );
  }
  for (const r of m.recipes)
    for (const l of r.in ?? [])
      if (l.takes === 'trade' && l.then?.stash)
        stashFills.push({ stash: l.then.stash, perDay: perDay('recipe', r.key), by: `recipe:${r.key}` });
  for (const l of m.lotteries)
    if (l.ticketNft?.then?.stash)
      stashFills.push({ stash: l.ticketNft.then.stash, perDay: perDay('lottery', l.key), by: `lottery:${l.key}` });
  const stashes = m.stashes.map(s => {
    const takes = stashTakes.filter(t => t.stash === s.key);
    const fills = stashFills.filter(t => t.stash === s.key);
    const perDay = takes.reduce((n, t) => n + t.perDay, 0);
    const inPerDay = fills.reduce((n, t) => n + t.perDay, 0);
    const holds = (s.nfts ?? []).length;
    const net = perDay - inPerDay;
    const filled =
      inPerDay > 0
        ? `, and takes in about ${numeral(inPerDay, 4)} a day (${[...new Set(fills.map(t => t.by))].join(', ')})`
        : '';
    if (perDay > 0 && net > 0)
      notes.push(
        `The stash “${s.name}” starts with ${numeral(holds)} NFT${holds === 1 ? '' : 's'} and gives about ${numeral(perDay, 4)} a day (${[...new Set(takes.map(t => t.by))].join(', ')})${filled}: ${holds ? `empty in about ${numeral(holds / net, 3)} days` : 'empty from the start'}, after which a draw that lands on its outcome is not made, and gives back that draw’s worth, until more are put in.`,
      );
    else if (perDay > 0)
      notes.push(
        `The stash “${s.name}” starts with ${numeral(holds)} NFT${holds === 1 ? '' : 's'}, gives about ${numeral(perDay, 4)} a day (${[...new Set(takes.map(t => t.by))].join(', ')})${filled}: it keeps up${holds ? '' : ', once the first come in (until then a draw that lands on its outcome is not made)'}.`,
      );
    return {
      key: s.key,
      name: s.name,
      holds,
      givenPerDay: round(perDay, 6),
      ...(inPerDay > 0 ? { takenInPerDay: round(inPerDay, 6) } : {}),
      ...(net > 0 ? { lastsDays: round(holds / net, 4) } : {}),
    };
  });
  const contestRolls = m.contests.filter(c => prizeLine(c.prize)?.gives === 'roll');
  if (contestRolls.length)
    notes.push(
      `${contestRolls.map(c => `“${c.name}”`).join(', ')} give${contestRolls.length === 1 ? 's' : ''} every winning entry a roll: whoever claims it pays the roll’s order (about ${numeral(orderHeld(prizeLine(contestRolls[0].prize).box), 3)} SOL, back to the winner at settle), and whoever asks for the roll pays the oracle.`,
    );
  for (const t of m.tokens.values())
    if (t.powers?.transferFeePercent > 0)
      notes.push(
        `${t.symbol} keeps ${t.powers.transferFeePercent}% of every transfer: pools, prizes, stakes and the treasury receive that much less than shown here.`,
      );

  const totals = map => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, round(v)]));
  return {
    scenario: {
      days,
      perDay: m.scenario.perDay ?? {},
      defaultPerDay: DEFAULT_PER_DAY,
      defaultBidsPerDay: DEFAULT_BIDS,
      defaultClaimsPerDay: 0,
    },
    boxes,
    items,
    payments,
    recipes,
    schedules,
    lotteries,
    farms: farmRows,
    grants,
    contests,
    auctions,
    stashes,
    pools: poolRows,
    perDay: {
      players: {
        pay: totals(players.pay),
        getBack: totals(players.get),
        playerFeesSol: round(players.fees),
        oracleFeesSol: round(players.oracle),
        networkFeesSol: round(players.network),
        rentSol: round(players.rent),
      },
      creator: {
        treasury: totals(creator.treasury),
        projectFeesSol: round(creator.fees),
        oracleFeesSol: round(creator.oracle),
        networkFeesSol: round(creator.network),
        grantRentSol: round(creator.rent ?? 0),
      },
      oracle: { totalSol: round(players.oracle + creator.oracle) },
      platform: {
        playerFeesSol: round(platform.player),
        projectFeesSol: round(platform.project),
        totalSol: round(platform.player + platform.project),
      },
      burned: totals(burned),
      accounts: totals(accounts),
    },
    fees: {
      playerSol: PLAYER_FEE,
      projectSol: PROJECT_FEE,
      oracleSol: ORACLE,
      networkPerSignatureSol: NETWORK_FEE,
      settleRentUnitSol: sol(SETTLE_RENT_UNIT),
      ticketLineRentSol: round(ticketLine({})),
      collectibleRentSol: COLLECTIBLE_RENT,
      burnRefundSol: BURN_REFUND,
    },
    notes,
  };
}

/** What the scenario doesn't name and doesn't count at its default, in words: ["grant claims none", "auction bids 10 a day"]. */
export function unnamedExceptions(sim) {
  const named = k => Object.hasOwn(sim.scenario.perDay ?? {}, k);
  return [
    (sim.grants ?? []).some(g => !named(`grant:${g.key}`)) && 'grant claims none',
    (sim.auctions ?? []).some(a => !named(`auction:${a.key}`)) && `auction bids ${DEFAULT_BIDS} a day`,
  ].filter(Boolean);
}
/** What the scenario assumes for what it doesn't name, in words: "100 a day (grant claims none, auction bids 10 a day)". */
export function unnamedWords(sim) {
  const except = unnamedExceptions(sim);
  return `${asWritten(sim.scenario.defaultPerDay)} a day${except.length ? ` (${except.join(', ')})` : ''}`;
}

/** What becomes of a pool (a row of `simulate`'s pools) over the scenario's `days`, in words: "settles at about 40". */
export function poolFate(p, days) {
  if (p.lasts === 'runs dry') return `runs dry in about ${numeral(p.lastsDays)} days`;
  if (p.lasts === 'settles') return `settles at about ${numeral(p.settlesAt)}`;
  if (p.lasts === 'shrinks')
    return `shrinks to about ${numeral(p.after)} after ${numeral(days)} days (half gone every ${numeral(p.halfLifeDays)} days)`;
  if (p.lasts === 'grows') return `grows to about ${numeral(p.after)} after ${numeral(days)} days`;
  if (p.lasts === 'walked')
    return `holds about ${numeral(p.after)} after ${numeral(days)} days, as what halves changes it day by day`;
  return 'holds steady';
}

/**
 * What a box's return is counted against when its price rises or falls (a row of `simulate`'s boxes with an
 * `averagePrice`): what the scenario's opens pay on average, which is not the price it goes live at.
 */
export const priceBasis = (b, symbol) =>
  `the ${numeral(b.averagePrice)} ${symbol} an open pays on average over the scenario`;

/**
 * A player's real cost of one action in words: the one number to quote. "about 0.0071 SOL in all (the price, the
 * player fee, …); the wallet needs 0.0151 SOL when it signs, and the rest comes back". A price that rises or falls is
 * the listed one, and the words say so and how it moves.
 */
export function inAll(c) {
  if (!c) return '';
  const parts = [
    'the player fee',
    c.oracleSol ? 'the oracle' : '',
    'the network',
    c.rentSol ? (/comes back/.test(c.rentIs) ? c.rentIs : `${c.rentIs}, which never comes back`) : '',
  ]
    .filter(Boolean)
    .join(', ');
  // after what the figure is made of, so the parentheses read as the figure's and not the rise's
  const moved = c.priceMoves ? `, and the price ${c.priceMoves.replace(/^which /, '')}` : '';
  const head =
    c.totalSol !== undefined
      ? `about ${numeral(c.totalSol)} SOL in all${c.atLeast ? ' at the least amount' : ''}${c.priceMoves ? ' at its listed price' : ''} (${c.priceBack ? '' : 'the price, '}${parts})${moved}`
      : `${numeral(c.extrasSol)} SOL on top of the price (${parts})${moved}`;
  return c.holdSol > (c.totalSol ?? c.extrasSol) + 1e-9
    ? `${head}; the wallet needs about ${numeral(c.holdSol)} SOL when it signs, and the rest${c.heldIs ? ` (${c.heldIs})` : ''} comes back`
    : head;
}

/** The simulation in plain words. */
/** One part of a box's outcome in words, as the simulation names it (`sym`: a token's key to its symbol). */
export const outcomePartWords = (o, sym) =>
  o.gives === 'pay'
    ? `${asWritten(o.amount)} ${sym(o.token)} from ${o.pool}`
    : o.gives === 'mint'
      ? `${asWritten(o.amount)} ${sym(o.token)}, minted`
      : o.gives === 'stash'
        ? `an NFT of the stash “${o.stash}”, at random`
        : o.gives === 'nft'
          ? `the NFT ${String(o.nft).slice(0, 4)}… of “${o.stash}”`
          : o.gives === 'roll'
            ? `a roll of “${o.box}”`
            : o.gives === 'item'
              ? `${o.item}${o.worth !== null ? ` (worth ${asWritten(o.worth)})` : ' (no value given)'}`
              : o.gives;

export function explain(sim, economy) {
  const m = model(economy);
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const lines = [];
  lines.push(
    `Assuming ${
      Object.entries(sim.scenario.perDay)
        .map(([k, v]) => `${numeral(v)} × ${k}`)
        .join(', ') || 'nothing in particular'
    } a day (anything not named: ${unnamedWords(sim)}), over ${asWritten(sim.scenario.days)} days.`,
  );
  for (const b of sim.boxes) {
    const edge =
      b.houseEdgePercent !== null
        ? `; the game keeps ${percentage(b.houseEdgePercent)}% of ${b.averagePrice !== undefined ? 'what an open pays, on average' : 'each price'}`
        : '';
    const also = Object.entries(b.alsoPays).map(([t, v]) => `${numeral(v)} ${sym(t)}`);
    const back =
      b.returnPercent !== null
        ? `${numeral(b.expectedBack)} ${sym(b.token)} on average (${percentage(b.returnPercent)}%${b.averagePrice !== undefined ? ` of ${priceBasis(b, sym(b.token))}` : ''})${also.length ? ` and ${also.join(', ')}` : ''}`
        : `${also.join(', ') || 'nothing'} on average`;
    const all = `; ${inAll(b.realCost)}`;
    lines.push(
      `Box “${b.name}”: costs ${asWritten(b.price)} ${sym(b.token)} (${all.slice(2)}), gives back ${back}${edge}.`,
    );
    const part = o => outcomePartWords(o, sym);
    for (const o of b.outcomes)
      lines.push(`  ${percentage(o.chance, 6)}%: ${o.gives === 'bundle' ? o.prizes.map(part).join(' + ') : part(o)}`);
    if (b.unpriced.length) lines.push(`  Give ${b.unpriced.join(', ')} a "value" to count them in the return.`);
    if (b.limitedStock) lines.push(`  ${whenOutWords(m.box.get(b.key))}.`);
  }
  for (const it of sim.items)
    lines.push(`Shop “${it.name}”: ${asWritten(it.price)} ${sym(it.token)}; ${inAll(it.realCost)}.`);
  for (const p of sim.payments)
    lines.push(
      `Payment “${p.name}”: ${p.atLeast ? 'at least ' : ''}${asWritten(p.amount)} ${sym(p.token)}; ${inAll(p.realCost)}.`,
    );
  for (const l of sim.lotteries) {
    const rounds = l.drawsOnce
      ? `${numeral(l.ticketsPerRound)} tickets in its one round of ${numeral(l.roundDays)} days (it draws once)`
      : `${numeral(l.ticketsPerRound)} tickets a round of ${numeral(l.roundDays)} days`;
    const from =
      l.rest !== undefined
        ? `each round pays from its own ticket money, about ${numeral(l.potBeforeDraw)} ${sym(l.potToken)}, what its places leave going to “${l.rest}”,`
        : `the pot reaches about ${numeral(l.potBeforeDraw)} ${sym(l.potToken)} and`;
    lines.push(
      `Lottery “${l.name}”: ${rounds}; ${from} pays ${l.prizes.map((v, i) => `${numeral(v)}${l.placePrizes?.[i] ? ` and ${l.placePrizes[i]}` : ''}${l.placeTimes?.[i] > 1 ? ` ×${l.placeTimes[i]}` : ''}`).join(' / ')}${l.firstPrizes ? ` (its first draw, with the seed, ${l.firstPrizes.map(v => numeral(v)).join(' / ')})` : ''}; ${l.ticketNft ? (l.noLoss ? 'a ticket (one NFT, back to its buyer after the draw)' : 'a ticket (one NFT, spent at once, never refunded)') : `a ${asWritten(l.price)} ${sym(l.token)} ticket${l.noLoss ? ' (back to its buyer after the draw)' : ''}`} ${l.noLoss ? 'wins' : 'is worth'} ${numeral(l.expectedPerTicket)} ${sym(l.potToken)} on average${l.noLoss ? ' on top' : ''}${l.unpricedPrizes ? ', plus its chance at the places’ prizes (no price given)' : ''}${l.returnPercent !== null ? ` (${percentage(l.returnPercent)}%${l.noLoss ? ' back, the ticket included' : ''})` : ''}; one ticket bought alone: ${inAll(l.realCost)}.`,
    );
    if (l.minSold)
      lines.push(
        `  Fewer than ${asWritten(l.minSold)} tickets sold by the draw: the round is cancelled and every ticket refunded.`,
      );
  }
  for (const f of sim.farms) {
    lines.push(
      `Farm “${f.name}”: ${numeral(f.rewardsPerDay)} ${sym(f.rewardsToken)} a day to everyone staked${f.perUnitPerDay !== undefined ? `, ${numeral(f.perUnitPerDay)} a day for each ${f.unit} staked` : ''}${f.yearlyPercent !== undefined ? ` (${percentage(f.yearlyPercent)}% a year)` : ''}; ${f.says}.`,
    );
    if (f.extras) lines.push(`  ${f.extras[0].toUpperCase()}${f.extras.slice(1)}.`);
    for (const g of f.growth ?? [])
      lines.push(
        `  Growth: ${asWritten(g.perDay)} ${g.attribute} a day at x1${g.levels ? `; ${g.levels.map(l => `level ${l.level} after ${numeral(l.days)} days`).join(', ')}` : ''}${g.streak ? ', back to 0 when it leaves' : ''}.`,
      );
    if (f.runs)
      lines.push(
        `  Runs ${f.runs} from when it goes live: it takes no stake at its end or after it, and pays and grows nothing more${f.end ? `; ${f.end}` : ''}.`,
      );
    if (f.lockAttribute)
      lines.push(
        `  Its lock is written on each collectible under “${f.lockAttribute}”: whatever moves that time lets it out sooner or keeps it longer.`,
      );
    if (f.upkeepAttribute)
      lines.push(
        `  Upkeep: each collectible earns and grows only until the time under “${f.upkeepAttribute}”; the figures assume every one is kept topped up.`,
      );
    for (const t of f.tiers.filter(t => t.prize))
      lines.push(`  Mission (lock ${t.lock}): ${t.prize} for each one that stays it (tokens grown by its boosts).`);
  }
  for (const g of sim.grants)
    lines.push(
      `Grant “${g.name}”: ${numeral(g.claimsPerDay)} claims a day, each giving ${g.gives}; each claim costs its funds about ${numeral(g.fundsPerClaimSol)} SOL${g.orderHeldSol ? ` (${numeral(g.orderHeldSol)} of it the roll’s order, which goes to the winner when it is settled; whoever asks for the roll pays the oracle)` : ''}.${g.many ? ` One wallet may claim ${numeral(g.many.one)} ${g.many.per}; ${MANY_WALLETS} wallets ${g.many.who} could claim ${numeral(g.many.all)} ${g.many.per}${g.many.capped ? `, its "${g.many.per === 'a day' ? 'perDay' : 'total'}" the cap` : ''}${g.many.perDay ? `, at most ${numeral(g.many.perDay)} a day` : ''}.` : ''}${g.person ? ` One person may claim ${numeral(g.person.one)} ${g.person.per}, whichever of their wallets claims: every wallet the issuer links to them counts together.` : ''}`,
    );
  for (const s of sim.stashes ?? [])
    lines.push(
      `Stash “${s.name}”: ${asWritten(s.holds)} NFT${s.holds === 1 ? '' : 's'} to start${s.takenInPerDay ? `, about ${numeral(s.takenInPerDay)} a day come in` : ''}${s.lastsDays !== undefined ? `, given at about ${numeral(s.givenPerDay)} a day: lasts about ${numeral(s.lastsDays)} days` : s.givenPerDay ? `, given at about ${numeral(s.givenPerDay)} a day` : ''}.`,
    );
  for (const r of sim.recipes)
    lines.push(
      `Recipe “${r.name}”: ${r.takes.join(' + ') || 'nothing'} → ${r.gives.join(' + ') || 'nothing'}, ${numeral(r.craftsPerDay)} a day.`,
    );
  for (const s of sim.schedules)
    lines.push(`Schedule “${s.key}”: ${s.says}; ${lateRunWords(m.schedules.find(x => x.key === s.key) ?? {})}.`);
  for (const c of sim.contests) lines.push(`Contest “${c.name}”: ${c.says}.`);
  for (const a of sim.auctions ?? []) lines.push(`Auction “${a.name}”: ${a.says}.`);
  for (const p of sim.pools)
    lines.push(
      `${p.pot ? `The pot of “${p.pot}”` : p.farm ? `The rewards vault of “${p.farm}”` : `Pool “${p.key}”`}: ${numeral(p.inPerDay)} ${sym(p.token)} in and ${numeral(p.outPerDay)} out a day from a seed of ${asWritten(p.seed)}; it ${poolFate(p, sim.scenario.days)}.`,
    );
  const d = sim.perDay;
  const list = map =>
    Object.entries(map)
      .map(([k, v]) => `${numeral(v)} ${sym(k)}`)
      .join(', ') || 'nothing';
  lines.push(
    `Each day players pay ${list(d.players.pay)} and get back ${list(d.players.getBack)} on average (items at the value you gave them), plus ${numeral(d.players.playerFeesSol)} SOL in player fees, ${numeral(d.players.oracleFeesSol)} SOL to MagicBlock’s oracle and ${numeral(d.players.networkFeesSol)} SOL in network fees.`,
  );
  if (d.creator.oracleFeesSol) {
    // Every roll the simulation counts as the project's: a draw, a roll a lottery's place or a grant gives, the authority's.
    const what = [
      sim.lotteries.length && 'lottery draws',
      m.lotteries.some(l => (l.places ?? []).some(p => placeOf(p).prize?.gives === 'roll')) &&
        'the rolls lottery places give',
      sim.grants.some(
        g => g.claimsPerDay > 0 && prizeLine(m.grant.get(g.key)?.prize ?? m.grant.get(g.key)?.gives)?.gives === 'roll',
      ) && 'the rolls grants give',
      m.decisions.some(x => x.does === 'roll' && Number(x.perDay) > 0) && 'the authority’s rolls',
    ].filter(Boolean);
    const words = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : (what[0] ?? 'its rolls');
    lines.push(
      `The oracle also takes about ${numeral(d.creator.oracleFeesSol)} SOL a day for ${words}, from whoever asks for them: anyone may (a player's page, or a ticket bought once a draw is due, sends it).`,
    );
  }
  lines.push(
    `The treasury gets ${list(d.creator.treasury)} a day; burned: ${list(d.burned)}. The platform’s fees: ${numeral(d.platform.totalSol)} SOL a day.`,
  );
  for (const note of sim.notes) lines.push(note);
  return lines.join('\n');
}
