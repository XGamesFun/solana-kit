// The checks of payments and recipes (craft.rs), and of a set's way out: a recipe that lets staked pieces leave
// their farm.
import { MAX_TRANSACTION_BYTES } from '../../chain/tx.js';
import {
  LIMITS,
  ANSWER_HOLDS,
  RESERVED_ATTRIBUTES,
  isAddress,
  lifeLines,
  prizeLine,
  prizePool,
  prizeToken,
  toBy,
} from '../model.mjs';
// plan.mjs imports check() in turn: each module only calls the other's functions, never at load time.
import { recipeArgs } from '../plan.mjs';
import { label } from '../format.mjs';
import { BUDGET } from '../txsize.mjs';
import { ACCOUNT_LOCKS, craftSize, TABLE_LOCKS } from '../sizes.mjs';

/** Checks the payments and the recipes. */
export function checkRecipes(c) {
  const {
    refusals,
    refuse,
    warn,
    m,
    units,
    fourByteSeconds,
    token,
    item,
    prizeBox,
    prizeCheck,
    timed,
    thenCheck,
    split,
    feeNote,
    perWalletWindow,
  } = c;
  // ---- payments
  for (const p of m.payments) {
    const where = `economy.payments.${p.key}`;
    const tok = token(p.currency, `${where}.currency`);
    const amount = units(p.amount, tok, `${where}.amount`, `${label(p)}’s amount`);
    if (amount === 0n)
      refuse('E-PRICE', `${where}.amount`, `${label(p)} is a payment of 0 (ZeroAmount).`, 'Give it an amount above 0.');
    // A payment's split is the payer's own (`pay` takes it from them each time), so they may name one wallet in it too.
    split(p.split, tok, `${where}.split`, { what: label(p), chosen: 'wallet' });
    feeNote(amount, tok, `${where}.amount`, `payment of ${label(p)}`);
  }

  // ---- recipes (craft.rs)
  for (const r of m.recipes) {
    const where = `economy.recipes.${r.key}`;
    const ins = r.in ?? [];
    // Each kind of line has its cap, a collectible's life adding its own needs and raises.
    const lines = (() => {
      try {
        return recipeArgs(r, m);
      } catch {
        return {
          inputs: ins,
          outputs: r.out ?? [],
          needs: r.needs ?? [],
          keeps: r.keeps ?? [],
          raises: r.raises ?? [],
        };
      }
    })();
    // A recipe takes any number of lines; what one craft can carry is measured: past it, the recipe is written
    // and never crafts.
    {
      const pays = ins.filter(l => l.takes === 'pay');
      const coins = new Set(pays.map(l => l.currency ?? m.currencyKey)).size;
      const pooled = (r.out ?? []).filter(l => l.gives === 'tokens' && prizePool(l)).length;
      const raised = lines.raises.length + lines.needs.length;
      const past = [
        coins > 1 &&
          pays.length > ANSWER_HOLDS.recipeCoins &&
          `${pays.length} payments in ${coins} coins (at most ${ANSWER_HOLDS.recipeCoins})`,
        coins <= 1 &&
          pays.length > ANSWER_HOLDS.recipePayments &&
          `${pays.length} payments (at most ${ANSWER_HOLDS.recipePayments} in one coin)`,
        pooled > ANSWER_HOLDS.recipePoolOutputs &&
          `${pooled} outputs from a pool (at most ${ANSWER_HOLDS.recipePoolOutputs})`,
        raised > ANSWER_HOLDS.recipeRaises && `${raised} raises and needs (at most ${ANSWER_HOLDS.recipeRaises})`,
      ].filter(Boolean);
      if (past.length)
        warn(
          'W-ANSWER',
          where,
          `${label(r)} has ${past.join(', ')}: the program writes it, but one craft can’t carry that much, so it never crafts.`,
          'Split it into two recipes.',
        );
    }
    const outs = r.out ?? [];
    // "on" names the collectible a roll is made on: on any other output it changes nothing.
    for (const [i, line] of outs.entries())
      if (line.on !== undefined && prizeLine(line)?.gives !== 'roll')
        warn(
          'W-RECIPE',
          `${where}.out[${i}].on`,
          `${label(r)}’s output ${i + 1} says "on", which only a roll uses (the collectible it rolls on): here it changes nothing.`,
          'Leave "on" out, or make it a roll ({ "gives": "roll", "box": key, "on": place }).',
        );
    if (!ins.length && !outs.length)
      warn(
        'W-RECIPE',
        where,
        `${label(r)} takes nothing and gives nothing: crafting it only charges the player fee.`,
        'Add what it takes and what it gives.',
      );
    perWalletWindow(r, where);
    let taken = 0;
    const kept = [];
    for (const [i, line] of ins.entries()) {
      const at = `${where}.in[${i}]`;
      if (line.takes === 'pay') {
        const tok = token(line.currency, `${at}.currency`);
        const amount = units(line.amount, tok, `${at}.amount`, `What ${label(r)} takes`);
        if (amount === 0n)
          refuse('E-RECIPE', `${at}.amount`, `${label(r)} takes an amount of 0.`, 'Give it an amount above 0.');
        feeNote(amount, tok, `${at}.amount`, `craft of ${label(r)}`);
        if (!line.to)
          refuse(
            'E-RECIPE',
            `${at}.to`,
            `${label(r)} takes ${tok?.symbol ?? 'a token'} but does not say where it goes.`,
            'Add "to": "burn", "pool:<key>", "wallet:<address>", "account:<token account>" or "holder:<address>".',
          );
        else split([{ to: line.to, percent: 100 }], tok, `${at}`, { what: label(r) });
        continue;
      }
      if (line.takes === 'trade') {
        if (line.item)
          refuse(
            'E-RECIPE',
            `${at}.item`,
            `${label(r)} trades in an NFT of a collection, not an item.`,
            'Use "takes": "burn" for one of the project’s items, or name the "collection".',
          );
        if (line.collection && !isAddress(line.collection))
          refuse(
            'E-REF',
            `${at}.collection`,
            `${label(r)} trades in an NFT of “${line.collection}”, which is not an address.`,
            'Write the Core collection’s address, or the Token Metadata collection mint.',
          );
        if (!line.collection && !m.collection)
          refuse(
            'E-RECIPE',
            `${at}.collection`,
            `${label(r)} trades in an NFT of the project’s own collection, but the project makes none.`,
            'Name the "collection" it takes.',
          );
        if (line.then === 'treasury' || line.then?.giveTo)
          warn(
            'W-NFT-PRICE',
            `${at}.then`,
            `${label(r)} hands each NFT traded in to ${line.then === 'treasury' ? 'the treasury' : line.then.giveTo}, straight from the player.`,
          );
        thenCheck(line.then, `${at}.then`, label(r));
        kept.push(false);
        taken += 1;
        continue;
      }
      if (line.takes === 'show') {
        if (line.item)
          refuse(
            'E-RECIPE',
            `${at}.item`,
            `${label(r)} shows an NFT of a collection, not an item.`,
            'Use "takes": "use" for one of the game’s items, or name the "collection".',
          );
        kept.push(true);
        taken += 1;
        continue;
      }
      const it = line.item
        ? item(line.item, `${at}.item`)
        : refuse(
            'E-RECIPE',
            at,
            `A line of ${label(r)} hands something in but does not say which item.`,
            'Add "item".',
          );
      if (!it) continue;
      if (it.kind === 'normal')
        refuse(
          'E-RECIPE',
          `${at}.item`,
          `${label(r)} takes ${label(it)}, a normal item: only collectibles can be handed in.`,
          `Make ${label(it)} a collectible.`,
        );
      if (line.takes === 'staked') {
        // The line names its farm (craft.rs, `Input::Staked { item, farm }`): the craft takes the piece only from its seat
        // there, a farm of collectibles that holds or freezes it (a watched one could be sold while staked).
        const f = line.farm === undefined ? null : m.farm.get(line.farm);
        // The recipe's own raises on it, and its life's (uses, a cooldown: `lifeLines`).
        const raised = [
          ...(r.raises ?? []).filter(x => x.place === taken).map(x => x.key),
          ...lifeLines(r, m)
            .raises.filter(x => x.place === taken)
            .map(x => x.shift.key),
        ];
        const candidates = m.farms.filter(
          x => x.stakes === 'collectibles' && (x.custody ?? 'escrow') !== 'watch' && (!x.item || x.item === it.key),
        );
        if (line.farm === undefined)
          refuse(
            'E-RECIPE',
            `${at}.farm`,
            `${label(r)} takes ${label(it)} only while it is staked, but does not say in which farm: the program takes the piece only from its seat in the farm the line names.`,
            candidates.length
              ? `Add "farm": ${candidates.map(x => `"${x.key}"`).join(' or ')}.`
              : `Add a farm of collectibles that takes ${label(it)} with "custody": "escrow" or "freeze", and name it in "farm".`,
          );
        else if (!f)
          refuse(
            'E-RECIPE',
            `${at}.farm`,
            `${label(r)} takes ${label(it)} staked in “${line.farm}”, which is not a farm of this spec.`,
            candidates.length
              ? `Use ${candidates.map(x => `"${x.key}"`).join(' or ')}.`
              : 'Fix the name, or add the farm.',
          );
        else if (f.stakes !== 'collectibles')
          refuse(
            'E-RECIPE',
            `${at}.farm`,
            `${label(r)} takes ${label(it)} staked in ${label(f)}, a farm of tokens: a collectible is staked only in a farm of collectibles.`,
            candidates.length
              ? `Use ${candidates.map(x => `"${x.key}"`).join(' or ')}.`
              : `Add a farm of collectibles that takes ${label(it)}.`,
          );
        else if (f.item && f.item !== it.key)
          refuse(
            'E-RECIPE',
            `${at}.farm`,
            `${label(r)} takes ${label(it)} staked in ${label(f)}, which stakes only ${label(m.item.get(f.item) ?? { key: f.item })}: no ${label(it)} is ever staked there.`,
            candidates.length
              ? `Use ${candidates.map(x => `"${x.key}"`).join(' or ')}.`
              : `Let ${label(f)} take ${label(it)}.`,
          );
        else if ((f.custody ?? 'escrow') === 'watch')
          refuse(
            'E-RECIPE',
            `${at}.farm`,
            `${label(r)} takes ${label(it)} staked in ${label(f)}, which watches NFTs left free in their wallets: one could be sold while staked, so the craft takes a staked piece only from a farm that escrows or freezes it.`,
            `Give ${label(f)} "custody": "escrow" or "freeze", or name another farm.`,
          );
        // A raise on the piece must move the lock its farm reads (BadRecipe): a lock moved where the farm doesn't read it holds nothing.
        else if (raised.length && !raised.includes(f.lockAttribute))
          refuse(
            'E-RECIPE',
            `${at}.farm`,
            `${label(r)} raises ${raised.map(k => `“${k}”`).join(', ')} on ${label(it)} staked in ${label(f)}, but ${f.lockAttribute ? `that farm keeps its lock under “${f.lockAttribute}”` : 'that farm keeps no lock on the NFT ("lockAttribute")'}: a recipe that raises anything on a staked piece must move the lock its farm reads, or the program refuses the craft (BadRecipe).`,
            f.lockAttribute
              ? `Raise "${f.lockAttribute}" on collectible ${taken} too, or take it with "takes": "use" to raise a stat and leave its lock alone.`
              : `Give ${label(f)} "lockAttribute" and raise it here, or take it with "takes": "use" to raise a stat and leave its lock alone.`,
          );
        else if (!f.lockAttribute)
          warn(
            'W-STAKED',
            `${at}.farm`,
            `${label(r)} takes ${label(it)} only while it is staked in ${label(f)}, which keeps no lock on the NFT ("lockAttribute"): nothing the recipe does can keep it staked after.`,
            `Give ${label(f)} a "lockAttribute", and raise it in the recipe so the pieces stay staked after the craft.`,
          );
      }
      if (line.takes === 'burn' && it.soulbound)
        warn(
          'W-RECIPE',
          `${at}.item`,
          `${label(r)} burns ${label(it)}, which is soulbound and can never be burned, so nobody could ever craft it.`,
          'Use it and keep it ("takes": "use"), or make the item not soulbound.',
        );
      taken += line.takes === 'burn' ? (line.count ?? 1) : 1;
      kept.push(...Array(line.takes === 'burn' ? (line.count ?? 1) : 1).fill(line.takes !== 'burn'));
    }
    if (taken > LIMITS.collectiblesPerCraft)
      refuse(
        'E-RECIPE',
        `${where}.in`,
        `${label(r)} takes ${taken} collectibles; one craft takes at most ${LIMITS.collectiblesPerCraft}.`,
        'Take fewer, or split it into two recipes.',
      );
    let made = 0;
    // Each line is a prize (prize.rs), given in the craft; a roll on a collectible it keeps (`on`) is checked below.
    for (const [i, line] of outs.entries()) {
      if (line.gives === 'roll' && line.on !== undefined) continue;
      const given = prizeCheck(line, `${where}.out[${i}]`, label(r), 'E-RECIPE');
      // A keep writes onto a collectible the craft makes as a Core asset (prize.rs `makes`): a compressed one is not one.
      if (given?.gives === 'item' && !given.compressed) made += 1;
    }
    // A roll it makes (craft.rs, order.rs): at most one, on a collectible it keeps.
    const places = ins.flatMap(l =>
      l.takes === 'burn' ? Array(l.count ?? 1).fill('burn') : l.takes === 'pay' ? [] : [l.takes],
    );
    // Each roll is its own order, at the craft's nonce plus its count (craft.rs); its receipts must fit the log.
    const rolls = outs.filter(l => l.gives === 'roll');
    if (rolls.length > ANSWER_HOLDS.recipeRolls)
      warn(
        'W-ANSWER',
        `${where}.out`,
        `${label(r)} gives ${rolls.length} rolls: past ${ANSWER_HOLDS.recipeRolls}, a craft’s receipts run past what a transaction’s log holds (10,000 bytes), and its Crafted receipt is cut, so an indexer or a results page can’t read what it made.`,
        `Give at most ${ANSWER_HOLDS.recipeRolls} rolls a craft, or roll a box that gives a pack.`,
      );
    // Two rolls on one NFT whose box holds it while it rolls: the craft fails whole.
    const held = rolls.filter(
      l =>
        l.on !== undefined &&
        (m.box.get(l.box)?.outcomes ?? []).some(o => (o.shifts ?? []).length || (o.then && o.then !== 'back')),
    );
    const twice = held.find((l, i) => held.slice(0, i).some(x => x.on === l.on));
    if (twice)
      warn(
        'W-RECIPE',
        `${where}.out`,
        `${label(r)} gives two rolls on collectible ${twice.on}, and a box that holds the NFT while it rolls: the second can’t take the NFT the first holds, so every craft of it fails whole.`,
        'Give one roll on each collectible.',
      );
    for (const [i, line] of outs.entries()) {
      if (line.gives !== 'roll') continue;
      const at = `${where}.out[${i}]`;
      // A roll with no "on" was checked as a prize above, its box too. One on a collectible is checked only here: a
      // box the spec does not have is refused (the recipe would be written to roll an address with no box at it, and
      // the program refuses that after the transactions before it have landed).
      const b = line.on === undefined ? m.box.get(line.box) : prizeBox(line.box, `${at}.box`, label(r), 'E-RECIPE');
      if (!b) continue;
      if (line.on === undefined && b.rollsOn)
        refuse(
          'E-RECIPE',
          at,
          `${label(r)} rolls ${label(b)}, which rolls on an NFT, but does not say on which collectible.`,
          'Add "on": the place of a collectible the recipe keeps.',
        );
      if (line.on !== undefined && !b.rollsOn)
        refuse(
          'E-RECIPE',
          `${at}.on`,
          `${label(r)} rolls ${label(b)} on collectible ${line.on}, but the box rolls on none.`,
          'Give the box "rollsOn", or leave "on" out.',
        );
      if (line.on !== undefined && !kept[line.on])
        refuse(
          'E-RECIPE',
          `${at}.on`,
          `${label(r)} rolls on collectible ${line.on}, which it ${line.on < taken ? 'burns' : 'does not take'}.`,
          'Point it at a collectible the recipe uses, renews or shows.',
        );
      const custodial = (b.outcomes ?? []).some(o => o.then && o.then !== 'back');
      // A roll that moves numbers holds the NFT until it settles, as one that can burn or give it away takes it (craft.rs).
      const moves = (b.outcomes ?? []).some(o => (o.shifts ?? []).length);
      if ((custodial || moves) && places[line.on] === 'show')
        warn(
          'W-ROLL-CUSTODY',
          `${at}.on`,
          `${label(b)} ${custodial ? 'can burn or give away' : 'moves numbers on'} the NFT ${label(r)} shows: the craft hands it to the game until it settles, which only a Core NFT can be (a Token Metadata or compressed one is refused, NeedsCustody).`,
          'Roll on one of the game’s items ("use").',
        );
    }
    for (const [i, raise] of (r.raises ?? []).entries()) {
      timed(raise, `${where}.raises[${i}]`, `${label(r)} raises “${raise.key}”`, 'E-RECIPE');
      fourByteSeconds(raise.by, `${where}.raises[${i}].by`, { signed: true });
      fourByteSeconds(raise.upTo, `${where}.raises[${i}].upTo`);
      if (!kept[raise.place])
        refuse(
          'E-RECIPE',
          `${where}.raises[${i}]`,
          `${label(r)} raises “${raise.key}” on collectible ${raise.place}, which it ${raise.place < taken ? 'burns' : 'does not take'}: only one it keeps can be raised.`,
          'Point it at a collectible the recipe uses, renews or shows.',
        );
      if (RESERVED_ATTRIBUTES.includes(raise.key))
        refuse(
          'E-RECIPE',
          `${where}.raises[${i}].key`,
          `“${raise.key}” is a number the program writes itself.`,
          'Raise a key of the game’s own, such as "level" or "power".',
        );
    }
    for (const [i, need] of (r.needs ?? []).entries())
      if (need.place >= taken)
        refuse(
          'E-RECIPE',
          `${where}.needs[${i}]`,
          `${label(r)} asks something of collectible number ${need.place}, but it only takes ${taken} (the first is 0).`,
          'Point it at a collectible the recipe takes.',
        );
    for (const [i, keep] of (r.keeps ?? []).entries()) {
      if (keep.from >= taken || keep.to >= made)
        refuse(
          'E-RECIPE',
          `${where}.keeps[${i}]`,
          `${label(r)} carries “${keep.key}” from collectible ${keep.from} to new collectible ${keep.to}, but it takes ${taken} and makes ${made} (the first of each is 0).`,
          'Point it at collectibles the recipe takes and makes.',
        );
      if (RESERVED_ATTRIBUTES.includes(keep.key))
        refuse(
          'E-RECIPE',
          `${where}.keeps[${i}].key`,
          `“${keep.key}” is a number the program writes itself and cannot be carried over.`,
          'Carry a key the game wrote.',
        );
      if ((r.keeps ?? []).slice(0, i).some(k => k.key === keep.key && k.to === keep.to))
        refuse(
          'E-RECIPE',
          `${where}.keeps[${i}]`,
          `${label(r)} carries “${keep.key}” to the same collectible twice.`,
          'Keep one.',
        );
    }
    if (!refusals.some(x => x.where.startsWith(where))) {
      const { bytes, locks } = craftSize(r, m, { detail: true });
      if (bytes > MAX_TRANSACTION_BYTES && locks + TABLE_LOCKS > ACCOUNT_LOCKS)
        refuse(
          'E-TX-SIZE',
          where,
          `Crafting ${label(r)} would take about ${bytes} bytes and ${locks} accounts, ${locks + TABLE_LOCKS} as a v0 transaction with a lookup table: more than the ${ACCOUNT_LOCKS} a transaction can lock, so no player could craft it.`,
          'Take or give fewer collectibles, or split it into two recipes.',
        );
      else if (bytes > MAX_TRANSACTION_BYTES)
        warn(
          'W-TX-V0',
          where,
          `Crafting ${label(r)} takes about ${bytes} bytes, more than the ${MAX_TRANSACTION_BYTES} a legacy transaction holds: js/play sends it as a v0 transaction that loads its accounts from the project’s standing lookup table, which going live makes (one approval; going live is refused without it, E-NO-TABLE). A wallet or app that sends only legacy transactions can’t craft it.`,
          'To keep it a legacy transaction, take or give fewer collectibles, or split it into two recipes.',
        );
      else if (bytes > BUDGET)
        warn(
          'W-TX-SIZE',
          where,
          `Crafting ${label(r)} takes about ${bytes} of ${MAX_TRANSACTION_BYTES} bytes: it fits only if the player’s wallet adds nothing of its own.`,
          'Take or give fewer collectibles if players see it fail.',
        );
    }
    // The tokens a craft moves: each pay line's (its currency, else the game's), and each prize of tokens' (prizeToken).
    const moved = [
      ...ins.filter(l => l.takes === 'pay').map(l => m.tokens.get(l.currency ?? m.currencyKey)),
      ...outs.map(l => prizeToken(l, m)),
    ];
    const hooks = moved.filter(t => t?.powers?.transferHook);
    if (hooks.length)
      warn(
        'W-TX-SIZE',
        where,
        `${label(r)} moves ${hooks[0].symbol}, whose transfer hook adds accounts of its own to every craft; the checker cannot count them from here.`,
        'Try a craft on devnet before players do.',
      );
  }

  // ---- a set's way out: a recipe that lowers the lock of staked pieces lets them leave their farm. With a "pay"
  // line it waits while the project is paused or the platform suspends it, so when it is the only way out the pieces
  // stay locked for as long as that lasts: the one thing the platform's switch would hold that an unstake needs.
  const lockKeys = new Set(m.farms.map(f => f.lockAttribute).filter(Boolean));
  const unbinds = m.recipes
    .map(r => {
      const places = (r.in ?? []).flatMap(l =>
        l.takes === 'burn' ? Array(l.count ?? 1).fill('burn') : l.takes === 'pay' ? [] : [l.takes],
      );
      const keys = new Set(
        (r.raises ?? [])
          .filter(x => lockKeys.has(x.key) && places[x.place] === 'staked' && toBy(x.by) < 0)
          .map(x => x.key),
      );
      return { r, keys, pays: (r.in ?? []).some(l => l.takes === 'pay') };
    })
    .filter(u => u.keys.size);
  for (const u of unbinds.filter(x => x.pays)) {
    const only = [...u.keys].filter(k => !unbinds.some(o => !o.pays && o.keys.has(k)));
    if (only.length)
      warn(
        'W-UNBIND-PAY',
        `economy.recipes.${u.r.key}`,
        `${label(u.r)} lets staked pieces out (it lowers “${only[0]}”) and takes a payment, and no other recipe lets them out for free. A recipe with a "pay" line can't be crafted while the project is paused or the platform suspends it, so for as long as that lasts the pieces stay locked in their farm: their lock holds the unstake.`,
        'Take the "pay" line out of the way out (charge when binding instead), or add one that takes no payment.',
      );
  }
}
