// Reading the loot program's accounts and receipts. Every account starts with a one-byte tag (1 to 23); the IDL
// describes most of them, and the ones it doesn't (a receipt, a sheet, a stash, …) are read here by hand. Values come back in the
// IDL's shapes (chain/borsh.js).
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { decodeAccount, decodeEvents } from '../chain/borsh.js';
import { compareBytes, fromHex, readUintLE, toHex } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { LOOT_PROGRAM } from './pda.js';
import IDL from './idl/loot.js';
import { MAX_RECEIPT_ROUNDS, RECEIPT_BASE_BYTES, RECEIPT_ROUND_BYTES } from './sizes.js';
export { MAX_RECEIPT_ROUNDS } from './sizes.js';

/** Account tags: each account's first byte, as the program writes it. */
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
  Entry: 11,
  Sheet: 12,
  Traits: 13,
  Grant: 14,
  Receipt: 15,
  LotteryContribution: 16,
  Farm: 17,
  Seat: 18,
  Proven: 19,
  Auction: 20,
  Stash: 21,
  Offer: 22,
  Listing: 23,
});

const BY_TAG = Object.fromEntries(Object.entries(TAGS).map(([name, tag]) => [tag, name]));

/** The kind of a loot account from its first byte, or null. */
export const accountKind = (data) => (data?.length ? BY_TAG[data[0]] ?? null : null);

/** A loot account of the named kind (one the IDL describes). Throws when the data is not one. */
export const decode = (name, data) => decodeAccount(IDL, name, data);

/** Any loot account: { kind, value }, or null for data that is no loot account. */
export function decodeAny(data) {
  const kind = accountKind(data);
  if (!kind) return null;
  if (kind === 'Receipt') return { kind, value: decodeReceipt(data) };
  if (kind === 'Sheet') return { kind, value: decodeSheet(data) };
  if (kind === 'Proven') return { kind, value: decodeProven(data) };
  if (kind === 'Traits') return { kind, value: decodeTraits(data) };
  if (kind === 'Stash') return { kind, value: decodeStash(data) };
  return { kind, value: decode(kind, data) };
}

/**
 * A counter (a Receipt): a wallet's on a box, a lottery, a recipe or a grant, a person's or a key's on
 * a grant. { count (lifetime where tracked), window (the window `inWindow` counts), inWindow, rounds (the first 8
 * bytes of sha256 of each round a grant paid it, by voucher or list, in order), claimed(round) }. A round it holds
 * was paid once and can never be paid again.
 */
export function decodeReceipt(data) {
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Receipt || data.length < RECEIPT_BASE_BYTES) throw new Error('Not a Receipt account');
  const n = Number(readUintLE(data, RECEIPT_BASE_BYTES - 4, 4));
  if (n > MAX_RECEIPT_ROUNDS) throw new Error('Receipt history exceeds the supported capacity');
  if (data.length !== RECEIPT_BASE_BYTES + RECEIPT_ROUND_BYTES * n) throw new Error('Receipt length does not match its rounds');
  const rounds = Array.from({ length: n }, (_, i) => data.slice(RECEIPT_BASE_BYTES + RECEIPT_ROUND_BYTES * i, RECEIPT_BASE_BYTES + RECEIPT_ROUND_BYTES * (i + 1)));
  if (rounds.some((round, i) => i > 0 && compareBytes(rounds[i - 1], round) >= 0)) throw new Error('Receipt rounds must be unique and sorted');
  const ids = new Set(rounds.map((r) => toHex(r)));
  const claimed = (round) => ids.has(toHex(sha256(typeof round === 'string' ? fromHex(round) : Uint8Array.from(round)).subarray(0, 8)));
  return {
    count: Number(readUintLE(data, 1, 4)),
    window: Number(readUintLE(data, 5, 4)),
    inWindow: Number(readUintLE(data, 9, 4)),
    rounds,
    claimed,
  };
}

/**
 * A Sheet (`["sheet", project, nft]`): what the project wrote about an NFT it has no authority over. Returns { project, nft,
 * attributes: [{ key, value }] }. A Sheet never written reads as none: pass `null` data for no account.
 */
export function decodeSheet(data) {
  if (data == null || data.length === 0) return null;
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Sheet || data.length < 69) throw new Error('Not a Sheet account');
  let at = 65;
  // Every length is checked against the data: a count or a text longer than what is there is a truncated account.
  const text = () => {
    const n = Number(readUintLE(data, at, 4));
    if (at + 4 + n > data.length) throw new Error('Sheet account is truncated');
    const value = new TextDecoder().decode(data.subarray(at + 4, at + 4 + n));
    at += 4 + n;
    return value;
  };
  const count = Number(readUintLE(data, at, 4));
  at += 4;
  // Each attribute takes 8 bytes at least (two empty texts).
  if (count * 8 > data.length - at) throw new Error('Sheet account is truncated');
  const attributes = Array.from({ length: count }, () => ({ key: text(), value: text() }));
  return { project: encodeBase58(data.subarray(1, 33)), nft: encodeBase58(data.subarray(33, 65)), attributes };
}

/** A stash (`["stash", project, id]`): { project, id, nfts }, the NFTs the project holds to give away, in no order. */
export function decodeStash(data) {
  if (data == null || data.length === 0) return null;
  if (!(data instanceof Uint8Array) || data[0] !== TAGS.Stash || data.length < 41) throw new Error('Not a Stash account');
  const count = Number(readUintLE(data, 37, 4));
  if (41 + 32 * count > data.length) throw new Error('Stash account is truncated');
  const nfts = Array.from({ length: count }, (_, i) => encodeBase58(data.subarray(41 + 32 * i, 73 + 32 * i)));
  return { project: encodeBase58(data.subarray(1, 33)), id: Number(readUintLE(data, 33, 4)), nfts };
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

/** A fetched receipt, or null for a missing/prefunded empty System account. Other owners/layouts are refused. */
export function readReceiptAccount(account) {
  if (account == null) return null;
  if (account.owner === SYSTEM_PROGRAM && account.data instanceof Uint8Array && account.data.length === 0 && !account.executable) return null;
  if (account.owner !== LOOT_PROGRAM || account.executable) throw new Error('The receipt has an invalid owner.');
  return decodeReceipt(account.data);
}

/** What a counter allows `n` more of at `now` under `limit` ({ total, per_window, window }, 0 is no limit). */
export function receiptAllows(receipt, limit, now, n = 1) {
  const window = Number(limit.window) ? Math.floor(Number(now) / Number(limit.window)) + 1 : 0;
  const count = (receipt?.count ?? 0) + n;
  const inWindow = (receipt && receipt.window === window ? receipt.inWindow : 0) + n;
  return (!Number(limit.total) || count <= Number(limit.total)) && (!Number(limit.per_window) || inWindow <= Number(limit.per_window));
}

// ---------------------------------------------------------------- a lottery's purchases

/** The contribution among `contributions` ([{ address, value }], decoded LotteryContributions) that holds `ticket`. */
export const contributionOf = (contributions, ticket) =>
  contributions.find(({ value }) => BigInt(value.first_ticket) <= BigInt(ticket) && BigInt(ticket) < BigInt(value.end)) ?? null;

/** Whether a lottery's place wins something: a share of the pot, a roll, or both (as the program counts a place set). */
export const placeSet = (place) => Number(place.bps) > 0 || place.prize != null;

/** The places of a lottery that have a winner this round: as many as are set, but no more than tickets. */
export function lotteryWinners(lottery) {
  const set = lottery.places.findIndex((p) => !placeSet(p));
  return Math.min(set === -1 ? lottery.places.length : set, Number(lottery.sold));
}

/** The ticket that wins `place` of a drawn lottery: even steps around the list from first place's ticket. */
export function ticketOfPlace(lottery, place) {
  const sold = BigInt(lottery.sold);
  const winners = BigInt(lotteryWinners(lottery) || 1);
  const ahead = BigInt(place) * (sold / winners);
  const toEnd = sold - BigInt(lottery.first_ticket);
  return ahead < toEnd ? BigInt(lottery.first_ticket) + ahead : ahead - toEnd;
}

/** The places of a drawn lottery whose winning ticket is in `first..end` (a contribution's), in order. */
export function placesWon(lottery, first, end) {
  const won = [];
  for (let place = 0; place < lotteryWinners(lottery); place++) {
    const ticket = ticketOfPlace(lottery, place);
    if (BigInt(first) <= ticket && ticket < BigInt(end)) won.push(place);
  }
  return won;
}

/** The places of a drawn round that have a winner and a prize, in order: what it gives before its money moves. */
export const prizePlaces = (lottery) => [...Array(lotteryWinners(lottery)).keys()].filter((place) => lottery.places[place].prize != null);

/** The places a contribution won whose prize is not given yet (`Lottery.given`): its next step gives them. */
export function lotteryOwed(lottery, contribution) {
  if (lottery.status !== 'Drawn') return [];
  const given = Number(lottery.given ?? 0);
  const prizes = new Set(prizePlaces(lottery));
  return placesWon(lottery, contribution.first_ticket, contribution.end).filter((place) => prizes.has(place) && !(given & (1 << place)));
}

/** Whether every place's prize of a drawn round is given, so its money may move (`PrizesFirst`). */
export const prizesGiven = (lottery) => prizePlaces(lottery).every((place) => Number(lottery.given ?? 0) & (1 << place));

/** The lowest place of a drawn round whose prize is not given yet, or null: prizes go in place order (`PlacesInOrder`). */
export const nextPrizePlace = (lottery) => prizePlaces(lottery).find((place) => !(Number(lottery.given ?? 0) & (1 << place))) ?? null;

/**
 * What a contribution's next `finish_lottery_contribution` does, or null for nothing yet:
 *   'prizes'  give the prize of the next place it won, one place a call (a drawn round gives every prize before any money moves);
 *   'refund'  its tickets back to its buyer (a cancelled round, or a lottery that returns them);
 *   'finish'  its money through the shares into the pot, its tickets burned, or its NFT ticket spent (only once every
 *             prize of the round is given);
 *   'pay'     its places' shares of the pot, once every contribution of the round is finished.
 */
export function lotteryStep(lottery, contribution) {
  // Its prize step comes when the lowest place still owed across the round is one it won; until then it waits.
  // In a lottery that returns its tickets, a winner's ticket goes back first, then its prizes.
  const owed = contribution.done || !lottery.returns ? lotteryOwed(lottery, contribution) : [];
  if (owed.length) return owed[0] === nextPrizePlace(lottery) ? 'prizes' : null;
  if (contribution.done) return Number(lottery.pending) === 0 ? 'pay' : null;
  if (lottery.status === 'Cancelled' || (lottery.status === 'Drawn' && lottery.returns)) return 'refund';
  if (lottery.status === 'Drawn') return prizesGiven(lottery) ? 'finish' : null;
  return null;
}

/**
 * Who rents a listed NFT at `now` (Unix seconds), from its decoded Listing (or null for none): the renter's wallet while
 * a rental runs, else null (a sale listing, or a rental that is over).
 */
export function renterOf(listing, now) {
  if (!listing || !listing.deal?.Rent) return null;
  return BigInt(now) < BigInt(listing.until) && listing.user !== SYSTEM_PROGRAM ? listing.user : null;
}

/**
 * How many runs of a schedule are due at `now` (Unix seconds, the chain's clock, never the computer's): each its own
 * `run_schedule`, several in one transaction to catch up; one too many fails the whole transaction. A sealed schedule
 * past its last run is due once whenever its vault holds something (`vaultBalance`), which goes where it always went.
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
