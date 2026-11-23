// What a player's transactions with a live economy take, estimated before anything is sent (txsize.mjs counts the
// bytes): a craft, a box's open or purchase, and the settle that pays a box's outcome, in bytes, accounts and compute.
// The checker refuses what could never fit; the plan and the tests read the same numbers.
import IDL from '../client/idl/loot.js';
import { gateList } from '../client/grant.js';
import {
  rent as rentOf,
  destination,
  outcomeParts,
  drawsOf,
  byPerson,
  limitsPlayers,
  stashNfts,
  sharesOf,
} from './model.mjs';
import { estimateTransactionSize, transactionLocks } from './txsize.mjs';

/** A transaction's estimated bytes, or with `detail` { bytes, locks }. */
const measured = (input, detail) =>
  detail ? { bytes: estimateTransactionSize(input), locks: transactionLocks(input) } : estimateTransactionSize(input);

/** The bytes of a loot instruction's tag: 1, or 8 for the oracle's callbacks. */
const tagBytes = name => IDL.instructions.find(i => i.name === name).discriminator.length;
export const isCollectible = it => (it?.kind ?? 'collectible') === 'collectible';

// ---------------------------------------------------------------- a player's craft, in bytes

/**
 * The transaction a player sends to craft `recipe`, estimated (txsize.mjs): the craft's own accounts, then each
 * line's (craft.rs; a roll's box and order), a compute limit (a big recipe needs more
 * than the default) and, for each token it gives, the player's token account created if missing.
 */
export function craftSize(recipe, m, { detail = false } = {}) {
  const collectionOf = key => `collection:${m.item.get(key)?.collection ?? 'project'}`;
  const limited = limitsPlayers(recipe);
  const fixed = [
    'wallet:player',
    'pda:project',
    `pda:recipe/${recipe.key}`,
    'program:mpl-core',
    'program:token',
    'program:token-2022',
    'pda:platform',
    'pda:fees',
    'program:system',
    // Its optional slots (craft.rs: counts, link, profile), each an index when unused: a limit's counts, and for a
    // limit per person the wallet's link to them.
    limited ? (byPerson(recipe) ? 'pda:persons/player' : 'pda:counts/player') : 'program:loot',
    limited && byPerson(recipe) ? 'pda:link/player' : 'program:loot',
    'program:loot',
  ];
  const rest = [];
  const signers = ['wallet:player'];
  const extra = [{ program: 'compute-budget', accounts: [], data: 5 }];
  let asset = 0;
  const mintOf = key => `mint:${key ?? m.currencyKey}`;
  for (const line of recipe.in ?? []) {
    // An item line passes its item and its collection (craft.rs).
    if (line.takes === 'burn')
      rest.push(
        `pda:item/${line.item}`,
        `${collectionOf(line.item)}`,
        ...Array.from({ length: line.count ?? 1 }, () => `asset:${asset++}`),
      );
    else if (line.takes === 'use' || line.takes === 'renew')
      rest.push(`pda:item/${line.item}`, `${collectionOf(line.item)}`, `asset:${asset++}`);
    // A staked one: its seat and the farm its line names follow it.
    else if (line.takes === 'staked')
      rest.push(
        `pda:item/${line.item}`,
        `${collectionOf(line.item)}`,
        `asset:${asset}`,
        `pda:seat/${asset++}`,
        `pda:farm/${line.farm}`,
      );
    // The largest a shown NFT takes: a Token Metadata one's mint, metadata, token account and Sheet.
    else if (line.takes === 'show')
      rest.push(`asset:${asset}`, `metadata:${asset}`, `ata:player/${asset}`, `sheet:${asset++}`);
    // A trade-in: the NFT's every slot (`piece`, the largest a pNFT's), then where it goes.
    else if (line.takes === 'trade')
      rest.push(
        ...Array.from({ length: PIECE_SLOTS }, (_, k) => (k < 9 ? `trade:${asset}/${k}` : 'program:loot')),
        `to:${asset++}`,
      );
    else if (line.takes === 'pay') {
      rest.push(mintOf(line.currency), `ata:player/${line.currency ?? m.currencyKey}`);
      const d = destination(line.to);
      if (d.kind === 'pool') rest.push(`pda:pool/${d.key}`);
      if (d.kind === 'account') rest.push(`account:${d.key}`);
      if (d.kind === 'holder') rest.push(`asset:${d.key}`, `ata:holder/${d.key}`);
    }
  }
  const gives = new Set();
  // Each line's prize accounts (prize.rs): a collectible at its item's and serial's address (no signer), tokens'
  // mint, pool and the player's account, an NFT's stash and its piece, a roll's box and order.
  recipe.out?.forEach((line, i) => {
    // A compressed one: the tree's config, the tree, the collection, then Bubblegum's four programs and its signer.
    if (line.gives === 'item' && line.compressed)
      rest.push(
        `pda:item/${line.item}`,
        'pda:tree-config',
        'account:tree',
        `${collectionOf(line.item)}`,
        'program:bubblegum',
        'program:compression',
        'program:noop',
        'program:core',
        'account:bubblegum-signer',
      );
    else if (line.gives === 'item')
      rest.push(
        `pda:item/${line.item}`,
        ...(m.item.get(line.item)?.kind === 'normal'
          ? []
          : [`${collectionOf(line.item)}`, `pda:asset/${line.item}/${i}`, 'program:core']),
      );
    else if (line.gives === 'nft')
      rest.push(
        `pda:stash/${line.stash}`,
        ...Array.from({ length: PIECE_SLOTS }, (_, k) =>
          k === 0 ? `asset:nft/${i}` : k < 3 ? `nft/${i}/${k}` : 'program:loot',
        ),
      );
    // A roll (given, or on a kept collectible): the box and the order (its roll is asked for after, `ask_roll`).
    else if (line.gives === 'roll') rest.push(`pda:box/${line.box}`, `pda:order/${i}`);
    else {
      const currency = line.from?.startsWith('pool:')
        ? m.pool.get(line.from.slice(5))?.currency
        : (line.currency ?? m.currencyKey);
      const pool = line.from?.startsWith('pool:') ? line.from.slice(5) : null;
      rest.push(mintOf(currency), ...(pool ? [`pda:pool/${pool}`] : []), `ata:player/${currency}`);
      gives.add(currency);
    }
  });
  for (const currency of gives)
    extra.push({
      program: 'associated-token',
      accounts: [
        'wallet:player',
        `ata:player/${currency}`,
        'wallet:player',
        mintOf(currency),
        'program:system',
        'program:token',
      ],
      data: 1,
    });
  return measured(
    {
      signers,
      instructions: [...extra, { program: 'loot', accounts: [...fixed, ...rest], data: tagBytes('craft') + 4 + 8 + 8 }],
    },
    detail,
  );
}

// ---------------------------------------------------------------- a player's purchase of a box, in bytes

/** How many accounts `open_box`'s NFT slot (`piece`) takes, used or not. */
const PIECE_SLOTS = IDL.instructions.find(i => i.name === 'open_box').accounts.find(a => a.name === 'piece')
  .accounts.length;

/**
 * The transaction a player sends to open box `b`, estimated (txsize.mjs) as a wallet sends it: its compute limit and
 * price, the player's token account of the box's currency created if missing (and for SOL, the wrap around the
 * purchase), then `open_box` (order.rs): its own accounts (an NFT slot the program leaves empty stands in as the
 * program's address), an account for each outcome that wins something, each prize mint with the game's vault for it,
 * and the NFT the player shows for a gate or odds (at its largest, a Token Metadata one's mint, metadata, token
 * account and Sheet).
 */
export function openBoxSize(b, m, { detail = false } = {}) {
  const currency = b.currency ?? m.currencyKey;
  const mint = key => `mint:${key}`;
  const vault = key => `vault:${key}`;
  const none = 'program:loot';
  const outcomes = b.outcomes ?? [];
  // A limit per person counts on the person's record and reads the wallet's link to them; one per wallet, on its own.
  const limited = Boolean(b.perWallet || b.perWalletEach?.count || b.perPerson || b.perPersonEach?.count);
  const chosenItem = (b.split ?? []).some(s => /^chosen:./.test(String(s.to)));
  // The NFT it rolls on fills the `piece` slots: a Core collectible of the game's, else at its largest a pNFT's
  // accounts (its records and rule set when the roll can move it).
  const moves = outcomes.some(o => (o.then ?? b.then) && (o.then ?? b.then) !== 'back');
  const piece = !b.rollsOn
    ? [`pda:box/${b.key}`]
    : b.rollsOn.item
      ? ['asset:rolled', 'sheet:rolled', ...(moves ? ['pda:collection', 'program:mpl-core'] : [])]
      : [
          'asset:rolled',
          'sheet:rolled',
          'metadata:rolled',
          'ata:player/rolled',
          ...(moves
            ? [
                'edition:rolled',
                'record:player',
                'ata:game/rolled',
                'record:game',
                'rule-set',
                'program:auth-rules',
                'program:token-metadata',
                'sysvar:instructions',
              ]
            : []),
        ];
  const own = [
    `pda:box/${b.key}`,
    'wallet:player',
    'pda:project',
    'pda:platform',
    'pda:order',
    mint(currency),
    `ata:player/${currency}`,
    vault(currency),
    'program:token',
    'program:token-2022',
    'program:system',
    'program:associated-token',
    ...piece,
    ...Array.from({ length: PIECE_SLOTS - piece.length }, () => none),
    // Every open asks the oracle.
    'vrf:queue',
    'pda:identity',
    'program:vrf',
    'sysvar:slot-hashes',
    chosenItem ? 'asset:chosen' : none,
    limited ? (byPerson(b) ? 'pda:persons/player' : 'pda:counts/player') : none,
    limited && byPerson(b) ? 'pda:link/player' : none,
  ];
  const rest = [];
  const prizeMints = [];
  for (const o of outcomes.flatMap(outcomeParts)) {
    if (o.gives === 'item') rest.push(`pda:item/${o.item}`);
    if (o.gives === 'stash' || o.gives === 'nft') rest.push(`pda:stash/${o.stash}`);
    if (o.gives === 'pay' || o.gives === 'mint') {
      if (o.gives !== 'mint') rest.push(`pda:pool/${o.pool}`);
      const c = o.gives === 'mint' ? (o.currency ?? m.currencyKey) : m.pool.get(o.pool)?.currency;
      if (c && !prizeMints.includes(c)) prizeMints.push(c);
    }
  }
  for (const c of prizeMints) rest.push(mint(c), vault(c));
  rest.push(...listProof(b.gate));
  if (!b.rollsOn && (showsNft(b.gate) || b.odds?.length))
    rest.push('asset:shown', 'metadata:shown', 'ata:player/shown', 'sheet:shown');
  const ata = `ata:player/${currency}`;
  const wallet = [
    { program: 'compute-budget', accounts: [], data: 5 },
    { program: 'compute-budget', accounts: [], data: 9 },
  ];
  const create = {
    program: 'associated-token',
    accounts: ['wallet:player', ata, 'wallet:player', mint(currency), 'program:system', 'program:token'],
    data: 1,
  };
  const wrap = m.tokens.get(currency)?.wsol
    ? [
        { program: 'system', accounts: ['wallet:player', ata], data: 12 },
        { program: 'token', accounts: [ata], data: 1 },
      ]
    : [];
  const unwrap = wrap.length ? [{ program: 'token', accounts: [ata, 'wallet:player', 'wallet:player'], data: 1 }] : [];
  const data =
    tagBytes('open_box') + 8 + 8 + (chosenItem || (b.split ?? []).some(s => s.to === 'chosen') ? 33 : 1) + 4 + 4;
  return measured(
    {
      signers: ['wallet:player'],
      instructions: [...wallet, create, ...wrap, { program: 'loot', accounts: [...own, ...rest], data }, ...unwrap],
    },
    detail,
  );
}

/** The longest proof a compressed NFT's tree can leave: Bubblegum v2 refuses a smaller canopy. */
export const LONGEST_PROOF = 17;
/** How many accounts a transaction may lock: so the most a settle can name. */
export const ACCOUNT_LOCKS = 64;
/** A v0 transaction's lookup table and the lookup-table program: the transaction deactivates the table it loads from. */
export const TABLE_LOCKS = 2;
/** More accounts than this never fit a legacy transaction (32 bytes each): such a transaction goes as v0. */
export const LEGACY_MOST_ACCOUNTS = 35;

/**
 * The accounts a settle of box `b` locks for outcome `o`, counted as the client builds it (`settleIx`, sent by anyone
 * after a Compute Budget instruction, in a v0 transaction with a lookup table, the Sheets of NFTs it doesn't write left
 * out), at its largest: { count, memo, picks, corePicks, payees, compressedSubject }. `memo`: a payee the project
 * didn't pick (a holder's share, a buyer's chosen wallet, a wallet's) can turn on required memos for their own
 * Token-2022 account at any time, and every settle then passes the memo program, one account more.
 * Matches the program's own measurements: a roll on a compressed NFT of a 17-node
 * proof is 41 with nothing won; each prize of tokens in a mint of its own 3, each holder's share 3, a hook asking
 * one account of its own 3, a compressed NFT picked from a stash 22, a Core one of its own collection 2 (Core 1).
 */
export function settleAccounts(b, o, m, { proof = LONGEST_PROOF } = {}) {
  const currency = b.currency ?? m.currencyKey;
  const tok = m.tokens.get(currency);
  const keys = new Set([
    'program:compute-budget',
    'program:loot',
    'wallet:signer',
    'pda:order',
    'wallet:player',
    'pda:project',
    `mint:${currency}`,
    `vault:${currency}`,
    'wallet:treasury',
    `ata:treasury/${currency}`,
    'program:token',
    'program:token-2022',
    'pda:fees',
    'program:system',
    'program:associated-token',
  ]);
  const add = (...list) => list.forEach(k => keys.add(k));
  const bubblegum = () => add('program:bubblegum', 'program:compression', 'program:noop');
  const compressed = id => {
    add(
      `asset:${id}`,
      `collection:${id}`,
      `leaf:${id}`,
      `tree:${id}`,
      `tree-config:${id}`,
      ...Array.from({ length: proof }, (_, i) => `proof:${id}/${i}`),
    );
    bubblegum();
  };
  // The NFT it rolls on: one of a collection not the game's own may be compressed (a Bubblegum v2 NFT is in a Core
  // collection), and its proof comes with it; the game's own is a Core asset. Its Sheet only when the roll moves a
  // number on it.
  const then = o.then ?? b.then;
  const compressedSubject = Boolean(b.rollsOn?.collection);
  if (b.rollsOn) {
    if (compressedSubject) compressed('subject');
    else add('asset:subject', `collection:${m.item.get(b.rollsOn.item)?.collection ?? 'project'}`, 'program:mpl-core');
    if (o.shifts?.length) add('sheet:subject');
    if (then && then !== 'back') add(then === 'treasury' ? 'wallet:treasury' : 'receiver');
  }
  // What it won, in order (`wonAccounts`).
  let picks = 0;
  let corePicks = 0;
  for (const [i, x] of outcomeParts(o).entries()) {
    if (x.gives === 'pay' || x.gives === 'mint') {
      const c = x.gives === 'mint' ? (x.currency ?? m.currencyKey) : m.pool.get(x.pool)?.currency;
      add(`mint:${c}`, `vault:${c}`, `ata:player/${c}`);
    } else if (x.gives === 'item') {
      const it = m.item.get(x.item);
      add(`pda:item/${x.item}`);
      if (isCollectible(it)) add(`asset:item/${i}`, `collection:${it?.collection ?? 'project'}`, 'program:mpl-core');
    } else if (x.gives === 'roll') {
      add(`pda:box/${x.box}`, `pda:order/roll${i}`);
    } else if (x.gives === 'stash' || x.gives === 'nft') {
      picks++;
      const s = m.stash.get(x.stash);
      const nfts = s ? stashNfts(s) : [];
      const named = x.gives === 'nft' ? nfts.filter(n => n.asset === x.nft) : nfts;
      // A random pick may be any of the stash's: counted as its largest kind.
      const id = `pick${i}`;
      if (named.some(n => n.kind === 'compressed')) compressed(id);
      else if (named.some(n => n.kind === 'token-metadata')) {
        add(
          `mint:${id}`,
          `metadata:${id}`,
          `edition:${id}`,
          `ata:player/${id}`,
          `ata:project/${id}`,
          'program:token-metadata',
          'sysvar:instructions',
        );
        if (named.some(n => n.programmable))
          add(`record:player/${id}`, `record:project/${id}`, `rule-set:${id}`, 'program:auth-rules');
      } else {
        corePicks++;
        const collections = new Set(named.map(n => n.collection ?? 'project'));
        add(`asset:${id}`, `collection:${collections.size === 1 ? [...collections][0] : id}`, 'program:mpl-core');
      }
    }
  }
  // The accounts the shares name (`destinationAccounts`): a holder's asset, wallet and token account; a wallet and its
  // token account; a pool or an account; the treasury's are the settle's own.
  let payees = 0;
  for (const [j, s] of sharesOf(b.split).entries()) {
    if (s.kind === 'holder' || s.kind === 'chosen') add(`asset:payee${j}`, `wallet:payee${j}`, `ata:payee${j}`);
    else if (s.kind === 'wallet') add(`wallet:${s.key}`, `ata:${s.key}/${currency}`);
    else if (s.kind === 'pool') add(`pda:pool/${s.key}`);
    else if (s.kind === 'account' || s.kind === 'lottery') add(`account:${s.kind}/${s.key}`);
    if (['holder', 'chosen', 'wallet'].includes(s.kind)) payees++;
  }
  // A transfer hook's own accounts: its program, its list of extra accounts and (as measured) one of its own.
  if (tok?.powers?.transferHook) add('program:hook', 'hook:validation', 'hook:extra');
  const token2022 =
    tok?.program === 'token-2022' ||
    Boolean(
      tok?.powers?.transferHook ||
      tok?.powers?.transferFeePercent ||
      tok?.powers?.permanentDelegate ||
      tok?.powers?.pausable ||
      tok?.powers?.defaultState,
    );
  return {
    count: keys.size,
    keys: [...keys],
    memo: token2022 && payees > 0,
    picks,
    corePicks,
    payees,
    compressedSubject,
  };
}

/** The compute a transaction may have: no settle can take more. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * The compute a settle of box `b`'s outcome `o` takes, estimated at its most from measurements on devnet's
 * features: about 60,000 units for the settle itself, 250,000 for each Token Metadata
 * NFT it moves (a pNFT's, with its rule set), 100,000 for a compressed one (or the NFT it rolls on, of a collection
 * not the game's own), 60,000 for a Core one, 40,000 for each collectible it mints and 20,000 for a roll it makes, and
 * 30,000 for each token payout (a prize, each share of the price, the treasury's), twice that in a coin with a
 * transfer hook. Three pNFTs of stashes, the NFT rolled on and four holders' shares (measured 942,389 to 985,942)
 * come out at about 1,170,000.
 */
export function settleComputeUnits(b, o, m) {
  const hooked = c => (m.tokens.get(c)?.powers?.transferHook ? 2 : 1);
  const currency = b.currency ?? m.currencyKey;
  let units = 60_000;
  if (b.rollsOn) units += b.rollsOn.collection ? 100_000 : 60_000;
  for (const x of outcomeParts(o)) {
    if (x.gives === 'pay' || x.gives === 'mint')
      units += 30_000 * hooked(x.gives === 'mint' ? (x.currency ?? m.currencyKey) : m.pool.get(x.pool)?.currency);
    else if (x.gives === 'item') units += isCollectible(m.item.get(x.item)) ? 40_000 : 0;
    else if (x.gives === 'roll') units += 20_000;
    else if (x.gives === 'stash' || x.gives === 'nft') {
      const nfts = m.stash.get(x.stash) ? stashNfts(m.stash.get(x.stash)) : [];
      const named = x.gives === 'nft' ? nfts.filter(n => n.asset === x.nft) : nfts;
      units += named.some(n => n.kind === 'token-metadata')
        ? 250_000
        : named.some(n => n.kind === 'compressed')
          ? 100_000
          : 60_000;
    }
  }
  return units + 30_000 * hooked(currency) * (sharesOf(b.split).length + 1);
}

/**
 * The settle of box `b`'s outcome `o` as xsolana's senders build it (js/play, the keeper's sweep: `settleIx` after a
 * compute limit, and a heap frame for three NFT moves or more), estimated (txsize.mjs) at its largest:
 * { legacy: its bytes as a legacy transaction, tableRent: the lamports a lookup table of its accounts holds while it
 * is open, locks: the accounts it locks (`settleAccounts`) }. A settle bigger than a legacy transaction goes as v0,
 * its accounts loaded from a table its sender makes first.
 */
export function settleSize(b, o, m) {
  const { keys, count, memo, compressedSubject } = settleAccounts(b, o, m);
  const parts = outcomeParts(o);
  const moves = parts.filter(x => x.gives === 'stash' || x.gives === 'nft').length + (b.rollsOn ? 1 : 0);
  // The settle's account list, with each slot it leaves empty (`settleIx`): its own 38, the proof of a compressed NFT
  // it rolls on, each prize's (tokens 3, a collectible 4, a normal item 1, a roll 2, an NFT the 23 of a piece and a
  // compressed one's proof), each share's (a holder's 3, a wallet's 2, a pool's or an account's 1), a hook's and a memo.
  const compressedPick = x =>
    (m.stash.get(x.stash) ? stashNfts(m.stash.get(x.stash)) : [])
      .filter(n => x.gives !== 'nft' || n.asset === x.nft)
      .some(n => n.kind === 'compressed');
  const won = parts.reduce(
    (n, x) =>
      n +
      ({
        pay: 3,
        share: 3,
        mint: 3,
        item: isCollectible(m.item.get(x.item)) ? 4 : 1,
        roll: 2,
        stash: PIECE_SLOTS,
        nft: PIECE_SLOTS,
      }[x.gives] ?? 0) +
      ((x.gives === 'stash' || x.gives === 'nft') && compressedPick(x) ? LONGEST_PROOF : 0),
    0,
  );
  const split = sharesOf(b.split).reduce(
    (n, x) => n + ({ holder: 3, chosen: 3, wallet: 2, pool: 1, account: 1, lottery: 1 }[x.kind] ?? 0),
    0,
  );
  const hooks = keys.filter(k => k.startsWith('hook:') || k === 'program:hook').length;
  const entries = 38 + (compressedSubject ? LONGEST_PROOF : 0) + won + split + hooks + (memo ? 1 : 0);
  const named = keys.filter(k => k !== 'program:compute-budget' && k !== 'program:loot');
  // Its data: the tag, `upto` and `prize_accounts`.
  const settle = {
    program: 'loot',
    accounts: [...named, ...Array.from({ length: Math.max(0, entries - named.length) }, () => 'program:loot')],
    data: tagBytes('settle') + 4 + 2,
  };
  const budget = [
    { program: 'compute-budget', accounts: [], data: 5 },
    ...(moves >= 3 ? [{ program: 'compute-budget', accounts: [], data: 5 }] : []),
  ];
  // A table holds every account but the signer and the programs the transaction calls.
  const held = keys.filter(k => !['wallet:signer', 'program:compute-budget', 'program:loot'].includes(k)).length;
  return {
    legacy: estimateTransactionSize({ signers: ['wallet:signer'], instructions: [...budget, settle] }),
    tableRent: rentOf(56 + 32 * held),
    locks: count,
  };
}

/** What a player passes ahead of an NFT shown: a list gate's proof, one account a level (`gateList`), or a stake gate's seat. */
const listProof = gate =>
  gate?.list
    ? Array.from({ length: gateList(gate.list).depth }, (_, i) => `proof:${i}`)
    : gate?.staked
      ? [`seat:${gate.staked.farm}`, `pda:farm/${gate.staked.farm}`]
      : [];
/** Whether a gate asks the player to show an NFT (a rule), not a list, a few wallets or a stake. */
const showsNft = gate => Boolean(gate && !gate.wallets && !gate.list && !gate.staked);

/**
 * The transaction a player sends to buy box `b` (buy.rs), estimated as `openBoxSize` is: its compute limit and price,
 * the player's token account of the currency created if missing, then `buy`: its own accounts, what the gate takes
 * (a list's proof, or the NFT shown), the accounts its shares name, and each prize's (prize.rs; a roll's box and
 * order), for each draw of a sale (a fixed amount of tokens once). `count`: the sales in one purchase.
 */
export function buySize(b, m, { detail = false, count = 1 } = {}) {
  const collectionOf = key => `collection:${m.item.get(key)?.collection ?? 'project'}`;
  const currency = b.currency ?? m.currencyKey;
  const none = 'program:loot';
  // A limit per person counts on the person's record and reads the wallet's link to them; one per wallet, on its own.
  const limited = Boolean(b.perWallet || b.perWalletEach?.count || b.perPerson || b.perPersonEach?.count);
  const chosenItem = (b.split ?? []).some(s => /^chosen:./.test(String(s.to)));
  const own = [
    'wallet:player',
    'pda:project',
    `pda:box/${b.key}`,
    `mint:${currency}`,
    `ata:player/${currency}`,
    'wallet:treasury',
    `ata:treasury/${currency}`,
    'program:token',
    'program:token-2022',
    'program:associated-token',
    chosenItem ? 'asset:chosen' : none,
    limited ? (byPerson(b) ? 'pda:persons/player' : 'pda:counts/player') : none,
    limited && byPerson(b) ? 'pda:link/player' : none,
    'pda:platform',
    'pda:fees',
    'program:system',
  ];
  const rest = [...listProof(b.gate)];
  if (showsNft(b.gate)) rest.push('asset:shown', 'metadata:shown', 'ata:player/shown', 'sheet:shown');
  for (const s of sharesOf(b.split)) {
    if (s.kind === 'pool') rest.push(`pda:pool/${s.key}`);
    if (s.kind === 'account') rest.push(`account:${s.key}`);
    if (s.kind === 'wallet' || s.kind === 'treasury' || s.kind === 'chosen')
      rest.push(`wallet:${s.key}`, `ata:${s.key}/${currency}`);
    if (s.kind === 'holder') rest.push(`asset:${s.key}`, `wallet:holder/${s.key}`, `ata:holder/${s.key}`);
  }
  const draws = drawsOf(b) * count;
  outcomeParts(b.outcomes?.[0])
    .flatMap(o => Array(o.gives === 'mint' || o.gives === 'pay' ? 1 : draws).fill(o))
    .forEach((o, i) => {
      if (o.gives === 'item')
        rest.push(
          `pda:item/${o.item}`,
          ...(m.item.get(o.item)?.kind === 'normal'
            ? []
            : [collectionOf(o.item), `pda:asset/${o.item}/${i}`, 'program:mpl-core']),
        );
      else if (o.gives === 'nft')
        rest.push(
          `pda:stash/${o.stash}`,
          ...Array.from({ length: PIECE_SLOTS }, (_, k) =>
            k === 0 ? `asset:nft/${i}` : k < 3 ? `nft/${i}/${k}` : none,
          ),
        );
      else if (o.gives === 'roll') rest.push(`pda:box/${o.box}`, `pda:order/${i}`);
      else {
        const c = o.gives === 'mint' ? (o.currency ?? m.currencyKey) : m.pool.get(o.pool)?.currency;
        rest.push(`mint:${c}`, ...(o.gives === 'mint' ? [] : [`pda:pool/${o.pool}`]), `ata:player/${c}`);
      }
    });
  const ata = `ata:player/${currency}`;
  const wallet = [
    { program: 'compute-budget', accounts: [], data: 5 },
    { program: 'compute-budget', accounts: [], data: 9 },
  ];
  const create = {
    program: 'associated-token',
    accounts: ['wallet:player', ata, 'wallet:player', `mint:${currency}`, 'program:system', 'program:token'],
    data: 1,
  };
  const data = tagBytes('buy') + 8 + (chosenItem || (b.split ?? []).some(s => s.to === 'chosen') ? 33 : 1) + 4 + 8 + 4;
  return measured(
    {
      signers: ['wallet:player'],
      instructions: [...wallet, create, { program: 'loot', accounts: [...own, ...rest], data }],
    },
    detail,
  );
}
