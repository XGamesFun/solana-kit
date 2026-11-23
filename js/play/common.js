// What the page client's modules share, none of it tied to one app: amounts in whole units (`units`, `show`), a fresh
// key, the options a call made without any has and the rule that refuses one a method doesn't take (`only`), and
// the programs and instructions several parts name.
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

/**
 * An amount in whole units of a token ("12", "0.5", or a number) in its base units. Only a plain decimal is taken, with
 * at most the token's decimals: "0x10", "1.2.3", "", "1e3", "-1" and an extra decimal place are refused, never read as
 * some other amount.
 */
export const units = (amount, decimals) => {
  const text =
    typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
      ? plainNumber(amount)
      : typeof amount === 'string'
        ? amount.trim()
        : null;
  const m = text === null ? null : /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m)
    throw new Error(
      `${typeof amount === 'string' ? JSON.stringify(amount) : String(amount)} is not an amount: write a plain number like 12 or 0.5.`,
    );
  const fraction = m[2] ?? '';
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals)))
    throw new Error(`${text} has more decimals than the token's ${decimals}.`);
  return BigInt(m[1] + fraction.padEnd(decimals, '0').slice(0, decimals));
};
/** A number as plain decimal text (1e-7 → "0.0000001"). */
const plainNumber = n => (/e/i.test(String(n)) ? n.toFixed(20).replace(/\.?0+$/, '') : String(n));
export const show = (u, decimals) => {
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
