// Tickets, rent to a plot, raffles and badges, through js/play on the Shelter Fair example
// (examples/shelter-fair.json): a ticket one wallet buys once, a crate whose rent goes to the plot the buyer names, a
// raffle that pays fixed beneficiaries after a timely draw, and a badge that each ticket claims once from an open
// grant.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { associatedTokenAddress, NATIVE_MINT } from '../chain/pda.js';
import { createAssociatedTokenAccountIdempotent } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import * as loot from '../client/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const SHELTER = '9F8NQski3wBvLykJTJEj896jDHXtHMUde8KGGN2sdqQa';

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
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-v010-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 8 && !session.state().done; i++) {
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

/** What a wallet holds in wrapped SOL, in lamports (0 with no account). */
const wrapped = async (w, owner) => {
  const a = await w.chain.rpc.account(associatedTokenAddress(owner, NATIVE_MINT));
  return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
};

test('Shelter Fair: one ticket a wallet, rent to the plot named, the shelter and a referrer paid after a timely draw, a badge per ticket', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'shelter' });
  w.chain.warp(NOW);
  const [owner, player, landlord, referrer] = [freshKeypair(), freshKeypair(), freshKeypair(), freshKeypair()];
  for (const k of [owner, player, landlord]) w.chain.airdrop(k.address, 100_000_000_000n);
  const spec = JSON.parse(readFileSync(new URL('../../examples/shelter-fair.json', import.meta.url), 'utf8'));
  const live = await goLive(w, owner, spec);
  assert.ok((live.live?.project ?? live.live?.game), 'live');
  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(landlord), now: () => w.chain.now() });

  // One ticket per wallet.
  const ticket = await app.buy('ticket', { listing: (await app.shop()).find((l) => l.key === 'ticket') });
  assert.ok(ticket.asset);
  await assert.rejects(app.buy('ticket', { listing: (await app.shop()).find((l) => l.key === 'ticket') }), /OverWallet/);

  // The landlord's plot, and their wrapped-SOL account to take its rent; the player opens a crate on it.
  const plot = (await theirs.buy('plot', { listing: (await theirs.shop()).find((l) => l.key === 'plot') })).asset;
  w.chain.send(landlord.address, [createAssociatedTokenAccountIdempotent(landlord.address, landlord.address, NATIVE_MINT)]);
  const before = await wrapped(w, landlord.address);
  await app.openBox('crate', { listing: (await app.boxes()).find((l) => l.key === 'crate'), chosenRecipient: plot });
  assert.equal((await wrapped(w, landlord.address)) - before, 500_000n, '10% of the 0.005 SOL crate');

  // Raffle tickets wait in escrow; the shelter and referrer are fixed for the eventual draw.
  w.chain.airdrop(referrer.address, 1_000_000_000n);
  w.chain.send(referrer.address, [createAssociatedTokenAccountIdempotent(referrer.address, referrer.address, NATIVE_MINT)]);
  const shelterBefore = await wrapped(w, SHELTER);
  await app.buyTickets('raffle', 5, { chosenRecipient: referrer.address, listing: (await app.lotteries()).find((l) => l.key === 'raffle') });
  assert.equal((await wrapped(w, SHELTER)) - shelterBefore, 0n);
  assert.equal(await wrapped(w, referrer.address), 0n);
  await assert.rejects(app.buyTickets('raffle', 6, { listing: (await app.lotteries()).find((l) => l.key === 'raffle') }), /OverWindow/, 'ten tickets a wallet a round');

  // The open grant: the ticket holder claims a badge once.
  await app.claimGrant('early-bird');
  await assert.rejects(app.claimGrant('early-bird'), /OverWallet/);
  const badges = (await app.collectibles()).filter((c) => c.item === 'badge');
  assert.equal(badges.length, 1);

  const address = loot.pda.lottery((live.live.project ?? live.live.game), live.lotteries.find((l) => l.key === 'raffle').id);
  const lottery = () => w.read('Lottery', address);
  w.chain.warp(Number(lottery().draws_at));
  await app.claim((await app.claims()).find((c) => c.kind === 'reveal'));
  while (lottery().pending > 0) await app.claim((await app.claims()).find((c) => c.kind === 'complete-draw'));
  assert.equal((await wrapped(w, SHELTER)) - shelterBefore, 2_000_000n, '20% of 0.01 SOL after settlement');
  assert.equal(await wrapped(w, referrer.address), 500_000n, '5% of 0.01 SOL to the buyer’s fixed choice');
  await app.claim((await app.claims()).find((c) => c.kind === 'prize'));
  assert.equal(lottery().status, 'Ended');
});
