// Small text and number helpers the economy tools share. Pure.
import { LAMPORTS_PER_SOL } from './model.mjs';

/** Lamports as SOL, a plain number. */
export const sol = lamports => Number(lamports) / Number(LAMPORTS_PER_SOL);

/** A part of a spec by its name, or its key when it has none, in quotes: “Gold Box”. */
export const label = part => `“${part?.name ?? part?.key}”`;

/** The most decimals a number is printed with: a lamport of SOL, and no token has a finer unit. */
const FINEST = 9;

/**
 * A number as the tools print it: an amount, a count, a number of days. Thousands are grouped and the whole part is
 * never rounded; what follows the point is cut so that the number keeps at most `digits` significant digits, and never
 * more than nine decimals. So 661112079143.5319 is "661,112,079,144", 74081.822068 "74,081.8", 0.176670648
 * "0.176671" and 0.000005 "0.000005". A number written as a string is read as the number; anything else that is not a
 * finite number is printed as it is.
 */
export function numeral(x, digits = 6) {
  if (typeof x === 'bigint') return x.toLocaleString('en-US');
  // (a spec may write an amount as a string, "0.1", to keep it exact)
  if (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x)) return numeral(Number(x), digits);
  if (typeof x !== 'number' || !Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  // (the power of ten of its first digit: 0 for 1 to 9.99…, -3 for 0.001 to 0.00999…)
  const magnitude = Number(Math.abs(x).toExponential().split('e')[1]);
  const decimals = Math.max(0, Math.min(FINEST, digits - 1 - magnitude));
  const text = x.toLocaleString('en-US', { maximumFractionDigits: decimals });
  return text === '-0' ? '0' : text;
}

/**
 * A number the spec's author wrote (a price, a seed, a supply, a prize), printed as they wrote it: grouped, and every
 * digit kept, down to the nine decimals any number is printed with. `numeral` is for a figure worked out from them.
 */
export const asWritten = x => numeral(x, 15);

/**
 * A percent as the tools print it, without its sign: four significant digits (75.89, 0.01235), or `digits` of them
 * for one that follows from written chances or shares, its whole part never rounded (1,250). One that is not 0 or
 * 100 is never printed as 0 or 100: it keeps the digits that say so (99.995), down to nine decimals.
 */
export function percentage(x, digits = 4) {
  if (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x)) return percentage(Number(x), digits);
  if (typeof x !== 'number' || !Number.isFinite(x)) return String(x);
  for (let kept = digits; kept < 15; kept++) {
    const text = numeral(x, kept);
    if ((text !== '100' || x === 100) && (text !== '0' || x === 0)) return text;
  }
  return numeral(x, 15);
}

/** A count with its noun: "1 box", "3 boxes", "1,200 boxes" (`many` when the plural isn't `one` + "s"). */
export const plural = (n, one, many = `${one}s`) => `${numeral(n)} ${n === 1 ? one : many}`;
