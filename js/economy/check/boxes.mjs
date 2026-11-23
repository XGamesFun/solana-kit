// The checks of boxes (catalog.rs, order.rs), and of a live box whose roll is rewritten. Sets `chance` and
// `randomItems` on the context (players pay for a chance at money, or for a random item they can resell), which the
// lotteries and auctions add to and the decisions warn of.
import { ASSUMED_TRIES, boxBytes, buyFits, drawsFit, MAX_ORDER_BYTES, tableBudget } from '../../client/sizes.js';
import { MAX_TRANSACTION_BYTES } from '../../chain/tx.js';
import {
  LIMITS,
  ANSWER_HOLDS,
  RESERVED_ATTRIBUTES,
  fromUnits,
  outcomeParts,
  boxBuys,
  boxRolls,
  drawsOf,
  limitsPlayers,
  prizes,
  stopsSales,
  sharesOf,
  weights,
} from '../model.mjs';
// plan.mjs imports check() in turn: each module only calls the other's functions, never at load time.
import { boxArgs, boxOrderBytes } from '../plan.mjs';
import { label } from '../format.mjs';
import {
  ACCOUNT_LOCKS,
  buySize,
  LEGACY_MOST_ACCOUNTS,
  LONGEST_PROOF,
  MAX_COMPUTE_UNITS,
  openBoxSize,
  settleAccounts,
  settleSize,
  settleComputeUnits,
  TABLE_LOCKS,
} from '../sizes.mjs';

/** Checks the boxes. Sets `c.chance` and `c.randomItems`. */
export function checkBoxes(c) {
  const {
    economy,
    project,
    refusals,
    refuse,
    warn,
    m,
    units,
    fourByteSeconds,
    tooMany,
    quietUnits,
    built,
    token,
    pool,
    item,
    compressedCheck,
    prizeCheck,
    rule,
    timed,
    effect,
    thenCheck,
    split,
    feeNote,
    perWalletWindow,
    opensAndCloses,
    prices,
    takers,
    rolls,
    roller,
  } = c;
  // ---- boxes (catalog.rs, order.rs)
  /**
   * What one answer of the oracle's holds: the program refuses a box when it is written (PackTooLarge) when one
   * answer can't hold a draw of it, a box of one draw included. Each measured number (`ANSWER_HOLDS`) is the most of
   * one thing in a box otherwise small: past one, the box is refused here; a box that mixes several near their numbers
   * is warned of, since together they fit less.
   */
  const answerHolds = (b, where) => {
    const outs = b.outcomes ?? [];
    const texts = r => (r?.oneOf ?? []).length + (r?.items ?? []).length;
    const parts = outs.map(outcomeParts);
    const tokenOutcomes = parts.filter(p => p.some(x => x.gives === 'pay' || x.gives === 'mint')).length;
    const itemOutcomes = parts.filter(p => p.some(x => x.gives === 'item')).length;
    const gateTexts = texts(b.gate);
    const oddsTexts = (b.odds ?? []).reduce((n, o) => n + texts(o.when), 0);
    const over = [
      [outs.length, ANSWER_HOLDS.entriesOfNothing, `${outs.length} outcomes`, `${where}.outcomes`],
      [(b.slots ?? []).length, ANSWER_HOLDS.slots, `${(b.slots ?? []).length} slots`, `${where}.slots`],
      [(b.odds ?? []).length, ANSWER_HOLDS.odds, `${(b.odds ?? []).length} odds rules`, `${where}.odds`],
      [gateTexts, ANSWER_HOLDS.gateTexts, `${gateTexts} texts in its gate`, `${where}.gate`],
      ...parts.flatMap((p, i) => [
        [
          p.filter(x => x.gives === 'pay' || x.gives === 'mint').length,
          ANSWER_HOLDS.entryTokens,
          `${p.filter(x => x.gives === 'pay' || x.gives === 'mint').length} token prizes in outcome ${i}`,
          `${where}.outcomes[${i}]`,
        ],
        [
          p.filter(x => x.gives === 'item').length,
          ANSWER_HOLDS.entryCollectibles,
          `${p.filter(x => x.gives === 'item').length} items in outcome ${i}`,
          `${where}.outcomes[${i}]`,
        ],
      ]),
    ].filter(([n, most]) => n > most);
    for (const [, most, what, at] of over)
      refuse(
        'E-ODDS',
        at,
        `${label(b)} has ${what}: one answer of the oracle’s holds at most ${most} of that, as measured, and the program refuses a box when it is written that one answer can’t draw (PackTooLarge).`,
        'Put a long weighted list in a table (an item that draws a trait from it) or a stash, drawn by one outcome; give fewer prizes in one outcome; keep a gate’s "oneOf" short.',
      );
    if (over.length) return;
    // How much of one answer the box takes, each part at its measured number: a guide, not the program's count.
    const used =
      (outs.length - tokenOutcomes - itemOutcomes) / ANSWER_HOLDS.entriesOfNothing +
      tokenOutcomes / ANSWER_HOLDS.entriesOfTokens +
      itemOutcomes / ANSWER_HOLDS.entriesOfItems +
      (b.slots ?? []).length / ANSWER_HOLDS.slots +
      (b.odds ?? []).length / ANSWER_HOLDS.odds +
      gateTexts / ANSWER_HOLDS.gateTexts;
    if (used > 0.75)
      warn(
        'W-ANSWER',
        where,
        `${label(b)} is long: by the measured numbers it takes about ${Math.round(used * 100)}% of what one answer of the oracle’s holds. One answer holds 128 outcomes that give nothing, 29 of token amounts or 18 each of its own item; 41 slots; 72 odds rules; 16 token prizes or 18 collectibles in one outcome; 340 texts in a box’s gate. A box that mixes them fits less, and one that does not fit is refused when it is written (PackTooLarge). A box written from a wallet carries about 960 bytes; a longer one needs a program call (a multisig).`,
        'Put a long weighted list in a table or a stash, drawn by one outcome.',
      );
    // An outcome of 15 to 18 collectibles fits an answer, but not a sale in one step.
    const many = parts.findIndex(p => p.filter(x => x.gives === 'item').length >= 15);
    if (many >= 0 && outs.length === 1 && boxBuys(b, m))
      warn(
        'W-ANSWER',
        `${where}.outcomes[${many}]`,
        `${label(b)} gives ${parts[many].filter(x => x.gives === 'item').length} collectibles in one outcome: a box of one outcome with 15 to 18 collectibles is too wide for a sale in one step and sells only through the oracle (an open, then a settle).`,
        'Fine as it is; or split the bundle in two boxes to sell each in one step.',
      );
    if (oddsTexts > 200)
      warn(
        'W-ANSWER',
        `${where}.odds`,
        `${label(b)}’s odds rules list ${oddsTexts} "one of" texts in all: the oracle’s answer reads them all, and past a few hundred it cannot land, so every purchase is refunded after 10 minutes.`,
        'Keep "one of" lists in odds rules short, or raise the odds by a number (an attribute "atLeast").',
      );
  };
  /** Every prize a route gives (a grant, a place, a mission, a recipe...), for what a box shares with them. */
  const routePrizes = prizes(m);
  // Whether players pay for a chance at money, or for a random item they can resell: the lotteries and the auctions add
  // to these, and the decisions warn of them.
  c.chance = false;
  c.randomItems = false;
  /** Per pool, the largest fixed prize a box pays from it, and every box that pays one: warned of once a pool, below. */
  const seedNeeds = new Map();
  for (const b of m.boxes) {
    const where = `economy.boxes.${b.key}`;
    // A pack: each slot draws at least once, among outcomes the box has, each named once. Several draws need a box that
    // rolls, or one outcome of items, with no outcome that burns the payment and no NFT to roll on (BadEntries).
    const slots = b.slots ?? [];
    const outs = b.outcomes ?? [];
    const heldBefore = refusals.length;
    answerHolds(b, where);
    const answerRefused = refusals.length > heldBefore;
    for (const [i, o] of outs.entries()) {
      const given = outcomeParts(o);
      tooMany(
        given.length,
        LIMITS.entryPrizes,
        'E-ODDS',
        `${where}.outcomes[${i}].prizes`,
        `An outcome of ${label(b)} gives ${given.length} prizes`,
        'BadEntries',
        'Give fewer, or make it two outcomes.',
      );
      // What a roll changes on the NFT it is on is written by the settle, with the NFT's own attributes.
      if ((o.shifts ?? []).length > 16)
        warn(
          'W-ANSWER',
          `${where}.outcomes[${i}].shifts`,
          `An outcome of ${label(b)} changes ${(o.shifts ?? []).length} numbers on the NFT it rolls on. The settle writes them with the NFT’s own attributes, and together they must stay under about 60, or the settle cannot land and a held NFT waits with the project.`,
          'Change fewer numbers in one outcome, and keep the NFTs it rolls on to few attributes.',
        );
      // An outcome gives all it names or isn't given (order.rs): what it names is refused at the write when it can clash.
      for (const [j, x] of given.entries()) {
        const clash = given
          .slice(0, j)
          .map(y => samePrizes(y, x))
          .find(Boolean);
        if (clash)
          refuse(
            'E-ODDS',
            `${where}.outcomes[${i}].prizes[${j}]`,
            `An outcome of ${label(b)} ${clash}: it gives all it names or isn't given, so the program refuses the box (BadEntries).`,
            "Name each pool once, with the whole amount, and a stash's random NFT beside nothing else of that stash.",
          );
      }
      // Two of an item take two units: an entry of more than its supply can never be given.
      for (const key of new Set(given.filter(x => x.gives === 'item').map(x => x.item))) {
        const count = given.filter(x => x.gives === 'item' && x.item === key).length;
        const supply = Number(m.item.get(key)?.supply ?? 0);
        if (supply > 0 && count > supply)
          warn(
            'W-OUT-OF-STOCK',
            `${where}.outcomes[${i}]`,
            `An outcome of ${label(b)} gives ${count} of ${label(m.item.get(key))}, which has a supply of ${supply}: it needs them all left, so it can never be given${stopsSales(b) && b.active !== false && boxRolls(b, m) ? ', and a box that stops selling while an outcome is out ("whenOut": "stopSales") is never sold' : ', and a draw that lands on it gives back that draw’s worth'}.`,
            'Give fewer, or raise its supply.',
          );
      }
    }
    // A box that stops selling once an outcome is out covers each purchase's draws, and a random draw of a stash could
    // take one of its NFTs another outcome names: it can't list both (catalog.rs, BadEntries).
    if (stopsSales(b)) {
      // One outcome naming both is refused above already.
      const parts = outs.map(outcomeParts);
      const random = parts.flatMap((p, i) => p.filter(x => x.gives === 'stash').map(x => [i, x.stash]));
      const mixed = [
        ...new Set(
          random
            .filter(([i, key]) => parts.some((p, j) => j !== i && p.some(y => y.gives === 'nft' && y.stash === key)))
            .map(([, key]) => key),
        ),
      ];
      for (const key of mixed)
        refuse(
          'E-ODDS',
          `${where}.outcomes`,
          `${label(b)} gives an NFT of the stash “${key}” at random and, in another outcome, one of its NFTs by name, and it stops selling once an outcome is out ("whenOut": "stopSales", the default): a random draw could take the named one, so nothing could cover it, and the program refuses the box (BadEntries).`,
          `Make it "whenOut": "drawLeft" or "giveNothing", or give the named NFT from a stash of its own.`,
        );
    }
    // A fresh outcome's tables come with the answer while they fit what the box's own accounts leave, in outcome order
    // (`tableBudget`). One past that is out of stock on every roll, so its odds would be false.
    {
      const box = built(() => boxArgs(b, m), where, label(b));
      if (box && boxRolls(b, m)) {
        let left = Math.max(0, tableBudget(box.entries));
        const cut = [];
        outs.forEach((out, i) => {
          for (const part of outcomeParts(out)) {
            if (part.gives !== 'item') continue;
            const tables = (m.item.get(part.item)?.drawn ?? []).filter(d => d.table).length;
            if (tables > left) cut.push(i);
            else left -= tables;
          }
        });
        if (cut.length)
          refuse(
            'E-ODDS',
            `${where}.outcomes`,
            `${label(b)} draws from more tables than one answer of the oracle’s can carry, so outcome${cut.length === 1 ? '' : 's'} ${[...new Set(cut)].join(', ')} could never be won.`,
            'Fewer outcomes with drawn traits, fewer table traits on each, or a range (`min`, `max`) in place of a table.',
          );
      }
    }
    slots.forEach((s, i) =>
      (s.from ?? []).forEach((o, j) => {
        if (o >= outs.length)
          refuse(
            'E-ODDS',
            `${where}.slots[${i}].from[${j}]`,
            `Slot ${i} of ${label(b)} names outcome ${o}, but the box has ${outs.length}.`,
            'Name outcomes by their place in "outcomes", from 0.',
          );
        else if ((s.from ?? []).slice(0, j).includes(o))
          refuse(
            'E-ODDS',
            `${where}.slots[${i}].from[${j}]`,
            `Slot ${i} of ${label(b)} names outcome ${o} twice.`,
            'Name each once.',
          );
      }),
    );
    // A compressed item an outcome gives is minted at the settle, as any prize's (`compressedCheck`).
    outs.forEach((o, i) =>
      outcomeParts(o).forEach(
        part =>
          part.gives === 'item' &&
          part.compressed &&
          m.item.get(part.item) &&
          compressedCheck(m.item.get(part.item), `${where}.outcomes[${i}]`, label(b), 'E-ODDS'),
      ),
    );
    const cards = slots.reduce((n, s) => n + s.count, 0);
    // Slots that name outcomes draw different things, so each says what it is worth (BadEntries): what a draw that
    // can't be made gives back.
    const shared = slots.reduce((n, s) => n + Math.round((s.share ?? 0) * 100), 0);
    const named = outs.length > 1 && slots.some(s => (s.from ?? []).length);
    const zero = named && slots.some(s => !s.share);
    if (zero || shared !== (named ? 10_000 : 0))
      refuse(
        'E-ODDS',
        `${where}.slots`,
        named
          ? `The slots of ${label(b)} name outcomes, so each says what it is worth as a share of an open's price, more than 0 each and 100 together; these come to ${shared / 100}.`
          : `The slots of ${label(b)} all draw among every outcome, so every draw is worth the same: they take no share.`,
        named
          ? 'Give each slot a "share": a draw that can\'t be made gives its slot\'s worth back, so make a rare slot worth what the rare is.'
          : 'Leave "share" out.',
      );
    // Every outcome is one some slot draws (BadEntries): one no slot draws would count as stock no roll can give.
    if (slots.length && !slots.some(s => !(s.from ?? []).length)) {
      const undrawn = outs.map((_, i) => i).filter(i => !slots.some(s => (s.from ?? []).includes(i)));
      if (undrawn.length)
        refuse(
          'E-ODDS',
          `${where}.slots`,
          `No slot of ${label(b)} draws its outcome${undrawn.length === 1 ? '' : 's'} ${undrawn.join(', ')}: an outcome no slot draws is never given, so the program refuses the box (BadEntries).`,
          'Name each outcome in some slot’s "from", leave "from" out of a slot (it draws among all), or drop the outcome.',
        );
    }
    // Every draw of one open fits one answer of the oracle's (PackTooLarge): a pack past it could only draw its first
    // cards, so the program refuses the box. A box that doesn't roll sells by `buy`, the whole purchase in one
    // transaction, or through the oracle when one `buy` can't carry it (`buyFits`): then the answer's heap counts, and it
    // can't give a roll, which only `buy` gives (catalog.rs). The heap counts the box's own bytes too (`boxBytes`), and
    // the compute finding each pool's and stash's address its prizes name (exact with the project, else assumed).
    // A box of one draw is held to the same count: past it the program refuses the box when it is written.
    if (outs.length && (cards > 1 || !answerRefused)) {
      const args = built(() => boxArgs(b, m), where, label(b));
      const entries = args?.entries;
      if (entries) {
        const byBuy = boxRolls(b, m) || Boolean(b.rollsOn) || buyFits(args, Math.max(1, cards));
        const extras = {
          odds: args.odds.length,
          shares: args.shares.length,
          fates: args.fates.length,
          bytes: boxBytes(args),
          oracle: !byBuy,
          project,
        };
        const searches = entries.some(e => e.prizes.some(p => p.Tokens?.from?.Pool || p.Stash != null || p.Nft));
        const searched = searches
          ? project
            ? ' (finding the address of each pool and stash it names counted for this project)'
            : ` (finding the address of each pool and stash it names counted at ${ASSUMED_TRIES} tries each, as no wallet is named yet: the check with your wallet counts it exactly)`
          : '';
        const drawn = slots.length ? slots.map(s => ({ count: s.count, only: s.from ?? [] })) : 1;
        if (!byBuy && entries.some(e => e.prizes.some(p => p.Roll != null)))
          refuse(
            'E-ODDS',
            `${where}.slots`,
            `${label(b)} gives a roll, which only a sale in one step gives, but ${Math.max(1, cards)} of what it gives don’t fit one transaction (its accounts, its instructions or its compute), so the program refuses the box (PackTooLarge).`,
            'Fewer cards an open, fewer prizes in its outcome, or fewer shares in its split.',
          );
        else if (cards > 1 && !drawsFit(entries, drawn, 1, extras)) {
          // The most cards that fit, found by halving (each card more costs more, so what fits is every count up to
          // one number): a count written in the billions is answered as fast as one of ten.
          let most = 1;
          for (let over = cards; over - most > 1;) {
            const half = most + Math.floor((over - most) / 2);
            if (drawsFit(entries, half, 1, extras)) most = half;
            else over = half;
          }
          refuse(
            'E-ODDS',
            `${where}.slots`,
            `${label(b)} draws ${cards} cards an open among ${outs.length} outcome${outs.length === 1 ? '' : 's'}: more than one answer of the oracle’s can draw (about ${most} here${searched}), so the program refuses the box (PackTooLarge).`,
            'Fewer cards an open (sell two packs instead of one), fewer outcomes, fewer prizes in an outcome, or a smaller box (fewer odds, shares, slots or outcomes that act on the NFT).',
          );
        } else if (cards <= 1 && !drawsFit(entries, drawn, 1, extras))
          refuse(
            'E-ODDS',
            `${where}.outcomes`,
            `${label(b)} is too long for one answer of the oracle’s to draw it once${searched}, so the program refuses the box when it is written (PackTooLarge).`,
            'Fewer outcomes, fewer prizes in an outcome, fewer pools or stashes named, or a smaller box (fewer odds, shares or slots). Put a long weighted list in a table or a stash, drawn by one outcome.',
          );
      }
    }
    if (cards > 1 && b.rollsOn)
      refuse(
        'E-ODDS',
        `${where}.slots`,
        `${label(b)} draws ${cards} times an open, but a pack has no NFT it rolls on (BadEntries).`,
        'Leave "slots" out, or drop "rollsOn".',
      );
    // An open's order holds every prize it can set aside: at most 10,240 bytes (about 243 one-prize draws).
    const orderSize = built(() => boxOrderBytes(b, m), where, `${label(b)}’s order`) ?? 0;
    if (orderSize > MAX_ORDER_BYTES)
      refuse(
        'E-ODDS',
        `${where}.slots`,
        `${label(b)}’s order would be ${orderSize.toLocaleString('en-US')} bytes, more than the ${MAX_ORDER_BYTES.toLocaleString('en-US')} an order can be (BadEntries).`,
        'Fewer draws an open, or fewer prizes in its largest outcome.',
      );
    // A roll moves its prizes aside with no accounts of a transfer hook's, and can't move tokens whose mint allows
    // confidential transfers or none at all: such a prize is out of stock in every roll (order.rs `mints_in_stock`): a draw
    // that lands on it is not made and gives back its worth, and a box with nothing else in stock is refused when it is
    // opened or asked for (SoldOut).
    const rolledAtAll = !boxBuys(b, m) || rolls.some(r => r.box === b.key);
    if (rolledAtAll)
      for (const [i, o] of outs.entries()) {
        const tokenOf = x =>
          x.gives === 'pay'
            ? m.pool.get(x.pool)?.currency
            : x.gives === 'mint'
              ? (x.currency ?? m.currencyKey)
              : undefined;
        const bad = outcomeParts(o)
          .map(x => m.tokens.get(tokenOf(x)))
          .find(t => t?.powers?.transferHook || t?.powers?.confidentialTransfers);
        if (!bad) continue;
        const why = bad.powers.transferHook
          ? 'whose mint has a transfer hook (a roll carries none of the accounts a hook asks for)'
          : 'whose mint allows confidential transfers';
        warn(
          'W-OUT-OF-STOCK',
          `${where}.outcomes[${i}]`,
          `${label(b)} pays a prize in ${bad.symbol ?? bad.key}, ${why}: a roll can’t move it, so this outcome is out of stock in every roll of the box: its odds stay as written, a draw that lands on it makes no draw and gives back that draw’s worth, and no other outcome takes its place${outs.length === 1 ? '; with nothing else in it, every opening or roll of the box is refused (SoldOut)' : ''}.`,
          `Pay its prizes in a token without ${bad.powers.transferHook ? 'a transfer hook' : 'confidential transfers'}${boxRolls(b, m) || b.rollsOn ? '' : ', or sell the box in one step (one outcome, nothing random, no NFT rolled on: the purchase moves its prize with the hook’s accounts)'}.`,
        );
      }
    // A roll is given only by a box that sells in one step (`buy`): one oracle answer can't serve a second draw. In a
    // box that rolls it is refused; in an order (an open, a prize's or a recipe's roll of the box) it is out of stock.
    const givesRoll = outs.some(o => outcomeParts(o).some(x => x.gives === 'roll'));
    if (givesRoll && boxRolls(b, m))
      refuse(
        'E-ODDS',
        `${where}.outcomes`,
        `${label(b)} rolls (more than one outcome, or an NFT of a stash at random), and gives a roll of a box: a box that rolls can’t give one (BadEntries).`,
        'Give the roll from a box of one outcome that sells in one step, or give the box’s prizes directly.',
      );
    else if (givesRoll && rolledAtAll)
      warn(
        'W-OUT-OF-STOCK',
        `${where}.outcomes`,
        `${label(b)} gives a roll of a box, which only its sale in one step gives: ${b.rollsOn ? 'it rolls on an NFT, so it is opened' : `${[...new Set(rolls.filter(r => r.box === b.key).map(roller))].join(', ')} roll${rolls.filter(r => r.box === b.key).length === 1 ? 's' : ''} it`}, and in an order the roll is out of stock: that order gives nothing${outs.length === 1 && outcomeParts(outs[0]).length === 1 ? ' (with nothing else in it, the roll is refused, SoldOut)' : ''}.`,
        'Give the roll from a box nothing rolls, or give the box’s prizes directly.',
      );
    const tok = token(b.currency, `${where}.currency`);
    const price = units(b.price, tok, `${where}.price`, `${label(b)}’s price`);
    prices(b, tok, where);
    perWalletWindow(b, where);
    opensAndCloses(b, where);
    split(b.split, tok, `${where}.split`, { what: label(b), chosen: true });
    feeNote(price, tok, `${where}.price`, `opening of ${label(b)}`);
    rule(b.gate, `${where}.gate`, label(b));
    const outcomes = b.outcomes ?? [];
    // A roll on an NFT (`rollsOn`): what its outcomes do to it (order.rs, settle.rs).
    // Earned rolls: a mission's or a recipe's, of this box or of a box that rolls it.
    const rolledBy = [
      ...new Set(rolls.filter(r => r.box === b.key && ['mission', 'recipe'].includes(r.route)).map(roller)),
    ];
    if (b.rollsOn) rule(b.rollsOn, `${where}.rollsOn`, `${label(b)}’s NFT`);
    for (const [i, o] of outcomes.entries()) {
      const at = `${where}.outcomes[${i}]`;
      if ((o.shifts?.length || (o.then && o.then !== 'back')) && !b.rollsOn)
        refuse(
          'E-ROLL',
          at,
          `An outcome of ${label(b)} acts on an NFT, but the box rolls on none.`,
          'Add "rollsOn": the rule the NFT it rolls on must pass.',
        );
      for (const [j, x] of (o.shifts ?? []).entries()) {
        if (RESERVED_ATTRIBUTES.includes(x.attribute))
          refuse(
            'E-ROLL',
            `${at}.shifts[${j}]`,
            `${label(b)} moves “${x.attribute}”, a number of the program’s own.`,
            'Use a name of the game’s own, such as "level".',
          );
        timed(x, `${at}.shifts[${j}]`, `${label(b)} moves “${x.attribute}”`, 'E-ROLL');
        fourByteSeconds(x.by, `${at}.shifts[${j}].by`, { signed: true });
        fourByteSeconds(x.upTo, `${at}.shifts[${j}].upTo`);
      }
      thenCheck(o.then, `${at}.then`, label(b));
    }
    if (b.then !== undefined && !b.rollsOn)
      refuse(
        'E-ROLL',
        `${where}.then`,
        `${label(b)} says where the NFT it rolls on goes, but it rolls on none.`,
        'Add "rollsOn": the rule the NFT it takes must pass.',
      );
    thenCheck(b.then, `${where}.then`, label(b));
    const thenOfOutcome = o => o.then ?? b.then;
    const custodial = outcomes.some(o => thenOfOutcome(o) && thenOfOutcome(o) !== 'back');
    // A known limit of the program: a settle hands every account of the instruction to each NFT's move, and the 32 KiB
    // heap a transaction has by default keeps every copy. A payee the project didn't pick (a holder's share, a buyer's
    // chosen wallet, or a wallet's) can turn on required memos for their own Token-2022 account at any time, which adds
    // the memo program and a memo call to every settle, so each is counted as needing one. Measured on devnet's
    // features: with a hooked coin, three NFTs of stashes and the NFT rolled on
    // moved (four moves) and three or four such payees don't fit; four moves and two payees, or three moves and four
    // payees, fit (about 31.5 KiB and 30.8 KiB); without a hook every shape fits. With a 256 KiB heap frame, which loot's
    // senders ask for (`settleHeapFrame`), every one of them lands.
    const moves = Math.max(
      0,
      ...outcomes.map(
        o =>
          outcomeParts(o).filter(x => x.gives === 'stash' || x.gives === 'nft').length +
          (thenOfOutcome(o) && !['back', 'burn'].includes(thenOfOutcome(o)) ? 1 : 0),
      ),
    );
    const payees = sharesOf(b.split).filter(x => ['holder', 'chosen', 'wallet'].includes(x.kind)).length;
    // How xsolana's senders send a settle (js/play, the keeper's sweep).
    const sends =
      'xsolana’s senders (js/play, the keeper’s sweep) ask for a 256 KiB heap frame, and send a settle too big for a legacy transaction as a v0 one with a lookup table (W-SETTLE-V0): it lands';
    if (tok?.powers?.transferHook && moves >= 4 && payees >= 3)
      warn(
        'W-BOX-HEAP',
        `${where}.outcomes`,
        `${label(b)}’s settle moves ${moves} NFTs (three of stashes and the one it rolls on) and pays ${payees} holders’ or wallets’ shares in a coin with a transfer hook: it doesn’t fit the 32 KiB heap a transaction has by default once any of those payees turns on required memos for their own account, which they can do at any time: each NFT moved gets its own copy of the settle's accounts, and the copies outgrow the heap. ${sends}. One sent without the frame (another app’s) fails, and as a rolled order is never refunded, its player then settles by putting one won NFT back in its stash, where it waits for the owner.`,
        'Give at most two NFTs of stashes an outcome, at most two holders’ or wallets’ shares, or a coin with no transfer hook.',
      );
    // Every box that settles (one that rolls, rolls on an NFT, or that a grant, a place, a contest, an auction, a mission
    // or a recipe rolls): its settle as xsolana's senders build it (`settleSize`). Refused only where it can't land at all:
    // more accounts than a transaction locks even with none of a compressed NFT's proof, or more compute than a
    // transaction may have. A settle that may go past 64 accounts (a compressed NFT's proof can be 17 accounts, a payee
    // may turn on memos) is warned of, and one bigger than a legacy transaction goes as v0 with a lookup table its
    // sender makes. Two shapes outgrow the 32 KiB heap on a compressed subject (three Core NFTs of stashes; two and four
    // holders' or wallets' shares): with the 256 KiB heap frame xsolana's senders ask for they land (48 and 58 accounts).
    if (!boxBuys(b, m) || rolls.some(r => r.box === b.key)) {
      const sizes = (outcomes.length ? outcomes : [{}]).map((o, i) => ({
        i,
        ...settleAccounts(b, o, m),
        least: settleAccounts(b, o, m, { proof: 0 }).count,
        units: settleComputeUnits(b, o, m),
        ...settleSize(b, o, m),
      }));
      const at = x => `${where}.outcomes${outcomes.length ? `[${x.i}]` : ''}`;
      // As v0 (any settle past a legacy transaction), the transaction locks its lookup table and the table's program
      // too: it deactivates the table (TABLE_LOCKS more).
      const asSent = (n, x) => n + (x.legacy > MAX_TRANSACTION_BYTES || n > LEGACY_MOST_ACCOUNTS ? TABLE_LOCKS : 0);
      const certain = sizes.find(x => asSent(x.least, x) > ACCOUNT_LOCKS);
      const heavy = sizes.find(x => x.units > MAX_COMPUTE_UNITS);
      const worst = sizes.reduce(
        (a, x) => (asSent(x.count + (x.memo ? 1 : 0), x) > asSent(a.count + (a.memo ? 1 : 0), a) ? x : a),
        sizes[0],
      );
      const plain = worst.count + (worst.memo ? 1 : 0);
      const total = asSent(plain, worst);
      if (certain)
        refuse(
          'E-TX-SIZE',
          at(certain),
          `${label(b)}’s settle of its outcome ${certain.i} takes ${certain.least} accounts at the least, and as a v0 transaction its lookup table and the table’s program two more: ${asSent(certain.least, certain)}, more than the ${ACCOUNT_LOCKS} a transaction can lock, so nobody could settle it, and a rolled order is never refunded.`,
          'Give the outcome fewer prizes or fewer holders’ or wallets’ shares.',
        );
      else if (heavy)
        refuse(
          'E-TX-SIZE',
          at(heavy),
          `${label(b)}’s settle of its outcome ${heavy.i} would take about ${heavy.units.toLocaleString('en-US')} compute units, more than the ${MAX_COMPUTE_UNITS.toLocaleString('en-US')} a transaction can have, so nobody could settle it, and a rolled order is never refunded.`,
          'Give the outcome fewer NFTs (a pNFT’s move takes the most) or fewer holders’ or wallets’ shares.',
        );
      else if (total > ACCOUNT_LOCKS) {
        const tipped = worst.count + TABLE_LOCKS <= ACCOUNT_LOCKS && worst.memo;
        const back = outcomeParts(outcomes[worst.i] ?? {}).some(x => x.gives === 'stash' || x.gives === 'nft');
        warn(
          'W-BOX-ACCOUNTS',
          at(worst),
          `${label(b)}’s settle of its outcome ${worst.i} takes ${worst.count} accounts${worst.compressedSubject || worst.least < worst.count ? ` with a compressed NFT’s proof (it can be ${LONGEST_PROOF} accounts)` : ''}${worst.memo ? `, and the memo program is one more once any of its ${worst.payees} payee${worst.payees === 1 ? '' : 's'} the project didn’t pick (a holder’s share, a buyer’s chosen wallet, a wallet’s) turns on required memos for their own account, which they can do at any time` : ''}; sent as a v0 transaction, its lookup table and the table’s program are two more: ${total}. A transaction locks at most ${ACCOUNT_LOCKS}, so nobody can settle it then${tipped ? ' (until a payee turns memos on, it lands)' : ''}, and a rolled order is never refunded. ${back ? 'Its player can still settle it by putting every NFT won back in its stash.' : 'What it won can’t be put back to make room: the order, the NFT and the price stay where they are.'}`,
          `Give the outcome fewer prizes or fewer holders’ or wallets’ shares${worst.compressedSubject ? ', roll on the game’s own collectibles, or check that the collection’s trees keep a deeper canopy (a shorter proof)' : ''}.`,
        );
      } else if (worst.compressedSubject && sizes.some(x => x.corePicks >= 3 || (x.picks >= 2 && x.payees >= 4)))
        warn(
          'W-BOX-HEAP',
          `${where}.rollsOn`,
          `${label(b)} rolls on an NFT of a collection that may be compressed, whose proof every NFT a settle moves is handed: with ${sizes.some(x => x.corePicks >= 3) ? 'three NFTs of stashes' : 'two NFTs of stashes and four holders’ or wallets’ shares'} it doesn’t fit the 32 KiB heap a transaction has by default. ${sends}. One sent without the frame (another app’s) fails, and as a rolled order is never refunded, its player then settles by putting every NFT won back in its stash.`,
          'Give an outcome fewer NFTs of stashes or fewer holders’ or wallets’ shares, or roll on the game’s own collectibles.',
        );
      const big = sizes.reduce((a, x) => (x.legacy > a.legacy ? x : a), sizes[0]);
      if (!certain && !heavy && total <= ACCOUNT_LOCKS && big.legacy > MAX_TRANSACTION_BYTES)
        warn(
          'W-SETTLE-V0',
          at(big),
          `${label(b)}’s settle of its outcome ${big.i} takes about ${big.legacy} bytes as a legacy transaction, more than the ${MAX_TRANSACTION_BYTES} one holds (${big.locks} accounts, ${big.locks + TABLE_LOCKS} as v0 with its table). xsolana’s senders send it as a v0 transaction that loads its accounts from an address lookup table: js/play from the project’s standing table, which going live makes (one approval; a table of the player’s own, about ${(Number(big.tableRent) / 1e9).toFixed(4)} SOL of rent back about two minutes later, only for accounts it lacks), the keeper’s sweep from its own payer. A sender of legacy transactions only (another app’s) can’t settle it, and a rolled order is never refunded.`,
          'To keep it a legacy transaction, give the outcome fewer prizes or fewer holders’ or wallets’ shares.',
        );
    }
    if (b.rollsOn && custodial)
      warn(
        'W-ROLL-CUSTODY',
        `${where}.rollsOn`,
        `${label(b)} can ${outcomes.some(o => thenOfOutcome(o) === 'burn') ? 'burn' : outcomes.some(o => thenOfOutcome(o)?.stash) ? 'keep' : 'give away'} the NFT it rolls on: the project holds the NFT from the moment it is bought until the roll is settled, so nobody can move it away from a bad roll. A player who brings their own NFT must agree to that.`,
      );
    // Every outcome sends the NFT away: the NFT is the box's price (a trade-in).
    if (b.rollsOn && outcomes.length && outcomes.every(o => thenOfOutcome(o) && thenOfOutcome(o) !== 'back'))
      warn(
        'W-NFT-PRICE',
        `${where}.rollsOn`,
        `${label(b)} takes the NFT it rolls on as its price: whatever it gives, the NFT ${outcomes.every(o => thenOfOutcome(o) === 'burn') ? 'is burned' : 'is not given back'}. It opens with an order and settles after (\`open_box\`, \`settle\`), even with one outcome.`,
      );
    // Free and for sale, anyone could open it again and again and empty what it gives: strangers take the owner's prizes.
    if (rolledBy.length && b.active !== false && price === 0n)
      refuse(
        'E-ROLL',
        `${where}.active`,
        `${label(b)} is rolled by ${rolledBy.join(', ')}, and is for sale for free: anyone could open it directly, as often as they like, and skip the mission or the recipe.`,
        'Set "active": false (a box only missions or recipes roll is never sold), or give it a price.',
      );
    else if (rolledBy.length && b.active !== false)
      warn(
        'W-ROLL',
        `${where}.active`,
        `${label(b)} is rolled by ${rolledBy.join(', ')}, and is also for sale: anyone may buy a roll of it instead of earning one.`,
        'Set "active": false if it should only be earned.',
      );
    // A prize's roll (a grant, a lottery's place, a contest's winners, an auction's lot) is made for a winner, on nothing.
    const prizedBy = rolls.filter(r => r.box === b.key && !['mission', 'recipe'].includes(r.route)).map(roller);
    if (prizedBy.length && b.active !== false && !b.shopOf)
      warn(
        'W-ROLL-PRIZE',
        `${where}.active`,
        `${label(b)} is a prize of ${[...new Set(prizedBy)].join(', ')}, and is for sale too: anyone can open it for its price${price === 0n ? ' (free)' : ''}, and each opening takes from what the prize gives (a stash’s NFTs, a pool’s prizes).`,
        'Set "active": false for a box only prizes roll.',
      );
    if (prizedBy.length && b.rollsOn)
      warn(
        'W-ROLL-PRIZE',
        `${where}.rollsOn`,
        `${label(b)} rolls on an NFT, but ${[...new Set(prizedBy)].join(', ')} give${prizedBy.length === 1 ? 's' : ''} a roll of it on nothing: its outcomes are given, and their shifts and where they send an NFT are not.`,
        'Give prizes a box with no "rollsOn".',
      );
    // Free spins are the project's to limit: warned, never refused.
    if (price === 0n && !rolledBy.length && b.active !== false && !limitsPlayers(b))
      warn(
        'W-FREE',
        `${where}.price`,
        `${label(b)} is free with no limit per wallet: anyone, a bot included, can open it again and again for only the fees${outcomes.flatMap(outcomeParts).some(o => o.gives === 'pay') ? ', and drain the pools its prizes come from' : ''}.`,
        'Set "perWallet" or "perWalletEach" (say one a day), give it a price or a gate, or hand out openings through a grant with limits.',
      );
    const withChance = outcomes.filter(o => o.chance !== undefined).length;
    const withWeight = outcomes.filter(o => o.weight !== undefined).length;
    if (withChance && withWeight)
      refuse(
        'E-ODDS',
        `${where}.outcomes`,
        `${label(b)} mixes chances and weights, so its odds cannot be read.`,
        'Give every outcome a chance (percents adding up to 100), or every one a weight.',
      );
    else if (withChance + withWeight < outcomes.length)
      refuse(
        'E-ODDS',
        `${where}.outcomes`,
        `Some outcomes of ${label(b)} have no chance.`,
        'Give every outcome a chance (percents adding up to 100) or a weight.',
      );
    else if (withChance) {
      const total = outcomes.reduce((n, o) => n + o.chance, 0);
      if (Math.abs(total - 100) > 1e-9)
        refuse(
          'E-ODDS',
          `${where}.outcomes`,
          `${label(b)}’s chances add up to ${+total.toFixed(6)}%, not 100%.`,
          'Make them add up to 100.',
        );
      if (outcomes.some(o => Math.abs(o.chance * 10_000 - Math.round(o.chance * 10_000)) > 1e-6))
        refuse(
          'E-ODDS',
          `${where}.outcomes`,
          `A chance in ${label(b)} has more than four decimals.`,
          'Round it to four decimals, or use weights.',
        );
    }
    const parts = outcomes.flatMap(outcomeParts);
    // A paid box with more than one outcome that hands out collectibles a player can resell: a loot box.
    if (
      price > 0n &&
      outcomes.length > 1 &&
      parts.some(
        o =>
          (o.gives === 'item' && !m.item.get(o.item)?.soulbound && m.item.get(o.item)?.kind !== 'normal') ||
          o.gives === 'nft',
      )
    )
      c.randomItems = true;
    // A stash's NFTs are picked at random and can be resold: a paid box of one is a loot box.
    if (price > 0n && b.active !== false && parts.some(o => o.gives === 'stash')) c.randomItems = true;
    const prizes = [];
    for (const [i, outcome] of outcomes.entries()) {
      const at = `${where}.outcomes[${i}]`;
      if (outcome.gives === 'bundle' && !(outcome.prizes ?? []).length)
        refuse(
          'E-ODDS',
          `${at}.prizes`,
          `A bundle of ${label(b)} gives nothing.`,
          'List up to three prizes in "prizes".',
        );
      for (const [k, o] of outcomeParts(outcome).entries()) {
        const at = outcome.gives === 'bundle' ? `${where}.outcomes[${i}].prizes[${k}]` : `${where}.outcomes[${i}]`;
        // A prize line's own kinds: tokens minted, a named NFT, a roll of a box (prize.rs).
        if (o.gives === 'mint' || o.gives === 'nft' || o.gives === 'roll')
          prizeCheck(
            o.gives === 'mint' ? { gives: 'tokens', from: 'mint', currency: o.currency, amount: o.amount } : o,
            at,
            `An outcome of ${label(b)}`,
            'E-ODDS',
          );
        if (o.gives === 'item') {
          if (!o.item)
            refuse('E-ODDS', at, `An outcome of ${label(b)} gives an item but does not say which.`, 'Add "item".');
          else item(o.item, `${at}.item`);
        }
        if (o.gives === 'pay') {
          c.chance = true;
          const p = o.pool
            ? pool(o.pool, `${at}.pool`)
            : refuse('E-ODDS', at, `An outcome of ${label(b)} pays from a pool but does not say which.`, 'Add "pool".');
          if (p) {
            const amount = units(o.amount, m.tokens.get(p.currency), `${at}.amount`, `${label(b)}’s prize`);
            // A prize of 0 tokens is given with nothing moved.
            if (amount === 0n)
              warn(
                'W-ZERO',
                `${at}.amount`,
                `An outcome of ${label(b)} pays 0: it is drawn and given, and its winner gets nothing.`,
                'Give it an amount above 0, or make it "nothing".',
              );
            // In base units, exact (null when it is not an amount, refused above).
            prizes.push({ pool: p, amount });
          }
        }
        if (o.gives === 'stash') {
          if (!o.stash)
            refuse(
              'E-ODDS',
              at,
              `An outcome of ${label(b)} gives a stash’s NFT but does not say which stash.`,
              'Add "stash".',
            );
          else if (!m.stash.get(o.stash))
            refuse(
              'E-REF',
              `${at}.stash`,
              `There is no stash “${o.stash}”.`,
              'Add it to "stashes", or name one that is there.',
            );
        }
      }
    }
    // The oracle's answer to a roll carries the order, the box, its ticket, an account for each outcome that wins
    // something, and with prizes the token programs, the game and a mint and a vault for each pool (catalog.rs).
    if (boxRolls(b, m)) {
      const named = parts.filter(o => ['item', 'pay', 'stash', 'nft'].includes(o.gives)).length;
      const sources = new Set(
        parts
          .filter(o => ['pay', 'mint'].includes(o.gives))
          .map(o => (o.gives === 'mint' ? `mint:${o.currency ?? m.currencyKey}` : o.pool)),
      ).size;
      const callback = 3 + named + (sources ? 3 + 2 * sources : 0);
      if (callback > LIMITS.callbackAccounts)
        refuse(
          'E-ODDS',
          `${where}.outcomes`,
          `${label(b)}’s roll would hand the oracle ${callback} accounts; its answer carries at most ${LIMITS.callbackAccounts} (TooManyAccounts).`,
          'Pay prizes from fewer pools, or have fewer outcomes.',
        );
    }
    // The player's purchase must be sendable, with the compute budget their wallet adds: js/play sends one
    // too big for a legacy transaction as v0 with a lookup table, which locks the table and its program too.
    if (b.active !== false && !refusals.some(x => x.where.startsWith(where))) {
      // A fixed pack too big to buy in one legacy transaction is opened instead (js/play): the oracle answers it.
      const bought = boxBuys(b, m) ? buySize(b, m, { detail: true }) : null;
      const buys =
        Boolean(bought) &&
        (drawsOf(b) === 1 || (bought.bytes <= MAX_TRANSACTION_BYTES && bought.locks <= ACCOUNT_LOCKS));
      const { bytes, locks } = buys ? bought : openBoxSize(b, m, { detail: true });
      const verb = buys ? 'buy' : 'open';
      if (bytes > MAX_TRANSACTION_BYTES && locks + TABLE_LOCKS > ACCOUNT_LOCKS)
        refuse(
          'E-TX-SIZE',
          where,
          `${buys ? 'Buying' : 'Opening'} ${label(b)} would take about ${bytes} bytes and ${locks} accounts, ${locks + TABLE_LOCKS} as a v0 transaction with a lookup table: more than the ${ACCOUNT_LOCKS} a transaction can lock, so no player could ${verb} it.`,
          'Give it fewer outcomes that name an item or a pool, pay its prizes (and those of a box it rolls) from fewer pools, or drop its per-wallet limit.',
        );
      else if (bytes > MAX_TRANSACTION_BYTES)
        warn(
          'W-TX-V0',
          where,
          `${buys ? 'Buying' : 'Opening'} ${label(b)} takes about ${bytes} bytes with the compute budget a wallet adds, more than the ${MAX_TRANSACTION_BYTES} a legacy transaction holds: js/play sends it as a v0 transaction that loads its accounts from the project’s standing lookup table, which going live makes (one approval; going live is refused without it, E-NO-TABLE). A wallet or app that sends only legacy transactions can’t ${verb} it.`,
          'To keep it a legacy transaction, give it fewer outcomes that name an item or a pool, or pay its prizes from fewer pools.',
        );
    }
    for (const [i, o] of (b.odds ?? []).entries()) {
      const at = `${where}.odds[${i}]`;
      if (o.outcome >= outcomes.length)
        refuse(
          'E-ODDS',
          `${at}.outcome`,
          `${label(b)}’s odds raise outcome ${o.outcome}, but it has ${outcomes.length} (the first is 0).`,
          'Point it at one of its outcomes.',
        );
      rule(o.when, `${at}.when`, `${label(b)}’s odds`);
      effect(o.add, `${at}.add`, `${label(b)}’s odds`);
    }
    if ((b.odds ?? []).length && outcomes.length < 2)
      warn('W-ODDS', `${where}.odds`, `${label(b)} has one outcome, so odds change nothing.`);
    // A fixed prize is in stock only while its pool holds all of it (order.rs): a prize won leaves the pool for the
    // game's vault at the roll.
    for (const z of prizes) {
      if (z.amount === null) continue;
      const need = seedNeeds.get(z.pool.key) ?? { pool: z.pool, amount: 0n, box: b, boxes: new Set() };
      need.boxes.add(b);
      if (z.amount > need.amount) Object.assign(need, { amount: z.amount, box: b });
      seedNeeds.set(z.pool.key, need);
    }
    if (b.stockOdds && !parts.some(o => o.gives === 'item' && m.item.get(o.item)?.supply > 0))
      warn(
        'W-ODDS',
        `${where}.stockOdds`,
        `${label(b)} has odds that shrink with stock, but none of its items has a limited supply, so nothing changes.`,
        'Give its items a supply, or turn stockOdds off.',
      );
    // What it does once an outcome runs out (order.rs `WhenOut`): only an open of a box that rolls reads it.
    if (b.whenOut !== undefined && boxBuys(b, m) && drawsOf(b) === 1)
      warn(
        'W-WHEN-OUT',
        `${where}.whenOut`,
        `${label(b)} sells in one step, all of it or nothing, so "whenOut" changes nothing.`,
        'Leave "whenOut" out.',
      );
    // What a draw on an outcome that is out does, by the setting the project chose, and who can make it happen by
    // emptying a source this box shares with another route.
    const runsDry = o =>
      outcomeParts(o).some(
        x =>
          x.gives === 'pay' ||
          x.gives === 'stash' ||
          x.gives === 'nft' ||
          (x.gives === 'item' && Number(m.item.get(x.item)?.supply ?? 0) > 0),
      );
    const rolledHere = !boxBuys(b, m) || rolls.some(r => r.box === b.key);
    if (b.whenOut === 'giveNothing' && rolledHere)
      warn(
        'W-WHEN-OUT',
        `${where}.whenOut`,
        `${label(b)} gives nothing for a draw on an outcome that is out ("whenOut": "giveNothing"): a paid draw is not refunded, a free roll is over, and the box keeps selling. Anyone who empties what an outcome gives (a pool, an item’s units, a stash), by this box or another route that takes from it, makes its rolls miss.`,
        'Tell players a draw can miss, keep each outcome in stock, or keep "stopSales" (a paid miss refunded) or "drawLeft" (a draw among what is left).',
      );
    const sharedSources = outs
      .flatMap(outcomeParts)
      .map(x =>
        x.gives === 'pay'
          ? ['pool', x.pool]
          : x.gives === 'stash' || x.gives === 'nft'
            ? ['stash', x.stash]
            : x.gives === 'item'
              ? ['item', x.item]
              : null,
      )
      .filter(Boolean)
      .filter(([kind, key]) =>
        kind === 'pool'
          ? takers.some(t => t.pool === key && t.by !== `box:${b.key}`)
          : kind === 'stash'
            ? routePrizes.some(p => p.prize.stash === key) ||
              m.allBoxes.some(x => x !== b && (x.outcomes ?? []).flatMap(outcomeParts).some(y => y.stash === key))
            : Number(m.item.get(key)?.supply ?? 0) > 0 &&
              (Number(m.item.get(key)?.price ?? 0) > 0 ||
                routePrizes.some(p => p.prize.item === key) ||
                m.allBoxes.some(x => x !== b && (x.outcomes ?? []).flatMap(outcomeParts).some(y => y.item === key))),
      );
    if (sharedSources.length && rolledHere && outs.some(runsDry) && b.active !== false)
      warn(
        'W-SHARED-SOURCE',
        `${where}.outcomes`,
        `${label(b)} draws from ${[...new Set(sharedSources.map(([kind, key]) => `the ${kind} “${key}”`))].join(', ')}, which another route also takes from. ${stopsSales(b) ? 'Stopping sales while an outcome is out ("stopSales") counts only this box’s own rolls: a roll already paid whose outcome another route empties before its answer lands is refunded in full. So a buyer can open the box and, in the same transaction, empty a common outcome’s source by the other route: every roll that lands on that outcome is refunded, and they pay only for the rolls that land on another one, such as the rare one' : b.whenOut === 'giveNothing' ? 'Anyone emptying that source makes this box’s rolls miss, and a miss gives nothing' : 'Anyone emptying that source moves this box’s odds to what is left'}.`,
        'Give the box sources of its own (an item, pool or stash nothing else sells or gives); cap a fresh item’s supply at what its table holds. "giveNothing" ends the refund but makes a miss give nothing; "drawLeft" draws among what is left.',
      );
    if (b.whenOut === 'drawLeft' && boxRolls(b, m)) {
      // The rarest outcome that gives something, against the likeliest outcome that can run out.
      const w = weights(b);
      const total = w.reduce((a, x) => a + x, 0) || 1;
      const runsOut = o =>
        outcomeParts(o).some(
          x =>
            x.gives === 'pay' ||
            x.gives === 'stash' ||
            x.gives === 'nft' ||
            (x.gives === 'item' && Number(m.item.get(x.item)?.supply ?? 0) > 0),
        );
      const giving = outcomes.map((o, i) => i).filter(i => outcomeParts(outcomes[i]).length);
      const rare = giving.reduce((r, i) => (r === -1 || w[i] < w[r] ? i : r), -1);
      const common = outcomes
        .map((o, i) => i)
        .filter(i => i !== rare && runsOut(outcomes[i]) && w[i] > w[rare])
        .reduce((c, i) => (c === -1 || w[i] > w[c] ? i : c), -1);
      if (rare >= 0 && common >= 0) {
        const pct = x => Math.round(x * 10_000) / 100;
        warn(
          'W-WHEN-OUT',
          `${where}.whenOut`,
          `${label(b)} draws among what is left once an outcome runs out ("whenOut": "drawLeft"): once outcome ${common} runs out, outcome ${rare}’s chance goes from ${pct(w[rare] / total)}% to ${pct(w[rare] / (total - w[common]))}%. Anyone who reads the stock can buy until outcome ${common} is gone and then open for outcome ${rare} at better odds.`,
          'Keep "stopSales" (the default) when a rare outcome matters: the box stops selling instead, and every roll stays on the odds written.',
        );
      }
    }
  }
  // A fixed prize a pool can't cover is out of stock (order.rs): a draw that lands on it is not made and gives back its
  // worth, a box with nothing else in stock is refused (SoldOut), and a sale in one step is refused (PrizeNotCovered).
  for (const { pool: p, amount: most, box, boxes } of seedNeeds.values()) {
    const tok = m.tokens.get(p.currency);
    const sym = tok?.symbol ?? p.currency;
    // Both in base units, exact: a seed that is not an amount is refused with its pool.
    const seed = quietUnits(p.seed, tok);
    if (seed === null || seed >= most) continue;
    const amount = fromUnits(most, tok?.decimals ?? 0);
    const others = [...boxes].filter(x => x !== box).map(label);
    // A box that stops selling when an outcome is out (the default) needs the prize for this purchase's draws and every
    // draw still waiting for the oracle before it sells at all.
    const stopped = [...boxes].filter(x => x.active !== false && stopsSales(x) && boxRolls(x, m));
    const stops = stopped.length
      ? ` ${stopped.map(label).join(', ')} stop${stopped.length === 1 ? 's' : ''} selling while an outcome is out ("whenOut": "stopSales"): ${stopped.length === 1 ? 'it isn’t' : 'they aren’t'} sold at all while the pool holds less than the prize for that purchase’s draws and every draw still waiting for the oracle.`
      : '';
    warn(
      'W-PRIZE-SEED',
      `economy.pools.${p.key}.seed`,
      `“${p.key}” starts with ${fromUnits(seed, tok?.decimals ?? 0)} ${sym}, but a win in ${label(box)} pays ${amount} ${sym}. A fixed prize its pool can’t cover is out of stock: the odds stay as written, so a roll that lands on it before the pool holds ${amount} ${sym} makes no draw and gives back that draw’s worth, no other outcome taking its place (a box with nothing else in stock is refused, SoldOut), and so again whenever a run of wins takes the pool below that${others.length ? ` (${others.join(', ')} pay${others.length === 1 ? 's' : ''} fixed prizes from it too, each out of stock the same way below its own amount)` : ''}.${stops}`,
      `Seed “${p.key}” with at least ${amount} ${sym} for each purchase that may wait for its roll at once; more rides out a run of wins (the simulation suggests how much). For a prize that grows with sales, use a lottery’s pot instead.`,
    );
  }

  // ---- a live box's roll rewritten: an edit of the entries, odds, stock odds, `whenOut`, the NFT it rolls on or the fates fails an
  // order that holds a payment, which is refunded; any other roll waiting (a prize, a mission's chest, a recipe's) rolls on
  // the box as edited, so an edit never loses what was spent.
  const published = new Map((economy.live?.published?.boxes ?? []).map(b => [b.key, b]));
  const rollOf = b =>
    JSON.stringify([
      b.outcomes ?? [],
      b.odds ?? [],
      Boolean(b.stockOdds),
      b.whenOut ?? 'stopSales',
      b.rollsOn ?? null,
      b.then ?? null,
    ]);
  for (const b of economy.boxes ?? []) {
    const was = published.get(b.key);
    if (!was || rollOf(was) === rollOf(b)) continue;
    const routes = [...new Set(rolls.filter(x => x.box === b.key).map(roller))];
    warn(
      'W-LIVE-ROLLS',
      `economy.boxes.${b.key}`,
      `${label(m.box.get(b.key) ?? b)} is live, and this changes its roll (its outcomes, odds, stock odds, what it does when an outcome runs out, the NFT it rolls on or what becomes of it). A purchase still waiting for its roll fails when the change lands, and gets its payment back${routes.length ? `; a roll won on another route (${routes.join(', ')}) holds no payment and rolls on the box as it is then` : '; a roll won on another route holds no payment and rolls on the box as it is then'}.`,
      'Publish the change only once no roll of it waits (each settled or refunded), or open a new box with the new roll and point the routes at it.',
    );
  }
}

/**
 * Two prizes of one box outcome that want the same thing from one source (prize.rs `wants_same`): the words for them,
 * or null. An outcome gives all it names or isn't given, so it names a pool once with the whole amount, a stash's
 * random NFT beside nothing else of that stash, and a named NFT once. An item may repeat: two of it is how it gives two.
 */
function samePrizes(x, y) {
  if (x.gives === 'pay' && y.gives === 'pay' && x.pool === y.pool) return `pays from the pool “${x.pool}” twice`;
  if (x.gives === 'stash' && y.gives === 'stash' && x.stash === y.stash)
    return `gives two random NFTs of the stash “${x.stash}”`;
  if (
    (x.gives === 'stash' && y.gives === 'nft' && x.stash === y.stash) ||
    (x.gives === 'nft' && y.gives === 'stash' && x.stash === y.stash)
  )
    return `gives a random NFT of the stash “${x.stash}” beside a named one of it`;
  if (x.gives === 'nft' && y.gives === 'nft' && x.stash === y.stash && x.nft === y.nft)
    return `names the NFT ${x.nft} twice`;
  return null;
}
