// Warnings the tools give for a live economy: a live box's roll rewritten while rolls of it may wait (a roll won on
// another route then refunds 0), and a price on a set's only way out (the platform's suspend then keeps the pieces
// locked).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';

const example = (name) => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url)));
const codes = (spec) => check(spec).warnings.map((w) => w.code);
/** The spec as if it went live as it is: `live.published` is what is on chain. */
const live = (spec) => {
  const { live: _, ...published } = structuredClone(spec);
  return { ...spec, live: { program: '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ', project: 'So11111111111111111111111111111111111111112', published } };
};

test('changing a live box\'s roll warns that its waiting rolls fail, and that one won elsewhere refunds 0', () => {
  const spec = live(example('expedition-guild'));
  assert.ok(!codes(spec).includes('W-LIVE-ROLLS'), 'nothing changed');
  const price = structuredClone(spec);
  price.boxes[0].price = 3;
  assert.ok(!codes(price).includes('W-LIVE-ROLLS'), 'a price leaves waiting rolls be');
  const odds = structuredClone(spec);
  odds.boxes[0].outcomes[0].chance = 30;
  odds.boxes[0].outcomes[1].chance = 70;
  const bought = check(odds).warnings.find((x) => x.code === 'W-LIVE-ROLLS');
  assert.ok(bought, 'its outcomes changed');
  assert.match(bought.message, /payment back/);
  // A box a grant and a mission give as a roll: those rolls paid nothing in.
  const vault = live(example('partner-vault'));
  const chest = vault.boxes.find((b) => b.key === 'daily-chest');
  chest.outcomes[0].chance += 1;
  chest.outcomes[1].chance -= 1;
  const won = check(vault).warnings.find((x) => x.code === 'W-LIVE-ROLLS' && x.where === 'economy.boxes.daily-chest');
  assert.ok(won);
  assert.match(won.message, /grant:daily, farm:expedition\) paid nothing in, so it refunds 0/);
});

test('a price on a set\'s only way out warns that a suspend keeps the pieces locked', () => {
  const spec = example('elements-set');
  assert.ok(!codes(spec).includes('W-UNBIND-PAY'), 'the example\'s unbind takes no payment');
  const priced = structuredClone(spec);
  const unbind = priced.recipes.find((r) => r.key === 'unbind');
  unbind.in.push({ takes: 'pay', amount: 1, currency: priced.currency, to: 'burn' });
  assert.ok(codes(priced).includes('W-UNBIND-PAY'));
  // A free way out besides it: the priced one is a choice, not the only door.
  const both = structuredClone(priced);
  both.recipes.push({ ...structuredClone(spec.recipes.find((r) => r.key === 'unbind')), key: 'unbind-free', name: 'Unbind for free' });
  assert.ok(!codes(both).includes('W-UNBIND-PAY'));
});
