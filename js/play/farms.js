// Farms, for the page client (solanaApp): stake and unstake tokens or NFTs, walk a farm's ends, refresh, harvest and
// compound, and read a player's stake.
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { parseCoreAsset } from '../chain/core.js';
import { COMPUTE_BUDGET_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, withSolWrap } from '../chain/programs.js';
import { resolveTransfers } from '../chain/token2022.js';
import { sendPlan, transactionLocks } from '../chain/lookup.js';
import { compileMessage, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { isProveLeaf, MPL_CORE, NO_OPTIONS, only, show, units } from './common.js';

/** Adds to `ctx` where an NFT is staked and a farm's ends, and returns the farm methods. */
export function addFarms(ctx) {
  const {
    spec,
    wallet,
    programs,
    live,
    client,
    project,
    tokens,
    mintOf,
    decimalsOf,
    part,
    read,
    readMaybe,
    nftOf,
    prizeInputs,
    ownerOf,
    passing,
    send,
    dryRun,
    sendRolling,
    freshNonce,
    chainNow,
    clearLeftovers,
    closesFirst,
  } = ctx;

  /** Farm hooks shared by all actions. Static lists resolve automatically. For dynamic hooks,
   * transfers[mint] describes every actual transfer, including fee-adjusted reward credit/payout, and in a farm that
   * shares its pool the move's last one when a seat gave rewards back in it (an early exit, a watched
   * NFT gone): from the farm's rewards vault back to its pool, the project the authority.
   * Explicit extra replaces resolution and must include all token hook/memo and Core adapter accounts. */
  const farmTokens = async (mints, create, { extra, transfers = {} } = {}) => {
    const selected = [...new Set(mints)];
    const resolved = await Promise.all(
      selected.map(async mint => {
        if (extra !== undefined) {
          const account = await client.account(mint);
          if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(account?.owner))
            throw new Error(`There is no supported token ${mint} on this network.`);
          return { mint, tokenProgram: account.owner, extraAccounts: [] };
        }
        try {
          return { mint, ...(await resolveTransfers(client, mint, transfers[mint] ?? [])) };
        } catch (cause) {
          throw new Error(
            `Cannot resolve farm transfers for ${mint}: ${cause.message} Supply exact transfers keyed by mint, or explicit extra hook/memo accounts.`,
            { cause },
          );
        }
      }),
    );
    const tokenPrograms = {
      ...programs,
      ...Object.fromEntries(resolved.map(({ mint, tokenProgram }) => [mint, tokenProgram])),
    };
    return {
      programs: tokenPrograms,
      extra: extra ?? resolved.flatMap(r => r.extraAccounts),
      before: [...new Set(create)].map(mint =>
        createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, mint, tokenPrograms[mint]),
      ),
    };
  };
  /** `{ asset, farm }` for a Core asset on its seat in one of the economy's farms of these custodies, or null. */
  const seatedIn = async (asset, custodies = ['escrow', 'freeze']) => {
    for (const f of (spec.farms ?? []).filter(
      x => x.stakes === 'collectibles' && custodies.includes(x.custody ?? 'escrow'),
    )) {
      if (await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset))) return { asset, farm: f.id };
    }
    // Or boosting the player's token seat in a farm of tokens: that seat, not one of its own (`booster`).
    for (const f of (spec.farms ?? []).filter(
      x => x.stakes !== 'collectibles' && custodies.includes(x.custody ?? 'escrow'),
    )) {
      const seat = wallet?.address
        ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address))
        : null;
      if (seat?.asset === asset) return { asset, farm: f.id, booster: true };
    }
    return null;
  };
  /** The same for one the project holds: staked in escrow. */
  const escrowedIn = async asset =>
    (await ownerOf(asset).catch(() => null)) === project ? seatedIn(asset, ['escrow']) : null;
  /** The same for one the project locks in the player's wallet: staked in a farm that freezes (a soulbound Core asset
   * carries no lock to tell it is staked, so it goes alone). */
  const lockedIn = async asset => {
    const seated = await seatedIn(asset, ['freeze']);
    if (!seated) return null;
    const account = await client.account(asset);
    return account?.owner === MPL_CORE && parseCoreAsset(account.data).soulbound ? null : seated;
  };
  /** A token seat's refresh (`seat` decoded), with its booster's accounts (a compressed one proven first), to go first in
   * a stake or a compound's transaction (`loot.stakeRefreshFirst`). */
  async function refreshOf(f, farm, seat) {
    const { before, ...nft } = seat.asset !== NO_ADDRESS ? await nftOf(seat.asset) : { before: [] };
    return [
      ...before,
      loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by: seat.player, seat, ...nft }),
    ];
  }

  /**
   * Refuses, in words, to stake `asset` in tier `tier` of farm `f` when its unstake (with the tier's prize, and as a
   * forfeit) couldn't be sent even as a v0 transaction with a lookup table, its proof sent first (`sendPlan`).
   */
  async function exitFits(f, farm, asset, nft, before, tier, staking) {
    const prize = farm.tiers[tier]?.prize ?? null;
    const given = await prizeInputs([prize]);
    // The rewards' accounts as the stake resolved them (a hook that needs each transfer named is sized without them).
    const token = {
      ...staking,
      before: [
        createAssociatedTokenAccountIdempotent(
          wallet.address,
          wallet.address,
          farm.rewards_mint,
          staking.programs[farm.rewards_mint] ?? TOKEN_PROGRAM,
        ),
      ],
    };
    const exit = forfeit => [
      ...before,
      ...(forfeit ? [] : [...given.before, ...token.before]),
      loot.unstakeNftIx({
        player: wallet.address,
        project,
        id: f.id,
        farm,
        asset,
        ...nft,
        forfeit,
        roll: farm.tiers[tier]?.roll ?? null,
        nonce: 1n,
        tier,
        projectCollection: given.collection,
        poolMints: given.poolMints,
        items: given.items,
        nft: given.nft,
        ...token,
      }),
    ];
    for (const forfeit of [false, true]) {
      const instructions = exit(forfeit).filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      if (
        !sendPlan({
          payer: wallet.address,
          instructions: [computeUnitLimit(1_400_000), ...instructions],
          alone: isProveLeaf,
        })
      )
        throw new Error(
          `Not staked: this NFT couldn't come back out of “${f.name ?? f.key}”. Its unstake${forfeit ? ', even giving up the rewards,' : ''} would lock more accounts than one transaction can (${transactionLocks(wallet.address, [computeUnitLimit(1_400_000), ...instructions], { asV0: true })} with its lookup table; at most 64), so it would stay in the farm.`,
        );
    }
  }

  /** How many ends farm `f` has passed and not walked yet (`loot.endsToWalk`), and its decoded record: 0 for one that keeps none. */
  async function endsOf(f, farm) {
    if (!farm.keeps_ends) return { left: 0, ends: [] };
    const data = (await client.account(loot.pda.ends(loot.pda.farm(project, f.id))))?.data;
    const ends = data ? loot.decodeEnds(data) : [];
    return { left: loot.endsToWalk(farm, ends, await chainNow()), ends };
  }

  /**
   * A move of farm `f` as it can land: every move walks the ends the farm has passed first, each some compute, so one with
   * ends to walk asks for all a transaction has, and one with more than that holds is refused in words, nothing signed.
   */
  async function walking(f, farm, instructions) {
    const { left } = await endsOf(f, farm);
    if (!left) return instructions;
    if (left > loot.MOVE_WALK_ROOM)
      throw Object.assign(
        new Error(
          `“${f.name ?? f.key}” has passed ${left} times seats stop earning since anyone last moved it, more than one transaction can walk: walk it first (app.walkFarm: anyone may, it is free, and nothing is lost by the wait).`,
        ),
        { name: 'FarmNeedsWalk' },
      );
    return [
      computeUnitLimit(loot.WALK_COMPUTE_UNITS),
      ...instructions.filter(x => !(x.programId === COMPUTE_BUDGET_PROGRAM && x.data[0] === 2)),
    ];
  }

  /**
   * Refuses a stake a farm would refuse (`FarmOver`) before anything is signed: a farm with an end takes none at its end
   * or after it, nor one at a tier whose lock would run past it. `f` is the spec's farm, `farm` the decoded one.
   */
  async function openFor(f, farm, tier) {
    const at = await chainNow();
    if (loot.farmOpenFor(farm, tier, at)) return;
    const ends = new Date(Number(farm.ends_at) * 1000).toISOString();
    if (at >= BigInt(farm.ends_at))
      throw new Error(
        `“${f.name ?? f.key}” ended at ${ends}: it takes no stake any more. Stakes in it can still leave and harvest.`,
      );
    throw new Error(
      `“${f.name ?? f.key}” ends at ${ends}, and lock tier ${tier} would run past it: stake at a tier with a shorter lock.`,
    );
  }
  Object.assign(ctx, { escrowedIn, lockedIn, endsOf });

  return {
    /**
     * Stakes `amount` (whole units) of a farm's token at lock tier `tier`. A farm with an end takes no stake at its end
     * or after it, nor one whose lock would run past it: refused here, before the wallet signs.
     */
    async stake(farmKey, amount, tier = 0, { shown, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'extra', 'transfers'], 'stake');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      await openFor(f, farm, tier);
      shown ??= await passing(farm.gates, 'stake here');
      const mint = farm.farmed.Tokens.mint;
      const value = units(amount, decimalsOf(f.stakes));
      // While its lock runs, a seat moves only to a tier with no early exit, or one whose early exit costs at least as
      // much as its own (`ExitWhileLocked`): never to a way out it didn't have, or a cheaper one.
      const mine = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address));
      if (mine && BigInt(mine.amount) > 0n && Number(mine.tier) !== Number(tier)) {
        const [from, to] = [Number(farm.tiers[mine.tier].exit_bps), Number(farm.tiers[tier].exit_bps)];
        const locked = (await chainNow()) < BigInt(mine.since) + BigInt(farm.tiers[mine.tier].lock);
        if (locked && !(to === 0 || (from > 0 && to >= from)))
          throw new Error(
            'While its lock runs, this stake can only move to a tier with no early exit, or one whose early exit costs at least as much as its own.',
          );
      }
      const token = await farmTokens([mint], [], { extra, transfers });
      const ix = loot.stakeTokensIx({
        player: wallet.address,
        project,
        id: f.id,
        farm,
        amount: value,
        tier,
        shown,
        ...token,
      });
      // A seat with a booster on (its boost is read again), or one whose growth the stake changes, is refreshed first, in
      // the same transaction.
      const before = loot.stakeRefreshFirst(farm, mine, { tier, now: await chainNow() })
        ? await refreshOf(f, farm, mine)
        : [];
      return send(await walking(f, farm, [...before, ...withSolWrap(wallet.address, mint, value, [ix])]));
    },

    /**
     * Takes `amount` out once its lock has run (0: only rewards); `forfeit` gives up rewards that cannot move. Before the
     * lock, a tier with an early exit lets it leave for its fee, keeping what the seat was credited.
     */
    async unstake(farmKey, amount = 0, { forfeit = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['forfeit', 'extra', 'transfers'], 'unstake');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const value = units(amount, decimalsOf(f.stakes));
      const mints = [...(value > 0n ? [farm.farmed.Tokens.mint] : []), ...(!forfeit ? [farm.rewards_mint] : [])];
      const token = await farmTokens(mints, mints, { extra, transfers });
      // An exit that would lose what the seat grew since its last refresh writes it first, in the same transaction.
      const by = wallet.address;
      const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
      const first = [];
      if (seat && loot.refreshFirst(farm, seat, value, forfeit)) {
        const { before, ...nft } = seat.asset !== NO_ADDRESS ? await nftOf(seat.asset) : { before: [] };
        first.push(
          ...before,
          loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by, seat, ...nft, extra: token.extra }),
        );
      }
      return send(
        await walking(f, farm, [
          ...token.before,
          ...first,
          loot.unstakeTokensIx({ player: wallet.address, project, id: f.id, farm, amount: value, forfeit, ...token }),
        ]),
      );
    },

    /**
     * Stakes one of the player's NFTs in a farm (its own seat, or as the booster of their token seat), of any kind: a
     * Core asset, a Token Metadata NFT's mint (legacy or pNFT), or a compressed NFT's asset id. In a farm that watches,
     * an NFT whose last staker sold it takes their seat over. A farm with an end takes none at its end or after it.
     */
    async stakeNft(farmKey, asset, tier = 0, { extra, transfers, acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['extra', 'transfers', 'acceptLeftover'], 'stakeNft');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      // A farm that keeps its NFTs in escrow hands this one to the project (what an earlier owner left of it there is
      // cleared first); one that freezes or watches leaves it in the wallet, where no record of the project's can move it.
      const clears = farm.custody === 'Escrow' ? await clearLeftovers(asset, acceptLeftover) : [];
      await openFor(f, farm, tier);
      const token = await farmTokens([farm.rewards_mint], [], { extra, transfers });
      const { before, ...nft } = await nftOf(asset);
      const seat =
        farm.custody === 'Watch' && farm.farmed === 'Collectibles'
          ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset))
          : null;
      const previous = seat && seat.player !== wallet.address ? seat.player : null;
      // A booster boosts a stake: a farm of tokens takes one only on a seat with tokens staked (NotFarmed). In a farm
      // whose growth writes the profile, the seat is refreshed first, in the same transaction (`boosterRefreshFirst`).
      const refresh = [];
      if (farm.farmed.Tokens) {
        const mine = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), wallet.address));
        if (!mine || BigInt(mine.amount) === 0n)
          throw new Error(`Stake some ${f.stakes} in “${f.name ?? f.key}” first: a booster boosts a stake.`);
        if (loot.boosterRefreshFirst(farm)) refresh.push(...(await refreshOf(f, farm, mine)));
      }
      // Its way out must land too: its unstake from this tier, with the tier's
      // prize and as a forfeit, is sized before it goes in, and an NFT that could never come back out isn't staked.
      if (!farm.farmed.Tokens) await exitFits(f, farm, asset, nft, before, tier, token);
      return send(
        await closesFirst(
          clears,
          await walking(f, farm, [
            ...refresh,
            ...before,
            loot.stakeNftIx({
              player: wallet.address,
              project,
              id: f.id,
              farm,
              asset,
              ...nft,
              previous,
              tier,
              ...token,
            }),
          ]),
        ),
      );
    },

    /**
     * Releases the collectible after its lock: it grows on its way out (a farm with `growth`), and from its own seat
     * takes its tier's prize (a mission: `prize.rs`). `forfeit` gives up rewards, and the prize, that cannot move. A
     * prize that can't be given now refuses the leave and the NFT stays (`needPrize`, true by default); `needPrize: false`
     * leaves without it (the receipt says `prize_missed`). Returns the signature, or { signature, roll } when it makes a roll (a mission's result on the NFT, or a chest),
     * which `collect` then finishes.
     */
    async unstakeNft(
      farmKey,
      asset,
      { forfeit = false, needPrize = true, extra, transfers, acceptLeftover, ...others } = NO_OPTIONS,
    ) {
      only(others, ['forfeit', 'needPrize', 'extra', 'transfers', 'acceptLeftover'], 'unstakeNft');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const token = await farmTokens(
        forfeit ? [] : [farm.rewards_mint],
        forfeit || farm.farmed.Tokens ? [] : [farm.rewards_mint],
        { extra, transfers },
      );
      // Held in escrow, it comes back into the player's account (frozen in place, it never left it).
      const { before, ...nft } = await nftOf(asset, wallet.address, {
        to: farm.custody === 'Escrow' ? wallet.address : undefined,
      });
      // Leaving a mission that rolls: its roll is made in an order of the player's, which `collect` then finishes; its
      // prize's roll (a chest) at the next nonce.
      // A booster on a token farm sits on the player's own seat (farm.rs `seat_by`: by the player in a farm of tokens,
      // by the NFT in a farm of NFTs).
      const seat = await read(
        'Seat',
        loot.pda.seat(loot.pda.farm(project, f.id), farm.farmed.Tokens ? wallet.address : asset),
      );
      const roll = farm.tiers[seat.tier]?.roll ?? null;
      const prize = farm.tiers[seat.tier]?.prize ?? null;
      // A forfeit takes no prize: none of its accounts (`unstakeNftIx`).
      const given = await prizeInputs([forfeit ? null : prize]);
      // A mission's roll on the NFT: on a box that holds it, at the NFT's own nonce (one at a time on it), else at
      // `prizeRollNonce` of the one named (`namedRollNonce`).
      const nonce = roll != null ? loot.nonceOn(asset) : freshNonce();
      const boxes = roll != null ? { [roll]: await read('LootBox', loot.pda.box(project, roll)) } : {};
      // A mission whose box holds the NFT it rolls on takes it into the project's hands on the way out, from a farm that
      // left it in the wallet.
      const clears =
        roll != null && farm.custody !== 'Escrow' && loot.boxHolds(boxes[roll])
          ? await clearLeftovers(asset, acceptLeftover)
          : [];
      // A roll still at the NFT's order address blocks the leave, unless it was asked and came back with nothing to give
      // (Waiting, asked once): that one stands in for this. Any other is asked (its player or the project's keys), answered and settled first.
      if (roll != null) {
        const at = loot.pda.order(project, wallet.address, loot.namedRollNonce(boxes[roll], asset, nonce));
        const there = await readMaybe('Order', at);
        if (there && !(there.status === 'Waiting' && BigInt(there.asked_first) !== 0n))
          throw new Error(
            `This NFT's last mission roll (${at}) hasn't finished: it must be asked, answered and settled before the NFT can leave. claims() lists the step; collect it (app.collect), then leave.`,
          );
      }
      const ix = loot.unstakeNftIx({
        player: wallet.address,
        project,
        id: f.id,
        farm,
        asset,
        ...nft,
        forfeit,
        needPrize,
        roll,
        nonce,
        tier: seat.tier,
        projectCollection: given.collection,
        poolMints: given.poolMints,
        items: given.items,
        nft: given.nft,
        boxes,
        ...token,
      });
      const steps = await walking(f, farm, [...before, ...given.before, ...token.before, ix]);
      // A mission prize that can't be given now (its pool short, an item sold out) refuses the leave and the NFT stays
      // (PrizeNotCovered): say so, and offer to leave without it (`needPrize: false`).
      if (prize != null && !forfeit && needPrize) {
        const tried = await dryRun(wallet.address, steps);
        if (!tried.ok && tried.error?.name === 'PrizeNotCovered')
          throw Object.assign(
            new Error(
              `This NFT's mission prize can't be given now, so it stays staked. Leave without the prize (needPrize: false) to take the NFT home now; the prize is then not given.`,
            ),
            { code: tried.error.code, name: 'PrizeNotCovered' },
          );
      }
      const { signature, rolls } = await sendRolling(await closesFirst(clears, steps));
      const rolled = rolls.length ? { rolled: rolls[0] } : {};
      if (roll != null)
        return {
          signature,
          roll: loot.pda.order(project, wallet.address, loot.namedRollNonce(boxes[roll], asset, nonce)),
          ...rolled,
        };
      return prize?.Roll && !forfeit
        ? { signature, roll: loot.pda.order(project, wallet.address, loot.prizeRollNonce(nonce + 1n)), ...rolled }
        : signature;
    },

    /**
     * What farm `farmKey` has to walk: `{ ends, needsWalk, parts }`, the times its seats stop earning it has passed and not
     * yet credited up to, whether a move can no longer do them in its own transaction, and how many transactions
     * `walkFarm` would take. Every move walks them first; nothing is lost however long they wait.
     */
    async farmWalk(farmKey) {
      const f = part('farms', farmKey);
      const { left } = await endsOf(f, await read('Farm', loot.pda.farm(project, f.id)));
      return { ends: left, needsWalk: left > loot.MOVE_WALK_ROOM, parts: Math.ceil(left / loot.WALK_PER_TX) };
    },

    /**
     * Walks a farm up to now in parts (`walk_farm`), for one that has passed more ends than a move can walk: one transaction
     * for every `loot.WALK_PER_TX` ends, oldest first. Anyone may send it, and it costs only the network fee. Returns their
     * signatures, none when there is nothing to walk.
     */
    async walkFarm(farmKey, { perTx = loot.WALK_PER_TX, ...others } = NO_OPTIONS) {
      only(others, ['perTx'], 'walkFarm');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const { ends } = await endsOf(f, farm);
      const out = [];
      for (const ix of loot.walkFarmParts({ project, id: f.id, farm, ends, now: await chainNow(), perTx }))
        out.push(await send([computeUnitLimit(loot.WALK_COMPUTE_UNITS), ix]));
      return out;
    },

    /**
     * Writes what a staked collectible has grown (a farm with `growth`: its points and level, on it or in its Sheet)
     * and reads its boosts again. Anyone may send it; the player pays for what the write adds. `by`: the collectible,
     * or the player for their token seat's booster.
     */
    async refresh(farmKey, by, { extra, ...others } = NO_OPTIONS) {
      // `transfers` (a token's transfer plan) is taken and needs nothing: a refresh moves no tokens.
      only(others, ['extra', 'transfers'], 'refresh');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const seat = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
      const held = seat.asset !== NO_ADDRESS;
      const { before, ...nft } = held ? await nftOf(seat.asset) : { before: [], hasAuthority: true };
      // A refresh moves no tokens (a farm's rewards are numbers until a seat is paid): only a collectible's own tail.
      return send(
        await walking(f, farm, [
          ...before,
          loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by, seat, ...nft, extra: extra ?? [] }),
        ]),
      );
    },

    /**
     * Collects what a seat owes (the player's own, or one of their collectibles' seats). In a farm that watches, it
     * shows the seat's NFT is still theirs: the Core asset, or their token account of a Token Metadata NFT.
     */
    async harvest(farmKey, by = wallet.address, { compound = false, extra, transfers, ...others } = NO_OPTIONS) {
      only(others, ['compound', 'extra', 'transfers'], 'harvest');
      const f = part('farms', farmKey);
      const farm = await read('Farm', loot.pda.farm(project, f.id));
      const token = await farmTokens([farm.rewards_mint], [farm.rewards_mint], { extra, transfers });
      // In a farm that watches: what shows the seat's NFT is still the player's (a compressed one proven first).
      let [held, tree, before] = [null, null, []];
      if (farm.custody === 'Watch') {
        const { asset } = await read('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by));
        if (asset !== NO_ADDRESS) {
          const nft = await nftOf(asset);
          held = nft.compressed ? loot.pda.leaf(asset) : nft.tokenMetadata ? loot.ata(wallet.address, asset) : asset;
          tree = nft.compressed?.tree ?? null;
          before = nft.compressed ? nft.before : [];
        }
      }
      // A compound stakes more: a seat with a booster on, or whose growth reads the amount, is refreshed first.
      const seat = compound ? await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), by)) : null;
      const first = loot.stakeRefreshFirst(farm, seat, { compound: true }) ? await refreshOf(f, farm, seat) : [];
      return send(
        await walking(f, farm, [
          ...before,
          ...token.before,
          ...first,
          loot.harvestIx({ player: wallet.address, project, id: f.id, farm, by, held, tree, compound, ...token }),
        ]),
      );
    },

    /**
     * Adds what a token seat is owed to its stake, without restarting its lock (a farm of tokens whose rewards are the
     * staked token).
     */
    async compound(farmKey, opts = {}) {
      only(opts, ['extra', 'transfers'], 'compound');
      return this.harvest(farmKey, wallet.address, { ...opts, compound: true });
    },

    /**
     * The player's seats in a farm (the wallet's, or `player`'s): each one's NFT (`asset`, null for a token seat with
     * no booster), what it holds staked (`amount`, in whole units of the staked token, a number for display that can
     * round past 2^53 base units; `amountUnits`, in base units exactly, a bigint; 1 for an NFT), its tier, when it
     * came in (`since`) and when its lock is over (`freeAt`, unix seconds; null when the NFT says it, `lockKey`), its
     * boost in percent, until when it earns (`earnsUntil`, unix seconds, null for no end: a tier's term, an upkeep), and
     * what it is owed now: `waiting` (whole units of the rewards, `rewards` their token) and `owedUnits` (base units). What it is owed is the program's own sum, from a refresh of the seat dry-run on the
     * network (nothing is signed or sent): what the farm released or its rate paid since its last move is in it, by the
     * farm's rounding. When the dry run fails, it is what the seat was last credited, and `counted` is false.
     * One search of the chain, and one dry run per seat: read it when the page opens and after a stake or a harvest.
     */
    async staked(farmKey, player = wallet?.address) {
      if (!player) throw new Error('Connect a wallet first.');
      const f = part('farms', farmKey);
      const farmAddress = loot.pda.farm(project, f.id);
      const farm = await read('Farm', farmAddress);
      const rewards = [...tokens.values()].find(t => mintOf(t.key) === farm.rewards_mint);
      const nfts = f.stakes === 'collectibles';
      // A seat names its player (offset 1), not its farm: a seat of this farm is the one at its own address here.
      const found = (
        await client.programAccounts(loot.lootProgram(), [
          { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Seat)) } },
          { memcmp: { offset: 1, bytes: player } },
        ])
      ).filter(({ pubkey, account }) => {
        const seat = loot.decode('Seat', account.data);
        return pubkey === loot.pda.seat(farmAddress, nfts ? seat.asset : player);
      });
      const { blockhash } = await client.latestBlockhash();
      // Who the dry run names as the refresh's signer and fee payer: the network wants one that holds SOL, whoever it is
      // (nothing is signed): the player, else the wallet looking, else the project's authority.
      let payer;
      const funded = async () => {
        for (const a of [player, wallet?.address, live.authority].filter(Boolean))
          if ((await client.balance(a).catch(() => 0n)) > 0n) return a;
        return player;
      };
      const out = [];
      for (const { pubkey, account } of found) {
        let seat = loot.decode('Seat', account.data);
        const held = seat.asset !== NO_ADDRESS;
        let counted = false;
        try {
          payer ??= await funded();
          const { before, ...nft } = held ? await nftOf(seat.asset, payer) : { before: [] };
          const by = nfts ? seat.asset : player;
          const ix = loot.refreshSeatIx({ signer: payer, project, id: f.id, farm, by, seat, ...nft });
          const message = compileMessage({ payer, blockhash, instructions: [...before, ix] });
          const after = (
            await client.simulate(wireTransaction(message), { accounts: [pubkey], replaceBlockhash: true })
          ).accounts[0];
          if (after?.data) [seat, counted] = [loot.decode('Seat', after.data), true];
        } catch {
          // The seat as it was last credited.
        }
        const lock = BigInt(farm.tiers[seat.tier]?.lock ?? 0);
        out.push({
          asset: held ? seat.asset : null,
          amount: nfts ? 1 : Number(show(seat.amount, decimalsOf(f.stakes))),
          amountUnits: nfts ? 1n : BigInt(seat.amount),
          tier: seat.tier,
          since: Number(seat.since),
          freeAt: farm.lock_key ? null : Number(BigInt(seat.since) + lock),
          ...(farm.lock_key ? { lockKey: farm.lock_key } : {}),
          boostPercent: Number(seat.boost_bps) / 100,
          // Its weight in the farm, as the seat holds it: near the farm's total cap a seat weighs only what is left, so
          // it is read, never worked out from the tier and the boost.
          weight: BigInt(seat.weight),
          rewards: rewards?.key ?? null,
          waiting: show(seat.owed, rewards ? decimalsOf(rewards.key) : 0),
          owedUnits: BigInt(seat.owed),
          // Until when it earns and grows (unix seconds): its tier's term or its fuel, the sooner; null for no end.
          earnsUntil: BigInt(seat.earns_until) >= loot.NO_END ? null : Number(seat.earns_until),
          counted,
        });
      }
      return out;
    },
  };
}
