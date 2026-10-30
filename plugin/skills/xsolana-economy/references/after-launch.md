# After it goes live: who does what

Going live is the start. Before the person approves, tell them who sends each step the economy needs while it runs,
and what happens if nobody does. Most failures in practice are a raffle nobody draws, a contest nobody decides, or a
winner nobody pays.

## Who sends each step

| Step | Who can send it | If nobody does |
| --- | --- | --- |
| A box's roll and settle, a shop buy | the player, in their own purchase (`js/play` does both in one prompt) | anyone can settle a rolled order, a normal item too (the app's backend delivers it from the `OrderSettled` receipt of a finalized transaction whose `meta.err` is null, once per order: `loot.receipts(tx)` gives none for a transaction with an error, whose logs can still read as all-success; it reads the transaction again when its log is truncated); a roll that failed or never came refunds (`app.refund`) |
| A lottery draw, completing its contributions, paying its places | **anyone**: the page (`app.claims()` lists each available step), or a sweep. Paying a winner with no prize account opens it in the same transaction (the sender pays its rent) | selling stops at draw time. A result must be followed by completion of its contributions and payment of every place before the next round. A round nobody draws waits, with no deadline. If the oracle never answers a draw (7 days after it was asked for), anyone can cancel and refund each recorded buyer. An empty round moves on with the next ticket. A one-time lottery ends after its round |
| A schedule that is due (an emission, rent, a drip) | **anyone**: the page (`app.runSchedule`), a player, a sweep | it waits, and catches up one run at a time |
| Ending an auction | **anyone**: usually the winner, from the page | it waits: whenever it is ended, the lot goes to the highest bidder |
| A contest's entries back when it is off, or its winners' claims | **anyone** (each entry's money goes only to its player) | they wait; nothing is lost |
| Opening a contest | the **authority** (the owner's wallet by default) | nothing happens |
| Naming its winner, calling it off | the **authority**, or **anyone** sending a verdict one of its `deciders` signed (a results server's key: `decideIx` with `verdict`, after the Ed25519 check of `verdictBytes`) | after `resultDue` it is off by the clock and everyone claims back; a crowdfund short of its `minPot` when entries close is off at once |
| Moving tokens out of a pool, minting, a `decisions` payout, rewriting a collectible | the **authority** | nothing happens |
| A grant claim | the **winner** only, from the page: the winning wallet signs every claim, whatever proves it (a voucher, the list, an open grant); anyone may pay its fees, nobody claims for it | the prize waits for them |
| A prize given directly (a grant's, a lottery place's, a contest's, a mission's, a recipe's: an item, tokens, an NFT of a stash) | the winner's own claim (a grant's: the winner signs it), the place's payment, the winning entry's claim, the unstake or the craft: it is given in that transaction, the sender paying what it opens (a collectible's rent, the winner's token account) | a grant's claim or a craft of a prize it can't give is refused; a lottery's place, a contest's claim or a mission's end goes on without it (an NFT already given, an item sold out or switched off, a pool short pays what it holds) |
| A prize that is a roll of a box (a grant's, a lottery's place, a contest's winners, an auction's mystery lot, a mission's chest) | the winner's own claim (a grant's), the place's payment or the auction's end makes the winner's order (its rent goes back to the winner at settle); then **anyone** asks the oracle for the roll (`loot.askRollIx`, its fee the asker's) and **anyone** settles it (`loot.settleIx`), which hands over what it rolled, a stash's NFT included; `app.claims()` lists them | it waits, and is never refunded while it waits; asked and never answered, anyone asks again. What the box gives that has run out (an empty stash, a sold-out item) can't be won: the roll lands on its other outcomes, and a fixed prize its pool runs short of pays what the pool holds |
| Putting more NFTs in a stash, or taking one out | the **owner** (or the authority), holding them: add them to the stash's `nfts` and publish again (only the new ones go in), or `loot.stashIx` with `out` to any wallet | a stash nobody refills just runs out |

"Anyone" means the page can offer a button for it, and any player can press it. Build those buttons with `js/play`:
`app.claims()` lists what this player can finish now (a draw, its completion or cancellation, a payout, a refund, an
auction to end), and `app.claim(c)` sends one. A **sweep** is a server that sends overdue public steps for the
projects it watches. One may or may not be running for the person's project, so never rely on it: the page's buttons
are what finish them. A sweep never needs anyone's key but its own fee payer.

A lottery's ticket payments stay separate from the prize pot until the draw succeeds: cuts, referrals and burns run
after it. The buyer's share recipients are fixed when they buy; completing a successful contribution sends its shares
and its prize funding. Cancelling instead (only for a draw the oracle never answered) returns its entire ticket
payment and record rent to the recorded buyer, with no ticket split or burn; network and oracle fees stay spent. Prizes and
outside donations already in the prize pot stay there for the lottery; they are not ticket refunds. Each purchase is
a record of its own whose rent goes back to its buyer once it is completed (a winning one once its places are paid),
so a round has no limit on buyers.

Every account a payment goes to is opened by the transaction that pays it, and whoever sends it pays the rent: the
treasury's or a payee's account at a settle, a winner's at a payout, an outbid bidder's at the next bid. Nothing waits
on an account, and closing one (an unwrap of wrapped SOL) never stops a sale.

An NFT the project has no authority over is used as it is, with no import step, whatever its kind: Core, Token Metadata
(legacy, pNFT) or compressed (Bubblegum v2). Any of them can be staked, held, auctioned by the owner or authority,
and shown to gates and odds (a player auctions only an NFT of the project's own collection);
a compressed one is proven in the same transaction (`prove_leaf`, which the page does by itself from the RPC's DAS
methods). What the project writes about one (a level, a use) goes in its Sheet (`["sheet", project, nft]`), written by
the authority with `collectible` `Set`, by a farm's growth, or by anyone proving the traits the project vouched for
(`app.proveTraits`).

A new mission is a new farm: add it to the spec and publish again; `runs` ends it that long after it goes live. Near the end of a farm that shares its pool, fund it at least its release span (its longest lock, a day at least) before the end and refresh any seat you suspect is dead a span before it: what is not released by the end, and what a seat gives back after it, stays in the pool, the project's. If rewards cannot move, unstaking can explicitly forfeit them.

Changing a live box's roll (its outcomes, odds, `stockOdds`, `rollsOn`, `then`) fails every roll of it still waiting
(`W-LIVE-ROLLS`): a purchase gets its payment back, but a roll won on another route (a grant's, a mission's chest, a
lottery's place, an auction's lot) paid nothing in and refunds 0. Publish such a change once none waits, or make a new
box. Its price, rise, fall, split, switch, window and gate change freely. A set's way out (the recipe that unbinds it)
should take no `pay` line (`W-UNBIND-PAY`): a recipe with one waits while the project is paused or the platform
suspends it, and the pieces stay locked in their farm meanwhile.

Leaving a farm needs only the player's wallet, never a server's signature; what can still keep an NFT from coming
back is the NFT issuer's own controls (`telling-the-person.md`, NFT custody).

## The owner's own steps: an owner page

What only the authority can sign (open or decide a contest, pay out, move a pool) needs a page the owner opens and
approves in **their own wallet**, like the approve page. Build it with `@xgamesfun/solana/client` builders
(`openContestIx`, `decideIx`, `moveTokensIx`) and the wallet's `signTransaction`, served locally or on the same site
behind nothing more than the owner's wallet: the program checks the signature, so a page holds no secret.

- Show what each button does in words before the wallet asks ("Name the Owls the winner: the pot of 0.42 SOL is
  shared by 7 backers; 5% goes to you").
- Never put an owner's or authority's key in a page, a file or a server, and never ask the person to export one.

## Results from a game: who won, and paying them

When a game (not the chain) knows who won a match, cleared a quest or placed in a tournament, pay through a **grant**
the winner claims themselves. The grant's limits (per wallet in all and per window, per person, per key, per day, in
total, between two dates) are the most anything can ever pay out, whatever happens to a server.

- **A list** (an airdrop, a known set of winners): the owner writes the wallets in the grant's `list`; no server.
- **Promo codes, claim links**: the grant's `keys` are the public keys of one keypair per code (made offline from each
  code; only public keys go in the spec), with `limits.perKey: 1`. The player types the code; the page derives its
  keypair, signs a voucher for the player's own wallet, and claims (`app.claimGrant(key, { voucher })`). A code pays
  once in all; a signature someone copies pays only the wallet it names.
- **Show a badge, claim once**: an open grant (no `vouchers`, `keys` or `list`) with a `gate` and `limits.perWallet`:
  any wallet that shows the collectible claims, and each collectible shown counts too. No server.
- **Vouchers from a results server**: the grant names the server's public key in `vouchers`; the server checks the
  game's result and signs a voucher (for a grant of tokens, with each winner's own `amount`, up to the grant's: rewards
  by rank); the winner's page claims with it (`app.claimGrant(key, { voucher })`).
  - The server can be the person's own game server (`signVoucher` from `@xgamesfun/solana/results`). It holds only that
    voucher key, never the owner's. Set the grant's `total` and `perWallet`: they bound what a stolen voucher key can
    pay.
  - Or a **results server** the person runs or names. It checks results signed by the game's host key, which the
    owner certifies once by signing a text in their wallet; the game server and pages talk to it with
    `@xgamesfun/solana/results` (`report`, `giveaways`, `draws`), and winners claim what it vouched for with
    `app.claimWins({ server, token })` (`token`: the player's sign-in with that server, when it asks for one; a drop
    of NFTs from a stash gives one only at a signed-in claim, first come first served). Its voucher key is per
    project (`GET <server>/v1/voucher-key?game=<address>`): the project's address exists only once it is live, so go
    live first, then add the grant with that key and publish again. A grant written before then is saved switched
    off (`"active": false`, which `xsolana_check` reports as W-OFF): tell the person it waits for that key, and switch it
    on when the key goes in. Never use a key from `/v1/health`.
- **A random draw nobody can rig** (a free draw for members): a results server's computed draws (drand), or a lottery.

Per wallet per day ("2 wins a day each") uses `limits.perWalletEach: { "count": 2, "every": "1d" }`;
`perDay` separately counts all wallets together. A wallet can claim at most 256 distinct signed voucher rounds
within one grant incarnation, in any order. Plan a new campaign when that bound would be exceeded; changing
limits or voucher keys does not clear its history. Closing and recreating a grant starts a new campaign with new
receipts and invalidates old vouchers. A list written in xsolana.json pays each wallet once per grant incarnation: editing it lets newly added wallets
claim, never a wallet already paid (for repeated payouts, list the wallet again under a new `round`, or use vouchers). A results server must read the current grant incarnation when accepting
a result and include it in the voucher it signs.

## Before you act on what the person says happened

"It's been an hour", "the Owls won", "the pool is empty": read the chain first (`xsolana_status`, or the account itself), and
say what you found. The chain's clock and balances decide what can be sent now.
