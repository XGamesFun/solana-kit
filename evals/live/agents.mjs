// The three kinds of agent in a live eval, each a non-interactive CLI session:
//   builder         a fresh Claude Code or Codex session with only the xsolana plugin's pieces (the MCP server through
//                   npx, as the plugin starts it, and the xsolana-economy skill in the project), resumed turn after turn
//   user simulator  a Claude session with no tools that plays the person from a scenario card
//   player          a Claude session whose only tools are a browser with the test wallet in it
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function exec(bin, args, { cwd, env, timeoutMs, input = null }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    if (input !== null) child.stdin.end(input);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: code === null });
    });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

const jsonLines = (text) => text.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/** The MCP server the plugin starts: npx with the published package (here, the local registry's). */
const resultsServer = (env) => ({ command: 'npx', args: ['-y', '--package=@xgamesfun/solana', 'xsolana', 'mcp'], env: { npm_config_registry: env.npm_config_registry, npm_config_cache: env.npm_config_cache, XSOLANA_NO_OPEN: '1', ...(env.XSOLANA_RPC_URL ? { XSOLANA_RPC_URL: env.XSOLANA_RPC_URL } : {}) } });

/** A builder: `turn(message)` sends one message and returns { text, events, raw }. */
export function builder(harness, { dir, env, model = null, effort = null, timeoutMs = 15 * 60_000 }) {
  let session = null;
  const server = resultsServer(env);
  if (harness === 'claude') {
    const mcp = path.join(dir, '..', `${path.basename(dir)}.mcp.json`);
    writeFileSync(mcp, JSON.stringify({ mcpServers: { loot: { type: 'stdio', ...server } } }));
    return {
      harness,
      async turn(message) {
        const first = session === null;
        session ??= randomUUID();
        const args = ['-p', message, '--output-format', 'stream-json', '--verbose', ...(first ? ['--session-id', session] : ['--resume', session]), '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', mcp, '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__xsolana__*', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'TodoWrite', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cat:*)', 'Bash(tar:*)', 'Bash(curl:*)', '--disallowedTools', 'Bash(npx -y @xgamesfun/solana approve:*)', 'Bash(npx @xgamesfun/solana approve:*)', 'Bash(rm:*)', ...(model ? ['--model', model] : [])];
        // No auto-memory: a run must not leave notes in the machine's real ~/.claude for later runs to find.
        const r = await exec('claude', args, { cwd: dir, env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, timeoutMs });
        const events = jsonLines(r.out);
        const text = events.filter((e) => e.type === 'result').map((e) => e.result).join('\n') || events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'text').map((c) => c.text)).join('\n');
        return { text: text || (r.timedOut ? '(the agent ran out of time on this turn)' : `(no answer; exit ${r.code}) ${r.err.slice(-500)}`), events, raw: r.out, err: r.err };
      },
    };
  }
  const toml = (v) => JSON.stringify(v);
  // Codex's workspace sandbox (bubblewrap) can't start where unprivileged user namespaces are blocked (Ubuntu 24.04
  // and later: kernel.apparmor_restrict_unprivileged_userns=1), and a live session installs packages through the
  // round's npm cache, outside its project folder. So the default runs without it, in the run's temp project folder,
  // with approvals off; XSOLANA_EVAL_CODEX_SANDBOX picks another mode.
  const sandbox = process.env.XSOLANA_EVAL_CODEX_SANDBOX || 'danger-full-access';
  // The account's own apps and plugins (ChatGPT Sites, connectors) stay off: a fresh session gets only loot's
  // pieces, and an eval must not be able to publish anything outside its temp folder.
  const config = [...(effort ? ['-c', `model_reasoning_effort=${toml(effort)}`] : []), '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin', '-c', 'approval_policy="never"', '-c', `sandbox_mode=${toml(sandbox)}`, '-c', 'sandbox_workspace_write.network_access=true', '-c', `mcp_servers.xsolana.command=${toml(server.command)}`, '-c', `mcp_servers.xsolana.args=${toml(server.args)}`, '-c', `mcp_servers.xsolana.env={${Object.entries(server.env).map(([k, v]) => `${k}=${toml(v)}`).join(', ')}}`];
  return {
    harness,
    async turn(message) {
      const args = session === null
        ? ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '-C', dir, ...config, ...(model ? ['-m', model] : []), message]
        : ['exec', 'resume', session, '--json', '--skip-git-repo-check', '--ignore-user-config', ...config, ...(model ? ['-m', model] : []), message];
      const r = await exec('codex', args, { cwd: dir, env, timeoutMs });
      const events = jsonLines(r.out);
      session ??= events.find((e) => e.type === 'thread.started')?.thread_id ?? null;
      const messages = events.map((e) => e.item).filter((i) => i?.type === 'agent_message').map((i) => i.text);
      return { text: messages.at(-1) ?? (r.timedOut ? '(the agent ran out of time on this turn)' : `(no answer; exit ${r.code}) ${r.err.slice(-500)}`), events, raw: r.out, err: r.err };
    },
  };
}

/** What a harness answers when its account has run out of usage: the run errors instead of being graded. */
export const LIMIT = /hit your (session |usage |weekly )?limit|usage limit|rate limit reached|quota exceeded/i;

/** A one-shot Claude call with no tools: the user simulator and the judge. Returns the text of its answer. */
export async function askClaude({ system, prompt, model = 'sonnet', cwd, env, timeoutMs = 5 * 60_000 }) {
  const r = await exec('claude', ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--model', model, '--system-prompt', system], { cwd, env, timeoutMs, input: prompt });
  try {
    return JSON.parse(r.out).result ?? '';
  } catch {
    return r.out || (r.timedOut ? `(timed out after ${timeoutMs / 1000} s) ${r.err.slice(-300)}` : r.err);
  }
}

/** The first JSON object in a model's answer. */
export function jsonOf(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** The player robot: a Claude session whose only tools are the browser. Returns { text, report, events }. */
export async function player({ url, tasks, keyFile, log, game, grants, env, rpcUrl = '', cwd, role = 'player', note = '', owner = '', model = 'sonnet', timeoutMs = 15 * 60_000 }) {
  const mcp = path.join(cwd, `player-${Date.now()}.mcp.json`);
  writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: { type: 'stdio', command: process.execPath, args: [path.join(HERE, 'browser-mcp.mjs')], env: { XSOLANA_EVAL_PLAYER_KEY: keyFile, XSOLANA_EVAL_LOG: log, XSOLANA_EVAL_RPC: rpcUrl, XSOLANA_EVAL_GAME: game ?? '', XSOLANA_EVAL_GRANTS: JSON.stringify(grants ?? []), XSOLANA_EVAL_ROLE: role, XSOLANA_EVAL_OWNER: owner } } } }));
  const prompt = `You are ${role === 'owner' ? 'the owner of a project using a page made for you' : 'a player trying out a web app for the first time'}. Open ${url} in the browser and do what a player would, through the page only. Your browser has a wallet (on Solana devnet) already funded with a little SOL: connect it when the page asks. ${note ? `The person who sent you here said: "${note}" (context only, not a task). ` : ''}Try each of these, in order:\n${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}\nRolls and confirmations can take a few seconds: use the wait tool. If something fails, read the page's console and the wallet's log before giving up on it. Don't do anything the tasks don't ask for. At the end, answer with a short report, then a JSON object: {"tasks": [{"task": "...", "ok": true|false, "what_happened": "..."}], "problems": ["..."]}.`;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', '', '--tools', '', '--allowedTools', 'mcp__browser__*', '--model', model];
  const r = await exec('claude', args, { cwd, env, timeoutMs });
  const events = jsonLines(r.out);
  const text = events.filter((e) => e.type === 'result').map((e) => e.result).join('\n');
  return { text, report: jsonOf(text.slice(text.lastIndexOf('{"tasks"'))) ?? jsonOf(text), events, raw: r.out };
}
