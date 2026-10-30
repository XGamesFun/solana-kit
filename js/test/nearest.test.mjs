// What an agent hears when loot can't do part of an idea (the limit and its nearest versions), and the one cost a
// player really pays. In the live evals agents ended on "loot can't" where a nearest version existed, and added up
// player costs by hand, differently each time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { cost, setupCost } from '../economy/cost.mjs';
import { example, hows, limits, search } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { CANNOT, guideText, HOW } from '../economy/guide.mjs';
import { simulate } from '../economy/simulate.mjs';
import { SCHEMA } from '../economy/validate.mjs';

const NOW = 1_790_000_000;
const WALLET = '8yPDcN7S2mxbFrQLqqGfUkg3fTBbZ8ZqYqJ5AD4QK6Ag';

test('every limit says why and offers at least one nearest version', () => {
  for (const c of CANNOT) {
    assert.ok(c.why && c.words, c.what);
    assert.ok(c.nearest.length >= 1, c.what);
  }
  assert.match(guideText(), /Nearest: /);
});

test('a person’s own words find the limit and its nearest versions, and ordinary asks find none', () => {
  const first = (q) => limits(q)[0]?.what ?? '';
  assert.match(first('5-card packs for 0.004 SOL'), /more than three prizes/);
  assert.ok(limits('5-card packs')[0].nearest[0].includes('roll'), 'a nested roll is the nearest version of a big pack');
  assert.match(first('guild dues treasury 3 of 5 officers'), /multisig/);
  assert.match(first('a weekly top tipper badge'), /top tipper/);
  assert.match(first('lend SOL against my NFT'), /lending/);
  for (const q of ['gacha with pity', 'staking with lock tiers', 'a weekly lottery']) assert.deepEqual(limits(q), [], q);
});

// Limits that earlier versions had and later ones removed: agents kept repeating them (one built a listing per partner
// because xsolana_examples said a sale's payee is fixed, though the schema takes "chosen").
test('what the program does is never offered as a limit, and the words find how it is done', () => {
  for (const q of ['referral links so streamers get 10% of each sale', 'one ticket per wallet', 'rent to the plot the buyer builds on', 'all or nothing crowdfund with refunds', 'dutch drop every 10 minutes no matter how many sold', 'promo codes on flyers'])
    assert.deepEqual(limits(q).map((l) => l.what).filter((w) => /referr|per-wallet|plot|crowdfund|dutch|promo/i.test(w)), [], q);
  assert.match(hows('referral links so streamers get 10% of each sale')[0]?.how ?? '', /"chosen"/);
  assert.match(hows('rent to whoever owns the plot')[0]?.how ?? '', /chosen:<item key>/);
  assert.match(hows('a monthly membership pass that renews')[0]?.how ?? '', /fromNow/);
  assert.match(hows('all or nothing crowdfund')[0]?.how ?? '', /minPot/);
  assert.match(guideText(), /look impossible but are one field/);
  assert.doesNotMatch(guideText(), /loot program 0\.12/);
});

// A capability that matches the person's words better is the answer: a weaker "can't" beside it only misleads (an
// agent reads it as "loot can't" next to the field that does it). A tie shows both.
test('xsolana_examples shows a “can’t” only when it matches at least as well as the best “how”', () => {
  const what = (list) => list.map((x) => x.what);
  // the renewing recipe matches “monthly pass” better than “recurring pulls” does: only the recipe
  assert.match(what(limits('monthly pass')).join(), /recurring pulls/, 'the limit matches on its own');
  assert.match(what(search('monthly pass').hows)[0], /renewing/);
  assert.deepEqual(search('monthly pass').limits, []);
  // “monthly” alone matches both the same: both show
  assert.ok(what(search('monthly').hows).some((w) => /renewing/.test(w)));
  assert.match(what(search('monthly').limits).join(), /recurring pulls/);
  // a real limit that matches best still shows, beside any weaker “how”
  for (const [q, re] of [['lend SOL against my NFT', /lending/], ['pump.fun creator coin with sell back', /market/], ['guild dues and 3 of 5 officers approve spending', /multisig/], ['a weekly top tipper badge', /top tipper/]]) assert.match(search(q).limits[0]?.what ?? '', re, q);
  // each capability is found first by its own words, and no limit is stronger than it
  for (const h of HOW) {
    const r = search(h.words);
    assert.equal(r.hows[0]?.what, h.what, h.words);
    assert.deepEqual(r.limits, [], h.words);
  }
});

// The schema's names: every property, enum and const value, and each word of a pattern's alternatives.
function schemaNames() {
  const names = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node.properties ?? {})) names.add(k);
    for (const v of [...(node.enum ?? []), ...(node.const !== undefined ? [node.const] : [])]) if (typeof v === 'string') names.add(v);
    if (typeof node.pattern === 'string') for (const w of node.pattern.match(/[a-z][A-Za-z]*/g) ?? []) names.add(w);
    for (const v of Object.values(node)) walk(v);
  })(SCHEMA);
  return names;
}

test('every field a “looks impossible but isn’t” answer names in code is in the schema', () => {
  const names = schemaNames();
  for (const h of HOW) {
    const named = new Set();
    for (const [, code] of h.how.matchAll(/`([^`]+)`/g)) {
      // the keys of a JSON snippet (`{ "noLoss": true }`) and a bare field or path (`perWalletEach`, `life.uses`);
      // runtime calls (`openListingIx`, `app.buy(…)`) are not fields
      for (const [, key] of code.matchAll(/"([A-Za-z]+)":/g)) named.add(key);
      if (/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)*$/.test(code) && !/Ix$/.test(code) && !code.startsWith('app.')) for (const part of code.split('.')) named.add(part);
    }
    for (const n of named) assert.ok(names.has(n), `${h.what}: the schema has no “${n}”`);
  }
  // the check reads what it should: a field that is gone is caught
  assert.ok(names.has('minPot') && names.has('perWalletEach') && names.has('use') && !names.has('perWalletDaily'));
});

test('a referral share reads as the buyer’s choice, and a list grant that repeats is warned about', () => {
  const ex = explainEconomy(example('shelter-fair').spec, { now: NOW });
  const text = typeof ex === 'string' ? ex : ex.text ?? JSON.stringify(ex);
  assert.match(text, /the wallet the buyer names/);
  assert.match(text, /the “plot” the buyer names/);
  assert.doesNotMatch(text, /to the account …/);
  const g = { version: 2, network: 'devnet', name: 'Monthly', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }, { key: 'gem', source: 'game', name: 'Gem', symbol: 'GEM', decimals: 6 }], pools: [{ key: 'p', currency: 'gem', seed: 100 }], grants: [{ key: 'g', name: 'Monthly', prize: { gives: 'tokens', amount: 1, from: 'pool:p' }, list: [WALLET], limits: { perWallet: 12, perWalletEach: { count: 1, every: '30d' } } }] };
  assert.ok(check(g, { now: NOW }).warnings.some((w) => w.code === 'W-LIST-ONCE'));
});

test('each player action has one “in all” cost: the price, the fee, the oracle, the network and lasting rent', () => {
  const spec = example('coin-flip-arena').spec;
  const flip = cost(spec, { now: NOW }).actions.find((a) => a.part === 'box:flip');
  // 0.1 SOL, the 0.002 player fee, 0.0005 to the oracle, two signatures (the open and the settle).
  assert.equal(flip.inAllSol, 0.10251);
  assert.ok(flip.holdSol > flip.inAllSol, 'the escrow is held while the order is open');
  assert.match(flip.inAll, /about 0\.10251 SOL in all/);
  // A shop collectible is bought in one signature (`buy`), and its rent never comes back: it is in the number.
  const shop = simulate({ version: 2, network: 'devnet', name: 'Shop', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], items: [{ key: 'hat', name: 'Hat', price: 0.003 }] }, { now: NOW }).items[0];
  assert.equal(shop.realCost.totalSol, 0.008105); // 0.003 + 0.002 fee + 0.000005 network + 0.0031 rent
});

test('a change to a live economy doesn’t pay its seeds or grant funds again', () => {
  const spec = example('coin-flip-arena').spec;
  const plan = { transactions: [{ signers: ['owner'], steps: [{ id: 'box:flip', creates: [] }] }], approvals: 1 };
  const s = setupCost(plan, spec);
  assert.deepEqual(s.seeds, {});
  // The box written: the project fee and one signature.
  assert.equal(s.totalSol, 0.000015);
});

test('a tip of any amount, and another wallet as the treasury, check and explain', () => {
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Shelter raffle',
    currency: 'sol',
    treasury: `wallet:${WALLET}`,
    tokens: [{ key: 'sol', source: 'sol' }],
    payments: [{ key: 'tip', name: 'Tip', amount: 0.001, any: true }],
  };
  const verdict = check(spec, { now: NOW });
  assert.ok(verdict.ok, JSON.stringify(verdict.refusals));
  const text = explainEconomy(spec, { now: NOW }).text;
  assert.match(text, /at least 0\.001 SOL/);
  assert.match(text, /the treasury \(the wallet 8yPD…/);
  assert.equal(check({ ...spec, treasury: 'shelter' }, { now: NOW }).ok, false);
});

test('voucher campaign limits disclose the bounded lifetime round history', () => {
  const spec = { version: 2, network: 'devnet', name: 'Rewards', currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }], pools: [{ key: 'prizes', currency: 'sol', seed: 1 }], grants: [{ key: 'wins', name: 'Wins', gives: { pool: 'prizes', amount: 0.001 }, vouchers: [WALLET], limits: { perWallet: 1000 }, fund: 1 }] };
  const oversized = check(spec, { now: NOW });
  assert.ok(oversized.ok, JSON.stringify(oversized.refusals));
  assert.ok(oversized.warnings.some((warning) => warning.code === 'W-GRANT-CAPACITY' && warning.message.includes('256')));
  spec.grants[0].limits.perWallet = 256;
  assert.ok(!check(spec, { now: NOW }).warnings.some((warning) => warning.code === 'W-GRANT-CAPACITY'));
  spec.grants[0].vouchers = [];
  spec.grants[0].limits.perWallet = 1000;
  assert.ok(!check(spec, { now: NOW }).warnings.some((warning) => warning.code === 'W-GRANT-CAPACITY'), 'open claims consume no voucher round slots');
});
