// The tools' guards, each shown against the real program in LiteSVM: a prize's roll at its hashed nonce, a planted
// `live` section, a confirmation that timed out, a price that moved after the player saw it, a loan whose token
// someone can freeze, a mainnet RPC, MCP file paths outside the project, and a throwaway key's lamports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { clusterChain, createApproval } from '../approve/server.mjs';
import { concat, fromBase64, toBase64, uintLE, utf8 } from '../chain/bytes.js';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, meta } from '../chain/programs.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, mintToIx, setAuthorityIx } from '../chain/token.js';
import { readMessage, readTransaction, wireTransaction } from '../chain/tx.js';
import { MEMO_PROGRAM } from '../chain/token2022.js';
import * as loot from '../client/index.js';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM, parseCoreAsset, parseCoreCollection } from '../chain/core.js';
import { createFungibleMetadataIx } from '../chain/metadata.js';
import { parseMint } from '../chain/mint.js';
import { check } from '../economy/check.mjs';
import { model } from '../economy/model.mjs';
import { plan, setupContext } from '../economy/plan.mjs';
import { runTool } from '../mcp/server.mjs';
import { solanaApp } from '../play/index.js';
import { newAddress } from '../sim/chain.mjs';
import { approvalChain, boxArgs, cannotRun, collectible, itemDrop, PRICE, world } from './world.mjs';

const NOW = 1_790_000_000;
const skip = cannotRun() ?? false;
const { pda } = loot;
const NOBODY = '11111111111111111111111111111111';
/** The address the setup plan stands in for the owner's wallet before one connects (plan.mjs `placeholderContext`). */
const STAND_IN_OWNER = encodeBase58(createHash('sha256').update('loot-plan:owner').digest());
const example = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));

/** A wallet: signs its own slot of whatever it is handed. */
const asWallet = kp => ({
  address: kp.address,
  async signTransaction(wire) {
    const t = readTransaction(wire);
    const sigs = [...t.signatures];
    sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
    return wireTransaction(t.message, sigs);
  },
});
const signAll = (kp, wires) => wires.map(b64 => toBase64(asWalletSync(kp, fromBase64(b64))));
const asWalletSync = (kp, wire) => {
  const t = readTransaction(wire);
  const sigs = [...t.signatures];
  sigs[t.signers.indexOf(kp.address)] = kp.sign(t.message);
  return wireTransaction(t.message, sigs);
};
const specFile = (spec, prefix = 'xsolana-') => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), prefix)), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec, null, 2));
  return file;
};
async function runAll(session, kp) {
  for (let i = 0; i < 10 && !session.state().done; i++) {
    const batch = await session.prepare(kp.address);
    await session.complete(kp.address, batch.id, signAll(kp, batch.transactions));
  }
}
const funded = w => {
  const kp = freshKeypair();
  w.chain.airdrop(kp.address, 100_000_000_000n);
  return kp;
};
const freshWorld = seed => {
  const w = world({ project: false, seed, compressed: false });
  w.chain.warp(NOW);
  return w;
};

describe('a prize’s roll is made at prizeRollNonce of the nonce its route names', () => {
  test('prizeRollNonce is the first 8 bytes, little endian, of sha256("prize" | n), and wraps as the program adds', () => {
    for (const n of [0n, 1n, 77n, 2n ** 64n - 1n]) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(n);
      const want = createHash('sha256')
        .update(Buffer.concat([Buffer.from('prize'), le]))
        .digest()
        .readBigUInt64LE(0);
      assert.equal(loot.prizeRollNonce(n), want);
    }
    assert.equal(
      loot.prizeRollNonce(2n ** 64n),
      loot.prizeRollNonce(0n),
      'a place added past u64 wraps, as wrapping_add does',
    );
    const project = freshKeypair().address;
    const lines = loot.prizeMetas({ project, prize: { Roll: [5] }, winner: NOBODY, nonce: 9n });
    assert.equal(lines[1].pubkey, pda.order(project, NOBODY, loot.prizeRollNonce(9n)));
  });

  test('a claim is signed by its own wallet; its claim at its NFT’s nonce rolls elsewhere', { skip }, () => {
    const w = world({ seed: 'hardening-prize-nonce' });
    w.upsert({ Item: { id: 1, args: collectible('Gem') } });
    w.upsert({ Box: { id: 5, args: boxArgs(0n, [itemDrop(1)], { active: false }) } });
    const limits = {
      wallet: { total: 1, per_window: 0, window: 0 },
      per_person: 0,
      per_key: 0,
      all: { total: 0, per_window: 0, window: 0 },
      window: { opens_at: 0n, closes_at: 0n },
    };
    w.upsert({
      Grant: {
        id: 1,
        args: {
          gives: { Roll: [5] },
          vouchers: [NOBODY, NOBODY, NOBODY],
          list_root: new Uint8Array(32),
          limits,
          active: true,
          gate: null,
          open: true,
        },
      },
    });
    const victimNft = w.make(1, w.player);
    const nonce = loot.nonceOn(victimNft);
    const rolls = w.rolls([5]);
    // Every claim needs its wallet's own signature (WalletMustSign): a stranger may pay its fees, never claim for it.
    const forThem = loot.claimGrantIx({
      project: w.project,
      id: 1,
      grant: w.read('Grant', pda.grant(w.project, 1)),
      wallet: w.player,
      signer: w.cranker,
      projectState: w.projectState(),
      rolls,
      nonce,
    });
    assert.ok(
      forThem.keys.some(k => k.pubkey === w.player && k.isSigner),
      'the player signs it',
    );
    // Named by the player itself, the nonce of its NFT still lands the roll elsewhere.
    w.chain.send(w.player, [
      loot.claimGrantIx({
        project: w.project,
        id: 1,
        grant: w.read('Grant', pda.grant(w.project, 1)),
        wallet: w.player,
        signer: w.player,
        projectState: w.projectState(),
        rolls,
        nonce,
      }),
    ]);
    assert.equal(w.chain.get(pda.order(w.project, w.player, nonce)), null, 'the NFT’s own order address is still free');
    assert.equal(w.read('Order', pda.order(w.project, w.player, loot.prizeRollNonce(nonce))).status, 'Waiting');
  });
});

describe('xsolana approve holds the file’s live section against the chain', () => {
  test(
    'a planted live section naming someone else’s project is refused: no seed is paid into their pool',
    { skip },
    async () => {
      const w = freshWorld('hardening-forged');
      const attacker = funded(w);
      const theirs = structuredClone(example);
      const aFile = specFile(theirs);
      await runAll(await createApproval({ file: aFile, chain: approvalChain(w), now: () => NOW }), attacker);
      const attackerLive = JSON.parse(readFileSync(aFile, 'utf8')).live;
      const house = example.pools.findIndex(p => p.key === 'house');
      const pool = pda.pool(attackerLive.project, house);
      const before = w.chain.tokens(pool);

      const victim = funded(w);
      const landed = plan(example, { now: NOW })
        .steps.map(s => s.id)
        .filter(id => !id.startsWith('seed:'));
      const forged = {
        ...example,
        live: {
          partial: true,
          project: attackerLive.project,
          treasury: attackerLive.treasury,
          authority: attackerLive.authority,
          collection: attackerLive.collection,
          mints: attackerLive.mints,
          landed,
        },
      };
      // xsolana_save does not keep a live section the file never had.
      const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-019-save-'));
      const saved = await runTool('xsolana_save', { spec: forged }, { cwd: dir, now: NOW });
      assert.equal(saved.ok, true, saved.text);
      assert.match(saved.text, /live section given was not kept/);
      assert.equal(JSON.parse(readFileSync(path.join(dir, 'xsolana.json'), 'utf8')).live, undefined);

      // Written to the file by hand, the page refuses it once the victim connects.
      const vFile = specFile(forged);
      const session = await createApproval({ file: vFile, chain: approvalChain(w), now: () => NOW });
      const shown = await session.stateFor(victim.address);
      assert.match(
        shown.refused,
        new RegExp(`belongs to ${attacker.address}, not to ${victim.address}, the address signing now`),
      );
      assert.match(
        shown.refused,
        /If it is not yours \(the file came from someone else with their live section in it\)/,
      );
      await assert.rejects(session.prepare(victim.address), /belongs to .*, not to .*, the address signing now/);
      assert.equal(w.chain.tokens(pool), before, 'the attacker’s pool got nothing');
    },
  );

  test(
    'a planted treasury before the project landed is ignored: the project’s treasury is the spec’s, the owner’s wallet',
    { skip },
    async () => {
      const w = freshWorld('hardening-treasury');
      const owner = funded(w);
      const attacker = freshKeypair().address;
      const spec = { ...structuredClone(example), live: { partial: true, landed: [], treasury: attacker } };
      delete spec.treasury;
      const session = await createApproval({ file: specFile(spec), chain: approvalChain(w), now: () => NOW });
      const shown = await session.stateFor(owner.address);
      assert.equal(
        shown.project,
        pda.project(owner.address, example.projectNumber ?? 0),
        'the page names the wallet’s own project',
      );
      assert.ok(!JSON.stringify(shown).includes(attacker), 'the planted treasury is nowhere');
      const lines = shown.steps.find(s => s.id === 'project').details;
      assert.ok(lines.includes(`Treasury: your wallet (${owner.address})`), lines.join('\n'));
      const batch = await session.prepare(owner.address);
      assert.equal(batch.project, shown.project);
      assert.ok(batch.details[0][0].startsWith(`Project: ${shown.project} (your own)`));
      await runAll(session, owner);
      const project = w.read('Project', pda.project(owner.address, example.projectNumber ?? 0));
      assert.equal(project.treasury, owner.address);
    },
  );

  test('a setup is built in a project another key made only on what the chain said of it', () => {
    const m = model(example, { now: NOW });
    const [maker, owner, signer, planted] = [1, 2, 3, 4].map(() => freshKeypair().address);
    const live = { project: pda.project(maker, example.projectNumber ?? 0), treasury: planted, authority: planted };
    // With nothing read from the chain, a project that is not at the owner's own address is refused, as before.
    assert.throws(
      () => setupContext(m, { owner, keys: {}, live }),
      new RegExp(`names the project ${live.project}, which is not the project .* of the wallet ${owner}`),
    );
    // On what the approval read from the chain, it is the project at its maker's address, with the chain's treasury
    // and authority: the file's lines of them are not built on.
    const ctx = setupContext(m, {
      owner,
      keys: {},
      live,
      onChain: { creator: maker, treasury: owner, authority: signer },
    });
    assert.deepEqual([ctx.project, ctx.owner, ctx.treasury, ctx.authority], [live.project, owner, owner, signer]);
    // A maker whose number does not make the address is refused too.
    assert.throws(
      () => setupContext(m, { owner, keys: {}, live, onChain: { creator: signer, treasury: owner, authority: owner } }),
      new RegExp(`which is not the project .* of the wallet ${owner} \\(made by ${signer}\\)`),
    );
    // The authority is never the file's: with no chain read it is the spec's (here the owner's wallet). And a live
    // section that names a treasury or an authority with no project names nothing.
    const own = { project: pda.project(owner, example.projectNumber ?? 0), treasury: owner, authority: planted };
    assert.equal(setupContext(m, { owner, keys: {}, live: own }).authority, owner);
    for (const section of [
      { treasury: planted, authority: planted },
      { partial: true, landed: [], treasury: planted, authority: planted },
    ]) {
      const fresh = setupContext(m, { owner, keys: {}, live: section });
      assert.deepEqual([fresh.treasury, fresh.authority], [owner, owner]);
    }
  });

  test(
    'a planted authority or treasury in a file with no project is ignored: a new project’s keys are the spec’s',
    { skip },
    async () => {
      // (the authority alone moves a pool's tokens, so a planted one would be handed the owner's seeds)
      for (const [n, section] of [
        ['a', { authority: 'planted' }],
        ['b', { treasury: 'planted' }],
        ['c', { authority: 'planted', treasury: 'planted' }],
        ['d', { partial: true, landed: [], authority: 'planted', treasury: 'planted' }],
      ]) {
        const w = freshWorld(`hardening-planted-${n}`);
        const owner = funded(w);
        const attacker = freshKeypair().address;
        const live = Object.fromEntries(Object.entries(section).map(([k, v]) => [k, v === 'planted' ? attacker : v]));
        const spec = { ...structuredClone(example), live };
        delete spec.treasury;
        const file = specFile(spec);
        const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
        const shown = await session.stateFor(owner.address);
        assert.equal(shown.refused, undefined, JSON.stringify(section));
        assert.ok(!JSON.stringify(shown).includes(attacker), `the planted key is nowhere (${JSON.stringify(section)})`);
        const batch = await session.prepare(owner.address);
        assert.ok(!JSON.stringify(batch.details).includes(attacker));
        await runAll(session, owner);
        const project = w.read('Project', pda.project(owner.address, example.projectNumber ?? 0));
        assert.deepEqual(
          [project.owner, project.authority, project.treasury],
          [owner.address, owner.address, owner.address],
        );
        const saved = JSON.parse(readFileSync(file, 'utf8')).live;
        assert.deepEqual([saved.authority, saved.treasury], [owner.address, owner.address]);
      }
    },
  );

  /**
   * A Core collection a stranger pays for and signs, which names `updateAuthority` its update authority (who signs
   * nothing) and keeps the stranger a power over it for good (an update delegate, and its royalty).
   */
  const plantedCollectionIx = ({ collection, payer, updateAuthority }) => {
    const text = t => concat(uintLE(utf8(t).length, 4), utf8(t));
    return {
      programId: MPL_CORE_PROGRAM,
      keys: [
        meta(collection, true, true),
        meta(updateAuthority, false, false),
        meta(payer, true, true),
        meta(SYSTEM_PROGRAM, false, false),
      ],
      data: concat(
        Uint8Array.of(21),
        text('Planted'),
        text(''),
        Uint8Array.of(1),
        uintLE(2, 4),
        // (a royalty to the stranger, then an update delegate that names the stranger)
        Uint8Array.of(0),
        uintLE(500, 2),
        uintLE(1, 4),
        addressBytes(payer),
        Uint8Array.of(100, 0, 0),
        Uint8Array.of(4),
        uintLE(1, 4),
        addressBytes(payer),
        Uint8Array.of(0),
        Uint8Array.of(0),
      ),
    };
  };

  test(
    'a collection the file names before its project is made is not built on: the setup makes its own',
    { skip },
    async () => {
      for (const [n, live] of [
        ['whole', x => ({ collection: x })],
        ['partial', x => ({ partial: true, landed: ['collection'], collection: x })],
        ['landed', () => ({ partial: true, landed: ['collection'] })],
      ]) {
        const w = freshWorld(`hardening-planted-collection-${n}`);
        const owner = funded(w);
        const stranger = funded(w);
        // Anyone can make a collection that names the owner its update authority, and keep a power of their own.
        const planted = freshKeypair().address;
        w.chain.send(stranger.address, [
          plantedCollectionIx({ collection: planted, payer: stranger.address, updateAuthority: owner.address }),
        ]);
        assert.equal(parseCoreCollection(w.chain.get(planted).data).updateAuthority, owner.address);
        const file = specFile({ ...structuredClone(example), live: live(planted) });
        const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
        const shown = await session.stateFor(owner.address);
        assert.equal(shown.refused, undefined, n);
        assert.ok(
          shown.steps.some(s => s.id === 'collection'),
          `the setup makes its own collection (${n})`,
        );
        assert.ok(!JSON.stringify(shown.steps).includes(planted), `no step names the planted one (${n})`);
        await runAll(session, owner);
        const project = w.read('Project', pda.project(owner.address, example.projectNumber ?? 0));
        const saved = JSON.parse(readFileSync(file, 'utf8')).live;
        assert.deepEqual(project.collections, [saved.collection], `the project lists the one the setup made (${n})`);
        assert.notEqual(saved.collection, planted);
      }
    },
  );

  /** A mint a stranger makes for a token of the owner's spec: the stranger's `supply` out, then `authority` its minter. */
  const plantMint = (
    w,
    stranger,
    { decimals, supply = 0n, authority, tokenProgram = TOKEN_PROGRAM, record = null },
  ) => {
    const mint = freshKeypair().address;
    w.chain.send(stranger.address, [
      createAccountIx({
        from: stranger.address,
        address: mint,
        lamports: w.chain.rent(MINT_BYTES),
        space: MINT_BYTES,
        owner: tokenProgram,
      }),
      initializeMint2Ix({ mint, decimals, authority: stranger.address, tokenProgram }),
      ...(record
        ? [createFungibleMetadataIx({ mint, authority: stranger.address, name: 'Arena', symbol: 'ARENA' })]
        : []),
      ...(supply
        ? [
            createAssociatedTokenAccountIdempotent(stranger.address, stranger.address, mint, tokenProgram),
            mintToIx({
              mint,
              to: loot.ata(stranger.address, mint, tokenProgram),
              authority: stranger.address,
              amount: supply,
              tokenProgram,
            }),
          ]
        : []),
      setAuthorityIx({ account: mint, current: stranger.address, newAuthority: authority, tokenProgram }),
    ]);
    return mint;
  };

  test(
    'a mint the file names before its project is made is as a setup leaves it, or it is refused',
    { skip },
    async () => {
      const refusal = async ({ seed, spec = example, token = 'arena', plant, live }) => {
        const w = freshWorld(seed);
        const owner = funded(w);
        const stranger = funded(w);
        const project = pda.project(owner.address, spec.projectNumber ?? 0);
        const mint = plantMint(w, stranger, plant({ project, owner }));
        const file = specFile({ ...structuredClone(spec), live: live(token, mint) });
        const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
        const shown = await session.stateFor(owner.address);
        await assert.rejects(session.prepare(owner.address));
        assert.equal(w.chain.get(project), null, 'no project was made');
        return { text: shown.refused ?? '', mint };
      };
      const whole = (token, mint) => ({ mints: { [token]: mint } });
      const partial = (token, mint) => ({ partial: true, landed: [`token:${token}`], mints: { [token]: mint } });
      // A supply of the stranger's own already out, and the project-to-be named its minter: in both shapes of file.
      for (const [n, live] of [
        ['whole', whole],
        ['partial', partial],
      ]) {
        const { text, mint } = await refusal({
          seed: `hardening-planted-mint-${n}`,
          plant: ({ project }) => ({ decimals: 6, supply: 1_000_000_000_000n, authority: project, record: true }),
          live,
        });
        assert.ok(
          text.includes(
            `The mint ${mint} the file names for ARENA has 1000000 ARENA made already, and its project is not made yet: a mint this setup made has none until the project mints some.`,
          ),
          text,
        );
      }
      // None out, but a Token-2022 mint (which can carry powers over every holder).
      assert.match(
        (
          await refusal({
            seed: 'hardening-planted-mint-2022',
            plant: ({ project }) => ({ decimals: 6, authority: project, tokenProgram: TOKEN_2022_PROGRAM }),
            live: partial,
          })
        ).text,
        /is a Token-2022 mint; a setup makes its tokens with the Token program/,
      );
      // None out, a classic mint, and no name record, or one that is the stranger's to change.
      assert.match(
        (
          await refusal({
            seed: 'hardening-planted-mint-unnamed',
            plant: ({ project }) => ({ decimals: 6, authority: project }),
            live: partial,
          })
        ).text,
        /has no name record on chain: a setup writes one in the step that makes the mint/,
      );
      assert.match(
        (
          await refusal({
            seed: 'hardening-planted-mint-named',
            plant: ({ project }) => ({ decimals: 6, authority: project, record: true }),
            live: partial,
          })
        ).text,
        /The name record of the mint .* is .*’s to change, not this wallet’s/,
      );
      // A fixed supply, its minting off for good, all of it the stranger's.
      const coin = JSON.parse(readFileSync(new URL('../../examples/community-coin.json', import.meta.url), 'utf8'));
      const fixed = coin.tokens.find(t => t.supply !== undefined);
      assert.match(
        (
          await refusal({
            seed: 'hardening-planted-mint-fixed',
            spec: coin,
            token: fixed.key,
            plant: () => ({ decimals: fixed.decimals, supply: 5_000_000n, authority: null, record: true }),
            live: partial,
          })
        ).text,
        /of which this wallet holds 0 [A-Z]+, and its project is not made yet: a setup gives a fixed supply whole to its owner/,
      );
    },
  );

  test(
    'a setup cut short before its project goes on: its own mints are kept, and its collection is made again',
    { skip },
    async () => {
      // (an example whose tokens and collection land in a transaction before the project's)
      const spec = JSON.parse(readFileSync(new URL('../../examples/star-fleet.json', import.meta.url), 'utf8'));
      const w = freshWorld('hardening-cut-before-project');
      const owner = funded(w);
      const file = specFile(spec);
      let sends = 0;
      let cut = true;
      const chain = approvalChain(w, {
        send: async wire => {
          if (cut && ++sends === 2) throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
          return w.chain.sendWire(wire);
        },
      });
      const first = await createApproval({ file, chain, now: () => NOW });
      const batch = await first.prepare(owner.address);
      await assert.rejects(first.complete(owner.address, batch.id, signAll(owner, batch.transactions)));
      first.close();
      const stopped = JSON.parse(readFileSync(file, 'utf8')).live;
      assert.equal(stopped.partial, true);
      assert.equal(stopped.project, undefined, 'the project’s step had not landed');
      assert.ok(stopped.landed.includes('collection') && stopped.collection);
      const tokens = Object.keys(stopped.mints);
      assert.ok(tokens.length > 0 && tokens.every(key => stopped.landed.includes(`token:${key}`)));

      // Another run: the mints the first made are as a setup leaves them (none minted, their name the owner's), so
      // they are gone on with; the collection is made anew, since nothing on chain yet says the first is the project's.
      cut = false;
      const second = await createApproval({ file, chain, now: () => NOW });
      const shown = await second.stateFor(owner.address);
      assert.equal(shown.refused, undefined);
      assert.ok(shown.steps.some(s => s.id === 'collection'));
      assert.ok(!shown.steps.some(s => s.id.startsWith('token:')), 'no token is made twice');
      await runAll(second, owner);
      const done = JSON.parse(readFileSync(file, 'utf8')).live;
      assert.equal(done.partial, undefined);
      assert.deepEqual(done.mints, stopped.mints);
      assert.notEqual(done.collection, stopped.collection);
      assert.deepEqual(w.read('Project', done.project).collections, [done.collection]);
      for (const key of tokens)
        assert.equal(
          parseMint(done.mints[key], TOKEN_PROGRAM, w.chain.get(done.mints[key]).data).mintAuthority,
          done.project,
        );

      // The session that made the collection goes on with it itself: its address is of a key that session made.
      const w2 = freshWorld('hardening-cut-same-session');
      const owner2 = funded(w2);
      const file2 = specFile(spec);
      let sent = 0;
      let stop = true;
      const session = await createApproval({
        file: file2,
        chain: approvalChain(w2, {
          send: async wire => {
            if (stop && ++sent === 2) throw Object.assign(new Error('RPC: blockhash not found'), { code: -32002 });
            return w2.chain.sendWire(wire);
          },
        }),
        now: () => NOW,
      });
      const b2 = await session.prepare(owner2.address);
      await assert.rejects(session.complete(owner2.address, b2.id, signAll(owner2, b2.transactions)));
      const made = JSON.parse(readFileSync(file2, 'utf8')).live.collection;
      assert.ok(made);
      stop = false;
      await runAll(session, owner2);
      const live2 = JSON.parse(readFileSync(file2, 'utf8')).live;
      assert.equal(live2.collection, made, 'the same collection');
      assert.deepEqual(w2.read('Project', live2.project).collections, [made]);
    },
  );

  test('a Token-2022 mint named for a live project’s token is refused', { skip }, async () => {
    const w = freshWorld('hardening-swap-2022');
    const owner = funded(w);
    const stranger = funded(w);
    const file = specFile(example);
    await runAll(await createApproval({ file, chain: approvalChain(w), now: () => NOW }), owner);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const swapped = plantMint(w, stranger, {
      decimals: 6,
      authority: saved.live.project,
      tokenProgram: TOKEN_2022_PROGRAM,
    });
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...saved,
          pools: [...saved.pools, { key: 'vault', currency: 'arena' }],
          live: { ...saved.live, mints: { ...saved.live.mints, arena: swapped } },
        },
        null,
        2,
      ),
    );
    await assert.rejects(
      (await createApproval({ file, chain: approvalChain(w), now: () => NOW })).prepare(owner.address),
      new RegExp(`The mint ${swapped} the file names for ARENA is a Token-2022 mint`),
    );
  });

  test('a landed step’s name as long as a stash step of several NFTs makes it is taken by the checker', () => {
    const nfts = Array.from({ length: 6 }, () => freshKeypair().address);
    const id = `stash:${'a-stash-key-as-long-as-a-key-gets'}:${nfts.join(',')}`;
    assert.ok(id.length > 300);
    const verdict = check({
      ...structuredClone(example),
      live: {
        partial: true,
        landed: [id],
        changing: [id],
        pending: [{ signature: '1'.repeat(88), steps: [id] }],
      },
    });
    assert.deepEqual(
      verdict.refusals.filter(r => r.code === 'E-SCHEMA'),
      [],
    );
  });

  test(
    'a live economy whose file names a collection the project does not list is refused, the owner’s own too',
    { skip },
    async () => {
      const w = freshWorld('hardening-collection');
      const owner = funded(w);
      const file = specFile(example);
      await runAll(await createApproval({ file, chain: approvalChain(w), now: () => NOW }), owner);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const project = w.read('Project', saved.live.project);
      assert.deepEqual(project.collections, [saved.live.collection], 'the project lists the collection its setup made');
      // Another collection whose update authority is the owner (anyone can make one that says so): its update
      // authority says nothing of whose it is, and a rule that names "the project's collection" would read it.
      const other = freshKeypair().address;
      w.chain.send(owner.address, [
        createCollectionInstruction({
          collection: other,
          creator: owner.address,
          project: saved.live.project,
          name: 'Another',
          uri: '',
        }),
      ]);
      writeFileSync(
        file,
        JSON.stringify(
          { ...saved, boxes: [{ ...saved.boxes[0], price: 0.2 }], live: { ...saved.live, collection: other } },
          null,
          2,
        ),
      );
      await assert.rejects(
        (await createApproval({ file, chain: approvalChain(w), now: () => NOW })).prepare(owner.address),
        new RegExp(
          `The collection ${other} the file names is not one of the collections of the project ${saved.live.project}`,
        ),
      );
    },
  );

  test(
    'a live economy whose file names another treasury than the chain’s is built on the chain’s',
    { skip },
    async () => {
      const w = freshWorld('hardening-change');
      const owner = funded(w);
      const file = specFile(example);
      await runAll(await createApproval({ file, chain: approvalChain(w), now: () => NOW }), owner);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const attacker = freshKeypair().address;
      writeFileSync(
        file,
        JSON.stringify(
          { ...saved, boxes: [{ ...saved.boxes[0], price: 0.2 }], live: { ...saved.live, treasury: attacker } },
          null,
          2,
        ),
      );
      // The treasury is the chain's to say (its owner can change it there, or hand the project on, and no file is
      // written): the file's line is not built on, the owner is told, and the file says the chain's once the change lands.
      const session = await createApproval({ file, chain: approvalChain(w), now: () => NOW });
      const shown = await session.stateFor(owner.address);
      assert.equal(shown.refused, undefined);
      assert.ok(
        shown.warnings.includes(
          `On chain the project’s treasury is ${owner.address} (the file said ${attacker}). Nothing is built on the file’s line, and the file is corrected when a step lands.`,
        ),
        shown.warnings.join('\n'),
      );
      assert.ok(!JSON.stringify(shown.steps).includes(attacker), 'no step names the planted treasury');
      const batch = await session.prepare(owner.address);
      assert.ok(!JSON.stringify(batch.details).includes(attacker), 'nothing to sign names it');
      for (const wire of batch.transactions)
        assert.ok(
          !readMessage(readTransaction(fromBase64(wire)).message).keys.includes(attacker),
          'no transaction names it as an account',
        );
      await runAll(session, owner);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).live.treasury, owner.address, 'the file says the chain’s');
      assert.equal(w.read('Project', saved.live.project).treasury, owner.address);
      // A mint that is not the one the setup made (its minting not the project's) is refused.
      const other = w.newMint(owner.address);
      writeFileSync(
        file,
        JSON.stringify(
          {
            ...saved,
            boxes: [{ ...saved.boxes[0], price: 0.2 }],
            live: { ...saved.live, mints: { ...saved.live.mints, arena: other } },
          },
          null,
          2,
        ),
      );
      await assert.rejects(
        (await createApproval({ file, chain: approvalChain(w), now: () => NOW })).prepare(owner.address),
        /is minted by/,
      );
    },
  );

  test(
    'no spec may name the address the plan stands in for the wallet, and only the connected wallet is “your wallet”',
    { skip },
    async () => {
      const spec = { ...structuredClone(example), treasury: `wallet:${STAND_IN_OWNER}` };
      const verdict = check(spec, { now: NOW });
      assert.ok(
        verdict.refusals.some(r => r.code === 'E-STAND-IN'),
        JSON.stringify(verdict.refusals),
      );
      const w = freshWorld('hardening-label');
      const owner = funded(w);
      const someone = freshKeypair().address;
      const session = await createApproval({
        file: specFile({ ...structuredClone(example), treasury: `wallet:${someone}` }),
        chain: approvalChain(w),
        now: () => NOW,
      });
      const lines = (await session.stateFor(owner.address)).steps.find(s => s.id === 'project').details;
      assert.ok(lines.includes(`Treasury: ${someone}`), lines.join('\n'));
      assert.ok(!lines.some(l => l.includes('your wallet') && !l.includes(owner.address)), lines.join('\n'));
    },
  );
});

describe('a setup transaction that lands after its confirmation failed is recorded, never sent twice', () => {
  for (const when of ['Open the project', 'Put 5'])
    test(`the step “${when}…”`, { skip }, async () => {
      const w = freshWorld(`hardening-lost-${when.length}`);
      const owner = funded(w);
      const file = specFile(example);
      let says = [];
      let k = 0;
      let current = '';
      let failed = false;
      const chain = approvalChain(w, {
        send: async wire => {
          current = says[k++];
          return w.chain.sendWire(wire);
        },
        // The transaction ran; the status poll then fails once, as an RPC hiccup does.
        confirm: async () => {
          if (!failed && current.includes(when)) {
            failed = true;
            throw new Error('RPC getSignatureStatuses did not answer: fetch failed');
          }
        },
      });
      const session = await createApproval({ file, chain, now: () => NOW });
      for (let i = 0; i < 8 && !session.state().done; i++) {
        const batch = await session.prepare(owner.address);
        says = batch.says;
        k = 0;
        await session.complete(owner.address, batch.id, signAll(owner, batch.transactions)).catch(() => null);
      }
      assert.ok(failed, 'a confirmation failed');
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(session.state().done && !saved.live.partial && !saved.live.pending, JSON.stringify(saved.live));
      assert.equal(w.read('Project', saved.live.project).owner, owner.address);
      const house = saved.pools.find(p => p.key === 'house');
      assert.equal(w.chain.tokens(pda.pool(saved.live.project, house.index)), 5_000_000_000n, 'the seed was paid once');
    });

  test('one that may still land stops the next batch until the chain says, then is recorded', { skip }, async () => {
    const w = freshWorld('hardening-wait');
    const owner = funded(w);
    const file = specFile(example);
    let seen = false;
    const chain = approvalChain(w, {
      confirm: async () => {
        throw new Error('Transaction was not confirmed in time; check it in the explorer.');
      },
    });
    const real = chain.signatureStatus;
    chain.signatureStatus = async sig => (seen ? real(sig) : null);
    const session = await createApproval({ file, chain, now: () => NOW });
    const batch = await session.prepare(owner.address);
    await assert.rejects(
      session.complete(owner.address, batch.id, signAll(owner, batch.transactions)),
      /may still land/,
    );
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).live.pending.length, 1);
    // A new session after a restart: nothing is sent while it is unknown.
    const again = await createApproval({ file, chain, now: () => NOW });
    await assert.rejects(again.prepare(owner.address), /has not landed yet/);
    seen = true;
    const next = await again.prepare(owner.address);
    const live = JSON.parse(readFileSync(file, 'utf8')).live;
    assert.ok(live.landed.length > 0 && !live.pending, 'recorded as landed');
    assert.ok(!next.says.join(' ').includes(batch.says[0]), 'and not sent again');
  });
});

/** An economy with a 0.01 SOL badge, live through the approval session; a player's app on it. */
async function shop(seed) {
  const w = freshWorld(seed);
  const owner = funded(w);
  const player = funded(w);
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Shop',
    currency: 'sol',
    tokens: [{ key: 'sol', source: 'sol' }],
    collection: { name: 'Shop' },
    items: [
      { key: 'badge', name: 'Badge', price: 0.01, supply: 10 },
      { key: 'gem', name: 'Gem' },
    ],
    boxes: [
      {
        key: 'chest',
        name: 'Chest',
        price: 0.02,
        outcomes: [
          { gives: 'item', item: 'gem', chance: 50 },
          { gives: 'item', item: 'badge', chance: 50 },
        ],
      },
    ],
  };
  const file = specFile(spec);
  await runAll(await createApproval({ file, chain: approvalChain(w), now: () => NOW }), owner);
  const live = JSON.parse(readFileSync(file, 'utf8'));
  return {
    w,
    owner,
    player,
    live,
    app: solanaApp({ spec: live, rpc: w.chain.rpc, wallet: asWallet(player), now: () => w.chain.now() }),
  };
}

describe('the price a player was shown is the most they pay', () => {
  test('buy and openBox need what the player saw, and refuse a price that rose since', { skip }, async () => {
    const { w, owner, player, live, app } = await shop('hardening-price');
    await assert.rejects(app.buy('badge'), /Say the most the player agreed to pay/);
    await assert.rejects(app.openBox('chest'), /Say the most the player agreed to pay/);
    const listing = (await app.shop()).find(l => l.key === 'badge');
    // The owner raises the price after the player saw it.
    const project = live.live.project;
    const boxId = live.items[0].shopBox;
    const b = w.read('LootBox', pda.box(project, boxId));
    const args = {
      price: 5_000_000_000n,
      currency: b.currency,
      rise: b.rise,
      fall: b.fall,
      stock_odds: b.stock_odds,
      active: b.active,
      shares: b.shares,
      entries: b.entries,
      gate: b.gate,
      odds: b.odds,
      window: b.window,
      per_wallet: b.per_wallet,
      subject: b.subject,
      fates: b.fates,
    };
    w.chain.send(owner.address, [loot.upsertIx({ owner: owner.address, project, def: { Box: { id: boxId, args } } })]);
    const had = await w.chain.rpc.balance(player.address);
    await assert.rejects(app.buy('badge', { listing }), /is now 5, more than the 0\.01 the player was shown/);
    await assert.rejects(app.buy('badge', { maxPrice: listing.priceUnits }), /more than/);
    assert.equal(await w.chain.rpc.balance(player.address), had, 'nothing was paid');
    const now = (await app.shop()).find(l => l.key === 'badge');
    assert.ok((await app.buy('badge', { listing: now })).asset, 'the new price, once shown, sells');
  });

  test('craft needs the recipe version the player was shown', { skip }, async () => {
    const w = world({ seed: 'hardening-craft-2' });
    w.upsert({ Item: { id: 1, args: collectible('Gem') } });
    w.upsert({
      Recipe: {
        id: 1,
        args: {
          active: true,
          inputs: [{ Burn: { item: 1, count: 1 } }],
          outputs: [],
          needs: [],
          keeps: [],
          raises: [],
        },
      },
    });
    const kp = funded(w);
    const spec = {
      version: 2,
      tokens: [],
      recipes: [{ key: 'melt', name: 'Melt', id: 1 }],
      live: { project: w.project, collection: w.collection },
    };
    const player = solanaApp({ spec, rpc: w.chain.rpc, wallet: asWallet(kp), now: () => w.chain.now() });
    const gem = w.make(1, kp.address);
    await assert.rejects(player.craft('melt', [gem]), /Say which version of “Melt” the player was shown/);
    const [listing] = await player.recipes();
    assert.equal(listing.key, 'melt');
    await player.craft('melt', [gem], 1, { listing });
    assert.ok((w.chain.get(gem)?.data.length ?? 0) <= 1, 'burned');
    // A craft carries the tail a Core collection's plugins need (`extra`), after the Memo program's account.
    const sent = [];
    const rpc = { ...w.chain.rpc, send: wire => (sent.push(readTransaction(wire)), w.chain.rpc.send(wire)) };
    const tailed = solanaApp({ spec, rpc, wallet: asWallet(kp), now: () => w.chain.now() });
    const another = w.make(1, kp.address);
    await tailed.craft('melt', [another], 1, {
      listing,
      extra: [{ pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false }],
    });
    assert.ok((w.chain.get(another)?.data.length ?? 0) <= 1, 'burned, with its tail');
    const message = readMessage(sent.at(-1).message);
    const craft = message.instructions.find(ix => message.keys[ix.programIndex] === loot.LOOT_PROGRAM);
    assert.equal(message.keys[craft.accountIndexes.at(-1)], MEMO_PROGRAM, 'the tail closes the craft');
  });
});

describe('a loan whose token someone can freeze is shown as such, and needs the player’s yes', () => {
  test('loanOffer names the freeze authority, and borrow refuses without acceptRisks', { skip }, async () => {
    const w = world({ seed: 'hardening-loan' });
    w.upsert({ Item: { id: 1, args: collectible('Fighter') } });
    const maker = w.who();
    // A mint the lender can freeze.
    const frozen = newAddress(w.random);
    w.chain.send(w.creator, [
      createAccountIx({
        from: w.creator,
        address: frozen,
        lamports: w.chain.rent(MINT_BYTES),
        space: MINT_BYTES,
        owner: TOKEN_PROGRAM,
      }),
      initializeMint2Ix({ mint: frozen, decimals: 6, authority: w.creator, freezeAuthority: maker }),
    ]);
    const rule = { of: { Item: [1] }, key: '', test: 'Any' };
    for (const [id, mint] of [
      [1, w.mint],
      [2, frozen],
    ]) {
      w.fund(maker, mint, 10n * PRICE);
      w.chain.send(maker, [
        loot.openOfferIx({
          maker,
          project: w.project,
          id,
          mint,
          args: { rule, deal: { Lend: { amount: PRICE, repay: 2n * PRICE, lasts: 3600 } }, left: 1 },
        }),
      ]);
    }
    const kp = funded(w);
    const app = solanaApp({
      spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } },
      rpc: w.chain.rpc,
      wallet: asWallet(kp),
      now: () => w.chain.now(),
    });
    const plain = await app.loanOffer(maker, 1);
    assert.deepEqual(plain.risks, []);
    const risky = await app.loanOffer(maker, 2);
    assert.deepEqual(
      risky.risks.map(r => [r.power, r.holder]),
      [['freeze', maker]],
    );
    assert.match(risky.risks[0].says, /That is the lender: they could keep you from repaying and take your NFT/);
    const [a, b] = [w.make(1, kp.address), w.make(1, kp.address)];
    await assert.rejects(app.borrow(maker, 2, a), /Repaying this loan can be blocked.*acceptRisks: true/);
    assert.equal(w.balance(kp.address, frozen), 0n, 'nothing borrowed');
    const { hold } = await app.borrow(maker, 2, a, { acceptRisks: true });
    assert.equal(w.read('Hold', hold).debt.lender, maker);
    assert.equal(w.balance(kp.address, frozen), PRICE);
    const loan = await app.borrow(maker, 1, b);
    assert.equal(w.balance(kp.address, w.mint), PRICE, 'a plain token needs no yes');
    // Repaying: the wallet's one prompt repays and brings the NFT home in the same instruction.
    w.fund(kp.address, w.mint, PRICE);
    let prompts = 0;
    const counted = solanaApp({
      spec: { version: 2, tokens: [], live: { project: w.project, collection: w.collection } },
      rpc: w.chain.rpc,
      wallet: { ...asWallet(kp), signTransaction: x => (prompts++, asWallet(kp).signTransaction(x)) },
      now: () => w.chain.now(),
    });
    const before = w.chain.get(kp.address).lamports;
    const due = w.read('Hold', loan.hold).free_at;
    const shown = await counted.loan(b, due);
    assert.equal(shown.repay, 2n * PRICE);
    await assert.rejects(counted.repay(b, due), /Say the debt the payer was shown/);
    await assert.rejects(counted.repay(b, due, { repay: shown.repay - 1n }), /now asks/);
    assert.equal(prompts, 0);
    const { home } = await counted.repay(b, due, { repay: shown.repay });
    assert.equal(home, true);
    assert.equal(prompts, 1, 'one prompt, and no key');
    assert.equal(w.chain.get(loan.hold), null, 'the hold is closed');
    assert.equal(parseCoreAsset(w.chain.get(b).data).owner, kp.address, 'the NFT is home');
    assert.equal(w.balance(maker, w.mint), 10n * PRICE - PRICE + 2n * PRICE, 'the lender is repaid');
    assert.ok(w.chain.get(kp.address).lamports > before - 1_000_000n, 'the hold’s rent came back, less fees');
  });
});

describe('one cluster a process, and MCP files inside the project folder', () => {
  test('an RPC of another cluster is refused by the approval, by its genesis too, by xsolana_status and by the player module', async () => {
    // This process's cluster, and the other one: its public RPC's URL, its first block, and how each is refused.
    const here = loot.cluster();
    const onDevnet = here === 'devnet';
    const otherUrl = onDevnet ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
    const otherGenesis = onDevnet
      ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    const urlRefused = onDevnet
      ? /is a mainnet RPC\. This works on devnet/
      : /is not a mainnet RPC\. This works on mainnet/;
    const chainRefused = onDevnet
      ? /is on mainnet\. This works on devnet/
      : /is not on mainnet\. This works on mainnet/;
    assert.throws(() => clusterChain(otherUrl), urlRefused);
    const hits = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const { method } = JSON.parse(init.body);
      hits.push(method);
      const result =
        method === 'getGenesisHash' ? otherGenesis : { value: { blockhash: NOBODY, lastValidBlockHeight: 1 } };
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    const was = process.env.XSOLANA_RPC_URL;
    try {
      const chain = clusterChain('https://rpc.example.invalid/my-key');
      await assert.rejects(chain.latestBlockhash(), chainRefused);
      await assert.rejects(chain.send(new Uint8Array(1)), chainRefused);
      assert.deepEqual([...new Set(hits)], ['getGenesisHash'], 'nothing but the genesis is asked');
      process.env.XSOLANA_RPC_URL = otherUrl;
      const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-019-status-'));
      writeFileSync(
        path.join(dir, 'xsolana.json'),
        JSON.stringify({ ...example, network: here, live: { project: NOBODY } }),
      );
      const status = await runTool('xsolana_status', {}, { cwd: dir, now: NOW });
      assert.match(status.text, urlRefused);
      assert.throws(
        () =>
          solanaApp({
            spec: { network: here, live: { project: NOBODY } },
            rpcUrl: otherUrl,
            wallet: null,
          }),
        urlRefused,
      );
    } finally {
      globalThis.fetch = real;
      if (was === undefined) delete process.env.XSOLANA_RPC_URL;
      else process.env.XSOLANA_RPC_URL = was;
    }
  });

  test('xsolana_save and every tool’s file stay inside the project folder, and a save never overwrites a file that is not a spec', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'xsolana-019-paths-'));
    const project = path.join(base, 'project');
    mkdirSync(project);
    const outside = path.join(base, 'home', '.bashrc');
    mkdirSync(path.dirname(outside));
    writeFileSync(outside, 'export PATH=$HOME/bin:$PATH\n');
    for (const file of ['../home/.bashrc', path.join(base, 'elsewhere.json'), '../elsewhere.json']) {
      const r = await runTool('xsolana_save', { spec: example, file }, { cwd: project, now: NOW });
      assert.equal(r.ok, false, r.text);
      assert.match(r.text, /outside the project folder|not a \.json file/);
    }
    assert.equal(readFileSync(outside, 'utf8'), 'export PATH=$HOME/bin:$PATH\n');
    assert.ok(!existsSync(path.join(base, 'elsewhere.json')));
    const read = await runTool('xsolana_check', { file: '/etc/hostname' }, { cwd: project, now: NOW });
    assert.ok(read.isError && /outside the project folder/.test(read.text), read.text);
    // Inside the folder: a broken JSON file is named without quoting it, and a JSON file that is no spec is kept.
    writeFileSync(path.join(project, 'notes.json'), 'secret words here');
    const broken = await runTool('xsolana_check', { file: 'notes.json' }, { cwd: project, now: NOW });
    assert.ok(!broken.text.includes('secret'), broken.text);
    writeFileSync(path.join(project, 'package.json'), '{"name":"game"}');
    const r = await runTool('xsolana_save', { spec: example, file: 'package.json' }, { cwd: project, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(path.join(project, 'package.json'), 'utf8'), '{"name":"game"}');
    assert.equal((await runTool('xsolana_save', { spec: example }, { cwd: project, now: NOW })).ok, true);
  });
});

describe('a throwaway key never keeps the player’s SOL', () => {
  test('a settle someone else sent first: the key gives its lamports back', { skip }, async () => {
    const { w, owner, player, live } = await shop('hardening-burner');
    let burner = null;
    let raced = false;
    const rpc = {
      ...w.chain.rpc,
      async send(wire) {
        const payer = readTransaction(wire).signers[0];
        // The throwaway key's settle: someone settles the order first.
        if (payer !== player.address && !raced) {
          raced = true;
          burner = payer;
          const orders = w.chain.svm.getProgramAccounts(loot.LOOT_PROGRAM).filter(a => a.data[0] === loot.TAGS.Order);
          for (const o of orders) {
            const order = loot.decode('Order', o.data);
            if (order.player !== player.address) continue;
            const items = Object.fromEntries(
              order.won
                .filter(x => x.Item)
                .map(x => [x.Item.item, w.read('Item', pda.item(live.live.project, x.Item.item))]),
            );
            w.chain.send(owner.address, [
              computeUnitLimit(600_000),
              loot.settleIx({
                signer: owner.address,
                orderAddress: o.address,
                order,
                projectState: w.read('Project', live.live.project),
                items,
              }),
            ]);
          }
        }
        return w.chain.rpc.send(wire);
      },
    };
    const app = solanaApp({ spec: live, rpc, wallet: asWallet(player), now: () => w.chain.now() });
    const r = await app.openBox('chest', { listing: (await app.boxes()).find(l => l.key === 'chest') });
    assert.ok(raced && burner, 'the race happened');
    assert.equal(r.settled, 'elsewhere');
    assert.equal(await w.chain.rpc.balance(burner), 0n, 'the throwaway key is empty');
  });
});

describe('a farm that watches counts no streak', () => {
  test('the checker refuses a streak on a watching farm, as the program does', async () => {
    const { check } = await import('../economy/check.mjs');
    const spec = JSON.parse(readFileSync(new URL('../../examples/guild-missions.json', import.meta.url), 'utf8'));
    const codes = s => check(s).refusals.map(p => p.code);
    assert.ok(!codes(spec).includes('E-FARM'));
    const watching = spec.farms.find(f => f.custody === 'watch' && f.growth?.length);
    watching.growth[0].streak = true;
    assert.ok(codes(spec).includes('E-FARM'));
    watching.custody = 'escrow';
    assert.ok(!codes(spec).includes('E-FARM'));
  });
});
