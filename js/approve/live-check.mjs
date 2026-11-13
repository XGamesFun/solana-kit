// What the spec file's `live` section says is made, held against the chain before anything is built on it. The file is
// written by agents, by hand and by teammates, so its `live` section is no more trusted than the rest of it: a planted
// one could name someone else's project (the owner's seeds would pay into its pools) or another treasury. The project
// must be the connected wallet's own (it is its owner or its authority on chain), at the address its creator's number
// makes, and the project, the mints, the collection and the tree the file calls made must be on chain and be that
// project's. A project's address is its creator's and its number, and a new owner keeps it: a project handed on is
// its new owner's to change. Its treasury and authority are read from the chain, never taken from the file, and its
// collection is one the Project account itself lists.
import { encodeBase58 } from '../chain/base58.js';
import { parseCoreCollection, MPL_CORE_PROGRAM } from '../chain/core.js';
import { utf8 } from '../chain/bytes.js';
import { METADATA_LIMITS, metadataAddress, parseRecord } from '../chain/metadata.js';
import { parseMint } from '../chain/mint.js';
import { mintState, powersOf } from '../chain/token2022.js';
import { accountKind, decode } from '../client/accounts.js';
import { BUBBLEGUM_PROGRAM, lootProgram, pda } from '../client/pda.js';
import { METAPLEX_METADATA_PROGRAM, SYSTEM_PROGRAM } from '../chain/pda.js';
import { tokenLabels } from '../economy/model.mjs';
import { madeSoFar } from '../economy/plan.mjs';

/** A `live` section that does not match the chain: the message says what differs, in plain words. */
export class LiveMismatch extends Error {}

/**
 * Checks `live` (the spec's live section) for `wallet`, the wallet connected on the page, against `chain` ({ account }).
 * `m` is the spec's model. Returns { owner, project, creator, treasury, authority, corrected, notes }: the project's
 * owner the setup is built for (the wallet, or the project's owner when the wallet is its authority); the project's
 * address; who made it (the wallet, for a project not made yet); its treasury and authority as the chain has them now
 * (absent for a project not made yet); `corrected`, in words, where the file said otherwise of those two (its owner
 * changed them, or handed the project on, since the file was written); and `notes`, where the chain's treasury is not
 * the one the spec names. Throws LiveMismatch when the file names a project that is not this wallet's, an account the
 * chain does not have as the file says, or (`settings`) a project whose authority on chain is not the spec's.
 */
export async function checkLive({ live, m, wallet, chain }) {
  const made = madeSoFar(live) ?? {};
  const own = pda.project(wallet, m.projectNumber);
  const setupMints = Object.entries(made.mints ?? {}).filter(([key]) => {
    const t = m.tokens.get(key);
    // Only a mint the setup makes is checked: a mint the spec names by its address is the spec's to name.
    return t?.source === 'game' && (!t.mint || t.mint.startsWith('@'));
  });
  if (!made.project && !setupMints.length && !made.collection && !made.tree)
    return { owner: wallet, project: own, creator: wallet, corrected: [], notes: [] };
  if (typeof chain.account !== 'function')
    throw new Error(
      'The file says part of this economy is live already, and this connection cannot read the chain to check it: nothing was sent.',
    );
  const read = address => chain.account(address);

  let owner = wallet;
  let project = own;
  let creator = wallet;
  let treasury;
  let authority;
  let listed = null;
  const corrected = [];
  const notes = [];
  if (made.project) {
    const account = await read(made.project);
    if (!account || account.owner !== lootProgram() || accountKind(account.data) !== 'Project')
      throw new LiveMismatch(
        `The file names the project ${made.project}, and there is no loot project at that address.`,
      );
    const state = decode('Project', account.data);
    // A project is at the address its creator and the number they gave it make, and a new owner keeps it.
    if (pda.project(state.creator, m.projectNumber) !== made.project)
      throw new LiveMismatch(
        `The file names the project ${made.project}, which is not project number ${m.projectNumber} of its creator ${state.creator}.`,
      );
    if (state.owner !== wallet && state.authority !== wallet)
      throw Object.assign(
        new LiveMismatch(
          `The file names the project ${made.project}, which belongs to ${state.owner}, not to ${wallet}, the address signing now. (That address’s own project number ${m.projectNumber} would be at ${own}.)`,
        ),
        { notOwner: true },
      );
    // Who signs the project's decisions is the chain's to say, and the steps are built and handed out for the key
    // the spec names: where the two differ, a step would name a signer the chain does not take, or wait for a
    // signature nobody can give. Nothing here changes a project's authority, so it is said before anything is built.
    const says = m.authority === 'owner' ? state.owner : m.authority;
    if (says !== state.authority)
      throw Object.assign(
        new LiveMismatch(
          `On chain the project’s authority (the key that signs its decisions) is ${state.authority}; the spec says it is ${m.authority === 'owner' ? `its owner’s wallet, ${state.owner}` : m.authority}. Publishing never changes a project’s authority, and a step built for another key than the chain’s can be signed by nobody: have the owner set it on chain (the program’s update_project), or put the spec’s back as it was published, then approve again.`,
        ),
        { settings: true },
      );
    // The project's treasury and authority are the chain's to say: its owner can change them, and hand the project
    // on, with the program's own update_project, which writes no file. Nothing is built on the file's lines of them.
    for (const [what, said, is] of [
      ['treasury', made.treasury, state.treasury],
      ['authority', made.authority, state.authority],
    ])
      if (said && said !== is) corrected.push(`On chain the project’s ${what} is ${is} (the file said ${said}).`);
    // What a split leaves over goes to the treasury the chain has, whatever the spec says of it now.
    if ((m.treasuryWallet ?? state.owner) !== state.treasury)
      notes.push(
        `On chain the project’s treasury is ${state.treasury}, not ${m.treasuryWallet ? `the spec’s ${m.treasuryWallet}` : `its owner’s wallet (${state.owner})`}: publishing never changes it, and what a split leaves over goes to the one on chain.`,
      );
    listed = new Set(state.collections ?? []);
    owner = state.owner;
    project = made.project;
    creator = state.creator;
    treasury = state.treasury;
    authority = state.authority;
  }

  for (const [key, address] of setupMints) {
    const t = m.tokens.get(key);
    // (a file that calls a token made and gives no address for it names nothing to read)
    if (typeof address !== 'string' || !address)
      throw new LiveMismatch(
        `The file says the setup made the token ${t.symbol ?? key}, and gives no address for its mint.`,
      );
    const account = await read(address);
    const mint = account ? parseMint(address, account.owner, account.data) : null;
    if (!mint)
      throw new LiveMismatch(
        `The file says the setup made the token ${t.symbol ?? key} at ${address}, and there is no mint there.`,
      );
    if (mint.decimals !== (t.decimals ?? 0))
      throw new LiveMismatch(
        `The mint ${address} the file names for ${t.symbol ?? key} has ${mint.decimals} decimals, not ${t.decimals ?? 0}.`,
      );
    // The setup hands a token's minting to the project, or turns it off for good (a fixed supply); it never keeps a
    // freeze authority.
    const minter = t.fixedSupply ? null : project;
    if (mint.mintAuthority !== minter)
      throw new LiveMismatch(
        `The mint ${address} the file names for ${t.symbol ?? key} is minted by ${mint.mintAuthority ?? 'nobody'}, not ${minter ?? 'nobody'} as the setup leaves it.`,
      );
    if (mint.freezeAuthority)
      throw new LiveMismatch(
        `The mint ${address} the file names for ${t.symbol ?? key} can be frozen by ${mint.freezeAuthority}; the setup makes none that can.`,
      );
  }

  if (made.collection) {
    const account = await read(made.collection);
    let collection;
    try {
      collection = account?.owner === MPL_CORE_PROGRAM ? parseCoreCollection(account.data) : null;
    } catch {
      collection = null;
    }
    if (!collection)
      throw new LiveMismatch(
        `The file names the collection ${made.collection}, and there is no Core collection there.`,
      );
    // A project that is made lists its own collections (the program took each at create_project): the file's is one
    // of them, whoever's it is to update now (a project handed on keeps the collection its creator made for it).
    // Anyone can make a collection that names the owner its update authority, so that alone says nothing here.
    if (listed && !listed.has(made.collection))
      throw new LiveMismatch(
        `The collection ${made.collection} the file names is not one of the collections of the project ${project}.`,
      );
    // Before the project is made (a setup cut short after its collection's step), the collection is the wallet's own.
    if (!listed && collection.updateAuthority !== owner)
      throw new LiveMismatch(
        `The collection ${made.collection} the file names belongs to ${collection.updateAuthority}, not to the project's owner ${owner}.`,
      );
  }

  if (made.tree) {
    const config = await read(pda.treeConfig(made.tree));
    const creator =
      config?.owner === BUBBLEGUM_PROGRAM && config.data.length >= 40
        ? encodeBase58(config.data.subarray(8, 40))
        : null;
    if (creator !== project)
      throw new LiveMismatch(`The file names the tree ${made.tree}, which is not a tree of the project ${project}.`);
  }
  return { owner, project, creator, ...(treasury ? { treasury, authority } : {}), corrected, notes };
}

/**
 * A record's own words, to show: whoever holds the record wrote them, so they are put on one line, cut short, with
 * nothing in them that hides, reorders or closes a quote (controls, marks that turn text around or take no room, line
 * breaks, quote marks), and are only ever shown inside quotes.
 */
const HIDES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}"“”„‟«»]/gu;
const clip = text => [...String(text).replace(HIDES, '')].slice(0, 40).join('');

/**
 * The tokens whose name record this approval writes again, read from the chain: `renames`, their keys; `notes`, in
 * words, for a name the spec changes that can't be written; and `held`, the keys of those. A token the setup made
 * (`live.mints`) is called on chain what its record says. Its spec's name, ticker or link is written there again when
 *   - the spec gives them otherwise than it was published with (`published`: the file's own snapshot; with none, a
 *     setup cut short, the chain alone is the measure, so a name edited before a resume is written), and
 *   - the record says something else, is the mint's, is the project owner's to change (its update authority, and
 *     still changeable) and holds nothing a write of its words would take away (a royalty, creators, a collection,
 *     uses: `parseRecord`'s `plain`).
 * A token with no record (one that went live before setups named tokens), or a record handed on, made unchangeable
 * or given a royalty or creators outside these tools, is not written: said in `notes`, and nothing else is held up.
 * A name so held is not recorded as published (approve/server.mjs), so it is said again at each approve until the
 * spec gives the old name back. Nothing here trusts the file for what is on chain. `owner`: the project's owner.
 */
export async function readRenames({ live, m, chain, owner, published = null }) {
  const out = { renames: [], notes: [], held: [], settled: [] };
  const made = madeSoFar(live) ?? {};
  // A name this setup or change wrote already, or sent and has not seen land (the file is still `partial`): the
  // record no longer says what was published, so the published spec is no measure of it and the chain is read.
  const step = key => `name:${key}`;
  const written = key =>
    Boolean(live?.partial) &&
    ((live.landed ?? []).includes(step(key)) || (live.pending ?? []).some(p => (p.steps ?? []).includes(step(key))));
  if (typeof chain.account !== 'function') return out;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hold = (key, note) => {
    out.held.push(key);
    out.notes.push(note);
  };
  for (const [key, address] of Object.entries(made.mints ?? {})) {
    const t = m.tokens.get(key);
    if (t?.source !== 'game' || (t.mint && !t.mint.startsWith('@'))) continue;
    const want = [t.name, t.symbol, t.uri ?? ''];
    const was = published ? (published.tokens ?? []).find(x => x.key === key) : null;
    const said = was ? tokenLabels(was) : null;
    // as it was published: nothing asked for, and a record its owner changed elsewhere is left as it is
    const asPublished = Boolean(said) && same(said, want);
    if (asPublished && !written(key)) continue;
    // (the token as the person knows it: by the ticker it was published with)
    const what = `the token ${said?.[1] ?? t.symbol ?? key}`;
    const again = 'This is said at each approve until the spec gives the old name, ticker and link back.';
    const account = await chain.account(metadataAddress(address));
    const record = account?.owner === METAPLEX_METADATA_PROGRAM ? parseRecord(account.data) : null;
    if (!record || record.mint !== address) {
      if (said && !asPublished)
        hold(
          key,
          account?.owner === METAPLEX_METADATA_PROGRAM
            ? `The spec changes what ${what} is called, but the name record of its mint ${address} can’t be read as one: nothing is sent for it. ${again}`
            : `The spec changes what ${what} is called, but it went live before setups named tokens on chain: it has no name record, and none can be made now (only a mint’s own authority makes one, and its minting was handed on or turned off). Nothing is sent for it, and wallets keep showing it as before. ${again}`,
        );
      continue;
    }
    if (same([record.name, record.symbol, record.uri], want)) {
      // the chain says the spec's name already (written by another tool, or by a session whose file was lost): it is
      // the published one from here on
      if (said && !asPublished) out.settled.push(key);
      continue;
    }
    const called = `“${clip(record.name)}” (“${clip(record.symbol)}”)`;
    const kept = `nothing is sent for it, and wallets keep showing ${called}. ${said ? again : ''}`.trim();
    if (record.updateAuthority !== owner)
      hold(
        key,
        `The spec changes what ${what} is called, but its name record is no longer the project owner’s to change (it was handed to another wallet, outside these tools): ${kept}`,
      );
    else if (!record.mutable)
      hold(
        key,
        `The spec changes what ${what} is called, but its name record can no longer be changed (it was made unchangeable, outside these tools): ${kept}`,
      );
    else if (!record.plain)
      hold(
        key,
        `The spec changes what ${what} is called, but its name record was given ${[record.royalty ? 'a royalty' : null, record.creators ? 'creators' : null, record.collection ? 'a collection' : null, record.uses ? 'uses' : null].filter(Boolean).join(', ')} outside these tools, which writing its name from here would take away or be refused for: ${kept} Change its name with the tool that set those.`,
      );
    // (the checker holds a changed name to what a record takes; a setup cut short has no published spec to say it
    // changed, so it is held to it here)
    else if (
      want.some(
        (v, i) => utf8(String(v)).length > [METADATA_LIMITS.name, METADATA_LIMITS.symbol, METADATA_LIMITS.uri][i],
      ) ||
      !String(t.name).trim() ||
      !String(t.symbol).trim()
    )
      hold(
        key,
        `The spec changes what ${what} is called to words a name record can’t take (a name of at most ${METADATA_LIMITS.name} bytes, a ticker of at most ${METADATA_LIMITS.symbol}, a link of at most ${METADATA_LIMITS.uri}, and neither name nor ticker blank): ${kept}`,
      );
    else out.renames.push(key);
  }
  return out;
}

/** A token the spec names by its mint address that is not that mint on chain: the message says what differs. */
export class MintMismatch extends Error {}

/** What each power of a mint's own keys lets its holder do, in the checker's words (check.mjs W-MINT-POWERS). */
const POWER_SAYS = {
  freeze: 'freeze any account holding it, the economy’s pools and vaults included',
  permanentDelegate: 'move or burn it out of any account',
  transferHook: 'run a program of their own on every transfer, which can refuse one',
  feeChangeable: 'raise its transfer fee, up to all of a transfer',
  closeAuthority: 'close the mint and make it again with other powers',
  pausable: 'pause every transfer of it',
  defaultFrozen: 'have every new account of it start frozen',
  defaultState: 'switch every new account of it to start frozen',
};
/** What the mint itself does, whoever controls it: said as a sentence of its own. */
const MINT_SAYS = {
  nonTransferable: 'It cannot be transferred at all: nothing can be paid, staked or given as a prize in it.',
  confidentialTransfers: 'Its holders can turn plain transfers into their account away (confidential transfers).',
};
/** What a spec says of a power when it denies it, for the refusal. */
const POWER_NAMES = {
  freeze: 'no freeze authority',
  permanentDelegate: 'no permanent delegate',
  transferHook: 'no transfer hook',
  feeChangeable: 'a transfer fee nobody can change',
  closeAuthority: 'no close authority',
  pausable: 'no pause',
  defaultFrozen: 'accounts that don’t start frozen',
  defaultState: 'no default account state',
  nonTransferable: 'a token that can be transferred',
  confidentialTransfers: 'no confidential transfers',
};

/**
 * A named mint's powers as the chain has them (`onChain`: token2022.js `powersOf`) against what the spec says of them
 * (`said`: its `powers`, or nothing). The spec denying a power the mint has is a contradiction: the checker's warnings
 * were worked out from the spec, so the person read that a risk was not there (throws MintMismatch). A power the spec
 * is silent on is not refused (a spec written before the tools could read a mint names none): it is returned in words,
 * for the page to show before the owner approves. → the sentence, or null when the spec says all the chain has.
 */
function powersAgainst(t, what, onChain, said = {}, { state = {}, project = null } = {}) {
  const fix = `Run \`xsolana token ${t.mint}\` and write its "powers" as the chain has them.`;
  for (const [power, name] of Object.entries(POWER_NAMES))
    if (said[power] === false && onChain[power])
      throw new MintMismatch(
        `The spec says ${what} has ${name} ("${power}": false); on chain, ${POWER_SAYS[power] ? `whoever controls its mint ${t.mint} can ${POWER_SAYS[power]}` : `its mint ${t.mint} says otherwise`}. ${fix}`,
      );
  if (said.mintAuthority === 'none' && onChain.mintAuthority !== 'none')
    throw new MintMismatch(
      `The spec says nobody can mint more of ${what} ("mintAuthority": "none"); on chain its mint ${t.mint} has a mint authority. ${fix}`,
    );
  const fee = onChain.transferFeePercent ?? 0;
  if (said.transferFeePercent !== undefined && fee > Number(said.transferFeePercent))
    throw new MintMismatch(
      `The spec says ${what} keeps ${said.transferFeePercent}% of every transfer; on chain its mint ${t.mint} keeps ${fee}%, so pools, prizes and stakes receive less than the page shows. ${fix}`,
    );
  // A default state only matters with someone who can freeze: with no freeze authority nobody can switch it.
  const can = power => (power === 'defaultState' ? !onChain.defaultFrozen && onChain.freeze : true);
  const unsaid = [
    onChain.mintAuthority === 'someone else' &&
      said.mintAuthority === undefined &&
      'mint more of it whenever they want',
    ...Object.entries(POWER_SAYS).map(
      ([power, says]) => onChain[power] && said[power] === undefined && can(power) && says,
    ),
    fee > 0 && said.transferFeePercent === undefined && `keep ${fee}% of every transfer`,
  ].filter(Boolean);
  const lines = [];
  if (unsaid.length)
    lines.push(
      `whoever controls the mint of ${what} (${t.mint}) can ${unsaid.join('; ')}. The checker’s warnings did not count it`,
    );
  for (const [power, says] of Object.entries(MINT_SAYS))
    if (onChain[power] && said[power] === undefined) lines.push(says.replace(/\.$/, ''));
  // The spec says the project mints it: true only once the mint's authority is the project. Until then whatever the
  // economy mints in it fails, and whoever holds the authority mints as they like.
  if (['project', 'game'].includes(said.mintAuthority) && onChain.mintAuthority !== 'project')
    lines.push(
      onChain.mintAuthority === 'none'
        ? `the spec says the project mints ${what}, and on chain nobody can mint it (its mint ${t.mint} has no authority, for good): everything this economy would mint in it will fail`
        : `the spec says the project mints ${what}, and on chain its mint ${t.mint} is someone else’s to mint${project ? `: until its authority is handed to the project (${project}), what this economy mints in it fails, and its holder can mint more` : ', not the project’s yet'}`,
    );
  if (state.paused) lines.push(`${what} is paused now: nothing of it moves until its issuer ends the pause`);
  if (state.scaled)
    lines.push(
      `wallets show amounts of ${what} multiplied by a rate its mint carries${state.scaler ? ', which its issuer can change' : ''}: the economy counts the amounts under it, so a price here is not the number a wallet shows`,
    );
  return lines.length
    ? `Read from the chain, and not in the spec: ${lines.join('. ')}. An economy in it is only as safe as the token.`
    : null;
}

/**
 * Checks every token the spec names by its mint address (an existing token, or a game token on a mint of its own)
 * against `chain` ({ account }): the mint must be there, of the token program the spec says, with the decimals the
 * spec says. Every amount the page shows is written in base units with the spec's decimals, and the program takes them
 * as they are, so one decimal off is ten times what the page says. A mint the setup makes is made with the spec's
 * decimals, and is not read. What the mint's own keys can do is read too (`powersAgainst`): a power the spec denies
 * and the mint has is refused, and one the spec is silent on is returned for the page to show. Throws MintMismatch.
 * `project`: the project's address (the wallet's own, or the live one), which a mint the project mints must name as
 * its authority. `chain.epoch`, when the chain has it, tells a transfer fee since lowered from one still in force.
 * → { powers: [{ key, mint, says }] }, one for each named token with something its spec doesn't say.
 */
export async function checkMints({ m, chain, project = null }) {
  const named = [...m.tokens.values()].filter(t => t.mint && !t.mint.startsWith('@'));
  const powers = [];
  let epoch = null;
  if (named.some(t => !t.wsol) && typeof chain.epoch === 'function') epoch = await chain.epoch().catch(() => null);
  for (const t of named) {
    const what = `the token ${t.symbol ?? t.key} (“${t.key}”)`;
    if (t.wsol) {
      if (t.decimals !== 9)
        throw new MintMismatch(
          `The spec gives ${what} ${t.decimals} decimals; its mint ${t.mint} is wrapped SOL, which has 9. Write "decimals": 9.`,
        );
      continue;
    }
    if (typeof chain.account !== 'function')
      throw new MintMismatch(
        `This connection cannot read the chain, so the decimals of ${what} at ${t.mint} cannot be checked.`,
      );
    const account = await chain.account(t.mint);
    const mint = account ? parseMint(t.mint, account.owner, account.data) : null;
    if (!mint) throw new MintMismatch(`The spec names ${what} at ${t.mint}, and there is no token mint there.`);
    if (mint.decimals !== t.decimals)
      throw new MintMismatch(
        `The spec gives ${what} ${t.decimals ?? 'no'} decimals; its mint ${t.mint} has ${mint.decimals}, so every amount in it would be ${scale(t.decimals ?? 0, mint.decimals)} what the page shows. Write "decimals": ${mint.decimals}.`,
      );
    if (mint.program !== t.program)
      throw new MintMismatch(
        `The spec says ${what} is a ${t.program} token; its mint ${t.mint} is ${mint.program}. Write "program": "${mint.program}".`,
      );
    let onChain, state;
    try {
      onChain = powersOf(account, { project, epoch }) ?? {};
      state = mintState(account);
    } catch {
      throw new MintMismatch(
        `The mint ${t.mint} of ${what} does not read as a mint: its data is not what its token program writes.`,
      );
    }
    const says = powersAgainst(t, what, onChain, t.powers, { state, project });
    if (says) powers.push({ key: t.key, mint: t.mint, says });
  }
  await checkTreasury({ m, chain });
  return { powers };
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
  const what =
    HOLDS_A_VAULT[account.owner] ?? (account.executable ? 'a program' : `an account of the program ${account.owner}`);
  throw new MintMismatch(
    `The spec’s treasury ${treasury} is ${what}: nobody can sign for what it would be paid, so every split’s rest would be stuck there. Name the wallet that signs (for a Squads multisig, its vault address; for a Realms DAO, its treasury).`,
  );
}

/** How much an amount written with `said` decimals is, on a mint of `real` decimals, against what it says. */
const scale = (said, real) =>
  said > real ? `${10n ** BigInt(said - real)} times` : `1/${10n ** BigInt(real - said)} of`;
