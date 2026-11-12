// The analyses that challenge a spec, computed over its model (flows.mjs), each a warning code with the situation in
// its message and a severity that follows how likely the state is: the program takes all of it as written, and the
// person decides.
//
// - W-VALUE, follow the value: what a player holds in each end state of each route against what they put in (a refund
//   in another asset than the one paid), value that converts back at any time, appears from nothing, grows around a
//   loop of recipes, or keeps being made after its last use.
// - W-STEPS, one intent, one step: an intent that takes more transactions (wallet prompts) than it needs.
// - W-ASSUMPTION, check every assumption: a number that depends on how many take part (a lottery's least sale, a
//   contest's least pot) against the scenario. A number the scenario doesn't state is unknown: the finding is the
//   question to ask the person, never an estimate from a default.
//
// Who sends each later step and what happens if nobody does, and where each rule is kept (chain, server or page), are
// in the walk-through (walk.mjs, from the same model) and the review's trust levels.
import { at, flows, named, num, words } from './flows.mjs';
import { toTime } from './model.mjs';

/** A cancel's severity, by how likely it is: the scenario says it is (or says nothing), says it isn't, or only the oracle's timeout. */
const BY_LIKELY = { likely: 'high', unknown: 'high', unlikely: 'medium', rare: 'low' };

/**
 * Runs the analyses. `warn(code, where, message, fix, extra)` as check() calls it, `extra` { severity, ask }; `now`
 * in seconds. Returns the model, for the caller to show.
 */
export function challenge(m, warn, now) {
  const fl = flows(m, { now });
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
        `Price the route in ${sym(origin.pays[0].asset)} itself ("currency": "${origin.pays[0].asset}", "price": ${origin.pays[0].amount / origin.makes}${route.kind === 'lottery' ? ', "rest": "burn" if the tickets should burn' : ''}), so a refund pays back what was paid; or keep a recipe that turns ${a.symbol} back switched off ("active": false), switched on after a cancel.`,
        { severity: BY_LIKELY[c.likely] },
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
          `Following ${a.symbol}, from nothing: ${named(g)} gives ${amount} for free, ${named(origin.recipe)} sells it for ${priced(origin.pays)}, and ${named(b.recipe)} turns it back into ${priced(b.gives)}${on(b.recipe) ? '' : ' once it is switched on'}: each claim is worth ${priced(worth)}, held back only by the grant’s limits.`,
          'Give the free one an asset of its own that turns into nothing, keep every way back switched off, or set the grant’s "limits" to what you would pay out.',
          { severity: on(b.recipe) ? 'high' : 'medium' },
        );
      }
    // After the end: still made once the last route it was good for has ended, and nothing else takes it.
    const live = a.uses.filter(on);
    const ends = live.map(r => r.ends ?? null);
    if (live.length && ends.every(e => e !== null)) {
      const last = Math.max(...ends);
      const lastUse = live.find(r => r.ends === last);
      const after = `Following ${a.symbol}, after the end: it has no use after ${named(lastUse)} (${at(last)})`;
      for (const g of a.free.filter(on))
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

  // A loop of recipes that ends with more than it started: each recipe of one token in and tokens out is an exchange at
  // a rate; a cycle whose rates multiply above 1 makes value from nothing, as fast as a player repeats it.
  const rates = m.recipes.flatMap(r => {
    const pays = (r.in ?? []).filter(l => l.takes === 'pay');
    if (pays.length !== 1 || (r.in ?? []).length !== 1 || !on(r)) return [];
    const from = pays[0].currency ?? m.currencyKey;
    return routes
      .find(x => x.kind === 'recipe' && x.key === r.key)
      .gives.filter(g => g.asset !== from)
      .map(g => ({ recipe: r, from, to: g.asset, rate: g.amount / num(pays[0].amount) }));
  });
  const seen = new Set();
  const walkLoop = (start, at, path, rate) => {
    for (const e of rates.filter(x => x.from === at)) {
      if (path.includes(e)) continue;
      const next = [...path, e];
      if (e.to === start) {
        const key = next
          .map(x => x.recipe.key)
          .sort()
          .join('|');
        if (rate * e.rate > 1 + 1e-9 && !seen.has(key)) {
          seen.add(key);
          warn(
            'W-VALUE',
            `economy.recipes.${next[0].recipe.key}`,
            `Following ${sym(start)}, around a loop: ${next.map(x => `${named(x.recipe)} turns ${sym(x.from)} into ${sym(x.to)} at ${+x.rate.toFixed(9)} each`).join(', then ')}: one turn gives back ${+(rate * e.rate).toFixed(9)} for each 1 put in, as often as a player repeats it.`,
            'Make the rates meet at 1 or less around the loop, or switch one of the recipes off.',
            { severity: 'high' },
          );
        }
      } else if (next.length < 4) walkLoop(start, e.to, next, rate * e.rate);
    }
  };
  for (const key of new Set(rates.map(x => x.from))) walkLoop(key, key, [], 1);

  // ---- W-STEPS: an intent whose price the player must craft first takes two transactions, two wallet prompts.
  for (const route of routes) {
    const craft = route.states.flatMap(s => s.steps).find(s => s.craft)?.craft;
    if (!craft || route.kind === 'recipe') continue;
    const asset = route.price[0]?.asset;
    const origin = assets.get(asset)?.origins.find(o => o.recipe === craft);
    const per = num(route.price[0]?.amount) / num(origin?.makes || 1);
    const rolls = (craft.out ?? []).some(o => o.gives === 'roll');
    warn(
      'W-STEPS',
      route.kind === 'lottery' ? route.where : route.where,
      `Buying from ${named(route)} takes a craft of ${named(craft)}, then the purchase: two transactions, two wallet prompts, since it costs ${sym(asset)}.`,
      route.kind === 'lottery' && !rolls
        ? `Send both in one: the play client's buyTickets("${route.key}", count, { listing, make: { recipe: "${craft.key}", times: ${per === 1 ? 'count' : `count × ${+per.toFixed(9)}`}, listing } }) crafts and buys with one approval (kit 0.28.7 and later).`
        : `Price it in what ${named(craft)} takes (${priced(origin?.pays ?? [])} for each ${origin?.makes} ${sym(asset)}), unless holding ${sym(asset)} is the point.`,
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
          ask: `How many players will ${named(route)} have, and how many tickets will each buy before its draw? It needs ${c.minSold}.`,
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
        ask: `How many will enter ${named(ct)}, and with how much? It needs ${ct.minPot} in its sides.`,
      },
    );
  }
  return fl;
}
