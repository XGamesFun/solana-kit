// From what a person wants to the specs that do it. A person's wants are written as requirements, each a test the tools
// can run on a spec (the refund of a cancelled round is what was paid; entering takes one approval). Bridges are the
// known ways to build a want loot has no single part for (any of many currencies → an entry token each currency buys,
// bundled into the purchase), each with what it adds. The search builds every combination of bridges for the route,
// checks each one (the checker and its analyses) and tests every requirement on it, then ranks them: the specs that keep
// the most, with the fewest findings and moving parts. When none keeps them all, it says which requirements can't hold
// together and what giving up each one costs. Pure.
//
// A first vocabulary, for a draw (a lottery or raffle) and how it is paid: more route kinds and bridges join it the same
// way, a requirement as a test and a bridge as a build.
import { check } from './check.mjs';
import { flows } from './flows.mjs';
import { model } from './model.mjs';
import { journeyOf } from './walk.mjs';

const clone = x => structuredClone(x);
/** A copy of a lottery for another draw: without its program number, which the new one gets its own of. */
const copyOf = ({ id: _id, ...rest }) => clone(rest);

/**
 * The requirements, by kind: `says` (the requirement read back to the person) and `test(c)` → { kept: true | false |
 * 'partly', why } on a candidate c = { spec, m, fl, verdict, plan }.
 */
export const REQUIREMENTS = {
  'pay-in': {
    says: r => `People can enter by paying any of: ${r.currencies.map(c => `${c.amount} ${c.token}`).join(', ')}.`,
    test: (c, r) => {
      const missing = r.currencies.filter(cur => !c.plan.paidWith.has(cur.token));
      return missing.length
        ? { kept: false, why: `no way to pay in ${missing.map(x => x.token).join(', ')}` }
        : { kept: true, why: c.plan.payWords };
    },
  },
  burn: {
    says: () => 'What people pay for an entry is burned.',
    test: c =>
      c.plan.burn === 'entry'
        ? { kept: true, why: 'burned at the purchase' }
        : c.plan.burn === 'settle'
          ? { kept: true, why: 'burned once the round is drawn (a cancel refunds it instead)' }
          : { kept: false, why: 'nothing burns it' },
  },
  'refund-as-paid': {
    says: () => 'If the draw is cancelled, people get back what they paid.',
    test: c => {
      const draw = c.fl.routes.find(x => x.key === c.plan.draw);
      const asset = draw?.price[0]?.asset;
      // Every draw priced in a currency people pay with refunds what was paid.
      // (a draw of free tickets refunds the free ticket, which is what was put in)
      const priced = c.plan.draws
        .filter(k => k !== c.plan.freeDraw)
        .map(k => c.fl.routes.find(x => x.key === k)?.price[0]?.asset);
      if (priced.every(a => c.plan.paidWith.has(a)))
        return { kept: true, why: `a cancel refunds ${[...new Set(priced)].join(', ')}, what was paid` };
      const sym = c.fl.assets.get(asset)?.symbol ?? asset;
      if (c.plan.swapBack)
        return {
          kept: 'partly',
          why: `a cancel refunds ${sym}; the owner switches on a way back after each cancel${c.plan.paidWith.size > 1 ? `, and it pays out any of the ${c.plan.paidWith.size} currencies at your fixed rates, so an entry bought with one can be taken back in another (an exchange at your prices while it is on)` : ''}`,
        };
      return { kept: false, why: `a cancel refunds ${sym}, not what was paid` };
    },
  },
  'free-entry': {
    says: r =>
      `Everyone can claim ${r.perPerson ?? 1} free entr${(r.perPerson ?? 1) === 1 ? 'y' : 'ies'}${r.spendable === false ? ', which is good only as an entry (it can’t be spent or turned into money)' : ''}.`,
    test: (c, r) => {
      if (!c.plan.free) return { kept: false, why: 'no free entry' };
      if (r.spendable !== false) return { kept: true, why: c.plan.freeWords };
      const a = c.fl.assets.get(c.plan.free.asset);
      if (a?.money)
        return {
          kept: 'partly',
          why: `there is a free entry, but it is ${a.symbol}, money that can be spent anywhere`,
        };
      const backs = a?.backs ?? [];
      if (backs.some(b => b.recipe.active !== false))
        return { kept: false, why: `a free ${a.symbol} turns into money at once` };
      if (backs.length)
        return {
          kept: 'partly',
          why: `a free ${a.symbol} turns into money once the way back is switched on (after a cancel)`,
        };
      return { kept: true, why: c.plan.freeWords };
    },
  },
  'one-approval': {
    says: () => 'Entering takes one wallet approval.',
    test: c => {
      const draw = c.fl.routes.find(x => x.key === c.plan.draw);
      const j = draw ? journeyOf(draw, c.fl) : null;
      if (!j) return { kept: false, why: 'no draw' };
      const crafts = j.steps.length - (draw.kind === 'lottery' ? 2 : 1);
      return crafts <= 0
        ? { kept: true, why: 'one purchase' }
        : j.bundles.length
          ? { kept: true, why: 'the craft rides in the purchase (buyTickets’ make)' }
          : { kept: false, why: `${crafts + 1} approvals` };
    },
  },
  'one-draw': {
    says: () => 'There is one draw for the prize.',
    test: c =>
      c.plan.draws.length === 1
        ? { kept: true, why: 'one draw' }
        : { kept: false, why: `${c.plan.draws.length} draws, each with its own winner and prize` },
  },
};

/**
 * The bridges, as choices the search combines: how the draw is paid (`pay`), where the payment burns (`burn`), how a
 * cancel gives it back (`refund`), and what a free entry is (`free`). Each `build(spec, ctx)` changes the candidate and
 * says what it did; one that can't apply to the choices made before it returns false.
 */
export const BRIDGES = {
  pay: [
    {
      id: 'direct',
      says: 'the draw is priced in the one currency itself',
      build: (s, x) => {
        if (x.currencies.length !== 1) return false;
        const [cur] = x.currencies;
        Object.assign(x.lottery(s), { currency: cur.token, price: cur.amount });
        x.plan.paidWith.add(cur.token);
        x.plan.payWords = `the draw takes ${cur.amount} ${cur.token} a ticket`;
        return true;
      },
    },
    {
      id: 'entry-token',
      says: 'an entry token, which each currency buys through a recipe; the draw takes the entry token, and the purchase crafts it in the same approval',
      build: (s, x) => {
        const entry = `${x.route}-entry`;
        s.tokens.push({
          key: entry,
          source: 'project',
          name: `${x.lottery(s).name ?? x.route} entry`,
          symbol: 'ENTRY',
          decimals: 0,
        });
        for (const cur of x.currencies) {
          s.recipes.push({
            key: `${x.route}-buy-${cur.token}`.slice(0, 32),
            name: `Entry for ${cur.amount} ${cur.token}`,
            in: [{ takes: 'pay', amount: cur.amount, currency: cur.token, to: x.burnAtEntry ? 'burn' : 'treasury' }],
            out: [{ gives: 'tokens', amount: 1, from: 'mint', currency: entry }],
          });
          x.plan.paidWith.add(cur.token);
        }
        Object.assign(x.lottery(s), { currency: entry, price: 1 });
        x.plan.entry = entry;
        x.plan.payWords = `each of ${x.currencies.length} currencies buys an entry token, crafted in the purchase`;
        return true;
      },
    },
    {
      id: 'draw-each',
      says: 'one draw for each currency, each priced in its own',
      build: (s, x) => {
        if (x.currencies.length < 2) return false;
        const base = x.lottery(s);
        s.lotteries = s.lotteries.filter(l => l !== base);
        for (const cur of x.currencies) {
          const key = `${x.route}-${cur.token}`.slice(0, 32);
          s.lotteries.push({
            ...copyOf(base),
            key,
            name: `${base.name ?? x.route} (${cur.token})`,
            currency: cur.token,
            price: cur.amount,
          });
          x.plan.draws.push(key);
          x.plan.paidWith.add(cur.token);
        }
        x.plan.draws = x.plan.draws.filter(k => k !== x.route);
        x.plan.draw = x.plan.draws[0];
        x.plan.payWords = `a draw in each currency`;
        return true;
      },
    },
  ],
  burn: [
    { id: 'none', says: 'the payment goes to the treasury', build: (s, x) => ((x.plan.burn = null), true) },
    {
      id: 'at-entry',
      says: 'the payment is burned when the entry is bought',
      // Only an entry token's recipe can burn at the purchase; a draw priced in the currency holds it until the draw.
      build: (s, x) => {
        if (!x.plan.entry) return false;
        for (const r of s.recipes.filter(r => r.key.startsWith(`${x.route}-buy-`))) r.in[0].to = 'burn';
        x.plan.burn = 'entry';
        return true;
      },
    },
    {
      id: 'at-settle',
      says: 'the payment is held until the draw and burned then ("rest": "burn"), so a cancel refunds it',
      build: (s, x) => {
        if (x.plan.entry) return false;
        for (const l of s.lotteries.filter(l => x.plan.draws.includes(l.key))) {
          delete l.pot;
          l.rest = 'burn';
        }
        x.plan.burn = 'settle';
        return true;
      },
    },
  ],
  refund: [
    { id: 'as-is', says: 'a cancel refunds the ticket', build: () => true },
    {
      id: 'swap-back',
      says: 'what each currency pays for an entry is held in a pool of its own, and a recipe pays an entry back from it, switched off and switched on by the owner after a cancel',
      build: (s, x) => {
        // A burned payment can't come back; a held one can.
        if (!x.plan.entry || x.plan.burn === 'entry') return false;
        s.pools ??= [];
        for (const cur of x.currencies) {
          const pool = `${x.route}-${cur.token}`.slice(0, 32);
          s.pools.push({ key: pool, currency: cur.token, seed: 0 });
          const buy = s.recipes.find(r => r.key === `${x.route}-buy-${cur.token}`.slice(0, 32));
          buy.in[0].to = `pool:${pool}`;
          s.recipes.push({
            key: `${x.route}-back-${cur.token}`.slice(0, 32),
            name: `${cur.amount} ${cur.token} for an entry`,
            active: false,
            in: [{ takes: 'pay', amount: 1, currency: x.plan.entry, to: 'burn' }],
            out: [{ gives: 'tokens', amount: cur.amount, from: `pool:${pool}`, currency: cur.token }],
          });
        }
        x.plan.swapBack = true;
        return true;
      },
    },
  ],
  free: [
    {
      id: 'none',
      says: 'no free entry',
      // (a grant the person named for free entries, with no prize yet, goes)
      build: (s, x) => ((s.grants = s.grants.filter(g => g.key !== x.freeKey || g.prize || g.gives)), true),
    },
    {
      id: 'grant-ticket',
      says: 'a grant gives what the draw takes, one a person',
      build: (s, x) => {
        if (!x.wantsFree) return false;
        const draw = s.lotteries.find(l => l.key === x.plan.draw);
        const g = x.freeGrant(s);
        // From the token's pool when it has one (a fixed supply can't be minted), else minted.
        const pool = (s.pools ?? []).find(p => p.currency === draw.currency);
        g.prize = {
          gives: 'tokens',
          amount: draw.price,
          from: pool ? `pool:${pool.key}` : 'mint',
          currency: draw.currency,
        };
        x.plan.free = { asset: draw.currency };
        x.plan.freeWords = `a grant gives ${draw.price} ${draw.currency}, a ticket's price`;
        return true;
      },
    },
    {
      id: 'free-draw',
      says: 'free entries go into a draw of their own, with a ticket token that is good for nothing else',
      build: (s, x) => {
        if (!x.wantsFree) return false;
        const base = s.lotteries.find(l => l.key === x.plan.draw);
        const ticket = `${x.route}-free`.slice(0, 32);
        s.tokens.push({ key: ticket, source: 'project', name: 'Free entry', symbol: 'FREE', decimals: 0 });
        const key = `${x.route}-free-draw`.slice(0, 32);
        s.lotteries.push({
          ...copyOf(base),
          key,
          name: `${base.name ?? x.route} (free)`,
          currency: ticket,
          price: 1,
          rest: 'burn',
        });
        delete s.lotteries.at(-1).pot;
        x.plan.draws.push(key);
        x.plan.freeDraw = key;
        const g = x.freeGrant(s);
        g.prize = { gives: 'tokens', amount: 1, from: 'mint', currency: ticket };
        x.plan.free = { asset: ticket };
        x.plan.freeWords = 'a grant gives a free ticket to a draw of its own';
        return true;
      },
    },
  ],
};

/**
 * Every spec the bridges build for `route` (a lottery of `base`) under `requirements`, checked and tested, best first:
 * { candidates: [{ bridges, says, kept, partly, broken, results, findings, spec }], conflicts }. `conflicts`: when no
 * candidate keeps every requirement, the smallest sets of requirements the best ones give up.
 */
export function design(base, requirements, { now = Math.floor(Date.now() / 1000) } = {}) {
  const pay = requirements.find(r => r.kind === 'pay-in');
  const route = pay?.route ?? base.lotteries?.[0]?.key;
  const wantsFree = requirements.some(r => r.kind === 'free-entry');
  const wantsBurn = requirements.some(r => r.kind === 'burn');
  const candidates = [];
  for (const p of BRIDGES.pay)
    for (const b of BRIDGES.burn)
      for (const r of BRIDGES.refund)
        for (const f of BRIDGES.free) {
          if (!wantsFree && f.id !== 'none') continue;
          if (!wantsBurn && b.id !== 'none') continue;
          const spec = clone(base);
          spec.tokens ??= [];
          spec.recipes ??= [];
          spec.grants ??= [];
          // A draw must name where its places are paid from: what is left goes to the treasury unless a bridge says.
          for (const l of spec.lotteries ?? [])
            if (l.key === route && l.pot === undefined && l.rest === undefined) l.rest = 'treasury';
          const x = {
            route,
            currencies: pay?.currencies ?? [],
            wantsFree,
            burnAtEntry: false,
            plan: {
              draw: route,
              draws: [route],
              paidWith: new Set(),
              entry: null,
              burn: null,
              swapBack: false,
              free: null,
            },
            lottery: s => s.lotteries.find(l => l.key === route),
            freeKey: requirements.find(q => q.kind === 'free-entry')?.grant,
            freeGrant: s => {
              const want = requirements.find(q => q.kind === 'free-entry');
              let g = s.grants.find(q => q.key === want.grant);
              if (!g) {
                g = {
                  key: want.grant ?? `${route}-free-entry`,
                  name: 'Free entry',
                  limits: { perPerson: want.perPerson ?? 1, perWallet: want.perPerson ?? 1 },
                };
                s.grants.push(g);
              }
              return g;
            },
          };
          // (the burn's place is known before the recipes are written)
          x.burnAtEntry = b.id === 'at-entry';
          if (![p, b, r, f].every(step => step.build(spec, x) !== false)) continue;
          let verdict;
          try {
            verdict = check(spec, { now });
          } catch {
            continue;
          }
          // (a combination the program refuses is no design)
          if (!verdict.ok) continue;
          const m = model(spec, { now });
          const fl = flows(m, { now });
          const c = { spec, m, fl, verdict, plan: x.plan };
          const results = requirements.map(q => ({
            kind: q.kind,
            says: REQUIREMENTS[q.kind].says(q),
            ...REQUIREMENTS[q.kind].test(c, q),
          }));
          const lens = verdict.warnings.filter(w => w.severity);
          candidates.push({
            bridges: [p.id, b.id, r.id, f.id],
            says: [p, b, r, f].filter(s => !['none', 'as-is'].includes(s.id)).map(s => s.says),
            kept: results.filter(q => q.kept === true).length,
            partly: results.filter(q => q.kept === 'partly').length,
            broken: results.filter(q => q.kept === false).map(q => q.kind),
            results,
            findings: {
              high: lens.filter(w => w.severity === 'high').length,
              medium: lens.filter(w => w.severity === 'medium').length,
            },
            parts: spec.lotteries.length + spec.recipes.length + spec.grants.length,
            spec,
          });
        }
  const score = c => c.kept + c.partly / 2 - c.findings.high * 0.5 - c.findings.medium * 0.1 - c.parts * 0.01;
  candidates.sort((a, b) => score(b) - score(a));
  // What can't hold together: the smallest sets of requirements the candidates give up (partly kept counts as given up).
  const gaveUp = candidates.map(c =>
    c.results
      .filter(q => q.kept !== true)
      .map(q => q.kind)
      .sort()
      .join('+'),
  );
  const all = candidates.some(c => c.results.every(q => q.kept === true));
  const sets = [...new Set(gaveUp)].map(s => s.split('+').filter(Boolean));
  const minimal = all ? [] : sets.filter(a => !sets.some(b => b.length < a.length && b.every(k => a.includes(k))));
  const conflicts = minimal
    .sort((a, b) => a.length - b.length)
    .map(kinds => ({
      giveUp: kinds,
      best: candidates.find(
        c =>
          c.results
            .filter(q => q.kept !== true)
            .map(q => q.kind)
            .sort()
            .join('+') === [...kinds].sort().join('+'),
      ),
    }));
  return { candidates, conflicts, allKept: all };
}

/** The design in words, for the agent to read and put to the person: the requirements, the conflicts, the top specs. */
export function describeDesign(result, requirements, { top = 3 } = {}) {
  const lines = ['What the person wants, as requirements (read these back to them):'];
  for (const r of requirements) lines.push(`- ${REQUIREMENTS[r.kind].says(r)}`);
  if (result.allKept) lines.push('', 'A design keeps every one of them:');
  else {
    lines.push('', 'No design keeps all of them. What has to give, and the best design for each choice:');
    for (const c of result.conflicts.slice(0, top)) {
      const gave = c.best.results.filter(q => q.kept !== true);
      lines.push(
        `- Give up ${gave.map(q => `“${q.says.replace(/\.$/, '')}”${q.kept === 'partly' ? ' in part' : ''} (${q.why})`).join(' and ')}: ${c.best.says.join('; ')}.`,
      );
    }
    lines.push('', 'The designs, best first:');
  }
  result.candidates.slice(0, top).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.says.join('; ')}.`);
    for (const q of c.results)
      lines.push(`   ${q.kept === true ? '✓' : q.kept === 'partly' ? '~' : '✗'} ${q.says} ${q.why}.`);
    lines.push(
      `   Findings: ${c.findings.high} high, ${c.findings.medium} medium (xsolana_check on its spec gives each).`,
    );
  });
  return lines.join('\n');
}
