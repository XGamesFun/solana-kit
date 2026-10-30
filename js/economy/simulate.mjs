// The quick simulation: expected values from the spec alone, instant. What each box, ticket and craft is worth
// against its price, the house edge, each pool's money in and out per day and how long it lasts, and who pays what:
// players, the owner, the platform's fees. Amounts are in whole units of their token. Pure.
//
// It assumes the scenario's counts (`scenario.perDay`, default 100 of each player action a day) arrive evenly,
// odds as written (stock odds start where the table starts), and one ticket per lottery purchase. Shares of a
// pool are worked out continuously, so a pool that pays a share of itself settles at a level instead of emptying.
// It is a guide, not a promise: the full simulation (js/sim) runs the real program.
import { ACCOUNT_BYTES, receiptBytes } from '../client/index.js';
import { boxBuys, boxRolls, COLLECTIBLE_RENT as COLLECTIBLE_RENT_LAMPORTS, outcomeBurns, outcomeParts, ESCROW_LAMPORTS, FEES, LAMPORTS_PER_SOL, ORACLE_FEE, RENT_PER_BYTE, SIGNATURE_FEE, destination, listOf, lotterySplit, model, placeOf, prizeLine, prizePool, prizeToken, farmEndWords, prizeWords, releaseWords, sharesOf, toBps, toSeconds, toTime, weights } from './model.mjs';

const DAY = 86_400;
const DEFAULT_PER_DAY = 100;
/** Bids a day on an auction the scenario doesn't name (`auction:<key>`); a grant it doesn't name is claimed by nobody. */
const DEFAULT_BIDS = 10;
const sol = (lamports) => Number(lamports) / Number(LAMPORTS_PER_SOL);
const PLAYER_FEE = sol(FEES.player);
const PROJECT_FEE = sol(FEES.project);
const NETWORK_FEE = sol(SIGNATURE_FEE);
/** MagicBlock's oracle, per random number: a box's open (the player), a lottery's draw, a `roll` (model.mjs ORACLE_FEE). */
const ORACLE = sol(ORACLE_FEE);
/** A lottery purchase's record: rent the buyer pays and gets back once the round is done with it (lottery.rs). */
const TICKET_LINE = sol((BigInt(ACCOUNT_BYTES.LotteryContribution) + 128n) * RENT_PER_BYTE);
/** A collectible's Core account, paid from the SOL the order holds: its rent and Core's creation fee (model.mjs). */
const COLLECTIBLE_RENT = sol(COLLECTIBLE_RENT_LAMPORTS);
/** What a collectible a recipe burns gives back: its rent less one byte's (Core leaves a 1-byte account that keeps
 * the creation fee). 189 bytes × 5,080 lamports, measured by the full simulation. */
const BURN_REFUND = 0.00096;
/** A grant's wallet receipt at its first voucher: the current header plus one round hash. */
const RECEIPT_RENT = sol((BigInt(receiptBytes(1)) + 128n) * RENT_PER_BYTE);
/** A wallet's token account, which a grant that pays tokens opens from its funds when the winner has none. */
const TOKEN_ACCOUNT_RENT = sol((165n + 128n) * RENT_PER_BYTE);
/** The order's fixed allocation, returned at settle or refund. */
const ORDER_RENT = sol((BigInt(ACCOUNT_BYTES.Order) + 128n) * RENT_PER_BYTE);
const num = (v) => (v === undefined || v === null ? 0 : Number(v));
export const round = (x, digits = 9) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : x);

/**
 * What one action takes from the player's wallet for good, and what the wallet must hold when it signs. `totalSol`
 * (only for a price in SOL) is the price, the platform's fee, the oracle's, the network's and rent that never comes
 * back (a collectible's own): the one number to tell a person. `holdSol` adds what comes back later (`held`, named by
 * `heldIs`: the SOL an order holds and its account, a ticket purchase's record) and, for SOL, the wrapped-SOL account a
 * purchase opens and closes again. A price that comes back (`priceBack`: a no-loss ticket) is held, not spent.
 */
function realCostOf({ price, token, isSol, oracle = 0, signatures = 1, rent = 0, rentIs = '', held = 0, heldIs = '', priceBack = false, atLeast = false }) {
  const extrasSol = PLAYER_FEE + oracle + signatures * NETWORK_FEE + rent;
  const hold = extrasSol - rent + held + (isSol ? price + TOKEN_ACCOUNT_RENT : 0);
  const spent = isSol && !priceBack ? price : 0;
  return {
    price: round(price),
    token,
    ...(atLeast ? { atLeast: true } : {}),
    ...(priceBack ? { priceBack: true } : {}),
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
 * What `perDay` sales a day over `days` pay, one every 1/perDay of a day (the first half a gap in), with the part's
 * rise and fall exactly as the program prices them (state.rs `Fall::sell`): each sale pays the price fallen since the
 * later of the fall's start and the last sale, and the price after it is what was paid plus the rise. A price that stops
 * moving (at its cap, or at its floor with no rise) is counted at that price for every sale after; a rise by a fixed step
 * alone (no percent, no fall) is an arithmetic series, summed at once. Every other sale walked comes out of `budget`
 * (one a simulation, shared by its calls), and the walk throws once it runs out. { count, average, first, last }, in
 * whole units.
 */
export function salePrices(part, perDay, days, fallStartsAfter = 0, budget = walkBudget()) {
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
    return { count, average: total / count, first: listed, last: count === 1 ? listed : below === count - 1 ? listed + below * step : PRICE_CAP };
  }
  // On the sale clock (the default) a sale restarts the countdown, so after the first sale each sale comes `gap` after
  // the last, and one closer than a step of the fall never lowers it. On a shared clock the steps keep their own time.
  const shared = part.fall?.clock === 'shared';
  const falls = Boolean(part.fall && every && num(part.fall.step) && (shared || gap >= every * (1 - 1e-9)));
  let price = listed;
  let since = fallStartsAfter;
  let total = 0;
  let first;
  let paid = listed;
  for (let k = 0; k < count; k++) {
    if (budget.left-- <= 0) throw new Error(`The scenario has ${count.toLocaleString('en-US')} sales of “${part.name ?? part.key}”, whose price rises or falls, and the quick simulation walks at most ${MAX_WALK.toLocaleString('en-US')} sales of prices that still move, for all boxes and items together. Give the scenario fewer days or fewer a day.`);
    const at = (k + 0.5) * gap;
    paid = price;
    const steps = part.fall && every && at > since ? Math.floor((at - since) / every) : 0;
    if (steps && price > floor) paid = Math.max(floor, price - steps * num(part.fall.step));
    // the next countdown starts at this sale, or on a shared clock at the last whole step
    since = shared ? since + steps * every : Math.max(since, at);
    first ??= paid;
    total += paid;
    price = Math.min(PRICE_CAP, paid + paid * growth + step);
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
  const game = m.currencyKey;
  const days = m.scenario.days ?? 30;
  /** The days a one-off (an auction's sale, a lottery that draws once) is spread over: the scenario's, or one when it has none. */
  const scenarioDays = days > 0 ? days : 1;
  const budget = walkBudget();
  const perDay = (kind, key) => num(m.scenario.perDay?.[`${kind}:${key}`] ?? DEFAULT_PER_DAY);
  const symbol = (key) => m.tokens.get(key)?.symbol ?? key;

  // Per pool: fixed money in and out per day, and a rate per day for what takes a share of what it holds.
  const pools = new Map(m.pools.map((p) => [p.key, { key: p.key, currency: p.currency, seed: num(p.seed), in: [], out: [], rate: [], variance: 0 }]));
  // Each lottery's pot is an account of its own, counted here as a pool named "lottery:<key>".
  for (const l of m.lotteries) pools.set(`lottery:${l.key}`, { key: `lottery:${l.key}`, pot: l.name, currency: l.currency ?? game, seed: num(l.seed), in: [], out: [], rate: [], variance: 0 });
  const flowIn = (pool, by, amount) => amount && pools.get(pool)?.in.push({ by, perDay: amount });
  const flowOut = (pool, by, amount) => amount && pools.get(pool)?.out.push({ by, perDay: amount });
  const rateOut = (pool, by, perDayShare, to) => perDayShare && pools.get(pool)?.rate.push({ by, perDay: perDayShare, ...(to ? { to } : {}) });

  const players = { pay: {}, get: {}, fees: 0, network: 0, rent: 0, oracle: 0 };
  const creator = { treasury: {}, fees: 0, network: 0, oracle: 0 };
  const burned = {};
  const accounts = {};
  const platform = { player: 0, project: 0 };
  const notes = [];
  /** Prizes that are a share of a pool: counted for players once each pool's level is known. */
  const sharePrizes = [];
  /** Shares of a pool that are burned (a schedule, a decision): counted once each pool's level is known. */
  const shareBurns = [];
  /** NFTs taken out of a stash a day, by each box that gives one; and the rolls of a box prizes give a day. */
  const stashTakes = [];
  const prizeTakes = [];
  /** The SOL a prize's order holds while it waits (its rent, and the SOL for a collectible when the box can give one), back to the winner at settle. */
  const orderHeld = (box) => ORDER_RENT + sol(ESCROW_LAMPORTS) * Math.max(0, ...(m.box.get(box)?.outcomes ?? []).map((o) => outcomeParts(o).filter((x) => x.gives === 'item').length));
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
      const token = prizePool(line) ? m.pool.get(prizePool(line))?.currency : line.currency ?? game;
      if (prizePool(line)) flowOut(prizePool(line), by, times * num(line.amount));
      add(players.get, token, times * num(line.amount));
    } else if (line.gives === 'share') {
      each = TOKEN_ACCOUNT_RENT;
      rateOut(line.pool, by, times * ((toBps(line.percent) ?? 0) / 10_000));
      sharePrizes.push({ pool: line.pool, rate: times * ((toBps(line.percent) ?? 0) / 10_000) });
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
  const fallStart = (part) => (part.fall?.start && part.fall.start !== 'publish' ? Math.max(0, toTime(part.fall.start, now) - now) : 0);
  /** What a rising or falling price really comes to, in words. */
  const priceNote = (part, sold) => {
    if (!part.rise && !part.fall) return;
    const shared = part.fall?.clock === 'shared';
    const how = part.rise && part.fall
      ? `rises with each sale and falls with time${shared ? ' on a clock of its own, sales or not' : ', the countdown restarting at each sale'}`
      : part.rise ? 'rises with each sale'
      : shared ? 'falls on a clock of its own, sales or not (a sale keeps the price at what was paid, and the next step still comes on time)'
      : 'falls while nobody buys (a sale keeps the price at what was paid and restarts the countdown)';
    const said = `“${part.name}”’s price ${how}: over the scenario’s ${sold.count} sales it averages ${round(sold.average, 6)} (the first ${round(sold.first, 6)}, the last ${round(sold.last, 6)}), and the money below counts that.`;
    notes.push(sold.last >= 10 * num(part.price) ? `${said} It ends ${sold.last >= PRICE_CAP ? 'beyond any price' : `${round(sold.last / num(part.price), 1)} times`} where it started: players stop buying long before that. A smaller growth keeps it in reach.` : said);
  };

  /** Sends `amount` of `token` a day to one destination (model `destination`): a pool, a lottery's pot, a burn, the treasury or an account. */
  const sendTo = (d, token, amount, by) => {
    if (d.kind === 'pool') flowIn(d.key, by, amount);
    else if (d.kind === 'lottery') flowIn(`lottery:${d.key}`, by, amount);
    else if (d.kind === 'burn') add(burned, token, amount);
    else if (d.kind === 'treasury') add(creator.treasury, token, amount);
    else if (d.kind === 'chosen') add(accounts, d.key ? `the holder of the ${m.item.get(d.key)?.name ?? d.key} the buyer names` : `the wallet the ${String(by).startsWith('payment:') ? 'payer' : 'buyer'} names`, amount);
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

  // ---- boxes
  const boxes = m.boxes.map((b) => {
    const token = b.currency ?? game;
    const opens = perDay('box', b.key);
    // A price that rises or falls is counted at what the scenario's opens really pay, on average.
    const sold = salePrices(b, opens, days, fallStart(b), budget);
    const price = sold.average;
    const w = weights(b);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    let value = 0;
    let burnChance = 0;
    const unpriced = [];
    const other = {};
    // One part of what an outcome gives (model `outcomeParts`), landing with chance `p`: its row, and its flows.
    const partRow = (o, p) => {
      const row = { gives: o.gives, chance: round(p * 100, 6) };
      if (o.gives === 'pay') {
        const prizeToken = m.pool.get(o.pool)?.currency;
        Object.assign(row, { pool: o.pool, amount: num(o.amount), token: prizeToken });
        if (prizeToken === token) value += p * num(o.amount);
        else add(other, prizeToken, p * num(o.amount));
        flowOut(o.pool, `box:${b.key}`, opens * p * num(o.amount));
      } else if (o.gives === 'mint') {
        // Tokens the project mints for the winner: new supply, from no pool.
        const prizeToken = o.currency ?? game;
        Object.assign(row, { amount: num(o.amount), token: prizeToken, minted: true });
        if (prizeToken === token) value += p * num(o.amount);
        else add(other, prizeToken, p * num(o.amount));
      } else if (o.gives === 'share') {
        const bps = toBps(o.percent) ?? 0;
        const prizeToken = m.pool.get(o.pool)?.currency;
        Object.assign(row, { pool: o.pool, percent: o.percent, token: prizeToken });
        rateOut(o.pool, `box:${b.key}`, opens * p * (bps / 10_000));
        sharePrizes.push({ pool: o.pool, rate: opens * p * (bps / 10_000), box: b.key, perOpen: p * (bps / 10_000) });
        row.shareOfPool = true;
      } else if (o.gives === 'item') {
        const it = m.item.get(o.item);
        const worth = it?.value !== undefined ? num(it.value) : num(it?.price) > 0 ? num(it.price) : null;
        Object.assign(row, { item: o.item, worth });
        if (worth === null) unpriced.push(o.item);
        else if ((b.currency ?? game) === game) value += p * worth;
        else add(other, game, p * worth);
      } else if (o.gives === 'stash' || o.gives === 'nft') {
        // A stash's NFT has whatever worth its collection has: the simulation counts how fast it is given away.
        Object.assign(row, { stash: o.stash, worth: null, ...(o.nft ? { nft: o.nft } : {}) });
        unpriced.push(o.gives === 'nft' ? `the NFT ${String(o.nft).slice(0, 4)}… of “${o.stash}”` : `the NFTs of “${o.stash}”`);
        // A box switched off is opened by nobody: only the prizes that roll it take from the stash.
        if (b.active !== false) stashTakes.push({ stash: o.stash, perDay: opens * p, by: `box:${b.key}` });
      } else if (o.gives === 'roll') {
        // A roll won is made when the order settles: whoever settles pays its order, and someone asks the oracle.
        Object.assign(row, { box: o.box, worth: null });
        unpriced.push(`a roll of “${m.box.get(o.box)?.name ?? o.box}”`);
        if (b.active !== false) prizeTakes.push({ box: o.box, perDay: opens * p, by: `box:${b.key}` });
      }
      return row;
    };
    const outcomes = (b.outcomes ?? []).map((o, i) => {
      const p = w[i] / total;
      const parts = outcomeParts(o).map((part) => partRow(part, p));
      if (outcomeBurns(o)) burnChance += p;
      if (o.gives === 'bundle') return { gives: 'bundle', chance: round(p * 100, 6), prizes: parts, ...(o.burns ? { burns: true } : {}) };
      return parts[0] ?? { gives: o.gives, chance: round(p * 100, 6) };
    });
    // Every part of every outcome, each with its outcome's chance.
    const partsOf = outcomes.flatMap((o) => (o.gives === 'bundle' ? o.prizes : [o]));
    const shares = partsOf.filter((o) => o.shareOfPool);
    // How much the prizes swing from day to day, per pool: opens × (E[prize²] − E[prize]²).
    for (const key of new Set(partsOf.filter((o) => o.gives === 'pay').map((o) => o.pool))) {
      const rows = partsOf.filter((o) => o.gives === 'pay' && o.pool === key);
      const mean = rows.reduce((n, o) => n + (o.chance / 100) * o.amount, 0);
      const square = rows.reduce((n, o) => n + (o.chance / 100) * o.amount ** 2, 0);
      if (pools.has(key)) pools.get(key).variance += opens * (square - mean ** 2);
    }
    // Money: the payment is split unless the roll burns it all.
    carryOut(b.split, token, opens * price * (1 - burnChance), `box:${b.key}`);
    add(burned, token, opens * price * burnChance);
    add(players.pay, token, opens * price);
    add(players.get, token, opens * value);
    for (const [t, v] of Object.entries(other)) add(players.get, t, opens * v);
    // Two signatures: the open, then the settle that carries the outcome out, both from the player's wallet. A box
    // that needs no roll is bought in one (`buy`), with no order; one of one entry that rolls on an NFT opens an order
    // that needs no oracle.
    const rolled = boxRolls(b);
    const bought = boxBuys(b);
    const signatures = bought ? 1 : 2;
    playerAction(opens, signatures);
    if (rolled) players.oracle += opens * ORACLE;
    const collectibles = partsOf.filter((o) => o.gives === 'item' && m.item.get(o.item)?.kind !== 'normal').reduce((n, o) => n + o.chance / 100, 0);
    players.rent += opens * collectibles * COLLECTIBLE_RENT;
    const known = !unpriced.length && !shares.length && !Object.keys(other).length;
    // What one open really takes from the player's wallet: the price, the platform's fee, the oracle's and the network's.
    const isSol = Boolean(m.tokens.get(token)?.wsol);
    const oracle = rolled ? ORACLE : 0;
    // A collectible's rent comes out of the SOL the order holds when it settles: on average, the chance of one.
    const items = Math.max(0, ...(b.outcomes ?? []).map((o) => outcomeParts(o).filter((x) => x.gives === 'item').length));
    const realCost = realCostOf({ price, token, isSol, oracle, signatures, rent: collectibles * COLLECTIBLE_RENT, rentIs: collectibles < 1 ? 'the collectible’s rent, when it gives one' : 'the collectible’s rent', held: bought ? 0 : sol(ESCROW_LAMPORTS) * items + ORDER_RENT });
    const extrasSol = realCost.extrasSol;
    priceNote(b, sold);
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
      ...(isSol && known && price ? { returnOfRealCostPercent: round((value / (price + extrasSol)) * 100, 4) } : {}),
    };
  });

  // ---- items sold in the shop
  const items = m.shop
    .map((b) => ({ ...m.item.get(b.shopOf), shopBox: b.key }))
    .map((it) => {
      const sales = perDay('item', it.key);
      const sold = salePrices(it, sales, days, fallStart(it), budget);
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
      const rises = it.rise ? listed * (num(it.rise.growthPercent) / 100) + num(it.rise.step) : 0;
      const realCost = realCostOf({ price: listed, token: game, isSol: Boolean(m.tokens.get(game)?.wsol), signatures: 1, rent: collectible ? COLLECTIBLE_RENT : 0, rentIs: 'the collectible’s rent', held: 0 });
      return { key: it.key, name: it.name, price: listed, ...(price !== listed ? { averagePrice: round(price) } : {}), token: game, salesPerDay: sales, ...(rises ? { nextPrice: round(listed + rises) } : {}), ...(it.supply && sales > 0 ? { soldOutInDays: round(it.supply / sales, 2) } : {}), realCost };
    });

  // ---- payments
  const payments = m.payments.map((p) => {
    const token = p.currency ?? game;
    const count = perDay('payment', p.key);
    carryOut(p.split, token, count * num(p.amount), `payment:${p.key}`);
    add(players.pay, token, count * num(p.amount));
    playerAction(count);
    const realCost = realCostOf({ price: num(p.amount), token, isSol: Boolean(m.tokens.get(token)?.wsol), atLeast: Boolean(p.any) });
    return { key: p.key, name: p.name, amount: num(p.amount), ...(p.any ? { atLeast: true } : {}), token, perDay: count, realCost };
  });

  // ---- recipes
  const recipes = m.recipes.map((r) => {
    const crafts = perDay('recipe', r.key);
    const takes = [];
    const gives = [];
    for (const line of r.in ?? []) {
      if (line.takes === 'burn') players.rent -= crafts * (line.count ?? 1) * BURN_REFUND;
      if (line.takes !== 'pay') {
        const what = line.takes === 'show' || line.takes === 'trade' ? `an NFT of ${line.collection ? `${line.collection.slice(0, 4)}…` : 'the collection'}` : line.item;
        const traded = (t) => (!t || t === 'burn' ? ' (traded in, burned)' : t.stash ? ` (traded in, into “${t.stash}”)` : ' (traded in, given on)');
        takes.push(`${line.takes === 'burn' ? `${line.count ?? 1} × ` : ''}${what}${line.takes === 'burn' ? ' (burned)' : line.takes === 'trade' ? traded(line.then) : line.takes === 'renew' ? ' (renewed)' : line.takes === 'staked' ? ` (kept, and staked in “${m.farm.get(line.farm)?.name ?? line.farm}”)` : ' (kept)'}`);
        continue;
      }
      const token = line.currency ?? game;
      takes.push(`${num(line.amount)} ${symbol(token)}`);
      add(players.pay, token, crafts * num(line.amount));
      sendTo(destination(line.to), token, crafts * num(line.amount), `recipe:${r.key}`);
    }
    for (const x of r.raises ?? []) {
      if (!x.fromNow && typeof x.by === 'string') gives.push(String(x.by).startsWith('-') ? `${x.key} ${String(x.by).slice(1)} sooner on collectible ${x.place}` : `${x.key} ${x.by} later on collectible ${x.place}`);
      else if (x.fromNow) gives.push(String(x.by).startsWith('-') ? `${x.key} ${String(x.by).slice(1)} sooner on collectible ${x.place}` : `${x.key} ${x.by} later on collectible ${x.place}, from now when it is past (at most ${x.upTo} ahead)`);
      else gives.push(x.by > 0 ? `+${x.by} ${x.key} on collectible ${x.place} (up to ${x.upTo})` : `${x.by} ${x.key} on collectible ${x.place} (never below 0)`);
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
        gives.push(`${num(line.amount)} ${symbol(token)}`);
        add(players.get, token, crafts * num(line.amount));
        if (line.from?.startsWith('pool:')) flowOut(line.from.slice(5), `recipe:${r.key}`, crafts * num(line.amount));
      } else if (line.gives === 'roll') {
        gives.push(`a roll of “${line.box}”${line.on !== undefined ? ` on collectible ${line.on}` : ''}`);
      } else if (line.gives === 'nft') {
        gives.push(prizeWords(line, m));
        stashTakes.push({ stash: line.stash, perDay: crafts, by: `recipe:${r.key}` });
      } else if (line.gives === 'share') {
        gives.push(`${line.percent}% of ${line.pool}`);
        rateOut(line.pool, `recipe:${r.key}`, crafts * ((toBps(line.percent) ?? 0) / 10_000));
        sharePrizes.push({ pool: line.pool, rate: crafts * ((toBps(line.percent) ?? 0) / 10_000) });
      }
    }
    // The player's is the only signature: what a craft makes is at its item's and serial's address.
    playerAction(crafts, 1);
    return { key: r.key, name: r.name, craftsPerDay: crafts, takes, gives };
  });

  // ---- schedules
  const schedules = m.schedules
    .filter((s) => s.active !== false)
    .map((s) => {
      const every = toSeconds(s.every) || DAY;
      const runs = DAY / every;
      creator.network += runs * NETWORK_FEE; // run_schedule is free of the program's fee; whoever sends it pays the network
      if (s.does === 'issue') {
        const amount = num(s.amount);
        flowIn(s.pool, `schedule:${s.key}`, runs * amount);
        const halving = s.halveEvery ? `, halving every ${s.halveEvery} runs (every ${round((s.halveEvery * every) / DAY, 2)} days)` : '';
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
        return { key: s.key, does: 'issue', perDay: round(runs * amount), token: m.pool.get(s.pool)?.currency, says: `mints ${round(runs * amount)} ${symbol(m.pool.get(s.pool)?.currency)} a day into ${s.pool}${halving}`, mintsInAll: Number.isFinite(totalEver) ? round(totalEver) : null };
      }
      if (s.sealed) {
        // A sealed schedule pays from its own vault: what it was funded with, run by run, the last run the rest.
        const t = s.currency ?? m.currencyKey;
        const each = s.percent === undefined ? `${num(s.amount)} ${symbol(t)}` : `${s.percent}% of what its vault holds`;
        if (s.percent === undefined) sendTo(destination(s.to), t, runs * num(s.amount), `schedule:${s.key}`);
        return { key: s.key, does: 'pay', sealed: true, perDay: s.percent === undefined ? round(runs * num(s.amount)) : 0, says: `sealed: pays ${s.to} ${each} every ${round(every / 3600, 3)} h for ${s.maxRuns} runs from a vault of its own${s.fund ? ` (${num(s.fund)} ${symbol(t)} put in at go-live${s.fundFrom === 'mint' ? ', minted' : s.fundFrom?.startsWith('pool:') ? ` from ${s.fundFrom.slice(5)}` : ' from the owner’s wallet'})` : ''}; the last run pays whatever is left, and nobody, the owner included, can change it, stop it or take its tokens back` };
      }
      const from = s.does === 'burn' ? s.pool : s.from;
      const sym = symbol(m.pool.get(from)?.currency);
      if (s.percent === undefined) {
        // A fixed amount each run.
        const amount = num(s.amount);
        flowOut(from, `schedule:${s.key}`, runs * amount);
        if (s.does === 'move') flowIn(s.to, `schedule:${s.key}`, runs * amount);
        else if (s.does === 'burn') add(burned, m.pool.get(from)?.currency, runs * amount);
        else sendTo(destination(s.to), m.pool.get(from)?.currency, runs * amount, `schedule:${s.key}`);
        const where = s.does === 'burn' ? 'burns' : s.does === 'move' ? `moves to ${s.to}` : `pays ${s.to}`;
        return { key: s.key, does: s.does, perDay: round(runs * amount), says: `${where} ${amount} ${sym} from ${from} every ${round(every / 3600, 3)} h` };
      }
      const share = (toBps(s.percent) ?? 0) / 10_000;
      if (s.does === 'burn') {
        rateOut(s.pool, `schedule:${s.key}`, runs * share);
        shareBurns.push({ pool: s.pool, rate: runs * share });
      } else if (s.does === 'move' || destination(s.to).kind === 'lottery') {
        // into another pool, or a lottery's pot (a pool named "lottery:<key>"): it enters that pot at the source's level
        rateOut(s.from, `schedule:${s.key}`, runs * share, s.to);
      } else {
        rateOut(s.from, `schedule:${s.key}`, runs * share);
        sharePrizes.push({ pool: s.from, rate: runs * share, account: s.to, by: `schedule:${s.key}` });
      }
      const where = s.does === 'burn' ? 'burns' : s.does === 'move' ? `moves to ${s.to}` : `pays ${s.to}`;
      return { key: s.key, does: s.does, percentPerDay: round(runs * s.percent, 6), says: `${where} ${s.percent}% of ${from} every ${round(every / 3600, 3)} h` };
    });

  // ---- stakes: everything that arrives in the rewards pool goes to stakers
  // ---- lotteries: in steady state each round pays out what came in (what the places leave rolls over). One that draws
  // once (no `every`) has one round, from going live to its first draw (the scenario's end at the latest): its tickets,
  // its draw and its pot happen once, spread over the scenario's days like an auction's sale.
  /** Per lottery: whether it draws once, and the days its money a day is spread over. */
  const lotteryRun = new Map();
  const lotteries = m.lotteries.map((l) => {
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
    else {
      // The split takes its shares as it does a sale's; the rest goes into the pot (not the treasury).
      carryOut(split, potToken, tickets * price, `lottery:${l.key}`, `lottery:${l.key}`);
    }
    playerAction(tickets);
    players.rent += tickets * TICKET_LINE;
    const placed = (l.places ?? [100]).map(placeOf);
    const places = placed.map((p) => Number(p.percent));
    creator.network += (1 + places.length) * NETWORK_FEE * drawsPerDay; // the draw and each place's payment
    // A place's prize, once a round, given by whoever pays the place (the game's keeper).
    for (const p of placed.filter((p) => p.prize)) givePrize(p.prize, drawsPerDay, `lottery:${l.key}`, creator);
    creator.oracle += ORACLE * drawsPerDay; // the draw asks the oracle; whoever sends it (the game's keeper) pays
    // What the places' prizes are worth a round in the pot's token: tokens of it, or an item with a value in it. A
    // prize with no price (an NFT, a roll, an item with no value) leaves a ticket's return unsaid.
    const worthOf = (line) => {
      if (line.gives === 'tokens') return (prizePool(line) ? m.pool.get(prizePool(line))?.currency : line.currency ?? game) === potToken ? num(line.amount) : null;
      if (line.gives === 'item') return m.item.get(line.item)?.value !== undefined && game === potToken ? num(m.item.get(line.item).value) : null;
      return null;
    };
    const prized = placed.filter((p) => prizeLine(p.prize)).map((p) => worthOf(prizeLine(p.prize)));
    // One ticket bought on its own: the fee and the record are per purchase, so a bundle of tickets shares them. The
    // record's rent comes back once the round is done with it, and a no-loss ticket's price after the draw: both held.
    const realCost = realCostOf({ price, token: ticketToken, isSol: Boolean(m.tokens.get(ticketToken)?.wsol), held: TICKET_LINE, heldIs: l.noLoss ? 'the ticket’s price and the purchase record’s rent' : 'the purchase record’s rent', priceBack: Boolean(l.noLoss) });
    return { key: l.key, name: l.name, price, token: ticketToken, potToken, ...(l.minSold ? { minSold: l.minSold } : {}), ticketsPerDay: round(tickets, 6), ticketsPerRound: round(perRound, 4), roundDays: round(every / DAY, 4), places, placePrizes: placed.map((p) => (p.prize ? prizeWords(p.prize, m) : null)), prizeWorthPerRound: round(prized.reduce((n, w) => n + (w ?? 0), 0)), ...(prized.includes(null) ? { unpricedPrizes: true } : {}), cutPercent: num(l.cutPercent), splitPercent: round(cut * 100, 4), drawsOnce: once, ...(l.ticketNft ? { ticketNft: true } : {}), ...(l.noLoss ? { noLoss: true } : {}), realCost };
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
      }
      else flowOut(d.pool, `decision:${d.key}`, rate * num(d.amount));
      const token = m.pool.get(d.pool)?.currency;
      if (d.does === 'payout' && d.amount !== undefined) add(players.get, token, rate * num(d.amount));
      if (d.does === 'burn' && d.amount !== undefined) add(burned, token, rate * num(d.amount));
    }
  }
  const contests = m.contests.map((c) => {
    const rake = sharesOf(c.split).reduce((n, s) => n + (s.bps ?? 0), 0) / 100;
    const opened = c.every ? DAY / toSeconds(c.every) : 0;
    creator.fees += opened * 2 * PROJECT_FEE; // opened and decided
    platform.project += opened * 2 * PROJECT_FEE;
    const split = prizeLine(c.prize)?.split ? `, and ${prizeWords(c.prize, m)} (set aside whole when it is decided; short of it, the decision is refused)` : '';
    return { key: c.key, name: c.name, sides: c.sides, rakePercent: rake, winnersSharePercent: 100 - rake, says: `the winning side shares ${100 - rake}% of the pot, by what each put in${split}` };
  });
  // Auctions: each bid tops the last by the least raise, so a run of N bids ends near reserve × (1 + raise)^(N − 1).
  // The scenario counts bids a day (`auction:<key>`, DEFAULT_BIDS a day unless it says), while the auction runs.
  const auctions = m.auctions.map((a) => {
    const runDays = toSeconds(a.runs) / DAY;
    const bids = Math.max(0, Math.round(num(m.scenario.perDay?.[`auction:${a.key}`] ?? DEFAULT_BIDS) * Math.max(runDays, 1 / 24)));
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
        says: !bids ? 'no bids: the lot goes home' : `about ${bids} bids over ${round(runDays)} days, each a bundle of up to three NFTs: the bundle with the most NFTs wins (at least ${num(a.reserve ?? 1)}), so it goes for NFTs, not money, and nothing is counted in what players pay; every topped bundle goes back to its bidder at once`,
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
        : `about ${bids} bids over ${round(runDays)} days at a ${round(raise * 100)}% least raise ${reserve ? `end near ${round(price)} ${symbol(token)} (from a reserve of ${reserve})` : 'end at whatever players make it (no reserve)'}${kept ? `, of which the split takes ${kept}%` : ''}; every outbid bidder has their bid back at once`,
    };
  });
  for (const f of m.farms) playerAction(perDay('farm', f.key));
  // Grants: each claim's sender pays the player fee; its receipt's rent comes from the grant's funds (the owner's SOL).
  const grants = m.grants.map((g) => {
    const claims = num(m.scenario.perDay?.[`grant:${g.key}`]);
    playerAction(claims);
    creator.rent = (creator.rent ?? 0) + claims * RECEIPT_RENT;
    // Its prize, paid for by the grant's funds; a roll's order goes back to the winner at settle.
    const line = prizeLine(g.prize ?? g.gives);
    const each = givePrize(line, claims, `grant:${g.key}`, creator);
    return { key: g.key, name: g.name, claimsPerDay: claims, gives: prizeWords(line, m), fundsPerClaimSol: round(RECEIPT_RENT + each), ...(line?.gives === 'roll' ? { orderHeldSol: round(orderHeld(line.box)) } : {}) };
  });
  for (const h of m.holds) playerAction(perDay('hold', h.key));
  for (const c of m.contests) playerAction(perDay('contest', c.key));

  // ---- the pools over time
  const settle = (p) => {
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
      const moved = [...pools.values()].flatMap((q) => q.rate.filter((r) => r.to === p.key).map((r) => r.perDay * (levels.get(q.key) ?? q.seed)));
      const { fixedIn, fixedOut, rate } = settle(p);
      const inflow = fixedIn + moved.reduce((a, b) => a + b, 0);
      const net = inflow - fixedOut;
      const steady = rate > 0 ? net / rate : null;
      levels.set(p.key, steady !== null && steady > 0 ? steady : p.seed);
      p.inflow = inflow;
    }

  // Farms: everything that arrives in the rewards pool is released to the seats over the farm's release span (its
  // longest lock, a day at least), by weight (stake × tier × boosts) as it is released; or a fixed rate for each seat
  // (minted, or from the pool while it lasts). In a steady state the release pays what arrives, a day at a time.
  /** A farm's ways out and tolls, in words (farm.rs): an early-exit fee, an unbonding wait, a toll; or null. */
  const farmExtras = (f) => {
    const exits = (f.tiers ?? []).map((t, i) => (t.exitFee ? `tier ${i + 1} may leave before its ${t.lock} lock by leaving ${t.exitFee}% of what it takes out (${f.exitFeeTo === 'burn' ? 'burned' : `to ${String(f.exitFeeTo).replace(/^pool:/, '')}`})` : null)).filter(Boolean);
    const parts = [
      ...exits,
      f.unbond && `what is taken out waits ${f.unbond}, earning nothing, before it can leave`,
      f.toll && `${f.toll.percent}% of every payout of rewards is ${f.toll.to === 'burn' ? 'burned' : `sent to ${String(f.toll.to).replace(/^pool:/, '')}`}`,
      f.stakes !== 'collectibles' && m.pool.get(f.rewards)?.currency === f.stakes && 'its rewards can be compounded into the stake without restarting the lock',
      f.unpaid && 'it pays nothing: staking there only counts (a stake gate reads it)',
    ].filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  };
  /** What a seat of `f` can give back (farm.rs `Farm::give`): a forfeit, an early exit's waiting rewards, a watched NFT gone, a lapsed upkeep. */
  const giveBacks = (f) => ['a forfeit', (f.tiers ?? []).some((t) => t.exitFee) && 'an early exit’s waiting rewards', f.custody === 'watch' && 'a watched NFT sold', f.upkeepAttribute && 'what a lapsed upkeep earned'].filter(Boolean).join(', ');
  const farmRows = m.farms.map((f) => {
    const pool = pools.get(f.rewards);
    const staked = num(m.scenario.staked?.[f.key]);
    const perUnit = f.rate ? num(f.rate.perDay) : null;
    const wanted = f.rate ? perUnit * staked : Infinity;
    const free = pool ? Math.max(0, pool.inflow - pool.out.reduce((n, x) => n + x.perDay, 0)) : 0;
    const rewards = f.rate?.minted ? wanted : Math.min(wanted, f.rate ? free + (pool?.seed ?? 0) / Math.max(1, m.scenario.days ?? 30) : free);
    if (pool && !f.rate?.minted) pool.out.push({ by: `farm:${f.key}`, perDay: rewards });
    const sameToken = pool?.currency === f.stakes;
    const tiers = (f.tiers ?? [{ lock: 0, multiplier: 1 }]).map((t) => ({ lock: t.lock, multiplier: t.multiplier ?? 1, ...(prizeLine(t.prize) ? { prize: prizeWords(t.prize, m) } : {}) }));
    const unit = f.stakes === 'collectibles' ? 'collectible' : symbol(f.stakes);
    // Growth: the days a collectible at x1 needs for each level.
    const growth = listOf(f.growth).map((g) => {
      const levels = (g.levels ?? []).map((points, i) => ({ level: i + 1, points, days: round(points / g.perDay, 2) }));
      return { attribute: g.attribute ?? 'xp', perDay: g.perDay, ...(levels.length ? { level: g.level ?? 'level', levels } : {}), streak: Boolean(g.streak) };
    });
    return {
      key: f.key,
      name: f.name,
      stakes: f.stakes,
      rewardsToken: pool?.currency,
      rewardsPerDay: round(rewards),
      ...(f.rate ? { rate: { perDay: perUnit, minted: Boolean(f.rate.minted) } } : {}),
      tiers,
      ...(staked ? { staked, perUnitPerDay: round(f.rate ? perUnit : rewards / staked), unit } : f.rate ? { perUnitPerDay: perUnit, unit } : {}),
      ...(staked && sameToken ? { yearlyPercent: round(((rewards * 365) / staked) * 100, 4) } : {}),
      ...(growth.length ? { growth } : {}),
      ...(f.runs ? { runs: f.runs } : {}),
      ...(farmEndWords(f) ? { end: farmEndWords(f) } : {}),
      ...(f.lockAttribute ? { lockAttribute: f.lockAttribute } : {}),
      ...(f.upkeepAttribute ? { upkeepAttribute: f.upkeepAttribute } : {}),
      ...(farmExtras(f) ? { extras: farmExtras(f) } : {}),
      says: f.rate
        ? `each seat earns ${perUnit} a day for each ${unit} at x1, whoever else is in${f.rate.minted ? ' (minted, as far as the mint has room for: what it can’t mint is not owed later)' : ', while the pool lasts'}${perUnit > 0 ? `; what a seat gives back (${giveBacks(f)}) is ${f.rate.minted ? 'burned' : `sent back to “${f.rewards}”`} in the same move, never to the other seats` : ''}`
        : `what lands in the pool is released over ${releaseWords(f)} to the seats there as it is released, so a stake earns only while it stays; ${tiers.length > 1 || (f.boosts ?? []).length ? 'shares are by weight: a higher tier or a boosted collectible takes more of the same rewards, so the figures are for a seat at x1 among seats at x1' : 'shares are by what each seat stakes'}`,
    };
  });
  for (const row of farmRows) add(players.get, row.rewardsToken, row.rewardsPerDay);
  // A farm that ends inside the scenario takes no stake from its end on (FarmOver), and pays nothing after it.
  for (const f of m.farms.filter((x) => x.runs && toSeconds(x.runs) < days * DAY))
    notes.push(`“${f.name ?? f.key}” runs ${f.runs}, less than the scenario’s ${days} days: its figures are a day while it runs; from its end it takes no stake and pays nothing.`);

  // Lotteries pay what came in, once the pot is in its steady state; one that draws once pays its seed and all that
  // came in, at its one draw.
  for (const l of lotteries) {
    const pool = pools.get(`lottery:${l.key}`);
    const inflow = pool ? pool.inflow : 0;
    const run = lotteryRun.get(l.key);
    const placesTotal = l.places.reduce((a, b) => a + b, 0) / 100;
    pool?.out.push({ by: `lottery:${l.key}`, perDay: inflow });
    const potBeforeDraw = run.once ? run.seed + inflow * run.spreadDays : placesTotal ? (inflow * l.roundDays) / placesTotal : 0;
    const paid = run.once ? potBeforeDraw * placesTotal : inflow * l.roundDays;
    l.potBeforeDraw = round(potBeforeDraw);
    l.paidPerRound = round(paid);
    l.prizes = l.places.map((pct) => round((potBeforeDraw * pct) / 100));
    const perTicket = l.ticketsPerRound ? (paid + l.prizeWorthPerRound) / l.ticketsPerRound : null;
    l.expectedPerTicket = perTicket === null ? null : round(perTicket);
    // A no-loss ticket comes back whole, so it returns its price and its share of the pot on top.
    l.returnPercent = perTicket !== null && l.price && l.token === l.potToken && !l.unpricedPrizes ? round((perTicket / l.price) * 100 + (l.noLoss ? 100 : 0), 4) : null;
    add(players.get, l.potToken, run.once ? paid / run.spreadDays : inflow);
  }

  const poolRows = [...pools.values()].map((p) => {
    const { fixedOut, rate } = settle(p);
    const inflow = p.inflow ?? 0;
    const net = inflow - fixedOut;
    const row = {
      key: p.key,
      ...(p.pot ? { pot: p.pot } : {}),
      token: p.currency,
      seed: p.seed,
      inPerDay: round(inflow),
      outPerDay: round(fixedOut + rate * (levels.get(p.key) ?? p.seed)),
      ins: p.in.map((f) => ({ by: f.by, perDay: round(f.perDay) })),
      outs: [...p.out.map((f) => ({ by: f.by, perDay: round(f.perDay) })), ...p.rate.map((f) => ({ by: f.by, percentPerDay: round(f.perDay * 100, 6) }))],
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
    if (p.variance > 0) {
      row.swingPerDay = round(Math.sqrt(p.variance), 6);
      const weekly = Math.sqrt(p.variance * 7);
      if (row.lasts !== 'runs dry' && p.seed < 3 * weekly)
        notes.push(`The pool “${p.key}” ${row.lasts === 'grows' ? 'takes in more than it pays on average' : row.lasts === 'settles' ? 'settles on average' : 'pays even on average'}, but luck moves it by about ±${round(row.swingPerDay, 4)} ${symbol(p.currency)} a day (±${round(weekly, 4)} a week), against a seed of ${p.seed}. While it can’t cover a fixed prize the box stops selling, and a prize rolled while it ran short pays only what it held, so a bad week stalls sales and shrinks wins until it refills. A seed of about ${round(3 * weekly, 2)} (three times a week’s swing) rides out almost any week.`);
    }
    if (row.lasts === 'runs dry') notes.push(`The pool “${p.key}” pays out more than comes in: it lasts about ${row.lastsDays} days from its seed of ${p.seed} ${symbol(p.currency)}.`);
    return row;
  });

  for (const prize of sharePrizes) {
    const row = poolRows.find((r) => r.key === prize.pool);
    const level = row ? (row.settlesAt ?? row.seed) : 0;
    if (prize.account) sendTo(destination(prize.account), row?.token, prize.rate * level, prize.by);
    else add(players.get, row?.token, prize.rate * level);
    const box = prize.box && boxes.find((b) => b.key === prize.box);
    if (box) add(box.alsoPays, row?.token, round(prize.perOpen * level));
  }
  // A share burned is burned at the pool's level, as a share prize is paid.
  for (const b of shareBurns) {
    const row = poolRows.find((r) => r.key === b.pool);
    add(burned, row?.token, b.rate * (row ? (row.settlesAt ?? row.seed) : 0));
  }
  // Stashes: each roll that lands on one takes an NFT out; how long what it starts with lasts.
  for (const r of prizeTakes) {
    const b = m.box.get(r.box);
    const w = b ? weights(b) : [];
    const total = w.reduce((a, x) => a + x, 0) || 1;
    (b?.outcomes ?? []).forEach((o, i) => outcomeParts(o).forEach((x) => (x.gives === 'stash' || x.gives === 'nft') && stashTakes.push({ stash: x.stash, perDay: (r.perDay * w[i]) / total, by: r.by })));
  }
  // What fills a stash besides its owner: NFTs paid as a price (a box's `then`, a recipe's trade-in, a lottery's ticket).
  const stashFills = [];
  for (const b of m.boxes.filter((b) => b.rollsOn && b.active !== false)) {
    const w = weights(b);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    (b.outcomes ?? []).forEach((o, i) => (o.then ?? b.then)?.stash && stashFills.push({ stash: (o.then ?? b.then).stash, perDay: (perDay('box', b.key) * w[i]) / total, by: `box:${b.key}` }));
  }
  for (const r of m.recipes) for (const l of r.in ?? []) if (l.takes === 'trade' && l.then?.stash) stashFills.push({ stash: l.then.stash, perDay: perDay('recipe', r.key), by: `recipe:${r.key}` });
  for (const l of m.lotteries) if (l.ticketNft?.then?.stash) stashFills.push({ stash: l.ticketNft.then.stash, perDay: perDay('lottery', l.key), by: `lottery:${l.key}` });
  const stashes = m.stashes.map((s) => {
    const takes = stashTakes.filter((t) => t.stash === s.key);
    const fills = stashFills.filter((t) => t.stash === s.key);
    const perDay = takes.reduce((n, t) => n + t.perDay, 0);
    const inPerDay = fills.reduce((n, t) => n + t.perDay, 0);
    const holds = (s.nfts ?? []).length;
    const net = perDay - inPerDay;
    const filled = inPerDay > 0 ? `, and takes in about ${round(inPerDay, 4)} a day (${[...new Set(fills.map((t) => t.by))].join(', ')})` : '';
    if (perDay > 0 && net > 0) notes.push(`The stash “${s.name}” starts with ${holds} NFT${holds === 1 ? '' : 's'} and gives about ${round(perDay, 4)} a day (${[...new Set(takes.map((t) => t.by))].join(', ')})${filled}: ${holds ? `empty in about ${round(holds / net, 2)} days` : 'empty from the start'}, after which its outcome can’t be won until more are put in.`);
    else if (perDay > 0) notes.push(`The stash “${s.name}” starts with ${holds} NFT${holds === 1 ? '' : 's'}, gives about ${round(perDay, 4)} a day (${[...new Set(takes.map((t) => t.by))].join(', ')})${filled}: it keeps up${holds ? '' : ', once the first come in (until then its outcome can’t be won)'}.`);
    return { key: s.key, name: s.name, holds, givenPerDay: round(perDay, 6), ...(inPerDay > 0 ? { takenInPerDay: round(inPerDay, 6) } : {}), ...(net > 0 ? { lastsDays: round(holds / net, 4) } : {}) };
  });
  const contestRolls = m.contests.filter((c) => prizeLine(c.prize)?.gives === 'roll');
  if (contestRolls.length) notes.push(`${contestRolls.map((c) => `“${c.name}”`).join(', ')} give${contestRolls.length === 1 ? 's' : ''} every winning entry a roll: whoever claims it pays the roll’s order (about ${round(orderHeld(prizeLine(contestRolls[0].prize).box), 4)} SOL, back to the winner at settle), and whoever asks for the roll pays the oracle.`);
  for (const t of m.tokens.values())
    if (t.powers?.transferFeePercent > 0) notes.push(`${t.symbol} keeps ${t.powers.transferFeePercent}% of every transfer: pools, prizes, stakes and the treasury receive that much less than shown here.`);

  const totals = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, round(v)]));
  return {
    scenario: { days, perDay: m.scenario.perDay ?? {}, defaultPerDay: DEFAULT_PER_DAY, defaultBidsPerDay: DEFAULT_BIDS, defaultClaimsPerDay: 0 },
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
      players: { pay: totals(players.pay), getBack: totals(players.get), playerFeesSol: round(players.fees), oracleFeesSol: round(players.oracle), networkFeesSol: round(players.network), rentSol: round(players.rent) },
      creator: { treasury: totals(creator.treasury), projectFeesSol: round(creator.fees), oracleFeesSol: round(creator.oracle), networkFeesSol: round(creator.network), grantRentSol: round(creator.rent ?? 0) },
      oracle: { totalSol: round(players.oracle + creator.oracle) },
      platform: { playerFeesSol: round(platform.player), projectFeesSol: round(platform.project), totalSol: round(platform.player + platform.project) },
      burned: totals(burned),
      accounts: totals(accounts),
    },
    fees: { playerSol: PLAYER_FEE, projectSol: PROJECT_FEE, oracleSol: ORACLE, networkPerSignatureSol: NETWORK_FEE, escrowSol: sol(ESCROW_LAMPORTS), ticketLineRentSol: round(TICKET_LINE), collectibleRentSol: COLLECTIBLE_RENT, burnRefundSol: BURN_REFUND },
    notes,
  };
}

/** What the scenario doesn't name and doesn't count at its default, in words: ["grant claims none", "auction bids 10 a day"]. */
export function unnamedExceptions(sim) {
  const named = (k) => Object.hasOwn(sim.scenario.perDay ?? {}, k);
  return [
    (sim.grants ?? []).some((g) => !named(`grant:${g.key}`)) && 'grant claims none',
    (sim.auctions ?? []).some((a) => !named(`auction:${a.key}`)) && `auction bids ${DEFAULT_BIDS} a day`,
  ].filter(Boolean);
}
/** What the scenario assumes for what it doesn't name, in words: "100 a day (grant claims none, auction bids 10 a day)". */
export function unnamedWords(sim) {
  const except = unnamedExceptions(sim);
  return `${sim.scenario.defaultPerDay} a day${except.length ? ` (${except.join(', ')})` : ''}`;
}

/** What becomes of a pool (a row of `simulate`'s pools) over the scenario's `days`, in words: "settles at about 40". */
export function poolFate(p, days) {
  const n = (x) => String(round(x, 6));
  if (p.lasts === 'runs dry') return `runs dry in about ${n(p.lastsDays)} days`;
  if (p.lasts === 'settles') return `settles at about ${n(p.settlesAt)}`;
  if (p.lasts === 'shrinks') return `shrinks to about ${n(p.after)} after ${days} days (half gone every ${n(p.halfLifeDays)} days)`;
  if (p.lasts === 'grows') return `grows to about ${n(p.after)} after ${days} days`;
  return 'holds steady';
}

/**
 * A player's real cost of one action in words: the one number to quote. "about 0.0071 SOL in all (the price, the
 * player fee, …); the wallet needs 0.0151 SOL when it signs, and the rest comes back".
 */
export function inAll(c) {
  if (!c) return '';
  const n = (x) => String(round(x, 6));
  const parts = ['the player fee', c.oracleSol ? 'the oracle' : '', 'the network', c.rentSol ? (/comes back/.test(c.rentIs) ? c.rentIs : `${c.rentIs}, which never comes back`) : ''].filter(Boolean).join(', ');
  const head = c.totalSol !== undefined ? `about ${n(c.totalSol)} SOL in all${c.atLeast ? ' at the least amount' : ''} (${c.priceBack ? '' : 'the price, '}${parts})` : `${n(c.extrasSol)} SOL on top of the price (${parts})`;
  return c.holdSol > (c.totalSol ?? c.extrasSol) + 1e-9 ? `${head}; the wallet needs about ${n(c.holdSol)} SOL when it signs, and the rest${c.heldIs ? ` (${c.heldIs})` : ''} comes back` : head;
}

/** The simulation in plain words. */
export function explain(sim, economy) {
  const m = model(economy);
  const sym = (key) => m.tokens.get(key)?.symbol ?? key;
  const lines = [];
  const n = (x) => (Number.isFinite(x) ? String(round(x, 6)) : String(x));
  lines.push(`Assuming ${Object.entries(sim.scenario.perDay).map(([k, v]) => `${v} × ${k}`).join(', ') || 'nothing in particular'} a day (anything not named: ${unnamedWords(sim)}), over ${sim.scenario.days} days.`);
  for (const b of sim.boxes) {
    const edge = b.houseEdgePercent !== null ? `; the house keeps ${n(b.houseEdgePercent)}% of each price` : '';
    const also = Object.entries(b.alsoPays).map(([t, v]) => `${n(v)} ${sym(t)}`);
    const back = b.returnPercent !== null ? `${n(b.expectedBack)} ${sym(b.token)} on average (${n(b.returnPercent)}%)${also.length ? ` and ${also.join(', ')}` : ''}` : `${also.join(', ') || 'nothing'} on average`;
    const all = `; ${inAll(b.realCost)}`;
    lines.push(`Box “${b.name}”: costs ${n(b.price)} ${sym(b.token)} (${all.slice(2)}), gives back ${back}${edge}.`);
    const part = (o) => (o.gives === 'pay' ? `${n(o.amount)} ${sym(o.token)} from ${o.pool}` : o.gives === 'mint' ? `${n(o.amount)} ${sym(o.token)}, minted` : o.gives === 'share' ? `${o.percent}% of ${o.pool}` : o.gives === 'stash' ? `an NFT of the stash “${o.stash}”, at random` : o.gives === 'nft' ? `the NFT ${String(o.nft).slice(0, 4)}… of “${o.stash}”` : o.gives === 'roll' ? `a roll of “${o.box}”` : o.gives === 'item' ? `${o.item}${o.worth !== null ? ` (worth ${n(o.worth)})` : ' (no value given)'}` : o.gives);
    for (const o of b.outcomes) lines.push(`  ${n(o.chance)}%: ${o.gives === 'bundle' ? `${o.prizes.map(part).join(' + ')}${o.burns ? ', and the payment burned' : ''}` : part(o)}`);
    if (b.unpriced.length) lines.push(`  Give ${b.unpriced.join(', ')} a "value" to count them in the return.`);
  }
  for (const it of sim.items) lines.push(`Shop “${it.name}”: ${n(it.price)} ${sym(it.token)}; ${inAll(it.realCost)}.`);
  for (const p of sim.payments) lines.push(`Payment “${p.name}”: ${p.atLeast ? 'at least ' : ''}${n(p.amount)} ${sym(p.token)}; ${inAll(p.realCost)}.`);
  for (const l of sim.lotteries) {
    const rounds = l.drawsOnce ? `${n(l.ticketsPerRound)} tickets in its one round of ${n(l.roundDays)} days (it draws once)` : `${n(l.ticketsPerRound)} tickets a round of ${n(l.roundDays)} days`;
    lines.push(`Lottery “${l.name}”: ${rounds}; the pot reaches about ${n(l.potBeforeDraw)} ${sym(l.potToken)} and pays ${l.prizes.map((v, i) => `${n(v)}${l.placePrizes?.[i] ? ` and ${l.placePrizes[i]}` : ''}`).join(' / ')}; ${l.ticketNft ? (l.noLoss ? 'a ticket (one NFT, back to its buyer after the draw)' : 'a ticket (one NFT, spent at once, never refunded)') : `a ${n(l.price)} ${sym(l.token)} ticket${l.noLoss ? ' (back to its buyer after the draw)' : ''}`} ${l.noLoss ? 'wins' : 'is worth'} ${n(l.expectedPerTicket)} ${sym(l.potToken)} on average${l.noLoss ? ' on top' : ''}${l.unpricedPrizes ? ', plus its chance at the places’ prizes (no price given)' : ''}${l.returnPercent !== null ? ` (${n(l.returnPercent)}%${l.noLoss ? ' back, the ticket included' : ''})` : ''}; one ticket bought alone: ${inAll(l.realCost)}.`);
    if (l.minSold) lines.push(`  Fewer than ${l.minSold} tickets sold by the draw: the round is cancelled and every ticket refunded.`);
  }
  for (const f of sim.farms) {
    lines.push(`Farm “${f.name}”: ${n(f.rewardsPerDay)} ${sym(f.rewardsToken)} a day to everyone staked${f.perUnitPerDay !== undefined ? `, ${n(f.perUnitPerDay)} a day for each ${f.unit} staked` : ''}${f.yearlyPercent !== undefined ? ` (${n(f.yearlyPercent)}% a year)` : ''}; ${f.says}.`);
    if (f.extras) lines.push(`  ${f.extras[0].toUpperCase()}${f.extras.slice(1)}.`);
    for (const g of f.growth ?? []) lines.push(`  Growth: ${g.perDay} ${g.attribute} a day at x1${g.levels ? `; ${g.levels.map((l) => `level ${l.level} after ${n(l.days)} days`).join(', ')}` : ''}${g.streak ? ', back to 0 when it leaves' : ''}.`);
    if (f.runs) lines.push(`  Runs ${f.runs} from when it goes live: it takes no stake at its end or after it, and pays and grows nothing more${f.end ? `; ${f.end}` : ''}.`);
    if (f.lockAttribute) lines.push(`  Its lock is written on each collectible under “${f.lockAttribute}”: whatever moves that time lets it out sooner or keeps it longer.`);
    if (f.upkeepAttribute) lines.push(`  Upkeep: each collectible earns and grows only until the time under “${f.upkeepAttribute}”; the figures assume every one is kept topped up.`);
    for (const t of f.tiers.filter((t) => t.prize)) lines.push(`  Mission (lock ${t.lock}): ${t.prize} for each one that stays it (tokens grown by its boosts).`);
  }
  for (const g of sim.grants) lines.push(`Grant “${g.name}”: ${n(g.claimsPerDay)} claims a day, each giving ${g.gives}; each claim costs its funds about ${n(g.fundsPerClaimSol)} SOL${g.orderHeldSol ? ` (${n(g.orderHeldSol)} of it the roll’s order, which goes to the winner when it is settled; whoever asks for the roll pays the oracle)` : ''}.`);
  for (const s of sim.stashes ?? []) lines.push(`Stash “${s.name}”: ${s.holds} NFT${s.holds === 1 ? '' : 's'} to start${s.takenInPerDay ? `, about ${n(s.takenInPerDay)} a day come in` : ''}${s.lastsDays !== undefined ? `, given at about ${n(s.givenPerDay)} a day: lasts about ${n(s.lastsDays)} days` : s.givenPerDay ? `, given at about ${n(s.givenPerDay)} a day` : ''}.`);
  for (const r of sim.recipes) lines.push(`Recipe “${r.name}”: ${r.takes.join(' + ') || 'nothing'} → ${r.gives.join(' + ') || 'nothing'}, ${n(r.craftsPerDay)} a day.`);
  for (const s of sim.schedules) lines.push(`Schedule “${s.key}”: ${s.says}.`);
  for (const c of sim.contests) lines.push(`Contest “${c.name}”: ${c.says}.`);
  for (const a of sim.auctions ?? []) lines.push(`Auction “${a.name}”: ${a.says}.`);
  for (const p of sim.pools) lines.push(`${p.pot ? `The pot of “${p.pot}”` : `Pool “${p.key}”`}: ${n(p.inPerDay)} ${sym(p.token)} in and ${n(p.outPerDay)} out a day from a seed of ${n(p.seed)}; it ${poolFate(p, sim.scenario.days)}.`);
  const d = sim.perDay;
  const list = (map) => Object.entries(map).map(([k, v]) => `${n(v)} ${sym(k)}`).join(', ') || 'nothing';
  lines.push(`Each day players pay ${list(d.players.pay)} and get back ${list(d.players.getBack)} on average (items at the value you gave them), plus ${n(d.players.playerFeesSol)} SOL in player fees, ${n(d.players.oracleFeesSol)} SOL to MagicBlock’s oracle and ${n(d.players.networkFeesSol)} SOL in network fees.`);
  if (d.creator.oracleFeesSol) {
    // Every roll the simulation counts as the project's: a draw, a roll a lottery's place or a grant gives, the authority's.
    const what = [
      sim.lotteries.length && 'lottery draws',
      m.lotteries.some((l) => (l.places ?? []).some((p) => placeOf(p).prize?.gives === 'roll')) && 'the rolls lottery places give',
      sim.grants.some((g) => g.claimsPerDay > 0 && prizeLine(m.grant.get(g.key)?.prize ?? m.grant.get(g.key)?.gives)?.gives === 'roll') && 'the rolls grants give',
      m.decisions.some((x) => x.does === 'roll' && Number(x.perDay) > 0) && 'the authority’s rolls',
    ].filter(Boolean);
    const words = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0] ?? 'its rolls';
    lines.push(`The oracle also takes about ${n(d.creator.oracleFeesSol)} SOL a day for ${words}, from whoever asks for them (the game’s keeper or the authority).`);
  }
  lines.push(`The treasury gets ${list(d.creator.treasury)} a day; burned: ${list(d.burned)}. The platform’s fees: ${n(d.platform.totalSol)} SOL a day.`);
  for (const note of sim.notes) lines.push(note);
  return lines.join('\n');
}
