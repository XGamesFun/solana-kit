#!/usr/bin/env node
// xsolana: the command line of @xgamesfun/solana. Every tool the MCP server has runs here too, with the same arguments and
// the same answer, for an agent (or a person) without MCP.
//
//   xsolana mcp                          serve the tools over stdio (what a plugin's MCP config runs)
//   xsolana guide [part] [--json]        what an economy can be made of, and what loot cannot do
//   xsolana examples [words…] [--json]   the nearest worked examples and rated economies
//   xsolana check|simulate|cost|explain|publish|status [file] [--json]   one tool on a spec file (default xsolana.json)
//   xsolana approve [file] [--port n] [--no-open]   open the local page where the owner approves going live in their wallet
//   xsolana connect [--agent claude|codex] [--scope user|project] [--local] [--remove] [--dry-run]   register the MCP server and the skill
//   xsolana tool --list | xsolana tool <name> '<json>' [--args-file f] [--json]   any tool by name
//   xsolana version
//
// A flag with a value is written either way: --agent claude or --agent=claude; a flag the command doesn't take is
// refused. A command that fails says why on stderr and exits 1: a usage error in one line (XSOLANA_DEBUG=1 prints the
// whole stack), a tool's refusal with the tool's own answer. `--json` prints a tool's whole answer on stdout, whatever
// it is, and the exit code still says whether it failed.
import { readFile } from 'node:fs/promises';

const USAGE = `xsolana: the tools for loot, one shared Solana program for game and community economies.

  xsolana guide [part]            what an economy can be made of
  xsolana examples [words…]       where to start
  xsolana check [file]            refusals and warnings (default xsolana.json)
  xsolana simulate [file]         the quick simulation
  xsolana cost [file]             what going live and each action cost
  xsolana explain [file]          the economy in plain words
  xsolana publish [file]          what going live does, and how to approve it
  xsolana approve [file]          approve going live in your own wallet (a local page; --port n, --no-open)
  xsolana status [file]           a live economy on chain
  xsolana connect                 add the xsolana tools to Claude Code or Codex (--agent claude|codex, --scope user|project, --local, --remove, --dry-run)
  xsolana mcp                     serve the tools over MCP (stdio)
  xsolana tool --list             every tool; xsolana tool <name> '<json>' runs one (--args-file f)
  xsolana version                 this package's xsolana version and program

  A tool's command (guide, examples, check … status, tool) takes --json for its whole answer as JSON.`;

/** A failure the person caused (a bad flag, a missing file): said in one line, without a stack. */
class UsageError extends Error {}

/** The flags that take a value: `--name value` or `--name=value`. */
const VALUED = new Set(['--args-file', '--agent', '--scope', '--port']);
/** The flags each command takes; any other is refused. */
const TOOL_FLAGS = ['--json'];
const FLAGS = {
  mcp: [],
  guide: TOOL_FLAGS,
  examples: TOOL_FLAGS,
  check: TOOL_FLAGS,
  simulate: TOOL_FLAGS,
  cost: TOOL_FLAGS,
  explain: TOOL_FLAGS,
  publish: TOOL_FLAGS,
  status: TOOL_FLAGS,
  approve: ['--port', '--no-open'],
  connect: ['--agent', '--scope', '--local', '--remove', '--dry-run'],
  tool: ['--list', '--args-file', ...TOOL_FLAGS],
  version: [],
};

/** The arguments after the command: { flags (every --name given), values (--name → value), positional }. */
function parseArgs(rest) {
  const flags = new Set();
  const values = new Map();
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--') || a === '--') {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    flags.add(name);
    if (eq > 0) values.set(name, a.slice(eq + 1));
    else if (VALUED.has(name)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new UsageError(`${name} needs a value (${name} <value> or ${name}=<value>).`);
      values.set(name, rest[++i]);
    }
  }
  return { flags, values, positional };
}

/** The port `xsolana approve` listens on: a whole number from 1 to 65535, or undefined for any free one. */
function portOf(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < 1 || n > 65535) throw new UsageError(`--port must be a whole number from 1 to 65535, not ${JSON.stringify(value)}.`);
  return n;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, values, positional } = parseArgs(rest);
  const takes = Object.hasOwn(FLAGS, command) ? FLAGS[command] : null;
  const unknown = takes && [...flags].find((f) => !takes.includes(f));
  if (unknown) throw new UsageError(`“${command}” takes no ${unknown} flag (${takes.length ? `only ${takes.join(', ')}` : 'it takes none'}).`);

  async function tool(name, input) {
    const { runTool } = await import('../js/mcp/server.mjs');
    const r = await runTool(name, input, { cwd: process.cwd() });
    const failed = Boolean(r.isError || r.ok === false);
    if (flags.has('--json')) console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    else (failed ? console.error : console.log)(r.text ?? JSON.stringify(r, null, 2));
    if (failed) process.exitCode = 1;
  }

  const fileInput = () => (positional[0] ? { file: positional[0] } : {});

  switch (command) {
    case 'mcp': {
      const { serveStdio } = await import('../js/mcp/server.mjs');
      await serveStdio();
      break;
    }
    case 'guide':
      await tool('xsolana_guide', positional[0] ? { part: positional[0] } : {});
      break;
    case 'examples':
      await tool('xsolana_examples', positional.length ? { query: positional.join(' ') } : {});
      break;
    case 'check':
    case 'simulate':
    case 'cost':
    case 'explain':
    case 'publish':
    case 'status':
      await tool(`xsolana_${command}`, fileInput());
      break;
    case 'approve': {
      const port = portOf(values.get('--port'));
      const { approve } = await import('../js/approve/server.mjs');
      await approve({ file: positional[0] ?? 'xsolana.json', port, open: !flags.has('--no-open') });
      break;
    }
    case 'connect': {
      const { connect } = await import('../js/connect/connect.mjs');
      process.exitCode = await connect({ agent: values.get('--agent'), local: flags.has('--local'), remove: flags.has('--remove'), dryRun: flags.has('--dry-run'), scope: values.get('--scope') });
      break;
    }
    case 'tool': {
      const { tools } = await import('../js/mcp/tools.mjs');
      if (flags.has('--list') || !positional[0]) {
        for (const t of tools) console.log(`${t.name}\n  ${t.description.split('. ')[0]}.`);
        break;
      }
      const from = values.get('--args-file');
      const raw = from ? await readFile(from, 'utf8') : positional[1] ?? '{}';
      let input;
      try {
        input = JSON.parse(raw);
      } catch (e) {
        throw new UsageError(`The arguments ${from ? `in ${from} ` : ''}are not JSON (${e.message}). Give them as one word, as in: xsolana tool xsolana_check '{"file":"xsolana.json"}'.`, { cause: e });
      }
      await tool(positional[0], input);
      break;
    }
    case 'version':
    case '--version': {
      const { VERSION, PROGRAM_INFO } = await import('../js/mcp/tools.mjs');
      console.log(`@xgamesfun/solana · loot ${VERSION} · program ${PROGRAM_INFO.program} · ${PROGRAM_INFO.cluster}`);
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      console.error(`xsolana: there is no command “${command}”.\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

/** One line for a failure: what went wrong, without a stack (a missing file names the file). */
function oneLine(e) {
  if (e?.code === 'ENOENT' && e.path) return `${e.path} does not exist.`;
  if (e?.code === 'EADDRINUSE') return `Port ${e.port} is in use: pick another with --port, or leave it out for any free one.`;
  return String(e?.message ?? e);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (process.env.XSOLANA_DEBUG) console.error(e);
  else console.error(`xsolana: ${oneLine(e)}`);
  process.exitCode = 1;
}
