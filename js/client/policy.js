// Lifecycle rules shared by browsers and optional keepers, read from the decoded accounts. The program still checks
// every transition; these say when one is worth sending.
import IDL from './idl/loot.js';

const constant = name => BigInt(IDL.constants.find(value => value.name === name).value);
/** How long the oracle has to answer before a roll or a draw may be asked again, and a pending order refunded (seconds). */
export const STALE_SECONDS = constant('STALE_SECONDS');
/** How long after a lottery's first ask the next ask cancels its round, and an asked order holding a payment or an NFT
 * may be refunded (seconds). */
export const LOTTERY_TIMEOUT_SECONDS = constant('LOTTERY_TIMEOUT_SECONDS');

/**
 * The earliest an order can be refunded, as `{ slot, at }` (the program wants a later slot than `slot` and a later
 * second than `at`), or null when it never can be as it stands: a failed order from the next slot; a paid order the
 * oracle never answered 10 minutes after it was asked (`STALE_SECONDS`); an asked roll holding a payment or an NFT 7 days
 * after its first ask. A rolled order has an outcome to carry out, and is settled. A waiting roll, or an asked one holding
 * nothing, is asked (again): `rollAskable`.
 */
export function orderRefundAt(order) {
  const slot = BigInt(order.requested_slot);
  if (order.status === 'Failed') return { slot, at: null };
  if (order.status === 'Pending') return { slot, at: BigInt(order.asked_at) + STALE_SECONDS };
  if (order.status === 'Asked' && (BigInt(order.paid ?? 0) > 0n || order.held))
    return { slot: null, at: BigInt(order.first_asked_at) + LOTTERY_TIMEOUT_SECONDS };
  if (['Rolled', 'Waiting', 'Asked'].includes(order.status)) return null;
  throw new Error('Unknown order status.');
}

/** Whether an order can be refunded at `slot` and `now` (Unix seconds, the chain's clock): `orderRefundAt`. */
export function orderRefundable(order, slot, now) {
  const due = orderRefundAt(order);
  if (!due) return false;
  return (due.slot === null || BigInt(slot) > due.slot) && (due.at === null || BigInt(now) > due.at);
}

/**
 * Whether its player or the project's keys may ask the oracle for a mission's or a recipe's roll at `slot` and `now`
 * (Unix seconds, the chain's clock): never asked, or never answered within `STALE_SECONDS`. Once asked, a later ask comes
 * in a later slot than the last (`SameSlot`: never the same seed twice), so a roll that found nothing in stock and waits
 * again is asked from the next slot on.
 */
export const rollAskable = (order, slot, now) =>
  (order.status === 'Waiting' &&
    (BigInt(order.asked_first ?? 0) === 0n || BigInt(slot) > BigInt(order.requested_slot))) ||
  (order.status === 'Asked' && BigInt(now) > BigInt(order.asked_at) + STALE_SECONDS);

/**
 * Whether a contest is off at `now` (Unix seconds), as the program reads its verdict: called off, its result
 * overdue, or short of its least pot once entries closed. Every entry of one that is off takes its money back.
 */
export function contestOff(contest, now) {
  if (contest.verdict === 'Off') return true;
  if (contest.verdict !== 'Open') return false;
  const total = contest.sides.reduce((sum, side) => sum + BigInt(side), 0n);
  return (
    BigInt(now) > BigInt(contest.result_by) ||
    (BigInt(now) >= BigInt(contest.closes_at) && total < BigInt(contest.min_pot ?? 0))
  );
}

/** Whether a lottery round's draw (`round`: its decoded record) was asked for and the oracle has not answered within
 * `STALE_SECONDS` by `now` (Unix seconds, the chain's clock): anyone may ask again. */
export const lotteryDrawStuck = (round, now) =>
  round?.status === 'Drawing' && BigInt(now) > BigInt(round.asked_at) + STALE_SECONDS;

/**
 * Whether a lottery round's draw (`round`: its decoded record) was asked for and the oracle has not answered within
 * `LOTTERY_TIMEOUT_SECONDS` of the first ask (asking again doesn't move it) by `now` (Unix seconds, the chain's clock):
 * the next ask of that round (`drawLotteryIx` with its address) cancels it, and every entry is refunded. A round nobody
 * asked to draw is never cancelled.
 */
export const lotteryCancellable = (round, now) =>
  round?.status === 'Drawing' && BigInt(now) > BigInt(round.first_asked_at) + LOTTERY_TIMEOUT_SECONDS;

/** A farm seat's `earns_until` when nothing ends its earning (i64::MAX): no tier term and no fuel it reads. */
export const NO_END = (1n << 63n) - 1n;
