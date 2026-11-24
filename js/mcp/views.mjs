// What a named command prints for the developer in a terminal (`ctx.reader` 'person', bin/xsolana.mjs): a short
// summary first, then tables, and the tool's whole text in words only with --verbose. The tools' own answers (MCP,
// `--json`, `xsolana tool`) are built elsewhere and are not changed by this file.
import { model } from '../economy/model.mjs';
import { numeral, percentage, plural } from '../economy/format.mjs';
import { outcomePartWords, poolFate } from '../economy/simulate.mjs';

/** The widest line a view prints. */
const WIDTH = 118;

/**
 * How a view's words are said before they are laid out (`terminalWords` and `personWords`, js/mcp/server.mjs and
 * person.mjs): a sentence wrapped over two lines would no longer read as the one they rewrite. Set for the length of
 * one view (`speaking`), which runs at once.
 */
let say = t => t;
function speaking(words, view) {
  const was = say;
  say = words ?? (t => t);
  try {
    return view();
  } finally {
    say = was;
  }
}

/**
 * The words of `text`, a `{ … }` (a tool's arguments, a JSON form) kept as one when it fits in `width`; a longer one
 * stays as its words, so a line is only ever cut between words.
 */
function tokens(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let group = words[i];
    let depth = (group.match(/\{/g) ?? []).length - (group.match(/\}/g) ?? []).length;
    let j = i;
    while (depth > 0 && j + 1 < words.length && group.length + 1 + words[j + 1].length <= width) {
      group += ` ${words[++j]}`;
      depth += (words[j].match(/\{/g) ?? []).length - (words[j].match(/\}/g) ?? []).length;
    }
    if (depth > 0 && j + 1 < words.length) out.push(words[i]);
    else {
      out.push(group);
      i = j;
    }
  }
  return out;
}

/** `text` (said as the view says it) in lines of at most `width` columns, cut only between words (a word longer than
 * a line has a line of its own). */
export function wrap(text, width) {
  const lines = [];
  for (const word of tokens(say(String(text)), width)) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length ? lines : [''];
}

/** Whether a cell reads as a number (right-aligned): 12, 0.5 SOL, 38%, ~0.2. */
const numeric = cell => cell === '—' || /^[~≈-]?\d[\d,.]*(%| [A-Z]{2,8})?$/.test(cell);

/**
 * A table: a header row, then the rows, two spaces between columns. When it is wider than WIDTH, the widest column
 * wraps its cells over several lines until it fits.
 */
export function table(headers, rows, { indent = 2 } = {}) {
  const all = [headers, ...rows].map(r => r.map(c => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...all.map(r => r[i].length)));
  // (a column is never narrower than its longest word, so no word is cut)
  const least = headers.map((_, i) => Math.max(12, ...all.flatMap(r => tokens(say(r[i]), WIDTH).map(t => t.length))));
  const total = () => indent + widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  while (total() > WIDTH) {
    const room = widths.map((w, i) => (w > least[i] ? w : -1));
    const widest = room.indexOf(Math.max(...room));
    if (room[widest] < 0) break;
    widths[widest] -= 1;
  }
  const out = [];
  for (const [n, row] of all.entries()) {
    const cells = row.map((c, i) => wrap(c, widths[i]));
    const height = Math.max(...cells.map(c => c.length));
    for (let line = 0; line < height; line++)
      out.push(
        `${' '.repeat(indent)}${cells
          .map((c, i) => {
            const t = c[line] ?? '';
            return n > 0 && numeric(row[i]) ? t.padStart(widths[i]) : t.padEnd(widths[i]);
          })
          .join('  ')}`.trimEnd(),
      );
  }
  return out.join('\n');
}

/**
 * Where the first sentence of `s` ends: the first ".", "!" or "?" followed by a space or the end, outside any
 * parentheses or quotes, so "(about 0.5 SOL. …)" or "“Done.”" never ends one. -1 when there is none.
 */
function sentenceEnd(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '“') depth++;
    else if ((c === ')' || c === '”') && depth > 0) depth--;
    else if (depth === 0 && /[.!?]/.test(c) && (i + 1 === s.length || /\s/.test(s[i + 1]))) return i;
  }
  return -1;
}

/**
 * The first sentence of `text`, whole: never cut inside a sentence or a parenthesis. A first sentence with no number,
 * followed by one that has them, is said with it ("…pays the player fee. On mainnet that is 0.0005 SOL, 5% on top…").
 * `max` only decides whether that second sentence fits.
 */
export function firstSentence(text, max = 150) {
  const s = String(text).trim();
  const end = sentenceEnd(s);
  let first = end >= 0 ? s.slice(0, end + 1) : s;
  if (!/\d/.test(first) && end >= 0) {
    const rest = s.slice(end + 1).trim();
    const stop = sentenceEnd(rest);
    const second = stop >= 0 ? rest.slice(0, stop + 1) : rest;
    if (/\d/.test(second) && first.length + 1 + second.length <= max + 60) first = `${first} ${second}`;
  }
  return first;
}
const days = n => `${numeral(n)} ${n === 1 ? 'day' : 'days'}`;

/** The clauses of `text` split at its semicolons outside parentheses and quotes, each with its semicolon. */
function clauses(text) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '“') depth++;
    else if ((c === ')' || c === '”') && depth > 0) depth--;
    else if (c === ';' && depth === 0 && /\s/.test(text[i + 1] ?? '')) {
      out.push(text.slice(from, i + 1).trim());
      from = i + 1;
    }
  }
  out.push(text.slice(from).trim());
  return out.filter(Boolean);
}

/** A sentence longer than this many words is laid out a clause a line. */
const LONG_WORDS = 45;

/**
 * Lines wrapped at WIDTH, each continued under its first character after `lead`. A long sentence keeps every word:
 * its clauses (split at its semicolons) go a line each under the first, so it reads in parts and nothing is cut.
 */
const bullet = (text, lead = '- ') => {
  const said = say(String(text));
  const parts = said.split(/\s+/).length > LONG_WORDS ? clauses(said) : [said];
  const under = ' '.repeat(lead.length);
  return parts
    .flatMap((part, n) =>
      wrap(part, WIDTH - lead.length - (n ? 2 : 0)).map(
        (l, i) => (n === 0 ? (i ? under : lead) : `${under}${i ? '  ' : '· '}`) + l,
      ),
    )
    .join('\n');
};

/** A section: its title, then its body, when there is one. */
const section = (title, body) => (body ? `${title}\n${body}` : '');
const join = parts => parts.filter(Boolean).join('\n\n');
const sol = x => (x === null || x === undefined ? '—' : `${numeral(x)} SOL`);

/** The SOL a part adds on top of its price, by the fees of the network it is priced at. */
const onTop = rc => (rc?.extrasSol === undefined ? null : rc.extrasSol);

/**
 * Every part a player pays for one at a time, with its price and what goes on top (`sim`: the economy's simulation;
 * `mainnet`: the same economy simulated at mainnet's fees, when it is on devnet).
 */
export function purchases(sim, economy, mainnet = null) {
  const m = model(economy);
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const rows = [];
  const add = (kind, part, price, token, back) => {
    if (!part.realCost) return;
    const other = mainnet?.[kind]?.find(x => x.key === part.key)?.realCost;
    const rc = part.realCost;
    const isSol = m.tokens.get(token)?.wsol;
    const extra = other ? onTop(other) : onTop(rc);
    rows.push({
      what: `${{ boxes: 'Box', items: 'Shop', payments: 'Payment', lotteries: 'Ticket', recipes: 'Recipe' }[kind] ?? kind} “${part.name ?? part.key}”`,
      price: price === null || price === undefined ? '—' : `${numeral(price)} ${sym(token)}`,
      onTop: onTop(rc),
      onTopMainnet: other ? onTop(other) : null,
      // (on mainnet: what a player pays there, as a share of a price in SOL)
      share: isSol && Number(price) > 0 && extra !== null ? (extra / Number(price)) * 100 : null,
      back,
    });
  };
  for (const b of sim.boxes) add('boxes', b, b.price, b.token, b.returnPercent);
  for (const it of sim.items) add('items', it, it.price, it.token, null);
  for (const p of sim.payments) add('payments', p, p.amount, p.token, null);
  for (const l of sim.lotteries) add('lotteries', l, l.price, l.token, l.returnPercent);
  for (const r of sim.recipes) add('recipes', r, r.price ?? null, r.token, null);
  return rows;
}

/** The purchases as a table: price, what goes on top (devnet and mainnet when on devnet), and what comes back. */
function purchaseTable(rows, onDevnet) {
  if (!rows.length) return '';
  const headers = onDevnet
    ? ['Purchase', 'Price', 'On top, devnet', 'On top, mainnet', 'Mainnet extra', 'Returns']
    : ['Purchase', 'Price', 'On top', 'Extra', 'Returns'];
  const pct = x => (x === null || x === undefined ? '—' : `${percentage(x, 2)}%`);
  return table(
    headers,
    rows.map(r =>
      onDevnet
        ? [r.what, r.price, sol(r.onTop), sol(r.onTopMainnet), pct(r.share), pct(r.back)]
        : [r.what, r.price, sol(r.onTop), pct(r.share), pct(r.back)],
    ),
  );
}

const ON_TOP_NOTE =
  '"On top" is what one action costs beyond its price, on average across its outcomes: the player fee, the oracle, the network fee, and rent that never comes back (a minted NFT’s, counted by how often one is minted); explain gives the same figure. "Extra" is that as a share of a price in SOL. "Returns" is what a player gets back on average, as a share of the price.';

/** `xsolana simulate` for the developer. `mainnet`: the simulation at mainnet's fees, for an economy on devnet. */
function simulateView(sim, economy, { mainnet = null, verbose = false, words = '' } = {}) {
  const m = model(economy);
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  const list = map =>
    Object.entries(map)
      .map(([k, v]) => `${numeral(v)} ${sym(k)}`)
      .join(', ') || 'nothing';
  const d = sim.perDay;
  const counts = Object.entries(sim.scenario.perDay).map(([k, v]) => `${k} ${numeral(v)}`);
  const head = [
    `Simulation over ${numeral(sim.scenario.days)} days. Counts a day: ${counts.join(', ') || 'none named'} (anything not named: ${numeral(sim.scenario.defaultPerDay)}).`,
    `Each day, players pay ${list(d.players.pay)} and get back ${list(d.players.getBack)} on average.`,
    `The treasury gets ${list(d.creator.treasury)}. Platform fees: ${numeral(d.platform.totalSol)} SOL. Oracle fees: ${numeral(d.oracle.totalSol)} SOL.`,
  ]
    .map(l => wrap(l, WIDTH).join('\n'))
    .join('\n');
  const rows = purchases(sim, economy, mainnet);
  const odds = sim.boxes.map(b =>
    bullet(
      `${b.name}: ${b.outcomes
        .map(
          o =>
            `${percentage(o.chance, 4)}% ${o.gives === 'bundle' ? o.prizes.map(p => outcomePartWords(p, sym)).join(' + ') : outcomePartWords(o, sym)}`,
        )
        .join(' · ')}`,
    ),
  );
  const pools = sim.pools.length
    ? table(
        ['Pool', 'Starts', 'In a day', 'Out a day', `Outlook over ${numeral(sim.scenario.days)} days`],
        sim.pools.map(p => [
          p.pot ? `pot of “${p.pot}”` : p.farm ? `rewards of “${p.farm}”` : `“${p.key}”`,
          `${numeral(p.seed)} ${sym(p.token)}`,
          numeral(p.inPerDay),
          numeral(p.outPerDay),
          poolFate(p, sim.scenario.days),
        ]),
      )
    : '';
  const farms = sim.farms.length
    ? table(
        ['Farm', 'Rewards a day', 'Per unit a day', 'A year'],
        sim.farms.map(f => [
          `“${f.name}”`,
          `${numeral(f.rewardsPerDay)} ${sym(f.rewardsToken)}`,
          f.perUnitPerDay !== undefined ? `${numeral(f.perUnitPerDay)} a ${f.unit}` : 'shared by stake',
          f.yearlyPercent !== undefined ? `${percentage(f.yearlyPercent, 3)}%` : '—',
        ]),
      )
    : '';
  const lotteries = sim.lotteries.length
    ? table(
        ['Lottery', 'Ticket', 'Tickets a round', 'Round', 'Pot at the draw'],
        sim.lotteries.map(l => [
          `“${l.name}”`,
          l.ticketNft ? 'an NFT' : `${numeral(l.price)} ${sym(l.token)}`,
          numeral(l.ticketsPerRound),
          days(l.roundDays),
          `${numeral(l.potBeforeDraw)} ${sym(l.potToken)}`,
        ]),
      )
    : '';
  const stashes = (sim.stashes ?? []).length
    ? table(
        ['Stash', 'NFTs', 'Given a day', 'Lasts'],
        sim.stashes.map(s => [
          `“${s.name}”`,
          numeral(s.holds),
          numeral(s.givenPerDay ?? 0),
          s.lastsDays !== undefined ? days(s.lastsDays) : '—',
        ]),
      )
    : '';
  const watch = sim.notes.map(n => bullet(firstSentence(n, 160)));
  return join([
    head,
    section('What a player pays', rows.length ? `${purchaseTable(rows, Boolean(mainnet))}` : ''),
    section('Odds', odds.join('\n')),
    section('Lotteries', lotteries),
    section('Pools', pools),
    section('Farms', farms),
    section('Stashes', stashes),
    section('Watch', watch.join('\n')),
    verbose ? section('In full', words) : '',
    rows.length ? wrap(ON_TOP_NOTE, WIDTH).join('\n') : '',
    verbose
      ? ''
      : 'Add --verbose for every part in words: what each one gives, how stock runs out, and each pool’s fate.',
  ]);
}

/** `xsolana cost` for the developer. `mainnet`: the cost at mainnet's fees, for an economy on devnet. */
function costView(c, economy, { sim = null, simMainnet = null, mainnet = null, verbose = false, words = '' } = {}) {
  const s = c.setup;
  // (every SOL part of the total, so they add up to it; seeds in other tokens beside it)
  const parts = s.parts ?? [];
  const sols = new Set([...model(economy).tokens.values()].filter(t => t.wsol).map(t => t.symbol));
  const other = Object.entries(s.seeds).filter(([symbol]) => !sols.has(symbol));
  const head = [
    `Going live: ${plural(s.transactions, 'transaction')}, about ${numeral(s.totalSol)} SOL in all:`,
    table(
      ['SOL', 'For'],
      parts.map(p => [numeral(p.sol), p.what]),
    ),
    other.length
      ? wrap(`Also put in, in other tokens: ${other.map(([k, v]) => `${numeral(v)} ${k}`).join(', ')}.`, WIDTH).join(
          '\n',
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const rows = sim ? purchases(sim, economy, simMainnet) : [];
  // (the headline a player pays: what goes on top of a price, on mainnet, and the largest share of a price in SOL)
  const tops = rows.map(r => r.onTopMainnet ?? r.onTop).filter(x => x !== null);
  const worst = rows.filter(r => r.share !== null).sort((a, b) => b.share - a.share)[0];
  const player = tops.length
    ? wrap(
        `A player pays ${Math.min(...tops) === Math.max(...tops) ? `${numeral(tops[0])} SOL` : `${numeral(Math.min(...tops))} to ${numeral(Math.max(...tops))} SOL`} on top of each price${simMainnet ? ' on mainnet' : ''}${worst ? `; the most, as a share of the price, is ${percentage(worst.share, 2)}% more for ${worst.what}` : ''}.`,
        WIDTH,
      ).join('\n')
    : '';
  const others = c.actions.filter(a => !(a.who === 'player' && (a.onTopSol !== undefined || a.inAllSol !== undefined)));
  const otherAt = a => mainnet?.actions.find(x => x.part === a.part && x.action === a.action) ?? null;
  const fee = a => (a.feeSol ? numeral(a.feeSol) : '0');
  const actions = others.length
    ? table(
        mainnet
          ? ['Action', 'Who signs', 'Fee, devnet', 'Fee, mainnet', 'Oracle', 'Network']
          : ['Action', 'Who signs', 'Fee', 'Oracle', 'Network'],
        others.map(a =>
          mainnet
            ? [
                a.action,
                a.who,
                fee(a),
                otherAt(a) ? fee(otherAt(a)) : '—',
                numeral(a.oracleSol ?? 0),
                numeral(a.networkSol ?? 0),
              ]
            : [a.action, a.who, fee(a), numeral(a.oracleSol ?? 0), numeral(a.networkSol ?? 0)],
        ),
      )
    : '';
  const network = c.fees?.mainnetPlayerSol !== undefined ? 'devnet' : (c.fees?.network ?? 'its network');
  return join([
    [head, player].filter(Boolean).join('\n'),
    section(
      `What a player pays for one action${simMainnet ? ' (devnet SOL is play money; mainnet is what real players pay)' : ''}`,
      purchaseTable(rows, Boolean(simMainnet)),
    ),
    section(`Other actions (SOL, at ${network}'s fees${mainnet ? ', with mainnet’s' : ''})`, actions),
    verbose ? section('In full', words) : '',
    rows.length ? wrap(ON_TOP_NOTE, WIDTH).join('\n') : '',
    verbose
      ? ''
      : wrap(
          'Add --verbose for each account’s rent, what a wallet must hold when it signs, and what comes back.',
          WIDTH,
        ).join('\n'),
  ]);
}

/** `xsolana review` for the developer: the verdict, the routes and the findings, then (--verbose) the trade-offs. */
function reviewView(r, name, { verbose = false, words = '', checklist = '' } = {}) {
  const count = sev => r.findings.filter(f => f.severity === sev).length;
  const highs = count('high');
  const head = [
    `Review of ${name ?? 'the economy'}: ${plural(r.routes.length, 'route')} that pay or give value. Findings: ${count('high')} high, ${count('medium')} medium, ${count('low')} low, ${count('info')} info.`,
    highs
      ? `Fix ${highs === 1 ? 'the high finding' : `the ${highs} high findings`}, or accept ${highs === 1 ? 'it' : 'them'} knowingly, before going live.`
      : 'No high finding.',
  ]
    .map(l => wrap(l, WIDTH).join('\n'))
    .join('\n');
  const routes = r.routes.length
    ? table(
        ['Route', 'Who can trigger it', 'Most one cheater gets'],
        r.routes.map(x => [
          `${x.kind} “${x.name ?? x.key}”`,
          firstSentence(x.trigger, 70),
          firstSentence(x.ceiling, 90),
        ]),
      )
    : '';
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  const findings = [...r.findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map(f =>
      bullet(
        `[${f.severity}] ${f.id} (${f.route}): ${f.severity === 'high' || verbose ? `${f.message} Fix: ${f.fix}` : firstSentence(f.message)}`,
      ),
    );
  return join([
    head,
    section('Routes', routes),
    section('Findings', findings.join('\n')),
    verbose ? section('In full', words) : '',
    verbose ? checklist : '',
    verbose
      ? ''
      : wrap(
          'Add --verbose for each route in full, every finding’s fix, the trade-offs of each signed route, and a checklist before going live.',
          WIDTH,
        ).join('\n'),
  ]);
}

/** The order a check's questions come in: the weightiest finding's first. */
const ASK_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * `xsolana check` for the developer: the verdict and its counts first, then each refusal in full, each warning in its
 * first sentence (in full, with its fix, with --verbose), the questions only the developer can answer, the legal
 * notes, and (--verbose) what players should know and how each route ends. `findings`: the refusals and warnings as
 * the tool lists them (repeats folded).
 */
function checkView(verdict, findings, { verbose = false, legal = [], told = [], ends = [], designHint = '' } = {}) {
  const { refusals, warnings } = findings;
  const bySeverity = ['high', 'medium', 'low']
    .map(sev => [sev, warnings.filter(w => w.severity === sev).length])
    .filter(([, n]) => n)
    .map(([sev, n]) => `${n} ${sev}`);
  const asks = verdict.warnings
    .filter(w => w.ask)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (ASK_ORDER[a.w.severity] ?? 3) - (ASK_ORDER[b.w.severity] ?? 3) || a.i - b.i)
    .map(({ w }) => w.ask);
  const head = verdict.ok
    ? `Ready: no refusals, ${plural(verdict.warnings.length, 'warning')}${bySeverity.length ? ` (${bySeverity.join(', ')})` : ''}${asks.length ? `, ${plural(asks.length, 'question')} for you` : ''}.`
    : `Not ready: ${plural(verdict.refusals.length, 'refusal')}${verdict.warnings.length ? ` and ${plural(verdict.warnings.length, 'warning')}` : ''}. Fix each refusal as its fix says, then check again.`;
  const refused = refusals.map(r => bullet(`${r.code} ${r.message} Fix: ${r.fix}`, '✗ '));
  const warned = warnings.map(w =>
    [
      bullet(
        `${w.code}${w.severity ? ` (${w.severity})` : ''} ${verbose ? w.message : firstSentence(w.message, 140)}`,
        '! ',
      ),
      verbose && w.fix ? bullet(w.fix, '  → ') : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const more = [];
  if (!verbose && warnings.length) more.push('each warning in full with its fix');
  if (!verbose && told.length) more.push('what players should know');
  if (!verbose && ends.length) more.push('how each route ends');
  return join([
    head,
    section('Refusals', refused.join('\n')),
    section('Warnings', warned.join('\n')),
    section(
      'Questions for you (settle them before you build on this spec; most answers go in its "scenario")',
      asks.map(a => bullet(a, '? ')).join('\n'),
    ),
    section('Legal notes (read them again before mainnet)', legal.map(f => bullet(f.says)).join('\n')),
    verbose
      ? section(
          'What players should know (the program does this; say it on your page)',
          told.map(t => bullet(t.line)).join('\n'),
        )
      : '',
    verbose
      ? section('When a route goes wrong or a player changes their mind', ends.map(l => bullet(l)).join('\n'))
      : '',
    verbose ? designHint : '',
    verdict.ok
      ? wrap(
          `Next: xsolana_simulate and xsolana_explain; before going live, xsolana_review.${more.length ? ` Add --verbose for ${more.join(', ')}.` : ''}`,
          WIDTH,
        ).join('\n')
      : '',
  ]);
}

/**
 * The views, each with `say`: how the tools' words are said in a terminal (js/mcp/tools.mjs passes the reader's
 * `terminalWords` and `personWords`), applied before anything is wrapped.
 */
export const personSimulate = (sim, economy, options = {}) =>
  speaking(options.say, () => simulateView(sim, economy, options));
export const personCost = (c, economy, options = {}) => speaking(options.say, () => costView(c, economy, options));
export const personReview = (r, name, options = {}) => speaking(options.say, () => reviewView(r, name, options));
export const personCheck = (verdict, findings, options = {}) =>
  speaking(options.say, () => checkView(verdict, findings, options));

/**
 * `xsolana examples` for the developer: the examples as a table (their prompts with --verbose), what looks impossible
 * but is not, what loot can't do with its nearest versions, and (only with --verbose) the rated kinds of economy, whose
 * hand ratings are dated. `found`: search's answer, or { examples } for the whole list.
 */
function examplesView(found, { query = null, verbose = false, ideaCount = 0 } = {}) {
  const ex = found.examples ?? [];
  const exTable = ex.length
    ? table(
        ['Example', 'What it is', 'Parts'],
        ex.map(e => [e.name, e.title, e.parts.join(', ')]),
      )
    : '';
  const prompts = verbose ? ex.map(e => bullet(`${e.name}: ${e.prompt ?? ''}`)).join('\n') : '';
  const ideas = found.ideas ?? [];
  return join([
    query
      ? ex.length
        ? `Worked examples closest to “${query}”:`
        : `No worked example matches “${query}”. Try other words, or start from xsolana_guide.`
      : `${plural(ex.length, 'worked example')}:`,
    exTable,
    section('What each asks for', prompts),
    section(
      'These look impossible but are one field or a short combination',
      (found.hows ?? []).map(h => bullet(`${h.what}: ${h.how}.`)).join('\n'),
    ),
    section(
      'What no part of loot does here, and the nearest versions, best first',
      (found.limits ?? [])
        .map(l => [bullet(`${l.what}: ${l.why}.`), ...l.nearest.map((n, i) => bullet(n, `  ${i + 1}. `))].join('\n'))
        .join('\n'),
    ),
    // (the kinds of economy without their hand ratings, which were made against an older loot: --json keeps them)
    verbose && ideas.length
      ? section(
          'Similar kinds of economy, with what loot covers and what it leaves out for each',
          ideas.map(i => bullet(`${i.name}: ${i.how}`)).join('\n'),
        )
      : '',
    !verbose && (ideas.length || (!query && ideaCount))
      ? wrap(
          query
            ? `${ideas.length} similar ${ideas.length === 1 ? 'kind of economy also matches' : 'kinds of economy also match'}: add --verbose to see how loot builds ${ideas.length === 1 ? 'it' : 'them'}.`
            : `${ideaCount} more kinds of economy can be searched: add words, as in xsolana examples nft staking.`,
          WIDTH,
        ).join('\n')
      : '',
    ex.length ? `xsolana examples <name> prints one whole; add --save <file> to start a spec from it.` : '',
  ]);
}
export const personExamples = (found, options = {}) => speaking(options.say, () => examplesView(found, options));

/** The sections of `explain` kept whole by default: what the law flags, who signs, the dates, each action's prompts. */
const WHOLE = /^(Flagged for the law|Every date|Each player action|What setting it up costs)/;
/** The sections only --verbose shows: each route, state by state. */
const VERBOSE_ONLY = /^Each route, state by state/;

/**
 * `xsolana explain` for the developer: each section with its bullets cut to their first sentence (the law's flags,
 * the dates and each action's prompts whole), and the state-by-state walk only with --verbose, which prints the whole
 * text. `text`: the tool's own words.
 */
function explainView(text, { verbose = false } = {}) {
  if (verbose) return text;
  const blocks = String(text).split(/\n\n+/);
  const out = [];
  let left = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    const titled = !lines[0].startsWith('- ');
    const title = titled ? lines[0] : '';
    if (VERBOSE_ONLY.test(title)) {
      left++;
      continue;
    }
    const whole = WHOLE.test(title);
    const body = (titled ? lines.slice(1) : lines).map(l => {
      const sub = /^ {2}- /.test(l);
      const item = l.replace(/^ *- /, '');
      const said = whole ? item : firstSentence(item, 160);
      return bullet(said, sub ? '  - ' : '- ');
    });
    // (a section that is one paragraph: its title is the text)
    const head = titled ? wrap(body.length || whole ? title : firstSentence(title, 220), WIDTH).join('\n') : '';
    out.push([head, ...body].filter(Boolean).join('\n'));
  }
  out.push(
    wrap(
      `Add --verbose for the whole text${left ? ', and each route state by state (as a player, the owner and a cheater see it)' : ''}.`,
      WIDTH,
    ).join('\n'),
  );
  return out.join('\n\n');
}
export const personExplain = (text, options = {}) => speaking(options.say, () => explainView(text, options));
