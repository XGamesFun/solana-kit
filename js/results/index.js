// `@xgamesfun/solana/results`: what a game uses with a results server, in a host server or in a player's game page.
// Browser-safe: Web Crypto only. `server` is RESULTS_SERVER (the public one, on the games.fun play host), or another
// one's URL. The server confirms who won (from signatures rooted on the chain) and signs grant vouchers; winners claim
// them with js/play (`claimWins`, `claimGrant`). The program pays a wallet each round once, ever, whatever is signed.
//
// A host server (the project's own):
//   const key = await newKey()                     // once; keep key.secret in the server's secret store
//   hostCertText({ game, host: key.address, until })   → the owner signs it in their wallet, once
//   await report({ server, cert, signer: key, game, round: newRound(), endedAt, winners: [{ wallet, place, grant }] })
//
// A host server that pays its winners itself, with no server of ours in the way (the owner names the host key among
// the grant's voucher keys; the program checks every voucher):
//   const voucher = await signVoucher({ signer: key, game, grant: 1, incarnation, wallet, round, now: clusterNow })
//   the winner's page: app.claimGrant('prize', { voucher })
//
// A giveaway host (a player the owner appointed, signed in with the play host; their page):
//   const session = await newKey()
//   await giveaways.open({ server, game, cert: appointment, token, giveaway: newRound(), winners: 3, endsBy, session })
//   … the game is played …
//   await giveaways.report({ server, game, giveaway, session, endedAt, winners: [{ wallet, place }], grant })
import { decodeBase58, encodeBase58 } from '../chain/base58.js';
import { toHex } from '../chain/bytes.js';
import { pda, voucherBytes } from '../client/index.js';
import { canonicalJson, drawText, entryText, lockText, resultBytes, rosterHash } from './wire.js';

export { canonicalJson, CERT_KINDS, CLUSTERS, drawText, entryText, giveawayHostText, hostCertText, lockText, NO_GRANT, RESULT_DOMAIN, resultBytes, revokeGiveawayText, revokeText, rosterHash } from './wire.js';

/** games.fun's results server, on its play host (devnet until the program's audit). */
export const RESULTS_SERVER = 'https://play.xgames.fun/xsolana';

const subtle = () => globalThis.crypto.subtle;
/** A value as a query's value: encoded, so a `&`, `#` or `/` in it is part of the value. */
const q = (value) => encodeURIComponent(String(value));
/**
 * A value as one segment of a URL's path: encoded, so a `/` or `?` in it stays inside the segment. One that is empty,
 * `.` or `..` (which a URL reads as a step up the path, encoded or not) is refused.
 */
const seg = (value) => {
  const text = String(value);
  if (text === '' || text === '.' || text === '..') throw new RangeError(`${JSON.stringify(text)} can't be a part of a path.`);
  return encodeURIComponent(text);
};

/** A fresh round id: 16 random bytes, in hex. Make it when the round starts. */
export const newRound = () => toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/**
 * A fresh Ed25519 key: { address, sign(bytes) → Promise<64 bytes>, secret }. `secret` is its 32-byte seed in base58,
 * for a host server to keep in its secret store; a page's session key never needs it.
 */
export async function newKey() {
  const pair = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  return keyOf(pair.privateKey, base64url(jwk.x), jwk.d);
}

/** The key a host server kept (`secret`: its seed in base58). */
export async function keyFromSecret(secret) {
  const seed = decodeBase58(secret);
  if (seed.length !== 32) throw new Error('A host key secret is 32 bytes in base58.');
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const privateKey = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle().exportKey('jwk', privateKey);
  return keyOf(privateKey, base64url(jwk.x), jwk.d);
}

function keyOf(privateKey, publicBytes, d) {
  return {
    address: encodeBase58(publicBytes),
    secret: encodeBase58(base64url(d)),
    sign: async (message) => new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, message)),
  };
}

function base64url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** One signer's signature of a result: { key, signature }. `signer` is a key from newKey, or anything with sign(). */
export async function signResult(signer, result, cluster = 'devnet') {
  return { key: signer.address, signature: encodeBase58(await signer.sign(resultBytes({ ...result, cluster }))) };
}

/**
 * A host server reports a round. `cert`: the owner's { text, signature } certifying `signer`, the host key. Retrying
 * with the same result is safe: it is the same answer. Returns the server's answer, { result, vouchers }, or throws its
 * { code, why }.
 */
export async function report({ server, cert, signer, game, round, endedAt, winners, cluster = 'devnet', fetchImpl = globalThis.fetch }) {
  const result = { game, round, endedAt, winners };
  const all = [await signResult(signer, result, cluster)];
  const response = await fetchImpl(`${server.replace(/\/$/, '')}/v1/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...result, cert, signatures: all }),
  });
  return answerOf(response);
}

/**
 * A server's answer: its JSON body when the status is a success. Otherwise it throws the server's own { code, why }
 * when the body says them, or the status in words (an HTML error page from a proxy, an empty body).
 */
async function answerOf(response) {
  const answer = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(answer?.error?.why ?? `The results server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`), { code: answer?.error?.code, status: response.status });
  if (answer === null || typeof answer !== 'object') throw Object.assign(new Error(`The results server answered ${response.status} with no JSON.`), { status: response.status });
  return answer;
}

/** A wallet's vouchers for a round it won: [{ grant, publicKey, signature, round, expires, … }]. */
export async function fetchVouchers({ server, game, round, wallet, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${server.replace(/\/$/, '')}/v1/vouchers?game=${q(game)}&round=${q(round)}&wallet=${q(wallet)}`);
  return (await answerOf(response)).vouchers;
}

/**
 * A loot grant voucher the host key signs itself, for a host server whose key the grant names (no results server
 * involved): the program checks it and pays only `wallet`, within the grant's limits. `round` is the result's round id
 * (16 bytes hex): the program pays a wallet each round once, ever, so the voucher may be signed again, any time, and
 * still pays once. `incarnation` is the grant's (`Grant.incarnation`): a voucher pays only the grant it was signed
 * for, never one written again at the same address. `now` is the cluster's clock (unix s); the voucher lives
 * `seconds` from it, 30 days at most. `amount`: the tokens this claim gives, in base units, for a grant of a fixed amount
 * of tokens (a rank's reward), at most the grant's; 0 (the default) gives the grant's prize as it is.
 * Returns { wallet, grant, incarnation, publicKey, signature, round, expires, personHash, amount } for js/play claimGrant,
 * plain JSON (`incarnation` and `amount` as decimal text), so a server can send it as it is.
 */
export async function signVoucher({ signer, game, grant, incarnation, wallet, round, now, seconds = 7 * 86_400, personHash = null, amount = 0n }) {
  if (!(Number(seconds) > 0)) throw new RangeError('A voucher lives some seconds from now (`seconds` above 0): one that has run out already pays nothing.');
  if (Number(seconds) > 30 * 86_400) throw new Error('A voucher lives 30 days at most.');
  // The cluster's clock comes as a number or a bigint (an RPC's, a decoded Clock's); `expires` is a number either way.
  const expires = Math.floor(typeof now === 'bigint' ? Number(now) : now) + Number(seconds);
  if (!Number.isSafeInteger(expires)) throw new RangeError('A voucher needs the cluster\'s clock (`now`, unix seconds).');
  const message = voucherBytes({ grant: pda.grant(game, grant), incarnation, wallet, personHash, round, expires, amount: BigInt(amount) });
  return { wallet, grant, incarnation: String(BigInt(incarnation)), publicKey: signer.address, signature: encodeBase58(await signer.sign(message)), round, expires, personHash: personHash ?? '0'.repeat(64), amount: String(BigInt(amount)) };
}

/** Posts JSON to the server and answers its body, or throws its { code, why }. */
async function post(server, path, body, fetchImpl) {
  const response = await fetchImpl(`${server.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return answerOf(response);
}

/** Gets JSON from the server and answers its body, or throws its { code, why }. */
const fetchJson = async (server, path, fetchImpl) => answerOf(await fetchImpl(`${server.replace(/\/$/, '')}${path}`));

/**
 * A draw, from the organizer's side and the players'. `signMessage(text) → signature bytes` is the organizer's wallet
 * (its signMessage) or a host key's sign; `by` its address; `cert` the owner's host certificate when `by` is a host key.
 */
export const draws = {
  open: async ({ server, signMessage, by, cert = null, rates = null, fetchImpl = globalThis.fetch, ...spec }) => {
    const ratesHash = rates ? Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(rates)))), (b) => b.toString(16).padStart(2, '0')).join('') : 'default';
    const text = drawText({ ...spec, rates: ratesHash });
    return post(server, '/v1/draws', { text, signature: encodeBase58(await signMessage(new TextEncoder().encode(text))), by, ...(cert ? { cert } : {}), ...(rates ? { rates } : {}) }, fetchImpl);
  },
  /** A player enters with their play-host token, or with their wallet's signature (`wallet`, `signMessage`). */
  enter: async ({ server, game, draw, token = null, wallet = null, signMessage = null, cluster = 'devnet', fetchImpl = globalThis.fetch }) => {
    if (token) return post(server, `/v1/draws/${seg(game)}/${seg(draw)}/entries`, { token }, fetchImpl);
    const text = entryText({ cluster, game, draw });
    return post(server, `/v1/draws/${seg(game)}/${seg(draw)}/entries`, { wallet, text, signature: encodeBase58(await signMessage(new TextEncoder().encode(text))) }, fetchImpl);
  },
  /** Locks the players the server holds now to `beacon`, a drand round still to come. Checks their hash itself. */
  lock: async ({ server, game, draw, beacon, signMessage, by, cert = null, cluster = 'devnet', net = 'quicknet', fetchImpl = globalThis.fetch }) => {
    const { draw: view } = await fetchJson(server, `/v1/draws/${seg(game)}/${seg(draw)}`, fetchImpl);
    const text = lockText({ cluster, game, draw, roster: await rosterHash(view.entries), players: view.entries.length, beacon, net });
    return post(server, `/v1/draws/${seg(game)}/${seg(draw)}/lock`, { text, signature: encodeBase58(await signMessage(new TextEncoder().encode(text))), by, ...(cert ? { cert } : {}) }, fetchImpl);
  },
  /** The draw as anyone may check it; settled, with its result, once its beacon round is out. */
  get: async ({ server, game, draw, fetchImpl = globalThis.fetch }) => (await fetchJson(server, `/v1/draws/${seg(game)}/${seg(draw)}`, fetchImpl)).draw,
};

/** A giveaway, from its appointed host's page. */
export const giveaways = {
  /** Opens one: `cert` the owner's appointment, `token` the host's play-host sign-in, `session` a key from newKey(). */
  open: async ({ server, game, cert, token, giveaway, winners, endsBy, session, fetchImpl = globalThis.fetch }) => post(server, `/v1/giveaways/${seg(game)}`, { cert, token, giveaway, winners, endsBy, session: session.address }, fetchImpl),
  /** Reports its result, signed by its session key. `grant`: the host's grant (each winner is paid from it). */
  report: async ({ server, game, giveaway, session, endedAt, winners, grant, cluster = 'devnet', fetchImpl = globalThis.fetch }) => {
    const signed = winners.map((w) => ({ wallet: w.wallet, place: w.place, grant }));
    const signature = encodeBase58(await session.sign(resultBytes({ cluster, game, round: giveaway, endedAt, winners: signed })));
    return post(server, `/v1/giveaways/${seg(game)}/${seg(giveaway)}/result`, { endedAt, winners: winners.map(({ wallet, place }) => ({ wallet, place })), signature }, fetchImpl);
  },
};
