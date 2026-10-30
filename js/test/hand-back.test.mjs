// A Token Metadata NFT the project holds, given to a wallet that is an account of the loot program (the owner wrote a
// loot address: here the project's fee box), goes back to its player instead (`price::given_to`): a box fate's Give at
// settle, and an NFT lottery ticket's price after the draw. Its `token` is then the player's token account
// (`handBack`), which the client passes once it reads the wallet's owner. On the real program and the real Token
// Metadata, through the builders and js/play.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cannotRun, drop } from './world.mjs';
import { nftOf, setup } from './tm-chain.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;
const DAY = 86_400;
const NOBODY = '11111111111111111111111111111111';
const tm = { tokenMetadata: { programmable: false } };
const app = (w, spec) => solanaApp({
  spec: { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, ...spec },
  rpc: w.chain.rpc, wallet: { address: w.player, async signTransaction(wire) { return wire; } }, now: () => w.chain.now(),
});

test('handsBack: a wallet whose account is the loot program’s', () => {
  assert.equal(loot.handsBack({ owner: loot.LOOT_PROGRAM }), true);
  assert.equal(loot.handsBack({ owner: NOBODY }), false);
  assert.equal(loot.handsBack(null), false);
});

test('a box’s fate giving the Token Metadata NFT rolled on to the fee box sends it back to its player, into their token account', { skip }, async () => {
  const { w, maker, club } = setup('hand-back-settle');
  const nft = nftOf(w, maker, w.player, club);
  const feeBox = pda.fees(w.project);
  assert.equal(loot.handsBack(w.chain.get(feeBox)), true, 'the fee box is the loot program’s');
  const subject = { of: { Collection: [club] }, key: '', test: 'Any' };
  const args = { price: 0n, currency: w.mint, rise: null, fall: null, stock_odds: false, active: true, shares: [], entries: [drop([])], gate: null, odds: [], subject, fates: [{ entry: 0, shifts: [], then: { Give: [feeBox] } }] };
  w.upsert({ Box: { id: 4, args } });
  const box = w.read('LootBox', pda.box(w.project, 4));
  w.chain.send(w.player, [computeUnitLimit(1_400_000), loot.openBoxIx({ player: w.player, project: w.project, box, nonce: 1n, subject: { asset: nft, ...tm } })]);
  const orderAddress = [loot.nonceOn(nft), 1n].map((n) => pda.order(w.project, w.player, n)).find((a) => w.chain.get(a));
  const order = w.read('Order', orderAddress);
  assert.deepEqual([order.held, order.status, w.chain.tokens(loot.ata(w.project, nft))], [true, 'Rolled', 1n], 'the project holds it until the settle');
  w.chain.nextSlot();
  // Built as before (the fee box's token account as the piece's), the settle fails and moves nothing; it can be sent again.
  const settle = (handBack) => [computeUnitLimit(1_400_000), loot.settleIx({ signer: w.cranker, orderAddress, order, projectState: w.projectState(), subject: tm, handBack })];
  assert.throws(() => w.chain.send(w.cranker, settle(false)));
  assert.equal(w.chain.tokens(loot.ata(w.project, nft)), 1n);
  // js/play reads the fee box's owner and passes the player's token account.
  await app(w, { boxes: [{ key: 'mirror', id: 4, name: 'Mirror' }] }).collect(orderAddress);
  assert.equal(w.chain.get(orderAddress), null, 'settled');
  assert.equal(w.chain.tokens(loot.ata(w.player, nft)), 1n, 'the NFT is back with its player');
  assert.equal(w.chain.get(loot.ata(feeBox, nft)), null, 'nothing went to the fee box');
});

test('an NFT lottery ticket whose price gives it to the fee box goes back to its buyer after the draw', { skip }, async () => {
  const { w, maker, club } = setup('hand-back-lottery');
  const ticket = nftOf(w, maker, w.player, club);
  const feeBox = pda.fees(w.project);
  const id = 1;
  const address = pda.lottery(w.project, id);
  const rule = { of: { Collection: [club] }, key: '', test: 'Any' };
  w.upsert({ Lottery: { id, args: { price: 0n, mint: w.mint, shares: [], places: [10_000], ticket_mint: NOBODY, every: BigInt(DAY), draws_at: BigInt(w.chain.now() + DAY), gate: null, per_wallet: 0, nft_ticket: { rule, then: { Give: [feeBox] } }, min_sold: 1n } } });
  w.chain.send(w.player, [computeUnitLimit(1_400_000), loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery: w.read('Lottery', address), count: 1n, nonce: 1n, nft: { asset: ticket, ...tm } })]);
  assert.equal(w.chain.tokens(loot.ata(w.project, ticket)), 1n, 'the project holds the ticket');
  w.chain.warp(w.chain.now() + DAY);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id })]);
  assert.equal(w.read('Lottery', address).status, 'Drawn');
  const contributionAddress = pda.contribution(address, w.player, 1n);
  // Built as before (the fee box's token account), the step fails and moves nothing.
  const finish = (handBack) => [computeUnitLimit(1_400_000), loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id, lottery: w.read('Lottery', address), contributionAddress, contribution: w.read('LotteryContribution', contributionAddress), treasury: w.treasury, ticket: tm, handBack })];
  assert.equal(loot.lotteryStep(w.read('Lottery', address), w.read('LotteryContribution', contributionAddress)), 'finish');
  assert.throws(() => w.chain.send(w.cranker, finish(false)));
  assert.equal(w.chain.tokens(loot.ata(w.project, ticket)), 1n);
  // js/play's claim reads the fee box's owner and passes the buyer's token account.
  const player = app(w, { lotteries: [{ key: 'raffle', name: 'Raffle', id }] });
  const step = (await player.claims()).find((c) => c.kind === 'complete-draw');
  assert.ok(step);
  await player.claim(step);
  assert.equal(w.chain.tokens(loot.ata(w.player, ticket)), 1n, 'the ticket is back with its buyer');
  assert.equal(w.chain.get(loot.ata(feeBox, ticket)), null, 'nothing went to the fee box');
});
