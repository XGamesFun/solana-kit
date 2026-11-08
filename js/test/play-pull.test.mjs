// The player pulls: nothing waits on a server. A box opens and settles with one wallet prompt (a throwaway key the
// open funded signs the settle and hands the rest back); whatever a player is owed shows in `claims()` and they take
// it themselves; an empty lottery round is moved on by the next ticket buyer.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LOOKUP_TABLE_PROGRAM, readTable } from '../chain/lookup.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { NATIVE_MINT } from '../chain/pda.js';
import { createAssociatedTokenAccountIdempotent, withSolWrap } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

/** A wallet that counts its prompts. */
const asWallet = kp => ({
  address: kp.address,
  prompts: 0,
  async signTransaction(wire) {
    this.prompts++;
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-pull-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
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

test(
  'one prompt a box; a player finds and takes what they are owed; the next buyer moves an empty round on',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'pull' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    const player = freshKeypair();
    const rival = freshKeypair();
    for (const k of [owner, player, rival]) w.chain.airdrop(k.address, 100_000_000_000n);
    const live = await goLive(w, owner, {
      version: 2,
      network: 'devnet',
      name: 'Pull test',
      currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }],
      collection: { name: 'Pull test' },
      items: [
        { key: 'badge', name: 'Badge', price: 0.01, supply: 10 },
        { key: 'gem', name: 'Gem' },
        { key: 'art', name: 'Sunset', supply: 1 },
      ],
      pools: [{ key: 'house', currency: 'sol', seed: 1 }],
      boxes: [
        {
          key: 'chest',
          name: 'Chest',
          price: 0.02,
          split: [{ to: 'pool:house', percent: 90 }],
          outcomes: [
            { gives: 'item', item: 'gem', chance: 50 },
            { gives: 'pay', pool: 'house', amount: 0.03, chance: 50 },
          ],
        },
      ],
      lotteries: [{ key: 'daily', name: 'Daily', price: 0.001, every: '1h' }],
      auctions: [{ key: 'sunset', name: 'Sunset', lot: { item: 'art' }, reserve: 0.01, runs: '1h' }],
    });
    // Going live made the project's standing lookup table, its addresses on chain.
    assert.equal(live.live.tables?.length, 1, 'one standing table');
    const standing = readTable(
      w.chain.get(live.live.tables[0]) && { ...w.chain.get(live.live.tables[0]), owner: LOOKUP_TABLE_PROGRAM },
    );
    assert.ok(standing.addresses.includes(live.live.project) && standing.authority === owner.address);
    const wallet = asWallet(player);
    const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });
    const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(rival), now: () => w.chain.now() });

    // One prompt each: the open. The settle is the throwaway key's, which ends empty.
    const bought = await app.buy('badge', { listing: (await app.shop()).find(l => l.key === 'badge') });
    assert.ok(bought.asset);
    assert.equal(wallet.prompts, 1);
    for (let i = 0; i < 4; i++)
      assert.ok((await app.openBox('chest', { listing: (await app.boxes()).find(l => l.key === 'chest') })).settled);
    assert.equal(wallet.prompts, 5, 'five boxes, five prompts');

    // A player whose page closed after the open, before the settle: what the box rolled waits in their claims.
    assert.deepEqual(await app.claims(), []);
    const box = w.read('LootBox', loot.pda.box(live.live.project ?? live.live.game, live.boxes[0].id));
    w.chain.send(
      player.address,
      withSolWrap(player.address, NATIVE_MINT, box.price, [
        createAssociatedTokenAccountIdempotent(player.address, player.address, NATIVE_MINT),
        loot.openBoxIx({ player: player.address, project: live.live.project ?? live.live.game, box, nonce: 77n }),
      ]),
    );
    const left = await app.claims();
    assert.deepEqual(
      left.map(c => c.kind),
      ['settle'],
    );
    await app.claim(left[0]);
    assert.equal(w.chain.get(loot.pda.order(live.live.project ?? live.live.game, player.address, 77n)), null);

    // The rival bids on the auction; while it runs, there is nothing to take.
    await theirs.bid('sunset', '0.01');
    assert.deepEqual(await theirs.claims(), []);

    // A lottery: two buyers; on its date the draw shows as due, either may reveal it (the ask moves the lottery on), and the
    // winner pulls their place, which closes the round.
    await app.buyTickets('daily', 2, { listing: (await app.lotteries()).find(l => l.key === 'daily') });
    await theirs.buyTickets('daily', 1, { listing: (await theirs.lotteries()).find(l => l.key === 'daily') });
    w.chain.warp(NOW + 3_600);
    const due = await app.claims();
    assert.deepEqual(
      due.map(c => c.kind),
      ['reveal'],
    );
    await app.claim(due[0]);
    const address = loot.pda.lottery(live.live.project ?? live.live.game, live.lotteries[0].id);
    const lottery = () => w.read('Lottery', address);
    const roundAt = n => {
      const held = w.chain.get(loot.pda.round(address, lottery().incarnation, n));
      return held?.owner === loot.LOOT_PROGRAM && held.data.length ? loot.decodeRound(held.data) : null;
    };
    assert.equal(roundAt(0).status, 'Drawn');
    assert.equal(lottery().round, 1, 'the ask moved the lottery to its next round');
    const mine = (await app.claims()).find(c => c.kind === 'pull');
    const yours = (await theirs.claims()).find(c => c.kind === 'pull');
    assert.ok(Boolean(mine) !== Boolean(yours), 'whoever won sees their place');
    await (mine ? app : theirs).claim(mine ?? yours);
    assert.equal(roundAt(0), null, 'the one pull paid the place and closed the round');

    // Nobody buys the next round; at its date the next buyer moves it on in their own transaction.
    w.chain.warp(Number(lottery().terms.draws_at) + 10);
    await theirs.buyTickets('daily', 1, { listing: (await theirs.lotteries()).find(l => l.key === 'daily') });
    assert.equal(roundAt(1).sold, 1n);
    assert.ok(roundAt(1).terms.draws_at > BigInt(w.chain.now()));

    // That round has one buyer. A player who didn't win may reveal it; the winner pulls their place.
    w.chain.warp(Number(roundAt(1).terms.draws_at) + 10);
    await app.claim((await app.claims()).find(c => c.kind === 'reveal'));
    assert.equal(roundAt(1).status, 'Drawn');
    const place = (await theirs.claims()).find(c => c.kind === 'pull');
    assert.ok(place, 'the winner sees their place');
    await theirs.claim(place);
    assert.equal(roundAt(1), null, 'paid, and closed');

    // The auction (bid on at the start, below, and over by now): the winner sees it and takes it.
    const won = await theirs.claims();
    assert.deepEqual(
      won.map(c => c.kind),
      ['auction'],
    );
    await theirs.claim(won[0]);
    assert.ok((await theirs.collectibles()).some(c => c.name.startsWith('Sunset')));
  },
);
