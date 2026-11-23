// The platform's instructions, and a project's settings: the project, its pools and its records.
import { NO_ADDRESS } from '../../chain/base58.js';
import { toBigInt } from '../../chain/bytes.js';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import { idleRound, lotteryPots, MAX_POTS, ownStash, paymentMint, potIdOf } from '../accounts.js';
import { ata, pda } from '../pda.js';
import { stored, tokenProgramOf, traitsInCaps } from './shared.js';
import { lootIx, tailOf } from './base.js';
import { boxesAccounts, defRolls } from './tail.js';

// ---------------------------------------------------------------- the platform

/** Signed by the program's upgrade authority, once. `fees`: { player, project } lamports. */
export const initPlatformIx = ({ admin, fees }) => lootIx('init_platform', { fees }, { admin });

/** `nextAdmin` signs too when it is another key. */
export const setPlatformIx = ({ admin, fees, nextAdmin = admin }) =>
  lootIx('set_platform', { fees }, { admin, next_admin: nextAdmin });

/** The platform collects the fees waiting in each project's fee box, into `to`. */
export const collectFeesIx = ({ admin, to, projects }) =>
  lootIx(
    'collect_fees',
    {},
    { admin, to },
    { remaining: projects.map(project => meta(pda.fees(project), false, true)) },
  );

export const setSuspendedIx = ({ admin, project, suspended }) =>
  lootIx('set_suspended', { suspended }, { admin, project });

// ---------------------------------------------------------------- a project's settings

/**
 * Opens project `id` (any number of `owner`'s own) at `pda.project(owner, id)`. `authority` signs payouts and makes,
 * `treasury` is the wallet the remainder of every split goes to (its associated token account of each mint, which the
 * program opens when it is not there). `collections`: the Metaplex Core collections it has authority over (none at
 * all is fine; at most 8), each one whose update authority is the owner or the project, passed after the
 * instruction's own accounts. A project names no token: each mechanic names the mint it takes or pays. Only the owner
 * signs; the authority's and the treasury's accounts are passed too, and the program refuses a key nobody can sign
 * for that it can tell (an account of loot or of a token program, a program: `BadKey`).
 */
export const createProjectIx = ({ owner, id = 0, authority, treasury, collections = [] }) =>
  lootIx(
    'create_project',
    { id: toBigInt(id), authority, treasury, collections },
    { owner, authority, treasury, project: pda.project(owner, id) },
    { remaining: collections.map(c => meta(c, false, false)) },
  );

/**
 * Changes project `project`'s settings, signed by its `owner`. Each setting is an option of its own, beside `owner`
 * and `project`: `authority`, `treasury`, `paused`, `collections`, `issuer`. One left out stays as it is. `collections`
 * replaces the project's list; every one in it is passed after the instruction's own accounts (the program reads the
 * new ones). The owner pays for the project growing with its collections, and gets back what it shrinks by. `issuer`:
 * the key that vouches for which person a wallet belongs to (`NO_ADDRESS` for nobody). `newOwner`: a new owner, who
 * signs too. A new authority or treasury comes with the account at its key (`new_authority`, `new_treasury`), which
 * the program checks as `createProjectIx`'s.
 */
export const updateProjectIx = ({
  owner,
  project,
  authority = null,
  paused = null,
  treasury = null,
  collections = null,
  issuer = null,
  newOwner = null,
}) =>
  lootIx(
    'update_project',
    { update: { authority, treasury, paused, collections, issuer } },
    { owner, project, new_owner: newOwner, new_authority: authority, new_treasury: treasury },
    { remaining: (collections ?? []).map(c => meta(c, false, false)) },
  );

export const openPoolIx = ({ owner, project, index, mint }) =>
  lootIx('open_pool', { index }, { owner, project, mint, pool: pda.pool(project, index) });

/** Where a record of the owner's lives: its kind's seed, the project and its id. */
export function recordAddress(project, def) {
  const [kind] = Object.keys(def);
  const body = def[kind];
  switch (kind) {
    case 'Item':
      return pda.item(project, body.id);
    case 'Box':
      return pda.box(project, body.id);
    case 'Schedule':
      return pda.schedule(project, body.id);
    case 'Lottery':
      return pda.lottery(project, body.id);
    case 'Recipe':
      return pda.recipe(project, body.id);
    case 'Grant':
      return pda.grant(project, body.id);
    case 'Table':
      return pda.table(project, body.id);
    default:
      throw new Error(`Unknown record kind ${kind}`);
  }
}

const NO_WINDOW = { opens_at: 0n, closes_at: 0n };
const NO_LIMIT = { total: 0, per_window: 0, window: 0, by_person: false };
/** A `PerWallet` with what is left out filled in: a lottery's number is its tickets a round. */
const limitOf = limit =>
  typeof limit === 'number' || typeof limit === 'bigint'
    ? { ...NO_LIMIT, per_window: Number(limit) }
    : { ...NO_LIMIT, ...(limit ?? {}) };
/**
 * `def` with optional fields filled in (no window, no limit for each wallet, no key root, a fall on its own clock).
 */
export function withDefaults(def) {
  const [kind] = Object.keys(def);
  const body = def[kind];
  const args = { ...body.args };
  if (kind === 'Box' || kind === 'Lottery' || kind === 'Grant') args.gate ??= null;
  if (kind === 'Item') {
    args.collection ??= NO_ADDRESS;
    // A fresh item's traits (`Item::traits`): none for one whose units are all alike.
    args.traits = traitsInCaps(args.traits ?? []);
  }
  if (kind === 'Box') {
    stored(args.shares);
    if (!args.currency) throw new Error('A box names the mint its price is in (`currency`).');
    // What one open draws (`LootBox::slots`): none is one draw among every entry.
    args.slots = (args.slots ?? []).map(s => ({ only: [], distinct: false, share: 0, ...s }));
    // An entry: its prizes (`prizeMetas`) and its weight. A box burns its price with a share to `Burn`.
    if (!Array.isArray(args.entries))
      throw new Error('A box needs its entries (`entries`): what its roll can give, each with its weight.');
    args.entries = args.entries.map(e => ({ prizes: [], ...e }));
    args.subject ??= null;
    // What it does once an entry can't be given (`WhenOut`): stop selling while any entry couldn't cover the draws of
    // a purchase and those waiting for their answer (the default), or draw among what is left ('DrawLeft').
    args.when_out ??= 'StopSales';
    // A fate's `then`: null sends the NFT back to its player; 'Burn', { Give: [wallet] } or { Stash: [id] }.
    args.fates = (args.fates ?? []).map(f => ({
      ...f,
      then: f.then ?? null,
      shifts: (f.shifts ?? []).map(s => ({ from_now: false, ...s })),
    }));
  }
  if (kind === 'Box' || kind === 'Recipe') {
    args.window ??= NO_WINDOW;
    args.per_wallet = limitOf(args.per_wallet);
  }
  if (kind === 'Recipe') {
    // A raise moves a number on a kept collectible (`place`) as a box's fate does (`Shift`); a need tests one (`Test`).
    args.raises = (args.raises ?? []).map(({ place, shift, ...flat }) => ({
      place,
      shift: { from_now: false, most: 0, ...(shift ?? flat) },
    }));
    args.needs = (args.needs ?? []).map(({ place, key, test, at_least: least }) => ({
      place,
      key,
      test: test ?? { AtLeast: [least ?? 0] },
    }));
  }
  if (kind === 'Box' && args.fall) args.fall = { shared: false, ...args.fall };
  if (kind === 'Lottery') {
    // Its terms (`LotteryTerms`, what a round copies at its first purchase), given in `terms` or beside `every`.
    const { every, gate, per_wallet: perWallet, terms: given, ...flat } = args;
    // Sales close `closes_before` seconds before the draw (0: at the draw). `time_weighted` (a lottery that returns its
    // tickets only): a purchase counts for its tickets times the seconds from it to the close of sales.
    const terms = {
      nft_ticket: null,
      returns: false,
      min_sold: 0,
      ticket_mint: NO_ADDRESS,
      closes_before: 0n,
      time_weighted: false,
      ...flat,
      ...given,
    };
    // Where its places are paid from is the project's to name, never a default: `{ Pot: [id] }`, a pot kept from round
    // to round, or `{ Round: { rest } }`, each round's own ticket money with what its places leave going to `rest`.
    const pays = terms.pays_from;
    if (!pays || !(pays.Pot || pays.Round))
      throw new Error(
        'A lottery names where its places are paid from (`pays_from`): { Pot: [id] } or { Round: { rest } }.',
      );
    if (pays.Pot && !(Number(pays.Pot[0]) >= 0 && Number(pays.Pot[0]) < MAX_POTS))
      throw new Error(`A lottery's pot id is below ${MAX_POTS}.`);
    // A run of places alike is { bps, prize, when_short, times }; a number is one place's share of the pot that gives
    // nothing else. `when_short`: what a place of tokens from a pool gets when the pool holds less than the places with
    // a winner win: 'InOrder' (the first places in full, the default), 'InProportion' or 'Nothing'.
    terms.places = (terms.places ?? []).map(p =>
      typeof p === 'object'
        ? { prize: null, when_short: 'InOrder', times: 1, ...p }
        : { bps: p, prize: null, when_short: 'InOrder', times: 1 },
    );
    terms.shares = stored(terms.shares ?? []);
    return {
      [kind]: { ...body, args: { terms, every: every ?? 0n, gate: gate ?? null, per_wallet: limitOf(perWallet) } },
    };
  }
  if (kind === 'Grant') {
    args.key_root ??= new Uint8Array(32);
    args.open ??= false;
    args.shard_bits ??= 0;
    if (args.limits)
      args.limits = {
        per_key: 0,
        tokens: 0n,
        window: NO_WINDOW,
        ...args.limits,
        wallet: limitOf(args.limits.wallet),
        all: limitOf(args.limits.all),
      };
  }
  return { [kind]: { ...body, args } };
}

/** The most "one of" texts a lottery's NFT ticket rule holds: the oracle's answer reads it (`lottery.rs`). */
export const MAX_TICKET_TEXTS = 170;
/** The most places of a lottery that give NFTs of its own stash (`MOST_OWN`): the oracle's answer loads their list. */
export const MAX_OWN_STASH_PLACES = 256;

/**
 * The owner writes one record (`def`: { Item: { id, args } }, { Box: … }, …), at its own address. A lottery names
 * its mint, the pot its terms pay from (which a write opens when it isn't open; pot 0's address for a lottery whose
 * rounds pay from their own money, where any account will do), its ticket mint, both token programs and the round it waits on
 * (`lotteryState`: the lottery as it is, null for a new one; `idleRound`: its current round's record, or its last round's once
 * it drew once and ended: a lottery made again, edited once ended or made to repeat waits while that round runs or
 * still owes NFTs of its own stash), then its own stash when a place holds or draws an NFT of it. A box, a recipe, a grant or a lottery that
 * names a box to roll later passes that box after (`boxesAccounts`), which must be written: a box is written before
 * anything names it (it may name itself).
 */
export function upsertIx({ owner, project, def: given, lotteryState = null }) {
  const def = withDefaults(given);
  const [kind] = Object.keys(def);
  const { args } = def[kind];
  let remaining = [];
  // A collectible names its collection, read for Bubblegum's plugin (`Item::compressed`: its compressed prizes can be
  // minted only when the collection carries it).
  if (kind === 'Item' && args.kind === 'Collectible') remaining = [meta(args.collection, false, false)];
  // A new sealed schedule opens its own vault: its mint, the vault and both token programs.
  const vest = kind === 'Schedule' ? args.action?.from?.Vest?.[0] : null;
  if (vest) {
    // It pays a wallet, the treasury or a burn. A wallet it pays follows the vault's four: the program refuses one
    // that is an account of its own (`BadMove`: every run would pass it over).
    const payee = args.action.to?.Wallet?.[0];
    remaining = [
      meta(vest, false, false),
      meta(pda.vest(recordAddress(project, def)), false, true),
      meta(TOKEN_PROGRAM, false, false),
      meta(TOKEN_2022_PROGRAM, false, false),
      ...(payee ? [meta(payee, false, false)] : []),
    ];
  }
  if (kind === 'Lottery') {
    // The oracle's answer reads the round on the default 32 KiB of memory: an NFT ticket's rule holds at most 170 "one
    // of" texts, and a raffle at most 256 places from its own stash (BadLottery past either).
    const texts = args.terms.nft_ticket?.rule?.test?.OneOf?.texts?.length ?? 0;
    if (texts > MAX_TICKET_TEXTS)
      throw new Error(
        `A lottery's NFT ticket rule holds at most ${MAX_TICKET_TEXTS} "one of" texts; this one has ${texts} (BadLottery).`,
      );
    const own = args.terms.places.filter(ownStash).reduce((n, p) => n + Number(p.times ?? 1), 0);
    if (own > MAX_OWN_STASH_PLACES)
      throw new Error(
        `A lottery gives at most ${MAX_OWN_STASH_PLACES} places from its own stash; this one gives ${own} (BadLottery).`,
      );
    remaining = [
      meta(args.terms.mint, false, false),
      meta(pda.lotteryPot(recordAddress(project, def), potIdOf(args.terms) ?? 0), false, true),
      meta(paymentMint(args.terms), false, false),
      meta(TOKEN_PROGRAM, false, false),
      meta(TOKEN_2022_PROGRAM, false, false),
      meta(lotteryState ? idleRound(recordAddress(project, def), lotteryState) : SYSTEM_PROGRAM, false, false),
    ];
    // A place that holds or draws an NFT of its own stash (`Prize::Held`, `Prize::Raffled`): that stash, after them.
    if (args.terms.places.some(p => p.prize?.Held || p.prize === 'Raffled'))
      remaining.push(meta(pda.lotteryStash(recordAddress(project, def)), false, false));
  }
  // Each box it names to roll later (a box's, a recipe's, a grant's, a lottery's places'), once.
  remaining.push(...boxesAccounts(project, defRolls(def)));
  return lootIx('upsert', { def }, { owner, project, target: recordAddress(project, def) }, { remaining });
}

/**
 * The owner closes the record at `target`, and its rent comes back: a grant's with the funds it held. A lottery
 * (`lottery`: its decoded record) sends what every pot it opened holds (`Lottery::pots`) to `to`, a token account of its
 * mint (the owner's own by default), and closes each, once its current round has no record (one that drew once and
 * ended: once its last round gave out every NFT of its own stash, `idleRound`), and once the round its `owing` names has
 * moved in what it owes its pot (pull it first, `Part::Common`). One that never opened a pot names only those rounds.
 */
export function closeRecordIx({ owner, project, target, lottery, schedule, programs, to, extra = [] }) {
  // A sealed schedule never closes (CannotClose): its address, and its vault's, stay bound to its terms.
  if (schedule?.action?.from?.Vest)
    throw new Error('A sealed schedule never closes: its vault stays bound to its terms.');
  if (!lottery) return lootIx('upsert', { def: null }, { owner, project, target });
  const { mint } = lottery.terms;
  const tokenProgram = tokenProgramOf(programs, mint);
  const pots = lotteryPots(lottery);
  const owing = lottery.owing && lottery.owing !== NO_ADDRESS ? [meta(lottery.owing, false, false)] : [];
  const remaining = [
    meta(idleRound(target, lottery), false, false),
    // The round that may still owe a pot: the close waits until it has moved its leftover in (RoundRunning).
    ...owing,
    ...(pots.length
      ? [
          meta(mint, false, true),
          meta(to ?? ata(owner, mint, tokenProgram), false, true),
          meta(TOKEN_PROGRAM, false, false),
          meta(TOKEN_2022_PROGRAM, false, false),
          ...pots.map(id => meta(pda.lotteryPot(target, id), false, true)),
        ]
      : []),
    ...tailOf(extra),
  ];
  return lootIx('upsert', { def: null }, { owner, project, target }, { remaining });
}
