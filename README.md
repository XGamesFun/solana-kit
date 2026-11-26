# xsolana

Build a Solana shop, loot box or rewards system in one JSON file. Check the rules, simulate payouts and see what
players pay before you go live. **xsolana** is the CLI in `@xgamesfun/solana`. **loot** is the program every project shares.

[![npm](https://img.shields.io/npm/v/@xgamesfun/solana?color=b9f26c&label=npm)](https://www.npmjs.com/package/@xgamesfun/solana)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![network](https://img.shields.io/badge/network-devnet%20%7C%20mainnet-orange)](#good-to-know)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.XGamesFun%2Fsolana--kit-8a2be2)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.XGamesFun/solana-kit)

Start on devnet with test funds. Set `"network": "mainnet"` to use real money. The program has not been
independently audited. [Before you use it](docs/before-you-use.md) · [Disclaimer](DISCLAIMER.md)

## Names

**solana-kit** is this repository. **xgames.fun** hosts games. **xcore** is its hosting CLI.
You can use xsolana with any host. [xcore](https://github.com/XGamesFun/xcore)

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

1. Describe your economy in `xsolana.json`, or ask your coding agent to write it.
2. Run `check` for errors, `simulate` for payouts and `cost` for fees. Run `review` to see who can claim each payout.
3. Preview setup with `approve`. It lists the transactions. When you're ready, run it again with the confirmation code.
   If setup stops partway through, earlier confirmed transactions stay on chain. Rerun `approve` to review what's left.

The wallet that signs setup owns the project. With a key file, anyone who reads it can act as you. Keep it outside
your repository and back it up. For real funds, prefer a browser wallet backed by hardware. Try it on devnet first.
[Owner keys and handover](docs/before-you-use.md#the-owners-key)

**Choose where sales go before you approve.** Set `"treasury": "wallet:<address>"` in your spec. Sales default to the
signing wallet. To change the treasury later, the owner must send a separate transaction outside the spec.
Collection resale royalties go to the original signing wallet.

[A spec in 10 fields](docs/cheatsheet.md) · [Loot box tutorial](docs/tutorial-loot-box.md)

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

# save a working shop with a potion and a mystery box
npx -y @xgamesfun/solana@0.29.12 examples hello-shop --save xsolana.json

# using a coin you already launched? read it from the chain into its "tokens" entry
npx -y @xgamesfun/solana@0.29.12 token <its mint address>

# does it work? where does the money go? what does it cost?
npx -y @xgamesfun/solana@0.29.12 check xsolana.json
npx -y @xgamesfun/solana@0.29.12 simulate xsolana.json
npx -y @xgamesfun/solana@0.29.12 cost xsolana.json

# review the rules and who can claim each payout
npx -y @xgamesfun/solana@0.29.12 explain xsolana.json
npx -y @xgamesfun/solana@0.29.12 review xsolana.json

# make a project key and fund the printed address with devnet SOL
npx -y @xgamesfun/solana@0.29.12 keygen ~/.config/xsolana/my-game.json
# preview setup
npx -y @xgamesfun/solana@0.29.12 approve xsolana.json --keypair ~/.config/xsolana/my-game.json
# send the setup you reviewed
npx -y @xgamesfun/solana@0.29.12 approve xsolana.json --keypair ~/.config/xsolana/my-game.json --yes <code>
```

Use Node 22 or newer. Run commands from the folder containing your spec or a parent folder.
`xsolana help <command>` lists options. Add `--verbose` for detail or `--json` for scripts.
Exit codes are 0 for success, 1 for failure and 2 for a usage error.

In `hello-shop`, `price` is what a player pays. `value` is a simulation estimate.
Items mint collectible NFTs by default. For a consumable you track in your game, set `"kind": "normal"` and have
your backend deliver it from the purchase receipt.

### In your app

**Hosting with xcore?** Use `GamesFun.loot`. It handles the network and mainnet sign-in. The xgames.fun shared
relay meters calls at $10 per million. [xcore page client](https://github.com/XGamesFun/xcore/blob/main/docs/CLIENT.md#the-economy-gamesfunloot-and-gfloot)

**Using the npm client?** Install `@xgamesfun/solana`. The import below needs a bundler or an
[import map for plain HTML](skills/xsolana-economy/references/apps.md). Start with the live spec, a connected
wallet and its account. Set `rpcUrl` to your network's RPC endpoint. Devnet also has a default.

```js
import { solanaApp, walletStandardSigner } from '@xgamesfun/solana/play';

const chain = spec.network === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';
const app = solanaApp({ spec, rpcUrl, wallet: walletStandardSigner(wallet, account, chain) });
await app.recover(); // finish earlier purchases when the wallet reconnects
const items = await app.shop();
const boxes = await app.boxes();
const buy = item => app.buy(item.key, { listing: item });
const open = box => app.openBox(box.key, { listing: box });
```

Show the listings from `items` or `boxes`, then call `buy` or `open` with the player's choice.
A random box normally needs one transaction approval. The wallet may also ask for one message signature per session
to recover unfinished purchases. [Page examples](skills/xsolana-economy/references/apps.md)

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
| Project fee                 | 0.00001 SOL                                                                     | 0.00001 SOL | the owner or the key authorized to act for the project                                                             |
| Cap on each fee             | 0.01 SOL                                                                        | 0.01 SOL    | the program refuses a higher fee                                                                                   |
| Fee raise                   | applies 7 days after it is set; a cut applies at once                           | same        | set by the platform                                                                                                |
| Randomness (MagicBlock VRF) | 0.0008 SOL per roll or draw (high priority; the program offers no cheaper tier) | same        | whoever asks: the player on a box, the sender of a draw                                                            |
| Metaplex Core protocol fee  | 0.0015 SOL per NFT minted, on top of its rent (about 0.0031 SOL in all)         | same        | whoever settles or mints it; Metaplex collects it ([protocol fees](https://developers.metaplex.com/protocol-fees)) |
| Token Metadata fee          | 0.01 SOL per token name written on chain, on top of its rent                    | same        | the owner, at setup                                                                                                |
| Rent                        | (bytes + 128) × 5,080 lamports per account                                      | same        | whoever opens the account; some return it when they close                                                          |
| Network fee                 | 5,000 lamports a signature, plus a priority fee of 2 lamports a transaction     | same        | the signer                                                                                                         |

A shop item mints a collectible by default. Its mint costs about 0.0031 SOL including the Metaplex fee and rent. A `normal` item is delivered by your backend. The Token Metadata fee applies when you name a token on chain.

Rent, as `cost` reports it: a project with one collection (217 bytes) is 0.0017526 SOL, a token account (165 bytes)
0.00148844 SOL, and a project's lookup table of 21 addresses (728 bytes) 0.00434848 SOL. The tutorial's loot box takes
about 0.017 SOL to go live. Any SOL you seed into pools comes on top. [The program reference](docs/program.md#costs)
lists the rent of every account and says which ones return it.

**Royalty.** The original signing wallet receives the collection's resale royalty: 5% unless the spec says
otherwise (`"collection": { "name": …, "royaltyPercent": n }`, 0 for none, at most 25). Marketplaces that honour
Metaplex Core royalties pay it on each resale. `check`, `cost`, `explain` and `approve` all say it.

Devnet SOL is play money, and devnet's player fee is four times mainnet's. For a devnet spec, `check` warns about the
fee as a share of a price using mainnet's fee, and gives devnet's beside it. The full fee rules are in
[the program reference](docs/program.md#the-fee).

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

## Questions

**How do I make a loot box or gacha on Solana without writing a smart contract?** Describe it as a box: its price, its
outcomes and their odds. Run `check` and `simulate`, then `approve` it with your project's key file. If the randomness
oracle never answers, the buyer can get a refund after 10 minutes. See the [tutorial](docs/tutorial-loot-box.md) and
the [examples](examples).

**Can I add staking to an NFT collection I didn't mint?** Yes. A staking farm takes any collection, with lock tiers,
boosts and reward rates, and needs no authority over the NFTs. See [NFTs and tokens](docs/nfts.md).

**Can I run a lottery, raffle or auction without deploying a program?** Yes. Lotteries (including no-loss ones),
raffles with allowlists, and auctions that refund the outbid at once are all part of the same spec.

**How does this differ from writing my own program?** Each project uses the same program and configures its rules
in a spec. Custom mechanics must fit what the program supports. [Known limits](docs/program.md#known-limits)

**Can players with no SOL play?** Yes, if your own server sponsors their fees (`@xgamesfun/solana/sponsor`). They
still pay any price themselves.

**Can I use this with a game I already host?** Yes. Use the page client with your existing host, or use
`xcore loot add` for a game on xgames.fun. [Page integration](#in-your-app)

**Who holds the keys?** Your wallet or project key signs on your computer. Players sign their own transactions.
[Owner keys](docs/before-you-use.md#the-owners-key)

**Is this `@solana/kit`?** That's the Solana JavaScript SDK. For these economy tools, install `@xgamesfun/solana`.

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

## Versions and stability

Pin the package version in scripts and read the changelog before upgrading. Major and minor versions track the program.
A new minor can require a new setup. Since 0.29.12, a patch may add warnings but must accept specs its predecessor
accepted on the same network. Patches may change CLI defaults, text or exit codes. Use `--json` in scripts.
[Changelog](CHANGELOG.md) · [Program upgrades](docs/program.md#upgrades)

To choose a new token's mint address, pass `--mint-key <token>=<keyfile>` to both approval commands.
That file signs mint creation only. Keep it private on every network where you plan to use the address.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](https://github.com/XGamesFun/solana-kit/blob/main/CONTRIBUTING.md) has the setup (`npm ci`, `npm run fixtures`,
`npm run check`), the repository's layout and how to send a change. Report a vulnerability privately, as
[SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [DISCLAIMER.md](DISCLAIMER.md).
