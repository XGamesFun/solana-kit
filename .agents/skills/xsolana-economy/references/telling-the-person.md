# Telling the person what they get

The person reads your words, not the spec. After every change, run `xsolana_explain` on the spec as saved and turn it
into a few short lines, in this order. Describe what is in the spec, not what you meant to put there: when your words
and the spec differ (a limit, an amount, a key not set yet), change one of them before you answer. Use the tools' numbers; round them sensibly; name currencies by symbol.

1. **What each play costs and is worth.** Lead with the tools' "in all" number: "A cast costs about 0.0234 SOL in
   all (0.02 SOL, the 0.002 SOL player fee, the oracle and the network, and the Perch's rent when one is caught), and
   gives back 0.01 SOL in prizes on average (50%), plus a Perch 3 casts in 10." For a box of items, the odds; for a
   lottery, what the pot reaches and what each place wins; for a farm, a day of rewards per unit staked and what the
   lock tiers multiply.
2. **Where the money goes.** "55% of each cast goes into the pond that pays the Golden Carp, 5% into the monthly
   draw's pot, and the other 40% to your treasury."
3. **How the pools fill and drain.** "The pond takes in a little more than it pays out, but luck swings it about
   4 SOL a week: start it with about 12.5 SOL rather than 2, or a bad week stops casts until it refills." A pool that
   runs dry is the first thing to say. A prize bigger than its pool is left out of the roll until the pool fills, so
   the odds players are shown don't hold until then (`W-PRIZE-SEED`).
4. **What going live costs.** "About 12.51 SOL on devnet, in one wallet approval: 12.5 SOL is the pond's seed, the
   rest is rent and fees."
5. **Who does what while it runs** (`after-launch.md` has the table): what anyone can send (a draw, a schedule, an
   auction's end, claims), what only they can (a contest's result, a payout, a held item, a collectible's new level)
   and how often, and what happens if nobody does. If a payout rewards a result the game reports (a clear, a win,
   a score): "Checking that a player really did it is up to you, on your own server: a game runs in the player's
   browser, and the program trusts the authority's signature."
6. **Flags for the law.** `W-CHANCE-PRIZE`: "Players pay for a chance at money. That is gambling in many places once
   it is real money; this runs on devnet only." `W-CHANCE-ITEMS`: "Players pay for random items they can resell: some
   places treat that as gambling, and many require the odds to be shown." `W-REVENUE-SHARE`: "Stakers are paid from
   what players spend; regulators look at that when they decide whether a token is a security." Say them every time
   they are raised. Before they go live, every time: "The program isn't independently audited and comes as is, with
   no warranty: you use it at your own risk, and making sure this is legal where you offer it is up to you." The
   approval page shows all of this too, and keeps Approve off until the owner ticks that they read it.
7. **For an auction**, say how it ends, in their words: "The highest bid when the 48 hours are up wins. Each bid must
   be at least 0.5 SOL and 5% over the last; a bid in the last 10 minutes gives everyone 10 more. Whoever is outbid
   has their SOL back at once, in the same transaction. With no bid, the lot goes back (an item's unit is never
   made). Anyone can end it once it is over: the winner, or anyone, from the page. Nobody has to hurry: whenever it is ended,
   the lot goes to the highest bidder." Then the shill warning (`W-AUCTION-SHILL`): "Anyone can bid, you included, and the
   program can't tell a friend bidding the price up from a real buyer: a reserve is the honest way to set a floor."
   For a collectible they already hold: "It stays with the project until someone wins it or the auction ends."
8. **Anything else the checker warned about**, in a sentence each (a mint that can freeze accounts, a free box bots
   can drain, a grant with no limits or no funds).

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
- **NFTs the project has no authority over** (any collection but its own): they count as they are. Say that
  whatever their collection lets be written on an NFT (even by its holder) is what a gate or a boost reads, and that
  the project's notes about one (levels, uses) live in its Sheet, which the authority writes and pays for. Every
  route takes every kind of NFT: Core, Token Metadata (legacy, pNFT) and compressed (Bubblegum v2; a v1 tree is
  refused). Off-chain traits (a background) count only once proven into the NFT's Sheet against the root the project
  set (`traits`): say who proves them, and when.
- **Rolls that can fail**: a box, a mission or a recipe that can burn or give away the NFT it rolls on holds it from
  the moment the roll is made until it is settled. Say the odds in plain numbers, which stats raise them, and what a
  loss means (burned, or given to whom). Nobody can back out of a roll once it is made; anyone (the page, a keeper)
  asks the oracle for it and settles it.
- **NFT custody** (a farm, a mission): Escrow is the default: the NFT moves to the project while it is staked.
  Freeze keeps it in the player's wallet, locked, with the project the only key that unlocks it; a soulbound
  collectible needs Freeze. Watch holds nothing: say plainly that a staked NFT can be sold, that its seller then
  collects nothing more, and that its buyer can take the seat over. Only frozen or watched NFTs can be in two farms
  at once: a guild frozen, its missions watched. Either way the NFT issuer's own controls still apply: an issuer who
  can block transfers, or (under Freeze) one whose later metadata or plugin changes stop the unfreeze, can keep an
  NFT from coming back, and forfeiting rewards doesn't get around that. Never promise an unconditional exit.
- **A farm releases everything in its rewards pool** to its stakers, over its longest lock (a day at least), by
  weight as it is released: give each farm a pool of its own (`W-POOL-SHARED`). Whoever stakes first is credited all
  that is released while they are alone, so say early stakers share the first rewards among few. A farm that
  `runs` takes no stake at its end, and what it has not released by then stays in the pool, the project's, as does
  what a seat gives back after it: say to fund it at least its release span before the end, and to refresh a seat
  they suspect is dead (a watched NFT sold, an upkeep run out) a span before it. A sharing farm of a token with a
  great many base units (a memecoin) that pays a reward of few units rounds each seat's share to nothing
  (`W-FARM-ROUNDING`). A farm with
  a fixed `rate` pays the same to each NFT instead; minted, it grows the token's supply every day it runs, which
  is the person's to plan (say how much a day at the scenario's stake). A mint holds at most u64::MAX base units:
  near that a rate that mints pays less than its rate, then nothing, and what it can't mint is never owed later
  (`W-FARM-MINT-ROOM`, for a rate that could get there).
- **Levels written by staking are attributes on the NFT** (or in the project's Sheet of it, for an NFT the project
  has no authority over): marketplaces show them, anyone can read them, and the person's other mechanics can use
  them. They grow only when a seat is refreshed or the NFT leaves: the page refreshes (`app.refresh`).
- **Grants pay their claims' rent from their own funds** (`fund`, in SOL, held in the grant): the player pays the
  0.002 SOL player fee and the network fee to claim, once, even when the prize is a roll. A first claim of a token
  prize also opens the winner's account from the funds:
  `xsolana_simulate` gives the funds a claim needs. When the funds run out, claims still land: whoever pays for the claim
  (the winner, who always signs it, or anyone paying its fees for them) pays the rest. Only the winner can claim.
- **Never walk the person through creating, exporting or pasting a private key**, for anything (a keeper, a server,
  a bot). Public steps need no key of theirs (`after-launch.md`).
