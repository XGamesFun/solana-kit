# solana-kit

The tools for **loot**, one shared Solana program for game and community economies. This repository is the npm
package `@xgamesfun/solana`:

- a JavaScript client with no Solana SDK (`@xgamesfun/solana/client`), a player module for apps (`/play`) and a results
  client (`/results`);
- the economy spec and its checker, quick simulation, cost and plain-words explainer;
- the `xsolana` CLI and an MCP server with ten `xsolana_*` tools;
- the `xsolana-economy` skill, and one plugin that carries the tools and the skill to Claude Code and Codex;
- a local approval page where a project's owner approves going live in their own wallet.

An economy is a JSON spec, not a new smart contract. Every project shares the one program, and none writes its own.

> **Status:** loot 0.20.1, program ID `9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`, **devnet only**. The program is
> not independently audited, and nothing runs on mainnet until it is. See [SECURITY.md](SECURITY.md).

> **Disclaimer:** provided as is, with no warranty and no guarantee that the program or the tools are safe. Use them
> at your own risk; you are responsible for every transaction you approve and for making sure what you build is legal
> where it runs. Nothing here is legal or financial advice. Read [DISCLAIMER.md](DISCLAIMER.md) before you use it.

## What an economy can be made of

- payments and splits, in tokens or with an NFT
- shops (a purchase in one transaction) and loot boxes
- pools and timed schedules, sealed or not
- lotteries and raffles, including no-loss lotteries
- prizes of any kind on every route, random or not: items, tokens, and NFTs the project holds in a stash
- an NFT as the price on every route that takes money
- staking farms with lock tiers, boosts, early exits and tolls
- crafting recipes
- holds and contests, with prizes by rank or by stake
- auctions: the highest bid wins, the outbid refunded at once
- listings for sale or rent, and bids and loans between players
- perks, staking and holds for any NFT, whether the project has authority over it or not
- allowlists of any size (a Merkle list) on every gated route
- capped rewards and grants that a server vouches for
- rules on what a collectible says

Every move leaves a public receipt. [`docs/program.md`](docs/program.md) describes how the program behaves.

## Use it from an AI coding agent

The MCP server and the skill let Claude Code, Codex or any MCP agent turn a one-line idea into a checked, simulated
economy and hand you the command that puts it live in your own wallet.

**Claude Code**

```
/plugin marketplace add XGamesFun/solana-kit
/plugin install xsolana@xgamesfun
```

**Codex**

```
codex plugin marketplace add XGamesFun/solana-kit
codex plugin add xsolana@xgamesfun
```

**Any agent with MCP** (Cursor, opencode, Cline…): run the server with
`npx -y --package=@xgamesfun/solana@0.20.1 xsolana mcp`. Or let `npx -y @xgamesfun/solana@0.20.1 connect` register it, with
the skill, for Claude Code and Codex.

Then ask for an economy, for example *"a fishing game where each cast costs 0.02 SOL, with a rare golden fish and a
monthly draw"*.

Going live is always yours: `npx -y @xgamesfun/solana@0.20.1 approve` opens a page on your computer where you connect a
devnet wallet and approve each transaction. The agent never signs and never asks for a key.

## Use it from a terminal

Every tool runs from the CLI too, on a spec file (`xsolana.json` by default):

```bash
npx -y @xgamesfun/solana@0.20.1 examples shop with loot boxes   # the nearest worked examples
npx -y @xgamesfun/solana@0.20.1 check xsolana.json                 # refusals and warnings
npx -y @xgamesfun/solana@0.20.1 simulate xsolana.json              # where the money goes, day by day
npx -y @xgamesfun/solana@0.20.1 cost xsolana.json                  # what going live and each action cost
npx -y @xgamesfun/solana@0.20.1 explain xsolana.json               # the economy in plain words
npx -y @xgamesfun/solana@0.20.1 approve xsolana.json               # go live, approved in your own wallet
```

`xsolana help` lists every command. Every command names the exact version, so `npx` runs that release and never whatever
is newest under the name.

## Use it from code

```bash
npm install @xgamesfun/solana
```

```js
import * as loot from '@xgamesfun/solana/client';
const ix = loot.openBoxIx({ player, project, box, nonce }); // one builder per instruction, no Solana SDK
```

| Import | What |
| --- | --- |
| `@xgamesfun/solana` | the economy tools: `check`, `simulate`, `plan`, `cost`, `explainEconomy`, `model` |
| `@xgamesfun/solana/client` | every PDA, one builder per instruction, account and receipt decoders, grant vouchers |
| `@xgamesfun/solana/play` | `solanaApp`: what a player does with a live economy, from a browser app |
| `@xgamesfun/solana/results` | results and vouchers a game's server signs |
| `@xgamesfun/solana/chain/*` | browser-safe Solana primitives: base58, Borsh, transactions, PDAs, tokens, Core |
| `@xgamesfun/solana/idl.json` | the program's IDL, the authority for account and argument layouts |
| `@xgamesfun/solana/release.json` | the program build, IDL and client this release is pinned to |

The client, chain and play modules run in browsers and Node 22 or later, with no bundler required. The package
ships TypeScript declarations for every entry point.

## Documentation

| | |
| --- | --- |
| [`docs/program.md`](docs/program.md) | the program: who signs, accounts, every instruction, fees, limits, receipts, costs |
| [`docs/nfts.md`](docs/nfts.md) | NFTs and tokens, with and without the project's authority |
| [`docs/harnesses.md`](docs/harnesses.md) | how the plugin reaches Claude Code and Codex, and the release checklist |
| [`skills/xsolana-economy`](skills/xsolana-economy/SKILL.md) | the skill an agent follows |
| [`examples/`](examples) | whole economies that check and go live in the tests; `ideas.json`, 112 real economies rated |
| [`evals/`](evals/README.md) | fresh-session evals of agents building on loot |
| [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md) | versions, the trust model, reporting a vulnerability |

## Layout

| Path | What |
| --- | --- |
| `js/chain/` | browser-safe Solana primitives, no SDK |
| `js/client/` | the client; `idl/` is the program's IDL |
| `js/economy/` | the economy spec (version 2, `schema.json`), checker, simulation, setup plan, cost, explainer, guide |
| `js/play/`, `js/results/` | a player's side of a live economy; results a server vouches for |
| `js/approve/`, `js/mcp/`, `js/connect/` | the approval page, the MCP server and its tools, `xsolana connect` |
| `js/sim/`, `js/test/` | LiteSVM running the real program; the tests and their pinned fixtures |
| `bin/xsolana.mjs` | the CLI |
| `skills/`, `plugin/` | the skill (copied to `plugin/skills`, `.claude/skills`, `.agents/skills`) and the plugin |
| `scripts/` | fixtures, skill sync, IDL sync, release manifest, a devnet end-to-end run |
| `release.json` | the program binary, IDL and client hashes this version is pinned to |

## Development

Node 22 or later.

```bash
npm ci
npm run fixtures   # downloads the loot program from devnet and the programs it calls from mainnet, each checked by hash
npm test           # every instruction the client builds, and every example's whole setup, against the real program in LiteSVM
npm run lint       # ESLint
npm run check      # fixtures, skill copies and release.json in step, lint, then the tests
```

Nothing in the tests deploys or spends SOL.

| Variable | What it does |
| --- | --- |
| `XSOLANA_RPC_URL` | a devnet RPC of your own for `xsolana approve` and `xsolana status` (a mainnet URL is refused) |
| `XSOLANA_NO_OPEN` | `xsolana approve` prints its link without opening a browser |
| `XSOLANA_DEBUG` | the CLI prints a failure's whole stack, not one line |
| `XSOLANA_PROGRAM_DIR` | the tests run that program build's `target/deploy/loot.so`, and check the IDL against it | To try the tools in your own agent from a clone,
`node bin/xsolana.mjs connect --local` registers this checkout's MCP server and the skill with Claude Code and Codex
(`--remove` takes them out again).

After editing `skills/`, run `npm run sync-skills`. Changes to tool texts, the skill or the plugin are best measured
with the evals before and after ([`evals/README.md`](evals/README.md)). [`AGENTS.md`](AGENTS.md) has the rules for
working in this repository, for people and coding agents alike.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm run check` before
sending a change, and report a vulnerability privately as [SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [DISCLAIMER.md](DISCLAIMER.md): provided as is, without warranty, at your
own risk.
