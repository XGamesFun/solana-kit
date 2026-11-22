// An NFT a setup puts in a stash moves with the collection the spec names for it, or the game's: approving reads each
// Core NFT and moves one the spec places in another collection with the one the chain says, and the file says it from
// then on. An NFT in no collection moves with any (as the program took it in a test of its own); one that is not there
// is refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM } from '../chain/core.js';
import { meta } from '../chain/programs.js';
import { checkNfts, MintMismatch, withNftCollections } from '../approve/live-check.mjs';
import { model } from '../economy/model.mjs';
import { newAddress } from '../sim/chain.mjs';
import { approvalChain, cannotRun, world } from './world.mjs';

const skip = cannotRun();

test(
  'approving moves an NFT with the collection the chain says, takes one in no collection, refuses one not there',
  { skip: skip ?? false },
  async () => {
    const w = world({ seed: 'nft-collections' });
    const core = collection => {
      const asset = newAddress(w.random);
      const str = s => concat(uintLE(utf8(s).length, 4), utf8(s));
      const data = concat(Uint8Array.of(20, 0), str('Art'), str('https://example.invalid/a.json'), Uint8Array.of(0, 0));
      const keys = [
        meta(asset, true, true),
        meta(collection ?? MPL_CORE_PROGRAM, false, Boolean(collection)),
        meta(w.authority, true, false),
        meta(w.authority, true, true),
        meta(w.authority, false, false),
        meta(MPL_CORE_PROGRAM, false, false),
        meta(SYSTEM_PROGRAM, false, false),
        meta(MPL_CORE_PROGRAM, false, false),
      ];
      w.chain.send(w.authority, [{ programId: MPL_CORE_PROGRAM, keys, data }]);
      return asset;
    };
    const other = newAddress(w.random);
    w.chain.send(w.authority, [
      createCollectionInstruction({
        collection: other,
        creator: w.authority,
        project: w.project,
        name: 'Other',
        uri: 'https://example.invalid/o.json',
      }),
    ]);
    const chain = approvalChain(w);
    const spec = raffle => ({
      version: 2,
      network: 'devnet',
      name: 'T',
      currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }],
      lotteries: [{ key: 'art', name: 'Art', price: 0.01, rest: 'treasury', raffle, firstDraw: '2030-01-01' }],
    });
    const checked = raffle => checkNfts({ m: model(spec(raffle), { now: w.chain.now() }), chain });
    assert.deepEqual(await checked(core(null)), []);
    const theirs = core(other);
    assert.deepEqual(await checked({ nft: theirs, collection: other }), []);
    const said = await checked(theirs);
    assert.deepEqual(
      said.map(c => [c.nft, c.collection, c.said]),
      [[theirs, other, null]],
    );
    const { spec: fixed, lines } = withNftCollections(spec(theirs), said);
    assert.deepEqual(fixed.lotteries[0].raffle, { nft: theirs, collection: other });
    assert.match(lines[0], new RegExp(`is in the collection ${other}`));
    await assert.rejects(checked(newAddress(w.random)), e => e instanceof MintMismatch && /no NFT/.test(e.message));
  },
);

test(
  'approving refuses a change to what a live item is once a unit of it is issued, and takes it before',
  { skip: skip ?? false },
  async () => {
    const { checkItemLocks } = await import('../approve/live-check.mjs');
    const w = world({ seed: 'item-locks' });
    w.upsert({
      Item: {
        id: 1,
        args: {
          kind: 'Collectible',
          rarity: 0,
          soulbound: false,
          burnable: false,
          name: 'Hero',
          uri: 'https://example.invalid/h.json',
          max_supply: 0,
          active: true,
        },
      },
    });
    const chain = approvalChain(w);
    const hero = { key: 'hero', id: 1, name: 'Hero', price: 0.01 };
    const spec = now => ({
      version: 2,
      network: 'devnet',
      name: 'T',
      currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }],
      items: [{ ...hero, ...now }],
      live: { project: w.project, published: { items: [hero] } },
    });
    const locks = now => checkItemLocks({ m: model(spec(now), { now: w.chain.now() }), chain, project: w.project });
    await locks({ soulbound: true });
    w.make(1, w.player);
    await assert.rejects(
      locks({ soulbound: true }),
      e => e instanceof MintMismatch && /1 issued/.test(e.message) && /soulbound/.test(e.message),
    );
    await locks({ price: 0.02 });
  },
);

test('an NFT an earlier approval put in is not read again: given out and burned since, it blocks no later change', async () => {
  const { checkNfts } = await import('../approve/live-check.mjs');
  const gone = 'Gone111111111111111111111111111111111111111';
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'T',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    stashes: [{ key: 's', name: 'S', nfts: [gone] }],
  };
  const chain = { account: async () => null };
  await assert.rejects(checkNfts({ m: model(spec, { now: 0 }), chain }), /no NFT/);
  const live = { ...spec, live: { project: 'P', published: structuredClone(spec) } };
  await checkNfts({ m: model(live, { now: 0 }), chain });
});
