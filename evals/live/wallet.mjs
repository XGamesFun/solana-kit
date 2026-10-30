// The test wallet: a browser wallet for the evals that signs from Node with a throwaway devnet key, after checking
// each transaction against a policy, and logs every request it gets. It registers through the Wallet Standard (what
// Phantom, Solflare and Backpack do) and also as a Phantom-style `window.solana`, so it works with whatever an
// agent's app expects. A transaction the policy refuses is not signed: the page gets an error, and the log keeps it
// as a finding.
import { appendFileSync } from 'node:fs';
import { addressBytes, decodeBase58, encodeBase58 } from '../../js/chain/base58.js';
import { readUintLE } from '../../js/chain/bytes.js';
import { readMessage, readTransaction, wireTransaction } from '../../js/chain/tx.js';
import { readTable } from '../../js/chain/lookup.js';
import { IDL } from '../../js/client/ix.js';
import { LOOT_PROGRAM, MPL_CORE_PROGRAM, pda } from '../../js/client/pda.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, associatedTokenAddress } from '../../js/chain/pda.js';

const ED25519 = 'Ed25519SigVerify111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// The lookup-table program: js/play sends a transaction too big for a legacy one as v0 with a table the wallet makes,
// fills, deactivates and later closes (js/chain/lookup.js).
const LOOKUP_TABLE = 'AddressLookupTab1e1111111111111111111111111';
const PROGRAMS = new Set([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, MPL_CORE_PROGRAM, LOOT_PROGRAM, ED25519, MEMO, LOOKUP_TABLE]);
const LOOT_BY_DISC = new Map(IDL.instructions.map((i) => [Buffer.from(i.discriminator).toString('hex'), i.name]));
/**
 * What a player may sign, and what an owner may sign while setting an economy up (`open_auction` hands the seller's own
 * collectible to the game, inside the loot program, for an auction of it).
 */
const PLAYER_LOOT = new Set(['pay', 'pay_nft', 'buy', 'open_box', 'settle', 'refund', 'buy_tickets', 'draw_lottery', 'finish_lottery_contribution', 'stake_tokens', 'unstake_tokens', 'stake_nft', 'unstake_nft', 'harvest', 'refresh_seat', 'craft', 'hold', 'release', 'enter', 'claim', 'claim_grant', 'run_schedule', 'open_auction', 'bid', 'end_auction',
  // What the program lets anyone send: asking the oracle for a waiting roll, cancelling an unanswered draw, proving a
  // compressed NFT or its traits, closing a stale leaf record.
  'ask_roll', 'cancel_lottery', 'prove_leaf', 'close_leaf', 'prove_traits']);
const OWNER_LOOT = new Set([...PLAYER_LOOT, 'create_project', 'update_project', 'open_pool', 'upsert', 'open_farm', 'move_tokens', 'collectible', 'open_contest', 'decide', 'roll', 'stash', 'set_traits']);

/**
 * Checks one transaction a wallet is asked to sign. `role`: 'owner' (setting up, the approval page) or 'player' (an
 * app). `game`: the game's address when known (a SOL transfer to one of its grants, the grant's funds, is fine).
 * `tables`: the addresses of each lookup table a v0 message loads from ({ [table]: [address…] }). Returns
 * { ok, findings: [text], summary: [what each instruction does] }.
 */
export function checkTransaction(message, { address, role, game = null, grants = [], owner = null, tables = {} }) {
  const { keys: statics, instructions, header, lookups } = readMessage(message);
  const findings = [];
  // A v0 message's accounts: its own, then those it loads from lookup tables (`tables`: each table's addresses, as
  // the chain holds them), the writable ones of every table first, then the read-only ones.
  const missing = lookups.filter((l) => !tables[l.address]);
  for (const l of missing) findings.push(`Loads accounts from a lookup table the wallet couldn't read: ${l.address}.`);
  const keys = [...statics, ...lookups.flatMap((l) => l.writable.map((i) => tables[l.address]?.[i])), ...lookups.flatMap((l) => l.readonly.map((i) => tables[l.address]?.[i]))];
  const summary = [];
  if (keys[0] !== address) findings.push(`The fee payer is ${keys[0]}, not this wallet.`);
  const signers = keys.slice(0, header.numRequiredSignatures);
  const own = new Set([address, associatedTokenAddress(address, NATIVE_MINT), associatedTokenAddress(address, NATIVE_MINT, TOKEN_2022_PROGRAM)]);
  const funds = new Set(game ? grants.map((id) => pda.grant(game, id)) : []);
  const opensBox = instructions.some((ix) => keys[ix.programIndex] === LOOT_PROGRAM && LOOT_BY_DISC.get(Buffer.from(ix.data.subarray(0, 8)).toString('hex')) === 'open_box');
  for (const ix of instructions) {
    const program = keys[ix.programIndex];
    const acct = (i) => keys[ix.accountIndexes[i]];
    if (!PROGRAMS.has(program)) {
      findings.push(`Calls a program the economy does not use: ${program}.`);
      continue;
    }
    if (program === LOOKUP_TABLE) {
      // The wallet's own table: made, filled, deactivated or closed by it (its authority), never frozen (its rent
      // would never come back).
      const kind = Number(readUintLE(ix.data, 0, 4));
      const what = ['make', 'freeze', 'fill', 'deactivate', 'close'][kind];
      if (!what || kind === 1) findings.push(`An unexpected lookup-table instruction (${kind}).`);
      else if (acct(1) !== address) findings.push(`A lookup-table instruction whose authority is ${acct(1)}, not this wallet.`);
      else if (kind === 4 && acct(2) !== address) findings.push(`Closes lookup table ${acct(0)} with its rent to ${acct(2)}, not this wallet.`);
      else summary.push(`${what} lookup table ${acct(0)}`);
      continue;
    }
    if (program === SYSTEM_PROGRAM) {
      const kind = readUintLE(ix.data, 0, 4);
      if (kind === 2n) {
        const lamports = readUintLE(ix.data, 4, 8);
        const to = acct(1);
        summary.push(`send ${lamports} lamports to ${to}`);
        // A player paying the project's owner directly (a tip to the address the owner gave) is theirs to choose.
        if (acct(0) === address && to === owner && role === 'player') summary.push('a direct payment to the project owner');
        // The player module's one-prompt box: the open funds a throwaway key with its settle's fee (a few thousand
        // lamports), and that key hands the rest back when it settles.
        else if (acct(0) === address && lamports <= 10_000_000n && opensBox) summary.push(`funds the settle key ${to} (${lamports} lamports)`);
        else if (acct(0) === address && !own.has(to) && !funds.has(to)) findings.push(`Sends ${Number(lamports) / 1e9} SOL from this wallet to ${to}, which is not its own wrapped-SOL account or a grant's funds.`);
      } else if (kind === 0n) summary.push(`create account ${acct(1)}`);
      else findings.push(`An unexpected System instruction (${kind}).`);
      continue;
    }
    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const kind = ix.data[0];
      if (kind === 3 || kind === 12) {
        const owner = kind === 3 ? acct(2) : acct(3);
        if (owner === address) findings.push(`A direct token transfer out of this wallet (to ${kind === 3 ? acct(1) : acct(2)}), outside the loot program.`);
        summary.push('token transfer');
      } else if (kind === 4 || kind === 13) findings.push(`Approves a delegate (${acct(1)}) to spend this wallet's tokens: the classic drain.`);
      else if (kind === 6) {
        const next = ix.data[2] === 1 ? encodeBase58(ix.data.subarray(3, 35)) : null;
        // An owner may hand a token's authority to its game, or give it up for good (a fixed supply); never to anyone else.
        if (role !== 'owner' || (next && game && next !== game)) findings.push(`Changes a token authority to ${next ?? 'nobody'}.`);
        summary.push(`set authority to ${next}`);
      } else if (kind === 9) {
        if (acct(1) !== address) findings.push(`Closes a token account and sends its rent to ${acct(1)}, not this wallet.`);
        summary.push('close token account');
      } else summary.push(`token instruction ${kind}`);
      continue;
    }
    if (program === LOOT_PROGRAM) {
      const name = LOOT_BY_DISC.get(Buffer.from(ix.data.subarray(0, 8)).toString('hex')) ?? 'unknown';
      summary.push(`loot ${name}`);
      const allowed = role === 'owner' ? OWNER_LOOT : PLAYER_LOOT;
      if (!allowed.has(name)) findings.push(`A ${role} is asked to sign loot's ${name}, which is the ${name === 'init_platform' || name.startsWith('set_') || name === 'collect_fees' ? 'platform’s' : 'authority’s'} to sign.`);
      continue;
    }
    summary.push(program === ASSOCIATED_TOKEN_PROGRAM ? 'open a token account' : program === MPL_CORE_PROGRAM ? 'metaplex core' : program === COMPUTE_BUDGET_PROGRAM ? 'compute budget' : program === ED25519 ? 'voucher signature check' : 'memo');
  }
  for (const s of signers) if (s !== address && keys.indexOf(s) < 0) findings.push(`Needs a signature from ${s}.`);
  return { ok: findings.length === 0, findings, summary };
}

const GRANT_IDS = Array.from({ length: 64 }, (_, i) => i);

/** Where create_project names the project among its accounts (after the owner, the authority and the treasury). */
const CREATED_AT = IDL.instructions.find((i) => i.name === 'create_project').accounts.findIndex((a) => a.name === 'project');

/** The games a transaction creates (loot create_project: its `project` account). */
function createdGames(message) {
  const { keys, instructions } = readMessage(message);
  return instructions.filter((ix) => keys[ix.programIndex] === LOOT_PROGRAM && LOOT_BY_DISC.get(Buffer.from(ix.data.subarray(0, 8)).toString('hex')) === 'create_project').map((ix) => keys[ix.accountIndexes[CREATED_AT]]);
}

/** The script a page runs before its own: registers the test wallet both ways. */
export function walletInitScript(address) {
  const publicKey = Array.from(addressBytes(address));
  return `(() => {
  const address = ${JSON.stringify(address)};
  const publicKey = new Uint8Array(${JSON.stringify(publicKey)});
  const call = (op, data) => window.__xsolanaTestWallet(op, data);
  const chains = ['solana:devnet', 'solana:testnet', 'solana:localnet'];
  const account = Object.freeze({ address, publicKey, chains, features: ['solana:signTransaction', 'solana:signAndSendTransaction', 'solana:signMessage'] });
  const bytes = (b) => Uint8Array.from(b);
  const wallet = {
    version: '1.0.0',
    name: 'xsolana Test Wallet',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=',
    chains,
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { await call('connect', null); return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: bytes(await call('sign', Array.from(i.transaction))) }))) },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signature: bytes(await call('signAndSend', Array.from(i.transaction))) }))) },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: bytes(await call('signMessage', Array.from(i.message))) }))) },
    },
  };
  const register = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail));
  try { window.dispatchEvent(Object.assign(new Event('wallet-standard:register-wallet'), { detail: register })); } catch (e) {}
  // A Phantom-style provider, for apps written against window.solana.
  const pk = { toBase58: () => address, toString: () => address, toBytes: () => publicKey, toBuffer: () => publicKey, equals: (o) => String(o?.toBase58?.() ?? o) === address };
  const wire = (tx) => (tx instanceof Uint8Array ? tx : tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const signed = async (tx) => {
    const out = bytes(await call('sign', Array.from(wire(tx))));
    if (tx instanceof Uint8Array) return out;
    const sig = out.slice(1, 65);
    if (Array.isArray(tx.signatures) && tx.signatures[0] instanceof Uint8Array) { const i = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === address); tx.signatures[i] = sig; return tx; }
    const pair = tx.signatures.find((s) => s.publicKey.toBase58() === address);
    tx.addSignature(pair.publicKey, sig);
    return tx;
  };
  const provider = {
    isPhantom: true, publicKey: null, isConnected: false,
    connect: async () => { await call('connect', null); provider.publicKey = pk; provider.isConnected = true; return { publicKey: pk }; },
    disconnect: async () => { provider.isConnected = false; },
    on: () => {}, off: () => {}, removeListener: () => {},
    signTransaction: signed,
    signAllTransactions: async (txs) => Promise.all(txs.map(signed)),
    signAndSendTransaction: async (tx) => { const s = bytes(await call('signAndSend', Array.from(wire(tx)))); return { signature: window.__lootBase58(s), publicKey: pk }; },
    signMessage: async (m) => ({ signature: bytes(await call('signMessage', Array.from(m))), publicKey: pk }),
  };
  window.solana = provider;
  window.phantom = { solana: provider };
})();`;
}

/**
 * Puts the test wallet into a Playwright browser context. `keypair`: { address, sign(message) }. `rpc`: the client's
 * rpc (send, confirm). Every request is appended to `log` (a JSONL file) and kept in `requests`.
 */
export async function attachWallet(context, { keypair, rpc, role, game = null, grants = [], owner = null, log }) {
  const requests = [];
  const created = new Set();
  const record = (r) => {
    requests.push(r);
    if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), role, ...r })}\n`);
  };
  await context.exposeFunction('__lootBase58', (b) => encodeBase58(Uint8Array.from(b)));
  await context.exposeFunction('__xsolanaTestWallet', async (op, data) => {
    if (op === 'connect') {
      record({ op });
      return null;
    }
    if (op === 'signMessage') {
      const message = Uint8Array.from(data);
      const looksLikeTx = (() => {
        try {
          readMessage(message);
          return true;
        } catch {
          return false;
        }
      })();
      record({ op, findings: looksLikeTx ? ['Asked to sign a transaction disguised as a message.'] : [], text: Buffer.from(message).toString('utf8').slice(0, 200) });
      if (looksLikeTx) throw new Error('The test wallet refuses to sign a transaction as a message.');
      return Array.from(keypair.sign(message));
    }
    const wire = Uint8Array.from(data);
    const t = readTransaction(wire);
    // An owner funds the grants of its own game: the one it is creating (from its create_project) or the one its xsolana.json
    // names, any grant id (spec v2 grants carry no id until they are live, so a resumed approval can't list them).
    if (role === 'owner') for (const g of createdGames(t.message)) created.add(g);
    const known = (typeof game === 'function' ? game() : game) ?? [...created].at(-1) ?? null;
    // The lookup tables a v0 transaction loads accounts from, read so every account it names is checked.
    const tables = {};
    for (const { address } of readMessage(t.message).lookups) {
      const table = readTable(await rpc.account(address).catch(() => null));
      if (table) tables[address] = table.addresses;
    }
    const verdict = checkTransaction(t.message, { address: keypair.address, role, owner, game: known, grants: role === 'owner' && known ? GRANT_IDS : typeof grants === 'function' ? grants() : grants, tables });
    record({ op, ok: verdict.ok, findings: verdict.findings, summary: verdict.summary });
    if (!verdict.ok) throw new Error(`The wallet refused: ${verdict.findings.join(' ')}`);
    const slot = t.signers.indexOf(keypair.address);
    if (slot < 0) throw new Error('This transaction does not ask this wallet to sign.');
    const sigs = [...t.signatures];
    sigs[slot] = keypair.sign(t.message);
    const signedWire = wireTransaction(t.message, sigs);
    if (op === 'sign') return Array.from(signedWire);
    const signature = await rpc.send(signedWire);
    await rpc.confirm(signature).catch(() => {});
    record({ op: 'sent', signature });
    return Array.from(decodeBase58(signature));
  });
  await context.addInitScript(walletInitScript(keypair.address));
  return { requests, findings: () => requests.flatMap((r) => r.findings ?? []) };
}

/** A headless Chrome (the machine's own, through playwright-core). */
export async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  const paths = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const { existsSync } = await import('node:fs');
  const executablePath = paths.find((p) => existsSync(p));
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
