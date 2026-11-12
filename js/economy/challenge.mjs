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
import { prizeLine, toSeconds, toTime } from './model.mjs';
import { simulate } from './simulate.mjs';
import { exchanges, payouts } from './exchanges.mjs';
import { journeyOf } from './walk.mjs';

/** A cancel's severity, by how likely it is: the scenario says it is (or says nothing), says it isn't, or only the oracle's timeout. */
const BY_LIKELY = { likely: 'high', unknown: 'high', unlikely: 'medium', rare: 'low' };

/**
 * Runs the analyses. `warn(code, where, message, fix, extra)` as check() calls it, `extra` { severity, ask }; `now`
 * in seconds; `economy`, the spec, for the quick simulation's burns. Returns the model, for the caller to show.
 */
export function challenge(m, warn, now, economy) {
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
        `The pick, which keeps every goal (the payment still ${origin.pays.every(x => x.to === 'burn') ? 'burned' : 'goes where it goes'}, one approval, no swap, nothing for the owner to do after a cancel): hold the payment until the outcome is final and settle it then. Price ${named(route)} in ${sym(origin.pays[0].asset)} itself ("currency": "${origin.pays[0].asset}", "price": ${origin.pays[0].amount / origin.makes}${route.kind === 'lottery' ? ', with "rest": "burn" to burn it once the round is drawn' : ''}), so a cancel refunds what was paid. A free entry stays free with a ticket of its own (a separate lottery, or an NFT ticket), still moving no ${sym(origin.pays[0].asset)}. The other fix gives up something: a recipe that turns ${a.symbol} back, switched off and switched on after a cancel, needs the owner after every cancel and is a swap players can use while it is on.`,
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
          `Following ${a.symbol}, from nothing: ${named(g)} gives ${amount} for free, ${named(origin.recipe)} sells it for ${priced(origin.pays)}, and ${named(b.recipe)} turns it back into ${priced(b.gives)}${on(b.recipe) ? '' : ' once it is switched on'}: each claim is worth ${priced(worth)}, held back only by the grant’s limits.${serverHeld(g) ? SERVER_NOTE : ''}`,
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
  // step: past two, say each step and what folds them together.
  for (const route of routes.filter(r => r.price.length && r.kind !== 'recipe' && r.kind !== 'item')) {
    const j = journeyOf(route, fl);
    if (j.prompts <= 2) continue;
    warn(
      'W-STEPS',
      route.where,
      `A player's loop through ${named(route)} takes ${j.prompts} wallet prompts: ${j.steps.join(', then ')}.`,
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
    const daily = grants.filter(g => num(g.limits?.perDay));
    const totalOnly = grants.filter(g => !num(g.limits?.perDay) && num(g.limits?.total));
    const uncapped = grants.filter(g => !num(g.limits?.perDay) && !num(g.limits?.total));
    const capped = daily.reduce((n, g) => n + amountOf(g) * num(g.limits.perDay), 0);
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
    if (!uncapped.length && !totalOnly.length && capped + farmed <= burned) continue;
    if (!uncapped.length && capped + farmed <= burned) continue;
    warn(
      'W-VALUE',
      `economy.tokens.${key}`,
      `Following ${sym(key)}, net flow: ${[
        capped ? `grants mint up to ${+capped.toFixed(9)} a day at their caps (${words(daily.map(named))})` : '',
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
        ask: `When can someone first learn the outcome of ${named(route)}? Entries must close before that.`,
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
    if (pct < 10) continue;
    warn(
      'W-ASSUMPTION',
      `economy.tokens.${key}.supply`,
      `The largest holder takes part: ${said ? '' : 'after setup '}${who} holds ${+held.toFixed(6)} ${sym(key)}, ${+pct.toFixed(1)}% of its supply of ${supply}. Staked or spent where holding more takes more, it takes ${words([...shares, ...chances.map(x => `${named(x)}: as many tickets or as much of a side as it likes`)])}.`,
      `Say whether ${who === 'the largest holder' ? 'the largest holder' : 'the owner'} takes part; if not, keep those ${sym(key)} out (seed them into a pool, a vesting schedule, or burn them), or rate the farm per seat instead of shared by stake.`,
      {
        severity: pct > 50 ? 'high' : 'medium',
        ask: `Will ${who === 'the largest holder' ? 'the largest holder' : 'the owner'}'s ${+held.toFixed(6)} ${sym(key)} (${+pct.toFixed(1)}% of the supply) be staked or played?`,
      },
    );
  }

  // A result or reward decided off chain (a voucher server, a decider) may give more than the spec shows: a boost, a
  // ranking that pays. Declared in "offchain", it is followed like any route; undeclared, ask.
  const offChain = [...m.grants.filter(g => (g.vouchers ?? []).length), ...m.contests];
  if (offChain.length && !(m.offchain ?? []).length)
    warn(
      'W-ASSUMPTION',
      'economy.offchain',
      `${words(offChain.map(named))} ${offChain.length === 1 ? 'is' : 'are'} decided off chain, and the spec declares nothing a server or the page does with what players hold or win ("offchain"). A boost, a ranking or a better reward the server grants for it is invisible to these checks, so a loop through it is not followed.`,
      'Ask, then declare each in "offchain" ({ "key", "takes", "gives", "rate" }) and check again.',
      {
        severity: 'low',
        ask: 'Does your server or page turn anything players hold or win into an advantage (a boost, a better reward, a ranking that pays)?',
      },
    );

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
        ask: {
          deliver: `Who delivers the off-chain prize of ${names} to each winner, and how will they reach them? The chain knows only the winning wallet.`,
          server: `Who runs the results server that signs the vouchers of ${names}, and is it up for the whole run?`,
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
