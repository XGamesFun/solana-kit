// The walk-through at the end of `xsolana explain` and the review, and the end states `xsolana_check` shows: each route
// of the spec, state by state (before it opens, while it runs, cancelled or failed, won, after it ends, a change of
// mind), as a player, the owner and a cheater see it, and what can change only before its first sale or claim. The
// routes the model holds (flows.mjs) are written from its steps (who sends each, who pays, what moves, what happens if
// nobody does); the others in words that follow the program's rules (PROGRAM.md).
import { at, flows, named, num, ORACLE_SOL, words } from './flows.mjs';
import { FEES, prizeLine, prizeWords, toSeconds, toTime } from './model.mjs';

const STATE = {
  open: 'Before it opens',
  run: 'While it runs',
  cancel: 'Cancelled or failed',
  win: 'Won',
  after: 'After it ends',
  undo: 'A change of mind',
};
const WHO = {
  player: 'Player',
  winner: 'Player',
  keys: 'Owner',
  server: 'The results server',
  anyone: 'Anyone',
  oracle: 'The oracle',
};

/** One state's steps in words: each actor once, their steps in order, what happens if nobody sends one. */
function stepWords(steps) {
  if (steps.length === 1 && /^[A-Z“]/.test(steps[0].says)) return steps[0].says;
  const parts = [];
  for (const s of steps) {
    const text = `${s.says}${s.ifNobody ? ` (if nobody does: ${s.ifNobody})` : ''}`;
    const last = parts.at(-1);
    if (last && last.who === s.by) last.texts.push(text);
    else parts.push({ who: s.by, texts: [text] });
  }
  return parts.map(p => `${WHO[p.who] ?? p.who}: ${p.texts.join('; then ')}.`).join(' ');
}

/** The end states of the routes the model holds, in short: what a cancel, a change of mind and the end leave a player. */
export function endStates(m, { now, fl = flows(m, { now }) }) {
  // A cancel where a route can be cancelled or its roll can wait; a change of mind where something turns it back.
  const shown = (r, state) =>
    state === 'cancel'
      ? Boolean(r.cancel) || (r.roll && r.kind !== 'recipe')
      : Boolean(extraWords(r, state, fl)) || r.backs?.length > 0;
  return fl.routes
    .filter(r => r.price.length)
    .flatMap(r =>
      ['cancel', 'undo']
        .map(state => [state, r.states.find(x => x.state === state)])
        .filter(([state, st]) => st && shown(r, state))
        .map(
          ([state, st]) =>
            `${named(r)}, ${STATE[state].toLowerCase()}: ${stepWords(st.steps)}${extraWords(r, state, fl)}`,
        )
        .concat(
          r.endings
            ? [`${named(r)}, every way it ends: ${r.endings.map(e => `${e.ending}: ${e.then}`).join('. ')}.`]
            : [],
        ),
    );
}

/** What the model adds to a state beyond its steps: what a refund is worth against what was paid, the way back. */
function extraWords(r, state, fl) {
  const sym = key => fl.assets.get(key)?.symbol ?? key;
  const on = x => x?.active !== false;
  const backs = asset => {
    const b = fl.assets.get(asset)?.backs ?? [];
    if (!b.length) return '';
    return b.some(x => on(x.recipe))
      ? ` ${words(b.filter(x => on(x.recipe)).map(x => named(x.recipe)))} turns it back (open now).`
      : ` ${words(b.map(x => named(x.recipe)))} turns it back once the project switches it on.`;
  };
  if (state === 'cancel' && r.cancel) {
    const asset = r.cancel.refund[0]?.asset;
    const a = fl.assets.get(asset);
    if (a && !a.money && a.origins.length)
      return ` What was paid for the ${a.symbol} does not come back with it:${backs(asset) || ` nothing turns ${a.symbol} back.`}`;
  }
  if (state === 'undo' && r.kind === 'lottery') {
    const asset = r.price[0]?.asset;
    const text = backs(asset);
    return text ? ` For ${sym(asset)} not yet spent on tickets:${text}` : '';
  }
  return '';
}

/** The walk-through, as lines: a title, then for each route its name and one line a state. [] for a spec with no route. */
export function walkThrough(m, { now, fl = flows(m, { now }) }) {
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const on = x => x.active !== false;
  const windowWords = (x, what, none) =>
    !on(x)
      ? `It is switched off ("active": false): ${none} until the project switches it on.`
      : x.opens !== undefined
        ? `${none[0].toUpperCase()}${none.slice(1)} before ${at(toTime(x.opens, now))}.`
        : `It ${what} from the moment it is live.`;
  const perWalletWords = x =>
    x.perWallet ? ` (at most ${x.perWallet} a wallet: a wallet is free, so it counts wallets, not people)` : '';
  const routes = [];
  const route = (title, rows) =>
    routes.push(title, ...rows.filter(([, text]) => text).map(([s, text]) => `  - ${s}: ${text}`));

  // ---- the routes the model holds, from their steps
  const OPEN = {
    box: ['sells', 'nothing is sold'],
    item: ['sells', 'nothing is sold'],
    recipe: ['crafts', 'nothing is crafted'],
    grant: ['takes claims', 'no claim is taken'],
    contest: ['takes entries', 'no entry is taken'],
  };
  for (const r of fl.routes) {
    const rows = [];
    const open = r.states.find(s => s.state === 'open');
    rows.push([
      STATE.open,
      open
        ? stepWords(open.steps)
        : windowWords(r.kind === 'grant' ? { ...r.part, opens: r.part.limits?.opens } : r.part, ...OPEN[r.kind]),
    ]);
    for (const st of r.states.filter(s => s.state !== 'open')) {
      let text = stepWords(st.steps) + extraWords(r, st.state, fl);
      if (st.state === 'run') {
        const cheat = st.cheater
          ? [st.cheater]
          : [
              r.kind === 'lottery'
                ? 'many wallets buy many tickets'
                : r.kind === 'recipe'
                  ? 'crafts as often as they hold what it takes'
                  : '',
              r.roll && r.kind !== 'recipe' ? 'nobody sees or picks the result, drawn from the oracle’s answer' : '',
              r.limited ? 'bots can buy limited stock first' : '',
            ].filter(Boolean);
        text += `${perWalletWords(r)}${cheat.length ? ` Cheater: ${cheat.join('; ')}.` : ' Cheater: nothing to take: it sells at its price.'}`;
      }
      if (st.state === 'cancel' && r.cancel) text += ' Cheater: nothing to gain: a refund goes only to its own buyer.';
      rows.push([STATE[st.state], text]);
    }
    // After its deadline: every step someone must send, who, who pays, how often, and what happens if nobody does.
    const later = r.states.flatMap(st => st.steps).filter(x => x.per);
    if (later.length)
      rows.push([
        'Who sends what',
        `${later.map(x => `${x.short[0].toUpperCase()}${x.short.slice(1)}: ${WHO[x.by] === 'Owner' ? 'the project' : (WHO[x.by] ?? x.by).toLowerCase()}${x.pays === 'sender' ? ', paying its fee' : ''}, ${x.per}; if nobody does, ${x.ifNobody}`).join('. ')}.`,
      ]);
    if (r.endings) rows.push(['Every way it ends', `${r.endings.map(e => `${e.ending}: ${e.then}`).join('. ')}.`]);
    if (r.fixed) rows.push([`Only before ${r.fixed.when}`, r.fixed.says]);
    route(`${named(r)}: ${r.title}`, rows);
  }

  // ---- the other routes, in words
  for (const a of m.auctions) {
    route(`${named(a)}: an auction`, [
      [
        'Before it opens',
        a.start !== undefined ? `No bid before ${at(toTime(a.start, now))}.` : 'Bids from the moment it opens.',
      ],
      [
        'While it runs',
        `Player: bids at least ${num(a.reserve) || 1} ${sym(a.currency ?? m.currencyKey)}; a higher bid sends theirs back in the same instruction. Owner: nothing to send; its terms are fixed when it opens. Cheater: anyone, the seller included, can bid to push the price${a.extendBy ? `; a bid in the last ${a.extendBy} moves the end` : ''}.`,
      ],
      [
        'Cancelled or failed',
        'With no bid it ends unsold and the lot goes home. The owner or authority may call off a sale whose lot has not moved: the bid back, the lot home.',
      ],
      ['Won', 'Anyone ends it after its end: the lot to the high bidder, the bid to the seller and the shares.'],
      ['A change of mind', 'A bid can’t be taken back: only a higher bid returns it before the end.'],
      ['Only before the first bid', 'Every term is fixed when it opens.'],
    ]);
  }

  for (const f of m.farms) {
    route(`${named(f)}: a farm`, [
      [
        'While it runs',
        `Player: stakes ${f.stakes === 'collectibles' ? 'NFTs' : sym(f.stakes ?? m.currencyKey)} and earns while staked, by tier. Owner: ${f.rate ? 'its rate pays from its rewards' : 'its stakers share what arrives in its rewards vault: nothing arrives, nothing is paid'}. Cheater: ${f.custody === 'watch' ? 'a watched NFT sold keeps earning until someone refreshes its seat' : 'many wallets stake as one: rewards follow the stake, not the person'}.`,
      ],
      [
        'After it ends',
        f.runs
          ? `It takes no stake after its end (${f.runs}); seats keep what they earned.`
          : 'It has no end: it runs until it is closed.',
      ],
      ['A change of mind', 'A stake leaves once its tier’s lock has run (earlier only where a tier sets an exit fee).'],
      ['Only before it opens', 'A farm is never edited once open: a change is a new farm.'],
    ]);
  }

  for (const s of m.schedules)
    route(`${named(s)}: a schedule`, [
      [
        'While it runs',
        s.sealed
          ? 'Its recipient sends each run when it is due; nobody can stop it.'
          : 'Owner: you, or a key of the project’s, sends each run when it is due: nothing runs it otherwise, and a missed run lapses. Player: nothing to do. Cheater: nothing: only the project’s keys send it.',
      ],
    ]);

  for (const p of m.payments)
    route(`${named(p)}: a payment`, [
      [
        'While it runs',
        `Player: pays ${p.any ? 'what they choose' : `${num(p.amount)} ${sym(p.currency ?? m.currencyKey)}`}. Owner: what it pays for is yours to deliver from its receipt.`,
      ],
      ['A change of mind', 'No refund: the program keeps no record to undo.'],
    ]);

  for (const h of m.holds)
    route(`${named(h)}: a hold`, [
      [
        'While it runs',
        'Player: hands an NFT to the project until the time they chose. Owner: until then the authority may release it, to any wallet. Cheater: whoever holds the authority’s key could release it elsewhere before its time: a hold trusts the project.',
      ],
      ['After it ends', 'Anyone sends it home once its time is up.'],
    ]);

  if (!routes.length) return [];
  const actions = actionWords(fl);
  const times = timeline(m, fl, now);
  return [
    ...(actions.length ? ['Each player action: its wallet prompts and SOL', ...actions.map(x => `- ${x}`), ''] : []),
    ...(times.length
      ? ['Every date, in order (from going live now)', ...times.map(x => `- ${x.when}: ${x.what}`), '']
      : []),
    'Each route, state by state (as a player, the owner and a cheater see it)',
    'The owner’s pause stops every purchase, ticket, entry, stake and bid coming in; nothing owed waits on it: claims, refunds, unstakes, draws and payouts go on.',
    ...routes,
  ];
}

/** Each player action of the routes the model holds: its wallet prompts and the SOL it costs, its price aside. */
export function actionWords(fl) {
  const fee = Number(FEES.player) / 1e9;
  return fl.routes
    .filter(r => r.price.length)
    .map(r => {
      const run = r.states.find(st => st.state === 'run');
      const prompts = (run?.steps ?? []).filter(x => x.by === 'player').length || 1;
      const oracle = r.roll && r.kind === 'box' ? ORACLE_SOL : 0;
      const sol = +(prompts * fee + oracle).toFixed(9);
      const price = r.price
        .map(p => `${+num(p.amount).toFixed(9)} ${fl.assets.get(p.asset)?.symbol ?? p.asset}`)
        .join(' and ');
      const loop = journeyOf(r, fl);
      return `${named(r)}: ${prompts} wallet prompt${prompts === 1 ? '' : 's'}${prompts > 1 && r.kind === 'lottery' ? ' (1 with buyTickets’ make)' : ''}; ${price} plus about ${sol} SOL (the player fee each time${oracle ? ', the oracle' : ''}), plus a network fee and any account it opens. A whole loop: ${loop.steps.join(', then ')} (${loop.prompts} prompt${loop.prompts === 1 ? '' : 's'}).`;
    });
}

/** Every dated moment of the spec, in order: [{ at, when, what }] (a contest's, counted from when it opens, last). */
export function timeline(m, fl, now) {
  const rows = [];
  const add = (seconds, what) => seconds && rows.push({ at: seconds, when: at(seconds), what });
  for (const r of fl.routes) {
    add(r.opens, `${named(r)} opens`);
    add(r.closes, `${named(r)} closes`);
    if (r.ends) add(r.ends, r.kind === 'lottery' ? `${named(r)} draws` : `${named(r)} ends`);
  }
  for (const f of m.farms) if (f.runs) add(now + toSeconds(f.runs), `${named(f)} takes no more stake`);
  rows.sort((a, b) => a.at - b.at);
  for (const c of m.contests)
    rows.push({
      at: Infinity,
      when: `${c.entriesClose ?? '?'} and ${c.resultDue ?? '?'} after it opens`,
      what: `${named(c)}: entries close, then the result is due`,
    });
  return rows;
}

/**
 * A player's whole loop through route `r`: getting what it costs, buying, and collecting what it gives: { steps, prompts,
 * bundles }. Each step is one wallet prompt; `bundles` are the ways the tools can fold steps together.
 */
export function journeyOf(r, fl) {
  const asset = r.price[0]?.asset;
  const a = fl.assets.get(asset);
  const steps = [];
  const bundles = [];
  if (a && !a.money) {
    const craft = a.origins.find(o => o.recipe.active !== false);
    if (craft) {
      // What a player holds who stops after this step: what turns it back, or nothing.
      const back = a.backs.find(b => b.recipe.active !== false);
      steps.push(
        `craft ${a.symbol} with ${named(craft.recipe)} (stopping there leaves ${a.symbol}${back ? `, which ${named(back.recipe)} turns back` : ', which nothing turns back'})`,
      );
    } else if (a.free.length) steps.push(`claim ${a.symbol} from ${named(a.free[0])}`);
    if (craft && r.kind === 'lottery' && !(craft.recipe.out ?? []).some(o => o.gives === 'roll')) {
      const per = num(r.price[0].amount) / num(craft.makes || 1);
      bundles.push(
        `the play client's buyTickets("${r.key}", count, { listing, make: { recipe: "${craft.recipe.key}", times: ${per === 1 ? 'count' : `count × ${+per.toFixed(9)}`}, listing } }) crafts and buys with one approval (kit 0.28.7 and later)`,
      );
    }
  }
  steps.push(
    r.kind === 'lottery'
      ? 'buy tickets'
      : r.kind === 'contest'
        ? 'enter a side'
        : r.kind === 'recipe'
          ? 'craft'
          : 'buy',
  );
  if (r.kind === 'box' && r.roll) {
    steps.push('settle the roll once the oracle answers');
    bundles.push(
      'a key of the project’s may settle rolls for players (rule 11), so the player signs only the purchase',
    );
  }
  if (r.kind === 'lottery') steps.push('pull the win (winners only)');
  if (r.kind === 'contest') steps.push('claim the win (winners only)');
  return { steps, prompts: steps.length, bundles };
}

/**
 * What the person must hear, in short final sentences the agent passes on as written: for each route, what a player
 * gets for their money (a fixed price or a chance), how a farm pays over time, a whole loop's approvals, what a cancel
 * refunds, every cap in one unit (an amount per identity per window), and who names a result.
 */
export function tells(m, { now, fl = flows(m, { now }) }) {
  const sym = key => fl.assets.get(key)?.symbol ?? key;
  const out = [];
  const amount = list => list.map(p => `${+num(p.amount).toFixed(9)} ${sym(p.asset)}`).join(' and ');
  for (const r of fl.routes) {
    if ((r.kind === 'item' || r.kind === 'box') && r.price.length)
      out.push(
        r.roll
          ? `${named(r)} is a chance, not a fixed price: ${amount(r.price)} buys one roll, and the oracle picks what it gives.`
          : `${named(r)} is a fixed price, not random: ${amount(r.price)} buys exactly what it says.`,
      );
    if (r.kind === 'lottery') {
      const loop = journeyOf(r, fl);
      out.push(
        `A whole go at ${named(r)} takes ${loop.prompts} wallet approval${loop.prompts === 1 ? '' : 's'}: ${loop.steps.join(', then ')}.`,
      );
      const a = fl.assets.get(r.cancel?.refund[0]?.asset);
      const origin = a && !a.money ? a.origins[0] : null;
      if (origin)
        out.push(
          `If ${named(r)} is cancelled, a ticket's refund is ${a.symbol}, not the ${amount(origin.pays)} it was bought with.`,
        );
      if (r.cancel?.minSold)
        out.push(`${named(r)} draws only if ${r.cancel.minSold} tickets sell; otherwise every ticket is refunded.`);
    }
    if (r.kind === 'contest')
      out.push(
        `${named(r)}'s result is named by ${r.decider === 'authority' ? 'the project' : 'its decider key'}; with no result by its deadline, everyone takes their money back.`,
      );
    if (r.kind === 'grant') {
      const l = r.part.limits ?? {};
      const g = r.gives[0];
      const signed = (r.part.vouchers ?? []).length || r.part.list;
      // Each cap in claims, and in the prize's own amount when it is tokens (a claim gives at most its amount).
      const of = n => (g ? ` (up to ${+(n * g.amount).toFixed(9)} ${sym(g.asset)})` : '');
      const caps = [
        l.perWalletEach
          ? `${l.perWalletEach.count} a wallet every ${l.perWalletEach.every ?? '1d'}${of(l.perWalletEach.count)}`
          : '',
        l.perWallet ? `${l.perWallet} a wallet in all${of(l.perWallet)}` : '',
        l.perPerson ? `${l.perPerson} a person in all${of(l.perPerson)}` : '',
        l.perDay
          ? `${l.perDay} a day for everyone together${of(l.perDay)}, so the first claims of a day can use it up`
          : '',
        l.total ? `${l.total} in all${of(l.total)}` : '',
      ].filter(Boolean);
      const pool = prizeLine(r.part.prize ?? r.part.gives)?.from?.startsWith('pool:')
        ? m.pool.get(prizeLine(r.part.prize ?? r.part.gives).from.slice(5))
        : null;
      const over =
        pool && g && l.total && l.total * g.amount > num(pool.seed)
          ? ` Its total is more than “${pool.key}” starts with (${num(pool.seed)}): claims past that are refused until it is refilled.`
          : '';
      if (caps.length)
        out.push(
          `${named(r)}: each claim gives ${signed && g ? 'up to ' : ''}${prizeWords(r.part.prize ?? r.part.gives, m)}; the caps count claims: ${caps.join('; ')}.${over}`,
        );
    }
  }
  for (const f of m.farms) {
    const locks = (f.tiers ?? []).map(t => t.lock).filter(x => x && toSeconds(x) > 0);
    out.push(
      `${named(f)} pays by the second while staked${f.rate ? (f.rate.shared ? ', sharing its rate by stake' : ' at a fixed rate a seat') : ', sharing what arrives by stake'}: staking just before a payout gains nothing${locks.length ? `, and a stake is locked for ${words([...new Set(locks)])} by its tier` : ', and there is no lock: a stake can leave at any time'}.`,
    );
  }
  return out;
}
