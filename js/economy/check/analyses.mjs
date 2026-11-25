// The analyses that challenge a spec once nothing is refused (challenge.mjs), the pools that run dry at the
// scenario's rates, and a simulation that could not run.
import { challenge } from '../challenge.mjs';
import { networkOf } from '../../client/cluster.js';
import { FEES_ON } from '../model.mjs';
import { farmRounding } from './farms.mjs';

/** The share of a price in SOL above which what goes on top of it is warned of (W-ON-TOP), on mainnet's fees. */
export const ON_TOP_SHARE = 0.2;
const MAINNET_PLAYER_FEE = Number(FEES_ON.mainnet.player) / 1e9;
const sol = x => +x.toFixed(9);

/** Runs the analyses on a spec nothing refuses. */
export function checkAnalyses(c) {
  const { economy, now, refusals, warn, warnings, m, simulated } = c;
  // ---- the analyses that challenge a spec: follow the value, one intent one step, check every assumption
  if (!refusals.length) challenge(m, warn, now, economy, simulated);

  // ---- W-TREASURY: on mainnet, a spec that names no treasury pays what sales leave to the owner's own address, the
  // key that goes live (with --keypair, a key file on a computer). Said before going live, while it can still change.
  if (!refusals.length && networkOf(economy) === 'mainnet' && !economy.treasury && !economy.live)
    warn(
      'W-TREASURY',
      'economy.treasury',
      'This economy is on mainnet and names no "treasury": what sales leave (and a lottery’s cut) lands at the owner’s address, the key that goes live. With `xsolana approve --keypair`, that is a key file on a computer, so the revenue sits where anything that can read the file can take it.',
      'Set "treasury": "wallet:<address>" to a wallet you hold apart from the key file (a hardware wallet or a multisig) before going live: once live, the spec can no longer change it.',
      { severity: 'medium' },
    );

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
      const takersText = [...new Set(p.outs.map(o => o.by))].join(', ');
      warn(
        'W-ASSUMPTION',
        `economy.pools.${p.key}`,
        `At the scenario’s rates “${p.key}” pays out ${+p.outPerDay.toFixed(6)} ${sym} a day (${takersText}) and takes in ${+p.inPerDay.toFixed(6)}: its seed of ${p.seed} ${sym} is gone on day ${p.lastsDays} of ${days}. After that what it owes is skipped or fails until money comes in.`,
        `Seed it with ${need !== null ? `at least ${need} ${sym} (${days} days at that rate)` : 'more'}, fill it with a share of a sale (a split to "pool:${p.key}") or a schedule, or pay less from it.`,
        { severity: 'medium' },
      );
    }
    for (const row of sim?.farms ?? []) farmRounding(m.farm.get(row.key), row, warn, m);

    // ---- W-ON-TOP: what one action costs a player beyond a price in SOL (the player fee, the oracle, the network,
    // rent that never comes back), at mainnet's fees, is a large share of a cheap price.
    const parts = [
      ...(sim?.boxes ?? []).map(p => ['boxes', 'box', p, p.price]),
      ...(sim?.items ?? []).map(p => ['items', 'item', p, p.price]),
      ...(sim?.payments ?? []).map(p => ['payments', 'payment', p, p.amount]),
      ...(sim?.lotteries ?? []).map(p => ['lotteries', 'ticket of', p, p.price]),
    ];
    for (const [kind, what, p, price] of parts) {
      const rc = p.realCost;
      if (!rc || rc.totalSol === undefined || !(Number(price) > 0) || rc.atLeast) continue;
      const extra = sol(rc.extrasSol - rc.playerFeeSol + MAINNET_PLAYER_FEE);
      if (extra / Number(price) < ON_TOP_SHARE) continue;
      const pieces = [
        `${MAINNET_PLAYER_FEE} SOL player fee`,
        rc.oracleSol ? `${rc.oracleSol} SOL oracle fee` : '',
        `${rc.networkSol} SOL network fee`,
        rc.rentSol ? `${rc.rentSol} SOL ${rc.rentIs ?? 'rent'}, which never comes back` : '',
      ].filter(Boolean);
      const cheaper = [
        rc.rentSol && kind === 'boxes'
          ? 'give the item as a compressed NFT ("compressed": true on the outcome; the project opens one tree for them at setup) or as a "normal" item your backend keeps, neither of which holds a collectible’s rent, or give tokens instead'
          : '',
        rc.rentSol && kind === 'items'
          ? 'make it a "normal" item your backend keeps, which holds no collectible’s rent'
          : '',
        rc.oracleSol
          ? 'sell what needs no roll as a shop item (one outcome, nothing random), which asks no oracle'
          : '',
        'or raise the price, so the same costs are a smaller part of it',
      ].filter(Boolean);
      // (it says the player fee too: a W-FEE on the same price goes, so the fee is said once)
      const fee = warnings.findIndex(
        w =>
          w.code === 'W-FEE' && [`economy.${kind}.${p.key}.price`, `economy.${kind}.${p.key}.amount`].includes(w.where),
      );
      if (fee >= 0) warnings.splice(fee, 1);
      warn(
        'W-ON-TOP',
        `economy.${kind}.${p.key}`,
        `Each ${what} “${p.name ?? p.key}” costs a player about ${extra} SOL on top of its ${price} SOL price on mainnet, ${Math.round((extra / Number(price)) * 100)}% more: ${pieces.join(', ')}.${extra !== rc.extrasSol ? ` On devnet it is ${rc.extrasSol} SOL.` : ''}`,
        `To make it cheaper: ${cheaper.join('; ')}.`,
      );
    }
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
