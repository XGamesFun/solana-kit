// The throwaway keys js/play settles with (the key job rule, AGENTS.md), made so a page that closes in the middle of a
// job can find them again and finish it, or send their SOL back.
//
// A key is named by the account its job is about (an order, a hold). With a wallet that signs messages, every key comes
// from one signature of the wallet's over a fixed text naming the project and the wallet, asked once a session: the
// key's seed is sha256("loot settle key" | that signature | the name). Ed25519 signatures are deterministic, so after a
// reload the same signature gives the same keys. A wallet that signs no messages, or whose signature of the text
// changes from one session to the next (some MPC wallets), gets a random key instead, kept in the page's storage
// encrypted with a device key the page can use but never read out (WebCrypto, IndexedDB); with no such storage, in
// memory only, as before.
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, fromBase64, randomBytes, toBase64, toHex, utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';

/** The PKCS #8 header of a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const fromBase64Url = (text) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));

/** An Ed25519 key from its 32-byte seed: { address, sign(message) }. */
export async function keyFromSeed(seed, name = null) {
  const subtle = globalThis.crypto.subtle;
  const pkcs8 = concat(PKCS8_ED25519, seed);
  const jwk = await subtle.exportKey('jwk', await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']));
  const signer = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return { address: encodeBase58(fromBase64Url(jwk.x)), name, sign: async (message) => new Uint8Array(await subtle.sign('Ed25519', signer, message)) };
}

/** The text a wallet signs once a session for its settle keys. It moves nothing and says so. */
export const settleKeysText = (project, wallet) =>
  `loot: the keys that settle your orders\nproject ${project}\nwallet ${wallet}\n\nSigning this moves nothing. A page that closes before it settles makes the same key again from it, to finish or send your SOL back.`;

/**
 * The page's storage of keys that can't be made again (`localStorage`), and a device key that encrypts them, kept in
 * IndexedDB as a non-extractable AES-GCM key. Null where either is missing (then keys live in memory only).
 */
export function browserStore() {
  const ls = globalThis.localStorage;
  if (!ls || !globalThis.indexedDB) return null;
  let device = null;
  return {
    get: (k) => ls.getItem(k),
    set: (k, v) => ls.setItem(k, v),
    remove: (k) => ls.removeItem(k),
    keys: () => Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter(Boolean),
    cryptoKey: () => (device ??= deviceKey().catch(() => null)),
  };
}

async function deviceKey() {
  const db = await new Promise((resolve, reject) => {
    const r = globalThis.indexedDB.open('loot-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const found = await new Promise((resolve, reject) => {
    const r = db.transaction('keys').objectStore('keys').get('device');
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
  if (found) return found;
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(key, 'device');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

/**
 * The keys of `wallet` ({ address, signMessage? }) in `project`. `store`: `browserStore()`'s shape ({ get, set, remove,
 * keys, cryptoKey }), or null. `key(name)` makes the key named by an address (asking the wallet for its signature the
 * first time in a session); `again(name)` makes it again for a job left unfinished, or finds it stored, or null;
 * `stored()` lists the names of keys stored; `forget(name)` drops a stored key once its job is done and it is empty.
 * `how()` says how keys are made: 'derived', 'stored' or 'memory'.
 */
export function keyring({ wallet, project, store = null }) {
  let root = null;
  const prefix = () => `loot-key:${project}:${wallet.address}:`;
  const checkName = () => `loot-key-check:${project}:${wallet.address}`;
  const safe = (f, fallback = null) => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };

  /** The wallet's signature of `settleKeysText`, once a session; null when it signs no messages, refuses, or signs the
   * text differently from an earlier session (then nothing it signed could be made again). */
  function signature() {
    if (!wallet?.signMessage) return Promise.resolve(null);
    root ??= (async () => {
      const sig = new Uint8Array(await wallet.signMessage(utf8(settleKeysText(project, wallet.address))));
      if (sig.length !== 64) return null;
      const mark = toHex(sha256(sha256(sig))).slice(0, 32);
      const had = store ? safe(() => store.get(checkName())) : null;
      if (had && had !== mark) return null;
      if (!had && store) safe(() => store.set(checkName(), mark));
      return sig;
    })().catch(() => null);
    return root;
  }

  const derived = (sig, name) => keyFromSeed(sha256(concat(utf8('loot settle key'), sig, addressBytes(name))), name);

  async function seal(seed) {
    const device = await store?.cryptoKey?.();
    if (!device) return null;
    const iv = randomBytes(12);
    const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, device, seed));
    return toBase64(concat(iv, sealed));
  }

  async function open(text) {
    const device = await store?.cryptoKey?.();
    if (!device || !text) return null;
    const bytes = fromBase64(text);
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, device, bytes.subarray(12)));
  }

  return {
    async how() {
      if (await signature()) return 'derived';
      return store && (await store.cryptoKey?.()) ? 'stored' : 'memory';
    },

    /** The key named `name` (an address) for a new job. */
    async key(name) {
      const sig = await signature();
      if (sig) return derived(sig, name);
      const seed = randomBytes(32);
      const sealed = store ? await seal(seed).catch(() => null) : null;
      if (sealed) safe(() => store.set(prefix() + name, sealed));
      return keyFromSeed(seed, name);
    },

    /** The key named `name` again, for a job left unfinished: made again from the wallet's signature, or read from
     * storage; null when neither can. `ask`: false to make it only from a signature already given this session. */
    async again(name, { ask = true } = {}) {
      const sig = ask || root ? await signature() : null;
      if (sig) return derived(sig, name);
      const text = store ? safe(() => store.get(prefix() + name)) : null;
      const seed = text ? await open(text).catch(() => null) : null;
      return seed ? keyFromSeed(seed, name) : null;
    },

    /** The names of the keys this page stored for the wallet (none when keys are made from its signature). */
    stored() {
      if (!store) return [];
      const p = prefix();
      return safe(() => store.keys(), []).filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
    },

    forget(name) {
      if (store && name) safe(() => store.remove(prefix() + name));
    },
  };
}
