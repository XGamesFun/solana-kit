// Farms: opening one, walking its ends, staking and unstaking tokens, and refreshing seats.
import { NO_ADDRESS } from '../../chain/base58.js';
import { ata, pda } from '../pda.js';
import { farmSide, payWrites, profileOf, tokenProgramOf } from './shared.js';
import { lootIx, tailOf } from './base.js';
import { boxesAccounts, shownAccounts } from './tail.js';

// ---------------------------------------------------------------- farms

/**
 * The owner opens farm `id`: of `stakedMint`'s tokens, or of collectibles when it is null. Its rewards are `rewardsMint`'s,
 * in its own rewards vault (`pda.rewards(farm)`), which anything funds by a plain transfer (a share or a schedule paying
 * `{ Account: [vault] }`): all that lands there, shared, or with `args.rate` ({ per_day, mints, shared, halve_every }) a
 * fixed rate, for each seat at x1 or with `shared` the whole farm's shared by weight, halving every `halve_every`
 * seconds from the farm's opening (0: never), minted when a seat is paid or paid from what the vault holds free while it
 * lasts (a rate of 0 pays nothing: a farm that only grows or gives prizes). `args.gates`: the rules an NFT must all
 * pass. `args.growth`: any number of { key, per_day, level, steps, streak, profile, at_least }, each writing points (and
 * a level) on what is staked, or with `profile` on the staker's profile (a token seat only while it stakes `at_least`);
 * a tier's `earns_for`: seconds a seat earns and grows after its lock started (0: no end). `args.ends_at`: when it ends
 * (0: never). For a farm of collectibles, `args.lock_key`: the attribute a staked NFT's lock is written under, as the
 * time it ends, so recipes and rolls can move it; `args.upkeep_key`: the attribute that says until when it earns and
 * grows (fuel). Empty: none. `args.exit_to`: where early-exit fees go, 'Burn', { Pool: [index] } or 'Rewards' (the
 * farm's own vault: a farm whose staked token is its rewards'). A farm whose seats can stop earning and that pays keeps a
 * record of when (`farmKeepsEnds`, `pda.ends`), made here at the owner's rent; each new time costs its writer `END_BYTES`.
 */
export const openFarmIx = ({ owner, project, id, args, rewardsMint, stakedMint = null }) => {
  if (!Array.isArray(args?.tiers)) throw new Error('A farm needs its lock tiers (`args.tiers`: [{ lock, bps }, …]).');
  const full = {
    gates: [],
    ends_at: 0,
    lock_key: '',
    upkeep_key: '',
    exit_to: null,
    ...args,
    rate: args.rate ? { mints: false, shared: false, halve_every: 0, ...args.rate } : null,
    tiers: args.tiers.map(t => ({ prize: null, roll: null, exit_bps: 0, earns_for: 0, ...t })),
    growth: (args.growth ?? []).map(g => ({ profile: false, at_least: 0n, ...g })),
  };
  return lootIx(
    'open_farm',
    { id, args: full },
    {
      owner,
      project,
      rewards_mint: rewardsMint,
      staked_mint: stakedMint,
      staked_vault: stakedMint ? pda.staked(pda.farm(project, id)) : null,
      exit_pool: sinkPool(project, full.exit_to),
      ends: farmKeepsEnds(full) ? pda.ends(pda.farm(project, id)) : null,
    },
    {
      // Each box its tiers name to roll, tier by tier (its roll, then a prize that is a roll), once.
      remaining: boxesAccounts(
        project,
        full.tiers.flatMap(t => [t.roll, t.prize?.Roll?.[0]].filter(x => x != null)),
      ),
    },
  );
};

/**
 * Whether a farm with these args keeps a record of when its seats stop earning (`Farm::keeps_ends`): a tier has a term
 * (`earns_for`) or the farm reads an upkeep (`upkeep_key`), and it pays something (no rate, or a rate above 0). The farm
 * and every move of it then pass the record (`WrongEnds` otherwise).
 */
export const farmKeepsEnds = args =>
  ((args.tiers ?? []).some(t => BigInt(t.earns_for ?? 0) > 0n) || Boolean(args.upkeep_key)) &&
  (!args.rate || BigInt(args.rate.per_day ?? 0) > 0n);

/** Where a farm's fee goes (`Sink`): the pool's address for `{ Pool: [index] }`, null for a burn, its own vault or none. */
const sinkPool = (project, sink) => (sink?.Pool ? pda.pool(project, sink.Pool[0]) : null);

/**
 * What a farm has to walk (`Farm::walk`): the times of its record of ends (`ends`, from `decodeEnds`; an empty list for none)
 * past its clock, up to `now` (Unix seconds, the chain's clock) or the farm's end. Every move walks all of them first, each a
 * little compute, so a farm idle past many ends may leave a move no room: `farmNeedsWalk`.
 */
export function endsToWalk(farm, ends, now) {
  const clock = BigInt(farm.clock ?? 0);
  const over = BigInt(farm.ends_at ?? 0);
  const stop = over > 0n && over < BigInt(now) ? over : BigInt(now);
  return ends.filter(e => e.at > clock && e.at <= stop).length;
}

/** How many ends `walk_farm` walks in one transaction at `WALK_COMPUTE_UNITS`: an end takes up to some 3,150 units at
 * the dearest farm, a halving rate and seats of 4 × 10^16 base units at a ×100 tier (`js/test/farm-ends.test.mjs`
 * measures it: 400 ends take 1,260,730 units, 2,270 an end with light seats). Each end walked also frees the leaving
 * weight's share of the carry, some 300 units of that at the dearest farm. */
export const WALK_PER_TX = 400;
/** The compute units a transaction that walks ends asks for: `walk_farm`, or a move with ends to walk first. */
export const WALK_COMPUTE_UNITS = 1_400_000;
/** How many ends a move can walk first at `WALK_COMPUTE_UNITS` and still do its own work (some 400,000 units are left
 * for it at the dearest farm): past this, the farm is walked first (`farmNeedsWalk`). */
export const MOVE_WALK_ROOM = 300;

/**
 * Whether a farm has passed more ends than a move can walk in its own transaction (`endsToWalk`, `MOVE_WALK_ROOM`): such
 * a move fails on compute until `walk_farm` has caught the farm up. Nothing is lost by waiting: what a seat earned by
 * its end is written when the farm walks past it, however late.
 */
export const farmNeedsWalk = (farm, ends, now) => endsToWalk(farm, ends, now) > MOVE_WALK_ROOM;

/**
 * The transactions that walk a farm up to now, oldest ends first: one `walkFarmIx` each, `perTx` ends at most, `[]` when
 * it has nothing to walk. Anyone may send them, in order; each is free but for its network fee.
 */
export function walkFarmParts({ project, id, farm, ends, now, perTx = WALK_PER_TX }) {
  const left = endsToWalk(farm, ends, now);
  const parts = [];
  for (let done = 0; done < left; done += perTx)
    parts.push(walkFarmIx({ project, id, farm, most: Math.min(perTx, left - done) }));
  return parts;
}

/**
 * Credits a farm up to at most `most` of the times its seats stopped earning. Anyone may send it, signing nothing but its
 * network fee: it decides nothing, every move walks the same times the same way. For a farm that has passed more of them
 * than a move's transaction can walk (`farmNeedsWalk`, `walkFarmParts`).
 */
export const walkFarmIx = ({ project, id, farm, most = WALK_PER_TX }) =>
  lootIx('walk_farm', { most }, farmSide(project, id, farm));

/** A token seat's accounts; `paid`: rewards may be paid (an unstake), so the player's account of them comes. */
function tokenSeat({ player, project, id, farm, programs, paid = false }) {
  const mint = farm.farmed.Tokens.mint;
  const farmAddress = pda.farm(project, id);
  return {
    ...farmSide(project, id, farm),
    player,
    seat: pda.seat(farmAddress, player),
    staked_vault: pda.staked(farmAddress),
    mint,
    player_tokens: ata(player, mint, tokenProgramOf(programs, mint)),
    player_rewards: paid ? ata(player, farm.rewards_mint, tokenProgramOf(programs, farm.rewards_mint)) : null,
    exit_pool: sinkPool(project, farm.exit_to),
    profile: profileOf(project, farm, player),
  };
}

/**
 * `player` stakes `amount` at lock tier `tier`. `farm` is decoded; `extra` carries token hook/memo accounts. A seat with
 * a booster on, or one whose growth the stake changes, needs a `refreshSeatIx` of it first, in the same transaction
 * (`stakeRefreshFirst`).
 */
export const stakeTokensIx = ({ player, project, id, farm, amount, tier = 0, programs, shown, extra = [] }) =>
  lootIx('stake_tokens', { amount, tier }, tokenSeat({ player, project, id, farm, programs }), {
    remaining: [...shownAccounts(project, shown), ...tailOf(extra)],
  });

/**
 * `player` takes `amount` out (0: only collects what is owed); `forfeit` gives up rewards that can't move. Before the
 * tier's lock has run, a tier with an early-exit fee (`exit_bps`) lets it leave, leaving that share of `amount` to the
 * farm's `exit_to`; it keeps the rewards it was credited.
 */
export const unstakeTokensIx = ({ player, project, id, farm, amount, forfeit = false, programs, extra = [] }) =>
  lootIx('unstake_tokens', { amount, forfeit }, tokenSeat({ player, project, id, farm, programs, paid: !forfeit }), {
    remaining: tailOf(extra),
    // An exit fee that burns writes the staked mint; a farm that mints, its rewards' mint when it pays.
    writable: [...(forfeit ? [] : payWrites(farm)), ...(farm.exit_to === 'Burn' ? ['mint'] : [])],
  });

/**
 * Whether taking `amount` out of a token seat (decoded `seat`) needs a `refreshSeatIx` of it first, in the same
 * transaction (`RefreshFirst`): the farm grows, and the exit closes the seat or drops it below a growth's least stake, so
 * what it grew since its last refresh is written before it goes. Never under `forfeit`.
 */
export const refreshFirst = (farm, seat, amount, forfeit = false) =>
  !forfeit &&
  BigInt(amount) > 0n &&
  (farm.growth ?? []).some(g => {
    const least = BigInt(g.at_least ?? 0) > 0n ? BigInt(g.at_least) : 1n;
    return BigInt(seat.amount) >= least && BigInt(seat.amount) - BigInt(amount) < least;
  });

/**
 * Whether a stake of tokens at `tier` in a token seat (decoded `seat`; null for a new one), or with `compound` a
 * compound of what it is owed, needs a `refreshSeatIx` of it first, in the same transaction (`RefreshFirst`), at `now`
 * (Unix seconds, the chain's clock): a seat with a booster on (its boost is read again there, so a top-up never stakes
 * more at a boost its booster no longer gives), or a seat that grows (a booster's growth, or its player's profile's)
 * when the stake changes how: a new tier, a farm whose growth reads the amount, a seat past its term; a compound when
 * that growth reads the amount.
 * @param {any} farm
 * @param {any} seat
 * @param {{ tier?: number, now?: bigint | number, compound?: boolean }} [options]
 */
export function stakeRefreshFirst(farm, seat, { tier = seat?.tier, now, compound = false } = {}) {
  if (!seat) return false;
  const growth = farm.growth ?? [];
  const booster = seat.asset !== undefined && seat.asset !== NO_ADDRESS;
  const grows = BigInt(seat.amount) > 0n && growth.some(g => g.profile || booster);
  const amountGrows = growth.some(g => g.profile || BigInt(g.at_least ?? 0) > 0n);
  if (compound) return BigInt(seat.amount) > 0n && (booster || (grows && amountGrows));
  const changes =
    Number(tier) !== Number(seat.tier) ||
    amountGrows ||
    (now !== undefined && BigInt(seat.earns_until ?? 0) <= BigInt(now));
  return booster || (grows && changes);
}

/**
 * Whether a booster put on a token seat of `farm` (decoded) needs the seat refreshed first, in the same transaction
 * (`stake_nft`'s `RefreshFirst`): in a farm of tokens whose growth writes its players' profiles, the booster's growth
 * starts from now, so what the seat grew before is written first.
 */
export const boosterRefreshFirst = farm => Boolean(farm.farmed?.Tokens) && (farm.growth ?? []).some(g => g.profile);

/**
 * Whether a farm (decoded) takes a stake at lock tier `tier` at `now` (Unix seconds, the chain's clock), as the program
 * judges it: a farm with an end (`ends_at`, 0 for never) takes none at its end or after it, nor one whose lock
 * would run past it (`FarmOver`). A stake of tokens, a booster, a new tier and a watched NFT's takeover all ask it.
 */
export function farmOpenFor(farm, tier, now) {
  const ends = BigInt(farm.ends_at ?? 0);
  if (ends === 0n) return true;
  const t = BigInt(now);
  return t < ends && t + BigInt(farm.tiers[tier]?.lock ?? 0) <= ends;
}

export const AUTH_RULES_PROGRAM = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
