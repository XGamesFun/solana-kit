// The client's mirror of the program's rolling module draws what the program draws: its vectors, from the program's
// own test (`the_vectors_file_is_what_the_program_draws`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fromHex } from '../chain/bytes.js';
import { range, stream, uniform, weighted } from '../client/random.js';

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/roll-vectors.json', import.meta.url), 'utf8'));

test('the stream and the sampler draw the program’s vectors', () => {
  assert.equal(cases.length, 12);
  for (const c of cases) {
    const answer = fromHex(c.answer);
    const s = stream(answer, c.path);
    assert.deepEqual([s.next(), s.next(), s.next()].map(String), c.numbers, JSON.stringify(c.path));
    assert.equal(uniform(stream(answer, c.path), 7), BigInt(c.uniform7));
    assert.equal(uniform(stream(answer, c.path), (1n << 63n) + 1n), BigInt(c.uniformHalfPlusOne));
    assert.equal(weighted(stream(answer, c.path), [100, 0, 20, 5]), c.weighted_100_0_20_5);
    assert.equal(range(stream(answer, c.path), 1, 100), BigInt(c.range_1_100));
  }
});

test('a weight of 0 is never drawn, and nothing weighing nothing draws nothing', () => {
  const answer = new Uint8Array(32).fill(7);
  for (let i = 0; i < 500; i++) assert.notEqual(weighted(stream(answer, [1, i]), [3, 0, 2]), 1);
  assert.equal(weighted(stream(answer, [1]), [0, 0]), null);
  assert.equal(uniform(stream(answer, [1]), 0), null);
});
