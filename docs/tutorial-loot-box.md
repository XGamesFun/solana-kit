# Make a Solana loot box without writing a smart contract

This tutorial builds a paid loot box on Solana, from one sentence to the transactions its owner approves. There is no
Anchor program to write or deploy. The box runs on **loot**, one Solana program that every project shares, instead of
new contract code for each project. You use it through the `xsolana` tools. loot has not been independently audited.
Everything here runs on **devnet**, where nothing is real money. The same file goes live on mainnet with
`"network": "mainnet"` and real SOL.

You need Node 22 or later. With an AI coding agent, you type only the sentence, and the agent runs the commands below.

## 1. Say what you want

Use Claude Code with the plugin installed (`/plugin marketplace add XGamesFun/solana-kit`, then
`/plugin install xsolana@xgamesfun`), Codex, or any agent with the MCP server
(`npx -y --package=@xgamesfun/solana@0.29.13 xsolana mcp`). Give it this sentence:

> A mystery crate for 0.1 SOL: a 1% legendary sword, a 9% epic shield, a 30% rare helmet, otherwise nothing. Most of
> the money goes to the treasury.

The agent looks up the nearest worked examples and writes a spec. From a terminal, `xsolana examples loot box gacha`
does the same lookup.

## 2. The spec

An economy is one JSON file, `xsolana.json`. This one has three collectible items and one box:

```json
{
  "version": 2,
  "network": "devnet",
  "name": "Mystery Crate",
  "currency": "sol",
  "tokens": [{ "key": "sol", "source": "sol" }],
  "collection": { "name": "Crate Gear" },
  "items": [
    { "key": "sword", "name": "Legendary Sword", "rarity": "Legendary", "value": 2 },
    { "key": "shield", "name": "Epic Shield", "rarity": "Epic", "value": 0.3 },
    { "key": "helmet", "name": "Rare Helmet", "rarity": "Rare", "value": 0.05 }
  ],
  "boxes": [
    {
      "key": "crate",
      "name": "Mystery crate",
      "price": 0.1,
      "currency": "sol",
      "split": [{ "to": "treasury", "percent": 100 }],
      "outcomes": [
        { "gives": "item", "item": "sword", "chance": 1 },
        { "gives": "item", "item": "shield", "chance": 9 },
        { "gives": "item", "item": "helmet", "chance": 30 },
        { "gives": "nothing", "chance": 60 }
      ]
    }
  ]
}
```

`value` is what you think an item is worth. The tools use it only to say what a player gets back on average.

## 3. Check it

```bash
npx -y @xgamesfun/solana@0.29.13 check xsolana.json
```

Run the check before signing. One warning to watch for is that paid random items that can be resold are treated as gambling in some places. Show the odds, and take advice
before you use real money.

Each opening also pays the platform's player fee: 0.002 SOL on devnet and 0.0005 SOL on mainnet. On mainnet that is
0.5% of the 0.1 SOL price, under the 1% at which `check` warns of the fee.

## 4. Simulate it

```bash
npx -y @xgamesfun/solana@0.29.13 simulate xsolana.json
```

```
Simulation over 30 days. Counts a day: none named (anything not named: 100).
Each day, players pay 10 SOL and get back 6.2 SOL on average.
The treasury gets 10 SOL. Platform fees: 0.2 SOL. Oracle fees: 0.08 SOL.

What a player pays
  Purchase             Price    On top, devnet  On top, mainnet  Mainnet extra  Returns
  Box “Mystery crate”  0.1 SOL     0.00405 SOL      0.00255 SOL           2.6%      62%

Odds
- Mystery crate: 1% sword (worth 2) · 9% shield (worth 0.3) · 30% helmet (worth 0.05) · 60% nothing
```

The table shows one opening. "On top" is what it costs beyond the 0.1 SOL price: the player fee, the oracle's fee,
the network fee and the rent of the collectible a player wins, which never comes back (counted on average: 40% of
openings give one). On devnet that is 0.00405 SOL;
on mainnet, where the player fee is 0.0005 SOL instead of 0.002, it is 0.00255 SOL, 2.6% of the price. "Returns" is
what a player gets back on average (62%). The platform fees of 0.2 SOL a day are devnet's: at mainnet's fee the same
100 openings a day pay 0.05 SOL. `--verbose` adds the simulation in words.

## 5. Price it

```bash
npx -y @xgamesfun/solana@0.29.13 cost xsolana.json
```

Going live takes 3 transactions and about 0.017 SOL. Almost all of it is rent for 10 accounts: the project, the
collection, the three items, the box, a lookup table and the token accounts.

## 6. Review it the way a cheater would

```bash
npx -y @xgamesfun/solana@0.29.13 review xsolana.json
```

This box uses the oracle to choose a prize. If its answer is late, a buyer may be able to choose a refund over a
losing result. The project owner controls the box settings. Review both risks before launch.

## 7. Go live, signed on your own computer

```bash
npx -y @xgamesfun/solana@0.29.13 keygen ~/.config/xsolana/loot-box.json
npx -y @xgamesfun/solana@0.29.13 approve xsolana.json --keypair ~/.config/xsolana/loot-box.json
```

`keygen` makes a key file for the project and prints its address, never the key. Send that address the devnet SOL
that `cost` named. The key file is the project's owner until it hands the project to another key. Keep it where it is, back it up yourself, and never
paste it anywhere.

Set `treasury` in the spec before approving if sales should go to a different wallet. `approve` previews the transactions. Read them, then rerun with `--yes <code>` to send. To sign in your browser, run `approve xsolana.json --browser` yourself.

After that, `xsolana status xsolana.json` reads the live economy back.

## 8. Let players open it

In a bundled web app, install `@xgamesfun/solana`. Use the live spec and the player's connected devnet wallet.

```js
import { solanaApp, walletStandardSigner } from '@xgamesfun/solana/play';

const app = solanaApp({ spec, wallet: walletStandardSigner(wallet, account, 'solana:devnet') });
await app.recover();
const crate = (await app.boxes()).find(box => box.key === 'crate');
// Show the price and odds, then open it on the player's click.
openButton.onclick = () => app.openBox(crate.key, { listing: crate });
```

`openBox` waits for the oracle, then delivers the prize. If the oracle has
not answered 10 minutes after it was asked, the purchase can be refunded.

## Where to go next

- Gacha pity, card packs with a guaranteed rare, prizes from a stash of NFTs, and a box whose outcomes run out: run
  `xsolana examples` with your own words, or read [`examples/`](../examples).
- Every route a spec can have (shops, lotteries, auctions, staking farms, crafting, contests, capped rewards):
  `xsolana guide`, [the skill](../skills/xsolana-economy/SKILL.md) and the [program reference](program.md).
- What a game's server has to check before it vouches for a result:
  [trust and cheating](../skills/xsolana-economy/references/trust-and-cheating.md).
