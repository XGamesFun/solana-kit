// The exact bytes and texts a results server checks (the public one runs at https://play.xgames.fun/xsolana), shared
// with whoever signs them: a host server, a player's game page, an owner's wallet. Browser-safe: no Node imports.
import { addressBytes } from '../chain/base58.js';
import { concat, fromHex, uintLE, utf8 } from '../chain/bytes.js';

export const RESULT_DOMAIN = 'loot-result-v1';
export const NO_GRANT = 0xffff;
export const CLUSTERS = Object.freeze({ devnet: 0, mainnet: 1 });

/** Each certificate's first line, and the lines that follow it, in order. */
export const CERT_KINDS = Object.freeze({
  host: { title: 'loot host key', fields: ['cluster', 'game', 'host', 'until'] },
  revoke: { title: 'loot revoke host key', fields: ['cluster', 'game', 'host'] },
  draw: { title: 'loot draw', fields: ['cluster', 'game', 'draw', 'engine', 'winners', 'prizes', 'payout', 'identity', 'slug', 'rates'] },
  lock: { title: 'loot draw lock', fields: ['cluster', 'game', 'draw', 'roster', 'players', 'beacon'] },
  entry: { title: 'loot entry', fields: ['cluster', 'game', 'draw'] },
  giveaway: { title: 'loot giveaway host', fields: ['cluster', 'game', 'who', 'slug', 'grant', 'until'] },
  revokeGiveaway: { title: 'loot revoke giveaway host', fields: ['cluster', 'game', 'who'] },
});

/** One field's value, on its own line: a value with a line break in it (which would read as another field) is refused. */
const field = (name, value) => {
  if (/[\r\n]/.test(String(value))) throw new RangeError(`A certificate's ${name} is one line: ${JSON.stringify(String(value))} has a line break.`);
  return value;
};
const write = (kind, values) => [CERT_KINDS[kind].title, ...CERT_KINDS[kind].fields.map((f) => `${f}: ${field(f, values[f])}`)].join('\n');

/** The text the owner signs to let `host` report `game`'s results until `until` (unix seconds). */
export const hostCertText = ({ cluster = 'devnet', game, host, until }) => write('host', { cluster, game, host, until });
/** The text the owner signs to take `host` back. */
export const revokeText = ({ cluster = 'devnet', game, host }) => write('revoke', { cluster, game, host });

/**
 * The text the organizer (the game's owner or authority, or a host key they certified) signs to open a draw: a round
 * whose winners an engine computes from the locked players and a future beacon value. `prizes`: [{ place, grant }];
 * `payout`: 'vouchers' (the server vouches for each winner) or 'list' (the owner writes the winners' list on the grant);
 * `identity`: 'linked' (a play-host sign-in linked to X, one entry a person) or 'wallet' (a wallet's own signature);
 * `slug`: the game's play-host name (its tokens' audience), or '-'; `rates`: the sha256 of the engine's rates (canonical
 * JSON), or 'default'.
 */
export const drawText = ({ cluster = 'devnet', game, draw, engine, winners, prizes = [], payout = 'vouchers', identity = 'linked', slug = '-', rates = 'default' }) =>
  write('draw', { cluster, game, draw, engine, winners, prizes: prizes.length ? prizes.map((p) => `${p.place}:${p.grant}`).join(' ') : 'none', payout, identity, slug, rates });
/** The text the organizer signs to lock a draw's players (`roster`: rosterHash) to a beacon round still to come. */
export const lockText = ({ cluster = 'devnet', game, draw, roster, players, beacon, net = 'quicknet' }) => write('lock', { cluster, game, draw, roster, players, beacon: `${net} ${beacon}` });
/** The text a player's wallet signs to enter a draw (identity 'wallet'). */
export const entryText = ({ cluster = 'devnet', game, draw }) => write('entry', { cluster, game, draw });

/**
 * The text the owner (or authority) signs to appoint a giveaway host: `who` is "x:<X account id>" (the host signs in
 * with that X account through the play host) or a wallet address; their giveaways pay from grant `grant` alone.
 */
export const giveawayHostText = ({ cluster = 'devnet', game, who, slug, grant, until }) => write('giveaway', { cluster, game, who, slug, grant, until });
/** The text the owner (or authority) signs to take a giveaway host back. */
export const revokeGiveawayText = ({ cluster = 'devnet', game, who }) => write('revokeGiveaway', { cluster, game, who });

/** A draw's players, as one hash: each `id<TAB>wallet`, sorted by id, one a line; sha256, hex. */
export async function rosterHash(entries) {
  const text = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => `${e.id}\t${e.wallet}`).join('\n');
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8(text))), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with every object's keys sorted: one text for one value, so its hash means one thing. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The bytes a result's signers sign:
 *   "loot-result-v1" | cluster (1) | game (32) | round (16) | endedAt (u64 LE)
 *   | winners (u8 count; each wallet (32) | place (u8) | grant id (u16 LE, 0xffff: none))
 * Every field has one length, so one set of bytes means one result: an unknown cluster, a round that is not 16 bytes, a
 * place past 255 and more than 255 winners are refused, never written as something else.
 */
export function resultBytes({ cluster = 'devnet', game, round, endedAt, winners }) {
  if (!Object.hasOwn(CLUSTERS, cluster)) throw new RangeError(`Unknown cluster ${JSON.stringify(cluster)}: a result names ${Object.keys(CLUSTERS).join(' or ')}.`);
  const roundAt = typeof round === 'string' && /^[0-9a-f]{32}$/i.test(round) ? fromHex(round) : round instanceof Uint8Array && round.length === 16 ? round : null;
  if (!roundAt) throw new RangeError('A result\'s round is 16 bytes (32 hex characters).');
  if (!Array.isArray(winners) || winners.length > 255) throw new RangeError('A result names at most 255 winners.');
  return concat(
    utf8(RESULT_DOMAIN),
    Uint8Array.of(CLUSTERS[cluster]),
    addressBytes(game),
    roundAt,
    uintLE(BigInt(endedAt), 8),
    Uint8Array.of(winners.length),
    ...winners.map((w) => concat(addressBytes(w.wallet), uintLE(w.place, 1), uintLE(w.grant ?? NO_GRANT, 2))),
  );
}
