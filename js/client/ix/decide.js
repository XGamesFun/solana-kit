// What is decided: a hold's release, a contest opened and decided, a roll and the oracle's answer.
import { addressBytes } from '../../chain/base58.js';
import { encodeInstruction } from '../../chain/borsh.js';
import { concat, intLE, toBigInt, uintLE, utf8 } from '../../chain/bytes.js';
import { SYSVAR_INSTRUCTIONS } from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import { sha256 } from '../../chain/sha256.js';
import IDL from '../idl/loot.js';
import { lootProgram, pda } from '../pda.js';
import { ascending, hashToAddress, ONLY_MOVES, splitMint, stored, withPrograms } from './shared.js';
import { lootIx, reference, tailOf } from './base.js';
import { boxesAccounts, chosenShares, shareAccounts, sharesBurn } from './tail.js';
import { anotherMetas, piece } from './piece.js';

// ---------------------------------------------------------------- decide

/**
 * A held NFT goes to `to`: the authority's choice while the hold runs, home to its player (anyone) after; a repaid
 * loan's home (anyone, whenever), an unpaid one's to its lender once due. `hold` is the
 * decoded Hold: its address names its end (`pda.hold(asset, free_at)`), so a release sent late never lands on a later
 * hold; `address` names it when its `free_at` changed since (a repaid loan's is 0, at the address its loan named). The
 * NFT is any kind
 * (`piece`): `asset` and `collection` for a Core asset, with `tokenMetadata` for a Token Metadata NFT, or `compressed`
 * (after a `proveLeafIx`).
 * A hold whose NFT is proven gone from the project (`piece`: the Core asset itself, `tokenMetadata.evidence`, a
 * compressed NFT's record proven again) closes instead: anyone sends it, at any time, also while the hold runs and for
 * a loan before it is due, for no project fee. Nothing moves and `to` is not read; the hold's rent goes to whoever paid
 * it, and a loan's debt ends unpaid. Its receipt is `NftGone`, with no `Released`.
 */
export function releaseIx({
  signer,
  project,
  collection,
  asset,
  tokenMetadata: tm,
  compressed,
  hold,
  address = null,
  to,
  treasury,
  reference: ref,
  more = [],
}) {
  // A hold whose player is the project's own address is owed to the treasury, as the project names it now (`treasury`,
  // the decoded Project's).
  if (!to && hold.player === project && !treasury)
    throw new Error('This hold is owed to the treasury: pass treasury (the project’s, as it is now).');
  const receiver = to ?? (hold.player === project ? treasury : hold.player);
  // Never to the project's own address, nor any account of the program, where nothing could move it again (ToTheProject).
  if (receiver === project) throw new Error('A held NFT can’t go to the project’s own address: name a wallet.');
  // Several holds of one player's with one end, payer and rent wallet (`more`: each { asset, collection, tokenMetadata,
  // compressed }) go to one `to` together, in ascending order of their holds' addresses.
  const [first, ...rest] = ascending(
    [{ asset, collection, tokenMetadata: tm, compressed, address }, ...more].map(n => {
      const p = piece({
        project,
        asset: n.asset,
        wallet: receiver,
        collection: n.collection,
        tokenMetadata: n.tokenMetadata,
        compressed: n.compressed,
        ...ONLY_MOVES,
      });
      return { p, hold: n.address ?? pda.hold(p.accounts.asset, hold.free_at) };
    }),
    x => x.hold,
  );
  const p = withPrograms(
    first.p,
    rest.map(x => x.p),
  );
  const groups = rest.flatMap(x => [meta(x.hold, false, true), ...anotherMetas(x.p)]);
  // The hold's rent goes back to whoever made it (`payer`), a Token Metadata NFT's emptied account's to whoever paid it.
  return lootIx(
    'release',
    { reference: reference(ref) },
    { signer, project, ...p.accounts, hold: first.hold, payer: hold.payer, rent_to: hold.rent_to, to: receiver },
    { remaining: [...p.proof, ...groups], writable: p.writable },
  );
}

/**
 * The authority opens contest `id` in `mint` (`projectState`: the decoded Project, whose next incarnation names the
 * contest's list of entries). `args`: { sides, closes_at, result_by, shares, gate, deciders, min_pot, stake, prize, nft,
 * prize_split, cap }: `prize`, what each winning entry gets with its first claim (`prizeMetas`); `nft`, a rule an NFT
 * each entry stakes passes, in place of tokens (no shares then, no stake: the NFTs are the pot), each winner sharing the
 * losers' NFTs, at most `cap` each (null: no cap). With `args.prize_split`, its token prize is set aside whole when it
 * is decided, in the contest's own vault (`pda.prizeVault`, opened now at the authority's rent), and each winning entry
 * takes its part by what it put in: `prizeMint` names the prize's mint when it comes from a pool.
 */
export const openContestIx = ({ authority, project, projectState, id, mint, args, prizeMint }) => {
  stored(args.shares);
  const contest = pda.contest(project, id);
  const split = Boolean(args.prize_split);
  return lootIx(
    'open_contest',
    {
      id,
      args: {
        deciders: [],
        min_pot: 0,
        stake: 0,
        prize: null,
        nft: null,
        prize_split: false,
        cap: null,
        ...args,
        gate: args.gate ?? null,
      },
    },
    {
      authority,
      project,
      mint,
      contest,
      prize_mint: split ? splitMint(args.prize, prizeMint) : null,
      prize_vault: split ? pda.prizeVault(contest) : null,
      entries: pda.entries(contest, BigInt(projectState.incarnations) + 1n),
      // A split prize from a pool names the pool at its index (`WrongPool` without it; a prize mint not the pool's is
      // `WrongMint`).
      prize_pool: split && args.prize?.Tokens?.from?.Pool ? pda.pool(project, args.prize.Tokens.from.Pool[0]) : null,
    },
    {
      // A prize that is a roll: its box.
      remaining: args.prize?.Roll ? boxesAccounts(project, [args.prize.Roll[0]]) : [],
    },
  );
};

/** A contest's list of entries, from its decoded Contest. */
export const contestEntries = (contestAddress, contest) => pda.entries(contestAddress, contest.incarnation);

/** The prefix of a contest's verdict (`verdictBytes`). */
export const VERDICT_DOMAIN = 'loot-verdict-v4';

/**
 * The bytes a contest's decider key signs: "loot-verdict-v4" | sha256(program (32) | contest (32) | incarnation (u64
 * LE) | side (u16 LE; 65535 calls it off) | expires (i64 LE), then | recipient (32) when the verdict names the wallet
 * the contest's chosen share pays). `incarnation` is the contest's (the decoded Contest's), so a verdict decides only
 * the contest it was signed for, never one opened later at the same id. `decide` rebuilds them from its own accounts
 * and arguments.
 */
export function verdictBytes({ program = lootProgram(), contest, incarnation, side, expires, recipient = null }) {
  if (incarnation == null) throw new Error('A verdict signs the contest’s incarnation (the decoded Contest’s).');
  const named = recipient == null ? new Uint8Array(0) : addressBytes(recipient);
  return concat(
    utf8(VERDICT_DOMAIN),
    sha256(
      concat(
        addressBytes(program),
        addressBytes(contest),
        uintLE(incarnation, 8),
        uintLE(side ?? 0xffff, 2),
        intLE(expires, 8),
        named,
      ),
    ),
  );
}

/**
 * Names the side that won (`side`), or calls the contest off (`side: null`). `signer` is the authority; or anyone
 * sending a decider's verdict (`verdict: { expires }`, taken once entries have closed): then this instruction goes
 * right after the Ed25519 check of the decider's signature over `verdictBytes` (`ed25519Ix` in grant.js), and
 * `signer` pays the fee, as the authority does. A contest that is off by itself (overdue) needs no decision, and takes
 * none (`ResultOverdue`): `claim` closes it. The contest's incarnation names it, so a
 * decision sent late never decides a contest opened later at the same id. A call-off takes no share accounts. A
 * contest with a chosen share is decided naming its `recipient`, a wallet (a bounty's worker); a decider's verdict
 * signs it too (`verdictBytes`).
 */
export function decideIx({
  signer,
  project,
  projectState,
  contestAddress,
  contest,
  side,
  recipient = null,
  verdict,
  reference: ref,
  holders,
  prizeMint,
  programs,
  extra = [],
}) {
  const address = contestAddress ?? pda.contest(project, contest.id);
  const named = recipient == null ? contest.shares : chosenShares(contest.shares, recipient);
  const shares =
    side == null
      ? []
      : shareAccounts(project, named, contest.mint, { holders, programs, treasury: projectState?.treasury });
  // A split prize is set aside when a side is named (minted, or from its pool). A decision never closes the contest:
  // `claim` does, entered or not.
  const split = Boolean(contest.prize_split);
  const from = contest.prize?.Tokens?.from;
  return lootIx(
    'decide',
    {
      side: side ?? null,
      expires: toBigInt(verdict?.expires ?? 0),
      reference: reference(ref),
      incarnation: contest.incarnation,
      recipient,
    },
    {
      signer,
      project,
      contest: address,
      mint: contest.mint,
      instructions: verdict ? SYSVAR_INSTRUCTIONS : null,
      prize_mint: split ? splitMint(contest.prize, prizeMint) : null,
      // Its pool: the prize set aside from it when a side is named.
      prize_pool: split && side != null && from?.Pool ? pda.pool(project, from.Pool[0]) : null,
      prize_vault: split ? pda.prizeVault(address) : null,
    },
    // The mint is written by a burn share; the prize's mint when it is minted.
    {
      remaining: [...shares, ...tailOf(extra)],
      writable: [
        ...(side != null && sharesBurn(contest.shares) ? ['mint'] : []),
        ...(split && side != null && from?.Mint ? ['prize_mint'] : []),
      ],
    },
  );
}

/** The authority asks the oracle for a random number, for a rule of the project's own. */
export const rollIx = ({ authority, project, reference: ref }) =>
  lootIx('roll', { reference: reference(ref) }, { authority, project });

/** The oracle's answer to a `roll` (for a local simulation). */
export const callbackRandomIx = ({ project, reference: ref, randomness }) => ({
  programId: lootProgram(),
  keys: [
    meta(pda.oracleIdentity(), true, false),
    meta(project, false, false),
    meta(hashToAddress(reference(ref)), false, false),
  ],
  data: encodeInstruction(IDL, 'callback_random', { randomness: Uint8Array.from(randomness) }),
});
