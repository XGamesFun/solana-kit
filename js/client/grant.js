// Grants: the bytes every voucher signer signs and `claim_grant` rebuilds, the approved list's Merkle tree, the
// Ed25519 precompile instruction that carries a voucher's signature, and the claim itself. Browser-safe.
//
//   voucherBytes   "loot-grant-v5" | sha256(program (32) | grant (32) | incarnation (u64 LE) | wallet (32) | person_hash (32) |
//                  expires (i64 LE) | count (u32 LE) | (round (16) | amount (u64 LE)) × count): a wallet's wins of several rounds
//   listLeaf       sha256("loot-list-v3" | wallet (32) | person_hash (32) | round (16) | amount (u64 LE)): a wallet's win of one round
//
// `amount`: the tokens a round gives, up to the grant's fixed amount (a rank's reward, a share); 0 for the grant's
// prize as it is. A round pays a wallet once per grant incarnation, whoever signs it again, whenever.
//   keyLeaf        sha256("loot-key-v1" | voucher key (32)): a key under a grant's key root (a promo code's)
//   merkleRoot     a node = sha256(min(a, b) | max(a, b)) (byte-wise); an odd node at a level goes up unchanged
//   merkleProof    the siblings from the leaf up (a promoted level adds none)
//
// A voucher's `person_hash` names one person across wallets (who decides that is the signer: a play host that saw
// a linked account, the project's own server). 32 zero bytes when there is none. Fixed vectors of these bytes are in
// the tests (js/test/client.test.mjs).
import { addressBytes } from '../chain/base58.js';
import { compareBytes, concat, fromHex, intLE, readUintLE, toBigInt, uintLE, utf8 } from '../chain/bytes.js';
import { meta } from '../chain/programs.js';
import { sha256 } from '../chain/sha256.js';
import { recordKey16 } from './accounts.js';
import { ASSOCIATED_TOKEN_PROGRAM, gateAccounts, lootIx, prizeMetas, prizeNonce, shownFor, tailOf } from './ix.js';
import { lootProgram, pda } from './pda.js';
import IDL from './idl/loot.js';

export const VOUCHER_DOMAIN = 'loot-grant-v5';
export const LIST_DOMAIN = 'loot-list-v3';
export const KEY_DOMAIN = 'loot-key-v1';
/** What a voucher key signs: the prefix (13 bytes), then the sha256 of the voucher's body. */
export const VOUCHER_BYTES = 45;
/** A grant claim's compute limit: its rounds' records and prizes can pass the 200,000 a transaction has by default. */
export const CLAIM_COMPUTE_UNITS = 400_000;
export const ZERO_HASH = new Uint8Array(32);
export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111';
/** The seconds of a UTC day (the IDL's `DAY_SECONDS`): a limit's window of a day (`PerWallet.window`). */
const DAY_SECONDS = Number(IDL.constants.find(c => c.name === 'DAY_SECONDS').value);
/** The day a window of `DAY_SECONDS` counts in, from the unix epoch. */
export const dayOf = unixSeconds => Math.floor(Number(unixSeconds) / DAY_SECONDS);

/** 32 bytes from a base58 address, 32 bytes or 64 hex characters. */
function bytes32(value, what) {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new RangeError(`${what} must be 32 bytes, not ${value.length}`);
    return value;
  }
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return fromHex(value);
  if (typeof value === 'string') return addressBytes(value);
  throw new TypeError(`${what} must be an address or 32 bytes`);
}

const personBytes = value =>
  value === null || value === undefined || value === '' ? ZERO_HASH : bytes32(value, 'person_hash');

function roundBytes(value) {
  const out =
    value instanceof Uint8Array
      ? value
      : typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)
        ? fromHex(value)
        : null;
  if (!out || out.length !== 16) throw new RangeError('round must be 16 bytes (32 hex characters)');
  return out;
}

/** An i64 little-endian (two's complement), as the program reads `expires`. */
export const i64LE = value => intLE(value, 8);

/** A claim's rounds: [{ id (16 bytes or 32 hex characters), amount }], or one `round` and its `amount`. */
const roundsOf = (rounds, round, amount) =>
  (rounds ?? [{ id: round, amount }]).map(r => ({
    id: roundBytes(r.id ?? r.round ?? new Uint8Array(16)),
    amount: toBigInt(r.amount ?? 0),
  }));

/** A voucher's body, which its key signs the sha256 of (`voucherBytes`). */
export function voucherBody({
  program = lootProgram(),
  grant,
  incarnation,
  wallet,
  personHash,
  expires,
  rounds,
  round,
  amount = 0n,
}) {
  const list = roundsOf(rounds, round, amount);
  return concat(
    bytes32(program, 'program'),
    bytes32(grant, 'grant'),
    uintLE(incarnation, 8),
    bytes32(wallet, 'wallet'),
    personBytes(personHash),
    i64LE(expires),
    uintLE(list.length, 4),
    ...list.flatMap(r => [r.id, uintLE(r.amount, 8)]),
  );
}

/**
 * The 45 bytes a voucher key signs and `claim_grant` rebuilds from its own accounts and arguments: the prefix, then the
 * sha256 of the voucher's body (`voucherBody`), so a voucher of many rounds is as short to check as one of one. `rounds`
 * ([{ id, amount }], or one `round` and its `amount`) names the wins (the project round, draw or giveaway each was won
 * in): the program pays a wallet each round once per grant incarnation.
 */
export const voucherBytes = fields => concat(utf8(VOUCHER_DOMAIN), sha256(voucherBody(fields)));

/** The fields back from a voucher's body (`voucherBody`; addresses as bytes, rounds as [{ id, amount }]). */
export function readVoucher(body) {
  if (!(body instanceof Uint8Array) || body.length < 148) throw new RangeError('a voucher body is at least 148 bytes');
  const at = (i, len) => body.slice(i, i + len);
  let expires = readUintLE(body, 136, 8);
  if (expires >= 1n << 63n) expires -= 1n << 64n;
  const count = Number(readUintLE(body, 144, 4));
  if (body.length !== 148 + 24 * count) throw new RangeError('a voucher body holds 24 bytes a round');
  const rounds = Array.from({ length: count }, (_, i) => ({
    id: at(148 + 24 * i, 16),
    amount: readUintLE(body, 164 + 24 * i, 8),
  }));
  return {
    program: at(0, 32),
    grant: at(32, 32),
    incarnation: readUintLE(body, 64, 8),
    wallet: at(72, 32),
    personHash: at(104, 32),
    expires,
    rounds,
  };
}

/** A voucher key's leaf under a grant's `key_root`. */
export const keyLeaf = key => sha256(concat(utf8(KEY_DOMAIN), bytes32(key, 'key')));

/** A list entry's round as the leaf names it: a number (a spec's `round`) in the first 8 of 16 bytes; 0 is zeros. */
export const listRound = (n = 0) => {
  const out = new Uint8Array(16);
  out.set(uintLE(n, 8));
  return out;
};

/**
 * A leaf of an approved list: `wallet` won `round` (16 bytes or 32 hex characters; zeros when not given). A round is
 * paid once, so a list can name the winners of many rounds, and a wallet's earlier wins stay claimable when a new
 * list adds later ones.
 */
export const listLeaf = (wallet, personHash, round, amount = 0n) =>
  sha256(
    concat(
      utf8(LIST_DOMAIN),
      bytes32(wallet, 'wallet'),
      personBytes(personHash),
      roundBytes(round ?? new Uint8Array(16)),
      uintLE(amount, 8),
    ),
  );

/** The prefix of a wallet's leaf in a list gate (`gateListLeaf`). */
export const GATE_LIST_DOMAIN = 'loot-list-v1';
/** A wallet's leaf in a list gate (`Gate::List`): sha256("loot-list-v1" | wallet). Its tree is a list's
 * (`merkleRoot`, `merkleProof`), and its proof's nodes go where an NFT shown would (`gateAccounts`'s `listProof`). */
export const gateListLeaf = wallet => sha256(concat(utf8(GATE_LIST_DOMAIN), bytes32(wallet, 'wallet')));

/** The parent of two nodes: sha256 of the smaller then the larger. */
export const parentOf = (a, b) => (compareBytes(a, b) <= 0 ? sha256(concat(a, b)) : sha256(concat(b, a)));

function levelsOf(leaves) {
  if (!leaves.length) throw new RangeError('a list needs at least one wallet');
  const levels = [leaves.map(l => bytes32(l, 'leaf'))];
  while (levels.at(-1).length > 1) {
    const level = levels.at(-1);
    const next = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? parentOf(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  return levels;
}

/** The root of the leaves, in the order given. Whoever builds the list keeps that order. */
export const merkleRoot = leaves => levelsOf(leaves).at(-1)[0];

/** The siblings of leaf `index`, from the bottom up. */
export function merkleProof(leaves, index) {
  const levels = levelsOf(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= levels[0].length) throw new RangeError('no leaf at that index');
  const proof = [];
  let i = index;
  for (const level of levels.slice(0, -1)) {
    const sibling = i % 2 ? i - 1 : i + 1;
    if (sibling < level.length) proof.push(level[sibling]);
    i = Math.floor(i / 2);
  }
  return proof;
}

/**
 * A list gate's tree (`Gate::List`) for `wallets`, in the order given: its `root`, its `depth`, and `proofOf(wallet)`.
 * The gate reads exactly `depth` nodes, so the leaves are filled up to a power of two with a leaf no wallet has (all
 * zeros): every wallet's proof is then `depth` nodes long.
 */
export function gateList(wallets) {
  if (!wallets.length) throw new RangeError('a list needs at least one wallet');
  const leaves = wallets.map(w => gateListLeaf(w));
  let size = 1;
  while (size < leaves.length) size *= 2;
  // Filled with a leaf no wallet has (all zeros): a wallet's leaf is a hash, so nobody can prove a filler.
  while (leaves.length < size) leaves.push(new Uint8Array(32));
  return {
    root: merkleRoot(leaves),
    depth: Math.log2(size),
    proofOf: wallet => {
      const at = wallets.indexOf(wallet);
      if (at < 0) throw new RangeError(`${wallet} is not on the list`);
      return merkleProof(leaves, at);
    },
  };
}

/** Whether `proof` leads from `leaf` to `root`. */
export function verifyProof(leaf, proof, root) {
  let node = bytes32(leaf, 'leaf');
  for (const sibling of proof) node = parentOf(node, bytes32(sibling, 'proof'));
  return compareBytes(node, bytes32(root, 'root')) === 0;
}

/**
 * The Ed25519 precompile instruction for one signature, everything in its own data: count 1, padding, seven u16
 * offsets with instruction index 0xffff (this instruction), then the key at 16, the signature at 48, the message at
 * 112. `claim_grant` reads it through the instructions sysvar, in the instruction right before itself.
 */
export function ed25519Ix({ publicKey, signature, message }) {
  const key = bytes32(publicKey, 'publicKey');
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new RangeError('signature must be 64 bytes');
  const keyAt = 16;
  const signatureAt = keyAt + 32;
  const messageAt = signatureAt + 64;
  const u16 = n => uintLE(n, 2);
  const THIS = 0xffff;
  const data = concat(
    Uint8Array.of(1, 0),
    u16(signatureAt),
    u16(THIS),
    u16(keyAt),
    u16(THIS),
    u16(messageAt),
    u16(message.length),
    u16(THIS),
    key,
    signature,
    message,
  );
  return { programId: ED25519_PROGRAM, keys: [], data };
}

/** The kinds of a grant's limit records (`limitKey`). */
const KINDS = Object.freeze({ wallet: 'wallet', person: 'person', badge: 'badge', code: 'code' });

/** The key of a grant's limit record of `kind` ('wallet', 'person', 'badge', 'code') for `subject` (an address or 32
 * bytes): sha256(kind | subject)[..16]. */
export const limitKey = (kind, subject) => recordKey16(utf8(KINDS[kind] ?? kind), bytes32(subject, 'subject'));

/** The key of a wallet's record of a round a grant paid it: sha256(round | wallet)[..16]. */
export const roundKey = (round, wallet) => recordKey16(roundBytes(round), bytes32(wallet, 'wallet'));

/** The shard a record's key falls in, of a grant's `2^bits`: the top `bits` bits of its first byte. */
export const shardOf = (key, bits) => (Number(bits) ? key[0] >> (8 - Number(bits)) : 0);

/** The rounds shard a wallet's paid rounds are kept in: its own limit record's. */
export const walletShard = (grant, wallet) => shardOf(limitKey('wallet', wallet), grant.shard_bits);

/** Whether a grant paid `wallet` for `round`, from the wallet's decoded rounds shard (`decodeList`, null for none). */
export const roundPaid = (list, wallet, round) =>
  Boolean(list?.records.some(r => compareBytes(r, roundKey(round, wallet)) === 0));

/**
 * The fewest shard bits (0 to 8) that keep each of a grant's lists under ~100,000 records over its life: `wallets` ×
 * the rounds each may claim (`rounds`). A 10,000-wallet airdrop takes 0 (one shard).
 */
export function shardBitsFor(wallets, rounds = 1) {
  const records = Number(wallets) * Math.max(1, Number(rounds));
  let bits = 0;
  while (bits < 8 && records / 2 ** bits > 100_000) bits += 1;
  return bits;
}

/**
 * The claim of grant `id` for `wallet`, sent and signed by `signer` (anyone: the play host, the owner's server, the
 * player). The grant's funds pay its records through the signer; what they can't cover, the signer pays. The signer pays
 * the player fee, and a roll's order, with its own SOL. `grant` is the decoded Grant.
 *
 * A voucher claim goes right after `ed25519Ix` in the same transaction, `voucherKey` the key that signed it (a key under
 * the key root carries its proof as `proofs[0]`); a list claim carries a proof for each round (`proofs`); an open grant
 * (no keys, no key root, no list) names no round and pays one prize (`count`: the wallet's claims before it, for its
 * roll's nonce). `rounds` ([{ id, amount }], or one `round` and its `amount`) are the wins it names: each paid once, so
 * one already paid is skipped (`paidRounds`: the wallet's decoded rounds shard, `decodeList`, to leave out its prize's
 * accounts). What passes its gate (`shown`, or `listProof` for a list gate) comes first, then each shard of the grant's
 * claims it counts in, then each round's prize (`grant.gives`, `prizeMetas`): `poolMint` for tokens from a pool, `item`
 * (the decoded Item) for a collectible or a compressed NFT of one, `nft` for an NFT of a stash; round `i`'s roll at
 * `prizeRollNonce(nonce + i)` (`nonce`: `prizeNonce` of the grant, the wallet and its rounds by default), its box and
 * order only (`askRollIx` then asks for it, in the same transaction when it fits). Send it with a compute limit of
 * `CLAIM_COMPUTE_UNITS`.
 */
export function claimGrantIx({
  project,
  id,
  grant,
  wallet,
  signer,
  count = 0,
  rounds,
  round,
  expires,
  personHash,
  amount = 0n,
  proofs,
  proof = [],
  paidRounds = null,
  poolMint,
  item,
  nft,
  shown,
  listProof,
  programs,
  voucherKey,
  nonce,
  extra = [],
}) {
  if (!signer) throw new Error('A claim needs its signer: whoever sends it');
  // Every claim is its winning wallet's own: the wallet signs it, whatever proves it (a voucher, a list, an open
  // grant), so nobody claims for a player (WalletMustSign). `signer` pays the fees and what the claim opens: the
  // wallet itself, or anyone who pays for it.
  const address = pda.grant(project, id);
  const person = personBytes(personHash);
  const listed = Uint8Array.from(grant.list_root ?? []).some(b => b !== 0);
  // A claim by voucher or list names its rounds; an open one names none.
  const named = Boolean(voucherKey) || listed || rounds != null || round != null;
  const list = named ? roundsOf(rounds, round ?? new Uint8Array(16), amount) : [];
  // The limit records it counts in: the wallet's, a person's a voucher names, the NFT an open claim of an open grant
  // gated by one shows (a badge), a voucher key's; each shard of the grant's claims once, by shard number.
  const bits = Number(grant.shard_bits ?? 0);
  const keys = [limitKey('wallet', wallet)];
  if (person.some(b => b !== 0) && Number(grant.limits?.per_person ?? 0) > 0) keys.push(limitKey('person', person));
  const badge = typeof shown === 'string' ? shown : (shown?.asset ?? shown?.mint ?? shown?.compressed);
  if (!named && grant.open && grant.gate?.Holds && badge) keys.push(limitKey('badge', badge));
  if (voucherKey && Number(grant.limits?.per_key ?? 0) > 0) keys.push(limitKey('code', voucherKey));
  const shards = [...new Set(keys.map(k => shardOf(k, bits)))]
    .sort((x, y) => x - y)
    .map(shard => meta(pda.claims(address, grant.incarnation, shard), false, true));
  nonce = toBigInt(
    nonce ??
      (named ? prizeNonce(address, wallet, ...list.map(r => r.id)) : prizeNonce(address, wallet, toBigInt(count))),
  );
  // Each round not paid yet gives the grant's prize, or the amount of its tokens the round names, in order; collectibles
  // of one item each at its next serial.
  const gives = grant.gives;
  const pool = gives.Tokens?.from.Pool?.[0];
  const itemId = gives.Item?.[0] ?? gives.Compressed?.item;
  if (pool !== undefined && !poolMint)
    throw new Error('A payout claim needs its pool’s mint (poolMint), read from the pool');
  const seen = new Set();
  const owed = (named ? list.map((r, i) => ({ ...r, i })) : [{ amount: 0n, i: 0 }]).filter(r => {
    if (!named) return true;
    const hex = Array.from(r.id, b => b.toString(16).padStart(2, '0')).join('');
    if (seen.has(hex) || roundPaid(paidRounds, wallet, r.id)) return false;
    seen.add(hex);
    return true;
  });
  const prizes = owed.flatMap((r, made) =>
    prizeMetas({
      project,
      prize: r.amount > 0n && gives.Tokens ? { Tokens: { ...gives.Tokens, amount: r.amount } } : gives,
      winner: wallet,
      nonce: BigInt.asUintN(64, nonce + BigInt(r.i)),
      programs,
      poolMints: pool !== undefined ? { [pool]: poolMint } : {},
      items: itemId !== undefined ? { [itemId]: item } : {},
      nft,
      made,
    }),
  );
  proofs ??= listed && !voucherKey ? [proof] : proof.length ? [proof] : [];
  return lootIx(
    'claim_grant',
    {
      rounds: list,
      expires: toBigInt(expires ?? 0),
      person_hash: person,
      proofs: proofs.map(p => p.map(x => bytes32(x, 'proof'))),
      nonce,
    },
    {
      project,
      grant: address,
      signer,
      wallet,
      rounds: named ? pda.rounds(address, grant.incarnation, shardOf(keys[0], bits)) : null,
      token_program: undefined,
      token_2022_program: undefined,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
    },
    {
      remaining: [
        ...gateAccounts(project, {
          gate: grant.gate,
          wallet,
          shown: shownFor(project, grant.gate, wallet, shown),
          listProof,
        }),
        ...shards,
        ...prizes,
        ...tailOf(extra),
      ],
      signer: ['wallet'],
    },
  );
}

/**
 * Anyone closes shard `shard` of a grant's rounds (`rounds`) or claims once the grant is closed or made again
 * (`incarnation` the one the shard is of): its rent goes to the project's `owner`.
 */
export const closeShardIx = ({ project, id, incarnation, rounds = false, shard, owner }) => {
  const grant = pda.grant(project, id);
  return lootIx(
    'close_shard',
    { id, incarnation: toBigInt(incarnation), rounds, shard },
    { project, grant, shard: (rounds ? pda.rounds : pda.claims)(grant, incarnation, shard), owner },
  );
};
