// What an economy costs: going live (each account's rent, the program's fees, network fees, the seeds), and each
// action while it runs, for whoever signs it. In SOL unless a seed is in another token. Pure.
//
// Rent is (bytes + 128) × 5,080 lamports (model.mjs); the loot program's own records are sized byte for byte from
// their Borsh layout, others (a Core collection, a farm) roughly, and marked so.
import { boxOrderBytes, plan as compile, contestBytes, entryShape, farmEnds, roundRentOf } from './plan.mjs';
import {
  ACCOUNT_BYTES,
  CONTEST_ENTRY_BYTES,
  END_BYTES,
  entryWidth,
  LIMIT_RECORD_BYTES,
  ROUND_RECORD_BYTES,
} from '../client/index.js';
import {
  boxBuys,
  COLLECTIBLE_RENT,
  drawsOf,
  settleUnits,
  holdsRent,
  outcomeParts,
  SETTLE_RENT_UNIT,
  FEES,
  LAMPORTS_PER_SOL,
  ORACLE_FEE,
  RENT_PER_BYTE,
  SIGNATURE_FEE,
  model,
  prizeLine,
  prizeRolls,
  prizes,
  prizeWords,
  rent,
  toUnits,
} from './model.mjs';
import { inAll, round, simulate } from './simulate.mjs';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const sol = lamports => round(Number(lamports) / Number(LAMPORTS_PER_SOL));
/** Setup steps that are no loot instruction, and so charge no fee: a token minted, a token's name written again, the
 * collection made, SOL put in a grant's funds. Every other step is the owner or the authority calling loot, which
 * charges the project fee. */
const NO_FEE_STEP = /^(token:|name:|collection$|fund:|rent:)/;
/** Setup cost from a plan (plan.mjs `plan`). */
export function setupCost(plan, economy) {
  const m = model(economy);
  // An account that grows (a live stash taking more NFTs) pays rent for its new bytes only.
  const rentOf = c => (c.grows ? BigInt(c.bytes) * RENT_PER_BYTE : rent(c.bytes));
  // `fee`: what the program that makes an account keeps in it on top of its rent (Token Metadata's, for a token's name
  // on chain). It is not rent: it never comes back.
  const accounts = plan.transactions
    .flatMap(t => t.steps)
    .flatMap(s => s.creates ?? [])
    .map(c => ({
      ...c,
      lamports: rentOf(c).toString(),
      sol: sol(rentOf(c)),
      ...(c.fee ? { feeSol: sol(BigInt(c.fee)) } : {}),
    }));
  const rentLamports = accounts.reduce((n, a) => n + BigInt(a.lamports), 0n);
  const metadataLamports = accounts.reduce((n, a) => n + BigInt(a.fee ?? 0), 0n);
  const charged = plan.transactions.flatMap(t => t.steps).filter(s => !NO_FEE_STEP.test(s.id));
  const feeLamports = BigInt(charged.length) * FEES.project;
  const networkLamports = plan.transactions.reduce((n, t) => n + BigInt(t.signers.length) * SIGNATURE_FEE, 0n);
  // Only the seeds and grant funds this plan puts in: a change to a live economy doesn't pay its seeds again.
  const steps = new Set(plan.transactions.flatMap(t => t.steps).map(s => s.id));
  const seeds = {};
  let seedLamports = 0n;
  const funded = m.grants.filter(g => Number(g.fund ?? 0) > 0 && steps.has(`fund:${g.key}`));
  for (const g of funded) seedLamports += toUnits(g.fund, 9);
  // What the owner puts in from their own wallet: a pool's seed, a lottery's seed (into its pot), a farm's seed (into its
  // rewards vault), a sealed schedule's funds (into its vault, from the wallet).
  const putIn = (key, amount, step) => {
    if (!(Number(amount ?? 0) > 0) || !steps.has(step)) return;
    const t = m.tokens.get(key ?? m.currencyKey);
    seeds[t.symbol] = round((seeds[t.symbol] ?? 0) + Number(amount));
    if (t.wsol) seedLamports += toUnits(amount, 9);
  };
  for (const p of m.pools) putIn(p.currency, p.seed, `seed:${p.key}`);
  for (const l of m.lotteries) putIn(l.currency, l.seed, `seed:lottery:${l.key}`);
  for (const f of m.farms) putIn(f.rewardsToken, f.seed, `seed:farm:${f.key}`);
  // SOL a lottery holds for its rounds' rent: lent to each round, back at its close.
  for (const l of m.lotteries) if (steps.has(`rent:lottery:${l.key}`)) seedLamports += roundRentOf(l, m);
  for (const sc of m.schedules)
    if (sc.sealed && (sc.fundFrom ?? 'wallet') === 'wallet') putIn(sc.currency, sc.fund, `fund:${sc.key}`);
  const total = rentLamports + metadataLamports + feeLamports + networkLamports + seedLamports;
  const notes = [];
  if (accounts.some(a => a.approx))
    notes.push('Accounts marked “about” are sized roughly (a Core collection or an external token account).');
  if (Object.entries(seeds).some(([symbol]) => [...m.tokens.values()].some(t => t.wsol && t.symbol === symbol)))
    notes.push(
      'The total includes the SOL you put in: pools’, lotteries’ and farms’ seeds, and sealed schedules’ funds.',
    );
  if (m.lotteries.some(l => steps.has(`rent:lottery:${l.key}`)))
    notes.push(
      'The total includes the SOL lotteries hold for their rounds’ rent and their tickets’ entries (`roundRent`, sized by default for the rounds and purchases expected at once): each round borrows it and gives it back when it closes; it comes back to you when the lottery closes.',
    );
  if (funded.length)
    notes.push(
      'The total includes the SOL put in grants’ funds, which pays their claims; what is left goes back to you when a grant closes.',
    );
  notes.push('The network fee is 5,000 lamports a signature; a wallet may add a priority fee of its own.');
  return {
    accounts,
    rentSol: sol(rentLamports),
    metadataFeesSol: sol(metadataLamports),
    programFeesSol: sol(feeLamports),
    networkFeesSol: sol(networkLamports),
    seeds,
    totalSol: sol(total),
    transactions: plan.transactions.length,
    approvals: plan.approvals,
    notes,
  };
}

/**
 * What each action costs whoever signs it while the economy runs: xgames.fun's fee, the network's, and for anything
 * that asks MagicBlock's oracle for a random number (a box's open, a lottery's draw, the authority's `roll`) the
 * oracle's own fee (`oracleSol`, model.mjs ORACLE_FEE).
 */
export function actionCosts(economy, { now } = NO_OPTIONS) {
  const m = model(economy);
  // A player's real cost of one action, from the simulation (simulate.mjs realCostOf): the number to quote.
  const sim = simulate(economy, { now });
  const real = new Map([
    ...sim.items.map(x => [`item:${x.key}`, x.realCost]),
    ...sim.boxes.map(x => [`box:${x.key}`, x.realCost]),
    ...sim.payments.map(x => [`payment:${x.key}`, x.realCost]),
    ...sim.lotteries.map(x => [`lottery:${x.key}`, x.realCost]),
  ]);
  const rows = [];
  const row = (part, action, who, fee, deposits = [], extra, oracle = 0n) => {
    const r = real.get(part);
    rows.push({
      part,
      action,
      who,
      feeSol: sol(fee),
      ...(oracle ? { oracleSol: sol(oracle) } : {}),
      networkSol: sol(SIGNATURE_FEE),
      deposits,
      ...(extra ? { note: extra } : {}),
      ...(r ? { inAllSol: r.totalSol ?? null, onTopSol: r.extrasSol, holdSol: r.holdSol, inAll: inAll(r) } : {}),
    });
  };
  const back = (what, lamports, when) => ({ what, sol: sol(lamports), back: when });
  // An order holds its rent and the fee; the open lends its throwaway settle key what the settle may open or mint (a
  // collectible's rent for each item the richest outcome gives, each card of a pack), back unspent.
  const itemsOf = b =>
    drawsOf(b) * Math.max(0, ...(b.outcomes ?? []).map(o => outcomeParts(o).filter(p => holdsRent(p, m)).length));
  const order = b => [
    back('the order', rent(boxOrderBytes(b, m, 1, { opened: true })), 'at settle or refund'),
    ...(settleUnits(b, m)
      ? [
          back(
            `the SOL the open lends the throwaway key that settles it, for what its settle may open (${settleUnits(b, m)} × ${sol(SETTLE_RENT_UNIT)} SOL: each collectible, NFT of a stash, coin it may pay and NFT it rolls on)`,
            SETTLE_RENT_UNIT * BigInt(settleUnits(b, m)),
            `once the key has settled, less what it opened (a collectible’s rent is about ${sol(COLLECTIBLE_RENT)} SOL); all of it when the roll fails`,
          ),
        ]
      : []),
  ];
  // A box that needs no roll is bought in one step (`buy`): no order, and a collectible's rent is paid at once.
  const bought = b =>
    itemsOf(b)
      ? [
          back(
            `${itemsOf(b)} new collectible${itemsOf(b) > 1 ? 's' : ''}`,
            COLLECTIBLE_RENT * BigInt(itemsOf(b)),
            `never: it is the collectible’s own rent (about ${sol(COLLECTIBLE_RENT)} SOL each)`,
          ),
        ]
      : [];
  for (const b of m.shop)
    row(
      `item:${b.shopOf}`,
      `buy “${b.name}”`,
      'player',
      FEES.player,
      bought(b),
      'One transaction: the price is split and the item given at once.',
    );
  for (const b of m.boxes) {
    if (boxBuys(b, m))
      row(
        `box:${b.key}`,
        `buy “${b.name}”`,
        'player',
        FEES.player,
        bought(b),
        'One transaction: the price is split and what it gives handed over at once.',
      );
    else
      row(
        `box:${b.key}`,
        `open “${b.name}”`,
        'player',
        FEES.player,
        order(b),
        'The oracle’s fee is paid by whoever asks for the roll (the player, at the open) and a refund doesn’t return it.',
        ORACLE_FEE,
      );
  }
  for (const p of m.payments) row(`payment:${p.key}`, `pay “${p.name}”`, 'player', FEES.player);
  for (const r of m.recipes) {
    const made = (r.out ?? []).filter(l => l.gives === 'item' && !l.compressed).length;
    row(
      `recipe:${r.key}`,
      `craft “${r.name}”`,
      'player',
      FEES.player,
      made
        ? [
            back(
              `${made} new collectible${made > 1 ? 's' : ''}`,
              COLLECTIBLE_RENT * BigInt(made),
              `never: it is the collectible’s own rent (about ${sol(COLLECTIBLE_RENT)} SOL each)`,
            ),
          ]
        : [],
    );
  }
  for (const l of m.lotteries) {
    // A purchase adds its entry's bytes to the round. In a round the lottery opened, the SOL it holds for its rounds
    // (`roundRent`, on by default) pays them, back to it at the close: the buyer pays only the fee and the price. Without
    // it, or once it runs short, the buyer pays them (to the treasury at the close), and a round's first buyer fronts its
    // header. A share the buyer chooses makes each entry keep what arrived.
    const entry = BigInt(entryWidth(...entryShape(l))) * RENT_PER_BYTE;
    const held = roundRentOf(l, m);
    const funded = held > 0n;
    row(
      `lottery:${l.key}`,
      `buy tickets for “${l.name}”`,
      'player',
      FEES.player,
      funded
        ? []
        : [
            back(
              'the purchase’s entry in the round (its bytes)',
              entry,
              'never: it goes to the treasury when the round closes',
            ),
          ],
      funded
        ? `A round’s record, its token accounts and each purchase’s entry are paid from the SOL the lottery holds for them (${sol(held)} SOL), back to it when the round closes: a buyer pays no program rent. When that runs short, a buyer pays their entry’s bytes (about ${sol(entry)} SOL, to the treasury at the close) and a round’s first buyer fronts its header, back to them at the close.`
        : 'A round’s first buyer also fronts its record’s header and token accounts (about 0.003 SOL and up, more with many places), back to them when the round closes, once every part is pulled; `roundRent` (on by default) has the lottery pay them, and each entry too.',
    );
  }
  for (const f of m.farms) {
    // A seat that can stop earning writes its end in the farm's record: a new time costs whoever writes it, spare rent first.
    const endRent = BigInt(END_BYTES) * RENT_PER_BYTE;
    row(
      `farm:${f.key}`,
      `stake in “${f.name}”`,
      'player',
      FEES.player,
      [
        back('the seat', rent(ACCOUNT_BYTES.Seat), 'when they take everything out'),
        ...(farmEnds(f)
          ? [
              back(
                `a new end time in the farm’s record of ends (${END_BYTES} bytes; none when another seat ends at that second, or spare rent in the record covers it)`,
                endRent,
                'never: it stays with the record for the next time written',
              ),
            ]
          : []),
      ],
      farmEnds(f)
        ? 'Whatever writes a new end time (a stake, a booster put on, a refresh that reads new upkeep) pays its bytes, its sender’s.'
        : undefined,
    );
    row(
      `farm:${f.key}`,
      `unstake or harvest from “${f.name}”`,
      'player',
      FEES.player,
      [],
      [
        (f.tiers ?? []).some(t => t.exitFee) &&
          'Leaving a tier before its lock leaves its exit fee of what is taken out, and keeps the rewards the seat was credited.',
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    );
  }
  for (const h of m.holds)
    row(`hold:${h.key}`, `hand in for “${h.name}”`, 'player', FEES.player, [
      back('the hold', rent(ACCOUNT_BYTES.Hold), 'when it is released'),
    ]);
  // What giving a prize opens, paid by whoever sends the instruction that gives it (prize.rs).
  const opens = p =>
    prizeLine(p)?.compressed
      ? ', and the compressed NFT, which has no rent'
      : ({
          item: ', plus the collectible’s rent',
          tokens: ', plus the winner’s token account for the prize when they have none',
          share: ', plus the winner’s token account for the prize when they have none',
          nft: ', and the NFT is handed over in the claim (a Token Metadata NFT opens the winner’s token account of it)',
          roll: ', plus the roll’s order (below)',
        }[prizeLine(p)?.gives] ?? '');
  for (const g of m.grants)
    row(
      `grant:${g.key}`,
      `claim “${g.name}”`,
      'the winner, who signs every claim (anyone may pay its fees)',
      FEES.player,
      [],
      `Only the winning wallet can claim: it signs, whatever proves it won (a voucher, a list, an open grant). Whoever pays the transaction pays the player fee from its own SOL; its records (${LIMIT_RECORD_BYTES} bytes a wallet, ${ROUND_RECORD_BYTES} a round it is paid)${opens(g.prize ?? g.gives)} come from the grant’s funds (the sender pays what they can’t), and go back to the owner when its shards close after the grant: xsolana_simulate gives what to put in its funds per claim.`,
    );
  // A prize of a collectible given when a place is paid or a winning entry claimed: its rent, from whoever sends it.
  for (const p of prizes(m).filter(
    p => p.prize.gives === 'item' && !p.prize.compressed && !['grant', 'recipe'].includes(p.route),
  ))
    row(
      p.by,
      `give ${prizeWords(p.prize, m)} (${p.route})`,
      p.route === 'mission'
        ? 'the player leaving the mission'
        : p.route === 'contest'
          ? 'whoever claims the winning entry'
          : 'whoever pays the place',
      0n,
      [back('the new collectible', COLLECTIBLE_RENT, 'never: it is the collectible’s own rent')],
    );
  for (const c of m.contests) {
    row(
      `contest:${c.key}`,
      `back a side in “${c.name}”`,
      'player',
      FEES.player,
      [
        back(
          'the entry’s bytes in the contest’s list',
          BigInt(c.stakeNft ? CONTEST_ENTRY_BYTES.nfts : CONTEST_ENTRY_BYTES.tokens) * RENT_PER_BYTE,
          'never: they go to the treasury when the contest closes',
        ),
      ],
      'A loser of a contest of tokens sends nothing more; every other entry is paid by a claim anyone may send.',
    );
    row(`contest:${c.key}`, `open “${c.name}”`, 'authority', FEES.project, [
      back('the contest and its pot', rent(contestBytes(c, m)) + rent(165), 'when it closes'),
    ]);
    row(`contest:${c.key}`, `decide “${c.name}”`, 'authority', FEES.project);
  }
  for (const a of m.auctions) {
    row(
      `auction:${a.key}`,
      `bid on “${a.name}”`,
      'player',
      FEES.player,
      [],
      'Nothing to deposit: the bid waits in the game’s vault, and goes back at once when it is topped.',
    );
    const minted = a.lot?.item && (m.item.get(a.lot.item)?.kind ?? 'collectible') === 'collectible';
    row(
      `auction:${a.key}`,
      `end “${a.name}”`,
      'anyone (the winner, a keeper)',
      0n,
      minted
        ? [
            back(
              'the new collectible',
              COLLECTIBLE_RENT,
              'never: it is the collectible’s own rent, paid by whoever ends it',
            ),
          ]
        : [],
      'Its own rent goes back to whoever opened it.',
    );
  }
  for (const s of m.stashes)
    row(`stash:${s.key}`, `put an NFT in “${s.name}”, or take one out`, 'the owner or the authority', FEES.project, [
      back(
        '32 bytes more of the stash for each NFT in it',
        32n * RENT_PER_BYTE,
        'to whoever takes one out; a roll leaves it with the stash, for the next one put in',
      ),
    ]);
  // A prize that is a roll of a box: whoever sends the claim, the payment, the end (or a grant's funds) makes its order.
  for (const r of prizeRolls(m).filter(r => !['mission', 'recipe'].includes(r.route))) {
    const name = m.box.get(r.box)?.name ?? r.box;
    const who =
      r.route === 'grant'
        ? 'the grant’s funds (the sender, what they can’t)'
        : r.route === 'auction'
          ? 'whoever ends it'
          : r.route === 'contest'
            ? 'whoever claims the winning entry'
            : 'whoever pays the place';
    // Whoever settles it pays a collectible's rent when its box gives one (an item outcome).
    const mints = (m.box.get(r.box)?.outcomes ?? []).flatMap(outcomeParts).some(o => holdsRent(o, m));
    row(
      r.by,
      `make a winner’s roll of “${name}” (${r.route})`,
      who,
      0n,
      [back('the roll’s order', rent(boxOrderBytes(m.box.get(r.box), m)), 'to the winner when it is settled')],
      `Then the winner or the project’s keys ask the oracle for the roll (its fee, below) and settle it${mints ? `, paying the collectible’s rent when it gives one (about ${sol(COLLECTIBLE_RENT)} SOL)` : ''}.`,
    );
    row(
      r.by,
      `ask for the roll of “${name}”`,
      'the winner or the project’s keys',
      0n,
      [],
      'It asks MagicBlock’s oracle, which takes its fee from whoever asks; a refund doesn’t return it.',
      ORACLE_FEE,
    );
  }
  for (const d of m.decisions)
    row(
      `decision:${d.key}`,
      d.when,
      'authority',
      FEES.project,
      [],
      d.does === 'roll' ? 'The roll asks MagicBlock’s oracle, which takes its own fee from the authority.' : undefined,
      d.does === 'roll' ? ORACLE_FEE : 0n,
    );
  if (m.allBoxes.some(b => !boxBuys(b, m)))
    row(
      'orders',
      'settle an order',
      'the player, a key they named, or the project’s keys',
      0n,
      [],
      'The sender pays what the settle opens or mints (a collectible’s rent, a token account the player lacks); the order’s rent goes back to the player. js/play’s throwaway key sends it with what the open lent it.',
    );
  if (m.schedules.length)
    row(
      'schedules',
      'run a schedule when it is due',
      'the project’s keys, or who it pays (a sealed one’s recipient, from their page)',
      0n,
      [],
      `A run missed is missed: one sent late pays once, for the latest run due, and the runs before it lapse.${m.schedules.some(sc => sc.sealed) ? ' A sealed schedule pays from its own vault, and its fixed amount pays every run due, in one transaction.' : ''}`,
    );
  if (m.lotteries.length) {
    row(
      'lotteries',
      'ask for a draw',
      'anyone (a keeper, or a player)',
      0n,
      [],
      'The draw asks MagicBlock’s oracle for the winning numbers, and fixes the round’s money first (the next round sells at once); the oracle takes its fee from whoever sends the draw. An oracle that never answers within about a week: the next ask cancels the round, and every ticket is refunded.',
      ORACLE_FEE,
    );
    row(
      'lotteries',
      'pull a part: a refund, a place’s part of the pot or its prize, a share owed in common',
      'anyone (the winner’s page, a keeper)',
      0n,
      [],
      'Each part is pulled by itself, in any order, and the pull that leaves nothing owed closes the round; whoever pulls opens the payee’s token account when it is missing.',
    );
    if (m.lotteries.some(l => l.minSold))
      row(
        'lotteries',
        'a short round',
        'anyone',
        0n,
        [],
        'A round that sold fewer tickets than its least is cancelled at its draw, with no oracle fee, and every ticket refunded.',
      );
  }
  return rows;
}

/** Setup and play costs for a spec, or its refusals. */
/** `only` and `live`: a change to a live economy, priced as only what it publishes (live.mjs `changedParts`). */
export function cost(economy, { now = Math.floor(Date.now() / 1000), only = null, live = null, renames = null } = {}) {
  const plan = compile(economy, { now, only, live, renames });
  if (!plan.ok) return plan;
  return {
    ok: true,
    setup: setupCost(plan, economy),
    actions: actionCosts(economy, { now }),
    fees: { playerSol: sol(FEES.player), projectSol: sol(FEES.project), oracleSol: sol(ORACLE_FEE) },
  };
}

/** The cost in plain words. */
export function explainCost(c) {
  const s = c.setup;
  const lines = [
    `Going live takes ${s.transactions} transaction${s.transactions === 1 ? '' : 's'} (${s.approvals} wallet approval${s.approvals === 1 ? '' : 's'}) and about ${s.totalSol} SOL:`,
  ];
  lines.push(
    `  rent ${s.rentSol} SOL for ${s.accounts.length} accounts; program fees ${s.programFeesSol} SOL; network fees ${s.networkFeesSol} SOL${
      s.metadataFeesSol ? `; Token Metadata’s fees ${s.metadataFeesSol} SOL (a token’s name on chain)` : ''
    }${
      Object.keys(s.seeds).length
        ? `; seeds ${Object.entries(s.seeds)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ')}`
        : ''
    }.`,
  );
  for (const a of s.accounts)
    lines.push(
      `  ${a.approx ? 'about ' : ''}${a.sol} SOL: ${a.what} (${a.bytes} bytes)${a.feeSol ? `, and ${a.feeSol} SOL Token Metadata keeps for it` : ''}`,
    );
  lines.push('While it runs (for a player, quote the “in all” number: it is what leaves their wallet for good):');
  for (const r of c.actions) {
    const deposits = r.deposits.map(d => `${d.sol} SOL for ${d.what} (back: ${d.back})`).join('; ');
    if (r.inAll) {
      lines.push(`  ${r.action} (${r.who}): ${r.inAll}${r.note ? `. ${r.note}` : ''}`);
      continue;
    }
    lines.push(
      `  ${r.action} (${r.who}): ${r.feeSol ? `${r.feeSol} SOL fee + ` : ''}${r.oracleSol ? `${r.oracleSol} SOL to the oracle + ` : ''}${r.networkSol} SOL network${deposits ? `; ${deposits}` : ''}${r.note ? `. ${r.note}` : ''}`,
    );
  }
  for (const n of s.notes) lines.push(n);
  return lines.join('\n');
}
