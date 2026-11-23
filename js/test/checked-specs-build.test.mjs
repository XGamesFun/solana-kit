// What the checker calls ready, the other tools can build. Every number, duration, amount and time a spec can write
// is found by walking the schema beside each bundled example (and one spec of the parts no example has), and pushed
// to values the schema takes and the program does not: past 4 bytes, past 8, past what a date holds, finer than a
// token counts. Whatever the checker answers then, it answers: it does not throw, and its simulation runs. A spec it
// passes is planned, costed and explained without a throw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { examples } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { plan } from '../economy/plan.mjs';
import { SCHEMA, validate } from '../economy/validate.mjs';

const NOW = 1_800_000_000;
const W = '5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T';
const N = 'So11111111111111111111111111111111111111113';

/** The parts no bundled example has: tables and drawn traits, a pack of slots, a falling box, limits by person and by
 * window, gates by stake and by attribute, bids and stakes of NFTs, a lottery's expected rounds, a grant's server limit. */
const PARTS_NO_EXAMPLE_HAS = {
  version: 2,
  network: 'devnet',
  name: 'Parts no example has',
  currency: 'gold',
  keys: { issuer: W },
  tokens: [
    { key: 'gold', source: 'project', name: 'Gold', symbol: 'GOLD', decimals: 6 },
    { key: 'usd', source: 'existing', mint: N, decimals: 6, symbol: 'USD', name: 'Dollar' },
  ],
  collections: [N],
  tables: [
    {
      key: 'colours',
      rows: [
        { label: 'red', weight: 3 },
        { label: 'gold', weight: 1, stock: 10 },
      ],
    },
    { key: 'numbers', kind: 'numbers', rows: [{ weight: 1 }, { weight: 1 }] },
  ],
  pools: [{ key: 'prizes', currency: 'gold', seed: 100000 }],
  items: [
    {
      key: 'pet',
      name: 'Pet',
      kind: 'collectible',
      drawn: [
        { attribute: 'colour', table: 'colours' },
        { attribute: 'power', min: 1, max: 100 },
        { attribute: 'n', table: 'numbers' },
      ],
    },
    {
      key: 'pass',
      name: 'Pass',
      kind: 'collectible',
      price: 5,
      gate: { item: 'pet', attribute: 'power', atLeast: 10 },
      perWalletEach: { count: 2, every: '1d' },
    },
    { key: 'badge', name: 'Badge', kind: 'collectible', price: 1, perPersonEach: { count: 1, every: '1w' } },
    { key: 'card', name: 'Card', kind: 'collectible' },
  ],
  boxes: [
    { key: 'egg', name: 'Egg', price: 10, outcomes: [{ gives: 'item', item: 'pet', chance: 100 }] },
    {
      key: 'pack',
      name: 'Pack',
      price: 20,
      fall: { step: 1, every: '1h', floor: 5, start: 'publish' },
      gate: { staked: { farm: 'bank', atLeast: 10 } },
      perPersonEach: { count: 3, every: '1d' },
      slots: [
        { count: 2, from: [0, 1], share: 60 },
        { count: 1, from: [2], share: 40 },
      ],
      outcomes: [
        { gives: 'item', item: 'card', chance: 50 },
        { gives: 'tokens', from: 'pool:prizes', amount: 5, chance: 30 },
        { gives: 'nothing', chance: 20 },
      ],
    },
  ],
  recipes: [
    {
      key: 'swap',
      name: 'Swap',
      in: [{ takes: 'pay', amount: 1, to: 'burn' }],
      out: [{ gives: 'item', item: 'card' }],
      perWalletEach: { count: 5, every: '1d' },
    },
    {
      key: 'swap-two',
      name: 'Swap two',
      in: [{ takes: 'pay', amount: 2, to: 'burn' }],
      out: [{ gives: 'item', item: 'card' }],
      perPersonEach: { count: 5, every: '1d' },
    },
  ],
  farms: [
    {
      key: 'bank',
      name: 'Bank',
      stakes: 'gold',
      rate: { perDay: 0.01, minted: true },
      tiers: [{ lock: '7d', multiplier: 1 }],
    },
    {
      key: 'kennel',
      name: 'Kennel',
      stakes: 'collectibles',
      item: 'pet',
      rate: { perDay: 1, minted: true },
      growth: [{ attribute: 'xp', perDay: 10, levels: [10, 100, 1000] }],
    },
  ],
  lotteries: [
    {
      key: 'weekly',
      name: 'Weekly',
      price: 1,
      pot: 0,
      places: [50, 30],
      every: '7d',
      expect: { rounds: 2, entries: 500 },
      perWalletEach: { count: 40, every: '1h' },
      gate: { item: 'pet', attribute: 'power', atLeast: 5 },
    },
    {
      key: 'monthly',
      name: 'Monthly',
      price: 1,
      rest: 'treasury',
      places: [50],
      every: '30d',
      perPersonEach: { count: 10, every: '1d' },
    },
  ],
  contests: [
    {
      key: 'duel',
      name: 'Duel',
      sides: 2,
      entriesClose: '1d',
      resultDue: '2d',
      gate: { item: 'pet', attribute: 'power', atLeast: 1 },
    },
    {
      key: 'pets',
      name: 'Pet fight',
      sides: 2,
      entriesClose: '1d',
      resultDue: '2d',
      stakeNft: { item: 'pet', attribute: 'power', atLeast: 1 },
      losersEach: 1,
      gate: { staked: { farm: 'bank', atLeast: 1 } },
    },
  ],
  auctions: [
    {
      key: 'lot',
      name: 'Lot',
      lot: { item: 'card' },
      reserve: 1,
      runs: '1d',
      bidNfts: { item: 'pet', attribute: 'power', atLeast: 1 },
      gate: { item: 'pet', attribute: 'power', atLeast: 1 },
    },
    {
      key: 'second-lot',
      name: 'Second lot',
      lot: { item: 'card' },
      reserve: 1,
      runs: '1d',
      gate: { staked: { farm: 'bank', atLeast: 1 } },
    },
  ],
  grants: [
    {
      key: 'quest',
      name: 'Quest',
      gives: { pool: 'prizes', amount: 5 },
      vouchers: [W],
      limits: { perPersonEach: { count: 1, every: '1d' }, tokens: 1000 },
      serverLimit: { per: 'person', amount: 5, claims: 1, every: '1d', total: 1000 },
      gate: { staked: { farm: 'bank', atLeast: 1 } },
      fund: 0.1,
    },
  ],
  offchain: [{ key: 'boost', takes: 'gold', gives: 'farm:bank', rate: 10 }],
  scenario: { days: 30, holders: { usd: { supply: 1000000, owner: 1000, largest: 5000 } } },
};

/** What each kind of value is pushed to. A number the schema bounds is pushed to its bound. */
const EXTREMES = {
  // past 4 bytes as a number and as text, past what a date holds, and past 8 bytes
  duration: [4_294_967_296, '5000000000s', '99999999w', 1e21],
  // past 8 bytes as a number and as text, and finer than most tokens count (in one of 9 decimals, the most 8 bytes hold)
  amount: [1e21, '99999999999999999999', '18446744073.709551615'],
  // no date of the calendar, past what a date holds, and past 8 bytes
  time: ['2026-13-45T25:61Z', 'publish+99999999w', 'publish+99999999999999999999w'],
  // past 4 bytes, and past 8
  number: [4_294_967_296, 1e21],
};
/** How many examples a field is pushed in: one the schema bounds in few, any other in more. */
const EXAMPLES_A_FIELD = { bounded: 2, open: 4 };

const NAMED = { '#/$defs/duration': 'duration', '#/$defs/amount': 'amount', '#/$defs/time': 'time' };
const follow = node => {
  while (node?.$ref && !NAMED[node.$ref])
    node = node.$ref
      .slice(2)
      .split('/')
      .reduce((n, k) => n?.[k], SCHEMA);
  return node;
};

/** The values a schema node's field is pushed to (none when it takes no number, duration, amount or time), and whether
 * the schema bounds every one of them. */
function pushes(node, found = { values: new Set(), bounded: true }) {
  node = follow(node);
  if (!node) return found;
  if (node.$ref) {
    for (const v of EXTREMES[NAMED[node.$ref]]) found.values.add(v);
    found.bounded = false;
    return found;
  }
  for (const form of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) pushes(form, found);
  if (node.type === 'integer' || node.type === 'number') {
    if (node.maximum !== undefined) found.values.add(node.maximum);
    else {
      for (const v of EXTREMES.number) found.values.add(v);
      found.bounded = false;
    }
  }
  return found;
}

/** Every field of `value` the schema lets hold a number, duration, amount or time, written or not: [{ path, field (its
 * path with no list index or map key), values, bounded }]. */
function fields(value, node, path = [], out = []) {
  node = follow(node);
  if (!node || node.$ref) return out;
  const forms = node.anyOf ?? node.oneOf;
  if (forms) {
    const fits = forms.find(form => validate(value, form, SCHEMA).length === 0);
    if (fits) fields(value, fits, path, out);
    if (!node.properties) return out;
  }
  const field = step => [...path.map(s => (typeof s === 'number' ? '*' : s)), step].join('.');
  const add = (step, name, sub) => {
    const { values, bounded } = pushes(sub);
    if (values.size) out.push({ path: [...path, step], field: field(name), values: [...values], bounded });
  };
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (typeof v !== 'object') add(i, '*', node.items);
      fields(v, node.items, [...path, i], out);
    });
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, sub] of Object.entries(node.properties ?? {})) {
    // (the live section is what going live wrote, not what a person writes)
    if (key === 'live' && !path.length) continue;
    add(key, key, sub);
    if (Object.hasOwn(value, key)) fields(value[key], sub, [...path, key], out);
  }
  if (typeof node.additionalProperties === 'object')
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(node.properties ?? {}, key)) continue;
      add(key, '*', node.additionalProperties);
      fields(v, node.additionalProperties, [...path, key], out);
    }
  return out;
}

/** `spec` with the value at `path` set to `value`. */
function pushed(spec, path, value) {
  const copy = structuredClone(spec);
  let at = copy;
  for (const step of path.slice(0, -1)) at = at[step];
  at[path.at(-1)] = value;
  return copy;
}

/** `run`'s result, or the error it throws in a line. */
const orThrown = (tool, run) => {
  try {
    return run();
  } catch (error) {
    return { thrown: `${tool} threw: ${error.message}` };
  }
};

/**
 * What goes wrong with a spec, in a line each (`wrong`), and whether the check passes it (`passed`). The spec is
 * explained, which checks it, simulates it, plans it and costs it on the way (the test below holds that). Wrong: a
 * tool that throws (each is then run by itself, to name it), a simulation that stopped, and a spec refused with no
 * field named, only because it could not be built (E-BUILD).
 */
function tried(spec) {
  const said = orThrown('explain', () => explainEconomy(spec, { now: NOW }));
  if (said.thrown) {
    const each = [
      orThrown('check', () => check(spec, { now: NOW })),
      orThrown('plan', () => plan(spec, { now: NOW })),
      orThrown('cost', () => cost(spec, { now: NOW })),
      said,
    ];
    return { passed: false, wrong: each.map(x => x.thrown).filter(Boolean) };
  }
  const stopped = said.warnings.find(w => w.code === 'W-SIMULATION');
  const unbuilt = (said.refusals ?? []).find(r => r.code === 'E-BUILD');
  return {
    passed: said.ok,
    wrong: [
      ...(stopped ? [`the check’s simulation stopped: ${stopped.message.slice(0, 120)}`] : []),
      ...(unbuilt ? [`no check names the value: ${unbuilt.message.slice(0, 120)}`] : []),
    ],
  };
}

const specs = [...examples(), { name: 'parts no example has', spec: PARTS_NO_EXAMPLE_HAS }];

test('to explain a spec is to plan it and cost it: the explanation quotes the cost’s total, and the cost counts the plan’s transactions', () => {
  for (const { name, spec } of specs) {
    assert.deepEqual(check(spec, { now: NOW }).refusals, [], name);
    const planned = plan(spec, { now: NOW });
    const costed = cost(spec, { now: NOW });
    const said = explainEconomy(spec, { now: NOW });
    assert.ok(planned.ok && costed.ok && said.ok, name);
    assert.equal(costed.setup.transactions, planned.transactions.length, name);
    assert.equal(said.setupSol, costed.setup.totalSol, name);
  }
});

test('a spec the check passes is planned, costed and explained, however far a number, duration, amount or time in it is pushed', () => {
  const pushedIn = new Map();
  const wrong = [];
  let passed = 0;
  for (const { name, spec } of specs) {
    assert.deepEqual(tried(spec), { passed: true, wrong: [] }, `${name} as it is`);
    const seen = new Set();
    for (const { path, field, values, bounded } of fields(spec, SCHEMA)) {
      // The first place of a field in each example, in so many examples.
      if (seen.has(field)) continue;
      seen.add(field);
      const count = pushedIn.get(field) ?? 0;
      if (count >= (bounded ? EXAMPLES_A_FIELD.bounded : EXAMPLES_A_FIELD.open)) continue;
      pushedIn.set(field, count + 1);
      for (const value of values) {
        const result = tried(pushed(spec, path, value));
        if (result.passed) passed += 1;
        for (const fault of result.wrong) wrong.push(`${name}: ${path.join('.')} = ${JSON.stringify(value)}: ${fault}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
  // The sweep reaches the tools: many pushed values are in range for their field, or only warned of.
  assert.ok(pushedIn.size > 200 && passed > 300, `${pushedIn.size} fields pushed, ${passed} specs passed the check`);
});
