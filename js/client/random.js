// The loot program's rolling module (`src/random`), mirrored: every random choice it makes is drawn from a stream of
// the oracle's answer, by a path that names what is drawn, with one unbiased sampler. A page shows from an order's
// answer what each draw gave (and a fresh unit's range traits) exactly as the program drew them. Held to the
// program's own vectors (`js/test/fixtures/roll-vectors.json`, from gamesfun-loot's `tests/fixtures`).
import { concat, uintLE } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';

/** What a path's first word names (`random::tag`): an entry of a box, a stash's NFT, a lottery's ticket, a fresh trait. */
export const TAG = Object.freeze({ ENTRY: 1, STASH: 2, LOTTERY: 3, TRAIT: 4 });
/** The most words a path holds. */
export const MAX_PATH = 8;
const U64 = (1n << 64n) - 1n;
const PREFIX = new TextEncoder().encode('loot-roll-v1');

/** A stream of the oracle's 32-byte `answer` at `path` (whole numbers): seed = sha256("loot-roll-v1" | answer | path as
 * u32 little-endian words); its nth number the first 8 bytes, little-endian, of sha256(seed | n as u64 little-endian). */
export function stream(answer, path = []) {
  const words = path.slice(0, MAX_PATH).map((w) => uintLE(w, 4));
  const seed = sha256(concat(PREFIX, Uint8Array.from(answer), ...words));
  let counter = 0n;
  return {
    next() {
      const block = sha256(concat(seed, uintLE(counter, 8)));
      counter += 1n;
      return block.subarray(0, 8).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
    },
  };
}

/** A number from 0 to `n` - 1, every one as likely: a draw past the last whole multiple of `n` is drawn again. null for
 * `n` 0. */
export function uniform(s, n) {
  n = BigInt(n);
  if (n === 0n) return null;
  const limit = U64 - (((1n << 64n) - n) % n);
  for (;;) {
    const roll = s.next();
    if (roll <= limit) return roll % n;
  }
}

/** The row `at` lands on, the weights walked in order. null past the last. */
export function walk(weights, at) {
  let left = BigInt(at);
  for (const [i, w] of weights.entries()) {
    if (left < BigInt(w)) return i;
    left -= BigInt(w);
  }
  return null;
}

/** A row by weight (a weight of 0 never drawn); null when none weighs anything, or they sum past 64 bits. */
export function weighted(s, weights) {
  const total = weights.reduce((n, w) => n + BigInt(w), 0n);
  if (total > U64) return null;
  const at = uniform(s, total);
  return at === null ? null : walk(weights, at);
}

/** A number from `min` to `max`, both included, every one as likely (either order). */
export function range(s, min, max) {
  let [lo, hi] = [BigInt(min), BigInt(max)];
  if (lo > hi) [lo, hi] = [hi, lo];
  const n = hi - lo + 1n;
  return n > U64 ? s.next() : lo + uniform(s, n);
}

/** A fresh unit's range trait `t` (its place among the item's traits) as the program draws it at the mint: from the
 * order's `answer`, `at` the unit's place in the order's `won`. */
export const rangeTrait = (answer, at, t, min, max) => range(stream(answer, [TAG.TRAIT, at, t]), min, max);
