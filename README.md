# xsolana: a toolkit for building game economies on Solana, with no smart contract to write

**Design, check, simulate and review a game's economy on Solana as a JSON spec: shops, items, crafting, rewards, NFT
staking, loot boxes, raffles and auctions. No smart contract to write.**

`xsolana` is the toolkit in this repository (`@xgamesfun/solana` on npm). **loot** is the Solana program it drives. It
is not [`@solana/kit`](https://github.com/anza-xyz/kit), the Solana JavaScript SDK.

[![npm](https://img.shields.io/npm/v/@xgamesfun/solana?color=b9f26c&label=npm)](https://www.npmjs.com/package/@xgamesfun/solana)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![network](https://img.shields.io/badge/network-devnet%20%7C%20mainnet-orange)](#good-to-know)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.XGamesFun%2Fsolana--kit-8a2be2)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.XGamesFun/solana-kit)

You describe your game's or community's economy in a small JSON file: what players buy, open, stake, win or craft.
The tools check the file, show where the money goes and say what it costs. You then put it live from your own
computer, after reading exactly what will be sent. It runs on **loot**, one Solana program that every project shares,
so there is no Anchor or Rust program to write or deploy for each project. loot itself has not been independently
audited yet.

Most people never edit the JSON. They ask an AI agent (Claude Code, Codex, Cursor, ChatGPT or Claude) for _"a fishing
game where each cast costs 0.02 SOL, with a rare golden fish and a monthly draw"_, and the agent writes and checks it.

> **On devnet and on mainnet.** An economy runs on devnet, where nothing is real money, unless its file says
> `"network": "mainnet"`, where everything is. The program is not independently audited and the tools are provided as
> is. Read [DISCLAIMER.md](DISCLAIMER.md) before you use them, and above all before you use real money.

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

Every move leaves a public receipt on chain. Random rolls come from MagicBlock's verifiable randomness (VRF).

## How it works

1. **Describe it.** Tell your agent in a sentence, or write the spec file (`xsolana.json`) yourself.
2. **Check it.**
   - `check` refuses anything it knows the program would refuse. If it misses something, `approve` stops and says
     what has already landed.
   - `simulate` shows where the money goes, day by day.
   - `cost` prices going live and each player action.
   - `review` shows what a cheater could get.
3. **Put it live.** `approve` lists every transaction, with what it pays and what it trusts, ends with a code, and
   sends nothing. Run it again with that code and it sends exactly what it listed. A key file on your own computer
   signs (`keygen` makes one for the project). Nothing here asks for a seed phrase or for the key of a wallet you
   already have, and no page opens unless you ask to sign with a browser wallet.

**Why a key file and not a browser wallet?**

- A key file made for the project is a new key that has never held anything else. The wallet that holds your own
  assets is never connected or asked to sign.
- It signs each transaction exactly as it was prepared and shown, and nothing opens in your browser.
- The cost: the key is a plain file, so anything on your machine that can read it can sign as the project.
- It owns the project until it hands the project to another key with `xsolana handover`, which both keys sign
  ([the owner's key](docs/before-you-use.md#the-owners-key)). Keep it outside any repository
  (the tools refuse a key file inside one, unless git ignores it there), never paste it anywhere, and back it up
  yourself: nothing restores a lost key.
- Unless your spec names a `treasury`, what the economy earns lands at the key's address. Name a wallet you hold
  (`"treasury": "wallet:<address>"`) before going live.

To sign with a browser wallet instead, `approve --browser` serves a local page for it. **For real money, that is the
safer choice:** the wallet that goes live owns the project, and a browser wallet can keep its key on a hardware device
(a Ledger, for example) instead of in a plain file. These tools have not been tested with a hardware wallet. See
[the owner's key](docs/before-you-use.md#the-owners-key).

New here? [A spec in 10 fields](docs/cheatsheet.md) is the one-page start, and the
[loot box tutorial](docs/tutorial-loot-box.md) walks through all three steps with real output.

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

**Cursor, Cline, opencode or any MCP client:** run `npx -y --package=@xgamesfun/solana@0.29.12 xsolana mcp`.

**Any agent that reads skills** (Copilot, Gemini CLI, Windsurf…): `npx skills add XGamesFun/solana-kit`.

Then ask for the economy you want. [docs/harnesses.md](docs/harnesses.md) lists more ways in, such as the skill as a
zip for desktop apps and the server over HTTP.

### From a terminal

```bash
# find a worked example close to your idea
npx -y @xgamesfun/solana@0.29.12 examples shop with loot boxes

# start your xsolana.json from the smallest one (a potion and a mystery box), then change it to your own economy
npx -y @xgamesfun/solana@0.29.12 examples hello-shop --save xsolana.json

# using a coin you already launched? read it from the chain into its "tokens" entry
npx -y @xgamesfun/solana@0.29.12 token <its mint address>

# does it work? where does the money go? what does it cost?
npx -y @xgamesfun/solana@0.29.12 check xsolana.json
npx -y @xgamesfun/solana@0.29.12 simulate xsolana.json
npx -y @xgamesfun/solana@0.29.12 cost xsolana.json

# the whole economy in plain words, and what a cheater could get
npx -y @xgamesfun/solana@0.29.12 explain xsolana.json
npx -y @xgamesfun/solana@0.29.12 review xsolana.json

# go live: a key file for the project (it prints the address to send SOL to, never the key)…
npx -y @xgamesfun/solana@0.29.12 keygen ~/.config/xsolana/my-game.json
# …then everything going live would send, and a code; nothing is sent
npx -y @xgamesfun/solana@0.29.12 approve xsolana.json --keypair ~/.config/xsolana/my-game.json
# …and with that code, exactly what it listed is sent
npx -y @xgamesfun/solana@0.29.12 approve xsolana.json --keypair ~/.config/xsolana/my-game.json --yes <code>
```

Each command names an exact version, so you always run the release you meant to. `xsolana help` lists every command,
and `xsolana help <command>` shows one command's arguments, options and examples. The commands print text for you to
read: `check`, `simulate`, `cost`, `explain`, `review` and `examples` start with a short summary and tables, and `--verbose` adds
the details in words. `--json` prints the whole answer as JSON, in the words an AI agent gets.

The spec file must be in the folder you run a command in, or in a folder below it: the tools (and an agent that calls
them) read and write nothing elsewhere on your machine. To check a spec in another folder, run the command there.

Exit codes: `0` success; `1` failure, including `check` refusing the spec, `review` finding something high and
`approve` not landing; `2` a usage error (an unknown command or flag, a missing or extra argument).

When the setup makes a token, its mint gets a new address. To put the mint at an address you chose, give both
`approve` commands the key file of that address: `--mint-key <the token's key in the spec>=<key file>`. The file signs
only the transaction that makes the mint, and it is never printed. Once the mint exists, the file can do nothing more
at that address on that cluster. On another cluster it can still create an account at the same address, so keep it as
safe as any key until you have used it everywhere you mean to.

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

No Solana SDK is needed. It runs in the browser and in Node 22 or later, and includes TypeScript types. The player
module covers buying, opening boxes, staking, crafting, tickets, bids and claims.
[apps.md](skills/xsolana-economy/references/apps.md) shows a whole page.

| Import                           | What it gives you                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `@xgamesfun/solana/play`         | everything a player does with a live economy, from a web page                         |
| `@xgamesfun/solana/client`       | one builder per instruction, every address, account and receipt decoders              |
| `@xgamesfun/solana/sponsor`      | your server pays players' fees (never their price), so players with no SOL can play   |
| `@xgamesfun/solana/results`      | results and vouchers your game's server signs                                         |
| `@xgamesfun/solana/keyfile`      | the project's key file as a signer, for a script of the owner's own steps (Node)      |
| `@xgamesfun/solana`              | the tools themselves: `check`, `simulate`, `cost`, `review`, `explainEconomy`, `plan` |
| `@xgamesfun/solana/mcp/http`     | the MCP server as a web handler, to host it yourself                                  |
| `@xgamesfun/solana/chain/*`      | small browser-safe Solana building blocks: base58, Borsh, transactions, tokens, Core  |
| `@xgamesfun/solana/idl.json`     | the program's IDL                                                                     |
| `@xgamesfun/solana/release.json` | the exact program build this release is for                                           |

Using `@solana/kit`? `loot.toKitInstruction(ix)` turns any builder's instruction into Kit's shape.

**Start with these.** The client exports hundreds of names (every builder, address, account layout and receipt). Most apps
need only a few:

| Need                           | Use                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| A player's page                | `solanaApp` and `walletStandardSigner` from `@xgamesfun/solana/play`                            |
| Your server pays players' fees | `sponsorHandler` from `@xgamesfun/solana/sponsor`                                               |
| Your server vouches for wins   | `signVoucher` from `@xgamesfun/solana/results`                                                  |
| An owner's own step, scripted  | `readKeyFile` from `@xgamesfun/solana/keyfile`, and one builder from `@xgamesfun/solana/client` |
| Reading what happened          | `receipts(tx)`, `decode(name, data)`, `pda` and `lootError` from `@xgamesfun/solana/client`     |
| Checking a spec in code        | `check`, `simulate`, `cost`, `review` and `explainEconomy` from `@xgamesfun/solana`             |

Everything else is for when one of these doesn't cover a case; the types (`types/`) document each export.

## Fees and costs

loot charges two flat fees, set in the platform account on each cluster. The figures here, and those the offline
tools quote, are the values at this release; `approve` and `status` read the platform account and say when it charges
other fees or a change waits. `xsolana cost` prices a spec at its own
network's fees, and on devnet it also gives mainnet's.

| What                        | Devnet                                                                          | Mainnet     | Paid by                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Player fee                  | 0.002 SOL                                                                       | 0.0005 SOL  | the player (or a sponsor), once for each action they sign                                                          |
| Project fee                 | 0.00001 SOL                                                                     | 0.00001 SOL | the owner or authority, for setup and each of the project's own steps                                              |
| Cap on each fee             | 0.01 SOL                                                                        | 0.01 SOL    | the program refuses a higher fee                                                                                   |
| Fee raise                   | applies 7 days after it is set; a cut applies at once                           | same        | set by the platform                                                                                                |
| Randomness (MagicBlock VRF) | 0.0008 SOL per roll or draw (high priority; the program offers no cheaper tier) | same        | whoever asks: the player on a box, the sender of a draw                                                            |
| Metaplex Core protocol fee  | 0.0015 SOL per NFT minted, on top of its rent (about 0.0031 SOL in all)         | same        | whoever settles or mints it; Metaplex collects it ([protocol fees](https://developers.metaplex.com/protocol-fees)) |
| Token Metadata fee          | 0.01 SOL per token name written on chain, on top of its rent                    | same        | the owner, at setup                                                                                                |
| Rent                        | (bytes + 128) × 5,080 lamports per account                                      | same        | whoever opens the account; some return it when they close                                                          |
| Network fee                 | 5,000 lamports a signature, plus a priority fee of 2 lamports a transaction     | same        | the signer                                                                                                         |

Rent, as `cost` reports it: a project with one collection (217 bytes) is 0.0017526 SOL, a token account (165 bytes)
0.00148844 SOL, and a project's lookup table of 21 addresses (728 bytes) 0.00434848 SOL. The tutorial's loot box takes
about 0.017 SOL to go live. Any SOL you seed into pools comes on top. [The program reference](docs/program.md#costs)
lists the rent of every account and says which ones return it.

**Royalty.** The collection the setup makes carries a resale royalty to your wallet: 5% unless the spec says
otherwise (`"collection": { "name": …, "royaltyPercent": n }`, 0 for none, at most 25). Marketplaces that honour
Metaplex Core royalties pay it on each resale. `check`, `cost`, `explain` and `approve` all say it.

Devnet SOL is play money, and devnet's player fee is four times mainnet's. For a devnet spec, `check` warns about the
fee as a share of a price using mainnet's fee, and gives devnet's beside it. The full fee rules are in
[the program reference](docs/program.md#the-fee).

## Names

| Name                                                                 | What it is                                                                                                                         | Needed?                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **loot**                                                             | the on-chain Solana program that runs every economy                                                                                | yes: every economy runs on it            |
| **`@xgamesfun/solana`**                                              | this npm package: the check, simulate, cost and review tools, the JS client, the MCP server and the agent skill                    | yes, to check an economy and put it live |
| **xsolana**                                                          | the package's command line (`npx -y @xgamesfun/solana@0.29.12 help` lists its commands), and the name of its plugin and MCP server | comes with the package                   |
| **solana-kit**                                                       | this repository, [XGamesFun/solana-kit](https://github.com/XGamesFun/solana-kit)                                                   | only to contribute or build from source  |
| **[xgames.fun](https://xgames.fun)**                                 | the site behind these tools: their how-tos, the hosted MCP server, the optional results server, and hosted games                   | no                                       |
| **xcore** ([`@xgamesfun/xcore`](https://github.com/XGamesFun/xcore)) | a separate command line that hosts a web game on xgames.fun and adds an economy to it                                              | no: optional, for hosting a game         |
| **gamesfun**                                                         | an older name, still in a few identifiers (the IDL's `repository` field)                                                           | no                                       |

## Good to know

- **Devnet and mainnet, not independently audited.** An economy is on devnet unless its file says
  `"network": "mainnet"`. Mainnet is real money: try everything on devnet first.
- **An upgrade can mean setting up again.** Most program versions so far have not carried accounts over: 0.29 can't
  read the accounts 0.28 made. Pin the package version. [Upgrades](docs/program.md#upgrades) says what is known, and
  what is not, about funds left in an older version's accounts.
- **Players trust the project.** Your keys can mint and move your project's pools. The program protects players from
  each other and from mistakes, not from the project they chose.
- **The chain can't see your game.** Your server vouches for wins and scores. Checking that a player really did
  something is your job. `review` shows what a cheater gets on each route.
- **Nothing runs by itself.** Someone sends every draw, settle and schedule run, usually your app.

[Before you use it](docs/before-you-use.md) has the full list, with the details behind each item. Some things aren't
built yet: read the [known limits](docs/program.md#known-limits) before you promise players something unusual.

## Versions and stability

The package is pre-1.0 and has had frequent releases; the [changelog](CHANGELOG.md) lists every version with its date.

- **major.minor is the program's.** `@xgamesfun/solana` 0.29.x is built for loot 0.29.0. A release check refuses a
  package whose major.minor differs from the IDL's. `release.json` names the program build (its version, program
  addresses and binary hashes) and the hashes of the IDL and the client.
- **A patch is a JavaScript-only release** on the same program: the checker's rules, the tools' words, the client
  and the docs. It can change what `check` warns about or refuses, and the wording an agent sees.
- **A new minor has so far meant a new program build**, and most did not carry accounts over (see
  [Upgrades](docs/program.md#upgrades)). The [changelog](CHANGELOG.md) marks what can break a spec or a script.
- **Pin an exact version.** Use `npx -y @xgamesfun/solana@0.29.12 …` in scripts and docs, and `"@xgamesfun/solana":
"0.29.12"` (no `^` or `~`) in `package.json`. Read the changelog before you move to a new version.

**Policy for specs: a patch never refuses a spec that the patch before it accepted.** This holds from 0.29.12 on.
It covers every refusal of the checker, which `check`, `approve`, `publish`, `cost`, `simulate` and the MCP tools all
run: a spec file with no refusals under one patch has none under the next, on the same network. A patch may add or
change warnings. A new refusal comes only in a new minor; until then, the same finding is a warning. 0.29.11 broke this
rule: its changelog says "Two changes can refuse what 0.29.10 took".

**Command-line changes can come in a patch.** Because major.minor tracks the program, a change to the command line's
surface (printed text, exit codes, defaults, flags) has no other number to go in while the program stays the same:
0.29.12 changed the exit code of usage errors and the default scope of `connect` in a patch. Each such change is listed
in the changelog under "Changes that can affect scripts". The printed text is written for people and can change in
any patch: a script should read `--json` and pin an exact version.

The plan, not a commitment, is fewer releases, with fixes batched into fewer patches.

## Questions

**How do I make a loot box or gacha on Solana without writing a smart contract?** Describe it as a box: its price, its
outcomes and their odds. Run `check` and `simulate`, then `approve` it with your project's key file. If the randomness
oracle never answers, the buyer can get a refund after 10 minutes. See the [tutorial](docs/tutorial-loot-box.md) and
the [examples](examples).

**Can I add staking to an NFT collection I didn't mint?** Yes. A staking farm takes any collection, with lock tiers,
boosts and reward rates, and needs no authority over the NFTs. See [NFTs and tokens](docs/nfts.md).

**Can I run a lottery, raffle or auction without deploying a program?** Yes. Lotteries (including no-loss ones),
raffles with allowlists, and auctions that refund the outbid at once are all part of the same spec.

**Is there an MCP server or Claude Code plugin for this?** Yes: the `xsolana` plugin for Claude Code and Codex, the
hosted server at `https://xgames.fun/mcp`, and the local server for any MCP client. It is in the MCP Registry as
`io.github.XGamesFun/solana-kit`.

**How is this different from writing my own Anchor program?** Nothing is written or deployed per project. One shared
program enforces every project's rules, and it is tested instruction by instruction (but not yet independently
audited). The trade-off: you can build what the spec can describe, which is a lot, but not everything.

**Can players with no SOL play?** Yes, if your own server sponsors their fees (`@xgamesfun/solana/sponsor`). They
still pay any price themselves.

**Does it run on Solana mainnet?** Yes. An economy runs on devnet, where nothing is real money, unless its file says
`"network": "mainnet"`, where everything is. The program has not been independently audited, so build and try an
economy on devnet first, and read [DISCLAIMER.md](DISCLAIMER.md) before you use real money.

**How do I add a Solana economy to a web game I already made?** Use [xcore](https://github.com/XGamesFun/xcore)
(`@xgamesfun/xcore`). `xcore loot add ./my-game` says where the game's `xsolana.json` goes and copies the page client
beside it. `xcore publish` hosts the game on xgames.fun with player sign-in, saves, leaderboards and multiplayer rooms.
It takes plain HTML/JS, Vite, Next.js static exports, and Godot and Unity web exports.

**Is this a gambling platform, an exchange or a wallet?** No. It is a building tool: it designs, checks, simulates and
reviews the economy of a game or a community. Nothing is played, traded or held here. Parts that pay by chance (a
loot box, a raffle) are game mechanics. Where one pays real money, `check` says what the law asks of it and tells you
to take advice before mainnet.

**Does it hold my funds or my keys?** No. Nothing an agent calls here signs or sends anything, and the hosted server
reads only what you pass it and the public chain. An economy goes live through a command you run on your own computer,
signed by a key file you made for the project, after you have read exactly what will be sent.

**Is this `@solana/kit`?** No. `@solana/kit` is the Solana JavaScript SDK, for sending transactions and reading
accounts. This is `xsolana` (`@xgamesfun/solana`): a spec, a checker and a client for economies on one shared program.
Its client needs no Solana SDK.

## Learn more

- How-tos on xgames.fun, each a whole build with what the tools print:
  [a loot box or gacha](https://xgames.fun/solana/loot-box),
  [NFT staking for any collection](https://xgames.fun/solana/nft-staking),
  [an NFT raffle or a lottery](https://xgames.fun/solana/raffle),
  [an NFT auction](https://xgames.fun/solana/auction),
  [an airdrop people claim](https://xgames.fun/solana/airdrop),
  [token rewards that are not farmed](https://xgames.fun/solana/token-rewards) and
  [Solana in a browser game](https://xgames.fun/solana/web-game)
- [Solana MCP servers and plugins, by job](https://xgames.fun/solana/mcp-servers): which one to use for docs, programs,
  chain data, NFTs, wallets and trading, and where this one fits
- [Loot box tutorial](docs/tutorial-loot-box.md): from one sentence to going live, step by step
- [Examples](examples): whole economies that are checked and put live in the tests
- [How the program works](docs/program.md): who signs, every instruction, fees, limits, receipts, upgrades
- [NFTs and tokens](docs/nfts.md): with and without the project's authority
- [Trust and cheating](skills/xsolana-economy/references/trust-and-cheating.md): what your server must check
- [The agent skill](skills/xsolana-economy/SKILL.md): what an AI agent follows to build an economy
- [Agents and harnesses](docs/harnesses.md): every way to reach the tools; [Releasing](https://github.com/XGamesFun/solana-kit/blob/main/RELEASING.md): how a version is
  made
- [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [xgames.fun/solana](https://xgames.fun/solana)

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](https://github.com/XGamesFun/solana-kit/blob/main/CONTRIBUTING.md) has the setup (`npm ci`, `npm run fixtures`,
`npm run check`), the repository's layout and how to send a change. Report a vulnerability privately, as
[SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [DISCLAIMER.md](DISCLAIMER.md).
