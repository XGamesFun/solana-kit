#!/usr/bin/env node
// A browser for the player robot, as an MCP server (stdio): a headless Chrome with the test wallet in it as a player,
// and the few tools a person uses on a page. The player agent that drives it has no other tools, so it can't read the
// wallet's key or the project's files: it can only use the app, as a player would.
//
// Environment: XSOLANA_EVAL_PLAYER_KEY (a keypair file), XSOLANA_EVAL_RPC, XSOLANA_EVAL_LOG (the wallet's JSONL log),
// XSOLANA_EVAL_GAME and XSOLANA_EVAL_GRANTS (the game and its grant ids, for the wallet's policy), XSOLANA_EVAL_ROLE (player, or
// owner for a page the owner uses with their own wallet).
import { readFileSync } from 'node:fs';
import { keypairFromSecret } from '../../scripts/keypair.mjs';
import { rpcClient } from '../../js/chain/rpc.js';
import { attachWallet, launchBrowser } from './wallet.mjs';

console.log = (...a) => console.error(...a);
const keypair = keypairFromSecret(Uint8Array.from(JSON.parse(readFileSync(process.env.XSOLANA_EVAL_PLAYER_KEY, 'utf8'))));
const rpc = rpcClient(process.env.XSOLANA_EVAL_RPC || 'https://api.devnet.solana.com');
let page = null;
let wallet = null;
const consoleLines = [];

async function ensure() {
  if (page) return page;
  const browser = await launchBrowser();
  const context = await browser.newContext();
  wallet = await attachWallet(context, { keypair, rpc, role: process.env.XSOLANA_EVAL_ROLE || 'player', game: process.env.XSOLANA_EVAL_GAME || null, grants: JSON.parse(process.env.XSOLANA_EVAL_GRANTS || '[]'), owner: process.env.XSOLANA_EVAL_OWNER || null, log: process.env.XSOLANA_EVAL_LOG });
  page = await context.newPage();
  // A confirm() or alert() is shown to the robot as a person would see it, then accepted.
  page.on('dialog', (d) => {
    consoleLines.push(`dialog (${d.type()}): ${d.message()}`.slice(0, 500));
    d.accept().catch(() => {});
  });
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 500)));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 500)));
  return page;
}

async function snapshot() {
  const p = await ensure();
  return p.evaluate(() => {
    // Numbers from an earlier look are taken off first, so a number always means what this look shows.
    for (const e of document.querySelectorAll('[data-xsolana-ref]')) e.removeAttribute('data-xsolana-ref');
    const els = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [onclick]')].filter((e) => e.offsetParent !== null || e.getClientRects().length);
    const lines = els.map((e, i) => {
      e.setAttribute('data-xsolana-ref', String(i));
      const kind = e.tagName.toLowerCase() + (e.type ? `:${e.type}` : '');
      const label = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return `[${i}] ${kind} "${label}"${e.disabled ? ' (disabled)' : ''}`;
    });
    return `URL: ${location.href}\nTITLE: ${document.title}\n\nTEXT:\n${document.body.innerText.slice(0, 6000)}\n\nCONTROLS:\n${lines.join('\n')}`;
  });
}

const tools = {
  open: { description: 'Open a URL in the browser.', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, run: async ({ url }) => { const p = await ensure(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await p.waitForTimeout(1500); return snapshot(); } },
  snapshot: { description: 'The page as it is now: its text and its controls, each with a number to click or fill.', schema: { type: 'object', properties: {} }, run: snapshot },
  click: { description: 'Click a control by its number from the snapshot.', schema: { type: 'object', properties: { ref: { type: 'integer' } }, required: ['ref'] }, run: async ({ ref }) => { const p = await ensure(); await p.locator(`[data-xsolana-ref="${ref}"]`).first().click({ timeout: 10_000 }); await p.waitForTimeout(2500); return snapshot(); } },
  fill: { description: 'Type into an input by its number from the snapshot.', schema: { type: 'object', properties: { ref: { type: 'integer' }, text: { type: 'string' } }, required: ['ref', 'text'] }, run: async ({ ref, text }) => { const p = await ensure(); await p.locator(`[data-xsolana-ref="${ref}"]`).first().fill(text); return snapshot(); } },
  select: { description: 'Choose an option of a select by its number from the snapshot.', schema: { type: 'object', properties: { ref: { type: 'integer' }, value: { type: 'string' } }, required: ['ref', 'value'] }, run: async ({ ref, value }) => { const p = await ensure(); await p.locator(`[data-xsolana-ref="${ref}"]`).first().selectOption({ label: value }).catch(() => p.locator(`[data-xsolana-ref="${ref}"]`).first().selectOption(value)); return snapshot(); } },
  wait: { description: 'Wait some seconds (a roll, a confirmation), then look again.', schema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] }, run: async ({ seconds }) => { const p = await ensure(); await p.waitForTimeout(Math.min(60, seconds) * 1000); return snapshot(); } },
  console: { description: 'The page’s console messages and errors so far.', schema: { type: 'object', properties: {} }, run: async () => consoleLines.slice(-60).join('\n') || '(nothing)' },
  wallet: { description: 'What the wallet was asked to sign so far, and whether it signed.', schema: { type: 'object', properties: {} }, run: async () => JSON.stringify({ address: keypair.address, requests: wallet?.requests ?? [] }, null, 1).slice(0, 6000) },
};

const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const server = new Server({ name: 'browser', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = tools[req.params.name];
  if (!t) return { isError: true, content: [{ type: 'text', text: `No tool ${req.params.name}` }] };
  try {
    return { content: [{ type: 'text', text: String(await t.run(req.params.arguments ?? {})) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});
process.stdin.on('close', () => process.exit(0));
await server.connect(new StdioServerTransport());
