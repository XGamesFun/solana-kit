// Grant identities and receipt layouts: the addresses a grant's children and vouchers are scoped to, receipt decoding,
// and the fixed sizes the client and the program share.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import { ACCOUNT_BYTES, allocationBytes, projectBytes, decodeAny, decodeReceipt, MAX_RECEIPT_ROUNDS, receiptBytes, pda, readVoucher, VOUCHER_BYTES, voucherBytes } from '../client/index.js';

const address = (n) => encodeBase58(new Uint8Array(32).fill(n));

test('grant identities scope every child address and the voucher itself', () => {
  const [grant, wallet, key] = [pda.grant(address(0x11), 7), address(0x33), address(1)];
  const person = new Uint8Array(32).fill(0x44);
  const derive = (incarnation) => [
    pda.grantReceipt(grant, incarnation, wallet), pda.person(grant, incarnation, person),
    pda.code(grant, incarnation, key),
  ];
  const first = derive(7n), next = derive(8n);
  first.forEach((value, i) => assert.notEqual(value, next[i]));
  assert.equal(first[0], '7E15BmvNwV5XeRE3cLPkTcudRJmqJzPh2NKuaE4Z4Nng');
  assert.equal(first[1], 'NgAhxtAqGTrTEavWEfypmhV354SouXJeLskMaXJHM91');
  assert.equal(pda.code(grant, 7n, key), first[2]);
  assert.notEqual(pda.receipt(grant, wallet), first[0]);
  // A badge's count has a seed of its own: a voucher naming the badge's bytes as its person never reaches it.
  assert.notEqual(pda.badge(grant, 7n, address(0x44)), first[1]);
  const fields = { grant, incarnation: 7n, wallet, personHash: person, round: new Uint8Array(16).fill(5), expires: -1n };
  const bytes = voucherBytes(fields);
  assert.equal(bytes.length, VOUCHER_BYTES);
  const decoded = readVoucher(bytes);
  assert.equal(decoded.incarnation, 7n);
  assert.equal(decoded.expires, -1n);
  assert.equal(encodeBase58(decoded.grant), grant);
  assert.equal(encodeBase58(decoded.wallet), wallet);
  assert.deepEqual(decoded.personHash, person);
  assert.deepEqual(decoded.round, fields.round);
  assert.notDeepEqual(voucherBytes({ ...fields, incarnation: 8n }), bytes);
  assert.throws(() => voucherBytes({ ...fields, incarnation: undefined }));
  assert.throws(() => readVoucher(bytes.subarray(0, 165)));
  assert.throws(() => readVoucher(concat(utf8('loot-grant-v2'), bytes.subarray(13))));
});

test('receipt decoding requires the bounded current layout and preserves arbitrary round lookup', () => {
  const round = new Uint8Array(16).fill(23);
  const digest = sha256(round).slice(0, 8);
  const header = (n) => concat(Uint8Array.of(15), uintLE(17, 4), uintLE(2, 4), uintLE(3, 4), uintLE(n, 4));
  const bytes = concat(header(1), digest);
  const receipt = decodeReceipt(bytes);
  assert.deepEqual([receipt.count, receipt.window, receipt.inWindow], [17, 2, 3]);
  assert.equal(receipt.rounds.length, 1);
  assert.ok(receipt.claimed(round));
  assert.ok(!receipt.claimed(new Uint8Array(16)));
  assert.equal(MAX_RECEIPT_ROUNDS, 256);
  assert.throws(() => decodeReceipt(bytes.slice(0, 13)), /Receipt/);
  assert.throws(() => decodeReceipt(bytes.slice(0, -1)), /length/);
  assert.throws(() => decodeReceipt(concat(bytes, Uint8Array.of(0))), /length/);
  assert.throws(() => decodeReceipt(header(MAX_RECEIPT_ROUNDS + 1)), /capacity/);
  assert.throws(() => decodeReceipt(concat(header(2), digest, digest)), /unique and sorted/);
  assert.throws(() => decodeReceipt(concat(header(2), new Uint8Array(8).fill(2), new Uint8Array(8).fill(1))), /unique and sorted/);
  assert.throws(() => decodeAny(Uint8Array.of(19)), /Proven/, 'tag 19 is a compressed NFT\'s record now');
});

test('fixed allocation maxima and receipt capacity share one size source', () => {
  assert.deepEqual(ACCOUNT_BYTES, { Order: 621, Seat: 232, Hold: 179, Entry: 106, LotteryContribution: 254 });
  assert.deepEqual([projectBytes(0), projectBytes(8)], [153, 409], 'a project grows with its collections');
  assert.equal(allocationBytes('Project'), projectBytes(8), 'at most eight collections');
  assert.equal(receiptBytes(), 17);
  assert.equal(receiptBytes(1), 25);
  assert.equal(receiptBytes(MAX_RECEIPT_ROUNDS), 2065);
  assert.throws(() => receiptBytes(MAX_RECEIPT_ROUNDS + 1), /at most/);
});
