// The checks of keys and program numbers: no two parts of a kind share a key or a number, and no box shares its
// number with a shop listing.

/** Checks the keys and program numbers of every part. */
export function checkKeys(c) {
  const { economy, refuse, m } = c;
  // ---- keys and ids
  for (const [list, kind] of Object.entries({
    tokens: 'token',
    items: 'item',
    pools: 'pool',
    stashes: 'stash',
    boxes: 'box',
    payments: 'payment',
    recipes: 'recipe',
    schedules: 'schedule',
    lotteries: 'lottery',
    farms: 'farm',
    contests: 'contest',
    auctions: 'auction',
    holds: 'hold',
    grants: 'grant',
    decisions: 'decision',
  })) {
    const seen = new Set();
    for (const [i, part] of (economy[list] ?? []).entries()) {
      if (seen.has(part.key))
        refuse(
          'E-KEY-DUP',
          `economy.${list}[${i}].key`,
          `Two ${list} are called “${part.key}”: the other parts could not tell which one they mean.`,
          `Give each ${kind} its own key.`,
        );
      seen.add(part.key);
    }
    const field = list === 'pools' ? 'index' : 'id';
    const ids = new Set();
    for (const [i, part] of (economy[list] ?? []).entries()) {
      if (part[field] === undefined) continue;
      if (ids.has(part[field]))
        refuse(
          'E-KEY-DUP',
          `economy.${list}[${i}].${field}`,
          `Two ${list} have the program number ${part[field]}: the second would overwrite the first.`,
          `Remove the ${field} from the newer one; it gets a free number when it goes live.`,
        );
      ids.add(part[field]);
    }
  }
  const boxIds = new Map();
  for (const b of m.allBoxes) {
    if (boxIds.has(b.id))
      refuse(
        'E-KEY-DUP',
        b.shopOf ? `economy.items.${b.shopOf}.shopBox` : `economy.boxes.${b.key}.id`,
        `The box number ${b.id} is taken twice (a box and a shop listing share the numbers).`,
        'Remove one of the numbers; it gets a free one when it goes live.',
      );
    boxIds.set(b.id, b);
  }
}
