// The encoders and decoders refuse what they cannot write or read faithfully: a token account is not a mint, a byte
// array holds bytes, a signed or unsigned integer that does not fit (or a number past 2^53) is refused rather than
// wrapped, and data cut short says so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBase58 } from '../chain/base58.js';
import { encodeBorsh } from '../chain/borsh.js';
import { intLE, readCompactU16, toBigInt } from '../chain/bytes.js';
import { tableAddress } from '../chain/lookup.js';
import { parseMint } from '../chain/mint.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { withSolWrap } from '../chain/programs.js';
import { compileMessage, readMessage } from '../chain/tx.js';
import * as loot from '../client/index.js';

const address = (n) => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : i + 1)));
const A = address(1);
const B = address(2);
const C = address(3);
const IDL = loot.IDL;

test('parseMint takes a mint and refuses a Token-2022 token account', () => {
  // A Token-2022 associated token account: 165 bytes, its account type (2) and ImmutableOwner. Byte 45 is in its owner.
  const account = new Uint8Array(170);
  account.fill(7, 0, 32);
  account.fill(9, 32, 64);
  account[45] = 1;
  account[108] = 1;
  account[165] = 2;
  account[166] = 7;
  assert.equal(parseMint(A, TOKEN_2022_PROGRAM, account), null);
  // A Token-2022 mint with an extension says it is a mint at byte 165.
  const mint = new Uint8Array(170);
  mint[44] = 6;
  mint[45] = 1;
  mint[165] = 1;
  assert.equal(parseMint(A, TOKEN_2022_PROGRAM, mint)?.decimals, 6);
  // 82 bytes is a mint for either program; anything between 82 and 166 bytes is not.
  const classic = new Uint8Array(82);
  classic[45] = 1;
  assert.equal(parseMint(A, TOKEN_PROGRAM, classic)?.program, 'spl-token');
  assert.equal(parseMint(A, TOKEN_2022_PROGRAM, classic)?.program, 'token-2022');
  assert.equal(parseMint(A, TOKEN_2022_PROGRAM, new Uint8Array(165).fill(1)), null);
  assert.equal(parseMint(A, TOKEN_PROGRAM, mint), null);
});

test('a [u8; N] takes bytes only', () => {
  const type = { array: ['u8', 4] };
  assert.deepEqual(encodeBorsh(IDL, type, [0, 1, 254, 255]), Uint8Array.of(0, 1, 254, 255));
  assert.deepEqual(encodeBorsh(IDL, type, Uint8Array.of(1, 2, 3, 4)), Uint8Array.of(1, 2, 3, 4));
  for (const bad of [[256, 0, 0, 0], [-1, 0, 0, 0], [1.5, 0, 0, 0], ['x', 0, 0, 0], 'abcd', null])
    assert.throws(() => encodeBorsh(IDL, type, bad), /Expected 4 bytes/, String(bad));
  assert.throws(() => encodeBorsh(IDL, type, [1, 2, 3]), /Expected 4 bytes, got 3/);
  // A 32-character string is not 32 bytes.
  assert.throws(() => loot.setTraitsIx({ signer: A, project: B, key: C, root: 'f'.repeat(32) }), /Expected 32 bytes/);
});

test('signed integers that do not fit are refused, not wrapped', () => {
  assert.deepEqual(intLE(-1n, 8), new Uint8Array(8).fill(255));
  assert.deepEqual(intLE(-(2n ** 63n), 8), Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 128));
  assert.throws(() => intLE(2n ** 63n, 8), RangeError);
  assert.throws(() => intLE(-(2n ** 63n) - 1n, 8), RangeError);
  assert.throws(() => loot.verdictBytes({ contest: A, incarnation: 0n, side: 0, expires: 2n ** 63n }), RangeError);
  assert.deepEqual(loot.verdictBytes({ contest: A, incarnation: 0n, side: 0, expires: -1n }).slice(-8), new Uint8Array(8).fill(255));
  assert.throws(() => loot.pda.hold(A, -(2n ** 64n)), RangeError);
  assert.throws(() => loot.pda.hold(A, 2n ** 63n), RangeError);
  assert.equal(loot.pda.hold(A, -1n), loot.pda.hold(A, -1));
  assert.throws(() => loot.i64LE(2n ** 63n), RangeError);
});

test('a number past 2^53 is refused before it becomes a bigint', () => {
  const unsafe = 2 ** 53 + 2;
  assert.equal(toBigInt('12345678901234567890'), 12345678901234567890n);
  assert.equal(toBigInt(7), 7n);
  assert.throws(() => toBigInt(unsafe), /not a safe integer/);
  assert.throws(() => withSolWrap(A, NATIVE_MINT, unsafe, []), /not a safe integer/);
  assert.equal(withSolWrap(A, NATIVE_MINT, 5, []).length, 4);
  assert.throws(() => tableAddress(A, unsafe), /not a safe integer/);
  assert.throws(() => loot.prizeRollNonce(unsafe), /not a safe integer/);
  assert.throws(() => loot.holdIx({ player: A, project: B, collection: C, asset: address(4), freeAt: unsafe }), /not a safe integer/);
});

test('readMessage and readCompactU16 refuse data cut short or out of range', () => {
  const message = compileMessage({ payer: A, blockhash: B, instructions: [{ programId: C, keys: [], data: new Uint8Array(10) }] });
  assert.equal(readMessage(message).instructions[0].data.length, 10);
  for (let cut = 1; cut <= message.length; cut++) assert.throws(() => readMessage(message.slice(0, message.length - cut)), /Truncated message|truncated length prefix/);
  assert.throws(() => readMessage(new Uint8Array(0)), /Truncated message/);
  assert.deepEqual(readCompactU16(Uint8Array.of(0xff, 0xff, 0x03), 0), { value: 0xffff, size: 3 });
  assert.throws(() => readCompactU16(Uint8Array.of(0xff, 0xff, 0x7f), 0), /past 0xffff/);
  assert.throws(() => readCompactU16(Uint8Array.of(0x80, 0x00), 0), /longer than it needs/);
  assert.throws(() => readCompactU16(Uint8Array.of(0x80, 0x80, 0x80), 0), /too long/);
});

test('decodeProven refuses an account too short for its asset data hash', () => {
  const shortest = 1 + 32 * 8 + 1 + 1 + 8 + 32;
  const data = new Uint8Array(shortest);
  data[0] = loot.TAGS.Proven;
  assert.equal(loot.decodeProven(data).payer, encodeBase58(new Uint8Array(32)));
  data[257] = 1;
  assert.throws(() => loot.decodeProven(data), /truncated/);
  const long = new Uint8Array(shortest + 32);
  long.set(data);
  long.fill(5, long.length - 32);
  assert.equal(loot.decodeProven(long).payer, encodeBase58(new Uint8Array(32).fill(5)));
  data[257] = 2;
  assert.throws(() => loot.decodeProven(data), /asset data hash/);
});

test('constants come from the IDL, and missing arguments are named', () => {
  const constant = (name) => BigInt(IDL.constants.find((c) => c.name === name).value);
  assert.equal(loot.ESCROW_LAMPORTS, constant('ESCROW_LAMPORTS'));
  assert.equal(loot.dayOf(constant('DAY_SECONDS') * 3n + 1n), 3);
  assert.throws(() => loot.withDefaults({ Box: { id: 1, args: { currency: A } } }), /entries/);
  assert.throws(() => loot.openFarmIx({ owner: A, project: B, id: 0, args: { rewards_pool: 0 }, rewardsMint: C }), /args\.tiers/);
});
