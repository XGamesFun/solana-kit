// The economy layer: every example checks, simulates and plans; and every example goes live on the real program in
// LiteSVM, transaction by transaction, exactly as the approval page would send them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM, parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, meta } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { freshAddresses, prepare, recordLanded } from '../economy/live.mjs';
import { boxBuys, compressedTree, model } from '../economy/model.mjs';
import { auctionSeller, plan, recordBytesOf, itemArgs, boxArgs, recipeArgs, scheduleArgs, lotteryArgs, grantArgs, farmArgs, prizeArgs } from '../economy/plan.mjs';
import { explain, simulate } from '../economy/simulate.mjs';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, cannotRunCompressed, world } from './world.mjs';

const NOW = 1_790_000_000;
const dir = new URL('../../examples/', import.meta.url);
const examples = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'ideas.json').map((f) => [f, JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]);
const skip = cannotRun();

describe('every example', () => {
  for (const [name, spec] of examples) {
    test(`${name}: checks, simulates and plans`, () => {
      const r = check(spec, { now: NOW });
      assert.ok(r.ok, r.refusals.map((x) => `${x.code} ${x.message}`).join('\n'));
      const sim = simulate(spec, { now: NOW });
      assert.ok(explain(sim, spec).length > 0);
      const p = plan(spec, { now: NOW });
      assert.ok(p.ok);
      for (const t of p.transactions) assert.ok(t.bytes <= 1168, `${t.bytes} bytes`);
    });
  }
});

/** An existing mint at its own address, the test's owner its mint authority. */
function putMint(w, mint, decimals, program) {
  const data = concat(uintLE(1, 4), addressBytes(w.creator), uintLE(0, 8), Uint8Array.of(decimals, 1), uintLE(0, 4), new Uint8Array(32));
  w.chain.put(mint, { owner: program, lamports: w.chain.rent(82), data });
}

/** A Core asset in `collection`, made by its update authority `maker` for `owner` (Core CreateV2). */
function coreAsset(w, collection, maker, owner) {
  const asset = newAddress(w.random);
  const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
  const data = concat(Uint8Array.of(20, 0), str('Partner NFT'), str('https://example.invalid/partner.json'), Uint8Array.of(0, 0));
  const keys = [meta(asset, true, true), meta(collection, false, true), meta(maker, true, false), meta(maker, true, true), meta(owner, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false), meta(MPL_CORE_PROGRAM, false, false)];
  w.chain.send(maker, [{ programId: MPL_CORE_PROGRAM, keys, data }]);
  return asset;
}

/**
 * The spec with every NFT its stashes list made for real in the test's chain, held by the owner: each collection it
 * names made once, each NFT in it minted to the owner, and the spec's addresses swapped for theirs.
 */
function withStashedNfts(w, spec) {
  spec = withRaffledNfts(w, spec);
  if (!spec.stashes?.length) return spec;
  const made = new Map();
  const collectionOf = (address) => {
    if (!made.has(address)) {
      const collection = newAddress(w.random);
      w.chain.send(w.creator, [createCollectionInstruction({ collection, creator: w.creator, project: loot.pda.project(w.creator, 0), name: 'Partner', uri: 'https://example.invalid/partner-collection.json' })]);
      made.set(address, collection);
    }
    return made.get(address);
  };
  const swapped = new Map();
  const stashes = spec.stashes.map((s) => {
    const nfts = (s.nfts ?? []).map((n) => {
      const collection = collectionOf(typeof n === 'string' ? s.collection : n.collection ?? s.collection);
      const asset = coreAsset(w, collection, w.creator, w.creator);
      swapped.set(typeof n === 'string' ? n : n.asset, asset);
      return typeof n === 'string' ? asset : { ...n, asset, collection };
    });
    return { ...s, ...(s.collection ? { collection: collectionOf(s.collection) } : {}), nfts };
  });
  // A prize that names one of them names the new address.
  const renamed = JSON.parse(JSON.stringify({ ...spec, stashes }), (key, value) => (key === 'nft' && swapped.has(value) ? swapped.get(value) : value));
  return renamed;
}

/** A raffle's NFT (`raffle`, or a place's held prize) made for real, held by the owner, in a collection of its own. */
function withRaffledNfts(w, spec) {
  if (!(spec.lotteries ?? []).some((l) => l.raffle)) return spec;
  const lotteries = spec.lotteries.map((l) => {
    if (!l.raffle) return l;
    const collection = newAddress(w.random);
    w.chain.send(w.creator, [createCollectionInstruction({ collection, creator: w.creator, project: loot.pda.project(w.creator, 0), name: 'Artist', uri: 'https://example.invalid/artist.json' })]);
    return { ...l, raffle: { nft: coreAsset(w, collection, w.creator, w.creator), collection } };
  });
  return { ...spec, lotteries };
}

/** Each pool's mint, read from its token account (a token account's first 32 bytes). */
function poolMintsOf(w, project, m) {
  return Object.fromEntries(m.pools.map((pl) => [pl.index, encodeBase58(w.chain.get(loot.pda.pool(project, pl.index)).data.slice(0, 32))]));
}

describe('every example goes live on the program', () => {
  for (const [name, given] of examples) {
    // An economy that gives compressed NFTs goes live with Bubblegum loaded.
    const compressed = Boolean(compressedTree(model(given)));
    test(name, { skip: (compressed ? cannotRunCompressed() : skip) ?? false }, () => {
      const w = world({ project: false, seed: name, compressed });
      const spec = withStashedNfts(w, given);
      const m = model(spec, { now: NOW });
      const owner = w.creator;
      // Existing tokens: a mint at their address, and enough of them for the owner's seeds.
      for (const t of m.tokens.values()) {
        if (t.source !== 'existing') continue;
        const program = t.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
        putMint(w, t.mint, t.decimals, program);
        const to = loot.ata(owner, t.mint, program);
        w.chain.send(owner, [createAssociatedTokenAccountIdempotent(owner, owner, t.mint, program), mintToIx({ mint: t.mint, to, authority: w.creator, amount: 10n ** 18n, tokenProgram: program })]);
      }
      w.chain.warp(NOW);
      const first = plan(spec, { now: NOW });
      const keys = freshAddresses(first.freshKeys, w.random);
      const p = prepare(spec, { owner, keys, now: NOW, rent: (bytes) => w.chain.rent(bytes) });
      assert.ok(p.ok);
      const signatures = [];
      for (const t of p.transactions) {
        const payer = t.signer === 'authority' ? p.ctx.authority : owner;
        signatures.push(w.chain.send(payer, t.instructions, { label: t.steps.map((s) => s.id).join(', ') }).id);
      }
      const project = w.read('Project', p.ctx.project);
      assert.equal(project.owner, owner);
      assert.equal(w.chain.get(p.ctx.project).data.length, loot.projectBytes((m.collection ? 1 : 0) + m.collections.length));
      const records = [
        ...m.items.map((x) => ['Item', loot.pda.item(p.ctx.project, x.id), itemArgs(x)]),
        ...m.allBoxes.map((x) => ['LootBox', loot.pda.box(p.ctx.project, x.id), boxArgs(x, m)]),
        ...m.recipes.map((x) => ['Recipe', loot.pda.recipe(p.ctx.project, x.id), recipeArgs(x, m)]),
        ...m.schedules.map((x) => ['Schedule', loot.pda.schedule(p.ctx.project, x.id), scheduleArgs(x, m)]),
        ...m.lotteries.map((x) => ['Lottery', loot.pda.lottery(p.ctx.project, x.id), lotteryArgs(x, m)]),
        ...m.grants.map((x) => ['Grant', loot.pda.grant(p.ctx.project, x.id), grantArgs(x, m)]),
      ];
      for (const [kind, address, args] of records) assert.equal(w.chain.get(address).data.length, recordBytesOf(kind, { args }), `${kind} setup rent matches the SBF account`);
      const auctionAt = (game, a) => loot.pda.auction(game, auctionSeller(a, p.ctx), a.id);
      for (const [kind, parts, derive] of [['farm', m.farms, (game, part) => loot.pda.farm(game, part.id)], ['auction', m.auctions, auctionAt]]) {
        for (const part of parts) {
          const step = p.transactions.flatMap((t) => t.steps).find((step) => step.id === `${kind}:${part.key}`);
          assert.equal(w.chain.get(derive(p.ctx.project, part)).data.length, step.creates[0].bytes, `${kind} setup rent matches the SBF account`);
        }
      }

      for (const b of m.allBoxes) assert.ok(w.chain.get(loot.pda.box(p.ctx.project, b.id)), `box ${b.key}`);
      for (const pl of m.pools) assert.ok(w.chain.get(loot.pda.pool(p.ctx.project, pl.index)), `pool ${pl.key}`);
      for (const f of m.farms) assert.ok(w.chain.get(loot.pda.farm(p.ctx.project, f.id)), `farm ${f.key}`);
      for (const a of m.auctions) assert.ok(w.chain.get(auctionAt(p.ctx.project, a)), `auction ${a.key}`);
      for (const pl of m.pools.filter((x) => Number(x.seed ?? 0) > 0)) assert.ok(w.chain.tokens(loot.pda.pool(p.ctx.project, pl.index)) > 0n, `seed of ${pl.key}`);
      // Every stash holds what it lists, each NFT now the game's.
      for (const s of m.stashes) {
        // An empty stash is made by the first NFT put in (a trade-in, a ticket): nothing at go-live.
        if (!s.nfts.length) {
          assert.equal(w.chain.get(loot.pda.stash(p.ctx.project, s.id)), null, `stash ${s.key} waits for its first NFT`);
          continue;
        }
        const held = loot.decodeStash(w.chain.get(loot.pda.stash(p.ctx.project, s.id))?.data)?.nfts ?? [];
        const listed = s.nfts.map((n) => (typeof n === 'string' ? n : n.asset));
        assert.deepEqual([...held].sort(), [...listed].sort(), `stash ${s.key}`);
        for (const nft of held) assert.equal(parseCoreAsset(w.chain.get(nft).data).owner, p.ctx.project);
        const step = p.transactions.flatMap((t) => t.steps).find((x) => x.part === `stash:${s.key}` && x.creates.length);
        assert.equal(w.chain.get(loot.pda.stash(p.ctx.project, s.id)).data.length, step.creates[0].bytes, 'stash setup rent matches the SBF account');
      }
      const landed = recordLanded(spec, { ctx: p.ctx, signatures, now: NOW });
      assert.equal(landed.live.project, p.ctx.project);
      assert.ok(check(landed, { now: NOW }).ok, 'the spec with its live section still checks');
      // A player can bid on its first auction (in wrapped SOL here): the reserve, from an account of their own.
      const a = m.auctions[0];
      if (a) {
        const auction = w.read('Auction', auctionAt(p.ctx.project, a));
        assert.equal(auction.mint, NATIVE_MINT, 'the example auctions in SOL');
        const bidder = w.who();
        const amount = loot.leastBid(auction);
        const wrap = loot.ata(bidder, NATIVE_MINT);
        const r = w.chain.send(bidder, [createAssociatedTokenAccountIdempotent(bidder, bidder, NATIVE_MINT), { programId: '11111111111111111111111111111111', keys: [{ pubkey: bidder, isSigner: true, isWritable: true }, { pubkey: wrap, isSigner: false, isWritable: true }], data: concat(uintLE(2, 4), uintLE(amount, 8)) }, { programId: TOKEN_PROGRAM, keys: [{ pubkey: wrap, isSigner: false, isWritable: true }], data: Uint8Array.of(17) }, loot.bidIx({ bidder, project: p.ctx.project, id: a.id, auction, amount })]);
        assert.ok(r.receipts.some((x) => x.name === 'BidPlaced'), 'the bid landed');
      }
      // A player can buy from it: the first box opens with the client (one gated by a stake waits for one: play-ranked-grants;
      // one whose share pays a collectible's holder waits for the buyer to name one).
      const b = m.allBoxes.find((x) => !x.gate?.staked && !(x.split ?? []).some((s) => s.to?.startsWith('chosen:')));
      if (b) {
        const box = w.read('LootBox', loot.pda.box(p.ctx.project, b.id));
        const mint = box.currency;
        const player = w.who();
        const program = w.chain.get(mint)?.owner ?? TOKEN_PROGRAM;
        if (mint === NATIVE_MINT) {
          const wrap = loot.ata(player, NATIVE_MINT);
          w.chain.send(player, [createAssociatedTokenAccountIdempotent(player, player, NATIVE_MINT), { programId: '11111111111111111111111111111111', keys: [{ pubkey: player, isSigner: true, isWritable: true }, { pubkey: wrap, isSigner: false, isWritable: true }], data: concat(uintLE(2, 4), uintLE(box.price + 1n, 8)) }, { programId: TOKEN_PROGRAM, keys: [{ pubkey: wrap, isSigner: false, isWritable: true }], data: Uint8Array.of(17) }]);
        } else if (m.tokens.get(b.currency ?? m.currencyKey)?.source === 'existing') {
          w.chain.send(player, [createAssociatedTokenAccountIdempotent(player, player, mint, program), mintToIx({ mint, to: loot.ata(player, mint, program), authority: w.creator, amount: box.price + 1n, tokenProgram: program })]);
        } else if (box.price > 0n) return; // a game token: players earn it first
        // A box that needs no roll is bought in one step; any other opens an order that rolls.
        if (boxBuys(b)) {
          const items = Object.fromEntries(m.items.map((x) => [x.id, w.chain.get(loot.pda.item(p.ctx.project, x.id)) ? w.read('Item', loot.pda.item(p.ctx.project, x.id)) : null]));
          const r = w.chain.send(player, [loot.buyIx({ player, project: p.ctx.project, box, boxAddress: loot.pda.box(p.ctx.project, b.id), treasury: p.ctx.treasury, items, poolMints: poolMintsOf(w, p.ctx.project, m), programs: { [mint]: program } })]);
          assert.ok(r.receipts.some((x) => x.name === 'Bought'), 'bought');
        } else {
          const r = w.chain.send(player, [loot.openBoxIx({ player, project: p.ctx.project, box, nonce: 1n, programs: { [mint]: program } })]);
          assert.ok(r.receipts.some((x) => x.name === 'OrderRolled') || r.answers.some((a) => a.receipts.some((x) => x.name === 'OrderRolled')), 'the order rolled');
        }
      }
    });
  }
});

describe('a no-loss lottery and a stake gate in a spec', () => {
  const given = JSON.parse(readFileSync(new URL('stakers-draw.json', dir), 'utf8'));

  test('the plan writes them, and the checker refuses what the program would', () => {
    const m = model(given, { now: NOW });
    const lottery = lotteryArgs(m.lottery.get('draw'), m);
    assert.equal(lottery.returns, true);
    assert.deepEqual(lottery.gate, { Staked: { farm: `@farm:${m.farm.get('vault').id}`, at_least: 100_000_000n } }, 'the least stake in the token’s base units');
    assert.equal(lotteryArgs({ ...m.lottery.get('draw'), noLoss: undefined }, m).returns, false);
    const refused = (edit) => {
      const spec = structuredClone(given);
      edit(spec);
      return check(spec, { now: NOW }).refusals.map((x) => `${x.code} ${x.where}`);
    };
    const draw = 'economy.lotteries.draw';
    assert.ok(refused((s) => (s.lotteries[0].split = [{ to: 'treasury', percent: 10 }])).includes(`E-LOTTERY ${draw}.split`), 'a split of tickets that come back');
    assert.ok(refused((s) => (s.lotteries[0].cutPercent = 5)).includes(`E-LOTTERY ${draw}.split`), 'a cut too');
    assert.ok(refused((s) => (s.lotteries[0].ticketCurrency = 'gem')).includes(`E-LOTTERY ${draw}.ticketCurrency`), 'burned tickets');
    assert.ok(refused((s) => (s.lotteries[0].gate.staked.farm = 'nowhere')).includes(`E-REF ${draw}.gate.staked.farm`));
    assert.ok(refused((s) => (s.lotteries[0].gate.staked.atLeast = 0)).includes(`E-RULE ${draw}.gate.staked.atLeast`));
    // A farm with no lock never passes a stake gate: nobody gets in, which the checker says and the program allows.
    const unlocked = structuredClone(given);
    unlocked.farms[0].tiers = [{ lock: 0, multiplier: 1 }];
    assert.ok(check(unlocked, { now: NOW }).warnings.some((x) => x.code === 'W-STAKED' && x.where === `${draw}.gate.staked.farm`), 'a farm with no lock never passes');
    assert.ok(refused((s) => (s.lotteries[0].gate = { staked: { farm: 'vault' } })).includes('E-SCHEMA economy.lotteries[0].gate'), 'a stake gate names its least stake');
    // One tier with no lock is a warning: only stakes in the locked tiers pass.
    const mixed = structuredClone(given);
    mixed.farms[0].tiers.push({ lock: 0, multiplier: 1 });
    const r = check(mixed, { now: NOW });
    assert.ok(r.ok, r.refusals.map((x) => `${x.code} ${x.message}`).join('\n'));
    assert.ok(r.warnings.some((x) => x.code === 'W-STAKED' && /tier 3 has no lock/.test(x.message)));
    // A no-loss lottery whose pot nothing fills is flagged.
    const empty = structuredClone(given);
    delete empty.lotteries[0].seed;
    empty.items[0].split = [];
    assert.ok(check(empty, { now: NOW }).warnings.some((x) => x.code === 'W-LOTTERY' && /winners would win nothing/.test(x.message)));
  });
});

describe('a bundle bought at once, a list gate, NFTs as the price, in a spec', () => {
  const given = JSON.parse(readFileSync(new URL('trade-in-shop.json', dir), 'utf8'));

  test('the checker and the plan read each of them', () => {
    const m = model(given, { now: NOW });
    const [pack, badge, gear] = ['starter-pack', 'founder-badge', 'mystery-gear'].map((key) => m.box.get(key));
    assert.deepEqual([boxBuys(pack), boxBuys(badge), boxBuys(gear)], [true, true, false], 'only the box that rolls opens an order');
    const args = boxArgs(pack, m);
    assert.equal(args.entries.length, 1);
    assert.equal(args.entries[0].prizes.length, 3, 'a bundle of three');
    assert.ok(args.entries[0].prizes.every((x) => x.Item || x.Tokens));
    assert.ok(boxArgs(badge, m).gate.List, 'a list gate keeps its root');
    assert.equal(boxArgs(badge, m).gate.List.depth, 3, 'five wallets fill a tree of eight');
    const trade = recipeArgs(m.recipe.get('trade-in'), m).inputs[0].Trade;
    assert.deepEqual(trade.then, { Stash: [m.stash.get('returns').id] });
    const lottery = lotteryArgs(m.lottery.get('shield-raffle'), m);
    assert.equal(lottery.price, 0n);
    assert.equal(lottery.nft_ticket.then, 'Burn');
    // What the program refuses, the checker refuses first.
    const refused = (edit) => {
      const spec = structuredClone(given);
      edit(spec);
      return check(spec, { now: NOW }).refusals.map((x) => `${x.code} ${x.where}`);
    };
    assert.ok(refused((s) => s.boxes[0].outcomes[0].prizes.push({ gives: 'item', item: 'badge' })).includes('E-SCHEMA economy.boxes[0].outcomes[0].prizes'), 'four prizes in one bundle');
    assert.ok(refused((s) => (s.lotteries[0].price = 1)).includes('E-LOTTERY economy.lotteries.shield-raffle.price'), 'an NFT and a price');
    assert.ok(refused((s) => (s.recipes[0].in[0].then = { stash: 'nowhere' })).some((x) => x.startsWith('E-REF')));
    assert.ok(refused((s) => (s.boxes[1].gate.list[0] = 'not-an-address')).includes('E-SCHEMA economy.boxes[1].gate'));
    // A contest staking NFTs and an auction bid in NFTs plan their rule.
    const more = structuredClone(given);
    more.contests = [{ key: 'duel', name: 'Duel', sides: 2, entriesClose: '1d', resultDue: '2d', stakeNft: { item: 'sword' } }];
    more.auctions = [{ key: 'relic', name: 'Relic', lot: { item: 'badge' }, runs: '1d', bidNfts: { item: 'shield' }, reserve: 2 }];
    const r = check(more, { now: NOW });
    assert.ok(r.ok, r.refusals.map((x) => `${x.code} ${x.message}`).join('\n'));
    assert.ok(r.warnings.some((x) => x.code === 'W-NFT-PRICE' && x.where.includes('contests')));
    assert.ok(plan(more, { now: NOW }).ok);
  });

  test('it goes live, and a player buys the pack, the badge, trades a sword in and pays a ticket with a shield', { skip: skip ?? false }, () => {
    const w = world({ project: false, seed: 'trade-in-shop' });
    const player = w.who();
    const stranger = w.who();
    // The list: the test's player, then the spec's own wallets.
    const spec = structuredClone(given);
    spec.boxes[1].gate.list = [player, ...spec.boxes[1].gate.list];
    const m = model(spec, { now: NOW });
    w.chain.warp(NOW);
    const keys = freshAddresses(plan(spec, { now: NOW }).freshKeys, w.random);
    const p = prepare(spec, { owner: w.creator, keys, now: NOW, rent: (bytes) => w.chain.rent(bytes) });
    assert.ok(p.ok);
    for (const t of p.transactions) w.chain.send(t.signer === 'authority' ? p.ctx.authority : w.creator, t.instructions);
    const { project, treasury, collection } = p.ctx;
    const poolMints = poolMintsOf(w, project, m);
    const items = Object.fromEntries(m.items.map((x) => [x.id, w.read('Item', loot.pda.item(project, x.id))]));
    // The player wraps 1 SOL.
    const wrap = (who) => w.chain.send(who, [createAssociatedTokenAccountIdempotent(who, who, NATIVE_MINT), { programId: SYSTEM_PROGRAM, keys: [meta(who, true, true), meta(loot.ata(who, NATIVE_MINT), false, true)], data: concat(uintLE(2, 4), uintLE(1_000_000_000n, 8)) }, { programId: TOKEN_PROGRAM, keys: [meta(loot.ata(who, NATIVE_MINT), false, true)], data: Uint8Array.of(17) }]);
    wrap(player);
    wrap(stranger);
    const wsol = () => w.chain.tokens(loot.ata(player, NATIVE_MINT));
    const boxOf = (key) => {
      const b = m.box.get(key);
      return { box: w.read('LootBox', loot.pda.box(project, b.id)), boxAddress: loot.pda.box(project, b.id) };
    };
    const given_ = (r) => r.receipts.filter((x) => x.name === 'PrizeGiven').map((x) => x.data);

    // The pack: one transaction, the price split and the bundle handed over at once.
    const before = wsol();
    const bought = w.chain.send(player, [computeUnitLimit(600_000), loot.buyIx({ player, project, ...boxOf('starter-pack'), treasury, items, poolMints })]);
    assert.ok(bought.receipts.some((x) => x.name === 'Bought'));
    const [sword, shield] = given_(bought).filter((x) => x.prize.Item).map((x) => x.asset);
    assert.deepEqual([parseCoreAsset(w.chain.get(sword).data).owner, parseCoreAsset(w.chain.get(shield).data).owner], [player, player]);
    assert.equal(before - wsol(), 50_000_000n - 10_000_000n, 'the price, less the 0.01 SOL the bundle pays back');
    assert.equal(w.chain.get(loot.pda.order(project, player, 0n)), null, 'no order');

    // The badge: only a wallet on the list, with its proof.
    const list = loot.gateList(spec.boxes[1].gate.list);
    const badge = (who, listProof) => loot.buyIx({ player: who, project, ...boxOf('founder-badge'), treasury, items, poolMints, listProof });
    assert.throws(() => w.chain.send(stranger, [badge(stranger, list.proofOf(player))]), /GateNotMet/);
    w.chain.send(player, [computeUnitLimit(400_000), badge(player, list.proofOf(player))]);
    assert.equal(w.read('Item', loot.pda.item(project, m.item.get('badge').id)).issued, 1);

    // A trade-in: the sword into the stash “returns” (made by this first NFT), 0.002 SOL out.
    const recipe = w.read('Recipe', loot.pda.recipe(project, m.recipe.get('trade-in').id));
    const sol = wsol();
    w.chain.send(player, [computeUnitLimit(600_000), loot.craftIx({ player, project, collection, id: m.recipe.get('trade-in').id, recipe, assets: [{ asset: sword, collection }], items, poolMints, treasury })]);
    assert.deepEqual(loot.decodeStash(w.chain.get(loot.pda.stash(project, m.stash.get('returns').id)).data).nfts, [sword]);
    assert.equal(parseCoreAsset(w.chain.get(sword).data).owner, project);
    assert.equal(wsol() - sol, 2_000_000n);

    // A raffle ticket paid with the shield, burned.
    const id = m.lottery.get('shield-raffle').id;
    const lottery = w.read('Lottery', loot.pda.lottery(project, id));
    const ticket = w.chain.send(player, [computeUnitLimit(400_000), loot.buyTicketsIx({ player, project, id, lottery, count: 1n, nonce: 1n, nft: { asset: shield, collection } })]);
    assert.equal(ticket.receipts.find((x) => x.name === 'TicketsBought').data.asset, shield);
    assert.equal(parseCoreAsset(w.chain.get(shield).data).owner, project, 'held until the draw');
  });
});

describe('auctions in a spec', () => {
  const base = JSON.parse(readFileSync(new URL('artwork-auction.json', dir), 'utf8'));
  const codes = (spec) => {
    const r = check(spec, { now: NOW });
    return [...r.refusals.map((x) => x.code), ...r.warnings.map((x) => x.code)];
  };
  const withAuction = (change, more = {}) => ({ ...base, ...more, auctions: [{ ...base.auctions[0], ...change }] });

  test('what the program refuses, the checker refuses first', () => {
    assert.ok(codes(base).includes('W-AUCTION-SHILL'), 'shill bidding is always said');
    assert.ok(codes(withAuction({ runs: '0s' })).includes('E-AUCTION'), 'an end that is not after the start');
    assert.ok(codes(withAuction({ start: '2020-01-01T00:00:00Z' })).includes('E-AUCTION'), 'over before it goes live');
    assert.ok(codes(withAuction({ lot: { asset: '6U3XnmrzuZ5sDujScii8SmzwtRZ4skfKcH2TLiz1rmES' } })).includes('E-AUCTION'), 'a collectible of a collection that does not exist yet');
    assert.ok(!codes(withAuction({ lot: { asset: '6U3XnmrzuZ5sDujScii8SmzwtRZ4skfKcH2TLiz1rmES', collection: '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ' } })).includes('E-AUCTION'), 'an NFT of another collection, which exists already');
    const two = { ...base, auctions: [base.auctions[0], { ...base.auctions[0], key: 'again' }] };
    assert.ok(codes(two).includes('E-AUCTION'), 'two auctions of the one unit there is');
    const points = { ...base, tokens: [...base.tokens, { key: 'pts', source: 'game' }] };
    assert.ok(!codes({ ...points, auctions: [{ ...base.auctions[0], currency: 'pts', reserve: 1 }] }).some((c) => c.startsWith('E-')), 'another currency is fine: what the split leaves goes to the treasury wallet');
    assert.ok(codes(withAuction({ split: [{ to: 'burn', percent: 10 }] })).includes('E-WSOL-BURN'), 'wrapped SOL is never burned');
    assert.ok(codes(withAuction({ reserve: 0 })).includes('W-AUCTION'), 'no reserve');
  });

  test('the plan opens it with the item, and the guide no longer says auctions cannot be done', async () => {
    const p = plan(base, { now: NOW });
    const step = p.steps.find((x) => x.id === 'auction:sunset');
    assert.ok(step && step.signers.includes('owner'));
    const { guideText } = await import('../economy/guide.mjs');
    const text = guideText();
    assert.match(text, /auctions \(list of auction/);
    assert.match(text, /sealed-bid auction/);
    assert.doesNotMatch(text, /auctions \(escrowed bids with refunds\)/);
  });
});

test('historical economy formats are rejected without conversion', () => {
  assert.equal(check({ version: 1 }).ok, false);
});

test('a box whose purchase cannot fit a legacy transaction is warned of as v0 (W-TX-V0), not refused', () => {
  const tokens = ['a', 'b', 'c'];
  const spec = (pools, perWallet) => ({
    version: 2,
    network: 'devnet',
    name: 'Big box',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }, ...tokens.map((key) => ({ key, source: 'game', name: key, symbol: key.toUpperCase(), decimals: 0 }))],
    collection: { name: 'Drops' },
    items: [1, 2, 3, 4, 5].map((i) => ({ key: `drop${i}`, name: `Drop ${i}` })),
    pools: tokens.slice(0, pools).map((key) => ({ key: `pool-${key}`, currency: key, seed: 10 })),
    boxes: [
      {
        key: 'big',
        name: 'Big box',
        price: 0.1,
        ...(perWallet ? { perWallet } : {}),
        outcomes: [
          ...[1, 2, 3, 4, 5].map((i) => ({ gives: 'item', item: `drop${i}`, weight: 1 })),
          ...tokens.slice(0, pools).map((key) => ({ gives: 'pay', pool: `pool-${key}`, amount: 1, weight: 1 })),
        ],
      },
    ],
  });
  // 5 items and 3 prizes in 3 mints, limited per wallet: the largest box upsert takes (its open_box measures 1,265
  // bytes with a wallet's compute limit and price).
  // Since js/play sends a transaction too big for a legacy one as v0 with a lookup table, it is warned of (W-TX-V0),
  // not refused: it is refused only past 64 accounts with the table's two.
  const big = check(spec(3, 5), { now: NOW });
  assert.ok(!big.refusals.some((r) => r.code === 'E-TX-SIZE'), big.refusals.map((r) => `${r.code} ${r.message}`).join('\n'));
  assert.equal(big.warnings.find((w) => w.code === 'W-TX-V0')?.where, 'economy.boxes.big');
  const fits = check(spec(1, 0), { now: NOW });
  assert.ok(!fits.refusals.some((r) => r.code === 'E-TX-SIZE'), fits.refusals.map((r) => `${r.code} ${r.message}`).join('\n'));
});

describe('stashes and prizes in a spec', () => {
  const base = JSON.parse(readFileSync(new URL('partner-vault.json', dir), 'utf8'));
  const codes = (spec) => {
    const r = check(spec, { now: NOW });
    return [...r.refusals.map((x) => `${x.code} ${x.where}`), ...r.warnings.map((x) => `${x.code} ${x.where}`)];
  };
  const edit = (f) => {
    const s = structuredClone(base);
    f(s);
    return codes(s);
  };
  const has = (list, prefix) => list.some((c) => c.startsWith(prefix));

  test('what the program refuses, the checker refuses first', () => {
    assert.ok(!has(codes(base), 'E-'), codes(base).join('\n'));
    assert.ok(has(edit((s) => (s.boxes[0].outcomes[0].stash = 'nowhere')), 'E-REF economy.boxes.partner-crate.outcomes[0].stash'));
    assert.ok(has(edit((s) => (s.grants[0].prize.box = 'nowhere')), 'E-GRANT economy.grants.daily.prize.box'));
    assert.ok(has(edit((s) => (delete s.grants[0].prize, (s.grants[0].gives = { roll: 'nowhere' }))), 'E-GRANT economy.grants.daily.gives.box'), 'the older form reads the same');
    assert.ok(has(edit((s) => (s.lotteries[0].places = [{ percent: 0 }, 90])), 'E-LOTTERY economy.lotteries.raffle.places[0]'), 'a place that wins nothing');
    assert.ok(has(edit((s) => (s.lotteries[0].places[0].prize.nft = s.stashes[0].nfts[0])), 'E-LOTTERY economy.lotteries.raffle.places[0].prize.nft'), 'a named NFT its stash does not list');
    assert.ok(has(edit((s) => (s.lotteries[0].places[0].prize.stash = 'nowhere')), 'E-REF economy.lotteries.raffle.places[0].prize.stash'));
    assert.ok(has(edit((s) => (s.farms[0].tiers[0].prize = { gives: 'tokens', amount: 5, from: 'mint', currency: 'sol' })), 'E-MINT-NOT-OURS economy.farms.expedition.tiers[0].prize.currency'));
    assert.ok(has(edit((s) => (s.farms[0].tiers[0] = { lock: '1d', roll: 'daily-chest' })), 'E-FARM economy.farms.expedition.tiers[0].roll'), 'a chest is a prize, not a roll on the NFT');
    assert.ok(has(edit((s) => (s.farms[0].tiers[0].lock = 0)), 'E-FARM economy.farms.expedition.tiers[0].prize'), 'a prize needs a lock');
    assert.ok(has(edit((s) => (s.auctions[0].lot = { roll: 'nowhere' })), 'E-AUCTION economy.auctions.mystery-lot.lot.roll'));
    assert.ok(has(edit((s) => (s.stashes[0].nfts.push({ compressed: '6U3XnmrzuZ5sDujScii8SmzwtRZ4skfKcH2TLiz1rmES' }))), 'E-STASH economy.stashes.vault.nfts[3]'), 'a compressed NFT goes in after go-live');
    assert.ok(has(edit((s) => delete s.stashes[0].collection), 'E-STASH economy.stashes.vault.nfts[0]'), 'the game’s own collection does not exist yet');
    assert.ok(has(edit((s) => s.stashes[1].nfts.push(s.stashes[0].nfts[0])), 'E-STASH economy.stashes.chest-nfts.nfts[2]'), 'one NFT in two stashes');
    // A box that rolls on an NFT can give a stash's NFT in the same outcome, and take the one it rolls on away (an
    // order holds the NFT won apart from the one rolled on).
    const onPass = (outcomes, more = {}) => edit((s) => Object.assign(s.boxes[0], { rollsOn: { item: 'pass' }, outcomes, ...more }));
    assert.ok(!has(onPass([{ gives: 'stash', stash: 'vault', chance: 50, shifts: [{ attribute: 'level', by: 1 }] }, { gives: 'nothing', chance: 50 }]), 'E-'));
    assert.ok(!has(onPass([{ gives: 'stash', stash: 'vault', chance: 50 }, { gives: 'nothing', chance: 50, then: 'burn' }]), 'E-'));
    // A trade-in: every outcome puts the NFT in a stash, by the box's own "then".
    assert.ok(has(onPass([{ gives: 'stash', stash: 'vault', chance: 50 }, { gives: 'nothing', chance: 50 }], { then: { stash: 'vault' } }), 'W-NFT-PRICE economy.boxes.partner-crate.rollsOn'));
    assert.ok(has(onPass([{ gives: 'nothing', chance: 100 }], { then: { stash: 'nowhere' } }), 'E-REF economy.boxes.partner-crate.then.stash'));
  });

  test('what an owner should know is said', () => {
    const all = codes(base);
    for (const code of ['W-STASH-SHARED economy.stashes.vault', 'W-STASH-TRANSFER economy.stashes', 'W-AUCTION economy.auctions.mystery-lot.lot.roll', 'W-CHANCE-PRIZE']) assert.ok(has(all, code), code);
    assert.ok(has(edit((s) => (s.boxes[1].active = true)), 'W-ROLL-PRIZE economy.boxes.daily-chest.active'), 'a prize’s box for sale too');
    assert.ok(has(edit((s) => (s.stashes[2].nfts = [])), 'W-STASH economy.stashes.rare.nfts'), 'an empty stash');
    assert.ok(!has(all, 'E-ROLL'));
    // One named NFT is given once: a grant of many claims, a contest of many winners.
    const trophy = { gives: 'nft', stash: 'rare', nft: base.stashes[2].nfts[0].asset };
    assert.ok(has(edit((s) => (s.grants[0].prize = trophy)), 'W-PRIZE-ONCE economy.grants.daily.prize'));
    assert.ok(!has(edit((s) => (s.grants[0] = { ...s.grants[0], prize: trophy, limits: { total: 1, perWallet: 1 } })), 'W-PRIZE-ONCE'), 'a grant of one claim');
    const contest = { key: 'cup', name: 'Cup', sides: 2, resultDue: '1d', decidedBy: 'authority', prize: trophy };
    assert.ok(has(edit((s) => (s.contests = [contest])), 'W-CONTEST-PRIZE economy.contests.cup.prize'));
    // A named NFT a roll could also take.
    assert.ok(has(edit((s) => (s.lotteries[0].places[0].prize = { ...trophy, stash: 'vault', nft: s.stashes[0].nfts[0] })), 'W-STASH-SHARED economy.stashes.vault'));
  });

  test('the plan puts each NFT in its stash, and maps every roll to its box', () => {
    const p = plan(base, { now: NOW });
    const m = model(base, { now: NOW });
    const stashSteps = p.steps.filter((s) => s.part.startsWith('stash:'));
    assert.equal(stashSteps.length, 6);
    assert.deepEqual(stashSteps.filter((s) => s.creates.length).map((s) => s.creates[0].bytes), [41 + 3 * 32, 41 + 2 * 32, 41 + 32]);
    const box = (key) => m.box.get(key).id;
    assert.deepEqual(grantArgs(m.grants[0], m).gives, { Roll: [box('daily-chest')] });
    const rare = base.stashes[2].nfts[0].asset;
    assert.deepEqual(lotteryArgs(m.lotteries[0], m).places, [{ bps: 0, prize: { Nft: { stash: m.stash.get('rare').id, nft: rare } } }, { bps: 9000, prize: null }]);
    assert.deepEqual(farmArgs(m.farms[0], m).tiers[0].prize, { Roll: [box('daily-chest')] });
    assert.deepEqual(prizeArgs({ gives: 'tokens', amount: 2, from: 'mint', currency: 'shards' }, m), { Tokens: { from: { Mint: ['@mint:shards'] }, amount: { Fixed: [2_000_000n] } } });
    assert.deepEqual(prizeArgs({ gives: 'share', pool: 'shard-rewards', percent: 10 }, m), { Tokens: { from: { Pool: [m.pool.get('shard-rewards').index] }, amount: { Bps: [1000] } } });
    assert.deepEqual(prizeArgs({ item: 'trinket' }, m), { Item: [m.item.get('trinket').id] }, 'a grant’s older form');
    assert.deepEqual(boxArgs(m.boxes[0], m).entries[0].prizes, [{ Stash: [m.stash.get('vault').id] }]);
    // Live, a stash publishes only what it does not hold yet.
    const live = { ...base, live: { project: NOBODY_PROJECT, published: { stashes: base.stashes } } };
    const again = plan({ ...live, stashes: [{ ...base.stashes[0], nfts: [...base.stashes[0].nfts, '6U3XnmrzuZ5sDujScii8SmzwtRZ4skfKcH2TLiz1rmES'] }, ...base.stashes.slice(1)] }, { now: NOW, only: new Set(['stash:vault']), live: live.live });
    assert.deepEqual(again.steps.map((s) => s.id), ['stash:vault:6U3XnmrzuZ5sDujScii8SmzwtRZ4skfKcH2TLiz1rmES']);
    assert.ok(again.steps[0].creates[0].grows);
  });
});
const NOBODY_PROJECT = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
