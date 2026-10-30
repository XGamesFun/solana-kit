// `xsolana connect`: adds the xsolana MCP server and the xsolana-economy skill to the coding agents on this machine (Claude
// Code, Codex), through each agent's own commands. It never edits an agent's config file and never reads a
// credential. With `--local`, the server runs from this checkout (before the package is published); otherwise from npm.
// `--scope user` (the default) adds them for every project of this user; `--scope project`, for the project folder
// it runs in only.
import { exec, execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = 'xsolana';
const SKILL = 'xsolana-economy';

/** The scopes `xsolana connect` knows: every project of this user, or the one project folder it runs in. */
export const SCOPES = ['user', 'project'];

/**
 * The agents xsolana connect to, as data: a new agent is a row. `scopes`: where the agent can register an MCP server
 * from its command line. `skills(scope, cwd)`: the folder its skills are read from.
 */
export const AGENTS = {
  claude: {
    name: 'Claude Code',
    bin: 'claude',
    scopes: ['user', 'project'],
    add: (command, args, scope) => ['mcp', 'add', '--transport', 'stdio', '--scope', scope, NAME, '--', command, ...args],
    remove: (scope) => ['mcp', 'remove', '--scope', scope, NAME],
    get: ['mcp', 'get', NAME],
    skills: (scope, cwd) => (scope === 'project' ? path.join(cwd, '.claude', 'skills') : path.join(os.homedir(), '.claude', 'skills')),
    plugin: 'Or install the plugin: /plugin marketplace add XGamesFun/solana-kit, then /plugin install xsolana@xgamesfun.',
    next: 'Start a new Claude Code session (or /mcp) to load the xsolana tools.',
  },
  codex: {
    name: 'Codex',
    bin: 'codex',
    scopes: ['user'],
    add: (command, args) => ['mcp', 'add', NAME, '--', command, ...args],
    remove: () => ['mcp', 'remove', NAME],
    get: ['mcp', 'get', NAME],
    skills: (scope, cwd) => (scope === 'project' ? path.join(cwd, '.agents', 'skills') : path.join(os.homedir(), '.agents', 'skills')),
    plugin: 'Or install the plugin: codex plugin marketplace add XGamesFun/solana-kit, then codex plugin add xsolana@xgamesfun.',
    next: 'Start a new Codex session so it picks up the xsolana tools.',
  },
};

/** One word for cmd.exe: as it is when it is plain, else in double quotes (a quote inside doubled). */
const winWord = (a) => (/^[\w@+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

/**
 * Runs an agent's command and answers { code, out }. On Windows the agents are installed as .cmd shims, which only a
 * shell can start: there the command goes to cmd.exe as one line, each word quoted as it needs.
 */
export function runAgent(bin, args, { platform = process.platform, execFileImpl = execFile, execImpl = exec } = {}) {
  return new Promise((resolve) => {
    const done = (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    if (platform === 'win32') execImpl([bin, ...args].map(winWord).join(' '), { timeout: 60_000, windowsHide: true }, done);
    else execFileImpl(bin, args, { timeout: 60_000 }, done);
  });
}

/**
 * The command that starts the server: this checkout's (`local`), or the published package's. On Windows, npx is a
 * .cmd shim that an agent can only start through cmd.exe.
 */
export async function serverCommand({ local = false, platform = process.platform } = {}) {
  if (local) return { command: process.execPath, args: [path.join(ROOT, 'bin', 'xsolana.mjs'), 'mcp'] };
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const npx = ['-y', `--package=@xgamesfun/solana@${version}`, 'xsolana', 'mcp'];
  return platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...npx] } : { command: 'npx', args: npx };
}

/**
 * What is in a skill folder: 'none' (nothing there), 'ours' (xsolana's own skill: its SKILL.md names xsolana-economy in its
 * frontmatter, so it may be replaced or removed), or 'other' (anything else, which xsolana never touches).
 */
export async function skillFolder(dir) {
  try {
    await stat(dir);
  } catch {
    return 'none';
  }
  try {
    const text = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    return /^name:\s*["']?xsolana-economy["']?\s*$/m.test(front) ? 'ours' : 'other';
  } catch {
    return 'other';
  }
}

/** Connects (or with `remove`, disconnects) each agent found. Returns an exit code. */
export async function connect({ agent, local = false, remove = false, dryRun = false, scope = 'user', cwd = process.cwd(), log = (...a) => console.log(...a), run = runAgent } = {}) {
  if (!SCOPES.includes(scope)) {
    log(`No scope called “${scope}” (${SCOPES.join(', ')}).`);
    return 1;
  }
  if (agent && !AGENTS[agent]) {
    log(`No agent called “${agent}” (${Object.keys(AGENTS).join(', ')}).`);
    return 1;
  }
  const ids = agent ? [agent] : Object.keys(AGENTS);
  const { command, args } = await serverCommand({ local });
  let failed = 0;
  let found = 0;
  for (const id of ids) {
    const a = AGENTS[id];
    const version = await run(a.bin, ['--version']);
    if (version.code !== 0) {
      if (agent) log(`${a.name}: not found on this machine.`);
      continue;
    }
    found++;
    if (!a.scopes.includes(scope)) {
      log(`${a.name}: adds MCP servers only for the whole user (--scope ${a.scopes.join(' or ')}), so it was left as it is. Run \`xsolana connect --agent ${id}\` for that.`);
      if (agent) failed++;
      continue;
    }
    // Registered already (at some scope): taken out at this scope first. Before an add that may fail (it is at the
    // other scope); for --remove it is the whole point, so whether it worked is told.
    const steps = [];
    const had = await run(a.bin, a.get);
    if (had.code === 0) steps.push({ args: a.remove(scope), optional: true, removal: true });
    if (!remove) steps.push({ args: a.add(command, args, scope) });
    let ok = true;
    let removed = false;
    for (const { args: s, optional, removal } of steps) {
      if (dryRun) {
        log(`${a.bin} ${s.join(' ')}`);
        continue;
      }
      const r = await run(a.bin, s);
      if (removal && r.code === 0) removed = true;
      if (r.code !== 0 && !optional) {
        log(`${a.name}: ${a.bin} ${s.slice(0, 3).join(' ')} failed: ${r.out.split('\n').at(-1)}`);
        failed++;
        ok = false;
      }
    }

    // The skill: copied into the agent's skills folder for this scope. A folder of that name that is not xsolana's own
    // skill is never replaced or removed.
    const skills = a.skills(scope, cwd);
    const skillDir = path.join(skills, SKILL);
    const there = await skillFolder(skillDir);
    let skillSaid;
    if (there === 'other') {
      log(`${a.name}: ${skillDir} is there already and is not xsolana's ${SKILL} skill, so it was left as it is${remove ? '' : ' and the skill was not copied'}. Move it away, then run \`xsolana connect\` again.`);
      failed++;
      ok = false;
    } else if (remove) {
      if (dryRun) log(there === 'ours' ? `remove ${skillDir}` : `(no skill at ${skillDir} to remove)`);
      else if (there === 'ours') await rm(skillDir, { recursive: true, force: true });
      skillSaid = there === 'ours' ? `; the ${SKILL} skill removed from ${skillDir}` : '';
    } else {
      if (dryRun) log(`${there === 'ours' ? 'replace the xsolana skill at' : 'copy skills/xsolana-economy to'} ${skillDir}`);
      else {
        await mkdir(skills, { recursive: true });
        if (there === 'ours') await rm(skillDir, { recursive: true, force: true });
        await cp(path.join(ROOT, 'skills', SKILL), skillDir, { recursive: true });
      }
      skillSaid = ` and the ${SKILL} skill copied to ${skillDir}`;
    }
    if (dryRun) continue;
    if (remove) {
      // Registered, but not at this scope: it is still there, and the person asked for it gone.
      const stays = had.code === 0 && !removed;
      if (stays) failed++;
      const server = removed ? 'xsolana removed' : stays ? `xsolana’s server was not found at the ${scope} scope, so it was left where it is (\`${a.bin} mcp get ${NAME}\` shows where)` : 'xsolana’s server was not registered';
      log(`${a.name}: ${server}${skillSaid ?? ''}.`);
    } else if (ok) {
      log(`${a.name}: xsolana tools added (${local ? 'from this checkout' : 'from npm'}, ${scope === 'project' ? `for ${cwd} only` : 'for every project'})${skillSaid}. ${a.next}`);
      log(`  ${a.plugin}`);
    }
  }
  if (!found) {
    log('No coding agent found (Claude Code: npm install -g @anthropic-ai/claude-code; Codex: npm install -g @openai/codex).');
    return 1;
  }
  return failed ? 1 : 0;
}
