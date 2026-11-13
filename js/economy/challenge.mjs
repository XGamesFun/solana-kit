// The analyses that challenge a spec, computed over its model (flows.mjs), each a warning code with the situation in
// its message and a severity that follows how likely the state is: the program takes all of it as written, and the
// person decides.
//
// - W-VALUE, follow the value: what a player holds in each end state of each route against what they put in (a refund
//   in another asset than the one paid), value that converts back at any time, appears from nothing, grows around a
//   loop of recipes, or keeps being made after its last use.
// - W-STEPS, one intent, one step: an intent that takes more transactions (wallet prompts) than it needs.
// - W-ENFORCED, where each rule is kept: a result named by a key (what else it can do, what its holder gains under
//   each outcome, when the outcome can first be known, how a player checks it).
// - W-ASSUMPTION, check every assumption: a number that depends on how many take part (a lottery's least sale, a
//   contest's least pot) against the scenario. A number the scenario doesn't state is unknown: the finding is the
//   question to ask the person, never an estimate from a default.
//
// Who sends each later step and what happens if nobody does is in the walk-through (walk.mjs, from the same model); a
// voucher's trust in the review's trust levels.
import { at, flows, lineToken, named, num, ticketOf, words } from './flows.mjs';
import { prizeLine, prizeToken, serverRate, toSeconds, toTime } from './model.mjs';
import { simulate } from './simulate.mjs';
import { exchanges, payouts } from './exchanges.mjs';
import { journeyOf } from './walk.mjs';

/** A cancel's severity, by how likely it is: the scenario says it is (or says nothing), says it isn't, or only the oracle's timeout. */
const BY_LIKELY = { likely: 'high', unknown: 'high', unlikely: 'medium', rare: 'low' };

/**
 * Runs the analyses. `warn(code, where, message, fix, extra)` as check() calls it, `extra` { severity, ask }; `now`
 * in seconds; `economy`, the spec, for the quick simulation's burns. Returns the model, for the caller to show.
 */
export function challenge(m, warnTo, now, economy) {
  // (every grant cap a question is about, so the caps nobody was asked about are asked once, together, at the end)
  const askedCaps = new Set();
  const warn = (code, where, message, fix, extra) => {
    const cap = extra?.ask ? /^economy\.grants\.(.+)\.limits\.(\w+)$/.exec(where) : null;
    if (cap) askedCaps.add(`${cap[1]}.${cap[2]}`);
    return warnTo(code, where, message, fix, extra);
  };
  const fl = flows(m, { now });
  // The owner's order is plays best, then clean, then secure: a bound the server keeps (a voucher server that decides or
  // replays who earns) is where such a limit lives when an on-chain cap tight enough to hold it would cost real players.
  const serverHeld = g => (g?.vouchers ?? []).length > 0 && ['decides', 'replays'].includes(g.trust);
  const lower = sev => ({ high: 'medium', medium: 'low', low: 'low' })[sev];
  const SERVER_NOTE =
    ' Its voucher server decides who earns, so the server holds this bound in practice: a cap on chain tight enough to hold it would also stop real players (a claim every few minutes), so keep it there and say so.';
  /** The quick simulation at the spec's scenario, run once when an analysis needs it. */
  let sim = null;
  const { assets, routes } = fl;
  const sym = key => (key === 'nft' ? 'the NFT' : (assets.get(key)?.symbol ?? key));
  const on = x => x?.active !== false;
  const priced = list => words(list.map(p => `${+num(p.amount).toFixed(9)} ${sym(p.asset)}`));
  const alwaysOpen = r => on(r) && r.closes === undefined && r.opens === undefined;

  // ---- W-VALUE
  // Cancelled: what comes back against what was paid for it.
  for (const route of routes) {
    const c = route.cancel;
    if (!c) continue;
    for (const back of c.refund) {
      const a = assets.get(back.asset);
      const origin = a?.origins.find(o => on(o.recipe)) ?? a?.origins[0];
      if (!a || a.money || !origin) continue;
      const ways = a.backs.filter(b => b.gives.some(g => origin.pays.some(p => p.asset === g.asset)));
      const p = c.participation;
      const burned = origin.pays.every(x => x.to === 'burn');
      const why =
        c.likely === 'likely'
          ? `likely: the scenario sells about ${p.expected} a round (${p.how}), short of ${c.minSold}`
          : c.likely === 'unknown'
            ? `how likely is unknown: ${p?.how ?? 'the scenario says nothing'}, against a least sale of ${c.minSold}`
            : c.likely === 'unlikely'
              ? `the scenario sells about ${p.expected} a round (${p.how}), enough for its ${c.minSold}`
              : 'rare: only a draw the oracle never answers';
      warn(
        'W-VALUE',
        route.where,
        `Following ${a.symbol} into ${named(route)}, cancelled: players buy ${a.symbol} with ${words(a.origins.map(o => `${named(o.recipe)} (${priced(o.pays)} for ${o.makes})`))}, and a cancelled round (${c.causes.join(', or ')}) refunds ${a.symbol}, not the ${priced(origin.pays)} paid for it, which ${origin.pays.every(x => x.to === 'burn') ? 'was burned' : `stays where ${named(origin.recipe)} sent it (${words([...new Set(origin.pays.map(x => x.to))])})`}. ${ways.length ? `${words(ways.map(w => named(w.recipe)))} turns ${a.symbol} back${ways.some(w => on(w.recipe)) ? '' : ' once the project switches it on'}.` : `Nothing turns ${a.symbol} back.`} Each refund waits until someone pulls it (anyone may; the page's claims() lists a player's). How likely a cancel is: ${why}.`,
        `The pick for the refund (it keeps the payment ${origin.pays.every(x => x.to === 'burn') ? 'burned' : 'going where it goes'}, one approval, no swap and nothing for the owner to do after a cancel; it assumes nothing else): hold the payment until the outcome is final and settle it then. Price ${named(route)} in ${sym(origin.pays[0].asset)} itself ("currency": "${origin.pays[0].asset}", "price": ${origin.pays[0].amount / origin.makes}${route.kind === 'lottery' ? ', with "rest": "burn" to burn it once the round is drawn' : ''}), so a cancel refunds what was paid. A free entry then is either ${sym(origin.pays[0].asset)} itself (which can be spent) or a ticket to a draw of its own (a second draw): with more wants than the refund (a free entry that isn't money, one draw), run xsolana_design, which weighs them all. The other fix gives up something: a recipe that turns ${a.symbol} back, switched off and switched on after a cancel, needs the owner after every cancel and is a swap players can use while it is on.`,
        // A payment that is burned can't be given back by anyone, so how a cancel ends is the person's to decide when
        // they ask for the burn, however rare a cancel is: at least medium, with the question.
        burned
          ? {
              severity: BY_LIKELY[c.likely] === 'low' ? 'medium' : BY_LIKELY[c.likely],
              // (a want that removes a way out is asked with the version that keeps it, never as a yes or no)
              ask: `${a.symbol} for ${named(route)} is bought with ${priced(origin.pays)} that is burned on the spot, and nobody can give a burned payment back: a cancelled round (${c.causes.join(', or ')}) then refunds only ${a.symbol}. The burn can wait for the outcome instead: ${named(route)} priced in ${sym(origin.pays[0].asset)} itself holds each payment until the outcome is final${route.kind === 'lottery' ? ' and burns it then' : ''}, and a cancel gives it back. Which do you want: the payment held until the outcome (it keeps the refund), or burned on entry with ${a.symbol} as the only refund?${route.fixed ? ` Choose before it is built: a round's terms are fixed at ${route.fixed.when}.` : ''}`,
            }
          : { severity: BY_LIKELY[c.likely] },
      );
    }
  }

  for (const [, a] of assets) {
    if (a.money) continue;
    const chance = a.uses.filter(r => r.roll && r.price.some(p => p.asset === a.key));
    const boughtWith = new Set(a.origins.flatMap(o => o.pays.map(p => p.asset)));
    // Undone: a way back to what bought it, open at all times, while it pays for something with an outcome.
    if (chance.length)
      for (const b of a.backs) {
        const r = b.recipe;
        if (!alwaysOpen(r) || !b.gives.some(g => boughtWith.has(g.asset))) continue;
        warn(
          'W-VALUE',
          `economy.recipes.${r.key}`,
          `Following ${a.symbol}, undone: ${named(r)} turns it back into ${priced(b.gives)} for ${b.takes} at any time (no "opens", "closes" or switch), so what it pays for (${words(chance.map(named))}) can be unbought before its outcome${a.free.length ? `, and each ${a.symbol} given free becomes ${priced(b.gives)}` : ''}. A way back is for a cancel.`,
          'Make it "active": false and switch it on only after a cancel (an edit by the project), or give it "opens" and "closes" around the time it is for.',
          { severity: a.free.length ? 'high' : 'medium' },
        );
      }
    // From nothing: given free, sold for a price, and turned back into another asset.
    const origin = a.origins[0];
    if (origin && a.backs.length)
      for (const g of a.free) {
        const b = a.backs.find(x => on(x.recipe)) ?? a.backs[0];
        const amount = num((g.prize ?? g.gives)?.amount);
        const worth = b.gives.map(x => ({ asset: x.asset, amount: (x.amount * amount) / b.takes }));
        warn(
          'W-VALUE',
          `economy.grants.${g.key}`,
          `Following ${a.symbol}, from nothing: ${named(g)} gives ${amount} for free, ${named(origin.recipe)} sells it for ${priced(origin.pays)}, and ${named(b.recipe)} turns it back into ${priced(b.gives)}${on(b.recipe) ? '' : ' once it is switched on'}: each claim is worth ${priced(worth)}, held back only by ${g.serverLimit ? `what its server signs (${serverRate(g).says}): up to ${priced(b.gives.map(x => ({ asset: x.asset, amount: (x.amount * serverRate(g).one) / b.takes })))} a ${g.serverLimit.per === 'all' ? 'day for everyone' : `${g.serverLimit.per} a day`}` : 'the grant’s limits'}.${serverHeld(g) ? SERVER_NOTE : ''}`,
          'Give the free one an asset of its own that turns into nothing, keep every way back switched off, or set the grant’s "limits" to what you would pay out.',
          { severity: serverHeld(g) ? lower(on(b.recipe) ? 'high' : 'medium') : on(b.recipe) ? 'high' : 'medium' },
        );
      }
    // After the end: still made once the last route it was good for has ended, and nothing else takes it.
    const live = a.uses.filter(on);
    const ends = live.map(r => r.ends ?? null);
    if (live.length && ends.every(e => e !== null)) {
      const last = Math.max(...ends);
      const lastUse = live.find(r => r.ends === last);
      const after = `Following ${a.symbol}, after the end: it has no use after ${named(lastUse)} (${at(last)})`;
      for (const g of a.free
        .filter(on)
        .filter(g => !(g.limits?.until !== undefined && toTime(g.limits.until, now) <= last)))
        warn(
          'W-VALUE',
          `economy.grants.${g.key}`,
          `${after}, and ${named(g)} keeps giving it for as long as it is switched on.`,
          `Switch it off after ${named(lastUse)} ("active": false, an edit by the project), make that route repeat, or give ${a.symbol} a use after it.`,
          { severity: 'low' },
        );
      for (const { recipe: r } of a.origins.filter(o => on(o.recipe))) {
        if (r.closes !== undefined && toTime(r.closes, now) <= last) continue;
        warn(
          'W-VALUE',
          `economy.recipes.${r.key}`,
          `${after}, and ${named(r)} keeps selling it${r.closes === undefined ? ' with no "closes"' : ` until ${at(toTime(r.closes, now))}`}.`,
          `Give it "closes" at ${at(last)} or before, or switch it off after it.`,
          { severity: 'low' },
        );
      }
    }
  }

  // Loops across routes: every route as an exchange from what it takes to what it gives (exchanges.mjs), and every
  // cycle that comes back with more than it started, caps or not: a boost bought with its farm's rewards, a prize that
  // buys more chances at itself, recipes whose rates multiply above 1.
  sim ??= simulateOrNull(economy, now);
  const edges = exchanges(m, fl, sim, now);
  const label = key => (key.startsWith('item:') ? named(m.item.get(key.slice(5)) ?? { key: key.slice(5) }) : sym(key));
  const seen = new Set();
  const walkLoop = (start, here, path, rate) => {
    for (const e of edges.filter(x => x.from === here && x.rate > 0)) {
      if (path.includes(e) || path.some(x => x.from === e.to && e.to !== start)) continue;
      const next = [...path, e];
      if (e.to === start) {
        const key = next
          .map(x => x.route)
          .sort()
          .join('|');
        const gain = rate * e.rate;
        if (gain > 1 + 1e-9 && !seen.has(key)) {
          seen.add(key);
          const caps = [...new Set(next.map(x => x.cap).filter(Boolean))];
          warn(
            'W-VALUE',
            next[0].where,
            `Following ${label(start)}, around a loop: ${next.map(x => `${x.says} (${label(x.from)} into ${label(x.to)} at ${+x.rate.toPrecision(4)} for 1)`).join(', then ')}. One turn gives back ${+gain.toPrecision(4)} for each 1 put in, as often as a player repeats it${caps.length ? `; ${words(caps)} bound${caps.length === 1 ? 's' : ''} how often, not the edge` : ', and nothing caps it'}.`,
            'Make the rates meet at 1 or less around the loop: cheaper rewards, a dearer step, or an output that can’t buy back in (another token, an item the farm doesn’t take).',
            { severity: caps.length ? 'medium' : 'high' },
          );
        }
      } else if (next.length < 4) walkLoop(start, e.to, next, rate * e.rate);
    }
  };
  for (const key of new Set(edges.map(x => x.from))) walkLoop(key, key, [], 1);

  // Every path to the same thing, priced at the spec's own rates (a crafted input at what crafting it costs, so a chain
  // of recipes is priced through): one far cheaper than the others is the path everyone takes.
  const costs = new Map();
  for (const e of edges) {
    const w = fl.worth.get(e.from);
    if (w === undefined || !(e.rate > 0)) continue;
    costs.set(e.to, [...(costs.get(e.to) ?? []), { cost: w / e.rate, e }]);
  }
  for (const [to, paths] of costs) {
    const byRoute = [...new Map(paths.map(p => [p.e.route, p])).values()].sort((a, b) => a.cost - b.cost);
    if (byRoute.length < 2) continue;
    const [cheap, dear] = [byRoute[0], byRoute.at(-1)];
    if (!(cheap.cost < dear.cost * 0.67)) continue;
    const item = to.startsWith('item:') ? m.item.get(to.slice(5)) : null;
    warn(
      'W-VALUE',
      cheap.e.where,
      `Following ${label(to)}, its paths: ${byRoute.map(p => `${p.e.says} costs about ${+p.cost.toPrecision(4)} ${sym(m.currencyKey)} for one`).join('; ')}. The cheapest is ${+(dear.cost / cheap.cost).toFixed(2)}× cheaper than the dearest, so it is the path everyone takes${item?.supply ? `, and the ${item.supply} there are go that way first` : ''}.`,
      'Price the paths to meet, or say which one is meant to be the cheap one and why.',
      { severity: item?.supply ? 'medium' : 'low' },
    );
  }

  // What each feature pays a player a day, in the project's currency: a free one that pays the most is the economy's
  // biggest payout, whatever it was meant to be.
  const pays = payouts(m, fl, sim);
  const top = pays[0];
  if (top?.free && pays.some(x => !x.free) && top.perDay > 0)
    warn(
      'W-VALUE',
      top.where,
      `Following ${sym(m.currencyKey)} a day: the free ${named({ name: top.name })} pays a player about ${+top.perDay.toPrecision(4)} ${sym(m.currencyKey)} a day (${top.how}), the most of any feature: ${pays
        .slice(1)
        .filter(x => x.perDay > 0)
        .slice(0, 3)
        .map(x => `${named({ name: x.name })} ${+x.perDay.toPrecision(4)} (${x.how})`)
        .join(
          ', ',
        )}. A free feature that pays most is what every extra identity is made for.${serverHeld(m.grant.get(top.where.split('.').at(-1))) ? SERVER_NOTE : ''}`,
      'Make it pay less than the paid features, cap it per identity per day where that costs real players nothing (else keep the bound on the server and say so), or gate it on something that costs.',
      { severity: serverHeld(m.grant.get(top.where.split('.').at(-1))) ? 'low' : 'medium' },
    );

  // ---- W-STEPS: a player's whole loop through a route (getting its price, buying, collecting), one wallet prompt a
  // step that nothing folds into another: past two, say each step and what folds them together.
  for (const route of routes.filter(r => r.price.length && r.kind !== 'recipe' && r.kind !== 'item')) {
    const j = journeyOf(route, fl);
    // (what is left with every fold the kit's own client makes: a page that buys with `make` is not told it has a
    // prompt too many; the walk-through says what the page must call, and what it costs without it)
    if (j.folded <= 2) continue;
    warn(
      'W-STEPS',
      route.where,
      `A player's loop through ${named(route)} takes ${j.folded} wallet prompts${j.folded < j.prompts ? ` at best (${j.prompts} when the page folds nothing)` : ''}: ${j.steps.join(', then ')}.`,
      j.bundles.length
        ? `Fold them: ${j.bundles.join('; ')}.`
        : 'Price it in what the player already holds, or give it without a step the player must sign.',
      { severity: 'low' },
    );
  }

  // ---- W-ASSUMPTION: a number that depends on how many take part, against the scenario; unknown when it says nothing.
  for (const route of routes) {
    const c = route.cancel;
    if (!c?.minSold || !c.participation) continue;
    const p = c.participation;
    const round = route.repeats
      ? 'a round'
      : route.ends
        ? `its one round, until its draw at ${at(route.ends)}`
        : 'its one round';
    if (p.expected === null)
      warn(
        'W-ASSUMPTION',
        `${route.where}.minSold`,
        `Unknown: ${named(route)} is cancelled unless ${c.minSold} tickets sell in ${round}, and ${p.how}, so whether it ever draws is a guess. Ask the person how many players they expect and how many tickets each buys before building on it. Its least sale can change only before the round's first ticket.`,
        `Ask, then write it in the scenario ("scenario.players", and "perWallet" or "scenario.perDay": {"lottery:${route.key}": n}) and check again; or leave "minSold" out.`,
        {
          severity: 'medium',
          ask: `It needs ${c.minSold} tickets to draw: how many players will ${named(route)} have, and how many tickets will each buy before its draw?`,
        },
      );
    else if (p.expected < c.minSold)
      warn(
        'W-ASSUMPTION',
        `${route.where}.minSold`,
        `${named(route)} is cancelled unless ${c.minSold} tickets sell in ${round}, and the scenario sells about ${p.expected} (${p.how}). A cancelled round refunds every ticket and draws nothing. Its least sale can change only before the round's first ticket: the round keeps the terms it opened with.`,
        'Lower "minSold" to what you expect to sell (or leave it out), or set the scenario to what you really expect and check again.',
        { severity: 'high' },
      );
  }
  for (const ct of m.contests) {
    if (!num(ct.minPot)) continue;
    if (m.scenario.perDay?.[`contest:${ct.key}`] !== undefined || num(m.scenario.players)) continue;
    warn(
      'W-ASSUMPTION',
      `economy.contests.${ct.key}.minPot`,
      `Unknown: ${named(ct)} is off unless its sides hold ${ct.minPot} when entries close, and the scenario names no entries for it (“contest:${ct.key}”) and no players, so whether it ever pays out is a guess. Ask the person how many will enter and with how much. It is fixed when the contest opens.`,
      `Ask, then write it in the scenario ("scenario.perDay": {"contest:${ct.key}": n}) and check again.`,
      {
        severity: 'medium',
        ask: `It needs ${ct.minPot} in its sides: how many will enter ${named(ct)}, and with how much?`,
      },
    );
  }
  /** How many units farm `f` can ever hold staked: an item's supply, the totals of what gives it, a token's supply. */
  const stakeCap = f => {
    if (f.stakes !== 'collectibles') return num(m.tokens.get(f.stakes)?.supply) || Infinity;
    if (!f.item) {
      // The items its gate names, else every collectible of the project's (a gate on another collection: no cap known).
      const rules = Array.isArray(f.gate) ? f.gate : f.gate ? [f.gate] : [];
      if (rules.some(r => r.collection)) return Infinity;
      const named = rules.flatMap(r => [r.item, ...(r.items ?? [])]).filter(Boolean);
      const items = named.length ? named.map(k => m.item.get(k)) : m.items.filter(it => it.kind === 'collectible');
      return items.length && items.every(it => num(it?.supply))
        ? items.reduce((n, it) => n + num(it.supply), 0)
        : Infinity;
    }
    const supply = num(m.item.get(f.item)?.supply);
    if (supply) return supply;
    const gives = x => prizeLine(x)?.gives === 'item' && prizeLine(x).item === f.item;
    const sold = m.allBoxes.some(b => (b.outcomes ?? []).some(gives)) || m.recipes.some(r => (r.out ?? []).some(gives));
    const totals = m.grants.filter(g => gives(g.prize ?? g.gives)).map(g => num(g.limits?.total));
    if (sold || !totals.length || totals.some(t => !t)) return Infinity;
    return totals.reduce((a, b) => a + b, 0);
  };
  // Net flow: a token with value (the project's currency, one that turns back into money, a farm's rewards) minted for
  // free a day at its caps, against what the scenario burns of it a day.
  const valued = key => {
    const a = assets.get(key);
    return (
      key === m.currencyKey ||
      a?.backs.some(b => b.gives.some(g => assets.get(g.asset)?.money)) ||
      m.farms.some(f => f.rewards === key)
    );
  };
  for (const [key, t] of m.tokens) {
    if (!['game', 'project'].includes(t.source) || !valued(key)) continue;
    const grants = m.grants.filter(
      g =>
        on(g) && prizeLine(g.prize ?? g.gives)?.from === 'mint' && lineToken(prizeLine(g.prize ?? g.gives), m) === key,
    );
    const farms = m.farms.filter(f => f.rewards === key && f.rate?.minted && num(f.rate.perDay) > 0);
    if (!grants.length && !farms.length) continue;
    sim ??= simulateOrNull(economy, now);
    const amountOf = g => num(prizeLine(g.prize ?? g.gives).amount);
    // A grant whose server declares what it signs ("serverLimit") is counted at that rate: what the economy really
    // pays. Its chain caps are only what a leaked voucher key could take, said beside it.
    const players = num(m.scenario.players);
    const held = grants.filter(g => g.serverLimit).map(g => ({ g, rate: serverRate(g, players) }));
    const chainOnly = grants.filter(g => !g.serverLimit);
    const served = held.reduce((n, x) => n + (x.rate.all ?? 0), 0);
    const daily = chainOnly.filter(g => num(g.limits?.perDay));
    const totalOnly = chainOnly.filter(g => !num(g.limits?.perDay) && num(g.limits?.total));
    const uncapped = chainOnly.filter(g => !num(g.limits?.perDay) && !num(g.limits?.total));
    const capped = daily.reduce((n, g) => n + amountOf(g) * num(g.limits.perDay), 0) + served;
    // A farm at what the routes can create, not the scenario's example: every unit that can exist, staked at its best
    // boost (a shared rate is the whole farm's).
    const atCaps = farms.map(f => {
      const cap = stakeCap(f);
      const best = 1 + Math.max(0, ...(f.boosts ?? []).map(x => num(x.add?.addPercent))) / 100;
      const said = num(sim?.farms?.find(x => x.key === f.key)?.rewardsPerDay);
      return { f, cap, perDay: f.rate.shared ? num(f.rate.perDay) : cap * num(f.rate.perDay) * best, said };
    });
    const farmed = atCaps.reduce((n, x) => n + x.perDay, 0);
    const burned = num(sim?.perDay?.burned?.[key]);
    if (!uncapped.length && capped + farmed <= burned) continue;
    warn(
      'W-VALUE',
      `economy.tokens.${key}`,
      `Following ${sym(key)}, net flow: ${[
        daily.length
          ? `grants mint up to ${+(capped - served).toFixed(9)} a day at their caps (${words(daily.map(named))})`
          : '',
        ...held.map(
          ({ g, rate }) =>
            `${named(g)}'s server signs at most ${rate.says}${rate.all !== null ? `, about ${+rate.all.toFixed(6)} a day${rate.per === 'all' ? '' : ` with the scenario's ${players} players`}` : ' (the scenario names no players, so not a day in all)'}${num(g.limits?.perDay) ? `; if its voucher key leaks, the chain allows ${+(amountOf(g) * num(g.limits.perDay)).toFixed(9)} a day` : ''}`,
        ),
        ...atCaps.map(x =>
          x.perDay === Infinity
            ? `${named(x.f)} mints as rewards with no cap: nothing bounds how many ${x.f.stakes === 'collectibles' ? 'NFTs it takes' : `${sym(x.f.stakes)} can be staked`}${x.said ? ` (the scenario's example, ${+x.said.toFixed(6)} a day, is not a cap)` : ''}`
            : `${named(x.f)} mints up to ${+x.perDay.toFixed(6)} a day as rewards with all ${x.f.rate.shared ? 'it pays' : `${x.cap} that can exist staked`}${x.said && x.said < x.perDay ? ` (the scenario's example stakes less: ${+x.said.toFixed(6)} a day)` : ''}`,
        ),
        totalOnly.length
          ? `${words(totalOnly.map(g => `${named(g)} (up to ${+(amountOf(g) * num(g.limits.total)).toFixed(9)} in all)`))} ${totalOnly.length === 1 ? 'has' : 'have'} no daily cap`
          : '',
        uncapped.length
          ? `${words(uncapped.map(named))} mint${uncapped.length === 1 ? 's' : ''} it with no cap at all`
          : '',
      ]
        .filter(Boolean)
        .join(
          '; ',
        )}, and the scenario burns ${+burned.toFixed(9)} a day. What is minted and not burned stays in players' hands: each ${sym(key)} buys less as they pile up.${grants.length && !farms.length && grants.every(serverHeld) ? SERVER_NOTE : ''}`,
      'Cap every free mint a day ("limits.perDay") at or below what is burned where that costs real players nothing (else keep the bound on the voucher server and say so), burn more (a share of each sale, a recipe that burns), or fix the supply (mint it once into a pool and pay from there).',
      // (a free mint with no cap at all is high; a farm with no cap on its stake is medium, as the review's endless farm)
      {
        severity:
          grants.length && !farms.length && grants.every(serverHeld)
            ? lower(uncapped.length ? 'high' : 'medium')
            : uncapped.length
              ? 'high'
              : 'medium',
      },
    );
  }

  // Farms: what a seat earns over the farm's run against what its stake costs (payback), how fast a stake grows when
  // its rewards buy more of it (growth), and what the earning items given away print. At x1, before any halving.
  const { worth } = fl;
  const money = sym(m.currencyKey);
  for (const f of m.farms) {
    sim ??= simulateOrNull(economy, now);
    const row = sim?.farms?.find(x => x.key === f.key);
    const days = f.runs ? toSeconds(f.runs) / 86_400 : num(sim?.scenario?.days);
    if (!row) continue;
    if (row.perUnitPerDay === undefined) {
      if (f.rate?.shared || !f.rate)
        warn(
          'W-ASSUMPTION',
          `economy.farms.${f.key}`,
          `Unknown: what a seat of ${named(f)} earns depends on how much is staked, and the scenario doesn't say ("scenario.staked": {"${f.key}": n}). Ask the person how much they expect staked, then check again.`,
          `Ask, then write it in "scenario.staked".`,
          { severity: 'medium', ask: `How much do you expect staked in ${named(f)}?` },
        );
      continue;
    }
    const per = num(row.perUnitPerDay);
    const stakeKey = f.stakes === 'collectibles' ? (f.item ? `item:${f.item}` : null) : f.stakes;
    const cost = stakeKey ? worth.get(stakeKey) : undefined;
    const reward = worth.get(f.rewardsToken);
    const unit =
      f.stakes === 'collectibles' ? `${f.item ? named(m.item.get(f.item)) : 'NFT'} staked` : `${sym(f.stakes)} staked`;
    const halving = f.rate?.halveEvery ? `, before its halving every ${f.rate.halveEvery}` : '';
    const freeStake =
      f.stakes === 'collectibles'
        ? f.item &&
          (m.grants.some(g => prizeLine(g.prize ?? g.gives)?.item === f.item) ||
            m.lotteries.some(l => (l.places ?? []).some(p => prizeLine(p.prize)?.item === f.item)) ||
            m.allBoxes.some(b => !b.shopOf && (b.outcomes ?? []).some(o => o.item === f.item)))
        : assets.get(f.stakes)?.free.length > 0;
    if (cost && reward !== undefined && days) {
      const ratio = (per * days * reward) / cost;
      if (ratio > 1)
        warn(
          'W-VALUE',
          `economy.farms.${f.key}`,
          `Following ${sym(f.rewardsToken)} out of ${named(f)}, payback: each ${unit} earns ${+(per * days).toFixed(6)} ${sym(f.rewardsToken)} over ${+days.toFixed(2)} days at x1${halving}${f.rewardsToken !== m.currencyKey ? `, worth ${+(per * days * reward).toFixed(6)} ${money}` : ''}, against the ${+cost.toFixed(6)} ${money} it costs: ${+ratio.toFixed(3)}× back, so every extra wallet that stakes one more profits${freeStake ? ', and some are given away free, so every extra identity that gets one prints for nothing' : ''}.`,
          'Lower the rate or the run until a seat earns back at most what it costs, pay from a fixed vault instead of minting, or cap who may stake (a gate, perWallet).',
          { severity: freeStake ? 'high' : 'medium' },
        );
    }
    // Growth: rewards that buy more of the stake (the same token, or one that prices it).
    const sameToken = f.rewardsToken === f.stakes;
    const rate = sameToken
      ? per
      : cost && reward !== undefined && f.stakes !== 'collectibles'
        ? (per * reward) / cost
        : null;
    if (rate && rate > 0 && days) {
      const doubling = Math.log(2) / Math.log(1 + rate);
      if (doubling < days)
        warn(
          'W-VALUE',
          `economy.farms.${f.key}`,
          `Following ${sym(f.rewardsToken)} back into ${named(f)}, growth: a stake whose rewards are staked again grows ${+(rate * 100).toFixed(4)}% a day, doubling every ${+doubling.toFixed(1)} days, ×${+Math.pow(1 + rate, days).toPrecision(4)} over its ${+days.toFixed(2)} days${halving}. Its end limits how long it grows, not how fast.`,
          'Lower the rate (halve it every so often: "halveEvery"), or pay rewards in a token that doesn’t buy more stake.',
          { severity: doubling < days / 4 ? 'high' : 'medium' },
        );
    }
    // Giveaways of what this farm takes, priced in what they print.
    if (f.stakes === 'collectibles' && f.item)
      for (const g of m.grants.filter(g => prizeLine(g.prize ?? g.gives)?.item === f.item)) {
        // What its server really gives (its declared total, or its rate over the run for everyone), else the chain total.
        const held = serverRate(g, num(m.scenario.players));
        const count = held
          ? num(held.total) || (held.all !== null ? Math.floor(held.all * days) : 0) || num(g.limits?.total)
          : num(g.limits?.total);
        warn(
          'W-VALUE',
          `economy.grants.${g.key}`,
          `Following ${sym(f.rewardsToken)}, given away: ${named(g)} gives ${named(m.item.get(f.item))}, which earns ${per} ${sym(f.rewardsToken)} a day in ${named(f)}: ${count ? `its ${count} claims print up to ${+(count * per * days).toFixed(6)} ${sym(f.rewardsToken)} over ${+days.toFixed(2)} days${held ? ' (its server’s limit)' : ''}${reward !== undefined && f.rewardsToken !== m.currencyKey ? `, worth ${+(count * per * days * reward).toFixed(6)} ${money}` : ''}` : 'it has no total, so what it prints has no cap'}.`,
          'Cap the grant ("limits.total") at what you would pay out, or give an item the farm doesn’t take.',
          { severity: count ? 'medium' : 'high' },
        );
      }
  }

  // ---- W-ENFORCED: where each rule is kept. A result named by a key: what else that key can do, what its holder gains
  // under each outcome, how a player checks it, and every moment someone can learn the outcome before entries close.
  for (const route of routes.filter(r => r.kind === 'contest')) {
    const c = route.part;
    const toProject = route.shares.filter(
      x => ['treasury', 'owner'].includes(x.to) || String(x.to).startsWith('wallet:'),
    );
    warn(
      'W-ENFORCED',
      route.where,
      route.decider === 'authority'
        ? `${named(route)}'s result is named with the authority key, which can also mint the project's tokens, move its pools and edit every route: a key on a server for this holds all of that. Whoever holds it can also enter: players trust them with the result. A decider key ("deciders") only signs a verdict, and anyone sends it.`
        : `${named(route)}'s result is named by its decider keys' signed verdict: they sign nothing else, and whoever holds one can also enter, so players trust them with the result.`,
      route.decider === 'authority'
        ? 'Name a decider key (up to three) for the server, and keep the authority off it.'
        : 'Say who holds each decider key and what it checks before it signs.',
      { severity: route.decider === 'authority' ? 'medium' : 'low' },
    );
    if (toProject.length)
      warn(
        'W-ENFORCED',
        `${route.where}.split`,
        `${named(route)} pays ${words(toProject.map(x => `${x.percent}% to ${x.to}`))} only when a side is named; a call-off refunds everyone and pays it nothing. Whoever decides for the project gains by naming a side rather than calling it off, whatever happened.`,
        'Say so to players, or take the project’s part as a flat fee on entry instead (a payment), so naming a side or calling it off pays the same.',
        { severity: 'low' },
      );
    warn(
      'W-ENFORCED',
      `${route.where}.entriesClose`,
      `${named(route)}'s entries close ${c.entriesClose ? `${c.entriesClose} after it opens` : 'when it says'}, by the clock, and the program names a side only after that. If its outcome can be known earlier (a match that ends, a score posted, a result leaked), whoever knows it can back the sure side before entries close. A verdict is only a signature: players can check a result only against what the decider publishes.`,
      'Close entries before the first moment anyone can learn the outcome, and publish what each verdict rests on.',
      {
        severity: 'medium',
        ask: `Entries must close before anyone can know the result: when can someone first learn the outcome of ${named(route)}?`,
      },
    );
  }

  // The largest holder as a participant: a token of fixed supply sits in the owner's wallet after setup, all but what
  // its pools are seeded with; where holding more takes more (a farm shared by stake, a lottery, a contest), the owner
  // taking part takes that share.
  for (const [key, t] of m.tokens) {
    const shared = m.farms.filter(f => f.stakes === key && (!f.rate || f.rate.shared));
    const chances = [
      ...m.lotteries.filter(l => ticketOf(l, m) === key),
      ...m.contests.filter(c => (c.currency ?? m.currencyKey) === key),
    ];
    if ((!shared.length && !chances.length) || t.source === 'sol') continue;
    // Who holds it: the scenario's word, else a fixed supply the project made (all in the owner's wallet but its pools'
    // seeds), else unknown for a token made elsewhere: ask.
    const said = m.scenario.holders?.[key];
    let supply = num(said?.supply ?? t.supply);
    let held = said ? Math.max(num(said.owner), num(said.largest)) : null;
    const who = said && num(said.largest) > num(said.owner) ? 'the largest holder' : "the owner's wallet";
    if (!said && ['game', 'project'].includes(t.source) && supply) {
      const seeded =
        m.pools.filter(p => p.currency === key).reduce((n, p) => n + num(p.seed), 0) +
        m.farms.filter(f => f.rewards === key).reduce((n, f) => n + num(f.seed), 0);
      held = supply - seeded;
    }
    if (held === null) {
      if (t.source === 'existing')
        warn(
          'W-ASSUMPTION',
          `economy.tokens.${key}`,
          `Unknown: ${sym(key)} is made elsewhere and taken where holding more takes more (${words([...shared, ...chances].map(named))}), and the scenario doesn't say who holds it ("scenario.holders"). A holder of most of it takes most of what those pay.`,
          'Ask, then write it in "scenario.holders" ({"supply", "owner", "largest"}) and check again.',
          {
            severity: 'medium',
            ask: `Who holds ${sym(key)}: how much is there, and how much do the owner and the largest holder have?`,
          },
        );
      continue;
    }
    if (!(held > 0) || !supply) continue;
    const pct = (held / supply) * 100;
    const shares = shared.map(f => {
      const others = num(m.scenario.staked?.[f.key]);
      return others
        ? `${named(f)}: ${+((held / (held + others)) * 100).toFixed(1)}% of its rewards against the ${others} the scenario has others stake`
        : `${named(f)}: most of its rewards, unless others stake far more (the scenario names no stake)`;
    });
    if (pct < 10) {
      if (!said)
        warn(
          'W-ASSUMPTION',
          `economy.tokens.${key}`,
          `Unknown: who holds ${sym(key)} besides the owner (a treasury, the team, early buyers, an exchange), where holding more takes more (${words([...shared, ...chances].map(named))}). The largest of them takes the largest share.`,
          'Ask, then write it in "scenario.holders" ({"supply", "owner", "largest"}) and check again.',
          { severity: 'low', ask: `Who holds the most ${sym(key)} besides the owner, and will they stake or play?` },
        );
      continue;
    }
    warn(
      'W-ASSUMPTION',
      `economy.tokens.${key}.supply`,
      `The largest holder takes part: ${said ? '' : 'after setup '}${who} holds ${+held.toFixed(6)} ${sym(key)}, ${+pct.toFixed(1)}% of its supply of ${supply}. Staked or spent where holding more takes more, it takes ${words([...shares, ...chances.map(x => `${named(x)}: as many tickets or as much of a side as it likes`)])}.`,
      `Say whether ${who === 'the largest holder' ? 'the largest holder' : 'the owner'} takes part; if not, keep those ${sym(key)} out (seed them into a pool, a vesting schedule, or burn them), or rate the farm per seat instead of shared by stake.`,
      {
        severity: pct > 50 ? 'high' : 'medium',
        ask: `Will ${who === 'the largest holder' ? 'the largest holder' : 'the owner'}'s ${+held.toFixed(6)} ${sym(key)} (${+pct.toFixed(1)}% of the supply) be staked or played${said ? '' : ', and who else holds a large share (a treasury, the team, early buyers)'}?`,
      },
    );
  }

  // A voucher grant that takes the page's word (or doesn't say) holds its real limit on its server: declared, the tools
  // reason from it; undeclared, ask.
  for (const g of m.grants.filter(g => (g.vouchers ?? []).length && !g.serverLimit && g.trust !== 'decides'))
    warn(
      'W-ASSUMPTION',
      `economy.grants.${g.key}`,
      `${named(g)} takes ${g.trust === 'replays' ? 'a replayed result' : "the page's word"} within the caps its server keeps, and the spec doesn't say what those are ("serverLimit"): every figure here is the chain's caps, which only bound a leaked voucher key.`,
      'Ask, then declare it: "serverLimit": { "per": "person" | "wallet" | "all", "amount", "claims", "every", "total" }.',
      {
        severity: 'low',
        ask: `How much does your server let one person (or wallet) take from ${named(g)}, per hour or per day, and in all? And how does it set each claim's amount (a multiplier, a streak, a rank, a code)? And what does it convert, so it can go in "offchain"?`,
      },
    );

  // A conversion declared off chain with no rate is counted one for one: what follows from it rests on that guess.
  for (const x of (m.offchain ?? []).filter(x => x.rate === undefined))
    warn(
      'W-ASSUMPTION',
      'economy.offchain',
      `Unknown: ${named(x)} (off chain) says what it takes and gives but not how much ("rate"), so it is counted one for one, and any loop through it is sized on that guess.`,
      'Ask, then give it a "rate": how much it gives for each one taken (for "farm:<key>", the percent a seat earns more).',
      { severity: 'low', ask: `How much does ${named(x)} give for each one it takes?` },
    );

  // A result or reward decided off chain (a voucher server, a decider) may give more than the spec shows: a boost, a
  // ranking that pays. Declared in "offchain", it is followed like any route; undeclared, ask.
  const offChain = [...m.grants.filter(g => (g.vouchers ?? []).length), ...m.contests];
  if (offChain.length && !(m.offchain ?? []).length)
    warn(
      'W-ASSUMPTION',
      'economy.offchain',
      `${words(offChain.map(named))} ${offChain.length === 1 ? 'is' : 'are'} decided off chain, and the spec declares nothing a server or the page does with what players hold or win ("offchain"). A boost, a ranking or a better reward the server grants for it is invisible to these checks, so a loop through it is not followed.`,
      // (a yes or no the person can answer; what the server computes is the builder's to read, not the person's to recite)
      'If you wrote the server and the page, read what each computes from what players hold or win, and say the answer to the person in one sentence; if they run their own, ask. Then declare each in "offchain" ({ "key", "takes", "gives", "rate" }) and check again.',
      {
        severity: 'low',
        ask: 'Does anything a player holds or wins get them more from your server or page (a boost, a better reward, a place on a board that pays): yes, and which, or no?',
      },
    );

  // A grant's funds (the SOL that pays each claim's rent) against the claims its audience makes: sized per claim, they
  // run out at a count of players.
  for (const g of m.grants.filter(g => on(g) && num(g.fund) > 0)) {
    sim ??= simulateOrNull(economy, now);
    const each = num(sim?.grants?.find(x => x.key === g.key)?.fundsPerClaimSol);
    if (!each) continue;
    const covers = Math.floor(num(g.fund) / each);
    const l = g.limits ?? {};
    const per =
      l.perPerson ??
      l.perWallet ??
      (l.perWalletEach
        ? l.perWalletEach.count *
          Math.ceil((num(m.scenario.days) || 30) / Math.max(toSeconds(l.perWalletEach.every ?? '1d') / 86_400, 1 / 24))
        : null);
    const players = num(m.scenario.players);
    if (!players)
      warn(
        'W-ASSUMPTION',
        `economy.grants.${g.key}.fund`,
        `Unknown: ${named(g)}'s funds (${g.fund} SOL) pay about ${covers} claims (${each} SOL each), and the scenario names no players, so when they run out is a guess. After that each claimer pays their own rent.`,
        'Ask, then size "fund" for the audience: players × claims each × the rent a claim costs.',
        { severity: 'low', ask: `How many players will claim ${named(g)}, and how many times each?` },
      );
    else if (per && covers < players * per)
      warn(
        'W-ASSUMPTION',
        `economy.grants.${g.key}.fund`,
        `${named(g)}'s funds (${g.fund} SOL) pay about ${covers} claims, and the scenario's ${players} players at ${per} each make ${players * per}: the funds run out after about ${Math.floor(covers / per)} players, and the rest pay their own rent (about ${each} SOL a claim).`,
        `Fund it for the audience: about ${+(players * per * each).toFixed(6)} SOL, or tell players a claim may cost them its rent.`,
        { severity: 'medium' },
      );
  }

  // ---- W-ASSUMPTION: one item through several routes; a grant's cap against the stated audience; who runs each step
  // only a person or a server sends; what freezes at the first sale.
  const givers = new Map();
  const give = (item, route) => item && givers.set(item, [...(givers.get(item) ?? []), route]);
  for (const b of m.allBoxes)
    for (const o of b.outcomes ?? []) if (o.gives === 'item') give(o.item, b.shopOf ? `the shop` : named(b));
  for (const g of m.grants) give(prizeLine(g.prize ?? g.gives)?.item, named(g));
  for (const l of m.lotteries) for (const p of l.places ?? []) give(prizeLine(p.prize)?.item, named(l));
  for (const r of m.recipes) for (const o of r.out ?? []) if (o.gives === 'item') give(o.item, named(r));
  for (const a of m.auctions) give(a.lot?.item, named(a));
  for (const [key, list] of givers) {
    const by = [...new Set(list)];
    if (by.length < 2) continue;
    const it = m.item.get(key);
    warn(
      'W-ASSUMPTION',
      `economy.items.${key}`,
      `${named(it)} reaches players through ${words(by)}: ${it?.supply ? `its supply of ${it.supply} is shared by all of them, first come first served, and ` : ''}each route's per-wallet limit counts on its own, so one wallet may take it through each, an early list's buyer again in public.`,
      'Say which route comes first and whether one wallet may take it twice; if not, give it through one route, or gate the later one on not holding it.',
      { severity: 'low' },
    );
  }
  const players = num(m.scenario.players);
  for (const g of m.grants) {
    const per = num(g.limits?.perPerson ?? g.limits?.perWallet);
    const total = num(g.limits?.total);
    if (!players || !per || !total || total >= players * per) continue;
    warn(
      'W-ASSUMPTION',
      `economy.grants.${g.key}.limits.total`,
      `${named(g)} gives ${total} claims in all, and ${players} players at ${per} each would take ${players * per}: it runs out before every player has claimed, first come first served (a bot first of all).`,
      'Raise "total" to the audience you expect, or tell players it is first come, first served.',
      { severity: 'medium' },
    );
  }
  // Every cap of every grant against the pace the game allows an honest player. The chain's caps count claims; a
  // server's limit counts what it signs (an amount, and claims when it says so). When one player reaches each cap of
  // their own, when everyone together reaches the shared ones, and whether the server signs a claim the chain then
  // refuses (it has counted the claim; the player gets nothing until the cap's window turns).
  const horizon = num(m.scenario.days) || 30;
  const about = d => (d * 24 < 48 ? `${+(d * 24).toFixed(1)} hours` : `${+d.toFixed(1)} days`);
  for (const g of m.grants.filter(on)) {
    const l = g.limits ?? {};
    const line = prizeLine(g.prize ?? g.gives);
    const each = num(line?.amount) || 1;
    // (the token it pays in: its pool's, or the one it mints; a pool-paid prize names no currency of its own)
    const unit =
      line?.gives === 'tokens' ? (prizeToken(line, m)?.symbol ?? sym(line.currency ?? m.currencyKey)) : 'of its prize';
    const sr = serverRate(g);
    const own = sr && sr.per !== 'all' && sr.one > 0;
    const counts = [
      l.perWalletEach?.count && `${l.perWalletEach.count} a wallet every ${l.perWalletEach.every ?? '1d'}`,
      l.perWallet && `${l.perWallet} a wallet in all`,
      l.perPerson && `${l.perPerson} a person in all`,
      l.perDay && `${l.perDay} a day for everyone`,
      l.total && `${l.total} in all`,
    ].filter(Boolean);
    // Claims a day for one honest player at the most the game allows: the server's claims, or its amount over the
    // most one claim gives (at least that many claims), or the chain's own window.
    const pace = own
      ? sr.claimsPerDay !== null
        ? { perDay: sr.claimsPerDay, atLeast: false, says: `its server signs ${sr.says}` }
        : { perDay: sr.one / each, atLeast: true, says: `its server signs ${sr.says}` }
      : l.perWalletEach?.count
        ? {
            perDay: (l.perWalletEach.count * 86_400) / Math.max(toSeconds(l.perWalletEach.every ?? '1d'), 1),
            atLeast: false,
            says: `the chain allows ${l.perWalletEach.count} a wallet every ${l.perWalletEach.every ?? '1d'}`,
          }
        : null;
    // The server counts an amount and the chain counts claims: how many claims an honest player makes is the question.
    if (own && sr.claimsPerDay === null && counts.length)
      warn(
        'W-ASSUMPTION',
        `economy.grants.${g.key}.serverLimit`,
        `${named(g)}'s server limits what it signs in ${unit} (${sr.says}), and the chain's caps count claims (${words(counts)}): how many claims an honest player makes is unknown, so each cap below is reached at least as soon as said, and a server that counts only ${unit} can sign a claim the chain then refuses, after it has counted it.`,
        'Ask, then declare it ("serverLimit": { …, "claims": n }), and have the server refuse a claim before it signs whatever the chain would refuse.',
        {
          severity: l.perWalletEach?.count || l.perDay ? 'medium' : 'low',
          ask: `${named(g)}'s server counts ${unit}, while the chain counts claims (${words(counts)}): how many times a day does a regular player claim it, at most?`,
        },
      );
    if (!pace) continue;
    // A server that signs more claims in a window than the chain takes: the extra are signed, counted and refused.
    if (own && l.perWalletEach?.count) {
      const chainDay = (l.perWalletEach.count * 86_400) / Math.max(toSeconds(l.perWalletEach.every ?? '1d'), 1);
      if (pace.perDay > chainDay)
        warn(
          'W-ASSUMPTION',
          `economy.grants.${g.key}.limits.perWalletEach`,
          `${named(g)}'s server signs ${pace.atLeast ? 'at least ' : ''}about ${+pace.perDay.toFixed(2)} claims a day for an honest player (${sr.says}), and the chain takes ${l.perWalletEach.count} a wallet every ${l.perWalletEach.every ?? '1d'}: past that, the server signs and counts a claim the chain refuses, and the player gets nothing for it until the window turns.`,
          `Have the server refuse first: its claims a window at or under the chain's (${l.perWalletEach.count} every ${l.perWalletEach.every ?? '1d'}), or raise the chain's cap to what the server allows.`,
          {
            severity: 'medium',
            ask: `A regular player can earn about ${Math.ceil(pace.perDay)} claims a day of ${named(g)}, and the chain takes ${l.perWalletEach.count} every ${l.perWalletEach.every ?? '1d'}: should the server stop at ${l.perWalletEach.count}, or should the chain take more?`,
          },
        );
    }
    const who = l.perPerson ? 'person' : 'wallet';
    const mine = l.perPerson ?? l.perWallet;
    const until = l.until !== undefined ? toTime(l.until, now) : null;
    const life = until !== null ? Math.max((until - now) / 86_400, 0) : null;
    const reach = mine ? mine / pace.perDay : null;
    if (reach !== null && (life === null || reach < life)) {
      const soon = reach < horizon;
      warn(
        'W-ASSUMPTION',
        `economy.grants.${g.key}.limits.${l.perPerson ? 'perPerson' : 'perWallet'}`,
        `${named(g)} gives each ${who} ${mine} claims in all${life === null ? ', and it has no end ("until")' : ''}, and ${pace.says} (${pace.atLeast ? 'at least ' : ''}about ${+pace.perDay.toFixed(2)} claims a day): an honest player reaches the cap ${pace.atLeast ? 'within' : 'in'} about ${about(reach)}, and every claim after that is refused for good. What the game keeps counting toward it after that can never be claimed. A cap “in all” counts claims, not ${unit}, for a player's whole time in the game.`,
        `If it is a day's limit, write it as one ("perWalletEach": { "count": ${mine}, "every": "1d" }, or the server's "serverLimit"); if it is meant for good, tell players when they reach it and stop counting what can't be paid.`,
        {
          severity: soon ? 'medium' : 'low',
          ask: `${named(g)} lets each ${who} claim ${mine} times in all (claims, not ${unit}), and ${pace.says}: a regular player is done ${pace.atLeast ? 'within' : 'in'} about ${about(reach)}. Is ${mine} meant for good, or for a day?`,
        },
      );
    }
    if (!players) continue;
    // Everyone at full pace: a day's claims (each stopping at their own cap), and how fast they come.
    const fast = players * pace.perDay;
    const day = players * (mine ? Math.min(pace.perDay, mine) : pace.perDay);
    if (l.perDay && l.perDay < day)
      warn(
        'W-ASSUMPTION',
        `economy.grants.${g.key}.limits.perDay`,
        `${named(g)}'s ${l.perDay} claims a day for everyone together: the scenario's ${players} players at that pace would make about ${Math.round(day)} a day, so the day's cap is used up about ${about(l.perDay / fast)} into each day, and later claims wait for the next.`,
        'Raise "perDay" to the audience you expect, or tell players the day’s claims are first come, first served.',
        {
          severity: 'medium',
          ask: `${players} players claiming ${named(g)} as often as the game lets them make about ${Math.round(day)} claims a day, and the chain takes ${l.perDay} a day for everyone: the day's claims are gone about ${about(l.perDay / fast)} in, and the rest wait for tomorrow. Is that what you want, or should the day's cap be about ${Math.round(day)}?`,
        },
      );
    // (with a cap of their own, the count against the audience is the check above)
    if (l.total && !mine && l.total / fast < (life ?? horizon))
      warn(
        'W-ASSUMPTION',
        `economy.grants.${g.key}.limits.total`,
        `${named(g)}'s ${l.total} claims in all: the scenario's ${players} players at that pace make about ${Math.round(fast)} a day, so it runs out in about ${about(l.total / fast)}, and every claim after that is refused.`,
        'Raise "total" to what you would pay out over the time it should run, or tell players it ends when it runs out.',
        { severity: 'medium' },
      );
  }

  // At a grant's edges (a day that turns, a cap, an empty pool, a voucher that runs out) the chain keeps only a claim a
  // window refused (the route's endings); what a player earned in the game and has not claimed is the server's record
  // alone. One question for every grant a server signs for.
  const signedGrants = m.grants.filter(g => on(g) && (g.vouchers ?? []).length);
  if (signedGrants.length)
    warn(
      'W-ASSUMPTION',
      `economy.grants.${signedGrants[0].key}`,
      `What a player has earned in the game and not yet claimed (${words(signedGrants.map(named))}) is on no chain: the server alone keeps it or drops it when a day's limit turns, a cap is reached, a pool is empty or a voucher runs out.`,
      'Ask, then build that and say it on the page where the player earns: what carries over, what is lost and when.',
      {
        severity: 'low',
        ask: `When a day turns, a cap is reached or a voucher runs out, what happens to what a player earned from ${words(signedGrants.map(named))} and did not claim in time: is it kept for them (until when), or lost? Players are told either way.`,
      },
    );
  // A cap is the person's number as the scenario is: every cap of a signed grant that no question above was about, in
  // claims and in what they give, once.
  const unasked = signedGrants
    .map(g => {
      const l = g.limits ?? {};
      const line = prizeLine(g.prize ?? g.gives);
      const each = num(line?.amount);
      const unit =
        line?.gives === 'tokens' ? (prizeToken(line, m)?.symbol ?? sym(line.currency ?? m.currencyKey)) : null;
      const worth = n => (unit && each ? ` (up to ${+(n * each).toFixed(9)} ${unit})` : '');
      const caps = [
        [
          'perWalletEach',
          l.perWalletEach?.count &&
            `${l.perWalletEach.count} a wallet every ${l.perWalletEach.every ?? '1d'}${worth(l.perWalletEach.count)}`,
        ],
        ['perWallet', l.perWallet && `${l.perWallet} a wallet in all${worth(l.perWallet)}`],
        ['perPerson', l.perPerson && `${l.perPerson} a person in all${worth(l.perPerson)}`],
        ['perDay', l.perDay && `${l.perDay} a day for everyone${worth(l.perDay)}`],
        ['total', l.total && `${l.total} in all${worth(l.total)}`],
      ].filter(([cap, says]) => says && !askedCaps.has(`${g.key}.${cap}`));
      return caps.length ? `${named(g)}: ${caps.map(([, says]) => says).join(', ')}` : null;
    })
    .filter(Boolean);
  if (unasked.length)
    warn(
      'W-ASSUMPTION',
      `economy.grants.${signedGrants[0].key}.limits`,
      `The chain's caps on what a server signs, in claims: ${unasked.join('; ')}. They are where an honest player stops and the most a leaked voucher key takes, and the spec can't say who chose them.`,
      'Ask, and keep the caps the person gives; a cap picked for them is said as a pick, with what it means in their numbers.',
      {
        severity: 'low',
        ask: `These caps decide where an honest player stops and the most a leaked voucher key could take. ${unasked.join('; ')}. Are these the numbers you want?`,
      },
    );

  // One question for each kind of step only a person or a server sends, naming every route that needs it.
  const manual = new Map();
  for (const route of routes)
    for (const st of route.states)
      for (const step of st.steps.filter(x => x.manual))
        manual.set(step.manual, [...(manual.get(step.manual) ?? []), { route, step }]);
  for (const [kind, list] of manual) {
    const names = words([...new Set(list.map(x => named(x.route)))]);
    const { step } = list[0];
    warn(
      'W-ASSUMPTION',
      list[0].route.where,
      `${names} need${list.length === 1 ? 's' : ''} a person or a server: ${step.says} (if nobody does: ${step.ifNobody}). Ask who, and when they are available, before placing it.`,
      'Ask, then say it on the page; for a step a key sends, give that key only the powers it needs (a voucher key, a decider key), never the owner’s.',
      {
        severity: 'low',
        ask: {
          deliver: `The chain knows only the winning wallet: who delivers the off-chain prize of ${names} to each winner, and how will they reach them?`,
          server: `Who runs the results server that signs the vouchers of ${names}: the game’s own server, or one someone else keeps for you? It has to be up for the whole run (${step.ifNobody}).`,
          decide: `Who holds the decider key of ${names}, what does it check before it signs, and will they be there before the result is due?`,
          'decide-authority': `Who names the result of ${names} with the authority key, and will they be there before the result is due?`,
        }[kind],
      },
    );
  }
  for (const l of m.lotteries.filter(l => l.firstDraw && !toSeconds(l.every)))
    warn(
      'W-ASSUMPTION',
      `economy.lotteries.${l.key}.firstDraw`,
      `${named(l)} draws at ${at(toTime(l.firstDraw, now))}, but only when someone asks for it: a player's button on the page (it waits for a visitor) or a key on a server (on time; a key that can be stolen, its fees the owner's).`,
      'Ask the person which, and build that (skill rule 11).',
      {
        severity: 'low',
        ask: `Who asks for ${named(l)}'s draw at its time: a button players press, or a key on a server?`,
      },
    );
  for (const sc of m.schedules.filter(sc => !sc.sealed))
    warn(
      'W-ASSUMPTION',
      `economy.schedules.${sc.key}`,
      `${named(sc)} runs only when the project's keys send each run, and a missed run lapses.`,
      'Ask who sends it and when they are available; or make it "sealed" so its recipient runs it.',
      { severity: 'low', ask: `Who sends each run of ${named(sc)} on time, and what if they are away?` },
    );
  // Scarce supply: an item of fixed supply sold first come, first served, against how many want one.
  for (const it of m.items.filter(it => num(it.supply) > 0)) {
    const sold = m.shop.find(b => b.shopOf === it.key && num(b.price) > 0 && b.active !== false);
    if (!sold) continue;
    const supply = num(it.supply);
    const per = num(it.perWallet) || null;
    const said = m.scenario.perDay?.[`item:${it.key}`];
    const days = num(m.scenario.days) || 30;
    const players = num(m.scenario.players);
    const demand = said !== undefined ? num(said) * days : players ? players * (per ?? 1) : null;
    const resold = !it.soulbound;
    if (demand === null)
      warn(
        'W-ASSUMPTION',
        `economy.items.${it.key}.supply`,
        `Unknown: ${named(it)} sells ${supply} first come, first served${per ? `, ${per} a wallet` : ''}, and the scenario says nothing of how many want one${resold ? '. It can be resold, so a bot or a reseller with many wallets has every reason to buy first' : ''}.`,
        'Ask, then write it in the scenario ("scenario.players", or "perDay": {"item:<key>": n}).',
        { severity: 'medium', ask: `How many people will want one of the ${supply} ${named(it)}?` },
      );
    else if (demand > supply)
      warn(
        'W-ASSUMPTION',
        `economy.items.${it.key}.supply`,
        `${named(it)} sells ${supply} first come, first served${per ? `, ${per} a wallet` : ''}, and the scenario has about ${Math.round(demand)} wanting one: it sells out to whoever is fastest${resold ? ', a bot or a reseller with many wallets first, who can sell them on' : ''}.`,
        'To share it fairly, count people, not wallets: one a person through vouchers naming an X account ("perPerson": 1), or draw the buyers (a lottery or raffle of the items).',
        { severity: resold && demand > 2 * supply ? 'high' : 'medium' },
      );
  }
  for (const it of m.items.filter(it => it.kind === 'collectible' && !it.uri))
    warn(
      'W-ASSUMPTION',
      `economy.items.${it.key}.uri`,
      `${named(it)} has no picture link ("uri"): each one is minted with the link it has then, and keeps it.`,
      'Give it its link (a JSON file with "name" and "image") before the first one is minted.',
      { severity: 'medium' },
    );
  return fl;
}

/** The quick simulation at the spec's scenario, or null when it can't run. */
function simulateOrNull(economy, now) {
  try {
    return economy ? simulate(economy, { now }) : null;
  } catch {
    return null;
  }
}
