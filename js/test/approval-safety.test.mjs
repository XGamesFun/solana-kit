// The approval and the tools against what a wrong RPC, a planted file or another user of the machine could do: each
// test reproduces a way it went wrong once and shows it refused now.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { approve, createApproval, openBrowser } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { NATIVE_MINT } from '../chain/pda.js';
import { transferLamports } from '../chain/programs.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { units } from '../play/index.js';
import { cost } from '../economy/cost.mjs';
import { newAddress } from '../sim/chain.mjs';
import { approvalChain, boxArgs, cannotRun, collectible, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_790_000_000;

/** A wallet: signs each prepared wire in its own slot, as signTransaction does. */
const signAll = (wallet, wires) =>
  wires.map((b64) => {
    const t = readTransaction(fromBase64(b64));
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(wallet.address)] = wallet.sign(t.message);
    return toBase64(wireTransaction(t.message, sigs));
  });

/** An approval of the spec `specOf(w)` makes, on a fresh world whose owner holds SOL and 5,000 of its 6-decimal mint. */
async function approval(seed, specOf, { chain: overrides = {} } = {}) {
  const w = world({ project: false, seed });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  w.fund(owner.address, w.mint, 5_000_000_000n);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-approval-')), 'xsolana.json');
  const spec = specOf(w);
  writeFileSync(file, JSON.stringify(spec, null, 2));
  const session = await createApproval({ file, chain: approvalChain(w, overrides), now: () => NOW });
  const runAll = async () => {
    for (let i = 0; i < 10 && !session.state().done; i++) {
      const batch = await session.prepare(owner.address);
      await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
    }
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  return { w, owner, file, session, runAll };
}

/** Send instructions that fail after every instruction logged success: [logs, error]. */
function failsAfterSuccess(w, ix) {
  try {
    w.chain.send(w.player, [ix, transferLamports(w.player, newAddress(w.random), 1n)]);
  } catch (e) {
    return [e.logs, e.message];
  }
  throw new Error('the transaction succeeded');
}

test('a transaction with an error gives no receipts, though its logs show every instruction succeeded', { skip }, () => {
  const w = world({ seed: 'error-receipts' });
  const balance = w.balance(w.player);
  const pay = loot.payIx({ player: w.player, project: w.project, mint: w.mint, treasury: w.treasury, amount: PRICE, shares: [], reference: 'order-1' });
  const [logs, error] = failsAfterSuccess(w, pay);
  assert.match(error, /rent/i);
  assert.equal(w.balance(w.player), balance, 'the payment was rolled back');
  assert.ok(logs.includes(`Program ${loot.LOOT_PROGRAM} success`) && !logs.some((l) => / failed/.test(l)), 'the logs read as all-success');
  const err = { InsufficientFundsForRent: { account_index: 4 } };
  assert.deepEqual(loot.receipts(logs, err), []);
  assert.deepEqual(loot.receipts({ meta: { err, logMessages: logs } }), []);
  assert.throws(() => loot.receipts(logs), /meta\.err/);
  assert.throws(() => loot.receipts({ logMessages: logs }), /meta\.err/);

  w.upsert({ Item: { id: 2, args: { ...collectible('Potion'), kind: 'Normal' } } });
  w.upsert({ Box: { id: 8, args: boxArgs(PRICE, [itemDrop(2)]) } });
  const buy = () => loot.buyIx({ player: w.player, project: w.project, box: w.read('LootBox', loot.pda.box(w.project, 8)), treasury: w.treasury, items: { 2: w.read('Item', loot.pda.item(w.project, 2)) } });
  const [buyLogs] = failsAfterSuccess(w, buy());
  assert.deepEqual(loot.receipts({ meta: { err: { InsufficientFundsForRent: { account_index: 6 } }, logMessages: buyLogs } }), []);
  const sent = w.chain.send(w.player, [buy()]);
  assert.deepEqual(loot.receipts({ meta: { err: null, logMessages: sent.logs } }).map((r) => r.name), ['PrizeGiven', 'Bought']);
  assert.deepEqual(loot.receipts(sent.logs, null).map((r) => r.name), ['PrizeGiven', 'Bought']);
});

test('the approval reads an existing mint’s decimals and refuses a spec that says otherwise', { skip }, async () => {
  const seeded = (decimals, mint) => (w) => ({
    version: 2, name: 'Prize pool', currency: 'usdc', collection: false,
    tokens: [{ key: 'usdc', symbol: 'USDC', source: 'existing', mint: mint ?? w.mint, decimals }],
    pools: [{ key: 'prizes', currency: 'usdc', seed: 1 }],
  });
  // The mint has 6 decimals: 9 would put 1,000 USDC in the pool while the page says 1.
  const wrong = await approval('decimals-wrong', seeded(9));
  const state = await wrong.session.stateFor(wrong.owner.address);
  assert.match(state.refused, /9 decimals; its mint \w+ has 6, so every amount in it would be 1000 times what the page shows\. Write "decimals": 6\./);
  await assert.rejects(wrong.session.prepare(wrong.owner.address), (e) => e.status === 409 && /has 6/.test(e.message));
  assert.equal(wrong.w.balance(wrong.owner.address), 5_000_000_000n, 'nothing moved');

  const price = await approval('decimals-price', (w) => ({
    version: 2, name: 'Shop', currency: 'usdc', collection: false,
    tokens: [{ key: 'usdc', symbol: 'USDC', source: 'existing', mint: w.mint, decimals: 3 }],
    pools: [{ key: 'house', currency: 'usdc' }],
    boxes: [{ key: 'chest', name: 'Chest', price: 10, split: [{ to: 'pool:house', percent: 100 }], outcomes: [{ gives: 'nothing', chance: 100 }] }],
  }));
  await assert.rejects(price.session.prepare(price.owner.address), /3 decimals; its mint \w+ has 6, so every amount in it would be 1\/1000 of what the page shows/);

  const wsol = await approval('decimals-wsol', seeded(12, NATIVE_MINT));
  await assert.rejects(wsol.session.prepare(wsol.owner.address), /wrapped SOL, which has 9/);

  // The mint's own decimals go live, and the pool holds the 1 USDC the page says.
  const right = await approval('decimals-right', seeded(6));
  assert.equal((await right.session.stateFor(right.owner.address)).refused, undefined);
  const saved = await right.runAll();
  assert.equal(right.w.chain.tokens(loot.pda.pool(saved.live.project, saved.pools[0].index)), 1_000_000n);
});

test('the page lists each wallet of a grant’s list with its amount, the prize and the limits, and warns of outside ones', { skip }, async () => {
  let attacker, members;
  const a = await approval('grant-list', (w) => {
    members = [newAddress(w.random), newAddress(w.random)];
    attacker = newAddress(w.random);
    return {
      version: 2, name: 'Airdrop', currency: 'coin', collection: false,
      tokens: [{ key: 'coin', symbol: 'COIN', source: 'existing', mint: w.mint, decimals: 6 }],
      pools: [{ key: 'prizes', currency: 'coin', seed: 300 }],
      grants: [{ key: 'drop', name: 'Community airdrop', prize: { gives: 'tokens', from: 'pool:prizes', amount: 100 }, list: [...members, { wallet: attacker, amount: 50, round: 2 }], limits: { total: 3 } }],
    };
  });
  for (const state of [a.session.state(), await a.session.stateFor(a.owner.address)]) {
    const grant = state.steps.find((s) => s.id.startsWith('grant:drop')).details;
    assert.ok(grant.includes('Each claim gets: up to 100 COIN from the pool “prizes”'), grant.join('\n'));
    assert.ok(grant.includes('Limits: 3 claims in all'));
    for (const m of members) assert.ok(grant.includes(`On its list, ${m}: gets the prize above`));
    assert.ok(grant.includes(`On its list, ${attacker}: gets 50 COIN, in round 2`));
    assert.ok(state.warnings.some((x) => x.includes('other than your wallet') && x.includes(attacker)), state.warnings.join('\n'));
  }
});

test('a change is held against the records on chain, not the file’s own copy of what is live', { skip }, async () => {
  const a = await approval('chain-records', () => ({
    version: 2, name: 'Shop', currency: 'sol', collection: false, tokens: [{ key: 'sol', source: 'sol' }],
    boxes: [{ key: 'chest', name: 'Chest', price: 0.1, split: [], outcomes: [{ gives: 'nothing', chance: 100 }] }],
  }));
  const saved = await a.runAll();
  const attacker = newAddress(a.w.random);
  // The file's box pays half to a stranger, and its live.published is planted to say the box always did.
  const planted = structuredClone(saved);
  const share = [{ to: `wallet:${attacker}`, percent: 50 }];
  planted.boxes[0] = { ...planted.boxes[0], name: 'Chest!', split: share };
  planted.live.published.boxes[0] = { ...planted.live.published.boxes[0], split: share };
  writeFileSync(a.file, JSON.stringify(planted, null, 2));
  const session = await createApproval({ file: a.file, chain: approvalChain(a.w), now: () => NOW });
  assert.ok(session.state().warnings.some((x) => /not been read from the chain yet/.test(x)));
  const state = await session.stateFor(a.owner.address);
  const box = state.steps.find((s) => s.id.startsWith('box:chest')).details;
  assert.ok(box.some((d) => d.includes(`50% to the wallet ${attacker}`) && d.includes('(changed: it was all of it to the treasury')), box.join('\n'));
  assert.ok(state.warnings.some((x) => x.includes('the live economy does not') && x.includes(attacker)), state.warnings.join('\n'));
  // What the wallet is asked to sign is marked the same way.
  const batch = await session.prepare(a.owner.address);
  assert.ok(batch.details.flat().some((d) => d.includes(attacker) && d.includes('(changed:')));
});

test('rent the RPC asks for is held against what any cluster charges, and refused above it', { skip }, async () => {
  const coins = () => ({ version: 2, name: 'Coins', currency: 'coin', collection: false, tokens: [{ key: 'coin', source: 'game', symbol: 'COIN', decimals: 6 }], pools: [{ key: 'p', currency: 'coin' }] });
  const lying = await approval('rent-cap', coins, { chain: { rent: async () => 500_000_000_000n } });
  const sol = lying.w.chain.get(lying.owner.address).lamports;
  await assert.rejects(lying.session.prepare(lying.owner.address), (e) => e.status === 502 && /needs 500000000000 lamports of rent; no cluster charges more than 1461600/.test(e.message));
  await assert.rejects(lying.session.stateFor(lying.owner.address), /no cluster charges more/);
  assert.equal(lying.w.chain.get(lying.owner.address).lamports, sol);
  // LiteSVM's own rent is within the bound, and goes live.
  const honest = await approval('rent-honest', coins);
  assert.ok((await honest.runAll()).live.project);
});

test('the player module takes only a plain decimal amount, with at most the token’s decimals', () => {
  for (const bad of ['0x1', '0x10', '0b1', '0o7', '1.2.3', '', ' ', '1e3', '-1', '1.0000009', '1,5', '.5', '5.', 'abc', undefined, null, -1, Infinity, NaN, 1n]) {
    assert.throws(() => units(bad, 6), /is not an amount|more decimals/, String(bad));
  }
  assert.equal(units('1.5', 6), 1_500_000n);
  assert.equal(units(' 12 ', 0), 12n);
  assert.equal(units(0.1, 9), 100_000_000n);
  assert.equal(units(1e-7, 9), 100n);
  assert.equal(units('1.000000', 6), 1_000_000n);
  assert.equal(units('0.000001', 6), 1n);
});

test('the SOL total of going live counts a lottery’s seed and a sealed schedule’s funds', () => {
  const spec = {
    version: 2, name: 'Draw', currency: 'sol', collection: false, tokens: [{ key: 'sol', source: 'sol' }],
    lotteries: [{ key: 'weekly', name: 'Weekly', price: 0.01, every: '7d', seed: 5, places: [{ percent: 100 }] }],
    schedules: [{ key: 'drip', name: 'Drip', does: 'pay', sealed: true, currency: 'sol', to: 'wallet:5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T', amount: 0.1, start: 'publish+1d', every: '1d', maxRuns: 20, fund: 2 }],
  };
  const setup = cost(spec, { now: NOW }).setup;
  assert.deepEqual(setup.seeds, { SOL: 7 });
  assert.ok(setup.totalSol > 7 && setup.totalSol < 7.1, String(setup.totalSol));
  assert.ok(Math.abs(setup.totalSol - (setup.rentSol + setup.programFeesSol + setup.networkFeesSol + 7)) < 1e-9);
  // Funds a pool or the mint puts in are not the owner's SOL.
  const minted = structuredClone(spec);
  minted.lotteries[0].seed = 0;
  minted.pools = [{ key: 'house', currency: 'sol' }];
  minted.schedules[0].fundFrom = 'pool:house';
  assert.ok(cost(minted, { now: NOW }).setup.totalSol < 0.1);
});

test('the browser is opened with a one-time code, never the session token', { skip }, async () => {
  const w = world({ project: false, seed: 'one-time-code' });
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-approval-')), 'xsolana.json');
  writeFileSync(file, readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url)));
  const noOpen = process.env.XSOLANA_NO_OPEN;
  delete process.env.XSOLANA_NO_OPEN;
  const asked = [];
  let served;
  try {
    served = await approve({ file, chain: approvalChain(w), log: () => {}, openLink: (url) => asked.push(url) });
  } finally {
    if (noOpen !== undefined) process.env.XSOLANA_NO_OPEN = noOpen;
  }
  const { server, link, opened } = served;
  try {
    const token = new URL(link).searchParams.get('t');
    assert.deepEqual(asked, [opened]);
    assert.ok(!opened.includes(token), 'the command line carries no token');
    const first = await fetch(opened, { redirect: 'manual' });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), `/?t=${token}`);
    assert.equal((await fetch(opened, { redirect: 'manual' })).status, 403, 'the code works once');
    const page = await fetch(link);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(token));
    assert.equal((await fetch(new URL('/api/state', link))).status, 403);
  } finally {
    server.close();
  }
});

// The one-time code was once on xdg-open's command line, which another user of the machine can read
// (/proc/<pid>/cmdline) and redeem before the browser does. The opener now gets the path of a page only this user can
// read, which sends the browser on to the code's link, and the page is removed once the code is used.
test('the opener\'s command line carries no code; the page it opens is private and removed once used', { skip }, async () => {
  const w = world({ project: false, seed: 'opener-page' });
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-approval-')), 'xsolana.json');
  writeFileSync(file, readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url)));
  const noOpen = process.env.XSOLANA_NO_OPEN;
  delete process.env.XSOLANA_NO_OPEN;
  const spawned = [];
  const spawnImpl = (cmd, args) => { spawned.push([cmd, ...args]); return { unref() {} }; };
  let served;
  try {
    served = await approve({ file, chain: approvalChain(w), log: () => {}, openLink: (url) => openBrowser(url, { spawnImpl }) });
  } finally {
    if (noOpen !== undefined) process.env.XSOLANA_NO_OPEN = noOpen;
  }
  const { server, opened } = served;
  try {
    const code = new URL(opened).searchParams.get('c');
    assert.equal(spawned.length, 1);
    assert.ok(!spawned[0].join(' ').includes(code), 'no code on the command line');
    const page = spawned[0].at(-1);
    assert.equal(statSync(page).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(page)).mode & 0o777, 0o700);
    assert.ok(readFileSync(page, 'utf8').includes(`url=${opened}`), 'the page sends the browser on to the code\'s link');
    assert.equal((await fetch(opened, { redirect: 'manual' })).status, 303);
    for (let i = 0; i < 50 && existsSync(path.dirname(page)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(existsSync(path.dirname(page)), false, 'removed once the code is used');
  } finally {
    server.close();
  }
});
