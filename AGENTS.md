# Working in this repository

This repository is **solana-kit**, the npm package `@xgamesfun/solana`: the tools for loot, one shared Solana program for
game and community economies. It holds loot's JavaScript client and economy tools (`js/`), the MCP server and CLI
(`js/mcp`, `bin/xsolana.mjs`), the skill (`skills/xsolana-economy`) and the plugin that carries both to Claude Code and Codex
(`plugin/`). The program itself runs on devnet and on mainnet, at an address of its own on each (`js/client/cluster.js`); its
source is not in this repository. `docs/program.md`
describes how it behaves, and its IDL is `js/client/idl/loot.json`.

If you were asked to **build an economy** (a shop, loot boxes, staking, a lottery, rewards…), use the `xsolana-economy`
skill and the `xsolana_*` tools. Everything below is for changing the tools.

## Layout

| Path                      | What                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `js/chain/`               | browser-safe Solana primitives, no SDK: base58, Borsh from the IDL, transactions, PDAs, tokens, Core                               |
| `js/client/`              | the client: every PDA, one builder per instruction, account and receipt decoders, grant vouchers                                   |
| `js/economy/`             | the economy spec (version 2, `schema.json`), checker, quick simulation, setup plan, cost, explainer, guide                         |
| `js/play/`, `js/results/` | what a player does with a live economy from an app; results a server vouched for                                                   |
| `js/approve/`             | `xsolana keygen` and `xsolana approve`: going live signed by a key file, or (`--browser`) on a local page in a browser wallet      |
| `js/mcp/`                 | the MCP server and its `xsolana_*` tools                                                                                           |
| `js/connect/`             | `xsolana connect`: adds the tools and the skill to Claude Code and Codex                                                           |
| `js/sim/`                 | LiteSVM running the real program (tests, and the full simulation)                                                                  |
| `js/test/`                | the tests; `fixtures/` pins the programs they run by hash (`npm run fixtures` downloads them)                                      |
| `skills/`                 | the skill; `scripts/sync-skills.mjs` copies it to `plugin/skills`, `.claude/skills`, `.agents/skills`                              |
| `plugin/`                 | one plugin folder for both harnesses: `.claude-plugin/plugin.json` + `.mcp.json` (Claude Code), `plugin.json` + `mcp.json` (Codex) |
| `examples/`               | whole economies that check and go live in the tests; `ideas.json`, 112 real economies rated against loot                           |
| `evals/`                  | fresh-session evals: prompts, a runner for `claude -p` and `codex exec`, a scorer, live devnet runs                                |

## Rules

- **No tool asks for a seed phrase or for the key of a wallet a person already has, none prints a key, and what is
  sent is what was shown.** Going live is signed on the owner's own machine by a key file made for the project
  (`js/approve/keyfile.mjs`: made new by `xsolana keygen`, for its user alone, outside any repository; the code hands
  back its address and a way to sign, never its bytes), with `xsolana approve --keypair`, which prints everything the
  approval page shows and sends only when run again with the code of exactly that printout. Every word here tells an
  agent to do that only after the owner's yes; the code cannot check who said it. The page for a browser wallet (`--browser`) is served
  only when the person asks for it: no tool, text or example opens one by default. A player's step is the player's own
  wallet's. A step after the wallet's prompt (a settle, an ask for a roll, a release) may be sent by a
  throwaway key `js/play` makes for that one job: the wallet's own transaction funds it with what the step pays (its
  fees, an ask's oracle fee, the rent of what a settle opens or mints: `loot.settleRent`; what a release opens), the
  rent minimum and one spare fee; its step is simulated first and, if it would fail, the wallet sends it instead; then
  the key empties itself back to the wallet. A key pays for an account only with lamports the wallet gave it for that,
  and never holds anything after its job. So a page that closes mid-job can finish it (`recover`), a key is named by
  its job's account and made from the wallet's own signature of a fixed text (`js/play/keys.js`), or, for a wallet that
  signs no messages, kept in the page's storage encrypted with a device key the page can't read out, and dropped once
  empty. A sponsor (`js/play/sponsor.js`) is a key on the project's own server: this package checks what it signs and
  hands it the message, never holds it. Tests may make throwaway keys too; nothing else holds a secret.
- **Tests, evals and scripts send to devnet only.** Mainnet is real money: nothing in this repository sends there but
  what a person runs for their own economy, whose file says `"network": "mainnet"`. Reading public mainnet to fetch
  test fixtures is fine.
- Plain ES modules, Node 22 or later, no build step: the code runs as written. The TypeScript declarations are
  generated from it when the package is packed (`npm run types`); `js/test/types.test.mjs` keeps them compiling.
  `js/chain`, `js/client`, `js/play` and `js/results` stay browser-safe (no `node:` imports, no `Buffer` or `process`), and `js/chain` imports
  nothing from `js/client`.
- `npm run lint` passes: ESLint's recommended rules (browser globals only in `js/chain`, `js/client`, `js/play` and
  `js/results`, and no `node:` import, `Buffer` or `process` there) and Prettier's formatting (`npm run format`).
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
