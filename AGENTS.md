# Working in this repository

This repository is **solana-kit**, the npm package `@xgamesfun/solana`: the tools for loot, one shared Solana program for
game and community economies. It holds loot's JavaScript client and economy tools (`js/`), the MCP server and CLI
(`js/mcp`, `bin/xsolana.mjs`), the skill (`skills/xsolana-economy`) and the plugin that carries both to Claude Code and Codex
(`plugin/`). The program itself is deployed on devnet; its source is not in this repository. `docs/program.md`
describes how it behaves, and its IDL is `js/client/idl/loot.json`.

If you were asked to **build an economy** (a shop, loot boxes, staking, a lottery, rewards…), use the `xsolana-economy`
skill and the `xsolana_*` tools. Everything below is for changing the tools.

## Layout

| Path | What |
| --- | --- |
| `js/chain/` | browser-safe Solana primitives, no SDK: base58, Borsh from the IDL, transactions, PDAs, tokens, Core |
| `js/client/` | the client: every PDA, one builder per instruction, account and receipt decoders, grant vouchers |
| `js/economy/` | the economy spec (version 2, `schema.json`), checker, quick simulation, setup plan, cost, explainer, guide |
| `js/play/`, `js/results/` | what a player does with a live economy from an app; results a server vouched for |
| `js/approve/` | `xsolana approve`: the local page where an owner approves going live in their own wallet |
| `js/mcp/` | the MCP server and its `xsolana_*` tools |
| `js/connect/` | `xsolana connect`: adds the tools and the skill to Claude Code and Codex |
| `js/sim/` | LiteSVM running the real program (tests, and the full simulation) |
| `js/test/` | the tests; `fixtures/` pins the programs they run by hash (`npm run fixtures` downloads them) |
| `skills/` | the skill; `scripts/sync-skills.mjs` copies it to `plugin/skills`, `.claude/skills`, `.agents/skills` |
| `plugin/` | one plugin folder for both harnesses: `.claude-plugin/plugin.json` + `.mcp.json` (Claude Code), `plugin.json` + `mcp.json` (Codex) |
| `examples/` | whole economies that check and go live in the tests; `ideas.json`, 112 real economies rated against loot |
| `evals/` | fresh-session evals: prompts, a runner for `claude -p` and `codex exec`, a scorer, live devnet runs |

## Rules

- **Nothing here signs with a person's key, and no tool asks for one.** Going live is always the owner approving in
  their own wallet. A test may make throwaway keys; nothing else holds a secret.
- **Devnet only.** Never pass a mainnet URL for anything that sends; mainnet waits for an audit. Reading public
  mainnet to fetch test fixtures is the one exception.
- Plain ES modules, Node 22 or later, no build step: the code runs as written. The TypeScript declarations are
  generated from it when the package is packed (`npm run types`); `js/test/types.test.mjs` keeps them compiling.
  `js/chain` and `js/client` stay browser-safe (no `node:` imports, no `Buffer` or `process`), and `js/chain` imports
  nothing from `js/client`.
- `npm run lint` (ESLint's recommended rules) passes.
- `js/client/idl/` is generated: a new program build comes with a new IDL (`node scripts/sync-idl.mjs`, given the
  build in `XSOLANA_PROGRAM_DIR`), a new `loot.so` row in `js/test/fixtures/pinned.txt` and a new `release.json`
  (`node scripts/release-manifest.mjs`).
- After editing `skills/`, run `npm run sync-skills`.
- No text names one eval's scenario or a real product as the answer: write the general rule.
- Comments and messages say what something is and does, in plain words.

## Build and test

```bash
npm ci
npm run fixtures                     # once: the loot program and the programs it calls, checked by hash
npm run check                        # fixtures, skill copies and release.json in step, lint, then the tests
node evals/run.mjs --only coin-flip  # one fresh Claude Code and Codex session each (uses real usage)
```

The tests send every instruction the client builds, and every example's whole setup, to the real program in LiteSVM.
With `XSOLANA_PROGRAM_DIR` set to a program build, they run that build's `target/deploy/loot.so` instead.
