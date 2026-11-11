// The cluster this process works on, and loot's address there. loot has an address of its own on each cluster, so
// what is signed for one (a voucher, a verdict) never counts on the other, and every address this client derives,
// every instruction it builds and everything it signs follows the cluster's address.
//
// One process works on one cluster. It is devnet unless the process names another: the environment variable
// XSOLANA_CLUSTER, or `useCluster` before anything is derived or built. Once an address has been derived the
// cluster is settled, and naming another is refused: addresses of two clusters never mix in one process.
// Browser-safe.
import { checkCluster, rightCluster } from '../chain/rpc.js';
import IDL from './idl/loot.js';

/**
 * Each cluster: loot's program there (devnet's is the IDL's own address), the chain as a wallet names it (Wallet
 * Standard), and the RPC used when none is given. Mainnet has none: its public RPC refuses or limits what loot reads
 * (a program's accounts, a compressed NFT's proof), so a mainnet RPC is always named (XSOLANA_RPC_URL, or `rpcUrl`).
 */
export const CLUSTERS = Object.freeze({
  devnet: Object.freeze({ program: IDL.address, chain: 'solana:devnet', rpc: 'https://api.devnet.solana.com' }),
  mainnet: Object.freeze({
    program: 'xgames8C758PyweWB9sDw8evvwsTVwyA2fGRUeAXVPy',
    chain: 'solana:mainnet',
    rpc: null,
  }),
});

const known = name => {
  if (!Object.hasOwn(CLUSTERS, name))
    throw new Error(`"${name}" is not a cluster loot knows: ${Object.keys(CLUSTERS).join(' or ')}.`);
  return name;
};

const fromEnv = globalThis.process?.env?.XSOLANA_CLUSTER?.trim() || null;
let name = known(fromEnv ?? 'devnet');
// Settled: named by the environment or by `useCluster`, or already used to derive an address.
let settled = Boolean(fromEnv);

/**
 * loot's program on this process's cluster. A live binding: it follows `useCluster`. Reading it settles nothing, so
 * take it when it is used, never into a value kept from before the cluster was named.
 * @type {string}
 */
export let LOOT_PROGRAM = CLUSTERS[name].program;

/**
 * Names the cluster this process works on (`devnet` or `mainnet`) and returns it. Call it first, before any address
 * is derived: it throws when the process already works on another cluster.
 * @param {'devnet' | 'mainnet'} cluster
 * @returns {'devnet' | 'mainnet'}
 */
export function useCluster(cluster) {
  known(cluster);
  if (cluster !== name) {
    if (settled)
      throw new Error(
        `This process already works on ${name}; it can't also work on ${cluster}. Start one for ${cluster} (XSOLANA_CLUSTER=${cluster}).`,
      );
    name = cluster;
    LOOT_PROGRAM = CLUSTERS[name].program;
  }
  settled = true;
  return name;
}

/**
 * The cluster this process works on. Asking settles it.
 * @returns {'devnet' | 'mainnet'}
 */
export function cluster() {
  settled = true;
  return name;
}

/** loot's program on this process's cluster, settling the cluster: what derives an address or builds an instruction calls this. */
export function lootProgram() {
  settled = true;
  return LOOT_PROGRAM;
}

// The tests' own switch, set by js/test/on-mainnet.mjs before a run of the whole suite on mainnet's address and by
// nothing else: the tests' economies, which say devnet or name no network, are then read as mainnet's.
const TEST_NETWORK = Symbol.for('xsolana.test.network');

/** The cluster an economy is on: the `network` its file names, devnet when it names none. */
export const networkOf = economy => globalThis[TEST_NETWORK] ?? economy?.network ?? 'devnet';

/**
 * The RPC URL this process reads and sends through: the one given, else XSOLANA_RPC_URL, else the cluster's own
 * (devnet's public RPC; mainnet has none). A URL that names another cluster is refused.
 */
export function clusterRpcUrl(url = globalThis.process?.env?.XSOLANA_RPC_URL || null) {
  const on = cluster();
  const chosen = url || CLUSTERS[on].rpc;
  if (!chosen)
    throw new Error(
      `No RPC for ${on}: name one (XSOLANA_RPC_URL, or rpcUrl). ${on === 'mainnet' ? 'Mainnet’s public RPC does not serve what loot reads, so there is no default.' : ''}`.trim(),
    );
  return rightCluster(chosen, on);
}

/** Refuses a chain that is not this process's cluster, by its genesis block (`rpc.js`, `checkCluster`). */
export const checkOnCluster = rpc => checkCluster(rpc, cluster());

/** This process's cluster as a wallet names it (Wallet Standard): `solana:devnet` or `solana:mainnet`. */
export const walletChain = () => CLUSTERS[cluster()].chain;
