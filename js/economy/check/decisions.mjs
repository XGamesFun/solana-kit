// The checks of parts switched off, of decisions (what only the game knows), and the warnings that span the
// economy: voucher keys, a chance at money or at items, the scenario's names and the authority.
import { realMoney } from '../../client/pda.js';
import { isAddress } from '../model.mjs';
import { label } from '../format.mjs';
import { isCollectible } from '../sizes.mjs';

/** Checks the parts switched off, the decisions and what spans the economy. */
export function checkDecisions(c) {
  const { refuse, warn, m, units, percent, token, pool, item, rolls } = c;
  // ---- parts switched off: saved as a draft (waiting for a voucher key, a date), they do nothing once live, while the
  // person may hear about them as if they worked. A box only prizes, missions or recipes roll is meant to be off.
  const OFF = {
    items: 'buy it or be given it',
    boxes: 'open it',
    recipes: 'craft it',
    schedules: 'run it',
    grants: 'claim it',
  };
  for (const [list, what] of Object.entries(OFF))
    for (const x of m[list])
      if (
        x.active === false &&
        !(list === 'boxes' && rolls.some(r => r.box === x.key)) &&
        !(list === 'schedules' && x.sealed)
      )
        warn(
          'W-OFF',
          `economy.${list}.${x.key}.active`,
          `${label(x)} is switched off: once live, nobody can ${what} until it is switched on and published again.`,
          'Tell the person it is off and what it waits for, or switch it on ("active": true) once that is ready.',
        );

  // ---- decisions: what only the game knows
  for (const d of m.decisions) {
    const where = `economy.decisions.${d.key}`;
    if (d.does === 'payout' || d.does === 'burn') {
      const p = d.pool
        ? pool(d.pool, `${where}.pool`)
        : refuse(
            'E-DECISION',
            where,
            `${label(d)} ${d.does === 'payout' ? 'pays out' : 'burns'} but does not say from which pool.`,
            'Add "pool".',
          );
      if (d.does === 'burn' && p && m.tokens.get(p.currency)?.wsol)
        refuse(
          'E-WSOL-BURN',
          `${where}.pool`,
          `${label(d)} burns SOL, and wrapped SOL cannot be burned.`,
          'Pay it out instead.',
        );
      if (p && d.amount !== undefined)
        units(d.amount, m.tokens.get(p.currency), `${where}.amount`, `${label(d)}’s amount`);
      if (d.percent !== undefined) percent(d.percent, `${where}.percent`);
    }
    if (d.does === 'issue') {
      const tok = token(d.currency, `${where}.currency`);
      if (tok && !tok.gameMints)
        refuse(
          'E-MINT-NOT-OURS',
          where,
          `${label(d)} mints ${tok.symbol}, but the project cannot mint it.`,
          'Pay it from a pool instead, or use a token with source "project".',
        );
    }
    if (['make', 'unmake', 'set'].includes(d.does)) {
      const it = d.item
        ? item(d.item, `${where}.item`)
        : refuse('E-DECISION', where, `${label(d)} works on a collectible but does not say which item.`, 'Add "item".');
      if (it && !isCollectible(it))
        refuse(
          'E-DECISION',
          `${where}.item`,
          `${label(d)} works on ${label(it)}, which is not a collectible.`,
          `Make ${label(it)} a collectible.`,
        );
      if (it && d.does === 'unmake' && !it.burnable)
        refuse(
          'E-DECISION',
          `${where}.item`,
          `${label(d)} burns ${label(it)}, but only items marked burnable can be burned by the game.`,
          `Mark ${label(it)} "burnable": true before any is issued.`,
        );
    }
    if (d.does === 'award' && !(d.hold && m.hold.get(d.hold)))
      refuse(
        'E-REF',
        `${where}.hold`,
        `${label(d)} awards a held collectible but names no hold that exists.`,
        'Name one of "holds".',
      );
    if ((d.does === 'decide' || d.does === 'open_contest') && !(d.contest && m.contest.get(d.contest)))
      refuse(
        'E-REF',
        `${where}.contest`,
        `${label(d)} works on a contest but names none that exists.`,
        'Name one of "contests".',
      );
    if (d.proof && !m.payments.some(p => p.key === d.proof.payment))
      refuse(
        'E-REF',
        `${where}.proof.payment`,
        `${label(d)} asks for proof of the payment “${d.proof.payment}”, which is not one of the economy’s payments.`,
        'Name one of "payments" (the attempt players pay for).',
      );
    if (d.signedBy === 'server' && m.authority === 'owner')
      warn(
        'W-AUTHORITY',
        where,
        `${label(d)} is signed by your server, but the authority is still your own wallet: that would put your wallet’s key on a machine that signs by itself.`,
        'Give the authority its own address ("keys.authority"), made for that server.',
      );
  }
  const needs = [
    ...m.decisions.map(d => `${label(d)} (when ${d.when})`),
    ...m.contests.map(c =>
      (c.deciders ?? []).length
        ? `opening ${label(c)} (its deciders’ keys name who won)`
        : `naming who won ${label(c)}`,
    ),
    ...m.holds.map(h => `saying where ${label(h)}’s collectibles go`),
  ];
  if (needs.length)
    warn(
      'W-AUTHORITY',
      'economy.keys.authority',
      `This economy needs the authority while it runs, for what only the game knows: ${needs.join('; ')}. ${m.authority === 'owner' ? 'That is the project’s owner key, which signs each one.' : `That is the key ${m.authority}.`}`,
    );
  const voucherKeys = [...new Set(m.grants.flatMap(g => [...(g.vouchers ?? []), ...(g.keys ?? [])]))];
  if (voucherKeys.length)
    warn(
      'W-VOUCHERS',
      'economy.grants',
      `A voucher key signs who earned a grant: whatever holds it (your server, a play host) decides who gets rewards, within the limits the program keeps. The program does not check that a player really did what the voucher says. The keys: ${voucherKeys.join(', ')}.`,
      'Say on each such grant what its server checks before it signs ("trust": "decides", "replays" or "bounds"), run xsolana_review, and tell the person what a cheater gets.',
    );

  if (c.randomItems && !c.chance)
    warn(
      'W-CHANCE-ITEMS',
      'economy',
      `Players pay for a random collectible they can resell (a loot box or gacha). Some places treat paid loot boxes of tradeable items as gambling, and many require the odds to be shown. ${realMoney() ? 'This economy is on mainnet, so it is real money: counsel and an age and region gate come first.' : 'This economy is on devnet; before mainnet, counsel and an age and region gate.'}`,
      'Tell the person, as xsolana_check’s “The law” line puts it, once now and again before mainnet; show the odds on the page, and get a lawyer before real money.',
    );
  if (c.chance)
    warn(
      'W-CHANCE-PRIZE',
      'economy',
      `Players pay for a chance at money (a box that pays a prize, a lottery). That is gambling in many places once it is real money, and paid packs with a cash buyback are drawing lawsuits. ${realMoney() ? 'This economy is on mainnet, so it is real money: counsel and an age and region gate come first.' : 'This economy is on devnet; before mainnet, counsel and an age and region gate.'}`,
      'Tell the person, as xsolana_check’s “The law” line puts it, once now and again before mainnet: before real money they need a lawyer and an age and region gate.',
    );

  for (const key of Object.keys(m.scenario.perDay ?? {})) {
    const [kind, name] = key.split(':');
    const list = {
      box: m.box,
      item: m.item,
      recipe: m.recipe,
      lottery: m.lottery,
      farm: m.farm,
      contest: m.contest,
      auction: m.auction,
      hold: m.hold,
      grant: m.grant,
      payment: new Map(m.payments.map(p => [p.key, p])),
    }[kind];
    if (!list?.has(name))
      warn(
        'W-SCENARIO',
        `economy.scenario.perDay.${key}`,
        `The scenario counts “${key}”, which is not in the economy.`,
        'Remove it, or fix the name.',
      );
  }
  for (const key of Object.keys(m.scenario.staked ?? {}))
    if (!m.farm.has(key))
      warn(
        'W-SCENARIO',
        `economy.scenario.staked.${key}`,
        `The scenario stakes in “${key}”, which is not a farm.`,
        'Remove it, or fix the name.',
      );
  if (typeof m.authority === 'string' && m.authority !== 'owner' && !isAddress(m.authority))
    refuse(
      'E-SCHEMA',
      'economy.keys.authority',
      'The authority is not an address.',
      'Write "owner" or a wallet’s public address.',
    );
}
