// Reading the loot program's accounts and receipts. Every account starts with a one-byte tag (1 to 26); the IDL
// describes most of them, and the ones it doesn't (a list of records, a lottery round, a sheet, a stash, …) are read
// here by hand. Values come back in the
// IDL's shapes (chain/borsh.js).
import { addressBytes, encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { decodeAccount, decodeBorsh, decodeEvents } from '../chain/borsh.js';
import { compareBytes, concat, readUintLE, toHex, uintLE } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { LOOT_PROGRAM, pda } from './pda.js';
import IDL from './idl/loot.js';

/** Account tags: each account's first byte, as the program writes it. A grant and a profile share 24 (`decodeAny` tells
 * them apart by a profile's shape); every list of records (`decodeList`) is 26. */
export const TAGS = Object.freeze({
  Platform: 1,
  Project: 2,
  Item: 3,
  LootBox: 4,
  Order: 5,
  Schedule: 6,
  Lottery: 7,
  Recipe: 8,
  Hold: 9,
  Contest: 10,
  Sheet: 12,
  Traits: 13,
  LotteryRound: 16,
  Farm: 17,
  Seat: 18,
  Proven: 19,
  Auction: 20,
  Offer: 22,
  Listing: 23,
  Grant: 24,
  Profile: 24,
  // A table, and a stash: a table of NFTs (21 was a stash's own before 0.22).
  Table: 25,
  // A list of records: a wallet's counts, a grant's claims or rounds, a contest's entries.
  List: 26,
});

const BY_TAG = Object.fromEntries(Object.entries(TAGS).filter(([name]) => name !== 'Profile').map(([name, tag]) => [tag, name]));

/** The kind of a loot account from its first byte, or null. Tag 24 is a grant or a profile (`decodeAny` reads which). */
export const accountKind = (data) => (data?.length ? BY_TAG[data[0]] ?? null : null);

/**
 * The records the program writes by hand, as IDL types: a lottery round's header and what it keeps (`LotteryRound`,
 * tag 16), and a contest's entry. The client reads them with the same Borsh codec as any account.
 */
const RECORDS = [
  { name: 'Round', type: { kind: 'enum', variants: ['Open', 'Drawing', 'Drawn', 'Swept', 'Cancelled'].map((name) => ({ name })) } },
  { name: 'TokenPrize', type: { kind: 'struct', fields: [{ name: 'run', type: 'u16' }, { name: 'mint', type: 'pubkey' }, { name: 'each', type: 'u64' }, { name: 'sent', type: 'u64' }, { name: 'arrived', type: 'u64' }, { name: 'minted', type: 'bool' }] } },
  { name: 'Opened', type: { kind: 'struct', fields: [{ name: 'mint', type: 'pubkey' }, { name: 'by', type: 'pubkey' }] } },
  {
    name: 'LotteryRound',
    type: {
      kind: 'struct',
      fields: [
        ['project', 'pubkey'], ['lottery', 'pubkey'], ['id', 'u32'], ['incarnation', 'u64'], ['round', 'u32'], ['bump', 'u8'], ['opener', 'pubkey'], ['head', 'u32'],
        ['status', { defined: { name: 'Round' } }],
        // The terms, as the lottery's revision had them at the round's first purchase; whether its entries keep what
        // arrived (a payment mint with a transfer fee).
        ['revision', 'u32'], ['terms', { defined: { name: 'LotteryTerms' } }], ['fee', 'bool'],
        // The totals, split at each purchase, and what it still owes.
        ['sold', 'u64'], ['to_pot', 'u64'], ['common', { vec: 'u64' }], ['owed_if_cancelled', 'u32'], ['owed_if_drawn', 'u32'], ['owed', 'u32'],
        // The draw, the cursor and the sweep.
        ['asked_first', 'u64'], ['asked_slot', 'u64'], ['answer', { array: ['u8', 32] }], ['first', 'u64'], ['cursor', 'u32'],
        ['pot_total', 'u64'], ['pot_sent', 'u64'], ['pot_arrived', 'u64'], ['paid', 'bytes'],
        ['prizes', { vec: { defined: { name: 'TokenPrize' } } }], ['accounts', { vec: { defined: { name: 'Opened' } } }],
      ].map(([name, type]) => ({ name, type })),
    },
  },
  { name: 'ContestEntry', type: { kind: 'struct', fields: [['player', 'pubkey'], ['side', 'u16'], ['amount', 'u64'], ['bits', 'u8'], ['nft', 'pubkey'], ['place', 'u32'], ['taken', 'u32']].map(([name, type]) => ({ name, type })) } },
];
const IDLX = { ...IDL, types: [...IDL.types, ...RECORDS], accounts: [...IDL.accounts, { name: 'LotteryRound', discriminator: [TAGS.LotteryRound] }] };

/** A loot account of the named kind (one the IDL describes, or a `LotteryRound`). Throws when the data is not one. */
export const decode = (name, data) => decodeAccount(IDLX, name, data);

/** Any loot account: { kind, value }, or null for data that is no loot account. */
export function decodeAny(data) {
  const kind = accountKind(data);
  if (!kind) return null;
  if (kind === 'Grant' && isProfile(data)) return { kind: 'Profile', value: decodeProfile(data) };
  if (kind === 'List') return { kind, value: decodeList(data) };
  if (kind === 'LotteryRound') return { kind, value: decodeRound(data) };
  if (kind === 'Sheet') return { kind, value: decodeSheet(data) };
  if (kind === 'Table') return data[37] === PAYLOAD.Nft ? { kind: 'Stash', value: decodeStash(data) } : { kind, value: decodeTable(data) };
  if (kind === 'Proven') return { kind, value: decodeProven(data) };
  if (kind === 'Traits') return { kind, value: decodeTraits(data) };
  return { kind, value: decode(kind, data) };
}

/** Whether data tagged 24 is a profile's: its attributes end exactly where the data does (a grant's never could). */
function isProfile(data) {
  try {
    return attributesAt(data, 'Profile').end === data.length;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- lists of records (M1)

/**
 * A list of records (tag 26, `list.rs`): { width, records } in their order: a wallet's counts
 * (`["counts", project, wallet]`) and a grant's claims are limit records (28 bytes, `readLimit`), a grant's rounds 16
 * bytes, a contest's entries 43 or 83 (`decodeEntries`).
 */
export function decodeList(data) {
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.List || data.length < 7) throw new Error('Not a list account');
  const width = Number(readUintLE(data, 1, 2));
  const count = Number(readUintLE(data, 3, 4));
  if (!width || data.length !== 7 + width * count) throw new Error('List account does not match its records');
  return { width, records: Array.from({ length: count }, (_, i) => data.subarray(7 + width * i, 7 + width * (i + 1))) };
}

/** The first 16 bytes of the sha256 of `parts` (addresses, bytes or u64s): a record's key in a list. */
export const recordKey16 = (...parts) => sha256(concat(...parts.map((p) => (typeof p === 'string' ? addressBytes(p) : p instanceof Uint8Array ? p : uintLE(p, 8))))).subarray(0, 16);

/** The key of a wallet's count for a box, a recipe (incarnation 0) or a lottery (its incarnation), in its counts. */
export const countKey = (record, incarnation = 0) => recordKey16(record, BigInt(incarnation));

/** What the limit record at `key` counts in a decoded list (`decodeList`, or null for none): { count, window, inWindow }. */
export function readLimit(list, key) {
  const record = list?.records.find((r) => compareBytes(r.subarray(0, 16), key) === 0);
  const n = (i) => (record ? Number(readUintLE(record, 16 + 4 * i, 4)) : 0);
  return { count: n(0), window: n(1), inWindow: n(2) };
}

/** A fetched list account, or null for none (or an empty System account someone sent SOL to, which the program opens
 * as the list). Any other owner or layout is refused. */
export function readListAccount(account) {
  if (account == null) return null;
  if (account.owner === SYSTEM_PROGRAM && account.data instanceof Uint8Array && account.data.length === 0 && !account.executable) return null;
  if (account.owner !== LOOT_PROGRAM || account.executable) throw new Error('The list has an invalid owner.');
  return decodeList(account.data);
}

/**
 * A contest's entries (`["entries", contest, incarnation, 0]`), in the list's order (by player): [{ player, side,
 * amount (0 once paid or refunded; 1 while a contest of NFTs holds its NFT), bits (`CLAIMED`, `ENDED`), nft, place (how
 * many entered its side before it), taken (the losers' NFTs a winner took) }]. A claim names an entry by its index here.
 */
export function decodeEntries(data) {
  const { width, records } = decodeList(data);
  return records.map((r) => {
    const full = new Uint8Array(83);
    full.set(r.subarray(0, Math.min(width, 83)));
    return decodeBorsh(IDLX, { defined: { name: 'ContestEntry' } }, full)[0];
  });
}

/** A winner's first claim came (its prize given or forgone); a winner ended its picks early. */
export const CLAIMED = 1;
export const ENDED = 2;

/** How many losers' NFTs a winner of a contest of NFTs takes: the share fixed at the decision, one more for an early
 * place on its side. */
export const shareOf = (contest, entry) => Number(contest.share) + (Number(entry.place) < Number(contest.extras) ? 1 : 0);

/** What a count allows `n` more of at `now` under `limit` ({ total, per_window, window }, 0 is no limit; a lottery's
 * window is its round plus one, given as `window`). */
export function countAllows(count, limit, now, n = 1, window = Number(limit.window) ? Math.floor(Number(now) / Number(limit.window)) + 1 : 0) {
  const total = (count?.count ?? 0) + n;
  const inWindow = (count && count.window === window ? count.inWindow : 0) + n;
  return (!Number(limit.total) || total <= Number(limit.total)) && (!Number(limit.per_window) || inWindow <= Number(limit.per_window));
}

/**
 * A Sheet (`["sheet", project, nft]`): what the project wrote about an NFT it has no authority over. Returns { project, nft,
 * attributes: [{ key, value }] }. A Sheet never written reads as none: pass `null` data for no account.
 */
export function decodeSheet(data) {
  if (data == null || data.length === 0) return null;
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Sheet || data.length < 69) throw new Error('Not a Sheet account');
  const { attributes, head } = attributesAt(data, 'Sheet');
  return { project: head(1), nft: head(33), attributes };
}

/** A player's profile (`["profile", project, wallet]`): { project, wallet, attributes }, what the project keeps about
 * the wallet (its XP, level, rank). Its layout is a Sheet's, under its own tag. */
export function decodeProfile(data) {
  if (data == null || data.length === 0) return null;
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Profile || data.length < 69) throw new Error('Not a Profile account');
  const { attributes, head } = attributesAt(data, 'Profile');
  return { project: head(1), wallet: head(33), attributes };
}

/** The attributes after a Sheet's or a profile's two addresses, read with every length checked against the data. */
function attributesAt(data, name) {
  let at = 65;
  // Every length is checked against the data: a count or a text longer than what is there is a truncated account.
  const text = () => {
    const n = Number(readUintLE(data, at, 4));
    if (at + 4 + n > data.length) throw new Error(`${name} account is truncated`);
    const value = new TextDecoder().decode(data.subarray(at + 4, at + 4 + n));
    at += 4 + n;
    return value;
  };
  const count = Number(readUintLE(data, at, 4));
  at += 4;
  // Each attribute takes 8 bytes at least (two empty texts).
  if (count * 8 > data.length - at) throw new Error(`${name} account is truncated`);
  const attributes = Array.from({ length: count }, () => ({ key: text(), value: text() }));
  return { attributes, end: at, head: (from) => encodeBase58(data.subarray(from, from + 32)) };
}

/** What a table's rows carry (its payload byte; 128 more marks a committed table). */
export const PAYLOAD = Object.freeze({ Number: 0, Label: 1, Nft: 2 });
const COMMITTED = 0x80;
const TABLE_HEAD = 51;

/** Where row `r` of a table of `len`-byte rows is: groups of 64 blocks of 64 rows, each led by its weight in stock. */
export function tableRowAt(len, r) {
  const block = 8 + 64 * len;
  const group = 8 + 64 * block;
  return TABLE_HEAD + Math.floor(r / 4096) * group + 8 + (Math.floor(r / 64) % 64) * block + 8 + (r % 64) * len;
}

/**
 * A table (`["table", project, id]`, `table.rs`): { project, id, payload ('Number' | 'Label'), committed, sealed,
 * count, total (the weight in stock), rows: [{ weight, left, label }] (none for a committed table), root (hex, a
 * committed table's once sealed) }. A row's `left` is `NO_LIMIT` (4294967295) for a stock that never runs out.
 */
export function decodeTable(data) {
  if (data == null || data.length === 0) return null;
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Table || data.length < TABLE_HEAD) throw new Error('Not a Table account');
  const committed = (data[37] & COMMITTED) !== 0;
  const payload = Object.keys(PAYLOAD).find((k) => PAYLOAD[k] === (data[37] & ~COMMITTED));
  if (!payload || payload === 'Nft') throw new Error('Not a Table account');
  const count = Number(readUintLE(data, 39, 4));
  const head = { project: encodeBase58(data.subarray(1, 33)), id: Number(readUintLE(data, 33, 4)), payload, committed, sealed: data[38] === 1, count, total: readUintLE(data, 43, 8) };
  if (committed) return { ...head, rows: [], root: head.sealed ? toHex(data.subarray(TABLE_HEAD, TABLE_HEAD + 32)) : null };
  const len = payload === 'Label' ? 40 : 8;
  if (count && tableRowAt(len, count - 1) + len > data.length) throw new Error('Table account is truncated');
  const rows = Array.from({ length: count }, (_, r) => {
    const at = tableRowAt(len, r);
    const label = payload === 'Label' ? new TextDecoder().decode(data.subarray(at + 8, at + 40)).replace(/\0+$/, '') : '';
    return { weight: Number(readUintLE(data, at, 4)), left: Number(readUintLE(data, at + 4, 4)), label };
  });
  return { ...head, rows, root: null };
}

/** A stash (`["stash", project, id]`, or a lottery's own): { project, id, nfts, weights }, the NFTs the project holds to
 * give away and the weight each is drawn by, as a table of NFTs keeps them (a row: its weight, then the NFT). */
export function decodeStash(data) {
  if (data == null || data.length === 0) return null;
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Table || data[37] !== PAYLOAD.Nft || data.length < TABLE_HEAD) throw new Error('Not a Stash account');
  const count = Number(readUintLE(data, 39, 4));
  if (count && tableRowAt(36, count - 1) + 36 > data.length) throw new Error('Stash account is truncated');
  const rows = Array.from({ length: count }, (_, r) => tableRowAt(36, r));
  return { project: encodeBase58(data.subarray(1, 33)), id: Number(readUintLE(data, 33, 4)), nfts: rows.map((at) => encodeBase58(data.subarray(at + 4, at + 36))), weights: rows.map((at) => Number(readUintLE(data, at, 4))) };
}

/**
 * A compressed NFT's record (`["leaf", asset]`, `prove_leaf`): { asset, tree, owner (null once burned), delegate,
 * collection (or null), flags, nonce, root (hex: the tree's root it holds for), payer }. Routes read it only while the
 * tree's root is still `root`; after that anyone may close it (`closeLeafIx`).
 */
export function decodeProven(data) {
  // Its shortest: the tag, five addresses, the root, data hash and creator hash, no asset data hash, the flags and
  // nonce, and its payer.
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Proven || data.length < 1 + 32 * 8 + 1 + 1 + 8 + 32) throw new Error('Not a Proven account');
  const key = (at) => encodeBase58(data.subarray(at, at + 32));
  const none = (k) => (k === NO_ADDRESS ? null : k);
  const root = 1 + 32 * 5;
  let at = root + 32 * 3; // the five addresses, then the root, data hash and creator hash
  if (data[at] !== 0 && data[at] !== 1) throw new Error('Proven account has an unknown asset data hash flag');
  at += data[at] === 1 ? 33 : 1; // the asset data hash
  // With an asset data hash, the flags, nonce and payer come 32 bytes later: the account must hold them too.
  if (at + 1 + 8 + 32 > data.length) throw new Error('Proven account is truncated');
  const flags = data[at];
  return {
    asset: key(1), tree: key(33), owner: none(key(65)), delegate: none(key(97)), collection: none(key(129)),
    flags, nonce: readUintLE(data, at + 1, 8), root: toHex(data.subarray(root, root + 32)), payer: key(at + 9),
  };
}

/** The traits a project vouches for (`["traits", project, key]`): { project, key, root (hex) }. */
export function decodeTraits(data) {
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Traits || data.length < 97) throw new Error('Not a Traits account');
  return { project: encodeBase58(data.subarray(1, 33)), key: encodeBase58(data.subarray(33, 65)), root: toHex(data.subarray(65, 97)) };
}

/**
 * A Token Metadata account (`MetadataV1`), read as far as a farm needs: { mint, collection (the one it is verified
 * in, or null), programmable (a pNFT), ruleSet (a pNFT's, or null) }. Null for anything else. Older accounts end
 * early: what is not there reads as none.
 */
export function decodeTokenMetadata(data) {
  if (!(data instanceof Uint8Array) || data[0] !== 4) return null;
  let at = 33;
  const key = () => encodeBase58(data.subarray(at, (at += 32)));
  const skip = (n) => (at += n);
  const str = () => skip(4 + Number(readUintLE(data, at, 4)));
  const some = () => at < data.length && data[at++] === 1;
  const mint = key();
  str(), str(), str(), skip(2);
  if (some()) skip(34 * Number(readUintLE(data, at, 4)) + 4);
  skip(2);
  if (some()) skip(1); // edition nonce
  const programmable = some() && [4, 5].includes(data[at++]); // a pNFT, or a pNFT's print
  let collection = null;
  if (some()) {
    const verified = data[at++] === 1;
    const address = key();
    if (verified) collection = address;
  }
  if (some()) skip(17); // uses
  if (some()) skip(9); // collection details
  let ruleSet = null;
  if (some()) {
    skip(1); // ProgrammableConfig::V1
    if (some()) ruleSet = key();
  }
  return { mint, collection, programmable, ruleSet };
}

// ---------------------------------------------------------------- a lottery's rounds (M3)
//
// A round is a record of its own (`pda.round`), opened by its first purchase: a header with a copy of the terms, the
// totals, what it still owes and the draw, then one entry a purchase. `settle_round` gives the places' prizes and
// sweeps; `pull` pays one part of one entry; the pull that leaves nothing owed closes it.

/** An entry's word: its tickets' end in the low 48 bits, then a bit a part paid (its own the top one). */
const END_BITS = (1n << 48n) - 1n;
export const OWN_PAID = 1n << 63n;
/** The bit of an entry's `k`th recipient's part. */
export const sharePaid = (k) => 1n << BigInt(62 - k);

/** The mint a lottery's tickets are paid in (`terms`: a Lottery's or a round's): its ticket mint, burned, or its pot's. */
export const paymentMint = (terms) => (ticketsBurn(terms) ? terms.ticket_mint : terms.mint);
/** Whether a lottery's tickets are burned: they are paid in a ticket mint of its own. */
export const ticketsBurn = (terms) => Boolean(terms.ticket_mint) && terms.ticket_mint !== NO_ADDRESS;

/** A share each buyer's own entry names a wallet for: their choice, or whoever holds a collectible then. */
export const perBuyer = (share) => Boolean(share.to?.Chosen || share.to?.Holder);

/** The bytes of one entry of a round: buyer, word, what arrived (a fee mint), a wallet a recipient, the NFT ticket. */
export const entryWidth = (shares, fee, nft) => 40 + (fee ? 8 : 0) + 32 * shares.filter(perBuyer).length + (nft ? 32 : 0);

/**
 * A lottery round (`["round", lottery, incarnation, round]`): its header (`status` 'Open' | 'Drawing' | 'Drawn' | 'Swept' |
 * 'Cancelled', the terms it copied, `sold`, `owed`, the draw, the cursor and the sweep), and `entries`, one a purchase:
 * { buyer, start, end (its tickets), paid (the bits of its parts paid), amount, to (a wallet for each recipient share,
 * the default address for none), nft (its NFT ticket) }.
 */
export function decodeRound(data) {
  const r = decode('LotteryRound', data);
  const at = Number(r.head);
  const width = Number(readUintLE(data, at, 2));
  const count = Number(readUintLE(data, at + 2, 4));
  if (width !== entryWidth(r.terms.shares, r.fee, r.terms.nft_ticket != null) || data.length !== at + 6 + width * count) throw new Error('LotteryRound entries do not match its header');
  const recipients = r.terms.shares.filter(perBuyer).length;
  let start = 0n;
  const entries = Array.from({ length: count }, (_, i) => {
    const e = data.subarray(at + 6 + width * i, at + 6 + width * (i + 1));
    const word = readUintLE(e, 32, 8);
    const end = word & END_BITS;
    let k = 40;
    const take = (n) => e.subarray((k += n) - n, k);
    const amount = r.fee ? readUintLE(take(8), 0, 8) : (end - start) * BigInt(r.terms.price);
    const to = Array.from({ length: recipients }, () => encodeBase58(take(32)));
    const entry = { buyer: encodeBase58(e.subarray(0, 32)), start, end, paid: word & ~END_BITS, amount, to, nft: r.terms.nft_ticket ? encodeBase58(take(32)) : NO_ADDRESS };
    start = end;
    return entry;
  });
  return { ...r, entries };
}

/** How many places a lottery's (or a round's) `places` are, every run counted (`Place.times`). */
export const placeCount = (places) => places.reduce((n, p) => n + Number(p.times ?? 1), 0);

/** The places of a round that have a winner: every place, but no more than tickets. */
export const roundWinners = (r) => Math.min(placeCount(r.terms.places), Number(r.sold));

/** The ticket that wins `place` of a drawn round: even steps around the list from first place's ticket. */
export function ticketOfPlace(r, place) {
  const sold = BigInt(r.sold);
  const ahead = BigInt(place) * (sold / BigInt(roundWinners(r) || 1));
  const toEnd = sold - BigInt(r.first);
  return ahead < toEnd ? BigInt(r.first) + ahead : ahead - toEnd;
}

/** The run of places that holds `place`, and its first place. */
export function runOf(r, place) {
  let first = 0;
  for (let run = 0; run < r.terms.places.length; run++) {
    if (place < first + Number(r.terms.places[run].times)) return [run, first];
    first += Number(r.terms.places[run].times);
  }
  return [r.terms.places.length, first];
}

/** The places of run `run` with a winner: [first, end). */
export function runPlaces(r, run) {
  const first = placeCount(r.terms.places.slice(0, run));
  const w = roundWinners(r);
  return [Math.min(first, w), Math.min(first + Number(r.terms.places[run].times), w)];
}

/** The places of run `run` whose ticket is in `start..end` (an entry's), in order. */
export function placesIn(r, run, start, end) {
  const [from, to] = runPlaces(r, run);
  const out = [];
  if (from >= to || BigInt(start) >= BigInt(end)) return out;
  const sold = BigInt(r.sold);
  const step = sold / BigInt(roundWinners(r));
  const d = (BigInt(start) + sold - BigInt(r.first)) % sold;
  const len = BigInt(end) - BigInt(start);
  for (const [a, b] of [[d, d + len < sold ? d + len : sold], [0n, d + len > sold ? d + len - sold : 0n]]) {
    let p = Number((a + step - 1n) / step);
    for (p = Math.max(p, from); p < to && BigInt(p) * step < b; p++) out.push(p);
  }
  return out.sort((x, y) => x - y);
}

/** What one place of a pass-through amount takes: `clamp(sent − before, 0, amount) × arrived / sent` (none of nothing sent). */
const through = (sent, arrived, before, amount) => {
  if (sent === 0n) return 0n;
  const part = sent > before ? (sent - before < amount ? sent - before : amount) : 0n;
  return (part * arrived) / sent;
};

/**
 * What place `place` (counted from the first place of `runs`) takes of a pass-through amount, as the program splits it:
 * runs of `[a, n]` (n places taking `a` each), `sent` what the places are owed and `arrived` what the round holds for
 * them; the last place with a part takes what the others leave.
 */
export function splitPart(runs, sent, arrived, place) {
  [sent, arrived] = [BigInt(sent), BigInt(arrived)];
  let [c, at, last, paid, before] = [0n, 0, null, 0n, 0n];
  for (const [a, n] of runs) {
    const m = a === 0n ? 0 : Math.min(Number((sent > c ? sent - c + a - 1n : 0n) / a), n);
    if (m > 0) {
      const full = through(sent, arrived, 0n, a);
      [last, before] = [at + m - 1, paid + BigInt(m - 1) * full];
      paid = before + through(sent, arrived, c + BigInt(m - 1) * a, a);
    }
    [c, at] = [c + a * BigInt(n), at + n];
  }
  if (last === place) return arrived > before ? arrived - before : 0n;
  [c, at] = [0n, 0];
  for (const [a, n] of runs) {
    if (place < at + n) return through(sent, arrived, c + BigInt(place - at) * a, a);
    [c, at] = [c + a * BigInt(n), at + n];
  }
  return 0n;
}

/** A share in basis points of an amount, rounded down. */
const bpsOf = (amount, bps) => (BigInt(amount) * BigInt(bps)) / 10_000n;

/** Whether place `place`'s part (its pot part, or with `prize` its token prize) is paid. */
const placePaid = (r, place, prize) => {
  const at = 2 * place + (prize ? 1 : 0);
  return Boolean((r.paid[at >> 3] ?? 0) & (1 << (at & 7)));
};

/** What entry `i`'s places in run `run` take now and are not paid yet, of its pot part or (`prize`) its token prize. */
export function placesOwed(r, i, run, prize) {
  const e = r.entries[i];
  const k = prize ? r.prizes.findIndex((p) => Number(p.run) === run) : -1;
  if (prize && k < 0) return 0n;
  const runs = k >= 0
    ? [[BigInt(r.prizes[k].each), runPlaces(r, run)[1] - runPlaces(r, run)[0]]]
    : r.terms.places.map((p, j) => [bpsOf(r.pot_total, p.bps), runPlaces(r, j)[1] - runPlaces(r, j)[0]]);
  const [sent, arrived, from] = k >= 0 ? [r.prizes[k].sent, r.prizes[k].arrived, runPlaces(r, run)[0]] : [r.pot_sent, r.pot_arrived, 0];
  return placesIn(r, run, e.start, e.end).filter((p) => !placePaid(r, p, prize)).reduce((sum, p) => sum + splitPart(runs, sent, arrived, p - from), 0n);
}

/**
 * The parts entry `i` of a round is owed now, in the order a keeper pulls them (`pullIx`'s `part`): its own ('Own': a
 * refund, a no-loss ticket's price, its NFT ticket back or where its price sends it), each recipient's
 * ({ Share: [k] }), and with `places`, its places' parts of the pot ({ Pot: [run] }) and token prizes ({ Prize: [run] }).
 */
export function partsOwed(r, i, { places = true } = {}) {
  const e = r.entries[i];
  const parts = [];
  const drawn = r.status === 'Drawn' || r.status === 'Swept';
  const back = r.status === 'Cancelled' || (r.terms.returns && drawn);
  const nft = e.nft !== NO_ADDRESS;
  if ((e.amount > 0n || nft) && (back || (nft && drawn)) && !(e.paid & OWN_PAID)) parts.push('Own');
  if (drawn && !r.terms.returns && !ticketsBurn(r.terms)) {
    const bps = r.terms.shares.filter(perBuyer).map((s) => s.bps);
    e.to.forEach((wallet, k) => {
      if (wallet !== NO_ADDRESS && bpsOf(e.amount, bps[k]) > 0n && !(e.paid & sharePaid(k))) parts.push({ Share: [k] });
    });
  }
  if (!places) return parts;
  for (let run = 0; run < r.terms.places.length; run++) {
    const prizeReady = r.status === 'Swept' || (r.status === 'Drawn' && r.cursor >= runPlaces(r, run)[1]);
    if (r.status === 'Swept' && placesOwed(r, i, run, false) > 0n) parts.push({ Pot: [run] });
    if (prizeReady && placesOwed(r, i, run, true) > 0n) parts.push({ Prize: [run] });
  }
  return parts;
}

/** The entry of a round holding `ticket`. */
export const entryOf = (r, ticket) => r.entries.findIndex((e) => e.start <= BigInt(ticket) && BigInt(ticket) < e.end);

/** Whether a round is done and owes nothing: the next step closes it, given its close's accounts. */
export const roundFinished = (r) => (r.status === 'Swept' || r.status === 'Cancelled') && Number(r.owed) === 0;

/** Whether a lottery's place wins something: a share of the pot, a prize, or both. */
export const placeSet = (place) => Number(place.bps) > 0 || place.prize != null;

/** The address of a lottery's current round's record (there or not). */
export const roundAddress = (lotteryAddress, lottery) => pda.round(lotteryAddress, lottery.incarnation, lottery.round);

/**
 * Who rents a listed NFT at `now` (Unix seconds), from its decoded Listing (or null for none): the renter's wallet while
 * a rental runs, else null (a sale listing, or a rental that is over).
 */
export function renterOf(listing, now) {
  if (!listing || !listing.deal?.Rent) return null;
  return BigInt(now) < BigInt(listing.until) && listing.user !== SYSTEM_PROGRAM ? listing.user : null;
}

/**
 * How many runs of a schedule are due at `now` (Unix seconds, the chain's clock, never the computer's). One
 * `run_schedule` makes them all (up to its `upto`, the runs made after it: `schedule.runs` plus these), and a long
 * backlog takes a few calls. A sealed schedule past its last run is due once whenever its vault holds something
 * (`vaultBalance`), which goes where it always went.
 */
export function runsDue(schedule, now, vaultBalance = 0n) {
  const runs = Number(schedule.runs), max = Number(schedule.max_runs);
  if (max > 0 && runs >= max) return schedule.action?.from?.Vest && BigInt(vaultBalance) > 0n ? 1 : 0;
  if (!schedule.active || BigInt(now) < BigInt(schedule.next_at)) return 0;
  const due = Number((BigInt(now) - BigInt(schedule.next_at)) / BigInt(schedule.every)) + 1;
  return max > 0 ? Math.min(due, max - runs) : due;
}

// ---------------------------------------------------------------- receipts

/**
 * The receipts (Anchor events) of a transaction that succeeded: [{ name, data }]. Pass what getTransaction returns
 * (`{ meta: { err, logMessages } }`), or the logs and the transaction's `meta.err`. Success is `meta.err === null` and
 * nothing else: a transaction can fail after every instruction logged success (the runtime's rent check, for one),
 * and its logs still hold every receipt, so a transaction with an error gives none. A backend delivers from a
 * finalized transaction's receipts, once per order or reference.
 */
export function receipts(tx, err) {
  if (Array.isArray(tx)) {
    if (err === undefined) throw new Error("loot.receipts(logs, err) needs the transaction's meta.err (null when it succeeded): a failed transaction keeps its logs");
    return err === null ? decodeEvents(IDL, tx) : [];
  }
  const meta = tx?.meta;
  if (!meta || meta.err === undefined) throw new Error('loot.receipts(tx) needs the transaction getTransaction returns, with its meta.err and meta.logMessages');
  return meta.err === null ? decodeEvents(IDL, meta.logMessages ?? []) : [];
}

/** The program's errors by code: { code: { name, msg } }. */
export const ERRORS = Object.freeze(Object.fromEntries(IDL.errors.map((e) => [e.code, { name: e.name, msg: e.msg }])));

/**
 * The loot error in a failed transaction's logs ("custom program error: 0x…", or Anchor's "Error Code: …" line), or
 * null. Only loot's own: another program the transaction calls (Bubblegum, the VRF program, …) has codes of its own
 * that may be the same numbers, so an error is loot's only when loot is the program that logged it or failed with it.
 * The first program that fails is where the error came from; the programs that called it fail after it with the same
 * code.
 */
export function lootError(logs) {
  const running = [];
  for (const line of logs ?? []) {
    const invoked = /^Program (\w+) invoke \[\d+\]/.exec(line);
    if (invoked) {
      running.push(invoked[1]);
      continue;
    }
    const failed = /^Program (\w+) failed: (.*)$/.exec(line);
    if (failed) {
      if (failed[1] !== LOOT_PROGRAM) return null;
      const m = /custom program error: 0x([0-9a-f]+)/i.exec(failed[2]);
      const code = m ? parseInt(m[1], 16) : null;
      return code !== null && ERRORS[code] ? { code, ...ERRORS[code] } : null;
    }
    if (/^Program (\w+) success/.test(line)) {
      running.pop();
      continue;
    }
    // A line that names no program (a log line, or an error's own text) is the running program's, when it is known.
    if (running.length && running.at(-1) !== LOOT_PROGRAM) continue;
    const named = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/.exec(line);
    if (named) return { code: Number(named[2]), name: named[1], msg: named[3] };
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(line);
    if (m && ERRORS[parseInt(m[1], 16)]) return { code: parseInt(m[1], 16), ...ERRORS[parseInt(m[1], 16)] };
  }
  return null;
}
