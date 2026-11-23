// A treasury trap: when the treasury is the owner's wrapped-SOL account, any wallet's "unwrap" closes it, and every
// later sale fails at settle. The treasury is by default a pool of the project's own, which no wallet can close: the
// owner buys from their own shop, unwraps, and later sales still settle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { associatedTokenAddress, NATIVE_MINT } from '../chain/pda.js';
import { solanaApp } from '../play/index.js';
import { goLive } from './helpers/live.mjs';
import { asWallet, cannotRun, world } from './helpers/world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

test(
  'the owner buys from their own shop and unwraps, and later sales still settle',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'treasury' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    const player = freshKeypair();
    for (const k of [owner, player]) w.chain.airdrop(k.address, 100_000_000_000n);
    const live = await goLive(w, owner, {
      version: 2,
      network: 'devnet',
      name: 'Treasury test',
      currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }],
      collection: { name: 'Treasury test' },
      items: [{ key: 'cat', name: 'Moon Cat', price: 0.003, supply: 300 }],
    });
    assert.equal(live.live.treasury, owner.address, 'the default treasury is the owner’s wallet');
    const treasury = associatedTokenAddress(owner.address, NATIVE_MINT);

    const mine = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(owner), now: () => w.chain.now() });
    assert.ok((await mine.buy('cat', { listing: (await mine.shop()).find(l => l.key === 'cat') })).asset);
    // Unwrapping closes the owner's wrapped-SOL account, the one sales pay into.
    await mine.unwrap();
    assert.equal(await w.chain.rpc.account(treasury), null);

    const theirs = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
    assert.ok(
      (await theirs.buy('cat', { listing: (await theirs.shop()).find(l => l.key === 'cat') })).asset,
      'a later sale settles',
    );
    assert.equal(
      await w.chain.rpc.tokenBalance(treasury),
      3_000_000n,
      'and opens the treasury’s account again to pay it',
    );
  },
);
