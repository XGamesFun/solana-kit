// A share for a person's wallet ("wallet:<address>"): the setup opens their token account for the currency, and a
// sale and a payment pay them there. A plain wallet address used as a token account froze a shop in the live evals.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { associatedTokenAddress, NATIVE_MINT } from '../chain/pda.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-payee-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map((b64) => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('a sale and a payment pay a share to plain wallets', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'payee' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  const singer = freshKeypair();
  const artist = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, {
    version: 2,
    network: 'devnet',
    name: 'Payee test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Payee test' },
    items: [{ key: 'track', name: 'Track 01', price: 0.01, supply: 200, split: [{ to: `wallet:${singer.address}`, percent: 30 }, { to: `wallet:${artist.address}`, percent: 20 }] }],
    payments: [{ key: 'tip', name: 'Tip', amount: 0.004, split: [{ to: `wallet:${singer.address}`, percent: 50 }] }],
  });
  const singerSol = associatedTokenAddress(singer.address, NATIVE_MINT);
  const artistSol = associatedTokenAddress(artist.address, NATIVE_MINT);
  assert.equal(await w.chain.rpc.account(singerSol), null, 'going live opens no payee’s account');
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  assert.ok((await app.buy('track', { listing: (await app.shop()).find((l) => l.key === 'track') })).asset, 'the sale settles, and opens the singer’s and the artist’s SOL accounts');
  assert.equal(await w.chain.rpc.tokenBalance(singerSol), 3_000_000n);
  assert.equal(await w.chain.rpc.tokenBalance(artistSol), 2_000_000n);
  await app.pay('tip');
  assert.equal(await w.chain.rpc.tokenBalance(singerSol), 5_000_000n);
});

test('another wallet as the treasury takes what sales leave, and a tip is any amount from its least', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'treasury' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  const shelter = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, {
    version: 2,
    network: 'devnet',
    name: 'Shelter shop',
    currency: 'sol',
    treasury: `wallet:${shelter.address}`,
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Shelter shop' },
    items: [{ key: 'badge', name: 'Badge', price: 0.01, supply: 50 }],
    payments: [{ key: 'tip', name: 'Tip', amount: 0.001, any: true }, { key: 'entry', name: 'Entry', amount: 0.002 }],
  });
  const shelterSol = associatedTokenAddress(shelter.address, NATIVE_MINT);
  assert.equal(live.live.treasury, shelter.address, 'the game’s treasury is the shelter’s wallet');
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  assert.ok((await app.buy('badge', { listing: (await app.shop()).find((l) => l.key === 'badge') })).asset);
  assert.equal(await w.chain.rpc.tokenBalance(shelterSol), 10_000_000n);
  await app.pay('tip', { amount: '0.005' });
  await app.pay('tip');
  assert.equal(await w.chain.rpc.tokenBalance(shelterSol), 16_000_000n);
  await assert.rejects(app.pay('tip', { amount: '0.0005' }), /at least 0.001/);
  await assert.rejects(app.pay('entry', { amount: '0.01' }), /set amount/);
});
