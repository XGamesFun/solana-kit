// The worked examples (whole specs in examples/ that check, simulate and go live in the tests), the ideas (real
// economies rated against the current loot, in examples/ideas.json) and what loot can't do exactly (with its nearest
// versions), searchable by a person's own words. Node only (reads the files).
import { readdirSync, readFileSync } from 'node:fs';
import { CANNOT, HOW } from './guide.mjs';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const DIR = new URL('../../examples/', import.meta.url);
const IDEAS = JSON.parse(readFileSync(new URL('ideas.json', DIR), 'utf8')).ideas;

/** Every worked example: { name, spec }. */
export function examples() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'ideas.json')
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ''), spec: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) }));
}

/** One example's whole spec, by name. */
export function example(name) {
  const n = String(name).replace(/\.json$/, '');
  const found = examples().find((e) => e.name === n);
  if (!found) throw new Error(`No example called “${name}”. xsolana_examples lists them.`);
  return found;
}

export const ideas = () => IDEAS;

const SYNONYMS = {
  gacha: ['box', 'boxes', 'pull'], loot: ['box', 'boxes'], mystery: ['box', 'boxes'], pack: ['box', 'boxes'], packs: ['box', 'boxes'], roll: ['box', 'boxes'], chest: ['box', 'boxes'],
  staking: ['farm', 'farms', 'stake'], stake: ['farm', 'farms'], yield: ['farm', 'farms'], earn: ['farm', 'farms'], boost: ['farm', 'farms', 'odds'],
  raffle: ['lottery', 'lotteries'], lottery: ['lottery', 'lotteries'], draw: ['lottery', 'lotteries'], jackpot: ['share', 'pool'],
  craft: ['recipe', 'recipes'], crafting: ['recipe', 'recipes'], merge: ['recipe', 'recipes'], upgrade: ['recipe', 'recipes'], breed: ['recipe', 'recipes', 'life'], breeding: ['recipe', 'recipes', 'life'],
  season: ['schedule', 'schedules'], seasons: ['schedule', 'schedules'], halving: ['schedule', 'schedules'], emission: ['schedule', 'schedules'], emissions: ['schedule', 'schedules'], vesting: ['schedule', 'schedules'],
  bet: ['contest', 'contests'], betting: ['contest', 'contests'], duel: ['contest', 'contests'], wager: ['contest', 'contests'], prediction: ['contest', 'contests'], fantasy: ['contest', 'contests'],
  shop: ['item', 'items'], store: ['item', 'items'], nft: ['item', 'items'], nfts: ['item', 'items'], collectible: ['item', 'items'], burn: ['burn'], deflation: ['burn'], deflationary: ['burn'],
  airdrop: ['grant', 'grants'], reward: ['grant', 'grants'], rewards: ['grant', 'grants'], quest: ['grant', 'grants'], quests: ['grant', 'grants'], giveaway: ['grant', 'grants'], allowlist: ['grant', 'grants'], whitelist: ['grant', 'grants'],
  gated: ['gate'], gate: ['gate'], 'no-loss': ['no-loss', 'lottery'], lossless: ['no-loss', 'lottery'], launchpad: ['staked', 'gate'], tiers: ['staked'], rank: ['grant', 'grants'], holders: ['gate', 'holder'], pfp: ['gate', 'collection'], 'bring-your-own': ['gate', 'collection'],
  auction: ['auction', 'auctions', 'bid'], auctions: ['auction', 'auctions', 'bid'], bid: ['auction', 'auctions'], bids: ['auction', 'auctions'], bidding: ['auction', 'auctions'], highest: ['auction', 'auctions'], outbid: ['auction', 'auctions'], english: ['auction', 'auctions'],
  dutch: ['fall', 'falling', 'drop'], descending: ['fall', 'falling'],
  referral: ['chosen', 'referred', 'referrer'], referrals: ['chosen', 'referred', 'referrer'], referrer: ['chosen', 'referred'], affiliate: ['chosen', 'referred'], affiliates: ['chosen', 'referred'], refer: ['chosen', 'referred'],
  rent: ['holder', 'chosen', 'rent'], landlord: ['holder', 'chosen', 'rent'], royalty: ['holder', 'share'], plot: ['chosen', 'holder', 'plot'],
  crowdfund: ['contest', 'goal', 'minpot'], crowdfunding: ['contest', 'goal', 'minpot'], pledge: ['contest', 'goal', 'minpot'], kickstarter: ['contest', 'goal', 'minpot'],
  leaderboard: ['decision', 'decisions'], tournament: ['contest', 'decision', 'decisions'], prize: ['pool', 'pools'], flip: ['coin', 'flip', 'box', 'boxes'],
};
const words = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? [];
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'my', 'our', 'that', 'is', 'it', 'on', 'every', 'each', 'make', 'me', 'game', 'i', 'want', 'like', 'build']);

/** The parts a spec uses, and features it shows. */
export function partsUsed(spec) {
  const out = ['items', 'pools', 'boxes', 'payments', 'recipes', 'schedules', 'lotteries', 'farms', 'contests', 'auctions', 'holds', 'grants', 'decisions'].filter((k) => Array.isArray(spec?.[k]) && spec[k].length);
  const all = JSON.stringify(spec ?? {}).replace(/\s/g, '');
  for (const [f, re] of [['rise', /"rise"/], ['fall', /"fall"/], ['life', /"life"/], ['holder', /holder:/], ['burn', /"burn"/], ['gate', /"gate"/], ['odds', /"odds"/], ['token-2022', /token-2022/], ['share', /"gives":"share"/], ['staked', /"staked":\{/], ['no-loss', /"noLoss":true/], ['chosen', /"to":"chosen/], ['minpot', /"minPot":/], ['shared-clock', /"clock":"shared"/]]) if (re.test(all)) out.push(f);
  return out;
}

function score(text, query, parts = []) {
  const have = new Set(words(text));
  const uses = new Set(parts);
  let s = 0;
  for (const w of words(query).filter((x) => !STOP.has(x))) {
    if (have.has(w)) s += 2;
    else if ([...have].some((h) => h.length > 3 && w.length > 3 && (h.startsWith(w) || w.startsWith(h)))) s += 1;
    for (const syn of SYNONYMS[w] ?? []) s += (have.has(syn) ? 1 : 0) + (uses.has(syn) ? 2 : 0);
  }
  return s;
}

const FIT_BONUS = { great: 0.5, some: 0.25, 'a-lot': 0, cannot: 0 };

/** Each entry of `list` scored against `query` by its words, the closest first, keeping those that match well enough. */
function closest(list, query, limit) {
  const scored = list.map((e) => ({ e, s: score(e.words.replace(/-/g, ' '), query) })).sort((a, b) => b.s - a.s);
  const best = scored[0]?.s ?? 0;
  return scored.filter((x) => x.s >= 2 && x.s * 2 >= best).slice(0, limit);
}

/**
 * What loot can't do exactly that `query` asks for, with the nearest versions: the closest few. `atLeast`: only limits
 * that match at least this well (search passes the best matching capability's score: when a capability matches the
 * words better, its "how" is the answer and a weaker "can't" beside it only misleads; a tie shows both).
 */
export function limits(query, { limit = 3, atLeast = 0 } = {}) {
  return closest(CANNOT, query, limit)
    .filter((x) => x.s >= atLeast)
    .map(({ e }) => ({ what: e.what, why: e.why, nearest: e.nearest }));
}

/** Asks that look impossible but are one field or a short combination, closest to `query`. */
export function hows(query, { limit = 3 } = {}) {
  return closest(HOW, query, limit).map(({ e }) => ({ what: e.what, how: e.how }));
}

/** The examples, ideas, hows and limits closest to `query`. */
export function search(query, { limit = 6, fit } = NO_OPTIONS) {
  const ex = examples().map(({ name, spec }) => ({ name, title: spec.name, prompt: spec.prompt, parts: partsUsed(spec) }));
  const exampleHits = ex
    .map((e) => ({ e, s: score(`${e.name} ${e.title} ${e.prompt}`, query, e.parts) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
  const ideaHits = IDEAS.filter((i) => !fit || i.fit === fit)
    .map((i) => ({ i, s: score(`${i.name} ${i.section} ${i.how}`, query) + FIT_BONUS[i.fit] }))
    .filter((x) => x.s > 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ i }) => i);
  // A "can't" shows only when it matches at least as well as the best matching capability.
  const how = closest(HOW, query, 3);
  return { examples: exampleHits, ideas: ideaHits, hows: how.map(({ e }) => ({ what: e.what, how: e.how })), limits: limits(query, { atLeast: how[0]?.s ?? 0 }) };
}
