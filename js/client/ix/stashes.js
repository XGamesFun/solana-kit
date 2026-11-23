// Stashes: an NFT put into a stash or taken out, and stashing many in batches.
import { idleRound } from '../accounts.js';
import { pda } from '../pda.js';
import { ascending, NO_OPTIONS, ONLY_MOVES, withPrograms } from './shared.js';
import { lootIx } from './base.js';
import { anotherMetas, piece } from './piece.js';

// ---------------------------------------------------------------- stashes

/**
 * The project's owner or authority (`signer`) puts an NFT it holds into stash `id`, or (`out`: a wallet) takes one the
 * stash holds out to that wallet. The NFT is any kind, as `piece` takes it: `collection` a Core asset's own,
 * `tokenMetadata`, or `compressed` after a `proveLeafIx` in the same transaction. The signer pays what the stash grows
 * by, and gets back the rent it no longer needs. `drop`: the NFT leaves the stash and stays where it is, owed to the
 * treasury in its hold (`["hold", nft, 0]`, the signer paying its rent until anyone `release`s it to the treasury, one
 * NFT a call). `out` is never the project's own address nor another account of the program (`ToTheProject`).
 * Taking out of a project's stash an NFT proven gone from the project (`piece`: the Core asset itself,
 * `tokenMetadata.evidence`, a compressed NFT's record proven again) only takes its row off the list: anyone may send
 * it (`signer`), for no fee, nothing moves and no hold is made (`NftGone`, no `Stashed`); the rent the stash no longer
 * needs goes to the signer only when it is one of the project's keys. A lottery's own stash stays the project's keys'.
 */
export function stashIx({
  signer,
  project,
  id,
  lottery = null,
  lotteryState = null,
  asset,
  out = null,
  drop = false,
  weight = 1,
  collection,
  tokenMetadata: tm,
  compressed,
  more = [],
}) {
  if (drop && more.length) throw new Error('A stash drops one NFT a call.');
  if (drop) out = pda.hold(compressed?.id ?? asset, 0);
  const to = out ?? signer;
  // A lottery's own stash (`lottery`: the lottery's id): an NFT its place names leaves only as that prize, or once the
  // lottery has ended; taking one out passes the lottery.
  const own = lottery != null ? pda.lottery(project, lottery) : null;
  const stash = own ? pda.lotteryStash(own) : pda.stash(project, id);
  // Out to a wallet or the project's own address, never another account of the program (a record, a stash, a fee
  // box), where no record names the NFT and nothing could move it again (ToTheProject): the ones this call names are
  // refused before sending, and the program refuses any other (js/play only takes one out to the signer's wallet).
  if (out && !drop && [project, stash, own, pda.fees(project), pda.platform()].includes(out))
    throw new Error(
      'An NFT taken out of a stash can’t go to the project or an account of the program: name a wallet, or drop it (`drop`: it stays, owed to the treasury).',
    );
  // Several NFTs (`more`: each { asset, weight, collection, tokenMetadata, compressed }) go in or out in one call, one
  // fee, in ascending order of their addresses; put in, each weighs its `weight` in the stash's draws.
  const [first, ...rest] = ascending(
    [{ asset, weight, collection, tokenMetadata: tm, compressed }, ...more].map(n => ({
      n,
      p: piece({
        project,
        asset: n.asset,
        wallet: drop ? project : to,
        collection: n.collection,
        tokenMetadata: n.tokenMetadata,
        compressed: n.compressed,
        ...ONLY_MOVES,
      }),
    })),
    x => x.p.accounts.asset,
  );
  const p = withPrograms(
    first.p,
    rest.map(x => x.p),
  );
  const weights = out ? [] : [first, ...rest].map(x => x.n.weight ?? 1);
  // A lottery's own stash names the lottery, and the round it waits on (`idleRound`; `lotteryState`: the decoded
  // Lottery; none for one never written), whose places say what it locks.
  const round = own && lotteryState ? idleRound(own, lotteryState) : null;
  return lootIx(
    'stash',
    { of: own ? { Lottery: [lottery] } : { Project: [id] }, out: Boolean(out), weights },
    { signer, project, stash, to, ...p.accounts, lottery: own, round },
    { remaining: [...p.proof, ...rest.flatMap(x => anotherMetas(x.p))], writable: p.writable },
  );
}

/**
 * How many NFTs of one kind one `stash` call puts in, measured on the program (`tests/v026_stash_batch.rs`): in a legacy
 * transaction, with a lookup table, and with a lookup table and the most memory asked for. A compressed NFT needs its
 * proof in the same transaction (`proveLeafIx`): one a call.
 */
export const STASH_BATCH = Object.freeze({
  own: [19, 26, 29],
  core: [10, 24, 27],
  tokenMetadata: [3, 7, 7],
  programmable: [2, 4, 4],
  compressed: [1, 1, 1],
});

/** The kind of an NFT as `stashIx` takes it, for `STASH_BATCH`: the project's own Core collectible ('own'), another
 * collection's Core NFT ('core', `hasAuthority` false), a Token Metadata NFT ('tokenMetadata', or 'programmable' for a
 * pNFT) or a compressed one ('compressed'). */
export const stashKind = n =>
  n.compressed
    ? 'compressed'
    : n.tokenMetadata
      ? n.tokenMetadata.programmable
        ? 'programmable'
        : 'tokenMetadata'
      : n.hasAuthority === false
        ? 'core'
        : 'own';

/**
 * A long list of NFTs to put in a stash (each { asset, weight, collection, hasAuthority, tokenMetadata, compressed }, as
 * `stashIx` takes them), split into calls of one kind each, as many a call as the measured sizes allow (`STASH_BATCH`):
 * `lookupTable` when the transactions carry one, `heap` when they also ask for the most memory. Returns the calls, each
 * a list of NFTs: the first is a call's own (`asset`…), the rest its `more`. Each call is one project fee.
 */
export function stashBatches(nfts, { lookupTable = false, heap = false } = NO_OPTIONS) {
  const column = lookupTable ? (heap ? 2 : 1) : 0;
  const byKind = new Map();
  for (const n of nfts) {
    const kind = stashKind(n);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(n);
  }
  const calls = [];
  for (const [kind, list] of byKind) {
    const size = STASH_BATCH[kind][column];
    for (let i = 0; i < list.length; i += size) calls.push(list.slice(i, i + size));
  }
  return calls;
}
