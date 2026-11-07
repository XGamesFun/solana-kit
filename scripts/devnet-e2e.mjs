#!/usr/bin/env node
// Goes live on devnet, end to end, the way a person does: a fresh owner wallet (funded from the keypair given) approves
// each example's setup through the approval server (js/approve), exactly as the page would hand the wallet's
// signatures back. Then it plays: a box rolled by MagicBlock's real oracle and settled, a payment, and a payout the
// authority signs; and an auction, where two fresh players bid through js/play, the outbid one has their SOL back at
// once, and the winner ends it; and farm times and a set, where two pieces staked with their lock and fuel on the NFT
// are refuelled and bound into a badge by recipes, held in until the badge is burned. Spends a little devnet SOL; every
// key lives in memory only.
//
//   node scripts/devnet-e2e.mjs --keypair <funder keypair file> [--keep <dir>] [--only <scenario>[,<scenario>...]]
//
// Scenarios: flip, examples, auction, farms, stash, packs, compressed, lottery, farm.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshKeypair } from '../js/approve/ed25519.mjs';
import { keypairFromSecret } from './keypair.mjs';
import { createApproval, devnetChain } from '../js/approve/server.mjs';
import { fromBase64, toBase64 } from '../js/chain/bytes.js';
import { parseCoreAsset } from '../js/chain/core.js';
import { NATIVE_MINT } from '../js/chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, syncNative, transferLamports } from '../js/chain/programs.js';
import { checkCluster, notMainnet, rpcClient } from '../js/chain/rpc.js';
import { compileMessage, readTransaction, wireTransaction } from '../js/chain/tx.js';
import * as loot from '../js/client/index.js';
import { solanaApp } from '../js/play/index.js';

const arg = (n) => process.argv[process.argv.indexOf(`--${n}`) + 1];
const url = process.env.XSOLANA_RPC_URL || 'https://api.devnet.solana.com';
// Devnet only: a mainnet URL is refused by its name, and any chain whose genesis block is mainnet's or testnet's
// is refused before anything is sent.
const rpc = rpcClient(notMainnet(url));
await checkCluster(rpc);
const funder = keypairFromSecret(Uint8Array.from(JSON.parse(readFileSync(arg('keypair'), 'utf8'))));
const chain = devnetChain(url);
const dir = process.argv.includes('--keep') ? arg('keep') : mkdtempSync(path.join(tmpdir(), 'xsolana-devnet-'));
mkdirSync(dir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(signers, instructions) {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const message = compileMessage({ payer: signers[0].address, blockhash, instructions });
  const { signers: slots } = readTransaction(wireTransaction(message));
  const wire = wireTransaction(message, slots.map((s) => signers.find((k) => k.address === s)?.sign(message) ?? new Uint8Array(64)));
  const signature = await rpc.send(wire);
  await rpc.confirm(signature, { lastValidBlockHeight });
  return signature;
}

const owner = freshKeypair();
console.log(`owner ${owner.address}`);
await send([funder], [transferLamports(funder.address, owner.address, 300_000_000n)]);

/** A wallet's answer to a prepared batch: its signature in its own slot. */
const signAll = (wallet, wires) =>
  wires.map((b64) => {
    const t = readTransaction(fromBase64(b64));
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(wallet.address)] = wallet.sign(t.message);
    return toBase64(wireTransaction(t.message, sigs));
  });

// Each project of the one owner is a number of its own (the project's address is ["project", owner, number]).
let projects = 0;
async function goLive(name, spec) {
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ ...spec, projectNumber: projects++ }, null, 2));
  const session = await createApproval({ file, chain });
  for (let i = 0; i < 10 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const state = await session.complete(owner.address, batch.id, signAll(owner, batch.transactions));
    console.log(`  ${name}: landed ${state.signatures.slice(-batch.transactions.length).join(', ')}`);
  }
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${name}: live, project ${saved.live.project}`);
  return saved;
}

const only = process.argv.includes('--only') ? arg('only').split(',') : null;
const want = (name) => !only || only.includes(name);

/** A keypair as js/play's wallet: it signs its own slot. */
const asWallet = (k) => ({
  address: k.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(k.address)] = k.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

if (want('flip')) {
// 1. A small coin flip, so the real oracle rolls on devnet.
const flip = await goLive('tiny-flip', {
  version: 2,
  network: 'devnet',
  name: 'Tiny flip',
  prompt: 'A 0.001 SOL coin flip for the devnet test.',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  pools: [{ key: 'house', currency: 'sol', seed: 0.01 }],
  boxes: [{ key: 'flip', name: 'Flip', price: 0.001, split: [{ to: 'pool:house', percent: 98 }], outcomes: [{ gives: 'pay', chance: 50, pool: 'house', amount: 0.0019 }, { gives: 'nothing', chance: 50 }] }],
  payments: [{ key: 'tip', name: 'Tip', amount: 0.001, split: [{ to: 'pool:house', percent: 50 }] }],
  decisions: [{ key: 'bonus', when: 'a daily winner', does: 'payout', pool: 'house', amount: 0.001 }],
});
const project = flip.live.project;
const projectState = loot.decode('Project', (await rpc.account(project)).data);
const box = loot.decode('LootBox', (await rpc.account(loot.pda.box(project, flip.boxes[0].id))).data);
const wsol = loot.ata(owner.address, NATIVE_MINT);
const wrap = (lamports) => [createAssociatedTokenAccountIdempotent(owner.address, owner.address, NATIVE_MINT), transferLamports(owner.address, wsol, lamports), syncNative(wsol)];
const nonce = BigInt(Date.now());
await send([owner], [...wrap(box.price + 1_000_000n), loot.openBoxIx({ player: owner.address, project, box, nonce })]);
const orderAddress = loot.pda.order(project, owner.address, nonce);
let order;
for (let i = 0; i < 30; i++) {
  order = loot.decode('Order', (await rpc.account(orderAddress)).data);
  if (order.status !== 'Pending') break;
  await sleep(2000);
}
console.log(`box: the oracle rolled ${JSON.stringify(order.won, (_, v) => (typeof v === "bigint" ? v.toString() : v))} (${order.status})`);
if (order.status === 'Rolled') {
  const settled = await send([owner], [loot.settleIx({ signer: owner.address, orderAddress, order, projectState })]);
  console.log(`box: settled ${settled}`);
}
console.log(`payment: ${await send([owner], [...wrap(1_000_000n), loot.payIx({ player: owner.address, project, mint: NATIVE_MINT, treasury: projectState.treasury, amount: 1_000_000n, shares: [{ to: { Pool: [flip.pools[0].index] }, bps: 5000 }] })])}`);
console.log(`payout (the authority): ${await send([owner], [loot.moveTokensIx({ authority: owner.address, project, mint: NATIVE_MINT, from: { Pool: [flip.pools[0].index] }, to: { Account: [wsol] }, amount: { Fixed: [1_000_000n] }, reference: 'devnet e2e' })])}`);

}

// 2. Two examples: a season of emissions with a project token, and a level ladder whose payouts the authority signs.
if (want('examples'))
  for (const name of ['halving-seasons', 'level-ladder']) {
    const spec = JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
    if (name === 'level-ladder') spec.pools = spec.pools.map((p) => ({ ...p, seed: 0.02 }));
    await goLive(name, spec);
  }

// 3. The artwork auction, short: two players bid in SOL through js/play, the outbid one's SOL is back at once, and the
// winner ends it once it is over and has the collectible.
if (want('auction')) {
  const spec = JSON.parse(readFileSync(new URL('../examples/artwork-auction.json', import.meta.url), 'utf8'));
  spec.auctions = spec.auctions.map((a) => ({ ...a, reserve: 0.001, runs: '90s', extendBy: '30s' }));
  const live = await goLive('artwork-auction', spec);
  const [first, second] = [freshKeypair(), freshKeypair()];
  for (const k of [first, second]) await send([funder], [transferLamports(funder.address, k.address, 30_000_000n)]);
  const a = solanaApp({ spec: live, rpc, wallet: asWallet(first) });
  const b = solanaApp({ spec: live, rpc, wallet: asWallet(second) });
  console.log(`auction: ${first.address} bids 0.001 SOL: ${await a.bid('sunset', '0.001')}`);
  console.log(`auction: ${second.address} bids 0.002 SOL: ${await b.bid('sunset', '0.002')}`);
  const [seen] = await a.auctions();
  if (seen.waiting !== '0.001') throw new Error(`The outbid player's 0.001 SOL is not back: ${JSON.stringify(seen)}`);
  console.log(`auction: the outbid player has ${seen.waiting} SOL back; unwrapped: ${await a.unwrap()}`);
  for (let left = seen.secondsLeft; ; left = (await b.auctions())[0].secondsLeft) {
    if (left <= 0) break;
    await sleep(Math.min(left, 20) * 1000 + 3000);
  }
  // The chain's clock can trail the wall's by a few seconds: try again until it agrees the auction is over.
  let ended;
  for (let i = 0; i < 10 && !ended; i++) ended = await b.endAuction('sunset').catch((e) => (/AuctionRunning/.test(`${e.message ?? e} ${(e.logs ?? []).join(' ')}`) ? sleep(5000).then(() => null) : Promise.reject(e)));
  console.log(`auction: ended ${ended.signature}; ${ended.winner} has the collectible ${ended.asset}`);
}
// 4. Farm times and a set: two pieces staked at an altar that keeps their lock and fuel on the NFT; a recipe refuels one
// (the play page refreshes its seat with it), a recipe binds both into a badge (only while they are staked), and the
// pieces can't leave until a recipe burns the badge.
if (want('farms')) {
  const live = await goLive('bound-elements', {
    version: 2,
    network: 'devnet',
    name: 'Bound elements',
    prompt: 'Fire and Water earn SPARK staked at the altar while fuelled; staked together, they bind into a badge.',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }, { key: 'spark', source: 'project', name: 'Spark', symbol: 'SPARK', decimals: 0 }, { key: 'fuel', source: 'project', name: 'Fuel', symbol: 'FUEL', decimals: 0 }],
    collection: { name: 'Bound elements' },
    items: [{ key: 'fire', name: 'Fire' }, { key: 'water', name: 'Water' }, { key: 'badge', name: 'Elemental Badge' }],
    farms: [
      { key: 'altar', name: 'The altar', stakes: 'collectibles', rewards: 'spark', rate: { perDay: 10, minted: true }, tiers: [{ lock: 0 }], lockAttribute: 'free_at', upkeepAttribute: 'fuel_until' },
      { key: 'sanctum', name: 'The sanctum', stakes: 'collectibles', item: 'badge', rewards: 'spark', rate: { perDay: 100, minted: true }, tiers: [{ lock: 0 }] },
    ],
    recipes: [
      { key: 'refuel', name: 'Refuel', in: [{ takes: 'use', item: 'fire' }, { takes: 'pay', currency: 'fuel', amount: 1, to: 'burn' }], raises: [{ place: 0, key: 'fuel_until', by: '1d', upTo: '3d', fromNow: true }] },
      { key: 'bind', name: 'Bind', in: [{ takes: 'staked', item: 'fire', farm: 'altar' }, { takes: 'staked', item: 'water', farm: 'altar' }], out: [{ gives: 'item', item: 'badge' }],
        raises: [0, 1].flatMap((place) => [{ place, key: 'bound', by: 1, upTo: 1 }, { place, key: 'free_at', by: '20000d' }]) },
      { key: 'unbind', name: 'Unbind', in: [{ takes: 'burn', item: 'badge' }, { takes: 'staked', item: 'fire', farm: 'altar' }, { takes: 'staked', item: 'water', farm: 'altar' }],
        needs: [1, 2].map((place) => ({ place, key: 'bound', atLeast: 1 })), raises: [1, 2].flatMap((place) => [{ place, key: 'bound', by: -1 }, { place, key: 'free_at', by: '-20000d' }]) },
    ],
  });
  const { project, mints } = live.live;
  const itemId = (key) => live.items.find((x) => x.key === key).id;
  const make = async (item) => {
    const id = itemId(item);
    const address = loot.pda.item(project, id);
    const itemState = loot.decode('Item', (await rpc.account(address)).data);
    const [asset] = loot.madeAssets(project, id, itemState);
    await send([owner], [loot.makeIx({ authority: owner.address, project, item: id, itemState, owners: [owner.address], attributes: [] })]);
    return asset;
  };
  const attributes = async (asset) => parseCoreAsset((await rpc.account(asset)).data).attributes;
  const [fire, water] = [await make('fire'), await make('water')];
  const fuelAccount = loot.ata(owner.address, mints.fuel);
  await send([owner], [createAssociatedTokenAccountIdempotent(owner.address, owner.address, mints.fuel), loot.moveTokensIx({ authority: owner.address, project, mint: mints.fuel, from: { Mint: [mints.fuel] }, to: { Account: [fuelAccount] }, amount: { Fixed: [5n] }, reference: 'devnet e2e fuel' })]);
  const app = solanaApp({ spec: live, rpc, wallet: asWallet(owner) });
  console.log(`farms: staked ${await app.stakeNft('altar', fire)} and ${await app.stakeNft('altar', water)}`);
  console.log(`farms: refuelled (with its refresh) ${(await app.craft('refuel', [fire], 1, { listing: (await app.recipes()).find((r) => r.key === 'refuel') })).signature}`);
  const seat = loot.decode('Seat', (await rpc.account(loot.pda.seat(loot.pda.farm(project, live.farms[0].id), fire))).data);
  if (!(Number((await attributes(fire)).fuel_until) > Date.now() / 1000 && seat.weight > 0n)) throw new Error(`Fire is not fuelled on its seat: ${JSON.stringify((await attributes(fire)))}`);
  const { signature: bound, made: [badge] } = await app.craft('bind', [fire, water], 1, { listing: (await app.recipes()).find((r) => r.key === 'bind') });
  console.log(`farms: bound ${bound}; badge ${badge}; Fire free at ${(await attributes(fire)).free_at}`);
  const kept = await app.unstakeNft('altar', fire).then(() => null, (e) => String(e.message ?? e));
  // StillLocked, named in the logs or only by its number (0x1790) in a failed simulation.
  if (!/StillLocked|0x1790/.test(kept ?? '')) throw new Error(`A bound piece left its farm: ${kept}`);
  console.log('farms: a bound piece can\'t leave (StillLocked)');
  console.log(`farms: the badge staked ${await app.stakeNft('sanctum', badge)} and out ${await app.unstakeNft('sanctum', badge)}`);
  console.log(`farms: unbound ${(await app.craft('unbind', [badge, fire, water], 1, { listing: (await app.recipes()).find((r) => r.key === 'unbind') })).signature}`);
  console.log(`farms: Fire out ${await app.unstakeNft('altar', fire)}, Water out ${await app.unstakeNft('altar', water)}`);
}
// 5. A stash's NFT at random, rolled by MagicBlock's real oracle: the callback takes the NFT it picks out of the stash
// (the stash shrinks inside the oracle's call), and the settle hands it over.
if (want('stash')) {
  const live = await goLive('stash-chest', {
    version: 2,
    network: 'devnet',
    name: 'Stash chest',
    prompt: 'A free chest that gives one of two trophies the project holds, at random.',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Stash chest' },
    items: [{ key: 'trophy', name: 'Trophy' }],
  });
  const { project, collection } = live.live;
  const trophy = live.items.find((x) => x.key === 'trophy').id;
  const trophies = [];
  for (let i = 0; i < 2; i++) {
    const itemState = loot.decode('Item', (await rpc.account(loot.pda.item(project, trophy))).data);
    const [asset] = loot.madeAssets(project, trophy, itemState);
    await send([owner], [loot.makeIx({ authority: owner.address, project, item: trophy, itemState, owners: [owner.address], attributes: [] })]);
    trophies.push(asset);
  }
  for (const asset of trophies) await send([owner], [loot.stashIx({ signer: owner.address, project, id: 1, asset, collection })]);
  const entries = [{ prizes: [{ Stash: [1] }], weight: 1 }, { prizes: [{ Stash: [1] }], weight: 1 }];
  const args = { price: 0n, currency: NATIVE_MINT, rise: null, fall: null, stock_odds: false, active: true, shares: [], entries, odds: [] };
  await send([owner], [loot.upsertIx({ owner: owner.address, project, def: { Box: { id: 900, args } } })]);
  const box = loot.decode('LootBox', (await rpc.account(loot.pda.box(project, 900))).data);
  const nonce = BigInt(Date.now());
  await send([owner], [loot.openBoxIx({ player: owner.address, project, box, nonce })]);
  const orderAddress = loot.pda.order(project, owner.address, nonce);
  let order;
  for (let i = 0; i < 30; i++) {
    order = loot.decode('Order', (await rpc.account(orderAddress)).data);
    if (order.status !== 'Pending') break;
    await sleep(2000);
  }
  if (order.status !== 'Rolled' || !order.won[0]?.Nft) throw new Error(`The chest did not roll a trophy: ${order.status}`);
  const won = order.won[0].Nft.nft;
  const left = loot.decodeStash((await rpc.account(loot.pda.stash(project, 1))).data).nfts;
  if (left.length !== 1 || left.includes(won)) throw new Error(`The roll did not take ${won} out of the stash: ${left}`);
  console.log(`stash: the oracle picked ${won}; the stash holds ${left.length} now`);
  const projectState = loot.decode('Project', (await rpc.account(project)).data);
  const nfts = Object.fromEntries(trophies.map((t) => [t, { collection, hasAuthority: true }]));
  console.log(`stash: settled ${await send([owner], [loot.settleIx({ signer: owner.address, orderAddress, order, projectState, nfts })])}`);
  if (parseCoreAsset((await rpc.account(won)).data).owner !== owner.address) throw new Error('The trophy is not the player\'s.');
  console.log(`stash: ${owner.address} holds the trophy ${won}`);
}
// 7. Packs (loot 0.22): a booster of four cards and a guaranteed rare, and a pack of fresh heroes whose color is drawn
// from a sealed table and power from a range; four boosters bought at once, one wallet prompt, the real oracle's one
// answer, settled in parts by the throwaway key.
if (want('packs')) {
  const live = await goLive('packs', {
    version: 2,
    network: 'devnet',
    name: 'Packs',
    prompt: 'Boosters of five cards with a guaranteed rare, and packs of heroes with a drawn color and power.',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Packs' },
    tables: [{ key: 'colors', kind: 'labels', rows: [{ label: 'red', weight: 3 }, { label: 'blue', weight: 3 }, { label: 'gold', weight: 1, stock: 5 }] }],
    items: [
      { key: 'common', name: 'Common' },
      { key: 'rare', name: 'Rare' },
      ...Array.from({ length: 12 }, (_, i) => ({ key: `card${i}`, name: `Card ${i}` })),
      { key: 'hero', name: '{color} Hero', uri: 'https://example.invalid/hero/{color}/{power}.json', drawn: [{ attribute: 'color', table: 'colors' }, { attribute: 'power', min: 1, max: 100 }] },
    ],
    boxes: [
      { key: 'booster', name: 'Booster', price: 0.001, slots: [{ count: 4, share: 40 }, { count: 1, from: [1], share: 60 }], outcomes: [{ gives: 'item', item: 'common', weight: 9 }, { gives: 'item', item: 'rare', weight: 1 }] },
      { key: 'heroes', name: 'Heroes', price: 0.001, slots: [{ count: 3 }], outcomes: [{ gives: 'item', item: 'hero', weight: 1 }] },
      { key: 'big', name: 'The largest pack of twelve items', price: 0.001, slots: [{ count: 36 }], outcomes: Array.from({ length: 12 }, (_, i) => ({ gives: 'item', item: `card${i}`, weight: 1 })) },
    ],
  });
  const player = freshKeypair();
  await send([funder], [transferLamports(funder.address, player.address, 500_000_000n)]);
  let prompts = 0;
  const wallet = { ...asWallet(player), async signTransaction(wire) { prompts++; return asWallet(player).signTransaction(wire); } };
  const app = solanaApp({ spec: live, rpc, wallet });
  const boosters = await app.openBox('booster', { listing: (await app.boxes()).find((l) => l.key === 'booster'), count: 4 });
  const rare = live.items.find((x) => x.key === 'rare').id;
  if (boosters.won.length !== 20) throw new Error(`Four boosters gave ${boosters.won.length} cards, not 20.`);
  if (![4, 9, 14, 19].every((k) => boosters.won[k].Item.item === rare)) throw new Error('A booster\'s fifth card was not a rare.');
  console.log(`packs: four boosters, ${prompts} wallet prompt(s), 20 cards, settled in ${boosters.parts?.length ?? 1} part(s): ${(boosters.parts ?? [boosters.settled]).join(', ')}`);
  const heroes = await app.openBox('heroes', { listing: (await app.boxes()).find((l) => l.key === 'heroes') });
  const mine = (await app.collectibles()).filter((c) => c.attributes.color);
  if (heroes.won.length !== 3 || mine.length !== 3) throw new Error(`The hero pack gave ${heroes.won.length} heroes, ${mine.length} held.`);
  for (const c of mine) console.log(`packs: ${c.name}, color ${c.attributes.color}, power ${c.attributes.power}`);
  console.log(`packs: ${prompts} wallet prompts for both purchases`);
  const big = await app.openBox('big', { listing: (await app.boxes()).find((l) => l.key === 'big') });
  if (big.won.length !== 36) throw new Error(`The largest pack gave ${big.won.length} cards, not 36.`);
  console.log(`packs: the largest pack, 36 cards, every draw made: ${(big.parts ?? [big.settled]).join(', ')}`);
  console.log(`packs: project ${live.live.project}`);
}
// 8. A lottery (loot 0.23: each round is a record of its own): two fresh players buy tickets of a one-off draw due
// 90 seconds after going live; once it is due, one reveals it, MagicBlock's real oracle draws, and the players take
// what they are owed (anyone may pay out everyone): the winner has the pot, and the last pull closes the round.
if (want('lottery')) {
  const live = await goLive('quick-draw', {
    version: 2,
    network: 'devnet',
    name: 'Quick draw',
    prompt: 'A one-off draw 90 seconds after going live: 0.001 SOL a ticket, the winner takes the pot.',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    lotteries: [{ key: 'quick', name: 'Quick draw', price: 0.001, places: [100], firstDraw: 'publish+90s' }],
  });
  const players = [freshKeypair(), freshKeypair()];
  for (const k of players) await send([funder], [transferLamports(funder.address, k.address, 30_000_000n)]);
  const apps = players.map((k) => solanaApp({ spec: live, rpc, wallet: asWallet(k) }));
  for (const [i, app] of apps.entries()) console.log(`lottery: ${players[i].address} buys ${i + 1} ticket(s): ${await app.buyTickets('quick', i + 1, { listing: (await app.lotteries())[0] })}`);
  const lotteryAddress = loot.pda.lottery(live.live.project, live.lotteries[0].id);
  const roundAddress = loot.currentRound(lotteryAddress, loot.decode('Lottery', (await rpc.account(lotteryAddress)).data));
  const { drawsAt } = (await apps[0].lotteries())[0];
  await sleep(Math.max(0, drawsAt * 1000 - Date.now()) + 3000);
  // The chain's clock can trail the wall's by a few seconds: look again until the draw is due there too.
  let reveal;
  for (let i = 0; i < 20 && !reveal; i++) reveal = (await apps[0].claims()).find((c) => c.kind === 'reveal' && c.key === 'quick') ?? (await sleep(5000), null);
  if (!reveal) throw new Error('The draw never came due.');
  console.log(`lottery: revealed (the oracle asked) ${await apps[0].claim(reveal)}`);
  let round;
  for (let i = 0; i < 30; i++) {
    round = loot.decodeRound((await rpc.account(roundAddress)).data);
    if (round.status !== 'Drawing') break;
    await sleep(2000);
  }
  if (round.status !== 'Drawn') throw new Error(`The oracle did not draw the round: ${round.status}`);
  console.log(`lottery: drawn by the oracle; ${round.sold} tickets sold`);
  for (let pass = 0; pass < 4 && (await rpc.account(roundAddress)); pass++)
    for (const [i, app] of apps.entries())
      for (const c of (await app.claims()).filter((x) => x.key === 'quick' && ['pull', 'payout'].includes(x.kind)))
        console.log(`lottery: ${players[i].address} ${c.kind}s: ${await app.claim(c)}`);
  if (await rpc.account(roundAddress)) throw new Error('The round is still open after every pull.');
  const pot = await Promise.all(players.map(async (k) => {
    const held = await rpc.account(loot.ata(k.address, NATIVE_MINT));
    return held ? new DataView(held.data.buffer, held.data.byteOffset).getBigUint64(64, true) : 0n;
  }));
  console.log(`lottery: every part paid and the round closed; wrapped SOL won: ${players.map((k, i) => `${k.address} ${pot[i]}`).join(', ')}`);
}
// 9. A token farm: a fresh player stakes SOL, earns SPARK minted as it grows (a rate is per whole staked token: 0.01 SOL
// earns 1,000 SPARK a day), harvests it, then takes the stake out.
if (want('farm')) {
  const live = await goLive('spark-field', {
    version: 2,
    network: 'devnet',
    name: 'Spark field',
    prompt: 'Stake SOL and earn SPARK, minted as it grows, with no lock.',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }, { key: 'spark', source: 'project', name: 'Spark', symbol: 'SPARK', decimals: 6 }],
    farms: [{ key: 'field', name: 'The field', stakes: 'sol', rewards: 'spark', rate: { perDay: 100000, minted: true }, tiers: [{ lock: 0 }] }],
  });
  const player = freshKeypair();
  await send([funder], [transferLamports(funder.address, player.address, 30_000_000n)]);
  const app = solanaApp({ spec: live, rpc, wallet: asWallet(player) });
  console.log(`farm: ${player.address} stakes 0.01 SOL: ${await app.stake('field', '0.01')}`);
  await sleep(20_000);
  console.log(`farm: harvested ${await app.harvest('field')}`);
  const spark = loot.ata(player.address, live.live.mints.spark);
  const held = (await rpc.account(spark)).data;
  const earned = new DataView(held.buffer, held.byteOffset).getBigUint64(64, true);
  if (earned <= 0n) throw new Error('The harvest paid no SPARK.');
  console.log(`farm: ${Number(earned) / 1e6} SPARK harvested; unstaked ${await app.unstake('field', '0.01')}`);
}
// 6. A compressed badge, given by an open grant: the setup makes the collection with Bubblegum's plugin and opens the
// project's tree; a fresh player claims, paying the player fee; Bubblegum mints the badge into the tree.
if (want('compressed')) {
  await send([funder], [transferLamports(funder.address, owner.address, 300_000_000n)]);
  const live = await goLive('compressed-badge', {
    version: 2,
    network: 'devnet',
    name: 'Compressed badge',
    prompt: 'A free badge for anyone who asks, once per wallet, as a compressed NFT.',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Compressed badge' },
    items: [{ key: 'badge', name: 'Badge', uri: 'https://example.invalid/badge/{serial}.json' }],
    grants: [{ key: 'open', name: 'Open badge', prize: { gives: 'item', item: 'badge', compressed: true }, limits: { perWallet: 1 }, fund: 0.01 }],
  });
  const { project, tree } = live.live;
  if (!tree) throw new Error('The setup recorded no tree.');
  const id = live.grants[0].id;
  const player = freshKeypair();
  await send([owner], [transferLamports(owner.address, player.address, 10_000_000n)]);
  const grant = loot.decode('Grant', (await rpc.account(loot.pda.grant(project, id))).data);
  const item = loot.decode('Item', (await rpc.account(loot.pda.item(project, grant.gives.Compressed.item))).data);
  const claimed = await send([player], [computeUnitLimit(400_000), loot.claimGrantIx({ project, id, grant, wallet: player.address, signer: player.address, item })]);
  const config = (await rpc.account(loot.pda.treeConfig(tree))).data;
  const minted = new DataView(config.buffer, config.byteOffset).getBigUint64(80, true);
  if (minted !== 1n) throw new Error(`The tree counts ${minted} minted, not 1.`);
  console.log(`compressed: ${player.address} claimed ${claimed}; the tree ${tree} holds badge ${loot.pda.compressedAsset(tree, 0)}`);
}
console.log(`\nDone. Specs with their live sections: ${dir}`);
