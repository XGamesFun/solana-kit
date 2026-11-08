// What the client builds for a lottery share that burns and an open grant gated by an NFT, run on the program: each
// asserts what the client should build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOBODY = '11111111111111111111111111111111';

test("a lottery share that burns is burned at the round's close, the rest in the pot", { skip }, () => {
  const w = world({ seed: 'review-burn-share' });
  const id = 91;
  const address = loot.pda.lottery(w.project, id);
  w.upsert({
    Lottery: {
      id,
      args: {
        price: 1000n,
        mint: w.mint,
        pays_from: { Pot: [0] },
        shares: [{ to: 'Burn', bps: 1000 }],
        places: [10000],
        ticket_mint: NOBODY,
        every: 3600n,
        draws_at: BigInt(w.chain.now() + 3600),
        gate: null,
        per_wallet: 0,
      },
    },
  });
  const lottery = w.read('Lottery', address);
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery, count: 1n })]);
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id, lottery })]);
  const supply = () =>
    w.chain
      .get(w.mint)
      .data.subarray(36, 44)
      .reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n);
  const before = supply();
  w.finishRound(id);
  assert.equal(w.chain.tokens(loot.ata(w.player, w.mint)) > 0n, true);
  assert.equal(before - supply(), 100n, 'the burn share burned at the close');
  assert.equal(w.round(id), null, 'the round closed');
});

test('an open grant with voucher keys and an NFT gate counts the NFT shown', { skip }, () => {
  const w = world({ seed: 'review-open-badge' });
  w.upsert({ Item: { id: 27, args: collectible('Grant badge') } });
  const badge = w.make(27, w.player);
  w.pool(1, w.mint, 100n);
  const limits = {
    wallet: { total: 1, per_window: 0, window: 0 },
    per_person: 0,
    per_key: 0,
    all: { total: 0, per_window: 0, window: 0 },
    window: { opens_at: 0n, closes_at: 0n },
  };
  w.upsert({
    Grant: {
      id: 41,
      args: {
        gives: { Tokens: { from: { Pool: [1] }, amount: 5n } },
        vouchers: [w.authority, NOBODY, NOBODY],
        list_root: new Uint8Array(32),
        key_root: new Uint8Array(32),
        open: true,
        active: true,
        limits,
        gate: { Holds: [{ of: { Item: [27] }, key: '', test: 'Any' }] },
      },
    },
  });
  const address = loot.pda.grant(w.project, 41);
  const grant = w.read('Grant', address);
  const result = w.chain.send(w.player, [
    loot.claimGrantIx({
      project: w.project,
      id: 41,
      grant,
      wallet: w.player,
      signer: w.player,
      poolMint: w.mint,
      shown: badge,
    }),
  ]);
  assert.ok(result.receipts.some(r => r.name === 'GrantClaimed'));
  // The badge is counted in the grant's claims by its own key, never as a person.
  const claims = loot.readListAccount(w.chain.get(loot.pda.claims(address, grant.incarnation, 0)));
  assert.equal(loot.readLimit(claims, loot.limitKey('badge', badge)).count, 1);
  assert.equal(loot.readLimit(claims, loot.limitKey('person', badge)).count, 0);
});
