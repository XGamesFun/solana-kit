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
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { solanaApp } from '../play/index.js';
import * as loot from '../client/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const SHELTER = '9F8NQski3wBvLykJTJEj896jDHXtHMUde8KGGN2sdqQa';

const asWallet = kp => ({
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
    const signed = batch.transactions.map(b64 => {
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

test(
  'Shelter Fair: one ticket a wallet, rent to the plot named, the shelter and a referrer paid after a timely draw, a badge per ticket',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'shelter' });
    w.chain.warp(NOW);
    const [owner, player, landlord, referrer] = [freshKeypair(), freshKeypair(), freshKeypair(), freshKeypair()];
    for (const k of [owner, player, landlord]) w.chain.airdrop(k.address, 100_000_000_000n);
    const spec = JSON.parse(readFileSync(new URL('../../examples/shelter-fair.json', import.meta.url), 'utf8'));
    const live = await goLive(w, owner, spec);
    assert.ok(live.live?.project ?? live.live?.game, 'live');
    const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
    const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(landlord), now: () => w.chain.now() });

    // One ticket per wallet.
    const ticket = await app.buy('ticket', { listing: (await app.shop()).find(l => l.key === 'ticket') });
    assert.ok(ticket.asset);
    await assert.rejects(
      app.buy('ticket', { listing: (await app.shop()).find(l => l.key === 'ticket') }),
      /OverWallet/,
    );

    // The landlord's plot, and their wrapped-SOL account to take its rent; the player opens a crate on it.
    const plot = (await theirs.buy('plot', { listing: (await theirs.shop()).find(l => l.key === 'plot') })).asset;
    w.chain.send(landlord.address, [
      createAssociatedTokenAccountIdempotent(landlord.address, landlord.address, NATIVE_MINT),
    ]);
    const before = await wrapped(w, landlord.address);
    await app.openBox('crate', { listing: (await app.boxes()).find(l => l.key === 'crate'), chosenRecipient: plot });
    assert.equal((await wrapped(w, landlord.address)) - before, 500_000n, '10% of the 0.005 SOL crate');

    // Raffle tickets wait in the round's own account; the referrer the buyer chose is paid as they buy, and the shelter's
    // share waits for the draw.
    w.chain.airdrop(referrer.address, 1_000_000_000n);
    w.chain.send(referrer.address, [
      createAssociatedTokenAccountIdempotent(referrer.address, referrer.address, NATIVE_MINT),
    ]);
    const shelterBefore = await wrapped(w, SHELTER);
    await app.buyTickets('raffle', 5, {
      chosenRecipient: referrer.address,
      listing: (await app.lotteries()).find(l => l.key === 'raffle'),
    });
    assert.equal((await wrapped(w, SHELTER)) - shelterBefore, 0n);
    assert.equal(await wrapped(w, referrer.address), 500_000n, '5% of 0.01 SOL to the buyer’s choice, as they buy');
    await assert.rejects(
      app.buyTickets('raffle', 6, { listing: (await app.lotteries()).find(l => l.key === 'raffle') }),
      /OverWindow/,
      'ten tickets a wallet a round',
    );

    // The open grant: the ticket holder claims a badge once.
    await app.claimGrant('early-bird');
    await assert.rejects(app.claimGrant('early-bird'), /OverWallet/);
    const badges = (await app.collectibles()).filter(c => c.item === 'badge');
    assert.equal(badges.length, 1);

    const address = loot.pda.lottery(
      live.live.project ?? live.live.game,
      live.lotteries.find(l => l.key === 'raffle').id,
    );
    const lottery = () => w.read('Lottery', address);
    w.chain.warp(Number(lottery().terms.draws_at));
    await app.claim((await app.claims()).find(c => c.kind === 'reveal'));
    // The ask moved the lottery on: drawn once, it has ended. The place and the shelter's share are pulled, in any order.
    assert.equal(lottery().round, 1, 'drawn once: it has ended');
    await app.claim((await app.claims()).find(c => c.kind === 'pull'));
    await app.claim((await app.claims()).find(c => c.kind === 'payout'));
    assert.equal((await wrapped(w, SHELTER)) - shelterBefore, 2_000_000n, '20% of 0.01 SOL, pulled in common');
    assert.deepEqual(
      (await app.claims()).filter(c => c.key === 'raffle'),
      [],
      'everyone paid, the round closed',
    );
    assert.equal((await app.lotteries()).find(l => l.key === 'raffle').status, 'Ended');
  },
);

test(
  'a raffle of 130 NFTs from its own stash: its winner pulls them through claims(), each pull on the largest heap',
  { skip: skip ?? false },
  async () => {
    // A pull that takes several Core NFTs out of a round's own stash outgrows the default heap from about 125 raffled
    // places (8 NFTs a pull): js/play asks for the largest heap for it, as for a run of rolls.
    const w = world({ seed: 'raffle-130' });
    w.upsert({
      Item: {
        id: 1,
        args: {
          kind: 'Collectible',
          rarity: 3,
          soulbound: false,
          burnable: false,
          name: 'Art',
          uri: 'https://example.invalid/art.json',
          max_supply: 0,
          active: true,
        },
      },
    });
    const PLACES = 130;
    const t0 = w.chain.now();
    const id = 2;
    const address = loot.pda.lottery(w.project, id);
    const nfts = Array.from({ length: PLACES }, () => ({ asset: w.make(1, w.authority), collection: w.collection }));
    for (const [first, ...more] of loot.stashBatches(nfts))
      w.chain.send(w.authority, [
        computeUnitLimit(1_400_000),
        loot.stashIx({ signer: w.authority, project: w.project, lottery: id, ...first, more }),
      ]);
    w.upsert({
      Lottery: {
        id,
        args: {
          price: 1000n,
          mint: w.mint,
          pays_from: { Pot: [0] },
          shares: [],
          places: [{ bps: 0, prize: 'Raffled', times: PLACES }],
          ticket_mint: '11111111111111111111111111111111',
          every: 0n,
          draws_at: BigInt(t0 + 3600),
          gate: null,
        },
      },
    });
    // A rival holds most tickets; the player holds 16 of 136, and wins 8 places or more.
    const lottery = w.read('Lottery', address);
    const rival = w.who();
    w.fund(rival, w.mint, 1_000_000n);
    for (const [who, count] of [
      [rival, 120n],
      [w.player, 16n],
    ])
      w.chain.send(who, [loot.buyTicketsIx({ player: who, project: w.project, id, lottery, mint: w.mint, count })]);
    w.chain.warp(t0 + 3601);
    w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id, lottery })]);
    const app = solanaApp({
      spec: {
        version: 2,
        currency: 'coin',
        tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }],
        live: { project: w.project, collection: w.collection },
        lotteries: [{ key: 'raffle', name: 'Raffle', id }],
      },
      rpc: w.chain.rpc,
      wallet: { address: w.player, signTransaction: async wire => wire },
      now: () => w.chain.now(),
    });
    const r = w.round(id).round;
    const mine = r.entries.findIndex(e => e.buyer === w.player);
    const won = loot.prizePlacesOwed(r, mine, 0).length;
    assert.ok(won >= 8, `the player won ${won} places`);
    const owner = asset => parseCoreAsset(w.chain.get(asset).data).owner;
    for (let i = 0; i < 8; i++) {
      const step = (await app.claims()).find(c => c.kind === 'pull' && c.key === 'raffle');
      if (!step) break;
      await app.claim(step);
    }
    assert.equal(nfts.filter(n => owner(n.asset) === w.player).length, won, 'every place the player won, its NFT');
  },
);
