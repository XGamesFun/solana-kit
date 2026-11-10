// loot 0.26 in the economy tools: what the program no longer refuses goes live and is warned of in words, the bounds
// it keeps are refused before anything is signed, and the simulator counts the new settings (a boosted weight in
// BigInt, a box that gives nothing for a miss, a stash with nothing that weighs, a round weighed by time, a short pool).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SYSVAR_SLOT_HASHES } from '../chain/pda.js';
import { slotHashes } from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { freshAddresses, prepare } from '../economy/live.mjs';
import {
  boostedWeight,
  boostedWeights,
  MOST_WEIGHT,
  placeWinners,
  purchaseWeight,
  shortPays,
  whenOutWords,
} from '../economy/model.mjs';
import { plan } from '../economy/plan.mjs';
import { simulate } from '../economy/simulate.mjs';
import { cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const WALLET = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const OTHER = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
const skip = cannotRun() ?? false;

/** A small economy in a token the project makes, with `more` merged in. */
const base = (more = {}) => ({
  version: 2,
  network: 'devnet',
  name: 'Limits',
  currency: 'gem',
  tokens: [{ key: 'gem', source: 'project', symbol: 'GEM', decimals: 6 }],
  collection: { name: 'Limits' },
  items: [
    { key: 'sword', name: 'Sword', uri: 'https://example.invalid/sword.json' },
    { key: 'shield', name: 'Shield', uri: 'https://example.invalid/shield.json' },
  ],
  pools: [{ key: 'prizes', currency: 'gem', seed: 1700 }],
  ...more,
});
const said = (spec, code, where) =>
  check(spec, { now: NOW }).warnings.find(w => w.code === code && (where === undefined || w.where === where));
const refusal = (spec, where) => check(spec, { now: NOW }).refusals.find(r => r.where === where);
const lottery = (more = {}) => ({
  key: 'save',
  name: 'Save',
  price: 1,
  noLoss: true,
  rest: 'treasury',
  every: '7d',
  perWallet: 100,
  places: [{ percent: 0, prize: { gives: 'tokens', from: 'pool:prizes', amount: 1000 } }],
  ...more,
});

/** Puts `spec` live on the real program, transaction by transaction, as the approval page sends them. */
function goLive(spec, seed) {
  const w = world({ project: false, seed });
  w.chain.warp(NOW);
  const keys = freshAddresses(plan(spec, { now: NOW }).freshKeys, w.random);
  const p = prepare(spec, {
    owner: w.creator,
    keys,
    now: NOW,
    rent: bytes => w.chain.rent(bytes),
    slot: slotHashes(w.chain.get(SYSVAR_SLOT_HASHES)?.data)[0] ?? null,
  });
  assert.ok(p.ok, JSON.stringify(p.refusals));
  for (const t of p.transactions)
    w.chain.send(t.signer === 'authority' ? p.ctx.authority : w.creator, t.instructions, {
      label: t.steps.map(s => s.id).join(', '),
    });
  return { w, project: p.ctx.project };
}

describe('what 0.26 takes goes live, and is warned of', () => {
  const spec = base({
    boxes: [
      {
        key: 'chest',
        name: 'Chest',
        price: 1,
        whenOut: 'giveNothing',
        outcomes: [
          { gives: 'item', item: 'sword', weight: 1 },
          { gives: 'pay', pool: 'prizes', amount: 5, weight: 99 },
        ],
        // A thousand times likelier: above the +10,000% the program once refused.
        odds: [{ outcome: 0, when: { item: 'shield' }, add: { addPercent: 99_900 } }],
      },
      {
        key: 'pick',
        name: 'Pick',
        price: 0,
        active: false,
        outcomes: [
          { gives: 'item', item: 'sword', weight: 1 },
          { gives: 'nothing', weight: 1 },
        ],
      },
    ],
    // Two rolls a craft: one was the most before.
    recipes: [
      {
        key: 'two',
        name: 'Two',
        in: [{ takes: 'pay', amount: 1, to: 'treasury' }],
        out: [
          { gives: 'roll', box: 'pick' },
          { gives: 'roll', box: 'pick' },
        ],
      },
    ],
    // A no-loss lottery paid from its rounds, weighed by time, sales closing a day early; places from one pool that
    // say what they get when it is short; a run of rolls.
    lotteries: [
      lottery({
        closesBefore: '1d',
        timeWeighted: true,
        places: [
          { percent: 0, prize: { gives: 'tokens', from: 'pool:prizes', amount: 1000 }, whenShort: 'inProportion' },
          {
            percent: 0,
            prize: { gives: 'tokens', from: 'pool:prizes', amount: 500 },
            times: 2,
            whenShort: 'inProportion',
          },
          { percent: 0, prize: { gives: 'roll', box: 'pick' }, times: 2 },
        ],
      }),
    ],
    farms: [
      // A tier of x50 and a boost of +50,000%: past the x11 and +10,000% the program once took.
      {
        key: 'deep',
        name: 'Deep',
        stakes: 'gem',
        rewards: 'gem',
        rate: { perDay: 1, minted: true },
        runs: '30d',
        tiers: [{ lock: 0 }, { lock: '7d', multiplier: 50 }],
        boosts: [{ when: { item: 'shield' }, add: { addPercent: 50_000 } }],
        maxBoostPercent: 100_000,
      },
      // A mission with no lock.
      {
        key: 'mission',
        name: 'Mission',
        stakes: 'collectibles',
        rewards: 'gem',
        rate: { perDay: 0, minted: true },
        tiers: [{ lock: 0, prize: { gives: 'tokens', from: 'mint', currency: 'gem', amount: 1 } }],
      },
    ],
  });

  test('the checker takes it, and says each risk in words', () => {
    const r = check(spec, { now: NOW });
    assert.ok(r.ok, r.refusals.map(x => `${x.code} ${x.where} ${x.message}`).join('\n'));
    assert.match(said(spec, 'W-WHEN-OUT', 'economy.boxes.chest.whenOut').message, /a paid draw is not refunded/);
    assert.match(
      said(spec, 'W-LOTTERY-WEIGHT').message,
      /tickets times the seconds from it to the close of sales \(1d before each draw\)/,
    );
    assert.match(
      said(spec, 'W-LOTTERY-POOL').message,
      /1,000, 500 and 0 in order, 850, 425 and 425 in proportion, or nothing/,
    );
    assert.match(said(spec, 'W-FARM-MISSION').message, /again and again and take the prize each time/);
  });

  test('it goes live on the program', { skip }, () => {
    const { w, project } = goLive(spec, 'economy-026-live');
    const l = w.read('Lottery', loot.pda.lottery(project, 1));
    assert.equal(l.terms.closes_before, 86_400n);
    assert.equal(l.terms.time_weighted, true);
    assert.equal(l.terms.returns, true);
    assert.deepEqual(
      l.terms.places.map(p => [p.when_short, p.times]),
      [
        ['InProportion', 1],
        ['InProportion', 2],
        ['InOrder', 2],
      ],
    );
    const box = w.read('LootBox', loot.pda.box(project, 1));
    assert.equal(box.when_out, 'GiveNothing');
    assert.ok(w.chain.get(loot.pda.farm(project, 1)) && w.chain.get(loot.pda.farm(project, 2)));
  });
});

describe('the bounds the program keeps are refused before signing, in words', () => {
  test('a lottery: sales that never open, a weighed lottery that keeps its money, pools that disagree', () => {
    const spec = more => base({ lotteries: [lottery(more)] });
    assert.match(
      refusal(spec({ closesBefore: '7d' }), 'economy.lotteries.save.closesBefore').message,
      /sales would never open \(BadLottery\)/,
    );
    const kept = base({ lotteries: [{ ...lottery({ timeWeighted: true }), noLoss: false }] });
    assert.match(refusal(kept, 'economy.lotteries.save.timeWeighted').message, /BadLottery/);
    const disagree = spec({
      places: [
        { percent: 0, prize: { gives: 'tokens', from: 'pool:prizes', amount: 10 }, whenShort: 'nothing' },
        { percent: 0, prize: { gives: 'tokens', from: 'pool:prizes', amount: 10 } },
      ],
    });
    assert.match(refusal(disagree, 'economy.lotteries.save.places').message, /must say the same \(BadLottery\)/);
    // 170 "one of" texts in an NFT ticket's rule, not 171.
    const ticket = n =>
      base({
        lotteries: [
          {
            key: 'nft',
            name: 'NFT',
            pot: 0,
            seed: 1,
            ticketNft: { rule: { attribute: 'kind', oneOf: Array.from({ length: n }, (_, i) => `k${i}`) } },
          },
        ],
      });
    assert.equal(refusal(ticket(170), 'economy.lotteries.nft.ticketNft.rule.oneOf'), undefined);
    assert.match(refusal(ticket(171), 'economy.lotteries.nft.ticketNft.rule.oneOf').message, /at most 170/);
  });

  test('a farm: a tier up to x100, a boost up to +100,000%', () => {
    const farm = (tier, boost) =>
      base({
        farms: [
          {
            key: 'f',
            name: 'F',
            stakes: 'gem',
            rewards: 'gem',
            seed: 1,
            tiers: [{ lock: '1d', multiplier: tier }],
            boosts: [{ when: { item: 'shield' }, add: boost }],
            maxBoostPercent: 100_000,
          },
        ],
      });
    assert.ok(check(farm(100, { addPercent: 100_000 }), { now: NOW }).ok);
    assert.match(
      check(farm(101, { addPercent: 1 }), { now: NOW }).refusals[0]?.message ?? '',
      /at most x100|must be at most 100/,
    );
    assert.match(
      refusal(farm(1, { perPointPercent: 1_000, upTo: 101 }), 'economy.farms.f.boosts[0].add').message,
      /past the \+100,000% a farm’s boost may add \(BadFarm\)/,
    );
  });
});

describe('each warning, in the words a founder reads', () => {
  test('W1: a token whose issuer can raise its fee or take from a vault', () => {
    const spec = base({
      tokens: [
        {
          key: 'gem',
          source: 'existing',
          mint: WALLET,
          decimals: 6,
          symbol: 'GEM',
          powers: { feeChangeable: true, permanentDelegate: true, closeAuthority: true },
        },
      ],
    });
    const w = said(spec, 'W-MINT-POWERS', 'economy.tokens[0].powers').message;
    assert.match(w, /raise its transfer fee, up to 100%/);
    assert.match(w, /a farm’s stakes and a sealed vest’s vault/);
    assert.match(w, /only as safe as the token/);
  });

  test('W2: a prize to each winning entry with no stake and no gate', () => {
    const spec = base({
      contests: [{ key: 'c', name: 'C', sides: 2, entriesClose: '1d', prize: { gives: 'item', item: 'sword' } }],
    });
    assert.match(said(spec, 'W-CONTEST-PRIZE', 'economy.contests.c.prize').message, /collects one prize a wallet/);
  });

  test('W4: a box that draws from a pool another route takes from', () => {
    const spec = base({
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [
            { gives: 'pay', pool: 'prizes', amount: 1, weight: 1 },
            { gives: 'nothing', weight: 1 },
          ],
        },
      ],
      grants: [
        {
          key: 'g',
          name: 'G',
          prize: { gives: 'tokens', from: 'pool:prizes', amount: 1 },
          limits: { perWallet: 1 },
        },
      ],
    });
    assert.match(said(spec, 'W-SHARED-SOURCE').message, /be refunded every miss/);
  });

  test('W5: an auction with no extension', () => {
    const spec = base({ auctions: [{ key: 'a', name: 'A', lot: { item: 'sword' }, runs: '1d', extendBy: 0 }] });
    assert.match(said(spec, 'W-AUCTION', 'economy.auctions.a.extendBy').message, /keep every other bid out/);
  });

  test('W6 and W16: NFTs of a collection the project does not control', () => {
    const spec = base({
      auctions: [{ key: 'a', name: 'A', lot: { asset: WALLET, collection: OTHER }, runs: '1d', minRaise: 5 }],
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          gate: { collection: OTHER },
          outcomes: [{ gives: 'item', item: 'sword', weight: 1 }],
        },
      ],
    });
    assert.match(said(spec, 'W-OUTSIDE-NFT').message, /pull it back out of a hold, a stake, a loan or a listing/);
    assert.match(said(spec, 'W-AUCTION-OUTSIDE').message, /A bidder’s money can be tied up, not lost/);
  });

  test('W7: a hold, and a contest’s judge', () => {
    const spec = base({
      holds: [{ key: 'h', name: 'H', item: 'sword', for: '7d' }],
      contests: [{ key: 'c', name: 'C', sides: 2, entriesClose: '1d', stake: 1 }],
    });
    assert.match(said(spec, 'W-HOLD', 'economy.holds.h').message, /the project’s authority alone decides/);
    assert.match(said(spec, 'W-CONTEST', 'economy.contests.c').message, /can also enter it/);
  });

  test('W8: a no-loss lottery that sells until the draw', () => {
    const spec = base({ lotteries: [lottery()] });
    assert.match(said(spec, 'W-LOTTERY', 'economy.lotteries.save.closesBefore').message, /held all period/);
  });

  test('W9: a lottery that draws again and names an NFT of a stash', () => {
    const spec = base({
      stashes: [{ key: 's', name: 'S', collection: OTHER, nfts: [WALLET] }],
      lotteries: [
        {
          key: 'l',
          name: 'L',
          price: 1,
          pot: 0,
          every: '1d',
          places: [{ percent: 50, prize: { gives: 'nft', stash: 's', nft: WALLET } }],
        },
      ],
    });
    assert.match(said(spec, 'W-LOTTERY', 'economy.lotteries.l.places').message, /later winners get nothing/);
  });

  test('W10: a share to whoever holds a collectible', () => {
    const spec = base({
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          split: [{ to: `holder:${WALLET}`, percent: 5 }],
          outcomes: [{ gives: 'item', item: 'sword', weight: 1 }],
        },
      ],
    });
    assert.match(said(spec, 'W-HOLDER-SHARE').message, /the settle fails and is sent again/);
  });

  test('W11: a lottery’s minted prize the project cannot mint, and a grant’s list', () => {
    const spec = base({
      tokens: [
        { key: 'gem', source: 'project', symbol: 'GEM', decimals: 6 },
        { key: 'usd', source: 'existing', mint: WALLET, decimals: 6, symbol: 'USD', powers: {} },
      ],
      lotteries: [
        {
          key: 'l',
          name: 'L',
          price: 1,
          pot: 0,
          places: [{ percent: 50, prize: { gives: 'tokens', from: 'mint', currency: 'usd', amount: 1 } }],
        },
      ],
      grants: [
        {
          key: 'g',
          name: 'G',
          prize: { gives: 'item', item: 'sword' },
          list: [{ wallet: WALLET, round: 1 }],
        },
      ],
    });
    const r = check(spec, { now: NOW });
    assert.ok(!r.refusals.some(x => x.code === 'E-MINT-NOT-OURS'), r.refusals.map(x => x.message).join());
    assert.match(said(spec, 'W-MINT-NOT-OURS').message, /pass it over for nothing/);
    assert.match(said(spec, 'W-GRANT', 'economy.grants.g.list').message, /they can claim again/);
  });

  test('W13 and W14: an auction and a lottery in a token a player can hold up', () => {
    const spec = base({
      tokens: [
        {
          key: 'gem',
          source: 'existing',
          mint: WALLET,
          decimals: 6,
          symbol: 'GEM',
          powers: { confidentialTransfers: true },
        },
      ],
      auctions: [{ key: 'a', name: 'A', lot: { item: 'sword' }, runs: '1d' }],
      lotteries: [{ key: 'l', name: 'L', price: 1, pot: 0, every: '1d' }],
    });
    assert.ok(check(spec, { now: NOW }).ok, 'the program takes both');
    assert.match(said(spec, 'W-HOLD-UP', 'economy.auctions.a.currency').message, /win at their price/);
    assert.match(said(spec, 'W-HOLD-UP', 'economy.lotteries.l.currency').message, /keep spare SOL in the lottery/);
  });

  test('W15 and W33: a farm that mints a token the project is not the authority of', () => {
    const spec = base({
      tokens: [
        { key: 'gem', source: 'project', symbol: 'GEM', decimals: 6 },
        { key: 'usd', source: 'existing', mint: WALLET, decimals: 6, symbol: 'USD', powers: {} },
      ],
      farms: [{ key: 'f', name: 'F', stakes: 'gem', rewards: 'usd', rate: { perDay: 1, minted: true }, runs: '30d' }],
    });
    assert.ok(check(spec, { now: NOW }).ok);
    const w = check(spec, { now: NOW }).warnings.find(
      x => x.code === 'W-FARM-MINT' && /not the authority/.test(x.message),
    );
    assert.match(w.message, /rewards for that time are lost, not paid later/);
    assert.match(w.message, /walk_farm/);
  });

  test('W18: a stash whose NFTs weigh 0, and W19: a prize of 0', () => {
    const spec = base({
      stashes: [{ key: 's', name: 'S', collection: OTHER, nfts: [{ asset: WALLET, weight: 0 }] }],
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [
            { gives: 'stash', stash: 's', weight: 1 },
            { gives: 'pay', pool: 'prizes', amount: 0, weight: 1 },
          ],
        },
      ],
    });
    assert.ok(
      check(spec, { now: NOW }).ok,
      check(spec, { now: NOW })
        .refusals.map(x => x.message)
        .join(),
    );
    assert.match(said(spec, 'W-STASH', 'economy.stashes.s.nfts').message, /given only by name/);
    assert.match(said(spec, 'W-ZERO', 'economy.boxes.b.outcomes[1].amount').message, /its winner gets nothing/);
  });

  test('W20 and W31: a collection the project may only be a delegate of', () => {
    const spec = base({ collections: [OTHER] });
    assert.match(said(spec, 'W-COLLECTION-PARTNER').message, /reads as any of the project’s items/);
  });

  test('W22: a long box, and an outcome of 15 collectibles', () => {
    const many = n => Array.from({ length: n }, () => ({ gives: 'nothing', weight: 1 }));
    const long = base({ boxes: [{ key: 'b', name: 'B', price: 1, outcomes: many(110) }] });
    assert.match(said(long, 'W-ANSWER', 'economy.boxes.b').message, /128 outcomes that give nothing/);
    const wide = base({
      boxes: [
        {
          key: 'w',
          name: 'W',
          price: 1,
          outcomes: [
            {
              gives: 'bundle',
              weight: 1,
              prizes: Array.from({ length: 15 }, () => ({ gives: 'item', item: 'sword' })),
            },
          ],
        },
      ],
    });
    assert.match(said(wide, 'W-ANSWER', 'economy.boxes.w.outcomes[0]').message, /sells only through the oracle/);
  });

  test('W23: a term farm keeps an entry for each second a seat stops earning', () => {
    const spec = base({
      farms: [{ key: 'f', name: 'F', stakes: 'gem', rewards: 'gem', seed: 1, tiers: [{ lock: '1d', earnsFor: '7d' }] }],
    });
    assert.match(said(spec, 'W-FARM-ENDS').message, /238,312 at most/);
  });

  test('W27: a heavy tier that can leave early for a fee', () => {
    const spec = base({
      farms: [
        {
          key: 'f',
          name: 'F',
          stakes: 'gem',
          rewards: 'gem',
          seed: 1,
          exitFeeTo: 'burn',
          tiers: [{ lock: '30d', multiplier: 20, exitFee: 5 }],
        },
      ],
    });
    assert.match(said(spec, 'W-FARM', 'economy.farms.f.tiers[0].exitFee').message, /leave for the fee/);
  });

  test('W32: a recipe of more than 15 rolls', () => {
    const spec = base({
      boxes: [
        {
          key: 'pick',
          name: 'Pick',
          price: 1,
          active: false,
          outcomes: [
            { gives: 'item', item: 'sword', weight: 1 },
            { gives: 'nothing', weight: 1 },
          ],
        },
      ],
      recipes: [
        {
          key: 'r',
          name: 'R',
          in: [{ takes: 'pay', amount: 1, to: 'treasury' }],
          out: Array.from({ length: 16 }, () => ({ gives: 'roll', box: 'pick' })),
        },
      ],
    });
    assert.match(said(spec, 'W-ANSWER', 'economy.recipes.r.out').message, /10,000 bytes/);
  });

  test('W3 in the explainer: the three settings of a box', () => {
    assert.match(whenOutWords({ whenOut: 'giveNothing' }), /a paid draw is not refunded and a free roll is over/i);
    assert.match(whenOutWords({}), /is still given after the box has stopped, and is asked again until it hits/);
    const text = explainEconomy(
      base({
        boxes: [
          {
            key: 'b',
            name: 'B',
            price: 1,
            whenOut: 'giveNothing',
            outcomes: [
              { gives: 'item', item: 'sword', weight: 1 },
              { gives: 'pay', pool: 'prizes', amount: 1, weight: 1 },
            ],
          },
        ],
      }),
      { now: NOW },
    ).text;
    assert.match(text, /giveNothing/);
  });
});

describe('the simulator’s arithmetic', () => {
  test('a boosted weight is counted in BigInt and stops at the largest weight', () => {
    assert.equal(boostedWeight(100, 10_000), 200n);
    assert.equal(boostedWeight(3, 5_000), 4n);
    assert.equal(boostedWeight(1, 4_294_967_295), 429_497n, 'the largest boost is about x429,497');
    assert.equal(boostedWeight(4_294_967_295, 4_294_967_295), MOST_WEIGHT, 'the product passes 2^53');
    assert.equal(boostedWeight(10_000, 4_294_967_295), MOST_WEIGHT);
    assert.equal(boostedWeight(0, 4_294_967_295), 0n, 'an outcome of weight 0 stays out');
    // Boosts on one outcome add up, and stop at the largest; two outcomes boosted past it are equally likely.
    const box = {
      outcomes: [
        { gives: 'nothing', weight: 10_000 },
        { gives: 'nothing', weight: 20_000 },
      ],
      odds: [
        { outcome: 0, when: { item: 'a' }, add: { addPercent: 40_000_000 } },
        { outcome: 0, when: { item: 'b' }, add: { addPercent: 40_000_000 } },
        { outcome: 1, when: { item: 'c' }, add: { perPointPercent: 1_000_000, upTo: 100 } },
      ],
    };
    assert.deepEqual(boostedWeights(box), [MOST_WEIGHT, MOST_WEIGHT]);
  });

  test('a box that gives nothing for a miss keeps selling, and its misses grow as outcomes run out', () => {
    const spec = base({
      items: [{ key: 'sword', name: 'Sword', supply: 10, uri: 'https://example.invalid/sword.json' }],
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          whenOut: 'giveNothing',
          outcomes: [
            { gives: 'item', item: 'sword', weight: 1 },
            { gives: 'nothing', weight: 3 },
          ],
        },
      ],
      scenario: { days: 30, perDay: { 'box:b': 4 } },
    });
    const box = simulate(spec, { now: NOW }).boxes[0];
    assert.equal(box.whenOut, 'giveNothing');
    assert.equal(box.stock.whenOut, 'giveNothing');
    // Four opens a day, one in four a sword: ten swords last ten days; then a quarter of the draws give nothing.
    assert.deepEqual(box.stock.runsOut, [{ inDays: 10, outcomes: [{ outcome: 0, gives: 'sword' }], missPercent: 25 }]);
    assert.equal(box.stock.stopsSellingInDays, undefined, 'it never stops selling');
  });

  test('a stash with nothing that weighs is out of stock from the start', () => {
    const spec = base({
      stashes: [{ key: 's', name: 'S', collection: OTHER, nfts: [{ asset: WALLET, weight: 0 }] }],
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [
            { gives: 'stash', stash: 's', weight: 1 },
            { gives: 'nothing', weight: 1 },
          ],
        },
      ],
    });
    const box = simulate(spec, { now: NOW }).boxes[0];
    assert.equal(box.stock.whenOut, 'stopSales');
    assert.equal(box.stock.stopsSellingInDays, 0);
  });

  test('a box’s odds rules, at their most, in its row', () => {
    const spec = base({
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 1,
          outcomes: [
            { gives: 'item', item: 'sword', weight: 1 },
            { gives: 'nothing', weight: 999 },
          ],
          odds: [{ outcome: 0, when: { item: 'shield' }, add: { addPercent: 99_900 } }],
        },
      ],
    });
    // A thousand times likelier: 1,000 against 999.
    assert.deepEqual(simulate(spec, { now: NOW }).boxes[0].oddsBoosted, [50.025012, 49.974987]);
  });

  test('a weighted round: a purchase weighs its tickets times the seconds to the close, and a place is won by weight', () => {
    const draw = 1_000_000;
    assert.equal(purchaseWeight(3, draw - 86_400 - 100, draw, 86_400), 300n);
    assert.equal(purchaseWeight(3, draw - 86_400 - 1, draw, 86_400), 3n, 'at least one a ticket');
    assert.equal(purchaseWeight(3, 0, draw, 0, false), 3n, 'unweighted: one a ticket');
    // Two buyers: one ticket held long (900 s), nine tickets bought late (10 s each): 900 against 90.
    const entries = [purchaseWeight(1, 100, 1_000), purchaseWeight(9, 990, 1_000)];
    assert.deepEqual(entries, [900n, 90n]);
    assert.deepEqual(placeWinners(entries, 1, 0n), [0]);
    assert.deepEqual(placeWinners(entries, 1, 950n), [1]);
    // Two places, half the weight apart: one buyer whose weight spans more than one step wins both.
    assert.deepEqual(placeWinners(entries, 2, 0n), [0, 0]);
    const lot = simulate(base({ lotteries: [lottery({ closesBefore: '1d', timeWeighted: true })] }), { now: NOW })
      .lotteries[0];
    assert.deepEqual(lot.weighted, { sellsForDays: 6, atOpen: 2, halfway: 1, lastHour: 0.013889 });
  });

  test('a short pool pays as its places say', () => {
    const runs = [
      { each: 1000n, places: 1 },
      { each: 500n, places: 2 },
    ];
    const sent = mode => shortPays(runs, 1700n, mode).map(r => r.each);
    assert.deepEqual(
      shortPays(runs, 1700n, 'inOrder').map(r => r.sent),
      [1000n, 500n],
      'in order: 1,000, 500 and 0',
    );
    assert.deepEqual(sent('inProportion'), [850n, 425n], 'in proportion: 850, 425 and 425');
    assert.deepEqual(sent('nothing'), [0n, 0n]);
    assert.deepEqual(sent(undefined), [1000n, 500n]);
    assert.deepEqual(
      shortPays(runs, 2000n, 'nothing').map(r => r.sent),
      [1000n, 1000n],
      'a pool that covers them',
    );
    const lot = simulate(
      base({
        lotteries: [
          lottery({
            places: [
              { percent: 0, prize: { gives: 'tokens', from: 'pool:prizes', amount: 1000 }, whenShort: 'inProportion' },
              {
                percent: 0,
                prize: { gives: 'tokens', from: 'pool:prizes', amount: 500 },
                times: 2,
                whenShort: 'inProportion',
              },
            ],
          }),
        ],
      }),
      { now: NOW },
    ).lotteries[0];
    assert.deepEqual(lot.shortPools, [
      { pool: 'prizes', holds: 1700, wins: 2000, whenShort: 'inProportion', each: [850, 425] },
    ]);
  });
});
