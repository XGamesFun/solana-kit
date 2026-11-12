// From what a person wants to the specs that do it: requirements as tests, bridges as builds, every combination
// checked, and an honest answer when nothing keeps every want.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { design, describeDesign } from '../economy/design.mjs';

const NOW = Date.parse('2026-11-12T00:00:00Z') / 1000;
const VOUCHER = 'HUQP6e86RqbkpPoKaAddwpe8bn81jVMqeTZbrrXm5VpD';

test('a raffle in any of several currencies: one entry token they each buy, crafted in the one purchase', () => {
  const base = {
    version: 2,
    network: 'devnet',
    name: 'Any-coin raffle',
    currency: 'sol',
    tokens: [
      { key: 'sol', source: 'sol' },
      {
        key: 'usdc',
        source: 'existing',
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        symbol: 'USDC',
        decimals: 6,
      },
      { key: 'bonk', source: 'existing', mint: VOUCHER, symbol: 'BONK', decimals: 5 },
    ],
    collection: { name: 'Raffle' },
    items: [{ key: 'prize', name: 'Signed card', supply: 1 }],
    lotteries: [
      {
        key: 'raffle',
        name: 'The raffle',
        places: [{ percent: 0, prize: { gives: 'item', item: 'prize' } }],
        firstDraw: '2026-11-20T00:00:00Z',
        rest: 'treasury',
      },
    ],
    scenario: { days: 7, players: 300, perDay: { 'lottery:raffle': 100 } },
  };
  const reqs = [
    {
      kind: 'pay-in',
      route: 'raffle',
      currencies: [
        { token: 'sol', amount: 0.1 },
        { token: 'usdc', amount: 15 },
        { token: 'bonk', amount: 500000 },
      ],
    },
    { kind: 'one-approval', route: 'raffle' },
    { kind: 'one-draw', route: 'raffle' },
  ];
  const r = design(base, reqs, { now: NOW });
  assert.ok(r.allKept);
  const [best] = r.candidates;
  assert.equal(best.bridges[0], 'entry-token');
  assert.equal(best.spec.lotteries[0].currency, 'raffle-entry');
  assert.equal(best.spec.recipes.length, 3, 'one recipe a currency');
  // Wanting refunds of what was paid too: no design keeps everything, and the trade is said.
  const more = design(base, [...reqs, { kind: 'refund-as-paid', route: 'raffle' }], { now: NOW });
  assert.equal(more.allKept, false);
  const text = describeDesign(more, [...reqs, { kind: 'refund-as-paid', route: 'raffle' }]);
  assert.match(text, /No design keeps all of them/);
  assert.match(text, /an entry bought with one can be taken back in another/);
  assert.match(text, /Give up “There is one draw for the prize”/);
  // Each option comes with one sentence for the person, and the turn ends with the choice.
  assert.match(
    text,
    /Say: “Players buy an entry with 0\.1 SOL or 15 USDC or 500000 BONK, and buying it rides in the ticket purchase: one approval/,
  );
  assert.match(text, /end your turn there: build none until they choose/);
});

test('a burn that a cancel must refund, and a free entry that is not money: what has to give', () => {
  const base = {
    version: 2,
    network: 'devnet',
    name: 'Prize Day',
    currency: 'bubl',
    tokens: [
      { key: 'sol', source: 'sol' },
      { key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL', decimals: 0, supply: 2_000_000 },
    ],
    pools: [{ key: 'taps', currency: 'bubl', seed: 2_000_000 }],
    items: [{ key: 'winner', name: 'Prize Ticket', soulbound: true, supply: 1 }],
    grants: [
      {
        key: 'free-entry',
        name: 'Free entry',
        vouchers: [VOUCHER],
        trust: 'decides',
        limits: { perPerson: 1, perWallet: 1 },
      },
    ],
    lotteries: [
      {
        key: 'draw',
        name: 'Prize draw',
        places: [{ percent: 0, prize: { gives: 'item', item: 'winner' } }],
        firstDraw: '2026-11-13T00:00:00Z',
        minSold: 2,
      },
    ],
    scenario: { days: 1, players: 2, perDay: { 'lottery:draw': 8 } },
  };
  const reqs = [
    { kind: 'pay-in', route: 'draw', currencies: [{ token: 'bubl', amount: 100 }] },
    { kind: 'burn', route: 'draw' },
    { kind: 'refund-as-paid', route: 'draw' },
    { kind: 'free-entry', route: 'draw', grant: 'free-entry', perPerson: 1, spendable: false },
    { kind: 'one-approval', route: 'draw' },
    { kind: 'one-draw', route: 'draw' },
  ];
  const r = design(base, reqs, { now: NOW });
  assert.equal(r.allKept, false);
  const choices = r.conflicts.map(c => c.giveUp.join('+')).sort();
  assert.deepEqual(choices, ['free-entry', 'one-draw', 'refund-as-paid']);
  // Giving up a spendable free entry, the best keeps the burn at settlement and refunds what was paid.
  const settle = r.conflicts.find(c => c.giveUp.join() === 'free-entry').best;
  assert.deepEqual(settle.bridges.slice(0, 2), ['direct', 'at-settle']);
  assert.equal(settle.spec.lotteries[0].rest, 'burn');
});

const example = name => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));

test('a sale: any of two currencies at a fixed price, and a fair share of something scarce, needs a list of people', () => {
  const s = example('duel-arena');
  const reqs = [
    {
      kind: 'pay-in',
      route: 'arena-deed',
      currencies: [
        { token: s.currency, amount: 100 },
        { token: 'sol', amount: 1 },
      ],
    },
    { kind: 'fixed-price', route: 'arena-deed' },
    { kind: 'fair-scarce', route: 'arena-deed', perPerson: 1 },
    { kind: 'one-approval', route: 'arena-deed' },
  ];
  const r = design(s, reqs, { now: NOW });
  assert.equal(r.family, 'sale');
  assert.ok(r.allKept);
  const [best] = r.candidates;
  assert.deepEqual(best.bridges, ['box-each', 'allowlist']);
  assert.equal(best.spec.boxes.filter(b => b.key.startsWith('arena-deed-')).length, 2, 'a box a currency');
  assert.match(best.needs[0], /allowlist/);
  assert.match(describeDesign(r, reqs), /Needs from you: the allowlist/);
});

test('a reward with no server, one a person and no gain for a script: a list, or a server that decides', () => {
  const s = example('stakers-draw');
  const route = s.grants[0].key;
  const reqs = [
    { kind: 'per-person', route, serverKeys: [VOUCHER] },
    { kind: 'no-server', route },
    { kind: 'bot-proof', route },
    { kind: 'bounded', route, total: 5000 },
  ];
  const r = design(s, reqs, { now: NOW });
  assert.equal(r.family, 'reward');
  assert.equal(r.allKept, false);
  assert.ok(
    r.inPart.some(x => x.best.bridges[0] === 'list'),
    'a list keeps every want, a script only in part',
  );
  assert.ok(r.conflicts.some(c => c.giveUp.join() === 'no-server' && c.best.bridges[0] === 'voucher-decides'));
});

test('staking with a cap on what it pays and a rate a staker can count on: what gives', () => {
  const s = example('paper-hands-farm');
  const reqs = [
    { kind: 'emission-cap', route: 'farm', total: 1_000_000 },
    { kind: 'predictable', route: 'farm' },
    { kind: 'no-lock', route: 'farm' },
  ];
  const r = design(s, reqs, { now: NOW });
  assert.equal(r.family, 'earn');
  // A fixed rate on a token nobody caps can't be bounded; a vault can, and its share moves with the stake.
  assert.equal(r.allKept, false);
  const gave = r.conflicts.map(c => c.giveUp.join('+')).sort();
  assert.deepEqual(gave, ['emission-cap', 'predictable']);
});

test('a contest with no trust in the owner’s key: a decider key, kept only in part', () => {
  const s = example('duel-arena');
  const reqs = [
    { kind: 'no-owner-trust', route: 'duel', serverKeys: [VOUCHER] },
    { kind: 'equal-stakes', route: 'duel', amount: 10 },
  ];
  const r = design(s, reqs, { now: NOW });
  assert.equal(r.family, 'contest');
  assert.deepEqual(r.candidates[0].bridges, ['decider-key', 'equal']);
  assert.equal(r.candidates[0].results[0].kept, 'partly');
  assert.deepEqual(r.candidates[0].spec.contests.find(c => c.key === 'duel').deciders, [VOUCHER]);
});
