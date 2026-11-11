// The routes that hand out an NFT a record holds, when that NFT is gone from the project (loot 0.27), through js/play
// on the real program: a lottery's pulls, a contest's claims, an auction's end, a raffle's own stash and a project's
// stash. Whoever controls a collection the project does not can take an NFT out of the project's hands, or burn it,
// while a round, a contest, an auction or a stash has it. Where the program reads the NFT's own accounts (a ticket's
// price, an auction's end, a stash) the route finishes without it on the proof. Where it only hands the NFT out (a
// ticket going back, a place's prize, a contest's NFT, a topped bid), the route makes it a hold and the hold closes on
// the proof (`NftGone`) in the same step. Each test runs for a Core asset, a Token Metadata NFT and a compressed NFT
// (`gone-kinds.mjs`), taken and burned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { coreOwner } from './gone-chain.mjs';
import { appOf, KINDS, logged, names, receiptsOf } from './gone-kinds.mjs';
import { collectible } from './world.mjs';

const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
const HOUR = 3600;

/** The transactions that landed since `from` (an index into `landed`). */
const since = (landed, from) => landed.slice(from);
/** Each `NftGone` of `txs` as "record asset by". */
const goneIn = txs => receiptsOf(txs, 'NftGone').map(g => `${g.record} ${g.asset} ${g.by}`);
/** No receipt of `txs` says a held NFT was sent on, went home or was put on a list. */
function nothingMoved(txs, also = []) {
  for (const tx of [txs].flat())
    for (const moved of ['Released', 'Repaid', 'ListingSold', 'Unlisted', 'Stashed', ...also])
      assert.ok(!names(tx).includes(moved), `no ${moved}: ${names(tx)}`);
}

// ---------------------------------------------------------------- a lottery's pulls

/** The owner writes lottery `id`, whose ticket is one NFT that passes `rule`, with what its price does with it. */
const ticketLottery = (w, id, rule, then, more = {}) =>
  w.upsert({
    Lottery: {
      id,
      args: {
        price: 0n,
        mint: w.mint,
        pays_from: { Pot: [0] },
        shares: [],
        places: [],
        ticket_mint: NOBODY,
        every: 0n,
        draws_at: BigInt(w.chain.now() + HOUR),
        gate: null,
        nft_ticket: { rule, then },
        ...more,
      },
    },
  });

/** `app` buys one ticket of `key` with `nft`. */
async function ticket(k, app, key, nft) {
  await app.buyTickets(key, 1, { nft, maxPrice: 0 });
  k.into(nft);
  assert.ok(k.holds(nft), 'the lottery holds the ticket');
  return nft;
}

/** `app` sends the claim of kind `kind` it is offered for lottery `key`; returns the claim and its transaction. */
async function claimOf(k, app, kind, key) {
  const claim = (await app.claims()).find(c => c.kind === kind && c.key === key);
  assert.ok(claim, `no ${kind} of ${key}`);
  return { claim, tx: logged(k.landed, await app.claim(claim)) };
}

for (const kind of KINDS)
  test(
    `a lottery ticket paid with a ${kind.name} NFT that is gone settles with nothing moved, whatever its price does with it`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-ticket');
      const { w } = k;
      const thens = { burns: 'Burn', gives: { Give: [w.treasury] }, stashes: { Stash: [3] } };
      const lotteries = Object.keys(thens).map((key, i) => ({ key, name: key, id: i + 1, pot: 0 }));
      for (const l of lotteries) ticketLottery(w, l.id, k.rule, thens[l.key]);
      const [buyer, other, stranger] = [w.who(), w.who(), w.who()].map(a => k.app(a, { lotteries }));
      const bought = {};
      for (const { key } of lotteries)
        bought[key] = {
          taken: await ticket(k, buyer, key, k.mint(buyer.wallet)),
          burned: await ticket(k, buyer, key, k.mint(buyer.wallet)),
          kept: await ticket(k, buyer, key, k.mint(buyer.wallet)),
          theirs: await ticket(k, other, key, k.mint(other.wallet)),
        };
      w.chain.warp(w.chain.now() + HOUR + 1);
      for (const { key } of lotteries) await claimOf(k, stranger, 'reveal', key);

      for (const { key, id } of lotteries) {
        const { taken, burned, kept, theirs } = bought[key];
        const { address: round } = w.round(id);
        k.lose(taken);
        k.lose(burned, true);
        k.lose(theirs);

        // The buyer is told which of their tickets are gone, and what claiming does, before anything is signed.
        const offered = (await buyer.claims()).find(c => c.kind === 'pull' && c.key === key);
        assert.equal(offered.gone, true);
        assert.deepEqual([...offered.assets].sort(), [taken, burned].sort());
        assert.match(offered.says, /no longer holds.*took it back or burned it.*sends nothing/);
        assert.doesNotMatch(offered.says, /burned, given|was sent|went to/);

        // One claim settles all three: the two gone go nowhere, the third where its price sends it.
        buyer.calls.prompts = 0;
        const tx = logged(k.landed, await buyer.claim(offered));
        // (Three compressed tickets' proofs go in a transaction with a lookup table, made first: more prompts.)
        if (kind.key !== 'compressed') assert.equal(buyer.calls.prompts, 1);
        assert.deepEqual(
          goneIn(tx).sort(),
          [taken, burned].map(nft => `${round} ${nft} ${buyer.wallet}`).sort(),
          `${key}: an NftGone for each ticket gone, the round its record`,
        );
        nothingMoved(tx, ['Held']);
        const pulled = receiptsOf(tx, 'LotteryPulled');
        assert.deepEqual(
          pulled.map(p => [p.buyer, p.part, p.amount]),
          Array(3).fill([buyer.wallet, 'Own', 0n]),
        );
        if (key === 'gives') k.into(kept, w.treasury);
        if (key === 'burns' && kind.key !== 'core') k.into(kept, loot.INCINERATOR);
        k.still(taken);
        k.still(burned);
        assert.equal(
          k.owner(kept),
          { burns: kind.key === 'core' ? null : loot.INCINERATOR, gives: w.treasury, stashes: w.project }[key],
          `${key}: the ticket still there went where its price sends it`,
        );
        const stash = loot.decodeStash(w.chain.get(pda.stash(w.project, 3))?.data ?? null);
        if (key === 'stashes') assert.deepEqual(stash.nfts, [kept], 'only the ticket still there is on the list');
        assert.ok(!(await buyer.claims()).some(c => c.kind === 'pull' && c.key === key), 'nothing left to take');

        // Anyone pays the others: a third wallet settles the other buyer's ticket the same way, and the round closes.
        const paid = await claimOf(k, stranger, 'payout', key);
        assert.deepEqual(goneIn(paid.tx), [`${round} ${theirs} ${stranger.wallet}`]);
        nothingMoved(paid.tx, ['Held']);
        k.still(theirs);
        assert.equal(w.chain.get(round), null, `${key}: the round closed`);
      }
    },
  );

for (const kind of KINDS)
  test(
    `a cancelled round's ${kind.name} NFT ticket that is gone can't come back: its claim makes it a hold and closes the hold on the proof`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-ticket-back');
      const { w } = k;
      const lotteries = [
        { key: 'taken', name: 'Taken', id: 1, pot: 0 },
        { key: 'burned', name: 'Burned', id: 2, pot: 0 },
      ];
      // Each needs three tickets and sells two: its one draw calls it off, and every ticket is owed back.
      for (const l of lotteries) ticketLottery(w, l.id, k.rule, 'Burn', { min_sold: 3n });
      const [buyer, other, stranger] = [w.who(), w.who(), w.who()].map(a => k.app(a, { lotteries }));
      const bought = {};
      for (const { key } of lotteries)
        bought[key] = {
          mine: await ticket(k, buyer, key, k.mint(buyer.wallet)),
          theirs: await ticket(k, other, key, k.mint(other.wallet)),
        };
      w.chain.warp(w.chain.now() + HOUR + 1);

      for (const { key, id } of lotteries) {
        const { mine, theirs } = bought[key];
        k.lose(mine, key === 'burned');
        const hold = pda.hold(mine, 0);
        const before = w.chain.get(buyer.wallet).lamports;
        // The buyer calls the short round off and takes their own part in the same step. (A compressed ticket's proof
        // does not fit beside the cancel in one plain transaction: its pull is the next claim.)
        buyer.calls.prompts = 0;
        const called = await claimOf(k, buyer, 'reveal', key);
        assert.match(called.claim.says, /sold fewer tickets than it needs/);
        const { address: round, round: r } = w.round(id);
        assert.equal(r.status, 'Cancelled');
        const together = kind.key !== 'compressed';
        if (together)
          assert.equal(buyer.calls.prompts, 1, 'one prompt: the cancel, the pull and the close of the hold');
        const tx = together ? called.tx : (await claimOf(k, buyer, 'pull', key)).tx;
        // The round counted the ticket delivered as a hold for its buyer, and the hold closed on the proof at once.
        assert.deepEqual(goneIn(tx), [`${hold} ${mine} ${buyer.wallet}`]);
        assert.equal(receiptsOf(tx, 'Held')[0].player, buyer.wallet);
        nothingMoved(tx);
        assert.equal(w.chain.get(hold), null, 'the hold is closed');
        k.still(mine);
        assert.ok(
          !(await buyer.claims()).some(c => c.asset === mine || (c.kind === 'pull' && c.key === key)),
          'nothing left for the buyer',
        );
        assert.ok(before - w.chain.get(buyer.wallet).lamports < 2_000_000n, 'the hold’s rent came back');

        // The other buyer's ticket, still there, goes home by anyone's payout, and the round closes.
        await claimOf(k, stranger, 'payout', key);
        k.into(theirs, other.wallet);
        assert.equal(k.owner(theirs), other.wallet);
        assert.equal(w.chain.get(round), null, 'the round closed');
      }

      // A ticket found gone only after the round was called off: claims() says so, and its pull closes it the same way.
      ticketLottery(w, 3, k.rule, 'Burn', { min_sold: 3n, draws_at: BigInt(w.chain.now() + HOUR) });
      const late = [...lotteries, { key: 'late', name: 'Late', id: 3, pot: 0 }];
      const [again, crank] = [k.app(buyer.wallet, { lotteries: late }), k.app(stranger.wallet, { lotteries: late })];
      const mine = await ticket(k, again, 'late', k.mint(buyer.wallet));
      w.chain.warp(w.chain.now() + HOUR + 1);
      await claimOf(k, crank, 'reveal', 'late');
      k.lose(mine);
      const offered = (await again.claims()).find(c => c.kind === 'pull' && c.key === 'late');
      assert.deepEqual([offered.gone, offered.assets], [true, [mine]]);
      assert.match(offered.says, /no longer holds.*can’t come back.*sends nothing/);
      const tx = logged(k.landed, await again.claim(offered));
      assert.deepEqual(goneIn(tx), [`${pda.hold(mine, 0)} ${mine} ${buyer.wallet}`]);
      nothingMoved(tx);
      assert.equal(w.chain.get(pda.hold(mine, 0)), null);
      assert.equal(w.round(3), null, 'its last part: the round closed');
    },
  );

for (const kind of KINDS)
  test(
    `a place's ${kind.name} NFT that is gone is not given: the pull makes it a hold, and the hold closes on the proof`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-place');
      const { w } = k;
      const lotteries = [
        { key: 'raffle', name: 'Raffle', id: 1 },
        { key: 'named', name: 'Named', id: 2 },
      ];
      const [owner, winner, stranger] = [w.creator, w.player, w.who()].map(a => k.app(a, { lotteries }));
      // A raffle of the owner's NFT, out of the lottery's own stash; and a lottery whose one place gives a named NFT
      // of a project stash.
      const [art, trophy] = [k.mint(w.creator), k.mint(w.authority)];
      const drawsAt = w.chain.now() + HOUR;
      await owner.raffle(1, art, { price: '0.0001', drawsAt });
      k.into(art);
      k.send(w.authority, trophy, piece =>
        loot.stashIx({ signer: w.authority, project: w.project, id: 5, asset: trophy, ...piece }),
      );
      k.into(trophy);
      w.upsert({
        Lottery: {
          id: 2,
          args: {
            price: 100n,
            mint: w.mint,
            pays_from: { Round: { rest: 'Treasury' } },
            shares: [],
            places: [{ bps: 0, prize: { Nft: { stash: 5, nft: trophy } } }],
            ticket_mint: NOBODY,
            every: 0n,
            draws_at: BigInt(drawsAt),
            gate: null,
          },
        },
      });
      for (const { key } of lotteries)
        await winner.buyTickets(key, 1, { listing: (await winner.lotteries()).find(l => l.key === key) });
      w.chain.warp(drawsAt + 1);
      for (const { key } of lotteries) await claimOf(k, stranger, 'reveal', key);
      assert.ok(k.holds(art) && k.holds(trophy));

      // The raffled NFT is taken before its winner pulls: the winner is told, and their claim closes the place.
      k.lose(art);
      const offered = (await winner.claims()).find(c => c.kind === 'pull' && c.key === 'raffle');
      assert.deepEqual([offered.gone, offered.assets], [true, [art]]);
      assert.match(offered.says, /no longer holds an NFT you won.*can’t be given.*sends nothing/);
      const round = w.round(1).address;
      const tx = logged(k.landed, await winner.claim(offered));
      assert.deepEqual(goneIn(tx), [`${pda.hold(art, 0)} ${art} ${winner.wallet}`]);
      nothingMoved(tx);
      // The round counts a prize it makes a hold as delivered (the program's `Held` and `PrizeGiven`, as for any NFT
      // that can't move now); the hold then closes on the proof, and nothing says it was sent on.
      assert.deepEqual(
        names(tx).filter(n => n !== 'LotteryPulled' && n !== 'RoundClosed'),
        ['Held', 'PrizeGiven', 'NftGone'],
      );
      assert.equal(w.chain.get(pda.hold(art, 0)), null, 'the hold the pull made is closed');
      k.still(art);
      assert.deepEqual(loot.decodeStash(w.chain.get(pda.lotteryStash(pda.lottery(w.project, 1))).data).nfts, []);
      assert.ok(!(await winner.claims()).some(c => c.kind === 'pull' && c.key === 'raffle'), 'nothing left to take');
      // What the round still owes (the ticket money, in common) is anyone's to pay, and it closes.
      await claimOf(k, stranger, 'payout', 'raffle');
      assert.equal(w.chain.get(round), null, 'the raffle’s round closed');

      // The named NFT is burned: a third wallet's payout closes that place the same way, and the round closes.
      k.lose(trophy, true);
      const theirs = (await winner.claims()).find(c => c.kind === 'pull' && c.key === 'named');
      assert.deepEqual([theirs.gone, theirs.assets], [true, [trophy]]);
      const named = w.round(2).address;
      const sent = k.landed.length;
      for (let n = 0; n < 3 && w.chain.get(named); n++) await claimOf(k, stranger, 'payout', 'named');
      const paid = since(k.landed, sent);
      assert.deepEqual(goneIn(paid), [`${pda.hold(trophy, 0)} ${trophy} ${stranger.wallet}`]);
      nothingMoved(paid);
      assert.equal(w.chain.get(pda.hold(trophy, 0)), null);
      k.still(trophy);
      assert.deepEqual(loot.decodeStash(w.chain.get(pda.stash(w.project, 5)).data).nfts, [], 'off the stash’s list');
      assert.equal(w.chain.get(named), null, 'the round closed');
    },
  );

// ---------------------------------------------------------------- a contest's claims

/** The authority opens contest `id` of NFTs that pass `rule`: two sides, entries for 100 seconds, a result within 200. */
function nftContest(w, id, rule, more = {}) {
  const now = w.chain.now();
  w.chain.send(w.authority, [
    loot.openContestIx({
      authority: w.authority,
      project: w.project,
      projectState: w.projectState(),
      id,
      mint: w.mint,
      args: {
        sides: 2,
        closes_at: BigInt(now + 100),
        result_by: BigInt(now + 200),
        shares: [],
        gate: null,
        nft: rule,
        ...more,
      },
    }),
  ]);
}

/** `app` enters contest `id` on `side` with a new NFT of its own; returns the NFT. */
async function entered(k, app, id, side) {
  const nft = k.mint(app.wallet);
  await app.enter(id, side, 0, { nft });
  k.into(nft);
  assert.ok(k.holds(nft), 'the contest holds the NFT');
  return nft;
}

/** The authority names `side` the winner of contest `id`. */
const decided = (w, id, side) =>
  w.chain.send(w.authority, [
    loot.decideIx({
      signer: w.authority,
      project: w.project,
      contest: w.read('Contest', pda.contest(w.project, id)),
      side,
    }),
  ]);

/** `app` sends every claim it is offered for contest `id` (a compressed NFT moves one a claim); returns the
 * transactions and the first claim offered. */
async function claimContest(k, app, id, options) {
  const from = k.landed.length;
  let first = null;
  for (let n = 0; n < 4; n++) {
    const claim = (await app.claims()).find(c => c.kind === 'contest' && c.id === id);
    if (!claim) break;
    first ??= claim;
    await app.claim(claim, options);
  }
  return { first, txs: since(k.landed, from) };
}

for (const kind of KINDS)
  test(
    `a contest called off: an entry's ${kind.name} NFT that is gone can't come back, and its claim closes it on the proof`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-contest-off');
      const { w } = k;
      const [p, q] = [w.who(), w.who()].map(a => k.app(a));
      for (const [id, burned] of [
        [1, false],
        [2, true],
      ]) {
        nftContest(w, id, k.rule);
        const [mine, theirs] = [await entered(k, p, id, 0), await entered(k, q, id, 1)];
        // Nobody names a winner by the time a result is due: the contest is off, and every entry takes its own back.
        w.chain.warp(w.chain.now() + 201);
        k.lose(mine, burned);
        const hold = pda.hold(mine, 0);
        const { first, txs } = await claimContest(k, p, id);
        assert.deepEqual([first.gone, first.assets], [true, [mine]]);
        assert.match(first.says, /contest is off.*no longer holds the NFT you entered.*can’t come back.*sends nothing/);
        assert.doesNotMatch(first.says, /Your entry back|Your NFT back/);
        // (A compressed NFT's proof makes the claim a transaction with a lookup table, made first.)
        if (kind.key !== 'compressed') assert.equal(txs.length, 1);
        // The contest counts the NFT delivered as a hold for its player; the hold closes on the proof at once.
        assert.deepEqual(goneIn(txs), [`${hold} ${mine} ${p.wallet}`]);
        assert.deepEqual(names(txs.at(-1)), ['Held', 'Claimed', 'NftGone']);
        nothingMoved(txs);
        assert.equal(w.chain.get(hold), null, 'the hold is closed');
        assert.equal(w.entries(id)[w.entryOf(id, p.wallet)].amount, 0n, 'the entry is claimed');
        k.still(mine);

        // The other entry's NFT, still there, goes home as before, and the contest closes.
        const other = await claimContest(k, q, id);
        assert.equal(other.first.gone, undefined);
        assert.match(other.first.says, /Your entry back/);
        k.into(theirs, q.wallet);
        assert.equal(k.owner(theirs), q.wallet);
        assert.equal(w.chain.get(pda.contest(w.project, id)), null, 'the contest closed');
      }
    },
  );

for (const kind of KINDS)
  test(
    `a contest won: the winner's own ${kind.name} NFT that is gone, and a loser's, close on the proof; a pick goes to one still there first`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-contest-won');
      const { w } = k;
      const [p, q, s] = [w.who(), w.who(), w.who()].map(a => k.app(a));
      const closedOn = (txs, nft) => {
        assert.ok(goneIn(txs).includes(`${pda.hold(nft, 0)} ${nft} ${p.wallet}`), `NftGone for ${nft}`);
        assert.equal(w.chain.get(pda.hold(nft, 0)), null, 'its hold is closed');
      };

      // The winner's own NFT is taken: their claim closes it and takes the loser's, which is still there.
      nftContest(w, 1, k.rule);
      const [mine, theirs] = [await entered(k, p, 1, 0), await entered(k, q, 1, 1)];
      // The loser's NFT is burned: the winner's claim takes its own back and closes the loser's.
      nftContest(w, 2, k.rule);
      const [kept, burned] = [await entered(k, p, 2, 0), await entered(k, q, 2, 1)];
      // Two losers, and a share of one: the winner's pick goes to the NFT still there, not to the one gone.
      nftContest(w, 3, k.rule, { cap: 1 });
      const [own, lost, there] = [await entered(k, p, 3, 0), await entered(k, q, 3, 1), await entered(k, s, 3, 1)];
      w.chain.warp(w.chain.now() + 150);
      for (const id of [1, 2, 3]) decided(w, id, 0);

      k.lose(mine);
      const one = await claimContest(k, p, 1);
      assert.deepEqual([one.first.gone, one.first.assets], [true, [mine]]);
      assert.match(one.first.says, /^Your pick of the losers’\. The project no longer holds the NFT you entered/);
      closedOn(one.txs, mine);
      nothingMoved(one.txs);
      k.into(theirs, p.wallet);
      k.still(mine);
      assert.equal(k.owner(theirs), p.wallet, 'the loser’s NFT went to the winner');
      assert.equal(w.chain.get(pda.contest(w.project, 1)), null, 'the contest closed');

      k.lose(burned, true);
      const two = await claimContest(k, p, 2);
      assert.deepEqual([two.first.gone, two.first.assets], [true, [burned]]);
      assert.match(two.first.says, /^Your NFT back\. The project no longer holds the loser’s NFT left.*takes nothing/);
      closedOn(two.txs, burned);
      nothingMoved(two.txs);
      k.into(kept, p.wallet);
      k.still(burned);
      assert.equal(k.owner(kept), p.wallet, 'the winner’s own NFT came back');
      assert.equal(w.chain.get(pda.contest(w.project, 2)), null, 'the contest closed');

      k.lose(lost);
      const three = await claimContest(k, p, 3);
      assert.equal(three.first.gone, undefined, 'nothing this claim moves is gone');
      assert.match(three.first.says, /^Your NFT back, and your pick of the losers’\.$/);
      assert.deepEqual(goneIn(three.txs), []);
      k.into(own, p.wallet);
      k.into(there, p.wallet);
      assert.deepEqual([k.owner(own), k.owner(there)], [p.wallet, p.wallet], 'the pick took the NFT still there');
      // The one gone is left: the winner has no pick left, and it is the opener's to close.
      const entry = w.entries(3)[w.entryOf(3, q.wallet)];
      assert.deepEqual([entry.nft, entry.amount], [lost, 1n]);
    },
  );

// ---------------------------------------------------------------- an auction's end

/** `seller` puts their NFT `lot` up as auction `id` for ten minutes: bids in the project's coin, or (`nftBids`: a
 * rule) in NFTs. */
function sale(k, seller, id, lot, nftBids = null) {
  const { w } = k;
  const now = w.chain.now();
  k.send(seller, lot, piece =>
    loot.openAuctionIx({
      seller,
      project: w.project,
      id,
      mint: w.mint,
      ...piece,
      args: {
        lot: { Asset: [lot] },
        reserve: 1n,
        min_raise_bps: 0,
        starts_at: BigInt(now),
        ends_at: BigInt(now + 600),
        extend: 0,
        shares: [],
        gate: null,
        nft_bids: nftBids,
      },
    }),
  );
  k.into(lot);
  return pda.auction(w.project, seller, id);
}

for (const kind of KINDS)
  test(
    `an auction whose ${kind.name} lot is gone: with no bid it closes and nothing goes home; sold, anyone's end calls it off and the bid goes back`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-lot');
      const { w } = k;
      const seller = w.who();
      const auctions = [1, 2, 3, 4].map(id => ({ key: `a${id}`, name: `Lot ${id}`, id, seller }));
      const [sellers, bidder, stranger] = [seller, w.player, w.who()].map(a => k.app(a, { auctions }));
      const lots = auctions.map(() => k.mint(seller));
      const at = auctions.map((a, i) => sale(k, seller, a.id, lots[i]));
      for (const key of ['a3', 'a4']) await bidder.bid(key, '0.0005');
      const paid = w.balance(w.player);
      w.chain.warp(w.chain.now() + 601);
      assert.match((await sellers.claims()).find(c => c.key === 'a1').says, /ended with no bid: take your lot back/);

      for (const [i, burned] of [false, true, false, true].entries()) k.lose(lots[i], burned);
      // The seller and the winner are told before anything is signed.
      const mine = (await sellers.claims()).filter(c => c.kind === 'auction');
      for (const c of mine) assert.equal(c.gone, true, c.key);
      assert.match(mine[0].says, /no longer holds its lot.*no bid.*nothing comes back.*closes the auction/);
      assert.match(mine[2].says, /no longer holds its lot.*called off.*bid goes back.*paid nothing/);
      const won = (await bidder.claims()).filter(c => c.kind === 'auction');
      assert.deepEqual(
        won.map(c => [c.key, c.gone]),
        [
          ['a3', true],
          ['a4', true],
        ],
      );
      assert.match(won[0].says, /no longer holds its lot.*called off.*your bid comes back/);
      for (const c of [...mine, ...won]) assert.doesNotMatch(c.says, /take your lot back|take it\.$|is paid to you/);

      // No bid: anyone ends it. The auction closes, its rent to its seller, and no lot goes home.
      for (const i of [0, 1]) {
        const [rent, before] = [w.chain.get(at[i]).lamports, w.chain.get(seller).lamports];
        const ended = await stranger.endAuction(auctions[i].key);
        assert.equal(ended.gone, true);
        assert.match(ended.says, /no longer holds the lot.*Nothing went home/);
        const tx = logged(k.landed, ended.signature);
        assert.deepEqual(
          receiptsOf(tx, 'AuctionEnded').map(e => [e.winner, e.asset]),
          [[null, NOBODY]],
        );
        nothingMoved(tx, ['Held']);
        assert.equal(w.chain.get(at[i]), null, 'the auction closed');
        assert.equal(w.chain.get(seller).lamports, before + rent, 'its rent to its seller');
        k.still(lots[i]);
      }
      // Sold: anyone's end calls the sale off on the evidence. The bid goes back whole, and no lot goes home.
      for (const i of [2, 3]) {
        const ended = await stranger.endAuction(auctions[i].key);
        assert.deepEqual([ended.calledOff, ended.gone], [true, true]);
        assert.match(ended.says, /no longer holds the lot.*bid went back/);
        const [off] = receiptsOf(logged(k.landed, ended.signature), 'SaleCalledOff');
        assert.deepEqual(
          [off.bidder, off.back, off.home, off.gone, off.by],
          [w.player, 500n, false, true, stranger.wallet],
        );
        nothingMoved(logged(k.landed, ended.signature), ['Held', 'AuctionEnded']);
        assert.equal(w.chain.get(at[i]), null, 'the auction closed');
        k.still(lots[i]);
      }
      assert.equal(w.balance(w.player), paid + 1_000n, 'both bids came back');
      assert.ok(!(await sellers.claims()).some(c => c.kind === 'auction'));
    },
  );

// A bid of NFTs is never a compressed NFT (the program refuses one), so these run for the two kinds a bid can be.
for (const kind of KINDS.filter(k => k.key !== 'compressed'))
  test(
    `an auction's winning bid of ${kind.name} NFTs, one of them gone: a player's lot is called off, the project's lot and a lot sent first are paid without it`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-bid');
      const { w } = k;
      const seller = w.who();
      w.upsert({ Item: { id: 1, args: collectible('Painting') } });
      w.upsert({ Item: { id: 2, args: { ...collectible('Potion'), kind: 'Normal' } } });
      const auctions = [
        { key: 'players', name: 'A player’s lot', id: 1, seller },
        { key: 'projects', name: 'The project’s lot', id: 2, seller: w.authority },
        { key: 'first', name: 'A lot sent first', id: 3, seller },
      ];
      const [sellers, bidder, stranger] = [seller, w.who(), w.who()].map(a => k.app(a, { auctions }));
      const now = w.chain.now();
      const args = lot => ({
        lot,
        reserve: 1n,
        min_raise_bps: 0,
        starts_at: BigInt(now),
        ends_at: BigInt(now + 600),
        extend: 0,
        shares: [],
        gate: null,
        nft_bids: k.rule,
      });
      const open = (who, id, lot) =>
        w.chain.send(who, [
          loot.openAuctionIx({
            seller: who,
            project: w.project,
            collection: w.collection,
            id,
            mint: w.mint,
            args: args(lot),
          }),
        ]);
      const lots = { players: w.make(1, seller), first: w.make(1, seller) };
      open(seller, 1, { Asset: [lots.players] });
      open(w.authority, 2, { Item: [2] });
      open(seller, 3, { Asset: [lots.first] });
      const bids = {};
      for (const { key } of auctions) {
        bids[key] = [k.mint(bidder.wallet), k.mint(bidder.wallet)];
        await bidder.bid(key, null, { nfts: bids[key] });
      }
      w.chain.warp(now + 601);
      const at = id => pda.auction(w.project, id === 2 ? w.authority : seller, id);

      // A player's lot: the two sides move together or not at all, so anyone's end calls the sale off.
      {
        const [lost, kept] = bids.players;
        k.lose(lost);
        const told = (await bidder.claims()).find(c => c.key === 'players');
        assert.deepEqual([told.gone, told.assets], [true, [lost]]);
        assert.match(told.says, /no longer holds an NFT of your bid.*called off.*lot goes home to its seller/);
        assert.match((await sellers.claims()).find(c => c.key === 'players').says, /lot goes home to you/);
        const ended = await stranger.endAuction('players');
        assert.deepEqual([ended.calledOff, ended.gone], [true, true]);
        assert.match(ended.says, /no longer holds an NFT of the winning bid.*lot went home.*rest of the bid went back/);
        const tx = logged(k.landed, ended.signature);
        const [off] = receiptsOf(tx, 'SaleCalledOff');
        assert.deepEqual([off.back, off.home, off.gone, off.by], [1n, true, true, stranger.wallet]);
        nothingMoved(tx, ['Held', 'AuctionEnded']);
        assert.deepEqual([k.owner(kept), coreOwner(w, lots.players)], [bidder.wallet, seller]);
        k.still(lost);
        assert.equal(w.chain.get(at(1)), null, 'the auction closed');
      }

      // The project's own lot: the end passes the NFT that is gone over, and pays the rest.
      {
        const [lost, kept] = bids.projects;
        k.lose(lost, true);
        const told = (await bidder.claims()).find(c => c.key === 'projects');
        assert.deepEqual([told.gone, told.assets], [true, [lost]]);
        assert.match(
          told.says,
          /no longer holds an NFT of your bid.*gives the lot to you.*nothing is paid for the one gone/,
        );
        const ended = await stranger.endAuction('projects');
        assert.deepEqual([ended.winner, ended.calledOff, ended.gone], [bidder.wallet, undefined, true]);
        assert.match(ended.says, /Nothing was paid for it: the lot went to its winner/);
        const tx = logged(k.landed, ended.signature);
        assert.equal(receiptsOf(tx, 'AuctionEnded')[0].winner, bidder.wallet);
        nothingMoved(tx, ['Held', 'SaleCalledOff']);
        assert.equal(k.owner(kept), w.treasury, 'the NFT still there went to the treasury');
        k.still(lost);
        assert.equal(w.chain.get(at(2)), null, 'the auction closed');
      }

      // A lot sent first: the winner has it, and an NFT of the bid goes before the second end pays the seller.
      {
        const [lost, kept] = bids.first;
        w.chain.send(w.cranker, [
          loot.endAuctionIx({
            signer: w.cranker,
            project: w.project,
            projectState: w.projectState(),
            id: 3,
            auction: w.read('Auction', at(3)),
            collection: w.collection,
            ending: 'LotFirst',
          }),
        ]);
        assert.equal(coreOwner(w, lots.first), bidder.wallet, 'the lot went first');
        k.lose(lost);
        const told = (await sellers.claims()).find(c => c.key === 'first');
        assert.deepEqual([told.gone, told.assets], [true, [lost]]);
        assert.match(told.says, /winner of .* has the lot.*pays you the rest of the bid, and nothing for the one gone/);
        const ended = await stranger.endAuction('first');
        assert.equal(ended.gone, true);
        assert.match(ended.says, /Nothing was paid for it: the rest of the bid was paid to the seller/);
        const tx = logged(k.landed, ended.paid);
        nothingMoved(tx, ['Held', 'SaleCalledOff']);
        assert.equal(k.owner(kept), seller, 'the NFT still there was paid to the seller');
        k.still(lost);
        assert.equal(w.chain.get(at(3)), null, 'the auction closed');
      }
    },
  );

for (const kind of KINDS.filter(k => k.key !== 'compressed'))
  test(
    `a high bid of ${kind.name} NFTs, one of them gone, is still topped: the one gone is made a hold that closes on the proof`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-topped');
      const { w } = k;
      const seller = w.who();
      w.upsert({ Item: { id: 1, args: collectible('Painting') } });
      const lot = w.make(1, seller);
      const auctions = [{ key: 'lot', name: 'Lot', id: 1, seller }];
      const now = w.chain.now();
      w.chain.send(seller, [
        loot.openAuctionIx({
          seller,
          project: w.project,
          collection: w.collection,
          id: 1,
          mint: w.mint,
          args: {
            lot: { Asset: [lot] },
            reserve: 1n,
            min_raise_bps: 0,
            starts_at: BigInt(now),
            ends_at: BigInt(now + 600),
            extend: 0,
            shares: [],
            gate: null,
            nft_bids: k.rule,
          },
        }),
      ]);
      const [first, second] = [w.who(), w.who()].map(a => k.app(a, { auctions }));
      const [lost, kept] = [k.mint(first.wallet), k.mint(first.wallet)];
      await first.bid('lot', null, { nfts: [lost, kept] });
      k.lose(lost);

      const mine = [k.mint(second.wallet), k.mint(second.wallet), k.mint(second.wallet)];
      second.calls.prompts = 0;
      const tx = logged(k.landed, await second.bid('lot', null, { nfts: mine }));
      // (Five Token Metadata NFTs' accounts need a lookup table, made first: more prompts.)
      if (kind.key === 'core') assert.equal(second.calls.prompts, 1);
      assert.equal(w.read('Auction', pda.auction(w.project, seller, 1)).high_bidder, second.wallet, 'the bid landed');
      assert.deepEqual(goneIn(tx), [`${pda.hold(lost, 0)} ${lost} ${second.wallet}`]);
      nothingMoved(tx);
      assert.equal(w.chain.get(pda.hold(lost, 0)), null, 'the hold is closed');
      assert.equal(k.owner(kept), first.wallet, 'the NFT still there went back to its bidder');
      k.still(lost);
    },
  );

for (const kind of KINDS)
  test(
    `a ${kind.name} lot made a hold at its auction's end and gone before its release: the release closes the hold on the proof`,
    { skip: kind.skip },
    async () => {
      const k = kind.make('gone-held-lot');
      const { w } = k;
      const seller = w.who();
      const lot = k.mint(seller);
      const auctions = [{ key: 'lot', name: 'Lot', id: 1, seller }];
      const at = sale(k, seller, 1, lot);
      w.chain.warp(w.chain.now() + 601);
      const hold = pda.hold(lot, 0);
      // The lot can't move when the end is tried (its dry run fails, as a frozen NFT's does), so the end makes it a
      // hold for its seller. Its controller takes it as soon as that lands, before the release.
      let [tries, taken] = [0, false];
      const rpc = {
        ...k.rpc,
        async simulate(...args) {
          if (tries++ === 0) throw Object.assign(new Error('The NFT is frozen.'), { logs: [] });
          return k.rpc.simulate(...args);
        },
        async send(wire) {
          const signature = await k.rpc.send(wire);
          if (!taken && w.chain.get(hold)) {
            taken = true;
            k.lose(lot);
          }
          return signature;
        },
      };
      const ended = await appOf(w, w.who(), { rpc, spec: { auctions } }).endAuction('lot');
      assert.equal(taken, true, 'the end made the hold');
      assert.equal(w.chain.get(at), null, 'the auction closed');
      assert.equal(ended.releases.length, 1);
      const [release] = ended.releases;
      assert.deepEqual([release.asset, release.gone], [lot, true]);
      const tx = logged(k.landed, release.closed);
      assert.deepEqual(
        receiptsOf(tx, 'NftGone').map(g => [g.record, g.asset]),
        [[hold, lot]],
      );
      nothingMoved(tx);
      assert.equal(w.chain.get(hold), null, 'the hold is closed');
      k.still(lot);
    },
  );
