// `xsolana handover`: a live project handed to a new owner by the program's update_project, signed by both key files.
// It shows what changes with a code and sends nothing; the code sends exactly that, and nothing else does. Run on the
// real program in LiteSVM, with no network.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { handover, HandoverError } from '../approve/handover.mjs';
import { makeKeyFile } from '../approve/keyfile.mjs';
import { approveWithKey } from '../approve/with-key.mjs';
import { approvalChain, cannotRun, world } from './helpers/world.mjs';

const skip = cannotRun();
const NOW = 1_790_000_000;
const folder = () => mkdtempSync(path.join(tmpdir(), 'xsolana-handover-'));
const example = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));

test(
  'a live project is handed to a new owner, signed by both keys, only with the code of what was shown',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'handover' });
    w.chain.warp(NOW);
    const file = path.join(folder(), 'xsolana.json');
    writeFileSync(file, JSON.stringify(example('level-ladder'), null, 2));
    const keyFile = path.join(folder(), 'owner.json');
    const toFile = path.join(folder(), 'next.json');
    const owner = await makeKeyFile(keyFile);
    const next = await makeKeyFile(toFile);
    w.chain.airdrop(owner.address, 100_000_000_000n);
    const chain = approvalChain(w);
    const live = await approveWithKey({ file, keyFile, chain, now: () => NOW, yes: true, out: () => {} });
    assert.equal(live.done, true);
    const { project } = JSON.parse(readFileSync(file, 'utf8')).live;
    const onChain = async () => loot.decode('Project', (await chain.account(project)).data);
    const before = await onChain();

    // Shown, nothing sent.
    const lines = [];
    const shown = await handover({ file, keyFile, toFile, chain, out: l => lines.push(l) });
    assert.equal(shown.sent, 0);
    assert.match(lines.join('\n'), new RegExp(`New owner: ${next.address}`));
    assert.match(lines.join('\n'), /Stay as they are: the authority .*, the treasury/);
    assert.match(lines.at(-1), new RegExp(`--yes ${shown.code}$`));
    assert.equal((await onChain()).owner, owner.address);

    // Another code, or the wrong key, sends nothing.
    await assert.rejects(handover({ file, keyFile, toFile, chain, yes: 'deadbeef', out: () => {} }), HandoverError);
    await assert.rejects(
      handover({ file, keyFile: toFile, toFile: keyFile, chain, out: () => {} }),
      /Only its owner's key hands it over/,
    );
    await assert.rejects(handover({ file, keyFile, toFile: keyFile, chain, out: () => {} }), /the same key/);
    assert.equal((await onChain()).owner, owner.address);

    // The code sends it: the new owner, the same authority, treasury and address.
    const sent = await handover({ file, keyFile, toFile, chain, yes: shown.code, out: () => {} });
    assert.equal(sent.sent, 1);
    const after = await onChain();
    assert.equal(after.owner, next.address);
    assert.deepEqual(
      [after.authority, after.treasury, after.creator],
      [before.authority, before.treasury, before.creator],
    );
    // (and the old key can hand it over no more)
    await assert.rejects(
      handover({ file, keyFile, toFile, chain, out: () => {} }),
      /Only its owner's key hands it over/,
    );
  },
);

test('a spec that is not live has no project to hand over', async () => {
  const file = path.join(folder(), 'xsolana.json');
  writeFileSync(file, JSON.stringify(example('level-ladder')));
  await assert.rejects(handover({ file, keyFile: 'a.json', toFile: 'b.json', out: () => {} }), /is not live/);
});
