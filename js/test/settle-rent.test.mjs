// One rent figure for a settle: what the cost and the simulation say the open lends the key that settles it
// (model.mjs `settleRentUnits`) is what the client funds that key with (`loot.settleRent`), for every box of every
// bundled example and for boxes at each thing the count turns on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { examples } from '../economy/examples.mjs';
import { model, SETTLE_RENT_UNIT, settleRentUnits } from '../economy/model.mjs';
import { boxArgs, itemArgs } from '../economy/plan.mjs';

const NOW = 1_800_000_000;
const N = 'So11111111111111111111111111111111111111113';
const PARTNER = '5q8LtcGwYhYRq5M8dQ79wkeLvo8N993a7aoE6DLDBXaw';

/** The units the client funds a settle of box `b` with: its rent, in `SETTLE_RENT_UNIT`s. */
const clientUnits = (b, m) => {
  const items = Object.fromEntries(m.items.map(it => [it.id, itemArgs(it, m)]));
  return Number(loot.settleRent(boxArgs(b, m), 1, items) / loot.SETTLE_RENT_UNIT);
};

/** A spec of the boxes given, with two pools, two tokens it mints, a stash, a table and the items they name. */
const spec = boxes => ({
  version: 2,
  network: 'devnet',
  name: 'Settle rent',
  currency: 'gold',
  tokens: [
    { key: 'gold', source: 'project', name: 'Gold', symbol: 'GOLD', decimals: 0 },
    { key: 'gems', source: 'project', name: 'Gems', symbol: 'GEMS', decimals: 0 },
  ],
  tables: [{ key: 'colours', rows: [{ label: 'red', weight: 1 }] }],
  pools: [
    { key: 'a', currency: 'gold', seed: 1000 },
    { key: 'b', currency: 'gold', seed: 1000 },
  ],
  stashes: [{ key: 'vault', name: 'Vault', collection: PARTNER, nfts: [N] }],
  items: [
    { key: 'card', name: 'Card' },
    { key: 'pet', name: 'Pet', drawn: [{ attribute: 'colour', table: 'colours' }] },
  ],
  boxes: boxes.map((b, i) => ({ key: `box-${i}`, name: `Box ${i}`, price: 10, ...b })),
});
const pay = (pool, chance) => ({ gives: 'tokens', from: `pool:${pool}`, amount: 5, chance });
const mint = (currency, chance) => ({
  gives: 'tokens',
  from: 'mint',
  amount: 5,
  chance,
  ...(currency ? { currency } : {}),
});

test('the model counts a settle’s rent as the client does', () => {
  assert.equal(SETTLE_RENT_UNIT, loot.SETTLE_RENT_UNIT);
  let boxes = 0;
  for (const { name, spec: example } of examples()) {
    const m = model(example, { now: NOW });
    for (const b of m.allBoxes) {
      assert.equal(settleRentUnits(b, m), clientUnits(b, m), `${name}: ${b.key}`);
      boxes += 1;
    }
  }
  assert.ok(boxes > 30, `${boxes} boxes of the examples compared`);
  // Each thing the count turns on, by what the box gives: [outcomes and the rest of the box, the units].
  const cases = [
    // each pool it may pay from is a source of its own
    [{ outcomes: [pay('a', 50), pay('b', 50)] }, 2],
    [{ outcomes: [pay('a', 50), pay('a', 50)] }, 1],
    // a token minted is one source, named or the project's currency by default; a pool of that token is another
    [{ outcomes: [mint(undefined, 50), mint('gold', 50)] }, 1],
    [{ outcomes: [mint('gold', 50), mint('gems', 50)] }, 2],
    [{ outcomes: [mint('gold', 50), pay('a', 50)] }, 2],
    // the outcome that opens the most accounts, once a draw: a collectible, a stash's NFT, a fresh compressed NFT
    [
      {
        outcomes: [
          {
            gives: 'bundle',
            chance: 50,
            prizes: [{ gives: 'item', item: 'card' }, { gives: 'item', item: 'card' }, pay('a')],
          },
          { gives: 'stash', stash: 'vault', chance: 50 },
        ],
      },
      3,
    ],
    [
      {
        outcomes: [
          { gives: 'item', item: 'card', compressed: true, chance: 50 },
          { gives: 'nothing', chance: 50 },
        ],
      },
      0,
    ],
    [
      {
        outcomes: [
          { gives: 'item', item: 'pet', compressed: true, chance: 50 },
          { gives: 'nothing', chance: 50 },
        ],
      },
      1,
    ],
    // each draw of a pack may open its own, and an NFT rolled on has its fate
    [
      {
        slots: [{ count: 3 }],
        outcomes: [
          { gives: 'item', item: 'card', chance: 50 },
          { gives: 'nothing', chance: 50 },
        ],
      },
      3,
    ],
    [{ rollsOn: { item: 'card' }, outcomes: [pay('a', 50), { gives: 'nothing', chance: 50 }] }, 2],
  ];
  const m = model(spec(cases.map(([b]) => b)), { now: NOW });
  cases.forEach(([, units], i) => {
    assert.equal(settleRentUnits(m.boxes[i], m), units, `box ${i}`);
    assert.equal(clientUnits(m.boxes[i], m), units, `box ${i}, as the client counts it`);
  });
});

test('the cost of an open quotes that rent: a box paying from two pools lends its settle two units', () => {
  const two = spec([{ outcomes: [pay('a', 50), pay('b', 50)] }]);
  assert.deepEqual(check(two, { now: NOW }).refusals, []);
  const open = cost(two, { now: NOW }).actions.find(a => a.part === 'box:box-0');
  const lent = open.deposits.find(d => /lends the throwaway key/.test(d.what));
  assert.equal(lent.sol, (2 * Number(SETTLE_RENT_UNIT)) / 1e9);
  assert.match(lent.what, /\(2 × 0\.006 SOL:/);
});
