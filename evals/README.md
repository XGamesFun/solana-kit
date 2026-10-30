# Evals

How we measure whether a fresh coding agent, given only the xsolana MCP server and the `xsolana-economy` skill, turns a
person's idea into a working economy, without writing a contract, asking for a key or saying "loot can't" where it can.

There are three kinds:

| Kind | What it does | Files |
| --- | --- | --- |
| Single turn | Each prompt goes to a fresh, non-interactive Claude Code or Codex session in an empty folder. A scorer reads what it did and saved. | `run.mjs`, `score.mjs`, `prompts.json` |
| Composition judge | Claude reads each single-turn run against loot's parts and rates each piece of the idea: built, composed, approximated, offered, declined (rightly or wrongly) or dropped. It also lists what was undersold or overclaimed. | `judge.mjs`, `composition-prompts.json` |
| Live | A whole conversation on devnet: a simulated person, a go-live approved by a test wallet on the real approval page, the page the agent builds, and a player robot that uses it. Graded for security findings and mistakes. | `live/` (see [live/README.md](live/README.md)) |

The composition prompts (`composition-prompts.json`) and their live cards (`live/composition-cards.json`) come from
rated lists of real Solana economies, written in a person's words. Each has a `split`, dev or holdout (see the rules
below), and notes for the judge that the agent under test never sees.

## Before you run anything

- **The `claude` and/or `codex` CLIs, installed and logged in.** Each run is a real session on your own account and
  uses real usage. A full live round is a lot of agent time.
- **Live runs only:**
  - a devnet keypair file of its own that holds devnet SOL, named by `XSOLANA_EVAL_FUNDER` (never a deployer's key);
  - optionally `XSOLANA_EVAL_RPC_URL`, a keyed devnet RPC for the harness (the public one rate-limits a full round);
    `XSOLANA_RPC_URL`, if set, is passed to the agents as a person's own setting would be;
  - Chrome, for the headless test wallet and the player robot.
- Devnet only. The runners refuse a mainnet URL.

Results go to `evals/results/<time>/` (git-ignored).

## Running

```bash
# single turn: every prompt, both harnesses, then the scorer's table in summary.md
node evals/run.mjs
node evals/run.mjs --only coin-flip --harness claude

# the composition prompts, then the composition judge over that round
node evals/run.mjs --prompts evals/composition-prompts.json --split dev --harness codex --effort xhigh
node evals/judge.mjs evals/results/<time> --parallel 4

# live (devnet), one card on both harnesses
XSOLANA_EVAL_FUNDER=<keypair file> XSOLANA_EVAL_RPC_URL=<devnet RPC> node evals/live/run.mjs --only coin-flip
```

`run.mjs` takes `--harness claude|codex|both`, `--only id,id`, `--limit n`, `--parallel n`, `--model`, `--effort`,
`--timeout <minutes>`, `--prompts <file>`, `--split dev|holdout|holdout2`, and `--server local|npm` (the MCP server from this
checkout, the default, or the published package of this version).

Single-turn Codex sessions run in Codex's `workspace-write` sandbox. If it can't start on your machine (every command
fails), set `XSOLANA_EVAL_CODEX_SANDBOX=danger-full-access`: each session works in a throwaway temp folder, but runs
unsandboxed. Live runs default to that mode ([live/README.md](live/README.md) says why).

The judge gives Claude loot's parts and [`docs/program.md`](../docs/program.md), so it can tell a real limit from an
overclaim.

## Rules for changing the tools from what the evals show

- **Dev and holdout.** Each composition prompt and card has a `split`. Change things only from what the dev runs show;
  run the holdout at the baseline and at the end, and never read it to tune anything. If dev improves and holdout
  doesn't, the change was fitted to the test.
- **No fix may name a test's scenario or product.** A change is a general method or a correct fact about loot.
- **Fix facts before adding instructions.** A stale "cannot" or a stale rating is the usual cause of underselling.
- **Keep the skill short.** A new instruction replaces or shortens something; it doesn't stack on top.
- **Overclaiming counts as much as underselling.** The fix for "says can't" must not become "says yes to everything",
  and every "can't" should come with the composition that gets closest.
- **Read the conversations, not only the grades.** The simulated person is easier to please than a real one.
