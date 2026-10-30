// The tools' guards, each shown against the real program in LiteSVM: a prize's roll at its hashed nonce, a planted
// `live` section, a confirmation that timed out, a price that moved after the player saw it, a loan whose token
// someone can freeze, a mainnet RPC, MCP file paths outside the project, and a throwaway key's lamports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval, devnetChain } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit } from '../chain/programs.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES } from '../chain/token.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { encodeBase58 } from '../chain/base58.js';
import { check } from '../economy/check.mjs';
import { plan } from '../economy/plan.mjs';
import { runTool } from '../mcp/server.mjs';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { approvalChain, boxArgs, cannotRun, collectible, itemDrop, PRICE, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
/** The address the setup plan stands in for the owner's wallet before one connects (plan.mjs `placeholderContext`). */
const STAND_IN_OWNER = encodeBase58(createHash('sha256').update('loot-plan:owner').digest());
const example = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));

/** A wallet: signs its own slot of whatever it is handed. */
const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});
const signAll = (kp, wires) => wires.map((b64) => toBase64(asWalletSync(kp, fromBase64(b64))));
const asWalletSync = (kp, wire) => {
  const t = readTransaction(wire);
  const sigs = [...t.signatures];
  sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
  return wireTransaction(t.message, sigs);
};
const specFile = (spec, prefix = 'xsolana-') => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), prefix)), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  return file;
};
async function runAll(session, kp) {
  for (let i = 0; i < 10 && !session.state().done; i++) {
    const batch = await session.prepare(kp.address);
    await session.complete(kp.address, batch.id, signAll(kp, batch.transactions));
  }
}
const funded = (w) => {
  const kp = freshKeypair();
  w.chain.airdrop(kp.address, 100_000_000_000n);
  return kp;
};
const freshWorld = (seed) => {
  const w = world({ project: false, seed, compressed: false });
  w.chain.warp(NOW);
  return w;
};

describe('a prize’s roll is made at prizeRollNonce of the nonce its route names', () => {
  test('prizeRollNonce is the first 8 bytes, little endian, of sha256("prize" | n), and wraps as the program adds', () => {
    for (const n of [0n, 1n, 77n, 2n ** 64n - 1n]) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(n);
      const want = createHash('sha256').update(Buffer.concat([Buffer.from('prize'), le])).digest().readBigUInt64LE(0);
      assert.equal(loot.prizeRollNonce(n), want);
    }
    assert.equal(loot.prizeRollNonce(2n ** 64n), loot.prizeRollNonce(0n), 'a place added past u64 wraps, as wrapping_add does');
    const project = freshKeypair().address;
    const lines = loot.prizeMetas({ project, prize: { Roll: [5] }, winner: NOBODY, nonce: 9n });
    assert.equal(lines[1].pubkey, pda.order(project, NOBODY, loot.prizeRollNonce(9n)));
  });

  test('a claim is signed by its own wallet; its claim at its NFT’s nonce rolls elsewhere', { skip }, () => {
    const w = world({ seed: 'hardening-prize-nonce' });
    w.upsert({ Item: { id: 1, args: collectible('Gem') } });
    w.upsert({ Box: { id: 5, args: boxArgs(0n, [itemDrop(1)], { active: false }) } });
    const limits = { wallet: { total: 1, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
    w.upsert({ Grant: { id: 1, args: { gives: { Roll: [5] }, vouchers: [NOBODY, NOBODY, NOBODY], list_root: new Uint8Array(32), limits, active: true, gate: null, open: true } } });
    const victimNft = w.make(1, w.player);
    const nonce = loot.nonceOn(victimNft);
    const boxes = { 5: w.read('LootBox', pda.box(w.project, 5)) };
    // Every claim needs its wallet's own signature (WalletMustSign): a stranger may pay its fees, never claim for it.
    const forThem = loot.claimGrantIx({ project: w.project, id: 1, grant: w.read('Grant', pda.grant(w.project, 1)), wallet: w.player, signer: w.cranker, projectState: w.projectState(), boxes, nonce });
    assert.ok(forThem.keys.some((k) => k.pubkey === w.player && k.isSigner), 'the player signs it');
    // Named by the player itself, the nonce of its NFT still lands the roll elsewhere.
    w.chain.send(w.player, [loot.claimGrantIx({ project: w.project, id: 1, grant: w.read('Grant', pda.grant(w.project, 1)), wallet: w.player, signer: w.player, projectState: w.projectState(), boxes, nonce })]);
    assert.equal(w.chain.get(pda.order(w.project, w.player, nonce)), null, 'the NFT’s own order address is still free');
    assert.equal(w.read('Order', pda.order(w.project, w.player, loot.prizeRollNonce(nonce))).status, 'Waiting');
  });
});

describe('xsolana approve holds the file’s live section against the chain', () => {
  test('a planted live section naming someone else’s project is refused: no seed is paid into their pool', { skip }, async () => {
    const w = freshWorld('hardening-forged');
    const attacker = funded(w);
    const theirs = structuredClone(example);
    const aFile = specFile(theirs);
    await runAll(await createApproval({ file: aFile, chain: approvalChain(w), now: () => NOW }), attacker);
    const attackerLive = JSON.parse(readFileSync(aFile, 'utf8')).live;
    const house = example.pools.findIndex((p) => p.key === 'house');
    const pool = pda.pool(attackerLive.project, house);
    const before = w.chain.tokens(pool);

    const victim = funded(w);
    const landed = plan(example, { now: NOW }).steps.map((s) => s.id).filter((id) => !id.startsWith('seed:'));
    const forged = { ...example, live: { partial: true, project: attackerLive.project, treasury: attackerLive.treasury, authority: attackerLive.authority, collection: attackerLive.collection, mints: attackerLive.mints, landed } };
    // xsolana_save does not keep a live section the file never had.
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-019-save-'));
    const saved = await runTool('xsolana_save', { spec: forged }, { cwd: dir, now: NOW });
    assert.equal(saved.ok, true, saved.text);
    assert.match(saved.text, /live section given was not kept/);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'xsolana.json'), 'utf8')).live, undefined);

    // Written to the file by hand, the page refuses it once the victim connects.
    const vFile = specFile(forged);
    const session = await createApproval({ file: vFile, chain: approvalChain(w), now: () => NOW });
    const shown = await session.stateFor(victim.address);
    assert.match(shown.refused, new RegExp(`belongs to the wallet ${attacker.address}, not to the connected wallet ${victim.address}`));
    await assert.rejects(session.prepare(victim.address), /belongs to the wallet/);
    assert.equal(w.chain.tokens(pool), before, 'the attacker’s pool got nothing');
  });

  test('a planted treasury before the project landed is ignored: the project’s treasury is the spec’s, the owner’s wallet', { skip }, async () => {
    const w = freshWorld('hardening-treasury');
    const owner = funded(w);
    const attacker = freshKeypair().address;
    const spec = { ...structuredClone(example), live: { partial: true, landed: [], treasury: attacker } };
    delete spec.treasury;
    const session = await createApproval({ file: specFile(spec), chain: approvalChain(w), now: () => NOW });
    const shown = await session.stateFor(owner.address);
    assert.equal(shown.project, pda.project(owner.address, example.projectNumber ?? 0), 'the page names the wallet’s own project');
    assert.ok(!JSON.stringify(shown).includes(attacker), 'the planted treasury is nowhere');
    const lines = shown.steps.find((s) => s.id === 'project').details;
    assert.ok(lines.includes(`Treasury: your wallet (${owner.address})`), lines.join('\n'));
    const batch = await session.prepare(owner.address);
    assert.equal(batch.project, shown.project);
    assert.ok(batch.details[0][0].startsWith(`Project: ${shown.project} (your own)`));
    await runAll(session, owner);
    const project = w.read('Project', pda.project(owner.address, example.projectNumber ?? 0));
    assert.equal(project.treasury, owner.address);
  });

  test('a live economy whose file names another treasury than the chain’s is refused', { skip }, async () => {
    const w = freshWorld('hardening-change');
    const owner = funded(w);
    const file = specFile(example);
    await runAll(await createApproval({ file, chain: approvalChain(w), now: () => NOW }), owner);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const attacker = freshKeypair().address;
    writeFileSync(file, JSON.stringify({ ...saved, boxes: [{ ...saved.boxes[0], price: 0.2 }], live: { ...saved.live, treasury: attacker } }, null, 2));
    const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
    await assert.rejects(session.prepare(owner.address), new RegExp(`treasury is ${attacker}; on chain it is ${owner.address}`));
    // A mint that is not the one the setup made (its minting not the project's) is refused too.
    const other = w.newMint(owner.address);
    writeFileSync(file, JSON.stringify({ ...saved, boxes: [{ ...saved.boxes[0], price: 0.2 }], live: { ...saved.live, mints: { ...saved.live.mints, arena: other } } }, null, 2));
    await assert.rejects((await createApproval({ file, chain: approvalChain(w), now: () => NOW })).prepare(owner.address), /is minted by/);
  });

  test('no spec may name the address the plan stands in for the wallet, and only the connected wallet is “your wallet”', { skip }, async () => {
    const spec = { ...structuredClone(example), treasury: `wallet:${STAND_IN_OWNER}` };
    const verdict = check(spec, { now: NOW });
    assert.ok(verdict.refusals.some((r) => r.code === 'E-STAND-IN'), JSON.stringify(verdict.refusals));
    const w = freshWorld('hardening-label');
    const owner = funded(w);
    const someone = freshKeypair().address;
    const session = await createApproval({ file: specFile({ ...structuredClone(example), treasury: `wallet:${someone}` }), chain: approvalChain(w), now: () => NOW });
    const lines = (await session.stateFor(owner.address)).steps.find((s) => s.id === 'project').details;
    assert.ok(lines.includes(`Treasury: ${someone}`), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('your wallet') && !l.includes(owner.address)), lines.join('\n'));
  });
});

describe('a setup transaction that lands after its confirmation failed is recorded, never sent twice', () => {
  for (const when of ['Open the project', 'Put 5'])
    test(`the step “${when}…”`, { skip }, async () => {
      const w = freshWorld(`hardening-lost-${when.length}`);
      const owner = funded(w);
      const file = specFile(example);
      let says = [];
      let k = 0;
      let current = '';
      let failed = false;
      const chain = approvalChain(w, {
        send: async (wire) => {
          current = says[k++];
          return w.chain.sendWire(wire);
        },
        // The transaction ran; the status poll then fails once, as an RPC hiccup does.
        confirm: async () => {
          if (!failed && current.includes(when)) {
            failed = true;
            throw new Error('RPC getSignatureStatuses did not answer: fetch failed');
          }
        },
      });
      const session = await createApproval({ file, chain, now: () => NOW });
      for (let i = 0; i < 8 && !session.state().done; i++) {
        const batch = await session.prepare(owner.address);
        says = batch.says;
        k = 0;
        await session.complete(owner.address, batch.id, signAll(owner, batch.transactions)).catch(() => null);
      }
      assert.ok(failed, 'a confirmation failed');
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(session.state().done && !saved.live.partial && !saved.live.pending, JSON.stringify(saved.live));
      assert.equal(w.read('Project', saved.live.project).owner, owner.address);
      const house = saved.pools.find((p) => p.key === 'house');
      assert.equal(w.chain.tokens(pda.pool(saved.live.project, house.index)), 5_000_000_000n, 'the seed was paid once');
    });

  test('one that may still land stops the next batch until the chain says, then is recorded', { skip }, async () => {
    const w = freshWorld('hardening-wait');
    const owner = funded(w);
    const file = specFile(example);
    let seen = false;
    const chain = approvalChain(w, {
      confirm: async () => {
        throw new Error('Transaction was not confirmed in time; check it in the explorer.');
      },
    });
    const real = chain.signatureStatus;
    chain.signatureStatus = async (sig) => (seen ? real(sig) : null);
    const session = await createApproval({ file, chain, now: () => NOW });
    const batch = await session.prepare(owner.address);
    await assert.rejects(session.complete(owner.address, batch.id, signAll(owner, batch.transactions)), /may still land/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).live.pending.length, 1);
    // A new session after a restart: nothing is sent while it is unknown.
    const again = await createApproval({ file, chain, now: () => NOW });
    await assert.rejects(again.prepare(owner.address), /has not landed yet/);
    seen = true;
    const next = await again.prepare(owner.address);
    const live = JSON.parse(readFileSync(file, 'utf8')).live;
    assert.ok(live.landed.length > 0 && !live.pending, 'recorded as landed');
    assert.ok(!next.says.join(' ').includes(batch.says[0]), 'and not sent again');
  });
});

/** An economy with a 0.01 SOL badge, live through the approval session; a player's app on it. */
async function shop(seed) {
  const w = freshWorld(seed);
  const owner = funded(w);
  const player = funded(w);
  const spec = { version: 2, network: 'devnet', name: 'Shop', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], collection: { name: 'Shop' }, items: [{ key: 'badge', name: 'Badge', price: 0.01, supply: 10 }, { key: 'gem', name: 'Gem' }], boxes: [{ key: 'chest', name: 'Chest', price: 0.02, outcomes: [{ gives: 'item', item: 'gem', chance: 50 }, { gives: 'item', item: 'badge', chance: 50 }] }] };
  const file = specFile(spec);
  await runAll(await createApproval({ file, chain: approvalChain(w), now: () => NOW }), owner);
  const live = JSON.parse(readFileSync(file, 'utf8'));
  return { w, owner, player, live, app: solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() }) };
}

describe('the price a player was shown is the most they pay', () => {
  test('buy and openBox need what the player saw, and refuse a price that rose since', { skip }, async () => {
    const { w, owner, player, live, app } = await shop('hardening-price');
    await assert.rejects(app.buy('badge'), /Say the most the player agreed to pay/);
    await assert.rejects(app.openBox('chest'), /Say the most the player agreed to pay/);
    const listing = (await app.shop()).find((l) => l.key === 'badge');
    // The owner raises the price after the player saw it.
    const project = live.live.project;
    const boxId = live.items[0].shopBox;
    const b = w.read('LootBox', pda.box(project, boxId));
    const args = { price: 5_000_000_000n, currency: b.currency, rise: b.rise, fall: b.fall, stock_odds: b.stock_odds, active: b.active, shares: b.shares, entries: b.entries, gate: b.gate, odds: b.odds, window: b.window, per_wallet: b.per_wallet, subject: b.subject, fates: b.fates };
    w.chain.send(owner.address, [loot.upsertIx({ owner: owner.address, project, def: { Box: { id: boxId, args } } })]);
    const had = await w.chain.rpc.balance(player.address);
    await assert.rejects(app.buy('badge', { listing }), /is now 5, more than the 0\.01 the player was shown/);
    await assert.rejects(app.buy('badge', { maxPrice: listing.priceUnits }), /more than/);
    assert.equal(await w.chain.rpc.balance(player.address), had, 'nothing was paid');
    const now = (await app.shop()).find((l) => l.key === 'badge');
    assert.ok((await app.buy('badge', { listing: now })).asset, 'the new price, once shown, sells');
  });

  test('craft needs the recipe version the player was shown', { skip }, async () => {
    const w = world({ seed: 'hardening-craft-2' });
    w.upsert({ Item: { id: 1, args: collectible('Gem') } });
    w.upsert({ Recipe: { id: 1, args: { active: true, inputs: [{ Burn: { item: 1, count: 1 } }], outputs: [], needs: [], keeps: [], raises: [] } } });
    const kp = funded(w);
    const spec = { version: 2, tokens: [], recipes: [{ key: 'melt', name: 'Melt', id: 1 }], live: { project: w.project, collection: w.collection } };
    const player = solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(kp), now: () => w.chain.now() });
    const gem = w.make(1, kp.address);
    await assert.rejects(player.craft('melt', [gem]), /Say which version of “Melt” the player was shown/);
    const [listing] = await player.recipes();
    assert.equal(listing.key, 'melt');
    await player.craft('melt', [gem], 1, { listing });
    assert.ok((w.chain.get(gem)?.data.length ?? 0) <= 1, 'burned');
  });
});

describe('a loan whose token someone can freeze is shown as such, and needs the player’s yes', () => {
  test('loanOffer names the freeze authority, and borrow refuses without acceptRisks', { skip }, async () => {
    const w = world({ seed: 'hardening-loan' });
    w.upsert({ Item: { id: 1, args: collectible('Fighter') } });
    const maker = w.who();
    // A mint the lender can freeze.
    const frozen = newAddress(w.random);
    w.chain.send(w.creator, [
      createAccountIx({ from: w.creator, address: frozen, lamports: w.chain.rent(MINT_BYTES), space: MINT_BYTES, owner: TOKEN_PROGRAM }),
      initializeMint2Ix({ mint: frozen, decimals: 6, authority: w.creator, freezeAuthority: maker }),
    ]);
    const rule = { of: { Item: [1] }, key: '', test: 'Any' };
    for (const [id, mint] of [[1, w.mint], [2, frozen]]) {
      w.fund(maker, mint, 10n * PRICE);
      w.chain.send(maker, [loot.openOfferIx({ maker, project: w.project, id, mint, args: { rule, deal: { Lend: { amount: PRICE, repay: 2n * PRICE, lasts: 3600 } }, left: 1 } })]);
    }
    const kp = funded(w);
    const app = solanaApp({ spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } }, rpc: w.chain.rpc, wallet: asWallet(kp), now: () => w.chain.now() });
    const plain = await app.loanOffer(maker, 1);
    assert.deepEqual(plain.risks, []);
    const risky = await app.loanOffer(maker, 2);
    assert.deepEqual(risky.risks.map((r) => [r.power, r.holder]), [['freeze', maker]]);
    assert.match(risky.risks[0].says, /That is the lender: they could keep you from repaying and take your NFT/);
    const [a, b] = [w.make(1, kp.address), w.make(1, kp.address)];
    await assert.rejects(app.borrow(maker, 2, a), /Repaying this loan can be blocked.*acceptRisks: true/);
    assert.equal(w.balance(kp.address, frozen), 0n, 'nothing borrowed');
    const { hold } = await app.borrow(maker, 2, a, { acceptRisks: true });
    assert.equal(w.read('Hold', hold).debt.lender, maker);
    assert.equal(w.balance(kp.address, frozen), PRICE);
    await app.borrow(maker, 1, b);
    assert.equal(w.balance(kp.address, w.mint), PRICE, 'a plain token needs no yes');
  });
});

describe('devnet only, and MCP files inside the project folder', () => {
  test('a mainnet RPC is refused by the approval page, by its genesis too, by xsolana_status and by the player module', async () => {
    assert.throws(() => devnetChain('https://api.mainnet-beta.solana.com'), /mainnet RPC. loot runs on devnet only/);
    const hits = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const { method } = JSON.parse(init.body);
      hits.push(method);
      const result = method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : { value: { blockhash: NOBODY, lastValidBlockHeight: 1 } };
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    const was = process.env.XSOLANA_RPC_URL;
    try {
      const chain = devnetChain('https://rpc.example.invalid/my-key');
      await assert.rejects(chain.latestBlockhash(), /is on mainnet/);
      await assert.rejects(chain.send(new Uint8Array(1)), /is on mainnet/);
      assert.deepEqual([...new Set(hits)], ['getGenesisHash'], 'nothing but the genesis is asked');
      process.env.XSOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
      const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-019-status-'));
      writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify({ ...example, live: { project: NOBODY } }));
      const status = await runTool('xsolana_status', {}, { cwd: dir, now: NOW });
      assert.match(status.text, /mainnet RPC/);
      assert.throws(() => solanaApp({ spec: { live: { project: NOBODY } }, rpcUrl: 'https://api.mainnet-beta.solana.com', wallet: null }), /mainnet RPC/);
    } finally {
      globalThis.fetch = real;
      if (was === undefined) delete process.env.XSOLANA_RPC_URL;
      else process.env.XSOLANA_RPC_URL = was;
    }
  });

  test('xsolana_save and every tool’s file stay inside the project folder, and a save never overwrites a file that is not a spec', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'xsolana-019-paths-'));
    const project = path.join(base, 'project');
    mkdirSync(project);
    const outside = path.join(base, 'home', '.bashrc');
    mkdirSync(path.dirname(outside));
    writeFileSync(outside, 'export PATH=$HOME/bin:$PATH\n');
    for (const file of ['../home/.bashrc', path.join(base, 'elsewhere.json'), '../elsewhere.json']) {
      const r = await runTool('xsolana_save', { spec: example, file }, { cwd: project, now: NOW });
      assert.equal(r.ok, false, r.text);
      assert.match(r.text, /outside the project folder|not a \.json file/);
    }
    assert.equal(readFileSync(outside, 'utf8'), 'export PATH=$HOME/bin:$PATH\n');
    assert.ok(!existsSync(path.join(base, 'elsewhere.json')));
    const read = await runTool('xsolana_check', { file: '/etc/hostname' }, { cwd: project, now: NOW });
    assert.ok(read.isError && /outside the project folder/.test(read.text), read.text);
    // Inside the folder: a broken JSON file is named without quoting it, and a JSON file that is no spec is kept.
    writeFileSync(path.join(project, 'notes.json'), 'secret words here');
    const broken = await runTool('xsolana_check', { file: 'notes.json' }, { cwd: project, now: NOW });
    assert.ok(!broken.text.includes('secret'), broken.text);
    writeFileSync(path.join(project, 'package.json'), '{"name":"game"}');
    const r = await runTool('xsolana_save', { spec: example, file: 'package.json' }, { cwd: project, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(path.join(project, 'package.json'), 'utf8'), '{"name":"game"}');
    assert.equal((await runTool('xsolana_save', { spec: example }, { cwd: project, now: NOW })).ok, true);
  });
});

describe('a throwaway key never keeps the player’s SOL', () => {
  test('a settle someone else sent first: the key gives its lamports back', { skip }, async () => {
    const { w, player, live } = await shop('hardening-burner');
    let burner = null;
    let raced = false;
    const rpc = {
      ...w.chain.rpc,
      async send(wire) {
        const payer = readTransaction(wire).signers[0];
        // The throwaway key's settle: someone settles the order first.
        if (payer !== player.address && !raced) {
          raced = true;
          burner = payer;
          const orders = w.chain.svm.getProgramAccounts(loot.LOOT_PROGRAM).filter((a) => a.data[0] === loot.TAGS.Order);
          for (const o of orders) {
            const order = loot.decode('Order', o.data);
            if (order.player !== player.address) continue;
            const items = Object.fromEntries(order.won.filter((x) => x.Item).map((x) => [x.Item.item, w.read('Item', pda.item(live.live.project, x.Item.item))]));
            w.chain.send(w.cranker, [computeUnitLimit(600_000), loot.settleIx({ signer: w.cranker, orderAddress: o.address, order, projectState: w.read('Project', live.live.project), items })]);
          }
        }
        return w.chain.rpc.send(wire);
      },
    };
    const app = solanaApp({ spec: live, rpc, wallet: asWallet(player), now: () => w.chain.now() });
    const r = await app.openBox('chest', { listing: (await app.boxes()).find((l) => l.key === 'chest') });
    assert.ok(raced && burner, 'the race happened');
    assert.equal(r.settled, 'elsewhere');
    assert.equal(await w.chain.rpc.balance(burner), 0n, 'the throwaway key is empty');
  });
});

describe('a farm that watches counts no streak', () => {
  test('the checker refuses a streak on a watching farm, as the program does', async () => {
    const { check } = await import('../economy/check.mjs');
    const spec = JSON.parse(readFileSync(new URL('../../examples/guild-missions.json', import.meta.url), 'utf8'));
    const codes = (s) => check(s).refusals.map((p) => p.code);
    assert.ok(!codes(spec).includes('E-FARM'));
    const watching = spec.farms.find((f) => f.custody === 'watch' && f.growth?.length);
    watching.growth[0].streak = true;
    assert.ok(codes(spec).includes('E-FARM'));
    watching.custody = 'escrow';
    assert.ok(!codes(spec).includes('E-FARM'));
  });
});
