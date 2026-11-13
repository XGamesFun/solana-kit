// `xsolana approve --browser`: a page on 127.0.0.1 where the owner of an economy approves going live in a browser
// wallet, served only when asked for (`xsolana approve --keypair`, js/approve/with-key.mjs, drives this same approval
// with a key file and no page). The
// server builds each transaction (js/economy/plan.mjs), has the fresh keys a setup makes sign their part, and sends
// only what it prepared and showed: a wallet's answer must carry that wallet's valid signature of the exact message
// prepared for it, or of that message with nothing but a wallet's own additions (js/approve/wallet-adds.mjs: its
// Lighthouse checks, a compute budget). Each prepared batch answers once and expires after 90 seconds. What lands is written back into the spec
// file as it lands, so a setup cut short goes on from where it stopped. The server never sees the owner's key.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, open as openFile, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { equalBytes, fromBase64, toBase64 } from '../chain/bytes.js';
import { alreadyProcessed, rpcClient } from '../chain/rpc.js';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { slotHashes, tableAddress } from '../chain/lookup.js';
import { SYSVAR_SLOT_HASHES } from '../chain/pda.js';
import { MINT_BYTES } from '../chain/token.js';
import { compileMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { accountKind, decode } from '../client/accounts.js';
import { checkOnCluster, cluster, CLUSTERS, clusterRpcUrl, lootProgram, pda } from '../client/pda.js';
import { check, describe } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { LEGAL, legalFlags } from '../economy/legal.mjs';
import { changedParts, prepare, recordLanded } from '../economy/live.mjs';
import { ACCOUNT_OVERHEAD, compressedTree, model, MOST_RENT_PER_BYTE } from '../economy/model.mjs';
import { madeSoFar, plan, PER_APPROVAL } from '../economy/plan.mjs';
import { compareDetails, liveStepDetails, namesOf, outsideAddresses, stepDetails } from './details.mjs';
import { freshKeypair, verifySignature } from './ed25519.mjs';
import { checkLive, checkMints, LiveMismatch, MintMismatch, readRenames } from './live-check.mjs';
import { walletAdded } from './wallet-adds.mjs';

const PREPARE_TTL_MS = 90_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A refusal with the HTTP status the page gets. */
class ApproveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The chain the approval sends to: this process's cluster (`client/cluster.js`), through XSOLANA_RPC_URL or, on
 * devnet, its public RPC (a local validator passes for devnet). A URL that names another cluster is refused at once,
 * and before anything is sent the chain's genesis block is checked: another cluster is refused whatever the URL says.
 */
export function clusterChain(url) {
  // A URL that names another cluster is refused here. With none to use (mainnet has no RPC of its own), the refusal
  // waits for the first request, so what is wrong with the economy's file is said first.
  let made = null;
  const client = () => (made ??= rpcClient(clusterRpcUrl(url)));
  if (url || process.env.XSOLANA_RPC_URL || CLUSTERS[cluster()].rpc) client();
  let genesis = null;
  const checked = () =>
    (genesis ??= checkOnCluster(client()).catch(e => {
      genesis = null;
      throw e;
    }));
  return {
    get url() {
      return client().url ?? url;
    },
    latestBlockhash: async () => {
      await checked();
      return client().latestBlockhash();
    },
    rent: async bytes => BigInt(await client().call('getMinimumBalanceForRentExemption', [bytes])),
    send: async wire => {
      await checked();
      return client().send(wire);
    },
    confirm: (signature, options) => client().confirm(signature, options),
    account: address => client().account(address),
    /** A sent transaction's status from the whole history: { err, confirmationStatus }, or null when unseen. */
    signatureStatus: async signature =>
      (await client().call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0],
    blockHeight: () => client().blockHeight(),
    /** The chain's current epoch (a mint's transfer fee changes on one). */
    epoch: async () => Number((await client().call('getEpochInfo')).epoch),
  };
}

/**
 * Writes `text` to `file` whole or not at all: into a new file in the same folder, flushed to disk, then renamed over
 * it. A crash mid-write leaves the file as it was, never cut short. The file keeps its permissions; a link to it is
 * followed, so the file it points at is the one written.
 */
export async function writeWhole(file, text) {
  const target = await realpath(file).catch(() => file);
  const mode = await stat(target).then(
    s => s.mode & 0o777,
    () => 0o644,
  );
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await openFile(temp, 'wx', mode);
    try {
      await handle.writeFile(text);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

/** A wallet address as the page sent it, or a refusal (400) when it is not a Solana address. */
function walletAddress(wallet) {
  const text = String(wallet ?? '');
  try {
    addressBytes(text);
  } catch {
    throw new ApproveError(
      400,
      `${text ? JSON.stringify(text.slice(0, 60)) : 'No wallet'}: that is not a Solana address. Connect a wallet and try again.`,
    );
  }
  return text;
}

/**
 * Whether `value` (a spec, or any part of one) names `address`: a string that is the address, or that has it as one
 * of its parts between colons ("wallet:<address>", "@ata:<address>:<key>"), as a value or as a name. A link or a
 * sentence that only mentions the address names nothing.
 */
function namesAddress(value, address) {
  if (typeof value === 'string') return value.split(':').includes(address);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, v]) => name.split(':').includes(address) || namesAddress(v, address));
}

/**
 * One approval session for the spec in `file`. `chain`: { latestBlockhash, rent(bytes), send(wire), confirm(sig) }.
 * `write(file, text)` writes the spec file (`writeWhole`). Exposed for tests; `approve` serves it.
 * `mintKeys`: a Map or an object of <token key> → { address, sign(message), drop?() }, a key the owner supplies for
 * a token's new mint, so the mint is made at that key's address (one they chose) and not at a new one. It signs the
 * transaction that makes the mint as a fresh key would, and no other. Once the mint is made it can do nothing more at
 * that address on that cluster; on another cluster the same key can still make an account there.
 */
export async function createApproval({
  file,
  chain = clusterChain(),
  now = () => Math.floor(Date.now() / 1000),
  clock = Date.now,
  write = writeWhole,
  mintKeys = {},
}) {
  let spec = JSON.parse(await readFile(file, 'utf8'));
  if (spec.economy) spec = spec.economy;
  const verdict = check(spec, { now: now() });
  if (!verdict.ok)
    throw new ApproveError(400, `${file} does not check:\n${describe({ refusals: verdict.refusals, warnings: [] })}`);
  const keys = new Map();
  /** The mints whose key the owner supplied (`mintKeys`), by the name of the fresh account each stands for. */
  const supplied = new Map();
  {
    const m = model(spec, { now: now() });
    const given = new Map();
    // (a Map, or an object's own names: a name like "__proto__" is a name here and nothing else)
    for (const [key, k] of mintKeys instanceof Map ? mintKeys : Object.entries(mintKeys ?? {})) {
      const t = m.tokens.get(key);
      const named = [...m.tokens.values()].filter(x => x.source === 'game').map(x => x.key);
      if (!t)
        throw new ApproveError(
          400,
          `--mint-key names the token “${key}”, and ${path.basename(file)} has no token with that key${named.length ? ` (the tokens it makes: ${named.join(', ')})` : ''}. Nothing was sent.`,
        );
      // (a mint the spec names by its address is made already, and SOL or another project's token is not this one's)
      if (t.source !== 'game' || (t.mint && !t.mint.startsWith('@')))
        throw new ApproveError(
          400,
          `--mint-key names the token ${t.symbol ?? key}, whose mint this setup does not make${t.mint && !t.mint.startsWith('@') ? ` (the spec names it: ${t.mint})` : ''}: a key file is only for a mint the setup makes. Nothing was sent.`,
        );
      if (given.has(k.address))
        throw new ApproveError(
          400,
          `--mint-key gives the same key (${k.address}) for the tokens “${given.get(k.address)}” and “${key}”: each mint has an address of its own. Nothing was sent.`,
        );
      given.set(k.address, key);
      supplied.set(`new:mint/${key}`, k);
    }
  }
  let prepared = null;
  let busy = false;
  // One wallet read, prepare or complete at a time: each settles and writes the live section, and a batch built while
  // another batch lands would send that batch's steps again.
  let queue = Promise.resolve();
  const serial = fn => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  // Goes up each time the live section changes: a batch prepared before a change is never sent.
  let generation = 0;
  const signatures = [];
  // What a wallet added to transactions this session sent (its own checks, a compute budget): said on the page.
  const walletAdds = [];
  const at = now();
  const mode = !spec.live ? 'new' : spec.live.partial ? 'resume' : 'change';
  /**
   * The parts this session publishes: all of them for a new economy, what changed for a live one. A change that was
   * cut short (`partial`, with what was `published` before it) goes on as what the file says changed now, with what
   * it was changing when it stopped: a part added to the spec since is published too, never recorded as live unsent,
   * and a change that had no part to publish (a token's name alone) is still a change.
   */
  let only =
    mode === 'change'
      ? changedParts(spec).only
      : spec.live?.published
        ? new Set([...(spec.live.changing ?? []), ...changedParts(spec).only])
        : spec.live?.changing
          ? new Set(spec.live.changing)
          : null;
  if (mode === 'resume' && spec.live.published) spec = { ...spec, live: { ...spec.live, changing: [...only] } };
  /**
   * The live tokens whose name record this session writes again (plan.mjs `renames`), and in words the names the spec
   * changes that can't be written (`held`: their keys). Until a wallet connects: what the file itself says changed
   * since it was published. Once one has: what the chain says (`readRenames`), which is all that is ever sent.
   */
  let renames = new Set(spec.live?.published ? changedParts(spec).renames : []);
  let renameNotes = [];
  /**
   * Where the chain says otherwise than the file of the live project's treasury or authority (`checkLive`), in words:
   * its owner changed them, or handed the project on, outside these tools. Kept for the session once read (the
   * session's own copy of the live section says the chain's from then on).
   */
  let fileCorrections = [];
  /** Where the chain's treasury is not the one the spec names (`checkLive`), in words. */
  let chainNotes = [];
  /**
   * What the chain says of the live project, read for the wallet connected now: { creator, treasury, authority };
   * null before a wallet's read and for a project not made yet. Every setup this session builds is built on it.
   */
  let projectOnChain = null;
  let held = new Set();
  /** The tokens whose record already says the spec's new name, though the file's published spec says the old one. */
  let settled = new Set();
  /**
   * The names this session has written itself, with this spec's words: never offered again, even to a connection
   * that reads a slot behind. (A name an earlier session sent is not among them: the spec may have changed since, so
   * the chain alone says whether it is the one wanted.)
   */
  const renamed = new Set();
  /** The transactions this session sent itself. */
  const sentHere = new Set();
  /** What a plan of this session is scoped by. */
  const scope = () => ({ only, renames });

  /** What is live so far: the spec's own live section (a resumed or changed economy) and what landed this session. */
  const live = () => spec.live ?? null;
  /**
   * What the chain says the keys of the mints this spec names can do, where the spec doesn't say it (`checkMints`,
   * read when a wallet connects): shown with the legal flags, so the owner ticks having read them before approving.
   */
  let mintPowers = [];
  /**
   * A name for those lines as they stand (null: none). The page hands it back with the owner's tick: a batch is given
   * out only to a page that showed these very lines, so nothing read after the tick, or never shown, is skipped.
   */
  const readKey = () =>
    mintPowers.length
      ? createHash('sha256')
          .update(JSON.stringify(mintPowers.map(t => t.says)))
          .digest('hex')
          .slice(0, 24)
      : null;

  /**
   * Holds each mint key the owner supplied against the file and the chain, before anything is built: a mint is made
   * at an address nothing holds yet. A token whose mint an earlier run already made at that key's address needs
   * nothing more of it; one that is live elsewhere, an address the chain already has an account at, and the wallet's
   * own key are refused.
   */
  async function holdSupplied(wallet) {
    if (!supplied.size) return;
    const so = madeSoFar(live()) ?? {};
    const made = so.mints ?? {};
    const m = model(spec, { now: at });
    // The keys of the project as the chain has them: an address that is one of them is a key somebody signs with.
    const roles = new Map([[wallet, 'the key that signs this approval']]);
    if (so.project && typeof chain.account === 'function') {
      // (a read that fails stops here: with no answer, nothing says the address is not one of the project's keys)
      const account = await chain.account(so.project);
      if (account && account.owner === lootProgram() && accountKind(account.data) === 'Project') {
        const state = decode('Project', account.data);
        for (const [role, address] of [
          ['creator', state.creator],
          ['treasury', state.treasury],
          ['authority', state.authority],
          ['owner', state.owner],
        ])
          if (address !== wallet) roles.set(address, `the project’s ${role} on chain`);
      }
    }
    for (const [name, k] of supplied) {
      const key = name.slice('new:mint/'.length);
      const what = m.tokens.get(key)?.symbol ?? key;
      if (made[key] === k.address) continue;
      // Anything else the file names by that address (an authority, a treasury, a wallet a split pays, another
      // token's mint, the project, its collection): the file's own record of this very mint under way aside.
      const { pending: _pending, transactions: _transactions, ...section } = spec.live ?? {};
      const elsewhere = namesAddress(
        {
          ...spec,
          ...(spec.live
            ? {
                live: {
                  ...section,
                  mints: Object.fromEntries(Object.entries(section.mints ?? {}).filter(([n]) => n !== key)),
                },
              }
            : {}),
        },
        k.address,
      );
      if (made[key])
        throw new ApproveError(
          409,
          `The token ${what}’s mint is live already at ${made[key]}, and a mint’s address never changes: leave --mint-key out for it. Nothing was sent.`,
        );
      if (roles.has(k.address))
        throw new ApproveError(
          409,
          `--mint-key gives the token ${what} ${roles.get(k.address)} (${k.address}): a mint is made at an address of its own, never at a key somebody signs with. Nothing was sent.`,
        );
      if (elsewhere)
        throw new ApproveError(
          409,
          `--mint-key gives the token ${what} the address ${k.address}, which ${path.basename(file)} names for something else: a mint is made at an address of its own. Nothing was sent.`,
        );
      if (typeof chain.account !== 'function')
        throw new ApproveError(
          409,
          `--mint-key gives the token ${what} the address ${k.address}, and this connection cannot read the chain to check that nothing is there: nothing was sent.`,
        );
      if (await chain.account(k.address))
        throw new ApproveError(
          409,
          `--mint-key gives the token ${what} the address ${k.address}, and an account is there already on ${cluster()} (anything at an address counts, SOL sent to it too): a mint is made at an address nothing holds yet. Nothing was sent. (If an earlier run of this setup made the token’s mint there, the file has lost its record of it: restore the file as approve last wrote it. Leaving --mint-key out would make the mint at a new address.)`,
        );
      keys.set(name, k);
    }
  }

  /**
   * The owner a setup for `wallet` is built for, and its project, once every mint the spec names is held against the
   * chain (`checkMints`: its decimals and program) and so is the file's live section (`checkLive`): the wallet's own
   * project, or the project whose authority it is. A section that does not match is refused, and nothing is built on
   * it.
   */
  async function trust(wallet) {
    await holdSupplied(wallet);
    try {
      const m = model(spec, { now: at });
      // the project a mint the spec calls the project's must name: the live one, else this wallet's own to be
      const project = live()?.project ?? pda.project(wallet, m.projectNumber);
      mintPowers = (await checkMints({ m, chain, project })).powers;
    } catch (e) {
      if (!(e instanceof MintMismatch)) throw e;
      throw new ApproveError(
        409,
        `${e.message} Nothing was sent: correct ${path.basename(file)}, then run the same approve command again.`,
      );
    }
    try {
      const m = model(spec, { now: at });
      const trusted = await checkLive({ live: live(), m, wallet, chain });
      projectOnChain = trusted.treasury
        ? { creator: trusted.creator, treasury: trusted.treasury, authority: trusted.authority }
        : null;
      if (trusted.corrected.length) fileCorrections = trusted.corrected;
      chainNotes = trusted.notes;
      // The session's copy of the live section says of the project's treasury and authority what the chain says, so
      // what this session records is the chain's: the file says it once a step lands (or at once, with none to send).
      if (trusted.treasury && (spec.live.treasury !== trusted.treasury || spec.live.authority !== trusted.authority))
        spec = { ...spec, live: { ...spec.live, treasury: trusted.treasury, authority: trusted.authority } };
      // which names are written again is the chain's to say, read for the project's owner
      const read = await readRenames({
        live: live(),
        m,
        chain,
        owner: trusted.owner,
        published: spec.live?.published ?? null,
      });
      renames = new Set(read.renames.filter(key => !renamed.has(key)));
      renameNotes = read.notes;
      held = new Set(read.held);
      settled = new Set(read.settled);
      return trusted;
    } catch (e) {
      if (!(e instanceof LiveMismatch)) throw e;
      // Another key's project: the owner with the wrong key, or a file that came with someone else's live section
      // (the two look the same from here). Anything else: the file is not what the chain says.
      throw Object.assign(
        new ApproveError(
          409,
          e.settings
            ? `${e.message} Nothing was sent.`
            : e.notOwner
              ? `${e.message} Nothing was sent. If the project is yours, sign with the key that owns it (its key file, or \`approve --browser\` when a browser wallet owns it): ${path.basename(file)} needs no change, and a new key can change nothing. If it is not yours (the file came from someone else with their live section in it), that section is theirs: only then is it removed, to set up a project of your own.`
              : `${e.message} Nothing was sent. ${path.basename(file)}’s live section is not what the chain says: restore the file as approve wrote it. (Its live section is removed only to start a separate setup of one’s own, which leaves the live project as it is on chain.)`,
        ),
        { notOwner: Boolean(e.notOwner) },
      );
    }
  }

  async function build(owner) {
    const p0 = plan(spec, { now: at, live: live(), ...scope() });
    if (!p0.ok) throw new ApproveError(400, describe({ refusals: p0.refusals, warnings: [] }));
    for (const name of p0.freshKeys) if (!keys.has(name)) keys.set(name, freshKeypair());
    // The accounts the owner makes outside loot: a mint, and the project's tree of compressed NFTs.
    const tree = compressedTree(model(spec, { now: at }));
    const rents = new Map(
      await Promise.all(
        [MINT_BYTES, ...(tree ? [tree.bytes] : [])].map(async bytes => [
          bytes,
          boundedRent(bytes, await chain.rent(bytes)),
        ]),
      ),
    );
    const rent = bytes => {
      if (!rents.has(bytes)) throw new Error(`No rent known for ${bytes} bytes.`);
      return rents.get(bytes);
    };
    const addresses = Object.fromEntries([...keys].map(([n, k]) => [n, k.address]));
    // A recent slot, for the project's standing lookup table (made at go-live at a slot still in the slot hashes when it lands).
    const hashes = slotHashes((await chain.account(SYSVAR_SLOT_HASHES).catch(() => null))?.data);
    const p = prepare(spec, {
      owner,
      onChain: projectOnChain,
      keys: addresses,
      live: live() ?? {},
      now: at,
      rent,
      ...scope(),
      slot: hashes[0] ?? null,
    });
    if (!p.ok) throw new ApproveError(400, describe({ refusals: p.refusals, warnings: [] }));
    return p;
  }

  /**
   * What each step pays to whom and which keys it trusts, read back from its instructions, in full. A change says, for
   * a record that is live already, how each line differs from what is on chain (`readLive`).
   */
  const names = () =>
    namesOf(model(spec, { now: at }), {
      now: at,
      treasury: madeSoFar(live())?.treasury ?? model(spec, { now: at }).treasuryWallet ?? null,
    });
  /**
   * What is live, read from the chain once a wallet connects and the file's live section is checked: for each step,
   * the lines of the records it writes as they are on chain now ([] for a record not there yet), and the treasury.
   * Never the file's own `live.published`: whoever writes the file writes that too. Null until read.
   */
  let wasLive = null;
  async function readLive(p) {
    if (!spec.live?.published || typeof chain.account !== 'function') return;
    // The names a published list or key list goes by: the published spec's, each held against the root on chain.
    const n = namesOf(model(spec.live.published, { now: at }), { now: at, treasury: p.ctx.treasury });
    const was = new Map();
    for (const t of p.transactions) {
      for (const [i, step] of t.steps.entries()) {
        const lines = await liveStepDetails(t.built[i], n, chain);
        if (lines) was.set(step.id, lines);
      }
    }
    // A grant published before and gone from the chain (closed) that the change makes again with a list: a list leaf
    // names no grant or incarnation, so the same root would pay every listed round again.
    const remade = [];
    const published = new Set((spec.live.published.grants ?? []).map(g => g.key));
    for (const g of model(spec, { now: at }).grants) {
      if (!g.list?.length || !published.has(g.key) || !p.ctx.project) continue;
      if (!(await chain.account(pda.grant(p.ctx.project, g.id)).catch(() => 'unread')))
        remade.push(`“${g.name ?? g.key}”`);
    }
    wasLive = { steps: was, treasury: p.ctx.treasury, remade };
  }
  const detailsOf = (t, i, n) => {
    const lines = stepDetails(t.built[i], n);
    const was = wasLive?.steps.get(t.steps[i].id);
    return was ? compareDetails(lines, was) : lines;
  };
  /** The lines a change is held against for its outside-address warning: what was read from the chain, or nothing yet. */
  const wasLines = () =>
    spec.live?.published
      ? [
          ...(wasLive ? [...wasLive.steps.values()].flat() : []),
          ...(wasLive?.treasury ? [`Treasury: ${wasLive.treasury}`] : []),
        ]
      : null;
  const remadeLists = () =>
    wasLive?.remade?.length
      ? `This change makes ${wasLive.remade.join(', ')} again after it was closed, with the same list: a list names no grant, so every wallet on it could claim every listed round again. Give the grant a fresh list (new rounds) before you approve.`
      : null;
  const unread = () =>
    spec.live?.published && !wasLive
      ? 'What is live has not been read from the chain yet: connect your wallet, and each line is marked against what is on chain.'
      : null;

  // The project's own settings a change names are never published: the page says so.
  const changed = mode === 'change' ? changedParts(spec).settings : [];
  const settings = changed.length
    ? `This change names new project settings (${changed.join(', ')}) that publishing never writes: on chain they stay as they are.`
    : null;

  const legal = legalFlags(verdict);

  /** What each step does, in words, kept after it lands (the plan no longer lists it then). */
  const said = new Map();
  /** The same for the steps still to do: a step's words become `said` when this session's own transaction lands it. */
  const planned = new Map();
  function view(p, n = names(), extra = {}) {
    // A step the plan lists is still to do, whatever landed under its id before (a token's name written, then changed
    // again before the change was gone on with): it is never shown as done, nor among what landed.
    const steps = p.ok
      ? p.transactions.flatMap(t =>
          t.steps.map((s, i) => ({
            id: s.id,
            says: s.says,
            details: detailsOf(t, i, n),
            signer: t.signer,
            done: false,
          })),
        )
      : [];
    const todo = new Set(steps.map(s => s.id));
    const done = new Set((live()?.landed ?? []).filter(id => !todo.has(id)));
    // (what a landed step did is kept in its own words: a later step of the same id never rewrites them)
    for (const s of steps) planned.set(s.id, s);
    return {
      name: spec.name ?? path.basename(file),
      file: path.basename(file),
      mode,
      program: lootProgram(),
      cluster: cluster(),
      setupSol: cost(spec, { now: at, live: live(), ...scope() }).setup?.totalSol ?? null,
      warnings: [
        ...(extra.refused ? [extra.refused] : []),
        ...verdict.warnings.filter(w => !Object.hasOwn(LEGAL, w.code)).map(w => w.message),
        ...[
          settings,
          // A mint made at an address the owner chose: said with its address, which the code of the printout covers.
          ...[...supplied]
            .filter(([name]) => todo.has(`token:${name.slice('new:mint/'.length)}`))
            .map(
              ([name, k]) =>
                `The mint of the token ${model(spec, { now: at }).tokens.get(name.slice('new:mint/'.length))?.symbol ?? name.slice('new:mint/'.length)} is made at ${k.address}, the address of the key file given with --mint-key: that key signs the transaction that makes the mint, and no other. Once the mint is there the key can do nothing more at that address on ${cluster()}; on another cluster the same file can still make an account there, so keep it as you keep a key until it is used wherever you mean to.`,
            ),
          ...fileCorrections.map(
            line => `${line} Nothing is built on the file’s line, and the file is corrected when a step lands.`,
          ),
          ...chainNotes,
          ...renameNotes,
          unread(),
          remadeLists(),
          outsideAddresses(
            steps.flatMap(s => s.details),
            { was: wasLines(), owner: n.owner },
          ),
        ].filter(Boolean),
      ],
      // The legal flags in plain words, shown in a block of their own whatever the agent said: Approve waits until the
      // owner ticks that they read them. With them, what the chain says a named token's mint can do that the spec
      // doesn't say.
      legal: [...legal, ...mintPowers.map(t => ({ code: 'W-MINT-POWERS', says: t.says }))],
      ...(readKey() ? { read: readKey() } : {}),
      // A token's name the spec changes and the chain can't take: said whatever else is on the page, done or not.
      unwritten: [...renameNotes],
      authority: model(spec).authority,
      steps,
      landed: [...done].map(id => ({ id, says: said.get(id)?.says ?? id, details: said.get(id)?.details ?? [] })),
      signatures: [...signatures],
      // (what a wallet added to transactions it signed, in words: they were sent as it signed them)
      walletAdded: [...walletAdds],
      // The project the setup sends to, once a wallet is connected: always that wallet's own (or the one it is the
      // authority of).
      project: extra.project ?? null,
      wallet: n.owner ?? null,
      // The accounts this session made new keys for (a token's mint, the collection, the tree): their addresses are
      // this session's own, new each time, so what is shown twice differs in them and in nothing else.
      // (an address the owner supplied a key for is theirs, the same each time: named in the lines above instead)
      fresh: [...keys]
        .filter(([name]) => !supplied.has(name))
        .map(([name, k]) => ({ name: name.replace(/^new:/, ''), address: k.address })),
      ...(extra.refused ? { refused: extra.refused } : {}),
    };
  }

  const session = {
    get spec() {
      return spec;
    },
    /**
     * Ends the session's hold on the fresh keys: each is dropped (it can sign nothing more) and forgotten, and a batch
     * out for signing is withdrawn. Called once the economy is live and when the server closes; a later batch, if
     * any, is built on new keys.
     */
    close() {
      for (const k of keys.values()) k.drop?.();
      for (const k of supplied.values()) k.drop?.();
      keys.clear();
      prepared = null;
    },
    /** The steps still to go and what is done, built on stand-in addresses until a wallet connects. */
    state() {
      const p = plan(spec, { now: at, live: live(), ...scope() });
      const v = view(p);
      // (a file still marked as under way is settled, and recorded as live, only by a connected wallet's read)
      return {
        ...v,
        remaining: p.ok ? p.transactions.length : 0,
        done: p.ok && p.transactions.length === 0 && !spec.live?.partial,
      };
    },
    /**
     * The same, for the connected `wallet`: built exactly as its batches will be (its own project, the treasury on
     * chain), so the page names that project and calls only that wallet "your wallet". A live section the chain does
     * not bear out is said at the top, and nothing can be approved.
     */
    stateFor(wallet) {
      return serial(() => stateFor(walletAddress(wallet)));
    },
    /**
     * The next batch for `wallet` to sign: [base64 wire], with what each does. `read`: the state's `read`, as the page
     * showed it when the owner ticked the box (what the chain says of the tokens this economy names).
     */
    prepare(wallet, read = null) {
      if (busy) return Promise.reject(new ApproveError(409, 'A batch is being sent: wait for it.'));
      return serial(() => prepareFor(walletAddress(wallet), read));
    },
    /** The wallet's answer: checked against what was prepared, then sent and confirmed one by one. */
    complete(wallet, id, signed) {
      return serial(() => complete(walletAddress(wallet), id, signed));
    },
  };
  return session;

  async function stateFor(wallet) {
    let trusted;
    let p0 = plan(spec, { now: at, live: live(), ...scope() });
    try {
      await settlePending();
      // (what a transaction found landed leaves to do: shown as it is under a refusal too)
      p0 = plan(spec, { now: at, live: live(), ...scope() });
      trusted = await trust(wallet);
      await finish({ owner: trusted.owner });
      await settle();
      p0 = plan(spec, { now: at, live: live(), ...scope() });
    } catch (e) {
      if (!(e instanceof ApproveError)) throw e;
      const v = view(p0, namesOf(model(spec, { now: at }), { now: at, owner: wallet }), { refused: e.message });
      return {
        ...v,
        ...(e.notOwner ? { notOwner: true } : {}),
        remaining: p0.ok ? p0.transactions.length : 0,
        done: false,
      };
    }
    if (!p0.ok || !p0.transactions.length) {
      // With nothing to send, no step will land to correct a file that said otherwise than the chain of the project's
      // treasury or authority: it is written now, and the person is told with what the chain says of the treasury.
      const said = p0.ok ? [...(await correctFile()), ...chainNotes] : [];
      return {
        ...view(p0, names(), { project: trusted.project }),
        ...(said.length ? { chainSays: said } : {}),
        remaining: 0,
        done: p0.ok,
      };
    }
    const p = await build(trusted.owner);
    if (!p.transactions.length) {
      // Steps are planned and none builds: the lookup table's, which can't be made without a recent slot (the chain's
      // slot hashes did not read). Nothing needs the table, or the build would have refused, so the setup is as live
      // as it can be made and is recorded so.
      await finish(p.ctx, { nothingBuilds: true });
      const left = plan(spec, { now: at, live: live(), ...scope() });
      return { ...view(left, names(), { project: trusted.project }), remaining: 0, done: !spec.live?.partial };
    }
    await readLive(p);
    const v = view(p, namesOf(model(spec, { now: at }), { now: at, owner: wallet, treasury: p.ctx.treasury }), {
      project: p.ctx.project,
    });
    return { ...v, remaining: p.transactions.length, done: false };
  }

  async function prepareFor(wallet, read = null) {
    // A second ask while a batch is out for signing (a double click) gets that same batch, not a new one that would
    // make the first signature fail.
    if (
      prepared &&
      prepared.wallet === wallet &&
      prepared.generation === generation &&
      prepared.expires > clock() + 15_000
    )
      return answer(prepared);
    await settlePending();
    const trusted = await trust(wallet);
    await finish({ owner: trusted.owner });
    await settle();
    // What the chain says a named token's mint can do, where the spec doesn't say it, is read with the wallet's own
    // state: nothing is handed out to sign until the page has shown those very lines and the owner ticked after.
    if (readKey() && read !== readKey())
      throw new ApproveError(
        409,
        'What the chain says of this economy’s tokens was not on the page when the box was ticked: read the lines above, tick the box again, then approve.',
      );
    const p = await build(trusted.owner);
    if (!p.transactions.length) {
      // (planned steps none of which builds: see stateFor)
      await finish(p.ctx, { nothingBuilds: true });
      throw new ApproveError(409, 'Everything has landed already.');
    }
    await readLive(p);
    const authority = p.ctx.authority;
    const first = p.transactions[0];
    const signer = first.signer === 'authority' ? authority : p.ctx.owner;
    if (signer !== wallet)
      throw new ApproveError(
        403,
        first.signer === 'authority'
          ? `The next step is the authority’s: connect the wallet ${authority} and approve it there.`
          : `The next step is the project owner’s: connect the wallet ${p.ctx.owner} and approve it there.`,
      );
    const batch = [];
    for (const t of p.transactions) {
      if (t.signer !== first.signer || batch.length >= PER_APPROVAL) break;
      batch.push(t);
    }
    const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
    const wires = batch.map(t => {
      const message = compileMessage({ payer: wallet, blockhash, instructions: t.instructions });
      const { signers } = readTransaction(wireTransaction(message));
      const sigs = signers.map(s => {
        const [name, fresh] = [...keys].find(([, k]) => k.address === s) ?? [];
        if (!fresh) return new Uint8Array(64);
        // A key the owner supplied signs the making of its own token's mint, and no other transaction.
        if (supplied.has(name) && !t.steps.some(step => step.id === `token:${name.slice('new:mint/'.length)}`))
          throw new ApproveError(
            409,
            `A transaction that does not make the token “${name.slice('new:mint/'.length)}” names the address given with --mint-key (${s}) as a signer: the key file signs the making of its mint and nothing else. Nothing was sent.`,
          );
        return fresh.sign(message);
      });
      return wireTransaction(message, sigs);
    });
    // What each transaction pays to whom, read back from the very instructions the wallet signs.
    const n = namesOf(model(spec, { now: at }), { now: at, owner: wallet, treasury: p.ctx.treasury });
    // Every line names the project it goes to first: always the wallet's own, or the one it is the authority of.
    const details = batch.map(t => [
      `Project: ${p.ctx.project}${p.ctx.owner === wallet ? ' (your own)' : ` (owned by ${p.ctx.owner})`}`,
      ...t.steps.flatMap((_, i) => detailsOf(t, i, n)),
    ]);
    prepared = {
      id: randomBytes(12).toString('hex'),
      wallet,
      wires,
      batch,
      details,
      ctx: p.ctx,
      lastValidBlockHeight,
      generation,
      expires: clock() + PREPARE_TTL_MS,
    };
    return answer(prepared);
  }

  async function complete(wallet, id, signed) {
    if (!prepared || !sameText(prepared.id, String(id ?? '')))
      throw new ApproveError(409, 'That batch is not the one prepared: ask for the next one.');
    if (prepared.expires < clock()) {
      prepared = null;
      throw new ApproveError(410, 'That batch expired (90 seconds). Ask for it again.');
    }
    if (prepared.wallet !== wallet) throw new ApproveError(403, 'That batch was prepared for another wallet.');
    const batch = prepared;
    prepared = null;
    if (batch.generation !== generation)
      throw new ApproveError(409, 'Something landed after that batch was built: ask for the next one.');
    const { wires, added } = checkSigned(batch.wires, signed, wallet);
    busy = true;
    try {
      for (const [i, wire] of wires.entries()) {
        // The wire's first signature is its own: written into the file before it is sent, so one that lands
        // after its confirmation timed out (or after this process stopped) is found again before anything is
        // sent twice (`settlePending`).
        const signature = encodeBase58(readTransaction(wire).signatures[0]);
        const sent = batch.batch[i];
        sentHere.add(signature);
        await remember({
          signature,
          steps: sent.steps.map(s => s.id),
          made: madeBy(sent, batch.ctx),
          lastValidBlockHeight: batch.lastValidBlockHeight,
        });
        try {
          await chain.send(wire);
        } catch (e) {
          // A refusal alone does not say it was never taken: when the answer to a first send is lost, the same
          // transaction sent again is refused as already processed, and it has landed; or the second try reaches a
          // node a moment behind, which refuses it for a blockhash or an account it has not seen yet. So the chain
          // is asked before the signature is forgotten, and it is forgotten only when it can never land: the chain
          // says it failed, or a node answered this send with a refusal and no earlier try of it went unanswered
          // (`maybeTaken`). Anything else is kept, and looked up before anything is sent again.
          let status = null;
          let read = Boolean(chain.signatureStatus);
          if (read)
            try {
              status = await chain.signatureStatus(signature);
            } catch {
              read = false;
            }
          const taken = landedStatus(status) || (!status?.err && (Boolean(status) || alreadyProcessed(e)));
          if (!taken) {
            if (!chain.signatureStatus || status?.err || (read && e.code !== undefined && !e.maybeTaken))
              await forget(signature);
            throw e;
          }
        }
        try {
          await chain.confirm(signature, { lastValidBlockHeight: batch.lastValidBlockHeight });
        } catch (e) {
          // A confirmation can fail without the transaction failing (an RPC hiccup, a slow network): what the
          // chain says about it decides.
          const status = chain.signatureStatus ? await chain.signatureStatus(signature).catch(() => null) : null;
          if (!landedStatus(status)) {
            if (status?.err || !chain.signatureStatus) await forget(signature);
            else
              throw new ApproveError(
                503,
                `${e.message} It may still land: it is looked up on chain before anything is sent again, so approving again never sends it twice. Wait a minute, then ask for the next batch.`,
              );
            throw e;
          }
        }
        signatures.push(signature);
        // (what the wallet added to it is said once it has landed, never of one that did not)
        if (added[i]) walletAdds.push(added[i]);
        await landed(sent, batch.ctx, signature, { more: i < wires.length - 1 });
      }
    } finally {
      busy = false;
    }
    return session.state();
  }

  /** A prepared batch as the page gets it: the wires to sign, and what each does in words. */
  function answer(b) {
    return {
      id: b.id,
      project: b.ctx.project,
      transactions: b.wires.map(toBase64),
      says: b.batch.map(t => t.steps.map(s => s.says).join('; ')),
      // each transaction's steps, by id and in words: what a signer that showed the steps first holds them against
      steps: b.batch.map(t => t.steps.map(s => ({ id: s.id, says: s.says }))),
      details: b.details,
    };
  }

  /** What a transaction's steps make, from the context it was built with: recorded when it lands. */
  function madeBy(transaction, ctx) {
    const ids = new Set(transaction.steps.map(s => s.id));
    const mints = Object.fromEntries(
      [...ids].filter(id => id.startsWith('token:')).map(id => [id.slice(6), ctx.mints[id.slice(6)]]),
    );
    return {
      ...(ids.has('project') ? { project: ctx.project, treasury: ctx.treasury, authority: ctx.authority } : {}),
      ...(ids.has('collection') && ctx.collection ? { collection: ctx.collection } : {}),
      ...(ids.has('tree') && ctx.tree ? { tree: ctx.tree } : {}),
      ...(ids.has('table') && ctx.slot != null ? { tables: [tableAddress(ctx.owner, ctx.slot)[0]] } : {}),
      ...(Object.keys(mints).length ? { mints } : {}),
    };
  }

  /**
   * Writes a transaction about to be sent into the file's live section, as not seen landing yet. The section reads as
   * a setup (or a change) under way, as it does once a step lands (`landed`).
   */
  async function remember(entry) {
    const was = spec.live ?? {};
    spec = {
      ...spec,
      live: {
        ...was,
        landed: was.landed ?? [],
        partial: true,
        ...(only ? { changing: [...only] } : {}),
        pending: [...(was.pending ?? []), entry].slice(-60),
      },
    };
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }

  /** Takes a transaction out of the pending list: it landed (and is recorded), failed, or can no longer land. */
  async function forget(signature) {
    if (!spec.live?.pending) return;
    const pending = spec.live.pending.filter(p => p.signature !== signature);
    const { pending: _, ...rest } = spec.live;
    spec = { ...spec, live: pending.length ? { ...rest, pending } : rest };
    // A change of which nothing was sent that could land is no change under way: the file reads as live again, and
    // the next approve works out the change afresh.
    if (!pending.length && rest.partial && rest.published && !rest.landed?.length) {
      const { partial: _p, landed: _l, changing: _c, ...asItWas } = rest;
      spec = { ...spec, live: asItWas };
    }
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }

  /** The owner of `project` on chain, or null when it can't be read. */
  async function projectOwner(project) {
    if (!project || !chain.account) return null;
    const account = await chain.account(project).catch(() => null);
    return account && account.owner === lootProgram() && accountKind(account.data) === 'Project'
      ? decode('Project', account.data).owner
      : null;
  }

  /**
   * Looks up each transaction sent but not seen landing (`live.pending`): one that landed is recorded as landed, with
   * what it made; one that failed, or whose blockhash ran out before it landed, is dropped and its steps are made
   * again. One that may still land stops the next batch until it is known, so nothing is sent twice.
   */
  async function settlePending() {
    for (const entry of [...(spec.live?.pending ?? [])]) {
      if (!chain.signatureStatus) {
        await forget(entry.signature);
        continue;
      }
      const status = await chain.signatureStatus(entry.signature);
      if (landedStatus(status)) {
        if (!signatures.includes(entry.signature)) signatures.push(entry.signature);
        // (never recorded as the whole setup here: whether a token's name is still to write is read from the chain
        // first, in `trust`, and `finish` records it after)
        await landed(
          { steps: entry.steps.map(id => ({ id })) },
          { ...(entry.made ?? {}), owner: await projectOwner(entry.made?.project ?? spec.live?.project) },
          entry.signature,
          { more: true },
        );
        continue;
      }
      if (status?.err) {
        await forget(entry.signature);
        continue;
      }
      // Never seen, and its blockhash has run out: it can no longer land. (One seen but not yet confirmed may still.)
      const height = !status && chain.blockHeight ? await chain.blockHeight() : null;
      if (height !== null && entry.lastValidBlockHeight !== undefined && height > entry.lastValidBlockHeight) {
        await forget(entry.signature);
        continue;
      }
      throw new ApproveError(
        409,
        `The transaction ${entry.signature}, sent earlier, has not landed yet and may still: wait a minute and try again, so nothing is sent twice.`,
      );
    }
  }

  /**
   * One transaction landed: the spec's live section learns its steps, and the file is written at once. It names only
   * what those steps made (the project once `project` landed, a mint once its `token:` step did, …): an account whose
   * own transaction has not landed is made again when the setup goes on. `more`: more of the same batch is still to
   * send, or the chain has not been read yet for what is left (a transaction found landed from an earlier session):
   * the file is not recorded as live on this landing.
   */
  async function landed(transaction, ctx, signature, { more = false } = {}) {
    const was = spec.live ?? {};
    const ids = transaction.steps.map(s => s.id);
    const made = new Set(ids);
    const mints = { ...(was.mints ?? {}) };
    for (const id of ids)
      if (id.startsWith('token:') && ctx.mints?.[id.slice(6)]) mints[id.slice(6)] = ctx.mints[id.slice(6)];
    // What this session sent itself did what its steps were shown to do (one found landed from an earlier session
    // was built from the file as it was then, which may have been edited since: only the chain says what it did).
    if (sentHere.has(signature))
      for (const id of ids) {
        if (planned.has(id)) said.set(id, planned.get(id));
        // a name written with this spec's words is done
        if (id.startsWith('name:')) {
          renames.delete(id.slice(5));
          renamed.add(id.slice(5));
        }
      }
    const progress = {
      ...was,
      program: lootProgram(),
      ...(made.has('project') ? { project: ctx.project, treasury: ctx.treasury, authority: ctx.authority } : {}),
      ...(made.has('collection') && ctx.collection ? { collection: ctx.collection } : {}),
      ...(made.has('tree') && ctx.tree ? { tree: ctx.tree } : {}),
      ...(made.has('table') && ctx.slot != null ? { tables: [tableAddress(ctx.owner, ctx.slot)[0]] } : {}),
      // (a transaction found landed from an earlier session names the table it made itself)
      ...(made.has('table') && ctx.slot == null && ctx.tables?.length ? { tables: ctx.tables } : {}),
      mints,
      landed: [...new Set([...(was.landed ?? []), ...ids])],
      partial: true,
      ...(only ? { changing: [...only] } : {}),
      // (each signature once: one found again by `settlePending` may have been recorded already)
      transactions: (was.transactions ?? []).some(t => t.signature === signature)
        ? was.transactions
        : [...(was.transactions ?? []), { signature }].slice(-60),
      pending: (was.pending ?? []).filter(p => p.signature !== signature),
    };
    if (!progress.pending.length) delete progress.pending;
    if (!Object.keys(progress.mints).length) delete progress.mints;
    if (!progress.collection) delete progress.collection;
    spec = { ...spec, live: progress };
    generation++;
    if (!more) record(ctx);
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }

  /**
   * Records the setup or the change as live, once nothing of it is left: no transaction still looked for, and no step
   * in a plan made with what the chain says of the tokens' names (`trust`, read for this session's wallet before this
   * is ever called). `published` becomes the spec as it is, but for a token's name the chain could not take (`held`):
   * that token keeps the name, ticker and link it was published with, so the file never says of a name what the chain
   * does not, and the next approve says it again. Returns whether it did.
   */
  function record(ctx = {}, { nothingBuilds = false } = {}) {
    const progress = spec.live;
    if (!progress?.partial || progress.pending?.length) return false;
    // `nothingBuilds`: the plan built for this wallet has no transaction, whatever a plan on stand-in addresses lists
    const rest = plan(spec, { now: at, live: progress, ...scope() });
    if (!rest.ok || (rest.transactions.length && !nothingBuilds)) return false;
    const { live: _, ...bare } = spec;
    // Everything the setup made, whichever session or transaction made it.
    const all = {
      ...ctx,
      ...Object.fromEntries(
        ['project', 'treasury', 'authority', 'collection', 'tree', 'tables'].map(k => [k, progress[k] ?? ctx[k]]),
      ),
      mints: { ...(ctx.mints ?? {}), ...(progress.mints ?? {}) },
    };
    const final = recordLanded(bare, { ctx: all, now: at, at: new Date(clock()).toISOString() });
    const before = progress.published?.tokens ?? null;
    if (before && held.size)
      final.live.published.tokens = final.live.published.tokens.map(t => {
        const was = held.has(t.key) ? before.find(x => x.key === t.key) : null;
        if (!was) return t;
        const { name: _n, symbol: _s, uri: _u, ...kept } = t;
        return {
          ...kept,
          ...Object.fromEntries(['name', 'symbol', 'uri'].filter(f => was[f] !== undefined).map(f => [f, was[f]])),
        };
      });
    final.live = { ...final.live, transactions: progress.transactions ?? [] };
    spec = final;
    only = changedParts(spec).only;
    return true;
  }

  /**
   * Writes the file with the chain's treasury and authority where it said otherwise (the session's copy says them
   * since the wallet's read): for a read that finds nothing to send. Returns the lines that say so.
   */
  async function correctFile() {
    if (!fileCorrections.length) return [];
    const lines = fileCorrections.map(line => `${line} The file now says the chain’s.`);
    fileCorrections = [];
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
    return lines;
  }

  /** `record`, with the file written when it did: after a wallet's read found nothing left of a setup under way. */
  async function finish(ctx, options) {
    if (!record(ctx, options)) return;
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }

  /**
   * A name the chain already carries is the published one from here on (`settled`, from this wallet's read): only
   * that token's name, ticker and link move in the file's published spec, so no tool keeps announcing a change that
   * is done. A setup or change under way records it when it is recorded as live.
   */
  async function settle() {
    const now = spec.live;
    if (!now?.published || now.partial || !settled.size) return;
    const tokens = (now.published.tokens ?? []).map(t => {
      const said = settled.has(t.key) ? (spec.tokens ?? []).find(x => x.key === t.key) : null;
      if (!said) return t;
      const { name: _n, symbol: _s, uri: _u, ...kept } = t;
      return {
        ...kept,
        ...Object.fromEntries(['name', 'symbol', 'uri'].filter(f => said[f] !== undefined).map(f => [f, said[f]])),
      };
    });
    spec = { ...spec, live: { ...now, published: { ...now.published, tokens } } };
    settled = new Set();
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }
}

/**
 * The rent the RPC gave for an account of `bytes`, once held against what rent can be: the lamports go into an account
 * the setup makes and can never close, so an RPC that asks more than any cluster charges is refused. Less is safe: the
 * chain refuses an account short of its rent, and nothing is lost.
 */
function boundedRent(bytes, lamports) {
  const most = (BigInt(bytes) + ACCOUNT_OVERHEAD) * MOST_RENT_PER_BYTE;
  const given = BigInt(lamports);
  if (given > most)
    throw new ApproveError(
      502,
      `The RPC says an account of ${bytes} bytes needs ${given} lamports of rent; no cluster charges more than ${most}. Nothing was sent: use another RPC (XSOLANA_RPC_URL).`,
    );
  return given;
}

/** Whether a signature's status says it landed: confirmed or finalized, and not failed. */
const landedStatus = status =>
  Boolean(
    status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'),
  );

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The wallet's signed copies, as they are sent: { wires, added }. Each is the exact prepared message with the wallet's
 * valid signature, or, from a wallet that adds to what it signs, the wallet's own message with its signature, taken
 * only when everything prepared is in it untouched and what it added is a wallet's own (`walletAdded`,
 * js/approve/wallet-adds.mjs: instructions of the Lighthouse program, a heap size). `added`: for each transaction, what
 * was added to it in words, or null. Anything else is refused, and nothing is sent.
 */
function checkSigned(prepared, signed, wallet) {
  if (!Array.isArray(signed) || signed.length !== prepared.length)
    throw new ApproveError(400, 'The wallet’s answer does not match the request.');
  const added = prepared.map(() => null);
  const wires = prepared.map((wire, i) => {
    let mine;
    let theirs;
    try {
      mine = readTransaction(wire);
      theirs = readTransaction(fromBase64(String(signed[i])));
    } catch {
      throw new ApproveError(400, 'The wallet returned something that is not a transaction.');
    }
    if (!equalBytes(mine.message, theirs.message)) {
      const taken = walletAdded(mine.message, theirs.message, wallet);
      if (!taken.ok)
        throw new ApproveError(
          400,
          `The wallet changed the transaction before signing it (it ${taken.why}), so nothing was sent. A wallet may add its own checks (instructions of the Lighthouse program) to a transaction it alone signs; everything that was prepared and shown here must be in it untouched, and nothing else may be. (A setup that has not started can be signed by a key file instead: xsolana approve --keypair. One that has started is finished by the key that started it.)`,
        );
      // The wallet's own message, with the wallet's own signature: it is the transaction's one signer.
      const signature = theirs.signatures[0];
      if (theirs.signers[0] !== wallet || !verifySignature(wallet, theirs.message, signature))
        throw new ApproveError(400, 'The wallet’s signature is missing or does not match your wallet.');
      added[i] = `Transaction ${i + 1} of its batch: your wallet added ${taken.added.join(', ')}.`;
      return wireTransaction(theirs.message, [signature]);
    }
    const slot = mine.signers.indexOf(wallet);
    if (slot < 0) throw new ApproveError(400, 'This transaction was not prepared for that wallet.');
    const signature = theirs.signatures[slot];
    if (!verifySignature(wallet, mine.message, signature))
      throw new ApproveError(400, 'The wallet’s signature is missing or does not match your wallet.');
    const signatures = [...mine.signatures];
    signatures[slot] = signature;
    return wireTransaction(mine.message, signatures);
  });
  return { wires, added };
}

// ---------------------------------------------------------------- the page

const BROWSER_FILES = /^\/js\/(chain\/bytes\.js|approve\/page\.js)$/;
/** The most a request's body may hold. */
const BODY_LIMIT = 200_000;

/**
 * What the page may load and do (its Content-Security-Policy): scripts only from this server, its one style block by
 * its hash, requests only to this server, and no other page may frame it.
 */
function pagePolicy(page) {
  const css = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? '';
  const hash = createHash('sha256').update(css).digest('base64');
  return `default-src 'none'; script-src 'self'; style-src 'sha256-${hash}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * Whether a request is for this server by its own name: its Host is 127.0.0.1:<port> or localhost:<port>, and its
 * Origin, when it has one, is that too. Another name (a site whose address was pointed at 127.0.0.1) is refused.
 */
export function ownRequest(headers, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(String(headers.host ?? '').toLowerCase())) return false;
  if (headers.origin === undefined) return true;
  return hosts.some(h => String(headers.origin).toLowerCase() === `http://${h}`);
}

/** A request's body, as text: refused (413) past `limit` bytes, and the rest of it read and let go. */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) return reject(new ApproveError(413, 'That request is too large.'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A request's body as JSON ({} when empty): refused (400) when it is not JSON. */
async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApproveError(400, 'The request is not JSON.');
  }
}

/**
 * Opens the browser on `url` (the one-time code's link) without putting it on a command line, which other users of the
 * machine can read while the opener runs: the link goes into a page that sends the browser on to it, written
 * to a file only this user can read (0600, in a new 0700 folder), and the opener is given that file's path. Answers a
 * function that removes the file (the server calls it once the code is used, and when it closes).
 */
export async function openBrowser(url, { spawnImpl = spawn, dir = tmpdir() } = {}) {
  const folder = await mkdtemp(path.join(dir, 'xsolana-approve-'));
  const remove = () => rm(folder, { recursive: true, force: true }).catch(() => {});
  try {
    await chmod(folder, 0o700);
    const file = path.join(folder, 'open.html');
    const href = url.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    await writeFile(
      file,
      `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${href}"><title>xsolana approve</title><a href="${href}">Open the approval page</a>\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [file]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', file]]
          : ['xdg-open', [file]];
    spawnImpl(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the link is printed anyway */
  }
  return remove;
}

/**
 * Serves the approval page for `file` until the economy is live (or the process is stopped). Returns { server, link,
 * opened, session }: `link` carries the session's token and is printed; `opened`, the link the browser is opened with
 * (`openLink`), carries a one-time code instead. The code works once: it answers with `link`, and is no use to anyone
 * after. The default `openLink` keeps even the code off the opener's command line (`openBrowser`); one that answers a
 * function has it called once the code is used.
 */
export async function approve({
  file = 'xsolana.json',
  port,
  open = true,
  chain = clusterChain(),
  log = (...a) => console.error(...a),
  openLink = openBrowser,
} = {}) {
  const session = await createApproval({ file: path.resolve(file), chain });
  const token = randomBytes(18).toString('base64url');
  let code = randomBytes(18).toString('base64url');
  // (removes the file the browser was opened with, once: `openLink` answers how)
  let removeOpener = null;
  const forget = () => {
    const remove = removeOpener;
    removeOpener = null;
    remove?.();
  };
  const page = await readFile(path.join(ROOT, 'approve/page.html'), 'utf8');
  const policy = pagePolicy(page);
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': policy,
    'x-frame-options': 'DENY',
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      // Only a request to this server by its own name (DNS rebinding: a site whose name now points at 127.0.0.1).
      if (!ownRequest(req.headers, server.address().port))
        return send(403, 'Open the link `xsolana approve` printed.', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/') {
        const once = url.searchParams.get('c');
        if (once !== null) {
          if (!code || !sameText(once, code))
            return send(
              403,
              'This link has been opened already: open the link `xsolana approve` printed.',
              'text/plain',
            );
          code = null;
          forget();
          res.writeHead(303, { ...headers, location: `/?t=${token}` });
          return res.end();
        }
        if (!sameText(url.searchParams.get('t') ?? '', token))
          return send(403, 'Open the link `xsolana approve` printed.', 'text/plain');
        return send(200, page.replace('__TOKEN__', token), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && BROWSER_FILES.test(url.pathname))
        return send(
          200,
          await readFile(path.join(ROOT, url.pathname.slice(4)), 'utf8'),
          'text/javascript; charset=utf-8',
        );
      if (!sameText(req.headers['x-xsolana-token'] ?? '', token))
        return send(403, { error: 'Not this session’s page.' });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const wallet = url.searchParams.get('wallet');
        return send(200, wallet ? await session.stateFor(wallet) : session.state());
      }
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'POST' && url.pathname === '/api/prepare')
        return send(
          200,
          await session.prepare(String(body.wallet ?? ''), typeof body.read === 'string' ? body.read : null),
        );
      if (req.method === 'POST' && url.pathname === '/api/complete') {
        const state = await session.complete(String(body.wallet ?? ''), body.id, body.transactions);
        if (state.done) {
          session.close();
          log(`Live. ${file} now holds the project’s addresses.`);
          // Nothing is left to approve: the server stops once the page has its answer, and `xsolana approve` ends.
          res.once('finish', () => server.close());
        }
        return send(200, state);
      }
      return send(404, { error: 'Not found.' });
    } catch (e) {
      return send(e.status ?? 500, { error: e.message });
    }
  });
  server.on('close', () => session.close());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const link = `${origin}/?t=${token}`;
  const opened = `${origin}/?c=${code}`;
  log(`Approve going live in your wallet (devnet): ${link}`);
  log(
    'Leave this running until the page says it is live. Ctrl+C stops it; running it again goes on from where it stopped.',
  );
  if (open && !process.env.XSOLANA_NO_OPEN) {
    const remove = await openLink(opened);
    if (typeof remove === 'function') {
      // the file that opened the browser goes once the code is used, when the server closes, or after a minute
      removeOpener = remove;
      setTimeout(forget, 60_000).unref();
      server.on('close', forget);
    }
  }
  return { server, link, opened, session };
}
