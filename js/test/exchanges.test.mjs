// Both sides of an exchange move together (loot 0.26): an auction's end delivers the lot with the money, sends the lot
// first and the money after, or calls the sale off; a loan's repayment brings its NFT home in the same instruction; a
// roll won on another route reads its player's profile and an NFT they show at its first ask. Each built by js/client
// (or js/play) and run on the real program, for every kind of NFT the test world makes: Core, Token Metadata, compressed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM, parseCoreAsset } from '../chain/core.js';
import { sendPlan } from '../chain/lookup.js';
import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from '../chain/pda.js';
import { readMessage, readTransaction } from '../chain/tx.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, meta } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import { EXECUTE_DISCRIMINATOR, MEMO_PROGRAM, validationAddress } from '../chain/token2022.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { cnftTree, onChainRoot } from './cnft-chain.mjs';
import { nftOf as tmNft, setup as tmSetup } from './tm-chain.mjs';
import { boxArgs, cannotRun, cannotRunCompressed, collectible, itemDrop, pinned, world } from './world.mjs';

const skip = cannotRun() ?? false;
const skipCompressed = cannotRunCompressed() ?? false;
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const names = record => record.receipts.map(r => r.name);
const receipt = (record, name) => record.receipts.find(r => r.name === name)?.data;
const coreOwner = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;
const tokens = (w, wallet, mint, program) => w.chain.tokens(loot.ata(wallet, mint, program));
const fails = (fn, why) =>
  assert.throws(fn, e => String(e.message).includes(why) || (e.logs ?? []).join('\n').includes(why), why);

/** A wallet that signs a transaction as the play module asks: the local chain signs for anyone. */
const asWallet = address => ({ address, signTransaction: async wire => wire });

/** `seller` auctions their NFT `lot` (as `kind` says: { collection } | { tokenMetadata } | { compressed }) as auction
 * `id`, for the project's coin; `w.player` bids `bid`. Returns the auction's address. */
function sale(w, seller, lot, kind, { id = 1, bid = 500n, shares = [], nftBids = null, reserve = 100n } = {}) {
  const now = w.chain.now();
  const proof = kind.compressed ? [loot.proveLeafIx({ signer: seller, compressed: kind.compressed })] : [];
  w.chain.send(seller, [
    computeUnitLimit(1_400_000),
    ...loot.withLeafCloses([
      ...proof,
      loot.openAuctionIx({
        seller,
        project: w.project,
        id,
        mint: w.mint,
        ...kind,
        args: {
          lot: { Asset: [lot] },
          reserve,
          min_raise_bps: 0,
          starts_at: BigInt(now),
          ends_at: BigInt(now + 600),
          extend: 0,
          shares,
          gate: null,
          nft_bids: nftBids,
        },
      }),
    ]),
  ]);
  const at = pda.auction(w.project, seller, id);
  if (bid && !nftBids)
    w.chain.send(w.player, [
      loot.bidIx({ bidder: w.player, project: w.project, id, auction: w.read('Auction', at), amount: bid }),
    ]);
  return at;
}

/** `signer` ends auction `id` of `seller` as `ending` says, with the lot's accounts as `kind` says. */
function end(w, signer, seller, kind, { id = 1, ending = 'Deliver', ...more } = {}) {
  const auction = w.read('Auction', pda.auction(w.project, seller, id));
  const proof = kind.compressed ? [loot.proveLeafIx({ signer, compressed: kind.compressed })] : [];
  return w.chain.send(signer, [
    computeUnitLimit(1_400_000),
    ...loot.withLeafCloses([
      ...proof,
      loot.endAuctionIx({
        signer,
        project: w.project,
        projectState: w.projectState(),
        id,
        auction,
        ending,
        ...kind,
        ...more,
      }),
    ]),
  ]);
}

/** Whoever controls the NFT's collection took it back (or it was burned): its owner now `thief`, as the chain would
 * show it. A Core asset's owner is its bytes 1 to 33. */
function takeCore(w, asset, thief) {
  const a = w.chain.get(asset);
  const data = Uint8Array.from(a.data);
  data.set(addressBytes(thief), 1);
  w.chain.put(asset, { ...a, data });
}

/** The same for a Token Metadata NFT the project holds: its one token leaves the project's account, into an account of
 * `thief`'s (returned), or, burned, out of existence (its mint returned, holding none). */
function takeTokenMetadata(w, mint, thief, { burned = false } = {}) {
  const held = loot.ata(w.project, mint);
  const a = w.chain.get(held);
  const data = Uint8Array.from(a.data);
  data.fill(0, 64, 72);
  w.chain.put(held, { ...a, data });
  if (burned) {
    const m = w.chain.get(mint);
    const supply = Uint8Array.from(m.data);
    supply.fill(0, 36, 44);
    w.chain.put(mint, { ...m, data: supply });
    return mint;
  }
  const theirs = loot.ata(thief, mint);
  const moved = Uint8Array.from(a.data);
  moved.set(addressBytes(thief), 32);
  w.chain.put(theirs, { ...a, data: moved });
  return theirs;
}

// ---------------------------------------------------------------- an auction's end, each kind of lot

test(
  'a Core lot: delivered with the money; sent first and paid after; called off by the keys; called off by anyone once it is gone',
  { skip },
  () => {
    const w = world({ seed: 'ex-core' });
    w.upsert({ Item: { id: 1, args: collectible('Painting') } });
    const seller = w.who();
    const kind = { collection: w.collection };
    const lots = [1, 2, 3, 4, 5].map(() => w.make(1, seller));
    const at = lots.map((lot, i) => sale(w, seller, lot, kind, { id: i + 1 }));
    w.chain.warp(w.chain.now() + 601);
    const had = w.balance(w.player);

    // Delivered: the lot and the money in one instruction.
    let r = end(w, w.cranker, seller, kind, { id: 1 });
    assert.deepEqual(names(r), ['AuctionEnded']);
    assert.equal(coreOwner(w, lots[0]), w.player);
    assert.equal(w.balance(seller), 500n);

    // The lot first: the winner has it, the whole bid owed; the next end pays it and closes the auction.
    r = end(w, w.cranker, seller, kind, { id: 2, ending: 'LotFirst' });
    assert.equal(receipt(r, 'AuctionEnded').remainder, 0n);
    assert.equal(coreOwner(w, lots[1]), w.player);
    assert.equal(w.read('Auction', at[1]).proceeds_owed, 500n);
    fails(() => end(w, w.authority, seller, kind, { id: 2, ending: 'CallOff' }), 'CantCallOff');
    r = end(w, w.cranker, seller, kind, { id: 2 });
    assert.equal(receipt(r, 'AuctionEnded').asset, NOBODY, 'the end that pays names no lot');
    assert.equal(w.chain.get(at[1]), null);
    assert.equal(w.balance(seller), 1_000n);

    // Nothing gone: a stranger can't call it off; the project's authority can, for the project fee.
    const stranger = w.who();
    fails(() => end(w, stranger, seller, kind, { id: 3, ending: 'CallOff' }), 'NotAuthority');
    r = end(w, w.authority, seller, kind, { id: 3, ending: 'CallOff' });
    assert.deepEqual(names(r), ['SaleCalledOff']);
    const off = receipt(r, 'SaleCalledOff');
    assert.deepEqual([off.back, off.home, off.gone, off.by], [500n, true, false, w.authority]);
    assert.equal(coreOwner(w, lots[2]), seller, 'the lot home');

    // Gone: its collection took it back. Anyone calls the sale off on that evidence; the lot stays where it is.
    const thief = w.who();
    takeCore(w, lots[3], thief);
    assert.throws(() => end(w, w.cranker, seller, kind, { id: 4 }), 'the lot can’t move to the winner');
    r = end(w, stranger, seller, kind, { id: 4, ending: 'CallOff' });
    const gone = receipt(r, 'SaleCalledOff');
    assert.deepEqual([gone.back, gone.home, gone.gone, gone.by], [500n, false, true, stranger]);
    assert.equal(coreOwner(w, lots[3]), thief);
    assert.equal(w.chain.get(at[3]), null);

    // The project's keys call a sale off with the lot made a hold for its seller, which anyone then sends home.
    end(w, w.authority, seller, kind, { id: 5, ending: 'CallOff', hold: true });
    const hold = w.read('Hold', pda.hold(lots[4], 0));
    assert.equal(hold.player, seller);
    w.chain.send(w.cranker, [
      loot.releaseIx({ signer: w.cranker, project: w.project, asset: lots[4], collection: w.collection, hold }),
    ]);
    assert.equal(coreOwner(w, lots[4]), seller);
    // Every bid but the two sold came back: 3 of 5.
    assert.equal(w.balance(w.player), had + 3n * 500n);
  },
);

test(
  'a Token Metadata lot: delivered, sent first, called off by the keys, and called off by anyone once it is taken or burned',
  { skip },
  () => {
    const { w, maker, club } = tmSetup('ex-tm');
    const seller = w.who();
    const tm = { tokenMetadata: { programmable: false, ruleSet: null } };
    const lots = [1, 2, 3, 4, 5].map(() => tmNft(w, maker, seller, club));
    const at = lots.map((lot, i) => sale(w, seller, lot, tm, { id: i + 1 }));
    w.chain.warp(w.chain.now() + 601);

    end(w, w.cranker, seller, tm, { id: 1 });
    assert.equal(tokens(w, w.player, lots[0]), 1n, 'the winner has it');

    end(w, w.cranker, seller, tm, { id: 2, ending: 'LotFirst' });
    assert.equal(tokens(w, w.player, lots[1]), 1n);
    end(w, w.cranker, seller, tm, { id: 2 });
    assert.equal(w.chain.get(at[1]), null);
    assert.equal(w.balance(seller), 1_000n);

    const off = receipt(end(w, w.authority, seller, tm, { id: 3, ending: 'CallOff' }), 'SaleCalledOff');
    assert.deepEqual([off.home, off.gone], [true, false]);
    assert.equal(tokens(w, seller, lots[2]), 1n, 'home');

    // Taken: the account that holds it now is the evidence; burned: its mint holding none.
    const stranger = w.who();
    // Taken: with only the accounts it was handed in with, nothing shows where it is (NotProven); the account that
    // holds it now is the evidence.
    const taken = takeTokenMetadata(w, lots[3], w.who());
    fails(() => end(w, stranger, seller, tm, { id: 4, ending: 'CallOff' }), 'NotProven');
    let gone = receipt(end(w, stranger, seller, tm, { id: 4, ending: 'CallOff', evidence: taken }), 'SaleCalledOff');
    assert.deepEqual([gone.back, gone.home, gone.gone], [500n, false, true]);
    // Burned: its mint holding none is the evidence, which the lot's own accounts already name.
    const burned = takeTokenMetadata(w, lots[4], w.who(), { burned: true });
    gone = receipt(end(w, stranger, seller, tm, { id: 5, ending: 'CallOff', evidence: burned }), 'SaleCalledOff');
    assert.deepEqual([gone.back, gone.home, gone.gone], [500n, false, true]);
    assert.deepEqual([w.chain.get(at[3]), w.chain.get(at[4])], [null, null]);
    assert.equal(w.balance(w.player), 100n * 1_000_000n - 2n * 500n);
  },
);

test(
  'a compressed lot: its record read at every end, delivered with its proof, sent first, called off by the keys, and gone home unsold',
  { skip: skipCompressed },
  () => {
    const w = world({ seed: 'ex-compressed', compressed: true });
    const tree = cnftTree(w);
    const seller = w.who();
    const lots = [1, 2, 3, 4].map(() => tree.mint(seller));
    const kind = id => ({ compressed: tree.compressed(id) });
    lots.forEach((lot, i) => {
      sale(w, seller, lot, kind(lot), { id: i + 1, bid: i === 3 ? 0n : 500n });
      tree.moved(lot, w.project);
    });
    assert.deepEqual(onChainRoot(w, tree), tree.root(), 'every lot is the project’s');
    w.chain.warp(w.chain.now() + 601);

    end(w, w.cranker, seller, kind(lots[0]), { id: 1 });
    tree.moved(lots[0], w.player);
    assert.deepEqual(onChainRoot(w, tree), tree.root(), 'the winner’s');

    end(w, w.cranker, seller, kind(lots[1]), { id: 2, ending: 'LotFirst' });
    tree.moved(lots[1], w.player);
    // The end that pays reads no lot: the auction's address stands in, with no proof.
    end(w, w.cranker, seller, {}, { id: 2 });
    assert.equal(w.balance(seller), 1_000n);

    end(w, w.authority, seller, kind(lots[2]), { id: 3, ending: 'CallOff' });
    tree.moved(lots[2], seller);

    // With no bid, the lot goes home: its record must be current (no proof in the transaction: NotProven).
    const auction = w.read('Auction', pda.auction(w.project, seller, 4));
    const bare = loot.endAuctionIx({
      signer: w.cranker,
      project: w.project,
      projectState: w.projectState(),
      id: 4,
      auction,
      compressed: tree.compressed(lots[3]),
    });
    fails(() => w.chain.send(w.cranker, [computeUnitLimit(1_400_000), bare]), 'NotProven');
    end(w, w.cranker, seller, kind(lots[3]), { id: 4 });
    tree.moved(lots[3], seller);
    assert.deepEqual(onChainRoot(w, tree), tree.root(), 'two home, one with its winner, one paid for');
  },
);

test(
  'NFT bids: the keys call a sale off and the bid goes back, one NFT made a hold; after the lot went first, the bid goes to the seller',
  { skip },
  () => {
    const w = world({ seed: 'ex-nft-bids' });
    w.upsert({ Item: { id: 1, args: collectible('Painting') } });
    w.upsert({ Item: { id: 2, args: collectible('Gem') } });
    const seller = w.who();
    const kind = { collection: w.collection };
    const rule = { of: { Item: [2] }, key: '', test: 'Any' };
    const [a, b] = [w.make(1, seller), w.make(1, seller)];
    const gems = [0, 1, 2, 3].map(() => w.make(2, w.player));
    const bidWith = (id, nfts) => {
      const auction = w.read('Auction', pda.auction(w.project, seller, id));
      w.chain.send(w.player, [
        computeUnitLimit(1_400_000),
        loot.bidIx({
          bidder: w.player,
          project: w.project,
          id,
          auction,
          nfts: nfts.map(asset => ({ asset, collection: w.collection })),
        }),
      ]);
    };
    sale(w, seller, a, kind, { id: 1, nftBids: rule, reserve: 1n });
    sale(w, seller, b, kind, { id: 2, nftBids: rule, reserve: 1n });
    bidWith(1, gems.slice(0, 2));
    bidWith(2, gems.slice(2));
    w.chain.warp(w.chain.now() + 601);
    const held = [{ collection: w.collection }, { collection: w.collection }];

    // A winning NFT of a bid on a player's lot is never a hold: it moves with the lot.
    assert.throws(() => end(w, w.cranker, seller, kind, { id: 1, held, hold: true }), /LotRefused/);
    const r = end(w, w.authority, seller, kind, { id: 1, ending: 'CallOff', held, hold: [gems[1]] });
    assert.deepEqual([receipt(r, 'SaleCalledOff').back, coreOwner(w, a)], [2n, seller]);
    assert.equal(coreOwner(w, gems[0]), w.player, 'moved back');
    assert.equal(w.read('Hold', pda.hold(gems[1], 0)).player, w.player, 'held for its bidder');

    end(w, w.cranker, seller, kind, { id: 2, ending: 'LotFirst' });
    assert.equal(coreOwner(w, b), w.player);
    end(w, w.cranker, seller, {}, { id: 2, held });
    assert.deepEqual([coreOwner(w, gems[2]), coreOwner(w, gems[3])], [seller, seller]);
    assert.equal(w.chain.get(pda.auction(w.project, seller, 2)), null);
  },
);

// ---------------------------------------------------------------- a loan's repayment

test(
  'a repayment brings a Core, a Token Metadata and a compressed NFT home; the money alone leaves the hold for a release',
  { skip: skipCompressed },
  async () => {
    const w = world({ seed: 'ex-repay', compressed: true });
    const { w: t, maker, club } = tmSetup('ex-repay-tm');
    const tree = cnftTree(w);
    w.upsert({ Item: { id: 1, args: collectible('Sword') } });
    const lend = (x, id, rule) => {
      const lender = x.who();
      x.fund(lender, x.mint, 10_000n);
      x.chain.send(lender, [
        loot.openOfferIx({
          maker: lender,
          project: x.project,
          id,
          mint: x.mint,
          args: { rule, deal: { Lend: { amount: 1_000n, repay: 1_100n, lasts: 3600 } }, left: 2 },
        }),
      ]);
      return lender;
    };
    const borrow = (x, lender, id, asset, kind) => {
      const due = BigInt(x.chain.now() + 3600);
      const offer = x.read('Offer', pda.offer(x.project, lender, id));
      const proof = kind.compressed ? [loot.proveLeafIx({ signer: x.player, compressed: kind.compressed })] : [];
      x.chain.send(x.player, [
        computeUnitLimit(1_400_000),
        ...loot.withLeafCloses([
          ...proof,
          loot.borrowIx({ borrower: x.player, project: x.project, id, offer, due, asset, ...kind }),
        ]),
      ]);
      return x.read('Hold', pda.hold(asset, due));
    };
    const repay = (x, hold, kind, home = true) => {
      const friend = x.who();
      x.fund(friend, x.mint, 1_100n);
      const proof = kind.compressed ? [loot.proveLeafIx({ signer: friend, compressed: kind.compressed })] : [];
      return x.chain.send(friend, [
        computeUnitLimit(1_400_000),
        ...loot.withLeafCloses([
          ...proof,
          loot.repayIx({ payer: friend, project: x.project, hold, repay: hold.debt.repay, home, ...kind }),
        ]),
      ]);
    };

    // Core: home in the same instruction, then another repaid with the money alone and released after.
    const core = { collection: w.collection };
    const lender = lend(w, 1, { of: { Item: [1] }, key: '', test: 'Any' });
    const [x, y] = [w.make(1, w.player), w.make(1, w.player)];
    let hold = borrow(w, lender, 1, x, core);
    let r = repay(w, hold, core);
    assert.deepEqual(names(r), ['Repaid', 'Released']);
    assert.deepEqual([receipt(r, 'Repaid').home, coreOwner(w, x)], [true, w.player]);
    hold = borrow(w, lender, 1, y, core);
    r = repay(w, hold, core, false);
    assert.deepEqual(names(r), ['Repaid'], 'nothing left the project');
    assert.equal(receipt(r, 'Repaid').home, false);
    const over = w.read('Hold', pda.hold(y, hold.free_at));
    assert.deepEqual([over.debt, over.free_at], [null, 0n], 'a plain hold that is over');
    w.chain.send(w.cranker, [
      loot.releaseIx({
        signer: w.cranker,
        project: w.project,
        asset: y,
        collection: w.collection,
        hold: over,
        address: pda.hold(y, hold.free_at),
      }),
    ]);
    assert.equal(coreOwner(w, y), w.player);
    assert.equal(w.balance(lender), 10_000n - 2_000n + 2n * 1_100n);

    // Compressed: proven in the same transaction, its proof first.
    const c = tree.mint(w.player);
    const cLender = lend(w, 2, { of: { Collection: [w.collection] }, key: '', test: 'Any' });
    hold = borrow(w, cLender, 2, c, { compressed: tree.compressed(c) });
    tree.moved(c, w.project);
    r = repay(w, hold, { compressed: tree.compressed(c) });
    assert.equal(receipt(r, 'Repaid').home, true);
    tree.moved(c, w.player);
    assert.deepEqual(onChainRoot(w, tree), tree.root(), 'the borrower’s again');

    // Token Metadata: into the borrower's own account, out of the project's (two different accounts).
    const tm = { tokenMetadata: { programmable: false, ruleSet: null } };
    const mint = tmNft(t, maker, t.player, club);
    const tLender = lend(t, 3, { of: { Collection: [club] }, key: '', test: 'Any' });
    hold = borrow(t, tLender, 3, mint, tm);
    assert.equal(t.chain.tokens(loot.ata(t.project, mint)), 1n);
    r = repay(t, hold, tm);
    assert.equal(receipt(r, 'Repaid').home, true);
    assert.equal(t.chain.tokens(loot.ata(t.player, mint)), 1n, 'home');
    assert.equal(t.chain.get(loot.ata(t.project, mint)), null, 'the project’s account closed');
  },
);

// ---------------------------------------------------------------- a roll's odds at its first ask

/** A chest given only as a prize: a sword (weight 99) or a dragon (1), the dragon raised +4% a level on the player's
 * profile and +5,100% for a charm. A grant gives a roll of it. */
function chestWorld(seed) {
  const w = world({ seed });
  w.upsert({ Item: { id: 1, args: collectible('Sword', 0, { kind: 'Normal' }) } });
  w.upsert({ Item: { id: 2, args: collectible('Dragon') } });
  w.upsert({ Item: { id: 3, args: collectible('Lucky Charm') } });
  const odds = [
    {
      entry: 1,
      boost: {
        rule: { of: 'Profile', key: 'level', test: { AtLeast: [0] } },
        effect: { PerPoint: { bps: 40_000, most: 100 } },
      },
    },
    { entry: 1, boost: { rule: { of: { Item: [3] }, key: '', test: 'Any' }, effect: { Flat: [510_000] } } },
  ];
  w.upsert({ Box: { id: 1, args: boxArgs(0n, [itemDrop(1, 99), itemDrop(2, 1)], { odds, active: false }) } });
  const never = { total: 0, per_window: 0, window: 0 };
  w.upsert({
    Grant: {
      id: 1,
      args: {
        gives: { Roll: [1] },
        vouchers: [NOBODY, NOBODY, NOBODY],
        list_root: new Uint8Array(32),
        limits: { wallet: never, per_person: 0, per_key: 0, all: never, window: { opens_at: 0n, closes_at: 0n } },
        active: true,
        gate: null,
        open: true,
      },
    },
  });
  // The player at level 12, with a charm.
  w.chain.send(w.authority, [
    loot.collectibleIx({
      authority: w.authority,
      project: w.project,
      collection: MPL_CORE_PROGRAM,
      asset: w.player,
      change: { Profile: [[{ key: 'level', value: '12' }]] },
    }),
  ]);
  const charm = w.make(3, w.player);
  const won = nonce => {
    const grant = w.read('Grant', pda.grant(w.project, 1));
    w.chain.send(w.player, [
      computeUnitLimit(1_400_000),
      loot.claimGrantIx({ project: w.project, id: 1, wallet: w.player, signer: w.player, grant, nonce }),
    ]);
    return pda.order(w.project, w.player, loot.prizeRollNonce(nonce));
  };
  return { w, charm, won, items: w.rolls([1]).items };
}

test(
  'a roll won on another route reads its player’s profile and their charm at its first ask; asked again, nothing',
  { skip },
  () => {
    const { w, charm, won, items } = chestWorld('ex-odds');
    const box = w.read('LootBox', pda.box(w.project, 1));
    assert.deepEqual(loot.askReads(box), { profile: true, nft: true });
    assert.equal(loot.bestShown(box, [{ asset: charm, itemId: 3, attributes: {} }]).best, charm);

    const order = won(1n);
    let o = w.read('Order', order);
    assert.equal(loot.firstAsk(o, box), true);
    // The project's keys ask (the oracle is late: no answer), passing the player's profile and the charm they hold.
    w.chain.nextSlot();
    const ask = (payer, shown) =>
      loot.askRollIx({ payer, orderAddress: order, order: w.read('Order', order), box, items, shown });
    const first = ask(w.authority, charm);
    const odds = first
      .at(-1)
      .keys.slice(-2)
      .map(k => k.pubkey);
    assert.deepEqual(odds, [pda.profile(w.project, w.player), charm], 'after the prizes: the profile, then the NFT');
    const r = w.chain.sendRaw(w.authority, [computeUnitLimit(1_400_000), ...first]);
    const raised = receipt(r, 'OddsRaised');
    assert.deepEqual([raised.profile, raised.asset], [pda.profile(w.project, w.player), charm]);
    // The receipt adds the boosts by entry; the order keeps what each odds rule added: +4% a level at level 12, and
    // the charm's.
    assert.deepEqual(raised.raised, [0, 12 * 40_000 + 510_000]);
    o = w.read('Order', order);
    assert.deepEqual(o.odds_bps, [480_000, 510_000]);
    assert.equal(loot.firstAsk(o, box), false);

    // Silent past its deadline, it is asked again: that ask reads nothing, and its odds stay as they were.
    w.chain.warp(w.chain.now() + 601);
    w.chain.nextSlot();
    const again = ask(w.player, charm);
    assert.equal(
      again.at(-1).keys.some(k => k.pubkey === charm || k.pubkey === pda.profile(w.project, w.player)),
      false,
      'a later ask passes none',
    );
    const r2 = w.chain.send(w.player, [computeUnitLimit(1_400_000), ...again]);
    assert.equal(receipt(r2, 'OddsRaised'), undefined);
    assert.deepEqual(w.read('Order', order).odds_bps, [480_000, 510_000]);
  },
);

test(
  'the player module asks a won roll with the profile and the player’s best NFT at its first ask',
  { skip },
  async () => {
    const { w, won } = chestWorld('ex-odds-play');
    // A second collectible that raises nothing: the charm is the one shown.
    w.make(2, w.player);
    const order = won(2n);
    w.chain.nextSlot();
    const app = solanaApp({
      spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } },
      rpc: w.chain.rpc,
      wallet: asWallet(w.player),
      now: () => w.chain.now(),
    });
    await app.askRoll(order);
    const o = w.read('Order', order);
    assert.deepEqual(o.odds_bps, [480_000, 510_000], 'the profile and the charm');
    assert.notEqual(o.status, 'Waiting');
  },
);

// ---------------------------------------------------------------- the player module's ends and repayments

test(
  'the player module: a sale waits while its lot can’t move, the keys call it off, a gone lot is called off by anyone, and a lot sent first is paid with its payees’ accounts opened first',
  { skip },
  async () => {
    const { w, maker, club } = tmSetup('ex-play-end');
    w.upsert({ Item: { id: 1, args: collectible('Painting') } });
    const seller = w.who();
    const tm = { tokenMetadata: { programmable: false, ruleSet: null } };
    const frozen = tmNft(w, maker, seller, club);
    const art = w.make(1, seller);
    const gone = w.make(1, seller);
    const partner = w.who();
    sale(w, seller, frozen, tm, { id: 1 });
    sale(w, seller, art, { collection: w.collection }, { id: 2, shares: [{ to: { Wallet: [partner] }, bps: 1_000 }] });
    sale(w, seller, gone, { collection: w.collection }, { id: 3 });
    w.chain.warp(w.chain.now() + 601);
    const spec = {
      version: 2,
      tokens: [],
      auctions: [1, 2, 3].map(id => ({ key: `a${id}`, id, seller })),
      live: { project: w.project, collection: w.collection },
    };
    const app = who => solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(who), now: () => w.chain.now() });

    // The project's account of the NFT frozen (as its collection could make it): nothing moves, the sale waits.
    const held = loot.ata(w.project, frozen);
    const account = w.chain.get(held);
    const data = Uint8Array.from(account.data);
    data[108] = 2;
    w.chain.put(held, { ...account, data });
    const waits = await app(w.cranker).endAuction('a1');
    assert.equal(waits.waiting, true);
    assert.match(waits.says, /the sale waits/);
    assert.ok(w.chain.get(pda.auction(w.project, seller, 1)), 'nothing was sent');
    await assert.rejects(app(w.cranker).callOffSale('a1'), /NotAuthority|owner or authority/);
    // The keys call it off: the bid back, the lot a hold for its seller until it can move.
    const off = await app(w.authority).callOffSale('a1');
    assert.equal(off.calledOff, true);
    assert.equal(w.chain.get(pda.auction(w.project, seller, 1)), null);
    assert.equal(w.read('Hold', pda.hold(frozen, 0)).player, seller);

    // Gone: anyone's end calls it off on the evidence.
    takeCore(w, gone, w.who());
    const called = await app(w.cranker).endAuction('a3');
    assert.deepEqual([called.calledOff, called.gone], [true, true]);

    // Sent first by the client; the module's end opens the partner's account, then pays.
    const auction = w.read('Auction', pda.auction(w.project, seller, 2));
    w.chain.send(w.cranker, [
      loot.endAuctionIx({
        signer: w.cranker,
        project: w.project,
        projectState: w.projectState(),
        id: 2,
        auction,
        collection: w.collection,
        ending: 'LotFirst',
      }),
    ]);
    assert.equal(w.chain.get(loot.ata(partner, w.mint)), null);
    const paid = await app(w.cranker).endAuction('a2');
    assert.ok(paid.paid);
    assert.deepEqual([w.balance(partner), w.balance(seller)], [50n, 450n]);
    assert.equal(w.chain.get(pda.auction(w.project, seller, 2)), null);
    assert.equal(w.balance(w.player), 100n * 1_000_000n - 500n, 'two bids back, one paid');
  },
);

test(
  'the player module repays: home in one prompt; the money alone when the NFT can’t move now; refused before signing when it is gone',
  { skip },
  async () => {
    const { w, maker, club } = tmSetup('ex-play-repay');
    w.upsert({ Item: { id: 1, args: collectible('Sword') } });
    const lender = w.who();
    w.fund(lender, w.mint, 10_000n);
    const open = (id, rule) =>
      w.chain.send(lender, [
        loot.openOfferIx({
          maker: lender,
          project: w.project,
          id,
          mint: w.mint,
          args: { rule, deal: { Lend: { amount: 1_000n, repay: 1_100n, lasts: 3600 } }, left: 3 },
        }),
      ]);
    open(1, { of: { Item: [1] }, key: '', test: 'Any' });
    open(2, { of: { Collection: [club] }, key: '', test: 'Any' });
    let prompts = 0;
    const app = solanaApp({
      spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } },
      rpc: w.chain.rpc,
      wallet: { address: w.player, signTransaction: async x => (prompts++, x) },
      now: () => w.chain.now(),
    });
    const [sword, lost] = [w.make(1, w.player), w.make(1, w.player)];
    const nft = tmNft(w, maker, w.player, club);
    const loans = [];
    for (const [id, asset] of [
      [1, sword],
      [1, lost],
      [2, nft],
    ])
      loans.push(await app.borrow(lender, id, asset));

    prompts = 0;
    const home = await app.repay(sword, loans[0].due, { repay: 1_100n });
    assert.deepEqual([home.home, prompts, coreOwner(w, sword)], [true, 1, w.player]);

    // Frozen for now in the project's account: the money alone, so the loan doesn't fall due.
    const held = loot.ata(w.project, nft);
    const account = w.chain.get(held);
    const data = Uint8Array.from(account.data);
    data[108] = 2;
    w.chain.put(held, { ...account, data });
    const alone = await app.repay(nft, loans[2].due, { repay: 1_100n });
    assert.equal(alone.home, false);
    assert.match(alone.says, /stays with the project/);
    assert.equal(w.read('Hold', loans[2].hold).debt, null);

    // Taken back while held: refused in words, nothing signed.
    takeCore(w, lost, w.who());
    prompts = 0;
    await assert.rejects(app.repay(lost, loans[1].due, { repay: 1_100n }), /no longer holds.*NotTheNft/);
    assert.equal(prompts, 0);
    assert.equal(w.balance(lender), 10_000n - 6_000n + 2n * 1_100n, 'two offers of three loans each, two repaid');
    // Once it is due, the lender's claims flag that loan's hold: its NFT is gone, and its release can't be sent.
    w.chain.warp(Number(loans[1].due) + 1);
    const lenders = solanaApp({
      spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } },
      rpc: w.chain.rpc,
      wallet: asWallet(lender),
      now: () => w.chain.now(),
    });
    const flagged = (await lenders.claims()).find(c => c.asset === lost);
    assert.deepEqual([flagged.kind, flagged.gone], ['release', true]);
    await assert.rejects(lenders.claim(flagged), /no longer holds this NFT/);
  },
);

// ---------------------------------------------------------------- an end too wide for one transaction

const HOOK = 'Hook111111111111111111111111111111111111111';

/** A Token-2022 coin whose transfer hook is the test hook, which counts each transfer in one account its list names
 * (with a transfer fee of 0), the owner its mint authority. Returns the coin and what each transfer of it carries. */
function hookedCoin(w) {
  const mint = newAddress(w.random);
  w.chain.svm.addProgram(HOOK, pinned('test_hook.so'));
  const base = new Uint8Array(166);
  base.set(uintLE(1, 4));
  base.set(addressBytes(w.creator), 4);
  base[44] = 6;
  base[45] = 1;
  base[165] = 1;
  const fees = concat(new Uint8Array(72), new Uint8Array(16), uintLE(0, 2), new Uint8Array(16), uintLE(0, 2));
  const hook = concat(new Uint8Array(32), addressBytes(HOOK));
  const data = concat(base, uintLE(1, 2), uintLE(fees.length, 2), fees, uintLE(14, 2), uintLE(hook.length, 2), hook);
  w.chain.put(mint, { owner: TOKEN_2022_PROGRAM, lamports: w.chain.rent(data.length), data });
  const counter = newAddress(w.random);
  const list = concat(
    EXECUTE_DISCRIMINATOR,
    uintLE(39, 4),
    uintLE(1, 4),
    Uint8Array.of(0),
    addressBytes(counter),
    Uint8Array.of(0, 1),
  );
  w.chain.put(validationAddress(mint, HOOK), { owner: HOOK, lamports: w.chain.rent(list.length), data: list });
  w.chain.put(counter, { owner: HOOK, lamports: w.chain.rent(16), data: new Uint8Array(16) });
  const extra = [
    meta(MEMO_PROGRAM, false, false),
    meta(HOOK, false, false),
    meta(validationAddress(mint, HOOK), false, false),
    meta(counter, false, true),
  ];
  return { mint, extra };
}

test(
  'the player module ends a sale too wide for one transaction: the lot first, then the payees’ accounts opened, then the money',
  { skip: skipCompressed },
  async () => {
    // The widest sale the test world makes: a compressed lot at a 17-node proof, eight shares to holders of collectibles,
    // and a coin with a transfer hook.
    const w = world({ seed: 'ex-widest', compressed: true });
    w.upsert({ Item: { id: 1, args: collectible('Painting') } });
    const { mint: coin, extra } = hookedCoin(w);
    const holders = Array.from({ length: loot.MAX_SHARES }, () => w.who());
    const shares = holders.map(h => ({ to: { Holder: [w.make(1, h)] }, bps: 1_000 }));
    const tree = cnftTree(w, { depth: 17, buffer: 64 });
    const seller = w.who();
    const lot = tree.mint(seller);
    const now = w.chain.now();
    w.chain.send(seller, [
      computeUnitLimit(1_400_000),
      ...loot.withLeafCloses([
        loot.proveLeafIx({ signer: seller, compressed: tree.compressed(lot) }),
        loot.openAuctionIx({
          seller,
          project: w.project,
          id: 1,
          mint: coin,
          compressed: tree.compressed(lot),
          args: {
            lot: { Asset: [lot] },
            reserve: 100n,
            min_raise_bps: 0,
            starts_at: BigInt(now),
            ends_at: BigInt(now + 600),
            extend: 0,
            shares,
            gate: null,
            nft_bids: null,
          },
        }),
      ]),
    ]);
    tree.moved(lot, w.project);
    const bidder = w.who();
    w.chain.send(w.creator, [
      createAssociatedTokenAccountIdempotent(w.creator, bidder, coin, TOKEN_2022_PROGRAM),
      mintToIx({
        mint: coin,
        to: loot.ata(bidder, coin, TOKEN_2022_PROGRAM),
        authority: w.creator,
        amount: 1_000_000n,
        tokenProgram: TOKEN_2022_PROGRAM,
      }),
    ]);
    const at = pda.auction(w.project, seller, 1);
    const programs = { [coin]: TOKEN_2022_PROGRAM };
    w.chain.send(bidder, [
      loot.bidIx({
        bidder,
        project: w.project,
        id: 1,
        auction: w.read('Auction', at),
        amount: 1_000_000n,
        programs,
        extra,
      }),
    ]);
    w.chain.warp(now + 601);

    // The end that delivers and pays together does not fit one transaction, even with a lookup table.
    const holdersNow = Object.fromEntries(shares.map((x, i) => [x.to.Holder[0], holders[i]]));
    const together = [
      computeUnitLimit(1_400_000),
      loot.proveLeafIx({ signer: w.cranker, compressed: tree.compressed(lot) }),
      loot.endAuctionIx({
        signer: w.cranker,
        project: w.project,
        projectState: w.projectState(),
        id: 1,
        auction: w.read('Auction', at),
        compressed: tree.compressed(lot),
        holders: holdersNow,
        programs,
        extra,
      }),
    ];
    const isProve = ix => ix.programId === loot.LOOT_PROGRAM && loot.instructionOf(ix.data)?.name === 'prove_leaf';
    assert.equal(sendPlan({ payer: w.cranker, instructions: together, alone: isProve }), null, 'too wide together');
    for (const h of [...holders, seller]) assert.equal(w.chain.get(loot.ata(h, coin, TOKEN_2022_PROGRAM)), null);

    // The module alone: the lot first, then the payees' accounts, then the money.
    const sent = [];
    const rpc = { ...tree.rpc, send: async wire => (sent.push(wire), tree.rpc.send(wire)) };
    const app = solanaApp({
      spec: {
        version: 2,
        tokens: [],
        auctions: [{ key: 'lot', id: 1, seller }],
        live: { project: w.project, collection: w.collection },
      },
      rpc,
      wallet: asWallet(w.cranker),
      now: () => w.chain.now(),
    });
    const ended = await app.endAuction('lot');
    assert.equal(ended.lotFirst, true);
    assert.ok(ended.signature && ended.paid, 'both ends sent');
    tree.moved(lot, bidder);
    assert.deepEqual(onChainRoot(w, tree), tree.root(), 'the winner holds the lot');
    for (const h of holders) assert.equal(tokens(w, h, coin, TOKEN_2022_PROGRAM), 100_000n, 'each holder’s tenth');
    assert.equal(tokens(w, seller, coin, TOKEN_2022_PROGRAM), 200_000n, 'the seller’s rest');
    assert.equal(w.chain.get(at), null, 'closed');
    // The payees' accounts were opened in a transaction of their own, before the money.
    const programsOf = wire => {
      const m = readMessage(readTransaction(wire).message);
      return m.instructions.map(ix => m.keys[ix.programIndex]);
    };
    const opens = sent.findIndex(wire => programsOf(wire).every(p => p === ASSOCIATED_TOKEN_PROGRAM));
    assert.ok(opens > 0 && opens < sent.length - 1, 'after the lot, before the money');
  },
);

// ---------------------------------------------------------------- a record an earlier owner left

/** A Core collection of `maker`'s that the project does not name, and an asset of it for `owner` (Core CreateV2). */
function outsideAsset(w, maker, owner) {
  const collection = newAddress(w.random);
  w.chain.send(maker, [
    createCollectionInstruction({
      collection,
      creator: maker,
      name: 'Outside',
      uri: 'https://example.invalid/o.json',
      project: w.project,
    }),
  ]);
  const asset = newAddress(w.random);
  const str = x => concat(uintLE(utf8(x).length, 4), utf8(x));
  w.chain.send(maker, [
    {
      programId: MPL_CORE_PROGRAM,
      keys: [
        meta(asset, true, true),
        meta(collection, false, true),
        meta(maker, true, false),
        meta(maker, true, true),
        meta(owner, false, false),
        meta(MPL_CORE_PROGRAM, false, false),
        meta(SYSTEM_PROGRAM, false, false),
        meta(MPL_CORE_PROGRAM, false, false),
      ],
      data: concat(Uint8Array.of(20, 0), str('Outside #1'), str('https://example.invalid/1.json'), Uint8Array.of(0, 0)),
    },
  ]);
  return { asset, collection };
}

test(
  'a deposit of an NFT whose earlier owner left a listing or a hold in the project is refused in words, and goes ahead with acceptLeftover',
  { skip },
  async () => {
    const w = world({ seed: 'ex-leftover' });
    const maker = w.who();
    const [earlier, next] = [w.who(), w.who()];
    // An earlier owner lists one NFT and holds another; whoever controls their collection takes both out of the
    // project's hands, and they reach the next owner.
    const listed = outsideAsset(w, maker, earlier);
    const held = outsideAsset(w, maker, earlier);
    w.chain.send(earlier, [
      loot.openListingIx({
        maker: earlier,
        project: w.project,
        asset: listed.asset,
        mint: w.mint,
        deal: { Sell: { price: 100n } },
        collection: listed.collection,
        hasAuthority: false,
      }),
    ]);
    const freeAt = BigInt(w.chain.now() + 60);
    w.chain.send(earlier, [
      loot.holdIx({ player: earlier, project: w.project, asset: held.asset, collection: held.collection, freeAt }),
    ]);
    takeCore(w, listed.asset, next);
    takeCore(w, held.asset, next);
    w.chain.warp(w.chain.now() + 61);

    let prompts = 0;
    const app = solanaApp({
      spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } },
      rpc: w.chain.rpc,
      wallet: { address: next, signTransaction: async x => (prompts++, x) },
      now: () => w.chain.now(),
    });
    await assert.rejects(
      app.hold(listed.asset, 3600),
      new RegExp(
        `listing of this NFT .* left by an earlier owner, ${earlier}.*would be lost to you.*acceptLeftover: true`,
      ),
    );
    await assert.rejects(
      app.hold(held.asset, 3600),
      /a hold that is over: anyone can send the NFT to .*acceptLeftover/,
    );
    // A listing: the program refuses a second one while the first is open, so no option sends it.
    await assert.rejects(
      app.listForSale(listed.asset, { price: 1, acceptLeftover: true }),
      /refuses another listing of this NFT/,
    );
    assert.equal(prompts, 0, 'nothing signed');

    // Given the option, the deposit goes: and the earlier owner's listing takes it, as the warning said.
    const { freeAt: until } = await app.hold(listed.asset, 3600, { acceptLeftover: true });
    assert.equal(coreOwner(w, listed.asset), w.project);
    assert.ok(w.chain.get(pda.hold(listed.asset, until)));
    w.chain.send(earlier, [
      loot.closeListingIx({
        maker: earlier,
        project: w.project,
        listing: w.read('Listing', pda.listing(w.project, listed.asset)),
        collection: listed.collection,
      }),
    ]);
    assert.equal(coreOwner(w, listed.asset), earlier, 'the earlier owner took the deposit');
  },
);
