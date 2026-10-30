// The checker: what the program takes is a warning, not a refusal (an owner may build an odd economy), and what it
// refuses (a held NFT outside a lottery, a split prize outside a contest, an exit fee on a farm of collectibles, a
// sealed schedule with no end) is refused before it goes live.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { model } from '../economy/model.mjs';
import { plan } from '../economy/plan.mjs';
import { pda } from '../client/pda.js';
import * as loot from '../client/index.js';

const NOW = 1_790_000_000;
const example = (name) => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
const WALLET = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const codes = (spec) => {
  const r = check(spec, { now: NOW });
  return { refused: r.refusals.map((x) => `${x.code} ${x.where}`), warned: r.warnings.map((x) => `${x.code} ${x.where}`), ok: r.ok };
};
const edit = (spec, fn) => {
  const copy = structuredClone(spec);
  fn(copy);
  return codes(copy);
};

test('what the program takes is a warning: free tickets, a faucet, a tier below x1, a fall to 0, an empty gate', () => {
  const raffle = example('nft-raffle');
  const free = edit(raffle, (s) => delete s.lotteries[0].price);
  assert.ok(free.ok && free.warned.includes('W-LOTTERY economy.lotteries.art.price'), free.refused.join());
  const farm = example('paper-hands-farm');
  const slow = edit(farm, (s) => (s.farms[0].tiers[0].multiplier = 0.5));
  assert.ok(slow.ok && slow.warned.includes('W-FARM economy.farms.farm.tiers[0].multiplier'), slow.refused.join());
  const vesting = example('team-vesting');
  const faucet = edit(vesting, (s) => s.grants.push({ key: 'faucet', name: 'Faucet', prize: { gives: 'tokens', amount: 1, from: 'mint', currency: 'share' }, limits: { total: 100 } }));
  assert.ok(faucet.ok && faucet.warned.includes('W-GRANT economy.grants.faucet'), faucet.refused.join());
  const gate = edit(vesting, (s) => (s.grants[0].gate = { wallets: [] }));
  assert.ok(gate.ok && gate.warned.some((w) => w.startsWith('W-GATE')), gate.refused.join());
});

test('a raffle’s NFT is held in its lottery only; a split prize is a contest’s; exits are a farm of tokens’', () => {
  const raffle = example('nft-raffle');
  assert.ok(edit(raffle, (s) => (s.lotteries[0].every = '1d')).refused.includes('E-LOTTERY economy.lotteries.art.every'), 'a held prize draws once');
  const vesting = example('team-vesting');
  const held = edit(vesting, (s) => (s.grants[0].prize = { gives: 'nft', nft: WALLET, held: true }));
  assert.ok(held.refused.some((r) => r.startsWith('E-GRANT') && r.endsWith('.held')), held.refused.join());
  const split = edit(vesting, (s) => (s.grants[0].prize.split = true));
  assert.ok(split.refused.some((r) => r.endsWith('.split')), split.refused.join());
  const farm = example('paper-hands-farm');
  assert.ok(edit(farm, (s) => delete s.farms[0].exitFeeTo).refused.includes('E-FARM economy.farms.farm.exitFeeTo'));
  const nfts = edit(farm, (s) => {
    s.farms[0].stakes = 'collectibles';
    s.items = [{ key: 'hero', name: 'Hero', price: 1 }];
    s.collection = { name: 'Heroes' };
  });
  assert.ok(nfts.refused.includes('E-FARM economy.farms.farm.tiers') && nfts.refused.includes('E-FARM economy.farms.farm.unbond'), nfts.refused.join());
});

test('a sealed schedule has an end and pays no holder; a list names amounts up to the grant’s', () => {
  const vesting = example('team-vesting');
  assert.ok(edit(vesting, (s) => delete s.schedules[0].maxRuns).refused.includes('E-SCHEDULE economy.schedules.lead.maxRuns'));
  assert.ok(edit(vesting, (s) => (s.schedules[0].to = `holder:${WALLET}`)).refused.includes('E-SCHEDULE economy.schedules.lead.to'));
  assert.ok(edit(vesting, (s) => (s.grants[0].list[0].amount = 30_000)).refused.includes('E-GRANT economy.grants.advisors.list[0].amount'));
});

test('a schedule pays a lottery’s pot; a farm with no rewards gets an empty pool of its own', () => {
  const raffle = example('nft-raffle');
  const sponsored = edit(raffle, (s) => (s.schedules = [{ key: 'sponsor', does: 'pay', from: 'prizes', to: 'lottery:art', amount: 1, every: '1d' }], s.pools = [{ key: 'prizes', currency: 'sol', seed: 1 }]));
  assert.ok(sponsored.ok, sponsored.refused.join());
  const farm = example('paper-hands-farm');
  const spec = structuredClone(farm);
  spec.farms.push({ key: 'qualify', name: 'Qualify', stakes: 'gem', tiers: [{ lock: '7d' }] });
  const r = codes(spec);
  assert.ok(r.ok && r.warned.includes('W-FARM economy.farms.qualify.rewards'), r.refused.join());
  assert.ok(model(spec).pool.has('qualify-rewards'));
  assert.ok(plan(spec, { now: NOW }).ok);
});

test('a sealed schedule pays a key someone holds, its last run within 10 years; a draw within 5 years', () => {
  const vesting = example('team-vesting');
  const toPda = edit(vesting, (s) => (s.schedules[0].to = `wallet:${pda.platform()}`));
  assert.ok(toPda.refused.includes('E-SCHEDULE economy.schedules.lead.to'), 'a program’s address is not a wallet anyone can spend from');
  assert.ok(edit(vesting, (s) => (s.schedules[0].maxRuns = 200)).refused.includes('E-SCHEDULE economy.schedules.lead.maxRuns'), '200 runs of 30 days pass 10 years');
  const raffle = example('nft-raffle');
  assert.ok(edit(raffle, (s) => (s.lotteries[0].firstDraw = 'publish+2000d')).refused.includes('E-LOTTERY economy.lotteries.art.firstDraw'));
});

test('sealed runs capped, a contest in a default-frozen mint refused, warnings for outside NFT bids, a heavy box that fits', () => {
  const vesting = example('team-vesting');
  assert.ok(edit(vesting, (s) => Object.assign(s.schedules[0], { maxRuns: 10_001, every: '1h' })).refused.includes('E-SCHEDULE economy.schedules.lead.maxRuns'));
  const presale = example('fair-presale');
  const frozen = edit(presale, (s) => (s.tokens[0] = { key: 'sol', source: 'existing', mint: WALLET, decimals: 9, powers: { defaultFrozen: true } }));
  assert.ok(frozen.refused.includes('E-CONTEST economy.contests.raise.currency'), frozen.refused.join());
  const auction = edit(presale, (s) => (s.auctions = [{ key: 'swap', name: 'Swap', lot: { item: 'gem' }, runs: '1d', bidNfts: { collection: WALLET, attribute: 'level', atLeast: 3 } }], s.items = [{ key: 'gem', name: 'Gem', price: 1 }], s.collection = { name: 'Gems' }));
  assert.ok(auction.warned.includes('W-RULE-OUTSIDE economy.auctions.swap.bidNfts'), auction.warned.join());
  const heavy = edit(presale, (s) => {
    s.collection = { name: 'Heavy' };
    s.stashes = ['a', 'b', 'c'].map((k) => ({ key: k, name: k, nfts: [] }));
    s.boxes = [{ key: 'triple', name: 'Triple', price: 1, split: [1, 2, 3].map(() => ({ to: `holder:${WALLET}`, percent: 1 })), outcomes: [{ gives: 'bundle', prizes: ['a', 'b', 'c'].map((st) => ({ gives: 'stash', stash: st })), chance: 50 }, { gives: 'nothing', chance: 50 }] }];
  });
  // (three NFTs and three holders' shares in a coin with no transfer hook fit the heap, memos or not, as measured on the
  // program; the shapes that don't are in settle-heap.test.mjs)
  assert.ok(!heavy.warned.includes('W-BOX-HEAP economy.boxes.triple.outcomes'), heavy.warned.join() + heavy.refused.join());
});

test('a Token Metadata mint is taken only as an NFT; a compressed rental passes its record and tree', () => {
  const mint = WALLET;
  const data = new Uint8Array(82);
  data[36] = 1; // a supply of one
  data[44] = 0;
  data[45] = 1;
  assert.equal(loot.isNftMint(mint, data), true, 'one token, no decimals, no mint authority');
  const two = Uint8Array.from(data);
  two[36] = 2;
  assert.equal(loot.isNftMint(mint, two), false, 'two units: a semi-fungible item');
  const minting = Uint8Array.from(data);
  minting.set([1, 0, 0, 0], 0);
  assert.equal(loot.isNftMint(mint, minting), false, 'a mint authority that is not its edition');
  const listing = { maker: WALLET, asset: WALLET, mint: WALLET, deal: { Rent: { price: 1n, lasts: 60, max_periods: 1 } }, shares: [] };
  const compressed = { id: WALLET, tree: pda.platform(), proof: [pda.identity()], owner: WALLET, delegate: WALLET, collection: null };
  const ix = loot.takeListingIx({ taker: WALLET, project: pda.platform(), listing, compressed });
  const keys = ix.keys.map((k) => k.pubkey);
  assert.ok(keys.includes(pda.leaf(WALLET)) && keys.includes(pda.platform()), 'the record and the tree');
  assert.ok(!keys.includes(pda.identity()), 'no proof: a rental moves nothing');
});

test('a drawn round’s prizes go in place order across purchases (PlacesInOrder)', () => {
  const roll = { bps: 0, prize: { Roll: [1] } };
  const lottery = { status: 'Drawn', places: [roll, roll, ...Array(6).fill({ bps: 0, prize: null })], sold: 2n, first_ticket: 0n, given: 0, pending: 2n };
  const first = { first_ticket: 0n, end: 1n, done: false };
  const second = { first_ticket: 1n, end: 2n, done: false };
  assert.equal(loot.lotteryStep(lottery, first), 'prizes', 'first place first');
  assert.equal(loot.lotteryStep(lottery, second), null, 'second place waits for the first');
  assert.equal(loot.lotteryStep({ ...lottery, given: 1 }, second), 'prizes');
  assert.equal(loot.lotteryStep({ ...lottery, given: 3 }, second), 'finish', 'then the money');
});

test('in a lottery that returns its tickets, a winner’s ticket goes back before its prize', () => {
  const roll = { bps: 0, prize: { Roll: [1] } };
  const lottery = { status: 'Drawn', returns: true, places: [roll, ...Array(7).fill({ bps: 0, prize: null })], sold: 1n, first_ticket: 0n, given: 0, pending: 1n };
  const winner = { first_ticket: 0n, end: 1n, done: false };
  assert.equal(loot.lotteryStep(lottery, winner), 'refund');
  assert.equal(loot.lotteryStep({ ...lottery, pending: 0n }, { ...winner, done: true }), 'prizes', 'then its prize');
});

test('every claim is signed by its winning wallet, whatever proves it; anyone may pay its fees', () => {
  const project = pda.platform();
  const other = pda.identity();
  const limits = { per_person: 0, per_key: 0 };
  const share = { incarnation: 1n, limits, open: false, gate: null, gives: { Tokens: { from: { Pool: [0] }, amount: { Bps: [100] } } } };
  const fixed = { ...share, gives: { Tokens: { from: { Pool: [0] }, amount: { Fixed: [5n] } } } };
  const open = { ...fixed, open: true };
  for (const grant of [share, fixed, open]) {
    const ix = loot.claimGrantIx({ project, id: 1, wallet: WALLET, expires: grant.open ? 0n : 9_999_999_999n, poolMint: other, grant, signer: other });
    assert.ok(ix.keys.some((k) => k.pubkey === WALLET && k.isSigner), 'the wallet signs');
    assert.ok(ix.keys.some((k) => k.pubkey === other && k.isSigner), 'the payer signs and pays');
  }
});
