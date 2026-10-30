// loot hands a Token Metadata NFT to a wallet through Token Metadata's TransferV1, into the token account the
// sender passes. A holder can hand their own associated token account to another key (SPL SetAuthority AccountOwner);
// Token Metadata then refuses that account as the destination, so a hand-out with the standard accounts fails for
// everyone. A cancelled lottery whose tickets are NFTs gives each ticket back to its buyer, and a buyer who
// spoiled their account holds the round (nothing pending reaches 0) and so the next round. The client hands the NFT
// into a fresh token account of the buyer's, opened in the same transaction, and the round goes on. Run against the
// real Token Metadata program (`js/test/fixtures/token_metadata.so`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, transferLamports } from '../chain/programs.js';
import { rpcClient } from '../chain/rpc.js';
import { setAuthorityIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, collectible } from './world.mjs';
import { nftOf, ownerOf, setup } from './tm-chain.mjs';

const skip = cannotRun() ?? false;
const TM = loot.TOKEN_METADATA_PROGRAM;
const DAY = 86_400;
/** `who` hands the ownership of their associated token account of `mint` to `to` (the spoil). */
const spoil = (w, who, mint, to) => w.chain.send(who, [
  createAssociatedTokenAccountIdempotent(who, who, mint),
  setAuthorityIx({ account: loot.ata(who, mint), current: who, kind: 2, newAuthority: to }),
]);

test('a cancelled NFT-ticket lottery is held by a buyer who spoiled their account, until the ticket goes into a fresh one', { skip }, async () => {
  const { w, maker, club } = setup('handout-lottery');
  const [a, b] = [w.who(), w.who()];
  const [ta, tb] = [nftOf(w, maker, a, club), nftOf(w, maker, b, club)];
  const id = 1;
  const address = loot.pda.lottery(w.project, id);
  const rule = { of: { Collection: [club] }, key: '', test: 'Any' };
  w.upsert({ Lottery: { id, args: { price: 0n, mint: w.mint, shares: [], places: [], ticket_mint: SYSTEM_PROGRAM, every: BigInt(DAY), draws_at: BigInt(w.chain.now() + DAY), gate: null, per_wallet: 0, nft_ticket: { rule, then: 'Burn' }, min_sold: 3n } } });
  const tm = { tokenMetadata: { programmable: false } };
  const buy = (who, asset, nonce) => w.chain.send(who, [computeUnitLimit(1_400_000), loot.buyTicketsIx({ player: who, project: w.project, id, lottery: w.read('Lottery', address), count: 1n, nonce, nft: { asset, ...tm } })]);
  buy(a, ta, 1n);
  buy(b, tb, 1n);
  assert.equal(w.chain.tokens(loot.ata(w.project, ta)), 1n, 'the project holds the ticket');
  // A hands their (empty) account of the ticket to a key nobody uses.
  const z = newAddress(w.random);
  spoil(w, a, ta, z);
  assert.equal(ownerOf(w, loot.ata(a, ta)), z);
  w.chain.warp(w.chain.now() + DAY);
  w.chain.send(w.cranker, [loot.drawLotteryIx({ payer: w.cranker, project: w.project, id })]);
  let lottery = w.read('Lottery', address);
  assert.equal(lottery.status, 'Cancelled', 'two tickets of the least three: cancelled');

  const contribution = (who) => loot.pda.contribution(address, who, 1n);
  const finish = (who, ticket = tm) => loot.finishLotteryContributionIx({ payer: w.cranker, project: w.project, id, lottery: w.read('Lottery', address), contributionAddress: contribution(who), contribution: w.read('LotteryContribution', contribution(who)), ticket });
  w.chain.send(w.cranker, [computeUnitLimit(1_400_000), finish(b)]);
  assert.equal(w.chain.tokens(loot.ata(b, tb)), 1n, 'B\'s ticket is home');

  // With the standard accounts (A's associated account), Token Metadata refuses the hand-out: the round stays open.
  assert.throws(() => w.chain.send(w.cranker, [computeUnitLimit(1_400_000), finish(a)]), (e) => (e.logs ?? []).some((l) => l.includes(TM)));
  lottery = w.read('Lottery', address);
  assert.deepEqual([lottery.status, Number(lottery.pending)], ['Cancelled', 1], 'nothing pending reaches 0: the next round never opens');
  const other = w.who();
  const t2 = nftOf(w, maker, other, club);
  assert.throws(() => buy(other, t2, 1n), 'nobody buys into the next round meanwhile');

  // The client: anyone returning the ticket (here B, through the player module) finds A's account can't take it, and
  // opens a fresh one of A's in the same transaction, which the NFT goes into.
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, lotteries: [{ key: 'raffle', name: 'Raffle', id }] };
  const app = solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: b, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  const claims = await app.claims();
  const refund = claims.find((c) => c.kind === 'ticket-refund' && c.contribution === contribution(a));
  assert.ok(refund, claims.map((c) => c.kind).join());
  await app.claim(refund);
  const fresh = loot.freshNftAccount({ payer: b, holder: a, mint: ta }).address;
  assert.deepEqual([w.chain.tokens(fresh), ownerOf(w, fresh)], [1n, a], 'A\'s ticket is in a fresh account A owns');
  lottery = w.read('Lottery', address);
  assert.deepEqual([lottery.status, Number(lottery.pending)], ['Open', 0], 'the next round opens');
  buy(other, t2, 2n);
  assert.equal(w.read('Lottery', address).sold, 1n);
});

test('a topped NFT bid goes back into a fresh account when its bidder\'s own can\'t take it', { skip }, async () => {
  const { w, maker, club } = setup('handout-bid');
  const [a, b] = [w.who(), w.who()];
  const x = nftOf(w, maker, a, club);
  const ys = [nftOf(w, maker, b, club), nftOf(w, maker, b, club)];
  w.upsert({ Item: { id: 1, args: collectible('Painting') } });
  const art = w.make(1, w.authority);
  const now = w.chain.now();
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, collection: w.collection, id: 1, mint: w.mint,
    args: { lot: { Asset: [art] }, reserve: 1n, min_raise_bps: 0, starts_at: BigInt(now), ends_at: BigInt(now + DAY), extend: 0, shares: [], gate: null, nft_bids: { of: { Collection: [club] }, key: '', test: 'Any' } } })]);
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, auctions: [{ key: 'lot', id: 1, seller: w.authority }] };
  const appOf = (who) => solanaApp({ spec, rpc: w.chain.rpc, wallet: { address: who, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  await appOf(a).bid('lot', null, { nfts: [x] });
  spoil(w, a, x, newAddress(w.random));
  // B's bid tops A's: A's NFT goes back to A, into a fresh account B opens.
  await appOf(b).bid('lot', null, { nfts: ys });
  const auction = w.read('Auction', loot.pda.auction(w.project, w.authority, 1));
  assert.equal(auction.high_bidder, b);
  const fresh = loot.freshNftAccount({ payer: b, holder: a, mint: x }).address;
  assert.deepEqual([w.chain.tokens(fresh), ownerOf(w, fresh)], [1n, a]);
});

// Two ways a fresh account could go wrong, on the bid above. If the player module put the page RPC's rent figure into
// the fresh account, which belongs to the outbid bidder, a lying RPC would move the sender's SOL to them. If the fresh
// addresses named only (payer, mint), CreateAccountWithSeed refuses an address that holds lamports, so the outbid
// bidder could send a little SOL to all 8 of a rival's addresses and the rival's bid would fail.
async function bidOverSpoiled(seed) {
  const { w, maker, club } = setup(seed);
  const [a, b] = [w.who(), w.who()];
  const x = nftOf(w, maker, a, club);
  const ys = [nftOf(w, maker, b, club), nftOf(w, maker, b, club)];
  w.upsert({ Item: { id: 1, args: collectible('Painting') } });
  const art = w.make(1, w.authority);
  const now = w.chain.now();
  w.chain.send(w.authority, [loot.openAuctionIx({ seller: w.authority, project: w.project, collection: w.collection, id: 1, mint: w.mint,
    args: { lot: { Asset: [art] }, reserve: 1n, min_raise_bps: 0, starts_at: BigInt(now), ends_at: BigInt(now + DAY), extend: 0, shares: [], gate: null, nft_bids: { of: { Collection: [club] }, key: '', test: 'Any' } } })]);
  const spec = { version: 2, currency: 'coin', tokens: [{ key: 'coin', source: 'existing', mint: w.mint, decimals: 6 }], live: { project: w.project, collection: w.collection }, auctions: [{ key: 'lot', id: 1, seller: w.authority }] };
  const appOf = (who, rpc = w.chain.rpc) => solanaApp({ spec, rpc, wallet: { address: who, async signTransaction(wire) { return wire; } }, now: () => w.chain.now() });
  await appOf(a).bid('lot', null, { nfts: [x] });
  spoil(w, a, x, newAddress(w.random));
  return { w, a, b, x, bid: (rpc) => appOf(b, rpc).bid('lot', null, { nfts: ys }) };
}

test('the fresh account gets the fixed rent, whatever the page\'s RPC says it is', { skip }, async () => {
  const { w, a, b, x, bid } = await bidOverSpoiled('handout-rent');
  const lying = { ...w.chain.rpc, async call(method, params) { return method === 'getMinimumBalanceForRentExemption' ? 5_000_000_000 : w.chain.rpc.call(method, params); } };
  await bid(lying);
  const fresh = loot.freshNftAccount({ payer: b, holder: a, mint: x }).address;
  assert.deepEqual([w.chain.tokens(fresh), w.chain.get(fresh).lamports], [1n, loot.TOKEN_ACCOUNT_RENT]);
});

test('lamports sent to every fresh address beforehand don\'t stop the hand-out; another holder\'s addresses differ', { skip }, async () => {
  const { w, a, b, x, bid } = await bidOverSpoiled('handout-prefund');
  const addresses = Array.from({ length: 8 }, (_, index) => loot.freshNftAccount({ payer: b, holder: a, mint: x, index }).address);
  w.chain.send(a, addresses.map((to) => transferLamports(a, to, 890_880n)));
  await bid();
  assert.equal(w.read('Auction', loot.pda.auction(w.project, w.authority, 1)).high_bidder, b, 'B\'s bid landed');
  assert.deepEqual([w.chain.tokens(addresses[0]), ownerOf(w, addresses[0]), w.chain.get(addresses[0]).lamports], [1n, a, loot.TOKEN_ACCOUNT_RENT], 'A\'s NFT is in the first address, topped up to the rent');
  const c = w.who();
  assert.ok(!addresses.includes(loot.freshNftAccount({ payer: b, holder: c, mint: x }).address), 'the holder is in the seed');
});

// A page RPC that says the first fresh address holds a negative number of lamports would make the top-up (the rent
// minus that figure) send 5 SOL of B's into A's fresh token account.
test('a page RPC that says a fresh address holds negative lamports gets it refused; the NFT goes into the next, at the rent', { skip }, async () => {
  const { w, a, b, x, bid } = await bidOverSpoiled('handout-negative');
  const [first, second] = [0, 1].map((index) => loot.freshNftAccount({ payer: b, holder: a, mint: x, index }).address);
  const fake = { owner: SYSTEM_PROGRAM, lamports: -4_997_960_720, data: new Uint8Array(0), executable: false };
  const lying = {
    ...w.chain.rpc,
    async accounts(addresses) { const real = await w.chain.rpc.accounts(addresses); return addresses.map((at, i) => (at === first ? fake : real[i])); },
    async account(address) { return address === first ? fake : w.chain.rpc.account(address); },
  };
  const spent = BigInt(w.chain.get(b).lamports);
  await bid(lying);
  assert.equal(w.read('Auction', loot.pda.auction(w.project, w.authority, 1)).high_bidder, b, 'B\'s bid landed');
  assert.equal(w.chain.get(first), null, 'nothing sent to the address the RPC lied about');
  assert.deepEqual([w.chain.tokens(second), ownerOf(w, second), BigInt(w.chain.get(second).lamports)], [1n, a, loot.TOKEN_ACCOUNT_RENT], 'A\'s NFT in the next address, with the rent only');
  assert.ok(spent - BigInt(w.chain.get(b).lamports) < 100_000_000n, 'B paid no one\'s SOL but the rent and fees');
});

test('the top-up is never more than the rent: lamports that no account holds are refused, as read through the RPC client', async () => {
  const [payer, holder, mint] = ['9N1VGk35kq9rcWwZSEaDXbCvkutANyyhCrznarEBW3D9', 'So11111111111111111111111111111111111111112', 'SysvarRent111111111111111111111111111111111'];
  const only = (lamports) => loot.freshNftAccount({ payer, holder, mint, there: { owner: SYSTEM_PROGRAM, lamports, data: new Uint8Array(0) } });
  const sent = (f) => { const t = f.instructions[0]; return t.programId === SYSTEM_PROGRAM && new DataView(t.data.buffer, t.data.byteOffset).getUint32(0, true) === 2 ? new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(4, true) : 0n; };
  for (const lamports of [-1, -4_997_960_720, -1n, 0.5, Number.NaN, Infinity, '2039280', true]) assert.equal(only(lamports), null, `lamports ${String(lamports)}`);
  assert.equal(sent(only(0)), loot.TOKEN_ACCOUNT_RENT);
  assert.equal(sent(only(undefined)), loot.TOKEN_ACCOUNT_RENT);
  assert.equal(sent(only(890_880)), loot.TOKEN_ACCOUNT_RENT - 890_880n);
  assert.equal(sent(only(5_000_000_000n)), 0n, 'more than the rent there: no top-up');
  // the RPC client passes the figure through as the JSON says it (decodeAccount), so the refusal is the client's
  const fetchImpl = async (_url, init) => {
    const { id } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: [{ owner: SYSTEM_PROGRAM, lamports: -4_997_960_720, data: ['', 'base64'], executable: false }] } }), { status: 200 });
  };
  const there = await rpcClient('http://devnet.invalid', { fetchImpl }).account(loot.freshNftAccount({ payer, holder, mint }).address);
  assert.equal(there.lamports, -4_997_960_720);
  assert.equal(loot.freshNftAccount({ payer, holder, mint, there }), null);
});

test('an account another key owns, or a frozen one, takes no NFT; a pNFT goes into the fresh account with its record', () => {
  const [holder, mint, other, project, payer] = ['Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111', 'Config1111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 'Sysvar1nstructions1111111111111111111111111'];
  const account = (owner, state = 1) => {
    const data = new Uint8Array(165);
    data.set(addressBytes(mint), 0); data.set(addressBytes(owner), 32); data[108] = state;
    return { owner: TOKEN_PROGRAM, data };
  };
  assert.equal(loot.takesNft(account(holder), holder, mint), true);
  assert.equal(loot.takesNft(account(other), holder, mint), false, 'handed to another key');
  assert.equal(loot.takesNft(account(holder, 2), holder, mint), false, 'frozen');
  const fresh = loot.freshNftAccount({ payer, holder, mint });
  assert.deepEqual(fresh.instructions.map((ix) => ix.programId), [SYSTEM_PROGRAM, TOKEN_PROGRAM]);
  assert.deepEqual(fresh.instructions[0].keys.filter((k) => k.isSigner).map((k) => k.pubkey), [payer], 'only the payer signs');
  assert.notEqual(loot.freshNftAccount({ payer, holder, mint, index: 1 }).address, fresh.address);
  // only lamports there: topped up and allocated, the payer still the only signer; a token account that takes
  // it: nothing to do; anything else: the next index
  const funded = loot.freshNftAccount({ payer, holder, mint, there: { owner: SYSTEM_PROGRAM, lamports: 890_880n, data: new Uint8Array(0) } });
  assert.equal(funded.address, fresh.address);
  assert.deepEqual(funded.instructions.map((ix) => ix.programId), [SYSTEM_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM]);
  assert.deepEqual([...new Set(funded.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)))], [payer]);
  assert.deepEqual(loot.freshNftAccount({ payer, holder, mint, there: account(holder) }).instructions, []);
  assert.equal(loot.freshNftAccount({ payer, holder, mint, there: account(other) }), null);
  const p = loot.piece({ project, asset: mint, wallet: holder, tokenMetadata: { programmable: true, into: fresh.address }, moves: true, locks: false, writes: false, reads: false });
  assert.equal(p.accounts.token, fresh.address);
  assert.equal(p.accounts.token_record, loot.tokenMetadata.record(mint, fresh.address));
});
