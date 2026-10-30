// Lifecycle rules shared by browsers and optional keepers, read from the decoded accounts. The program still checks
// every transition; these say when one is worth sending.
import IDL from './idl/loot.js';

const constant = name => BigInt(IDL.constants.find(value => value.name === name).value);
export const STALE_SLOTS = constant('STALE_SLOTS');
export const LOTTERY_TIMEOUT_SLOTS = constant('LOTTERY_TIMEOUT_SLOTS');
const U64_MAX = (1n << 64n) - 1n;

/**
 * The earliest slot an order can be refunded in, or null when it never can be: a rolled order has an outcome anyone
 * can carry out, and is settled, never refunded; a roll a mission or a recipe made waits for anyone to ask for it
 * (`Waiting`), and once asked (`Asked`) is asked again if the oracle never answers (`rollAskable`).
 */
export function orderRefundSlot(order) {
  let wait;
  if (order.status === 'Failed') wait = 0n;
  else if (order.status === 'Pending') wait = STALE_SLOTS;
  else if (['Rolled', 'Waiting', 'Asked'].includes(order.status)) return null;
  else throw new Error('Unknown order status.');
  const deadline = BigInt(order.requested_slot) + wait;
  // The program requires strictly greater than the saturating deadline; MAX + 1 is unreachable.
  return (deadline > U64_MAX ? U64_MAX : deadline) + 1n;
}

/** Whether anyone may ask the oracle for a mission's or a recipe's roll at `slot`: never asked, or never answered. */
export const rollAskable = (order, slot) => order.status === 'Waiting' || (order.status === 'Asked' && BigInt(slot) > BigInt(order.requested_slot) + STALE_SLOTS);

/**
 * Whether a contest is off at `now` (Unix seconds), as the program reads its verdict: called off, its result
 * overdue, or short of its least pot once entries closed. Every entry of one that is off takes its money back.
 */
export function contestOff(contest, now) {
  if (contest.verdict === 'Off') return true;
  if (contest.verdict !== 'Open') return false;
  const total = contest.sides.reduce((sum, side) => sum + BigInt(side), 0n);
  return BigInt(now) > BigInt(contest.result_by) || (BigInt(now) >= BigInt(contest.closes_at) && total < BigInt(contest.min_pot ?? 0));
}

/** Whether a lottery's draw was asked for and the oracle has not answered within `STALE_SLOTS`: anyone may ask again. */
export const lotteryDrawStuck = (lottery, slot) => lottery.status === 'Drawing' && BigInt(slot) > BigInt(lottery.asked_slot) + STALE_SLOTS;

/**
 * Whether a lottery's draw was asked for and the oracle has not answered within `LOTTERY_TIMEOUT_SLOTS` of the first
 * ask (asking again doesn't move it): anyone may cancel the round and refund it. A round nobody asked to draw is never
 * cancelled.
 */
export const lotteryCancellable = (lottery, slot) => lottery.status === 'Drawing' && BigInt(slot) > BigInt(lottery.asked_first) + LOTTERY_TIMEOUT_SLOTS;
