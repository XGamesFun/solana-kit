// js/play's claimWins against a results server's answers: it reads every page of a wallet's wins, claims a win paid
// by a list with the proof and round the server gives, keeps going past a claim that fails, skips a round already
// paid, and claims a stash drop's NFT signed in (POST /v1/claims with the player's token).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun();
const hex = (bytes) => Buffer.from(bytes).toString('hex');

const asWallet = (kp) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

test('claimWins reads every page, claims a list win with its round, and keeps going past a failed claim', { skip: skip ?? false }, async () => {
  const w = world({ project: false, seed: 'wins' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  const player = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  w.chain.airdrop(player.address, 100_000_000_000n);
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Wins test',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Wins test' },
    pools: [{ key: 'prizes', currency: 'sol', seed: 0.5 }],
    grants: [{ key: 'wins', name: 'Wins', gives: { pool: 'prizes', amount: 0.01 }, list: [owner.address], limits: { perWallet: 10 }, fund: 0.05 }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-wins-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const chain = approvalChain(w);
  const session = await createApproval({ file, chain, now: () => NOW });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const sign = (b64) => {
      const t = readTransaction(fromBase64(b64));
      const s = [...t.signatures];
      s[t.signers.indexOf(owner.address)] = owner.sign(t.message);
      return toBase64(wireTransaction(t.message, s));
    };
    await session.complete(owner.address, batch.id, batch.transactions.map(sign));
  }
  const live = JSON.parse(readFileSync(file, 'utf8'));
  const game = (live.live.project ?? live.live.game);
  const id = live.grants[0].id;
  const address = loot.pda.grant(game, id);

  // A draw's winners: the owner writes the list of round R1 as the grant's root.
  const r1 = '11'.repeat(16);
  const r2 = '22'.repeat(16);
  const r3 = '33'.repeat(16);
  const leaves = [loot.listLeaf(player.address, null, r1)];
  const g = loot.decode('Grant', w.chain.get(address).data);
  const args = { gives: g.gives, vouchers: g.vouchers, list_root: loot.merkleRoot(leaves), key_root: g.key_root, open: g.open, limits: g.limits, active: g.active, gate: g.gate };
  w.chain.send(owner.address, [loot.upsertIx({ owner: owner.address, project: game, def: { Grant: { id, args } } })]);

  // The results server: two pages of wins, a list win on the first, a voucher that does not verify on the second, and
  // a stash drop's check-in whose NFT is given only at a signed-in claim (R-SIGN-IN).
  const server = 'https://results.example';
  const signIn = { error: { code: 'R-SIGN-IN', why: 'This drop’s NFTs go to the players who claim first, and a claim is made with your sign-in.' } };
  const bad = { grant: id, incarnation: g.incarnation.toString(), expires: NOW + 3600, publicKey: owner.address, signature: new Uint8Array(64), personHash: null };
  const answers = {
    [`/v1/wins?game=${game}&wallet=${player.address}`]: { wins: [{ round: r1, grant: id }], next: 'p2' },
    [`/v1/wins?game=${game}&wallet=${player.address}&before=p2`]: { wins: [{ round: r2, grant: id }, { round: r3, grant: id, kind: 'participation' }], next: null },
    [`/v1/vouchers?game=${game}&round=${r3}&wallet=${player.address}`]: { status: 409, body: signIn },
    [`/v1/vouchers?game=${game}&round=${r1}&wallet=${player.address}`]: { vouchers: [{ wallet: player.address, grant: id, list: true, proof: `${server}/v1/draws/${game}/${r1}/list?grant=${id}` }] },
    [`/v1/draws/${game}/${r1}/list?grant=${id}`]: { grant: id, round: r1, root: hex(loot.merkleRoot(leaves)), winners: [{ wallet: player.address, place: 0, personHash: '00'.repeat(32), proof: [] }] },
    [`/v1/vouchers?game=${game}&round=${r2}&wallet=${player.address}`]: { vouchers: [{ grant: id, incarnation: g.incarnation.toString(), round: r2, expires: NOW + 3600, publicKey: owner.address, signature: new Uint8Array(64), personHash: null }] },
  };
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST' && url === `${server}/v1/claims`) {
      posted.push(JSON.parse(init.body));
      // a sign-in that ran out: the server refuses it
      if (JSON.parse(init.body).token === 'run-out') return { ok: false, status: 403, json: async () => ({ error: { code: 'R-SIGNED', why: 'That sign-in token is not the play host’s, is for another game, or has run out.' } }) };
      // the signed-in claim: this wallet's voucher (one that does not verify here), and one for another wallet, left out
      return { ok: true, status: 200, json: async () => ({ vouchers: [{ ...bad, wallet: owner.address, round: r3 }, { ...bad, wallet: player.address, round: r3 }] }) };
    }
    const found = answers[url.replace(server, '')];
    const { status, body } = found?.status ? found : { status: found ? 200 : 404, body: found };
    return { ok: status === 200, status, json: async () => body ?? { error: { why: 'none' } } };
  };

  const app = solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() });
  const before = await w.chain.rpc.balance(player.address);
  const first = await app.claimWins({ server, fetchImpl });
  assert.deepEqual(first.map((x) => [x.round, x.grant, Boolean(x.signature), Boolean(x.error)]), [[r1, id, true, false], [r2, id, false, true], [r3, id, false, true]]);
  assert.equal(first[2].error, signIn.error.why, 'no sign-in: the stash drop says to claim signed in, and the rest go on');
  assert.deepEqual(posted, [], 'nothing claimed without the token');
  assert.ok((await w.chain.rpc.balance(player.address)) > before, 'the list win paid the player');
  const again = await app.claimWins({ server, token: 'the-play-host-token', fetchImpl });
  assert.deepEqual(again.map((x) => [x.round, Boolean(x.error)]), [[r2, true], [r3, true]], 'the list round is paid once, and skipped after');
  assert.deepEqual(posted, [{ game, round: r3, token: 'the-play-host-token' }], 'with the token, the stash drop is claimed signed in');
  assert.notEqual(again[1].error, signIn.error.why, 'its voucher (this wallet’s only) went to the claim');
  // A refused signed-in claim (a sign-in that ran out) is that win's error line,
  // never a rejection that stops the wins after it
  const ranOut = await app.claimWins({ server, token: 'run-out', fetchImpl });
  assert.deepEqual(ranOut.map((x) => [x.round, Boolean(x.error)]), [[r2, true], [r3, true]]);
  assert.match(ranOut[1].error, /has run out/);
});
