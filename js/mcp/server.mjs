// The xsolana MCP server (stdio): the tools in tools.mjs for any agent that speaks MCP (Claude Code, Codex, Cursor,
// opencode, Cline). It has no dependencies, so `npx -y --package=@xgamesfun/solana@<version> xsolana mcp` starts in the
// time an agent allows for it on a first install: MCP over stdio is newline-delimited JSON-RPC 2.0, and arguments are checked against each tool's
// input schema with the economy's own validator (js/economy/validate.mjs), here and on the terminal path
// (`xsolana tool`), with the same words. Answers go out as text and as structuredContent.
//
// stdout is the protocol: everything else goes to stderr.
import { validate } from '../economy/validate.mjs';
import { PACKAGE_VERSION, PROGRAM_INFO, REMOTE_TOOLS, tools, VERSION } from './tools.mjs';

export const INSTRUCTIONS = [
  'loot is one shared Solana program for game and community economies (shops, loot boxes, lotteries, auctions, staking farms, crafting, contests, schedules, perks for holders of any NFT, capped rewards). An economy is a JSON spec, not a new smart contract: never write Anchor or Rust for what loot covers.',
  'Start with xsolana_guide, then xsolana_examples with the person’s own words; write the spec; xsolana_check after every change; xsolana_simulate and xsolana_explain before telling them what it does; xsolana_review before going live (fix its high findings, say honestly what each voucher server checks, and tell the person what a cheater gets); xsolana_save; xsolana_publish when they say to put it live. Going live is signed by a key file on their own machine (xsolana keygen makes one; never ask for, read or print a key) with xsolana approve --keypair, which prints everything it would send and sends nothing until it is run again with the code it printed: do that only after they have read the printout and said yes. That key owns the project for good: a change to an economy that is already live is signed by the key that owns it, never by a new one. A browser wallet’s signing page (approve --browser) only if they ask for one, and they run it themselves.',
  `Program ${PROGRAM_INFO.program} on ${PROGRAM_INFO.cluster} (loot ${VERSION}). Devnet only until audited.`,
].join(' ');

/**
 * What a hosted server (js/mcp/http.mjs) tells the agent: the same work, with the spec passed whole in every call,
 * and going live on the person's own computer, since a hosted server can neither write their files nor sign there.
 */
export const REMOTE_INSTRUCTIONS = [
  INSTRUCTIONS.split(' Start with')[0],
  'Start with xsolana_guide, then xsolana_examples with the person’s own words; write the spec and pass it whole as "spec" to every tool (this hosted server reads no files); xsolana_check after every change; xsolana_simulate and xsolana_explain before telling them what it does; xsolana_review before going live (fix its high findings, say honestly what each voucher server checks, and tell the person what a cheater gets).',
  `To go live, the spec goes in a file named xsolana.json on the person’s own computer and is signed there by a key file. In that folder: npx -y @xgamesfun/solana@${PACKAGE_VERSION} keygen ~/.config/xsolana/<name>.json makes the key file (it prints the address, never the key; the person sends that address devnet SOL), then npx -y @xgamesfun/solana@${PACKAGE_VERSION} approve xsolana.json --keypair <that file> prints everything that would be sent and sends nothing. When the person has read that and said yes, the same command with --yes <the code it printed> sends it. Run them yourself if you have a terminal there; otherwise hand them to the person. Never ask for, read or print a key. Say once what the key file is: the project’s owner for good (whoever can read it controls the project; they back it up themselves; nothing restores a lost one) and, unless the spec names a treasury, where what the economy earns lands. A change to an economy that is already live is signed by the key that owns it: never make a new key for it. A browser wallet’s signing page (the same approve command with --browser in place of --keypair), which the person runs themselves, only if they ask for one or a browser wallet owns the project. (xsolana_save and xsolana_publish, which tool texts may name, run only in the local server.)`,
  `Program ${PROGRAM_INFO.program} on ${PROGRAM_INFO.cluster} (loot ${VERSION}). Devnet only until audited.`,
].join(' ');

/** A tool as tools/list shows it; on a hosted server, without the `file` argument it can't take. */
function listed(t, remote) {
  let inputSchema = t.inputSchema;
  if (remote && inputSchema.properties?.file) {
    const { file: _file, ...properties } = inputSchema.properties;
    inputSchema = { ...inputSchema, properties };
  }
  return { name: t.name, description: t.description, inputSchema, annotations: t.annotations };
}

/**
 * The protocol versions this server speaks, newest first. A client that asks for one of them gets it; any other ask
 * gets the newest, and the client decides whether it can go on (the spec's version negotiation).
 */
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Every way `input` does not fit a tool's input schema, in words; [] when it fits. */
export function inputProblems(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['arguments must be an object'];
  return validate(input, schema, schema, 'arguments').map(e => `${e.path} ${e.message}`);
}

/** Runs one tool by name: the same checks and answer on the server and in the terminal. */
export async function runTool(name, input = {}, ctx = {}) {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    const near = tools.filter(t => t.name.includes(String(name).replace(/^xsolana_/, ''))).map(t => t.name);
    return {
      isError: true,
      text: `No tool ${name}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} Tools: ${tools.map(t => t.name).join(', ')}.`,
    };
  }
  if (ctx.remote && !REMOTE_TOOLS.has(name))
    return {
      isError: true,
      text: `${name} works on the person’s own files, so it runs only in the local server (npx -y --package=@xgamesfun/solana@${PACKAGE_VERSION} xsolana mcp).`,
    };
  if (ctx.remote && 'file' in input)
    return { isError: true, text: 'This hosted server reads no files: pass the whole spec as "spec".' };
  const bad = inputProblems(tool.inputSchema, input);
  if (bad.length) return { isError: true, text: bad.join('; ') };
  try {
    return await tool.handler(input, ctx);
  } catch (e) {
    return { isError: true, text: e.message };
  }
}

const jsonable = value =>
  JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
    ),
  );

/** The answer to one JSON-RPC request, or null for a notification. */
export async function handle(message, ctx = {}) {
  const { id, method, params } = message ?? {};
  const reply = result => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, text) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'xsolana', version: VERSION },
        instructions: ctx.remote ? REMOTE_INSTRUCTIONS : INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: tools.filter(t => !ctx.remote || REMOTE_TOOLS.has(t.name)).map(t => listed(t, ctx.remote)),
      });
    case 'tools/call': {
      const input = params?.arguments ?? {};
      const result = await runTool(params?.name, input, ctx.remote ? ctx : { ...ctx, cwd: ctx.cwd ?? process.cwd() });
      // A tool that failed says so (isError), and keeps whatever it found (a save's refusals, say) as structuredContent.
      const { text, isError, ...data } = jsonable(result);
      return reply({
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text }],
        structuredContent: { text, ...data },
      });
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
export async function serveStdio({
  input = process.stdin,
  output = process.stdout,
  exit = () => process.exit(0),
} = {}) {
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  let buffer = '';
  const write = m => m && output.write(`${JSON.stringify(m)}\n`);
  // The requests read and not yet answered.
  const pending = new Set();
  input.setEncoding('utf8');
  input.on('data', chunk => {
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
          .then(write, e => write({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: e.message } }))
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
  console.error(`xsolana MCP server ${VERSION}: ${tools.length} tools (${tools.map(t => t.name).join(', ')})`);
}
