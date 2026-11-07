# After it goes live: who does what

Going live is the start. Before the person approves, tell them who sends each step the economy needs while it runs,
and what happens if nobody does. Most failures in practice are a raffle nobody draws, a contest nobody decides, or a
winner nobody pays.

## Who sends each step

| Step | Who can send it | If nobody does |
| --- | --- | --- |
| A box's roll and settle, a shop buy | the player, in their own purchase (`js/play` does both in one prompt) | the player, a key the player named for the order (`settler`) or the project's owner or authority settle a rolled order, a normal item too (the app's backend delivers it from the `OrderSettled` receipt of a finalized transaction whose `meta.err` is null, once per order: `loot.receipts(tx)` gives none for a transaction with an error, whose logs can still read as all-success; a truncated log stays truncated when read again, so it then goes by the order's account); a roll that failed or never came refunds (`app.refund`) |
| A lottery draw, then each part pulled | **anyone**: the page (`app.claims()` lists each available step), or a sweep. The draw's ask fixes the round's money (what its places take of the pot, or of the round's own ticket money for a lottery with `rest`; each pool's prize) and opens the next round at once; paid from a pot, it first moves in what the round before left that pot, so the next round always sees it, whoever pulls and whenever. A pull pays one part into its owner's account, opened in the same transaction when it is not there (the sender pays its rent): an entry's own (a refund, a ticket back), its places' part of the pot or their prizes (a raffled NFT, an item, tokens, a roll), or a part owed in common (a share, what the places leave: to the pot, or to `rest`; a burned `rest` stays for the close to burn) | selling stops at draw time. A round nobody draws waits, with no deadline. Once drawn, every part waits in the round for its own pull, in any order, holding up nobody else; the pull that leaves nothing owed closes the round, and the rent of its record goes back to whoever fronted it (the lottery's `roundRent`, or its first buyer). An NFT that can't move is made a hold for its winner. If the oracle never answers a draw (7 days after it was first asked for), the next ask cancels it, and every buyer's refund is pulled; the page pulls the sender's own refund in the cancel's own transaction. A due round's draw rides in front of the next ticket purchase. An empty round moves on with the next ticket. A one-time lottery ends after its round |
| A schedule that is due (an emission, rent, a drip) | the project's owner or authority, or who it pays (a wallet, the treasury): `app.runSchedule` signed by one of them, or their sweep (a sealed burn: anyone) | **a run missed is missed**: one sent late pays once, for the latest run due, and the runs before it lapse, so keep a key of the project's sending it on time. Only a sealed schedule's fixed amount pays every run due (a backlog of years takes a few calls) |
| Ending an auction | **anyone**: usually the winner, from the page | it waits: whenever it is ended, the lot goes to the highest bidder. A seller whose account can't take the money then doesn't hold up the winner: the lot goes, the auction stays open owing it (`app.auctions()`: `delivered`, `proceedsOwed`), and the next end, anyone's, pays and closes it |
| Catching a farm up (`walk_farm`), when it has passed more of its seats' end times than a move can walk | **anyone**, for free: `app.claims()` lists it, `app.walkFarm(key)` sends it in parts (`app.farmWalk(key)` says how many) | moves of that farm fail until it is walked; nothing is lost by the wait: what each seat earned by its end is exact |
| A contest's entries back when it is off, or a winner's part of a contest with no prize or picks | **anyone** (each entry's money goes only to its player); a winner's first claim with a prize or picks: the **winner or the project's keys**, and past 30 days the project's keys may pick for them | they wait; nothing is lost. Each winner's part is written at the decision (the pot then, and a split prize's vault), so the order of claims changes nothing; tokens sent to the pot after it go to nobody (burned at the close), and a split prize's part a winner gives up goes back to its pool, not to later winners |
| Opening a contest | the **authority** (the owner's wallet by default) | nothing happens |
| Naming its winner, calling it off | the **authority**, or **anyone** sending a verdict one of its `deciders` signed (a results server's key: `decideIx` with `verdict`, after the Ed25519 check of `verdictBytes`); a winner only once entries close, a call-off any time | after `resultDue` it is off by the clock and everyone claims back; a crowdfund short of its `minPot` when entries close is off at once |
| Moving tokens out of a pool, minting, a `decisions` payout, rewriting a collectible | the **authority** | nothing happens |
| A grant claim | the **winner** only, from the page: the winning wallet signs every claim, whatever proves it (a voucher, the list, an open grant); anyone may pay its fees, nobody claims for it | the prize waits for them |
| A prize given directly (a grant's, a lottery place's, a contest's, a mission's, a recipe's: an item, tokens, an NFT of a stash) | the winner's own claim (a grant's: the winner signs it), the place's payment, the winning entry's claim, the unstake or the craft: it is given in that transaction, the sender paying what it opens (a collectible's rent, the winner's token account) | a grant's claim or a craft of a prize it can't give is refused; a lottery's place, a contest's claim or a mission's end goes on without it (an NFT already given, an item sold out or switched off, a pool short pays what it holds) |
| A prize that is a roll of a box (a grant's, a lottery's place, a contest's winners, an auction's mystery lot, a mission's chest) | the winner's own claim (a grant's), the place's payment or the auction's end makes the winner's order (its rent goes back to the winner at settle); then the **winner or the project's keys** ask the oracle for the roll (`loot.askRollIx`, its fee the asker's) and the winner, a key the winner named, or the project's keys settle it (`loot.settleIx`), which hands over what it rolled, a stash's NFT included; `app.claims()` lists them | it waits, and is never refunded while it waits; asked and never answered, they ask again. What the box gives that has run out (an empty stash, a sold-out item) can't be won: the roll lands on its other outcomes, and a fixed prize its pool runs short of pays what the pool holds. With nothing at all in stock, only the winner asks, and that ends the roll with nothing (an auction's mystery lot: the winning bid refunded); a roll whose answer finds nothing at all waits again, for a restock |
| Putting more NFTs in a stash, or taking one out | the **owner** (or the authority), holding them: add them to the stash's `nfts` and publish again (only the new ones go in), or `loot.stashIx` with `out` to any wallet | a stash nobody refills just runs out |

"Anyone" means the page can offer a button for it, and any player can press it. Build those buttons with `js/play`:
`app.claims()` lists what this player can finish now (a draw, its cancellation, a pull, a payout, a refund, an
auction to end), and `app.claim(c)` sends one. A **sweep** is a server that sends overdue public steps for the
projects it watches. One may or may not be running for the person's project, so never rely on it: the page's buttons
are what finish them. A sweep needs only its own fee payer for draws, refunds and returns; to settle or run a schedule, it needs a project key or a key the player named.

A round of a lottery is a record of its own, opened by its first purchase (the SOL the lottery holds for it,
`roundRent`, put in at setup by default and sized from the lottery's expected rounds and entries, pays its header, its
token accounts and each entry's bytes; with too little, its first buyer fronts the header and accounts, about 0.004 SOL
and up, and each buyer their entry; all back when the round closes, to whoever paid), and it holds its ticket money in
accounts of its own until each part is pulled: shares in common and burns run after the draw, and the pot holds only
what nobody is owed. While a round paid from a pot waits for the oracle, the next round's draw waits too: it needs that
round's answer to know what it left the pot. Each purchase adds an entry: funded by `roundRent`, the buyer pays only the fee and the price; a
buyer who pays its bytes themselves (about 0.0002 SOL) never gets them back (they go to the treasury when the round
closes). A share the
buyer chooses (a referrer) is paid as they buy. Cancelling (only for a draw the oracle never answered, or a round short of its least sale) owes every entry its
whole ticket payment back, with no split or burn; network and oracle fees stay spent. Prizes and outside donations
already in the pot stay there for the lottery; they are not ticket refunds. A round holds about 70,000 to 260,000
purchases, by how wide its entries are.

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

A new mission is a new farm: add it to the spec and publish again; `runs` ends it that long after it goes live. Near the end of a farm that shares what lands, fund it at least its release span (its longest lock, a day at least) before the end: what is not released by the end, and what a seat forfeits after it, stays in its rewards vault, where the authority may take back what is free (`loot.moveTokensIx` with `from: { Farm: [id] }`), never what the farm owes its seats. No seat needs a refresh at its end. If rewards cannot move, unstaking can explicitly forfeit them.

Changing a live box's roll (its outcomes, odds, `stockOdds`, `whenOut`, `rollsOn`, `then`) fails a purchase still waiting for its
roll, and an auction's roll lot, each of which gets its payment back at once (`W-LIVE-ROLLS`). Any other roll waiting (a
grant's, a mission's chest, a lottery's place, a recipe's) holds no payment and rolls on the box as edited: nothing spent is
lost. A roll asked and left unanswered 7 days can be refunded when it holds a payment or an NFT (its refund names the
box, whose count of draws waiting it leaves: `app.refund` does). A box that stops selling when an outcome runs out (the
default) sells again once the project restocks it (more units, tokens into its pool, NFTs into its stash) or edits it. Its price, rise, fall, split, switch, window and gate change freely. A set's way out (the recipe that unbinds it)
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
`perDay` separately counts all wallets together. A grant keeps every round it paid each wallet within one incarnation,
16 bytes a round (from the grant's funds), and each wallet's count in 28: one voucher may name several rounds, each
paid once, and the same voucher sent again later pays what a limit held back. Changing limits or voucher keys does not
clear its history. Closing and recreating a grant starts a new campaign with new records and invalidates old vouchers;
anyone may then close the old records (`loot.closeShardIx`), their rent to the owner. A grant for more than about
100,000 wallet-rounds names `wallets` (and `rounds`) so its records are kept in enough lists. A list written in xsolana.json pays each wallet once per grant incarnation: editing it lets newly added wallets
claim, never a wallet already paid (for repeated payouts, list the wallet again under a new `round`, or use vouchers). A list leaf names no grant or incarnation, so a grant closed and made again with the same list pays every listed round again: give a re-made grant a fresh list (new rounds); the approval page warns when a change does that. A results server must read the current grant incarnation when accepting
a result and include it in the voucher it signs.

## Before you act on what the person says happened

"It's been an hour", "the Owls won", "the pool is empty": read the chain first (`xsolana_status`, or the account itself), and
say what you found. The chain's clock and balances decide what can be sent now.
