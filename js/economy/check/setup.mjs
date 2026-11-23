// The checks of the owner's setup: each step built as the plan builds it, on stand-in addresses, and measured
// against what one transaction holds. What cannot be built at all is refused here too, so a spec the check passes is
// one the plan, the cost and the explanation can build.
import { MAX_TRANSACTION_BYTES } from '../../chain/tx.js';
// plan.mjs imports check() in turn: each module only calls the other's functions, never at load time.
import { contestBytes, placeholderContext, setupSteps, stepAloneBytes } from '../plan.mjs';
import { label } from '../format.mjs';
import { BUDGET, WALLET_ROOM } from '../txsize.mjs';

/** Checks that the owner's setup can be built, and that each step of it fits one transaction. */
export function checkSetup(c) {
  const { economy, now, refusals, refuse, m, unbuilt } = c;
  /**
   * Refuses what could not be built. Every value a part writes is refused in words where it is written, by that
   * part's own check; an error that reaches here is one no check named, so it is said as it was thrown, with the part
   * it came from, and as the tools' fault. The plan would stop on it too.
   */
  const refuseUnbuilt = (where, what, error) => {
    const said = String(error?.message ?? error).slice(0, 200);
    refuse(
      'E-BUILD',
      where,
      `${what} could not be built for the program: ${said}${/[.!?]$/.test(said) ? '' : '.'} The plan, the cost and the explanation of this spec stop on the same error. No check named the value that causes it, which is a fault in these tools.`,
      `Look in ${where === 'economy' ? 'the spec' : 'that part'} for a number, an amount or a time far out of range${error?.fix ? ` (${error.fix})` : ''}, and report the spec with this message.`,
    );
  };
  if (refusals.length) return;
  // What a part's own check could not build to measure it, once nothing else is refused.
  for (const { where, what, error } of unbuilt) refuseUnbuilt(where, what, error);
  if (refusals.length) return;
  // ---- the owner's setup: each step goes whole in one transaction (plan.mjs `pack`), so a step bigger than a setup
  // transaction may be (a box of many bundles, a recipe of many lines) could never go live. Built as the plan builds
  // it, on stand-in addresses.
  {
    let setup;
    try {
      setup = setupSteps(economy, { now });
    } catch (error) {
      refuseUnbuilt('economy', 'The setup', error);
      return;
    }
    const ctx = placeholderContext(setup.model);
    const lists = {
      box: m.box,
      item: m.item,
      recipe: m.recipe,
      schedule: new Map(m.schedules.map(x => [x.key, x])),
      lottery: m.lottery,
      grant: m.grant,
      farm: m.farm,
      auction: m.auction,
      pool: m.pool,
      seed: m.pool,
      fund: m.grant,
      stash: m.stash,
      table: m.table,
    };
    const paths = {
      box: 'boxes',
      item: 'items',
      recipe: 'recipes',
      schedule: 'schedules',
      lottery: 'lotteries',
      grant: 'grants',
      farm: 'farms',
      auction: 'auctions',
      pool: 'pools',
      seed: 'pools',
      fund: 'grants',
      stash: 'stashes',
      table: 'tables',
      token: 'tokens',
      traits: 'traits',
    };
    for (const step of setup.steps) {
      const [kind, key] = [step.part.split(':')[0], step.part.split(':').slice(1).join(':')];
      const part = lists[kind]?.get(key);
      const named = part
        ? `The ${kind === 'seed' ? 'seed of the pool' : kind === 'fund' ? 'funds of the grant' : kind} ${label(part)}`
        : `The setup step “${step.says}”`;
      const where = paths[kind] ? `economy.${paths[kind]}${part ? `.${key}` : ''}` : 'economy';
      let bytes;
      try {
        bytes = stepAloneBytes(step, ctx);
      } catch (error) {
        refuseUnbuilt(where, named, error);
        continue;
      }
      if (bytes <= BUDGET) continue;
      const fix =
        kind === 'box'
          ? 'Give it fewer outcomes, or fewer prizes an outcome, or split it into two boxes.'
          : kind === 'recipe'
            ? 'Give it fewer lines, or split it into two recipes.'
            : 'Make it smaller (fewer entries, shorter names and links), or split it in two.';
      refuse(
        'E-TX-SIZE',
        where,
        `${named} takes ${bytes} bytes to set up in one transaction, more than the ${BUDGET} a setup transaction may hold (${MAX_TRANSACTION_BYTES}, less ${WALLET_ROOM} kept for the compute unit limit and price it leads with), so it could never go live.`,
        fix,
      );
    }
    // A contest is opened by the authority once the economy is live, so no step of the setup writes it. The cost sizes
    // its record as it would be opened now (plan.mjs `contestBytes`): built here the same way.
    for (const contest of m.contests) {
      try {
        contestBytes(contest, m);
      } catch (error) {
        refuseUnbuilt(`economy.contests.${contest.key}`, `The contest ${label(contest)}`, error);
      }
    }
  }
}
