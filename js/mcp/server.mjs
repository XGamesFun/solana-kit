// The xsolana MCP server (stdio): the tools in tools.mjs for any agent that speaks MCP (Claude Code, Codex, Cursor,
// opencode, Cline). It has no dependencies, so `npx -y --package=@xgamesfun/solana@<version> xsolana mcp` starts in the
// time an agent allows for it on a first install: MCP over stdio is newline-delimited JSON-RPC 2.0, and arguments are checked against each tool's
// input schema with the economy's own validator (js/economy/validate.mjs), here and on the terminal path
// (`xsolana tool`), with the same words. Answers go out as text and as structuredContent.
//
// stdout is the protocol: everything else goes to stderr.
import { validate } from '../economy/validate.mjs';
import { PROGRAM_INFO, tools, VERSION } from './tools.mjs';

export const INSTRUCTIONS = [
  'loot is one shared Solana program for game and community economies (shops, loot boxes, lotteries, auctions, staking farms, crafting, contests, schedules, perks for holders of any NFT, capped rewards). An economy is a JSON spec, not a new smart contract: never write Anchor or Rust for what loot covers.',
  'Start with xsolana_guide, then xsolana_examples with the person’s own words; write the spec; xsolana_check after every change; xsolana_simulate and xsolana_explain before telling them what it does; xsolana_save; xsolana_publish when they say to put it live (they approve in their own wallet: you never sign or ask for a key).',
  `Program ${PROGRAM_INFO.program} on ${PROGRAM_INFO.cluster} (loot ${VERSION}). Devnet only until audited.`,
].join(' ');

/**
 * The protocol versions this server speaks, newest first. A client that asks for one of them gets it; any other ask
 * gets the newest, and the client decides whether it can go on (the spec's version negotiation).
 */
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Every way `input` does not fit a tool's input schema, in words; [] when it fits. */
export function inputProblems(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['arguments must be an object'];
  return validate(input, schema, schema, 'arguments').map((e) => `${e.path} ${e.message}`);
}

/** Runs one tool by name: the same checks and answer on the server and in the terminal. */
export async function runTool(name, input = {}, ctx = {}) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const near = tools.filter((t) => t.name.includes(String(name).replace(/^xsolana_/, ''))).map((t) => t.name);
    return { isError: true, text: `No tool ${name}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} Tools: ${tools.map((t) => t.name).join(', ')}.` };
  }
  const bad = inputProblems(tool.inputSchema, input);
  if (bad.length) return { isError: true, text: bad.join('; ') };
  try {
    return await tool.handler(input, ctx);
  } catch (e) {
    return { isError: true, text: e.message };
  }
}

const jsonable = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));

/** The answer to one JSON-RPC request, or null for a notification. */
export async function handle(message, ctx = {}) {
  const { id, method, params } = message ?? {};
  const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, text) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'xsolana', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
    case 'tools/call': {
      const result = await runTool(params?.name, params?.arguments ?? {}, { ...ctx, cwd: ctx.cwd ?? process.cwd() });
      // A tool that failed says so (isError), and keeps whatever it found (a save's refusals, say) as structuredContent.
      const { text, isError, ...data } = jsonable(result);
      return reply({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }], structuredContent: { text, ...data } });
    }
    default:
      if (method?.startsWith('notifications/')) return null;
      return fail(-32601, `No method ${method}.`);
  }
}

/**
 * Serves the tools over stdio until stdin closes. Once it closes, every request already read is answered before
 * `exit` runs, so a client that sends its last request and closes still gets the reply.
 */
export async function serveStdio({ input = process.stdin, output = process.stdout, exit = () => process.exit(0) } = {}) {
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  let buffer = '';
  const write = (m) => m && output.write(`${JSON.stringify(m)}\n`);
  // The requests read and not yet answered.
  const pending = new Set();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } });
        continue;
      }
      for (const m of Array.isArray(message) ? message : [message]) {
        const done = handle(m)
          .then(write, (e) => write({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: e.message } }))
          .finally(() => pending.delete(done));
        pending.add(done);
      }
    }
  });
  input.on('end', async () => {
    while (pending.size) await Promise.allSettled([...pending]);
    // (the last reply is written out before the process goes)
    output.write('', () => exit());
  });
  console.error(`xsolana MCP server ${VERSION}: ${tools.length} tools (${tools.map((t) => t.name).join(', ')})`);
}
