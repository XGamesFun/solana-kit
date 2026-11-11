// A record whose NFT is gone from the project closes (loot 0.27), through js/play on the real program. Whoever
// controls a collection the project does not can take an NFT out of the project's hands, or burn it, while a hold, a
// loan or a listing has it. The instruction that would have moved it then finishes without it and leaves an `NftGone`
// receipt: a hold closes at any time (`claims`, `claim`), a loan ends unpaid, a listing closes for its maker
// (`unlist`) and for anyone (`closeGone`), and a deposit clears what an earlier owner left before it hands the NFT in.
// For each kind of NFT the test world makes: a Core asset its controller really takes or burns (a permanent transfer
// and burn delegate), a compressed NFT the same way through Bubblegum, and a Token Metadata NFT whose token is moved by
// hand, as only its own program could.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cnftTree } from './cnft-chain.mjs';
import { burn, coreOwner, seizingAsset, seizingCollection, takeBack } from './gone-chain.mjs';
import { nftOf as tmNft, setup as tmSetup } from './tm-chain.mjs';
import { boxArgs, cannotRun, cannotRunCompressed, drop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const skipCompressed = cannotRunCompressed() ?? false;
const { pda } = loot;
const FEE = 5_000n;
const lamports = (w, address) => BigInt(w.chain.get(address)?.lamports ?? 0);
const names = tx => tx.receipts.map(r => r.name);
const receipt = (tx, name) => tx.receipts.find(r => r.name === name)?.data;

/** A wire transaction with a signature of its own in its first slot (the local chain checks none), so each one this
 * wallet sends is found again by its signature. */
let signatures = 0;
function signed(wire) {
  const out = Uint8Array.from(wire);
  out.fill(0, 1, 65);
  out.set(new Uint8Array(new BigUint64Array([BigInt(++signatures)]).buffer), 1);
  return out;
}

/** The play module for `address` on world `w`, with `wallet` its address and `calls.prompts` what its wallet signed;
 * `rpc`: one that answers an indexer's calls too, for a compressed NFT's tree. */
function appOf(w, address, { rpc = w.chain.rpc } = {}) {
  const calls = { prompts: 0 };
  const app = solanaApp({
    spec: {
      version: 2,
      currency: 'coin',
      tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }],
      live: { project: w.project, collection: w.collection },
    },
    rpc,
    wallet: { address, signTransaction: async wire => (calls.prompts++, signed(wire)) },
    now: () => w.chain.now(),
  });
  return Object.assign(app, { calls, wallet: address });
}

/** A world with a collection its `controller` can take NFTs back out of, which the project does not control. */
function fixture(seed, options = {}) {
  const w = world({ seed, ...options });
  const controller = w.who();
  const collection = seizingCollection(w, controller, { compressed: options.compressed });
  const mint = owner => seizingAsset(w, controller, collection, owner);
  return { w, controller, collection, mint, landed: w.watch() };
}

/** A Token Metadata NFT the project holds leaves its token account, as only its own program could move it: into an
 * account of `to`'s (returned), or, burned, out of existence (its mint, holding none, returned). */
function takeTokenMetadata(w, mint, to, { burned = false } = {}) {
  const held = loot.ata(w.project, mint);
  const account = w.chain.get(held);
  const emptied = Uint8Array.from(account.data);
  emptied.fill(0, 64, 72);
  w.chain.put(held, { ...account, data: emptied });
  if (burned) {
    const m = w.chain.get(mint);
    const supply = Uint8Array.from(m.data);
    supply.fill(0, 36, 44);
    w.chain.put(mint, { ...m, data: supply });
    return mint;
  }
  const theirs = loot.ata(to, mint);
  const moved = Uint8Array.from(account.data);
  moved.set(addressBytes(to), 32);
  w.chain.put(theirs, { ...account, data: moved });
  return theirs;
}

/** What `signature` left in the log, as the chain recorded it. */
const logged = (landed, signature) => {
  const tx = landed.find(r => r.id === signature);
  assert.ok(tx, `no landed transaction ${signature}`);
  return tx;
};

/** The hold closed on the proof: its account gone, an `NftGone` for it by `by`, and no receipt saying the NFT moved. */
function closedGone(w, tx, record, asset, by) {
  assert.equal(w.chain.get(record), null, 'the record is closed');
  const gone = tx.receipts.filter(r => r.name === 'NftGone').map(r => r.data);
  assert.ok(
    gone.some(g => g.record === record && g.asset === asset && g.by === by && g.project === w.project),
    `NftGone for ${record}: ${JSON.stringify(gone)}`,
  );
  for (const moved of ['Released', 'Repaid', 'ListingSold', 'Unlisted'])
    assert.ok(!names(tx).includes(moved), `no ${moved}: ${names(tx)}`);
}

// ---------------------------------------------------------------- a hold

test(
  'a hold whose Core NFT was taken back or burned: claims() lists it while it still runs, and claim closes it',
  { skip },
  async () => {
    const { w, controller, collection, mint, landed } = fixture('gone-hold');
    const alice = appOf(w, w.player);
    for (const burned of [false, true]) {
      const nft = mint(w.player);
      const { freeAt } = await alice.hold(nft, 3600);
      const hold = pda.hold(nft, freeAt);
      assert.equal(coreOwner(w, nft), w.project);
      assert.ok(!(await alice.claims()).some(c => c.asset === nft), 'held and running: nothing to finish');

      if (burned) burn(w, controller, collection, nft);
      else takeBack(w, controller, collection, nft);
      assert.equal(coreOwner(w, nft), burned ? null : controller);
      assert.ok(w.chain.now() < Number(freeAt), 'the hold still runs');
      const [claim] = (await alice.claims()).filter(c => c.asset === nft);
      assert.deepEqual([claim.kind, claim.gone, claim.hold], ['release', true, hold]);
      assert.match(claim.says, /no longer holds this NFT.*closing it sends nothing.*rent goes back to whoever paid it/);
      assert.doesNotMatch(claim.says, /loan/);

      const [rent, before] = [lamports(w, hold), lamports(w, w.player)];
      alice.calls.prompts = 0;
      const signature = await alice.claim(claim);
      assert.equal(alice.calls.prompts, 1);
      closedGone(w, logged(landed, signature), hold, nft, w.player);
      // Its payer is the player who made it: the rent comes back, less the fee of this transaction.
      assert.equal(lamports(w, w.player), before + rent - FEE, 'its rent went to its payer');
      assert.ok(!(await alice.claims()).some(c => c.asset === nft), 'nothing left to finish');
    }
  },
);

test(
  'a hold of a Token Metadata NFT that left the project closes on the account that holds it now, or its burned mint',
  { skip },
  async () => {
    const { w, maker, club } = tmSetup('gone-hold-tm');
    const landed = w.watch();
    const alice = appOf(w, w.player);
    for (const burned of [false, true]) {
      const nft = tmNft(w, maker, w.player, club);
      const { freeAt } = await alice.hold(nft, 3600);
      const hold = pda.hold(nft, freeAt);
      assert.equal(w.chain.tokens(loot.ata(w.project, nft)), 1n);
      assert.ok(!(await alice.claims()).some(c => c.asset === nft));
      // Frozen in the project's account, it is held, not gone.
      const held = w.chain.get(loot.ata(w.project, nft));
      const frozen = Uint8Array.from(held.data);
      frozen[108] = 2;
      w.chain.put(loot.ata(w.project, nft), { ...held, data: frozen });
      assert.ok(!(await alice.claims()).some(c => c.asset === nft), 'frozen and held: not gone');
      w.chain.put(loot.ata(w.project, nft), held);

      takeTokenMetadata(w, nft, w.who(), { burned });
      const [claim] = (await alice.claims()).filter(c => c.asset === nft);
      assert.deepEqual([claim.kind, claim.gone], ['release', true]);
      const [rent, before] = [lamports(w, hold), lamports(w, w.player)];
      const signature = await alice.claim(claim);
      closedGone(w, logged(landed, signature), hold, nft, w.player);
      assert.equal(lamports(w, w.player), before + rent - FEE);
    }
  },
);

test(
  'a hold of a compressed NFT its collection took back or burned closes on its record, proven again',
  { skip: skipCompressed },
  async () => {
    const { w, controller, collection, landed } = fixture('gone-hold-cnft', { compressed: true });
    const tree = cnftTree(w, { maker: controller, collection });
    const alice = appOf(w, w.player, { rpc: tree.rpc });
    for (const burned of [false, true]) {
      const nft = tree.mint(w.player);
      const { freeAt } = await alice.hold(nft, 3600);
      tree.moved(nft, w.project);
      const hold = pda.hold(nft, freeAt);
      assert.ok(!(await alice.claims()).some(c => c.asset === nft), 'held and running');

      if (burned) tree.burn(nft, controller);
      else tree.take(nft, controller);
      const [claim] = (await alice.claims()).filter(c => c.asset === nft);
      assert.deepEqual([claim.kind, claim.gone], ['release', true]);
      const [rent, before] = [lamports(w, hold), lamports(w, w.player)];
      const signature = await alice.claim(claim);
      closedGone(w, logged(landed, signature), hold, nft, w.player);
      // The proof record the claim made is closed in the same transaction: only the fee is spent.
      assert.equal(lamports(w, w.player), before + rent - FEE);
      assert.equal(w.chain.get(pda.leaf(nft)), null);
    }
  },
);

// ---------------------------------------------------------------- a loan

test(
  'a loan whose NFT was taken: repay refuses in words and takes nothing; both sides’ claims list it; one claim closes it unpaid',
  { skip },
  async () => {
    const { w, controller, collection, mint, landed } = fixture('gone-loan');
    const lender = w.who();
    w.fund(lender, w.mint, 10_000n);
    w.chain.send(lender, [
      loot.openOfferIx({
        maker: lender,
        project: w.project,
        id: 1,
        mint: w.mint,
        args: {
          rule: { of: { Collection: [collection] }, key: '', test: 'Any' },
          deal: { Lend: { amount: 1_000n, repay: 1_100n, lasts: 3600 } },
          left: 1,
        },
      }),
    ]);
    const [borrower, lenders] = [appOf(w, w.player), appOf(w, lender)];
    const nft = mint(w.player);
    const loan = await borrower.borrow(lender, 1, nft);
    const balances = () => [w.balance(lender), w.balance(w.player)];
    const lent = balances();
    assert.ok(!(await lenders.claims()).some(c => c.asset === nft), 'held and not due: nothing for the lender');

    takeBack(w, controller, collection, nft);
    borrower.calls.prompts = 0;
    await assert.rejects(
      borrower.repay(nft, loan.due, { repay: 1_100n }),
      /no longer holds the NFT.*takes no repayment.*nothing was sent.*closed for nothing: claims\(\) lists it.*claim\(\) of it closes the hold/,
    );
    assert.equal(borrower.calls.prompts, 0, 'nothing signed');
    assert.deepEqual(balances(), lent, 'nothing taken');

    // Before it is due, each side sees it, flagged gone, with what closing it does to the loan.
    assert.ok(w.chain.now() < Number(loan.due));
    const mine = (await borrower.claims()).find(c => c.asset === nft);
    const theirs = (await lenders.claims()).find(c => c.asset === nft);
    for (const c of [mine, theirs]) {
      assert.deepEqual([c.kind, c.gone, c.hold], ['release', true, loan.hold]);
      assert.match(c.says, /It was a loan: nothing is repaid, the borrower keeps what they borrowed/);
    }
    // The lender closes it: the hold's rent goes to the borrower, who paid it, and no token moves.
    const [rent, before] = [lamports(w, loan.hold), lamports(w, w.player)];
    const signature = await lenders.claim(theirs);
    closedGone(w, logged(landed, signature), loan.hold, nft, lender);
    assert.equal(lamports(w, w.player), before + rent, 'the hold’s rent to the borrower who paid it');
    assert.deepEqual(balances(), lent, 'nothing was paid: the borrower keeps the loan, the lender is out it');
    assert.ok(!(await borrower.claims()).some(c => c.asset === nft));
    assert.ok(!(await lenders.claims()).some(c => c.asset === nft));
  },
);

// ---------------------------------------------------------------- a listing

test(
  'a listing whose Core NFT was taken: flagged, refused to a buyer in words, closed by its maker, and by anyone for nothing',
  { skip },
  async () => {
    const { w, controller, collection, mint, landed } = fixture('gone-listing');
    const [maker, buyer, stranger] = [appOf(w, w.player), appOf(w, w.who()), appOf(w, w.who())];
    w.fund(buyer.wallet, w.mint, 1_000n);
    const [own, other, there] = [mint(w.player), mint(w.player), mint(w.player)];
    for (const nft of [own, other, there]) await maker.listForSale(nft, { price: '0.0001' });
    const shown = await buyer.listing(own);
    assert.equal(shown.gone, undefined, 'there: not flagged');
    assert.ok((await buyer.listings()).every(l => !l.gone));

    takeBack(w, controller, collection, own);
    burn(w, controller, collection, other);
    const now = await buyer.listing(own);
    assert.equal(now.gone, true);
    assert.match(now.says, /nothing to buy or rent.*closed for nothing/);
    const all = await buyer.listings();
    assert.deepEqual(
      [own, other, there].map(nft => Boolean(all.find(l => l.asset === nft).gone)),
      [true, true, false],
      'one read flags each listing whose NFT is gone',
    );

    // A buyer is told before anything is signed: nothing is there to buy.
    const coins = w.balance(buyer.wallet);
    await assert.rejects(
      buyer.buyListing(own, { listing: shown }),
      /no longer holds the NFT.*nothing to buy or rent, and nothing was sent.*Anyone can close this listing for nothing \(closeGone\)/,
    );
    assert.equal(buyer.calls.prompts, 0, 'nothing signed');
    assert.equal(w.balance(buyer.wallet), coins);

    // Its maker closes one: the rent comes back, and nothing says the NFT went home.
    const listing = pda.listing(w.project, own);
    const [rent, before] = [lamports(w, listing), lamports(w, w.player)];
    const unlisted = await maker.unlist(own);
    closedGone(w, logged(landed, unlisted), listing, own, w.player);
    assert.equal(lamports(w, w.player), before + rent - FEE, 'its rent to its maker');

    // Anyone closes the other, for nothing: no token moves, and its rent goes to its maker, not to the sender.
    const second = pda.listing(w.project, other);
    const [rent2, makerBefore, strangerBefore] = [
      lamports(w, second),
      lamports(w, w.player),
      lamports(w, stranger.wallet),
    ];
    const closed = await stranger.closeGone(other);
    assert.deepEqual(closed.closed, [{ kind: 'listing', address: second }]);
    assert.deepEqual(closed.waits, []);
    closedGone(w, logged(landed, closed.signature), second, other, stranger.wallet);
    assert.equal(lamports(w, w.player), makerBefore + rent2, 'its rent to its maker');
    assert.equal(lamports(w, stranger.wallet), strangerBefore - FEE, 'the sender pays the fee only');
    assert.equal(w.balance(w.player), 100_000_000n, 'the maker was paid nothing');

    // One whose NFT is there is nobody's to close this way, and still sells.
    await assert.rejects(stranger.closeGone(there), /Nothing shows that the project no longer holds/);
    await buyer.buyListing(there, { listing: await buyer.listing(there) });
    assert.equal(coreOwner(w, there), buyer.wallet);
    assert.deepEqual(await stranger.closeGone(there), { signature: null, closed: [], waits: [] });
  },
);

test(
  'a rented listing whose NFT was taken keeps its rental: it only stops, and closes once the rental has run',
  { skip },
  async () => {
    const { w, controller, collection, mint, landed } = fixture('gone-rental');
    const [maker, renter, stranger] = [appOf(w, w.player), appOf(w, w.who()), appOf(w, w.who())];
    w.fund(renter.wallet, w.mint, 1_000_000n);
    const nft = mint(w.player);
    await maker.listForRent(nft, { price: '0.0001', lasts: 3600, maxPeriods: 2 });
    await renter.rentListing(nft, { periods: 1, listing: await renter.listing(nft) });
    takeBack(w, controller, collection, nft);
    const listing = pda.listing(w.project, nft);

    // While the rental runs nobody closes it, and nobody rents it again.
    assert.deepEqual(await stranger.closeGone(nft), {
      signature: null,
      closed: [],
      waits: [{ kind: 'listing', address: listing }],
    });
    await assert.rejects(renter.rentListing(nft, { listing: await renter.listing(nft) }), /nothing to buy or rent/);
    // Its maker's close only stops it: the renter keeps the rental they paid for.
    const stopped = await maker.unlist(nft);
    assert.ok(!names(logged(landed, stopped)).includes('NftGone'));
    const kept = w.read('Listing', listing);
    assert.deepEqual([kept.stopped, kept.user], [true, renter.wallet]);

    w.chain.warp(w.chain.now() + 3601);
    const [rent, before] = [lamports(w, listing), lamports(w, w.player)];
    const closed = await stranger.closeGone(nft);
    closedGone(w, logged(landed, closed.signature), listing, nft, stranger.wallet);
    assert.equal(lamports(w, w.player), before + rent, 'its rent to its maker');
  },
);

test(
  'a listing of a Token Metadata NFT that left the project closes on the account that holds it now',
  { skip },
  async () => {
    const { w, maker: minter, club } = tmSetup('gone-listing-tm');
    const landed = w.watch();
    const [maker, stranger] = [appOf(w, w.player), appOf(w, w.who())];
    const [own, other] = [tmNft(w, minter, w.player, club), tmNft(w, minter, w.player, club)];
    for (const nft of [own, other]) await maker.listForSale(nft, { price: '0.0001' });
    assert.ok((await maker.listings()).every(l => !l.gone));
    takeTokenMetadata(w, own, w.who());
    takeTokenMetadata(w, other, w.who(), { burned: true });
    assert.ok(
      (await maker.listings()).every(l => l.gone),
      'each flagged from the project’s empty account',
    );
    assert.equal((await maker.listing(own)).gone, true);

    const unlisted = await maker.unlist(own);
    closedGone(w, logged(landed, unlisted), pda.listing(w.project, own), own, w.player);
    const closed = await stranger.closeGone(other);
    closedGone(w, logged(landed, closed.signature), pda.listing(w.project, other), other, stranger.wallet);
  },
);

test(
  'a listing of a compressed NFT its collection burned or took back closes on its record',
  { skip: skipCompressed },
  async () => {
    const { w, controller, collection, landed } = fixture('gone-listing-cnft', { compressed: true });
    const tree = cnftTree(w, { maker: controller, collection });
    const [maker, stranger] = [appOf(w, w.player, { rpc: tree.rpc }), appOf(w, w.who(), { rpc: tree.rpc })];
    const [own, other] = [tree.mint(w.player), tree.mint(w.player)];
    for (const nft of [own, other]) {
      await maker.listForSale(nft, { price: '0.0001' });
      tree.moved(nft, w.project);
    }
    tree.burn(own, controller);
    tree.take(other, controller);
    assert.equal((await maker.listing(own)).gone, true, 'read from the indexer');

    const unlisted = await maker.unlist(own);
    closedGone(w, logged(landed, unlisted), pda.listing(w.project, own), own, w.player);
    const closed = await stranger.closeGone(other);
    closedGone(w, logged(landed, closed.signature), pda.listing(w.project, other), other, stranger.wallet);
  },
);

// ---------------------------------------------------------------- the deposit guard

/**
 * An NFT with an earlier owner's listing and hold both left behind, now in `next`'s wallet: the earlier owner lists
 * it, its controller takes it back and returns it, the earlier owner puts it on a hold (which runs an hour), and its
 * controller takes it again and gives it to `next`. Returns { nft, listing, hold }.
 */
function leftBehind({ w, controller, collection, mint }, earlier, next) {
  const nft = mint(earlier);
  w.chain.send(earlier, [
    loot.openListingIx({
      maker: earlier,
      project: w.project,
      asset: nft,
      mint: w.mint,
      deal: { Sell: { price: 100n } },
      collection,
      hasAuthority: false,
    }),
  ]);
  takeBack(w, controller, collection, nft, earlier);
  const freeAt = BigInt(w.chain.now() + 3600);
  w.chain.send(earlier, [loot.holdIx({ player: earlier, project: w.project, asset: nft, collection, freeAt })]);
  takeBack(w, controller, collection, nft, next);
  return { nft, listing: pda.listing(w.project, nft), hold: pda.hold(nft, freeAt) };
}

test(
  'a deposit clears the hold and the listing an earlier owner left, in the same transaction, with no option',
  { skip },
  async () => {
    const f = fixture('gone-deposit');
    const { w, collection, landed } = f;
    const [earlier, next] = [w.who(), w.who()];
    const lender = w.who();
    w.fund(lender, w.mint, 10_000n);
    w.chain.send(lender, [
      loot.openOfferIx({
        maker: lender,
        project: w.project,
        id: 1,
        mint: w.mint,
        args: {
          rule: { of: { Collection: [collection] }, key: '', test: 'Any' },
          deal: { Lend: { amount: 1_000n, repay: 1_100n, lasts: 7200 } },
          left: 1,
        },
      }),
    ]);
    const app = appOf(w, next);
    const routes = {
      hold: nft => app.hold(nft, 600).then(r => r.signature),
      listForSale: nft => app.listForSale(nft, { price: '0.0001' }),
      borrow: nft => app.borrow(lender, 1, nft).then(r => r.signature),
    };
    for (const [route, deposit] of Object.entries(routes)) {
      const { nft, listing, hold } = leftBehind(f, earlier, next);
      assert.equal(coreOwner(w, nft), next);
      const rents = lamports(w, listing) + lamports(w, hold);
      const [before, mine] = [lamports(w, earlier), lamports(w, next)];
      app.calls.prompts = 0;
      const signature = await deposit(nft);
      assert.equal(app.calls.prompts, 1, `${route}: the closes and the deposit in one prompt`);
      const tx = logged(landed, signature);
      const gone = tx.receipts.filter(r => r.name === 'NftGone').map(r => r.data.record);
      assert.deepEqual(gone.sort(), [listing, hold].sort(), `${route}: both closed on the proof`);
      assert.equal(w.chain.get(hold), null, `${route}: the earlier hold is closed`);
      // The earlier owner is whom both records name: every lamport of their rent went there, none to the player.
      assert.equal(lamports(w, earlier), before + rents, `${route}: the rents to whom the records name`);
      assert.ok(lamports(w, next) < mine, `${route}: the player paid, and got none of it`);
      assert.equal(coreOwner(w, nft), w.project, `${route}: the deposit landed`);
      // The listing's address holds only what the new owner made there.
      const there = w.chain.get(listing);
      if (route === 'listForSale') assert.equal(w.read('Listing', listing).maker, next);
      else assert.equal(there, null, `${route}: the earlier listing is closed`);

      // The earlier owner has nothing left that names the NFT: neither record can take it.
      const stale = { project: w.project, asset: nft, maker: earlier, mint: w.mint, deal: { Sell: { price: 100n } } };
      assert.throws(() =>
        w.chain.send(earlier, [
          loot.closeListingIx({ maker: earlier, project: w.project, listing: stale, collection }),
        ]),
      );
      w.chain.warp(w.chain.now() + 3601);
      assert.throws(() =>
        w.chain.send(earlier, [
          loot.releaseIx({
            signer: earlier,
            project: w.project,
            asset: nft,
            collection,
            hold: { player: earlier, payer: earlier, rent_to: earlier, free_at: 0n },
            address: hold,
          }),
        ]),
      );
      assert.equal(coreOwner(w, nft), w.project, `${route}: still the new owner’s`);
    }
  },
);

test(
  'a deposit still refuses what can’t be closed: a leftover listing whose rental runs, unless the player accepts it',
  { skip },
  async () => {
    const { w, controller, collection, mint } = fixture('gone-deposit-rented');
    const [earlier, renter, next] = [w.who(), w.who(), w.who()];
    w.fund(renter, w.mint, 1_000_000n);
    const nft = mint(earlier);
    await appOf(w, earlier).listForRent(nft, { price: '0.0001', lasts: 3600, maxPeriods: 1 });
    const renting = appOf(w, renter);
    await renting.rentListing(nft, { listing: await renting.listing(nft) });
    takeBack(w, controller, collection, nft, next);
    const listing = pda.listing(w.project, nft);

    const app = appOf(w, next);
    await assert.rejects(
      app.hold(nft, 600),
      new RegExp(
        `listing of this NFT \\(${listing}\\) is still open.*left by an earlier owner, ${earlier}.*rented until .*keeps a running rental.*would be lost to you. Nothing was sent.*acceptLeftover: true`,
      ),
    );
    await assert.rejects(
      app.listForSale(nft, { price: 1, acceptLeftover: true }),
      /keeps a running rental.*refuses another listing of this NFT while that one is open/,
    );
    assert.equal(app.calls.prompts, 0, 'nothing signed');
    assert.ok(w.chain.get(listing), 'the rental is kept');

    // Accepted, the deposit goes ahead beside the listing.
    const { freeAt } = await app.hold(nft, 600, { acceptLeftover: true });
    assert.equal(w.read('Hold', pda.hold(nft, freeAt)).player, next);
    assert.ok(w.chain.get(listing));
  },
);

test(
  'a deposit of a Token Metadata NFT clears an earlier owner’s hold on the player’s own token account',
  { skip },
  async () => {
    const { w, maker, club } = tmSetup('gone-deposit-tm');
    const landed = w.watch();
    const [earlier, next] = [w.who(), w.who()];
    const nft = tmNft(w, maker, earlier, club);
    const freeAt = BigInt(w.chain.now() + 3600);
    w.chain.send(earlier, [
      computeUnitLimit(400_000),
      loot.holdIx({
        player: earlier,
        project: w.project,
        asset: nft,
        tokenMetadata: { programmable: false, ruleSet: null },
        freeAt,
      }),
    ]);
    const hold = pda.hold(nft, freeAt);
    assert.equal(takeTokenMetadata(w, nft, next), loot.ata(next, nft));

    const app = appOf(w, next);
    const [rent, before] = [lamports(w, hold), lamports(w, earlier)];
    const { signature, freeAt: until } = await app.hold(nft, 600);
    assert.equal(app.calls.prompts, 1);
    closedGone(w, logged(landed, signature), hold, nft, next);
    assert.equal(lamports(w, earlier), before + rent, 'its rent to the earlier owner who paid it');
    assert.equal(w.chain.tokens(loot.ata(w.project, nft)), 1n, 'the deposit landed');
    assert.equal(w.read('Hold', pda.hold(nft, until)).player, next);
  },
);

test(
  'a deposit of a compressed NFT clears an earlier owner’s hold on one proof of its leaf',
  { skip: skipCompressed },
  async () => {
    const { w, controller, collection, landed } = fixture('gone-deposit-cnft', { compressed: true });
    const tree = cnftTree(w, { maker: controller, collection });
    const [earlier, next] = [w.who(), w.who()];
    const nft = tree.mint(earlier);
    const freeAt = BigInt(w.chain.now() + 3600);
    w.chain.send(earlier, [
      computeUnitLimit(1_400_000),
      ...loot.withLeafCloses([
        loot.proveLeafIx({ signer: earlier, compressed: tree.compressed(nft) }),
        loot.holdIx({ player: earlier, project: w.project, asset: nft, compressed: tree.compressed(nft), freeAt }),
      ]),
    ]);
    tree.moved(nft, w.project);
    const hold = pda.hold(nft, freeAt);
    tree.take(nft, controller, next);

    const app = appOf(w, next, { rpc: tree.rpc });
    const [rent, before] = [lamports(w, hold), lamports(w, earlier)];
    const { signature, freeAt: until } = await app.hold(nft, 600);
    tree.moved(nft, w.project);
    assert.equal(app.calls.prompts, 1, 'one prompt');
    const tx = logged(landed, signature);
    closedGone(w, tx, hold, nft, next);
    assert.ok(names(tx).includes('Held'));
    assert.equal(receipt(tx, 'Held').player, next);
    assert.equal(lamports(w, earlier), before + rent, 'its rent to the earlier owner who paid it');
    assert.equal(w.read('Hold', pda.hold(nft, until)).player, next);
  },
);

// ---------------------------------------------------------------- an order

test(
  'a stash’s NFT a roll won, taken before the settle, is not given: collect says so, beside PrizeForgone and NftGone',
  { skip },
  async () => {
    const { w, controller, collection, mint, landed } = fixture('gone-won');
    const [taken, kept] = [mint(w.authority), mint(w.authority)];
    const stash = asset =>
      w.chain.send(w.authority, [loot.stashIx({ signer: w.authority, project: w.project, id: 1, asset, collection })]);
    const open = nonce => {
      const box = w.read('LootBox', pda.box(w.project, 4));
      w.chain.send(w.player, [
        computeUnitLimit(1_400_000),
        loot.openBoxIx({ player: w.player, project: w.project, box, nonce, items: {}, poolMints: {} }),
      ]);
      return pda.order(w.project, w.player, nonce);
    };
    const app = appOf(w, w.player);
    stash(taken);
    w.upsert({ Box: { id: 4, args: boxArgs(PRICE, [drop([{ Stash: [1] }])]) } });
    // The roll takes the NFT out of the stash for its winner; its controller then takes it out of the project's hands.
    const order = open(1n);
    assert.deepEqual(
      w.read('Order', order).won.map(x => x.Nft?.nft),
      [taken],
    );
    takeBack(w, controller, collection, taken);
    const [treasury, mine] = [w.balance(w.treasury), w.balance(w.player)];
    const got = await app.collect(order);
    assert.equal(w.chain.get(order), null, 'the order settled');
    assert.deepEqual([got.assets, got.asset, got.gone], [[null], undefined, [taken]], 'said not given');
    assert.match(got.says, /no longer holds an NFT of this order.*was not given or sent back/);
    const tx = logged(landed, got.settled);
    assert.deepEqual(
      ['PrizeForgone', 'NftGone', 'OrderSettled'].map(name => names(tx).includes(name)),
      [true, true, true],
      names(tx).join(),
    );
    assert.ok(!names(tx).includes('PrizeGiven'), 'nothing says it was given');
    assert.equal(receipt(tx, 'NftGone').asset, taken);
    assert.equal(receipt(tx, 'PrizeForgone').won.Nft.nft, taken);
    assert.equal(coreOwner(w, taken), controller);
    assert.deepEqual(
      [w.balance(w.treasury), w.balance(w.player)],
      [treasury + PRICE, mine],
      'the payment split as rolled',
    );

    // One the project still holds is given as before.
    stash(kept);
    const next = await app.collect(open(2n));
    assert.deepEqual([next.assets, next.gone], [[kept], undefined]);
    assert.equal(coreOwner(w, kept), w.player);
  },
);

// ---------------------------------------------------------------- the receipt

test('NftGone decodes wherever receipts decode, and is no receipt of a move', { skip }, async () => {
  const { w, controller, collection, mint } = fixture('gone-receipt');
  const nft = mint(w.player);
  const freeAt = BigInt(w.chain.now() + 60);
  w.chain.send(w.player, [loot.holdIx({ player: w.player, project: w.project, asset: nft, collection, freeAt })]);
  takeBack(w, controller, collection, nft);
  const hold = { ...w.read('Hold', pda.hold(nft, freeAt)) };
  const sent = w.chain.send(w.cranker, [
    loot.releaseIx({
      signer: w.cranker,
      project: w.project,
      asset: nft,
      collection,
      hold,
      address: pda.hold(nft, freeAt),
    }),
  ]);
  // From the logs with the transaction's error, and from what getTransaction returns.
  const expected = [
    { name: 'NftGone', data: { project: w.project, record: pda.hold(nft, freeAt), asset: nft, by: w.cranker } },
  ];
  assert.deepEqual(loot.receipts(sent.logs, null), expected);
  assert.deepEqual(loot.receipts({ meta: { err: null, logMessages: sent.logs } }), expected);
  assert.deepEqual(
    loot.receipts(sent.logs, { InstructionError: [0, 'Custom'] }),
    [],
    'a failed transaction gives none',
  );
});
