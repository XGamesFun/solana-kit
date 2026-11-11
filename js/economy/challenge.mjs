// Three analyses of a spec, each a warning code, the situation it found in the message: the program takes all of it as
// written, and the person decides.
//
// - W-VALUE, follow the value: for every token a player puts into a route, what they hold in each end state (bought,
//   cancelled, undone, given free, after the end). Value that comes back as something else, converts back after the
//   outcome, appears from nothing, or keeps being made after its last use.
// - W-STEPS, one intent, one step: a purchase whose price is a token the player must craft first takes two
//   transactions, two wallet prompts.
// - W-ASSUMPTION, check every assumption: a number that depends on how many take part (a lottery's least sale, a pool's
//   life) against the scenario, and what can change only before a first sale.
//
// Who makes each later step happen, and where each rule is kept (chain, server or page), are the walk-through's
// (walk.mjs) and the review's trust levels (review.mjs).
import { prizeLine, prizeToken, toSeconds, toTime } from './model.mjs';
import { DEFAULT_PER_DAY } from './simulate.mjs';

const DAY = 86_400;
const num = x => Number(x ?? 0);
const at = seconds =>
  new Date(seconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, ' UTC');
const named = part => `“${part?.name ?? part?.key}”`;
const words = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

/** The token a token line pays in or gives, by key; null for an item, an NFT or a roll. */
function lineToken(line, m) {
  const prize = prizeLine(line);
  if (prize?.gives !== 'tokens') return null;
  return prizeToken(prize, m)?.key ?? prize.currency ?? m.currencyKey;
}

/** What a recipe takes in tokens: [{ token, amount }]. */
const paysIn = (r, m) =>
  (r.in ?? []).filter(l => l.takes === 'pay').map(l => ({ token: l.currency ?? m.currencyKey, amount: num(l.amount) }));

/** What a recipe gives in tokens: [{ token, amount }]. */
const givesOut = (r, m) =>
  (r.out ?? []).map(l => ({ token: lineToken(l, m), amount: num(l.amount) })).filter(x => x.token);

/** The token a lottery's tickets are paid in, or null for a free ticket or one paid with an NFT. */
const ticketOf = (l, m) =>
  l.ticketNft || !(num(l.price) > 0) ? null : (l.ticketCurrency ?? l.currency ?? m.currencyKey);

/**
 * Every token a player can hold but the project's money (its currency, SOL): how a player gets it (`paid`, recipes
 * that take another token for it; `free`, grants), what turns it back into another token (`back`), and what takes it
 * (`tickets`, lotteries; `spent`, any other route).
 */
function ledger(m) {
  const money = t => t === m.currencyKey || m.tokens.get(t)?.source === 'sol';
  const rows = new Map();
  for (const t of m.tokens.keys()) {
    if (money(t)) continue;
    const paid = m.recipes
      .map(r => ({
        recipe: r,
        pays: paysIn(r, m).filter(p => p.token !== t),
        makes: givesOut(r, m).find(g => g.token === t)?.amount ?? 0,
      }))
      .filter(s => s.makes > 0 && s.pays.length);
    const free = m.grants.filter(g => lineToken(prizeLine(g.prize ?? g.gives), m) === t);
    const back = m.recipes
      .map(r => ({
        recipe: r,
        takes: paysIn(r, m).find(p => p.token === t)?.amount ?? 0,
        gives: givesOut(r, m).filter(g => g.token !== t),
      }))
      .filter(b => b.takes > 0 && b.gives.length);
    const tickets = m.lotteries.filter(l => ticketOf(l, m) === t);
    const spent =
      m.recipes.some(r => r.active !== false && paysIn(r, m).some(p => p.token === t)) ||
      m.allBoxes.some(b => b.currency === t) ||
      m.auctions.some(a => a.currency === t) ||
      m.contests.some(c => c.currency === t) ||
      m.payments.some(p => p.currency === t) ||
      m.farms.some(f => f.stakes === t);
    rows.set(t, { paid, free, back, tickets, spent });
  }
  return rows;
}

/** Runs the three analyses. `warn(code, where, message, fix)` as check() calls it; `now` in seconds. */
export function challenge(m, warn, now) {
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const on = r => r.active !== false;
  const priced = list => words(list.map(p => `${+p.amount.toFixed(9)} ${sym(p.token)}`));
  const rows = ledger(m);

  // ---- W-VALUE: follow the value of each token through its end states.
  for (const [t, { paid, free, back, tickets, spent }] of rows) {
    const T = sym(t);
    const first = paid[0];
    // Cancelled: a round short of its least sale refunds what reached it, the ticket token.
    for (const l of tickets) {
      if (!(num(l.minSold) > 0) || !first) continue;
      warn(
        'W-VALUE',
        `economy.lotteries.${l.key}.minSold`,
        `Following ${T} into ${named(l)}, cancelled: players buy ${T} with ${words(paid.map(s => `${named(s.recipe)} (${priced(s.pays)} for ${s.makes})`))}, and a round short of its ${l.minSold} tickets refunds ${T}, not the ${priced(first.pays)} paid for it, which stays where ${named(first.recipe)} sent it.`,
        `Price the tickets in ${sym(first.pays[0].token)} itself ("currency": "${first.pays[0].token}", "price": ${first.pays[0].amount / first.makes}, "rest": "burn" if they should burn), so a refund pays back what was paid; or keep a recipe that turns ${T} back switched off ("active": false) and switch it on after a cancelled round.`,
      );
    }
    // Undone: a way back to what bought it, open at all times, while the token is a ticket.
    const boughtWith = new Set(paid.flatMap(s => s.pays.map(p => p.token)));
    if (tickets.length)
      for (const b of back) {
        const r = b.recipe;
        if (!on(r) || r.closes !== undefined || r.opens !== undefined) continue;
        if (!b.gives.some(g => boughtWith.has(g.token))) continue;
        warn(
          'W-VALUE',
          `economy.recipes.${r.key}`,
          `Following ${T}, undone: ${named(r)} turns it back into ${priced(b.gives)} for ${b.takes} at any time (no "opens", "closes" or switch), so a ticket of ${words(tickets.map(named))} can be unbought before its draw${free.length ? `, and each ${T} given free becomes ${priced(b.gives)}` : ''}. A way back is for a cancelled round.`,
          'Make it "active": false and switch it on only after a cancelled round (an edit by the project), or give it "opens" and "closes" around the time it is for.',
        );
      }
    // From nothing: given free, sold for a price, and turned back into another token.
    if (first && back.length)
      for (const g of free) {
        const b = back.find(x => on(x.recipe)) ?? back[0];
        const amount = num(prizeLine(g.prize ?? g.gives).amount);
        const worth = b.gives.map(x => ({ token: x.token, amount: (x.amount * amount) / b.takes }));
        warn(
          'W-VALUE',
          `economy.grants.${g.key}`,
          `Following ${T}, from nothing: ${named(g)} gives ${amount} for free, ${named(first.recipe)} sells it for ${priced(first.pays)}, and ${named(b.recipe)} turns it back into ${priced(b.gives)}${on(b.recipe) ? '' : ' once it is switched on'}: each claim is worth ${priced(worth)}, held back only by the grant’s limits.`,
          'Give the free one a token of its own that turns into nothing, keep every way back switched off, or set the grant’s "limits" to what you would pay out.',
        );
      }
    // After the end: still made once the last draw it was good for is done, and nothing else takes it.
    if (tickets.length && !spent && tickets.every(l => !toSeconds(l.every) && l.firstDraw)) {
      const last = Math.max(...tickets.map(l => toTime(l.firstDraw, now)));
      const lastLot = tickets.find(l => toTime(l.firstDraw, now) === last);
      const after = `Following ${T}, after the end: it has no use after the last draw (${named(lastLot)}, ${at(last)})`;
      for (const g of free.filter(on))
        warn(
          'W-VALUE',
          `economy.grants.${g.key}`,
          `${after}, and ${named(g)} keeps giving it for as long as it is switched on.`,
          `Switch it off after the draw ("active": false, an edit by the project), make the lottery repeat ("every"), or give ${T} a use after it.`,
        );
      for (const { recipe: r } of paid.filter(s => on(s.recipe))) {
        if (r.closes !== undefined && toTime(r.closes, now) <= last) continue;
        warn(
          'W-VALUE',
          `economy.recipes.${r.key}`,
          `${after}, and ${named(r)} keeps selling it${r.closes === undefined ? ' with no "closes"' : ` until ${at(toTime(r.closes, now))}`}.`,
          `Give it "closes" at the draw (${at(last)}) or before, or switch it off after the draw.`,
        );
      }
    }
  }

  // ---- W-STEPS: one intent, one step. A price in a token the player crafts first is two transactions.
  for (const [t, { paid }] of rows) {
    const craft = paid.find(s => on(s.recipe) && !(s.recipe.out ?? []).some(o => o.gives === 'roll'));
    if (!craft) continue;
    const r = craft.recipe;
    const steps = `a craft of ${named(r)}, then the purchase: two transactions, two wallet prompts`;
    for (const l of m.lotteries.filter(x => ticketOf(x, m) === t)) {
      const per = num(l.price) / craft.makes;
      warn(
        'W-STEPS',
        `economy.lotteries.${l.key}`,
        `Buying tickets of ${named(l)} takes ${steps}, since they cost ${sym(t)}.`,
        `Send both in one: the play client's buyTickets("${l.key}", count, { listing, make: { recipe: "${r.key}", times: ${per === 1 ? 'count' : `count × ${+per.toFixed(9)}`}, listing } }) crafts and buys with one approval (kit 0.28.7 and later).`,
      );
    }
    for (const b of m.allBoxes.filter(x => x.currency === t && num(x.price) > 0))
      warn(
        'W-STEPS',
        `economy.${b.shopOf ? `items.${b.shopOf}` : `boxes.${b.key}`}`,
        `Buying ${named(b.shopOf ? m.item.get(b.shopOf) : b)} takes ${steps}, since it costs ${sym(t)}.`,
        `Price it in what ${named(r)} takes (${priced(craft.pays)} for each ${craft.makes} ${sym(t)}), unless holding ${sym(t)} is the point.`,
      );
  }

  // ---- W-ASSUMPTION: a lottery's least sale against what the scenario sells in a round. (A pool's life against the
  // scenario's rates is in check.mjs, from the simulation.)
  for (const l of m.lotteries) {
    if (!(num(l.minSold) > 0)) continue;
    const every = toSeconds(l.every);
    const untilDraw = l.firstDraw ? toTime(l.firstDraw, now) - now : 0;
    const roundDays = every ? every / DAY : untilDraw > 0 ? untilDraw / DAY : 0;
    if (!(roundDays > 0)) continue;
    const said = m.scenario.perDay?.[`lottery:${l.key}`];
    const perDay = num(said ?? DEFAULT_PER_DAY);
    let sold = perDay * roundDays;
    const players = num(m.scenario.players);
    const each = num(l.perWallet);
    const capped = players > 0 && each > 0 && players * each < sold;
    if (capped) sold = players * each;
    sold = Math.floor(sold);
    if (sold >= num(l.minSold)) continue;
    const round = every ? 'a round' : `its one round, until its draw at ${at(toTime(l.firstDraw, now))}`;
    warn(
      'W-ASSUMPTION',
      `economy.lotteries.${l.key}.minSold`,
      `${named(l)} is cancelled unless ${l.minSold} tickets sell in ${round}, and the scenario sells about ${sold}${capped ? ` (${players} players, at most ${each} each)` : said === undefined ? ` (it names no tickets for it: ${DEFAULT_PER_DAY} a day assumed)` : ` (${perDay} a day)`}. A cancelled round refunds every ticket and draws nothing. Its least sale can change only before the round's first ticket: the round keeps the terms it opened with.`,
      'Lower "minSold" to what you expect to sell (or leave it out), or set the scenario ("scenario.perDay", "scenario.players") to what you really expect and check again.',
    );
  }
}
