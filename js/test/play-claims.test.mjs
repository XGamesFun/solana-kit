// What claims() lists beside a player's own wins: a lender's overdue loan (its NFT theirs to take), and a seller's own
// auction once it is over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { addressBytes, decodeBase58, encodeBase58 } from '../chain/base58.js';
import { parseCoreAsset } from '../chain/core.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { solanaApp } from '../play/index.js';
import { cannotRun, collectible, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const asWallet = kp => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});

test('a lender sees their overdue loan in claims() and takes its NFT', { skip }, async () => {
  const w = world({ seed: 'claims-lender' });
  w.upsert({ Item: { id: 1, args: collectible('Fighter') } });
  const [lender, borrower] = [freshKeypair(), freshKeypair()];
  for (const k of [lender, borrower]) w.chain.airdrop(k.address, 100_000_000_000n);
  w.fund(lender.address, w.mint, 10n * PRICE);
  w.chain.send(lender.address, [
    loot.openOfferIx({
      maker: lender.address,
      project: w.project,
      id: 1,
      mint: w.mint,
      args: {
        rule: { of: { Item: [1] }, key: '', test: 'Any' },
        deal: { Lend: { amount: PRICE, repay: 2n * PRICE, lasts: 3600 } },
        left: 1,
      },
    }),
  ]);
  const spec = { version: 2, tokens: [], live: { project: w.project, collection: w.collection } };
  const app = kp => solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(kp), now: () => w.chain.now() });
  const nft = w.make(1, borrower.address);
  await app(borrower).borrow(lender.address, 1, nft);
  assert.deepEqual(await app(lender).claims(), [], 'not due yet');
  w.chain.warp(w.chain.now() + 3_700);
  const claims = await app(lender).claims();
  assert.deepEqual(
    claims.map(c => c.kind),
    ['release'],
  );
  assert.match(claims[0].says, /loan you made is overdue/);
  await app(lender).claim(claims[0]);
  assert.equal(parseCoreAsset(w.chain.get(nft).data).owner, lender.address, 'the NFT is the lender’s');
});

test(
  'a proof record the player paid for is found by its payer, through a relay that refuses a scan of a whole kind',
  { skip },
  async () => {
    const w = world({ seed: 'claims-proven' });
    const [player, other] = [freshKeypair(), freshKeypair()];
    w.chain.airdrop(player.address, 10_000_000_000n);
    // Proven records as the program writes them: the tag, eight addresses and hashes, the asset data hash (none, or
    // one), the flags, the nonce, the payer
    const proven = (payer, hash, n) => {
      const data = new Uint8Array(1 + 32 * 8 + 33 + 1 + 8 + 32);
      data[0] = loot.TAGS.Proven;
      data.set(addressBytes(freshKeypair().address), 1);
      data.set(addressBytes(freshKeypair().address), 33);
      let at = 1 + 32 * 8;
      data[at] = hash ? 1 : 0;
      at += hash ? 33 : 1;
      data[at + 1] = n;
      data.set(addressBytes(payer), at + 9);
      return data;
    };
    const records = [
      proven(player.address, false, 1),
      proven(player.address, true, 2),
      proven(other.address, false, 3),
    ];
    for (const data of records)
      w.chain.put(freshKeypair().address, { owner: loot.lootProgram(), lamports: 3_000_000n, data });
    // the play host's relay: a scan of loot's accounts names one kind and one address, or it is refused
    const asked = [];
    const rpc = {
      ...w.chain.rpc,
      async programAccounts(program, filters = []) {
        asked.push(filters.map(f => f.memcmp?.offset));
        const named = filters.some(f => f.memcmp && f.memcmp.offset > 0 && decodeBase58(f.memcmp.bytes).length === 32);
        if (program === loot.lootProgram() && !named)
          throw new Error('getProgramAccounts is relayed for the loot program as loot’s client asks it');
        return w.chain.rpc.programAccounts(program, filters);
      },
    };
    const spec = { version: 2, tokens: [], live: { project: w.project, collection: w.collection } };
    const app = solanaApp({ spec, rpc, wallet: asWallet(player), now: () => w.chain.now() });
    const claims = await app.claims();
    const leaves = claims.filter(c => c.kind === 'close-leaf');
    assert.equal(leaves.length, 2, 'both of the player’s, with an asset data hash and without; not another payer’s');
    assert.ok(
      asked.some(o => o.includes(loot.PROVEN_PAYER_AT[0])) && asked.some(o => o.includes(loot.PROVEN_PAYER_AT[1])),
    );
    // a relay that refuses those scans too: the rest of the claims are still listed, never an error
    const refusing = {
      ...rpc,
      async programAccounts(program, filters) {
        if (filters[0]?.memcmp?.bytes === encodeBase58(Uint8Array.of(loot.TAGS.Proven))) throw new Error('refused');
        return rpc.programAccounts(program, filters);
      },
    };
    const quiet = await solanaApp({ spec, rpc: refusing, wallet: asWallet(player), now: () => w.chain.now() }).claims();
    assert.deepEqual(
      quiet.filter(c => c.kind === 'close-leaf'),
      [],
    );
  },
);
