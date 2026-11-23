// A change to a live economy publishes every part whose instructions it changes, the parts that read the changed one
// included: a sale's share into a lottery whose pot moves, a recipe that enforces an item's life. A file left as it was
// publishes nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { changedParts, recordLanded } from '../economy/live.mjs';
import { model } from '../economy/model.mjs';
import { placeholderContext, plan, setupContext } from '../economy/plan.mjs';

const NOW = 1_800_000_000;
const OWNER = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const live = name => {
  const spec = JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
  // A copy, as a file read again is: the record and its published spec share their parts.
  return JSON.parse(
    JSON.stringify(recordLanded(spec, { ctx: placeholderContext(model(spec, { now: NOW })), now: NOW })),
  );
};

test('a live economy left as it was publishes nothing', () => {
  for (const name of ['stakers-draw', 'stud-farm', 'partner-vault', 'halving-seasons']) {
    const ch = changedParts(live(name));
    assert.deepEqual([[...ch.only], ch.fixed], [[], []], name);
  }
});

test('a lottery’s pot moved publishes the sale whose share is paid into it', () => {
  const e = live('stakers-draw');
  e.lotteries[0].pot = 1;
  assert.deepEqual([...changedParts(e).only].sort(), ['item:badge', 'lottery:draw']);
});

test('an item’s life changed publishes each recipe that enforces it', () => {
  const e = live('stud-farm');
  e.items[0].life.uses = Number(e.items[0].life.uses ?? 0) + 1;
  const only = [...changedParts(e).only];
  assert.ok(only.includes('item:mare') && only.includes('recipe:breed'), only.join(', '));
});

test('a change to a spec whose steps cannot be built is refused, never published without the parts that read what changed', () => {
  // Live for a real wallet (the check refuses the plan's stand-in for one).
  const spec = JSON.parse(readFileSync(new URL('../../examples/stakers-draw.json', import.meta.url), 'utf8'));
  const m = model(spec, { now: NOW });
  const keys = Object.fromEntries(
    ['new:collection', ...[...m.tokens.keys()].map(key => `new:mint/${key}`)].map((name, i) => [
      name,
      `So1111111111111111111111111111111111111111${i + 3}`,
    ]),
  );
  const ctx = setupContext(m, { owner: OWNER, keys, rent: () => 0n });
  const e = JSON.parse(JSON.stringify(recordLanded(spec, { ctx, now: NOW })));
  assert.deepEqual(check(e, { now: NOW }).refusals, []);
  // Its pot moves, which the badge's sale reads. And what the lottery would hold for its rounds' rent, were it put
  // live anew, passes what 8 bytes count: its steps cannot be built, so the parts cannot be compared as they build.
  e.lotteries[0].pot = 1;
  e.lotteries[0].every = '640000000w';
  e.scenario.perDay['lottery:draw'] = 1_000_000;
  const { only } = changedParts(e);
  assert.deepEqual([...only], ['lottery:draw'], 'the sale that reads the pot could not be found');
  // A change is planned only from a spec the check passes, and the check builds the same steps.
  const verdict = check(e, { now: NOW });
  assert.deepEqual(
    verdict.refusals.map(r => `${r.code} ${r.where}`),
    ['E-BUILD economy.lotteries.draw'],
  );
  assert.match(verdict.refusals[0].message, /could not be built for the program: \d+ does not fit in 8 bytes\./);
  assert.equal(plan(e, { now: NOW, only, live: e.live }).ok, false);
});

test('a live grant keeps how its claim records are split, whatever its wallets become, edit after edit', async () => {
  const { grantArgs, setupSteps } = await import('../economy/plan.mjs');
  // The bits a plan sends: from what the chain holds (the approval reads it into `grantShards`), else the published spec.
  const bits = (e, grantShards) => {
    const { model: m } = setupSteps(e, { now: NOW, live: { ...e.live, ...(grantShards ? { grantShards } : {}) } });
    return grantArgs(m.grants[0], m).shard_bits;
  };
  const e = live('event-badges');
  const first = bits(e);
  const key = e.grants[0].key;
  // A first edit that would size it otherwise: the published spec still sizes it as it went live.
  e.grants[0].wallets = 500_000;
  assert.notEqual(
    bits({ ...e, live: { ...e.live, published: undefined } }),
    first,
    'the edit alone would size it otherwise',
  );
  assert.equal(bits(e), first);
  // Once that edit is the published spec, only the chain's word keeps it: the approval reads it.
  e.live.published.grants[0].wallets = 500_000;
  e.grants[0].wallets = 900_000;
  assert.equal(bits(e, { [key]: first }), first);
  // Nothing of it is written to the file: a file any kit reads.
  assert.ok(
    !JSON.stringify(recordLanded(e, { ctx: placeholderContext(model(e, { now: NOW })), now: NOW })).includes(
      'shardBits',
    ),
  );
});
