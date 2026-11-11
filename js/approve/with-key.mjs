// `xsolana approve --keypair <file>`: going live signed by a key file on this machine, with no browser and no page.
// It is the same approval the page serves (`createApproval`: the same plan, the same reads of the chain, the same
// check of every signed transaction, the same record in the spec file), driven from the terminal. What the page shows
// before its Approve button is printed here first, whole: every step with what it pays and trusts, the warnings, the
// notice and the legal flags. Nothing is signed until the person has said yes to exactly that: on a terminal by typing
// yes, otherwise by giving back the code the printout ends with (`--yes <code>`), which stands for that printout and
// no other.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { readKeyFile } from './keyfile.mjs';
import { createApproval, devnetChain } from './server.mjs';

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
 * The code that stands for one printout: the spec, the key, the project, every step still to send and every line the
 * person is to read first. Anything of that changing (an edit to the file, a step landing, the chain saying something
 * new of a token) gives another code, so a yes is never carried over to something that was not shown. The addresses
 * of the accounts the setup makes new are left out: they are new each time, and say nothing a person can check.
 */
export function approvalCode(state, spec) {
  const { live: _, ...bare } = spec;
  let text = JSON.stringify([
    'xsolana approve',
    state.cluster,
    state.program,
    state.wallet,
    state.project,
    state.mode,
    bare,
    state.steps.map(s => [s.id, s.says, s.signer]),
    state.warnings,
    state.legal.map(f => f.says),
    state.unwritten,
    state.read ?? null,
  ]);
  // (a new account's address is made anew for each printout: it is named by what it is)
  for (const f of state.fresh ?? []) text = text.replaceAll(f.address, `<new ${f.name}>`);
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** A new account of the setup in words: "mint:gold" is the mint of the token “gold”. */
const freshName = name =>
  name.startsWith('mint:')
    ? `the mint of the token “${name.slice(5)}”`
    : name === 'collection'
      ? 'the collection'
      : name === 'tree'
        ? 'the tree of compressed NFTs'
        : name;

/** What the page shows before Approve, as lines of text. `balance`: the key's lamports, or null when not read. */
export function approvalText(state, { keyFile, balance = null }) {
  const lines = [];
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
    'The full text is in DISCLAIMER.md, in the package. Devnet is not real money; real money needs every point above answered first.',
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
 * live economy's change. `yes`: null shows what would be sent and sends nothing (or asks `confirm`, when given: a
 * terminal's "type yes"); a code sends when it is the code of what is shown now, and is refused otherwise; true sends
 * without asking (for a script that has shown it its own way). `out(line)` prints. Returns { ok, sent, done, code }:
 * `ok` false when something was refused or failed, `sent` how many transactions landed, `done` whether the file is
 * recorded as live.
 */
export async function approveWithKey({
  file = 'xsolana.json',
  keyFile,
  yes = null,
  confirm = null,
  chain = devnetChain(),
  out = line => console.log(line),
  now,
  keyReader = readKeyFile,
}) {
  const key = await keyReader(keyFile);
  const session = await createApproval({ file: path.resolve(file), chain, ...(now ? { now } : {}) });
  // How many transactions this run saw land (its own, and any an earlier run sent that it found landed).
  const landed = () => session.state().signatures.length;
  const live = () => !session.spec.live?.partial && Boolean(session.spec.live);
  try {
    let state = await session.stateFor(key.address);
    if (state.refused) {
      out(`Nothing can be sent: ${state.refused}`);
      return { ok: false, sent: 0, done: false, code: null };
    }
    if (!state.remaining) {
      for (const line of state.unwritten ?? []) out(line);
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
        `Nothing was sent: the key holds no SOL. Send devnet SOL to ${key.address} first (https://faucet.solana.com gives some), then run this again.`,
      );
      return { ok: false, sent: 0, done: false, code };
    }
    if (yes === null && confirm) {
      const said = await confirm(
        `Send ${count(state.remaining, 'transaction')} from ${key.address}? Type yes to send: `,
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

    // Only what was shown is sent: a step that was not on the printout, or a line about a token the chain did not
    // say then, stops it for another read.
    const shown = new Set(state.steps.map(s => s.id));
    const readShown = state.read ?? null;
    for (let turn = 0; state.remaining && turn < 500; turn++) {
      let batch;
      try {
        batch = await session.prepare(key.address, state.read ?? null);
      } catch (e) {
        if (e.status === 403)
          e.message += ' With key files: run this command again with that address’s key file (--keypair).';
        throw e;
      }
      for (const says of batch.says) out(`Sending: ${says}`);
      await session.complete(
        key.address,
        batch.id,
        batch.transactions.map(b64 => signWire(key, b64)),
      );
      state = await session.stateFor(key.address);
      if (state.refused) throw new Error(state.refused);
      if (state.steps.some(s => !shown.has(s.id)) || (state.remaining && (state.read ?? null) !== readShown)) {
        out(
          `Stopped after ${count(landed(), 'transaction')}: what is left to send is not what was shown above. Nothing more was sent. Run the command again to read what is left, and go on from there.`,
        );
        return { ok: false, sent: landed(), done: false, code };
      }
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
    out(
      `${sent ? `Stopped after ${count(sent, 'transaction')}` : 'Nothing was sent'}: ${e.message}${sent ? ` What landed is recorded in ${path.basename(file)}: run the command again to go on from where it stopped.` : ''}`,
    );
    return { ok: false, sent, done: false, code: null };
  } finally {
    session.close();
    key.drop();
  }
}
