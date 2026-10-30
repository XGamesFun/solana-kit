// What a setup step does with money and keys, read back from the instructions it sends (not from the spec's words):
// every payee of a split, where a schedule or a recipe sends tokens, who is given an NFT, the project's treasury and
// authority, a grant's prize, limits, voucher keys and list (each wallet with its amount), and whether any wallet may
// claim it. Addresses are written in full, so an owner sees a payee that an edit re-pointed before they sign.
import { decodeBorsh } from '../chain/borsh.js';
import { equalBytes, toHex } from '../chain/bytes.js';
import { accountKind, decode, IDL, keyLeaf, merkleRoot } from '../client/index.js';
import { LOOT_PROGRAM, pda } from '../client/pda.js';
import { fromUnits } from '../economy/model.mjs';
import { grantArgs } from '../economy/plan.mjs';

const NOBODY = '11111111111111111111111111111111';
const ZERO = new Uint8Array(32);

/** An instruction's accounts by name, nested groups flattened, in the order the program takes them. */
const leafNames = (list) => list.flatMap((a) => (a.accounts ? leafNames(a.accounts) : [a.name]));

/** A loot instruction read back: { name, args, accounts: { name: address } }, or null for another program's. */
function readLootInstruction(ix) {
  if (ix.programId !== LOOT_PROGRAM) return null;
  const def = IDL.instructions.find((i) => i.discriminator.length <= ix.data.length && i.discriminator.every((b, j) => ix.data[j] === b));
  if (!def) return null;
  const args = {};
  let at = def.discriminator.length;
  for (const a of def.args) [args[a.name], at] = decodeBorsh(IDL, a.type, ix.data, at);
  const accounts = Object.fromEntries(leafNames(def.accounts).map((name, i) => [name, ix.keys[i]?.pubkey]));
  return { name: def.name, args, accounts };
}

/**
 * The names an owner knows the spec's parts by. `m`: the spec's model; `owner`: the wallet that approves, once it is
 * connected; `treasury`: the treasury's address when it is known (else "your wallet" stands for it, as the setup
 * makes it).
 */
export function namesOf(m, { owner = null, treasury = null } = {}) {
  return {
    m,
    owner,
    treasury,
    pools: new Map(m.pools.map((p) => [p.index, p.key])),
    stashes: new Map(m.stashes.map((s) => [s.id, s.name ?? s.key])),
    grants: new Map(m.grants.map((g) => [g.id, g])),
  };
}

/** Plain-word lines for one step's instructions: what it pays to whom, and which keys it trusts. */
export function stepDetails(instructions, names) {
  const reads = [];
  for (const ix of instructions) {
    try {
      reads.push(readLootInstruction(ix));
    } catch (e) {
      reads.push({ unreadable: e.message });
    }
  }
  return readDetails(reads, names);
}

/** The account each record an `upsert` writes is kept in on chain. */
const RECORD_ACCOUNT = { Item: 'Item', Box: 'LootBox', Schedule: 'Schedule', Lottery: 'Lottery', Recipe: 'Recipe', Grant: 'Grant' };

/**
 * What is live for one step, read from the chain (`chain.account`): the lines of the records its `upsert`s write, as
 * they are on chain now (an account's fields are named as the upsert's). [] when none of them is on chain yet (all of
 * it is new); null when the step writes no record, so there is nothing on chain to hold it against.
 */
export async function liveStepDetails(instructions, names, chain) {
  const reads = [];
  for (const ix of instructions) {
    const read = readLootInstruction(ix);
    const [kind] = Object.keys(read?.name === 'upsert' ? read.args.def ?? {} : {});
    if (!RECORD_ACCOUNT[kind]) continue;
    const account = await chain.account(read.accounts.target);
    if (!account) {
      reads.push(null);
      continue;
    }
    if (account.owner !== LOOT_PROGRAM || accountKind(account.data) !== RECORD_ACCOUNT[kind]) throw new Error(`${read.accounts.target} is not the ${kind.toLowerCase()} it should be.`);
    reads.push({ ...read, args: { def: { [kind]: { id: read.args.def[kind].id, args: decode(RECORD_ACCOUNT[kind], account.data) } } } });
  }
  return reads.length ? readDetails(reads.filter(Boolean), names) : null;
}

/** The lines for instructions read back (readLootInstruction's answers; null for another program's). */
function readDetails(reads, names) {
  const lines = [];
  for (const read of reads) {
    if (read?.unreadable) {
      lines.push(`This step could not be read back (${read.unreadable}): check what it pays in your wallet before approving`);
      continue;
    }
    if (!read) continue;
    const owner = read.accounts.owner ?? read.accounts.seller;
    const project = read.accounts.project;
    const pots = new Map(names.m.lotteries.map((l) => [pda.pot(pda.lottery(project, l.id)), l.name ?? l.key]));
    // Before a wallet connects, the plan stands a made-up address in for it (one no spec may name): that one is not
    // shown. Once one is connected, only that wallet is called yours.
    const yours = (a) => (names.owner == null ? 'your wallet' : a === names.owner ? `your wallet (${a})` : `the project’s owner, ${a}`);
    const address = (a) => (a === owner ? yours(a) : a);
    const wallet = (a) => (a === owner ? yours(a) : `the wallet ${a}`);
    const treasury = () => `the treasury (${names.treasury ? address(names.treasury) : 'your wallet'})`;
    const where = (to) => {
      if (to === 'Treasury') return treasury();
      const [kind] = Object.keys(to);
      const v = to[kind];
      if (kind === 'Pool') return `the pool “${names.pools.get(v[0]) ?? v[0]}”`;
      if (kind === 'Wallet') return wallet(v[0]);
      if (kind === 'Account') return pots.has(v[0]) ? `the pot of “${pots.get(v[0])}”` : `the token account ${v[0]}`;
      if (kind === 'Holder') return `whoever holds the NFT ${v[0]}`;
      if (kind === 'Chosen') return 'a wallet the buyer chooses';
      return JSON.stringify(to);
    };
    if (read.name === 'create_project') {
      lines.push(`Treasury: ${address(read.args.treasury)}`);
      lines.push(`Authority (signs the project’s decisions): ${address(read.args.authority)}`);
      continue;
    }
    // Where what a split leaves goes: a lottery's pot, an auction's seller (or the treasury for a new item), else the treasury.
    const def = read.args.def ?? {};
    const restTo = def.Lottery ? 'its pot' : read.name === 'open_auction' ? (read.args.args?.lot?.Asset ? `the seller, ${address(read.accounts.seller)}` : treasury()) : treasury();
    const to = (v) => (v === 'Burn' ? 'burned' : `to ${where(v)}`);
    const isTo = (v) => v === 'Burn' || v === 'Treasury' || (v && typeof v === 'object' && ['Pool', 'Account', 'Holder', 'Wallet', 'Chosen'].some((k) => k in v) && Object.keys(v).length === 1);
    const grantId = read.args.def?.Grant?.id;
    if (read.args.def?.Grant) lines.push(...grantTerms(read.args.def.Grant.args, names));
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== 'object' || value instanceof Uint8Array) return;
      for (const [k, v] of Object.entries(value)) {
        if (k === 'shares' && Array.isArray(v)) {
          const rest = 10_000 - v.reduce((n, s) => n + Number(s.bps), 0);
          const parts = v.map((s) => `${Number(s.bps) / 100}% ${to(s.to)}`);
          if (rest > 0) parts.push(v.length ? `the rest (${rest / 100}%) to ${restTo}` : `all of it to ${restTo}`);
          lines.push(`Pays: ${parts.join(', ')}`);
        } else if (k === 'to' && isTo(v)) lines.push(v === 'Burn' ? 'Burns the tokens it takes' : `Sends tokens to ${where(v)}`);
        else if (k === 'Give' && Array.isArray(v) && typeof v[0] === 'string') lines.push(`Gives the NFT to ${address(v[0])}`);
        else if (k === 'vouchers' && Array.isArray(v)) {
          const keys = v.filter((a) => a !== NOBODY);
          if (keys.length) lines.push(`Voucher keys (each decides who gets it): ${keys.join(', ')}`);
        } else if (k === 'key_root' && v instanceof Uint8Array) {
          if (!equalBytes(v, ZERO)) {
            const listed = names.grants.get(grantId)?.keys ?? [];
            const ours = listed.length && equalBytes(merkleRoot(listed.map((key) => keyLeaf(key))), v);
            lines.push(ours ? `Voucher keys from its list (each decides who gets it): ${listed.join(', ')}` : `Voucher keys: a list with the root ${toHex(v)}, which is not the spec’s list`);
          }
        } else if (k === 'list_root' && v instanceof Uint8Array) {
          if (!equalBytes(v, ZERO)) lines.push(...listLines(v, names.grants.get(grantId), read.args.def.Grant.args.gives, names));
        } else if (k === 'open' && v === true) lines.push('Open: any wallet may claim it, with no voucher and no list, within its limits');
        else walk(v);
      }
    };
    walk(read.args);
  }
  return lines;
}

/** The token a prize pays in, from its bytes: { symbol, decimals }, or null when it is not one the spec names. */
function prizeToken(gives, m) {
  const from = gives?.Tokens?.from;
  if (!from) return null;
  const key = from.Pool ? (m.pools.find((p) => p.index === from.Pool[0])?.currency ?? m.currencyKey) : [...m.tokens.values()].find((t) => t.mint === (from.Mint ?? from.Vest)?.[0])?.key;
  return m.tokens.get(key) ?? null;
}

/** Base units of `token` in its own words ("100 COIN"), or as base units when the token is not known. */
const tokens = (units, token) => (token ? `${fromUnits(BigInt(units), token.decimals ?? 0)} ${token.symbol ?? token.key}` : `${units} base units`);

/** A prize in words, from its bytes. Named by the spec's parts; an NFT or a tree is not a payee, so its address is left out. */
function prizeWords(gives, m) {
  const [kind] = Object.keys(gives ?? {});
  const v = gives?.[kind];
  const named = (list, id, field = 'id') => list.find((x) => x[field] === id);
  const stash = (id) => `the stash “${named(m.stashes, id)?.name ?? named(m.stashes, id)?.key ?? id}”`;
  const item = (id) => `the item “${named(m.items, id)?.name ?? named(m.items, id)?.key ?? id}”`;
  if (kind === 'Tokens') {
    const from = v.from.Pool ? `from the pool “${m.pools.find((p) => p.index === v.from.Pool[0])?.key ?? v.from.Pool[0]}”` : v.from.Mint ? `minted from ${v.from.Mint[0]}` : `from the vault ${v.from.Vest[0]}`;
    const amount = v.amount.Fixed ? tokens(v.amount.Fixed[0], prizeToken(gives, m)) : `${Number(v.amount.Bps[0]) / 100}% of what it holds`;
    return `${amount} ${from}`;
  }
  if (kind === 'Item') return item(v[0]);
  if (kind === 'Nft') return `an NFT of ${stash(v.stash)}`;
  if (kind === 'Stash') return `an NFT of ${stash(v[0])} at random`;
  if (kind === 'Roll') return `a roll of the box “${m.allBoxes.find((b) => b.id === v[0])?.name ?? m.allBoxes.find((b) => b.id === v[0])?.key ?? v[0]}”`;
  if (kind === 'Compressed') return `a compressed NFT of ${item(v.item)}`;
  if (kind === 'Held') return 'an NFT the lottery holds';
  return 'nothing';
}

const times = (n) => `${n} claim${Number(n) === 1 ? '' : 's'}`;
const when = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

/** A grant's prize and its limits: what each claim takes from the project, and how many claims there can be. */
function grantTerms(args, names) {
  const l = args.limits ?? {};
  const limits = [
    l.wallet?.total ? `each wallet ${times(l.wallet.total)} in all` : null,
    l.wallet?.per_window ? `each wallet ${times(l.wallet.per_window)} every ${l.wallet.window} seconds` : null,
    l.per_person ? `each person ${times(l.per_person)}` : null,
    l.per_key ? `each voucher key ${times(l.per_key)}` : null,
    l.per_day ? `${times(l.per_day)} a day` : null,
    l.total ? `${times(l.total)} in all` : null,
    BigInt(l.window?.opens_at ?? 0) ? `opens ${when(l.window.opens_at)}` : null,
    BigInt(l.window?.closes_at ?? 0) ? `closes ${when(l.window.closes_at)}` : null,
  ].filter(Boolean);
  // A voucher or a list entry may name an amount of its own, up to the grant's fixed amount (0 is the prize as it is).
  const upTo = !args.open && args.gives?.Tokens?.amount?.Fixed ? 'up to ' : '';
  return [`Each claim gets: ${upTo}${prizeWords(args.gives, names.m)}`, `Limits: ${limits.length ? limits.join(', ') : 'none'}`];
}

/**
 * A grant's list, read against the root it writes: every wallet on it with what it gets and in which round, when the
 * root is the spec's list; else that the root is not the spec's.
 */
function listLines(root, g, gives, names) {
  const list = g?.list ?? [];
  if (!list.length || !equalBytes(grantArgs(g, names.m).list_root, root)) return [`Its list: a list with the root ${toHex(root)}, which is not the spec’s list`];
  const token = prizeToken(gives, names.m);
  return [
    `Only wallets on its list may claim it (${list.length} wallet${list.length === 1 ? '' : 's'}, root ${toHex(root)})`,
    ...list.map((e) => {
      const entry = typeof e === 'string' ? { wallet: e } : e;
      const gets = entry.amount !== undefined ? `gets ${entry.amount} ${token?.symbol ?? token?.key ?? 'tokens'}` : 'gets the prize above';
      return `On its list, ${entry.wallet}: ${gets}${entry.round ? `, in round ${entry.round}` : ''}`;
    }),
  ];
}

/**
 * A change's lines against what is live: a line of `now` that differs from the one `was` had about the same thing
 * (the words before the colon) says what it was, a line about something new says so, and what `was` had that `now`
 * lacks is listed as no longer so.
 */
export function compareDetails(now, was) {
  const topic = (line) => line.split(':')[0];
  const left = [...was];
  const out = now.map((line) => {
    const same = left.indexOf(line);
    if (same >= 0) return left.splice(same, 1)[0];
    const i = left.findIndex((old) => topic(old) === topic(line));
    if (i < 0) return `${line} (new)`;
    const [old] = left.splice(i, 1);
    return `${line} (changed: it was ${old.slice(topic(old).length + 1).trim() || old})`;
  });
  return [...out, ...left.map((old) => `No longer: ${old}`)];
}

const ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/** Every address the lines name, in the order they name them. */
const addressesIn = (lines) => [...new Set(lines.flatMap((l) => l.match(ADDRESS) ?? []))];

/**
 * A warning for the page when the approval pays or trusts an address: on a change, those the live economy did not
 * (`was`: the lines of what is live); on a new setup, every one but the owner's wallet (`owner`, when known).
 */
export function outsideAddresses(lines, { was = null, owner = null } = {}) {
  const known = new Set([...(was ? addressesIn(was) : []), ...(owner ? [owner] : [])]);
  const outside = addressesIn(lines).filter((a) => !known.has(a));
  if (!outside.length) return null;
  return was
    ? `This change pays or trusts ${outside.length === 1 ? 'an address' : 'addresses'} the live economy does not: ${outside.join(', ')}. Approve only if you meant ${outside.length === 1 ? 'it' : 'each one'} (the lines below say what each gets).`
    : `This setup pays or trusts ${outside.length === 1 ? 'an address' : 'addresses'} other than your wallet: ${outside.join(', ')}. Approve only if you meant ${outside.length === 1 ? 'it' : 'each one'} (the lines below say what each gets).`;
}
