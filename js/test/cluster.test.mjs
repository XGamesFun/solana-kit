// loot has an address of its own on each cluster, and one process works on one cluster (client/cluster.js). The values
// here that follow from an address are the ones the program's own tests hold for both of its builds
// (programs/loot/tests/grants.rs, the unit test of instructions/order.rs), so the client and the program agree on
// both: a voucher, the verdicts, their signatures by the vector key (the seed of 32 ones), a grant's addresses and the
// identities the oracle knows the program by.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeBase58, encodeBase58 } from '../chain/base58.js';
import { utf8, uintLE } from '../chain/bytes.js';
import { findProgramAddress } from '../chain/pda.js';
import * as loot from '../client/index.js';

const hex = bytes => Buffer.from(bytes).toString('hex');
const filled = (byte, length = 32) => new Uint8Array(length).fill(byte);
const address = byte => encodeBase58(filled(byte));

const VECTORS = {
  devnet: {
    program: 'xgamesVsZBpCVgJuatfYAFJRmQoccfQf5qtUFNp2Eet',
    voucher: '6c6f6f742d6772616e742d7635e9bc26c3576a1298f974b6829dfce5cc4eadf7e8a9afd06c17e4152288f526e3',
    voucherSignature:
      '1245e1fbd9b875fb59e61514c3030c21144b3e1771843467c837b5867b894a9a1141ae55fb3a5169755f9f59d760b9677a5b11c2b1d0089b802aa0bdaf814e05',
    side1: '6c6f6f742d766572646963742d7634be7be067a7b928f432bbb17c7d61f096099cfe94dbde04798955b3e70f5dc60e',
    side300: '6c6f6f742d766572646963742d7634172d180a9fdcc95b03ca0c1c8f65f51b0ac723a9e10355df801ee10d4b373818',
    offTo33: '6c6f6f742d766572646963742d76349dd2d9129d8d70f3a69642cf5abe142a5a89d5ba944ed3de49bd3bc1be5c099f',
    verdictSignature:
      '3cc814cc36aff67008f53f901ff9fcf875ca17aaa1e6142bc7e91a0a6aaa4bd429828abd6c4724b9dfe3ba053189d60abb8d87c83afbbe455eceb27cda434008',
    grant: '7bVHL6QKccAv5RhUXvet16xpi5KotmAe3dZAi5XTLmZN',
    claims: 'pXtKuHGkyehKhaf5rbo8dGVT1smAPQRTAW4nXkiEMr4',
    rounds: '5caNKeLy6bx56K78whevogE6EahkBoLEwDdN7mxY4o3P',
    identity: 'C4DgEvJfoT3MmXupCvtgeVMDJTAis4G7xxeHSwNqfKKj',
    oracleIdentity: 'G3naDjL8RpPjQmN7MKoDZqKxDDpLwaxtPuo4hdcpZKEB',
  },
  mainnet: {
    program: 'xgames8C758PyweWB9sDw8evvwsTVwyA2fGRUeAXVPy',
    voucher: '6c6f6f742d6772616e742d763522f48401c48b7af5e0b814181092a7b689e29aed36dc8e0d8d35770d17d67765',
    voucherSignature:
      '1236079a319fb71ead084f2418299f96f2392772ec3001851ee281a0ceb54bca294c0baeec7349e023921d9661e172f69c016c07d622b0a452372c5eab088708',
    side1: '6c6f6f742d766572646963742d763460533d0746ef7e2deeb447a5bd20bb23027cfcf423975c9e3e9f8e8f5633357c',
    side300: '6c6f6f742d766572646963742d7634ad2e3ddee78b6ba6afade42d5fa570faf50fc6bab8adbe7f663f893f8e9ec2e5',
    offTo33: '6c6f6f742d766572646963742d76348bc926659e7bd805ed4f034ab3022809fb96a5e9bdfc4fb248ffc34ed226f157',
    verdictSignature:
      'f54da45053a0f7fa29b8ae2cdd11918036105dbcbb7d5707f4631c93c4803f2c9867e74be5abf4186af066920eb132e636ae0a261c347e23e8c11c563c831908',
    grant: '6LdYgov8j4wGwAjnNAXwUyntfGpJsNJKVZf1EkTU95Ny',
    claims: 'yN9kNQ5wN3Jrc5cwzwndEsW3x9TMKPC2MkaUXFbWdFQ',
    rounds: 'GTuQZwpbKJuomnsFvt2HX83N93UftGZVgv1Hesua96Nx',
    identity: '7fqj5vfXbtDPnsRAnmEvjrYDRSMxtHhRuBavj8Atgu7Q',
    oracleIdentity: 'BCNmL24LYwQULJchZUSY68f6PuMQJZjEwZHPv1X7Atnf',
  },
};

const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), filled(1)]),
  format: 'der',
  type: 'pkcs8',
});
const signed = bytes => hex(sign(null, Buffer.from(bytes), vectorKey));
const EXPIRES = 1_767_225_600n;

test('each cluster has loot at an address of its own, and devnet’s is the IDL’s', () => {
  assert.equal(loot.CLUSTERS.devnet.program, VECTORS.devnet.program);
  assert.equal(loot.CLUSTERS.devnet.program, loot.IDL.address);
  assert.equal(loot.CLUSTERS.mainnet.program, VECTORS.mainnet.program);
  assert.notEqual(loot.CLUSTERS.devnet.program, loot.CLUSTERS.mainnet.program);
  assert.deepEqual(Object.keys(loot.CLUSTERS), ['devnet', 'mainnet']);
});

for (const [name, v] of Object.entries(VECTORS))
  test(`what is signed for ${name} is the program’s own vector there, and is not what is signed for the other`, () => {
    const voucher = loot.voucherBytes({
      program: v.program,
      grant: filled(0x22),
      incarnation: 7n,
      wallet: filled(0x33),
      personHash: filled(0x44),
      expires: EXPIRES,
      rounds: [{ id: filled(0x55, 16), amount: 0n }],
    });
    assert.equal(voucher.length, 45);
    assert.equal(hex(voucher), v.voucher);
    assert.equal(signed(voucher), v.voucherSignature);
    const verdict = (side, recipient = null) =>
      loot.verdictBytes({
        program: v.program,
        contest: address(0x22),
        incarnation: 7n,
        side,
        expires: EXPIRES,
        recipient,
      });
    assert.equal(hex(verdict(1)), v.side1);
    assert.equal(hex(verdict(300)), v.side300);
    assert.equal(hex(verdict(null, address(0x33))), v.offTo33);
    assert.equal(signed(verdict(1)), v.verdictSignature);
    // The addresses under that program: project 0x11's grant 7, its first claims and rounds shards at incarnation 7.
    const at = (...seeds) => loot.lootAddress(seeds, v.program)[0];
    const grant = at(utf8('grant'), filled(0x11), uintLE(7, 2));
    assert.equal(grant, v.grant);
    const grantBytes = loot.lootAddress([utf8('grant'), filled(0x11), uintLE(7, 2)], v.program);
    assert.equal(grantBytes[0], grant);
    const shard = seed => at(utf8(seed), decodeBase58(grant), uintLE(7, 8), uintLE(0, 1));
    assert.equal(shard('claims'), v.claims);
    assert.equal(shard('rounds'), v.rounds);
    assert.equal(at(utf8('identity')), v.identity);
    assert.equal(
      findProgramAddress([utf8('identity'), decodeBase58(v.program)], loot.VRF_PROGRAM)[0],
      v.oracleIdentity,
    );
    const other = VECTORS[name === 'devnet' ? 'mainnet' : 'devnet'];
    for (const key of Object.keys(v)) assert.notEqual(v[key], other[key], key);
  });

test('this process’s cluster: the program, a voucher signed without naming one, and every address follow it', () => {
  const name = loot.cluster();
  const v = VECTORS[name];
  assert.equal(name, process.env.XSOLANA_CLUSTER ?? 'devnet');
  assert.equal(loot.LOOT_PROGRAM, v.program);
  assert.equal(loot.lootProgram(), v.program);
  const voucher = loot.voucherBytes({
    grant: filled(0x22),
    incarnation: 7n,
    wallet: filled(0x33),
    personHash: filled(0x44),
    expires: EXPIRES,
    rounds: [{ id: filled(0x55, 16), amount: 0n }],
  });
  assert.equal(hex(voucher), v.voucher);
  assert.equal(hex(loot.verdictBytes({ contest: address(0x22), incarnation: 7n, side: 1, expires: EXPIRES })), v.side1);
  const grant = loot.pda.grant(address(0x11), 7);
  assert.equal(grant, v.grant);
  assert.equal(loot.pda.claims(grant, 7, 0), v.claims);
  assert.equal(loot.pda.rounds(grant, 7, 0), v.rounds);
  assert.equal(loot.pda.identity(), v.identity);
  assert.equal(loot.pda.oracleIdentity(), v.oracleIdentity);
  assert.equal(loot.collectFeesIx({ admin: address(0x11), to: address(0x12), projects: [] }).programId, v.program);
});

// One process works on one cluster: each case is a process of its own.
const client = path.join(path.dirname(fileURLToPath(import.meta.url)), '../client/index.js');
const run = (script, env = {}) => {
  const clean = { ...process.env, ...env };
  if (!('XSOLANA_CLUSTER' in env)) delete clean.XSOLANA_CLUSTER;
  delete clean.NODE_OPTIONS;
  try {
    return execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `import * as loot from ${JSON.stringify(client)};\n${script}`],
      {
        env: clean,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (e) {
    return `threw: ${/^\w*Error: .*$/m.exec(String(e.stderr))?.[0] ?? e.message}`;
  }
};

test('a process is on devnet unless it names another cluster, once, before it derives anything', () => {
  assert.equal(run('console.log(loot.cluster(), loot.LOOT_PROGRAM)'), `devnet ${VECTORS.devnet.program}`);
  assert.equal(
    run('console.log(loot.cluster(), loot.LOOT_PROGRAM)', { XSOLANA_CLUSTER: 'mainnet' }),
    `mainnet ${VECTORS.mainnet.program}`,
  );
  // Named in the process, before anything else: every address after it is mainnet's.
  assert.equal(
    run('loot.useCluster("mainnet"); console.log(loot.LOOT_PROGRAM, loot.pda.identity())'),
    `${VECTORS.mainnet.program} ${VECTORS.mainnet.identity}`,
  );
  // Naming the cluster it is already on is fine, any number of times.
  assert.equal(run('loot.useCluster("devnet"); loot.pda.identity(); console.log(loot.useCluster("devnet"))'), 'devnet');
});

test('a second cluster is refused once the first is settled: by an address derived, an instruction built, a name given', () => {
  const refused = /already works on (devnet|mainnet); it can't also work on/;
  assert.match(run('loot.pda.identity(); loot.useCluster("mainnet")'), refused);
  assert.match(
    run(
      'loot.collectFeesIx({ admin: loot.VRF_PROGRAM, to: loot.VRF_PROGRAM, projects: [] }); loot.useCluster("mainnet")',
    ),
    refused,
  );
  assert.match(run('loot.cluster(); loot.useCluster("mainnet")'), refused);
  assert.match(run('loot.useCluster("mainnet"); loot.useCluster("devnet")'), refused);
  assert.match(run('loot.useCluster("devnet")', { XSOLANA_CLUSTER: 'mainnet' }), refused);
  // A refused name changes nothing.
  assert.equal(
    run(
      'loot.pda.identity(); try { loot.useCluster("mainnet") } catch {} console.log(loot.cluster(), loot.LOOT_PROGRAM)',
    ),
    `devnet ${VECTORS.devnet.program}`,
  );
});

test('a cluster loot does not know is refused, from the environment too', () => {
  assert.match(run('loot.useCluster("testnet")'), /"testnet" is not a cluster loot knows: devnet or mainnet/);
  assert.match(
    run('console.log(loot.cluster())', { XSOLANA_CLUSTER: 'mainnet-beta' }),
    /"mainnet-beta" is not a cluster loot knows/,
  );
});
