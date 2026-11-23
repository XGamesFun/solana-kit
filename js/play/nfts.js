// NFTs, for the page client (solanaApp): which collection one is in, who holds it, what kind it is (`nftOf`: a Core
// asset, a Token Metadata NFT or a compressed one) and the accounts that move it, whether the project still holds one,
// the proof that it is gone, and the player's own collectibles.
import { ownedAssetFilters, parseCoreAsset } from '../chain/core.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { MPL_CORE } from './common.js';

/** Adds to `ctx` what reads and moves an NFT: its kind, its holder, the proof it is gone; returns `collectibles`. */
export function addNfts(ctx) {
  const { spec, wallet, client, project, collections, ours } = ctx;

  const farmCollection = async asset => {
    const account = await client.account(asset);
    // Core tombstones and missing assets remain valid farm-cleanup paths.
    return account?.owner === MPL_CORE && account.data[0] === 1
      ? (parseCoreAsset(account.data).collection ?? collections[0])
      : collections[0];
  };
  /** The Core collection an asset is in, or null. */
  const collectionOf = async asset => {
    const account = await client.account(asset);
    return account?.owner === MPL_CORE && account.data[0] === 1
      ? (parseCoreAsset(account.data).collection ?? null)
      : null;
  };
  /** A Token Metadata NFT's { programmable, ruleSet } from its metadata, or null for anything else (a Core asset). */
  const tokenMetadataOf = async asset => {
    const account = await client.account(asset);
    if (account?.owner !== TOKEN_PROGRAM) return null;
    return loot.decodeTokenMetadata((await client.account(loot.tokenMetadata.metadata(asset)))?.data);
  };
  /**
   * Where a Token Metadata NFT handed to `holder` goes: { into, before }. Into their associated account (`into` null)
   * while it is not there (the program opens it) or takes it; when it is there but another key owns it or it is frozen,
   * Token Metadata refuses it and the hand-out would fail for everyone (an outbid NFT bid, a cancelled round's ticket),
   * so `payer` opens a fresh account of the holder's in the same transaction (`loot.freshNftAccount`) and it goes there.
   */
  async function nftInto(asset, holder, payer) {
    const own = await client.account(loot.ata(holder, asset));
    if (!own || loot.takesNft(own, holder, asset)) return { into: null, before: [] };
    // (the rent is the fixed one for 165 bytes, never the RPC's figure: the account is the holder's)
    for (let index = 0; index < loot.FRESH_NFT_ACCOUNTS; index++) {
      const { address } = loot.freshNftAccount({ payer, holder, mint: asset, index });
      // nothing there, only lamports someone sent there, or one opened before (a hand-out that did not land) that takes it
      const fresh = loot.freshNftAccount({ payer, holder, mint: asset, index, there: await client.account(address) });
      if (fresh) return { into: fresh.address, before: fresh.instructions };
    }
    throw new Error(
      `${holder}'s accounts of the NFT ${asset} can't take it (owned by another key, or frozen), and no fresh one could be opened.`,
    );
  }
  /**
   * What a route needs of an NFT, whatever its kind: { collection, hasAuthority, tokenMetadata, compressed, before }.
   * A compressed NFT (no account at its address) is read from the RPC's DAS methods (`getAsset`, `getAssetProof`),
   * which the page's RPC must offer, and proven first in the same transaction (`before`). `to`: the wallet the route
   * hands it to, when it hands it to one: a Token Metadata NFT then names the account it goes into (`nftInto`), a fresh
   * one opened by `payer` (the signer by default).
   */
  async function nftOf(asset, signer = wallet.address, { to, payer = signer } = {}) {
    const account = await client.account(asset);
    if (!account) {
      const das = await client.call('getAsset', { id: asset }).catch(() => null);
      if (das?.compression?.compressed) {
        const proof = await client.call('getAssetProof', { id: asset });
        const tree = await client.account(das.compression.tree);
        const compressed = loot.compressedFromDas({ asset: das, proof, treeData: tree.data });
        return {
          compressed,
          hasAuthority: false,
          before: [computeUnitLimit(1_000_000), loot.proveLeafIx({ signer, compressed })],
        };
      }
    }
    const tokenMetadata = await tokenMetadataOf(asset);
    // A Token Metadata mint is taken only as an NFT: one token, no decimals, none more ever minted (NotAnNft).
    if (tokenMetadata && account && !loot.isNftMint(asset, account.data))
      throw new Error(
        `${asset} is a semi-fungible item (several units, or a mint that can still mint): only an NFT is taken.`,
      );
    const { into, before } = tokenMetadata && to ? await nftInto(asset, to, payer) : { into: null, before: [] };
    return {
      collection: await farmCollection(asset),
      hasAuthority: ours(await collectionOf(asset)),
      tokenMetadata: tokenMetadata && into ? { ...tokenMetadata, into } : tokenMetadata,
      before: tokenMetadata ? [computeUnitLimit(400_000), ...before] : [],
    };
  }
  /** Whether a Core asset's account shows the project holds it: held by another, or burned (one byte left), it is gone. */
  const coreHeld = account => account.data[0] === 1 && parseCoreAsset(account.data).owner === project;
  /**
   * Whether the project still holds `asset`, as the program reads it (`piece::held`): { held, evidence, das }. A Core
   * asset by its owner (one burned is gone); a Token Metadata NFT by the project's token account of it, and when that
   * holds none, by the account that holds it now or by its mint when it was burned (`evidence`, what shows it gone); a
   * compressed NFT by the RPC's DAS record of it (`das`, proven again on chain before anything relies on it). `held` is
   * null when nothing shows either way. `holder`: a wallet thought to hold it now (a player handing it in), whose own
   * token account is read before any search.
   */
  async function heldNow(asset, { holder = null } = {}) {
    const account = await client.account(asset);
    if (account?.owner === MPL_CORE) return { held: coreHeld(account) };
    if (account?.owner === TOKEN_PROGRAM) {
      const u64 = (data, at) => new DataView(data.buffer, data.byteOffset).getBigUint64(at, true);
      const amount = data => (data?.length >= 72 ? u64(data, 64) : 0n);
      if (amount((await client.account(loot.ata(project, asset)))?.data) === 1n) return { held: true };
      // Burned: its mint holds none.
      if (account.data.length >= 44 && u64(account.data, 36) === 0n) return { held: false, evidence: asset };
      const own = holder ? loot.ata(holder, asset) : null;
      if (own && amount((await client.account(own))?.data) === 1n) return { held: false, evidence: own };
      const found = await client.programAccounts(TOKEN_PROGRAM, [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: asset } },
      ]);
      const now = found.find(x => amount(x.account.data) === 1n);
      return now ? { held: false, evidence: now.pubkey } : { held: null };
    }
    if (account) return { held: null };
    const das = await client.call('getAsset', { id: asset }).catch(() => null);
    if (!das?.compression?.compressed) return { held: null };
    // DAS says a burned NFT at the asset's top level (`burnt`).
    const burnt = das.burnt === true || das.compression.burnt === true;
    return { held: !burnt && das.ownership?.owner === project, das };
  }
  /** `heldNow` of several NFTs: the Core assets from one read of them all, any other kind one by one. By asset. */
  async function heldEach(assets) {
    const unique = [...new Set(assets)];
    const found = unique.length ? await client.accounts(unique) : [];
    const out = new Map();
    for (const [i, asset] of unique.entries())
      out.set(asset, found[i]?.owner === MPL_CORE ? { held: coreHeld(found[i]) } : await heldNow(asset));
    return out;
  }
  /**
   * What proves `asset` gone from the project, as the instruction that lets go of it takes it (a record whose NFT is
   * proven gone closes): { before, kind }, or null when the project still holds it or nothing shows either
   * way. Whoever controls a collection the project does not can take an NFT out of the project's hands or burn it. A
   * Core asset shows it by itself (`kind`: its collection now); a Token Metadata NFT by the token account that holds it
   * now, or its mint once burned (`kind.tokenMetadata.evidence`); a compressed NFT by its record, proven again as its
   * leaf is now (`before`, by `signer`). `holder`: as `heldNow` takes it. `now`: what `heldNow` read of it already.
   */
  async function goneProof(asset, signer = wallet.address, { holder = null, now = null } = {}) {
    now ??= await heldNow(asset, { holder });
    if (now.held !== false) return null;
    if (now.das) {
      const proof = await client.call('getAssetProof', { id: asset });
      const tree = await client.account(now.das.compression.tree);
      const compressed = loot.compressedFromDas({ asset: now.das, proof, treeData: tree.data });
      return { before: [computeUnitLimit(1_000_000), loot.proveLeafIx({ signer, compressed })], kind: { compressed } };
    }
    if (now.evidence)
      return { before: [], kind: { tokenMetadata: { programmable: false, ruleSet: null, evidence: now.evidence } } };
    return { before: [], kind: { collection: (await collectionOf(asset)) ?? MPL_CORE } };
  }
  /**
   * An NFT a record of the project's is to send on (`nftOf`, to `to`), or, when it is proven gone from the project
   * (`goneProof`), what shows that, with `gone` true: the instruction then finishes without it and nothing is sent.
   * `now`: what `heldNow` read of it already.
   */
  async function leaving(asset, signer = wallet.address, { to, payer = signer, now = null } = {}) {
    const proof = await goneProof(asset, signer, { now });
    if (!proof) return { ...(await nftOf(asset, signer, { to, payer })), gone: false };
    // A Core asset shows it by itself, with the accounts it always took.
    if (!proof.kind.tokenMetadata && !proof.kind.compressed) return { ...(await nftOf(asset, signer)), gone: true };
    return { before: proof.before, hasAuthority: false, ...proof.kind, gone: true };
  }
  /**
   * The release of a hold a route just made of `asset`, an NFT it owed and could only hand out (`kind`: from
   * `leaving`). The program makes such a hold at `["hold", asset, 0]` for `player`, the route's `signer` paying its
   * rent and `rentTo` named for its NFT's account's (`hold::owe`). The release right after it, by the same signer,
   * ends it: for an NFT proven gone from the project it closes the hold on the proof and nothing is sent (`NftGone`);
   * for any other it sends the NFT on to `player` (`Released`). Either way the hold's rent comes back to the signer.
   * `g`: the project, for a hold owed to the treasury.
   */
  const releaseOwed = (asset, kind, { player, rentTo }, signer, g) =>
    loot.releaseIx({
      signer,
      project,
      asset,
      ...kind,
      hold: { player, payer: signer, rent_to: rentTo, free_at: 0n },
      address: loot.pda.hold(asset, 0),
      treasury: g.treasury,
    });

  const itemKeyOf = id => (spec.items ?? []).find(it => it.id === Number(id))?.key ?? null;
  /** Who holds a collectible now. */
  const ownerOf = async asset => parseCoreAsset((await client.account(asset)).data).owner;
  /** The player's collectibles of this project (in any of its collections), each with the item it is (its "item_id" attribute). */
  async function owned(owner = wallet?.address) {
    const found = (
      await Promise.all(collections.map(c => client.programAccounts(MPL_CORE, ownedAssetFilters(owner, c))))
    ).flat();
    return found.map(({ pubkey, account }) => {
      const a = parseCoreAsset(account.data);
      const itemId = a.attributes?.item_id !== undefined ? Number(a.attributes.item_id) : null;
      return { asset: pubkey, ...a, itemId, item: itemId === null ? null : itemKeyOf(itemId) };
    });
  }

  /** An NFT's kind as a route's `ticket` or `nft` takes it: without its asset. */
  const kindOnly = ({ asset: _, ...kind }) => kind;

  /** Who holds each collectible a split's holder shares name now: { asset: holder }. */
  async function holdersOf(shares) {
    const holders = {};
    for (const s of shares) if (s.to.Holder) holders[s.to.Holder[0]] = await ownerOf(s.to.Holder[0]).catch(() => null);
    return holders;
  }
  Object.assign(ctx, {
    collectionOf,
    nftOf,
    coreHeld,
    heldNow,
    heldEach,
    goneProof,
    leaving,
    releaseOwed,
    ownerOf,
    owned,
    kindOnly,
    holdersOf,
  });

  return {
    /** The player's collectibles of this project: [{ asset, item, itemId, name, uri, attributes, frozen }]. `item` is its key in the spec. */
    collectibles: owned,
  };
}
