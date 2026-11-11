// A project pays its players' fees: a sponsor. The sponsor is a plain key on the project's own server, with no role in
// the program: it is the transaction's fee payer, and it lends the player SOL in the same transaction, the player
// giving back, last, all but what the step costs them beyond its price (the platform's player fee, the oracle's fee
// for a roll, and the rent of what the program opens or mints for them). It lends first and takes back after because a
// step can need more SOL midway than it costs (a wrapped-SOL account it opens and closes). A player with no SOL can then
// play with what they hold. The price itself is never sponsored.
//
// The app (`solanaApp({ sponsor })`) builds the transaction with the sponsor as payer, the player's wallet signs it,
// and the project's server checks it (`checkSponsored`) and signs it (`sponsorSigner`, `sponsorHandler`) before the
// app sends it. The server trusts nothing the page says: it reads the transaction itself and dry-runs it. What it
// holds to:
//
// - the sponsor appears in no instruction but its one loan, a plain transfer to a signer of the transaction (the
//   player), and plain transfers back to it: no instruction can move the sponsor's SOL but the loan, sign as it, or
//   name it otherwise;
// - at least one instruction is this project's (a loot instruction naming the project), and none pays the project's
//   fee box or the oracle straight from the page;
// - no priority fee past the server's limit (none by default);
// - in the dry run, what the sponsor is out (its loan less what came back) leaves the player no richer than they began,
//   and is at most what the step cost in fees and rent: what the project's fee box and the oracle took, and the rent of
//   what the program's own moves opened (`sponsoredCost`: a loot account, a token account of a mint the step's loot
//   instructions name, a Core asset when the page calls Core itself nowhere). An account the page opens for itself (a
//   plain key, a token account of any mint) is never sponsored: the player could close it and keep the rent;
// - the loan and the network fee together are at most `maxLamports`, and the project's `budget` (per player, per day)
//   agrees.
//
// What a sponsor can still lose: rent the program later gives back to the player (an order's, when it settles; a token
// account the player closes), up to `maxLamports` a transaction, and a fee for a transaction that passed its dry run
// but failed on chain. `budget` is where a project caps those.
//
// Browser-safe: the server side needs only an RPC and the sponsor's own `sign`, which the project's server provides
// (this package never holds a key).
import { readTable } from '../chain/lookup.js';
import { COMPUTE_BUDGET_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { transferLamports } from '../chain/programs.js';
import { encodeBase58 } from '../chain/base58.js';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readMessage, readTransaction, withSignature } from '../chain/tx.js';
import { lootProgram, MPL_CORE_PROGRAM, pda, VRF_PROGRAM } from '../client/index.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** What a signature costs the fee payer, in lamports. */
export const SIGNATURE_LAMPORTS = 5_000n;
/** The most a sponsored transaction may cost the sponsor by default: its top-up and its network fee, 0.01 SOL. */
export const SPONSOR_MAX_LAMPORTS = 10_000_000n;

const lamportsOf = a => (a ? BigInt(a.lamports) : 0n);
const u64At = (data, at) => new DataView(data.buffer, data.byteOffset).getBigUint64(at, true);
const u32At = (data, at) => new DataView(data.buffer, data.byteOffset).getUint32(at, true);

/** The top-up: the sponsor's transfer to the player, first in the transaction. */
export const sponsorTopUp = (sponsor, player, lamports) => transferLamports(sponsor, player, BigInt(lamports));

/** The give-back: what the step didn't need of the top-up, from the player back to the sponsor, last in the transaction. */
export const sponsorGiveBack = (sponsor, player, lamports) => transferLamports(player, sponsor, BigInt(lamports));

/**
 * What a step cost in fees and rent, from the accounts it names before and after a dry run (`pre`, `post`: one each
 * per address, null when there is none): what the project's fee box and the oracle took, and the full rent of each
 * account it opened that loot, Core or a token program owns. Only what the program's own moves open counts: a token
 * account counts when its mint is named by one of the step's loot instructions (`lootNamed`), and a Core asset when no
 * instruction of the step calls Core itself (`programs`: the programs its instructions call), so a player can't open
 * accounts of their own on the sponsor and close them for the rent. `skip`: the payer and the player.
 * @param {{ addresses: string[], pre: ({ owner: string, lamports: number | bigint, data?: Uint8Array } | null)[],
 *   post: ({ owner: string, lamports: number | bigint, data?: Uint8Array } | null)[], project: string, skip?: string[],
 *   programs?: string[], lootNamed?: string[] }} input
 * @returns {bigint}
 */
export function sponsoredCost({ addresses, pre, post, project, skip = [], programs = [], lootNamed = [] }) {
  const feeBox = pda.fees(project);
  const named = new Set(lootNamed);
  let cost = 0n;
  for (const [i, address] of addresses.entries()) {
    if (skip.includes(address)) continue;
    const before = pre[i];
    const after = post[i];
    if (!after) continue;
    const grew = lamportsOf(after) - lamportsOf(before);
    if (address === feeBox || after.owner === VRF_PROGRAM) {
      cost += grew > 0n ? grew : 0n;
      continue;
    }
    if (before) continue;
    const opened =
      after.owner === lootProgram() ||
      (after.owner === MPL_CORE_PROGRAM && !programs.includes(MPL_CORE_PROGRAM)) ||
      ((after.owner === TOKEN_PROGRAM || after.owner === TOKEN_2022_PROGRAM) &&
        after.data?.length >= 32 &&
        named.has(encodeBase58(after.data.subarray(0, 32))));
    if (opened) cost += lamportsOf(after);
  }
  return cost;
}

/** The programs a step's instructions call, and every account its loot instructions name: what `sponsoredCost` reads. */
export function stepShape(instructions) {
  return {
    programs: [...new Set(instructions.map(ix => ix.programId))],
    lootNamed: [
      ...new Set(instructions.filter(ix => ix.programId === lootProgram()).flatMap(ix => ix.keys.map(k => k.pubkey))),
    ],
  };
}

/**
 * The top-up a step needs: what it cost the player (`spend`, before any top-up) bounded by its fees and rent
 * (`cost`), never below 0. A step that leaves the player richer, or costs nothing, needs none.
 */
export const topUpFor = ({ spend, cost }) => {
  const t = spend < cost ? spend : cost;
  return t > 0n ? t : 0n;
};

/** The transaction's accounts in order: its static keys, then each lookup table's writable, then read-only ones. */
async function accountKeys(message, rpc) {
  const writable = [];
  const readonly = [];
  for (const l of message.lookups) {
    const table = readTable(await rpc.account(l.address));
    if (!table || table.deactivationSlot !== null) throw new Error(`the lookup table ${l.address} is not active`);
    const at = i => {
      if (i >= table.addresses.length) throw new Error(`the lookup table ${l.address} has no address ${i}`);
      return table.addresses[i];
    };
    writable.push(...l.writable.map(at));
    readonly.push(...l.readonly.map(at));
  }
  return [...message.keys, ...writable, ...readonly];
}

/**
 * Whether the project's sponsor should sign this transaction (a wire, the player's signature in it): read it, dry-run
 * it, and hold it to the rules above. Returns { ok: true, player, topUp, cost, lamports, message } (`topUp`: what the
 * player kept of it, the top-up less the give-back; `lamports`: what it costs the sponsor, that and the network fee)
 * or { ok: false, reason } in words.
 * @param {Uint8Array} wire
 * @param {{ rpc: any, project: string, sponsor: string, maxLamports?: bigint | number, maxPriorityMicroLamports?: bigint | number,
 *   budget?: ((ask: { player: string, lamports: bigint, topUp: bigint }) => boolean | Promise<boolean>) | null }} options
 */
export async function checkSponsored(
  wire,
  { rpc, project, sponsor, maxLamports = SPONSOR_MAX_LAMPORTS, maxPriorityMicroLamports = 0n, budget = null },
) {
  const no = reason => ({ ok: false, reason });
  let t;
  let m;
  let keys;
  try {
    t = readTransaction(wire);
    m = readMessage(t.message);
    keys = await accountKeys(m, rpc);
  } catch (e) {
    return no(`It is not a transaction this server can read: ${e.message}.`);
  }
  if (keys[0] !== sponsor) return no('The sponsor is not its fee payer.');
  const signers = keys.slice(0, m.header.numRequiredSignatures);
  if (signers.length < 2) return no('Only the sponsor signs it: a sponsored transaction is a player’s.');
  let topUp = null;
  let back = 0n;
  let ours = false;
  let units = 200_000n * BigInt(m.instructions.length);
  let price = 0n;
  for (const ix of m.instructions) {
    const program = keys[ix.programIndex];
    const accounts = ix.accountIndexes.map(i => keys[i]);
    if (program === sponsor) return no('It calls the sponsor as a program.');
    const isTransfer = program === SYSTEM_PROGRAM && ix.data.length === 12 && u32At(ix.data, 0) === 2;
    if (isTransfer && accounts[0] === sponsor && accounts.length === 2) {
      if (topUp) return no('It tops up more than once.');
      if (!signers.includes(accounts[1]) || accounts[1] === sponsor)
        return no('Its top-up goes to someone who doesn’t sign it.');
      topUp = { to: accounts[1], lamports: u64At(ix.data, 4) };
      continue;
    }
    if (isTransfer && accounts[1] === sponsor && accounts[0] !== sponsor && accounts.length === 2) {
      back += u64At(ix.data, 4);
      continue;
    }
    if (accounts.includes(sponsor)) return no('The sponsor is named in an instruction other than the top-up.');
    if (program === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2 && ix.data.length >= 5)
      units = BigInt(u32At(ix.data, 1));
    if (program === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 3 && ix.data.length >= 9) price = u64At(ix.data, 1);
    if (program === lootProgram() && accounts.includes(project)) ours = true;
  }
  if (!ours) return no('It does nothing in this project.');
  if (price > BigInt(maxPriorityMicroLamports)) return no('Its priority fee is more than this sponsor pays.');
  const fee = SIGNATURE_LAMPORTS * BigInt(signers.length) + (units * price + 999_999n) / 1_000_000n;
  const player = topUp?.to ?? signers.find(s => s !== sponsor);
  const lent = topUp?.lamports ?? 0n;
  if (lent + fee > BigInt(maxLamports))
    return no(`It would cost the sponsor ${lent + fee} lamports, more than the ${maxLamports} it pays a transaction.`);
  // What the sponsor is out once the player gives back what the step didn't need.
  const net = lent > back ? lent - back : 0n;
  const lamports = net + fee;
  const addresses = [...new Set(keys)];
  const at = address => addresses.indexOf(address);
  let pre;
  try {
    pre = await rpc.accounts(addresses);
  } catch (e) {
    return no(`Its accounts could not be read: ${e.message}`);
  }
  const feeBox = pda.fees(project);
  const steps = m.instructions.map(ix => ({
    programId: keys[ix.programIndex],
    keys: ix.accountIndexes.map(i => ({ pubkey: keys[i] })),
  }));
  // The fee box and the oracle are paid by the program's own moves, never straight from an instruction of the page's.
  for (const ix of steps.filter(x => x.programId === SYSTEM_PROGRAM))
    if (ix.keys.some(k => k.pubkey === feeBox || pre[at(k.pubkey)]?.owner === VRF_PROGRAM))
      return no('It pays the fee box or the oracle straight from an instruction of its own.');
  let post;
  try {
    post = (await rpc.simulate(wire, { accounts: addresses })).accounts;
  } catch (e) {
    return no(`It would fail: ${e.message}`);
  }
  const cost = sponsoredCost({ addresses, pre, post, project, skip: [sponsor, player], ...stepShape(steps) });
  // A player who keeps none of the top-up (it was all given back) may end richer by what the step itself pays them
  // (an order's rent, back at its settle): the sponsor paid only the fee.
  if (net > 0n) {
    if (lamportsOf(post[at(player)]) > lamportsOf(pre[at(player)]))
      return no('Its top-up is more than the step costs the player: they would keep some.');
    if (net > cost) return no('Its top-up is more than the step’s fees and rent: the price is the player’s.');
  }
  if (budget && !(await budget({ player, lamports, topUp: net })))
    return no('This project’s sponsor has paid as much as it pays for now.');
  return { ok: true, player, topUp: net, cost, lamports, message: t.message };
}

/**
 * The project's server side: `sign(wire)` checks a transaction (`checkSponsored`) and, when it passes, returns it with
 * the sponsor's signature; otherwise it throws the reason (`refused: true`). `sponsor.sign(message)`: the sponsor key's
 * ed25519 signature of the message bytes, made by the project's server, which alone holds that key.
 * @param {{ rpc: any, project: string, sponsor: { address: string, sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array> },
 *   maxLamports?: bigint | number, maxPriorityMicroLamports?: bigint | number,
 *   budget?: ((ask: { player: string, lamports: bigint, topUp: bigint }) => boolean | Promise<boolean>) | null }} options
 */
export function sponsorSigner({ rpc, project, sponsor, ...limits }) {
  return {
    address: sponsor.address,
    async sign(wire) {
      const checked = await checkSponsored(wire, { rpc, project, sponsor: sponsor.address, ...limits });
      if (!checked.ok) throw Object.assign(new Error(checked.reason), { refused: true });
      return withSignature(wire, sponsor.address, await sponsor.sign(checked.message));
    },
  };
}

/**
 * The sponsor as an HTTP endpoint (a Next.js route, a Worker): POST { transaction } (base64) answers { transaction }
 * signed, or 403 { error } in words. `signer`: a `sponsorSigner`.
 * @param {Request} request
 * @param {{ address: string, sign: (wire: Uint8Array) => Promise<Uint8Array> }} signer
 * @returns {Promise<Response>}
 */
export async function sponsorHandler(request, signer) {
  const answer = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  if (request.method !== 'POST') return answer({ error: 'POST a transaction.' }, 405);
  let wire;
  try {
    const body = await request.json();
    wire = fromBase64(String(body.transaction));
    if (wire.length > 1232) throw new Error('too long');
  } catch {
    return answer({ error: 'Send { "transaction": "<base64>" }.' }, 400);
  }
  try {
    return answer({ transaction: toBase64(await signer.sign(wire)), sponsor: signer.address });
  } catch (e) {
    return answer({ error: e.message }, e.refused ? 403 : 500);
  }
}

/**
 * The app's side of a sponsor behind `url` (`sponsorHandler`): what `solanaApp({ sponsor })` takes. `address`: the
 * sponsor's public key; `maxLamports`: the most it pays a transaction, as its server says.
 * @param {{ url: string, address: string, maxLamports?: bigint | number, fetchImpl?: typeof fetch }} options
 */
export function httpSponsor({ url, address, maxLamports = SPONSOR_MAX_LAMPORTS, fetchImpl = fetch }) {
  return {
    address,
    maxLamports: BigInt(maxLamports),
    async sign(wire) {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: toBase64(wire) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.transaction)
        throw Object.assign(new Error(body.error ?? `The sponsor answered ${r.status}.`), {
          refused: r.status === 403,
        });
      return fromBase64(body.transaction);
    },
  };
}
