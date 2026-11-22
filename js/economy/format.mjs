// Small text and number helpers the economy tools share. Pure.
import { LAMPORTS_PER_SOL } from './model.mjs';

/** Lamports as SOL, a plain number. */
export const sol = lamports => Number(lamports) / Number(LAMPORTS_PER_SOL);

/** A part of a spec by its name, or its key when it has none, in quotes: “Gold Box”. */
export const label = part => `“${part?.name ?? part?.key}”`;

/** A count with its noun: "1 box", "3 boxes" (`many` when the plural isn't `one` + "s"). */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
