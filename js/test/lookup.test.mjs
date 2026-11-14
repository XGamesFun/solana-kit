// Transactions too big for a legacy one: js/chain/lookup.js plans an address lookup table of a transaction's accounts
// and sends it as v0; js/play's `send` does so for anything the wallet sends, and a box's settle that doesn't fit the
// burner's legacy transaction goes from the wallet. Against the real loot program in LiteSVM: a box giving three NFTs
// of a stash and paying four holders' shares settles as v0, and the table's rent comes back to the player once it has
// cooled down.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { encodeBase58 } from '../chain/base58.js';
import { parseCoreAsset } from '../chain/core.js';
import {
  compileFitting,
  compileKeepingKind,
  createTableIx,
  deactivateTableIx,
  extendTableIx,
  LOOKUP_TABLE_PROGRAM,
  planTable,
  readTable,
  sendFitting,
  slotHashes,
  tableAccounts,
  tableStep,
  TABLE_COOLDOWN_SLOTS,
  WALLET_ADDS_BYTES,
} from '../chain/lookup.js';
import { computeUnitLimit, meta, transferLamports } from '../chain/programs.js';
import { COMPUTE_BUDGET_PROGRAM, SYSVAR_SLOT_HASHES } from '../chain/pda.js';
import { MAX_TRANSACTION_BYTES, readMessage, readTransaction, transactionSize, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp, walletStandardSigner } from '../play/index.js';
import { boxArgs, cannotRun, collectible, drop, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const key = n => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + n * 7 + 3) % 256));
const BLOCKHASH = key(999);

/** An instruction of a made-up program naming `n` accounts of its own. */
const wide = (payer, n, from = 0) => ({
  programId: key(500),
  keys: [meta(payer, true, true), ...Array.from({ length: n }, (_, i) => meta(key(from + i), false, i % 2 === 0))],
  data: new Uint8Array(40),
});

describe('lookup tables, planned (js/chain/lookup.js)', () => {
  const payer = key(1000);
  test('a transaction that fits stays legacy; one too big has no legacy message', () => {
    const small = compileFitting({ payer, blockhash: BLOCKHASH, instructions: [wide(payer, 20)] });
    assert.ok(small && small[0] < 0x80, 'legacy');
    assert.equal(
      compileFitting({ payer, blockhash: BLOCKHASH, instructions: [wide(payer, 40)] }),
      null,
      'no table given: nothing fits',
    );
  });

  test('room for what a wallet adds: a legacy transaction that leaves less goes as v0 with a table that makes it smaller', () => {
    const kind = m => (m === null ? null : m[0] === 0x80 ? 'v0' : 'legacy');
    const room = WALLET_ADDS_BYTES;
    const fit = (instructions, more = {}) => compileFitting({ payer, blockhash: BLOCKHASH, instructions, ...more });
    // A table of the accounts `wide` names, and one of accounts no transaction here names.
    const holds = [{ address: key(700), addresses: Array.from({ length: 30 }, (_, i) => key(i)) }];
    const strange = [{ address: key(701), addresses: Array.from({ length: 30 }, (_, i) => key(300 + i)) }];
    const small = [wide(payer, 10)];
    const tight = [wide(payer, 22)];
    assert.ok(transactionSize(fit(small)) <= MAX_TRANSACTION_BYTES - room, 'small leaves the room');
    const size = transactionSize(fit(tight));
    assert.ok(size > MAX_TRANSACTION_BYTES - room && size <= MAX_TRANSACTION_BYTES, 'tight fits, with less to spare');
    // With no room asked, as ever: legacy whenever it fits, tables or not.
    assert.equal(kind(fit(tight, { tables: holds })), 'legacy');
    // With room: what leaves it stays legacy; what does not goes with the table, smaller, the room free again.
    assert.equal(kind(fit(small, { tables: holds, room })), 'legacy');
    const loaded = fit(tight, { tables: holds, room });
    assert.equal(kind(loaded), 'v0');
    assert.ok(transactionSize(loaded) <= MAX_TRANSACTION_BYTES - room, `${transactionSize(loaded)} bytes of ${size}`);
    assert.deepEqual(
      readMessage(loaded).instructions.map(i => i.data.length),
      readMessage(fit(tight)).instructions.map(i => i.data.length),
      'the same instructions',
    );
    // No table, or one that holds none of its accounts (v0 with it would be the bigger): legacy, as with no room.
    assert.equal(kind(fit(tight, { room })), 'legacy');
    assert.equal(kind(fit(tight, { tables: strange, room })), 'legacy');
    // The line itself: a transaction of exactly the limit less the room stays legacy, one byte more goes with the table.
    const sized = data => [{ ...wide(payer, 20), data: new Uint8Array(data) }];
    const at = 40 + (MAX_TRANSACTION_BYTES - room - transactionSize(fit(sized(40))));
    assert.equal(transactionSize(fit(sized(at))), MAX_TRANSACTION_BYTES - room);
    assert.equal(kind(fit(sized(at), { tables: holds, room })), 'legacy');
    assert.equal(kind(fit(sized(at + 1), { tables: holds, room })), 'v0');
    // A table that holds only some of its accounts: v0 still, the smaller of the two, though the room is not reached.
    const some = [{ address: key(703), addresses: Array.from({ length: 3 }, (_, i) => key(i)) }];
    const little = fit(tight, { tables: some, room });
    assert.equal(kind(little), 'v0');
    assert.ok(transactionSize(little) < size && transactionSize(little) > MAX_TRANSACTION_BYTES - room);
    // The room a wallet's own instructions take, as measured; and a room that is no number above 0 is none.
    assert.equal(WALLET_ADDS_BYTES, 400);
    for (const none of [0, -100, NaN, undefined, null, '400x'])
      assert.deepEqual(fit(tight, { tables: holds, room: none }), fit(tight, { tables: holds }), String(none));
    assert.equal(fit([wide(payer, 40)], { room: -100 }), null, 'never a message past the limit');
    // Too big for a legacy transaction: v0 with the table or nothing, room or not.
    assert.equal(
      kind(
        fit([wide(payer, 40)], {
          tables: [{ address: key(702), addresses: Array.from({ length: 40 }, (_, i) => key(i)) }],
          room,
        }),
      ),
      'v0',
    );
    assert.equal(fit([wide(payer, 40)], { room }), null);
  });

  test('sendFitting with room: one v0 transaction with the standing tables, never a table of its own for the room’s sake', async () => {
    const sent = [];
    const rpc = {
      latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
      send: async wire => (sent.push(readTransaction(wire).message), `sig${sent.length}`),
      confirm: async () => {},
    };
    const sign = async message => wireTransaction(message, [new Uint8Array(64)]);
    const standing = [{ address: key(700), addresses: Array.from({ length: 30 }, (_, i) => key(i)) }];
    const go = (instructions, more) => sendFitting({ rpc, payer, instructions, sign, ...more });
    const versions = () => sent.splice(0).map(m => readMessage(m).version);
    const tight = [wide(payer, 22)];
    assert.deepEqual(await go(tight, { standing, room: WALLET_ADDS_BYTES }), {
      signature: 'sig1',
      table: null,
      steps: [],
    });
    assert.deepEqual(versions(), [0]);
    // No room asked (a key of the page's own signs: nothing is added), no standing table, or a small transaction: legacy.
    await go(tight, { standing });
    await go(tight, { room: WALLET_ADDS_BYTES });
    await go([wide(payer, 10)], { standing, room: WALLET_ADDS_BYTES });
    assert.deepEqual(versions(), ['legacy', 'legacy', 'legacy'], 'one transaction each: no table made');
    // `fresh`: the tables are read again just before a transaction goes as v0 for the room's sake only, and never else.
    let reads = 0;
    const fresh = tables => async () => (reads++, tables);
    await go(tight, { standing, room: WALLET_ADDS_BYTES, fresh: fresh([]) });
    assert.deepEqual([versions(), reads], [['legacy'], 1], 'the table is gone: legacy, as it always went');
    await go(tight, { standing, room: WALLET_ADDS_BYTES, fresh: fresh(standing) });
    assert.deepEqual([versions(), reads], [[0], 2], 'still there: v0');
    await go([wide(payer, 10)], { standing, room: WALLET_ADDS_BYTES, fresh: fresh([]) });
    await go(tight, { standing, fresh: fresh([]) });
    await go(tight, { room: WALLET_ADDS_BYTES, fresh: fresh([]) });
    assert.deepEqual(
      [versions(), reads],
      [['legacy', 'legacy', 'legacy'], 2],
      'not asked where no table would be used',
    );
    // A transaction too big for a legacy one goes with the tables it was given: they are not read again for it.
    const big = [wide(payer, 40)];
    const all = [{ address: key(704), addresses: Array.from({ length: 40 }, (_, i) => key(i)) }];
    await go(big, { standing: all, room: WALLET_ADDS_BYTES, fresh: fresh([]) });
    assert.deepEqual([versions(), reads], [[0], 2]);
  });

  test('a table of 55 accounts is made in two steps that each fit, and the transaction fits as v0 with it, deactivating it', () => {
    const instructions = [computeUnitLimit(1_400_000), wide(payer, 55)];
    const plan = planTable({ payer, blockhash: BLOCKHASH, slot: 1234n, instructions });
    assert.deepEqual(plan.table.addresses, tableAccounts(instructions));
    assert.equal(plan.table.addresses.length, 55, 'neither the payer nor a program the transaction calls');
    const first = key(9999);
    assert.equal(
      planTable({ payer, blockhash: BLOCKHASH, slot: 1234n, instructions, first: [first] }).table.addresses[0],
      first,
      '`first` goes in the creation step',
    );
    assert.equal(plan.steps.length, 2);
    for (const step of plan.steps)
      assert.ok(
        compileFitting({ payer, blockhash: BLOCKHASH, instructions: step })[0] < 0x80,
        'each step is a legacy transaction',
      );
    assert.deepEqual(plan.final.at(-1), deactivateTableIx({ table: plan.table.address, authority: payer }));
    const v0 = compileFitting({ payer, blockhash: BLOCKHASH, instructions: plan.final, tables: [plan.table] });
    assert.equal(v0[0], 0x80, 'v0');
    assert.ok(transactionSize(v0) < 600, `${transactionSize(v0)} bytes`);
  });

  test('more accounts than a transaction locks or a table holds, or instructions too long even as v0, have no plan', () => {
    assert.equal(planTable({ payer, blockhash: BLOCKHASH, slot: 1n, instructions: [wide(payer, 257)] }), null);
    assert.equal(
      planTable({ payer, blockhash: BLOCKHASH, slot: 1n, instructions: [wide(payer, 61)] }),
      null,
      '61 accounts, the payer, the program and the table’s: past 64 locks',
    );
    assert.ok(planTable({ payer, blockhash: BLOCKHASH, slot: 1n, instructions: [wide(payer, 60)] }), 'exactly 64');
    assert.equal(
      planTable({
        payer,
        blockhash: BLOCKHASH,
        slot: 1n,
        instructions: [{ ...wide(payer, 10), data: new Uint8Array(1200) }],
      }),
      null,
    );
  });

  test('a table read back, and when it can be closed', () => {
    const data = new Uint8Array(56 + 64);
    data[0] = 1;
    data.set(new Uint8Array(8).fill(255), 4);
    data[12] = 7;
    data[21] = 1;
    const table = readTable({ owner: LOOKUP_TABLE_PROGRAM, data });
    assert.equal(table.deactivationSlot, null);
    assert.equal(table.lastExtendedSlot, 7n);
    assert.equal(table.addresses.length, 2);
    assert.equal(tableStep(table, 10_000n), 'active');
    assert.equal(tableStep({ ...table, deactivationSlot: 100n }, 100n + TABLE_COOLDOWN_SLOTS), 'cooling');
    assert.equal(tableStep({ ...table, deactivationSlot: 100n }, 101n + TABLE_COOLDOWN_SLOTS), 'close');
    // By the SlotHashes read: closable only from a full read (512 slots) older than none of them.
    const full = from => Array.from({ length: 512 }, (_, i) => from - BigInt(i));
    assert.equal(tableStep({ ...table, deactivationSlot: 100n }, 2000n, full(2000n)), 'close');
    assert.equal(tableStep({ ...table, deactivationSlot: 100n }, 2000n, [2000n, 1999n]), 'cooling', 'a short read');
    assert.equal(tableStep({ ...table, deactivationSlot: 100n }, 2000n, []), 'cooling', 'an empty read');
    assert.equal(tableStep({ ...table, deactivationSlot: 1700n }, 2000n, full(2000n)), 'cooling', 'still held');
    assert.equal(readTable({ owner: key(5), data }), null, 'another program’s account');
  });
});

const asWallet = (kp, signed) => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    signed.push(t.message);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

/** A box that rolls, all but always on three NFTs a stash holds, each named, and pays four holders' shares, and a player's app. */
function bigBox(seed, { standing = null, versions = null } = {}) {
  const w = world({ seed });
  w.upsert({ Item: { id: 1, args: collectible('Relic') } });
  const relics = [0, 1, 2].map(() => w.make(1, w.authority));
  for (const asset of relics)
    w.chain.send(w.authority, [
      loot.stashIx({ signer: w.authority, project: w.project, id: 4, asset, collection: w.collection }),
    ]);
  const holders = [0, 1, 2, 3].map(() => {
    const owner = w.who();
    w.tokenAccount(owner, w.mint);
    return { owner, asset: w.make(1, owner) };
  });
  const shares = holders.map(h => ({ to: { Holder: [h.asset] }, bps: 500 }));
  // It draws among what is left (`DrawLeft`): a box that stops selling refuses an entry of several named NFTs of one stash.
  w.upsert({
    Box: {
      id: 1,
      args: boxArgs(
        PRICE,
        [
          drop(
            relics.map(nft => ({ Nft: { stash: 4, nft } })),
            1_000_000_000,
          ),
          drop([{ Nft: { stash: 4, nft: relics[0] } }]),
        ],
        { shares, when_out: 'DrawLeft' },
      ),
    },
  });
  w.upsert({ Box: { id: 2, args: boxArgs(PRICE, [drop([{ Stash: [5] }])]) } });
  const kp = freshKeypair();
  w.chain.airdrop(kp.address, 10_000_000_000n);
  w.fund(kp.address, w.mint, 10n * PRICE);
  const spec = {
    version: 2,
    name: 'Big',
    currency: 'gold',
    tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }],
    boxes: [
      { key: 'chest', name: 'Chest', id: 1 },
      { key: 'small', name: 'Small', id: 2 },
    ],
    live: { project: w.project, collections: [w.collection], mints: { gold: w.mint } },
  };
  // A project's standing lookup table (made at go-live; here by hand): the addresses its settles name most.
  if (standing) {
    const [slot] = slotHashes(w.chain.get(SYSVAR_SLOT_HASHES).data);
    const { address, instruction } = createTableIx({ authority: w.creator, slot });
    const vault = loot.vault(w.project, w.mint);
    const names = [
      w.project,
      loot.pda.fees(w.project),
      loot.pda.platform(),
      w.mint,
      vault,
      loot.ata(w.treasury, w.mint),
      loot.pda.stash(w.project, 4),
      w.collection,
      loot.MPL_CORE_PROGRAM,
      ...relics,
      ...holders.flatMap(h => [h.asset, h.owner, loot.ata(h.owner, w.mint)]),
    ];
    w.chain.send(w.creator, [instruction, extendTableIx({ table: address, authority: w.creator, addresses: names })]);
    if (standing === 'deactivated')
      w.chain.send(w.creator, [deactivateTableIx({ table: address, authority: w.creator })]);
    w.chain.nextSlot();
    spec.live.tables = [address];
  }
  const signed = [];
  const sent = [];
  let retired = false;
  const rpc = {
    ...w.chain.rpc,
    async send(wire) {
      sent.push(readTransaction(wire).message);
      return w.chain.rpc.send(wire);
    },
    // 'retired': the project's owner deactivates the table right after the page first read it, and it cools down
    // before the page sends anything: what a page left open across that would hold.
    async accounts(addresses, ...rest) {
      const read = await w.chain.rpc.accounts(addresses, ...rest);
      const table = spec.live.tables?.[0];
      if (standing === 'retired' && !retired && addresses.includes(table)) {
        retired = true;
        w.chain.send(w.creator, [deactivateTableIx({ table, authority: w.creator })]);
        w.chain.nextSlot(Number(TABLE_COOLDOWN_SLOTS) + 5);
        // (the simulator fills SlotHashes when it is read: as a cluster would hold it now)
        await w.chain.rpc.accounts([SYSVAR_SLOT_HASHES]);
      }
      return read;
    },
  };
  // `versions`: what the wallet says it signs (a Wallet Standard wallet's supportedTransactionVersions).
  const wallet = { ...asWallet(kp, signed), ...(versions ? { versions } : {}) };
  const app = solanaApp({ spec, rpc, wallet, now: () => w.chain.now() });
  return { w, app, kp, me: kp.address, relics, holders, signed, sent };
}

const units = message => {
  const m = readMessage(message);
  const ix = m.instructions.find(i => m.keys[i.programIndex] === COMPUTE_BUDGET_PROGRAM && i.data[0] === 2);
  return ix ? Number(new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true)) : null;
};

describe('js/play sends what doesn’t fit a legacy transaction as v0', () => {
  test(
    'a settle of three NFTs and four holders’ shares that doesn’t fit one transaction goes in parts from the burner: one prompt',
    { skip },
    async () => {
      const { w, app, me, relics, holders, signed, sent } = bigBox('lookup-big');
      const listing = (await app.boxes()).find(l => l.key === 'chest');
      const got = await app.openBox('chest', { listing });
      assert.equal(w.chain.get(got.order), null, 'settled: the order closed');
      assert.ok(
        relics.every(a => parseCoreAsset(w.chain.get(a).data).owner === me),
        'all three NFTs are the player’s',
      );
      assert.ok(
        holders.every(h => w.balance(h.owner) === PRICE / 20n),
        'each holder has its share',
      );
      // The open; a part of prizes only (no NFT rolled on, no shares); the last part with the shares, the burner's
      // lamports back with it. Each legacy, the parts the burner's.
      assert.deepEqual(
        sent.map(m => readMessage(m).version),
        ['legacy', 'legacy', 'legacy'],
      );
      assert.ok(
        sent.slice(1).every(m => readMessage(m).keys[0] !== me),
        'the burner sent both parts',
      );
      assert.equal(signed.length, 1, 'one prompt: the open');
      assert.equal(got.parts?.length, 2);
    },
  );

  test(
    'a lookup table a big transaction of the wallet’s made is listed in claims once cooled down, and its rent comes back',
    { skip },
    async () => {
      const { w, app, kp, me, signed } = bigBox('lookup-table-claim');
      const { sendFitting } = await import('../chain/lookup.js');
      // Forty payments to forty new wallets: too many accounts for a legacy transaction.
      const instructions = Array.from({ length: 40 }, (_, i) => transferLamports(me, key(2000 + i), 1_000_000n));
      const wallet = asWallet(kp, signed);
      await sendFitting({
        rpc: w.chain.rpc,
        payer: me,
        instructions,
        sign: message => wallet.signTransaction(wireTransaction(message)),
        first: [w.project],
        sleep: async () => w.chain.nextSlot(),
      });
      const [found] = await w.chain.rpc.programAccounts(LOOKUP_TABLE_PROGRAM, [{ memcmp: { offset: 22, bytes: me } }]);
      const table = readTable(found.account);
      assert.ok(table.deactivationSlot !== null, 'the transaction deactivated it');
      assert.deepEqual(
        (await app.claims()).filter(c => c.kind === 'lookup-table'),
        [],
        'not yet: it is cooling down',
      );
      w.chain.nextSlot(Number(TABLE_COOLDOWN_SLOTS) + 1);
      const [claim] = (await app.claims()).filter(c => c.kind === 'lookup-table');
      assert.match(claim.says, /SOL of rent back/);
      const before = await w.chain.rpc.balance(me);
      await app.claim(claim);
      assert.equal(w.chain.get(found.pubkey), null, 'closed');
      assert.ok((await w.chain.rpc.balance(me)) > before, 'its rent is the player’s again');
    },
  );

  test(
    'with the project’s standing lookup table the same settle is one v0 transaction, one prompt; a deactivated table is passed by',
    { skip },
    async () => {
      const { w, app, relics, signed, sent, me } = bigBox('lookup-standing', { standing: 'active' });
      const got = await app.openBox('chest', { listing: (await app.boxes()).find(l => l.key === 'chest') });
      assert.equal(w.chain.get(got.order), null, 'settled');
      assert.ok(relics.every(a => parseCoreAsset(w.chain.get(a).data).owner === me));
      assert.deepEqual(
        sent.map(m => readMessage(m).version),
        [0, 0, 'legacy'],
        'the open, the settle with the standing table, the burner’s lamports back',
      );
      // The open fits a legacy transaction, with less to spare than a wallet's own checks take: it goes with the
      // standing table too, and the room is free again.
      assert.ok(
        transactionSize(sent[0]) <= MAX_TRANSACTION_BYTES - WALLET_ADDS_BYTES,
        `${transactionSize(sent[0])} bytes`,
      );
      assert.equal(signed.length, 2, 'two prompts: the open and the settle; no table of its own');
      const off = bigBox('lookup-standing-off', { standing: 'deactivated' });
      await off.app.openBox('chest', { listing: (await off.app.boxes()).find(l => l.key === 'chest') });
      assert.deepEqual(
        off.sent.map(m => readMessage(m).version),
        ['legacy', 'legacy', 'legacy'],
        'in parts, as with none',
      );
      // A table retired after the page read it: the open is read against the chain again before it is sent, so it
      // goes as the legacy transaction it always was, and lands; nothing rests on the table that is gone.
      const gone = bigBox('lookup-standing-retired', { standing: 'retired' });
      const landed = await gone.app.openBox('chest', {
        listing: (await gone.app.boxes()).find(l => l.key === 'chest'),
      });
      assert.equal(gone.w.chain.get(landed.order), null, 'settled');
      assert.deepEqual(
        gone.sent.map(m => readMessage(m).version),
        ['legacy', 'legacy', 'legacy'],
        'as with none',
      );
      // A wallet that says it signs no v0 transaction: the open goes legacy, as before this rule (the settle, too big
      // for a legacy transaction, still goes with the table, as it always did).
      const old = bigBox('lookup-standing-legacy-wallet', { standing: 'active', versions: ['legacy'] });
      await old.app.openBox('chest', { listing: (await old.app.boxes()).find(l => l.key === 'chest') });
      assert.deepEqual(
        old.sent.map(m => readMessage(m).version),
        ['legacy', 0, 'legacy'],
      );
      // The same open with no table to load from: legacy, as it always went, with less than the room to spare.
      const alone = transactionSize(off.sent[0]);
      assert.ok(alone > MAX_TRANSACTION_BYTES - WALLET_ADDS_BYTES && alone <= MAX_TRANSACTION_BYTES, `${alone} bytes`);
    },
  );

  test(
    'right after one’s own open, an order a lagging RPC node doesn’t show yet is read again, never “settled already”',
    { skip },
    async () => {
      const { w } = bigBox('lookup-lag');
      const relic = w.make(1, w.authority);
      w.chain.send(w.authority, [
        loot.stashIx({ signer: w.authority, project: w.project, id: 5, asset: relic, collection: w.collection }),
      ]);
      // The first two reads of an order after the open answer nothing, as a node lagging behind did on devnet.
      let hidden = 2;
      const isOrder = a => a?.owner === loot.LOOT_PROGRAM && a.data[0] === loot.TAGS.Order;
      const rpc = {
        ...w.chain.rpc,
        async accounts(addresses, ...rest) {
          return (await w.chain.rpc.accounts(addresses, ...rest)).map(a => (isOrder(a) && hidden-- > 0 ? null : a));
        },
        async account(address, ...rest) {
          return (await this.accounts([address], ...rest))[0];
        },
      };
      const spec = {
        version: 2,
        name: 'Lag',
        currency: 'gold',
        tokens: [{ key: 'gold', mint: w.mint, decimals: 6 }],
        boxes: [{ key: 'small', name: 'Small', id: 2 }],
        live: { project: w.project, collections: [w.collection], mints: { gold: w.mint } },
      };
      const kp = freshKeypair();
      w.chain.airdrop(kp.address, 10_000_000_000n);
      w.fund(kp.address, w.mint, 10n * PRICE);
      const app = solanaApp({ spec, rpc, wallet: asWallet(kp, []), now: () => w.chain.now() });
      const got = await app.openBox('small', { listing: (await app.boxes()).find(l => l.key === 'small') });
      assert.notEqual(got.settled, 'elsewhere', got.says);
      assert.ok(got.settled, 'settled by the burner');
      assert.equal(parseCoreAsset(w.chain.get(relic).data).owner, kp.address);
      assert.ok(hidden <= 0, 'the order was hidden twice first');
    },
  );

  test('a settle that fits goes from the burner, legacy, with a compute limit', { skip }, async () => {
    const { w, app, me, sent, signed } = bigBox('lookup-small');
    const relic = w.make(1, w.authority);
    w.chain.send(w.authority, [
      loot.stashIx({ signer: w.authority, project: w.project, id: 5, asset: relic, collection: w.collection }),
    ]);
    const got = await app.openBox('small', { listing: (await app.boxes()).find(l => l.key === 'small') });
    assert.equal(w.chain.get(got.order), null);
    assert.equal(parseCoreAsset(w.chain.get(relic).data).owner, me);
    assert.equal(signed.length, 1, 'one prompt: the open');
    const settle = sent.at(-1);
    assert.equal(readMessage(settle).version, 'legacy');
    assert.notEqual(readMessage(settle).keys[0], me, 'the burner paid it');
    assert.equal(units(settle), 1_400_000, 'it moves an NFT');
  });
});

test('a Wallet Standard signer carries the kinds of transaction its wallet says it signs', () => {
  const account = { address: key(1) };
  const wallet = versions => ({
    name: 'A wallet',
    features: {
      'solana:signTransaction': {
        ...(versions ? { supportedTransactionVersions: versions } : {}),
        signTransaction: async () => [{ signedTransaction: new Uint8Array() }],
      },
    },
  });
  const says = versions => walletStandardSigner(wallet(versions), account, 'solana:devnet').versions;
  assert.deepEqual(says(new Set(['legacy', 0, 1])), ['legacy', 0, 1]);
  assert.deepEqual(says(['legacy']), ['legacy']);
  assert.deepEqual(says(null), ['legacy', 0], 'a wallet that says nothing is taken to sign both, as before');
});

test('a throwaway key’s transaction too big for a legacy one is refused in words, not sent', async () => {
  const { sendFitting } = await import('../chain/lookup.js');
  const payer = key(77);
  const rpc = {
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    send: async () => assert.fail('sent'),
  };
  await assert.rejects(
    sendFitting({
      rpc,
      payer,
      instructions: [wide(payer, 40), transferLamports(payer, key(3), 1n)],
      sign: async () => new Uint8Array(),
      table: false,
    }),
    /holds no rent for a lookup table/,
  );
});

describe('xsolana_check sizes every box’s settle', async () => {
  const { check, settleSize, settleUnits } = await import('../economy/check.mjs');
  const { model } = await import('../economy/model.mjs');
  const { requestHeapFrame } = await import('../chain/programs.js');
  const { TOKEN_PROGRAM } = await import('../chain/pda.js');
  const { compileMessage } = await import('../chain/tx.js');
  const A = n => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 13 + 1) % 256));
  const NOW = 1_790_000_000;
  const shape = ({ tokens = 0, core = 0, pnft = 0, holders = 0, wallets = 0, hooked = false, subject = false }) => ({
    version: 2,
    network: 'devnet',
    name: 'Shapes',
    currency: 'coin',
    tokens: [
      {
        key: 'coin',
        source: 'existing',
        mint: A(1),
        decimals: 6,
        ...(hooked ? { program: 'token-2022', powers: { transferHook: true } } : { powers: {} }),
      },
      ...Array.from({ length: tokens }, (_, i) => ({
        key: `t${i}`,
        source: 'existing',
        mint: A(10 + i),
        decimals: 0,
        powers: {},
      })),
    ],
    collection: { name: 'Shapes' },
    items: [{ key: 'hero', name: 'Hero' }],
    pools: Array.from({ length: tokens }, (_, i) => ({ key: `p${i}`, currency: `t${i}`, seed: 100 })),
    stashes: [
      { key: 'c', name: 'Core', collection: A(30), nfts: [A(40), A(41), A(42)] },
      {
        key: 'pn',
        name: 'P',
        nfts: [
          { mint: A(70), programmable: true },
          { mint: A(71), programmable: true },
          { mint: A(72), programmable: true },
        ],
      },
    ],
    boxes: [
      {
        key: 'roll',
        name: 'Roll',
        price: 1,
        ...(subject ? { rollsOn: { item: 'hero' }, then: { giveTo: A(3) } } : {}),
        split: [
          ...Array.from({ length: holders }, (_, i) => ({ to: `holder:${A(60 + i)}`, percent: 5 })),
          ...Array.from({ length: wallets }, (_, i) => ({ to: A(80 + i), percent: 5 })),
        ],
        outcomes: [
          {
            gives: 'bundle',
            weight: 1000,
            prizes: [
              ...Array.from({ length: tokens }, (_, i) => ({ gives: 'pay', pool: `p${i}`, amount: 7 })),
              ...Array.from({ length: core }, () => ({ gives: 'stash', stash: 'c' })),
              ...Array.from({ length: pnft }, () => ({ gives: 'stash', stash: 'pn' })),
            ],
          },
          { gives: 'nothing', weight: 1 },
        ],
      },
    ],
  });
  const verdict = args => {
    const r = check(shape(args), { now: NOW });
    return {
      refused: r.refusals.filter(x => x.code === 'E-TX-SIZE'),
      v0: r.warnings.find(x => x.code === 'W-SETTLE-V0'),
    };
  };

  test('the estimate is the settle the client builds, byte for byte: three Core NFTs of a stash and four holders’ shares, 1,271 bytes', () => {
    const m = model(shape({ core: 3, holders: 4 }));
    const est = settleSize(m.boxes[0], m.boxes[0].outcomes[0], m);
    const k = n => key(2000 + n);
    const assets = [k(1), k(2), k(3), k(4)];
    const order = {
      project: k(5),
      player: k(6),
      mint: k(7),
      loot_box: k(8),
      status: 'Rolled',
      won: [k(9), k(10), k(11)].map(nft => ({ Nft: { stash: 0, nft } })),
      paid: 1n,
      fee: 0n,
      shares: assets.map(a => ({ to: { Holder: [a] }, bps: 500 })),
      subject: '11111111111111111111111111111111',
      held: false,
      fate: null,
      requested_slot: 1n,
      drew: 1,
    };
    const ix = loot.settleIx({
      signer: k(12),
      orderAddress: k(13),
      order,
      projectState: { treasury: k(14) },
      items: {},
      nfts: Object.fromEntries(order.won.map(w => [w.Nft.nft, { collection: k(15) }])),
      putBack: [],
      subject: {},
      holders: Object.fromEntries(assets.map((a, i) => [a, k(20 + i)])),
      programs: { [k(7)]: TOKEN_PROGRAM },
    });
    const real = transactionSize(
      compileMessage({
        payer: k(12),
        blockhash: BLOCKHASH,
        instructions: [computeUnitLimit(1_400_000), requestHeapFrame(loot.settleHeapFrame(order)), ix],
      }),
    );
    assert.equal(est.legacy, real);
    assert.equal(real, 1271);
  });

  test('a settle too big for a legacy transaction, NFTs or not, is warned of as v0 with a table’s rent; one that fits is not', () => {
    for (const args of [
      { core: 3, holders: 4 },
      { tokens: 3, holders: 4 },
      { pnft: 3, holders: 4, subject: true },
    ]) {
      const { refused, v0 } = verdict(args);
      assert.deepEqual(refused, [], JSON.stringify(args));
      assert.match(
        v0?.message ?? '',
        /as a v0 transaction that loads its accounts from an address lookup table.*the project’s standing table, which going live makes.*SOL of rent back/s,
        JSON.stringify(args),
      );
    }
    assert.equal(verdict({ core: 3, holders: 3 }).v0, undefined);
  });

  test('the largest settle a spec allows (three pNFTs, the NFT rolled on, four holders, a hooked coin: 61 accounts) is not refused, and its compute is under 1.4M', () => {
    assert.deepEqual(verdict({ pnft: 3, holders: 4, subject: true, hooked: true }).refused, []);
    const m = model(shape({ pnft: 3, holders: 4, subject: true, hooked: true }));
    const units = settleUnits(m.boxes[0], m.boxes[0].outcomes[0], m);
    assert.ok(units > 985_942 && units < 1_400_000, `${units}: above the measured 985,942, under the limit`);
  });

  test('the heap warnings say xsolana’s senders land it as v0 with a lookup table', () => {
    const heap = check(shape({ core: 0, pnft: 3, holders: 4, subject: true, hooked: true }), {
      now: NOW,
    }).warnings.find(w => w.code === 'W-BOX-HEAP');
    assert.match(
      heap.message,
      /send a settle too big for a legacy transaction as a v0 one with a lookup table \(W-SETTLE-V0\): it lands/,
    );
  });
});

describe('a transaction with two forms keeps the kind its plain form has', () => {
  // An instruction of `bytes` of data naming `accounts` addresses, from `payer`.
  const random = n => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + 1) % 256));
  const big = (payer, bytes, accounts) => ({
    programId: random(99),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      ...Array.from({ length: accounts }, (_, i) => ({ pubkey: random(i), isSigner: false, isWritable: false })),
    ],
    data: new Uint8Array(bytes),
  });
  const lead = { programId: random(98), keys: [], data: new Uint8Array(40) };
  const payer = random(200);
  const blockhash = random(201);
  const kind = message => (message ? (message[0] & 0x80 ? 'v0' : 'legacy') : null);
  const carries = (message, ix) =>
    Buffer.from(message).includes(Buffer.from(ix.data.length === 40 ? [40, ...ix.data] : []));

  test('legacy stays legacy, with the lead where it fits and without it where it does not; v0 only for what needed it', () => {
    const tables = [{ address: random(202), addresses: Array.from({ length: 20 }, (_, i) => random(i)) }];
    const form = plain => compileKeepingKind({ payer, blockhash, led: [lead, ...plain], plain, tables });
    // Small: legacy, led.
    const small = [big(payer, 100, 4)];
    assert.equal(kind(form(small)), 'legacy');
    assert.ok(carries(form(small), lead));
    // Fits a legacy transaction alone, and not with the lead: legacy still, without it (v0 with it would fit).
    const tight = [big(payer, 380, 20)];
    assert.equal(kind(compileFitting({ payer, blockhash, instructions: tight })), 'legacy');
    assert.equal(kind(compileFitting({ payer, blockhash, instructions: [lead, ...tight] })), null);
    assert.equal(kind(compileFitting({ payer, blockhash, instructions: [lead, ...tight], tables })), 'v0');
    assert.equal(kind(form(tight)), 'legacy');
    assert.ok(!carries(form(tight), lead));
    // Needs the tables anyway: v0, led.
    const wide = [big(payer, 520, 20)];
    assert.equal(kind(compileFitting({ payer, blockhash, instructions: wide })), null);
    assert.equal(kind(form(wide)), 'v0');
    assert.ok(carries(form(wide), lead));
    // Fits neither way: null.
    assert.equal(form([big(payer, 1300, 2)]), null);
  });
});
