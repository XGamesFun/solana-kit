# From a sentence to a spec

Read the sentence for **what players pay, what they can get, where the money goes, and who decides**. Each phrase
maps to a part of the spec (`xsolana_guide` has every field).

| They say | Write |
| --- | --- |
| "a shop", "sell hats for 0.05 SOL", "limited to 100" | `items` with `price` (in the project's `currency`) and `supply`: bought in one transaction (`buy`), the item handed over at once. `{serial}` in an item's `uri` gives each unit its own art |
| "free to claim", "a free starter item" | an item with `"free": true` (a gate or a supply keeps bots out), or a grant with limits |
| "costs more each time", "+3% per sale" | an item's or box's `rise` (`growthPercent`, or a `step`) |
| "price drops every minute until it sells", "Dutch auction" | `fall` (`step`, `every`, `floor` above 0): a Dutch auction is a falling price, not `auctions`. By default a sale holds the price where it was paid and restarts the countdown, so it falls only while nobody buys; `"clock": "shared"` keeps it falling on its own clock however often it sells (a Dutch drop of many units). Say which |
| "drops at 6pm Friday", "on sale for a week", "the sale ends Sunday" | an item's, box's or recipe's `opens` and `closes` (times: "publish+2d" or a date) |
| "one per wallet", "max 2 per wallet", "5 a day each" | an item's, box's or recipe's `perWallet` (in all) and `perWalletEach` (`{ "count": 5, "every": "1d" }`): the chain counts each wallet (a person with many wallets gets around it: say so) |
| "auction", "highest bid wins", "bids", "losing bids are returned", "1 of 1 to the top bidder" | `auctions`: a `lot` (`{ "item": key }` for a new one; `{ "asset": address }` for one the owner already holds, once live), `reserve`, `minRaise` (percent), `runs`, `extendBy` (anti-sniping), a `split` (the artist's or a collaborator's share) |
| "auction my NFT", "my 1-of-1" (and you can't tell whether they already hold it) | a new item lot: an item with `supply: 1` and `lot: { "item": key }`, minted to the winner. A collectible they hold can only go up once the economy is live (`E-AUCTION`): say so, and save the spec as `xsolana.json` all the same |
| "sealed bids", "nobody sees the bids", "second-price", "Vickrey" | loot cannot: say so, and offer an open auction (`auctions`) |
| "loot box", "gacha", "mystery box", "pack", "60/25/10/4/1" | `boxes` with `outcomes` of `gives: "item"` and a `chance` each |
| "a starter pack: a sword, a shield and some gold", "three cards in one pack", "an item and coins together" | an outcome `{ "gives": "bundle", "prizes": [ … ] }` of up to three (items, `pay` from a pool, `tokens` minted, `stash`, `nft`, `roll`); more than three: make the third prize a roll of another box (`{ "gives": "roll", "box": key }`, that box `"active": false` and itself a bundle), so one purchase gives five or more, the rolled part after the oracle. A box of one outcome with nothing random and no NFT it rolls on is bought in one step: no order, no oracle, nothing to settle |
| "coin flip", "double or nothing", "plinko", "a prize" | a box whose outcomes `pay` from a pool; its `split` fills that pool. The box sells only while the pool holds every fixed prize (seed it at least that much), and a prize won is set aside for its winner at once |
| "jackpot", "a tenth of the jackpot" | an outcome `gives: "share"` of a pool (`percent`) |
| "give away our partner's NFTs", "a 5% chance at an NFT from another collection", "random NFTs from our treasury", "NFTs we already own" | a `stashes` entry (`nfts`: their addresses, held by the owner's wallet at go-live; `collection` for Core NFTs of another collection; a Token Metadata NFT as `{ "mint", "programmable" }`) and a box outcome `{ "gives": "stash", "stash": "<key>" }`: a roll picks one at random and takes it out of the stash at once. Rarity tiers: one stash per tier, each an outcome with its chance. A compressed NFT goes in after go-live (`E-STASH`) |
| "a prize", "the winner gets", "reward" (known in advance) on a grant, a raffle, a tournament, a quest, a mission, a recipe | a prize line given in the same transaction: `{ "gives": "item", "item": key }`, `{ "gives": "tokens", "amount": n, "from": "mint", "currency": key }` or `"from": "pool:<key>"`, `{ "gives": "share", "pool": key, "percent": p }`, `{ "gives": "nft", "stash": key, "nft": "<address>" }` (an NFT a stash lists). One step for the player, no oracle |
| "a random prize" for a grant, a raffle, a tournament, a quest, a mission | the prize `{ "gives": "roll", "box": "<box>" }`: a box (`"active": false`) of whatever it may give (items, `pay`, `share`, `stash`), rolled for the winner. Anyone asks the oracle for the roll and settles it; it is never refunded while it waits. Use it only for chance |
| "a free daily chest", "quest reward: a random item", "a promo code for a mystery box" | a grant with `"prize": { "gives": "roll", "box": "<box>" }` (its funds pay the roll's order, back to the winner at settle); a known reward is a direct `prize` instead |
| "raffle my NFT", "the winner gets the 1-of-1", "first place wins an NFT", "refund everyone if not enough tickets sell" | a lottery with `"raffle": "<address>"` (or `{ "nft", "collection" }` for an NFT of another collection) and no `every`: the NFT waits in the lottery's own stash, which nothing but the draw can empty, and the winner gets it before any ticket money moves. `minSold`: a round that sold fewer is cancelled at its draw and refunded. The ticket money goes where its `split` says (`"treasury"`, the seller's). A seller raffling their own NFT is the owner of a project of their own (`app.raffle`) |
| "sell my shield for 3 SOL", "list it at a price", "rent out my mech for a few days", "scholarships" | a listing, made from the app's page at run time, not in xsolana.json: `app.listForSale(asset, { price })`, `app.listForRent(asset, { price, lasts, maxPeriods })`; a buyer `app.buyListing(asset, { listing })`, a renter `app.rentListing(asset, { periods, listing })` (the `listing` the page showed); the app reads who rents it with `app.rentedTo(asset)` (one account read). On-chain gates don't read rentals |
| "presale", "fair launch", "10% of the supply split by what each put in", "allocation by contribution" | a contest with one side, a `minPot`, a split of 100% to the treasury and a token `prize` with `"split": true`: set aside whole when it is decided (or the decision is refused), each backer's part by what they put in; short of `minPot`, everyone is refunded |
| "vesting", "cliff then monthly", "locked team tokens", "nobody can take it back", "unlock schedule" | a schedule `{ "does": "pay", "sealed": true, "currency": key, "to": "wallet:<address>", "amount": n, "start": "publish+60d", "every": "30d", "maxRuns": 6, "fund": total, "fundFrom": "mint" }`: its own vault, never edited or stopped by anyone, the last run pays the rest. An ordinary schedule from a pool is only the owner's promise (`W-SCHEDULE-PAY`) |
| "leave early for a 10% fee", "paper hands penalty", "unstaking takes 7 days", "2% harvest tax", "compound" | a farm of tokens: a tier's `exitFee` (percent) with the farm's `exitFeeTo` (`"burn"` or `"pool:<key>"`: its own rewards pool releases it to those who stay, over the farm's longest lock), `unbond` ("7d"), `toll` `{ "percent": 2, "to": "burn" }`; compounding is `app.compound(farm)` when the rewards are the staked token, the lock unchanged. A farm of collectibles leaves early by a recipe that lowers its `lockAttribute` |
| "monthly payouts from a list", "each wallet gets a different amount", "points to tokens by list" | a grant of tokens whose `list` entries are `{ "wallet", "amount", "round" }`: each claims its amount once; the same wallet under another `round` claims again |
| "the tournament winner gets a trophy NFT", "a random NFT for every correct pick" | a contest's `prize`, given to each winning entry when it is claimed, besides its part of the pot: one NFT goes to the first entry claimed (`W-CONTEST-PRIZE`; a contest whose sides are the players has one winner), a roll gives each winner a random one |
| "auction a mystery box", "bid on a mystery lot" | an auction `lot: { "roll": "<box>" }`: the winner gets a roll of the box; the price goes to the treasury. Say what the box can give, with its odds (`W-AUCTION`) |
| "the expedition brings back a chest", "missions drop random loot" | a farm tier's `prize`: `{ "gives": "roll", "box": "<box>" }`, rolled when the mission is completed (its lock stayed, its upkeep never ran dry, not forfeited) while the NFT goes home; a known reward (tokens, an item, an NFT) is given as it leaves |
| "only pass holders can buy it", "members only" | a `gate` of the item alone: `{ "item": "pass" }` |
| "only holders can open it", "level 5 and up" | a `gate`: `{ "item": "pass", "attribute": "level", "atLeast": 5 }` |
| "only these players", "just the two of them", "the tournament's entrants" | a `gate` of wallets: `{ "wallets": ["<address>", …] }` (at most 16) |
| "stake to enter", "staking tiers for a token sale", "only people who lock 100 of our token can buy" | a farm of a token with no `rewards` when staking pays nothing (an empty pool is opened for it), and a `gate` `{ "staked": { "farm": "<farm of a token>", "atLeast": 100 } }`: the wallet's stake in that farm, counted only while its tier's lock runs and from the second after it is made (one stake can't move to another wallet and count again; a tier with no lock never passes, `W-STAKED`). The app passes the seat and the farm |
| "allowlist", "whitelist of 5,000 wallets", "a snapshot of our holders", "early supporters only" | a `gate` `{ "list": ["<address>", …] }` of any size: the program keeps only its root, the page passes each player's proof (`W-LIST`); a new list is a new root, published again |
| "rarer pulls for higher levels", "a charm stat improves the odds" | a box's `odds`: `{ "outcome": 3, "when": { "attribute": "charm" }, "add": { "perPointPercent": 10, "upTo": 9 } }` |
| "stake to earn", "x% house edge to stakers", "fees go to holders" | a `split` share `"to": "pool:<rewards>"` and a `farms` entry whose `rewards` is that pool |
| "lock for longer, earn more", "30-day lock pays 3x" | a farm's `tiers`: `[{ "lock": "1d", "multiplier": 1 }, { "lock": "30d", "multiplier": 3 }]` |
| "stake your NFT", "rarer heroes earn more" | a farm with `"stakes": "collectibles"`, `boosts` on an attribute, `maxBoostPercent` |
| "earn 12 a day per NFT", "daily emissions per NFT", "a fixed rate per NFT" | a farm's `rate`: `{ "perDay": 12, "minted": true }` (the reward a token the project mints), the same for each NFT whoever else stakes; without `minted` it pays from the rewards pool while it lasts |
| "XP", "levels up while staked", "level 5 after a week", "evolve at level 10" | a farm's `growth`: `{ "perDay": 100, "levels": [100, 300, 600] }` writes `xp` and `level` on the NFT for time staked, with nobody's signature; a boost per `level`, a gate, box `odds` or a recipe's `needs` read it (evolve: a recipe that burns the hero and makes the next form, `needs` level 10). `"streak": true` resets it when the NFT leaves |
| "a mission can fail", "the hero comes back hurt", "the hero can be lost / captured" | the tier's `roll`: a box (`"active": false`, `rollsOn` the mission's NFTs) whose outcomes say what happens: an item or a prize on success, `"shifts": [{ "attribute": "affection", "by": -2 }]` when hurt, `"then": "burn"` (or `"treasury"`, `{ "giveTo": "<wallet>" }`) when lost; `odds` by level make success likelier. The farm then needs freeze or escrow custody for a loss to bite (a watched NFT sold first is simply not rolled) |
| "enchant: 60% +1 level, 30% -1 level, 10% it breaks", "upgrade can fail" | a box with `rollsOn` (the NFT the player brings) and outcomes with `shifts` and `then`; one that can burn or give the NFT away holds it until the roll settles, so say so |
| "risky forge", "merge with a chance of failure" | a recipe output `{ "gives": "roll", "box": "<box>", "on": 0 }` (the box `"active": false`): on a kept collectible, or with no `on`, a roll whose outcomes are items or prizes |
| "merging costs a level", "lose a stat" | a recipe's `raises` with a negative `by`: `{ "place": 0, "key": "level", "by": -1 }` (never below 0) |
| "missions", "expeditions", "send heroes on a 3-day quest for loot", "random rewards" | a farm tier with a `lock` and a `prize`: `{ "gives": "tokens", "amount": 2, "from": "mint", "currency": "<ticket>" }` (grown by boosts); a box priced in that ticket gives the random loot, its `odds` raised by level or trait. A mission needs a lock (`E-FARM`) |
| "1 level a day", "+2 affection a day" | a farm's `growth` without `levels`: the points are the attribute itself, `[{ "attribute": "level", "perDay": 1 }, { "attribute": "affection", "perDay": 2 }]` (up to 4) |
| "a mission open for one week", "a season that ends" | a farm's `runs`: `"7d"` from when it goes live; it takes no stake at its end or after it, nor one whose lock would run past it. A sharing farm keeps what it has not released by the end in the pool (the project's): fund it at least its release span (its longest lock, a day at least) before the end. A mission that pays no tokens has `"rate": { "perDay": 0, "minted": true }`. Released later: add the farm to the spec and publish again |
| "level 3 to join", "needs level 100 and 6 affection" | a farm's `gate`, one rule or a list the NFT must all pass: `[{ "collection": "<address>", "attribute": "level", "atLeast": 100 }, { …, "attribute": "affection", "atLeast": 6 }]` |
| "fuel", "food", "upkeep", "drills need fuel to dig", "runs out", "license for 30 days" | a farm of collectibles' `upkeepAttribute` (`"fuel_until"`): a staked NFT earns and grows only until that time, and it runs out by itself; a recipe sells it: `in` the NFT (`use`) and a `pay` line, `raises`: `[{ "place": 0, "key": "fuel_until", "by": "1d", "upTo": "3d", "fromNow": true }]` (a dry tank fills from now; at most 3 days ahead). A recipe reaches an NFT staked in escrow; the play page refreshes its seat in the same transaction. A mission's prize needs the fuel to last its lock |
| "leave early for a fee", "early unstake penalty", "break the lock", "recall" | a farm of collectibles' `lockAttribute` (`"free_at"`: the lock is written on the NFT as the time it ends) and a recipe that lowers it for a price: `raises`: `[{ "place": 0, "key": "free_at", "by": "-1d", "fromNow": true }]` with a `pay` line burned, or paid into the farm's rewards pool (released to the seats there over the farm's longest lock, a day at least). Leaving early takes no mission prize. A farm of tokens uses its tier's `exitFee` instead |
| "jail", "cooldown after a raid", "arrested for 24 hours" | a roll's outcome `"shifts": [{ "attribute": "jailed", "by": "1d", "upTo": "1d", "fromNow": true }]`, and the mission's gate `{ "item": "<hero>", "attribute": "jailed", "time": "passed" }`; on a staked NFT with `lockAttribute`, a shift on that key keeps it in longer |
| "set bonus", "collect all four elements", "a full set earns more", "bonus for a complete set staked" | a set bound into a badge: a recipe whose `in` takes each piece `{ "takes": "staked", "item": "<piece>", "farm": "<its farm>" }` (the farm it is staked in, escrowed or frozen) and whose `out` is a badge item, with `raises` on each piece `{ "key": "bound", "by": 1, "upTo": 1 }` (one badge a set) and `{ "key": "free_at", "by": "20000d" }` (that farm has `"lockAttribute": "free_at"`, so they stay staked while the badge exists; a raise on a staked piece must move its farm's lock, or the craft is refused); the badge earns in a farm of its own. Unbinding: `in` the badge burned and the pieces `staked` in the same farm, `needs` each `bound` at least 1, `raises` `bound` by -1 and `free_at` by "-20000d", and no `pay` line (one waits while the platform suspends the project, keeping the pieces locked: charge when binding). Up to 4 pieces (8 raises; one transaction). The `elements-set` example |
| "only with fuel left", "pass still valid" | a rule's `"time": "ahead"` (a time still to come) or `"passed"`; a farm's gate reads a time as the NFT comes in |
| "the NFT stays in the guild while it goes on the mission", "can still sell it" | `"custody": "watch"` on the mission (and on any farm whose NFTs must stay free); the guild itself may freeze |
| "my pNFTs", "compressed NFTs", "any NFT" | nothing to add: every route takes Core, Token Metadata (legacy, pNFT) and compressed NFTs |
| "a badge for everyone who comes", "airdrop an NFT to 20,000 wallets", "POAPs", "mint cNFTs" | the prize `{ "gives": "item", "item": "<badge>", "compressed": true }` (a grant's, a place's, a contest's, a mission's or a recipe's): a compressed NFT of the collectible, no rent each (a Core one is about 0.003 SOL), minted into a tree the setup opens (`compressedTree: { "holds": n }`, 16,384 by default, about 0.23 SOL once). Write it before going live: the setup's collection takes compressed NFTs only if it is made with them in the spec. Not soulbound, not a box outcome; give a rare one as a Core collectible |
| "blue background gets 10%", "a trait in the metadata" | a boost on the attribute (`{ "when": { "collection": "<address>", "attribute": "Background", "equals": "Blue" }, "add": { "addPercent": 10 } }`) and the spec's `traits` (the root of `loot.traitsTree` of the collection's off-chain metadata): each NFT's traits are proven into its Sheet once |
| "pay to level up", "train", "upgrade a stat for 100 shards", "max level 10" | a recipe: `in` the collectible kept (`use`) and a `pay` line, and `raises`: `[{ "place": 0, "key": "level", "by": 1, "upTo": 10 }]`. A farm's growth never takes a bought level back down |
| "upgrade an NFT of another collection in our game", "stats for NFTs from another collection" | a recipe line `{ "takes": "show", "collection": "<address>" }` and `raises` on it: the stats live in the project's Sheet of that NFT (or on the NFT, when its Attributes plugin names the project); the authority imports stats that only exist off the chain with a `set` decision |
| "earns its power a day", "rate by rarity or stat" | a farm `rate` and a boost `perPointPercent` on the stat: `{ "when": { "attribute": "power" }, "add": { "perPointPercent": 100, "upTo": 100 } }` and `maxBoostPercent` up to 10,000 (x101) |
| "level-up rewards", "claim a badge at level 15" | an open grant gated by `{ "attribute": "level", "atLeast": 15 }`, `perWallet` and the NFT counted once (show the badge, claim once) |
| "weekly lottery", "three places", "one grand prize and seven smaller" | `lotteries` with `every: "7d"`, `places: [60, 25, 15]`. A lottery has a pot of its own (`currency`, the project's by default; `seed` fills it at go-live): only its winners are paid from it, so the owner can't drain it by mistake |
| "a raffle", "one draw at the end of the month" | a lottery with no `every` and a `firstDraw`: it draws once and ends |
| "x% of tickets go to me" | the lottery's `cutPercent` (a share to the treasury, paid after a successful draw) |
| "20% of every ticket to the school fund", "the referrer gets 8% of the tickets they bring" | the lottery's `split`: `{ "to": "wallet:<fund>", "percent": 20 }`, `{ "to": "chosen", "percent": 8 }` (the buyer fixes the referrer when they buy; shares are paid after a successful draw) |
| "max 10 tickets each" | the lottery's `perWallet` (tickets one wallet holds in a round) |
| "fed by 10% of every flip" | a 10% share in the box's `split` to `"lottery:<key>"` |
| "burn X for Y", "merge two into one", "craft", "breed", "upgrade" | `recipes`: `in` (`burn`, `use`, `renew`, `pay`, `trade`, `staked`, `show`) and `out` (`item`, `tokens`, `share`, `nft`, `roll`) |
| "trade in any NFT of ours for 10 gold", "swap an NFT of another collection for a badge", "we keep what's traded in and give it away again" | a recipe line `{ "takes": "trade", "collection": "<address>" (left out: the project's own), "then": "burn" \| { "stash": "<key>" } \| { "giveTo": "<wallet>" } }`: the NFT is the price. Into a stash, it becomes another player's prize (a box outcome `{ "gives": "stash" }` resells it) |
| "a trade-in box: give an NFT, roll for a new one" | a box with `rollsOn` (which NFTs it takes) and `"then": { "stash": "<key>" }` (or `"burn"`): every outcome keeps the NFT paid, and its outcomes give the prizes |
| "tickets cost an NFT", "sacrifice an NFT for a raffle ticket" | a lottery's `ticketNft`: `{ "rule": { "item": key } or { "collection": address }, "then": "burn" or { "stash": key } }`, with no `price`, `split` or `ticketCurrency`; the pot is its `seed` and its places' prizes. An NFT spent on a ticket is never refunded (`W-NFT-PRICE`) |
| "no-loss lottery", "prize savings", "you never lose your ticket", "the sponsor pays the prize" | a lottery with `"noLoss": true`: every ticket (tokens or an NFT) goes back to its buyer once the round is drawn, and the winners take only the pot: its `seed`, a sponsor's payments, shares of other sales (`"lottery:<key>"`). No `split`, `cutPercent` or `ticketCurrency`. Say that tickets are not weighted by time: someone may buy most of them right before the draw and risk only the fees |
| "stake an NFT on the duel", "winner takes the loser's NFT" | a contest's `stakeNft` (a rule): each entry stakes one NFT; each winning entry takes its own back and one loser's as it is claimed, and the opener gets what the winners leave |
| "bid with NFTs", "the most NFTs wins" | an auction's `bidNfts` (a rule): a bid is up to three Core or Token Metadata NFTs (never compressed), the most wins, `reserve` counts NFTs |
| "pay with an NFT to enter", "burn an NFT for an attempt" | not a spec part: the page calls `loot.payNftIx` (burned, or given to a wallet) and the app admits by the receipt, as for a payment |
| "points", "tickets", "shards", "attempts", "sparks" | a token the project mints: a `tokens` entry `source: "project"`, given by a recipe's `out` (`from: "mint"`) or a schedule |
| "a pass that claims daily", "cooldown" | an item with `life.cooldown`; a recipe that `use`s it and pays `tokens` from a pool |
| "ready after 7 days", "rots in 3 days", "6 uses" | an item's `life`: `readyAfter`, `lasts`, `uses`. Only recipes read `life` (a recipe refuses an item not ready, expired or used up); gates, odds and boosts never do |
| "monthly membership", "renew", "pass valid until", "expires unless renewed", "a week's access" | a pass item with a time attribute (`paid_until`), a renew recipe (`in`: the pass `use`d and a `pay` line; `raises`: `[{ "place": 0, "key": "paid_until", "by": "30d", "fromNow": true, "upTo": "60d" }]`), and gates that read `{ "item": "pass", "attribute": "paid_until", "time": "ahead" }`. Nothing charges a wallet by itself: the member renews, the page reminds them |
| "every day mint 5,000 into the pool, halving every 90 days" | a `schedules` entry `does: "issue"`, `every: "1d"`, `halveEvery: 90` |
| "burn half a percent of the pool daily", "move 5% weekly" | a schedule `does: "burn"` or `does: "move"` with `percent` |
| "pay the team 100 a week", "a landlord's rent" | a schedule `does: "pay"` from a pool `to` "wallet:<address>" or "holder:<asset>" (anyone may run it when due: the page, a player, a sweep) |
| "an entry fee", "pay per attempt" | `payments` with `amount` and a `split`. A payment has no gate, no opens/closes, no `"chosen:<item>"` share and no rising price: when the entry needs one, sell it as a box with one outcome that gives nothing (or an item), which has them all. Its split may name a `"chosen"` wallet (a referrer): `app.pay(key, { chosenRecipient })` |
| "tips", "donations", "pay what you want", "any amount above 0.001" | a payment with `"any": true`: `amount` is the least; the page asks the amount and calls `app.pay(key, { amount })` |
| "all proceeds to the school", "our DAO's vault gets the money", "the cut goes to the charity" | `"treasury": "wallet:<their address>"`: what every split leaves, and a lottery's cut, go there. Left out, the treasury is the owner's own wallet. The owner can change it later |
| "several signers must approve spending", "a multisig" | loot isn't a multisig: the money goes to their multisig's vault (for example Squads): `"treasury": "wallet:<vault>"`, or a `wallet:` share; spending from it is approved in the multisig |
| "60% to me, 40% to my co-designer", "10% to our charity", "split with my partners" | split shares `"to": "wallet:<their wallet address>"` (ask for each address). Going live opens each wallet's account for the currency. Use `account:` only for a token account that already exists |
| "our partner gets 4%" (one fixed wallet) | a split share `"to": "wallet:<their address>"` |
| "referral links", "each streamer gets 6% of what they bring", "tip the artist I pick" | a box's, shop item's, lottery's or payment's split share `"to": "chosen"`: the buyer names the wallet when they buy (the page passes it from the link: `app.buy(key, { listing, chosenRecipient: referrer })`, `app.pay(key, { chosenRecipient: referrer })`), never their own (a second wallet of theirs still works, so a referral share is at most a rebate: price it so); with none it goes to the treasury |
| "a fee to the owner of the workshop I craft at", "the venue's owner gets a cut" | a split share `"to": "chosen:<item key>"`: the buyer names a collectible of that item, and whoever holds it is paid (`{ chosenRecipient: <its address> }`) |
| "the holder of the deed gets 3%" | a split share `"to": "holder:<collectible address>"` |
| "duel", "bet on a side", "prediction", "the winner takes the pot" | `contests` with `sides` and a rake in `split`; the authority decides, or a results server's key in `deciders` signs the result (anyone sends it) |
| "1v1 wager", "both put in 10 and the winner takes it" | a contest with a wallet `gate` of the two players and a `stake` (every entry exactly that) |
| "crowdfund", "all or nothing", "refund everyone if we miss the goal" | a contest with `sides: 1`, a `minPot` (the goal), and a `split` of 100% to `"wallet:<recipient>"`. Short of the goal when entries close, it is off by itself and every backer claims their pledge back (anyone can send those claims). Reached: the owner (or a decider) names side 0 and the whole pot goes to the recipient. A badge for each backer: a grant whose `list` is the backers |
| "the game decides who cleared the level and pays them" | `decisions`: `does: "payout"` from a pool, with `when` in words |
| "level up my pet", "write the score on the NFT" | a decision `does: "set"` (the authority rewrites attributes) |
| "send caravans on trade runs, the game says how they went", "the event ends at 18:00" | `holds` (the item, `for` a time the player picks, or `until` a set time) and an `award` decision |
| "quests that pay", "airdrop to these wallets", "one per person" | `grants`: a `prize` (an item, tokens, an NFT, or a roll); a `list` of wallets, or `vouchers` (a results server's public key: see `after-launch.md`); `limits`. A claim of a prize it can't give is refused and keeps its round |
| "rewards by rank", "1st gets 400, 2nd 250", "points to tokens", "each winner a different amount" | one grant whose `prize` is a fixed amount of tokens (the most any claim takes: 1st place's) paid by `vouchers` or a list: each voucher (or list leaf) names that claim's own amount, up to the grant's (`signVoucher({ …, amount })`, `app.claimGrant(key, { voucher })`); none named pays the grant's amount. A `list` written in xsolana.json does the same: each entry `{ wallet, amount }` names its own amount |
| "at most once a day each", "2 wins a day per wallet" | a grant's `limits.perWalletEach`: `{ "count": 1, "every": "1d" }` |
| "promo codes on flyers", "a code pays once", "QR claim links" | a grant with `keys` (the public key of each code's keypair: the page derives the keypair from the typed code and signs a voucher for the player's own wallet) and `limits.perKey: 1` |
| "holders of the ticket claim a free badge once" | an open grant: no `vouchers`, `keys` or `list`, a `gate` of the ticket, and `limits.perWallet: 1` (each ticket shown claims once too) |
| "bring your own NFT", "any NFT of a partner collection can play", "holders of X get" | a `gate` (or a farm's, or odds') rule with `collection`: the collection's address; the project's notes about each NFT (a level) go in its Sheet |
| "our own token, 10 million, we keep it", "a fixed supply", "a community token" | `source: "project"` with `supply`: going live mints all of it to the owner and turns minting off for good; pools are seeded from it |
| "our token", "the coin we already launched", "this mint" | `source: "existing"` with `mint` and `decimals` (ask for the address). loot doesn't put a token on a market: for trading, launch it on a token launchpad or an exchange first |
| "Token-2022", "a transfer fee" | `program: "token-2022"` and `powers.transferFeePercent` |
| "tokens only, no NFTs" | `"collection": false`: no collection is made (no collectibles; normal items and tokens work) |
| "mint into our existing collection", "two collections" | `collections`: Core collections the owner's wallet already controls (up to eight in all, with the project's own), each with the project added as an update delegate; an item's `collection` names the one it is minted into |
| "a second game or community from the same wallet" | `projectNumber`: 1, 2, … (the first is 0); each number is a project of its own |

Ask, in your first reply, for the numbers that define the product if the person hasn't given them: prices, supply, odds
or multipliers, and how much SOL they can put in (their budget sets every seed). Don't wait for the answers to build:
save a first draft that checks, with sensible, stated defaults (a farm's lock tier of
"1d", a grant's `perWallet: 1`), and say which, so they react to something concrete. When you weigh two designs,
save the one you recommend and say what the other would change. Only what the person alone can give (their coin's
mint, a vault's or a partner's address) is worth waiting for.

When loot can't do exactly what they asked, follow SKILL.md rule 9: `xsolana_examples {"query": "<that part, in their
words>"}` returns the limit and its nearest versions. Offer them with their costs, build the one they pick, and when
they push back offer the next one. Don't stop at "it doesn't meet your requirement".


## Worked example

The person: *"A fishing game: a cast costs 0.02 SOL. Most casts catch nothing, some land a Perch to keep, and 1 cast
in 50 hooks the Golden Carp, worth 0.5 SOL. 5% of every cast goes to a monthly prize draw."*

- **Pays**: a cast (a box). **Gets**: nothing (68%), a Perch collectible (30%), or 0.5 SOL from a pool (2%).
  **Money goes**: 5% to the draw's pot; they didn't say where the rest goes, so the draft sends 55% to the pond that
  pays the carp and leaves 40% to the treasury, and says so. **Decides**: nobody, but someone sends the monthly draw
  and pays its place when it is due: anyone can (a ticket holder from the page).
- `xsolana_examples {"query": "<their words>"}` gives the nearest spec to start from. The draft:

```json
{
  "version": 2,
  "network": "devnet",
  "name": "Lakeside fishing",
  "prompt": "A fishing game: a cast costs 0.02 SOL. Most casts catch nothing, some land a Perch to keep, and 1 cast in 50 hooks the Golden Carp, worth 0.5 SOL. 5% of every cast goes to a monthly prize draw.",
  "currency": "sol",
  "tokens": [{ "key": "sol", "source": "sol" }],
  "items": [{ "key": "perch", "name": "Perch", "uri": "https://example.com/perch.json", "active": false }],
  "pools": [{ "key": "pond", "currency": "sol", "seed": 2 }],
  "boxes": [{
    "key": "cast", "name": "Cast", "price": 0.02,
    "split": [{ "to": "pool:pond", "percent": 55 }, { "to": "lottery:monthly", "percent": 5 }],
    "outcomes": [
      { "gives": "nothing", "chance": 68 },
      { "gives": "item", "item": "perch", "chance": 30 },
      { "gives": "pay", "pool": "pond", "amount": 0.5, "chance": 2 }
    ]
  }],
  "lotteries": [{ "key": "monthly", "name": "Monthly draw", "price": 0.01, "places": [100], "every": "30d", "firstDraw": "publish+30d" }],
  "scenario": { "days": 30, "perDay": { "box:cast": 500, "lottery:monthly": 20 } }
}
```

- `xsolana_check` → ready, with `W-CHANCE-PRIZE` (say it) and `W-FEE` (the 0.002 SOL player fee is 10% on top of a
  0.02 SOL cast: say so, and that a higher price makes it a smaller part).
- `xsolana_simulate` → a cast costs about 0.0234 SOL in all and gives back 0.01 SOL in prizes on average (50%), plus a
  Perch 3 casts in 10; at 500 casts a day the treasury gets about 4 SOL a day. The pond takes in 5.5 SOL a day and
  pays out 5, but luck swings it about 4 SOL a week: on a 2 SOL seed a bad week stops the box selling, and the
  simulation suggests about 12.4. The monthly pot reaches about 21 SOL, because casts feed it as well as tickets.
- `xsolana_cost` → about 2.01 SOL to go live, in one wallet approval: 2 SOL is the seed, the rest rent and fees.
- `xsolana_explain` → the words for the person (`telling-the-person.md`): pass on the 40% treasury share you chose, the
  thin seed and the flags.
- The person: "start the pond with 12.5 SOL". Change the seed, check, simulate (the swing note is gone), explain:
  going live is now about 12.51 SOL. `xsolana_save`, and when they say so, `xsolana_publish` and the approve command.
