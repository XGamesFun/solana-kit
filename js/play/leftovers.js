// What an NFT that left the project can leave behind, for the page client (solanaApp): records and stashes of it that
// would take a deposit of it again, found before the deposit and closed first, or refused in words.
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit } from '../chain/programs.js';
import { compileFitting, transactionLocks } from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { isProveLeaf } from './common.js';

/**
 * Puts on `ctx` the records an NFT left behind and the closes that go before a deposit of it. Returns `ctx`.
 * @param {ReturnType<typeof import('./rolls.js').addRolls>} ctx
 */
export function addLeftovers(ctx) {
  const {
    wallet,
    programs,
    client,
    project,
    ours,
    readMaybe,
    collectionOf,
    goneProof,
    projectNow,
    standing,
    send,
    dryRun,
    chainNow,
    holdersOf,
  } = ctx;

  /**
   * This project's records of `asset`: its listing at `["listing", project, asset]` (one read) and its holds (one
   * search, by the asset's address). Each is { kind: 'listing' | 'hold', address, record }.
   */
  async function recordsOf(asset) {
    const out = [];
    const listingAt = loot.pda.listing(project, asset);
    const listing = await readMaybe('Listing', listingAt);
    if (listing) out.push({ kind: 'listing', address: listingAt, record: listing });
    const tag = { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS.Hold)) } };
    const holds = await client.programAccounts(loot.lootProgram(), [
      tag,
      { memcmp: { offset: 1, bytes: project } },
      { memcmp: { offset: 33, bytes: asset } },
    ]);
    for (const { pubkey, account } of holds)
      out.push({ kind: 'hold', address: pubkey, record: loot.decode('Hold', account.data) });
    return out;
  }

  /**
   * The stashes of this project that list `asset`: a project's stash (`kind` 'stash') or a lottery's own
   * ('lottery-stash'), each { kind, address, id } (`id`: the stash's, or the lottery's). A stash keeps its NFTs in
   * rows of no fixed place, so no filter finds one NFT's row: this is one search of the project's stashes
   * (`getProgramAccounts` by tag, project and payload), which returns every stash of the project whole, 36 bytes for
   * each NFT a stash lists, and reads them here.
   */
  async function stashesOf(asset) {
    const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
    const found = await client.programAccounts(loot.lootProgram(), [
      at(0, encodeBase58(Uint8Array.of(loot.TAGS.Table))),
      at(1, project),
      at(37, encodeBase58(Uint8Array.of(loot.PAYLOAD.Nft))),
    ]);
    const out = [];
    for (const { pubkey, account } of found) {
      const stash = loot.decodeStash(account.data);
      if (!stash?.nfts.includes(asset)) continue;
      const own = pubkey === loot.pda.stash(project, stash.id);
      out.push({ kind: own ? 'stash' : 'lottery-stash', address: pubkey, id: stash.id });
    }
    return out;
  }

  /**
   * The records of this project an earlier owner of `asset` left behind (`recordsOf`), each that names a wallet other
   * than the player's: { kind, address, record, says }. Such a record is left when whoever controls the NFT's
   * collection moved it out of the project's hands without the program. Until it is closed, the program hands out
   * whatever the project holds at that address: once this player's deposit puts the NFT back in the project's hands, the
   * record can send it to the wallet it names. `own`: the player's own listing of it counts too (a route that lists:
   * the program takes no second listing of an NFT while one is open). NFTs of the project's own collections are not
   * read: those collections refuse the permanent delegates that take an NFT out.
   */
  async function leftovers(asset, { own = false } = {}) {
    if (ours(await collectionOf(asset))) return [];
    const me = wallet.address;
    const out = [];
    const time = BigInt(await chainNow());
    const iso = at => new Date(Number(at) * 1000).toISOString();
    for (const r of await recordsOf(asset)) {
      if (r.kind === 'listing') {
        const listing = r.record;
        const mine = listing.maker === me;
        if (mine && !own) continue;
        const sale = Boolean(listing.deal.Sell);
        // A running rental is kept: nobody but its maker can even stop the listing until it has run.
        const rented =
          time < BigInt(listing.until)
            ? ` It is rented until ${iso(listing.until)}: the program keeps a running rental, so nobody can close this listing before then (anyone can after, for nothing).`
            : '';
        out.push({
          ...r,
          says: mine
            ? `Your own earlier listing of this NFT (${r.address}) is still open in this project.${rented}`
            : `A listing of this NFT (${r.address}) is still open in this project, left by an earlier owner, ${listing.maker}. Once the project holds the NFT again, ${listing.maker} can take it home by closing that listing${sale ? `, and anyone can buy it at the listing's price, which is paid to ${listing.maker}` : ''}.${rented}`,
        });
        continue;
      }
      const hold = r.record;
      const to = hold.player === project ? 'the project’s treasury' : hold.player;
      const names = [hold.player, hold.debt?.lender].filter(Boolean);
      if (names.every(x => x === me)) continue;
      const due = time >= BigInt(hold.free_at);
      const what = hold.debt
        ? due
          ? `a loan's hold whose loan is overdue: anyone can send the NFT to its lender, ${hold.debt.lender}`
          : `a loan's hold: anyone who repays it (${hold.debt.repay} to ${hold.debt.lender}) sends the NFT to ${to}, and once it is due anyone sends it to the lender`
        : due
          ? `a hold that is over: anyone can send the NFT to ${to} at once`
          : `a hold that runs until ${iso(hold.free_at)}: the project's authority decides where the NFT goes until then, and anyone sends it to ${to} after`;
      out.push({
        ...r,
        says: `This project still has ${what} (${r.address}), left from an earlier owner of this NFT. Once the project holds the NFT again, it can be sent there.`,
      });
    }
    return out;
  }

  /**
   * The instructions that close `records` of `asset` (`recordsOf`) on the proof that the project no longer holds it
   * (`proof`, from `goneProof`), as `signer` sends them: a hold by `release`, a listing by `take_listing`. Anyone may
   * send either, at any time; nothing is sent or paid, and no project fee is taken. A listing whose rental still runs
   * can't be closed (`Rented`): the program keeps a running rental, and the listing closes once it has run.
   * Returns { closes, closed: [{ kind, address }], waits: the records left }.
   */
  async function closesOf(asset, records, proof, signer = wallet.address) {
    const g = await projectNow();
    const time = BigInt(await chainNow());
    const closes = [];
    const closed = [];
    const waits = [];
    for (const r of records) {
      if (r.kind === 'listing') {
        if (time < BigInt(r.record.until)) {
          waits.push(r);
          continue;
        }
        closes.push(
          loot.takeListingIx({
            taker: signer,
            project,
            projectState: g,
            listing: r.record,
            holders: await holdersOf(r.record.shares ?? []),
            programs,
            ...proof.kind,
          }),
        );
      } else {
        const hold = r.record;
        closes.push(
          loot.releaseIx({
            signer,
            project,
            asset,
            ...proof.kind,
            hold,
            address: r.address,
            treasury: g.treasury,
            ...(hold.debt ? { to: hold.debt.lender } : {}),
          }),
        );
      }
      closed.push({ kind: r.kind, address: r.address });
    }
    return { closes: closes.length ? [...proof.before, ...closes] : [], closed, waits };
  }

  /**
   * The deposit guard. Before the player hands `asset` to the project, what an earlier owner left of it there
   * (`leftovers`) is cleared: the player holds the NFT, so it is provably gone from the project, and each leftover hold
   * closes by `release` on that proof and a leftover listing by `take_listing` on it (anyone may, at any time, and
   * nothing is paid). Returns those instructions, tried in a dry run, to go in front of the deposit (`closesFirst`);
   * none when nothing was left. The closes cost the player their transaction fee only: each record's rent goes to
   * whoever that record names (a hold's payer, a listing's maker), never to the player.
   * What can't be closed still refuses the deposit, in words, with nothing sent: a listing whose rental still runs
   * (the program keeps it until the rental has run), or a record of an NFT nothing shows gone. `accept` true goes
   * ahead all the same (the closes that can be made still go first). `listing`: the route is a listing, which the
   * program refuses outright while a listing of the NFT is open (its address is taken), whatever the option says.
   */
  async function clearLeftovers(asset, accept, { listing = false } = {}) {
    const found = await leftovers(asset, { own: listing });
    if (!found.length) return [];
    const proof = await goneProof(asset, wallet.address, { holder: wallet.address });
    let { closes, waits } = proof ? await closesOf(asset, found, proof) : { closes: [], waits: found };
    let why = '';
    if (closes.length) {
      const trial = [computeUnitLimit(1_400_000), ...closes.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM)];
      // Tried in a dry run when they are one transaction as they stand; a longer list is made to fit as it is sent.
      const one = compileFitting({
        payer: wallet.address,
        blockhash: NO_ADDRESS,
        instructions: trial,
        tables: await standing(),
      });
      const tried = one ? await dryRun(wallet.address, trial) : { ok: true };
      if (!tried.ok) {
        why = tried.error ? ` Closing it was refused in a dry run: ${tried.error.msg} (${tried.error.name}).` : '';
        [closes, waits] = [[], found];
      }
    }
    const open = waits.find(x => x.kind === 'listing');
    if (listing && open)
      throw new Error(
        `${open.says}${why} The program refuses another listing of this NFT while that one is open (its address is taken): nothing was sent.`,
      );
    if (waits.length && accept !== true)
      throw new Error(
        `${waits.map(x => x.says).join(' ')}${why} This deposit would put the NFT where that record can take it: it would be lost to you. Nothing was sent. Go ahead only if the player accepts this: pass acceptLeftover: true.`,
      );
    return closes;
  }

  /**
   * A deposit's `instructions` with `closes` (`clearLeftovers`) in front of them: in the same transaction when both
   * fit one as the wallet sends it (a legacy one, or one with the project's standing tables); when they do not, the
   * closes are sent first in a transaction of their own, and the deposit's instructions come back alone.
   */
  async function closesFirst(closes, instructions) {
    if (!closes.length) return instructions;
    const isLimit = ix => ix.programId === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2;
    // One proof of a compressed NFT serves both: the closes read its record first, then the deposit moves it.
    const proven = new Set(closes.filter(isProveLeaf).map(ix => ix.keys[1].pubkey));
    const together = [
      computeUnitLimit(1_400_000),
      ...closes.filter(ix => !isLimit(ix)),
      ...instructions.filter(ix => !isLimit(ix) && !(isProveLeaf(ix) && proven.has(ix.keys[1].pubkey))),
    ];
    const fits =
      Boolean(
        compileFitting({
          payer: wallet.address,
          blockhash: NO_ADDRESS,
          instructions: loot.withLeafCloses(together),
          tables: await standing(),
        }),
      ) && transactionLocks(wallet.address, together) <= 64;
    if (fits) return together;
    await send(closes);
    return instructions;
  }
  return Object.assign(ctx, { recordsOf, stashesOf, closesOf, clearLeftovers, closesFirst });
}
