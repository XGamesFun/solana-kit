// The MCP server as an agent sees it: started over stdio with the SDK's own client, every tool listed with honest
// hints, and each answering on an example.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { handle, PROTOCOLS } from '../mcp/server.mjs';

const bin = fileURLToPath(new URL('../../bin/xsolana.mjs', import.meta.url));
const cwd = mkdtempSync(path.join(tmpdir(), 'xsolana-mcp-'));
let client;

before(async () => {
  client = new Client({ name: 'xsolana-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], cwd, stderr: 'ignore' }));
});
after(async () => client?.close());

const text = (r) => r.content.map((c) => c.text).join('\n');

describe('the xsolana MCP server', () => {
  test('lists every tool with all four hints and an object input schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['xsolana_check', 'xsolana_client', 'xsolana_cost', 'xsolana_examples', 'xsolana_explain', 'xsolana_guide', 'xsolana_publish', 'xsolana_save', 'xsolana_simulate', 'xsolana_status'].sort());
    for (const t of tools) {
      for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof t.annotations?.[h], 'boolean', `${t.name} ${h}`);
      assert.equal(t.inputSchema.type, 'object');
    }
    assert.ok(client.getInstructions()?.includes('never write Anchor'));
  });

  test('guide, examples, check, simulate, explain, cost and publish answer on an example', async () => {
    const guide = await client.callTool({ name: 'xsolana_guide', arguments: {} });
    assert.match(text(guide), /What no part of loot does/);
    assert.equal(guide.structuredContent.program, '9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ');
    const ex = await client.callTool({ name: 'xsolana_examples', arguments: { query: 'coin flip with staking' } });
    assert.ok(ex.structuredContent.examples.some((e) => e.name === 'coin-flip-arena'));
    for (const name of ['xsolana_check', 'xsolana_simulate', 'xsolana_explain', 'xsolana_cost', 'xsolana_publish']) {
      const r = await client.callTool({ name, arguments: { example: 'coin-flip-arena' } });
      assert.ok(!r.isError, `${name}: ${text(r)}`);
      assert.match(text(r), /program 9cwqM1TX/);
    }
    const pub = await client.callTool({ name: 'xsolana_publish', arguments: { example: 'coin-flip-arena' } });
    // Pinned to this package's exact version (an unpinned npx runs whatever the name holds when it runs).
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pub.structuredContent.command, `npx -y @xgamesfun/solana@${version} approve xsolana.json`);
  });

  // Every npx line a person or an agent is handed names this exact version.
  test('every npx command in the tools, the skill and the docs is pinned to this package’s version', () => {
    const root = new URL('../../', import.meta.url);
    const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    const files = ['README.md', 'docs/harnesses.md', 'skills/xsolana-economy/SKILL.md', 'js/mcp/tools.mjs', 'js/mcp/server.mjs', 'js/connect/connect.mjs', 'evals/run.mjs', 'plugin/.mcp.json', 'plugin/mcp.json'];
    for (const file of files) {
      const text = readFileSync(new URL(file, root), 'utf8');
      for (const line of text.split('\n').filter((l) => /npx/.test(l))) {
        for (const [, pin] of line.matchAll(/(?:npx (?:-y )?|--package=)@xgamesfun\/solana(@[^\s`'",\]]*)?/g)) {
          assert.ok(pin, `${file}: an unpinned @xgamesfun/solana in “${line.trim()}”`);
          assert.ok([`@${version}`, '@<version>', '@${version}', '@${PACKAGE_VERSION}'].includes(pin), `${file}: pinned to ${pin}, not ${version}, in “${line.trim()}”`);
        }
      }
    }
  });

  // The plugin manifests, the release manifest and the MCP Registry entry name the same version as the package.
  test('the plugin manifests, release.json and server.json carry this package’s version', () => {
    const root = new URL('../../', import.meta.url);
    const { name, version, mcpName } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    for (const file of ['plugin/plugin.json', 'plugin/.claude-plugin/plugin.json', 'release.json', 'server.json']) {
      assert.equal(JSON.parse(readFileSync(new URL(file, root), 'utf8')).version, version, `${file} names another version`);
    }
    const server = JSON.parse(readFileSync(new URL('server.json', root), 'utf8'));
    assert.equal(server.name, mcpName);
    assert.ok(server.description.length <= 100, 'the registry takes a description of at most 100 characters');
    assert.deepEqual(server.packages.map((p) => [p.identifier, p.version]), [[name, version]]);
  });

  test('save writes only a spec that checks, and refuses a key', async () => {
    const spec = JSON.parse(readFileSync(new URL('../../examples/level-ladder.json', import.meta.url), 'utf8'));
    const ok = await client.callTool({ name: 'xsolana_save', arguments: { spec } });
    assert.equal(ok.structuredContent.ok, true);
    assert.ok(JSON.parse(readFileSync(path.join(cwd, 'xsolana.json'), 'utf8')).name);
    assert.ok(!ok.isError);
    // a save that fails is a tool error, and still says why in structuredContent
    const bad = await client.callTool({ name: 'xsolana_save', arguments: { spec: { ...spec, pools: [{ key: 'x', currency: 'nope' }] } } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.ok, false);
    assert.ok(bad.structuredContent.refusals.length);
    const secret = await client.callTool({ name: 'xsolana_save', arguments: { spec: { ...spec, name: 'api_key: abc' } } });
    assert.equal(secret.isError, true);
    assert.equal(secret.structuredContent.ok, false);
    const outside = await client.callTool({ name: 'xsolana_save', arguments: { spec, file: '../elsewhere.json' } });
    assert.equal(outside.isError, true);
    assert.match(text(outside), /^Not saved/);
    const checked = await client.callTool({ name: 'xsolana_check', arguments: {} });
    assert.equal(checked.structuredContent.ok, true, 'xsolana.json in the project folder is the default');
  });

  test('a bad argument is refused with its place and reason', async () => {
    const r = await client.callTool({ name: 'xsolana_guide', arguments: { part: 'nonsense' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /must be one of/);
  });
});

describe('the MCP protocol', () => {
  test('initialize answers the version the client asks for when it speaks it, else its newest', async () => {
    const init = async (protocolVersion) => (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } })).result.protocolVersion;
    assert.equal(PROTOCOLS[0], '2025-11-25');
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) assert.equal(await init(v), v);
    assert.equal(await init('2099-01-01'), '2025-11-25');
    assert.equal(await init(undefined), '2025-11-25');
  });

  test('a request sent just before stdin closes is still answered', async () => {
    // the spec is read from a file, so the reply waits on the disk and comes after stdin has closed
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-mcp-end-'));
    writeFileSync(path.join(dir, 'xsolana.json'), readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url)));
    const child = spawn(process.execPath, [bin, 'mcp'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'xsolana_simulate', arguments: {} } })}\n`);
    assert.equal(await exited, 0);
    const reply = out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 7);
    assert.ok(reply?.result?.content?.[0]?.text, `a reply to the last request: ${out.slice(0, 200)}`);
  });
});
