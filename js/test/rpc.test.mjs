// The RPC client waits out a public RPC's rate limit (429) instead of failing a player's transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rpcClient } from '../chain/rpc.js';

const answer = (status, body, headers = {}) => ({
  status,
  ok: status === 200,
  headers: new Headers(headers),
  json: async () => body,
});

test('a rate limit is retried until the RPC answers', async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => (++calls <= 6 ? answer(429, null) : answer(200, { jsonrpc: '2.0', id: 1, result: 42 }));
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async ms => waits.push(ms) });
  assert.equal(await rpc.call('getSlot'), 42);
  assert.equal(waits.length, 6);
  assert.ok(waits.every(ms => ms > 0 && ms <= 15_000 * 1.25));
});

test("a rate limit's Retry-After is honoured", async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () =>
    ++calls === 1 ? answer(429, null, { 'retry-after': '3' }) : answer(200, { jsonrpc: '2.0', id: 1, result: 7 });
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async ms => waits.push(ms) });
  assert.equal(await rpc.call('getSlot'), 7);
  assert.deepEqual(waits, [3000]);
});

test('a node behind the cluster (-32005, -32016) is asked again; minContextSlot reaches getMultipleAccounts', async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, { body }) => {
    bodies.push(JSON.parse(body));
    calls++;
    if (calls === 1)
      return answer(200, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32005, message: 'No confirmed state available yet' },
      });
    if (calls === 2)
      return answer(200, {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32016, message: 'Minimum context slot has not been reached' },
      });
    return answer(200, { jsonrpc: '2.0', id: 3, result: { context: { slot: 9 }, value: [null] } });
  };
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async () => {} });
  assert.equal(
    await rpc.account('11111111111111111111111111111111', 'confirmed', { minContextSlot: 516_494_860 }),
    null,
  );
  assert.equal(calls, 3);
  assert.equal(bodies[2].params[1].minContextSlot, 516_494_860);
  assert.equal(bodies[2].params[1].commitment, 'confirmed');
});

test('a send refused for a blockhash the node has not seen yet is sent again; one truly gone is refused', async () => {
  const notFound = {
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32002,
      message: 'Transaction simulation failed: Blockhash not found',
      data: { err: 'BlockhashNotFound', logs: [] },
    },
  };
  let calls = 0;
  const waits = [];
  const behind = async () =>
    ++calls <= 2 ? answer(200, notFound) : answer(200, { jsonrpc: '2.0', id: 3, result: 'sig' });
  const rpc = rpcClient('http://rpc', { fetchImpl: behind, sleepImpl: async ms => waits.push(ms) });
  assert.equal(await rpc.send(new Uint8Array(3)), 'sig');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);

  calls = 0;
  const gone = rpcClient('http://rpc', {
    fetchImpl: async () => (calls++, answer(200, notFound)),
    sleepImpl: async () => {},
  });
  await assert.rejects(gone.send(new Uint8Array(3)), e => {
    assert.equal(e.code, -32002);
    assert.match(e.message, /Blockhash not found/);
    return true;
  });
  assert.equal(calls, 5, 'asked again four times, then the refusal is the answer');
  // (only a send: a read that names a blockhash is not asked again for it)
  calls = 0;
  await assert.rejects(gone.call('simulateTransaction', ['x']), /Blockhash not found/);
  assert.equal(calls, 1);
});

test('a send the cluster has already taken is a send: its signature is the transaction’s own', async () => {
  // (the answer to a first send was lost on its way back; the second is refused as already processed)
  const { compileMessage, wireTransaction, transactionId } = await import('../chain/tx.js');
  const { transferLamports } = await import('../chain/programs.js');
  const payer = '11111111111111111111111111111112';
  const wire = wireTransaction(
    compileMessage({ payer, blockhash: payer, instructions: [transferLamports(payer, payer, 1n)] }),
    [new Uint8Array(64).fill(7)],
  );
  const taken = {
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32002,
      message: 'Transaction simulation failed: This transaction has already been processed',
      data: { err: 'AlreadyProcessed', logs: [] },
    },
  };
  let calls = 0;
  const rpc = rpcClient('http://rpc', {
    fetchImpl: async () => (calls++, answer(200, taken)),
    sleepImpl: async () => {},
  });
  assert.equal(await rpc.send(wire), transactionId(wire));
  assert.equal(calls, 1);
  // Any other refusal is still a refusal.
  const refused = {
    ...taken,
    error: { code: -32002, message: 'Transaction simulation failed: custom program error: 0x1' },
  };
  const other = rpcClient('http://rpc', { fetchImpl: async () => answer(200, refused), sleepImpl: async () => {} });
  await assert.rejects(other.send(wire), /custom program error/);
});

test('a refusal says whether an earlier try of the same send went unanswered, and a program’s words are its own', async () => {
  const { alreadyProcessed } = await import('../chain/rpc.js');
  const notFound = {
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32002,
      message: 'Transaction simulation failed: Blockhash not found',
      data: { err: 'BlockhashNotFound', logs: [] },
    },
  };
  // The first try's connection drops (a node may have taken it); every later one is refused by a node behind.
  let calls = 0;
  const dropped = rpcClient('http://rpc', {
    fetchImpl: async () => {
      if (++calls === 1) throw new Error('socket hang up');
      return answer(200, notFound);
    },
    sleepImpl: async () => {},
  });
  await assert.rejects(dropped.send(new Uint8Array(3)), e => {
    assert.equal(e.code, -32002);
    assert.equal(e.err, 'BlockhashNotFound');
    assert.equal(e.maybeTaken, true);
    return true;
  });
  // A gateway's failure is no answer either.
  calls = 0;
  const gateway = rpcClient('http://rpc', {
    fetchImpl: async () => (++calls === 1 ? answer(502, null) : answer(200, notFound)),
    sleepImpl: async () => {},
  });
  await assert.rejects(gateway.send(new Uint8Array(3)), e => e.maybeTaken === true);
  // Every try answered with a refusal: no node took it.
  const answered = rpcClient('http://rpc', { fetchImpl: async () => answer(200, notFound), sleepImpl: async () => {} });
  await assert.rejects(answered.send(new Uint8Array(3)), e => e.maybeTaken === false);
  // (a read is never a send that may have been taken)
  calls = 0;
  const read = rpcClient('http://rpc', {
    fetchImpl: async () => {
      if (++calls === 1) throw new Error('socket hang up');
      return answer(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } });
    },
    sleepImpl: async () => {},
  });
  await assert.rejects(read.call('getAccountInfo', ['x']), e => e.maybeTaken === false);

  // "Already processed" is the node's own word for a transaction it has, never a program's log line or error name.
  assert.equal(alreadyProcessed({ err: 'AlreadyProcessed', message: 'anything' }), true);
  assert.equal(
    alreadyProcessed({ message: 'Transaction simulation failed: This transaction has already been processed' }),
    true,
  );
  const programs = {
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32002,
      message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771',
      data: {
        err: { InstructionError: [0, { Custom: 6001 }] },
        logs: [
          'Program log: AnchorError occurred. Error Code: AlreadyProcessed. Error Number: 6001. Error Message: This claim has already been processed.',
        ],
      },
    },
  };
  const refusing = rpcClient('http://rpc', { fetchImpl: async () => answer(200, programs), sleepImpl: async () => {} });
  await assert.rejects(refusing.send(new Uint8Array(3)), e => {
    assert.match(e.message, /This claim has already been processed/);
    assert.equal(alreadyProcessed(e), false);
    return true;
  });
});
