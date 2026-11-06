// A settle key a page left holding the player's SOL is found again (`recover`): made again from the wallet's signature
// of a fixed text, or read from the page's storage, encrypted, when the wallet signs no messages.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import { keyring } from '../play/keys.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;

/** A wallet that signs what it is handed, counting its transaction prompts and, when it signs messages, those. */
const counting = (kp, { messages = true } = {}) => {
  const wallet = {
    address: kp.address,
    prompts: 0,
    messages: 0,
    async signTransaction(wire) {
      wallet.prompts++;
      const t = readTransaction(wire);
      const sigs = [...t.signatures];
      sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
      return wireTransaction(t.message, sigs);
    },
  };
  if (messages) {
    wallet.signMessage = async (message) => {
      wallet.messages++;
      return kp.sign(message);
    };
  }
  return wallet;
};

/** A page's storage in memory, with a device key that encrypts what it keeps. */
async function memoryStore() {
  const map = new Map();
  const device = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), remove: (k) => map.delete(k), keys: () => [...map.keys()], cryptoKey: async () => device };
}

/** An rpc that stops answering once a transaction was sent: the page closed right after the open. */
function closingAfterSend(rpc) {
  let closed = false;
  return new Proxy(rpc, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        if (closed) throw new Error('The page closed.');
        const out = await value.apply(target, args);
        if (key === 'send') closed = true;
        return out;
      };
    },
  });
}

const SPEC = {
  version: 2,
  network: 'devnet',
  name: 'Recover',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'Recover' },
  items: [{ key: 'common', name: 'Common' }, { key: 'rare', name: 'Rare' }],
  boxes: [{ key: 'booster', name: 'Booster', price: 0.01, slots: [{ count: 3 }], outcomes: [{ gives: 'item', item: 'common', weight: 9 }, { gives: 'item', item: 'rare', weight: 1 }] }],
};

async function live(w, owner) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-recover-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(SPEC));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
  for (let i = 0; i < 8 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const sigs = [...t.signatures];
      sigs[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, sigs));
    }));
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('a settle key is the same from the same signature, another for another order; a wallet whose signature changes gets stored keys', async () => {
  const kp = freshKeypair();
  const wallet = counting(kp);
  const project = freshKeypair().address;
  const [a, b] = [freshKeypair().address, freshKeypair().address];
  const one = keyring({ wallet, project });
  const two = keyring({ wallet, project });
  assert.equal((await one.key(a)).address, (await two.again(a)).address, 'made again in another session');
  assert.notEqual((await one.key(a)).address, (await one.key(b)).address);
  assert.equal(wallet.messages, 2, 'one signature a session');
  assert.equal(await two.again(b, { ask: false }).then((k) => k.address), (await one.key(b)).address, 'no prompt once signed this session');
  // A wallet that signs the text differently each time (randomized): its later sessions can't make the keys again, so
  // they are stored, encrypted.
  const store = await memoryStore();
  let n = 0;
  const shifting = { address: kp.address, signMessage: async (m) => Uint8Array.from(kp.sign(m), (x, i) => (i === 0 ? x ^ ++n : x)) };
  assert.equal(await keyring({ wallet: shifting, project, store }).how(), 'derived', 'first seen: taken as it is');
  const later = keyring({ wallet: shifting, project, store });
  assert.equal(await later.how(), 'stored', 'a different signature next session');
  const key = await later.key(a);
  assert.deepEqual(later.stored(), [a]);
  assert.ok(![...store.map.values()].some((v) => v.includes(key.address)));
  assert.equal((await keyring({ wallet: shifting, project, store }).again(a)).address, key.address, 'read back from storage');
  assert.equal(await keyring({ wallet: { address: kp.address }, project, store: null }).how(), 'memory');
});

for (const how of ['derived', 'stored']) {
  test(`a page that closes after the open: the key is ${how === 'derived' ? 'made again from the wallet’s signature' : 'read back from the page’s storage'} and settles with no prompt`, { skip }, async () => {
    const w = world({ project: false, seed: `recover-${how}` });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    const player = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    w.chain.airdrop(player.address, 100_000_000_000n);
    const spec = await live(w, owner);
    const wallet = counting(player, { messages: how === 'derived' });
    const keyStore = how === 'stored' ? await memoryStore() : null;
    const first = solanaApp({ spec, rpc: closingAfterSend(w.chain.rpc), wallet, now: () => w.chain.now(), keyStore });
    const listing = (await first.boxes()).find((l) => l.key === 'booster');
    await assert.rejects(first.openBox('booster', { listing }), /page closed/);
    assert.equal(wallet.prompts, 1);
    w.chain.nextSlot();
    const again = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now(), keyStore });
    const got = await again.recover();
    assert.equal(got.length, 1, JSON.stringify(got, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.ok(got[0].settled, 'settled by the key');
    assert.equal(got[0].won.length, 3);
    assert.equal(wallet.prompts, 1, 'no transaction prompt');
    if (how === 'derived') assert.equal(wallet.messages, 2, 'one signature a session');
    else assert.deepEqual(keyStore.keys(), [], 'the stored key is dropped once empty');
    assert.equal(BigInt(await w.chain.rpc.balance(got[0].key)), 0n, 'the key gave back what it held');
    assert.equal((await again.collectibles()).length, 3);
    assert.deepEqual(await again.recover(), [], 'nothing left to recover');
  });
}
