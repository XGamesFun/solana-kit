// `xsolana approve --keypair <file>`: going live signed by a key file on this machine, with no browser and no page.
// It is the same approval the page serves (`createApproval`: the same plan, the same reads of the chain, the same
// check of every signed transaction, the same record in the spec file), driven from the terminal. What the page shows
// before its Approve button is printed here first, whole: every step with what it pays and trusts, the warnings, the
// notice and the legal flags, and then nothing is sent. It is sent when the command is run again with the code the
// printout ends with (`--yes <code>`), which stands for that printout and no other: whoever runs it (a person, or an
// agent after the person's yes) sends exactly what was shown. The command never stops to ask: an agent's terminal
// would hang on a question, or answer it.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { KeyFileError, keyFilePath, readKeyFile } from './keyfile.mjs';
import { clusterChain, createApproval } from './server.mjs';
import { realMoney } from '../client/cluster.js';

/** The notice the page has its owner tick before Approve (js/approve/page.html, "Read this first"), word for word. */
export const NOTICE = [
  'The loot program has not been independently audited. It and these tools come as is, with no warranty and no guarantee that they are safe: what is sent to the program can be lost. You use them at your own risk.',
  'Transactions can’t be undone. You are responsible for every one you approve.',
  'Making sure your economy is legal everywhere it is offered is up to you. Nothing here is legal or financial advice.',
];

const LAMPORTS = 1_000_000_000n;
/** Lamports as SOL, to the lamport, with no trailing zeros. */
function sol(lamports) {
  const n = BigInt(lamports);
  const frac = String(n % LAMPORTS)
    .padStart(9, '0')
    .replace(/0+$/, '');
  return `${n / LAMPORTS}${frac ? `.${frac}` : ''}`;
}

/** SOL as the tools write it ("5.33360349", 5.3336) in lamports. */
function solToLamports(text) {
  const [whole, frac = ''] = String(text).split('.');
  return BigInt(whole || '0') * LAMPORTS + BigInt(frac.padEnd(9, '0').slice(0, 9) || '0');
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The key's own signature put into its slot of a prepared transaction, as a wallet's signTransaction does. */
function signWire(key, b64) {
  const t = readTransaction(fromBase64(b64));
  const slot = t.signers.indexOf(key.address);
  if (slot < 0) throw new Error('A transaction was prepared that this key does not sign: nothing was sent.');
  const signatures = [...t.signatures];
  signatures[slot] = key.sign(t.message);
  return toBase64(wireTransaction(t.message, signatures));
}

/**
 * A time as the steps' lines write one: to the second ("2026-11-11T08:34:11Z"), to the minute as the checker's
 * analyses and walk-through do ("2026-11-11 08:34 UTC"), or, for one years off, by the day and the years it is away
 * ("11 November 2030, 4 years from now").
 */
const WRITTEN_TIME =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b|\b\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\b|\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4,}\b|\b[\d,]+ years (?:from now|after go-live)\b/g;

/**
 * The code that stands for one printout: the whole file (the spec, and its live section with every address it gives
 * the steps: the project, the mints, the collection), the key, every step still to send with what it pays and trusts,
 * and every line the person is to read first. Anything of that changing (an edit to the file, a step landing, the
 * chain saying something new of a token) gives another code, so a yes is never carried over to something that was
 * not shown. Two things in the lines are left out, because they are new at each run and say nothing a person can
 * check: the addresses of the accounts the setup makes new, and a time counted from "publish" (the file's own words
 * for it, "publish+30d", are in the code).
 */
export function approvalCode(state, spec) {
  let shown = JSON.stringify([
    'xsolana approve',
    state.cluster,
    state.program,
    state.wallet,
    state.project,
    state.mode,
    state.steps.map(s => [s.id, s.says, s.signer, s.details ?? []]),
    state.warnings,
    state.legal.map(f => f.says),
    state.unwritten,
    state.read ?? null,
  ]);
  // (a new account's address is made anew for each printout: it is named by what it is)
  for (const f of state.fresh ?? []) shown = shown.replaceAll(f.address, `<new ${f.name}>`);
  shown = shown.replace(WRITTEN_TIME, '<a time>');
  // The file as it is, live section and all: what the steps are built from, whether or not a line names it.
  const hex = createHash('sha256').update(JSON.stringify(spec)).update('\n').update(shown).digest('hex').slice(0, 8);
  // (on mainnet the code says so: whoever types it back types "mainnet", a step beyond the file's own word)
  return state.cluster === 'mainnet' ? `mainnet-${hex}` : hex;
}

/** A new account of the setup in words: "mint/gold" is the mint of the token “gold”. */
const freshName = name =>
  /^mint[/:]/.test(name)
    ? `the mint of the token “${name.slice(5)}”`
    : name === 'collection'
      ? 'the collection'
      : name === 'tree'
        ? 'the tree of compressed NFTs'
        : name;

/** What the page shows before Approve, as lines of text. `balance`: the key's lamports, or null when not read. */
export function approvalText(state, { keyFile, balance = null }) {
  const lines = [];
  // (on mainnet, the first thing said: what is sent is real money)
  if (state.cluster === 'mainnet')
    lines.push(
      'MAINNET: everything below moves real SOL and real tokens, and cannot be undone. loot is not independently audited.',
    );
  const kind =
    state.mode === 'change'
      ? 'a change to a live economy'
      : state.mode === 'resume'
        ? 'a setup that was cut short goes on'
        : 'a new economy';
  lines.push(
    `“${state.name}” (${state.file}): ${kind}, on ${state.cluster}, on the shared loot program ${state.program}.`,
  );
  lines.push(
    `Signed by the key file ${keyFile}, whose address is ${state.wallet}. The lines below call that address “your wallet”.`,
  );
  if (state.project) lines.push(`Project: ${state.project}`);
  for (const f of state.fresh ?? [])
    lines.push(
      `New, made by this setup: ${freshName(f.name)}, at ${f.address} (a new address each time this is shown).`,
    );
  const about = state.setupSol !== null && state.mode === 'new' ? ` Going live takes about ${state.setupSol} SOL.` : '';
  if (balance !== null) lines.push(`The key holds ${sol(balance)} SOL.${about}`);
  else if (about) lines.push(about.trim());

  lines.push('', 'Read this first');
  for (const line of [...NOTICE, ...state.legal.map(f => f.says)]) lines.push(`- ${line}`);
  lines.push(
    `The full text is in DISCLAIMER.md, in the package. ${realMoney() ? 'This is mainnet: everything sent here is real money, and every point above is yours to have answered first.' : 'Devnet is not real money; real money needs every point above answered first.'}`,
  );

  if (state.warnings.length) {
    lines.push('', 'Before you approve');
    for (const w of state.warnings) lines.push(`- ${w}`);
  }
  if (state.landed.length) {
    lines.push('', 'Landed already');
    for (const l of state.landed) lines.push(`- ${l.says}`);
  }
  lines.push('', `To send: ${count(state.steps.length, 'step')} in ${count(state.remaining, 'transaction')}`);
  state.steps.forEach((s, i) => {
    const who = s.signer === 'authority' ? ` (the authority signs: ${state.authority})` : '';
    lines.push(`${i + 1}. ${s.says}${who}`);
    for (const d of s.details ?? []) lines.push(`   - ${d}`);
  });
  return lines;
}

/**
 * Puts the economy in `file` live with the key in `keyFile`, or goes on with a setup that was cut short, or sends a
 * live economy's change. `yes`: null shows what would be sent and sends nothing (or asks `confirm`, when a caller
 * that has the person in front of it gives one; the command line never does); a code sends when it is the code of
 * what is shown now, and is refused otherwise; true sends without asking (for a script that has shown it its own
 * way). `out(line)` prints. Returns { ok, sent, done, code }:
 * `ok` false when something was refused or failed, `sent` how many transactions landed, `done` whether the file is
 * recorded as live.
 */
export async function approveWithKey({
  file = 'xsolana.json',
  keyFile,
  yes = null,
  confirm = null,
  chain = clusterChain(),
  out = line => console.log(line),
  now,
  keyReader = readKeyFile,
  approval = createApproval,
  mintKeyFiles = {},
}) {
  const key = await keyReader(keyFile);
  // A key file the owner supplies for a token's new mint (`--mint-key <token key>=<file>`): read as the owner's own
  // is (its user alone, outside any repository, a whole key), never printed, and dropped with it.
  const mintKeys = new Map();
  const dropAll = () => {
    for (const k of mintKeys.values()) k.drop();
    key.drop();
  };
  let session;
  try {
    // (a Map, or an object's own names: a name like "__proto__" is a name here and nothing else)
    for (const [token, given] of mintKeyFiles instanceof Map ? mintKeyFiles : Object.entries(mintKeyFiles ?? {})) {
      if (!existsSync(keyFilePath(given)))
        throw new KeyFileError(`--mint-key ${token}: ${keyFilePath(given)} does not exist.`);
      try {
        mintKeys.set(token, await keyReader(given));
      } catch (e) {
        if (!(e instanceof KeyFileError)) throw e;
        throw new KeyFileError(`--mint-key ${token}: ${e.message}`);
      }
    }
    session = await approval({
      file: path.resolve(file),
      chain,
      ...(now ? { now } : {}),
      ...(mintKeys.size ? { mintKeys } : {}),
    });
  } catch (e) {
    dropAll();
    throw e;
  }
  // How many transactions this run saw land (its own, and any an earlier run sent that it found landed).
  const landed = () => session.state().signatures.length;
  const live = () => !session.spec.live?.partial && Boolean(session.spec.live);
  try {
    let state = await session.stateFor(key.address);
    if (state.refused) {
      out(`Nothing can be sent: ${state.refused}`);
      // (a key that is not the project's: said plainly, so nobody makes a new key or cuts the file to get past it)
      if (state.notOwner)
        out(
          `This key file’s address is ${key.address}: it is not the project’s key. If the project is yours, find the key it went live with (or the key it was handed to since): don’t make a new one, and don’t change ${state.file} to get past this.`,
        );
      return { ok: false, sent: 0, done: false, code: null };
    }
    if (!state.remaining) {
      for (const line of state.unwritten ?? []) out(line);
      // (what the chain says of the project's treasury and authority where the file or the spec said otherwise)
      for (const line of state.chainSays ?? []) out(line);
      if (!state.done) {
        for (const w of state.warnings) out(w);
        out(`Nothing can be sent for ${state.file} as it is.`);
        return { ok: false, sent: 0, done: false, code: null };
      }
      out(
        state.unwritten?.length
          ? `Nothing to send for “${state.name}”: the file is as it was.`
          : `Nothing to send: “${state.name}” is live on ${state.cluster} as ${state.file} says.`,
      );
      return { ok: true, sent: 0, done: true, code: null };
    }

    const balance = chain.account
      ? await chain.account(key.address).then(
          a => BigInt(a?.lamports ?? 0),
          () => null,
        )
      : null;
    const code = approvalCode(state, session.spec);
    for (const line of approvalText(state, { keyFile: key.file, balance })) out(line);
    out('');
    if (balance === 0n) {
      out(
        realMoney()
          ? `Nothing was sent: the key holds no SOL. This economy is on mainnet: send SOL to ${key.address} first, then run this again.`
          : `Nothing was sent: the key holds no SOL. Send devnet SOL to ${key.address} first (https://faucet.solana.com gives some), then run this again.`,
      );
      return { ok: false, sent: 0, done: false, code };
    }
    // A new setup the key can't pay for would stop part way: it is not started.
    const needs = state.mode === 'new' && state.setupSol !== null ? solToLamports(state.setupSol) : null;
    if (balance !== null && needs !== null && balance < needs) {
      out(
        `Nothing was sent: the key holds ${sol(balance)} SOL, less than the about ${state.setupSol} SOL going live takes. Send ${key.address} at least ${sol(needs - balance)} SOL more, then run this again.`,
      );
      return { ok: false, sent: 0, done: false, code };
    }
    if (yes === null && confirm) {
      const said = await confirm(
        `${state.cluster === 'mainnet' ? 'This is MAINNET: real SOL and real tokens. ' : ''}Send ${count(state.remaining, 'transaction')} from ${key.address}? Type yes to send: `,
      );
      if (!said) {
        out('Nothing was sent.');
        return { ok: true, sent: 0, done: false, code };
      }
    } else if (yes === null) {
      out(
        `Nothing was sent. This is what going on would send: show it to the person whose economy it is, and when they say yes, run the same command with --yes ${code}`,
      );
      return { ok: true, sent: 0, done: false, code };
    } else if (yes !== true && String(yes) !== code) {
      out(
        `Nothing was sent: ${JSON.stringify(String(yes))} is not the code of what is above (the file, the chain or what is left to send has changed since that code was given, or it was mistyped). Read the above again; its code is ${code}.`,
      );
      return { ok: false, sent: 0, done: false, code };
    }

    // Only what was shown is sent. Each batch is held against the printout before the key signs it: every step it
    // carries was on the printout, in the same words. After each batch, a step that was not on the printout, or a
    // line about a token the chain did not say then, stops it for another read.
    const shown = new Map(state.steps.map(s => [s.id, s.says]));
    const readShown = state.read ?? null;
    const changed = () => {
      const sent = landed();
      out(
        `${sent ? `Stopped after ${count(sent, 'transaction')}` : 'Nothing was sent'}: what is left to send is not what was shown above. Run the command again to read what is left, and go on from there.`,
      );
      return { ok: false, sent, done: false, code };
    };
    for (let turn = 0; state.remaining && turn < 500; turn++) {
      let batch;
      try {
        batch = await session.prepare(key.address, state.read ?? null);
      } catch (e) {
        if (e.status === 403)
          e.message += ' With key files: run this command again with that address’s key file (--keypair).';
        throw e;
      }
      if (!batch.steps?.length || batch.steps.flat().some(step => shown.get(step.id) !== step.says)) return changed();
      for (const says of batch.says) out(`Sending: ${says}`);
      await session.complete(
        key.address,
        batch.id,
        batch.transactions.map(b64 => signWire(key, b64)),
      );
      state = await session.stateFor(key.address);
      if (state.refused) throw new Error(state.refused);
      if (state.steps.some(s => !shown.has(s.id)) || (state.remaining && (state.read ?? null) !== readShown))
        return changed();
    }
    for (const line of state.unwritten ?? []) out(line);
    const sent = landed();
    out(
      live()
        ? `Live on ${state.cluster}: ${count(sent, 'transaction')} landed, and ${state.file} now holds the project’s addresses (project ${session.spec.live.project}).`
        : `${count(sent, 'transaction')} landed, and ${state.file} is not recorded as live yet: run the command again.`,
    );
    return { ok: live(), sent, done: live(), code };
  } catch (e) {
    const sent = landed();
    // A transaction that was sent and is not known to have landed is still looked for: it is not "nothing sent".
    const unknown = session.spec.live?.pending?.length ?? 0;
    const so = [
      sent ? `Stopped after ${count(sent, 'transaction')} landed` : unknown ? 'Stopped' : 'Nothing was sent',
      unknown
        ? ` (${count(unknown, 'more was', 'more were')} sent and ${unknown === 1 ? 'is' : 'are'} not known to have landed yet)`
        : '',
    ].join('');
    out(
      `${so}: ${e.message}${sent || unknown ? ` What is known is recorded in ${path.basename(file)}: run the command again to go on from where it stopped; a transaction still looked for is found first, so nothing is sent twice.` : ''}`,
    );
    return { ok: false, sent, done: false, code: null };
  } finally {
    session.close();
    dropAll();
  }
}
