// After a run: the SOL the owner's test wallet put into its game's pools (seeds, and what players paid in) comes back
// to that wallet, so the sweep returns it to the funder. Only when the test wallet is the game's authority (the
// default); a run whose game names another authority keeps its pools. Devnet test wallets only.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NATIVE_MINT } from '../../js/chain/pda.js';
import { closeTokenAccount, createAssociatedTokenAccountIdempotent } from '../../js/chain/programs.js';
import { moveTokensIx } from '../../js/client/ix.js';
import { ata, pda } from '../../js/client/pda.js';
import { send } from './funds.mjs';

/**
 * Moves each SOL pool of the run's game to the owner and unwraps it. → lamports reclaimed (a number), or null.
 * `keepLotteries`: leave lottery pots alone (a keeper round, where the sweep still has to draw and pay them; the
 * authority can move a pot's tokens even with tickets sold, so reclaiming it would rob the round).
 */
export async function reclaim(rpc, owner, dir, { keepLotteries = false } = {}) {
  const file = path.join(dir, 'xsolana.json');
  if (!existsSync(file)) return null;
  const live = JSON.parse(readFileSync(file, 'utf8')).live;
  // The project's address: `live.project`, or `live.game` in a spec saved by an older version.
  const project = live?.project ?? live?.game;
  if (!project || live.authority !== owner.address) return null;
  const wsol = ata(owner.address, NATIVE_MINT);
  const published = live.published ?? {};
  const sol = new Set((published.tokens ?? []).filter((t) => t.source === 'sol').map((t) => t.key));
  const pots = new Set(keepLotteries ? (published.lotteries ?? []).map((l) => l.pot).filter(Boolean) : []);
  let total = 0n;
  for (const p of published.pools ?? []) {
    if (!sol.has(p.currency ?? published.currency) || pots.has(p.key)) continue;
    const index = Number(p.index ?? -1);
    if (!(index >= 0)) continue;
    const pool = pda.pool(project, index);
    const amount = await rpc.tokenBalance(pool).catch(() => 0n);
    if (!(BigInt(amount) > 0n)) continue;
    await send(rpc, owner, [
      createAssociatedTokenAccountIdempotent(owner.address, owner.address, NATIVE_MINT),
      moveTokensIx({ authority: owner.address, project, mint: NATIVE_MINT, from: { Pool: [index] }, to: { Account: [wsol] }, amount: { Fixed: [BigInt(amount)] }, reference: null }),
    ]);
    total += BigInt(amount);
  }
  // The owner's wrapped SOL (the pools just moved, and a treasury kept as wrapped SOL) back to plain SOL.
  // This also closes the game's treasury when it is that account (the default): the run is over, and the SOL comes
  // back. Anyone reading the chain after a run sees a treasury the agent didn't close.
  if (await rpc.account(wsol).catch(() => null)) await send(rpc, owner, [closeTokenAccount(wsol, owner.address, owner.address)]).catch(() => {});
  return Number(total);
}
