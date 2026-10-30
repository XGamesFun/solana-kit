#!/usr/bin/env node
// Live evals: a fresh agent builds an economy and its app for a simulated person, end to end, on devnet.
//
//   node evals/live/run.mjs [--harness claude|codex|both] [--only id,id] [--parallel n] [--model m] [--effort e] [--max-turns n]
//                           [--cards <file>] [--keeper [--server-dir <dir>]]
//
// --cards reads another card file (evals/live/composition-cards.json); a copy goes in the round's folder as cards.json, which
// digest.mjs and regrade.mjs read. --effort is Codex's reasoning effort.
//
// For each scenario card and harness: an empty project folder with only the xsolana plugin's pieces; a user simulator
// playing the person; fresh devnet wallets for the owner and a player, topped up by the eval funder; the person runs
// the approval command the agent gives them (the test wallet approves in a headless browser, after checking every
// transaction); the person asks for a page and opens it; a player robot uses it with its own test wallet. Everything
// is recorded under evals/results/live-<time>/<harness>/<card>/, graded, and summed up in summary.md. What the
// wallets have left goes back to the funder.
//
// Needs: claude and codex logged in, Chrome, and the eval funder: XSOLANA_EVAL_FUNDER names its devnet keypair file
// (funds.mjs), which must hold devnet SOL. The agents under test never see that variable.
// XSOLANA_EVAL_RPC_URL is the harness's own devnet RPC (funding, the approval, the test wallets): a keyed one keeps a
// full round under the public RPC's rate limits. It is never handed to the agents being tested, and is scrubbed from
// everything recorded. XSOLANA_RPC_URL, if set, is passed to the agents' tools as a person's own setting would be.
//
// --keeper runs the round with a results server beside it. That server is not part of this repository: name a
// folder holding its scripts/loot-server.mjs (with its npm packages installed) with --server-dir or
// XSOLANA_EVAL_SERVER_DIR. One server runs for the round on a throwaway voucher key, at the address cards name as
// {KEEPER}; its sweep runs every few minutes over the round's live games, paid by a throwaway fee payer. The client
// games use with it is @xgamesfun/solana/results, in the @xgamesfun/solana the registry serves from this checkout.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcClient } from '../../js/chain/rpc.js';
import { builder, LIMIT, player } from './agents.mjs';
import { approveRun, isApproveCommand } from './approver.mjs';
import { spawnGroup, stopGroup, stopWithin } from './procs.mjs';
import { fund, funder as loadFunder, sweep, throwaway } from './funds.mjs';
import { grade } from './grade.mjs';
import { reclaim } from './reclaim.mjs';
import { startRegistry } from './registry.mjs';
import { nextMove } from './usersim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const harnesses = opt('harness', 'both') === 'both' ? ['claude', 'codex'] : [opt('harness')];
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const parallel = Number(opt('parallel', 2));
const model = opt('model', null);
const effort = opt('effort', null);
const cardFile = path.resolve(opt('cards', path.join(ROOT, 'evals/live/cards.json')));
const maxTurns = Number(opt('max-turns', 14));
const keeperRound = args.includes('--keeper');
const SERVER_DIR = opt('server-dir', process.env.XSOLANA_EVAL_SERVER_DIR || null);
if (keeperRound && !(SERVER_DIR && existsSync(path.join(SERVER_DIR, 'scripts/loot-server.mjs')))) {
  console.error('A --keeper round needs a results server: --server-dir <dir> or XSOLANA_EVAL_SERVER_DIR, a folder holding scripts/loot-server.mjs.');
  process.exit(1);
}
const KIT_DIR = process.env.XSOLANA_EVAL_KIT_DIR || ROOT;
const PUBLIC_RPC = 'https://api.devnet.solana.com';
const RPC = process.env.XSOLANA_EVAL_RPC_URL || process.env.XSOLANA_RPC_URL || PUBLIC_RPC;
if (/mainnet/i.test(RPC)) throw new Error('Live evals run on devnet only.');
const HIDE = RPC === PUBLIC_RPC ? null : RPC;
/** Text with the harness's RPC URL (it may hold a key) taken out. */
const scrub = (text) => (HIDE ? String(text).replaceAll(HIDE, '<eval-rpc>').replaceAll(new URL(HIDE).search.slice(1) || HIDE, '<eval-rpc-key>') : String(text));
const record = (file, text) => writeFileSync(file, scrub(text));
const OWNER_SOL = 0.5;
const PLAYER_SOL = 0.1;

const { cards: all } = JSON.parse(readFileSync(cardFile, 'utf8'));
// A card that needs the results server (`keeper`) runs only in a --keeper round, unless --only names it.
const cards = all.filter((c) => (only ? only.has(c.id) : Boolean(c.keeper) === keeperRound));
const runDir = path.join(ROOT, 'evals/results', `live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(runDir, { recursive: true });
cpSync(cardFile, path.join(runDir, 'cards.json'));
const rpc = rpcClient(RPC);
const funder = loadFunder();
// Wallets are topped up as runs start and swept back as they end: what is spent is rent, fees and seeds.
// With the pools reclaimed, a run keeps about 0.02–0.05 (rent, fees, oracle); what is out at once is the float.
const need = Math.min(parallel, cards.length * harnesses.length) * (OWNER_SOL + PLAYER_SOL) + cards.length * harnesses.length * 0.05 + (keeperRound ? 0.15 : 0);
const have = Number(await rpc.balance(funder.address)) / 1e9;
if (have < need) {
  console.error(`The eval funder ${funder.address} holds ${have} devnet SOL; this round needs about ${need.toFixed(2)} (most comes back).`);
  process.exit(1);
}
const registry = await startRegistry(runDir, { kitDir: KIT_DIR });
// The agents, the person and the robot never see the harness's own RPC URL (it may hold a key) or where the funder's
// key is.
const { XSOLANA_EVAL_RPC_URL: _evalRpc, XSOLANA_EVAL_FUNDER: _funderFile, ...parentEnv } = process.env;
const baseEnv = { ...parentEnv, npm_config_registry: registry.url, npm_config_cache: path.join(runDir, 'npm-cache'), npm_config_update_notifier: 'false', XSOLANA_NO_OPEN: '1', ...(process.env.XSOLANA_RPC_URL ? { XSOLANA_RPC_URL: process.env.XSOLANA_RPC_URL } : {}) };
const say = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- the results server, for a --keeper round

const serverKeys = keeperRound ? mkdtempSync(path.join(os.tmpdir(), 'xsolana-eval-keys-')) : null;
const SERVER_BIN = keeperRound ? path.join(SERVER_DIR, 'scripts/loot-server.mjs') : null;
const serverEnv = { ...parentEnv, XSOLANA_RPC_URL: RPC };
let resultsServer = null;
let sweeper = null;
const liveGames = new Set();
if (keeperRound) {
  execFileSync(process.execPath, [SERVER_BIN, 'new-key', path.join(serverKeys, 'voucher.key.json')], { env: serverEnv, stdio: 'ignore' });
  const port = 8700 + Math.floor(Math.random() * 200);
  const child = spawnGroup(process.execPath, [SERVER_BIN, 'serve', '--voucher-key', path.join(serverKeys, 'voucher.key.json'), '--state', path.join(runDir, 'results-server.db'), '--port', String(port), '--voucher-seconds', '600'], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 3000));
  if (!/Serving at/.test(out)) throw new Error(`The results server didn't start: ${scrub(out).slice(0, 500)}`);
  resultsServer = { url: `http://127.0.0.1:${port}`, child, log: () => out };
  say(`results server at ${resultsServer.url}`);
  // The sweep: every 4 minutes, one pass over the round's live games, with a short grace.
  const payer = throwaway(path.join(serverKeys, 'payer.key.json'));
  await fund(rpc, funder, payer.address, 0.15);
  let sweeping = false;
  const pass = async () => {
    if (sweeping || !liveGames.size) return;
    sweeping = true;
    try {
      const games = [...liveGames].flatMap((g) => ['--game', g]);
      const r = await new Promise((resolve) => {
        const c = spawnGroup(process.execPath, [SERVER_BIN, 'sweep', '--payer', path.join(serverKeys, 'payer.key.json'), '--grace', '120', '--pay-rent', ...games], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '';
        c.stdout.on('data', (d) => (o += d));
        c.stderr.on('data', (d) => (o += d));
        c.on('close', () => resolve(o));
      });
      writeFileSync(path.join(runDir, 'sweep.log'), `${existsSync(path.join(runDir, 'sweep.log')) ? readFileSync(path.join(runDir, 'sweep.log'), 'utf8') : ''}${scrub(r)}`);
    } finally {
      sweeping = false;
    }
  };
  sweeper = { payer, pass, timer: setInterval(() => pass().catch(() => {}), 240_000) };
}

// ---------------------------------------------------------------- the app the person opens

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
async function staticServer(dir) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dir, url);
    if (file !== dir && !file.startsWith(dir + path.sep)) return res.writeHead(403).end();
    if (existsSync(file) && !path.extname(file)) file = path.join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
}

// `cd <folder in the project> && <command>` runs the command in that folder.
const IN_FOLDER = /^cd\s+([\w./-]+)\s*&&\s*(.+)$/;
const APP_COMMAND = /^(?:[A-Z_]+=[\w.:/-]*\s+)*(npm\s+(run\s+[\w:-]+|start|run-script\s+[\w:-]+)|npx\s+(-y\s+)?(serve|vite|http-server|live-server)(\s+[\w./-]+)*|node\s+[\w./-]+\.m?js|python3?\s+-m\s+http\.server(\s+\d+)?)\s*$/;
const SETUP_COMMAND = /^npm\s+(install|i|ci)(\s+[@\w./-]+)*\s*$/;
// A game server's own script (a --keeper card's `scripts`): `node report-win.mjs <wallet>`, run once, not kept running.
const SCRIPT_COMMAND = /^(?:[A-Z_]+=[\w.:/-]*\s+)*node\s+[\w./-]+\.m?js(\s+[\w.:/=@-]+)*\s*$/;

/** A command line as the person types it: `HOST=0.0.0.0 node server.mjs` → { bin, args, env }. */
function splitCommand(command) {
  const parts = command.trim().split(/\s+/);
  const env = {};
  while (/^[A-Z_]+=/.test(parts[0] ?? '')) {
    const [k, ...v] = parts.shift().split('=');
    env[k] = v.join('=');
  }
  return { bin: parts[0], args: parts.slice(1), env };
}

// Commands the person runs get a home folder of the run's own: what a game server writes to ~/.config stays in the run.
function startApp(command, cwd, home = null) {
  return new Promise((resolve) => {
    const c = splitCommand(command);
    const child = spawnGroup(c.bin, c.args, { cwd, env: { ...baseEnv, BROWSER: 'none', PORT: String(4100 + Math.floor(Math.random() * 800)), ...(home ? { HOME: home } : {}), ...c.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => resolve({ url: null, out, stop: () => stopGroup(child) }), 120_000);
    const seen = (d) => {
      out += d;
      // eslint-disable-next-line no-control-regex -- strips terminal colour codes
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
      // A link it printed, or just a port ("listening on port 4123").
      const port = /(?:listening|running|serving|started)[^\n]{0,30}?\bport\s*:?\s*([1-9]\d{1,4})\b/i.exec(plain);
      const m = /(https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+[^\s'"]*)/.exec(plain) ?? (port ? [null, `http://127.0.0.1:${port[1]}/`] : null);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1].replace('0.0.0.0', '127.0.0.1'), out, stop: () => stopGroup(child) });
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('close', () => resolve({ url: null, out, stop: () => {} }));
  });
}

function runSetup(command, cwd, timeoutMs = 300_000, home = null) {
  return new Promise((resolve) => {
    const c = splitCommand(command);
    const child = spawnGroup(c.bin, c.args, { cwd, env: { ...baseEnv, ...(home ? { HOME: home } : {}), ...c.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => stopGroup(child), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// ---------------------------------------------------------------- one run

async function one(harness, card0) {
  // The results go under the repo; the project, the agents' working folders and the test keys live outside it, so
  // nothing in the run sees this repo (its package.json is @xgamesfun/solana, which npx would take for the package).
  const where = path.join(runDir, harness, card0.id);
  mkdirSync(where, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), `xsolana-eval-${card0.id}-`));
  const keys = mkdtempSync(path.join(os.tmpdir(), 'xsolana-eval-keys-'));
  const dir = path.join(work, 'project');
  mkdirSync(dir, { recursive: true });
  const home = path.join(work, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(path.join(ROOT, 'skills'), path.join(dir, harness === 'claude' ? '.claude/skills' : '.agents/skills'), { recursive: true });
  const owner = throwaway(path.join(keys, 'owner.key.json'));
  const playerKey = path.join(keys, 'player.key.json');
  const playerWallet = throwaway(playerKey);
  await fund(rpc, funder, owner.address, OWNER_SOL);
  await fund(rpc, funder, playerWallet.address, PLAYER_SOL);
  const conversation = [];
  try {
    const card = JSON.parse(JSON.stringify(card0).replaceAll('{PLAYER}', playerWallet.address).replaceAll('{KEEPER}', resultsServer?.url ?? '(no results server in this round)'));
    const noteGame = () => {
      try {
        const live = JSON.parse(readFileSync(path.join(dir, 'xsolana.json'), 'utf8')).live;
        const g = live?.project ?? live?.game;
        if (g) liveGames.add(g);
      } catch {
        // No xsolana.json, or not one that went live.
      }
    };
    const b = builder(harness, { dir, env: baseEnv, model, effort });
    const turns = [];
    const approvals = [];
    const players = [];
    const ownerPages = [];
    const walletLogs = [];
    const toBuilder = async (text) => {
      conversation.push({ from: 'user', text });
      const r = await b.turn(text);
      // An answer from the harness, not the agent: the run says nothing about loot, so it errors instead of grading.
      if (LIMIT.test(r.text)) throw new Error(`${harness} hit a usage limit: ${r.text.slice(0, 200)}`);
      turns.push({ events: r.events });
      record(path.join(where, `turn-${turns.length}.jsonl`), r.raw);
      conversation.push({ from: 'assistant', text: r.text });
      say(`${harness} ${card.id} turn ${turns.length}`);
    };
    await toBuilder(card.opening);
    let ended = 'turns ran out';
    while (turns.length < maxTurns) {
      let move;
      try {
        move = await nextMove({ card, wallet: owner.address, history: conversation, cwd: work, env: baseEnv });
      } catch (e) {
        // The person stopped answering after the page was already tried: the run is graded on what happened.
        if (!players.length) throw e;
        ended = `the simulator stopped answering (${e.message.slice(0, 120)})`;
        break;
      }
      conversation.push({ from: 'simulator', text: JSON.stringify(move) });
      if (move.action === 'done') {
        ended = 'the person was done';
        break;
      }
      if (move.action === 'run_command') {
        const command = String(move.command ?? '');
        if (isApproveCommand(command)) {
          const log = path.join(where, `wallet-owner-${approvals.length + 1}.jsonl`);
          const r = await approveRun({ command, cwd: dir, env: { ...baseEnv, XSOLANA_RPC_URL: RPC }, keypair: owner, rpc, log });
          r.said = scrub(r.said);
          r.afterPlayers = players.length;
          approvals.push(r);
          walletLogs.push({ role: 'owner', findings: r.findings });
          conversation.push({ from: 'system', text: r.ok ? `You ran it and approved in your wallet. The page said:\n${r.said.slice(0, 1200)}` : `You ran it, but it didn't finish${r.requests ? ` (you approved ${r.requests === 1 ? 'a transaction' : `${r.requests} wallet requests`} on the page: your wallet signed what it showed you)` : ''}:\n${r.said.slice(0, 4000)}` });
          say(`${harness} ${card.id} approval ${r.ok ? 'landed' : 'failed'}`);
          noteGame();
        } else if (card.checks.scripts && SCRIPT_COMMAND.test(command.replace(IN_FOLDER, '$2'))) {
          const inFolder = IN_FOLDER.exec(command);
          const folder = inFolder ? path.resolve(dir, inFolder[1].replace(/^.*\/project(\/|$)/, '')) : dir;
          const r = await runSetup((inFolder ? inFolder[2] : command).trim(), folder.startsWith(dir) && existsSync(folder) ? folder : dir, 120_000, home);
          conversation.push({ from: 'system', text: `You ran \`${command}\`. It ${r.code === 0 ? 'finished' : `failed (exit ${r.code})`}:\n${scrub(r.out).slice(-1200)}` });
          say(`${harness} ${card.id} ran a script (${r.code})`);
          noteGame();
        } else if (SETUP_COMMAND.test(command)) {
          const r = await runSetup(command, dir, 300_000, home);
          conversation.push({ from: 'system', text: `You ran \`${command}\`. It ${r.code === 0 ? 'finished' : `failed (exit ${r.code})`}:\n${r.out.slice(-800)}` });
        } else conversation.push({ from: 'system', text: `You didn't run \`${command.slice(0, 200)}\`: it isn't something you would run (only the approval command, npm install, ${card.checks.scripts ? 'a node script of your game server, ' : ''}or a command that starts the page; a page is opened with open_app, or open_owner_page for one you use yourself).` });
        continue;
      }
      if (move.action === 'open_app' || move.action === 'open_owner_page') {
        const asOwner = move.action === 'open_owner_page';
        const spec = existsSync(path.join(dir, 'xsolana.json')) ? JSON.parse(readFileSync(path.join(dir, 'xsolana.json'), 'utf8')) : null;
        let app = null;
        let command = String(move.command ?? '').trim();
        let at = dir;
        const inFolder = IN_FOLDER.exec(command);
        if (inFolder) {
          const folder = path.resolve(dir, inFolder[1].replace(/^.*\/project(\/|$)/, ''));
          if (folder.startsWith(dir) && existsSync(folder)) [at, command] = [folder, inFolder[2].trim()];
        }
        // `npm install && <start>`: the install first, then the command that starts the page.
        const installFirst = /^(npm\s+(?:install|i|ci)(?:\s+[@\w./-]+)*)\s*&&\s*(.+)$/.exec(command);
        if (installFirst && APP_COMMAND.test(installFirst[2].trim())) {
          await runSetup(installFirst[1], at, 300_000, home);
          command = installFirst[2].trim();
        }
        if (command && APP_COMMAND.test(command)) app = await startApp(command, at, home);
        const file = String(move.file || (/^https?:\/\//.test(command) ? command : 'index.html'));
        // A server started and the person named a page on it (`owner.html`, `/admin`): open that page, not the root.
        if (app?.url && move.file && !/^https?:\/\//.test(file) && !/^index\.html?$/.test(file)) app.url = new URL(file.replace(/^.*project\//, '').replace(/^\.?\/?/, '/'), app.url).href;
        if (!app?.url && /^https:\/\//.test(file)) app = { url: file, stop: () => {}, out: '' };
        // A local link works when something the agent started is still serving it; otherwise the person sees nothing.
        if (!app?.url && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(file)) {
          const up = await fetch(file, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500).catch(() => false);
          if (up) app = { url: file, stop: () => {}, out: '' };
        }
        if (!app?.url && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(file) && !APP_COMMAND.test(command)) {
          conversation.push({ from: 'system', text: `You opened ${file} in your browser. Nothing is running there: the page says it can't connect.` });
          continue;
        }
        // The command the agent gave crashed or never served: the person sees that, not a page.
        if (!app?.url && command && APP_COMMAND.test(command)) {
          conversation.push({ from: 'system', text: `You ran \`${command}\` to open the page, but no page came up. The terminal showed:\n${scrub(app?.out ?? '').slice(-1200) || '(nothing)'}` });
          app?.stop?.();
          continue;
        }
        if (!app?.url) {
          const s = await staticServer(at);
          // A local link the agent gave (its own server is not running here) keeps only its path.
          const rel = (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(file) ? new URL(file).pathname : file).replace(/^\.?\//, '').replace(/^.*project\//, '');
          app = { url: `${s.url}/${rel}`, stop: s.stop, out: app?.out ?? '' };
        }
        const log = path.join(where, asOwner ? `wallet-owner-page-${ownerPages.length + 1}.jsonl` : `wallet-player-${players.length + 1}.jsonl`);
        const tasks = asOwner ? [`You are the owner of this project, using your own wallet. ${String(move.message || 'Do what the page is for.').slice(0, 600)}`] : card.app;
        const p = await player({ url: app.url, tasks, owner: owner.address, note: asOwner ? '' : String(move.message ?? '').slice(0, 300), role: asOwner ? 'owner' : 'player', keyFile: asOwner ? path.join(keys, 'owner.key.json') : playerKey, log, game: spec?.live?.project ?? spec?.live?.game, grants: (spec?.grants ?? []).map((g) => g.id).filter(Number.isInteger), env: baseEnv, rpcUrl: RPC, cwd: work });
        app.stop();
        if (LIMIT.test(p.text)) throw new Error(`the player robot hit a usage limit: ${p.text.slice(0, 200)}`);
        const findings = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap((l) => JSON.parse(l).findings ?? []) : [];
        walletLogs.push({ role: asOwner ? 'owner' : 'player', findings });
        if (asOwner) {
          ownerPages.push(p);
          record(path.join(where, `owner-page-${ownerPages.length}.jsonl`), p.raw);
          conversation.push({ from: 'system', text: `You opened ${app.url} with your own wallet and did what it asked. What happened:\n${p.text.slice(0, 2000)}` });
          say(`${harness} ${card.id} owner used a page`);
          noteGame();
          continue;
        }
        players.push(p);
        record(path.join(where, `player-${players.length}.jsonl`), p.raw);
        conversation.push({ from: 'system', text: `A tester opened ${app.url} and tried it. Their report:\n${p.text.slice(0, 2500)}` });
        say(`${harness} ${card.id} player tried the app`);
        continue;
      }
      // A beat that says time has passed (`waitMinutes`) is made true first: the run waits that long on the real clock.
      const message = String(move.message ?? '');
      for (const b of card.beats ?? [])
        if (b.waitMinutes && !b.waited && message.toLowerCase().includes(String(b.say).toLowerCase().slice(0, 24))) {
          b.waited = true;
          say(`${harness} ${card.id} waits ${b.waitMinutes} minutes before the person says it`);
          await new Promise((r) => setTimeout(r, b.waitMinutes * 60_000));
        }
      await toBuilder(message);
    }
    record(path.join(where, 'conversation.json'), JSON.stringify(conversation, null, 2));
    const g = { harness, ended, player: playerWallet.address, ...grade({ card, dir, conversation, turns, approvals, players, ownerPages, walletLogs, playerAddress: playerWallet.address }) };
    record(path.join(where, 'grade.json'), JSON.stringify(g, null, 2));
    say(`${g.pass ? 'PASS' : g.secure ? 'MISTAKES' : 'SECURITY'} ${harness} ${card.id}: ${[...g.security.map((s) => s.code), ...g.mistakes.map((m) => m.code)].join(', ')}`);
    return g;
  } finally {
    if (!existsSync(path.join(where, 'conversation.json'))) record(path.join(where, 'conversation.json'), JSON.stringify(conversation, null, 2));
    // The pools' SOL back to the owner's test wallet first, so the sweep returns it to the funder.
    await reclaim(rpc, owner, dir, { keepLotteries: true }).then((n) => n && say(`${harness} ${card0.id} reclaimed ${n / 1e9} SOL from its pools`)).catch((e) => say(`${harness} ${card0.id} reclaim failed: ${e.message.slice(0, 200)}`));
    for (const w of [owner, playerWallet]) await sweep(rpc, w, funder.address).catch(() => {});
    // Servers the agent started in the project and left running stop with the run.
    stopWithin(work);
    cpSync(dir, path.join(where, 'project'), { recursive: true, filter: (f) => !/[\\/](node_modules|\.git|target|\.next|\.cache)([\\/]|$)/.test(f) });
    rmSync(keys, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

const queue = harnesses.flatMap((h) => cards.map((c) => [h, c]));
const results = [];
await Promise.all(
  Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const [h, c] = queue.shift();
      try {
        results.push(await one(h, c));
      } catch (e) {
        say(`ERROR ${h} ${c.id}: ${e.stack}`);
        results.push({ harness: h, card: c.id, pass: false, secure: null, error: e.message, security: [], mistakes: [] });
      }
    }
  }),
);
await registry.close();
if (sweeper) {
  clearInterval(sweeper.timer);
  // One last pass for what came due as the last runs ended (a raffle drawn after its run).
  await sweeper.pass().catch(() => {});
  await sweep(rpc, sweeper.payer, funder.address).catch(() => {});
}
if (resultsServer) {
  record(path.join(runDir, 'results-server.log'), resultsServer.log());
  stopGroup(resultsServer.child);
  rmSync(serverKeys, { recursive: true, force: true });
}

const by = (h) => results.filter((r) => r.harness === h);
const md = [
  `# Live evals, ${new Date().toISOString()}`,
  '',
  ...harnesses.map((h) => `- **${h}**: ${by(h).filter((r) => r.pass).length} of ${by(h).length} clean; ${by(h).filter((r) => r.secure === false).length} with a security finding; ${by(h).filter((r) => r.error).length} errored`),
  '',
  '| Harness | Card | Kind | Result | Security | Mistakes | Notes | Fidelity | App | Turns |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.harness} | ${r.card} | ${r.kind ?? ''} | ${r.error ? 'error' : r.pass ? 'clean' : r.secure ? 'mistakes' : 'SECURITY'} | ${r.security.map((s) => s.code).join(' ')} | ${r.mistakes.map((m) => m.code).join(' ')} | ${(r.notes ?? []).map((n) => n.split(':')[0]).join(' ')} | ${r.fidelity === null || r.fidelity === undefined ? '-' : `${Math.round(r.fidelity * 100)}%`} | ${r.appTasksOk === undefined ? '-' : `${Math.round(r.appTasksOk * 100)}%`} | ${r.turns ?? ''} |`),
  '',
  '## Findings',
  ...results.flatMap((r) => [...r.security.map((s) => `- **${r.harness} ${r.card}** ${s.code}: ${s.detail}`), ...r.mistakes.map((m) => `- ${r.harness} ${r.card} ${m.code}: ${m.detail}`), ...(r.notes ?? []).map((n) => `- ${r.harness} ${r.card} ${n}`)]),
];
record(path.join(runDir, 'summary.json'), JSON.stringify(results, null, 2));
record(path.join(runDir, 'summary.md'), `${md.join('\n')}\n`);
// Last, nothing recorded may hold the harness's RPC key: anything that does (a wallet log, a copied project) is scrubbed.
if (HIDE) {
  const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'npm-cache' || e.name === 'node_modules' || /\.db(-\w+)?$/.test(e.name) ? [] : e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of files(runDir)) {
    const text = readFileSync(f, 'utf8');
    if (scrub(text) !== text) {
      writeFileSync(f, scrub(text));
      say(`scrubbed the eval RPC from ${path.relative(runDir, f)}`);
    }
  }
}
// The npm cache the agents filled is most of a round's size (gigabytes) and is only a cache.
rmSync(path.join(runDir, 'npm-cache'), { recursive: true, force: true });
console.log(`${md.slice(0, 2 + harnesses.length).join('\n')}\nResults: ${path.relative(ROOT, runDir)}/summary.md`);
