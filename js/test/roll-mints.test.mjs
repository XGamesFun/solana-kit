// A roll a route makes (a craft's `Prize::Roll` and `RollOn`, a bundle's roll, a grant claim of a roll) passes its box
// and its order, nothing more: what the roll can give is read when it is asked (`ask_roll`, with the box's roll
// accounts, `loot.rollAccounts`). js/play asks in the route's own transaction (one prompt); on a box with nothing in
// stock (here: its one prize in a coin with a transfer hook, which a roll can't move) that ask fails, and with it the
// whole transaction (SoldOut): the player keeps what the route took. Later, the order's own player may still ask; that
// ends it there with nothing, no oracle. On the real program, through the builders and js/play.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE } from '../chain/bytes.js';
import { parseCoreAsset } from '../chain/core.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent } from '../chain/programs.js';
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
const FORGE = 5; // a roll of 100 from the pool: its one prize
const ANVIL = 6; // the same, rolled on a hero
const BUNDLE = 7; // sold: two rolls of the forge
const GRANT = 9;
const onHero = { of: { Item: [HERO] }, key: '', test: 'Any' };
const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, all: { total: 0, per_window: 0, window: 0 }, window: { opens_at: 0n, closes_at: 0n } };
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
 * A project whose pool `POOL` is in a coin with a transfer hook (`hooked`, so the forge has nothing in stock) or a
 * classic one, funded; `FORGE`, switched off, a roll of 100 from it; `ANVIL` the same rolled on a hero; `BUNDLE`, sold,
 * two rolls of the forge; a grant of a roll of the forge; and a hero the player holds. Every write that names the forge
 * is written, hooked or not: it passes the box alone.
 */
function fixture(seed, hooked) {
  const w = world({ seed: `${seed}-${hooked ? 'hooked' : 'plain'}` });
  const coin = hooked ? hookedMint(w) : w.newMint();
  const program = hooked ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  w.chain.send(w.creator, [loot.openPoolIx({ owner: w.creator, project: w.project, index: POOL, mint: coin })]);
  w.chain.send(w.creator, [mintToIx({ mint: coin, to: pda.pool(w.project, POOL), authority: w.creator, amount: 10_000n, tokenProgram: program })]);
  w.upsert({ Item: { id: HERO, args: collectible('Hero') } });
  const entries = [drop([fromPool(POOL, 100)])];
  w.upsert({ Box: { id: FORGE, args: boxArgs(0n, entries, { active: false }) } });
  w.upsert({ Box: { id: ANVIL, args: boxArgs(0n, entries, { active: false, subject: onHero }) } });
  w.upsert({ Box: { id: BUNDLE, args: boxArgs(PRICE, [drop([{ Roll: [FORGE] }, { Roll: [FORGE] }])]) } });
  w.upsert({ Grant: { id: GRANT, args: { gives: { Roll: [FORGE] }, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true } } });
  w.upsert({ Recipe: { id: 1, args: recipeArgs([{ Burn: { item: HERO, count: 1 } }], [{ Prize: [{ Roll: [FORGE] }] }]) } });
  w.upsert({ Recipe: { id: 2, args: recipeArgs([{ Use: { item: HERO } }], [{ RollOn: { box_id: ANVIL, place: 0 } }]) } });
  const hero = w.make(HERO, w.player);
  const programs = { [coin]: program };
  /** `payer` asks for the waiting roll at `orderAddress`: the instructions (`loot.askRollIx`). */
  const asks = (payer, orderAddress) => {
    const order = w.read('Order', orderAddress) ?? { project: w.project, loot_box: pda.box(w.project, FORGE) };
    return loot.askRollIx({ payer, orderAddress, order, box: w.read('LootBox', order.loot_box), poolMints: { [POOL]: coin }, programs });
  };
  return { w, coin, hero, programs, asks };
}

const ownerOf = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const recipe = (w, id) => w.read('Recipe', pda.recipe(w.project, id));
const items = (w) => ({ [HERO]: w.read('Item', pda.item(w.project, HERO)) });
/** The ask of a roll not made yet (the route making it is in the same transaction): its order's address and box. */
const askNew = (f, payer, orderAddress, box = FORGE) => loot.askRollIx({ payer, orderAddress, order: { project: f.w.project, loot_box: pda.box(f.w.project, box) }, box: f.w.read('LootBox', pda.box(f.w.project, box)), poolMints: { [POOL]: f.coin }, programs: f.programs });

t('rollAccounts: each entry’s prize accounts, a fresh item’s tables while they fit the box’s table budget, then each mint and its vault', () => {
  const project = pda.project(NOBODY, 0);
  const minted = 'So11111111111111111111111111111111111111112';
  const coin = 'Mint222222222222222222222222222222222222222';
  const box = { box_id: 4, entries: [{ prizes: [fromPool(2, 1), { Item: [1] }] }, { prizes: [{ Tokens: { from: { Mint: [minted] }, amount: { Fixed: [1n] } } }, fromPool(8, 1)] }] };
  const fresh = { kind: 'Collectible', traits: [{ key: 'hue', from: { Table: [3] } }] };
  const keys = loot.rollAccounts(project, box, { items: { 1: fresh }, poolMints: { 2: coin, 8: null } }).map((m) => m.pubkey);
  assert.deepEqual(keys, [pda.pool(project, 2), pda.item(project, 1), pda.table(project, 3), pda.pool(project, 8), coin, loot.vault(project, coin), minted, loot.vault(project, minted)]);
  assert.deepEqual(loot.rollAccounts(project, null), []);
  assert.throws(() => loot.rollAccounts(project, box, { items: { 1: null } }), /mint of pool 2/);
  assert.throws(() => loot.rollAccounts(project, box, { poolMints: { 2: coin, 8: null } }), /needs item 1/);
  // The budget: what the box's own accounts leave of the 21 an answer carries. Here 3 + 3 named + 3 + 2 × 3 sources = 15.
  assert.equal(loot.callbackAccounts(box.entries), 15);
  assert.equal(loot.tableBudget(box.entries), 6);
  // An item of seven tables passes the six left: it takes none (out of stock), and the next item that fits takes its own.
  const wide = { kind: 'Collectible', traits: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, from: { Table: [10 + i] } })) };
  const two = { prizes: [{ Item: [1] }, { Item: [2] }] };
  const walked = loot.entryAccounts(project, [two], { 1: wide, 2: fresh }).map((m) => m.pubkey);
  assert.equal(loot.tableBudget([two]), 21 - 5);
  assert.deepEqual(walked, [pda.item(project, 1), ...wide.traits.map((x) => pda.table(project, x.from.Table[0])), pda.item(project, 2), pda.table(project, 3)], 'seven fit sixteen');
  const crowded = { prizes: [...Array.from({ length: 10 }, () => fromPool(2, 1)), { Item: [1] }, { Item: [2] }] };
  assert.equal(loot.tableBudget([crowded]), 21 - (3 + 12 + 5));
  assert.deepEqual(loot.entryAccounts(project, [crowded], { 1: wide, 2: fresh }).slice(10).map((m) => m.pubkey), [pda.item(project, 1), pda.item(project, 2), pda.table(project, 3)], 'the wide one takes none; the next fits the one left');
  // An order holds, for each draw, the rows its dearest entry's fresh items draw now (`entryRows`, the same walk).
  assert.deepEqual(loot.entryRows([two], { 1: wide, 2: fresh }), [8]);
  assert.deepEqual(loot.entryRows([crowded], { 1: wide, 2: fresh }), [1], 'the wide one draws none');
  const pack = { entries: [two, { prizes: [fromPool(2, 1)] }], slots: [{ count: 3, only: [], distinct: false }], odds: [], fates: [] };
  assert.equal(loot.orderBytes(pack, 0, 2, { 1: wide, 2: fresh }) - loot.orderBytes(pack, 0, 1, { 1: wide, 2: fresh }), 3 * (41 + 8 * 4), 'a draw: its dearest entry (tokens, 41 bytes; two items are 28) and eight rows of 4');
  assert.equal(loot.orderBytes(pack, 0, 2) - loot.orderBytes(pack, 0, 1), 3 * (41 + 10 * 4), 'a roll made in another call keeps the whole table budget a draw');
  // A write or a route naming boxes passes each once, the box alone; a roll given is its box and its order.
  assert.deepEqual(loot.boxesAccounts(project, [4, 4, 5]).map((m) => m.pubkey), [pda.box(project, 4), pda.box(project, 5)]);
  assert.deepEqual(loot.defRolls({ Recipe: { args: { outputs: [{ Prize: [{ Roll: [7] }] }, { RollOn: { box_id: 9, place: 0 } }] } } }), [7, 9]);
  assert.equal(loot.prizeMetas({ project, prize: { Roll: [4] }, winner: project }).length, 2);
});

t('a craft’s roll asked in its own transaction: on a box with nothing in stock the craft fails whole (SoldOut) and the hero stays; in stock it rolls', () => {
  for (const hooked of [true, false]) {
    const f = fixture('roll-mints-craft', hooked);
    const { w, hero, programs } = f;
    const nonce = 41n;
    const order = pda.order(w.project, w.player, loot.prizeRollNonce(nonce));
    const craft = [computeUnitLimit(1_400_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 1, recipe: recipe(w, 1), assets: [hero], nonce, items: items(w), programs }), ...askNew(f, w.player, order)];
    if (hooked) {
      assert.throws(() => w.chain.send(w.player, craft), /SoldOut/);
      assert.equal(ownerOf(w, hero), w.player, 'the hero is not burned');
      assert.equal(w.chain.get(order), null, 'no roll made');
    } else {
      w.chain.send(w.player, craft);
      assert.ok(!w.chain.get(hero) || w.chain.get(hero).data.length <= 1, 'the hero is burned');
      assert.equal(w.read('Order', order).status, 'Rolled', 'asked and answered in one go');
    }
  }
});

t('a roll made on a box with nothing in stock: a stranger’s ask is refused; its player’s own, a slot later, ends it with nothing, no oracle', () => {
  const f = fixture('roll-mints-empty', true);
  const { w, hero, programs } = f;
  const nonce = loot.nonceOn(hero);
  w.chain.send(w.player, [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: 2, recipe: recipe(w, 2), assets: [hero], nonce, items: items(w), programs, boxes: { [ANVIL]: w.read('LootBox', pda.box(w.project, ANVIL)) } })]);
  const order = pda.order(w.project, w.player, loot.namedRollNonce(w.read('LootBox', pda.box(w.project, ANVIL)), hero, nonce));
  assert.equal(w.read('Order', order).status, 'Waiting');
  w.chain.nextSlot();
  assert.throws(() => w.chain.send(w.cranker, f.asks(w.cranker, order)), /SoldOut/, 'a stranger never lands a roll on an empty box');
  const asked = w.chain.send(w.player, f.asks(w.player, order));
  assert.equal(asked.answers.length, 0, 'no oracle asked');
  const rolled = w.read('Order', order);
  assert.deepEqual([rolled.status, rolled.won], ['Rolled', []], 'a free roll its player ends on an empty box rolls with nothing');
  w.chain.nextSlot();
  w.chain.send(w.player, [loot.settleIx({ signer: w.player, orderAddress: order, order: rolled, projectState: w.projectState() })]);
  assert.equal(w.chain.get(order), null, 'settled: closed');
  assert.equal(ownerOf(w, hero), w.player, 'the hero stays its player’s');
});

t('a bundle of two rolls bought with their asks: refused whole on an empty box, the price kept; in stock both roll', () => {
  for (const hooked of [true, false]) {
    const f = fixture('roll-mints-buy', hooked);
    const { w, programs } = f;
    const box = w.read('LootBox', pda.box(w.project, BUNDLE));
    const before = w.balance(w.player);
    const nonce = 900n;
    const orders = [0n, 1n].map((k) => pda.order(w.project, w.player, loot.prizeRollNonce(nonce + k)));
    const buy = loot.buyIx({ player: w.player, project: w.project, box, treasury: w.treasury, nonce, programs });
    // Each roll is its box and its order, nothing after them.
    const keys = buy.keys.map((k) => k.pubkey);
    for (const order of orders) assert.equal(keys[keys.indexOf(order) - 1], pda.box(w.project, FORGE));
    const all = [computeUnitLimit(1_400_000), buy, ...orders.flatMap((o) => askNew(f, w.player, o))];
    if (hooked) {
      assert.throws(() => w.chain.send(w.player, all), /SoldOut/);
      assert.equal(w.balance(w.player), before, 'the price stays with the player');
      for (const order of orders) assert.equal(w.chain.get(order), null);
    } else {
      w.chain.send(w.player, all);
      assert.equal(w.balance(w.player), before - PRICE);
      for (const order of orders) assert.equal(w.read('Order', order).status, 'Rolled');
    }
  }
});

t('a grant claim of a roll with its ask: refused whole on an empty box, the round not spent; in stock it rolls', () => {
  for (const hooked of [true, false]) {
    const f = fixture('roll-mints-grant', hooked);
    const { w, programs } = f;
    const address = pda.grant(w.project, GRANT);
    const grant = w.read('Grant', address);
    const wallet = w.who();
    const nonce = 5n;
    const order = pda.order(w.project, wallet, loot.prizeRollNonce(nonce));
    const claim = [computeUnitLimit(1_400_000), loot.claimGrantIx({ project: w.project, id: GRANT, grant, wallet, signer: wallet, nonce, programs }), ...askNew(f, wallet, order)];
    if (hooked) {
      assert.throws(() => w.chain.send(wallet, claim), /SoldOut/);
      assert.equal(w.chain.get(order), null);
    } else {
      w.chain.send(wallet, claim);
      assert.equal(w.read('Order', order).status, 'Rolled');
    }
  }
});

t('js/play asks for a route’s rolls in its own transaction: one prompt; on an empty box it sends nothing and says so', async () => {
  for (const hooked of [true, false]) {
    const { w, hero } = fixture('roll-mints-play', hooked);
    const spec = {
      version: 2,
      currency: 'gold',
      tokens: [{ key: 'gold', source: 'existing', mint: w.mint, decimals: 6 }],
      boxes: [{ key: 'bundle', id: BUNDLE, name: 'Bundle' }],
      recipes: [{ key: 'forge', id: 1, name: 'Forge' }],
      grants: [{ key: 'gift', id: GRANT }],
      live: { project: w.project, collection: w.collection, mints: { gold: w.mint } },
    };
    const signed = [];
    const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: w.player, async signTransaction(wire) { signed.push(wire); return wire; } }, now: () => w.chain.now() });
    const waiting = async () => (await app.claims()).filter((c) => c.kind === 'settle').length;
    const runs = [
      () => app.craft('forge', [hero], 1, { version: recipe(w, 1).version }),
      () => app.openBox('bundle', { maxPrice: PRICE }),
      () => app.claimGrant('gift'),
    ];
    if (hooked) {
      for (const run of runs) await assert.rejects(run(), /SoldOut/);
      assert.equal(ownerOf(w, hero), w.player, 'the hero stays');
      assert.equal(signed.length, 0, 'nothing was sent');
      assert.equal(await waiting(), 0, 'no roll made');
    } else {
      const [crafted, bought, claimed] = [await runs[0](), await runs[1](), await runs[2]()];
      // Each roll is asked in its route's own transaction and settled by a key after: one prompt each.
      assert.ok(crafted.rolled?.settled);
      assert.equal(bought.rolls?.length, 2);
      assert.equal(claimed.rolls?.length, 1);
      assert.equal(signed.length, 3, 'one prompt a route');
      assert.equal(await waiting(), 0, 'every roll settled');
    }
  }
});

t('the checker counts a roll given as its box and its order only, whatever the box gives', () => {
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
  assert.equal(craftSize(wide.recipes[0], wide), craftSize(narrow.recipes[0], narrow));
  const bundle = (m) => buySize(m.box.get('bundle'), m);
  assert.equal(bundle(wide), bundle(narrow));
  const said = (prizes) => { const r = check(spec(prizes)); return [...r.refusals, ...r.warnings].filter((x) => ['E-TX-SIZE', 'W-TX-V0'].includes(x.code)).map((x) => `${x.code} ${x.where}`); };
  assert.deepEqual(said(['a', 'b', 'c', 'd', 'e']), []);
});

t('a lottery paid in a hooked coin: its ask and each pull carry the hook’s accounts, its common share pulled like any part', () => {
  const w = world({ seed: 'hooked-sweep' });
  const coin = hookedMint(w);
  // The test hook counts each transfer in an account its list names: a list of one.
  const counter = newAddress(w.random);
  w.chain.put(validationAddress(coin, HOOK), { owner: HOOK, lamports: w.chain.rent(51), data: concat(EXECUTE_DISCRIMINATOR, uintLE(39, 4), uintLE(1, 4), Uint8Array.of(0), addressBytes(counter), Uint8Array.of(0, 1)) });
  w.chain.put(counter, { owner: HOOK, lamports: w.chain.rent(16), data: new Uint8Array(16) });
  const programs = { [coin]: TOKEN_2022_PROGRAM };
  // What every transfer of the coin carries: the hook program, its list and the account the list names.
  const extra = [{ pubkey: HOOK, isSigner: false, isWritable: false }, { pubkey: validationAddress(coin, HOOK), isSigner: false, isWritable: false }, { pubkey: counter, isSigner: false, isWritable: true }];
  w.upsert({ Lottery: { id: 1, args: { price: 1000n, mint: coin, shares: [{ to: 'Treasury', bps: 1000 }], places: [10_000], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null } } });
  const address = pda.lottery(w.project, 1);
  const lottery = w.read('Lottery', address);
  const buyers = [w.who(), w.who()];
  for (const buyer of buyers) {
    w.chain.send(w.creator, [createAssociatedTokenAccountIdempotent(w.creator, buyer, coin, TOKEN_2022_PROGRAM), mintToIx({ mint: coin, to: loot.ata(buyer, coin, TOKEN_2022_PROGRAM), authority: w.creator, amount: 10_000n, tokenProgram: TOKEN_2022_PROGRAM })]);
    w.chain.send(buyer, [loot.buyTicketsIx({ player: buyer, project: w.project, id: 1, lottery, round: w.round(1)?.round ?? null, count: 2n, programs, extra })]);
  }
  w.chain.warp(w.chain.now() + 3601);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id: 1, lottery, extra })]);
  const treasury = loot.ata(w.treasury, coin, TOKEN_2022_PROGRAM);
  assert.deepEqual(loot.commonOwed(w.round(1).round), [{ Common: [0] }], 'the treasury’s share, owed in common');
  w.finishRound(1, { extra: { programs, extra } });
  assert.equal(w.round(1), null, 'every part pulled, the round closed');
  assert.equal(w.chain.tokens(treasury), 400n, 'the treasury’s 10% of 4,000');
});

t('js/play buys, draws and pulls a lottery paid in a hooked coin, reading the hook’s accounts itself', async () => {
  const w = world({ seed: 'hooked-play' });
  const coin = hookedMint(w);
  const counter = newAddress(w.random);
  w.chain.put(validationAddress(coin, HOOK), { owner: HOOK, lamports: w.chain.rent(51), data: concat(EXECUTE_DISCRIMINATOR, uintLE(39, 4), uintLE(1, 4), Uint8Array.of(0), addressBytes(counter), Uint8Array.of(0, 1)) });
  w.chain.put(counter, { owner: HOOK, lamports: w.chain.rent(16), data: new Uint8Array(16) });
  w.upsert({ Lottery: { id: 1, args: { price: 1000n, mint: coin, shares: [{ to: 'Treasury', bps: 1000 }], places: [10_000], ticket_mint: NOBODY, every: 0n, draws_at: BigInt(w.chain.now() + 3600), gate: null } } });
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: coin, decimals: 6, program: 'token-2022' }], lotteries: [{ key: 'draw', name: 'Draw', id: 1 }], live: { project: w.project, collection: w.collection, mints: { coin } } };
  const players = [w.who(), w.who()];
  const apps = players.map((p) => solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: p, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() }));
  for (const p of players) w.chain.send(w.creator, [createAssociatedTokenAccountIdempotent(w.creator, p, coin, TOKEN_2022_PROGRAM), mintToIx({ mint: coin, to: loot.ata(p, coin, TOKEN_2022_PROGRAM), authority: w.creator, amount: 10_000n, tokenProgram: TOKEN_2022_PROGRAM })]);
  for (const app of apps) await app.buyTickets('draw', 2, { maxPrice: 1000n });
  w.chain.warp(w.chain.now() + 3601);
  // Each step from the page, until nothing is left: the draw, then each part pulled.
  for (let i = 0; i < 10; i++) {
    const steps = (await Promise.all(apps.map(async (app) => (await app.claims()).filter((c) => ['reveal', 'pull', 'payout'].includes(c.kind)).map((c) => [app, c])))).flat();
    if (!steps.length) break;
    const [app, c] = steps[0];
    await app.claim(c);
  }
  assert.equal(w.round(1), null, 'the round closed');
  assert.equal(w.chain.tokens(loot.ata(w.treasury, coin, TOKEN_2022_PROGRAM)), 400n, 'the treasury’s 10%');
  const left = players.map((p) => w.chain.tokens(loot.ata(p, coin, TOKEN_2022_PROGRAM)));
  assert.deepEqual(left.sort((a, b) => (a < b ? -1 : 1)), [8_000n, 11_600n], 'the winner took the pot: 3,600');
});
