// Contests: entering one and claiming what it pays.
import { toBigInt } from '../../chain/bytes.js';
import { meta } from '../../chain/programs.js';
import { CLAIMED, ENDED, shareOf } from '../accounts.js';
import { ata, pda } from '../pda.js';
import { holds, ONLY_MOVES, pieceMetas, splitMint, tokenProgramOf } from './shared.js';
import { lootIx, tailOf } from './base.js';
import { gateAccounts, prizeMetas, prizeNonce, shownFor } from './tail.js';
import { contestEntries } from './decide.js';
import { piece } from './piece.js';

// ---------------------------------------------------------------- contests

/**
 * `player` backs `side` with `amount`, naming the contest's incarnation (which fixes its terms). `contest` is the
 * decoded Contest. A contest of NFTs (`contest.nft`) takes one NFT instead (`nft`: { asset, collection, tokenMetadata,
 * compressed }, as `piece` takes it), which the contest holds until it is claimed. `shown`/`listProof` pass its gate.
 * A new entry's record is the player's to pay (not refunded). `extra`: a hook's accounts.
 */
export function enterIx({
  player,
  project,
  id,
  contest,
  side,
  amount,
  shown,
  listProof,
  nft,
  playerToken,
  programs,
  extra = [],
}) {
  const address = pda.contest(project, id);
  // Read for its rule (with its Sheet, for an NFT the project has no authority over), then handed to the project.
  const staked = contest.nft ? piece({ project, wallet: player, ...nft, ...ONLY_MOVES, reads: true }) : null;
  return lootIx(
    'enter',
    { side, amount: contest.nft ? 1n : amount, incarnation: contest.incarnation },
    {
      player,
      project,
      contest: address,
      entries: contestEntries(address, contest),
      player_token: playerToken ?? ata(player, contest.mint, tokenProgramOf(programs, contest.mint)),
      mint: contest.mint,
    },
    {
      remaining: [
        ...gateAccounts(project, {
          gate: contest.gate,
          wallet: player,
          shown: shownFor(project, contest.gate, player, shown),
          listProof,
        }),
        ...(staked ? [...pieceMetas(staked), ...staked.proof] : []),
        ...tailOf(extra),
      ],
    },
  );
}

/** How long a winner has to make their own picks before the project's keys may make them (constants.rs). */
const CLAIM_GRACE_SECONDS = 30 * 86_400;

/**
 * Anyone (`payer`) claims `player`'s entry (`entries`: the contest's decoded entries, `decodeEntries`), into the
 * player's account of the mint, which `payer` opens when it is not there. A winner's first claim also gives the
 * contest's prize (`prizeMetas`: `collection`, `poolMints`, `items`, `nft`; a roll's order at `nonce`, `prizeNonce` of the
 * contest and the player by default), unless the player (signing) `forgo`es it. In a contest of NFTs it moves the NFTs of
 * the entries `nfts` names by their place in the list (the player's own by default, while the contest holds it): an
 * entry's own back to its player (anyone sends it); a loser's to the winner while it has picks left of its share (only
 * the winner sends it, and picks which: `WinnerPicks`), or to the opener once no winner has picks left. `kinds` maps an
 * NFT to its kind, as `piece` takes it. With `hold` (true, or a list of assets), each becomes a hold for the wallet it goes to (an NFT that can't
 * move now); with `end`, the winner leaves the rest of its share to the opener. The claim that leaves nothing owed
 * closes the contest (`projectState`: its treasury); a contest that owes nothing (nobody entered, every part claimed,
 * off by itself with none in) is closed by any claim, the `payer`'s. `extra`: a hook's accounts.
 */
export function claimIx({
  payer,
  project,
  projectState,
  id,
  contest,
  entries,
  player,
  nfts,
  kinds = {},
  nonce,
  collection,
  poolMints,
  items,
  nft,
  prizeMint,
  forgo = false,
  end = false,
  hold = false,
  programs,
  extra = [],
  now = Math.floor(Date.now() / 1000),
}) {
  const address = pda.contest(project, id);
  // A loser's NFT goes to the winner picking it: the winner's own claim, or the project's keys' once the grace after the
  // decision has passed (contest.rs: `signed || (late && keys)`).
  const late = now >= Number(contest.decided_at ?? 0) + CLAIM_GRACE_SECONDS;
  const keys = Boolean(projectState) && (payer === projectState.owner || payer === projectState.authority);
  // A contest that owes nothing (nobody entered, or every part claimed) is only closed: by any claim, entry 0, any player.
  const closing = BigInt(contest.owed) === 0n;
  player ??= payer;
  const i = closing ? 0 : entries.findIndex(e => e.player === player);
  if (i < 0) throw new Error(`${player} has no entry in this contest.`);
  const me = closing ? { side: 0, bits: CLAIMED | ENDED, amount: 0n, taken: 0 } : entries[i];
  nonce = toBigInt(nonce ?? prizeNonce(address, player));
  const won = contest.verdict === 'Won' && Number(contest.winner) === Number(me.side);
  const first = won && !(me.bits & CLAIMED);
  // A winner's first claim of a contest with a prize: the prize's accounts, after the NFTs'. A split prize is paid from
  // the contest's vault (named accounts below), not given as a prize line.
  const split = Boolean(contest.prize_split);
  const prize =
    contest.prize != null && first && !split && !forgo
      ? prizeMetas({
          project,
          collection,
          prize: contest.prize,
          winner: player,
          nonce,
          poolMints,
          items,
          nft,
          programs,
        })
      : [];
  const pMint = split
    ? splitMint(contest.prize, prizeMint ?? poolMints?.[contest.prize?.Tokens?.from.Pool?.[0]])
    : null;
  nfts ??= !closing && contest.nft && Number(me.amount) === 1 ? [i] : [];
  const moved = [];
  let taken = Number(me.taken);
  for (const j of nfts) {
    const theirs = entries[j];
    let to = contest.opener;
    if (contest.verdict !== 'Won' || Number(theirs.side) === Number(contest.winner)) to = theirs.player;
    else if (won && (payer === player || (late && keys)) && !(me.bits & ENDED) && taken < shareOf(contest, me))
      [to, taken] = [player, taken + 1];
    moved.push(meta(theirs.player, false, true));
    if (holds(hold, theirs.nft)) moved.push(meta(pda.hold(theirs.nft, 0), false, true));
    else {
      const p = piece({ project, asset: theirs.nft, wallet: to, ...kinds[theirs.nft], ...ONLY_MOVES });
      moved.push(...pieceMetas(p), ...p.proof);
    }
  }
  // What it leaves owed: at 0 it closes the contest, burning what its pot (and a split prize's vault) still hold.
  const owed = BigInt(contest.owed);
  const left = closing
    ? 0n
    : !contest.nft
      ? owed - (contest.verdict === 'Won' ? (first ? BigInt(me.amount) : 0n) : 1n)
      : owed - BigInt(nfts.length) - (first && contest.prize ? 1n : 0n);
  // The claim that leaves nothing owed closes the contest, its rent and what is left to the treasury: it names it.
  if (left <= 0n && !projectState?.treasury)
    throw new Error('This claim closes the contest: pass projectState, for its treasury.');
  return lootIx(
    'claim',
    { entry: i, nonce, forgo, end, nfts },
    {
      payer,
      project,
      contest: address,
      entries: contestEntries(address, contest),
      player,
      opener: contest.opener,
      to: ata(player, contest.mint, tokenProgramOf(programs, contest.mint)),
      mint: contest.mint,
      prize_mint: pMint,
      // A split prize from a pool: what its vault holds at the close goes back to that pool (`WrongPool` without it).
      prize_pool:
        split && contest.prize?.Tokens?.from?.Pool ? pda.pool(project, contest.prize.Tokens.from.Pool[0]) : null,
      prize_vault: split ? pda.prizeVault(address) : null,
      prize_to: split ? ata(player, pMint, tokenProgramOf(programs, pMint)) : null,
      treasury: projectState?.treasury ?? null,
    },
    {
      writable: left <= 0n ? ['mint', ...(split ? ['prize_mint'] : [])] : [],
      remaining: [...moved, ...prize, ...tailOf(extra)],
    },
  );
}
