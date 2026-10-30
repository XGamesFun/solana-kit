// What an economy costs: going live (each account's rent, the program's fees, network fees, the seeds), and each
// action while it runs, for whoever signs it. In SOL unless a seed is in another token. Pure.
//
// Rent is (bytes + 128) × 5,080 lamports (model.mjs); the loot program's own records are sized byte for byte from
// their Borsh layout, others (a Core collection, a farm) roughly, and marked so.
import { plan as compile, contestBytes } from './plan.mjs';
import { ACCOUNT_BYTES } from '../client/index.js';
import { boxBuys, boxRolls, COLLECTIBLE_RENT, outcomeParts, ESCROW_LAMPORTS, FEES, LAMPORTS_PER_SOL, ORACLE_FEE, RENT_PER_BYTE, SIGNATURE_FEE, model, prizeLine, prizeRolls, prizes, prizeWords, rent, toUnits } from './model.mjs';
import { inAll, round, simulate } from './simulate.mjs';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const sol = (lamports) => round(Number(lamports) / Number(LAMPORTS_PER_SOL));
/** Setup steps that are no loot instruction, and so charge no fee: a token minted, the collection made, SOL put in a
 * grant's funds. Every other step is the owner or the authority calling loot, which charges the project fee. */
const NO_FEE_STEP = /^(token:|collection$|fund:)/;
/** Setup cost from a plan (plan.mjs `plan`). */
export function setupCost(plan, economy) {
  const m = model(economy);
  // An account that grows (a live stash taking more NFTs) pays rent for its new bytes only.
  const rentOf = (c) => (c.grows ? BigInt(c.bytes) * RENT_PER_BYTE : rent(c.bytes));
  const accounts = plan.transactions.flatMap((t) => t.steps).flatMap((s) => s.creates ?? []).map((c) => ({ ...c, lamports: rentOf(c).toString(), sol: sol(rentOf(c)) }));
  const rentLamports = accounts.reduce((n, a) => n + BigInt(a.lamports), 0n);
  const charged = plan.transactions.flatMap((t) => t.steps).filter((s) => !NO_FEE_STEP.test(s.id));
  const feeLamports = BigInt(charged.length) * FEES.project;
  const networkLamports = plan.transactions.reduce((n, t) => n + BigInt(t.signers.length) * SIGNATURE_FEE, 0n);
  // Only the seeds and grant funds this plan puts in: a change to a live economy doesn't pay its seeds again.
  const steps = new Set(plan.transactions.flatMap((t) => t.steps).map((s) => s.id));
  const seeds = {};
  let seedLamports = 0n;
  const funded = m.grants.filter((g) => Number(g.fund ?? 0) > 0 && steps.has(`fund:${g.key}`));
  for (const g of funded) seedLamports += toUnits(g.fund, 9);
  // What the owner puts in from their own wallet: a pool's seed, a lottery's seed (into its pot), a sealed schedule's
  // funds (into its vault, from the wallet).
  const putIn = (key, amount, step) => {
    if (!(Number(amount ?? 0) > 0) || !steps.has(step)) return;
    const t = m.tokens.get(key ?? m.currencyKey);
    seeds[t.symbol] = round((seeds[t.symbol] ?? 0) + Number(amount));
    if (t.wsol) seedLamports += toUnits(amount, 9);
  };
  for (const p of m.pools) putIn(p.currency, p.seed, `seed:${p.key}`);
  for (const l of m.lotteries) putIn(l.currency, l.seed, `seed:lottery:${l.key}`);
  for (const sc of m.schedules) if (sc.sealed && (sc.fundFrom ?? 'wallet') === 'wallet') putIn(sc.currency, sc.fund, `fund:${sc.key}`);
  const total = rentLamports + feeLamports + networkLamports + seedLamports;
  const notes = [];
  if (accounts.some((a) => a.approx)) notes.push('Accounts marked “about” are sized roughly (a Core collection or an external token account).');
  if (Object.entries(seeds).some(([symbol]) => [...m.tokens.values()].some((t) => t.wsol && t.symbol === symbol))) notes.push('The total includes the SOL you put in: pools’ and lotteries’ seeds, and sealed schedules’ funds.');
  if (funded.length) notes.push('The total includes the SOL put in grants’ funds, which pays their claims; what is left goes back to you when a grant closes.');
  notes.push('The network fee is 5,000 lamports a signature; a wallet may add a priority fee of its own.');
  return {
    accounts,
    rentSol: sol(rentLamports),
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
 * What each action costs whoever signs it while the economy runs: games.fun's fee, the network's, and for anything
 * that asks MagicBlock's oracle for a random number (a box's open, a lottery's draw, the authority's `roll`) the
 * oracle's own 0.0005 SOL (`oracleSol`, model.mjs ORACLE_FEE).
 */
export function actionCosts(economy, { now } = NO_OPTIONS) {
  const m = model(economy);
  // A player's real cost of one action, from the simulation (simulate.mjs realCostOf): the number to quote.
  const sim = simulate(economy, { now });
  const real = new Map([...sim.items.map((x) => [`item:${x.key}`, x.realCost]), ...sim.boxes.map((x) => [`box:${x.key}`, x.realCost]), ...sim.payments.map((x) => [`payment:${x.key}`, x.realCost]), ...sim.lotteries.map((x) => [`lottery:${x.key}`, x.realCost])]);
  const rows = [];
  const row = (part, action, who, fee, deposits = [], extra, oracle = 0n) => {
    const r = real.get(part);
    rows.push({ part, action, who, feeSol: sol(fee), ...(oracle ? { oracleSol: sol(oracle) } : {}), networkSol: sol(SIGNATURE_FEE), deposits, ...(extra ? { note: extra } : {}), ...(r ? { inAllSol: r.totalSol ?? null, onTopSol: r.extrasSol, holdSol: r.holdSol, inAll: inAll(r) } : {}) });
  };
  const back = (what, lamports, when) => ({ what, sol: sol(lamports), back: when });
  // An order holds a collectible's rent for each item the richest outcome gives (order.rs `escrow`).
  const itemsOf = (b) => Math.max(0, ...(b.outcomes ?? []).map((o) => outcomeParts(o).filter((p) => p.gives === 'item').length));
  const order = (b) => [
    back('the order', rent(ACCOUNT_BYTES.Order), 'at settle or refund'),
    ...(itemsOf(b) ? [back(`the SOL the order holds for ${itemsOf(b) === 1 ? 'a collectible’s' : `${itemsOf(b)} collectibles’`} rent (the player fee is paid on top of it)`, ESCROW_LAMPORTS * BigInt(itemsOf(b)), `at settle, less each collectible’s rent (about ${sol(COLLECTIBLE_RENT)} SOL) it gives; all of it, and the fee, on a refund`)] : []),
  ];
  // A box that needs no roll is bought in one step (`buy`): no order, and a collectible's rent is paid at once.
  const bought = (b) => (itemsOf(b) ? [back(`${itemsOf(b)} new collectible${itemsOf(b) > 1 ? 's' : ''}`, COLLECTIBLE_RENT * BigInt(itemsOf(b)), `never: it is the collectible’s own rent (about ${sol(COLLECTIBLE_RENT)} SOL each)`)] : []);
  for (const b of m.shop) row(`item:${b.shopOf}`, `buy “${b.name}”`, 'player', FEES.player, bought(b), 'One transaction: the price is split and the item given at once.');
  for (const b of m.boxes) {
    if (boxBuys(b)) row(`box:${b.key}`, `buy “${b.name}”`, 'player', FEES.player, bought(b), 'One transaction: the price is split and what it gives handed over at once.');
    else row(`box:${b.key}`, `open “${b.name}”`, 'player', FEES.player, order(b), boxRolls(b) ? 'The oracle’s fee is paid by whoever asks for the roll (the player, at the open) and a refund doesn’t return it.' : undefined, boxRolls(b) ? ORACLE_FEE : 0n);
  }
  for (const p of m.payments) row(`payment:${p.key}`, `pay “${p.name}”`, 'player', FEES.player);
  for (const r of m.recipes) {
    const made = (r.out ?? []).filter((l) => l.gives === 'item' && !l.compressed).length;
    row(`recipe:${r.key}`, `craft “${r.name}”`, 'player', FEES.player, made ? [back(`${made} new collectible${made > 1 ? 's' : ''}`, COLLECTIBLE_RENT * BigInt(made), `never: it is the collectible’s own rent (about ${sol(COLLECTIBLE_RENT)} SOL each)`)] : []);
  }
  for (const l of m.lotteries) row(`lottery:${l.key}`, `buy tickets for “${l.name}”`, 'player', FEES.player, [back('the purchase’s record (its tickets)', rent(ACCOUNT_BYTES.LotteryContribution), 'when the round is done with it: drawn and its place paid, or refunded')]);
  for (const f of m.farms) {
    row(`farm:${f.key}`, `stake in “${f.name}”`, 'player', FEES.player, [back('the seat', rent(ACCOUNT_BYTES.Seat), 'when they take everything out')]);
    row(`farm:${f.key}`, `unstake or harvest from “${f.name}”`, 'player', FEES.player, [], [
      (f.tiers ?? []).some((t) => t.exitFee) && 'Leaving a tier before its lock leaves its exit fee of what is taken out.',
      f.unbond && `What is taken out waits ${f.unbond} first; a later unstake (or withdraw) takes it out.`,
      f.toll && `${f.toll.percent}% of every payout of rewards goes ${f.toll.to === 'burn' ? 'to a burn' : `to ${String(f.toll.to).slice(5)}`}.`,
    ].filter(Boolean).join(' ') || undefined);
  }
  for (const h of m.holds) row(`hold:${h.key}`, `hand in for “${h.name}”`, 'player', FEES.player, [back('the hold', rent(ACCOUNT_BYTES.Hold), 'when it ends')]);
  // What giving a prize opens, paid by whoever sends the instruction that gives it (prize.rs).
  const opens = (p) => prizeLine(p)?.compressed ? ', and the compressed NFT, which has no rent' : ({ item: ', plus the collectible’s rent', tokens: ', plus the winner’s token account for the prize when they have none', share: ', plus the winner’s token account for the prize when they have none', nft: ', and the NFT is handed over in the claim (a Token Metadata NFT opens the winner’s token account of it)', roll: ', plus the roll’s order (below)' })[prizeLine(p)?.gives] ?? '';
  for (const g of m.grants) row(`grant:${g.key}`, `claim “${g.name}”`, 'the winner, who signs every claim (anyone may pay its fees)', FEES.player, [], `Only the winning wallet can claim: it signs, whatever proves it won (a voucher, a list, an open grant). Whoever pays the transaction pays the player fee from its own SOL; a first claim’s receipt rent${opens(g.prize ?? g.gives)} comes from the grant’s funds (the sender pays what they can’t): xsolana_simulate gives what to put in its funds per claim.`);
  // A prize of a collectible given when a place is paid or a winning entry claimed: its rent, from whoever sends it.
  for (const p of prizes(m).filter((p) => p.prize.gives === 'item' && !p.prize.compressed && !['grant', 'recipe'].includes(p.route)))
    row(p.by, `give ${prizeWords(p.prize, m)} (${p.route})`, p.route === 'mission' ? 'the player leaving the mission' : p.route === 'contest' ? 'whoever claims the winning entry' : 'whoever pays the place', 0n, [back('the new collectible', COLLECTIBLE_RENT, 'never: it is the collectible’s own rent')]);
  for (const c of m.contests) {
    row(`contest:${c.key}`, `back a side in “${c.name}”`, 'player', FEES.player, [back('the entry', rent(ACCOUNT_BYTES.Entry), 'at claim')]);
    row(`contest:${c.key}`, `open “${c.name}”`, 'authority', FEES.project, [back('the contest and its pot', rent(contestBytes(c, m)) + rent(165), 'when it closes')]);
    row(`contest:${c.key}`, `decide “${c.name}”`, 'authority', FEES.project);
  }
  for (const a of m.auctions) {
    row(`auction:${a.key}`, `bid on “${a.name}”`, 'player', FEES.player, [], 'Nothing to deposit: the bid waits in the game’s vault, and goes back at once when it is topped.');
    const minted = a.lot?.item && (m.item.get(a.lot.item)?.kind ?? 'collectible') === 'collectible';
    row(`auction:${a.key}`, `end “${a.name}”`, 'anyone (the winner, a keeper)', 0n, minted ? [back('the new collectible', COLLECTIBLE_RENT, 'never: it is the collectible’s own rent, paid by whoever ends it')] : [], 'Its own rent goes back to whoever opened it.');
  }
  for (const s of m.stashes) row(`stash:${s.key}`, `put an NFT in “${s.name}”, or take one out`, 'the owner or the authority', FEES.project, [back('32 bytes more of the stash for each NFT in it', 32n * RENT_PER_BYTE, 'to whoever takes one out; a roll leaves it with the stash, for the next one put in')]);
  // A prize that is a roll of a box: whoever sends the claim, the payment, the end (or a grant's funds) makes its order.
  for (const r of prizeRolls(m).filter((r) => !['mission', 'recipe'].includes(r.route))) {
    const name = m.box.get(r.box)?.name ?? r.box;
    const who = r.route === 'grant' ? 'the grant’s funds (the sender, what they can’t)' : r.route === 'auction' ? 'whoever ends it' : r.route === 'contest' ? 'whoever claims the winning entry' : 'whoever pays the place';
    // The order holds the SOL for a collectible's rent only when its box can give one (an item outcome).
    const mints = (m.box.get(r.box)?.outcomes ?? []).flatMap(outcomeParts).some((o) => o.gives === 'item');
    row(r.by, `make a winner’s roll of “${name}” (${r.route})`, who, 0n, [back(mints ? 'the roll’s order and the SOL it holds for a collectible' : 'the roll’s order', rent(ACCOUNT_BYTES.Order) + (mints ? ESCROW_LAMPORTS : 0n), mints ? 'to the winner when it is settled, less a collectible’s rent when it gives one' : 'to the winner when it is settled')], 'Then anyone asks the oracle for the roll (its fee, below) and anyone settles it.');
    row(r.by, `ask for the roll of “${name}”`, 'anyone (a keeper, or the winner)', 0n, [], 'It asks MagicBlock’s oracle, which takes its fee from whoever asks; a refund doesn’t return it.', ORACLE_FEE);
  }
  for (const d of m.decisions) row(`decision:${d.key}`, d.when, 'authority', FEES.project, [], d.does === 'roll' ? 'The roll asks MagicBlock’s oracle, which takes its own fee from the authority.' : undefined, d.does === 'roll' ? ORACLE_FEE : 0n);
  if (m.allBoxes.some((b) => !boxBuys(b))) row('orders', 'settle an order', 'anyone (a keeper, or the player)', 0n, [], 'A roll won (an outcome that gives one) makes its order now: the sender pays its rent, which goes to the player when it settles.');
  if (m.schedules.length) row('schedules', 'run a schedule when it is due', 'anyone (a sealed one’s recipient, from their page)', 0n, [], m.schedules.some((sc) => sc.sealed) ? 'Several runs that fell behind go in one transaction; a sealed schedule pays from its own vault.' : undefined);
  if (m.lotteries.length) {
    row('lotteries', 'ask for a draw', 'anyone (a keeper, or a player)', 0n, [], 'The draw asks MagicBlock’s oracle for the winning numbers; the oracle takes its fee from whoever sends the draw.', ORACLE_FEE);
    row('lotteries', 'give a place’s prize, then route the tickets, then pay a place', 'anyone (the winner’s page)', 0n, [], 'A drawn round gives every place’s prize first; its ticket money moves only after (prizes first, then money).');
    if (m.lotteries.some((l) => l.minSold)) row('lotteries', 'a short round', 'anyone', 0n, [], 'A round that sold fewer tickets than its least is cancelled at its draw, with no oracle fee, and every ticket refunded.');
  }
  return rows;
}

/** Setup and play costs for a spec, or its refusals. */
/** `only` and `live`: a change to a live economy, priced as only what it publishes (live.mjs `changedParts`). */
export function cost(economy, { now = Math.floor(Date.now() / 1000), only = null, live = null } = {}) {
  const plan = compile(economy, { now, only, live });
  if (!plan.ok) return plan;
  return { ok: true, setup: setupCost(plan, economy), actions: actionCosts(economy, { now }), fees: { playerSol: sol(FEES.player), projectSol: sol(FEES.project), oracleSol: sol(ORACLE_FEE) } };
}

/** The cost in plain words. */
export function explainCost(c) {
  const s = c.setup;
  const lines = [`Going live takes ${s.transactions} transaction${s.transactions === 1 ? '' : 's'} (${s.approvals} wallet approval${s.approvals === 1 ? '' : 's'}) and about ${s.totalSol} SOL:`];
  lines.push(`  rent ${s.rentSol} SOL for ${s.accounts.length} accounts; program fees ${s.programFeesSol} SOL; network fees ${s.networkFeesSol} SOL${Object.keys(s.seeds).length ? `; seeds ${Object.entries(s.seeds).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`);
  for (const a of s.accounts) lines.push(`  ${a.approx ? 'about ' : ''}${a.sol} SOL: ${a.what} (${a.bytes} bytes)`);
  lines.push('While it runs (for a player, quote the “in all” number: it is what leaves their wallet for good):');
  for (const r of c.actions) {
    const deposits = r.deposits.map((d) => `${d.sol} SOL for ${d.what} (back: ${d.back})`).join('; ');
    if (r.inAll) {
      lines.push(`  ${r.action} (${r.who}): ${r.inAll}${r.note ? `. ${r.note}` : ''}`);
      continue;
    }
    lines.push(`  ${r.action} (${r.who}): ${r.feeSol ? `${r.feeSol} SOL fee + ` : ''}${r.oracleSol ? `${r.oracleSol} SOL to the oracle + ` : ''}${r.networkSol} SOL network${deposits ? `; ${deposits}` : ''}${r.note ? `. ${r.note}` : ''}`);
  }
  for (const n of s.notes) lines.push(n);
  return lines.join('\n');
}
