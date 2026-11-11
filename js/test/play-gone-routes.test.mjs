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
import { KINDS, logged, names, receiptsOf } from './gone-kinds.mjs';

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
