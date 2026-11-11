// A token's name on chain, changed after it is live: the spec's new name, ticker or link is written to its record
// (Token Metadata's UpdateMetadataAccountV2) at the next approve, signed by the owner, the record's update authority.
// A token that went live before setups named tokens has no record, and is said so instead. Through the approval
// page's own server, on the real programs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { checkLive, LiveMismatch } from '../approve/live-check.mjs';
import { createApproval } from '../approve/server.mjs';
import { addressBytes } from '../chain/base58.js';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { metadataAddress, metadataUpdateAuthority } from '../chain/metadata.js';
import { parseMint } from '../chain/mint.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, setAuthorityIx } from '../chain/token.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { changedParts, unnamedNote } from '../economy/live.mjs';
import { model } from '../economy/model.mjs';
import { plan } from '../economy/plan.mjs';
import { runTool } from '../mcp/server.mjs';
import { approvalChain, cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_790_000_000;
const LINK = 'https://example.invalid/token/bubl.json';
const SPEC = {
  version: 2,
  network: 'devnet',
  name: 'Renamed',
  currency: 'sol',
  tokens: [
    { key: 'sol', source: 'sol' },
    { key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL' },
    { key: 'gem', source: 'project', name: 'Gem', symbol: 'GEM', decimals: 6, supply: 1000 },
  ],
  collection: false,
};

const signAll = (wallet, wires) =>
  wires.map(b64 => {
    const t = readTransaction(fromBase64(b64));
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(wallet.address)] = wallet.sign(t.message);
    return toBase64(wireTransaction(t.message, sigs));
  });
async function approveAll(file, chain, owner) {
  const session = await createApproval({ file, chain, now: () => NOW });
  const before = session.state();
  for (let i = 0; i < 10 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
  }
  return { before, saved: JSON.parse(readFileSync(file, 'utf8')) };
}
function setup(spec) {
  const w = world({ project: false, seed: 'token-rename' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-rename-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  return { w, owner, file, chain: approvalChain(w, { send: async wire => w.chain.sendWire(wire) }) };
}
const named = (w, mint) => {
  const a = w.chain.get(mint);
  const record = w.chain.get(metadataAddress(mint));
  return { ...parseMint(mint, a.owner, a.data, record?.data ?? null), record };
};
const edit = (spec, key, change) => ({
  ...spec,
  tokens: spec.tokens.map(t => (t.key === key ? { ...t, ...change } : t)),
});

test(
  'a live token’s new name, ticker or link is written to its record at the next approve, and nothing else is sent',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup(SPEC);
    const { saved } = await approveAll(file, chain, owner);
    assert.deepEqual(saved.live.named, ['bubl', 'gem'], 'the file records which tokens the setup named');
    const bubl = saved.live.mints.bubl,
      gem = saved.live.mints.gem;
    assert.deepEqual([named(w, bubl).name, named(w, bubl).uri], ['Bubble', null]);
    assert.deepEqual(changedParts(saved), { only: new Set(), fixed: [], removed: [], settings: [], unnamed: [] });

    // BUBL gets its picture, and a longer name; GEM, whose minting is off for good, a new ticker
    const next = edit(edit(saved, 'bubl', { name: 'Bubble Day', uri: LINK }), 'gem', { symbol: 'GEMS' });
    assert.deepEqual([...changedParts(next).only], ['name:bubl', 'name:gem']);
    writeFileSync(file, JSON.stringify(next, null, 2));
    const { before, saved: after } = await approveAll(file, chain, owner);
    assert.equal(before.mode, 'change');
    assert.deepEqual(
      before.steps.map(s => s.id),
      ['name:bubl', 'name:gem'],
    );
    assert.match(
      before.steps[0].says,
      /Change what the token BUBL is called on chain to “Bubble Day”, BUBL, with the link https:\/\/example\.invalid\/token\/bubl\.json/,
    );
    const b = named(w, bubl),
      g = named(w, gem);
    assert.deepEqual([b.name, b.symbol, b.uri], ['Bubble Day', 'BUBL', LINK]);
    assert.deepEqual([g.name, g.symbol, g.mintAuthority, g.supply], ['Gem', 'GEMS', null, '1000000000']);
    assert.equal(b.mintAuthority, after.live.project, 'minting is still the project’s');
    assert.equal(metadataUpdateAuthority(b.record.data), owner.address, 'and the record still the owner’s to change');
    assert.equal(b.record.data.length, 607);
    assert.deepEqual(after.live.named, ['bubl', 'gem']);
    assert.deepEqual([after.live.mints.bubl, after.live.mints.gem], [bubl, gem], 'the same mints');
    // nothing more to publish; and a change of name costs a transaction, no rent and no fee to Token Metadata
    assert.equal(changedParts(after).only.size, 0);
    const priced = cost(next, { now: NOW, only: changedParts(next).only, live: next.live }).setup;
    assert.deepEqual([priced.accounts.length, priced.rentSol, priced.metadataFeesSol], [0, 0, 0]);
    const said = await runTool('xsolana_publish', { spec: next }, { now: NOW });
    assert.match(said.text, /Change what the token BUBL is called on chain/);

    // a name too long for the record is refused before anything is signed, on a live token too now that it is written
    const long = edit(after, 'bubl', { name: '🫧'.repeat(11) });
    assert.match(check(long, { now: NOW }).refusals.find(r => r.code === 'E-TOKEN').message, /44 bytes/);
    // taking the link out writes the record without one
    writeFileSync(file, JSON.stringify(edit(after, 'bubl', { uri: undefined }), null, 2));
    await approveAll(file, chain, owner);
    assert.equal(named(w, bubl).uri, null);
  },
);

test(
  'a token that went live before setups named tokens has no record: its new name sends nothing, and is said',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup(SPEC);
    const { saved } = await approveAll(file, chain, owner);
    // as a file written by an earlier release: no list of named tokens
    const { named: _, ...live } = saved.live;
    const old = edit({ ...saved, live }, 'bubl', { name: 'Bubble Day' });
    const change = changedParts(old);
    assert.deepEqual([[...change.only], change.unnamed], [[], ['bubl']]);
    assert.match(unnamedNote(change.unnamed), /bubl is called.*no name record, and none can be made now/);
    assert.ok(!plan(old, { now: NOW, only: change.only, live: old.live }).steps.length);
    writeFileSync(file, JSON.stringify(old, null, 2));
    const session = await createApproval({ file, chain, now: () => NOW });
    assert.ok(
      session.state().warnings.some(x => /went live before setups named tokens/.test(x)),
      session.state().warnings.join('\n'),
    );
    assert.equal(named(w, saved.live.mints.bubl).name, 'Bubble', 'unchanged on chain');
    // its labels are not held to a record's limits, as before
    assert.ok(check(edit({ ...saved, live }, 'bubl', { name: '🫧'.repeat(11) }), { now: NOW }).ok);
    assert.match(
      (await runTool('xsolana_publish', { spec: old }, { now: NOW })).text,
      /went live before setups named tokens/,
    );
  },
);

test(
  'a file that says a token is named when its mint has no record, or another’s record, is refused before anything is built',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
    const { saved } = await approveAll(file, chain, owner);
    const mint = saved.live.mints.bubl;
    // the record handed to someone else (the owner's own doing, outside these tools)
    const thief = freshKeypair();
    const record = w.chain.get(metadataAddress(mint));
    const handed = Uint8Array.from(record.data);
    handed.set(addressBytes(thief.address), 1);
    w.chain.put(metadataAddress(mint), { ...record, data: handed });
    writeFileSync(file, JSON.stringify(edit(saved, 'bubl', { name: 'Bubble Day' }), null, 2));
    const refused = await createApproval({ file, chain, now: () => NOW });
    await assert.rejects(refused.prepare(owner.address), /name record of the token BUBL .* not the project’s owner’s/);
    // a record handed on stops only its own rename: another change to the economy still goes through
    writeFileSync(file, JSON.stringify({ ...saved, pools: [{ key: 'pot', currency: 'sol' }] }, null, 2));
    const { before, saved: after } = await approveAll(file, chain, owner);
    assert.deepEqual(
      before.steps.map(s => s.id),
      ['pool:pot'],
    );
    assert.ok(after.pools[0].index !== undefined, 'the pool landed');
    // and a file that calls a token named whose mint has no record at all is not believed
    const bare = freshKeypair().address;
    w.chain.send(owner.address, [
      createAccountIx({
        from: owner.address,
        address: bare,
        lamports: w.chain.rent(MINT_BYTES),
        space: MINT_BYTES,
        owner: TOKEN_PROGRAM,
      }),
      initializeMint2Ix({ mint: bare, decimals: 0, authority: owner.address }),
      setAuthorityIx({ account: bare, current: owner.address, newAuthority: after.live.project }),
    ]);
    await assert.rejects(
      checkLive({
        live: { ...after.live, mints: { bubl: bare } },
        m: model(after),
        wallet: owner.address,
        chain: { account: async a => w.chain.get(a) ?? null },
      }),
      e => e instanceof LiveMismatch && /has no name record/.test(e.message),
    );
  },
);
