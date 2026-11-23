// Recipes and holds: crafting, and holding an NFT.
import { NO_ADDRESS } from '../../chain/base58.js';
import { toBigInt } from '../../chain/bytes.js';
import { TOKEN_PROGRAM } from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import { ata, MPL_CORE_PROGRAM, pda } from '../pda.js';
import { ascending, NO_OPTIONS, ONLY_MOVES, tokenProgramOf, treasuryAccounts, withPrograms } from './shared.js';
import { lootIx, reference, tailOf } from './base.js';
import { destinationAccounts, limitAccounts, namedRollNonce, prizeMetas } from './tail.js';
import { anotherMetas, nftPaid, piece, tokenMetadata } from './piece.js';

// ---------------------------------------------------------------- recipes and holds

/**
 * `player` crafts recipe `id` (`recipe` decoded, the version shown to them), `times` over. `assets`: the
 * collectibles handed in, in the recipe's order (the burned, the used, and for a `Show` line the NFT shown: its address
 * when it is the project's, `{ asset, collection }` for a Core NFT of another collection, `{ mint, owner }` for a Token
 * Metadata one, `{ compressed, tree }` for a compressed one; with `farm` (a farm's id: `{ asset, farm }` for the
 * project's own) when the project locks it in the player's wallet on a seat of that farm, which freezes, and a raise on
 * it lowers a number: its seat and farm follow it, and the raise may not lower a number that farm reads; for a `Trade` line the NFT traded in, as `piece` takes it: `{ asset, collection, tokenMetadata,
 * compressed }`). A collectible used that is staked in a farm holding it for the player (escrow) or locking it in their
 * wallet (freeze) is `{ asset, farm }`, `farm` that farm's id: its seat and farm follow it (a raise on it may not lower a
 * number its farm reads: `BadRecipe`). One that boosts the player's token seat in a farm of tokens is
 * `{ asset, farm, booster: true }`: the player's token seat (`["seat", farm, player]`) and that farm follow it, on a kept
 * `Use` line or a `Show` line alike. A `Staked` line names the farm its collectible
 * is staked in (`Input::Staked { item, farm }`, escrowed or frozen there): its address, or `{ asset, farm }` with that
 * farm, and its seat and that farm follow it. Each item line passes its item's collection
 * (`items[id].collection`, the decoded Items; `collection` when not given), written for a burn: Core writes it as it
 * burns a collectible. A recipe's `raises` write on the kept ones, in their Sheet when the project has no
 * authority over them. The player opens any account a line pays into that is not there. A roll it makes (a
 * `Prize::Roll` or a `RollOn`) passes its box and its order, nothing more. A recipe may give several rolls: each is at
 * the craft's `nonce` plus the rolls before it in the recipe's order (`craftRollNonces`); a `RollOn`'s order is where
 * `namedRollNonce` says of that, which reads the rolled box (`boxes`: a box's id to its decoded LootBox). Its player or
 * the project's keys then ask for the roll (`askRollIx`, in the same transaction when it fits).
 * A payment line nobody can take goes to the treasury (`Crafted.to_treasury`): a collectible nobody holds or the project
 * holds (`holders`: who holds each now, as read when building; if it changes hands before the craft lands, the craft
 * fails cleanly), the project's own address, or an address `lootAccounts` names (wallets read as accounts of the loot
 * program). The treasury's wallet and its account then follow that line's accounts (`treasury`).
 * A craft makes several Core calls: raise the compute limit. `extra`: a token's hook accounts.
 */
export function craftIx({
  player,
  project,
  collection,
  id,
  recipe,
  assets = [],
  times = 1,
  nonce = 0n,
  holders,
  programs,
  treasury,
  poolMints,
  items = {},
  nfts = {},
  boxes = {},
  lootAccounts = [],
  extra = [],
  person = null,
}) {
  const remaining = [];
  const given = [...assets];
  const tokens = mint => ata(player, mint, tokenProgramOf(programs, mint));
  const itemLine = (itemId, burns = false) => [
    meta(pda.item(project, itemId), false, false),
    meta(items[itemId]?.collection ?? collection, false, burns),
  ];
  for (const input of recipe.inputs) {
    if (input.Burn) {
      remaining.push(...itemLine(input.Burn.item, true));
      for (let i = 0; i < input.Burn.count; i++)
        remaining.push(meta(take(given, 'a collectible to burn'), false, true));
    } else if (input.Use || input.Staked) {
      remaining.push(...itemLine((input.Use ?? input.Staked).item));
      const used = take(given, 'a collectible to use');
      // A staked one is on its seat in the farm its line names.
      if (
        input.Staked &&
        typeof used !== 'string' &&
        used.farm !== undefined &&
        Number(used.farm) !== input.Staked.farm
      )
        throw new Error(
          `craft: the recipe takes this collectible staked in farm ${input.Staked.farm}, not farm ${used.farm}`,
        );
      // A booster of a token seat is on the player's seat, not one of its own: a `Staked` line refuses it (NotFarmed).
      if (input.Staked && used?.booster)
        throw new Error(
          `craft: the recipe takes a collectible staked on a seat of its own in farm ${input.Staked.farm}; one boosting a token seat is taken by a kept line ("use")`,
        );
      const seated = input.Staked
        ? { asset: typeof used === 'string' ? used : used.asset, farm: input.Staked.farm }
        : used;
      if (typeof seated === 'string') remaining.push(meta(seated, false, true));
      else {
        // On a seat: its seat (its own, or the player's token seat it boosts) and its farm follow it.
        const farm = pda.farm(project, seated.farm);
        remaining.push(
          meta(seated.asset, false, true),
          meta(pda.seat(farm, seated.booster ? player : seated.asset), false, false),
          meta(farm, false, false),
        );
      }
    } else if (input.Pay) {
      const { mint, to } = input.Pay;
      if (!treasury && paysNowhere(project, to, { holders, lootAccounts }))
        throw new Error(
          "craft: a payment line nobody can take goes to the project's treasury: pass its wallet (`treasury`).",
        );
      remaining.push(
        meta(mint, false, true),
        meta(tokens(mint), false, true),
        ...destinationAccounts(project, to, mint, { holders, programs, treasury }),
        // A line nobody can take goes to the treasury: its wallet and its account follow the line's own.
        ...(paysNowhere(project, to, { holders, lootAccounts }) ? treasuryAccounts(treasury, mint, programs) : []),
      );
    } else if (input.Trade) {
      // Any NFT of the line's collection, traded in: burned, given on or stashed (`nftPaid`).
      const nft = take(given, 'an NFT to trade in');
      remaining.push(
        ...nftPaid({
          project,
          owner: player,
          then: input.Trade.then,
          ...(typeof nft === 'string' ? { asset: nft, collection: input.Trade.collection } : nft),
        }),
      );
    } else if (input.Show) {
      // Any NFT, kept: one of the project's (its address), a Core asset of another collection ({ asset, collection }:
      // with its Sheet, then its collection), a Token Metadata NFT ({ mint, owner }: its metadata, the holder's
      // token account and its Sheet), or a compressed NFT ({ compressed, tree }: its record, proven earlier in the
      // transaction, its tree and its Sheet). What a raise writes on is writable.
      // One the project locks in the player's wallet on a seat of a farm that freezes (`farm`, that farm's id) has its
      // seat and farm after its accounts, when a raise on it lowers a number.
      const place = assets.length - given.length;
      const nft = take(given, 'an NFT to show');
      if (typeof nft === 'string' || (nft.asset && nft.farm !== undefined && !('collection' in nft)))
        remaining.push(meta(nft.asset ?? nft, false, true), meta(input.Show.collection, false, false));
      else if (nft.asset)
        remaining.push(
          meta(nft.asset, false, true),
          meta(pda.sheet(project, nft.asset), false, true),
          meta(nft.collection ?? MPL_CORE_PROGRAM, false, false),
        );
      else if (nft.compressed)
        remaining.push(
          ...[nft.compressed, pda.leaf(nft.compressed), nft.tree].map(key => meta(key, false, false)),
          meta(pda.sheet(project, nft.compressed), false, true),
        );
      else
        remaining.push(
          ...[nft.mint, tokenMetadata.metadata(nft.mint), ata(nft.owner ?? player, nft.mint, TOKEN_PROGRAM)].map(key =>
            meta(key, false, false),
          ),
          meta(pda.sheet(project, nft.mint), false, true),
        );
      const lowers = (recipe.raises ?? []).some(raise => Number(raise.place) === place && BigInt(raise.shift.by) < 0n);
      if (lowers && typeof nft !== 'string' && nft.farm !== undefined && nft.farm !== null) {
        const farm = pda.farm(project, nft.farm);
        remaining.push(
          meta(pda.seat(farm, nft.booster ? player : (nft.asset ?? nft.compressed ?? nft.mint)), false, false),
          meta(farm, false, false),
        );
      }
    }
  }
  const made = {};
  // Each roll the recipe gives (a `Prize::Roll` or a `RollOn`) is at the craft's nonce plus the rolls before it, in the
  // recipe's order: the first at `nonce`, the next at `nonce + 1`.
  let rolls = 0n;
  const nextRoll = () => BigInt.asUintN(64, toBigInt(nonce) + rolls++);
  for (const output of recipe.outputs) {
    if (output.Prize) {
      // A prize (`prizeMetas`): collectibles of one item made in order, each at the next serial.
      const prize = output.Prize[0];
      const item = prize.Item?.[0];
      remaining.push(
        ...prizeMetas({
          project,
          collection,
          prize,
          winner: player,
          nonce: prize.Roll ? nextRoll() : nonce,
          poolMints,
          items,
          nft: nfts[prize.Nft?.nft],
          made: made[item] ?? 0,
          programs,
        }),
      );
      if (item !== undefined) made[item] = (made[item] ?? 0) + 1;
    } else if (output.RollOn) {
      // The box, then the order its roll is made in (`namedRollNonce` of its nonce: on an NFT its box holds, that NFT's
      // own, though it still counts in the numbering).
      const on = assets[output.RollOn.place];
      const order = pda.order(
        project,
        player,
        namedRollNonce(
          boxes[output.RollOn.box_id],
          typeof on === 'string' ? on : (on?.asset ?? on?.mint ?? on?.compressed),
          nextRoll(),
        ),
      );
      remaining.push(meta(pda.box(project, output.RollOn.box_id), false, false), meta(order, false, true));
    }
  }
  const address = pda.recipe(project, id);
  return lootIx(
    'craft',
    { version: recipe.version, times, nonce },
    { player, project, recipe: address, ...limitAccounts(project, player, recipe.per_wallet, person) },
    { remaining: [...remaining, ...tailOf(extra)] },
  );
}

/**
 * Whether a payment to `to` finds nobody to take it (`rail::Target::Nowhere`), so a recipe's line goes to the treasury:
 * a collectible nobody holds, or the project holds (`holders`: who holds each now); a wallet that is the project's own
 * address or an account of the loot program (`lootAccounts`, as read). A pool or a token account always takes it.
 */
export function paysNowhere(project, to, { holders = {}, lootAccounts = [] } = NO_OPTIONS) {
  const program = wallet => wallet === project || lootAccounts.includes(wallet);
  if (to?.Wallet) return program(to.Wallet[0]);
  if (to?.Holder) {
    const holder = holders[to.Holder[0]];
    return !holder || holder === NO_ADDRESS || program(holder);
  }
  return false;
}

/**
 * The nonce each roll a craft of `recipe` makes is named at, in the recipe's outputs' order: [{ output, nonce }], the
 * first at `nonce`, each next one more. A `RollOn` on an NFT its box holds is made at that NFT's own nonce
 * (`namedRollNonce`), but counts all the same.
 */
export function craftRollNonces(recipe, nonce = 0n) {
  let k = 0n;
  return recipe.outputs.flatMap((output, i) =>
    output.RollOn || output.Prize?.[0]?.Roll ? [{ output: i, nonce: BigInt.asUintN(64, toBigInt(nonce) + k++) }] : [],
  );
}

function take(list, what) {
  if (!list.length) throw new Error(`craft: missing ${what}`);
  return list.shift();
}

/** The collectibles a craft of `recipe` makes: one per `Item` prize among its outputs. */
export const craftNewAssets = recipe => recipe.outputs.filter(o => o.Prize?.[0]?.Item).length;

/**
 * `player` hands an NFT to the project until `freeAt` (Unix seconds; the hold's address names it, `pda.hold`): a Core
 * asset (`collection` its own, Core's address for none), a Token Metadata NFT (`tokenMetadata`), or `compressed` (after
 * a `proveLeafIx`).
 */
export function holdIx({
  player,
  project,
  collection,
  asset,
  tokenMetadata: tm,
  compressed,
  freeAt,
  reference: ref,
  more = [],
}) {
  // Several NFTs (`more`: each { asset, collection, tokenMetadata, compressed }) go on holds of their own with one end, one
  // fee: by their holds' addresses, the first the call's own.
  const [first, ...rest] = ascending(
    [{ asset, collection, tokenMetadata: tm, compressed }, ...more].map(n => {
      const p = piece({
        project,
        asset: n.asset,
        wallet: player,
        collection: n.collection,
        tokenMetadata: n.tokenMetadata,
        compressed: n.compressed,
        ...ONLY_MOVES,
      });
      return { p, hold: pda.hold(p.accounts.asset, freeAt) };
    }),
    x => x.hold,
  );
  const p = withPrograms(
    first.p,
    rest.map(x => x.p),
  );
  const groups = rest.flatMap(x => [meta(x.hold, false, true), ...anotherMetas(x.p)]);
  return lootIx(
    'hold',
    { free_at: toBigInt(freeAt), reference: reference(ref) },
    { player, project, ...p.accounts, hold: first.hold },
    { remaining: [...p.proof, ...groups], writable: p.writable },
  );
}
