// Nothing secret ever goes in an economy: it is public. These patterns catch a key, a keypair file, a seed phrase
// or a keyed RPC link before it is saved or published. Pure.
import { isSignature } from '../chain/base58.js';
import { SEED_WORDS } from './seed-words.mjs';

/** The names only a credential goes by. */
const CREDENTIAL_ONLY =
  'api[-_ ]?key|apikey|private[-_ ]?key|secret[-_ ]?key|seed[-_ ]?phrase|mnemonic|access[-_ ]?token|auth[-_ ]?token';
/** Every name a credential goes by, ordinary words ("secret", "bearer") included: a field named so holds one. */
const CREDENTIAL = `${CREDENTIAL_ONLY}|secret|bearer`;

const SECRET_PATTERNS = [
  // a 64-byte Solana secret key in base58 (signatures are the same length; the spec keeps those in their own field)
  /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,90}($|[^1-9A-HJ-NP-Za-km-z])/,
  // the same 64 bytes in hex (32 bytes in hex are left alone: a hash is as long)
  /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{128}($|[^0-9a-fA-F])/,
  // a keypair file's byte array
  /\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]/,
  // key=value or key: value for a name only a credential goes by ("api_key: …", "private key = …")
  new RegExp(`\\b(${CREDENTIAL_ONLY})\\b\\s*[=:]`, 'i'),
  // "secret" is an ordinary word too ("Secret: Blade"): with = or : after it, only a value that looks like a key (a
  // run of 16 or more key characters) or a seed phrase (12 or more lower-case words)
  /\bsecret\b\s*[=:]\s*["'`]?([A-Za-z0-9+/_.~-]{16,}|([a-z]{3,8}\s+){11,}[a-z]{3,8}\b)/i,
  // a bearer token as an Authorization header carries it
  /\bbearer\s+[A-Za-z0-9+/_.~-]{16,}/i,
  // a credential in a URL query, by a name only a credential goes by ("?api-key=…", "?access_token=…")
  /[?&](api[-_]?key|apikey|access[-_]?token|auth[-_]?token|private[-_]?key|secret[-_]?key|client[-_]?secret)=/i,
  // or by a name a link also uses for ordinary things ("?token=12", "?sig=", "?key=hero"), with a value that looks like
  // a key: a run of 16 or more key characters
  /[?&](key|token|secret|auth|sig|signature)=[A-Za-z0-9+/_.~%-]{16,}/i,
  // RPC providers that put the key in the path
  /\b(helius-rpc\.com|quiknode\.pro|alchemy\.com\/v2|ankr\.com\/[a-z]+\/[0-9a-f]{32})/i,
  // PEM blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Whether a string looks like it carries a key, a token or a keyed RPC URL. */
export const secretLike = value => typeof value === 'string' && SECRET_PATTERNS.some(p => p.test(value));

const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);
/** A seed phrase: 12 to 24 lower-case words of 3 to 8 letters and nothing else (no sentence is only such words). */
const seedPhrase = s => {
  const words = s.trim().split(/\s+/);
  return MNEMONIC_LENGTHS.has(words.length) && words.every(w => /^[a-z]{3,8}$/.test(w));
};

/**
 * A seed phrase anywhere in `s`, however it is written: 12 or more words in a row that are all of the seed-phrase
 * word list (seed-words.mjs), whatever their case and whatever stands between them (spaces, commas, new lines, the
 * numbers of a numbered list). Ordinary writing does not run 12 such words: the list has no "the", "and" or "of".
 */
const seedWords = s => {
  let run = 0;
  for (const word of s.toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    run = SEED_WORDS.has(word) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
};

/** A field's name that is a credential's: "apiKey", "private_key", "seed phrase", "my-secret". */
const CREDENTIAL_FIELD = new RegExp(`\\b(${CREDENTIAL})$`, 'i');
/** Whether a field holds anything: a string with more than spaces, a number, a list or an object that is not empty. */
const filled = v =>
  typeof v === 'string'
    ? v.trim() !== ''
    : Array.isArray(v)
      ? v.length > 0
      : v !== null && v !== undefined && (typeof v !== 'object' || Object.keys(v).length > 0);

/** Every place in `value` that looks like a key, a seed phrase or a keypair file. */
export function findSecrets(value, path = 'economy') {
  if (typeof value === 'string') return secretLike(value) || seedPhrase(value) || seedWords(value) ? [path] : [];
  if (Array.isArray(value)) {
    if (value.length >= 32 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return [path];
    return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  }
  // A transaction's signature is as long as a key; the spec keeps signatures in fields named "signature" only. A field
  // named for a credential ("apiKey", "privateKey", "mnemonic", …) that holds something is one.
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      k === 'signature' && isSignature(v)
        ? []
        : [...(CREDENTIAL_FIELD.test(k) && filled(v) ? [`${path}.${k}`] : []), ...findSecrets(v, `${path}.${k}`)],
    );
  return [];
}
