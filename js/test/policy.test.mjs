// The client's policy helpers: which receipts are safe to read, which orders can be refunded, and how an auction's end
// and an untoppable bid are shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, uintLE } from '../chain/bytes.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import {
  LOOT_PROGRAM,
  readListAccount,
  orderRefundAt,
  orderRefundable,
  rollAskable,
  lotteryDrawStuck,
  lotteryCancellable,
  STALE_SECONDS,
  LOTTERY_TIMEOUT_SECONDS,
  auctionEnds,
  leastBid,
} from '../client/index.js';

test('a list account agrees with the program opening a prefunded address, and foreign or malformed ones are refused', () => {
  assert.equal(readListAccount(null), null);
  assert.equal(readListAccount({ owner: SYSTEM_PROGRAM, data: new Uint8Array(), lamports: 1_000_000n }), null);
  const data = concat(Uint8Array.of(26), uintLE(16, 2), uintLE(1, 4), new Uint8Array(16).fill(7));
  assert.equal(readListAccount({ owner: LOOT_PROGRAM, data }).records.length, 1);
  for (const account of [
    { owner: SYSTEM_PROGRAM, data },
    { owner: 'foreign', data },
    { owner: LOOT_PROGRAM, data: new Uint8Array() },
    { owner: LOOT_PROGRAM, data, executable: true },
    { owner: SYSTEM_PROGRAM, data: new Uint8Array(), executable: true },
  ])
    assert.throws(() => readListAccount(account));
});

test('refund discovery: a failed roll from the next slot, a stale one by the clock, and never a rolled order', () => {
  const base = {
    project: 'project',
    requested_slot: 100n,
    asked_at: 5_000n,
    first_asked_at: 4_000n,
    paid: 0n,
    held: false,
  };
  assert.deepEqual([STALE_SECONDS, LOTTERY_TIMEOUT_SECONDS], [600n, 604_800n]);
  const failed = { ...base, status: 'Failed' };
  assert.deepEqual(orderRefundAt(failed), { slot: 100n, at: null });
  assert.equal(orderRefundable(failed, 100n, 0n), false, 'not in its own slot');
  assert.equal(orderRefundable(failed, 101n, 0n), true);
  const pending = { ...base, status: 'Pending' };
  assert.equal(orderRefundable(pending, 101n, 5_600n), false, 'the clock, to the second');
  assert.equal(orderRefundable(pending, 101n, 5_601n), true);
  assert.equal(orderRefundable(pending, 100n, 5_601n), false, 'and a later slot');
  for (const status of ['Rolled', 'Waiting', 'Asked'])
    assert.equal(orderRefundAt({ ...base, status }), null, `${status}: nothing to give back`);
  // An asked roll holding a payment or an NFT may leave after a week of silence, from its first ask.
  for (const holds of [{ paid: 1n }, { held: true }]) {
    const asked = { ...base, ...holds, status: 'Asked' };
    assert.equal(orderRefundable(asked, 101n, 4_000n + 604_800n), false);
    assert.equal(orderRefundable(asked, 101n, 4_001n + 604_800n), true);
  }
  assert.throws(() => orderRefundAt({ ...base, status: 'Gone' }), /Unknown order status/);
});

test('a stale roll or draw is judged by the clock, not by slots', () => {
  const asked = { status: 'Asked', requested_slot: 100n, asked_first: 90n, asked_at: 5_000n };
  assert.equal(rollAskable(asked, 1_000_000n, 5_600n), false, 'many slots later, the clock has not moved');
  assert.equal(rollAskable(asked, 101n, 5_601n), true);
  const waiting = { status: 'Waiting', requested_slot: 100n, asked_first: 90n };
  assert.equal(rollAskable(waiting, 100n, 0n), false, 'never the same seed twice');
  assert.equal(rollAskable(waiting, 101n, 0n), true);
  const round = { status: 'Drawing', asked_at: 5_000n, first_asked_at: 4_000n };
  assert.equal(lotteryDrawStuck(round, 5_600n), false);
  assert.equal(lotteryDrawStuck(round, 5_601n), true);
  assert.equal(lotteryCancellable(round, 4_000n + 604_800n), false);
  assert.equal(lotteryCancellable(round, 4_001n + 604_800n), true);
  assert.equal(lotteryCancellable({ ...round, status: 'Open' }, 1n << 40n), false);
});

test('auction client preserves the initial end and represents an untoppable bid', () => {
  const a = { ends_at: 100n, last_bid_at: 0n, extend: 4_294_967_295, high: 0n, reserve: 0n, min_raise_bps: 500 };
  assert.equal(auctionEnds(a), 100n);
  assert.equal(auctionEnds({ ...a, last_bid_at: 90n, extend: 30 }), 120n);
  // A refunded high bid does not erase the already recorded extension.
  assert.equal(auctionEnds({ ...a, last_bid_at: 90n, extend: 30, high: 0n }), 120n);
  assert.equal(leastBid(a), 1n);
  assert.equal(leastBid({ ...a, high: (1n << 64n) - 1n }), null);
  assert.equal(leastBid({ ...a, high: (1n << 64n) - 2n, min_raise_bps: 0 }), (1n << 64n) - 1n);
});
