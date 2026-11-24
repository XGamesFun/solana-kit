// The worked examples (whole specs in examples/ that check, simulate and go live in the tests), the ideas (real
// economies rated against the loot version examples/ideas.json names) and what loot can't do exactly (with its nearest
// versions), searchable by a person's own words. Node only (reads the files).
import { readdirSync, readFileSync } from 'node:fs';
import { CANNOT, HOW } from './guide.mjs';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const DIR = new URL('../../examples/', import.meta.url);
const IDEAS_FILE = JSON.parse(readFileSync(new URL('ideas.json', DIR), 'utf8'));
const IDEAS = IDEAS_FILE.ideas;

/** Every worked example: { name, spec }. */
export function examples() {
  return readdirSync(DIR)
    .filter(f => f.endsWith('.json') && f !== 'ideas.json')
    .sort()
    .map(f => ({ name: f.replace(/\.json$/, ''), spec: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) }));
}

/** One example's whole spec, by name. */
export function example(name) {
  const n = String(name).replace(/\.json$/, '');
  const found = examples().find(e => e.name === n);
  if (!found) throw new Error(`No example called “${name}”. xsolana_examples lists them.`);
  return found;
}

export const ideas = () => IDEAS;
/** The loot version the ideas were rated against (ideas.json `rated`). */
export const ideasRated = () => IDEAS_FILE.rated;
/** The day they were rated (ideas.json `ratedOn`). */
export const ideasRatedOn = () => IDEAS_FILE.ratedOn ?? null;

const SYNONYMS = {
  gacha: ['box', 'boxes', 'pull'],
  loot: ['box', 'boxes'],
  mystery: ['box', 'boxes'],
  pack: ['box', 'boxes'],
  packs: ['box', 'boxes'],
  roll: ['box', 'boxes'],
  chest: ['box', 'boxes'],
  staking: ['farm', 'farms', 'stake'],
  stake: ['farm', 'farms'],
  yield: ['farm', 'farms'],
  earn: ['farm', 'farms'],
  boost: ['farm', 'farms', 'odds'],
  raffle: ['lottery', 'lotteries'],
  lottery: ['lottery', 'lotteries'],
  draw: ['lottery', 'lotteries'],
  jackpot: ['lottery', 'lotteries', 'pot'],
  craft: ['recipe', 'recipes'],
  crafting: ['recipe', 'recipes'],
  merge: ['recipe', 'recipes'],
  merging: ['recipe', 'recipes'],
  upgrade: ['recipe', 'recipes'],
  breed: ['recipe', 'recipes', 'life'],
  breeding: ['recipe', 'recipes', 'life'],
  season: ['schedule', 'schedules'],
  seasons: ['schedule', 'schedules'],
  halving: ['schedule', 'schedules'],
  emission: ['schedule', 'schedules'],
  emissions: ['schedule', 'schedules'],
  vesting: ['schedule', 'schedules'],
  bet: ['contest', 'contests'],
  betting: ['contest', 'contests'],
  duel: ['contest', 'contests'],
  wager: ['contest', 'contests'],
  prediction: ['contest', 'contests'],
  fantasy: ['contest', 'contests'],
  shop: ['item', 'items'],
  store: ['item', 'items'],
  nft: ['item', 'items'],
  nfts: ['item', 'items'],
  collectible: ['item', 'items'],
  burn: ['burn'],
  deflation: ['burn'],
  deflationary: ['burn'],
  airdrop: ['grant', 'grants'],
  reward: ['grant', 'grants'],
  rewards: ['grant', 'grants'],
  quest: ['grant', 'grants'],
  quests: ['grant', 'grants'],
  giveaway: ['grant', 'grants'],
  allowlist: ['grant', 'grants'],
  whitelist: ['grant', 'grants'],
  gated: ['gate'],
  gate: ['gate'],
  'no-loss': ['no-loss', 'lottery'],
  lossless: ['no-loss', 'lottery'],
  launchpad: ['staked', 'gate'],
  tiers: ['staked'],
  rank: ['grant', 'grants'],
  holders: ['gate', 'holder'],
  pfp: ['gate', 'collection'],
  'bring-your-own': ['gate', 'collection'],
  auction: ['auction', 'auctions', 'bid'],
  auctions: ['auction', 'auctions', 'bid'],
  bid: ['auction', 'auctions'],
  bids: ['auction', 'auctions'],
  bidding: ['auction', 'auctions'],
  highest: ['auction', 'auctions'],
  outbid: ['auction', 'auctions'],
  english: ['auction', 'auctions'],
  dutch: ['fall', 'falling', 'drop'],
  descending: ['fall', 'falling'],
  referral: ['chosen', 'referred', 'referrer'],
  referrals: ['chosen', 'referred', 'referrer'],
  referrer: ['chosen', 'referred'],
  affiliate: ['chosen', 'referred'],
  affiliates: ['chosen', 'referred'],
  refer: ['chosen', 'referred'],
  rent: ['holder', 'chosen', 'rent'],
  landlord: ['holder', 'chosen', 'rent'],
  royalty: ['holder', 'share'],
  plot: ['chosen', 'holder', 'plot'],
  crowdfund: ['contest', 'goal', 'minpot'],
  crowdfunding: ['contest', 'goal', 'minpot'],
  pledge: ['contest', 'goal', 'minpot'],
  kickstarter: ['contest', 'goal', 'minpot'],
  leaderboard: ['decision', 'decisions'],
  tournament: ['contest', 'decision', 'decisions'],
  prize: ['pool', 'pools'],
  flip: ['coin', 'flip', 'box', 'boxes'],
};
const words = s =>
  String(s ?? '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9.+-]*/g) ?? [];
const STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'for',
  'with',
  'my',
  'our',
  'that',
  'is',
  'it',
  'on',
  'every',
  'each',
  'make',
  'me',
  'game',
  'i',
  'want',
  'like',
  'build',
]);

/** The parts a spec uses, and features it shows. */
export function partsUsed(spec) {
  const out = [
    'items',
    'pools',
    'boxes',
    'payments',
    'recipes',
    'schedules',
    'lotteries',
    'farms',
    'contests',
    'auctions',
    'holds',
    'grants',
    'decisions',
  ].filter(k => Array.isArray(spec?.[k]) && spec[k].length);
  const all = JSON.stringify(spec ?? {}).replace(/\s/g, '');
  for (const [f, re] of [
    ['rise', /"rise"/],
    ['fall', /"fall"/],
    ['life', /"life"/],
    ['holder', /holder:/],
    ['burn', /"burn"/],
    ['gate', /"gate"/],
    ['odds', /"odds"/],
    ['token-2022', /token-2022/],
    ['staked', /"staked":\{/],
    ['no-loss', /"noLoss":true/],
    ['chosen', /"to":"chosen/],
    ['minpot', /"minPot":/],
    ['shared-clock', /"clock":"shared"/],
  ])
    if (re.test(all)) out.push(f);
  return out;
}

function score(text, query, parts = []) {
  const have = new Set(words(text));
  const uses = new Set(parts);
  let s = 0;
  for (const w of words(query).filter(x => !STOP.has(x))) {
    if (have.has(w)) s += 2;
    else if ([...have].some(h => h.length > 3 && w.length > 3 && (h.startsWith(w) || w.startsWith(h)))) s += 1;
    for (const syn of SYNONYMS[w] ?? []) s += (have.has(syn) ? 1 : 0) + (uses.has(syn) ? 2 : 0);
  }
  return s;
}

const FIT_BONUS = { great: 0.5, some: 0.25, 'a-lot': 0, cannot: 0 };

/** How rare a word is among `docs` (sets of words), 0 to 1: a word every text has says nothing about any of them. */
function rarity(docs) {
  const df = new Map();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  return w => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) / Math.log(n + 1);
}

/** A word without a plural's "s" (raffles, raffle), so the two match; short words stay as they are. */
const stem = w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const stems = text => new Set(words(text).map(stem));
/** Whether name word `n` and query word `q` mean the same part (gacha and box, raffle and lottery), either way round. */
const alike = (n, q) => (SYNONYMS[n] ?? []).map(stem).includes(q) || (SYNONYMS[q] ?? []).map(stem).includes(n);

/**
 * A rated idea's match to `query`. Only an idea whose name says what was asked counts: a word of its name (1.5 to 3,
 * more for a word few names have), or a word that means the same part (1.5). Then each word its "how" shares with the query adds by how rare the word is
 * among the ideas (each "how" names many parts, so a common word there matches nearly every idea), and its section's
 * a little. 0 for an idea whose name matches nothing.
 */
const IDEA_WORDS = IDEAS.map(i => ({
  name: stems(i.name.replace(/-/g, ' ')),
  section: stems(i.section),
  how: stems(i.how.replace(/-/g, ' ')),
}));
const ideaRarity = rarity(IDEA_WORDS.map(d => new Set([...d.name, ...d.how])));
const nameRarity = rarity(IDEA_WORDS.map(d => d.name));
function ideaScore({ name, section, how }, query) {
  let s = 0;
  let named = false;
  for (const q of [...stems(query)].filter(x => !STOP.has(x))) {
    if (name.has(q)) {
      // (a word few names have says more: "prediction" over "market")
      s += 1.5 + 1.5 * nameRarity(q);
      named = true;
    } else if ([...name].some(n => alike(n, q))) {
      s += 1.5;
      named = true;
    }
    if (how.has(q)) s += 2 * ideaRarity(q);
    if (section.has(q)) s += 0.5;
  }
  return named ? s : 0;
}
/**
 * A worked example's match to `query`, each word weighed by how rare it is among the examples: a word of its name or
 * title (up to 3), of its prompt (up to 2), and a part the word stands for that it uses (1 to 2.5: "staking" and
 * a farm), so that "items", which nearly every example has, says little.
 */
const EXAMPLE_WORDS = () =>
  (EXAMPLE_WORDS.cached ??= examples().map(({ name, spec }) => ({
    title: stems(`${name} ${spec.name ?? ''}`.replace(/-/g, ' ')),
    prompt: stems(String(spec.prompt ?? '').replace(/-/g, ' ')),
    parts: new Set(partsUsed(spec).map(stem)),
  })));
const exampleRarity = () =>
  (exampleRarity.cached ??= rarity(EXAMPLE_WORDS().map(d => new Set([...d.title, ...d.prompt]))));
const partRarity = () => (partRarity.cached ??= rarity(EXAMPLE_WORDS().map(d => d.parts)));
function exampleScore(e, query) {
  const at = examples().findIndex(x => x.name === e.name);
  const { title, prompt, parts } = EXAMPLE_WORDS()[at];
  const r = exampleRarity();
  let s = 0;
  for (const q of [...stems(query)].filter(x => !STOP.has(x))) {
    if (title.has(q)) s += 1.5 + 1.5 * r(q);
    else if (prompt.has(q)) s += 2 * r(q);
    const part = (SYNONYMS[q] ?? []).map(stem).find(p => parts.has(p));
    if (part) s += 1 + 1.5 * partRarity()(part);
  }
  return s;
}

/** The least an idea scores to be shown: one word of its name, or a rare word of its "how". */
const IDEA_FLOOR = 2;

/** Each entry of `list` scored against `query` by its words, the closest first, keeping those that match well enough. */
function closest(list, query, limit) {
  const scored = list.map(e => ({ e, s: score(e.words.replace(/-/g, ' '), query) })).sort((a, b) => b.s - a.s);
  const best = scored[0]?.s ?? 0;
  return scored.filter(x => x.s >= 2 && x.s * 2 >= best).slice(0, limit);
}

/**
 * What loot can't do exactly that `query` asks for, with the nearest versions: the closest few. `atLeast`: only limits
 * that match at least this well (search passes the best matching capability's score: when a capability matches the
 * words better, its "how" is the answer and a weaker "can't" beside it only misleads; a tie shows both).
 */
export function limits(query, { limit = 3, atLeast = 0 } = {}) {
  return closest(CANNOT, query, limit)
    .filter(x => x.s >= atLeast)
    .map(({ e }) => ({ what: e.what, why: e.why, nearest: e.nearest }));
}

/** Asks that look impossible but are one field or a short combination, closest to `query`. */
export function hows(query, { limit = 3 } = {}) {
  return closest(HOW, query, limit).map(({ e }) => ({ what: e.what, how: e.how }));
}

/** The examples, ideas, hows and limits closest to `query`. */
export function search(query, { limit = 6, fit } = NO_OPTIONS) {
  const ex = examples().map(({ name, spec }) => ({
    name,
    title: spec.name,
    prompt: spec.prompt,
    parts: partsUsed(spec),
  }));
  // (an example is kept when it matches at least half as well as the best one: a word or two in common with a long
  // prompt is not a match)
  const exampleScores = ex.map(e => ({ e, s: exampleScore(e, query) })).filter(x => x.s >= 1.5);
  const bestExample = Math.max(0, ...exampleScores.map(x => x.s));
  const exampleHits = exampleScores
    .filter(x => x.s * 2 >= bestExample)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.e);
  const ideaScores = IDEAS.map((i, at) => ({ i, s: ideaScore(IDEA_WORDS[at], query) })).filter(
    x => (!fit || x.i.fit === fit) && x.s >= IDEA_FLOOR,
  );
  const bestIdea = Math.max(0, ...ideaScores.map(x => x.s));
  const ideaHits = ideaScores
    .filter(x => x.s * 2 >= bestIdea)
    .sort((a, b) => b.s + FIT_BONUS[b.i.fit] - (a.s + FIT_BONUS[a.i.fit]))
    .slice(0, limit)
    .map(({ i }) => i);
  // A "can't" shows only when it matches at least as well as the best matching capability.
  const how = closest(HOW, query, 3);
  return {
    examples: exampleHits,
    ideas: ideaHits,
    hows: how.map(({ e }) => ({ what: e.what, how: e.how })),
    limits: limits(query, { atLeast: how[0]?.s ?? 0 }),
  };
}
