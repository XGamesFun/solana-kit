// @xgamesfun/solana/results' server checks: a wallet's signed proof (made, signed as a wallet signs a message, checked;
// a tampered, expired or someone else's proof refused), promo codes (enough randomness, read forgivingly, a key each),
// a code's voucher paying once on the real program, which of the game's collectibles a wallet holds, and whether a win
// was paid already (the same win signed for a second wallet pays again: the server reads the first wallet's).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBase58 } from '../chain/base58.js';
import * as loot from '../client/index.js';
import {
  codeAddresses,
  codeKey,
  codeVoucher,
  collectiblesOf,
  holds,
  makeCodes,
  newKey,
  normalizeCode,
  proofRequest,
  readProof,
  signVoucher,
  verifyProof,
  winPaid,
} from '../results/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_800_000_000;
const GAME = 'Game111111111111111111111111111111111111111';

test('a wallet proof: the server asks, the wallet signs the text, the server checks it; anything else is refused in words', async () => {
  const wallet = await newKey();
  const other = await newKey();
  const ask = proofRequest({ game: GAME, wallet: wallet.address, purpose: 'link to player 42', now: NOW });
  assert.match(ask.nonce, /^[0-9a-f]{32}$/);
  assert.equal(ask.expires, NOW + 300);
  assert.deepEqual(readProof(ask.text), {
    cluster: loot.cluster(),
    game: GAME,
    wallet: wallet.address,
    purpose: 'link to player 42',
    nonce: ask.nonce,
    expires: NOW + 300,
  });
  const signature = await wallet.sign(new TextEncoder().encode(ask.text));
  const ok = await verifyProof({
    text: ask.text,
    signature,
    wallet: wallet.address,
    game: GAME,
    purpose: 'link to player 42',
    now: NOW + 10,
  });
  assert.equal(ok.nonce, ask.nonce);
  await assert.rejects(
    verifyProof({ text: ask.text, signature, wallet: wallet.address, game: GAME, now: NOW + 301 }),
    /expired/,
  );
  await assert.rejects(
    verifyProof({ text: ask.text, signature, wallet: other.address, game: GAME, now: NOW }),
    /another wallet/,
  );
  await assert.rejects(
    verifyProof({
      text: ask.text,
      signature,
      wallet: wallet.address,
      game: 'Other1111111111111111111111111111111111111',
      now: NOW,
    }),
    /another game/,
  );
  await assert.rejects(
    verifyProof({ text: ask.text, signature, wallet: wallet.address, game: GAME, purpose: 'sign in', now: NOW }),
    /something else/,
  );
  // another wallet's signature of the same text, and the text changed after signing
  await assert.rejects(
    verifyProof({
      text: ask.text,
      signature: await other.sign(new TextEncoder().encode(ask.text)),
      wallet: wallet.address,
      game: GAME,
      now: NOW,
    }),
    /not that wallet/,
  );
  await assert.rejects(
    verifyProof({
      text: ask.text.replace('player 42', 'player 43'),
      signature,
      wallet: wallet.address,
      game: GAME,
      now: NOW,
    }),
    /not that wallet/,
  );
  await assert.rejects(
    verifyProof({ text: 'hello', signature, wallet: wallet.address, game: GAME, now: NOW }),
    /not a wallet proof/,
  );
});

test('promo codes: 80 bits by default, never fewer than 64; read forgivingly; each its own key, always the same', async () => {
  const codes = makeCodes(20);
  assert.equal(new Set(codes).size, 20);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.throws(() => makeCodes(1, { bits: 40 }), /at least 64 bits/);
  assert.equal(makeCodes(1, { bits: 100, group: 0 })[0].length, 20);
  assert.equal(normalizeCode(' abcd-efgh-ijkl-mnop '), 'ABCDEFGH1JK1MN0P');
  const key = await codeKey(codes[0]);
  assert.equal(
    (await codeKey(codes[0].toLowerCase().replace(/-/g, ' '))).address,
    key.address,
    'the same code, typed loosely',
  );
  assert.notEqual((await codeKey(codes[1])).address, key.address);
  assert.deepEqual(await codeAddresses(codes.slice(0, 2)), [key.address, (await codeKey(codes[1])).address]);
  await assert.rejects(codeKey('not a code!'), /not a code/);
});

test('a code’s voucher pays its wallet on the program, once', { skip }, async () => {
  const w = world();
  w.upsert({ Item: { id: 7, args: collectible('Flyer Prize') } });
  const [code] = makeCodes(1);
  const key = await codeKey(code);
  const nobody = '11111111111111111111111111111111';
  const limits = {
    wallet: { total: 5, per_window: 0, window: 0 },
    per_person: 0,
    per_key: 0,
    all: { total: 0, per_window: 0, window: 0 },
    window: { opens_at: 0n, closes_at: 0n },
  };
  w.upsert({
    Grant: {
      id: 1,
      args: {
        gives: { Item: [7] },
        vouchers: [key.address, nobody, nobody],
        list_root: new Uint8Array(32),
        limits,
        active: true,
        gate: null,
      },
    },
  });
  const address = loot.pda.grant(w.project, 1);
  w.chain.airdrop(address, 1_000_000_000n);
  const { incarnation } = w.read('Grant', address);
  const wallet = w.who();
  const claim = async count => {
    const v = await codeVoucher({ code, game: w.project, grant: 1, incarnation, wallet, now: w.chain.now() });
    const message = loot.voucherBytes({
      grant: address,
      incarnation,
      wallet,
      personHash: v.personHash,
      round: v.round,
      expires: v.expires,
    });
    const check = loot.ed25519Ix({ publicKey: v.publicKey, signature: decodeBase58(v.signature), message });
    return w.chain.send(w.cranker, [
      check,
      loot.claimGrantIx({
        project: w.project,
        id: 1,
        grant: w.read('Grant', address),
        wallet,
        signer: w.cranker,
        count,
        round: v.round,
        expires: v.expires,
        personHash: v.personHash,
        projectState: w.projectState(),
        item: w.read('Item', loot.pda.item(w.project, 7)),
      }),
    ]);
  };
  await claim(0);
  assert.ok(w.chain.get(loot.pda.itemAsset(loot.pda.item(w.project, 7), 1)), 'the prize was minted');
  await assert.rejects(claim(1), /AlreadyClaimed/, 'the same code twice pays once: its round is the code’s');
});

test(
  'a win is paid once to a wallet, and again to another: winPaid reads the first before a server signs it again',
  { skip },
  async () => {
    const w = world();
    w.upsert({ Item: { id: 7, args: collectible('Round Prize') } });
    const host = await newKey();
    const nobody = '11111111111111111111111111111111';
    w.upsert({
      Grant: {
        id: 1,
        args: {
          gives: { Item: [7] },
          vouchers: [host.address, nobody, nobody],
          list_root: new Uint8Array(32),
          limits: {
            wallet: { total: 0, per_window: 0, window: 0 },
            per_person: 0,
            per_key: 0,
            all: { total: 0, per_window: 0, window: 0 },
            window: { opens_at: 0n, closes_at: 0n },
          },
          active: true,
          gate: null,
        },
      },
    });
    const address = loot.pda.grant(w.project, 1);
    w.chain.airdrop(address, 1_000_000_000n);
    const { incarnation } = w.read('Grant', address);
    const [first, second] = [w.who(), w.who()];
    const round = 'ab'.repeat(16);
    const paid = wallet => winPaid({ rpc: w.chain.rpc, game: w.project, grant: 1, wallet, round });
    const claim = async (wallet, count) => {
      const v = await signVoucher({
        signer: host,
        game: w.project,
        grant: 1,
        incarnation,
        wallet,
        round,
        now: w.chain.now(),
      });
      const message = loot.voucherBytes({
        grant: address,
        incarnation,
        wallet,
        personHash: v.personHash,
        round,
        expires: v.expires,
      });
      return w.chain.send(w.cranker, [
        loot.ed25519Ix({ publicKey: v.publicKey, signature: decodeBase58(v.signature), message }),
        loot.claimGrantIx({
          project: w.project,
          id: 1,
          grant: w.read('Grant', address),
          wallet,
          signer: w.cranker,
          count,
          round,
          expires: v.expires,
          personHash: v.personHash,
          projectState: w.projectState(),
          item: w.read('Item', loot.pda.item(w.project, 7)),
        }),
      ]);
    };
    assert.equal(await paid(first), false, 'nothing paid yet');
    await claim(first, 0);
    assert.equal(await paid(first), true, 'the first wallet collected, whatever it tells the server');
    assert.equal(await paid(second), false, 'the chain keeps the round with its wallet');
    await assert.rejects(claim(first, 1), /AlreadyClaimed/, 'the same wallet, the same win: once');
    // what a server that goes by the voucher's expiry alone would do: sign the same win for a second wallet
    await claim(second, 1);
    assert.ok(w.chain.get(loot.pda.itemAsset(loot.pda.item(w.project, 7), 2)), 'the same win paid a second wallet');
    await assert.rejects(winPaid({ rpc: w.chain.rpc, game: w.project, grant: 9, wallet: first, round }), /no grant 9/);
  },
);

test(
  'what a wallet holds: the game’s collectibles by their key, and holds() for an item, an attribute or any',
  { skip },
  async () => {
    const w = world();
    w.upsert({ Item: { id: 3, args: collectible('Pass') } });
    w.upsert({ Item: { id: 4, args: collectible('Hat') } });
    const player = w.who();
    w.make(3, player, [{ key: 'level', value: '5' }]);
    w.make(4, player);
    const spec = {
      live: { project: w.project, collection: w.collection },
      items: [
        { key: 'pass', id: 3 },
        { key: 'hat', id: 4 },
      ],
    };
    const mine = await collectiblesOf({ rpc: w.chain.rpc, spec, wallet: player });
    assert.deepEqual(mine.map(c => c.item).sort(), ['hat', 'pass']);
    assert.equal(await holds({ rpc: w.chain.rpc, spec, wallet: player, item: 'pass' }), 1);
    assert.equal(
      await holds({ rpc: w.chain.rpc, spec, wallet: player, item: 'pass', attribute: 'level', minimum: 6 }),
      0,
    );
    assert.equal(await holds({ rpc: w.chain.rpc, spec, wallet: player }), 2, 'any of the game’s collectibles');
    assert.equal(await holds({ rpc: w.chain.rpc, spec, wallet: w.who(), item: 'pass' }), 0, 'someone else holds none');
    await assert.rejects(
      collectiblesOf({ rpc: w.chain.rpc, spec: { items: [] }, wallet: player }),
      /names no collection/,
    );
  },
);
