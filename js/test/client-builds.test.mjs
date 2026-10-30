// What the client builds for a lottery share that burns and an open grant gated by an NFT, run on the program: each
// asserts what the client should build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOBODY = '11111111111111111111111111111111';

test('a lottery share that burns finishes through the standard builder', { skip }, () => {
  const w = world({ seed: 'review-burn-share' });
  const id = 91;
  const address = loot.pda.lottery(w.project, id);
  w.upsert({ Lottery: { id, args: { price: 1000n, mint: w.mint, shares: [{ to: 'Burn', bps: 1000 }], places: [10000], ticket_mint: NOBODY, every: 3600n, draws_at: BigInt(w.chain.now() + 3600), gate: null, per_wallet: 0 } } });
  w.chain.send(w.player, [loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery: w.read('Lottery', address), count: 1n, nonce: 1n })]);
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id })]);
  const contributionAddress = loot.pda.contribution(address, w.player, 1n);
  const contribution = w.read('LotteryContribution', contributionAddress);
  w.chain.send(w.cranker, [loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id, lottery: w.read('Lottery', address), contributionAddress, contribution, treasury: w.treasury })]);
  assert.equal(w.chain.tokens(loot.pda.pot(address)), 900n, 'the share burned, the rest in the pot');
});

test('an open grant with voucher keys and an NFT gate counts the NFT shown', { skip }, () => {
  const w = world({ seed: 'review-open-badge' });
  w.upsert({ Item: { id: 27, args: collectible('Grant badge') } });
  const badge = w.make(27, w.player);
  w.pool(1, w.mint, 100n);
  const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 41, args: { gives: { Tokens: { from: { Pool: [1] }, amount: { Fixed: [5n] } } }, vouchers: [w.authority, NOBODY, NOBODY], list_root: new Uint8Array(32), key_root: new Uint8Array(32), open: true, active: true, limits, gate: { Holds: [{ of: { Item: [27] }, key: '', test: 'Any' }] } } } });
  const address = loot.pda.grant(w.project, 41);
  const grant = w.read('Grant', address);
  const result = w.chain.send(w.player, [loot.claimGrantIx({ project: w.project, id: 41, grant, wallet: w.player, signer: w.player, poolMint: w.mint, shown: badge })]);
  assert.ok(result.receipts.some((r) => r.name === 'GrantClaimed'));
  assert.equal(loot.decodeReceipt(w.chain.get(loot.pda.badge(address, grant.incarnation, badge)).data).count, 1);
});
