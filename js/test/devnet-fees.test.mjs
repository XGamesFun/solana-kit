// Devnet's player fee is four times mainnet's (model.mjs FEES_ON), and devnet SOL is play money. A spec on devnet is
// warned of the fee as mainnet charges it, with devnet's beside it, and its cost says both.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { cost, explainCost } from '../economy/cost.mjs';
import { FEES_ON } from '../economy/model.mjs';
import { withCluster } from '../mcp/with-cluster.mjs';

const NOW = 1_790_000_000;
const ladder = JSON.parse(readFileSync(new URL('../../examples/level-ladder.json', import.meta.url), 'utf8'));
const priced = (network, amount) => ({
  ...ladder,
  network,
  payments: [{ ...ladder.payments[0], amount }],
});
const fee = (network, amount) =>
  withCluster(network, () => check(priced(network, amount), { now: NOW }).warnings.find(w => w.code === 'W-FEE'));

test('the fees the tools quote: 0.002 SOL a player action on devnet, 0.0005 on mainnet, 0.00001 a project action', () => {
  assert.equal(FEES_ON.devnet.player, 2_000_000n);
  assert.equal(FEES_ON.mainnet.player, 500_000n);
  assert.equal(FEES_ON.devnet.project, 10_000n);
  assert.equal(FEES_ON.mainnet.project, 10_000n);
});

test('a devnet price is warned of the fee as mainnet charges it, with devnet’s beside it', async () => {
  const w = await fee('devnet', 0.01);
  assert.match(w.message, /On mainnet that is 0\.0005 SOL, 5\.0% on top of its 0\.01 SOL price\./);
  assert.match(w.message, /on devnet, where the fee is 0\.002 SOL \(20\.0%\) and SOL is play money/);
  // 0.1 SOL: 2% of it on devnet, 0.5% on mainnet, under the 1% a warning starts at
  assert.equal(await fee('devnet', 0.1), undefined);
  const m = await fee('mainnet', 0.01);
  assert.match(m.message, /player fee of 0\.0005 SOL: 5\.0% on top of its 0\.01 SOL price\.$/);
  assert.equal(await fee('mainnet', 0.1), undefined);
});

test('the cost of a devnet economy says mainnet’s player fee too', async () => {
  const c = await withCluster('devnet', () => cost(priced('devnet', 0.01), { now: NOW }));
  assert.equal(c.fees.network, 'devnet');
  assert.equal(c.fees.playerSol, 0.002);
  assert.equal(c.fees.mainnetPlayerSol, 0.0005);
  assert.match(
    explainCost(c),
    /The player fee is 0\.002 SOL a player action on devnet and 0\.0005 SOL on mainnet, so each player action above costs 0\.0015 SOL less there\./,
  );
  const m = await withCluster('mainnet', () => cost(priced('mainnet', 0.01), { now: NOW }));
  assert.equal(m.fees.mainnetPlayerSol, undefined);
  assert.doesNotMatch(explainCost(m), /devnet's fees/);
});
