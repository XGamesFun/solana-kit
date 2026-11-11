// Going live: the plan's transactions for a real owner, and what the spec records once they land. Nothing here signs:
// the approval page (js/approve) has the owner's wallet sign, and the full simulation sends them to a local chain.
import { encodeBase58 } from '../chain/base58.js';
import { randomBytes } from '../chain/bytes.js';
import { LOOT_PROGRAM } from '../client/pda.js';
import { compressedTree, listOf, model, tokenLabels } from './model.mjs';
import { auctionSeller, plan, setupContext } from './plan.mjs';

/** A key for each fresh account the plan creates. Their secret halves are made by whoever signs (the page). */
export function freshAddresses(names, random = randomBytes) {
  return Object.fromEntries(names.map(n => [n, encodeBase58(random(32))]));
}

/**
 * The transactions that put `economy` live for `owner`, with `keys` the addresses of the fresh accounts (each signs
 * the transaction that creates it). `live`: what is already live (a change publishes only what differs).
 */
export function prepare(
  economy,
  { owner, keys, live = null, now = Math.floor(Date.now() / 1000), rent, only = null, slot = null, renames = null },
) {
  const m = model(economy, { now });
  // `slot`: a recent slot (in the slot hashes now), which the project's standing lookup table is made at.
  const ctx = { ...setupContext(m, { owner, keys, live: live ?? {}, rent }), slot };
  const p = plan(economy, { now, ctx, live, only, renames });
  if (!p.ok) return p;
  // Going live always makes the project's standing lookup table (the plan's "table" step). Without a recent slot it
  // can't be made: refused when a part's widest transaction needs it (`wideParts`), so no player is left with a
  // transaction only a table carries in one approval.
  const wide = p.steps.some(s => s.id === 'table') && slot == null ? wideParts(m, p.warnings) : [];
  if (wide.length)
    return {
      ok: false,
      warnings: p.warnings,
      refusals: [
        {
          code: 'E-NO-TABLE',
          where: wide[0].where,
          message: `Going live makes the project’s standing lookup table, and no recent slot was read to make it at: ${wide.map(x => x.why).join('; ')}. Without the table each of those is a wallet’s own table first (more approvals), or can’t be sent at all by a wallet that sends legacy transactions only.`,
          fix: 'Try again once the cluster answers (the approval page reads a recent slot from its slot hashes).',
        },
      ],
    };
  return { ...p, ctx };
}

/**
 * The parts of an economy whose widest transaction passes a legacy transaction, so a player sends it in one approval
 * only with the project's standing lookup table: a box's open or settle and a craft the checker sizes past one
 * (W-TX-V0, W-SETTLE-V0), an auction whose bids are NFTs (each moves with its own accounts), and a farm of another
 * collection's NFTs (a pNFT's stake and exit carry its token record and rule set). [{ where, why }]
 */
export function wideParts(m, warnings = []) {
  const out = warnings
    .filter(w => w.code === 'W-TX-V0' || w.code === 'W-SETTLE-V0')
    .map(w => ({
      where: w.where,
      why: `${w.where} (${w.code === 'W-TX-V0' ? 'its open, buy or craft' : 'its settle'} passes a legacy transaction)`,
    }));
  for (const a of m.auctions)
    if (a.bidNfts) out.push({ where: `economy.auctions.${a.key}`, why: `the auction “${a.name}” (its bids are NFTs)` });
  for (const f of m.farms)
    if (f.stakes === 'collectibles' && listOf(f.gate).some(g => g?.collection))
      out.push({
        where: `economy.farms.${f.key}`,
        why: `the farm “${f.name}” (it stakes another collection’s NFTs, a pNFT’s stake and exit pass a legacy transaction)`,
      });
  return out;
}

/**
 * The spec once its setup landed: every part keeps the program number it was given, and `live` names the game, its
 * collection, the treasury, the mints made and the program, with a copy of what is now on chain.
 */
export function recordLanded(economy, { ctx, signatures = [], at = new Date().toISOString(), now }) {
  const m = model(economy, { now });
  const ids = (list, field = 'id') => list.map(x => x[field]);
  const withIds = (key, list, field = 'id') =>
    (economy[key] ?? []).map((part, i) => ({ ...part, [field]: ids(list, field)[i] }));
  const out = { ...economy };
  out.items = (economy.items ?? []).map((it, i) => {
    const shop = m.shop.find(b => b.shopOf === it.key);
    return { ...it, id: m.items[i].id, ...(shop ? { shopBox: shop.id } : {}) };
  });
  out.pools = withIds('pools', m.pools, 'index');
  out.boxes = withIds('boxes', m.boxes);
  for (const k of ['stashes', 'tables', 'recipes', 'schedules', 'lotteries', 'farms', 'grants', 'auctions'])
    if (economy[k]) out[k] = withIds(k, m[k]);
  // An auction's address names its seller: the page finds it by both.
  if (economy.auctions) out.auctions = out.auctions.map(a => ({ ...a, seller: a.seller ?? auctionSeller(a, ctx) }));
  for (const k of ['items', 'pools', 'boxes']) if (!economy[k]) delete out[k];
  const mints = {
    ...(economy.live?.mints ?? {}),
    ...Object.fromEntries([...m.tokens.values()].filter(t => t.source === 'game').map(t => [t.key, ctx.mints[t.key]])),
  };
  const { live: _, previous: __, ...published } = out;
  out.live = {
    program: LOOT_PROGRAM,
    project: ctx.project,
    // A project made with no collection (`"collection": false`) has none to write: the schema takes an address only.
    ...(ctx.collection ? { collection: ctx.collection } : {}),
    ...(ctx.tree ? { tree: ctx.tree } : {}),
    ...(ctx.tables?.length ? { tables: ctx.tables } : {}),
    treasury: ctx.treasury,
    authority: ctx.authority,
    ...(Object.keys(mints).length ? { mints } : {}),
    at,
    published,
    transactions: [...(economy.live?.transactions ?? []), ...signatures.map(signature => ({ signature }))].slice(-60),
  };
  return out;
}

const PART_LISTS = {
  items: 'item',
  pools: 'pool',
  stashes: 'stash',
  boxes: 'box',
  recipes: 'recipe',
  schedules: 'schedule',
  lotteries: 'lottery',
  farms: 'farm',
  grants: 'grant',
  auctions: 'auction',
};
/** Parts that never change once live: a farm and an auction are never edited, a pool's token is fixed. */
const FIXED = new Set(['farm', 'pool', 'auction']);

/**
 * What a change to a live economy publishes: the parts that are new or differ from what is on chain (`live.published`),
 * as the part ids setupSteps takes (`only`), and in words what cannot change. `settings`: the project's own settings
 * the spec changes (its authority, treasury, collections), which a publish never writes.
 */
export function changedParts(economy) {
  const published = economy.live?.published;
  if (!published) return { only: null, fixed: [], removed: [], settings: [], renames: [] };
  const only = new Set();
  const fixed = [];
  const removed = [];
  const renames = [];
  // A grant's `trust` is the spec's own note about its server, never sent on chain: changing it publishes nothing.
  const strip = ({ id, index, shopBox, seller, trust, ...rest }) => JSON.stringify(rest);
  for (const [list, kind] of Object.entries(PART_LISTS)) {
    const before = new Map((published[list] ?? []).map(p => [p.key, p]));
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
  // A token is made once. One whose name, ticker or link the spec now gives otherwise than it was published with
  // (`renames`; by what they come to, not how they are spelled: model.mjs tokenLabels) has its name record written
  // again, when it has one its owner can still change: that is read from the chain as the change is approved
  // (approve/live-check.mjs readRenames), never taken from this file.
  for (const t of economy.tokens ?? []) {
    const was = (published.tokens ?? []).find(x => x.key === t.key);
    if (!was) only.add(`token:${t.key}`);
    else if (
      ['project', 'game'].includes(t.source) &&
      economy.live.mints?.[t.key] &&
      JSON.stringify(tokenLabels(was)) !== JSON.stringify(tokenLabels(t))
    )
      renames.push(t.key);
  }
  // The first compressed prize opens the project's tree.
  if (!economy.live.tree && compressedTree(model(economy))) only.add('tree');
  // A traits root set again replaces the last.
  for (const t of economy.traits ?? [])
    if (!(published.traits ?? []).some(x => x.collection === t.collection && x.root === t.root))
      only.add(`traits:${t.collection}`);
  const settings = [];
  if ((published.keys?.authority ?? 'owner') !== (economy.keys?.authority ?? 'owner')) settings.push('its authority');
  if ((published.treasury ?? null) !== (economy.treasury ?? null)) settings.push('its treasury');
  if (JSON.stringify(published.collections ?? []) !== JSON.stringify(economy.collections ?? []))
    settings.push('the collections it takes');
  return { only, fixed, removed, settings, renames };
}

/**
 * In words, for a tool that does not read the chain: the spec changes what these tokens are called, and what becomes
 * of that is decided when the change is approved.
 */
export const renamesNote = renames =>
  `The spec changes what ${renames.join(', ')} ${renames.length === 1 ? 'is' : 'are'} called. A token’s name on chain is its name record: approving reads it, and writes the new name, ticker and link there when the token has a record its owner can still change (and nothing when the record says them already). A token that went live before setups named tokens has no record and can’t be given one, and a record handed on, made unchangeable or given a royalty outside these tools is left as it is: the approval page says so, sends nothing for that token, and the change stays listed here until the spec gives its old name back.`;
