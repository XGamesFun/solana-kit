// The checks of schedules (schedule.rs).
import { addressBytes } from '../../chain/base58.js';
import { isOnCurve } from '../../chain/curve.js';
import { destination, isAddress, keepsPot, SpecError, toTime } from '../model.mjs';
import { label } from '../format.mjs';

/** Checks the schedules. */
export function checkSchedules(c) {
  const { now, refuse, warn, m, units, seconds, fromNowSeconds, timeAt, farTime, percent, token, pool, gameVault } = c;
  // ---- schedules (schedule.rs)
  for (const s of m.schedules) {
    const where = `economy.schedules.${s.key}`;
    if (fromNowSeconds(s.every, `${where}.every`) <= 0)
      refuse('E-SCHEDULE', `${where}.every`, `${label(s)} never comes round (every 0).`, 'Give it a time like "1d".');
    farTime(timeAt(s.start, `${where}.start`), `${where}.start`, `${label(s)}’s start`, s.start, 'it runs nothing');
    // A vault is funded only for a sealed schedule: anywhere else "fund" puts nothing in.
    if (!s.sealed && (s.fund !== undefined || s.fundFrom !== undefined))
      warn(
        'W-SCHEDULE',
        `${where}.${s.fund !== undefined ? 'fund' : 'fundFrom'}`,
        `${label(s)} names what goes into a vault of its own, but it is not sealed: it pays from its pool, and "fund" puts nothing in.`,
        'Seal it ("sealed": true) to pay from a vault of its own, or leave "fund" out and fill its pool.',
      );
    if (!s.sealed)
      farTime(
        now + seconds(s.every, `${where}.every`),
        `${where}.every`,
        `${label(s)}’s next run`,
        s.every,
        'it runs nothing',
      );
    const byShare = s.percent !== undefined;
    if (s.does !== 'issue' && byShare && s.amount !== undefined)
      refuse('E-SCHEDULE', where, `${label(s)} names both a percent and an amount.`, 'Keep one.');
    if (s.does === 'issue') {
      // Into a pool, or a farm's rewards vault ("to": "farm:<key>").
      const intoFarm = destination(s.to ?? '').kind === 'farm';
      const farm = intoFarm ? m.farm.get(destination(s.to).key) : null;
      if (intoFarm && !farm)
        refuse(
          'E-REF',
          `${where}.to`,
          `There is no farm “${destination(s.to).key}”.`,
          'Name one of "farms" by its key.',
        );
      const p = intoFarm
        ? null
        : s.pool
          ? pool(s.pool, `${where}.pool`)
          : refuse(
              'E-SCHEDULE',
              where,
              `${label(s)} mints but does not say into which pool or farm.`,
              'Add "pool", or "to": "farm:<key>".',
            );
      const tok = token(s.currency ?? p?.currency ?? farm?.rewardsToken, `${where}.currency`);
      if (farm && tok && farm.rewardsToken !== tok.key)
        refuse(
          'E-POOL-MINT',
          `${where}.to`,
          `${label(s)} mints ${tok.symbol} into ${label(farm)}, whose rewards are ${m.tokens.get(farm.rewardsToken)?.symbol ?? farm.rewardsToken}.`,
          'Mint the farm’s rewards token.',
        );
      if (tok && !tok.gameMints)
        refuse(
          'E-MINT-NOT-OURS',
          where,
          `${label(s)} mints ${tok.symbol}, but the project cannot mint it: only a token the project makes itself can be minted, so every run of it would fail.`,
          'Fill the pool with a share of sales or a move from another pool, or use a token with source "project".',
        );
      if (p && tok && p.currency !== tok.key)
        refuse(
          'E-POOL-MINT',
          `${where}.pool`,
          `${label(s)} mints ${tok.symbol} into “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol}.`,
          `Mint into a pool of ${tok.symbol}.`,
        );
      if (units(s.amount, tok, `${where}.amount`, `What ${label(s)} mints`) === 0n)
        refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} mints 0.`, 'Give it an amount above 0.');
      continue;
    }
    if (s.sealed) {
      // A sealed schedule pays from a vault of its own (`["vest", schedule]`), in `currency`: written once, never edited
      // or switched off, its last run pays whatever is left (schedule.rs).
      const tok = token(s.currency ?? m.currencyKey, `${where}.currency`);
      if (s.does !== 'pay')
        refuse(
          'E-SCHEDULE',
          `${where}.does`,
          `${label(s)} is sealed, so it pays from a vault of its own: it can only "pay".`,
          'Write "does": "pay", or leave "sealed" out.',
        );
      if (s.from || s.pool)
        refuse(
          'E-SCHEDULE',
          where,
          `${label(s)} is sealed: it pays from a vault of its own, not from a pool.`,
          'Remove "from" and "pool"; fund it with "fund".',
        );
      if (!(s.maxRuns > 0))
        refuse(
          'E-SCHEDULE',
          `${where}.maxRuns`,
          `${label(s)} is sealed and never ends: its last run is what pays out whatever is left (BadSchedule).`,
          'Give it "maxRuns".',
        );
      if (s.active === false)
        refuse(
          'E-SCHEDULE',
          `${where}.active`,
          `${label(s)} is sealed and switched off: it could never be switched on (BadSchedule).`,
          'Leave "active" out.',
        );
      const d = destination(s.to ?? '');
      // A payee nobody signs for (an address off the curve): a multisig's vault is one, and so is an address of this
      // program, where a record made later would make every run pass it over. The program refuses only an
      // account this program already owns (BadMove), which it checks when the schedule is written.
      if (d.kind === 'wallet' && isAddress(d.key) && !isOnCurve(addressBytes(d.key)))
        warn(
          'W-SCHEDULE-PAYEE',
          `${where}.to`,
          `${label(s)} is sealed and pays ${d.key}, an address nobody holds a key of: a program's address. A multisig's vault is fine; an address of the loot program is not: a record made there later would make every run pass it over, and the vault would never empty. Nothing can change the payee once it is sealed.`,
          'Check the address is a wallet or a multisig vault you can spend from, before you sign.',
        );
      // Its last run: far off is taken, and warned of with its date.
      if (s.maxRuns > 0) {
        let first = now + seconds(s.every, `${where}.every`);
        try {
          if (s.start) first = Math.max(now, toTime(s.start, now));
        } catch (error) {
          // A start that doesn't read is refused where the schedule's times are checked.
          if (!(error instanceof SpecError)) throw error;
        }
        const last = first + seconds(s.every, `${where}.every`) * (s.maxRuns - 1);
        if (last > Number.MAX_SAFE_INTEGER / 1000)
          refuse(
            'E-SCHEDULE',
            `${where}.maxRuns`,
            `${label(s)} is sealed and its last run would come further off than a date holds (BadSchedule).`,
            'Fewer runs, a shorter "every", or an earlier "start".',
          );
        else
          farTime(
            last,
            `${where}.maxRuns`,
            `${label(s)}’s last run`,
            s.every,
            'the vault keeps what is left, and nobody can take it out early',
          );
      }
      // A wallet, the treasury or a burn: a stream into a pool or an account would be only as safe as where it lands (the
      // authority moves a pool; an account's holder may close it).
      if (!['wallet', 'treasury', 'burn'].includes(d.kind) || !s.to)
        refuse(
          'E-SCHEDULE',
          `${where}.to`,
          `${label(s)} is sealed and pays “${s.to ?? 'nowhere'}”: a sealed schedule pays a wallet, the treasury or a burn, never a pool, a pot, a farm or an account (BadMove).`,
          'Write "to": "wallet:<address>"; for a stream into a pool, a pot or a farm, leave "sealed" out.',
        );
      if (tok?.wsol && d.kind === 'burn')
        refuse(
          'E-WSOL-BURN',
          `${where}.to`,
          `${label(s)} burns SOL, and wrapped SOL cannot be burned.`,
          'Pay it somewhere instead.',
        );
      // A vault that pays a wallet or the treasury moves its tokens by a transfer: a token that can't be transferred
      // would sit in it for good. The program takes it (only a burn of a token whose burn needs its issuer is refused).
      if (tok?.powers?.nonTransferable && d.kind !== 'burn')
        refuse(
          'E-SCHEDULE',
          `${where}.currency`,
          `${label(s)} is sealed in ${tok.symbol}, which cannot be transferred: no run could ever pay ${d.kind === 'treasury' ? 'the treasury' : 'the wallet'}, and the vault, which nobody can open, would keep it all for good.`,
          'Seal it in another token.',
        );
      // A vest is only as safe as its token.
      const p = tok?.powers ?? {};
      const powers = [
        p.permanentDelegate && 'a permanent delegate can take the tokens out of the vault',
        p.feeChangeable && 'its issuer can raise the transfer fee to 100% and take each run as it leaves',
        p.closeAuthority && 'its mint can be closed and made again with other powers',
        (p.freeze || p.defaultFrozen || (p.defaultState && p.freeze)) &&
          'a freeze can hold the vault or the payee’s account',
        p.pausable && 'a pause can hold every run',
        p.transferHook && 'its transfer hook can refuse a run',
        p.confidentialTransfers && 'a payee can turn plain transfers away',
      ].filter(Boolean);
      if (powers.length)
        warn(
          'W-SCHEDULE',
          `${where}.currency`,
          `${label(s)} is sealed in ${tok.symbol}: a vest is only as safe as its token, and ${powers.join('; ')}.`,
          'Seal it in a token without those powers, or tell whoever it pays.',
        );
      if (byShare && !(percent(s.percent, `${where}.percent`) > 0))
        refuse('E-SCHEDULE', `${where}.percent`, `${label(s)} pays 0%.`, 'Give it a percent above 0.');
      else if (!byShare && units(s.amount, tok, `${where}.amount`, `What ${label(s)} pays`) === 0n)
        refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} pays nothing.`, 'Give it an amount or a percent above 0.');
      if (s.fund !== undefined) units(s.fund, tok, `${where}.fund`, `${label(s)}’s fund`);
      if (s.fundFrom === 'mint' && tok && !tok.gameMints)
        refuse(
          'E-MINT-NOT-OURS',
          `${where}.fundFrom`,
          `${label(s)} is funded by minting ${tok.symbol}, which the project cannot mint.`,
          "Fund it from the owner's wallet or a pool.",
        );
      if (s.fundFrom?.startsWith('pool:')) pool(s.fundFrom.slice(5), `${where}.fundFrom`);
      warn(
        'W-SCHEDULE',
        where,
        `${label(s)} is sealed: once written it never closes, and nobody can edit or stop it. Check its terms before it goes live.`,
      );
      if (!Number(s.fund ?? 0))
        warn(
          'W-SCHEDULE',
          `${where}.fund`,
          `${label(s)} starts empty: its runs pay nothing until someone sends tokens to its vault.`,
          'Give it "fund".',
        );
      if (d.kind === 'treasury')
        warn(
          'W-SCHEDULE',
          `${where}.to`,
          `${label(s)} pays the treasury: the owner can change which wallet that is, so it is the owner's promise to themselves.`,
        );
      continue;
    }
    const sourceKey = s.does === 'burn' ? s.pool : s.from;
    const source = sourceKey
      ? pool(sourceKey, `${where}.${s.does === 'burn' ? 'pool' : 'from'}`)
      : refuse(
          'E-SCHEDULE',
          where,
          `${label(s)} ${s.does === 'burn' ? 'burns' : 'moves'} money but does not say from which pool.`,
          `Add "${s.does === 'burn' ? 'pool' : 'from'}".`,
        );
    const srcToken = source && m.tokens.get(source.currency);
    if (byShare) {
      if (!(percent(s.percent, `${where}.percent`) > 0))
        refuse(
          'E-SCHEDULE',
          `${where}.percent`,
          `${label(s)} ${s.does === 'burn' ? 'burns' : 'moves'} 0%.`,
          'Give it a percent above 0.',
        );
    } else if (units(s.amount, srcToken, `${where}.amount`, `What ${label(s)} moves`) === 0n)
      refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} moves nothing.`, 'Give it an amount or a percent above 0.');
    if (s.does === 'burn' && srcToken?.wsol)
      refuse(
        'E-WSOL-BURN',
        `${where}.pool`,
        `${label(s)} burns SOL from “${source.key}”, and wrapped SOL cannot be burned.`,
        'Move it to another pool instead.',
      );
    if (s.does === 'move') {
      const to = s.to
        ? pool(s.to, `${where}.to`)
        : refuse('E-SCHEDULE', where, `${label(s)} moves money but does not say to which pool.`, 'Add "to".');
      if (source && to && source.key === to.key)
        refuse(
          'E-SCHEDULE',
          where,
          `${label(s)} moves money from “${source.key}” into itself.`,
          'Name two different pools.',
        );
      if (source && to && source.currency !== to.currency)
        refuse(
          'E-POOL-MINT',
          where,
          `${label(s)} moves from “${source.key}” to “${to.key}”, which hold different tokens.`,
          'Name two pools of the same token.',
        );
    }
    if (s.does === 'pay') {
      const d = destination(s.to ?? '');
      if (d.kind === 'lottery') {
        const l = m.lottery.get(d.key);
        if (!l)
          refuse('E-REF', `${where}.to`, `There is no lottery “${d.key}”.`, 'Name one of "lotteries" by its key.');
        else if (!keepsPot(l))
          refuse(
            'E-LOTTERY',
            `${where}.to`,
            `${label(s)} pays ${label(l)}, which pays each round from that round's own ticket money ("rest"): it keeps no pot to pay into.`,
            `Give ${label(l)} a pot ("pot": 0), or pay elsewhere.`,
          );
      } else if (d.kind === 'farm') {
        const f = m.farm.get(d.key);
        if (!f) refuse('E-REF', `${where}.to`, `There is no farm “${d.key}”.`, 'Name one of "farms" by its key.');
        else if (srcToken && f.rewardsToken !== srcToken.key)
          refuse(
            'E-POOL-MINT',
            `${where}.to`,
            `${label(s)} pays ${srcToken.symbol} into ${label(f)}, whose rewards are ${m.tokens.get(f.rewardsToken)?.symbol ?? f.rewardsToken}.`,
            'Pay it from a pool of the farm’s rewards token.',
          );
      } else if (!['account', 'holder', 'wallet'].includes(d.kind) || !isAddress(d.key))
        refuse(
          'E-SCHEDULE',
          `${where}.to`,
          `${label(s)} pays “${s.to ?? 'nowhere'}”: a pay schedule pays a wallet, a token account, a collectible’s holder, a lottery’s pot or a farm’s rewards.`,
          'Write "to": "wallet:<address>", "account:<token account address>", "holder:<asset address>", "lottery:<key>" or "farm:<key>".',
        );
      else if (d.kind === 'account' && gameVault(d.key, m.poolToken(sourceKey)))
        refuse(
          'E-SCHEDULE',
          `${where}.to`,
          `${label(s)} pays the game’s own vault, where open orders, prizes set aside and bids wait: the program refuses it.`,
          'Pay a pool or a wallet instead.',
        );
      warn(
        'W-SCHEDULE-PAY',
        where,
        `${label(s)} pays out of “${sourceKey}” on a timer, but the pool stays the game’s: the authority can still spend it, and the owner can rewrite or stop the schedule. It is a promise the project keeps, not a vesting contract the recipient holds.`,
        'Make it "sealed" (with "fund" and "maxRuns") for a vesting nobody can take back.',
      );
    }
  }
}
