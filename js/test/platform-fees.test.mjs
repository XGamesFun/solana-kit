// The tools quote the fees at this release (model.mjs FEES_ON); what reads the chain (approve, status) reads the
// platform account too and says when the program charges, or will charge, other fees. On the real program in LiteSVM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { platformFees } from '../approve/platform-fees.mjs';
import { FEES_ON } from '../economy/model.mjs';
import { cannotRun, world } from './helpers/world.mjs';

const skip = cannotRun();
const NOW = 1_790_000_000;

test(
  'the platform’s fees are read from the chain and compared with the ones the tools quote',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'platform-fees' });
    w.chain.warp(NOW);
    const read = address => w.chain.rpc.account(address);
    // As at release: nothing to say.
    const same = await platformFees(read, { now: NOW });
    assert.equal(same.differs, false);
    assert.equal(same.words, null);
    assert.equal(same.fees.playerSol, Number(FEES_ON.devnet.player) / 1e9);

    // A cut applies at once: the tools' quote is now off, and said so.
    w.chain.send(w.admin, [loot.setPlatformIx({ admin: w.admin, fees: { player: 1_000_000n, project: 10_000n } })]);
    const cut = await platformFees(read, { now: NOW });
    assert.equal(cut.differs, true);
    assert.match(cut.words, /The platform charges a player fee of 0\.001 SOL .* where these tools quote 0\.002/);

    // A raise waits 7 days: said, with when it applies.
    w.chain.send(w.admin, [loot.setPlatformIx({ admin: w.admin, fees: { player: 3_000_000n, project: 10_000n } })]);
    const raise = await platformFees(read, { now: NOW });
    assert.ok(raise.pending, JSON.stringify(raise));
    assert.match(
      raise.words,
      /A fee change waits on the platform: from \d{4}-\d{2}-\d{2}T.*a player fee of 0\.003 SOL/,
    );
  },
);
