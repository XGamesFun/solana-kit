// A farm whose seats can stop earning keeps a record of when (`["ends", farm]`): which farms do, what it costs, that a
// seat past its end is paid exactly however late it is touched, and walking a farm in parts, on the real program.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUnitLimit } from '../chain/programs.js';
import { mintToIx } from '../chain/token.js';
import * as loot from '../client/index.js';
import { cost, explainCost } from '../economy/cost.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { farmEnds, plan } from '../economy/plan.mjs';
import { solanaApp } from '../play/index.js';
import { cannotRun, PRICE, world } from './world.mjs';

const skip = cannotRun() ?? false;
const pda = loot.pda;
const NOW = 1_790_000_000;
const tier = (earns_for = 0, lock = 0) => ({ lock, bps: 10_000, earns_for });
const farmArgs = (tiers, rate = null) => ({ custody: 'Escrow', tiers, boosts: [], max_boost_bps: 0, rate });

function farmOf(w, args, id = 1, fund = 1_000_000_000_000n) {
  w.chain.send(w.creator, [
    loot.openFarmIx({ owner: w.creator, project: w.project, id, args, rewardsMint: w.mint, stakedMint: w.mint }),
  ]);
  const address = pda.farm(w.project, id);
  if (fund)
    w.chain.send(w.creator, [mintToIx({ mint: w.mint, to: pda.rewards(address), authority: w.creator, amount: fund })]);
  return address;
}
const staker = w => {
  const p = w.who();
  w.fund(p, w.mint, 100n * PRICE);
  return p;
};
const stake = (w, player, address, amount = 1_000_000n, tierAt = 0, id = 1) =>
  w.chain.send(player, [
    computeUnitLimit(1_400_000),
    loot.stakeTokensIx({ player, project: w.project, id, farm: w.read('Farm', address), amount, tier: tierAt }),
  ]);
const endsOf = (w, address) => loot.decodeEnds(w.chain.get(pda.ends(address)).data);

test('which farms keep a record: a term or an upkeep, and something to pay', { skip }, () => {
  const per = { per_day: 1000n, mints: false };
  assert.equal(loot.farmKeepsEnds({ tiers: [tier()] }), false, 'nothing stops');
  assert.equal(loot.farmKeepsEnds({ tiers: [tier(60)] }), true, 'a term, sharing what lands');
  assert.equal(loot.farmKeepsEnds({ tiers: [tier(60)], rate: per }), true, 'a term and a rate');
  assert.equal(
    loot.farmKeepsEnds({ tiers: [tier(60)], rate: { per_day: 0n } }),
    false,
    'a rate of 0 has nothing to credit',
  );
  assert.equal(loot.farmKeepsEnds({ tiers: [tier()], upkeep_key: 'fuel' }), true, 'an upkeep');

  const w = world({ seed: 'ends-which' });
  const a = farmOf(w, farmArgs([tier(60)]), 1);
  assert.equal(w.read('Farm', a).keeps_ends, true);
  assert.deepEqual(endsOf(w, a), []);
  assert.equal(w.chain.get(pda.ends(a)).data.length, loot.ENDS_HEAD_BYTES);
  const b = farmOf(w, farmArgs([tier()]), 2);
  assert.equal(w.read('Farm', b).keeps_ends, false);
  assert.equal(w.chain.get(pda.ends(b)), null, 'none made');
  const c = farmOf(w, farmArgs([tier(60)], { per_day: 0n }), 3, 0n);
  assert.equal(w.read('Farm', c).keeps_ends, false);

  // The program holds a client to it.
  const missing = loot.lootIx(
    'walk_farm',
    { most: 1 },
    { project: w.project, farm: a, rewards_mint: w.mint, ends: null },
  );
  assert.throws(() => w.chain.send(w.player, [missing]), /WrongEnds/);
  const extra = loot.lootIx(
    'walk_farm',
    { most: 1 },
    { project: w.project, farm: b, rewards_mint: w.mint, ends: pda.ends(b) },
  );
  assert.throws(() => w.chain.send(w.player, [extra]));
  // A hand-written `open_farm` that says otherwise.
  const wrong = loot.lootIx(
    'open_farm',
    {
      id: 9,
      args: {
        gates: [],
        ends_at: 0,
        lock_key: '',
        upkeep_key: '',
        exit_to: null,
        ...farmArgs([{ ...tier(60), prize: null, roll: null, exit_bps: 0 }]),
        growth: [],
      },
    },
    {
      owner: w.creator,
      project: w.project,
      rewards_mint: w.mint,
      staked_mint: w.mint,
      staked_vault: pda.staked(pda.farm(w.project, 9)),
      exit_pool: null,
      ends: null,
    },
  );
  assert.throws(() => w.chain.send(w.creator, [wrong]), /WrongEnds/);
});

test('a new end time costs its writer 44 bytes, spare rent first, and leaving refunds none of it', { skip }, () => {
  const w = world({ seed: 'ends-rent' });
  const address = farmOf(w, farmArgs([tier(1_000, 0)], { per_day: 1000n }));
  const record = pda.ends(address);
  const open = w.chain.get(record).lamports;
  assert.equal(BigInt(open), w.chain.rent(loot.ENDS_HEAD_BYTES));

  const [a, b, c, d] = [staker(w), staker(w), staker(w), staker(w)];
  stake(w, a, address);
  assert.equal(endsOf(w, address).length, 1);
  assert.equal(w.chain.get(record).data.length, loot.ENDS_HEAD_BYTES + loot.END_BYTES);
  const one = BigInt(w.chain.get(record).lamports);
  assert.equal(one, w.chain.rent(loot.ENDS_HEAD_BYTES + loot.END_BYTES), 'paid by whoever wrote it');

  // Another seat in the same second shares the record, and pays nothing for it.
  stake(w, b, address);
  assert.equal(endsOf(w, address).length, 1);
  assert.equal(endsOf(w, address)[0].seats, 2);
  assert.equal(BigInt(w.chain.get(record).lamports), one);

  // Both leave: the record goes, its rent stays with the account.
  for (const p of [a, b])
    w.chain.send(p, [
      computeUnitLimit(800_000),
      loot.unstakeTokensIx({ player: p, project: w.project, id: 1, farm: w.read('Farm', address), amount: 1_000_000n }),
    ]);
  assert.deepEqual(endsOf(w, address), []);
  assert.equal(w.chain.get(record).data.length, loot.ENDS_HEAD_BYTES);
  assert.equal(BigInt(w.chain.get(record).lamports), one, 'not refunded on leaving');

  // So the next new time pays from it: its writer pays none of the record's rent.
  w.chain.warp(w.chain.now() + 5);
  stake(w, c, address);
  assert.equal(BigInt(w.chain.get(record).lamports), one, 'spare rent paid first');
  w.chain.warp(w.chain.now() + 5);
  stake(w, d, address);
  assert.equal(
    BigInt(w.chain.get(record).lamports),
    w.chain.rent(loot.ENDS_HEAD_BYTES + 2 * loot.END_BYTES),
    'then its writer',
  );
});

test('a seat past its end is paid to the second, the same a minute late or a year late', { skip }, () => {
  // Two worlds alike: in one the lapsed seat is touched at once, in the other a year on; a seat with no end stays.
  const run = (seed, late, rate) => {
    const w = world({ seed });
    const address = farmOf(w, farmArgs([tier(1_000), tier()], rate));
    const [ending, staying] = [staker(w), staker(w)];
    stake(w, ending, address, 1_000_000n, 0);
    stake(w, staying, address, 1_000_000n, 1);
    w.chain.warp(w.chain.now() + 1_000 + late);
    const before = w.balance(ending);
    w.chain.send(ending, [
      computeUnitLimit(800_000),
      loot.harvestIx({ player: ending, project: w.project, id: 1, farm: w.read('Farm', address) }),
    ]);
    return w.balance(ending) - before;
  };
  for (const [kind, rate] of [
    ['rate', { per_day: 86_400_000n }],
    ['shared', { per_day: 86_400_000n, shared: true }],
    ['halving', { per_day: 86_400_000n, halve_every: 500 }],
  ]) {
    const prompt = run(`ends-pay-${kind}-a`, 60, rate);
    const year = run(`ends-pay-${kind}-b`, 365 * 86_400, rate);
    assert.ok(prompt > 0n, kind);
    assert.equal(year, prompt, `${kind}: late or not, what it earned by its end`);
  }
  // A rate for each unit of weight, to the unit: 1,000 seconds at 1,000 a second for its 1 unit of weight.
  assert.equal(run('ends-pay-exact', 500, { per_day: 86_400_000n }), 1_000_000n);
});

test('a seat that stops earning stops counting: those who stay earn by the weight really there', { skip }, () => {
  const w = world({ seed: 'ends-staying' });
  const address = farmOf(w, farmArgs([tier(1_000), tier()], { per_day: 86_400_000n, shared: true }));
  const [ending, staying] = [staker(w), staker(w)];
  stake(w, ending, address, 1_000_000n, 0);
  stake(w, staying, address, 1_000_000n, 1);
  w.chain.warp(w.chain.now() + 3_000);
  const before = w.balance(staying);
  w.chain.send(staying, [
    computeUnitLimit(800_000),
    loot.harvestIx({ player: staying, project: w.project, id: 1, farm: w.read('Farm', address) }),
  ]);
  // 1,000 a second in all: half for 1,000 seconds, all of it for 2,000, whether anyone touched the lapsed seat or not.
  const paid = w.balance(staying) - before;
  assert.ok(paid > 2_499_000n && paid <= 2_500_000n, String(paid));
});

test('walkFarmParts sends a farm’s passed ends in parts, oldest first, and the farm ends up the same', { skip }, () => {
  const w = world({ seed: 'ends-parts' });
  const address = farmOf(w, farmArgs([tier(100)], { per_day: 86_400_000n, halve_every: 3_600 }));
  const count = 30;
  for (let i = 0; i < count; i++) {
    stake(w, staker(w), address);
    w.chain.warp(w.chain.now() + 1);
  }
  const ends = endsOf(w, address);
  assert.equal(ends.length, count);
  const farm = w.read('Farm', address);
  assert.equal(loot.endsToWalk(farm, ends, w.chain.now()), 0, 'none has passed');
  assert.deepEqual(loot.walkFarmParts({ project: w.project, id: 1, farm, ends, now: w.chain.now() }), []);
  w.chain.warp(w.chain.now() + 1_000);
  assert.equal(loot.endsToWalk(farm, ends, w.chain.now()), count);
  assert.equal(loot.farmNeedsWalk(farm, ends, w.chain.now()), false);
  // A farm that ended stops counting at its end.
  assert.equal(loot.endsToWalk({ ...farm, ends_at: ends[9].at }, ends, w.chain.now()), 10);

  const parts = loot.walkFarmParts({ project: w.project, id: 1, farm, ends, now: w.chain.now(), perTx: 12 });
  assert.equal(parts.length, 3);
  for (const [i, part] of parts.entries()) {
    w.chain.send(w.cranker, [computeUnitLimit(loot.WALK_COMPUTE_UNITS), part]);
    const left = loot.endsToWalk(w.read('Farm', address), ends, w.chain.now());
    assert.equal(left, Math.max(0, count - 12 * (i + 1)));
  }
  const walked = endsOf(w, address);
  assert.ok(
    walked.every(e => e.rewardPerWeight > 0n),
    'each end has its value written',
  );
  assert.ok(walked.every((e, i) => i === 0 || e.rewardPerWeight >= walked[i - 1].rewardPerWeight));
  assert.equal(w.read('Farm', address).total_weight, 0n, 'every seat’s weight has left');
});

test('moving what a farm holds free names its record of ends', { skip }, () => {
  const w = world({ seed: 'ends-move' });
  const address = farmOf(w, farmArgs([tier(100)]), 1, 1000n);
  const farm = w.read('Farm', address);
  const to = w.tokenAccount(w.authority, w.mint);
  const move = f =>
    loot.moveTokensIx({
      authority: w.authority,
      project: w.project,
      mint: w.mint,
      from: { Farm: [1] },
      to: { Account: [to] },
      amount: { Fixed: [10n] },
      farm: f,
    });
  assert.throws(() => w.chain.send(w.authority, [move(null)]), /WrongEnds/);
  w.chain.send(w.authority, [move(farm)]);
  assert.equal(w.chain.tokens(to), 10n);
});

test(
  'js/play: a move walks the ends it can, says when a farm needs walking first, and walks it in parts',
  { skip },
  async () => {
    const w = world({ seed: 'ends-play' });
    const address = farmOf(w, farmArgs([tier(10_000)], { per_day: 86_400_000n, halve_every: 3_600 }));
    const [me, other] = [staker(w), staker(w)];
    const wallet = {
      address: me,
      async signTransaction(wire) {
        return wire;
      },
    };
    const spec = {
      version: 2,
      name: 'Walk',
      currency: 'gem',
      tokens: [{ key: 'gem', source: 'existing', mint: w.mint, decimals: 6 }],
      live: { project: w.project, collection: w.collection },
      farms: [
        {
          key: 'long',
          name: 'Long',
          id: 1,
          stakes: 'gem',
          rewards: 'gem',
          tiers: [{ lock: 0, multiplier: 1, earnsFor: 10_000 }],
        },
      ],
    };
    const app = solanaApp({ spec, rpc: w.chain.rpc, wallet, now: () => w.chain.now() });

    // A few to walk: the move asks for the compute itself.
    await app.stake('long', '1');
    for (let i = 0; i < 90; i++) {
      w.chain.warp(w.chain.now() + 1);
      stake(w, staker(w), address);
    }
    w.chain.warp(w.chain.now() + 20_000);
    assert.deepEqual(await app.farmWalk('long'), { ends: 91, needsWalk: false, parts: 1 });
    await app.harvest('long');
    assert.equal((await app.farmWalk('long')).ends, 0, 'it walked them');

    // More than a transaction can walk beside a move's own work.
    stake(w, other, address);
    for (let i = 0; i < loot.MOVE_WALK_ROOM + 5; i++) {
      w.chain.warp(w.chain.now() + 1);
      stake(w, staker(w), address);
    }
    w.chain.warp(w.chain.now() + 20_000);
    const said = await app.farmWalk('long');
    assert.deepEqual(said, { ends: loot.MOVE_WALK_ROOM + 6, needsWalk: true, parts: 1 });
    await assert.rejects(app.harvest('long'), e => e.name === 'FarmNeedsWalk' && /walk it first/.test(e.message));
    const claims = await app.claims();
    const walk = claims.find(c => c.kind === 'walk');
    assert.match(walk?.says ?? '', /caught up/);
    await app.claim(walk);
    assert.equal((await app.farmWalk('long')).ends, 0);
    await app.harvest('long');
    assert.deepEqual(await app.walkFarm('long'), [], 'nothing to walk');
  },
);

test('walk_farm fits its measured count in one transaction, at the dearest kind of farm', { skip }, () => {
  // The dearest end to walk: a halving rate, and seats so heavy that every number the walk divides is a wide one
  // (4 × 10^16 base units each at a ×100 tier). Each end walked also frees its weight's share of the carry.
  const heavy = 40_000_000_000_000_000n;
  const dearest = seed => {
    const w = world({ seed });
    const rate = { per_day: 1_000_000_000_000_000n, halve_every: 3_600 };
    const address = farmOf(w, farmArgs([{ ...tier(10_000), bps: 1_000_000 }], rate));
    const join = () => {
      const p = w.who();
      w.fund(p, w.mint, heavy);
      return stake(w, p, address, heavy);
    };
    return { w, address, join };
  };
  const { w, address, join } = dearest('ends-budget');
  for (let i = 0; i < loot.WALK_PER_TX + 3; i++) {
    join();
    w.chain.warp(w.chain.now() + 1);
  }
  w.chain.warp(w.chain.now() + 20_000);
  const farm = w.read('Farm', address);
  const r = w.chain.send(w.cranker, [
    computeUnitLimit(loot.WALK_COMPUTE_UNITS),
    loot.walkFarmIx({ project: w.project, id: 1, farm }),
  ]);
  assert.ok(r.units < loot.WALK_COMPUTE_UNITS - 100_000, `${r.units} units`);
  assert.equal(loot.endsToWalk(w.read('Farm', address), endsOf(w, address), w.chain.now()), 3);

  // A move that walks all the ends a move may (`MOVE_WALK_ROOM`) keeps some 400,000 units for its own work.
  const m = dearest('ends-move-room');
  for (let i = 0; i < loot.MOVE_WALK_ROOM; i++) {
    m.join();
    m.w.chain.warp(m.w.chain.now() + 1);
  }
  m.w.chain.warp(m.w.chain.now() + 20_000);
  const before = m.w.read('Farm', m.address);
  assert.equal(loot.endsToWalk(before, endsOf(m.w, m.address), m.w.chain.now()), loot.MOVE_WALK_ROOM);
  assert.equal(loot.farmNeedsWalk(before, endsOf(m.w, m.address), m.w.chain.now()), false);
  const moved = m.join();
  assert.ok(moved.units < loot.WALK_COMPUTE_UNITS - 400_000, `${moved.units} units`);
});

test('what it costs is said: the record at setup, and a new end time at a stake', () => {
  const spec = {
    version: 2,
    network: 'devnet',
    name: 'Term',
    currency: 'gem',
    tokens: [{ key: 'gem', source: 'project', name: 'Gem', symbol: 'GEM', decimals: 6 }],
    farms: [
      {
        key: 'term',
        name: 'Term',
        stakes: 'gem',
        rewards: 'gem',
        seed: 10,
        tiers: [{ lock: 0, multiplier: 1, earnsFor: '30d' }],
      },
    ],
  };
  assert.equal(farmEnds(spec.farms[0]), true);
  const setup = plan(spec, { now: NOW })
    .transactions.flatMap(t => t.steps)
    .flatMap(s => s.creates ?? []);
  assert.ok(setup.some(c => /record of when seats stop earning/.test(c.what) && c.bytes === loot.ENDS_HEAD_BYTES));
  const c = cost(spec, { now: NOW });
  const stake = c.actions.find(a => a.part === 'farm:term' && a.action.startsWith('stake'));
  const end = stake.deposits.find(d => /end time/.test(d.what));
  assert.equal(end.sol, 0.00022352);
  assert.match(end.back, /never/);
  assert.match(explainCost(c), /a new end time/);
  const text = explainEconomy(spec, { now: NOW }).text;
  assert.match(text, /however late it is next touched/);
  assert.match(text, /44 bytes of rent/);
  assert.match(text, /not refunded on leaving/);
  assert.doesNotMatch(text, /marks|gives? back after|refresh it at/i);
  // A farm with no end has none of it.
  const plain = { ...spec, farms: [{ ...spec.farms[0], tiers: [{ lock: 0, multiplier: 1 }] }] };
  assert.equal(farmEnds(plain.farms[0]), false);
  assert.ok(
    !cost(plain, { now: NOW })
      .actions.find(a => a.action.startsWith('stake'))
      .deposits.some(d => /end time/.test(d.what)),
  );
  assert.doesNotMatch(explainEconomy(plain, { now: NOW }).text, /44 bytes of rent/);
});
