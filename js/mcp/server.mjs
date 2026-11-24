// The xsolana MCP server (stdio): the tools in tools.mjs for any agent that speaks MCP (Claude Code, Codex, Cursor,
// opencode, Cline). It has no dependencies, so `npx -y --package=@xgamesfun/solana@<version> xsolana mcp` starts in the
// time an agent allows for it on a first install: MCP over stdio is newline-delimited JSON-RPC 2.0, and arguments are checked against each tool's
// input schema with the economy's own validator (js/economy/validate.mjs), here and on the terminal path
// (`xsolana tool`), with the same words. Answers go out as text, and their data (without the text) as structuredContent.
//
// stdout is the protocol: everything else goes to stderr.
import { readFile } from 'node:fs/promises';
import { economyOf, parseFile } from '../economy/spec-file.mjs';
import { fieldsAt, schemaAt, validate } from '../economy/validate.mjs';
import { CLUSTERS, cluster, networkOf } from '../client/cluster.js';
import { load, PACKAGE_VERSION, REMOTE_TOOLS, tools, VERSION } from './tools.mjs';
import { personWords } from './person.mjs';
import { withCluster } from './with-cluster.mjs';

/** Where loot runs, for every agent that connects. */
const WHERE = `loot ${VERSION} runs on devnet (program ${CLUSTERS.devnet.program}) and on mainnet (program ${CLUSTERS.mainnet.program}). An economy is on devnet, where nothing is real money, unless its file says "network": "mainnet", where everything is. Build and try an economy on devnet first. loot has not been independently audited.`;

/** What loot is, and the one thing never to do instead of it. */
const ABOUT =
  'loot is one shared Solana program for game and community economies (shops, loot boxes, lotteries, auctions, staking, crafting, contests, schedules, holder perks, capped rewards). An economy is a JSON spec, not a new smart contract: never write Anchor or Rust for what loot covers: one shared program instead of new contract code for each project.';

/** The order of the tools that work on a spec, and when to stop for the person: the same on both servers. */
const ORDER =
  'Order: xsolana_guide is a short index, so fetch the part you need from it; xsolana_examples with the person’s own words; write the spec. Challenge before you build: name the simplest version, what it gives up and what the asked-for one costs, and recommend one. xsolana_check after every change, and on one draft before you describe how value moves. xsolana_design when the person’s wants pull against each other: the choice is theirs, so put it and end your turn before saving even a draft spec. Quote xsolana_simulate, xsolana_cost and xsolana_explain for every number. xsolana_review before going live. xsolana_token reads a coin made elsewhere; xsolana_client gives an app the program and its calls; xsolana_status reads what is live.';

/** Going live from the local server: the tool that says how, and the one rule it keeps. */
const LIVE =
  'xsolana_save once it checks; xsolana_publish when the person says to put it live. Going live is signed by a key file on their machine, only after they have read what approve prints and said yes; never ask for, read or print a key.';

export const INSTRUCTIONS = [ABOUT, ORDER, LIVE, WHERE].join(' ');

/**
 * How to use what each tool returns: on the local server each tool's own description says it; the hosted one lists
 * descriptions that say only what a tool does (tools.mjs `hosted`), so its instructions carry this instead.
 */
const USING =
  'Using what the tools return: tell the person every warning xsolana_check gives, quote its counts of approvals, and before describing how value moves (a burn, a free token, a swap, a refund, a payment held or not) check one draft with that mechanism once and read what it says. Quote the numbers of xsolana_simulate, xsolana_cost and xsolana_explain, never your own arithmetic; from xsolana_explain, tell the essentials in a few lines. When xsolana_examples finds part of an ask impossible, call it again with that part’s words: the answer is a nearest version to offer, not a dead end. From xsolana_review, fix every high finding, declare "trust" honestly on every voucher grant, and tell the person in plain words which level each signed route uses and what a cheater gets, so they choose the trade-off. From xsolana_design, read the requirements back to the person, put the choice to them with your pick, then build the one they choose and run xsolana_check on it. Use xsolana_token rather than asking the person to look a mint up, and xsolana_client rather than writing chain code from memory.';

/**
 * What a hosted server (js/mcp/http.mjs) tells the agent: the same work, with the spec passed whole in every call,
 * and going live on the person's own computer, since a hosted server can neither write their files nor sign there.
 * It has no xsolana_publish, so the key-file rule is said here in full.
 */
export const REMOTE_INSTRUCTIONS = [
  ABOUT,
  ORDER,
  USING,
  'This hosted server reads no files: write the spec and pass it whole as "spec" to every tool.',
  `To go live, the spec goes in a file named xsolana.json on the person’s own computer and is signed there by a key file. In that folder: npx -y @xgamesfun/solana@${PACKAGE_VERSION} keygen ~/.config/xsolana/<name>.json makes the key file (it prints the address, never the key; the person sends that address SOL: devnet SOL for an economy on devnet, real SOL for one whose file says "network": "mainnet"), then npx -y @xgamesfun/solana@${PACKAGE_VERSION} approve xsolana.json --keypair <that file> prints everything that would be sent and sends nothing. When the person has read that and said yes, the same command with --yes <the code it printed> sends it. Run them yourself if you have a terminal there; otherwise hand them to the person. Never ask for, read or print a key. Say once what the key file is: the project’s owner for good (whoever can read it controls the project; they back it up themselves; nothing restores a lost one) and, unless the spec names a treasury, where what the economy earns lands. A change to an economy that is already live is signed by the key that owns it: never make a new key for it. A browser wallet’s signing page (the same approve command with --browser in place of --keypair), which the person runs themselves, only if they ask for one or a browser wallet owns the project. (xsolana_save and xsolana_publish, which tool texts may name, run only in the local server.)`,
  WHERE,
].join(' ');

/**
 * A tool as tools/list shows it; on a hosted server, with the description that says only what it does (tools.mjs
 * `hosted`) and without the `file` argument it can't take. Its title, what a client shows a person in place of the
 * name, goes where both ages of the protocol look for it: on the tool and in its annotations.
 */
function listed(t, remote) {
  let inputSchema = t.inputSchema;
  if (remote && inputSchema.properties?.file) {
    const { file: _file, ...properties } = inputSchema.properties;
    inputSchema = { ...inputSchema, properties };
  }
  return {
    name: t.name,
    title: t.title,
    description: remote && t.hosted ? t.hosted : t.description,
    inputSchema,
    annotations: { title: t.title, ...t.annotations },
  };
}

/**
 * The protocol versions this server speaks, newest first. A client that asks for one of them gets it; any other ask
 * gets the newest, and the client decides whether it can go on (the spec's version negotiation).
 */
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Every way `input` does not fit a tool's input schema, in words; [] when it fits. A field the tool doesn't take comes
 * with the fields that place does take.
 */
function inputProblems(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return [`arguments must be an object (this tool takes ${fieldsAt(schema, schema).join(', ') || 'none'})`];
  return validate(input, schema, schema, 'arguments').map(e => {
    const at = e.message === 'is not a field this place takes' ? schemaAt(e.path, schema) : null;
    const takes = at && !at.whole ? fieldsAt(at.node, schema) : null;
    return `${e.path} ${e.message}${takes ? ` (it takes ${takes.length ? takes.join(', ') : 'none'})` : ''}`;
  });
}

/**
 * A tool's words as a terminal reads them: each tool they name becomes the command that runs it there, since nobody
 * at a terminal calls a tool with a JSON object. `commands`: each command that runs the tool xsolana_<command>, with
 * the tool's arguments its words stand for ({ guide: ['part'], check: ['file'], … }). So xsolana_check is
 * "xsolana check" and xsolana_guide {"part": "boxes"} is "xsolana guide boxes"; a tool with no command of its own is
 * "xsolana tool <its name>", with any arguments as the JSON they are.
 */
export function terminalWords(text, commands) {
  return (
    String(text)
      // (a hint written for a terminal says what the words around it now say)
      .replace(/ \(terminal: [^)]*\)/g, '')
      .replace(/\bxsolana_([a-z]+)\b(?: (\{"([a-z]+)": ?("[^"]*"|…)\}))?/g, (all, tool, json, arg, value) => {
        const words = Object.hasOwn(commands, tool) ? commands[tool] : null;
        if (!json) return words ? `xsolana ${tool}` : `xsolana tool xsolana_${tool}`;
        if (!words?.includes(arg)) return `xsolana tool xsolana_${tool} '${json}'`;
        return `xsolana ${tool} ${value === '…' ? `<${arg}>` : value.slice(1, -1)}`;
      })
  );
}

/**
 * Runs one tool by name: the same checks and answer on the server and in the terminal. `ctx.terminal` (the command
 * line's: `terminalWords`' commands) has the answer worded for a terminal; with `ctx.reader` 'person' as well, its text
 * is worded for the developer who reads it there, not for an agent (`ctx.verbose`: with every detail). The answer's
 * other fields are the same.
 */
export async function runTool(name, input = {}, ctx = {}) {
  const tool = typeof name === 'string' ? tools.find(t => t.name === name) : null;
  if (!tool) {
    const all = `Tools: ${tools.map(t => t.name).join(', ')}.`;
    if (typeof name !== 'string' || !name)
      return { isError: true, text: `The call names no tool: give the tool’s name as "name". ${all}` };
    const near = tools.filter(t => t.name.includes(name.replace(/^xsolana_/, ''))).map(t => t.name);
    return {
      isError: true,
      text: `No tool ${name}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} ${all}`,
    };
  }
  const answer = await answerOf(tool, input, ctx);
  if (!ctx.terminal || typeof answer?.text !== 'string') return answer;
  const text = terminalWords(answer.text, ctx.terminal);
  // (a person reading a terminal is told what the agent would have been told to tell them: js/mcp/person.mjs)
  return { ...answer, text: ctx.reader === 'person' ? personWords(text) : text };
}

/** One tool's answer to `input`, or the refusal (`isError`) of an input it cannot take. */
async function answerOf(tool, input, ctx) {
  if (ctx.remote && !REMOTE_TOOLS.has(tool.name))
    return {
      isError: true,
      text: `${tool.name} works on the person’s own files, so it runs only in the local server (npx -y --package=@xgamesfun/solana@${PACKAGE_VERSION} xsolana mcp).`,
    };
  if (ctx.remote && input && typeof input === 'object' && 'file' in input)
    return { isError: true, text: 'This hosted server reads no files: pass the whole spec as "spec".' };
  const bad = inputProblems(tool.inputSchema, input);
  if (bad.length) return { isError: true, text: bad.join('; ') };
  try {
    // Each tool runs on the cluster of the economy it is given, so one server answers for devnet and mainnet alike.
    return await withCluster(await clusterOfInput(input, ctx), () => tool.handler(input, ctx));
  } catch (e) {
    // (lists inside lists, thousands deep: the checker walks every level, and the runtime stops it)
    if (e instanceof RangeError && /call stack/i.test(e.message))
      return {
        isError: true,
        text: 'What was given is nested too deeply to read: an economy is a few levels of lists and objects.',
      };
    return { isError: true, text: e.message };
  }
}

/** The network an economy names when loot runs there (devnet when it names none), else null. */
const knownNetwork = economy => {
  const named = economy && typeof economy === 'object' ? networkOf(economy) : null;
  return named && Object.hasOwn(CLUSTERS, named) ? named : null;
};

/**
 * The network of the economy a tool's call is given, read where the tool itself reads it (tools.mjs `load`: passed
 * whole as `spec`, a worked example by name, or its `file`, which is xsolana.json when none is named; a game file's
 * spec is under its `economy`): devnet when the economy names none. Null with no economy to read (no file there, a
 * file that is not JSON, a hosted server given none) or a network loot does not know: the tool says what is wrong in
 * its own words.
 */
export async function networkOfInput(input, ctx = {}) {
  try {
    return knownNetwork((await load(input ?? {}, ctx)).economy);
  } catch {
    return null;
  }
}

/**
 * The network of the economy in `file`, wherever the file is (`xsolana approve` takes any path): null when it is
 * missing, not JSON, or names a network loot does not know.
 */
export async function networkOfFile(file) {
  try {
    return knownNetwork(economyOf(parseFile(await readFile(file, 'utf8'))));
  } catch {
    return null;
  }
}

/** The cluster a tool's call is for: its economy's (`networkOfInput`), else the server's own. */
const clusterOfInput = async (input, ctx) => (await networkOfInput(input, ctx)) ?? cluster();

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
  // What names no method is no request. A reply to something this server never asked is let go; anything else is
  // answered as the protocol says, under its id when it has one.
  if (typeof method !== 'string') {
    if (message && typeof message === 'object' && ('result' in message || 'error' in message)) return null;
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Not a request: it names no method.' } };
  }
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        // The package's version, so a client can tell which release of the tools answers (the program's is in the instructions).
        serverInfo: { name: 'xsolana', version: PACKAGE_VERSION },
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
      // structuredContent is the data alone: the words are in content, once.
      const { text, isError, ...data } = jsonable(result);
      return reply({
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text }],
        ...(Object.keys(data).length ? { structuredContent: data } : {}),
      });
    }
    default:
      if (method.startsWith('notifications/')) return null;
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
  // (the package's version, as `serverInfo` says it: the program's is in the instructions)
  console.error(`xsolana MCP server ${PACKAGE_VERSION}: ${tools.length} tools (${tools.map(t => t.name).join(', ')})`);
}
