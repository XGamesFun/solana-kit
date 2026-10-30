// The approval page's server: a whole setup, then a change to it, approved batch by batch by a wallet and sent to the
// real program in LiteSVM; and the refusals that keep it honest (a changed transaction, another wallet, a replay).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import { request } from 'node:http';
import { approve, createApproval, ownRequest } from '../approve/server.mjs';
import * as loot from '../client/index.js';
import { approvalChain, cannotRun, cannotRunCompressed, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const example = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));

/** A wallet: signs each prepared wire in its own slot, as signTransaction does. */
const signAll = (wallet, wires) =>
  wires.map((b64) => {
    const t = readTransaction(fromBase64(b64));
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(wallet.address)] = wallet.sign(t.message);
    return toBase64(wireTransaction(t.message, sigs));
  });

/** `fails`: the number of a send (1, 2, …) that fails as a devnet RPC error would, while `fails.on` is true. */
function setup(spec, { compressed = false, fails = null } = {}) {
  const w = world({ project: false, seed: 'approve', compressed });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-approve-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  let sends = 0;
  const chain = approvalChain(w, {
    send: async (wire) => {
      sends++;
      // The node answers and refuses it (a code), as a devnet RPC does.
      if (fails?.on && sends === fails.send) throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
      return w.chain.sendWire(wire);
    },
  });
  return { w, owner, file, chain };
}

async function runAll(session, owner) {
  for (let i = 0; i < 10 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
  }
}

describe('xsolana approve', () => {
  test('a new economy goes live batch by batch, and the file records it', { skip: skip ?? false }, async () => {
    const { w, owner, file, chain } = setup(example);
    const session = await createApproval({ file, chain, now: () => NOW });
    assert.equal(session.state().mode, 'new');
    await runAll(session, owner);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(saved.live?.project && !saved.live.partial, 'live, and not partial');
    const project = w.read('Project', saved.live.project);
    assert.equal(project.owner, owner.address);
    assert.ok(w.chain.get(loot.pda.box(saved.live.project, saved.boxes[0].id)));
    assert.equal(w.chain.tokens(loot.pda.pool(saved.live.project, saved.pools.find((p) => p.key === 'house').index)), 5_000_000_000n);

    // A change: a new pool, and the flip costs more. Only those land.
    const changed = { ...saved, pools: [...saved.pools, { key: 'bonus', currency: 'sol' }], boxes: [{ ...saved.boxes[0], price: 0.2, split: [{ to: 'pool:house', percent: 86 }, { to: 'lottery:weekly', percent: 10 }, { to: 'pool:backers', percent: 2 }, { to: 'pool:bonus', percent: 2 }] }], decisions: [{ key: 'bonus-payout', when: 'a weekly high score', does: 'payout', pool: 'bonus', amount: 0.1 }] };
    writeFileSync(file, JSON.stringify(changed, null, 2));
    const again = await createApproval({ file, chain, now: () => NOW });
    const state = again.state();
    assert.equal(state.mode, 'change');
    assert.deepEqual(state.steps.map((s) => s.id).sort(), ['box:flip:LootBox', 'pool:bonus'].sort());
    await runAll(again, owner);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    const box = w.read('LootBox', loot.pda.box(after.live.project, after.boxes[0].id));
    assert.equal(box.price, 200_000_000n);
    assert.ok(w.chain.get(loot.pda.pool(after.live.project, after.pools.find((p) => p.key === 'bonus').index)));
    assert.equal((await createApproval({ file, chain, now: () => NOW })).state().done, true, 'nothing left to publish');
  });

  test('an economy that gives compressed NFTs goes live: the owner makes the tree’s account, its fresh key signs', { skip: cannotRunCompressed() ?? false }, async () => {
    const badges = JSON.parse(readFileSync(new URL('../../examples/event-badges.json', import.meta.url), 'utf8'));
    const { w, owner, file, chain } = setup(badges, { compressed: true });
    await runAll(await createApproval({ file, chain, now: () => NOW }), owner);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(saved.live?.tree && !saved.live.partial, 'live, with its tree');
    assert.equal(w.chain.get(loot.pda.treeConfig(saved.live.tree)).owner, loot.BUBBLEGUM_PROGRAM);
    assert.deepEqual(w.read('Grant', loot.pda.grant(saved.live.project, saved.grants[0].id)).gives, { Compressed: { item: saved.items[0].id, tree: saved.live.tree } });
  });

  // A batch cut short after its first transaction wrote the project and every mint
  // into the file as live, so going on never opened the project.
  for (const restart of [false, true])
    test(`a setup cut short records only what landed, and going on ${restart ? 'after a restart' : 'in the same session'} finishes it`, { skip: skip ?? false }, async () => {
      const guild = JSON.parse(readFileSync(new URL('../../examples/expedition-guild.json', import.meta.url), 'utf8'));
      // A third token of the game's own: the project's step falls out of the first transaction.
      guild.tokens.push({ key: 'ember', source: 'game', name: 'ember', symbol: 'EMBER', decimals: 0 });
      const fails = { on: true, send: 2 };
      const { w, owner, file, chain } = setup(guild, { fails });
      const session = await createApproval({ file, chain, now: () => NOW });
      const batch = await session.prepare(owner.address);
      await assert.rejects(session.complete(owner.address, batch.id, signAll(owner, batch.transactions)), /blockhash/);
      const mid = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(mid.live.partial && !mid.live.landed.includes('project'));
      assert.equal(mid.live.project, undefined, 'no project named before its step lands');
      for (const [key, mint] of Object.entries(mid.live.mints ?? {})) {
        assert.ok(mid.live.landed.includes(`token:${key}`), `the mint of ${key} is named only once its step landed`);
        assert.ok(w.chain.get(mint), `the mint of ${key} exists`);
      }
      fails.on = false;
      const again = restart ? await createApproval({ file, chain, now: () => NOW }) : session;
      assert.ok(again.state().steps.some((s) => s.id === 'project'), 'the project is planned again');
      await runAll(again, owner);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(again.state().done && !saved.live.partial);
      assert.equal(w.read('Project', saved.live.project).owner, owner.address);
      for (const t of guild.tokens.filter((t) => t.source === 'game')) assert.ok(w.chain.get(saved.live.mints[t.key]), `the mint of ${t.key} exists`);
      assert.ok(w.chain.get(loot.pda.box(saved.live.project, saved.boxes[0].id)));
    });

  // Two asks for the next batch at once (two tabs, a reload): the slower one was built before the other's batch
  // landed, and sending it paid the same pool's seed twice.
  test('a batch built before another landed is never sent', { skip: skip ?? false }, async () => {
    const { w, owner, file, chain: base } = setup(example, { fails: { on: true, send: 3 } });
    // The first blockhash asked for after `slow` is set comes late: the second ask is built and lands meanwhile.
    let slow = null;
    const chain = {
      ...base,
      latestBlockhash: async () => {
        const wait = slow;
        slow = null;
        if (wait) await wait;
        return base.latestBlockhash();
      },
    };
    const session = await createApproval({ file, chain, now: () => NOW });
    const first = await session.prepare(owner.address);
    await assert.rejects(session.complete(owner.address, first.id, signAll(owner, first.transactions)), /blockhash/);
    slow = new Promise((resolve) => setTimeout(resolve, 300));
    const stale = session.prepare(owner.address);
    const next = await session.prepare(owner.address);
    await session.complete(owner.address, next.id, signAll(owner, next.transactions));
    const again = await stale;
    await assert.rejects(session.complete(owner.address, again.id, signAll(owner, again.transactions)), (e) => e.status === 409);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const house = saved.pools.find((p) => p.key === 'house');
    assert.equal(w.chain.tokens(loot.pda.pool(saved.live.project, house.index)), 5_000_000_000n, 'the seed is paid once');
  });

  test('a setup cut short before its tree landed opens the tree on going on, and its prizes name that tree', { skip: cannotRunCompressed() ?? false }, async () => {
    const badges = JSON.parse(readFileSync(new URL('../../examples/event-badges.json', import.meta.url), 'utf8'));
    // A long metadata link: the tree's step falls out of the first transaction (the collection and the project).
    badges.collection = { ...badges.collection, uri: `https://arweave.net/${'a'.repeat(180)}` };
    const fails = { on: true, send: 2 };
    const { w, owner, file, chain } = setup(badges, { compressed: true, fails });
    const first = await createApproval({ file, chain, now: () => NOW });
    const batch = await first.prepare(owner.address);
    await assert.rejects(first.complete(owner.address, batch.id, signAll(owner, batch.transactions)), /blockhash/);
    const mid = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!mid.live.landed.includes('tree'));
    assert.equal(mid.live.tree, undefined, 'no tree named before its step lands');
    fails.on = false;
    const again = await createApproval({ file, chain, now: () => NOW });
    await runAll(again, owner);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(again.state().done && !saved.live.partial);
    assert.equal(w.chain.get(loot.pda.treeConfig(saved.live.tree)).owner, loot.BUBBLEGUM_PROGRAM, 'the tree the file names was made');
    assert.deepEqual(w.read('Grant', loot.pda.grant(saved.live.project, saved.grants[0].id)).gives, { Compressed: { item: saved.items[0].id, tree: saved.live.tree } });
  });

  // A change that re-pointed a box's 88% share to an outside wallet read,
  // word for word, like an honest one.
  test('the page names every payee in full, and a change says which payee it re-points', { skip: skip ?? false }, async () => {
    const { w, owner, file, chain } = setup(example);
    const first = await createApproval({ file, chain, now: () => NOW });
    const box = first.state().steps.find((s) => s.id === 'box:flip:LootBox');
    assert.ok(box.details.some((d) => /^Pays: 88% to the pool “house”, 10% to the pot of “Weekly draw”, 2% to the pool “backers”$/.test(d)), box.details.join('\n'));
    await runAll(first, owner);
    const saved = JSON.parse(readFileSync(file, 'utf8'));

    const attacker = freshKeypair().address;
    const voucher = freshKeypair().address;
    const tampered = structuredClone(saved);
    tampered.boxes[0].split = tampered.boxes[0].split.map((s) => (s.to === 'pool:house' ? { ...s, to: `wallet:${attacker}` } : s));
    const prize = { gives: 'tokens', amount: 1, currency: 'arena', from: 'mint' };
    tampered.grants = [{ key: 'drop', name: 'Drop', prize, vouchers: [voucher], limits: { perWallet: 1 } }, { key: 'free', name: 'Free', prize, limits: { perWallet: 1, total: 10 } }];
    writeFileSync(file, JSON.stringify(tampered, null, 2));
    const session = await createApproval({ file, chain, now: () => NOW });
    // What is live is read from the chain once the wallet connects; before, the page says it has not been.
    assert.ok(session.state().warnings.some((w) => /not been read from the chain yet/.test(w)));
    const state = await session.stateFor(owner.address);
    const lines = (id) => state.steps.find((s) => s.id === id)?.details ?? [];
    assert.ok(lines('box:flip:LootBox').some((d) => d.includes(`88% to the wallet ${attacker}`) && d.includes('(changed: it was 88% to the pool “house”')), lines('box:flip:LootBox').join('\n'));
    assert.ok(state.warnings.some((w) => w.includes(attacker) && w.includes(voucher)), 'a warning names the new payee and the new voucher key');
    assert.ok(lines('grant:drop:Grant').some((d) => d.includes(`Voucher keys (each decides who gets it): ${voucher}`)));
    assert.ok(lines('grant:free:Grant').some((d) => /^Open: any wallet may claim it/.test(d)));

    // What the wallet is asked to sign says it too, read from those very transactions.
    const batch = await session.prepare(owner.address);
    const said = batch.details.flat();
    assert.ok(said.some((d) => d.includes(`88% to the wallet ${attacker}`)));
    assert.ok(said.some((d) => d.includes(voucher)));
    await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
    assert.ok(JSON.stringify(w.read('LootBox', loot.pda.box(saved.live.project, saved.boxes[0].id)).shares).includes(attacker));
  });

  test('refuses a changed transaction, another wallet and a replay', { skip: skip ?? false }, async () => {
    const { owner, file, chain } = setup(example);
    const session = await createApproval({ file, chain, now: () => NOW });
    const batch = await session.prepare(owner.address);
    const signed = signAll(owner, batch.transactions);
    const other = freshKeypair();
    await assert.rejects(session.complete(other.address, batch.id, signed), /another wallet/);
    const tampered = [...signed];
    const t = readTransaction(fromBase64(tampered[0]));
    const message = Uint8Array.from(t.message);
    message[message.length - 1] ^= 1;
    tampered[0] = toBase64(wireTransaction(message, t.signatures));
    await assert.rejects(session.complete(owner.address, batch.id, tampered), /that batch is not|changed the transaction/i);
    const batch2 = await session.prepare(owner.address);
    await session.complete(owner.address, batch2.id, signAll(owner, batch2.transactions));
    await assert.rejects(session.complete(owner.address, batch2.id, signAll(owner, batch2.transactions)), /not the one prepared/);
  });

  test('a second ask while a batch is out (a double click) gets the same batch, which still lands', { skip: skip ?? false }, async () => {
    const { owner, file, chain } = setup(example);
    const session = await createApproval({ file, chain, now: () => NOW });
    const first = await session.prepare(owner.address);
    const second = await session.prepare(owner.address);
    assert.equal(second.id, first.id);
    assert.deepEqual(second.transactions, first.transactions);
    await session.complete(owner.address, first.id, signAll(owner, first.transactions));
  });
});

describe('xsolana approve: the local server', () => {
  /** One request to the server: { status, headers, body }. Host and Origin can be set as a browser on another name would. */
  const ask = (port, { method = 'GET', path: at = '/', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path: at, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });

  async function serve() {
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-serve-'));
    const file = path.join(dir, 'xsolana.json');
    writeFileSync(file, JSON.stringify(example, null, 2));
    // no request here reaches the chain
    const { server, link } = await approve({ file, open: false, chain: {}, log: () => {} });
    const token = new URL(link).searchParams.get('t');
    return { server, port: server.address().port, token };
  }

  test('only its own name is served: another Host or Origin (DNS rebinding) is refused', async () => {
    const { server, port, token } = await serve();
    try {
      const page = `/?t=${token}`;
      assert.equal((await ask(port, { path: page })).status, 200);
      assert.equal((await ask(port, { path: page, headers: { host: `localhost:${port}` } })).status, 200);
      assert.equal((await ask(port, { path: page, headers: { host: `evil.example:${port}` } })).status, 403);
      assert.equal((await ask(port, { path: page, headers: { host: '127.0.0.1:1' } })).status, 403);
      const api = { path: '/api/state', headers: { 'x-xsolana-token': token } };
      assert.equal((await ask(port, api)).status, 200);
      assert.equal((await ask(port, { ...api, headers: { ...api.headers, origin: `http://127.0.0.1:${port}` } })).status, 200);
      assert.equal((await ask(port, { ...api, headers: { ...api.headers, origin: 'http://evil.example' } })).status, 403);
      assert.equal(ownRequest({ host: `127.0.0.1:${port}`, origin: 'null' }, port), false);
    } finally {
      server.close();
    }
  });

  test('the page is served with a policy that allows its own scripts only, and is never framed', async () => {
    const { server, port, token } = await serve();
    try {
      const r = await ask(port, { path: `/?t=${token}` });
      const csp = r.headers['content-security-policy'];
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /default-src 'none'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      // nothing inline for the policy to block: no inline script, no style attribute; the one style block is hashed
      assert.doesNotMatch(r.body, /<script(?![^>]*\bsrc=)[^>]*>/);
      assert.doesNotMatch(r.body, /\sstyle="/);
      assert.match(r.body, new RegExp(`<meta name="xsolana-token" content="${token}">`));
      const js = await ask(port, { path: '/js/approve/page.js' });
      assert.equal(js.status, 200);
      assert.match(js.headers['content-type'], /javascript/);
    } finally {
      server.close();
    }
  });

  test('a wrong token, a body that is not JSON and a body too large are refused with their own status', async () => {
    const { server, port, token } = await serve();
    try {
      assert.equal((await ask(port, { path: '/api/state', headers: { 'x-xsolana-token': `${token}x` } })).status, 403);
      assert.equal((await ask(port, { path: '/api/state' })).status, 403);
      const post = (body) => ask(port, { method: 'POST', path: '/api/prepare', headers: { 'x-xsolana-token': token, 'content-type': 'application/json' }, body });
      const notJson = await post('{not json');
      assert.equal(notJson.status, 400);
      assert.match(JSON.parse(notJson.body).error, /not JSON/);
      const large = await post(JSON.stringify({ wallet: 'x'.repeat(300_000) }));
      assert.equal(large.status, 413);
      // and the server goes on answering
      assert.equal((await ask(port, { path: '/api/state', headers: { 'x-xsolana-token': token } })).status, 200);
    } finally {
      server.close();
    }
  });

  test('closing the session withdraws the batch out for signing and drops the fresh keys', { skip: skip ?? false }, async () => {
    const { owner, file, chain } = setup(example);
    const session = await createApproval({ file, chain, now: () => NOW });
    const batch = await session.prepare(owner.address);
    session.close();
    await assert.rejects(session.complete(owner.address, batch.id, signAll(owner, batch.transactions)), /not the one prepared/);
    // a later batch is built on new keys, and still lands
    await runAll(session, owner);
    assert.ok(session.state().done);
  });
});
