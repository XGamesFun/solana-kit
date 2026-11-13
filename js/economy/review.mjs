// The review: an economy read the way a cheater reads it, not a validity check (that is check.mjs). For every route
// that pays or gives something of value it says who can trigger it, what the program enforces, what it trusts off the
// chain, the declared trust level of a signed result, the most one cheater gets, and what the prize goes on to earn.
// Then findings, each with a stable id, a severity, its route, what it means and the fix, and the trade-off between a
// server that decides, replays or bounds a result, in words an agent can show the person. Pure.
//
// The program enforces its own rules: a voucher names its wallet, grant and incarnation; a round pays a wallet once;
// limits, gates, seats and custody are the program's. What is left to get wrong is what a voucher signer decides
// (what it checks, which person it names, the limits it is given) and the economy's own design (emission without an
// end, prizes worth farming). The findings are about those.
import { check } from './check.mjs';
import { gateWords, ruleWords } from './explain.mjs';
import {
  boxRolls,
  farmCeiling,
  destination,
  listOf,
  model,
  outcomeParts,
  poolFillers,
  prizeLine,
  prizePool,
  prizeToken,
  prizeWords,
  toSeconds,
} from './model.mjs';
import { TRUST_LEVELS, TRUST_WORDS } from './trust.mjs';
import { walkThrough } from './walk.mjs';

/** Severities, most serious first. */
export const SEVERITIES = Object.freeze(['high', 'medium', 'low', 'info']);
export { TRUST_LEVELS, TRUST_WORDS };

const label = part => `“${part?.name ?? part?.key}”`;
const fmt = x =>
  Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(x);
const short = a => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;
const days = d => toSeconds(d) / 86_400;

/** Which money a pool filler is: what players pay (not the owner's seed or a timer's mint). */
const PLAYER_MONEY = /^(payment|box|item|lottery|contest|recipe|auction):/;

/**
 * The review of an economy: { ok, routes, findings, tradeoffs }. `ok` is false when there is a high finding, or when
 * the spec does not check (then `refusals` says why, and the rest is empty).
 */
export function review(economy, { now = Math.floor(Date.now() / 1000) } = {}) {
  const verdict = check(economy, { now });
  if (!verdict.ok) return { ok: false, refusals: verdict.refusals, routes: [], findings: [], tradeoffs: '' };
  const m = model(economy, { now });
  const warnings = verdict.warnings;
  const warned = (code, where) => warnings.filter(w => w.code === code && (!where || w.where.startsWith(where)));
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const routes = [];
  const findings = [];
  const find = (id, severity, route, message, fix) =>
    findings.push({ id, severity, route, message, ...(fix ? { fix } : {}) });

  // ---------------------------------------------------------------- what a prize goes on to earn or buy

  /** Whether farm `f` takes collectible `key`: its gate's rules, as far as the spec says (an attribute test may not pass). */
  const farmTakesItem = (f, key) => {
    const it = m.item.get(key);
    if (f.stakes !== 'collectibles' || !it || it.kind === 'normal') return false;
    return listOf(f.gate).every(r => {
      if (r.items) return r.items.includes(key);
      if (r.item) return r.item === key;
      if (r.collection) return it.collection === r.collection;
      return true;
    });
  };
  /** The routes a prize line feeds: farms that stake it, recipes that take it, what its token buys. ["farm:reef", …] */
  const feedsOf = (p, seen = new Set()) => {
    const line = prizeLine(p);
    if (!line) return [];
    const out = new Set();
    if (line.gives === 'item') {
      for (const f of m.farms) if (farmTakesItem(f, line.item)) out.add(`farm:${f.key}`);
      for (const r of m.recipes) if ((r.in ?? []).some(i => i.item === line.item)) out.add(`recipe:${r.key}`);
    } else if (line.gives === 'tokens') {
      const t = prizeToken(line, m)?.key;
      if (t) for (const id of tokenFeeds(t)) out.add(id);
    } else if (line.gives === 'roll' && line.box && !seen.has(line.box)) {
      seen.add(line.box);
      for (const o of (m.box.get(line.box)?.outcomes ?? []).flatMap(outcomeParts)) {
        const as =
          o.gives === 'mint'
            ? { gives: 'tokens', currency: o.currency, amount: o.amount, from: 'mint' }
            : o.gives === 'pay'
              ? { gives: 'tokens', amount: o.amount, from: `pool:${o.pool}` }
              : o;
        for (const id of feedsOf(as, seen)) out.add(id);
      }
    }
    return [...out];
  };
  /** What a token is staked in or buys. */
  const tokenFeeds = t => [
    ...m.farms.filter(f => f.stakes === t).map(f => `farm:${f.key}`),
    ...m.allBoxes
      .filter(b => b.active !== false && (b.currency ?? m.currencyKey) === t && Number(b.price ?? 0) > 0)
      .map(b => (b.shopOf ? `item:${b.shopOf}` : `box:${b.key}`)),
    ...m.lotteries.filter(l => (l.ticketCurrency ?? l.currency ?? m.currencyKey) === t).map(l => `lottery:${l.key}`),
    ...m.recipes
      .filter(r => (r.in ?? []).some(i => i.takes === 'pay' && (i.currency ?? m.currencyKey) === t))
      .map(r => `recipe:${r.key}`),
  ];
  const farmOf = id => (id.startsWith('farm:') ? m.farm.get(id.slice(5)) : null);
  const mints = f => Boolean(f?.rate?.minted) && Number(f.rate.perDay ?? 0) > 0;
  /** A farm that pays for good: no end, no term on every tier, no upkeep, no halving. */
  const endless = f => !f.upkeepAttribute && farmCeiling(f)?.total === null;

  /**
   * What one staked unit (a collectible `item`, or one whole token) earns at its best tier and boosts: { perDay, life }
   * (`life`: days it can earn, or null for good; `perDay` null for a farm that shares what lands).
   */
  const earns = (f, item) => {
    if (!f.rate) return { perDay: null, life: f.runs ? days(f.runs) : null };
    const mult = Math.max(1, ...(f.tiers ?? []).map(t => Number(t.multiplier ?? 1)));
    let boost = 0;
    for (const b of f.boosts ?? []) {
      if (item && b.when?.item && b.when.item !== item) continue;
      if (item && b.when?.items && !b.when.items.includes(item)) continue;
      boost +=
        b.add?.addPercent ??
        (b.add?.perPointPercent !== undefined ? b.add.perPointPercent * (b.add.upTo ?? Infinity) : 0);
    }
    if (f.maxBoostPercent !== undefined) boost = Math.min(boost, Number(f.maxBoostPercent));
    const perDay = Number.isFinite(boost) ? Number(f.rate.perDay) * mult * (1 + boost / 100) : null;
    const lives = [
      f.runs ? days(f.runs) : null,
      f.rate.halveEvery ? days(f.rate.halveEvery) * 2 : null,
      (f.tiers ?? []).every(t => t.earnsFor) && (f.tiers ?? []).length
        ? Math.max(...f.tiers.map(t => days(t.earnsFor)))
        : null,
    ].filter(x => x !== null);
    return { perDay, life: lives.length ? Math.min(...lives) : null };
  };
  const earnsWords = (f, item) => {
    const e = earns(f, item);
    const what = f.stakes === 'collectibles' ? `each ${item ? (m.item.get(item)?.name ?? item) : 'NFT'}` : 'each token';
    const t = sym(f.rewardsToken);
    if (e.perDay === null)
      return f.rate
        ? `${what} earns more in ${label(f)} the more its boosts read`
        : `${what} takes a share of what lands in ${label(f)}`;
    const shared = f.rate.shared ? ' (the whole farm’s, shared by weight: all of it while alone)' : '';
    return e.life === null
      ? `${what} earns up to ${fmt(e.perDay)} ${t} a day in ${label(f)}${shared} (${fmt(e.perDay * 30)} in 30 days, ${fmt(e.perDay * 365)} a year), for as long as it stays staked, with no end`
      : `${what} earns up to ${fmt(e.perDay)} ${t} a day in ${label(f)}${shared}, at most about ${fmt(e.perDay * e.life)} over ${fmt(e.life)} days`;
  };

  // ---------------------------------------------------------------- grants

  const tradeable = p =>
    p?.gives === 'tokens' ||
    p?.gives === 'nft' ||
    p?.gives === 'roll' ||
    (p?.gives === 'item' && !m.item.get(p.item)?.soulbound && m.item.get(p.item)?.kind !== 'normal');
  /** The pools a prize pays from, a roll's included. */
  const poolsOf = (p, seen = new Set()) => {
    const line = prizeLine(p);
    if (!line) return [];
    if (prizePool(line)) return [prizePool(line)];
    if (line.gives !== 'roll' || !line.box || seen.has(line.box)) return [];
    seen.add(line.box);
    return (m.box.get(line.box)?.outcomes ?? [])
      .flatMap(outcomeParts)
      .flatMap(o => (o.gives === 'pay' ? [o.pool] : o.gives === 'roll' ? poolsOf(o, seen) : []));
  };
  const fillers = poolFillers(m);

  for (const g of m.grants) {
    const id = `grant:${g.key}`;
    const prize = prizeLine(g.prize ?? g.gives);
    const l = g.limits ?? {};
    const vouchers = g.vouchers ?? [];
    const keys = g.keys ?? [];
    const list = g.list ?? [];
    const open = !vouchers.length && !keys.length && !list.length;
    const feeds = feedsOf(prize);
    const earning = feeds.map(farmOf).filter(f => f && (Number(f.rate?.perDay ?? 0) > 0 || !f.rate));
    const minting = earning.filter(mints);
    const worth = tradeable(prize) || earning.length > 0;
    const gives = prizeWords(prize, m);
    const level = g.trust ?? null;
    // An undeclared server is read as the weakest: nothing says it checks more.
    const assumed = level ?? (vouchers.length ? 'bounds' : null);

    const enforced = [
      l.perWallet && `${l.perWallet} per wallet`,
      l.perWalletEach?.count && `${l.perWalletEach.count} per wallet every ${l.perWalletEach.every ?? '1d'}`,
      l.perPerson && `${l.perPerson} per person (counted only for a voucher that names one)`,
      l.perKey && `${l.perKey} per key`,
      l.perDay && `${l.perDay} a day, all wallets together`,
      l.total && `${l.total} in all`,
      l.opens && `not before ${l.opens}`,
      l.until && `not after ${l.until}`,
      g.gate && gateWords(g.gate, 'claim it', m).replace(/^Only/, 'only'),
      !open &&
        'each round pays a wallet once; a voucher names its wallet, grant and incarnation, so it can’t be moved or replayed',
      'only the receiving wallet signs the claim',
    ].filter(Boolean);
    const trusts = [
      ...vouchers.map(v => `the voucher key ${short(v)} (whatever it signs is paid, within the limits)`),
      ...(keys.length ? [`${keys.length} code keys (whoever has a code claims with it)`] : []),
      ...(list.length ? [`the list of ${list.length} wallets in the spec`] : []),
    ];
    const trigger = open
      ? `any wallet${
          g.gate
            ? ` that passes its gate (${gateWords(g.gate, 'claim it', m)
                .replace(/^Only /, '')
                .replace(/ can claim it$/, '')})`
            : ''
        }`
      : [
          vouchers.length && 'a wallet the voucher key signs for',
          keys.length && 'a wallet holding a code',
          list.length && 'a wallet on the list',
        ]
          .filter(Boolean)
          .join(', or ');

    // The most one cheater gets.
    const perWallet = l.perWallet
      ? `${l.perWallet} per wallet`
      : l.perWalletEach?.count
        ? `${l.perWalletEach.count} per wallet every ${l.perWalletEach.every ?? '1d'}`
        : 'no limit per wallet';
    const cap = l.perDay
      ? `up to ${l.perDay} a day (everyone’s daily total)${l.total ? ` and ${l.total} in all` : ', with no total: without end'}`
      : l.total
        ? `up to ${l.total} in all (everyone’s total)`
        : 'with no daily or overall cap: until the prize or its funds run out';
    const many = list.length
      ? `only the ${list.length} listed wallets: ${perWallet}, each round once`
      : keys.length && !vouchers.length
        ? l.perKey
          ? `${l.perKey} per code, ${fmt(keys.length * l.perKey)} with every code; ${cap}`
          : `a shared code pays every wallet that uses it; ${cap}`
        : l.perPerson
          ? `${l.perPerson} per person when the server names a real one (an X account); a voucher with no person counts nobody, and then free wallets claim ${perWallet} each, ${cap}`
          : `${perWallet}, and wallets are free: ${cap}`;
    const how = {
      decides: 'Playing for real (a bot that plays well): ',
      replays: 'A bot that plays well, or one that finds the best run offline when it knows the randomness up front: ',
      bounds: 'Without playing (a script at human speed): ',
    };
    const ceiling = `${open ? 'Without playing: ' : (how[assumed] ?? '')}${gives}, ${many}.${minting.length || earning.length ? ` Then ${earning.map(f => earnsWords(f, prize?.gives === 'item' ? prize.item : null)).join('; ')}.` : ''}`;
    routes.push({ kind: 'grant', key: g.key, name: g.name, trigger, enforced, trusts, trust: level, ceiling, feeds });

    // A voucher grant that says nothing of what its server checks.
    if (vouchers.length && !level)
      find(
        'R-TRUST-UNSAID',
        'medium',
        id,
        `${label(g)} pays whatever its voucher key signs, and the spec doesn’t say what that server checks before it signs. The program checks the signature, the wallet and the limits, never what happened in the game, so this review reads it as "bounds" (the page reports, the server only checks pace and caps): a script that never plays gets ${gives} as often as the limits allow.`,
        'Set "trust" to what the server really does: "decides" (it runs the game or match; the page sends only inputs), "replays" (it re-runs the page’s inputs from randomness it keeps) or "bounds" (it takes the page’s word within a pace and caps). Then tell the person which, and what a cheater gets.',
      );

    // A cheatable claim whose prize keeps earning.
    if ((assumed === 'bounds' || assumed === 'replays') && minting.length) {
      const forGood = minting.some(endless);
      const serious = forGood || !l.total;
      const severity = assumed === 'bounds' ? (serious ? 'high' : 'medium') : serious ? 'medium' : 'low';
      find(
        'R-CLAIM-COMPOUNDS',
        severity,
        id,
        `${label(g)} is ${level ? `"${level}"` : 'read as "bounds"'}: ${TRUST_WORDS[assumed]}. What it gives keeps earning: ${minting.map(f => earnsWords(f, prize?.gives === 'item' ? prize.item : null)).join('; ')}. So a cheater’s claim mints tokens ${forGood ? 'for good' : 'for as long as the farm runs'}, ${l.total ? `from up to ${l.total} claims in all` : 'and the grant has no "total"'}${l.perPerson ? '' : ', one claim for every free wallet'}.`,
        `Pick one, and tell the person the trade-off: have the server decide or replay the result (${assumed === 'bounds' ? 'the strongest fix' : 'decide it, for the strongest'}); give ${minting.map(label).join(', ')} an end ("runs") or a term on every tier ("earnsFor"); ${[!l.total && '"total"', !l.perPerson && '"perPerson"'].filter(Boolean).length ? `set the grant’s ${[!l.total && '"total"', !l.perPerson && '"perPerson"'].filter(Boolean).join(' and ')}; ` : ''}or pay a rate from the farm’s vault (no "minted"), so it can only pay what it holds.`,
      );
    } else if ((assumed === 'bounds' || assumed === 'replays') && earning.length)
      find(
        'R-CLAIM-COMPOUNDS',
        assumed === 'bounds' ? 'medium' : 'low',
        id,
        `${label(g)} is ${level ? `"${level}"` : 'read as "bounds"'}, and what it gives earns in ${earning.map(label).join(', ')}: what a cheater claims takes rewards honest stakers would have had.`,
        'Have the server decide or replay the result, or keep "total" and "perPerson" small.',
      );
    // A cheatable claim with no total, worth farming.
    else if ((assumed === 'bounds' || assumed === 'replays') && tradeable(prize) && !l.total)
      find(
        'R-CLAIM-UNCAPPED',
        assumed === 'bounds' ? 'medium' : 'low',
        id,
        `${label(g)} is ${level ? `"${level}"` : 'read as "bounds"'} and has no "total": a cheater claims ${gives} ${l.perDay ? `every day, up to ${l.perDay} a day,` : ''} for as long as it runs.`,
        'Set "total" (the most it ever pays), keep "perDay" small, or have the server decide or replay the result.',
      );

    // Entry fees and prize pools paid on a result the server only bounds or replays.
    const paidBy = [
      ...new Set(
        poolsOf(prize).flatMap(pool => fillers.filter(f => f.pool === pool && PLAYER_MONEY.test(f.by)).map(f => f.by)),
      ),
    ];
    if ((assumed === 'bounds' || assumed === 'replays') && paidBy.length)
      find(
        'R-STAKES-PAID',
        assumed === 'bounds' ? 'high' : 'medium',
        id,
        `${label(g)} pays ${gives} out of what players paid in (${paidBy.join(', ')}), on a result the server ${assumed === 'bounds' ? 'only bounds' : 'replays'}${level ? '' : ' (read as "bounds": its "trust" is not said)'}: a script takes other players’ money.`,
        'Keep entry fees and prize pools for results the server decides (a match it runs) and for chance (a lottery, a box: the oracle). Pay a bounded or replayed result only from what the project mints or seeds, small and capped a day.',
      );

    // Each free wallet claims again: a voucher grant with no person counted.
    if (vouchers.length && !l.perPerson && worth && Number(l.total ?? 0) !== 1)
      find(
        'R-GRANT-PERSON',
        g.gate ? 'low' : 'medium',
        id,
        `${label(g)} counts no person ("perPerson"): its limits are per wallet, and wallets are free, so one person with many wallets claims ${gives} once for each, up to ${l.perDay ? `${l.perDay} a day` : l.total ? `${l.total} in all` : 'its funds or prize'}${g.gate ? ', each wallet holding what its gate asks' : ''}.`,
        'Have the server sign only for players signed in with an outside account (X), naming that person in each voucher (a person hash, never a wallet), and set "perPerson". For a wallet-only player, keep the prize small and capped a day.',
      );

    // Open grants: anyone claims.
    if (open && !list.length) {
      const extra =
        !l.perWallet && !l.perWalletEach?.count ? ' It limits no wallet: one wallet claims again and again.' : '';
      if (worth) {
        const severity = !g.gate ? 'high' : g.gate.wallets || g.gate.list ? 'info' : 'medium';
        find(
          'R-GRANT-OPEN',
          severity,
          id,
          `${label(g)} is open: no voucher, code or list, so ${g.gate ? (g.gate.wallets || g.gate.list ? 'every wallet its gate lets in' : 'any wallet that passes its gate (each collectible shown counts once, so passing one around claims nothing more)') : 'any wallet'} claims ${gives} without doing anything, ${many}.${extra}${earning.length ? ` And ${earning.map(f => earnsWords(f, prize?.gives === 'item' ? prize.item : null)).join('; ')}.` : ''}`,
          g.gate
            ? 'Gate on something a sybil must pay for (an item the game sells, a locked stake), and keep "perDay" and "total" small.'
            : 'Pay it on vouchers from a server that checks what was done (and counts people with "perPerson"), or gate it on holding something the game sells; keep "perDay" and "total" small either way.',
        );
      } else
        find(
          'R-GRANT-OPEN',
          'low',
          id,
          `${label(g)} is open: any wallet claims ${gives}, ${many}. It can’t be sold, so farming it gains little.${extra}`,
        );
    }

    // A leaked key or a shared code: the checker's notes, read as exploits.
    const totals = [...warned('W-GRANT-TOTAL', `economy.grants.${g.key}`)].concat(
      warned('W-GRANT-LIMITS', `economy.grants.${g.key}.limits`).filter(w => w.where.endsWith('.limits')),
    );
    if (totals.length) find('R-GRANT-TOTAL', 'medium', id, totals.map(w => w.message).join(' '), totals[0].fix);
    for (const w of warned('W-GRANT-LIMITS', `economy.grants.${g.key}.limits.perKey`))
      find('R-CODES', 'medium', id, w.message, w.fix);
  }

  // ---------------------------------------------------------------- the shop, boxes, payments, recipes

  for (const b of m.allBoxes) {
    if (b.active === false) continue;
    const it = b.shopOf ? m.item.get(b.shopOf) : null;
    const kind = it ? 'item' : 'box';
    const key = it ? it.key : b.key;
    const id = `${kind}:${key}`;
    const price = Number(b.price ?? 0);
    const t = sym(b.currency ?? m.currencyKey);
    const rolls = boxRolls(b, m);
    const outcomes = (b.outcomes ?? []).flatMap(outcomeParts);
    const feeds = [
      ...new Set(
        outcomes.flatMap(o =>
          feedsOf(
            o.gives === 'mint'
              ? { gives: 'tokens', currency: o.currency, amount: o.amount, from: 'mint' }
              : o.gives === 'pay'
                ? { gives: 'tokens', amount: o.amount, from: `pool:${o.pool}` }
                : o,
          ),
        ),
      ),
    ];
    const enforced = [
      price > 0 ? `the price, ${fmt(price)} ${t}` : 'no price: free',
      it?.supply && `${it.supply} exist`,
      b.perWallet && `${b.perWallet} per wallet`,
      b.perWalletEach?.count && `${b.perWalletEach.count} per wallet every ${b.perWalletEach.every ?? '1d'}`,
      b.opens && `from ${b.opens}`,
      b.closes && `until ${b.closes}`,
      b.gate && gateWords(b.gate, kind === 'item' ? 'buy it' : 'open it', m).replace(/^Only/, 'only'),
      rolls && 'the roll is on its written odds, by the oracle',
    ].filter(Boolean);
    const free = price === 0;
    const ceiling = free
      ? `${b.perWallet ? `${b.perWallet} per wallet, and wallets are free: ` : ''}${it?.supply ? `all ${it.supply}` : 'as many as they like'}, for only the fees.`
      : `What they pay for, at the price: ${rolls ? 'nobody, the project included, can steer the roll' : 'nothing free'}.${b.whenOut === 'drawLeft' && rolls ? ' With "whenOut": "drawLeft", someone watching the stock can empty a common outcome, then open for the rare at better odds.' : ''}${b.whenOut === 'giveNothing' && rolls ? ' With "whenOut": "giveNothing", a draw on an outcome that is out gives nothing and is not refunded.' : ''}`;
    routes.push({
      kind,
      key,
      name: it?.name ?? b.name,
      trigger: `any wallet${free ? ', for only the fees' : ` that pays ${fmt(price)} ${t}`}`,
      enforced,
      trusts: rolls ? ['MagicBlock’s oracle (the roll)'] : [],
      trust: null,
      ceiling,
      feeds,
    });
    if (b.whenOut === 'drawLeft' && rolls && !free)
      find(
        'R-STOCK-STEER',
        'low',
        id,
        `${label(b)} keeps selling when an outcome runs out and draws among what is left: anyone watching the stock can empty a common outcome, then open for the rare at better odds.`,
        'Keep the default ("stopSales") for a box that sells a rare prize.',
      );
  }
  for (const w of warned('W-FREE')) {
    const [, list, key] = /^economy\.(items|boxes)\.([^.[]+)/.exec(w.where) ?? [];
    const route = list === 'items' ? `item:${key}` : list === 'boxes' ? `box:${key}` : 'economy';
    const r = routes.find(x => `${x.kind}:${x.key}` === route);
    const earning = (r?.feeds ?? []).map(farmOf).filter(f => f && mints(f));
    find(
      'R-FREE',
      earning.length ? 'high' : 'medium',
      route,
      `${w.message}${earning.length ? ` And ${earning.map(f => earnsWords(f, list === 'items' ? key : null)).join('; ')}.` : ''}`,
      w.fix,
    );
  }
  for (const p of m.payments)
    routes.push({
      kind: 'payment',
      key: p.key,
      name: p.name,
      trigger: 'any wallet that pays',
      enforced: [`${p.any ? 'at least ' : ''}${fmt(p.amount)} ${sym(p.currency ?? m.currencyKey)}`],
      trusts: ['your server, which reads the receipt and gives off the chain what was paid for'],
      trust: null,
      ceiling: 'What your server gives for a receipt: the program only takes the money. Count each receipt once.',
      feeds: [],
    });
  for (const r of m.recipes) {
    if (r.active === false) continue;
    routes.push({
      kind: 'recipe',
      key: r.key,
      name: r.name,
      trigger: 'any wallet holding what it takes',
      enforced: [
        'every line it takes, all or nothing',
        r.perWallet && `${r.perWallet} per wallet`,
        r.perWalletEach?.count && `${r.perWalletEach.count} per wallet every ${r.perWalletEach.every ?? '1d'}`,
        r.opens && `from ${r.opens}`,
        r.closes && `until ${r.closes}`,
      ].filter(Boolean),
      trusts: [],
      trust: null,
      ceiling: 'As many crafts as what it takes allows: as cheap to farm as its inputs are.',
      feeds: [...new Set((r.out ?? []).flatMap(o => feedsOf(o)))],
    });
  }

  // ---------------------------------------------------------------- farms

  for (const f of m.farms) {
    const id = `farm:${f.key}`;
    const takes =
      f.stakes === 'collectibles'
        ? f.gate
          ? listOf(f.gate).map(ruleWords).join(' and ')
          : 'one of the game’s collectibles'
        : `${sym(f.stakes)} tokens`;
    const items = f.stakes === 'collectibles' ? m.items.filter(it => farmTakesItem(f, it.key)) : [];
    const enforced = [
      f.stakes === 'collectibles'
        ? 'only NFTs its gate takes: the project’s collection and the item number the program writes at mint (nobody can forge or change it)'
        : `only ${sym(f.stakes)}`,
      'one seat per NFT, ever; nobody else harvests or unstakes a seat',
      f.rate
        ? `${f.rate.shared ? 'the whole farm’s' : 'a fixed'} ${fmt(f.rate.perDay)} ${sym(f.rewardsToken)} a day${f.rate.shared ? '' : ' per unit at x1'}, ${f.rate.minted ? 'minted' : 'from its vault while it lasts'}`
        : 'a share of what lands in its vault',
      `locks ${(f.tiers ?? [{ lock: 0 }]).map(t => `${t.lock ?? 0} (x${t.multiplier ?? 1})`).join(', ')}`,
      f.maxBoostPercent !== undefined && `boosts at most +${f.maxBoostPercent}%`,
      f.runs ? `ends ${f.runs} after it goes live` : 'no end',
      `${f.custody ?? 'escrow'} custody`,
    ].filter(Boolean);
    const best = items.length ? items.map(it => earnsWords(f, it.key)).join('; ') : earnsWords(f, null);
    routes.push({
      kind: 'farm',
      key: f.key,
      name: f.name,
      trigger: `any wallet that stakes ${takes}`,
      enforced,
      trusts: [],
      trust: null,
      ceiling: `${best}. Whoever holds the most of what it takes earns the most: how cheaply that is had is what to look at.`,
      feeds: [...new Set([...tokenFeeds(f.rewardsToken), ...(f.tiers ?? []).flatMap(t => feedsOf(t.prize))])],
    });
    // (a farm that mints without end: R-VALUE's net flow, from W-VALUE)
    if (f.custody === 'watch')
      find(
        'R-FARM-WATCH',
        'info',
        id,
        `${label(f)} watches NFTs left in their wallets: one NFT has one seat, ever. Sold while staked, its old staker earns nothing more and its buyer takes the seat over, so passing an NFT between wallets earns nothing twice.`,
      );
  }
  for (const w of warned('W-FARM-SWITCH')) {
    const key = /^economy\.farms\.([^.]+)/.exec(w.where)?.[1];
    find('R-FARM-SWITCH', 'low', key ? `farm:${key}` : 'economy', w.message, w.fix);
  }

  // ---------------------------------------------------------------- chance, contests, auctions, timers, the authority

  for (const l of m.lotteries) {
    const t = sym(l.ticketCurrency ?? l.currency ?? m.currencyKey);
    routes.push({
      kind: 'lottery',
      key: l.key,
      name: l.name,
      trigger: `any wallet that buys a ticket${l.ticketNft ? ' (with an NFT)' : ` (${fmt(l.price ?? 0)} ${t})`}`,
      enforced: [
        l.perWallet && `${l.perWallet} tickets per wallet a round`,
        l.gate && gateWords(l.gate, 'buy a ticket', m).replace(/^Only/, 'only'),
        'the draw is by the oracle; its places are paid by the program’s rules',
      ].filter(Boolean),
      trusts: ['MagicBlock’s oracle (the draw)'],
      trust: null,
      ceiling: l.timeWeighted
        ? `A place by chance, by weight: each purchase counts its tickets times the seconds left until sales close, so a ticket held longer has a better chance; "perWallet" limits a wallet, not a person.`
        : `A place by chance: each ticket is one chance, and "perWallet" limits a wallet, not a person. Tickets are not weighted by time, so one buyer may take most of a round’s tickets just before ${l.closesBefore ? 'sales close' : 'the draw'}.`,
      feeds: [...new Set((l.places ?? []).flatMap(p => feedsOf(p.prize)))],
    });
    if (!l.timeWeighted)
      find(
        'R-LOTTERY-LATE',
        l.noLoss && !l.closesBefore ? 'low' : 'info',
        `lottery:${l.key}`,
        `Anyone may buy most of ${label(l)}’s tickets right before ${l.closesBefore ? `sales close (${l.closesBefore} before the draw)` : 'the draw'}, risking only ${l.noLoss ? 'the fees: every ticket’s price comes back' : 'the price and fees'}; the draw itself is the oracle’s, which nobody steers.`,
        l.noLoss
          ? 'Weigh tickets by the time they are held ("timeWeighted": true), or close sales a while before the draw ("closesBefore").'
          : undefined,
      );
  }
  for (const c of m.contests) {
    const deciders = c.deciders ?? [];
    routes.push({
      kind: 'contest',
      key: c.key,
      name: c.name,
      trigger: 'the authority opens it; any wallet enters',
      enforced: [
        c.stake && `every entry ${fmt(c.stake)} ${sym(c.currency ?? m.currencyKey)}`,
        c.gate && gateWords(c.gate, 'enter', m).replace(/^Only/, 'only'),
        c.minPot && `at least ${fmt(c.minPot)} in the pot, or everyone is paid back`,
        'no result before entries close; a result overdue pays everyone back',
      ].filter(Boolean),
      trusts: deciders.length
        ? deciders.map(d => `the decider key ${short(d)} (it names the side that won)`)
        : ['the authority, which names the side that won'],
      trust: null,
      ceiling:
        'The losing sides’ stakes, for whichever side the signer names: the pot is only as honest as that result.',
      feeds: feedsOf(c.prize),
    });
    // (who names the result, what that key can also do, and when it can be known: R-ENFORCED, from W-ENFORCED)
  }
  for (const a of m.auctions) {
    routes.push({
      kind: 'auction',
      key: a.key,
      name: a.name,
      trigger: 'any wallet that bids',
      enforced: [
        a.reserve !== undefined && `a reserve of ${fmt(a.reserve)}`,
        a.minRaise !== undefined && `each bid ${a.minRaise} over the last`,
        `runs ${a.runs}`,
        'an outbid is paid back at once',
      ].filter(Boolean),
      trusts: [],
      trust: null,
      ceiling: 'The lot, for the highest bid: nothing free. Anyone, the seller included, can bid the price up.',
      feeds: a.lot?.item ? feedsOf({ gives: 'item', item: a.lot.item }) : [],
    });
  }
  for (const w of warned('W-AUCTION-SHILL')) {
    const key = /^economy\.auctions\.([^.]+)/.exec(w.where)?.[1];
    find('R-AUCTION-SHILL', 'info', key ? `auction:${key}` : 'economy', w.message, w.fix);
  }
  for (const s of m.schedules)
    routes.push({
      kind: 'schedule',
      key: s.key,
      name: s.name ?? s.key,
      trigger: s.sealed ? 'whoever it pays, when it is due' : 'the project’s keys (or whoever it pays), when it is due',
      enforced: [
        `${s.does} ${s.amount !== undefined ? fmt(s.amount) : `${s.percent}%`} every ${s.every}`,
        s.maxRuns && `${s.maxRuns} runs at most`,
        s.halveEvery && `halving every ${s.halveEvery} runs`,
        s.sealed && 'sealed: nobody, the owner included, changes or stops it',
      ].filter(Boolean),
      trusts: s.sealed ? [] : ['the authority, which runs it'],
      trust: null,
      ceiling: `Only what it pays to where it pays it${s.maxRuns ? '' : ', for good'}: nobody else can take it.`,
      feeds: [destination(s.to ?? '')].filter(d => d.kind === 'farm').map(d => `farm:${d.key}`),
    });
  for (const h of m.holds)
    routes.push({
      kind: 'hold',
      key: h.key,
      name: h.name,
      trigger: 'a player hands in a collectible',
      enforced: ['until its time is up only the authority moves it; after it, anyone sends it home'],
      trusts: ['the authority, which says where it goes'],
      trust: null,
      ceiling: 'Whatever the authority awards: the program trusts it.',
      feeds: [],
    });
  for (const d of m.decisions) {
    routes.push({
      kind: 'decision',
      key: d.key,
      name: d.key,
      trigger: `the authority${d.signedBy === 'server' ? ' (a server holding its key)' : ' (approved in its wallet)'}, when ${d.when}`,
      enforced: ['nothing beyond the authority’s signature: its caps are the server’s to keep'],
      trusts: [d.signedBy === 'server' ? 'the server holding the authority key' : 'the authority’s own judgement'],
      trust: null,
      ceiling:
        d.does === 'payout'
          ? `What the pool “${d.pool}” holds, on the authority’s word.`
          : 'Whatever the authority signs: the program trusts it.',
      feeds: d.item ? feedsOf({ gives: 'item', item: d.item }) : [],
    });
    if (d.signedBy === 'server' && ['payout', 'issue', 'make', 'award'].includes(d.does))
      find(
        m.authority === 'owner' ? 'R-AUTHORITY-ON-SERVER' : 'R-DECISION-SERVER',
        m.authority === 'owner' ? 'high' : 'medium',
        `decision:${d.key}`,
        m.authority === 'owner'
          ? `${label(d)} is signed by a server, but the authority is the owner’s own wallet: its key would sit on a machine that signs by itself, able to change and drain everything.`
          : `${label(d)} is signed by a server holding the authority key: the program enforces no caps on it, so whoever takes that server can ${d.does === 'payout' ? `empty the pool “${d.pool}”` : 'mint and make as it likes'}.`,
        m.authority === 'owner'
          ? 'Give the authority its own address ("keys.authority"), made for that server.'
          : 'Keep the server’s checks and caps strict, its key out of anything players load, and pools it pays from small.',
      );
  }

  // ---------------------------------------------------------------- keys, the authority and the treasury

  const voucherKeys = new Map();
  for (const g of m.grants)
    for (const v of g.vouchers ?? []) voucherKeys.set(v, [...(voucherKeys.get(v) ?? []), label(g)]);
  for (const [v, grants] of voucherKeys)
    find(
      'R-VOUCHER-KEY',
      'info',
      'economy',
      `The voucher key ${v} signs for ${grants.join(', ')}. The program refuses any other key and any voucher moved to another wallet, grant or incarnation, and pays a wallet each round once; the same round signed for a second wallet pays again, so a server that signs a win again for another wallet first reads the chain for the first one. What it can’t check is what the key’s server decides, and which person it names. Whoever holds that key pays anyone, up to these grants’ limits.`,
      'Keep its secret on the server only (never in a page, a repository or a spec); to rotate it, put the new public key in "vouchers" and publish. Their "perDay" and "total" are what a stolen key could take.',
    );
  const owner = 'the owner’s wallet';
  const authority = m.authority === 'owner' ? owner : `the key ${m.authority}`;
  find(
    'R-AUTHORITY',
    m.authority === 'owner' ? 'info' : 'low',
    'economy',
    `${owner[0].toUpperCase()}${owner.slice(1)} alone changes every price, rate, grant, limit and voucher key (publishing again), and closes parts. ${m.authority === 'owner' ? 'It is also the authority, which' : `The authority, ${authority},`} mints the project’s tokens, moves what pools hold, names contest results and releases holds, with no caps. ${m.treasuryWallet ? `What sales leave goes to the wallet ${m.treasuryWallet}.` : 'What sales leave goes to the owner’s wallet (the treasury).'} Money held for a record (a farm’s stakes and rewards, a pot, an order) leaves only by its record’s rules: neither key pays it out.`,
    'Keep these keys safe: on devnet, the key file the setup was signed with, readable by you alone and never pasted anywhere; with real money, a hardware wallet or a multisig. Never on a server that players can reach, unless it is an authority made for that server.',
  );
  for (const w of warned('W-MINT-POWERS')) {
    const key = /^economy\.tokens\.([^.]+)/.exec(w.where)?.[1];
    find('R-MINT-POWERS', 'low', key ? `token:${key}` : 'economy', w.message, w.fix);
  }
  // What the program takes and a player, a partner or a typo can turn against the project (loot 0.26): each warning,
  // as a finding on its route.
  const routeOf = where => {
    const [, list, key] = /^economy\.([a-z]+)\.([^.[]+)/.exec(where) ?? [];
    const kinds = {
      boxes: 'box',
      lotteries: 'lottery',
      auctions: 'auction',
      contests: 'contest',
      farms: 'farm',
      schedules: 'schedule',
      recipes: 'recipe',
      grants: 'grant',
      holds: 'hold',
      stashes: 'stash',
      tokens: 'token',
    };
    return kinds[list] ? `${kinds[list]}:${key}` : 'economy';
  };
  for (const [code, id, severity] of [
    ['W-FARM-AUTHORITY', 'R-FARM-AUTHORITY', 'high'],
    ['W-SCHEDULE-PAYEE', 'R-SCHEDULE-PAYEE', 'medium'],
    ['W-FAR-TIME', 'R-FAR-TIME', 'medium'],
    ['W-HOLD-UP', 'R-HOLD-UP', 'medium'],
    ['W-AUCTION-OUTSIDE', 'R-AUCTION-OUTSIDE', 'medium'],
    ['W-OUTSIDE-NFT', 'R-OUTSIDE-NFT', 'medium'],
    ['W-COLLECTION-PARTNER', 'R-COLLECTION-PARTNER', 'medium'],
    ['W-FARM-MISSION', 'R-FARM-MISSION', 'medium'],
    ['W-CONTEST-PRIZE', 'R-CONTEST-PRIZE', 'medium'],
    ['W-SHARED-SOURCE', 'R-SHARED-SOURCE', 'low'],
    ['W-LOTTERY-POOL', 'R-LOTTERY-POOL', 'low'],
    ['W-LOTTERY-WEIGHT', 'R-LOTTERY-WEIGHT', 'info'],
    ['W-ZERO', 'R-ZERO', 'low'],
    ['W-ANSWER', 'R-ANSWER', 'low'],
    ['W-VALUE', 'R-VALUE', 'medium'],
    ['W-ASSUMPTION', 'R-ASSUMPTION', 'medium'],
    ['W-STEPS', 'R-STEPS', 'low'],
    ['W-ENFORCED', 'R-ENFORCED', 'medium'],
  ])
    for (const w of warned(code)) find(id, w.severity ?? severity, routeOf(w.where), w.message, w.fix);

  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return {
    ok: !findings.some(f => f.severity === 'high'),
    routes,
    findings,
    tradeoffs: [tradeoffs(routes, findings), walkThrough(m, { now }).join('\n')].filter(Boolean).join('\n\n'),
  };
}

/** What moving one level up takes, for a route at `level`. */
const UP = {
  bounds:
    'Moving up to "replays": make the game deterministic (a fixed time step, seeded randomness the server keeps or reveals as the run goes) and have the server re-run each run’s inputs: a forged result then fails. It costs server CPU per run (replay short runs, or a long one in pieces as it is played).',
  replays:
    'Moving up to "decides": run the game or the match on the server (a turn game, a room whose server runs the match) so the page sends only inputs. It costs the most to build, and every move waits on the server.',
  decides: 'Already the strongest: a bot that plays well still earns, so keep its limits and "perPerson".',
};

/** The trade-off in short markdown, for the agent to show the person: the levels, this economy's routes, the costs. */
function tradeoffs(routes, findings) {
  const lines = [
    '**How far a result the server signs can be trusted**',
    '',
    '| Level | What the server does | What it costs to build | What a cheater gets |',
    '| --- | --- | --- | --- |',
    '| decides | runs the game or match itself; the page sends only inputs | the most: the rules run on the server, and every move waits on it | what a bot that plays well earns; nothing forged |',
    '| replays | re-runs the page’s inputs from randomness it keeps, reads the result | a deterministic game (fixed time step, seeded randomness) and CPU for each replay | what a bot that plays well earns; with the seed up front, the best run found offline |',
    '| bounds | starts each run, takes checkpoints in order, refuses what is too fast, caps a day | the least: a clock and counters | every reward a script claims at human speed, up to the limits |',
    '',
    '**In this economy**',
  ];
  const signed = routes.filter(r => r.kind === 'grant' && r.trusts.some(t => t.startsWith('the voucher key')));
  for (const r of signed) {
    const top = findings.find(f => f.route === `grant:${r.key}` && f.severity !== 'info');
    lines.push(
      `- “${r.name}”: **${r.trust ?? 'not said (read as bounds)'}**. ${r.ceiling}${top ? ` (${top.severity}: ${top.id})` : ''}`,
    );
  }
  const open = routes.filter(r => r.kind === 'grant' && !r.trusts.length);
  for (const r of open) lines.push(`- “${r.name}”: open, no server: ${r.ceiling}`);
  const chance = routes.filter(r => r.trusts.some(t => t.startsWith('MagicBlock')));
  if (chance.length)
    lines.push(
      `- Chance (the oracle): ${chance.map(r => `“${r.name}”`).join(', ')}. Nobody, the project included, steers a roll or a draw.`,
    );
  const contests = routes.filter(r => r.kind === 'contest');
  if (contests.length)
    lines.push(
      `- Results that move players’ stakes: ${contests.map(r => `“${r.name}”`).join(', ')}, as honest as whoever names the winner.`,
    );
  if (!signed.length && !open.length && !chance.length && !contests.length)
    lines.push('- No route pays on a result from off the chain.');
  const levels = [...new Set(signed.map(r => r.trust ?? 'bounds'))];
  if (levels.length) lines.push('', '**What the next level up costs**', ...levels.map(l => `- From ${l}: ${UP[l]}`));
  lines.push(
    '',
    'Pay a bounded or replayed result only what you would accept losing to a patient script (small, capped a day), and keep entry fees and prize pools for results the server decides and for chance. A wallet is not a person: count people only through vouchers that name an X account. Tell players which level each reward uses.',
  );
  return lines.join('\n');
}

/** A review in words, for the terminal and the tool's text. */
export function describeReview(r, name = 'This economy') {
  if (r.refusals?.length)
    return `${name} does not check (${r.refusals.length} refusal${r.refusals.length === 1 ? '' : 's'}): run xsolana_check and fix them first.`;
  const count = s => r.findings.filter(f => f.severity === s).length;
  const lines = [
    `Review of ${name}: ${r.routes.length} route${r.routes.length === 1 ? '' : 's'} that pay or give value; findings: ${SEVERITIES.map(s => `${count(s)} ${s}`).join(', ')}.`,
    '',
    'Routes',
  ];
  for (const x of r.routes) {
    lines.push(`- ${x.kind} “${x.name}” (${x.kind}:${x.key})${x.trust ? `, trust: ${x.trust}` : ''}`);
    lines.push(`  Who: ${x.trigger}`);
    if (x.enforced.length) lines.push(`  The program keeps: ${x.enforced.join('; ')}`);
    lines.push(`  Trusts off the chain: ${x.trusts.length ? x.trusts.join('; ') : 'nothing'}`);
    lines.push(`  Most one cheater gets: ${x.ceiling}`);
    if (x.feeds.length) lines.push(`  Feeds: ${x.feeds.join(', ')}`);
  }
  lines.push('', 'Findings');
  for (const f of r.findings) {
    lines.push(`- [${f.severity}] ${f.id} (${f.route}): ${f.message}`);
    if (f.fix) lines.push(`  Fix: ${f.fix}`);
  }
  lines.push('', 'Trade-offs to show the person', '', r.tradeoffs);
  return lines.join('\n');
}
