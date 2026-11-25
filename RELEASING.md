# Releasing a version

Keep these in step:

- `version` in `package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/plugin.json` and `server.json` (twice: the
  server's and its npm package's; `npm test` fails when they differ), and in `claude-directory/.claude-plugin/plugin.json`
  only when that edition is submitted again ([docs/harnesses.md](docs/harnesses.md));
- the `--package=@xgamesfun/solana@<version>` pin in `plugin/.mcp.json` and `plugin/mcp.json`, and every
  `npx -y @xgamesfun/solana@<version>` line in `README.md`, `docs/` and the skill (`npm test` fails on a pin
  that isn't `package.json`'s version; in `claude-directory/README.md`, on one that isn't its manifest's);
- `release.json`, the program build this package is for: its `version` is the program's (the IDL's), not the package's,
  so a release that changes only JavaScript leaves it as it is. `node scripts/release-manifest.mjs` writes it, after a
  program build and `node scripts/sync-idl.mjs`, and again after any change to `js/client` or `js/chain` (it holds their
  hash);
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
