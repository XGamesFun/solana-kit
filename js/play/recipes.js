// Recipes, for the page client (solanaApp): the recipes and their versions now, and a craft.
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, withSolWrap } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { MPL_CORE, NO_OPTIONS, only } from './common.js';

/**
 * The recipe methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function recipeMethods(ctx) {
  const {
    spec,
    wallet,
    programs,
    client,
    project,
    collections,
    ours,
    part,
    read,
    readMaybe,
    personFor,
    collectionOf,
    nftOf,
    prizeInputs,
    projectNow,
    escrowedIn,
    lockedIn,
    sendRolling,
    freshNonce,
    holdersOf,
  } = ctx;

  return {
    /** The recipes: whether each is on, and its version now (what `craft` takes as the terms the player was shown). */
    async recipes() {
      const list = spec.recipes ?? [];
      const accounts = await client.accounts(list.map(r => loot.pda.recipe(project, r.id)));
      return list.map((r, i) => {
        const recipe = accounts[i] && loot.decode('Recipe', accounts[i].data);
        return { key: r.key, name: r.name, active: Boolean(recipe?.active), version: recipe ? recipe.version : null };
      });
    },

    /**
     * Crafts a recipe, handing in `assets` (the collectibles it burns or uses, in the recipe's order). `version`: the
     * recipe's version the page showed the player (`recipes()`, or the listing itself as `listing`), so a recipe the
     * owner changed since is refused rather than crafted on terms the player never saw. It is required: the version
     * read now is never signed in its place. `extra`: the tail a Core collection's plugins need when the craft moves or
     * rolls on a Core NFT (sent after the Memo program's account, as on every other Core move).
     */
    async craft(
      recipeKey,
      assets = [],
      times = 1,
      { version, listing, extra = [], build = false, ...others } = NO_OPTIONS,
    ) {
      only(others, ['version', 'listing', 'extra', 'build'], 'craft');
      const r = part('recipes', recipeKey);
      version ??= listing?.version ?? undefined;
      if (version === undefined || version === null)
        throw new Error(
          `Say which version of “${r.name ?? recipeKey}” the player was shown: pass the listing recipes() showed (listing), or its version. The version read now is never signed in its place.`,
        );
      const current = await read('Recipe', loot.pda.recipe(project, r.id));
      const recipe = { ...current, version };
      const pays = recipe.inputs.filter(i => i.Pay).map(i => i.Pay);
      const holders = await holdersOf(pays.map(p => ({ to: p.to })));
      const treasury = (await projectNow()).treasury;
      // An NFT a `show` line takes, by its address: as the project's, a Core asset of another collection, or a Token
      // Metadata mint, which the craft reads differently.
      // Where the collectibles of input `i` start among those handed in.
      const at = i =>
        recipe.inputs
          .slice(0, i)
          .reduce((n, x) => n + (x.Burn?.count ?? (x.Use || x.Show || x.Staked || x.Trade ? 1 : 0)), 0);
      const shownAt = new Set(recipe.inputs.flatMap((input, i) => (input.Show ? [at(i)] : [])));
      // An NFT a `trade` line takes in, any kind: read for its kind (a compressed one proven first).
      const tradedAt = new Set(recipe.inputs.flatMap((input, i) => (input.Trade ? [at(i)] : [])));
      const proving = [];
      // A collectible used or renewed that is staked in escrow, in the project's hands: its farm, found by its seat.
      const keptAt = new Set(recipe.inputs.flatMap((input, i) => (input.Use ? [at(i)] : [])));
      // One a `staked` line takes: on its seat in the farm the line names, escrowed or frozen there.
      const stakedAt = new Map(recipe.inputs.flatMap((input, i) => (input.Staked ? [[at(i), input.Staked.farm]] : [])));
      // The places a raise lowers a number on.
      const lowered = new Set(
        (recipe.raises ?? []).filter(raise => BigInt(raise.shift.by) < 0n).map(raise => Number(raise.place)),
      );
      const handed = await Promise.all(
        assets.map(async (nft, i) => {
          if (stakedAt.has(i) && typeof nft === 'string') {
            const farm = stakedAt.get(i);
            if (!(await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, farm), nft)))) {
              const name = (spec.farms ?? []).find(f => f.id === farm)?.name ?? `farm ${farm}`;
              throw new Error(`${nft} is not staked in “${name}”, where this recipe takes it.`);
            }
            return { asset: nft, farm };
          }
          if (keptAt.has(i) && typeof nft === 'string') return (await escrowedIn(nft)) ?? (await lockedIn(nft)) ?? nft;
          if (tradedAt.has(i) && typeof nft === 'string') {
            const { before, ...kind } = await nftOf(nft);
            proving.push(...before);
            return { asset: nft, ...kind };
          }
          if (!shownAt.has(i) || typeof nft !== 'string') return nft;
          // Shown on a seat of a farm that freezes, with a raise lowering a number on it: its seat and farm go with it.
          const seated = lowered.has(i) ? await lockedIn(nft) : null;
          const on = seated ? { farm: seated.farm } : {};
          const account = await client.account(nft);
          if (account?.owner !== MPL_CORE) return { mint: nft, owner: wallet.address, ...on };
          const theirs = await collectionOf(nft);
          return ours(theirs) ? (seated ? { asset: nft, ...on } : nft) : { asset: nft, collection: theirs, ...on };
        }),
      );
      // A recipe that rolls makes its roll in an order of the player's, which `collect` then finishes.
      const rolls = recipe.outputs.some(o => o.RollOn || o.Prize?.[0]?.Roll);
      // A roll on a collectible kept is named by that collectible's nonce (`nonceOn`): on a box that holds it, its
      // order is there, one at a time on it (`namedRollNonce`).
      const rollOn = recipe.outputs.find(o => o.RollOn)?.RollOn;
      const nonce = rollOn
        ? loot.nonceOn(typeof assets[rollOn.place] === 'string' ? assets[rollOn.place] : assets[rollOn.place].asset)
        : freshNonce();
      // A roll on a kept collectible (`RollOn`) passes its box's prize mints as a roll given does.
      const given = await prizeInputs(
        recipe.outputs.map(o => o.Prize?.[0] ?? (o.RollOn ? { Roll: [o.RollOn.box_id] } : null)),
      );
      // Each item a line takes passes its collection.
      const items = { ...given.items };
      for (const input of recipe.inputs) {
        const id = (input.Burn ?? input.Use ?? input.Renew ?? input.Staked)?.item;
        if (id !== undefined && !(id in items)) items[id] = await read('Item', loot.pda.item(project, id));
      }
      // The collectibles it makes, each at its item's next serial.
      const counts = {};
      const made = recipe.outputs.flatMap(o => {
        const id = o.Prize?.[0]?.Item?.[0];
        if (id === undefined || items[id]?.kind !== 'Collectible') return [];
        counts[id] = (counts[id] ?? 0) + 1;
        return [loot.pda.itemAsset(loot.pda.item(project, id), Number(items[id].issued) + counts[id])];
      });
      const linked = await personFor(recipe.per_wallet);
      const before = [...proving, ...given.before, ...linked.ixs].filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM);
      let instructions = [
        computeUnitLimit(rolls ? 1_400_000 : 1_000_000),
        ...before,
        loot.craftIx({
          person: linked.person,
          player: wallet.address,
          project,
          collection: collections[0],
          id: r.id,
          recipe,
          assets: handed,
          times,
          nonce,
          holders,
          programs,
          treasury,
          poolMints: given.poolMints,
          items,
          nfts: given.nfts,
          boxes: given.boxes,
          extra,
        }),
      ];
      // Fuel bought for a staked collectible counts once its seat is refreshed: in the same transaction.
      for (const raise of recipe.raises ?? []) {
        const asset = assets[raise.place];
        if (typeof asset !== 'string') continue;
        for (const f of (spec.farms ?? []).filter(x => x.upkeepAttribute === raise.shift.key)) {
          const seat = await readMaybe('Seat', loot.pda.seat(loot.pda.farm(project, f.id), asset));
          if (!seat) continue;
          const farm = await read('Farm', loot.pda.farm(project, f.id));
          const { before, ...nft } = await nftOf(asset);
          instructions.push(
            ...before,
            loot.refreshSeatIx({ signer: wallet.address, project, id: f.id, farm, by: asset, seat, ...nft }),
          );
        }
      }
      for (const p of pays) instructions = withSolWrap(wallet.address, p.mint, p.amount * BigInt(times), instructions);
      // A roll on a collectible kept is at its nonce; a prize's roll at `prizeRollNonce` of the craft's. Asked for in the
      // craft's own transaction and settled by a key after: one prompt.
      const on =
        rollOn && (typeof assets[rollOn.place] === 'string' ? assets[rollOn.place] : assets[rollOn.place].asset);
      const roll = rolls
        ? loot.pda.order(
            project,
            wallet.address,
            rollOn ? loot.namedRollNonce(given.boxes[rollOn.box_id], on, nonce) : loot.prizeRollNonce(nonce),
          )
        : null;
      // `build`: its instructions, unsent, for a step that rides in another's transaction (buyTickets' `make`). A recipe
      // that rolls is settled after its transaction, so it can't ride along.
      if (build) {
        if (rolls)
          throw new Error(`“${r.name ?? recipeKey}” rolls: it is crafted on its own (craft), not with another step.`);
        return { instructions, made };
      }
      const { signature, rolls: rolled } = await sendRolling(instructions);
      return { signature, made, ...(roll ? { roll } : {}), ...(rolled.length ? { rolled: rolled[0] } : {}) };
    },
  };
}
