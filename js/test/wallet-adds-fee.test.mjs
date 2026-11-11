// A wallet that adds its own priority fee (Phantom does): only to a transaction that carries no signature yet and
// no compute budget instruction. The approval page sends a transaction only as it prepared it, so every setup
// transaction sets its own limit and price, and such a wallet signs each one as it stands. One that changes a
// transaction all the same is refused in words that say what it added.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval, walletChange } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, computeUnitPrice, priorityFee, transferLamports } from '../chain/programs.js';
import { compileMessage, isEmptySignature, readMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const example = name => JSON.parse(readFileSync(path.join(ROOT, 'examples', `${name}.json`), 'utf8'));
const LIMIT = 2;
const PRICE = 3;

/** A message's instructions as they were built: { programId, keys, data }. */
function instructionsOf(message) {
  const m = readMessage(message);
  const { numRequiredSignatures: signed, numReadonlySigned, numReadonlyUnsigned } = m.header;
  const writable = i => i < signed - numReadonlySigned || (i >= signed && i < m.keys.length - numReadonlyUnsigned);
  return m.instructions.map(ix => ({
    programId: m.keys[ix.programIndex],
    keys: ix.accountIndexes.map(i => ({ pubkey: m.keys[i], isSigner: i < signed, isWritable: writable(i) })),
    data: ix.data,
  }));
}

/** Whether a wallet that adds its fee would add it to this wire: no signature on it yet, and no compute budget. */
const wouldAddFee = wire => {
  const t = readTransaction(wire);
  return (
    t.signatures.every(isEmptySignature) &&
    !instructionsOf(t.message).some(ix => ix.programId === COMPUTE_BUDGET_PROGRAM)
  );
};

/** The message a wallet signs in place of `message` once it has put `added` first. */
function withAdded(message, added) {
  const m = readMessage(message);
  return compileMessage({
    payer: m.keys[0],
    blockhash: m.blockhash,
    instructions: [...added, ...instructionsOf(message)],
  });
}

/**
 * A wallet that adds its own priority fee where the rule says it does, and signs what it then holds. `changed` counts
 * the transactions it changed.
 */
function feeAddingWallet(key = freshKeypair()) {
  const wallet = {
    address: key.address,
    changed: 0,
    signAll: wires =>
      wires.map(b64 => {
        const wire = fromBase64(b64);
        let { message, signatures, signers } = readTransaction(wire);
        if (wouldAddFee(wire)) {
          wallet.changed++;
          message = withAdded(message, [computeUnitLimit(200_000), computeUnitPrice(50_000n)]);
          ({ signatures, signers } = readTransaction(wireTransaction(message)));
        }
        const sigs = [...signatures];
        sigs[signers.indexOf(key.address)] = key.sign(message);
        return toBase64(wireTransaction(message, sigs));
      }),
  };
  return wallet;
}

function setup(spec) {
  const w = world({ project: false, seed: 'wallet-adds-fee' });
  w.chain.warp(NOW);
  const wallet = feeAddingWallet();
  w.chain.airdrop(wallet.address, 100_000_000_000n);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-fee-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  const chain = approvalChain(w);
  const session = () => createApproval({ file, chain, now: () => NOW });
  return { w, wallet, file, chain, session, saved: () => JSON.parse(readFileSync(file, 'utf8')) };
}

/** Every prepared transaction leads with one unit limit, then one unit price, and holds no other of either. */
function assertLeads(b64, what) {
  const ixs = instructionsOf(readTransaction(fromBase64(b64)).message);
  const kinds = ixs.filter(ix => ix.programId === COMPUTE_BUDGET_PROGRAM).map(ix => ix.data[0]);
  assert.equal(ixs[0].programId, COMPUTE_BUDGET_PROGRAM, what);
  assert.equal(ixs[0].data[0], LIMIT, `${what}: its unit limit first`);
  assert.equal(ixs[1].programId, COMPUTE_BUDGET_PROGRAM, what);
  assert.equal(ixs[1].data[0], PRICE, `${what}: then its unit price`);
  assert.equal(kinds.filter(k => k === LIMIT).length, 1, `${what}: one limit`);
  assert.equal(kinds.filter(k => k === PRICE).length, 1, `${what}: one price`);
  assert.equal(wouldAddFee(fromBase64(b64)), false, what);
  return ixs;
}

describe('a wallet that adds its own priority fee', () => {
  test(
    'signs a whole setup, a change and the lookup table’s steps as they stand',
    { skip: skip ?? false },
    async () => {
      const { w, wallet, session, saved, file } = setup(example('coin-flip-arena'));
      const first = await session();
      const steps = [];
      for (let i = 0; i < 10 && !first.state().done; i++) {
        const batch = await first.prepare(wallet.address);
        batch.transactions.forEach((b64, n) => assertLeads(b64, `transaction ${n + 1}: ${batch.says[n]}`));
        steps.push(...batch.says);
        await first.complete(wallet.address, batch.id, wallet.signAll(batch.transactions));
      }
      assert.ok(
        steps.some(s => /lookup table/.test(s)),
        'the lookup table’s steps were among them',
      );
      assert.ok(saved().live.project && !saved().live.partial, 'live');
      assert.ok(saved().live.tables?.length, 'with its lookup table');

      const live = saved();
      writeFileSync(
        file,
        JSON.stringify({ ...live, pools: [...live.pools, { key: 'bonus', currency: 'sol' }] }, null, 2),
      );
      const change = await session();
      const batch = await change.prepare(wallet.address);
      batch.transactions.forEach((b64, n) => assertLeads(b64, `the change’s transaction ${n + 1}`));
      await change.complete(wallet.address, batch.id, wallet.signAll(batch.transactions));
      assert.ok(saved().live.published.pools.some(p => p.key === 'bonus'));
      assert.equal(wallet.changed, 0, 'it changed nothing: each transaction set its own limit and price');

      // What the price costs is what the plan says: a token's new name is one transaction of one signature that
      // makes no account, so the wallet is out the 5,000 lamports of its signature and the 2 of its priority fee.
      const named = saved();
      const tokens = named.tokens.map(t => (t.name ? { ...t, name: `${t.name} Coin` } : t));
      writeFileSync(file, JSON.stringify({ ...named, tokens }, null, 2));
      const rename = await session();
      const held = BigInt(await w.chain.rpc.balance(wallet.address));
      const one = await rename.prepare(wallet.address);
      assert.equal(one.transactions.length, 1);
      await rename.complete(wallet.address, one.id, wallet.signAll(one.transactions));
      assert.equal(held - BigInt(await w.chain.rpc.balance(wallet.address)), 5002n);
    },
  );

  test('every example’s setup hands it transactions it leaves alone', { skip: skip ?? false }, async () => {
    let prepared = 0;
    for (const name of readdirSync(path.join(ROOT, 'examples')).filter(
      f => f.endsWith('.json') && f !== 'ideas.json',
    )) {
      const { wallet, session } = setup(example(name.slice(0, -5)));
      const s = await session();
      // (an example that names a token made elsewhere has no such mint on this chain: nothing is prepared for it)
      if ((await s.stateFor(wallet.address)).refused) continue;
      const batch = await s.prepare(wallet.address);
      for (const [n, b64] of batch.transactions.entries()) {
        const ixs = assertLeads(b64, `${name}, transaction ${n + 1}`);
        // the price the plan's cost counts: 1 micro-lamport a unit, 2 lamports a transaction at the most units
        assert.equal(priorityFee(ixs), 2n, `${name}, transaction ${n + 1}`);
      }
      prepared += batch.transactions.length;
    }
    assert.ok(prepared > 60, `${prepared} transactions were prepared`);
  });

  test(
    'one that changes a transaction all the same is refused, in words that say what it added',
    { skip: skip ?? false },
    async () => {
      const { wallet, session, saved, w } = setup(example('coin-flip-arena'));
      const s = await session();
      const batch = await s.prepare(wallet.address);
      // A wallet that adds a check of its own to every transaction, whatever the transaction sets.
      const guard = { programId: freshKeypair().address, keys: [], data: Uint8Array.of(1) };
      const meddled = batch.transactions.map(b64 => {
        const message = withAdded(readTransaction(fromBase64(b64)).message, [guard]);
        const { signatures } = readTransaction(wireTransaction(message));
        return toBase64(wireTransaction(message, signatures));
      });
      const before = w.sent?.size ?? 0;
      await assert.rejects(s.complete(wallet.address, batch.id, meddled), e => {
        assert.equal(e.status, 400);
        assert.match(
          e.message,
          /The wallet changed the transaction before signing it \(it added an instruction of the program /,
        );
        assert.ok(e.message.includes(guard.programId));
        assert.match(e.message, /so nothing was sent/);
        assert.match(e.message, /xsolana approve --keypair/);
        return true;
      });
      assert.equal(w.sent?.size ?? 0, before, 'nothing was sent');
      assert.equal(saved().live, undefined, 'and the file is as it was');
    },
  );

  test('what a wallet added is read from the two messages', () => {
    const payer = freshKeypair().address;
    const to = freshKeypair().address;
    const blockhash = freshKeypair().address;
    const ours = compileMessage({ payer, blockhash, instructions: [transferLamports(payer, to, 5n)] });
    const add = (...added) =>
      compileMessage({ payer, blockhash, instructions: [...added, transferLamports(payer, to, 5n)] });
    assert.equal(
      walletChange(ours, add(computeUnitLimit(200_000), computeUnitPrice(1000n))),
      ' (it added a compute unit limit, a compute unit price (a priority fee of its own))',
    );
    assert.equal(
      walletChange(ours, add(computeUnitPrice(1000n))),
      ' (it added a compute unit price (a priority fee of its own))',
    );
    const guard = {
      programId: to,
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      data: Uint8Array.of(9),
    };
    assert.equal(walletChange(ours, add(guard)), ` (it added an instruction of the program ${to})`);
    // Added after ours, the same.
    const after = compileMessage({ payer, blockhash, instructions: [transferLamports(payer, to, 5n), guard] });
    assert.equal(walletChange(ours, after), ` (it added an instruction of the program ${to})`);
    // Another blockhash, another amount, or nothing readable: no guess is made.
    const other = compileMessage({ payer, blockhash: payer, instructions: [transferLamports(payer, to, 5n)] });
    assert.equal(walletChange(ours, other), ' (it put another blockhash on it)');
    const more = compileMessage({ payer, blockhash, instructions: [transferLamports(payer, to, 6n)] });
    assert.equal(walletChange(ours, more), '');
    assert.equal(walletChange(ours, new Uint8Array(3)), '');
    assert.equal(walletChange(ours, ours), '');
  });
});
