// A payment's split may name a share the payer chooses ("chosen": a referrer): `pay` takes its shares from the payer
// each time, so the page passes the wallet (`app.pay(key, { chosenRecipient })`), never the payer's own. A
// "chosen:<item>" share stays a box's and a lottery's: `pay` can't check the collectible named is of the item. And
// js/play refuses an option a method doesn't take, so a `{ choice }` meant as `chosenRecipient` fails instead of
// sending the referrer's share to the treasury.
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
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { simulate } from '../economy/simulate.mjs';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const ARTIST = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';

const spec = (split) => ({
  version: 2,
  network: 'devnet',
  name: 'Referral entry',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'Referral entry' },
  items: [{ key: 'plot', name: 'Plot', price: 0.01, supply: 10 }],
  payments: [{ key: 'entry', name: 'Entry', amount: 0.01, split }],
});

const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, economy) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-referral-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(economy));
  const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
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

test('the checker takes a chosen wallet in a payment’s split, not a chosen collectible', () => {
  const ok = check(spec([{ to: 'chosen', percent: 10 }, { to: `wallet:${ARTIST}`, percent: 20 }]), { now: NOW });
  assert.ok(ok.ok, ok.refusals.map((r) => `${r.code} ${r.where}`).join());
  const item = check(spec([{ to: 'chosen:plot', percent: 10 }]), { now: NOW });
  assert.ok(item.refusals.some((r) => r.code === 'E-CHOSEN' && r.where === 'economy.payments.entry.split[0].to'), item.refusals.map((r) => r.code).join());
  const two = check(spec([{ to: 'chosen', percent: 10 }, { to: 'chosen', percent: 5 }]), { now: NOW });
  assert.ok(two.refusals.some((r) => r.code === 'E-CHOSEN'), 'one chosen share a split');
});

test('the explainer and the simulation say the payer names the wallet', () => {
  const economy = spec([{ to: 'chosen', percent: 10 }]);
  const ex = explainEconomy(economy, { now: NOW });
  const text = typeof ex === 'string' ? ex : ex.text ?? JSON.stringify(ex);
  assert.match(text, /the wallet the payer names \(each payment its own: a referrer; with none named, to /);
  const sim = simulate({ ...economy, scenario: { perDay: { 'payment:entry': 10 } } }, { now: NOW });
  assert.ok(JSON.stringify(sim).includes('the wallet the payer names'));
});

test('a payment pays the referrer the payer names, and nothing when none is named', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'payment-referrer' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  const referrer = freshKeypair();
  const artist = freshKeypair();
  for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
  const live = await goLive(w, owner, spec([{ to: 'chosen', percent: 10 }, { to: `wallet:${artist.address}`, percent: 20 }]));
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  const balance = async (a) => (await w.chain.rpc.account(associatedTokenAddress(a, NATIVE_MINT))) ? BigInt(await w.chain.rpc.tokenBalance(associatedTokenAddress(a, NATIVE_MINT))) : 0n;
  const treasury = live.live.treasury ?? owner.address;
  const before = await balance(treasury);

  await app.pay('entry', { chosenRecipient: referrer.address });
  assert.equal(await balance(referrer.address), 1_000_000n, 'the referrer gets 10%');
  assert.equal(await balance(artist.address), 2_000_000n, 'the artist 20%');
  assert.equal((await balance(treasury)) - before, 7_000_000n, 'the treasury the rest');

  await app.pay('entry');
  assert.equal(await balance(referrer.address), 1_000_000n, 'none named: no referrer is paid');
  assert.equal((await balance(treasury)) - before, 15_000_000n, 'and the treasury takes the chosen share');

  await assert.rejects(app.pay('entry', { chosenRecipient: player.address }), /their own wallet/);
  await assert.rejects(app.pay('entry', { choice: referrer.address }), /pay doesn’t take “choice” \(a buyer’s choice is `chosenRecipient`\)/);
  assert.equal(await balance(referrer.address), 1_000_000n, 'a refused option pays nothing');
});

test('every player method refuses an option it doesn’t take, before anything is read or signed', async () => {
  const live = { ...spec([]), live: { project: ARTIST, treasury: ARTIST } };
  const nothing = { call: async () => assert.fail('nothing is read'), accounts: async () => assert.fail('nothing is read'), account: async () => assert.fail('nothing is read') };
  const app = solanaApp({ spec: live, rpc: nothing, wallet: { address: ARTIST, signTransaction: async (x) => x } });
  await assert.rejects(app.buy('plot', { choice: ARTIST }), /buy doesn’t take “choice” \(a buyer’s choice is `chosenRecipient`\)\. It takes: .*chosenRecipient/);
  await assert.rejects(app.openBox('chest', { listing: {}, refferer: ARTIST }), /openBox doesn’t take “refferer”/);
  await assert.rejects(app.buyTickets('weekly', 1, { choice: ARTIST }), /buyTickets doesn’t take “choice” \(a buyer’s choice is `chosenRecipient`\)/);
  await assert.rejects(app.stake('farm', 1, 0, { tier: 1 }), /stake doesn’t take “tier”\. It takes: shown, extra, transfers\./);
  await assert.rejects(app.harvest('farm', ARTIST, { forfeit: true }), /harvest doesn’t take “forfeit”/);
  await assert.rejects(app.compound('farm', { compound: false }), /compound doesn’t take “compound”/);
  await assert.rejects(app.craft('melt', [], 1, { recipe: 1 }), /craft doesn’t take “recipe”/);
  await assert.rejects(app.claimGrant('gift', { vouchers: [] }), /claimGrant doesn’t take “vouchers”/);
  await assert.rejects(app.claimWins({ url: 'https://r.invalid' }), /claimWins doesn’t take “url”/);
  await assert.rejects(app.rentListing(ARTIST, { period: 2 }), /rentListing doesn’t take “period”/);
  await assert.rejects(app.collect(ARTIST, { timeout: 5 }), /collect doesn’t take “timeout”/);
  await assert.rejects(app.payNft(ARTIST, { to: null, memo: 'x' }), /payNft doesn’t take “memo”/);
  // An option given as undefined is no option: a page may pass what it doesn't have.
  await assert.rejects(app.stake('farm', 1, 0, { other: undefined }), /No farm “farm”/);
});
