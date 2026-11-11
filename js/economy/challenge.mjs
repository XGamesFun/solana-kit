// Traps the program takes as written, found by a game that went live with them (Bubble Day, 2026-11-11): a ticket
// token bought with another token, so a cancelled round refunds the ticket token and not what was paid for it; a way
// back from that token left open at all times; a free grant of a token that is also sold and converts back; a least
// sale the scenario's players never reach; a ticket that needs a craft first, two wallet prompts unless both go in one
// transaction; and a token still earned after the last draw it was good for. Each is a warning: the person decides.
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
 * Warns of the traps above. `warn(code, where, message, fix)` as check() calls it; `now` in seconds.
 */
export function challenge(m, warn, now) {
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const on = r => r.active !== false;
  /** The recipes that sell token `t` for another token: [{ recipe, pays: [{ token, amount }], makes }]. */
  const sellers = t =>
    m.recipes
      .map(r => ({
        recipe: r,
        pays: paysIn(r, m).filter(p => p.token !== t),
        makes: givesOut(r, m).find(g => g.token === t)?.amount ?? 0,
      }))
      .filter(s => s.makes > 0 && s.pays.length);
  /** The recipes that turn token `t` back into another token: [{ recipe, takes, gives: [{ token, amount }] }]. */
  const backs = t =>
    m.recipes
      .map(r => ({
        recipe: r,
        takes: paysIn(r, m).find(p => p.token === t)?.amount ?? 0,
        gives: givesOut(r, m).filter(g => g.token !== t),
      }))
      .filter(b => b.takes > 0 && b.gives.length);
  const priced = list => words(list.map(p => `${p.amount} ${sym(p.token)}`));
  const tickets = new Map();
  for (const l of m.lotteries) {
    const t = ticketOf(l, m);
    if (t) tickets.set(t, [...(tickets.get(t) ?? []), l]);
  }

  // ---- W-REFUND-NOT-PAID: a cancelled round refunds what reached it, in its ticket token.
  for (const l of m.lotteries) {
    const t = ticketOf(l, m);
    // Tickets in the game's currency or SOL refund what the player paid.
    if (!t || t === m.currencyKey || m.tokens.get(t)?.source === 'sol' || !(num(l.minSold) > 0)) continue;
    const sold = sellers(t);
    if (!sold.length) continue;
    const s = sold[0];
    const ways = sold.map(x => `${named(x.recipe)} (${priced(x.pays)} for ${x.makes} ${sym(t)})`);
    warn(
      'W-REFUND-NOT-PAID',
      `economy.lotteries.${l.key}.minSold`,
      `${named(l)}’s tickets are paid in ${sym(t)}, which players buy with another token: ${words(ways)}. A round short of its ${l.minSold} tickets is cancelled, and its refund pays back ${sym(t)}, the ticket token, not the ${priced(s.pays)} a player paid for it: that stays where ${named(s.recipe)} sent it. A player who wanted their ${sym(s.pays[0].token)} back has no way to get it unless the project opens one.`,
      `Price the tickets in ${sym(s.pays[0].token)} itself ("currency": "${s.pays[0].token}", "price": ${s.pays[0].amount / s.makes}, "rest": "burn" if they should burn), so a refund pays back what was paid; or keep a recipe that turns ${sym(t)} back into ${sym(s.pays[0].token)} switched off ("active": false) and switch it on after a cancelled round.`,
    );
  }

  // ---- W-SWAP-BACK-OPEN: a way back from a ticket token, open at all times.
  for (const [t, lots] of tickets) {
    const made = sellers(t);
    if (!made.length) continue;
    const paidWith = new Set(made.flatMap(s => s.pays.map(p => p.token)));
    for (const b of backs(t)) {
      const r = b.recipe;
      if (!on(r) || r.closes !== undefined || r.opens !== undefined) continue;
      if (!b.gives.some(g => paidWith.has(g.token))) continue;
      warn(
        'W-SWAP-BACK-OPEN',
        `economy.recipes.${r.key}`,
        `${named(r)} turns ${sym(t)}, the ticket of ${words(lots.map(named))}, back into ${priced(b.gives)} for ${b.takes}, and it is open with no "opens" or "closes": anyone holding ${sym(t)} can undo their purchase at any time, before a draw or after losing interest, and every ${sym(t)} given free becomes ${priced(b.gives)}. A way back is for a cancelled round.`,
        `Make it "active": false and switch it on only after a cancelled round (an edit by the project), or give it "opens" and "closes" around the time it is for.`,
      );
    }
  }

  // ---- W-FREE-IS-PAID: a free grant of a token that is also sold, and turns back into another token.
  for (const g of m.grants) {
    const prize = prizeLine(g.prize ?? g.gives);
    const t = lineToken(prize, m);
    // The project's own currency, or SOL, given as a reward is what a grant is for.
    if (!t || t === m.currencyKey || m.tokens.get(t)?.source === 'sol') continue;
    const sold = sellers(t);
    const back = backs(t);
    if (!sold.length || !back.length) continue;
    const b = back.find(x => on(x.recipe)) ?? back[0];
    const per = num(prize.amount) / b.takes;
    const worth = b.gives.map(x => ({ token: x.token, amount: +(x.amount * per).toFixed(9) }));
    warn(
      'W-FREE-IS-PAID',
      `economy.grants.${g.key}`,
      `${named(g)} gives ${num(prize.amount)} ${sym(t)} for nothing, the token ${named(sold[0].recipe)} sells for ${priced(sold[0].pays)}, and ${named(b.recipe)} turns it back into ${priced(b.gives)}${on(b.recipe) ? '' : ' once it is switched on'}: each claim is worth ${priced(worth)}, and the grant’s limits are all that hold that back.`,
      `Give the free one a token of its own that turns into nothing (a free-entry token a lottery also takes, or an NFT ticket), keep every way back switched off, or set the grant's "limits" to what you would pay out.`,
    );
  }

  // ---- W-MINSOLD-VS-SCENARIO: a least sale above what the scenario's players buy in a round.
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
      'W-MINSOLD-VS-SCENARIO',
      `economy.lotteries.${l.key}.minSold`,
      `${named(l)} is cancelled unless ${l.minSold} tickets sell in ${round}, and the scenario sells about ${sold}${capped ? ` (${players} players, at most ${each} each)` : said === undefined ? ` (it names no tickets for it: ${DEFAULT_PER_DAY} a day assumed)` : ` (${perDay} a day)`}. A cancelled round refunds every ticket and draws nothing. Its least sale can change only before the round's first ticket: the round keeps the terms it opened with.`,
      `Lower "minSold" to what you expect to sell (or leave it out), or set the scenario ("scenario.perDay", "scenario.players") to what you really expect and check again.`,
    );
  }

  // ---- W-TWO-PROMPTS: a ticket the player crafts first, then buys: one wallet prompt each, unless one transaction.
  for (const [t, lots] of tickets) {
    const made = sellers(t).filter(s => on(s.recipe) && !(s.recipe.out ?? []).some(o => o.gives === 'roll'));
    if (!made.length || t === m.currencyKey) continue;
    const s = made[0];
    for (const l of lots)
      warn(
        'W-TWO-PROMPTS',
        `economy.lotteries.${l.key}`,
        `A player buys ${named(l)}’s tickets with ${sym(t)}, which they get from ${named(s.recipe)}: a craft, then a purchase, two wallet prompts a buy (more, for each ticket crafted one at a time).`,
        `Send both in one transaction: the play client's buyTickets(“${l.key}”, count, { listing, make: { recipe: “${s.recipe.key}”, times: ${num(l.price) / s.makes === 1 ? 'count' : `count × ${+(num(l.price) / s.makes).toFixed(9)}`}, listing } }) crafts what the tickets cost and buys them with one approval (kit 0.28.7 and later).`,
      );
  }

  // ---- W-AFTER-THE-END: a token still given after the last draw it was good for.
  for (const [t, lots] of tickets) {
    if (t === m.currencyKey || m.tokens.get(t)?.source === 'sol' || lots.some(l => toSeconds(l.every))) continue;
    if (lots.some(l => !l.firstDraw)) continue;
    const used =
      m.recipes.some(r => on(r) && paysIn(r, m).some(p => p.token === t)) ||
      m.allBoxes.some(b => b.currency === t) ||
      m.auctions.some(a => a.currency === t) ||
      m.contests.some(c => c.currency === t) ||
      m.payments.some(p => p.currency === t) ||
      m.farms.some(f => f.stakes === t);
    if (used) continue;
    const last = Math.max(...lots.map(l => toTime(l.firstDraw, now)));
    const lastLot = lots.find(l => toTime(l.firstDraw, now) === last);
    const after = `${sym(t)} has no use after the last draw (${named(lastLot)}, ${at(last)})`;
    for (const g of m.grants) {
      if (g.active === false || lineToken(prizeLine(g.prize ?? g.gives), m) !== t) continue;
      warn(
        'W-AFTER-THE-END',
        `economy.grants.${g.key}`,
        `${named(g)} keeps giving ${sym(t)} for as long as it is switched on, and ${after}: players go on claiming a token that does nothing.`,
        `Switch it off after the draw ("active": false, an edit by the project), make the lottery repeat ("every"), or give ${sym(t)} a use after it.`,
      );
    }
    for (const r of m.recipes) {
      if (!on(r) || !givesOut(r, m).some(x => x.token === t)) continue;
      if (r.closes !== undefined && toTime(r.closes, now) <= last) continue;
      warn(
        'W-AFTER-THE-END',
        `economy.recipes.${r.key}`,
        `${named(r)} keeps making ${sym(t)}${r.closes === undefined ? ' with no "closes"' : ` until ${at(toTime(r.closes, now))}`}, and ${after}: a player can still pay for a token that does nothing.`,
        `Give it "closes" at the draw (${at(last)}) or before, or switch it off after the draw.`,
      );
    }
  }
}
