// The three kinds of NFT whose collection's controller can take them out of the project's hands, for the tests of a
// record whose NFT is gone: a Core asset its controller really takes or burns (`gone-chain.mjs`), a compressed NFT the
// same way through Bubblegum (`cnft-chain.mjs`), and a Token Metadata NFT whose token is moved by hand, as only its own
// program could. Each makes a world of its own and answers the same few calls, so one test runs for every kind.
import assert from 'node:assert/strict';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cnftTree, onChainRoot } from './cnft-chain.mjs';
import { burn, coreOwner, seizingAsset, seizingCollection, takeBack } from './gone-chain.mjs';
import { nftOf as tmNft, setup as tmSetup } from './tm-chain.mjs';
import { cannotRun, cannotRunCompressed, world } from './world.mjs';

export const skip = cannotRun() ?? false;
export const skipCompressed = cannotRunCompressed() ?? false;

export const FEE = 5_000n;
export const lamports = (w, address) => BigInt(w.chain.get(address)?.lamports ?? 0);
export const names = tx => tx.receipts.map(r => r.name);
export const receipt = (tx, name) => tx.receipts.find(r => r.name === name)?.data;
/** Every receipt called `name` in the transactions `txs`, in order. */
export const receiptsOf = (txs, name) =>
  [txs]
    .flat()
    .flatMap(tx => tx.receipts)
    .filter(r => r.name === name)
    .map(r => r.data);

/** A wire transaction with a signature of its own in its first slot (the local chain checks none), so each one this
 * wallet sends is found again by its signature. */
let signatures = 0;
function signed(wire) {
  const out = Uint8Array.from(wire);
  out.fill(0, 1, 65);
  out.set(new Uint8Array(new BigUint64Array([BigInt(++signatures)]).buffer), 1);
  return out;
}

/** The play module for `address` on world `w`, with `wallet` its address and `calls.prompts` what its wallet signed;
 * `rpc`: one that answers an indexer's calls too, for a compressed NFT's tree; `spec`: the parts of the economy the
 * page names (its lotteries, its auctions). */
export function appOf(w, address, { rpc = w.chain.rpc, spec = {} } = {}) {
  const calls = { prompts: 0 };
  const app = solanaApp({
    spec: {
      version: 2,
      currency: 'coin',
      tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }],
      live: { project: w.project, collection: w.collection },
      ...spec,
    },
    rpc,
    wallet: { address, signTransaction: async wire => (calls.prompts++, signed(wire)) },
    now: () => w.chain.now(),
  });
  return Object.assign(app, { calls, wallet: address });
}

/** A world with a collection its `controller` can take NFTs back out of, which the project does not control. */
export function fixture(seed, options = {}) {
  const w = world({ seed, ...options });
  const controller = w.who();
  const collection = seizingCollection(w, controller, { compressed: options.compressed });
  const mint = owner => seizingAsset(w, controller, collection, owner);
  return { w, controller, collection, mint, landed: w.watch() };
}

/** A Token Metadata NFT the project holds leaves its token account, as only its own program could move it: into an
 * account of `to`'s (returned), or, burned, out of existence (its mint, holding none, returned). */
export function takeTokenMetadata(w, mint, to, { burned = false } = {}) {
  const held = loot.ata(w.project, mint);
  const account = w.chain.get(held);
  const emptied = Uint8Array.from(account.data);
  emptied.fill(0, 64, 72);
  w.chain.put(held, { ...account, data: emptied });
  if (burned) {
    const m = w.chain.get(mint);
    const supply = Uint8Array.from(m.data);
    supply.fill(0, 36, 44);
    w.chain.put(mint, { ...m, data: supply });
    return mint;
  }
  const theirs = loot.ata(to, mint);
  const moved = Uint8Array.from(account.data);
  moved.set(addressBytes(to), 32);
  w.chain.put(theirs, { ...account, data: moved });
  return theirs;
}

/** What `signature` left in the log, as the chain recorded it. */
export const logged = (landed, signature) => {
  const tx = landed.find(r => r.id === signature);
  assert.ok(tx, `no landed transaction ${signature}`);
  return tx;
};

/**
 * Each kind of NFT, on a world of its own (`make(seed)`): { w, landed, collection (what a rule names), rule, rpc,
 * mint(owner), lose(nft, burned) (its controller takes it out of whoever's hands it is in, or burns it), regain(nft,
 * to) (its controller gives one it took to `to`), still(nft)
 * (fails unless the NFT is where its controller left it: nothing moved it since), holds(nft) (whether the project
 * holds it), owner(nft) (who holds it now, null once burned), into(nft, to) (a compressed NFT's leaf went to `to` on
 * chain: the indexer is told; nothing for the others), piece(nft, signer) (its kind as a builder takes it, and what goes
 * before), send(signer, nft, build), app(address, spec) (the play module on that world) }.
 */
export const KINDS = [
  {
    name: 'Core',
    key: 'core',
    skip,
    make(seed) {
      const { w, controller, collection, mint, landed } = fixture(seed);
      const lost = new Map();
      return {
        w,
        landed,
        collection,
        rpc: w.chain.rpc,
        mint,
        lose(nft, burned = false) {
          if (burned) burn(w, controller, collection, nft);
          else takeBack(w, controller, collection, nft);
          lost.set(nft, burned ? null : controller);
        },
        regain: (nft, to) => (takeBack(w, controller, collection, nft, to), nft),
        still: nft => assert.equal(coreOwner(w, nft), lost.get(nft), `${nft} is where its controller left it`),
        holds: nft => coreOwner(w, nft) === w.project,
        owner: nft => coreOwner(w, nft),
        into: () => {},
        piece: () => ({ before: [], kind: { collection, hasAuthority: false } }),
      };
    },
  },
  {
    name: 'Token Metadata',
    key: 'tokenMetadata',
    skip,
    make(seed) {
      const { w, maker, club } = tmSetup(seed);
      const lost = new Map();
      const supply = nft => {
        const { data } = w.chain.get(nft);
        return new DataView(data.buffer, data.byteOffset).getBigUint64(36, true);
      };
      return {
        w,
        landed: w.watch(),
        collection: club,
        rpc: w.chain.rpc,
        mint: owner => tmNft(w, maker, owner, club),
        lose: (nft, burned = false) => lost.set(nft, takeTokenMetadata(w, nft, w.who(), { burned })),
        regain(nft, to) {
          const from = w.chain.get(lost.get(nft));
          const [moved, emptied] = [Uint8Array.from(from.data), Uint8Array.from(from.data)];
          moved.set(addressBytes(to), 32);
          emptied.fill(0, 64, 72);
          w.chain.put(loot.ata(to, nft), { ...from, data: moved });
          w.chain.put(lost.get(nft), { ...from, data: emptied });
          return nft;
        },
        still(nft) {
          assert.equal(w.chain.tokens(loot.ata(w.project, nft)), 0n, 'the project holds none');
          if (lost.get(nft) === nft) assert.equal(supply(nft), 0n, 'burned: its mint holds none');
          else assert.equal(w.chain.tokens(lost.get(nft)), 1n, `${nft} is in the account its controller moved it to`);
        },
        holds: nft => w.chain.tokens(loot.ata(w.project, nft)) === 1n,
        owner: nft => [...holdersOf(w, nft)][0] ?? null,
        into: () => {},
        piece: () => ({
          before: [computeUnitLimit(400_000)],
          kind: { tokenMetadata: { programmable: false, ruleSet: null } },
        }),
      };
    },
  },
  {
    name: 'compressed',
    key: 'compressed',
    skip: skipCompressed,
    make(seed) {
      const { w, controller, collection, landed } = fixture(seed, { compressed: true });
      const tree = cnftTree(w, { maker: controller, collection });
      return {
        w,
        landed,
        collection,
        rpc: tree.rpc,
        tree,
        mint: owner => tree.mint(owner),
        lose: (nft, burned = false) => (burned ? tree.burn(nft, controller) : tree.take(nft, controller)),
        regain: (nft, to) => (tree.take(nft, controller, to), nft),
        // The indexer was told of nothing since: the tree's root on chain is still the one it mirrors.
        still: () => assert.deepEqual(onChainRoot(w, tree), tree.root(), 'no leaf moved since'),
        holds: nft => !tree.nfts.get(nft).burnt && tree.nfts.get(nft).owner === w.project,
        owner: nft => (tree.nfts.get(nft).burnt ? null : tree.nfts.get(nft).owner),
        into: (nft, to = w.project) => tree.moved(nft, to),
        piece: (nft, signer) => ({
          before: [computeUnitLimit(1_400_000), loot.proveLeafIx({ signer, compressed: tree.compressed(nft) })],
          kind: { compressed: tree.compressed(nft) },
        }),
      };
    },
  },
].map(kind => ({
  ...kind,
  make(seed) {
    const made = kind.make(`${seed}-${kind.key}`);
    return {
      ...made,
      rule: { of: { Collection: [made.collection] }, key: '', test: 'Any' },
      app: (address, spec) => appOf(made.w, address, { rpc: made.rpc, spec }),
      /** `signer` sends the instruction `build` makes of `nft`'s kind (`piece` takes it), a compressed one proven first. */
      send(signer, nft, build) {
        const { before, kind: piece } = made.piece(nft, signer);
        return made.w.chain.send(signer, loot.withLeafCloses([...before, build(piece)]));
      },
    };
  },
}));

/** The wallets whose token accounts hold the one token of a Token Metadata NFT now (one, or none once burned). */
function* holdersOf(w, mint) {
  for (const { data } of w.chain.svm.getProgramAccounts(TOKEN_PROGRAM))
    if (
      data.length === 165 &&
      encodeBase58(data.subarray(0, 32)) === mint &&
      new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) === 1n
    )
      yield encodeBase58(data.subarray(32, 64));
}
