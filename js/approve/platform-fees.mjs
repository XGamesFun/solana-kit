// The fees the program charges, read from the platform account on the chain, beside the ones the tools quote. The
// tools are offline: check, simulate and cost quote `FEES_ON` (js/economy/model.mjs), the values at this release. The
// platform's admin can change them (a raise waits 7 days, a cut applies at once), so what reads the chain anyway
// (approve, status) reads the platform account too, and says when it charges, or will charge, other fees.
import { decode } from '../client/accounts.js';
import { cluster, lootProgram } from '../client/cluster.js';
import { pda } from '../client/pda.js';
import { FEES_ON } from '../economy/model.mjs';

const sol = lamports => Number(lamports) / 1e9;

/**
 * The platform's fees as `read(address)` (an RPC's or a chain's account read) gives the platform account, compared
 * with the ones these tools quote for this cluster: { fees, quoted, pending, pendingAt, differs, words } (sol), or
 * null when there is no platform account to read. `words` is null when they agree and nothing waits.
 */
export async function platformFees(read, { now = Math.floor(Date.now() / 1000) } = {}) {
  const account = await read(pda.platform());
  if (!account || account.owner !== lootProgram()) return null;
  const p = decode('Platform', account.data);
  const quoted = FEES_ON[cluster()];
  const fees = { playerSol: sol(p.fees.player), projectSol: sol(p.fees.project) };
  const q = { playerSol: sol(quoted.player), projectSol: sol(quoted.project) };
  const pendingAt = Number(p.pending_at ?? 0);
  const pending =
    pendingAt > 0 ? { playerSol: sol(p.pending.player), projectSol: sol(p.pending.project), at: pendingAt } : null;
  const differs = fees.playerSol !== q.playerSol || fees.projectSol !== q.projectSol;
  const changing = pending && (pending.playerSol !== fees.playerSol || pending.projectSol !== fees.projectSol);
  const words = [
    differs
      ? `The platform charges a player fee of ${fees.playerSol} SOL and a project fee of ${fees.projectSol} SOL on ${cluster()}, where these tools quote ${q.playerSol} and ${q.projectSol} (the values at this release): check, simulate and cost are off by the difference.`
      : '',
    changing
      ? `A fee change waits on the platform: from ${new Date(pendingAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}${pendingAt <= now ? ' (due now)' : ''}, a player fee of ${pending.playerSol} SOL and a project fee of ${pending.projectSol} SOL.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { fees, quoted: q, pending, differs, words: words || null };
}
