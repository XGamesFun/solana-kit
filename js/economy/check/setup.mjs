// The checks of the owner's setup: each step built as the plan builds it, on stand-in addresses, and measured
// against what one transaction holds.
import { MAX_TRANSACTION_BYTES } from '../../chain/tx.js';
// plan.mjs imports check() in turn: each module only calls the other's functions, never at load time.
import { placeholderContext, setupSteps, stepAloneBytes } from '../plan.mjs';
import { label } from '../format.mjs';
import { BUDGET, WALLET_ROOM } from '../txsize.mjs';

/** Checks that each step of the owner's setup fits one transaction. */
export function checkSetup(c) {
  const { economy, now, refusals, refuse, m } = c;
  // ---- the owner's setup: each step goes whole in one transaction (plan.mjs `pack`), so a step bigger than a setup
  // transaction may be (a box of many bundles, a recipe of many lines) could never go live. Built as the plan builds
  // it, on stand-in addresses.
  if (!refusals.length) {
    let setup = null;
    try {
      setup = setupSteps(economy, { now });
    } catch {
      // A spec the steps can't be built from fails the same way when it is planned.
    }
    const ctx = setup && placeholderContext(setup.model);
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
    for (const step of setup?.steps ?? []) {
      let bytes;
      try {
        bytes = stepAloneBytes(step, ctx);
      } catch {
        continue;
      }
      if (bytes <= BUDGET) continue;
      const [kind, key] = [step.part.split(':')[0], step.part.split(':').slice(1).join(':')];
      const part = lists[kind]?.get(key);
      const named = part
        ? `The ${kind === 'seed' ? 'seed of the pool' : kind === 'fund' ? 'funds of the grant' : kind} ${label(part)}`
        : `The setup step “${step.says}”`;
      const fix =
        kind === 'box'
          ? 'Give it fewer outcomes, or fewer prizes an outcome, or split it into two boxes.'
          : kind === 'recipe'
            ? 'Give it fewer lines, or split it into two recipes.'
            : 'Make it smaller (fewer entries, shorter names and links), or split it in two.';
      refuse(
        'E-TX-SIZE',
        paths[kind] ? `economy.${paths[kind]}${part ? `.${key}` : ''}` : 'economy',
        `${named} takes ${bytes} bytes to set up in one transaction, more than the ${BUDGET} a setup transaction may hold (${MAX_TRANSACTION_BYTES}, less ${WALLET_ROOM} kept for the compute unit limit and price it leads with), so it could never go live.`,
        fix,
      );
    }
  }
}
