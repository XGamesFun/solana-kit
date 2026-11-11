// A token's name on chain, changed after it is live: the spec's new name, ticker or link is written to its record
// (Token Metadata's UpdateMetadataAccountV2) at the next approve, signed by the owner, the record's update authority.
// Which tokens have a record their owner can change is read from the chain as the change is approved, never taken
// from the file: one with no record (it went live before setups named tokens), or a record handed on, made
// unchangeable or given a royalty or creators, is said so and nothing is sent for it; the file never calls such a
// name published. Through the approval page's own server, on the real programs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { readRenames } from '../approve/live-check.mjs';
import { createApproval } from '../approve/server.mjs';
import { addressBytes } from '../chain/base58.js';
import { concat, fromBase64, toBase64, uintLE, utf8 } from '../chain/bytes.js';
import { metadataAddress, parseRecord } from '../chain/metadata.js';
import { parseMint } from '../chain/mint.js';
import { METAPLEX_METADATA_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, setAuthorityIx } from '../chain/token.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { changedParts, renamesNote } from '../economy/live.mjs';
import { model } from '../economy/model.mjs';
import { runTool } from '../mcp/server.mjs';
import { pda } from '../client/pda.js';
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
/** `fails`: the number of a send (1, 2, …) that fails as a devnet RPC error would, while `fails.on` is true. */
function setup(spec, { fails = null } = {}) {
  const w = world({ project: false, seed: 'token-rename' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-rename-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  let sends = 0;
  const chain = approvalChain(w, {
    send: async wire => {
      sends++;
      if (fails?.on && sends === fails.send)
        throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
      return w.chain.sendWire(wire);
    },
  });
  return { w, owner, file, chain };
}
/** A mint as a setup before 0.26.2 left it: the project's to mint, with no name record. */
function bareMint(w, owner, project) {
  const mint = freshKeypair().address;
  w.chain.send(owner.address, [
    createAccountIx({
      from: owner.address,
      address: mint,
      lamports: w.chain.rent(MINT_BYTES),
      space: MINT_BYTES,
      owner: TOKEN_PROGRAM,
    }),
    initializeMint2Ix({ mint, decimals: 0, authority: owner.address }),
    setAuthorityIx({ account: mint, current: owner.address, newAuthority: project }),
  ]);
  return mint;
}
/** The record of `mint` with some of its bytes changed, as its owner could have left it outside these tools. */
function alterRecord(w, mint, change) {
  const record = w.chain.get(metadataAddress(mint));
  const data = Uint8Array.from(record.data);
  change(data);
  w.chain.put(metadataAddress(mint), { ...record, data });
}
const warned = (state, pattern) => state.warnings.some(x => pattern.test(x));
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
    assert.equal(saved.live.named, undefined, 'the file keeps no list of named tokens: the chain says');
    const bubl = saved.live.mints.bubl,
      gem = saved.live.mints.gem;
    assert.deepEqual([named(w, bubl).name, named(w, bubl).uri], ['Bubble', null]);
    assert.deepEqual(changedParts(saved), { only: new Set(), fixed: [], removed: [], settings: [], renames: [] });

    // BUBL gets its picture, and a longer name; GEM, whose minting is off for good, a new ticker
    const next = edit(edit(saved, 'bubl', { name: 'Bubble Day', uri: LINK }), 'gem', { symbol: 'GEMS' });
    const change = changedParts(next);
    assert.deepEqual([[...change.only], change.renames], [[], ['bubl', 'gem']]);
    writeFileSync(file, JSON.stringify(next, null, 2));
    const { before, saved: after } = await approveAll(file, chain, owner);
    assert.equal(before.mode, 'change');
    assert.deepEqual(
      before.steps.map(s => s.id),
      ['name:bubl', 'name:gem'],
    );
    assert.ok(
      before.steps[0].says.startsWith(
        `Change what the token BUBL (mint ${bubl}) is called on chain to “Bubble Day”, BUBL, with the link ${LINK}`,
      ),
      before.steps[0].says,
    );
    // (a token is named by the ticker it was published with: the new one is what it is changed to)
    assert.ok(
      before.steps[1].says.startsWith(`Change what the token GEM (mint ${gem}) is called on chain to “Gem”, GEMS,`),
      before.steps[1].says,
    );
    const b = named(w, bubl),
      g = named(w, gem);
    assert.deepEqual([b.name, b.symbol, b.uri], ['Bubble Day', 'BUBL', LINK]);
    assert.deepEqual([g.name, g.symbol, g.mintAuthority, g.supply], ['Gem', 'GEMS', null, '1000000000']);
    assert.equal(b.mintAuthority, after.live.project, 'minting is still the project’s');
    assert.deepEqual(
      parseRecord(b.record.data),
      {
        updateAuthority: owner.address,
        mint: bubl,
        name: 'Bubble Day',
        symbol: 'BUBL',
        uri: LINK,
        royalty: 0,
        creators: 0,
        mutable: true,
        collection: false,
        uses: false,
        plain: true,
      },
      'the record is still the owner’s to change, and nothing else of it changed',
    );
    assert.equal(b.record.data.length, 607);
    assert.deepEqual([after.live.mints.bubl, after.live.mints.gem], [bubl, gem], 'the same mints');
    assert.ok(!after.live.partial && !after.live.landed, 'the file is live, with nothing left over');
    // nothing more to publish; and a change of name costs a transaction, no rent and no fee to Token Metadata
    assert.deepEqual([changedParts(after).only.size, changedParts(after).renames], [0, []]);
    // (loot is not called, so its project fee is not charged: the network's fee for one signature, and the
    // transaction's own priority fee of 2 lamports, are all)
    const priced = cost(next, { now: NOW, ...change, live: next.live }).setup;
    assert.deepEqual(
      [priced.accounts.length, priced.rentSol, priced.metadataFeesSol, priced.programFeesSol, priced.totalSol],
      [0, 0, 0, 0, 0.000005002],
    );
    // a tool that does not read the chain says what approving will do, and that it reads the record first
    const said = await runTool('xsolana_publish', { spec: next }, { now: NOW });
    assert.equal(said.transactions, 1);
    assert.match(said.text, /at most 1 transaction, 1 wallet approval, about 0\.000005002 SOL/);
    assert.match(
      said.text,
      /Change what the token BUBL \(mint \w+\) is called on chain.*\(sent only if the token has a name record its owner can still change, read when approving\)/,
    );
    assert.ok(said.text.includes(renamesNote(['bubl', 'gem'])), said.text);
    const priceSaid = (await runTool('xsolana_cost', { spec: next }, { now: NOW })).text;
    assert.match(priceSaid, /prices only the change \(the name of bubl, the name of gem\)/);
    assert.match(priceSaid, /program fees 0 SOL/);
    assert.ok(priceSaid.includes(renamesNote(['bubl', 'gem'])), priceSaid);

    // a name too long for the record is refused before anything is signed, on a live token too now that it is written
    const long = edit(after, 'bubl', { name: '🫧'.repeat(11) });
    assert.match(check(long, { now: NOW }).refusals.find(r => r.code === 'E-TOKEN').message, /44 bytes/);
    // taking the link out writes the record without one
    writeFileSync(file, JSON.stringify(edit(after, 'bubl', { uri: undefined }), null, 2));
    await approveAll(file, chain, owner);
    assert.equal(named(w, bubl).uri, null);
  },
);

test('the same names spelled out, or a record already saying them, send nothing', { skip }, async () => {
  // a token with no name or ticker of its own goes live as its key
  const { w, owner, file, chain } = setup({ ...SPEC, tokens: [SPEC.tokens[0], { key: 'dust', source: 'project' }] });
  const { saved } = await approveAll(file, chain, owner);
  const dust = saved.live.mints.dust;
  assert.deepEqual([named(w, dust).name, named(w, dust).symbol], ['dust', 'DUST']);
  // …and writing those out changes nothing
  const spelled = edit(saved, 'dust', { name: 'dust', symbol: 'DUST' });
  assert.deepEqual(changedParts(spelled).renames, []);
  writeFileSync(file, JSON.stringify(spelled, null, 2));
  const session = await createApproval({ file, chain, now: () => NOW });
  const state = await session.stateFor(owner.address);
  assert.deepEqual([state.steps.length, state.done], [0, true]);

  // a record that says the new name already (changed in another tool, or by a session whose file was lost)
  const next = edit(saved, 'dust', { name: 'Dust' });
  const made = Uint8Array.from(w.chain.get(metadataAddress(dust)).data);
  alterRecord(w, dust, data => data.set(new TextEncoder().encode('Dust'), 65 + 4));
  assert.equal(parseRecord(w.chain.get(metadataAddress(dust)).data).name, 'Dust');
  writeFileSync(file, JSON.stringify(next, null, 2));
  const again = await createApproval({ file, chain, now: () => NOW });
  assert.deepEqual(
    again.state().steps.map(s => s.id),
    ['name:dust'],
    'before a wallet connects, the file alone says what changed',
  );
  const read = await again.stateFor(owner.address);
  assert.deepEqual([read.steps.length, read.done, read.warnings.filter(x => /called/.test(x))], [0, true, []]);
  w.chain.put(metadataAddress(dust), { ...w.chain.get(metadataAddress(dust)), data: made });
});

test(
  'a token that went live before setups named tokens has no record: its new name sends nothing, and is said',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
    const { saved } = await approveAll(file, chain, owner);
    // as an earlier release left it: the file's mint is the project's to mint, and nothing names it on chain
    const bare = bareMint(w, owner, saved.live.project);
    // (lamports sent to where its record would be are not a record)
    w.chain.airdrop(metadataAddress(bare), 1_000_000n);
    const old = { ...saved, live: { ...saved.live, mints: { bubl: bare } } };
    const next = edit(old, 'bubl', { name: 'Bubble Day' });
    assert.deepEqual(changedParts(next).renames, ['bubl'], 'the file can’t tell: the chain is asked');
    writeFileSync(file, JSON.stringify(next, null, 2));
    const session = await createApproval({ file, chain, now: () => NOW });
    const state = await session.stateFor(owner.address);
    assert.deepEqual([state.steps.length, state.done], [0, true]);
    assert.ok(
      warned(state, /BUBL is called, but it went live before setups named tokens.*Nothing is sent for it/),
      state.warnings.join('\n'),
    );
    // the page shows it by itself, done or not (`unwritten`), and the file is as it was
    assert.deepEqual(
      state.unwritten,
      state.warnings.filter(x => /went live before setups named tokens/.test(x)),
    );
    assert.equal(state.unwritten.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), next);
    assert.equal(w.chain.get(metadataAddress(bare)).data.length, 0, 'nothing written');
    // a change beside it goes through; the file never calls the name published, so it is said again at each approve
    // until the spec gives the old one back
    writeFileSync(file, JSON.stringify({ ...next, pools: [{ key: 'pot', currency: 'sol' }] }, null, 2));
    const { before, saved: after } = await approveAll(file, chain, owner);
    assert.deepEqual(
      before.steps.map(s => s.id).filter(id => !id.startsWith('name:')),
      ['pool:pot'],
    );
    assert.ok(after.pools[0].index !== undefined && !after.live.partial, 'the pool landed, and the file is not stuck');
    assert.deepEqual(
      [after.tokens.find(t => t.key === 'bubl').name, after.live.published.tokens.find(t => t.key === 'bubl').name],
      ['Bubble Day', 'Bubble'],
      'published as the chain has it',
    );
    assert.deepEqual([[...changedParts(after).only], changedParts(after).renames], [[], ['bubl']]);
    const later = await (await createApproval({ file, chain, now: () => NOW })).stateFor(owner.address);
    assert.deepEqual([later.steps.length, later.done, later.unwritten.length], [0, true, 1]);
    writeFileSync(file, JSON.stringify(edit(after, 'bubl', { name: 'Bubble' }), null, 2));
    const back = await (await createApproval({ file, chain, now: () => NOW })).stateFor(owner.address);
    assert.deepEqual([back.steps.length, back.done, back.unwritten], [0, true, []]);
    // its words as it went live are labels, held to nothing; changed, they are held to what a record takes
    const long = '🫧'.repeat(11);
    const wasLong = edit(old, 'bubl', { name: long });
    wasLong.live = { ...wasLong.live, published: edit(old.live.published, 'bubl', { name: long }) };
    assert.ok(check(wasLong, { now: NOW }).ok);
    assert.ok(!check(edit(old, 'bubl', { name: long }), { now: NOW }).ok);
    assert.match(
      (await runTool('xsolana_publish', { spec: next }, { now: NOW })).text,
      /approving reads it, and writes the new name, ticker and link there when the token has a record its owner can still change/,
    );
  },
);

test(
  'a record handed on, made unchangeable or given a royalty is not written, is said, and holds nothing else up',
  { skip },
  async () => {
    for (const [what, change, says] of [
      [
        'handed on',
        (data, thief) => data.set(addressBytes(thief), 1),
        /BUBL is called, but its name record is no longer the project owner’s to change.*wallets keep showing “Bubble” \(“BUBL”\)/,
      ],
      [
        'made unchangeable',
        data => {
          const at = 65 + 3 * 4 + 32 + 10 + 200 + 2 + 1 + 1;
          assert.equal(data[at], 1, 'the record’s own flag');
          data[at] = 0;
        },
        /BUBL is called, but its name record can no longer be changed.*wallets keep showing “Bubble” \(“BUBL”\)/,
      ],
      [
        'given a royalty',
        data => {
          const at = 65 + 3 * 4 + 32 + 10 + 200;
          assert.deepEqual([data[at], data[at + 1]], [0, 0], 'the record’s own royalty');
          data[at] = 0xf4;
          data[at + 1] = 0x01;
        },
        /BUBL is called, but its name record was given a royalty outside these tools.*wallets keep showing “Bubble” \(“BUBL”\)/,
      ],
    ]) {
      const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
      const { saved } = await approveAll(file, chain, owner);
      const mint = saved.live.mints.bubl;
      alterRecord(w, mint, data => change(data, freshKeypair().address));
      const next = { ...edit(saved, 'bubl', { name: 'Bubble Day' }), pools: [{ key: 'pot', currency: 'sol' }] };
      writeFileSync(file, JSON.stringify(next, null, 2));
      const session = await createApproval({ file, chain, now: () => NOW });
      const state = await session.stateFor(owner.address);
      assert.ok(warned(state, says), `${what}: ${state.warnings.join('\n')}`);
      assert.deepEqual(
        state.steps.map(s => s.id),
        ['pool:pot'],
        what,
      );
      const record = Uint8Array.from(w.chain.get(metadataAddress(mint)).data);
      const { saved: after } = await approveAll(file, chain, owner);
      assert.ok(after.pools[0].index !== undefined && !after.live.partial && !after.live.changing, what);
      assert.deepEqual(w.chain.get(metadataAddress(mint)).data, record, `${what}: the record is untouched`);
      assert.equal(after.live.published.tokens[1].name, 'Bubble', `${what}: and the file does not say otherwise`);
    }
  },
);

test(
  'a record with a verified creator, which Token Metadata would refuse to write over, stops nothing in its batch',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
    const { saved } = await approveAll(file, chain, owner);
    const mint = saved.live.mints.bubl;
    // as another tool would write it: the same words, with a royalty and the owner as a verified creator
    const text = t => concat(uintLE(utf8(t).length, 4), utf8(t));
    w.chain.send(owner.address, [
      {
        programId: METAPLEX_METADATA_PROGRAM,
        keys: [meta(metadataAddress(mint), false, true), meta(owner.address, true, false)],
        data: concat(
          Uint8Array.of(15, 1),
          ...['Bubble', 'BUBL', ''].map(text),
          uintLE(500, 2),
          Uint8Array.of(1),
          uintLE(1, 4),
          addressBytes(owner.address),
          Uint8Array.of(1, 100),
          Uint8Array.of(0, 0, 0, 0, 0),
        ),
      },
    ]);
    const was = parseRecord(w.chain.get(metadataAddress(mint)).data);
    assert.deepEqual([was.royalty, was.creators, was.plain], [500, 1, false]);
    writeFileSync(
      file,
      JSON.stringify({ ...edit(saved, 'bubl', { name: 'Bubble Day' }), pools: [{ key: 'pot', currency: 'sol' }] }),
    );
    const session = await createApproval({ file, chain, now: () => NOW });
    const state = await session.stateFor(owner.address);
    assert.deepEqual(
      state.steps.map(s => s.id),
      ['pool:pot'],
    );
    assert.ok(warned(state, /was given a royalty, creators outside these tools/), state.warnings.join('\n'));
    const { saved: after } = await approveAll(file, chain, owner);
    assert.ok(!after.live.partial && w.chain.get(pda.pool(after.live.project, 0)), 'the pool landed');
    assert.deepEqual(parseRecord(w.chain.get(metadataAddress(mint)).data), was, 'the record keeps what it was given');
  },
);

test('a name edited while a setup or a change was cut short is written when it is gone on with', { skip }, async () => {
  // the setup stops after its first transaction: two tokens made and named, the third and the project not yet
  const fails = { on: true, send: 2 };
  const spec = {
    ...SPEC,
    tokens: [...SPEC.tokens, { key: 'ember', source: 'project', name: 'Ember', symbol: 'EMBR' }],
  };
  const { w, owner, file, chain } = setup(spec, { fails });
  const first = await createApproval({ file, chain, now: () => NOW });
  const batch = await first.prepare(owner.address);
  await assert.rejects(first.complete(owner.address, batch.id, signAll(owner, batch.transactions)), /blockhash/);
  const mid = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(mid.live.partial && !mid.live.published && !mid.live.project, 'cut short');
  assert.deepEqual(Object.keys(mid.live.mints), ['bubl', 'gem']);
  assert.equal(named(w, mid.live.mints.bubl).name, 'Bubble');
  // two names are edited before going on: the token made already has its record written again, and the one still to
  // make is made with its new name
  fails.on = false;
  writeFileSync(file, JSON.stringify(edit(edit(mid, 'bubl', { name: 'Bubble Day' }), 'ember', { name: 'Embers' })));
  const resumed = await createApproval({ file, chain, now: () => NOW });
  const state = await resumed.stateFor(owner.address);
  assert.equal(state.mode, 'resume');
  assert.ok(
    ['name:bubl', 'token:ember', 'project'].every(id => state.steps.some(s => s.id === id)) &&
      !state.steps.some(s => ['name:gem', 'token:bubl', 'token:gem'].includes(s.id)),
    state.steps.map(s => s.id).join(' '),
  );
  const { saved } = await approveAll(file, chain, owner);
  assert.ok(!saved.live.partial && saved.live.published);
  assert.deepEqual(
    ['bubl', 'gem', 'ember'].map(key => named(w, saved.live.mints[key]).name),
    ['Bubble Day', 'Gem', 'Embers'],
  );
  assert.equal(saved.live.mints.bubl, mid.live.mints.bubl, 'the same mint');
  assert.deepEqual(changedParts(saved).renames, []);

  // a change cut short after its first transaction (the new name, and a token made beside it): gone on with, the
  // name is not written a second time, and what did not land is
  const next = {
    ...edit(saved, 'bubl', { name: 'Bubbles' }),
    tokens: [
      ...edit(saved, 'bubl', { name: 'Bubbles' }).tokens,
      { key: 'ash', source: 'project', name: 'Ash', symbol: 'ASH' },
      { key: 'soot', source: 'project', name: 'Soot', symbol: 'SOOT' },
      { key: 'coal', source: 'project', name: 'Coal', symbol: 'COAL' },
    ],
  };
  writeFileSync(file, JSON.stringify(next, null, 2));
  const cut = { on: true, send: 2 };
  let sends = 0;
  const flaky = {
    ...chain,
    send: async wire => {
      if (cut.on && ++sends === cut.send) throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
      return w.chain.sendWire(wire);
    },
  };
  const second = await createApproval({ file, chain: flaky, now: () => NOW });
  const b2 = await second.prepare(owner.address);
  assert.ok(b2.transactions.length > 1, 'more than one transaction, so it can be cut');
  assert.match(b2.says[0], /Change what the token BUBL/);
  await assert.rejects(second.complete(owner.address, b2.id, signAll(owner, b2.transactions)), /blockhash/);
  const half = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(half.live.partial && half.live.landed.includes('name:bubl'), 'cut short, the name written');
  assert.equal(named(w, saved.live.mints.bubl).name, 'Bubbles');
  assert.equal(half.live.published.tokens.find(t => t.key === 'bubl').name, 'Bubble Day', 'published as it was');
  cut.on = false;
  const third = await createApproval({ file, chain: flaky, now: () => NOW });
  const rest = await third.stateFor(owner.address);
  assert.ok(rest.steps.length && !rest.steps.some(s => s.id.startsWith('name:')), rest.steps.map(s => s.id).join(' '));
  // the name is changed once more before going on: its step is to do again, and is never shown as the one that landed
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8')), 'bubl', { name: 'Bubbly' })));
  const fourth = await createApproval({ file, chain: flaky, now: () => NOW });
  const again = await fourth.stateFor(owner.address);
  const step = again.steps.find(s => s.id === 'name:bubl');
  assert.ok(step && step.done === false && /“Bubbly”/.test(step.says), JSON.stringify(again.steps.map(s => s.id)));
  assert.ok(!again.landed.some(l => l.id === 'name:bubl') && again.landed.some(l => l.id.startsWith('token:')));
  const { saved: done } = await approveAll(file, flaky, owner);
  assert.ok(!done.live.partial && done.live.mints.coal);
  assert.deepEqual(
    ['bubl', 'ash', 'coal'].map(key => named(w, done.live.mints[key]).name),
    ['Bubbly', 'Ash', 'Coal'],
  );
  assert.deepEqual(changedParts(done).renames, []);
});

test('which names are written is read from the chain alone', { skip }, async () => {
  const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
  const { saved } = await approveAll(file, chain, owner);
  const next = edit(saved, 'bubl', { name: 'Bubble Day' });
  const ask = (economy, extra = {}) =>
    readRenames({
      live: economy.live,
      m: model(economy),
      chain: { account: async a => w.chain.rpc.account(a) },
      owner: owner.address,
      published: economy.live.published,
      ...extra,
    });
  assert.deepEqual(await ask(saved), { renames: [], notes: [], held: [], settled: [] });
  assert.deepEqual(await ask(next), { renames: ['bubl'], notes: [], held: [], settled: [] });
  // a file that claims anything about names is not believed: there is nothing in it to believe
  assert.deepEqual(await ask({ ...next, live: { ...next.live, named: [] } }), {
    renames: ['bubl'],
    notes: [],
    held: [],
    settled: [],
  });
  // another project's owner asking: the record is not theirs to change
  const other = await ask(next, { owner: freshKeypair().address });
  assert.deepEqual([other.renames, other.notes.length, other.held], [[], 1, ['bubl']]);
  // a record's own words are whoever holds it's: shown inside quotes, with nothing that closes one, turns the text
  // around or takes no room
  alterRecord(w, saved.live.mints.bubl, data => {
    data.fill(0, 69, 69 + 32);
    data.set(new TextEncoder().encode('ok”. Approve\u202e it\n now: “'), 69);
  });
  const hostile = await ask(next, { owner: freshKeypair().address });
  assert.match(
    hostile.notes[0],
    /wallets keep showing “ok\. Approve it now: ” \(“BUBL”\)\. This is said at each approve/,
  );
  alterRecord(w, saved.live.mints.bubl, data => {
    data.fill(0, 69, 69 + 32);
    data.set(new TextEncoder().encode('Bubble'), 69);
  });
  // with no published spec (a setup cut short), the chain alone is the measure, and words a record can't take are said
  const long = await ask(edit(saved, 'bubl', { name: '🫧'.repeat(11) }), { published: null });
  assert.deepEqual(long.renames, []);
  assert.match(long.notes[0], /words a name record can’t take/);
  assert.deepEqual(await ask(saved, { published: null }), { renames: [], notes: [], held: [], settled: [] });
  // a connection that can't read accounts renames nothing
  assert.deepEqual(await readRenames({ live: next.live, m: model(next), chain: {}, owner: owner.address }), {
    renames: [],
    notes: [],
    held: [],
    settled: [],
  });
});

/** `chain`, but the confirmation of the `at`th transaction sent is never seen, nor its status, until `seen()`. */
function blind(chain, at) {
  let confirms = 0;
  let lost = null;
  let hidden = true;
  return {
    chain: {
      ...chain,
      confirm: async signature => {
        if (++confirms !== at) return;
        lost = signature;
        throw new Error('confirmation timed out');
      },
      signatureStatus: async signature => (hidden && signature === lost ? null : chain.signatureStatus(signature)),
    },
    seen: () => (hidden = false),
  };
}
/** Approves batches until one fails: its message. */
async function approveUntilCut(file, chain, owner) {
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6; i++) {
    const batch = await session.prepare(owner.address);
    try {
      await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
    } catch (e) {
      return e.message;
    }
  }
  return null;
}

test(
  'a name edited while a transaction was still looked for is written, never recorded as published unsent',
  { skip },
  async () => {
    // a change (a pool) whose transaction landed unseen; the name is edited before approving again
    {
      const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
      const { saved } = await approveAll(file, chain, owner);
      writeFileSync(file, JSON.stringify({ ...saved, pools: [{ key: 'pot', currency: 'sol' }] }));
      const lost = blind(chain, 1);
      assert.match(await approveUntilCut(file, lost.chain, owner), /may still land/);
      const mid = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(mid.live.partial && mid.live.pending.length === 1);
      lost.seen();
      writeFileSync(file, JSON.stringify(edit(mid, 'bubl', { name: 'Bubble Day' })));
      const session = await createApproval({ file, chain: lost.chain, now: () => NOW });
      const state = await session.stateFor(owner.address);
      assert.deepEqual(
        [state.steps.map(s => s.id), state.done],
        [['name:bubl'], false],
        'the pool is found landed, and the name is still to write',
      );
      const held = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(held.live.partial && held.live.published.tokens[1].name === 'Bubble', 'not recorded as live yet');
      const { saved: after } = await approveAll(file, lost.chain, owner);
      assert.ok(!after.live.partial && w.chain.get(pda.pool(after.live.project, 0)));
      assert.deepEqual(
        [named(w, saved.live.mints.bubl).name, after.live.published.tokens[1].name],
        ['Bubble Day', 'Bubble Day'],
      );
    }
    // a first setup whose first transaction (the token, named as it was then) landed unseen
    {
      const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
      const lost = blind(chain, 1);
      assert.match(await approveUntilCut(file, lost.chain, owner), /may still land/);
      const mid = JSON.parse(readFileSync(file, 'utf8'));
      // (what a pending transaction made, the project's lookup table too, is a file that checks)
      assert.ok(check(mid, { now: NOW }).ok);
      lost.seen();
      writeFileSync(file, JSON.stringify(edit(mid, 'bubl', { name: 'Bubble Day' })));
      const { saved: after } = await approveAll(file, lost.chain, owner);
      assert.ok(!after.live.partial && after.live.project);
      assert.equal(named(w, after.live.mints.bubl).name, 'Bubble Day');
    }
    // a first setup whose lookup table's transaction landed unseen: what it made is in the file, which still checks
    {
      const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
      const lost = blind(chain, 2);
      assert.match(await approveUntilCut(file, lost.chain, owner), /may still land/);
      const mid = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(mid.live.pending[0].made.tables?.length === 1 && check(mid, { now: NOW }).ok);
      lost.seen();
      const session = await createApproval({ file, chain: lost.chain, now: () => NOW });
      assert.equal((await session.stateFor(owner.address)).done, true);
      const after = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(!after.live.partial && !after.live.pending);
      assert.deepEqual(after.live.tables, mid.live.pending[0].made.tables);
      assert.ok(w.chain.get(after.live.tables[0]), 'the table is on chain');
    }
    // a rename with a typo landed unseen; the typo is fixed before approving again: the fix is written, in the
    // session that found the first one landed
    for (const more of [[], ['ash', 'soot', 'coal', 'tar']]) {
      const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
      const { saved } = await approveAll(file, chain, owner);
      const typo = edit(saved, 'bubl', { name: 'Buble Day' });
      typo.tokens = [...typo.tokens, ...more.map(key => ({ key, source: 'project' }))];
      writeFileSync(file, JSON.stringify(typo));
      const lost = blind(chain, 1);
      assert.match(await approveUntilCut(file, lost.chain, owner), /may still land/);
      assert.equal(named(w, saved.live.mints.bubl).name, 'Buble Day');
      lost.seen();
      writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8')), 'bubl', { name: 'Bubble Day' })));
      const session = await createApproval({ file, chain: lost.chain, now: () => NOW });
      const state = await session.stateFor(owner.address);
      const again = state.steps.find(s => s.id === 'name:bubl');
      // the step is to do, and never shown as landed for what an earlier one of its name did
      assert.ok(again && !again.done && /“Bubble Day”/.test(again.says), JSON.stringify(state.steps.map(s => s.id)));
      assert.ok(!state.landed.some(l => l.id === 'name:bubl'));
      const { saved: after } = await approveAll(file, lost.chain, owner);
      assert.ok(!after.live.partial);
      assert.deepEqual(
        [named(w, saved.live.mints.bubl).name, after.live.published.tokens[1].name, changedParts(after).renames],
        ['Bubble Day', 'Bubble Day', []],
      );
    }
  },
);

test(
  'a change that is a name alone, cut short, is still that change; a part added since is sent, never recorded unsent',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
    const { saved } = await approveAll(file, chain, owner);
    const next = edit(saved, 'bubl', { name: 'Bubble Day' });
    writeFileSync(file, JSON.stringify(next, null, 2));
    // the node refuses the send: nothing of the change can land, so the file reads as live again, as it was
    const refuses = {
      ...chain,
      send: async () => {
        throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
      },
    };
    assert.match(await approveUntilCut(file, refuses, owner), /blockhash/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), next);
    const fresh = await createApproval({ file, chain, now: () => NOW });
    assert.deepEqual(
      [fresh.state().mode, fresh.state().steps.map(s => s.id), fresh.state().done],
      ['change', ['name:bubl'], false],
    );

    // as an earlier build left such a file (marked as under way, changing nothing), with a pool added since: first
    // with the new name kept, then with nothing but another pool
    for (const [name, pool, steps] of [
      ['Bubble Day', 'pot', ['name:bubl', 'pool:pot']],
      ['Bubble Day', 'jar', ['pool:jar']],
    ]) {
      const base = JSON.parse(readFileSync(file, 'utf8'));
      const stuck = {
        ...edit(base, 'bubl', { name }),
        pools: [...(base.pools ?? []), { key: pool, currency: 'sol' }],
        live: { ...base.live, partial: true, changing: [], landed: [] },
      };
      writeFileSync(file, JSON.stringify(stuck, null, 2));
      const session = await createApproval({ file, chain, now: () => NOW });
      // before a wallet connects the page lists the change, and never calls a file under way done
      assert.deepEqual(
        [
          session.state().done,
          session
            .state()
            .steps.map(s => s.id)
            .sort(),
        ],
        [false, steps],
      );
      const state = await session.stateFor(owner.address);
      assert.deepEqual(state.steps.map(s => s.id).sort(), steps);
      const { saved: after } = await approveAll(file, chain, owner);
      assert.ok(!after.live.partial && !after.live.changing);
      assert.equal(named(w, saved.live.mints.bubl).name, name);
      for (const p of after.pools)
        assert.ok(w.chain.get(pda.pool(after.live.project, p.index)), `${p.key} is on chain`);
      assert.deepEqual([[...changedParts(after).only], changedParts(after).renames], [[], []]);
    }

    // a file left marked as under way with nothing left to do is recorded as live once a wallet's read says so
    const done = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...done, live: { ...done.live, partial: true, changing: [], landed: [] } }));
    const session = await createApproval({ file, chain, now: () => NOW });
    assert.equal(session.state().done, false);
    assert.equal((await session.stateFor(owner.address)).done, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).live.partial, undefined);
  },
);

test(
  'a name put back while its change was cut short is written back; one the chain already carries becomes the published one',
  { skip },
  async () => {
    const { w, owner, file, chain } = setup({ ...SPEC, tokens: SPEC.tokens.slice(0, 2) });
    const { saved } = await approveAll(file, chain, owner);
    const mint = saved.live.mints.bubl;
    // a change: the new name, and enough beside it that it takes more than one transaction; cut after the first
    const more = ['ash', 'soot', 'coal'].map(key => ({ key, source: 'project', name: key, symbol: key.toUpperCase() }));
    const renamed = edit(saved, 'bubl', { name: 'Bubbles' });
    writeFileSync(file, JSON.stringify({ ...renamed, tokens: [...renamed.tokens, ...more] }, null, 2));
    let sends = 0;
    const cut = { on: true };
    const flaky = {
      ...chain,
      send: async wire => {
        if (cut.on && ++sends === 2) throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
        return w.chain.sendWire(wire);
      },
    };
    const first = await createApproval({ file, chain: flaky, now: () => NOW });
    const batch = await first.prepare(owner.address);
    await assert.rejects(first.complete(owner.address, batch.id, signAll(owner, batch.transactions)), /blockhash/);
    const half = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(half.live.partial && half.live.landed.includes('name:bubl'));
    assert.equal(named(w, mint).name, 'Bubbles');
    // the old name is put back before going on: the spec says what was published, and the chain no longer does
    cut.on = false;
    writeFileSync(file, JSON.stringify(edit(half, 'bubl', { name: 'Bubble' }), null, 2));
    const again = await createApproval({ file, chain: flaky, now: () => NOW });
    const state = await again.stateFor(owner.address);
    assert.ok(
      state.steps.some(x => x.id === 'name:bubl'),
      state.steps.map(x => x.id).join(' '),
    );
    const { saved: done } = await approveAll(file, flaky, owner);
    assert.ok(!done.live.partial);
    assert.deepEqual(
      [named(w, mint).name, done.live.published.tokens.find(t => t.key === 'bubl').name],
      ['Bubble', 'Bubble'],
      'the chain and the file agree',
    );
    assert.deepEqual(changedParts(done).renames, []);

    // the spec takes a new name the record already has (written elsewhere): nothing is sent, and the file's published
    // spec takes it, so no tool keeps announcing the change
    alterRecord(w, mint, data => {
      data.fill(0, 69, 69 + 32);
      data.set(new TextEncoder().encode('Bubble Day'), 69);
    });
    const next = edit(done, 'bubl', { name: 'Bubble Day', symbol: 'BUBL' });
    writeFileSync(file, JSON.stringify(next, null, 2));
    assert.deepEqual(changedParts(next).renames, ['bubl']);
    const settled = await createApproval({ file, chain: flaky, now: () => NOW });
    const read = await settled.stateFor(owner.address);
    assert.deepEqual([read.steps.length, read.done], [0, true]);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.live.published.tokens.find(t => t.key === 'bubl').name, 'Bubble Day');
    assert.deepEqual(changedParts(after).renames, []);
    assert.match(
      (await runTool('xsolana_publish', { spec: after }, { now: NOW })).text,
      /nothing in it has changed since it went live/,
    );
  },
);
