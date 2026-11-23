// The shop and the boxes, for the page client (solanaApp): what is for sale and at what price, a box bought at once or
// opened (its roll asked for and settled in the same prompt), an order collected, recovered or refunded.
import { encodeBase58, NO_ADDRESS } from '../chain/base58.js';
import { associatedTokenAddress, COMPUTE_BUDGET_PROGRAM, NATIVE_MINT, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, createAssociatedTokenAccountIdempotent, withSolWrap } from '../chain/programs.js';
import { compileFitting, transactionLocks } from '../chain/lookup.js';
import { SIGNATURE_LAMPORTS } from '../chain/tx.js';
import * as loot from '../client/index.js';
import { freshKey, MPL_CORE, only, show } from './common.js';

/**
 * The shop and box methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function boxMethods(ctx) {
  const {
    spec,
    wallet,
    programs,
    sponsor,
    client,
    project,
    keys,
    jobKey,
    tokens,
    currencyKey,
    decimalsOf,
    programOf,
    part,
    read,
    personFor,
    collectionOf,
    nftOf,
    leaving,
    prizeInputs,
    projectNow,
    auctionAt,
    passing,
    listProofOf,
    send,
    keyFor,
    dryRun,
    emptyKey,
    sendRolling,
    collect,
    freshNonce,
    itemsOf,
    poolMintsOf,
    askRoll,
    slotNow,
    chainNow,
    clearLeftovers,
    closesFirst,
    holdersOf,
  } = ctx;

  /**
   * The most the player agreed to pay for `box`, in base units: `maxPrice` (base units), or the `listing` that
   * `shop()` or `boxes()` showed them (its `priceUnits`). Never the price read now: a price the owner or other buyers
   * moved since the player saw it would be paid without their say. A price above it is refused here, in words, before
   * the wallet is asked.
   */
  function boundOf(box, name, { maxPrice, listing } = {}, key) {
    if (listing && key !== undefined && listing.key !== undefined && listing.key !== key)
      throw new Error(`That listing is “${listing.key}”, not “${key}”.`);
    const given = maxPrice ?? listing?.priceUnits;
    if (given === undefined || given === null)
      throw new Error(
        `Say the most the player agreed to pay for “${name}”: pass the listing shop() or boxes() showed (listing), or maxPrice in base units. The price read now is never the bound.`,
      );
    const bound = BigInt(given);
    if (BigInt(box.price) > bound)
      throw new Error(
        `The price of “${name}” is now ${show(box.price, decimalsOf(box.currencyKey))}, more than the ${show(bound, decimalsOf(box.currencyKey))} the player was shown: show them the new price first.`,
      );
    return bound;
  }
  /** What `buy` and `openBox` take: a box bought at once (`buyBox`) or opened (`open`). */
  const BOX_OPTIONS = [
    'shown',
    'listProof',
    'maxPrice',
    'listing',
    'chosenRecipient',
    'on',
    'oneSignature',
    'count',
    'acceptLeftover',
  ];

  /**
   * Buys `count` of a box that needs no roll (a shop item, a bundle, a fixed pack: one entry, nothing random, no NFT
   * rolled on) in one transaction: the price is split and every prize given at once, once for each draw of each, with
   * no order to settle. A roll the box gives (`Prize::Roll`) is asked for in the same transaction and settled by a
   * throwaway key after (`sendRolling`: still one prompt). `shown` (an NFT for its gate), `listProof` (for a list gate),
   * `chosenRecipient` (the wallet, or collectible, a share the box lets the buyer name goes to). Returns { signature,
   * assets }: for each prize given, the collectible minted or the NFT given (null for tokens or a normal item), and for
   * a roll the order it is made in; with `rolls`, what each roll gave. `orNull`: a pack (more than one draw in all)
   * whose purchase doesn't fit one legacy transaction, or the instruction trace, returns null, sending nothing.
   */
  async function buyBox(
    boxId,
    part,
    { shown = null, listProof, maxPrice, listing, chosenRecipient = null, count = 1, orNull = false } = {},
  ) {
    const g = await projectNow();
    const box = await read('LootBox', loot.pda.box(project, boxId));
    if (!Number.isInteger(count) || count < 1) throw new Error('Buy a whole number, one at least (count).');
    // One `buy` prices at most so many sales (`PackTooLarge` past it): more is several purchases.
    if (count > loot.MOST_SALES_A_BUY)
      throw new Error(
        `One purchase buys at most ${loot.MOST_SALES_A_BUY.toLocaleString('en-US')} (count): buy the rest in another.`,
      );
    const bound =
      boundOf({ ...box, currencyKey: part?.currency }, part?.name ?? `box ${boxId}`, { maxPrice, listing }, part?.key) *
      BigInt(count);
    shown ??= await passing(box.gate, 'buy this');
    listProof = listProofOf(box.gate, part?.gate?.list, listProof);
    const mint = box.currency;
    const [entry] = box.entries;
    const given = await prizeInputs(entry.prizes);
    const nonce = freshNonce();
    const choosesHolder = box.shares.some(s => s.to.Chosen && s.to.Chosen.item != null);
    const holders = await holdersOf(loot.chosenShares(box.shares, chosenRecipient));
    const linked = await personFor(box.per_wallet);
    const ix = loot.buyIx({
      player: wallet.address,
      project,
      box,
      person: linked.person,
      maxPrice: bound,
      count,
      treasury: g.treasury,
      chosenRecipient,
      chosen: choosesHolder ? chosenRecipient : null,
      nonce,
      shown,
      listProof,
      items: given.items,
      poolMints: given.poolMints,
      nfts: given.nfts,
      holders,
      programs,
    });
    const made = {};
    const gives = loot.buyGives(box, count);
    const assets = gives.map(({ prize, k }) => {
      if (prize.Item) {
        const id = prize.Item[0];
        const item = given.items[id];
        made[id] = (made[id] ?? 0) + 1;
        return item?.kind === 'Collectible'
          ? loot.pda.itemAsset(loot.pda.item(project, id), Number(item.issued) + made[id])
          : null;
      }
      if (prize.Nft) return prize.Nft.nft;
      if (prize.Roll) return loot.pda.order(project, wallet.address, loot.prizeRollNonce(nonce + BigInt(k)));
      return null;
    });
    const rollsMade = gives.filter(x => x.prize.Roll).length;
    const instructions = withSolWrap(wallet.address, mint, bound, [
      computeUnitLimit(rollsMade || gives.length > 2 ? 1_400_000 : 600_000),
      ...given.before.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ...linked.ixs,
      ix,
    ]);
    if (orNull && gives.length > 1) {
      const fits =
        compileFitting({ payer: wallet.address, blockhash: NO_ADDRESS, instructions }) &&
        transactionLocks(wallet.address, instructions) <= 64;
      if (!fits || !(await dryRun(wallet.address, instructions)).ok) return null;
    }
    const { signature, rolls } = rollsMade
      ? await sendRolling(instructions)
      : { signature: await send(instructions), rolls: [] };
    return {
      signature,
      assets,
      ...(assets.find(Boolean) ? { asset: assets.find(Boolean) } : {}),
      ...(rolls.length ? { rolls } : {}),
    };
  }

  /**
   * Opens a box that rolls. `oneSignature` (the default): the same transaction funds a throwaway key with its settle's
   * fee, and makes the player's account of each mint the box's tokens are in, so the settle needs no second wallet
   * prompt. `chosenRecipient`: the wallet (or collectible) the player names for a share the box lets them choose (a
   * referrer, a plot). `on`: the NFT a box that rolls on one takes (an NFT whose price it is, a sword to enchant).
   * `listProof`: for a list gate.
   */
  async function open(
    boxId,
    part,
    {
      shown = null,
      on = null,
      maxPrice,
      listing,
      oneSignature = !sponsor,
      chosenRecipient = null,
      listProof,
      count = 1,
      acceptLeftover,
    } = {},
  ) {
    const g = await projectNow();
    const box = await read('LootBox', loot.pda.box(project, boxId));
    // `count` packs in one purchase: one wallet prompt, one oracle answer, each at the price the one before it left.
    if (!Number.isInteger(count) || count < 1) throw new Error('Open a whole number of packs, one at least (count).');
    const bound =
      boundOf({ ...box, currencyKey: part?.currency }, part?.name ?? `box ${boxId}`, { maxPrice, listing }, part?.key) *
      BigInt(count);
    // Each item a prize names: a fresh one's tables go with the purchase.
    const items = await itemsOf(box);
    // A box that rolls on an NFT takes the one the player brings (`on`), whatever its kind.
    if (box.subject && !on) throw new Error('This box rolls on an NFT: say which (on).');
    // A box that burns it, gives it away or moves its numbers takes it into the project's hands until the roll settles.
    // What an earlier owner of it left in the project is cleared first (`clearLeftovers`).
    const clears = box.subject && loot.boxHolds(box) ? await clearLeftovers(on, acceptLeftover) : [];
    const brought = box.subject ? await nftOf(on) : { before: [] };
    const { before: proving, hasAuthority, ...kind } = brought;
    const subject = box.subject
      ? { asset: on, hasAuthority, ...kind, collection: kind.collection ?? (await collectionOf(on)) ?? MPL_CORE }
      : undefined;
    if (!box.subject) shown ??= await passing(box.gate, 'buy this');
    listProof = listProofOf(box.gate, part?.gate?.list, listProof);
    const mint = box.currency;
    // A roll that moves the numbers of the NFT it rolls on is at that NFT's nonce: one at a time on it.
    const nonce = box.subject && loot.boxHolds(box) ? loot.nonceOn(on) : freshNonce();
    // Each pool's mint, and each mint tokens are minted from: what is won waits in the project's vault for its mint.
    const poolMints = await poolMintsOf(box);
    const minted = box.entries
      .flatMap(e => e.prizes)
      .map(p => p.Tokens?.from.Mint?.[0])
      .filter(Boolean);
    const prizeMints = [...new Set([...Object.values(poolMints).filter(Boolean), ...minted])];
    const choosesHolder = box.shares.some(s => s.to.Chosen && s.to.Chosen.item != null);
    const chosen = chosenRecipient && choosesHolder ? chosenRecipient : null;
    // A purchase of more opens than one order takes (`loot.opensAnOrder`: what one oracle answer draws, and an order's
    // rent and fee within 0.01 SOL) is several orders, each its own answer, all in this one transaction: one prompt.
    const each = loot.opensAnOrder(box, { items });
    // A limit by person: the person, and the steps that link the wallet first when it is linked in this one.
    const linked = await personFor(box.per_wallet);
    const orders = [];
    for (let left = count, k = 0n; left > 0; left -= each, k++) {
      const n = Math.min(each, left);
      // Its key, named by the order as its settler (made again after a reload: `recover`), when the settle needs no prompt.
      const settlerKey = oneSignature
        ? ((await jobKey(loot.pda.order(project, wallet.address, nonce + k))) ?? (await freshKey()))
        : null;
      orders.push({
        nonce: nonce + k,
        n,
        settlerKey,
        ix: loot.openBoxIx({
          settler: settlerKey?.address,
          player: wallet.address,
          project,
          box,
          person: linked.person,
          nonce: nonce + k,
          maxPrice: (bound / BigInt(count)) * BigInt(n),
          count: n,
          items,
          shown,
          listProof,
          subject,
          chosenRecipient,
          chosen,
          poolMints,
          programs,
        }),
      });
    }
    const before = [
      ...proving,
      createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, mint, programOf(mint)),
      ...linked.ixs,
    ];
    // (A compressed NFT's proof brings its own compute limit, the transaction's only one.)
    let solPrize = false;
    if (oneSignature) {
      // The player opens here every account the settle will pay into (their prize's, and each wallet a share of the
      // sale pays: a referrer, a plot's holder, the treasury), so the burner's settle opens none of them.
      for (const prizeMint of prizeMints) {
        solPrize ||= prizeMint === NATIVE_MINT;
        before.push(
          createAssociatedTokenAccountIdempotent(wallet.address, wallet.address, prizeMint, programOf(prizeMint)),
        );
      }
      const shares = loot.chosenShares(box.shares, chosenRecipient);
      const holders = await holdersOf(shares);
      const payees = shares.flatMap(s =>
        s.to === 'Treasury'
          ? [g.treasury]
          : s.to.Wallet
            ? [s.to.Wallet[0]]
            : s.to.Holder && holders[s.to.Holder[0]]
              ? [holders[s.to.Holder[0]]]
              : [],
      );
      const paid = new Set([g.treasury, ...payees]);
      for (const payee of paid)
        before.push(createAssociatedTokenAccountIdempotent(wallet.address, payee, mint, programOf(mint)));
      // A sale that pays the player themselves (the owner buying from their own shop) pays into their wrapped-SOL
      // account: it stays open for the settle too.
      solPrize ||= mint === NATIVE_MINT && paid.has(wallet.address);
    }
    // Each order's burner, named by the order (made again after a reload: `recover`), holds the fee of each settle part
    // its order may take (`settleParts`) and of its give-back, and what its settle may mint or open (`settleRent`: the
    // order lends nothing); it gives back what it doesn't use.
    const addresses = orders.map(o => loot.pda.order(project, wallet.address, o.nonce));
    const burners = [];
    const after = [];
    if (oneSignature) {
      for (const o of orders) {
        const { key, fund } = await keyFor(
          SIGNATURE_LAMPORTS * BigInt(loot.settleParts(box, o.n) + 1) + loot.settleRent(box, o.n, items),
          o.settlerKey,
        );
        burners.push(key);
        after.push(fund);
      }
    }
    // A SOL prize, or a share of the sale, lands in the player's wrapped-SOL account, which the prompt-less settle
    // can't open: it stays open, and the player's next transaction unwraps it.
    let instructions = withSolWrap(wallet.address, mint, BigInt(box.price) * BigInt(count), [
      ...before,
      ...orders.map(o => o.ix),
      ...after,
    ]);
    if (solPrize)
      instructions = instructions.filter(
        x =>
          !(
            x.programId === TOKEN_PROGRAM &&
            x.data?.[0] === 9 &&
            x.keys[0]?.pubkey === associatedTokenAddress(wallet.address, NATIVE_MINT)
          ),
      );
    const signature = await send(await closesFirst(clears, instructions), [], { keepWrapped: solPrize });
    // The slot it landed in: the order is read from a node that has seen it (a load-balanced RPC's node lagging
    // behind answers nothing for an order just opened).
    const landed = (await client.signatureStatus?.(signature).catch(() => null))?.slot ?? null;
    return {
      signature,
      orderAddress: addresses[0],
      orderAddresses: addresses,
      burner: burners[0] ?? null,
      burners,
      landed,
    };
  }

  /** A box bought at once when it needs no roll (`buyBox`: a shop item, a bundle, a fixed pack of any count), or
   * opened and collected: one that rolls, gives a fresh item (its traits are rolled), or rolls on an NFT. A fixed pack
   * too big for one transaction is opened instead (the oracle answers it like any box). */
  async function buyOrOpen(boxId, part, options) {
    const box = await read('LootBox', loot.pda.box(project, boxId));
    if (!loot.boxRolls(box.entries) && !box.subject && !loot.boxFresh(box.entries, await itemsOf(box))) {
      const { on: _on, oneSignature: _one, ...buying } = options ?? {};
      const bought = await buyBox(boxId, part, { ...buying, orNull: true });
      if (bought) return bought;
    }
    const { orderAddresses, burners, landed } = await open(boxId, part, options);
    if (orderAddresses.length === 1)
      return collect(orderAddresses[0], { burner: burners[0] ?? null, opened: true, landed });
    // Several orders of one purchase: each collected in turn by its own burner.
    const got = [];
    for (const [k, address] of orderAddresses.entries())
      got.push(await collect(address, { burner: burners[k] ?? null, opened: true, landed }));
    return {
      ...got.at(-1),
      orders: got,
      won: got.flatMap(g => g.won ?? []),
      assets: got.flatMap(g => g.assets ?? []),
      parts: got.flatMap(g => g.parts ?? [g.settled]),
    };
  }

  return {
    /**
     * The shop: every item with a price (or free), its price now and what is left.
     * @returns {Promise<any[]>}
     */
    async shop() {
      const items = (spec.items ?? []).filter(it => Number.isInteger(it.shopBox));
      const accounts = await client.accounts(
        items.flatMap(it => [loot.pda.box(project, it.shopBox), loot.pda.item(project, it.id)]),
      );
      return items.map((it, i) => {
        const box = accounts[2 * i] && loot.decode('LootBox', accounts[2 * i].data);
        const item = accounts[2 * i + 1] && loot.decode('Item', accounts[2 * i + 1].data);
        const dec = decimalsOf(currencyKey);
        return {
          key: it.key,
          name: it.name,
          price: box ? show(box.price, dec) : null,
          priceUnits: box?.price ?? null,
          currency: tokens.get(currencyKey)?.symbol ?? currencyKey,
          active: Boolean(box?.active && item?.active),
          left: item?.max_supply ? item.max_supply - item.issued : null,
        };
      });
    },

    /**
     * The boxes: price now, each outcome's chance as written, and what the box does once an outcome runs out
     * (`whenOut`: 'stopSales', it isn't sold until restocked; 'drawLeft', it draws among what is left).
     * @returns {Promise<any[]>}
     */
    async boxes() {
      const list = spec.boxes ?? [];
      const accounts = await client.accounts(list.map(b => loot.pda.box(project, b.id)));
      return list.map((b, i) => {
        const box = accounts[i] && loot.decode('LootBox', accounts[i].data);
        const total = box ? box.entries.reduce((n, e) => n + e.weight, 0) : 0;
        return {
          key: b.key,
          name: b.name,
          price: box ? show(box.price, decimalsOf(b.currency)) : null,
          priceUnits: box?.price ?? null,
          currency: tokens.get(b.currency ?? currencyKey)?.symbol,
          active: Boolean(box?.active),
          whenOut: box?.when_out === 'DrawLeft' ? 'drawLeft' : 'stopSales',
          outcomes: (b.outcomes ?? []).map((o, j) => ({
            ...o,
            chancePercent: box ? (100 * box.entries[j].weight) / total : o.chance,
          })),
        };
      });
    },

    /**
     * Buys a shop item, in one transaction (`buy`: the price split and the item given at once). A listing that rolls
     * (an NFT at random, or one it rolls on) is opened and settled instead. Returns { signature, assets, asset } for a
     * purchase, or what `collect` returns for an open.
     */
    async buy(itemKey, options = {}) {
      only(options, BOX_OPTIONS, 'buy');
      const it = part('items', itemKey);
      if (!Number.isInteger(it.shopBox)) throw new Error(`“${it.name}” is not in the shop.`);
      return buyOrOpen(it.shopBox, it, options);
    },

    /**
     * Opens a box (shows a collectible for its gate or odds when given): a box that needs no roll is bought at once
     * (`buy`); one that rolls waits for the roll and collects it, settling a pack in as many parts as it needs. `count`
     * opens several packs in one purchase: one wallet prompt and one oracle answer (`maxPrice` is a pack's).
     */
    async openBox(boxKey, options = {}) {
      only(options, BOX_OPTIONS, 'openBox');
      const b = part('boxes', boxKey);
      return buyOrOpen(b.id, b, options);
    },

    /** Collects an order opened earlier (its roll arrived after the app stopped waiting). */
    collect,

    /**
     * Finds the settle keys a page that closed left holding the player's SOL, and finishes their jobs: a key whose order
     * has rolled settles it (no prompt); one whose order is gone, failed or due its refund sends its SOL back; one whose
     * order still waits for its roll keeps it for later. Each key is made again from the wallet's signature (asked once
     * a session, `walletStandardSigner`'s `signMessage`), or read from the page's storage (`keyStore`) when the wallet
     * signs no messages. Returns [{ name, key, settled } | { name, key, swept } | { name, key, waiting }].
     */
    async recover() {
      if (!keys) throw new Error('Connect a wallet first.');
      const me = wallet.address;
      const tag = t => ({ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(loot.TAGS[t])) } });
      const at = (offset, bytes) => ({ memcmp: { offset, bytes } });
      const orders = new Map();
      for (const { pubkey, account } of await client.programAccounts(loot.lootProgram(), [
        tag('Order'),
        at(1, project),
        at(33, me),
      ]))
        orders.set(pubkey, loot.decode('Order', account.data));
      const holds = (await client.programAccounts(loot.lootProgram(), [tag('Hold'), at(1, project), at(65, me)])).map(
        h => h.pubkey,
      );
      // Keys are named by an order of the wallet's, a hold (a loan's release), or an auction (the releases after its end).
      const names = [
        ...new Set([...orders.keys(), ...holds, ...(spec.auctions ?? []).map(a => auctionAt(a)), ...keys.stored()]),
      ];
      if (!names.length) return [];
      const made = (await Promise.all(names.map(name => keys.again(name)))).filter(Boolean);
      const held = made.length ? await client.accounts(made.map(k => k.address)) : [];
      const [slot, time] = [await slotNow(), await chainNow()];
      const out = [];
      for (const [i, key] of made.entries()) {
        const lamports = BigInt(held[i]?.lamports ?? 0);
        if (lamports === 0n) {
          keys.forget(key.name);
          continue;
        }
        const order = orders.get(key.name);
        const due = order ? loot.orderRefundable(order, slot, time) : false;
        if (order?.status === 'Rolled' && slot > BigInt(order.requested_slot) && !due) {
          const got = await collect(key.name, { burner: key }).catch(e => ({ error: e.message }));
          out.push({
            name: key.name,
            key: key.address,
            ...(got.error ? { error: got.error } : { settled: got.settled, won: got.won }),
          });
        } else if (order && ['Pending', 'Asked', 'Waiting'].includes(order.status) && !due) {
          out.push({ name: key.name, key: key.address, waiting: order.status });
        } else {
          await emptyKey(key);
          out.push({ name: key.name, key: key.address, swept: lamports });
        }
      }
      return out;
    },

    /** Gives an order's payment back once its time has come (a roll that failed or never came). An NFT the project
     * held for the roll goes back with it; one it no longer holds (its collection took it back or burned it) is not
     * looked for, and the whole payment goes back all the same. */
    async refund(orderAddress) {
      const order = await read('Order', orderAddress);
      // An NFT the project held for the roll goes back.
      const {
        before = [],
        hasAuthority: _,
        gone: _gone,
        ...subject
      } = order.held ? await leaving(order.subject, wallet.address, { to: order.player }) : {};
      return send([...before, loot.refundIx({ signer: wallet.address, orderAddress, order, subject, programs })]);
    },

    /** Asks the oracle for a roll a mission, a recipe or a prize made (its player or the project's keys may; the asker
     * pays the oracle). Its first ask fixes its odds: the player's profile, and an NFT they show (`shown`; by default
     * their collectible that raises the box's odds the most), count then. On a box with nothing in stock only the order's
     * player may ask, a slot after it was made or last asked, and that ends the roll there with nothing, no oracle (a lot
     * its winner paid for fails, for its refund). */
    askRoll: (orderAddress, options = {}) => {
      only(options, ['shown'], 'askRoll');
      return askRoll(orderAddress, options);
    },
  };
}
