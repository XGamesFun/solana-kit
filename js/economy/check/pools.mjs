// The checks of pools (what fills them and what takes from them) and stashes (stash.rs: NFTs the game holds to give
// away). It adds to the context what takes from each pool and every roll of a box, which later parts read.
import {
  poolFillers,
  outcomeParts,
  boxBuys,
  rollsOf,
  prizes,
  prizeWords,
  stashNfts,
  stopsSales,
  poolTakers,
  utf8Bytes,
} from '../model.mjs';
import { label } from '../format.mjs';

/** Checks the pools and the stashes. Adds `takers`, `rolls` and `roller` to `c`. */
export function checkPools(c) {
  const { refuse, warn, m, units } = c;
  // ---- pools: what fills them and what takes from them
  const takers = poolTakers(m);
  const fillers = poolFillers(m);
  for (const p of m.pools) {
    const where = `economy.pools.${p.key}`;
    const tok = m.tokens.get(p.currency);
    units(p.seed, tok, `${where}.seed`, `The seed of “${p.key}”`);
    const takes = takers.filter(t => t.pool === p.key);
    const fills = fillers.filter(f => f.pool === p.key);
    if (takes.length && !fills.length)
      warn(
        'W-POOL-DRY',
        where,
        `The pool “${p.key}” is paid out of (${takes.map(t => t.by).join(', ')}) but nothing in this spec fills it: until someone sends it tokens, those payouts give nothing (a claim of a fixed amount is refused).`,
        `Seed it ("seed"), send it a share of a sale (a split to "pool:${p.key}"), or fill it with a schedule.`,
      );
    if (!takes.length && !fills.length)
      warn('W-POOL', where, `The pool “${p.key}” is never used.`, 'Remove it, or use it.');
    if (fills.length && !takes.length)
      warn(
        'W-POOL',
        where,
        `Money goes into “${p.key}” (${fills.map(f => f.by).join(', ')}) and nothing in the economy takes it out: only the authority can, with a payout.`,
        'Add what pays from it (a box prize, a lottery, a farm, a recipe, a grant), or a decision that pays out of it.',
      );
    const lottery = takes.find(t => t.by.startsWith('lottery:'));
    if (lottery) {
      const others = takes.filter(t => t !== lottery);
      if (others.length)
        warn(
          'W-POOL-SHARED',
          where,
          `The pot “${p.key}” of ${lottery.by} is also taken from by ${others.map(t => t.by).join(', ')}: until its winners are paid it is a pool like any other, and the winners share what is left.`,
          'Give the lottery a pot of its own.',
        );
    }
  }

  // ---- stashes (stash.rs): NFTs the game holds to give away, one at random a roll
  // Every roll of a box, a box's own outcome's and a roll's roll included: who can empty a stash, who wins a box,
  // whose roll fails at its ask.
  const rolls = rollsOf(m);
  /** Who makes a roll, in words: "grant:gift", or "grant:gift through box:mid" for a box that a box it rolls rolls. */
  const roller = r => (r.through?.length ? `${r.by} through ${r.through.map(k => `box:${k}`).join(', ')}` : r.by);
  const stashUsers = new Map(
    m.stashes.map(s => [
      s.key,
      m.allBoxes.filter(b =>
        (b.outcomes ?? []).flatMap(outcomeParts).some(o => o.gives === 'stash' && o.stash === s.key),
      ),
    ]),
  );
  // What fills a stash besides its owner: an NFT a box takes as its price, a recipe's trade-in, a lottery's ticket.
  const intoStash = new Map();
  const into = (then, by) => then?.stash && intoStash.set(then.stash, [...(intoStash.get(then.stash) ?? []), by]);
  for (const b of m.allBoxes) for (const o of b.outcomes ?? []) into(o.then ?? b.then, `box:${b.key}`);
  for (const r of m.recipes) for (const l of r.in ?? []) if (l.takes === 'trade') into(l.then, `recipe:${r.key}`);
  for (const l of m.lotteries) into(l.ticketNft?.then, `lottery:${l.key}`);
  // The prizes that name one NFT of a stash (prize.rs Prize::Nft), given at once.
  const directs = prizes(m).filter(p => p.prize.gives === 'nft');
  const listed = new Map();
  for (const s of m.stashes) {
    const where = `economy.stashes.${s.key}`;
    if (utf8Bytes(s.name) > 40)
      refuse('E-STASH', `${where}.name`, `${label(s)}’s name is longer than 40 bytes.`, 'Shorten it.');
    if (stashNfts(s).some(n => n.kind === 'token-metadata'))
      warn(
        'W-STASH',
        `${where}.nfts`,
        `${label(s)} lists Token Metadata NFTs: each must be an NFT (one token, no decimals, a mint that can never mint another); a semi-fungible item is refused when it is put in (NotAnNft).`,
      );
    for (const [i, n] of stashNfts(s).entries()) {
      const at = `${where}.nfts[${i}]`;
      if (listed.has(n.asset))
        refuse(
          'E-STASH',
          at,
          `${label(s)} lists ${n.asset}, which ${listed.get(n.asset)} lists too: an NFT can be handed to the game once.`,
          'List each NFT in one stash, once.',
        );
      listed.set(n.asset, label(s));
      if (n.kind === 'compressed')
        refuse(
          'E-STASH',
          at,
          `${label(s)} lists a compressed NFT: putting one in needs a proof of its leaf fetched when it is signed, which going live does not do.`,
          'Leave it out here; once the economy is live, put it in with `loot.proveLeafIx` then `loot.stashIx` (both in one transaction, signed by the owner or the authority who holds it). A compressed prize NFT can’t move in the same instruction as another move on its tree (a mission whose staked NFTs share that tree, a lottery entry winning two places of one tree): the second proof is stale and the unstake or the payment fails until it is sent again. Keep prize NFTs on a tree of their own, or give them through a roll.',
        );
      if (n.kind === 'core' && !n.collection && !m.live.project)
        refuse(
          'E-STASH',
          at,
          `${label(s)} lists an NFT of the game’s own collection, which is only made when the economy goes live: there is none to put in yet.`,
          'Give the collection it is in ("collection"), or put it in once the economy is live and your wallet holds it.',
        );
    }
    const users = stashUsers.get(s.key);
    const named = directs.filter(p => p.prize.stash === s.key);
    // NFTs of weight 0: never drawn, given only by name.
    const light = stashNfts(s).filter(n => n.weight === 0);
    if (light.length)
      warn(
        'W-STASH',
        `${where}.nfts`,
        `${label(s)} holds ${light.length} NFT${light.length === 1 ? '' : 's'} of weight 0: never drawn, and given only by name. A raffle counts them among the stash’s NFTs, so a raffle with more places than NFTs that weigh something leaves the extra places with nothing${light.length === stashNfts(s).length ? '; with none that weighs, a draw from it finds nothing, and a box that stops selling when an outcome is out is not sold' : '; a box that stops selling when out may land on the stash and find nothing to draw'}.`,
        'Give the NFTs to draw a weight above 0; keep weight 0 for NFTs a prize names.',
      );
    // A known limit of the program: a named NFT is found by reading the stash's list from its start, about 52
    // compute units for each NFT ahead of it, and a box's roll looks for every NFT it names, then takes the one won. A
    // stash that players fill (a box's fate, a recipe's trade-in, a lottery's NFT ticket) can grow past what fits.
    const namers = m.allBoxes
      .map(b => [
        b,
        (b.outcomes ?? []).flatMap(outcomeParts).filter(o => o.gives === 'nft' && o.stash === s.key).length,
      ])
      .filter(([, n]) => n);
    if ((namers.length || named.length) && intoStash.has(s.key)) {
      const most = Math.max(0, ...namers.map(([, n]) => n));
      const fits = Math.floor(1_200_000 / (52 * (most + 1)) / 100) * 100;
      warn(
        'W-STASH-NAMED',
        where,
        `${[...namers.map(([b]) => label(b)), ...named.map(p => p.by)].join(', ')} name${namers.length + named.length === 1 ? 's' : ''} NFTs of ${label(s)}, which ${[...new Set(intoStash.get(s.key))].join(', ')} put${intoStash.get(s.key).length === 1 ? 's' : ''} NFTs into, so it can grow without end. A named NFT is found by reading the stash’s list, about 52 compute units for each NFT ahead of it${most ? `: a roll of ${label(namers.find(([, n]) => n === most)[0])}, which names ${most}, stops fitting a transaction at about ${fits.toLocaleString('en-US')} NFTs in the stash (its order then waits for its refund)` : ''}${named.length ? `${most ? ', and' : ':'} a prize naming one stops at about 25,000` : ''}. Keep a stash that prizes name under about 1,000 NFTs.`,
        'Send what players put in to a stash of its own, and name prizes from a stash only the owner fills; a random pick of a stash costs the same at any size.',
      );
    }
    if (!(s.nfts ?? []).length && !intoStash.has(s.key)) {
      // A box that stops selling when an outcome runs out (the default) isn't sold at all while it is empty.
      const stopped = users.filter(b => b.active !== false && stopsSales(b) && !boxBuys(b, m));
      warn(
        'W-STASH',
        `${where}.nfts`,
        `${label(s)} starts empty: until the owner or the authority puts NFTs in (\`loot.stashIx\`), ${stopped.length ? `${stopped.map(label).join(', ')} ${stopped.length === 1 ? 'isn’t' : 'aren’t'} sold at all (it stops selling while an outcome is out, "whenOut": "stopSales"), and ` : ''}a draw that lands on it is not made and gives back that draw’s worth, no other outcome taking its place, and a box of nothing else sells nothing.`,
      );
    }
    if (!users.length && !named.length)
      warn(
        'W-STASH',
        where,
        `No box and no prize gives an NFT of ${label(s)}: what it holds stays with the game.`,
        'Add an outcome { "gives": "stash", "stash": key } to a box, or a prize { "gives": "nft", "stash": key, "nft": address }.',
      );
    // Who takes from it: buyers and every route that rolls those boxes (one NFT a roll), and the prizes naming one.
    const takers = [
      ...new Set([
        ...users.flatMap(b => [
          ...(b.active !== false ? [b.shopOf ? `item:${b.shopOf}` : `box:${b.key}`] : []),
          ...rolls.filter(r => r.box === b.key).map(r => r.by),
        ]),
        ...named.map(p => p.by),
      ]),
    ];
    if (takers.length > 1)
      warn(
        'W-STASH-SHARED',
        where,
        `${label(s)} is given by ${takers.join(', ')}: ${users.length ? 'each roll takes an NFT out at random' : ''}${users.length && named.length ? ', and ' : ''}${named.length ? 'a prize that names an NFT finds it gone once a roll took it' : ''}, so one route can empty it before another pays, and a winner then gets the box’s other outcomes, or nothing. A lottery’s, a contest’s or an auction’s winner gets theirs only once the result is in.`,
        'Give each route a stash of its own (a named NFT in a stash no box rolls), or keep it stocked.',
      );
  }
  // A prize that names one NFT gives it once: every later winner of the route gets nothing (a grant's claim or a craft
  // is refused).
  for (const p of directs) {
    if (p.once) continue;
    warn(
      'W-PRIZE-ONCE',
      p.where,
      `${p.by} gives ${prizeWords(p.prize, m)}, one NFT: the first winner takes it, and ${p.strict ? 'every claim or craft after is refused (PrizeNotCovered)' : 'every winner after gets nothing for it'}.`,
      p.route === 'grant'
        ? 'Limit the grant to one claim ("limits.total": 1), or give a roll of a box of a stash of many.'
        : 'Give a roll of a box of a stash of many, or an item or tokens each winner can get.',
    );
  }
  // The game's own collection moves as the game says; any other's, as whoever controls it says.
  const others = m.stashes.filter(s => stashNfts(s).some(n => !(n.kind === 'core' && !n.collection)));
  if (others.length) {
    const ruled = others
      .flatMap(s => stashNfts(s))
      .filter(n => n.kind === 'token-metadata' && n.programmable && n.ruleSet).length;
    warn(
      'W-STASH-TRANSFER',
      'economy.stashes',
      `${others.map(label).join(', ')} hold${others.length === 1 ? 's' : ''} NFTs of collections the game has no authority over. An NFT goes to its winner through its own program, and whoever controls its collection can make that refuse (a Core freeze or a permanent delegate, a pNFT rule set that does not let programs hold or send it${ruled ? `; ${ruled} listed have a rule set` : ''}): a won order then can’t be settled until they allow it, and a prize that names such an NFT holds up what gives it (a lottery round’s last payment, a contest’s claim, a mission’s unstake) until the owner or the authority drops it from the stash (\`loot.stashIx\` out to the game’s own address).`,
      'Stash NFTs of collections that let them move freely (the game’s own, or a partner’s you trust).',
    );
  }
  Object.assign(c, { takers, rolls, roller });
}
