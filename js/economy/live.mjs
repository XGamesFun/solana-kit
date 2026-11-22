// Going live: the plan's transactions for a real owner, and what the spec records once they land. Nothing here signs:
// the approval page (js/approve) has the owner's wallet sign, and the full simulation sends them to a local chain.
import { encodeBase58 } from '../chain/base58.js';
import { randomBytes } from '../chain/bytes.js';
import { lootProgram } from '../client/pda.js';
import { compressedTree, listOf, model, tokenLabels, toTime } from './model.mjs';
import { auctionSeller, placeholderContext, plan, setupContext, setupSteps } from './plan.mjs';

/** A key for each fresh account the plan creates. Their secret halves are made by whoever signs (the page). */
export function freshAddresses(names, random = randomBytes) {
  return Object.fromEntries(names.map(n => [n, encodeBase58(random(32))]));
}

/**
 * The transactions that put `economy` live for `owner`, with `keys` the addresses of the fresh accounts (each signs
 * the transaction that creates it). `live`: what is already live (a change publishes only what differs). `onChain`:
 * what the chain says of the live project ({ creator, treasury, authority }; plan.mjs `setupContext`).
 */
export function prepare(
  economy,
  {
    owner,
    keys,
    live = null,
    now = Math.floor(Date.now() / 1000),
    rent,
    only = null,
    slot = null,
    renames = null,
    onChain = null,
  },
) {
  const m = model(economy, { now });
  // `slot`: a recent slot (in the slot hashes now), which the project's standing lookup table is made at.
  const ctx = { ...setupContext(m, { owner, keys, live: live ?? {}, rent, onChain }), slot };
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
/**
 * The times a part says from its going live ("publish", "publish+7d", a falling price with no `start`), as the date
 * this approval sent (`now`, Unix seconds): once a part is live they are its dates, so a later change sends them again
 * and never counts them from that change. By the part's list (its kind's fields: schema.json `time`).
 */
const TIME_FIELDS = {
  items: ['opens', 'closes', 'fall.start'],
  boxes: ['opens', 'closes', 'fall.start'],
  recipes: ['opens', 'closes'],
  schedules: ['start'],
  lotteries: ['firstDraw'],
  auctions: ['start'],
  grants: ['limits.opens', 'limits.until'],
};
/** The fields of `part` (in `list`) that still say a time from its going live. */
export function goLiveFields(part, list) {
  return (TIME_FIELDS[list] ?? []).filter(field => {
    const [a, b] = field.split('.');
    const holder = b ? part?.[a] : part;
    if (!holder || typeof holder !== 'object') return false;
    const said = holder[b ?? a];
    return field === 'fall.start' ? said === undefined : typeof said === 'string' && said.startsWith('publish');
  });
}

function frozenTimes(part, list, now) {
  let out = part;
  for (const field of TIME_FIELDS[list] ?? []) {
    const [a, b] = field.split('.');
    const holder = b ? out[a] : out;
    if (!holder || typeof holder !== 'object') continue;
    const said = holder[b ?? a];
    // a falling price with no start falls from when it went live
    const fromGoLive =
      field === 'fall.start' ? said === undefined : typeof said === 'string' && said.startsWith('publish');
    if (!fromGoLive) continue;
    const date = new Date(toTime(said ?? 'publish', now) * 1000).toISOString().replace('.000Z', 'Z');
    out = b ? { ...out, [a]: { ...out[a], [b]: date } } : { ...out, [a]: date };
  }
  return out;
}

export function recordLanded(economy, { ctx, signatures = [], at = new Date().toISOString(), now, sent = null }) {
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
  // The parts this approval sent (`sent`, part ids; all of them for a new setup) have their go-live times frozen.
  for (const [list, kind] of Object.entries(PART_LISTS))
    if (Array.isArray(out[list]))
      out[list] = out[list].map(p => (!sent || sent.has(`${kind}:${p.key}`) ? frozenTimes(p, list, now) : p));
  // An auction's address names its seller: the page finds it by both.
  if (economy.auctions) out.auctions = out.auctions.map(a => ({ ...a, seller: a.seller ?? auctionSeller(a, ctx) }));
  for (const k of ['items', 'pools', 'boxes']) if (!economy[k]) delete out[k];
  const mints = {
    ...(economy.live?.mints ?? {}),
    ...Object.fromEntries([...m.tokens.values()].filter(t => t.source === 'game').map(t => [t.key, ctx.mints[t.key]])),
  };
  const { live: _, previous: __, ...published } = out;
  out.live = {
    program: lootProgram(),
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
  tables: 'table',
  boxes: 'box',
  recipes: 'recipe',
  schedules: 'schedule',
  lotteries: 'lottery',
  farms: 'farm',
  grants: 'grant',
  auctions: 'auction',
};
/**
 * Parts that never change once live: a farm and an auction are never edited, a pool's token is fixed, and a table
 * written again appends its rows (table.rs `write`), so a live one is never written again.
 */
const FIXED = new Set(['farm', 'pool', 'auction', 'table']);
const PART_KINDS = new Set(Object.values(PART_LISTS));

/**
 * Each part's go-live instructions as bytes, by part id ("box:crate"; a shop item's listing counts as its item's), for a
 * spec put live afresh at `now` with stand-in addresses: two specs that build a part alike write it alike.
 */
function partBytes(spec, now) {
  const m = model(spec, { now });
  const ctx = placeholderContext(m);
  const out = new Map();
  for (const step of setupSteps(spec, { now }).steps) {
    // by the part a step writes (a lookup table's steps are the project's, never a table of the spec)
    const [kind, key] = String(step.part ?? '').split(':');
    if (!PART_KINDS.has(kind) || !key) continue;
    const id = `${kind}:${key}`;
    // (an instruction is written either way: { programAddress, accounts: [{ address }] } or { programId, keys: [{ pubkey }] })
    const ixs = step
      .build(ctx)
      .map(ix => [
        String(ix.programAddress ?? ix.programId),
        Buffer.from(ix.data ?? []).toString('hex'),
        (ix.accounts ?? ix.keys ?? []).map(a => String(a.address ?? a.pubkey)),
      ]);
    out.set(id, (out.get(id) ?? '') + JSON.stringify(ixs));
  }
  return out;
}

/**
 * What a change to a live economy publishes: the parts that are new or differ from what is on chain (`live.published`),
 * as the part ids setupSteps takes (`only`), and in words what cannot change. `settings`: the project's own settings
 * the spec changes (its authority, treasury, collections), which a publish never writes.
 */
export function changedParts(economy) {
  const published = economy.live?.published;
  if (!published) return { only: null, fixed: [], fixedEdited: [], removed: [], settings: [], renames: [] };
  const only = new Set();
  const fixed = [];
  // the fixed parts the spec itself edits (not those another change would write otherwise, a project's new treasury)
  const fixedEdited = [];
  const removed = [];
  const renames = [];
  // A grant's `trust` is the spec's own note about its server, never sent on chain: changing it publishes nothing.
  const strip = ({ id, index, shopBox, seller, trust, ...rest }) => JSON.stringify(rest);
  // What can't change on a live part, as the program refuses it: a fixed kind; a sealed schedule (written once,
  // schedule.rs Sealed); a lottery's currency, the mint its pot holds (lottery.rs WrongMint).
  const potMint = (l, spec) => l?.currency ?? spec?.currency ?? null;
  const isFixed = (kind, key) => {
    if (FIXED.has(kind)) return true;
    const was = (published[Object.keys(PART_LISTS).find(k => PART_LISTS[k] === kind)] ?? []).find(p => p.key === key);
    const now = (economy[Object.keys(PART_LISTS).find(k => PART_LISTS[k] === kind)] ?? []).find(p => p.key === key);
    if (kind === 'schedule') return Boolean(was?.sealed);
    if (kind === 'lottery') return Boolean(was && now) && potMint(was, published) !== potMint(now, economy);
    return false;
  };
  for (const [list, kind] of Object.entries(PART_LISTS)) {
    const before = new Map((published[list] ?? []).map(p => [p.key, p]));
    for (const part of economy[list] ?? []) {
      const was = before.get(part.key);
      if (!was) {
        only.add(`${kind}:${part.key}`);
        if (kind === 'pool') only.add(`seed:${part.key}`);
        if (kind === 'grant') only.add(`fund:${part.key}`);
      } else if (strip(was) !== strip(part)) {
        if (isFixed(kind, part.key)) {
          fixed.push(`${kind}:${part.key}`);
          fixedEdited.push(`${kind}:${part.key}`);
        } else only.add(`${kind}:${part.key}`);
      }
      before.delete(part.key);
    }
    for (const key of before.keys()) removed.push(`${kind}:${key}`);
  }
  // A part the spec leaves as it was can still be written otherwise: what it reads from another part changed (a
  // lottery's pot, which a sale's share is paid into; an item's life, which each recipe that takes it enforces). Each
  // part whose instructions now build otherwise than the published spec's is published too, or said fixed.
  try {
    const now = Math.floor(Date.now() / 1000);
    const was = partBytes(published, now);
    for (const [id, bytes] of partBytes(economy, now)) {
      if (!was.has(id) || was.get(id) === bytes || only.has(id) || fixed.includes(id)) continue;
      if (isFixed(...id.split(':'))) fixed.push(id);
      else only.add(id);
    }
  } catch {
    // A published spec this version can no longer build (an older file): its parts are compared as written, above.
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
  // Another issuer: the owner's update_project names it (plan.mjs, the issuer's step).
  if ((economy.keys?.issuer ?? null) !== (published.keys?.issuer ?? null)) only.add('issuer');
  // A traits root set again replaces the last.
  for (const t of economy.traits ?? [])
    if (!(published.traits ?? []).some(x => x.collection === t.collection && x.root === t.root))
      only.add(`traits:${t.collection}`);
  const settings = [];
  if ((published.keys?.authority ?? 'owner') !== (economy.keys?.authority ?? 'owner')) settings.push('its authority');
  if ((published.treasury ?? null) !== (economy.treasury ?? null)) settings.push('its treasury');
  if (JSON.stringify(published.collections ?? []) !== JSON.stringify(economy.collections ?? []))
    settings.push('the collections it takes');
  return { only, fixed, fixedEdited, removed, settings, renames };
}

/**
 * In words, for a tool that does not read the chain: the spec changes what these tokens are called, and what becomes
 * of that is decided when the change is approved.
 */
export const renamesNote = renames =>
  `The spec changes what ${renames.join(', ')} ${renames.length === 1 ? 'is' : 'are'} called. A token’s name on chain is its name record: approving reads it, and writes the new name, ticker and link there when the token has a record its owner can still change (and nothing when the record says them already). A token that went live before setups named tokens has no record and can’t be given one, and a record handed on, made unchangeable or given a royalty outside these tools is left as it is: approving says so, sends nothing for that token, and the change stays listed here until the spec gives its old name back.`;
