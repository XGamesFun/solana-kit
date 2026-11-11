# Contributing

Issues and pull requests are welcome. [AGENTS.md](AGENTS.md) has the rules for working in this repository, for
people and coding agents alike; this page is the short version.

## Setting up

Node 22 or later.

```bash
npm ci
npm run fixtures   # once: the loot program and the programs it calls, each checked against its pinned hash
npm run check      # fixtures, skill copies and release.json in step, lint, then the tests
npm run format     # Prettier, before you commit (npm run lint checks it)
```

Nothing in the tests deploys or spends SOL: they run the real program in LiteSVM. They send every instruction the
client builds, and every example's whole setup.

To try the tools in your own agent from a clone, `node bin/xsolana.mjs connect --local` registers this checkout's MCP
server and the skill with Claude Code and Codex (`--remove` takes them out again).

| Variable              | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `XSOLANA_RPC_URL`     | a devnet RPC of your own for `xsolana approve` and `xsolana status` (a mainnet URL is refused) |
| `XSOLANA_NO_OPEN`     | `xsolana approve --browser` prints its link without opening a browser                          |
| `XSOLANA_DEBUG`       | the CLI prints a failure's whole stack, not one line                                           |
| `XSOLANA_PROGRAM_DIR` | the tests run that program build's `target/deploy/loot.so`, and check the IDL against it       |

## Layout

| Path                                    | What                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `js/chain/`                             | browser-safe Solana primitives, no SDK                                                                 |
| `js/client/`                            | the client; `idl/` is the program's IDL                                                                |
| `js/economy/`                           | the economy spec (version 2, `schema.json`), checker, simulation, setup plan, cost, explainer, guide   |
| `js/play/`, `js/results/`               | a player's side of a live economy (and a sponsor's checks); results a server vouches for               |
| `js/approve/`, `js/mcp/`, `js/connect/` | going live (a key file, or the page), the MCP server (stdio and HTTP) and its tools, `xsolana connect` |
| `js/sim/`, `js/test/`                   | LiteSVM running the real program; the tests and their pinned fixtures                                  |
| `bin/xsolana.mjs`                       | the CLI                                                                                                |
| `skills/`, `plugin/`                    | the skill (copied to `plugin/skills`, `.claude/skills`, `.agents/skills`) and the plugin               |
| `scripts/`                              | fixtures, skill sync and zip, IDL sync, release manifest, a devnet end-to-end run                      |
| `release.json`                          | the program binary, IDL and client hashes this version is pinned to                                    |
| `evals/`                                | fresh-session evals of agents building on loot ([evals/README.md](evals/README.md))                    |

## Sending a change

- Run `npm run check` before you send it. CI runs the same on Node 22 and 24.
- Add or change a test with the code: a client builder, an example or a checker rule is tested against the real
  program.
- After editing `skills/`, run `npm run sync-skills`.
- Changes to tool texts, the skill or the plugin are best measured with the evals before and after
  ([evals/README.md](evals/README.md)). Write general rules, never a fix that names one scenario or product.
- Plain ES modules, no build step. `js/chain`, `js/client`, `js/play` and `js/results` stay browser-safe: lint refuses
  a `node:` import, `Buffer`, `process` or `require` there.
- Formatting is Prettier's (`.prettierrc.json`, the same settings as xcore's): `npm run format`, and your editor can
  follow `.editorconfig`. The code was reformatted in one commit; `git config blame.ignoreRevsFile
.git-blame-ignore-revs` makes `git blame` look past it (GitHub does on its own).

## Rules that don't bend

- Nothing signs with a person's key, and no tool asks for one.
- Devnet only: nothing sends to mainnet until the program is independently audited.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, and never in a public issue.
