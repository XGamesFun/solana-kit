// toKitInstruction and fromKitInstruction: a builder's instruction in @solana/kit's shape and back, every account's
// signer and writable flags kept as Kit's AccountRole numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFeesIx, fromKitInstruction, KIT_ACCOUNT_ROLE, toKitInstruction } from '../client/index.js';

const admin = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
const to = '11111111111111111111111111111111';

test('a builder’s instruction in @solana/kit’s shape, and back unchanged', () => {
  const ix = collectFeesIx({ admin, to, projects: [] });
  const kit = toKitInstruction(ix);
  assert.equal(kit.programAddress, ix.programId);
  assert.equal(kit.data, ix.data);
  assert.deepEqual(
    kit.accounts.map(a => a.address),
    ix.keys.map(k => k.pubkey),
  );
  for (const [i, k] of ix.keys.entries()) {
    const role = kit.accounts[i].role;
    assert.equal((role & 2) !== 0, k.isSigner, `account ${i} signer`);
    assert.equal((role & 1) !== 0, k.isWritable, `account ${i} writable`);
  }
  assert.deepEqual(fromKitInstruction(kit), ix);
});

test('every role number is Kit’s AccountRole', () => {
  const ix = {
    programId: admin,
    keys: [
      { pubkey: 'a', isSigner: false, isWritable: false },
      { pubkey: 'b', isSigner: false, isWritable: true },
      { pubkey: 'c', isSigner: true, isWritable: false },
      { pubkey: 'd', isSigner: true, isWritable: true },
    ],
    data: Uint8Array.of(1, 2),
  };
  assert.deepEqual(
    toKitInstruction(ix).accounts.map(a => a.role),
    [
      KIT_ACCOUNT_ROLE.READONLY,
      KIT_ACCOUNT_ROLE.WRITABLE,
      KIT_ACCOUNT_ROLE.READONLY_SIGNER,
      KIT_ACCOUNT_ROLE.WRITABLE_SIGNER,
    ],
  );
  assert.deepEqual(fromKitInstruction({ programAddress: admin }), {
    programId: admin,
    keys: [],
    data: new Uint8Array(),
  });
});
