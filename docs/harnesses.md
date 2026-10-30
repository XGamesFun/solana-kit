# Delivering xsolana to coding agents

xsolana reaches an agent as two pieces: the **MCP server** (`xsolana_*` tools, from `@xgamesfun/solana`) and the
**xsolana-economy skill** (when to use loot, the loop, what to tell the person). The `plugin/` folder carries both, in
each harness's own format, from one source.

| | Claude Code | Codex |
| --- | --- | --- |
| Manifest | `plugin/.claude-plugin/plugin.json` | `plugin/plugin.json` (the portable format, `agent-plugins.org` schema 1.0.0) |
| MCP server | `plugin/.mcp.json` | `plugin/mcp.json` (`"type": "stdio"`) |
| Skill | `plugin/skills/xsolana-economy/` | the same folder |
| Marketplace | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` |
| Install | `/plugin marketplace add XGamesFun/solana-kit`, `/plugin install xsolana@xgamesfun` | `codex plugin marketplace add XGamesFun/solana-kit`, `codex plugin add xsolana@xgamesfun` |
| Without the plugin | `npx -y @xgamesfun/solana@0.20.1 connect` (runs `claude mcp add`, copies the skill to `~/.claude/skills`) | the same (`codex mcp add`, `~/.agents/skills`) |
| Instructions in this repo | `CLAUDE.md` → `AGENTS.md` | `AGENTS.md` |

The marketplace is named `xgamesfun` in both marketplace files, so the plugin is `xsolana@xgamesfun` whichever
repository serves it. Both MCP configs start the server with `npx -y --package=@xgamesfun/solana@<version> xsolana mcp`,
pinned to the plugin's own version, so a plugin and its server never disagree.

The skill follows the Agent Skills standard (front matter `name` and `description` only), which both harnesses read;
its text names no harness. `xsolana connect` knows Claude Code and Codex only. From a checkout,
`node bin/xsolana.mjs connect --local` registers that checkout's server instead of the published package.

## Releasing a version

Keep these in step:

- `version` in `package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/plugin.json`, `release.json` and
  `server.json` (twice: the server's and its npm package's; `npm test` fails when they differ);
- the `--package=@xgamesfun/solana@<version>` pin in `plugin/.mcp.json` and `plugin/mcp.json`, and every
  `npx -y @xgamesfun/solana@<version>` line in `README.md`, this file and the skill (`npm test` fails on a pin that
  isn't `package.json`'s version);
- `release.json` (`node scripts/release-manifest.mjs`, after a program build and `node scripts/sync-idl.mjs`);
- the skill's copies (`node scripts/sync-skills.mjs` after editing `skills/`).

`npm run check` runs the pin and version tests, `release.json`'s check, the fixtures' check and the skill copies' check.

Publishing a GitHub release runs `.github/workflows/publish.yml`: the checks, then `npm publish` with provenance (the
release's tag must be the package's version). The first publish uses an npm token (the `NPM_TOKEN` secret); after it,
add the workflow as the package's trusted publisher on npmjs.com and delete the token, and npm publishes over OIDC.
Then `.github/workflows/mcp-registry.yml` lists the version in the MCP Registry from `server.json`, once npm serves it
(a new package can take minutes): `mcp-publisher` (pinned, its signature verified) signs in with the workflow's own
GitHub identity, so the namespace `io.github.XGamesFun` works only from a repository the `XGamesFun` account owns. It
can also be run by hand from the Actions tab, and a publish run that failed after npm can be run again: it skips a
version npm has already. Actions are pinned to commit hashes, and Dependabot moves them.

Then check both harnesses still load the plugin: `claude plugin validate ./plugin` and `claude plugin validate .`;
and for Codex, in a scratch `CODEX_HOME`, `codex plugin marketplace add ./`, `codex plugin add xsolana@xgamesfun`,
then `codex mcp list` shows the `xsolana` stdio server.

## Fresh-session evals

`node evals/run.mjs` gives each prompt in `evals/prompts.json` to a new `claude -p` and `codex exec` session in an
empty folder holding only the skill and the xsolana MCP server, and scores what it did. `evals/README.md` has the rest.
