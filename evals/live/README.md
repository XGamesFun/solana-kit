# Live evals

A fresh Claude Code or Codex session gets the xsolana plugin and a person to serve. It designs the economy, puts it live
on devnet and builds the page, and a player then uses that page. This is end to end, with no human in the loop.

`evals/run.mjs` is different: it sends one-sentence prompts to the design step only. This folder runs the whole
conversation.

## The parts

| File | What it is |
| --- | --- |
| `run.mjs` | the runner: one card × one harness per run, in parallel; records, grades, writes `summary.md` |
| `cards.json` | the scenario cards (below) |
| `agents.mjs` | the agent under test (`claude -p` / `codex exec`, resumed turn by turn), the player robot, `LIMIT` (a usage-limit reply) |
| `usersim.mjs` | the simulated person: Claude with no tools, answering in JSON moves (say, run a command, open the app, done) |
| `approver.mjs` | runs the approval command the agent gave, and approves on the page with the owner's test wallet |
| `wallet.mjs` | the test wallet in a headless Chrome: refuses any transaction it can't explain, and logs what it signed |
| `browser-mcp.mjs` | the browser the player robot drives, with the player's test wallet in it |
| `registry.mjs` | a local npm registry serving this checkout, packed, as `@xgamesfun/solana`, so agents test the code here, not npm's |
| `funds.mjs` | the eval funder, throwaway wallets, topping up and sweeping back |
| `procs.mjs` | process groups: every server a run starts (and any the agent leaves running) stops with it |
| `grade.mjs` | the grader: `S-` security findings, `M-` mistakes, `N-` notes |
| `reclaim.mjs` | after a run, moves the game's SOL pools back to the owner's test wallet (lottery pots stay) so the sweep returns them |
| `regrade.mjs` | grades saved runs again with the current grader and cards |
| `digest.mjs` | one Markdown file per saved run (card, grade, conversation) for reading closely |
| `sweep.mjs` | sends test wallets' devnet SOL back to the funder after a killed run |
| `REVIEW.md` | how to review a round's conversations, and what to report |

## Before a round

- **Harnesses and browser.** `claude` and `codex` are installed and logged in, and Chrome is available for the
  headless wallet and the player robot.
- **The eval funder.** `XSOLANA_EVAL_FUNDER` is the path to its devnet keypair file (`funds.mjs`): a key of its own,
  never the deployer's. The runner stops at once when it is not set.
  - Each run tops up a fresh owner with 0.5 SOL and a player with 0.1, and sweeps them back at the end.
  - A run uses about 0.1 devnet SOL net (rent, fees, seeds). A full round of both harnesses on every card uses about
    2.5. The runner refuses to start when the funder holds less than it needs.
- **An RPC URL of the harness's own.** `XSOLANA_EVAL_RPC_URL` is used for funding, approvals and the test wallets.
  - Use a keyed devnet RPC: the public one rate-limits a full round.
  - It's never passed to the agents under test, and it's scrubbed from everything recorded.
  - `XSOLANA_RPC_URL`, if set, *is* passed to the agents, as a person's own setting would be.
- **Program version.** The program on devnet must be the version this checkout's client speaks (`release.json`
  names it). A client of another version builds instructions or vouchers the program refuses.

## Running

```bash
# one card, both harnesses (about 15 minutes)
XSOLANA_EVAL_RPC_URL=… node evals/live/run.mjs --only coin-flip

# a full round, one harness at a time in two terminals (about 30–50 minutes each at --parallel 2)
XSOLANA_EVAL_RPC_URL=… node evals/live/run.mjs --harness claude --parallel 2 --max-turns 20
XSOLANA_EVAL_RPC_URL=… node evals/live/run.mjs --harness codex  --parallel 2 --max-turns 20
```

Options:
- `--keeper`: a round with a results server beside it. The server is not part of this repository: name a
  folder holding its `scripts/loot-server.mjs` (with its npm packages installed) with `--server-dir <dir>` or
  `XSOLANA_EVAL_SERVER_DIR`; the runner stops at once without one. One server runs at the cards' `{KEEPER}`, and its
  sweep runs every 4 minutes (`--grace 120 --pay-rent`) over the round's games. Games use it through
  `@xgamesfun/solana/results` (this checkout, or `XSOLANA_EVAL_KIT_DIR`). Without `--keeper` (and without `--only`), cards
  with `"keeper": true` are left out, so a round runs without a results server.
- `--harness claude|codex|both`
- `--only id,id`
- `--cards <file>`: another card file, such as `composition-cards.json` (cards from real economies, with a dev and a
  holdout split; see [../README.md](../README.md))
- `--parallel n` (2 by default)
- `--model m` (the agent under test)
- `--effort e`: Codex's reasoning effort
- `--max-turns n`: the person's turns, 14 by default

**Codex runs without its sandbox here** (`danger-full-access`, approvals off), unlike `evals/run.mjs`: a live
session installs packages through the round's npm cache, outside its project folder, and the sandbox can't start on
many Linux machines. Each session works in a throwaway temp folder, but it can run any command as you: run live
rounds on a machine or account you're comfortable with. `XSOLANA_EVAL_CODEX_SANDBOX` picks another mode.

Results go in `evals/results/live-<time>/` (git-ignored). For each `<harness>/<card>/` run:
- `conversation.json`;
- `turn-N.jsonl` (the agent's raw events);
- `player-N.jsonl`;
- `wallet-<role>-N.jsonl` (each transaction the test wallet saw and what it found);
- `grade.json`;
- `project/` (what the agent left, without `node_modules`).

`summary.md` has the table and the findings.

**A run that errored** isn't a failure of the agent's. It's the harness, or a usage limit (`LIMIT` in `agents.mjs`).
Run that card again with `--only`.

## After a round

```bash
node evals/live/regrade.mjs evals/results/live-<time>             # after changing grade.mjs or cards.json
node evals/live/digest.mjs <out> after=evals/results/live-<time>  # after-claude-coin-flip.md, …
```

Then review the digests as `REVIEW.md` says. Split the cards between a few reviewers, and check their claims against
the code before acting on them.

## Things that bite

- **Never import `run.mjs` to test it.** It starts a round as it loads, funds wallets and runs agents. Use
  `node --check evals/live/run.mjs`, and test its parts through their own modules.
- **A killed run** (Ctrl-C, a crash, a closed terminal) leaves funded test wallets in `<tmp>/xsolana-eval-keys-*` and
  may leave servers running.
  - `node evals/live/sweep.mjs` sweeps the wallets back and removes those folders.
  - For servers: `pgrep -af 'xsolana-eval-|evals/results/live-'`.
- **Usage limits.** A full round of both harnesses is a lot of agent time. When an agent hits its limit, the run is
  recorded as errored, not graded.
- **The simulated person** is easier to please than a real one. It's more technical than its persona, gives in after
  one push, and is easy on cost. Read the conversations, not only the grades.

## A card

```json
{
  "id": "coin-flip",
  "kind": "plain",
  "persona": "Who the person is and what they know (not technical, has a Phantom wallet…)",
  "opening": "Their first message, in their words",
  "facts": { "bet size": "0.005 SOL a flip", "bankroll": "at most 0.15 SOL to start" },
  "beats": ["Later turns the person brings up, in order (a change of mind, a pushback)"],
  "app": ["What the player robot tries on the page, one task each"],
  "checks": {
    "expect": "build | refuse",
    "parts": ["the spec parts it must have: boxes, pools, lotteries, farms, grants, auctions…"],
    "intent": [{ "type": "boxReturn", "min": 90, "max": 99 }, { "type": "seedAtMost", "sol": 0.2 }],
    "flags": ["chance"]
  }
}
```

More card fields:
- `"keeper": true`: the card needs a `--keeper` round.
- a beat's `waitMinutes`: the run waits that long on the real clock before the person says it ("it's been an hour").
- `checks.scripts`: the person may run the agent's `node <script>.mjs …` (their game server reporting a winner).
- `checks.serverKeyOk`: a key in a server-side file of the person's game server is a note, not a security failure.
- `checks.expect`: `build`, `refuse`, or `either` (a refusal or an alternative is as good).

The person can also open an owner page with their own wallet (`open_owner_page`): the robot drives it with the
owner's test wallet, under the wallet's owner policy.

`kind` is `plain` (a person who wants something built) or `adversarial`: a pasted key, "just go to mainnet", a
partner's document with instructions in it, "put an admin button in the page". The intent checks are in `grade.mjs`
(`INTENT`). Placeholders: `{PLAYER}` is replaced with the player's test wallet address.
