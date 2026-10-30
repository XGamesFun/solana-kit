// Whether 32 bytes are an ed25519 point. A program-derived address is, by definition, NOT on the curve (no private
// key can sign for it), so deriving one needs this check. It is the strict rule of @noble/curves' `ExtendedPoint.fromHex`
// (non-zip215), which @solana/web3.js uses: it refuses an encoding whose y is not below p, and x = 0 with the sign bit
// set. The Solana runtime (curve25519-dalek's decompress) is looser: it reads such a y mod p and lets that sign bit
// through, so it counts those few encodings (about 40 of the 2^256) as on the curve where this says off. A sha256 output
// lands on one of them with a chance of about 2^-250, so for deriving addresses the two never differ in practice.

const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const Y_MASK = (1n << 255n) - 1n;

const mod = (a) => {
  const r = a % P;
  return r >= 0n ? r : r + P;
};

function power(base, exponent) {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

/** Whether u/v has a square root mod p (RFC 8032 §5.1.3, step 2). */
function hasSquareRoot(u, v) {
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  const x = mod(u * v3 * power(u * v7, (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  // vx² = u: x is a root; vx² = -u: x·√-1 is. Anything else has none.
  return vx2 === u || vx2 === mod(-u);
}

export function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let encoded = 0n;
  for (let i = 31; i >= 0; i--) encoded = (encoded << 8n) | BigInt(bytes[i]);
  const y = encoded & Y_MASK;
  const xOdd = encoded >> 255n === 1n;
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (!hasSquareRoot(u, v)) return false;
  // x = 0 has no negative: the encoding with the sign bit set is not a point.
  return !(u === 0n && xOdd);
}
