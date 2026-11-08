// What a game's server checks before it pays or grants anything: which of the game's collectibles a wallet holds,
// that a wallet's owner signed a proof (a sign-in, a link to a player), and promo codes with keys nobody can guess.
// Browser-safe (Web Crypto and fetch only), so a Cloudflare Worker, a Node server or a page can use it alike; the
// page's own answers are never trusted for what a server pays.
//
//   const mine = await collectiblesOf({ rpc: RPC_URL, spec, wallet })       // [{ asset, item, name, attributes, … }]
//   if (await holds({ rpc: RPC_URL, spec, wallet, item: 'pass' })) …        // a perk for holders
//
//   const ask = proofRequest({ game, wallet, purpose: 'link to player 42' }) // the server keeps ask.nonce until ask.expires
//   … the page has the wallet sign ask.text (signMessage) and sends back the signature …
//   const proof = await verifyProof({ text: ask.text, signature, wallet, game, purpose: 'link to player 42' })
//
//   const codes = makeCodes(50)                                 // print these on flyers; keep them out of the repository
//   spec.grants[i].keys = await codeAddresses(codes)            // only public keys go in the spec
//   const voucher = await codeVoucher({ code, game, grant: 3, incarnation, wallet, now })  // the player typed `code`
import { decodeBase58, encodeBase58, isAddress } from '../chain/base58.js';
import { toHex, utf8 } from '../chain/bytes.js';
import { MPL_CORE_PROGRAM, ownedAssetFilters, parseCoreAsset } from '../chain/core.js';
import { rpcClient } from '../chain/rpc.js';
import { sha256 } from '../chain/sha256.js';
import { signVoucher } from './index.js';

const subtle = () => globalThis.crypto.subtle;
const rpcOf = rpc => (typeof rpc === 'string' ? rpcClient(rpc) : rpc);

// ---------------------------------------------------------------- what a wallet holds

/**
 * The game's collectibles `wallet` holds now, read from the chain (Metaplex Core assets of the live spec's collection
 * and of the collections it names): [{ asset, item (its key in the spec, or null), itemId, name, uri, attributes,
 * frozen }]. `rpc`: an RPC link or a `rpcClient`. Token Metadata and compressed NFTs are not read here.
 */
export async function collectiblesOf({ rpc, spec, wallet }) {
  if (!isAddress(wallet)) throw new Error('Name the wallet (its public address).');
  const collections = [spec?.live?.collection, ...(spec?.collections ?? [])].filter(Boolean);
  if (!collections.length)
    throw new Error('The spec names no collection: put it live first (its live section names the collection).');
  const keyOf = new Map((spec.items ?? []).filter(it => Number.isInteger(it.id)).map(it => [it.id, it.key]));
  const client = rpcOf(rpc);
  const found = (
    await Promise.all(collections.map(c => client.programAccounts(MPL_CORE_PROGRAM, ownedAssetFilters(wallet, c))))
  ).flat();
  return found.map(({ pubkey, account }) => {
    const a = parseCoreAsset(account.data);
    const itemId = a.attributes?.item_id !== undefined ? Number(a.attributes.item_id) : null;
    return { asset: pubkey, ...a, itemId, item: itemId === null ? null : (keyOf.get(itemId) ?? null) };
  });
}

/**
 * Whether `wallet` holds at least `atLeast` of the game's collectible `item` (its key in the spec), or of any of the
 * game's collectibles when `item` is left out. With `attribute`, only those whose number under it is at least
 * `minimum` count (a level, a rarity). → the count it holds when that is enough, else 0.
 */
export async function holds({ rpc, spec, wallet, item = null, atLeast = 1, attribute = null, minimum = 0 }) {
  const mine = (await collectiblesOf({ rpc, spec, wallet })).filter(
    c =>
      (item === null || c.item === item) && (attribute === null || Number(c.attributes?.[attribute] ?? 0) >= minimum),
  );
  return mine.length >= atLeast ? mine.length : 0;
}

// ---------------------------------------------------------------- a wallet's signed proof

const PROOF_TITLE = 'loot wallet proof';
const PROOF_FIELDS = ['cluster', 'game', 'wallet', 'purpose', 'nonce', 'expires'];
const oneLine = (name, value) => {
  if (/[\r\n]/.test(String(value))) throw new RangeError(`A proof's ${name} is one line.`);
  return String(value);
};

/** The exact text a wallet signs to prove it is its owner's: fixed lines, so nothing else can be passed off as it. */
export const proofText = ({ cluster = 'devnet', game, wallet, purpose, nonce, expires }) =>
  [
    PROOF_TITLE,
    ...PROOF_FIELDS.map(f => `${f}: ${oneLine(f, { cluster, game, wallet, purpose, nonce, expires }[f])}`),
    '',
    'Signing this moves nothing.',
  ].join('\n');

/**
 * A proof to ask of `wallet`, made by the server: { text, nonce, expires }. The server keeps `nonce` until `expires`
 * (unix seconds, `seconds` from now) and takes each nonce once, so a signed proof can't be replayed.
 */
export function proofRequest({
  cluster = 'devnet',
  game,
  wallet,
  purpose = 'sign in',
  seconds = 300,
  now = Math.floor(Date.now() / 1000),
}) {
  if (!isAddress(wallet)) throw new Error('Name the wallet (its public address).');
  const nonce = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const expires = Math.floor(now) + Math.floor(seconds);
  return { text: proofText({ cluster, game, wallet, purpose, nonce, expires }), nonce, expires };
}

/** A proof text's fields, or null when it is not one. */
export function readProof(text) {
  const lines = String(text).split('\n');
  if (
    lines[0] !== PROOF_TITLE ||
    lines.length !== PROOF_FIELDS.length + 3 ||
    lines.at(-1) !== 'Signing this moves nothing.'
  )
    return null;
  const out = {};
  for (const [i, f] of PROOF_FIELDS.entries()) {
    const prefix = `${f}: `;
    if (!lines[i + 1].startsWith(prefix)) return null;
    out[f] = lines[i + 1].slice(prefix.length);
  }
  out.expires = Number(out.expires);
  return out;
}

/**
 * Checks a wallet's signed proof: the text is a proof for this `game` (and `purpose`, when given), for `wallet`, not
 * expired at `now`, and `signature` (base58, or 64 bytes) is that wallet's Ed25519 signature of it. → the proof's
 * fields ({ wallet, nonce, expires, … }), or throws in words. Taking each nonce once is the caller's: check
 * `fields.nonce` against the ones the server handed out and not yet used.
 */
export async function verifyProof({
  text,
  signature,
  wallet,
  game,
  purpose = null,
  cluster = 'devnet',
  now = Math.floor(Date.now() / 1000),
}) {
  const fields = readProof(text);
  if (!fields) throw new Error('That is not a wallet proof.');
  if (fields.cluster !== cluster) throw new Error(`The proof is for ${fields.cluster}, not ${cluster}.`);
  if (game !== undefined && fields.game !== String(game)) throw new Error('The proof is for another game.');
  if (wallet !== undefined && fields.wallet !== wallet) throw new Error('The proof names another wallet.');
  if (purpose !== null && fields.purpose !== purpose) throw new Error('The proof is for something else.');
  if (!(fields.expires > now)) throw new Error('The proof has expired: ask for a new one.');
  const sig = typeof signature === 'string' ? decodeBase58(signature) : Uint8Array.from(signature ?? []);
  if (sig.length !== 64) throw new Error('A signature is 64 bytes.');
  const key = await subtle().importKey('raw', decodeBase58(fields.wallet), { name: 'Ed25519' }, false, ['verify']);
  if (!(await subtle().verify({ name: 'Ed25519' }, key, sig, utf8(text))))
    throw new Error("The signature is not that wallet's.");
  return fields;
}

// ---------------------------------------------------------------- promo codes

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_DOMAIN = 'loot-promo-code-v1';

/**
 * `n` fresh promo codes, each `bits` of randomness (80 by default, 16 characters of Crockford base32, in groups of 4).
 * A code's key is in the spec for anyone to read, so a short code can be found by trying them all offline: fewer than
 * 64 bits is refused.
 */
export function makeCodes(n, { bits = 80, group = 4 } = {}) {
  if (!(bits >= 64))
    throw new RangeError(
      'A promo code needs at least 64 bits (80 by default): its key is public, so a short code can be guessed offline.',
    );
  const chars = Math.ceil(bits / 5);
  return Array.from({ length: n }, () => {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(chars));
    const text = Array.from(bytes, b => CROCKFORD[b & 31]).join('');
    return group ? text.match(new RegExp(`.{1,${group}}`, 'g')).join('-') : text;
  });
}

/** A code as typed, read the forgiving way (Crockford): case, spaces and dashes don't matter, O reads 0, I and L read 1. */
export const normalizeCode = code =>
  String(code).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

/** The key a code stands for: { address, sign } (Ed25519, its seed sha256 of the domain and the code). */
export async function codeKey(code, { domain = CODE_DOMAIN } = {}) {
  const normalized = normalizeCode(code);
  if (!normalized || [...normalized].some(c => !CROCKFORD.includes(c))) throw new Error('That is not a code.');
  const seed = sha256(utf8(`${domain}\n${normalized}`));
  const pkcs8 = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20,
    ...seed,
  ]);
  const privateKey = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle().exportKey('jwk', privateKey);
  const raw = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
  return {
    address: encodeBase58(raw),
    sign: async message => new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, message)),
  };
}

/** The public keys for a grant's `keys`, one per code, in order. */
export const codeAddresses = async (codes, options) =>
  Promise.all(codes.map(async c => (await codeKey(c, options)).address));

/**
 * A voucher a typed code signs for `wallet` (the page, or a server, makes it): the grant pays it once per code with
 * `limits.perKey: 1`. Its round is the code's own, so one wallet can't use one code twice either. `incarnation` is the
 * grant's, read from the chain; `now` the cluster's clock.
 */
export async function codeVoucher({
  code,
  game,
  grant,
  incarnation,
  wallet,
  now,
  seconds = 86_400,
  domain = CODE_DOMAIN,
}) {
  const key = await codeKey(code, { domain });
  const round = toHex(sha256(utf8(`${domain}\nround\n${key.address}`))).slice(0, 32);
  return signVoucher({ signer: key, game, grant, incarnation, wallet, round, now, seconds });
}
