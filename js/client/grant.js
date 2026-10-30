// Grants: the bytes every voucher signer signs and `claim_grant` rebuilds, the approved list's Merkle tree, the
// Ed25519 precompile instruction that carries a voucher's signature, and the claim itself. Browser-safe.
//
//   voucherBytes   "loot-grant-v4" | program (32) | grant (32) | incarnation (u64 LE) | wallet (32) | person_hash (32) | round (16) | expires (i64 LE) | amount (u64 LE)
//   listLeaf       sha256("loot-list-v3" | wallet (32) | person_hash (32) | round (16) | amount (u64 LE)): a wallet's win of one round
//
// `amount`: the tokens this claim gives, up to the grant's fixed amount (a rank's reward, a share); 0 for the grant's
// prize as it is.
//   keyLeaf        sha256("loot-key-v1" | voucher key (32)): a key under a grant's key root (a promo code's)
//   merkleRoot     a node = sha256(min(a, b) | max(a, b)) (byte-wise); an odd node at a level goes up unchanged
//   merkleProof    the siblings from the leaf up (a promoted level adds none)
//
// A voucher's `person_hash` names one person across wallets (who decides that is the signer: a play host that saw
// a linked account, the project's own server). 32 zero bytes when there is none. Fixed vectors of these bytes are in
// the tests (js/test/client.test.mjs).
import { addressBytes } from '../chain/base58.js';
import { compareBytes, concat, fromHex, intLE, readUintLE, toBigInt, uintLE, utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import { ASSOCIATED_TOKEN_PROGRAM, gateAccounts, lootIx, prizeMetas, prizeNonce } from './ix.js';
import { LOOT_PROGRAM, pda } from './pda.js';
import IDL from './idl/loot.js';

export const VOUCHER_DOMAIN = 'loot-grant-v4';
export const LIST_DOMAIN = 'loot-list-v3';
export const KEY_DOMAIN = 'loot-key-v1';
/** 13 + 32 × 4 + 8 + 16 + 8. */
export const VOUCHER_BYTES = 181;
export const ZERO_HASH = new Uint8Array(32);
export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111';
/** The seconds of the day a grant's daily limit counts claims in (the IDL's `DAY_SECONDS`). */
const DAY_SECONDS = Number(IDL.constants.find((c) => c.name === 'DAY_SECONDS').value);
/** The day the program counts `per_day` in. */
export const dayOf = (unixSeconds) => Math.floor(Number(unixSeconds) / DAY_SECONDS);

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

const personBytes = (value) => (value === null || value === undefined || value === '' ? ZERO_HASH : bytes32(value, 'person_hash'));

function roundBytes(value) {
  const out = value instanceof Uint8Array ? value : typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value) ? fromHex(value) : null;
  if (!out || out.length !== 16) throw new RangeError('round must be 16 bytes (32 hex characters)');
  return out;
}

/** An i64 little-endian (two's complement), as the program reads `expires`. */
export const i64LE = (value) => intLE(value, 8);

/**
 * The 181 bytes a voucher key signs and `claim_grant` rebuilds from its own accounts and arguments. `round` names the
 * win (the project round, draw or giveaway it was won in): the program pays a wallet each round once per grant incarnation.
 */
export function voucherBytes({ program = LOOT_PROGRAM, grant, incarnation, wallet, personHash, round, expires, amount = 0n }) {
  const out = concat(utf8(VOUCHER_DOMAIN), bytes32(program, 'program'), bytes32(grant, 'grant'), uintLE(incarnation, 8), bytes32(wallet, 'wallet'), personBytes(personHash), roundBytes(round), i64LE(expires), uintLE(amount, 8));
  if (out.length !== VOUCHER_BYTES) throw new Error(`a voucher is ${VOUCHER_BYTES} bytes, not ${out.length}`);
  return out;
}

/** The fields back from voucher bytes (addresses as bytes). */
export function readVoucher(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== VOUCHER_BYTES) throw new RangeError(`a voucher is ${VOUCHER_BYTES} bytes`);
  const n = VOUCHER_DOMAIN.length;
  if (new TextDecoder().decode(bytes.subarray(0, n)) !== VOUCHER_DOMAIN) throw new Error(`not a ${VOUCHER_DOMAIN} voucher`);
  const at = (i, len) => bytes.slice(i, i + len);
  let expires = 0n;
  for (let i = 7; i >= 0; i--) expires = (expires << 8n) | BigInt(bytes[n + 152 + i]);
  if (expires >= 1n << 63n) expires -= 1n << 64n;
  return { program: at(n, 32), grant: at(n + 32, 32), incarnation: readUintLE(bytes, n + 64, 8), wallet: at(n + 72, 32), personHash: at(n + 104, 32), round: at(n + 136, 16), expires, amount: readUintLE(bytes, n + 160, 8) };
}

/** A voucher key's leaf under a grant's `key_root`. */
export const keyLeaf = (key) => sha256(concat(utf8(KEY_DOMAIN), bytes32(key, 'key')));

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
export const listLeaf = (wallet, personHash, round, amount = 0n) => sha256(concat(utf8(LIST_DOMAIN), bytes32(wallet, 'wallet'), personBytes(personHash), roundBytes(round ?? new Uint8Array(16)), uintLE(amount, 8)));

/** The prefix of a wallet's leaf in a list gate (`gateListLeaf`). */
export const GATE_LIST_DOMAIN = 'loot-list-v1';
/** A wallet's leaf in a list gate (`Gate::List`): sha256("loot-list-v1" | wallet). Its tree is a list's
 * (`merkleRoot`, `merkleProof`), and its proof's nodes go where an NFT shown would (`gateAccounts`'s `listProof`). */
export const gateListLeaf = (wallet) => sha256(concat(utf8(GATE_LIST_DOMAIN), bytes32(wallet, 'wallet')));

/** The parent of two nodes: sha256 of the smaller then the larger. */
export const parentOf = (a, b) => (compareBytes(a, b) <= 0 ? sha256(concat(a, b)) : sha256(concat(b, a)));

function levelsOf(leaves) {
  if (!leaves.length) throw new RangeError('a list needs at least one wallet');
  const levels = [leaves.map((l) => bytes32(l, 'leaf'))];
  while (levels.at(-1).length > 1) {
    const level = levels.at(-1);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? parentOf(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  return levels;
}

/** The root of the leaves, in the order given. Whoever builds the list keeps that order. */
export const merkleRoot = (leaves) => levelsOf(leaves).at(-1)[0];

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
  const leaves = wallets.map((w) => gateListLeaf(w));
  let size = 1;
  while (size < leaves.length) size *= 2;
  // Filled with a leaf no wallet has (all zeros): a wallet's leaf is a hash, so nobody can prove a filler.
  while (leaves.length < size) leaves.push(new Uint8Array(32));
  return {
    root: merkleRoot(leaves),
    depth: Math.log2(size),
    proofOf: (wallet) => {
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
  const u16 = (n) => uintLE(n, 2);
  const THIS = 0xffff;
  const data = concat(Uint8Array.of(1, 0), u16(signatureAt), u16(THIS), u16(keyAt), u16(THIS), u16(messageAt), u16(message.length), u16(THIS), key, signature, message);
  return { programId: ED25519_PROGRAM, keys: [], data };
}

/**
 * The claim of grant `id` for `wallet`, sent and signed by `signer` (anyone: the play host, the owner's server, the
 * player). The grant's funds pay its rent through the signer; what they can't cover, the signer pays. The signer pays
 * the player fee with its own SOL. `grant` is the decoded Grant; `count` the wallet's receipt count before this claim (0 for a
 * first claim); `poolMint` the mint of a Payout's pool, read from the pool.
 * A voucher claim goes right after `ed25519Ix` in the same transaction, `voucherKey` the key that signed it (its
 * counter is passed when the grant limits keys; a key under the key root carries its `proof`); a list claim carries
 * its `proof`; an open grant (no keys, no key root, no list) needs neither. What passes its gate (`shown`, or
 * `listProof` for a list gate) comes first. Its prize (`grant.gives`, `prizeMetas`)
 * follows: `poolMint` for tokens from a pool, `item` (the decoded Item) for a collectible or a compressed NFT of one, `nft` for an NFT of a stash;
 * a roll's order at `nonce` (`prizeNonce(grant, round, count)` by default), then the rolled box's prize mints
 * (`rollMints`: `boxes` maps the box's id to its decoded LootBox, null for one never written; `rollPools` each pool its
 * prizes name to its mint, null for one never opened). The grant's funds pay what it opens.
 */
export function claimGrantIx({ project, id, grant, wallet, signer, count = 0, round, expires, personHash, amount = 0n, proof = [], poolMint, item, nft, boxes = {}, rollPools = {}, shown, listProof, programs, voucherKey, nonce, extra = [] }) {
  if (!signer) throw new Error('A claim needs its signer: whoever sends it');
  // Every claim is its winning wallet's own: the wallet signs it, whatever proves it (a voucher, a list, an open
  // grant), so nobody claims for a player (WalletMustSign). `signer` pays the fees and what the claim opens: the
  // wallet itself, or anyone who pays for it.
  const address = pda.grant(project, id);
  const person = personBytes(personHash);
  const hasPerson = person.some((b) => b !== 0);
  // A person a voucher names is counted when the grant limits persons; an open grant gated by an NFT
  // counts the NFT shown, at a badge's address (a grant never does both; both go in `person_receipt`).
  const badge = typeof shown === 'string' ? shown : shown?.asset ?? shown?.mint ?? shown?.compressed;
  const counted = hasPerson && Number(grant.limits?.per_person ?? 0) > 0
    ? pda.person(address, grant.incarnation, person)
    : grant.open && grant.gate?.Holds && badge ? pda.badge(address, grant.incarnation, badge) : null;
  const accounts = {
    project,
    grant: address,
    signer,
    wallet,
    wallet_receipt: pda.grantReceipt(address, grant.incarnation, wallet),
    person_receipt: counted,
    code_receipt: voucherKey && Number(grant.limits?.per_key ?? 0) ? pda.code(address, grant.incarnation, voucherKey) : null,
    token_program: undefined,
    token_2022_program: undefined,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
  };
  const roundAt = roundBytes(round ?? new Uint8Array(16));
  nonce = toBigInt(nonce ?? prizeNonce(address, roundAt, toBigInt(count)));
  // The prize's accounts, after an NFT the wallet shows: `poolMint` a pool's mint, `item` the decoded Item of a
  // collectible (its next serial), `nft` an NFT's kind as `piece` takes it.
  const gives = grant.gives;
  const pool = gives.Tokens?.from.Pool?.[0];
  const itemId = gives.Item?.[0] ?? gives.Compressed?.item;
  if (pool !== undefined && !poolMint) throw new Error('A payout claim needs its pool’s mint (poolMint), read from the pool');
  const prize = prizeMetas({
    project, prize: gives, winner: wallet, nonce, programs,
    poolMints: pool !== undefined ? { [pool]: poolMint } : {}, items: itemId !== undefined ? { [itemId]: item } : {}, nft,
    strict: true, boxes, rollPools,
  });
  return lootIx(
    'claim_grant',
    { round: roundAt, expires: toBigInt(expires ?? 0), person_hash: person, amount: toBigInt(amount), proof: proof.map((p) => bytes32(p, 'proof')), nonce },
    accounts,
    { remaining: [...gateAccounts(project, { gate: grant.gate, wallet, shown, listProof }), ...prize, ...extra], signer: ['wallet'] },
  );
}
