// A local Solana for tests and the full simulation: LiteSVM (an optional dependency) with the real loot program,
// Metaplex Core and MagicBlock's VRF, a clock the caller moves, and an `rpc` object answering what the client and the
// player calls read. Node only.
//
// Signatures are not checked (sigverify off): a player, the owner or the authority is an address marked as a signer,
// and nothing needs a key. The oracle is played the same way: after a transaction asks for randomness, `send`
// answers it at once with the loot program's own callback, signed by the identity the program checks (`["identity",
// loot]` under the VRF program), with randomness from the seeded generator, and puts the oracle's queue back as the
// oracle would have. The program's own tests do the same.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { decodeBase58, encodeBase58 } from '../chain/base58.js';
import { readUintLE } from '../chain/bytes.js';
import { SYSVAR_SLOT_HASHES, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { compileMessage, readMessage, readTransaction, signersOf } from '../chain/tx.js';
import { programError } from '../chain/rpc.js';
import { decode, receipts } from '../client/accounts.js';
import { callbackLotteryIx, callbackRandomIx, callbackRollIx, IDL } from '../client/ix.js';
import { BPF_LOADER_UPGRADEABLE, LOOT_PROGRAM, pda, VRF_QUEUE } from '../client/pda.js';

/** Slots are about 400 ms. */
const SLOTS_PER_SECOND = 2.5;
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
/** LiteSVM's transaction errors without fields, by number (its TransactionErrorFieldless). */
const TX_ERRORS = ['AccountInUse', 'AccountLoadedTwice', 'AccountNotFound', 'ProgramAccountNotFound', 'InsufficientFundsForFee', 'InvalidAccountForFee', 'AlreadyProcessed', 'BlockhashNotFound', 'CallChainTooDeep', 'MissingSignatureForFee', 'InvalidAccountIndex', 'SignatureFailure', 'InvalidProgramForExecution (a program the transaction calls is not loaded)', 'SanitizeFailure'];

/** LiteSVM's classes, or a plain sentence when it is not installed. */
export function loadLiteSVM(from = import.meta.url) {
  if (process.platform === 'win32') throw new Error('LiteSVM has no Windows build (its npm package ships Linux and macOS binaries only).');
  try {
    const m = createRequire(from)('litesvm');
    return { LiteSVM: m.LiteSVM, Rent: m.Rent, FeatureSet: m.FeatureSet };
  } catch {
    throw new Error('LiteSVM is not installed: `npm install litesvm@1.5.0` (an optional dependency, used by the tests and the full simulation).');
  }
}

/** A seeded byte generator: the same seed gives the same run. */
export function seeded(seed = 'loot') {
  let counter = 0n;
  let pool = new Uint8Array(0);
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!pool.length) pool = createHash('sha256').update(`${seed}:${counter++}`).digest();
      out[i] = pool[0];
      pool = pool.subarray(1);
    }
    return out;
  };
}

/** A fresh address nobody holds a key to (none is needed: signatures are not checked). */
export const newAddress = (random) => encodeBase58(random(32));

/** Each loot instruction's 8-byte discriminator → its name and its account names, flattened in order. */
const BY_DISCRIMINATOR = new Map(
  IDL.instructions.map((def) => {
    const names = [];
    const walk = (list) => list.forEach((a) => (a.accounts ? walk(a.accounts) : names.push(a.name)));
    walk(def.accounts);
    return [Buffer.from(def.discriminator).toString('hex'), { name: def.name, names }];
  }),
);
export const lootName = (ix) => (ix.programId === LOOT_PROGRAM ? BY_DISCRIMINATOR.get(Buffer.from(ix.data.subarray(0, 8)).toString('hex')) ?? null : null);

/** A token account's mint, owner and amount (classic and Token-2022 share these offsets). */
export function tokenAccount(account) {
  if (!account || !TOKEN_PROGRAMS.has(account.owner) || account.data.length < 165) return null;
  if (account.data.length > 165 && account.data[165] !== 2) return null; // Token-2022 account type: 2 = account
  return { mint: encodeBase58(account.data.subarray(0, 32)), owner: encodeBase58(account.data.subarray(32, 64)), amount: readUintLE(account.data, 64, 8) };
}

/** A mint's supply and decimals. */
export function mintAccount(account) {
  if (!account || !TOKEN_PROGRAMS.has(account.owner) || account.data.length < 82 || account.data.length === 165) return null;
  if (account.data.length > 165 && account.data[165] !== 1) return null;
  return { supply: readUintLE(account.data, 36, 8), decimals: account.data[44] };
}

/** The tokens a transaction moved, read from its token-program instructions, inner ones included. */
function tokenMoves(keys, instructions, mintOf) {
  const out = [];
  for (const { program, accounts, data } of instructions) {
    if (!TOKEN_PROGRAMS.has(program) || data.length < 9) continue;
    const amount = readUintLE(data, 1, 8);
    const a = (i) => keys[accounts[i]];
    if (data[0] === 3) out.push({ kind: 'transfer', from: a(0), to: a(1), mint: mintOf(a(0)), amount });
    else if (data[0] === 12) out.push({ kind: 'transfer', from: a(0), to: a(2), mint: a(1), amount });
    else if (data[0] === 7 || data[0] === 14) out.push({ kind: 'mint', from: null, to: a(1), mint: a(0), amount });
    else if (data[0] === 8 || data[0] === 15) out.push({ kind: 'burn', from: a(0), to: null, mint: a(1), amount });
  }
  return out;
}

/**
 * A LiteSVM as a cluster runs: `runtime` is { off, rent } (`off` the feature ids the cluster has off, `rent` its Rent
 * sysvar), set before LiteSVM makes its builtins and program runtime from the feature set. Without one, LiteSVM's own.
 */
function newSVM({ LiteSVM, FeatureSet, Rent }, runtime) {
  if (!runtime) return new LiteSVM();
  const features = FeatureSet.allEnabled();
  for (const id of runtime.off) features.deactivate(decodeBase58(id));
  const svm = LiteSVM.default().withFeatureSet(features).withBuiltins().withLamports(1_000_000_000_000_000n).withSysvars().withDefaultPrograms().withPrecompiles();
  const { lamportsPerByteYear, exemptionThreshold, burnPercent } = runtime.rent;
  svm.setRent(new Rent(lamportsPerByteYear, exemptionThreshold, burnPercent));
  return svm;
}

/**
 * The local chain. `programs`: { address: bytes or { bytes, loader } } (loot, Metaplex Core and VRF at least; a
 * program with no loader gets the upgradeable one); `accounts`: [{ address, owner, lamports, data }] to load (the VRF
 * queue at least); `runtime`: { off, rent }, the cluster's feature set and rent (`newSVM`), with LiteSVM's own when
 * absent (then `FeatureSet` and `Rent` are not needed); `start` the unix time the clock starts at; `random` a seeded
 * generator; `upgradeAuthority` makes that address the loot program's upgrade authority (so it can `init_platform`);
 * `onSent(record)` sees every landed transaction.
 */
export function simChain({ LiteSVM, FeatureSet, Rent, programs, accounts = [], runtime = null, start = 1_790_000_000, random = seeded(), upgradeAuthority = null, onSent = () => {} }) {
  const svm = newSVM({ LiteSVM, FeatureSet, Rent }, runtime);
  svm.withSigverify(false);
  svm.withBlockhashCheck(false);
  svm.withTransactionHistory(0n);
  svm.withNativeMints?.();
  for (const [address, program] of Object.entries(programs)) {
    if (program instanceof Uint8Array) svm.addProgram(address, program);
    else svm.addProgramWithLoader(address, program.bytes, program.loader);
  }
  const put = (address, { owner, lamports, data, executable = false }) =>
    svm.setAccount({ address, lamports: BigInt(lamports), data: Uint8Array.from(data), programAddress: owner, executable });
  for (const a of accounts) put(a.address, a);
  const queue = accounts.find((a) => a.address === VRF_QUEUE);
  const queueBytes = queue ? Uint8Array.from(queue.data) : null;

  function get(address) {
    const a = svm.getAccount(address);
    return a.exists ? { owner: a.programAddress, lamports: a.lamports, data: a.data, executable: a.executable } : null;
  }

  if (upgradeAuthority) {
    // LiteSVM deploys with no upgrade authority: write one into the ProgramData account, as the Rust tests do.
    const key = pda.programData();
    const pd = get(key);
    if (!pd) throw new Error('The loot program has no ProgramData account: is it loaded with the upgradeable loader?');
    const data = Uint8Array.from(pd.data);
    data[12] = 1;
    data.set(decodeBase58(upgradeAuthority), 13);
    put(key, { owner: BPF_LOADER_UPGRADEABLE, lamports: pd.lamports, data, executable: false });
  }

  const startSlot = 400_000_000n;
  let now = start;
  const setClock = () => {
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(now);
    const bySeconds = startSlot + BigInt(Math.floor((now - start) * SLOTS_PER_SECOND));
    clock.slot = clock.slot > bySeconds ? clock.slot : bySeconds;
    svm.setClock(clock);
  };
  setClock();
  const oracle = newAddress(random);
  svm.airdrop(oracle, 1_000_000_000_000n);
  /** A landed transaction moves the chain one slot on, as a real cluster does between transactions. */
  const tick = () => {
    const clock = svm.getClock();
    clock.slot += 1n;
    svm.setClock(clock);
  };

  function snapshot(keys) {
    const out = new Map();
    for (const k of keys) {
      const a = get(k);
      out.set(k, a ? { lamports: a.lamports, owner: a.owner, token: tokenAccount(a), mint: mintAccount(a), size: a.data.length } : null);
    }
    return out;
  }

  /** Compile, send, and throw the program's own words when it fails. Returns { id, logs, receipts }. */
  function sendRaw(payer, instructions, { label = '', role = 'player' } = {}) {
    const message = compileMessage({ payer, blockhash: svm.latestBlockhash(), instructions });
    const signers = signersOf(message);
    const keys = [...new Set([payer, ...instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)])])];
    const before = snapshot(keys);
    const signatures = Object.fromEntries(signers.map((s) => [s, random(64)]));
    const result = svm.sendTransaction({ messageBytes: message, signatures });
    const failed = typeof result.err === 'function';
    const logs = (failed ? result.meta() : result).logs();
    if (failed) {
      const err = result.err();
      const said = typeof err === 'number' ? (TX_ERRORS[err] ?? `transaction error ${err}`) : String(err?.toString?.() ?? 'failed');
      throw Object.assign(new Error(programError(said, logs)), { logs, label });
    }
    const after = snapshot(keys);
    tick();
    const id = encodeBase58(signatures[signers[0]]);
    const { keys: ordered, instructions: compiled } = readMessage(message);
    const run = [];
    const inner = result.innerInstructions();
    compiled.forEach((ix, i) => {
      run.push({ program: ordered[ix.programIndex], accounts: ix.accountIndexes, data: ix.data });
      for (const x of inner[i] ?? []) {
        const c = x.instruction();
        run.push({ program: ordered[c.programIdIndex()], accounts: Array.from(c.accounts()), data: c.data() });
      }
    });
    const mintOf = (account) => (before.get(account) ?? after.get(account))?.token?.mint ?? null;
    const record = {
      id,
      payer,
      role,
      label,
      signatures: signers.length,
      instructions,
      keys,
      before,
      after,
      moves: tokenMoves(ordered, run, mintOf),
      logs,
      receipts: receipts(logs, null),
      units: Number(result.computeUnitsConsumed?.() ?? 0n),
      at: now,
    };
    onSent(record);
    return record;
  }

  const restoreQueue = () => {
    if (!queueBytes) return;
    const q = get(VRF_QUEUE);
    put(VRF_QUEUE, { ...q, data: queueBytes });
  };

  /** The oracle answers what this transaction asked for: a box's roll, a lottery's draw, the authority's roll. */
  function answer(instructions, label) {
    const answers = [];
    for (const ix of instructions) {
      const known = lootName(ix);
      if (!known || !['open_box', 'ask_roll', 'draw_lottery', 'roll'].includes(known.name)) continue;
      const account = (name) => ix.keys[known.names.indexOf(name)]?.pubkey;
      const randomness = random(32);
      // A box's roll: asked by a purchase, or by anyone for a roll a mission or a recipe made.
      if (known.name === 'open_box' || known.name === 'ask_roll') {
        const order = account('order');
        const orderState = decode('Order', get(order).data);
        if (!['Pending', 'Asked'].includes(orderState.status)) continue; // a box of one entry gave it at once
        const box = decode('LootBox', get(orderState.loot_box).data);
        // Each prize pool's mint: tokens won move to the project's vault for it in the roll. A pool not opened has none.
        const poolMints = {};
        for (const prize of box.entries.flatMap((e) => e.prizes)) {
          const pool = prize.Tokens?.from.Pool?.[0];
          if (pool === undefined) continue;
          const held = get(pda.pool(orderState.project, pool));
          poolMints[pool] = held?.data?.length >= 32 ? encodeBase58(held.data.subarray(0, 32)) : null;
        }
        restoreQueue();
        answers.push(sendRaw(oracle, [callbackRollIx({ order, orderState, box, randomness, poolMints })], { label: `${label} (oracle)`, role: 'oracle' }));
      } else if (known.name === 'draw_lottery') {
        const lottery = account('lottery');
        const l = decode('Lottery', get(lottery).data);
        restoreQueue();
        if (l.status !== 'Drawing') continue;
        answers.push(sendRaw(oracle, [callbackLotteryIx({ project: l.project, id: l.id, lottery: l, randomness })], { label: `${label} (oracle)`, role: 'oracle' }));
      } else {
        const project = account('project');
        restoreQueue();
        answers.push(sendRaw(oracle, [callbackRandomIx({ project, reference: ix.data.subarray(8, 40), randomness })], { label: `${label} (oracle)`, role: 'oracle' }));
      }
    }
    return answers;
  }

  /** Send as `payer`; the oracle answers what the transaction asked for. Returns the record, with `answers`. */
  function send(payer, instructions, options = {}) {
    const record = sendRaw(payer, instructions, options);
    record.answers = answer(instructions, options.label ?? '');
    return record;
  }

  /**
   * A signed wire transaction, as a wallet or the approval page sends it: its own signatures and blockhash. The oracle
   * answers what it asked for. Returns its signature (base58).
   */
  function sendWire(wire, { label = 'wire', role = 'owner' } = {}) {
    const { message, signatures: slots, signers } = readTransaction(wire);
    const signatures = Object.fromEntries(signers.map((s, i) => [s, slots[i]]));
    const result = svm.sendTransaction({ messageBytes: message, signatures });
    const failed = typeof result.err === 'function';
    const logs = (failed ? result.meta() : result).logs();
    if (failed) {
      const err = result.err();
      const said = typeof err === 'number' ? (TX_ERRORS[err] ?? `transaction error ${err}`) : String(err?.toString?.() ?? 'failed');
      throw Object.assign(new Error(programError(said, logs)), { logs, label });
    }
    tick();
    const { keys, instructions: compiled } = readMessage(message);
    const instructions = compiled.map((ix) => ({ programId: keys[ix.programIndex], keys: ix.accountIndexes.map((k) => ({ pubkey: keys[k], isSigner: false, isWritable: false })), data: ix.data }));
    onSent({ id: encodeBase58(slots[0]), payer: signers[0], role, label, instructions, logs, receipts: receipts(logs, null), at: now });
    answer(instructions, label);
    return encodeBase58(slots[0]);
  }

  /**
   * The SlotHashes sysvar as a cluster's is when read: the last 512 slots, the current one first (every slot has a
   * block here). A lookup table is made at a slot it holds, and closes once its deactivation slot has left it.
   */
  function freshSlotHashes() {
    const slot = svm.getClock().slot;
    // Every slot has a block here: the last 512, newest first.
    const hash = svm.latestBlockhash();
    svm.setSlotHashes(Array.from({ length: Number(slot < 512n ? slot + 1n : 512n) }, (_, i) => ({ slot: slot - BigInt(i), hash })));
  }

  /** The methods of the client's rpc that the play calls read, answered from the local chain. */
  const rpc = {
    url: 'litesvm:',
    async accounts(addresses) {
      if (addresses.includes(SYSVAR_SLOT_HASHES)) freshSlotHashes();
      return addresses.map((a) => {
        const x = get(a);
        return x ? { ...x, lamports: Number(x.lamports) } : null;
      });
    },
    async account(address) {
      return (await rpc.accounts([address]))[0];
    },
    async balance(address) {
      return get(address)?.lamports ?? 0n;
    },
    async tokenBalance(address) {
      return tokenAccount(get(address))?.amount ?? 0n;
    },
    async programAccounts(program, filters = []) {
      const found = svm.getProgramAccounts(program).map((a) => ({ pubkey: a.address, account: { owner: a.programAddress, lamports: Number(a.lamports), data: a.data, executable: a.executable } }));
      const memcmp = (data, { offset, bytes }) => {
        const want = decodeBase58(bytes);
        return data.length >= offset + want.length && want.every((b, i) => data[offset + i] === b);
      };
      return found.filter((x) => filters.every((f) => (f.memcmp ? memcmp(x.account.data, f.memcmp) : f.dataSize === undefined || x.account.data.length === f.dataSize)));
    },
    async latestBlockhash() {
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number.MAX_SAFE_INTEGER };
    },
    async send(wire) {
      return sendWire(wire);
    },
    /** Dry-runs a wire transaction (its signatures are not checked) and returns `accounts`' state after it; nothing changes. */
    async simulate(wire, { accounts: watch = [] } = {}) {
      const { message, signatures: slots, signers } = readTransaction(wire);
      const result = svm.simulateTransaction({ messageBytes: message, signatures: Object.fromEntries(signers.map((s, i) => [s, slots[i]])) });
      if (typeof result.err === 'function') {
        const logs = result.meta().logs();
        throw Object.assign(new Error(`The network refused this in a dry run: ${programError(String(result.err()), logs)}`), { logs });
      }
      const post = new Map(result.postAccounts().map((x) => [x.address, x]));
      const accounts = await Promise.all(watch.map(async (a) => {
        const x = post.get(a);
        return x ? { owner: x.programAddress, lamports: Number(x.lamports), data: x.data, executable: x.executable } : rpc.accounts([a]).then(([y]) => y);
      }));
      return { unitsConsumed: Number(result.meta().computeUnitsConsumed()), logs: result.meta().logs(), accounts };
    },
    async confirm(signature) {
      return signature;
    },
    async call(method, params = []) {
      if (method === 'getSlot') return Number(svm.getClock().slot);
      if (method === 'getMinimumBalanceForRentExemption') return Number(svm.minimumBalanceForRentExemption(BigInt(params[0])));
      throw new Error(`The local chain does not answer ${method}.`);
    },
  };

  return {
    svm,
    rpc,
    oracle,
    get,
    put,
    send,
    sendRaw,
    sendWire,
    snapshot,
    now: () => now,
    slot: () => svm.getClock().slot,
    /** Moves the clock forward to `to` (unix seconds). */
    warp(to) {
      if (to > now) {
        now = Math.floor(to);
        setClock();
        svm.expireBlockhash();
      }
    },
    /** Moves the slot forward without moving the time. */
    nextSlot(slots = 1) {
      const clock = svm.getClock();
      clock.slot += BigInt(slots);
      svm.setClock(clock);
      svm.expireBlockhash();
    },
    airdrop: (address, lamports) => svm.airdrop(address, BigInt(lamports)),
    rent: (bytes) => svm.minimumBalanceForRentExemption(BigInt(bytes)),
    tokens: (address) => tokenAccount(get(address))?.amount ?? 0n,
    account: (name, address) => decode(name, get(address).data),
  };
}
