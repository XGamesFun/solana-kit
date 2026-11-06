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
  assert.ok(edit(vesting, (s) => Object.assign(s.schedules[0], { maxRuns: 100_001, every: '1h' })).refused.includes('E-SCHEDULE economy.schedules.lead.maxRuns'));
  assert.ok(!edit(vesting, (s) => Object.assign(s.schedules[0], { maxRuns: 35_040, every: '1h' })).refused.includes('E-SCHEDULE economy.schedules.lead.maxRuns'), 'four years of hourly runs');
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

/** A round's record as `decodeRound` reads it, for the parts it owes. */
const round = ({ returns = false, ...more } = {}) => ({
  status: 'Drawn', terms: { returns, ticket_mint: '11111111111111111111111111111111', shares: [], places: [{ bps: 10_000, prize: null, times: 1 }] }, sold: 2n, first: 0n, cursor: 0, pot_total: 100n, pot_sent: 100n, pot_arrived: 100n,
  paid: new Uint8Array(1), prizes: [], entries: [{ buyer: WALLET, start: 0n, end: 1n, paid: 0n, amount: 50n, to: [], nft: '11111111111111111111111111111111' }, { buyer: WALLET, start: 1n, end: 2n, paid: 0n, amount: 50n, to: [], nft: '11111111111111111111111111111111' }],
  ...more,
});

test('a drawn round’s places are paid once it is swept, each place once', () => {
  assert.deepEqual(loot.partsOwed(round(), 0), [], 'drawn: the sweep comes first');
  assert.deepEqual(loot.partsOwed(round({ status: 'Swept' }), 0), [{ Pot: [0] }], 'first place\'s part of the pot');
  assert.deepEqual(loot.partsOwed(round({ status: 'Swept' }), 1), [], 'the other ticket won nothing');
  assert.deepEqual(loot.partsOwed(round({ status: 'Swept', paid: Uint8Array.of(1) }), 0), [], 'paid once');
});

test('in a lottery that returns its tickets, a ticket goes back from the draw, before the sweep', () => {
  assert.deepEqual(loot.partsOwed(round({ returns: true }), 1, { places: false }), ['Own']);
  assert.deepEqual(loot.partsOwed(round({ returns: true, status: 'Cancelled' }), 0), ['Own'], 'a cancelled round refunds every ticket');
  assert.deepEqual(loot.partsOwed(round({ returns: true, status: 'Swept' }), 0), ['Own', { Pot: [0] }], 'and its winner\'s place once swept');
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

test('a lottery’s places as runs and a raffle of many NFTs are checked as the program writes them', () => {
  const raffle = example('nft-raffle');
  const nfts = [WALLET, pda.platform(), pda.identity()];
  // Its own NFT (`raffle`) left out: a raffle names its NFTs or draws them, never both.
  const many = (s, more = {}) => {
    delete s.lotteries[0].raffle;
    return Object.assign(s.lotteries[0], { places: [{ percent: 0, prize: { gives: 'raffled' }, times: 3 }], nfts }, more);
  };
  const ok = edit(raffle, (s) => many(s));
  assert.ok(!ok.refused.some((r) => r.startsWith('E-LOTTERY')), ok.refused.join());
  assert.ok(edit(raffle, (s) => many(s, { nfts: nfts.slice(0, 2) })).refused.includes('E-LOTTERY economy.lotteries.art.nfts'), 'fewer NFTs than raffled places');
  assert.ok(edit(raffle, (s) => many(s, { every: '1d' })).refused.includes('E-LOTTERY economy.lotteries.art.every'), 'a raffle draws once');
  const runs = edit(raffle, (s) => Object.assign(s.lotteries[0], { places: [{ percent: 1, times: 101 }] }));
  assert.ok(runs.refused.includes('E-LOTTERY economy.lotteries.art.places'), 'a run of 101 places at 1% is more than the pot');
  assert.ok(edit(raffle, (s) => Object.assign(s.lotteries[0], { places: [{ percent: 0, prize: { gives: 'roll', box: 'x' }, times: 2 }] })).refused.includes('E-LOTTERY economy.lotteries.art.places[1].times'), 'a roll is one place’s (after the raffle’s own NFT)');
});

test('a run of places whose token prize in all passes a u64 is refused (BadLottery)', () => {
  const arena = example('coin-flip-arena');
  const run = (amount) => edit(arena, (s) => Object.assign(s.lotteries[0], { places: [50, { percent: 0, prize: { gives: 'tokens', from: 'mint', currency: 'arena', amount }, times: 2 }] })).refused;
  assert.ok(run(10_000_000_000_000).includes('E-LOTTERY economy.lotteries.weekly.places[1].times'), 'ten trillion tokens of 6 decimals, twice');
  assert.ok(!run(1).includes('E-LOTTERY economy.lotteries.weekly.places[1].times'));
});

test('a pull pays at most 300 places of a run; it closes the round only when they are the last parts owed', () => {
  const r = round({ status: 'Swept', terms: { returns: false, mint: WALLET, ticket_mint: '11111111111111111111111111111111', shares: [], places: [{ bps: 20, prize: null, times: 400 }] }, sold: 400n, pot_total: 1_000_000n, pot_sent: 800_000n, pot_arrived: 800_000n, paid: new Uint8Array(100), entries: [{ buyer: WALLET, start: 0n, end: 400n, paid: 0n, amount: 400n, to: [], nft: '11111111111111111111111111111111' }] });
  assert.equal(loot.MOST_A_PULL, 300);
  assert.equal(loot.placesPulled(r, 0, 0, false), 300);
  const opener = pda.platform();
  const pull = (owed) => loot.pullIx({ payer: WALLET, project: WALLET, roundAddress: WALLET, round: { ...r, owed, accounts: [], opener }, entry: 0, part: { Pot: [0] }, projectState: { treasury: WALLET } }).keys.map((k) => k.pubkey);
  assert.ok(pull(300).includes(opener), 'the last 300 owed: it closes the round, naming its opener');
  assert.ok(!pull(301).includes(opener), 'one more owed: the next pull closes it');
});

test('a grant is tag 27 and a profile 24: told apart by their tag; a Token Metadata Sheet names its edition to close', () => {
  assert.equal(loot.TAGS.Grant, 27);
  assert.equal(loot.accountKind(Uint8Array.of(27)), 'Grant');
  assert.equal(loot.accountKind(Uint8Array.of(24)), 'Profile');
  const core = loot.closeSheetIx({ project: WALLET, nft: WALLET, treasury: WALLET });
  const tm = loot.closeSheetIx({ project: WALLET, nft: WALLET, treasury: WALLET, tokenMetadata: true });
  assert.equal(core.keys[4].pubkey, loot.LOOT_PROGRAM, 'none: the program id');
  assert.equal(tm.keys[4].pubkey, loot.tokenMetadata.edition(WALLET));
});

test('a bid of NFTs holds at most three: past a high bid of three, nothing tops it', () => {
  assert.equal(loot.MAX_BID_NFTS, 3);
  const auction = { nft_bids: { of: 'Any' }, reserve: 1n, min_raise_bps: 0, high: 2n };
  assert.equal(loot.leastBid(auction), 3n);
  assert.equal(loot.leastBid({ ...auction, high: 3n }), null, 'a high bid of three can’t be topped');
  assert.equal(loot.leastBid({ ...auction, nft_bids: null, high: 3n }), 4n, 'a bid of tokens has no such cap');
});

test('a box whose open’s order would pass 10,240 bytes is refused (BadEntries)', () => {
  const arena = example('coin-flip-arena');
  const box = arena.boxes.find((b) => (b.outcomes ?? []).length);
  const spec = structuredClone(arena);
  Object.assign(spec.boxes.find((b) => b.key === box.key), { slots: [{ count: 300 }] });
  const r = check(spec, { now: NOW });
  assert.ok(r.refusals.some((x) => x.where === `economy.boxes.${box.key}.slots` && /order would be/.test(x.message)), r.refusals.map((x) => x.message).join('\n'));
  assert.equal(loot.MAX_ORDER_BYTES, 10_240);
});

test('a compressed prize of a collection without Bubblegum’s plugin mints nothing: the next one’s Sheet takes its place', () => {
  const [plain, plugged] = [pda.platform(), pda.identity()];
  const tree = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
  const order = { project: WALLET, player: WALLET, won: [{ Compressed: { item: 1, serial: 1, drawn: 0 } }, { Compressed: { item: 2, serial: 1, drawn: 0 } }] };
  const items = { 1: { collection: plain, traits: [] }, 2: { collection: plugged, traits: [] } };
  const sheets = (unminted) => loot.wonAccounts({ orderAddress: WALLET, order, items, tree, treeMinted: 5n, unminted }).filter((m) => m.isWritable).map((m) => m.pubkey);
  assert.ok(sheets([]).includes(pda.sheet(WALLET, pda.compressedAsset(tree, 6n))), 'both minted: the second is the tree’s 7th');
  assert.ok(sheets([plain]).includes(pda.sheet(WALLET, pda.compressedAsset(tree, 5n))), 'the first skipped: the second is the 6th');
  assert.ok(!sheets([plain]).includes(pda.sheet(WALLET, pda.compressedAsset(tree, 6n))));
});

test('a box of one outcome that is opened, minting a token with confidential transfers, is refused (PrizeNotCovered)', () => {
  const arena = example('coin-flip-arena');
  const spec = structuredClone(arena);
  spec.tokens.push({ key: 'veil', source: 'game', symbol: 'VEIL', decimals: 0, powers: { confidentialTransfers: true } });
  spec.boxes.push({ key: 'veiled', name: 'Veiled pack', price: 0.01, slots: [{ count: 2 }], outcomes: [{ gives: 'tokens', currency: 'veil', amount: 1 }] });
  const r = check(spec, { now: NOW });
  assert.ok(r.refusals.some((x) => x.where === 'economy.boxes.veiled.outcomes[0]' && /PrizeNotCovered/.test(x.message)), r.refusals.map((x) => `${x.where} ${x.message}`).join('\n'));
  // Sold with one draw, it is bought, not opened: no such refusal.
  spec.boxes.at(-1).slots = undefined;
  assert.ok(!check(spec, { now: NOW }).refusals.some((x) => /PrizeNotCovered/.test(x.message) && x.where === 'economy.boxes.veiled.outcomes[0]'));
});

test('a settle’s first call splits the payment with its shares; SETTLE_SPLIT does only that; later calls carry no shares', () => {
  const k = (n) => pda.stash(WALLET, n);
  const shares = [{ to: { Wallet: [k(1)] }, bps: 500 }, { to: { Wallet: [k(2)] }, bps: 500 }];
  const order = { project: WALLET, player: WALLET, mint: k(3), won: [{ Tokens: { mint: k(4), amount: 1n } }], burns: false, shares, subject: null, held: false, fate: null, settled: 0, drew: 1, undrawn: 0 };
  const build = (o, upto) => loot.settleIx({ signer: WALLET, orderAddress: k(5), order: o, projectState: { treasury: k(6) }, upto });
  const has = (ix, a) => ix.keys.some((m) => m.pubkey === a);
  assert.equal(loot.SETTLE_SPLIT, 4_294_967_295);
  const split = build(order, loot.SETTLE_SPLIT);
  assert.ok(has(split, k(1)) && has(split, k(2)), 'the split carries the shares');
  assert.ok(!has(split, k(4)), 'and no prize');
  assert.deepEqual([...split.data.subarray(8, 12)], [255, 255, 255, 255]);
  const after = build({ ...order, drew: 0 }, 0);
  assert.ok(!has(after, k(1)) && has(after, k(4)), 'split made: the last part carries the prize, no shares');
});

test('go-live writes a box before a box that names it to roll, each naming write alone with all the compute', () => {
  const arena = example('coin-flip-arena');
  const spec = structuredClone(arena);
  const inner = spec.boxes.find((b) => (b.outcomes ?? []).length);
  // A box that rolls the arena's box, listed before it.
  spec.boxes.unshift({ key: 'mystery', name: 'Mystery', price: 0.01, outcomes: [{ gives: 'roll', box: inner.key, chance: 50 }, { gives: 'nothing', chance: 50 }] });
  const p = plan(spec, { now: NOW });
  assert.ok(p.ok, JSON.stringify(p.refusals));
  const ids = p.steps.map((s) => s.id);
  assert.ok(ids.indexOf(`box:${inner.key}:LootBox`) < ids.indexOf('box:mystery:LootBox'), ids.join(' '));
  const t = p.transactions.find((x) => x.steps.some((s) => s.id === 'box:mystery:LootBox'));
  assert.equal(t.steps.length, 1, 'alone');
  assert.equal(t.instructions[0].data[0], 2, 'a compute limit first');
});
