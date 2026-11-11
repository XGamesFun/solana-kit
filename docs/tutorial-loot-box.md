# Make a Solana loot box without writing a smart contract

This walks through a paid loot box on Solana, from one sentence to the transactions its owner approves, without
writing, deploying or auditing an Anchor program. It runs on **loot**, a Solana program every project shares, through
the `xsolana` tools. Everything here runs on **devnet**: the program is not yet independently audited.

You need Node 22 or later. With an AI coding agent you only type the sentence; the commands below are what it runs.

## 1. Say what you want

In Claude Code with the plugin installed (`/plugin marketplace add XGamesFun/solana-kit`, then
`/plugin install xsolana@xgamesfun`), in Codex, or in any agent with the MCP server
(`npx -y --package=@xgamesfun/solana@0.28.0 xsolana mcp`):

> A mystery crate for 0.1 SOL: a 1% legendary sword, a 9% epic shield, a 30% rare helmet, otherwise nothing. Most of
> the money goes to the treasury.

The agent looks for the nearest worked examples (`xsolana examples loot box gacha` does the same from a terminal) and
writes a spec.

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

`value` is what you think an item is worth, used only to say what a player gets back on average.

## 3. Check it

```bash
npx -y @xgamesfun/solana@0.28.0 check xsolana.json
```

The checker refuses anything the program would refuse, before anything is signed. This spec is ready, with two
warnings: each opening also pays the platform's 0.002 SOL player fee, and paid random items that can be resold are
treated as gambling in some places (show the odds, and take advice before real money).

## 4. Simulate it

```bash
npx -y @xgamesfun/solana@0.28.0 simulate xsolana.json
```

```
Box “Mystery crate”: costs 0.1 SOL (about 0.10405 SOL in all …), gives back 0.062 SOL on average (62%);
the house keeps 38% of each price.
  1%: sword (worth 2)
  9%: shield (worth 0.3)
  30%: helmet (worth 0.05)
  60%: nothing
Each day players pay 10 SOL and get back 6.2 SOL on average (items at the value you gave them), plus 0.2 SOL in
player fees, 0.08 SOL to MagicBlock’s oracle and 0.001 SOL in network fees.
```

“In all” is what leaves a player's wallet for good: the price, the player fee, the oracle's fee, the network fee and
the rent of the collectible they win.

## 5. Price it

```bash
npx -y @xgamesfun/solana@0.28.0 cost xsolana.json
```

Going live takes 3 transactions and about 0.017 SOL, almost all of it rent for 10 accounts (the
project, the collection, the three items, the box, a lookup table and the token accounts).

## 6. Review it the way a cheater would

```bash
npx -y @xgamesfun/solana@0.28.0 review xsolana.json
```

For every route that pays or gives value it says who can trigger it, what the program enforces, what it trusts off the
chain and the most one cheater gets. Here the only route is the box, and its roll comes from MagicBlock's VRF:
“nobody, the project included, can steer the roll.” The one finding is a reminder that the owner's key controls the
project, so keep it safe: the key file readable by you alone on devnet, a hardware wallet or a multisig with real money.

## 7. Go live, signed on your own computer

```bash
npx -y @xgamesfun/solana@0.28.0 keygen ~/.config/xsolana/loot-box.json
npx -y @xgamesfun/solana@0.28.0 approve xsolana.json --keypair ~/.config/xsolana/loot-box.json
```

`keygen` makes a key file for the project and prints its address, never the key: send that address the devnet SOL
`cost` named. The key file is the project's owner, for good: keep it where it is, back it up yourself, and never
paste it anywhere. `approve` then lists every transaction with what it pays and trusts, ends with a code, and sends
nothing. Run the same command again with `--yes <code>` to send exactly what was listed (an agent does that only
after you have read the list and said yes). Nothing asks for a seed phrase or for the key of a wallet you already
have. To sign in a browser wallet instead, run the page yourself: `approve xsolana.json --browser`.
`xsolana status xsolana.json` then reads the live economy back.

## 8. Let players open it

From a web app, `@xgamesfun/solana/play` does what a player does with a live economy (open the box, wait for the roll,
collect the item) with no Solana SDK:

```bash
npm install @xgamesfun/solana
```

The roll is asked of the oracle when the box is opened and settled once it answers. If the oracle never answers, an
order still waiting after 7 days can be refunded.

## Where to go next

- Gacha pity, card packs with a guaranteed rare, prizes from a stash of NFTs, and a box whose outcomes run out: run
  `xsolana examples` with your own words, or read [`examples/`](../examples).
- Every route a spec can have (shops, lotteries, auctions, staking farms, crafting, contests, capped rewards):
  `xsolana guide`, [the skill](../skills/xsolana-economy/SKILL.md) and the [program reference](program.md).
- What a game's server has to check before it vouches for a result:
  [trust and cheating](../skills/xsolana-economy/references/trust-and-cheating.md).
