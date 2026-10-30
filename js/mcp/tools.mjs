// The xsolana tools: what an agent needs to turn a person's idea into an economy on the shared loot program, check it,
// simulate it, price it, explain it, save it and hand the person the step that puts it live in their own wallet.
// Each tool is { name, description, inputSchema, annotations, handler(input, ctx) → { text, ...data } }; the server
// (server.mjs) and the terminal (`xsolana tool`) run them the same way. No tool signs, holds a key or talks to a wallet.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkCluster, notMainnet, rpcClient } from '../chain/rpc.js';
import { decodeAny } from '../client/accounts.js';
import { IDL } from '../client/ix.js';
import { LOOT_PROGRAM, pda } from '../client/pda.js';
import { check, describe } from '../economy/check.mjs';
import { legalFlags } from '../economy/legal.mjs';
import { cost, explainCost } from '../economy/cost.mjs';
import { changedParts } from '../economy/live.mjs';
import { example, examples, ideas, search, partsUsed } from '../economy/examples.mjs';
import { explainEconomy } from '../economy/explain.mjs';
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
const NOT_PLAIN = (rel) => `${JSON.stringify(String(rel))} is not a plain file name`;
const RENAME = 'use letters, digits and . _ - (and / for a folder), as in xsolana.json';
/**
 * The command an owner runs to approve going live in their own wallet, pinned to this package's exact version, with
 * the spec's file (relative to the project folder, by `paths`' rules: the system's own unless given) as one plain
 * word. A name that is not plain throws.
 */
export function approveCommand(file = '', paths = path) {
  const name = file ? plainName(file, paths) : '';
  if (name === null) throw new Error(`${NOT_PLAIN(file)}: rename it (${RENAME}).`);
  return `npx -y @xgamesfun/solana@${PACKAGE_VERSION} approve${name ? ` ${name}` : ''}`;
}
export const CLUSTER = 'devnet';
export const DEVNET_RPC = 'https://api.devnet.solana.com';
/** What every answer carries, so an agent never has to remember the program's address. */
export const PROGRAM_INFO = Object.freeze({ program: LOOT_PROGRAM, cluster: CLUSTER, version: VERSION, idl: '@xgamesfun/solana/idl.json', package: `@xgamesfun/solana@${PACKAGE_VERSION}` });
const footer = `\n\nloot ${VERSION} · program ${LOOT_PROGRAM} · ${CLUSTER}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nowOf = (ctx) => ctx?.now ?? Math.floor(Date.now() / 1000);
const cwdOf = (ctx) => ctx?.cwd ?? process.cwd();
export const DEFAULT_FILE = 'xsolana.json';

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
  const inside = (p) => {
    const r = path.relative(root, p);
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  };
  if (!inside(file) || !inside(realPath(file))) throw new Error(`${rel} is outside the project folder (${root}): a spec file must be inside it.`);
  if (path.extname(file).toLowerCase() !== '.json') throw new Error(`${rel} is not a .json file: a spec file is JSON.`);
  return file;
}

/** The spec's own top-level keys (schema.json). */
const SPEC_KEYS = new Set(Object.keys(SCHEMA.properties));
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A file's spec: the JSON as it is, or what it holds under `economy` when that is its only key. */
const specOf = (value) => (plainObject(value) && Object.keys(value).length === 1 && plainObject(value.economy) ? value.economy : value);
/** The spec to read: what a file holds under `economy` (a game file keeps it beside its own keys), else the JSON. */
const economyOf = (value) => (plainObject(value) && plainObject(value.economy) ? value.economy : value);
/**
 * Whether a file's JSON is an economy spec, so xsolana_save may write over it: version 2 with its tokens (every spec that
 * checks has them), a currency if it names one (a spec of one token checks without: that token is its currency)
 * and nothing but the spec's keys, as it is or as the only key of a file, `economy` (a file with other keys beside it
 * would lose them). Every spec xsolana_save writes passes.
 */
export function isSpec(value) {
  const s = specOf(value);
  return plainObject(s) && s.version === 2 && (s.currency === undefined || typeof s.currency === 'string') && Array.isArray(s.tokens) && Object.keys(s).every((k) => SPEC_KEYS.has(k));
}

// ---------------------------------------------------------------- where a spec comes from

const SOURCE = {
  spec: { type: 'object', description: 'An economy spec (version 2) given inline. Takes precedence over file and example.' },
  file: { type: 'string', description: `A JSON file holding the spec, relative to the project folder (default: ${DEFAULT_FILE} when it exists).` },
  example: { type: 'string', description: 'A worked example by name, from xsolana_examples (coin-flip-arena, stud-farm, …).' },
};

async function load(input, ctx) {
  if (input.spec) return { economy: economyOf(input.spec), from: 'the spec given' };
  if (input.example) return { economy: example(input.example).spec, from: `the example ${input.example}` };
  const rel = input.file ?? DEFAULT_FILE;
  const file = projectFile(rel, ctx);
  if (!existsSync(file)) {
    if (input.file) throw new Error(`${rel} does not exist.`);
    throw new Error(`There is no ${DEFAULT_FILE} in ${cwdOf(ctx)} yet. Write a spec (xsolana_guide, xsolana_examples) and pass it as "spec", or save it with xsolana_save.`);
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
    const old = new Map((previous[list] ?? []).map((p) => [p.key, p]));
    out[list] = next[list].map((p) => {
      const was = old.get(p.key);
      if (!was) return p;
      const ids = Object.fromEntries(fields.filter((f) => was[f] !== undefined && p[f] === undefined).map((f) => [f, was[f]]));
      return { ...p, ...ids };
    });
  };
  carry('items', ['id', 'shopBox']);
  carry('pools', ['index']);
  for (const list of ['stashes', 'boxes', 'recipes', 'schedules', 'lotteries', 'grants']) carry(list, ['id']);
  // A farm that pays nothing keeps the number of the empty pool made for it; an auction keeps the seller its address names.
  carry('farms', ['id', 'rewardsIndex']);
  carry('auctions', ['id', 'seller']);
  return out;
}

// ---------------------------------------------------------------- the tools

/** The legal flags to pass on before the person approves, as lines for an answer: [] when there are none. */
function flagsToTell(economy, now) {
  const flags = legalFlags(check(economy, { now }));
  return flags.length ? ['Before anything else, tell the person, in plain words (the approval page shows these too, and asks them to tick that they read them):', ...flags.map((f) => `- ${f.says}`), ''] : [];
}

/**
 * A spec that is already live publishes only what changed (as the approve page does): the plan's scope, and in words
 * what can't change or was taken out.
 */
function liveChange(economy) {
  if (!economy.live?.project || !economy.live?.published) return { scope: {}, notes: '', settings: [] };
  const { only, fixed, removed, settings } = changedParts(economy);
  const notes = [
    settings.length ? `\n${settingsNote(settings, economy.live)}` : '',
    fixed.length ? `\nThese can't change once live, and stay as they were: ${fixed.join(', ')} (a farm, an auction or a pool's token).` : '',
    removed.length ? `\nTaken out of the spec but still on chain: ${removed.join(', ')}. To stop one, keep it and set "active": false.` : '',
  ].join('');
  return { scope: { only, live: economy.live }, notes, settings };
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
    inputSchema: { type: 'object', properties: { part: { type: 'string', enum: Object.keys(PARTS), description: 'One part, with its nested shapes.' } }, additionalProperties: false },
    async handler({ part } = NO_OPTIONS) {
      return { text: guideText(part) + footer, parts: catalog(part), ...(part ? {} : { cannot: CANNOT }), ...PROGRAM_INFO };
    },
  },
  {
    name: 'xsolana_examples',
    annotations: READ,
    description:
      `Find an economy to start from. With \`query\` (the person’s own words, as they said them), returns the closest worked examples (whole specs that check and go live in the tests), the closest of ${ideas().length} real or trending economies rated against loot (great / some / a-lot / cannot, with what carries it or what is missing), and what loot can’t do exactly in the ask, each with the nearest versions it can. Call it again with the words of any part that looks impossible: the answer is a nearest version to offer, not a dead end. With \`name\`, returns that example’s whole spec to copy and change. With neither, lists every example.`,
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
        return { name: ex.name, spec: ex.spec, checks: verdict.ok ? 'clean' : verdict.refusals.map((r) => r.code), text: `${ex.spec.name}: ${ex.spec.prompt ?? ''}\nCopy the spec, change it to what the person asked, then run xsolana_check on it. Existing mints in examples are devnet stand-ins: use the person’s own.${footer}` };
      }
      if (!query) {
        const all = examples().map(({ name: n, spec }) => ({ name: n, title: spec.name, prompt: spec.prompt, parts: partsUsed(spec) }));
        return { examples: all, ideas: { count: ideas().length }, text: [`${all.length} worked examples (xsolana_examples {"name": "<name>"} gives the whole spec):`, ...all.map((e) => `- ${e.name}: ${e.title}. ${e.prompt ?? ''} [${e.parts.join(', ')}]`), `\nAnd ${ideas().length} rated economies: pass a query to search them.`].join('\n') + footer };
      }
      const r = search(query, { limit, fit });
      const text = [
        r.examples.length ? `Examples closest to “${query}” (xsolana_examples {"name": …} gives the whole spec):` : `No worked example matches “${query}”. Start from the nearest idea below, or from xsolana_guide.`,
        ...r.examples.map((e) => `- ${e.name}: ${e.title}. ${e.prompt ?? ''} [${e.parts.join(', ')}]`),
        r.hows.length ? '\nThese look impossible but are one field or a short combination (build them):' : '',
        ...r.hows.map((h) => `- ${h.what}: ${h.how}.`),
        r.ideas.length ? '\nRated economies (rated against this version of loot: a rating is a hint, the parts in xsolana_guide decide):' : '',
        ...r.ideas.map((i) => `- #${i.n} ${i.name} (${i.fit}): ${i.how}`),
        r.limits.length ? '\nWhat no part of loot does here, and the nearest versions (first check that no combination of parts does it; then offer these, best first, with their numbers from xsolana_cost; never end on “it can’t”):' : '',
        ...r.limits.flatMap((l) => [`- ${l.what}: ${l.why}.`, ...l.nearest.map((n, i) => `  ${i + 1}. ${n}`)]),
        r.ideas.some((i) => i.fit === 'cannot') ? '\nA "cannot" means a defining piece was missing when it was rated: check that piece against xsolana_guide’s parts and their combinations before telling the person, then offer the nearest version.' : '',
      ].filter(Boolean).join('\n');
      return { examples: r.examples, ideas: r.ideas, hows: r.hows, limits: r.limits, text: text + footer };
    },
  },
  {
    name: 'xsolana_check',
    annotations: READ,
    description:
      'Check an economy spec: refusals (each with a code, what it means and its fix) stop it from going live; warnings are what the person must hear (chance that pays money, revenue paid to stakers, an unfunded prize, a grant without limits, a mint’s powers). Run it after every change. Give the spec inline (`spec`), a file, or an example.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const verdict = check(economy, { now: nowOf(ctx) });
      const head = verdict.refusals.length || verdict.warnings.length ? describe(verdict) : 'No problems found.';
      const tail = verdict.ok ? `\nReady (${plural(verdict.warnings.length, 'warning')}). Next: xsolana_simulate and xsolana_explain, and tell the person what it means in plain words.` : `\n${plural(verdict.refusals.length, 'refusal')}: fix each as its fix says, then check again.`;
      return { ok: verdict.ok, from, refusals: verdict.refusals, warnings: verdict.warnings, text: `${head}${tail}${footer}` };
    },
  },
  {
    name: 'xsolana_simulate',
    annotations: READ,
    description:
      'The quick simulation (expected values from the spec, instant): what each box, ticket and craft gives back against its price, the house edge, each pool’s money in and out per day and whether it runs dry, settles or grows, farm rewards per unit staked, what players, the treasury and the platform get each day. `scenario` overrides the spec’s own ({"perDay": {"box:flip": 1000}, "days": 30, "staked": {"<farm>": 1000}}). Quote its numbers; never your own arithmetic.',
    inputSchema: { type: 'object', properties: { ...SOURCE, scenario: { type: 'object', description: 'What to assume instead of the spec’s scenario.' }, json: { type: 'boolean', description: 'Also return every row.' } }, additionalProperties: false },
    async handler(input, ctx) {
      const { economy: e, from } = await load(input, ctx);
      const economy = input.scenario ? { ...e, scenario: { ...e.scenario, ...input.scenario } } : e;
      const verdict = check(economy, { now: nowOf(ctx) });
      if (!verdict.ok) return refused(verdict, from);
      const sim = simulate(economy, { now: nowOf(ctx) });
      const summary = {
        boxes: sim.boxes.map((b) => ({ key: b.key, returnPercent: b.returnPercent, houseEdgePercent: b.houseEdgePercent })),
        pools: sim.pools.map((p) => ({ key: p.key, lasts: p.lasts, lastsDays: p.lastsDays, settlesAt: p.settlesAt })),
        farms: sim.farms.map((f) => ({ key: f.key, rewardsPerDay: f.rewardsPerDay, yearlyPercent: f.yearlyPercent })),
        platformSolPerDay: sim.perDay.platform.totalSol,
      };
      return { ok: true, from, summary, ...(input.json ? { simulation: sim } : {}), text: explain(sim, economy) + footer };
    },
  },
  {
    name: 'xsolana_cost',
    annotations: READ,
    description: 'What going live costs (each account’s rent, the program’s fees, network fees, the seeds, the transactions and wallet approvals it takes) and what each action costs whoever signs it while it runs.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const change = liveChange(economy);
      const c = cost(economy, { now: nowOf(ctx), ...change.scope });
      if (!c.ok) return refused(c, from);
      const head = change.scope.live ? (change.scope.only.size ? `This economy is live: this prices only the change (${[...change.scope.only].join(', ')}).\n` : 'This economy is live and nothing has changed since it went live: publishing costs nothing.\n') : '';
      return { ok: true, from, setup: c.setup, actions: c.actions, fees: c.fees, text: head + explainCost(c) + footer };
    },
  },
  {
    name: 'xsolana_explain',
    annotations: READ,
    description: 'The economy in plain words for the person: what players do and what it costs and is worth, how the pools fill and drain, what runs by itself, what the authority must sign, what going live costs, and what is flagged for the law. Tell them the essentials in a few lines, from this text.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const r = explainEconomy(economy, { now: nowOf(ctx) });
      return { ...r, from, text: r.text + footer };
    },
  },
  {
    name: 'xsolana_save',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: `Save a spec into the project (default ${DEFAULT_FILE}), only if it checks. A file that is already live keeps its program numbers and its live section. Never put a key in it: the checker refuses one.`,
    inputSchema: { type: 'object', properties: { spec: SOURCE.spec, file: SOURCE.file }, required: ['spec'], additionalProperties: false },
    async handler(input, ctx) {
      const rel = input.file ?? DEFAULT_FILE;
      let file;
      try {
        file = projectFile(rel, ctx);
      } catch (e) {
        return { ok: false, isError: true, text: `Not saved: ${e.message}` };
      }
      // a name the approve command can carry as it is: letters, digits and . _ - in each part, parts split by /
      if (plainName(rel) === null) return { ok: false, isError: true, text: `Not saved: ${NOT_PLAIN(rel)}. Use letters, digits and . _ - (and / for a folder), as in ${DEFAULT_FILE}.` };
      if (findSecrets(input.spec).length) return { ok: false, isError: true, text: 'Not saved: the spec holds what looks like a private key or a seed phrase. Remove it (and treat that wallet as exposed).' };
      let previous = null;
      if (existsSync(file)) {
        try {
          previous = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          previous = null;
        }
        // Only a spec is ever overwritten: never another JSON file that happens to be there (a package.json has a
        // `version` too). A spec is version 2 with only the spec's own keys, as it is or under `economy`.
        if (!isSpec(previous)) return { ok: false, isError: true, text: `Not saved: ${rel} is there already and is not an economy spec. Pick another file name.` };
      }
      // (a spec wrapped under `economy`, given or already in the file, is read the same way xsolana_check reads it)
      const given = economyOf(input.spec);
      const spec = carryIds(previous && economyOf(previous), given);
      const dropped = given.live && !previous?.live ? ' The live section given was not kept: only `xsolana approve` writes one, as what it sends lands.' : '';
      const verdict = check(spec, { now: nowOf(ctx) });
      if (!verdict.ok) return { ...refused(verdict, 'the spec given'), isError: true, text: `Not saved.\n${refused(verdict, 'the spec given').text}` };
      // A folder that isn't there yet is made, inside the project folder (projectFile checked the whole path).
      try {
        await mkdir(path.dirname(file), { recursive: true });
      } catch (e) {
        return { ok: false, isError: true, text: `Not saved: the folder for ${rel} can’t be made (${e.code ?? 'error'}).` };
      }
      await writeFile(file, `${JSON.stringify(spec, null, 2)}\n`);
      return { ok: true, file: rel, warnings: verdict.warnings, text: `Saved ${rel} (${plural(verdict.warnings.length, 'warning')}).${dropped}${spec.live ? ' It is live: xsolana_publish publishes only what changed.' : ' Next: xsolana_publish when the person says to put it live.'}${footer}` };
    },
  },
  {
    name: 'xsolana_publish',
    annotations: { ...READ, readOnlyHint: true },
    description:
      `When the person says to put it live: returns what going live does (every step, in order, and its cost) and the one command they run themselves to approve it in their own wallet (\`${approveCommand()}\`, pinned to this exact version: give it as it is): it opens a local page where they connect a devnet wallet and approve each transaction. You never sign, never ask for a key, and never run the approval for them.`,
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from, file } = await load(input, ctx);
      const change = liveChange(economy);
      if (change.scope.live && !change.scope.only.size && change.settings.length) return { ok: false, transactions: 0, approvals: 0, steps: [], text: `${from} is live, and its parts are as they are on chain. ${settingsNote(change.settings, economy.live)}${footer}` };
      if (change.scope.live && !change.scope.only.size) return { ok: true, transactions: 0, approvals: 0, steps: [], text: `${from} is live, and nothing in it has changed since it went live: there is nothing to publish.${change.notes}${footer}` };
      const p = plan(economy, { now: nowOf(ctx), ...change.scope });
      if (!p.ok) return refused(p, from);
      const c = cost(economy, { now: nowOf(ctx), ...change.scope });
      const steps = p.transactions.flatMap((t) => t.steps.map((s) => s.says));
      // the file as the approve command names it, relative to the project folder (projectFile's), and plain (plainName)
      const target = file ? path.relative(realPath(path.resolve(cwdOf(ctx))), file) || DEFAULT_FILE : DEFAULT_FILE;
      if (plainName(target) === null) return { ok: false, transactions: 0, approvals: 0, steps: [], text: `Not published: ${NOT_PLAIN(target)}, and the approve command carries the file's name as it is. Ask the person to rename it (${RENAME}), then run xsolana_publish again with the new name.${footer}` };
      const command = approveCommand(target);
      const text = [
        ...flagsToTell(economy, nowOf(ctx)),
        `${change.scope.live ? 'Publishing this change to the live economy' : 'Going live'}: ${plural(p.transactions.length, 'transaction')}, ${plural(p.approvals, 'wallet approval')}, about ${c.setup.totalSol} SOL on devnet:`,
        ...steps.map((s, i) => `${i + 1}. ${s}`),
        '',
        `To put it live, the person runs this in a terminal in the project folder (not you): ${command}`,
        'It opens a page on their own computer; they connect a wallet set to devnet and approve. What lands is written back into the file.',
        'Tell them too, as the page does: the program is not independently audited and comes as is, with no warranty; they use it at their own risk, and making sure the economy is legal where it is offered is up to them (DISCLAIMER.md in the package).',
        ...(file ? [] : [`(Save it first with xsolana_save: the approval reads ${DEFAULT_FILE}.)`]),
        ...(change.notes ? [change.notes.trim()] : []),
      ].join('\n');
      return { ok: true, command, transactions: p.transactions.length, approvals: p.approvals, setupSol: c.setup.totalSol, steps, text: text + footer };
    },
  },
  {
    name: 'xsolana_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'A live economy as it is on chain: the project, every pool’s balance, every record the spec names (found or missing). Reads devnet (or XSOLANA_RPC_URL).',
    inputSchema: { type: 'object', properties: { file: SOURCE.file }, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      if (!economy.live?.project) return { ok: false, text: `${from} is not live yet (no "live" section). xsolana_publish says how to put it live.${footer}` };
      const m = model(economy);
      // Devnet only: a mainnet URL is refused, and so is a chain whose first block is mainnet's or testnet's.
      const rpc = (ctx?.rpc ?? rpcClient)(notMainnet(process.env.XSOLANA_RPC_URL || DEVNET_RPC));
      if (!ctx?.rpc) await checkCluster(rpc);
      const project = economy.live.project;
      const wanted = [
        ['project', project],
        ...m.pools.map((p) => [`pool:${p.key}`, pda.pool(project, p.index)]),
        ...m.allBoxes.map((b) => [b.shopOf ? `item:${b.shopOf} (shop)` : `box:${b.key}`, pda.box(project, b.id)]),
        ...m.items.map((it) => [`item:${it.key}`, pda.item(project, it.id)]),
        ...m.farms.map((f) => [`farm:${f.key}`, pda.farm(project, f.id)]),
        ...m.lotteries.map((l) => [`lottery:${l.key}`, pda.lottery(project, l.id)]),
        ...m.schedules.map((s) => [`schedule:${s.key}`, pda.schedule(project, s.id)]),
        ...m.recipes.map((r) => [`recipe:${r.key}`, pda.recipe(project, r.id)]),
        ...m.grants.map((g) => [`grant:${g.key}`, pda.grant(project, g.id)]),
        ...m.stashes.map((s) => [`stash:${s.key}`, pda.stash(project, s.id)]),
        ...(economy.auctions ?? []).filter((a) => a.seller).map((a) => [`auction:${a.key}`, pda.auction(project, a.seller, a.id)]),
      ];
      const accounts = await rpc.accounts(wanted.map(([, a]) => a));
      const rows = wanted.map(([part, address], i) => {
        const a = accounts[i];
        if (!a) return { part, address, found: false };
        // A grant's funds are the SOL it holds beyond its rent: what is left to pay its claims' fees and rent.
        if (part.startsWith('grant:')) return { part, address, found: true, kind: 'Grant', sol: Number(BigInt(a.lamports ?? 0) - rentOf(a.data?.length ?? 0)) / 1e9 };
        const tokenAmount = a.data?.length >= 72 && part.startsWith('pool:') ? Number(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true)) : undefined;
        const decoded = a.owner === LOOT_PROGRAM ? decodeAny(a.data) : null;
        // A stash: how many NFTs it still holds to give away.
        const nfts = decoded?.kind === 'Stash' ? decoded.value.nfts.length : undefined;
        return { part, address, found: true, ...(tokenAmount !== undefined ? { amount: tokenAmount } : {}), ...(nfts !== undefined ? { nfts } : {}), ...(decoded ? { kind: decoded.kind } : {}) };
      });
      const missing = rows.filter((r) => !r.found);
      const text = [`${economy.name ?? 'The economy'} on ${CLUSTER}: project ${project}.`, ...rows.map((r) => `- ${r.part}: ${r.found ? `found${r.amount !== undefined ? `, holds ${r.amount} base units` : ''}${r.nfts !== undefined ? `, holds ${r.nfts} NFT${r.nfts === 1 ? '' : 's'} to give away` : ''}${r.sol !== undefined ? `, holds ${r.sol} SOL for claims` : ''}` : 'missing'} (${r.address})`), missing.length ? `\n${plural(missing.length, 'part')} not on chain: publish again (xsolana_publish) to add them.` : ''].filter(Boolean).join('\n');
      return { ok: true, rows, text: text + footer };
    },
  },
  {
    name: 'xsolana_client',
    annotations: READ,
    description: 'How an app (a game, a site, a bot) uses a live economy: the program’s address and cluster, the npm package and IDL, and the calls a page makes with the player’s own wallet (open a box, buy, stake, craft, enter, claim). Use this instead of writing chain code from memory.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const text = [
        `loot ${VERSION} on ${CLUSTER}: program ${LOOT_PROGRAM}. Never write another address from memory: take it from this package.`,
        'Package: npm install @xgamesfun/solana (plain ES modules, no Solana SDK needed; works in the browser).',
        '  import { solanaApp, walletStandardSigner } from "@xgamesfun/solana/play";',
        '  const app = solanaApp({ spec /* the live xsolana.json */, rpcUrl, wallet: walletStandardSigner(wallet, account) });',
        '  app.shop(), app.buy(key, { listing }), app.boxes(), app.openBox(key, { listing }), app.pay(key) (or app.pay(key, { chosenRecipient })),',
        '  `chosenRecipient` (buy, openBox, pay): the wallet (or collectible) the player names for a "chosen" share of the split (a referrer from the link)',
        '  app.lotteries(), app.buyTickets(key, n, { listing }) (or { maxPrice }: a ticket’s most, in base units),',
        '  app.stake(key, amount), app.harvest(key), app.staked(key) (each seat and what it is owed now), app.recipes(), app.craft(key, assets, 1, { listing }), app.claimGrant(key),',
        '  app.collectibles(), app.balances()   what a player does. `listing`: the entry shop(), boxes(), lotteries() or recipes() showed the',
        '  player; its price (or version) is the most they pay: one that moved since is refused, never paid unseen',
        '  a prize (a grant, a lottery place, a contest win, a mission, a recipe) is given in the instruction that wins it,',
        '  its accounts from loot.prizeMetas({ project, collection, prize, winner, poolMints, items, nft }) (a roll a buy, a craft',
        '  or a grant claim makes: strict: true, boxes, rollPools, for the box’s prize mints, loot.rollMints); app.claims() finds',
        '  what a player is owed. A roll (a prize of a roll, an auction lot, a box) is an order: app.claim / app.collect, or',
        '  loot.askRollIx({ payer, orderAddress, order, box }) then loot.settleIx(...) hands over what it rolled (a stash NFT too)',
        '  loot.stashIx({ signer, project, id, asset, out })           the owner or authority puts an NFT in a stash, or takes one out',
        '  app.listForSale(asset, { price }), app.listForRent(asset, { price, lasts, maxPeriods }), app.listing(asset), app.listings(),',
        '  app.buyListing(asset, { listing }), app.rentListing(asset, { periods, listing }) (`listing`: what listing() or listings()',
        '  showed the player), app.unlist(asset), app.rentedTo(asset) (one account read)   listings, sale and rent',
        '  app.raffle(id, nft, { price, drawsAt, minSold }), app.unraffle(id, nft)   a raffle from the lottery’s own stash',
        '  app.compound(key), app.withdraw(key), app.runSchedule(key)   compound, take out unbonded tokens, catch a schedule up',
        '  app.claims() also lists a raffle’s prize step (given before the money), unbonded tokens, vested runs, a rental over',
        'Lower level, for what the player module does not cover:',
        '  import * as loot from "@xgamesfun/solana/client";',
        '  loot.pda.project(owner, number), loot.pda.box(project, id), …   every address the program derives',
        '  loot.openBoxIx({ player, project, box, nonce }), loot.buyIx({ player, project, box, items }) …   one builder per instruction; each returns { programId, keys, data }',
        '  loot.payNftIx({ player, project, asset, to })             pay with an NFT (burned, or given to `to`): the app admits by the receipt',
        '  loot.openListingIx / takeListingIx / closeListingIx, loot.listingTerms(listing), loot.pda.listing(project, asset), loot.renterOf(listing, now)',
        '  loot.lotteryStep(lottery, contribution) then loot.finishLotteryContributionIx(...)   a drawn round’s prizes first, then its money',
        '  loot.withdrawable(seat, now), loot.runsDue(schedule, now, vaultBalance), loot.pda.vest(schedule), loot.pda.prizeVault(contest), loot.pda.lotteryStash(lottery)',
        '  loot.decode("LootBox", data), loot.receipts(tx)            accounts, and the receipts of a getTransaction result (none when meta.err is set)',
        'IDL: @xgamesfun/solana/idl.json (Anchor 1.x format).',
        'A page builds the instruction, puts it in a transaction, and asks the player’s wallet (Wallet Standard: Phantom, Solflare, Backpack) to sign and send it. The app never holds a key.',
        'Reads: the project’s records are plain accounts (loot.decode); every move leaves a receipt in the transaction’s logs (loot.receipts(tx)). A backend delivers only from a finalized transaction whose meta.err is null, once per order or reference: a failed transaction keeps its logs, and they can read as all-success.',
      ].join('\n');
      return { text: text + footer, ...PROGRAM_INFO };
    },
  },
];
