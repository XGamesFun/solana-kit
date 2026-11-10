// js/play on loot 0.26, through the player module on the real program: a settle that fails because the player can't
// receive a prize says which and that tokens given up stay in the project's vault, and `collect` with `giveUp` settles
// the rest; and a lottery whose run of places each give a roll, more than one pull carries, claimed until nothing is
// owed, each place's roll at its own order and the round's close on the last pull only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { freshKeypair } from '../approve/ed25519.mjs';
import { parseCoreAsset } from '../chain/core.js';
import { readMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { boxArgs, cannotRun, collectible, drop, fromPool, itemDrop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NOBODY = '11111111111111111111111111111111';
const { pda } = loot;

/** A wallet that signs for `kp` and keeps every message it signed. */
const asWallet = kp => ({
  address: kp.address,
  signed: [],
  async signTransaction(wire) {
    const t = readTransaction(wire);
    this.signed.push(t.message);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

/** A player with SOL and the project's token, and the app over `spec` live on `w`'s project. */
function playerApp(w, spec) {
  const player = freshKeypair();
  w.chain.airdrop(player.address, 10_000_000_000n);
  w.fund(player.address, w.mint, 100n * PRICE);
  const wallet = asWallet(player);
  const live = { ...spec, live: { project: w.project, collection: w.collection, mints: { gold: w.mint } } };
  return {
    player: player.address,
    wallet,
    app: solanaApp({ spec: live, rpc: w.chain.rpc, wallet, now: () => w.chain.now() }),
  };
}

/** Sets an SPL token account's state byte (108): 2 frozen, as its issuer's freeze leaves it; 1 open. */
function setFrozen(w, account, frozen) {
  const held = w.chain.get(account);
  const data = Uint8Array.from(held.data);
  data[108] = frozen ? 2 : 1;
  w.chain.put(account, { ...held, data });
}

/** Writes over every copy of `from` in an account's data with `to`. */
function replaceAddress(w, account, from, to) {
  const held = w.chain.get(account);
  const data = Uint8Array.from(held.data);
  const [a, b] = [addressBytes(from), addressBytes(to)];
  for (let i = 0; i + 32 <= data.length; i++) if (a.every((x, k) => data[i + k] === x)) data.set(b, i);
  w.chain.put(account, { ...held, data });
}

const coreOwner = (w, asset) => parseCoreAsset(w.chain.get(asset).data).owner;

test(
  'a prize the player can’t receive: the settle says which and that tokens given up stay in the vault; collect with giveUp settles the rest',
  { skip },
  async () => {
    const w = world({ seed: 'play-give-up' });
    const coin = w.newMint();
    w.pool(2, coin, 10_000n);
    w.upsert({ Item: { id: 1, args: collectible('Badge') } });
    w.upsert({ Box: { id: 1, args: boxArgs(PRICE, [drop([fromPool(2, 700), { Item: [1] }])]) } });
    const { player, app } = playerApp(w, {
      version: 2,
      name: 'Give up',
      currency: 'gold',
      tokens: [
        { key: 'gold', mint: w.mint, decimals: 6 },
        { key: 'coin', mint: coin, decimals: 6 },
      ],
      boxes: [{ key: 'chest', id: 1, name: 'Chest' }],
    });
    const vault = loot.vault(w.project, coin);
    const mine = loot.ata(player, coin);
    const listing = async () => (await app.boxes()).find(b => b.key === 'chest');

    // 1. The token's issuer froze the player's account of it: the settle fails, and says so.
    w.tokenAccount(player, coin);
    setFrozen(w, mine, true);
    const err = await app.openBox('chest', { listing: await listing() }).then(
      () => assert.fail('the settle can’t land'),
      e => e,
    );
    assert.deepEqual(err.giveUp, [0], 'the tokens, by their place in what the order won');
    assert.match(err.message, /can.t reach your wallet/);
    assert.match(err.message, /tokens given up stay in the project.s vault/);
    const [{ order }] = (await app.claims()).filter(c => c.kind === 'settle');
    const won = w.read('Order', order).won;
    const badge = pda.itemAsset(pda.item(w.project, 1), won[1].Item.serial);
    const vaultHeld = w.chain.tokens(vault);
    assert.equal(w.chain.get(badge), null, 'nothing given yet');
    // 2. Given up: the rest is settled, the tokens stay in the vault.
    const settled = await app.collect(order, { giveUp: err.giveUp });
    assert.ok(settled.settled);
    assert.equal(w.chain.get(order), null, 'the order settled and closed');
    assert.equal(coreOwner(w, badge), player, 'the collectible is theirs');
    assert.equal(w.chain.tokens(vault), vaultHeld, 'the tokens given up stayed in the project’s vault');
    assert.equal(w.chain.tokens(mine), 0n, 'and never reached the frozen account');
    assert.deepEqual(settled.assets, [null, badge]);
    setFrozen(w, mine, false);

    // 3. A collection that refuses the mint: the project is no longer the collection's update delegate.
    replaceAddress(w, w.collection, w.project, w.who());
    const refused = await app.openBox('chest', { listing: await listing() }).then(
      () => assert.fail('the mint is refused'),
      e => e,
    );
    assert.deepEqual(refused.giveUp, [1], 'the collectible, the one Core would not make');
    const [{ order: next }] = (await app.claims()).filter(c => c.kind === 'settle');
    const serial = w.read('Order', next).won[1].Item.serial;
    const issued = w.read('Item', pda.item(w.project, 1));
    const before = w.chain.tokens(mine);
    await app.collect(next, { giveUp: refused.giveUp });
    assert.equal(w.chain.get(next), null, 'settled');
    assert.equal(w.chain.tokens(mine) - before, 700n, 'the tokens reached the player');
    assert.equal(w.chain.get(pda.itemAsset(pda.item(w.project, 1), serial)), null, 'the collectible was never made');
    const after = w.read('Item', pda.item(w.project, 1));
    assert.equal(Number(after.voided ?? 0) - Number(issued.voided ?? 0), 1, 'its serial voided');
  },
);

test(
  'a run of places that each give a roll, more than one pull carries: claimed until nothing is owed, each roll at its own order, the close on the last pull',
  { skip },
  async () => {
    const w = world({ seed: 'play-roll-run' });
    w.upsert({ Item: { id: 1, args: collectible('Shard') } });
    const CHEST = 5;
    w.upsert({ Box: { id: CHEST, args: boxArgs(0n, [itemDrop(1), itemDrop(1)], { active: false }) } });
    const PLACES = 30;
    const t0 = w.chain.now();
    w.upsert({
      Lottery: {
        id: 1,
        args: {
          price: 1000n,
          mint: w.mint,
          pays_from: { Pot: [0] },
          shares: [],
          places: [{ bps: 0, prize: { Roll: [CHEST] }, times: PLACES }],
          ticket_mint: NOBODY,
          every: 0n,
          draws_at: BigInt(t0 + 3600),
          gate: null,
        },
      },
    });
    const { player, wallet, app } = playerApp(w, {
      version: 2,
      name: 'Rolls',
      currency: 'gold',
      tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }],
      lotteries: [{ key: 'draw', pot: 0, name: 'Draw', id: 1 }],
    });
    await app.buyTickets('draw', PLACES, { listing: (await app.lotteries()).find(l => l.key === 'draw') });
    w.chain.warp(t0 + 3601);
    await app.claim((await app.claims()).find(c => c.kind === 'reveal'));
    const lottery = pda.lottery(w.project, 1);
    const roundAddress = pda.round(lottery, w.read('Lottery', lottery).incarnation, 0);
    const pulled = () =>
      wallet.signed.flatMap(message => {
        const m = readMessage(message);
        return m.instructions
          .filter(ix => m.keys[ix.programIndex] === loot.LOOT_PROGRAM)
          .filter(ix => loot.instructionOf(ix.data)?.name === 'pull')
          .map(ix => ix.accountIndexes.map(i => m.keys[i]));
      });
    const PULL = loot.IDL.instructions.find(i => i.name === 'pull').accounts.map(a => a.name);
    const closes = keys => keys[PULL.indexOf('treasury')] !== loot.LOOT_PROGRAM;
    // Claimed as the player finds it: their places, then what is owed in common, until nothing is.
    for (let i = 0; i < 10; i++) {
      const next = (await app.claims()).find(c => c.kind === 'pull' || c.kind === 'payout');
      if (!next) break;
      await app.claim(next);
    }
    assert.equal(w.chain.get(roundAddress), null, 'nothing owed: the round closed');
    const pulls = pulled();
    const rollPulls = pulls.filter(keys => keys.includes(pda.box(w.project, CHEST)));
    assert.ok(rollPulls.length >= 2, `more places than one pull carries: ${rollPulls.length} pulls`);
    assert.deepEqual(
      pulls.map(closes),
      pulls.map((_, k) => k === pulls.length - 1),
      'the close’s accounts on the last pull only',
    );
    // Each place's roll at its own order: the one nonce of the entry's pulls, plus its place.
    const nonce = loot.prizeNonce(roundAddress, 0n);
    const orders = Array.from({ length: PLACES }, (_, place) =>
      pda.order(w.project, player, loot.prizeRollNonce(nonce + BigInt(place))),
    );
    assert.equal(new Set(orders).size, PLACES);
    for (const order of orders) assert.ok(w.chain.get(order), 'a roll made for each place');
    // And each is the player's to ask and settle.
    const waiting = (await app.claims()).filter(c => c.kind === 'settle').map(c => c.order);
    assert.deepEqual(new Set(waiting), new Set(orders.filter(o => w.read('Order', o).status !== 'Rolled')));
  },
);
