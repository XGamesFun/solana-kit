// A collectible's life (`life`: ready after, lasts, uses, cooldown) is the recipes' own lines on chain: the kit writes
// needs and raises into each recipe that takes the item (`lifeLines`), on its `made`, `used` and `next_use`, and the
// program holds them as it holds any recipe's (NeedNotMet, MaxedOut). A renew line counts the uses from 0 again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoreAsset } from '../chain/core.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { check } from '../economy/check.mjs';
import { lifeLines, model } from '../economy/model.mjs';
import { recipeArgs } from '../economy/plan.mjs';
import { cannotRun, collectible, world } from './world.mjs';

const skip = cannotRun() ?? false;
const { pda } = loot;
const HOUR = 3_600;
const NOW = 1_800_000_000;

const spec = {
  version: 2,
  network: 'devnet',
  name: 'Tools',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  items: [
    { key: 'tool', name: 'Tool', uri: 'https://example.invalid/t.json', life: { readyAfter: '1h', lasts: '10d', uses: 2, cooldown: '1h' } },
    { key: 'ore', name: 'Ore', uri: 'https://example.invalid/o.json', life: { readyAfter: '1h' } },
  ],
  recipes: [
    { key: 'work', name: 'Work', in: [{ takes: 'burn', item: 'ore' }, { takes: 'use', item: 'tool' }], out: [] },
    { key: 'fix', name: 'Fix', in: [{ takes: 'renew', item: 'tool' }], out: [] },
  ],
};

test('a life is written as needs and raises at each collectible’s place in the recipes that take it', () => {
  const m = model(spec, { now: NOW });
  const work = lifeLines(spec.recipes[0], m);
  // The ore burned is place 0 (ready after an hour); the tool used is place 1 (all four rules).
  assert.deepEqual(work.needs, [
    { place: 0, key: 'made', test: { Older: [HOUR] } },
    { place: 1, key: 'made', test: { Older: [HOUR] } },
    { place: 1, key: 'made', test: { Within: [10 * 24 * HOUR] } },
    { place: 1, key: 'next_use', test: 'Passed' },
  ]);
  assert.deepEqual(work.raises, [
    { place: 1, shift: { key: 'used', by: 1, most: 2, from_now: false } },
    { place: 1, shift: { key: 'next_use', by: HOUR, most: HOUR, from_now: true } },
  ]);
  const fix = recipeArgs(spec.recipes[1], m);
  assert.deepEqual(fix.inputs, [{ Use: { item: m.item.get('tool').id } }], 'a renew keeps it as a use does');
  assert.deepEqual(fix.raises, [{ place: 0, shift: { key: 'used', by: -2_147_483_647, most: 0, from_now: false } }]);
  assert.equal(check(spec, { now: NOW }).ok, true);
});

test('a staked line of an item with uses must move its farm’s lock too: the life’s raise is a raise on it', () => {
  const staked = structuredClone(spec);
  staked.farms = [{ key: 'yard', name: 'Yard', stakes: 'collectibles', item: 'tool', custody: 'escrow', rewards: 'sol', lockAttribute: 'free_at', tiers: [{ lock: '1d' }] }];
  staked.recipes = [{ key: 'work', name: 'Work', in: [{ takes: 'staked', item: 'tool', farm: 'yard' }], out: [] }];
  const r = check(staked, { now: NOW });
  assert.ok(r.refusals.some((x) => x.code === 'E-RECIPE' && /“used”/.test(x.message) && /BadRecipe/.test(x.message)), r.refusals.map((x) => x.message).join('\n'));
});

test('on chain: ready after an hour, two uses with an hour between them, then renewed', { skip }, () => {
  const w = world({ seed: 'item-life' });
  const m = model(spec, { now: NOW });
  const id = m.item.get('tool').id;
  w.upsert({ Item: { id, args: collectible('Tool') } });
  const work = recipeArgs({ ...spec.recipes[0], in: [spec.recipes[0].in[1]] }, m);
  w.upsert({ Recipe: { id: 1, args: { ...work, window: undefined, per_wallet: undefined } } });
  w.upsert({ Recipe: { id: 2, args: { ...recipeArgs(spec.recipes[1], m), window: undefined, per_wallet: undefined } } });
  const tool = w.make(id, w.player);
  const craft = (recipe) => w.chain.send(w.player, [computeUnitLimit(1_000_000), loot.craftIx({ player: w.player, project: w.project, collection: w.collection, id: recipe, recipe: w.read('Recipe', pda.recipe(w.project, recipe)), assets: [tool] })]);
  const used = () => Number(parseCoreAsset(w.chain.get(tool).data).attributes.used ?? 0);
  assert.throws(() => craft(1), /NeedNotMet/, 'not ready yet');
  w.chain.warp(w.chain.now() + HOUR);
  craft(1);
  assert.equal(used(), 1);
  assert.throws(() => craft(1), /NeedNotMet/, 'cooling down');
  w.chain.warp(w.chain.now() + HOUR);
  craft(1);
  assert.equal(used(), 2);
  w.chain.warp(w.chain.now() + HOUR);
  assert.throws(() => craft(1), /MaxedOut/, 'used up');
  craft(2);
  assert.equal(used(), 0, 'renewed');
  craft(1);
  w.chain.warp(w.chain.now() + 10 * 24 * HOUR);
  assert.throws(() => craft(1), /NeedNotMet/, 'past its life');
});
