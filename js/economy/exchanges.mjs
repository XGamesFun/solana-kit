// Every route of the model as an exchange from what it takes to what it gives, at its expected rate, so value can be
// followed across routes: a recipe at its lines' amounts, a box at its outcomes' odds, a farm at what one unit staked
// earns over its life (its ceiling; boosts at their best). And what each feature pays one player a day, in the
// project's currency at the spec's own rates. Pure.
import { farmCeiling, prizeLine, toSeconds } from './model.mjs';
import { lineToken, named, num } from './flows.mjs';

const DAY = 86_400;

/** A per-wallet limit in words, or null. */
function capOf(part) {
  const each = part?.perWalletEach;
  if (each) return `${each.count} a wallet every ${each.every ?? 'window'}`;
  if (part?.perWallet) return `${part.perWallet} a wallet`;
  return null;
}

/** What one open of box `b` gives, on average: [{ asset, amount }] (an item as "item:<key>"). */
function boxGives(b, m) {
  const outcomes = b.outcomes ?? [];
  const weightOf = o => num(o.chance ?? o.weight ?? 1);
  const all = outcomes.reduce((n, o) => n + weightOf(o), 0) || 1;
  const out = new Map();
  const add = (asset, amount) => asset && out.set(asset, (out.get(asset) ?? 0) + amount);
  for (const o of outcomes) {
    const p = weightOf(o) / all;
    if (o.gives === 'item') add(`item:${o.item}`, p * num(o.count ?? 1));
    else if (o.gives === 'pay') add(m.poolToken(o.pool)?.key, p * num(o.amount));
    else if (o.gives === 'tokens') add(lineToken(o, m), p * num(o.amount));
  }
  return [...out].map(([asset, amount]) => ({ asset, amount }));
}

/** What one unit staked in farm `f` earns over its life at its best boost, and the life in days. */
function farmYield(f, sim) {
  const ceiling = farmCeiling(f);
  if (!ceiling || f.rate?.shared) return null;
  const days = ceiling.days ?? (num(sim?.scenario?.days) || 30);
  const total = ceiling.total ?? ceiling.perDay * days;
  const best = Math.max(0, ...(f.boosts ?? []).map(x => num(x.add?.addPercent)));
  return { total: total * (1 + best / 100), days, boosted: best > 0 };
}

/**
 * The exchanges: [{ from, to, rate, route, where, says, cap }]: `rate` units of `to` for each unit of `from`; an item
 * as "item:<key>".
 */
export function exchanges(m, fl, sim) {
  const edges = [];
  const on = x => x?.active !== false;
  for (const r of m.recipes.filter(on)) {
    const lines = r.in ?? [];
    if (lines.length !== 1) continue;
    const l = lines[0];
    const from =
      l.takes === 'pay' ? (l.currency ?? m.currencyKey) : l.takes === 'burn' && l.item ? `item:${l.item}` : null;
    const amount = l.takes === 'pay' ? num(l.amount) : num(l.count ?? 1);
    if (!from || !(amount > 0)) continue;
    for (const o of r.out ?? []) {
      const to = o.gives === 'item' ? `item:${o.item}` : lineToken(o, m);
      const got = o.gives === 'item' ? num(o.count ?? 1) : num(o.amount);
      if (to && to !== from && got > 0)
        edges.push({
          from,
          to,
          rate: got / amount,
          route: `recipe:${r.key}`,
          where: `economy.recipes.${r.key}`,
          says: `crafting ${named(r)}`,
          cap: capOf(r),
        });
    }
  }
  for (const b of m.allBoxes.filter(on)) {
    const price = num(b.price);
    if (!(price > 0)) continue;
    const from = b.currency ?? m.currencyKey;
    const item = b.shopOf ? m.item.get(b.shopOf) : null;
    for (const g of boxGives(b, m))
      if (g.asset !== from && g.amount > 0)
        edges.push({
          from,
          to: g.asset,
          rate: g.amount / price,
          route: `box:${b.key}`,
          where: item ? `economy.items.${item.key}` : `economy.boxes.${b.key}`,
          says: `buying ${named(item ?? b)}`,
          cap: capOf(item ?? b),
        });
  }
  for (const f of m.farms) {
    const y = farmYield(f, sim);
    const from = f.stakes === 'collectibles' ? (f.item ? `item:${f.item}` : null) : f.stakes;
    if (!y || !from || from === f.rewardsToken || !(y.total > 0)) continue;
    edges.push({
      from,
      to: f.rewardsToken,
      rate: y.total,
      route: `farm:${f.key}`,
      where: `economy.farms.${f.key}`,
      says: `staking in ${named(f)} for ${+y.days.toFixed(2)} days${y.boosted ? ' at its best boost' : ''}`,
      cap: null,
    });
  }
  return edges;
}

/**
 * What each feature pays one player a day, in the project's currency at the spec's own rates, most first: [{ name,
 * where, perDay, how, free }]. A grant or a free box by its per-identity limit; a farm for one unit staked.
 */
export function payouts(m, fl, sim) {
  const worth = asset => fl.worth.get(asset);
  const on = x => x?.active !== false;
  const days = num(sim?.scenario?.days) || 30;
  const value = list =>
    list.every(x => worth(x.asset) !== undefined) ? list.reduce((n, x) => n + worth(x.asset) * x.amount, 0) : null;
  /** Uses a day one identity may take: a window's count, or a total spread over the scenario's days. */
  const daily = part => {
    const each = part?.perWalletEach;
    if (each)
      return {
        n: num(each.count) / Math.max(toSeconds(each.every ?? '1d') / DAY, 1 / 24),
        how: `${each.count} every ${each.every ?? '1d'}`,
      };
    const total = num(part?.perPerson ?? part?.perWallet);
    if (total) return { n: total / days, how: `${total} over ${days} days` };
    return null;
  };
  const rows = [];
  for (const g of m.grants.filter(on)) {
    const prize = prizeLine(g.prize ?? g.gives);
    const asset = prize?.gives === 'item' ? `item:${prize.item}` : lineToken(prize, m);
    const each = asset ? value([{ asset, amount: prize.gives === 'item' ? 1 : num(prize.amount) }]) : null;
    const d = daily(g.limits);
    if (each === null || !d) continue;
    rows.push({
      name: g.name ?? g.key,
      where: `economy.grants.${g.key}`,
      perDay: each * d.n,
      how: `${+each.toPrecision(4)} a claim, ${d.how}`,
      free: true,
    });
  }
  for (const b of m.allBoxes.filter(on)) {
    const item = b.shopOf ? m.item.get(b.shopOf) : null;
    const part = item ?? b;
    const price = num(b.price);
    const back = value(boxGives(b, m));
    const d = daily(part);
    if (back === null || !d) continue;
    const net = back - price * (worth(b.currency ?? m.currencyKey) ?? 1);
    rows.push({
      name: part.name ?? part.key,
      where: item ? `economy.items.${item.key}` : `economy.boxes.${b.key}`,
      perDay: net * d.n,
      how: `${price > 0 ? `${+net.toPrecision(4)} net an open` : `${+back.toPrecision(4)} an open, free`}, ${d.how}`,
      free: !(price > 0),
    });
  }
  for (const f of m.farms) {
    const row = sim?.farms?.find(x => x.key === f.key);
    const r = worth(f.rewardsToken);
    if (row?.perUnitPerDay === undefined || r === undefined) continue;
    rows.push({
      name: f.name ?? f.key,
      where: `economy.farms.${f.key}`,
      perDay: num(row.perUnitPerDay) * r,
      how: `for each ${row.unit ?? 'unit'} staked`,
      free: false,
    });
  }
  return rows.sort((a, b) => b.perDay - a.perDay);
}
