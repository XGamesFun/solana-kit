// The hosted MCP server (js/mcp/http.mjs) as a chat app sees it: the SDK's own Streamable HTTP client against
// `serveHttp`, only the tools that read nothing but their arguments, every spec passed whole, and no file of the
// machine it runs on ever read.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpHttp, serveHttp } from '../mcp/http.mjs';
import { REMOTE_INSTRUCTIONS } from '../mcp/server.mjs';
import { example } from '../economy/examples.mjs';
import { PACKAGE_VERSION } from '../mcp/tools.mjs';

let server;
let client;
let url;

before(async () => {
  server = await serveHttp({ port: 0 });
  url = `http://127.0.0.1:${server.address().port}/mcp`;
  client = new Client({ name: 'xsolana-http-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
});
after(async () => {
  await client?.close();
  server?.close();
});

const text = r => r.content.map(c => c.text).join('\n');
const post = (body, headers = {}) =>
  mcpHttp(
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

describe('the hosted xsolana MCP server', () => {
  test('lists only the tools that read nothing but their arguments, none taking a file', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'xsolana_check',
      'xsolana_client',
      'xsolana_cost',
      'xsolana_examples',
      'xsolana_explain',
      'xsolana_guide',
      'xsolana_review',
      'xsolana_simulate',
      'xsolana_status',
    ]);
    for (const t of tools) assert.ok(!('file' in (t.inputSchema.properties ?? {})), `${t.name} takes no file`);
  });

  test('its instructions say to pass the spec whole and how the owner goes live in their own wallet', () => {
    assert.equal(client.getInstructions(), REMOTE_INSTRUCTIONS);
    assert.match(REMOTE_INSTRUCTIONS, /pass it whole as "spec"/);
    assert.ok(REMOTE_INSTRUCTIONS.includes(`npx -y @xgamesfun/solana@${PACKAGE_VERSION} approve xsolana.json`));
    assert.match(REMOTE_INSTRUCTIONS, /never ask for a key/);
  });

  test('checks, simulates and reviews a spec passed whole, and a worked example by name', async () => {
    const spec = example('coin-flip-arena').spec;
    for (const name of ['xsolana_check', 'xsolana_simulate', 'xsolana_explain', 'xsolana_review']) {
      const r = await client.callTool({ name, arguments: { spec } });
      assert.ok(!r.isError, `${name}: ${text(r)}`);
    }
    const byName = await client.callTool({ name: 'xsolana_cost', arguments: { example: 'coin-flip-arena' } });
    assert.ok(!byName.isError, text(byName));
    assert.match(text(byName), /Going live takes/);
  });

  test('never reads a file of the machine it runs on', async () => {
    // Even with an xsolana.json in the server's own folder, a call without a spec is refused, not answered from it.
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-http-'));
    writeFileSync(path.join(dir, 'xsolana.json'), JSON.stringify(example('coin-flip-arena').spec));
    const here = process.cwd();
    process.chdir(dir);
    try {
      const none = await client.callTool({ name: 'xsolana_check', arguments: {} });
      assert.ok(none.isError);
      assert.match(text(none), /reads no files/);
      const named = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'xsolana_check', arguments: { file: 'xsolana.json' } },
      });
      const { result } = await named.json();
      assert.ok(result.isError);
      assert.match(result.content[0].text, /reads no files/);
    } finally {
      process.chdir(here);
    }
  });

  test('refuses the tools that write or read the person’s files, naming the local server', async () => {
    for (const name of ['xsolana_save', 'xsolana_publish']) {
      const r = await client.callTool({ name, arguments: { spec: example('coin-flip-arena').spec } });
      assert.ok(r.isError, name);
      assert.match(text(r), /runs only in the local server/);
    }
  });

  test('speaks the transport: notifications get 202, GET 405, CORS preflight 204, junk and huge bodies refused', async () => {
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const get = await mcpHttp(new Request('https://example.test/mcp'));
    assert.equal(get.status, 405);
    assert.match(get.headers.get('allow'), /POST/);
    const pre = await mcpHttp(new Request('https://example.test/mcp', { method: 'OPTIONS' }));
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    const junk = await post('{not json');
    assert.equal(junk.status, 400);
    assert.equal((await junk.json()).error.code, -32700);
    assert.equal((await post('x'.repeat(1_000_001))).status, 413);
    const batch = await post([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    assert.deepEqual(await batch.json(), [{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  test('on this machine, answers pages on localhost only', async () => {
    const from = origin =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    assert.equal((await from('http://localhost:3000')).status, 200);
    assert.equal((await from('https://attacker.example')).status, 403);
  });
});
