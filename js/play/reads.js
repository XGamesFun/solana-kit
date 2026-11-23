// The reads the page client's parts share (solanaApp): the project's record (read once), the slot and the chain's clock,
// a token's transfer-hook accounts, and a token's settings that can turn a payment away; and the player's balances.
import { NO_ADDRESS } from '../chain/base58.js';
import { SYSVAR_CLOCK, SYSVAR_SLOT_HASHES, TOKEN_2022_PROGRAM } from '../chain/pda.js';
import { extension, mayStartFrozen, resolveTransfers } from '../chain/token2022.js';
import { slotHashes } from '../chain/lookup.js';
import * as loot from '../client/index.js';
import { show } from './common.js';

/**
 * Puts on `ctx` the project's record, the slot and the clock, a token's hook accounts and settings. Returns `ctx`.
 * @param {ReturnType<typeof import('./gates.js').addGates>} ctx
 */
export function addReads(ctx) {
  const { now, client, project, read } = ctx;

  /**
   * A token's own settings that let whoever is to be paid turn a payment away, for a page to say before a player puts
   * money in: accounts that start frozen or can be switched to it (a payee closes their own account, and the one
   * opened again in its place is frozen), confidential transfers (a payee's account can refuse plain ones), and a token
   * that can't be transferred at all. `what`: the payment ("repaying", "a higher bid"); `who` and `then`: who could and
   * what they gain. Each is { power, says }.
   */
  function tokenSettings(account, what, who, then) {
    if (account?.owner !== TOKEN_2022_PROGRAM || account.data.length <= 166 || account.data[165] !== 1) return [];
    const out = [];
    if (mayStartFrozen(account))
      out.push({
        power: 'startsFrozen',
        says: `New accounts of this token start frozen, or can be switched to start frozen: ${who} can close their own account so that ${what} cannot arrive, ${then}.`,
      });
    if (extension(account.data, 4))
      out.push({
        power: 'confidential',
        says: `This token has confidential transfers: ${who} can turn plain transfers into their account off so that ${what} cannot arrive, ${then}.`,
      });
    if (extension(account.data, 9))
      out.push({
        power: 'nonTransferable',
        says: `This token can't be transferred: nothing can be paid in it, ${what} included.`,
      });
    return out;
  }
  ctx.projectState = null;
  const projectNow = async () => (ctx.projectState ??= await read('Project', project));

  /** The current slot (a later ask or a refund of a failed order needs a later slot; an order's deadlines count in seconds: `chainNow`). */
  const slotNow = async () => BigInt(await client.call('getSlot', [{ commitment: 'confirmed' }]));
  /** The slots the SlotHashes sysvar holds now (a lookup table closes once its deactivation slot has left them). */
  const recentSlots = async () => slotHashes((await client.account(SYSVAR_SLOT_HASHES))?.data);
  /** The chain's clock (Unix seconds), read from its Clock sysvar; the computer's (`now`) when it can't be read. */
  const chainNow = async () => {
    const clock = await client.account(SYSVAR_CLOCK).catch(() => null);
    if (!clock?.data || clock.data.length < 40) return BigInt(now());
    const v = clock.data.subarray(32, 40).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n);
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  };

  /**
   * The tail a round's transfers need: each mint's transfer-hook accounts (its extra-account metas, read as every
   * hooked transfer of the client reads them), once each; none for a mint with no hook. A hook whose list names each
   * transfer can't be resolved ahead and is left out (the call then fails on it).
   */
  async function hookTail(mints) {
    const out = new Map();
    for (const mint of new Set(mints.filter(x => x && x !== NO_ADDRESS))) {
      const resolved = await resolveTransfers(client, mint).catch(() => null);
      for (const m of resolved?.extraAccounts ?? []) {
        const had = out.get(m.pubkey);
        out.set(m.pubkey, had ? { ...had, isWritable: had.isWritable || m.isWritable } : m);
      }
    }
    return [...out.values()];
  }
  return Object.assign(ctx, { tokenSettings, projectNow, slotNow, recentSlots, chainNow, hookTail });
}

/**
 * The read method: `balances`.
 * @param {import('./common.js').Ctx} ctx
 */
export function readMethods(ctx) {
  const { wallet, client, tokens, mintOf, programOf } = ctx;

  return {
    /** What the player holds of each of the economy's tokens, in whole units. */
    async balances(owner = wallet?.address) {
      const out = {};
      for (const t of tokens.values()) {
        const mint = mintOf(t.key);
        if (t.source === 'sol') out[t.key] = show(await client.balance(owner), 9);
        else if (mint) {
          const a = await client.account(loot.ata(owner, mint, programOf(mint)));
          out[t.key] = a
            ? show(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true), t.decimals ?? 0)
            : '0';
        }
      }
      return out;
    },
  };
}
