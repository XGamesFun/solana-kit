// A token's name on chain, changed after it is live: the spec's new name, ticker or link is written to its record
// (Token Metadata's UpdateMetadataAccountV2) at the next approve, signed by the owner, the record's update authority.
// Which tokens have a record their owner can change is read from the chain as the change is approved, never taken
// from the file: one with no record (it went live before setups named tokens), or a record handed on or made
// unchangeable, is said so and nothing is sent for it. Through the approval page's own server, on the real programs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { readRenames } from '../approve/live-check.mjs';
import { createApproval } from '../approve/server.mjs';
import { addressBytes } from '../chain/base58.js';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { metadataAddress, parseRecord } from '../chain/metadata.js';
import { parseMint } from '../chain/mint.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, setAuthorityIx } from '../chain/token.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { changedParts, renamesNote } from '../economy/live.mjs';
import { model } from '../economy/model.mjs';
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
    const b = named(w, bubl),
      g = named(w, gem);
    assert.deepEqual([b.name, b.symbol, b.uri], ['Bubble Day', 'BUBL', LINK]);
    assert.deepEqual([g.name, g.symbol, g.mintAuthority, g.supply], ['Gem', 'GEMS', null, '1000000000']);
    assert.equal(b.mintAuthority, after.live.project, 'minting is still the project’s');
    assert.deepEqual(
      parseRecord(b.record.data),
      { updateAuthority: owner.address, mint: bubl, name: 'Bubble Day', symbol: 'BUBL', uri: LINK, mutable: true },
      'the record is still the owner’s to change',
    );
    assert.equal(b.record.data.length, 607);
    assert.deepEqual([after.live.mints.bubl, after.live.mints.gem], [bubl, gem], 'the same mints');
    assert.ok(!after.live.partial && !after.live.landed, 'the file is live, with nothing left over');
    // nothing more to publish; and a change of name costs a transaction, no rent and no fee to Token Metadata
    assert.deepEqual([changedParts(after).only.size, changedParts(after).renames], [0, []]);
    const priced = cost(next, { now: NOW, ...change, live: next.live }).setup;
    assert.deepEqual([priced.accounts.length, priced.rentSol, priced.metadataFeesSol], [0, 0, 0]);
    // a tool that does not read the chain says what approving will do, and that it reads the record first
    const said = await runTool('xsolana_publish', { spec: next }, { now: NOW });
    assert.equal(said.transactions, 1);
    assert.match(said.text, /Change what the token BUBL \(mint \w+\) is called on chain/);
    assert.ok(said.text.includes(renamesNote(['bubl', 'gem'])), said.text);
    assert.match(
      (await runTool('xsolana_cost', { spec: next }, { now: NOW })).text,
      /prices only the change \(the name of bubl, the name of gem\)/,
    );

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
    assert.equal(w.chain.get(metadataAddress(bare)).data.length, 0, 'nothing written');
    // a change beside it goes through, and the name is not asked about again once the file is published as it is
    writeFileSync(file, JSON.stringify({ ...next, pools: [{ key: 'pot', currency: 'sol' }] }, null, 2));
    const { before, saved: after } = await approveAll(file, chain, owner);
    assert.deepEqual(
      before.steps.map(s => s.id).filter(id => !id.startsWith('name:')),
      ['pool:pot'],
    );
    assert.ok(after.pools[0].index !== undefined && !after.live.partial, 'the pool landed, and the file is not stuck');
    assert.deepEqual(changedParts(after).renames, []);
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
  'a record handed on or made unchangeable is not written, is said, and holds nothing else up',
  { skip },
  async () => {
    for (const [what, change, says] of [
      [
        'handed on',
        (data, thief) => data.set(addressBytes(thief), 1),
        /BUBL is called, but its name record is no longer the project owner’s to change.*wallets keep showing “Bubble”, BUBL/,
      ],
      [
        'made unchangeable',
        data => {
          const at = 65 + 3 * 4 + 32 + 10 + 200 + 2 + 1 + 1;
          assert.equal(data[at], 1, 'the record’s own flag');
          data[at] = 0;
        },
        /BUBL is called, but its name record can no longer be changed.*wallets keep showing “Bubble”, BUBL/,
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
      const { saved: after } = await approveAll(file, chain, owner);
      assert.ok(after.pools[0].index !== undefined && !after.live.partial && !after.live.changing, what);
      assert.equal(named(w, mint).name, 'Bubble', `${what}: unchanged on chain`);
    }
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
  const { saved: done } = await approveAll(file, flaky, owner);
  assert.ok(!done.live.partial && done.live.mints.coal);
  assert.deepEqual(
    ['bubl', 'ash', 'coal'].map(key => named(w, done.live.mints[key]).name),
    ['Bubbles', 'Ash', 'Coal'],
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
  assert.deepEqual(await ask(saved), { renames: [], notes: [] });
  assert.deepEqual(await ask(next), { renames: ['bubl'], notes: [] });
  // a file that claims anything about names is not believed: there is nothing in it to believe
  assert.deepEqual(await ask({ ...next, live: { ...next.live, named: [] } }), { renames: ['bubl'], notes: [] });
  // another project's owner asking: the record is not theirs to change
  const other = await ask(next, { owner: freshKeypair().address });
  assert.deepEqual([other.renames, other.notes.length], [[], 1]);
  // with no published spec (a setup cut short), the chain alone is the measure, and words a record can't take are said
  const long = await ask(edit(saved, 'bubl', { name: '🫧'.repeat(11) }), { published: null });
  assert.deepEqual(long.renames, []);
  assert.match(long.notes[0], /words a name record can’t take/);
  assert.deepEqual(await ask(saved, { published: null }), { renames: [], notes: [] });
  // a connection that can't read accounts renames nothing
  assert.deepEqual(await readRenames({ live: next.live, m: model(next), chain: {}, owner: owner.address }), {
    renames: [],
    notes: [],
  });
});
