// Auctions, for the page client (solanaApp): the auctions and their bids, a bid, and the end that pays the seller and
// gives the lot (or calls a sale off).
import { associatedTokenAddress, COMPUTE_BUDGET_PROGRAM, NATIVE_MINT, TOKEN_PROGRAM } from '../chain/pda.js';
import {
  computeUnitLimit,
  createAssociatedTokenAccountIdempotent,
  syncNative,
  transferLamports,
} from '../chain/programs.js';
import { sendPlan } from '../chain/lookup.js';
import { SIGNATURE_LAMPORTS } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { isProveLeaf, MPL_CORE, NO_OPTIONS, only, show, units } from './common.js';

/**
 * Puts on `ctx` an auction's address and its end. Returns `ctx`.
 * @param {ReturnType<typeof import('./lotteries.js').addLotteries>} ctx
 */
export function addAuctions(ctx) {
  const {
    wallet,
    programs,
    client,
    project,
    jobKey,
    read,
    collectionOf,
    heldNow,
    leaving,
    projectNow,
    send,
    sendAs,
    keyFor,
    dryRun,
    emptyKey,
    sendRolling,
    holdersOf,
    hookTail,
  } = ctx;

  /** A spec auction's address: it names the seller, which xsolana.json records once it is live. */
  const auctionAt = a => {
    if (!a.seller) throw new Error(`The auction “${a.key}” has no seller in xsolana.json: publish the economy again.`);
    return loot.pda.auction(project, a.seller, a.id);
  };

  /**
   * An auction's end, as `endAuction` and `callOffSale` send it (`a`: the auction's part of the spec). Each step is
   * checked before the wallet signs: a dry run when it is one legacy transaction, the size otherwise.

   * @param {any} a
   * @param {{ holders?: any, callOff?: boolean }} [options]
   */
  async function endSale(a, { holders, callOff = false } = {}) {
    const at = auctionAt(a);
    let auction = await read('Auction', at);
    const g = await projectNow();
    // What a transfer of the bids' coin carries: the Memo program for Token-2022, and a transfer hook's accounts.
    const memo = await hookTail([auction.mint]);
    const sold = auction.high > 0n;
    const lot = auction.lot.Asset?.[0] ?? null;
    const owner = lot ? auction.seller : g.treasury;
    // The bids' coin's token program, read from the mint when the app wasn't told it.
    const coin = programs[auction.mint] ?? (await client.account(auction.mint))?.owner ?? TOKEN_PROGRAM;
    const base = {
      signer: wallet.address,
      project,
      projectState: g,
      id: a.id,
      programs: { ...programs, [auction.mint]: coin },
      extra: memo,
    };
    if (callOff && (!sold || !lot))
      throw new Error('Only the sale of an NFT lot that has a bid is called off: end this auction with endAuction.');
    // The lot went at an earlier end: this one pays what the bid still owes and closes the auction.
    if (BigInt(auction.proceeds_owed) > 0n) {
      if (callOff)
        throw new Error(
          'The lot went to its winner already: the sale stands (CantCallOff). End it to pay what it owes.',
        );
      return { ...(await payOwed(a, auction, base, holders)), owedPaid: auction.proceeds_owed };
    }
    const item = auction.lot.Item ? await read('Item', loot.pda.item(project, auction.lot.Item[0])) : null;
    const made =
      sold && item?.kind === 'Collectible'
        ? loot.pda.itemAsset(loot.pda.item(project, auction.lot.Item[0]), auction.pin)
        : null;
    // Gone (taken back or burned by whoever controls its collection): the lot, or an NFT of the winning bid.
    const lotNow = lot ? await heldNow(lot) : { held: null };
    const bidNow = [];
    if (sold && auction.nft_bids) for (const nft of auction.held) bidNow.push(await heldNow(nft));
    const lostBids = sold && auction.nft_bids ? auction.held.filter((_, i) => bidNow[i].held === false) : [];
    const gone = lotNow.held === false || lostBids.length > 0;
    const ending = sold && lot && (callOff || gone) ? 'CallOff' : 'Deliver';
    const home = !sold || ending === 'CallOff';
    // The lot to its winner, or home to its seller; a bid's NFTs to whoever owned the lot, or back to their bidder.
    // One that is gone is not sent: its accounts only show the end that the project no longer holds it.
    const before = [];
    const lotKind = lot ? await kindFor(lot, home ? auction.seller : auction.high_bidder, lotNow, before) : {};
    const bidTo = ending === 'CallOff' ? auction.high_bidder : owner;
    const held = [];
    if (sold && auction.nft_bids)
      for (const [i, nft] of auction.held.entries()) held.push(await kindFor(nft, bidTo, bidNow[i], before));
    if (sold && !home) holders ??= await holdersOf(auction.shares);
    const end = (ending, hold = false) =>
      loot.endAuctionIx({ ...base, auction, item, ...lotKind, held, holders, ending, hold });
    const steps = ix => [
      computeUnitLimit(1_000_000),
      ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ix,
    ];
    const fits = ix => Boolean(sendPlan({ payer: wallet.address, instructions: steps(ix), alone: isProveLeaf }));
    const result = {
      ...(sold && ending === 'Deliver' ? { winner: auction.high_bidder } : {}),
      ...(made ? { asset: made } : {}),
    };
    if (ending === 'CallOff') Object.assign(result, { calledOff: true, gone });
    // What the end did about an NFT that is gone, in words: nothing here says it moved.
    if (gone) {
      const which =
        lotNow.held === false
          ? `the lot (${lot})`
          : `${lostBids.length === 1 ? 'an NFT' : 'NFTs'} of the winning bid (${lostBids.join(', ')})`;
      const did = !sold
        ? 'Nothing went home: the auction is closed, and its rent went back to its seller.'
        : ending === 'Deliver'
          ? 'Nothing was paid for it: the lot went to its winner, and the rest of the bid was paid.'
          : lotNow.held === false
            ? `The sale was called off: ${auction.nft_bids ? 'the NFTs of the winning bid the project still held' : 'the winning bid'} went back to its bidder, and nothing went home to the seller.`
            : 'The sale was called off: the lot went home to its seller, and the rest of the bid went back to its bidder.';
      Object.assign(result, {
        gone: true,
        says: `The project no longer holds ${which}: whoever controls its collection took it back or burned it while the auction held it. ${did}`,
      });
    }

    // An end that may make holds: a lot going home, a bid's NFTs going back or to the treasury for the project's lot.
    const outs = [
      ...(lot && home && lotNow.held !== false ? [[lot, auction.seller]] : []),
      ...(sold && auction.nft_bids && (home || !lot)
        ? auction.held.filter((_, i) => bidNow[i].held !== false).map(x => [x, bidTo])
        : []),
    ];
    const holding = async () => ({
      ...(await heldThenReleased(
        at,
        steps(
          end(
            ending,
            outs.map(([x]) => x),
          ),
        ),
        outs,
      )),
      ...result,
    });
    if (fits(end(ending))) {
      if (await stuck(steps(end(ending)))) {
        // What can't move now goes home or back as a hold, sent on once it can; a sold lot waits instead.
        if (outs.length) return holding();
        return {
          waiting: true,
          says: 'The lot can’t move to its winner now (its collection froze it, or refuses the move): the sale waits, the winning bid in the project’s vault. End it again later; the project’s keys can call it off (callOffSale), and if the lot is taken back or burned anyone can.',
        };
      }
      // A roll lot sold: the winner's roll, made at the default nonce, waits for its winner or the project's keys to ask it
      // (`collect`); the winner ending it asks in the same transaction and a key settles it.
      const roll =
        sold && auction.lot.Roll
          ? loot.pda.order(
              project,
              auction.high_bidder,
              loot.prizeRollNonce(loot.prizeNonce(at, BigInt(auction.last_bid_at))),
            )
          : null;
      const { signature, rolls } =
        roll && auction.high_bidder === wallet.address
          ? await sendRolling(steps(end(ending)))
          : { signature: await send(steps(end(ending))), rolls: [] };
      return {
        signature,
        ...result,
        ...(roll ? { order: roll } : {}),
        ...(rolls.length ? { rolled: rolls[0] } : {}),
      };
    }
    // Too wide for one transaction. A sold NFT lot goes first, and a second end pays the bid.
    if (sold && lot && ending === 'Deliver') {
      const first = steps(end('LotFirst'));
      if (await stuck(first))
        return {
          waiting: true,
          says: 'The lot can’t move to its winner now (its collection froze it, or refuses the move): the sale waits, the winning bid in the project’s vault. End it again later; the project’s keys can call it off (callOffSale).',
        };
      const signature = await send(first);
      auction = await read('Auction', at);
      return { signature, ...result, lotFirst: true, ...(await payOwed(a, auction, base, holders)) };
    }
    // Otherwise each NFT that may be a hold becomes one, and is sent on with a release after.
    return holding();
  }

  /** An NFT's kind on an auction's end, going to `to`: what `nftOf` reads, its proof put in `before`. `now`: what
   * `heldNow` read of it; one that is gone carries what shows it instead (a Token Metadata NFT's account that holds it
   * now, or its mint; a compressed NFT's leaf as it is now), and is sent nowhere. */
  async function kindFor(asset, to, now, before) {
    const { before: proof, hasAuthority: _h, gone: _g, ...kind } = await leaving(asset, wallet.address, { to, now });
    before.push(...proof);
    return {
      ...kind,
      collection: kind.compressed || kind.tokenMetadata ? undefined : ((await collectionOf(asset)) ?? MPL_CORE),
    };
  }

  /**
   * Whether an end can't move an NFT now: dry-run as the wallet would send it (one legacy transaction; a bigger one is
   * sent as it is, and counts as one that can). A refusal of loot's is said in words; a failure in the NFT's own program
   * (it is frozen, or its collection refuses the move) is one that is stuck: true, and nothing is sent.
   */
  async function stuck(instructions) {
    const plan = sendPlan({ payer: wallet.address, instructions, alone: isProveLeaf });
    if (!plan?.legacy) return false;
    const tried = await dryRun(wallet.address, instructions);
    if (tried.ok) return false;
    if (tried.error) throw Object.assign(new Error(`${tried.error.msg} (${tried.error.name}).`), tried.error);
    return true;
  }

  /**
   * After an NFT lot went first: the end that pays what the bid still owes and closes the auction. The accounts its
   * money goes into (each share's wallet and the seller's) are opened first, in a transaction of their own when any is
   * missing: the end itself can make up to 64 calls. A bid's NFTs go to the seller, made holds and released after when
   * they don't all fit. Returns { paid } (its signature), and `releases`.
   */
  async function payOwed(a, auction, base, holders) {
    const at = auctionAt(a);
    holders ??= await holdersOf(auction.shares);
    const opens = [];
    if (!auction.nft_bids) {
      const payees = [
        auction.seller,
        ...auction.shares.flatMap(sh =>
          sh.to.Wallet
            ? [sh.to.Wallet[0]]
            : sh.to.Holder
              ? [holders[sh.to.Holder[0]]]
              : sh.to === 'Treasury'
                ? [base.projectState.treasury]
                : [],
        ),
      ].filter(Boolean);
      const program = base.programs[auction.mint];
      const accounts = await client.accounts(payees.map(w => loot.ata(w, auction.mint, program)));
      for (const [i, w] of payees.entries())
        if (!accounts[i]) opens.push(createAssociatedTokenAccountIdempotent(wallet.address, w, auction.mint, program));
    }
    if (opens.length) await send([...new Map(opens.map(x => [x.keys[1].pubkey, x])).values()]);
    const before = [];
    const held = [];
    // An NFT of the bid that is gone (its collection took it back or burned it) is not paid: its accounts show the
    // end that the project no longer holds it, and the end passes it over.
    const lost = [];
    if (auction.nft_bids)
      for (const nft of auction.held) {
        const now = await heldNow(nft);
        if (now.held === false) lost.push(nft);
        held.push(await kindFor(nft, auction.seller, now, before));
      }
    const end = (hold = false) => loot.endAuctionIx({ ...base, auction, held, holders, hold });
    const steps = ix => [
      computeUnitLimit(1_000_000),
      ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ix,
    ];
    const passed = lost.length
      ? {
          gone: true,
          says: `The project no longer holds ${lost.length === 1 ? 'an NFT' : 'NFTs'} of the winning bid (${lost.join(', ')}): whoever controls its collection took it back or burned it while the auction held it. Nothing was paid for it: the rest of the bid was paid to the seller.`,
        }
      : {};
    if (sendPlan({ payer: wallet.address, instructions: steps(end()), alone: isProveLeaf }))
      try {
        return { paid: await send(steps(end())), ...passed };
      } catch (e) {
        // The lot is the winner's already: what is owed waits until the account it goes into can take it.
        return {
          paid: null,
          says: `The lot is the winner’s; the money waits (${e.message}): end the auction again to pay it.`,
        };
      }
    const outs = auction.held.filter(x => !lost.includes(x)).map(x => [x, auction.seller]);
    const { signature, releases } = await heldThenReleased(at, steps(end(outs.map(([x]) => x))), outs);
    return { paid: signature, releases, ...passed };
  }

  /**
   * An end that makes NFTs holds (`outs`: [asset, to]), sent by the wallet with a transfer that funds a throwaway key; the
   * key then sends each on with a release (anyone may), funded for what each may open (a pNFT's token account and record,
   * a compressed NFT's proof record). One the key can't send, the wallet does. Returns { signature, releases }.
   */
  async function heldThenReleased(at, instructions, outs) {
    const { key, fund } = await keyFor(
      BigInt(outs.length) * (2n * SIGNATURE_LAMPORTS + loot.SETTLE_RENT_UNIT),
      await jobKey(at),
    );
    const signature = await send([...instructions, fund]);
    const releases = [];
    for (const [asset, to] of outs) {
      // Taken back or burned since the end made it a hold: its release closes the hold on that proof, and moves no NFT.
      let lost = false;
      const release = async signer => {
        const hold = await read('Hold', loot.pda.hold(asset, 0));
        const { before: proof, hasAuthority: _h, gone, ...kind } = await leaving(asset, signer, { to });
        lost = gone;
        return [
          ...proof,
          loot.releaseIx({
            signer,
            project,
            asset,
            ...kind,
            collection: kind.compressed || kind.tokenMetadata ? undefined : ((await collectionOf(asset)) ?? MPL_CORE),
            hold,
            to,
          }),
        ];
      };
      const steps = await release(key.address);
      const byKey = (await dryRun(key.address, steps)).ok ? await sendAs(key, steps).catch(() => null) : null;
      // One that still can't move (frozen for now) stays a hold: claims() lists it for whoever it is owed to.
      const sent = byKey ?? (await send(await release(wallet.address)).catch(e => ({ asset, waits: e.message })));
      releases.push(lost && typeof sent === 'string' ? { asset, gone: true, closed: sent } : sent);
    }
    await emptyKey(key);
    return { signature, releases };
  }
  return Object.assign(ctx, { auctionAt, endSale });
}

/**
 * The auction methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function auctionMethods(ctx) {
  const {
    spec,
    wallet,
    programs,
    now,
    client,
    project,
    ours,
    tokens,
    currencyKey,
    decimalsOf,
    part,
    read,
    collectionOf,
    nftOf,
    leaving,
    releaseOwed,
    tokenSettings,
    projectNow,
    auctionAt,
    passing,
    listProofOf,
    send,
    endSale,
    clearLeftovers,
    closesFirst,
    hookTail,
  } = ctx;

  return {
    /**
     * The auctions: each one's lot, high bid, the least the next bid must be, when it ends and how long is left, and
     * whether the player leads. One no longer on chain has ended. `waiting`: SOL that came back to the player's
     * wrapped-SOL account from a bid that was topped (`unwrap` turns it into plain SOL). `warnings`: what to show every
     * bidder before a bid (a token whose accounts can be frozen, a lot of another collection).
     */
    async auctions() {
      const list = spec.auctions ?? [];
      const accounts = await client.accounts(list.map(a => auctionAt(a)));
      const at = BigInt(now());
      const wrapped = wallet?.address
        ? await client.account(associatedTokenAddress(wallet.address, NATIVE_MINT))
        : null;
      const waiting = wrapped
        ? show(new DataView(wrapped.data.buffer, wrapped.data.byteOffset).getBigUint64(64, true), 9)
        : '0';
      const auctions = accounts.map(x => x && loot.decode('Auction', x.data));
      // What every bidder is told before a bid: what the bids' token lets the high bidder do, and what whoever
      // controls an NFT lot of another collection can do to it.
      const mints = [...new Set(auctions.filter(Boolean).map(x => x.mint))];
      const mintAccounts = Object.fromEntries((await client.accounts(mints)).map((m, k) => [mints[k], m]));
      const warningsOf = async x => {
        const out = tokenSettings(
          mintAccounts[x.mint],
          'the refund of the bid a higher one tops',
          'the high bidder',
          'so every higher bid fails and they win at their price',
        ).map(r => r.says);
        const lot = x.lot.Asset?.[0];
        if (lot && !ours(await collectionOf(lot)))
          out.push(
            'This lot is an NFT outside the project’s collections: whoever controls its collection can stop it moving or take it back while the project holds it. The seller is paid only when the lot reaches the winner; while it can’t move, the winning bid waits in the project’s vault, until it can or the project calls the sale off, and a lot taken back or burned sends the bid back. A bid can be tied up, not lost.',
          );
        return out;
      };
      const warned = await Promise.all(auctions.map(x => (x ? warningsOf(x) : [])));
      return list.map((a, i) => {
        const x = auctions[i];
        const base = {
          key: a.key,
          name: a.name,
          lot: a.lot,
          currency: tokens.get(a.currency ?? currencyKey)?.symbol ?? a.currency ?? currencyKey,
        };
        if (!x) return { ...base, ended: true };
        // Bids of NFTs count NFTs.
        const dec = x.nft_bids ? 0 : decimalsOf(a.currency);
        const ends = loot.auctionEnds(x);
        const bid = x.high > 0n;
        const nextBid = loot.leastBid(x);
        return {
          ...base,
          ended: false,
          reserve: show(x.reserve, dec),
          high: bid ? show(x.high, dec) : null,
          highBidder: bid ? x.high_bidder : null,
          leading: bid && x.high_bidder === wallet?.address,
          nextBid: nextBid === null ? null : show(nextBid, dec),
          nextBidUnits: nextBid,
          startsAt: Number(x.starts_at),
          endsAt: Number(ends),
          secondsLeft: Number(ends > at ? ends - at : 0n),
          open: nextBid !== null && at >= x.starts_at && at < ends,
          over: at >= ends,
          // The lot went at its end, and its seller's account couldn't take the money then: the next end pays it and closes it.
          ...(BigInt(x.proceeds_owed) > 0n ? { delivered: true, proceedsOwed: show(x.proceeds_owed, dec) } : {}),
          // A bid of NFTs: a picker of 1 to `maxNfts` (and at least `nextBid`) of the player's NFTs.
          ...(x.nft_bids ? { nftBids: true, held: x.held, maxNfts: loot.MAX_BID_NFTS } : {}),
          ...(tokens.get(a.currency ?? currencyKey)?.source === 'sol' ? { waiting } : {}),
          ...(warned[i].length ? { warnings: warned[i] } : {}),
        };
      });
    },

    /**
     * Bids `amount` (whole units) on an auction. The bid it tops goes back to its bidder in the same transaction
     * (the program opens their account again if they closed it, paid by this bidder). In SOL, only what the player's
     * wrapped-SOL account does not hold already is wrapped, and the account stays open: if this bid is topped, it comes
     * back there. In an auction of NFT bids, an NFT of the topped bid that the project no longer holds (its collection
     * took it back or burned it) can't go back: the bid makes it a hold for its bidder and closes that hold on the
     * proof in the same transaction, so a high bid with an NFT gone can still be topped.
     */
    async bid(auctionKey, amount, { shown, listProof, nfts, acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'listProof', 'nfts', 'acceptLeftover'], 'bid');
      const a = part('auctions', auctionKey);
      const auction = await read('Auction', auctionAt(a));
      shown ??= await passing(auction.gate, 'bid');
      listProof = listProofOf(auction.gate, a.gate?.list, listProof);
      // An auction of NFT bids: a bid is a bundle of the player's NFTs (`nfts`, their addresses, or `amount` read as
      // them), and the bid it tops goes back to its bidder in the same transaction.
      if (auction.nft_bids) {
        const bundle = nfts ?? (Array.isArray(amount) ? amount : null);
        if (!bundle?.length) throw new Error('This auction takes NFTs as bids: say which (nfts).');
        if (bundle.length > loot.MAX_BID_NFTS) throw new Error(`A bid holds at most ${loot.MAX_BID_NFTS} NFTs.`);
        if (auction.held.length >= loot.MAX_BID_NFTS)
          throw new Error(`The high bid holds ${loot.MAX_BID_NFTS} NFTs, the most a bid holds: it can't be topped.`);
        const clears = [];
        for (const asset of bundle) clears.push(...(await clearLeftovers(asset, acceptLeftover)));
        const before = [];
        const kindOf = async (asset, to) => {
          const { before: proof, ...kind } = await nftOf(asset, wallet.address, { to });
          before.push(...proof);
          return { asset, ...kind };
        };
        const bid = [];
        for (const asset of bundle) bid.push(await kindOf(asset));
        // The bid it tops goes back to its bidder: into a fresh account of theirs when their own can't take it. An
        // NFT of it that is gone (its collection took it back or burned it) can't go back: the auction only hands it
        // out, so it is made a hold for its bidder, and that hold closes on the proof right after the bid.
        const held = [];
        const lost = new Map();
        for (const asset of auction.held) {
          const { before: proof, gone, ...kind } = await leaving(asset, wallet.address, { to: auction.high_bidder });
          before.push(...proof);
          held.push({ asset, ...kind });
          if (gone) lost.set(asset, kind);
        }
        const ix = loot.bidIx({
          bidder: wallet.address,
          project,
          id: a.id,
          auction,
          shown,
          listProof,
          nfts: bid,
          held,
          hold: [...lost.keys()],
          programs,
        });
        const g = await projectNow();
        const closes = [...lost].map(([asset, { hasAuthority: _, ...kind }]) =>
          releaseOwed(asset, kind, { player: auction.high_bidder, rentTo: auction.high_bidder }, wallet.address, g),
        );
        return send(
          await closesFirst(clears, [
            computeUnitLimit(800_000),
            ...before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
            ix,
            ...closes,
          ]),
        );
      }
      const mint = auction.mint;
      const value = units(amount, decimalsOf(a.currency));
      const instructions = [];
      if (mint === NATIVE_MINT) {
        const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
        const have = await client.account(wrapped);
        const held = have ? new DataView(have.data.buffer, have.data.byteOffset).getBigUint64(64, true) : 0n;
        instructions.push(createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, NATIVE_MINT));
        if (value > held)
          instructions.push(transferLamports(wallet.address, wrapped, value - held), syncNative(wrapped));
      }
      // A Token-2022 account can ask for a memo on every transfer into it: the Memo program rides along, and a transfer
      // hook's accounts.
      const memo = await hookTail([mint]);
      // The coin's token program, read from the mint when the app wasn't told it.
      const coin = programs[mint] ?? (await client.account(mint))?.owner ?? TOKEN_PROGRAM;
      instructions.push(
        loot.bidIx({
          bidder: wallet.address,
          project,
          id: a.id,
          auction,
          amount: value,
          shown,
          listProof,
          programs: { ...programs, [mint]: coin },
          extra: memo,
        }),
      );
      return send(instructions, [], { keepWrapped: true });
    },

    /**
     * Ends an auction that is over (anyone can; the winner usually does): the lot to the highest bidder and the winning
     * bid to whoever owned it, in one transaction (a new collectible minted for the winner at the address its item and
     * serial name), however long after the end it is sent. A roll lot makes the winner's roll of its box (`order`), which
     * `collect` asks for and settles. An NFT lot whose end can't fit one transaction (a compressed lot's long proof, many
     * shares, a hooked coin) goes first, and the bid is paid by a second end, the accounts it pays into opened before it.
     * When the lot can't move now (its collection froze it or refuses the move), nothing is sent: the sale waits, the
     * winning bid in the project's vault (`{ waiting: true, says }`); end it again later, or the project's keys call it
     * off (`callOffSale`). When the lot or an NFT of the winning bid is gone (its collection took it back or burned it),
     * the sale is called off on that evidence, which anyone may: the bid goes back to its bidder (`{ calledOff: true }`).
     * With no bid, the lot goes home to its seller. An end too big for one transaction otherwise makes each NFT that may
     * be a hold one, and sends each on with a release after it (`releases`).
     * An NFT that is gone is never sent, whatever its kind, and the result says so (`gone: true`, and `says`, what the
     * end did in words): a lot gone with no bid stays where it is and the auction closes, its rent to its seller; a
     * sale with the lot or an NFT of the bid gone is called off, and what the project still holds goes back; for the
     * project's own lot, or a lot that went first, the end passes the bid's NFT that is gone over and pays the rest.
     * A hold made at the end whose NFT goes before its release is closed on the proof: its entry in `releases` is
     * then `{ asset, gone: true, closed }`, `closed` the signature.
     */
    async endAuction(auctionKey, { holders, ...others } = NO_OPTIONS) {
      only(others, ['holders'], 'endAuction');
      return endSale(part('auctions', auctionKey), { holders });
    },

    /**
     * The project's owner or authority calls off the sale of an NFT lot whose auction is over and whose lot has not moved
     * (one that never thaws, say), for the project fee: the winning bid goes back to its bidder and the lot home to its
     * seller, each moved, or made a hold that anyone sends on once it can move (`releases`). Anyone may when the lot or
     * an NFT of the winning bid is gone (`endAuction` does it then). Refused once the lot went to its winner (`CantCallOff`).
     */
    async callOffSale(auctionKey, { ...others } = NO_OPTIONS) {
      only(others, [], 'callOffSale');
      return endSale(part('auctions', auctionKey), { callOff: true });
    },
  };
}
