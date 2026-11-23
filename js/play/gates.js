// Who may, for the page client (solanaApp): the person a limit counts this wallet as (a link voucher the project's server
// signs, taken by `link`), and a gate's checks: the NFT of the player's that passes it, or the list proof of a wallet on
// its list; and an NFT's traits proven into its Sheet, where a rule reads them (`proveTraits`).
import { decodeBase58 } from '../chain/base58.js';
import { ownedAssetFilters, parseCoreAsset } from '../chain/core.js';
import * as loot from '../client/index.js';
import { MPL_CORE, show } from './common.js';

/** Adds to `ctx` the link voucher waiting, the person a limit counts and what passes a gate; returns `proveTraits`, `link`. */
export function addGates(ctx) {
  const { spec, wallet, now, client, project, ours, tokens, decimalsOf, read, readMaybe, owned } = ctx;

  /** The link voucher the project's issuer gave this wallet (`link`), sent with the next step that counts by person. */
  ctx.pendingLink = null;
  /** The Ed25519 check of a link voucher and `link_wallet`, for this wallet. */
  const linkIxs = v => [
    loot.ed25519Ix({
      publicKey: v.publicKey,
      signature: v.signature,
      message: loot.linkBytes({ project, wallet: wallet.address, person: v.person, expires: v.expires }),
    }),
    loot.linkWalletIx({ project, wallet: wallet.address, person: v.person, expires: v.expires }),
  ];
  /**
   * The person a limit (`limit`, a `PerWallet`) counts this wallet as, and the steps that link it first: none for a
   * limit by wallet; the link voucher given (`link`), sent in the same transaction; or the link the wallet has.
   */
  const personFor = async limit => {
    const on = limit && (Number(limit.total) || Number(limit.per_window));
    if (!on || !limit.by_person) return { person: null, ixs: [] };
    // The chain's link, when it says what the voucher given says (or no voucher is waiting): the voucher has landed.
    const linked = await readMaybe('Link', loot.pda.link(project, wallet.address));
    const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    const pending = ctx.pendingLink && Number(ctx.pendingLink.expires) > now() ? ctx.pendingLink : null;
    if (linked && (!pending || hex(Uint8Array.from(linked.person)) === pending.person)) {
      ctx.pendingLink = null;
      return { person: Uint8Array.from(linked.person), ixs: [] };
    }
    // A voucher waiting goes with this step; it stays until the chain has it, so a step that fails keeps it.
    if (pending) return { person: pending.person, ixs: linkIxs(pending) };
    throw new Error(
      'This counts each person, and this wallet is linked to none yet: pass the link voucher the project’s server signs (`link`) first.',
    );
  };
  /** The Sheet the project keeps of an NFT it has no authority over: { key: value } of what the project wrote. */
  const sheetOf = async nft => {
    const found = await client.account(loot.pda.sheet(project, nft));
    return Object.fromEntries(
      (loot.decodeSheet(found?.owner === loot.lootProgram() ? found.data : null)?.attributes ?? []).map(a => [
        a.key,
        a.value,
      ]),
    );
  };
  /**
   * For a gate (the program's Gate: a Rule an NFT must pass, or a list of wallets), one of the player's NFTs that
   * passes it, so a page needn't find it; null when nothing is to be shown. A rule naming a collection the project has no
   * authority over finds the player's Core assets of it (with what the project wrote in their Sheets); a Token Metadata NFT
   * is not looked for: pass it as `shown: { mint, owner }`. Throws a plain sentence when none passes, or the wallet is not on the list.
   * A stake gate shows nothing: the client passes the wallet's seat in its farm; here it is only read, to say plainly
   * when it holds too little or its lock is over (the program counts a stake only while its tier's lock runs, and
   * only one made before this second).
   */
  async function passing(gate, what) {
    if (!gate) return null;
    // A list is passed with a proof, not an NFT (`listProofOf`).
    if (gate.List) return null;
    if (gate.Staked) {
      const { farm, at_least: atLeast } = gate.Staked;
      const seat = await readMaybe('Seat', loot.pda.seat(farm, wallet.address));
      const f = (spec.farms ?? []).find(x => loot.pda.farm(project, x.id) === farm);
      const t = f ? tokens.get(f.stakes) : null;
      const needs = t ? `${show(atLeast, decimalsOf(t.key))} ${t.symbol ?? t.key}` : `${atLeast} (in base units)`;
      const where = f ? `“${f.name}”` : 'its farm';
      if (!seat || BigInt(seat.amount) < BigInt(atLeast))
        throw new Error(`You need at least ${needs} staked in ${where} to ${what}.`);
      // Only a locked stake counts: its tier's lock still running.
      const lock = BigInt((await read('Farm', farm)).tiers[seat.tier]?.lock ?? 0);
      if (lock === 0n || BigInt(now()) >= BigInt(seat.since) + lock)
        throw new Error(
          `Your stake in ${where} counts only while it is locked: stake in a tier with a lock (staking again starts a new one) to ${what}.`,
        );
      return null;
    }
    if (gate.Wallets) {
      if (gate.Wallets[0].includes(wallet.address)) return null;
      throw new Error(`Only the wallets this names may ${what}.`);
    }
    // A farm's gate is a list of rules one NFT must all pass; any other gate one rule.
    const rules = Array.isArray(gate) ? gate : [gate.Holds ? gate.Holds[0] : gate];
    if (!rules.length) return null;
    const rule = rules[0];
    const atLeast = rule.test?.AtLeast?.[0];
    const equals = rule.test?.OneOf?.texts?.length === 1 ? rule.test.OneOf.texts[0] : undefined;
    const item = rule.of?.Item?.[0];
    const named = rules.map(r => r.of?.Collection?.[0]).find(c => c && !ours(c));
    const other = named ?? null;
    const passes = (r, c) => {
      if (r.of?.Item?.[0] !== undefined && c.itemId !== Number(r.of.Item[0])) return false;
      const value = c.attributes?.[r.key];
      if (r.test?.AtLeast?.[0] !== undefined) return Number(value) >= Number(r.test.AtLeast[0]);
      if (r.test?.OneOf?.texts)
        return r.test.OneOf.texts.map(String).includes(String(r.key === 'item_id' ? c.itemId : value));
      return true;
    };
    const pass = c => rules.every(r => passes(r, c));
    // A rule on the player's profile: the client passes the profile itself (`loot.shownFor`); here it is only read, to
    // say plainly when it falls short.
    if (loot.readsProfile(rule)) {
      const found = await client.account(loot.pda.profile(project, wallet.address));
      const attributes = Object.fromEntries(
        (loot.decodeProfile(found?.owner === loot.lootProgram() ? found.data : null)?.attributes ?? []).map(a => [
          a.key,
          a.value,
        ]),
      );
      if (passes(rule, { attributes })) return null;
      throw new Error(
        `You need ${rule.key} ${atLeast !== undefined ? `${atLeast} or more` : equals !== undefined ? equals : 'set'} on your profile to ${what}.`,
      );
    }
    if (other) {
      const found = await client.programAccounts(MPL_CORE, ownedAssetFilters(wallet.address, other));
      for (const { pubkey, account } of found) {
        const a = parseCoreAsset(account.data);
        if (pass({ attributes: { ...a.attributes, ...(await sheetOf(pubkey)) } })) return { asset: pubkey };
      }
      throw new Error(
        `You need an NFT of the collection ${other}${atLeast !== undefined ? ` with ${rule.key} ${atLeast} or more` : equals !== undefined ? ` whose ${rule.key} is ${equals}` : ''} to ${what}.`,
      );
    }
    const found = (await owned()).find(pass);
    if (found) return found.asset;
    const needs =
      item !== undefined
        ? `a ${(spec.items ?? []).find(it => it.id === Number(item))?.name ?? 'collectible of this project'}`
        : 'a collectible of this project';
    throw new Error(
      `You need ${needs}${atLeast !== undefined ? ` with ${rule.key} ${atLeast} or more` : equals !== undefined ? ` whose ${rule.key} is ${equals}` : ''} to ${what}.`,
    );
  }

  /**
   * For a list gate (`List`: a Merkle root of wallets, `sha256("loot-list-v1" | wallet)`), the proof that the player is
   * on it: `given` (as a page or a results server hands it over), or made from the wallets xsolana.json lists for the part
   * (`list`, its gate's `list`). Undefined for any other gate. Throws a plain sentence when the wallet is not on it.
   */
  function listProofOf(gate, list, given) {
    if (!gate?.List) return undefined;
    if (given) return given;
    if (!(list ?? []).includes(wallet.address)) throw new Error('This wallet is not on the list for this.');
    // The list as the plan wrote its root: filled to a power of two (`gateList`).
    return loot.gateList(list).proofOf(wallet.address);
  }
  Object.assign(ctx, { personFor, passing, listProofOf });

  return {
    /**
     * Writes an NFT's traits from the project's traits tree (`traits` in the spec) into its Sheet, where rules read them:
     * anyone may, paying the Sheet's rent. `attributes` ([{ key, value }]) and `proof` come from the project's tree
     * (`loot.traitsTree`); `key` names the tree (a collection's address), the spec's first when left out. Traits the
     * Sheet already has are left as they are.
     */
    async proveTraits(nft, attributes, proof, key = spec.traits?.[0]?.collection) {
      return ctx.send([loot.proveTraitsIx({ signer: wallet.address, project, key, nft, attributes, proof })]);
    },

    /**
     * Takes the link voucher the project's issuer signed for this wallet: { person (32 bytes or 64 hex characters),
     * expires, publicKey (the issuer's), signature } over `loot.linkBytes`. Nothing is sent now: the wallet's next step
     * that counts by person (a purchase, a ticket, a craft, a claim) links it in the same transaction.
     */
    link(voucher) {
      if (voucher.wallet && voucher.wallet !== wallet.address)
        throw new Error(`This link voucher is for ${voucher.wallet}, not this wallet (${wallet.address}).`);
      const person =
        typeof voucher.person === 'string'
          ? voucher.person.toLowerCase()
          : Array.from(voucher.person ?? [], x => x.toString(16).padStart(2, '0')).join('');
      if (!/^[0-9a-f]{64}$/.test(person) || /^0+$/.test(person))
        throw new Error('A link voucher names a person: 32 bytes, not all zeros.');
      if (!(Number(voucher.expires) > now()))
        throw new Error('This link voucher has expired: ask the server for a new one.');
      const signature = typeof voucher.signature === 'string' ? decodeBase58(voucher.signature) : voucher.signature;
      ctx.pendingLink = { ...voucher, person, signature };
    },
  };
}
