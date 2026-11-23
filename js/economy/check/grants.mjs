// The checks of holds (hold.rs) and grants (grant.rs).
import { isAddress, listOf, byPerson, limitsPlayers, prizePool, prizeToken } from '../model.mjs';
import { label } from '../format.mjs';
import { isCollectible } from '../sizes.mjs';

/** Checks the holds and the grants. */
export function checkGrants(c) {
  const {
    economy,
    now,
    refuse,
    warn,
    m,
    tradeable,
    grantClaimSol,
    units,
    seconds,
    timeAt,
    farTime,
    item,
    prizeCheck,
    rule,
    perWalletWindow,
    opensAndCloses,
  } = c;
  // ---- holds (hold.rs)
  for (const h of m.holds) {
    const where = `economy.holds.${h.key}`;
    const it = item(h.item, `${where}.item`);
    if (it && (!isCollectible(it) || it.soulbound))
      refuse(
        'E-HOLD',
        `${where}.item`,
        `${label(h)} holds ${label(it)}, which is ${it.soulbound ? 'soulbound' : 'not a collectible'}: only a collectible that can move can be held.`,
        'Hold a collectible that is not soulbound.',
      );
    // While a hold runs, the project's authority alone decides where the NFT goes; a far end is taken.
    farTime(
      now + seconds(h.for, `${where}.for`),
      `${where}.for`,
      `${label(h)}’s holds`,
      h.for,
      'each NFT waits with the project',
    );
    warn(
      'W-HOLD',
      where,
      `${label(h)}: while a hold runs, the project’s authority alone decides where its NFT goes, and it runs as long as the project sets. Players trust the project with the NFT until then.`,
    );
    if (h.until !== undefined && timeAt(h.until, `${where}.until`) < now)
      warn(
        'W-HOLD',
        `${where}.until`,
        `${label(h)}’s holds end before the economy goes live: each one is over at once, and anyone can send its NFT home.`,
      );
  }

  // ---- grants (grant.rs)
  // Limits per person: every wallet the project's issuer linked to one person counts together, so the issuer is named,
  // and a part counts wallets or persons, not both.
  const limited = [
    ...['items', 'boxes', 'recipes', 'lotteries'].flatMap(list =>
      (economy[list] ?? []).map((p, i) => [p, `economy.${list}[${i}]`, p]),
    ),
    ...(economy.grants ?? []).map((g, i) => [g.limits, `economy.grants[${i}].limits`, g]),
  ];
  for (const [part, where, owner] of limited) {
    if (!byPerson(part)) continue;
    if (!economy.keys?.issuer)
      refuse(
        'E-PERSON',
        where,
        `${label(owner)} limits each person, and the economy names no issuer: no wallet could be linked to a person, so every one would be refused (NotLinked).`,
        'Add "keys": { "issuer": "<the server key that signs who is who>" } (the grants’ voucher key may be it), or limit each wallet ("perWallet").',
      );
    if (part.perWallet != null || part.perWalletEach != null)
      refuse(
        'E-PERSON',
        where,
        `${label(owner)} names both a limit per wallet and one per person: a limit counts wallets or persons, not both.`,
        'Keep "perPerson" / "perPersonEach" (a person with every wallet of theirs), or "perWallet" / "perWalletEach".',
      );
  }

  for (const g of m.grants) {
    const where = `economy.grants.${g.key}`;
    const old = g.gives ?? {};
    if (g.prize && g.gives)
      refuse(
        'E-GRANT',
        `${where}.gives`,
        `${label(g)} names a "prize" and "gives": one is its prize.`,
        'Keep "prize".',
      );
    if (!g.prize && [old.item, old.pool, old.roll].filter(Boolean).length > 1)
      refuse('E-GRANT', `${where}.gives`, `${label(g)} gives more than one thing.`, 'Give one "prize".');
    else if (!g.prize && !g.gives)
      refuse(
        'E-GRANT',
        `${where}.prize`,
        `${label(g)} gives nothing.`,
        'Add a "prize": { "gives": "item", "item": key }, { "gives": "tokens", … }, { "gives": "nft", … } or { "gives": "roll", "box": key }.',
      );
    const gives = prizeCheck(g.prize ?? g.gives, `${where}.${g.prize ? 'prize' : 'gives'}`, label(g), 'E-GRANT') ?? {};
    if (g.limits?.tokens != null && gives.gives && gives.gives !== 'tokens')
      refuse(
        'E-GRANT',
        `${where}.limits.tokens`,
        `${label(g)} caps the tokens it gives, but gives ${gives.gives === 'item' ? 'an item' : `a ${gives.gives}`}: the cap counts tokens only (BadLimits).`,
        'Remove "tokens", or bound the grant with "total" and "perDay".',
      );
    // The most tokens it gives in all (grant.rs `Limits.tokens`), counted in its prize's token.
    else if (g.limits?.tokens != null && gives.gives === 'tokens')
      units(
        g.limits.tokens,
        prizeToken(gives, m),
        `${where}.limits.tokens`,
        `${label(g)}’s cap on the tokens it gives`,
      );
    const vouchers = g.vouchers ?? [];
    const keys = g.keys ?? [];
    const l = g.limits ?? {};
    const open = !vouchers.length && !keys.length && !(g.list ?? []).length;
    // A grant written again with the same list lets its wallets claim again.
    if ((g.list ?? []).length)
      warn(
        'W-GRANT',
        `${where}.list`,
        `${label(g)} pays the wallets on its list: if it is ever made again with the same list (closed and opened anew), they can claim again.`,
        'For a second round, change the list or the amounts; leave it as it is to pay each wallet once.',
      );
    // List entries that name their own amount: tokens of a fixed amount only, each at most the grant's (OverPrize).
    for (const [i, e] of (g.list ?? []).entries()) {
      if (typeof e !== 'object' || e.amount === undefined) continue;
      const t = prizeToken(gives, m);
      if (gives.gives !== 'tokens')
        refuse(
          'E-GRANT',
          `${where}.list[${i}].amount`,
          `${label(g)}’s list names an amount, but it gives ${gives.gives ?? 'nothing'}: only a grant of a fixed amount of tokens takes one.`,
          'Remove "amount", or make the grant give tokens.',
        );
      else if (
        t &&
        units(e.amount, t, `${where}.list[${i}].amount`, 'A listed amount') >
          units(gives.amount, t, `${where}.prize.amount`, label(g))
      )
        refuse(
          'E-GRANT',
          `${where}.list[${i}].amount`,
          `${label(g)}’s list gives ${e.wallet} ${e.amount}, more than the grant’s ${gives.amount} (OverPrize).`,
          'Raise the grant’s amount to the largest listed, or lower this one.',
        );
    }
    // A grant with no voucher key, no key list and no list is open: any wallet claims it, within its limits (grant.rs).
    if (open && !limitsPlayers(l))
      warn(
        'W-GRANT',
        where,
        `${label(g)} has no voucher key, no keys and no list, and limits no wallet: the first wallet to come can claim it again and again, up to its total${l.total ? '' : ' (it has none: until its funds or its pool run out)'}.`,
        'Set "limits.perWallet" (1 is usual) to make it a one-per-wallet claim, or add "vouchers", "keys" or a "list".',
      );
    if (open)
      warn(
        'W-GRANT-OPEN',
        where,
        g.gate?.wallets
          ? `${label(g)} is open to the ${g.gate.wallets.length} wallets its gate lists, within its limits.`
          : g.gate?.list
            ? `${label(g)} is open to the wallets on its gate’s list, within its limits.`
            : g.gate?.staked
              ? `${label(g)} is open to any wallet with the stake its gate asks, within its limits. Someone who stakes from many wallets claims once per wallet.`
              : g.gate
                ? `${label(g)} is open: any wallet that shows what its gate asks can claim it, within its limits, and each collectible shown counts too, so passing one around claims nothing more.`
                : tradeable(gives)
                  ? `${label(g)} is open: any wallet can claim it, within its limits, and wallets are free to make, so someone with many wallets claims once per wallet. What it gives ${gives.gives === 'roll' ? 'is a roll of a box' : 'can be sold'}, so claiming it from many wallets pays.`
                  : `${label(g)} is open: any wallet can claim it, within its limits. Someone with many wallets claims once per wallet.`,
        g.gate
          ? undefined
          : tradeable(gives)
            ? 'Make each claim cost a sybil something: a gate on holding a collectible the game sells or a locked stake, or vouchers from your server that count people ("perPerson", with an outside sign-in such as X). Keep "perDay" and "total" small either way.'
            : 'Give it a gate (a collectible each claimer must hold), or keep "total" small.',
      );
    // `trust` says what the server holding a voucher key checks: a grant with no voucher key or code has no such server.
    if (g.trust && !vouchers.length && !keys.length)
      refuse(
        'E-GRANT-TRUST',
        `${where}.trust`,
        `${label(g)} says its server ${g.trust} the result ("trust"), but it is paid ${open ? 'to any wallet that asks (it is open)' : 'to the wallets on its list'}: no server signs for it, so nothing checks what a claimer did.`,
        open
          ? 'Remove "trust", or name the server’s public key in "vouchers" so its claims are signed.'
          : 'Remove "trust": the list is the owner’s own choice, written in the spec.',
      );
    for (const [i, v] of vouchers.entries())
      if (!isAddress(v))
        refuse(
          'E-GRANT',
          `${where}.vouchers[${i}]`,
          'A voucher key must be a public address.',
          'Write the signer’s public key (never its private key).',
        );
    for (const [i, v] of keys.entries())
      if (!isAddress(v))
        refuse(
          'E-GRANT',
          `${where}.keys[${i}]`,
          'A key must be a public address.',
          'Write each code’s public key (never its private key or the code itself).',
        );
    if (!open && !l.perWallet && !l.perPerson && !l.total && !l.perDay && !l.perKey && !l.perWalletEach?.count)
      warn(
        'W-GRANT-LIMITS',
        `${where}.limits`,
        `${label(g)} has no limits: a leaked voucher key can take everything its ${prizePool(gives) ? 'pool' : 'prize'} has.`,
        'Set "perWallet" (1 is usual), and "total" or "perDay".',
      );
    // Wallets are free, and a voucher key can leak: what bounds a grant is its totals, not its per-wallet limits.
    const perClaimer = limitsPlayers(l) || l.perKey;
    const listOnly = !open && !vouchers.length && !keys.length;
    // Codes that each pay a set number of times (perKey) are a total already: as many claims as codes allow.
    const codesOnly = keys.length && l.perKey && !vouchers.length;
    if (!listOnly && !codesOnly && perClaimer && !l.perDay && !l.total)
      warn(
        'W-GRANT-TOTAL',
        `${where}.limits`,
        `${label(g)} limits each ${byPerson(l) ? 'person' : l.perKey && !limitsPlayers(l) ? 'key' : 'wallet'} but nothing a day or in all: ${open ? 'every new wallet (free to make) claims its share' : vouchers.length ? 'a leaked voucher key signs for as many wallets as it likes' : 'a shared code pays every wallet that uses it'}, until ${prizePool(gives) ? 'its pool' : gives.gives === 'tokens' && gives.from !== 'mint' ? 'its prize runs out' : 'its funds run out (then each claimer pays its own rent)'}.`,
        'Set "perDay" (and "total"): they are the most it can ever pay, whatever happens to a key or how many wallets come.',
      );
    if (keys.length && !l.perKey)
      warn(
        'W-GRANT-LIMITS',
        `${where}.limits.perKey`,
        `${label(g)} takes vouchers from ${keys.length} keys but limits no key: a code someone shares pays every wallet that uses it.`,
        'Set "perKey": 1 for codes that pay once each.',
      );
    // A list written in xsolana.json has every leaf at round zero, and a round pays a wallet once (grant.rs take_round).
    const rounds = (g.list ?? []).some(e => typeof e === 'object' && e.round);
    if (
      (g.list ?? []).length &&
      !vouchers.length &&
      !keys.length &&
      !rounds &&
      ((l.perWallet ?? 1) > 1 || l.perWalletEach)
    )
      warn(
        'W-LIST-ONCE',
        `${where}.limits`,
        `${label(g)} pays each entry on its list once: a wallet listed once is paid once, whatever "perWallet" or "perWalletEach" say.`,
        'List the wallet again under another "round" ({ "wallet", "amount", "round" }) for each payout, or name a results server’s key in "vouchers".',
      );
    // Every entry of the list is a claim of its own, and "total" counts every claim (grant.rs): the entries past it are refused.
    if ((g.list ?? []).length && l.total && l.total < g.list.length)
      warn(
        'W-GRANT-LIMITS',
        `${where}.limits.total`,
        `${label(g)} lists ${g.list.length} claims but pays ${l.total} in all ("total"): once ${l.total} are claimed, the rest of the list is refused.`,
        `Raise "total" to ${g.list.length}, or leave it out.`,
      );
    if (l.perWalletEach && !(l.perWalletEach.count > 0))
      refuse(
        'E-GRANT',
        `${where}.limits.perWalletEach`,
        `${label(g)} limits each wallet in a window but names no count.`,
        'Give "count" (how many claims a wallet makes in each window) and "every" (like "1d").',
      );
    perWalletWindow(l, `${where}.limits`);
    opensAndCloses(l, `${where}.limits`, 'until');
    // Its funds are SOL, which pays each claim's rent.
    const funds = g.fund === undefined ? 0n : units(g.fund, { decimals: 9 }, `${where}.fund`, `${label(g)}’s funds`);
    const perClaim = grantClaimSol(g.key);
    if (funds === 0n)
      warn(
        'W-GRANT-FUNDS',
        `${where}.fund`,
        `${label(g)} has no funds: whoever pays for each claim (the winner, who always signs it, or anyone paying its fees for them) pays its rent as well as the player fee.`,
        perClaim
          ? `Set "fund": each claim costs its funds about ${perClaim} SOL, so 0.05 SOL covers about ${Math.floor(0.05 / perClaim)} claims (then claimers pay their own rent).`
          : 'Set "fund" (0.05 SOL covers about a dozen claims) so winners claim for only the player fee and the network fee, or top it up after it goes live: anyone sends SOL to the grant.',
      );
    rule(g.gate, `${where}.gate`, label(g));
  }

  // (a farm that mints without end, and rewards that buy more of what earns them: W-VALUE's net flow, growth and
  // loops, challenge.mjs)
  // An NFT a farm watches (left free in its wallet) can be staked in a farm that holds it: its watched seat stops, and
  // what it was owed and not harvested is gone (farm.rs: a watched seat earns only while its NFT is still there).
  const farmCollections = f =>
    listOf(f.gate)
      .map(r => r?.collection)
      .filter(Boolean);
  const overlaps = (a, b) => {
    if (a.item && b.item) return a.item === b.item;
    const [ca, cb] = [farmCollections(a), farmCollections(b)];
    return !ca.length || !cb.length || ca.some(c => cb.includes(c));
  };
  const nftFarms = m.farms.filter(f => f.stakes === 'collectibles');
  for (const w of nftFarms.filter(f => f.custody === 'watch'))
    // (a farm that freezes the NFT leaves it in its wallet, so the watched seat goes on: only escrow moves it away)
    for (const h of nftFarms.filter(f => f !== w && (f.custody ?? 'escrow') === 'escrow' && overlaps(w, f)))
      warn(
        'W-FARM-SWITCH',
        `economy.farms.${w.key}.custody`,
        `An NFT ${label(w)} watches can be staked in ${label(h)}, which takes it into the game's keeping: its seat in ${label(w)} stops, and what that seat was owed and not harvested is lost.`,
        `Have the page harvest (or leave) ${label(w)} before it stakes the NFT in ${label(h)}.`,
      );
}
