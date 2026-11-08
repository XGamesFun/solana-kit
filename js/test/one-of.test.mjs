// A rule that matches any of several texts (the program's `Test::OneOf`): `oneOf` on an attribute, and `items`, any of
// several items the game mints, read as its own collection's `item_id` being one of theirs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleOf } from '../economy/model.mjs';

const m = {
  item: new Map([
    ['oak', { id: 3 }],
    ['pine', { id: 4 }],
  ]),
};

test('equals is one text, oneOf several, items any of several items', () => {
  assert.deepEqual(ruleOf({ attribute: 'tier', equals: 'rare' }, m).test, { OneOf: { texts: ['rare'] } });
  assert.deepEqual(ruleOf({ attribute: 'tier', oneOf: ['rare', 'epic'] }, m).test, {
    OneOf: { texts: ['rare', 'epic'] },
  });
  assert.deepEqual(ruleOf({ items: ['oak', 'pine'] }, m), {
    of: { Collection: ['@collection'] },
    key: 'item_id',
    test: { OneOf: { texts: ['3', '4'] } },
  });
});
