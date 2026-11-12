// The walk-through at the end of `xsolana explain` and the review, and the end states `xsolana_check` shows: each route
// of the spec, state by state (before it opens, while it runs, cancelled or failed, won, after it ends, a change of
// mind), as a player, the owner and a cheater see it, and what can change only before its first sale or claim. The
// routes the model holds (flows.mjs) are written from its steps (who sends each, who pays, what moves, what happens if
// nobody does); the others in words that follow the program's rules (PROGRAM.md).
import { at, flows, named, num, words } from './flows.mjs';
import { toTime } from './model.mjs';

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
  };
  for (const r of fl.routes) {
    const rows = [];
    const open = r.states.find(s => s.state === 'open');
    rows.push([STATE.open, open ? stepWords(open.steps) : windowWords(r.part, ...OPEN[r.kind])]);
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

  for (const c of m.contests) {
    route(`${named(c)}: a contest`, [
      [
        'While it runs',
        `Player: enters one side${c.stake ? `, a stake of ${num(c.stake)}` : ''}${c.entriesClose ? ` (entries close: ${c.entriesClose})` : ''}; a wallet backs one side, never two. Owner: ${c.decidedBy === 'authority' || !c.deciders ? 'the result is yours to decide once entries close' : 'its deciders sign the result once entries close'}. Cheater: the result is worth what its decider checks; nobody names a side before entries close.`,
      ],
      [
        'Cancelled or failed',
        `With no result by its result deadline${c.minPot ? `, or less than ${num(c.minPot)} in its sides when entries close` : ''}, or a call-off, every entry is refunded.`,
      ],
      ['Won', 'The winners claim their share of the pot, by what each put in.'],
      ['A change of mind', 'An entry stays until the result or a refund.'],
      ['Only before the first entry', 'Every term is fixed when it opens and never edited.'],
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
  return [
    'Each route, state by state (as a player, the owner and a cheater see it)',
    'The owner’s pause stops every purchase, ticket, entry, stake and bid coming in; nothing owed waits on it: claims, refunds, unstakes, draws and payouts go on.',
    ...routes,
  ];
}
