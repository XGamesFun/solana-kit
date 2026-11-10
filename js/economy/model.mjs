// The economy spec in the program's own terms: amounts in base units, percents in basis points, durations in
// seconds, every reference resolved and every part given its program id. The checker, the simulation, the cost
// and the setup plan all read a spec through this. Pure.
import { gateList } from '../client/grant.js';
import { treeSize } from '../client/ix.js';

// ---------------------------------------------------------------- the program's numbers
// Each is the loot program's own unless it says otherwise.

/** The two flat fees, in lamports, as the platform sets them by default; the program caps each at 0.01 SOL. */
export const FEES = Object.freeze({ player: 2_000_000n, project: 10_000n });
/**
 * What MagicBlock's VRF oracle queue (Cuj97ggr…, ephemeral-vrf-sdk 0.17.2 consts.rs DEFAULT_QUEUE) takes for each
 * random number asked of it: VRF_LAMPORTS_COST = 500,000 lamports, 0.0005 SOL (magicblock-labs/ephemeral-vrf,
 * api/src/consts.rs; the high-priority queue's 800,000 is not the one loot uses). Paid by whoever asks: the player
 * on `open_box` (order.rs), whoever sends `draw_lottery` (lottery.rs, its `payer`), the authority on `roll`
 * (roll.rs). Measured on devnet: 500,000 lamports per open.
 */
export const ORACLE_FEE = 800_000n;
/**
 * What js/play's throwaway settle key is funded with, in the purchase's own transaction, for each prize its settle may
 * open or mint (`loot.SETTLE_RENT_UNIT`): whoever settles pays that rent, the order lends nothing. What the settle
 * doesn't spend goes back to the player when the key empties itself, and all of it when the roll fails.
 */
export const SETTLE_RENT_UNIT = 6_000_000n;
/** Rent: (bytes + 128) × 5,080 lamports, as `solana rent` reads it on devnet and mainnet-beta. */
export const RENT_PER_BYTE = 5_080n;
export const ACCOUNT_OVERHEAD = 128n;
/**
 * The most rent a byte has cost on any Solana cluster: 3,480 lamports a byte-year for two years, the rate before
 * devnet and mainnet lowered it (a local validator and LiteSVM still charge it). An RPC that asks more is not believed.
 */
export const MOST_RENT_PER_BYTE = 6_960n;
export const rent = bytes => (BigInt(bytes) + ACCOUNT_OVERHEAD) * RENT_PER_BYTE;
/**
 * A collectible's Core account, paid from the SOL its order holds (or by whoever gives it): its rent (a Core asset of
 * about 190 bytes) plus Metaplex Core's creation fee of 0.0015 SOL, which the account keeps. The full simulation
 * measures 0.00309 to 0.00313 SOL across its fixtures.
 */
export const COLLECTIBLE_RENT = 3_100_000n;
/** The network's base fee per signature. Priority fees are extra and up to the wallet. */
export const SIGNATURE_FEE = 5_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const WSOL = 'So11111111111111111111111111111111111111112';
/** The limits a spec meets: the chain's (the oracle's answer carries 21 accounts; a farm names a tier and a recipe a
 * collectible's place in a byte; Bubblegum keeps a compressed NFT's link in 200 bytes and its name in 32) and the two
 * caps that keep a farm's numbers from overflowing. Since loot 0.22 the program caps no count or size of its own. */
export const LIMITS = Object.freeze({
  callbackAccounts: 21,
  tiers: 256,
  collectiblesPerCraft: 255,
  vouchers: 3,
  compressedNameBytes: 32,
  compressedUriBytes: 200,
  maxBoostBps: 1_000_000,
  maxTierBps: 110_000,
  // The program's caps on a record's lists (constants.rs, not in the IDL): a spec over one is refused before anything is signed.
  boxEntries: 128,
  boxSlots: 32,
  boxOdds: 32,
  boxFates: 64,
  entryPrizes: 14,
  itemTraits: 64,
  traitKeyBytes: 64,
  recipeLines: 48,
  farmRules: 32,
  growthSteps: 128,
  contestSides: 1024,
  deciders: 32,
  collections: 32,
  lotteryRuns: 64,
  farmEnds: 100_000,
});
/** Attribute names the program writes itself, which a recipe cannot copy and `Set` cannot change (craft.rs, make.rs),
 * and the two a collectible's life keeps (`lifeLines`: its uses and its next use). */
export const RESERVED_ATTRIBUTES = Object.freeze(['made', 'used', 'next_use', 'item_id', 'rarity', 'serial', 'origin']);
export const RARITIES = Object.freeze(['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic']);

// ---------------------------------------------------------------- units

/** A refusal raised while reading a value; the checker turns it into a refusal with a code. */
export class SpecError extends Error {
  constructor(code, message, fix) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

/** A plain decimal string for an amount written as a number or text (no exponent). */
export function decimalText(amount) {
  if (typeof amount === 'string') return amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
    throw new SpecError('E-AMOUNT', `${amount} is not an amount.`, 'Write a number like 0.1, or text like "0.1".');
  const text = String(amount);
  if (!/e/i.test(text)) return text;
  return amount.toFixed(20).replace(/\.?0+$/, '');
}

/** "0.1" of a currency with 9 decimals → 100000000n. Refuses more decimals than the currency has. */
export function toUnits(amount, decimals) {
  const text = decimalText(amount ?? 0);
  if (!/^\d{1,20}(\.\d+)?$/.test(text))
    throw new SpecError('E-AMOUNT', `${text} is not an amount.`, 'Write a number like 0.1, or text like "0.1".');
  const [whole, fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > decimals)
    throw new SpecError(
      'E-AMOUNT',
      `${text} has more decimals than its currency (${decimals}).`,
      `Round it to ${decimals} decimals.`,
    );
  const units = BigInt(whole + trimmed.padEnd(decimals, '0'));
  if (units >= 2n ** 64n)
    throw new SpecError('E-AMOUNT', `${text} is too large for the program.`, 'Use a smaller amount.');
  return units;
}

/** 100000000n with 9 decimals → "0.1". */
export function fromUnits(units, decimals) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** A count written as an amount (a contest of NFTs counts NFTs): 2 or "2" → 2n. Null when it is not a whole number. */
export function wholeCount(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : (value ?? '0');
  return typeof text === 'string' && /^\d{1,19}$/.test(text) && BigInt(text) < 2n ** 64n ? BigInt(text) : null;
}

/** 2.5 (percent) → 250 basis points. Null when it is not a whole number of hundredths. */
export function toBps(percent) {
  const bps = Math.round(Number(percent ?? 0) * 100);
  return Math.abs(bps - Number(percent ?? 0) * 100) < 1e-6 && bps >= 0 && bps <= 10_000 ? bps : null;
}

const UNIT = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
/** "7d" → 604800. A number is seconds already. */
export function toSeconds(duration) {
  if (duration === undefined || duration === null) return 0;
  if (typeof duration === 'number') return duration;
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(duration);
  if (!m)
    throw new SpecError('E-TIME', `${duration} is not a duration.`, 'Write it like "45s", "30m", "6h", "7d" or "2w".');
  return Math.round(Number(m[1]) * UNIT[m[2]]);
}

/**
 * How long what lands in a farm's rewards vault takes to be released to its seats, in seconds (a farm that shares what
 * lands, `farm.rs` `release_span`): its longest lock tier, and a day at least.
 */
export const releaseSeconds = f => Math.max(86_400, ...(f.tiers ?? []).map(t => toSeconds(t.lock ?? 0)));

/** A farm's release span in words: "a day", "30 days", "36 hours". */
export function releaseWords(f) {
  const s = releaseSeconds(f);
  if (s % 86_400 === 0) return s === 86_400 ? 'a day' : `${s / 86_400} days`;
  return s % 3_600 === 0 ? `${s / 3_600} hours` : `${s} seconds`;
}

/**
 * What a run sent late does, in words (schedule.rs `catches_up`): a sealed schedule's fixed amount pays every run due;
 * any other run pays once, for the latest run due, and the runs before it lapse.
 */
export const lateRunWords = s =>
  s.sealed && s.percent === undefined
    ? 'a run sent late pays every run due since'
    : 'a run missed is missed: one sent late pays once, for the latest run due, and the runs before it lapse';

/**
 * Whether a farm's boost reads a number its own growth writes (`refresh_seat` writes it): each level counts from when it is
 * written, so a page or a keeper should refresh seats.
 */
export const boostReadsGrowth = f =>
  (f.boosts ?? []).some(
    b =>
      b.when?.attribute &&
      listOf(f.growth).some(
        g =>
          b.when.attribute === (g.attribute ?? 'xp') ||
          ((g.levels ?? []).length > 0 && b.when.attribute === (g.level ?? 'level')),
      ),
  );

/** A box's roll against what is in stock, in words (order.rs): the odds stay as written, whatever is left. */
export const STOCK_WORDS =
  'The odds stay as written whatever is in stock: a draw that lands on an outcome that can’t be given then (its pool short of the whole amount, its item or stash gone) is not made, no other outcome takes its place, and that draw’s worth of the price goes back at the settle; with no draw made at all, a paid open fails and is refunded, and a free roll goes back to waiting';

/**
 * What a box that rolls does once an outcome can't be given (`whenOut`, order.rs `WhenOut`), in words. `sold`: it is
 * sold (an open checks the stock); a box only other routes roll (a prize, a mission) never stops a sale.
 */
export function whenOutWords(b, { sold = b.active !== false } = {}) {
  if (b.whenOut === 'drawLeft' && !sold)
    return 'When an outcome runs out (an item sold out, a pool short of its prize, a stash empty), a roll draws among the outcomes still there by their written weights, so the others’ chances rise; with nothing left at all, a free roll waits to be asked again and a paid one is refunded';
  if (b.whenOut === 'drawLeft')
    return 'When an outcome runs out (an item sold out, a pool short of its prize, a stash empty), the box keeps selling while its first draw has anything left, and a roll draws among the outcomes still there by their written weights: the others’ chances rise as one runs out, so a player can empty a common outcome to make a rare one likelier (a box selling a rare prize should stop selling instead, the default)';
  if (!sold)
    return `${STOCK_WORDS}. A free roll (a prize, a recipe’s, a mission’s chest) is on the odds as written too: a draw on an outcome that is out misses and gives nothing back (a pack keeps what its other draws won; a roll that drew nothing waits to be asked again), so emptying a shared source before asking steers nothing. A pack that should draw among what is left needs "whenOut": "drawLeft"`;
  return 'When an outcome runs out, the box stops selling: it isn’t sold while anything an outcome takes (an item’s units left, a pool’s tokens, a stash’s NFTs) couldn’t cover, at the most any outcome sharing it takes in one draw, this purchase’s draws and those of purchases still waiting for the oracle, so every roll is on the odds as written and nobody can buy their way to a refund on every miss; it sells again once the project restocks or edits the box (an outcome whose odds shrink with stock needs no cover). An outcome emptied another way all the same (another route sharing its pool, item or stash) makes no draw, no other outcome taking its place, and gives back that draw’s worth of the price at the settle; with no draw made at all, the open is refunded';
}

/**
 * What the end of a sharing farm that `runs` means, in words, or null (no end, or a fixed rate): its release keeps its
 * pace, so what it has not let go by the end stays in its vault, free for the authority to take back, and so does what
 * a seat forfeits after the end.
 */
export function farmEndWords(f) {
  if (!f.runs || f.rate) return null;
  const span = releaseWords(f);
  return `what is not released by its end stays in its vault, credited to nobody (the authority may take back what is free there), and so does what a seat forfeits after the end: fund it at least ${span} before its end (what lands later is released only in part, and what lands at or after the end not at all)`;
}

/**
 * The token a farm's rewards are in (`rewards`, a token key): by default its staked token, or for a farm of
 * collectibles the project's currency. One that names a pool (as farms did before they had a vault of their own) is
 * read as that pool's token, and the checker refuses it.
 */
export function farmRewardsToken(f, tokens, currencyKey, poolCurrency = new Map()) {
  if (f.rewards && tokens.has(f.rewards)) return f.rewards;
  if (f.rewards && poolCurrency.has(f.rewards)) return poolCurrency.get(f.rewards);
  return f.stakes && f.stakes !== 'collectibles' ? f.stakes : currencyKey;
}

/** A raise's or a shift's `by`: a number, or for a time a duration, which may be negative ("-1d"). */
export function toBy(by) {
  if (typeof by !== 'string') return by;
  return by.startsWith('-') ? -toSeconds(by.slice(1)) : toSeconds(by);
}

/** "publish", "publish+7d" or a date → Unix seconds, counted from `now` (Unix seconds) for the first two. */
export function toTime(time, now) {
  if (!time || time === 'publish') return now;
  const m = /^publish\+(.+)$/.exec(time);
  if (m) return now + toSeconds(m[1]);
  const at = Date.parse(time);
  if (!Number.isFinite(at))
    throw new SpecError(
      'E-TIME',
      `${time} is not a time.`,
      'Write "publish", "publish+7d" or a date like "2026-11-01T18:00:00Z".',
    );
  return Math.floor(at / 1000);
}

export const rarityNumber = rarity =>
  typeof rarity === 'number' ? rarity : Math.max(0, RARITIES.indexOf(rarity ?? 'Common'));
export const utf8Bytes = s => new TextEncoder().encode(s ?? '').length;
export const isAddress = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// ---------------------------------------------------------------- the model

/** Gives every part without one the next free program id (pools from 0, the rest from 1). */
function assignIds(list, field, first) {
  const used = new Set(list.map(x => x[field]).filter(v => Number.isInteger(v)));
  let next = first;
  return list.map(x => {
    if (Number.isInteger(x[field])) return x;
    while (used.has(next)) next += 1;
    used.add(next);
    return { ...x, [field]: next };
  });
}

/** Where an NFT paid goes, in the program's words (`Spend`, `Then`): "burn", "treasury" (its wallet, filled in at go-live), { giveTo }, or { stash }. */
export const spendOf = (then, m) => {
  if (!then || then === 'burn') return 'Burn';
  if (then === 'treasury') return { Give: ['@treasury'] };
  if (then.stash) return { Stash: [m.stash.get(then.stash)?.id ?? 0] };
  return { Give: [then.giveTo] };
};

/** What a token is on chain: its mint (or "@mint:<key>" until it exists), program, decimals, and who can mint it. */
function tokenOf(given) {
  // "project" is the spec's word for a token the project mints; "game" is the older spelling of it.
  const t = given.source === 'project' ? { ...given, source: 'game' } : given;
  if (t.source === 'sol')
    return {
      ...t,
      name: t.name ?? 'SOL',
      symbol: t.symbol ?? 'SOL',
      decimals: 9,
      program: 'spl-token',
      mint: WSOL,
      wsol: true,
      gameMints: false,
    };
  const decimals = t.decimals ?? (t.source === 'game' ? 0 : undefined);
  return {
    ...t,
    symbol: t.symbol ?? t.key.toUpperCase().slice(0, 10),
    name: t.name ?? t.symbol ?? t.key,
    decimals,
    program: t.program ?? 'spl-token',
    mint: t.mint ?? `@mint:${t.key}`,
    wsol: t.mint === WSOL,
    // A game token with a fixed supply is minted once, to the owner, and nobody mints it after.
    gameMints: (t.source === 'game' && t.supply === undefined) || ['game', 'project'].includes(t.powers?.mintAuthority),
    fixedSupply: t.source === 'game' && t.supply !== undefined,
  };
}

/**
 * The spec with references resolved and ids given. Unknown references stay as they are (the checker reports
 * them); call `check` first when it matters.
 */
export function model(economy, { now = 0 } = {}) {
  const e = economy ?? {};
  const tokens = new Map((e.tokens ?? []).map(t => [t.key, tokenOf(t)]));
  const currencyKey = e.currency ?? (tokens.size === 1 ? [...tokens.keys()][0] : undefined);
  const currency = tokens.get(currencyKey);
  // Numbers are given in this order: the pools that have one, then the rest in the spec's order.
  const listed = e.pools ?? [];
  const order = [...listed.keys()].sort(
    (a, b) => Number(!Number.isInteger(listed[a].index)) - Number(!Number.isInteger(listed[b].index)),
  );
  const assigned = assignIds(
    order.map(i => listed[i]),
    'index',
    0,
  );
  const pools = listed.map((_, i) => assigned[order.indexOf(i)]);
  // A farm's rewards land in a vault of its own: `rewardsToken` is their token.
  const poolCurrency = new Map(pools.map(p => [p.key, p.currency]));
  const farms = (e.farms ?? []).map(f => ({
    ...f,
    rewardsToken: farmRewardsToken(f, tokens, currencyKey, poolCurrency),
  }));
  // A raffle: its NFT is first place's prize, held in the lottery's own stash.
  const lotteries = (e.lotteries ?? []).map(l => {
    if (!l.raffle) return l;
    const { nft, collection } = typeof l.raffle === 'string' ? { nft: l.raffle } : l.raffle;
    return {
      ...l,
      places: [
        { percent: 0, prize: { gives: 'nft', nft, held: true, ...(collection ? { collection } : {}) } },
        ...(l.places ?? []),
      ],
    };
  });
  const m = {
    now,
    name: e.name ?? 'Project',
    authority: e.keys?.authority ?? 'owner',
    /** The wallet whose account for the currency is the treasury, when it isn't the owner's ("wallet:<address>"). */
    treasuryWallet: typeof e.treasury === 'string' && e.treasury.startsWith('wallet:') ? e.treasury.slice(7) : null,
    tokens,
    currencyKey,
    currency,
    /** The collection the setup makes (null when the spec says `"collection": false`: a project of tokens only). */
    collection:
      e.collection === false
        ? null
        : {
            name: e.collection?.name ?? (e.name ?? 'Project').slice(0, 32),
            royaltyPercent: e.collection?.royaltyPercent ?? 5,
            uri: e.collection?.uri ?? '',
            ...e.collection,
          },
    /** Core collections the owner already has that the project also takes (its update authority is the owner). */
    collections: e.collections ?? [],
    /** How many compressed NFTs the project's tree holds (`compressedTree`), when a prize gives one. */
    treeHolds: e.compressedTree?.holds ?? 16_384,
    /** The project's number among its owner's: its address is ["project", owner, number]. */
    projectNumber: e.projectNumber ?? 0,
    items: assignIds(e.items ?? [], 'id', 1),
    pools,
    stashes: assignIds(e.stashes ?? [], 'id', 1),
    tables: assignIds(e.tables ?? [], 'id', 1),
    boxes: [],
    payments: e.payments ?? [],
    recipes: assignIds(e.recipes ?? [], 'id', 1),
    schedules: assignIds(e.schedules ?? [], 'id', 1),
    lotteries: assignIds(lotteries, 'id', 1),
    farms: assignIds(farms, 'id', 1),
    contests: assignIds(e.contests ?? [], 'id', 1),
    auctions: assignIds(e.auctions ?? [], 'id', 1),
    holds: e.holds ?? [],
    grants: assignIds(e.grants ?? [], 'id', 1),
    traits: e.traits ?? [],
    decisions: e.decisions ?? [],
    scenario: e.scenario ?? {},
    live: e.live ?? {},
  };
  // A shop item is a box of one entry (the program sells items only through boxes). Its box takes the item's price,
  // rise, fall, split and gate; it is numbered with the boxes, after the ones the spec numbered itself.
  const shop = m.items
    .filter(it => Number(it.price ?? 0) > 0 || it.free)
    .map(it => ({
      key: `shop-${it.key}`,
      ...(Number.isInteger(it.shopBox) ? { id: it.shopBox } : {}),
      name: it.name,
      price: it.price ?? 0,
      ...(it.rise ? { rise: it.rise } : {}),
      ...(it.fall ? { fall: it.fall } : {}),
      ...(it.split ? { split: it.split } : {}),
      ...(it.gate ? { gate: it.gate } : {}),
      // When it sells, and how many one wallet may buy.
      ...Object.fromEntries(
        ['opens', 'closes', 'perWallet', 'perWalletEach'].filter(k => it[k] !== undefined).map(k => [k, it[k]]),
      ),
      active: it.active !== false,
      outcomes: [{ gives: 'item', item: it.key, weight: 1 }],
      shopOf: it.key,
    }));
  const numbered = assignIds([...(e.boxes ?? []), ...shop], 'id', 1);
  m.boxes = numbered.filter(b => !b.shopOf);
  m.shop = numbered.filter(b => b.shopOf);
  /** Every box the program holds: the spec's own and the shop's. */
  m.allBoxes = numbered;
  const index = list => new Map(list.map(x => [x.key, x]));
  m.item = index(m.items);
  m.pool = index(m.pools);
  m.stash = index(m.stashes);
  m.table = index(m.tables);
  m.box = index(m.allBoxes);
  m.recipe = index(m.recipes);
  m.farm = index(m.farms);
  m.grant = index(m.grants);
  m.lottery = index(m.lotteries);
  m.contest = index(m.contests);
  m.auction = index(m.auctions);
  m.hold = index(m.holds);
  /** The token a pool holds. */
  m.poolToken = key => tokens.get(m.pool.get(key)?.currency);
  /** The token a part is priced in (its own `currency`, else the game's). */
  m.priceToken = part => tokens.get(part?.currency ?? currencyKey);
  return m;
}

/**
 * The NFTs a stash lists, each as the program's `piece` takes it: a Core asset (`asset`, its `collection`: its own, the
 * stash's, or the game's when neither says), a Token Metadata NFT (`mint`, `programmable`, `ruleSet`), or a compressed
 * NFT (`compressed`, its asset id).
 */
export function stashNfts(s) {
  return (s.nfts ?? []).map(n => {
    if (typeof n === 'string') return { kind: 'core', asset: n, collection: s.collection ?? null, weight: 1 };
    const weight = n.weight ?? 1;
    if (n.mint)
      return {
        kind: 'token-metadata',
        asset: n.mint,
        programmable: Boolean(n.programmable),
        ruleSet: n.ruleSet ?? null,
        weight,
      };
    if (n.compressed) return { kind: 'compressed', asset: n.compressed, weight };
    return { kind: 'core', asset: n.asset, collection: n.collection ?? s.collection ?? null, weight };
  });
}

/**
 * A prize as the spec writes it (`$defs/prize`), read the one way: a line { gives, … } as a recipe's `out` lines are:
 * "item" (`item`), "tokens" (`amount`, `from` "mint" with `currency`, or "pool:<key>"),
 * "nft" (`nft`, an address the stash `stash` lists) or "roll" (a roll of `box`; in a recipe, on the collectible kept
 * at `on`). A grant's older `gives` ({ item }, { pool, amount }, { roll }) reads as its line. Null for none.
 */
export function prizeLine(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.gives) return p;
  if (p.item) return { gives: 'item', item: p.item };
  if (p.roll) return { gives: 'roll', box: p.roll };
  if (p.pool) return { gives: 'tokens', amount: p.amount, from: `pool:${p.pool}` };
  return null;
}

/** The pool a prize line pays from: tokens' "pool:<key>". */
export const prizePool = p => (p?.gives === 'tokens' && p.from?.startsWith('pool:') ? p.from.slice(5) : null);

/** The token a prize line pays in: its pool's, or the one it mints. */
export const prizeToken = (p, m) =>
  prizePool(p) ? m.poolToken(prizePool(p)) : p?.gives === 'tokens' ? m.tokens.get(p.currency ?? m.currencyKey) : null;

/**
 * Every prize the spec gives (prize.rs): a grant's, a lottery place's, a contest's winners', a mission tier's and a
 * recipe's `out` lines. [{ prize (a line), where, by, route, strict, once }] `strict`: the route refuses a prize it
 * can't give (a grant's claim, a craft); any other goes on without it. `once`: the route gives it once at most (a
 * grant of one claim in all).
 */
export function prizes(m) {
  const list = [];
  const add = (p, where, by, route, strict, once = false) =>
    p && list.push({ prize: p, where, by, route, strict, once });
  for (const g of m.grants)
    add(
      prizeLine(g.prize ?? g.gives),
      `economy.grants.${g.key}.${g.prize ? 'prize' : 'gives'}`,
      `grant:${g.key}`,
      'grant',
      true,
      Number(g.limits?.total ?? 0) === 1,
    );
  for (const l of m.lotteries)
    (l.places ?? []).forEach((p, i) =>
      add(
        placeOf(p).prize,
        `economy.lotteries.${l.key}.places[${i}].prize`,
        `lottery:${l.key}`,
        `place ${i + 1}`,
        false,
        !l.every,
      ),
    );
  for (const c of m.contests)
    add(prizeLine(c.prize), `economy.contests.${c.key}.prize`, `contest:${c.key}`, 'contest', false);
  for (const f of m.farms)
    (f.tiers ?? []).forEach((t, i) =>
      add(prizeLine(t.prize), `economy.farms.${f.key}.tiers[${i}].prize`, `farm:${f.key}`, 'mission', false),
    );
  for (const r of m.recipes)
    (r.out ?? []).forEach((o, i) =>
      o.gives !== 'roll' || o.on === undefined
        ? add(o, `economy.recipes.${r.key}.out[${i}]`, `recipe:${r.key}`, 'recipe', true)
        : null,
    );
  return list;
}

/**
 * The project's tree of compressed NFTs (`open_tree`), when a prize gives one (`"compressed": true`), else null: deep
 * enough for `treeHolds` (14 to 20 levels, Bubblegum's sizes for a buffer of 64), its canopy keeping a proof at 10
 * nodes or a few more (at most 8 levels: past that the rent grows faster than the proofs shrink). { depth, buffer,
 * canopy, bytes }
 */
export function compressedTree(m) {
  const boxGives = m.allBoxes.some(b =>
    (b.outcomes ?? []).flatMap(outcomeParts).some(o => o.gives === 'item' && o.compressed),
  );
  if (!boxGives && !prizes(m).some(p => p.prize.gives === 'item' && p.prize.compressed)) return null;
  const depth = Math.min(20, Math.max(14, Math.ceil(Math.log2(Math.max(1, m.treeHolds)))));
  const canopy = Math.min(depth - 10, 8);
  return { depth, buffer: 64, canopy, bytes: treeSize(depth, 64, canopy) };
}

/**
 * Every route that gives a roll of a box, with the box it names: a prize's roll (`prizes`), an auction's lot, a
 * mission's roll on the NFT leaving it and a recipe's roll on a collectible it keeps. [{ box, by, route }]
 */
export function prizeRolls(m) {
  const rolls = prizes(m)
    .filter(p => p.prize.gives === 'roll')
    .map(p => ({ box: p.prize.box, by: p.by, route: p.route }));
  for (const a of m.auctions)
    if (a.lot?.roll) rolls.push({ box: a.lot.roll, by: `auction:${a.key}`, route: 'auction' });
  for (const f of m.farms)
    for (const t of f.tiers ?? []) if (t.roll) rolls.push({ box: t.roll, by: `farm:${f.key}`, route: 'mission' });
  for (const r of m.recipes)
    for (const o of r.out ?? [])
      if (o.gives === 'roll' && o.on !== undefined) rolls.push({ box: o.box, by: `recipe:${r.key}`, route: 'recipe' });
  return rolls.filter(r => r.box);
}

/**
 * Every roll of a box any route makes, for the checks keyed on "a box something rolls": `prizeRolls`, every box
 * outcome's (or bundle part's) roll of another box (route "box", made at its settle), and, followed through chains,
 * each route that rolls a box whose outcome rolls another (a grant's roll of “mid”, whose outcome rolls “inner”, is a
 * roll of “inner” by the grant, `through` ["mid"]). [{ box, by, route, through? }]
 */
export function rollsOf(m) {
  const rolls = [...prizeRolls(m)];
  for (const b of m.allBoxes)
    for (const o of b.outcomes ?? [])
      for (const x of outcomeParts(o))
        if (x.gives === 'roll' && x.box) rolls.push({ box: x.box, by: `box:${b.key}`, route: 'box' });
  const seen = new Set(rolls.map(r => `${r.box}|${r.by}|${r.route}`));
  const rollsFrom = key => [
    ...new Set(
      m.box.get(key)
        ? (m.box.get(key).outcomes ?? [])
            .flatMap(outcomeParts)
            .filter(x => x.gives === 'roll' && x.box)
            .map(x => x.box)
        : [],
    ),
  ];
  // A breadth-first walk: each roll of a box is also a roll of every box it rolls, once for each route.
  for (let i = 0; i < rolls.length; i++) {
    const r = rolls[i];
    for (const next of rollsFrom(r.box)) {
      const id = `${next}|${r.by}|${r.route}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rolls.push({ box: next, by: r.by, route: r.route, through: [...(r.through ?? []), r.box] });
    }
  }
  return rolls;
}

/** A prize line in words: "one Badge", "100 GOLD from “rewards”", "100 GOLD, minted", "the NFT ab12…cd34 of “vault”", "a roll of “Chest”". */
export function prizeWords(p, m) {
  const line = prizeLine(p);
  if (!line) return 'nothing';
  const sym = key => m.tokens.get(key)?.symbol ?? key;
  if (line.gives === 'item')
    return `one ${m.item.get(line.item)?.name ?? line.item}${line.compressed ? ' (compressed)' : ''}`;
  if (line.gives === 'raffled') return 'an NFT drawn at random from the lottery’s own stash';
  if (line.gives === 'nft' && line.held)
    return `the NFT ${String(line.nft).slice(0, 4)}…${String(line.nft).slice(-4)} (held in the lottery’s own stash until it is won)`;
  if (line.gives === 'nft')
    return `the NFT ${String(line.nft).slice(0, 4)}…${String(line.nft).slice(-4)} of “${m.stash.get(line.stash)?.name ?? line.stash}”`;
  if (line.gives === 'roll') return `a roll of “${m.box.get(line.box)?.name ?? line.box}”`;
  const pool = prizePool(line);
  const split = line.split ? ', split by what each winner put in' : '';
  return pool
    ? `${line.amount} ${sym(m.pool.get(pool)?.currency)} from “${pool}”${split}`
    : `${line.amount} ${sym(line.currency ?? m.currencyKey)}, minted${split}`;
}

/**
 * What one box outcome gives (catalog.rs), each in the box's own words: "item", "pay" (a fixed amount from a pool),
 * "stash" (an NFT of a stash at random), "mint"
 * (tokens minted), "nft" (one NFT a stash lists) or "roll" (a roll of another box). A bundle gives its `prizes`; "burn"
 * and "nothing" give none.
 */
export function outcomeParts(o) {
  if (!o) return [];
  if (o.gives === 'bundle') return (o.prizes ?? []).flatMap(outcomeParts);
  if (o.gives === 'nothing') return [];
  if (o.gives === 'tokens')
    return [
      o.from?.startsWith('pool:')
        ? { gives: 'pay', pool: o.from.slice(5), amount: o.amount }
        : { gives: 'mint', currency: o.currency, amount: o.amount },
    ];
  return [o];
}

/** Whether a box leaves its outcome to the oracle (catalog.rs `rolls`): more than one outcome, or an NFT at random. */
/** How many draws one open of a box makes: its slots' counts, or one. */
export const drawsOf = b => ((b.slots ?? []).length ? b.slots.reduce((n, s) => n + Number(s.count), 0) : 1);

/** Whether a box's prize costs its settle a collectible's rent: an item minted as a Core NFT, or a fresh compressed one
 * (its traits' Sheet). A plain compressed NFT costs no rent. */
export const holdsRent = (p, m) =>
  p.gives === 'item' && (!p.compressed || (m?.item.get(p.item)?.drawn ?? []).length > 0);

/**
 * The units of `SETTLE_RENT_UNIT` a settle of box `b`'s order may spend (`loot.settleRent`), which js/play funds its
 * throwaway settle key with and gets back unspent: for each draw, each part of the richest outcome that opens an
 * account (a collectible, a fresh compressed NFT's Sheet, a stash's NFT); once an order, each source of tokens it may
 * pay, and the fate of the NFT it rolls on.
 */
export function settleUnits(b, m) {
  const opens = p => holdsRent(p, m) || p.gives === 'stash' || p.gives === 'nft';
  const parts = (b.outcomes ?? []).map(o => outcomeParts(o));
  const most = Math.max(0, ...parts.map(ps => ps.filter(opens).length));
  const sources = new Set(
    parts
      .flat()
      .filter(p => ['tokens', 'pay', 'mint'].includes(p.gives))
      .map(p => prizePool(p) ?? `mint:${p.currency ?? ''}`),
  );
  return drawsOf(b) * most + sources.size + (b.rollsOn ? 1 : 0);
}

export const boxRolls = (b, m) =>
  (b.outcomes ?? []).length > 1 ||
  (b.outcomes ?? [])
    .flatMap(outcomeParts)
    .some(p => p.gives === 'stash' || (p.gives === 'item' && (m?.item.get(p.item)?.drawn ?? []).length > 0));

/** Whether a box sells with `buy`, in one transaction (buy.rs): it doesn't roll and rolls on no NFT, any number of draws
 * a sale (a fixed pack: its prizes given once for each draw). */
export const boxBuys = (b, m) => !boxRolls(b, m) && !b.rollsOn;

/** The most a raise lowers a number by (an i32's least but one): a renew's, which counts a collectible's uses from 0. */
const RENEW_BY = -2_147_483_647;

/**
 * What a recipe's lines owe the life of each collectible they take (an item's `life`), as the program's needs and
 * raises (craft.rs `Need`, `Raise`), at each collectible's place in the recipe (each burned unit, then each kept one, in
 * line order; a pay line takes none): ready after `readyAfter` (`made` older than it), for `lasts` (`made` within it),
 * on every line that takes it; `uses` times (`used` raised by 1 up to it) and a `cooldown` (`next_use` passed, then
 * raised to that far from now) on a line that uses it or takes it staked; a renew line counts its uses from 0 again.
 * { needs, raises }, in the program's shapes.
 */
export function lifeLines(r, m) {
  const places = (r.in ?? []).flatMap(l =>
    l.takes === 'pay' ? [] : Array(l.takes === 'burn' ? (l.count ?? 1) : 1).fill(l),
  );
  const needs = [];
  const raises = [];
  places.forEach((l, place) => {
    const it = l.item ? m.item.get(l.item) : null;
    if (!it?.life || it.kind === 'normal') return;
    const [ready, lasts, uses, cooldown] = [
      toSeconds(it.life.readyAfter ?? 0),
      toSeconds(it.life.lasts ?? 0),
      it.life.uses ?? 0,
      toSeconds(it.life.cooldown ?? 0),
    ];
    if (ready) needs.push({ place, key: 'made', test: { Older: [ready] } });
    if (lasts) needs.push({ place, key: 'made', test: { Within: [lasts] } });
    if (l.takes === 'renew') raises.push({ place, shift: { key: 'used', by: RENEW_BY, most: 0, from_now: false } });
    if (l.takes !== 'use' && l.takes !== 'staked') return;
    if (uses) raises.push({ place, shift: { key: 'used', by: 1, most: uses, from_now: false } });
    if (cooldown) {
      needs.push({ place, key: 'next_use', test: 'Passed' });
      raises.push({ place, shift: { key: 'next_use', by: cooldown, most: cooldown, from_now: true } });
    }
  });
  return { needs, raises };
}

/** A lottery's place as { percent, prize }: a number is a percent of what the round pays from, and no prize. */
export const placeOf = p =>
  typeof p === 'object' && p !== null
    ? { percent: p.percent ?? 0, prize: prizeLine(p.prize), times: p.times ?? 1, whenShort: p.whenShort }
    : { percent: p, prize: null, times: 1 };

/** "pool:house" → { kind: 'pool', key: 'house' }; "burn" → { kind: 'burn' }. */
export function destination(to) {
  if (to === 'burn') return { kind: 'burn' };
  if (to === 'treasury') return { kind: 'treasury' };
  if (to === 'chosen') return { kind: 'chosen', key: '' };
  const [kind, ...rest] = String(to).split(':');
  return { kind, key: rest.join(':') };
}

/** The share with its basis points, or null bps when the percent is not whole hundredths. */
export const sharesOf = split =>
  (split ?? []).map(s => ({ ...destination(s.to), to: s.to, percent: s.percent, bps: toBps(s.percent) }));

/**
 * The program's `To` for a destination, with pool indexes resolved (the IDL's own shape). A wallet ("wallet:<address>")
 * is paid at its own token account of the part's currency (the program opens it when it is not there); "treasury" is the game's treasury wallet's; "chosen"
 * (or "chosen:<item>") is the one the buyer names when they buy; "lottery:<key>" is that lottery's pot
 * ("@pot:<lottery id>:<pot id>") and "farm:<key>" that farm's rewards vault ("@rewards:<id>"), which the plan resolves once the game is
 * known.
 */
export function toEnum(to, m) {
  const d = destination(to);
  if (d.kind === 'burn') return 'Burn';
  if (d.kind === 'treasury') return 'Treasury';
  if (d.kind === 'pool') return { Pool: [m.pool.get(d.key)?.index ?? 0] };
  if (d.kind === 'account') return { Account: [d.key] };
  if (d.kind === 'wallet') return { Wallet: [d.key] };
  if (d.kind === 'lottery')
    return { Account: [`@pot:${m.lottery.get(d.key)?.id ?? 0}:${m.lottery.get(d.key)?.pot ?? 0}`] };
  if (d.kind === 'farm') return { Account: [`@rewards:${m.farm.get(d.key)?.id ?? 0}`] };
  if (d.kind === 'chosen') return { Chosen: { item: d.key ? (m.item.get(d.key)?.id ?? 0) : null } };
  return { Holder: [d.key] };
}

/**
 * The program's `Rule` for a spec rule: which NFTs (a collection's, or an item's the game mints), an attribute and its
 * test. With neither, the collection the game has authority over: `@collection`, filled in when the economy goes live.
 */
export function ruleOf(rule, m) {
  if (!rule) return null;
  const time = { ahead: 'Ahead', passed: 'Passed' }[rule.time];
  // Any of several items: the game's own collection, its `item_id` one of theirs.
  if (rule.items)
    return {
      of: { Collection: ['@collection'] },
      key: 'item_id',
      test: { OneOf: { texts: rule.items.map(k => String(m.item.get(k)?.id ?? 0)) } },
    };
  const texts = rule.oneOf ?? (rule.equals !== undefined ? [rule.equals] : null);
  const test =
    rule.atLeast !== undefined
      ? { AtLeast: [rule.atLeast] }
      : texts
        ? { OneOf: { texts: texts.map(String) } }
        : (time ?? 'Any');
  const of = rule.item
    ? { Item: [m.item.get(rule.item)?.id ?? 0] }
    : { Collection: [rule.collection ?? '@collection'] };
  return { of, key: rule.attribute ?? '', test };
}

/** One thing or a list of them, as a list: a farm's `gate` and `growth` take either. */
export const listOf = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

/**
 * The program's `Gate` for a spec gate: a few wallets (`wallets`), a list of any size (`list`: an allowlist, its root and
 * depth: the client's `gateList`), a stake (`staked`: at least `atLeast` of a farm's token in the wallet's seat; the farm's address
 * is "@farm:<id>", filled in when the project is known), or a rule a collectible the player shows must pass.
 */
export const gateOf = (gate, m) => {
  if (!gate) return null;
  if (gate.wallets) return { Wallets: [gate.wallets] };
  if (gate.staked) {
    const farm = m.farm.get(gate.staked.farm);
    return {
      Staked: {
        farm: `@farm:${farm?.id ?? 0}`,
        at_least: toUnits(gate.staked.atLeast ?? 0, m.tokens.get(farm?.stakes)?.decimals ?? 0),
      },
    };
  }
  if (gate.list) {
    const { root, depth } = gateList(gate.list);
    return { List: { root, depth } };
  }
  return { Holds: [ruleOf(gate, m)] };
};

/** The program's `PerWallet` for a part's "perWallet" (in all) and "perWalletEach" ({ count, every }). */
export const perWalletOf = part => ({
  total: part?.perWallet ?? 0,
  per_window: part?.perWalletEach?.count ?? 0,
  window: part?.perWalletEach ? toSeconds(part.perWalletEach.every ?? '1d') : 0,
});

/** The program's `Window` for a part's "opens" and "closes" (times; 0 leaves a side open). */
export const windowOf = (part, now) => ({
  opens_at: BigInt(part?.opens ? toTime(part.opens, now) : 0),
  closes_at: BigInt(part?.closes ? toTime(part.closes, now) : 0),
});

/** Whether lottery `l` pays its places from a pot it keeps (`"pot"`, `PaysFrom::Pot`); false when each round pays from
 * its own ticket money and sends what its places leave to `"rest"` (`PaysFrom::Round`). */
export const keepsPot = l => Number.isInteger(l?.pot);

/** The program's `PaysFrom` for a lottery: `{ Pot: [id] }` or `{ Round: { rest } }` (its `rest` as `toEnum` gives it). */
export const paysFromOf = (l, m) => (keepsPot(l) ? { Pot: [l.pot] } : { Round: { rest: toEnum(l.rest, m) } });

/** A lottery's split of ticket money: its own, and "cutPercent" as a share to the treasury. */
export const lotterySplit = l => [
  ...(l.split ?? []),
  ...(l.cutPercent ? [{ to: 'treasury', percent: l.cutPercent }] : []),
];

/** The program's `Effect` for a spec effect: a flat share, or a share per point of the attribute. */
export function effectOf(effect) {
  if (effect?.perPointPercent !== undefined)
    return { PerPoint: { bps: Math.round(effect.perPointPercent * 100), most: effect.upTo ?? 4_294_967_295 } };
  return { Flat: [Math.round((effect?.addPercent ?? 0) * 100)] };
}

/** A box's outcomes with their program weights: chances become whole weights (hundredths of a basis point). */
export function weights(box) {
  const outcomes = box.outcomes ?? [];
  if (outcomes.every(o => Number.isInteger(o.weight))) return outcomes.map(o => o.weight);
  const raw = outcomes.map(o => Math.round((o.chance ?? 0) * 10_000));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = raw.reduce((a, b) => gcd(a, b), 0) || 1;
  return raw.map(w => w / g);
}

/** Every place the spec names a pool as somewhere money leaves from, with what takes it. */
export function poolTakers(m) {
  const takers = [];
  const add = (pool, by, how) => pool && takers.push({ pool, by, how });
  for (const b of m.allBoxes)
    for (const o of (b.outcomes ?? []).flatMap(outcomeParts))
      if (o.gives === 'pay') add(o.pool, `box:${b.key}`, 'pays prizes');
  for (const p of prizes(m)) add(prizePool(p.prize), p.by, `pays prizes (${p.route})`);
  for (const s of m.schedules) {
    if (s.does === 'burn') add(s.pool, `schedule:${s.key}`, 'burns a share');
    if (s.does === 'move') add(s.from, `schedule:${s.key}`, 'moves a share out');
    // A pay schedule pays out of its pool (to a wallet, a token account, a holder or a lottery's pot); a sealed one pays
    // from a vault of its own and names no pool.
    if (s.does === 'pay') add(s.from, `schedule:${s.key}`, 'pays out on a timer');
  }
  for (const d of m.decisions)
    if (d.does === 'payout' || d.does === 'burn')
      add(
        d.pool,
        `decision:${d.key}`,
        d.does === 'payout' ? 'pays out on the authority’s word' : 'burns on the authority’s word',
      );
  return takers;
}

/** Every place the spec sends money into a pool. */
export function poolFillers(m) {
  const fillers = [];
  const add = (pool, by, how) => pool && fillers.push({ pool, by, how });
  const fromSplit = (split, by) =>
    sharesOf(split).forEach(s => s.kind === 'pool' && add(s.key, by, `${s.percent}% of each payment`));
  for (const p of m.pools)
    if (p.seed !== undefined && Number(p.seed) > 0) add(p.key, `pool:${p.key}`, 'the owner’s seed');
  for (const b of m.allBoxes) fromSplit(b.split, b.shopOf ? `item:${b.shopOf}` : `box:${b.key}`);
  for (const p of m.payments) fromSplit(p.split, `payment:${p.key}`);
  for (const r of m.recipes)
    for (const i of r.in ?? [])
      if (i.takes === 'pay' && destination(i.to).kind === 'pool')
        add(destination(i.to).key, `recipe:${r.key}`, 'a craft pays in');
  for (const s of m.schedules) {
    if (s.does === 'issue') add(s.pool, `schedule:${s.key}`, 'mints into it');
    if (s.does === 'move') add(s.to, `schedule:${s.key}`, 'moves a share in');
  }
  for (const l of m.lotteries) fromSplit(lotterySplit(l), `lottery:${l.key}`);
  for (const c of m.contests) fromSplit(c.split, `contest:${c.key}`);
  for (const a of m.auctions) fromSplit(a.split, `auction:${a.key}`);
  return fillers;
}

/**
 * Every place the spec sends money into a farm's rewards vault ("farm:<key>"): a split's share, a schedule that pays it,
 * a craft that pays it, the owner's seed, an early exit's fee into its own vault. [{ farm, by, how }]
 */
export function farmFillers(m) {
  const fillers = [];
  const add = (to, by, how) => {
    const d = destination(to ?? '');
    if (d.kind === 'farm') fillers.push({ farm: d.key, by, how });
  };
  const fromSplit = (split, by) => sharesOf(split).forEach(s => add(s.to, by, `${s.percent}% of each payment`));
  for (const f of m.farms) {
    if (Number(f.seed ?? 0) > 0) fillers.push({ farm: f.key, by: `farm:${f.key}`, how: 'the owner’s seed' });
    if (f.exitFeeTo === 'rewards') fillers.push({ farm: f.key, by: `farm:${f.key}`, how: 'early-exit fees' });
  }
  for (const b of m.allBoxes) fromSplit(b.split, b.shopOf ? `item:${b.shopOf}` : `box:${b.key}`);
  for (const p of m.payments) fromSplit(p.split, `payment:${p.key}`);
  for (const r of m.recipes)
    for (const i of r.in ?? []) if (i.takes === 'pay') add(i.to, `recipe:${r.key}`, 'a craft pays in');
  for (const s of m.schedules)
    if (s.does === 'pay' || s.does === 'issue')
      add(s.to, `schedule:${s.key}`, s.does === 'issue' ? 'mints into it on a timer' : 'pays in on a timer');
  for (const l of m.lotteries) fromSplit(lotterySplit(l), `lottery:${l.key}`);
  for (const c of m.contests) fromSplit(c.split, `contest:${c.key}`);
  for (const a of m.auctions) fromSplit(a.split, `auction:${a.key}`);
  return fillers;
}
