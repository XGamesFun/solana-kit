// The setup plan: every instruction that puts an economy live on loot, in order, built with the client and
// packed into transactions that fit. Nothing here signs or talks to the chain. Pure.
//
// A step is { id, part, says, signers, creates: [{ what, bytes }], build(ctx) → instructions }. `ctx` names the
// addresses a step needs: { owner, authority, project, collection, tree, treasury, mints: { tokenKey: mint }, keys: {
// name: address } } where `keys` are the fresh keys this setup makes ("new:collection", "new:tree", "new:mint/points"), each of
// which signs the step that creates it. `placeholderContext` fills every address with a stand-in, so a plan can be
// sized and shown before anyone connects a wallet.
import { encodeBase58 } from '../chain/base58.js';
import { createCollectionInstruction } from '../chain/core.js';
import { ASSOCIATED_TOKEN_PROGRAM, NATIVE_MINT, SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, SYSVAR_SLOT_HASHES, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { createTableIx, extendTableIx } from '../chain/lookup.js';
import { MEMO_PROGRAM } from '../chain/token2022.js';
import { createAssociatedTokenAccountIdempotent, syncNative, transferLamports } from '../chain/programs.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, mintToIx, setAuthorityIx, transferCheckedIx } from '../chain/token.js';
import { compileMessage, transactionSize } from '../chain/tx.js';
import { sha256 } from '../chain/sha256.js';
import { utf8 } from '../chain/bytes.js';
import * as loot from '../client/index.js';
import { check } from './check.mjs';
import { ACCOUNT_OVERHEAD, boxBuys, boxRolls, compressedTree, destination, effectOf, gateOf, listOf, lotterySplit, model, MOST_RENT_PER_BYTE, outcomeParts, perWalletOf, placeOf, lifeLines, prizeLine, prizePool, prizeRolls, prizeToken, rarityNumber, ruleOf, sharesOf, spendOf, stashNfts, toBy, toEnum, toSeconds, toTime, toUnits, weights, wholeCount, windowOf } from './model.mjs';
import { BUDGET } from './txsize.mjs';

const owner = 'owner';
/** Most transactions one wallet approval carries. */
export const PER_APPROVAL = 12;

const amount = (value, t) => toUnits(value ?? 0, t?.decimals ?? 0);
const shares = (split, m) => sharesOf(split).map((s) => ({ to: toEnum(s.to, m), bps: s.bps ?? 0 }));
const rise = (r, t) => (r ? { step: amount(r.step ?? 0, t), growth_bps: Math.round((r.growthPercent ?? 0) * 100) } : null);
const fall = (f, t, now) => (f ? { step: amount(f.step, t), every: toSeconds(f.every), floor: amount(f.floor ?? 0, t), since: BigInt(toTime(f.start, now)), shared: f.clock === 'shared' } : null);
const tokenProgramOf = (t) => (t?.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

// ---------------------------------------------------------------- spec parts → the program's args

export function itemArgs(it, m) {
  const kind = it.kind === 'normal' ? 'Normal' : 'Collectible';
  // A collectible is minted into its own `collection`, or the one the setup makes ("@collection" until it exists). Its
  // life is written into each recipe that takes it (`lifeLines`).
  return {
    kind,
    rarity: rarityNumber(it.rarity),
    soulbound: !!it.soulbound,
    burnable: !!it.burnable,
    name: it.name,
    uri: it.uri ?? '',
    max_supply: it.supply ?? 0,
    active: it.active !== false,
    collection: kind === 'Normal' ? NOBODY : it.collection ?? '@collection',
    // A fresh collectible's traits, each drawn per unit (a table's row, or a number in a range).
    traits: kind === 'Normal' ? [] : (it.drawn ?? []).map((t) => ({ key: t.attribute, from: t.table !== undefined ? { Table: [m?.table.get(t.table)?.id ?? 0] } : { Range: { min: BigInt(t.min ?? 0), max: BigInt(t.max ?? 0) } } })),
  };
}

/** The bytes of an order of box `b` (`orderBytes`), its spec's names standing in as addresses. */
export const boxOrderBytes = (b, m, opens = 1) => {
  // Sized as the program sizes it (`space_for(box, shares, opens)`): with the shares its split stores.
  const args = boxArgs(b, m);
  return loot.orderBytes(placeholders(args), (args.shares ?? []).length, opens);
};

/** The most bytes of rows one table write carries: what a 1,232-byte transaction leaves after the upsert's accounts,
 * its signature and its own bytes. */
export const TABLE_BATCH_BYTES = 800;

/** A spec table's rows as the program takes them ({ weight, left, label }), in batches that fit a transaction each. */
export function tableBatches(t) {
  const rows = t.rows.map((r) => ({ weight: r.weight, left: r.stock ?? 4294967295, label: t.kind === 'numbers' ? '' : String(r.label ?? '') }));
  const batches = [[]];
  let bytes = 0;
  for (const r of rows) {
    const size = 12 + new TextEncoder().encode(r.label).length;
    if (bytes + size > TABLE_BATCH_BYTES && batches.at(-1).length) batches.push([]), (bytes = 0);
    batches.at(-1).push(r);
    bytes += size;
  }
  return batches;
}

/** The program's `Prize` for one part of a box outcome (`model.outcomeParts`). */
export function partPrize(o, m) {
  // An item, or a compressed NFT of it, minted at the settle into the project's tree.
  if (o.gives === 'item' && o.compressed) return { Compressed: { item: m.item.get(o.item)?.id ?? 0, tree: '@tree' } };
  if (o.gives === 'item') return { Item: [m.item.get(o.item)?.id ?? 0] };
  if (o.gives === 'stash') return { Stash: [m.stash.get(o.stash)?.id ?? 0] };
  if (o.gives === 'pay') return { Tokens: { from: { Pool: [m.pool.get(o.pool)?.index ?? 0] }, amount: { Fixed: [amount(o.amount, m.poolToken(o.pool))] } } };
  if (o.gives === 'share') return { Tokens: { from: { Pool: [m.pool.get(o.pool)?.index ?? 0] }, amount: { Bps: [Math.round((o.percent ?? 0) * 100)] } } };
  if (o.gives === 'mint') return { Tokens: { from: { Mint: [`@mint:${o.currency ?? m.currencyKey}`] }, amount: { Fixed: [amount(o.amount, m.tokens.get(o.currency ?? m.currencyKey))] } } };
  return prizeArgs(o, m);
}

export function boxArgs(b, m) {
  const t = m.priceToken(b);
  const w = weights(b);
  return {
    price: amount(b.price, t),
    currency: `@mint:${b.currency ?? m.currencyKey}`,
    rise: rise(b.rise, t),
    fall: fall(b.fall, t, m.now),
    stock_odds: !!b.stockOdds,
    active: b.active !== false,
    shares: shares(b.split, m),
    // What one open draws: each slot so many draws among the outcomes it names (all, when none), no outcome twice
    // when distinct. None is one draw among every outcome.
    slots: (b.slots ?? []).map((s) => ({ count: s.count, only: s.from ?? [], distinct: Boolean(s.distinct) })),
    // An entry gives its prizes (a bundle of any number), and may burn the payment in place of the split.
    entries: (b.outcomes ?? []).map((o, i) => ({ prizes: outcomeParts(o).map((part) => partPrize(part, m)), weight: w[i] })),
    gate: gateOf(b.gate, m),
    odds: (b.odds ?? []).map((o) => ({ entry: o.outcome, boost: { rule: ruleOf(o.when, m), effect: effectOf(o.add) } })),
    window: windowOf(b, m.now),
    per_wallet: perWalletOf(b),
    // A box that rolls on an NFT: the rule it must pass, and what each outcome does to it.
    subject: b.rollsOn ? ruleOf(b.rollsOn, m) : null,
    fates: (b.outcomes ?? []).flatMap((o, i) => {
      const shifts = (o.shifts ?? []).map((x) => ({ key: x.attribute, by: toBy(x.by), most: toSeconds(x.upTo ?? 0), from_now: Boolean(x.fromNow) }));
      // An outcome's own `then`, or the box's: an NFT taken as its price goes there whatever the roll gives.
      const then = thenOf(o.then ?? b.then, m);
      return shifts.length || then !== null ? [{ entry: i, shifts, then }] : [];
    }),
  };
}

/** Where an outcome sends the NFT a box rolls on: back (null), burned, given (the treasury's wallet is filled in when the economy goes live), or into a stash. */
export const thenOf = (then, m) => {
  if (!then || then === 'back') return null;
  if (then === 'burn') return 'Burn';
  if (then.stash) return { Stash: [m?.stash.get(then.stash)?.id ?? 0] };
  return { Give: [then === 'treasury' ? '@treasury' : then.giveTo] };
};

/** The most a raise names (a u32): a farm’s time moved as written, with no cap of its own until 2106. */
const NO_CAP = 4_294_967_295;
/** Whether `key` is a time a farm of the spec keeps on what it stakes (its lock, its upkeep). */
const farmTime = (key, m) => m.farms.some((f) => f.lockAttribute === key || f.upkeepAttribute === key);

export function recipeArgs(r, m) {
  const tok = (key) => m.tokens.get(key ?? m.currencyKey);
  const inputs = (r.in ?? []).map((l) => {
    if (l.takes === 'burn') return { Burn: { item: m.item.get(l.item)?.id ?? 0, count: l.count ?? 1 } };
    if (l.takes === 'use') return { Use: { item: m.item.get(l.item)?.id ?? 0 } };
    // A staked one names the farm it sits in (craft.rs): the craft takes it only from its seat there.
    if (l.takes === 'staked') return { Staked: { item: m.item.get(l.item)?.id ?? 0, farm: m.farm.get(l.farm)?.id ?? 0 } };
    // A renew keeps the collectible as a use does; its life's raise counts its uses from 0 again (`lifeLines`).
    if (l.takes === 'renew') return { Use: { item: m.item.get(l.item)?.id ?? 0 } };
    if (l.takes === 'show') return { Show: { collection: l.collection ?? '@collection' } };
    // A trade-in: one NFT of `collection`, any kind, burned, given on, or put in a stash.
    if (l.takes === 'trade') return { Trade: { collection: l.collection ?? '@collection', then: spendOf(l.then, m) } };
    return { Pay: { mint: `@mint:${l.currency ?? m.currencyKey}`, amount: amount(l.amount, tok(l.currency)), to: toEnum(l.to, m) } };
  });
  const life = lifeLines(r, m);
  // A line is a prize (prize.rs), or a roll on a collectible it keeps (`on`).
  const outputs = (r.out ?? []).map((l) => (l.gives === 'roll' && l.on !== undefined ? { RollOn: { box_id: m.box.get(l.box)?.id ?? 0, place: l.on } } : { Prize: [prizeArgs(l, m)] }));
  return {
    active: r.active !== false,
    inputs,
    outputs,
    // The recipe's own needs and raises, then what the life of each collectible it takes adds (`lifeLines`).
    needs: [...(r.needs ?? []).map((n) => ({ place: n.place, key: n.key, test: { AtLeast: [n.atLeast ?? 0] } })), ...life.needs],
    keeps: (r.keeps ?? []).map((k) => ({ key: k.key, from: k.from, to: k.to })),
    raises: [...(r.raises ?? []).map((x) => ({ place: x.place, shift: { key: x.key, by: toBy(x.by), most: x.upTo === undefined && farmTime(x.key, m) && !x.fromNow ? NO_CAP : toSeconds(x.upTo ?? 0), from_now: Boolean(x.fromNow) } })), ...life.raises],
    window: windowOf(r, m.now),
    per_wallet: perWalletOf(r),
  };
}

export function scheduleArgs(s, m) {
  const every = toSeconds(s.every);
  const poolOf = (key) => m.pool.get(key)?.index ?? 0;
  let action;
  if (s.does === 'issue') {
    const t = m.tokens.get(s.currency ?? m.pool.get(s.pool)?.currency);
    action = { from: { Mint: [`@mint:${t?.key}`] }, to: { Pool: [poolOf(s.pool)] }, amount: { Fixed: [amount(s.amount, t)] }, halve_every: s.halveEvery ?? 0 };
  } else if (s.sealed) {
    // A sealed schedule pays from its own vault, in `currency`.
    const t = m.tokens.get(s.currency ?? m.currencyKey);
    const how = s.percent !== undefined ? { Bps: [Math.round(s.percent * 100)] } : { Fixed: [amount(s.amount, t)] };
    action = { from: { Vest: [`@mint:${t?.key}`] }, to: toEnum(s.to, m), amount: how, halve_every: s.halveEvery ?? 0 };
  } else {
    const from = s.does === 'burn' ? s.pool : s.from;
    const t = m.poolToken(from);
    const to = s.does === 'burn' ? 'Burn' : s.does === 'move' ? { Pool: [poolOf(s.to)] } : toEnum(s.to, m);
    const how = s.percent !== undefined ? { Bps: [Math.round(s.percent * 100)] } : { Fixed: [amount(s.amount, t)] };
    action = { from: { Pool: [poolOf(from)] }, to, amount: how, halve_every: s.halveEvery ?? 0 };
  }
  return { active: s.active !== false, action, every: BigInt(every), next_at: BigInt(s.start ? toTime(s.start, m.now) : m.now + every), max_runs: s.maxRuns ?? 0 };
}

/**
 * The program's `Prize` for a prize line (`model.prizeLine`): tokens minted or from a pool (a fixed amount, or a share
 * of the pool), an item (a compressed NFT of it into the project's tree, "@tree"), one NFT of a stash, or a roll of a box.
 */
export function prizeArgs(p, m) {
  const line = prizeLine(p);
  if (line.gives === 'item' && line.compressed) return { Compressed: { item: m.item.get(line.item)?.id ?? 0, tree: '@tree' } };
  if (line.gives === 'item') return { Item: [m.item.get(line.item)?.id ?? 0] };
  // An NFT a lottery's place holds in the lottery's own stash (a raffle), or one of a project stash.
  if (line.gives === 'nft' && line.held) return { Held: [line.nft] };
  // An NFT drawn at random from the lottery's own stash (a raffle of many NFTs).
  if (line.gives === 'raffled') return 'Raffled';
  if (line.gives === 'nft') return { Nft: { stash: m.stash.get(line.stash)?.id ?? 0, nft: line.nft } };
  if (line.gives === 'roll') return { Roll: [m.box.get(line.box)?.id ?? 0] };
  const pool = prizePool(line);
  const from = pool ? { Pool: [m.pool.get(pool)?.index ?? 0] } : { Mint: [`@mint:${line.currency ?? m.currencyKey}`] };
  if (line.gives === 'share') return { Tokens: { from, amount: { Bps: [Math.round((line.percent ?? 0) * 100)] } } };
  return { Tokens: { from, amount: { Fixed: [amount(line.amount, prizeToken(line, m))] } } };
}

/**
 * A grant list's leaves: a plain address is the grant's amount in round 0; an entry { wallet, amount, round } names
 * its own amount (whole units of `t`, the grant's token) and round, so one wallet listed under several rounds claims
 * each once (monthly vesting, a season's airdrop).
 */
export const listLeaves = (list, t) => list.map((e) => (typeof e === 'string' ? loot.listLeaf(e, null) : loot.listLeaf(e.wallet, null, loot.listRound(e.round ?? 0), e.amount !== undefined ? amount(e.amount, t) : 0n)));

/** A prize line's `Prize`, or null for none. */
const prizeOrNull = (p, m) => (prizeLine(p) ? prizeArgs(p, m) : null);

/**
 * A lottery's args: its own pot in `currency` (the project's by default), ticket money split by `split` (and
 * `cutPercent` to the treasury) with the rest into the pot. No `every` draws once, at `firstDraw`.
 */
export function lotteryArgs(l, m) {
  const potKey = l.currency ?? m.currencyKey;
  const potToken = m.tokens.get(potKey);
  const ticket = l.ticketCurrency ? m.tokens.get(l.ticketCurrency) : potToken;
  const every = toSeconds(l.every);
  return {
    // What a round copies at its first purchase.
    terms: {
      price: l.ticketNft ? 0n : amount(l.price, ticket),
      mint: `@mint:${potKey}`,
      shares: shares(lotterySplit(l), m),
      // A place takes a share of the pot, a prize for its winner, or both.
      // A run of `times` places alike: "places 2 to 201 each take 1%" is one.
      places: (l.places ?? []).map(placeOf).map((p) => ({ bps: Math.round(p.percent * 100), prize: prizeOrNull(p.prize, m), times: p.times })),
      ticket_mint: l.ticketCurrency ? `@mint:${l.ticketCurrency}` : '11111111111111111111111111111111',
      draws_at: BigInt(l.firstDraw ? toTime(l.firstDraw, m.now) : m.now + every),
      // A ticket paid with one NFT that passes the rule, in place of tokens.
      nft_ticket: l.ticketNft ? { rule: ruleOf(l.ticketNft.rule, m), then: spendOf(l.ticketNft.then, m) } : null,
      // No loss: every ticket goes back to its buyer once the round is drawn; the winners take the pot alone.
      returns: Boolean(l.noLoss),
      // A least sale: a round that sold fewer tickets is cancelled at its draw and refunded.
      min_sold: BigInt(l.minSold ?? 0),
    },
    every: BigInt(every),
    gate: gateOf(l.gate, m),
    per_wallet: l.perWallet ?? 0,
  };
}

/**
 * The args the authority opens a contest with, `at` (Unix seconds) its opening: its sides, when entries close and the
 * result is due, its split, its gate (a list of wallets for a duel), the keys that may decide it, the least pot (an
 * all-or-nothing crowdfund) and the stake every entry puts in.
 */
export function contestArgs(c, m, at = m.now) {
  const t = m.priceToken(c);
  // A decider's verdict is taken once entries close, so with deciders entries close before the result is due (the
  // program refuses them at once): with no "entriesClose", an hour before the result is due (halfway for a contest
  // shorter than two hours); with no "resultDue", an hour after entries close.
  const deciders = (c.deciders ?? []).length > 0;
  const due = c.resultDue === undefined && c.entriesClose !== undefined && deciders ? toSeconds(c.entriesClose) + 3600 : toSeconds(c.resultDue ?? c.entriesClose ?? '1d');
  const closes = c.entriesClose !== undefined ? toSeconds(c.entriesClose) : deciders ? due - Math.min(3600, Math.floor(due / 2)) : due;
  return {
    sides: c.sides,
    closes_at: BigInt(at + closes),
    result_by: BigInt(at + due),
    shares: shares(c.split, m),
    gate: gateOf(c.gate, m),
    deciders: c.deciders ?? [],
    // A contest of NFTs counts its pot in NFTs.
    min_pot: c.stakeNft ? wholeCount(c.minPot) ?? 0n : amount(c.minPot ?? 0, t),
    stake: amount(c.stake ?? 0, t),
    prize: prizeOrNull(c.prize, m),
    // A token prize set aside whole at the decision and split among the winners by what each put in.
    prize_split: Boolean(c.prize?.split),
    // Each entry stakes one NFT that passes this rule, and the NFTs are the pot: each winner shares the losers', at most
    // `losersEach` of them (none: no cap).
    nft: c.stakeNft ? ruleOf(c.stakeNft, m) : null,
    cap: c.stakeNft && c.losersEach ? c.losersEach : null,
  };
}

export function farmArgs(f, m) {
  const tiers = (f.tiers ?? [{ lock: 0, multiplier: 1 }]).map((t) => ({
    lock: toSeconds(t.lock),
    bps: Math.round((t.multiplier ?? 1) * 10_000),
    prize: prizeOrNull(t.prize, m),
    roll: t.roll ? m.box.get(t.roll)?.id ?? 0 : null,
    // A token seat may leave before this tier's lock by leaving this share of what it takes out.
    exit_bps: Math.round((t.exitFee ?? 0) * 100),
    // How long a seat of this tier earns from its stake (0: no end). The spec has no field for it yet.
    earns_for: 0,
  }));
  // Every rule of its gate; with none, a farm of one item's collectibles takes that item.
  const named = listOf(f.gate);
  const gates = f.stakes !== 'collectibles' ? [] : (named.length ? named : f.item ? [{ item: f.item, attribute: 'item_id' }] : []).map((r) => ruleOf(r, m));
  // A rate is per NFT_UNIT of weight: one collectible, or 1,000,000 base units of a staked token.
  const rewards = m.poolToken(f.rewards);
  const staked = f.stakes === 'collectibles' ? null : m.tokens.get(f.stakes);
  const perDay = f.rate ? amount(f.rate.perDay, rewards) : 0n;
  return {
    custody: { freeze: 'Freeze', watch: 'Watch' }[f.custody] ?? 'Escrow',
    rewards_pool: m.pool.get(f.rewards)?.index ?? 0,
    tiers,
    boosts: (f.boosts ?? []).map((b) => ({ rule: ruleOf(b.when, m), effect: effectOf(b.add) })),
    max_boost_bps: Math.round((f.maxBoostPercent ?? 0) * 100),
    gates,
    rate: f.rate ? { per_day: staked ? (perDay * 1_000_000n) / 10n ** BigInt(staked.decimals ?? 0) : perDay, mints: Boolean(f.rate.minted) } : null,
    growth: listOf(f.growth).map((g) => ({ key: g.attribute ?? 'xp', per_day: g.perDay, level: (g.levels ?? []).length ? g.level ?? 'level' : '', steps: g.levels ?? [], streak: Boolean(g.streak), profile: false, at_least: 0n })),
    // A farm that runs for a time ends that long after it goes live.
    ends_at: f.runs ? BigInt(m.now + toSeconds(f.runs)) : 0n,
    // The times it keeps on what is staked: its lock, and an upkeep.
    lock_key: f.lockAttribute ?? '',
    upkeep_key: f.upkeepAttribute ?? '',
    // Where an early exit's fee goes, how long a stake waits on its way out, and a toll on every payout of rewards.
    exit_to: f.exitFeeTo ? sinkOf(f.exitFeeTo, m) : null,
    unbond: f.unbond ? toSeconds(f.unbond) : 0,
    toll: f.toll ? { bps: Math.round(f.toll.percent * 100), to: sinkOf(f.toll.to, m) } : null,
  };
}

/** A fee's sink (`Sink`): "burn", or "pool:<key>", one of the project's pools. */
export const sinkOf = (to, m) => (to === 'burn' ? 'Burn' : { Pool: [m.pool.get(String(to).replace(/^pool:/, ''))?.index ?? 0] });

/** An auction's args: its lot, reserve, least raise, times and split. "start" is when it goes live unless it says. */
export function auctionArgs(a, m) {
  const t = m.priceToken(a);
  const startsAt = toTime(a.start, m.now);
  return {
    lot: a.lot?.asset ? { Asset: [a.lot.asset] } : a.lot?.roll ? { Roll: [rollOf(a.lot.roll, m)] } : { Item: [m.item.get(a.lot?.item)?.id ?? 0] },
    // With NFT bids, the reserve counts NFTs.
    reserve: a.bidNfts ? BigInt(a.reserve ?? 1) : amount(a.reserve ?? 0, t),
    min_raise_bps: Math.round((a.minRaise ?? 5) * 100),
    starts_at: BigInt(startsAt),
    ends_at: BigInt(startsAt + toSeconds(a.runs)),
    extend: toSeconds(a.extendBy ?? '10m'),
    shares: shares(a.split, m),
    gate: gateOf(a.gate, m),
    // A bid is a bundle of NFTs that pass this rule, in place of tokens.
    nft_bids: a.bidNfts ? ruleOf(a.bidNfts, m) : null,
  };
}

const NOBODY = '11111111111111111111111111111111';
/** The program id of the box a prize rolls (a box key), or null for none. */
const rollOf = (box, m) => (box ? m.box.get(box)?.id ?? 0 : null);

export function grantArgs(g, m) {
  const gives = prizeArgs(g.prize ?? g.gives, m);
  const vouchers = [...(g.vouchers ?? []), NOBODY, NOBODY, NOBODY].slice(0, 3);
  const list = g.list ?? [];
  const keys = g.keys ?? [];
  const l = g.limits ?? {};
  return {
    gives,
    vouchers,
    list_root: list.length ? loot.merkleRoot(listLeaves(list, prizeToken(prizeLine(g.prize ?? g.gives), m))) : new Uint8Array(32),
    key_root: keys.length ? loot.merkleRoot(keys.map((k) => loot.keyLeaf(k))) : new Uint8Array(32),
    // A grant that names no voucher key and no list is one any wallet may claim, within its limits.
    open: !(g.vouchers ?? []).length && !list.length && !keys.length,
    limits: {
      wallet: perWalletOf(l),
      per_person: l.perPerson ?? 0,
      per_key: l.perKey ?? 0,
      // Every wallet's claims together: in all, and a day (a window of 86,400 seconds, from the unix epoch).
      all: { total: l.total ?? 0, per_window: l.perDay ?? 0, window: l.perDay ? 86_400 : 0 },
      window: windowOf({ opens: l.opens, closes: l.until }, m.now),
    },
    active: g.active !== false,
    gate: gateOf(g.gate, m),
    // Its records in 2^bits lists, the fewest that keep each under ~100,000 over its life (wallets × rounds).
    shard_bits: loot.shardBitsFor(g.wallets ?? list.length ?? 0, g.rounds ?? 1),
  };
}

// ---------------------------------------------------------------- resolving "@" names at build time

/**
 * Replaces "@mint:<key>" strings anywhere in `value` with the mint `ctx` names, "@ata:<wallet>:<key>" with that
 * wallet's token account for it, "@pot:<id>" with a lottery's pot and "@farm:<id>" with a farm's address.
 */
function resolve(value, ctx) {
  if (value === '@treasury') {
    if (!ctx.treasury) throw new Error('No treasury yet for a roll that gives an NFT to it.');
    return ctx.treasury;
  }
  if (value === '@collection') {
    if (!ctx.collection) throw new Error('No collection yet for a rule or an item about the project’s collection.');
    return ctx.collection;
  }
  if (value === '@tree') {
    if (!ctx.tree) throw new Error('No tree yet for a compressed prize.');
    return ctx.tree;
  }
  if (typeof value === 'string' && value.startsWith('@mint:')) {
    const key = value.slice(6);
    const mint = ctx.mints[key];
    if (!mint) throw new Error(`No mint yet for the token “${key}”.`);
    return mint;
  }
  if (typeof value === 'string' && value.startsWith('@farm:')) {
    if (!ctx.project) throw new Error('No project yet for a stake gate’s farm.');
    return loot.pda.farm(ctx.project, Number(value.slice(6)));
  }
  if (typeof value === 'string' && value.startsWith('@pot:')) {
    if (!ctx.project) throw new Error('No project yet for a lottery’s pot.');
    return loot.pda.pot(loot.pda.lottery(ctx.project, Number(value.slice(5))));
  }
  if (typeof value === 'string' && value.startsWith('@ata:')) {
    const [, wallet, key, program] = value.split(':');
    const mint = ctx.mints[key];
    if (!mint) throw new Error(`No mint yet for the token “${key}”.`);
    return loot.ata(wallet, mint, program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
  if (value instanceof Uint8Array || typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]));
}

// ---------------------------------------------------------------- the steps

const encodedSize = loot.accountBytes;
/** Bubblegum's config of a tree. */
const TREE_CONFIG_BYTES = 96;
const placeholderKey = (name) => encodeBase58(sha256(utf8(`loot-plan:${name}`)));

/**
 * Every step that sets the economy up, in order: the tokens the project mints, the collection, the project, the pools, items, boxes (the shop's too), recipes, schedules, lotteries, grants,
 * farms, auctions, then the seeds and the grants' funds. `only` limits it to these part ids (a change to a live economy).
 *
 * A farm opens before the seed of its rewards pool lands, and anyone may stake in between. That is safe: a sharing
 * farm credits nothing at once, and releases what lands in its pool over its longest lock (a day at least) to the
 * seats there as it is released, its clock stopped while nobody is in. A seed that lands
 * before the first stake or after it is released the same way from that stake on, so seeding first would change nothing.
 */
export function setupSteps(economy, { now = 0, only = null, live: given = null } = {}) {
  const m = model(economy, { now });
  const live = madeSoFar(given);
  const steps = [];
  const want = (id) => !only || only.has(id);
  const landed = new Set(live?.landed ?? []);
  const add = (step) => want(step.part) && !landed.has(step.id) && steps.push({ creates: [], signers: [owner], ...step });
  const project = (ctx) => ctx.project;
  const fresh = !live?.project;

  // Tokens the project mints: a classic mint with the owner as its authority, handed to the project right after.
  for (const t of m.tokens.values()) {
    if (t.source !== 'game' || live?.mints?.[t.key] || t.mint && !t.mint.startsWith('@')) continue;
    const key = `new:mint/${t.key}`;
    if (t.fixedSupply) {
      const supply = amount(t.supply, t);
      add({
        id: `token:${t.key}`,
        part: `token:${t.key}`,
        says: `Make the token ${t.symbol} (${t.decimals} decimals) with a fixed supply of ${t.supply}, all of it to your wallet, then turn its minting off for good`,
        signers: [owner, key],
        creates: [{ what: `the mint of ${t.symbol}`, bytes: MINT_BYTES }, { what: `your ${t.symbol} account`, bytes: 165 }],
        build: (ctx) => [
          createAccountIx({ from: ctx.owner, address: ctx.keys[key], lamports: ctx.rent(MINT_BYTES), space: MINT_BYTES, owner: TOKEN_PROGRAM }),
          initializeMint2Ix({ mint: ctx.keys[key], decimals: t.decimals, authority: ctx.owner }),
          createAssociatedTokenAccountIdempotent(ctx.owner, ctx.owner, ctx.keys[key]),
          mintToIx({ mint: ctx.keys[key], to: loot.ata(ctx.owner, ctx.keys[key]), authority: ctx.owner, amount: supply }),
          setAuthorityIx({ account: ctx.keys[key], current: ctx.owner, newAuthority: null }),
        ],
      });
      continue;
    }
    add({
      id: `token:${t.key}`,
      part: `token:${t.key}`,
      says: `Make the token ${t.symbol} (${t.decimals} decimals), then hand its minting to the project`,
      signers: [owner, key],
      creates: [{ what: `the mint of ${t.symbol}`, bytes: MINT_BYTES }],
      build: (ctx) => [
        createAccountIx({ from: ctx.owner, address: ctx.keys[key], lamports: ctx.rent(MINT_BYTES), space: MINT_BYTES, owner: TOKEN_PROGRAM }),
        initializeMint2Ix({ mint: ctx.keys[key], decimals: t.decimals, authority: ctx.owner }),
        setAuthorityIx({ account: ctx.keys[key], current: ctx.owner, newAuthority: ctx.project }),
      ],
    });
  }

  // The collection and the project. A spec that gives compressed NFTs makes its collection with Bubblegum's plugin,
  // which only a new collection can carry.
  const tree = compressedTree(m);
  if (fresh) {
    const c = m.collection;
    if (c)
      add({
        id: 'collection',
        part: 'project',
        says: `Make the collection “${c.name}”, with ${c.royaltyPercent ?? 5}% resale royalty to you; the project may mint into it${tree ? ', as Core NFTs or compressed ones' : ''}`,
        signers: [owner, 'new:collection'],
        creates: [{ what: 'the collection', bytes: 1 + 32 + 4 + c.name.length + 4 + (c.uri ?? '').length + 140 + (tree ? 3 : 0), approx: true }],
        build: (ctx) => [createCollectionInstruction({ collection: ctx.keys['new:collection'], creator: ctx.owner, project: ctx.project, name: c.name, uri: c.uri ?? '', royaltyBps: Math.round((c.royaltyPercent ?? 5) * 100), compressed: Boolean(tree) })],
      });
    // The treasury is a wallet: the remainder of every split goes to its account of that mint, which the program
    // opens when it is not there. The project's vaults, and every account a share pays, open the same way when first
    // paid, so the setup opens none of them.
    const collections = (ctx) => [...(ctx.collection ? [ctx.collection] : []), ...m.collections];
    const count = (c ? 1 : 0) + m.collections.length;
    add({
      id: 'project',
      part: 'project',
      says: `Open the project on the loot program${count ? ` with ${count === 1 ? 'its collection' : `its ${count} collections`}` : ', with no collection'}; ${m.authority === 'owner' ? 'your wallet' : m.authority} signs its decisions, and ${m.treasuryWallet ?? 'your wallet'} is its treasury`,
      creates: [{ what: 'the project', bytes: loot.projectBytes(count) }, { what: 'the project’s fee box', bytes: 0 }],
      build: (ctx) => [loot.createProjectIx({ owner: ctx.owner, id: m.projectNumber, collections: collections(ctx), treasury: ctx.treasury, authority: ctx.authority })],
    });
  }

  // The tree compressed prizes are minted into: made empty by the owner, then opened with the project as its creator.
  if (tree && !live?.tree)
    add({
      id: 'tree',
      part: 'tree',
      says: `Open the project’s tree of compressed NFTs, for ${(2 ** tree.depth).toLocaleString('en-US')} of them in all`,
      signers: [owner, 'new:tree'],
      creates: [{ what: 'the tree of compressed NFTs', bytes: tree.bytes }, { what: 'the tree’s config (Bubblegum’s)', bytes: TREE_CONFIG_BYTES }],
      build: (ctx) => [
        createAccountIx({ from: ctx.owner, address: ctx.keys['new:tree'], lamports: ctx.rent(tree.bytes), space: tree.bytes, owner: loot.COMPRESSION_PROGRAM }),
        loot.openTreeIx({ signer: ctx.owner, project: project(ctx), tree: ctx.keys['new:tree'], maxDepth: tree.depth, maxBufferSize: tree.buffer }),
      ],
    });

  // The token accounts players' purchases would otherwise open (the owner pays their rent now, about 0.002 SOL each,
  // so no player's purchase pays another wallet's): the treasury's of each coin the economy takes, the project's vault
  // of each coin a box or an auction holds, and each fixed wallet's a split pays.
  const accounts = goLiveAccounts(m);
  if (fresh && accounts.length)
    add({
      id: 'accounts',
      part: 'project',
      says: `Open ${accounts.length} token account${accounts.length === 1 ? '' : 's'} the economy pays into (the treasury’s, the project’s vaults, the wallets its splits name), so no player’s purchase opens them`,
      creates: accounts.map((x) => ({ what: `${x.who}’s account of ${m.tokens.get(x.token)?.symbol ?? x.token}`, bytes: 165 })),
      build: (ctx) => accounts.map((x) => createAssociatedTokenAccountIdempotent(ctx.owner, x.who === 'the project' ? ctx.project : x.who === 'the treasury' ? ctx.treasury : x.who, ctx.mints[x.token], programsOf(ctx)[ctx.mints[x.token]] ?? TOKEN_PROGRAM)),
    });

  // The project's standing lookup table (the owner its authority): the addresses its transactions name most, so a
  // transaction too big for a legacy one goes as v0 with it in one approval, never with a table of its own. Made with
  // the first of its addresses, then extended a group a step.
  if (fresh) {
    const named = standingAddresses(m);
    groupsOf(named, TABLE_GROUP).forEach((group, i) =>
      add({
        id: i ? `table:${i}` : 'table',
        part: 'project',
        says: i ? `Add ${group.length} more addresses to the project’s lookup table` : `Make the project’s lookup table of the ${named.length} addresses its transactions name most, so a large one takes one approval`,
        creates: i ? [{ what: `room for ${group.length} addresses in the lookup table`, bytes: 32 * group.length, grows: true }] : [{ what: 'the project’s lookup table', bytes: 56 + 32 * group.length }],
        build: (ctx) => {
          // With no recent slot known (a plan built offline), there is no table to make.
          if (ctx.slot == null) return [];
          const { address: table, instruction } = createTableIx({ authority: ctx.owner, slot: ctx.slot });
          return [...(i ? [] : [instruction]), extendTableIx({ table, authority: ctx.owner, addresses: group.map((at) => at(ctx)).filter(Boolean) })];
        },
      }));
  }

  for (const p of m.pools) {
    const t = m.tokens.get(p.currency);
    add({ id: `pool:${p.key}`, part: `pool:${p.key}`, says: `Open the pool “${p.key}” for ${t?.symbol}`, creates: [{ what: `the pool “${p.key}”`, bytes: 165 }], build: (ctx) => [loot.openPoolIx({ owner: ctx.owner, project: project(ctx), index: p.index, mint: ctx.mints[p.currency] })] });
  }
  const record = (part, def, says, kind, what, options = () => ({})) => {
    const [variant] = Object.keys(def);
    const bytes = recordBytesOf(kind, def[variant]);
    // A lottery's first write opens its pot: a token account as well as the record (each round holds its own money).
    const pot = kind === 'Lottery' ? [{ what: `${what}’s pot`, bytes: 165 }] : def.Schedule?.args.action.from.Vest ? [{ what: `${what}’s sealed vault`, bytes: 165 }] : [];
    add({
      id: `${part}:${kind}`, part, says, creates: [{ what, bytes }, ...pot],
      build: (ctx) => [loot.upsertIx({ owner: ctx.owner, project: project(ctx), def: resolve(def, ctx), ...options(ctx) })],
    });
  };
  // Each table, a batch of rows a transaction (`TABLE_BATCH_BYTES` of rows at most), sealed with its last batch.
  for (const t of m.tables) {
    const batches = tableBatches(t);
    const len = t.kind === 'numbers' ? 8 : 40;
    batches.forEach((rows, i) => {
      const seal = i === batches.length - 1;
      add({
        id: `table:${t.key}:${i}`,
        part: `table:${t.key}`,
        says: `Write ${rows.length} row${rows.length === 1 ? '' : 's'} of the table “${t.key}”${seal ? ', and seal it: its weights never change from now on' : ''}`,
        creates: i === 0 ? [{ what: `the table “${t.key}”, ${t.rows.length} rows`, bytes: loot.tableRowAt(len, t.rows.length - 1) + len }] : [],
        build: (ctx) => [loot.upsertIx({ owner: ctx.owner, project: project(ctx), def: { Table: { id: t.id, args: { payload: t.kind === 'numbers' ? 'Number' : 'Label', rows, seal } } } })],
      });
    });
  }
  for (const it of m.items) record(`item:${it.key}`, { Item: { id: it.id, args: itemArgs(it, m) } }, `${it.active === false ? 'Switch off' : 'Write'} the item “${it.name}”`, 'Item', `the item “${it.name}”`);
  // A box's line names its odds, so the owner sees what they approve (above all when a live box's odds change).
  const odds = (b) => {
    const ws = weights(b);
    const total = ws.reduce((n, w) => n + w, 0) || 1;
    const part = (o) => (o.gives === 'item' ? m.item.get(o.item)?.name ?? o.item : o.gives === 'stash' ? `an NFT of “${m.stash.get(o.stash)?.name ?? o.stash}”` : o.gives === 'pay' ? `${o.amount} ${m.poolToken(o.pool)?.symbol ?? ''}`.trim() : o.gives === 'share' ? `${o.percent}% of “${o.pool}”` : o.gives === 'mint' ? `${o.amount} ${m.tokens.get(o.currency ?? m.currencyKey)?.symbol ?? ''}`.trim() : o.gives === 'nft' ? `the NFT ${String(o.nft).slice(0, 4)}…` : o.gives === 'roll' ? `a roll of “${m.box.get(o.box)?.name ?? o.box}”` : '');
    const what = (o) => outcomeParts(o).map(part).join(' + ') || 'nothing';
    return (b.outcomes ?? []).map((o, i) => `${what(o)} ${Math.round((ws[i] / total) * 10_000) / 100}%`).join(', ');
  };
  const wasLive = new Set((live?.published?.boxes ?? []).map((b) => b.key));
  // A box is written before any box that names it to roll (one may name itself): in that order.
  const boxOrder = [];
  const visit = (b, path = new Set()) => {
    if (boxOrder.includes(b) || path.has(b)) return;
    path.add(b);
    for (const id of loot.defRolls({ Box: { args: boxArgs(b, m) } })) {
      const named = m.allBoxes.find((x) => x.id === id);
      if (named && named !== b) visit(named, path);
    }
    boxOrder.push(b);
  };
  for (const b of m.allBoxes) visit(b);
  for (const b of boxOrder) {
    const says = b.shopOf ? `Put “${b.name}” in the shop at ${b.price} ${m.priceToken(b)?.symbol}` : `${b.active === false ? 'Switch off' : wasLive.has(b.key) ? 'Change' : 'Put on sale'} the box “${b.name}” at ${b.price} ${m.priceToken(b)?.symbol}${b.active === false ? '' : `: ${odds(b)}`}`;
    record(b.shopOf ? `item:${b.shopOf}` : `box:${b.key}`, { Box: { id: b.id, args: boxArgs(b, m) } }, says, 'LootBox', b.shopOf ? `the shop listing of “${b.name}”` : `the box “${b.name}”`);
  }
  for (const r of m.recipes) record(`recipe:${r.key}`, { Recipe: { id: r.id, args: recipeArgs(r, m) } }, `Write the recipe “${r.name}”`, 'Recipe', `the recipe “${r.name}”`);
  for (const s of m.schedules) {
    // A sealed schedule that pays a lottery's pot names the lottery when it is written (the pot is the project's own).
    const pays = destination(s.to ?? '');
    const lottery = s.sealed && pays.kind === 'lottery' ? m.lottery.get(pays.key) : null;
    record(`schedule:${s.key}`, { Schedule: { id: s.id, args: scheduleArgs(s, m) } }, `${s.active === false ? 'Stop' : 'Start'} the ${s.sealed ? 'sealed ' : ''}schedule “${s.name ?? s.key}”`, 'Schedule', `the schedule “${s.name ?? s.key}”`, (ctx) => (lottery ? { lottery: loot.pda.lottery(project(ctx), lottery.id) } : {}));
    // A sealed schedule's vault is funded once, at go-live: from the owner's wallet, minted, or from a pool.
    const id = `fund:${s.key}`;
    if (!s.sealed || !Number(s.fund ?? 0) || (live?.landed ?? []).includes(id) || live?.published?.schedules?.some((x) => x.key === s.key)) continue;
    const t = m.tokens.get(s.currency ?? m.currencyKey);
    const from = s.fundFrom ?? 'wallet';
    add({
      id,
      part: `schedule:${s.key}`,
      signers: from === 'wallet' || m.authority === 'owner' ? [owner] : ['authority'],
      says: `Put ${s.fund} ${t?.symbol ?? ''} in the sealed schedule “${s.name ?? s.key}”${from === 'wallet' ? ' from your wallet' : from === 'mint' ? ', minted' : ` from “${from.slice(5)}”`}: nobody can take it back`,
      creates: [],
      build: (ctx) => {
        const mint = ctx.mints[t.key];
        const vest = loot.pda.vest(loot.pda.schedule(project(ctx), s.id));
        const value = amount(s.fund, t);
        if (from === 'wallet') {
          const tokenProgram = programsOf(ctx)[mint] ?? TOKEN_PROGRAM;
          // SOL is wrapped first, as a seed is: the owner's wallet holds it as plain SOL, the vault takes wrapped SOL.
          const wrap = t.wsol ? [createAssociatedTokenAccountIdempotent(ctx.owner, ctx.owner, NATIVE_MINT), transferLamports(ctx.owner, loot.ata(ctx.owner, NATIVE_MINT), value), syncNative(loot.ata(ctx.owner, NATIVE_MINT))] : [];
          return [...wrap, transferCheckedIx({ from: loot.ata(ctx.owner, mint, tokenProgram), mint, to: vest, owner: ctx.owner, amount: value, decimals: t.decimals ?? 0, tokenProgram })];
        }
        const source = from === 'mint' ? { Mint: [mint] } : { Pool: [m.pool.get(from.slice(5))?.index ?? 0] };
        return [loot.moveTokensIx({ authority: ctx.authority, project: project(ctx), mint, from: source, to: { Account: [vest] }, amount: { Fixed: [value] }, programs: programsOf(ctx) })];
      },
    });
  }
  for (const l of m.lotteries) {
    // A raffle's NFTs go into the lottery's own stash first, several a call: the lottery is written naming NFTs already
    // there, or drawing from as many as its places.
    const raffled = [...(l.places ?? []).map(placeOf).filter((p) => p.prize?.held).map((p) => ({ nft: p.prize.nft, collection: p.prize.collection })), ...(l.nfts ?? []).map((n) => (typeof n === 'string' ? { nft: n } : n))];
    const opened = live?.published?.lotteries?.some((x) => x.key === l.key);
    groupsOf(raffled.filter((n) => !(live?.landed ?? []).includes(`stash:lottery-${l.key}:${n.nft}`)), STASH_GROUP).forEach((group, i) => {
      if (opened) return;
      add({
        id: `stash:lottery-${l.key}:${group.map((n) => n.nft).join(',')}`,
        part: `lottery:${l.key}`,
        says: `Put your NFT${group.length === 1 ? ` ${group[0].nft}` : `s ${group.map((n) => n.nft).join(', ')}`} in the lottery “${l.name}”: ${group.length === 1 ? 'it stays' : 'they stay'} there until ${group.length === 1 ? 'its winner takes it' : 'their winners take them'}, and nobody, you included, can take ${group.length === 1 ? 'it' : 'them'} out before`,
        creates: i === 0 ? [{ what: `the lottery “${l.name}”’s stash`, bytes: stashBytes(raffled.length) }] : [],
        build: (ctx) => [loot.stashIx({ signer: ctx.owner, project: project(ctx), lottery: l.id, asset: group[0].nft, collection: group[0].collection ?? ctx.collection, more: group.slice(1).map((n) => ({ asset: n.nft, collection: n.collection ?? ctx.collection })) })],
      });
    });
    record(`lottery:${l.key}`, { Lottery: { id: l.id, args: lotteryArgs(l, m) } }, `Start the ${l.raffle ? 'raffle' : 'lottery'} “${l.name}”`, 'Lottery', `the lottery “${l.name}”`);
  }
  for (const g of m.grants) record(`grant:${g.key}`, { Grant: { id: g.id, args: grantArgs(g, m) } }, `Write the grant “${g.name}”`, 'Grant', `the grant “${g.name}”`);
  /** The boxes a farm's tiers roll, tier by tier (its roll, then a prize that is a roll). */
  for (const f of m.farms) {
    if (live?.farms?.includes(f.key)) continue;
    const rewards = m.poolToken(f.rewards);
    add({
      id: `farm:${f.key}`,
      part: `farm:${f.key}`,
      says: `Open the farm “${f.name}”: stake ${f.stakes === 'collectibles' ? 'collectibles' : m.tokens.get(f.stakes)?.symbol}, earn ${rewards?.symbol} from “${f.rewards}”`,
      creates: [{ what: `the farm “${f.name}”`, bytes: encodedSize('Farm', { project: NOBODY, id: 0, farmed: f.stakes === 'collectibles' ? 'Collectibles' : { Tokens: { mint: NOBODY } }, ...placeholders(farmArgs(f, m)), rewards_mint: NOBODY, rate_at: 0n, rate_carry: 0n, total_weight: 0n, reward_per_weight: 0n, reward_remainder: 0n, given: 0n, unreleased: 0n, released_at: 0n, release_ends: 0n, release_from: 0n, release_base: 0n }) }, { what: 'its rewards vault', bytes: 165 }, ...(f.stakes === 'collectibles' ? [] : [{ what: 'its stake vault', bytes: 165 }])],
      build: (ctx) => [loot.openFarmIx({ owner: ctx.owner, project: project(ctx), id: f.id, args: resolve(farmArgs(f, m), ctx), rewardsMint: ctx.mints[rewards.key], stakedMint: f.stakes === 'collectibles' ? null : ctx.mints[f.stakes] })],
    });
  }

  // Traits the project vouches for from NFTs' off-chain metadata: one Merkle root per collection, signed once.
  const vouched = new Map((live?.published?.traits ?? []).map((t) => [t.collection, t.root]));
  for (const t of m.traits) {
    if (vouched.get(t.collection) === t.root) continue;
    add({
      id: `traits:${t.collection}`,
      part: `traits:${t.collection}`,
      says: `Vouch for the traits of the NFTs of ${t.collection} (a root of their off-chain metadata)`,
      creates: [{ what: `the traits of ${t.collection}`, bytes: 1 + 32 * 3 }],
      build: (ctx) => [loot.setTraitsIx({ signer: ctx.owner, project: project(ctx), key: t.collection, root: Uint8Array.from(t.root.match(/../g).map((h) => parseInt(h, 16))) })],
    });
  }

  // Stashes: the owner's wallet hands each NFT it lists to the project, one instruction each (`stash`). A compressed NFT
  // needs a proof fetched when it is signed, so the checker leaves those to `loot.stashIx` after go-live.
  // What is in a live stash already: what its last publish listed, and the steps of this one that landed.
  const stashed = new Set([
    ...(live?.published?.stashes ?? []).flatMap((s) => stashNfts(s).map((n) => `${s.key}:${n.asset}`)),
    // A step puts in a group of NFTs: `stash:<key>:<asset>,<asset>…`.
    ...(live?.landed ?? []).filter((id) => id.startsWith('stash:')).flatMap((id) => {
      const [key, assets = ''] = id.slice(6).split(/:(.*)/s);
      return assets.split(',').map((asset) => `${key}:${asset}`);
    }),
  ]);
  for (const s of m.stashes) {
    const nfts = stashNfts(s);
    const putting = nfts.filter((n) => n.kind !== 'compressed' && !stashed.has(`${s.key}:${n.asset}`));
    // The first NFT this plan puts in names the stash's rent: all of it for a new stash, what it grows by for one live already.
    const fresh = !nfts.some((n) => stashed.has(`${s.key}:${n.asset}`));
    // Several NFTs a call, each with its weight: Core NFTs a group of `STASH_GROUP`, Token Metadata ones two (each takes
    // more accounts).
    const kindOf = (n) => ({ asset: n.asset, weight: n.weight, collection: n.kind === 'core' ? n.collection : undefined, tokenMetadata: n.kind === 'token-metadata' ? { programmable: n.programmable, ruleSet: n.ruleSet ?? undefined } : undefined });
    const groups = [...groupsOf(putting.filter((n) => n.kind === 'core'), STASH_GROUP), ...groupsOf(putting.filter((n) => n.kind !== 'core'), 2)];
    for (const [i, group] of groups.entries()) {
      add({
        id: `stash:${s.key}:${group.map((n) => n.asset).join(',')}`,
        part: `stash:${s.key}`,
        says: `Put your NFT${group.length === 1 ? ` ${group[0].asset}` : `s ${group.map((n) => n.asset).join(', ')}`} in the stash “${s.name}”: the project holds ${group.length === 1 ? 'it' : 'them'} until a prize or a roll gives ${group.length === 1 ? 'it' : 'them'} away`,
        creates: i > 0 ? [] : fresh ? [{ what: `the stash “${s.name}”, with ${putting.length} NFT${putting.length === 1 ? '' : 's'}`, bytes: stashBytes(putting.length) }] : [{ what: `room for ${putting.length} more NFT${putting.length === 1 ? '' : 's'} in “${s.name}”`, bytes: 36 * putting.length, grows: true }],
        build: (ctx) => {
          const [first, ...more] = group.map((n) => {
            const k = kindOf(n);
            return { ...k, collection: n.kind === 'core' ? k.collection ?? ctx.collection : undefined };
          });
          return [loot.stashIx({ signer: ctx.owner, project: project(ctx), id: s.id, ...first, more })];
        },
      });
    }
  }

  // Auctions, each opened by its seller alone: a new unit of an item by the authority, a collectible by the owner who
  // holds it. Its address names the seller (`auctionSeller`).
  for (const a of m.auctions) {
    const t = m.priceToken(a);
    const args = auctionArgs(a, m);
    const asset = Boolean(a.lot?.asset);
    const signer = asset || m.authority === 'owner' ? owner : 'authority';
    const terms = `bids in ${t?.symbol} from ${a.reserve ?? 'any amount'}, for ${a.runs}`;
    add({
      id: `auction:${a.key}`,
      part: `auction:${a.key}`,
      signers: [signer],
      says: asset
        ? `Put your NFT up for auction in “${a.name}”: it stays with the project until someone wins it or the auction ends (${terms})`
        : a.lot?.roll
          ? `Open the auction “${a.name}” of a roll of the box “${m.box.get(a.lot.roll)?.name ?? a.lot.roll}”, made for its winner at the end (${terms})`
          : `Open the auction “${a.name}” of one new “${m.item.get(a.lot?.item)?.name ?? a.lot?.item}” (${terms})`,
      creates: [{ what: `the auction “${a.name}” (back when it ends)`, bytes: encodedSize('Auction', { project: NOBODY, id: 0, seller: NOBODY, mint: NOBODY, lot: args.lot, ours: false, pin: 0, reserve: 0n, min_raise_bps: 0, starts_at: 0n, ends_at: 0n, extend: 0, high_bidder: NOBODY, high: 0n, last_bid_at: 0n, shares: args.shares, gate: args.gate, nft_bids: placeholders(args).nft_bids, held: [] }) }],
      build: (ctx) => {
        const seller = auctionSeller(a, ctx);
        return [loot.openAuctionIx({ seller, project: project(ctx), collection: a.lot?.collection ?? ctx.collection, id: a.id, mint: ctx.mints[t.key], args: resolve(args, ctx) })];
      },
    });
  }

  // Seeds: what the owner puts in each pool. SOL is wrapped into the owner's account first.
  for (const p of m.pools) {
    if (!(Number(p.seed ?? 0) > 0) || live?.seeded?.includes(p.key)) continue;
    const t = m.tokens.get(p.currency);
    const units = amount(p.seed, t);
    if (t.gameMints) {
      const signer = m.authority === 'owner' ? owner : 'authority';
      add({
        id: `seed:${p.key}`,
        part: `seed:${p.key}`,
        signers: [signer],
        says: `Mint ${p.seed} ${t.symbol} into “${p.key}”`,
        build: (ctx) => [loot.moveTokensIx({ authority: ctx.authority, project: project(ctx), mint: ctx.mints[t.key], from: { Mint: [ctx.mints[t.key]] }, to: { Pool: [p.index] }, amount: { Fixed: [units] }, reference: `seed ${p.key}` })],
      });
    } else {
      add({
        id: `seed:${p.key}`,
        part: `seed:${p.key}`,
        says: `Put ${p.seed} ${t.symbol} into “${p.key}”`,
        build: (ctx) => [
          ...(t.wsol ? [createAssociatedTokenAccountIdempotent(ctx.owner, ctx.owner, NATIVE_MINT), transferLamports(ctx.owner, loot.ata(ctx.owner, NATIVE_MINT), units), syncNative(loot.ata(ctx.owner, NATIVE_MINT))] : []),
          loot.payIx({ player: ctx.owner, project: project(ctx), mint: ctx.mints[t.key], treasury: ctx.treasury, amount: units, shares: [{ to: { Pool: [p.index] }, bps: 10_000 }], reference: `seed ${p.key}`, programs: { [ctx.mints[t.key]]: tokenProgramOf(t) } }),
        ],
      });
    }
  }
  // A lottery's seed: the owner puts it straight into the lottery's pot.
  for (const l of m.lotteries) {
    if (!(Number(l.seed ?? 0) > 0) || live?.seeded?.includes(`lottery:${l.key}`)) continue;
    const t = m.tokens.get(l.currency ?? m.currencyKey);
    const units = amount(l.seed, t);
    add({
      id: `seed:lottery:${l.key}`,
      part: `lottery:${l.key}`,
      says: `Put ${l.seed} ${t.symbol} into the pot of “${l.name}”`,
      build: (ctx) => {
        const pot = loot.pda.pot(loot.pda.lottery(project(ctx), l.id));
        return [
          ...(t.wsol ? [createAssociatedTokenAccountIdempotent(ctx.owner, ctx.owner, NATIVE_MINT), transferLamports(ctx.owner, loot.ata(ctx.owner, NATIVE_MINT), units), syncNative(loot.ata(ctx.owner, NATIVE_MINT))] : []),
          loot.payIx({ player: ctx.owner, project: project(ctx), mint: ctx.mints[t.key], treasury: ctx.treasury, amount: units, shares: [{ to: { Account: [pot] }, bps: 10_000 }], reference: `seed ${l.key}`, programs: programsOf(ctx) }),
        ];
      },
    });
  }
  for (const g of m.grants) {
    if (!(Number(g.fund ?? 0) > 0) || live?.funded?.includes(g.key)) continue;
    const lamports = toUnits(g.fund, 9);
    add({ id: `fund:${g.key}`, part: `fund:${g.key}`, says: `Put ${g.fund} SOL in the funds of the grant “${g.name}” (they pay each claim’s rent)`, build: (ctx) => [transferLamports(ctx.owner, loot.pda.grant(project(ctx), g.id), lamports)] });
  }
  // The authority's steps go last: the owner approves theirs in one batch, the authority theirs in another.
  return { steps: [...steps.filter((x) => !x.signers.includes('authority')), ...steps.filter((x) => x.signers.includes('authority'))], model: m };
}

/** The token accounts going live opens (`setupSteps`): [{ who ('the treasury', 'the project' or a wallet), token }], each
 * once, for the coins the economy takes in. */
export function goLiveAccounts(m) {
  const out = new Map();
  const add = (who, token) => token && out.set(`${who}|${token}`, { who, token });
  const takes = (part, token = part.currency ?? m.currencyKey) => {
    add('the treasury', token);
    for (const s of sharesOf(part.split)) if (s.kind === 'wallet') add(s.key, token);
  };
  for (const b of m.allBoxes) takes(b), add('the project', b.currency ?? m.currencyKey);
  for (const p of m.payments) takes(p);
  for (const l of m.lotteries) if (!l.ticketNft) takes(l, l.ticketCurrency ?? l.currency ?? m.currencyKey);
  for (const a of m.auctions) if (!a.bidNfts) takes(a), add('the project', a.currency ?? m.currencyKey);
  return [...out.values()];
}

/** How many addresses one step adds to the project's lookup table (each extension its own transaction). */
const TABLE_GROUP = 24;

/**
 * The addresses a project's transactions name most, for its standing lookup table: loot's own fixed accounts (the
 * platform, the oracle's), the project and its fee box, its treasury and collections, each coin's mint, its vault and
 * the treasury's account of it, then each pool, item, box and stash. Each a function of the go-live context.
 */
export function standingAddresses(m) {
  const fixed = [loot.LOOT_PROGRAM, loot.pda.platform(), loot.pda.identity(), loot.VRF_PROGRAM, loot.VRF_QUEUE, loot.MPL_CORE_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, SYSVAR_SLOT_HASHES, SYSVAR_INSTRUCTIONS, MEMO_PROGRAM].map((a) => () => a);
  const programOf = (ctx, key) => programsOf(ctx)[ctx.mints[key]] ?? TOKEN_PROGRAM;
  return [
    ...fixed,
    (ctx) => ctx.project, (ctx) => loot.pda.fees(ctx.project), (ctx) => ctx.treasury,
    ...(m.collection ? [(ctx) => ctx.collection] : []),
    ...[...m.tokens.values()].flatMap((t) => [(ctx) => ctx.mints[t.key], (ctx) => ctx.mints[t.key] && loot.ata(ctx.project, ctx.mints[t.key], programOf(ctx, t.key)), (ctx) => ctx.mints[t.key] && loot.ata(ctx.treasury, ctx.mints[t.key], programOf(ctx, t.key))]),
    ...m.pools.map((p) => (ctx) => loot.pda.pool(ctx.project, p.index)),
    ...m.items.map((it) => (ctx) => loot.pda.item(ctx.project, it.id)),
    ...m.allBoxes.map((b) => (ctx) => loot.pda.box(ctx.project, b.id)),
    ...m.stashes.map((s) => (ctx) => loot.pda.stash(ctx.project, s.id)),
  ].slice(0, 256);
}

/** How many Core NFTs one `stash` call puts in (`Piece::another`: three accounts each after the first). */
const STASH_GROUP = 6;
/** `list` in groups of `n`. */
const groupsOf = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/** A stash's bytes with `n` NFTs: a table of NFTs (`table.rs`): its 51-byte header, a total for each group of 4,096
 * rows and each block of 64, and 36 bytes an NFT (its weight and its address). */
export const stashBytes = (n) => (n ? loot.tableRowAt(36, n - 1) + 36 : 51);

/** Who puts a spec's auction up, and so is named in its address: the owner for a collectible it holds, the authority for a new unit of an item. */
export const auctionSeller = (a, ctx) => (a.lot?.asset ? ctx.owner : ctx.authority);

export const recordBytesOf = (kind, body) => {
  const args = body.args;
  const base = {
    Item: () => ({ project: NOBODY, item_id: 0, ...placeholders(args), issued: 0, voided: 0, compressed: false }),
    LootBox: () => ({ project: NOBODY, box_id: 0, ...placeholders(args), version: 0 }),
    Recipe: () => ({ project: NOBODY, id: 0, version: 0, ...placeholders(args) }),
    Schedule: () => ({ project: NOBODY, id: 0, ...placeholders(args), runs: 0 }),
    // Its terms and its round number: each round keeps the rest in a record of its own.
    Lottery: () => ({ project: NOBODY, id: 0, incarnation: 0n, revision: 0, ...placeholders(loot.withDefaults({ Lottery: { args } }).Lottery.args), round: 0 }),
    Grant: () => ({ project: NOBODY, id: 0, incarnation: 0n, ...placeholders(args), counted: { count: 0, window: 0, in_window: 0 } }),
  }[kind];
  return encodedSize(kind, base());
};
/** Exact initial contest record size for its configured shares, gate, sides and deciders. */
export const contestBytes = (contest, m) => encodedSize('Contest', { project: NOBODY, id: 0, incarnation: 0n, opener: NOBODY, mint: NOBODY, ...placeholders(contestArgs(contest, m)), verdict: 'Open', winner: 0, owed: 0n, unclaimed: 0n, sides: Array(contest.sides).fill(0n), share: 0, extras: 0, picks: 0 });
/** Args with "@mint:" names standing in as addresses, for sizing. */
const placeholders = (args) => resolve(args, { project: placeholderKey('project'), collection: placeholderKey('new:collection'), tree: placeholderKey('new:tree'), treasury: placeholderKey('treasury'), mints: new Proxy({}, { get: (_, k) => placeholderKey(`mint/${String(k)}`) }) });
/** The token program of each Token-2022 mint a context names (the program's account lists name it). */
const programsOf = (ctx) => ctx.tokenPrograms ?? {};

// ---------------------------------------------------------------- contexts

/** Stand-in addresses for every name a plan uses, so it can be built and sized without a wallet. */
export function placeholderContext(m, { rent = (bytes) => (BigInt(bytes) + ACCOUNT_OVERHEAD) * MOST_RENT_PER_BYTE } = {}) {
  const ownerKey = placeholderKey('owner');
  const collection = m.collection ? placeholderKey('new:collection') : null;
  const tree = compressedTree(m) ? placeholderKey('new:tree') : null;
  const mints = {};
  for (const t of m.tokens.values()) mints[t.key] = t.mint?.startsWith('@') ? placeholderKey(`new:mint/${t.key}`) : t.mint;
  return {
    owner: ownerKey,
    authority: m.authority === 'owner' ? ownerKey : m.authority,
    collection,
    tree,
    project: loot.pda.project(ownerKey, m.projectNumber),
    treasury: m.treasuryWallet ?? ownerKey,
    mints,
    keys: { ...(collection ? { 'new:collection': collection } : {}), ...(tree ? { 'new:tree': tree } : {}), ...Object.fromEntries([...m.tokens.values()].map((t) => [`new:mint/${t.key}`, placeholderKey(`new:mint/${t.key}`)])) },
    rent,
    slot: 0n,
  };
}

/**
 * What of `live` is made. While a setup is landing (`partial`), the project, its collection, its tree and each mint the
 * setup makes count only once the step that makes it landed (`landed`): a setup cut short makes the rest again, with
 * this session's fresh keys, instead of naming an account that was never made. What was live before a change, and
 * that the change does not make, counts as it is. The treasury and authority count only with the project. The approval
 * page holds what is left against the chain before it builds on it (`js/approve/live-check.mjs`).
 */
export function madeSoFar(live) {
  if (!live?.partial) return live;
  const landed = new Set(live.landed ?? []);
  const changing = new Set(live.changing ?? []);
  // A new setup makes everything; a change makes only the parts it names.
  const made = (part, id) => landed.has(id) || (Boolean(live.published) && !changing.has(part));
  const out = { ...live };
  // The treasury and authority are the project's: named only once it is made, never from the file before then.
  if (!made('project', 'project')) {
    delete out.project;
    delete out.treasury;
    delete out.authority;
  }
  if (!made('project', 'collection')) delete out.collection;
  if (!made('tree', 'tree')) delete out.tree;
  if (live.mints) out.mints = Object.fromEntries(Object.entries(live.mints).filter(([key]) => made(`token:${key}`, `token:${key}`)));
  return out;
}

/** The context of a real setup: the owner's wallet, fresh keys for what it creates, and what is live already. */
export function setupContext(m, { owner: ownerKey, keys, live: given = {}, rent }) {
  const live = madeSoFar(given) ?? {};
  // A setup goes on only in the owner's own project: never in one a file names for them.
  const own = loot.pda.project(ownerKey, m.projectNumber);
  if (live.project && live.project !== own) throw new Error(`The live section names the project ${live.project}, which is not the project ${own} of the wallet ${ownerKey}.`);
  const collection = live.collection ?? keys['new:collection'] ?? null;
  const tree = live.tree ?? keys['new:tree'] ?? null;
  const mints = {};
  // A mint the spec names by its address is that one, whatever the live section says; one the setup makes is the
  // live section's once it landed (checked against the chain by the approval page), else this setup's fresh key.
  for (const t of m.tokens.values()) mints[t.key] = t.mint && !t.mint.startsWith('@') ? t.mint : live.mints?.[t.key] ?? keys[`new:mint/${t.key}`];
  return {
    owner: ownerKey,
    authority: m.authority === 'owner' ? ownerKey : m.authority,
    collection,
    tree,
    project: own,
    treasury: live.treasury ?? m.treasuryWallet ?? ownerKey,
    mints,
    keys,
    rent,
  };
}

// ---------------------------------------------------------------- packing

/** The bytes of a transaction of `instructions` the owner pays for: what `pack` holds against the budget. */
export const stepBytes = (instructions, ctx) => transactionSize(compileMessage({ payer: ctx.owner, blockhash: placeholderKey('blockhash'), instructions }));

/** Packs steps into transactions under the size budget, one signer set at a time; each step whole. */
export function pack(steps, ctx) {
  const transactions = [];
  let current = null;
  const sizeOf = (instructions) => stepBytes(instructions, ctx);
  for (const step of steps) {
    const instructions = step.build(ctx);
    // A step with nothing to send (the lookup table of a plan built with no recent slot) is left out.
    if (!instructions.length) continue;
    const signerKind = step.signers.includes('authority') ? 'authority' : 'owner';
    // A write that names boxes to roll takes all the compute a transaction has: alone.
    if (current && current.signer === signerKind && !step.alone && !current.alone) {
      const next = [...current.instructions, ...instructions];
      if (sizeOf(next) <= BUDGET) {
        current.instructions = next;
        current.steps.push(step);
        current.built.push(instructions);
        current.signers = [...new Set([...current.signers, ...step.signers])];
        continue;
      }
    }
    const size = sizeOf(instructions);
    if (size > BUDGET) throw new Error(`The step “${step.says}” is ${size} bytes: too big for one transaction.`);
    // `built`: each step's own instructions, in the order of `steps`.
    current = { signer: signerKind, steps: [step], built: [instructions], instructions, signers: [...step.signers], alone: Boolean(step.alone) };
    transactions.push(current);
  }
  for (const t of transactions) t.bytes = sizeOf(t.instructions);
  return transactions;
}

/**
 * The plan for a spec: refusals, or every step packed into transactions. With `ctx` the transactions carry the
 * real instructions; without it they are built on stand-in addresses (for sizing, cost and showing).
 */
export function plan(economy, { now = Math.floor(Date.now() / 1000), ctx = null, only = null, live = null } = {}) {
  const checked = check(economy, { now });
  if (!checked.ok) return { ok: false, refusals: checked.refusals, warnings: checked.warnings };
  const { steps, model: m } = setupSteps(economy, { now, only, live });
  if (ctx) ctx.tokenPrograms ??= Object.fromEntries([...m.tokens.values()].filter((t) => t.program === 'token-2022' && ctx.mints[t.key]).map((t) => [ctx.mints[t.key], TOKEN_2022_PROGRAM]));
  const context = ctx ?? placeholderContext(m);
  const transactions = pack(steps, context);
  return {
    ok: true,
    warnings: checked.warnings,
    steps,
    transactions,
    // A wallet approves up to PER_APPROVAL transactions at once: the owner's, then the authority's (its steps go last).
    approvals: Math.max(1, Math.ceil(transactions.filter((t) => t.signer === 'owner').length / PER_APPROVAL)) + Math.ceil(transactions.filter((t) => t.signer === 'authority').length / PER_APPROVAL),
    freshKeys: [...new Set(steps.flatMap((s) => s.signers.filter((x) => x.startsWith('new:'))))],
  };
}

/** What each part needs while the economy runs: the instruction, and who signs it. */
export function playSteps(economy) {
  const m = model(economy);
  const rows = [];
  const add = (part, ix, signer, says) => rows.push({ part, ix, signer, says });
  // A shop item, and any box with one outcome and nothing random, sells in one instruction: price split, prize given.
  for (const b of m.shop) {
    const it = m.item.get(b.shopOf);
    add(`item:${it.key}`, 'buy', 'player', it.kind === 'normal' ? `buy “${it.name}”: the project’s backend delivers it from the receipt` : `buy “${it.name}”: minted to them at once`);
  }
  for (const b of m.boxes) {
    if (boxBuys(b, m)) {
      add(`box:${b.key}`, 'buy', 'player', `buy “${b.name}”: what it gives, at once`);
      continue;
    }
    add(`box:${b.key}`, 'open_box', 'player', `open “${b.name}”`);
    if (boxRolls(b, m)) add(`box:${b.key}`, 'callback_roll', 'the oracle', 'roll it');
    add(`box:${b.key}`, 'settle', 'anyone', 'carry out what it rolled');
  }
  for (const p of m.payments) add(`payment:${p.key}`, 'pay', 'player', `pay “${p.name}”`);
  add('payments', 'pay_nft', 'player', 'pay with an NFT (burned, or given to a wallet): the receipt is the record');
  for (const s of m.stashes) add(`stash:${s.key}`, 'stash', 'the owner or the authority', `put an NFT it holds in “${s.name}”, or take one out to any wallet`);
  for (const r of prizeRolls(m).filter((r) => !['mission', 'recipe'].includes(r.route))) {
    add(r.by, 'ask_roll', 'anyone, who pays the oracle', `ask for the roll of “${m.box.get(r.box)?.name ?? r.box}” a winner got (${r.route})`);
    add(r.by, 'settle', 'anyone', 'carry out what it rolled');
  }
  for (const r of m.recipes) add(`recipe:${r.key}`, 'craft', 'player', `craft “${r.name}”`);
  for (const s of m.schedules) add(`schedule:${s.key}`, 'run_schedule', 'anyone', `run “${s.name ?? s.key}” when it is due`);
  for (const l of m.lotteries) add(`lottery:${l.key}`, 'buy_tickets', 'player', 'buy tickets'), add(`lottery:${l.key}`, 'draw_lottery', 'anyone', 'ask for the draw when it is due'), add(`lottery:${l.key}`, 'settle_round', 'anyone', 'give the places’ prizes, then sweep the round'), add(`lottery:${l.key}`, 'pull', 'anyone', 'pay one entry its part: a refund, a place, a recipient’s share');
  for (const f of m.farms) {
    if (f.stakes === 'collectibles') add(`farm:${f.key}`, 'stake_nft', 'player', 'stake a collectible'), add(`farm:${f.key}`, 'unstake_nft', 'player', 'take it out once its lock has run');
    else add(`farm:${f.key}`, 'stake_tokens', 'player', 'stake'), add(`farm:${f.key}`, 'unstake_tokens', 'player', 'unstake or collect'), add(`farm:${f.key}`, 'stake_nft', 'player', 'put a collectible on as a booster');
    add(`farm:${f.key}`, 'harvest', 'player', 'collect rewards');
    add(`farm:${f.key}`, 'refresh_seat', 'anyone', 'read a seat’s boosts again');
  }
  for (const c of m.contests) {
    add(`contest:${c.key}`, 'open_contest', 'authority', `open “${c.name}”`);
    add(`contest:${c.key}`, 'enter', 'player', 'back a side');
    add(`contest:${c.key}`, 'decide', 'authority (or anyone, to call it off once overdue)', 'name the side that won');
    add(`contest:${c.key}`, 'claim', 'anyone', 'pay an entry');
  }
  for (const a of m.auctions) {
    add(`auction:${a.key}`, 'open_auction', a.lot?.asset ? 'the owner, alone (a collectible of theirs)' : 'the authority, alone (a new unit of an item)', `put the lot up (at go-live)`);
    add(`auction:${a.key}`, 'bid', 'player', 'bid: the bid it tops goes back at once');
    add(`auction:${a.key}`, 'end_auction', 'anyone once it is over; its seller, to call off one with no bid', 'sell to the high bidder, or send the lot home');
  }
  for (const h of m.holds) add(`hold:${h.key}`, 'hold', 'player', `hand in a “${h.item}” until ${h.until ?? `${h.for ?? 'the time they choose'} from then`}`), add(`hold:${h.key}`, 'release', 'authority while it runs, anyone after', 'say where it goes, or send it home');
  for (const g of m.grants) add(`grant:${g.key}`, 'claim_grant', 'the winning wallet, which signs it (with a voucher, a list proof, or an open grant); anyone may pay its fees', `claim “${g.name}”`);
  for (const d of m.decisions) add(`decision:${d.key}`, { payout: 'move_tokens', burn: 'move_tokens', issue: 'move_tokens', make: 'collectible', unmake: 'collectible', set: 'collectible', award: 'release', decide: 'decide', roll: 'roll', open_contest: 'open_contest' }[d.does], 'authority', d.when);
  return rows;
}

