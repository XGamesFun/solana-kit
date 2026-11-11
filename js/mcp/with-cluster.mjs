// For a server that answers for both clusters in one process (Node): `withCluster(cluster, fn)` runs `fn`, and
// everything it awaits, with the client on that cluster. Every address derived, instruction built and voucher signed
// inside it is that cluster's, whatever the process's own cluster is, and two pieces of work on two clusters can run
// at the same time without touching each other. Outside any, the client is on the process's own cluster
// (js/client/cluster.js, which stays free of Node so a page can load it: this file is the Node half).
//
// Importing this file sets it up: import it once, before the first request is answered.
import { AsyncLocalStorage } from 'node:async_hooks';
import { CLUSTERS, scopeClusters } from '../client/cluster.js';

const work = new AsyncLocalStorage();
scopeClusters(() => work.getStore());

/**
 * Runs `fn` on `cluster` (`devnet` or `mainnet`) and returns what it returns. A cluster loot does not know is refused.
 * @template T
 * @param {'devnet' | 'mainnet'} cluster
 * @param {() => T} fn
 * @returns {T}
 */
export function withCluster(cluster, fn) {
  if (!Object.hasOwn(CLUSTERS, cluster))
    throw new Error(`"${cluster}" is not a cluster loot knows: ${Object.keys(CLUSTERS).join(' or ')}.`);
  return work.run(cluster, fn);
}
