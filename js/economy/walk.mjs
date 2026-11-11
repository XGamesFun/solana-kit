// The walk-through at the end of `xsolana explain` and the review: each route of the spec, state by state (before it
// opens, while it runs, cancelled or failed, won, after it ends, a change of mind), as a player, the owner and a
// cheater see it, and what can change only before its first sale or claim. Words the program's rules back
// (PROGRAM.md), filled with the spec's own names, prices and dates, so an agent has the trade-offs in front of it at
// the moment it decides.
import { boxRolls, ORACLE_FEE, prizeLine, prizeToken, prizeWords, toSeconds, toTime } from './model.mjs';

const num = x => Number(x ?? 0);
const at = seconds =>
  new Date(seconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, ' UTC');
const named = part => `“${part?.name ?? part?.key}”`;
const words = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const span = seconds =>
  seconds % 86_400 === 0
    ? `${seconds / 86_400} d`
    : seconds % 3600 === 0
      ? `${seconds / 3600} h`
      : seconds % 60 === 0
        ? `${seconds / 60} min`
        : `${seconds} s`;

/** What a draw or a roll pays the oracle, in SOL. */
const oracleSol = Number(ORACLE_FEE) / 1e9;

/** The walk-through, as lines: a title, then for each route its name and one line a state. [] for a spec with no route. */
export function walkThrough(m, { now }) {
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const on = x => x.active !== false;
  const lineToken = l => {
    const p = prizeLine(l);
    return p?.gives === 'tokens' ? (prizeToken(p, m)?.key ?? p.currency ?? m.currencyKey) : null;
  };
  const inWords = r =>
    words(
      (r.in ?? []).map(l =>
        l.takes === 'pay'
          ? `${num(l.amount)} ${sym(l.currency ?? m.currencyKey)}`
          : l.item
            ? `${l.count ?? 1} ${named(m.item.get(l.item) ?? { key: l.item })} (${l.takes === 'burn' ? 'burned' : l.takes === 'use' || l.takes === 'renew' ? 'used, kept' : l.takes === 'staked' ? 'staked, kept' : l.takes})`
            : l.takes === 'show'
              ? 'an NFT of a collection, shown and kept'
              : l.takes === 'trade'
                ? 'an NFT of a collection, traded in'
                : l.takes,
      ),
    ) || 'nothing';
  const outWords = r => words((r.out ?? []).map(o => prizeWords(o, m))) || 'nothing';
  /** Recipes that make token `t` from something else, and recipes that turn it back into another token. */
  const makers = t => m.recipes.filter(r => (r.out ?? []).some(o => lineToken(o) === t) && (r.in ?? []).length);
  const backs = t =>
    m.recipes.filter(
      r =>
        (r.in ?? []).some(l => l.takes === 'pay' && (l.currency ?? m.currencyKey) === t) &&
        (r.out ?? []).some(o => lineToken(o) && lineToken(o) !== t),
    );
  const backWords = (t, how) => {
    const b = backs(t);
    if (!b.length) return '';
    const open = b.filter(on);
    return open.length
      ? ` ${words(open.map(named))} ${how} (open now).`
      : ` ${words(b.map(named))} ${how} once the project switches it on.`;
  };
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

  for (const l of m.lotteries) {
    const t = l.ticketNft ? null : (l.ticketCurrency ?? l.currency ?? m.currencyKey);
    const price = num(l.price);
    const every = toSeconds(l.every);
    const draw = l.firstDraw ? at(toTime(l.firstDraw, now)) : null;
    const made = t ? makers(t) : [];
    const closesBefore = num(toSeconds(l.closesBefore));
    const ticket = l.ticketNft
      ? 'an NFT that passes its rule'
      : price > 0
        ? `${price} ${sym(t)}`
        : 'nothing but the player fee';
    route(
      `${named(l)}: a lottery, ${every ? `drawn every ${span(every)}` : `drawn once${draw ? `, at ${draw}` : ''}`}`,
      [
        [
          'Before it opens',
          `It sells from the moment it is live; its first ticket opens the round.${l.gate ? ' Only wallets its gate admits buy.' : ''}`,
        ],
        [
          'While it runs',
          `Player: pays ${ticket} a ticket${made.length ? ` (${sym(t)} comes from ${words(made.map(named))}: a craft before the purchase)` : ''}${perWalletWords(l)}, and holds an entry in the round, not a token: it can't be sold or taken back. Sales close ${closesBefore ? `${span(closesBefore)} before` : 'at'} the draw. Owner: nothing to send; an edit reaches the next round, never the one running. Cheater: many wallets buy many tickets; nobody sees or picks the result, drawn from the oracle's answer after sales close.`,
        ],
        [
          'Cancelled or failed',
          `${num(l.minSold) > 0 ? `A round short of ${l.minSold} tickets is cancelled when its draw is asked, with no draw. ` : ''}A draw the oracle hasn't answered 7 days after it was asked is cancelled at the next ask. Player: every ticket is refunded${t && price > 0 ? ` in ${sym(t)}` : ''}${l.ticketNft ? ' (the NFT back)' : ''}, the player fee not; anyone may pull a refund to its buyer.${made.length ? ` What was paid for the ${sym(t)} does not come back with it:${backWordsOr(backWords(t, 'turns it back'), ` nothing turns ${sym(t)} back.`)}` : ''} Owner: nothing to send; a round nobody asks to draw waits, with no deadline. Cheater: nothing to gain: a refund goes to the entry's own buyer.`,
        ],
        [
          'Won',
          `Once it is due anyone asks for the draw, paying the oracle ${oracleSol} SOL, and anyone pulls each winner's part to the winner: ${words((l.places ?? []).map((p, i) => `place ${i + 1} ${p.prize ? prizeWords(p.prize, m) : `${num(p.percent)}% of the pot`}`)) || 'the pot'}. An item is given while it has stock${(l.places ?? []).some(p => prizeLine(p.prize)?.gives === 'item' && m.item.get(prizeLine(p.prize).item)?.kind !== 'collectible') ? '; a normal item is an off-chain prize, yours to deliver from its receipt' : ''}.`,
        ],
        [
          'After it ends',
          every
            ? 'The next round sells at once, on the lottery’s terms as they are then.'
            : `It sells no more tickets.${t && price > 0 && t !== m.currencyKey ? ` ${sym(t)} left in wallets does only what something else takes it for.` : ''} The owner may close it once its round is paid out, for its rent back.`,
        ],
        [
          'A change of mind',
          `No way out: a ticket stays in the round until its draw or a cancel.${t && made.length ? backWords(t, `turns ${sym(t)} not yet spent on tickets back`) : ''}`,
        ],
        [
          'Only before the first ticket',
          `The round copies the lottery's terms (price, places, least sale, draw date) at its first ticket: an edit after it reaches only the next round${every ? '' : ', and a lottery that draws once has none'}.`,
        ],
      ],
    );
  }

  for (const b of m.allBoxes) {
    const item = b.shopOf ? m.item.get(b.shopOf) : null;
    const source = item ?? b;
    const rolls = boxRolls(b, m);
    const cur = sym(b.currency ?? m.currencyKey);
    const price = num(b.price);
    const what = item ? `${named(item)} from the shop` : named(b);
    route(`${what}: ${item ? 'an item for sale' : rolls ? 'a box, rolled by the oracle' : 'a box'}`, [
      ['Before it opens', windowWords(source, 'sells', 'nothing is sold')],
      [
        'While it runs',
        `Player: pays ${price > 0 ? `${price} ${cur}` : 'nothing but the player fee'}${perWalletWords(source)}; ${rolls ? `the oracle rolls what they get (paid ${oracleSol} SOL), which lands with its answer` : 'gets what it gives at once'}. Owner: nothing to send${rolls ? '; an edit of its entries or odds refunds every paid roll still waiting, at once; a price change reaches the next purchase' : ''}. Cheater: ${rolls ? "can't see or pick a roll" : 'nothing to take: it sells at its price'}${item?.supply || (!item && rolls) ? '; bots can buy limited stock first' : ''}.`,
      ],
      [
        'Cancelled or failed',
        rolls
          ? "A roll the oracle hasn't answered is asked again once it is stale, by its player or your keys; nothing times it out. A prize out of stock is never set aside for a roll."
          : 'A purchase that can’t give what it sells fails whole: nothing is taken.',
      ],
      [
        'After it ends',
        source.closes !== undefined
          ? `Nothing sells after ${at(toTime(source.closes, now))}.`
          : 'It sells until its stock runs out or the project switches it off.',
      ],
      ['A change of mind', 'No refund once paid.'],
      [
        'Only before the first sale',
        item?.kind === 'collectible' ? 'The item’s collection can’t change once a unit is out.' : '',
      ],
    ]);
  }

  for (const r of m.recipes) {
    const takes = (r.in ?? []).filter(l => l.takes === 'pay').map(l => l.currency ?? m.currencyKey);
    const back = takes.length
      ? m.recipes.filter(
          x =>
            x !== r &&
            (x.out ?? []).some(o => takes.includes(lineToken(o))) &&
            (x.in ?? []).some(
              l => l.takes === 'pay' && (r.out ?? []).some(o => lineToken(o) === (l.currency ?? m.currencyKey)),
            ),
        )
      : [];
    route(`${named(r)}: a recipe`, [
      ['Before it opens', windowWords(r, 'crafts', 'nothing is crafted')],
      [
        'While it runs',
        `Player: gives ${inWords(r)}, gets ${outWords(r)}, in one transaction, all or nothing${perWalletWords(r)}. Owner: nothing to send; an edit reaches the next craft. Cheater: crafts as often as they hold what it takes.`,
      ],
      ['Cancelled or failed', 'A craft that can’t give every line fails whole: nothing is taken.'],
      [
        'After it ends',
        r.closes !== undefined
          ? `Nothing crafts after ${at(toTime(r.closes, now))}.`
          : 'It crafts until the project switches it off.',
      ],
      [
        'A change of mind',
        back.length
          ? `${words(back.map(named))} turns it back${back.some(on) ? '' : ' once the project switches it on'}.`
          : 'No undo: what it took is spent.',
      ],
    ]);
  }

  for (const g of m.grants) {
    const prize = prizeWords(g.prize ?? g.gives, m);
    const how = g.vouchers?.length
      ? 'a voucher from the project’s results server'
      : g.list
        ? 'a place on its list'
        : 'nothing but its limits';
    const limits = Object.entries(g.limits ?? {})
      .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ');
    route(`${named(g)}: a grant`, [
      [
        'Before it opens',
        on(g)
          ? 'Claims work from the moment it is live.'
          : 'It is switched off ("active": false): no claim until the project switches it on.',
      ],
      [
        'While it runs',
        `Player: claims ${prize}, proving it with ${how}; only their own wallet signs the claim. Owner: ${g.vouchers?.length ? 'the results server must be up to sign vouchers (no server, no claims), and ' : ''}its funds pay each claim's rent: keep them topped up. Cheater: ${g.vouchers?.length ? `gets whatever the server signs (${g.trust ?? 'what it checks'}): a signed result is worth what the server checks; ` : g.list ? '' : 'every wallet may claim; '}its limits are the ceiling (${limits || 'none'}).`,
      ],
      [
        'Cancelled or failed',
        'A claim whose prize can’t be given (a pool run dry, an item out of stock) is refused and keeps its round: it can be claimed later.',
      ],
      ['After it ends', 'It gives until its limits are reached or the project switches it off: it has no end date.'],
    ]);
  }

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

const backWordsOr = (text, otherwise) => text || otherwise;
