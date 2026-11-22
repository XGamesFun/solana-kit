// A limit on each player is the same limit however it is written: per wallet or per person, in all or in a window. A
// shop item limited per person goes live with that limit, and no word says such a part limits nobody; a grant's older
// "gives" reads as its "prize" does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buySize, check, craftSize, openBoxSize } from '../economy/check.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { model, writtenDurations } from '../economy/model.mjs';
import { boxArgs } from '../economy/plan.mjs';
import { review } from '../economy/review.mjs';
import { simulate } from '../economy/simulate.mjs';

const NOW = 1_800_000_000;
const ISSUER = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const spec = more => ({
  version: 2,
  network: 'devnet',
  name: 'T',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: { name: 'T' },
  keys: { issuer: ISSUER },
  ...more,
});
const FORMS = {
  perWallet: [{ perWallet: 3 }, { total: 3, per_window: 0, window: 0, by_person: false }],
  perWalletEach: [
    { perWalletEach: { count: 3, every: '1d' } },
    { total: 0, per_window: 3, window: 86_400, by_person: false },
  ],
  perPerson: [{ perPerson: 3 }, { total: 3, per_window: 0, window: 0, by_person: true }],
  perPersonEach: [
    { perPersonEach: { count: 3, every: '1d' } },
    { total: 0, per_window: 3, window: 86_400, by_person: true },
  ],
};
const said = (s, codes) => {
  const v = check(s, { now: NOW });
  assert.ok(v.ok, v.refusals.map(r => `${r.code} ${r.message}`).join('\n'));
  return {
    warnings: v.warnings.filter(w => codes.includes(w.code)).map(w => w.message),
    text: explainEconomy(s, { now: NOW }).text,
  };
};

for (const [form, [limit, onChain]] of Object.entries(FORMS)) {
  test(`a shop item limited by ${form} goes live with that limit, and explain says it`, () => {
    const s = spec({ items: [{ key: 'pass', name: 'Pass', price: 0.01, ...limit }] });
    const m = model(s, { now: NOW });
    const per = boxArgs(m.shop[0], m).per_wallet;
    assert.deepEqual({ ...per, total: Number(per.total) }, onChain);
    assert.match(said(s, []).text, /Buy “Pass”: [^\n]*; at most 3 per (wallet|person)/);
  });

  test(`a free box, free lottery tickets and an open grant limited by ${form} are never said to limit nobody`, () => {
    const s = spec({
      items: [{ key: 'gem', name: 'Gem', price: 0.01 }],
      boxes: [{ key: 'b', name: 'Crate', price: 0, ...limit, outcomes: [{ gives: 'item', item: 'gem', chance: 100 }] }],
      lotteries: [{ key: 'l', name: 'Draw', price: 0, pot: 0, every: '7d', places: [100], ...limit }],
      grants: [
        { key: 'g', name: 'Gift', prize: { gives: 'item', item: 'gem' }, fund: 0.1, limits: { ...limit, perDay: 50 } },
      ],
    });
    const { warnings, text } = said(s, ['W-FREE', 'W-GRANT', 'W-LOTTERY']);
    for (const w of warnings) assert.doesNotMatch(w, /no limit per wallet|with no "perWallet"|limits no wallet/);
    assert.doesNotMatch(text, /limits no wallet/);
    assert.doesNotMatch(JSON.stringify(review(s, { now: NOW }).findings), /It limits no wallet/);
    assert.match(text, /“Gift” \(only the winning wallet claims[^\n]*limits 3 per (wallet|person)/);
  });
}

test('a grant written with the older "gives" is explained as its "prize" is: a voucher may name each claim’s amount', () => {
  const s = JSON.parse(readFileSync(new URL('../../examples/stakers-draw.json', import.meta.url), 'utf8'));
  s.pools = [{ key: 'rewards', currency: 'gem', seed: 100_000 }];
  s.grants[0].prize = { gives: 'tokens', amount: 500, from: 'pool:rewards' };
  const old = structuredClone(s);
  delete old.grants[0].prize;
  old.grants[0].gives = { pool: 'rewards', amount: 500 };
  const line = x =>
    explainEconomy(x, { now: NOW })
      .text.split('\n')
      .find(l => l.includes('Claim “Weekly race rewards”'));
  assert.match(line(s), /a voucher or the list can name each claim’s own amount/);
  assert.equal(line(old), line(s));
});

test('a purchase, an opening and a craft limited per person are sized with the person’s record and the wallet’s link', () => {
  const s = limit =>
    spec({
      items: [{ key: 'gem', name: 'Gem', price: 0.01, ...limit }],
      boxes: [
        { key: 'b', name: 'Crate', price: 0.01, ...limit, outcomes: [{ gives: 'item', item: 'gem', chance: 100 }] },
      ],
      recipes: [{ key: 'r', name: 'Forge', in: [{ pay: 0.01 }], out: [{ item: 'gem' }], ...limit }],
    });
  const sizes = limit => {
    const m = model(s(limit), { now: NOW });
    return [buySize(m.shop[0], m), openBoxSize(m.boxes[0], m), craftSize(m.recipes[0], m)];
  };
  const [none, wallet, person] = [sizes({}), sizes({ perWallet: 1 }), sizes({ perPerson: 1 })];
  for (const i of [0, 1, 2]) {
    assert.ok(wallet[i] > none[i], `a limit per wallet adds its counts (${i})`);
    assert.ok(person[i] > wallet[i], `a limit per person adds the link too (${i})`);
  }
});

test('a duration written as seconds is said as the spec could have written it, and counts the same', () => {
  const words = JSON.parse(readFileSync(new URL('../../examples/stakers-draw.json', import.meta.url), 'utf8'));
  const seconds = structuredClone(words);
  seconds.lotteries[0].every = 604_800;
  seconds.farms[0].tiers = seconds.farms[0].tiers.map(t => ({ ...t, lock: t.lock === '7d' ? 604_800 : 2_592_000 }));
  assert.equal(writtenDurations(seconds).lotteries[0].every, '1w');
  assert.equal(writtenDurations({ lotteries: [{ every: 90 }] }).lotteries[0].every, '90s');
  const text = explainEconomy(seconds, { now: NOW }).text;
  assert.doesNotMatch(text, /604800|2592000/);
  assert.match(text, /lock tiers x1 for 1w, x2 for 30d/);
  assert.deepEqual(
    simulate(seconds, { now: NOW }).lotteries[0].prizes,
    simulate(words, { now: NOW }).lotteries[0].prizes,
  );
});

test('a grant limited per person is simulated per person, and one per person each day with no total is warned', () => {
  const s = limit =>
    spec({
      items: [{ key: 'gem', name: 'Gem', price: 0.01 }],
      grants: [{ key: 'g', name: 'Gift', prize: { gives: 'item', item: 'gem' }, fund: 0.1, limits: limit }],
    });
  const sim = simulate(s({ perPersonEach: { count: 2, every: '1d' }, perDay: 50 }), { now: NOW });
  assert.deepEqual(sim.grants[0].person, { one: 2, per: 'a day' });
  assert.equal(sim.grants[0].many, undefined);
  const v = check(s({ perPersonEach: { count: 2, every: '1d' } }), { now: NOW });
  assert.ok(
    v.warnings.some(
      w => w.code === 'W-GRANT-TOTAL' && /limits each person but nothing a day or in all/.test(w.message),
    ),
  );
});
