// The quick simulation's money flows and words: where a recipe's and a schedule's payment lands (the treasury, a
// lottery's pot), what a lottery ticket really costs (what comes back is held, not spent), an auction of NFT bids, a
// falling price on a shared clock, a lottery that draws once, a scenario of no days, and what the scenario assumes
// for what it doesn't name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { explain, simulate } from '../economy/simulate.mjs';
import { feesOf } from '../economy/model.mjs';

const NOW = 1_000_000_000;
const exampleSpec = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
/** Checks `spec` (it must pass) and simulates it. */
const sim = spec => {
  const v = check(spec, { now: NOW });
  assert.ok(v.ok, v.refusals.map(r => `${r.code} ${r.message}`).join('\n'));
  return simulate(spec, { now: NOW });
};
const solSpec = more => ({
  version: 2,
  network: 'devnet',
  name: 'T',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'T' },
  ...more,
});
const gold = {
  version: 2,
  network: 'devnet',
  name: 'G',
  currency: 'gold',
  tokens: [{ key: 'gold', source: 'game', name: 'Gold', symbol: 'GLD', decimals: 0 }],
  collection: false,
};

test('a recipe’s pay line to the treasury lands in the treasury, and one to a lottery in its pot', () => {
  const spec = solSpec({
    items: [{ key: 'sword', name: 'Sword', value: 0.1 }],
    recipes: [
      {
        key: 'fee',
        name: 'Fee',
        in: [{ takes: 'pay', amount: 1, currency: 'sol', to: 'treasury' }],
        out: [{ gives: 'item', item: 'sword' }],
      },
      {
        key: 'entry',
        name: 'Entry',
        in: [{ takes: 'pay', amount: 0.5, currency: 'sol', to: 'lottery:draw' }],
        out: [{ gives: 'item', item: 'sword' }],
      },
    ],
    lotteries: [{ key: 'draw', pot: 0, name: 'Draw', price: 0.01, places: [100], every: '1d' }],
    scenario: { days: 30, perDay: { 'recipe:fee': 10, 'recipe:entry': 4, 'lottery:draw': 0 } },
  });
  const s = sim(spec);
  assert.equal(s.perDay.creator.treasury.sol, 10);
  assert.deepEqual(s.perDay.accounts, {});
  const pot = s.pools.find(p => p.key === 'lottery:draw');
  assert.equal(pot.inPerDay, 2);
  assert.deepEqual(pot.ins, [{ by: 'recipe:entry', perDay: 2 }]);
});

test('a schedule that pays a lottery fills its pot, by a fixed amount or by a share', () => {
  const base = {
    ...gold,
    pools: [{ key: 'bank', currency: 'gold', seed: 1000 }],
    lotteries: [{ key: 'draw', pot: 0, name: 'Draw', price: 10, places: [100], every: '1d', noLoss: true }],
    scenario: { days: 30, perDay: { 'lottery:draw': 10 } },
  };
  const fixed = sim({
    ...base,
    schedules: [
      { key: 'mint', name: 'Mint', does: 'issue', pool: 'bank', amount: 1000, every: '1d' },
      { key: 'feed', name: 'Feed', does: 'pay', from: 'bank', to: 'lottery:draw', amount: 100, every: '1d' },
    ],
  });
  assert.equal(fixed.pools.find(p => p.key === 'lottery:draw').inPerDay, 100);
  assert.deepEqual(fixed.perDay.accounts, {});
  const draw = fixed.lotteries[0];
  assert.equal(draw.potBeforeDraw, 100);
  assert.equal(draw.expectedPerTicket, 10, 'ten tickets share the 100 a round');
  const share = sim({
    ...base,
    schedules: [{ key: 'feed', name: 'Feed', does: 'pay', from: 'bank', to: 'lottery:draw', percent: 10, every: '1d' }],
  });
  const pot = share.pools.find(p => p.key === 'lottery:draw');
  assert.ok(pot.inPerDay > 0, JSON.stringify(pot));
  assert.deepEqual(share.perDay.accounts, {});
});

test('a ticket’s “in all” counts its entry’s bytes, which never come back, and leaves out a no-loss ticket’s price', () => {
  // A lottery that holds SOL for its rounds (`roundRent`, on by default) pays each entry: the buyer pays none.
  const funded = sim(
    solSpec({ lotteries: [{ key: 'draw', pot: 0, name: 'Draw', price: 0.01, places: [100], every: '1d' }] }),
  ).lotteries[0];
  assert.equal(funded.realCost.rentSol, 0);
  assert.ok(funded.roundRentSol > 0);
  const plain = sim(
    solSpec({
      lotteries: [{ key: 'draw', pot: 0, name: 'Draw', price: 0.01, places: [100], every: '1d', roundRent: 0 }],
    }),
  ).lotteries[0].realCost;
  // An entry of 40 bytes in the round (its buyer and its tickets' end), at 5,080 lamports a byte.
  assert.equal(plain.rentSol, 0.0002032);
  // The player fee is the economy's network's: 0.002 SOL on devnet.
  const fee = Number(feesOf(solSpec({})).player) / 1e9;
  assert.equal(
    plain.totalSol,
    +(0.01 + fee + 0.000005 + 0.0002032).toFixed(9),
    'the price, the player fee, the network and the entry',
  );
  const noLoss = sim(
    solSpec({
      lotteries: [
        {
          key: 'draw',
          pot: 0,
          name: 'Draw',
          price: 0.5,
          places: [100],
          every: '1d',
          noLoss: true,
          seed: 1,
          roundRent: 0,
        },
      ],
    }),
  ).lotteries[0].realCost;
  assert.equal(noLoss.priceBack, true);
  assert.equal(
    noLoss.totalSol,
    +(fee + 0.000005 + 0.0002032).toFixed(9),
    'only the player fee, the network and the entry leave for good',
  );
  assert.ok(noLoss.holdSol > 0.5);
  const text = explain(
    sim(
      solSpec({
        lotteries: [
          {
            key: 'draw',
            pot: 0,
            name: 'Draw',
            price: 0.5,
            places: [100],
            every: '1d',
            noLoss: true,
            seed: 1,
            roundRent: 0,
          },
        ],
      }),
    ),
    solSpec({
      lotteries: [
        {
          key: 'draw',
          pot: 0,
          name: 'Draw',
          price: 0.5,
          places: [100],
          every: '1d',
          noLoss: true,
          seed: 1,
          roundRent: 0,
        },
      ],
    }),
  );
  assert.match(
    text,
    /about [\d.]+ SOL in all \(the player fee, the network, the purchase’s entry in the round, which never comes back\); the wallet needs about [\d.]+ SOL when it signs, and the rest comes back/,
  );
});

test('an auction of NFT bids moves no money', () => {
  const spec = exampleSpec('artwork-auction');
  spec.auctions[0].bidNfts = { attribute: 'level' };
  spec.auctions[0].reserve = 3;
  delete spec.auctions[0].minRaise;
  delete spec.auctions[0].split;
  const s = sim(spec);
  const a = s.auctions[0];
  assert.equal(a.bidNfts, true);
  assert.equal(a.expectedPrice, null);
  assert.match(a.says, /goes for NFTs, not money/);
  assert.deepEqual(s.perDay.players.pay, {});
  assert.deepEqual(s.perDay.creator.treasury, {});
});

test('a price that falls on a shared clock keeps falling however often it sells', () => {
  const run = clock => {
    const spec = exampleSpec('falling-drop');
    spec.items[0].fall = { step: 0.05, every: '10m', floor: 0.2, start: 'publish', ...(clock ? { clock } : {}) };
    spec.scenario.perDay[`item:${spec.items[0].key}`] = 1000;
    spec.scenario.days = 1;
    delete spec.items[0].supply;
    const s = sim(spec);
    return {
      price: s.items[0].averagePrice ?? s.items[0].price,
      note: s.notes.find(n => n.includes(spec.items[0].name)),
    };
  };
  const sale = run();
  const shared = run('shared');
  assert.equal(sale.price, 2, 'a sale every 86 s restarts a 10-minute countdown: it never falls');
  assert.ok(shared.price < 0.5, `the shared clock reaches its floor within the day: ${shared.price}`);
  assert.match(shared.note, /clock of its own, sales or not/);
  assert.doesNotMatch(shared.note, /restarts the countdown/);
});

test('the “in all” cost of a price that rises is at its listed price, whatever the scenario sells, and says how it moves', () => {
  const forge = (opens, rise) =>
    solSpec({
      items: [{ key: 'blade', name: 'Blade', value: 0.01 }],
      boxes: [
        {
          key: 'forge',
          name: 'Forge',
          price: 0.02,
          ...(rise ? { rise } : {}),
          outcomes: [{ gives: 'item', item: 'blade', chance: 100 }],
        },
      ],
      scenario: { days: 30, perDay: { 'box:forge': opens } },
    });
  const at = opens => {
    const spec = forge(opens, { growthPercent: 0.01 });
    return { box: sim(spec).boxes[0], open: cost(spec, { now: NOW }).actions.find(a => a.part === 'box:forge') };
  };
  const runs = [1, 100, 1000].map(at);
  // What one open costs at 0.02 SOL: the same box with a price that stays.
  const inAll = sim(forge(100, null)).boxes[0].realCost.totalSol;
  assert.ok(inAll > 0.02 && inAll < 0.03, String(inAll));
  for (const { box, open } of runs) {
    assert.equal(box.realCost.totalSol, inAll);
    assert.equal(open.inAllSol, inAll);
    assert.ok(
      open.inAll.startsWith(`about ${inAll} SOL in all at its listed price (the price, the player fee, `),
      open.inAll,
    );
    assert.match(open.inAll, /\), and the price rises 0\.01% with each sale/, open.inAll);
  }
  // What the scenario's sales pay on average is still what the money flows count, and it is named as that.
  const [, hundred, thousand] = runs.map(r => r.box.averagePrice);
  assert.ok(hundred > 0.02 && thousand > hundred, `${hundred}, ${thousand}`);
  // A return counted against that average says so, beside the listed price it is not counted against.
  const rising = forge(100, { growthPercent: 0.01 });
  const box = explain(sim(rising), rising)
    .split('\n')
    .find(l => l.startsWith('Box “Forge”'));
  assert.match(
    box,
    /^Box “Forge”: costs 0\.02 SOL .*gives back 0\.01 SOL on average \(\d+(\.\d+)?% of the 0\.0233\d* SOL an open pays on average over the scenario\), all of it items worth that by the "value" you gave them \(a value, not money paid out\); the game keeps [\d.]+% of what an open pays, on average, by those values\.$/,
  );
  const steady = forge(100, null);
  assert.match(
    explain(sim(steady), steady),
    /gives back 0\.01 SOL on average \(50%\), all of it items worth that by the "value" you gave them \(a value, not money paid out\); the game keeps 50% of each price, by those values\./,
  );

  // A shop item says the same, once: its rise and its fall, with the fall's floor.
  const shop = solSpec({
    items: [
      {
        key: 'hat',
        name: 'Hat',
        price: 2,
        rise: { step: 0.5 },
        fall: { step: 0.05, every: '10m', floor: 0.2 },
      },
    ],
  });
  const moves = 'which rises 0.5 SOL with each sale and falls 0.05 SOL every 10m, to at least 0.2 SOL';
  assert.ok(sim(shop).items[0].realCost.priceMoves === moves, sim(shop).items[0].realCost.priceMoves);
  const buy = explainEconomy(shop, { now: NOW })
    .text.split('\n')
    .find(l => l.includes('Buy “Hat”'));
  assert.ok(buy.includes(`SOL in all at its listed price (the price, `), buy);
  assert.ok(buy.includes(`, and the price ${moves.replace(/^which /, '')}`), buy);
  assert.equal(buy.split('rises').length, 2, buy);
  // A price in another token is not in the SOL figure: what it adds says how the price moves.
  const priced = {
    ...gold,
    items: [{ key: 'hat', name: 'Hat', kind: 'normal', price: 10, rise: { growthPercent: 5 } }],
  };
  assert.match(
    explain(sim(priced), priced),
    /Shop “Hat”: 10 GLD; [\d.]+ SOL on top of the price \(the player fee, the network\), and the price rises 5% with each sale\./,
  );
});

test('a lottery that draws once is one round until its draw, with one oracle fee, and no return said for a prize with no price', () => {
  const spec = exampleSpec('nft-raffle');
  const s = sim(spec);
  const l = s.lotteries[0];
  assert.equal(l.drawsOnce, true);
  assert.equal(l.roundDays, 3, 'from going live to its first draw');
  assert.equal(l.ticketsPerRound, 300);
  assert.equal(l.unpricedPrizes, true);
  assert.equal(l.returnPercent, null);
  const days = s.scenario.days;
  assert.ok(Math.abs(s.perDay.creator.oracleFeesSol - s.fees.oracleSol / days) < 1e-9, 'one draw over the scenario');
  assert.ok(Math.abs(s.perDay.players.pay.sol - (300 * 0.1) / days) < 1e-9, 'its tickets, spread over the scenario');
  const text = explain(s, spec);
  assert.match(text, /300 tickets in its one round of 3 days \(it draws once\)/);
  assert.doesNotMatch(text, /round of 1 days|\(0%\)/);
  const words = explainEconomy(spec, { now: NOW }).text;
  assert.match(words, /a ticket is worth 0 on average, plus its chance at the places’ prizes/);
  assert.doesNotMatch(words, /\(0%\)/);
});

test('a scenario of no days gives numbers, never Infinity', () => {
  const spec = exampleSpec('artwork-auction');
  spec.scenario = { ...(spec.scenario ?? {}), days: 0 };
  const s = sim(spec);
  assert.ok(Object.values(s.perDay.players.pay).every(Number.isFinite), JSON.stringify(s.perDay.players.pay));
  assert.doesNotMatch(explain(s, spec), /Infinity/);
});

test('an item nobody buys has no sold-out day', () => {
  const s = sim(
    solSpec({
      items: [{ key: 'sword', name: 'Sword', price: 0.1, supply: 50 }],
      scenario: { perDay: { 'item:sword': 0 } },
    }),
  );
  assert.equal('soldOutInDays' in s.items[0], false);
  const sold = sim(
    solSpec({
      items: [{ key: 'sword', name: 'Sword', price: 0.1, supply: 50 }],
      scenario: { perDay: { 'item:sword': 10 } },
    }),
  );
  assert.equal(sold.items[0].soldOutInDays, 5);
});

test('what the scenario assumes for what it doesn’t name is said as it is counted', () => {
  const spec = exampleSpec('artwork-auction');
  delete spec.scenario;
  const s = sim(spec);
  assert.match(explain(s, spec), /anything not named: 100 a day \(auction bids 10 a day\)/);
  assert.match(
    explainEconomy(spec, { now: NOW }).text,
    /Each day, if 100 of each thing happen \(auction bids 10 a day\)/,
  );
});

test('explain names each lottery place by its percent, written as a plain number or as an object, and a run of places as a run', () => {
  const said = spec =>
    explainEconomy(spec, { now: NOW }).text.match(/pulls each winner's part to the winner: ([^.]*)\./)?.[1];
  assert.equal(said(exampleSpec('stakers-draw')), 'place 1 60% of the pot and place 2 40% of the pot');
  const weekly = from =>
    solSpec({
      lotteries: [
        {
          key: 'weekly',
          name: 'Weekly',
          price: 0.01,
          every: '7d',
          ...from,
          places: [40, { percent: 20, times: 2 }, { percent: 10 }],
        },
      ],
    });
  assert.equal(
    said(weekly({ pot: 0 })),
    'place 1 40% of the pot, places 2–3 each 20% of the pot and place 4 10% of the pot',
  );
  assert.equal(
    said(weekly({ rest: 'treasury' })),
    "place 1 40% of the round's ticket money, places 2–3 each 20% of the round's ticket money and place 4 10% of the round's ticket money",
  );
});

test('a box’s house edge is the part of its price that does not come back, and the return the part that does', () => {
  // 40% of opens pay back the price, the rest nothing: 40% comes back, the project keeps 60%.
  const spec = {
    ...gold,
    pools: [{ key: 'prizes', currency: 'gold', seed: 100_000 }],
    boxes: [
      {
        key: 'flip',
        name: 'Flip',
        price: 10,
        perWallet: 5,
        outcomes: [
          { gives: 'tokens', from: 'pool:prizes', amount: 10, chance: 40 },
          { gives: 'nothing', chance: 60 },
        ],
      },
    ],
  };
  const box = sim(spec).boxes[0];
  assert.equal(box.expectedBack, 4);
  assert.equal(box.returnPercent, 40);
  assert.equal(box.houseEdgePercent, 60);
  assert.match(explain(simulate(spec, { now: NOW }), spec), /the game keeps 60% of each price/);
  // The shipped coin flip keeps 12% of each flip.
  const flip = sim(exampleSpec('coin-flip-arena')).boxes.find(b => b.key === 'flip');
  assert.equal(flip.houseEdgePercent, 12);
  assert.equal(flip.returnPercent + flip.houseEdgePercent, 100);
});
