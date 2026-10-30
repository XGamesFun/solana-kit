// Address lookup tables, and sending a transaction whatever its size. A legacy transaction holds at most 1,232 bytes,
// about 35 accounts with room for their instructions; loot's program accepts more (a settle can lock up to 64 accounts).
// A v0 transaction names each account it loads from a lookup table with one byte instead of 32. `sendFitting` sends
// legacy when it fits; otherwise the payer makes a table of the transaction's accounts first (its own transactions,
// each legacy), waits one slot for it to be usable, and sends the transaction as v0 with the table, deactivating the
// table in that same transaction (a compressed NFT's prove_leaf goes alone, after the table, only when even that
// doesn't fit: `sendPlan`). Once its deactivation slot has left the recent slot hashes (about 513 slots: on devnet about two minutes)
// the table can be closed and its rent goes back to the payer (`closeTableIx`; `tableStep` says when).
import { addressBytes, encodeBase58 } from './base58.js';
import { concat, readUintLE, uintLE } from './bytes.js';
import { COMPUTE_BUDGET_PROGRAM, findProgramAddress, SYSTEM_PROGRAM, SYSVAR_SLOT_HASHES } from './pda.js';
import { compileMessage, MAX_TRANSACTION_BYTES, transactionSize } from './tx.js';

export const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
/** A table's account: 56 bytes of header, then its addresses, 32 bytes each (at most 256). */
export const TABLE_HEADER_BYTES = 56;
export const TABLE_MAX_ADDRESSES = 256;
/** The accounts a transaction may lock. */
export const MAX_ACCOUNT_LOCKS = 64;
/** A deactivated table can be closed once its deactivation slot has left the 512 recent slot hashes. */
export const TABLE_COOLDOWN_SLOTS = 513n;
/** The deactivation slot of a table still active. */
const ACTIVE = 2n ** 64n - 1n;

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const ix = (keys, data) => ({ programId: LOOKUP_TABLE_PROGRAM, keys, data });

/** The table `authority` makes at `slot` (a recent slot: the table's address names it): [address, bump]. */
export const tableAddress = (authority, slot) => findProgramAddress([addressBytes(authority), uintLE(slot, 8)], LOOKUP_TABLE_PROGRAM);

/** Makes the table `authority` owns at `slot`, its rent paid by `payer`. Returns { address, instruction }. */
export function createTableIx({ authority, payer = authority, slot }) {
  const [address, bump] = tableAddress(authority, slot);
  const instruction = ix([meta(address, false, true), meta(authority, true, false), meta(payer, true, true), meta(SYSTEM_PROGRAM, false, false)], concat(uintLE(0, 4), uintLE(slot, 8), Uint8Array.of(bump)));
  return { address, instruction };
}

/** Adds `addresses` to `table`, the rent of its growth paid by `payer`. */
export const extendTableIx = ({ table, authority, payer = authority, addresses }) =>
  ix([meta(table, false, true), meta(authority, true, false), meta(payer, true, true), meta(SYSTEM_PROGRAM, false, false)], concat(uintLE(2, 4), uintLE(addresses.length, 8), ...addresses.map(addressBytes)));

/** Freezes `table`: nobody can add to it or close it after. */
export const freezeTableIx = ({ table, authority }) => ix([meta(table, false, true), meta(authority, true, false)], uintLE(1, 4));

/** Deactivates `table`: transactions can still use it until it cools down, then it can be closed. */
export const deactivateTableIx = ({ table, authority }) => ix([meta(table, false, true), meta(authority, true, false)], uintLE(3, 4));

/** Closes a cooled-down `table`: its rent goes to `recipient`. */
export const closeTableIx = ({ table, authority, recipient = authority }) => ix([meta(table, false, true), meta(authority, true, false), meta(recipient, false, true)], uintLE(4, 4));

/**
 * A table's account read back: { authority (null once frozen), deactivationSlot (null while active),
 * lastExtendedSlot, addresses }, or null when `account` is not a lookup table.
 */
export function readTable(account) {
  if (!account || account.owner !== LOOKUP_TABLE_PROGRAM || account.data.length < TABLE_HEADER_BYTES || readUintLE(account.data, 0, 4) !== 1n) return null;
  const data = account.data;
  const deactivation = readUintLE(data, 4, 8);
  const addresses = [];
  for (let at = TABLE_HEADER_BYTES; at + 32 <= data.length; at += 32) addresses.push(encodeBase58(data.subarray(at, at + 32)));
  return {
    authority: data[21] === 1 ? encodeBase58(data.subarray(22, 54)) : null,
    deactivationSlot: deactivation === ACTIVE ? null : deactivation,
    lastExtendedSlot: readUintLE(data, 12, 8),
    addresses,
  };
}

/** The filter that finds the tables `authority` owns (getProgramAccounts on LOOKUP_TABLE_PROGRAM). */
export const tablesOf = (authority) => [{ memcmp: { offset: 22, bytes: authority } }];

/**
 * The slots the SlotHashes sysvar holds (its account's data: a count, then a slot and a hash each), newest first. It
 * holds the last 512 slots that had a block: a table is made at one of them, and closes only once its deactivation
 * slot has left them.
 */
export function slotHashes(data) {
  if (!data || data.length < 8) return [];
  const n = Number(readUintLE(data, 0, 8));
  const out = [];
  for (let i = 0; i < n && 8 + 40 * (i + 1) <= data.length; i++) out.push(readUintLE(data, 8 + 40 * i, 8));
  return out;
}

/** How many slots the SlotHashes sysvar holds when full. */
export const SLOT_HASHES_HELD = 512;

/**
 * What is due for a table of yours at `slot`: 'close' (deactivated, and its deactivation slot has left `recent`, the
 * slots SlotHashes holds: its rent comes back), 'cooling' (deactivated, not yet closable), or 'active'. A table is
 * closable only when `recent` is a full read (512 slots) and its deactivation slot is older than all of them: an empty
 * or short read (an RPC that answered nothing, a young chain) says cooling. Without `recent`, a table is counted
 * closable 513 slots after its deactivation, which skipped slots can make too early.
 */
export function tableStep(table, slot, recent = null) {
  if (table.deactivationSlot === null) return 'active';
  if (BigInt(slot) <= table.deactivationSlot) return 'cooling';
  if (recent) return recent.length >= SLOT_HASHES_HELD && recent.every((s) => s > table.deactivationSlot) ? 'close' : 'cooling';
  return BigInt(slot) > table.deactivationSlot + TABLE_COOLDOWN_SLOTS ? 'close' : 'cooling';
}

/**
 * How many accounts a transaction of `instructions` from `payer` locks: every account once, its programs included. As
 * v0 with a lookup table it deactivates (`planTable`), the table and the lookup-table program are two more
 * (`asV0`).
 */
export function transactionLocks(payer, instructions, { asV0 = false } = {}) {
  return new Set([payer, ...instructions.flatMap((i) => [i.programId, ...i.keys.map((k) => k.pubkey)])]).size + (asV0 ? 2 : 0);
}

/** The accounts of `instructions` a table can hold: every one that is neither a signer nor a program they call, once. */
export function tableAccounts(instructions) {
  const signers = new Set(instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
  const programs = new Set(instructions.map((i) => i.programId));
  return [...new Set(instructions.flatMap((i) => i.keys.map((k) => k.pubkey)))].filter((a) => !signers.has(a) && !programs.has(a));
}

const sizeOf = (input) => {
  try {
    return transactionSize(compileMessage(input));
  } catch {
    return Infinity;
  }
};

/**
 * The message for `instructions` from `payer`: legacy when it fits, else v0 loading what it can from `tables`
 * ([{ address, addresses }]). null when neither fits.
 */
export function compileFitting({ payer, blockhash, instructions, tables = [] }) {
  const legacy = { payer, blockhash, instructions };
  if (sizeOf(legacy) <= MAX_TRANSACTION_BYTES) return compileMessage(legacy);
  const v0 = { ...legacy, version: 0, lookupTables: tables };
  return tables.length && sizeOf(v0) <= MAX_TRANSACTION_BYTES ? compileMessage(v0) : null;
}

/**
 * The plan for sending `instructions` from `payer` as v0 with a table of their accounts made at `slot`, `first` the
 * addresses it holds first:
 * { table: { address, addresses }, steps: [instructions…] (each a legacy transaction: the table's creation and as
 * many additions as it takes), final: the instructions with the table's deactivation after them }. null when even that
 * does not fit (more accounts than a transaction can lock, or instructions too long).
 */
export function planTable({ payer, blockhash, slot, instructions, first = [] }) {
  const { address, instruction: create } = createTableIx({ authority: payer, slot });
  // `first` (js/play: the project's address) goes in the table's creation step, so a table whose later steps were
  // never sent still shows whose it is.
  const addresses = [...new Set([...first, ...tableAccounts(instructions)])];
  if (addresses.length > TABLE_MAX_ADDRESSES) return null;
  const table = { address, addresses };
  const final = [...instructions, deactivateTableIx({ table: address, authority: payer })];
  // A transaction locks at most 64 accounts, its programs and those it loads from a table included.
  if (transactionLocks(payer, final) > MAX_ACCOUNT_LOCKS) return null;
  if (sizeOf({ payer, blockhash, instructions: final, version: 0, lookupTables: [table] }) > MAX_TRANSACTION_BYTES) return null;
  const steps = [];
  let step = [create];
  let left = addresses;
  while (left.length) {
    // As many addresses as fit this step's transaction.
    let n = left.length;
    while (n > 0 && sizeOf({ payer, blockhash, instructions: [...step, extendTableIx({ table: address, authority: payer, addresses: left.slice(0, n) })] }) > MAX_TRANSACTION_BYTES) n--;
    if (n === 0) {
      // Not one address fits beside the table's creation: the creation goes alone. Not one fits a transaction of its
      // own: no table can be made for this payer.
      if (!step.length) return null;
      steps.push(step);
      step = [];
      continue;
    }
    steps.push([...step, extendTableIx({ table: address, authority: payer, addresses: left.slice(0, n) })]);
    left = left.slice(n);
    step = [];
  }
  return { table, steps, final };
}

/**
 * How `instructions` from `payer` can be sent, decided before anyone signs:
 *   { legacy: true }                              they fit a legacy transaction;
 *   { table: true, first: [] }                    they fit one v0 transaction with a lookup table of their accounts,
 *                                                 a compressed NFT's prove_leaf included (one transaction: nobody can
 *                                                 prove its leaf again between the proof and the move);
 *   { first, rest, table }                        only when they don't: `first`, the instructions `alone` picks (each
 *                                                 compressed NFT's prove_leaf), each sent alone with the transaction's
 *                                                 compute-budget instructions, after the table is made (`table`: the
 *                                                 rest goes as v0 with one) or before a legacy rest.
 * null when nothing fits: more accounts than a transaction locks, or instructions too long even as v0.
 */
export function sendPlan({ payer, blockhash = SYSTEM_PROGRAM, instructions, alone = () => false }) {
  if (compileFitting({ payer, blockhash, instructions })) return { legacy: true, first: [], budget: [], rest: instructions, table: false };
  if (planTable({ payer, blockhash, slot: 0n, instructions })) return { legacy: false, first: [], budget: [], rest: instructions, table: true };
  const budget = instructions.filter((i) => i.programId === COMPUTE_BUDGET_PROGRAM);
  const first = instructions.filter((i) => alone(i));
  const rest = instructions.filter((i) => !alone(i));
  if (!first.length || first.some((i) => !compileFitting({ payer, blockhash, instructions: [...budget, i] }))) return null;
  if (compileFitting({ payer, blockhash, instructions: rest })) return { legacy: false, first, budget, rest, table: false };
  return planTable({ payer, blockhash, slot: 0n, instructions: rest }) ? { legacy: false, first, budget, rest, table: true } : null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** The tables this page made, by address: two sends never name the same one, even in one slot. */
const madeHere = new Set();

/**
 * A recent slot to make `payer`'s next table at: the newest of the finalized SlotHashes (the program takes only a slot
 * they hold) whose table this page hasn't made and that isn't on the chain.
 */
async function freshSlot(rpc, payer) {
  const recent = slotHashes((await rpc.account(SYSVAR_SLOT_HASHES, 'finalized'))?.data);
  for (const slot of recent) {
    const [address] = tableAddress(payer, slot);
    if (madeHere.has(address) || (await rpc.account(address))) continue;
    madeHere.add(address);
    return slot;
  }
  throw new Error('The network named no recent slot to make a lookup table at: try again in a moment.');
}

/**
 * Sends `instructions` paid by `payer` (the only signer of a table's own transactions) and confirms it, as `sendPlan`
 * decides before anything is signed: legacy when it fits; else one v0 transaction with a lookup table `payer` makes
 * first (`planTable`); else the table first, then each compressed NFT's prove_leaf alone, then the rest as v0 (or the
 * proofs then a legacy rest, when that fits with no table). The v0 transaction is compiled against the table as the
 * chain holds it. `sign(message)` → the signed wire transaction. `rpc`: the client's (latestBlockhash, send, confirm,
 * account, call('getSlot')). `table: false` sends no lookup table (a throwaway key holds no rent for one); `first`:
 * addresses a table holds first (`planTable`). Throws a
 * plain sentence when it can't be sent. Returns { signature (the last transaction's), table (its address, or null),
 * steps (the signatures of the transactions before it) }.
 */
export async function sendFitting({ rpc, payer, instructions, sign, table = true, alone = () => false, first = [], sleep = pause }) {
  const sendOne = async (build) => {
    const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
    const message = build(blockhash);
    const signature = await rpc.send(await sign(message));
    await rpc.confirm?.(signature, { lastValidBlockHeight });
    return signature;
  };
  const plain = (list) => sendOne((bh) => compileMessage({ payer, blockhash: bh, instructions: list }));
  const { blockhash } = await rpc.latestBlockhash();
  const plan = sendPlan({ payer, blockhash, instructions, alone });
  if (!plan) throw new Error(`This transaction is too large to send even as a v0 one with a lookup table: it names ${tableAccounts(instructions).length + 1} accounts or more (a transaction locks at most 64), or its instructions are too long.`);
  if (plan.legacy) return { signature: await plain(instructions), table: null, steps: [] };
  if (plan.table && !table) throw new Error(`This transaction takes ${sizeOf({ payer, blockhash, instructions })} bytes, more than the ${MAX_TRANSACTION_BYTES} a legacy one holds, and this key holds no rent for a lookup table.`);
  const steps = [];
  const proofs = async () => {
    for (const ix of plan.first) steps.push(await plain([...plan.budget, ix]));
  };
  if (!plan.table) {
    await proofs();
    return { signature: await plain(plan.rest), table: null, steps };
  }
  const made = planTable({ payer, blockhash, slot: await freshSlot(rpc, payer), instructions: plan.rest, first });
  if (!made) throw new Error('This transaction is too large to send even as a v0 one with a lookup table.');
  for (const step of made.steps) steps.push(await plain(step));
  // A table's new addresses are usable from the slot after the one that added them; the transaction names them by
  // where the chain holds them.
  let held = null;
  let usable = false;
  for (let i = 0; i < 40 && !usable; i++) {
    held = readTable(await rpc.account(made.table.address));
    usable = Boolean(held && made.table.addresses.every((a) => held.addresses.includes(a)) && BigInt(await rpc.call('getSlot', [{ commitment: 'confirmed' }])) > held.lastExtendedSlot);
    if (!usable) await sleep(400);
  }
  if (!held || !made.table.addresses.every((a) => held.addresses.includes(a))) throw new Error(`The lookup table ${made.table.address} doesn't hold this transaction's accounts yet: try again in a moment.`);
  // Sent before the slot passes the table's last addition, the transaction would be refused for addresses it can't load.
  if (!usable) throw new Error(`The lookup table ${made.table.address} is made, but the network has not moved past the slot it was last added to: try again in a moment.`);
  await proofs();
  const tables = [{ address: made.table.address, addresses: held.addresses }];
  const message = compileFitting({ payer, blockhash, instructions: made.final, tables });
  if (!message || message[0] !== 0x80) throw new Error('This transaction doesn’t fit even with its lookup table.');
  const signature = await sendOne((bh) => compileMessage({ payer, blockhash: bh, instructions: made.final, version: 0, lookupTables: tables }));
  return { signature, table: made.table.address, steps };
}
