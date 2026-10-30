// What the spec file's `live` section says is made, held against the chain before anything is built on it. The file is
// written by agents, by hand and by teammates, so its `live` section is no more trusted than the rest of it: a planted
// one could name someone else's project (the owner's seeds would pay into its pools) or another treasury. The project
// must be the connected wallet's own, at the address its number makes, and the project, the mints, the collection and
// the tree the file calls made must be on chain and be that project's.
import { encodeBase58 } from '../chain/base58.js';
import { parseCoreCollection, MPL_CORE_PROGRAM } from '../chain/core.js';
import { parseMint } from '../chain/mint.js';
import { mayStartFrozen } from '../chain/token2022.js';
import { accountKind, decode } from '../client/accounts.js';
import { BUBBLEGUM_PROGRAM, LOOT_PROGRAM, pda } from '../client/pda.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { madeSoFar } from '../economy/plan.mjs';

/** A `live` section that does not match the chain: the message says what differs, in plain words. */
export class LiveMismatch extends Error {}

/**
 * Checks `live` (the spec's live section) for `wallet`, the wallet connected on the page, against `chain` ({ account }).
 * `m` is the spec's model. Returns { owner, project }: the project's owner the setup is built for (the wallet, or the
 * project's owner when the wallet is its authority), and the project's address. Throws LiveMismatch when the file
 * names a project that is not this wallet's, or an account the chain does not have as the file says.
 */
export async function checkLive({ live, m, wallet, chain }) {
  const made = madeSoFar(live) ?? {};
  const own = pda.project(wallet, m.projectNumber);
  const setupMints = Object.entries(made.mints ?? {}).filter(([key]) => {
    const t = m.tokens.get(key);
    // Only a mint the setup makes is checked: a mint the spec names by its address is the spec's to name.
    return t?.source === 'game' && (!t.mint || t.mint.startsWith('@'));
  });
  if (!made.project && !setupMints.length && !made.collection && !made.tree) return { owner: wallet, project: own };
  if (typeof chain.account !== 'function') throw new Error('The file says part of this economy is live already, and this connection cannot read the chain to check it: nothing was sent.');
  const read = (address) => chain.account(address);

  let owner = wallet;
  let project = own;
  if (made.project) {
    const account = await read(made.project);
    if (!account || account.owner !== LOOT_PROGRAM || accountKind(account.data) !== 'Project') throw new LiveMismatch(`The file names the project ${made.project}, and there is no loot project at that address.`);
    const state = decode('Project', account.data);
    if (pda.project(state.owner, m.projectNumber) !== made.project) throw new LiveMismatch(`The file names the project ${made.project}, which is not project number ${m.projectNumber} of its owner ${state.owner}.`);
    if (state.owner !== wallet && state.authority !== wallet) throw new LiveMismatch(`The file names the project ${made.project}, which belongs to the wallet ${state.owner}, not to the connected wallet ${wallet}. Your own project number ${m.projectNumber} is at ${own}.`);
    if (made.treasury && made.treasury !== state.treasury) throw new LiveMismatch(`The file says the treasury is ${made.treasury}; on chain it is ${state.treasury}.`);
    if (made.authority && made.authority !== state.authority) throw new LiveMismatch(`The file says the authority is ${made.authority}; on chain it is ${state.authority}.`);
    owner = state.owner;
    project = made.project;
  }

  for (const [key, address] of setupMints) {
    const t = m.tokens.get(key);
    const account = await read(address);
    const mint = account ? parseMint(address, account.owner, account.data) : null;
    if (!mint) throw new LiveMismatch(`The file says the setup made the token ${t.symbol ?? key} at ${address}, and there is no mint there.`);
    if (mint.decimals !== (t.decimals ?? 0)) throw new LiveMismatch(`The mint ${address} the file names for ${t.symbol ?? key} has ${mint.decimals} decimals, not ${t.decimals ?? 0}.`);
    // The setup hands a token's minting to the project, or turns it off for good (a fixed supply); it never keeps a
    // freeze authority.
    const minter = t.fixedSupply ? null : project;
    if (mint.mintAuthority !== minter) throw new LiveMismatch(`The mint ${address} the file names for ${t.symbol ?? key} is minted by ${mint.mintAuthority ?? 'nobody'}, not ${minter ?? 'nobody'} as the setup leaves it.`);
    if (mint.freezeAuthority) throw new LiveMismatch(`The mint ${address} the file names for ${t.symbol ?? key} can be frozen by ${mint.freezeAuthority}; the setup makes none that can.`);
  }

  if (made.collection) {
    const account = await read(made.collection);
    let collection;
    try {
      collection = account?.owner === MPL_CORE_PROGRAM ? parseCoreCollection(account.data) : null;
    } catch {
      collection = null;
    }
    if (!collection) throw new LiveMismatch(`The file names the collection ${made.collection}, and there is no Core collection there.`);
    if (collection.updateAuthority !== owner) throw new LiveMismatch(`The collection ${made.collection} the file names belongs to ${collection.updateAuthority}, not to the project's owner ${owner}.`);
  }

  if (made.tree) {
    const config = await read(pda.treeConfig(made.tree));
    const creator = config?.owner === BUBBLEGUM_PROGRAM && config.data.length >= 40 ? encodeBase58(config.data.subarray(8, 40)) : null;
    if (creator !== project) throw new LiveMismatch(`The file names the tree ${made.tree}, which is not a tree of the project ${project}.`);
  }
  return { owner, project };
}

/** A token the spec names by its mint address that is not that mint on chain: the message says what differs. */
export class MintMismatch extends Error {}

/**
 * Checks every token the spec names by its mint address (an existing token, or a game token on a mint of its own)
 * against `chain` ({ account }): the mint must be there, of the token program the spec says, with the decimals the
 * spec says. Every amount the page shows is written in base units with the spec's decimals, and the program takes them
 * as they are, so one decimal off is ten times what the page says. A mint the setup makes is made with the spec's
 * decimals, and is not read. Throws MintMismatch.
 */
export async function checkMints({ m, chain }) {
  const named = [...m.tokens.values()].filter((t) => t.mint && !t.mint.startsWith('@'));
  // The routes that read a mint's default account state once, as they open, and refuse one that can start frozen.
  const once = new Map();
  const reads = (key, what) => key && !once.has(key) && once.set(key, what);
  for (const l of m.lotteries) reads(l.currency ?? m.currencyKey, `the lottery ${l.name ?? l.key}`), reads(l.ticketCurrency, `the lottery ${l.name ?? l.key}`);
  for (const c of m.contests) reads(c.currency ?? m.currencyKey, `the contest ${c.name ?? c.key}`);
  for (const a of m.auctions) reads(a.currency ?? m.currencyKey, `the auction ${a.name ?? a.key}`);
  for (const s of m.schedules.filter((x) => x.sealed)) reads(s.currency ?? m.currencyKey, `the sealed schedule ${s.name ?? s.key}`);
  for (const t of named) {
    const what = `the token ${t.symbol ?? t.key} (“${t.key}”)`;
    if (t.wsol) {
      if (t.decimals !== 9) throw new MintMismatch(`The spec gives ${what} ${t.decimals} decimals; its mint ${t.mint} is wrapped SOL, which has 9. Write "decimals": 9.`);
      continue;
    }
    if (typeof chain.account !== 'function') throw new MintMismatch(`This connection cannot read the chain, so the decimals of ${what} at ${t.mint} cannot be checked.`);
    const account = await chain.account(t.mint);
    const mint = account ? parseMint(t.mint, account.owner, account.data) : null;
    if (!mint) throw new MintMismatch(`The spec names ${what} at ${t.mint}, and there is no token mint there.`);
    if (mint.decimals !== t.decimals) throw new MintMismatch(`The spec gives ${what} ${t.decimals ?? 'no'} decimals; its mint ${t.mint} has ${mint.decimals}, so every amount in it would be ${scale(t.decimals ?? 0, mint.decimals)} what the page shows. Write "decimals": ${mint.decimals}.`);
    if (mint.program !== t.program) throw new MintMismatch(`The spec says ${what} is a ${t.program} token; its mint ${t.mint} is ${mint.program}. Write "program": "${mint.program}".`);
    if (once.has(t.key) && mayStartFrozen(account))
      throw new MintMismatch(`The mint ${t.mint} of ${what} has a default account state that starts new accounts frozen, or that its freeze authority can switch to frozen, so ${once.get(t.key)} would be refused as it opens (the program refuses such a mint wherever a refund or a payout goes into an account opened for it). Use another token there.`);
  }
  await checkTreasury({ m, chain });
}

/** Programs whose own accounts are often pasted where their vault was meant: a multisig's or a DAO's account. */
const HOLDS_A_VAULT = {
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: 'a Squads multisig’s own account, not its vault',
  SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu: 'a Squads v3 multisig’s own account, not its vault',
  GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw: 'a Realms governance account, not its treasury',
};

/**
 * The treasury the spec names ("wallet:<address>"), against the chain: what every
 * split leaves goes to the treasury's own account of the mint, which only the treasury's key can move. A wallet, a
 * Squads vault and a Realms treasury are System's accounts (or not there yet); an account another program owns (a
 * multisig's own account, a token account, an NFT, a program) signs for nothing, so what went there would be stuck.
 * Throws MintMismatch (what the spec names does not match the chain).
 */
export async function checkTreasury({ m, chain }) {
  const treasury = m.treasuryWallet;
  if (!treasury || typeof chain.account !== 'function') return;
  const account = await chain.account(treasury);
  if (!account || (account.owner === SYSTEM_PROGRAM && !account.executable)) return;
  const what = HOLDS_A_VAULT[account.owner] ?? (account.executable ? 'a program' : `an account of the program ${account.owner}`);
  throw new MintMismatch(`The spec’s treasury ${treasury} is ${what}: nobody can sign for what it would be paid, so every split’s rest would be stuck there. Name the wallet that signs (for a Squads multisig, its vault address; for a Realms DAO, its treasury).`);
}

/** How much an amount written with `said` decimals is, on a mint of `real` decimals, against what it says. */
const scale = (said, real) => (said > real ? `${10n ** BigInt(said - real)} times` : `1/${10n ** BigInt(real - said)} of`);
