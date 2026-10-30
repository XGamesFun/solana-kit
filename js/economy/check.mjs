// The economy checker. Refusals stop an economy from going live: each has a code, what it means for the owner and
// the fix. Warnings are what the owner should know before going live. Pure.
//
// Most refusals are the program's own (cited by the program's source file), caught here so the owner hears about
// them in words before a wallet is ever asked. The rest are traps the program's notes name: a farm that empties a
// lottery's pot, a pool nothing fills, a recipe too big to send, a prize its pool cannot pay.
import IDL from '../client/idl/loot.js';
import { gateList } from '../client/grant.js';
import { MAX_RECEIPT_ROUNDS } from '../client/sizes.js';
import { vault } from '../client/pda.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { isOnCurve } from '../chain/curve.js';
import { utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import {
  FEES,
  rent as rentOf,
  LIMITS,
  RESERVED_ATTRIBUTES,
  destination,
  fromUnits,
  isAddress,
  listOf,
  lotterySplit,
  model,
  placeOf,
  poolFillers,
  outcomeBurns,
  outcomeParts,
  boxBuys,
  boxRolls,
  prizeLine,
  prizePool,
  prizeToken,
  rollsOf,
  prizes,
  prizeWords,
  releaseSeconds,
  releaseWords,
  farmEndWords,
  stashNfts,
  poolTakers,
  sharesOf,
  toBps,
  toBy,
  toSeconds,
  toTime,
  toUnits,
  utf8Bytes,
  wholeCount,
} from './model.mjs';
// plan.mjs imports check() in turn: each module only calls the other's functions, never at load time.
import { placeholderContext, setupSteps, stepBytes } from './plan.mjs';
import { findSecrets } from './secrets.mjs';
import { simulate } from './simulate.mjs';
import { BUDGET, MAX_TRANSACTION_BYTES, transactionLocks, transactionSize, WALLET_ROOM } from './txsize.mjs';
import { validate } from './validate.mjs';

/** A transaction's estimated bytes, or with `detail` { bytes, locks }. */
const measured = (input, detail) => (detail ? { bytes: transactionSize(input), locks: transactionLocks(input) } : transactionSize(input));

const label = (part) => `“${part?.name ?? part?.key}”`;
const isCollectible = (it) => (it?.kind ?? 'collectible') === 'collectible';

// ---------------------------------------------------------------- a player's craft, in bytes

/**
 * The accounts a route the player pays or asks for (a craft, a buy, a grant's claim) passes after a roll's box and
 * order (`order::askable`, the client's `rollMints`): for each token prize of box `key`, in order, its pool and the
 * pool's mint, or the mint it mints from. Up to 10 distinct accounts a box.
 */
export function rollMintKeys(key, m) {
  return (m.box.get(key)?.outcomes ?? []).flatMap(outcomeParts).flatMap((o) => {
    if (o.gives === 'mint') return [`mint:${o.currency ?? m.currencyKey}`];
    if (o.gives === 'pay' || o.gives === 'share') return [`pda:pool/${o.pool}`, `mint:${m.pool.get(o.pool)?.currency ?? m.currencyKey}`];
    return [];
  });
}

/**
 * The transaction a player sends to craft `recipe`, estimated (txsize.mjs): the craft's own accounts, then each
 * line's (craft.rs; a roll's with its box's prize mints, `rollMintKeys`), a compute limit (a big recipe needs more
 * than the default) and, for each token it gives, the player's token account created if missing.
 */
export function craftSize(recipe, m, { detail = false } = {}) {
  const collectionOf = (key) => `collection:${m.item.get(key)?.collection ?? 'project'}`;
  const fixed = ['wallet:player', 'pda:project', `pda:recipe/${recipe.key}`, 'program:mpl-core', 'program:token', 'program:token-2022', 'pda:platform', 'pda:fees', 'program:system'];
  const rest = [];
  const signers = ['wallet:player'];
  const extra = [{ program: 'compute-budget', accounts: [], data: 5 }];
  let asset = 0;
  const mintOf = (key) => `mint:${key ?? m.currencyKey}`;
  for (const line of recipe.in ?? []) {
    // An item line passes its item and its collection (craft.rs).
    if (line.takes === 'burn') rest.push(`pda:item/${line.item}`, `${collectionOf(line.item)}`, ...Array.from({ length: line.count ?? 1 }, () => `asset:${asset++}`));
    else if (line.takes === 'use' || line.takes === 'renew') rest.push(`pda:item/${line.item}`, `${collectionOf(line.item)}`, `asset:${asset++}`);
    // A staked one: its seat and the farm its line names follow it.
    else if (line.takes === 'staked') rest.push(`pda:item/${line.item}`, `${collectionOf(line.item)}`, `asset:${asset}`, `pda:seat/${asset++}`, `pda:farm/${line.farm}`);
    // The largest a shown NFT takes: a Token Metadata one's mint, metadata, token account and Sheet.
    else if (line.takes === 'show') rest.push(`asset:${asset}`, `metadata:${asset}`, `ata:player/${asset}`, `sheet:${asset++}`);
    // A trade-in: the NFT's every slot (`piece`, the largest a pNFT's), then where it goes.
    else if (line.takes === 'trade') rest.push(...Array.from({ length: PIECE_SLOTS }, (_, k) => (k < 9 ? `trade:${asset}/${k}` : 'program:loot')), `to:${asset++}`);
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
    if (line.gives === 'item' && line.compressed) rest.push(`pda:item/${line.item}`, 'pda:tree-config', 'account:tree', `${collectionOf(line.item)}`, 'program:bubblegum', 'program:compression', 'program:noop', 'program:core', 'account:bubblegum-signer');
    else if (line.gives === 'item') rest.push(`pda:item/${line.item}`, ...(m.item.get(line.item)?.kind === 'normal' ? [] : [`${collectionOf(line.item)}`, `pda:asset/${line.item}/${i}`, 'program:core']));
    else if (line.gives === 'nft') rest.push(`pda:stash/${line.stash}`, ...Array.from({ length: PIECE_SLOTS }, (_, k) => (k === 0 ? `asset:nft/${i}` : k < 3 ? `nft/${i}/${k}` : 'program:loot')));
    // A roll (given, or on a kept collectible): the box, the order, then the box's prize mints (`rollMintKeys`).
    else if (line.gives === 'roll') rest.push(`pda:box/${line.box}`, `pda:order/${i}`, ...rollMintKeys(line.box, m));
    else {
      const currency = line.gives === 'share' ? m.pool.get(line.pool)?.currency : line.from?.startsWith('pool:') ? m.pool.get(line.from.slice(5))?.currency : line.currency ?? m.currencyKey;
      const pool = line.gives === 'share' ? line.pool : line.from?.startsWith('pool:') ? line.from.slice(5) : null;
      rest.push(mintOf(currency), ...(pool ? [`pda:pool/${pool}`] : []), `ata:player/${currency}`);
      gives.add(currency);
    }
  });
  for (const currency of gives) extra.push({ program: 'associated-token', accounts: ['wallet:player', `ata:player/${currency}`, 'wallet:player', mintOf(currency), 'program:system', 'program:token'], data: 1 });
  return measured({ signers, instructions: [...extra, { program: 'loot', accounts: [...fixed, ...rest], data: 8 + 4 + 8 }] }, detail);
}

// ---------------------------------------------------------------- a player's purchase of a box, in bytes

/** How many accounts `open_box`'s NFT slot (`piece`) takes, used or not. */
const PIECE_SLOTS = IDL.instructions.find((i) => i.name === 'open_box').accounts.find((a) => a.name === 'piece').accounts.length;

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
  const mint = (key) => `mint:${key}`;
  const vault = (key) => `vault:${key}`;
  const none = 'program:loot';
  const outcomes = b.outcomes ?? [];
  // A stash's NFT is picked at random: a box of one stash outcome is rolled too.
  const rolls = boxRolls(b);
  const limited = Boolean(b.perWallet || b.perWalletEach?.count);
  const chosenItem = (b.split ?? []).some((s) => /^chosen:./.test(String(s.to)));
  // The NFT it rolls on fills the `piece` slots: a Core collectible of the game's, else at its largest a pNFT's
  // accounts (its records and rule set when the roll can move it).
  const moves = outcomes.some((o) => (o.then ?? b.then) && (o.then ?? b.then) !== 'back');
  const piece = !b.rollsOn
    ? [`pda:box/${b.key}`]
    : b.rollsOn.item
      ? ['asset:rolled', 'sheet:rolled', ...(moves ? ['pda:collection', 'program:mpl-core'] : [])]
      : ['asset:rolled', 'sheet:rolled', 'metadata:rolled', 'ata:player/rolled', ...(moves ? ['edition:rolled', 'record:player', 'ata:game/rolled', 'record:game', 'rule-set', 'program:auth-rules', 'program:token-metadata', 'sysvar:instructions'] : [])];
  const own = [
    `pda:box/${b.key}`,
    'wallet:player', 'pda:project', 'pda:platform', 'pda:order', mint(currency), `ata:player/${currency}`, vault(currency),
    'program:token', 'program:token-2022', 'program:system', 'program:associated-token',
    ...piece, ...Array.from({ length: PIECE_SLOTS - piece.length }, () => none),
    ...(rolls ? ['vrf:queue', 'pda:identity', 'program:vrf', 'sysvar:slot-hashes'] : [none, none, none, none]),
    chosenItem ? 'asset:chosen' : none,
    limited ? `pda:receipt/${b.key}` : none,
  ];
  const rest = [];
  const prizeMints = [];
  for (const o of outcomes.flatMap(outcomeParts)) {
    if (o.gives === 'item') rest.push(`pda:item/${o.item}`);
    if (o.gives === 'stash' || o.gives === 'nft') rest.push(`pda:stash/${o.stash}`);
    if (o.gives === 'pay' || o.gives === 'share' || o.gives === 'mint') {
      if (o.gives !== 'mint') rest.push(`pda:pool/${o.pool}`);
      const c = o.gives === 'mint' ? o.currency ?? m.currencyKey : m.pool.get(o.pool)?.currency;
      if (c && !prizeMints.includes(c)) prizeMints.push(c);
    }
  }
  for (const c of prizeMints) rest.push(mint(c), vault(c));
  rest.push(...listProof(b.gate));
  if (!b.rollsOn && ((showsNft(b.gate)) || b.odds?.length)) rest.push('asset:shown', 'metadata:shown', 'ata:player/shown', 'sheet:shown');
  const ata = `ata:player/${currency}`;
  const wallet = [{ program: 'compute-budget', accounts: [], data: 5 }, { program: 'compute-budget', accounts: [], data: 9 }];
  const create = { program: 'associated-token', accounts: ['wallet:player', ata, 'wallet:player', mint(currency), 'program:system', 'program:token'], data: 1 };
  const wrap = m.tokens.get(currency)?.wsol
    ? [{ program: 'system', accounts: ['wallet:player', ata], data: 12 }, { program: 'token', accounts: [ata], data: 1 }]
    : [];
  const unwrap = wrap.length ? [{ program: 'token', accounts: [ata, 'wallet:player', 'wallet:player'], data: 1 }] : [];
  const data = 8 + 8 + 8 + (chosenItem || (b.split ?? []).some((s) => s.to === 'chosen') ? 33 : 1) + 4;
  return measured({ signers: ['wallet:player'], instructions: [...wallet, create, ...wrap, { program: 'loot', accounts: [...own, ...rest], data }, ...unwrap] }, detail);
}

/** The longest proof a compressed NFT's tree can leave: Bubblegum v2 refuses a smaller canopy. */
export const LONGEST_PROOF = 17;
/** How many accounts a transaction may lock: so the most a settle can name. */
export const ACCOUNT_LOCKS = 64;
/** A v0 transaction's lookup table and the lookup-table program: the transaction deactivates the table it loads from. */
export const TABLE_LOCKS = 2;
/** More accounts than this never fit a legacy transaction (32 bytes each): such a transaction goes as v0. */
const LEGACY_MOST_ACCOUNTS = 35;

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
    'program:compute-budget', 'program:loot', 'wallet:signer', 'pda:order', 'wallet:player', 'pda:project', `mint:${currency}`, `vault:${currency}`,
    'wallet:treasury', `ata:treasury/${currency}`, 'program:token', 'program:token-2022', 'pda:fees', 'program:system', 'program:associated-token',
  ]);
  const add = (...list) => list.forEach((k) => keys.add(k));
  const bubblegum = () => add('program:bubblegum', 'program:compression', 'program:noop');
  const compressed = (id) => {
    add(`asset:${id}`, `collection:${id}`, `leaf:${id}`, `tree:${id}`, `tree-config:${id}`, ...Array.from({ length: proof }, (_, i) => `proof:${id}/${i}`));
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
    if (x.gives === 'pay' || x.gives === 'share' || x.gives === 'mint') {
      const c = x.gives === 'mint' ? x.currency ?? m.currencyKey : m.pool.get(x.pool)?.currency;
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
      const named = x.gives === 'nft' ? nfts.filter((n) => n.asset === x.nft) : nfts;
      // A random pick may be any of the stash's: counted as its largest kind.
      const id = `pick${i}`;
      if (named.some((n) => n.kind === 'compressed')) compressed(id);
      else if (named.some((n) => n.kind === 'token-metadata')) {
        add(`mint:${id}`, `metadata:${id}`, `edition:${id}`, `ata:player/${id}`, `ata:project/${id}`, 'program:token-metadata', 'sysvar:instructions');
        if (named.some((n) => n.programmable)) add(`record:player/${id}`, `record:project/${id}`, `rule-set:${id}`, 'program:auth-rules');
      } else {
        corePicks++;
        const collections = new Set(named.map((n) => n.collection ?? 'project'));
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
  const token2022 = tok?.program === 'token-2022' || Boolean(tok?.powers?.transferHook || tok?.powers?.transferFeePercent || tok?.powers?.permanentDelegate || tok?.powers?.pausable || tok?.powers?.defaultState);
  return { count: keys.size, keys: [...keys], memo: token2022 && payees > 0, picks, corePicks, payees, compressedSubject };
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
export function settleUnits(b, o, m) {
  const hooked = (c) => (m.tokens.get(c)?.powers?.transferHook ? 2 : 1);
  const currency = b.currency ?? m.currencyKey;
  let units = 60_000;
  if (b.rollsOn) units += b.rollsOn.collection ? 100_000 : 60_000;
  for (const x of outcomeParts(o)) {
    if (x.gives === 'pay' || x.gives === 'share' || x.gives === 'mint') units += 30_000 * hooked(x.gives === 'mint' ? x.currency ?? m.currencyKey : m.pool.get(x.pool)?.currency);
    else if (x.gives === 'item') units += isCollectible(m.item.get(x.item)) ? 40_000 : 0;
    else if (x.gives === 'roll') units += 20_000;
    else if (x.gives === 'stash' || x.gives === 'nft') {
      const nfts = m.stash.get(x.stash) ? stashNfts(m.stash.get(x.stash)) : [];
      const named = x.gives === 'nft' ? nfts.filter((n) => n.asset === x.nft) : nfts;
      units += named.some((n) => n.kind === 'token-metadata') ? 250_000 : named.some((n) => n.kind === 'compressed') ? 100_000 : 60_000;
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
  const moves = parts.filter((x) => x.gives === 'stash' || x.gives === 'nft').length + (b.rollsOn ? 1 : 0);
  // The settle's account list, with each slot it leaves empty (`settleIx`): its own 37, the proof of a compressed NFT
  // it rolls on, each prize's (tokens 3, a collectible 4, a normal item 1, a roll 2, an NFT the 23 of a piece and a
  // compressed one's proof), each share's (a holder's 3, a wallet's 2, a pool's or an account's 1), a hook's and a memo.
  const compressedPick = (x) => (m.stash.get(x.stash) ? stashNfts(m.stash.get(x.stash)) : []).filter((n) => x.gives !== 'nft' || n.asset === x.nft).some((n) => n.kind === 'compressed');
  const won = parts.reduce((n, x) => n + ({ pay: 3, share: 3, mint: 3, item: isCollectible(m.item.get(x.item)) ? 4 : 1, roll: 2, stash: PIECE_SLOTS, nft: PIECE_SLOTS }[x.gives] ?? 0) + ((x.gives === 'stash' || x.gives === 'nft') && compressedPick(x) ? LONGEST_PROOF : 0), 0);
  const split = sharesOf(b.split).reduce((n, x) => n + ({ holder: 3, chosen: 3, wallet: 2, pool: 1, account: 1, lottery: 1 }[x.kind] ?? 0), 0);
  const hooks = keys.filter((k) => k.startsWith('hook:') || k === 'program:hook').length;
  const entries = 37 + (compressedSubject ? LONGEST_PROOF : 0) + won + split + hooks + (memo ? 1 : 0);
  const named = keys.filter((k) => k !== 'program:compute-budget' && k !== 'program:loot');
  const settle = { program: 'loot', accounts: [...named, ...Array.from({ length: Math.max(0, entries - named.length) }, () => 'program:loot')], data: 8 };
  const budget = [{ program: 'compute-budget', accounts: [], data: 5 }, ...(moves >= 3 ? [{ program: 'compute-budget', accounts: [], data: 5 }] : [])];
  // A table holds every account but the signer and the programs the transaction calls.
  const held = keys.filter((k) => !['wallet:signer', 'program:compute-budget', 'program:loot'].includes(k)).length;
  return { legacy: transactionSize({ signers: ['wallet:signer'], instructions: [...budget, settle] }), tableRent: rentOf(56 + 32 * held), locks: count };
}

/** What a player passes ahead of an NFT shown: a list gate's proof, one account a level (`gateList`), or a stake gate's seat. */
const listProof = (gate) => (gate?.list ? Array.from({ length: gateList(gate.list).depth }, (_, i) => `proof:${i}`) : gate?.staked ? [`seat:${gate.staked.farm}`, `pda:farm/${gate.staked.farm}`] : []);
/** Whether a gate asks the player to show an NFT (a rule), not a list, a few wallets or a stake. */
const showsNft = (gate) => Boolean(gate && !gate.wallets && !gate.list && !gate.staked);

/**
 * The transaction a player sends to buy box `b` (buy.rs), estimated as `openBoxSize` is: its compute limit and price,
 * the player's token account of the currency created if missing, then `buy`: its own accounts, what the gate takes
 * (a list's proof, or the NFT shown), the accounts its shares name, and each prize's (prize.rs; a roll's with its
 * box's prize mints, `rollMintKeys`).
 */
export function buySize(b, m, { detail = false } = {}) {
  const collectionOf = (key) => `collection:${m.item.get(key)?.collection ?? 'project'}`;
  const currency = b.currency ?? m.currencyKey;
  const none = 'program:loot';
  const limited = Boolean(b.perWallet || b.perWalletEach?.count);
  const chosenItem = (b.split ?? []).some((s) => /^chosen:./.test(String(s.to)));
  const own = [
    'wallet:player', 'pda:project', `pda:box/${b.key}`, `mint:${currency}`, `ata:player/${currency}`, 'wallet:treasury', `ata:treasury/${currency}`,
    'program:token', 'program:token-2022', 'program:associated-token', chosenItem ? 'asset:chosen' : none, limited ? `pda:receipt/${b.key}` : none,
    'pda:platform', 'pda:fees', 'program:system',
  ];
  const rest = [...listProof(b.gate)];
  if (showsNft(b.gate)) rest.push('asset:shown', 'metadata:shown', 'ata:player/shown', 'sheet:shown');
  for (const s of sharesOf(b.split)) {
    if (s.kind === 'pool') rest.push(`pda:pool/${s.key}`);
    if (s.kind === 'account') rest.push(`account:${s.key}`);
    if (s.kind === 'wallet' || s.kind === 'treasury' || s.kind === 'chosen') rest.push(`wallet:${s.key}`, `ata:${s.key}/${currency}`);
    if (s.kind === 'holder') rest.push(`asset:${s.key}`, `wallet:holder/${s.key}`, `ata:holder/${s.key}`);
  }
  outcomeParts(b.outcomes?.[0]).forEach((o, i) => {
    if (o.gives === 'item') rest.push(`pda:item/${o.item}`, ...(m.item.get(o.item)?.kind === 'normal' ? [] : [collectionOf(o.item), `pda:asset/${o.item}/${i}`, 'program:mpl-core']));
    else if (o.gives === 'nft') rest.push(`pda:stash/${o.stash}`, ...Array.from({ length: PIECE_SLOTS }, (_, k) => (k === 0 ? `asset:nft/${i}` : k < 3 ? `nft/${i}/${k}` : none)));
    else if (o.gives === 'roll') rest.push(`pda:box/${o.box}`, `pda:order/${i}`, ...rollMintKeys(o.box, m));
    else {
      const c = o.gives === 'mint' ? o.currency ?? m.currencyKey : m.pool.get(o.pool)?.currency;
      rest.push(`mint:${c}`, ...(o.gives === 'mint' ? [] : [`pda:pool/${o.pool}`]), `ata:player/${c}`);
    }
  });
  const ata = `ata:player/${currency}`;
  const wallet = [{ program: 'compute-budget', accounts: [], data: 5 }, { program: 'compute-budget', accounts: [], data: 9 }];
  const create = { program: 'associated-token', accounts: ['wallet:player', ata, 'wallet:player', `mint:${currency}`, 'program:system', 'program:token'], data: 1 };
  const data = 8 + 8 + (chosenItem || (b.split ?? []).some((s) => s.to === 'chosen') ? 33 : 1) + 4 + 8;
  return measured({ signers: ['wallet:player'], instructions: [...wallet, create, { program: 'loot', accounts: [...own, ...rest], data }] }, detail);
}

// ---------------------------------------------------------------- the checker

/** The address a plan stands in for the owner's wallet before one connects (plan.mjs `placeholderContext`). Nobody
 * holds its key, and the approval page calls it "your wallet" until a wallet connects: no spec may name it. */
export const STAND_IN_OWNER = encodeBase58(sha256(utf8('loot-plan:owner')));

/** The longest a contest's result or a lottery's draw may be off, or an auction's end (contest.rs, lottery.rs, auction.rs). */
const MAX_CONTEST_SECONDS = Number(IDL.constants.find((c) => c.name === 'MAX_CONTEST_SECONDS')?.value ?? 157_680_000);
/** A sealed schedule's last run comes within this of going live (schedule.rs). */
const MAX_SCHEDULE_SECONDS = Number(IDL.constants.find((c) => c.name === 'MAX_SCHEDULE_SECONDS')?.value ?? 315_360_000);
/** The most runs a sealed schedule makes (schedule.rs). */
const MAX_SEALED_RUNS = Number(IDL.constants.find((c) => c.name === 'MAX_SEALED_RUNS')?.value ?? 10_000);

/**
 * Checks an economy spec. `now` (Unix seconds) dates "publish".
 * Returns { ok, refusals: [{ code, where, message, fix }], warnings: [{ code, where, message, fix? }] }.
 */
export function check(economy, { network = 'devnet', now = Math.floor(Date.now() / 1000) } = {}) {
  const refusals = [];
  const warnings = [];
  const refuse = (code, where, message, fix) => refusals.push({ code, where, message, fix });
  const warn = (code, where, message, fix) => warnings.push({ code, where, message, ...(fix ? { fix } : {}) });
  const result = () => ({ ok: refusals.length === 0, refusals, warnings });

  for (const where of findSecrets(economy))
    refuse('E-SECRET', where, 'This looks like a private key, a seed phrase or a keypair file. Anything in the economy is public: whoever reads it could take the wallet.', 'Delete it now and move the funds of that wallet to a new one. A spec only ever holds public addresses.');
  if (JSON.stringify(economy ?? null, (_, v) => (typeof v === 'bigint' ? String(v) : v)).includes(STAND_IN_OWNER))
    refuse('E-STAND-IN', 'economy', `The economy names ${STAND_IN_OWNER}, the address the setup plan stands in for your wallet before one connects. Nobody holds its key: whatever is sent there is lost.`, 'Name a real wallet there.');
  if (network !== 'devnet' || (economy?.network && economy.network !== 'devnet'))
    refuse('E-NETWORK', 'economy.network', `The economy names the network “${economy?.network ?? network}”. loot runs on devnet only: mainnet waits for an audit.`, 'Set the network to "devnet".');
  const oldVersion = economy?.version === 1;
  if (oldVersion) refuse('E-VERSION', 'economy.version', 'Only the current version 2 economy format is supported.', 'Write the economy using the current schema.');
  // An old version is said once, by E-VERSION, not again by the schema.
  for (const e of validate(economy)) if (!(oldVersion && e.path === 'economy.version')) refuse('E-SCHEMA', e.path, `${e.path} ${e.message}.`, 'Fix that field (xsolana_guide lists what each part takes).');
  if (refusals.length) return result();

  const m = model(economy, { now });
  const units = (amount, token, where, what = 'This amount') => {
    if (!token) return null;
    try {
      return toUnits(amount ?? 0, token.decimals ?? 0);
    } catch (err) {
      refuse(err.code ?? 'E-AMOUNT', where, `${what}: ${err.message}`, err.fix ?? 'Fix the amount.');
      return null;
    }
  };
  const seconds = (duration, where) => {
    try {
      return toSeconds(duration);
    } catch (err) {
      refuse(err.code, where, err.message, err.fix);
      return 0;
    }
  };
  /**
   * A duration the program keeps in 4 bytes (a lock, an unbonding, a collectible's life, a fall's step, a wallet's
   * window, a raise or a shift): its seconds, refused in words past what fits. A signed one (a raise's or a shift's
   * `by`, which may be "-1d") holds half as much each way.
   */
  const fourByteSeconds = (duration, where, { signed = false } = {}) => {
    if (duration === undefined) return 0;
    const negative = typeof duration === 'string' && duration.startsWith('-');
    const s = seconds(negative ? duration.slice(1) : duration, where) * (negative ? -1 : 1);
    const most = signed ? 2_147_483_647 : 4_294_967_295;
    if (s > most || s < (signed ? -most - 1 : 0))
      refuse('E-TIME', where, `${duration} is ${Math.abs(s).toLocaleString('en-US')} seconds, more than the program keeps here: at most ${most.toLocaleString('en-US')} (about ${Math.floor(most / 31_557_600)} years)${signed ? ' each way' : ''}.`, 'Use a shorter time.');
    return s;
  };
  /**
   * A duration counted from go-live into a time the program keeps (a farm's end, a schedule's next run): its seconds,
   * refused in words when go-live plus it is past what a count of seconds holds exactly.
   */
  const fromNowSeconds = (duration, where) => {
    const s = seconds(duration, where);
    if (now + s > Number.MAX_SAFE_INTEGER) refuse('E-TIME', where, `${duration} from go-live is further off than the program can count.`, 'Use a shorter time.');
    return s;
  };
  const percent = (value, where) => {
    if (value === undefined) return 0;
    const bps = toBps(value);
    if (bps === null) refuse('E-PERCENT', where, `${value}% is finer than the program counts (hundredths of a percent).`, 'Round it to two decimals.');
    return bps ?? 0;
  };
  /** A boost's percent (up to 10,000%, the schema's bound): whole hundredths of a percent, as the program counts it. */
  const boostPercent = (value, where) => {
    if (value === undefined) return;
    if (Math.abs(Math.round(Number(value) * 100) - Number(value) * 100) >= 1e-6) refuse('E-PERCENT', where, `${value}% is finer than the program counts (hundredths of a percent).`, 'Round it to two decimals.');
  };
  /** An amount checked without a refusal of its own (another check refuses it where it is written): its base units, or null. */
  const quietUnits = (amount, token) => {
    try {
      return toUnits(amount ?? 0, token?.decimals ?? 0);
    } catch {
      return null;
    }
  };

  // ---- keys and ids
  for (const [list, kind] of Object.entries({ tokens: 'token', items: 'item', pools: 'pool', stashes: 'stash', boxes: 'box', payments: 'payment', recipes: 'recipe', schedules: 'schedule', lotteries: 'lottery', farms: 'farm', contests: 'contest', auctions: 'auction', holds: 'hold', grants: 'grant', decisions: 'decision' })) {
    const seen = new Set();
    for (const [i, part] of (economy[list] ?? []).entries()) {
      if (seen.has(part.key)) refuse('E-KEY-DUP', `economy.${list}[${i}].key`, `Two ${list} are called “${part.key}”: the other parts could not tell which one they mean.`, `Give each ${kind} its own key.`);
      seen.add(part.key);
    }
    const field = list === 'pools' ? 'index' : 'id';
    const ids = new Set();
    for (const [i, part] of (economy[list] ?? []).entries()) {
      if (part[field] === undefined) continue;
      if (ids.has(part[field])) refuse('E-KEY-DUP', `economy.${list}[${i}].${field}`, `Two ${list} have the program number ${part[field]}: the second would overwrite the first.`, `Remove the ${field} from the newer one; it gets a free number when it goes live.`);
      ids.add(part[field]);
    }
  }
  // The empty pool of a farm that pays nothing keeps the number written on the farm (`rewardsIndex`): no pool may share it.
  for (const p of m.pools.filter((x) => x.farm && Number.isInteger(x.index))) {
    const other = m.pools.find((x) => x !== p && x.index === p.index);
    if (other) refuse('E-KEY-DUP', `economy.farms.${p.farm}.rewardsIndex`, `The farm “${p.farm}”’s empty rewards pool and the pool “${other.key}” both have the program number ${p.index}: the second would overwrite the first.`, other.farm ? 'Remove the number from the newer one; it gets a free number when it goes live.' : `Remove the "index" from “${other.key}” if it is new; it gets a free number when it goes live.`);
  }
  const boxIds = new Map();
  for (const b of m.allBoxes) {
    if (boxIds.has(b.id)) refuse('E-KEY-DUP', b.shopOf ? `economy.items.${b.shopOf}.shopBox` : `economy.boxes.${b.key}.id`, `The box number ${b.id} is taken twice (a box and a shop listing share the numbers).`, 'Remove one of the numbers; it gets a free one when it goes live.');
    boxIds.set(b.id, b);
  }

  // ---- tokens and the game's currency
  const sols = (economy.tokens ?? []).filter((t) => t.source === 'sol');
  if (sols.length > 1) refuse('E-TOKEN', 'economy.tokens', 'SOL is listed more than once.', 'Keep one token with source "sol".');
  for (const [i, t] of (economy.tokens ?? []).entries()) {
    const where = `economy.tokens[${i}]`;
    const tok = m.tokens.get(t.key);
    // The source as the model reads it: "project", and "game", its older spelling, are both "game" there.
    const source = tok.source;
    if (source === 'sol' && t.mint && !tok.wsol) refuse('E-TOKEN', `${where}.mint`, `“${t.key}” is SOL, but names another mint.`, 'Remove the mint: SOL needs none.');
    if (source === 'existing' && (!t.mint || t.decimals === undefined))
      refuse('E-TOKEN', where, `“${t.key}” is an existing token, so the economy needs its mint address and its decimals.`, 'Add "mint" (the token’s address) and "decimals", read from the mint (an explorer shows them): `xsolana approve` reads the mint and refuses decimals that differ.');
    if (source === 'game' && t.program === 'token-2022')
      refuse('E-NOT-YET', `${where}.program`, `“${t.key}” is a token the project makes itself, and the setup makes those as classic SPL tokens.`, 'Remove "program", or use an existing Token-2022 mint (source "existing").');
    // A token the project makes gets its mint when the setup makes it (kept in "live.mints"): one it names already
    // would be minted from without ever being made.
    if (source === 'game' && t.mint)
      refuse('E-TOKEN', `${where}.mint`, `“${t.key}” is a token the project makes when the economy goes live, but it names the mint ${t.mint}: the setup would never make it, and would mint from an address the project has no say over.`, 'Remove "mint" for a token the setup makes, or make it an existing token (source "existing", with its "decimals").');
    if (t.supply !== undefined && source !== 'game') refuse('E-TOKEN', `${where}.supply`, `“${t.key}” is not made by the project, so its supply is whatever its mint says.`, 'Remove "supply", or make it a token the project makes (source "project").');
    if (source === 'game' && t.supply !== undefined) {
      const supply = units(t.supply, tok, `${where}.supply`, `“${t.key}”’s supply`);
      if (supply === 0n) refuse('E-TOKEN', `${where}.supply`, `“${t.key}” has a supply of 0.`, 'Give it a supply above 0, or leave "supply" out for a token the game mints.');
      // A seed that is not an amount is refused with its pool, below.
      const seeded = m.pools.filter((p) => p.currency === t.key).reduce((n, p) => n + (quietUnits(p.seed, tok) ?? 0n), 0n);
      if (supply !== null && seeded > supply) refuse('E-TOKEN', `${where}.supply`, `The pools of “${t.key}” are seeded with more than its whole supply of ${t.supply}.`, 'Seed them with less, or raise the supply.');
    }
    const p = t.powers ?? {};
    percent(p.transferFeePercent, `${where}.powers.transferFeePercent`);
    if (p.nonTransferable) refuse('E-TOKEN', `${where}.powers`, `“${t.key}” cannot be transferred, so it cannot pay for anything, fill a pool or be staked.`, 'Use another token.');
    const powers = [
      p.freeze && 'freeze any account holding it, including the game’s pools and the vault that holds open orders and bids (a frozen vault holds them until it thaws)',
      p.permanentDelegate && 'move or burn it out of any account, the game’s pools included',
      p.transferHook && 'run its own program on every transfer, which can refuse one (a settle that pays a price or its shares in it waits until the hook allows it; a box that rolls, or that a recipe, a mission or a prize rolls, can’t give it as a prize)',
      p.transferFeePercent > 0 && `keep ${p.transferFeePercent}% of every transfer (pools and prizes receive that much less)`,
      p.pausable && 'pause every transfer of it',
      p.defaultFrozen && 'start every new account frozen',
      !p.defaultFrozen && p.defaultState && p.freeze && 'switch every new account to start frozen',
      p.mintAuthority === 'someone else' && 'mint more of it whenever its owner wants',
    ].filter(Boolean);
    if (powers.length) warn('W-MINT-POWERS', `${where}.powers`, `Whoever controls the mint of “${t.key}” can ${powers.join('; ')}. The program treats that as the token’s own business: players should know.`, 'Use a mint without those powers, or say so where players buy.');
    if (source === 'existing' && !t.powers)
      warn('W-MINT-POWERS', where, `The checker cannot read the mint of “${t.key}” from here, so it does not know what its owner can do (freeze, a permanent delegate, a transfer hook, which no rolled box can give a prize in, or fee).`, 'Look the mint up on an explorer and list what it can do under "powers".');
  }
  if (!m.currency) {
    if (m.currencyKey) refuse('E-REF', 'economy.currency', `The game’s currency “${m.currencyKey}” is not in the tokens.`, 'Add it to "tokens", or name one that is there.');
    else refuse('E-CURRENCY', 'economy.currency', 'The economy has no currency: the program needs one for the shop’s prices and the treasury.', 'Add a token (for example { "key": "sol", "source": "sol" }) and name it in "currency".');
    return result();
  }
  const game = m.currency;
  if (economy?.treasury !== undefined && (!m.treasuryWallet || !isAddress(m.treasuryWallet)))
    refuse('E-REF', 'economy.treasury', `The treasury “${economy.treasury}” is not "wallet:<address>".`, 'Write "wallet:<the wallet’s public address>", or leave it out for the owner’s own wallet.');

  const token = (key, where) => {
    const t = m.tokens.get(key ?? m.currencyKey);
    if (!t) refuse('E-REF', where, `There is no token “${key}”.`, 'Add it to "tokens", or name one that is there.');
    return t;
  };
  const pool = (key, where) => {
    const p = m.pool.get(key);
    if (!p) refuse('E-REF', where, `There is no pool “${key}”.`, 'Add it to "pools", or name one that is there.');
    return p;
  };
  const item = (key, where) => {
    const it = m.item.get(key);
    if (!it) refuse('E-REF', where, `There is no item “${key}”.`, 'Add it to "items", or name one that is there.');
    return it;
  };
  /** A box a prize rolls (`order::prize_roll`): one of this spec's. On chain a lottery's, a contest's or an auction's roll of no box rolls nothing, and a grant's is refused. */
  const prizeBox = (key, where, what, code) => {
    const b = m.box.get(key);
    if (!b) refuse(code, where, `${what} gives a roll of “${key}”, which is no box: on chain ${code === 'E-GRANT' ? 'every claim would be refused' : code === 'E-AUCTION' ? 'the auction could not open (LotRefused)' : 'its winner would get no roll'}.`, 'Name a box of this spec.');
    return b;
  };
  /**
   * A compressed NFT of an item (prize.rs `give_compressed`): a collectible, not soulbound, whose link fits Bubblegum's
   * 200 bytes with its serial in, in a collection that takes compressed NFTs. The setup's own does when it is made
   * with a compressed prize in the spec; one made before never can.
   */
  const compressedCheck = (it, at, what, code) => {
    const never = code === 'E-GRANT' || code === 'E-RECIPE' ? 'every claim or craft would be refused' : 'its winner would get nothing';
    if (!isCollectible(it)) return refuse(code, `${at}.compressed`, `${what} gives ${label(it)} compressed, but it is a normal item: only a collectible is an NFT.`, 'Make it a collectible, or leave "compressed" out.');
    if (it.soulbound) return refuse(code, `${at}.compressed`, `${what} gives ${label(it)} compressed, but it is soulbound: a compressed NFT can’t be kept from moving, so the program never gives one (${never}).`, 'Give it as a Core collectible (leave "compressed" out), or make the item tradable.');
    const longest = (it.uri ?? '').replaceAll('{serial}', String(Number(it.supply ?? 0) || 4_294_967_295));
    if (utf8Bytes(longest) > LIMITS.uriBytes) refuse(code, `${at}.compressed`, `${label(it)}’s link, its serial written in, is longer than Bubblegum’s ${LIMITS.uriBytes} bytes: ${never}.`, 'Use a shorter link.');
    if (it.collection) warn('W-COMPRESSED', `${at}.compressed`, `${label(it)} is minted into ${it.collection}: a compressed one is given only if that collection was made with Bubblegum’s plugin (BubblegumV2), which a collection can’t add later; otherwise ${never}.`, 'Use the setup’s collection, or one made with the plugin.');
    // A new setup still landing made its collection with the plugin, and opens the tree after the project.
    else if (m.live.project && !m.live.tree && !(m.live.partial && !m.live.published)) refuse(code, `${at}.compressed`, `${what} gives ${label(it)} compressed, but the project’s collection went live without Bubblegum’s plugin, which a collection can’t add later: ${never}.`, 'Give it as a Core collectible (leave "compressed" out), or mint it into another collection made with the plugin ("collection" on the item).');
  };
  /**
   * A prize (prize.rs, `model.prizeLine`): what it names is this spec's, and it gives something. `code` is the route's
   * refusal code. Returns the prize line, or null.
   */
  const prizeCheck = (given, at, what, code) => {
    const line = prizeLine(given);
    if (!line) {
      refuse(code, at, `${what} gives a prize this spec can’t read.`, 'Write a prize line: { "gives": "item", "item": key }, { "gives": "tokens", "amount": n, "from": "mint" or "pool:<key>" }, { "gives": "share", "pool": key, "percent": p }, { "gives": "nft", "stash": key, "nft": address } or { "gives": "roll", "box": key }.');
      return null;
    }
    if (line.split && (code !== 'E-CONTEST' || !['tokens', 'share'].includes(line.gives)))
      refuse(code, `${at}.split`, `${what} splits its prize by stake: only a contest's prize of tokens can be split (BadContest).`, 'Leave "split" out.');
    if (line.gives === 'item') {
      const it = line.item ? item(line.item, `${at}.item`) : refuse(code, at, `${what} gives an item but does not say which.`, 'Add "item".');
      if (it && it.active === false) warn('W-PRIZE', `${at}.item`, `${what} gives ${label(it)}, which is switched off: no prize gives an item switched off, so ${code === 'E-GRANT' || code === 'E-RECIPE' ? 'the claim or craft is refused' : 'its winner gets nothing'} until it is switched on.`, `Switch ${label(it)} on.`);
      if (it && line.compressed) compressedCheck(it, at, what, code);
    } else if (line.compressed) {
      refuse(code, `${at}.compressed`, `${what} gives ${line.gives} compressed: only an item’s collectible can be given as a compressed NFT.`, 'Leave "compressed" out.');
    } else if (line.gives === 'tokens') {
      const minted = line.from === 'mint';
      const poolKey = prizePool(line);
      if (!minted && !poolKey) refuse(code, `${at}.from`, `${what} gives tokens but does not say where from.`, 'Add "from": "mint" (the game mints them) or "pool:<key>".');
      const p = poolKey ? pool(poolKey, `${at}.from`) : null;
      const t = minted ? token(line.currency, `${at}.currency`) : p ? m.tokens.get(p.currency) : null;
      if (minted && t && !t.gameMints) refuse('E-MINT-NOT-OURS', `${at}.currency`, `${what} mints ${t.symbol}, which the project cannot mint.`, 'Pay it from a pool ("from": "pool:<key>"), or use a token with source "project".');
      if (p && line.currency && line.currency !== p.currency) refuse('E-POOL-MINT', `${at}.from`, `${what} gives ${m.tokens.get(line.currency)?.symbol ?? line.currency} from “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol}.`, `Leave "currency" out: a pool’s prize is in what it holds.`);
      if (t && units(line.amount, t, `${at}.amount`, `What ${what} gives`) === 0n) refuse(code, `${at}.amount`, `${what} gives an amount of 0.`, 'Give it an amount above 0.');
    } else if (line.gives === 'share') {
      if (line.pool) pool(line.pool, `${at}.pool`);
      else refuse(code, at, `${what} gives a share but does not say of which pool.`, 'Add "pool".');
      if (!(percent(line.percent, `${at}.percent`) > 0)) refuse(code, `${at}.percent`, `${what} gives a share of 0%.`, 'Give it a percent above 0.');
    } else if (line.gives === 'nft' && line.held) {
      // An NFT a lottery's place holds in the lottery's own stash: a lottery's place only (prize.rs Prize::Held).
      if (code !== 'E-LOTTERY') refuse(code, `${at}.held`, `${what} gives a held NFT: only a lottery's place holds one, in its own stash (BadPrize).`, 'Put it in a stash and give it with "stash", or raffle it in a lottery.');
      if (line.stash) refuse(code, `${at}.stash`, `${what} holds its NFT in the lottery's own stash, not in “${line.stash}”.`, 'Leave "stash" out.');
      if (!isAddress(line.nft)) refuse(code, `${at}.nft`, `${what} gives the NFT “${line.nft}”, which is not an address.`, 'Write the NFT’s address (a Core asset).');
    } else if (line.gives === 'nft') {
      const st = line.stash ? m.stash.get(line.stash) : null;
      if (!line.stash) refuse(code, at, `${what} gives an NFT but does not say which stash holds it.`, 'Add "stash": the stash that lists it.');
      else if (!st) refuse('E-REF', `${at}.stash`, `There is no stash “${line.stash}”.`, 'Add it to "stashes", or name one that is there.');
      if (!isAddress(line.nft)) refuse(code, `${at}.nft`, `${what} gives the NFT “${line.nft}”, which is not an address.`, 'Write the NFT’s address (a Core asset, or a Token Metadata NFT’s mint).');
      else if (st && !stashNfts(st).some((n) => n.asset === line.nft))
        refuse(code, `${at}.nft`, `${what} gives the NFT ${line.nft}, which ${label(st)} does not list: a prize gives only an NFT a stash of the game holds, so it would never be given.`, `List it in ${label(st)}'s "nfts", which puts it in when the economy goes live.`);
    } else if (line.gives === 'roll') prizeBox(line.box, `${at}.box`, what, code);
    else refuse(code, `${at}.gives`, `${what} gives “${line.gives}”, which no prize is.`, 'Use "item", "tokens", "share", "nft" or "roll".');
    return line;
  };
  /**
   * A mint whose holders can turn plain transfers away (confidential transfers): a lottery, a contest and an auction
   * refuse it, since a bid or a payout sent back could never land. Only when the spec says so (`powers`).
   */
  const confidential = (t, where, what, code) => {
    if (t?.powers?.confidentialTransfers) refuse(code, where, `${what} is in ${t.symbol}, whose mint allows confidential transfers: any holder could turn plain transfers away, so a payout or a bid sent back might never land (the program refuses it).`, 'Use a mint without confidential transfers.');
  };
  /**
   * A mint whose new accounts start frozen, or can be made to (a default state and a freeze authority, which can switch
   * it to frozen): a lottery, a contest, an auction and a sealed schedule refuse it as they open, since each reads the
   * setting once, and a payout or a refund opened into a frozen account could never land. Only when the spec says so.
   */
  const startsFrozen = (t, where, what, code, error) => {
    const p = t?.powers ?? {};
    if (!p.defaultFrozen && !(p.defaultState && p.freeze)) return;
    refuse(code, where, `${what} is in ${t.symbol}, whose new accounts ${p.defaultFrozen ? 'start frozen' : 'can be made to start frozen (its mint has a default account state and a freeze authority, which can switch it to frozen at any time)'}: a winner's, a refund's or a payout's account opened for them could never take what is owed (${error}).`, 'Use a mint without a default account state, or one with no freeze authority.');
  };
  /** Whether `address` is the game's own vault for `t` (where open orders, prizes set aside and bids wait), when both are known. */
  const gameVault = (address, t) => Boolean(m.live.project && t?.mint && !t.mint.startsWith('@') && [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].some((program) => vault(m.live.project, t.mint, program) === address));
  /** Whether anything puts money into lottery `l`'s pot: its seed, a place's prize, or a share or schedule that names "lottery:<key>". */
  const lotteryPotFilled = (l) => {
    const to = `lottery:${l.key}`;
    if (Number(l.seed ?? 0) > 0 || (l.places ?? []).some((p) => typeof p === 'object' && p.prize)) return true;
    const splits = [...m.allBoxes, ...m.payments, ...m.lotteries.map((x) => ({ split: lotterySplit(x) })), ...m.contests, ...m.auctions].map((x) => x.split ?? []);
    if (splits.some((sp) => sp.some((share) => share.to === to))) return true;
    if (m.schedules.some((sc) => sc.to === to)) return true;
    return m.recipes.some((r) => (r.in ?? []).some((i) => i.to === to));
  };
  /**
   * A route between players the project's keys have no say over (an auction's bids of NFTs, an offer's rule) reads an
   * NFT outside the project's collections without its Sheet: a Core NFT by its own attributes, a Token Metadata or
   * compressed NFT with none, so an attribute test never passes for those there (rules.rs `read_unwritten`).
   */
  const outsideAttribute = (r, where, what) => {
    if (!r?.collection || !r.attribute || m.collections.includes(r.collection)) return;
    warn('W-RULE-OUTSIDE', where, `${what} test “${r.attribute}” of NFTs of ${r.collection}, outside the project’s collections: there it reads a Core NFT’s own attributes, never what the project wrote in its Sheet, so the test fails for an NFT that doesn’t carry “${r.attribute}” itself (every Token Metadata or compressed NFT).`, 'Test only the collection, or use Core NFTs that carry the attribute themselves.');
  };
  /** A rule on what an NFT says (rules.rs): an item of the game's must be a collectible; or a collection is named. */
  const rule = (r, where, what) => {
    if (!r) return;
    // A gate may list wallets instead (rules.rs Gate::Wallets): a duel's two players, a tournament's entrants.
    // Or a list of any size (rules.rs Gate::List): its root on chain, each player's proof passed as accounts.
    if (r.list !== undefined) {
      r.list.forEach((w, i) => isAddress(w) || refuse('E-REF', `${where}.list[${i}]`, `${what} lists “${w}”, which is not an address.`, 'Write the wallet’s public address.'));
      if (!refusals.some((x) => x.where.startsWith(`${where}.list`))) {
        const { depth } = gateList(r.list);
        if (depth > 20) refuse('E-RULE', `${where}.list`, `${what} lists ${r.list.length} wallets: a proof is one account a level, and the program reads at most 20 (BadRule).`, 'Keep the list under 1,048,576 wallets, or gate by an NFT they hold.');
        if (depth > 12) warn('W-LIST', `${where}.list`, `${what}’s list is ${depth} levels deep: each player passes ${depth} proof nodes as accounts, ${depth * 32} bytes of their transaction.`, 'A shorter list, or gate by an NFT they hold.');
        warn('W-LIST', `${where}.list`, `${what} lets in ${r.list.length} listed wallet${r.list.length === 1 ? '' : 's'}: the program keeps only the list’s root, so the app (or xsolana_play) passes each player’s proof, and the list itself must stay where the app can read it (this spec keeps it).`);
      }
      return;
    }
    // Or a stake (rules.rs Gate::Staked): the wallet's token seat in a farm of tokens holds at least `atLeast`.
    if (r.staked !== undefined) {
      const f = m.farm.get(r.staked.farm);
      if (!f) refuse('E-REF', `${where}.staked.farm`, `${what} asks for a stake in the farm “${r.staked.farm}”, which is not in this economy.`, 'Name one of "farms" by its key.');
      else if (f.stakes === 'collectibles') refuse('E-RULE', `${where}.staked.farm`, `${what} asks for a stake in ${label(f)}, a farm of collectibles: a stake gate reads a wallet’s seat of tokens.`, 'Name a farm that stakes a token, or gate by a collectible they hold.');
      else {
        const t = m.tokens.get(f.stakes);
        const least = units(r.staked.atLeast, t, `${where}.staked.atLeast`, `${what}’s stake`);
        if (least === 0n) refuse('E-RULE', `${where}.staked.atLeast`, `${what} asks for a stake of 0, which every wallet has: the program refuses it (BadRule).`, 'Ask for more than 0, or leave the gate out.');
        // A stake counts only while its tier's lock runs: one with no lock could move to another wallet and count again.
        const tiers = f.tiers ?? [{ lock: 0 }];
        // A tier with no lock, or one a stake can leave early for a fee, never counts (rules.rs Gate::Staked).
        const unlocked = tiers.map((x, i) => [x, i]).filter(([x]) => seconds(x.lock ?? 0, `${where}.staked.farm`) <= 0 || Number(x.exitFee ?? 0) > 0).map(([, i]) => i + 1);
        if (unlocked.length === tiers.length) warn('W-STAKED', `${where}.staked.farm`, `${what} asks for a stake in ${label(f)}, which has no tier that counts: a stake counts only while it is locked with no early exit (so one stake can’t be unstaked, moved to another wallet and count again), and a stake there never passes (GateNotMet).`, `Give ${label(f)} a tier with a "lock" (like "7d") and no "exitFee", or gate by something else.`);
        else if (unlocked.length) warn('W-STAKED', `${where}.staked.farm`, `${label(f)}’s tier${unlocked.length === 1 ? '' : 's'} ${unlocked.join(', ')} ${unlocked.length === 1 ? 'has' : 'have'} no lock, so a stake in ${unlocked.length === 1 ? 'it' : 'them'} never passes ${what}’s gate: only a locked stake counts.`, 'Tell players to stake in a locked tier, or give every tier a lock.');
        if (least !== null && least !== 0n && unlocked.length < tiers.length) warn('W-STAKED', `${where}.staked`, `${what} lets in a wallet with at least ${r.staked.atLeast} ${t?.symbol ?? f.stakes} staked in ${label(f)} while its lock runs, staked before the second it is used (so it can’t be staked, used and unstaked in one transaction, and one stake counts for one wallet a lock). The app (or xsolana_play) passes the wallet’s seat and the farm; staking more counts at once, and the gate shuts once the lock ends (staking again starts a new lock).`);
      }
      return;
    }
    if (r.wallets !== undefined) {
      if (r.wallets.length > LIMITS.gateWallets) refuse('E-RULE', `${where}.wallets`, `${what} lists ${r.wallets.length} wallets; a gate lists at most ${LIMITS.gateWallets}.`, 'List fewer wallets, or gate by a collectible they hold.');
      else if (!r.wallets.length) warn('W-GATE', `${where}.wallets`, `${what} lists no wallets: nobody passes it.`, 'List the wallets it lets in, or leave the gate out.');
      r.wallets.forEach((w, i) => isAddress(w) || refuse('E-REF', `${where}.wallets[${i}]`, `${what} lists “${w}”, which is not an address.`, 'Write the wallet’s public address.'));
      return;
    }
    if ((r.atLeast !== undefined || r.equals !== undefined || r.time !== undefined) && !r.attribute) refuse('E-RULE', where, `${what} tests a number, a text or a time but names no attribute.`, 'Add "attribute", or leave the test out to ask only for the item.');
    if (r.time !== undefined && (r.atLeast !== undefined || r.equals !== undefined)) refuse('E-RULE', where, `${what} asks for a time and for a number or a text at once.`, 'Keep one of "time", "atLeast" and "equals".');
    if (!r.item && !r.collection && !r.attribute) refuse('E-RULE', where, `${what} asks for nothing: no item, no collection and no attribute.`, 'Name the item or the collection players must hold, an attribute, or both.');
    if (r.item && r.collection) refuse('E-RULE', where, `${what} names both an item and a collection: a rule is about one.`, 'Keep "item" for an item the game mints, or "collection" for any NFT of a collection.');
    if (r.collection && !isAddress(r.collection)) refuse('E-REF', `${where}.collection`, `${what} names the collection “${r.collection}”, which is not an address.`, 'Write the Core collection’s address, or the Token Metadata collection mint.');
    if (utf8Bytes(r.attribute ?? '') > LIMITS.keyBytes) refuse('E-RULE', `${where}.attribute`, `${what} reads an attribute name longer than ${LIMITS.keyBytes} bytes.`, 'Shorten it.');
    if (r.atLeast !== undefined && r.equals !== undefined) refuse('E-RULE', where, `${what} asks for an attribute that is both at least a number and equal to a text.`, 'Keep one of "atLeast" and "equals".');
    if (r.item) {
      const it = item(r.item, `${where}.item`);
      if (it && !isCollectible(it)) refuse('E-RULE', `${where}.item`, `${what} asks players to show ${label(it)}, a normal item: only collectibles can be shown.`, `Make ${label(it)} a collectible.`);
    }
    if (RESERVED_ATTRIBUTES.includes(r.attribute) && !['rarity', 'serial', 'made', 'used'].includes(r.attribute))
      warn('W-RULE', `${where}.attribute`, `${what} reads “${r.attribute}”, which only the program writes.`);
  };
  /** A raise or a shift that may move a time (`fromNow`): durations only with it, and a key a farm keeps a time under moved only with it. */
  const timed = (x, where, what, code) => {
    const durations = typeof x.by === 'string' || typeof x.upTo === 'string';
    const key = x.key ?? x.attribute;
    const kept = m.farms.find((f) => f.lockAttribute === key || f.upkeepAttribute === key);
    if (durations && !x.fromNow && !kept) refuse(code, where, `${what} by a duration, but it is not a time.`, 'Add "fromNow": true to move a time from now, or write plain numbers.');
    if (typeof x.upTo === 'string' && !x.fromNow) refuse(code, `${where}.upTo`, `${what} up to ${x.upTo}, a time from now, but it does not count from now.`, 'Add "fromNow": true, or leave "upTo" out.');
    if (kept && !x.fromNow && !durations) warn('W-TIME', where, `${what}, which ${label(kept)} keeps as a time (Unix seconds), by a plain number: ${toBy(x.by)} seconds.`, 'Write "by" as a duration ("1d"), with "fromNow": true to count from now.');
  };
  const effect = (e, where, what) => {
    if (!e) return;
    if (e.addPercent === undefined && e.perPointPercent === undefined) refuse('E-RULE', where, `${what} adds nothing.`, 'Give it "addPercent", or "perPointPercent" (with "upTo").');
    if (e.addPercent !== undefined && e.perPointPercent !== undefined) refuse('E-RULE', where, `${what} has both a flat boost and a boost per point.`, 'Keep one.');
    boostPercent(e.addPercent, `${where}.addPercent`);
    boostPercent(e.perPointPercent, `${where}.perPointPercent`);
  };
  /** Where an NFT a box rolls on (or takes as its price) goes: an address to give it to, or one of the spec's stashes. */
  const thenCheck = (then, where, what) => {
    if (then?.giveTo && !isAddress(then.giveTo)) refuse('E-ROLL', `${where}.giveTo`, `${what} gives the NFT to “${then.giveTo}”, which is not an address.`, 'Write a wallet address.');
    if (then?.stash && !m.stash.get(then.stash)) refuse('E-REF', `${where}.stash`, `There is no stash “${then.stash}” for ${what} to put the NFT in.`, 'Add it to "stashes", or name one that is there.');
  };
  for (const p of m.pools) if (!m.tokens.has(p.currency)) refuse('E-REF', `economy.pools.${p.key}.currency`, `The pool “${p.key}” holds “${p.currency}”, which is not in the tokens.`, 'Add the token, or name one that is there.');

  /**
   * A split carried out in `tok`: percents, at most 4 shares and 100% (state.rs check_later_shares), pools of the same
   * token, and no share that burns in wrapped SOL (the program refuses it). What the shares leave goes to the
   * treasury wallet's account of `tok`, whatever token it is. `chosen`: the buyer may name one share ("chosen",
   * "chosen:<item>"): a box's or a lottery's split; 'wallet': only "chosen", a wallet (a payment's split).
   */
  const split = (list, tok, where, { what, chosen = false }) => {
    const shares = sharesOf(list);
    shares.forEach((s, i) => percent(s.percent, `${where}[${i}].percent`));
    const total = shares.reduce((n, s) => n + (s.bps ?? 0), 0);
    if (shares.length > LIMITS.shares) refuse('E-SPLIT', where, `${what} has ${shares.length} shares; the program takes at most ${LIMITS.shares}.`, 'Merge shares that go to the same place, or drop one.');
    if (total > 10_000) refuse('E-SPLIT', where, `${what}’s shares add up to ${total / 100}%, more than the whole payment.`, 'Make them add up to 100% or less; the treasury gets what they leave.');
    if (shares.filter((s) => s.kind === 'chosen').length > 1) refuse('E-CHOSEN', where, `${what} lets the buyer choose more than one share.`, 'Let them choose one.');
    for (const [i, s] of shares.entries()) {
      if (s.kind === 'pool') {
        const p = pool(s.key, `${where}[${i}].to`);
        if (p && tok && p.currency !== tok.key) refuse('E-POOL-MINT', `${where}[${i}].to`, `${what} is paid in ${tok.symbol}, but the pool “${p.key}” holds ${m.tokens.get(p.currency)?.symbol ?? p.currency}.`, `Send it to a pool of ${tok.symbol}.`);
      }
      // A lottery's pot of this spec, in the token the share is paid in.
      if (s.kind === 'lottery') {
        const l = m.lottery.get(s.key);
        const potKey = l?.currency ?? m.currencyKey;
        if (!l) refuse('E-REF', `${where}[${i}].to`, `There is no lottery “${s.key}”.`, 'Name one of "lotteries" by its key.');
        else if (tok && potKey !== tok.key) refuse('E-POOL-MINT', `${where}[${i}].to`, `${what} is paid in ${tok.symbol}, but the pot of ${label(l)} is in ${m.tokens.get(potKey)?.symbol ?? potKey}.`, `Send it to a lottery whose pot is in ${tok.symbol}.`);
      }
      if (['account', 'holder', 'wallet'].includes(s.kind) && !isAddress(s.key)) refuse('E-REF', `${where}[${i}].to`, `${what} sends a share to “${s.to}”, which is not an address.`, `Write "${s.kind}:<address>".`);
      // A token account named as it is can't be opened for anyone: while none is there, its share goes to the treasury.
      if (s.kind === 'account' && isAddress(s.key) && gameVault(s.key, tok)) refuse('E-SPLIT', `${where}[${i}].to`, `${what} sends a share to the game’s own vault for ${tok.symbol}, where open orders, prizes set aside and bids wait: the program refuses it (it would mix into what those records hold).`, 'Send it to a pool ("pool:<key>") or the treasury instead.');
      else if (s.kind === 'account' && isAddress(s.key)) warn('W-PAYEE', `${where}[${i}].to`, `${what} pays a share to the token account ${s.key.slice(0, 4)}…: while no ${tok?.symbol ?? 'such'} account is there, that share goes to the treasury instead.`, `For a person's wallet, write "wallet:${s.key}": the program pays their own ${tok?.symbol ?? ''} account, and opens it when it is not there.`);
      if (s.kind === 'chosen' && !chosen)
        refuse('E-CHOSEN', `${where}[${i}].to`, `${what} can’t let anyone choose where a share goes: only a buyer chooses, when they pay (a box, a shop item, a lottery’s tickets, a payment).`, 'Name the destination, or sell it as a box with one outcome that gives nothing (or the item): a box can carry the "chosen" share, a gate and opens/closes.');
      // `pay` takes its shares from the payer as they are and checks no collectible against an item: a holder's share
      // the payer picks could name any collectible at all.
      else if (s.kind === 'chosen' && s.key && chosen === 'wallet')
        refuse('E-CHOSEN', `${where}[${i}].to`, `${what} lets the payer pick a “${s.key}” whose holder is paid, but a payment can’t check that the collectible they name is one: only a box’s (or shop item’s) and a lottery’s buyer picks a collectible of an item.`, 'Write "chosen" for a wallet the payer names (a referrer), or sell it as a box with one outcome that gives nothing: a box’s split can carry "chosen:<item>".');
      if (s.kind === 'chosen' && s.key && !m.item.has(s.key)) refuse('E-REF', `${where}[${i}].to`, `${what} lets the buyer pick a “${s.key}”, which is not an item.`, 'Name an item of the game ("chosen:<item key>"), or write "chosen" for a wallet.');
      if (tok?.wsol && s.kind === 'burn')
        refuse('E-WSOL-BURN', `${where}[${i}].to`, `${what} is paid in SOL, and wrapped SOL cannot be burned.`, 'Send that share to a pool or a wallet instead.');
    }
    return total;
  };

  const feeNote = (price, tok, where, what) => {
    if (!tok?.wsol || price === null) return;
    if (price === 0n) return;
    const ratio = Number(FEES.player) / Number(price);
    if (ratio >= 0.01)
      warn('W-FEE', where, `Every ${what} also pays the platform’s player fee of ${fromUnits(FEES.player, 9)} SOL: ${(ratio * 100).toFixed(1)}% on top of its ${fromUnits(price, 9)} SOL price.`, 'Fine for a game; a higher price makes the fee a smaller part of it.');
  };
  /** A part's "perWalletEach": its window (a day when it names none) in 4 bytes. */
  const perWalletWindow = (part, where) => {
    if (part.perWalletEach) fourByteSeconds(part.perWalletEach.every ?? '1d', `${where}.perWalletEach.every`);
  };
  const prices = (part, tok, where) => {
    if (part.rise) {
      units(part.rise.step, tok, `${where}.rise.step`, `${label(part)}’s rise`);
      percent(part.rise.growthPercent, `${where}.rise.growthPercent`);
    }
    if (part.fall) {
      const step = units(part.fall.step, tok, `${where}.fall.step`, `${label(part)}’s fall`);
      if (fourByteSeconds(part.fall.every, `${where}.fall.every`) === 0) refuse('E-PRICE', `${where}.fall.every`, `${label(part)}’s price falls every 0 seconds: the program refuses it.`, 'Give the fall a time above 0.');
      else if (step === 0n) warn('W-PRICE', `${where}.fall.step`, `${label(part)}’s price falls by 0: it never falls.`, 'Give the fall a step above 0, or leave "fall" out.');
      const floor = units(part.fall.floor, tok, `${where}.fall.floor`, `${label(part)}’s floor`);
      if (floor === 0n) warn('W-PRICE', `${where}.fall.floor`, `${label(part)}’s price can fall to 0: once it gets there, it is free until a rise lifts it.`, 'Give the fall a floor above 0 if it should never be free.');
    }
  };

  // ---- the collections and items
  if (m.collection && utf8Bytes(m.collection.name) > LIMITS.nameBytes) refuse('E-COLLECTION', 'economy.collection.name', `The collection’s name is longer than ${LIMITS.nameBytes} bytes.`, 'Shorten it.');
  if (m.collection && toBps(m.collection.royaltyPercent) === null) refuse('E-PERCENT', 'economy.collection.royaltyPercent', 'The royalty is finer than hundredths of a percent.', 'Round it to two decimals.');
  // A project takes up to eight collections (project.rs MAX_COLLECTIONS): the one it makes and the owner's others.
  if ((m.collection ? 1 : 0) + m.collections.length > 8) refuse('E-COLLECTION', 'economy.collections', `The project would take ${(m.collection ? 1 : 0) + m.collections.length} collections; it takes at most 8 (BadCollection).`, 'Name fewer collections.');
  m.collections.forEach((c, i) => isAddress(c) || refuse('E-REF', `economy.collections[${i}]`, `“${c}” is not an address.`, 'Write the Core collection’s address.'));
  if (m.collections.length) warn('W-COLLECTIONS', 'economy.collections', `The project takes ${m.collections.length} collection${m.collections.length === 1 ? '' : 's'} you already have: going live passes ${m.collections.length === 1 ? 'it' : 'them'} to the program, which refuses one whose update authority is not your wallet (BadCollection). An item minted into one needs the project as an update delegate of it, which you add to the collection yourself.`);
  const given = new Set();
  for (const b of m.allBoxes) for (const o of (b.outcomes ?? []).flatMap(outcomeParts)) if (o.gives === 'item') given.add(o.item);
  for (const p of prizes(m)) if (p.prize.gives === 'item') given.add(p.prize.item);
  for (const a of m.auctions) if (a.lot?.item) given.add(a.lot.item);
  for (const d of m.decisions) if (d.does === 'make') given.add(d.item);
  for (const it of m.items) {
    const where = `economy.items.${it.key}`;
    if (utf8Bytes(it.name) > LIMITS.nameBytes) refuse('E-ITEM', `${where}.name`, `${label(it)} is longer than ${LIMITS.nameBytes} bytes, the most the program keeps.`, 'Shorten the name.');
    if (utf8Bytes(it.uri) > LIMITS.uriBytes) refuse('E-ITEM', `${where}.uri`, `${label(it)}’s link is longer than ${LIMITS.uriBytes} bytes.`, 'Use a shorter link.');
    // A collectible is minted into a collection of the project's (catalog.rs BadCollection).
    if (isCollectible(it) && it.collection && !m.collections.includes(it.collection))
      refuse('E-COLLECTION', `${where}.collection`, `${label(it)} is minted into ${it.collection}, which is not one of the project’s "collections" (BadCollection).`, 'Add it to "collections", or leave "collection" out to mint into the one the setup makes.');
    if (isCollectible(it) && !it.collection && !m.collection)
      refuse('E-COLLECTION', `${where}.collection`, `${label(it)} is a collectible, but the project makes no collection ("collection": false) and the item names none.`, 'Name one of "collections" as its "collection", make it a normal item, or let the setup make a collection.');
    if ((it.uri ?? '').includes('{serial}') && !isCollectible(it)) warn('W-ITEM', `${where}.uri`, `${label(it)} is a normal item: "{serial}" in its link is written only on collectibles.`);
    const price = units(it.price, game, `${where}.price`, `${label(it)}’s price`);
    prices(it, game, where);
    perWalletWindow(it, where);
    // A collectible's life, each time in 4 bytes (a normal item's is dropped, warned of below).
    if (isCollectible(it) && it.life) for (const k of ['readyAfter', 'lasts', 'cooldown']) fourByteSeconds(it.life[k], `${where}.life.${k}`);
    if (it.kind === 'normal' && (it.life || it.soulbound || it.burnable))
      warn('W-ITEM', where, `${label(it)} is a normal item, kept by the project’s backend: its life, soulbound and burnable settings only apply to collectibles, so the program drops them.`, 'Make it a collectible, or remove those settings.');
    split(it.split, game, `${where}.split`, { what: `${label(it)}’s sale`, chosen: true });
    feeNote(price, game, `${where}.price`, `purchase of ${label(it)}`);
    rule(it.gate, `${where}.gate`, `${label(it)}’s shop listing`);
    if (price === 0n && !it.free && !given.has(it.key))
      warn('W-ITEM', where, `Nobody can get ${label(it)}: it is not in the shop (price 0), and no box, recipe, grant or decision gives it.`, 'Give it a price (or "free": true), or put it in a box, a recipe or a grant.');
    if (it.free) warn('W-FREE', where, `${label(it)} is free in the shop: anyone, a bot included, can take ${it.supply ? `all ${it.supply}` : 'as many as they like'} for only the fees.`, 'Give it a gate, a supply, or hand it out through a grant with limits per wallet and per person.');
  }

  // ---- pools: what fills them and what takes from them
  const takers = poolTakers(m);
  const fillers = poolFillers(m);
  for (const p of m.pools) {
    const where = `economy.pools.${p.key}`;
    const tok = m.tokens.get(p.currency);
    units(p.seed, tok, `${where}.seed`, `The seed of “${p.key}”`);
    const takes = takers.filter((t) => t.pool === p.key);
    const fills = fillers.filter((f) => f.pool === p.key);
    if (takes.length && !fills.length)
      warn('W-POOL-DRY', where, `The pool “${p.key}” is paid out of (${takes.map((t) => t.by).join(', ')}) but nothing in this spec fills it: until someone sends it tokens, those payouts give nothing (a claim of a fixed amount is refused).`, `Seed it ("seed"), send it a share of a sale (a split to "pool:${p.key}"), or fill it with a schedule.`);
    const names = m.farms.some((f) => f.rewards === p.key && f.rate?.minted);
    if (!takes.length && !fills.length && !names) warn('W-POOL', where, `The pool “${p.key}” is never used.`, 'Remove it, or use it.');
    if (fills.length && !takes.length)
      warn('W-POOL', where, `Money goes into “${p.key}” (${fills.map((f) => f.by).join(', ')}) and nothing in the economy takes it out: only the authority can, with a payout.`, 'Add what pays from it (a box prize, a lottery, a farm, a recipe, a grant), or a decision that pays out of it.');
    const farm = takes.find((t) => t.by.startsWith('farm:') && t.how.startsWith('releases everything'));
    if (farm) {
      const others = takes.filter((t) => t !== farm);
      if (others.length)
        warn('W-POOL-SHARED', where, `The farm ${label(m.farm.get(farm.by.slice(5)))} releases everything that arrives in “${p.key}” to its stakers, and ${others.map((t) => t.by).join(', ')} also take from it: the farm releases all the pool holds to its seats, so what the others need is paid out to stakers, and whichever takes first leaves the others less.`, 'Give the farm a rewards pool of its own, and feed it with a share or a schedule.');
    }
    const lottery = takes.find((t) => t.by.startsWith('lottery:'));
    if (lottery && !farm) {
      const others = takes.filter((t) => t !== lottery);
      if (others.length) warn('W-POOL-SHARED', where, `The pot “${p.key}” of ${lottery.by} is also taken from by ${others.map((t) => t.by).join(', ')}: until its winners are paid it is a pool like any other, and the winners share what is left.`, 'Give the lottery a pot of its own.');
    }
  }

  // ---- stashes (stash.rs): NFTs the game holds to give away, one at random a roll
  // Every roll of a box, a box's own outcome's and a roll's roll included: who can empty a stash, who wins a box,
  // whose roll fails at its ask.
  const rolls = rollsOf(m);
  /** Who makes a roll, in words: "grant:gift", or "grant:gift through box:mid" for a box that a box it rolls rolls. */
  const roller = (r) => (r.through?.length ? `${r.by} through ${r.through.map((k) => `box:${k}`).join(', ')}` : r.by);
  const stashUsers = new Map(m.stashes.map((s) => [s.key, m.allBoxes.filter((b) => (b.outcomes ?? []).flatMap(outcomeParts).some((o) => o.gives === 'stash' && o.stash === s.key))]));
  // What fills a stash besides its owner: an NFT a box takes as its price, a recipe's trade-in, a lottery's ticket.
  const intoStash = new Map();
  const into = (then, by) => then?.stash && intoStash.set(then.stash, [...(intoStash.get(then.stash) ?? []), by]);
  for (const b of m.allBoxes) for (const o of b.outcomes ?? []) into(o.then ?? b.then, `box:${b.key}`);
  for (const r of m.recipes) for (const l of r.in ?? []) if (l.takes === 'trade') into(l.then, `recipe:${r.key}`);
  for (const l of m.lotteries) into(l.ticketNft?.then, `lottery:${l.key}`);
  // The prizes that name one NFT of a stash (prize.rs Prize::Nft), given at once.
  const directs = prizes(m).filter((p) => p.prize.gives === 'nft');
  const listed = new Map();
  for (const s of m.stashes) {
    const where = `economy.stashes.${s.key}`;
    if (utf8Bytes(s.name) > 40) refuse('E-STASH', `${where}.name`, `${label(s)}’s name is longer than 40 bytes.`, 'Shorten it.');
    if (stashNfts(s).some((n) => n.kind === 'token-metadata'))
      warn('W-STASH', `${where}.nfts`, `${label(s)} lists Token Metadata NFTs: each must be an NFT (one token, no decimals, a mint that can never mint another); a semi-fungible item is refused when it is put in (NotAnNft).`);
    for (const [i, n] of stashNfts(s).entries()) {
      const at = `${where}.nfts[${i}]`;
      if (listed.has(n.asset)) refuse('E-STASH', at, `${label(s)} lists ${n.asset}, which ${listed.get(n.asset)} lists too: an NFT can be handed to the game once.`, 'List each NFT in one stash, once.');
      listed.set(n.asset, label(s));
      if (n.kind === 'compressed')
        refuse('E-STASH', at, `${label(s)} lists a compressed NFT: putting one in needs a proof of its leaf fetched when it is signed, which going live does not do.`, 'Leave it out here; once the economy is live, put it in with `loot.proveLeafIx` then `loot.stashIx` (both in one transaction, signed by the owner or the authority who holds it). A compressed prize NFT can’t move in the same instruction as another move on its tree (a mission whose staked NFTs share that tree, a lottery contribution winning two places of one tree): the second proof is stale and the unstake or the payment fails until it is sent again. Keep prize NFTs on a tree of their own, or give them through a roll.');
      if (n.kind === 'core' && !n.collection && !m.live.project)
        refuse('E-STASH', at, `${label(s)} lists an NFT of the game’s own collection, which is only made when the economy goes live: there is none to put in yet.`, 'Give the collection it is in ("collection"), or put it in once the economy is live and your wallet holds it.');
    }
    const users = stashUsers.get(s.key);
    const named = directs.filter((p) => p.prize.stash === s.key);
    // A known limit of the program: a named NFT is found by reading the stash's list from its start, about 52
    // compute units for each NFT ahead of it, and a box's roll looks for every NFT it names, then takes the one won. A
    // stash that players fill (a box's fate, a recipe's trade-in, a lottery's NFT ticket) can grow past what fits.
    const namers = m.allBoxes.map((b) => [b, (b.outcomes ?? []).flatMap(outcomeParts).filter((o) => o.gives === 'nft' && o.stash === s.key).length]).filter(([, n]) => n);
    if ((namers.length || named.length) && intoStash.has(s.key)) {
      const most = Math.max(0, ...namers.map(([, n]) => n));
      const fits = Math.floor(1_200_000 / (52 * (most + 1)) / 100) * 100;
      warn('W-STASH-NAMED', where, `${[...namers.map(([b]) => label(b)), ...named.map((p) => p.by)].join(', ')} name${namers.length + named.length === 1 ? 's' : ''} NFTs of ${label(s)}, which ${[...new Set(intoStash.get(s.key))].join(', ')} put${intoStash.get(s.key).length === 1 ? 's' : ''} NFTs into, so it can grow without end. A named NFT is found by reading the stash’s list, about 52 compute units for each NFT ahead of it${most ? `: a roll of ${label(namers.find(([, n]) => n === most)[0])}, which names ${most}, stops fitting a transaction at about ${fits.toLocaleString('en-US')} NFTs in the stash (its order then waits for its refund)` : ''}${named.length ? `${most ? ', and' : ':'} a prize naming one stops at about 25,000` : ''}. Keep a stash that prizes name under about 1,000 NFTs.`, 'Send what players put in to a stash of its own, and name prizes from a stash only the owner fills; a random pick of a stash costs the same at any size.');
    }
    if (!(s.nfts ?? []).length && !intoStash.has(s.key)) warn('W-STASH', `${where}.nfts`, `${label(s)} starts empty: an empty stash can’t be won, so its box gives its other outcomes (or sells nothing) until the owner or the authority puts NFTs in (\`loot.stashIx\`).`);
    if (!users.length && !named.length) warn('W-STASH', where, `No box and no prize gives an NFT of ${label(s)}: what it holds stays with the game.`, 'Add an outcome { "gives": "stash", "stash": key } to a box, or a prize { "gives": "nft", "stash": key, "nft": address }.');
    // Who takes from it: buyers and every route that rolls those boxes (one NFT a roll), and the prizes naming one.
    const takers = [...new Set([...users.flatMap((b) => [...(b.active !== false ? [b.shopOf ? `item:${b.shopOf}` : `box:${b.key}`] : []), ...rolls.filter((r) => r.box === b.key).map((r) => r.by)]), ...named.map((p) => p.by)])];
    if (takers.length > 1)
      warn('W-STASH-SHARED', where, `${label(s)} is given by ${takers.join(', ')}: ${users.length ? 'each roll takes an NFT out at random' : ''}${users.length && named.length ? ', and ' : ''}${named.length ? 'a prize that names an NFT finds it gone once a roll took it' : ''}, so one route can empty it before another pays, and a winner then gets the box’s other outcomes, or nothing. A lottery’s, a contest’s or an auction’s winner gets theirs only once the result is in.`, 'Give each route a stash of its own (a named NFT in a stash no box rolls), or keep it stocked.');
  }
  // A prize that names one NFT gives it once: every later winner of the route gets nothing (a grant's claim or a craft
  // is refused).
  for (const p of directs) {
    if (p.once) continue;
    warn('W-PRIZE-ONCE', p.where, `${p.by} gives ${prizeWords(p.prize, m)}, one NFT: the first winner takes it, and ${p.strict ? 'every claim or craft after is refused (PrizeNotCovered)' : 'every winner after gets nothing for it'}.`, p.route === 'grant' ? 'Limit the grant to one claim ("limits.total": 1), or give a roll of a box of a stash of many.' : 'Give a roll of a box of a stash of many, or an item or tokens each winner can get.');
  }
  // The game's own collection moves as the game says; any other's, as whoever controls it says.
  const others = m.stashes.filter((s) => stashNfts(s).some((n) => !(n.kind === 'core' && !n.collection)));
  if (others.length) {
    const ruled = others.flatMap((s) => stashNfts(s)).filter((n) => n.kind === 'token-metadata' && n.programmable && n.ruleSet).length;
    warn('W-STASH-TRANSFER', 'economy.stashes', `${others.map(label).join(', ')} hold${others.length === 1 ? 's' : ''} NFTs of collections the game has no authority over. An NFT goes to its winner through its own program, and whoever controls its collection can make that refuse (a Core freeze or a permanent delegate, a pNFT rule set that does not let programs hold or send it${ruled ? `; ${ruled} listed have a rule set` : ''}): a won order then can’t be settled until they allow it, and a prize that names such an NFT holds up what gives it (a lottery round’s last payment, a contest’s claim, a mission’s unstake) until the owner or the authority drops it from the stash (\`loot.stashIx\` out to the game’s own address).`, 'Stash NFTs of collections that let them move freely (the game’s own, or a partner’s you trust).');
  }

  // ---- boxes (catalog.rs, order.rs)
  let chance = false;
  let randomItems = false;
  /** Per pool, the largest fixed prize a box pays from it, and every box that pays one: warned of once a pool, below. */
  const seedNeeds = new Map();
  for (const b of m.boxes) {
    const where = `economy.boxes.${b.key}`;
    const tok = token(b.currency, `${where}.currency`);
    const price = units(b.price, tok, `${where}.price`, `${label(b)}’s price`);
    prices(b, tok, where);
    perWalletWindow(b, where);
    split(b.split, tok, `${where}.split`, { what: label(b), chosen: true });
    feeNote(price, tok, `${where}.price`, `opening of ${label(b)}`);
    rule(b.gate, `${where}.gate`, label(b));
    const outcomes = b.outcomes ?? [];
    // A roll on an NFT (`rollsOn`): what its outcomes do to it (order.rs, settle.rs).
    // Earned rolls: a mission's or a recipe's, of this box or of a box that rolls it.
    const rolledBy = [...new Set(rolls.filter((r) => r.box === b.key && ['mission', 'recipe'].includes(r.route)).map(roller))];
    if (b.rollsOn) rule(b.rollsOn, `${where}.rollsOn`, `${label(b)}’s NFT`);
    for (const [i, o] of outcomes.entries()) {
      const at = `${where}.outcomes[${i}]`;
      if ((o.shifts?.length || (o.then && o.then !== 'back')) && !b.rollsOn) refuse('E-ROLL', at, `An outcome of ${label(b)} acts on an NFT, but the box rolls on none.`, 'Add "rollsOn": the rule the NFT it rolls on must pass.');
      for (const [j, x] of (o.shifts ?? []).entries()) {
        if (RESERVED_ATTRIBUTES.includes(x.attribute)) refuse('E-ROLL', `${at}.shifts[${j}]`, `${label(b)} moves “${x.attribute}”, a number of the program’s own.`, 'Use a name of the game’s own, such as "level".');
        timed(x, `${at}.shifts[${j}]`, `${label(b)} moves “${x.attribute}”`, 'E-ROLL');
        fourByteSeconds(x.by, `${at}.shifts[${j}].by`, { signed: true });
        fourByteSeconds(x.upTo, `${at}.shifts[${j}].upTo`);
        if (toBy(x.by) > 0 && x.upTo !== undefined && !(toSeconds(x.upTo) >= 1)) warn('W-ROLL', `${at}.shifts[${j}]`, `${label(b)} raises “${x.attribute}” up to ${x.upTo}: it never raises it.`, 'Set "upTo" to 1 or more, or leave it out.');
      }
      thenCheck(o.then, `${at}.then`, label(b));
    }
    if (b.then !== undefined && !b.rollsOn) refuse('E-ROLL', `${where}.then`, `${label(b)} says where the NFT it rolls on goes, but it rolls on none.`, 'Add "rollsOn": the rule the NFT it takes must pass.');
    thenCheck(b.then, `${where}.then`, label(b));
    const thenOfOutcome = (o) => o.then ?? b.then;
    const custodial = outcomes.some((o) => thenOfOutcome(o) && thenOfOutcome(o) !== 'back');
    // A known limit of the program: a settle hands every account of the instruction to each NFT's move, and the 32 KiB
    // heap a transaction has by default keeps every copy. A payee the project didn't pick (a holder's share, a buyer's
    // chosen wallet, or a wallet's) can turn on required memos for their own Token-2022 account at any time, which adds
    // the memo program and a memo call to every settle, so each is counted as needing one. Measured on devnet's
    // features: with a hooked coin, three NFTs of stashes and the NFT rolled on
    // moved (four moves) and three or four such payees don't fit; four moves and two payees, or three moves and four
    // payees, fit (about 31.5 KiB and 30.8 KiB); without a hook every shape fits. With a 256 KiB heap frame, which loot's
    // senders ask for (`settleHeapFrame`), every one of them lands.
    const moves = Math.max(0, ...outcomes.map((o) => outcomeParts(o).filter((x) => x.gives === 'stash' || x.gives === 'nft').length + (thenOfOutcome(o) && !['back', 'burn'].includes(thenOfOutcome(o)) ? 1 : 0)));
    const payees = sharesOf(b.split).filter((x) => ['holder', 'chosen', 'wallet'].includes(x.kind)).length;
    // How xsolana's senders send a settle (js/play, the keeper's sweep).
    const sends = 'xsolana’s senders (js/play, the keeper’s sweep) ask for a 256 KiB heap frame, and send a settle too big for a legacy transaction as a v0 one with a lookup table (W-SETTLE-V0): it lands';
    if (tok?.powers?.transferHook && moves >= 4 && payees >= 3)
      warn('W-BOX-HEAP', `${where}.outcomes`, `${label(b)}’s settle moves ${moves} NFTs (three of stashes and the one it rolls on) and pays ${payees} holders’ or wallets’ shares in a coin with a transfer hook: it doesn’t fit the 32 KiB heap a transaction has by default once any of those payees turns on required memos for their own account, which they can do at any time: each NFT moved gets its own copy of the settle's accounts, and the copies outgrow the heap. ${sends}. One sent without the frame (another app’s) fails, and as a rolled order is never refunded, its player then settles by putting one won NFT back in its stash, where it waits for the owner.`, 'Give at most two NFTs of stashes an outcome, at most two holders’ or wallets’ shares, or a coin with no transfer hook.');
    // Every box that settles (one that rolls, rolls on an NFT, or that a grant, a place, a contest, an auction, a mission
    // or a recipe rolls): its settle as xsolana's senders build it (`settleSize`). Refused only where it can't land at all:
    // more accounts than a transaction locks even with none of a compressed NFT's proof, or more compute than a
    // transaction may have. A settle that may go past 64 accounts (a compressed NFT's proof can be 17 accounts, a payee
    // may turn on memos) is warned of, and one bigger than a legacy transaction goes as v0 with a lookup table its
    // sender makes. Two shapes outgrow the 32 KiB heap on a compressed subject (three Core NFTs of stashes; two and four
    // holders' or wallets' shares): with the 256 KiB heap frame xsolana's senders ask for they land (48 and 58 accounts).
    if (!boxBuys(b) || rolls.some((r) => r.box === b.key)) {
      const sizes = (outcomes.length ? outcomes : [{}]).map((o, i) => ({ i, ...settleAccounts(b, o, m), least: settleAccounts(b, o, m, { proof: 0 }).count, units: settleUnits(b, o, m), ...settleSize(b, o, m) }));
      const at = (x) => `${where}.outcomes${outcomes.length ? `[${x.i}]` : ''}`;
      // As v0 (any settle past a legacy transaction), the transaction locks its lookup table and the table's program
      // too: it deactivates the table (TABLE_LOCKS more).
      const asSent = (n, x) => n + (x.legacy > MAX_TRANSACTION_BYTES || n > LEGACY_MOST_ACCOUNTS ? TABLE_LOCKS : 0);
      const certain = sizes.find((x) => asSent(x.least, x) > ACCOUNT_LOCKS);
      const heavy = sizes.find((x) => x.units > MAX_COMPUTE_UNITS);
      const worst = sizes.reduce((a, x) => (asSent(x.count + (x.memo ? 1 : 0), x) > asSent(a.count + (a.memo ? 1 : 0), a) ? x : a), sizes[0]);
      const plain = worst.count + (worst.memo ? 1 : 0);
      const total = asSent(plain, worst);
      if (certain)
        refuse('E-TX-SIZE', at(certain), `${label(b)}’s settle of its outcome ${certain.i} takes ${certain.least} accounts at the least, and as a v0 transaction its lookup table and the table’s program two more: ${asSent(certain.least, certain)}, more than the ${ACCOUNT_LOCKS} a transaction can lock, so nobody could settle it, and a rolled order is never refunded.`, 'Give the outcome fewer prizes or fewer holders’ or wallets’ shares.');
      else if (heavy)
        refuse('E-TX-SIZE', at(heavy), `${label(b)}’s settle of its outcome ${heavy.i} would take about ${heavy.units.toLocaleString('en-US')} compute units, more than the ${MAX_COMPUTE_UNITS.toLocaleString('en-US')} a transaction can have, so nobody could settle it, and a rolled order is never refunded.`, 'Give the outcome fewer NFTs (a pNFT’s move takes the most) or fewer holders’ or wallets’ shares.');
      else if (total > ACCOUNT_LOCKS) {
        const tipped = worst.count + TABLE_LOCKS <= ACCOUNT_LOCKS && worst.memo;
        const back = outcomeParts(outcomes[worst.i] ?? {}).some((x) => x.gives === 'stash' || x.gives === 'nft');
        warn('W-BOX-ACCOUNTS', at(worst), `${label(b)}’s settle of its outcome ${worst.i} takes ${worst.count} accounts${worst.compressedSubject || worst.least < worst.count ? ` with a compressed NFT’s proof (it can be ${LONGEST_PROOF} accounts)` : ''}${worst.memo ? `, and the memo program is one more once any of its ${worst.payees} payee${worst.payees === 1 ? '' : 's'} the project didn’t pick (a holder’s share, a buyer’s chosen wallet, a wallet’s) turns on required memos for their own account, which they can do at any time` : ''}; sent as a v0 transaction, its lookup table and the table’s program are two more: ${total}. A transaction locks at most ${ACCOUNT_LOCKS}, so nobody can settle it then${tipped ? ' (until a payee turns memos on, it lands)' : ''}, and a rolled order is never refunded. ${back ? 'Its player can still settle it by putting every NFT won back in its stash.' : 'What it won can’t be put back to make room: the order, the NFT and the price stay where they are.'}`, `Give the outcome fewer prizes or fewer holders’ or wallets’ shares${worst.compressedSubject ? ', roll on the game’s own collectibles, or check that the collection’s trees keep a deeper canopy (a shorter proof)' : ''}.`);
      } else if (worst.compressedSubject && sizes.some((x) => x.corePicks >= 3 || (x.picks >= 2 && x.payees >= 4)))
        warn('W-BOX-HEAP', `${where}.rollsOn`, `${label(b)} rolls on an NFT of a collection that may be compressed, whose proof every NFT a settle moves is handed: with ${sizes.some((x) => x.corePicks >= 3) ? 'three NFTs of stashes' : 'two NFTs of stashes and four holders’ or wallets’ shares'} it doesn’t fit the 32 KiB heap a transaction has by default. ${sends}. One sent without the frame (another app’s) fails, and as a rolled order is never refunded, its player then settles by putting every NFT won back in its stash.`, 'Give an outcome fewer NFTs of stashes or fewer holders’ or wallets’ shares, or roll on the game’s own collectibles.');
      const big = sizes.reduce((a, x) => (x.legacy > a.legacy ? x : a), sizes[0]);
      if (!certain && !heavy && total <= ACCOUNT_LOCKS && big.legacy > MAX_TRANSACTION_BYTES)
        warn('W-SETTLE-V0', at(big), `${label(b)}’s settle of its outcome ${big.i} takes about ${big.legacy} bytes as a legacy transaction, more than the ${MAX_TRANSACTION_BYTES} one holds (${big.locks} accounts, ${big.locks + TABLE_LOCKS} as v0 with its table). xsolana’s senders send it as a v0 transaction that loads its accounts from an address lookup table they make first: js/play from the player’s wallet (one to three more approvals to make the table, and about ${(Number(big.tableRent) / 1e9).toFixed(4)} SOL of its rent, which comes back once the table has cooled down, about two minutes later: claims() lists it), the keeper’s sweep from its own payer. A sender of legacy transactions only (another app’s) can’t settle it, and a rolled order is never refunded.`, 'To keep it a legacy transaction, give the outcome fewer prizes or fewer holders’ or wallets’ shares.');
    }
    if (b.rollsOn && custodial)
      warn('W-ROLL-CUSTODY', `${where}.rollsOn`, `${label(b)} can ${outcomes.some((o) => thenOfOutcome(o) === 'burn') ? 'burn' : outcomes.some((o) => thenOfOutcome(o)?.stash) ? 'keep' : 'give away'} the NFT it rolls on: the project holds the NFT from the moment it is bought until the roll is settled, so nobody can move it away from a bad roll. A player who brings their own NFT must agree to that.`);
    // Every outcome sends the NFT away: the NFT is the box's price (a trade-in).
    if (b.rollsOn && outcomes.length && outcomes.every((o) => thenOfOutcome(o) && thenOfOutcome(o) !== 'back'))
      warn('W-NFT-PRICE', `${where}.rollsOn`, `${label(b)} takes the NFT it rolls on as its price: whatever it gives, the NFT ${outcomes.every((o) => thenOfOutcome(o) === 'burn') ? 'is burned' : 'is not given back'}. It opens with an order and settles after (\`open_box\`, \`settle\`), even with one outcome.`);
    // Free and for sale, anyone could open it again and again and empty what it gives: strangers take the owner's prizes.
    if (rolledBy.length && b.active !== false && price === 0n)
      refuse('E-ROLL', `${where}.active`, `${label(b)} is rolled by ${rolledBy.join(', ')}, and is for sale for free: anyone could open it directly, as often as they like, and skip the mission or the recipe.`, 'Set "active": false (a box only missions or recipes roll is never sold), or give it a price.');
    else if (rolledBy.length && b.active !== false)
      warn('W-ROLL', `${where}.active`, `${label(b)} is rolled by ${rolledBy.join(', ')}, and is also for sale: anyone may buy a roll of it instead of earning one.`, 'Set "active": false if it should only be earned.');
    // A prize's roll (a grant, a lottery's place, a contest's winners, an auction's lot) is made for a winner, on nothing.
    const prizedBy = rolls.filter((r) => r.box === b.key && !['mission', 'recipe'].includes(r.route)).map(roller);
    if (prizedBy.length && b.active !== false && !b.shopOf)
      warn('W-ROLL-PRIZE', `${where}.active`, `${label(b)} is a prize of ${[...new Set(prizedBy)].join(', ')}, and is for sale too: anyone can open it for its price${price === 0n ? ' (free)' : ''}, and each opening takes from what the prize gives (a stash’s NFTs, a pool’s prizes).`, 'Set "active": false for a box only prizes roll.');
    // A prize moves in the roll, which carries none of the accounts a transfer hook asks for (order.rs): the program
    // refuses a hooked prize mint at every open of a box that rolls, and fails every waiting roll of a box (a recipe's,
    // a mission's, a prize's, another box's outcome's, of any number of outcomes) at its ask, after the player gave what
    // it took.
    const rolledHere = [...new Set(rolls.filter((r) => r.box === b.key).map(roller))];
    if (boxRolls(b) || rolledHere.length)
      for (const [i, o] of outcomes.entries()) {
        const hookedKey = outcomeParts(o)
          .map((x) => (x.gives === 'pay' || x.gives === 'share' ? m.pool.get(x.pool)?.currency : x.gives === 'mint' ? x.currency ?? m.currencyKey : undefined))
          .find((k) => k && m.tokens.get(k)?.powers?.transferHook);
        if (!hookedKey) continue;
        const fails = [
          boxRolls(b) && 'every opening of it fails',
          rolledHere.length && `every roll of it ${rolledHere.join(', ')} make${rolledHere.length === 1 ? 's' : ''} fails when it is asked for, keeping what the player gave for it (a recipe’s inputs, a mission’s return, a grant’s round, a box’s price), or is refused at once on a route that can’t give it (a purchase in one step)`,
        ].filter(Boolean);
        refuse('E-BOX', `${where}.outcomes[${i}]`, `${label(b)} pays a prize in “${hookedKey}”, a token whose mint has a transfer hook, and its prizes move in a roll, which carries none of the accounts a hook asks for: the program refuses them (PrizeHasHook), so ${fails.join(', and ')}.`, `Pay its prizes in a token without a transfer hook${rolledHere.length ? '' : ', or give it one outcome (a box of one outcome moves its prize in the purchase, with the hook’s accounts)'}.`);
      }
    if (prizedBy.length && b.rollsOn)
      warn('W-ROLL-PRIZE', `${where}.rollsOn`, `${label(b)} rolls on an NFT, but ${[...new Set(prizedBy)].join(', ')} give${prizedBy.length === 1 ? 's' : ''} a roll of it on nothing: its outcomes are given, and their shifts and where they send an NFT are not.`, 'Give prizes a box with no "rollsOn".');
    if (price === 0n && !rolledBy.length && b.active !== false)
      warn('W-FREE', `${where}.price`, `${label(b)} is free: anyone, a bot included, can open it again and again for only the fees${outcomes.flatMap(outcomeParts).some((o) => o.gives === 'pay' || o.gives === 'share') ? ', and drain the pools its prizes come from' : ''}.`, 'Give it a price, a gate, or hand out openings through a grant.');
    const withChance = outcomes.filter((o) => o.chance !== undefined).length;
    const withWeight = outcomes.filter((o) => o.weight !== undefined).length;
    if (withChance && withWeight) refuse('E-ODDS', `${where}.outcomes`, `${label(b)} mixes chances and weights, so its odds cannot be read.`, 'Give every outcome a chance (percents adding up to 100), or every one a weight.');
    else if (withChance + withWeight < outcomes.length) refuse('E-ODDS', `${where}.outcomes`, `Some outcomes of ${label(b)} have no chance.`, 'Give every outcome a chance (percents adding up to 100) or a weight.');
    else if (withChance) {
      const total = outcomes.reduce((n, o) => n + o.chance, 0);
      if (Math.abs(total - 100) > 1e-9) refuse('E-ODDS', `${where}.outcomes`, `${label(b)}’s chances add up to ${+total.toFixed(6)}%, not 100%.`, 'Make them add up to 100.');
      if (outcomes.some((o) => Math.abs(o.chance * 10_000 - Math.round(o.chance * 10_000)) > 1e-6)) refuse('E-ODDS', `${where}.outcomes`, `A chance in ${label(b)} has more than four decimals.`, 'Round it to four decimals, or use weights.');
    }
    const parts = outcomes.flatMap(outcomeParts);
    // A paid box with more than one outcome that hands out collectibles a player can resell: a loot box.
    if (price > 0n && outcomes.length > 1 && parts.some((o) => (o.gives === 'item' && !m.item.get(o.item)?.soulbound && m.item.get(o.item)?.kind !== 'normal') || o.gives === 'nft')) randomItems = true;
    // A stash's NFTs are picked at random and can be resold: a paid box of one is a loot box.
    if (price > 0n && b.active !== false && parts.some((o) => o.gives === 'stash')) randomItems = true;
    const prizes = [];
    for (const [i, outcome] of outcomes.entries()) {
      const at = `${where}.outcomes[${i}]`;
      if (outcome.gives === 'bundle' && !(outcome.prizes ?? []).length) refuse('E-ODDS', `${at}.prizes`, `A bundle of ${label(b)} gives nothing.`, 'List up to three prizes in "prizes".');
      if (outcomeParts(outcome).length > 3) refuse('E-ODDS', `${at}.prizes`, `An outcome of ${label(b)} gives ${outcomeParts(outcome).length} prizes; an entry gives at most 3 (BadEntries).`, 'Give fewer, or move some to another outcome.');
      if (outcome.burns && outcome.gives !== 'bundle') refuse('E-ODDS', `${at}.burns`, `"burns" is a bundle's; this outcome is “${outcome.gives}”.`, 'Use "gives": "burn" for an outcome that only burns, or make it a bundle.');
      if (outcomeBurns(outcome) && outcome.gives !== 'burn' && tok?.wsol) refuse('E-WSOL-BURN', at, `${label(b)} is paid in SOL, and wrapped SOL cannot be burned.`, 'Leave "burns" out.');
      for (const [k, o] of outcomeParts(outcome).entries()) {
        const at = outcome.gives === 'bundle' ? `${where}.outcomes[${i}].prizes[${k}]` : `${where}.outcomes[${i}]`;
        // A prize line's own kinds: tokens minted, a named NFT, a roll of a box (prize.rs).
        if (o.gives === 'mint' || o.gives === 'nft' || o.gives === 'roll') prizeCheck(o.gives === 'mint' ? { gives: 'tokens', from: 'mint', currency: o.currency, amount: o.amount } : o, at, `An outcome of ${label(b)}`, 'E-ODDS');
        if (o.gives === 'item') {
          if (!o.item) refuse('E-ODDS', at, `An outcome of ${label(b)} gives an item but does not say which.`, 'Add "item".');
          else item(o.item, `${at}.item`);
        }
        if (o.gives === 'pay' || o.gives === 'share') {
          chance = true;
          const p = o.pool ? pool(o.pool, `${at}.pool`) : refuse('E-ODDS', at, `An outcome of ${label(b)} pays from a pool but does not say which.`, 'Add "pool".');
          if (o.gives === 'pay' && p) {
            const amount = units(o.amount, m.tokens.get(p.currency), `${at}.amount`, `${label(b)}’s prize`);
            if (amount === 0n) refuse('E-ODDS', `${at}.amount`, `An outcome of ${label(b)} pays nothing (BadEntries).`, 'Give it an amount above 0, or make it "nothing".');
            // In base units, exact (null when it is not an amount, refused above).
            prizes.push({ pool: p, amount });
          }
          if (o.gives === 'share' && !(percent(o.percent, `${at}.percent`) > 0)) refuse('E-ODDS', `${at}.percent`, `An outcome of ${label(b)} pays a share of 0% (BadEntries).`, 'Give it a percent above 0.');
        }
        if (o.gives === 'stash') {
          if (!o.stash) refuse('E-ODDS', at, `An outcome of ${label(b)} gives a stash’s NFT but does not say which stash.`, 'Add "stash".');
          else if (!m.stash.get(o.stash)) refuse('E-REF', `${at}.stash`, `There is no stash “${o.stash}”.`, 'Add it to "stashes", or name one that is there.');
        }
      }
      if (outcome.gives === 'burn' && tok?.wsol) refuse('E-WSOL-BURN', at, `${label(b)} is paid in SOL, and wrapped SOL cannot be burned.`, 'Make that outcome "nothing", or send its share somewhere.');
    }
    if (outcomes.length > LIMITS.entries) refuse('E-ODDS', `${where}.outcomes`, `${label(b)} has ${outcomes.length} outcomes; a box holds at most ${LIMITS.entries}.`, 'Merge outcomes, or split it into two boxes.');
    // The oracle's answer to a roll carries the order, the box, its ticket, an account for each outcome that wins
    // something, and with prizes the token programs, the game and a mint and a vault for each pool (catalog.rs).
    if (boxRolls(b)) {
      const named = parts.filter((o) => ['item', 'pay', 'share', 'stash', 'nft'].includes(o.gives)).length;
      const sources = new Set(parts.filter((o) => ['pay', 'share', 'mint'].includes(o.gives)).map((o) => (o.gives === 'mint' ? `mint:${o.currency ?? m.currencyKey}` : o.pool))).size;
      const callback = 3 + named + (sources ? 3 + 2 * sources : 0);
      if (callback > LIMITS.callbackAccounts) refuse('E-ODDS', `${where}.outcomes`, `${label(b)}’s roll would hand the oracle ${callback} accounts; its answer carries at most ${LIMITS.callbackAccounts} (TooManyAccounts).`, 'Pay prizes from fewer pools, or have fewer outcomes.');
    }
    // The player's purchase must be sendable, with the compute budget their wallet adds: js/play sends one
    // too big for a legacy transaction as v0 with a lookup table, which locks the table and its program too.
    if (b.active !== false && !refusals.some((x) => x.where.startsWith(where))) {
      const { bytes, locks } = boxBuys(b) ? buySize(b, m, { detail: true }) : openBoxSize(b, m, { detail: true });
      const verb = boxBuys(b) ? 'buy' : 'open';
      if (bytes > MAX_TRANSACTION_BYTES && locks + TABLE_LOCKS > ACCOUNT_LOCKS)
        refuse('E-TX-SIZE', where, `${boxBuys(b) ? 'Buying' : 'Opening'} ${label(b)} would take about ${bytes} bytes and ${locks} accounts, ${locks + TABLE_LOCKS} as a v0 transaction with a lookup table: more than the ${ACCOUNT_LOCKS} a transaction can lock, so no player could ${verb} it.`, 'Give it fewer outcomes that name an item or a pool, pay its prizes (and those of a box it rolls) from fewer pools, or drop its per-wallet limit.');
      else if (bytes > MAX_TRANSACTION_BYTES)
        warn('W-TX-V0', where, `${boxBuys(b) ? 'Buying' : 'Opening'} ${label(b)} takes about ${bytes} bytes with the compute budget a wallet adds, more than the ${MAX_TRANSACTION_BYTES} a legacy transaction holds: js/play sends it as a v0 transaction with a lookup table the player’s wallet makes first (one to three more approvals, and the table’s rent until it is closed, which claims() offers about two minutes later). A wallet or app that sends only legacy transactions can’t ${verb} it.`, 'To keep it a legacy transaction, give it fewer outcomes that name an item or a pool, or pay its prizes from fewer pools.');
    }
    for (const [i, o] of (b.odds ?? []).entries()) {
      const at = `${where}.odds[${i}]`;
      if (o.outcome >= outcomes.length) refuse('E-ODDS', `${at}.outcome`, `${label(b)}’s odds raise outcome ${o.outcome}, but it has ${outcomes.length} (the first is 0).`, 'Point it at one of its outcomes.');
      rule(o.when, `${at}.when`, `${label(b)}’s odds`);
      effect(o.add, `${at}.add`, `${label(b)}’s odds`);
    }
    if ((b.odds ?? []).length && outcomes.length < 2) warn('W-ODDS', `${where}.odds`, `${label(b)} has one outcome, so odds change nothing.`);
    // A box sells only while its pool covers every fixed prize (order.rs, PrizeNotCovered): the odds on the page are
    // always odds it can pay. A prize won leaves the pool for the game's vault at the roll.
    for (const z of prizes) {
      if (z.amount === null) continue;
      const need = seedNeeds.get(z.pool.key) ?? { pool: z.pool, amount: 0n, box: b, boxes: new Set() };
      need.boxes.add(b);
      if (z.amount > need.amount) Object.assign(need, { amount: z.amount, box: b });
      seedNeeds.set(z.pool.key, need);
    }
    if (b.stockOdds && !parts.some((o) => o.gives === 'item' && m.item.get(o.item)?.supply > 0))
      warn('W-ODDS', `${where}.stockOdds`, `${label(b)} has odds that shrink with stock, but none of its items has a limited supply, so nothing changes.`, 'Give its items a supply, or turn stockOdds off.');
  }
  // A box sells only while its pool covers every fixed prize (order.rs, PrizeNotCovered): a pool whose seed is short of
  // the largest prize a box pays from it holds up every box it pays.
  for (const { pool: p, amount: most, box, boxes } of seedNeeds.values()) {
    const tok = m.tokens.get(p.currency);
    const sym = tok?.symbol ?? p.currency;
    // Both in base units, exact: a seed that is not an amount is refused with its pool.
    const seed = quietUnits(p.seed, tok);
    if (seed === null || seed >= most) continue;
    const amount = fromUnits(most, tok?.decimals ?? 0);
    const others = [...boxes].filter((x) => x !== box).map(label);
    warn('W-PRIZE-SEED', `economy.pools.${p.key}.seed`, `“${p.key}” starts with ${fromUnits(seed, tok?.decimals ?? 0)} ${sym}, but a win in ${label(box)} pays ${amount} ${sym}. The program sells a box only while its pool holds every fixed prize, so ${label(box)} can’t be opened until the pool holds ${amount} ${sym}, and stops selling whenever a run of wins takes the pool below that${others.length ? ` (${others.join(', ')} pay${others.length === 1 ? 's' : ''} fixed prizes from it too, each held up the same way below its own largest)` : ''}.`, `Seed “${p.key}” with at least ${amount} ${sym}; more rides out a run of wins (the simulation suggests how much). For a prize that grows with sales, use a share of the pool ("gives": "share") instead.`);
  }

  // ---- a live box's roll rewritten: an order waiting for its roll is rolled only on the version it paid for, so
  // an edit of the entries, odds, stock odds, the NFT it rolls on or the fates fails every roll of it that waits. A
  // purchase gets its payment back; a roll won elsewhere (a prize, a mission's chest, an auction's lot) paid nothing in,
  // and refunds 0.
  const published = new Map((economy.live?.published?.boxes ?? []).map((b) => [b.key, b]));
  const rollOf = (b) => JSON.stringify([b.outcomes ?? [], b.odds ?? [], Boolean(b.stockOdds), b.rollsOn ?? null, b.then ?? null]);
  for (const b of economy.boxes ?? []) {
    const was = published.get(b.key);
    if (!was || rollOf(was) === rollOf(b)) continue;
    const routes = [...new Set(rolls.filter((x) => x.box === b.key).map(roller))];
    warn('W-LIVE-ROLLS', `economy.boxes.${b.key}`, `${label(m.box.get(b.key) ?? b)} is live, and this changes its roll (its outcomes, odds, stock odds, the NFT it rolls on or what becomes of it). Every roll of it still waiting fails when the change lands${routes.length ? `: one won on another route (${routes.join(', ')}) paid nothing in, so it refunds 0 and its winner loses it` : ': a purchase gets its payment back, and a roll won on another route paid nothing in, so it refunds 0'}.`, 'Publish the change only once no roll of it waits (each settled or refunded), or open a new box with the new roll and point the routes at it.');
  }

  // ---- payments
  for (const p of m.payments) {
    const where = `economy.payments.${p.key}`;
    const tok = token(p.currency, `${where}.currency`);
    const amount = units(p.amount, tok, `${where}.amount`, `${label(p)}’s amount`);
    if (amount === 0n) refuse('E-PRICE', `${where}.amount`, `${label(p)} is a payment of 0 (ZeroAmount).`, 'Give it an amount above 0.');
    // A payment's split is the payer's own (`pay` takes it from them each time), so they may name one wallet in it too.
    split(p.split, tok, `${where}.split`, { what: label(p), chosen: 'wallet' });
    feeNote(amount, tok, `${where}.amount`, `payment of ${label(p)}`);
  }

  // ---- recipes (craft.rs)
  for (const r of m.recipes) {
    const where = `economy.recipes.${r.key}`;
    const ins = r.in ?? [];
    const outs = r.out ?? [];
    if (!ins.length && !outs.length) warn('W-RECIPE', where, `${label(r)} takes nothing and gives nothing: crafting it only charges the player fee.`, 'Add what it takes and what it gives.');
    if (ins.length > LIMITS.lines || outs.length > LIMITS.lines) refuse('E-RECIPE', where, `${label(r)} has more than ${LIMITS.lines} lines on a side.`, 'Merge lines, or split it into two recipes.');
    perWalletWindow(r, where);
    let taken = 0;
    const kept = [];
    for (const [i, line] of ins.entries()) {
      const at = `${where}.in[${i}]`;
      if (line.takes === 'pay') {
        const tok = token(line.currency, `${at}.currency`);
        const amount = units(line.amount, tok, `${at}.amount`, `What ${label(r)} takes`);
        if (amount === 0n) refuse('E-RECIPE', `${at}.amount`, `${label(r)} takes an amount of 0.`, 'Give it an amount above 0.');
        feeNote(amount, tok, `${at}.amount`, `craft of ${label(r)}`);
        if (!line.to) refuse('E-RECIPE', `${at}.to`, `${label(r)} takes ${tok?.symbol ?? 'a token'} but does not say where it goes.`, 'Add "to": "burn", "pool:<key>", "wallet:<address>", "account:<token account>" or "holder:<address>".');
        else split([{ to: line.to, percent: 100 }], tok, `${at}`, { what: label(r) });
        continue;
      }
      if (line.takes === 'trade') {
        if (line.item) refuse('E-RECIPE', `${at}.item`, `${label(r)} trades in an NFT of a collection, not an item.`, 'Use "takes": "burn" for one of the project’s items, or name the "collection".');
        if (line.collection && !isAddress(line.collection)) refuse('E-REF', `${at}.collection`, `${label(r)} trades in an NFT of “${line.collection}”, which is not an address.`, 'Write the Core collection’s address, or the Token Metadata collection mint.');
        if (!line.collection && !m.collection) refuse('E-RECIPE', `${at}.collection`, `${label(r)} trades in an NFT of the project’s own collection, but the project makes none.`, 'Name the "collection" it takes.');
        if (line.then === 'treasury' || line.then?.giveTo) warn('W-NFT-PRICE', `${at}.then`, `${label(r)} hands each NFT traded in to ${line.then === 'treasury' ? 'the treasury' : line.then.giveTo}, straight from the player.`);
        thenCheck(line.then, `${at}.then`, label(r));
        kept.push(false);
        taken += 1;
        continue;
      }
      if (line.takes === 'show') {
        if (line.item) refuse('E-RECIPE', `${at}.item`, `${label(r)} shows an NFT of a collection, not an item.`, 'Use "takes": "use" for one of the game’s items, or name the "collection".');
        kept.push(true);
        taken += 1;
        continue;
      }
      const it = line.item ? item(line.item, `${at}.item`) : refuse('E-RECIPE', at, `A line of ${label(r)} hands something in but does not say which item.`, 'Add "item".');
      if (!it) continue;
      if (it.kind === 'normal') refuse('E-RECIPE', `${at}.item`, `${label(r)} takes ${label(it)}, a normal item: only collectibles can be handed in.`, `Make ${label(it)} a collectible.`);
      if (line.takes === 'staked') {
        // The line names its farm (craft.rs, `Input::Staked { item, farm }`): the craft takes the piece only from its seat
        // there, a farm of collectibles that holds or freezes it (a watched one could be sold while staked).
        const f = line.farm === undefined ? null : m.farm.get(line.farm);
        const raised = (r.raises ?? []).filter((x) => x.place === taken).map((x) => x.key);
        const candidates = m.farms.filter((x) => x.stakes === 'collectibles' && (x.custody ?? 'escrow') !== 'watch' && (!x.item || x.item === it.key));
        if (line.farm === undefined)
          refuse('E-RECIPE', `${at}.farm`, `${label(r)} takes ${label(it)} only while it is staked, but does not say in which farm: the program takes the piece only from its seat in the farm the line names.`, candidates.length ? `Add "farm": ${candidates.map((x) => `"${x.key}"`).join(' or ')}.` : `Add a farm of collectibles that takes ${label(it)} with "custody": "escrow" or "freeze", and name it in "farm".`);
        else if (!f) refuse('E-RECIPE', `${at}.farm`, `${label(r)} takes ${label(it)} staked in “${line.farm}”, which is not a farm of this spec.`, candidates.length ? `Use ${candidates.map((x) => `"${x.key}"`).join(' or ')}.` : 'Fix the name, or add the farm.');
        else if (f.stakes !== 'collectibles') refuse('E-RECIPE', `${at}.farm`, `${label(r)} takes ${label(it)} staked in ${label(f)}, a farm of tokens: a collectible is staked only in a farm of collectibles.`, candidates.length ? `Use ${candidates.map((x) => `"${x.key}"`).join(' or ')}.` : `Add a farm of collectibles that takes ${label(it)}.`);
        else if (f.item && f.item !== it.key) refuse('E-RECIPE', `${at}.farm`, `${label(r)} takes ${label(it)} staked in ${label(f)}, which stakes only ${label(m.item.get(f.item) ?? { key: f.item })}: no ${label(it)} is ever staked there.`, candidates.length ? `Use ${candidates.map((x) => `"${x.key}"`).join(' or ')}.` : `Let ${label(f)} take ${label(it)}.`);
        else if ((f.custody ?? 'escrow') === 'watch') refuse('E-RECIPE', `${at}.farm`, `${label(r)} takes ${label(it)} staked in ${label(f)}, which watches NFTs left free in their wallets: one could be sold while staked, so the craft takes a staked piece only from a farm that escrows or freezes it.`, `Give ${label(f)} "custody": "escrow" or "freeze", or name another farm.`);
        // A raise on the piece must move the lock its farm reads (BadRecipe): a lock moved where the farm doesn't read it holds nothing.
        else if (raised.length && !raised.includes(f.lockAttribute))
          refuse('E-RECIPE', `${at}.farm`, `${label(r)} raises ${raised.map((k) => `“${k}”`).join(', ')} on ${label(it)} staked in ${label(f)}, but ${f.lockAttribute ? `that farm keeps its lock under “${f.lockAttribute}”` : 'that farm keeps no lock on the NFT ("lockAttribute")'}: a recipe that raises anything on a staked piece must move the lock its farm reads, or the program refuses the craft (BadRecipe).`, f.lockAttribute ? `Raise "${f.lockAttribute}" on collectible ${taken} too, or take it with "takes": "use" to raise a stat and leave its lock alone.` : `Give ${label(f)} "lockAttribute" and raise it here, or take it with "takes": "use" to raise a stat and leave its lock alone.`);
        else if (!f.lockAttribute) warn('W-STAKED', `${at}.farm`, `${label(r)} takes ${label(it)} only while it is staked in ${label(f)}, which keeps no lock on the NFT ("lockAttribute"): nothing the recipe does can keep it staked after.`, `Give ${label(f)} a "lockAttribute", and raise it in the recipe so the pieces stay staked after the craft.`);
      }
      if (line.takes === 'burn' && it.soulbound) warn('W-RECIPE', `${at}.item`, `${label(r)} burns ${label(it)}, which is soulbound and can never be burned, so nobody could ever craft it.`, 'Use it and keep it ("takes": "use"), or make the item not soulbound.');
      taken += line.takes === 'burn' ? line.count ?? 1 : 1;
      kept.push(...Array(line.takes === 'burn' ? line.count ?? 1 : 1).fill(line.takes !== 'burn'));
    }
    if (taken > LIMITS.collectiblesPerCraft) refuse('E-RECIPE', `${where}.in`, `${label(r)} takes ${taken} collectibles; one craft takes at most ${LIMITS.collectiblesPerCraft}.`, 'Take fewer, or split it into two recipes.');
    let made = 0;
    // Each line is a prize (prize.rs), given in the craft; a roll on a collectible it keeps (`on`) is checked below.
    for (const [i, line] of outs.entries()) {
      if (line.gives === 'roll' && line.on !== undefined) continue;
      const given = prizeCheck(line, `${where}.out[${i}]`, label(r), 'E-RECIPE');
      if (given?.gives === 'item') made += 1;
    }
    // A roll it makes (craft.rs, order.rs): at most one, on a collectible it keeps.
    const places = ins.flatMap((l) => (l.takes === 'burn' ? Array(l.count ?? 1).fill('burn') : l.takes === 'pay' ? [] : [l.takes]));
    const rolls = outs.filter((l) => l.gives === 'roll');
    if (rolls.length > 1) refuse('E-RECIPE', `${where}.out`, `${label(r)} rolls ${rolls.length} boxes: a craft makes one roll.`, 'Keep one roll.');
    for (const [i, line] of outs.entries()) {
      if (line.gives !== 'roll') continue;
      const at = `${where}.out[${i}]`;
      const b = m.box.get(line.box);
      if (!b) continue;
      if (line.on === undefined && b.rollsOn) refuse('E-RECIPE', at, `${label(r)} rolls ${label(b)}, which rolls on an NFT, but does not say on which collectible.`, 'Add "on": the place of a collectible the recipe keeps.');
      if (line.on !== undefined && !b.rollsOn) refuse('E-RECIPE', `${at}.on`, `${label(r)} rolls ${label(b)} on collectible ${line.on}, but the box rolls on none.`, 'Give the box "rollsOn", or leave "on" out.');
      if (line.on !== undefined && !kept[line.on]) refuse('E-RECIPE', `${at}.on`, `${label(r)} rolls on collectible ${line.on}, which it ${line.on < taken ? 'burns' : 'does not take'}.`, 'Point it at a collectible the recipe uses, renews or shows.');
      const custodial = (b.outcomes ?? []).some((o) => o.then && o.then !== 'back');
      if (custodial && places[line.on] === 'show')
        warn('W-ROLL-CUSTODY', `${at}.on`, `${label(b)} can burn or give away the NFT ${label(r)} shows: the craft hands it to the game, which only a Core NFT can be (a Token Metadata or compressed one is refused, NeedsCustody).`, 'Roll on one of the game’s items ("use"), or give the box only outcomes that move numbers.');
    }
    for (const [i, raise] of (r.raises ?? []).entries()) {
      timed(raise, `${where}.raises[${i}]`, `${label(r)} raises “${raise.key}”`, 'E-RECIPE');
      fourByteSeconds(raise.by, `${where}.raises[${i}].by`, { signed: true });
      fourByteSeconds(raise.upTo, `${where}.raises[${i}].upTo`);
      const asWritten = !raise.fromNow && m.farms.some((f) => f.lockAttribute === raise.key || f.upkeepAttribute === raise.key);
      if (toBy(raise.by) > 0 && !asWritten && !(toSeconds(raise.upTo ?? 0) >= 1)) warn('W-RECIPE', `${where}.raises[${i}].upTo`, `${label(r)} raises “${raise.key}” with no "upTo": it is maxed out for every NFT and never raises it.`, 'Say the most it reaches.');
      if (!kept[raise.place]) refuse('E-RECIPE', `${where}.raises[${i}]`, `${label(r)} raises “${raise.key}” on collectible ${raise.place}, which it ${raise.place < taken ? 'burns' : 'does not take'}: only one it keeps can be raised.`, 'Point it at a collectible the recipe uses, renews or shows.');
      if (RESERVED_ATTRIBUTES.includes(raise.key)) refuse('E-RECIPE', `${where}.raises[${i}].key`, `“${raise.key}” is a number the program writes itself.`, 'Raise a key of the game’s own, such as "level" or "power".');
    }
    for (const [i, need] of (r.needs ?? []).entries())
      if (need.place >= taken) refuse('E-RECIPE', `${where}.needs[${i}]`, `${label(r)} asks something of collectible number ${need.place}, but it only takes ${taken} (the first is 0).`, 'Point it at a collectible the recipe takes.');
    for (const [i, keep] of (r.keeps ?? []).entries()) {
      if (keep.from >= taken || keep.to >= made) refuse('E-RECIPE', `${where}.keeps[${i}]`, `${label(r)} carries “${keep.key}” from collectible ${keep.from} to new collectible ${keep.to}, but it takes ${taken} and makes ${made} (the first of each is 0).`, 'Point it at collectibles the recipe takes and makes.');
      if (RESERVED_ATTRIBUTES.includes(keep.key)) refuse('E-RECIPE', `${where}.keeps[${i}].key`, `“${keep.key}” is a number the program writes itself and cannot be carried over.`, 'Carry a key the game wrote.');
      if ((r.keeps ?? []).slice(0, i).some((k) => k.key === keep.key && k.to === keep.to)) refuse('E-RECIPE', `${where}.keeps[${i}]`, `${label(r)} carries “${keep.key}” to the same collectible twice.`, 'Keep one.');
    }
    if (!refusals.some((x) => x.where.startsWith(where))) {
      const { bytes, locks } = craftSize(r, m, { detail: true });
      if (bytes > MAX_TRANSACTION_BYTES && locks + TABLE_LOCKS > ACCOUNT_LOCKS)
        refuse('E-TX-SIZE', where, `Crafting ${label(r)} would take about ${bytes} bytes and ${locks} accounts, ${locks + TABLE_LOCKS} as a v0 transaction with a lookup table: more than the ${ACCOUNT_LOCKS} a transaction can lock, so no player could craft it.`, 'Take or give fewer collectibles, or split it into two recipes.');
      else if (bytes > MAX_TRANSACTION_BYTES)
        warn('W-TX-V0', where, `Crafting ${label(r)} takes about ${bytes} bytes, more than the ${MAX_TRANSACTION_BYTES} a legacy transaction holds: js/play sends it as a v0 transaction with a lookup table the player’s wallet makes first (one to three more approvals, and the table’s rent until it is closed, which claims() offers about two minutes later). A wallet or app that sends only legacy transactions can’t craft it.`, 'To keep it a legacy transaction, take or give fewer collectibles, or split it into two recipes.');
      else if (bytes > BUDGET)
        warn('W-TX-SIZE', where, `Crafting ${label(r)} takes about ${bytes} of ${MAX_TRANSACTION_BYTES} bytes: it fits only if the player’s wallet adds nothing of its own.`, 'Take or give fewer collectibles if players see it fail.');
    }
    // The tokens a craft moves: each pay line's (its currency, else the game's), and each prize of tokens' (prizeToken).
    const moved = [...ins.filter((l) => l.takes === 'pay').map((l) => m.tokens.get(l.currency ?? m.currencyKey)), ...outs.map((l) => prizeToken(l, m))];
    const hooks = moved.filter((t) => t?.powers?.transferHook);
    if (hooks.length) warn('W-TX-SIZE', where, `${label(r)} moves ${hooks[0].symbol}, whose transfer hook adds accounts of its own to every craft; the checker cannot count them from here.`, 'Try a craft on devnet before players do.');
  }

  // ---- a set's way out: a recipe that lowers the lock of staked pieces lets them leave their farm. With a "pay"
  // line it waits while the project is paused or the platform suspends it, so when it is the only way out the pieces
  // stay locked for as long as that lasts: the one thing the platform's switch would hold that an unstake needs.
  const lockKeys = new Set(m.farms.map((f) => f.lockAttribute).filter(Boolean));
  const unbinds = m.recipes.map((r) => {
    const places = (r.in ?? []).flatMap((l) => (l.takes === 'burn' ? Array(l.count ?? 1).fill('burn') : l.takes === 'pay' ? [] : [l.takes]));
    const keys = new Set((r.raises ?? []).filter((x) => lockKeys.has(x.key) && places[x.place] === 'staked' && toBy(x.by) < 0).map((x) => x.key));
    return { r, keys, pays: (r.in ?? []).some((l) => l.takes === 'pay') };
  }).filter((u) => u.keys.size);
  for (const u of unbinds.filter((x) => x.pays)) {
    const only = [...u.keys].filter((k) => !unbinds.some((o) => !o.pays && o.keys.has(k)));
    if (only.length)
      warn('W-UNBIND-PAY', `economy.recipes.${u.r.key}`, `${label(u.r)} lets staked pieces out (it lowers “${only[0]}”) and takes a payment, and no other recipe lets them out for free. A recipe with a "pay" line can't be crafted while the project is paused or the platform suspends it, so for as long as that lasts the pieces stay locked in their farm: their lock holds the unstake.`, 'Take the "pay" line out of the way out (charge when binding instead), or add one that takes no payment.');
  }

  // ---- schedules (schedule.rs)
  for (const s of m.schedules) {
    const where = `economy.schedules.${s.key}`;
    if (fromNowSeconds(s.every, `${where}.every`) <= 0) refuse('E-SCHEDULE', `${where}.every`, `${label(s)} never comes round (every 0).`, 'Give it a time like "1d".');
    try {
      toTime(s.start, now);
    } catch (err) {
      refuse(err.code, `${where}.start`, err.message, err.fix);
    }
    const byShare = s.percent !== undefined;
    if (s.does !== 'issue' && byShare && s.amount !== undefined) refuse('E-SCHEDULE', where, `${label(s)} names both a percent and an amount.`, 'Keep one.');
    if (s.does === 'issue') {
      const p = s.pool ? pool(s.pool, `${where}.pool`) : refuse('E-SCHEDULE', where, `${label(s)} mints but does not say into which pool.`, 'Add "pool".');
      const tok = token(s.currency ?? p?.currency, `${where}.currency`);
      if (tok && !tok.gameMints) refuse('E-MINT-NOT-OURS', where, `${label(s)} mints ${tok.symbol}, but the project cannot mint it: only a token the project makes itself can be minted, so every run of it would fail.`, 'Fill the pool with a share of sales or a move from another pool, or use a token with source "project".');
      if (p && tok && p.currency !== tok.key) refuse('E-POOL-MINT', `${where}.pool`, `${label(s)} mints ${tok.symbol} into “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol}.`, `Mint into a pool of ${tok.symbol}.`);
      if (units(s.amount, tok, `${where}.amount`, `What ${label(s)} mints`) === 0n) refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} mints 0.`, 'Give it an amount above 0.');
      continue;
    }
    if (s.sealed) {
      // A sealed schedule pays from a vault of its own (`["vest", schedule]`), in `currency`: written once, never edited
      // or switched off, its last run pays whatever is left (schedule.rs).
      const tok = token(s.currency ?? m.currencyKey, `${where}.currency`);
      if (s.does !== 'pay') refuse('E-SCHEDULE', `${where}.does`, `${label(s)} is sealed, so it pays from a vault of its own: it can only "pay".`, 'Write "does": "pay", or leave "sealed" out.');
      if (s.from || s.pool) refuse('E-SCHEDULE', where, `${label(s)} is sealed: it pays from a vault of its own, not from a pool.`, 'Remove "from" and "pool"; fund it with "fund".');
      if (!(s.maxRuns > 0)) refuse('E-SCHEDULE', `${where}.maxRuns`, `${label(s)} is sealed and never ends: its last run is what pays out whatever is left (BadSchedule).`, 'Give it "maxRuns".');
      if (s.active === false) refuse('E-SCHEDULE', `${where}.active`, `${label(s)} is sealed and switched off: it could never be switched on (BadSchedule).`, 'Leave "active" out.');
      const d = destination(s.to ?? '');
      // A wallet that is a program's address (off the curve) nobody can sign for: a run would pay where nobody can
      // spend it, or pass it over (BadMove).
      if (d.kind === 'wallet' && isAddress(d.key) && !isOnCurve(addressBytes(d.key))) refuse('E-SCHEDULE', `${where}.to`, `${label(s)} is sealed and pays ${d.key}, the address of a program's account, not a wallet someone holds the key of: nobody could spend what it pays (BadMove).`, 'Pay the wallet of a person (its public key), or "account:<token account>".');
      // Its last run within 10 years of going live.
      if (s.maxRuns > 0) {
        let first = now + seconds(s.every, `${where}.every`);
        try {
          if (s.start) first = Math.max(now, toTime(s.start, now));
        } catch {
          // A start that doesn't read is refused where the schedule's times are checked.
        }
        if (first + seconds(s.every, `${where}.every`) * (s.maxRuns - 1) - now > MAX_SCHEDULE_SECONDS) refuse('E-SCHEDULE', `${where}.maxRuns`, `${label(s)} is sealed and its last run would come more than 10 years after go-live (BadSchedule).`, 'Fewer runs, a shorter "every", or an earlier "start".');
      }
      if (s.maxRuns > MAX_SEALED_RUNS) refuse('E-SCHEDULE', `${where}.maxRuns`, `${label(s)} is sealed with ${s.maxRuns} runs; a sealed schedule runs at most ${MAX_SEALED_RUNS} times (BadSchedule).`, 'Fewer runs, each larger.');
      if (d.kind === 'account') warn('W-SCHEDULE', `${where}.to`, `${label(s)} is sealed and pays a token account: it must be its holder's associated account of ${tok?.symbol ?? 'its token'}, or a token account the project holds with no close authority, when it goes live, or the write is refused (BadMove).`);
      if (d.kind === 'account' && gameVault(d.key, tok)) refuse('E-SCHEDULE', `${where}.to`, `${label(s)} is sealed and pays the game’s own vault, where open orders, prizes set aside and bids wait: no run could (BadMove).`, 'Pay a wallet.');
      if (!['wallet', 'account', 'pool', 'lottery', 'treasury', 'burn'].includes(d.kind) || !s.to) refuse('E-SCHEDULE', `${where}.to`, `${label(s)} is sealed and pays “${s.to ?? 'nowhere'}”: a sealed schedule pays a wallet, a token account, a pool, a lottery's pot, the treasury or a burn (BadMove).`, 'Write "to": "wallet:<address>".');
      // What it pays into is this spec's, and holds what it pays: a pool of its token, a lottery whose pot is in it.
      if (d.kind === 'pool') {
        const p = pool(d.key, `${where}.to`);
        if (p && tok && p.currency !== tok.key) refuse('E-POOL-MINT', `${where}.to`, `${label(s)} is sealed in ${tok.symbol}, but pays the pool “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol ?? p.currency}.`, `Pay a pool of ${tok.symbol}, or seal it in ${m.tokens.get(p.currency)?.symbol ?? p.currency}.`);
      }
      if (d.kind === 'lottery') {
        const l = m.lottery.get(d.key);
        const potKey = l?.currency ?? m.currencyKey;
        if (!l) refuse('E-REF', `${where}.to`, `There is no lottery “${d.key}”.`, 'Name one of "lotteries" by its key.');
        else if (tok && potKey !== tok.key) refuse('E-POOL-MINT', `${where}.to`, `${label(s)} is sealed in ${tok.symbol}, but pays the pot of ${label(l)}, which is in ${m.tokens.get(potKey)?.symbol ?? potKey}.`, `Pay a lottery whose pot is in ${tok.symbol}, or seal it in ${m.tokens.get(potKey)?.symbol ?? potKey}.`);
      }
      if (tok?.wsol && d.kind === 'burn') refuse('E-WSOL-BURN', `${where}.to`, `${label(s)} burns SOL, and wrapped SOL cannot be burned.`, 'Pay it somewhere instead.');
      startsFrozen(tok, `${where}.currency`, `${label(s)} (sealed)`, 'E-SCHEDULE', 'BadSchedule');
      if (tok?.powers?.permanentDelegate || tok?.powers?.nonTransferable || tok?.powers?.confidentialTransfers)
        refuse('E-SCHEDULE', `${where}.currency`, `${label(s)} is sealed in ${tok.symbol}, whose mint ${tok.powers.permanentDelegate ? 'has a permanent delegate, who could take the tokens out of the vault' : 'can’t move tokens out of a vault by a plain transfer'} (BadSchedule).`, 'Seal it in another token.');
      if (byShare && !(percent(s.percent, `${where}.percent`) > 0)) refuse('E-SCHEDULE', `${where}.percent`, `${label(s)} pays 0%.`, 'Give it a percent above 0.');
      else if (!byShare && units(s.amount, tok, `${where}.amount`, `What ${label(s)} pays`) === 0n) refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} pays nothing.`, 'Give it an amount or a percent above 0.');
      if (s.fund !== undefined) units(s.fund, tok, `${where}.fund`, `${label(s)}’s fund`);
      if (s.fundFrom === 'mint' && tok && !tok.gameMints) refuse('E-MINT-NOT-OURS', `${where}.fundFrom`, `${label(s)} is funded by minting ${tok.symbol}, which the project cannot mint.`, 'Fund it from the owner\'s wallet or a pool.');
      if (s.fundFrom?.startsWith('pool:')) pool(s.fundFrom.slice(5), `${where}.fundFrom`);
      if (d.kind === 'lottery' || d.kind === 'pool') warn('W-SCHEDULE', `${where}.to`, `${label(s)} is sealed, but pays ${d.kind === 'pool' ? 'a pool, which the authority moves' : 'a lottery’s pot, which the owner may close between rounds with nothing sold'}: a stream is as safe as where it lands.`);
      warn('W-SCHEDULE', where, `${label(s)} is sealed: once written it never closes, and nobody can edit or stop it. Check its terms before it goes live.`);
      if (!Number(s.fund ?? 0)) warn('W-SCHEDULE', `${where}.fund`, `${label(s)} starts empty: its runs pay nothing until someone sends tokens to its vault.`, 'Give it "fund".');
      if (d.kind === 'treasury') warn('W-SCHEDULE', `${where}.to`, `${label(s)} pays the treasury: the owner can change which wallet that is, so it is the owner's promise to themselves.`);
      continue;
    }
    const sourceKey = s.does === 'burn' ? s.pool : s.from;
    const source = sourceKey ? pool(sourceKey, `${where}.${s.does === 'burn' ? 'pool' : 'from'}`) : refuse('E-SCHEDULE', where, `${label(s)} ${s.does === 'burn' ? 'burns' : 'moves'} money but does not say from which pool.`, `Add "${s.does === 'burn' ? 'pool' : 'from'}".`);
    const srcToken = source && m.tokens.get(source.currency);
    if (byShare) {
      if (!(percent(s.percent, `${where}.percent`) > 0)) refuse('E-SCHEDULE', `${where}.percent`, `${label(s)} ${s.does === 'burn' ? 'burns' : 'moves'} 0%.`, 'Give it a percent above 0.');
    } else if (units(s.amount, srcToken, `${where}.amount`, `What ${label(s)} moves`) === 0n) refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} moves nothing.`, 'Give it an amount or a percent above 0.');
    if (s.does === 'burn' && srcToken?.wsol) refuse('E-WSOL-BURN', `${where}.pool`, `${label(s)} burns SOL from “${source.key}”, and wrapped SOL cannot be burned.`, 'Move it to another pool instead.');
    if (s.does === 'move') {
      const to = s.to ? pool(s.to, `${where}.to`) : refuse('E-SCHEDULE', where, `${label(s)} moves money but does not say to which pool.`, 'Add "to".');
      if (source && to && source.key === to.key) refuse('E-SCHEDULE', where, `${label(s)} moves money from “${source.key}” into itself.`, 'Name two different pools.');
      if (source && to && source.currency !== to.currency) refuse('E-POOL-MINT', where, `${label(s)} moves from “${source.key}” to “${to.key}”, which hold different tokens.`, 'Name two pools of the same token.');
    }
    if (s.does === 'pay') {
      const d = destination(s.to ?? '');
      if (d.kind === 'lottery') m.lottery.has(d.key) || refuse('E-REF', `${where}.to`, `There is no lottery “${d.key}”.`, 'Name one of "lotteries" by its key.');
      else if (!['account', 'holder', 'wallet'].includes(d.kind) || !isAddress(d.key)) refuse('E-SCHEDULE', `${where}.to`, `${label(s)} pays “${s.to ?? 'nowhere'}”: a pay schedule pays a wallet, a token account, a collectible’s holder or a lottery’s pot.`, 'Write "to": "wallet:<address>", "account:<token account address>" or "holder:<asset address>".');
      else if (d.kind === 'account' && gameVault(d.key, m.poolToken(sourceKey))) refuse('E-SCHEDULE', `${where}.to`, `${label(s)} pays the game’s own vault, where open orders, prizes set aside and bids wait: the program refuses it.`, 'Pay a pool or a wallet instead.');
      warn('W-SCHEDULE-PAY', where, `${label(s)} pays out of “${sourceKey}” on a timer, but the pool stays the game’s: the authority can still spend it, and the owner can rewrite or stop the schedule. It is a promise the project keeps, not a vesting contract the recipient holds.`, 'Make it "sealed" (with "fund" and "maxRuns") for a vesting nobody can take back.');
    }
  }

  // ---- lotteries (lottery.rs)
  for (const l of m.lotteries) {
    const where = `economy.lotteries.${l.key}`;
    const potToken = token(l.currency, `${where}.currency`);
    const ticket = l.ticketCurrency ? token(l.ticketCurrency, `${where}.ticketCurrency`) : potToken;
    confidential(potToken, `${where}.currency`, label(l), 'E-LOTTERY');
    if (ticket !== potToken) confidential(ticket, `${where}.ticketCurrency`, label(l), 'E-LOTTERY');
    startsFrozen(potToken, `${where}.currency`, label(l), 'E-LOTTERY', 'BadLottery');
    if (ticket !== potToken) startsFrozen(ticket, `${where}.ticketCurrency`, `${label(l)}’s ticket`, 'E-LOTTERY', 'BadLottery');
    if (l.ticketCurrency && ticket?.wsol) refuse('E-LOTTERY', `${where}.ticketCurrency`, 'Wrapped SOL cannot be burned as a ticket token.', 'Use SOL as the lottery currency, or use a burnable non-native ticket token.');
    if (l.ticketNft) {
      // A ticket paid with an NFT: no price, no split, no ticket token (lottery.rs BadLottery).
      if (l.price !== undefined && Number(l.price) > 0) refuse('E-LOTTERY', `${where}.price`, `${label(l)}’s tickets cost an NFT, and a price too: a ticket costs one or the other (BadLottery).`, 'Leave "price" out.');
      if (l.ticketCurrency) refuse('E-LOTTERY', `${where}.ticketCurrency`, `${label(l)}’s tickets cost an NFT: there is no ticket token (BadLottery).`, 'Leave "ticketCurrency" out.');
      if (lotterySplit(l).length) refuse('E-LOTTERY', `${where}.split`, `${label(l)}’s tickets cost an NFT: there is no ticket money to split (BadLottery).`, 'Remove the split and the cut.');
      rule(l.ticketNft.rule, `${where}.ticketNft.rule`, `${label(l)}’s ticket`);
      thenCheck(l.ticketNft.then, `${where}.ticketNft.then`, label(l));
      if (!l.noLoss) warn('W-NFT-PRICE', `${where}.ticketNft`, `${label(l)}’s tickets cost one NFT each, ${!l.ticketNft.then || l.ticketNft.then === 'burn' ? 'burned' : l.ticketNft.then.stash ? `put in “${l.ticketNft.then.stash}”` : 'given on'} once the round is drawn (the project holds it until then, and hands it back if the draw is cancelled). The pot is what the owner seeds and what its places' prizes give.`, Number(l.seed ?? 0) > 0 || (l.places ?? []).some((p) => typeof p === 'object' && p.prize) ? undefined : 'Seed the pot ("seed"), or give its places prizes.');
      else if (l.ticketNft.then) warn('W-LOTTERY', `${where}.ticketNft.then`, `${label(l)} gives every ticket back, so each NFT paid goes back to its buyer after the draw and "then" is never used.`, 'Leave "then" out.');
    } else if (l.price === undefined || units(l.price, ticket, `${where}.price`, `${label(l)}’s ticket`) === 0n)
      warn('W-LOTTERY', `${where}.price`, `${label(l)}’s tickets are free: a buyer pays only the player fee (${fromUnits(FEES.player, 9)} SOL)${l.perWallet ? '' : ', and with no "perWallet" one wallet can hold most of the tickets'}. Its pot is only what is paid into it.`, 'Give a ticket a "price" if it should cost something, or set "perWallet".');
    units(l.seed, potToken, `${where}.seed`, `${label(l)}’s seed`);
    if (seconds(l.every, `${where}.every`) <= 0 && !l.firstDraw) warn('W-LOTTERY', `${where}.every`, `${label(l)} draws once (no "every"), and the draw is due at go-live.`, 'Give it a "firstDraw" (like "publish+1d"), or an "every" to draw again and again.');
    // A round whose draw is more than five years off sells nothing (lottery.rs).
    if (seconds(l.every, `${where}.every`) > MAX_CONTEST_SECONDS) refuse('E-LOTTERY', `${where}.every`, `${label(l)} draws every ${l.every}: a draw more than 5 years off sells no ticket (SalesClosed).`, 'Draw within 5 years.');
    try {
      if (l.firstDraw && toTime(l.firstDraw, now) - now > MAX_CONTEST_SECONDS) refuse('E-LOTTERY', `${where}.firstDraw`, `${label(l)} first draws more than 5 years after go-live: no ticket sells until the draw is within 5 years (SalesClosed).`, 'Draw sooner.');
      toTime(l.firstDraw, now);
    } catch (err) {
      refuse(err.code, `${where}.firstDraw`, err.message, err.fix);
    }
    // A place takes a share of the pot, a roll of a box for its winner, or both (lottery.rs Place).
    const placed = (l.places ?? [100]).map(placeOf);
    const places = placed.map((p, i) => percent(p.percent, `${where}.places[${i}]${typeof (l.places ?? [])[i] === 'object' ? '.percent' : ''}`));
    for (const [i, p] of placed.entries()) {
      const raw = (l.places ?? [])[i];
      if (!places[i] && !p.prize) refuse('E-LOTTERY', `${where}.places[${i}]`, `${label(l)}’s place ${i + 1} wins nothing: no share of the pot and no prize (BadLottery).`, 'Give it a "percent" above 0, a "prize", or remove it.');
      if (typeof raw === 'object' && raw?.prize) prizeCheck(raw.prize, `${where}.places[${i}].prize`, `${label(l)}’s place ${i + 1}`, 'E-LOTTERY');
    }
    // A raffle's NFT: one place each, and a lottery that holds one draws once (lottery.rs).
    const held = placed.map((p) => (p.prize?.held ? p.prize.nft : null)).filter(Boolean);
    if (held.length && l.every) refuse('E-LOTTERY', `${where}.every`, `${label(l)} holds an NFT as a prize, so it draws once: a next round would sell a prize already won (BadLottery).`, 'Leave "every" out.');
    if (new Set(held).size < held.length) refuse('E-LOTTERY', `${where}.places`, `${label(l)} gives the same NFT on two places: the second could never be given (BadLottery).`, 'Name each NFT once.');
    if (held.length) warn('W-RAFFLE', `${where}.places`, `${label(l)} holds ${held.length === 1 ? 'its NFT' : 'its NFTs'} in its own stash: nobody, the owner included, can take ${held.length === 1 ? 'it' : 'them'} out while a place names ${held.length === 1 ? 'it' : 'them'}, and the winner gets ${held.length === 1 ? 'it' : 'them'} before any ticket money moves. If the NFT's collection lets someone freeze or move it (a permanent freeze, transfer or burn delegate), they could stop the prize, and every ticket's money would wait in the lottery until they let it go.`);
    if (l.minSold && l.perWallet && !l.every && l.minSold > l.perWallet * 1000) warn('W-LOTTERY', `${where}.minSold`, `${label(l)} needs ${l.minSold} tickets sold, and each wallet may hold ${l.perWallet}: it takes at least ${Math.ceil(l.minSold / l.perWallet)} wallets.`);
    const total = places.reduce((a, b) => a + b, 0);
    if (total > 10_000) refuse('E-LOTTERY', `${where}.places`, `${label(l)}’s places add up to ${total / 100}% of the pot, more than all of it.`, 'Make them add up to 100% or less.');
    else if (total < 10_000) warn('W-LOTTERY', `${where}.places`, `${label(l)}’s places add up to ${total / 100}%: the other ${(10_000 - total) / 100}% of each pot stays in it for the next round, as do places nobody won.`);
    const ticketSplit = lotterySplit(l);
    if (ticketSplit.length && l.ticketCurrency) refuse('E-LOTTERY', `${where}.split`, `${label(l)}’s tickets are burned, so there is no ticket money to split.`, 'Remove the split and the cut.');
    split(ticketSplit, potToken, `${where}.split`, { what: `${label(l)}’s ticket money`, chosen: true });
    if (ticket?.wsol && l.ticketCurrency) refuse('E-WSOL-BURN', `${where}.ticketCurrency`, `${label(l)}’s tickets are burned, and wrapped SOL cannot be burned.`, 'Sell tickets into the pot instead (no ticketCurrency).');
    // No loss (lottery.rs `returns`): every ticket goes back whole after the draw, so nothing of it can be split or burned.
    if (l.noLoss) {
      if (ticketSplit.length) refuse('E-LOTTERY', `${where}.split`, `${label(l)} gives every ticket back to its buyer after the draw, so no part of the ticket money can go anywhere else (BadLottery).`, 'Remove the split and the cut, or make it a lottery that keeps its tickets (no "noLoss").');
      if (l.ticketCurrency) refuse('E-LOTTERY', `${where}.ticketCurrency`, `${label(l)} gives every ticket back, and tickets in "ticketCurrency" are burned: a ticket can’t be both (BadLottery).`, 'Leave "ticketCurrency" out: tickets are paid in the pot’s currency and come back.');
      if (!lotteryPotFilled(l)) warn('W-LOTTERY', where, `${label(l)} gives every ticket back, so its pot holds only what is paid into it, and nothing is: its winners would win nothing.`, `Seed the pot ("seed"), send it a share of a sale or payment ("lottery:${l.key}" in a split, or a schedule that pays "to": "lottery:${l.key}"), or give its places prizes.`);
      else warn('W-LOTTERY', where, `${label(l)} loses nobody their tickets: every ticket goes back to its buyer once the round is drawn (anyone can finish each purchase), and the winners take only the pot, what is paid into it (the seed, a sponsor, a share of other sales). Ticket money waits in the lottery’s own vault until then. Tickets are not weighted by how long they were held: someone may buy most of a round’s tickets right before the draw and risk only the fees.`, 'A "perWallet" limit bounds one wallet, not many; keep the pot small next to what a late buyer would put in, or gate it (a stake, a list).');
    }
    rule(l.gate, `${where}.gate`, label(l));
    chance = true;
  }

  // ---- farms (farm.rs)
  for (const f of m.farms) {
    const where = `economy.farms.${f.key}`;
    const ofCollectibles = f.stakes === 'collectibles';
    // A farm that shares what arrives releases it to the seats over its release span (its longest lock, a day at
    // least), by weight as it is released: nobody takes at once what landed before them. A seat alone still
    // earns all that is released while it is alone, however small it is.
    const waiting = !f.rate && poolFillers(m).filter((x) => x.pool === f.rewards);
    if (waiting?.length) warn('W-FARM-FIRST', `${where}.rewards`, `${label(f)} shares what arrives in “${f.rewards}” (${waiting.map((x) => x.by).join(', ')}), released over ${releaseWords(f)} as seats stay: whoever stakes first is credited all that is released while they are the only one in, even with 1 unit.`, 'Have the owner hold a small seat from the start, or tell stakers early ones share the first rewards among few.');
    // A rewards mint that keeps a fee on transfers rounds each fee up, by less than a base unit (Token-2022). A sharing
    // farm's refresh that changes no weight releases only a chunk at a time, ⌈1,000,000 / fee_bps⌉ base units or a
    // hundredth of its line, so the rounding stays small; a fixed rate from a pool pays on every move, with no chunk.
    const feePercent = Number(m.tokens.get(m.pool.get(f.rewards)?.currency)?.powers?.transferFeePercent ?? 0);
    // A fee finer than a hundredth of a percent is refused with its token (E-PERCENT).
    const feeBps = toBps(feePercent);
    if (feeBps > 0 && !f.rate?.minted && !f.unpaid) {
      const chunk = Math.ceil(1_000_000 / feeBps);
      warn('W-FARM-FEE', `${where}.rewards`, f.rate
        ? `${label(f)} pays its rate from “${f.rewards}”, whose token keeps ${feePercent}% of every transfer, each fee rounded up: every move pays from the pool and can lose up to a base unit to the rounding, so a refresh anyone can send every few seconds turns a slow rate into fees (they go to the mint’s fee collector, not to anyone in the farm).`
        : `${label(f)}’s rewards keep ${feePercent}% of every transfer, each fee rounded up: a refresh that changes no seat’s weight releases a chunk at a time, ${chunk.toLocaleString('en-US')} base units or a hundredth of what is being released if that is less, the rest waiting for the next move that releases it; a release of a few base units a second, or a watched NFT moved back and forth with a refresh each time, can still lose a base unit a move to the rounding.`,
        'Give the rewards token enough decimals that a second’s release is many base units, or use one without a fee.');
    }
    if (!ofCollectibles) {
      const tok = token(f.stakes, `${where}.stakes`);
      if (tok?.wsol) warn('W-FARM', `${where}.stakes`, `${label(f)} stakes SOL: players stake wrapped SOL, which their wallet makes for them.`);
      if (f.item) refuse('E-FARM', `${where}.item`, `${label(f)} stakes a token, so it takes no item.`, 'Remove "item", or make it a farm of collectibles ("stakes": "collectibles").');
      if (f.custody === 'watch') refuse('E-FARM', `${where}.custody`, `${label(f)} stakes a token: its boosters can’t be left free and watched, or one sold could keep boosting.`, 'Use "custody": "escrow" or "freeze", or make it a farm of collectibles.');
    }
    // Early exits, unbonding and tolls (farm.rs): a fee leaves to a burn or a pool of its token, checked once at open.
    const exits = (f.tiers ?? []).some((t) => Number(t.exitFee ?? 0) > 0);
    const sinkOk = (to, at, tokenKey, what) => {
      if (to === 'burn') {
        if (m.tokens.get(tokenKey)?.wsol) refuse('E-WSOL-BURN', at, `${label(f)} burns ${what} in SOL, and wrapped SOL cannot be burned: every exit or harvest that owes it would fail.`, 'Send it to a pool instead.');
        return;
      }
      const p = pool(String(to).slice(5), at);
      if (p && tokenKey && p.currency !== tokenKey) refuse('E-POOL-MINT', at, `${label(f)} sends ${what} to “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol ?? p.currency}, not ${m.tokens.get(tokenKey)?.symbol ?? tokenKey} (WrongMint).`, `Send it to a pool of ${m.tokens.get(tokenKey)?.symbol ?? tokenKey}.`);
    };
    if (ofCollectibles && exits) refuse('E-FARM', `${where}.tiers`, `${label(f)} stakes collectibles: there is no stake to take an exit fee from (BadFarm). A collectible leaves early by a recipe that lowers its lock.`, 'Remove "exitFee", and give the farm a "lockAttribute" and a recipe that lowers it.');
    if (ofCollectibles && f.unbond) refuse('E-FARM', `${where}.unbond`, `${label(f)} stakes collectibles: unbonding is a stake of tokens' wait (BadFarm).`, 'Remove "unbond".');
    else fourByteSeconds(f.unbond, `${where}.unbond`);
    if (!ofCollectibles && exits && !f.exitFeeTo) refuse('E-FARM', `${where}.exitFeeTo`, `${label(f)} has an early-exit fee but does not say where it goes (BadFarm).`, 'Add "exitFeeTo": "burn" or "pool:<key>".');
    if (!ofCollectibles && f.exitFeeTo) sinkOk(f.exitFeeTo, `${where}.exitFeeTo`, f.stakes, 'its exit fees');
    (f.tiers ?? []).forEach((t, i) => percent(t.exitFee, `${where}.tiers[${i}].exitFee`));
    if (f.toll) {
      sinkOk(f.toll.to, `${where}.toll.to`, m.pool.get(f.rewards)?.currency, 'its toll');
      percent(f.toll.percent, `${where}.toll.percent`);
    }
    if (!ofCollectibles && exits) warn('W-FARM', `${where}.tiers`, `${label(f)}’s tiers with an early exit keep their rewards until the lock has run (no harvest or compound before), and leaving early gives up what the seat is owed as well as the fee: ${f.rate ? (f.rate.minted ? 'burned' : `sent back to “${f.rewards}”`) + ' in the same move, never to the other seats' : `back to “${f.rewards}”, released again with the rest`}.`);
    if (f.exitFeeTo === `pool:${f.rewards}`) warn('W-FARM', `${where}.exitFeeTo`, `${label(f)} sends early-exit fees to its own rewards pool: the stakers who stay share them.`);
    if (f.unpaid) warn('W-FARM', `${where}.rewards`, `${label(f)} pays nothing: its rewards pool “${f.rewards}” is opened empty, for staking only to qualify (a stake gate reads it).`);
    if (ofCollectibles && f.item) {
      const it = item(f.item, `${where}.item`);
      if (it && it.kind === 'normal') refuse('E-FARM', `${where}.item`, `${label(f)} takes ${label(it)}, a normal item: only collectibles can be staked.`, `Make ${label(it)} a collectible.`);
      if (it?.soulbound && (f.custody ?? 'escrow') === 'escrow') refuse('E-FARM', `${where}.custody`, `${label(f)} holds collectibles in escrow, and ${label(it)} is soulbound: it can’t move to the game.`, 'Use "custody": "freeze", or a collectible that is not soulbound.');
    }
    if (f.custody === 'watch' && listOf(f.growth).some((g) => g.streak)) refuse('E-FARM', `${where}.growth`, `${label(f)} watches NFTs left free in their wallets and counts a streak: one leaves by being moved, with nothing to set its streak back to 0, so the program refuses it (BadFarm).`, 'Use "custody": "escrow" or "freeze" for a streak, or drop "streak".');
    if (f.custody === 'watch') warn('W-FARM-CUSTODY', `${where}.custody`, `${label(f)} watches NFTs left free in their wallets: one sold while staked stops earning for its staker (what its seat was owed ${f.rate ? (f.rate.minted ? 'is burned' : `goes back to “${f.rewards}”`) + ', never to the other seats' : `goes back to “${f.rewards}”, released again with the rest`}), and its new holder can take the seat over, paying the last staker back the seat’s rent.`);
    else if (f.custody === 'freeze') warn('W-FARM-CUSTODY', `${where}.custody`, `${label(f)} locks NFTs in their wallets (a Core freeze, Token Metadata’s lock, a compressed NFT’s freeze), with the game the only key that unlocks them. For ordinary Core assets, issuer metadata or plugin growth can make unfreezing fail; a soulbound asset needs no extra freeze. This also applies to token-seat boosters.`, 'Use escrow for transferable collectibles, or retain freeze only with a trusted issuer and controlled metadata changes.');
    else if (ofCollectibles || (f.boosts ?? []).length) warn('W-FARM-CUSTODY', `${where}.custody`, `${label(f)} escrows collectibles. This avoids Core’s unfreeze operation, but issuer-controlled transfer rules can still block return. Soulbound collectibles require explicit freeze custody.`);
    pool(f.rewards, `${where}.rewards`);
    const tiers = f.tiers ?? [{ lock: 0, multiplier: 1 }];
    if (tiers.length > LIMITS.tiers) refuse('E-FARM', `${where}.tiers`, `${label(f)} has ${tiers.length} lock tiers; a farm has at most ${LIMITS.tiers}.`, 'Merge tiers.');
    for (const [i, t] of tiers.entries()) {
      fourByteSeconds(t.lock, `${where}.tiers[${i}].lock`);
      const bps = Math.round((t.multiplier ?? 1) * 10_000);
      if (bps <= 0 || bps > LIMITS.maxTierBps) refuse('E-FARM', `${where}.tiers[${i}].multiplier`, `${label(f)}’s tier ${i} multiplies by ${t.multiplier}: a tier is above 0 and at most x11.`, 'Use a multiplier above 0, up to 11.');
      else if (bps < 10_000) warn('W-FARM', `${where}.tiers[${i}].multiplier`, `${label(f)}’s tier ${i} weighs x${t.multiplier}, less than what it stakes: a flexible tier that earns less.`);
    }
    if ((f.boosts ?? []).length > LIMITS.boosts) refuse('E-FARM', `${where}.boosts`, `${label(f)} has ${f.boosts.length} boosts; a farm has at most ${LIMITS.boosts}.`, 'Merge boosts.');
    for (const [i, b] of (f.boosts ?? []).entries()) {
      rule(b.when, `${where}.boosts[${i}].when`, `${label(f)}’s boost`);
      effect(b.add, `${where}.boosts[${i}].add`, `${label(f)}’s boost`);
    }
    boostPercent(f.maxBoostPercent, `${where}.maxBoostPercent`);
    if ((f.boosts ?? []).length && !(f.maxBoostPercent > 0)) warn('W-FARM', `${where}.maxBoostPercent`, `${label(f)} has boosts but no "maxBoostPercent", so they add nothing (the cap is 0).`, 'Set "maxBoostPercent", for example 100 (at most double).');
    // A fixed rate (`rate`), growth (`growth`) and missions (tiers' `prize`).
    const rewardsToken = m.poolToken(f.rewards);
    const growths = listOf(f.growth);
    const prized = tiers.some((t) => t.prize);
    const rolls = tiers.some((t) => t.roll);
    if (f.rate) {
      const perDay = units(f.rate.perDay, rewardsToken, `${where}.rate.perDay`, `${label(f)}’s rate`);
      if (!(Number(f.rate.perDay) > 0)) {
        if (!growths.length && !prized && !rolls) warn('W-FARM', `${where}.rate.perDay`, `${label(f)}’s fixed rate pays nothing a day, and it grows nothing, gives no prize and rolls no mission: staking there only counts (a stake gate can read it).`, 'Set "perDay" above 0, or give it "growth", a mission prize or a mission roll.');
      } else if (!ofCollectibles && perDay !== null && (perDay * 1_000_000n) / 10n ** BigInt(m.tokens.get(f.stakes)?.decimals ?? 0) === 0n) warn('W-FARM', `${where}.rate.perDay`, `${label(f)}’s rate of ${f.rate.perDay} a day is less than one base unit for each 1,000,000 base units staked.`, 'Raise "perDay".');
      if (f.rate.minted && rewardsToken && !rewardsToken.gameMints) refuse('E-MINT-NOT-OURS', `${where}.rate.minted`, `${label(f)} mints its rewards, but the project cannot mint ${rewardsToken.symbol}.`, 'Pay the rate from the pool ("minted": false), or reward in a token with source "project".');
      if (!f.rate.minted) warn('W-FARM-RATE', `${where}.rate`, `${label(f)} pays its fixed rate from “${f.rewards}” while it lasts: what the pool can’t cover is not owed later, and every seat earns less once it runs dry.`, 'Keep the pool filled (a schedule), or mint the rewards.');
      else rateRoom(f, warn, m);
    }
    if (growths.length > LIMITS.growths) refuse('E-FARM', `${where}.growth`, `${label(f)} grows ${growths.length} things; a farm grows at most ${LIMITS.growths}.`, 'Merge them.');
    const names = growths.flatMap((g) => [g.attribute ?? 'xp', ...((g.levels ?? []).length ? [g.level ?? 'level'] : [])]);
    if (names.some((n, i) => names.indexOf(n) !== i)) refuse('E-FARM', `${where}.growth`, `${label(f)} grows the same attribute twice (${names.join(', ')}): each growth writes names of its own.`, 'Give each growth its own "attribute" (and "level").');
    for (const [i, g] of growths.entries()) {
      const at = Array.isArray(f.growth) ? `${where}.growth[${i}]` : `${where}.growth`;
      const own = RESERVED_ATTRIBUTES;
      const [points, level] = [g.attribute ?? 'xp', g.level ?? 'level'];
      if (own.includes(points) || (g.levels?.length && own.includes(level)) || ((g.levels ?? []).length && points === level))
        refuse('E-FARM', at, `${label(f)} writes its points under “${points}” and its level under “${level}”: two names of the game’s own, not the program’s (${own.join(', ')}).`, 'Use names such as "xp" and "level".');
      if ((g.levels ?? []).some((n, i, all) => i > 0 && n <= all[i - 1])) refuse('E-FARM', `${at}.levels`, `${label(f)}’s levels must need more points each.`, 'List the points each level needs, rising: [100, 300, 600].');
      if (!ofCollectibles && !(f.boosts ?? []).length) warn('W-FARM', at, `${label(f)} stakes a token: only a collectible put on a seat as its booster grows.`);
    }
    if (f.runs !== undefined) {
      const runs = fromNowSeconds(f.runs, `${where}.runs`);
      for (const [i, t] of tiers.entries())
        if (toSeconds(t.lock ?? 0) > 0 && toSeconds(t.lock ?? 0) >= runs) warn('W-FARM', `${where}.tiers[${i}].lock`, `${label(f)} runs ${f.runs}, and its tier ${i} locks ${t.lock}: nobody could ever take it (a seat must be free by the farm’s end, and the farm takes none at its end).`, 'Shorten the lock, or let the farm run longer.');
      const end = farmEndWords(f);
      warn('W-FARM', `${where}.runs`, `${label(f)} runs ${f.runs} from when it goes live: it takes no stake at its end or after it (nor one at a tier whose lock would run past it), and pays and grows nothing more; seats leave and harvest what they were owed as before.${end ? ` It shares its pool: ${end}.` : ''}`);
    }
    // Missions' prizes (prize.rs): a tier's, given as a collectible that stayed its lock leaves its seat.
    if (f.prize) refuse('E-FARM', `${where}.prize`, `${label(f)} names where its prizes come from: each tier names its whole prize.`, 'Move it into each tier: "prize": { "gives": "tokens", "amount": n, "from": "mint" or "pool:<key>" } (or an item, an NFT, a roll of a chest).');
    for (const [i, t] of tiers.entries()) {
      if (!t.prize) continue;
      const at = `${where}.tiers[${i}].prize`;
      if (typeof t.prize !== 'object') refuse('E-FARM', at, `${label(f)}’s tier ${i} pays ${t.prize}: a tier names its whole prize.`, 'Write "prize": { "gives": "tokens", "amount": n, "from": "mint" or "pool:<key>" }.');
      else prizeCheck(t.prize, at, `${label(f)}’s tier ${i}`, 'E-FARM');
      if (!ofCollectibles) refuse('E-FARM', at, `${label(f)} stakes a token: a mission’s prize is for a collectible that stays its tier’s lock.`, 'Make it a farm of collectibles, or remove the prizes.');
      if (toSeconds(t.lock ?? 0) === 0) refuse('E-FARM', at, `${label(f)}’s tier ${i} gives a prize with no lock: staking and leaving at once would give it again and again.`, 'Give the mission a lock, such as "1d".');
    }
    for (const [i, t] of tiers.entries()) {
      if (!t.roll) continue;
      const at = `${where}.tiers[${i}].roll`;
      if (!ofCollectibles) refuse('E-FARM', at, `${label(f)} stakes a token: a mission’s roll is for a collectible leaving its seat.`, 'Make it a farm of collectibles, or remove the roll.');
      if (toSeconds(t.lock ?? 0) === 0) refuse('E-FARM', at, `${label(f)}’s tier ${i} rolls with no lock: staking and leaving at once would roll it again and again.`, 'Give the mission a lock, such as "1d".');
      if (!m.box.get(t.roll)) refuse('E-FARM', at, `${label(f)}’s tier ${i} rolls “${t.roll}”, which is no box.`, 'Name a box of this spec.');
      else if (!m.box.get(t.roll).rollsOn) refuse('E-FARM', at, `${label(f)}’s tier ${i} rolls “${t.roll}” on the NFT leaving it, but the box rolls on none: a chest the mission brings back is its prize.`, `Write "prize": { "gives": "roll", "box": "${t.roll}" } instead, or give the box "rollsOn".`);
      else if ((f.custody ?? 'escrow') === 'watch' && (m.box.get(t.roll).outcomes ?? []).some((o) => o.then && o.then !== 'back'))
        warn('W-ROLL-CUSTODY', at, `${label(f)} watches NFTs left free, and its mission’s box can burn or give one away: an NFT its staker sold before leaving is never rolled (it earns nothing either); one still held is taken into the game’s hands for the roll.`);
    }
    // The times a farm of collectibles keeps on the NFT: its lock and an upkeep.
    const times = [['lockAttribute', f.lockAttribute], ['upkeepAttribute', f.upkeepAttribute]].filter(([, key]) => key !== undefined);
    for (const [field, key] of times) {
      if (!ofCollectibles) refuse('E-FARM', `${where}.${field}`, `${label(f)} stakes a token, which has nowhere to keep a time: only a farm of collectibles writes one on what it stakes.`, `Remove "${field}", or make it a farm of collectibles.`);
      if (RESERVED_ATTRIBUTES.includes(key)) refuse('E-FARM', `${where}.${field}`, `“${key}” is a number the program writes itself.`, 'Use a name of the game’s own, such as "free_at" or "upkeep_until".');
      if (names.includes(key)) refuse('E-FARM', `${where}.${field}`, `${label(f)} grows “${key}” and keeps a time under it too.`, 'Give the time a name of its own.');
    }
    if (f.lockAttribute !== undefined && f.lockAttribute === f.upkeepAttribute) refuse('E-FARM', `${where}.upkeepAttribute`, `${label(f)} keeps its lock and its upkeep under the same name, “${f.lockAttribute}”.`, 'Give each its own name.');
    if (f.upkeepAttribute !== undefined && ofCollectibles) {
      const sells = m.recipes.some((r) => (r.raises ?? []).some((x) => x.key === f.upkeepAttribute && x.fromNow && toBy(x.by) > 0));
      warn('W-FARM-UPKEEP', `${where}.upkeepAttribute`, `${label(f)} pays and grows a collectible only until the time under “${f.upkeepAttribute}”: one staked dry counts for nothing until it is topped up and its seat refreshed, and what a seat is credited after its upkeep runs out is not paid (in a farm at a fixed rate it is burned or goes back where the rate came from, never to the other seats; in a farm that shares its pool it goes back to the pool and is released again with the rest).${sells ? '' : ' Nothing in this spec sells it: only the authority (Set) could.'}`, sells ? undefined : `Add a recipe that raises "${f.upkeepAttribute}" with "fromNow": true.`);
      // A known limit of the program: a recipe with a pay line waits while the project is paused or suspended
      // (craft.rs), and the upkeep's clock keeps running. With every top-up paid and capped below a mission's lock, a
      // switch on for longer than a player could top up ahead dries the seat, and a seat that ran dry before its lock
      // ended never brings its tier's prize (farm.rs: `stayed`), even once it is topped up again.
      const refuels = m.recipes.filter((r) => r.active !== false).flatMap((r) => (r.raises ?? []).filter((x) => x.key === f.upkeepAttribute && x.fromNow && toBy(x.by) > 0).map((x) => ({ r, x })));
      const prized = tiers.filter((t) => t.prize && toSeconds(t.lock ?? 0) > 0);
      if (refuels.length && prized.length && refuels.every(({ r }) => (r.in ?? []).some((l) => l.takes === 'pay'))) {
        const ahead = Math.max(...refuels.map(({ x }) => (x.upTo === undefined ? Infinity : toSeconds(x.upTo))));
        const lock = prized.reduce((most, t) => (toSeconds(t.lock) > toSeconds(most.lock) ? t : most));
        if (ahead < toSeconds(lock.lock))
          warn('W-FARM-REFUEL', `${where}.upkeepAttribute`, `${label(f)}’s missions bring a prize (a ${lock.lock} lock) only to a seat whose “${f.upkeepAttribute}” never ran out, and every recipe that tops it up takes a payment, which waits while the project is paused or suspended (a switch the platform holds too), while the upkeep keeps running down. A player can top it up only ${refuels.map(({ r, x }) => `${x.upTo} ahead with ${label(r)}`).join(', ')}, so a switch on for longer than that dries the seat: its mission’s prize is lost for good, and what it was credited after the lapse is given back, even once it is topped up again.`, `Add a top-up recipe with no "pay" line (one paid in nothing goes through while the project is suspended), or let a player top up a whole mission ahead ("upTo" of at least ${lock.lock}, longer than any suspension you would expect).`);
      }
    }
    if (f.gate && !ofCollectibles) refuse('E-FARM', `${where}.gate`, `${label(f)} stakes a token: a gate only says which collectibles a farm of collectibles takes.`, 'Remove the gate, or use a boost to favour holders.');
    const gates = listOf(f.gate);
    if (gates.length > LIMITS.gates) refuse('E-FARM', `${where}.gate`, `${label(f)}’s gate has ${gates.length} rules; a farm’s has at most ${LIMITS.gates}.`, 'Keep the rules that matter.');
    for (const [i, r] of gates.entries()) rule(r, Array.isArray(f.gate) ? `${where}.gate[${i}]` : `${where}.gate`, label(f));
    // No lock rule for rewards that land: a sharing farm releases each over its release span, and a fixed rate pays by
    // the second, so a stake just before a reward lands and gone right after takes only what was released meanwhile.
    // A farm whose rewards are a share of what players pay hands holders the project's revenue.
    const revenue = fillers.filter((x) => x.pool === f.rewards && /^(box|item|payment):/.test(x.by));
    if (revenue.length)
      warn('W-REVENUE-SHARE', where, `${label(f)} pays stakers a share of what players spend (${revenue.map((x) => x.by).join(', ')}). Paying holders out of a project’s revenue is what regulators look at when they decide whether a token is a security.`, 'Fine on devnet. Before mainnet, ask counsel, or reward stakers from emissions (a schedule that mints a game token) rather than from sales.');
  }

  // ---- contests (contest.rs)
  for (const c of m.contests) {
    const where = `economy.contests.${c.key}`;
    const tok = token(c.currency, `${where}.currency`);
    confidential(tok, `${where}.currency`, label(c), 'E-CONTEST');
    startsFrozen(tok, `${where}.currency`, label(c), 'E-CONTEST', 'BadContest');
    // Entries close no later than the result is due, and with deciders before it: a decider's verdict is taken only
    // once entries close (contest.rs, BadContest). With deciders, a side left out is an hour from the other (plan.mjs
    // `contestArgs`).
    const closes = seconds(c.entriesClose, `${where}.entriesClose`);
    const due = seconds(c.resultDue, `${where}.resultDue`);
    if (c.entriesClose !== undefined && c.resultDue !== undefined && closes > due)
      refuse('E-CONTEST', where, `${label(c)}’s entries close after its result is due (BadContest).`, 'Close entries before the result is due.');
    else if (Math.max(closes, due) > MAX_CONTEST_SECONDS)
      refuse('E-CONTEST', where, `${label(c)}’s result is due more than 5 years after it opens: the program refuses to open it (BadContest).`, 'Have its result due within 5 years.');
    else if ((c.deciders ?? []).length && c.entriesClose !== undefined && c.resultDue !== undefined && closes >= due)
      refuse('E-CONTEST', where, `${label(c)} has deciders, whose verdict is taken only once entries close, and its entries close when its result is due: the program refuses to open it (BadContest).`, 'Close entries before the result is due, or leave one of "entriesClose" and "resultDue" out (an hour apart).');
    if (c.sideNames && c.sideNames.length !== c.sides) warn('W-CONTEST', `${where}.sideNames`, `${label(c)} has ${c.sides} sides and ${c.sideNames.length} names for them.`, 'Name each side once.');
    split(c.split, tok, `${where}.split`, { what: label(c) });
    rule(c.gate, `${where}.gate`, label(c));
    const cp = c.prize ? prizeCheck(c.prize, `${where}.prize`, label(c), 'E-CONTEST') : null;
    // One NFT, the last units of an item, a pool's prize: the winning entries share it in the order they are claimed.
    const scarce = cp && (cp.gives === 'nft' || (cp.gives === 'item' && Number(m.item.get(cp.item)?.supply ?? 0) > 0) || prizePool(cp));
    if (scarce) warn('W-CONTEST-PRIZE', `${where}.prize`, `${label(c)} gives ${prizeWords(cp, m)} to each winning entry as it is claimed: ${cp.gives === 'nft' ? 'there is one, so the first winning entry claimed takes it and the others get none' : 'when it runs short, the entries claimed first take it'}, and anyone may claim the entries in any order.`, cp.gives === 'nft' ? 'For one winner, use a contest whose sides are the players (a gate of wallets), or give a roll of a box instead.' : 'Keep enough for every winner, or give a roll of a box.');
    if (c.stakeNft) {
      // A pot of NFTs: no split and no stake of tokens (contest.rs BadContest).
      if (sharesOf(c.split).length) refuse('E-CONTEST', `${where}.split`, `${label(c)}’s entries stake NFTs: there is no money to take shares of (BadContest).`, 'Remove the split.');
      if (c.stake !== undefined) refuse('E-CONTEST', `${where}.stake`, `${label(c)}’s entries stake one NFT each, not tokens (BadContest).`, 'Remove "stake".');
      rule(c.stakeNft, `${where}.stakeNft`, `${label(c)}’s stake`);
      warn('W-NFT-PRICE', `${where}.stakeNft`, `${label(c)}’s entries each stake one NFT, and the NFTs are the pot: each winning entry takes its own back and one loser’s, in the order the entries are claimed (anyone may claim them), and the losers’ NFTs the winners leave go to whoever opened it. The project holds every NFT until its entry is claimed.`);
    }
    const deciders = c.deciders ?? [];
    if (deciders.length > LIMITS.deciders) refuse('E-CONTEST', `${where}.deciders`, `${label(c)} names ${deciders.length} deciders; a contest takes at most ${LIMITS.deciders}.`, 'Name fewer keys.');
    deciders.forEach((k, i) => isAddress(k) || refuse('E-REF', `${where}.deciders[${i}]`, `${label(c)}’s decider “${k}” is not a public address.`, 'Write the results server’s public key (never its private key).'));
    // A contest of NFTs counts its pot in NFTs, so its least pot is a whole number of them.
    const minPot = c.stakeNft ? wholeCount(c.minPot) : units(c.minPot, tok, `${where}.minPot`, `${label(c)}’s least pot`);
    if (c.stakeNft && minPot === null) refuse('E-CONTEST', `${where}.minPot`, `${label(c)}’s entries stake NFTs, so its least pot counts NFTs: ${c.minPot} is not a whole number of them.`, 'Write how many NFTs its sides must hold, like 4.');
    units(c.stake, tok, `${where}.stake`, `${label(c)}’s stake`);
    if (c.sides === 1) {
      if (!minPot) warn('W-CONTEST', `${where}.minPot`, `${label(c)} has one side and no goal: it is a collection that pays its split whatever it raises.`, 'Give it a "minPot": short of it, everyone takes their money back (an all-or-nothing crowdfund).');
      if (sharesOf(c.split).reduce((n, s) => n + (s.bps ?? 0), 0) < 10_000) warn('W-CONTEST', `${where}.split`, `${label(c)} has one side, so its backers share back what its split leaves: a crowdfund’s split sends all of it to whoever it funds.`, 'Send 100% to the wallet it funds.');
    } else warn('W-CHANCE-PRIZE', where, `${label(c)} lets players put money on an outcome: that is betting, which is regulated in most places once it is real money (state rules on prediction markets are in flux). loot runs on devnet only.`, 'Before mainnet: counsel, an age and region gate, and a name that does not call it an investment.');
  }

  // ---- auctions (auction.rs)
  for (const a of m.auctions) {
    const where = `economy.auctions.${a.key}`;
    const tok = token(a.currency, `${where}.currency`);
    confidential(tok, `${where}.currency`, label(a), 'E-AUCTION');
    startsFrozen(tok, `${where}.currency`, label(a), 'E-AUCTION', 'BadAuction');
    const reserve = a.bidNfts ? BigInt(Number.isInteger(a.reserve) ? a.reserve : 1) : units(a.reserve, tok, `${where}.reserve`, `${label(a)}’s reserve`);
    if (a.bidNfts) {
      // Bids of NFT bundles (auction.rs): no split, and a reserve a bid of up to four can reach.
      if (a.reserve !== undefined && !(Number.isInteger(a.reserve) && a.reserve >= 1 && a.reserve <= 3)) refuse('E-AUCTION', `${where}.reserve`, `${label(a)}’s bids are bundles of NFTs: its reserve counts NFTs, from 1 to 3, the most one bid holds (BadAuction).`, 'Write a reserve of 1 to 3.');
      if (sharesOf(a.split).length) refuse('E-AUCTION', `${where}.split`, `${label(a)}’s bids are NFTs: there is no money to take shares of (BadAuction).`, 'Remove the split.');
      rule(a.bidNfts, `${where}.bidNfts`, `${label(a)}’s bids`);
      outsideAttribute(a.bidNfts, `${where}.bidNfts`, `${label(a)}’s bids`);
      warn('W-NFT-PRICE', `${where}.bidNfts`, `${label(a)}’s bids are bundles of up to three Core or Token Metadata NFTs (never compressed ones): the bundle with the most wins, a topped bundle goes back to its bidder at once, and the winning NFTs go to ${a.lot?.asset ? 'the seller' : 'the treasury'}. The least raise is in NFTs too (always at least one more).`);
    }
    percent(a.minRaise, `${where}.minRaise`);
    const runs = seconds(a.runs, `${where}.runs`);
    const extend = seconds(a.extendBy ?? '10m', `${where}.extendBy`);
    let start = now;
    try {
      start = toTime(a.start, now);
    } catch (err) {
      refuse(err.code, `${where}.start`, err.message, err.fix);
    }
    if (runs === 0) refuse('E-AUCTION', `${where}.runs`, `${label(a)} runs for no time at all: its end must come after its start (BadAuction).`, 'Give it a time to run, such as "24h".');
    else if (start + runs <= now) refuse('E-AUCTION', `${where}.start`, `${label(a)} would be over before it goes live (BadAuction).`, 'Start it at "publish", or later.');
    // Nothing but a higher bid hands a high bid back before the end: an end, or a push of it, more than five years off
    // would hold the bid and the lot that long, and the program refuses it (auction.rs).
    if (runs > 0 && start + runs - now > MAX_CONTEST_SECONDS) refuse('E-AUCTION', `${where}.${start - now >= MAX_CONTEST_SECONDS ? 'start' : 'runs'}`, `${label(a)} ends more than 5 years after go-live: until its end only a higher bid hands a high bid back, so a bid and the lot would be held that long (BadAuction).`, 'End it within 5 years.');
    if (extend > MAX_CONTEST_SECONDS) refuse('E-AUCTION', `${where}.extendBy`, `${label(a)} moves its end by more than 5 years after a bid: one bid would hold the lot and itself that long (BadAuction).`, 'Use an extension of minutes, such as "10m".');
    if (a.lot?.item) {
      const it = item(a.lot.item, `${where}.lot.item`);
      if (it && it.active === false) refuse('E-AUCTION', `${where}.lot.item`, `${label(a)} sells ${label(it)}, which is switched off (LotRefused).`, `Switch ${label(it)} on.`);
      if (it?.kind === 'normal') warn('W-AUCTION', `${where}.lot.item`, `${label(a)} sells ${label(it)}, a normal item: the program names the winner, and the game’s backend must deliver it from the receipt.`);
    } else if (a.lot?.roll) {
      // A mystery lot: open_auction refuses one whose box is not written (LotRefused).
      prizeBox(a.lot.roll, `${where}.lot.roll`, label(a), 'E-AUCTION');
      warn('W-AUCTION', `${where}.lot.roll`, `${label(a)} sells a roll of a box: the winner pays for whatever it rolls, and gets nothing more if what it gives has run out by the end (an empty stash, a sold-out item).`, 'Keep a stash or item for this auction alone, and say on the page what the box can give, with its odds.');
      randomItems = true;
    } else if (a.lot?.asset) {
      if (!a.lot.collection && !m.live.project) refuse('E-AUCTION', `${where}.lot.asset`, `${label(a)} sells a collectible of the game’s own collection, which is only made when the economy goes live: there is none to sell yet.`, 'Sell a new unit of an item ({ "item": key }) now, or add this auction once the economy is live and your wallet holds the collectible.');
    }
    split(a.split, tok, `${where}.split`, { what: label(a) });
    rule(a.gate, `${where}.gate`, label(a));
    if (extend > 0 && extend >= runs && runs > 0) warn('W-AUCTION', `${where}.extendBy`, `${label(a)} moves its end by ${a.extendBy ?? '10m'} after every bid, as long as it runs at all: every bid restarts the clock.`, 'Use an extension much shorter than the run, such as "10m" for a day.');
    if (reserve === 0n && !a.bidNfts) warn('W-AUCTION', `${where}.reserve`, `${label(a)} has no reserve: one bid of the smallest unit wins it if nobody else bids.`, 'Set "reserve" to the least you would sell it for.');
    const sameItem = m.auctions.filter((x) => a.lot?.item && x.lot?.item === a.lot.item);
    const it = a.lot?.item && m.item.get(a.lot.item);
    if (it?.supply && sameItem.length > it.supply && sameItem[0] === a)
      refuse('E-AUCTION', `${where}.lot.item`, `${sameItem.length} auctions sell ${label(it)}, and only ${it.supply} can ever be made: each auction keeps its unit from the moment it opens (LotRefused).`, `Raise ${label(it)}’s supply, or auction fewer.`);
    warn('W-AUCTION-SHILL', where, `Anyone can bid on ${label(a)}, the seller and the project included, to push the price up (shill bidding); the program cannot tell them apart.`, 'Set an honest reserve instead, and say so where players bid.');
  }

  // ---- holds (hold.rs)
  for (const h of m.holds) {
    const where = `economy.holds.${h.key}`;
    const it = item(h.item, `${where}.item`);
    if (it && (!isCollectible(it) || it.soulbound)) refuse('E-HOLD', `${where}.item`, `${label(h)} holds ${label(it)}, which is ${it.soulbound ? 'soulbound' : 'not a collectible'}: only a collectible that can move can be held.`, 'Hold a collectible that is not soulbound.');
    seconds(h.for, `${where}.for`);
    if (h.until !== undefined) {
      try {
        if (toTime(h.until, now) < now) warn('W-HOLD', `${where}.until`, `${label(h)}’s holds end before the economy goes live: each one is over at once, and anyone can send its NFT home.`);
      } catch (err) {
        refuse(err.code, `${where}.until`, err.message, err.fix);
      }
    }
  }

  // ---- grants (grant.rs)
  for (const g of m.grants) {
    const where = `economy.grants.${g.key}`;
    const old = g.gives ?? {};
    if (g.prize && g.gives) refuse('E-GRANT', `${where}.gives`, `${label(g)} names a "prize" and "gives": one is its prize.`, 'Keep "prize".');
    if (!g.prize && [old.item, old.pool, old.roll].filter(Boolean).length > 1) refuse('E-GRANT', `${where}.gives`, `${label(g)} gives more than one thing.`, 'Give one "prize".');
    else if (!g.prize && !g.gives) refuse('E-GRANT', `${where}.prize`, `${label(g)} gives nothing.`, 'Add a "prize": { "gives": "item", "item": key }, { "gives": "tokens", … }, { "gives": "nft", … } or { "gives": "roll", "box": key }.');
    const gives = prizeCheck(g.prize ?? g.gives, `${where}.${g.prize ? 'prize' : 'gives'}`, label(g), 'E-GRANT') ?? {};
    const vouchers = g.vouchers ?? [];
    const keys = g.keys ?? [];
    const l = g.limits ?? {};
    const open = !vouchers.length && !keys.length && !(g.list ?? []).length;
    // List entries that name their own amount: tokens of a fixed amount only, each at most the grant's (OverPrize).
    for (const [i, e] of (g.list ?? []).entries()) {
      if (typeof e !== 'object' || e.amount === undefined) continue;
      const t = prizeToken(gives, m);
      if (gives.gives !== 'tokens') refuse('E-GRANT', `${where}.list[${i}].amount`, `${label(g)}’s list names an amount, but it gives ${gives.gives ?? 'nothing'}: only a grant of a fixed amount of tokens takes one.`, 'Remove "amount", or make the grant give tokens.');
      else if (t && units(e.amount, t, `${where}.list[${i}].amount`, 'A listed amount') > units(gives.amount, t, `${where}.prize.amount`, label(g))) refuse('E-GRANT', `${where}.list[${i}].amount`, `${label(g)}’s list gives ${e.wallet} ${e.amount}, more than the grant’s ${gives.amount} (OverPrize).`, 'Raise the grant’s amount to the largest listed, or lower this one.');
    }
    if ((vouchers.length || keys.length) && (!l.perWallet || l.perWallet > MAX_RECEIPT_ROUNDS))
      warn('W-GRANT-CAPACITY', `${where}.limits.perWallet`, `${label(g)} can pay each wallet at most ${MAX_RECEIPT_ROUNDS} distinct voucher rounds in one grant incarnation. Its round history is retained even after vouchers expire.`, `Use a wallet limit at or below ${MAX_RECEIPT_ROUNDS}, or start a new grant incarnation when the campaign ends.`);
    // A grant with no voucher key, no key list and no list is open: any wallet claims it, within its limits (grant.rs).
    if (open && showsNft(g.gate) && l.perPerson)
      warn('W-GRANT', `${where}.limits.perPerson`, `${label(g)} is open: "perPerson" counts only vouchers that name a person, so here it limits nothing (the wallet limits count each collectible shown).`, 'Remove "perPerson".');
    if (open && !l.perWallet && !l.perWalletEach?.count)
      warn('W-GRANT', where, `${label(g)} has no voucher key, no keys and no list, and limits no wallet: the first wallet to come can claim it again and again, up to its total${l.total ? '' : ' (it has none: until its funds or its pool run out)'}.`, 'Set "limits.perWallet" (1 is usual) to make it a one-per-wallet claim, or add "vouchers", "keys" or a "list".');
    if (open)
      warn('W-GRANT-OPEN', where, g.gate?.wallets ? `${label(g)} is open to the ${g.gate.wallets.length} wallets its gate lists, within its limits.` : g.gate?.list ? `${label(g)} is open to the wallets on its gate’s list, within its limits.` : g.gate?.staked ? `${label(g)} is open to any wallet with the stake its gate asks, within its limits. Someone who stakes from many wallets claims once per wallet.` : g.gate ? `${label(g)} is open: any wallet that shows what its gate asks can claim it, within its limits, and each collectible shown counts too, so passing one around claims nothing more.` : `${label(g)} is open: any wallet can claim it, within its limits. Someone with many wallets claims once per wallet.`, g.gate ? undefined : 'Give it a gate (a collectible each claimer must hold), or keep "total" small.');
    for (const [i, v] of vouchers.entries()) if (!isAddress(v)) refuse('E-GRANT', `${where}.vouchers[${i}]`, 'A voucher key must be a public address.', 'Write the signer’s public key (never its private key).');
    for (const [i, v] of keys.entries()) if (!isAddress(v)) refuse('E-GRANT', `${where}.keys[${i}]`, 'A key must be a public address.', 'Write each code’s public key (never its private key or the code itself).');
    if (!open && !l.perWallet && !l.perPerson && !l.total && !l.perDay && !l.perKey && !l.perWalletEach?.count)
      warn('W-GRANT-LIMITS', `${where}.limits`, `${label(g)} has no limits: a leaked voucher key can take everything its ${prizePool(gives) ? 'pool' : 'prize'} has.`, 'Set "perWallet" (1 is usual), and "total" or "perDay".');
    if (keys.length && !l.perKey) warn('W-GRANT-LIMITS', `${where}.limits.perKey`, `${label(g)} takes vouchers from ${keys.length} keys but limits no key: a code someone shares pays every wallet that uses it.`, 'Set "perKey": 1 for codes that pay once each.');
    // A list written in xsolana.json has every leaf at round zero, and a round pays a wallet once (grant.rs take_round).
    const rounds = (g.list ?? []).some((e) => typeof e === 'object' && e.round);
    if ((g.list ?? []).length && !vouchers.length && !keys.length && !rounds && ((l.perWallet ?? 1) > 1 || l.perWalletEach))
      warn('W-LIST-ONCE', `${where}.limits`, `${label(g)} pays each entry on its list once: a wallet listed once is paid once, whatever "perWallet" or "perWalletEach" say.`, 'List the wallet again under another "round" ({ "wallet", "amount", "round" }) for each payout, or name a results server’s key in "vouchers".');
    // Every entry of the list is a claim of its own, and "total" counts every claim (grant.rs): the entries past it are refused.
    if ((g.list ?? []).length && l.total && l.total < g.list.length)
      warn('W-GRANT-LIMITS', `${where}.limits.total`, `${label(g)} lists ${g.list.length} claims but pays ${l.total} in all ("total"): once ${l.total} are claimed, the rest of the list is refused.`, `Raise "total" to ${g.list.length}, or leave it out.`);
    if (l.perWalletEach && !(l.perWalletEach.count > 0)) refuse('E-GRANT', `${where}.limits.perWalletEach`, `${label(g)} limits each wallet in a window but names no count.`, 'Give "count" (how many claims a wallet makes in each window) and "every" (like "1d").');
    perWalletWindow(l, `${where}.limits`);
    for (const at of ['until', 'opens']) {
      if (!l[at]) continue;
      try {
        toTime(l[at], now);
      } catch (err) {
        refuse(err.code, `${where}.limits.${at}`, err.message, err.fix);
      }
    }
    // Its funds are SOL, which pays each claim's rent.
    const funds = g.fund === undefined ? 0n : units(g.fund, { decimals: 9 }, `${where}.fund`, `${label(g)}’s funds`);
    if (funds === 0n)
      warn('W-GRANT-FUNDS', `${where}.fund`, `${label(g)} has no funds: whoever pays for each claim (the winner, who always signs it, or anyone paying its fees for them) pays its rent as well as the player fee.`, 'Set "fund" (0.05 SOL covers about a dozen claims) so winners claim for only the player fee and the network fee, or top it up after it goes live: anyone sends SOL to the grant.');
    rule(g.gate, `${where}.gate`, label(g));
  }

  // ---- parts switched off: saved as a draft (waiting for a voucher key, a date), they do nothing once live, while the
  // person may hear about them as if they worked. A box only prizes, missions or recipes roll is meant to be off.
  const OFF = { items: 'buy it or be given it', boxes: 'open it', recipes: 'craft it', schedules: 'run it', grants: 'claim it' };
  for (const [list, what] of Object.entries(OFF))
    for (const x of m[list])
      if (x.active === false && !(list === 'boxes' && rolls.some((r) => r.box === x.key)) && !(list === 'schedules' && x.sealed))
        warn('W-OFF', `economy.${list}.${x.key}.active`, `${label(x)} is switched off: once live, nobody can ${what} until it is switched on and published again.`, 'Tell the person it is off and what it waits for, or switch it on ("active": true) once that is ready.');

  // ---- decisions: what only the game knows
  for (const d of m.decisions) {
    const where = `economy.decisions.${d.key}`;
    if (d.does === 'payout' || d.does === 'burn') {
      const p = d.pool ? pool(d.pool, `${where}.pool`) : refuse('E-DECISION', where, `${label(d)} ${d.does === 'payout' ? 'pays out' : 'burns'} but does not say from which pool.`, 'Add "pool".');
      if (d.does === 'burn' && p && m.tokens.get(p.currency)?.wsol) refuse('E-WSOL-BURN', `${where}.pool`, `${label(d)} burns SOL, and wrapped SOL cannot be burned.`, 'Pay it out instead.');
      if (p && d.amount !== undefined) units(d.amount, m.tokens.get(p.currency), `${where}.amount`, `${label(d)}’s amount`);
      if (d.percent !== undefined) percent(d.percent, `${where}.percent`);
    }
    if (d.does === 'issue') {
      const tok = token(d.currency, `${where}.currency`);
      if (tok && !tok.gameMints) refuse('E-MINT-NOT-OURS', where, `${label(d)} mints ${tok.symbol}, but the project cannot mint it.`, 'Pay it from a pool instead, or use a token with source "project".');
    }
    if (['make', 'unmake', 'set'].includes(d.does)) {
      const it = d.item ? item(d.item, `${where}.item`) : refuse('E-DECISION', where, `${label(d)} works on a collectible but does not say which item.`, 'Add "item".');
      if (it && !isCollectible(it)) refuse('E-DECISION', `${where}.item`, `${label(d)} works on ${label(it)}, which is not a collectible.`, `Make ${label(it)} a collectible.`);
      if (it && d.does === 'unmake' && !it.burnable) refuse('E-DECISION', `${where}.item`, `${label(d)} burns ${label(it)}, but only items marked burnable can be burned by the game.`, `Mark ${label(it)} "burnable": true before any is issued.`);
    }
    if (d.does === 'award' && !(d.hold && m.hold.get(d.hold))) refuse('E-REF', `${where}.hold`, `${label(d)} awards a held collectible but names no hold that exists.`, 'Name one of "holds".');
    if ((d.does === 'decide' || d.does === 'open_contest') && !(d.contest && m.contest.get(d.contest))) refuse('E-REF', `${where}.contest`, `${label(d)} works on a contest but names none that exists.`, 'Name one of "contests".');
    if (d.proof && !m.payments.some((p) => p.key === d.proof.payment)) refuse('E-REF', `${where}.proof.payment`, `${label(d)} asks for proof of the payment “${d.proof.payment}”, which is not one of the economy’s payments.`, 'Name one of "payments" (the attempt players pay for).');
    if (d.signedBy === 'server' && m.authority === 'owner')
      warn('W-AUTHORITY', where, `${label(d)} is signed by your server, but the authority is still your own wallet: that would put your wallet’s key on a machine that signs by itself.`, 'Give the authority its own address ("keys.authority"), made for that server.');
  }
  const needs = [
    ...m.decisions.map((d) => `${label(d)} (when ${d.when})`),
    ...m.contests.map((c) => ((c.deciders ?? []).length ? `opening ${label(c)} (its deciders’ keys name who won)` : `naming who won ${label(c)}`)),
    ...m.holds.map((h) => `saying where ${label(h)}’s collectibles go`),
  ];
  if (needs.length)
    warn('W-AUTHORITY', 'economy.keys.authority', `This economy needs the authority while it runs, for what only the game knows: ${needs.join('; ')}. ${m.authority === 'owner' ? 'That is your wallet, approving each one.' : `That is the key ${m.authority}.`}`);
  const voucherKeys = [...new Set(m.grants.flatMap((g) => [...(g.vouchers ?? []), ...(g.keys ?? [])]))];
  if (voucherKeys.length)
    warn('W-VOUCHERS', 'economy.grants', `A voucher key signs who earned a grant: whatever holds it (your server, a play host) decides who gets rewards, within the limits the program keeps. The program does not check that a player really did what the voucher says. The keys: ${voucherKeys.join(', ')}.`);

  if (randomItems && !chance) warn('W-CHANCE-ITEMS', 'economy', 'Players pay for a random collectible they can resell (a loot box or gacha). Some places treat paid loot boxes of tradeable items as gambling, and many require the odds to be shown. loot runs on devnet only; before mainnet, counsel and an age and region gate.', 'Tell the person in plain words: paid random items that can be resold may count as gambling in some places; show the odds on the page, and get a lawyer before real money.');
  if (chance) warn('W-CHANCE-PRIZE', 'economy', 'Players pay for a chance at money (a box that pays a prize, a lottery). That is gambling in many places once it is real money, and paid packs with a cash buyback are drawing lawsuits. loot runs on devnet only; before mainnet, counsel and an age and region gate.', 'Tell the person this in plain words before they go live: paying for a chance at money is gambling in many places, so before real money they need a lawyer and an age and region gate.');

  for (const key of Object.keys(m.scenario.perDay ?? {})) {
    const [kind, name] = key.split(':');
    const list = { box: m.box, item: m.item, recipe: m.recipe, lottery: m.lottery, farm: m.farm, contest: m.contest, auction: m.auction, hold: m.hold, grant: m.grant, payment: new Map(m.payments.map((p) => [p.key, p])) }[kind];
    if (!list?.has(name)) warn('W-SCENARIO', `economy.scenario.perDay.${key}`, `The scenario counts “${key}”, which is not in the economy.`, 'Remove it, or fix the name.');
  }
  for (const key of Object.keys(m.scenario.staked ?? {})) if (!m.farm.has(key)) warn('W-SCENARIO', `economy.scenario.staked.${key}`, `The scenario stakes in “${key}”, which is not a farm.`, 'Remove it, or fix the name.');
  if (typeof m.authority === 'string' && m.authority !== 'owner' && !isAddress(m.authority)) refuse('E-SCHEMA', 'economy.keys.authority', 'The authority is not an address.', 'Write "owner" or a wallet’s public address.');

  // ---- the owner's setup: each step goes whole in one transaction (plan.mjs `pack`), so a step bigger than a setup
  // transaction may be (a box of many bundles, a recipe of many lines) could never go live. Built as the plan builds
  // it, on stand-in addresses.
  if (!refusals.length) {
    let setup = null;
    try {
      setup = setupSteps(economy, { now });
    } catch {
      // A spec the steps can't be built from fails the same way when it is planned.
    }
    const ctx = setup && placeholderContext(setup.model);
    const lists = { box: m.box, item: m.item, recipe: m.recipe, schedule: new Map(m.schedules.map((x) => [x.key, x])), lottery: m.lottery, grant: m.grant, farm: m.farm, auction: m.auction, pool: m.pool, seed: m.pool, fund: m.grant, stash: m.stash };
    const paths = { box: 'boxes', item: 'items', recipe: 'recipes', schedule: 'schedules', lottery: 'lotteries', grant: 'grants', farm: 'farms', auction: 'auctions', pool: 'pools', seed: 'pools', fund: 'grants', stash: 'stashes', token: 'tokens', traits: 'traits' };
    for (const step of setup?.steps ?? []) {
      let bytes;
      try {
        bytes = stepBytes(step.build(ctx), ctx);
      } catch {
        continue;
      }
      if (bytes <= BUDGET) continue;
      const [kind, key] = [step.part.split(':')[0], step.part.split(':').slice(1).join(':')];
      const part = lists[kind]?.get(key);
      const named = part ? `The ${kind === 'seed' ? 'seed of the pool' : kind === 'fund' ? 'funds of the grant' : kind} ${label(part)}` : `The setup step “${step.says}”`;
      const fix = kind === 'box' ? 'Give it fewer outcomes, or fewer prizes an outcome, or split it into two boxes.' : kind === 'recipe' ? 'Give it fewer lines, or split it into two recipes.' : 'Make it smaller (fewer entries, shorter names and links), or split it in two.';
      refuse('E-TX-SIZE', paths[kind] ? `economy.${paths[kind]}${part ? `.${key}` : ''}` : 'economy', `${named} takes ${bytes} bytes to set up in one transaction, more than the ${BUDGET} a setup transaction may hold (${MAX_TRANSACTION_BYTES}, less ${WALLET_ROOM} kept for what the owner’s wallet adds), so it could never go live.`, fix);
    }
  }

  // ---- pools that run dry at the scenario's rates (W-POOL-DRY above names a pool nothing fills): one that is filled
  // but pays out faster drains, and then skips or fails what it owes.
  if (!refusals.length) {
    let sim;
    try {
      sim = simulate(economy, { now });
    } catch {
      sim = null;
    }
    for (const p of sim?.pools ?? []) {
      if (p.lasts !== 'runs dry' || !(p.lastsDays < sim.scenario.days)) continue;
      const sym = m.tokens.get(p.token)?.symbol ?? p.token;
      const days = sim.scenario.days;
      const short = p.outPerDay - p.inPerDay;
      const need = !p.outs.some((o) => o.percentPerDay !== undefined) && short > 0 ? +(short * days).toFixed(6) : null;
      const takersText = p.outs.map((o) => o.by).join(', ');
      warn('W-POOL-RUNS-DRY', `economy.pools.${p.key}`, `At the scenario’s rates “${p.key}” pays out ${+p.outPerDay.toFixed(6)} ${sym} a day (${takersText}) and takes in ${+p.inPerDay.toFixed(6)}: its seed of ${p.seed} ${sym} is gone on day ${p.lastsDays} of ${days}. After that what it owes is skipped or fails until money comes in.`, `Seed it with ${need !== null ? `at least ${need} ${sym} (${days} days at that rate)` : 'more'}, fill it with a share of a sale (a split to "pool:${p.key}") or a schedule, or pay less from it.`);
    }
    for (const row of sim?.farms ?? []) farmRounding(m.farm.get(row.key), row, warn, m);
  }

  return result();
}

/** A large number in words a person reads: 7,000 below a billion, 7×10¹⁵ above. */
function many(x) {
  if (x < 1e9) return Math.round(x).toLocaleString('en-US');
  const exp = Math.floor(Math.log10(x));
  const digits = String(exp).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
  return `${+(x / 10 ** exp).toFixed(1)}×10${digits}`;
}

/**
 * A sharing farm's rounding: a release is credited by weight in steps of the total
 * weight ÷ 10¹² base units of the reward, and what is below a step waits uncredited, going back to the pool when the
 * last seat leaves or the farm ends. A staked token with a great many base units (many decimals, a huge supply: a
 * memecoin) paying a reward of few units rounds every seat's share to nothing: an exact model of the farm found seats
 * losing all of rewards of 194 to 2,155 units at total weights around 7×10¹⁵. The weight is the most that can
 * plausibly be staked (the supply, else a billion whole tokens or the scenario's stake if larger) at the highest tier
 * and the largest boost; the reward, what lands in a release span (the pool's seed and a span of the steady inflow).
 */
function farmRounding(f, row, warn, m) {
  if (!f || f.rate || f.unpaid || f.stakes === 'collectibles') return;
  const staked = m.tokens.get(f.stakes), pool = m.pool.get(f.rewards), reward = m.tokens.get(pool?.currency);
  if (staked?.decimals === undefined || reward?.decimals === undefined) return;
  const scenario = Number(m.scenario.staked?.[f.key] ?? 0);
  const whole = staked.supply !== undefined ? Number(staked.supply) : Math.max(1e9, scenario);
  const top = Math.max(1, ...(f.tiers ?? []).map((t) => Number(t.multiplier ?? 1)));
  const boost = (f.boosts ?? []).length ? 1 + Number(f.maxBoostPercent ?? 0) / 100 : 1;
  const weight = whole * 10 ** staked.decimals * top * boost;
  if (!(weight > 1e12)) return;
  const step = weight / 1e12;
  const span = releaseSeconds(f) / 86_400;
  const units = (Number(pool.seed ?? 0) + Number(row.rewardsPerDay ?? 0) * span) * 10 ** reward.decimals;
  if (!(units > 0) || units >= 100 * step) return;
  const [ss, rs] = [staked.symbol ?? f.stakes, reward.symbol ?? pool.currency];
  const basis = `${staked.supply !== undefined ? `its supply of ${many(whole)}` : whole > 1e9 ? `the scenario’s ${many(whole)} staked` : `a billion ${ss} (assumed when no supply is given)`} at ${staked.decimals} decimals${top > 1 ? `, at x${top}` : ''}${boost > 1 ? `, boosted +${f.maxBoostPercent}%` : ''}`;
  const lost = units < step
    ? 'each seat’s share of it rounds down to nothing, so no seat is credited any of it, and it goes back to the pool when the last seat leaves or the farm ends'
    : `up to a step of it at a time waits uncredited until more adds up to a step, and what waits goes back to the pool when the last seat leaves or the farm ends, so the seats can lose up to ${Math.min(100, Math.round((step / units) * 100))}% of a release`;
  warn('W-FARM-ROUNDING', `economy.farms.${f.key}.stakes`, `${label(f)} shares its rewards by weight, and the stakes in it can weigh up to about ${many(weight)} base units of ${ss} (${basis}). At that weight the program can share a release only in steps of about ${many(step)} base units of ${rs}, and about ${many(units)} land in it over a release (${releaseWords(f)}): ${lost}.`, `Stake a token with fewer base units (fewer decimals or a smaller supply), or fund larger rewards: about ${many(100 * step)} base units of ${rs} (${(100 * step) / 10 ** reward.decimals >= 1 ? many((100 * step) / 10 ** reward.decimals) : +((100 * step) / 10 ** reward.decimals).toPrecision(3)} ${rs}) or more a release keeps the rounding under 1%.`);
}

/**
 * A fixed rate that mints: every move mints the rate's due as far as the mint has room for under the most a
 * mint can ever hold (u64::MAX base units, less its supply), and what it can't mint is never owed later. What the rate
 * could mint is the rate times the most that can plausibly be staked (a token's supply, else a billion whole tokens or
 * the scenario's stake if larger; a collectible's supply, else 10,000 or the scenario's count), at the highest tier and
 * the largest boost, over the farm's run (ten years for a farm that never ends). Past a tenth of that room the warning
 * says the seats can come to be paid less than the rate.
 */
function rateRoom(f, warn, m) {
  if (!(Number(f.rate.perDay) > 0)) return;
  const reward = m.poolToken(f.rewards);
  if (reward?.decimals === undefined) return;
  const scenario = Number(m.scenario.staked?.[f.key] ?? 0);
  const ofCollectibles = f.stakes === 'collectibles';
  const staked = ofCollectibles ? m.item.get(f.item) : m.tokens.get(f.stakes);
  const known = Number(staked?.supply ?? 0) > 0;
  const count = known ? Number(staked.supply) : Math.max(ofCollectibles ? 10_000 : 1e9, scenario);
  const top = Math.max(1, ...(f.tiers ?? []).map((t) => Number(t.multiplier ?? 1)));
  const boost = (f.boosts ?? []).length ? 1 + Number(f.maxBoostPercent ?? 0) / 100 : 1;
  const days = f.runs ? toSeconds(f.runs) / 86_400 : 3650;
  const units = Number(f.rate.perDay) * count * top * boost * days * 10 ** reward.decimals;
  const room = 2 ** 64;
  if (!(units >= room / 10)) return;
  const [rs, unit] = [reward.symbol ?? m.pool.get(f.rewards)?.currency, ofCollectibles ? 'collectible' : (staked?.symbol ?? f.stakes)];
  const basis = `${known ? `a supply of ${many(count)}` : count > (ofCollectibles ? 10_000 : 1e9) ? `the scenario’s ${many(count)}` : ofCollectibles ? '10,000 collectibles' : `a billion ${unit}`} staked${top > 1 ? ` at x${top}` : ''}${boost > 1 ? `, boosted +${f.maxBoostPercent}%` : ''}, ${f.runs ? `over its ${f.runs}` : 'over ten years'}`;
  const whole = room / 10 ** reward.decimals;
  warn('W-FARM-MINT-ROOM', `economy.farms.${f.key}.rate`, `${label(f)} mints ${f.rate.perDay} ${rs} a day for each ${unit} at x1: at ${basis}, that is about ${many(units)} base units, ${units >= room ? 'more than' : `${Math.round((units / room) * 100)}% of`} the most a mint can ever hold (about ${many(room)} base units, ${many(whole)} ${rs} at ${reward.decimals} decimals). Each move mints only what the mint still has room for, and what it can’t mint is never owed later: once ${rs}’s supply nears that, every seat is paid less than the rate, then nothing.`, `Lower "perDay", give the farm an end ("runs"), or reward in a token with fewer decimals.`);
}

/** A one-line summary for each refusal and warning, as a person reads them. */
export function describe({ refusals, warnings }) {
  return [...refusals.map((r) => `✗ ${r.code} ${r.message}\n    Fix: ${r.fix}`), ...warnings.map((w) => `! ${w.code} ${w.message}${w.fix ? `\n    ${w.fix}` : ''}`)].join('\n');
}
