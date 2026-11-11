// A wallet that adds to what it signs (Phantom adds its own checks, instructions of the Lighthouse program): the
// approval takes the wallet's own message only when everything prepared is in it untouched and what was added is a
// wallet's own, and sends that. Anything else is refused, as any change was before.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freshKeypair, verifySignature } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { walletAdded } from '../approve/wallet-adds.mjs';
import { encodeBase58 } from '../chain/base58.js';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM, SYSTEM_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, computeUnitPrice, requestHeapFrame, transferLamports } from '../chain/programs.js';
import { compileMessage, readMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { approvalChain, cannotRun, pinned, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const example = name => JSON.parse(readFileSync(path.join(ROOT, 'examples', `${name}.json`), 'utf8'));
const address = () => freshKeypair().address;

/** A check of the wallet's own: an instruction of the Lighthouse program that reads `reads` (and writes `writes`). */
const check = ({ reads = [], writes = [], signs = [], data = [9, 9] } = {}) => ({
  programId: LIGHTHOUSE_PROGRAM,
  keys: [
    ...signs.map(pubkey => ({ pubkey, isSigner: true, isWritable: true })),
    ...writes.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
    ...reads.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
  ],
  data: Uint8Array.from(data),
});

describe('what a wallet may add to a transaction', () => {
  const wallet = address();
  const blockhash = address();
  const pool = address();
  const mint = address();
  const program = address();
  // The prepared transaction: its own compute budget, a payment, and a program's instruction that writes one account
  // and only reads another.
  const prepared = [
    computeUnitLimit(1_400_000),
    computeUnitPrice(1n),
    transferLamports(wallet, pool, 5_000_000n),
    {
      programId: program,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
      ],
      data: Uint8Array.of(7, 1, 2, 3),
    },
  ];
  const message = (instructions, options = {}) =>
    compileMessage({ payer: wallet, blockhash, instructions, ...options });
  const ours = message(prepared);
  const judged = (instructions, options) => walletAdded(ours, message(instructions, options), wallet);
  const refused = (instructions, pattern, options) => {
    const r = judged(instructions, options);
    assert.equal(r.ok, false, `taken: ${JSON.stringify(r.added)}`);
    assert.match(r.why, pattern);
  };

  test('its own checks, wherever it puts them, and a compute budget the transaction does not set', () => {
    const stranger = address();
    for (const [what, instructions] of Object.entries({
      'a check after': [...prepared, check()],
      'a check before': [check(), ...prepared],
      'checks between': [prepared[0], check(), prepared[1], prepared[2], check({ reads: [stranger] }), prepared[3]],
      'a check that reads the accounts of the prepared instructions': [
        ...prepared,
        check({ reads: [pool, mint, wallet] }),
      ],
      'a check that writes an account of its own, paid by the wallet': [
        check({ signs: [wallet], writes: [stranger] }),
        ...prepared,
      ],
    })) {
      const r = judged(instructions);
      assert.equal(r.ok, true, `${what}: ${r.why}`);
      assert.match(r.added.join(', '), /^\d checks? of its own \(the Lighthouse program’s\)$/, what);
    }
    assert.deepEqual(judged([...prepared, check(), check(), check()]).added, [
      '3 checks of its own (the Lighthouse program’s)',
    ]);
    assert.deepEqual(judged([requestHeapFrame(64 * 1024), ...prepared, check()]).added, [
      'a heap size',
      '1 check of its own (the Lighthouse program’s)',
    ]);
    // A transaction that sets no price of its own may be given one (this package's own setups always set one).
    const bare = message(prepared.slice(2));
    const priced = walletAdded(
      bare,
      message([computeUnitLimit(200_000), computeUnitPrice(5000n), ...prepared.slice(2)]),
      wallet,
    );
    assert.deepEqual(priced.added, ['a compute unit limit', 'a compute unit price (a priority fee of its own)']);
  });

  test('never another program’s instruction: a payment out of the wallet above all', () => {
    const thief = address();
    refused(
      [...prepared, transferLamports(wallet, thief, 1_000_000_000n)],
      new RegExp(`added an instruction of the program ${SYSTEM_PROGRAM}`),
    );
    refused([transferLamports(wallet, thief, 1n), ...prepared, check()], /added an instruction of the program 1111/);
    refused(
      [...prepared, { programId: program, keys: [], data: Uint8Array.of(1) }],
      new RegExp(`added an instruction of the program ${program}`),
    );
    refused(
      [...prepared, { programId: address(), keys: [], data: Uint8Array.of(1) }],
      /added an instruction of the program /,
    );
  });

  test('never a change to what was prepared: its data, its accounts, its order, or one left out', () => {
    const [limit, price, pay, call] = prepared;
    const other = address();
    // (each with a check added too: an added check never covers a change)
    refused(
      [limit, price, transferLamports(wallet, pool, 5_000_001n), call, check()],
      /changed, dropped or moved one of the prepared instructions/,
    );
    refused([limit, price, transferLamports(wallet, other, 5_000_000n), call, check()], /changed, dropped or moved/);
    refused([limit, price, pay, { ...call, data: Uint8Array.of(7, 1, 2, 4) }, check()], /changed, dropped or moved/);
    refused(
      [limit, price, pay, { ...call, keys: [call.keys[0], call.keys[2], call.keys[1]] }, check()],
      /changed, dropped or moved/,
    );
    refused([limit, price, pay, { ...call, keys: call.keys.slice(0, 2) }, check()], /changed, dropped or moved/);
    refused([limit, price, pay, { ...call, programId: other }, check()], /changed, dropped or moved/);
    refused([limit, price, call, pay, check()], /changed, dropped or moved/);
    refused([limit, price, pay, check()], /changed, dropped or moved/);
    refused([check(), check()], /changed, dropped or moved/);
    // Its own compute budget changed (a higher price on all the units the transaction asks for) is a change too.
    refused([limit, computeUnitPrice(5_000_000n), pay, call, check()], /changed, dropped or moved/);
    refused([computeUnitLimit(200_000), price, pay, call, check()], /changed, dropped or moved/);
    // The same instructions and nothing added, in other bytes: not this rule's to take.
    refused(prepared, /changed the transaction’s accounts/, { blockhash });
  });

  test('never an account of the prepared instructions made writable, or no longer so', () => {
    // The mint is only read by what was prepared. A check that asks to write it makes it writable for all of them.
    refused(
      [...prepared, check({ writes: [mint] })],
      new RegExp(
        `changed what the account ${mint} is in the transaction \\(it could only be read, and can now be written\\)`,
      ),
    );
    // (and an account that is the wallet's check's alone may be written)
    assert.equal(judged([...prepared, check({ writes: [address()] })]).ok, true);
    // A program of the prepared instructions asked for as a writable account.
    refused([...prepared, check({ writes: [program] })], new RegExp(`changed what the account ${program} is`));
    // Writable in what was prepared and only read in what came back: by hand, since nothing here builds one. The
    // message's last number is how many of its unsigned accounts are read-only; one more takes the pool's place.
    const added = message([...prepared, check()]);
    const parts = readMessage(added);
    assert.equal(parts.header.numReadonlyUnsigned, 5, 'the mint and the four programs');
    const order = parts.keys.indexOf(pool);
    assert.ok(order > 0 && order === parts.keys.length - parts.header.numReadonlyUnsigned - 1, 'the last writable one');
    const demoted = added.slice();
    demoted[2] = 6;
    const r = walletAdded(ours, demoted, wallet);
    assert.equal(r.ok, false);
    assert.match(
      r.why,
      new RegExp(`changed what the account ${pool} is in the transaction \\(it could be written, and no longer can\\)`),
    );
  });

  test('never a second limit or price: the network refuses a transaction that sets one twice', () => {
    refused(
      [computeUnitPrice(50_000n), ...prepared],
      /added a second compute unit price.*the network refuses one that sets it twice/,
    );
    refused([...prepared, computeUnitLimit(200_000)], /added a second compute unit limit/);
    refused([requestHeapFrame(64 * 1024), requestHeapFrame(32 * 1024), ...prepared], /added a second heap size/);
    refused(
      [...prepared, { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8) }],
      /a compute budget instruction of a kind not known here/,
    );
    refused(
      [...prepared, { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new Uint8Array(0) }],
      /of a kind not known here/,
    );
  });

  test('never another signer, fee payer or blockhash, a lookup table, or a transaction another key signs too', () => {
    const other = address();
    refused([...prepared, check()], /put another blockhash on it/, { blockhash: other });
    refused([...prepared, check({ signs: [other] })], /added a signer/);
    assert.equal(
      walletAdded(ours, compileMessage({ payer: other, blockhash, instructions: [...prepared, check()] }), wallet).ok,
      false,
    );
    assert.match(
      walletAdded(
        ours,
        compileMessage({ payer: other, blockhash, instructions: [...prepared.slice(0, 2), check()] }),
        wallet,
      ).why,
      /put another fee payer on it|added a signer/,
    );
    // v0, with or without a table: its accounts can't all be compared by address.
    refused([...prepared, check()], /loads accounts from a lookup table/, { version: 0, lookupTables: [] });
    const table = { address: address(), addresses: [pool, mint, program] };
    refused([...prepared, check()], /loads accounts from a lookup table/, { version: 0, lookupTables: [table] });
    // A transaction a new account's own key signed as it was prepared: the wallet's message would leave that
    // signature behind.
    const fresh = address();
    const made = [
      ...prepared,
      { programId: program, keys: [{ pubkey: fresh, isSigner: true, isWritable: true }], data: Uint8Array.of(1) },
    ];
    const two = message(made);
    const r = walletAdded(two, message([...made, check()]), wallet);
    assert.equal(r.ok, false);
    assert.match(r.why, /changed a transaction that another key signs too/);
    // Prepared for one wallet, judged for another.
    assert.equal(walletAdded(ours, message([...prepared, check()]), other).ok, false);
    // Not a transaction at all, or cut short.
    assert.match(walletAdded(ours, new Uint8Array(3), wallet).why, /not a transaction/);
    assert.match(walletAdded(ours, message([...prepared, check()]).slice(0, -3), wallet).why, /not a transaction/);
    assert.equal(walletAdded(new Uint8Array(3), message([...prepared, check()]), wallet).ok, false);
  });

  test('an account named twice, or a header that does not add up, is not compared at all', () => {
    const added = message([...prepared, check()]);
    const parts = readMessage(added);
    // The header: [signers, read-only signers, read-only others]. More read-only signers than signers, more
    // read-only others than there are, no signer.
    for (const header of [
      [1, 1, parts.header.numReadonlyUnsigned],
      [1, 0, parts.keys.length],
      [0, 0, parts.header.numReadonlyUnsigned],
    ]) {
      const bent = added.slice();
      bent.set(header, 0);
      const r = walletAdded(ours, bent, wallet);
      assert.equal(r.ok, false, header.join());
    }
    // The same address twice in the list of accounts (the second in place of the last account).
    const twice = added.slice();
    const first = 4; // header (3) and the count of accounts (1)
    twice.set(added.slice(first + 32, first + 64), first + 32 * (parts.keys.length - 1));
    const r = walletAdded(ours, twice, wallet);
    assert.equal(r.ok, false);
    assert.match(r.why, /names an account twice/);
  });
});

/** The instructions of a legacy message as they were built. */
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

describe('the approval, with a wallet that adds its own checks', () => {
  /**
   * A wallet as Phantom is said to be: to a transaction nobody has signed yet it adds a check of its own, an
   * instruction of the Lighthouse program, and signs what it then holds; one a new account's key signed already it
   * signs as it stands. `adds(instructions, wire)`: what it puts on, by default one check at the end.
   */
  function addingWallet(adds = instructions => [...instructions, check({ data: [...Buffer.from('balance ok')] })]) {
    const key = freshKeypair();
    const wallet = {
      address: key.address,
      changed: 0,
      signAll: wires =>
        wires.map(b64 => {
          let { message, signatures, signers } = readTransaction(fromBase64(b64));
          if (signers.length === 1) {
            const m = readMessage(message);
            message = compileMessage({
              payer: m.keys[0],
              blockhash: m.blockhash,
              instructions: adds(instructionsOf(message), m.keys[0]),
            });
            ({ signatures, signers } = readTransaction(wireTransaction(message)));
            wallet.changed++;
          }
          const sigs = [...signatures];
          sigs[signers.indexOf(key.address)] = key.sign(message);
          return toBase64(wireTransaction(message, sigs));
        }),
    };
    return wallet;
  }

  function setup(spec, wallet) {
    const w = world({ project: false, seed: 'wallet-adds' });
    w.chain.warp(NOW);
    // The Lighthouse program is not among the pinned ones: a program that takes any words and no accounts stands at
    // its address, so a check of the wallet's runs and passes.
    w.chain.svm.addProgramWithLoader(
      LIGHTHOUSE_PROGRAM,
      pinned('memo.so'),
      'BPFLoader2111111111111111111111111111111111',
    );
    w.chain.airdrop(wallet.address, 100_000_000_000n);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-adds-')), 'xsolana.json');
    writeFileSync(file, JSON.stringify(spec, null, 2));
    const sent = [];
    const chain = approvalChain(w, { send: async wire => (sent.push(wire), w.chain.sendWire(wire)) });
    return {
      w,
      file,
      sent,
      session: () => createApproval({ file, chain, now: () => NOW }),
      saved: () => JSON.parse(readFileSync(file, 'utf8')),
    };
  }

  test(
    'a whole setup and a change go live as the wallet signed them, and the page is told what it added',
    { skip: skip ?? false },
    async () => {
      const wallet = addingWallet();
      const { w, file, sent, session, saved } = setup(example('coin-flip-arena'), wallet);
      const first = await session();
      let state = first.state();
      for (let i = 0; i < 10 && !state.done; i++) {
        const batch = await first.prepare(wallet.address);
        state = await first.complete(wallet.address, batch.id, wallet.signAll(batch.transactions));
      }
      assert.equal(state.done, true);
      assert.ok(wallet.changed >= 3, `the wallet added to ${wallet.changed} transactions`);
      const live = saved();
      assert.ok(live.live.project && !live.live.partial, 'live');
      assert.equal(w.read('Project', live.live.project).owner, wallet.address);
      // What was sent is what the wallet signed: each changed one carries its check, and the wallet's own signature
      // is the one recorded for it.
      const checked = sent.filter(wire =>
        instructionsOf(readTransaction(wire).message).some(ix => ix.programId === LIGHTHOUSE_PROGRAM),
      );
      assert.equal(checked.length, wallet.changed);
      for (const wire of checked) {
        const t = readTransaction(wire);
        assert.deepEqual(t.signers, [wallet.address]);
        assert.ok(
          verifySignature(wallet.address, t.message, t.signatures[0]),
          'the wallet’s signature of its own message',
        );
        assert.ok(
          live.live.transactions.some(x => x.signature === encodeBase58(t.signatures[0])),
          'recorded by that signature',
        );
      }
      assert.equal(live.live.transactions.length, sent.length);
      assert.equal(state.walletAdded.length, wallet.changed);
      assert.match(
        state.walletAdded[0],
        /^Transaction \d+ of this batch: your wallet added 1 check of its own \(the Lighthouse program’s\)\.$/,
      );

      // A change to the live economy: one transaction, the wallet its one signer.
      writeFileSync(
        file,
        JSON.stringify({ ...live, pools: [...live.pools, { key: 'bonus', currency: 'sol' }] }, null, 2),
      );
      const change = await session();
      const before = wallet.changed;
      const batch = await change.prepare(wallet.address);
      await change.complete(wallet.address, batch.id, wallet.signAll(batch.transactions));
      assert.equal(wallet.changed, before + 1);
      assert.ok(saved().live.published.pools.some(p => p.key === 'bonus'));
    },
  );

  test('a wallet that adds a payment of its own among its checks sends nothing', { skip: skip ?? false }, async () => {
    const thief = freshKeypair().address;
    // The payment is out of the wallet itself, and the wallet signs it: only this rule stands between it and the
    // chain.
    const wallet = addingWallet((instructions, payer) => [
      ...instructions,
      check(),
      transferLamports(payer, thief, 1_000_000n),
    ]);
    const { w, sent, session, saved } = setup(example('coin-flip-arena'), wallet);
    const s = await session();
    const batch = await s.prepare(wallet.address);
    const signed = wallet.signAll(batch.transactions);
    assert.ok(wallet.changed >= 1 && wallet.changed < batch.transactions.length, 'some changed, the first not');
    await assert.rejects(s.complete(wallet.address, batch.id, signed), e => {
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(`it added an instruction of the program ${SYSTEM_PROGRAM}`));
      assert.match(e.message, /so nothing was sent/);
      return true;
    });
    assert.equal(sent.length, 0, 'not even the transactions of the batch that were not changed');
    assert.equal(saved().live, undefined);
    assert.equal(BigInt(await w.chain.rpc.balance(thief)), 0n);
  });
});
