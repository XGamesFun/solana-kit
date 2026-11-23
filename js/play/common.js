// What the page client's modules share, none of it tied to one app: amounts in whole units (`units`, `show`), a fresh
// key, the options a call made without any has and the rule that refuses one a method doesn't take (`only`), the
// programs and instructions several parts name, and the types of the context the parts are built with (`Base`, `Ctx`).
import { encodeBase58 } from '../chain/base58.js';
import * as loot from '../client/index.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
export const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

export const MPL_CORE = loot.MPL_CORE_PROGRAM;

/** A compressed NFT's `prove_leaf`: its record stays good while the leaf is unchanged, so it may go in a transaction of its own first. */
export const isProveLeaf = ix =>
  ix.programId === loot.lootProgram() && loot.instructionOf(ix.data)?.name === 'prove_leaf';

/** A fresh ed25519 key (WebCrypto) that signs only its own account's creation: a crafted collectible's. */
export async function freshKey() {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    address: encodeBase58(raw),
    sign: async message => new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', pair.privateKey, message)),
  };
}

// The most decimals a token has: a mint keeps them in one byte.
const MAX_DECIMALS = 255;

/** A value as an error names it: text in quotes, so "6" is told from 6. */
const said = value => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/**
 * Refuses decimals that are not a token's: a whole number from 0 to 255. With them left out, or anything else, an
 * amount could only be read as some other amount ("1.5" with no decimals as 15).
 */
const places = decimals => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS)
    throw new Error(
      `An amount needs its token’s decimals, a whole number from 0 to ${MAX_DECIMALS} (6, or 9 for SOL): got ${said(decimals)}.`,
    );
};

/**
 * An amount in whole units of a token ("12", "0.5", or a number) in its base units, given the token's `decimals`. Only
 * a plain decimal is taken, with at most the token's decimals: "0x10", "1.2.3", "", "1e3", "-1" and an extra decimal
 * place are refused, never read as some other amount. So are decimals left out, or not a whole number.
 */
export const units = (amount, decimals) => {
  places(decimals);
  const text =
    typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
      ? plainNumber(amount)
      : typeof amount === 'string'
        ? amount.trim()
        : null;
  const m = text === null ? null : /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`${said(amount)} is not an amount: write a plain number like 12 or 0.5.`);
  const fraction = m[2] ?? '';
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals)))
    throw new Error(`${text} has more decimals than the token's ${decimals}.`);
  return BigInt(m[1] + fraction.padEnd(decimals, '0').slice(0, decimals));
};
/** A number as plain decimal text (1e-7 → "0.0000001"). */
const plainNumber = n => (/e/i.test(String(n)) ? n.toFixed(20).replace(/\.?0+$/, '') : String(n));
/** Base units as an amount in whole units of a token with `decimals` (1500000, 6 → "1.5"): what `units` reads back. */
export const show = (u, decimals) => {
  places(decimals);
  const s = BigInt(u)
    .toString()
    .padStart(decimals + 1, '0');
  const f = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${s.slice(0, s.length - decimals)}${f ? `.${f}` : ''}`;
};

/**
 * Refuses an option a method doesn't take, so a misspelled or outdated one fails here instead of being ignored (a page
 * passing `{ choice }` for a referrer would send every referral share to the treasury). `options`: what the method
 * was given, or what is left of it once the options it takes are read; `takes`: those it takes, said in the error.
 */
export function only(options, takes, method) {
  const unknown = Object.keys(options ?? {}).filter(k => !takes.includes(k) && options[k] !== undefined);
  if (!unknown.length) return;
  const hint =
    unknown.includes('choice') && takes.includes('chosenRecipient') ? ' (a buyer’s choice is `chosenRecipient`)' : '';
  throw new Error(
    `${method} doesn’t take ${unknown.map(k => `“${k}”`).join(', ')}${hint}. It takes: ${takes.join(', ')}.`,
  );
}

/**
 * What solanaApp() puts on the context its parts share (index.js), before any part adds its helpers: the spec, the
 * wallet, the RPC and the reads of its setup, typed as solanaApp() itself has them.
 * @typedef {object} Base
 * @property {any} spec
 * @property {any} wallet
 * @property {{}} programs
 * @property {() => number} now
 * @property {null} sponsor
 * @property {any} live
 * @property {any} client
 * @property {any} project
 * @property {ReturnType<typeof import('./keys.js').keyring> | null} keys
 * @property {(name: any) => ReturnType<typeof freshKey>} jobKey
 * @property {any} collections
 * @property {(collection: any) => any} ours
 * @property {Map<any, any>} tokens
 * @property {any} currencyKey
 * @property {(key: any) => any} mintOf
 * @property {(key: any) => any} decimalsOf
 * @property {(mint: any) => any} programOf
 * @property {(list: any, key: any) => any} part
 * @property {(name: any, address: any) => Promise<any>} read
 * @property {(name: any, address: any) => Promise<any>} readMaybe
 */

/**
 * The context once every part has put its helpers on it (each `add…` factory, in order): what the parts' methods are
 * built with. Each factory's return type adds its own, so every helper keeps the type it has.
 * @typedef {ReturnType<typeof import('./contests.js').addContests>} Ctx
 */
