// The economy in plain words, from the checker, the simulation, the cost and the play-time steps: what players do
// and what it costs them, how the pools fill and drain, what runs by itself, what the authority must sign, what
// going live costs, and what the owner must know. Deterministic. Pure.
import { check, describe } from './check.mjs';
import { cost } from './cost.mjs';
import { boxBuys, farmEndWords, listOf, lotterySplit, model, outcomeBurns, outcomeParts, placeOf, prizeLine, prizeRolls, prizes, prizeWords, rollsOf, sharesOf, stashNfts, toSeconds } from './model.mjs';
import { playSteps } from './plan.mjs';
import { inAll, poolFate, round, simulate, unnamedExceptions, unnamedWords } from './simulate.mjs';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (x) => (Number.isFinite(x) ? String(round(x, 6)) : String(x));

/**
 * Where a split's shares send the money, and where what they leave goes: to the treasury (`treasury`: how to name it),
 * or `rest` ("into the pot" for a lottery's ticket money). `payer`: who names a "chosen" share, and what each one is
 * ("buyer", "sale"; "payer", "payment").
 */
function splitWords(split, treasury = 'your treasury', rest = `to ${treasury}`, payer = ['buyer', 'sale']) {
  const shares = sharesOf(split);
  if (!shares.length) return `all of it ${rest}`;
  const left = 100 - shares.reduce((n, s) => n + Number(s.percent), 0);
  const to = (s) => (s.kind === 'burn' ? 'burned' : s.kind === 'treasury' ? `to ${treasury}` : s.kind === 'pool' ? `to the pool “${s.key}”` : s.kind === 'holder' ? 'to whoever holds that collectible' : s.kind === 'lottery' ? `into the pot of the lottery “${s.key}”` : s.kind === 'wallet' ? `to the wallet ${s.key.slice(0, 4)}…` : s.kind === 'chosen' ? (s.key ? `to whoever holds the “${s.key}” the ${payer[0]} names (each ${payer[1]} its own)` : `to the wallet the ${payer[0]} names (each ${payer[1]} its own: a referrer; with none named, to ${treasury})`) : `to the account ${s.key.slice(0, 4)}…`);
  return `${shares.map((s) => `${s.percent}% ${to(s)}`).join(', ')}${left > 0 ? `, ${num(left)}% ${rest}` : ''}`;
}

const ruleWords = (r) => {
  if (!r) return '';
  if (r.wallets) return `they are one of the ${r.wallets.length} wallets it names`;
  const what = r.item ? `a “${r.item}”` : r.collection ? `an NFT of the collection ${r.collection.slice(0, 4)}…` : 'one of the game’s collectibles';
  const time = { ahead: ` whose ${r.attribute} is a time still to come`, passed: ` whose ${r.attribute} is a time past (or none)` }[r.time];
  return `${what}${r.atLeast !== undefined ? ` with ${r.attribute} at least ${r.atLeast}` : r.equals !== undefined ? ` whose ${r.attribute} is “${r.equals}”` : time ?? (r.attribute ? ` with a ${r.attribute}` : '')}`;
};
/** A stake gate in words: "at least 100 of “Staking” staked …", the farm by its name when `m` has it. */
const stakeWords = (staked, m) => {
  const f = m?.farm.get(staked.farm);
  return `at least ${staked.atLeast} ${f ? m.tokens.get(f.stakes)?.symbol ?? f.stakes : ''} staked and locked in “${f?.name ?? staked.farm}” (a stake counts while its lock runs, from the second after it is made)`.replace('  ', ' ');
};
/** A gate in a sentence: "Only players who show …", "Only the wallets it names …", "Only wallets with … staked …". */
const gateWords = (gate, verb, m) => (!gate ? '' : gate.wallets ? `Only the ${gate.wallets.length} wallets it names can ${verb}` : gate.list ? `Only the ${gate.list.length} wallets on its list can ${verb} (each passes their proof)` : gate.staked ? `Only wallets with ${stakeWords(gate.staked, m)} can ${verb}` : `Only players who show ${ruleWords(gate)} can ${verb}`);
/** When a part sells, and how many one wallet may: "from …, until …; 1 per wallet, 2 a day per wallet". */
const limitWords = (part) => {
  const words = [part.opens && `from ${part.opens}`, part.closes && `until ${part.closes}`, part.perWallet && `${part.perWallet} per wallet`, part.perWalletEach && `${part.perWalletEach.count} per wallet every ${part.perWalletEach.every ?? '1d'}`].filter(Boolean);
  return words.length ? ` ${words.join(', ')}.` : '';
};
/** What one outcome of a box that rolls on an NFT does, in words: "+1 level", "the NFT burned", "nothing changes". */
const fateWords = (o, b, m) => {
  const then = o.then ?? b.then;
  const fate = !then || then === 'back' ? null : then === 'burn' ? 'the NFT burned' : then.stash ? `the NFT kept in “${m.stash.get(then.stash)?.name ?? then.stash}”` : 'the NFT given away';
  const shifts = (o.shifts ?? []).map((x) => `${typeof x.by === 'string' ? x.by : x.by > 0 ? `+${x.by}` : x.by} ${x.attribute}`);
  // A part as a prize line (`prizeWords`), or a stash's NFT at random.
  const won = outcomeParts(o).map((x) => (x.gives === 'stash' ? `an NFT of “${m.stash.get(x.stash)?.name ?? x.stash}”` : prizeWords(x.gives === 'pay' ? { gives: 'tokens', amount: x.amount, from: `pool:${x.pool}` } : x.gives === 'mint' ? { gives: 'tokens', amount: x.amount, currency: x.currency, from: 'mint' } : x, m)));
  const all = [...shifts, ...won, ...(fate ? [fate] : [])];
  return all.length ? all.join(' and ') : 'nothing changes';
};
const effectWords = (e) => (e?.perPointPercent !== undefined ? `+${e.perPointPercent}% per point${e.upTo ? ` (up to ${e.upTo})` : ''}` : `+${e?.addPercent ?? 0}%`);

export function explainEconomy(economy, { now = Math.floor(Date.now() / 1000) } = {}) {
  const verdict = check(economy, { now });
  if (!verdict.ok) return { ok: false, refusals: verdict.refusals, warnings: verdict.warnings, text: describe({ refusals: verdict.refusals, warnings: [] }) };
  const m = model(economy, { now });
  /** "your treasury", or the other wallet the spec names as the treasury. */
  const treasuryWords = m.treasuryWallet ? `the treasury (the wallet ${m.treasuryWallet.slice(0, 4)}…${m.treasuryWallet.slice(-4)})` : 'your treasury';
  const splitOf = (split, payer) => splitWords(split, treasuryWords, undefined, payer);
  const sim = simulate(economy, { now });
  const c = cost(economy, { now });
  const play = playSteps(economy);
  const sym = (key) => m.tokens.get(key)?.symbol ?? key;
  const lines = [];
  const section = (title, rows) => {
    if (rows.length) lines.push('', title, ...rows.map((r) => `- ${r}`));
  };

  const ONE = { tokens: 'token', items: 'item', pools: 'pool', stashes: 'stash', boxes: 'box', payments: 'payment', recipes: 'recipe', schedules: 'schedule', lotteries: 'lottery', farms: 'farm', contests: 'contest', auctions: 'auction', holds: 'hold', grants: 'grant', decisions: 'decision' };
  const counted = Object.keys(ONE).filter((k) => economy[k]?.length).map((k) => plural(economy[k].length, ONE[k], k));
  lines.push(`${economy.name ?? 'This economy'}: ${counted.join(', ') || 'nothing yet'}. The project’s currency is ${m.currency?.symbol ?? '(none)'}${m.currency ? ` (${m.currency.source === 'sol' ? 'SOL' : m.currency.source === 'game' ? 'a token the project mints' : `an existing ${m.currency.program === 'token-2022' ? 'Token-2022 ' : ''}mint`})` : ''}. It runs on the shared loot program, devnet only: no contract of its own.`);
  if (economy.prompt) lines.push(`Asked for: “${economy.prompt}”`);

  const fee = num(sim.fees.playerSol);
  const actions = [];
  for (const it of sim.items) {
    const src = m.item.get(it.key);
    actions.push(`Buy “${it.name}”: ${num(it.price)} ${sym(it.token)}, ${inAll(it.realCost)}${src.supply ? `; ${src.supply} exist` : ''}${src.rise ? '; the price rises after every sale' : ''}${src.fall ? `; the price falls ${src.fall.step} every ${src.fall.every}${src.fall.floor !== undefined ? ` to at least ${src.fall.floor}` : ''}` : ''}${src.soulbound ? '; soulbound' : ''}${src.gate ? `; ${gateWords(src.gate, 'buy it', m).replace(/^Only/, 'only')}` : ''}. The money: ${splitOf(src.split)}.`);
  }
  for (const b of sim.boxes) {
    const src = m.box.get(b.key);
    const edge = b.houseEdgePercent !== null ? `; the house keeps ${num(b.houseEdgePercent)}%` : b.unpriced.length ? `, plus what ${b.unpriced.join(', ')} ${b.unpriced.length === 1 ? 'is' : 'are'} worth` : '';
    const back = b.returnPercent !== null ? `gives back ${num(b.expectedBack)} ${sym(b.token)} on average (${num(b.returnPercent)}% of its price${edge})` : 'gives back what its items are worth to the player';
    const part = (o) => (o.gives === 'pay' ? `${num(o.amount)} ${sym(o.token)} from “${o.pool}”` : o.gives === 'mint' ? `${num(o.amount)} ${sym(o.token)}, minted` : o.gives === 'share' ? `${o.percent}% of “${o.pool}”` : o.gives === 'stash' ? `an NFT of “${m.stash.get(o.stash)?.name ?? o.stash}”, picked at random` : o.gives === 'nft' ? `the NFT ${String(o.nft).slice(0, 4)}… of “${m.stash.get(o.stash)?.name ?? o.stash}”` : o.gives === 'roll' ? `a roll of “${m.box.get(o.box)?.name ?? o.box}”` : o.gives === 'item' ? `${o.item}` : o.gives === 'burn' ? 'burned' : 'nothing');
    const outs = b.outcomes.map((o) => `${num(o.chance)}% ${o.gives === 'bundle' ? `${o.prizes.map(part).join(' + ')}${o.burns ? ' (the payment burned)' : ''}` : part(o)}`).join(', ');
    const odds = (src.odds ?? []).map((o) => `outcome ${o.outcome} ${effectWords(o.add)} for a player who shows ${ruleWords(o.when)}`);
    // A roll on an NFT: what each outcome does to it.
    const fates = (src.outcomes ?? []).flatMap((o, i) => {
      const moves = (o.shifts ?? []).map((x) => (x.fromNow ? `${x.attribute} ${String(x.by).startsWith('-') ? `${String(x.by).slice(1)} sooner` : `${x.by} later, counted from now when it is past`}${x.upTo ? `, at most ${x.upTo} from now` : ''}` : `${x.by > 0 ? '+' : ''}${x.by} ${x.attribute}`));
      const then = o.then ?? src.then;
      const where = then === 'burn' ? 'it is burned' : then === 'treasury' ? 'it goes to the treasury' : then?.giveTo ? `it goes to ${then.giveTo.slice(0, 4)}…` : then?.stash ? `it goes into the stash “${m.stash.get(then.stash)?.name ?? then.stash}”` : '';
      const said = [...moves, where].filter(Boolean).join(' and ');
      return said ? [`outcome ${i}: ${said}`] : [];
    });
    const custodial = (src.outcomes ?? []).some((o) => (o.then ?? src.then) && (o.then ?? src.then) !== 'back');
    const rolls = src.rollsOn
      ? ` It rolls on ${src.active === false ? 'the NFT' : 'an NFT the player brings'} (${ruleWords(src.rollsOn)})${fates.length ? `: ${fates.join('; ')}` : ''}${custodial ? '; the project holds that NFT from the purchase until it is settled, so nobody can move it away from a bad roll' : '; the NFT stays in its wallet, and the numbers follow it wherever it goes'}.`
      : '';
    const named = { grant: 'the grant', contest: 'the contest', auction: 'the auction', mission: 'the mission', recipe: 'the recipe', box: 'the box' };
    const by = [...new Set(rollsOf(m).filter((r) => r.box === src.key && !r.through).map((r) => {
      const [kind, key] = r.by.split(':');
      const part = { grant: m.grant, lottery: m.lottery, contest: m.contest, auction: m.auction, farm: m.farm, recipe: m.recipe, box: m.box }[kind]?.get(key);
      return kind === 'lottery' ? `${r.route} of the lottery “${part?.name ?? key}”` : `${named[r.route] ?? kind} “${part?.name ?? key}”`;
    }))];
    if (src.active === false && (src.rollsOn || by.length)) {
      actions.push(`“${b.name}” is never sold: ${by.join(' and ') || 'nothing'} rolls it. Odds: ${outs}${odds.length ? `; ${odds.join('; ')}` : ''}.${rolls} Anyone asks the oracle for a roll and settles it (the oracle's fee is the asker's), and a roll is never refunded while it waits.`);
      continue;
    }
    const verb = boxBuys(src) ? 'Buy' : 'Open';
    const oneStep = boxBuys(src) ? ' It sells in one step: the price is split and what it gives handed over in the same transaction.' : '';
    actions.push(`${verb} “${b.name}”: ${num(b.price)} ${sym(b.token)}, ${inAll(b.realCost)}; ${back}. ${boxBuys(src) ? 'It gives' : 'Odds'}: ${outs}${odds.length ? `; ${odds.join('; ')}` : ''}${src.gate ? `. ${gateWords(src.gate, 'open it', m)}` : ''}.${rolls} The money: ${src.outcomes.some(outcomeBurns) ? 'on a burn, all of it is burned; otherwise ' : ''}${splitOf(src.split)}.${limitWords(src)}${src.outcomes.flatMap(outcomeParts).some((o) => o.gives === 'pay') ? ` It sells only while its pools hold every fixed prize${boxBuys(src) ? '' : ', and a prize won is set aside for its winner at once'}.` : ''}${oneStep}`);
  }
  for (const p of sim.payments) actions.push(`Pay “${p.name}”: ${p.atLeast ? `whatever the player chooses, at least ${num(p.amount)} ${sym(p.token)} (the page keeps the least; the chain takes any amount)` : `${num(p.amount)} ${sym(p.token)}`}, ${inAll(p.realCost)}. The money: ${splitOf(m.payments.find((x) => x.key === p.key)?.split, ['payer', 'payment'])}.`);
  for (const r of sim.recipes) actions.push(`Craft “${r.name}”: ${r.takes.join(' + ') || 'nothing'} → ${r.gives.join(' + ') || 'nothing'} (+ ${fee} SOL player fee).`);
  for (const l of sim.lotteries) {
    const src = m.lottery.get(l.key);
    // Its split (and its cut, a share to the treasury) takes its shares, and the rest goes into the pot.
    const others = (src.split ?? []).length ? `; ticket money goes ${splitWords(lotterySplit(src), treasuryWords, 'into the pot')}` : '';
    if (src.ticketNft) {
      const goes = src.noLoss ? 'held until the round is drawn, then goes back to its buyer (no loss)' : `${!src.ticketNft.then || src.ticketNft.then === 'burn' ? 'burned' : src.ticketNft.then.stash ? `put in the stash “${src.ticketNft.then.stash}”` : 'given on'} once the round is drawn (back to its buyer only if the draw is cancelled)`;
      actions.push(`Buy a ticket for “${l.name}” with one NFT that is ${ruleWords(src.ticketNft.rule)} (+ ${fee} SOL player fee): it is ${goes}. ${l.drawsOnce ? 'Drawn once, then it ends' : `Drawn every ${num(l.roundDays)} days`}; the pot is what the owner seeds and what its places give.${src.gate ? ` ${gateWords(src.gate, 'buy tickets', m)}.` : ''}`);
      continue;
    }
    actions.push(`Buy tickets for “${l.name}”: ${num(l.price)} ${sym(l.token)} a ticket; one ticket bought alone is ${inAll(l.realCost)}, and the fee is per purchase, so several tickets at once share it. ${l.drawsOnce ? 'Drawn once, then it ends' : `Drawn every ${num(l.roundDays)} days`}; the pot (an account of its own, which only its winners are paid from) reaches about ${num(l.potBeforeDraw)} ${sym(l.potToken)} and pays ${l.prizes.map(num).join(' / ')}; ${src.noLoss ? `no loss: every ticket comes back to its buyer once the round is drawn (anyone can finish each purchase), and the winners take only the pot, what is paid into it, so a ticket wins ${num(l.expectedPerTicket)} on average on top of its price coming back (tickets are not weighted by time: someone may buy most of them right before the draw and risk only the fees)` : `a ticket is worth ${num(l.expectedPerTicket)} on average${l.unpricedPrizes ? ', plus its chance at the places’ prizes' : ''}${l.returnPercent !== null ? ` (${num(l.returnPercent)}%)` : ''}`}${l.cutPercent && !(src.split ?? []).length ? `; ${num(l.cutPercent)}% of ticket money goes to ${treasuryWords}, the rest into the pot` : ''}${others}${src.perWallet ? `; at most ${src.perWallet} tickets per wallet a round` : ''}.${src.gate ? ` ${gateWords(src.gate, 'buy tickets', m)}.` : ''}`);
  }
  for (const f of sim.farms) {
    const src = m.farm.get(f.key);
    const tiers = f.tiers.map((t) => `x${t.multiplier} for ${t.lock}`).join(', ');
    const boosts = (src.boosts ?? []).map((b) => `${effectWords(b.add)} for ${ruleWords(b.when)}`);
    const custody = src.stakes !== 'collectibles' && !boosts.length ? '' : {
      freeze: ' NFTs stay locked in the wallet (a Core freeze, Token Metadata’s lock, a compressed NFT’s freeze); issuer metadata growth can prevent Core from unfreezing ordinary assets.',
      watch: ' NFTs stay free in the wallet: one sold while staked stops earning for its staker, and its new holder can take the seat over.',
    }[src.custody] ?? ' NFTs are handed to the game until they leave; issuer-controlled transfer rules can still prevent return.';
    const earns = f.rate && !(Number(f.rate.perDay) > 0)
      ? 'no tokens'
      : f.rate
      ? `${num(f.rate.perDay)} ${sym(f.rewardsToken)} a day for each ${f.unit} at x1, whoever else is in (${f.rate.minted ? 'minted while the mint has room for it, never owed later past that' : `from “${src.rewards}” while it lasts`}); what a seat gives back (a forfeit, an early exit’s waiting rewards, a watched NFT sold, a lapsed upkeep) is ${f.rate.minted ? 'burned' : `sent back to “${src.rewards}”`} in the same move, never to the other seats`
      : `${num(f.rewardsPerDay)} ${sym(f.rewardsToken)} a day shared by weight${f.perUnitPerDay !== undefined ? ` (${num(f.perUnitPerDay)} a day for each ${f.unit} at x1${f.yearlyPercent !== undefined ? `, ${num(f.yearlyPercent)}% a year` : ''})` : ''}`;
    const grows = (f.growth ?? []).map((g) => `; staying in earns ${g.perDay} ${g.attribute} a day at x1, written on the collectible${g.levels ? ` with its ${g.level} (${g.levels.map((l) => `${l.level} after ${num(l.days)} days`).join(', ')})` : ''}${g.streak ? ', back to 0 when it leaves' : ', kept when it leaves'}`).join('');
    const gates = listOf(src.gate);
    const takes = gates.length ? `; to stake here an NFT must be ${gates.map(ruleWords).join(' and ')}` : '';
    const end = farmEndWords(src);
    const runs = src.runs ? `; it runs ${src.runs} from when it goes live, taking no stake at its end or after it, nor one that could not leave by then, and pays and grows nothing after${end ? `; ${end}` : ''}` : '';
    const lock = src.lockAttribute ? `; each collectible’s lock is written on it under “${src.lockAttribute}” (the time it ends) and it leaves once that time has come, so a recipe or a roll that moves “${src.lockAttribute}” lets it out sooner or keeps it longer (a mission’s prize still needs the tier’s own lock)` : '';
    const upkeep = src.upkeepAttribute ? `; a collectible earns and grows only until the time under its “${src.upkeepAttribute}” (its upkeep): run dry, it earns nothing more until it is topped up and its seat refreshed, and what it was credited after running dry is not paid: in a farm at a fixed rate it is burned or goes back where the rate came from, never to the other seats; in a farm that shares its pool it goes back to the pool and is released again with the rest` : '';
    const missions = f.tiers.filter((t) => t.prize).map((t) => `${t.prize} for staying ${t.lock}`);
    const results = (src.tiers ?? []).filter((t) => t.roll).map((t) => {
      const box = m.box.get(t.roll);
      const fates = box ? [...new Set((box.outcomes ?? []).map((o) => fateWords(o, box, m)))] : [];
      return `leaving after ${t.lock}, the NFT is rolled on “${box?.name ?? t.roll}”${fates.length ? ` (its result: ${fates.length > 1 ? `${fates.slice(0, -1).join('; ')}; or ${fates.at(-1)}` : fates[0]})` : ''}`;
    });
    actions.push(`Stake ${src.stakes === 'collectibles' ? `collectibles${src.item ? ` (${src.item})` : ''}` : sym(src.stakes)} in “${f.name}”: ${earns}${grows}${takes}${runs}${lock}${upkeep}${missions.length ? `; a mission that stays its lock (topped up, not forfeited) brings back ${missions.join(', ')}, given as it leaves (a roll is settled after)` : ''}${results.length ? `; ${results.join('; ')}` : ''}; lock tiers ${tiers}${boosts.length ? `; boosts ${boosts.join(', ')}, at most +${src.maxBoostPercent ?? 0}%` : ''}. After the lock, pause and suspend cannot stop an unstake; external token or NFT controls can still block custody release.${custody}`);
  }
  for (const t of m.traits) actions.push(`Prove an NFT’s traits (anyone, once for each NFT, paying its Sheet’s small rent): what the off-chain metadata of the NFTs of ${t.collection.slice(0, 4)}… says, from the root the game vouched for, goes in the NFT’s Sheet, where boosts, gates and odds read it.${t.about ? ` ${t.about}` : ''}`);
  for (const ct of sim.contests) {
    const src = m.contest.get(ct.key);
    const roll = prizeLine(src?.prize) ? ` Each winning entry also gets ${prizeWords(src.prize, m)} when it is claimed${prizeLine(src.prize).gives === 'roll' ? '' : ', in the same transaction'}.` : '';
    if (src.stakeNft) {
      actions.push(`Back a side in “${ct.name}” with one NFT that is ${ruleWords(src.stakeNft)} (+ ${fee} SOL player fee): the NFTs are the pot. The authority names the side that won; each winning entry takes its own NFT back and one loser’s, in the order the entries are claimed, and what the winners leave goes to whoever opened it. Called off, or not decided by its deadline, every entry takes its own back.${roll}`);
      continue;
    }
    actions.push(`Back a side in “${ct.name}” (+ ${fee} SOL player fee): ${ct.says}; the authority names the side that won, and a contest not decided by its deadline pays everyone back.${roll}`);
  }
  for (const a of sim.auctions ?? []) {
    const src = m.auction.get(a.key);
    const lot = src.lot?.item ? `one new “${m.item.get(src.lot.item)?.name ?? src.lot.item}”` : src.lot?.roll ? `a roll of “${m.box.get(src.lot.roll)?.name ?? src.lot.roll}” for the winner (a mystery lot: what it gives is chance, and the price goes to ${treasuryWords})` : `the NFT ${src.lot?.asset?.slice(0, 4)}…`;
    if (src.bidNfts) {
      actions.push(`Bid on “${a.name}”, which sells ${lot}, with bundles of up to three Core or Token Metadata NFTs that are ${ruleWords(src.bidNfts)} (+ ${fee} SOL player fee a bid): the bundle with the most wins (at least ${src.reserve ?? 1}); a bundle that is topped goes back to its bidder at once, and the winning NFTs go to ${src.lot?.asset ? 'the seller' : treasuryWords}. It runs ${src.runs}.${src.gate ? ` ${gateWords(src.gate, 'bid', m)}.` : ''}`);
      continue;
    }
    actions.push(`Bid on “${a.name}”, which sells ${lot}: bids in ${sym(a.token)}${a.reserve ? ` from ${num(a.reserve)}` : ''}, each topping the last by at least ${src.minRaise ?? 5}% (+ ${fee} SOL player fee a bid); a bid that is topped goes back to its bidder at once. It runs ${src.runs}${toSeconds(src.extendBy ?? '10m') > 0 ? `, and a bid in the last ${src.extendBy ?? '10m'} moves the end to ${src.extendBy ?? '10m'} after it` : ''}; anyone ends it then, the lot goes to the highest bidder and the money: ${splitOf(src.split)}. With no bid the lot goes home; an auction nobody ends waits, and sells to the highest bidder whenever anyone ends it.${src.gate ? ` ${gateWords(src.gate, 'bid', m)}.` : ''}`);
  }
  for (const h of m.holds) actions.push(`Hand in a ${h.item} for “${h.name}”${h.until ? ` until ${h.until}` : h.for ? ` for ${h.for}` : ''}: the authority says where it goes; after the time is up anyone can send it home.`);
  if (m.payments.length || m.boxes.length) actions.push('Pay with an NFT, outside the spec (`loot.payNftIx`): any NFT a player holds, burned or given to a wallet; the app admits them by the receipt, as for a payment.');
  for (const g of sim.grants) {
    const src = m.grant.get(g.key);
    const l = src.limits ?? {};
    const limits = [l.perWallet && `${l.perWallet} per wallet`, l.perWalletEach && `${l.perWalletEach.count} per wallet every ${l.perWalletEach.every ?? '1d'}`, l.perPerson && `${l.perPerson} per person`, l.perKey && `${l.perKey} per key`, l.perDay && `${l.perDay} a day`, l.total && `${l.total} in all`].filter(Boolean).join(', ');
    const signers = [(src.vouchers ?? []).length && 'a voucher key says earned it', (src.keys ?? []).length && `one of its ${src.keys.length} keys (codes) signed for`, (src.list ?? []).length && `on the list of ${src.list.length}`].filter(Boolean);
    const who = signers.length ? signers.join(' or ') : 'that asks (it is open to any wallet)';
    // A grant of a fixed amount of tokens, paid by voucher or list: each claim may name its own amount, up to the grant's.
    const named = signers.length > 0 && src.prize?.gives === 'tokens';
    actions.push(`Claim “${g.name}” (only the winning wallet claims, signing it; anyone may pay its fees): gives ${g.gives}, to a wallet ${who}${limits ? `; limits ${limits}` : '; no limits'}${src.gate ? (src.gate.wallets ? `; only the ${src.gate.wallets.length} wallets it names` : src.gate.list || src.gate.staked ? `; ${gateWords(src.gate, 'claim it', m).replace(/^Only/, 'only')}` : `; the wallet must hold ${ruleWords(src.gate)}${!signers.length ? ', and each one of those claims once too' : ''}`) : ''}${named ? `; a voucher or the list can name each claim’s own amount, up to that (a reward by rank or share)` : ''}. Each claim costs the grant’s funds about ${num(g.fundsPerClaimSol)} SOL of rent, and whoever sends it the ${fee} SOL player fee.`);
  }
  for (const st of sim.stashes ?? []) {
    const src = m.stash.get(st.key);
    const nfts = stashNfts(src);
    const boxes = m.boxes.filter((b) => (b.outcomes ?? []).flatMap(outcomeParts).some((o) => o.gives === 'stash' && o.stash === st.key)).map((b) => `“${b.name}”`);
    const direct = prizes(m).filter((p) => p.prize.gives === 'nft' && p.prize.stash === st.key).map((p) => `${p.by} (${prizeWords(p.prize, m)}, given at once)`);
    actions.push(`The stash “${st.name}” holds ${plural(nfts.length, 'NFT')} the game gives away${boxes.length ? ` through ${boxes.join(', ')}` : ''}${direct.length ? `${boxes.length ? ' and' : ' through'} ${direct.join(', ')}` : ''}, put in by your wallet when it goes live${st.takenInPerDay ? ` and by what players pay with an NFT (about ${num(st.takenInPerDay)} a day in the scenario)` : ''}: a roll that lands on it picks one at random and takes it out at once, so two winners never get the same one, and anyone then settles the roll to hand it over; a prize that names an NFT hands it over in the instruction that wins it. Empty, it can’t be won. Your wallet (or the authority) can put more in, or take one out, any time.${st.lastsDays !== undefined ? ` At the scenario’s rate it lasts about ${num(st.lastsDays)} days.` : ''}`);
  }
  // Prizes that are a roll of a box: made for the winner, then asked of the oracle and settled by anyone.
  const prized = prizeRolls(m).filter((r) => !['mission', 'recipe'].includes(r.route));
  if (prized.length)
    actions.push(`Prizes that are a roll of a box (${[...new Set(prized.map((r) => `${r.by} → “${m.box.get(r.box)?.name ?? r.box}”`))].join(', ')}): the winner gets an order of that box, made by whoever sends the claim, the place’s payment or the auction’s end (its rent, back to the winner when it is settled); anyone then asks the oracle for the roll (its fee is the asker’s) and settles it. A roll is never refunded while it waits.`);
  for (const l of m.lotteries) {
    const rolls = (l.places ?? []).map(placeOf).map((p, i) => (p.prize ? `place ${i + 1} wins ${prizeWords(p.prize, m)}${p.percent ? ` and ${p.percent}% of the pot` : ''}` : null)).filter(Boolean);
    if (rolls.length) actions.push(`In “${l.name}”, ${rolls.join('; ')}.`);
  }
  section('What players do, what it costs and what it is worth', actions);

  section('How the pools fill and drain', sim.pools.map((p) => {
    const by = (rows) => rows.map((r) => (r.percentPerDay !== undefined ? `${r.by} ${num(r.percentPerDay)}% of what it holds a day` : `${r.by} ${num(r.perDay)} a day`)).join(', ') || 'nothing';
    return `${p.pot ? `The pot of “${p.pot}”` : `“${p.key}”`} (${sym(p.token)}): starts at ${num(p.seed)}; in: ${by(p.ins)}; out: ${by(p.outs)}; it ${poolFate(p, sim.scenario.days)}.`;
  }));
  section('What runs by itself', [...sim.schedules.map((s) => `“${m.schedules.find((x) => x.key === s.key)?.name ?? s.key}” ${s.says}; anyone can run it when it is due.`), ...sim.lotteries.map((l) => `“${l.name}” is drawn ${l.drawsOnce ? 'once' : `every ${num(l.roundDays)} days`} by MagicBlock’s oracle; anyone can ask for the draw (${num(sim.fees.oracleSol)} SOL to the oracle) and pay the places.`)]);
  const authority = play.filter((s) => s.signer.startsWith('authority'));
  section(`What only the authority signs while it runs (${m.authority === 'owner' ? 'your wallet' : `the key ${m.authority}`})`, authority.map((s) => `${s.says} (${s.part}, ${s.ix}).`));
  if (authority.length) lines.push('- Checking that a player really did what a payout is for is up to you, on your own server: a game runs in the player’s browser, and the program trusts the authority’s signature.');

  const s = c.setup;
  lines.push('', 'What setting it up costs');
  lines.push(`- About ${num(s.totalSol)} SOL in all, in ${plural(s.transactions, 'transaction')} (${plural(s.approvals, 'wallet approval')}): rent ${num(s.rentSol)} SOL for ${plural(s.accounts.length, 'account')}, program fees ${num(s.programFeesSol)} SOL, network fees ${num(s.networkFeesSol)} SOL${Object.keys(s.seeds).length ? `, seeds ${Object.entries(s.seeds).map(([k, v]) => `${num(v)} ${k}`).join(', ')}` : ''}.`);
  for (const n of s.notes) lines.push(`- ${n}`);

  const d = sim.perDay;
  const list = (map) => Object.entries(map).map(([k, v]) => `${num(v)} ${sym(k)}`).join(', ') || 'nothing';
  const named = Object.entries(sim.scenario.perDay).map(([k, v]) => `${v} × ${k}`).join(', ');
  const except = unnamedExceptions(sim);
  lines.push('', `Each day, if ${named ? `${named} happen (anything else: ${unnamedWords(sim)})` : `${sim.scenario.defaultPerDay} of each thing happen${except.length ? ` (${except.join(', ')})` : ''}`}`);
  lines.push(`- Players pay ${list(d.players.pay)} and get back ${list(d.players.getBack)} on average, plus ${num(d.players.playerFeesSol)} SOL in player fees${d.players.oracleFeesSol ? ` and ${num(d.players.oracleFeesSol)} SOL to MagicBlock’s oracle` : ''}.`);
  lines.push(`- Your treasury gets ${list(d.creator.treasury)}; burned: ${list(d.burned)}; the platform’s fees: ${num(d.platform.totalSol)} SOL.`);
  for (const n of sim.notes) lines.push(`- ${n}`);

  const flagged = verdict.warnings.filter((w) => w.code === 'W-CHANCE-PRIZE' || w.code === 'W-REVENUE-SHARE');
  const others = verdict.warnings.filter((w) => !flagged.includes(w));
  if (flagged.length) section('Flagged for the law, once it is real money', [...new Set(flagged.map((w) => w.message))]);
  section('Know before going live', others.map((w) => `${w.message}${w.fix ? ` ${w.fix}` : ''}`));
  lines.push('', 'Devnet only: nothing here is real money. Going live is your approval in your own wallet: no one else signs, and no key is ever shared.');
  return { ok: true, text: lines.join('\n').trim(), warnings: verdict.warnings, needsAuthority: authority.length > 0, chance: verdict.warnings.some((w) => w.code === 'W-CHANCE-PRIZE'), setupSol: s.totalSol };
}
