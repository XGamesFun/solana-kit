// What the checker refuses in words so that the setup plan never throws on a spec it passed: a token's source as the
// model reads it, times past what the program keeps, a sealed schedule's and a grant's amounts, the schema's oneOf,
// not and uniqueItems, and a setup step too big for one transaction.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { plan } from '../economy/plan.mjs';
import { findSecrets } from '../economy/secrets.mjs';
import { validate } from '../economy/validate.mjs';

const NOW = 1_800_000_000;
const A = 'So11111111111111111111111111111111111111113';
const W = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const example = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
const codes = r => r.refusals.map(x => `${x.code} ${x.where}`);
/** Checks a spec, and when it passes, plans it: a spec the checker passed must plan without throwing. */
const checkAndPlan = spec => {
  const r = check(spec, { now: NOW });
  if (r.ok) assert.doesNotThrow(() => plan(spec, { now: NOW }), 'a spec the checker passed plans');
  return r;
};
const sol = (extra = {}) => ({
  version: 2,
  network: 'devnet',
  name: 'Limits',
  currency: 'sol',
  tokens: [{ key: 'sol', source: 'sol' }],
  collection: false,
  ...extra,
});

test('a token of source "project" is checked as one of source "game": its Token-2022 program, its supply and its pools’ seeds', () => {
  for (const source of ['game', 'project']) {
    const token2022 = sol({
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'gold', source, program: 'token-2022' },
      ],
    });
    assert.deepEqual(codes(checkAndPlan(token2022)), ['E-NOT-YET economy.tokens[1].program'], source);
    const seeded = sol({
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'gold', source, supply: 100 },
      ],
      pools: [{ key: 'p', currency: 'gold', seed: 200 }],
    });
    assert.deepEqual(codes(checkAndPlan(seeded)), ['E-TOKEN economy.tokens[1].supply'], source);
    const fixed = sol({
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'gold', source, supply: 100 },
      ],
      pools: [{ key: 'p', currency: 'gold', seed: 50 }],
    });
    assert.deepEqual(codes(checkAndPlan(fixed)), [], source);
  }
});

test('a token the project makes names no mint of its own', () => {
  for (const source of ['game', 'project']) {
    const spec = sol({
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'gold', source, mint: A },
      ],
    });
    assert.deepEqual(codes(checkAndPlan(spec)), ['E-TOKEN economy.tokens[1].mint'], source);
  }
});

test('a time the program keeps in 4 bytes, or counts from go-live, is refused in words past what fits', () => {
  const at = r => r.refusals.filter(x => x.code === 'E-TIME').map(x => x.where);
  const tooLong = '8000w';
  let e = example('coin-flip-arena');
  e.farms[0].tiers[0].lock = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), ['economy.farms.' + e.farms[0].key + '.tiers[0].lock']);
  e = example('paper-hands-farm');
  e.farms[0].tiers[0].earnsFor = 4_294_967_296;
  assert.deepEqual(at(checkAndPlan(e)), ['economy.farms.' + e.farms[0].key + '.tiers[0].earnsFor']);
  e = example('stud-farm');
  const living = e.items.find(it => it.life);
  living.life.readyAfter = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.items.${living.key}.life.readyAfter`]);
  e = example('falling-drop');
  const falling = e.items.find(it => it.fall);
  falling.fall.every = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.items.${falling.key}.fall.every`]);
  e = example('shelter-fair');
  const limited = e.boxes.find(b => b.perWalletEach);
  limited.perWalletEach.every = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.boxes.${limited.key}.perWalletEach.every`]);
  e = example('partner-vault');
  const windowed = e.grants.find(g => g.limits?.perWalletEach);
  windowed.limits.perWalletEach.every = tooLong;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.grants.${windowed.key}.limits.perWalletEach.every`]);
  // A raise's `by` is signed: half as much each way.
  e = example('elements-set');
  const r = e.recipes.find(x => x.raises);
  r.raises[0].by = '4000w';
  r.raises[0].upTo = 4_294_967_296;
  assert.deepEqual(at(checkAndPlan(e)), [
    `economy.recipes.${r.key}.raises[0].by`,
    `economy.recipes.${r.key}.raises[0].upTo`,
  ]);
  e = example('hero-trials');
  const shifting = e.boxes.find(b => b.outcomes.some(o => o.shifts));
  const o = shifting.outcomes.findIndex(x => x.shifts);
  shifting.outcomes[o].shifts[0].upTo = 4_294_967_296;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.boxes.${shifting.key}.outcomes[${o}].shifts[0].upTo`]);
  // Counted from go-live into 8 bytes: a farm's end, a schedule's every.
  e = example('guild-missions');
  const ending = e.farms.find(f => f.runs);
  ending.runs = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.farms.${ending.key}.runs`]);
  e = example('halving-seasons');
  e.schedules[0].every = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.schedules.${e.schedules[0].key}.every`]);
});

test('every time and window a part writes is refused in words past what the program keeps: an auction’s, a lottery’s, a contest’s, a sale’s', () => {
  const at = r => r.refusals.filter(x => x.code === 'E-TIME').map(x => x.where);
  // In 4 bytes: what a late bid pushes an auction's end by, and a limit's window by person.
  let e = example('artwork-auction');
  const auction = `economy.auctions.${e.auctions[0].key}`;
  e.auctions[0].extendBy = '5000000000s';
  let r = checkAndPlan(e);
  assert.deepEqual(at(r), [`${auction}.extendBy`]);
  assert.match(r.refusals[0].message, /^5000000000s is 5,000,000,000 seconds, more than the program keeps here/);
  e = example('shelter-fair');
  e.keys = { ...e.keys, issuer: W };
  const box = e.boxes.find(b => b.perWalletEach);
  box.perPersonEach = { ...box.perWalletEach, every: '8000w' };
  delete box.perWalletEach;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.boxes.${box.key}.perPersonEach.every`]);
  e = example('coin-flip-arena');
  const lottery = `economy.lotteries.${e.lotteries[0].key}`;
  delete e.lotteries[0].perWallet;
  e.lotteries[0].perWalletEach = { count: 5, every: 4_294_967_296 };
  assert.deepEqual(at(checkAndPlan(e)), [`${lottery}.perWalletEach.every`]);
  // In 8 bytes, counted from go-live: an auction's end, a lottery's rhythm and close of sales, a contest's result.
  e = example('artwork-auction');
  e.auctions[0].runs = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`${auction}.runs`]);
  e = example('coin-flip-arena');
  e.lotteries[0].every = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`${lottery}.every`]);
  e = example('nft-raffle');
  e.lotteries[0].closesBefore = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.lotteries.${e.lotteries[0].key}.closesBefore`]);
  e = example('fair-presale');
  e.contests[0].resultDue = 1e21;
  assert.deepEqual(at(checkAndPlan(e)), [`economy.contests.${e.contests[0].key}.resultDue`]);
  // A time: a date the calendar doesn't have, and one after the last a date can say, wherever a part writes one.
  const times = [
    ['blind-forge', x => x.boxes[0], 'opens', x => `economy.boxes.${x.boxes[0].key}.opens`],
    ['blind-forge', x => x.boxes[0], 'closes', x => `economy.boxes.${x.boxes[0].key}.closes`],
    ['elements-set', x => x.recipes[0], 'closes', x => `economy.recipes.${x.recipes[0].key}.closes`],
    [
      'falling-drop',
      x => x.items.find(it => it.fall),
      'opens',
      x => `economy.items.${x.items.find(it => it.fall).key}.opens`,
    ],
    [
      'falling-drop',
      x => x.items.find(it => it.fall).fall,
      'start',
      x => `economy.items.${x.items.find(it => it.fall).key}.fall.start`,
    ],
    ['event-badges', x => (x.grants[0].limits ??= {}), 'until', x => `economy.grants.${x.grants[0].key}.limits.until`],
    ['artwork-auction', x => x.auctions[0], 'start', () => `${auction}.start`],
    ['nft-raffle', x => x.lotteries[0], 'firstDraw', x => `economy.lotteries.${x.lotteries[0].key}.firstDraw`],
    ['halving-seasons', x => x.schedules[0], 'start', x => `economy.schedules.${x.schedules[0].key}.start`],
  ];
  for (const [name, part, field, where] of times)
    for (const [time, says] of [
      ['2026-13-45T25:61Z', /is not a time\.$/],
      ['publish+99999999w', /lands after the year 9999/],
    ]) {
      e = example(name);
      part(e)[field] = time;
      r = checkAndPlan(e);
      assert.deepEqual(at(r), [where(e)], `${name} ${field} ${time}`);
      assert.match(r.refusals.find(x => x.code === 'E-TIME').message, says);
    }
});

test('the most tokens a grant gives is an amount of its prize’s token', () => {
  const e = example('stakers-draw');
  const grant = e.grants.find(g => g.prize?.gives === 'tokens' || g.gives?.pool);
  const where = `economy.grants.${grant.key}.limits.tokens`;
  for (const [tokens, says] of [
    ['99999999999999999999', /is too large for the program/],
    ['0.000000000000000001', /has more decimals than its currency/],
  ]) {
    grant.limits = { ...grant.limits, tokens };
    const r = checkAndPlan(e);
    assert.deepEqual(codes(r), [`E-AMOUNT ${where}`], tokens);
    assert.match(r.refusals[0].message, says);
  }
});

test('a sealed schedule gets the checks an unsealed one gets: its amounts in its token, and where it pays', () => {
  const spec = (schedule, extra = {}) =>
    sol({
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'usd', source: 'existing', mint: A, decimals: 6 },
      ],
      schedules: [
        Object.fromEntries(
          Object.entries({
            key: 's',
            name: 'S',
            does: 'pay',
            sealed: true,
            currency: 'usd',
            to: `wallet:${W}`,
            amount: 1,
            fund: 10,
            every: '1d',
            maxRuns: 10,
            ...schedule,
          }).filter(([, v]) => v !== undefined),
        ),
      ],
      ...extra,
    });
  assert.equal(checkAndPlan(spec({})).ok, true);
  assert.deepEqual(codes(checkAndPlan(spec({ amount: '0.0000001' }))), ['E-AMOUNT economy.schedules.s.amount']);
  assert.deepEqual(codes(checkAndPlan(spec({ fund: '0.0000001' }))), ['E-AMOUNT economy.schedules.s.fund']);
  assert.deepEqual(codes(checkAndPlan(spec({ fund: '99999999999999999999' }))), ['E-AMOUNT economy.schedules.s.fund']);
  // It pays a wallet, the treasury or a burn: never a pool, a pot, a farm or an account (BadMove).
  for (const to of ['pool:nope', 'lottery:nope', 'farm:nope', `account:${W}`, 'nope'])
    assert.deepEqual(codes(checkAndPlan(spec({ to }))), ['E-SCHEDULE economy.schedules.s.to'], to);
  assert.equal(checkAndPlan(spec({ to: 'treasury' })).ok, true);
});

test('a grant’s funds are SOL to the lamport, and no more than the program counts', () => {
  const spec = fund =>
    sol({
      grants: [
        {
          key: 'g',
          name: 'G',
          prize: { gives: 'tokens', amount: 0.01, from: 'pool:p' },
          limits: { perWallet: 1 },
          fund,
        },
      ],
      pools: [{ key: 'p', currency: 'sol', seed: 1 }],
    });
  assert.equal(checkAndPlan(spec(0.05)).ok, true);
  for (const fund of ['0.0000000001', '99999999999999999999'])
    assert.deepEqual(codes(checkAndPlan(spec(fund))), ['E-AMOUNT economy.grants.g.fund'], fund);
});

test('the schema’s oneOf, not and uniqueItems are kept: a lot is one of its forms, a raise moves by something, a list names each once', () => {
  let e = example('artwork-auction');
  for (const lot of [{}, { item: e.auctions[0].lot.item, roll: 'x' }]) {
    e.auctions[0].lot = lot;
    assert.deepEqual(codes(checkAndPlan(e)), ['E-SCHEMA economy.auctions[0].lot'], JSON.stringify(lot));
  }
  e = example('elements-set');
  const i = e.recipes.findIndex(r => r.raises);
  e.recipes[i].raises[0].by = 0;
  assert.deepEqual(codes(checkAndPlan(e)), [`E-SCHEMA economy.recipes[${i}].raises[0].by`]);
  e = example('artwork-auction');
  e.collections = [A, A];
  assert.deepEqual(codes(checkAndPlan(e)), ['E-SCHEMA economy.collections[1]']);
  assert.deepEqual(validate({ version: 2, collections: [A, W] }), []);
  // The messages read as English.
  assert.deepEqual(
    validate({ version: 2, tokens: 'x' }).map(x => x.message),
    ['must be an array'],
  );
});

test('a setup step too big for one transaction is refused by the checker, not thrown on by the plan', () => {
  const mint = { gives: 'tokens', from: 'mint', currency: 'gold', amount: 1 };
  const spec = n =>
    sol({
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'gold', source: 'project' },
      ],
      boxes: [
        {
          key: 'big',
          name: 'Big',
          price: 0.1,
          outcomes: Array.from({ length: n }, () => ({ gives: 'bundle', prizes: [mint, mint, mint], weight: 1 })),
        },
      ],
    });
  assert.equal(checkAndPlan(spec(3)).ok, true);
  const r = checkAndPlan(spec(6));
  assert.deepEqual(codes(r), ['E-TX-SIZE economy.boxes.big']);
  assert.match(r.refusals[0].message, /The box “Big” takes \d+ bytes to set up/);
});

test('a prize’s seed is weighed in exact units', () => {
  const spec = seed =>
    sol({
      pools: [{ key: 'p', currency: 'sol', seed }],
      boxes: [
        {
          key: 'b',
          name: 'B',
          price: 0.1,
          outcomes: [
            { gives: 'tokens', from: 'pool:p', amount: '0.300000001', weight: 1 },
            { gives: 'nothing', weight: 1 },
          ],
        },
      ],
    });
  const seedWarned = seed => check(spec(seed), { now: NOW }).warnings.some(w => w.code === 'W-PRIZE-SEED');
  assert.equal(seedWarned('0.3'), true, 'a lamport short');
  assert.equal(seedWarned('0.300000001'), false);
});

test('a link’s ordinary query is no secret; a key in one still is', () => {
  for (const uri of [
    'https://example.com/meta.json?token=12',
    'https://example.com/meta.json?sig=',
    'https://example.com/a?key=hero',
  ])
    assert.deepEqual(findSecrets(uri), [], uri);
  for (const uri of ['https://rpc.example/?api-key=1', 'https://rpc.example/?token=eyJhbGciOiJIUzI1NiJ9abcdef'])
    assert.equal(findSecrets(uri).length, 1, uri);
});

test('an auction of a roll says so in its setup step, and a pool a pay schedule drains is taken from', () => {
  const steps = plan(example('partner-vault'), { now: NOW }).steps.filter(s => s.id.startsWith('auction:'));
  assert.ok(
    steps.length && steps.every(s => /a roll of the box “/.test(s.says) && !/undefined/.test(s.says)),
    steps.map(s => s.says).join('\n'),
  );
  const spec = sol({
    pools: [{ key: 'p', currency: 'sol', seed: 1 }],
    lotteries: [{ key: 'l', pot: 0, name: 'L', price: 0.1, every: '1d' }],
    schedules: [{ key: 's', name: 'S', does: 'pay', from: 'p', to: 'lottery:l', amount: 0.01, every: '1d' }],
  });
  const r = check(spec, { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.ok(!r.warnings.some(w => w.code === 'W-POOL' && w.where === 'economy.pools.p'), 'the schedule takes from it');
});

test('a name every object inherits is not a field of the schema, and does not count as given', () => {
  const spec = JSON.parse(readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url), 'utf8'));
  assert.deepEqual(validate(spec), []);
  // "constructor" and "__proto__" as keys of the file (JSON gives an object its own "__proto__" key): refused like
  // any other name the schema does not list, where each passed before.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const edited = JSON.parse(JSON.stringify(spec).replace(/^\{/, `{"${name}":{"anything":1},`));
    assert.ok(Object.hasOwn(edited, name), name);
    assert.deepEqual(
      validate(edited).map(e => `${e.path} ${e.message}`),
      [`economy.${name} is not a field this place takes`],
      name,
    );
  }
  // A field the schema requires is not given by a name the object inherits.
  const schema = { type: 'object', required: ['constructor'], properties: { constructor: { type: 'string' } } };
  assert.deepEqual(
    validate({}, schema, schema, 'x').map(e => e.message),
    ['needs "constructor"'],
  );
  assert.deepEqual(validate({ constructor: 'a' }, schema, schema, 'x'), []);
});

test('a seed phrase is found however it is written, and a 64-byte key in hex; ordinary writing and a hash are not', () => {
  // (the well-known test phrase of BIP-39's own vectors: it opens nothing anyone uses)
  const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
  const found = text => findSecrets({ name: 'A game', note: text }).join();
  for (const [how, text] of [
    ['lower case', words.join(' ')],
    ['Capitalised', words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ')],
    ['UPPER CASE', words.join(' ').toUpperCase()],
    ['commas', words.join(', ')],
    ['new lines', words.join('\n')],
    ['numbered', words.map((w, i) => `${i + 1}. ${w}`).join(' ')],
    ['numbered lines', words.map((w, i) => `${i + 1}) ${w}`).join('\n')],
    ['inside a sentence', `Backup for the treasury wallet: ${words.join(' ')} (keep safe)`],
    ['24 words', [...words, ...words].join(' ')],
  ])
    assert.equal(found(text), 'economy.note', how);
  // a 64-byte key in hex, bare and with 0x
  const hex = 'ab'.repeat(64);
  assert.equal(found(hex), 'economy.note');
  assert.equal(found(`key 0x${hex}`), 'economy.note');
  // Not secrets: eleven such words, a description, a hash of 32 bytes in hex, an address, a longer run of hex.
  for (const [what, text] of [
    ['eleven words', words.slice(0, 11).join(' ')],
    [
      'a description',
      'Win a legendary sword, a shield and a dragon egg by opening the golden chest in the forest at night',
    ],
    ['words broken by ordinary ones', `${words.slice(0, 8).join(' ')} and then ${words.slice(8).join(' ')}`],
    ['a 32-byte hash', 'cd'.repeat(32)],
    ['an address', '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T'],
    ['hex that is not 64 bytes', 'ef'.repeat(80)],
  ])
    assert.equal(found(text), '', what);
  // every example the package ships is clean
  for (const name of ['coin-flip-arena', 'shelter-fair', 'stakers-draw', 'guild-missions', 'partner-vault'])
    assert.deepEqual(
      findSecrets(JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'))),
      [],
      name,
    );
});

test('a spec the check passes can be planned: a recipe’s roll on a box that is gone, and a cooldown past what a raise holds, are refused', async () => {
  const { check } = await import('../economy/check.mjs');
  const { plan } = await import('../economy/plan.mjs');
  const NOW = 1_790_000_000;
  const ex = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
  const said = spec => check(spec, { now: NOW }).refusals.map(x => `${x.code} ${x.where}`);
  // A recipe that rolls a box on a collectible it keeps, the box taken out of the spec. The check passed it, and going
  // live stopped with WrongRecord after four transactions had landed.
  const heroes = ex('hero-trials');
  assert.deepEqual(said(heroes), []);
  const recipe = heroes.recipes.findIndex(r => (r.out ?? []).some(o => o.gives === 'roll' && o.on !== undefined));
  const line = heroes.recipes[recipe].out.findIndex(o => o.gives === 'roll' && o.on !== undefined);
  const gone = heroes.recipes[recipe].out[line].box;
  heroes.boxes = heroes.boxes.filter(b => b.key !== gone);
  const refused = check(heroes, { now: NOW }).refusals.filter(
    x => x.code === 'E-RECIPE' && x.where.endsWith(`.out[${line}].box`),
  );
  assert.equal(refused.length, 1, JSON.stringify(said(heroes)));
  assert.match(refused[0].message, new RegExp(`gives a roll of “${gone}”, which is no box`));
  // A cooldown is a raise's amount, a signed number: 5,000 weeks passed the check and the plan threw on it.
  const seasons = ex('halving-seasons');
  const item = seasons.items.findIndex(it => it.life);
  seasons.items[item].life.cooldown = '5000w';
  assert.deepEqual(
    said(seasons)
      .filter(x => x.startsWith('E-TIME'))
      .map(x => x.split('.').slice(-2).join('.')),
    ['life.cooldown'],
  );
  seasons.items[item].life.cooldown = '3000w';
  assert.deepEqual(said(seasons), []);
  assert.doesNotThrow(() => plan(seasons, { now: NOW }));
});

test('a fixed supply covers everything going live puts in: pools, lotteries, farms and sealed schedules together', async () => {
  const { check } = await import('../economy/check.mjs');
  const NOW = 1_790_000_000;
  const coin = () => JSON.parse(readFileSync(new URL('../../examples/community-coin.json', import.meta.url), 'utf8'));
  const said = spec =>
    check(spec, { now: NOW }).refusals.map(x => `${x.code} ${x.where.split('.').slice(-1)[0]}: ${x.message}`);
  assert.deepEqual(said(coin()), []);
  // The example's pools take 40,000,000 of a supply of 100,000,000 and its sealed schedule 24,000,000 more.
  const base = coin();
  const ember = base.tokens.find(t => t.key === 'ember');
  const pools = base.pools.filter(p => p.currency === 'ember').reduce((n, p) => n + (p.seed ?? 0), 0);
  const sealed = base.schedules.find(sc => sc.sealed);
  assert.ok(pools + sealed.fund <= ember.supply);
  // The schedule's funds alone past what the pools leave: the check passed it, and going live stopped at the transfer
  // that ran short, two transactions in.
  for (const fund of [ember.supply - pools + 1, 240_000_000, 24_000_000_000]) {
    const spec = coin();
    spec.schedules.find(sc => sc.sealed).fund = fund;
    spec.schedules.find(sc => sc.sealed).amount = fund / 12;
    const refused = said(spec).filter(x => x.startsWith('E-TOKEN supply'));
    assert.equal(refused.length, 1, `${fund}: ${JSON.stringify(said(spec))}`);
    assert.match(refused[0], /Going live puts in more of “ember” than its whole supply of 100000000: .* come to \d+/);
  }
  // A smaller supply than the pools and the schedule take together, though more than the pools alone.
  const small = coin();
  small.tokens.find(t => t.key === 'ember').supply = pools + sealed.fund - 1;
  assert.equal(said(small).filter(x => x.startsWith('E-TOKEN supply')).length, 1);
  // Exactly the supply is taken: allowed.
  const exact = coin();
  exact.tokens.find(t => t.key === 'ember').supply = pools + sealed.fund;
  assert.deepEqual(
    said(exact).filter(x => x.startsWith('E-TOKEN supply')),
    [],
  );
});
