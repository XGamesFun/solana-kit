// The client's policy helpers: which receipts are safe to read, which orders can be refunded, and how an auction's end
// and an untoppable bid are shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, uintLE } from '../chain/bytes.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { LOOT_PROGRAM, readReceiptAccount, orderRefundSlot, STALE_SLOTS, auctionEnds, leastBid } from '../client/index.js';

test('receipt classification agrees with safe onchain initialization and rejects foreign/malformed accounts', () => {
  assert.equal(readReceiptAccount(null), null);
  assert.equal(readReceiptAccount({ owner: SYSTEM_PROGRAM, data: new Uint8Array(), lamports: 1_000_000n }), null);
  const data = concat(Uint8Array.of(15), uintLE(7, 4), uintLE(1, 4), uintLE(3, 4), uintLE(0, 4));
  assert.equal(readReceiptAccount({ owner: LOOT_PROGRAM, data }).count, 7);
  for (const account of [
    { owner: SYSTEM_PROGRAM, data }, { owner: 'foreign', data },
    { owner: LOOT_PROGRAM, data: new Uint8Array() },
    { owner: LOOT_PROGRAM, data, executable: true },
    { owner: SYSTEM_PROGRAM, data: new Uint8Array(), executable: true },
  ]) assert.throws(() => readReceiptAccount(account));
});

test('refund discovery: a failed or stale roll, and never a rolled order', () => {
  const base = { project: 'project', requested_slot: 100n, outcome: 'Nothing' };
  assert.equal(orderRefundSlot({ ...base, status: 'Failed' }), 101n);
  assert.equal(orderRefundSlot({ ...base, status: 'Pending' }), 101n + STALE_SLOTS);
  for (const outcome of ['Nothing', 'Burn', { Pay: { pool: 0, amount: 1n } }, { Item: [3] }]) {
    assert.equal(orderRefundSlot({ ...base, status: 'Rolled', outcome }), null, 'settled, never refunded');
  }
  const max = (1n << 64n) - 1n;
  assert.equal(orderRefundSlot({ ...base, status: 'Pending', requested_slot: max - 1n }), max + 1n);
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
