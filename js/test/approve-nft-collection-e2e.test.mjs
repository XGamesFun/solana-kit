// A raffle of an NFT in a collection of its own, named in the file with no collection: the approval reads the NFT's
// collection from the chain, moves it with that one, and the file says it once the step lands. Nothing for the owner to
// write.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { concat, fromBase64, toBase64, uintLE, utf8 } from '../chain/bytes.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM } from '../chain/core.js';
import { SYSTEM_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { newAddress } from '../sim/chain.mjs';
import { approvalChain, cannotRun, world } from './helpers/world.mjs';

const skip = cannotRun();

test(
  'a raffle NFT named with no collection is moved with the one the chain says, and the file says it',
  { skip: skip ?? false },
  async () => {
    const NOW = 1_790_000_000;
    const w = world({ project: false, seed: 'raffle-collection' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    // an artist's collection, and their NFT in it, held by the owner
    const collection = newAddress(w.random);
    w.chain.send(w.creator, [
      createCollectionInstruction({
        collection,
        creator: w.creator,
        project: loot.pda.project(w.creator, 0),
        name: 'Artist',
        uri: 'https://example.invalid/artist.json',
      }),
    ]);
    const nft = newAddress(w.random);
    const str = s => concat(uintLE(utf8(s).length, 4), utf8(s));
    w.chain.send(w.creator, [
      {
        programId: MPL_CORE_PROGRAM,
        keys: [
          meta(nft, true, true),
          meta(collection, false, true),
          meta(w.creator, true, false),
          meta(w.creator, true, true),
          meta(owner.address, false, false),
          meta(MPL_CORE_PROGRAM, false, false),
          meta(SYSTEM_PROGRAM, false, false),
          meta(MPL_CORE_PROGRAM, false, false),
        ],
        data: concat(Uint8Array.of(20, 0), str('Art'), str('https://example.invalid/a.json'), Uint8Array.of(0, 0)),
      },
    ]);
    const spec = {
      version: 2,
      network: 'devnet',
      name: 'R',
      currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }],
      collection: false,
      lotteries: [
        { key: 'art', name: 'Art', price: 0.01, rest: 'treasury', raffle: nft, firstDraw: '2027-01-01T00:00:00Z' },
      ],
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'raffle-collection-')), 'xsolana.json');
    writeFileSync(file, JSON.stringify(spec));
    const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
    for (let i = 0; i < 6 && !session.state().done; i++) {
      const batch = await session.prepare(owner.address);
      await session.complete(
        owner.address,
        batch.id,
        batch.transactions.map(b64 => {
          const t = readTransaction(fromBase64(b64));
          const s = [...t.signatures];
          s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
          return toBase64(wireTransaction(t.message, s));
        }),
      );
    }
    assert.equal(session.state().done, true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(after.lotteries[0].raffle, { nft, collection });
  },
);
