// What a wallet may add to a transaction it was asked to sign as it stood, and nothing else.
//
// The approval page prepares each transaction, shows what it does, and sends what the wallet signed. Some wallets add
// to a transaction before they sign it: Phantom adds its own checks (instructions of the Lighthouse program, which
// read accounts and fail the transaction when something is not as the wallet expected). The page takes such a
// transaction only when everything that was prepared and shown is still in it, untouched, and everything else is of
// the two programs a wallet adds for its own sake: Compute Budget and Lighthouse. Then what is sent is the wallet's
// own message with the wallet's own signature. Anything else is refused, as any change was before.
//
// The rule, each part of which is needed:
// - Both messages are legacy, with no lookup table: every account is in the message itself, so every account is
//   compared by its address.
// - The wallet is the message's one signer and its fee payer, in both. A transaction a fresh key signs too (a new
//   mint, a new collection) can't be changed: that key signed the prepared message.
// - The same blockhash.
// - Every prepared instruction is there, in the prepared order, with the same program, the same accounts and the
//   same data.
// - Every account a prepared instruction names (its program too) is a signer or writable in the wallet's message
//   exactly as it was in the prepared one. Whether an account can be written is the message's word, not one
//   instruction's: an added instruction that asks to write an account of ours would make it writable for ours too.
// - Every other instruction is the Lighthouse program's, or a Compute Budget instruction of a kind the prepared
//   transaction does not set itself (the network refuses a transaction that sets its unit limit or price twice).
import { equalBytes } from '../chain/bytes.js';
import { COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM } from '../chain/pda.js';
import { readMessage } from '../chain/tx.js';

/** What a Compute Budget instruction asks for, by its first byte. */
const BUDGET_ASKS = {
  1: 'a heap size',
  2: 'a compute unit limit',
  3: 'a compute unit price (a priority fee of its own)',
  4: 'a limit on the account data loaded',
};

/** A refusal of a wallet's message: `why`, in words that go after "it …". */
class Refused extends Error {}

/**
 * A legacy message's accounts and instructions with nothing left as a number:
 * { blockhash, signers, flags (address → { signer, writable }), instructions: [{ program, accounts: [address], data }] }.
 * Throws `Refused` for a message that is not legacy, that names an account twice, or whose own numbers do not add up.
 */
function laidOut(message) {
  let m;
  try {
    m = readMessage(message);
  } catch {
    throw new Refused('returned something that is not a transaction');
  }
  if (m.version !== 'legacy' || m.lookups.length)
    throw new Refused('returned a transaction that loads accounts from a lookup table, which can’t be compared');
  const { numRequiredSignatures: signed, numReadonlySigned, numReadonlyUnsigned } = m.header;
  const count = m.keys.length;
  if (signed < 1 || signed > count || numReadonlySigned >= signed || numReadonlyUnsigned > count - signed)
    throw new Refused('returned a transaction whose header does not add up');
  if (new Set(m.keys).size !== count) throw new Refused('returned a transaction that names an account twice');
  const flags = new Map(
    m.keys.map((address, i) => [
      address,
      {
        signer: i < signed,
        writable: i < signed - numReadonlySigned || (i >= signed && i < count - numReadonlyUnsigned),
      },
    ]),
  );
  const at = i => {
    if (i >= count) throw new Refused('returned a transaction that names an account it does not list');
    return m.keys[i];
  };
  return {
    blockhash: m.blockhash,
    signers: m.keys.slice(0, signed),
    flags,
    instructions: m.instructions.map(ix => ({
      program: at(ix.programIndex),
      accounts: ix.accountIndexes.map(at),
      data: ix.data,
    })),
  };
}

const sameInstruction = (a, b) =>
  a.program === b.program &&
  a.accounts.length === b.accounts.length &&
  a.accounts.every((address, i) => address === b.accounts[i]) &&
  equalBytes(a.data, b.data);

/**
 * Whether `theirs`, the message a wallet signed, is `ours`, the message prepared for it, with nothing but a wallet's
 * own additions. `wallet`: the address the transaction was prepared for.
 * → { ok: true, added: [what it added, in words] } or { ok: false, why: what it did, in words after "it …" }.
 * Two messages that are the same bytes are not this function's to judge (nothing was added).
 */
export function walletAdded(ours, theirs, wallet) {
  try {
    // (the prepared message is this package's own: one this can't lay out is one a wallet may not change)
    let a;
    try {
      a = laidOut(ours);
    } catch {
      throw new Refused('changed a transaction that can only be sent as it was prepared');
    }
    const b = laidOut(theirs);
    if (a.signers.length !== 1 || a.signers[0] !== wallet)
      throw new Refused(
        'changed a transaction that another key signs too (a new account’s own key signed it as it was prepared)',
      );
    if (b.signers.length !== 1) throw new Refused('added a signer');
    if (b.signers[0] !== wallet) throw new Refused('put another fee payer on it');
    if (a.blockhash !== b.blockhash) throw new Refused('put another blockhash on it');

    // Every prepared instruction, in its order; whatever stands between them is what the wallet added.
    const added = [];
    let next = 0;
    for (const ix of b.instructions) {
      if (next < a.instructions.length && sameInstruction(ix, a.instructions[next])) next++;
      else added.push(ix);
    }
    if (next !== a.instructions.length) throw new Refused('changed, dropped or moved one of the prepared instructions');
    if (!added.length) throw new Refused('changed the transaction’s accounts');

    // No account of ours is more, or less, than it was: a signer, or writable.
    const mine = new Set(a.instructions.flatMap(ix => [ix.program, ...ix.accounts]));
    for (const address of mine) {
      const was = a.flags.get(address);
      const is = b.flags.get(address);
      if (!is || was.signer !== is.signer || was.writable !== is.writable)
        throw new Refused(
          `changed what the account ${address} is in the transaction (${was.writable ? 'it could be written, and no longer can' : 'it could only be read, and can now be written'})`,
        );
    }

    // What it added is a wallet's own: Lighthouse's checks, or a compute budget the transaction did not set.
    const budget = list =>
      list.filter(ix => ix.program === COMPUTE_BUDGET_PROGRAM).map(ix => (ix.data.length ? ix.data[0] : -1));
    const set = new Set(budget(a.instructions));
    const words = [];
    let checks = 0;
    for (const ix of added) {
      if (ix.program === LIGHTHOUSE_PROGRAM) {
        checks++;
        continue;
      }
      if (ix.program !== COMPUTE_BUDGET_PROGRAM) throw new Refused(`added an instruction of the program ${ix.program}`);
      const kind = ix.data.length ? ix.data[0] : -1;
      const what = BUDGET_ASKS[kind];
      if (!what) throw new Refused('added a compute budget instruction of a kind not known here');
      if (set.has(kind))
        throw new Refused(
          `added ${what.replace(/^a /, 'a second ')}: the transaction sets its own, and the network refuses one that sets it twice`,
        );
      set.add(kind);
      words.push(what);
    }
    if (checks) words.push(`${checks} check${checks === 1 ? '' : 's'} of its own (the Lighthouse program’s)`);
    return { ok: true, added: words };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return { ok: false, why: e.message };
  }
}
