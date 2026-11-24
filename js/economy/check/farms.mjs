// The checks of farms (farm.rs), and two that read a farm's rates: a sharing farm's rounding (the analyses run it on
// the simulation's rows) and a minting rate's room in its mint.
import { realMoney } from '../../client/pda.js';
import {
  DAY,
  LIMITS,
  RESERVED_ATTRIBUTES,
  listOf,
  farmFillers,
  releaseSeconds,
  releaseWords,
  farmCeiling,
  farmEndWords,
  toBps,
  toBy,
  toSeconds,
} from '../model.mjs';
import { label } from '../format.mjs';

/** Checks the farms. */
export function checkFarms(c) {
  const {
    refuse,
    warn,
    m,
    units,
    fourByteSeconds,
    fromNowSeconds,
    tooMany,
    percent,
    boostPercent,
    token,
    pool,
    item,
    prizeCheck,
    rule,
    effect,
  } = c;
  // ---- farms (farm.rs)
  for (const f of m.farms) {
    const where = `economy.farms.${f.key}`;
    const ofCollectibles = f.stakes === 'collectibles';
    // A farm that shares what arrives releases it to the seats over its release span (its longest lock, a day at
    // least), by weight as it is released: nobody takes at once what landed before them. A seat alone still
    // earns all that is released while it is alone, however small it is.
    // Its rewards land in a vault of its own (`["rewards", farm]`): `rewards` names their token, never a pool.
    if (f.rewards && !m.tokens.has(f.rewards)) {
      if (m.pool.has(f.rewards))
        refuse(
          'E-FARM',
          `${where}.rewards`,
          `${label(f)} names the pool “${f.rewards}” for its rewards: a farm’s rewards land in a vault of its own now, and "rewards" names their token.`,
          `Write "rewards": "${m.pool.get(f.rewards).currency}", and send the farm what it shares with "farm:${f.key}" (in a split, or a schedule that pays it) or "seed".`,
        );
      else token(f.rewards, `${where}.rewards`);
    }
    const rewardsToken = m.tokens.get(f.rewardsToken);
    const fills = farmFillers(m).filter(x => x.farm === f.key);
    if (f.seed !== undefined) units(f.seed, rewardsToken, `${where}.seed`, `The seed of ${label(f)}`);
    if (!f.rate?.minted && Number(f.rate?.perDay ?? 1) > 0 && !fills.length)
      warn(
        'W-FARM-DRY',
        `${where}`,
        `${label(f)} ${f.rate ? 'pays its rate from what its rewards vault holds free' : 'shares what lands in its rewards vault'}, and nothing in this spec sends it any: its seats earn nothing until someone does.`,
        `Seed it ("seed"), send it a share of a sale ("farm:${f.key}" in a split), or pay it with a schedule ("to": "farm:${f.key}").`,
      );
    // A farm that shares what arrives releases it to the seats over its release span (its longest lock, a day at
    // least), by weight as it is released: nobody takes at once what landed before them. A seat alone still
    // earns all that is released while it is alone, however small it is.
    if (!f.rate && fills.length)
      warn(
        'W-FARM-FIRST',
        `${where}.rewards`,
        `${label(f)} shares what lands in its rewards vault (${fills.map(x => x.by).join(', ')}), released over ${releaseWords(f)} as seats stay: whoever stakes first is credited all that is released while they are the only one in, even with 1 unit.`,
        'Have the owner hold a small seat from the start, or tell stakers early ones share the first rewards among few.',
      );
    // A rewards mint that keeps a fee on transfers: what lands in the vault and what each seat is paid arrive less it.
    const feePercent = Number(rewardsToken?.powers?.transferFeePercent ?? 0);
    if (toBps(feePercent) > 0 && !f.rate?.minted)
      warn(
        'W-FARM-FEE',
        `${where}.rewards`,
        `${label(f)}’s rewards keep ${feePercent}% of every transfer: what lands in its vault arrives less that, and so does what each seat is paid.`,
        'Use a rewards token without a fee, or say so to stakers.',
      );
    if (!ofCollectibles) {
      const tok = token(f.stakes, `${where}.stakes`);
      if (tok?.wsol)
        warn(
          'W-FARM',
          `${where}.stakes`,
          `${label(f)} stakes SOL: players stake wrapped SOL, which their wallet makes for them.`,
        );
      if (f.item)
        refuse(
          'E-FARM',
          `${where}.item`,
          `${label(f)} stakes a token, so it takes no item.`,
          'Remove "item", or make it a farm of collectibles ("stakes": "collectibles").',
        );
      if (f.custody === 'watch')
        refuse(
          'E-FARM',
          `${where}.custody`,
          `${label(f)} stakes a token: its boosters can’t be left free and watched, or one sold could keep boosting.`,
          'Use "custody": "escrow" or "freeze", or make it a farm of collectibles.',
        );
    }
    // Early exits (farm.rs): a fee leaves to a burn, a pool of its token or the farm's own vault, checked once at open.
    const exits = (f.tiers ?? []).some(t => Number(t.exitFee ?? 0) > 0);
    const sinkOk = (to, at, tokenKey, what) => {
      if (to === 'rewards') {
        if (tokenKey !== f.rewardsToken)
          refuse(
            'E-FARM',
            at,
            `${label(f)} sends ${what} into its own rewards vault, but it stakes ${m.tokens.get(tokenKey)?.symbol ?? tokenKey} and its rewards are ${m.tokens.get(f.rewardsToken)?.symbol ?? f.rewardsToken} (WrongMint).`,
            'Send it to a burn or a pool, or make its rewards its staked token.',
          );
        return;
      }
      if (to === 'burn') {
        if (m.tokens.get(tokenKey)?.wsol)
          refuse(
            'E-WSOL-BURN',
            at,
            `${label(f)} burns ${what} in SOL, and wrapped SOL cannot be burned: every exit or harvest that owes it would fail.`,
            'Send it to a pool instead.',
          );
        return;
      }
      const p = pool(String(to).slice(5), at);
      if (p && tokenKey && p.currency !== tokenKey)
        refuse(
          'E-POOL-MINT',
          at,
          `${label(f)} sends ${what} to “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol ?? p.currency}, not ${m.tokens.get(tokenKey)?.symbol ?? tokenKey} (WrongMint).`,
          `Send it to a pool of ${m.tokens.get(tokenKey)?.symbol ?? tokenKey}.`,
        );
    };
    if (ofCollectibles && exits)
      refuse(
        'E-FARM',
        `${where}.tiers`,
        `${label(f)} stakes collectibles: there is no stake to take an exit fee from (BadFarm). A collectible leaves early by a recipe that lowers its lock.`,
        'Remove "exitFee", and give the farm a "lockAttribute" and a recipe that lowers it.',
      );
    if (!ofCollectibles && exits && !f.exitFeeTo)
      refuse(
        'E-FARM',
        `${where}.exitFeeTo`,
        `${label(f)} has an early-exit fee but does not say where it goes (BadFarm).`,
        'Add "exitFeeTo": "burn", "rewards" or "pool:<key>".',
      );
    if (!ofCollectibles && f.exitFeeTo) sinkOk(f.exitFeeTo, `${where}.exitFeeTo`, f.stakes, 'its exit fees');
    (f.tiers ?? []).forEach((t, i) => percent(t.exitFee, `${where}.tiers[${i}].exitFee`));
    if (!ofCollectibles && exits)
      warn(
        'W-FARM',
        `${where}.tiers`,
        `${label(f)}’s tiers with an early exit may leave before the lock for the fee, keeping the rewards they were credited (a tier's extra weight can be bought for its exit fee): pick the fee with that in mind.`,
      );
    if (f.exitFeeTo === 'rewards')
      warn(
        'W-FARM',
        `${where}.exitFeeTo`,
        `${label(f)} sends early-exit fees into its own rewards vault: the stakers who stay share them.`,
      );
    if (ofCollectibles && f.item) {
      const it = item(f.item, `${where}.item`);
      if (it && it.kind === 'normal')
        refuse(
          'E-FARM',
          `${where}.item`,
          `${label(f)} takes ${label(it)}, a normal item: only collectibles can be staked.`,
          `Make ${label(it)} a collectible.`,
        );
      if (it?.soulbound && (f.custody ?? 'escrow') === 'escrow')
        refuse(
          'E-FARM',
          `${where}.custody`,
          `${label(f)} holds collectibles in escrow, and ${label(it)} is soulbound: it can’t move to the game.`,
          'Use "custody": "freeze", or a collectible that is not soulbound.',
        );
    }
    if (f.custody === 'watch' && listOf(f.growth).some(g => g.streak))
      refuse(
        'E-FARM',
        `${where}.growth`,
        `${label(f)} watches NFTs left free in their wallets and counts a streak: one leaves by being moved, with nothing to set its streak back to 0, so the program refuses it (BadFarm).`,
        'Use "custody": "escrow" or "freeze" for a streak, or drop "streak".',
      );
    if (f.custody === 'watch')
      warn(
        'W-FARM-CUSTODY',
        `${where}.custody`,
        `${label(f)} watches NFTs left free in their wallets: one sold while staked stops earning for its staker (what its seat was owed ${f.rate ? (f.rate.minted ? 'is never minted' : 'stays free in its vault') + ', never to the other seats' : 'goes back to its vault, released again with the rest'}), and its new holder can take the seat over, paying the last staker back the seat’s rent.`,
      );
    else if (f.custody === 'freeze')
      warn(
        'W-FARM-CUSTODY',
        `${where}.custody`,
        `${label(f)} locks NFTs in their wallets (a Core freeze, Token Metadata’s lock, a compressed NFT’s freeze), with the game the only key that unlocks them. For ordinary Core assets, issuer metadata or plugin growth can make unfreezing fail; a soulbound asset needs no extra freeze. This also applies to token-seat boosters.`,
        'Use escrow for transferable collectibles, or retain freeze only with a trusted issuer and controlled metadata changes.',
      );
    else if (ofCollectibles || (f.boosts ?? []).length)
      warn(
        'W-FARM-CUSTODY',
        `${where}.custody`,
        `${label(f)} escrows collectibles. This avoids Core’s unfreeze operation, but issuer-controlled transfer rules can still block return. Soulbound collectibles require explicit freeze custody.`,
      );
    const tiers = f.tiers ?? [{ lock: 0, multiplier: 1 }];
    if (tiers.length > LIMITS.tiers)
      refuse(
        'E-FARM',
        `${where}.tiers`,
        `${label(f)} has ${tiers.length} lock tiers; a farm has at most ${LIMITS.tiers}.`,
        'Merge tiers.',
      );
    tooMany(
      (f.boosts ?? []).length,
      LIMITS.farmRules,
      'E-FARM',
      `${where}.boosts`,
      `${label(f)} has ${(f.boosts ?? []).length} boosts`,
      'BadFarm',
      'Keep the boosts that matter.',
    );
    tooMany(
      listOf(f.gate).length,
      LIMITS.farmRules,
      'E-FARM',
      `${where}.gate`,
      `${label(f)}’s gate has ${listOf(f.gate).length} rules`,
      'BadFarm',
      'Keep the rules that matter.',
    );
    tooMany(
      listOf(f.growth).length,
      LIMITS.farmRules,
      'E-FARM',
      `${where}.growth`,
      `${label(f)} has ${listOf(f.growth).length} growths`,
      'BadFarm',
      'Keep the numbers that matter.',
    );
    for (const [i, g] of listOf(f.growth).entries())
      tooMany(
        (g.levels ?? []).length,
        LIMITS.growthSteps,
        'E-FARM',
        `${where}.growth[${i}].levels`,
        `${label(f)}’s growth of “${g.attribute ?? 'xp'}” has ${(g.levels ?? []).length} levels`,
        'BadFarm',
        'Use fewer levels.',
      );
    for (const [i, t] of tiers.entries()) {
      fourByteSeconds(t.lock, `${where}.tiers[${i}].lock`);
      // A mission with no lock is the project's choice: one NFT can come and go and take it each time.
      if ((t.prize || t.roll) && !(toSeconds(t.lock ?? 0) > 0))
        warn(
          'W-FARM-MISSION',
          `${where}.tiers[${i}].lock`,
          `No lock on ${label(f)}’s mission tier ${i}: one player can stake and leave one NFT again and again and ${t.prize ? 'take the prize' : 'roll the box'} each time.`,
          'Give the tier a "lock" above 0, such as "1d".',
        );
      if (t.earnsFor !== undefined) fourByteSeconds(t.earnsFor, `${where}.tiers[${i}].earnsFor`);
      const bps = Math.round((t.multiplier ?? 1) * 10_000);
      if (bps <= 0 || bps > LIMITS.maxTierBps)
        refuse(
          'E-FARM',
          `${where}.tiers[${i}].multiplier`,
          `${label(f)}’s tier ${i} multiplies by ${t.multiplier}: a tier is above 0 and at most x${LIMITS.maxTierBps / 10_000} (BadFarm).`,
          `Use a multiplier above 0, up to ${LIMITS.maxTierBps / 10_000}.`,
        );
      // A heavy tier a seat can leave early for a fee: the weight is bought for the fee.
      else if (bps >= 30_000 && Number(t.exitFee ?? 0) > 0 && !ofCollectibles)
        warn(
          'W-FARM',
          `${where}.tiers[${i}].exitFee`,
          `${label(f)}’s tier ${i} weighs x${t.multiplier} and lets a seat leave early for ${t.exitFee}%: a player can take the large weight, earn at it, and leave for the fee.`,
          'Check the fee is worth what the tier pays over its lock, or drop the early exit on heavy tiers.',
        );
      else if (bps < 10_000)
        warn(
          'W-FARM',
          `${where}.tiers[${i}].multiplier`,
          `${label(f)}’s tier ${i} weighs x${t.multiplier}, less than what it stakes: a flexible tier that earns less.`,
        );
    }
    for (const [i, b] of (f.boosts ?? []).entries()) {
      rule(b.when, `${where}.boosts[${i}].when`, `${label(f)}’s boost`);
      effect(b.add, `${where}.boosts[${i}].add`, `${label(f)}’s boost`);
      // A boost per point adds its percent times its most points, at most +100,000% (rules.rs `Boost::check`).
      const most = Number(b.add?.perPointPercent ?? 0) * Number(b.add?.upTo ?? 0);
      if (b.add?.perPointPercent !== undefined && Math.round(most * 100) > LIMITS.maxBoostBps)
        refuse(
          'E-FARM',
          `${where}.boosts[${i}].add`,
          `${label(f)}’s boost adds ${b.add.perPointPercent}% a point up to ${b.add.upTo} points: +${most.toLocaleString('en-US')}% at most, past the +${(LIMITS.maxBoostBps / 100).toLocaleString('en-US')}% a farm’s boost may add (BadFarm).`,
          'Add less a point, or count fewer points ("upTo").',
        );
    }
    boostPercent(f.maxBoostPercent, `${where}.maxBoostPercent`);
    if ((f.boosts ?? []).length && !(f.maxBoostPercent > 0))
      warn(
        'W-FARM',
        `${where}.maxBoostPercent`,
        `${label(f)} has boosts but no "maxBoostPercent", so they add nothing (the cap is 0).`,
        'Set "maxBoostPercent", for example 100 (at most double).',
      );
    // A fixed rate (`rate`), growth (`growth`) and missions (tiers' `prize`).
    const growths = listOf(f.growth);
    const prized = tiers.some(t => t.prize);
    const rolls = tiers.some(t => t.roll);
    if (f.rate) {
      const perDay = units(f.rate.perDay, rewardsToken, `${where}.rate.perDay`, `${label(f)}’s rate`);
      if (!(Number(f.rate.perDay) > 0)) {
        if (!growths.length && !prized && !rolls)
          warn(
            'W-FARM',
            `${where}.rate.perDay`,
            `${label(f)}’s fixed rate pays nothing a day, and it grows nothing, gives no prize and rolls no mission: staking there only counts (a stake gate can read it).`,
            'Set "perDay" above 0, or give it "growth", a mission prize or a mission roll.',
          );
      } else if (
        !ofCollectibles &&
        !f.rate.shared &&
        perDay !== null &&
        (perDay * 1_000_000n) / 10n ** BigInt(m.tokens.get(f.stakes)?.decimals ?? 0) === 0n
      )
        warn(
          'W-FARM',
          `${where}.rate.perDay`,
          `${label(f)}’s rate of ${f.rate.perDay} a day is less than one base unit for each 1,000,000 base units staked.`,
          'Raise "perDay".',
        );
      // A rate the program keeps without its last digits (model.mjs `keptRate`): said, with what is paid.
      const paid = m.farm.get(f.key)?.rate;
      if (paid?.perDaySaid !== undefined && Number(paid.perDay) > 0)
        warn(
          'W-FARM-RATE',
          `${where}.rate.perDay`,
          `${label(f)}’s rate of ${paid.perDaySaid} a day is paid as ${paid.perDay} a day for each ${m.tokens.get(f.stakes)?.symbol ?? f.stakes}: the program keeps a rate for each 1,000,000 base units staked, and ${m.tokens.get(f.stakes)?.symbol ?? f.stakes} has ${m.tokens.get(f.stakes)?.decimals} decimals, so the last digits go.`,
          `Write "perDay": ${paid.perDay} to say what is paid, or a rate whose last digits the program keeps.`,
        );
      // The rate the program keeps, for each 1,000,000 base units staked (plan.mjs `farmArgs`), fits 8 bytes: a large rate
      // in a token of many decimals, for a staked token of few, does not, and the setup could not write it.
      const kept =
        perDay !== null && !ofCollectibles && !f.rate.shared
          ? (perDay * 1_000_000n) / 10n ** BigInt(m.tokens.get(f.stakes)?.decimals ?? 0)
          : perDay;
      if (kept !== null && kept > 2n ** 64n - 1n)
        refuse(
          'E-FARM',
          `${where}.rate.perDay`,
          `${label(f)}’s rate of ${f.rate.perDay} a day comes to ${kept.toLocaleString('en-US')} base units for each 1,000,000 base units staked, more than the program can hold (8 bytes).`,
          'Lower "perDay", or stake a token of more decimals.',
        );
      // A farm that mints while the project is not the mint's authority credits nothing, and what it would have paid is
      // not owed later; the program takes it, so the mint can be handed over after.
      if (f.rate.minted && rewardsToken && !rewardsToken.gameMints)
        warn(
          'W-FARM-AUTHORITY',
          `${where}.rate.minted`,
          `${label(f)} mints its rewards, but the project is not the authority of ${rewardsToken.symbol}’s mint. It pays nothing until you set the mint’s authority to the project’s address; rewards for that time are lost, not paid later. When you hand the mint over, send \`walk_farm\` in the same transaction, just before it: then nothing from before the hand-over is ever paid; without it, the first move after the hand-over credits all the time since the farm’s last move.`,
          'Reward in a token the project makes (source "project"), pay the rate from its rewards vault ("minted": false), or hand the mint to the project before the farm opens.',
        );
      if (f.rate.minted && rewardsToken)
        warn(
          'W-FARM',
          `${where}.rate.minted`,
          `${label(f)} mints ${rewardsToken.symbol}: if the project ever moves the mint’s authority away, stakers cannot harvest what they are owed and can only leave by giving it up.`,
          undefined,
          { severity: 'medium' },
        );
      if (!f.rate.minted)
        warn(
          'W-FARM-RATE',
          `${where}.rate`,
          `${label(f)} pays its fixed rate from what its rewards vault holds free while it lasts: what it can’t cover is not owed later, and every seat earns less once it runs dry.`,
          `Keep it funded ("farm:${f.key}" in a split or a schedule), or mint the rewards.`,
        );
      else rateRoom(f, warn, m);
      if (f.rate.halveEvery !== undefined) fourByteSeconds(f.rate.halveEvery, `${where}.rate.halveEvery`);
      if (f.rate.shared)
        warn(
          'W-FARM-RATE',
          `${where}.rate.shared`,
          `${label(f)}’s rate of ${f.rate.perDay} a day is the whole farm’s, shared by weight while anything is staked${f.rate.halveEvery ? `, halving every ${f.rate.halveEvery} from when it opens` : ''}: an emission budget, so each seat’s share falls as more stake.`,
        );
      else if (f.rate.halveEvery)
        warn(
          'W-FARM-RATE',
          `${where}.rate.halveEvery`,
          `${label(f)}’s rate halves every ${f.rate.halveEvery} from when it opens, for every seat: each unit staked at x1 earns ${farmCeiling(f).says}.`,
        );
    }
    const names = growths.flatMap(g => [g.attribute ?? 'xp', ...((g.levels ?? []).length ? [g.level ?? 'level'] : [])]);
    if (names.some((n, i) => names.indexOf(n) !== i))
      refuse(
        'E-FARM',
        `${where}.growth`,
        `${label(f)} grows the same attribute twice (${names.join(', ')}): each growth writes names of its own.`,
        'Give each growth its own "attribute" (and "level").',
      );
    for (const [i, g] of growths.entries()) {
      const at = Array.isArray(f.growth) ? `${where}.growth[${i}]` : `${where}.growth`;
      const own = RESERVED_ATTRIBUTES;
      const [points, level] = [g.attribute ?? 'xp', g.level ?? 'level'];
      if (
        own.includes(points) ||
        (g.levels?.length && own.includes(level)) ||
        ((g.levels ?? []).length && points === level)
      )
        refuse(
          'E-FARM',
          at,
          `${label(f)} writes its points under “${points}” and its level under “${level}”: two names of the game’s own, not the program’s (${own.join(', ')}).`,
          'Use names such as "xp" and "level".',
        );
      if ((g.levels ?? []).some((n, i, all) => i > 0 && n <= all[i - 1]))
        refuse(
          'E-FARM',
          `${at}.levels`,
          `${label(f)}’s levels must need more points each.`,
          'List the points each level needs, rising: [100, 300, 600].',
        );
      if (!ofCollectibles && !(f.boosts ?? []).length)
        warn('W-FARM', at, `${label(f)} stakes a token: only a collectible put on a seat as its booster grows.`);
    }
    // A farm whose seats stop earning at times of their own keeps one entry a different second.
    if (tiers.some(t => t.earnsFor !== undefined) || f.upkeepAttribute !== undefined)
      warn(
        'W-FARM-ENDS',
        `${where}.tiers`,
        `${label(f)} keeps one entry for each different second at which a seat stops earning, 238,312 at most; the first staker on a new second pays about 0.0003 SOL for it. When it is full, a stake at a new end time fails until older seats are touched. A stake in a large farm needs more than the default compute (an insert took 145,279 units at the full list).`,
        'Expect it with many stakers: the app asks for more compute on a stake, and anyone may touch old seats for free.',
      );
    if (f.runs !== undefined) {
      const runs = fromNowSeconds(f.runs, `${where}.runs`);
      for (const [i, t] of tiers.entries())
        if (toSeconds(t.lock ?? 0) > 0 && toSeconds(t.lock ?? 0) >= runs)
          warn(
            'W-FARM',
            `${where}.tiers[${i}].lock`,
            `${label(f)} runs ${f.runs}, and its tier ${i} locks ${t.lock}: nobody could ever take it (a seat must be free by the farm’s end, and the farm takes none at its end).`,
            'Shorten the lock, or let the farm run longer.',
          );
      const end = farmEndWords(f);
      warn(
        'W-FARM',
        `${where}.runs`,
        `${label(f)} runs ${f.runs} from when it goes live: it takes no stake at its end or after it (nor one at a tier whose lock would run past it), and pays and grows nothing more; seats leave and harvest what they were owed as before.${end ? ` It shares what lands: ${end}.` : ''}`,
      );
    }
    // Missions' prizes (prize.rs): a tier's, given as a collectible that stayed its lock leaves its seat.
    if (f.prize)
      refuse(
        'E-FARM',
        `${where}.prize`,
        `${label(f)} names where its prizes come from: each tier names its whole prize.`,
        'Move it into each tier: "prize": { "gives": "tokens", "amount": n, "from": "mint" or "pool:<key>" } (or an item, an NFT, a roll of a chest).',
      );
    for (const [i, t] of tiers.entries()) {
      if (!t.prize) continue;
      const at = `${where}.tiers[${i}].prize`;
      if (typeof t.prize !== 'object')
        refuse(
          'E-FARM',
          at,
          `${label(f)}’s tier ${i} pays ${t.prize}: a tier names its whole prize.`,
          'Write "prize": { "gives": "tokens", "amount": n, "from": "mint" or "pool:<key>" }.',
        );
      else prizeCheck(t.prize, at, `${label(f)}’s tier ${i}`, 'E-FARM');
      if (!ofCollectibles)
        refuse(
          'E-FARM',
          at,
          `${label(f)} stakes a token: a mission’s prize is for a collectible that stays its tier’s lock.`,
          'Make it a farm of collectibles, or remove the prizes.',
        );
    }
    for (const [i, t] of tiers.entries()) {
      if (!t.roll) continue;
      const at = `${where}.tiers[${i}].roll`;
      if (!ofCollectibles)
        refuse(
          'E-FARM',
          at,
          `${label(f)} stakes a token: a mission’s roll is for a collectible leaving its seat.`,
          'Make it a farm of collectibles, or remove the roll.',
        );
      if (!m.box.get(t.roll))
        refuse('E-FARM', at, `${label(f)}’s tier ${i} rolls “${t.roll}”, which is no box.`, 'Name a box of this spec.');
      else if (!m.box.get(t.roll).rollsOn)
        refuse(
          'E-FARM',
          at,
          `${label(f)}’s tier ${i} rolls “${t.roll}” on the NFT leaving it, but the box rolls on none: a chest the mission brings back is its prize.`,
          `Write "prize": { "gives": "roll", "box": "${t.roll}" } instead, or give the box "rollsOn".`,
        );
      else if (
        (f.custody ?? 'escrow') === 'watch' &&
        (m.box.get(t.roll).outcomes ?? []).some(o => o.then && o.then !== 'back')
      )
        warn(
          'W-ROLL-CUSTODY',
          at,
          `${label(f)} watches NFTs left free, and its mission’s box can burn or give one away: an NFT its staker sold before leaving is never rolled (it earns nothing either); one still held is taken into the game’s hands for the roll.`,
        );
    }
    // The times a farm of collectibles keeps on the NFT: its lock and an upkeep.
    const times = [
      ['lockAttribute', f.lockAttribute],
      ['upkeepAttribute', f.upkeepAttribute],
    ].filter(([, key]) => key !== undefined);
    for (const [field, key] of times) {
      if (!ofCollectibles)
        refuse(
          'E-FARM',
          `${where}.${field}`,
          `${label(f)} stakes a token, which has nowhere to keep a time: only a farm of collectibles writes one on what it stakes.`,
          `Remove "${field}", or make it a farm of collectibles.`,
        );
      if (RESERVED_ATTRIBUTES.includes(key))
        refuse(
          'E-FARM',
          `${where}.${field}`,
          `“${key}” is a number the program writes itself.`,
          'Use a name of the game’s own, such as "free_at" or "upkeep_until".',
        );
      if (names.includes(key))
        refuse(
          'E-FARM',
          `${where}.${field}`,
          `${label(f)} grows “${key}” and keeps a time under it too.`,
          'Give the time a name of its own.',
        );
    }
    if (f.lockAttribute !== undefined && f.lockAttribute === f.upkeepAttribute)
      refuse(
        'E-FARM',
        `${where}.upkeepAttribute`,
        `${label(f)} keeps its lock and its upkeep under the same name, “${f.lockAttribute}”.`,
        'Give each its own name.',
      );
    if (f.upkeepAttribute !== undefined && ofCollectibles) {
      const sells = m.recipes.some(r =>
        (r.raises ?? []).some(x => x.key === f.upkeepAttribute && x.fromNow && toBy(x.by) > 0),
      );
      warn(
        'W-FARM-UPKEEP',
        `${where}.upkeepAttribute`,
        `${label(f)} pays and grows a collectible only until the time under “${f.upkeepAttribute}”: one staked dry counts for nothing until it is topped up and its seat refreshed, and a seat earns nothing after its upkeep runs out, however late it is next touched (no refresh is needed at its end).${sells ? '' : ' Nothing in this spec sells it: only the authority (Set) could.'}`,
        sells ? undefined : `Add a recipe that raises "${f.upkeepAttribute}" with "fromNow": true.`,
      );
      // A known limit of the program: a recipe with a pay line waits while the project is paused or suspended
      // (craft.rs), and the upkeep's clock keeps running. With every top-up paid and capped below a mission's lock, a
      // switch on for longer than a player could top up ahead dries the seat, and a seat that ran dry before its lock
      // ended never brings its tier's prize (farm.rs: `stayed`), even once it is topped up again.
      const refuels = m.recipes
        .filter(r => r.active !== false)
        .flatMap(r =>
          (r.raises ?? []).filter(x => x.key === f.upkeepAttribute && x.fromNow && toBy(x.by) > 0).map(x => ({ r, x })),
        );
      const prized = tiers.filter(t => t.prize && toSeconds(t.lock ?? 0) > 0);
      if (refuels.length && prized.length && refuels.every(({ r }) => (r.in ?? []).some(l => l.takes === 'pay'))) {
        const ahead = Math.max(...refuels.map(({ x }) => (x.upTo === undefined ? Infinity : toSeconds(x.upTo))));
        const lock = prized.reduce((most, t) => (toSeconds(t.lock) > toSeconds(most.lock) ? t : most));
        if (ahead < toSeconds(lock.lock))
          warn(
            'W-FARM-REFUEL',
            `${where}.upkeepAttribute`,
            `${label(f)}’s missions bring a prize (a ${lock.lock} lock) only to a seat whose “${f.upkeepAttribute}” never ran out, and every recipe that tops it up takes a payment, which waits while the project is paused or suspended (a switch the platform holds too), while the upkeep keeps running down. A player can top it up only ${refuels.map(({ r, x }) => `${x.upTo} ahead with ${label(r)}`).join(', ')}, so a switch on for longer than that dries the seat: its mission’s prize is lost for good, and what it was credited after the lapse is given back, even once it is topped up again.`,
            `Add a top-up recipe with no "pay" line (one paid in nothing goes through while the project is suspended), or let a player top up a whole mission ahead ("upTo" of at least ${lock.lock}, longer than any suspension you would expect).`,
          );
      }
    }
    if (f.gate && !ofCollectibles)
      refuse(
        'E-FARM',
        `${where}.gate`,
        `${label(f)} stakes a token: a gate only says which collectibles a farm of collectibles takes.`,
        'Remove the gate, or use a boost to favour holders.',
      );
    const gates = listOf(f.gate);
    for (const [i, r] of gates.entries())
      rule(r, Array.isArray(f.gate) ? `${where}.gate[${i}]` : `${where}.gate`, label(f));
    // No lock rule for rewards that land: a sharing farm releases each over its release span, and a fixed rate pays by
    // the second, so a stake just before a reward lands and gone right after takes only what was released meanwhile.
    // A farm whose rewards are a share of what players pay hands holders the project's revenue.
    const revenue = fills.filter(x => /^(box|item|payment):/.test(x.by));
    if (revenue.length)
      warn(
        'W-REVENUE-SHARE',
        where,
        `${label(f)} pays stakers a share of what players spend (${revenue.map(x => x.by).join(', ')}). Paying holders out of a project’s revenue is what regulators look at when they decide whether a token is a security.`,
        realMoney()
          ? 'This economy is on mainnet, where that is real money: ask counsel first, or reward stakers from emissions (a schedule that mints a game token) rather than from sales.'
          : 'Fine on devnet. Before mainnet, ask counsel, or reward stakers from emissions (a schedule that mints a game token) rather than from sales.',
      );
  }
}

/** A large number in words a person reads: 7,000 below a billion, 7×10¹⁵ above. */
function many(x) {
  if (x < 1e9) return Math.round(x).toLocaleString('en-US');
  const exp = Math.floor(Math.log10(x));
  const digits = String(exp).replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
  return `${+(x / 10 ** exp).toFixed(1)}×10${digits}`;
}

/**
 * A sharing farm's rounding: a release is credited by weight in steps of the total
 * weight ÷ 10¹² base units of the reward, and what is below a step waits uncredited, freed in its vault when the
 * last seat leaves or the farm ends. A staked token with a great many base units (many decimals, a huge supply: a
 * memecoin) paying a reward of few units rounds every seat's share to nothing: an exact model of the farm found seats
 * losing all of rewards of 194 to 2,155 units at total weights around 7×10¹⁵. The weight is the most that can
 * plausibly be staked (the supply, else a billion whole tokens or the scenario's stake if larger) at the highest tier
 * and the largest boost; the reward, what lands in a release span (the farm's seed and a span of the steady inflow).
 */
export function farmRounding(f, row, warn, m) {
  if (!f || f.rate || f.stakes === 'collectibles') return;
  const staked = m.tokens.get(f.stakes),
    reward = m.tokens.get(f.rewardsToken);
  if (staked?.decimals === undefined || reward?.decimals === undefined) return;
  const scenario = Number(m.scenario.staked?.[f.key] ?? 0);
  const whole = staked.supply !== undefined ? Number(staked.supply) : Math.max(1e9, scenario);
  const top = Math.max(1, ...(f.tiers ?? []).map(t => Number(t.multiplier ?? 1)));
  const boost = (f.boosts ?? []).length ? 1 + Number(f.maxBoostPercent ?? 0) / 100 : 1;
  const weight = whole * 10 ** staked.decimals * top * boost;
  if (!(weight > 1e12)) return;
  const step = weight / 1e12;
  const span = releaseSeconds(f) / DAY;
  const units = (Number(f.seed ?? 0) + Number(row.rewardsPerDay ?? 0) * span) * 10 ** reward.decimals;
  if (!(units > 0) || units >= 100 * step) return;
  const [ss, rs] = [staked.symbol ?? f.stakes, reward.symbol ?? f.rewardsToken];
  const basis = `${staked.supply !== undefined ? `its supply of ${many(whole)}` : whole > 1e9 ? `the scenario’s ${many(whole)} staked` : `a billion ${ss} (assumed when no supply is given)`} at ${staked.decimals} decimals${top > 1 ? `, at x${top}` : ''}${boost > 1 ? `, boosted +${f.maxBoostPercent}%` : ''}`;
  const lost =
    units < step
      ? 'each seat’s share of it rounds down to nothing, so no seat is credited any of it, and it is freed in its vault when the last seat leaves or the farm ends'
      : `up to a step of it at a time waits uncredited until more adds up to a step, and what waits is freed in its vault when the last seat leaves or the farm ends, so the seats can lose up to ${Math.min(100, Math.round((step / units) * 100))}% of a release`;
  warn(
    'W-FARM-ROUNDING',
    `economy.farms.${f.key}.stakes`,
    `${label(f)} shares its rewards by weight, and the stakes in it can weigh up to about ${many(weight)} base units of ${ss} (${basis}). At that weight the program can share a release only in steps of about ${many(step)} base units of ${rs}, and about ${many(units)} land in it over a release (${releaseWords(f)}): ${lost}.`,
    `Stake a token with fewer base units (fewer decimals or a smaller supply), or fund larger rewards: about ${many(100 * step)} base units of ${rs} (${(100 * step) / 10 ** reward.decimals >= 1 ? many((100 * step) / 10 ** reward.decimals) : +((100 * step) / 10 ** reward.decimals).toPrecision(3)} ${rs}) or more a release keeps the rounding under 1%.`,
  );
}

/**
 * A fixed rate that mints: each payout mints what a seat is owed as far as the mint has room for under the most a
 * mint can ever hold (u64::MAX base units, less its supply), and what it can't mint is never owed later. What the rate
 * could mint is the rate times the most that can plausibly be staked (a token's supply, else a billion whole tokens or
 * the scenario's stake if larger; a collectible's supply, else 10,000 or the scenario's count), at the highest tier and
 * the largest boost, over the farm's run (ten years for a farm that never ends). Past a tenth of that room the warning
 * says the seats can come to be paid less than the rate.
 */
function rateRoom(f, warn, m) {
  if (!(Number(f.rate.perDay) > 0)) return;
  const reward = m.tokens.get(f.rewardsToken);
  if (reward?.decimals === undefined) return;
  const scenario = Number(m.scenario.staked?.[f.key] ?? 0);
  const ofCollectibles = f.stakes === 'collectibles';
  const staked = ofCollectibles ? m.item.get(f.item) : m.tokens.get(f.stakes);
  const known = Number(staked?.supply ?? 0) > 0;
  const count = known ? Number(staked.supply) : Math.max(ofCollectibles ? 10_000 : 1e9, scenario);
  const top = Math.max(1, ...(f.tiers ?? []).map(t => Number(t.multiplier ?? 1)));
  const boost = (f.boosts ?? []).length ? 1 + Number(f.maxBoostPercent ?? 0) / 100 : 1;
  const days = f.runs ? toSeconds(f.runs) / DAY : 3650;
  const units = Number(f.rate.perDay) * (f.rate.shared ? 1 : count * top * boost) * days * 10 ** reward.decimals;
  const room = 2 ** 64;
  if (!(units >= room / 10)) return;
  const [rs, unit] = [reward.symbol ?? f.rewardsToken, ofCollectibles ? 'collectible' : (staked?.symbol ?? f.stakes)];
  const basis = `${known ? `a supply of ${many(count)}` : count > (ofCollectibles ? 10_000 : 1e9) ? `the scenario’s ${many(count)}` : ofCollectibles ? '10,000 collectibles' : `a billion ${unit}`} staked${top > 1 ? ` at x${top}` : ''}${boost > 1 ? `, boosted +${f.maxBoostPercent}%` : ''}, ${f.runs ? `over its ${f.runs}` : 'over ten years'}`;
  const whole = room / 10 ** reward.decimals;
  warn(
    'W-FARM-MINT-ROOM',
    `economy.farms.${f.key}.rate`,
    `${label(f)} mints ${f.rate.perDay} ${rs} a day for each ${unit} at x1: at ${basis}, that is about ${many(units)} base units, ${units >= room ? 'more than' : `${Math.round((units / room) * 100)}% of`} the most a mint can ever hold (about ${many(room)} base units, ${many(whole)} ${rs} at ${reward.decimals} decimals). Each move mints only what the mint still has room for, and what it can’t mint is never owed later: once ${rs}’s supply nears that, every seat is paid less than the rate, then nothing.`,
    `Lower "perDay", give the farm an end ("runs"), or reward in a token with fewer decimals.`,
  );
}
