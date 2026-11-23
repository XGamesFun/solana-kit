// Sending, for the page client (solanaApp): the player's wallet signs, and a transaction is made to fit (the project's
// standing lookup tables, or one the wallet makes), sponsored when the app has a sponsor, tried first when it should be
// (`dryRun`), and put in words when it fails. The throwaway keys of the key job rule (AGENTS.md) are funded and emptied
// here. `unwrap` turns the player's wrapped SOL into plain SOL.
import { ASSOCIATED_TOKEN_PROGRAM, associatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM } from '../chain/pda.js';
import {
  closeTokenAccount,
  createAssociatedTokenAccountIdempotent,
  transferLamports,
  withComputeBudget,
} from '../chain/programs.js';
import {
  compileFitting,
  compileKeepingKind,
  readTable,
  sendFitting,
  WALLET_ADDS_BYTES,
  LOOKUP_TABLE_PROGRAM,
} from '../chain/lookup.js';
import { readTransaction, SIGNATURE_LAMPORTS, wireTransaction } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { SPONSOR_MAX_LAMPORTS, sponsoredCost, sponsorGiveBack, sponsorTopUp, stepShape, topUpFor } from './sponsor.js';
import { freshKey, isProveLeaf } from './common.js';

/** The compute units a sponsored step asks for: all a transaction can have. It sets a price of 0, so they cost nothing. */
const SPONSORED_UNITS = 1_400_000;

/** A system account must keep this much (rent for 0 bytes) or be emptied. */
const RENT_EMPTY = 890_880n;

/**
 * Puts on `ctx` the ways a step is sent (`send`, `sendBatch`, `sendAs`), a dry run, and a throwaway key's funding and refund. Returns `ctx`.
 * @param {ReturnType<typeof import('./reads.js').addReads>} ctx
 */
export function addSending(ctx) {
  const { spec, wallet, sponsor, client, project, keys } = ctx;

  /**
   * SOL paid out to the player (a prize, rewards, a refund, a grant) lands in their wrapped-SOL account: close it at
   * the end, so the player keeps plain SOL. When the transaction pays into it and nothing opens it first, the player
   * opens it here (the program would otherwise open it, unseen), and has the rent back at the close.
   */
  async function unwrapAfter(instructions) {
    const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
    const opens = instructions.some(ix => ix.programId === ASSOCIATED_TOKEN_PROGRAM && ix.keys[1]?.pubkey === wrapped);
    const closes = instructions.some(
      ix => ix.programId === TOKEN_PROGRAM && ix.data?.[0] === 9 && ix.keys[0]?.pubkey === wrapped,
    );
    if (closes) return instructions;
    const close = closeTokenAccount(wrapped, wallet.address, wallet.address);
    if (opens || (await client.account(wrapped))) return [...instructions, close];
    const touches = instructions.some(ix => ix.keys?.some(k => k.pubkey === wrapped));
    return touches
      ? [createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, NATIVE_MINT), ...instructions, close]
      : instructions;
  }

  /**
   * The project's standing lookup tables (made at go-live, `spec.live.tables`), each as the chain holds it now: one
   * deactivated (or gone) is left out, and a transaction then makes a table of its own.
   */
  ctx.standingTables = null;
  async function standing() {
    ctx.standingTables ??= (async () => {
      const addresses = spec.live?.tables ?? [];
      const found = addresses.length ? await client.accounts(addresses) : [];
      return addresses.flatMap((address, i) => {
        const table = readTable(found[i] && { ...found[i], owner: found[i].owner ?? LOOKUP_TABLE_PROGRAM });
        return table && table.deactivationSlot === null ? [{ address, addresses: table.addresses }] : [];
      });
    })();
    return ctx.standingTables;
  }

  /**
   * The room kept in a step the player's wallet signs, for what the wallet adds before it signs (`WALLET_ADDS_BYTES`);
   * none for a wallet that says it signs no v0 transaction (`wallet.versions`), which gets a legacy one.
   */
  const walletRoom = () => (wallet?.versions && !wallet.versions.includes(0) ? 0 : WALLET_ADDS_BYTES);

  /**
   * Build, have the wallet sign, send and confirm. Extra signers (fresh keys) sign first. Returns the signature.
   * `keepWrapped`: leave the player's wrapped-SOL account open (a bid's: what is topped comes back there).
   * Its size is checked before the wallet signs (`sendFitting`): one that fits a legacy transaction and leaves the
   * wallet less than `WALLET_ADDS_BYTES` for the checks it adds goes as v0 with the project's standing tables, when
   * they make it smaller (the same one prompt); a transaction too big for a legacy one goes as one v0
   * transaction with a lookup table the wallet makes first (one to three more approvals, and the table's rent until the
   * player closes it, which `claims()` lists); only when even that is too big does each compressed NFT's `prove_leaf`
   * go alone, after the table and before the rest. A compressed NFT's record closes in the same transaction, its prover
   * signing (`loot.withLeafCloses`), so its rent comes straight back.
   */
  async function send(instructions, extra = [], { keepWrapped = false } = {}) {
    if (!wallet?.address) throw new Error('Connect a wallet first.');
    // A compressed NFT's record is closed in the transaction that used it, its prover signing: its rent comes back.
    instructions = loot.withLeafCloses(instructions);
    if (!keepWrapped) instructions = await unwrapAfter(instructions);
    if (sponsor) {
      const sponsored = await sendSponsored(instructions, extra);
      if (sponsored) return sponsored;
    }
    return sendUnsponsored(instructions, extra);
  }

  /** The player's step as they pay for it themselves: their wallet the fee payer (`sendFitting`). */
  async function sendUnsponsored(instructions, extra = []) {
    const sign = async message => {
      const { signers } = readTransaction(wireTransaction(message));
      const sigs = await Promise.all(
        signers.map(async s =>
          extra.find(k => k.address === s) ? extra.find(k => k.address === s).sign(message) : new Uint8Array(64),
        ),
      );
      return wallet.signTransaction(wireTransaction(message, sigs));
    };
    // The project first in a table, so claims() knows a table whose later steps were never sent as this project's.
    return (
      await sendFitting({
        rpc: client,
        payer: wallet.address,
        instructions,
        sign,
        alone: isProveLeaf,
        first: [project],
        standing: await standing(),
        room: walletRoom(),
        // read again just before a step goes as v0 for the room's sake: a table retired since is passed by
        fresh: () => ((ctx.standingTables = null), standing()),
      }).catch(inWords)
    ).signature;
  }

  const sendNow = (...args) => send(...args);

  /** The most the sponsor pays a transaction (its top-up and network fee), as the app was told. */
  // It lends the player that, less room for the network fee, and takes back what the step didn't need.
  const sponsorMax = sponsor ? BigInt(sponsor.maxLamports ?? SPONSOR_MAX_LAMPORTS) - SIGNATURE_LAMPORTS * 4n : 0n;

  /** Every account a list of instructions names, its programs too. */
  const namedIn = instructions => [
    ...new Set(instructions.flatMap(ix => [ix.programId, ...ix.keys.map(k => k.pubkey)])),
  ];

  /**
   * The player's step with the sponsor paying (`sponsor`, js/play/sponsor.js): the sponsor the fee payer and the
   * player topped up first by what the step costs them in fees and rent (a dry run, as the sponsor's server will
   * check it), the player's wallet signing, then the sponsor's server. Null when it can't be sponsored as one
   * transaction (it needs a lookup table of its own, or proofs sent first), or the sponsor refused it and the player
   * pays instead (`sponsor.playerPaysIfRefused`, the default): the step then goes as the player's own.
   */
  async function sendSponsored(instructions, extra) {
    const me = wallet.address;
    const tables = await standing();
    const { blockhash, lastValidBlockHeight } = await client.latestBlockhash();
    // Lent the most, the step is tried; then sent lent the same, the player giving back last all but what it costs in
    // fees and rent: a step can need more SOL midway than it costs (a wrapped-SOL account it opens and closes).
    // It leads with a compute unit limit (all a transaction can have) and a unit price of 0, the price a sponsor
    // pays unless its server says more: a wallet that adds its own priority fee only where a transaction sets none
    // (Phantom does, to one with no signature on it yet) is then handed one it signs as it stands, and the sponsor's
    // server, which refuses a price it did not agree to, takes it. A step keeps the kind of transaction it had: one
    // that fits a legacy transaction stays one (without the two where they would not fit), and only a step that
    // needed the project's lookup tables before goes as v0.
    const compile = (back = 0n) => {
      const list = [
        sponsorTopUp(sponsor.address, me, sponsorMax),
        ...instructions,
        ...(back > 0n ? [sponsorGiveBack(sponsor.address, me, back)] : []),
      ];
      return compileKeepingKind({
        payer: sponsor.address,
        blockhash,
        led: withComputeBudget(list, { units: SPONSORED_UNITS, microLamports: 0n }),
        plain: list,
        tables,
      });
    };
    const tried = compile();
    if (!tried) return null;
    const addresses = namedIn([sponsorTopUp(sponsor.address, me, 0n), ...instructions]);
    const pre = await client.accounts(addresses);
    // A step loot refuses is refused in words; one that fails otherwise (the sponsor short of SOL) goes as the player's.
    const run = await client
      .simulate(wireTransaction(tried), { accounts: addresses, replaceBlockhash: true })
      .catch(e => (loot.lootError(e?.logs ?? []) ? inWords(e) : null));
    if (!run) return null;
    const post = run.accounts;
    const at = a => addresses.indexOf(a);
    const balance = a => (a ? BigInt(a.lamports) : 0n);
    const cost = sponsoredCost({
      addresses,
      pre,
      post,
      project,
      skip: [sponsor.address, me],
      ...stepShape(instructions),
    });
    const spend = balance(pre[at(me)]) + sponsorMax - balance(post[at(me)]);
    const message = compile(sponsorMax - topUpFor({ spend, cost }));
    if (!message) return null;
    const { signers } = readTransaction(wireTransaction(message));
    const sigs = await Promise.all(
      signers.map(async s => extra.find(k => k.address === s)?.sign(message) ?? new Uint8Array(64)),
    );
    const signed = await wallet.signTransaction(wireTransaction(message, sigs));
    let wire;
    try {
      wire = await sponsor.sign(signed);
    } catch (e) {
      if (sponsor.playerPaysIfRefused === false) throw e;
      return null;
    }
    const signature = await client.send(wire).catch(inWords);
    await client.confirm?.(signature, { lastValidBlockHeight });
    return signature;
  }

  /**
   * Several independent steps of the player's, each one transaction (`lists`: their instructions), signed in one wallet
   * prompt when the wallet signs several at once (`wallet.signTransactions`), then sent in order; one by one otherwise,
   * and for a step too big for one transaction. Returns each step's { signature } or { error }.
   */
  async function sendBatch(lists) {
    const settled = p =>
      p.then(
        signature => ({ signature }),
        e => ({ error: e.message }),
      );
    let signed = null;
    let messages = [];
    let lastValidBlockHeight = null;
    if (wallet?.signTransactions && lists.length > 1 && !sponsor) {
      const latest = await client.latestBlockhash();
      lastValidBlockHeight = latest.lastValidBlockHeight;
      const tables = await standing();
      for (const l of lists)
        messages.push(
          compileFitting({
            payer: wallet.address,
            blockhash: latest.blockhash,
            instructions: await unwrapAfter(loot.withLeafCloses(l)),
            tables,
            room: walletRoom(),
          }),
        );
      const wires = messages.filter(Boolean).map(m => wireTransaction(m));
      const back = wires.length > 1 ? await wallet.signTransactions(wires).catch(() => null) : null;
      if (back) signed = messages.map(m => (m ? back.shift() : null));
    }
    const out = [];
    for (const [i, l] of lists.entries()) {
      const wire = signed?.[i];
      const confirmed = async () => {
        const signature = await client.send(wire).catch(inWords);
        await client.confirm?.(signature, { lastValidBlockHeight });
        return signature;
      };
      out.push(await settled(wire ? confirmed() : send(l)));
    }
    return out;
  }

  /**
   * Throws `e` with loot's reason in words in place of a bare code: a wallet whose own dry run failed often says only
   * "custom program error: 0x17b5". A code is loot's when the logs name loot as the program that failed, or, with no
   * logs, when it is one of loot's (Anchor's codes start at 6000; the token programs' are small).
   */
  function inWords(e) {
    // The program logs an error's name only (its text is compiled out): the IDL's sentence for it.
    const logged = e?.logs ? loot.lootError(e.logs) : null;
    if (logged)
      throw Object.assign(new Error(`${logged.msg} (${logged.name}).`, { cause: e }), {
        code: logged.code,
        name: logged.name,
        logs: e.logs,
      });
    const said = String(e?.message ?? '');
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(said);
    const failed = e?.logs?.find(line => / failed: custom program error: 0x/i.test(line));
    const known = m && (!failed || failed.includes(loot.lootProgram())) ? loot.ERRORS[parseInt(m[1], 16)] : null;
    if (!known) throw e;
    throw Object.assign(new Error(`${known.msg} (${known.name}).`, { cause: e }), {
      code: parseInt(m[1], 16),
      name: known.name,
      logs: e.logs,
    });
  }

  /**
   * Build, sign with `key` alone (it pays), send and confirm: a throwaway key's transaction. No wallet prompt. Legacy,
   * or v0 with the project's standing tables (which cost it nothing); the key holds no rent for a table of its own.
   */
  async function sendAs(key, instructions) {
    instructions = loot.withLeafCloses(instructions);
    return (
      await sendFitting({
        rpc: client,
        payer: key.address,
        instructions,
        sign: async message => wireTransaction(message, [await key.sign(message)]),
        table: false,
        standing: await standing(),
      }).catch(inWords)
    ).signature;
  }

  /**
   * The key job rule (AGENTS.md). A step after the wallet's prompt (a settle, an ask for a roll, a release) is sent by a
   * throwaway key made in memory for that one job. `keyFor(pays)` makes it, and the transfer that funds it, which goes
   * in the wallet's own transaction: what its steps pay (`pays`: their fees, an ask's oracle fee, the rent of what a
   * settle opens or mints, `loot.settleRent`) and the rent minimum read from the cluster, plus one spare fee so it can
   * always empty itself. A key pays for an account only with lamports the wallet gave it for that, and never makes a
   * proof record: then the wallet sends that step. `key`: one made already (a box's open names it before it knows how
   * many settles it funds).
   */
  async function keyFor(pays = SIGNATURE_LAMPORTS, key = null) {
    key ??= await freshKey();
    return {
      key,
      fund: transferLamports(wallet.address, key.address, (await rentEmpty()) + BigInt(pays) + SIGNATURE_LAMPORTS),
    };
  }

  /** The rent minimum of an account of no data, as the cluster says it (once). A key must hold it, past its fee, to pay
   * a transaction's fee: a fee payer stays rent-exempt or ends empty. */
  ctx.rentMinimum = null;
  const rentEmpty = async () =>
    (ctx.rentMinimum ??= BigInt(
      await client.call('getMinimumBalanceForRentExemption', [0]).catch(() => Number(RENT_EMPTY)),
    ));

  /** Whether `instructions` would land as `payer` sends them now (a dry run, with the standing tables when they need
   * them), and the accounts `watch` as they would be after: { ok, accounts, error }, `error` loot's when it refused
   * ({ code, name, msg }, `loot.lootError`). */
  async function dryRun(payer, instructions, watch = []) {
    // A sponsored player's step is tried as it will be sent: the sponsor pays, and tops the player up (here by the
    // most it pays, so a player with no SOL is tried as one the sponsor covers).
    if (sponsor && payer === wallet?.address) {
      instructions = [sponsorTopUp(sponsor.address, payer, sponsorMax), ...instructions];
      payer = sponsor.address;
    }
    const { blockhash } = await client.latestBlockhash();
    const message = compileFitting({ payer, blockhash, instructions, tables: await standing() });
    if (!message) return { ok: false, accounts: [], error: null };
    let error = null;
    const r = await client.simulate(wireTransaction(message), { accounts: watch, replaceBlockhash: true }).catch(e => {
      error = loot.lootError(e?.logs ?? []);
      return null;
    });
    return { ok: Boolean(r), accounts: r?.accounts ?? [], error };
  }

  /** A throwaway key empties itself back to the wallet: all it holds now, less its own fee. Nothing when it holds no more
   * than that fee (a settle of its that failed on chain took its fee: the wallet then pays the move, one more prompt). */
  async function emptyKey(key) {
    const left = BigInt(await client.balance(key.address).catch(() => 0n));
    // A refund that fails is not the player's error, so it is not thrown: the key's job already landed, and `recover`
    // finds a key still holding SOL and sends it back.
    if (left >= (await rentEmpty()) + SIGNATURE_LAMPORTS)
      await sendAs(key, [transferLamports(key.address, wallet.address, left - SIGNATURE_LAMPORTS)]).catch(() => null);
    else if (left > 0n) await send([transferLamports(key.address, wallet.address, left)], [key]).catch(() => null);
    // A key kept in storage is dropped once it holds nothing.
    if (key.name && !(BigInt(await client.balance(key.address).catch(() => 1n)) > 0n)) keys?.forget(key.name);
  }
  return Object.assign(ctx, { standing, send, sendNow, sendBatch, sendAs, keyFor, dryRun, emptyKey });
}

/**
 * The sending method: `unwrap`.
 * @param {import('./common.js').Ctx} ctx
 */
export function sendingMethods(ctx) {
  const { wallet, client, send } = ctx;

  return {
    /** Turns what waits in the player's wrapped-SOL account (a bid that was topped) into plain SOL. */
    async unwrap() {
      const wrapped = associatedTokenAddress(wallet.address, NATIVE_MINT);
      if (!(await client.account(wrapped))) return null;
      return send([closeTokenAccount(wrapped, wallet.address, wallet.address)]);
    },
  };
}
