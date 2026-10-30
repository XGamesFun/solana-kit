// @xgamesfun/solana/results: the client a game uses with a results server. The bytes and texts it signs are the
// ones a server checks, a host key it makes signs as the program expects, and a voucher a host signs itself pays its
// winner on the real program once: the same round signed again is refused.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';
import { addressBytes, decodeBase58 } from '../chain/base58.js';
import { fromHex, readUintLE, utf8 } from '../chain/bytes.js';
import { MPL_CORE_PROGRAM } from '../chain/core.js';
import * as loot from '../client/index.js';
import { giveawayHostText, hostCertText, keyFromSecret, RESULTS_SERVER, newKey, newRound, NO_GRANT, report, RESULT_DOMAIN, resultBytes, signResult, signVoucher } from '../results/index.js';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const verifies = (address, message, signature) =>
  verify(null, Buffer.from(message), createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(addressBytes(address))]), format: 'der', type: 'spki' }), Buffer.from(typeof signature === 'string' ? decodeBase58(signature) : signature));

test('a result’s bytes: the domain, the cluster, the game, the round, when it ended, each winner with their place and grant', async () => {
  const [game, a, b] = await Promise.all([newKey(), newKey(), newKey()]);
  const round = newRound();
  assert.match(round, /^[0-9a-f]{32}$/);
  const bytes = resultBytes({ game: game.address, round, endedAt: 1_800_000_000, winners: [{ wallet: a.address, place: 1, grant: 3 }, { wallet: b.address, place: 2 }] });
  assert.equal(bytes.length, RESULT_DOMAIN.length + 1 + 32 + 16 + 8 + 1 + 2 * 35);
  let at = RESULT_DOMAIN.length;
  assert.deepEqual([...bytes.subarray(0, at)], [...utf8(RESULT_DOMAIN)]);
  assert.equal(bytes[at], 0, 'devnet');
  assert.deepEqual([...bytes.subarray(at + 1, at + 33)], [...addressBytes(game.address)]);
  assert.deepEqual([...bytes.subarray(at + 33, at + 49)], [...fromHex(round)]);
  assert.equal(readUintLE(bytes, at + 49, 8), 1_800_000_000n);
  at += 57;
  assert.equal(bytes[at], 2);
  assert.equal(readUintLE(bytes, at + 1 + 33, 2), 3n);
  assert.equal(readUintLE(bytes, at + 1 + 35 + 33, 2), BigInt(NO_GRANT), 'no prize for that place');
  const signed = await signResult(game, { game: game.address, round, endedAt: 1_800_000_000, winners: [{ wallet: a.address, place: 1, grant: 3 }, { wallet: b.address, place: 2 }] });
  assert.ok(verifies(game.address, bytes, signed.signature));
});

test('the texts an owner signs read as they are checked, line by line; a host key kept as its secret is the same key', async () => {
  const [game, host] = [await newKey(), await newKey()];
  assert.equal(hostCertText({ game: game.address, host: host.address, until: 42 }), `loot host key\ncluster: devnet\ngame: ${game.address}\nhost: ${host.address}\nuntil: 42`);
  assert.equal(giveawayHostText({ game: game.address, who: 'x:123', slug: 'rattlepost', grant: 5, until: 42 }), `loot giveaway host\ncluster: devnet\ngame: ${game.address}\nwho: x:123\nslug: rattlepost\ngrant: 5\nuntil: 42`);
  const kept = await keyFromSecret(host.secret);
  assert.equal(kept.address, host.address);
  const message = utf8('hello');
  assert.ok(verifies(host.address, message, await kept.sign(message)));
  assert.equal(RESULTS_SERVER, 'https://play.xgames.fun/xsolana');
});

test('report posts the signed result and answers the server’s refusal as its code', async () => {
  const [game, host, winner] = await Promise.all([newKey(), newKey(), newKey()]);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, JSON.parse(init.body)]);
    return Response.json({ error: { code: 'R-CERT', why: 'not the owner' } }, { status: 403 });
  };
  const round = newRound();
  await assert.rejects(report({ server: 'https://results.test/loot/', fetchImpl, cert: { text: 't', signature: 's' }, signer: host, game: game.address, round, endedAt: 1, winners: [{ wallet: winner.address, place: 1, grant: 1 }] }), (e) => e.code === 'R-CERT' && e.status === 403);
  assert.equal(seen[0][0], 'https://results.test/loot/v1/results');
  assert.ok(verifies(host.address, resultBytes({ game: game.address, round, endedAt: 1, winners: seen[0][1].winners }), seen[0][1].signatures[0].signature));
});

test('a host’s own voucher pays its winner on the program, once: the same round signed again later is refused', { skip }, async () => {
  const w = world();
  w.upsert({ Item: { id: 7, args: collectible('Trophy') } });
  const host = await newKey();
  const nobody = '11111111111111111111111111111111';
  const limits = { wallet: { total: 5, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 1, args: { gives: { Item: [7] }, vouchers: [host.address, nobody, nobody], list_root: new Uint8Array(32), limits, active: true, gate: null } } });
  const address = loot.pda.grant(w.project, 1);
  w.chain.airdrop(address, 1_000_000_000n);
  const { incarnation } = w.read('Grant', address);
  const wallet = w.who();
  const round = newRound();
  const claim = (v, count) => {
    const message = loot.voucherBytes({ grant: address, incarnation, wallet, personHash: v.personHash, round: v.round, expires: v.expires });
    assert.ok(verifies(v.publicKey, message, v.signature));
    const check = loot.ed25519Ix({ publicKey: v.publicKey, signature: decodeBase58(v.signature), message });
    return w.chain.send(w.cranker, [check, loot.claimGrantIx({ project: w.project, id: 1, grant: w.read('Grant', address), wallet, signer: w.cranker, count, round: v.round, expires: v.expires, personHash: v.personHash, projectState: w.projectState(), item: w.read('Item', loot.pda.item(w.project, 7)) })]);
  };
  const voucher = await signVoucher({ signer: host, game: w.project, grant: 1, incarnation, wallet, round, now: w.chain.now() });
  claim(voucher, 0);
  assert.equal(w.chain.get(loot.pda.itemAsset(loot.pda.item(w.project, 7), 1)).owner, MPL_CORE_PROGRAM);
  const later = await signVoucher({ signer: host, game: w.project, grant: 1, incarnation, wallet, round, now: w.chain.now() + 3_600 });
  assert.throws(() => claim(later, 1), /AlreadyClaimed/);
  await assert.rejects(signVoucher({ signer: host, game: w.project, grant: 1, incarnation, wallet, round, now: 0, seconds: 31 * 86_400 }), /30 days/);
});
