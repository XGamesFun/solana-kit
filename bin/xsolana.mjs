#!/usr/bin/env node
// xsolana: the command line of @xgamesfun/solana. Every tool the MCP server has runs here too, with the same arguments and
// the same answer, for an agent (or a person) without MCP: a tool's words name each tool as the command that runs it
// here (`xsolana check`, where the server says xsolana_check).
//
//   xsolana mcp                          serve the tools over stdio (what a plugin's MCP config runs)
//   xsolana mcp --http [--port n] [--host h]   serve the hosted tools over HTTP at /mcp (127.0.0.1:8787 by default)
//   xsolana guide [part] [--json]        the guide's index; with a part or a topic (writing, cheating, asks, cannot), that one
//   xsolana examples [words…] [--json]   the nearest worked examples and rated kinds of economy
//   xsolana examples <name> [--save <file>]   one worked example whole; --save writes its spec into a new file
//   xsolana check|simulate|cost|explain|review|publish|status [file] [--json]   one tool on a spec file (default xsolana.json);
//                                       check --verbose adds what players should know and how each route ends
//   xsolana client [--json]               the program and its calls, for an app
//   xsolana token <mint> [--json]         a token made elsewhere, read from the chain: its `tokens` entry, powers and all
//   xsolana keygen <file>                 make a key file for a project's owner (outside any repository; the key is never printed)
//   xsolana approve [file] --keypair <keyfile> [--yes <code>]   put the economy live, signed by a key file: no browser, no page
//       [--mint-key <token>=<keyfile>]…   a token's new mint at the address of a key file the owner has
//   xsolana approve [file] --browser [--port n] [--no-open]     the same in a browser wallet, on a local page: only when its owner asks for it
//   xsolana connect [--agent claude|codex] [--scope user|project] [--local] [--remove] [--dry-run]   register the MCP server and the skill
//   xsolana tool --list | xsolana tool <name> '<json>' [--args-file f] [--json]   any tool by name
//   xsolana version
//   xsolana help [command], xsolana <command> --help (or -h)   the commands, or one command's words, flags and all
//
// A flag with a value is written either way: --agent claude or --agent=claude; a flag the command doesn't take is
// refused, and so is a word more than it takes. A command given wrongly says why in one line on stderr and exits 2
// (XSOLANA_DEBUG=1 prints the whole stack); one that fails says why and exits 1, a tool's refusal with the tool's own
// answer. `--json` prints a
// tool's whole answer on stdout, whatever it is, and the exit code still says whether it failed.
//
// Who reads it: a named command (check, review…) is read by the developer, so its text is worded for them
// (js/mcp/person.mjs); `xsolana tool <name>` and `--json` give the answer an agent gets over MCP, word for word.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** A command given wrongly (a bad flag, a word too many, no such command): said in one line, without a stack. */
class UsageError extends Error {}
/**
 * The exit codes: 0 it went well; 1 it failed or found what it exits on (a refusal, a high finding, an approval that
 * did not land, a missing file); 2 the command was given wrongly (UsageError), as in xcore and most command lines.
 */
const USAGE_EXIT = 2;

/** How many single-letter edits turn `a` into `b` (Levenshtein). */
function edits(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
/** " Did you mean …?" for a name a typo away from one of `names` (at most two edits, and fewer than half its letters). */
function didYouMean(given, names) {
  const near = names
    .map(n => [n, edits(String(given).toLowerCase(), n)])
    .filter(([n, d]) => d <= 2 && d < n.length / 2)
    .sort((a, b) => a[1] - b[1]);
  return near.length ? ` Did you mean ${near[0][0]}?` : '';
}

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
  '--to',
]);
/** The valued flags that may be given more than once: each value is kept, in order (`lists`). */
const REPEATED = new Set(['--mint-key']);
/** The flags each command takes; any other is refused (`--help`, or `-h`, is every command's). */
const TOOL_FLAGS = ['--json'];
const FLAGS = {
  mcp: ['--http', '--port', '--host'],
  guide: TOOL_FLAGS,
  examples: ['--save', ...TOOL_FLAGS, '--verbose'],
  check: [...TOOL_FLAGS, '--verbose'],
  simulate: [...TOOL_FLAGS, '--verbose'],
  cost: [...TOOL_FLAGS, '--verbose'],
  explain: [...TOOL_FLAGS, '--verbose'],
  review: [...TOOL_FLAGS, '--verbose'],
  publish: TOOL_FLAGS,
  status: TOOL_FLAGS,
  client: TOOL_FLAGS,
  token: TOOL_FLAGS,
  keygen: [],
  approve: ['--keypair', '--yes', '--mint-key', '--browser', '--port', '--no-open'],
  handover: ['--keypair', '--to', '--yes'],
  connect: ['--agent', '--scope', '--local', '--remove', '--dry-run'],
  tool: ['--list', '--args-file', '--json'],
  version: [],
};

const FILE_ARG = ['file', 'the spec file, in this folder or a folder below it (default: xsolana.json)'];
const JSON_OPT = [
  '--json',
  'print the whole answer as JSON on stdout, as an AI agent gets it; the exit code still says whether it failed',
];
const VERBOSE_OPT = [
  '--verbose',
  'also print each warning in full with its fix, what players should know and how each route ends',
];
const verbose = what => ['--verbose', `also print ${what}`];
const HELP_OPT = ['-h, --help', 'show this help'];

/** A command that runs one tool on a spec file. */
const onFile = (command, summary, about, examples, more = []) => ({
  group: 'spec',
  summary,
  usage: [`xsolana ${command} [file] [options]`],
  words: [1, 'one file'],
  tool: ['file'],
  about,
  args: [FILE_ARG],
  options: [...more, JSON_OPT, HELP_OPT],
  examples,
});

/**
 * Every command, in the order the help lists them. `summary`: its line on the first help screen. `usage`: how it is
 * typed. `words`: the most words it takes after its name, and what they are (more are refused). `tool`: for a command
 * that runs the tool xsolana_<command>, the tool's arguments its words stand for, so a tool's answer can name that
 * tool as this command. `about`, `args`, `options`, `examples`: its own help (every flag it takes is in `options`).
 */
const COMMANDS = {
  guide: {
    group: 'spec',
    summary: 'Show what an economy spec can contain: an index, or one part or topic',
    usage: ['xsolana guide [part] [options]'],
    words: [1, 'one part or topic'],
    tool: ['part'],
    about:
      'Without a part, prints an index of every part of a spec and every topic, with when to read each. With a part, prints its fields from the schema, who acts at play time, and its nested shapes.',
    args: [
      [
        'part',
        'a part of an economy (tokens, items, boxes, lotteries, farms…) or a topic (writing, cheating, asks, cannot); the index lists them all',
      ],
    ],
    options: [JSON_OPT, HELP_OPT],
    examples: ['xsolana guide', 'xsolana guide boxes'],
  },
  examples: {
    group: 'spec',
    summary: 'Find worked examples and rated economy types close to your idea',
    usage: ['xsolana examples [words…] [options]', 'xsolana examples <name> [--save <file>]'],
    words: [Infinity],
    tool: ['name', 'query'],
    about:
      'Without words, lists every worked example. With words, prints the closest examples, the closest rated economy types, and what loot cannot do in your words, with the nearest versions it can. With one word that is an example’s name, prints that example’s whole spec.',
    args: [['words', 'your idea in a few words, or an example’s name']],
    options: [
      [
        '--save <file>',
        'with a name: write that example’s spec into <file> (for example xsolana.json), to change and then check; an existing file is never overwritten',
      ],
      [
        '--verbose',
        'also print each example’s prompt, and the rated kinds of economy that match (hand ratings, dated)',
      ],
      JSON_OPT,
      HELP_OPT,
    ],
    examples: ['xsolana examples shop with loot boxes', 'xsolana examples blind-forge --save xsolana.json'],
  },
  check: onFile(
    'check',
    'Check a spec: refusals (it cannot go live) and warnings',
    'Checks a spec and lists its refusals and warnings. A refusal keeps the spec from going live and comes with a fix. A warning is something the owner should know before going live; some raise a question only you can answer. Exits 1 when the spec is refused.',
    ['xsolana check', 'xsolana check game/xsolana.json --verbose'],
    [VERBOSE_OPT],
  ),
  simulate: onFile(
    'simulate',
    'Simulate where the money goes, day by day',
    'Computes expected values from the spec and its scenario. Prints a summary of each day, a table of what a player pays (on devnet, with mainnet’s figures), the odds, and each lottery, pool, farm and stash.',
    ['xsolana simulate', 'xsolana simulate --verbose'],
    [verbose('every part in words: what it gives, how its stock runs out, and each pool’s fate')],
  ),
  cost: onFile(
    'cost',
    'Price going live and each player or owner action',
    'Prices going live (rent, fees, seeds and the number of transactions) and what each action costs whoever signs it: for a player, what goes on top of the price, on devnet and on mainnet. Nothing is sent.',
    ['xsolana cost', 'xsolana cost --verbose'],
    [verbose('each account’s rent, what a wallet must hold when it signs, and what comes back')],
  ),
  explain: onFile(
    'explain',
    'Describe the economy in plain words',
    'Describes what players do and what it costs and is worth, how the pools fill and drain, what runs by itself, and what the authority signs, each section in short.',
    ['xsolana explain', 'xsolana explain --verbose'],
    [verbose('the whole text, and each route state by state as a player, the owner and a cheater see it')],
  ),
  review: onFile(
    'review',
    'Review the spec as a cheater would, before going live',
    'For every route that pays or gives value: who can trigger it and the most one cheater gets, then the findings by severity. Prints the report on stdout and exits 1 when a finding is high.',
    ['xsolana review', 'xsolana review --verbose'],
    [
      verbose(
        'what the program enforces and trusts on each route, every finding’s fix, the trade-offs, and a checklist',
      ),
    ],
  ),
  publish: onFile(
    'publish',
    'List the steps of going live and the commands that do them',
    'Lists every step going live takes, in order, with its cost, and the commands that do it. It sends nothing: `xsolana approve` does.',
    ['xsolana publish'],
  ),
  keygen: {
    group: 'live',
    summary: 'Make a key file for the project owner (prints the address, never the key)',
    usage: ['xsolana keygen <file>'],
    words: [1, 'one path'],
    tooMany: 'xsolana keygen <file> makes one key file: give one path (in quotes when it has a space).',
    about:
      'Makes a new key file, readable by you alone, and prints its address. The key owns the project it sets up until it hands the project to another key: back the file up yourself, keep it outside any repository, and never paste it anywhere. An existing file is never overwritten. For real money, a browser wallet that keeps its key on a hardware device is safer (approve --browser).',
    args: [['file', 'where the key file goes, outside any repository (for example ~/.config/xsolana/my-game.json)']],
    options: [HELP_OPT],
    examples: ['xsolana keygen ~/.config/xsolana/my-game.json'],
  },
  approve: {
    group: 'live',
    summary: 'Put the economy live: show what it sends, then send it with --yes <code>',
    usage: [
      'xsolana approve [file] --keypair <keyfile> [--yes <code>] [--mint-key <token>=<keyfile>]…',
      'xsolana approve [file] --browser [--port <n>] [--no-open]',
    ],
    words: [1, 'one file'],
    about:
      'Without --yes, prints every transaction going live would send, with what it pays and trusts, and ends with a code. It sends nothing. Run it again with --yes <code> to send exactly what was printed, signed by the key file. What lands is written back into the spec file.',
    args: [['file', 'the spec file (default: xsolana.json)']],
    // (options: WAYS_TO_SIGN, below)
    examples: [
      'xsolana approve xsolana.json --keypair ~/.config/xsolana/my-game.json',
      'xsolana approve xsolana.json --keypair ~/.config/xsolana/my-game.json --yes <code>',
    ],
  },
  handover: {
    group: 'live',
    summary: 'Hand a live project to a new owner key: both keys sign, as the program requires',
    usage: ['xsolana handover [file] --keypair <owner keyfile> --to <new owner keyfile> [--yes <code>]'],
    words: [1, 'one file'],
    about:
      'Hands the live project in the spec file to a new owner, with the program’s update_project, signed by the current owner’s key file and the new owner’s. Without --yes it reads the project from the chain, prints what changes, with a code, and sends nothing; run it again with --yes <code> to send exactly that. The authority, the treasury and the project’s address stay as they are. A new owner that is a browser or hardware wallet can’t sign here: see docs/before-you-use.md.',
    args: [['file', 'the live spec file (default: xsolana.json)']],
    options: [
      ['--keypair <keyfile>', 'the key file of the project’s current owner'],
      ['--to <keyfile>', 'the key file of the new owner, which signs too'],
      ['--yes <code>', 'send what was printed, by the code the printout ended with'],
      HELP_OPT,
    ],
    examples: [
      'xsolana handover --keypair ~/.config/xsolana/my-game.json --to ~/.config/xsolana/new-owner.json',
      'xsolana handover --keypair ~/.config/xsolana/my-game.json --to ~/.config/xsolana/new-owner.json --yes <code>',
    ],
  },
  status: onFile(
    'status',
    'Read a live economy from the chain',
    'Reads the project, each pool’s balance and every record the spec names, found or missing. It reads the economy’s own cluster: devnet through its public RPC (or XSOLANA_RPC_URL), mainnet through XSOLANA_RPC_URL.',
    ['xsolana status'],
  ),
  token: {
    group: 'app',
    summary: 'Read a token made elsewhere: its "tokens" entry and what its mint can do',
    usage: ['xsolana token <mint> [options]'],
    words: [1, 'one mint address'],
    tool: ['mint'],
    about:
      'Reads a token’s mint from the chain and prints its ready "tokens" entry, with its name, ticker, decimals, token program and what its mint can still do (mint, freeze, a transfer fee…).',
    args: [
      [
        'mint',
        'the token’s mint address, read on the cluster of the economy in this folder: devnet, unless xsolana.json says "network": "mainnet"',
      ],
    ],
    options: [JSON_OPT, HELP_OPT],
    examples: ['xsolana token <mint address>'],
  },
  client: {
    group: 'app',
    summary: 'Show the program and its calls, for an app that uses a live economy',
    usage: ['xsolana client [options]'],
    words: [0],
    tool: [],
    about:
      'Prints the program’s address and cluster, the npm package and IDL, and the calls a page makes with the player’s own wallet.',
    args: [],
    options: [JSON_OPT, HELP_OPT],
    examples: ['xsolana client'],
  },
  connect: {
    group: 'agent',
    summary: 'Add the xsolana tools and skill to Claude Code and Codex (--local: from a checkout)',
    usage: ['xsolana connect [--agent claude|codex] [--scope user|project] [--local] [--remove] [--dry-run]'],
    words: [0],
    about:
      'Registers the MCP server and the skill through each agent’s own commands. It never edits an agent’s config file.',
    args: [],
    options: [
      ['--agent claude|codex', 'that agent only (default: both)'],
      ['--scope user|project', 'for every project of this user (default), or for this folder only'],
      ['--local', 'run the server from this checkout, not from npm'],
      ['--remove', 'remove the tools and the skill'],
      ['--dry-run', 'print the commands it would run, and run nothing'],
      HELP_OPT,
    ],
    examples: ['xsolana connect', 'xsolana connect --agent codex --dry-run'],
  },
  mcp: {
    group: 'agent',
    summary: 'Serve the tools over MCP (stdio, or HTTP with --http)',
    usage: ['xsolana mcp', 'xsolana mcp --http [--port <n>] [--host <h>]'],
    words: [0],
    about:
      'Over stdio, this is what an agent’s MCP configuration runs. Over HTTP it serves the tools that read no local file, at http://127.0.0.1:8787/mcp by default.',
    args: [],
    options: [
      ['--http', 'serve over HTTP, at /mcp'],
      ['--port <n>', 'with --http: the port (default: 8787)'],
      ['--host <h>', 'with --http: the address to listen on (default: 127.0.0.1)'],
      HELP_OPT,
    ],
    examples: ['xsolana mcp', 'xsolana mcp --http --port 9000'],
  },
  tool: {
    group: 'agent',
    summary: 'Run any MCP tool by name (including xsolana_design and xsolana_save)',
    usage: [
      'xsolana tool --list',
      "xsolana tool <name> ['<json>'] [--args-file <f>] [--json]",
      'xsolana tool <name> --help',
    ],
    words: [2, 'a tool’s name and its arguments as one word of JSON, in quotes (\'{"file":"xsolana.json"}\')'],
    about:
      'Runs one MCP tool by name and prints its answer word for word, as an AI agent gets it. Two tools have no command of their own: xsolana_design (the specs that do what you want, when your goals pull against each other) and xsolana_save (save a spec given whole).',
    args: [
      ['name', 'a tool’s name, as --list prints it; with --help, that tool’s arguments'],
      ["'<json>'", 'its arguments, as one JSON object in quotes (default: {})'],
    ],
    options: [
      ['--list', 'list every tool, with the command that runs it when there is one'],
      ['--args-file <f>', 'read the arguments from a JSON file'],
      JSON_OPT,
      HELP_OPT,
    ],
    examples: ['xsolana tool --list', `xsolana tool xsolana_check '{"file":"xsolana.json"}'`],
  },
  version: {
    group: 'other',
    summary: 'Print this package’s version, the loot program it is built for, and the cluster',
    usage: ['xsolana version'],
    words: [0],
    about: '',
    args: [],
    options: [],
    examples: [],
  },
};

/** The groups of the first help screen, in order. */
const GROUPS = [
  ['spec', 'Design and check a spec'],
  ['live', 'Go live'],
  ['app', 'Build an app on a live economy'],
  ['agent', 'Use with an AI agent'],
  ['other', 'Other'],
];

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

/** Rows of [left, right] as two columns: the right one from column `at`, under the left when it is too long. */
function columns(rows, at = 34, indent = 2) {
  const under = ' '.repeat(at);
  return rows
    .flatMap(([left, right]) => {
      const [first = '', ...rest] = right ? wrapped(right, 118 - at) : [];
      const head = `${' '.repeat(indent)}${left}`;
      return [
        head.length < at - 1 ? `${head.padEnd(at)}${first}`.trimEnd() : `${head}${first ? `\n${under}${first}` : ''}`,
        ...rest.map(l => under + l),
      ];
    })
    .join('\n');
}

const USAGE = [
  'xsolana: check, simulate and price economy specs for loot, a shared Solana program for game and community economies.',
  '',
  'Usage: xsolana <command> [arguments] [options]',
  ...GROUPS.flatMap(([group, title]) => [
    '',
    `${title}:`,
    columns(
      Object.values(COMMANDS)
        .filter(c => c.group === group)
        .map(c => [
          // (its first usage line up to its options: `xsolana check [file]`, `xsolana token <mint>`)
          c.usage[0]
            .split(' ')
            .slice(0, 3)
            .filter(w => !w.startsWith('--') && !w.startsWith('[--') && w !== '[options]')
            .join(' '),
          c.summary,
        ])
        .concat(
          group === 'other'
            ? [['xsolana help [command]', 'Show this help, or one command’s help (also: xsolana <command> --help)']]
            : [],
        ),
    ),
  ]),
  '',
  'Common options:',
  columns([
    [
      '--json',
      'print the whole answer as JSON, as an AI agent gets it (guide, examples, check … status, token, client, tool)',
    ],
    ['--verbose', 'check, simulate, cost, explain, review, examples: also print the details left out by default'],
    ['-h, --help', 'show a command’s help'],
  ]),
  '',
  'Exit codes: 0 success; 1 failure (including check refusing the spec and review finding something high); 2 usage error.',
  'Examples: xsolana examples shop with loot boxes · xsolana check · xsolana help approve',
].join('\n');

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

/** The two ways going live is signed, each with its flags: approve's options, and what it says when given neither. */
const WAYS_TO_SIGN = [
  [
    '--keypair <keyfile>',
    'sign with a key file on this machine (the usual way: no browser, no page). It prints everything it would send, with a code, and sends nothing. Run it again with --yes <code> and it sends exactly that. `xsolana keygen <file>` makes a new project’s key file; a live project is signed only by the key it went live with.',
  ],
  [
    '--mint-key <token>=<keyfile>',
    'with --keypair: make that token’s new mint at the address of a key file you have (an address you chose), not at a new one. Give it once for each such token. The file signs only the transaction that makes the mint. After that it can do nothing more at that address on that cluster; on another cluster it still can, so keep it safe until then.',
  ],
  [
    '--browser',
    'sign in a browser wallet, on a page this command serves on this machine until the economy is live. Use it only when the economy’s owner asks for it; the owner runs it themselves.',
  ],
];
COMMANDS.approve.options = [
  ...WAYS_TO_SIGN,
  ['--yes <code>', 'with --keypair: send what was printed, by the code the printout ended with'],
  ['--port <n>', 'with --browser: the port the page is served on (default: any free port)'],
  ['--no-open', 'with --browser: print the link, and open no browser'],
  HELP_OPT,
];
/** What `xsolana approve` says when it is not told how the setup is signed. */
const HOW_TO_SIGN = `xsolana approve: say how going live is signed.\n\n${columns(WAYS_TO_SIGN, 32)}`;

/** One command's own help: usage, what it does, its arguments and options, and examples. */
function helpFor(command) {
  const c = COMMANDS[command];
  const section = (title, body) => (body ? ['', `${title}:`, body] : []);
  return [
    ...c.usage.map((u, i) => `${i ? '       ' : 'Usage: '}${u}`),
    ...(c.about ? ['', ...wrapped(c.about, 118)] : []),
    ...section('Arguments', c.args.length ? columns(c.args, 32) : ''),
    ...section('Options', c.options.length ? columns(c.options, 32) : ''),
    ...section('Examples', c.examples.map(e => `  ${e}`).join('\n')),
  ].join('\n');
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
      throw new UsageError(
        `There is no command “${helped}”: xsolana help lists them all.${didYouMean(helped, Object.keys(COMMANDS))}`,
      );
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
      `“${command}” takes no ${unknown} flag (${takes.length ? `only ${takes.join(', ')}` : 'it takes none'}).${didYouMean(unknown, takes)}`,
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
    // A named command is read by the developer (`ctx.reader`); `xsolana tool` and --json give the answer an agent
    // gets, word for word.
    const person = !flags.has('--json') && command !== 'tool';
    const ctx = {
      cwd: process.cwd(),
      terminal: TERMINAL,
      ...(person ? { reader: 'person', verbose: flags.has('--verbose') } : {}),
    };
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
          'Whatever is set up with it, it owns, until it hands the project to another key (xsolana handover, signed by both keys): anyone who can read that file controls the project, and every later change is signed by it. Keep the file where it is and never paste it into a chat, a spec, a repository or a page. Back it up yourself (a USB stick, a password manager): if it is lost, nothing can change the project or move what its address holds.',
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
        process.exitCode = USAGE_EXIT;
        break;
      }
      const port = portOf(values.get('--port'));
      const { approve } = await import('../js/approve/server.mjs');
      await approve({ file, port, open: !flags.has('--no-open') });
      break;
    }
    case 'handover': {
      const file = positional[0] ?? 'xsolana.json';
      const { networkOfFile } = await import('../js/mcp/server.mjs');
      await onCluster(await networkOfFile(file), file);
      if (values.get('--keypair') === undefined || values.get('--to') === undefined)
        throw new UsageError(
          'xsolana handover needs both keys: --keypair <the owner’s key file> --to <the new owner’s key file>.',
        );
      const { handover } = await import('../js/approve/handover.mjs');
      const r = await handover({
        file,
        keyFile: values.get('--keypair'),
        toFile: values.get('--to'),
        yes: values.get('--yes') ?? null,
      });
      if (!r.ok) process.exitCode = 1;
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
      console.error(
        `xsolana: there is no command “${command}”.${didYouMean(command, [...Object.keys(COMMANDS), 'help'])}\n\n${USAGE}`,
      );
      process.exitCode = USAGE_EXIT;
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
  process.exitCode = e instanceof UsageError ? USAGE_EXIT : 1;
}
