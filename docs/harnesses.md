# Delivering xsolana to coding agents

xsolana reaches an agent as two pieces:

- the **MCP server** (`xsolana_*` tools, from `@xgamesfun/solana`);
- the **xsolana-economy skill**, which says when to use loot, the loop to follow, and what to tell the person.

The `plugin/` folder carries both, in each harness's own format, from one source.

|                           | Claude Code                                                                                                                                                                                   | Codex                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest                  | `plugin/.claude-plugin/plugin.json`                                                                                                                                                           | `plugin/plugin.json` (the portable format, `agent-plugins.org` schema 1.0.0)                                                                       |
| MCP server                | `plugin/.mcp.json`                                                                                                                                                                            | `plugin/mcp.json` (`"type": "stdio"`)                                                                                                              |
| Skill                     | `plugin/skills/xsolana-economy/`                                                                                                                                                              | the same folder                                                                                                                                    |
| Marketplace               | `.claude-plugin/marketplace.json`                                                                                                                                                             | `.agents/plugins/marketplace.json`                                                                                                                 |
| Install                   | `/plugin marketplace add XGamesFun/solana-kit`, `/plugin install xsolana@xgamesfun`                                                                                                           | `codex plugin marketplace add XGamesFun/solana-kit`, `codex plugin add xsolana@xgamesfun`                                                          |
| Without the plugin        | `npx -y @xgamesfun/solana@0.29.12 connect` (runs `claude mcp add --scope project`, copies the skill to `.claude/skills` in this folder; `--scope user` for every project, `~/.claude/skills`) | `npx -y @xgamesfun/solana@0.29.12 connect --scope user` (`codex mcp add`, `~/.agents/skills`): Codex registers MCP servers only for the whole user |
| Instructions in this repo | `CLAUDE.md` → `AGENTS.md`                                                                                                                                                                     | `AGENTS.md`                                                                                                                                        |

Both marketplace files name the marketplace `xgamesfun`, so the plugin is `xsolana@xgamesfun` whichever repository
serves it. Both MCP configs start the server with `npx -y --package=@xgamesfun/solana@<version> xsolana mcp`. The
version is pinned to the plugin's own version, so a plugin and its server never disagree.

The skill follows the Agent Skills standard (front matter `name` and `description` only), which both harnesses read.
Its text names no harness. `xsolana connect` supports Claude Code and Codex only. It connects the project folder it
runs in by default, as `xcore connect` does; `--scope user` connects every project of this user. From a checkout,
`node bin/xsolana.mjs connect --local` registers that checkout's server instead of the published package.

## Other agents and chat apps

- **Any agent that reads skills**: `npx skills add XGamesFun/solana-kit` (the `skills` CLI) finds the one skill and
  installs it for each agent it finds. It skips the copies in `plugin/`, `.claude/` and `.agents/`.
- **Apps that take a skill as an upload**: the release job `skill-zip` attaches `xsolana-economy.zip`. The zip is
  built by `scripts/skill-zip.mjs`. It holds the skill folder with `SKILL.md` at its top, and the same files always
  give the same bytes.
- **Chat apps that add an MCP server by URL** (claude.ai, ChatGPT, Claude Desktop): `js/mcp/http.mjs` is the server
  over Streamable HTTP. It sends one JSON answer per request and keeps no session. It runs the stdio server's handler
  in remote mode, which has:
  - only `REMOTE_TOOLS`, the tools that read nothing but their arguments and the chain;
  - no `file` argument;
  - instructions that give the spec as a file, and the `keygen` and `approve --keypair` commands instead of
    `xsolana_save` and `xsolana_publish`.

  A host mounts `mcpHttp` (exported as `@xgamesfun/solana/mcp/http`). `xsolana mcp --http` serves it on 127.0.0.1 and
  answers only pages on localhost. xgames.fun hosts it at `https://xgames.fun/mcp`, which `server.json` names under
  `remotes`.

## The edition Anthropic's directory lists

Anthropic's directory (claude.ai/directory) accepts a plugin whose MCP server runs on the user's machine only from an
organization it has verified. Until then, `claude-directory/` is the edition it lists. That edition has the same
skill. In place of the local server, it connects to the hosted one (`.mcp.json`: `https://xgames.fun/mcp`, the eleven
read-only tools). It carries no Codex files. Its manifest has only the fields Claude Code reads and the listing's own
fields (the icon and the four links). For an organization it has not verified, the directory's portal refuses any
other field, `network` included. In the portal, the plugin's path is `claude-directory`. `plugin/` stays what this
repository's own marketplace installs.

The edition changes only when it is submitted again, because each version of it is reviewed before it is listed. A
release leaves it at the version its manifest names, with the skill of that release, which keeps working.
`sync-skills` copies the skill into it only while that manifest names `package.json`'s version. To move it to a new
version:

1. Set that version in its manifest and in its README's pins.
2. Run `npm run sync-skills`.
3. Validate it in the portal again.

Its tools are the hosted server's, so they change with xgames.fun, whatever the edition's version.

## Releasing a version

[RELEASING.md](https://github.com/XGamesFun/solana-kit/blob/main/RELEASING.md) has the steps: what to keep in step, publishing, and checking both harnesses.

## Fresh-session evals

`node evals/run.mjs` gives each prompt in `evals/prompts.json` to a new `claude -p` session and a new `codex exec`
session. Each session runs in an empty folder that holds only the skill and the xsolana MCP server. The script then
scores what each session did. `evals/README.md` has the details.
