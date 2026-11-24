# A spec in 10 fields

An economy is one JSON file, `xsolana.json`. Most economies start from these ten top-level fields. Every part has a
`key` that other parts name (`"pool:pond"`, `"item": "golden-fish"`).

```json
{
  "version": 2,
  "network": "devnet",
  "name": "Fishing Pier",
  "currency": "sol",
  "tokens": [{ "key": "sol", "source": "sol" }],
  "treasury": "wallet:5DckzByxgf3nMQ1m1SGfpsnRXozawiFncTBZDtZ9Nj7T",
  "items": [{ "key": "golden-fish", "name": "Golden Fish", "value": 1 }],
  "pools": [{ "key": "pond", "currency": "sol", "seed": 2 }],
  "boxes": [
    {
      "key": "cast",
      "name": "Cast a line",
      "price": 0.05,
      "split": [{ "to": "pool:pond", "percent": 50 }],
      "outcomes": [
        { "gives": "item", "item": "golden-fish", "chance": 1 },
        { "gives": "pay", "pool": "pond", "amount": 0.1, "chance": 20 },
        { "gives": "nothing", "chance": 79 }
      ]
    }
  ],
  "scenario": { "days": 30, "perDay": { "box:cast": 200 } }
}
```

| #   | Field      | What it is                                                                                                                   |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | `version`  | The spec format: always `2`.                                                                                                 |
| 2   | `network`  | `"devnet"` (play money, the default) or `"mainnet"` (real money). Build and try on devnet first.                             |
| 3   | `name`     | The economy's name, shown to players and on the collection.                                                                  |
| 4   | `currency` | The key of the token the shop is priced in and the treasury holds.                                                           |
| 5   | `tokens`   | Every currency: SOL (`"source": "sol"`), a coin that exists (by its mint, `xsolana token <mint>` reads it), or one you make. |
| 6   | `treasury` | Where what sales leave lands: `"wallet:<address>"`. Left out, it is the owner's key; on mainnet, name a wallet you hold.     |
| 7   | `items`    | Anything sold, dropped or made: a collectible NFT (the default) or a `"normal"` item your backend keeps.                     |
| 8   | `pools`    | Vaults that pay prizes or rewards, with an optional `seed` you put in at go-live.                                            |
| 9   | `boxes`    | Random rolls: a price, a `split` of each payment, and `outcomes` with a `chance` each (adding up to 100).                    |
| 10  | `scenario` | What the simulation assumes: `days`, and how many of each action a day (`"box:cast": 200`).                                  |

How values are written:

- **Amounts** are whole units of their currency: `0.05` is 0.05 SOL.
- **Shares** are percents: `50` is 50%. What a `split` leaves goes to the treasury.
- **Times** are durations (`"30m"`, `"7d"`) or a start (`"publish"`, `"publish+7d"`, a date like `"2026-12-01T18:00:00Z"`).
- **Public data only.** A spec never holds a private key or a seed phrase.

## Other parts, when you need them

`xsolana guide <part>` prints every field of a part, and `xsolana examples <words>` finds a worked example to copy.

| Part        | For                                                                 |
| ----------- | ------------------------------------------------------------------- |
| `lotteries` | Raffles and draws: tickets in rounds, places, a pot, no-loss rounds |
| `farms`     | Staking tokens or NFTs for rewards, with lock tiers and boosts      |
| `recipes`   | Crafting, merging, upgrades, salvage, breeding                      |
| `grants`    | Rewards someone earned: quests, airdrops, vouchers from your server |
| `auctions`  | Highest bid wins; the outbid are refunded at once                   |
| `contests`  | Players back a side; the winners share the pot                      |
| `schedules` | Anything on a timer: an emission, a burn, vesting                   |
| `payments`  | A payment for something your game gives off chain                   |
| `stashes`   | NFTs you hold to give away as prizes                                |
| `holds`     | A player hands an NFT over for a time: a mission, a raid            |
| `keys`      | Who the authority is (the owner, or a server's key)                 |

## The loop

```bash
npx -y @xgamesfun/solana@0.29.11 check xsolana.json      # refusals and warnings
npx -y @xgamesfun/solana@0.29.11 simulate xsolana.json   # where the money goes
npx -y @xgamesfun/solana@0.29.11 cost xsolana.json       # what going live and each action cost
npx -y @xgamesfun/solana@0.29.11 review xsolana.json     # what a cheater could get
npx -y @xgamesfun/solana@0.29.11 approve xsolana.json --keypair ~/.config/xsolana/my-game.json
```

The [loot box tutorial](tutorial-loot-box.md) walks through it with real output, and
[Before you use it](before-you-use.md) has what to know before real money.
