// The tests' own helpers do what the tests count on them for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quick, ROOM_MS } from './helpers/quick.mjs';

test('a call that loops past its room fails and one that answers passes, by the CPU time it took', async () => {
  const cpuMs = () => (process.cpuUsage().user + process.cpuUsage().system) / 1000;
  const loop = ms => {
    for (const from = cpuMs(); cpuMs() - from < ms;);
  };
  const wait = ms => new Promise(resolve => setTimeout(() => resolve('late'), ms));
  /** A room of `ms` milliseconds, whatever this run's own room is. */
  const rooms = ms => ms / ROOM_MS;
  await assert.rejects(
    quick('a loop', () => loop(60), rooms(20)),
    /^AssertionError.*: a loop took \d+ ms of CPU, more than the 20 ms it is given$/,
  );
  assert.equal(await quick('an answer', () => 7), 7);
  // time spent waiting is not time spent looping: a wait three times as long as the room passes
  assert.equal(await quick('a wait', () => wait(300), rooms(100)), 'late');
});
