// A token the setup makes is named on chain as it is made: its Token Metadata record (name, ticker, link), written
// while the owner is still its mint authority, in the same step that hands minting on or turns it off. Sent to the
// real Token Metadata program as mainnet runs it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUintLE } from '../chain/bytes.js';
import {
  createFungibleMetadataIx,
  METADATA_BYTES,
  METADATA_FEE,
  metadataAddress,
  metadataUpdateAuthority,
} from '../chain/metadata.js';
import { parseMint } from '../chain/mint.js';
import { setAuthorityIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { cost, explainCost } from '../economy/cost.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { freshAddresses, prepare } from '../economy/live.mjs';
import { plan } from '../economy/plan.mjs';
import { BUDGET } from '../economy/txsize.mjs';
import { cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_790_000_000;
const LINK = 'https://example.invalid/token/bubl.json';

const spec = token => ({
  version: 2,
  network: 'devnet',
  name: 'Named tokens',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }, token],
  collection: false,
});

/** Puts `economy` live in a fresh world; returns the world, the setup's context and the plan sent. */
function goLive(economy, seed) {
  assert.ok(check(economy, { now: NOW }).ok, JSON.stringify(check(economy, { now: NOW }).refusals));
  const w = world({ project: false, seed });
  w.chain.warp(NOW);
  const keys = freshAddresses(plan(economy, { now: NOW }).freshKeys, w.random);
  const p = prepare(economy, { owner: w.creator, keys, now: NOW, rent: bytes => w.chain.rent(bytes) });
  assert.ok(p.ok, JSON.stringify(p.refusals ?? p));
  for (const t of p.transactions)
    w.chain.send(t.signer === 'authority' ? p.ctx.authority : w.creator, t.instructions, {
      label: t.steps.map(s => s.id).join(', '),
    });
  return { w, p };
}

/** A mint as the chain holds it, with its Token Metadata record. */
function read(w, mint) {
  const account = w.chain.get(mint);
  const record = w.chain.get(metadataAddress(mint));
  return { record, ...parseMint(mint, account.owner, account.data, record?.data ?? null) };
}

const STANDARDS = ['NonFungible', 'FungibleAsset', 'Fungible', 'NonFungibleEdition', 'ProgrammableNonFungible'];
/** The token standard a record names: after its three strings, the royalty, the creators, two flags and the nonce. */
function standardOf(data) {
  let at = 1 + 32 + 32;
  for (let i = 0; i < 3; i++) at += 4 + Number(readUintLE(data, at, 4));
  at += 2;
  if (data[at++] === 1) at += 4 + 34 * Number(readUintLE(data, at, 4));
  at += 2;
  if (data[at++] === 1) at += 1;
  return data[at] === 1 ? STANDARDS[data[at + 1]] : null;
}

test('a token the project mints goes live named: its name, ticker and link read back from the chain', { skip }, () => {
  const { w, p } = goLive(
    spec({ key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL', uri: LINK }),
    'token-names-minted',
  );
  const mint = p.ctx.mints.bubl;
  const t = read(w, mint);
  assert.equal(t.name, 'Bubble');
  assert.equal(t.symbol, 'BUBL');
  assert.equal(t.uri, LINK);
  assert.equal(t.decimals, 0, 'a project token has 0 decimals unless the spec says more');
  assert.equal(standardOf(t.record.data), 'Fungible', 'a token, not an asset, at 0 decimals too');
  assert.equal(t.record.data.length, METADATA_BYTES);
  assert.equal(t.mintAuthority, p.ctx.project, 'minting is the project’s, as before');
  assert.equal(t.freezeAuthority, null);
  assert.equal(metadataUpdateAuthority(t.record.data), w.creator, 'only the owner can change the record');
  assert.equal(loot.tokenMetadata.metadata(mint), metadataAddress(mint));
});

test('a fixed supply goes live named, all of it in the owner’s wallet and its minting off for good', { skip }, () => {
  const { w, p } = goLive(
    spec({ key: 'gem', source: 'project', name: 'Gem', symbol: 'GEM', decimals: 6, supply: 1_000_000 }),
    'token-names-fixed',
  );
  const mint = p.ctx.mints.gem;
  const t = read(w, mint);
  assert.equal(t.name, 'Gem');
  assert.equal(t.symbol, 'GEM');
  assert.equal(t.uri, null, 'no link given: wallets show the name and ticker, and no picture');
  assert.equal(standardOf(t.record.data), 'Fungible');
  assert.equal(t.mintAuthority, null);
  assert.equal(t.supply, '1000000000000');
  assert.equal(w.chain.tokens(loot.ata(w.creator, mint)), 1_000_000_000_000n);
  assert.equal(metadataUpdateAuthority(t.record.data), w.creator);
});

test('a token with no name of its own is named by its key, and one at the longest fields still fits', { skip }, () => {
  const plain = goLive(spec({ key: 'points', source: 'project' }), 'token-names-plain');
  const t = read(plain.w, plain.p.ctx.mints.points);
  assert.equal(t.name, 'points', 'the key, as the tools already call it');
  assert.equal(t.symbol, 'POINTS');

  const longest = spec({
    key: 'long',
    source: 'project',
    name: 'N'.repeat(32),
    symbol: 'S'.repeat(10),
    uri: `https://${'u'.repeat(192)}`,
    decimals: 9,
    supply: 5,
  });
  const sized = plan(longest, { now: NOW });
  const step = sized.transactions.find(x => x.steps.some(s => s.id === 'token:long'));
  assert.ok(step.bytes <= BUDGET, `${step.bytes} bytes`);
  const { w, p } = goLive(longest, 'token-names-longest');
  const long = read(w, p.ctx.mints.long);
  assert.equal(long.name.length, 32);
  assert.equal(long.symbol.length, 10);
  assert.equal(long.uri.length, 200);
});

test('once minting is handed on, no record can be made: the name is written in the token’s own step', { skip }, () => {
  const w = world({ seed: 'token-names-late' });
  const mint = w.newMint(w.creator);
  const naming = createFungibleMetadataIx({ mint, authority: w.creator, name: 'Late', symbol: 'LATE' });
  // with the authority given up first, Token Metadata refuses the record
  w.chain.send(w.creator, [setAuthorityIx({ account: mint, current: w.creator, newAuthority: null })]);
  assert.throws(() => w.chain.send(w.creator, [naming]));
  assert.ok(!w.chain.get(metadataAddress(mint)));
});

test('a name, ticker or link too long for the record is refused before anything is signed, in bytes', () => {
  const refusals = token => check(spec(token), { now: NOW }).refusals.filter(r => r.code === 'E-TOKEN');
  // 11 four-byte letters: 11 characters (the schema's 32 allows them), 44 bytes
  const name = refusals({ key: 'a', source: 'project', name: '🫧'.repeat(11), symbol: 'A' });
  assert.equal(name.length, 1);
  assert.match(name[0].where, /tokens\[1\]\.name$/);
  assert.match(name[0].message, /44 bytes.*at most 32/);
  const symbol = refusals({ key: 'b', source: 'project', name: 'B', symbol: 'ééééééé' });
  assert.match(symbol[0].where, /\.symbol$/);
  const uri = refusals({ key: 'c', source: 'project', uri: `https://${'u'.repeat(193)}` });
  assert.match(uri[0].where, /\.uri$/);
  assert.match(uri[0].message, /201 bytes.*at most 200/);
  // a token made elsewhere is named where it was made: its words here are only labels
  assert.equal(
    refusals({
      key: 'd',
      source: 'existing',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      decimals: 6,
      name: '🫧'.repeat(11),
    }).length,
    0,
  );
  assert.throws(
    () => createFungibleMetadataIx({ mint: 'x', authority: 'y', name: 'n'.repeat(33), symbol: 's' }),
    RangeError,
  );
});

test('the cost of going live counts the record: its rent, and Token Metadata’s fee apart from rent', () => {
  const c = cost(spec({ key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL' }), { now: NOW });
  const record = c.setup.accounts.find(a => a.what === 'the name of BUBL on chain');
  assert.equal(record.bytes, METADATA_BYTES);
  assert.equal(record.feeSol, Number(METADATA_FEE) / 1e9);
  assert.equal(c.setup.metadataFeesSol, 0.01);
  const parts = c.setup.rentSol + c.setup.metadataFeesSol + c.setup.programFeesSol + c.setup.networkFeesSol;
  assert.ok(Math.abs(c.setup.totalSol - parts) < 1e-9, `${c.setup.totalSol} against ${parts}`);
  assert.match(explainCost(c), /Token Metadata’s fees 0\.01 SOL/);
  const step = plan(spec({ key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL' }), { now: NOW }).steps.find(
    s => s.id === 'token:bubl',
  );
  assert.match(step.says, /write its name on chain \(“Bubble”, BUBL, no picture link/);
  assert.match(step.says, /only your wallet can change it later, which these tools don’t do yet/);
  // the link is said whole: the approval page shows the step's words, and nothing else of this instruction
  const linked = plan(spec({ key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL', uri: LINK }), {
    now: NOW,
  }).steps.find(s => s.id === 'token:bubl');
  assert.ok(linked.says.includes(`with the link ${LINK}`), linked.says);
});

test('explain lists the tokens going live makes, and says when one will show with no picture', () => {
  const words = token => explainEconomy(spec(token), { now: NOW }).text;
  const bare = words({ key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL' });
  assert.match(bare, /The tokens going live makes/);
  assert.match(bare, /BUBL \(“Bubble”\): minted by the project as its rules say/);
  assert.match(bare, /its name and ticker and no picture: for one, give it a `uri`/);
  assert.match(bare, /these tools don’t change a live token’s yet/);
  assert.match(bare, /Token Metadata’s fees 0\.01 SOL/);
  const pictured = words({ key: 'gem', source: 'project', symbol: 'GEM', supply: 500, uri: LINK });
  assert.match(pictured, /GEM: a fixed supply of 500, all of it to your wallet, and no more ever/);
  assert.match(pictured, /its name, its ticker and the picture its link gives/);
});

test('a token that is live already is not named again: no step, no limits on its labels, no line in explain', () => {
  const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const live = {
    ...spec({ key: 'old', source: 'project', name: '🫧'.repeat(11), symbol: 'OLD' }),
    live: { program: loot.LOOT_PROGRAM, project: MINT, mints: { old: MINT }, published: {} },
  };
  const verdict = check(live, { now: NOW });
  assert.deepEqual(
    verdict.refusals.filter(r => r.code === 'E-TOKEN'),
    [],
    'its name was only ever a label',
  );
  // the same name on a token still to be made is refused, and so is a blank one
  const fresh = token => check(spec(token), { now: NOW }).refusals.filter(r => r.code === 'E-TOKEN');
  assert.equal(fresh({ key: 'old', source: 'project', name: '🫧'.repeat(11), symbol: 'OLD' }).length, 1);
  const blank = fresh({ key: 'blank', source: 'project', name: '  ', symbol: '' });
  assert.deepEqual(blank.map(r => r.where.split('.').pop()).sort(), ['name', 'symbol']);
  assert.match(blank[0].message, /has an empty/);
  // explained and priced all the same (its whole setup as if new, which is never sent), with no line for the token
  assert.doesNotMatch(explainEconomy(live, { now: NOW }).text, /The tokens going live makes/);
  assert.ok(cost(live, { now: NOW }).setup.totalSol > 0);
  // and a change to it makes no token step
  assert.ok(!plan(live, { now: NOW, live: live.live }).steps.some(s => s.id.startsWith('token:')));
});
