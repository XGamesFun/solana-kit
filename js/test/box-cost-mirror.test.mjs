// The client's copy of the program's box cost check, held against the program: for boxes at and around each edge loot
// 0.26.1 names, `boxFits` says a box fits exactly when the program writes it, and `drawsFit` with `purchase` (what
// `opensAnOrder` counts) says a purchase fits exactly when `open_box` sells it. Each purchase at its edge is answered by
// the oracle with the compute its real answer has, every draw made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYSVAR_SLOT_HASHES } from '../chain/pda.js';
import { slotHashes } from '../chain/lookup.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { freshAddresses, prepare } from '../economy/live.mjs';
import { plan } from '../economy/plan.mjs';
import { boxArgs, cannotRun, collectible, drop, fromPool, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const blank = () => drop([]);
const blanks = n => Array.from({ length: n }, blank);
const slot = count => [{ count, only: [], distinct: false, share: 0 }];

/** Whether the program writes box `id` with these args (sent with all the compute a transaction has, so only its own
 * count refuses it): true, or false when it refuses it as too large. Any other failure throws. */
function writes(w, id, args) {
  try {
    w.chain.send(w.creator, [
      computeUnitLimit(1_400_000),
      loot.upsertIx({
        owner: w.creator,
        project: w.project,
        def: { Box: { id, args: { ...args, currency: w.mint } } },
      }),
    ]);
    return true;
  } catch (e) {
    if (/PackTooLarge/.test(e.message)) return false;
    throw e;
  }
}

/** The most `n` the client says fits, from `from` up. */
const most = (fits, from = 1) => {
  let n = from;
  while (fits(n + 1)) n += 1;
  return n;
};

/**
 * The client's verdict and the program's, for box `id` written as `make(n)` at `n` one below, at and one above the
 * client's most (`edge`). Returns the client's most.
 */
function sameEdge(w, id, make, label, from = 1) {
  const fits = n => loot.boxFits(make(n), { project: w.project });
  const edge = most(fits, from);
  for (const n of [edge - 1, edge, edge + 1].filter(n => n >= from))
    assert.equal(writes(w, id, make(n)), fits(n), `${label} at ${n} (the client's most is ${edge})`);
  // Left written at its most.
  assert.ok(writes(w, id, make(edge)));
  return edge;
}

let nonce = 1000n;
/**
 * `count` opens of box `id` bought in one `open_box`: the order, answered by the oracle, or null when the program refuses
 * the purchase as too large. Any other failure (the answer's included) throws.
 */
function buys(w, id, count, more = {}) {
  const box = w.read('LootBox', pda.box(w.project, id));
  nonce += 1n;
  try {
    w.chain.send(w.player, [
      computeUnitLimit(1_400_000),
      loot.openBoxIx({
        player: w.player,
        project: w.project,
        box,
        nonce,
        maxPrice: BigInt(box.price) * BigInt(count),
        count,
        ...more,
      }),
    ]);
  } catch (e) {
    if (/PackTooLarge/.test(e.message)) return null;
    throw e;
  }
  return w.read('Order', pda.order(w.project, w.player, nonce));
}

/** What the client says of a purchase of `count` opens of box `id` as written (`open_box`'s count). */
function clientBuys(w, id, count) {
  const box = w.read('LootBox', pda.box(w.project, id));
  return loot.drawsFit(box.entries, box.slots.length ? box.slots : 1, count, {
    odds: box.odds.length,
    shares: box.shares.length,
    fates: box.fates.length,
    bytes: loot.boxBytes(box),
    project: box.project,
    purchase: true,
  });
}

/** Every draw of `order` made: rolled, nothing undrawn. */
function allDrawn(order, draws, label) {
  assert.equal(order.status, 'Rolled', label);
  assert.deepEqual([order.drew, order.undrawn], [draws, 0], `${label}: every draw made`);
}

/** A pool or stash id of `w`'s project whose address takes `tries` tries to find. */
const takes = (w, pool, tries, skipIds = []) =>
  Array.from({ length: 5000 }, (_, i) => i + 1).find(
    i => !skipIds.includes(i) && loot.searchTries(w.project, pool, i) === tries,
  );

/** Puts `n` of the project's own collectibles in stash `id`; returns them. */
function stock(w, id, n) {
  const nfts = Array.from({ length: n }, () => ({ asset: w.make(1, w.authority), collection: w.collection }));
  const [first, ...more] = nfts;
  w.chain.send(w.authority, [
    computeUnitLimit(1_400_000),
    loot.stashIx({ signer: w.authority, project: w.project, id, ...first, more }),
  ]);
  return nfts.map(x => x.asset);
}

t('a pack of entries that give nothing: written up to 116 draws, each lands; 109 opens of one sold, each lands', () => {
  const w = world({ seed: 'mirror-blank' });
  // Two entries that give nothing, a pack of `n` draws: 115, 116 and 117 against the program.
  const edge = sameEdge(w, 1, n => boxArgs(1n, blanks(2), { slots: slot(n) }), 'a pack of blank draws');
  assert.equal(edge, 116, 'the program’s changelog');
  allDrawn(buys(w, 1, 1), 116, '116 blank draws');
  // A box of two such entries, one draw an open: 108, 109 and 110 opens in one purchase.
  assert.ok(writes(w, 2, boxArgs(1n, blanks(2))));
  const opens = most(n => clientBuys(w, 2, n));
  assert.equal(opens, 109, 'the program’s changelog');
  assert.equal(loot.opensAnOrder(w.read('LootBox', pda.box(w.project, 2))), 109, 'what js/play puts in one order');
  for (const n of [108, 109, 110]) {
    const order = buys(w, 2, n);
    assert.equal(Boolean(order), clientBuys(w, 2, n), `${n} opens`);
    if (order) allDrawn(order, n, `${n} opens`);
  }
});

t('a count no answer or transaction could carry is refused before any price is added up', () => {
  const w = world({ seed: 'mirror-counts' });
  assert.ok(writes(w, 1, boxArgs(1n, blanks(2))));
  w.fund(w.player, w.mint, 100_000_000n);
  assert.equal(loot.MOST_DRAWS_A_PURCHASE, 300);
  for (const n of [301, 24_763, 4_294_967_295]) {
    assert.equal(clientBuys(w, 1, n), false, `${n} opens`);
    assert.equal(buys(w, 1, n), null, `${n} opens: PackTooLarge`);
  }
  // A `buy` of more sales than one transaction can price (25,454) is refused with the same error.
  assert.equal(loot.MOST_SALES_A_BUY, 25_454);
  const gem = w.newMint(w.creator);
  w.upsert({ Box: { id: 2, args: boxArgs(1n, [drop([{ Tokens: { from: { Mint: [gem] }, amount: 1n } }])]) } });
  const box = w.read('LootBox', pda.box(w.project, 2));
  const buy = count =>
    w.chain.send(w.player, [
      computeUnitLimit(1_400_000),
      loot.buyIx({
        player: w.player,
        project: w.project,
        box,
        maxPrice: BigInt(count),
        count,
        treasury: w.treasury,
        nonce: 1n,
      }),
    ]);
  assert.throws(() => buy(loot.MOST_SALES_A_BUY + 1), /PackTooLarge/);
});

t('thirteen entries of one pool: 8 draws where its address takes 1 try, 5 where it takes 4; each sold lands', () => {
  const w = world({ seed: 'mirror-pool' });
  const entries = pool => Array.from({ length: 13 }, (_, i) => drop([fromPool(pool, i + 1)]));
  for (const [tries, expected] of [
    [1, 8],
    [2, 7],
    [4, 5],
  ]) {
    const pool = takes(w, true, tries);
    w.pool(pool, w.mint, 10_000n);
    const id = 10 + tries;
    const edge = sameEdge(
      w,
      id,
      n => boxArgs(1n, entries(pool), { slots: slot(n) }),
      `13 entries of a pool, ${tries} tries`,
    );
    assert.equal(edge, expected, `${tries} tries: the program’s table`);
    assert.equal(clientBuys(w, id, 1), true);
    allDrawn(buys(w, id, 1, { poolMints: { [pool]: w.mint } }), edge, `${tries} tries, ${edge} draws`);
  }
  // Boxes that name no pool and no stash, whose edges the search does not move: sixteen entries of minted tokens (the
  // answer's heap binds), twelve items.
  const gem = w.newMint(w.creator);
  const tokens = Array.from({ length: 16 }, (_, i) =>
    drop([{ Tokens: { from: { Mint: [gem] }, amount: BigInt(i + 1) } }]),
  );
  sameEdge(w, 20, n => boxArgs(1n, tokens, { slots: slot(n) }), '16 entries of tokens');
  for (let i = 0; i < 12; i++) w.upsert({ Item: { id: 100 + i, args: collectible(`Card ${i}`) } });
  const items = Array.from({ length: 12 }, (_, i) => drop([{ Item: [100 + i] }]));
  sameEdge(w, 21, n => boxArgs(1n, items, { slots: slot(n) }), 'twelve items');
});

t(
  'sixteen stashes: 9 draws when finding them all takes 36 tries; the client and the program agree at other sums',
  () => {
    const w = world({ seed: 'mirror-stashes' });
    w.upsert({ Item: { id: 1, args: collectible('Relic') } });
    // Sixteen stash ids whose addresses take 36 tries in all: eight of 1, four of 2, two of 3, one of 4 and one of 10.
    const ids = [];
    for (const [tries, n] of [
      [1, 8],
      [2, 4],
      [3, 2],
      [4, 1],
      [10, 1],
    ])
      for (let k = 0; k < n; k++) ids.push(takes(w, false, tries, ids));
    assert.equal(
      ids.reduce((n, id) => n + loot.searchTries(w.project, false, id), 0),
      36,
    );
    for (const id of ids) stock(w, id, 1);
    const entries = list => list.map(id => drop([{ Stash: [id] }]));
    const box = (list, n) => boxArgs(1n, entries(list), { slots: slot(n), when_out: 'DrawLeft' });
    const edge = sameEdge(w, 1, n => box(ids, n), '16 stashes, 36 tries');
    assert.equal(edge, 9, 'the program’s table');
    assert.equal(clientBuys(w, 1, 1), true);
    allDrawn(buys(w, 1, 1), 9, '16 stashes, 9 draws');
    // The first sixteen ids, whatever their sum; and sixteen that take 4 tries each.
    sameEdge(
      w,
      2,
      n =>
        box(
          Array.from({ length: 16 }, (_, i) => i + 1),
          n,
        ),
      '16 stashes, ids 1 to 16',
    );
    const four = [];
    for (let k = 0; k < 16; k++) four.push(takes(w, false, 4, four));
    sameEdge(w, 3, n => box(four, n), '16 stashes of 4 tries');
  },
);

t('a stash, a pool or a named NFT beside entries that give nothing: the same edge on both sides, and it sells', () => {
  const w = world({ seed: 'mirror-beside' });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const stash = takes(w, false, 3);
  stock(w, stash, 3);
  const pool = takes(w, true, 2);
  w.pool(pool, w.mint, 10_000n);
  const named = takes(w, false, 1, [stash]);
  const [nft] = stock(w, named, 1);
  const prizes = { stash: { Stash: [stash] }, pool: fromPool(pool, 1), named: { Nft: { stash: named, nft } } };
  let id = 1;
  for (const [kind, prize] of Object.entries(prizes))
    for (const k of [1, 4, 8]) {
      const make = n => boxArgs(1n, [drop([prize]), ...blanks(k)], { slots: slot(n), when_out: 'DrawLeft' });
      const edge = sameEdge(w, id, make, `${kind} beside ${k} blanks`);
      // A purchase of one open at the most written is sold (each draw may miss what ran out: a stash's few NFTs).
      assert.equal(clientBuys(w, id, 1), true, `${kind} beside ${k} blanks: one open`);
      const order = buys(w, id, 1, { poolMints: { [pool]: w.mint } });
      assert.ok(order, `${kind} beside ${k} blanks: sold at ${edge} draws`);
      assert.equal(order.status, 'Rolled');
      id += 1;
    }
  // One draw an open (no slots): a stash beside as many blanks as the write takes.
  const one = n => boxArgs(1n, [drop([{ Stash: [stash] }]), ...blanks(n)], { when_out: 'DrawLeft' });
  const edge = sameEdge(w, 50, one, 'a stash beside blanks, one draw', 1);
  assert.ok(edge > 100, `${edge} blanks`);
  assert.ok(buys(w, 50, 1), 'sold');
});

t(
  'a prize of 0 from a pool never opened: the box is written as the client says, and that entry is out of stock',
  () => {
    const w = world({ seed: 'mirror-unopened' });
    w.upsert({ Item: { id: 70, args: collectible('Crown') } });
    const pool = 9;
    assert.equal(w.chain.get(pda.pool(w.project, pool)), null, 'never opened');
    const crown = { Item: [70] };
    const both = drop([crown, fromPool(pool, 0)]);
    // One entry that stops selling once out: written, then sold out at every purchase.
    const alone = boxArgs(1n, [both]);
    assert.equal(writes(w, 1, alone), loot.boxFits(alone, { project: w.project }));
    assert.throws(() => buys(w, 1, 1, { poolMints: { [pool]: null } }), /SoldOut/);
    // Two entries that draw among what is left: every draw lands on the other entry, the crown alone, at its price.
    const two = boxArgs(1n, [both, drop([crown])], { when_out: 'DrawLeft' });
    assert.equal(writes(w, 2, two), loot.boxFits(two, { project: w.project }));
    for (let k = 0; k < 4; k++) {
      const order = buys(w, 2, 1, { poolMints: { [pool]: null } });
      assert.equal(order.status, 'Rolled');
      assert.deepEqual(
        order.won.map(x => Object.keys(x)[0]),
        ['Item'],
        'the crown alone',
      );
      assert.equal(BigInt(order.back), 0n, 'nothing given back: the draw was made');
    }
  },
);

t('a box naming sixteen stashes goes live through the plan, whatever its addresses take to find', () => {
  // A box's write finds each stash's address: 1,500 units a try. Sixteen whose addresses take 5 tries each (80 in all)
  // need more than the 200,000 units an instruction has by default; the plan's transaction asks for all it can have.
  const w = world({ project: false, seed: 'mirror-plan' });
  const NOW = 1_790_000_000;
  w.chain.warp(NOW);
  const project = pda.project(w.creator, 0);
  const ids = [];
  for (let i = 1; ids.length < 16; i++) if (loot.searchTries(project, false, i) === 5) ids.push(i);
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Stashes',
    currency: 'gem',
    tokens: [{ key: 'gem', source: 'project', symbol: 'GEM', decimals: 6 }],
    collection: { name: 'Stashes' },
    stashes: ids.map((id, i) => ({ key: `s${i}`, id, name: `S${i}`, nfts: [] })),
    boxes: [
      {
        key: 'b',
        name: 'B',
        price: 1,
        whenOut: 'drawLeft',
        outcomes: ids.map((_, i) => ({ gives: 'stash', stash: `s${i}`, weight: 1 })),
      },
    ],
  };
  const keys = freshAddresses(plan(spec, { now: NOW }).freshKeys, w.random);
  const p = prepare(spec, {
    owner: w.creator,
    keys,
    now: NOW,
    rent: bytes => w.chain.rent(bytes),
    slot: slotHashes(w.chain.get(SYSVAR_SLOT_HASHES)?.data)[0] ?? null,
  });
  assert.ok(p.ok, JSON.stringify(p.refusals));
  let units = 0;
  for (const tx of p.transactions) {
    const r = w.chain.send(tx.signer === 'authority' ? p.ctx.authority : w.creator, tx.instructions);
    if (tx.steps.some(s => s.id === 'box:b:LootBox')) {
      assert.equal(tx.instructions[0].programId, 'ComputeBudget111111111111111111111111111111');
      units = r.units;
    }
  }
  const box = w.read('LootBox', pda.box(p.ctx.project, 1));
  assert.equal(box.entries.length, 16);
  assert.ok(units > 200_000, `the write took ${units} units: more than an instruction has by default`);
});
