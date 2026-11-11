# Telling the person what they get

The person reads your words, not the spec. After every change, run `xsolana_explain` on the spec as saved and turn it
into a few short lines, in this order. Describe what is in the spec, not what you meant to put there: when your words
and the spec differ (a limit, an amount, a key not set yet), change one of them before you answer. Use the tools' numbers; round them sensibly; name currencies by symbol.

1. **What each play costs and is worth.** Lead with the tools' "in all" number: "A cast costs about 0.0234 SOL in
   all (0.02 SOL, the 0.002 SOL player fee, the oracle and the network, and the Perch's rent when one is caught), and
   gives back 0.01 SOL in prizes on average (50%), plus a Perch 3 casts in 10." For a box of items, the odds; for a
   lottery, where its places are paid from (its pot, which gifts and what earlier rounds left fill, or each round's own
   ticket money, which nothing from outside can change), what that reaches and what each place wins; for a farm, a day of rewards per unit staked and what the
   lock tiers multiply.
2. **Where the money goes.** "55% of each cast goes into the pond that pays the Golden Carp, 5% into the monthly
   draw's pot, and the other 40% to your treasury."
3. **How the pools fill and drain.** "The pond takes in a little more than it pays out, but luck swings it about
   4 SOL a week: start it with about 12.5 SOL rather than 2, or a bad week stops casts until it refills." A pool that
   runs dry is the first thing to say. A prize bigger than its pool is left out of the roll until the pool fills, so
   the odds players are shown don't hold until then (`W-PRIZE-SEED`).
4. **What going live costs.** "About 12.51 SOL on devnet, in one wallet approval: 12.5 SOL is the pond's seed, the
   rest is rent and fees."
5. **Who does what while it runs** (`after-launch.md` has the table): what anyone can send (a draw, an
   auction's end, claims), what only they can (a contest's result, a payout, a held item, a collectible's new level, each run of a schedule that isn't sealed: without them or a server holding a project key, an emission stops)
   and how often, and what happens if nobody does. If a payout rewards a result the game reports (a clear, a win,
   a score): "Checking that a player really did it is up to you, on your own server: a game runs in the player's
   browser, and the program trusts the authority's signature."
6. **Flags for the law, once.** `W-CHANCE-PRIZE`: "Players pay for a chance at money. That is gambling in many places once
   it is real money; this runs on devnet only." `W-CHANCE-ITEMS`: "Players pay for random items they can resell: some
   places treat that as gambling, and many require the odds to be shown." `W-REVENUE-SHARE`: "Stakers are paid from
   what players spend; regulators look at that when they decide whether a token is a security." `W-TOKEN-SALE`:
   "People pay for a share of a new token; selling a token to raise money is what securities law looks at first."
   Say each once, the
   first time the checker raises it; then leave them, saying them again only when the person asks or a flag of a new
   kind appears, and keep them out of pages and apps unless asked. The approval page shows them, with the program's
   status (not independently audited, as is, at their own risk, theirs to make legal where they offer it), and keeps
   Approve off until the owner ticks that they read it.
7. **For an auction**, say how it ends, in their words: "The highest bid when the 48 hours are up wins. Each bid must
   be at least 0.5 SOL and 5% over the last; a bid in the last 10 minutes gives everyone 10 more. Whoever is outbid
   has their SOL back at once, in the same transaction. With no bid, the lot goes back (an item's unit is never
   made). Anyone can end it once it is over: the winner, or anyone, from the page. Nobody has to hurry: whenever it is ended,
   the lot goes to the highest bidder." Then the shill warning (`W-AUCTION-SHILL`): "Anyone can bid, you included, and the
   program can't tell a friend bidding the price up from a real buyer: a reserve is the honest way to set a floor."
   For a collectible they already hold: "It stays with the project until someone wins it or the auction ends."
8. **Anything else the checker warned about**, in a sentence each (a mint that can freeze accounts, a free box bots
   can drain, a grant with no limits or no funds).
9. **What a cheater gets**, from `xsolana_review`, before the owner approves: for each route paid on a server's
   voucher, which level it uses (the server decides, replays or only bounds the result), what one cheater gets there
   (its ceiling, and what the prize goes on to earn), and what the stronger level would cost to build: "A script that
   waits as long as a player would gets each reward NFT once per wallet, and each then earns tokens every day with no
   end; having the server replay each run would stop forged runs, and needs the game to be deterministic." Then each
   high finding and its fix. The person chooses the trade-off (`trust-and-cheating.md`).

## What stays the project's job

Say these whenever the spec has the part they name, before the person goes live. The program holds the rules and the
money; it holds no files and serves nothing.

- **Images and metadata are off the chain.** An item's `uri` points at a file the project hosts; the program keeps no
  images. A fresh item's `uri` with `{attribute}` in it (`https://…/hero/{color}/{power}.json`) becomes a different link
  for every value drawn: the project hosts a file for every value a table or range can give (every row's label, every
  number from `min` to `max`), or a server that renders them on request. A link with nothing behind it is a card
  that shows no picture, for good.
- **Large tables cost rent the owner pays, never back**: about 8 bytes a row of numbers and 40 a row of labels, at
  5,080 lamports (0.00000508 SOL) a byte: 1,000 labels about 0.2 SOL, 100,000 numbers about 4.1 SOL. Quote
  `xsolana_cost` for the real figure.
- **A pack's cards each cost a collectible's rent when settled.** Whoever settles pays what the settle mints: Core
  keeps about 0.0031 SOL in each card the player gets. The page lends its throwaway settle key 0.006 SOL for each Core
  card it may mint, in the purchase's one prompt, and the key sends back what it didn't spend. A plain compressed card
  costs none. A pack of fixed cards (nothing random) is bought in one step, its cards minted in the purchase; a pack
  too big for one transaction settles in parts (about 14 Core cards a part), which the page sends.
- **When an outcome runs out, the project chooses what its box does (`whenOut`), and should hear the trade-off.**
  An outcome runs out when its item sells out, its pool can't cover its whole prize, or its stash empties. With
  `"stopSales"` (the default) the box isn't sold while any outcome couldn't cover this purchase and those still waiting
  for the oracle: every roll is on the odds written, nobody can buy their way to a rare once the commons are gone, and
  the project restocks or edits the box to sell again (a pool holds its prize for every draw waiting; a named NFT is in
  one waiting purchase at a time). With `"drawLeft"` the box keeps selling and draws among what is left, by the written
  weights: the others' chances rise as one runs out, so anyone watching the stock can empty a common outcome and then
  open for the rare at better odds. With `"giveNothing"` the box keeps selling on the odds written, and a draw that lands
  on an outcome that is out gives nothing: a paid draw is not refunded, a free roll is over, and anyone who empties a
  source the box shares makes its rolls miss. Put it as: "stop selling keeps your odds honest and refunds a miss; keep
  selling never stalls but lets a player tilt the odds; give nothing keeps the odds and never refunds". Under
  `"stopSales"`, a roll another route gives (a grant, a mission, a recipe, a lottery's place) is still given after the
  box has stopped, and is asked again until it hits, so with one outcome dry it always ends on what is left. A box
  selling a rare prize keeps the default; `drawLeft` suits a box of alike prizes, or one only other routes roll (a
  grant's, a mission's), where nothing is sold. `xsolana_check` says what each does to the
  box (W-WHEN-OUT, W-OUT-OF-STOCK, W-PRIZE-SEED, W-STASH) and `xsolana_simulate` the day it stops or each outcome runs out.
- **A prize the program can't give right now is out of stock, not an error.** A prize in a token with a transfer hook
  (or confidential transfers) is never moved by a roll. An outcome emptied by another route after a purchase (another
  box sharing its pool, item or stash) can't be given: a draw that lands on it is not made, no other outcome takes its
  place, and that draw's worth of the price goes back at the settle. With no draw made a paid open is refunded and a
  free roll waits to be asked again, and a box with nothing in stock is refused (SoldOut).
- **The oracle's answer reads at most 21 accounts**, so a box's distinct prize accounts (its items, pools, stashes,
  the mints and vaults of its tokens, a fresh item's tables) are bounded by that, however many outcomes it has.
  `xsolana_check` counts them. One answer also holds only so much of a box (measured: 128 outcomes that give
  nothing, 29 of token amounts, 18 each of its own item; 41 slots; 72 odds rules; 16 token prizes or 18 collectibles
  in one outcome; 340 texts in a gate; fewer where outcomes name pools or stashes, since the write counts finding
  each one's address): a box past that is refused when written. Put a long weighted list in a table
  or a stash, drawn by one outcome.
- **The program takes any time, and the checker says a far one's date in words (W-FAR-TIME).** A time that looks like
  milliseconds, or lands more than three years out, locks the bids, tickets, NFTs or vault that wait on it until then.
  Read the date to the person before they sign.
- **Much of what the program used to refuse is the project's own choice now, warned of in words, never refused**: a
  price or a prize of 0, a mission with no lock, a contest of NFTs whose winners take none of the losers' NFTs, a
  sealed schedule of any length paying any address the program doesn't own, a lottery, contest or auction in a token a
  player can hold a payment up in (a frozen default, confidential transfers), a farm that mints a token the project is
  not yet the authority of (it pays nothing until it is, and that time is never paid). Tell the person each warning
  `xsolana_check` gives, in its own words.

Don'ts:

- Don't show mints, account addresses, PDAs, lamports or instruction names unless asked.
- Don't promise returns, profits or "passive income". Say what the program does, with the numbers.
- Don't hide a gap: if loot can't do what they asked, the first line says so and offers the nearest thing.
- Ask one question at a time, and only when the answer changes the spec (an existing coin's mint, a referrer's
  address, how often they expect players to play).
- **Wrapped SOL cannot be burned**: burn a token the project mints or an existing coin, never SOL.
- A **box or payment in a currency other than the project's** works like any other: what its split leaves goes to the
  treasury wallet, in that currency.
- **Prizes paid from a pool** need something filling it (a seed, a split, a schedule): the checker warns `W-POOL-DRY`
  otherwise, and until it is filled those prizes pay nothing.
- **A token the project mints** (`source: "project"`) is how points, tickets, attempts and shards work; an existing coin
  needs its mint address and decimals from the person (ask; never guess an address).
- **A token the setup makes is named on chain as it goes live**: its `name`, its `symbol` and its `uri` (a link to a
  JSON file the project hosts, `{ "name", "symbol", "image": "https://…" }`), which is what wallets and explorers show.
  Ask for the name, the ticker and a picture before going live: with no `uri` it shows by name and ticker with no
  picture. Only the owner's wallet can change the three later (Token Metadata's rule, not loot's), and these tools
  don't change a live token's yet, so get them right first. The record costs about 0.014 SOL (`xsolana_cost` says it:
  rent, and 0.01 SOL Token Metadata keeps). A token that went live before the tools wrote one has none and
  can't be given one: only a mint's own authority can name it, and its minting was handed on or turned off.
- **NFTs the project has no authority over** (any collection but its own): they count as they are. Say that
  whatever their collection lets be written on an NFT (even by its holder) is what a gate or a boost reads, and that
  the project's notes about one (levels, uses) live in its Sheet, which the authority writes and pays for. Every
  route takes every kind of NFT: Core, Token Metadata (legacy, pNFT) and compressed (Bubblegum v2; a v1 tree is
  refused). Off-chain traits (a background) count only once proven into the NFT's Sheet against the root the project
  set (`traits`): say who proves them, and when.
- **Rolls that can fail**: a box, a mission or a recipe that can burn or give away the NFT it rolls on holds it from
  the moment the roll is made until it is settled. Say the odds in plain numbers, which stats raise them, and what a
  loss means (burned, or given to whom). Nobody can back out of a roll once it is made; the player or the project's keys ask the oracle
  for it, and the player, a key they named or the project's keys settle it.
- **NFT custody** (a farm, a mission): Escrow is the default: the NFT moves to the project while it is staked.
  Freeze keeps it in the player's wallet, locked, with the project the only key that unlocks it; a soulbound
  collectible needs Freeze. Watch holds nothing: say plainly that a staked NFT can be sold, that its seller then
  collects nothing more, and that its buyer can take the seat over. Only frozen or watched NFTs can be in two farms
  at once: a guild frozen, its missions watched. Either way the NFT issuer's own controls still apply: an issuer who
  can block transfers, or (under Freeze) one whose later metadata or plugin changes stop the unfreeze, can keep an
  NFT from coming back, and forfeiting rewards doesn't get around that. Never promise an unconditional exit.
- **A farm releases everything that lands in its own rewards vault** to its stakers, over its longest lock (a day at
  least), by weight as it is released. Something must send it rewards: its `seed`, a share `"farm:<key>"` of a sale,
  or a schedule that pays or mints into `"farm:<key>"` (`W-FARM-DRY` when nothing does). Whoever stakes first is
  credited all that is released while they are alone, so say early stakers share the first rewards among few. A farm
  that `runs` takes no stake at its end, and what it has not released by then stays in its vault (the authority may
  take back what is free there), as does what a seat forfeits after it: say to fund it at least its release span
  before the end. What a seat earned by its term (`earnsFor`) or its fuel is exact however late it is next touched, and
  nobody has to act at that time. Such a farm keeps a record of those times: each new one costs whoever writes it 44 bytes
  of rent (about 0.00022 SOL), not refunded on leaving. A sharing farm of a token with a
  great many base units (a memecoin) that pays a reward of few units rounds each seat's share to nothing
  (`W-FARM-ROUNDING`). A farm with
  a fixed `rate` pays the same to each NFT instead; minted, it grows the token's supply every day it runs, which
  is the person's to plan (say how much a day at the scenario's stake). A mint holds at most u64::MAX base units:
  near that a rate that mints pays less than its rate, then nothing, and what it can't mint is never owed later
  (`W-FARM-MINT-ROOM`, for a rate that could get there).
- **Levels written by staking are attributes on the NFT** (or in the project's Sheet of it, for an NFT the project
  has no authority over): marketplaces show them, anyone can read them, and the person's other mechanics can use
  them. They grow only when a seat is refreshed or the NFT leaves: the page refreshes (`app.refresh`). A boost that reads a level the farm's own growth writes counts each level from when it is written, so a seat refreshed often earns more than one refreshed rarely: have the page or a keeper refresh seats (anyone may, for free).
- **Grants pay their claims' rent from their own funds** (`fund`, in SOL, held in the grant): the player pays the
  0.002 SOL player fee and the network fee to claim, once, even when the prize is a roll. A first claim of a token
  prize also opens the winner's account from the funds:
  `xsolana_simulate` gives the funds a claim needs. When the funds run out, claims still land: whoever pays for the claim
  (the winner, who always signs it, or anyone paying its fees for them) pays the rest. Only the winner can claim.
- **Never walk the person through creating, exporting or pasting a private key**, for anything (a keeper, a server,
  a bot). Public steps need no key of theirs (`after-launch.md`).
