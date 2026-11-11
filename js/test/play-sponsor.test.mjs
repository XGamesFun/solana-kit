// A sponsor pays a project's players' fees (js/play/sponsor.js), against the real program: a player with no SOL takes
// a free item, and the sponsor pays exactly its fee, the player fee and the rent of what it opened, the player ending
// as they began; a priced item still costs the player its price, and only its price. The sponsor's server refuses a
// transaction that would make it pay more: a smaller give-back, the sponsor named elsewhere, nothing of the project's, a
// priority fee, a budget spent.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { decodeBase58 } from '../chain/base58.js';
import { parseCoreAsset } from '../chain/core.js';
import { COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { transferLamports } from '../chain/programs.js';
import { compileMessage, readMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import {
  checkSponsored,
  solanaApp,
  sponsoredCost,
  sponsorHandler,
  sponsorSigner,
  sponsorTopUp,
} from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();

const asWallet = kp => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-sponsor-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map(b64 => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    });
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

const SPEC = {
  version: 2,
  network: 'devnet',
  name: 'Sponsor test',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'Sponsor test' },
  items: [
    { key: 'badge', name: 'Welcome Badge', price: 0, free: true, supply: 1000 },
    { key: 'cat', name: 'Moon Cat', price: 0.003, supply: 300 },
    { key: 'gem', name: 'Gem' },
  ],
  boxes: [
    {
      key: 'crate',
      name: 'Free crate',
      price: 0,
      currency: 'sol',
      outcomes: [
        { gives: 'item', item: 'gem', chance: 50 },
        { gives: 'nothing', chance: 50 },
      ],
    },
  ],
};

test(
  'a sponsor pays a player’s fees and rent, never their price, and its server refuses to pay more',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'sponsor' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    const sponsorKey = freshKeypair();
    const player = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    w.chain.airdrop(sponsorKey.address, 1_000_000_000n);
    const live = await goLive(w, owner, SPEC);
    const project = live.live.project;
    const rpc = w.chain.rpc;
    const balance = a => rpc.balance(a).then(BigInt);

    // The project's server: the sponsor's check and signature, behind an HTTP handler, as a page reaches it.
    const asked = [];
    const server = sponsorSigner({ rpc, project, sponsor: sponsorKey });
    const sponsor = {
      address: sponsorKey.address,
      async sign(wire) {
        asked.push(wire);
        const r = await sponsorHandler(
          new Request('https://game.test/sponsor', {
            method: 'POST',
            body: JSON.stringify({ transaction: toBase64(wire) }),
          }),
          server,
        );
        const body = await r.json();
        if (!r.ok) throw Object.assign(new Error(body.error), { refused: r.status === 403 });
        return fromBase64(body.transaction);
      },
    };
    // (what the player's wallet is handed to sign, as it is handed it)
    const handed = [];
    const wallet = {
      ...asWallet(player),
      signTransaction: wire => (handed.push(wire), asWallet(player).signTransaction(wire)),
    };
    const app = solanaApp({ spec: live, rpc, wallet, now: () => w.chain.now(), sponsor });

    // A player with no SOL at all takes the free badge.
    assert.equal(await balance(player.address), 0n);
    const sponsorBefore = await balance(sponsorKey.address);
    const feeBoxBefore = await balance(loot.pda.fees(project));
    const shop = await app.shop();
    const badge = await app.buy('badge', { listing: shop.find(l => l.key === 'badge') });
    assert.ok(badge.asset, 'the badge is the player’s');
    assert.equal(await balance(player.address), 0n, 'the player ends as they began: with nothing');
    const paid = sponsorBefore - (await balance(sponsorKey.address));
    const feeBox = (await balance(loot.pda.fees(project))) - feeBoxBefore;
    assert.ok(feeBox > 0n, 'the player fee was paid');
    const assetRent = await balance(badge.asset);
    assert.ok(paid >= feeBox + assetRent, 'the sponsor paid the player fee and the badge’s rent');
    assert.ok(paid <= feeBox + assetRent + 100_000n, `and little more than that, its fees: ${paid}`);
    assert.equal(asked.length, 1, 'one transaction, one sponsor signature');
    // It leads with a compute unit limit and a unit price of 0: a wallet that adds its own priority fee only where
    // a transaction sets none signs it as it stands, and the sponsor, which pays no price by default, took it.
    assert.equal(handed.length, 1);
    const led = readMessage(readTransaction(handed[0]).message);
    const [limit, price] = led.instructions;
    assert.equal(led.keys[limit.programIndex], COMPUTE_BUDGET_PROGRAM);
    assert.equal(limit.data[0], 2, 'its unit limit first');
    assert.equal(led.keys[price.programIndex], COMPUTE_BUDGET_PROGRAM);
    assert.deepEqual([...price.data], [3, 0, 0, 0, 0, 0, 0, 0, 0], 'then a unit price of 0');
    assert.deepEqual(readTransaction(asked[0]).message, readTransaction(handed[0]).message, 'signed as it was handed');

    // A second badge's transaction, as the page sends it to the sponsor: kept, never sent.
    let fresh = null;
    const keeper = solanaApp({
      spec: live,
      rpc,
      wallet: asWallet(player),
      now: () => w.chain.now(),
      sponsor: {
        address: sponsorKey.address,
        playerPaysIfRefused: false,
        async sign(wire) {
          fresh = wire;
          throw Object.assign(new Error('kept for the test'), { refused: true });
        },
      },
    });
    await assert.rejects(keeper.buy('badge', { listing: shop.find(l => l.key === 'badge') }), /kept for the test/);
    const passes = await checkSponsored(fresh, { rpc, project, sponsor: sponsorKey.address });
    assert.ok(passes.ok, passes.reason);
    assert.equal(passes.player, player.address);
    assert.ok(passes.topUp > 0n && passes.topUp <= passes.cost, 'what the player keeps is the step’s fees and rent');

    // A priced item: the sponsor won't pay the price, so a player with no SOL can't have it.
    await assert.rejects(app.buy('cat', { listing: shop.find(l => l.key === 'cat') }));
    // With SOL of their own, the player pays the price and only the price.
    w.chain.airdrop(player.address, 1_000_000_000n);
    const before = await balance(player.address);
    const cat = await app.buy('cat', { listing: (await app.shop()).find(l => l.key === 'cat') });
    assert.ok(cat.asset);
    assert.equal(before - (await balance(player.address)), 3_000_000n, 'the player paid the price, 0.003 SOL, alone');

    // The server's refusals, each on a transaction a page could send it.
    const { blockhash } = await rpc.latestBlockhash();
    const check = (instructions, more = {}) =>
      checkSponsored(wireTransaction(compileMessage({ payer: sponsorKey.address, blockhash, instructions })), {
        rpc,
        project,
        sponsor: sponsorKey.address,
        ...more,
      });
    // A loot instruction naming the project: each refusal below comes before the dry run, so it need not be one that runs.
    const ours = {
      programId: loot.LOOT_PROGRAM,
      keys: [
        { pubkey: project, isSigner: false, isWritable: false },
        { pubkey: player.address, isSigner: true, isWritable: true },
      ],
      data: Uint8Array.of(0),
    };

    const topUpOnly = await check([
      sponsorTopUp(sponsorKey.address, player.address, 1000n),
      transferLamports(player.address, player.address, 0n),
    ]);
    assert.equal(topUpOnly.ok, false);
    assert.match(topUpOnly.reason, /nothing in this project/);

    const named = await check([
      sponsorTopUp(sponsorKey.address, player.address, 1000n),
      { ...ours, keys: [...ours.keys, { pubkey: sponsorKey.address, isSigner: false, isWritable: true }] },
    ]);
    assert.match(named.reason, /named in an instruction other than the top-up/);

    const twice = await check([
      sponsorTopUp(sponsorKey.address, player.address, 1000n),
      ours,
      transferLamports(sponsorKey.address, player.address, 1000n),
    ]);
    assert.match(twice.reason, /more than once/);

    const elsewhere = await check([sponsorTopUp(sponsorKey.address, freshKeypair().address, 1000n), ours]);
    assert.match(elsewhere.reason, /doesn’t sign it/);

    const priority = await check([
      { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) },
      sponsorTopUp(sponsorKey.address, player.address, 1000n),
      ours,
    ]);
    assert.match(priority.reason, /priority fee/);

    const direct = await check([
      sponsorTopUp(sponsorKey.address, player.address, 1000n),
      ours,
      transferLamports(player.address, loot.pda.fees(project), 1000n),
    ]);
    assert.match(direct.reason, /fee box or the oracle straight/);

    // Rent counts only for what the step's own loot instructions open: a token account of a mint none of them names
    // (one the player could close later for its rent) is not a cost the sponsor pays.
    const mint = freshKeypair().address;
    const shape = { programs: [loot.LOOT_PROGRAM], lootNamed: [project] };
    const tokenAccount = { owner: TOKEN_PROGRAM, lamports: 2_039_280, data: new Uint8Array(165) };
    tokenAccount.data.set(decodeBase58(mint), 0);
    const opened = { addresses: ['x'], pre: [null], post: [tokenAccount], project };
    assert.equal(sponsoredCost({ ...opened, ...shape }), 0n);
    assert.equal(sponsoredCost({ ...opened, ...shape, lootNamed: [project, mint] }), 2_039_280n);

    const tooMuch = await check([sponsorTopUp(sponsorKey.address, player.address, 50_000_000n), ours]);
    assert.match(tooMuch.reason, /more than the 10000000 it pays a transaction/);

    // That transaction, its give-back cut: the player would keep the difference.
    const { message, signatures } = readTransaction(fresh);
    const transfers = [];
    for (let i = 0; i + 12 <= message.length; i++)
      if (message[i] === 2 && message[i + 1] === 0 && message[i + 2] === 0 && message[i + 3] === 0) {
        const v = new DataView(message.buffer, message.byteOffset + i + 4, 8).getBigUint64(0, true);
        if (v > 1_000_000n && v < 10_000_000n) transfers.push(i + 4);
      }
    assert.equal(transfers.length, 2, 'the badge’s transaction lends and gives back');
    const cut = Uint8Array.from(message);
    const view = new DataView(cut.buffer, transfers[1], 8);
    view.setBigUint64(0, view.getBigUint64(0, true) - 1_000_000n, true);
    const greedy = await checkSponsored(wireTransaction(cut, signatures), {
      rpc,
      project,
      sponsor: sponsorKey.address,
    });
    assert.equal(greedy.ok, false);
    assert.match(greedy.reason, /they would keep some/);

    // A budget the project keeps (per player, per day) has the last word.
    const spent = await checkSponsored(fresh, {
      rpc,
      project,
      sponsor: sponsorKey.address,
      budget: () => false,
    });
    assert.equal(spent.ok, false);
    assert.match(spent.reason, /paid as much as it pays/);
  },
);

test(
  'sponsored, a player with no SOL opens a free box: the oracle’s fee and the rent are the sponsor’s, and the player settles',
  { skip: skip ?? false },
  async () => {
    const w = world({ project: false, seed: 'sponsor-box' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    const sponsorKey = freshKeypair();
    const player = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    w.chain.airdrop(sponsorKey.address, 1_000_000_000n);
    const live = await goLive(w, owner, SPEC);
    const rpc = w.chain.rpc;
    const server = sponsorSigner({ rpc, project: live.live.project, sponsor: sponsorKey });
    let signed = 0;
    const sponsor = {
      address: sponsorKey.address,
      playerPaysIfRefused: false,
      async sign(wire) {
        signed++;
        return server.sign(wire);
      },
    };
    let prompts = 0;
    const wallet = {
      ...asWallet(player),
      signTransaction: wire => (prompts++, asWallet(player).signTransaction(wire)),
    };
    const app = solanaApp({ spec: live, rpc, wallet, now: () => w.chain.now(), sponsor });

    const before = BigInt(await rpc.balance(sponsorKey.address));
    const got = await app.openBox('crate', { maxPrice: 0n });
    assert.ok(typeof got.settled === 'string' && got.settled.length > 40, 'opened, rolled and settled');
    assert.equal(await rpc.account(got.order), null, 'the order is settled and closed');
    for (const asset of got.assets.filter(Boolean))
      assert.equal(parseCoreAsset((await rpc.account(asset)).data).owner, player.address, 'a gem won is the player’s');
    assert.equal(prompts, 2, 'two prompts: the open (with its ask), then the settle');
    assert.equal(signed, 2, 'the sponsor signed both');
    assert.ok(BigInt(await rpc.balance(sponsorKey.address)) < before, 'and paid for them');
    // What the player holds now is only what the program gave back: the order's rent, at its settle.
    assert.ok(BigInt(await rpc.balance(player.address)) <= 3_000_000n);
  },
);
