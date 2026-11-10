// loot 0.26 on the routes of boxes, recipes, settles, lotteries, farms and stashes, as the client builds them and the
// real program takes them: a box whose gate reads the player's profile and whose odds read an NFT; a recipe of several
// rolls whose payment lines nobody can take go to the treasury; a prize the player can't receive, given up at the
// settle; tickets weighed by time, bought, drawn and pulled, each place's winner found by its slice of the draw; a run
// of places that each give a roll, pulled in parts; a stash stocked in a batch; a mission's leave without its prize.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit, requestHeapFrame } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { boxArgs, cannotRun, collectible, drop, fromPool, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const names = record => record.receipts.map(r => r.name);
const receipt = (record, name) => record.receipts.find(r => r.name === name)?.data;
const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const fails = (fn, code) => assert.throws(fn, e => new RegExp(code).test(`${e.message} ${(e.logs ?? []).join(' ')}`));
const recipeArgs = (inputs, outputs) => ({ active: true, inputs, outputs, needs: [], keeps: [], raises: [] });

/** The authority writes `lines` on `wallet`'s profile. */
function writeProfile(w, wallet, lines) {
  w.chain.send(w.authority, [
    loot.collectibleIx({
      authority: w.authority,
      project: w.project,
      collection: w.collection,
      asset: wallet,
      change: { Profile: [lines.map(([key, value]) => ({ key, value }))] },
    }),
  ]);
}

t('a box whose gate reads the profile and whose odds read an NFT takes the profile first, then the NFT', () => {
  const w = world({ seed: 'k026-profile-and-nft' });
  w.upsert({ Item: { id: 1, args: collectible('Charm') } });
  w.upsert({ Item: { id: 2, args: collectible('Sword') } });
  w.upsert({ Item: { id: 3, args: collectible('Dragon') } });
  const gate = { Holds: [{ of: 'Profile', key: 'level', test: { AtLeast: [10] } }] };
  const odds = [
    { entry: 1, boost: { rule: { of: { Item: [1] }, key: '', test: 'Any' }, effect: { Flat: [990_000] } } },
  ];
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [itemDrop(2, 99), itemDrop(3, 1)], { gate, odds }) } });
  const box = w.read('LootBox', pda.box(w.project, 1));
  assert.deepEqual([loot.boxReads(box, true), loot.boxReads(box, false)], [true, true]);
  const charm = w.make(1, w.player);
  const open = (nonce, more = {}) =>
    w.chain.send(w.player, [
      loot.openBoxIx({ player: w.player, project: w.project, box, nonce, shown: charm, ...more }),
    ]);
  // No profile yet, then one below the gate: refused.
  fails(() => open(1n), 'GateNotMet');
  writeProfile(w, w.player, [['level', '9']]);
  fails(() => open(1n), 'GateNotMet');
  writeProfile(w, w.player, [['level', '12']]);
  const r = open(1n);
  const ix = loot.openBoxIx({ player: w.player, project: w.project, box, nonce: 1n, shown: charm });
  const keys = ix.keys.map(k => k.pubkey);
  const profileAt = keys.indexOf(pda.profile(w.project, w.player));
  assert.ok(profileAt > 0 && keys[profileAt + 1] === charm, 'the profile, then the NFT shown');
  const raised = receipt(r, 'OddsRaised');
  assert.deepEqual(
    [raised.asset, raised.profile, raised.raised],
    [charm, pda.profile(w.project, w.player), [0, 990_000]],
    'the NFT read for the odds, the profile for the gate',
  );
  // `RollMade` is the purchase's receipt too.
  const made = receipt(r, 'RollMade');
  assert.deepEqual([made.paid, made.opens, made.mint], [PRICE, 1, w.mint]);
  // Someone else's profile in its place reads as nothing: refused.
  const other = w.who();
  writeProfile(w, other, [['level', '50']]);
  fails(() => open(2n, { profile: pda.profile(w.project, other) }), 'GateNotMet');
  // `buy` takes only the gate's own account: the profile.
  w.upsert({ Box: { id: 2, args: boxArgs(PRICE, [itemDrop(2)], { gate }) } });
  const shop = w.read('LootBox', pda.box(w.project, 2));
  const bought = w.chain.send(w.player, [
    loot.buyIx({
      player: w.player,
      project: w.project,
      box: shop,
      treasury: w.treasury,
      items: { 2: w.read('Item', pda.item(w.project, 2)) },
    }),
  ]);
  assert.ok(names(bought).includes('Bought'));
});

t('a recipe of several rolls makes each at nonce + k, and a payment line nobody can take goes to the treasury', () => {
  const w = world({ seed: 'k026-recipe-rolls' });
  w.upsert({ Item: { id: 1, args: collectible('Ore') } });
  w.upsert({ Item: { id: 2, args: collectible('Gem') } });
  w.upsert({ Box: { id: 5, args: boxArgs(0n, [itemDrop(2), itemDrop(2)], { active: false }) } });
  // A collectible nobody holds (an address with nothing there) and the project's own address: nobody takes either.
  const gone = w.who();
  const inputs = [
    { Burn: { item: 1, count: 1 } },
    { Pay: { mint: w.mint, amount: 300n, to: { Holder: [gone] } } },
    { Pay: { mint: w.mint, amount: 200n, to: { Wallet: [w.project] } } },
  ];
  const outputs = [{ Prize: [{ Roll: [5] }] }, { Prize: [{ Roll: [5] }] }, { Prize: [{ Roll: [5] }] }];
  w.upsert({ Recipe: { id: 1, args: recipeArgs(inputs, outputs) } });
  const recipe = w.read('Recipe', pda.recipe(w.project, 1));
  const ore = w.make(1, w.player);
  const nonce = 40n;
  assert.deepEqual(
    loot.craftRollNonces(recipe, nonce).map(x => x.nonce),
    [40n, 41n, 42n],
  );
  assert.ok(loot.paysNowhere(w.project, inputs[1].Pay.to) && loot.paysNowhere(w.project, inputs[2].Pay.to));
  assert.throws(
    () =>
      loot.craftIx({
        player: w.player,
        project: w.project,
        collection: w.collection,
        id: 1,
        recipe,
        assets: [ore],
        nonce,
      }),
    /treasury/,
  );
  const before = w.balance(w.treasury);
  const r = w.chain.send(w.player, [
    computeUnitLimit(1_400_000),
    loot.craftIx({
      player: w.player,
      project: w.project,
      collection: w.collection,
      id: 1,
      recipe,
      assets: [ore],
      nonce,
      treasury: w.treasury,
      items: { 1: w.read('Item', pda.item(w.project, 1)) },
    }),
  ]);
  assert.deepEqual(receipt(r, 'Crafted').to_treasury, [1, 2], 'both lines, by their place among the inputs');
  assert.equal(w.balance(w.treasury) - before, 500n);
  for (const k of [0n, 1n, 2n]) {
    const order = w.read('Order', pda.order(w.project, w.player, loot.prizeRollNonce(nonce + k)));
    assert.equal(order?.status, 'Waiting', `roll ${k} at nonce + ${k}`);
  }
});

t('a player who can’t receive a prize gives it up at the settle: the tokens stay in the project’s vault', () => {
  const w = world({ seed: 'k026-give-up' });
  w.pool(2, w.mint, 10_000n);
  w.upsert({ Item: { id: 1, args: collectible('Badge') } });
  w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([fromPool(2, 700), { Item: [1] }])]) } });
  const box = w.read('LootBox', pda.box(w.project, 1));
  w.chain.send(w.player, [loot.openBoxIx({ player: w.player, project: w.project, box, nonce: 1n })]);
  const orderAddress = pda.order(w.project, w.player, 1n);
  const order = w.read('Order', orderAddress);
  assert.equal(order.status, 'Rolled');
  w.chain.nextSlot();
  // The issuer froze the player's account of the token: its state byte (108) is 2.
  const account = loot.ata(w.player, w.mint);
  const held = w.chain.get(account);
  const data = Uint8Array.from(held.data);
  data[108] = 2;
  w.chain.put(account, { ...held, data });
  const items = { 1: w.read('Item', pda.item(w.project, 1)) };
  const settle = (signer, more = {}) =>
    w.chain.send(signer, [
      computeUnitLimit(800_000),
      loot.settleIx({ signer, orderAddress, order, projectState: w.projectState(), items, ...more }),
    ]);
  fails(() => settle(w.player), 'frozen|Frozen|0x11');
  // Only the order's own player may give it up: the project's keys can't.
  fails(() => settle(w.authority, { giveUp: [0] }), 'NotTheirAccount|Error');
  const vault = loot.vault(w.project, w.mint);
  const kept = w.chain.tokens(vault);
  const r = settle(w.player, { giveUp: [0] });
  const forgone = receipt(r, 'PrizeForgone');
  assert.equal(forgone.at, 0);
  assert.ok(forgone.won.Tokens, 'the tokens, given up');
  // Only the price left the vault (split to the treasury); the 700 given up stay.
  assert.equal(kept - w.chain.tokens(vault), PRICE, 'they stay in the project’s vault');
  assert.equal(ownerOf(w, loot.pda.itemAsset(pda.item(w.project, 1), order.won[1].Item.serial)), w.player);
  assert.equal(w.chain.get(orderAddress), null, 'and the order is settled');
});

t('tickets weighed by time: each purchase weighs its tickets times the seconds to the close of sales', () => {
  const w = world({ seed: 'k026-weighted' });
  w.upsert({ Item: { id: 1, args: collectible('Medal') } });
  const t0 = w.chain.now();
  w.upsert({
    Lottery: {
      id: 1,
      args: {
        price: 1000n,
        mint: w.mint,
        pays_from: { Pot: [0] },
        shares: [],
        places: [{ bps: 0, prize: { Item: [1] }, times: 3 }],
        ticket_mint: NOBODY,
        every: 0n,
        draws_at: BigInt(t0 + 3600),
        gate: null,
        returns: true,
        closes_before: 600n,
        time_weighted: true,
      },
    },
  });
  const address = pda.lottery(w.project, 1);
  const lottery = w.read('Lottery', address);
  const [a, b, c] = [w.player, w.who(), w.who()];
  for (const p of [b, c]) w.fund(p, w.mint, 100n * PRICE);
  const buy = (player, count, at) => {
    w.chain.warp(at);
    const round = w.round(1)?.round ?? null;
    const odds = loot.purchaseOdds(round, lottery.terms, count, w.chain.now());
    const r = w.chain.send(player, [
      loot.buyTicketsIx({ player, project: w.project, id: 1, lottery, round, mint: w.mint, count }),
    ]);
    const bought = receipt(r, 'TicketsBought');
    assert.equal(bought.weight, odds.weight, 'what the buyer was shown it weighs');
    return bought.weight;
  };
  const weights = [buy(a, 1n, t0 + 10), buy(b, 3n, t0 + 1500), buy(c, 2n, t0 + 2900)];
  assert.deepEqual(weights, [2990n, 3n * 1500n, 2n * 100n], 'the seconds left to the close, times the tickets');
  // Sales close 600 seconds before the draw.
  w.chain.warp(t0 + 3001);
  fails(
    () =>
      w.chain.send(a, [
        loot.buyTicketsIx({
          player: a,
          project: w.project,
          id: 1,
          lottery,
          round: w.round(1).round,
          mint: w.mint,
          count: 1n,
        }),
      ]),
    'SalesClosed',
  );
  let r = w.round(1).round;
  assert.equal(r.weight, 2990n + 4500n + 200n);
  assert.deepEqual(
    r.entries.map(e => [e.start, e.end, e.tickets]),
    [
      [0n, 2990n, 1n],
      [2990n, 7490n, 3n],
      [7490n, 7690n, 2n],
    ],
    'each entry’s slice of the draw, and its tickets',
  );
  w.chain.warp(t0 + 3601);
  const drawn = w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1, lottery })]);
  r = w.round(1).round;
  assert.equal(receipt(drawn.answers[0], 'LotteryDrawn').winning_ticket, r.first, 'the first place’s point, 128 bits');
  // Each place's winner: the entry whose slice holds its point; and that entry's places in the run hold it.
  const winners = [0, 1, 2].map(place => {
    const point = loot.ticketOfPlace(r, place);
    const i = loot.entryOf(r, point);
    assert.ok(r.entries[i].start <= point && point < r.entries[i].end);
    assert.ok(loot.placesIn(r, 0, r.entries[i].start, r.entries[i].end).includes(place));
    return r.entries[i].buyer;
  });
  const won = p => winners.filter(x => x === p).length;
  const items = () => ({ 1: w.read('Item', pda.item(w.project, 1)) });
  const medals = p => {
    const item = w.read('Item', pda.item(w.project, 1));
    let n = 0;
    for (let s = 1; s <= Number(item.issued); s++) if (ownerOf(w, pda.itemAsset(pda.item(w.project, 1), s)) === p) n++;
    return n;
  };
  const had = [a, b, c].map(p => w.balance(p));
  w.finishRound(1, { items });
  assert.equal(w.round(1), null, 'paid out and closed');
  assert.deepEqual(
    [a, b, c].map(medals),
    [a, b, c].map(won),
    'each place’s prize to the entry whose slice holds its point',
  );
  // A no-loss lottery: every ticket's price back.
  assert.deepEqual(
    [a, b, c].map((p, i) => w.balance(p) - had[i]),
    [1000n, 3000n, 2000n],
  );
});

t('a run of places that each give a roll is pulled in parts, the close on the last', () => {
  const w = world({ seed: 'k026-run-of-rolls' });
  w.upsert({ Item: { id: 1, args: collectible('Shard') } });
  w.upsert({ Box: { id: 5, args: boxArgs(0n, [itemDrop(1), itemDrop(1)], { active: false }) } });
  const t0 = w.chain.now();
  const PLACES = 12;
  w.upsert({
    Lottery: {
      id: 1,
      args: {
        price: 1000n,
        mint: w.mint,
        pays_from: { Pot: [0] },
        shares: [],
        places: [{ bps: 0, prize: { Roll: [5] }, times: PLACES }],
        ticket_mint: NOBODY,
        every: 0n,
        draws_at: BigInt(t0 + 3600),
        gate: null,
      },
    },
    rolls: [5],
  });
  const lottery = w.read('Lottery', pda.lottery(w.project, 1));
  w.chain.send(w.player, [
    loot.buyTicketsIx({ player: w.player, project: w.project, id: 1, lottery, mint: w.mint, count: BigInt(PLACES) }),
  ]);
  w.chain.warp(t0 + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1, lottery })]);
  const { address } = w.round(1);
  const nonce = 7n;
  const pullPart = most => {
    const r = w.round(1).round;
    const part = { Prize: [0] };
    const made = loot.pullRolls({ project: w.project, round: r, entry: 0, part, nonce, most });
    const ix = loot.pullIx({
      payer: w.player,
      project: w.project,
      roundAddress: address,
      round: r,
      entry: 0,
      part,
      nonce,
      projectState: w.projectState(),
      prize: { most },
    });
    w.chain.send(w.player, [computeUnitLimit(1_400_000), requestHeapFrame(loot.LARGE_SETTLE_HEAP), ix]);
    return { made, closes: ix.keys.some(k => k.pubkey === w.projectState().treasury) };
  };
  const first = pullPart(5);
  assert.equal(first.made.length, 5);
  assert.ok(!first.closes, 'a pull that stops short carries no close');
  for (const { order } of first.made) assert.equal(w.read('Order', order).status, 'Waiting');
  assert.equal(loot.prizePlacesOwed(w.round(1).round, 0, 0).length, PLACES - 5);
  pullPart(5);
  const last = pullPart(5);
  assert.equal(last.made.length, 2);
  w.finishRound(1);
  assert.equal(w.round(1), null, 'the last pull closes the round');
  for (let place = 0; place < PLACES; place++)
    assert.ok(w.read('Order', pda.order(w.project, w.player, loot.prizeRollNonce(nonce + BigInt(place)))));
});

t('a stash is stocked in a batch: one call puts in several NFTs, split by kind at the measured sizes', () => {
  const w = world({ seed: 'k026-stash-batch' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const nfts = Array.from({ length: 12 }, () => ({ asset: w.make(1, w.authority), collection: w.collection }));
  const calls = loot.stashBatches(nfts);
  assert.equal(calls.length, 1, 'the project’s own collectibles: 19 a legacy call');
  const [first, ...more] = calls[0].map((n, i) => ({ ...n, weight: i % 3 }));
  const r = w.chain.send(w.authority, [
    computeUnitLimit(1_400_000),
    loot.stashIx({ signer: w.authority, project: w.project, id: 1, ...first, more }),
  ]);
  assert.ok(r.receipts.length > 0);
  const stash = loot.decodeStash(w.chain.get(pda.stash(w.project, 1)).data);
  assert.equal(stash.nfts.length, 12);
  for (const n of nfts) assert.equal(ownerOf(w, n.asset), w.project);
  // Split by kind, at the measured sizes.
  const tm = Array.from({ length: 8 }, (_, i) => ({ asset: `tm${i}`, tokenMetadata: { programmable: false } }));
  const pnft = Array.from({ length: 5 }, (_, i) => ({ asset: `p${i}`, tokenMetadata: { programmable: true } }));
  const other = Array.from({ length: 30 }, (_, i) => ({ asset: `c${i}`, hasAuthority: false }));
  const sizes = list => loot.stashBatches(list).map(c => c.length);
  assert.deepEqual(sizes([...tm, ...pnft, ...other]), [3, 3, 2, 2, 2, 1, 10, 10, 10]);
  assert.deepEqual(
    loot.stashBatches(other, { lookupTable: true }).map(c => c.length),
    [24, 6],
  );
  assert.deepEqual(
    loot.stashBatches(other, { lookupTable: true, heap: true }).map(c => c.length),
    [27, 3],
  );
});

t(
  'a mission whose prize can’t be given: the leave is refused, or with needPrize false the NFT goes home without it',
  () => {
    const w = world({ seed: 'k026-need-prize' });
    w.pool(7, w.mint, 0n);
    w.upsert({ Item: { id: 1, args: collectible('Hero') } });
    const args = {
      custody: 'Escrow',
      tiers: [{ lock: 60, bps: 10_000, prize: fromPool(7, 500) }],
      boosts: [],
      max_boost_bps: 0,
      gates: [],
      rate: { per_day: 0n, mints: false },
    };
    w.chain.send(w.creator, [
      loot.openFarmIx({ owner: w.creator, project: w.project, id: 1, args, rewardsMint: w.mint }),
    ]);
    const farm = w.read('Farm', pda.farm(w.project, 1));
    const hero = w.make(1, w.player);
    w.tokenAccount(w.player, w.mint);
    w.chain.send(w.player, [
      loot.stakeNftIx({ player: w.player, project: w.project, id: 1, farm, asset: hero, collection: w.collection }),
    ]);
    w.chain.warp(w.chain.now() + 61);
    const leave = needPrize =>
      w.chain.send(w.player, [
        computeUnitLimit(800_000),
        loot.unstakeNftIx({
          player: w.player,
          project: w.project,
          id: 1,
          farm,
          asset: hero,
          collection: w.collection,
          tier: 0,
          poolMints: { 7: w.mint },
          needPrize,
        }),
      ]);
    fails(() => leave(true), 'PrizeNotCovered');
    assert.equal(ownerOf(w, hero), w.project, 'the seat stays');
    const r = leave(false);
    assert.equal(receipt(r, 'Unseated').prize_missed, true);
    assert.equal(ownerOf(w, hero), w.player, 'home without the prize');
  },
);
