#!/usr/bin/env node
// Fresh-session evals: each prompt goes to a new, non-interactive Claude Code or Codex session in an empty project
// folder that has only the xsolana plugin's pieces (the xsolana MCP server and the xsolana-economy skill), with none of the
// person's own MCP servers, plugins or settings. What each session did and left behind is kept and scored.
//
//   node evals/run.mjs [--harness claude|codex|both] [--only id,id] [--limit n] [--parallel n] [--server local|npm]
//                      [--model <name>] [--effort <level>] [--timeout <minutes>] [--prompts <file>] [--split <name>]
//
// --prompts reads another prompt file (evals/composition-prompts.json: prompts from real economies, with notes for
// evals/judge.mjs); --split keeps only the prompts of that split. --effort is Codex's reasoning effort.
//
// --server local (the default) runs the MCP server from this checkout, so it works before the package is published;
// npm runs the published @xgamesfun/solana. Results go to evals/results/<time>/: per run its transcript, its project
// folder and its score, then summary.json and summary.md. Sessions use the person's own login for each agent.
//
// Safety: a session may edit files and run commands, inside its own temporary project folder only (Codex: the
// workspace-write sandbox; Claude Code: permission mode acceptEdits with Bash limited to node, npm, npx and ls). If
// Codex's sandbox can't start on this machine (every command fails), set XSOLANA_EVAL_CODEX_SANDBOX=danger-full-access:
// each session works in a throwaway temp folder, removed after its project is copied out.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from './score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const harnesses = (opt('harness', 'both') === 'both' ? ['claude', 'codex'] : [opt('harness')]).filter(Boolean);
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const limit = Number(opt('limit', Infinity));
const parallel = Number(opt('parallel', 2));
const serverMode = opt('server', 'local');
const model = opt('model');
const timeoutMs = Number(opt('timeout', 15)) * 60_000;
const effort = opt('effort');
const split = opt('split');
const promptFile = path.resolve(opt('prompts', path.join(ROOT, 'evals/prompts.json')));

const { prompts: all } = JSON.parse(readFileSync(promptFile, 'utf8'));
const prompts = all.filter((p) => (!only || only.has(p.id)) && (!split || p.split === split)).slice(0, limit);
const runDir = path.join(ROOT, 'evals/results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(runDir, { recursive: true });

// npm mode runs the published package of this checkout's exact version, never whatever is latest under the name.
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const server = serverMode === 'npm' ? { command: 'npx', args: ['-y', `--package=@xgamesfun/solana@${version}`, 'xsolana', 'mcp'] } : { command: process.execPath, args: [path.join(ROOT, 'bin/xsolana.mjs'), 'mcp'] };

/** An empty project folder with the plugin's skill where the harness reads project skills. */
function project(harness, id) {
  const dir = path.join(tmpdir(), `xsolana-eval-${harness}-${id}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const skills = harness === 'claude' ? '.claude/skills' : '.agents/skills';
  cpSync(path.join(ROOT, 'skills'), path.join(dir, skills), { recursive: true });
  return dir;
}

function claudeRun(prompt, dir) {
  const mcp = path.join(dir, '.xsolana-mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { loot: { type: 'stdio', command: server.command, args: server.args } } }));
  const a = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', 'project', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__xsolana__*', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(ls:*)'];
  if (model) a.push('--model', model);
  return { bin: 'claude', args: a };
}

function codexRun(prompt, dir) {
  const toml = (v) => JSON.stringify(v);
  // As in the live evals: the account's own apps and plugins stay off, and the sandbox mode can be chosen
  // (bubblewrap can't start where unprivileged user namespaces are blocked; then every command fails).
  const sandbox = process.env.XSOLANA_EVAL_CODEX_SANDBOX || 'workspace-write';
  const a = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-C', dir, '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin', '-s', sandbox, '-c', 'approval_policy="never"', '-c', `mcp_servers.xsolana.command=${toml(server.command)}`, '-c', `mcp_servers.xsolana.args=${toml(server.args)}`];
  if (model) a.push('-m', model);
  if (effort) a.push('-c', `model_reasoning_effort=${toml(effort)}`);
  a.push(prompt);
  return { bin: 'codex', args: a };
}

// The sessions never see the live evals' own settings (the funder's key file, the harness's RPC URL).
const { XSOLANA_EVAL_FUNDER: _funder, XSOLANA_EVAL_RPC_URL: _evalRpc, ...sessionEnv } = process.env;

function exec({ bin, args: a }, cwd) {
  return new Promise((resolve) => {
    const child = spawn(bin, a, { cwd, env: sessionEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

async function one(harness, p) {
  const dir = project(harness, p.id);
  const started = Date.now();
  const r = await exec(harness === 'claude' ? claudeRun(p.prompt, dir) : codexRun(p.prompt, dir), dir);
  const where = path.join(runDir, harness, p.id);
  mkdirSync(where, { recursive: true });
  writeFileSync(path.join(where, 'transcript.jsonl'), r.out);
  if (r.err) writeFileSync(path.join(where, 'stderr.txt'), r.err);
  cpSync(dir, path.join(where, 'project'), { recursive: true, filter: (src) => !/node_modules|\.claude\/skills|\.agents\/skills/.test(src) });
  const s = { harness, ...score(p, dir, r.out), exit: r.code, seconds: Math.round((Date.now() - started) / 1000) };
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(path.join(where, 'score.json'), JSON.stringify(s, null, 2));
  console.error(`${s.pass ? 'PASS' : 'FAIL'} ${harness} ${p.id}${s.failed.length ? ` (${s.failed.join(', ')})` : ''} ${s.seconds}s`);
  return s;
}

const queue = harnesses.flatMap((h) => prompts.map((p) => [h, p]));
const results = [];
await Promise.all(
  Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const [h, p] = queue.shift();
      try {
        results.push(await one(h, p));
      } catch (e) {
        // One run that broke (a full disk, an unreadable project) is recorded as failed; the round goes on.
        console.error(`ERROR ${h} ${p.id}: ${e.stack}`);
        results.push({ harness: h, id: p.id, expect: p.expect, pass: false, failed: ['error'], tools: [], spec: null, error: e.message });
      }
    }
  }),
);

const by = (h) => results.filter((r) => r.harness === h);
const summary = {
  at: new Date().toISOString(),
  server: serverMode,
  model: model ?? 'default',
  effort: effort ?? 'default',
  prompts: path.relative(ROOT, promptFile),
  harnesses: Object.fromEntries(harnesses.map((h) => [h, { runs: by(h).length, pass: by(h).filter((r) => r.pass).length, failedChecks: Object.entries(by(h).flatMap((r) => r.failed).reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})) }])),
  results: results.map(({ files, ...r }) => r),
};
writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
const md = [
  `# Fresh-session evals, ${summary.at}`,
  '',
  `Server: ${serverMode}. Model: ${summary.model}.`,
  '',
  ...harnesses.map((h) => `- **${h}**: ${summary.harnesses[h].pass} of ${summary.harnesses[h].runs} pass${summary.harnesses[h].failedChecks.length ? `; failed checks: ${summary.harnesses[h].failedChecks.map(([k, n]) => `${k} ×${n}`).join(', ')}` : ''}`),
  '',
  '| Harness | Prompt | Expect | Pass | Failed | xsolana tools | Spec |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.harness} | ${r.id} | ${r.expect} | ${r.pass ? 'yes' : 'no'} | ${r.failed.join(', ')} | ${[...new Set(r.tools)].join(' ')} | ${r.spec ? (r.spec.ok ? 'checks' : r.spec.refusals.join(' ')) : '-'} |`),
];
writeFileSync(path.join(runDir, 'summary.md'), `${md.join('\n')}\n`);
console.log(`\n${md.slice(0, 5 + harnesses.length).join('\n')}\nResults: ${path.relative(ROOT, runDir)}/summary.md`);
if (!existsSync(runDir)) process.exit(1);
