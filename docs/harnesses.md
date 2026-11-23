# Delivering xsolana to coding agents

xsolana reaches an agent as two pieces: the **MCP server** (`xsolana_*` tools, from `@xgamesfun/solana`) and the
**xsolana-economy skill** (when to use loot, the loop, what to tell the person). The `plugin/` folder carries both, in
each harness's own format, from one source.

|                           | Claude Code                                                                                                | Codex                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Manifest                  | `plugin/.claude-plugin/plugin.json`                                                                        | `plugin/plugin.json` (the portable format, `agent-plugins.org` schema 1.0.0)              |
| MCP server                | `plugin/.mcp.json`                                                                                         | `plugin/mcp.json` (`"type": "stdio"`)                                                     |
| Skill                     | `plugin/skills/xsolana-economy/`                                                                           | the same folder                                                                           |
| Marketplace               | `.claude-plugin/marketplace.json`                                                                          | `.agents/plugins/marketplace.json`                                                        |
| Install                   | `/plugin marketplace add XGamesFun/solana-kit`, `/plugin install xsolana@xgamesfun`                        | `codex plugin marketplace add XGamesFun/solana-kit`, `codex plugin add xsolana@xgamesfun` |
| Without the plugin        | `npx -y @xgamesfun/solana@0.29.11 connect` (runs `claude mcp add`, copies the skill to `~/.claude/skills`) | the same (`codex mcp add`, `~/.agents/skills`)                                            |
| Instructions in this repo | `CLAUDE.md` → `AGENTS.md`                                                                                  | `AGENTS.md`                                                                               |

The marketplace is named `xgamesfun` in both marketplace files, so the plugin is `xsolana@xgamesfun` whichever
repository serves it. Both MCP configs start the server with `npx -y --package=@xgamesfun/solana@<version> xsolana mcp`,
pinned to the plugin's own version, so a plugin and its server never disagree.

The skill follows the Agent Skills standard (front matter `name` and `description` only), which both harnesses read;
its text names no harness. `xsolana connect` knows Claude Code and Codex only. From a checkout,
`node bin/xsolana.mjs connect --local` registers that checkout's server instead of the published package.

## Other agents and chat apps

- **Any agent that reads skills**: `npx skills add XGamesFun/solana-kit` (the `skills` CLI) finds the one skill (it
  skips the copies in `plugin/`, `.claude/` and `.agents/`) and installs it for each agent it finds.
- **Apps that take a skill as an upload**: the release job `skill-zip` attaches `xsolana-economy.zip`
  (`scripts/skill-zip.mjs`: the folder with `SKILL.md` at its top, the same bytes for the same files).
- **Chat apps that add an MCP server by URL** (claude.ai, ChatGPT, Claude Desktop): `js/mcp/http.mjs` is the server
  over Streamable HTTP, one JSON answer a request, no session. It runs the stdio server's handler in remote mode: only
  `REMOTE_TOOLS` (the tools that read nothing but their arguments and the chain), no `file` argument, and instructions
  that give the spec as a file and the `keygen` and `approve --keypair` commands instead of `xsolana_save` and `xsolana_publish`. A host
  mounts `mcpHttp` (exported as `@xgamesfun/solana/mcp/http`); `xsolana mcp --http` serves it on 127.0.0.1, answering
  only pages on localhost. xgames.fun hosts it at `https://xgames.fun/mcp`, which `server.json` names under `remotes`.

## The edition Anthropic's directory lists

Anthropic's directory (claude.ai/directory) takes a plugin whose MCP server runs on the user's machine only from an
organization it has verified. `claude-directory/` is the edition it lists until then: the same skill, and in place of
the local server a connection to the hosted one (`.mcp.json`: `https://xgames.fun/mcp`, the eleven read-only tools).
It carries no Codex files, and its manifest has only the fields Claude Code reads and the listing's own (the icon and
the four links): from an organization it has not verified, the directory's portal refuses any other, `network`
included. In the portal the plugin's path is `claude-directory`; `plugin/` stays what this repository's own
marketplace installs.

The edition moves only when it is submitted again, since each version of it is reviewed before it is listed: a release
leaves it at the version its manifest names (the skill of that release, which keeps working), and `sync-skills` copies
the skill into it only while that manifest names `package.json`'s version. To move it, set that version in its manifest
and its README's pins, run `npm run sync-skills`, then validate it in the portal again. Its tools are the hosted
server's, so they move with xgames.fun whatever its version.

## Releasing a version

[RELEASING.md](../RELEASING.md) has the steps: what to keep in step, publishing, and checking both harnesses.

## Fresh-session evals

`node evals/run.mjs` gives each prompt in `evals/prompts.json` to a new `claude -p` and `codex exec` session in an
empty folder holding only the skill and the xsolana MCP server, and scores what it did. `evals/README.md` has the rest.
