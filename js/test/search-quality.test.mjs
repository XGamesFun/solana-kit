// What `examples` finds for a few plain requests: the examples and rated kinds of economy that fit, and none that only
// share a common word with them (a messaging app for "shop with loot boxes").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search } from '../economy/examples.mjs';

const names = r => r.examples.map(e => e.name);
const ideas = r => r.ideas.map(i => i.name);

test('a request finds the examples that fit it, the best first', () => {
  assert.deepEqual(names(search('shop with loot boxes')).slice(0, 2), ['trade-in-shop', 'blind-forge']);
  assert.equal(names(search('coin flip'))[0], 'coin-flip-arena');
  assert.equal(names(search('auction for my art'))[0], 'artwork-auction');
  assert.equal(names(search('team token vesting'))[0], 'team-vesting');
  assert.ok(names(search('weekly raffle')).slice(0, 2).includes('nft-raffle'));
  assert.ok(names(search('crafting and merging')).includes('merge-2048'));
});

test('a rated kind of economy is shown only when its name says what was asked', () => {
  const shop = ideas(search('shop with loot boxes'));
  assert.ok(!shop.some(n => /messaging|shooter/i.test(n)), shop.join(' | '));
  assert.match(ideas(search('coin flip'))[0], /coin-flip/i);
  assert.match(ideas(search('team token vesting'))[0], /vesting/i);
  assert.match(ideas(search('prediction market'))[0], /prediction/i);
  for (const n of ideas(search('liquid staking of SOL with a validator'))) assert.match(n, /liquid|staking/i);
  for (const n of ideas(search('nft staking'))) assert.match(n, /nft|staking|pfp|collection/i);
});

test('a request loot has no example for finds none, and says what it can’t do', () => {
  const r = search('liquid staking of SOL with a validator');
  assert.deepEqual(names(r), []);
  assert.ok(r.limits.length);
});
