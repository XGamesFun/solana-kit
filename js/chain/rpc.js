// The Solana JSON-RPC calls this kit makes, over fetch, for browser apps and Node alike. Public RPCs rate-limit
// (devnet: about 100 requests per 10 s per IP, 40 for any one method), so 429s are retried with backoff, and so are a
// gateway's passing failures (502, 503, 504).
import { fromBase64, toBase64 } from './bytes.js';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

const TIMEOUT_MS = 20_000;
const RETRIES = 4;
// A rate limit is waited out longer than a failed connection: about a minute in all, with jitter so pages and
// servers sharing an IP don't retry in step.
const RATE_LIMIT_RETRIES = 7;
const CONFIRM_POLL_MS = 1200;
const CONFIRM_TIMEOUT_MS = 90_000;
const ACCOUNTS_PER_CALL = 100;
/** The HTTP statuses of a gateway that failed for a moment (bad gateway, unavailable, timed out): retried. */
const PASSING = [502, 503, 504];
/** The JSON-RPC errors of a node behind the cluster: retried. */
const BEHIND = [-32005, -32016];

/** A JSON-RPC failure, with the node's own message (and logs for a failed simulation). */
export class RpcError extends Error {
  constructor(message, { code, logs } = NO_OPTIONS) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.logs = logs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first block of each public Solana cluster: it names the cluster whatever URL reaches it. */
export const GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
});

const DEVNET_ONLY = 'loot runs on devnet only: mainnet waits for an audit. Unset XSOLANA_RPC_URL, or point it at a devnet RPC.';

/** Refuses an RPC URL that names mainnet. Returns the URL. */
export function notMainnet(url) {
  if (/mainnet/i.test(String(url))) throw new RpcError(`${url} is a mainnet RPC. ${DEVNET_ONLY}`);
  return url;
}

/**
 * Refuses a chain that is mainnet or testnet, by its genesis block, whatever its URL says (a local validator is
 * let through). `rpc` has `call`. Returns the genesis hash.
 */
export async function checkCluster(rpc) {
  const genesis = await rpc.call('getGenesisHash');
  if (genesis === GENESIS.mainnet) throw new RpcError(`${rpc.url ?? 'This RPC'} is on mainnet. ${DEVNET_ONLY}`);
  if (genesis === GENESIS.testnet) throw new RpcError(`${rpc.url ?? 'This RPC'} is on testnet. ${DEVNET_ONLY}`);
  return genesis;
}
const decodeAccount = (raw) =>
  raw ? { owner: raw.owner, lamports: raw.lamports, data: fromBase64(raw.data[0]), executable: raw.executable } : null;

/** The program's own words for a failed run (`AnchorError … Error Message: …`), else the last error log line. */
export function programError(err, logs) {
  const anchor = logs?.find((line) => line.includes('AnchorError'));
  const said = anchor ? /Error Message: (.+?)\.?$/.exec(anchor)?.[1] : undefined;
  const code = anchor ? /Error Code: (\w+)/.exec(anchor)?.[1] : undefined;
  const last = logs?.filter((l) => /error|failed|insufficient/i.test(l)).at(-1);
  if (said) return code ? `${said} (${code})` : said;
  return last ?? (typeof err === 'string' ? err : JSON.stringify(err));
}

/** A client for one RPC URL. `fetchImpl` and `sleepImpl` are for tests. */
export function rpcClient(url, { fetchImpl = globalThis.fetch, sleepImpl = sleep } = {}) {
  let id = 0;
  async function call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < RETRIES) {
          await sleepImpl(500 * 2 ** attempt);
          continue;
        }
        throw new RpcError(`RPC ${method} did not answer: ${error.message}`);
      }
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const after = Number(response.headers?.get?.('retry-after'));
        await sleepImpl(after > 0 ? after * 1000 : Math.min(1000 * 2 ** attempt, 15_000) * (0.75 + Math.random() / 2));
        continue;
      }
      // Sending the same signed transaction again is safe: it has one signature, so it lands once at most.
      if (PASSING.includes(response.status) && attempt < RETRIES) {
        await sleepImpl(500 * 2 ** attempt);
        continue;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.error) {
        const message = body?.error?.message ?? `RPC ${method} failed (HTTP ${response.status})`;
        if (body?.error?.code === 429 && attempt < RETRIES) {
          await sleepImpl(1000 * 2 ** attempt);
          continue;
        }
        // A node of a load-balanced RPC a moment behind: "No confirmed state available yet" (-32005), "Minimum context
        // slot has not been reached" (-32016). Asked again, another (or the same, caught up) answers.
        if (BEHIND.includes(body?.error?.code) && attempt < RETRIES) {
          await sleepImpl(500 * 2 ** attempt);
          continue;
        }
        // A send whose preflight failed ("Transaction simulation failed: … custom program error: 0x17b5") carries the
        // logs, where the program says why in words.
        const logs = body?.error?.data?.logs;
        const said = logs?.length ? `The network refused this in a dry run: ${programError(body.error.data.err, logs)}` : message;
        throw new RpcError(said, { code: body?.error?.code, logs });
      }
      return body.result;
    }
  }

  async function accounts(addresses, commitment = 'confirmed', { minContextSlot } = NO_OPTIONS) {
    const out = [];
    for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_CALL) {
      const batch = addresses.slice(i, i + ACCOUNTS_PER_CALL);
      const r = await call('getMultipleAccounts', [batch, { encoding: 'base64', commitment, ...(minContextSlot != null ? { minContextSlot: Number(minContextSlot) } : {}) }]);
      out.push(...r.value.map(decodeAccount));
    }
    return out;
  }

  async function signatureStatus(signature) {
    const r = await call('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
    return r.value[0];
  }

  return {
    url,
    call,
    /** Accounts as of `commitment`; `minContextSlot`: from a node that has seen at least that slot (one's own landed send). */
    accounts,
    async account(address, commitment = 'confirmed', options = {}) {
      return (await accounts([address], commitment, options))[0];
    },
    async latestBlockhash() {
      const r = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
    },
    async blockHeight() {
      return call('getBlockHeight', [{ commitment: 'confirmed' }]);
    },
    async balance(address) {
      return BigInt((await call('getBalance', [address, { commitment: 'confirmed' }])).value);
    },
    /**
     * A token account's balance in base units, or 0n when there is no account there. Any other refusal throws: an
     * address that is not a token account (a wallet's, passed by mistake: "Invalid param: not a Token account") is
     * not an empty one.
     */
    async tokenBalance(tokenAccount) {
      try {
        return BigInt((await call('getTokenAccountBalance', [tokenAccount, { commitment: 'confirmed' }])).value.amount);
      } catch (error) {
        if (/could not find account|account not found/i.test(error.message)) return 0n;
        throw error;
      }
    },
    async programAccounts(program, filters) {
      const r = await call('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', filters }]);
      return r.map((x) => ({ pubkey: x.pubkey, account: decodeAccount(x.account) }));
    },
    /**
     * Dry-run a wire transaction (empty signature slots are fine). Throws with the program's reason when it fails.
     * `accounts`: addresses whose state after the run to return (base64-decoded, or null).
     */
    async simulate(wire, { accounts: watch = [], replaceBlockhash = false } = {}) {
      const r = await call('simulateTransaction', [
        toBase64(wire),
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: replaceBlockhash,
          commitment: 'confirmed',
          ...(watch.length ? { accounts: { encoding: 'base64', addresses: watch } } : {}),
        },
      ]);
      const value = r.value;
      if (value.err) throw new RpcError(`The network refused this in a dry run: ${programError(value.err, value.logs)}`, { logs: value.logs });
      return { unitsConsumed: value.unitsConsumed ?? null, logs: value.logs ?? [], accounts: (value.accounts ?? []).map(decodeAccount) };
    },
    async send(wire) {
      return call('sendTransaction', [toBase64(wire), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }]);
    },
    signatureStatus,
    /** Wait until a sent transaction is confirmed; throws with the program's reason when it failed. */
    async confirm(signature, { timeoutMs = CONFIRM_TIMEOUT_MS, lastValidBlockHeight = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (let poll = 0; Date.now() < deadline; poll++) {
        const status = await signatureStatus(signature);
        if (status?.err) {
          const tx = await call('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
          throw new RpcError(`Transaction ${signature} failed: ${programError(status.err, tx?.meta?.logMessages)}`, { logs: tx?.meta?.logMessages });
        }
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
        if (lastValidBlockHeight !== null && poll % 5 === 4) {
          const height = await call('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => 0);
          if (height > lastValidBlockHeight) throw new RpcError(`Transaction ${signature} expired before it landed. Try again.`);
        }
        await sleepImpl(CONFIRM_POLL_MS);
      }
      throw new RpcError(`Transaction ${signature} was not confirmed in time; check it in the explorer.`);
    },
  };
}
