// A time far off, and a time in words: the checker warns of a date that lands years away, and the approval's details
// say such a date the same way.
import { DAY } from '../model.mjs';

/** How far off a time may land before the checker asks whether its unit is right: three years. The program
 * takes any time a date holds; a time written in milliseconds lands thousands of years out and locks what waits on it. */
export const FAR_SECONDS = 3 * 365 * DAY;
/** The last time a spec can write as a date: 9999-12-31T23:59:59Z, in Unix seconds. A time counted from go-live
 * ("publish+7d") is written as its date once the economy is live (live.mjs), so it lands no later either. */
export const LAST_DATE_SECONDS = 253_402_300_799;
/** A Unix time in words, in English: "14 March 2031". Past what a date can show, the year alone. */
export function dateWords(seconds) {
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) return `the year ${Math.floor(Number(seconds) / 31_557_600) + 1970}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
