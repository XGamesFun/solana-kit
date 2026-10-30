// Farm custody and the rules around it: a farm's default custody, freeze farms and soulbound collectibles, rules that
// name an item or a collection, and recipes that move a staked piece's lock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { guideText } from '../economy/guide.mjs';
import { model } from '../economy/model.mjs';
import { farmArgs } from '../economy/plan.mjs';
import { SCHEMA } from '../economy/validate.mjs';

const now = 1_790_000_000;
const spec = {
  version: 2, network: 'devnet', name: 'Custody choices', currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'Custody choices' },
  items: [{ key: 'badge', name: 'Badge' }],
  pools: [{ key: 'rewards', currency: 'sol', seed: 1 }],
  farms: [{ key: 'farm', name: 'Farm', stakes: 'collectibles', item: 'badge', rewards: 'rewards' }],
};

test('a farm with no custody named escrows, in the schema, the plan and the guide', () => {
  const m = model(spec, { now });
  const result = check(spec, { now });
  assert.ok(result.ok, result.refusals.map((x) => x.message).join('\n'));
  assert.equal(SCHEMA.$defs.farm.properties.custody.default, 'escrow');
  assert.equal(farmArgs(m.farms[0], m).custody, 'Escrow');
  assert.match(guideText(), /Escrow is the default/);
});

test('an explicit freeze farm is kept, and soulbound collectibles need one', () => {
  const chosen = structuredClone(spec);
  chosen.farms[0].custody = 'freeze';
  assert.equal(farmArgs(model(chosen, { now }).farms[0], model(chosen, { now })).custody, 'Freeze');
  assert.ok(check(chosen, { now }).warnings.some((x) => x.code === 'W-FARM-CUSTODY' && /unfreezing fail/.test(x.message)));
  const soulbound = structuredClone(spec);
  soulbound.items[0].soulbound = true;
  assert.ok(check(soulbound, { now }).refusals.some((x) => x.code === 'E-FARM' && /soulbound/.test(x.message)));
  soulbound.farms[0].custody = 'freeze';
  assert.ok(check(soulbound, { now }).ok);
});

test('a rule names an item of the game or another collection, never both', () => {
  const gated = (gate) => check({ ...spec, boxes: [{ key: 'chest', name: 'Chest', price: 0.1, outcomes: [{ gives: 'nothing', weight: 1 }], gate }] }, { now });
  const club = '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ';
  assert.ok(gated({ collection: club }).ok, gated({ collection: club }).refusals.map((x) => x.message).join('\n'));
  assert.ok(gated({ item: 'badge', collection: club }).refusals.some((x) => x.code === 'E-RULE'));
  assert.ok(gated({ collection: 'not an address' }).refusals.some((x) => x.code === 'E-SCHEMA'));
});

test('a recipe that moves a staked piece’s lock takes it only from the farm its line names, which reads that lock', async () => {
  const { readFile } = await import('node:fs/promises');
  const elements = JSON.parse(await readFile(new URL('../../examples/elements-set.json', import.meta.url), 'utf8'));
  assert.ok(check(elements, { now }).ok, check(elements, { now }).refusals.map((x) => x.message).join('\n'));
  // A second farm that stakes the pieces with no lock on the NFT changes nothing: each line names the altar.
  const loose = structuredClone(elements);
  const { lockAttribute, ...shrine } = loose.farms[0];
  loose.farms.push({ ...shrine, key: 'shrine', name: 'The shrine' });
  assert.ok(check(loose, { now }).ok, check(loose, { now }).refusals.map((x) => x.message).join('\n'));
  // Lines that name the shrine move a lock it doesn't read (BadRecipe).
  for (const r of loose.recipes) for (const line of r.in) if (line.takes === 'staked') line.farm = 'shrine';
  const refusals = check(loose, { now }).refusals.filter((x) => x.code === 'E-RECIPE' && /free_at/.test(x.message) && /BadRecipe/.test(x.message));
  assert.equal(refusals.length, 8, refusals.map((x) => x.message).join('\n'));
  loose.farms[2].lockAttribute = lockAttribute;
  assert.ok(check(loose, { now }).ok);
});

test('an open grant behind an NFT counts the NFT as a person, so it limits no person', () => {
  const grant = { key: 'drop', name: 'Drop', gives: { item: 'badge' }, gate: { item: 'badge' }, limits: { perWallet: 1, perPerson: 1 } };
  // The program allows it; it limits nothing, which the checker says.
  const said = check({ ...spec, grants: [grant] }, { now });
  assert.ok(said.ok && said.warnings.some((x) => x.code === 'W-GRANT' && /perPerson/.test(x.where)), said.refusals.map((x) => x.message).join('\n'));
  const fine = check({ ...spec, grants: [{ ...grant, limits: { perWallet: 1 } }] }, { now });
  assert.ok(!fine.refusals.some((x) => x.code === 'E-GRANT'), fine.refusals.map((x) => x.message).join('\n'));
});
