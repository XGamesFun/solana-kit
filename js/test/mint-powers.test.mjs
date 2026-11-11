// What a mint's own keys can do, read from the mint as the chain holds it (`powersOf`, js/chain/token2022.js): each
// Token-2022 extension made by Token-2022 itself, as mainnet runs it, so the reader is held to the real layouts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressBytes } from '../chain/base58.js';
import { concat, uintLE } from '../chain/bytes.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { meta } from '../chain/programs.js';
import { checkMints, MintMismatch } from '../approve/live-check.mjs';
import { createFungibleMetadataIx } from '../chain/metadata.js';
import { tokenEntry } from '../chain/mint.js';
import { createAccountIx, initializeMint2Ix, setAuthorityIx } from '../chain/token.js';
import { powersOf } from '../chain/token2022.js';
import { check } from '../economy/check.mjs';
import { model } from '../economy/model.mjs';
import { runTool } from '../mcp/server.mjs';
import { newAddress } from '../sim/chain.mjs';
import { cannotRun, world } from './world.mjs';

const skip = cannotRun() ?? false;
const NONE32 = new Uint8Array(32);
const some = address => concat(Uint8Array.of(1), addressBytes(address));

/** Token-2022 instructions that set a mint's extension up, before the mint itself: [data, the extension's bytes]. */
const EXTENSIONS = {
  transferFee: (who, { points = 250, changeable = true } = {}) => [
    concat(
      Uint8Array.of(26, 0),
      changeable ? some(who) : Uint8Array.of(0),
      some(who),
      uintLE(points, 2),
      uintLE(1_000_000, 8),
    ),
    108,
  ],
  closeAuthority: who => [concat(Uint8Array.of(25), some(who)), 32],
  confidential: who => [concat(Uint8Array.of(27, 0), addressBytes(who), Uint8Array.of(1), NONE32), 65],
  defaultState: (who, { state = 2 } = {}) => [Uint8Array.of(28, 0, state), 1],
  nonTransferable: () => [Uint8Array.of(32), 0],
  permanentDelegate: who => [concat(Uint8Array.of(35), addressBytes(who)), 32],
  hook: (who, { program = null } = {}) => [
    concat(Uint8Array.of(36, 0), addressBytes(who), program ? addressBytes(program) : NONE32),
    64,
  ],
  pausable: who => [concat(Uint8Array.of(44, 0), addressBytes(who)), 33],
};

/** A Token-2022 mint with these extensions, made by Token-2022; returns the account as the chain holds it. */
function mintWith(w, extensions, { freeze = false, decimals = 6 } = {}) {
  const mint = newAddress(w.random);
  const made = extensions.map(([name, options]) => EXTENSIONS[name](w.creator, options));
  // a Token-2022 mint with no extension is a classic mint's 82 bytes; with any, a token account's 165, its kind, then each
  const space = made.length ? 166 + made.reduce((n, [, bytes]) => n + 4 + bytes, 0) : 82;
  w.chain.send(
    w.creator,
    [
      createAccountIx({
        from: w.creator,
        address: mint,
        lamports: w.chain.rent(space),
        space,
        owner: TOKEN_2022_PROGRAM,
      }),
      ...made.map(([data]) => ({ programId: TOKEN_2022_PROGRAM, keys: [meta(mint, false, true)], data })),
      initializeMint2Ix({
        mint,
        decimals,
        authority: w.creator,
        freezeAuthority: freeze ? w.creator : null,
        tokenProgram: TOKEN_2022_PROGRAM,
      }),
    ],
    { signers: [w.creator, mint] },
  );
  return { mint, account: w.chain.get(mint) };
}

test('a plain mint reads as who can mint it and whether it can be frozen, and nothing else', { skip }, () => {
  const w = world({ seed: 'mint-powers-plain' });
  const mint = w.newMint(w.creator);
  assert.deepEqual(powersOf(w.chain.get(mint)), { mintAuthority: 'someone else' });
  assert.deepEqual(powersOf(w.chain.get(mint), { project: w.creator }), { mintAuthority: 'project' });
  w.chain.send(w.creator, [setAuthorityIx({ account: mint, current: w.creator, newAuthority: null })]);
  assert.deepEqual(powersOf(w.chain.get(mint)), { mintAuthority: 'none' });

  const plain2022 = mintWith(w, [], { freeze: true });
  assert.equal(plain2022.account.owner, TOKEN_2022_PROGRAM);
  assert.deepEqual(powersOf(plain2022.account), { mintAuthority: 'someone else', freeze: true });

  assert.equal(powersOf({ owner: TOKEN_PROGRAM, data: new Uint8Array(165) }), null, 'a token account is no mint');
  assert.equal(powersOf({ owner: w.creator, data: new Uint8Array(82) }), null, 'nor is another program’s account');
});

test('each Token-2022 power is read from a mint Token-2022 made with it', { skip }, () => {
  const w = world({ seed: 'mint-powers-2022' });
  const read = (extensions, options) => {
    const { mintAuthority, ...powers } = powersOf(mintWith(w, extensions, options).account);
    assert.equal(mintAuthority, 'someone else');
    return powers;
  };
  assert.deepEqual(read([['transferFee', { points: 250 }]]), { transferFeePercent: 2.5, feeChangeable: true });
  assert.deepEqual(read([['transferFee', { points: 100, changeable: false }]]), { transferFeePercent: 1 });
  // a fee of 0 whose authority can still raise it: no fee today, and one tomorrow
  assert.deepEqual(read([['transferFee', { points: 0 }]]), { feeChangeable: true });
  assert.deepEqual(read([['closeAuthority']]), { closeAuthority: true });
  assert.deepEqual(read([['confidential']]), { confidentialTransfers: true });
  assert.deepEqual(read([['defaultState', { state: 2 }]], { freeze: true }), {
    freeze: true,
    defaultState: true,
    defaultFrozen: true,
  });
  assert.deepEqual(read([['defaultState', { state: 1 }]], { freeze: true }), { freeze: true, defaultState: true });
  assert.deepEqual(read([['nonTransferable']]), { nonTransferable: true });
  assert.deepEqual(read([['permanentDelegate']]), { permanentDelegate: true });
  // a hook with no program yet, whose authority can name one
  assert.deepEqual(read([['hook']]), { transferHook: true });
  assert.deepEqual(read([['hook', { program: TOKEN_PROGRAM }]]), { transferHook: true });
  assert.deepEqual(read([['pausable']]), { pausable: true });
  // several at once, in the order Token-2022 lays them out
  assert.deepEqual(
    read([['transferFee', { points: 50 }], ['closeAuthority'], ['permanentDelegate']], { freeze: true }),
    {
      freeze: true,
      permanentDelegate: true,
      transferFeePercent: 0.5,
      feeChangeable: true,
      closeAuthority: true,
    },
  );
});

/** The chain a tool reads, answered by this world: what `rpcClient` gives a tool (`accounts`). */
const rpcOf = w => () => ({ accounts: async list => list.map(a => w.chain.get(a) ?? null) });

test('xsolana_token reads a mint into its ready tokens entry, which the checker takes as it is', { skip }, async () => {
  const w = world({ seed: 'mint-powers-tool' });
  const ctx = { rpc: rpcOf(w) };
  // a coin with a name record, nobody left to mint it: what a launchpad leaves
  const coin = w.newMint(w.creator);
  w.chain.send(w.creator, [
    createFungibleMetadataIx({ mint: coin, authority: w.creator, name: 'Tile', symbol: 'TILE' }),
    setAuthorityIx({ account: coin, current: w.creator, newAuthority: null }),
  ]);
  const plain = await runTool('xsolana_token', { mint: coin }, ctx);
  assert.deepEqual(plain.token, {
    key: 'tile',
    source: 'existing',
    name: 'Tile',
    symbol: 'TILE',
    decimals: 6,
    program: 'spl-token',
    mint: coin,
    powers: { mintAuthority: 'none' },
  });
  assert.match(
    plain.text,
    /TILE \(“Tile”\) at .* a classic SPL token, 6 decimals, 0 in existence, and nobody can mint more/,
  );
  assert.match(plain.text, /no key that can freeze it/);
  // the entry goes into a spec as it is: no refusal, and no warning that the mint could not be read
  const spec = token => ({
    version: 2,
    network: 'devnet',
    name: 'T',
    currency: token.key,
    tokens: [token],
    collection: false,
  });
  const verdict = check(spec(plain.token), { now: 1_790_000_000 });
  assert.ok(verdict.ok, JSON.stringify(verdict.refusals));
  assert.ok(!verdict.warnings.some(x => x.code === 'W-MINT-POWERS'), 'a plain token warns of nothing');

  // a Token-2022 coin with a fee its issuer can raise and a freeze authority, with no name record
  const taxed = mintWith(w, [['transferFee', { points: 300 }]], { freeze: true });
  const read = await runTool('xsolana_token', { mint: taxed.mint, key: 'tax' }, ctx);
  assert.deepEqual(read.token, {
    key: 'tax',
    source: 'existing',
    decimals: 6,
    program: 'token-2022',
    mint: taxed.mint,
    powers: { mintAuthority: 'someone else', freeze: true, transferFeePercent: 3, feeChangeable: true },
  });
  assert.match(read.text, /a Token-2022 token/);
  assert.match(read.text, /mint more of it/);
  assert.match(read.text, /keep 3% of every transfer/);
  assert.match(read.text, /raise its transfer fee/);
  const warned = check(spec(read.token), { now: 1_790_000_000 });
  assert.ok(warned.ok, JSON.stringify(warned.refusals));
  assert.ok(warned.warnings.some(x => x.code === 'W-MINT-POWERS' && /freeze any account/.test(x.message)));

  // what is not a mint, in words
  const wallet = await runTool('xsolana_token', { mint: w.creator }, ctx);
  assert.equal(wallet.ok, false);
  assert.match(wallet.text, /is not a token mint on devnet/);
  const nothing = await runTool('xsolana_token', { mint: newAddress(w.random) }, ctx);
  assert.equal(nothing.ok, false);
  assert.match(nothing.text, /nothing at .* A coin launched on mainnet is not on devnet/);
  const wrong = await runTool('xsolana_token', { mint: 'not an address' }, ctx);
  assert.equal(wrong.ok, false);
  assert.match(wrong.text, /is not a Solana address/);
  assert.equal(tokenEntry(w.creator, w.chain.get(w.creator)), null);
});

test(
  'going live holds a named mint against the chain: a power the spec denies is refused, one it leaves out is said',
  { skip },
  async () => {
    const w = world({ seed: 'mint-powers-approve' });
    const chain = { account: async a => w.chain.get(a) ?? null };
    const { mint } = mintWith(w, [['transferFee', { points: 300 }]], { freeze: true });
    const m = powers =>
      model({
        version: 2,
        network: 'devnet',
        name: 'T',
        currency: 'tax',
        tokens: [
          {
            key: 'tax',
            source: 'existing',
            symbol: 'TAX',
            decimals: 6,
            program: 'token-2022',
            mint,
            ...(powers ? { powers } : {}),
          },
        ],
        collection: false,
      });
    // the spec says everything the mint can do: nothing more to say
    const all = { mintAuthority: 'someone else', freeze: true, transferFeePercent: 3, feeChangeable: true };
    assert.deepEqual((await checkMints({ m: m(all), chain })).powers, []);
    // a spec that names no powers (one written before the tools read a mint) still goes live, and the page says them
    const silent = (await checkMints({ m: m(null), chain })).powers;
    assert.equal(silent.length, 1);
    assert.equal(silent[0].key, 'tax');
    assert.match(silent[0].says, /mint more of it whenever they want; freeze any account holding it/);
    assert.match(silent[0].says, /raise its transfer fee/);
    assert.match(silent[0].says, /keep 3% of every transfer/);
    // only what is left out is said
    const some = (await checkMints({ m: m({ mintAuthority: 'someone else', freeze: true }), chain })).powers;
    assert.doesNotMatch(some[0].says, /freeze any account|mint more/);
    assert.match(some[0].says, /keep 3% of every transfer/);
    // a spec that denies what the mint has is refused, with the fix
    await assert.rejects(checkMints({ m: m({ ...all, freeze: false }), chain }), e => {
      assert.ok(e instanceof MintMismatch);
      assert.match(e.message, /no freeze authority \("freeze": false\); on chain.*xsolana token/);
      return true;
    });
    await assert.rejects(checkMints({ m: m({ ...all, mintAuthority: 'none' }), chain }), /has a mint authority/);
    await assert.rejects(checkMints({ m: m({ ...all, transferFeePercent: 1 }), chain }), /keeps 3%/);
    await assert.rejects(
      checkMints({ m: m({ ...all, feeChangeable: false }), chain }),
      /a transfer fee nobody can change/,
    );
    // a higher fee said than the mint has is no risk hidden
    assert.deepEqual((await checkMints({ m: m({ ...all, transferFeePercent: 5 }), chain })).powers, []);
  },
);
