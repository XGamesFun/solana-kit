// The xsolana tools: what an agent needs to turn a person's idea into an economy on the shared loot program, check it,
// simulate it, price it, explain it, save it and say how it is put live: signed by a key file on the person's own
// machine, once they have read what would be sent and said yes.
// Each tool is { name, description, inputSchema, annotations, handler(input, ctx) → { text, ...data } }; the server
// (server.mjs) and the terminal (`xsolana tool`) run them the same way. No tool signs, holds a key or talks to a wallet.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addressBytes } from '../chain/base58.js';
import { metadataAddress } from '../chain/metadata.js';
import { parseMint, tokenEntry } from '../chain/mint.js';
import { rpcClient } from '../chain/rpc.js';
import { mintState } from '../chain/token2022.js';
import { decodeAny } from '../client/accounts.js';
import { IDL } from '../client/ix.js';
import { checkOnCluster, cluster, CLUSTERS, clusterRpcUrl, lootProgram, pda } from '../client/pda.js';
import { check, describe } from '../economy/check.mjs';
import { legalFlags } from '../economy/legal.mjs';
import { cost, explainCost } from '../economy/cost.mjs';
import { changedParts, renamesNote } from '../economy/live.mjs';
import { example, examples, ideas, search, partsUsed } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
import { describeReview, review } from '../economy/review.mjs';
import { CANNOT, catalog, guideText, PARTS } from '../economy/guide.mjs';
import { model, rent as rentOf } from '../economy/model.mjs';
import { plan } from '../economy/plan.mjs';
import { explain, simulate } from '../economy/simulate.mjs';
import { findSecrets } from '../economy/secrets.mjs';
import { SCHEMA } from '../economy/validate.mjs';

// The options of a call made without any: read-only, and typed so the generated declarations take any option.
const NO_OPTIONS = Object.freeze(/** @type {Record<string, any>} */ ({}));

export const VERSION = IDL.metadata.version;
/** This package's exact version: every command the tools hand a person names it, so npx runs this very release. */
export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
/** A name xsolana_save writes: parts of letters, digits and . _ - (none starting with - ), split by /: a name the approve command can carry as one word. */
const SAVE_NAME = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*\/)*[A-Za-z0-9._][A-Za-z0-9._-]*$/;
/**
 * A file name relative to the project folder as the approve command carries it: its folders split by / on every
 * system (Windows' economy\xsolana.json too), or null when it is not plain by xsolana_save's rule. A name is never quoted
 * (a quoted word is a POSIX shell's rule; PowerShell, cmd.exe and fish read the same quotes another way and would run
 * the code planted in the name), so a plain one is one word, the same in every shell, and never an option.
 */
export function plainName(rel, paths = path) {
  const name = String(rel).split(paths.sep).join('/');
  return SAVE_NAME.test(name) ? name : null;
}
const NOT_PLAIN = rel => `${JSON.stringify(String(rel))} is not a plain file name`;
const RENAME = 'use letters, digits and . _ - (and / for a folder), as in xsolana.json';
/**
 * The command that puts an economy live, pinned to this package's exact version, with the spec's file (relative to the
 * project folder, by `paths`' rules: the system's own unless given) as one plain word. A name that is not plain
 * throws. How it is signed goes after it: `--keypair <key file>` (the usual way), or `--browser` when the person
 * asks for a browser wallet.
 */
export function approveCommand(file = '', paths = path) {
  const name = file ? plainName(file, paths) : '';
  if (name === null) throw new Error(`${NOT_PLAIN(file)}: rename it (${RENAME}).`);
  return `npx -y @xgamesfun/solana@${PACKAGE_VERSION} approve${name ? ` ${name}` : ''}`;
}
/**
 * Where a project's key file is kept unless the person names another place: outside any repository, under the
 * economy's own name (`~` is the home folder, in any shell: the commands read it themselves).
 */
export function keyFileFor(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `~/.config/xsolana/${slug || 'project'}.json`;
}
/** The command that makes a project's key file (it prints the key's address, never the key). */
export const keygenCommand = keyFile => `npx -y @xgamesfun/solana@${PACKAGE_VERSION} keygen ${keyFile}`;
export const DEVNET_RPC = 'https://api.devnet.solana.com';
/** The RPC a tool reads through: the test's own when it gives one, else this process's cluster's (XSOLANA_RPC_URL, or devnet's public RPC). */
const chainOf = ctx =>
  ctx?.rpc ? ctx.rpc(process.env.XSOLANA_RPC_URL || CLUSTERS[cluster()].rpc) : rpcClient(clusterRpcUrl());
/**
 * What every answer carries, so an agent never has to remember the program's address. The program and the cluster are
 * read when asked for: this process's cluster (`client/cluster.js`).
 */
export const PROGRAM_INFO = Object.freeze({
  get program() {
    return lootProgram();
  },
  get cluster() {
    return cluster();
  },
  version: VERSION,
  idl: '@xgamesfun/solana/idl.json',
  package: `@xgamesfun/solana@${PACKAGE_VERSION}`,
});
const footer = () => `\n\nloot ${VERSION} · program ${lootProgram()} · ${cluster()}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nowOf = ctx => ctx?.now ?? Math.floor(Date.now() / 1000);
const cwdOf = ctx => ctx?.cwd ?? process.cwd();
export const DEFAULT_FILE = 'xsolana.json';

/**
 * The tools a hosted server (js/mcp/http.mjs) offers: those that read nothing but their arguments and the chain.
 * xsolana_save and xsolana_publish write and read the person's own files, so they run only on the person's machine.
 */
export const REMOTE_TOOLS = new Set([
  'xsolana_guide',
  'xsolana_examples',
  'xsolana_check',
  'xsolana_simulate',
  'xsolana_cost',
  'xsolana_explain',
  'xsolana_review',
  'xsolana_status',
  'xsolana_token',
  'xsolana_client',
]);

/** The real path of `p`, or of the nearest folder above it that exists, with the rest added back. */
function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    const up = path.dirname(p);
    return up === p ? p : path.join(realPath(up), path.basename(p));
  }
}

/**
 * The spec file `rel` names, inside the project folder: a `.json` file there or in a folder below it. Anything else (an
 * absolute path elsewhere, `..`, a link out of the folder, another kind of file) is refused.
 */
export function projectFile(rel, ctx) {
  const root = realPath(path.resolve(cwdOf(ctx)));
  const file = path.resolve(root, String(rel));
  const inside = p => {
    const r = path.relative(root, p);
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  };
  if (!inside(file) || !inside(realPath(file)))
    throw new Error(`${rel} is outside the project folder (${root}): a spec file must be inside it.`);
  if (path.extname(file).toLowerCase() !== '.json') throw new Error(`${rel} is not a .json file: a spec file is JSON.`);
  return file;
}

/** The spec's own top-level keys (schema.json). */
const SPEC_KEYS = new Set(Object.keys(SCHEMA.properties));
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A file's spec: the JSON as it is, or what it holds under `economy` when that is its only key. */
const specOf = value =>
  plainObject(value) && Object.keys(value).length === 1 && plainObject(value.economy) ? value.economy : value;
/** The spec to read: what a file holds under `economy` (a game file keeps it beside its own keys), else the JSON. */
const economyOf = value => (plainObject(value) && plainObject(value.economy) ? value.economy : value);
/**
 * Whether a file's JSON is an economy spec, so xsolana_save may write over it: version 2 with its tokens (every spec that
 * checks has them), a currency if it names one (a spec of one token checks without: that token is its currency)
 * and nothing but the spec's keys, as it is or as the only key of a file, `economy` (a file with other keys beside it
 * would lose them). Every spec xsolana_save writes passes.
 */
export function isSpec(value) {
  const s = specOf(value);
  return (
    plainObject(s) &&
    s.version === 2 &&
    (s.currency === undefined || typeof s.currency === 'string') &&
    Array.isArray(s.tokens) &&
    Object.keys(s).every(k => SPEC_KEYS.has(k))
  );
}

// ---------------------------------------------------------------- where a spec comes from

const SOURCE = {
  spec: {
    type: 'object',
    description: 'An economy spec (version 2) given inline. Takes precedence over file and example.',
  },
  file: {
    type: 'string',
    description: `A JSON file holding the spec, relative to the project folder (default: ${DEFAULT_FILE} when it exists).`,
  },
  example: {
    type: 'string',
    description: 'A worked example by name, from xsolana_examples (coin-flip-arena, stud-farm, …).',
  },
};

async function load(input, ctx) {
  if (input.spec) return { economy: economyOf(input.spec), from: 'the spec given' };
  if (input.example) return { economy: example(input.example).spec, from: `the example ${input.example}` };
  // A hosted server (js/mcp/http.mjs) reads no file: the machine it runs on is not the person's.
  if (ctx?.remote)
    throw new Error(
      'This hosted server reads no files: pass the whole spec as "spec" (or a worked example by name as "example").',
    );
  const rel = input.file ?? DEFAULT_FILE;
  const file = projectFile(rel, ctx);
  if (!existsSync(file)) {
    if (input.file) throw new Error(`${rel} does not exist.`);
    throw new Error(
      `There is no ${DEFAULT_FILE} in ${cwdOf(ctx)} yet. Write a spec (xsolana_guide, xsolana_examples) and pass it as "spec", or save it with xsolana_save.`,
    );
  }
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    // The parser's message quotes the file: say only where it stopped.
    const at = /position \d+/.exec(e.message)?.[0];
    throw new Error(`${rel} is not valid JSON${at ? ` (at ${at})` : ''}.`, { cause: e });
  }
  return { economy: economyOf(value), from: rel, file };
}

const refused = (verdict, from) => ({
  ok: false,
  from,
  refusals: verdict.refusals,
  warnings: verdict.warnings,
  text: `${describe({ refusals: verdict.refusals, warnings: [] })}\n\n${plural(verdict.refusals.length, 'refusal')} in ${from}: fix ${verdict.refusals.length === 1 ? 'it' : 'them'} (each says how), then run xsolana_check again.`,
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Carries the program numbers of a live spec's parts (by key) into a new version of it, and its `live` section. Only
 * the file on disk can have a `live` section (`xsolana approve` writes it as the setup lands): one the new version brings
 * is dropped when the file had none, and replaced by the file's when it had one.
 */
export function carryIds(previous, next) {
  if (!previous?.live) {
    const { live: _, ...rest } = next;
    return rest;
  }
  const out = { ...next, live: previous.live };
  const carry = (list, fields) => {
    if (!next[list]) return;
    const old = new Map((previous[list] ?? []).map(p => [p.key, p]));
    out[list] = next[list].map(p => {
      const was = old.get(p.key);
      if (!was) return p;
      const ids = Object.fromEntries(
        fields.filter(f => was[f] !== undefined && p[f] === undefined).map(f => [f, was[f]]),
      );
      return { ...p, ...ids };
    });
  };
  carry('items', ['id', 'shopBox']);
  carry('pools', ['index']);
  for (const list of ['stashes', 'boxes', 'recipes', 'schedules', 'lotteries', 'grants']) carry(list, ['id']);
  // A farm that pays nothing keeps the number of the empty pool made for it; an auction keeps the seller its address names.
  carry('farms', ['id']);
  carry('auctions', ['id', 'seller']);
  return out;
}

// ---------------------------------------------------------------- the tools

/** The legal flags to pass on before the person approves, as lines for an answer: [] when there are none. */
function flagsToTell(economy, now) {
  const flags = legalFlags(check(economy, { now }));
  return flags.length
    ? [
        "If you haven't told the person these yet, say each once, in a plain sentence (what `approve` prints before anything is sent shows them too; after that, only when they ask):",
        ...flags.map(f => `- ${f.says}`),
        '',
      ]
    : [];
}

/**
 * A spec that is already live publishes only what changed (as the approve page does): the plan's scope, and in words
 * what can't change or was taken out.
 */
function liveChange(economy) {
  if (!economy.live?.project || !economy.live?.published) return { scope: {}, notes: '', settings: [], changes: 0 };
  const { only, fixed, removed, settings, renames } = changedParts(economy);
  const notes = [
    settings.length ? `\n${settingsNote(settings, economy.live)}` : '',
    renames.length ? `\n${renamesNote(renames)}` : '',
    fixed.length
      ? `\nThese can't change once live, and stay as they were: ${fixed.join(', ')} (a farm, an auction or a pool's token).`
      : '',
    removed.length
      ? `\nTaken out of the spec but still on chain: ${removed.join(', ')}. To stop one, keep it and set "active": false.`
      : '',
  ].join('');
  // (`changes`: whether anything is to be published at all: a part, or a token's name)
  return { scope: { only, live: economy.live, renames }, notes, settings, changes: only.size + renames.length };
}

/** In words: the spec changes the project's own settings, which publishing never writes. */
export const settingsNote = (settings, live) =>
  `The spec changes the project’s ${settings.join(', ')}, and publishing never changes those: on chain the authority stays ${live.authority ?? 'as it was'} and the treasury ${live.treasury ?? 'as it was'}. Changing them takes the owner’s update_project, which loot does not send yet; until then, put them back as they were in the spec.`;

export const tools = [
  {
    name: 'xsolana_guide',
    annotations: READ,
    description:
      'Read this first whenever someone wants a web3 economy, game economy, token economy, NFT mechanic or onchain reward system: a shop, loot boxes or packs, gacha, a lottery or raffle, an auction (highest bid wins, the outbid refunded at once), staking or a farm, crafting or merging, seasons and emissions, a prediction pool or contest, quests and airdrops, holder-gated drops, using NFTs of any other collection in a game. loot is ONE shared Solana program (devnet until it is audited): the economy is a JSON spec, not a new smart contract, so never write Anchor/Rust for what it covers. Returns every part an economy can have (fields from the schema, who acts at play time, fees), how to write a spec, and what loot cannot do (with the nearest alternative). Pass `part` for one part with its nested shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'string', enum: Object.keys(PARTS), description: 'One part, with its nested shapes.' },
      },
      additionalProperties: false,
    },
    async handler({ part } = NO_OPTIONS) {
      return {
        text: guideText(part) + footer(),
        parts: catalog(part),
        ...(part ? {} : { cannot: CANNOT }),
        ...PROGRAM_INFO,
      };
    },
  },
  {
    name: 'xsolana_examples',
    annotations: READ,
    description: `Find an economy to start from. With \`query\` (the person’s own words, as they said them), returns the closest worked examples (whole specs that check and go live in the tests), the closest of ${ideas().length} real or trending economies rated against loot (great / some / a-lot / cannot, with what carries it or what is missing), and what loot can’t do exactly in the ask, each with the nearest versions it can. Call it again with the words of any part that looks impossible: the answer is a nearest version to offer, not a dead end. With \`name\`, returns that example’s whole spec to copy and change. With neither, lists every example.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the person wants, in a few words.' },
        name: { type: 'string', description: 'An example’s name, to get its whole spec.' },
        fit: { type: 'string', enum: ['great', 'some', 'a-lot', 'cannot'], description: 'Only ideas with this fit.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many of each kind (default 6).' },
      },
      additionalProperties: false,
    },
    async handler({ query, name, fit, limit = 6 } = NO_OPTIONS, ctx) {
      if (name) {
        const ex = example(name);
        const verdict = check(ex.spec, { now: nowOf(ctx) });
        return {
          name: ex.name,
          spec: ex.spec,
          checks: verdict.ok ? 'clean' : verdict.refusals.map(r => r.code),
          text: `${ex.spec.name}: ${ex.spec.prompt ?? ''}\nCopy the spec, change it to what the person asked, then run xsolana_check on it. Existing mints in examples are devnet stand-ins: use the person’s own.${footer()}`,
        };
      }
      if (!query) {
        const all = examples().map(({ name: n, spec }) => ({
          name: n,
          title: spec.name,
          prompt: spec.prompt,
          parts: partsUsed(spec),
        }));
        return {
          examples: all,
          ideas: { count: ideas().length },
          text:
            [
              `${all.length} worked examples (xsolana_examples {"name": "<name>"} gives the whole spec):`,
              ...all.map(e => `- ${e.name}: ${e.title}. ${e.prompt ?? ''} [${e.parts.join(', ')}]`),
              `\nAnd ${ideas().length} rated economies: pass a query to search them.`,
            ].join('\n') + footer(),
        };
      }
      const r = search(query, { limit, fit });
      const text = [
        r.examples.length
          ? `Examples closest to “${query}” (xsolana_examples {"name": …} gives the whole spec):`
          : `No worked example matches “${query}”. Start from the nearest idea below, or from xsolana_guide.`,
        ...r.examples.map(e => `- ${e.name}: ${e.title}. ${e.prompt ?? ''} [${e.parts.join(', ')}]`),
        r.hows.length ? '\nThese look impossible but are one field or a short combination (build them):' : '',
        ...r.hows.map(h => `- ${h.what}: ${h.how}.`),
        r.ideas.length
          ? '\nRated economies (rated against this version of loot: a rating is a hint, the parts in xsolana_guide decide):'
          : '',
        ...r.ideas.map(i => `- #${i.n} ${i.name} (${i.fit}): ${i.how}`),
        r.limits.length
          ? '\nWhat no part of loot does here, and the nearest versions (first check that no combination of parts does it; then offer these, best first, with their numbers from xsolana_cost; never end on “it can’t”):'
          : '',
        ...r.limits.flatMap(l => [`- ${l.what}: ${l.why}.`, ...l.nearest.map((n, i) => `  ${i + 1}. ${n}`)]),
        r.ideas.some(i => i.fit === 'cannot')
          ? '\nA "cannot" means a defining piece was missing when it was rated: check that piece against xsolana_guide’s parts and their combinations before telling the person, then offer the nearest version.'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      return { examples: r.examples, ideas: r.ideas, hows: r.hows, limits: r.limits, text: text + footer() };
    },
  },
  {
    name: 'xsolana_check',
    annotations: READ,
    description:
      'Check an economy spec: refusals (each with a code, what it means and its fix) stop it from going live; warnings are what the person must hear (chance that pays money, revenue paid to stakers, an unfunded prize, a grant without limits, a mint’s powers, a time far off with its date in words, a token a player can hold a payment up in, a box longer than one answer of the oracle’s holds). The program refuses only what it must: much of what a project sets up is taken and warned of, never refused, so tell the person each warning in plain words. Run it after every change. Give the spec inline (`spec`), a file, or an example.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const verdict = check(economy, { now: nowOf(ctx) });
      const head = verdict.refusals.length || verdict.warnings.length ? describe(verdict) : 'No problems found.';
      const tail = verdict.ok
        ? `\nReady (${plural(verdict.warnings.length, 'warning')}). Next: xsolana_simulate and xsolana_explain, and tell the person what it means in plain words; before going live, xsolana_review.`
        : `\n${plural(verdict.refusals.length, 'refusal')}: fix each as its fix says, then check again.`;
      return {
        ok: verdict.ok,
        from,
        refusals: verdict.refusals,
        warnings: verdict.warnings,
        text: `${head}${tail}${footer()}`,
      };
    },
  },
  {
    name: 'xsolana_simulate',
    annotations: READ,
    description:
      'The quick simulation (expected values from the spec, instant): what each box, ticket and craft gives back against its price, the house edge, each pool’s money in and out per day and whether it runs dry, settles or grows, farm rewards per unit staked, what players, the treasury and the platform get each day; a box’s chances with its odds rules at their most, what a box that gives nothing for a miss misses as its outcomes run out, what a ticket weighs in a lottery weighed by time, and what places get from a pool that starts short. `scenario` overrides the spec’s own ({"perDay": {"box:flip": 1000}, "days": 30, "staked": {"<farm>": 1000}}). Quote its numbers; never your own arithmetic.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SOURCE,
        scenario: { type: 'object', description: 'What to assume instead of the spec’s scenario.' },
        json: { type: 'boolean', description: 'Also return every row.' },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const { economy: e, from } = await load(input, ctx);
      const economy = input.scenario ? { ...e, scenario: { ...e.scenario, ...input.scenario } } : e;
      const verdict = check(economy, { now: nowOf(ctx) });
      if (!verdict.ok) return refused(verdict, from);
      const sim = simulate(economy, { now: nowOf(ctx) });
      const summary = {
        boxes: sim.boxes.map(b => ({
          key: b.key,
          returnPercent: b.returnPercent,
          houseEdgePercent: b.houseEdgePercent,
        })),
        pools: sim.pools.map(p => ({ key: p.key, lasts: p.lasts, lastsDays: p.lastsDays, settlesAt: p.settlesAt })),
        farms: sim.farms.map(f => ({ key: f.key, rewardsPerDay: f.rewardsPerDay, yearlyPercent: f.yearlyPercent })),
        platformSolPerDay: sim.perDay.platform.totalSol,
      };
      return {
        ok: true,
        from,
        summary,
        ...(input.json ? { simulation: sim } : {}),
        text: explain(sim, economy) + footer(),
      };
    },
  },
  {
    name: 'xsolana_cost',
    annotations: READ,
    description:
      'What going live costs (each account’s rent, the program’s fees, network fees, the seeds, the transactions it takes) and what each action costs whoever signs it while it runs.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const change = liveChange(economy);
      const c = cost(economy, { now: nowOf(ctx), ...change.scope });
      if (!c.ok) return refused(c, from);
      const head = change.scope.live
        ? change.changes
          ? `This economy is live: this prices only the change (${[...change.scope.only, ...change.scope.renames.map(key => `the name of ${key}`)].join(', ')}).\n`
          : 'This economy is live and nothing has changed since it went live: publishing costs nothing.\n'
        : '';
      // (a name's price is a transaction's, if it is sent at all: only approving reads the token's record)
      const names = change.scope.renames?.length ? `\n${renamesNote(change.scope.renames)}` : '';
      return {
        ok: true,
        from,
        setup: c.setup,
        actions: c.actions,
        fees: c.fees,
        text: head + explainCost(c) + names + footer(),
      };
    },
  },
  {
    name: 'xsolana_explain',
    annotations: READ,
    description:
      'The economy in plain words for the person: what players do and what it costs and is worth, how the pools fill and drain, what runs by itself, what the authority must sign, what going live costs, and what is flagged for the law. Tell them the essentials in a few lines, from this text.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const r = explainEconomy(economy, { now: nowOf(ctx) });
      return { ...r, from, text: r.text + footer() };
    },
  },
  {
    name: 'xsolana_review',
    annotations: READ,
    description:
      'Review an economy the way a cheater reads it, before it goes live (not a validity check: xsolana_check is that). For every route that pays or gives value it says who can trigger it, what the program enforces, what it trusts off the chain, and the most one cheater gets; then findings with stable ids and a severity; then the trade-off to show the person: for each grant paid on vouchers, whether its server decides, replays or only bounds the result (its "trust"), what a cheater gets at that level, and what the next level costs to build. Fix every high finding, declare "trust" honestly on every voucher grant, and tell the person in plain words which level each signed route uses and what a cheater gets, so they choose the trade-off. Give the spec inline (`spec`), a file, or an example. Answers { ok (false when a finding is high, or the spec does not check: then `refusals`), routes: [{ kind ("grant", "farm", "item", "box", "payment", "recipe", "lottery", "contest", "auction", "schedule", "hold", "decision"), key, name, trigger, enforced: [words], trusts: [words], trust ("decides" | "replays" | "bounds" | null), ceiling (words), feeds: ["farm:<key>", …: what its prize is staked in, crafted into or buys] }], findings: [{ id (R-…), severity ("high" | "medium" | "low" | "info"), route ("grant:<key>", "farm:<key>", … or "economy"), message, fix }], tradeoffs (markdown) }.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const r = review(economy, { now: nowOf(ctx) });
      if (r.refusals) return refused({ refusals: r.refusals, warnings: [] }, from);
      const highs = r.findings.filter(f => f.severity === 'high').length;
      const tail = highs
        ? `\n${plural(highs, 'high finding')}: fix ${highs === 1 ? 'it' : 'them'} (or have the person accept ${highs === 1 ? 'it' : 'them'} in plain words) before going live, then review again.`
        : '\nNo high finding. Tell the person, in plain words, which level each signed route uses and what a cheater gets (the trade-offs above).';
      return {
        ok: r.ok,
        from,
        routes: r.routes,
        findings: r.findings,
        tradeoffs: r.tradeoffs,
        text: `${describeReview(r, economy.name)}${tail}${footer()}`,
      };
    },
  },
  {
    name: 'xsolana_save',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: `Save a spec into the project (default ${DEFAULT_FILE}), only if it checks. A file that is already live keeps its program numbers and its live section. Never put a key in it: the checker refuses one.`,
    inputSchema: {
      type: 'object',
      properties: { spec: SOURCE.spec, file: SOURCE.file },
      required: ['spec'],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const rel = input.file ?? DEFAULT_FILE;
      let file;
      try {
        file = projectFile(rel, ctx);
      } catch (e) {
        return { ok: false, isError: true, text: `Not saved: ${e.message}` };
      }
      // a name the approve command can carry as it is: letters, digits and . _ - in each part, parts split by /
      if (plainName(rel) === null)
        return {
          ok: false,
          isError: true,
          text: `Not saved: ${NOT_PLAIN(rel)}. Use letters, digits and . _ - (and / for a folder), as in ${DEFAULT_FILE}.`,
        };
      if (findSecrets(input.spec).length)
        return {
          ok: false,
          isError: true,
          text: 'Not saved: the spec holds what looks like a private key or a seed phrase. Remove it (and treat that wallet as exposed).',
        };
      let previous = null;
      if (existsSync(file)) {
        try {
          previous = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          previous = null;
        }
        // Only a spec is ever overwritten: never another JSON file that happens to be there (a package.json has a
        // `version` too). A spec is version 2 with only the spec's own keys, as it is or under `economy`.
        if (!isSpec(previous))
          return {
            ok: false,
            isError: true,
            text: `Not saved: ${rel} is there already and is not an economy spec. Pick another file name.`,
          };
      }
      // (a spec wrapped under `economy`, given or already in the file, is read the same way xsolana_check reads it)
      const given = economyOf(input.spec);
      const spec = carryIds(previous && economyOf(previous), given);
      const dropped =
        given.live && !previous?.live
          ? ' The live section given was not kept: only `xsolana approve` writes one, as what it sends lands.'
          : '';
      const verdict = check(spec, { now: nowOf(ctx) });
      if (!verdict.ok)
        return {
          ...refused(verdict, 'the spec given'),
          isError: true,
          text: `Not saved.\n${refused(verdict, 'the spec given').text}`,
        };
      // A folder that isn't there yet is made, inside the project folder (projectFile checked the whole path).
      try {
        await mkdir(path.dirname(file), { recursive: true });
      } catch (e) {
        return {
          ok: false,
          isError: true,
          text: `Not saved: the folder for ${rel} can’t be made (${e.code ?? 'error'}).`,
        };
      }
      await writeFile(file, `${JSON.stringify(spec, null, 2)}\n`);
      return {
        ok: true,
        file: rel,
        warnings: verdict.warnings,
        text: `Saved ${rel} (${plural(verdict.warnings.length, 'warning')}).${dropped}${spec.live ? ' It is live: xsolana_publish publishes only what changed.' : ' Next: xsolana_publish when the person says to put it live.'}${footer()}`,
      };
    },
  },
  {
    name: 'xsolana_publish',
    annotations: { ...READ, readOnlyHint: true },
    description: `When the person says to put it live: returns what going live does (every step, in order, and its cost) and the commands that do it (each starts npx -y @xgamesfun/solana@${PACKAGE_VERSION} for this exact version: give them as they are). Going live is signed by a key file on the person’s own machine: \`keygen\` makes one for the project (it prints the address, never the key), and \`approve … --keypair <file>\` prints everything that would be sent and sends nothing until it is run again with the code it printed, which you do only after the person has read that printout and said yes. A live economy is changed only by the key that owns it: never make a new key for one. Never ask for, read or print a key, and open no signing page: the browser-wallet page (\`approve … --browser\`) is for a person who asks for one, or whose browser wallet owns the project, and they run it themselves.`,
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from, file } = await load(input, ctx);
      const change = liveChange(economy);
      if (change.scope.live && !change.changes && change.settings.length)
        return {
          ok: false,
          transactions: 0,
          approvals: 0,
          steps: [],
          text: `${from} is live, and its parts are as they are on chain. ${settingsNote(change.settings, economy.live)}${footer()}`,
        };
      if (change.scope.live && !change.changes)
        return {
          ok: true,
          transactions: 0,
          approvals: 0,
          steps: [],
          text: `${from} is live, and nothing in it has changed since it went live: there is nothing to publish.${change.notes}${footer()}`,
        };
      const p = plan(economy, { now: nowOf(ctx), ...change.scope });
      if (!p.ok) return refused(p, from);
      const c = cost(economy, { now: nowOf(ctx), ...change.scope });
      // A token's new name is listed as the file has it: whether it is sent is the chain's to say, as approving reads it.
      const steps = p.transactions.flatMap(t =>
        t.steps.map(s =>
          s.id.startsWith('name:')
            ? `${s.says} (sent only if the token has a name record its owner can still change, read when approving)`
            : s.says,
        ),
      );
      const renaming = Boolean(change.scope.renames?.length);
      // the file as the approve command names it, relative to the project folder (projectFile's), and plain (plainName)
      const target = file ? path.relative(realPath(path.resolve(cwdOf(ctx))), file) || DEFAULT_FILE : DEFAULT_FILE;
      if (plainName(target) === null)
        return {
          ok: false,
          transactions: 0,
          approvals: 0,
          steps: [],
          text: `Not published: ${NOT_PLAIN(target)}, and the approve command carries the file's name as it is. Ask the person to rename it (${RENAME}), then run xsolana_publish again with the new name.${footer()}`,
        };
      const live = Boolean(change.scope.live);
      const keyFile = keyFileFor(economy.name);
      // (a live project is signed only by the key that owns it: no command here makes another)
      const keygen = live ? null : keygenCommand(keyFile);
      const browserCommand = `${approveCommand(target)} --browser`;
      const command = `${approveCommand(target)} --keypair ${keyFile}`;
      const text = [
        ...flagsToTell(economy, nowOf(ctx)),
        `${change.scope.live ? 'Publishing this change to the live economy' : 'Going live'}: ${renaming ? 'at most ' : ''}${plural(p.transactions.length, 'transaction')}, about ${c.setup.totalSol} SOL on devnet:`,
        ...steps.map((s, i) => `${i + 1}. ${s}`),
        '',
        `${live ? 'To publish it' : 'To put it live'}, in a terminal in the project folder (you run these; nothing opens, and nothing is sent before the person’s yes):`,
        ...(live
          ? [
              `1. Only the key that owns the project can change it: the key file it went live with (${keyFile} if it was made there; give the file’s own path if it is elsewhere). If there is no such file, a browser wallet owns it: use the --browser command below. Never make a new key for a live project (a new key can change nothing), and never remove the file’s live section because a key was refused. If you can’t tell, ask the person how it went live. The owner’s address needs about ${c.setup.totalSol} SOL of devnet SOL.`,
            ]
          : [
              `1. A key file for this project, unless it has one: ${keygen}`,
              '   It prints the key’s address, never the key. The key file is the project’s owner: whoever can read it controls the project, and which key goes live is for good (every later change is signed by it; these tools can’t hand a project to another owner). It stays where it is: never in a chat, a spec, a repository or a page, and you never open, read or print it. Tell the person to back the file up themselves: if it is lost, nothing can change the economy or move what its address holds.',
              `   Everything the setup takes from the owner must be at that address first: the devnet SOL (about ${c.setup.totalSol} SOL here; https://faucet.solana.com gives some), any seed in a coin that already exists, and every NFT a stash, a raffle or an auction names (a collection they already have needs that address as its update authority). If they would rather not move those, offer the browser wallet.`,
              '   The steps above call the owner’s address “your wallet”: with a key file, that is the key’s address. Unless the spec names a treasury, what sales leave lands there, and it signs what only the authority signs. If the economy takes money in, ask for the public address of a wallet the person holds and set "treasury": "wallet:<address>" first: it can’t be changed through the spec once live.',
            ]),
        `2. ${command}`,
        '   It prints every step with what it pays and trusts, the warnings, the notice (the program is not independently audited and comes as is, with no warranty; they use it at their own risk, and making sure the economy is legal where it is offered is up to them: DISCLAIMER.md in the package) and a code. It sends nothing.',
        '3. Show the person that printout and ask. When they say yes, run the same command with --yes <code>: the code stands for exactly what was printed, and anything else is refused. What lands is written back into the file. If it stops part way, run it again without --yes: it prints what is left and a new code. Go on with that code; if it shows a step or a warning they have not seen, ask again.',
        `${live ? 'For a project a browser wallet owns' : 'Only if the person asks to sign in a browser wallet instead'}: give them this to run in their own terminal: ${browserCommand} (it serves a page on their own computer where they connect a wallet set to devnet and approve, ${plural(p.approvals, 'approval')}, and keeps running until the page says it is live). Don’t run or open it otherwise.${live ? ' A project a key file owns can’t be signed in a browser wallet.' : ''}`,
        ...(file ? [] : [`(Save it first with xsolana_save: \`approve\` reads ${DEFAULT_FILE}.)`]),
        ...(change.notes ? [change.notes.trim()] : []),
      ].join('\n');
      return {
        ok: true,
        command,
        ...(keygen ? { keygen } : {}),
        keyFile,
        browserCommand,
        transactions: p.transactions.length,
        approvals: p.approvals,
        setupSol: c.setup.totalSol,
        steps,
        text: text + footer(),
      };
    },
  },
  {
    name: 'xsolana_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'A live economy as it is on chain: the project, every pool’s balance, every record the spec names (found or missing). Reads devnet (or XSOLANA_RPC_URL).',
    inputSchema: { type: 'object', properties: { spec: SOURCE.spec, file: SOURCE.file }, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      if (!economy.live?.project)
        return {
          ok: false,
          text: `${from} is not live yet (no "live" section). xsolana_publish says how to put it live.${footer()}`,
        };
      const m = model(economy);
      // This process's cluster only: a URL that names another is refused, and so is a chain whose first block is another's.
      const rpc = chainOf(ctx);
      if (!ctx?.rpc) await checkOnCluster(rpc);
      const project = economy.live.project;
      const wanted = [
        ['project', project],
        ...m.pools.map(p => [`pool:${p.key}`, pda.pool(project, p.index)]),
        ...m.allBoxes.map(b => [b.shopOf ? `item:${b.shopOf} (shop)` : `box:${b.key}`, pda.box(project, b.id)]),
        ...m.items.map(it => [`item:${it.key}`, pda.item(project, it.id)]),
        ...m.farms.map(f => [`farm:${f.key}`, pda.farm(project, f.id)]),
        ...m.lotteries.map(l => [`lottery:${l.key}`, pda.lottery(project, l.id)]),
        ...m.lotteries
          .filter(l => Number.isInteger(l.pot))
          .map(l => [`lottery:${l.key} (pot ${l.pot})`, pda.lotteryPot(pda.lottery(project, l.id), l.pot)]),
        ...m.schedules.map(s => [`schedule:${s.key}`, pda.schedule(project, s.id)]),
        ...m.recipes.map(r => [`recipe:${r.key}`, pda.recipe(project, r.id)]),
        ...m.grants.map(g => [`grant:${g.key}`, pda.grant(project, g.id)]),
        ...m.stashes.map(s => [`stash:${s.key}`, pda.stash(project, s.id)]),
        ...(economy.auctions ?? [])
          .filter(a => a.seller)
          .map(a => [`auction:${a.key}`, pda.auction(project, a.seller, a.id)]),
      ];
      const accounts = await rpc.accounts(wanted.map(([, a]) => a));
      const rows = wanted.map(([part, address], i) => {
        const a = accounts[i];
        if (!a) return { part, address, found: false };
        // A grant's funds are the SOL it holds beyond its rent: what is left to pay its claims' fees and rent.
        if (part.startsWith('grant:'))
          return {
            part,
            address,
            found: true,
            kind: 'Grant',
            sol: Number(BigInt(a.lamports ?? 0) - rentOf(a.data?.length ?? 0)) / 1e9,
          };
        const tokenAmount =
          a.data?.length >= 72 && (part.startsWith('pool:') || part.includes(' (pot '))
            ? Number(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true))
            : undefined;
        const decoded = a.owner === lootProgram() ? decodeAny(a.data) : null;
        // A stash: how many NFTs it still holds to give away.
        const nfts = decoded?.kind === 'Stash' ? decoded.value.nfts.length : undefined;
        return {
          part,
          address,
          found: true,
          ...(tokenAmount !== undefined ? { amount: tokenAmount } : {}),
          ...(nfts !== undefined ? { nfts } : {}),
          ...(decoded ? { kind: decoded.kind } : {}),
        };
      });
      const missing = rows.filter(r => !r.found);
      const text = [
        `${economy.name ?? 'The economy'} on ${cluster()}: project ${project}.`,
        ...rows.map(
          r =>
            `- ${r.part}: ${r.found ? `found${r.amount !== undefined ? `, holds ${r.amount} base units` : ''}${r.nfts !== undefined ? `, holds ${r.nfts} NFT${r.nfts === 1 ? '' : 's'} to give away` : ''}${r.sol !== undefined ? `, holds ${r.sol} SOL for claims` : ''}` : 'missing'} (${r.address})`,
        ),
        missing.length
          ? `\n${plural(missing.length, 'part')} not on chain: publish again (xsolana_publish) to add them.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      return { ok: true, rows, text: text + footer() };
    },
  },
  {
    name: 'xsolana_token',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'A token made elsewhere, as the chain has it, for an economy that uses it: give its mint’s address and get its ready `tokens` entry (`source: "existing"`) with its name, ticker, decimals and token program, and `powers` filled in: what the mint’s own keys can do (mint more, freeze, a transfer fee, a transfer hook, a permanent delegate, a pause…), in words too. Use it instead of asking the person to look the mint up. Reads devnet (or XSOLANA_RPC_URL): the mint and its name record only, never the link the record names.',
    inputSchema: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'The token’s mint address.' },
        key: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{0,31}$',
          description: 'What the spec will call it (default: its ticker, in the letters a key takes).',
        },
        project: {
          type: 'string',
          description:
            'The loot project’s address, when the token is one the project is to mint on a mint of its own: its mint authority then reads as the project’s, or as not handed over yet.',
        },
      },
      required: ['mint'],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const mint = String(input.mint ?? '').trim();
      try {
        addressBytes(mint);
      } catch {
        return {
          ok: false,
          text: `${JSON.stringify(mint)} is not a Solana address. Give the token’s mint address.${footer()}`,
        };
      }
      // This process's cluster only: a URL that names another is refused, and so is a chain whose first block is another's.
      const rpc = chainOf(ctx);
      if (!ctx?.rpc) await checkOnCluster(rpc);
      let project = null;
      if (input.project !== undefined) {
        project = String(input.project).trim();
        try {
          addressBytes(project);
        } catch {
          return {
            ok: false,
            text: `${JSON.stringify(project)} is not a Solana address. Give the project’s address, or leave it out.${footer()}`,
          };
        }
      }
      const [account, record] = await rpc.accounts([mint, metadataAddress(mint)]);
      // A transfer fee changes on an epoch: with the chain's current one, a fee since lowered reads as it is now.
      const epoch =
        account && typeof rpc.call === 'function'
          ? await rpc.call('getEpochInfo').then(
              e => Number(e.epoch),
              () => null,
            )
          : null;
      const token = tokenEntry(mint, account, record?.data ?? null, {
        ...(input.key ? { key: input.key } : {}),
        project,
        epoch,
      });
      if (!token)
        return {
          ok: false,
          text: `${
            account
              ? `${mint} is not a token mint on ${cluster()} (a token account or a wallet is not the mint: an explorer’s token page names it)`
              : cluster() === 'devnet'
                ? `There is nothing at ${mint} on devnet. A coin launched on mainnet is not on devnet, where loot runs for now`
                : `There is nothing at ${mint} on ${cluster()}. A coin made on devnet is not on ${cluster()}`
          }.${footer()}`,
        };
      if (token.source === 'sol')
        return {
          ok: true,
          token,
          text: `${mint} is wrapped SOL: in a spec that is SOL itself.\n\nIn the spec’s "tokens":\n${JSON.stringify(token)}${footer()}`,
        };
      const read = parseMint(mint, account.owner, account.data, record?.data ?? null);
      const supply = Number(BigInt(read.supply)) / 10 ** read.decimals;
      const p = token.powers;
      const state = mintState(account);
      // The name and ticker are the token's own writing, anyone's to set: given as the entry has them (one line, cut
      // to a spec's lengths), in quotes, as labels and never as words of this tool.
      const called =
        token.symbol || token.name
          ? `calls itself ${[token.name && `“${token.name}”`, token.symbol && `ticker “${token.symbol}”`].filter(Boolean).join(', ')} (its own record’s words: a label anyone can write, not a fact)`
          : 'has no name record, so wallets show it as an unknown token';
      // What each power lets whoever holds it do, in the checker's words (check.mjs W-MINT-POWERS).
      const can = [
        p.mintAuthority === 'someone else' && `mint more of it whenever they want (${read.mintAuthority} can)`,
        p.mintAuthority === 'project' && null,
        p.freeze && 'freeze any account holding it, an economy’s pools and vaults included',
        p.permanentDelegate && 'move or burn it out of any account',
        p.transferHook && 'run a program of their own on every transfer, which can refuse one',
        p.transferFeePercent > 0 && `keep ${p.transferFeePercent}% of every transfer`,
        p.feeChangeable && 'raise its transfer fee, up to all of a transfer',
        p.closeAuthority && 'close the mint and make it again with other powers',
        p.pausable && 'pause every transfer of it',
        p.defaultFrozen && 'have every new account of it start frozen',
        !p.defaultFrozen && p.defaultState && p.freeze && 'switch every new account of it to start frozen',
      ].filter(Boolean);
      const also = [
        p.nonTransferable && 'It cannot be transferred at all: nothing can be paid, staked or given as a prize in it.',
        p.confidentialTransfers &&
          'Its holders can turn plain transfers into their account away (confidential transfers).',
        state.paused && 'It is paused now: nothing of it moves until its issuer ends the pause.',
        state.scaled &&
          `Wallets show its amounts multiplied by a rate its mint carries${state.scaler ? ', which its issuer can change' : ''}: an economy counts the amounts under it, so a price in a spec is not the number a wallet shows.`,
        p.mintAuthority === 'project' &&
          'Its mint authority is the project given: the project mints it, as its rules say.',
        project &&
          p.mintAuthority === 'someone else' &&
          `Its mint authority is not the project given (${project}): until it is handed over, nothing the economy mints in it lands.`,
      ].filter(Boolean);
      const text = [
        `The token at ${mint} on ${cluster()}: ${read.program === 'token-2022' ? 'a Token-2022' : 'a classic SPL'} token, ${plural(read.decimals, 'decimal')}, ${supply.toLocaleString('en-US')} in existence${p.mintAuthority === 'none' ? ', and nobody can mint more' : ''}. It ${called}.`,
        can.length
          ? `Whoever controls its mint can:\n${can.map(c => `- ${c}`).join('\n')}\nAn economy in it is only as safe as the token: say so where players pay, stake or are paid.`
          : `Its mint has no key that can freeze it, take it, charge on it or stop a transfer${p.mintAuthority === 'project' ? ' (the project mints it)' : ''}.`,
        ...also,
        `In the spec’s "tokens" (xsolana_check then says what each power means for the economy’s parts):\n${JSON.stringify(token, null, 2)}`,
      ].join('\n\n');
      return {
        ok: true,
        token,
        mint: {
          address: mint,
          program: read.program,
          decimals: read.decimals,
          supply: read.supply,
          name: token.name ?? null,
          symbol: token.symbol ?? null,
          mintAuthority: read.mintAuthority,
          freezeAuthority: read.freezeAuthority,
        },
        text: text + footer(),
      };
    },
  },
  {
    name: 'xsolana_client',
    annotations: READ,
    description:
      'How an app (a game, a site, a bot) uses a live economy: the program’s address and cluster, the npm package and IDL, and the calls a page makes with the player’s own wallet (open a box, buy, stake, craft, enter, claim). Use this instead of writing chain code from memory.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const text = [
        `loot ${VERSION} on ${cluster()}: program ${lootProgram()}. Never write another address from memory: take it from this package.`,
        'Package: npm install @xgamesfun/solana (plain ES modules, no Solana SDK needed; works in the browser).',
        '  What only the project’s owner or authority signs (a contest’s result, a payout, a schedule’s run) is not a page’s: a script on the owner’s machine signs it with the project’s key file, `readKeyFile(file)` from "@xgamesfun/solana/keyfile" (an address and a way to sign, never the key; it is also a `wallet` for solanaApp). The skill’s references/after-launch.md has the script.',
        '  import { solanaApp, walletStandardSigner } from "@xgamesfun/solana/play";',
        '  const app = solanaApp({ spec /* the live xsolana.json */, rpcUrl, wallet: walletStandardSigner(wallet, account) });',
        '  app.shop(), app.buy(key, { listing }), app.boxes(), app.openBox(key, { listing }), app.pay(key) (or app.pay(key, { chosenRecipient })),',
        '  `chosenRecipient` (buy, openBox, pay): the wallet (or collectible) the player names for a "chosen" share of the split (a referrer from the link)',
        '  app.lotteries(), app.buyTickets(key, n, { listing }) (or { maxPrice }: a ticket’s most, in base units),',
        '  app.stake(key, amount), app.harvest(key), app.staked(key) (each seat and what it is owed now), app.recipes(), app.craft(key, assets, 1, { listing }), app.claimGrant(key),',
        '  solanaApp({ ..., sponsor: httpSponsor({ url, address }) })   the project pays players’ fees (never the price) from a key on its own server: @xgamesfun/solana/sponsor sponsorSigner + sponsorHandler there',
        '  app.collectibles(), app.balances()   what a player does. `listing`: the entry shop(), boxes(), lotteries() or recipes() showed the',
        '  player; its price (or version) is the most they pay: one that moved since is refused, never paid unseen',
        '  a prize (a grant, a lottery place, a contest win, a mission, a recipe) is given in the instruction that wins it,',
        '  its accounts from loot.prizeMetas({ project, collection, prize, winner, poolMints, items, nft }) (a roll: its box and',
        '  its order; ask for it in the same transaction, loot.askRollIx, which fails the whole transaction, SoldOut, when the box',
        '  has nothing in stock (only the order’s player asks then, a slot later, and that ends the roll with nothing); a write naming a',
        '  box to roll passes loot.boxesAccounts after it, and the box is written first); app.claims() finds',
        '  what a player is owed. A roll (a prize of a roll, an auction lot, a box) is an order: app.claim / app.collect, or',
        '  loot.askRollIx({ payer, orderAddress, order, box }) then loot.settleIx(...) hands over what it rolled (a stash NFT too)',
        '  loot.stashIx({ signer, project, id, asset, out })           the owner or authority puts an NFT in a stash, or takes one out',
        '  app.listForSale(asset, { price }), app.listForRent(asset, { price, lasts, maxPeriods }), app.listing(asset), app.listings(),',
        '  app.buyListing(asset, { listing }), app.rentListing(asset, { periods, listing }) (`listing`: what listing() or listings()',
        '  showed the player), app.unlist(asset), app.rentedTo(asset) (one account read)   listings, sale and rent',
        '  app.closeGone(asset)   anyone closes the holds and the listing of an NFT the project no longer holds (its collection took it back or burned it), and takes its row off each of the project’s stashes: nothing is sent or paid; claims() lists such a hold or loan flagged `gone`, and a lottery’s part, a contest’s claim or an auction whose NFT is gone (its claim finishes without it); listing() flags such a listing',
        '  app.raffle(id, nft, { price, drawsAt, minSold }), app.unraffle(id, nft)   a raffle from the lottery’s own stash',
        '  app.compound(key), app.runSchedule(key)   compound, send a schedule that is due (a run missed is missed: only a sealed fixed amount pays every run due)',
        '  app.farmWalk(key), app.walkFarm(key)   a farm idle past many end times: how many it must walk, and walking them in parts (anyone, free; moves ask for the compute to walk a few themselves)',
        '  app.claims() also lists a lottery’s parts to pull (a refund, a place, a raffle’s NFT), vested runs, a rental over',
        'Lower level, for what the player module does not cover:',
        '  import * as loot from "@xgamesfun/solana/client";',
        '  loot.pda.project(owner, number), loot.pda.box(project, id), …   every address the program derives',
        '  loot.openBoxIx({ player, project, box, nonce }), loot.buyIx({ player, project, box, items }) …   one builder per instruction; each returns { programId, keys, data }',
        '  loot.toKitInstruction(ix)   a builder’s instruction in @solana/kit’s shape ({ programAddress, accounts, data }), for an app built on Kit; loot.fromKitInstruction back',
        '  loot.payNftIx({ player, project, asset, to })             pay with an NFT (burned, or given to `to`): the app admits by the receipt',
        '  loot.openListingIx / takeListingIx / closeListingIx, loot.listingTerms(listing), loot.pda.listing(project, asset), loot.renterOf(listing, now)',
        '  a take or a bid signs the record’s terms: loot.listingTerms / offerTerms / auctionTerms(record), the hash of its bytes as read, but what a take changes',
        '  loot.decodeRound(data), loot.partsOwed(round, entry), loot.commonOwed(round), loot.pullIx(...)   a round’s parts, each pulled in any order (a place’s roll: loot.pullRolls, asked in the same transaction)',
        '  loot.drawLotteryIx({ ..., lottery, round, owing })   a round paid from a pot first moves in what the round before left it (`lottery.owing`, its record as `owing`); loot.pda.lotteryPot(lottery, id), loot.potIdOf(terms), loot.leftoverTo(lottery, terms)',
        '  loot.decodeEnds(data), loot.endsToWalk(farm, ends, now), loot.farmNeedsWalk(farm, ends, now), loot.walkFarmParts({ project, id, farm, ends, now }), loot.pda.ends(farm)   a farm’s record of when seats stop earning',
        '  loot.orderRefundable(order, slot, now), loot.rollAskable(order, slot, now), loot.lotteryDrawStuck(round, now), loot.lotteryCancellable(round, now)   deadlines, by the chain’s clock',
        '  loot.runsDue(schedule, now, vaultBalance), loot.scheduleCatchesUp(schedule), loot.pda.vest(schedule), loot.pda.prizeVault(contest), loot.pda.lotteryStash(lottery), loot.pda.rewards(farm)',
        '  loot.decode("LootBox", data), loot.receipts(tx)            accounts, and the receipts of a getTransaction result (none when meta.err is set)',
        'IDL: @xgamesfun/solana/idl.json (Anchor 1.x format).',
        'A page builds the instruction, puts it in a transaction, and asks the player’s wallet (Wallet Standard: Phantom, Solflare, Backpack) to sign and send it. The app never holds a key.',
        'Reads: the project’s records are plain accounts (loot.decode); every move leaves a receipt in the transaction’s logs (loot.receipts(tx)). A backend delivers only from a finalized transaction whose meta.err is null, once per order or reference, and only for a receipt whose data.project is its own (loot.receipts reads every project’s, and anyone can make a project): a failed transaction keeps its logs, and they can read as all-success.',
      ].join('\n');
      return { text: text + footer(), ...PROGRAM_INFO };
    },
  },
];
