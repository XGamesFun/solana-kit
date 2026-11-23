// The analyses that challenge a spec once nothing is refused (challenge.mjs), the pools that run dry at the
// scenario's rates, and a simulation that could not run.
import { challenge } from '../challenge.mjs';
import { farmRounding } from './farms.mjs';

/** Runs the analyses on a spec nothing refuses. */
export function checkAnalyses(c) {
  const { economy, now, refusals, warn, m, simulated } = c;
  // ---- the analyses that challenge a spec: follow the value, one intent one step, check every assumption
  if (!refusals.length) challenge(m, warn, now, economy, simulated);

  // ---- W-ASSUMPTION (challenge.mjs): pools that run dry at the scenario's rates (W-POOL-DRY, check/pools.mjs, names
  // a pool nothing fills): one that is filled but pays out faster drains, and then skips or fails what it owes.
  if (!refusals.length) {
    const sim = simulated();
    for (const p of sim?.pools ?? []) {
      if (p.lasts !== 'runs dry' || !(p.lastsDays < sim.scenario.days)) continue;
      const sym = m.tokens.get(p.token)?.symbol ?? p.token;
      const days = sim.scenario.days;
      const short = p.outPerDay - p.inPerDay;
      const need = !p.outs.some(o => o.percentPerDay !== undefined) && short > 0 ? +(short * days).toFixed(6) : null;
      const takersText = p.outs.map(o => o.by).join(', ');
      warn(
        'W-ASSUMPTION',
        `economy.pools.${p.key}`,
        `At the scenario’s rates “${p.key}” pays out ${+p.outPerDay.toFixed(6)} ${sym} a day (${takersText}) and takes in ${+p.inPerDay.toFixed(6)}: its seed of ${p.seed} ${sym} is gone on day ${p.lastsDays} of ${days}. After that what it owes is skipped or fails until money comes in.`,
        `Seed it with ${need !== null ? `at least ${need} ${sym} (${days} days at that rate)` : 'more'}, fill it with a share of a sale (a split to "pool:${p.key}") or a schedule, or pay less from it.`,
        { severity: 'medium' },
      );
    }
    for (const row of sim?.farms ?? []) farmRounding(m.farm.get(row.key), row, warn, m);
  }

  // ---- W-SIMULATION: the simulation could not run, so what rests on it was not checked. Said, never passed over.
  if (!refusals.length && c.simRun?.error)
    warn(
      'W-SIMULATION',
      'economy',
      `The simulation of this spec stopped on an error (${String(c.simRun.error?.message ?? c.simRun.error).slice(0, 200)}), so nothing that rests on its numbers was checked: whether a pool runs dry or a farm rounds a share to nothing at the scenario's rates, what a claim costs a grant's funds, and the rates the questions above would quote. That is a fault in these tools, not a finding about the spec, and this check is not a clean one.`,
      'Run xsolana_simulate on the spec to see the error, and report it with the spec. Until it runs, work those numbers out by hand before going live.',
      { severity: 'medium' },
    );
}
