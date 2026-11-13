// From what a person wants to the specs that do it. A person's wants are written as requirements, each a test the tools
// can run on a spec (the refund of a cancelled round is what was paid; entering takes one approval). Bridges are the
// known ways to build a want loot has no single part for (any of many currencies → an entry token each currency buys,
// bundled into the purchase), each with what it adds. The search builds every combination of bridges for the route,
// checks each one (the checker and its analyses) and tests every requirement on it, then ranks them: the specs that keep
// the most, then the ones that play best (fewest approvals, fewest tokens to learn), then the cleanest, then the most
// secure. When none keeps them all, it says which requirements can't hold
// together and what giving up each one costs. Pure.
//
// Routes come in families (FAMILIES): a draw (a lottery or a raffle) and how it is paid, a sale of an item, a reward
// (a grant), staking (a farm) and a contest. More join the same way: a requirement as a test, a bridge as a build.
import { check } from './check.mjs';
import { flows } from './flows.mjs';
import { farmCeiling, model } from './model.mjs';
import { journeyOf } from './walk.mjs';

const num = x => Number(x ?? 0);
const clone = x => structuredClone(x);
/** A copy of a lottery for another draw: without its program number, which the new one gets its own of. */
const copyOf = ({ id: _id, ...rest }) => clone(rest);

/**
 * The requirements, by kind: `says` (the requirement read back to the person) and `test(c)` → { kept: true | false |
 * 'partly', why } on a candidate c = { spec, m, fl, verdict, plan }.
 */
export const REQUIREMENTS = {
  'pay-in': {
    says: r => `People can pay with any of: ${r.currencies.map(c => `${c.amount} ${c.token}`).join(', ')}.`,
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
          : c.plan.burn === 'held'
            ? {
                kept: 'partly',
                why: 'held in a pool until the draw, then burned by the owner (one action after each draw)',
              }
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
    says: () => 'Each go takes one wallet approval.',
    test: c => {
      if (!c.plan.draw) {
        const r = c.fl.routes.find(x => (c.plan.routes ?? []).includes(x.key));
        const n = r ? journeyOf(r, c.fl).prompts : 1;
        return n <= 1 ? { kept: true, why: 'one approval' } : { kept: false, why: `${n} approvals` };
      }
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
  'one-token': {
    says: () => 'Players handle no token besides what they already hold and the prize.',
    test: c =>
      c.plan.entry || c.plan.freeDraw
        ? {
            kept: false,
            why: `players hold a token of its own (${[c.plan.entry, c.plan.freeDraw ? c.plan.free?.asset : null].filter(Boolean).join(', ')}) to understand`,
          }
        : { kept: true, why: 'nothing new to hold' },
  },
  'first-reward-no-sol': {
    says: () => 'A new player gets their first reward without needing SOL first.',
    test: c =>
      c.plan.proof
        ? {
            kept: 'partly',
            why: 'a claim, whose fees the page or server can pay for them (anyone may); they still need a wallet',
          }
        : c.plan.free
          ? {
              kept: 'partly',
              why: 'the free entry is a claim, whose fees the page or server can pay for them (anyone may); they still need a wallet',
            }
          : { kept: false, why: 'their first entry is bought: they need SOL for its fees first' },
  },
  'one-draw': {
    says: () => 'There is one draw for the prize.',
    test: c =>
      c.plan.draws.length === 1
        ? { kept: true, why: 'one draw' }
        : { kept: false, why: `${c.plan.draws.length} draws, each with its own winner and prize` },
  },
  // ---- a sale
  'fixed-price': {
    says: () => 'Buyers know exactly what they get for the price (not random).',
    test: c => {
      const rolls = c.fl.routes.filter(r => (c.plan.routes ?? []).includes(r.key)).some(r => r.roll);
      return rolls
        ? { kept: false, why: 'what they get is rolled' }
        : { kept: true, why: 'a fixed price for a fixed thing' };
    },
  },
  instant: {
    says: () => 'Buyers get it at once, with no wait.',
    test: c => {
      const rolls = c.fl.routes.filter(r => (c.plan.routes ?? []).includes(r.key)).some(r => r.roll);
      return rolls
        ? { kept: false, why: 'it waits on the oracle’s roll' }
        : { kept: true, why: 'given in the purchase' };
    },
  },
  'fair-scarce': {
    says: r => `A person gets at most ${r.perPerson ?? 1}, and a script with many wallets doesn't beat people to it.`,
    test: c => {
      if (c.plan.fair === 'allowlist') return { kept: true, why: 'only your list buys, one wallet a person' };
      const it = c.spec.items.find(i => i.key === c.x.route);
      const players = num(c.spec.scenario?.players);
      if (num(it?.supply) && players && players * c.x.per <= num(it.supply))
        return { kept: true, why: `${it.supply} for about ${players} people: enough for all` };
      return {
        kept: false,
        why: 'first come, first served by wallet: one person with many wallets, or a script, buys first',
      };
    },
  },

  // ---- a reward
  'per-person': {
    says: r => `A person claims at most ${r.claims ?? 1}, however many wallets they have.`,
    test: c =>
      c.plan.cap === 'person'
        ? { kept: true, why: 'counted by the account your server names in each voucher' }
        : c.plan.proof === 'list'
          ? { kept: true, why: 'only your list claims, one wallet a person' }
          : { kept: false, why: 'counted by wallet, and wallets are free: one person claims once for each wallet' },
  },
  'no-server': {
    says: () => 'It runs with no server to keep up.',
    test: c =>
      ['open', 'list'].includes(c.plan.proof)
        ? { kept: true, why: c.plan.proof === 'list' ? 'the list is written once, at setup' : 'nothing signs claims' }
        : { kept: false, why: 'a server must sign each claim, for as long as it runs' },
  },
  'bot-proof': {
    says: () => 'A script gets no more than a person playing honestly.',
    test: c =>
      c.plan.proof === 'decides'
        ? { kept: true, why: 'the server ran what it signs for' }
        : c.plan.proof === 'list'
          ? { kept: 'partly', why: 'only listed wallets claim, but a listed one can be scripted' }
          : {
              kept: false,
              why:
                c.plan.proof === 'bounds'
                  ? 'a script at a human pace gets the most the caps allow'
                  : 'anyone, a script included, claims up to the limits',
            },
  },
  bounded: {
    says: r => `It gives at most ${r.total} claims in all.`,
    test: (c, r) => {
      const g = c.spec.grants.find(q => q.key === c.x.route);
      return num(g?.limits?.total) && num(g.limits.total) <= r.total
        ? { kept: true, why: `${g.limits.total} in all` }
        : { kept: false, why: 'no total' };
    },
  },

  // ---- staking
  'emission-cap': {
    says: r => `It pays out at most ${r.total} in all.`,
    test: (c, r) => {
      const f = c.spec.farms.find(q => q.key === c.x.route);
      if (!f.rate)
        return num(f.seed) <= r.total
          ? { kept: true, why: `a vault of ${f.seed}, nothing more` }
          : { kept: false, why: `a vault of ${f.seed}` };
      const ceiling = farmCeiling(f);
      if (ceiling?.total === null || ceiling?.total === undefined) return { kept: false, why: 'minted with no end' };
      const units = f.rate.shared
        ? 1
        : f.stakes === 'collectibles'
          ? num(c.spec.items.find(i => i.key === f.item)?.supply) || Infinity
          : num(c.spec.tokens.find(t => t.key === f.stakes)?.supply) || Infinity;
      const most = ceiling.total * units;
      return most <= r.total
        ? { kept: true, why: `at most ${+most.toFixed(6)} in all` }
        : {
            kept: false,
            why:
              most === Infinity ? 'as much as can be staked, with no cap on that' : `up to ${+most.toFixed(6)} in all`,
          };
    },
  },
  predictable: {
    says: () => 'A staker knows what each unit earns a day.',
    test: c =>
      c.plan.payout === 'fixed'
        ? { kept: true, why: 'a fixed rate a unit' }
        : { kept: false, why: 'a seat’s share falls as others stake' },
  },
  'no-lock': {
    says: () => 'A stake can leave at any time.',
    test: c => (c.plan.lock ? { kept: false, why: `locked for ${c.plan.lock}` } : { kept: true, why: 'no lock' }),
  },
  'whale-fair': {
    says: () => 'The largest holder can’t take most of what it pays.',
    test: c =>
      c.plan.payout === 'fixed'
        ? { kept: true, why: 'each unit earns the same, so a big holder earns more only by staking more' }
        : { kept: false, why: 'split by stake: the largest holder takes the largest share of a fixed amount' },
  },

  // ---- a contest
  'no-owner-trust': {
    says: () => 'Players don’t have to trust the owner’s own key with the result.',
    test: c =>
      c.plan.decider === 'decider'
        ? { kept: 'partly', why: 'a decider key signs only verdicts, but players trust whoever holds it' }
        : { kept: false, why: 'the project’s key names it, the key that can also mint and move pools' },
  },
  'equal-stakes': {
    says: r => `Everyone puts in the same${r.amount ? ` (${r.amount})` : ''}.`,
    test: c =>
      c.plan.stake
        ? { kept: true, why: `exactly ${c.plan.stake} an entry` }
        : { kept: false, why: 'each puts in what they like' },
  },
  'refund-if-no-result': {
    says: () => 'With no result, everyone gets their money back.',
    test: () => ({
      kept: true,
      why: 'with no result by its deadline anyone calls it off, and every entry claims its money back',
    }),
  },
};

/**
 * The bridges, as choices the search combines: how the draw is paid (`pay`), where the payment burns (`burn`), how a
 * cancel gives it back (`refund`), and what a free entry is (`free`). Each `build(spec, ctx)` changes the candidate and
 * says what it did; one that can't apply to the choices made before it returns false.
 */
const DRAW_BRIDGES = {
  pay: [
    {
      id: 'direct',
      says: 'the draw is priced in the one currency itself',
      plain: x => `players pay ${x.currencies[0].amount} ${x.currencies[0].token.toUpperCase()} a ticket`,
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
      plain: x =>
        `players buy an entry with ${x.currencies.map(c => `${c.amount} ${c.token.toUpperCase()}`).join(' or ')}, and buying it rides in the ticket purchase: one approval`,
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
      plain: () => 'there is a separate draw in each currency, each with its own winner and prize',
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
    {
      id: 'none',
      says: 'the payment goes to the treasury',
      plain: () => 'what they pay goes to your treasury',
      build: (s, x) => ((x.plan.burn = null), true),
    },
    {
      id: 'at-entry',
      says: 'the payment is burned when the entry is bought',
      plain: () => 'what they pay is burned the moment they buy',
      // Only an entry token's recipe can burn at the purchase; a draw priced in the currency holds it until the draw.
      build: (s, x) => {
        if (!x.plan.entry) return false;
        for (const r of s.recipes.filter(r => r.key.startsWith(`${x.route}-buy-`))) r.in[0].to = 'burn';
        x.plan.burn = 'entry';
        return true;
      },
    },
    {
      id: 'held',
      says: 'what each currency pays for an entry is held in a pool of its own until the draw, and the owner burns it after the draw (one action), so a cancel can still pay it back',
      plain: () => 'what they pay waits in a pool until the draw, and you burn it after each draw (one action)',
      build: (s, x) => {
        if (!x.plan.entry) return false;
        s.pools ??= [];
        for (const cur of x.currencies) {
          const pool = `${x.route}-${cur.token}`.slice(0, 32);
          if (!s.pools.some(p => p.key === pool)) s.pools.push({ key: pool, currency: cur.token, seed: 0 });
          const buy = s.recipes.find(r => r.key === `${x.route}-buy-${cur.token}`.slice(0, 32));
          buy.in[0].to = `pool:${pool}`;
        }
        x.plan.burn = 'held';
        x.plan.held = true;
        return true;
      },
    },
    {
      id: 'at-settle',
      says: 'the payment is held until the draw and burned then ("rest": "burn"), so a cancel refunds it',
      plain: () => 'what they pay is burned when the draw happens, and refunded instead if it is cancelled',
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
      plain: () => 'after a cancel you switch on a swap that gives what was paid back for each entry',
      build: (s, x) => {
        // A burned payment can't come back; a held one can.
        if (!x.plan.entry || x.plan.burn === 'entry') return false;
        s.pools ??= [];
        for (const cur of x.currencies) {
          const pool = `${x.route}-${cur.token}`.slice(0, 32);
          if (!s.pools.some(p => p.key === pool)) s.pools.push({ key: pool, currency: cur.token, seed: 0 });
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
      plain: () => 'there is no free entry',
      // (a grant the person named for free entries, with no prize yet, goes)
      build: (s, x) => ((s.grants = s.grants.filter(g => g.key !== x.freeKey || g.prize || g.gives)), true),
    },
    {
      id: 'grant-ticket',
      says: 'a grant gives what the draw takes, one a person',
      plain: x =>
        `the free entry is ${x.plan.free?.asset === x.plan.entry ? 'one entry token' : `${x.currencies[0]?.amount ?? ''} ${(x.plan.free?.asset ?? '').toUpperCase()}, which they could also spend`}`,
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
      plain: () => 'free entries go into a second draw with a prize of its own',
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

/** An address that stands in for a list the person builds (the system program's: no wallet). */
const STAND_IN = '11111111111111111111111111111111';
const UP = t => String(t ?? '').toUpperCase();
const perWord = n => (n === 1 ? 'one' : String(n));

/**
 * The families of routes, each with its choices (`dims`: one bridge from each), how a candidate is set up (`init`), which
 * combinations make no sense (`skip`), and how a candidate plays (`experience`).
 */
/** What a reward a server signs needs from the person before its first spec: the numbers and the rule only they have. */
const SERVER_NEEDS = Object.freeze([
  'its caps, each with your pick, before the first spec: the most claims one player makes a day, the most for everyone together a day, and the most in all (the chain counts claims: a cap of N claims is N times the most one claim gives)',
  'what happens to what a player earned and did not claim when a day turns or a voucher runs out: kept for them (until when), or lost; follow the balance your server keeps from the moment it signs',
]);

export const FAMILIES = {
  // ---- a draw (a lottery or a raffle) and how it is paid
  draw: {
    dims: [DRAW_BRIDGES.pay, DRAW_BRIDGES.burn, DRAW_BRIDGES.refund, DRAW_BRIDGES.free],
    init(spec, route, requirements) {
      const pay = requirements.find(r => r.kind === 'pay-in');
      for (const l of spec.lotteries)
        if (l.key === route && l.pot === undefined && l.rest === undefined) l.rest = 'treasury';
      const lottery = spec.lotteries.find(l => l.key === route);
      if (!lottery) return null;
      return {
        route,
        currencies: pay?.currencies ?? [{ token: lottery.currency ?? spec.currency, amount: num(lottery.price) }],
        wantsFree: requirements.some(r => r.kind === 'free-entry'),
        wantsBurn: requirements.some(r => r.kind === 'burn'),
        burnAtEntry: false,
        plan: {
          draw: route,
          draws: [route],
          routes: [route],
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
    },
    skip: ([, b, , f], x) => (!x.wantsFree && f.id !== 'none') || (!x.wantsBurn && b.id !== 'none'),
    prepare: ([, b], x) => {
      x.burnAtEntry = b.id === 'at-entry';
    },
    experience: c => drawExperience(c),
  },

  // ---- a sale of an item: in which currencies, and who gets a scarce one
  sale: {
    dims: [
      [
        {
          id: 'shop',
          says: x => `the shop sells it for ${x.currencies[0].amount} ${UP(x.currencies[0].token)}`,
          plain: x => `players buy it in the shop for ${x.currencies[0].amount} ${UP(x.currencies[0].token)}`,
          build: (s, x) => {
            if (x.currencies.length !== 1 || x.currencies[0].token !== (s.currency ?? 'sol')) return false;
            x.item(s).price = x.currencies[0].amount;
            x.plan.routes = [x.route];
            x.plan.paidWith.add(x.currencies[0].token);
            x.plan.payWords = `the shop takes ${x.currencies[0].amount} ${UP(x.currencies[0].token)}`;
            return true;
          },
        },
        {
          id: 'box-each',
          says: x =>
            `a box for each currency that gives it at a fixed price (${x.currencies.map(c => `${c.amount} ${UP(c.token)}`).join(', ')})`,
          plain: x =>
            `players buy it for ${x.currencies.map(c => `${c.amount} ${UP(c.token)}`).join(' or ')}, each a fixed price in its own listing`,
          build: (s, x) => {
            const it = x.item(s);
            delete it.price;
            x.plan.routes = [];
            for (const cur of x.currencies) {
              const key = `${x.route}-${cur.token}`.slice(0, 32);
              s.boxes.push({
                key,
                name: `${it.name ?? x.route} for ${UP(cur.token)}`,
                price: cur.amount,
                currency: cur.token,
                outcomes: [{ gives: 'item', item: x.route, weight: 1 }],
              });
              x.plan.routes.push(key);
              x.plan.paidWith.add(cur.token);
            }
            x.plan.payWords = `a fixed-price listing in each of ${x.currencies.length} currencies`;
            return true;
          },
        },
      ],
      [
        {
          id: 'first-come',
          says: x => `first come, first served, ${perWord(x.per)} a wallet`,
          plain: x => `anyone can buy, first come first served, ${perWord(x.per)} a wallet`,
          build: (s, x) => {
            for (const p of x.parts(s)) p.perWallet = x.per;
            x.plan.fair = 'first-come';
            return true;
          },
        },
        {
          id: 'allowlist',
          says: x => `only wallets on a list you build (one a person) may buy, ${perWord(x.per)} each`,
          plain: x =>
            `only people on your list can buy, ${perWord(x.per)} each (you build the list, one wallet a person)`,
          build: (s, x) => {
            for (const p of x.parts(s)) {
              p.perWallet = x.per;
              p.gate = { list: x.list.length ? x.list : [STAND_IN] };
            }
            if (!x.list.length)
              x.plan.needs = [
                'the allowlist: a stand-in address fills it here; put in the real wallets, one a person, before going live',
              ];
            x.plan.fair = 'allowlist';
            return true;
          },
        },
      ],
    ],
    init(spec, route, requirements) {
      const it = spec.items.find(i => i.key === route);
      if (!it) return null;
      const pay = requirements.find(r => r.kind === 'pay-in');
      const fair = requirements.find(r => r.kind === 'fair-scarce');
      return {
        route,
        currencies: pay?.currencies ?? [{ token: spec.currency ?? 'sol', amount: num(it.price) }],
        per: fair?.perPerson ?? it.perWallet ?? 1,
        list: fair?.list ?? [],
        item: s => s.items.find(i => i.key === route),
        parts: s =>
          s.boxes.some(b => b.key.startsWith(`${route}-`))
            ? s.boxes.filter(b => b.key.startsWith(`${route}-`))
            : [s.items.find(i => i.key === route)],
        plan: { routes: [route], paidWith: new Set() },
      };
    },
    experience: c => {
      const r = c.fl.routes.find(x => c.plan.routes.includes(x.key));
      return { approvals: r ? journeyOf(r, c.fl).prompts : 1, tokens: 0, waits: 0 };
    },
  },

  // ---- a reward: what proves a claim, and what caps it
  // (what only the person has, for a reward a server signs: asked with the design, before the first spec, where a
  // builder puts its questions; the checker asks again for whatever a spec then leaves unsaid)
  reward: {
    dims: [
      [
        {
          id: 'open',
          says: 'anyone may claim, with nothing but its limits',
          plain: () => 'anyone can claim it, no server needed',
          build: (s, x) => {
            // No server signs for it: nothing to say it checks ("trust" is a voucher server's).
            const g = x.grant(s);
            delete g.vouchers;
            delete g.list;
            delete g.trust;
            x.plan.proof = 'open';
            return true;
          },
        },
        {
          id: 'list',
          says: 'only wallets on a list you build may claim',
          plain: () => 'only people on your list can claim it (you build the list, one wallet a person)',
          build: (s, x) => {
            const g = x.grant(s);
            delete g.vouchers;
            delete g.trust;
            g.list = x.list.length ? x.list : [STAND_IN];
            if (!x.list.length)
              x.plan.needs = [
                'the list of wallets: a stand-in address fills it here; put in the real ones, one a person, before going live',
              ];
            x.plan.proof = 'list';
            return true;
          },
        },
        {
          id: 'voucher-bounds',
          says: 'your server signs a voucher for each claim, checking the page’s report within a pace and caps',
          plain: () => 'your server signs each claim, taking the page’s word within its caps',
          build: (s, x) =>
            x.keys.length
              ? (Object.assign(x.grant(s), { vouchers: x.keys, trust: 'bounds' }),
                delete x.grant(s).list,
                (x.plan.proof = 'bounds'),
                (x.plan.needs = SERVER_NEEDS),
                true)
              : false,
        },
        {
          id: 'voucher-decides',
          says: 'your server signs a voucher only for what it ran itself (it decides the result)',
          plain: () => 'your server signs each claim for what it ran itself',
          build: (s, x) =>
            x.keys.length
              ? (Object.assign(x.grant(s), { vouchers: x.keys, trust: 'decides' }),
                delete x.grant(s).list,
                (x.plan.proof = 'decides'),
                (x.plan.needs = SERVER_NEEDS),
                true)
              : false,
        },
      ],
      [
        {
          id: 'per-wallet',
          says: x => `${perWord(x.per)} claim a wallet`,
          plain: x => `${perWord(x.per)} claim a wallet`,
          build: (s, x) => ((x.grant(s).limits = { ...x.limits(s), perWallet: x.per }), (x.plan.cap = 'wallet'), true),
        },
        {
          id: 'per-person',
          says: x => `${perWord(x.per)} claim a person (the server names an X account in each voucher)`,
          plain: x => `${perWord(x.per)} claim a person, counted by the account your server names`,
          build: (s, x) => {
            if (!['bounds', 'decides'].includes(x.plan.proof)) return false;
            x.grant(s).limits = { ...x.limits(s), perPerson: x.per, perWallet: x.per };
            x.plan.cap = 'person';
            return true;
          },
        },
        {
          id: 'daily',
          says: x => `${perWord(x.per)} claim a wallet a day`,
          plain: x => `${perWord(x.per)} claim a wallet each day`,
          build: (s, x) => (
            (x.grant(s).limits = { ...x.limits(s), perWalletEach: { count: x.per, every: '1d' } }),
            (x.plan.cap = 'daily'),
            true
          ),
        },
      ],
    ],
    init(spec, route, requirements) {
      const g = spec.grants.find(q => q.key === route);
      if (!g) return null;
      const bounded = requirements.find(r => r.kind === 'bounded');
      const person = requirements.find(r => r.kind === 'per-person');
      const keys = requirements.find(r => r.serverKeys)?.serverKeys ?? g.vouchers ?? [];
      return {
        route,
        keys,
        per: person?.claims ?? 1,
        list: requirements.find(r => r.list)?.list ?? [],
        grant: s => s.grants.find(q => q.key === route),
        limits: s => ({
          ...(s.grants.find(q => q.key === route).limits ?? {}),
          ...(bounded ? { total: bounded.total } : {}),
        }),
        plan: { routes: [route] },
      };
    },
    experience: () => ({ approvals: 1, tokens: 0, waits: 0 }),
  },

  // ---- staking: how a seat is paid, for how long, and whether a stake is locked
  earn: {
    dims: [
      [
        {
          id: 'fixed-minted',
          says: x => `each unit staked earns ${x.perDay} a day, minted`,
          plain: x => `each one staked earns ${x.perDay} a day`,
          build: (s, x) => ((x.farm(s).rate = { perDay: x.perDay, minted: true }), (x.plan.payout = 'fixed'), true),
        },
        {
          id: 'shared-minted',
          says: x => `${x.pie} a day for the whole farm, shared by stake, minted`,
          plain: x => `the farm pays ${x.pie} a day in all, split by how much each has staked`,
          build: (s, x) => (
            (x.farm(s).rate = { perDay: x.pie, shared: true, minted: true }),
            (x.plan.payout = 'shared'),
            true
          ),
        },
        {
          id: 'vault',
          says: x => `a vault of ${x.budget} shared by stake as it is paid out, nothing minted`,
          plain: x => `the farm shares a fixed ${x.budget} by stake, and pays nothing more once it is gone`,
          build: (s, x) => {
            const f = x.farm(s);
            delete f.rate;
            f.seed = x.budget;
            x.plan.payout = 'vault';
            return true;
          },
        },
      ],
      [
        { id: 'none', says: 'no end', plain: () => '', build: (s, x) => ((x.plan.end = null), true) },
        {
          id: 'runs',
          says: x => `it ends after ${x.days} days`,
          plain: x => `it runs for ${x.days} days`,
          build: (s, x) => ((x.farm(s).runs = `${x.days}d`), (x.plan.end = 'runs'), true),
        },
        {
          id: 'halving',
          says: x => `its rate halves every ${Math.max(1, Math.round(x.days / 3))} days`,
          plain: x => `its rate halves every ${Math.max(1, Math.round(x.days / 3))} days`,
          build: (s, x) => {
            const f = x.farm(s);
            if (!f.rate) return false;
            f.rate.halveEvery = `${Math.max(1, Math.round(x.days / 3))}d`;
            x.plan.end = 'halving';
            return true;
          },
        },
      ],
      [
        {
          id: 'unlocked',
          says: 'a stake can leave at any time',
          plain: () => 'a stake can leave any time',
          build: (s, x) => ((x.farm(s).tiers = [{ lock: 0, multiplier: 1 }]), (x.plan.lock = null), true),
        },
        {
          id: 'locked',
          says: x => `a stake is locked for ${x.lock}`,
          plain: x => `a stake is locked for ${x.lock}`,
          build: (s, x) => ((x.farm(s).tiers = [{ lock: x.lock, multiplier: 1 }]), (x.plan.lock = x.lock), true),
        },
      ],
    ],
    init(spec, route, requirements) {
      const f = spec.farms.find(q => q.key === route);
      if (!f) return null;
      const cap = requirements.find(r => r.kind === 'emission-cap');
      const days = requirements.find(r => r.days)?.days ?? 90;
      const perDay = requirements.find(r => r.perDay)?.perDay ?? f.rate?.perDay ?? 1;
      const budget = cap?.total ?? perDay * days * 10;
      return {
        route,
        perDay,
        days,
        budget,
        // (the whole farm's rate a day, rounded down to what its reward token's decimals hold)
        pie: (() => {
          const d = spec.tokens.find(t => t.key === f.rewards)?.decimals ?? 0;
          return Math.floor((budget / days) * 10 ** d) / 10 ** d;
        })(),
        lock: requirements.find(r => r.kind === 'locked')?.lock ?? '7d',
        farm: s => s.farms.find(q => q.key === route),
        plan: { routes: [route] },
      };
    },
    experience: c => ({ approvals: 1, tokens: 0, waits: c.plan.lock ? 1 : 0 }),
  },

  // ---- a contest: who names the result, and what an entry puts in
  contest: {
    dims: [
      [
        {
          id: 'authority',
          says: 'the project’s authority names the result',
          plain: () => 'you name the result with the project’s key',
          build: (s, x) => (delete x.contest(s).deciders, (x.plan.decider = 'authority'), true),
        },
        {
          id: 'decider-key',
          says: 'a decider key that signs only verdicts names the result; anyone sends it',
          plain: () => 'a key that can only sign results names the winner',
          build: (s, x) =>
            x.keys.length ? ((x.contest(s).deciders = x.keys.slice(0, 3)), (x.plan.decider = 'decider'), true) : false,
        },
      ],
      [
        {
          id: 'any-stake',
          says: 'each entry puts in what it likes',
          plain: () => 'each player puts in what they like',
          build: (s, x) => (delete x.contest(s).stake, (x.plan.stake = null), true),
        },
        {
          id: 'equal',
          says: x => `every entry puts in exactly ${x.stake}`,
          plain: x => `everyone puts in exactly ${x.stake}`,
          build: (s, x) => ((x.contest(s).stake = x.stake), (x.plan.stake = x.stake), true),
        },
      ],
    ],
    init(spec, route, requirements) {
      const c = spec.contests.find(q => q.key === route);
      if (!c) return null;
      return {
        route,
        keys: requirements.find(r => r.serverKeys)?.serverKeys ?? c.deciders ?? [],
        stake: requirements.find(r => r.kind === 'equal-stakes')?.amount ?? c.stake ?? 1,
        contest: s => s.contests.find(q => q.key === route),
        plan: { routes: [route] },
      };
    },
    experience: () => ({ approvals: 1, tokens: 0, waits: 0 }),
  },
};

/** How a draw candidate plays: the approvals to enter it, and the tokens of its own a player must learn. */
function drawExperience(c) {
  const draw = c.fl.routes.find(x => x.key === c.plan.draw);
  const j = draw ? journeyOf(draw, c.fl) : null;
  const crafts = j ? j.steps.length - (draw.kind === 'lottery' ? 2 : 1) : 0;
  return {
    approvals: 1 + (crafts > 0 && !j?.bundles.length ? crafts : 0),
    tokens: [c.plan.entry, c.plan.freeDraw ? c.plan.free?.asset : null].filter(Boolean).length,
  };
}

/** The family a route belongs to, by where its key is in the spec (or a requirement's own "family"). */
function familyOf(spec, route, requirements) {
  const said = requirements.find(r => r.route === route && r.family)?.family;
  if (said) return said;
  if ((spec.lotteries ?? []).some(x => x.key === route)) return 'draw';
  if ((spec.items ?? []).some(x => x.key === route)) return 'sale';
  if ((spec.grants ?? []).some(x => x.key === route)) return 'reward';
  if ((spec.farms ?? []).some(x => x.key === route)) return 'earn';
  if ((spec.contests ?? []).some(x => x.key === route)) return 'contest';
  return null;
}

/** Every combination of a family's choices, one from each. */
function* combos(dims, at = 0, picked = []) {
  if (at === dims.length) yield picked;
  else for (const b of dims[at]) yield* combos(dims, at + 1, [...picked, b]);
}

/**
 * Every spec the family's bridges build for one route under its requirements, checked and tested, best first:
 * { route, family, candidates, conflicts, inPart, allKept }.
 */
function searchRoute(base, route, family, requirements, now) {
  const fam = FAMILIES[family];
  const candidates = [];
  for (const picked of combos(fam.dims)) {
    const spec = clone(base);
    for (const k of ['tokens', 'recipes', 'grants', 'boxes', 'pools', 'lotteries', 'farms', 'contests', 'items'])
      spec[k] ??= [];
    // SOL is every economy's to take: a want that names it declares it.
    for (const r of requirements)
      for (const c of r.currencies ?? [])
        if (c.token === 'sol' && !spec.tokens.some(t => t.key === 'sol'))
          spec.tokens.push({ key: 'sol', source: 'sol' });
    const x = fam.init(spec, route, requirements);
    if (!x) return { route, family, candidates: [], conflicts: [], inPart: [], allKept: false };
    if (fam.skip?.(picked, x)) continue;
    fam.prepare?.(picked, x);
    if (!picked.every(step => step.build(spec, x) !== false)) continue;
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
    const c = { spec, m, fl, verdict, plan: x.plan, x };
    const results = requirements.map(q => ({
      kind: q.kind,
      says: REQUIREMENTS[q.kind].says(q),
      ...REQUIREMENTS[q.kind].test(c, q),
    }));
    const lens = verdict.warnings.filter(w => w.severity);
    candidates.push({
      bridges: picked.map(b => b.id),
      says: picked
        .filter(b => !['none', 'as-is'].includes(b.id))
        .map(b => (typeof b.says === 'function' ? b.says(x) : b.says)),
      kept: results.filter(q => q.kept === true).length,
      partly: results.filter(q => q.kept === 'partly').length,
      broken: results.filter(q => q.kept === false).map(q => q.kind),
      results,
      findings: {
        high: lens.filter(w => w.severity === 'high').length,
        medium: lens.filter(w => w.severity === 'medium').length,
      },
      parts: ['lotteries', 'recipes', 'grants', 'boxes', 'pools', 'farms', 'contests'].reduce(
        (n, k) => n + (spec[k]?.length ?? 0),
        0,
      ),
      experience: fam.experience(c),
      plain: picked.map(step => step.plain?.(x)).filter(Boolean),
      needs: x.plan.needs ?? [],
      fl,
      plan: x.plan,
      spec,
    });
  }
  // Best first: what the person asked for, then how it plays (approvals, waits, tokens a player must learn), then how
  // clean it is (fewer parts), then the findings (the owner's order: plays best, cleaner, more secure).
  const score = c =>
    (c.kept + c.partly / 2) * 100 -
    (c.experience.approvals - 1) * 10 -
    (c.experience.waits ?? 0) * 8 -
    c.experience.tokens * 5 -
    c.parts -
    c.findings.high * 0.5 -
    c.findings.medium * 0.1;
  candidates.sort((a, b) => score(b) - score(a));
  // What can't hold together: the smallest sets of requirements the candidates give up (partly kept counts as given up).
  const key = c =>
    c.results
      .filter(q => q.kept !== true)
      .map(q => q.kind)
      .sort()
      .join('+');
  const all = candidates.some(c => c.results.every(q => q.kept === true));
  const sets = [...new Set(candidates.map(key))].map(k => k.split('+').filter(Boolean));
  const minimal = all ? [] : sets.filter(a => !sets.some(b => b.length < a.length && b.every(k => a.includes(k))));
  const conflicts = minimal
    .sort((a, b) => a.length - b.length)
    .map(kinds => ({ giveUp: kinds, best: candidates.find(c => key(c) === [...kinds].sort().join('+')) }));
  // A design that gives nothing up entirely, keeping some wants only in part, is an option of its own.
  const inPart = [];
  for (const c of all ? [] : candidates.filter(c => !c.results.some(q => q.kept === false))) {
    const partial = c.results
      .filter(q => q.kept === 'partly')
      .map(q => q.kind)
      .sort()
      .join('+');
    if (!inPart.some(y => y.partial === partial)) inPart.push({ partial, best: c });
  }
  return { route, family, candidates, conflicts, allKept: all, inPart };
}

/**
 * The designs for every route the requirements name, each route searched in turn on the best design of the ones
 * before it: { routes: [{ route, family, candidates, conflicts, inPart, allKept }], …the first route's result }.
 * Requirements name their route (`route`); its family follows from where that key is in the spec (a lottery: a draw;
 * an item: a sale; a grant: a reward; a farm: staking; a contest), or from a requirement's own `family`.
 */
export function design(base, requirements, { now = Math.floor(Date.now() / 1000) } = {}) {
  const first = requirements.find(r => r.route)?.route ?? base.lotteries?.[0]?.key;
  const order = [...new Set(requirements.map(r => r.route ?? first))];
  const routes = [];
  let spec = base;
  for (const route of order) {
    const family = familyOf(spec, route, requirements);
    const reqs = requirements.filter(r => (r.route ?? first) === route);
    if (!family) {
      routes.push({ route, family: null, candidates: [], conflicts: [], inPart: [], allKept: false, unknown: true });
      continue;
    }
    const result = searchRoute(spec, route, family, reqs, now);
    routes.push(result);
    if (result.candidates[0]) spec = result.candidates[0].spec;
  }
  return { ...routes[0], routes };
}

/** One sentence for the person, to pass on as written: what players see, then what it gives up. */
function sayIt(c) {
  const gave = c.results.filter(q => q.kept !== true);
  const what = c.plain.join('; ');
  return `“${what.charAt(0).toUpperCase()}${what.slice(1)}.${gave.length ? ` The catch: ${gave.map(q => q.why).join('; ')}.` : ''}”`;
}

/** The design in words, for the agent to read and put to the person: the requirements, the conflicts, the top specs. */
const FAMILY_WORDS = { draw: 'a draw', sale: 'a sale', reward: 'a reward', earn: 'staking', contest: 'a contest' };

/** The design in words, for every route the requirements name: one section a route. */
export function describeDesign(result, requirements, { top = 3 } = {}) {
  const routes = result.routes ?? [result];
  const first = requirements.find(r => r.route)?.route;
  if (routes.length === 1 && !routes[0].unknown) return describeRoute(routes[0], requirements, { top });
  const parts = routes.map(r => {
    const reqs = requirements.filter(q => (q.route ?? first) === r.route);
    if (r.unknown)
      return `For “${r.route}”: no family covers it yet (a draw: a lottery's key; a sale: an item's; a reward: a grant's; staking: a farm's; a contest's). Draft it by hand and check it.`;
    return `For “${r.route}” (${FAMILY_WORDS[r.family]}):\n${describeRoute(r, reqs, { top, last: false })}`;
  });
  const any = routes.some(r => !r.allKept && !r.unknown);
  return `${parts.join('\n\n')}${any ? '\n\nPut these options to the person, each with its “Say” sentence as written and your pick, and end your turn there: build none until they choose.' : ''}`;
}

/** One route's designs in words: the requirements, the conflicts, the top designs. */
function describeRoute(result, requirements, { top = 3, last = true } = {}) {
  const lines = ['What the person wants, as requirements (read these back to them):'];
  for (const r of requirements) lines.push(`- ${REQUIREMENTS[r.kind].says(r)}`);
  if (!result.candidates.length)
    return `${lines.join('\n')}\n\nNo design checks: none of the known ways builds this on the spec as it is (the tokens it names, the item, grant, farm, lottery or contest it is for). Fix the spec and run it again, or draft it by hand.`;
  if (result.allKept) lines.push('', 'A design keeps every one of them:');
  else {
    lines.push(
      '',
      'No design keeps all of them. This is the person’s choice, not yours: put every option below to them, each with what it gives up and costs, and your pick; build none of them until they choose.',
      '',
      'What has to give, and the best design for each choice:',
    );
    for (const { best } of result.inPart.slice(0, 2))
      lines.push(
        `- Keep every want, some only in part (${best.results
          .filter(q => q.kept === 'partly')
          .map(q => `“${q.says.replace(/\.$/, '')}”: ${q.why}`)
          .join('; ')}): ${best.says.join('; ')}.\n  Say: ${sayIt(best)}`,
      );
    for (const c of result.conflicts.filter(x => !result.inPart.some(y => y.best === x.best)).slice(0, top)) {
      const gave = c.best.results.filter(q => q.kept !== true);
      lines.push(
        `- Give up ${gave.map(q => `“${q.says.replace(/\.$/, '')}”${q.kept === 'partly' ? ' in part' : ''} (${q.why})`).join(' and ')}: ${c.best.says.join('; ')}.\n  Say: ${sayIt(c.best)}`,
      );
    }
    lines.push(
      '',
      'The designs, best first (what the person asked for, then what plays best, then the cleanest, then the most secure):',
    );
  }
  result.candidates.slice(0, top).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.says.join('; ')}.`, `   Say: ${sayIt(c)}`);
    for (const q of c.results)
      lines.push(`   ${q.kept === true ? '✓' : q.kept === 'partly' ? '~' : '✗'} ${q.says} ${q.why}.`);
    // After the draw: every step someone must send, who, and what happens if nobody does.
    const after = c.fl.routes
      .filter(r => (c.plan.draws ?? c.plan.routes ?? []).includes(r.key))
      .flatMap(r => r.states.flatMap(st => st.steps))
      .filter(x => x.per)
      .map(x => `${x.short} (${x.by === 'keys' ? 'the project' : x.by}, ${x.per}; if nobody does, ${x.ifNobody})`);
    if (c.plan.held)
      after.push(
        'the held payments burned after the draw (the owner, once a draw; if nobody does, they stay in their pools)',
      );
    if (c.plan.swapBack)
      after.push('the way back switched on after a cancel (the owner; if nobody does, a refund stays in entries)');
    if (after.length)
      lines.push(`   After ${c.plan.draw ? 'the draw' : 'it ends'}: ${[...new Set(after)].join('; ')}.`);
    if (c.needs.length) lines.push(`   Needs from you: ${c.needs.join('; ')}.`);
    lines.push(
      `   Plays: ${c.experience.approvals} approval${c.experience.approvals === 1 ? '' : 's'}; ${c.experience.tokens ? `${c.experience.tokens} token${c.experience.tokens === 1 ? '' : 's'} of its own to learn` : 'nothing new to learn'}${c.experience.waits ? '; a wait (a lock)' : ''}. Findings: ${c.findings.high} high, ${c.findings.medium} medium (xsolana_check on its spec gives each).`,
    );
  });
  if (!result.allKept && last)
    lines.push(
      '',
      'Put these options to the person, each with its “Say” sentence as written and your pick, and end your turn there: build none until they choose.',
    );
  return lines.join('\n');
}
