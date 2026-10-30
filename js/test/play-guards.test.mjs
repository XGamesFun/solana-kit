// What keeps a player and a host server from paying or sending what they never saw: js/play buys tickets and listings
// only on the terms the page showed, claims a voucher that came as JSON, and puts every value it sends a results server
// inside its URL; js/results signs only vouchers that are JSON and still live.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { draws, fetchVouchers, newKey, newRound, signVoucher } from '../results/index.js';
import { cannotRun, collectible, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOW = 1_790_000_000;
const A = '11111111111111111111111111111111';
const B = 'SysvarC1ock11111111111111111111111111111111';
const ROUND = '00'.repeat(16);

function fixture(seed) {
  const w = world({ seed });
  w.upsert({ Item: { id: 1, args: collectible('Art') } });
  const spec = {
    version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }],
    live: { project: w.project, collection: w.collection },
    lotteries: [{ key: 'raffle', name: 'Art raffle', id: 1 }],
    grants: [{ key: 'prize', name: 'Prize', id: 1 }],
  };
  const appOf = (address) => solanaApp({ spec, rpc: w.chain.rpc, wallet: { address, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  return { w, appOf };
}

test('tickets are bought only on the terms shown: a price raised since is refused, never paid', { skip }, async () => {
  const { w, appOf } = fixture('guard-tickets');
  const art = w.make(1, w.creator);
  const drawsAt = w.chain.now() + 3600;
  await appOf(w.creator).raffle(1, art, { price: 1, drawsAt });
  const app = appOf(w.player);
  await assert.rejects(app.buyTickets('raffle', 1), /Say the terms the player was shown/);
  const shown = (await app.lotteries()).find((l) => l.key === 'raffle');
  assert.equal(shown.priceUnits, PRICE);
  assert.equal(shown.price, '1');
  // The owner doubles the price after the page showed it.
  const args = { price: 2n * PRICE, mint: w.mint, shares: [{ to: 'Treasury', bps: 10_000 }], places: [{ bps: 0, prize: { Held: [art] } }], ticket_mint: A, every: 0n, draws_at: BigInt(drawsAt), gate: null, per_wallet: 0, min_sold: 0n };
  w.chain.send(w.creator, [loot.upsertIx({ owner: w.creator, project: w.project, def: { Lottery: { id: 1, args } } })]);
  const before = w.balance(w.player);
  await assert.rejects(app.buyTickets('raffle', 1, { listing: shown }), /changed since the player was shown it/);
  await assert.rejects(app.buyTickets('raffle', 1, { maxPrice: PRICE }), /now costs 2, more than the 1/);
  await assert.rejects(app.buyTickets('raffle', 1, { listing: { ...shown, key: 'other' } }), /not “raffle”/);
  assert.equal(w.balance(w.player), before, 'nothing paid');
  // Shown the new price, the player buys.
  await app.buyTickets('raffle', 1, { listing: (await app.lotteries()).find((l) => l.key === 'raffle') });
  assert.equal(before - w.balance(w.player), 2n * PRICE);
});

test('a listing is bought or rented only on the terms shown: one listed again at a new price is refused', { skip }, async () => {
  const { w, appOf } = fixture('guard-listings');
  const art = w.make(1, w.creator);
  const seller = appOf(w.creator);
  const buyer = appOf(w.player);
  await seller.listForSale(art, { price: 1 });
  await assert.rejects(buyer.buyListing(art), /Say the terms the player was shown/);
  const shown = await buyer.listing(art);
  await assert.rejects(buyer.rentListing(art, { listing: shown }), /for sale, not for rent/);
  await seller.unlist(art);
  await seller.listForSale(art, { price: 3 });
  const before = w.balance(w.player);
  await assert.rejects(buyer.buyListing(art, { listing: shown }), /changed since the player was shown it/);
  assert.equal(w.balance(w.player), before, 'nothing paid');
  await buyer.buyListing(art, { listing: await buyer.listing(art) });
  assert.equal(before - w.balance(w.player), 3n * PRICE);
  await assert.rejects(buyer.rentListing(art), /Say the terms the player was shown/);
});

test('a voucher is plain JSON (its incarnation as text), and js/play claims it as a server would send it', { skip }, async () => {
  const { w, appOf } = fixture('guard-voucher');
  const host = await newKey();
  const limits = { wallet: { total: 5, per_window: 0, window: 0 }, per_person: 0, per_key: 0, per_day: 0, total: 0, window: { opens_at: 0n, closes_at: 0n } };
  w.upsert({ Grant: { id: 1, args: { gives: { Item: [1] }, vouchers: [host.address, A, A], list_root: new Uint8Array(32), limits, active: true, gate: null } } });
  const { incarnation } = w.read('Grant', loot.pda.grant(w.project, 1));
  assert.equal(typeof incarnation, 'bigint');
  const voucher = await signVoucher({ signer: host, game: w.project, grant: 1, incarnation, wallet: w.player, round: newRound(), now: w.chain.now() });
  assert.equal(voucher.incarnation, String(incarnation));
  await appOf(w.player).claimGrant('prize', { voucher: JSON.parse(JSON.stringify(voucher)) });
  assert.equal((await appOf(w.player).collectibles()).length, 1);
});

test('a voucher lives some seconds from now: none, or fewer, is refused', async () => {
  const signer = await newKey();
  for (const seconds of [0, -100]) await assert.rejects(signVoucher({ signer, game: A, grant: 1, incarnation: 0n, wallet: B, round: ROUND, now: NOW, seconds }), /above 0/);
});

test('every value sent to a results server stays inside its URL', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return Response.json({ vouchers: [], draw: { entries: [] }, wins: [] });
  };
  await fetchVouchers({ server: 'https://r.invalid', game: A, round: 'x&wallet=evil', wallet: B, fetchImpl });
  assert.equal(new URL(asked.at(-1)).searchParams.get('round'), 'x&wallet=evil');
  await draws.get({ server: 'https://r.invalid', game: A, draw: '../../admin', fetchImpl });
  assert.equal(new URL(asked.at(-1)).pathname, `/v1/draws/${A}/..%2F..%2Fadmin`);
  for (const draw of ['..', '.', '']) await assert.rejects(draws.get({ server: 'https://r.invalid', game: A, draw, fetchImpl }), /part of a path/);
  // js/play's claimWins: the page a server names next is one value, never more of the query.
  const pages = [{ wins: [], next: 'p2&wallet=evil' }, { wins: [] }];
  const app = solanaApp({ spec: { version: 2, tokens: [], live: { project: A } }, rpc: { call: async () => null }, wallet: { address: B } });
  asked.length = 0;
  await app.claimWins({ server: 'https://r.invalid', fetchImpl: async (url) => (asked.push(url), Response.json(pages.shift())) });
  const second = new URL(asked[1]).searchParams;
  assert.equal(second.get('before'), 'p2&wallet=evil');
  assert.deepEqual(second.getAll('wallet'), [B]);
});

test('a custom rpc with no call() is refused at once, in words', () => {
  assert.throws(() => solanaApp({ spec: { version: 2, tokens: [], live: { project: A } }, rpc: { account: async () => null }, wallet: { address: B } }), /no call\(method, params\)/);
});

test('a list’s proof is fetched only from the results server’s own origin', async () => {
  const spec = { version: 2, tokens: [], live: { project: A }, grants: [{ key: 'prize', name: 'Prize', id: 1 }] };
  const app = solanaApp({ spec, rpc: { call: async () => null }, wallet: { address: B } });
  const server = 'https://r.invalid/base';
  /** What claimWins asked for, past the wins and vouchers, with the proof the server names. */
  const run = async (proof) => {
    const asked = [];
    const fetchImpl = async (url) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith('/v1/wins')) return Response.json({ wins: [{ round: ROUND, grant: 1 }] });
      if (pathname.endsWith('/v1/vouchers')) return Response.json({ vouchers: [{ wallet: B, grant: 1, list: true, proof }] });
      asked.push(url);
      return Response.json({ grant: 1, round: ROUND, winners: [] });
    };
    return { out: await app.claimWins({ server, fetchImpl }), asked };
  };
  for (const proof of ['https://elsewhere.invalid/list', '//elsewhere.invalid/list', 'http://r.invalid/base/list', 'https://r.invalid.elsewhere.invalid/list', 'javascript:alert(1)', 'data:application/json,{}']) {
    const { out, asked } = await run(proof);
    assert.deepEqual(asked, [], `${proof} is never fetched`);
    assert.equal(out.length, 1);
    assert.match(out[0].error, /not on the server itself \(https:\/\/r\.invalid\): it was not fetched/);
  }
  assert.deepEqual((await run('/v1/draws/g/r/list?grant=1')).asked, ['https://r.invalid/base/v1/draws/g/r/list?grant=1'], 'a path is on the server');
  assert.deepEqual((await run('https://r.invalid/base/v1/draws/g/r/list')).asked, ['https://r.invalid/base/v1/draws/g/r/list'], 'a whole URL on its origin');
  assert.deepEqual((await run('https://r.invalid/base/v1/draws/g/r/list')).out, [], 'nothing to claim, nothing refused');
});
