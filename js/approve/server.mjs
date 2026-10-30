// `xsolana approve`: a page on 127.0.0.1 where the owner of an economy approves going live in their own wallet. The
// server builds each transaction (js/economy/plan.mjs), has the fresh keys a setup makes sign their part, and sends
// only what it prepared: a wallet's answer must carry the exact message prepared for it and that wallet's valid
// signature. Each prepared batch answers once and expires after 90 seconds. What lands is written back into the spec
// file as it lands, so a setup cut short goes on from where it stopped. The server never sees the owner's key.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, open as openFile, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { equalBytes, fromBase64, toBase64 } from '../chain/bytes.js';
import { checkCluster, notMainnet, rpcClient } from '../chain/rpc.js';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { MINT_BYTES } from '../chain/token.js';
import { compileMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { accountKind, decode } from '../client/accounts.js';
import { LOOT_PROGRAM } from '../client/pda.js';
import { check, describe } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { LEGAL, legalFlags } from '../economy/legal.mjs';
import { changedParts, prepare, recordLanded } from '../economy/live.mjs';
import { ACCOUNT_OVERHEAD, compressedTree, model, MOST_RENT_PER_BYTE } from '../economy/model.mjs';
import { madeSoFar, plan, PER_APPROVAL } from '../economy/plan.mjs';
import { compareDetails, liveStepDetails, namesOf, outsideAddresses, stepDetails } from './details.mjs';
import { freshKeypair, verifySignature } from './ed25519.mjs';
import { checkLive, checkMints, LiveMismatch, MintMismatch } from './live-check.mjs';

const PREPARE_TTL_MS = 90_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEVNET = 'https://api.devnet.solana.com';

/** A refusal with the HTTP status the page gets. */
class ApproveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The chain the approval sends to: devnet by default (XSOLANA_RPC_URL to use another devnet RPC, or a local validator).
 * A mainnet URL is refused at once, and before anything is sent the chain's genesis block is checked: mainnet and
 * testnet are refused whatever the URL says.
 */
export function devnetChain(url = process.env.XSOLANA_RPC_URL || DEVNET) {
  const rpc = rpcClient(notMainnet(url));
  let cluster = null;
  const checked = () => (cluster ??= checkCluster(rpc).catch((e) => {
    cluster = null;
    throw e;
  }));
  return {
    url,
    latestBlockhash: async () => {
      await checked();
      return rpc.latestBlockhash();
    },
    rent: async (bytes) => BigInt(await rpc.call('getMinimumBalanceForRentExemption', [bytes])),
    send: async (wire) => {
      await checked();
      return rpc.send(wire);
    },
    confirm: (signature, options) => rpc.confirm(signature, options),
    account: (address) => rpc.account(address),
    /** A sent transaction's status from the whole history: { err, confirmationStatus }, or null when unseen. */
    signatureStatus: async (signature) => (await rpc.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0],
    blockHeight: () => rpc.blockHeight(),
  };
}

/**
 * Writes `text` to `file` whole or not at all: into a new file in the same folder, flushed to disk, then renamed over
 * it. A crash mid-write leaves the file as it was, never cut short. The file keeps its permissions; a link to it is
 * followed, so the file it points at is the one written.
 */
export async function writeWhole(file, text) {
  const target = await realpath(file).catch(() => file);
  const mode = await stat(target).then((s) => s.mode & 0o777, () => 0o644);
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
    throw new ApproveError(400, `${text ? JSON.stringify(text.slice(0, 60)) : 'No wallet'}: that is not a Solana address. Connect a wallet and try again.`);
  }
  return text;
}

/**
 * One approval session for the spec in `file`. `chain`: { latestBlockhash, rent(bytes), send(wire), confirm(sig) }.
 * `write(file, text)` writes the spec file (`writeWhole`). Exposed for tests; `approve` serves it.
 */
export async function createApproval({ file, chain = devnetChain(), now = () => Math.floor(Date.now() / 1000), clock = Date.now, write = writeWhole }) {
  let spec = JSON.parse(await readFile(file, 'utf8'));
  if (spec.economy) spec = spec.economy;
  const verdict = check(spec, { now: now() });
  if (!verdict.ok) throw new ApproveError(400, `${file} does not check:\n${describe({ refusals: verdict.refusals, warnings: [] })}`);
  const keys = new Map();
  let prepared = null;
  let busy = false;
  // One wallet read, prepare or complete at a time: each settles and writes the live section, and a batch built while
  // another batch lands would send that batch's steps again.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  // Goes up each time the live section changes: a batch prepared before a change is never sent.
  let generation = 0;
  const signatures = [];
  const at = now();
  const mode = !spec.live ? 'new' : spec.live.partial ? 'resume' : 'change';
  /** The parts this session publishes: all of them for a new economy, what changed for a live one. */
  let only = mode === 'change' ? changedParts(spec).only : spec.live?.changing ? new Set(spec.live.changing) : null;

  /** What is live so far: the spec's own live section (a resumed or changed economy) and what landed this session. */
  const live = () => spec.live ?? null;

  /**
   * The owner a setup for `wallet` is built for, and its project, once every mint the spec names is held against the
   * chain (`checkMints`: its decimals and program) and so is the file's live section (`checkLive`): the wallet's own
   * project, or the project whose authority it is. A section that does not match is refused, and nothing is built on
   * it.
   */
  async function trust(wallet) {
    try {
      await checkMints({ m: model(spec, { now: at }), chain });
    } catch (e) {
      if (!(e instanceof MintMismatch)) throw e;
      throw new ApproveError(409, `${e.message} Nothing was sent: correct ${path.basename(file)}, then run \`xsolana approve\` again.`);
    }
    try {
      return await checkLive({ live: live(), m: model(spec, { now: at }), wallet, chain });
    } catch (e) {
      if (!(e instanceof LiveMismatch)) throw e;
      throw new ApproveError(409, `${e.message} Nothing was sent. ${path.basename(file)}’s live section is not what the chain says: restore the file \`xsolana approve\` wrote, or remove its live section to start a new setup.`);
    }
  }

  async function build(owner) {
    const p0 = plan(spec, { now: at, live: live(), only });
    if (!p0.ok) throw new ApproveError(400, describe({ refusals: p0.refusals, warnings: [] }));
    for (const name of p0.freshKeys) if (!keys.has(name)) keys.set(name, freshKeypair());
    // The accounts the owner makes outside loot: a mint, and the project's tree of compressed NFTs.
    const tree = compressedTree(model(spec, { now: at }));
    const rents = new Map(await Promise.all([MINT_BYTES, ...(tree ? [tree.bytes] : [])].map(async (bytes) => [bytes, boundedRent(bytes, await chain.rent(bytes))])));
    const rent = (bytes) => {
      if (!rents.has(bytes)) throw new Error(`No rent known for ${bytes} bytes.`);
      return rents.get(bytes);
    };
    const addresses = Object.fromEntries([...keys].map(([n, k]) => [n, k.address]));
    const p = prepare(spec, { owner, keys: addresses, live: live() ?? {}, now: at, rent, only });
    if (!p.ok) throw new ApproveError(400, describe({ refusals: p.refusals, warnings: [] }));
    return p;
  }

  /**
   * What each step pays to whom and which keys it trusts, read back from its instructions, in full. A change says, for
   * a record that is live already, how each line differs from what is on chain (`readLive`).
   */
  const names = () => namesOf(model(spec, { now: at }), { treasury: madeSoFar(live())?.treasury ?? model(spec, { now: at }).treasuryWallet ?? null });
  /**
   * What is live, read from the chain once a wallet connects and the file's live section is checked: for each step,
   * the lines of the records it writes as they are on chain now ([] for a record not there yet), and the treasury.
   * Never the file's own `live.published`: whoever writes the file writes that too. Null until read.
   */
  let wasLive = null;
  async function readLive(p) {
    if (!spec.live?.published || typeof chain.account !== 'function') return;
    // The names a published list or key list goes by: the published spec's, each held against the root on chain.
    const n = namesOf(model(spec.live.published, { now: at }), { treasury: p.ctx.treasury });
    const was = new Map();
    for (const t of p.transactions) {
      for (const [i, step] of t.steps.entries()) {
        const lines = await liveStepDetails(t.built[i], n, chain);
        if (lines) was.set(step.id, lines);
      }
    }
    wasLive = { steps: was, treasury: p.ctx.treasury };
  }
  const detailsOf = (t, i, n) => {
    const lines = stepDetails(t.built[i], n);
    const was = wasLive?.steps.get(t.steps[i].id);
    return was ? compareDetails(lines, was) : lines;
  };
  /** The lines a change is held against for its outside-address warning: what was read from the chain, or nothing yet. */
  const wasLines = () => (spec.live?.published ? [...(wasLive ? [...wasLive.steps.values()].flat() : []), ...(wasLive?.treasury ? [`Treasury: ${wasLive.treasury}`] : [])] : null);
  const unread = () => (spec.live?.published && !wasLive ? 'What is live has not been read from the chain yet: connect your wallet, and each line is marked against what is on chain.' : null);

  // The project's own settings a change names are never published: the page says so.
  const changed = mode === 'change' ? changedParts(spec).settings : [];
  const settings = changed.length ? `This change names new project settings (${changed.join(', ')}) that publishing never writes: on chain they stay as they are.` : null;

  const legal = legalFlags(verdict);

  /** What each step does, in words, kept after it lands (the plan no longer lists it then). */
  const said = new Map();
  function view(p, n = names(), extra = {}) {
    const done = new Set(live()?.landed ?? []);
    const steps = p.ok ? p.transactions.flatMap((t) => t.steps.map((s, i) => ({ id: s.id, says: s.says, details: detailsOf(t, i, n), signer: t.signer, done: done.has(s.id) }))) : [];
    for (const s of steps) said.set(s.id, s);
    return {
      name: spec.name ?? path.basename(file),
      file: path.basename(file),
      mode,
      program: LOOT_PROGRAM,
      cluster: 'devnet',
      setupSol: cost(spec, { now: at, live: live(), only }).setup?.totalSol ?? null,
      warnings: [...(extra.refused ? [extra.refused] : []), ...verdict.warnings.filter((w) => !Object.hasOwn(LEGAL, w.code)).map((w) => w.message), ...[settings, unread(), outsideAddresses(steps.flatMap((s) => s.details), { was: wasLines(), owner: n.owner })].filter(Boolean)],
      // The legal flags in plain words, shown in a block of their own whatever the agent said: Approve waits until the
      // owner ticks that they read them.
      legal,
      authority: model(spec).authority,
      steps,
      landed: [...done].map((id) => ({ id, says: said.get(id)?.says ?? id, details: said.get(id)?.details ?? [] })),
      signatures: [...signatures],
      // The project the setup sends to, once a wallet is connected: always that wallet's own (or the one it is the
      // authority of).
      project: extra.project ?? null,
      wallet: n.owner ?? null,
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
      for (const k of keys.values()) k.drop();
      keys.clear();
      prepared = null;
    },
    /** The steps still to go and what is done, built on stand-in addresses until a wallet connects. */
    state() {
      const p = plan(spec, { now: at, live: live(), only });
      const v = view(p);
      return { ...v, remaining: p.ok ? p.transactions.length : 0, done: p.ok && p.transactions.length === 0 };
    },
    /**
     * The same, for the connected `wallet`: built exactly as its batches will be (its own project, the treasury on
     * chain), so the page names that project and calls only that wallet "your wallet". A live section the chain does
     * not bear out is said at the top, and nothing can be approved.
     */
    stateFor(wallet) {
      return serial(() => stateFor(walletAddress(wallet)));
    },
    /** The next batch for `wallet` to sign: [base64 wire], with what each does. */
    prepare(wallet) {
      if (busy) return Promise.reject(new ApproveError(409, 'A batch is being sent: wait for it.'));
      return serial(() => prepareFor(walletAddress(wallet)));
    },
    /** The wallet's answer: checked against what was prepared, then sent and confirmed one by one. */
    complete(wallet, id, signed) {
      return serial(() => complete(walletAddress(wallet), id, signed));
    },
  };
  return session;

  async function stateFor(wallet) {
    let trusted;
    let p0 = plan(spec, { now: at, live: live(), only });
    try {
      await settlePending();
      p0 = plan(spec, { now: at, live: live(), only });
      trusted = await trust(wallet);
    } catch (e) {
      if (!(e instanceof ApproveError)) throw e;
      const v = view(p0, namesOf(model(spec, { now: at }), { owner: wallet }), { refused: e.message });
      return { ...v, remaining: p0.ok ? p0.transactions.length : 0, done: false };
    }
    if (!p0.ok || !p0.transactions.length) return { ...view(p0, names(), { project: trusted.project }), remaining: 0, done: p0.ok };
    const p = await build(trusted.owner);
    await readLive(p);
    const v = view(p, namesOf(model(spec, { now: at }), { owner: wallet, treasury: p.ctx.treasury }), { project: p.ctx.project });
    return { ...v, remaining: p.transactions.length, done: false };
  }

  async function prepareFor(wallet) {
    // A second ask while a batch is out for signing (a double click) gets that same batch, not a new one that would
    // make the first signature fail.
    if (prepared && prepared.wallet === wallet && prepared.generation === generation && prepared.expires > clock() + 15_000) return answer(prepared);
    await settlePending();
    const trusted = await trust(wallet);
    const p = await build(trusted.owner);
    if (!p.transactions.length) throw new ApproveError(409, 'Everything has landed already.');
    await readLive(p);
    const authority = p.ctx.authority;
    const first = p.transactions[0];
    const signer = first.signer === 'authority' ? authority : p.ctx.owner;
    if (signer !== wallet) throw new ApproveError(403, first.signer === 'authority' ? `The next step is the authority’s: connect the wallet ${authority} and approve it there.` : `The next step is the project owner’s: connect the wallet ${p.ctx.owner} and approve it there.`);
    const batch = [];
    for (const t of p.transactions) {
      if (t.signer !== first.signer || batch.length >= PER_APPROVAL) break;
      batch.push(t);
    }
    const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
    const wires = batch.map((t) => {
      const message = compileMessage({ payer: wallet, blockhash, instructions: t.instructions });
      const { signers } = readTransaction(wireTransaction(message));
      const sigs = signers.map((s) => {
        const fresh = [...keys.values()].find((k) => k.address === s);
        return fresh ? fresh.sign(message) : new Uint8Array(64);
      });
      return wireTransaction(message, sigs);
    });
    // What each transaction pays to whom, read back from the very instructions the wallet signs.
    const n = namesOf(model(spec, { now: at }), { owner: wallet, treasury: p.ctx.treasury });
    // Every line names the project it goes to first: always the wallet's own, or the one it is the authority of.
    const details = batch.map((t) => [`Project: ${p.ctx.project}${p.ctx.owner === wallet ? ' (your own)' : ` (owned by ${p.ctx.owner})`}`, ...t.steps.flatMap((_, i) => detailsOf(t, i, n))]);
    prepared = { id: randomBytes(12).toString('hex'), wallet, wires, batch, details, ctx: p.ctx, lastValidBlockHeight, generation, expires: clock() + PREPARE_TTL_MS };
    return answer(prepared);
  }

  async function complete(wallet, id, signed) {
    if (!prepared || !sameText(prepared.id, String(id ?? ''))) throw new ApproveError(409, 'That batch is not the one prepared: ask for the next one.');
    if (prepared.expires < clock()) {
      prepared = null;
      throw new ApproveError(410, 'That batch expired (90 seconds). Ask for it again.');
    }
    if (prepared.wallet !== wallet) throw new ApproveError(403, 'That batch was prepared for another wallet.');
    const batch = prepared;
    prepared = null;
    if (batch.generation !== generation) throw new ApproveError(409, 'Something landed after that batch was built: ask for the next one.');
    const wires = checkSigned(batch.wires, signed, wallet);
    busy = true;
    try {
      for (const [i, wire] of wires.entries()) {
        // The wire's first signature is its own: written into the file before it is sent, so one that lands
        // after its confirmation timed out (or after this process stopped) is found again before anything is
        // sent twice (`settlePending`).
        const signature = encodeBase58(readTransaction(wire).signatures[0]);
        const sent = batch.batch[i];
        await remember({ signature, steps: sent.steps.map((s) => s.id), made: madeBy(sent, batch.ctx), lastValidBlockHeight: batch.lastValidBlockHeight });
        try {
          await chain.send(wire);
        } catch (e) {
          // The node answered and refused it: it was never taken, so it can never land.
          if (e.code !== undefined || !chain.signatureStatus) await forget(signature);
          throw e;
        }
        try {
          await chain.confirm(signature, { lastValidBlockHeight: batch.lastValidBlockHeight });
        } catch (e) {
          // A confirmation can fail without the transaction failing (an RPC hiccup, a slow network): what the
          // chain says about it decides.
          const status = chain.signatureStatus ? await chain.signatureStatus(signature).catch(() => null) : null;
          if (!landedStatus(status)) {
            if (status?.err || !chain.signatureStatus) await forget(signature);
            else throw new ApproveError(503, `${e.message} It may still land: it is looked up on chain before anything is sent again, so approving again never sends it twice. Wait a minute, then ask for the next batch.`);
            throw e;
          }
        }
        signatures.push(signature);
        await landed(sent, batch.ctx, signature);
      }
    } finally {
      busy = false;
    }
    return session.state();
  }

  /** A prepared batch as the page gets it: the wires to sign, and what each does in words. */
  function answer(b) {
    return { id: b.id, project: b.ctx.project, transactions: b.wires.map(toBase64), says: b.batch.map((t) => t.steps.map((s) => s.says).join('; ')), details: b.details };
  }

  /** What a transaction's steps make, from the context it was built with: recorded when it lands. */
  function madeBy(transaction, ctx) {
    const ids = new Set(transaction.steps.map((s) => s.id));
    const mints = Object.fromEntries([...ids].filter((id) => id.startsWith('token:')).map((id) => [id.slice(6), ctx.mints[id.slice(6)]]));
    return {
      ...(ids.has('project') ? { project: ctx.project, treasury: ctx.treasury, authority: ctx.authority } : {}),
      ...(ids.has('collection') && ctx.collection ? { collection: ctx.collection } : {}),
      ...(ids.has('tree') && ctx.tree ? { tree: ctx.tree } : {}),
      ...(Object.keys(mints).length ? { mints } : {}),
    };
  }

  /**
   * Writes a transaction about to be sent into the file's live section, as not seen landing yet. The section reads as
   * a setup (or a change) under way, as it does once a step lands (`landed`).
   */
  async function remember(entry) {
    const was = spec.live ?? {};
    spec = { ...spec, live: { ...was, landed: was.landed ?? [], partial: true, ...(only ? { changing: [...only] } : {}), pending: [...(was.pending ?? []), entry].slice(-60) } };
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }

  /** Takes a transaction out of the pending list: it landed (and is recorded), failed, or can no longer land. */
  async function forget(signature) {
    if (!spec.live?.pending) return;
    const pending = spec.live.pending.filter((p) => p.signature !== signature);
    const { pending: _, ...rest } = spec.live;
    spec = { ...spec, live: pending.length ? { ...rest, pending } : rest };
    generation++;
    await write(file, `${JSON.stringify(spec, null, 2)}\n`);
  }

  /** The owner of `project` on chain, or null when it can't be read. */
  async function projectOwner(project) {
    if (!project || !chain.account) return null;
    const account = await chain.account(project).catch(() => null);
    return account && account.owner === LOOT_PROGRAM && accountKind(account.data) === 'Project' ? decode('Project', account.data).owner : null;
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
        await landed({ steps: entry.steps.map((id) => ({ id })) }, { ...(entry.made ?? {}), owner: await projectOwner(entry.made?.project ?? spec.live?.project) }, entry.signature);
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
      throw new ApproveError(409, `The transaction ${entry.signature}, sent earlier, has not landed yet and may still: wait a minute and try again, so nothing is sent twice.`);
    }
  }

  /**
   * One transaction landed: the spec's live section learns its steps, and the file is written at once. It names only
   * what those steps made (the project once `project` landed, a mint once its `token:` step did, …): an account whose
   * own transaction has not landed is made again when the setup goes on.
   */
  async function landed(transaction, ctx, signature) {
    const was = spec.live ?? {};
    const ids = transaction.steps.map((s) => s.id);
    const made = new Set(ids);
    const mints = { ...(was.mints ?? {}) };
    for (const id of ids) if (id.startsWith('token:') && ctx.mints?.[id.slice(6)]) mints[id.slice(6)] = ctx.mints[id.slice(6)];
    const progress = {
      ...was,
      program: LOOT_PROGRAM,
      ...(made.has('project') ? { project: ctx.project, treasury: ctx.treasury, authority: ctx.authority } : {}),
      ...(made.has('collection') && ctx.collection ? { collection: ctx.collection } : {}),
      ...(made.has('tree') && ctx.tree ? { tree: ctx.tree } : {}),
      mints,
      landed: [...new Set([...(was.landed ?? []), ...ids])],
      partial: true,
      ...(only ? { changing: [...only] } : {}),
      // (each signature once: one found again by `settlePending` may have been recorded already)
      transactions: (was.transactions ?? []).some((t) => t.signature === signature) ? was.transactions : [...(was.transactions ?? []), { signature }].slice(-60),
      pending: (was.pending ?? []).filter((p) => p.signature !== signature),
    };
    if (!progress.pending.length) delete progress.pending;
    if (!Object.keys(progress.mints).length) delete progress.mints;
    if (!progress.collection) delete progress.collection;
    spec = { ...spec, live: progress };
    generation++;
    const rest = plan(spec, { now: at, live: spec.live, only });
    if (rest.ok && rest.transactions.length === 0) {
      const { live: _, ...bare } = spec;
      // Everything the setup made, whichever session or transaction made it.
      const all = { ...ctx, ...Object.fromEntries(['project', 'treasury', 'authority', 'collection', 'tree'].map((k) => [k, progress[k] ?? ctx[k]])), mints: { ...(ctx.mints ?? {}), ...(progress.mints ?? {}) } };
      const final = recordLanded(bare, { ctx: all, now: at, at: new Date(clock()).toISOString() });
      final.live = { ...final.live, transactions: progress.transactions };
      spec = final;
      only = changedParts(spec).only;
    }
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
  if (given > most) throw new ApproveError(502, `The RPC says an account of ${bytes} bytes needs ${given} lamports of rent; no cluster charges more than ${most}. Nothing was sent: use another RPC (XSOLANA_RPC_URL).`);
  return given;
}

/** Whether a signature's status says it landed: confirmed or finalized, and not failed. */
const landedStatus = (status) => Boolean(status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'));

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The wallet's signed copies: each the exact prepared message, each with the wallet's valid signature. */
function checkSigned(prepared, signed, wallet) {
  if (!Array.isArray(signed) || signed.length !== prepared.length) throw new ApproveError(400, 'The wallet’s answer does not match the request.');
  return prepared.map((wire, i) => {
    let mine;
    let theirs;
    try {
      mine = readTransaction(wire);
      theirs = readTransaction(fromBase64(String(signed[i])));
    } catch {
      throw new ApproveError(400, 'The wallet returned something that is not a transaction.');
    }
    if (!equalBytes(mine.message, theirs.message)) throw new ApproveError(400, 'The wallet changed the transaction before signing it, so nothing was sent.');
    const slot = mine.signers.indexOf(wallet);
    if (slot < 0) throw new ApproveError(400, 'This transaction was not prepared for that wallet.');
    const signature = theirs.signatures[slot];
    if (!verifySignature(wallet, mine.message, signature)) throw new ApproveError(400, 'The wallet’s signature is missing or does not match your wallet.');
    const signatures = [...mine.signatures];
    signatures[slot] = signature;
    return wireTransaction(mine.message, signatures);
  });
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
  return hosts.some((h) => String(headers.origin).toLowerCase() === `http://${h}`);
}

/** A request's body, as text: refused (413) past `limit` bytes, and the rest of it read and let go. */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
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
    const href = url.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    await writeFile(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${href}"><title>xsolana approve</title><a href="${href}">Open the approval page</a>\n`, { mode: 0o600, flag: 'wx' });
    const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
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
export async function approve({ file = 'xsolana.json', port, open = true, chain = devnetChain(), log = (...a) => console.error(...a), openLink = openBrowser } = {}) {
  const session = await createApproval({ file: path.resolve(file), chain });
  const token = randomBytes(18).toString('base64url');
  let code = randomBytes(18).toString('base64url');
  // (removes the file the browser was opened with, once: `openLink` answers how)
  let removeOpener = null;
  const forget = () => { const remove = removeOpener; removeOpener = null; remove?.(); };
  const page = await readFile(path.join(ROOT, 'approve/page.html'), 'utf8');
  const policy = pagePolicy(page);
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': policy, 'x-frame-options': 'DENY' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      // Only a request to this server by its own name (DNS rebinding: a site whose name now points at 127.0.0.1).
      if (!ownRequest(req.headers, server.address().port)) return send(403, 'Open the link `xsolana approve` printed.', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/') {
        const once = url.searchParams.get('c');
        if (once !== null) {
          if (!code || !sameText(once, code)) return send(403, 'This link has been opened already: open the link `xsolana approve` printed.', 'text/plain');
          code = null;
          forget();
          res.writeHead(303, { ...headers, location: `/?t=${token}` });
          return res.end();
        }
        if (!sameText(url.searchParams.get('t') ?? '', token)) return send(403, 'Open the link `xsolana approve` printed.', 'text/plain');
        return send(200, page.replace('__TOKEN__', token), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && BROWSER_FILES.test(url.pathname)) return send(200, await readFile(path.join(ROOT, url.pathname.slice(4)), 'utf8'), 'text/javascript; charset=utf-8');
      if (!sameText(req.headers['x-xsolana-token'] ?? '', token)) return send(403, { error: 'Not this session’s page.' });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const wallet = url.searchParams.get('wallet');
        return send(200, wallet ? await session.stateFor(wallet) : session.state());
      }
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'POST' && url.pathname === '/api/prepare') return send(200, await session.prepare(String(body.wallet ?? '')));
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
  log('Leave this running until the page says it is live. Ctrl+C stops it; running it again goes on from where it stopped.');
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
