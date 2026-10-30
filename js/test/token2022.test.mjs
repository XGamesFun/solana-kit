// Resolver vectors use the transfer-hook wire format, independently of the loot account decoders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, uintLE } from '../chain/bytes.js';
import { pdaOf, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../chain/pda.js';
import { associatedAccountSize, EXECUTE_DISCRIMINATOR, MEMO_PROGRAM, readExtraMetas, resolveTransfers, validationAddress } from '../chain/token2022.js';

const address = (byte) => encodeBase58(new Uint8Array(32).fill(byte));
const mint = address(1), hook = address(2), source = address(3), authority = address(4);
const mintAccount = (extensions = []) => {
  const base = new Uint8Array(166); base[45] = 1; base[165] = 1;
  return { owner: TOKEN_2022_PROGRAM, data: concat(base, ...extensions.map(([kind, data]) => concat(uintLE(kind, 2), uintLE(data.length, 2), data))) };
};
const hookMint = () => mintAccount([[14, concat(new Uint8Array(32), addressBytes(hook))]]);
const entry = (discriminator, config, { signer = false, writable = false } = {}) => {
  const seeds = new Uint8Array(32); seeds.set(config);
  return concat(Uint8Array.of(discriminator), seeds, Uint8Array.of(Number(signer), Number(writable)));
};
const listData = (entries) => concat(EXECUTE_DISCRIMINATOR, uintLE(4 + 35 * entries.length, 4), uintLE(entries.length, 4), ...entries);
function rpcWith(account, list = null) {
  const reads = [];
  const accounts = new Map([[mint, account], [validationAddress(mint, hook), list]]);
  return { reads, accounts: async (keys) => { reads.push(...keys); return keys.map((key) => accounts.get(key) ?? null); } };
}

test('ATA rent sizes follow mint extensions and include the Token-2022 immutable owner', () => {
  assert.equal(associatedAccountSize({ owner: TOKEN_PROGRAM, data: new Uint8Array(82) }), 165);
  assert.equal(associatedAccountSize({ owner: TOKEN_2022_PROGRAM, data: new Uint8Array(82) }), 170);
  assert.equal(associatedAccountSize(mintAccount()), 170);
  assert.equal(associatedAccountSize(mintAccount([[1, new Uint8Array(108)]])), 182);
  assert.equal(associatedAccountSize(hookMint()), 175);
  assert.equal(associatedAccountSize(mintAccount([[9, new Uint8Array()]])), 174);
  assert.equal(associatedAccountSize(mintAccount([[26, new Uint8Array(33)]])), 174);
  assert.equal(associatedAccountSize(mintAccount([[1, new Uint8Array(108)], [14, new Uint8Array(64)], [9, new Uint8Array()], [26, new Uint8Array(33)]])), 195);
  assert.equal(associatedAccountSize(mintAccount([[12, new Uint8Array(32)]])), 170, 'mint-only extensions add no account state');
});

test('the shared resolver reads a mint once and returns its program, rent size and memo requirement', async () => {
  for (const [account, size, extra] of [[{ owner: TOKEN_PROGRAM, data: new Uint8Array(82) }, 165, []], [mintAccount([[1, new Uint8Array(108)]]), 182, [MEMO_PROGRAM]]]) {
    const rpc = rpcWith(account), result = await resolveTransfers(rpc, mint);
    assert.equal(result.tokenProgram, account.owner);
    assert.equal(result.accountSize, size);
    assert.deepEqual(result.extraAccounts.map((m) => m.pubkey), extra);
    assert.deepEqual(rpc.reads, [mint]);
  }
});

test('hook PDAs use each destination and the exact transfer amount, with writable deduplication', async () => {
  const fixed = address(8), destination = address(5), second = address(6);
  const entries = [entry(0, addressBytes(fixed)), entry(0, addressBytes(fixed), { writable: true }), entry(1, Uint8Array.of(3, 2, 2, 8, 8), { writable: true })];
  const rpc = rpcWith(hookMint(), { owner: hook, data: listData(entries) });
  const transfers = [{ destination, amount: 7n }, { destination: second, amount: 7n }, { destination, amount: 8n }, { destination, amount: 7n }].map((t) => ({ source, authority, ...t }));
  const result = await resolveTransfers(rpc, mint, transfers);
  const expected = [MEMO_PROGRAM, hook, validationAddress(mint, hook), fixed, ...transfers.slice(0, 3).map((t) => pdaOf([addressBytes(t.destination), uintLE(t.amount, 8)], hook))];
  assert.equal(result.accountSize, 175);
  assert.deepEqual(result.extraAccounts.map((m) => m.pubkey), expected);
  assert.ok(result.extraAccounts.slice(3).every((m) => m.isWritable && !m.isSigner));
  assert.equal(rpc.reads.filter((key) => key === mint).length, 1);
  await assert.rejects(resolveTransfers(rpc, mint), /each transfer/);
});

test('the resolver refuses unknown mint owners, malformed extension data, untrusted lists and extra signatures', async () => {
  assert.throws(() => associatedAccountSize({ owner: hook, data: new Uint8Array(82) }), /supported token program/);
  const invalid = mintAccount(); invalid.data[165] = 2;
  assert.throws(() => associatedAccountSize(invalid), /mint layout/);
  const truncated = mintAccount([[14, new Uint8Array(64)]]); truncated.data = truncated.data.subarray(0, truncated.data.length - 1);
  assert.throws(() => associatedAccountSize(truncated), /truncated/);
  assert.throws(() => associatedAccountSize(mintAccount([[28, new Uint8Array()]])), /Unsupported/);
  await assert.rejects(resolveTransfers(rpcWith(hookMint()), mint), /list is missing/);
  await assert.rejects(resolveTransfers(rpcWith(hookMint(), { owner: authority, data: listData([]) }), mint), /wrong owner/);
  await assert.rejects(resolveTransfers(rpcWith(hookMint(), { owner: hook, data: listData([entry(0, addressBytes(source), { signer: true })]) }), mint), /additional signature/);
  assert.throws(() => readExtraMetas(concat(EXECUTE_DISCRIMINATOR, uintLE(4, 4), uintLE(1, 4), entry(0, addressBytes(source)))), /past its entry/);
  assert.throws(() => readExtraMetas(listData([entry(0, addressBytes(source))]).subarray(0, 20)), /past the data/);
});

test('hook seeds cannot read beyond their packed config, transfer instruction or account data', async () => {
  const transfer = { source, authority, destination: address(5), amount: 7n };
  const resolve = (config) => {
    const base = rpcWith(hookMint(), { owner: hook, data: listData([entry(1, config)]) });
    const rpc = { accounts: async (keys) => keys.length === 1 && keys[0] === source ? [{ owner: TOKEN_PROGRAM, data: new Uint8Array(8) }] : base.accounts(keys) };
    return resolveTransfers(rpc, mint, [transfer]);
  };
  await assert.rejects(resolve(Uint8Array.of(1, 31)), /literal seed runs past/);
  for (const [kind, message] of [[1, /literal seed/], [2, /instruction seed/], [3, /account key seed/], [4, /account data seed/]]) {
    const config = new Uint8Array(32); config[0] = 1; config[1] = 29; config[31] = kind;
    await assert.rejects(resolve(config), message, 'the final config byte cannot begin an incomplete seed');
  }
  await assert.rejects(resolve(Uint8Array.of(2, 9, 8)), /instruction seed runs past/);
  await assert.rejects(resolve(Uint8Array.of(4, 0, 7, 2)), /account data seed runs past/);
  await assert.rejects(resolve(Uint8Array.of(3, 9)), /address|base58/i, 'a missing account key is never a seed');
  assert.throws(() => readExtraMetas(concat(EXECUTE_DISCRIMINATOR, uintLE(0, 4))), /missing its count/);
  assert.throws(() => readExtraMetas(concat(EXECUTE_DISCRIMINATOR, uintLE(4, 4), uintLE(0xffff_ffff, 4))), /past its entry/);
});
