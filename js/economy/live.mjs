// Going live: the plan's transactions for a real owner, and what the spec records once they land. Nothing here signs:
// the approval page (js/approve) has the owner's wallet sign, and the full simulation sends them to a local chain.
import { encodeBase58 } from '../chain/base58.js';
import { randomBytes } from '../chain/bytes.js';
import { LOOT_PROGRAM } from '../client/pda.js';
import { compressedTree, model } from './model.mjs';
import { auctionSeller, plan, setupContext } from './plan.mjs';

/** A key for each fresh account the plan creates. Their secret halves are made by whoever signs (the page). */
export function freshAddresses(names, random = randomBytes) {
  return Object.fromEntries(names.map((n) => [n, encodeBase58(random(32))]));
}

/**
 * The transactions that put `economy` live for `owner`, with `keys` the addresses of the fresh accounts (each signs
 * the transaction that creates it). `live`: what is already live (a change publishes only what differs).
 */
export function prepare(economy, { owner, keys, live = null, now = Math.floor(Date.now() / 1000), rent, only = null }) {
  const m = model(economy, { now });
  const ctx = setupContext(m, { owner, keys, live: live ?? {}, rent });
  const p = plan(economy, { now, ctx, live, only });
  if (!p.ok) return p;
  return { ...p, ctx };
}

/**
 * The spec once its setup landed: every part keeps the program number it was given, and `live` names the game, its
 * collection, the treasury, the mints made and the program, with a copy of what is now on chain.
 */
export function recordLanded(economy, { ctx, signatures = [], at = new Date().toISOString(), now }) {
  const m = model(economy, { now });
  const ids = (list, field = 'id') => list.map((x) => x[field]);
  const withIds = (key, list, field = 'id') => (economy[key] ?? []).map((part, i) => ({ ...part, [field]: ids(list, field)[i] }));
  const out = { ...economy };
  out.items = (economy.items ?? []).map((it, i) => {
    const shop = m.shop.find((b) => b.shopOf === it.key);
    return { ...it, id: m.items[i].id, ...(shop ? { shopBox: shop.id } : {}) };
  });
  out.pools = withIds('pools', m.pools, 'index');
  out.boxes = withIds('boxes', m.boxes);
  for (const k of ['stashes', 'recipes', 'schedules', 'lotteries', 'farms', 'grants', 'auctions']) if (economy[k]) out[k] = withIds(k, m[k]);
  // A farm that pays nothing keeps the number of the empty pool made for it, so a pool added later never takes it.
  if (economy.farms) out.farms = out.farms.map((f, i) => (m.farms[i].unpaid ? { ...f, rewardsIndex: m.pool.get(m.farms[i].rewards).index } : f));
  // An auction's address names its seller: the page finds it by both.
  if (economy.auctions) out.auctions = out.auctions.map((a) => ({ ...a, seller: a.seller ?? auctionSeller(a, ctx) }));
  for (const k of ['items', 'pools', 'boxes']) if (!economy[k]) delete out[k];
  const mints = { ...(economy.live?.mints ?? {}), ...Object.fromEntries([...m.tokens.values()].filter((t) => t.source === 'game').map((t) => [t.key, ctx.mints[t.key]])) };
  const { live: _, previous: __, ...published } = out;
  out.live = {
    program: LOOT_PROGRAM,
    project: ctx.project,
    // A project made with no collection (`"collection": false`) has none to write: the schema takes an address only.
    ...(ctx.collection ? { collection: ctx.collection } : {}),
    ...(ctx.tree ? { tree: ctx.tree } : {}),
    treasury: ctx.treasury,
    authority: ctx.authority,
    ...(Object.keys(mints).length ? { mints } : {}),
    at,
    published,
    transactions: [...(economy.live?.transactions ?? []), ...signatures.map((signature) => ({ signature }))].slice(-60),
  };
  return out;
}

const PART_LISTS = { items: 'item', pools: 'pool', stashes: 'stash', boxes: 'box', recipes: 'recipe', schedules: 'schedule', lotteries: 'lottery', farms: 'farm', grants: 'grant', auctions: 'auction' };
/** Parts that never change once live: a farm and an auction are never edited, a pool's token is fixed. */
const FIXED = new Set(['farm', 'pool', 'auction']);

/**
 * What a change to a live economy publishes: the parts that are new or differ from what is on chain (`live.published`),
 * as the part ids setupSteps takes (`only`), and in words what cannot change. `settings`: the project's own settings
 * the spec changes (its authority, treasury, collections), which a publish never writes.
 */
export function changedParts(economy) {
  const published = economy.live?.published;
  if (!published) return { only: null, fixed: [], removed: [], settings: [] };
  const only = new Set();
  const fixed = [];
  const removed = [];
  const strip = ({ id, index, shopBox, seller, rewardsIndex, ...rest }) => JSON.stringify(rest);
  for (const [list, kind] of Object.entries(PART_LISTS)) {
    const before = new Map((published[list] ?? []).map((p) => [p.key, p]));
    for (const part of economy[list] ?? []) {
      const was = before.get(part.key);
      if (!was) {
        only.add(`${kind}:${part.key}`);
        if (kind === 'pool') only.add(`seed:${part.key}`);
        if (kind === 'grant') only.add(`fund:${part.key}`);
      } else if (strip(was) !== strip(part)) {
        if (FIXED.has(kind)) fixed.push(`${kind}:${part.key}`);
        else only.add(`${kind}:${part.key}`);
      }
      before.delete(part.key);
    }
    for (const key of before.keys()) removed.push(`${kind}:${key}`);
  }
  for (const t of economy.tokens ?? []) if (!(published.tokens ?? []).some((x) => x.key === t.key)) only.add(`token:${t.key}`);
  // The first compressed prize opens the project's tree.
  if (!economy.live.tree && compressedTree(model(economy))) only.add('tree');
  // A traits root set again replaces the last.
  for (const t of economy.traits ?? []) if (!(published.traits ?? []).some((x) => x.collection === t.collection && x.root === t.root)) only.add(`traits:${t.collection}`);
  const settings = [];
  if ((published.keys?.authority ?? 'owner') !== (economy.keys?.authority ?? 'owner')) settings.push('its authority');
  if ((published.treasury ?? null) !== (economy.treasury ?? null)) settings.push('its treasury');
  if (JSON.stringify(published.collections ?? []) !== JSON.stringify(economy.collections ?? [])) settings.push('the collections it takes');
  return { only, fixed, removed, settings };
}
