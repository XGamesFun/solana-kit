// Schedules, for the page client (solanaApp): running a schedule that is due.
import { encodeBase58 } from '../chain/base58.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { NO_OPTIONS, only } from './common.js';

/** Returns the schedule method. */
export function addSchedules(ctx) {
  const { wallet, programs, client, project, part, read, projectNow, send, chainNow, holdersOf } = ctx;

  return {
    /**
     * Runs a schedule that is due (an emission into a pool, a rent or a drip): the project's owner or authority, or who it
     * pays, may (a sealed burn: anyone), and nothing is paid to whoever sends it but the network fee. A run missed is missed:
     * this pays once, for the latest run due, and the runs before it lapse; only a sealed fixed amount pays every run due. `holders`: asset → holder, for a schedule that pays a collectible's holder.
     * Returns null when it isn't due yet.
     */
    async runSchedule(scheduleKey, { holders, most, ...others } = NO_OPTIONS) {
      only(others, ['holders', 'most'], 'runSchedule');
      const sc = part('schedules', scheduleKey);
      const address = loot.pda.schedule(project, sc.id);
      const schedule = await read('Schedule', address);
      const from = schedule.action.from;
      // A sealed schedule's vault: past its last run, whatever arrived since is due once more.
      const vault = from.Vest ? await client.account(loot.pda.vest(address)) : null;
      const held = vault ? vault.data.subarray(64, 72).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n;
      // Every run due by the chain's clock (`most`: at most that many of a sealed fixed amount's, the only one paid run by
      // run; a long backlog of those takes a few calls).
      const due = Math.min(loot.runsDue(schedule, await chainNow(), held), most ?? Infinity);
      if (!due) return null;
      const poolMint = from.Pool
        ? encodeBase58((await client.account(loot.pda.pool(project, from.Pool[0]))).data.subarray(0, 32))
        : null;
      holders ??= await holdersOf([{ to: schedule.action.to }]);
      const treasury = (await projectNow()).treasury;
      // A sealed fixed amount's backlog is a step for each halving: room for the longest the program takes a call.
      return send([
        computeUnitLimit(1_400_000),
        loot.runScheduleIx({
          payer: wallet.address,
          project,
          id: sc.id,
          schedule,
          poolMint,
          holders,
          programs,
          treasury,
          upto: Number(schedule.runs) + due,
        }),
      ]);
    },
  };
}
