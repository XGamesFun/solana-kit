// A player's way out with a compressed NFT: an unstake from a farm whose tier gives a collectible would be 1,374 bytes
// at a 3-node proof as a legacy transaction, past its limit. A forfeit passes neither the prize's accounts nor the
// rewards account (the program reads neither), and js/play's sender sends a compressed NFT's prove_leaf alone first,
// then the rest as legacy, or as v0 with a lookup table.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { encodeBase58 } from '../chain/base58.js';
import { LOOKUP_TABLE_PROGRAM, sendFitting, sendPlan } from '../chain/lookup.js';
import { uintLE } from '../chain/bytes.js';
import { addressBytes } from '../chain/base58.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent } from '../chain/programs.js';
import { compileMessage, readMessage, readTransaction, transactionSize, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';

const addr = (label) => encodeBase58(createHash('sha256').update(label).digest());
const player = addr('player'), project = addr('project'), tree = addr('tree'), collection = addr('c2'), c1 = addr('c1'), rwd = addr('rwd'), gold = addr('gold');
const BH = addr('bh');
const bytes32 = () => new Uint8Array(32).fill(7);
const cnft = (n) => ({ id: addr('cnft'), tree, nonce: 1n, owner: player, delegate: player, collection, dataHash: bytes32(), creatorHash: bytes32(), assetDataHash: null, flags: 0, root: bytes32(), proof: Array.from({ length: n }, (_, i) => addr(`node${i}`)) });
const farm = (prize) => ({ farmed: 'Collectibles', custody: 'Escrow', rewards_mint: rwd, rewards_pool: 0, rate: { mints: true }, tiers: [{ lock: 30, prize, roll: null, exit_bps: 0 }], growth: [], toll: null, exit_to: null, lock_key: '' });
const PROVE_LEAF = loot.IDL.instructions.find((i) => i.name === 'prove_leaf').discriminator;
const isProveLeaf = (ix) => ix.programId === loot.LOOT_PROGRAM && PROVE_LEAF.every((b, i) => ix.data[i] === b);

/** js/play's unstakeNft of a compressed NFT with a `n`-node proof from a tier that gives a collectible. */
const unstake = (n, forfeit) => {
  const c = cnft(n);
  return [computeUnitLimit(1_000_000), loot.proveLeafIx({ signer: player, compressed: c }), ...(forfeit ? [] : [createAssociatedTokenAccountIdempotent(player, player, rwd)]),
    loot.unstakeNftIx({ player, project, id: 4, farm: farm({ Item: [1] }), asset: c.id, compressed: c, hasAuthority: false, forfeit, roll: null, nonce: 5n, tier: 0, projectCollection: c1, poolMints: { 1: gold }, items: { 1: { kind: 'Collectible', issued: 3, collection: c1 } } })];
};
const size = (instructions) => transactionSize(compileMessage({ payer: player, blockhash: BH, instructions }));

test('a forfeit passes neither the prize’s accounts nor the rewards account', () => {
  const keys = (forfeit) => unstake(0, forfeit).at(-1).keys.map((k) => k.pubkey);
  assert.ok(!keys(true).includes(loot.ata(player, rwd)), 'no rewards account');
  assert.ok(!keys(true).includes(loot.pda.item(project, 1)), 'no prize item');
  assert.ok(keys(false).includes(loot.pda.item(project, 1)));
  assert.ok(size(unstake(3, true)) < size(unstake(3, false)) - 100, `${size(unstake(3, true))} against ${size(unstake(3, false))}`);
});

test('an unstake of a compressed NFT up to a 20-node proof goes in one v0 transaction, its proof with it (nobody can prove the leaf again in between)', () => {
  assert.ok(size(unstake(3, false)) > 1232, 'too big for one legacy transaction, as measured (1,374 bytes)');
  for (let n = 0; n <= 20; n++)
    for (const forfeit of [false, true]) {
      const plan = sendPlan({ payer: player, instructions: unstake(n, forfeit), alone: isProveLeaf });
      assert.ok(plan, `${n} nodes${forfeit ? ', forfeit' : ''}`);
      assert.deepEqual(plan.first, [], `${n} nodes: no proof sent alone`);
    }
});

/** A made-up program's instruction naming `n` accounts of its own from `from`, as `alone` picks it or not. */
const wide = (n, from, data = 9) => ({ programId: addr('prog'), keys: [{ pubkey: player, isSigner: true, isWritable: true }, ...Array.from({ length: n }, (_, i) => ({ pubkey: addr(`k${from + i}`), isSigner: false, isWritable: false }))], data: new Uint8Array(data) });

/** A chain for sendFitting: SlotHashes holds one slot (`recent`), a table holds what its sent extensions added, every slot moves on. */
function fakeChain(recent = 900n) {
  const sent = [];
  const tables = new Map();
  let slot = 1000n;
  const hashes = new Uint8Array(8 + 40);
  hashes[0] = 1;
  hashes.set(uintLE(recent, 8), 8);
  return {
    sent,
    rpc: {
      latestBlockhash: async () => ({ blockhash: BH, lastValidBlockHeight: 10 }),
      async send(wire) {
        const m = readMessage(readTransaction(wire).message);
        sent.push(m);
        for (const ix of m.instructions) {
          if (m.keys[ix.programIndex] !== LOOKUP_TABLE_PROGRAM || ix.data[0] !== 2) continue;
          const table = m.keys[ix.accountIndexes[0]];
          const added = Array.from({ length: (ix.data.length - 12) / 32 }, (_, i) => encodeBase58(ix.data.subarray(12 + 32 * i, 44 + 32 * i)));
          tables.set(table, [...(tables.get(table) ?? []), ...added]);
        }
        slot++;
        return `sig${sent.length}`;
      },
      confirm: async (s) => s,
      call: async () => Number(slot),
      async account(address) {
        if (address === 'SysvarS1otHashes111111111111111111111111111') return { owner: 'Sysvar1111111111111111111111111111111111111', data: hashes };
        const held = tables.get(address);
        if (!held) return null;
        const data = new Uint8Array(56 + 32 * held.length);
        data[0] = 1;
        data.set(new Uint8Array(8).fill(255), 4);
        data.set(uintLE(slot - 1n, 8), 12);
        data[21] = 1;
        held.forEach((a, i) => data.set(addressBytes(a), 56 + 32 * i));
        return { owner: LOOKUP_TABLE_PROGRAM, data };
      },
    },
  };
}

test('what fits one v0 transaction goes in one, its table made first; a proof goes alone only when it doesn’t, after the table', async () => {
  const { rpc, sent } = fakeChain();
  const one = await sendFitting({ rpc, payer: player, instructions: [computeUnitLimit(1_000_000), ...unstake(12, false).slice(1)], sign: async (m) => wireTransaction(m), alone: isProveLeaf });
  assert.ok(one.table);
  assert.deepEqual(sent.map((m) => m.version), [...sent.slice(0, -1).map(() => 'legacy'), 0], 'the table, then everything in one v0 transaction');
  assert.ok(sent.slice(0, -1).every((m) => m.keys.includes(LOOKUP_TABLE_PROGRAM)), 'the table’s own steps first');
  assert.ok(sent.at(-1).instructions.some((ix) => isProveLeaf({ programId: sent.at(-1).keys[ix.programIndex], data: ix.data })), 'the proof is in it');

  // 30 accounts the proof names and 33 others: 66 locks together, past 64, so the proof goes alone after the table.
  const proof = { ...wide(30, 0), programId: loot.LOOT_PROGRAM, data: Uint8Array.from([...PROVE_LEAF, 1]) };
  const rest = wide(33, 100);
  assert.equal(sendPlan({ payer: player, instructions: [proof, rest], alone: isProveLeaf }).first.length, 1);
  // A table this page made is never named again: the next send needs another recent slot.
  await assert.rejects(sendFitting({ rpc: fakeChain().rpc, payer: player, instructions: [proof, rest], sign: async (m) => wireTransaction(m), alone: isProveLeaf }), /no recent slot/);
  const chain = fakeChain(901n);
  await sendFitting({ rpc: chain.rpc, payer: player, instructions: [proof, rest], sign: async (m) => wireTransaction(m), alone: isProveLeaf });
  const kinds = chain.sent.map((m) => (m.version === 0 ? 'v0' : m.keys[m.instructions.at(-1).programIndex] === LOOKUP_TABLE_PROGRAM ? 'table' : isProveLeaf({ programId: m.keys[m.instructions.at(-1).programIndex], data: m.instructions.at(-1).data }) ? 'proof' : 'other'));
  assert.equal(kinds[0], 'table', JSON.stringify(kinds));
  assert.deepEqual(kinds.slice(-2), ['proof', 'v0'], JSON.stringify(kinds));
  assert.ok(kinds.lastIndexOf('table') < kinds.indexOf('proof'), 'the table is made before the proof');
});
