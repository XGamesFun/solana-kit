// Rolls, for the page client (solanaApp): what a prize needs to be given, the oracle's ask for an order's roll, and
// the settle that collects what it rolled, sent by a throwaway key the player's own transaction funds (`sendRolling`,
// `collect`).
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { parseCoreCollection } from '../chain/core.js';
import { COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, requestHeapFrame, transferLamports } from '../chain/programs.js';
import { sleep } from '../chain/rpc.js';
import { compileFitting, transactionLocks } from '../chain/lookup.js';
import { SIGNATURE_LAMPORTS } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { MPL_CORE, only } from './common.js';

/**
 * Puts on `ctx` a prize's inputs, the ask for a roll and the collecting of an order. Returns `ctx`.
 * @param {ReturnType<typeof import('./sending.js').addSending>} ctx
 */
export function addRolls(ctx) {
  const {
    wallet,
    programs,
    sponsor,
    client,
    project,
    keys,
    jobKey,
    collections,
    mintOf,
    programOf,
    read,
    readMaybe,
    nftOf,
    leaving,
    projectNow,
    owned,
    standing,
    send,
    sendAs,
    keyFor,
    dryRun,
    emptyKey,
    slotNow,
    chainNow,
    holdersOf,
  } = ctx;

  /**
   * What `loot.prizeMetas` needs to give these prizes (`null`s are skipped): each pool's mint, each item (its kind, its
   * collection and its next serial; null for one never written), each NFT's kind (`nfts`, and `nft` for one), the
   * project's first collection, a compressed NFT's proof, which goes first in the transaction (`before`), and for a
   * roll its box, decoded (`boxes`, `boxesOf`).
   */
  async function prizeInputs(prizes, signer = wallet.address, winner = wallet.address) {
    const out = { poolMints: {}, items: {}, nfts: {}, nft: undefined, collection: collections[0], before: [] };
    out.boxes = await boxesOf(prizes.filter(Boolean).flatMap(p => (p.Roll ? [p.Roll[0]] : [])));
    for (const prize of prizes.filter(Boolean)) {
      const pool = prize.Tokens?.from.Pool?.[0];
      if (pool !== undefined && !(pool in out.poolMints)) {
        const account = await client.account(loot.pda.pool(project, pool));
        // A pool never opened gives nothing; the economy's currency stands in for its mint's place.
        out.poolMints[pool] = account ? encodeBase58(account.data.subarray(0, 32)) : mintOf();
      }
      const id = prize.Item?.[0] ?? prize.Compressed?.item;
      if (id !== undefined && !(id in out.items)) out.items[id] = await readMaybe('Item', loot.pda.item(project, id));
      // An NFT of a stash, or one a lottery's place holds in the lottery's own stash.
      const asset = prize.Nft?.nft ?? prize.Held?.[0];
      if (asset && !out.nfts[asset]) {
        const { before, hasAuthority: _, ...nft } = await nftOf(asset, signer, { to: winner });
        out.nfts[asset] = out.nft = nft;
        out.before.push(...before);
      }
    }
    return out;
  }

  /**
   * Rolls in one prompt: a step that makes orders waiting for their roll (a craft, a buy, a mission left, a grant or a
   * contest prize, a lot won) asks for each in the same transaction, and a throwaway key it funds then settles each (the
   * key job rule: funded with each settle's fees and what it may open or mint, `loot.settleRent`). A dry run finds them:
   * the accounts the step writes that come out as orders waiting (a limit can hold a round back, so only what it would
   * make). A box with nothing in stock refuses the ask, and with it the step (`SoldOut`): nothing is sent, and the
   * player is told. When the step and its asks would not land together for any other reason (a missing prize vault,
   * too big a transaction), the step goes alone and its rolls wait in `claims()`. Returns { signature, rolls }.
   */
  async function sendRolling(instructions) {
    const watch = [
      ...new Set(
        instructions
          .filter(ix => ix.programId === loot.lootProgram())
          .flatMap(ix => ix.keys.filter(k => k.isWritable && !k.isSigner).map(k => k.pubkey)),
      ),
    ];
    const after = (await dryRun(wallet.address, instructions, watch)).accounts;
    const waiting = watch.flatMap((address, i) => {
      const a = after[i];
      if (a?.owner !== loot.lootProgram() || loot.accountKind(a.data) !== 'Order') return [];
      const order = loot.decode('Order', a.data);
      return order.status === 'Waiting' && order.player === wallet.address ? [[address, order]] : [];
    });
    if (!waiting.length) return { signature: await send(instructions), rolls: [] };
    // Sponsored, a settle key isn't funded (a plain account the player could empty is never sponsored): the step asks
    // for each roll, and the player's wallet settles it once it is answered (one more prompt, sponsored too).
    if (sponsor) {
      const asked = [...instructions];
      for (const [orderAddress, order] of waiting) asked.push(...(await asksFor(wallet.address, orderAddress, order)));
      const tried = await dryRun(wallet.address, asked);
      const signature = await send(tried.ok ? asked : instructions);
      const rolls = [];
      if (tried.ok) for (const [orderAddress] of waiting) rolls.push(await collect(orderAddress, { opened: true }));
      return { signature, rolls };
    }
    const asks = [];
    const funds = [];
    const burners = [];
    for (const [orderAddress, order] of waiting) {
      const box = await read('LootBox', order.loot_box);
      // Each order its own key, named by it (it can be made again after a reload, `recover`): its settle's fee, a spare
      // for its parts and its give-back, and what its settle may open or mint. The ask names it as the order's settler.
      const { key, fund } = await keyFor(
        SIGNATURE_LAMPORTS * 3n + loot.settleRent(box, Number(order.opens ?? 1), await itemsOf(box)),
        await jobKey(orderAddress),
      );
      asks.push(...(await asksFor(wallet.address, orderAddress, order, key.address)));
      funds.push(fund);
      burners.push(key);
    }
    const all = [...instructions, ...asks, ...funds];
    const tried = await dryRun(wallet.address, all);
    if (tried.error?.name === 'SoldOut')
      throw Object.assign(
        new Error(
          'The box this rolls has nothing left to give right now (SoldOut): nothing was sent. Try again once it is restocked.',
        ),
        { code: tried.error.code, name: 'SoldOut' },
      );
    // Too heavy to be answered: a step sent alone would pay for a roll that can only fail.
    if (tried.error?.name === 'PackTooLarge')
      throw Object.assign(
        new Error(
          "The box this rolls is too heavy for the oracle's answer as it stands (PackTooLarge): nothing was sent.",
        ),
        { code: tried.error.code, name: 'PackTooLarge' },
      );
    if (!tried.ok) return { signature: await send(instructions), rolls: [] };
    const signature = await send(all);
    const rolls = [];
    for (const [k, [orderAddress]] of waiting.entries())
      rolls.push(await collect(orderAddress, { burner: burners[k], opened: true }));
    return { signature, rolls };
  }

  /**
   * Waits for an order's roll (the oracle answers a moment after the open), then settles it. With `burner` (the
   * throwaway key the open funded), the burner signs and pays the settle, and gives the rest back: no wallet prompt.
   * The order names it (`settler`), so it may settle; when the player or the project did first, the burner only gives its lamports back.
   * An NFT of the order the project no longer holds (its collection took it back or burned it) is passed over: a
   * stash's NFT won is not given (its place in `assets` is null) and the NFT rolled on is not sent back; `gone` lists
   * them, with `says`. `putBack`: NFTs
   * won that the player puts back into their stash in place of taking them (one whose collection now refuses to let it
   * move); `giveUp`: the places in the order's `won` of tokens or collectibles the player gives up because they can't
   * receive them (an account the token's issuer froze, a collection that refuses the mint): tokens given up stay in the
   * project's vault, a collectible is never made. The player signs either settle. A settle that fails because the player
   * can't receive a prize says which (`error.giveUp`), so a page can offer to give them up and take the rest.
   */
  async function collect(orderAddress, options = {}) {
    only(options, ['timeoutMs', 'burner', 'putBack', 'giveUp', 'opened', 'landed', 'keepBurner'], 'collect');
    try {
      return await collectOnce(orderAddress, options);
    } catch (e) {
      // The throwaway key is never left holding the player's SOL: whatever stopped the collect (a roll not in yet, a
      // settle someone else sent first), it gives its lamports back before the error is said. Collecting again later
      // needs no burner: the player signs that settle.
      const { burner } = options;
      if (!burner) throw e;
      await emptyKey(burner);
      if (!(await client.account(orderAddress)))
        return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
      throw e;
    }
  }

  async function collectOnce(
    orderAddress,
    {
      timeoutMs = 60_000,
      burner = null,
      putBack = [],
      giveUp = [],
      opened = false,
      landed = null,
      keepBurner = false,
    } = {},
  ) {
    // The player's own choices (an NFT put back, a prize given up) are theirs to sign: no burner settles them.
    const chooses = putBack.length > 0 || giveUp.length > 0;
    const started = Date.now();
    // `landed`: the slot one's own open landed in; the order is read from a node that has seen it.
    const current = async () => {
      const account = await client.account(orderAddress, 'confirmed', landed != null ? { minContextSlot: landed } : {});
      return account?.owner === loot.lootProgram() ? loot.decode('Order', account.data) : null;
    };
    let order = await current();
    // Right after one's own confirmed open, no order is "not seen yet", never "settled already": a node of the RPC may
    // lag behind the one that confirmed it. It is read again for a few seconds first.
    for (let i = 0; !order && opened && i < 6; i++) {
      await sleep(1000);
      order = await current();
    }
    // A roll a mission or a recipe made waits to be asked for (or asked again, the oracle never having answered):
    // its player or the project's keys ask, here the player.
    if (order && loot.rollAskable(order, await slotNow(), await chainNow())) {
      await askRoll(orderAddress);
      order = await current();
    }
    while (['Pending', 'Asked'].includes(order?.status) && Date.now() - started < timeoutMs) {
      await sleep(1500);
      order = await current();
    }
    // A free roll whose answer found nothing at all in stock waits again: for a restock, or for its player to end it.
    if (order?.status === 'Waiting') {
      throw new Error(
        "The box this rolls had nothing left to give when the roll landed, so the roll waits: collect it again once the box is restocked. Collected while the box is still empty, the player's own ask ends it with nothing.",
      );
    }
    if (!order) {
      if (burner && !keepBurner) await emptyKey(burner);
      // One's own open still not seen after that: say so plainly, never that it was settled (claims() lists it).
      if (opened)
        return {
          order: orderAddress,
          settled: null,
          says: 'The network doesn’t show this order yet: collect it again in a moment (claims() lists it).',
        };
      return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
    }
    if (order.status === 'Pending')
      throw new Error(
        'The oracle has not rolled yet: try collecting again in a minute (an order never rolled refunds after about 10 minutes).',
      );
    if (order.status === 'Asked')
      throw new Error(
        'The oracle has not rolled yet: try collecting again in a minute (a roll never answered is asked again after about 10 minutes).',
      );
    if (order.status === 'Failed') throw new Error('The roll failed (the box changed or ran out): refund the order.');
    // An order closes only in a later slot than the one it was opened in.
    for (let i = 0; i < 20 && client.call; i++) {
      const slot = BigInt(await client.call('getSlot', [{ commitment: 'confirmed' }]));
      if (slot > order.requested_slot) break;
      await sleep(400);
    }
    const g = await projectNow();
    // What the roll set aside: each item it gave (its kind and collection) and each NFT's kind (a compressed one
    // proven first).
    const items = {};
    for (const won of order.won) {
      const id = won.Item?.item ?? won.Compressed?.item;
      if (id !== undefined && !(id in items)) items[id] = await read('Item', loot.pda.item(project, id));
    }
    // A compressed prize is minted into the tree its box names (any of the project's with room), the next NFT it mints.
    const treeOf = async () => {
      if (!order.won.some(w => w.Compressed)) return {};
      const box = await read('LootBox', order.loot_box);
      const tree = box.entries.flatMap(e => e.prizes).find(p => p.Compressed)?.Compressed.tree;
      const config = (await client.account(loot.pda.treeConfig(tree)))?.data;
      // An item's collection without Bubblegum's plugin mints nothing: the prizes after it take its place in the tree.
      const unminted = [];
      for (const c of new Set(
        order.won
          .filter(w => w.Compressed)
          .map(w => items[w.Compressed.item]?.collection)
          .filter(Boolean),
      )) {
        const data = (await client.account(c))?.data;
        if (!data || !parseCoreCollection(data).bubblegum) unminted.push(c);
      }
      return {
        tree,
        unminted,
        treeMinted: config ? config.subarray(80, 88).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n) : 0n,
      };
    };
    const holders = await holdersOf(order.shares);
    // NFTs of this order the project no longer holds (their collection took them back or burned them): the settle
    // passes each over on that proof. A stash's NFT won is then not given; the NFT rolled on is not sent back.
    const lost = new Set();
    // Given by its fate to a wallet that is an account of the loot program, the NFT goes back to the player.
    const gives = order.held ? order.fate?.then?.Give?.[0] : undefined;
    const handBack = gives !== undefined && loot.handsBack(await client.account(gives));
    /** The settle's part up to `upto` (`loot.SETTLE_LAST`: all that is left; 0: the split alone) as `signer` sends it,
     * and what goes before it: each compressed NFT's proof, a fresh token account. */
    const settleBy = async (signer, upto = loot.SETTLE_LAST) => {
      const nfts = {};
      const proving = [];
      const end = Math.min(order.won.length, upto);
      for (const won of order.won.slice(Number(order.settled ?? 0), end)) {
        if (won.Nft && !putBack.includes(won.Nft.nft)) {
          // A fresh token account a Token Metadata NFT needs (its holder's own can't take it) is the wallet's to open: a
          // settle with anything before it is the wallet's to send.
          const {
            before,
            hasAuthority: _,
            gone,
            ...kind
          } = await leaving(won.Nft.nft, signer, { to: order.player, payer: wallet.address });
          if (gone) lost.add(won.Nft.nft);
          nfts[won.Nft.nft] = kind;
          proving.push(...before);
        }
      }
      // The NFT the roll was on: its kind, and for a compressed one a proof first. One the order holds may be gone.
      const {
        before: subjectProof,
        gone: subjectGone,
        ...subject
      } = order.subject && order.subject !== NO_ADDRESS
        ? order.held
          ? await leaving(order.subject, signer)
          : await nftOf(order.subject, signer)
        : { before: [] };
      if (subjectGone) lost.add(order.subject);
      const ix = loot.settleIx({
        signer,
        orderAddress,
        order,
        projectState: g,
        items,
        nfts,
        putBack,
        giveUp,
        subject,
        handBack,
        holders,
        programs,
        upto,
        ...(await treeOf()),
      });
      return { ix, nfts, before: [...subjectProof, ...proving].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM) };
    };
    // An order whose settle doesn't fit one transaction (the instruction trace, 64 accounts, 1,232 bytes) settles in
    // parts, each its own transaction, from where the last stopped. The first splits the payment, its shares' accounts
    // with it (alone, `upto` 0, when not even one prize fits beside them); parts that hand prizes over (`upto` where
    // each stops), as many as the trace holds (`settlePartEnd`) and fewer until they fit; then a last part
    // (`SETTLE_LAST`) with the NFT rolled on. The burner sends each, paying what each mints with what the open funded it
    // with; the player's wallet, a part it can't.
    const signatures = [];
    // A key the order doesn't name can't settle it (`Order::settler`): then the player signs.
    const by = burner && !chooses && order.settler === burner.address ? burner.address : wallet.address;
    const fits = async instructions =>
      Boolean(compileFitting({ payer: by, blockhash: NO_ADDRESS, instructions, tables: await standing() })) &&
      transactionLocks(by, instructions) <= 64;
    const part = async end => [computeUnitLimit(loot.settleComputeUnits(order)), (await settleBy(by, end)).ix];
    const sendPart = async end =>
      signatures.push(by === wallet.address ? await send(await part(end)) : await sendAs(burner, await part(end)));
    for (;;) {
      const from = Number(order.settled ?? 0);
      if (from >= order.won.length) break;
      let end = loot.settlePartEnd(order, from, items);
      if (end >= order.won.length && (await fits(await part(loot.SETTLE_LAST)))) break;
      while (end > from + 1 && !(await fits(await part(end)))) end--;
      await sendPart(Number(order.drew ?? 0) > 0 && !(await fits(await part(end))) ? 0 : end);
      order = await current();
      if (!order) return { order: orderAddress, settled: 'elsewhere', says: 'The order was settled already.' };
    }
    // Room for every move the shape makes (`loot.settleComputeUnits`), and for a settle of several NFTs the bigger heap
    // the program's allocator uses (`loot.settleHeapFrame`).
    const heap = loot.settleHeapFrame(order);
    const budget = [computeUnitLimit(loot.settleComputeUnits(order)), ...(heap ? [requestHeapFrame(heap)] : [])];
    // The settle opens or mints what the order won (a collectible, a token account, a Sheet, the fate's writes), paid by
    // whoever signs it: the burner, with what the open funded it with (`loot.settleRent`). It settles alone unless the
    // settle needs something first (a proof, a fresh token account) or doesn't fit a legacy transaction (a lookup
    // table's rent is the wallet's to pay), and only when a dry run says it lands as the burner sends it; else the
    // wallet settles (one more prompt). An NFT put back into its stash (one its collection no longer lets move) is the
    // player's own choice: they sign.
    let signature = null;
    let emptied = false;
    const byBurner = burner && !chooses && order.settler === burner.address ? await settleBy(burner.address) : null;
    const alone = byBurner && !byBurner.before.length ? [...budget, byBurner.ix] : null;
    const legacy = instructions =>
      Boolean(compileFitting({ payer: burner.address, blockhash: NO_ADDRESS, instructions }));
    const tried = alone && legacy(alone) ? await dryRun(burner.address, alone, [burner.address]) : null;
    if (tried?.ok) {
      // Its last settle gives back all the burner holds after it, in the same transaction, as the dry run says it will
      // hold (its fee and what the settle opened taken); when that doesn't land as one, the burner empties itself after.
      const left = BigInt(tried.accounts[0]?.lamports ?? 0);
      const back = !keepBurner && left > 0n ? [...alone, transferLamports(burner.address, wallet.address, left)] : null;
      if (back && legacy(back) && (await dryRun(burner.address, back)).ok)
        signature = await sendAs(burner, back).catch(() => null);
      emptied = Boolean(signature);
      signature ??= await sendAs(burner, alone).catch(() => null);
    }
    if (!signature) {
      // The wallet's settle: as a v0 transaction with a lookup table when it doesn't fit a legacy one (`send`).
      const { ix, before } = await settleBy(wallet.address);
      signature = await send([...budget, ...before, ix]).catch(async e => {
        throw await cannotReceive(order, e);
      });
    }
    // The burner gives back what it holds after its last settle (a purchase of several orders: after the last order's).
    if (burner && !keepBurner && !emptied) await emptyKey(burner);
    else if (burner && emptied) keys?.forget(burner.name);
    const given = new Set(giveUp.map(Number));
    const assets = wonAssets(order).map((a, k) => (putBack.includes(a) || given.has(k) || lost.has(a) ? null : a));
    return {
      order: orderAddress,
      won: order.won,
      assets,
      settled: signature,
      ...(signatures.length ? { parts: [...signatures, signature] } : {}),
      ...(assets.find(Boolean) ? { asset: assets.find(Boolean) } : {}),
      // What the settle passed over: not given (a stash's NFT won), not sent back (the NFT rolled on).
      ...(lost.size
        ? {
            gone: [...lost],
            says: 'The project no longer holds an NFT of this order (whoever controls its collection took it back or burned it): it was not given or sent back. Everything else settled as rolled.',
          }
        : {}),
    };
  }

  /**
   * A settle of `order` that failed (`e`): when a prize can't reach the player (their token account of its mint frozen by
   * the token's issuer; a collectible whose collection refuses the mint), an error that says so in words and names the
   * places in `won` they may give up (`giveUp`, for `collect`); otherwise `e` itself.
   */
  async function cannotReceive(order, e) {
    const from = Number(order.settled ?? 0);
    const stuck = [];
    for (const [k, won] of order.won.entries()) {
      if (k < from || !won.Tokens) continue;
      const account = await client.account(loot.ata(order.player, won.Tokens.mint, programOf(won.Tokens.mint)));
      // A token account's state is its byte 108: 2 is frozen.
      if (account && account.data?.[108] === 2) stuck.push(k);
    }
    // Core refusing the mint (a collection's plugin): the collectibles of the order are what it would not take.
    const core = (e?.logs ?? []).some(line => line.startsWith(`Program ${MPL_CORE} failed`));
    if (!stuck.length && core)
      for (const [k, won] of order.won.entries()) if (k >= from && won.Item?.serial != null) stuck.push(k);
    if (!stuck.length) return e;
    const err = new Error(
      `This order can't be settled as it is: ${stuck.length === 1 ? 'one prize' : `${stuck.length} prizes`} can't reach your wallet (a token account its issuer froze, or a collection that refuses the mint). Give ${stuck.length === 1 ? 'it' : 'them'} up to take the rest (collect again with giveUp: [${stuck.join(', ')}]): tokens given up stay in the project's vault, and a collectible given up is never made.`,
    );
    Object.assign(err, { giveUp: stuck, cause: e, logs: e?.logs });
    return err;
  }

  /**
   * For each prize an order won, what it is now: the collectible minted (`["asset", item, serial]`), the NFT handed
   * over; null for tokens. A normal item is the project's backend's to deliver.
   */
  function wonAssets(order) {
    return order.won.map(won => {
      if (won.Item) return loot.pda.itemAsset(loot.pda.item(project, won.Item.item), won.Item.serial);
      if (won.Nft) return won.Nft.nft;
      // A compressed NFT's asset id is the tree's count when it was minted: read from its settle's receipt or the
      // player's assets (`claims`), not from the order.
      return null;
    });
  }

  /** A nonce for an order no other order of the player's is at. */
  const freshNonce = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

  /** Each box of `ids`, decoded (null for one never written), by id. */
  async function boxesOf(ids) {
    const out = {};
    for (const id of new Set(ids)) out[id] = await readMaybe('LootBox', loot.pda.box(project, id));
    return out;
  }

  /** Each item a box's prizes name, decoded (null for one never written), by id: a fresh one's tables go with its roll. */
  async function itemsOf(box) {
    const out = {};
    for (const p of box.entries.flatMap(e => e.prizes)) {
      const id = p.Item?.[0] ?? p.Compressed?.item;
      if (id !== undefined && !(id in out)) out[id] = await readMaybe('Item', loot.pda.item(project, id));
    }
    return out;
  }

  /** The mint of each pool a box's tokens come from (null for a pool not opened). */
  async function poolMintsOf(box) {
    const prizePools = [
      ...new Set(
        box.entries
          .flatMap(e => e.prizes)
          .map(p => p.Tokens?.from.Pool?.[0])
          .filter(p => p !== undefined),
      ),
    ];
    const pools = prizePools.length ? await client.accounts(prizePools.map(p => loot.pda.pool(project, p))) : [];
    return Object.fromEntries(
      prizePools.map((p, i) => [p, pools[i] ? encodeBase58(pools[i].data.subarray(0, 32)) : null]),
    );
  }

  /** The instructions that ask the oracle for the roll of `order` (at `orderAddress`), `payer` paying it. Each prize
   * mint's token program is read from the mint when the app wasn't given it (`programs`): the ask opens the project's
   * vault of it. Its first ask fixes its odds (`loot.askReads`): it passes the order's player's profile when the box's
   * odds read one, and for a roll on no NFT, when they read an NFT, `shown` (an NFT the player holds, as `openBox` takes
   * it), or else the player's collectible of this project that raises them the most (`loot.bestShown`). */
  async function asksFor(payer, orderAddress, order, settler, shown = null) {
    const box = await read('LootBox', order.loot_box);
    const player = order.player ?? payer;
    if (!shown && loot.firstAsk(order, box) && loot.askReads(box, order).nft && player === wallet?.address)
      shown = loot.bestShown(box, await owned(player)).best;
    const poolMints = await poolMintsOf(box);
    const mints = [
      ...Object.values(poolMints),
      ...box.entries.flatMap(e => e.prizes.map(p => p.Tokens?.from.Mint?.[0])),
    ].filter(x => x && !programs[x]);
    const owners = mints.length ? await client.accounts(mints) : [];
    const known = { ...programs, ...Object.fromEntries(mints.map((x, i) => [x, owners[i]?.owner ?? TOKEN_PROGRAM])) };
    return loot.askRollIx({
      payer,
      orderAddress,
      order: { ...order, player },
      box,
      settler,
      shown,
      poolMints,
      items: await itemsOf(box),
      programs: known,
    });
  }

  /** Asks the oracle for a roll a mission, a recipe or a prize made (`Waiting`): the player pays the oracle. `shown`: an
   * NFT the player shows for the box's odds at its first ask (by default the one of theirs that raises them most). */
  async function askRoll(orderAddress, { shown = null } = {}) {
    return send([
      computeUnitLimit(400_000),
      ...(await asksFor(wallet.address, orderAddress, await read('Order', orderAddress), undefined, shown)),
    ]);
  }
  return Object.assign(ctx, { prizeInputs, sendRolling, collect, freshNonce, itemsOf, poolMintsOf, asksFor, askRoll });
}
