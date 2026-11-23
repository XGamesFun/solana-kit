// The checks of the collection, the collections the project names, the tables of drawn traits and the items
// (catalog.rs), with what each route may give of them.
import { LIMITS, RESERVED_ATTRIBUTES, isAddress, outcomeParts, prizes, toBps, utf8Bytes } from '../model.mjs';
import { label } from '../format.mjs';
import { isCollectible } from '../sizes.mjs';

/** Checks the collection and the items. */
export function checkItems(c) {
  const { refuse, warn, m, units, fourByteSeconds, tooMany, game, rule, split, feeNote, perWalletWindow, prices } = c;
  // ---- the collections and items
  if (m.collection && toBps(m.collection.royaltyPercent) === null)
    refuse(
      'E-PERCENT',
      'economy.collection.royaltyPercent',
      'The royalty is finer than hundredths of a percent.',
      'Round it to two decimals.',
    );
  // A project takes the one collection it makes and the owner's others: as many as `create_project`'s transaction carries
  // (about 25; no cap of the program's own), which the setup's size check below refuses past (E-TX-SIZE).
  tooMany(
    m.collections.length + (m.collection ? 1 : 0),
    LIMITS.collections,
    'E-REF',
    'economy.collections',
    `The project takes ${m.collections.length + (m.collection ? 1 : 0)} collections`,
    'BadCollection',
    'Take fewer: a gate or a boost can name a collection the project doesn’t take.',
  );
  m.collections.forEach(
    (c, i) =>
      isAddress(c) ||
      refuse('E-REF', `economy.collections[${i}]`, `“${c}” is not an address.`, 'Write the Core collection’s address.'),
  );
  if (m.collections.length)
    warn(
      'W-COLLECTIONS',
      'economy.collections',
      `The project takes ${m.collections.length} collection${m.collections.length === 1 ? '' : 's'} you already have: going live passes ${m.collections.length === 1 ? 'it' : 'them'} to the program, which takes one whose update authority is your wallet, or a Core collection where the project is an update delegate (BadCollection otherwise). An item minted into one needs the project as an update delegate of it, which you add to the collection yourself.`,
    );
  // A Core collection where the project is only an update delegate: its owner and every other delegate can
  // write to it, and what they make reads as the project's own.
  if (m.collections.length)
    warn(
      'W-COLLECTION-PARTNER',
      'economy.collections',
      'If the project is only an update delegate of a collection it names (someone else owns it), you trust that partner: every item they mint into it counts as your own, and they can take your access away at any time. Anyone who can write to that collection, its owner and every other update delegate they named, can make an NFT that reads as any of the project’s items, in any of its collections, by minting one there with that "item_id": it passes the project’s gates, boosts and odds for that item and takes its missions’ prizes. Two projects that name one shared collection read each other’s items of the same number as their own. Once the access is taken away, purchases of items in it are refused, a won item can only be settled by giving it up, a staked NFT in a farm that writes on it leaves only by forfeit, and a box that holds a player’s NFT to change its numbers cannot settle until the access is back.',
      'Name only a collection whose every writer you trust, and never one another loot project also names.',
    );
  const given = new Set();
  for (const b of m.allBoxes)
    for (const o of (b.outcomes ?? []).flatMap(outcomeParts)) if (o.gives === 'item') given.add(o.item);
  for (const p of prizes(m)) if (p.prize.gives === 'item') given.add(p.prize.item);
  for (const a of m.auctions) if (a.lot?.item) given.add(a.lot.item);
  for (const d of m.decisions) if (d.does === 'make') given.add(d.item);
  // A fresh item is given only by a box's roll: a route the player pays or asks for refuses it (PrizeNotCovered); one that
  // only finishes (a lottery place, a contest, a mission's end) gives nothing in its place; an auction refuses the lot.
  const fix = 'Give a roll of a box that gives it (`{ "gives": "roll", "box": key }`) instead.';
  for (const p of prizes(m)) {
    const it = p.prize.gives === 'item' ? m.item.get(p.prize.item) : null;
    if (!(it?.drawn ?? []).length) continue;
    if (p.strict)
      refuse(
        'E-ITEM',
        p.where,
        `${label(it)} draws its traits per unit, which only a box’s roll does: a ${p.route} gives alike units (PrizeNotCovered).`,
        fix,
      );
    else
      warn(
        'W-ITEM',
        p.where,
        `${label(it)} draws its traits per unit, which only a box’s roll does: as a ${p.route}’s prize it is never given (its winner gets nothing for it).`,
        fix,
      );
  }
  for (const a of m.auctions) {
    const it = a.lot?.item ? m.item.get(a.lot.item) : null;
    if ((it?.drawn ?? []).length)
      refuse(
        'E-AUCTION',
        `economy.auctions.${a.key}.lot.item`,
        `${label(it)} draws its traits per unit, which only a box’s roll does: an auction can’t sell a new one (LotRefused).`,
        'Auction a roll of a box that gives it (`"lot": { "roll": key }`) instead.',
      );
  }

  // A table: rows that weigh something, a label of 32 bytes at most in a table of labels, none in one of numbers.
  for (const t of m.tables) {
    const where = `economy.tables.${t.key}`;
    if (!(t.rows ?? []).length)
      refuse('E-TABLE', `${where}.rows`, `The table “${t.key}” has no rows.`, 'Give it at least one row.');
    (t.rows ?? []).forEach((r, i) => {
      const bytes = new TextEncoder().encode(String(r.label ?? '')).length;
      if (t.kind === 'numbers' && r.label !== undefined)
        refuse(
          'E-TABLE',
          `${where}.rows[${i}].label`,
          `The table “${t.key}” is of numbers: a row gives its own number, and takes no label (BadTable).`,
          'Remove the label, or make the table "labels".',
        );
      else if (t.kind !== 'numbers' && (bytes === 0 || bytes > 32))
        refuse(
          'E-TABLE',
          `${where}.rows[${i}].label`,
          `Row ${i} of the table “${t.key}” has a label of ${bytes} bytes: a label is 1 to 32 bytes (BadTable).`,
          'Shorten it.',
        );
    });
    // A row of weight 0 or stock 0 is never drawn; a table with none that can be is drawn from as an empty one.
    const dead = (t.rows ?? []).map((r, i) => [r, i]).filter(([r]) => r.weight === 0 || r.stock === 0);
    if (dead.length)
      warn(
        'W-ZERO',
        `${where}.rows`,
        `${dead.length === (t.rows ?? []).length ? 'Every row' : `Row${dead.length === 1 ? '' : 's'} ${dead.map(([, i]) => i).join(', ')}`} of the table “${t.key}” ${dead.length === 1 ? 'has' : 'have'} a weight or a stock of 0: never drawn${dead.length === (t.rows ?? []).length ? ', so a draw from it finds nothing' : ''}.`,
        'Give each row a weight and a stock above 0, or leave the row out.',
      );
    if (!m.items.some(it => (it.drawn ?? []).some(d => d.table === t.key)))
      warn(
        'W-TABLE',
        where,
        `No item draws a trait from the table “${t.key}”.`,
        'Name it in an item’s "drawn", or leave it out.',
      );
  }

  for (const it of m.items) {
    const where = `economy.items.${it.key}`;
    // A fresh collectible: each trait its own attribute, drawn from a table the spec has or a range from its least to its
    // most; given only by a box's roll (a shop sells alike units: PrizeNotCovered).
    const drawn = it.drawn ?? [];
    if (drawn.length && !isCollectible(it))
      refuse(
        'E-ITEM',
        `${where}.drawn`,
        `${label(it)} draws traits, but it is a normal item: only a collectible carries them.`,
        'Make it a collectible, or leave "drawn" out.',
      );
    // Each trait is written as its unit is minted, which one transaction must hold (catalog.rs).
    tooMany(
      drawn.length,
      LIMITS.itemTraits,
      'E-ITEM',
      `${where}.drawn`,
      `${label(it)} draws ${drawn.length} traits`,
      'BadItem',
      'Draw fewer: put what goes together in one table’s labels.',
    );
    drawn.forEach((d, i) => {
      const at = `${where}.drawn[${i}]`;
      if (utf8Bytes(d.attribute ?? '') > LIMITS.traitKeyBytes)
        refuse(
          'E-ITEM',
          `${at}.attribute`,
          `${label(it)}’s trait “${String(d.attribute).slice(0, 24)}…” has a name of ${utf8Bytes(d.attribute)} bytes; the program takes at most ${LIMITS.traitKeyBytes} (BadItem).`,
          'Use a shorter name.',
        );
      if (RESERVED_ATTRIBUTES.includes(d.attribute))
        refuse(
          'E-ITEM',
          `${at}.attribute`,
          `${label(it)} draws “${d.attribute}”, an attribute the program writes itself (BadItem).`,
          'Name another attribute.',
        );
      if (drawn.slice(0, i).some(e => e.attribute === d.attribute))
        refuse(
          'E-ITEM',
          `${at}.attribute`,
          `${label(it)} draws “${d.attribute}” twice (BadItem).`,
          'Draw each attribute once.',
        );
      // A table is drawn by one trait each (catalog.rs: two draws of one table could find its last unit gone at the second).
      if (d.table !== undefined && drawn.slice(0, i).some(e => e.table === d.table))
        refuse(
          'E-ITEM',
          `${at}.table`,
          `${label(it)} draws two traits from the table “${d.table}”: the program draws a table once a unit (BadItem).`,
          'Give the second trait a table of its own (a copy of the first, if its values are the same).',
        );
      if (d.table !== undefined && (d.min !== undefined || d.max !== undefined))
        refuse('E-ITEM', at, `${label(it)}’s trait “${d.attribute}” names a table and a range.`, 'Keep one.');
      else if (d.table !== undefined && !m.table.get(d.table))
        refuse(
          'E-REF',
          `${at}.table`,
          `${label(it)}’s trait “${d.attribute}” draws from “${d.table}”, which is not one of the spec’s tables.`,
          'Add the table to "tables", or name one it has.',
        );
      else if (d.table === undefined && !(d.min !== undefined && d.max !== undefined && d.min <= d.max))
        refuse(
          'E-ITEM',
          at,
          `${label(it)}’s trait “${d.attribute}” needs a table, or a range from its "min" to its "max", the least first.`,
          'Name a table, or give a "min" and a "max".',
        );
    });
    if (drawn.length && (Number(it.price ?? 0) > 0 || it.free))
      refuse(
        'E-ITEM',
        `${where}.price`,
        `${label(it)} draws its traits per unit, by a roll: the shop sells only alike units (PrizeNotCovered).`,
        'Sell it from a box (one outcome is enough: the box still rolls), and leave "price" out.',
      );
    // A collectible is minted into a collection of the project's (catalog.rs BadCollection).
    if (isCollectible(it) && it.collection && !m.collections.includes(it.collection))
      refuse(
        'E-COLLECTION',
        `${where}.collection`,
        `${label(it)} is minted into ${it.collection}, which is not one of the project’s "collections" (BadCollection).`,
        'Add it to "collections", or leave "collection" out to mint into the one the setup makes.',
      );
    if (isCollectible(it) && !it.collection && !m.collection)
      refuse(
        'E-COLLECTION',
        `${where}.collection`,
        `${label(it)} is a collectible, but the project makes no collection ("collection": false) and the item names none.`,
        'Name one of "collections" as its "collection", make it a normal item, or let the setup make a collection.',
      );
    if ((it.uri ?? '').includes('{serial}') && !isCollectible(it))
      warn(
        'W-ITEM',
        `${where}.uri`,
        `${label(it)} is a normal item: "{serial}" in its link is written only on collectibles.`,
      );
    const price = units(it.price, game, `${where}.price`, `${label(it)}’s price`);
    prices(it, game, where);
    perWalletWindow(it, where);
    // A collectible's life, each time in 4 bytes (a normal item's is dropped, warned of below).
    if (isCollectible(it) && it.life)
      // (a cooldown is written into each recipe as a raise, whose amount is a signed number: half as much fits)
      for (const k of ['readyAfter', 'lasts', 'cooldown'])
        fourByteSeconds(it.life[k], `${where}.life.${k}`, { signed: k === 'cooldown' });
    if (it.kind === 'normal' && (it.life || it.soulbound || it.burnable))
      warn(
        'W-ITEM',
        where,
        `${label(it)} is a normal item, kept by the project’s backend: its life, soulbound and burnable settings only apply to collectibles, so the program drops them.`,
        'Make it a collectible, or remove those settings.',
      );
    split(it.split, game, `${where}.split`, { what: `${label(it)}’s sale`, chosen: true });
    feeNote(price, game, `${where}.price`, `purchase of ${label(it)}`);
    rule(it.gate, `${where}.gate`, `${label(it)}’s shop listing`);
    if (price === 0n && !it.free && !given.has(it.key))
      warn(
        'W-ITEM',
        where,
        `Nobody can get ${label(it)}: it is not in the shop (price 0), and no box, recipe, grant or decision gives it.`,
        'Give it a price (or "free": true), or put it in a box, a recipe or a grant.',
      );
    // "free" lists it at price 0: with a price too, the price would be charged under a spec that says free.
    if (it.free && Number(it.price ?? 0) > 0)
      refuse(
        'E-ITEM',
        `${where}.free`,
        `${label(it)} is "free" and has a price of ${it.price}: "free" lists it in the shop at 0, and the price would still be charged.`,
        'Leave the price out for a free listing, or "free" out to sell it at its price.',
      );
    if (it.free)
      warn(
        'W-FREE',
        where,
        `${label(it)} is free in the shop: anyone, a bot included, can take ${it.supply ? `all ${it.supply}` : 'as many as they like'} for only the fees.`,
        'Give it a gate, a supply, or hand it out through a grant with limits per wallet and per person.',
      );
  }
}
