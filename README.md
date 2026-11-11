# solana-kit

**Build loot boxes, shops, lotteries, auctions, NFT staking and rewards on Solana without writing a smart contract.**

[![npm](https://img.shields.io/npm/v/@xgamesfun/solana?color=b9f26c&label=npm)](https://www.npmjs.com/package/@xgamesfun/solana)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![network](https://img.shields.io/badge/network-devnet-orange)](#good-to-know)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.XGamesFun%2Fsolana--kit-8a2be2)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.XGamesFun/solana-kit)

You describe your game's or community's economy in a small JSON file: what players buy, open, stake, win or craft.
The tools check it, show you where the money goes, tell you what it costs, and then you put it live by approving it in
your own wallet. It runs on **loot**, one Solana program that every project shares, so there is no Anchor or Rust to
write, deploy or audit yourself.

Most people never touch the JSON: they ask an AI agent (Claude Code, Codex, Cursor, ChatGPT or Claude) for _"a fishing
game where each cast costs 0.02 SOL, with a rare golden fish and a monthly draw"_ and the agent does the rest.

> **Devnet only for now.** The program is not yet independently audited, so nothing here is for real money. The
> tools are provided as is: read [DISCLAIMER.md](DISCLAIMER.md) before you use them.

## What you can build

| Build                         | For example                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------- |
| **Shops**                     | A potion for 0.01 SOL, a skin paid in your own token, an item that costs an NFT  |
| **Loot boxes, gacha, packs**  | A crate with a 1% legendary, a five-card pack with a guaranteed rare, gacha pity |
| **Lotteries and raffles**     | A weekly draw, a no-loss lottery, a raffle for an NFT with an allowlist          |
| **Auctions**                  | Highest bid wins, and anyone outbid gets their money back at once                |
| **NFT staking**               | Lock tiers and boosts, for your collection or any collection you didn't mint     |
| **Crafting**                  | Burn three common gems to forge a rare one                                       |
| **Contests and predictions**  | Pick a side, prizes by rank or by stake                                          |
| **Rewards, quests, airdrops** | Capped rewards your game's server vouches for, daily chests, holder-only drops   |
| **Trading between players**   | Listings for sale or rent, offers, and loans against an NFT                      |

Every move leaves a public receipt on chain. Random rolls come from MagicBlock's verifiable randomness.

## How it works

1. **Describe it.** In a sentence to your agent, or as a spec file (`xsolana.json`).
2. **Check it.** `check` refuses anything the program would refuse; `simulate` shows where the money goes, day by
   day; `cost` prices going live and each player action; `review` shows what a cheater could get.
3. **Approve it.** A page opens on your own computer, lists every transaction, and you approve them in your wallet.
   Nothing here ever signs for you or asks for a key.

New here? The [loot box tutorial](docs/tutorial-loot-box.md) walks through all three with real output.

## Get started

### With an AI agent

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

**claude.ai, ChatGPT or Claude Desktop:** add `https://xgames.fun/mcp` as a custom connector. Nothing to install.

**Cursor, Cline, opencode or any MCP client:** run `npx -y --package=@xgamesfun/solana@0.27.0 xsolana mcp`.

**Any agent that reads skills** (Copilot, Gemini CLI, Windsurf…): `npx skills add XGamesFun/solana-kit`.

Then ask for the economy you want. More ways in, such as the skill as a zip for desktop apps or the server over HTTP,
are in [docs/harnesses.md](docs/harnesses.md).

### From a terminal

```bash
# find a worked example close to your idea
npx -y @xgamesfun/solana@0.27.0 examples shop with loot boxes

# using a coin you already launched? read it from the chain into its "tokens" entry
npx -y @xgamesfun/solana@0.27.0 token <its mint address>

# does it work? where does the money go? what does it cost?
npx -y @xgamesfun/solana@0.27.0 check xsolana.json
npx -y @xgamesfun/solana@0.27.0 simulate xsolana.json
npx -y @xgamesfun/solana@0.27.0 cost xsolana.json

# the whole economy in plain words, and what a cheater could get
npx -y @xgamesfun/solana@0.27.0 explain xsolana.json
npx -y @xgamesfun/solana@0.27.0 review xsolana.json

# go live, approved in your own wallet
npx -y @xgamesfun/solana@0.27.0 approve xsolana.json
```

Each command names an exact version, so you always run the release you meant to. `xsolana help` lists them all.

### In your app

```bash
npm install @xgamesfun/solana
```

```js
import { solanaApp, walletStandardSigner } from '@xgamesfun/solana/play';

// spec: your live xsolana.json; wallet: the player's own (Phantom, Solflare, Backpack…)
const app = solanaApp({ spec, wallet: walletStandardSigner(wallet, account) });

// the player sees the price, then approves the purchase in their wallet
const shop = await app.shop();
await app.buy('potion', { listing: shop.find(item => item.key === 'potion') });
```

No Solana SDK needed: it runs in the browser and in Node 22 or later, with TypeScript types included. The player
module covers buying, opening boxes, staking, crafting, tickets, bids and claims;
[apps.md](skills/xsolana-economy/references/apps.md) shows a whole page.

| Import                           | What it gives you                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `@xgamesfun/solana/play`         | everything a player does with a live economy, from a web page                         |
| `@xgamesfun/solana/client`       | one builder per instruction, every address, account and receipt decoders              |
| `@xgamesfun/solana/sponsor`      | your server pays players' fees (never their price), so players with no SOL can play   |
| `@xgamesfun/solana/results`      | results and vouchers your game's server signs                                         |
| `@xgamesfun/solana`              | the tools themselves: `check`, `simulate`, `cost`, `review`, `explainEconomy`, `plan` |
| `@xgamesfun/solana/mcp/http`     | the MCP server as a web handler, to host it yourself                                  |
| `@xgamesfun/solana/chain/*`      | small browser-safe Solana building blocks: base58, Borsh, transactions, tokens, Core  |
| `@xgamesfun/solana/idl.json`     | the program's IDL                                                                     |
| `@xgamesfun/solana/release.json` | the exact program build this release is for                                           |

Using `@solana/kit`? `loot.toKitInstruction(ix)` turns any builder's instruction into Kit's shape.

## Good to know

- **Devnet only, not yet audited.** Use a devnet wallet. Mainnet waits for an independent audit.
- **Upgrades can mean setting up again.** No program version so far has carried accounts over. Pin the package version.
- **Players trust the project.** Your keys can mint and move your project's pools. The program protects players from
  each other and from mistakes, not from the project they chose.
- **The chain can't see your game.** Wins and scores are vouched for by your server; checking that a player really did
  it is your job. `review` shows what a cheater gets on each route.
- **Nothing runs by itself.** Draws, settles and schedule runs are sent by someone, usually your app.
- **Fees:** 0.002 SOL per player action and 0.00001 SOL per project action, plus rent. `cost` gives the totals.

The full list, with the details behind each, is in [Before you use it](docs/before-you-use.md). Some things aren't
built yet: read the [known limits](docs/program.md#known-limits) before promising players something unusual.

## Questions

**How do I make a loot box or gacha on Solana without writing a smart contract?** Describe it as a box (its price,
its outcomes and their odds), run `check` and `simulate`, then `approve` it in your wallet. If the randomness oracle
never answers, the buyer can get a refund. See the [tutorial](docs/tutorial-loot-box.md) and the
[examples](examples).

**Can I add staking to an NFT collection I didn't mint?** Yes. A staking farm takes any collection, with lock tiers,
boosts and reward rates, and needs no authority over the NFTs. See [NFTs and tokens](docs/nfts.md).

**Can I run a lottery, raffle or auction without deploying a program?** Yes: lotteries (no-loss ones too), raffles
with allowlists, and auctions that refund the outbid at once are all part of the same spec.

**Is there an MCP server or Claude Code plugin for this?** Yes: the `xsolana` plugin for Claude Code and Codex, the
hosted server at `https://xgames.fun/mcp`, and the local server for any MCP client. It's in the MCP Registry as
`io.github.XGamesFun/solana-kit`.

**How is this different from writing my own Anchor program?** Nothing is written or deployed per project: one shared
program enforces every project's rules, and it is tested instruction by instruction. The trade-off is that you can
build what the spec can describe, which is a lot, but not everything.

**Can players with no SOL play?** Yes, if you sponsor their fees from your own server
(`@xgamesfun/solana/sponsor`). They still pay any price themselves.

## Learn more

- [Loot box tutorial](docs/tutorial-loot-box.md): one sentence to going live, step by step
- [Examples](examples): whole economies that are checked and put live in the tests
- [How the program works](docs/program.md): who signs, every instruction, fees, limits, receipts
- [NFTs and tokens](docs/nfts.md): with and without the project's authority
- [Trust and cheating](skills/xsolana-economy/references/trust-and-cheating.md): what your server must check
- [The agent skill](skills/xsolana-economy/SKILL.md): what an AI agent follows to build an economy
- [Agents and harnesses](docs/harnesses.md): every way to reach the tools, and how releases are made
- [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [xgames.fun/solana](https://xgames.fun/solana)

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup (`npm ci`, `npm run fixtures`,
`npm run check`), the repository's layout and how to send a change. Report a vulnerability privately, as
[SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [DISCLAIMER.md](DISCLAIMER.md).
