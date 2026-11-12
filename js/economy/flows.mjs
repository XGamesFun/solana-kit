// The spec as value that moves: what each asset is worth to a player and where it comes from, and each route as the
// states it goes through (before it opens, while it runs, cancelled or failed, won, after it ends, a change of mind),
// each state its steps: who sends it, who pays, what moves from where to where, and what happens if nobody sends it.
// One model the analyses (challenge.mjs) and the walk-through (walk.mjs) read, so every fact about a route is worked
// out once. Each sentence it backs follows the program's rules (PROGRAM.md). Pure.
//
// Lotteries, boxes (the shop's items with them), recipes and grants are modelled; the other kinds are the
// walk-through's own words until they are.
import { boxRolls, ORACLE_FEE, prizeLine, prizeToken, prizeWords, toSeconds, toTime } from './model.mjs';
import { DEFAULT_PER_DAY } from './simulate.mjs';

const DAY = 86_400;
/** A draw the oracle hasn't answered this long after its ask is cancelled at the next ask (LOTTERY_TIMEOUT_SECONDS). */
const ORACLE_TIMEOUT_DAYS = 7;
export const num = x => Number(x ?? 0);
export const at = seconds =>
  new Date(seconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, ' UTC');
export const named = part => `“${part?.name ?? part?.key}”`;
export const words = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
export const span = seconds =>
  seconds % DAY === 0
    ? `${seconds / DAY} d`
    : seconds % 3600 === 0
      ? `${seconds / 3600} h`
      : seconds % 60 === 0
        ? `${seconds / 60} min`
        : `${seconds} s`;
/** What a draw or a roll pays the oracle, in SOL. */
export const ORACLE_SOL = Number(ORACLE_FEE) / 1e9;

/** The token a token line pays in or gives, by key; null for an item, an NFT or a roll. */
export function lineToken(line, m) {
  const prize = prizeLine(line);
  if (prize?.gives !== 'tokens') return null;
  return prizeToken(prize, m)?.key ?? prize.currency ?? m.currencyKey;
}

/** What a recipe takes in tokens: [{ asset, amount }]. */
const paysIn = (r, m) =>
  (r.in ?? [])
    .filter(l => l.takes === 'pay')
    .map(l => ({ asset: l.currency ?? m.currencyKey, amount: num(l.amount), to: l.to ?? 'treasury' }));

/** What a recipe gives in tokens: [{ asset, amount }]. */
const givesOut = (r, m) =>
  (r.out ?? []).map(l => ({ asset: lineToken(l, m), amount: num(l.amount) })).filter(x => x.asset);

/** The token a lottery's tickets are paid in, or null for a free ticket or one paid with an NFT. */
export const ticketOf = (l, m) =>
  l.ticketNft || !(num(l.price) > 0) ? null : (l.ticketCurrency ?? l.currency ?? m.currencyKey);

/**
 * How many takers the scenario expects of a route in a span of days, and whether it said so: { expected, said, how }.
 * `expected` is null when the scenario names neither the route's count a day nor its players: a number that depends
 * on it is then unknown, never a default (`how` says what to ask).
 */
function participation(m, kind, key, days, perWallet) {
  const said = m.scenario.perDay?.[`${kind}:${key}`];
  const players = num(m.scenario.players);
  if (said === undefined && !players)
    return { expected: null, said: false, how: `the scenario names no count for it (“${kind}:${key}”) and no players` };
  let expected = said === undefined ? null : num(said) * days;
  let how = said === undefined ? '' : `${num(said)} a day`;
  if (players && perWallet && (expected === null || players * perWallet < expected)) {
    expected = players * perWallet;
    how = `${players} players, at most ${perWallet} each`;
  }
  if (expected === null)
    return {
      expected: null,
      said: false,
      how: `the scenario names ${players} players but not how many each takes (“${kind}:${key}” a day)`,
    };
  return { expected: Math.floor(expected), said: true, how };
}

/**
 * The model: { assets, routes, worth }. `worth`: Map asset key (an item's as "item:<key>") → its worth in the project's
 * currency at the spec's own rates.
 *
 * `assets`: Map asset key → { key, symbol, money, origins, free, backs, uses }: `money` for the project's currency
 * and SOL, what a player already holds as value; `origins`, recipes that sell it for another asset ({ recipe, pays,
 * makes }); `free`, grants that give it; `backs`, recipes that turn it into another asset ({ recipe, takes, gives });
 * `uses`, the routes that take it as a price.
 *
 * `routes`: [{ kind, key, name, where, part, price, active, opens, closes, ends, repeats, perWallet, gate, roll,
 * cancel, fixed, states }], `states` a list of { state, steps } in the order a player meets them; a step is { by,
 * pays, says, moves, ifNobody } (`by`: player, anyone, keys, server, oracle, winner; `moves`: [{ asset, amount, from,
 * to }]). `cancel`: { causes, likely, refund, participation } for a route that can be cancelled.
 */
export function flows(m, { now }) {
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const assets = new Map();
  for (const [key, t] of m.tokens) {
    const money = key === m.currencyKey || t.source === 'sol';
    const origins = m.recipes
      .map(r => ({
        recipe: r,
        pays: paysIn(r, m).filter(p => p.asset !== key),
        makes: givesOut(r, m).find(g => g.asset === key)?.amount ?? 0,
      }))
      .filter(s => s.makes > 0 && s.pays.length);
    const free = m.grants.filter(g => lineToken(prizeLine(g.prize ?? g.gives), m) === key);
    const backs = m.recipes
      .map(r => ({
        recipe: r,
        takes: paysIn(r, m).find(p => p.asset === key)?.amount ?? 0,
        gives: givesOut(r, m).filter(g => g.asset !== key),
      }))
      .filter(b => b.takes > 0 && b.gives.length);
    assets.set(key, { key, symbol: sym(key), money, origins, free, backs, uses: [] });
  }
  const priced = list => words(list.map(p => `${+num(p.amount).toFixed(9)} ${sym(p.asset)}`));
  const on = x => x?.active !== false;
  // What each asset is worth in the project's currency, at the spec's own rates: the currency itself, what a recipe
  // sells it for, else what a recipe turns it into; an item at its shop price. null when nothing prices it.
  const worth = new Map([[m.currencyKey, 1]]);
  for (let pass = 0; pass < 4; pass++)
    for (const [key, a] of assets) {
      if (worth.has(key)) continue;
      const value = list =>
        list.every(p => worth.has(p.asset)) ? list.reduce((n, p) => n + worth.get(p.asset) * p.amount, 0) : null;
      const bought = a.origins.map(o => value(o.pays)).find(v => v !== null);
      if (bought !== undefined) worth.set(key, bought / a.origins.find(o => value(o.pays) === bought).makes);
      else {
        const back = a.backs.find(b => value(b.gives) !== null);
        if (back) worth.set(key, value(back.gives) / back.takes);
      }
    }
  for (const b of m.shop)
    if ((b.currency ?? m.currencyKey) === m.currencyKey || worth.has(b.currency))
      worth.set(`item:${b.shopOf}`, num(b.price) * (worth.get(b.currency ?? m.currencyKey) ?? 1));
  const routes = [];

  // ---- lotteries
  for (const l of m.lotteries) {
    const t = ticketOf(l, m);
    const price = l.ticketNft ? [{ asset: 'nft', amount: 1 }] : t ? [{ asset: t, amount: num(l.price) }] : [];
    const every = toSeconds(l.every);
    const draw = l.firstDraw ? toTime(l.firstDraw, now) : null;
    const roundDays = every ? every / DAY : draw && draw > now ? (draw - now) / DAY : null;
    const minSold = num(l.minSold);
    // Its round's span unknown (a draw date passed or not given): what it sells is unknown unless the scenario says.
    const people = roundDays
      ? participation(m, 'lottery', l.key, roundDays, num(l.perWallet))
      : m.scenario.perDay?.[`lottery:${l.key}`] === undefined && !num(m.scenario.players)
        ? { expected: null, said: false, how: `the scenario names no count for it (“lottery:${l.key}”) and no players` }
        : null;
    // How likely a round is cancelled: short of its least sale (as likely as the scenario says, unknown when it says
    // nothing), or a draw the oracle never answers (rare).
    const likely = !minSold
      ? 'rare'
      : !people || people.expected === null
        ? 'unknown'
        : people.expected < minSold
          ? 'likely'
          : 'unlikely';
    // The player crafts the ticket's token first when it isn't money they already hold.
    const made = t && !assets.get(t)?.money ? assets.get(t).origins.filter(o => on(o.recipe)) : [];
    const closesBefore = num(toSeconds(l.closesBefore));
    const route = {
      kind: 'lottery',
      key: l.key,
      name: l.name ?? l.key,
      where: `economy.lotteries.${l.key}`,
      part: l,
      price,
      active: true,
      repeats: Boolean(every),
      ends: every ? null : draw,
      perWallet: num(l.perWallet),
      gate: Boolean(l.gate),
      roll: true,
      title: `a lottery, ${every ? `drawn every ${span(every)}` : `drawn once${draw ? `, at ${at(draw)}` : ''}`}`,
      cancel: {
        causes: [
          ...(minSold ? [`a round short of ${minSold} tickets, when its draw is asked`] : []),
          `a draw the oracle hasn't answered ${ORACLE_TIMEOUT_DAYS} days after it was asked, at the next ask`,
        ],
        likely,
        participation: people,
        minSold,
        refund: l.ticketNft ? [{ asset: 'nft', amount: 1 }] : price,
      },
      endings: [
        {
          ending: 'Nothing sold',
          then: every ? 'its date moves on to the next round; nothing to pay' : 'it ends with nothing to pay',
        },
        ...(minSold
          ? [
              {
                ending: `Fewer than ${minSold} tickets`,
                then: 'cancelled when its draw is asked: every ticket refunded, pulled by anyone',
              },
            ]
          : []),
        {
          ending: 'Nobody asks for the draw',
          then: 'the round waits with every ticket and its money in it, refunds too, with no deadline',
        },
        {
          ending: 'The oracle never answers',
          then: `the next ask ${ORACLE_TIMEOUT_DAYS} days after the first cancels it: every ticket refunded`,
        },
        { ending: 'The draw asked late', then: 'it is drawn then; nothing is lost, the winners just wait' },
        ...((l.places ?? []).length > 1 || (l.places ?? []).some(p => num(p.times) > 1)
          ? [
              {
                ending: 'Fewer tickets than places',
                then: `places with no winner pay nothing: their share goes where the round's leftover goes (${l.rest ?? (Number.isInteger(l.pot) ? 'the pot' : 'its rest')})`,
              },
            ]
          : []),
      ],
      fixed: {
        when: 'the first ticket',
        says: `The round copies the lottery's terms (price, places, least sale, draw date) at its first ticket: an edit after it reaches only the next round${every ? '' : ', and a lottery that draws once has none'}.`,
      },
      states: [],
    };
    const ticket = l.ticketNft ? 'an NFT that passes its rule' : t ? priced(price) : 'nothing but the player fee';
    route.states = [
      {
        state: 'open',
        steps: [
          {
            by: 'player',
            says: `It sells from the moment it is live; its first ticket opens the round.${l.gate ? ' Only wallets its gate admits buy.' : ''}`,
          },
        ],
      },
      {
        state: 'run',
        steps: [
          ...(made.length && t
            ? [
                {
                  by: 'player',
                  pays: 'player',
                  says: `crafts ${sym(t)} first with ${named(made[0].recipe)} (${priced(made[0].pays)} for ${made[0].makes})`,
                  moves: [
                    ...made[0].pays.map(p => ({ ...p, from: 'player', to: 'recipe' })),
                    { asset: t, amount: made[0].makes, from: 'recipe', to: 'player' },
                  ],
                  craft: made[0].recipe,
                },
              ]
            : []),
          {
            by: 'player',
            pays: 'player',
            says: `pays ${ticket} a ticket, and holds an entry in the round, not a token: it can't be sold or taken back. Sales close ${closesBefore ? `${span(closesBefore)} before` : 'at'} the draw`,
            moves: price.map(p => ({ ...p, from: 'player', to: `round:${l.key}` })),
          },
          { by: 'keys', says: 'nothing to send; an edit reaches the next round, never the one running' },
        ],
      },
      {
        state: 'cancel',
        steps: [
          {
            by: 'anyone',
            pays: 'sender',
            says: `refunds every ticket${t ? ` in ${sym(t)}` : ''}${l.ticketNft ? ' (the NFT back)' : ''}, the player fee not; each refund waits until someone pulls it to its buyer (anyone may: the page's claims() lists a player's)`,
            moves: route.cancel.refund.map(p => ({ ...p, from: `round:${l.key}`, to: 'player' })),
            ifNobody: 'a refund nobody pulls waits, with no deadline; a round nobody asks to draw waits too',
            per: 'each buyer',
            short: 'a refund pulled to its buyer',
          },
        ],
      },
      {
        state: 'win',
        steps: [
          {
            by: 'anyone',
            pays: 'sender',
            says: `asks for the draw once it is due, paying the oracle ${ORACLE_SOL} SOL`,
            ifNobody:
              'the round waits undrawn: a player or the project must ask (the page’s button, or the next buyer)',
            per: 'once a round',
            short: 'the ask for the draw (or the cancel, when the round is short)',
          },
          { by: 'oracle', says: 'answers; its answer picks the winners, drawn after sales close' },
          {
            by: 'anyone',
            pays: 'sender',
            says: `pulls each winner's part to the winner: ${words((l.places ?? []).map((p, i) => `place ${i + 1} ${p.prize ? prizeWords(p.prize, m) : `${num(p.percent)}% of the pot`}`)) || 'the pot'}. An item is given while it has stock`,
            ifNobody: 'a part nobody pulls waits for its winner, with no deadline',
            per: 'each winner',
            short: 'each winner’s part pulled to them',
          },
          ...((l.places ?? []).some(
            p => prizeLine(p.prize)?.gives === 'item' && m.item.get(prizeLine(p.prize).item)?.kind !== 'collectible',
          )
            ? [
                {
                  by: 'keys',
                  says: 'deliver a normal item, an off-chain prize, from its receipt',
                  ifNobody: 'the winner holds a receipt and nothing else',
                  per: 'each winner',
                  short: 'the off-chain prize delivered',
                  manual: 'deliver',
                },
              ]
            : []),
        ],
      },
      {
        state: 'after',
        steps: [
          every
            ? { by: 'player', says: 'The next round sells at once, on the lottery’s terms as they are then.' }
            : {
                by: 'keys',
                says: `It sells no more tickets.${t && !assets.get(t)?.money ? ` ${sym(t)} left in wallets does only what something else takes it for.` : ''} The owner may close it once its round is paid out, for its rent back.`,
              },
        ],
      },
      {
        state: 'undo',
        steps: [{ by: 'player', says: 'No way out: a ticket stays in the round until its draw or a cancel.' }],
      },
    ];
    if (t) assets.get(t)?.uses.push(route);
    routes.push(route);
  }

  // ---- boxes, and the shop's items (a box of one entry)
  for (const b of m.allBoxes) {
    const item = b.shopOf ? m.item.get(b.shopOf) : null;
    const source = item ?? b;
    const rolls = boxRolls(b, m);
    const cur = b.currency ?? m.currencyKey;
    const price = num(b.price) > 0 ? [{ asset: cur, amount: num(b.price) }] : [];
    const made = assets.get(cur)?.money ? [] : (assets.get(cur)?.origins.filter(o => on(o.recipe)) ?? []);
    const route = {
      kind: item ? 'item' : 'box',
      key: item ? item.key : b.key,
      name: item ? `${item.name ?? item.key} from the shop` : (b.name ?? b.key),
      where: item ? `economy.items.${item.key}` : `economy.boxes.${b.key}`,
      part: source,
      price,
      active: on(source),
      opens: source.opens !== undefined ? toTime(source.opens, now) : null,
      closes: source.closes !== undefined ? toTime(source.closes, now) : null,
      perWallet: num(source.perWallet),
      gate: Boolean(source.gate),
      roll: rolls,
      limited: Boolean(item?.supply) || (!item && rolls),
      title: item ? 'an item for sale' : rolls ? 'a box, rolled by the oracle' : 'a box',
      fixed:
        item?.kind === 'collectible'
          ? { when: 'the first sale', says: 'The item’s collection can’t change once a unit is out.' }
          : null,
      states: [
        {
          state: 'run',
          steps: [
            ...(made.length && price.length
              ? [
                  {
                    by: 'player',
                    pays: 'player',
                    says: `crafts ${sym(cur)} first with ${named(made[0].recipe)}`,
                    craft: made[0].recipe,
                  },
                ]
              : []),
            {
              by: 'player',
              pays: 'player',
              says: `pays ${price.length ? priced(price) : 'nothing but the player fee'}; ${rolls ? `the oracle rolls what they get (paid ${ORACLE_SOL} SOL), which lands with its answer` : 'gets what it gives at once'}`,
              moves: price.map(p => ({ ...p, from: 'player', to: 'treasury' })),
            },
            {
              by: 'keys',
              says: rolls
                ? 'nothing to send; an edit of its entries or odds refunds every paid roll still waiting, at once; a price change reaches the next purchase'
                : 'nothing to send',
            },
          ],
        },
        {
          state: 'cancel',
          steps: [
            rolls
              ? {
                  by: 'anyone',
                  says: "A roll the oracle hasn't answered is asked again once it is stale, by its player or your keys; nothing times it out. A prize out of stock is never set aside for a roll.",
                }
              : { by: 'player', says: 'A purchase that can’t give what it sells fails whole: nothing is taken.' },
          ],
        },
        {
          state: 'after',
          steps: [
            {
              by: 'keys',
              says:
                source.closes !== undefined
                  ? `Nothing sells after ${at(toTime(source.closes, now))}.`
                  : 'It sells until its stock runs out or the project switches it off.',
            },
          ],
        },
        { state: 'undo', steps: [{ by: 'player', says: 'No refund once paid.' }] },
      ],
    };
    assets.get(cur)?.uses.push(route);
    routes.push(route);
  }

  // ---- recipes
  for (const r of m.recipes) {
    const pays = paysIn(r, m);
    const gives = givesOut(r, m);
    const backs = m.recipes.filter(
      x =>
        x !== r &&
        givesOut(x, m).some(g => pays.some(p => p.asset === g.asset)) &&
        paysIn(x, m).some(p => gives.some(g => g.asset === p.asset)),
    );
    const route = {
      kind: 'recipe',
      key: r.key,
      name: r.name ?? r.key,
      where: `economy.recipes.${r.key}`,
      part: r,
      price: pays,
      gives,
      active: on(r),
      opens: r.opens !== undefined ? toTime(r.opens, now) : null,
      closes: r.closes !== undefined ? toTime(r.closes, now) : null,
      perWallet: num(r.perWallet),
      roll: (r.out ?? []).some(o => o.gives === 'roll'),
      title: 'a recipe',
      backs,
      states: [
        {
          state: 'run',
          steps: [
            {
              by: 'player',
              pays: 'player',
              says: `gives ${inWords(r, m, sym)}, gets ${words((r.out ?? []).map(o => prizeWords(o, m))) || 'nothing'}, in one transaction, all or nothing`,
              moves: [
                ...pays.map(p => ({ ...p, from: 'player', to: 'recipe' })),
                ...gives.map(g => ({ ...g, from: 'recipe', to: 'player' })),
              ],
            },
            { by: 'keys', says: 'nothing to send; an edit reaches the next craft' },
          ],
        },
        {
          state: 'cancel',
          steps: [{ by: 'player', says: 'A craft that can’t give every line fails whole: nothing is taken.' }],
        },
        {
          state: 'after',
          steps: [
            {
              by: 'keys',
              says:
                r.closes !== undefined
                  ? `Nothing is crafted after ${at(toTime(r.closes, now))}.`
                  : 'It crafts until the project switches it off.',
            },
          ],
        },
        {
          state: 'undo',
          steps: [
            {
              by: 'player',
              says: backs.length
                ? `${words(backs.map(named))} turns it back${backs.some(on) ? '' : ' once the project switches it on'}.`
                : 'No undo: what it took is spent.',
            },
          ],
        },
      ],
    };
    for (const p of pays) assets.get(p.asset)?.uses.push(route);
    routes.push(route);
  }

  // ---- grants
  for (const g of m.grants) {
    const prize = prizeLine(g.prize ?? g.gives);
    const asset = lineToken(prize, m);
    const how = g.vouchers?.length
      ? 'a voucher from the project’s results server'
      : g.list
        ? 'a place on its list'
        : 'nothing but its limits';
    const limits = Object.entries(g.limits ?? {})
      .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ');
    routes.push({
      kind: 'grant',
      key: g.key,
      name: g.name ?? g.key,
      where: `economy.grants.${g.key}`,
      part: g,
      price: [],
      gives: asset ? [{ asset, amount: num(prize.amount) }] : [],
      active: on(g),
      opens: g.limits?.opens !== undefined ? toTime(g.limits.opens, now) : null,
      ends: g.limits?.until !== undefined ? toTime(g.limits.until, now) : null,
      title: 'a grant',
      trust: g.vouchers?.length ? (g.trust ?? 'what it checks') : null,
      states: [
        {
          state: 'run',
          steps: [
            {
              by: 'winner',
              pays: 'sender',
              says: `claims ${prizeWords(g.prize ?? g.gives, m)}, proving it with ${how}; only their own wallet signs the claim`,
            },
            ...(g.vouchers?.length
              ? [{ by: 'server', says: 'signs each voucher', ifNobody: 'no server, no claims', manual: 'server' }]
              : []),
            { by: 'keys', says: "its funds pay each claim's rent: keep them topped up" },
          ],
          cheater: `${g.vouchers?.length ? `gets whatever the server signs (${g.trust ?? 'what it checks'}): a signed result is worth what the server checks; ` : g.list ? '' : 'every wallet may claim; '}its limits are the ceiling (${limits || 'none'})`,
        },
        {
          state: 'cancel',
          steps: [
            {
              by: 'winner',
              says: 'A claim whose prize can’t be given (a pool run dry, an item out of stock) is refused and keeps its round: it can be claimed later.',
            },
          ],
        },
        {
          state: 'after',
          steps: [
            {
              by: 'keys',
              says:
                g.limits?.until !== undefined
                  ? `It takes no claim after ${at(toTime(g.limits.until, now))} (its "until"), nor once its limits are reached or the project switches it off.`
                  : 'It gives until its limits are reached or the project switches it off: it has no end date.',
            },
          ],
        },
      ],
    });
  }
  // ---- contests: players back a side; a decider (or the authority) names one once entries close
  for (const c of m.contests) {
    const cur = c.currency ?? m.currencyKey;
    const minPot = num(c.minPot);
    const deciders = (c.deciders ?? []).length;
    const people = minPot
      ? m.scenario.perDay?.[`contest:${c.key}`] === undefined && !num(m.scenario.players)
        ? {
            expected: null,
            said: false,
            how: `the scenario names no entries for it (“contest:${c.key}”) and no players`,
          }
        : null
      : null;
    const shares = (c.split ?? []).map(x => ({ to: x.to, percent: num(x.percent) }));
    const route = {
      kind: 'contest',
      key: c.key,
      name: c.name ?? c.key,
      where: `economy.contests.${c.key}`,
      part: c,
      price: c.stakeNft ? [{ asset: 'nft', amount: 1 }] : [{ asset: cur, amount: num(c.stake) || 1 }],
      active: true,
      gate: Boolean(c.gate),
      title: `a contest, decided by ${deciders ? `${deciders === 1 ? 'a decider key' : `${deciders} decider keys`} (verdicts only)` : 'the project’s authority'}`,
      decider: deciders ? 'decider' : 'authority',
      shares,
      cancel: {
        causes: [
          `no result by its result deadline${c.resultDue ? ` (${c.resultDue} after it opens)` : ''}`,
          ...(minPot ? [`less than ${minPot} in its sides when entries close`] : []),
          'a call-off',
        ],
        likely: minPot ? (people ? 'unknown' : 'unlikely') : 'rare',
        participation: people,
        refund: c.stakeNft ? [{ asset: 'nft', amount: 1 }] : [{ asset: cur, amount: num(c.stake) || 1 }],
      },
      endings: [
        { ending: 'No entries', then: 'nothing to pay; the project closes it' },
        ...(minPot
          ? [
              {
                ending: `Less than ${minPot} in its sides when entries close`,
                then: 'it is off: every entry claims its money back',
              },
            ]
          : []),
        {
          ending: `No result by its deadline${c.resultDue ? ` (${c.resultDue} after it opens)` : ''}`,
          then: `${deciders ? 'the decider key lost or its server down' : 'the authority away'} included: anyone calls it off and every entry claims its money back`,
        },
        {
          ending: 'A result after its deadline',
          then: 'refused: it is called off and every entry claims its money back',
        },
        { ending: 'A result before entries close', then: 'refused (only a call-off is taken before then)' },
        {
          ending: 'A tie, or a result nobody can call',
          then: `the program names one side or none: ${deciders ? 'the decider key' : 'the authority'} picks a side or calls it off, and a call-off pays every entry back`,
        },
        {
          ending: 'Nobody on the winning side',
          then: 'naming a side nobody backed is refused (NoWinner): it is called off, now or at its deadline, and every entry is paid back',
        },
      ],
      fixed: { when: 'it opens', says: 'Every term is fixed when it opens and never edited.' },
      states: [
        {
          state: 'run',
          steps: [
            {
              by: 'player',
              pays: 'player',
              says: `backs one side${c.stake ? ` with exactly ${num(c.stake)} ${sym(cur)}` : c.stakeNft ? ' with one NFT' : ` with ${sym(cur)}`}${c.entriesClose ? ` until entries close (${c.entriesClose} after it opens)` : ''}; a wallet backs one side, never two`,
            },
            { by: 'keys', says: 'nothing to send until entries close; its terms are fixed' },
          ],
          cheater: `the result is worth what its ${deciders ? 'decider keys check' : 'authority checks'}; nobody names a side before entries close, but whoever learns the outcome before entries close can back the sure side`,
        },
        {
          state: 'cancel',
          steps: [
            {
              by: 'anyone',
              pays: 'sender',
              says: `claims each entry's money back for it (anyone may)`,
              ifNobody: 'an entry nobody claims waits, with no deadline',
              per: 'each entry',
              short: 'each entry’s refund claimed',
            },
          ],
        },
        {
          state: 'win',
          steps: [
            {
              by: deciders ? 'anyone' : 'keys',
              pays: 'sender',
              says: deciders
                ? 'sends a decider’s signed verdict naming the side, once entries close (anyone may send it)'
                : 'names the side once entries close, with the authority key',
              ifNobody: 'no result by its deadline: it is called off and everyone takes their money back',
              per: 'once',
              short: 'the result',
              ...(deciders ? { manual: 'decide' } : { manual: 'decide-authority' }),
            },
            {
              by: 'anyone',
              pays: 'sender',
              says: `claims each winner's share of the pot, by what each put in${shares.length ? `, after the shares (${words(shares.map(x => `${x.percent}% to ${x.to}`))}) taken when the result is named` : ''}`,
              ifNobody: 'a winner’s part waits for them, with no deadline',
              per: 'each winner',
              short: 'each winner’s part claimed',
            },
          ],
        },
        { state: 'undo', steps: [{ by: 'player', says: 'An entry stays until the result or a refund.' }] },
      ],
    };
    assets.get(cur)?.uses.push(route);
    routes.push(route);
  }

  // The kinds not modelled yet still use what they take: an auction's, a contest's or a payment's currency, a farm's
  // staked token.
  const other = (kind, list, assetOf) =>
    list.forEach(x => {
      const asset = assetOf(x);
      if (asset)
        assets
          .get(asset)
          ?.uses.push({ kind, key: x.key, name: x.name ?? x.key, price: [], states: [], active: true, ends: null });
    });
  other('auction', m.auctions, a => a.currency ?? m.currencyKey);
  other('payment', m.payments, p => p.currency ?? m.currencyKey);
  other('farm', m.farms, f => (m.tokens.has(f.stakes) ? f.stakes : null));
  return { assets, routes, worth };
}

/** A recipe's inputs in words. */
function inWords(r, m, sym) {
  return (
    words(
      (r.in ?? []).map(l =>
        l.takes === 'pay'
          ? `${num(l.amount)} ${sym(l.currency ?? m.currencyKey)}`
          : l.item
            ? `${l.count ?? 1} ${named(m.item.get(l.item) ?? { key: l.item })} (${l.takes === 'burn' ? 'burned' : l.takes === 'use' || l.takes === 'renew' ? 'used, kept' : l.takes === 'staked' ? 'staked, kept' : l.takes})`
            : l.takes === 'show'
              ? 'an NFT of a collection, shown and kept'
              : l.takes === 'trade'
                ? 'an NFT of a collection, traded in'
                : l.takes,
      ),
    ) || 'nothing'
  );
}

export { DEFAULT_PER_DAY };
