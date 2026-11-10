# solana-kit: Solana game and NFT economies without a smart contract

Loot boxes and gacha, shops, lotteries and raffles, auctions, NFT staking farms, crafting, quests and capped rewards on
Solana, written as a JSON spec instead of a new Anchor program. They all run on **loot**, one shared, open Solana
program, and an AI coding agent (Claude Code, Codex, Cursor or any MCP client) can design, check, simulate and price
one from a sentence. This repository is the npm package `@xgamesfun/solana`:

- a JavaScript client with no Solana SDK (`@xgamesfun/solana/client`), a player module for apps (`/play`) and a results
  client (`/results`);
- the economy spec and its checker, quick simulation, cost and plain-words explainer;
- the `xsolana` CLI and an MCP server with eleven `xsolana_*` tools;
- the `xsolana-economy` skill, and one plugin that carries the tools and the skill to Claude Code and Codex;
- a local approval page where a project's owner approves going live in their own wallet.

An economy is a JSON spec, not a new smart contract. Every project shares the one program, and none writes its own.

> **Status:** these tools are for loot 0.25.0, program ID `9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`, **devnet
> only** (deployed 2026-11-08, slot 519,994,814). The program is not independently audited, and nothing runs
> on mainnet until it is. See [SECURITY.md](SECURITY.md).

> **Disclaimer:** provided as is, with no warranty and no guarantee that the program or the tools are safe. Use them
> at your own risk; you are responsible for every transaction you approve and for making sure what you build is legal
> where it runs. Nothing here is legal or financial advice. Read [DISCLAIMER.md](DISCLAIMER.md) before you use it.

## Before you use it

- **Devnet only, and not independently audited.** Nothing here is for real money yet. Use a devnet wallet.
- **The program can be upgraded, and an upgrade can mean starting again.** Its upgrade authority can replace the
  program's code, which is power over every economy on it (on mainnet that key is to be a multisig). No version so far
  has carried accounts over from the one before: an economy made on 0.23 was made again for 0.24. Pin the package
  version (each one names the program build it is for in `release.json`) and expect to set an economy up again after an
  upgrade.
- **Players trust the project.** Its owner and authority are trusted keys with no caps: the authority mints, moves the
  project's pool funds, decides contests and writes its NFTs. The program protects players from each other, from the
  platform and from mistakes, not from the project they chose to play. Money held for a record (an order, a bid, a
  farm's stakes, a contest's or lottery's pot) leaves only by that record's rules.
- **Players also trust the token and the collection.** A mint's issuer (a freeze authority, a pause, a transfer hook, a
  permanent delegate) or a collection's controller can stop or move what loot holds. USDC has a freeze authority.
- **The chain can't see a game.** Results a game reports (a win, a score, a clear) are vouched for by a key the project
  trusts, a results server or deciders. Checking that a player really did it is the project's job, on its own server:
  a server that decides the result, replays it, or only bounds what the page reports leaves a cheater very different
  amounts. A grant says which in `trust`, and `xsolana review` says what a cheater gets on every route
  ([trust and cheating](skills/xsolana-economy/references/trust-and-cheating.md)).
- **The hosted results server is optional.** `https://play.xgames.fun/xsolana` (`@xgamesfun/solana/results`'s
  default) signs vouchers for games without a server of their own. It can only pay what a grant allows, and only for a
  grant whose owner named its key in `vouchers`. It sends nothing on chain, and it is offered as is: it can be down, and
  it is behind for a while after each program upgrade. A game with its own server signs its own vouchers
  (`signVoucher`), which is the better choice once it has one.
- **Nothing runs by itself.** Someone sends every step: settles (the player, the project's keys, or a key the player
  named), lottery draws, auction ends, refunds (anyone), contest results (the authority or its deciders) and schedule
  runs (the project's keys). A run nobody sends on time is missed, except a sealed schedule's fixed amount. Apps built
  with `@xgamesfun/solana/play` send the steps a player needs. Don't count on a hosted keeper.
- **The rules are strict.** A prize is a fixed amount: a jackpot that grows is a lottery's pot. A lottery says where its
  places are paid from: a pot that carries over (gifts and what earlier rounds left count), or each round's own ticket
  money, which nothing from outside can change. A prize never shifts to a later round. A draw uses the odds
  as written. When an outcome runs out, a box either stops selling (`stopSales`, the default) or keeps selling and
  draws among what's left (`drawLeft`, which lets a player empty a common outcome to make a rare one likelier).
- **Chance comes from an oracle.** MagicBlock's VRF answers every random roll and draw. If it stops answering, rolls wait. An
  order still unanswered after 7 days can be refunded. Once a roll has waited 10 minutes, a buyer who sees a late
  answer coming can take a refund instead.
- **Fees and rent.** The platform sets two flat fees: by default 0.002 SOL a player action and 0.00001 SOL a project
  action. Each is capped at 0.01 SOL, and a raise waits 7 days. Accounts cost rent: going live, and each settle that
  opens or mints something. `xsolana cost` gives the totals. The platform can suspend purchases, but it never stops
  payouts, refunds or unstakes (the one exception is a recipe that charges).
- **Some things aren't built,** and some limits are kept by design. Read
  [Known limits](docs/program.md#known-limits) before promising players something unusual.
- **The law is yours to check.** The checker's legal flags (chance at money, resellable random items, revenue
  sharing) are reminders, not advice. A spec with no flag isn't therefore legal.

## What an economy can be made of

- payments and splits, in tokens or with an NFT
- shops (a purchase in one transaction) and loot boxes
- pools and timed schedules, sealed or not
- lotteries and raffles, including no-loss lotteries
- prizes of any kind on every route, random or not: items, tokens, and NFTs the project holds in a stash
- an NFT as the price on every route that takes money
- staking farms with lock tiers, boosts, early exits, fixed or shared rates and terms
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

**Chat apps** (claude.ai, ChatGPT, Claude Desktop): add `https://xgames.fun/mcp` as a custom connector (an MCP server
by URL). It is the hosted server (below, "Over HTTP"): nothing to install, and going live stays your own approval on your
computer. More at [xgames.fun/solana](https://xgames.fun/solana).

**Any agent with MCP** (Cursor, opencode, Cline…): run the server with
`npx -y --package=@xgamesfun/solana@0.25.3 xsolana mcp`. Or let `npx -y @xgamesfun/solana@0.25.3 connect` register it, with
the skill, for Claude Code and Codex.

**The skill alone, in any agent that reads skills** (Claude Code, Codex, Copilot, Gemini CLI, Cursor, Windsurf, Cline,
opencode…): `npx skills add XGamesFun/solana-kit` finds it and installs it for the agents you have. Without the MCP
server it runs the same tools through `npx`. Each GitHub release also carries `xsolana-economy.zip`, the skill as one
file for apps that take a skill as an upload (the Claude and ChatGPT desktop apps).

**Over HTTP**: `npx -y --package=@xgamesfun/solana@0.25.3 xsolana mcp --http` serves the tools that read nothing but
their arguments (guide, examples, check, simulate, cost, explain, review, status, client) at
`http://127.0.0.1:8787/mcp`, MCP's Streamable HTTP transport. `@xgamesfun/solana/mcp/http` exports the same handler
(`mcpHttp(request) → response`) for a hosted endpoint: it reads no files, and the agent hands the person the spec and the
`approve` command to go live.

Then ask for an economy, for example _"a fishing game where each cast costs 0.02 SOL, with a rare golden fish and a
monthly draw"_.

Going live is always yours: `npx -y @xgamesfun/solana@0.25.3 approve` opens a page on your computer where you connect a
devnet wallet and approve each transaction. The agent never signs and never asks for a key.

## Use it from a terminal

Every tool runs from the CLI too, on a spec file (`xsolana.json` by default):

```bash
npx -y @xgamesfun/solana@0.25.3 examples shop with loot boxes   # the nearest worked examples
npx -y @xgamesfun/solana@0.25.3 check xsolana.json                 # refusals and warnings
npx -y @xgamesfun/solana@0.25.3 simulate xsolana.json              # where the money goes, day by day
npx -y @xgamesfun/solana@0.25.3 cost xsolana.json                  # what going live and each action cost
npx -y @xgamesfun/solana@0.25.3 explain xsolana.json               # the economy in plain words
npx -y @xgamesfun/solana@0.25.3 review xsolana.json                # what a cheater gets on each route (exits 1 on a high finding)
npx -y @xgamesfun/solana@0.25.3 approve xsolana.json               # go live, approved in your own wallet
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

Players with no SOL can still play when the project sponsors their fees: `solanaApp({ sponsor })` has a key on the
project's own server pay each step's fees and rent (never its price), and `@xgamesfun/solana/sponsor` is that server's
side: `sponsorSigner` dry-runs and checks every transaction before it signs, under the project's own per-player budget.

Building on `@solana/kit`? `loot.toKitInstruction(ix)` gives any builder's instruction in Kit's shape
(`{ programAddress, accounts, data }`), and `loot.fromKitInstruction` turns one back.

| Import                           | What                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `@xgamesfun/solana`              | the economy tools: `check`, `simulate`, `plan`, `cost`, `explainEconomy`, `review`, `model` |
| `@xgamesfun/solana/client`       | every PDA, one builder per instruction, account and receipt decoders, grant vouchers        |
| `@xgamesfun/solana/play`         | `solanaApp`: what a player does with a live economy, from a browser app                     |
| `@xgamesfun/solana/results`      | results and vouchers a game's server signs                                                  |
| `@xgamesfun/solana/chain/*`      | browser-safe Solana primitives: base58, Borsh, transactions, PDAs, tokens, Core             |
| `@xgamesfun/solana/idl.json`     | the program's IDL, the authority for account and argument layouts                           |
| `@xgamesfun/solana/release.json` | the program build, IDL and client this release is pinned to                                 |

The client, chain and play modules run in browsers and Node 22 or later, with no bundler required. The package
ships TypeScript declarations for every entry point.

## Questions people ask

**How do I make a loot box, gacha or pack opening on Solana without writing a smart contract?** Describe it as a box
in a spec (its price, its outcomes and their odds, what each one pays), run `xsolana check` and `xsolana simulate`, then
approve it in your wallet with `xsolana approve`. Rolls come from MagicBlock's VRF, and a buyer is refunded if the
oracle never answers. [`examples/`](examples) has whole worked economies.

**How do I add staking to an NFT collection, even one I didn't mint?** A staking farm takes any collection, with lock
tiers, boosts and fixed or shared reward rates. The project needs no authority over the NFTs: see
[`docs/nfts.md`](docs/nfts.md).

**Can I run a lottery, raffle or auction on Solana without deploying a program?** Yes: lotteries (including no-loss
ones), raffles with a Merkle allowlist, and auctions that refund the outbid at once are all routes in the same spec.

**Is there an MCP server or Claude Code plugin for building on Solana?** Yes: the `xsolana` plugin for Claude Code and
Codex, the hosted server at `https://xgames.fun/mcp` for chat apps, and `npx -y --package=@xgamesfun/solana@0.25.3 xsolana mcp` for any MCP client. It is listed in the MCP
Registry as `io.github.XGamesFun/solana-kit`.

**How is this different from writing my own Anchor program?** Nothing is written, deployed or upgraded per project:
every project's rules are checked by the one program, and its tests run every instruction against that program in
LiteSVM. The trade-off is that an economy can only be what the spec can say ([known limits](docs/program.md#known-limits)).

**Does it run on mainnet?** Not yet: devnet only until the program is independently audited.

## Documentation

|                                                                                    |                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`docs/tutorial-loot-box.md`](docs/tutorial-loot-box.md)                           | a loot box from one sentence to going live, step by step                                    |
| [`docs/program.md`](docs/program.md)                                               | the program: who signs, accounts, every instruction, fees, limits, receipts, costs          |
| [`docs/nfts.md`](docs/nfts.md)                                                     | NFTs and tokens, with and without the project's authority                                   |
| [`docs/harnesses.md`](docs/harnesses.md)                                           | how the plugin reaches Claude Code and Codex, and the release checklist                     |
| [`skills/xsolana-economy`](skills/xsolana-economy/SKILL.md)                        | the skill an agent follows                                                                  |
| [`trust-and-cheating.md`](skills/xsolana-economy/references/trust-and-cheating.md) | what a server decides, replays or bounds; who gets paid; an exploit checklist               |
| [`examples/`](examples)                                                            | whole economies that check and go live in the tests; `ideas.json`, 112 real economies rated |
| [`evals/`](evals/README.md)                                                        | fresh-session evals of agents building on loot                                              |
| [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md)                       | versions, the trust model, reporting a vulnerability                                        |

## Layout

| Path                                    | What                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `js/chain/`                             | browser-safe Solana primitives, no SDK                                                               |
| `js/client/`                            | the client; `idl/` is the program's IDL                                                              |
| `js/economy/`                           | the economy spec (version 2, `schema.json`), checker, simulation, setup plan, cost, explainer, guide |
| `js/play/`, `js/results/`               | a player's side of a live economy; results a server vouches for                                      |
| `js/approve/`, `js/mcp/`, `js/connect/` | the approval page, the MCP server and its tools, `xsolana connect`                                   |
| `js/sim/`, `js/test/`                   | LiteSVM running the real program; the tests and their pinned fixtures                                |
| `bin/xsolana.mjs`                       | the CLI                                                                                              |
| `skills/`, `plugin/`                    | the skill (copied to `plugin/skills`, `.claude/skills`, `.agents/skills`) and the plugin             |
| `scripts/`                              | fixtures, skill sync, IDL sync, release manifest, a devnet end-to-end run                            |
| `release.json`                          | the program binary, IDL and client hashes this version is pinned to                                  |

## Development

Node 22 or later.

```bash
npm ci
npm run fixtures   # downloads the loot program from devnet and the programs it calls from mainnet, each checked by hash
npm test           # every instruction the client builds, and every example's whole setup, against the real program in LiteSVM
npm run lint       # ESLint and Prettier (npm run format fixes the formatting)
npm run check      # fixtures, skill copies and release.json in step, lint, then the tests
```

Nothing in the tests deploys or spends SOL.

| Variable                                                                                                             | What it does                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `XSOLANA_RPC_URL`                                                                                                    | a devnet RPC of your own for `xsolana approve` and `xsolana status` (a mainnet URL is refused) |
| `XSOLANA_NO_OPEN`                                                                                                    | `xsolana approve` prints its link without opening a browser                                    |
| `XSOLANA_DEBUG`                                                                                                      | the CLI prints a failure's whole stack, not one line                                           |
| `XSOLANA_PROGRAM_DIR`                                                                                                | the tests run that program build's `target/deploy/loot.so`, and check the IDL against it       | To try the tools in your own agent from a clone, |
| `node bin/xsolana.mjs connect --local` registers this checkout's MCP server and the skill with Claude Code and Codex |
| (`--remove` takes them out again).                                                                                   |

After editing `skills/`, run `npm run sync-skills`. Changes to tool texts, the skill or the plugin are best measured
with the evals before and after ([`evals/README.md`](evals/README.md)). [`AGENTS.md`](AGENTS.md) has the rules for
working in this repository, for people and coding agents alike.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm run check` before
sending a change, and report a vulnerability privately as [SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [DISCLAIMER.md](DISCLAIMER.md): provided as is, without warranty, at your
own risk.
