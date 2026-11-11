#!/usr/bin/env node
// xsolana: the command line of @xgamesfun/solana. Every tool the MCP server has runs here too, with the same arguments and
// the same answer, for an agent (or a person) without MCP.
//
//   xsolana mcp                          serve the tools over stdio (what a plugin's MCP config runs)
//   xsolana mcp --http [--port n] [--host h]   serve the hosted tools over HTTP at /mcp (127.0.0.1:8787 by default)
//   xsolana guide [part] [--json]        what an economy can be made of, and what loot cannot do
//   xsolana examples [words…] [--json]   the nearest worked examples and rated economies
//   xsolana check|simulate|cost|explain|review|publish|status [file] [--json]   one tool on a spec file (default xsolana.json)
//   xsolana token <mint> [--json]         a token made elsewhere, read from the chain: its `tokens` entry, powers and all
//   xsolana keygen <file>                 make a key file for a project's owner (outside any repository; the key is never printed)
//   xsolana approve [file] --keypair <keyfile> [--yes <code>]   put the economy live, signed by a key file: no browser, no page
//   xsolana approve [file] --browser [--port n] [--no-open]     the same in a browser wallet, on a local page: only when the person asks for it
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
  xsolana review [file]           what a cheater gets on each route, and what to fix before going live
  xsolana publish [file]          what going live does, and how to approve it
  xsolana keygen <file>           make a key file for the project’s owner, outside any repository (prints its address, never the key)
  xsolana approve [file] --keypair <keyfile>   what going live sends, then (--yes <code>) send it, signed by that key file
  xsolana approve [file] --browser             the same on a local page, signed in a browser wallet (--port n, --no-open)
  xsolana status [file]           a live economy on chain
  xsolana token <mint>            a token made elsewhere, as the chain has it: its "tokens" entry, with what its mint can do
  xsolana connect                 add the xsolana tools to Claude Code or Codex (--agent claude|codex, --scope user|project, --local, --remove, --dry-run)
  xsolana mcp                     serve the tools over MCP (stdio)
  xsolana mcp --http              serve the hosted tools over HTTP at http://127.0.0.1:8787/mcp (--port n, --host h)
  xsolana tool --list             every tool; xsolana tool <name> '<json>' runs one (--args-file f)
  xsolana version                 this package's xsolana version and program

  A tool's command (guide, examples, check … status, token, tool) takes --json for its whole answer as JSON.
  review exits 1 when it finds something high.`;

/** A failure the person caused (a bad flag, a missing file): said in one line, without a stack. */
class UsageError extends Error {}

/** The flags that take a value: `--name value` or `--name=value`. */
const VALUED = new Set(['--args-file', '--agent', '--scope', '--port', '--host', '--keypair', '--yes']);
/** The flags each command takes; any other is refused. */
const TOOL_FLAGS = ['--json'];
const FLAGS = {
  mcp: ['--http', '--port', '--host'],
  guide: TOOL_FLAGS,
  examples: TOOL_FLAGS,
  check: TOOL_FLAGS,
  simulate: TOOL_FLAGS,
  cost: TOOL_FLAGS,
  explain: TOOL_FLAGS,
  review: TOOL_FLAGS,
  publish: TOOL_FLAGS,
  status: TOOL_FLAGS,
  token: TOOL_FLAGS,
  keygen: [],
  approve: ['--keypair', '--yes', '--browser', '--port', '--no-open'],
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
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--'))
        throw new UsageError(`${name} needs a value (${name} <value> or ${name}=<value>).`);
      values.set(name, rest[++i]);
    }
  }
  return { flags, values, positional };
}

/** What `xsolana approve` says when it is not told how the setup is signed. */
const HOW_TO_SIGN = `xsolana approve: say how going live is signed.

  --keypair <keyfile>   a key file on this machine signs (the usual way: no browser, no page). It shows everything that
                        would be sent and sends nothing until it is told yes. \`xsolana keygen <file>\` makes a key file.
  --browser             a browser wallet signs, on a page this command serves on this machine. Only when the person
                        whose economy it is asks for that.`;

/** The port `xsolana approve --browser` listens on: a whole number from 1 to 65535, or undefined for any free one. */
function portOf(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < 1 || n > 65535)
    throw new UsageError(`--port must be a whole number from 1 to 65535, not ${JSON.stringify(value)}.`);
  return n;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, values, positional } = parseArgs(rest);
  const takes = Object.hasOwn(FLAGS, command) ? FLAGS[command] : null;
  const unknown = takes && [...flags].find(f => !takes.includes(f));
  if (unknown)
    throw new UsageError(
      `“${command}” takes no ${unknown} flag (${takes.length ? `only ${takes.join(', ')}` : 'it takes none'}).`,
    );

  async function tool(name, input) {
    const { runTool } = await import('../js/mcp/server.mjs');
    const r = await runTool(name, input, { cwd: process.cwd() });
    const failed = Boolean(r.isError || r.ok === false);
    // A review is a report whatever it finds: printed on stdout, its exit code saying whether a finding is high.
    const report = name === 'xsolana_review' && !r.isError && !r.refusals;
    if (flags.has('--json')) console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    else (failed && !report ? console.error : console.log)(r.text ?? JSON.stringify(r, null, 2));
    if (failed) process.exitCode = 1;
  }

  const fileInput = () => (positional[0] ? { file: positional[0] } : {});

  switch (command) {
    case 'mcp': {
      if (flags.has('--http')) {
        const { serveHttp } = await import('../js/mcp/http.mjs');
        await serveHttp({ port: portOf(values.get('--port')) ?? 8787, host: values.get('--host') ?? '127.0.0.1' });
        break;
      }
      if (flags.has('--port') || flags.has('--host')) throw new UsageError('--port and --host go with --http.');
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
    case 'review':
    case 'publish':
    case 'status':
      await tool(`xsolana_${command}`, fileInput());
      break;
    case 'token':
      if (!positional[0]) throw new UsageError('xsolana token <mint>: give the token’s mint address.');
      await tool('xsolana_token', { mint: positional[0] });
      break;
    case 'keygen': {
      if (!positional[0])
        throw new UsageError(
          'xsolana keygen <file>: say where the key file goes, outside any repository (for example ~/.config/xsolana/my-game.json).',
        );
      const { makeKeyFile } = await import('../js/approve/keyfile.mjs');
      const made = await makeKeyFile(positional[0]);
      console.log(
        [
          `A new key is in ${made.file}, readable by you alone. Its address:`,
          `  ${made.address}`,
          'Whatever is set up with it, it owns: anyone who can read that file controls the project. Keep the file where it is, back it up as you would a password, and never paste it into a chat, a spec, a repository or a page.',
          `It holds nothing yet. Send it devnet SOL (\`xsolana cost\` says what going live takes; https://faucet.solana.com gives some), then: xsolana approve xsolana.json --keypair ${made.file}`,
        ].join('\n'),
      );
      break;
    }
    case 'approve': {
      const file = positional[0] ?? 'xsolana.json';
      const keyFile = values.get('--keypair');
      const page = flags.has('--browser');
      if (keyFile !== undefined && page)
        throw new UsageError('--keypair and --browser are two ways to sign: give one.');
      if (keyFile !== undefined) {
        if (flags.has('--port') || flags.has('--no-open'))
          throw new UsageError('--port and --no-open go with --browser.');
        const { approveWithKey } = await import('../js/approve/with-key.mjs');
        // On a terminal the person is asked there; anywhere else what would be sent is shown with its code.
        const terminal = process.stdin.isTTY && process.stdout.isTTY;
        const confirm = async question => {
          const { createInterface } = await import('node:readline/promises');
          const lines = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return (await lines.question(question)).trim().toLowerCase() === 'yes';
          } finally {
            lines.close();
          }
        };
        const r = await approveWithKey({
          file,
          keyFile,
          yes: values.get('--yes') ?? null,
          confirm: terminal ? confirm : null,
        });
        if (!r.ok) process.exitCode = 1;
        break;
      }
      if (flags.has('--yes')) throw new UsageError('--yes goes with --keypair.');
      if (!page) {
        console.error(HOW_TO_SIGN);
        process.exitCode = 1;
        break;
      }
      const port = portOf(values.get('--port'));
      const { approve } = await import('../js/approve/server.mjs');
      await approve({ file, port, open: !flags.has('--no-open') });
      break;
    }
    case 'connect': {
      const { connect } = await import('../js/connect/connect.mjs');
      process.exitCode = await connect({
        agent: values.get('--agent'),
        local: flags.has('--local'),
        remove: flags.has('--remove'),
        dryRun: flags.has('--dry-run'),
        scope: values.get('--scope'),
      });
      break;
    }
    case 'tool': {
      const { tools } = await import('../js/mcp/tools.mjs');
      if (flags.has('--list') || !positional[0]) {
        for (const t of tools) console.log(`${t.name}\n  ${t.description.split('. ')[0]}.`);
        break;
      }
      const from = values.get('--args-file');
      const raw = from ? await readFile(from, 'utf8') : (positional[1] ?? '{}');
      let input;
      try {
        input = JSON.parse(raw);
      } catch (e) {
        throw new UsageError(
          `The arguments ${from ? `in ${from} ` : ''}are not JSON (${e.message}). Give them as one word, as in: xsolana tool xsolana_check '{"file":"xsolana.json"}'.`,
          { cause: e },
        );
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
  if (e?.code === 'EADDRINUSE')
    return `Port ${e.port} is in use: pick another with --port, or leave it out for any free one.`;
  return String(e?.message ?? e);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (process.env.XSOLANA_DEBUG) console.error(e);
  else console.error(`xsolana: ${oneLine(e)}`);
  process.exitCode = 1;
}
