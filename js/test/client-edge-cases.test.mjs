// Edge cases of the client's encoders, decoders and helpers: values that do not fit are refused rather than written
// as some other value, truncated accounts are refused, another program's error is not read as loot's, and the RPC and
// results-server helpers say plainly what went wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { encodeAccount } from '../chain/borsh.js';
import { concat, uintLE } from '../chain/bytes.js';
import { readTable, sendFitting, tableAccounts, tableAddress } from '../chain/lookup.js';
import { SYSVAR_SLOT_HASHES } from '../chain/pda.js';
import { GENESIS, rpcClient } from '../chain/rpc.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { draws, fetchVouchers, newKey, report, resultBytes, signVoucher } from '../results/index.js';
import { cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const address = (n) => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : i + 1)));
const A = address(1);
const B = address(2);
const ROUND = 'ab'.repeat(16);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null }, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

test('resultBytes refuses what it cannot write as one result', () => {
  const ok = { game: A, round: ROUND, endedAt: 1, winners: [{ wallet: B, place: 1 }] };
  assert.equal(resultBytes(ok).length, 14 + 1 + 32 + 16 + 8 + 1 + 35);
  assert.throws(() => resultBytes({ ...ok, cluster: 'testnet' }), /Unknown cluster/);
  assert.throws(() => resultBytes({ ...ok, cluster: 'toString' }), /Unknown cluster/);
  assert.throws(() => resultBytes({ ...ok, winners: [{ wallet: B, place: 256 }] }), RangeError);
  assert.throws(() => resultBytes({ ...ok, winners: Array.from({ length: 256 }, () => ({ wallet: B, place: 0 })) }), /at most 255/);
  assert.throws(() => resultBytes({ ...ok, round: 'ab'.repeat(4) }), /16 bytes/);
  assert.throws(() => resultBytes({ ...ok, round: 'ab'.repeat(17) }), /16 bytes/);
  assert.deepEqual(resultBytes({ ...ok, round: Uint8Array.from({ length: 16 }, () => 0xab) }), resultBytes(ok));
});

test('uintLE refuses a number that already lost precision, and what does not fit', () => {
  assert.throws(() => uintLE(2 ** 53 + 1, 8), /safe integer/);
  assert.throws(() => uintLE(2 ** 53, 8), /safe integer/);
  assert.deepEqual(uintLE(2n ** 53n + 1n, 8), Uint8Array.of(1, 0, 0, 0, 0, 0, 0x20, 0));
  assert.deepEqual(uintLE(Number.MAX_SAFE_INTEGER, 8), uintLE(2n ** 53n - 1n, 8));
  assert.throws(() => uintLE(-1, 4), RangeError);
  assert.throws(() => uintLE(256, 1), RangeError);
  assert.throws(() => uintLE(1.5, 4));
});

test('a u8 seed or byte past 255 is refused, never wrapped', () => {
  assert.throws(() => loot.pda.pool(A, 256), RangeError);
  assert.notEqual(loot.pda.pool(A, 255), loot.pda.pool(A, 0));
  assert.throws(() => loot.rollNonce(A, 1n, 256), RangeError);
  assert.equal(typeof loot.rollNonce(A, 1n, 255), 'bigint');
  assert.throws(() => loot.verdictBytes({ contest: A, incarnation: 0n, side: 256, expires: 0 }), RangeError);
  const off = loot.verdictBytes({ contest: A, incarnation: 0n, side: null, expires: 0 });
  assert.equal(off[off.length - 9], 255);
});

test("lootError reads only loot's own errors", () => {
  const LOOT = loot.LOOT_PROGRAM;
  const BGUM = loot.BUBBLEGUM_PROGRAM;
  // Bubblegum's 6000 is not loot's NotOwner, called by loot or not.
  assert.equal(loot.lootError([`Program ${BGUM} failed: custom program error: 0x1770`]), null);
  assert.equal(loot.lootError([
    `Program ${LOOT} invoke [1]`,
    `Program ${BGUM} invoke [2]`,
    'Program log: AnchorError occurred. Error Code: LeafAuthorityMustSign. Error Number: 6000. Error Message: Leaf authority must sign.',
    `Program ${BGUM} failed: custom program error: 0x1770`,
    `Program ${LOOT} failed: custom program error: 0x1770`,
  ]), null);
  // loot's own, by its code and by Anchor's line, also after a call that went well.
  assert.equal(loot.lootError([`Program ${LOOT} invoke [1]`, `Program ${BGUM} invoke [2]`, `Program ${BGUM} success`, `Program ${LOOT} failed: custom program error: 0x1770`]).code, 6000);
  const named = loot.lootError([`Program ${LOOT} invoke [1]`, 'Program log: AnchorError occurred. Error Code: NotOwner. Error Number: 6000. Error Message: Signer is not the project\'s owner.', `Program ${LOOT} failed: custom program error: 0x1770`]);
  assert.equal(named.name, 'NotOwner');
  // Logs that name no program read as before.
  assert.equal(loot.lootError(['custom program error: 0x1770']).code, 6000);
});

test('signVoucher takes the cluster clock as a bigint', async () => {
  const signer = await newKey();
  const v = await signVoucher({ signer, game: A, grant: 1, incarnation: 0n, wallet: B, round: ROUND, now: 1_800_000_000n, seconds: 60 });
  assert.equal(v.expires, 1_800_000_060);
  const n = await signVoucher({ signer, game: A, grant: 1, incarnation: 0n, wallet: B, round: ROUND, now: 1_800_000_000, seconds: 60 });
  assert.equal(n.expires, v.expires);
  await assert.rejects(signVoucher({ signer, game: A, grant: 1, incarnation: 0n, wallet: B, round: ROUND, now: undefined }), /clock/);
});

test('a truncated Stash or Sheet is refused, never read as empty addresses', () => {
  const stash = concat(Uint8Array.of(loot.TAGS.Stash), addressBytes(A), uintLE(7, 4), uintLE(3, 4), addressBytes(B));
  assert.throws(() => loot.decodeStash(stash), /truncated/);
  const whole = concat(stash, addressBytes(B), addressBytes(B));
  assert.deepEqual(loot.decodeStash(whole), { project: A, id: 7, nfts: [B, B, B] });
  assert.throws(() => loot.decodeStash(Uint8Array.of(loot.TAGS.Stash, 1, 2)), /Not a Stash/);

  const text = (t) => concat(uintLE(t.length, 4), new TextEncoder().encode(t));
  const head = concat(Uint8Array.of(loot.TAGS.Sheet), addressBytes(A), addressBytes(B));
  assert.deepEqual(loot.decodeSheet(concat(head, uintLE(1, 4), text('Class'), text('Mage'))).attributes, [{ key: 'Class', value: 'Mage' }]);
  assert.throws(() => loot.decodeSheet(concat(head, uintLE(1000, 4), text('Class'), text('Mage'))), /truncated/);
  assert.throws(() => loot.decodeSheet(concat(head, uintLE(1, 4), uintLE(50, 4), new TextEncoder().encode('Class'))), /truncated/);
  assert.throws(() => loot.decodeSheet(head), /Not a Sheet/);
});

test('claimWins stops when the server leaves out the next page', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    if (++calls > 5) throw new Error('read the same page again');
    return json(200, { wins: [] });
  };
  const app = solanaApp({ spec: { version: 2, tokens: [], live: { project: A } }, rpc: { call: async () => null }, wallet: { address: B } });
  assert.deepEqual(await app.claimWins({ server: 'https://results.invalid', fetchImpl }), []);
  assert.equal(calls, 1);
  // A server that names the same page again is not followed around in a circle either.
  calls = 0;
  const looping = async () => {
    if (++calls > 5) throw new Error('read the same page again');
    return json(200, { wins: [], next: 'p2' });
  };
  await app.claimWins({ server: 'https://results.invalid', fetchImpl: looping });
  assert.equal(calls, 2);
});

test('solanaApp checks the genesis block of an http RPC once, before its first request', async () => {
  const spec = { version: 2, tokens: [], live: { project: A } };
  const asked = [];
  const rpcOn = (genesis) => ({
    url: 'https://rpc.example.invalid',
    async call(method) {
      asked.push(method);
      if (method === 'getGenesisHash') return genesis;
      throw new Error(`unexpected ${method}`);
    },
    async account() {
      asked.push('account');
      return null;
    },
    async accounts(keys) {
      asked.push('accounts');
      return keys.map(() => null);
    },
    async programAccounts() {
      asked.push('programAccounts');
      return [];
    },
  });
  await assert.rejects(solanaApp({ spec, rpc: rpcOn(GENESIS.mainnet), wallet: { address: B } }).shop(), /mainnet/);
  assert.deepEqual(asked, ['getGenesisHash'], 'nothing else is asked of a mainnet RPC');
  asked.length = 0;
  await assert.rejects(solanaApp({ spec, rpc: rpcOn(GENESIS.testnet), wallet: { address: B } }).shop(), /testnet/);
  asked.length = 0;
  const app = solanaApp({ spec, rpc: rpcOn(GENESIS.devnet), wallet: { address: B } });
  await app.shop().catch(() => {});
  await app.shop().catch(() => {});
  assert.equal(asked.filter((m) => m === 'getGenesisHash').length, 1);
  assert.ok(asked.length > 1);
  // A URL that says mainnet is refused at once, given as a URL or on an rpc object.
  assert.throws(() => solanaApp({ spec, rpcUrl: 'https://api.mainnet-beta.solana.com' }), /mainnet/);
  assert.throws(() => solanaApp({ spec, rpc: { ...rpcOn(GENESIS.devnet), url: 'https://mainnet.example.invalid' } }), /mainnet/);
  // The old live shape (`live.game`) is not read.
  assert.throws(() => solanaApp({ spec: { version: 2, live: { game: A } }, rpc: {} }), /not live/);
});

test("tokenBalance reads only a missing account as zero; a gateway's 502 is asked again", async () => {
  const said = (message) => async () => json(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message } });
  const sleepImpl = async () => {};
  assert.equal(await rpcClient('https://rpc.invalid', { fetchImpl: said('Invalid param: could not find account'), sleepImpl }).tokenBalance(A), 0n);
  await assert.rejects(rpcClient('https://rpc.invalid', { fetchImpl: said('Invalid param: not a Token account'), sleepImpl }).tokenBalance(A), /not a Token account/);
  let calls = 0;
  const flaky = async () => (++calls <= 2 ? { ...json(502, '<html>Bad Gateway</html>'), json: async () => { throw new SyntaxError('Unexpected token <'); } } : json(200, { jsonrpc: '2.0', id: 1, result: 9 }));
  assert.equal(await rpcClient('https://rpc.invalid', { fetchImpl: flaky, sleepImpl }).call('getSlot'), 9);
  assert.equal(calls, 3);
});

test('the results helpers check the status before reading JSON', async () => {
  const html = async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const signer = await newKey();
  await assert.rejects(report({ server: 'https://results.invalid', cert: {}, signer, game: A, round: ROUND, endedAt: 1, winners: [], fetchImpl: html }), (e) => e.status === 502 && /502 Bad Gateway/.test(e.message));
  await assert.rejects(fetchVouchers({ server: 'https://results.invalid', game: A, round: ROUND, wallet: B, fetchImpl: html }), /502/);
  await assert.rejects(draws.get({ server: 'https://results.invalid', game: A, draw: 'd', fetchImpl: html }), /502/);
  const notFound = async () => json(404, { error: { code: 'R-NO-DRAW', why: 'No such draw.' } });
  await assert.rejects(draws.get({ server: 'https://results.invalid', game: A, draw: 'd', fetchImpl: notFound }), (e) => e.code === 'R-NO-DRAW' && e.message === 'No such draw.');
});

test('sendFitting refuses to send against a table the network has not moved past', async () => {
  const payer = A;
  const program = address(9);
  const instructions = [{ programId: program, keys: Array.from({ length: 40 }, (_, i) => ({ pubkey: address(100 + i), isSigner: false, isWritable: false })), data: new Uint8Array(0) }];
  const slot = 1000n;
  const hashes = concat(uintLE(1, 8), uintLE(slot, 8), new Uint8Array(32));
  const [table] = tableAddress(payer, slot);
  const held = tableAccounts(instructions);
  const tableData = concat(uintLE(1, 4), uintLE(2n ** 64n - 1n, 8), uintLE(slot, 8), Uint8Array.of(0, 1), addressBytes(payer), new Uint8Array(2), ...held.map(addressBytes));
  let sent = 0;
  let sleeps = 0;
  const rpc = {
    latestBlockhash: async () => ({ blockhash: address(7), lastValidBlockHeight: 1 }),
    send: async () => `sig${++sent}`,
    confirm: async (s) => s,
    account: async (key) => (key === SYSVAR_SLOT_HASHES ? { data: hashes } : key === table && sent ? { owner: 'AddressLookupTab1e1111111111111111111111111', data: tableData } : null),
    call: async () => Number(slot),
  };
  assert.deepEqual(readTable(await (sent++, rpc.account(table))).addresses, held);
  sent = 0;
  await assert.rejects(sendFitting({ rpc, payer, instructions, sign: async (m) => m, sleep: async () => { sleeps++; } }), /has not moved past/);
  assert.equal(sleeps, 40);
  const tableSteps = sent;
  assert.ok(tableSteps >= 1);
  // Once the slot has passed, the transaction goes.
  sent = 0;
  rpc.call = async () => Number(slot) + 1;
  const done = await sendFitting({ rpc, payer, instructions, sign: async (m) => m, sleep: async () => {} }).catch((e) => e);
  assert.ok(!(done instanceof Error) || !/has not moved past/.test(done.message));
});

test('staked gives what a seat holds in base units exactly', { skip }, async () => {
  const w = world({ seed: 'edge-staked' });
  const reward = w.newMint();
  w.pool(5, reward);
  w.chain.send(w.creator, [loot.openFarmIx({ owner: w.creator, project: w.project, id: 2, rewardsMint: reward, stakedMint: w.mint,
    args: { custody: 'Freeze', rewards_pool: 5, tiers: [{ lock: 0, bps: 10_000 }], boosts: [], max_boost_bps: 0, gate: null } })]);
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, farms: [{ key: 'tokens', id: 2, stakes: 'coin' }] };
  // No dry run: the seat as written is what is read.
  const app = solanaApp({ spec, rpc: { ...w.chain.rpc, simulate: undefined }, wallet: { address: w.player, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  await app.stake('tokens', '2.5');
  assert.equal((await app.staked('tokens'))[0].amountUnits, 2_500_000n);
  // A seat holding more than 2^53 base units: the bigint keeps every unit.
  const seatAddress = loot.pda.seat(loot.pda.farm(w.project, 2), w.player);
  const account = w.chain.get(seatAddress);
  const big = 2n ** 53n + 1n;
  w.chain.put(seatAddress, { ...account, data: encodeAccount(loot.IDL, 'Seat', { ...loot.decode('Seat', account.data), amount: big }) });
  const [seat] = await app.staked('tokens');
  assert.equal(seat.amountUnits, big);
  assert.equal(typeof seat.amount, 'number');
});
