// The approve command xsolana_publish hands the person carries the spec's file name as one plain word, and xsolana_save
// writes only plain file names (a name with `$(…)` in it would run its own shell code from the command the person is
// told to run as it is); xsolana_save overwrites only a file that is an economy spec, by its whole shape, never another
// JSON file that has a `version` (package.json).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { example } from '../economy/examples.mjs';
import { runTool } from '../mcp/server.mjs';
import { approveCommand } from '../mcp/tools.mjs';

const NOW = 1_790_000_000;
const spec = example('coin-flip-arena').spec;

test('xsolana_save refuses a file name the shell would read as code', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-r5-names-'));
  for (const file of ['$(touch PWNED).json', '`touch PWNED`.json', 'a;touch PWNED.json', 'my spec.json', "it's.json", '-rf.json', 'specs/-x.json']) {
    const r = await runTool('xsolana_save', { spec, file }, { cwd: dir, now: NOW });
    assert.equal(r.ok, false, file);
    assert.match(r.text, /is not a plain file name/);
    assert.ok(!existsSync(path.join(dir, file)), file);
  }
  for (const file of ['xsolana.json', 'economy/shop_v2.json', 'my-game.xsolana.json']) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    assert.equal((await runTool('xsolana_save', { spec, file }, { cwd: dir, now: NOW })).ok, true, file);
    assert.match((await runTool('xsolana_publish', { file }, { cwd: dir, now: NOW })).command, new RegExp(` approve ${file.replace(/\./g, '\\.')}$`));
  }
  // a name already on disk (written by hand, not by xsolana_save) is refused by xsolana_publish too: see below
});

test('xsolana_save overwrites a spec, never a JSON file that only has a version', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-r5-overwrite-'));
  const pkg = JSON.stringify({ name: 'my-game', version: '1.0.0', scripts: { dev: 'vite' }, dependencies: { three: '^0.170.0' } }, null, 2);
  for (const [file, body] of [['package.json', pkg], ['app.json', '{"version": 2, "expo": {"name": "game"}}'], ['list.json', '[2]'], ['v1.json', '{"version": 1, "name": "old"}']]) {
    writeFileSync(path.join(dir, file), body);
    const r = await runTool('xsolana_save', { spec, file }, { cwd: dir, now: NOW });
    assert.equal(r.ok, false, file);
    assert.match(r.text, /is there already and is not an economy spec/);
    assert.equal(readFileSync(path.join(dir, file), 'utf8'), body, `${file} is kept as it was`);
  }
  // a spec (as it is, or under `economy`) is saved over
  writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(spec));
  assert.equal((await runTool('xsolana_save', { spec: { ...spec, name: 'Renamed' }, file: 'xsolana.json' }, { cwd: dir, now: NOW })).ok, true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'xsolana.json'), 'utf8')).name, 'Renamed');
  writeFileSync(path.join(dir, 'wrapped.json'), JSON.stringify({ economy: spec }));
  assert.equal((await runTool('xsolana_save', { spec, file: 'wrapped.json' }, { cwd: dir, now: NOW })).ok, true);
});

// Quoting a name is a POSIX shell's rule only (PowerShell, cmd.exe and fish read the same quotes another way and would
// run the planted code), so xsolana_publish refuses any file name that is not plain, by xsolana_save's own rule, and the
// command is one plain word in every shell. On Windows a spec in a folder is economy\xsolana.json, which would need quotes
// that cmd.exe passes on: the command writes / instead.
test('xsolana_publish refuses a file name that is not plain, whatever shell the person pastes the command into', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-plain-name-'));
  // names a person may have on disk already (a cloned repository), each running code in PowerShell, cmd.exe or fish
  for (const name of ["x';calc;'.json", 'a&calc&.json', "x\\';touch PWNED;#.json", '$(touch PWNED).json', 'my spec.json', '-rf.json', 'a\\b.json']) {
    writeFileSync(path.join(dir, name), JSON.stringify(spec));
    const r = await runTool('xsolana_publish', { file: name }, { cwd: dir, now: NOW });
    assert.equal(r.ok, false, name);
    assert.equal(r.command, undefined, name);
    assert.match(r.text, /is not a plain file name.*rename it/s, name);
  }
  assert.throws(() => approveCommand("it's.json"), /not a plain file name/);
  assert.throws(() => approveCommand('-rf.json'), /not a plain file name/);
  // a plain name, in a folder or not, is the command's word as it is
  mkdirSync(path.join(dir, 'economy'));
  writeFileSync(path.join(dir, 'economy/shop_v2.json'), JSON.stringify(spec));
  assert.ok((await runTool('xsolana_publish', { file: 'economy/shop_v2.json' }, { cwd: dir, now: NOW })).command.endsWith(' approve economy/shop_v2.json'));
});

test('a spec in a folder on Windows is written with / in the approve command, never quoted', () => {
  assert.ok(approveCommand('economy\\xsolana.json', path.win32).endsWith(' approve economy/xsolana.json'));
  assert.ok(approveCommand('a\\b\\c.json', path.win32).endsWith(' approve a/b/c.json'));
  // on Linux and macOS a \ is part of the name: not plain
  assert.throws(() => approveCommand('economy\\xsolana.json', path.posix), /not a plain file name/);
});

test('xsolana_save overwrites only a whole spec: one with its tokens, or one wrapped under `economy` alone', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-r5-shape-'));
  const bodies = [
    ['vercel.json', '{"version": 2, "name": "my-app"}'],
    ['bare.json', '{"version": 2}'],
    ['game.json', JSON.stringify({ title: 'My game', scripts: { dev: 'vite' }, economy: { version: 2 } })],
    ['kept.json', JSON.stringify({ title: 'My game', economy: spec })],
  ];
  for (const [file, body] of bodies) {
    writeFileSync(path.join(dir, file), body);
    const r = await runTool('xsolana_save', { spec, file }, { cwd: dir, now: NOW });
    assert.equal(r.ok, false, file);
    assert.match(r.text, /is there already and is not an economy spec/, file);
    assert.equal(readFileSync(path.join(dir, file), 'utf8'), body, `${file} is kept as it was`);
  }
  // a spec, a live one and a wrapped one are still saved over
  for (const body of [spec, { ...spec, live: { project: '11111111111111111111111111111111' } }, { economy: spec }]) {
    writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(body));
    assert.equal((await runTool('xsolana_save', { spec, file: 'xsolana.json' }, { cwd: dir, now: NOW })).ok, true);
  }
});

test('saving over a spec wrapped under `economy` keeps its live section and program numbers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-r5-wrapped-'));
  const live = { project: '11111111111111111111111111111111' };
  const pools = (spec.pools ?? []).map((p, i) => ({ ...p, index: i }));
  writeFileSync(path.join(dir, 'wrapped.json'), JSON.stringify({ economy: { ...spec, pools, live } }));
  const r = await runTool('xsolana_save', { spec, file: 'wrapped.json' }, { cwd: dir, now: NOW });
  assert.equal(r.ok, true, r.text);
  const after = JSON.parse(readFileSync(path.join(dir, 'wrapped.json'), 'utf8'));
  assert.deepEqual(after.live, live, 'the live section is kept');
  assert.deepEqual((after.pools ?? []).map((p) => p.index), pools.map((p) => p.index), 'and the program numbers');
});

// A refuel paid in anything waits while the project is paused or suspended, the
// fuel keeps running down, and a seat that ran dry before its lock ended never brings its mission's prize.
test('W-FARM-REFUEL for a farm whose mission brings a prize and whose every refuel is paid and capped below the lock', async () => {
  const { check } = await import('../economy/check.mjs');
  const fleet = (change = () => {}) => {
    const s = {
      version: 2, network: 'devnet', name: 'Fleet', currency: 'sol',
      tokens: [{ key: 'sol', source: 'sol' }, { key: 'fuel', source: 'game', name: 'Fuel', symbol: 'FUEL', decimals: 0 }, { key: 'ore', source: 'game', name: 'Ore', symbol: 'ORE', decimals: 0 }, { key: 'ticket', source: 'game', name: 'Ticket', symbol: 'TIX', decimals: 0 }],
      collection: { name: 'Fleet' },
      items: [{ key: 'ship', name: 'Ship', price: 0.05 }],
      pools: [{ key: 'ore-rewards', currency: 'ore' }],
      farms: [{ key: 'mine', name: 'Mine', stakes: 'collectibles', item: 'ship', rewards: 'ore-rewards', rate: { perDay: 10, minted: true }, tiers: [{ lock: '3d', prize: { gives: 'tokens', amount: 50, currency: 'ticket', from: 'mint' } }], upkeepAttribute: 'fuel_until' }],
      recipes: [{ key: 'refuel', name: 'Refuel', in: [{ takes: 'use', item: 'ship' }, { takes: 'pay', currency: 'fuel', amount: 10, to: 'burn' }], raises: [{ place: 0, key: 'fuel_until', by: '1d', upTo: '1d', fromNow: true }] }],
    };
    change(s);
    return check(s, { now: NOW });
  };
  const warned = (r) => r.warnings.filter((w) => w.code === 'W-FARM-REFUEL');
  const base = fleet();
  assert.ok(base.ok, JSON.stringify(base.refusals));
  assert.equal(warned(base).length, 1);
  assert.match(warned(base)[0].message, /waits while the project is paused or suspended.*prize is lost for good/s);
  assert.match(warned(base)[0].fix, /no "pay" line.*"upTo" of at least 3d/s);
  // fits: a refuel paid in nothing beside it, fuel a whole mission ahead, no cap, no mission prize
  assert.deepEqual(warned(fleet((s) => s.recipes.push({ key: 'free-refuel', name: 'Free refuel', in: [{ takes: 'use', item: 'ship' }], raises: [{ place: 0, key: 'fuel_until', by: '1h', upTo: '1d', fromNow: true }] }))), []);
  assert.deepEqual(warned(fleet((s) => { s.recipes[0].raises[0].upTo = '3d'; })), []);
  assert.deepEqual(warned(fleet((s) => { delete s.recipes[0].raises[0].upTo; })), []);
  assert.deepEqual(warned(fleet((s) => { delete s.farms[0].tiers[0].prize; })), []);
});

// The program's known limits on a box's settle (64 accounts, and its heap) name a checker's warning that counts the
// accounts a settle takes. `settleAccounts` counts them as the client builds the settle, and the counts here are the
// program's own measurements (a 17-node proof, the stranger's settle with Sheets left out).
test('W-BOX-ACCOUNTS counts a settle past 64 accounts (or at 64 with a payee who may need a memo); W-BOX-HEAP for the heap shapes of a compressed subject', async () => {
  const { check, settleAccounts } = await import('../economy/check.mjs');
  const { model } = await import('../economy/model.mjs');
  const { encodeBase58 } = await import('../chain/base58.js');
  const A = (n) => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 13 + 1) % 256));
  const shape = ({ tokens = 0, items = 0, core = 0, compressed = 0, holders = 0, hooked = false, shifts = false, own = false }) => ({
    version: 2, network: 'devnet', name: 'Shapes', currency: 'coin',
    tokens: [{ key: 'coin', source: 'existing', mint: A(1), decimals: 6, ...(hooked ? { program: 'token-2022', powers: { transferHook: true } } : { powers: {} }) },
      ...Array.from({ length: tokens }, (_, i) => ({ key: `t${i}`, source: 'existing', mint: A(10 + i), decimals: 0, powers: {} }))],
    collection: { name: 'Shapes' },
    items: [{ key: 'hero', name: 'Hero' }, ...Array.from({ length: items }, (_, i) => ({ key: `prize${i}`, name: `Prize ${i}` }))],
    pools: Array.from({ length: tokens }, (_, i) => ({ key: `p${i}`, currency: `t${i}`, seed: 100 })),
    stashes: [...Array.from({ length: core }, (_, i) => ({ key: `c${i}`, name: `Core ${i}`, collection: A(30 + i), nfts: [A(40 + i)] })),
      ...Array.from({ length: compressed }, (_, i) => ({ key: `z${i}`, name: `Compressed ${i}`, nfts: [{ compressed: A(50 + i) }] }))],
    boxes: [{
      key: 'roll', name: 'Roll', price: 1, rollsOn: own ? { item: 'hero' } : { collection: A(2) }, then: { giveTo: A(3) },
      split: Array.from({ length: holders }, (_, i) => ({ to: `holder:${A(60 + i)}`, percent: 10 })),
      outcomes: [{ gives: 'bundle', weight: 1000, ...(shifts ? { shifts: [{ attribute: 'level', by: 1 }] } : {}),
        prizes: [...Array.from({ length: tokens }, (_, i) => ({ gives: 'pay', pool: `p${i}`, amount: 7 })), ...Array.from({ length: items }, (_, i) => ({ gives: 'item', item: `prize${i}` })),
          ...Array.from({ length: core }, (_, i) => ({ gives: 'stash', stash: `c${i}` })), ...Array.from({ length: compressed }, (_, i) => ({ gives: 'stash', stash: `z${i}` }))] },
      { gives: 'nothing', weight: 1 }],
    }],
  });
  const counted = (s) => { const m = model(s); return settleAccounts(m.boxes[0], m.boxes[0].outcomes[0], m); };
  const warned = (s) => check(s, { now: NOW }).warnings.filter((w) => w.code === 'W-BOX-ACCOUNTS' || w.code === 'W-BOX-HEAP').map((w) => `${w.code} ${w.where}`);
  const ACCOUNTS = 'W-BOX-ACCOUNTS economy.boxes.roll.outcomes[0]', HEAP = 'W-BOX-HEAP economy.boxes.roll.rollsOn';
  // the program's measured counts, and what each shape is warned of
  const shapes = [
    // three token prizes, four holders' shares, a hooked coin: 65 (66 with a fate that moves a number)
    [{ tokens: 3, holders: 4, hooked: true }, 65, true, [ACCOUNTS]],
    [{ tokens: 3, holders: 4, hooked: true, shifts: true }, 66, true, [ACCOUNTS]],
    // one compressed pick and one holder's share: 66
    [{ compressed: 1, holders: 1 }, 66, false, [ACCOUNTS]],
    // exactly 64, and a payee who may turn on memos in a Token-2022 coin: the memo program is the 65th
    [{ items: 3, holders: 4, hooked: true }, 64, true, [ACCOUNTS]],
    // the heap shapes: three Core picks (48), two picks and four shares (58): land with the client's heap frame
    [{ core: 3 }, 48, false, [HEAP]],
    [{ core: 2, holders: 4 }, 58, false, [HEAP]],
    // shapes that fit
    [{ tokens: 3, holders: 4 }, 62, false, []],
    [{ items: 3, holders: 4 }, 61, false, []],
    // 63, and as v0 its lookup table and the table's program: 65
    [{ compressed: 1 }, 63, false, [ACCOUNTS]],
    [{ core: 2 }, 46, false, []],
    [{ tokens: 3, holders: 4, hooked: true, own: true }, 43, true, []],
  ];
  for (const [args, count, memo, codes] of shapes) {
    const s = shape(args);
    assert.deepEqual([counted(s).count, counted(s).memo], [count, memo], JSON.stringify(args));
    assert.deepEqual(warned(s), codes, JSON.stringify(args));
  }
  const m = model(shape({ tokens: 3 }));
  assert.equal(settleAccounts(m.boxes[0], { gives: 'nothing' }, m).count, 41, 'a roll on a compressed NFT, nothing won');
  const words = (args) => check(shape(args), { now: NOW }).warnings.find((w) => w.code === 'W-BOX-ACCOUNTS').message;
  assert.match(words({ items: 3, holders: 4, hooked: true }), /takes 64 accounts.*memo program is one more.*lookup table and the table’s program are two more: 67\. A transaction locks at most 64/s);
  assert.match(words({ tokens: 3, holders: 4, hooked: true }), /takes 65 accounts.*can’t be put back/s);
  assert.match(words({ compressed: 1, holders: 1 }), /takes 66 accounts.*putting every NFT won back/s);
});
