// The checks of a change to a live economy: what the program never edits once live, a live part sent again with a
// time counted from going live, and an item's traits once a unit of it is issued.
import { lockedChanges } from '../model.mjs';
// live.mjs imports plan.mjs, which imports check(): each module only calls the others' functions, never at load time.
import { changedParts, goLiveFields } from '../live.mjs';
import { label } from '../format.mjs';

/** Checks what a change to a live economy can and cannot change. */
export function checkLiveParts(c) {
  const { economy, refuse, warn, m } = c;
  // ---- what can't change once live (live.mjs changedParts `fixed`): the program never edits a farm or an auction once
  // open, takes no new token for a pool, appends a table's rows when it is written again, never edits a sealed schedule,
  // and keeps a lottery's pot in its mint. A change to one is refused here, before anything is signed: left out of what
  // the approval sends, it would stay as it was on chain while the file said otherwise.
  if (economy.live?.published) {
    const WHY = {
      farm: 'a farm is never edited once open: a new one replaces it (another key)',
      auction: 'an auction is never edited once open: a new one replaces it (another key)',
      pool: 'a pool keeps its token: a new pool (another key) takes another',
      table: 'a table written again adds its rows after the ones it has: a new table (another key) takes new rows',
      schedule: 'a sealed schedule is written once: nobody edits it (Sealed)',
      lottery: "a lottery's pot stays in its mint (WrongMint): a new lottery (another key) takes another currency",
    };
    // A live part sent again that still says a time from its going live (a file whose approval did not write its
    // dates): this change reads it from now, so on chain it moves; the approval writes the date it sends from then on.
    const LISTS = {
      item: 'items',
      box: 'boxes',
      recipe: 'recipes',
      schedule: 'schedules',
      lottery: 'lotteries',
      auction: 'auctions',
      grant: 'grants',
    };
    for (const id of changedParts(economy).only) {
      const [kind, key] = id.split(':');
      const list = LISTS[kind];
      if (!list || !(economy.live.published[list] ?? []).some(p => p.key === key)) continue;
      const part = (economy[list] ?? []).find(p => p.key === key);
      const fields = goLiveFields(part, list);
      if (fields.length)
        warn(
          'W-LIVE-TIME',
          `economy.${list}.${key}`,
          `The live ${kind} “${key}” is sent again, and its ${fields.join(', ')} ${fields.length === 1 ? 'says' : 'say'} a time from going live ("publish…"${fields.includes('fall.start') ? ', or a fall with no start' : ''}): this change counts ${fields.length === 1 ? 'it' : 'them'} from now, so on chain ${fields.length === 1 ? 'it moves' : 'they move'} later than ${fields.length === 1 ? 'it was' : 'they were'}.`,
          'Write the date it was published with (an ISO date) to keep it; from this approval on, the file says the date it sends.',
        );
    }
    for (const id of changedParts(economy).fixedEdited) {
      const [kind, key] = id.split(':');
      refuse(
        'E-LIVE-FIXED',
        `economy.${Object.entries({ farm: 'farms', auction: 'auctions', pool: 'pools', table: 'tables', schedule: 'schedules', lottery: 'lotteries' }).find(([k]) => k === kind)?.[1] ?? kind}.${key}`,
        `The live ${kind} “${key}” is changed, and ${WHY[kind] ?? 'it can’t change once live'}.`,
        'Put it back as it was published, or make the change as a new part with a key of its own.',
      );
    }
  }

  // ---- a live item's kind, soulbound, burnable, collection and drawn traits are fixed once a unit of it is issued
  // (catalog.rs KindLocked): its edit is then refused. How many were issued is the chain's to say, read as the change is
  // approved (approve/live-check.mjs checkItemLocks).
  for (const it of economy.items ?? []) {
    const was = (m.live.published?.items ?? []).find(x => x.key === it.key);
    const changed = was ? lockedChanges(it, was) : [];
    if (changed.length)
      warn(
        'W-ITEM-LOCKED',
        `economy.items.${it.key}`,
        `${label(it)} is live, and this changes its ${changed.join(', ')}: the program refuses that once any “${it.name ?? it.key}” has been issued (KindLocked), so the change goes through only if none has.`,
        'Approving reads how many were issued and says so before anything is signed; to change an item people already hold, make a new item.',
      );
  }
}
