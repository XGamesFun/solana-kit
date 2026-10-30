// A roll a route the player pays or asks for makes (a craft's `Prize::Roll` and `RollOn`, a buy bundle's roll, a grant
// claim of a roll) passes its box's prize mints after the box and the order (`loot.rollMints`, the program's
// `order::askable`): the program refuses the whole transaction when one has a transfer hook (PrizeHasHook), and the
// player keeps what the route takes. On the real program, through the builders and js/play.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE } from '../chain/bytes.js';
import { parseCoreAsset } from '../chain/core.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import { EXECUTE_DISCRIMINATOR, validationAddress } from '../chain/token2022.js';
import * as loot from '../client/index.js';
import { buySize, check, craftSize } from '../economy/check.mjs';
import { model } from '../economy/model.mjs';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { boxArgs, cannotRun, collectible, drop, fromPool, pinned, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const t = (name, fn) => test(name, { skip }, fn);
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const HOOK = 'Hook111111111111111111111111111111111111111';
const HERO = 1;
const POOL = 3;
const FORGE = 5; // a roll from the pool, or nothing
const ANVIL = 6; // the same, rolled on a hero
const BUNDLE = 7; // sold: two rolls of the forge
const GRANT = 9;
const onHero = { of: { Item: [HERO] }, key: '', test: 'Any' };
const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
const recipeArgs = (inputs, outputs) => ({ active: true, inputs, outputs, needs: [], keeps: [], raises: [] });

/** A Token-2022 mint whose transfer hook is the test hook (with a transfer fee of 0), the owner its mint authority. */
function hookedMint(w) {
  const mint = newAddress(w.random);
  w.chain.svm.addProgram(HOOK, pinned('test_hook.so'));
  const base = new Uint8Array(166);
  base.set(uintLE(1, 4)); base.set(addressBytes(w.creator), 4); base[44] = 6; base[45] = 1; base[165] = 1;
  const fees = concat(new Uint8Array(72), uintLE(0, 8), uintLE(0, 8), uintLE(0, 2), uintLE(0, 8), uintLE(0, 8), uintLE(0, 2));
  const hook = concat(new Uint8Array(32), addressBytes(HOOK));
  const data = concat(base, uintLE(1, 2), uintLE(fees.length, 2), fees, uintLE(14, 2), uintLE(hook.length, 2), hook);
  w.chain.put(mint, { owner: TOKEN_2022_PROGRAM, lamports: w.chain.rent(data.length), data });
  const list = concat(EXECUTE_DISCRIMINATOR, uintLE(4, 4), uintLE(0, 4));
  w.chain.put(validationAddress(mint, HOOK), { owner: HOOK, lamports: w.chain.rent(list.length), data: list });
  return mint;
}

/**
 * A project whose pool `POOL` is in a coin with a transfer hook (`hooked`) or a classic one, funded; `FORGE`, switched
 * off, a roll of 100 from it or nothing; `ANVIL` the same rolled on a hero; `BUNDLE`, sold, two rolls of the forge; a
 * grant of a roll of the forge; and a hero the player holds.
 */
function fixture(seed, hooked) {
  const w = world({ seed: `${seed}-${hooked ? 'hooked' : 'plain'}` });
  const coin = hooked ? hookedMint(w) : w.newMint();
  const program = hooked ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  w.chain.send(w.creator, [loot.openPoolIx({ owner: w.creator, project: w.project, index: POOL, mint: coin })]);
  w.chain.send(w.creator, [mintToIx({ mint: coin, to: pda.pool(w.project, POOL), authority: w.creator, amount: 10_000n, tokenProgram: program })]);
  w.upsert({ Item: { id: HERO, args: collectible('Hero') } });
  const entries = [drop([fromPool(POOL, 100)]), drop([])];
  w.upsert({ Box: { id: FORGE, args: boxArgs(0n, entries, { active: false }) } });
  w.upsert({ Box: { id: ANVIL, args: boxArgs(0n, entries, { active: false, subject: onHero }) } });
  w.upsert({ Box: { id: BUNDLE, args: boxArgs(PRICE, [drop([{ Roll: [FORGE] }, { Roll: [FORGE] }])]) } });
  w.upsert({ Grant: { id: GRANT, args: { gives: { Roll: [FORGE] }, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true } } });
  const hero = w.make(HERO, w.player);
  const programs = { [coin]: program };
  // What a strict roll of the forge or the anvil passes: the box, and its pool's mint.
  const rolls = () => ({ boxes: { [FORGE]: w.read('LootBox', pda.box(w.project, FORGE)), [ANVIL]: w.read('LootBox', pda.box(w.project, ANVIL)) }, rollPools: { [POOL]: coin } });
  return { w, coin, hero, programs, rolls };
}

const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const recipe = (w, id) => w.read('Recipe', pda.recipe(w.project, id));
const items = (w) => ({ [HERO]: w.read('Item', pda.item(w.project, HERO)) });
/** Anyone asks for the waiting roll at `orderAddress`: the local oracle answers at once. */
function ask(w, orderAddress, coin, programs) {
  const order = w.read('Order', orderAddress);
  assert.equal(order.status, 'Waiting');
  w.chain.send(w.cranker, loot.askRollIx({ payer: w.cranker, orderAddress, order, box: w.read('LootBox', order.loot_box), poolMints: { [POOL]: coin }, programs }));
  assert.equal(w.read('Order', orderAddress).status, 'Rolled');
}

t('rollMints: for each token prize, its pool and an opened pool’s mint, or the mint it mints from; none for a box never written', () => {
  const project = pda.project(NOBODY, 0);
  const minted = 'So11111111111111111111111111111111111111112';
  const box = { box_id: 4, entries: [{ prizes: [fromPool(2, 1), { Item: [1] }] }, { prizes: [{ Tokens: { from: { Mint: [minted] }, amount: { Fixed: [1n] } } }, fromPool(8, 1)] }] };
  const keys = loot.rollMints(project, box, { 2: 'Mint222222222222222222222222222222222222222', 8: null }).map((m) => [m.pubkey, m.isWritable]);
  assert.deepEqual(keys, [[pda.pool(project, 2), false], ['Mint222222222222222222222222222222222222222', false], [minted, false], [pda.pool(project, 8), false]]);
  assert.deepEqual(loot.rollMints(project, null), []);
  assert.throws(() => loot.rollMints(project, box, {}), /mint of pool 2/);
  // A strict route needs the box; any other route's roll takes the box and the order alone.
  assert.throws(() => loot.prizeMetas({ project, prize: { Roll: [4] }, winner: project, strict: true }), /needs the box/);
  assert.equal(loot.prizeMetas({ project, prize: { Roll: [4] }, winner: project }).length, 2);
  assert.equal(loot.prizeMetas({ project, prize: { Roll: [4] }, winner: project, strict: true, boxes: { 4: box }, rollPools: { 2: minted, 8: null } }).length, 6);
});

t('a craft’s roll of a box paying in a hooked coin is refused and the hero stays; in a plain coin it rolls', () => {
  for (const hooked of [true, false]) {
    const { w, coin, hero, programs, rolls } = fixture('roll-mints-craft', hooked);
    w.upsert({ Recipe: { id: 1, args: recipeArgs([{ Burn: { item: HERO, count: 1 } }], [{ Prize: [{ Roll: [FORGE] }] }]) } });
    const nonce = 41n;
    const craft = () => [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 1, recipe: recipe(w, 1), assets: [hero], nonce, items: items(w), programs, ...rolls() })];
    const order = pda.order(w.project, w.player, loot.prizeRollNonce(nonce));
    if (hooked) {
      assert.throws(() => w.chain.send(w.player, craft()), /PrizeHasHook/);
      assert.equal(ownerOf(w, hero), w.player, 'the hero is not burned');
      assert.equal(w.chain.get(order), null, 'no roll made');
    } else {
      w.chain.send(w.player, craft());
      assert.ok(!w.chain.get(hero) || w.chain.get(hero).data.length <= 1, 'the hero is burned');
      ask(w, order, coin, programs);
    }
  }
});

t('a craft’s roll on the hero it keeps (RollOn) of a box paying in a hooked coin is refused; in a plain coin it rolls', () => {
  for (const hooked of [true, false]) {
    const { w, coin, hero, programs, rolls } = fixture('roll-mints-rollon', hooked);
    w.upsert({ Recipe: { id: 2, args: recipeArgs([{ Use: { item: HERO } }], [{ RollOn: { box_id: ANVIL, place: 0 } }]) } });
    const nonce = loot.nonceOn(hero);
    const craft = [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 2, recipe: recipe(w, 2), assets: [hero], nonce, items: items(w), programs, ...rolls() })];
    const order = pda.order(w.project, w.player, nonce);
    if (hooked) {
      assert.throws(() => w.chain.send(w.player, craft), /PrizeHasHook/);
      assert.equal(w.chain.get(order), null, 'no roll made');
    } else {
      w.chain.send(w.player, craft);
      ask(w, order, coin, programs);
    }
    assert.equal(ownerOf(w, hero), w.player, 'the hero stays its player’s');
  }
});

t('a bundle of two rolls of a box paying in a hooked coin is refused and the price stays; in a plain coin it buys both', () => {
  for (const hooked of [true, false]) {
    const { w, coin, programs, rolls } = fixture('roll-mints-buy', hooked);
    const box = w.read('LootBox', pda.box(w.project, BUNDLE));
    const before = w.balance(w.player);
    const nonce = 900n;
    const buy = [computeUnitLimit(600_000), loot.buyIx({ player: w.player, project: w.project, box, treasury: w.treasury, nonce, programs, ...rolls() })];
    const orders = [0n, 1n].map((k) => pda.order(w.project, w.player, loot.prizeRollNonce(nonce + k)));
    // Each roll passes the forge's pool and mint after its box and order.
    const keys = buy[1].keys.map((k) => k.pubkey);
    for (const order of orders) assert.deepEqual(keys.slice(keys.indexOf(order) + 1, keys.indexOf(order) + 3), [pda.pool(w.project, POOL), coin]);
    if (hooked) {
      assert.throws(() => w.chain.send(w.player, buy), /PrizeHasHook/);
      assert.equal(w.balance(w.player), before, 'the price stays with the player');
      for (const order of orders) assert.equal(w.chain.get(order), null);
    } else {
      w.chain.send(w.player, buy);
      assert.equal(w.balance(w.player), before - PRICE);
      for (const order of orders) ask(w, order, coin, programs);
    }
  }
});

t('a grant claim of a roll of a box paying in a hooked coin is refused and the round is not spent; in a plain coin it rolls', () => {
  for (const hooked of [true, false]) {
    const { w, coin, programs, rolls } = fixture('roll-mints-grant', hooked);
    const address = pda.grant(w.project, GRANT);
    const grant = w.read('Grant', address);
    const wallet = w.who();
    const nonce = 5n;
    const claim = [loot.claimGrantIx({ project: w.project, id: GRANT, grant, wallet, signer: wallet, nonce, programs, ...rolls() })];
    const order = pda.order(w.project, wallet, loot.prizeRollNonce(nonce));
    if (hooked) {
      assert.throws(() => w.chain.send(wallet, claim), /PrizeHasHook/);
      assert.equal(w.chain.get(pda.grantReceipt(address, grant.incarnation, wallet)), null, 'the round is not spent');
      assert.equal(w.chain.get(order), null);
    } else {
      w.chain.send(wallet, claim);
      ask(w, order, coin, programs);
    }
  }
});

t('js/play passes the rolled box’s prize mints: its craft, its bundle buy and its grant claim roll, and a hooked coin’s are refused', async () => {
  for (const hooked of [false, true]) {
    const { w, hero } = fixture('roll-mints-play', hooked);
    w.upsert({ Recipe: { id: 1, args: recipeArgs([{ Burn: { item: HERO, count: 1 } }], [{ Prize: [{ Roll: [FORGE] }] }]) } });
    const spec = {
      version: 2,
      currency: 'gold',
      tokens: [{ key: 'gold', source: 'existing', mint: w.mint, decimals: 6 }],
      boxes: [{ key: 'bundle', id: BUNDLE, name: 'Bundle' }],
      recipes: [{ key: 'forge', id: 1, name: 'Forge' }],
      grants: [{ key: 'gift', id: GRANT }],
      live: { project: w.project, collection: w.collection, mints: { gold: w.mint } },
    };
    const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: w.player, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
    const waiting = async () => (await app.claims()).filter((c) => c.kind === 'settle').length;
    const runs = [
      () => app.craft('forge', [hero], 1, { version: recipe(w, 1).version }),
      () => app.openBox('bundle', { maxPrice: PRICE }),
      () => app.claimGrant('gift'),
    ];
    if (hooked) {
      for (const run of runs) await assert.rejects(run(), /PrizeHasHook/);
      assert.equal(ownerOf(w, hero), w.player, 'the hero stays');
      assert.equal(await waiting(), 0, 'no roll made');
    } else {
      for (const run of runs) await run();
      assert.equal(await waiting(), 4, 'a roll from the craft, two from the bundle, one from the grant');
    }
  }
});

t('the checker counts a roll’s prize mints in a craft and a bundle buy', () => {
  const at = (n) => pda.project(NOBODY, n);
  const pools = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, currency: key === 'a' ? 'gold' : `t${key}`, seed: 100 }));
  const spec = (prizes) => ({
    version: 2,
    currency: 'gold',
    tokens: [{ key: 'gold', source: 'existing', mint: at(1), decimals: 6 }, ...['b', 'c', 'd', 'e'].map((k, i) => ({ key: `t${k}`, source: 'existing', mint: at(2 + i), decimals: 0 }))],
    pools,
    items: [{ key: 'hero', name: 'Hero', uri: 'https://example.invalid/h.json' }],
    boxes: [
      { key: 'wide', name: 'Wide', price: 0, active: false, outcomes: [...prizes.map((pool) => ({ gives: 'pay', pool, amount: 1, chance: 10 })), { gives: 'nothing', chance: 100 - 10 * prizes.length }] },
      {
        key: 'bundle', name: 'Bundle', price: 1, split: [10, 11, 12, 13].map((n) => ({ to: `wallet:${at(n)}`, percent: 25 })),
        outcomes: [{ gives: 'bundle', chance: 100, prizes: [{ gives: 'roll', box: 'wide' }, { gives: 'roll', box: 'wide' }, { gives: 'roll', box: 'wide' }] }],
      },
    ],
    recipes: [{ key: 'forge', name: 'Forge', in: [{ takes: 'burn', item: 'hero' }], out: [{ gives: 'roll', box: 'wide' }] }],
  });
  const narrow = model(spec(['a']));
  const wide = model(spec(['a', 'b', 'c', 'd', 'e']));
  // Five pools in five mints: ten accounts (32 bytes each, once), and an index byte each time a roll names one.
  assert.equal(craftSize(wide.recipes[0], wide) - craftSize(narrow.recipes[0], narrow), 8 * 32 + 8);
  const bundle = (m) => buySize(m.box.get('bundle'), m);
  assert.equal(bundle(wide) - bundle(narrow), 8 * 32 + 3 * 8);
  // Three rolls of a box paying from one pool fit a purchase with four wallets' shares; from five pools, no longer.
  // (as v0 with a lookup table: warned, W-TX-V0, not refused)
  const said = (prizes) => { const r = check(spec(prizes)); return [...r.refusals, ...r.warnings].filter((x) => ['E-TX-SIZE', 'W-TX-V0'].includes(x.code)).map((x) => `${x.code} ${x.where}`); };
  assert.deepEqual(said(['a']), []);
  assert.deepEqual(said(['a', 'b', 'c', 'd', 'e']), ['W-TX-V0 economy.boxes.bundle']);
});
