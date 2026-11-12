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
import { at, flows, lineToken, named, num, words } from './flows.mjs';
import { prizeLine, toSeconds, toTime } from './model.mjs';
import { simulate } from './simulate.mjs';

/** A cancel's severity, by how likely it is: the scenario says it is (or says nothing), says it isn't, or only the oracle's timeout. */
const BY_LIKELY = { likely: 'high', unknown: 'high', unlikely: 'medium', rare: 'low' };

/**
 * Runs the analyses. `warn(code, where, message, fix, extra)` as check() calls it, `extra` { severity, ask }; `now`
 * in seconds; `economy`, the spec, for the quick simulation's burns. Returns the model, for the caller to show.
 */
export function challenge(m, warn, now, economy) {
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
        `Hold the payment until the outcome is final, then burn or route it at settlement: price ${named(route)} in ${sym(origin.pays[0].asset)} itself ("currency": "${origin.pays[0].asset}", "price": ${origin.pays[0].amount / origin.makes}${route.kind === 'lottery' ? ', with "rest": "burn" to burn it once the round is drawn' : ''}), so a cancel refunds what was paid and nothing is burned before the outcome. Otherwise, keep a recipe that turns ${a.symbol} back switched off ("active": false) and switch it on after a cancel.`,
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
  let sim = null;
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
    const daily = grants.filter(g => num(g.limits?.perDay));
    const totalOnly = grants.filter(g => !num(g.limits?.perDay) && num(g.limits?.total));
    const uncapped = grants.filter(g => !num(g.limits?.perDay) && !num(g.limits?.total));
    const capped = daily.reduce((n, g) => n + amountOf(g) * num(g.limits.perDay), 0);
    const farmed = farms.reduce((n, f) => n + num(sim?.farms?.find(x => x.key === f.key)?.rewardsPerDay), 0);
    const burned = num(sim?.perDay?.burned?.[key]);
    if (!uncapped.length && !totalOnly.length && capped + farmed <= burned) continue;
    if (!uncapped.length && capped + farmed <= burned) continue;
    warn(
      'W-VALUE',
      `economy.tokens.${key}`,
      `Following ${sym(key)}, net flow: ${[
        capped ? `grants mint up to ${+capped.toFixed(9)} a day at their caps (${words(daily.map(named))})` : '',
        farmed
          ? `${words(farms.map(named))} mint${farms.length === 1 ? 's' : ''} about ${+farmed.toFixed(9)} a day as rewards at the scenario's stake`
          : '',
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
        )}, and the scenario burns ${+burned.toFixed(9)} a day. What is minted and not burned stays in players' hands: each ${sym(key)} buys less as they pile up.`,
      'Cap every free mint a day ("limits.perDay") at or below what is burned, burn more (a share of each sale, a recipe that burns), or fix the supply (mint it once into a pool and pay from there).',
      { severity: uncapped.length ? 'high' : 'medium' },
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
        const count = num(g.limits?.total);
        warn(
          'W-VALUE',
          `economy.grants.${g.key}`,
          `Following ${sym(f.rewardsToken)}, given away: ${named(g)} gives ${named(m.item.get(f.item))}, which earns ${per} ${sym(f.rewardsToken)} a day in ${named(f)}: ${count ? `its ${count} claims print up to ${+(count * per * days).toFixed(6)} ${sym(f.rewardsToken)} over ${+days.toFixed(2)} days${reward !== undefined && f.rewardsToken !== m.currencyKey ? `, worth ${+(count * per * days * reward).toFixed(6)} ${money}` : ''}` : 'it has no total, so what it prints has no cap'}.`,
          'Cap the grant ("limits.total") at what you would pay out, or give an item the farm doesn’t take.',
          { severity: count ? 'medium' : 'high' },
        );
      }
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
        ask:
          kind === 'deliver'
            ? `Who delivers the off-chain prize of ${names} to each winner, and how will they reach them? The chain knows only the winning wallet.`
            : `Who runs the results server that signs the vouchers of ${names}, and is it up for the whole run?`,
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
