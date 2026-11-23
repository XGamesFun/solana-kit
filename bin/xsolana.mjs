#!/usr/bin/env node
// xsolana: the command line of @xgamesfun/solana. Every tool the MCP server has runs here too, with the same arguments and
// the same answer, for an agent (or a person) without MCP: a tool's words name each tool as the command that runs it
// here (`xsolana check`, where the server says xsolana_check).
//
//   xsolana mcp                          serve the tools over stdio (what a plugin's MCP config runs)
//   xsolana mcp --http [--port n] [--host h]   serve the hosted tools over HTTP at /mcp (127.0.0.1:8787 by default)
//   xsolana guide [part] [--json]        the guide's index; with a part or a topic (writing, cheating, asks, cannot), that one
//   xsolana examples [words…] [--json]   the nearest worked examples and rated economies
//   xsolana examples <name> [--save <file>]   one worked example whole; --save writes its spec into a new file
//   xsolana check|simulate|cost|explain|review|publish|status [file] [--json]   one tool on a spec file (default xsolana.json)
//   xsolana client [--json]               the program and its calls, for an app
//   xsolana token <mint> [--json]         a token made elsewhere, read from the chain: its `tokens` entry, powers and all
//   xsolana keygen <file>                 make a key file for a project's owner (outside any repository; the key is never printed)
//   xsolana approve [file] --keypair <keyfile> [--yes <code>]   put the economy live, signed by a key file: no browser, no page
//       [--mint-key <token>=<keyfile>]…   a token's new mint at the address of a key file the owner has
//   xsolana approve [file] --browser [--port n] [--no-open]     the same in a browser wallet, on a local page: only when the person asks for it
//   xsolana connect [--agent claude|codex] [--scope user|project] [--local] [--remove] [--dry-run]   register the MCP server and the skill
//   xsolana tool --list | xsolana tool <name> '<json>' [--args-file f] [--json]   any tool by name
//   xsolana version
//   xsolana help [command], xsolana <command> --help (or -h)   the commands, or one command's words, flags and all
//
// A flag with a value is written either way: --agent claude or --agent=claude; a flag the command doesn't take is
// refused, and so is a word more than it takes. A command that fails says why on stderr and exits 1: a usage error in
// one line (XSOLANA_DEBUG=1 prints the whole stack), a tool's refusal with the tool's own answer. `--json` prints a
// tool's whole answer on stdout, whatever it is, and the exit code still says whether it failed.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** A failure the person caused (a bad flag, a missing file): said in one line, without a stack. */
class UsageError extends Error {}

/** The flags that take a value: `--name value` or `--name=value`. */
const VALUED = new Set([
  '--args-file',
  '--agent',
  '--scope',
  '--port',
  '--host',
  '--keypair',
  '--yes',
  '--mint-key',
  '--save',
]);
/** The valued flags that may be given more than once: each value is kept, in order (`lists`). */
const REPEATED = new Set(['--mint-key']);
/** The flags each command takes; any other is refused (`--help`, or `-h`, is every command's). */
const TOOL_FLAGS = ['--json'];
const FLAGS = {
  mcp: ['--http', '--port', '--host'],
  guide: TOOL_FLAGS,
  examples: ['--save', ...TOOL_FLAGS],
  check: TOOL_FLAGS,
  simulate: TOOL_FLAGS,
  cost: TOOL_FLAGS,
  explain: TOOL_FLAGS,
  review: TOOL_FLAGS,
  publish: TOOL_FLAGS,
  status: TOOL_FLAGS,
  client: TOOL_FLAGS,
  token: TOOL_FLAGS,
  keygen: [],
  approve: ['--keypair', '--yes', '--mint-key', '--browser', '--port', '--no-open'],
  connect: ['--agent', '--scope', '--local', '--remove', '--dry-run'],
  tool: ['--list', '--args-file', ...TOOL_FLAGS],
  version: [],
};

const JSON_FLAG = '--json   the whole answer as JSON on stdout; the exit code still says whether it failed';
const FILE_WORD = 'file     the spec file, in this folder or one below it (xsolana.json when left out)';
/** A command that runs one tool on a spec file: its help, but for what the tool says. */
const onFile = (command, does, more) => ({
  lines: [[`xsolana ${command} [file]`, does]],
  words: [1, 'one file'],
  tool: ['file'],
  more: [more, FILE_WORD, JSON_FLAG],
});

/**
 * Every command, in the order the help lists them. `lines`: what the help's first screen says of it, as [what is
 * typed, what it does]. `words`: the most words it takes after its name, and what they are (more are refused).
 * `tool`: for a command that runs the tool xsolana_<command>, the tool's arguments its words stand for, so a tool's
 * answer can name that tool as this command. `more`: what its own help adds, every flag it takes among it.
 */
const COMMANDS = {
  guide: {
    lines: [['xsolana guide [part]', 'what an economy can be made of: an index, then one part or topic']],
    words: [1, 'one part or topic'],
    tool: ['part'],
    more: [
      'With no part, the index: how to go about it, and every part and topic with when to read it.',
      'part     a part of an economy (tokens, items, boxes, lotteries, farms…) or a topic (writing, cheating, asks,\n         cannot): the index names them all',
      JSON_FLAG,
    ],
  },
  examples: {
    lines: [
      ['xsolana examples [words…]', 'where to start: the worked examples and rated economies nearest your words'],
      ['xsolana examples <name>', 'one worked example whole; --save <file> writes its spec into a new file'],
    ],
    words: [Infinity],
    tool: ['name', 'query'],
    more: [
      'With no words, every worked example by name. With words, the nearest examples, the nearest of the rated\neconomies, and what loot does not do in them with the nearest versions it does.',
      'name          one word that is an example’s name: that example, with its whole spec',
      '--save <file> with a name: write that example’s spec into <file> (xsolana.json, say), to change and then check.\n              A file that is there already is never written over',
      JSON_FLAG,
    ],
  },
  check: onFile(
    'check',
    'refusals and warnings (default xsolana.json)',
    'Refusals keep a spec from going live, each with its fix; warnings are what its owner should hear. Exits 1 when\nit refuses.',
  ),
  simulate: onFile(
    'simulate',
    'the quick simulation',
    'Expected values from the spec and its scenario: what each box, ticket and craft gives back against its price,\neach pool’s money in and out, and what players, the treasury and the platform get a day.',
  ),
  cost: onFile(
    'cost',
    'what going live and each action cost',
    'What going live takes (rent, fees, seeds, how many transactions) and what each action costs whoever signs it.\nNothing is sent.',
  ),
  explain: onFile(
    'explain',
    'the economy in plain words',
    'What players do and what it costs and is worth, how the pools fill and drain, what runs by itself and what the\nauthority signs.',
  ),
  review: onFile(
    'review',
    'what a cheater gets on each route, and what to fix before going live',
    'For every route that pays or gives value: who can trigger it, what the program enforces, what it trusts off the\nchain and the most one cheater gets. A report: printed on stdout whatever it finds, and it exits 1 when a\nfinding is high.',
  ),
  publish: onFile(
    'publish',
    'what going live does, and how to approve it',
    'Every step going live takes, in order, with its cost, and the commands that do it. It sends nothing: `xsolana\napprove` does.',
  ),
  keygen: {
    lines: [
      [
        'xsolana keygen <file>',
        'make a key file for the project’s owner, outside any repository (prints its address, never the key)',
      ],
    ],
    words: [1, 'one path'],
    tooMany: 'xsolana keygen <file> makes one key file: give one path (in quotes when it has a space).',
    more: [
      'file     where the key file goes, outside any repository: ~/.config/xsolana/my-game.json, say. It is made for\n         its user alone, and a file that is there already is never written over',
      'The key is the project’s owner for good: back the file up yourself, and never paste it anywhere.',
    ],
  },
  approve: {
    lines: [
      [
        'xsolana approve [file] --keypair <keyfile>',
        'what going live sends, then (--yes <code>) send it, signed by that key file (--mint-key <token>=<keyfile>: that token’s new mint at the address of a key file you have)',
      ],
      [
        'xsolana approve [file] --browser',
        'the same on a local page, signed in a browser wallet (--port n, --no-open)',
      ],
    ],
    words: [1, 'one file'],
    // (`more` is HOW_TO_SIGN's, below)
  },
  status: onFile(
    'status',
    'a live economy on chain',
    'The project, each pool’s balance and every record the spec names, found or missing. It reads the economy’s own\ncluster: devnet through its public RPC (or XSOLANA_RPC_URL), mainnet through XSOLANA_RPC_URL.',
  ),
  token: {
    lines: [
      [
        'xsolana token <mint>',
        'a token made elsewhere, as the chain has it: its "tokens" entry, with what its mint can do',
      ],
    ],
    words: [1, 'one mint address'],
    tool: ['mint'],
    more: [
      'mint     the token’s mint address. It is read on the cluster of the economy in this folder: devnet, unless\n         xsolana.json says "network": "mainnet"',
      JSON_FLAG,
    ],
  },
  client: {
    lines: [['xsolana client', 'the program and its calls, for an app that uses a live economy']],
    words: [0],
    tool: [],
    more: [
      'The program’s address and cluster, the npm package and IDL, and the calls a page makes with the player’s own\nwallet.',
      JSON_FLAG,
    ],
  },
  connect: {
    lines: [
      [
        'xsolana connect',
        'add the xsolana tools and the skill to Claude Code and Codex (--agent, --scope, --local, --remove, --dry-run)',
      ],
    ],
    words: [0],
    more: [
      'It runs each agent’s own commands, and never edits an agent’s config file.',
      '--agent claude|codex   that agent alone (both when left out)',
      '--scope user|project   for every project of this user (the default), or for the folder it runs in only',
      '--local                run the server from this checkout, not from npm',
      '--remove               take the tools and the skill out again',
      '--dry-run              print what would be run, and run nothing',
    ],
  },
  mcp: {
    lines: [
      ['xsolana mcp', 'serve the tools over MCP (stdio)'],
      ['xsolana mcp --http', 'serve the hosted tools over HTTP at http://127.0.0.1:8787/mcp (--port n, --host h)'],
    ],
    words: [0],
    more: [
      'Over stdio it is what an agent’s MCP config runs. Over HTTP it serves the tools that read no file of yours.',
      '--http        serve over HTTP, at /mcp',
      '--port <n>    with --http: the port (8787)',
      '--host <h>    with --http: the address to listen on (127.0.0.1)',
    ],
  },
  tool: {
    lines: [
      [
        'xsolana tool --list',
        "every tool by name; xsolana tool <name> '<json>' runs one (--args-file f; --help for its arguments). xsolana_design (the specs that do what a person wants) and xsolana_save (save a spec given whole) have no command of their own",
      ],
    ],
    words: [2, 'a tool’s name and its arguments as one word of JSON, in quotes (\'{"file":"xsolana.json"}\')'],
    more: [
      'name               a tool’s name, as --list gives it. With --help: that tool’s arguments',
      "'<json>'           its arguments, one JSON object in quotes ({} when left out)",
      '--args-file <f>    read the arguments from a JSON file',
      '--list             every tool, with the command that runs it when it has one',
      JSON_FLAG,
    ],
  },
  version: {
    lines: [['xsolana version', 'this package’s version, the loot program it is built for, and the cluster']],
    words: [0],
    more: [],
  },
};

/** `text` in lines of at most `width` columns, cut between words. */
function wrapped(text, width) {
  const lines = [];
  for (const word of text.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** One [what is typed, what it does] of the help: the second from column 34, on the same line when the first leaves room. */
function helpLine([typed, does]) {
  const [first, ...rest] = wrapped(does, 84);
  const under = ' '.repeat(34);
  return [
    typed.length < 32 ? `  ${typed.padEnd(32)}${first}` : `  ${typed}\n${under}${first}`,
    ...rest.map(l => under + l),
  ].join('\n');
}

const USAGE = `xsolana: the tools for loot, one shared Solana program for game and community economies.

${Object.values(COMMANDS)
  .flatMap(c => c.lines.map(helpLine))
  .join('\n')}
  xsolana help [command]          this screen, or one command’s words and flags (also: xsolana <command> --help)

  A tool’s command (guide, examples, check … status, token, client, tool) takes --json for its whole answer as
  JSON. review exits 1 when it finds something high.`;

/**
 * The arguments after the command: { flags (every --name given), values (--name → value), lists (--name → every
 * value of a flag that may be given more than once), positional }. `-h` is `--help`; after a bare `--`, every
 * argument is a word, whatever it starts with.
 */
function parseArgs(rest) {
  const flags = new Set();
  const values = new Map();
  const lists = new Map();
  const positional = [];
  const keep = (name, value) => {
    if (REPEATED.has(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
    else values.set(name, value);
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (a === '-h') {
      flags.add('--help');
      continue;
    }
    // (a short flag is not a file's name: read as one, "-v" would be "not a .json file")
    if (/^-[A-Za-z]/.test(a))
      throw new UsageError(`There is no ${a} flag: flags are written whole (--json), and -h is --help.`);
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUED.has(name) && flags.has(name) && !REPEATED.has(name))
      throw new UsageError(`${name} is given twice: give it once.`);
    if (eq > 0 && !VALUED.has(name)) throw new UsageError(`${name} takes no value: write it alone, or leave it out.`);
    flags.add(name);
    if (eq > 0) keep(name, a.slice(eq + 1));
    else if (VALUED.has(name)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--'))
        throw new UsageError(`${name} needs a value (${name} <value> or ${name}=<value>).`);
      keep(name, rest[++i]);
    }
  }
  return { flags, values, lists, positional };
}

/** The two ways going live is signed, each with its flags. */
const WAYS_TO_SIGN = `  --keypair <keyfile>   a key file on this machine signs (the usual way: no browser, no page). It shows everything that
                        would be sent, with a code, and sends nothing; run again with --yes <code>, it sends exactly
                        that. \`xsolana keygen <file>\` makes a new project's key file; one that is live is signed
                        only by the key it went live with.
  --mint-key <token>=<keyfile>   with --keypair: make that token's new mint at the address of a key file you have
                        (an address you chose), not at a new one. Given once for each such token. The file signs the
                        transaction that makes the mint and no other. After that it can do nothing more at that
                        address on that cluster; on another cluster it still can, so keep it safe until then.
  --browser             a browser wallet signs, on a page this command serves on this machine until it is live. Only
                        when the person whose economy it is asks for that; they run it themselves.`;
/** What `xsolana approve` says when it is not told how the setup is signed. */
const HOW_TO_SIGN = `xsolana approve: say how going live is signed.\n\n${WAYS_TO_SIGN}`;
COMMANDS.approve.more = [
  'file     the spec file (xsolana.json when left out). What lands is written back into it',
  WAYS_TO_SIGN.replace(/^ {2}/gm, ''),
  '--yes <code>          with --keypair: send what was shown, by the code that printout ended with',
  '--port <n>            with --browser: the port the page is served on (any free one when left out)',
  '--no-open             with --browser: print the link, and open no browser',
];

/** One command's own help: what is typed, what it does, and each word and flag it takes. */
function helpFor(command) {
  const c = COMMANDS[command];
  return [...c.lines.map(helpLine), ...(c.more.length ? ['', ...c.more.map(m => m.replace(/^/gm, '  '))] : [])].join(
    '\n',
  );
}

/**
 * One tool's help, for `xsolana tool <name> --help`: what it is, the command that runs it when it has one, and its
 * arguments as its input schema names them.
 */
function toolHelp(t, terminalWords) {
  const command = t.name.slice('xsolana_'.length);
  const fields = Object.entries(t.inputSchema.properties ?? {});
  const required = new Set(t.inputSchema.required ?? []);
  return [
    `xsolana tool ${t.name} '<json>'   ${t.title}${COMMANDS[command]?.tool ? ` (also: xsolana ${command})` : ''}`,
    '',
    terminalWords(t.description, TERMINAL),
    '',
    fields.length ? 'Its arguments, as one JSON object:' : 'It takes no arguments.',
    ...fields.map(
      ([name, f]) =>
        `  ${name} (${f.type ?? 'any'}${required.has(name) ? ', needed' : ''})${f.description ? `: ${f.description}` : ''}`,
    ),
  ].join('\n');
}

/**
 * How a tool's answer is worded in a terminal (server.mjs `terminalWords`): each command that runs a tool, with the
 * tool's arguments its words stand for.
 */
const TERMINAL = Object.fromEntries(
  Object.entries(COMMANDS)
    .filter(([, c]) => c.tool)
    .map(([name, c]) => [name, c.tool]),
);

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
  const { flags, values, lists, positional } = parseArgs(rest);
  const known = Object.hasOwn(FLAGS, command);
  // A command's own help: `xsolana <command> --help` (or -h), and `xsolana help <command>`.
  const helped = command === 'help' ? positional[0] : known && flags.has('--help') ? command : null;
  if (helped !== null && helped !== undefined) {
    if (!Object.hasOwn(COMMANDS, helped))
      throw new UsageError(`There is no command “${helped}”: xsolana help lists them all.`);
    if (helped === 'tool' && command === 'tool' && positional[0]) {
      const { tools } = await import('../js/mcp/tools.mjs');
      const { terminalWords } = await import('../js/mcp/server.mjs');
      const t = tools.find(x => x.name === positional[0]);
      if (!t) throw new UsageError(`There is no tool “${positional[0]}”: xsolana tool --list names them all.`);
      console.log(toolHelp(t, terminalWords));
      return;
    }
    console.log(helpFor(helped));
    return;
  }
  const takes = known ? FLAGS[command] : null;
  const unknown = takes && [...flags].find(f => !takes.includes(f));
  if (unknown)
    throw new UsageError(
      `“${command}” takes no ${unknown} flag (${takes.length ? `only ${takes.join(', ')}` : 'it takes none'}).`,
    );
  // A word more than the command takes is refused: dropped, it would look as if it had been read.
  const [most, what] = known ? COMMANDS[command].words : [Infinity];
  if (positional.length > most) {
    const extra = positional.slice(most).map(w => `“${w}”`);
    throw new UsageError(
      COMMANDS[command].tooMany ??
        `xsolana ${command} takes ${what ?? 'nothing after its name'}: ${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} more than that.`,
    );
  }

  /**
   * Names the cluster this command works on: the network of the economy it is given, as `what` names it. A cluster
   * the environment names otherwise is refused, for every command alike. With no economy to read (`network` null),
   * the command works on the process's own cluster.
   */
  async function onCluster(network, what) {
    if (!network) return;
    const { useCluster } = await import('../js/client/cluster.js');
    try {
      useCluster(network);
    } catch {
      throw new UsageError(
        `${what} is on ${network}, and XSOLANA_CLUSTER says ${process.env.XSOLANA_CLUSTER}: unset it, or change the economy’s "network".`,
      );
    }
  }

  /**
   * Runs one tool and prints its answer, in a terminal's words: the tool's own refusal on stderr, with exit 1.
   * `done`: what to say in place of the tool's words when it went well.
   */
  async function tool(name, input, done = null) {
    const { networkOfInput, runTool } = await import('../js/mcp/server.mjs');
    const ctx = { cwd: process.cwd(), terminal: TERMINAL };
    // The economy's cluster is read as the tool reads it (a spec given whole, an example, a file).
    const given = input && typeof input === 'object' ? input : {};
    await onCluster(
      await networkOfInput(given, ctx),
      given.spec ? 'The economy' : given.example ? `The example ${given.example}` : (given.file ?? 'xsolana.json'),
    );
    const r = await runTool(name, input, ctx);
    const failed = Boolean(r.isError || r.ok === false);
    // A review is a report whatever it finds: printed on stdout, its exit code saying whether a finding is high.
    const report = name === 'xsolana_review' && !r.isError && !r.refusals;
    if (flags.has('--json')) console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    else if (done && !failed) console.log(done);
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
    case 'guide': {
      if (positional[0]) {
        // (a word that is no part is refused in the command's own words: the tool would say "arguments.part")
        const { tools } = await import('../js/mcp/tools.mjs');
        const parts = tools.find(t => t.name === 'xsolana_guide').inputSchema.properties.part.enum;
        if (!parts.includes(positional[0]))
          throw new UsageError(
            `xsolana guide: there is no part or topic “${positional[0]}”. It takes one of: ${parts.join(', ')}.`,
          );
      }
      await tool('xsolana_guide', positional[0] ? { part: positional[0] } : {});
      break;
    }
    case 'examples': {
      // One word that is an example's name is that example, whole; any other words are searched for.
      const { examples } = await import('../js/economy/examples.mjs');
      const named = positional.length === 1 ? examples().find(e => e.name === positional[0]) : null;
      const into = values.get('--save');
      if (into === undefined) {
        await tool(
          'xsolana_examples',
          named ? { name: named.name } : positional.length ? { query: positional.join(' ') } : {},
        );
        break;
      }
      if (!named)
        throw new UsageError(
          '--save goes with one example’s name: xsolana examples <name> --save <file> (xsolana examples lists the names).',
        );
      // A start from an example is a new file: one that is there may be somebody's economy, live or not.
      if (existsSync(path.resolve(into)))
        throw new UsageError(`${into} is there already, and --save writes only a new file: name another.`);
      await tool(
        'xsolana_save',
        { spec: named.spec, file: into },
        `${into} now holds the worked example “${named.name}”, whole. Change it to your own economy (xsolana guide says what each part takes), then run: xsolana check${into === 'xsolana.json' ? '' : ` ${into}`}`,
      );
      break;
    }
    case 'client':
      await tool('xsolana_client', {});
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
      if (positional.length > 1)
        throw new UsageError(
          'xsolana keygen <file> makes one key file: give one path (in quotes when it has a space).',
        );
      const { makeKeyFile } = await import('../js/approve/keyfile.mjs');
      const { PACKAGE_VERSION } = await import('../js/mcp/tools.mjs');
      const made = await makeKeyFile(positional[0]);
      // The file as it was named when that is the home folder's (`~/…` reads the same in any shell), else whole; in
      // quotes when a shell would split it.
      const named = positional[0].startsWith('~') ? positional[0] : made.file;
      const word = /^[\w./~:\\-]+$/.test(named) ? named : `"${named}"`;
      console.log(
        [
          `A new key is in ${made.file}${process.platform === 'win32' ? '' : ', readable by you alone'}. Its address:`,
          `  ${made.address}`,
          'Whatever is set up with it, it owns, for good: anyone who can read that file controls the project, and every later change is signed by it. Keep the file where it is and never paste it into a chat, a spec, a repository or a page. Back it up yourself (a USB stick, a password manager): if it is lost, nothing can change the project or move what its address holds.',
          `It holds nothing yet. Send it SOL (\`xsolana cost\` says what going live takes): devnet SOL for an economy on devnet (https://faucet.solana.com gives some), real SOL for one whose file says "network": "mainnet". Then: npx -y @xgamesfun/solana@${PACKAGE_VERSION} approve xsolana.json --keypair ${word}`,
        ].join('\n'),
      );
      break;
    }
    case 'approve': {
      const file = positional[0] ?? 'xsolana.json';
      // (a file that is missing or not JSON is left to the approval, which says so in its own words)
      const { networkOfFile } = await import('../js/mcp/server.mjs');
      await onCluster(await networkOfFile(file), file);
      const keyFile = values.get('--keypair');
      const page = flags.has('--browser');
      if (keyFile !== undefined && page)
        throw new UsageError('--keypair and --browser are two ways to sign: give one.');
      // A key file for a token's new mint, so the mint is at an address the owner chose: <token key>=<key file>.
      const mintKeyFiles = new Map();
      for (const pair of lists.get('--mint-key') ?? []) {
        const eq = pair.indexOf('=');
        if (eq <= 0 || eq === pair.length - 1)
          throw new UsageError(
            '--mint-key takes <token key>=<key file>: the token’s key in the spec, then the key file its mint is made at.',
          );
        const token = pair.slice(0, eq);
        if (mintKeyFiles.has(token))
          throw new UsageError(`--mint-key names the token “${token}” twice: give it one key file.`);
        mintKeyFiles.set(token, pair.slice(eq + 1));
      }
      if (flags.has('--mint-key') && keyFile === undefined) throw new UsageError('--mint-key goes with --keypair.');
      if (keyFile !== undefined) {
        if (flags.has('--port') || flags.has('--no-open'))
          throw new UsageError('--port and --no-open go with --browser.');
        const { approveWithKey } = await import('../js/approve/with-key.mjs');
        // It shows, and sends only when given the code of what it showed: it never stops to ask.
        const r = await approveWithKey({ file, keyFile, yes: values.get('--yes') ?? null, mintKeyFiles });
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
        // Each tool by its title (what a client shows a person), with the command that runs it when it has one.
        const list = tools.map(t => {
          const command = t.name.slice('xsolana_'.length);
          return {
            name: t.name,
            title: t.title,
            ...(COMMANDS[command]?.tool ? { command: `xsolana ${command}` } : {}),
          };
        });
        if (flags.has('--json')) console.log(JSON.stringify(list, null, 2));
        else for (const t of list) console.log(`${t.name}\n  ${t.title}${t.command ? ` (${t.command})` : ''}`);
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
      // The package's own version first (what `npx @xgamesfun/solana@<version>` names), then the program's it is built for.
      const { PACKAGE_VERSION, VERSION, PROGRAM_INFO } = await import('../js/mcp/tools.mjs');
      console.log(
        `@xgamesfun/solana ${PACKAGE_VERSION} · loot ${VERSION} · program ${PROGRAM_INFO.program} · ${PROGRAM_INFO.cluster}`,
      );
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
  // (a line that already starts with the command it is about is not named twice)
  const line = oneLine(e);
  if (process.env.XSOLANA_DEBUG) console.error(e);
  else console.error(/^xsolana[ :]/.test(line) ? line : `xsolana: ${line}`);
  process.exitCode = 1;
}
