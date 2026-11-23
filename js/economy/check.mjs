// The economy checker. Refusals stop an economy from going live: each has a code, what it means for the owner and
// the fix. Warnings are what the owner should know before going live. Pure.
//
// Most refusals are the program's own (cited by the program's source file), caught here so the owner hears about
// them in words before a wallet is ever asked. The rest are traps the program's notes name: a farm that empties a
// lottery's pot, a pool nothing fills, a recipe too big to send, a prize its pool cannot pay.
//
// check() reads the spec whole (secrets, network, version, schema) and builds the helpers every part uses; each
// part's checks are in check/, one module a part or close group, run in a fixed order. sizes.mjs estimates the
// transactions players send.
import { cluster, CLUSTERS, networkOf, useCluster } from '../client/pda.js';
import { encodeBase58 } from '../chain/base58.js';
import { utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import { DAY, model, toBps, toSeconds, toUnits, writtenDurations } from './model.mjs';
import { findSecrets } from './secrets.mjs';
import { simulate } from './simulate.mjs';
import { PARTS } from './guide.mjs';
import { fieldsAt, schemaAt, shapeOf, validate } from './validate.mjs';
import { dateWords, FAR_SECONDS } from './check/dates.mjs';
import { checkKeys } from './check/keys.mjs';
import { checkTokens } from './check/tokens.mjs';
import { checkLiveParts } from './check/live-parts.mjs';
import { checkItems } from './check/items.mjs';
import { checkPools } from './check/pools.mjs';
import { checkBoxes } from './check/boxes.mjs';
import { checkRecipes } from './check/recipes.mjs';
import { checkSchedules } from './check/schedules.mjs';
import { checkLotteries } from './check/lotteries.mjs';
import { checkFarms } from './check/farms.mjs';
import { checkContests } from './check/contests.mjs';
import { checkAuctions } from './check/auctions.mjs';
import { checkGrants } from './check/grants.mjs';
import { checkDecisions } from './check/decisions.mjs';
import { checkSetup } from './check/setup.mjs';
import { checkAnalyses } from './check/analyses.mjs';

/** Every place a spec gives a share of a pool as a prize, as a path ("economy.boxes[0].outcomes[1]"): the program has none. */
function sharePrizes(value, path = 'economy', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => sharePrizes(v, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') {
    if (value.gives === 'share') found.push(path);
    for (const [k, v] of Object.entries(value)) if (k !== 'live') sharePrizes(v, `${path}.${k}`, found);
  }
  return found;
}

// ---------------------------------------------------------------- the checker

/** The address a plan stands in for the owner's wallet before one connects (plan.mjs `placeholderContext`). Nobody
 * holds its key, and the approval page calls it "your wallet" until a wallet connects: no spec may name it. */
export const STAND_IN_OWNER = encodeBase58(sha256(utf8('loot-plan:owner')));

/**
 * The fix of a schema refusal: the shape the schema expects where it failed (or, for a field it doesn't take, the
 * fields that place does take), and the guide's part that has every field of it.
 */
function schemaFix(path) {
  const at = schemaAt(path);
  const shown = s => (s.length > 400 ? `${s.slice(0, 400)}…` : s);
  const place = ['economy', ...at.steps.slice(0, at.reached)].join('.').replace(/\.(\d+)(?=\.|$)/g, '[$1]');
  const expected = at.whole
    ? `It takes ${shown(shapeOf(at.node))}.`
    : `${place} takes ${shown(fieldsAt(at.node).join(', ')) || 'no fields'}.`;
  const part = at.steps[0] && Object.hasOwn(PARTS, at.steps[0]) ? at.steps[0] : null;
  return `${expected} ${part ? `xsolana_guide {"part": "${part}"} gives every field of it with what each means.` : 'xsolana_guide lists every part, and {"part": …} gives one with its fields.'}`;
}

/**
 * Checks an economy spec. `now` (Unix seconds) dates "publish". `project`: the project's address, once a wallet is named
 * (the plan for a real setup passes it; a live economy's file names it): a box's write searches for each of its pools'
 * and stashes' addresses, and the checker counts each search exactly with it, else at an assumed 2 tries an address
 * (`ASSUMED_TRIES`).
 * Returns { ok, refusals: [{ code, where, message, fix }], warnings: [{ code, where, message, fix? }] }.
 */
export function check(
  economy,
  { now = Math.floor(Date.now() / 1000), project = economy?.live?.project ?? null, simulator = simulate } = {},
) {
  const refusals = [];
  const warnings = [];
  const refuse = (code, where, message, fix) => refusals.push({ code, where, message, fix });
  /** A warning; `extra` { severity, ask }: how likely its state is, and the question to put to the person. */
  const warn = (code, where, message, fix, extra) =>
    warnings.push({ code, where, message, ...(fix ? { fix } : {}), ...(extra ?? {}) });
  const result = () => ({ ok: refusals.length === 0, refusals, warnings });

  for (const where of findSecrets(economy))
    refuse(
      'E-SECRET',
      where,
      'This looks like a private key, a seed phrase or a keypair file. Anything in the economy is public: whoever reads it could take the wallet.',
      'Delete it now and move the funds of that wallet to a new one. A spec only ever holds public addresses.',
    );
  if (JSON.stringify(economy ?? null, (_, v) => (typeof v === 'bigint' ? String(v) : v)).includes(STAND_IN_OWNER))
    refuse(
      'E-STAND-IN',
      'economy',
      `The economy names ${STAND_IN_OWNER}, the address the setup plan stands in for your wallet before one connects. Nobody holds its key: whatever is sent there is lost.`,
      'Name a real wallet there.',
    );
  // The economy's cluster: the network it names, devnet when it names none. This process works on one cluster, and
  // the first economy it checks names it when nothing did before.
  const named = networkOf(economy);
  if (!Object.hasOwn(CLUSTERS, named))
    refuse(
      'E-NETWORK',
      'economy.network',
      `The economy names the network “${named}”. loot runs on ${Object.keys(CLUSTERS).join(' and on ')}.`,
      'Set the network to "devnet", or to "mainnet".',
    );
  else
    try {
      useCluster(named);
    } catch {
      refuse(
        'E-NETWORK',
        'economy.network',
        `The economy is on ${named}, and this process works on ${cluster()}: one process works on one cluster.`,
        `Run it where the cluster is ${named}: the xsolana command takes the cluster from the file, and a server or a script is started with XSOLANA_CLUSTER=${named}.`,
      );
    }
  const oldVersion = economy?.version === 1;
  if (oldVersion)
    refuse(
      'E-VERSION',
      'economy.version',
      'Only the current version 2 economy format is supported.',
      'Write the economy using the current schema.',
    );
  // A box's outcome never burns the payment (its split's "burn" share does): said in words, not again by the schema.
  const burnsGone = new Set();
  (Array.isArray(economy?.boxes) ? economy.boxes : []).forEach((b, i) =>
    (Array.isArray(b?.outcomes) ? b.outcomes : []).forEach((o, j) => {
      const at = `economy.boxes[${i}].outcomes[${j}]`;
      if (o?.gives !== 'burn' && o?.burns === undefined) return;
      burnsGone.add(o?.gives === 'burn' ? `${at}.gives` : `${at}.burns`);
      refuse(
        'E-ODDS',
        at,
        `An outcome of “${b?.name ?? b?.key}” burns the payment: a box's outcome no longer does (BadEntries). A box burns its price, whatever its roll gives, with a "burn" share in its split.`,
        o?.gives === 'burn'
          ? 'Make this outcome "nothing", and give the box a "burn" share in its "split".'
          : 'Leave "burns" out, and give the box a "burn" share in its "split".',
      );
    }),
  );
  // The program has no prize that is a share of a pool: said in words, not again by the schema.
  const shares = sharePrizes(economy);
  for (const at of shares)
    refuse(
      'E-SHARE-PRIZE',
      at,
      `${at} gives a share of a pool as a prize, and the program has no such prize on any route: a prize is what its record says, a fixed amount, all of it or none (BadEntries).`,
      'Give a fixed amount: in a box { "gives": "pay", "pool": "<key>", "amount": n }, anywhere else { "gives": "tokens", "from": "pool:<key>", "amount": n }. For a jackpot that grows, use a lottery: its pot is what its tickets fill, and its places take percents of it.',
    );
  const aboutShare = path =>
    shares.some(
      at => path === at || path.startsWith(`${at}.`) || at.startsWith(`${path}.`) || at.startsWith(`${path}[`),
    );
  // Where a lottery's places are paid from is the project's to name, never a default: said in words, not again by the
  // schema.
  const paysUnsaid = new Set();
  (Array.isArray(economy?.lotteries) ? economy.lotteries : []).forEach((l, i) => {
    if (!l || typeof l !== 'object' || 'pot' in l !== 'rest' in l) return;
    const at = `economy.lotteries[${i}]`;
    paysUnsaid.add(at);
    const both = 'pot' in l;
    refuse(
      'E-LOTTERY-PAYS',
      at,
      `The lottery “${l.name ?? l.key}” ${both ? 'names both "pot" and "rest"' : 'does not say where its places are paid from'}: a lottery pays from exactly one. "pot" (a number 0 to 15, usually 0) keeps a pot from round to round: each place takes its percent of what the pot holds at the draw with the round's ticket money, so a seed, gifts, shares of other sales, yield and what earlier rounds' places left all count, and the next round starts with what the round before left. "rest" pays each round from its own ticket money alone, which nothing from outside can change, and sends what its places leave to that destination (the treasury, a wallet, a burn…).`,
      both
        ? 'Keep one: "pot" for a pot that carries over and takes gifts, or "rest" for rounds that each pay from their own tickets.'
        : 'Add "pot": 0 for a jackpot that carries over and that sponsors or other sales can fill, or "rest": "treasury" (or another destination) for rounds that each pay out of their own ticket money.',
    );
  });
  // An old version is said once, by E-VERSION, not again by the schema.
  for (const e of validate(economy))
    if (
      !(oldVersion && e.path === 'economy.version') &&
      !burnsGone.has(e.path) &&
      !aboutShare(e.path) &&
      !(paysUnsaid.has(e.path) && e.message.startsWith('needs exactly one of'))
    )
      refuse('E-SCHEMA', e.path, `${e.path} ${e.message}.`, schemaFix(e.path));
  if (refusals.length) return result();
  // A duration written as seconds is said in its words ("1d"), as it would be had the spec written it so; `asWritten`
  // keeps the spec itself, for what reads the number as it was typed (a time in milliseconds).
  const asWritten = economy;
  economy = writtenDurations(economy);
  /** The value at a checker path ("economy.farms.mission.runs", "economy.lotteries[0].places[1]") in the spec as written. */
  const writtenAt = where =>
    where
      .replace(/^economy\.?/, '')
      .split(/\.|\[(\d+)\]/)
      .filter(Boolean)
      .reduce(
        (v, k) => (Array.isArray(v) ? (/^\d+$/.test(k) ? v[Number(k)] : v.find(x => x?.key === k)) : v?.[k]),
        asWritten,
      );

  const m = model(economy, { now });
  /** Whether a prize is worth farming from many wallets: tokens, an NFT, a collectible that isn't soulbound, or a roll. */
  const tradeable = p =>
    p?.gives === 'tokens' ||
    p?.gives === 'nft' ||
    p?.gives === 'roll' ||
    (p?.gives === 'item' && !m.item.get(p.item)?.soulbound && m.item.get(p.item)?.kind !== 'normal');
  /**
   * The simulation at the spec's scenario, run once for the whole check (`simulator`: `simulate`, or a test's own).
   * null when it cannot run, and then W-SIMULATION says so at the end, with what was therefore not checked: a
   * simulation that stops is a fault in these tools, and a check that hid it would read as a clean spec.
   */
  let simRun;
  const simulated = () => {
    if (simRun === undefined) {
      try {
        simRun = { sim: simulator(economy, { now }) };
      } catch (error) {
        simRun = { sim: null, error };
      }
    }
    return simRun.sim;
  };
  /** What one claim of grant `key` costs its funds, in SOL, as `simulate` counts it (null when it can't say). */
  const grantClaimSol = key => {
    const each = simulated()?.grants?.find(x => x.key === key)?.fundsPerClaimSol;
    return each > 0 ? each : null;
  };
  const units = (amount, token, where, what = 'This amount') => {
    if (!token) return null;
    try {
      return toUnits(amount ?? 0, token.decimals ?? 0);
    } catch (err) {
      refuse(err.code ?? 'E-AMOUNT', where, `${what}: ${err.message}`, err.fix ?? 'Fix the amount.');
      return null;
    }
  };
  const seconds = (duration, where) => {
    try {
      return toSeconds(duration);
    } catch (err) {
      refuse(err.code, where, err.message, err.fix);
      return 0;
    }
  };
  /**
   * A duration the program keeps in 4 bytes (a lock, an unbonding, a collectible's life, a fall's step, a wallet's
   * window, a raise or a shift): its seconds, refused in words past what fits. A signed one (a raise's or a shift's
   * `by`, which may be "-1d") holds half as much each way.
   */
  const fourByteSeconds = (duration, where, { signed = false } = {}) => {
    if (duration === undefined) return 0;
    const negative = typeof duration === 'string' && duration.startsWith('-');
    const s = seconds(negative ? duration.slice(1) : duration, where) * (negative ? -1 : 1);
    const most = signed ? 2_147_483_647 : 4_294_967_295;
    if (s > most || s < (signed ? -most - 1 : 0))
      refuse(
        'E-TIME',
        where,
        `${duration} is ${Math.abs(s).toLocaleString('en-US')} seconds, more than the program keeps here: at most ${most.toLocaleString('en-US')} (about ${Math.floor(most / 31_557_600)} years)${signed ? ' each way' : ''}.`,
        'Use a shorter time.',
      );
    return s;
  };
  /**
   * A duration counted from go-live into a time the program keeps (a farm's end, a schedule's next run): its seconds,
   * refused in words when go-live plus it is past what a count of seconds holds exactly.
   */
  const fromNowSeconds = (duration, where) => {
    const s = seconds(duration, where);
    if (now + s > Number.MAX_SAFE_INTEGER)
      refuse(
        'E-TIME',
        where,
        `${duration} from go-live is further off than the program can count.`,
        'Use a shorter time.',
      );
    return s;
  };
  /**
   * A time that lands far off: the program takes it, and what waits on it (bids, tickets, NFTs, a vault) is
   * locked until then. `at` is when it lands (Unix seconds), `written` what the spec says, `locks` what waits. Warned
   * with the date in words, and as milliseconds when the number written reads as a time in milliseconds.
   */
  const farTime = (at, where, what, said, locks) => {
    if (!(at - now > FAR_SECONDS)) return;
    const typed = writtenAt(where);
    const written = typeof typed === 'number' ? typed : said;
    // A plain number this far off is most likely milliseconds: a thousandth of it is what was meant.
    const millis = typeof written === 'number' || /^\d+$/.test(String(written ?? ''));
    const meant = Math.round(Number(written) / 1000);
    warn(
      'W-FAR-TIME',
      where,
      `${what} lands on ${dateWords(at)}, ${Math.floor((at - now) / 31_536_000).toLocaleString('en-US')} years after go-live${millis ? `: ${written} reads like milliseconds, and the program counts seconds (${meant.toLocaleString('en-US')} seconds is ${meant >= DAY ? `${Math.round(meant / DAY).toLocaleString('en-US')} days` : `${Math.round(meant / 3_600).toLocaleString('en-US')} hours`})` : ''}. The program takes any time, so ${locks} until then.`,
      millis
        ? 'Write the time in seconds, or as a duration like "7d".'
        : 'Check the unit and the date before you sign: a duration like "30d" or a date like "2027-01-01" is safest.',
    );
  };
  /** Refuses a list over one of the program's caps (`LIMITS`), which it would refuse when the owner signs. */
  const tooMany = (count, most, code, where, what, error, fix) => {
    if (count > most) refuse(code, where, `${what}; the program takes at most ${most} (${error}).`, fix);
  };
  const percent = (value, where) => {
    if (value === undefined) return 0;
    const bps = toBps(value);
    if (bps === null)
      refuse(
        'E-PERCENT',
        where,
        `${value}% is finer than the program counts (hundredths of a percent).`,
        'Round it to two decimals.',
      );
    return bps ?? 0;
  };
  /** A boost's percent (up to 10,000%, the schema's bound): whole hundredths of a percent, as the program counts it. */
  const boostPercent = (value, where) => {
    if (value === undefined) return;
    if (Math.abs(Math.round(Number(value) * 100) - Number(value) * 100) >= 1e-6)
      refuse(
        'E-PERCENT',
        where,
        `${value}% is finer than the program counts (hundredths of a percent).`,
        'Round it to two decimals.',
      );
  };
  /** An amount checked without a refusal of its own (another check refuses it where it is written): its base units, or null. */
  const quietUnits = (amount, token) => {
    try {
      return toUnits(amount ?? 0, token?.decimals ?? 0);
    } catch {
      return null;
    }
  };

  // What each part's check (check/*.mjs) reads: the spec, the model, the refusals and warnings and the helpers above.
  // A part's check adds to it what a later part reuses (the tokens' shared checks, the pools' takers and rolls), and
  // the boxes set `chance` and `randomItems` on it. The parts run in this order, which is the order of what they say.
  const c = {
    economy,
    now,
    project,
    refusals,
    refuse,
    warn,
    m,
    tradeable,
    simulated,
    grantClaimSol,
    units,
    seconds,
    fourByteSeconds,
    fromNowSeconds,
    farTime,
    tooMany,
    percent,
    boostPercent,
    quietUnits,
    get simRun() {
      return simRun;
    },
  };
  checkKeys(c);
  if (checkTokens(c)) return result();
  checkLiveParts(c);
  checkItems(c);
  checkPools(c);
  checkBoxes(c);
  checkRecipes(c);
  checkSchedules(c);
  checkLotteries(c);
  checkFarms(c);
  checkContests(c);
  checkAuctions(c);
  checkGrants(c);
  checkDecisions(c);
  checkSetup(c);
  checkAnalyses(c);

  return result();
}

/** The order of the questions: by how much their finding weighs. */
const ASK_ORDER = { high: 0, medium: 1, low: 2 };

/** A one-line summary for each refusal and warning, as a person reads them. */
export function describe({ refusals, warnings }) {
  return [
    ...refusals.map(r => `✗ ${r.code} ${r.message}\n    Fix: ${r.fix}`),
    ...warnings.map(
      w => `! ${w.code}${w.severity ? ` (${w.severity})` : ''} ${w.message}${w.fix ? `\n    ${w.fix}` : ''}`,
    ),
    // (the questions whose finding weighs most first: a builder puts the first few to the person)
    ...(warnings.some(w => w.ask)
      ? [
          '',
          'Ask the person before building on it (saving it, a draft too, is building on it), the first ones first. Each one is theirs to answer: put it to them as a question, with the answer you would pick as your recommendation. One you answer yourself still goes to them, as one plain sentence saying what you chose, so they can overrule it; check it is true first. The scenario holds their numbers: change it only with their answer, and when an answer clears a finding, tell them which:',
          ...warnings
            .filter(w => w.ask)
            .map((w, i) => ({ w, i }))
            .sort((a, b) => (ASK_ORDER[a.w.severity] ?? 3) - (ASK_ORDER[b.w.severity] ?? 3) || a.i - b.i)
            .map(({ w }) => `? ${w.ask}`),
        ]
      : []),
  ].join('\n');
}

export {
  buySize,
  craftSize,
  MAX_COMPUTE_UNITS,
  openBoxSize,
  settleAccounts,
  settleSize,
  settleUnits,
} from './sizes.mjs';

export { dateWords, FAR_SECONDS } from './check/dates.mjs';
