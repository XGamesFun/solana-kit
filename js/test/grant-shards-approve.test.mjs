// A live grant's claim records are split once (grant.rs ShardsFixed): an edit of its wallets, then another, goes live
// with the split the chain holds, which the approval reads; the file never carries it, so every kit still reads the file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { approvalChain, cannotRun, world } from './helpers/world.mjs';

const skip = cannotRun();

test(
  'a live grant’s wallets edited twice: each approval sends the split the chain holds',
  { skip: skip ?? false },
  async () => {
    const NOW = 1_790_000_000;
    const w = world({ project: false, seed: 'shards' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    const voucher = freshKeypair().address;
    const spec = {
      version: 2,
      network: 'devnet',
      name: 'S',
      currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }],
      collection: false,
      items: [{ key: 'gem', name: 'Gem', kind: 'normal', price: 0.01 }],
      grants: [
        {
          key: 'g',
          name: 'G',
          prize: { gives: 'item', item: 'gem' },
          vouchers: [voucher],
          trust: 'decides',
          limits: { perWallet: 1, perDay: 100 },
        },
      ],
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'shards-')), 'xsolana.json');
    writeFileSync(file, JSON.stringify(spec));
    const approve = async label => {
      const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
      try {
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
        assert.equal(session.state().done, true, label);
      } catch (e) {
        assert.fail(`${label}: ${e.message}`);
      }
    };
    await approve('go live');
    for (const wallets of [500_000, 900_000]) {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      s.grants[0].wallets = wallets;
      writeFileSync(file, JSON.stringify(s));
      await approve(`edit wallets=${wallets}`);
    }
    assert.ok(!readFileSync(file, 'utf8').includes('shardBits'));
  },
);
