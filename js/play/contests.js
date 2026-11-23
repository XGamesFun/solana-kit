// Contests, for the page client (solanaApp): entering one, and the NFTs a winner's claim chooses among.
import { withSolWrap } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { NO_OPTIONS, only, units } from './common.js';

/**
 * Puts on `ctx` a contest's NFTs. Returns `ctx`.
 * @param {ReturnType<typeof import('./auctions.js').addAuctions>} ctx
 */
export function addContests(ctx) {
  const { heldEach } = ctx;

  /** How many of the losers' NFTs left a winner's claim reads to choose its picks among. */
  const PICKS_READ = 8;
  /**
   * The NFTs a claim of entry `i` of a contest of NFTs moves, as `claim` sends it: the entry's own while the contest
   * holds it, and for a winner the losers' NFTs its share still lets it pick, at most 4 a claim. `take` names the
   * picks (one asset, or several). With none named, the first of the losers' NFTs left that the project still holds
   * are picked (the first `PICKS_READ` are read), and one that is gone only when no other is left there: a pick of an
   * NFT gone takes nothing. Each is { j, nft, gone }: its entry's place in the list, and whether the project no longer
   * holds it (its collection took it back or burned it).
   */
  async function contestNfts(contest, entries, i, take) {
    const own = entries[i];
    const won = contest.verdict === 'Won' && Number(contest.winner) === Number(own.side);
    const out = Number(own.amount) === 1 ? [{ j: i, nft: own.nft }] : [];
    const share = won && !(own.bits & loot.ENDED) ? loot.shareOf(contest, own) - Number(own.taken) : 0;
    const left = entries
      .map((e, j) => ({ j, nft: e.nft, e }))
      .filter(({ e }) => Number(e.side) !== Number(contest.winner) && Number(e.amount) === 1);
    const wanted = take ? [take].flat() : [];
    const among =
      share <= 0 ? [] : wanted.length ? left.filter(x => wanted.includes(x.nft)) : left.slice(0, PICKS_READ);
    if (wanted.length && among.length < Math.min(wanted.length, share))
      throw new Error(`${wanted.join(', ')} is not a loser’s NFT left in this contest for you to pick.`);
    const heldOf = await heldEach([...out, ...among].map(x => x.nft));
    const isGone = x => heldOf.get(x.nft)?.held === false;
    const picks = wanted.length ? among : [...among.filter(x => !isGone(x)), ...among.filter(isGone)];
    out.push(...picks.slice(0, Math.min(share, 4)));
    return out.map(x => ({ j: x.j, nft: x.nft, gone: isGone(x) }));
  }
  return Object.assign(ctx, { contestNfts });
}

/**
 * The contest method: `enter`.
 * @param {import('./common.js').Ctx} ctx
 */
export function contestMethods(ctx) {
  const {
    wallet,
    programs,
    project,
    tokens,
    mintOf,
    read,
    nftOf,
    passing,
    listProofOf,
    send,
    clearLeftovers,
    closesFirst,
  } = ctx;

  return {
    /**
     * Backs `side` of contest number `id` (the authority opens contests while the project runs) with `amount`; a contest
     * of NFTs takes one of the player's NFTs that passes its rule instead (`nft`, its address), held until it is
     * claimed. `listProof`: for a list gate.
     */
    async enter(id, side, amount, { shown, listProof, nft: staked, acceptLeftover, ...others } = NO_OPTIONS) {
      only(others, ['shown', 'listProof', 'nft', 'acceptLeftover'], 'enter');
      const contest = await read('Contest', loot.pda.contest(project, id));
      shown ??= await passing(contest.gate, 'enter');
      listProof = listProofOf(contest.gate, null, listProof);
      if (contest.nft) {
        if (!staked) throw new Error('This contest takes an NFT: say which (nft).');
        const clears = await clearLeftovers(staked, acceptLeftover);
        const { before, ...kind } = await nftOf(staked);
        return send(
          await closesFirst(clears, [
            ...before,
            loot.enterIx({
              player: wallet.address,
              project,
              id,
              contest,
              side,
              amount: 1n,
              shown,
              listProof,
              nft: { asset: staked, ...kind },
              programs,
            }),
          ]),
        );
      }
      const t = [...tokens.values()].find(x => mintOf(x.key) === contest.mint);
      const value = units(amount, t?.source === 'sol' ? 9 : (t?.decimals ?? 0));
      return send(
        withSolWrap(wallet.address, contest.mint, value, [
          loot.enterIx({
            player: wallet.address,
            project,
            id,
            contest,
            side,
            amount: value,
            shown,
            listProof,
            programs,
          }),
        ]),
      );
    },
  };
}
