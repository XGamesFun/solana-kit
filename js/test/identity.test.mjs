// Grant identities and list layouts: the addresses a grant's records and vouchers are scoped to, how a record is keyed
// and sharded, list decoding, and the fixed sizes the client and the program share.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import {
  ACCOUNT_BYTES,
  CONTEST_ENTRY_BYTES,
  countKey,
  decodeAny,
  decodeEntries,
  decodeList,
  entryWidth,
  limitKey,
  LIMIT_RECORD_BYTES,
  pda,
  projectBytes,
  readLimit,
  readVoucher,
  roundKey,
  roundPaid,
  shardBitsFor,
  shardOf,
  voucherBody,
  VOUCHER_BYTES,
  voucherBytes,
  walletShard,
} from '../client/index.js';

const address = n => encodeBase58(new Uint8Array(32).fill(n));
const list = (width, records) => concat(Uint8Array.of(26), uintLE(width, 2), uintLE(records.length, 4), ...records);

test('grant identities scope every record and the voucher itself', () => {
  const [grant, wallet] = [pda.grant(address(0x11), 7), address(0x33)];
  const person = new Uint8Array(32).fill(0x44);
  // A shard of an incarnation is its own address: a grant made again never reads an old one's records.
  assert.notEqual(pda.claims(grant, 7n, 0), pda.claims(grant, 8n, 0));
  assert.notEqual(pda.rounds(grant, 7n, 0), pda.claims(grant, 7n, 0));
  // A record's key is sha256(kind | subject)[..16]: a person, a wallet, a badge and a code never share one.
  const wallet16 = sha256(concat(utf8('wallet'), addressBytes(wallet))).subarray(0, 16);
  assert.deepEqual(limitKey('wallet', wallet), wallet16);
  assert.notDeepEqual(limitKey('person', person), limitKey('badge', person));
  assert.deepEqual(
    roundKey(new Uint8Array(16).fill(5), wallet),
    sha256(concat(new Uint8Array(16).fill(5), addressBytes(wallet))).subarray(0, 16),
  );
  // Its shard: the top bits of its key's first byte; a wallet's rounds are in its own limit record's shard.
  assert.equal(shardOf(wallet16, 0), 0);
  assert.equal(shardOf(wallet16, 8), wallet16[0]);
  assert.equal(shardOf(wallet16, 3), wallet16[0] >> 5);
  assert.equal(walletShard({ shard_bits: 4 }, wallet), wallet16[0] >> 4);
  assert.deepEqual(
    [shardBitsFor(10_000), shardBitsFor(100_001), shardBitsFor(1_000_000, 3), shardBitsFor(1e12)],
    [0, 1, 5, 8],
  );
  // A wallet's counts key a record by its record and incarnation.
  assert.deepEqual(countKey(grant, 3n), sha256(concat(addressBytes(grant), uintLE(3, 8))).subarray(0, 16));

  const fields = {
    grant,
    incarnation: 7n,
    wallet,
    personHash: person,
    round: new Uint8Array(16).fill(5),
    amount: 4n,
    expires: -1n,
  };
  const bytes = voucherBytes(fields);
  assert.equal(bytes.length, VOUCHER_BYTES);
  const decoded = readVoucher(voucherBody(fields));
  assert.equal(decoded.incarnation, 7n);
  assert.equal(decoded.expires, -1n);
  assert.equal(encodeBase58(decoded.grant), grant);
  assert.equal(encodeBase58(decoded.wallet), wallet);
  assert.deepEqual(decoded.personHash, person);
  assert.deepEqual(decoded.rounds, [{ id: fields.round, amount: 4n }]);
  assert.notDeepEqual(voucherBytes({ ...fields, incarnation: 8n }), bytes);
  assert.throws(() => voucherBytes({ ...fields, incarnation: undefined }));
  assert.throws(() => readVoucher(voucherBody(fields).subarray(0, 165)));
});

test('a list of records is read with every length checked; a paid round and a count are found by key', () => {
  const wallet = address(0x33);
  const round = new Uint8Array(16).fill(23);
  const rounds = list(16, [roundKey(round, wallet)]);
  assert.ok(roundPaid(decodeList(rounds), wallet, round));
  assert.ok(!roundPaid(decodeList(rounds), wallet, new Uint8Array(16)));
  const key = limitKey('wallet', wallet);
  const counts = list(LIMIT_RECORD_BYTES, [concat(key, uintLE(17, 4), uintLE(2, 4), uintLE(3, 4))]);
  assert.deepEqual(readLimit(decodeList(counts), key), { count: 17, window: 2, inWindow: 3 });
  assert.deepEqual(readLimit(decodeList(counts), new Uint8Array(16)), { count: 0, window: 0, inWindow: 0 }, 'none yet');
  assert.throws(() => decodeList(rounds.slice(0, -1)), /records/);
  assert.throws(() => decodeList(concat(rounds, Uint8Array.of(0))), /records/);
  assert.equal(decodeAny(rounds).kind, 'List');
  // A contest's entries: 43 bytes in a contest of tokens, read with the NFT's fields as nothing.
  const entry = concat(addressBytes(wallet), uintLE(1, 2), uintLE(500, 8), Uint8Array.of(1));
  assert.deepEqual(
    decodeEntries(list(CONTEST_ENTRY_BYTES.tokens, [entry])).map(e => [e.player, e.side, e.amount, e.bits, e.taken]),
    [[wallet, 1, 500n, 1, 0]],
  );
  assert.throws(() => decodeAny(Uint8Array.of(19)), /Proven/, "tag 19 is a compressed NFT's record");
});

test('fixed allocations, and the records sized to what they hold, share one size source', () => {
  // A hold names its player, who made it and who paid its NFT's account: a loan's has room for its debt.
  assert.deepEqual(ACCOUNT_BYTES, { Seat: 176, Loan: 242, Hold: 170 });
  assert.deepEqual([projectBytes(0), projectBytes(8)], [153, 409], 'a project grows with its collections');
  // A lottery entry: its buyer and word, what arrived (a fee mint, or a share the buyer chooses), its NFT ticket.
  assert.deepEqual([entryWidth(false, false), entryWidth(true, true)], [40, 40 + 8 + 32]);
});
