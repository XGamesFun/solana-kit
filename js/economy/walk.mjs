// The walk-through at the end of `xsolana explain` and the review, and the end states `xsolana_check` shows: each route
// of the spec, state by state (before it opens, while it runs, cancelled or failed, won, after it ends, a change of
// mind), as a player, the owner and a cheater see it, and what can change only before its first sale or claim. The
// routes the model holds (flows.mjs) are written from its steps (who sends each, who pays, what moves, what happens if
// nobody does); the others in words that follow the program's rules (PROGRAM.md).
import { at, flows, named, num, ORACLE_SOL, words } from './flows.mjs';
import { realMoney } from '../client/pda.js';
import { FEES, prizeLine, prizeWords, serverRate, toSeconds, toTime } from './model.mjs';

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
    .filter(r => r.price.length || r.endings)
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
            ? [
                `${named(r)}, every way ${r.endsAs ?? 'it'} ends: ${r.endings.map(e => `${e.ending}: ${e.then}`).join('. ')}.`,
              ]
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
    if (r.endings)
      rows.push([`Every way ${r.endsAs ?? 'it'} ends`, `${r.endings.map(e => `${e.ending}: ${e.then}`).join('. ')}.`]);
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
  const control = controlWords(m, fl);
  return [
    ...(actions.length ? ['Each player action: its wallet prompts and SOL', ...actions.map(x => `- ${x}`), ''] : []),
    ...(times.length
      ? ['Every date, in order (from going live now)', ...times.map(x => `- ${x.when}: ${x.what}`), '']
      : []),
    ...(control.length
      ? ['Who controls what: the chain, your server, your owner key', ...control.map(x => `- ${x}`), '']
      : []),
    'Each route, state by state (as a player, the owner and a cheater see it)',
    'The owner’s pause stops every purchase, ticket, entry, stake and bid coming in; nothing owed waits on it: claims, refunds, unstakes, draws and payouts go on.',
    ...(routes.some(r => r.includes('Only before'))
      ? [
          'Each “Only before …” is a setting that freezes then: tell the person as each is agreed, not only in a last checklist; when a new fact reopens a settled choice, say what changed and why.',
        ]
      : []),
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
      return `${named(r)}: ${prompts} wallet prompt${prompts === 1 ? '' : 's'}${prompts > 1 && r.kind === 'lottery' ? ' (1 with buyTickets’ make)' : ''}; ${price} plus about ${sol} SOL (the player fee each time${oracle ? ', the oracle' : ''}), plus a network fee and any account it opens. A whole loop: ${loop.steps.join(', then ')} (${loop.folded < loop.prompts ? `${loop.folded} with the craft carried by the purchase, ${loop.prompts} without` : `${loop.prompts} prompt${loop.prompts === 1 ? '' : 's'}`}).${loop.bundles.length ? ` To fold it: ${loop.bundles.join('; ')}.` : ''}`;
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
 * folded, bundles }. Each step is one wallet prompt (`prompts`); `bundles` are the ways the kit's own client folds
 * steps together, and `folded` is how many prompts are left when the page uses every one of them.
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
  // (a box's roll is settled by the page's own settle key once the oracle answers: no wallet prompt; the play client's
  // openBox does it, and recover() finishes one a closed page left)
  if (r.kind === 'lottery') steps.push('pull the win (winners only)');
  if (r.kind === 'contest') steps.push('claim the win (winners only)');
  // (each bundle folds one step into the next: a craft into the purchase it pays for)
  return { steps, prompts: steps.length, folded: steps.length - bundles.length, bundles };
}

/**
 * What the person must hear, in short final sentences the agent passes on as written: for each route, what a player
 * gets for their money (a fixed price or a chance), how a farm pays over time, a whole loop's approvals, what a cancel
 * refunds, every cap in one unit (an amount per identity per window), and who names a result.
 */
export function tells(m, opts) {
  return tellLines(m, opts).map(t => t.line);
}

/**
 * The same lines, each with whether it goes to the person as written (`asWritten`: a trust fact, such as what a
 * script or a leaked key can take, where other words could claim more or less than is true) or in the agent's own
 * words, every number kept.
 */
export function tellLines(m, { now, fl = flows(m, { now }) }) {
  const sym = key => fl.assets.get(key)?.symbol ?? key;
  const out = [];
  // (a trust fact: passed on as written)
  const trust = [];
  // A first-time player, from the link to the first reward: what they need before anything works.
  if (fl.routes.length)
    out.push(
      `A first-time player needs a wallet and a little SOL before their first action${realMoney() ? '' : ' (devnet SOL, from a faucet)'}: each action costs the player fee (${Number(FEES.player) / 1e9} SOL) and a network fee, unless the page or server pays a claim's fees for them (anyone may pay them).`,
    );
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
      const crafted = fl.assets.get(r.price[0]?.asset)?.origins.find(o => o.recipe.active !== false);
      if (crafted && !fl.assets.get(r.price[0].asset).money) {
        const per = num(r.price[0].amount) / num(crafted.makes || 1);
        out.push(
          `Entering ${named(r)} N times at once takes 1 approval with buyTickets' make (times: N${per === 1 ? '' : ` × ${+per.toFixed(9)}`}), or 2 without it (one craft of ${named(crafted.recipe)} with times N, then one purchase of N tickets); never a craft for each entry.`,
        );
      }
      out.push(
        loop.folded < loop.prompts
          ? `A whole go at ${named(r)} takes ${loop.folded} wallet approval${loop.folded === 1 ? '' : 's'} when the page's purchase carries the craft (buyTickets' make), ${loop.prompts} when it doesn't: ${loop.steps.join(', then ')}.`
          : `A whole go at ${named(r)} takes ${loop.prompts} wallet approval${loop.prompts === 1 ? '' : 's'}: ${loop.steps.join(', then ')}.`,
      );
      const a = fl.assets.get(r.cancel?.refund[0]?.asset);
      const origin = a && !a.money ? a.origins[0] : null;
      if (origin)
        out.push(
          `If ${named(r)} is cancelled, a ticket's refund is ${a.symbol}, not the ${amount(origin.pays)} it was bought with.`,
        );
      if (r.cancel?.minSold)
        out.push(
          `${named(r)} draws only if ${r.cancel.minSold} tickets sell; otherwise it is cancelled, and each ticket's price waits until someone pulls it back to its buyer.`,
        );
    }
    if (r.kind === 'contest')
      out.push(
        `${named(r)}'s result is named by ${r.decider === 'authority' ? 'the project' : 'its decider key'}; with no result by its deadline, it is called off, and each entry's money waits until someone claims it back.`,
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
      // A free grant of something a route sells is a paid thing given away.
      const sold = g ? fl.assets.get(g.asset)?.origins.find(o => o.recipe.active !== false) : null;
      if (sold && !fl.assets.get(g.asset).money)
        out.push(
          `${named(r)} gives away a paid ${sym(g.asset)}: ${named(sold.recipe)} sells ${sold.makes} for ${amount(sold.pays)}, and a free one is accepted wherever a bought one is.`,
        );
      if (signed && ['bounds', undefined].includes(r.part.trust))
        trust.push(
          `${named(r)} takes the page's word within its caps: a script claiming at a steady, human pace gets the most its caps allow. A server check that only clamps to a bound costs that script nothing; one that refuses costs it the attempt.`,
        );
      // What the chain still allows when only its caps stand (the voucher key leaked, or the server loosened): a day and
      // in all, against the pool it pays from.
      const day = g && l.perDay ? l.perDay * g.amount : null;
      const drains =
        pool && day
          ? ` (“${pool.key}” starts with ${num(pool.seed)}: emptied in ${+(num(pool.seed) / day).toFixed(2)} days at that pace)`
          : '';
      const server =
        signed && (r.part.vouchers ?? []).length
          ? `${r.part.serverLimit ? ` Its server signs at most ${serverRate(r.part).says}: that is what it really pays.` : ' Its voucher server can hold a tighter limit of its own; an on-chain cap that would stop real players (a claim every few minutes) belongs on the server, said plainly.'} If its voucher key leaks, the chain still allows ${day ? `${+day.toFixed(9)} ${sym(g.asset)} a day` : 'whatever its caps allow'}${l.total && g ? ` and ${+(l.total * g.amount).toFixed(9)} in all` : ''}${drains}.`
          : '';
      if (caps.length)
        (server ? trust : out).push(
          `${named(r)}: each claim gives ${signed && g ? 'up to ' : ''}${prizeWords(r.part.prize ?? r.part.gives, m)}; the caps count claims: ${caps.join('; ')}.${over}${server}`,
        );
    }
  }
  // What "a round pays once" covers: the chain keeps a paid round with its wallet (docs/program.md, a grant's
  // rounds: the record's key is sha256(round | wallet)), so a win signed again for another wallet pays again, and a
  // voucher that ran out may have been collected before it did. One line for every grant a server signs for.
  const signedFor = fl.routes.filter(r => r.kind === 'grant' && (r.part.vouchers ?? []).length);
  if (signedFor.length)
    trust.push(
      `${words(signedFor.map(named))}: the chain pays a wallet each win (round) once, and keeps that by round and wallet together. The same win signed for a second wallet pays again, and a voucher that has run out may have been collected before it did. Before the server signs a win again (another wallet, a new voucher after the first ran out), it reads the chain for the first wallet (winPaid, from @xgamesfun/solana/results), or keeps each win on the first wallet it signed for.`,
    );
  for (const f of m.farms) {
    const locks = (f.tiers ?? []).map(t => t.lock).filter(x => x && toSeconds(x) > 0);
    out.push(
      `${named(f)} pays by the second while staked${f.rate ? (f.rate.shared ? ', sharing its rate by stake' : ' at a fixed rate a seat') : ', sharing what arrives by stake'}: staking just before a payout gains nothing${locks.length ? `, and a stake is locked for ${words([...new Set(locks)])} by its tier` : ', and there is no lock: a stake can leave at any time'}.`,
    );
  }
  // Every way a round ends (each kept in its own words), and a schedule's runs.
  // (a grant's, the ends of a claim, are told once, with what goes wrong: endStates)
  for (const r of fl.routes.filter(x => x.endings && !x.endsAs))
    out.push(`Every way ${named(r)} ends: ${r.endings.map(e => `${e.ending.toLowerCase()}: ${e.then}`).join('; ')}.`);
  // What each end state still owes moves only when someone sends it: who may, what it costs them, and what happens if
  // nobody does ("refunded" or "paid" alone hides all three).
  const WHO = {
    anyone: 'anyone may send it (a player from the page, the project or a keeper), with no loot fee',
    keys: 'only the project’s keys send it',
    winner: 'the winner sends it',
    player: 'the player sends it',
  };
  for (const r of fl.routes.filter(x => x.endings)) {
    const owed = r.states
      .filter(st => ['cancel', 'win'].includes(st.state))
      .flatMap(st => st.steps.filter(s => s.ifNobody && s.short && WHO[s.by]));
    if (owed.length)
      out.push(
        `What ${named(r)} owes moves only when someone sends it: ${owed.map(s => `${s.short[0].toUpperCase()}${s.short.slice(1)}${s.note ? ` (${s.note})` : ''}: ${WHO[s.by]}${s.cost ? `, the sender paying ${s.cost}` : ''}; if nobody does, ${s.ifNobody}`).join('. ')}.`,
      );
  }
  for (const sc of m.schedules)
    out.push(
      sc.sealed
        ? `${named(sc)} pays each run when its recipient sends it, and every run due is paid.`
        : `${named(sc)} pays only when your keys send each run; a run nobody sends on time lapses, and only the latest one due is paid.`,
    );
  // Odds that move: a box's chances shift when an outcome runs out, and whenever the project edits it.
  const rolled = fl.routes.filter(r => (r.kind === 'box' || r.kind === 'item') && r.roll);
  if (rolled.length)
    out.push(
      `${words(rolled.map(named))}'s odds can change: when an outcome runs out of stock, and whenever you edit ${rolled.length === 1 ? 'it' : 'them'}. Show players the odds as they are now (the play client's boxes() gives each outcome's chance) and say when you change them.`,
    );
  // Several at once: one approval.
  const sold = fl.routes.filter(r => (r.kind === 'box' || r.kind === 'item') && r.price.length);
  if (sold.length)
    out.push(
      `Buying or opening several of ${words(sold.map(named))} at once is one approval (count: N), and the wins to collect afterwards go in as few approvals as the wallet allows (claimAll).`,
    );
  // A returning player's day, doing each thing once: every approval added up, and what folds them.
  const day = [];
  for (const g of m.grants.filter(
    g => g.active !== false && g.limits?.perWalletEach && toSeconds(g.limits.perWalletEach.every ?? '1d') <= 86_400,
  ))
    day.push({ what: `claim ${named(g)}`, n: 1 });
  for (const r of fl.routes.filter(r => r.price.length && ['box', 'item', 'lottery', 'contest'].includes(r.kind)))
    day.push({
      what: `${r.kind === 'lottery' ? 'buy tickets of' : r.kind === 'contest' ? 'enter' : 'buy or open'} ${named(r)}`,
      // (without the win's pull, counted below; a craft the purchase carries is no approval of its own)
      n: r.kind === 'lottery' ? Math.max(1, journeyOf(r, fl).folded - 1) : 1,
    });
  for (const f of m.farms) day.push({ what: `harvest ${named(f)}`, n: 1 });
  if (fl.routes.some(r => r.kind === 'lottery' || r.kind === 'contest' || (r.kind === 'box' && r.roll)))
    day.push({ what: 'collect wins', n: 1 });
  if (day.length > 1)
    out.push(
      `A returning player's day, doing each thing once: ${day.map(d => `${d.what} (${d.n})`).join(', ')}: about ${day.reduce((n, d) => n + d.n, 0)} wallet approvals. Fold what you can: claimAll collects every win in as few as the wallet allows, and a craft rides in a ticket purchase (make).`,
    );
  return [...out.map(line => ({ line, asWritten: false })), ...trust.map(line => ({ line, asWritten: true }))];
}

/**
 * Who controls what, in one table: what the chain keeps (each cap, price and lock as written), what a server decides
 * (a voucher server's grants, a decider's contests), and what the owner's key can still change (and so whether a cap
 * can be raised).
 */
export function controlWords(m, fl) {
  const rows = [];
  const caps = [];
  for (const r of fl.routes) {
    const p = r.part ?? {};
    const l = p.limits ?? p;
    const said = [
      l.perWallet && `${l.perWallet} a wallet`,
      l.perWalletEach && `${l.perWalletEach.count} a wallet every ${l.perWalletEach.every ?? '1d'}`,
      l.perPerson && `${l.perPerson} a person`,
      l.perDay && `${l.perDay} a day`,
      l.total && `${l.total} in all`,
      r.kind === 'lottery' && r.cancel?.minSold && `at least ${r.cancel.minSold} tickets`,
    ].filter(Boolean);
    if (said.length) caps.push(`${named(r)} ${said.join(', ')}`);
  }
  rows.push(
    `The chain keeps, exactly as written: every price and cap (${caps.length ? caps.join('; ') : 'none set'}), every lock and term, and every draw's and roll's odds at the moment it is drawn (the oracle's answer). Nobody, you included, can break them while they stand.`,
  );
  const signed = m.grants.filter(g => (g.vouchers ?? []).length);
  const decided = m.contests;
  if (signed.length || decided.length)
    rows.push(
      `Decided off chain, by your server or by you: ${[
        signed.length
          ? `who earns ${words(signed.map(named))} (it signs each claim: ${[...new Set(signed.map(g => g.trust ?? 'what it checks, unsaid'))].join(', ')})`
          : '',
        decided.length
          ? `the result of ${words(decided.map(named))} (${decided.some(c => (c.deciders ?? []).length) ? 'a decider key signs it' : 'your authority key names it'})`
          : '',
      ]
        .filter(Boolean)
        .join('; ')}. The chain checks its signature and caps, never what happened.`,
    );
  rows.push(
    `Your owner key can still change: any box's, item's, recipe's, grant's or lottery's terms by an edit (so any cap above can be raised or lowered, a price changed, a route switched off; a lottery round already selling keeps its terms), pause what comes in from players, and close routes. It can't edit a farm or a contest once open (a new one replaces it), take what a round or a stake holds, or skip what is owed.${[...m.tokens.values()].some(t => t.gameMints) ? ' It mints the project’s tokens wherever a route mints them.' : ''}`,
  );
  return rows;
}
