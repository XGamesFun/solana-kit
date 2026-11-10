// The rules a client sees of "the rules are strict": written odds, whole prizes, edits that lose nothing, deadlines by the
// clock, missed runs, an owed seller and the program's caps, each run on the real program where it can be.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { computeUnitLimit, meta } from '../chain/programs.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, mintToIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { LIMITS } from '../economy/model.mjs';
import { explain, simulate } from '../economy/simulate.mjs';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { boxArgs, cannotRun, collectible, drop, fromPool, itemDrop, PRICE, program, world } from './world.mjs';

const skip = cannotRun() ?? false;
const pda = loot.pda;
const NOW = 1_790_000_000;
const NOBODY = '11111111111111111111111111111111';
const WALLET = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const refused = spec => check(spec, { now: NOW }).refusals;
const box = (w, id) => w.read('LootBox', pda.box(w.project, id));
const never = {
  wallet: { total: 0, per_window: 0, window: 0 },
  per_person: 0,
  per_key: 0,
  all: { total: 0, per_window: 0, window: 0 },
  window: { opens_at: 0n, closes_at: 0n },
};
const fails = (fn, name) => assert.throws(fn, e => (e.logs ?? []).join(' ').includes(name) || e.message.includes(name));

/** A plain economy to add a part to. */
const base = (more = {}) => ({
  version: 2,
  network: 'devnet',
  name: 'Strict',
  currency: 'gem',
  tokens: [{ key: 'gem', source: 'project', name: 'Gem', symbol: 'GEM', decimals: 6 }],
  collection: { name: 'Strict' },
  items: [
    { key: 'relic', name: 'Relic', supply: 1 },
    { key: 'shard', name: 'Shard' },
  ],
  pools: [
    { key: 'prizes', currency: 'gem', seed: 100 },
    { key: 'other', currency: 'gem', seed: 100 },
  ],
  ...more,
});

// ---------------------------------------------------------------- a share of a pool as a prize

test('a share of a pool as a prize is refused on every route, in words, with the way to do it', () => {
  const share = { gives: 'share', pool: 'prizes', percent: 10 };
  const specs = {
    'economy.boxes[0].outcomes[0]': {
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [
            { ...share, chance: 50 },
            { gives: 'nothing', chance: 50 },
          ],
        },
      ],
    },
    'economy.boxes[0].outcomes[0].prizes[1]': {
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [{ gives: 'bundle', prizes: [{ gives: 'item', item: 'shard' }, share], chance: 100 }],
        },
      ],
    },
    'economy.recipes[0].out[0]': { recipes: [{ key: 'r', name: 'R', in: [], out: [share] }] },
    'economy.grants[0].prize': { grants: [{ key: 'g', name: 'G', prize: share, fund: 1 }] },
    'economy.lotteries[0].places[0].prize': {
      lotteries: [{ key: 'l', pot: 0, name: 'L', price: 1, every: '1d', places: [{ percent: 50, prize: share }, 50] }],
    },
    'economy.farms[0].tiers[0].prize': {
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'collectibles',
          rewards: 'gem',
          tiers: [{ lock: '1d', multiplier: 1, prize: share }],
        },
      ],
    },
    'economy.contests[0].prize': { contests: [{ key: 'c', name: 'C', sides: 2, entriesClose: '1d', prize: share }] },
  };
  for (const [where, parts] of Object.entries(specs)) {
    const said = refused(base(parts));
    const mine = said.find(r => r.code === 'E-SHARE-PRIZE');
    assert.equal(mine?.where, where, JSON.stringify(said));
    assert.match(mine.message, /a share of a pool as a prize/);
    assert.match(mine.fix, /fixed amount/);
    assert.match(mine.fix, /lottery/);
    assert.ok(
      !said.some(r => r.code === 'E-SCHEMA' && r.where.startsWith(where)),
      'said once, not again by the schema',
    );
  }
});

test('a fixed prize is written as a plain number, as the program takes it', { skip }, () => {
  const w = world({ seed: 'strict-plain-prize' });
  w.pool(1, w.mint, 100n);
  w.upsert({ Box: { id: 1, args: boxArgs(0n, [drop([fromPool(1, 7)])]) } });
  assert.deepEqual(box(w, 1).entries[0].prizes[0].Tokens.amount, 7n);
});

// ---------------------------------------------------------------- written odds

/** Burns all a pool holds, as the project's keys may at any time: another route emptying an entry after a purchase. */
const drain = (w, pool) =>
  w.chain.send(w.authority, [
    loot.moveTokensIx({
      authority: w.authority,
      project: w.project,
      mint: w.mint,
      from: { Pool: [pool] },
      to: 'Burn',
      amount: { Bps: [10_000] },
    }),
  ]);
/** The oracle's answer to `orderAddress`, sent by hand (the purchase went with `sendRaw`, which leaves it unanswered). */
const answer = (w, orderAddress, more = {}) =>
  w.chain.sendRaw(w.chain.oracle, [
    computeUnitLimit(400_000),
    loot.callbackRollIx({
      order: orderAddress,
      orderState: w.read('Order', orderAddress),
      box: w.read('LootBox', w.read('Order', orderAddress).loot_box),
      randomness: new Uint8Array(32).fill(5),
      ...more,
    }),
  ]);

test(
  'an entry drawn that another route emptied after the purchase makes no draw: a paid order fails and refunds, whatever else is in stock',
  { skip },
  () => {
    const w = world({ seed: 'strict-written-odds' });
    w.upsert({ Item: { id: 1, args: collectible('Crown') } });
    w.pool(1, w.mint, 5n);
    // All but always the pool's entry: re-weighing among what is in stock would give the crown every time.
    w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([fromPool(1, 5)], 1_000_000_000), itemDrop(1)]) } });
    const before = w.balance(w.player);
    w.chain.sendRaw(w.player, [
      loot.openBoxIx({ player: w.player, project: w.project, box: box(w, 1), nonce: 1n, poolMints: { 1: w.mint } }),
    ]);
    const address = pda.order(w.project, w.player, 1n);
    drain(w, 1);
    answer(w, address, { poolMints: { 1: w.mint } });
    const order = w.read('Order', address);
    assert.equal(order.status, 'Failed', 'no other entry took its place');
    assert.deepEqual(order.won, []);
    assert.equal(order.reserved, 0n, 'the answer took its draws out of the box’s count');
    assert.equal(box(w, 1).in_flight, 0n);
    w.chain.nextSlot();
    assert.equal(loot.orderRefundable(order, w.chain.slot(), w.chain.now()), true);
    w.chain.send(w.cranker, [loot.refundIx({ signer: w.cranker, orderAddress: address, order })]);
    assert.equal(w.balance(w.player), before, 'the price back');
  },
);

test(
  'a pack whose draws land on what another route emptied gives back those draws’ worth at the settle',
  { skip },
  () => {
    const w = world({ seed: 'strict-pack-back' });
    w.upsert({ Item: { id: 1, args: collectible('Card') } });
    // A box that stops selling sells only while the pool covers every draw of the purchase: 8 × 5.
    w.pool(1, w.mint, 40n);
    const price = 8_000n;
    w.upsert({
      Box: {
        id: 1,
        args: boxArgs(price, [itemDrop(1), drop([fromPool(1, 5)])], {
          slots: [{ count: 8, only: [], distinct: false, share: 0 }],
        }),
      },
    });
    const before = w.balance(w.player);
    w.chain.sendRaw(w.player, [
      computeUnitLimit(1_400_000),
      loot.openBoxIx({ player: w.player, project: w.project, box: box(w, 1), nonce: 1n, poolMints: { 1: w.mint } }),
    ]);
    const address = pda.order(w.project, w.player, 1n);
    assert.equal(w.read('Order', address).reserved, 8n);
    drain(w, 1);
    const items = { 1: w.read('Item', pda.item(w.project, 1)) };
    answer(w, address, { poolMints: { 1: w.mint }, items });
    const order = w.read('Order', address);
    assert.equal(order.status, 'Rolled');
    const made = order.won.length;
    assert.ok(made > 0 && made < 8, `some of the eight land on each: ${made}`);
    assert.equal(order.undrawn, 8 - made);
    assert.ok(
      order.won.every(x => x.Item),
      'only the card is given, no other entry in the pool’s place',
    );
    w.chain.nextSlot();
    w.chain.send(w.authority, [
      computeUnitLimit(1_400_000),
      loot.settleIx({ signer: w.authority, orderAddress: address, order, projectState: w.projectState(), items }),
    ]);
    assert.equal(before - w.balance(w.player), (price * BigInt(made)) / 8n, 'what was not drawn came back');
  },
);

test('with no draw made a free roll goes back to waiting, and rolls again once it can be given', { skip }, () => {
  const w = world({ seed: 'strict-free-waits' });
  w.upsert({ Item: { id: 1, args: collectible('Crown') } });
  w.pool(1, w.mint);
  w.upsert({
    Box: { id: 1, args: boxArgs(0n, [drop([fromPool(1, 5)], 1_000_000_000), itemDrop(1)], { active: false }) },
  });
  w.upsert({
    Grant: {
      id: 1,
      args: {
        gives: { Roll: [1] },
        vouchers: [NOBODY, NOBODY, NOBODY],
        list_root: new Uint8Array(32),
        limits: never,
        active: true,
        gate: null,
        open: true,
      },
    },
  });
  const grant = w.read('Grant', pda.grant(w.project, 1));
  w.chain.send(w.player, [
    computeUnitLimit(1_400_000),
    loot.claimGrantIx({ project: w.project, id: 1, wallet: w.player, signer: w.player, grant, nonce: 9n }),
  ]);
  const address = pda.order(w.project, w.player, loot.prizeRollNonce(9n));
  assert.equal(w.read('Order', address).status, 'Waiting');
  w.chain.nextSlot();
  w.chain.send(
    w.authority,
    loot.askRollIx({
      payer: w.authority,
      orderAddress: address,
      order: w.read('Order', address),
      box: box(w, 1),
      poolMints: { 1: w.mint },
    }),
  );
  const after = w.read('Order', address);
  assert.equal(after.status, 'Waiting', 'not rolled, and no other entry given');
  assert.equal(
    loot.rollAskable(after, after.requested_slot, w.chain.now()),
    false,
    'not again in the slot of its last ask',
  );
  assert.equal(loot.rollAskable(after, after.requested_slot + 1n, w.chain.now()), true);
});

test(
  'an outcome that names a pool twice, or a stash’s random NFT beside the stash, is caught before anything is written',
  { skip },
  () => {
    const pay = amount => ({ gives: 'pay', pool: 'prizes', amount });
    const nft = n => ({ gives: 'nft', stash: 'vault', nft: n });
    const stashes = [
      {
        key: 'vault',
        name: 'Vault',
        nfts: [
          { asset: WALLET, collection: WALLET },
          { asset: NOBODY, collection: WALLET },
        ],
      },
    ];
    const outcome = prizes =>
      base({
        stashes,
        boxes: [
          {
            key: 'b',
            name: 'B',
            price: 1,
            outcomes: [
              { gives: 'bundle', prizes, chance: 50 },
              { gives: 'nothing', chance: 50 },
            ],
          },
        ],
      });
    const clash = prizes =>
      refused(outcome(prizes)).filter(r => /BadEntries/.test(r.message) && /prizes\[1\]/.test(r.where));
    assert.match(clash([pay(1), pay(2)])[0].message, /pool “prizes” twice/);
    assert.match(
      clash([
        { gives: 'stash', stash: 'vault' },
        { gives: 'stash', stash: 'vault' },
      ])[0].message,
      /two random NFTs/,
    );
    assert.match(clash([{ gives: 'stash', stash: 'vault' }, nft(WALLET)])[0].message, /beside a named one/);
    assert.match(clash([nft(WALLET), nft(WALLET)])[0].message, /twice/);
    assert.deepEqual(clash([nft(WALLET), nft(NOBODY)]), [], 'two named NFTs of one stash');
    assert.deepEqual(clash([pay(1), { gives: 'pay', pool: 'other', amount: 1 }]), [], 'two pools');
    assert.deepEqual(
      clash([
        { gives: 'item', item: 'shard' },
        { gives: 'item', item: 'shard' },
      ]),
      [],
      'two of an item is how it gives two',
    );
    // Two of an item its supply can never give is said, and left to the owner.
    const twice = check(
      outcome([
        { gives: 'item', item: 'relic' },
        { gives: 'item', item: 'relic' },
      ]),
      { now: NOW },
    ).warnings;
    assert.ok(
      twice.some(x => x.code === 'W-OUT-OF-STOCK' && /supply of 1/.test(x.message)),
      JSON.stringify(twice.map(x => x.code)),
    );

    // The program agrees on each.
    const w = world({ seed: 'strict-entries' });
    w.upsert({ Item: { id: 1, args: collectible('Crown') } });
    w.pool(1, w.mint, 100n);
    const write = prizes => () => w.upsert({ Box: { id: 2, args: boxArgs(1n, [drop(prizes), itemDrop(1)]) } });
    fails(write([fromPool(1, 1), fromPool(1, 2)]), 'BadEntries');
    fails(write([{ Stash: [1] }, { Stash: [1] }]), 'BadEntries');
    fails(write([{ Stash: [1] }, { Nft: { stash: 1, nft: WALLET } }]), 'BadEntries');
    fails(write([{ Nft: { stash: 1, nft: WALLET } }, { Nft: { stash: 1, nft: WALLET } }]), 'BadEntries');
    write([{ Item: [1] }, { Item: [1] }])();
  },
);

test('the words describe written odds, not re-weighing, and what the box does once an outcome runs out', () => {
  const spec = base({
    boxes: [
      {
        key: 'b',
        name: 'Crate',
        price: 1,
        split: [{ to: 'pool:prizes', percent: 50 }],
        outcomes: [
          { gives: 'pay', pool: 'prizes', amount: 5, chance: 10 },
          { gives: 'item', item: 'relic', chance: 90 },
        ],
      },
    ],
  });
  const text = explainEconomy(spec, { now: NOW }).text;
  const sim = explain(simulate(spec, { now: NOW }), spec);
  for (const said of [text, sim]) {
    assert.match(said, /stops selling/);
    assert.match(said, /odds as written/);
    assert.match(said, /no other outcome taking its place/);
    assert.match(said, /refunded/);
    assert.doesNotMatch(said, /never comes up/);
  }
  assert.match(text, /An edit of the box’s roll fails a purchase still waiting/);
  assert.doesNotMatch(text, /refunds 0|never refunded while/);
});

// ---------------------------------------------------------------- edits, and an unanswered roll

test('an edit fails a purchase that holds a payment; a roll won elsewhere rolls on the box as edited', { skip }, () => {
  const w = world({ seed: 'strict-edits' });
  w.upsert({ Item: { id: 1, args: collectible('Crown') } });
  w.upsert({ Item: { id: 2, args: collectible('Sceptre') } });
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(1, 1), itemDrop(2, 1)]) } });
  // A purchase whose answer hasn't come, and a roll a grant gave, waiting.
  w.chain.sendRaw(w.player, [loot.openBoxIx({ player: w.player, project: w.project, box: box(w, 1), nonce: 1n })]);
  const bought = pda.order(w.project, w.player, 1n);
  w.upsert({
    Grant: {
      id: 1,
      args: {
        gives: { Roll: [1] },
        vouchers: [NOBODY, NOBODY, NOBODY],
        list_root: new Uint8Array(32),
        limits: never,
        active: true,
        gate: null,
        open: true,
      },
    },
  });
  const grant = w.read('Grant', pda.grant(w.project, 1));
  w.chain.send(w.player, [
    computeUnitLimit(1_400_000),
    loot.claimGrantIx({ project: w.project, id: 1, wallet: w.player, signer: w.player, grant, nonce: 9n }),
  ]);
  const won = pda.order(w.project, w.player, loot.prizeRollNonce(9n));
  const old = box(w, 1);
  // Now only the sceptre.
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(2)]) } });
  const edited = box(w, 1);
  assert.notEqual(edited.version, old.version);

  const order = w.read('Order', bought);
  const items = { 1: w.read('Item', pda.item(w.project, 1)), 2: w.read('Item', pda.item(w.project, 2)) };
  w.chain.sendRaw(w.chain.oracle, [
    computeUnitLimit(400_000),
    loot.callbackRollIx({
      order: bought,
      orderState: order,
      box: edited,
      randomness: new Uint8Array(32).fill(3),
      items,
    }),
  ]);
  assert.equal(w.read('Order', bought).status, 'Failed', 'its payment back');

  w.chain.nextSlot();
  w.chain.send(
    w.authority,
    [
      computeUnitLimit(1_400_000),
      ...loot.askRollIx({ payer: w.authority, orderAddress: won, order: w.read('Order', won), box: edited, items }),
    ].filter(x => x.programId),
  );
  const rolled = w.read('Order', won);
  assert.equal(rolled.status, 'Rolled', 'rolled on the box as it is now, nothing lost');
  assert.deepEqual(
    rolled.won.map(x => x.Item.item),
    [2],
  );
});

test(
  'an asked roll that holds a payment may leave after a week of silence, counted from its first ask',
  { skip },
  () => {
    const w = world({ seed: 'strict-asked-refund' });
    w.upsert({ Item: { id: 1, args: collectible('Crown') } });
    w.upsert({ Box: { id: 1, args: boxArgs(0n, [itemDrop(1, 1)], { active: false }) } });
    const now = w.chain.now();
    w.chain.send(w.authority, [
      computeUnitLimit(600_000),
      loot.openAuctionIx({
        seller: w.authority,
        project: w.project,
        id: 1,
        mint: w.mint,
        args: {
          lot: { Roll: [1] },
          reserve: 1n,
          min_raise_bps: 0,
          starts_at: BigInt(now),
          ends_at: BigInt(now + 60),
          extend: 0,
          shares: [],
          gate: null,
          nft_bids: null,
        },
      }),
    ]);
    const address = pda.auction(w.project, w.authority, 1);
    w.chain.send(w.player, [
      loot.bidIx({ bidder: w.player, project: w.project, id: 1, auction: w.read('Auction', address), amount: PRICE }),
    ]);
    const before = w.balance(w.player);
    w.chain.warp(now + 61);
    const auction = w.read('Auction', address);
    w.chain.send(w.cranker, [
      computeUnitLimit(800_000),
      loot.endAuctionIx({ signer: w.cranker, project: w.project, projectState: w.projectState(), id: 1, auction }),
    ]);
    const orderAddress = pda.order(
      w.project,
      w.player,
      loot.prizeRollNonce(loot.prizeNonce(address, BigInt(auction.last_bid_at))),
    );
    assert.equal(w.read('Order', orderAddress).status, 'Waiting');
    w.chain.nextSlot();
    w.chain.sendRaw(
      w.player,
      loot.askRollIx({
        payer: w.player,
        orderAddress,
        order: w.read('Order', orderAddress),
        box: box(w, 1),
        items: { 1: w.read('Item', pda.item(w.project, 1)) },
      }),
    );
    const asked = w.read('Order', orderAddress);
    assert.equal(asked.status, 'Asked');
    assert.ok(asked.paid > 0n && asked.first_asked_at > 0n);
    w.chain.warp(Number(asked.first_asked_at) + Number(loot.LOTTERY_TIMEOUT_SECONDS));
    w.chain.nextSlot();
    assert.equal(loot.orderRefundable(asked, w.chain.slot(), w.chain.now()), false);
    fails(
      () => w.chain.send(w.cranker, [loot.refundIx({ signer: w.cranker, orderAddress, order: asked })]),
      'NotStale',
    );
    w.chain.warp(w.chain.now() + 1);
    w.chain.nextSlot();
    assert.equal(loot.orderRefundable(asked, w.chain.slot(), w.chain.now()), true);
    w.chain.send(w.cranker, [loot.refundIx({ signer: w.cranker, orderAddress, order: asked })]);
    assert.equal(w.balance(w.player), before + PRICE, 'the winning bid back');
  },
);

test('a live roll changed says a purchase is refunded and a roll won elsewhere is not lost', () => {
  const spec = base({
    boxes: [
      {
        key: 'b',
        name: 'B',
        price: 1,
        outcomes: [
          { gives: 'item', item: 'shard', chance: 50 },
          { gives: 'nothing', chance: 50 },
        ],
      },
    ],
  });
  const { ...published } = structuredClone(spec);
  const changed = { ...structuredClone(spec), live: { program: loot.LOOT_PROGRAM, project: WALLET, published } };
  changed.boxes[0].outcomes[0].chance = 40;
  changed.boxes[0].outcomes[1].chance = 60;
  const said = check(changed, { now: NOW }).warnings.find(x => x.code === 'W-LIVE-ROLLS').message;
  assert.match(said, /gets its payment back/);
  assert.match(said, /holds no payment and rolls on the box as it is then/);
  assert.doesNotMatch(said, /refunds 0|loses it/);
});

// ---------------------------------------------------------------- schedules

test('a run missed is missed: one sent late pays once; a sealed fixed amount pays every run due', { skip }, () => {
  const w = world({ seed: 'strict-schedules' });
  w.pool(1, w.mint, 10_000n);
  const payee = w.who();
  w.tokenAccount(payee, w.mint);
  const start = BigInt(w.chain.now() + 10);
  const action = { from: { Pool: [1] }, to: { Wallet: [payee] }, amount: { Fixed: [100n] }, halve_every: 0 };
  w.upsert({
    Schedule: { id: 1, args: { active: true, action, every: 60n, next_at: start, max_runs: 0, sealed: false } },
  });
  w.chain.warp(Number(start) + 300);
  const schedule = w.read('Schedule', pda.schedule(w.project, 1));
  assert.equal(loot.scheduleCatchesUp(schedule), false);
  assert.equal(loot.runsDue(schedule, w.chain.now()), 6);
  w.chain.send(w.authority, [
    loot.runScheduleIx({ payer: w.authority, project: w.project, id: 1, schedule, poolMint: w.mint, upto: 2 }),
  ]);
  assert.equal(w.balance(payee), 100n, 'once, whatever upto says');
  assert.equal(
    loot.runsDue(w.read('Schedule', pda.schedule(w.project, 1)), w.chain.now()),
    0,
    'the runs before it lapsed',
  );

  // Sealed: a promise nobody can take back pays what it promised.
  const vest = w.who();
  w.tokenAccount(vest, w.mint);
  const sealed = { from: { Vest: [w.mint] }, to: { Wallet: [vest] }, amount: { Fixed: [50n] }, halve_every: 0 };
  const at = BigInt(w.chain.now() + 10);
  w.upsert({
    Schedule: { id: 2, args: { active: true, action: sealed, every: 60n, next_at: at, max_runs: 100, sealed: true } },
  });
  const vault = pda.vest(pda.schedule(w.project, 2));
  w.chain.send(w.creator, [mintToIx({ mint: w.mint, to: vault, authority: w.creator, amount: 5_000n })]);
  w.chain.warp(Number(at) + 240);
  const promised = w.read('Schedule', pda.schedule(w.project, 2));
  assert.equal(loot.scheduleCatchesUp(promised), true);
  const due = loot.runsDue(promised, w.chain.now(), 5_000n);
  assert.equal(due, 5);
  w.chain.send(vest, [
    computeUnitLimit(400_000),
    loot.runScheduleIx({ payer: vest, project: w.project, id: 2, schedule: promised, upto: Number(promised.runs) + 2 }),
  ]);
  assert.equal(w.balance(vest), 100n, 'up to upto, each paid');
  w.chain.send(vest, [
    computeUnitLimit(400_000),
    loot.runScheduleIx({
      payer: vest,
      project: w.project,
      id: 2,
      schedule: w.read('Schedule', pda.schedule(w.project, 2)),
    }),
  ]);
  assert.equal(w.balance(vest), 250n, 'and the rest');
});

test('the words on a schedule say a run missed is missed, and only a sealed fixed amount catches up', () => {
  const pays = { key: 'drip', does: 'move', from: 'prizes', to: 'other', amount: 1, every: '1d' };
  const said = explainEconomy(base({ schedules: [pays] }), { now: NOW }).text;
  assert.match(said, /a run missed is missed/);
  assert.match(
    explain(simulate(base({ schedules: [pays] }), { now: NOW }), base({ schedules: [pays] })),
    /a run missed is missed/,
  );
  const vest = {
    key: 'vest',
    does: 'pay',
    sealed: true,
    fund: 100,
    to: `wallet:${WALLET}`,
    amount: 1,
    every: '1d',
    maxRuns: 100,
    currency: 'gem',
  };
  assert.match(
    explainEconomy(base({ schedules: [vest] }), { now: NOW }).text,
    /a run sent late pays every run due since/,
  );
});

// ---------------------------------------------------------------- auctions

test(
  'a sale too wide for one end, or a seller whose account can’t take the money: the lot goes first, the auction stays open owing the bid, and the next end pays it and closes it',
  { skip },
  async () => {
    const w = world({ seed: 'strict-owed' });
    // A coin whose freeze authority is the owner, as an issuer's can be.
    const coin = newAddress(w.random);
    w.chain.send(w.creator, [
      createAccountIx({
        from: w.creator,
        address: coin,
        lamports: w.chain.rent(MINT_BYTES),
        space: MINT_BYTES,
        owner: TOKEN_PROGRAM,
      }),
      initializeMint2Ix({ mint: coin, decimals: 6, authority: w.creator, freezeAuthority: w.creator }),
    ]);
    w.upsert({ Item: { id: 1, args: collectible('Painting') } });
    const seller = w.who();
    const now = w.chain.now();
    const bidder = w.who();
    w.fund(bidder, coin, 1_000n);
    // Two paintings, each auctioned and won with 500.
    const sales = [1, 2].map(id => {
      const painting = w.make(1, seller);
      const open = loot.openAuctionIx({
        seller,
        project: w.project,
        collection: w.collection,
        id,
        mint: coin,
        args: {
          lot: { Asset: [painting] },
          reserve: 1n,
          min_raise_bps: 0,
          starts_at: BigInt(now),
          ends_at: BigInt(now + 60),
          extend: 0,
          shares: [],
          gate: null,
          nft_bids: null,
        },
      });
      w.chain.send(seller, [computeUnitLimit(400_000), open]);
      const address = pda.auction(w.project, seller, id);
      w.chain.send(bidder, [
        loot.bidIx({ bidder, project: w.project, id, auction: w.read('Auction', address), amount: 500n }),
      ]);
      return { id, painting, address };
    });
    w.chain.warp(now + 61);
    // The seller's account of the coin, frozen by its issuer.
    const account = w.tokenAccount(seller, coin);
    const freeze = op =>
      w.chain.send(w.creator, [
        {
          programId: TOKEN_PROGRAM,
          keys: [meta(account, false, true), meta(coin, false, false), meta(w.creator, true, false)],
          data: Uint8Array.of(op),
        },
      ]);
    freeze(10);

    const end = ({ id, address }, ending) =>
      loot.endAuctionIx({
        signer: w.cranker,
        project: w.project,
        projectState: w.projectState(),
        id,
        auction: w.read('Auction', address),
        collection: w.collection,
        ending,
      });
    const { parseCoreAsset } = await import('../chain/core.js');
    // The first sends its lot first: the whole bid is owed, whatever the seller's account says.
    const first = w.chain.send(w.cranker, [computeUnitLimit(800_000), end(sales[0], 'LotFirst')]);
    assert.deepEqual(
      first.receipts.map(r => r.name),
      ['AuctionEnded'],
    );
    assert.equal(first.receipts[0].data.remainder, 0n, 'nothing paid yet');
    // The second ends in one go: the lot goes, and what the seller's account can't take is owed.
    w.chain.send(w.cranker, [computeUnitLimit(800_000), end(sales[1], 'Deliver')]);
    for (const sale of sales) {
      assert.equal(w.read('Auction', sale.address).proceeds_owed, 500n, 'still open, owing it');
      assert.equal(parseCoreAsset(w.chain.get(sale.painting).data).owner, bidder, 'the winner has the lot');
      // The lot moved: the sale stands.
      assert.throws(() => end(sale, 'CallOff'), /CantCallOff/);
    }
    assert.equal(w.chain.tokens(account), 0n);
    for (const sale of sales)
      assert.throws(
        () => w.chain.send(w.cranker, [computeUnitLimit(800_000), end(sale, 'Deliver')]),
        'it fails while the account can’t take it',
      );

    freeze(11);
    for (const sale of sales) {
      w.chain.send(w.cranker, [computeUnitLimit(800_000), end(sale, 'Deliver')]);
      assert.equal(w.chain.get(sale.address), null, 'closed');
    }
    assert.equal(w.chain.tokens(account), 1_000n, 'paid for both');
  },
);

// ---------------------------------------------------------------- lotteries

test('a stranger’s pull is refused when a named stash NFT is gone; its winner passes it over', { skip }, async () => {
  const w = world({ seed: 'strict-pull' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const relic = w.make(1, w.authority);
  w.chain.send(w.authority, [
    loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset: relic, collection: w.collection }),
  ]);
  const id = 7;
  const address = pda.lottery(w.project, id);
  const places = [
    { bps: 0, prize: { Nft: { stash: 1, nft: relic } }, times: 1 },
    { bps: 10_000, prize: null, times: 1 },
  ];
  w.upsert({
    Lottery: {
      id,
      args: {
        terms: {
          price: 1000n,
          mint: w.mint,
          pays_from: { Pot: [0] },
          shares: [],
          places,
          ticket_mint: NOBODY,
          draws_at: BigInt(w.chain.now() + 60),
          min_sold: 0n,
        },
        every: 0n,
        gate: null,
        per_wallet: 0,
      },
    },
  });
  w.chain.send(w.player, [
    loot.buyTicketsIx({ player: w.player, project: w.project, id, lottery: w.read('Lottery', address), count: 2n }),
  ]);
  w.chain.warp(w.chain.now() + 61);
  w.chain.send(w.cranker, [
    computeUnitLimit(600_000),
    loot.drawLotteryIx({ payer: w.cranker, project: w.project, id, lottery: w.read('Lottery', address) }),
  ]);
  const { address: roundAddress, round } = w.round(id);
  assert.equal(round.status, 'Drawn');
  // The authority takes the NFT out before it is pulled.
  w.chain.send(w.authority, [
    loot.stashIx({
      signer: w.authority,
      project: w.project,
      id: 1,
      asset: relic,
      collection: w.collection,
      out: w.authority,
    }),
  ]);
  const pull = payer => [
    computeUnitLimit(1_400_000),
    loot.pullIx({
      payer,
      project: w.project,
      roundAddress,
      round: w.round(id).round,
      entry: 0,
      part: { Prize: [0] },
      projectState: w.projectState(),
      prize: { stash: null, nfts: { [relic]: { collection: w.collection } }, collection: w.collection },
    }),
  ];
  fails(() => w.chain.send(w.cranker, pull(w.cranker)), 'PrizeNotCovered');
  // A stranger's payout from the page pays what it can, and leaves that one for its winner.
  const spec = {
    version: 2,
    name: 'Pull',
    currency: 'gem',
    tokens: [{ key: 'gem', source: 'existing', mint: w.mint, decimals: 6 }],
    live: { project: w.project, collection: w.collection },
    lotteries: [{ key: 'l', pot: 0, id, name: 'L' }],
  };
  const stranger = solanaApp({
    spec,
    rpc: w.chain.rpc,
    wallet: {
      address: w.cranker,
      async signTransaction(wire) {
        return wire;
      },
    },
    now: () => w.chain.now(),
  });
  const payout = (await stranger.claims()).find(c => c.kind === 'payout');
  assert.ok(payout);
  await stranger.claim(payout);
  const left = w.round(id).round;
  assert.deepEqual(loot.partsOwed(left, 0), [{ Prize: [0] }], 'only the prize its winner may pass over');
  const winner = solanaApp({
    spec,
    rpc: w.chain.rpc,
    wallet: {
      address: w.player,
      async signTransaction(wire) {
        return wire;
      },
    },
    now: () => w.chain.now(),
  });
  const mine = (await winner.claims()).find(c => c.kind === 'pull');
  await winner.claim(mine);
  assert.equal(w.round(id), null, 'its winner passed it over, and the round closed');
});

test('a lottery of more runs than the program takes is refused; one at the cap is not', () => {
  const places = n => Array.from({ length: n }, () => 0.5);
  const spec = n => base({ lotteries: [{ key: 'l', pot: 0, name: 'L', price: 1, every: '1d', places: places(n) }] });
  assert.ok(
    refused(spec(LIMITS.lotteryRuns + 1)).some(
      r => r.code === 'E-LOTTERY' && r.where.endsWith('.places') && /BadLottery/.test(r.message),
    ),
  );
  assert.ok(
    !refused(spec(LIMITS.lotteryRuns)).some(r => r.where.endsWith('.places') && /runs of places/.test(r.message)),
  );
});

// ---------------------------------------------------------------- recipes, farms, caps

test('a raise with no cap works, again and again', { skip }, () => {
  const w = world({ seed: 'strict-raise' });
  w.upsert({ Item: { id: 1, args: collectible('Sword') } });
  const sword = w.make(1, w.player, [{ key: 'level', value: '1' }]);
  w.upsert({
    Recipe: {
      id: 1,
      args: {
        active: true,
        inputs: [{ Use: { item: 1 } }],
        outputs: [],
        needs: [],
        keeps: [],
        raises: [{ place: 0, shift: { key: 'level', by: 1, most: 0, from_now: false } }],
        window: { opens_at: 0n, closes_at: 0n },
        per_wallet: { total: 0, per_window: 0, window: 0 },
      },
    },
  });
  const recipe = () => w.read('Recipe', pda.recipe(w.project, 1));
  for (let i = 0; i < 2; i++)
    w.chain.send(w.player, [
      computeUnitLimit(800_000),
      loot.craftIx({
        player: w.player,
        project: w.project,
        collection: w.collection,
        id: 1,
        recipe: recipe(),
        assets: [sword],
      }),
    ]);
  // No warning that it never raises: 0 means no cap.
  const spec = base({
    recipes: [
      {
        key: 'r',
        name: 'R',
        in: [{ takes: 'use', item: 'shard' }],
        out: [],
        raises: [{ place: 0, key: 'level', by: 1 }],
      },
    ],
  });
  assert.ok(!check(spec, { now: NOW }).warnings.some(x => x.code === 'W-RECIPE' && /maxed out/.test(x.message)));
});

test('a tier with a prize needs a lock', { skip }, () => {
  const spec = lock =>
    base({
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'collectibles',
          rewards: 'gem',
          rate: { perDay: 1, minted: true },
          tiers: [{ lock, multiplier: 1, prize: { gives: 'item', item: 'shard' } }],
        },
      ],
    });
  assert.ok(refused(spec(0)).some(r => r.code === 'E-FARM' && /BadFarm/.test(r.message) && /lock/.test(r.fix)));
  assert.ok(!refused(spec('1d')).some(r => /no lock/.test(r.message)));
  const w = world({ seed: 'strict-tier-prize' });
  w.upsert({ Item: { id: 1, args: collectible('Hero') } });
  const open = lock =>
    w.chain.send(w.creator, [
      computeUnitLimit(600_000),
      loot.openFarmIx({
        owner: w.creator,
        project: w.project,
        id: lock + 1,
        rewardsMint: w.mint,
        args: {
          custody: 'Escrow',
          tiers: [{ lock, bps: 10_000, prize: { Item: [1] } }],
          boosts: [],
          max_boost_bps: 0,
          gates: [],
          rate: { per_day: 0n, mints: false },
        },
      }),
    ]);
  fails(() => open(0), 'BadFarm');
  open(60);
});

test('a number-moving roll on an NFT a recipe shows warns that only a Core NFT can be held', () => {
  const spec = base({
    boxes: [
      {
        key: 'forge',
        name: 'Forge',
        price: 0,
        active: false,
        rollsOn: { collection: WALLET },
        outcomes: [{ gives: 'nothing', chance: 100, shifts: [{ attribute: 'level', by: 1, upTo: 9 }] }],
      },
    ],
    recipes: [
      {
        key: 'r',
        name: 'R',
        in: [{ takes: 'show', collection: WALLET }],
        out: [{ gives: 'roll', box: 'forge', on: 0 }],
      },
    ],
  });
  const said = check(spec, { now: NOW }).warnings.find(x => x.code === 'W-ROLL-CUSTODY');
  assert.match(said?.message ?? '', /NeedsCustody/);
});

test(
  'the program’s caps are the checker’s, and a spec over one is refused in words',
  { skip: program ? false : 'no program build (XSOLANA_PROGRAM_DIR)' },
  () => {
    const text = readFileSync(path.join(program, 'programs/loot/src/constants.rs'), 'utf8');
    const cap = name =>
      Number(text.match(new RegExp(`pub const ${name}: [a-z0-9]+ = ([0-9_]+);`))[1].replaceAll('_', ''));
    assert.deepEqual(
      [
        LIMITS.boxEntries,
        LIMITS.boxSlots,
        LIMITS.boxOdds,
        LIMITS.boxFates,
        LIMITS.entryPrizes,
        LIMITS.recipeLines,
        LIMITS.farmRules,
        LIMITS.growthSteps,
        LIMITS.contestSides,
        LIMITS.deciders,
        LIMITS.collections,
        LIMITS.lotteryRuns,
        LIMITS.farmEnds,
      ],
      [
        'MAX_BOX_ENTRIES',
        'MAX_BOX_SLOTS',
        'MAX_BOX_ODDS',
        'MAX_BOX_FATES',
        'MAX_ENTRY_PRIZES',
        'MAX_RECIPE_LINES',
        'MAX_FARM_RULES',
        'MAX_GROWTH_STEPS',
        'MAX_CONTEST_SIDES',
        'MAX_DECIDERS',
        'MAX_COLLECTIONS',
        'MAX_LOTTERY_RUNS',
        'MAX_FARM_ENDS',
      ].map(cap),
    );
  },
);

test('every cap refuses a spec over it, with a plain message', () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const nothing = n => many(n, () => ({ gives: 'nothing', weight: 1 }));
  const rule = { attribute: 'level', atLeast: 1 };
  const over = {
    [`${LIMITS.boxEntries + 1} outcomes`]: base({
      boxes: [{ key: 'b', name: 'B', price: 1, outcomes: nothing(LIMITS.boxEntries + 1) }],
    }),
    [`${LIMITS.boxSlots + 1} slots`]: base({
      boxes: [
        { key: 'b', name: 'B', price: 1, outcomes: nothing(2), slots: many(LIMITS.boxSlots + 1, () => ({ count: 1 })) },
      ],
    }),
    'odds that read an NFT': base({
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: nothing(2),
          odds: many(LIMITS.boxOdds + 1, () => ({ outcome: 0, when: rule, add: { addPercent: 1 } })),
        },
      ],
    }),
    'act on the NFT': base({
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          rollsOn: rule,
          outcomes: many(LIMITS.boxFates + 1, () => ({
            gives: 'nothing',
            weight: 1,
            shifts: [{ attribute: 'level', by: 1, upTo: 2 }],
          })),
        },
      ],
    }),
    [`gives ${LIMITS.entryPrizes + 1} prizes`]: base({
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [
            {
              gives: 'bundle',
              weight: 1,
              prizes: many(LIMITS.entryPrizes + 1, () => ({ gives: 'item', item: 'shard' })),
            },
            { gives: 'nothing', weight: 1 },
          ],
        },
      ],
    }),
    [`${LIMITS.recipeLines + 1} lines out`]: base({
      recipes: [
        { key: 'r', name: 'R', in: [], out: many(LIMITS.recipeLines + 1, () => ({ gives: 'item', item: 'shard' })) },
      ],
    }),
    [`${LIMITS.farmRules + 1} boosts`]: base({
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'collectibles',
          rewards: 'gem',
          boosts: many(LIMITS.farmRules + 1, () => ({ when: rule, add: { addPercent: 1 } })),
          maxBoostPercent: 10,
        },
      ],
    }),
    [`${LIMITS.farmRules + 1} growths`]: base({
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'collectibles',
          rewards: 'gem',
          growth: many(LIMITS.farmRules + 1, i => ({ attribute: `x${i}`, perDay: 1 })),
        },
      ],
    }),
    [`${LIMITS.growthSteps + 1} levels`]: base({
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'collectibles',
          rewards: 'gem',
          growth: [
            { attribute: 'xp', perDay: 1, level: 'level', levels: many(LIMITS.growthSteps + 1, i => (i + 1) * 1000) },
          ],
        },
      ],
    }),
    [`${LIMITS.deciders + 1} deciders`]: base({
      contests: [
        { key: 'c', name: 'C', sides: 2, entriesClose: '1d', deciders: many(LIMITS.deciders + 1, () => WALLET) },
      ],
    }),
    [`${LIMITS.collections + 1} collections`]: base({
      collections: many(LIMITS.collections, i => pda.project(WALLET, i)),
    }),
  };
  // A contest's sides are the schema's to refuse, in words too.
  assert.match(
    refused(base({ contests: [{ key: 'c', name: 'C', sides: LIMITS.contestSides + 1, entriesClose: '1d' }] }))[0]
      .message,
    /sides must be at most 1024/,
  );
  assert.ok(
    !refused(base({ contests: [{ key: 'c', name: 'C', sides: LIMITS.contestSides, entriesClose: '1d' }] })).some(r =>
      /sides/.test(r.message),
    ),
  );
  for (const [words, spec] of Object.entries(over)) {
    const said = refused(spec).filter(r => /the program takes at most/.test(r.message));
    assert.ok(
      said.some(r => r.message.includes(words) && r.fix),
      `${words}: ${JSON.stringify(refused(spec).map(r => r.message.slice(0, 80)))}`,
    );
  }
});

test('a boost that reads what the farm’s own growth writes gets a note to refresh seats, and is not refused', () => {
  const farm = boosts =>
    base({
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'collectibles',
          rewards: 'gem',
          rate: { perDay: 1, minted: true },
          maxBoostPercent: 100,
          growth: [{ attribute: 'xp', perDay: 1, level: 'level', levels: [10, 20] }],
          boosts,
        },
      ],
    });
  const reads = farm([{ when: { attribute: 'level' }, add: { perPointPercent: 1, upTo: 10 } }]);
  assert.deepEqual(
    refused(reads).map(r => r.code),
    [],
  );
  assert.match(explainEconomy(reads, { now: NOW }).text, /have the page or a keeper refresh seats/);
  assert.doesNotMatch(
    explainEconomy(farm([{ when: { attribute: 'other' }, add: { addPercent: 1 } }]), { now: NOW }).text,
    /have the page or a keeper refresh seats/,
  );
});

test('what is accepted by design is not warned of as a bug', () => {
  const words = /run(s)? dry.*bug|next touch|racing|follows the holder/i;
  const spec = base({
    farms: [
      {
        key: 'f',
        name: 'F',
        stakes: 'gem',
        rewards: 'gem',
        rate: { perDay: 1, shared: true },
        seed: 1,
        tiers: [{ lock: 0, multiplier: 1, earnsFor: '1d' }],
      },
    ],
  });
  assert.ok(!check(spec, { now: NOW }).warnings.some(x => words.test(x.message)));
  assert.ok(cost(spec, { now: NOW }).ok);
});
