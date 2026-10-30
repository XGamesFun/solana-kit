// The RPC client waits out a public RPC's rate limit (429) instead of failing a player's transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rpcClient } from '../chain/rpc.js';

const answer = (status, body, headers = {}) => ({ status, ok: status === 200, headers: new Headers(headers), json: async () => body });

test('a rate limit is retried until the RPC answers', async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => (++calls <= 6 ? answer(429, null) : answer(200, { jsonrpc: '2.0', id: 1, result: 42 }));
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async (ms) => waits.push(ms) });
  assert.equal(await rpc.call('getSlot'), 42);
  assert.equal(waits.length, 6);
  assert.ok(waits.every((ms) => ms > 0 && ms <= 15_000 * 1.25));
});

test("a rate limit's Retry-After is honoured", async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => (++calls === 1 ? answer(429, null, { 'retry-after': '3' }) : answer(200, { jsonrpc: '2.0', id: 1, result: 7 }));
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async (ms) => waits.push(ms) });
  assert.equal(await rpc.call('getSlot'), 7);
  assert.deepEqual(waits, [3000]);
});

test('a node behind the cluster (-32005, -32016) is asked again; minContextSlot reaches getMultipleAccounts', async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, { body }) => {
    bodies.push(JSON.parse(body));
    calls++;
    if (calls === 1) return answer(200, { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'No confirmed state available yet' } });
    if (calls === 2) return answer(200, { jsonrpc: '2.0', id: 2, error: { code: -32016, message: 'Minimum context slot has not been reached' } });
    return answer(200, { jsonrpc: '2.0', id: 3, result: { context: { slot: 9 }, value: [null] } });
  };
  const rpc = rpcClient('http://rpc', { fetchImpl, sleepImpl: async () => {} });
  assert.equal(await rpc.account('11111111111111111111111111111111', 'confirmed', { minContextSlot: 516_494_860 }), null);
  assert.equal(calls, 3);
  assert.equal(bodies[2].params[1].minContextSlot, 516_494_860);
  assert.equal(bodies[2].params[1].commitment, 'confirmed');
});
