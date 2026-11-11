# Changelog

The version of `@xgamesfun/solana` is the version of the loot program it is built for; `release.json` pins that
program's exact build, its IDL and this client. Changes to the program itself are summarised here only where the
tools see them.

## 0.27.1: every route that hands out an NFT finishes without one that is gone, whatever its kind (loot 0.27.0, unchanged)

The JavaScript alone: the program, its IDL and every account are 0.27.0's.

0.27.0's tools closed a hold, a loan, a listing and an order whose NFT the project no longer holds (its collection took
it back or burned it). Four routes were left: a lottery's pulls, a contest's claims, an auction's end and `unraffle`.
Where the program reads the NFT itself (a ticket whose price sends it on, an auction's end, a stash), a Core and a
compressed NFT already finished, and a Token Metadata NFT mostly did not: one taken was passed without the account
that shows it gone, and one burned was refused as a semi-fungible item before anything was sent. Where the program
only hands the NFT out and reads nothing first (a ticket going back to its buyer, a place's NFT, a contest's NFT, a
topped bid's NFT), the route failed for every kind. Each now finishes, for a Core, a Token Metadata and a compressed
NFT, taken or burned, and nothing says the NFT moved.

What `js/play` now does:

- **`claims()`** flags a `pull`, a `contest` and an `auction` whose claim would hand out an NFT that is gone: it
  carries `gone` (true), `assets` (those NFTs) and `says`, what claiming does about each in words. Before, it said
  "take what you are owed", "your NFT back" or "take your lot back" for an NFT that could not come.
- **`claim(c)` of a lottery's part** (`pull`, `payout`, the pull a cancelling `reveal` or `cancel-draw` carries, and
  what `claimAll` sends):
  - a ticket whose price sends it on (burned, given, stashed) passes what proves it gone: its part settles and nothing
    moves (`NftGone`, the round its record). A Token Metadata ticket failed there before;
  - a ticket going back to its buyer (a round called off, a lottery that returns its tickets) and a place's NFT (the
    lottery's own stash's, or a project stash's named one) are passed as their hold, `["hold", nft, 0]`, and a
    `release` on the proof follows the pull in the same transaction when it fits: the hold closes, nothing is sent,
    and the signer gets the hold's rent back at once (`NftGone`, the hold its record). The round then closes as it
    would have. Before, that pull failed for every kind, and the round stayed open;
  - one pull of several places' NFTs with one of them gone makes holds of them all (a pull makes holds of all or of
    none) and releases each: the one gone closes, the others go to their winner.
- **`claim(c)` of a contest of NFTs**: an entry's own NFT that is gone (a contest that is off, or a winner's), and a
  loser's NFT a winner picks, are passed as their hold and closed on the proof the same way, so the entry is claimed
  and the contest can close. Before, that claim failed for every kind. A winner's picks now go first to the losers'
  NFTs the project still holds (the first 8 left are read); `take` still names one.
- **`endAuction`, `callOffSale` and the end `claim` sends**: a lot or an NFT of the winning bid that is gone is read
  with what proves it, whatever its kind. A burned Token Metadata lot or bid no longer stops the end, and after a lot
  went first, the second end passes a taken NFT of the bid over and pays the rest (before, the money waited). The
  result says what the end did, in `gone` (true) and `says`: a lot gone with no bid (nothing went home and the auction
  closed), a sale called off, or the project's own lot, or a lot sent first, ended without that NFT. A hold made at
  the end whose NFT goes before its release is closed on the proof, and `releases` says so for it (`asset`, `gone`,
  and `closed`, the signature).
- **`bid`** over a high bid of NFTs one of which is gone: that NFT can't go back, so the bid makes it a hold for its
  bidder and closes the hold on the proof in the same transaction. Before, no bid could top such a bid.
- **`unraffle(id, nft)`** of an NFT that is gone takes its row out of the lottery's own stash on the proof, and nothing
  is sent (`NftGone`, no `Stashed`): a Token Metadata NFT's too, which failed before. Only the project's owner or
  authority may, as before: the program refuses anyone else (`NotAuthority`).
- **`closeGone(asset)`** also takes the NFT's row off each of the project's stashes that lists it, for anyone and for
  nothing: no roll then draws it, and a prize that names it is passed over. It returns those stashes in `unstashed`
  (each its `address` and `id`; always there, empty when none), beside `closed`. A lottery's own stash that lists the
  NFT is left alone and named in `waits` (its `kind` is `lottery-stash`, with its `address` and its `lottery`): that
  row is the project's keys' to take out (`unraffle`). This costs one more search a call, of the project's stashes,
  which returns each of them whole (36 bytes for each NFT a stash lists).

What the receipts say: where the program reads the NFT itself (a ticket's price, an auction's end, a stash), it writes
`NftGone` or `SaleCalledOff` and nothing else about the NFT. Where it makes a hold first, it writes that hold's
receipts (`Held`, and `PrizeGiven` for a place's prize) before the release's `NftGone`. Read `NftGone` for that hold as
the NFT not given: no `Released` follows it.

## 0.27.0: a record whose NFT is gone closes, and a deposit clears what an earlier owner left (loot 0.27.0, on devnet since 2026-11-11, slot 521,001,695)

The program, 0.27.0: two changes. No stored record changed shape and no instruction's arguments or accounts changed:
every account made under 0.26 reads as before, and a 0.26 client's instructions land. The IDL gains one receipt,
`NftGone { project, record, asset, by }`.

- **A record whose NFT is proven gone closes.** Whoever controls a collection the project does not can take an NFT
  out of the project's hands, or burn it, while a hold, a loan, a listing or an order has it. That record then stayed
  open for good, with its rent, and an order's payment with it. Now the instruction that would have moved the NFT,
  sent with the same accounts, finishes without it and writes `NftGone`:
  - `release`: the hold closes, sent by anyone at any time, also while it runs and for a loan before it is due, for no
    fee. Its rent goes to whoever paid it. A loan's debt ends unpaid: the borrower keeps what they borrowed.
  - `refund` and `settle` of an order whose box holds the NFT it rolls on: the payment goes back, or is split as
    rolled, and the NFT is not moved. A stash's NFT the roll won that is gone is not given: `PrizeForgone` beside
    `NftGone`.
  - `close_listing` by its maker and `take_listing` by anyone (nothing paid, no fee): the listing closes, its rent to
    its maker. While a rental runs it is kept: a stranger's take is refused, the maker's close only stops the listing,
    and it closes once the rental has run.
  - `stash` out: the row of a gone NFT comes off, for anyone on a project's stash; a lottery's own stash stays the
    project's keys'. A lottery `pull` of an NFT ticket that is gone settles its part and moves nothing.
  - Gone is proven, never guessed: a Core asset itself (held by another, or burned); the token account that holds a
    Token Metadata NFT now, or its mint with none left; a compressed NFT's record, proven again. A frozen NFT the
    project still holds is held, not gone, and goes the way it always went.
  - What stays: a record nobody closed can still take its NFT if the NFT comes back into the project's hands under
    another record first. That is why a deposit now closes them first (below).
- **The weight that leaves a farm gives its share of the rounding back** to the project (`Farm::free_share`). Before,
  the seats that stayed were credited all of the farm's carry, the leaver's part too. A player's numbers do not change
  in any way a client shows; what a farm holds free can be a few whole reward units higher after a large seat leaves.
  Walking an end costs a little more compute for it: up to some 3,150 units an end at the dearest farm (a halving rate
  and seats of 4 × 10^16 base units at a ×100 tier), 2,270 with light seats.

What `js/play` now does:

- **`claims()`** lists a hold of the wallet's, and a loan it made or took, whose NFT the project no longer holds: at
  any time, also while the hold runs, as a `release` flagged `gone`, with `says`, what closing it does in words (the
  hold closes, its rent goes back to whoever paid it, nothing is sent, and for a loan nothing is repaid). Before, only
  a hold that was over was flagged, and nothing could be done with it.
- **`claim(c)`** of such a claim sends the `release` on the proof and returns its signature: the hold closes. Before,
  it threw.
- **`repay`** of a loan whose NFT is gone still takes no payment and signs nothing; its refusal now says the loan
  can be closed for nothing, and how (`claims()` lists it for both sides, `claim` closes it).
- **`unlist(asset)`** of a listing whose NFT is gone closes it on the proof (the maker's `close_listing`): its rent
  comes back and nothing is sent. Before, it failed.
- **`closeGone(asset)`**, new: anyone closes an NFT's holds and its listing once the project no longer holds it.
  Nothing is sent or paid; the sender pays the transaction's fee, and each record's rent goes to whoever that record
  names. A listing whose rental still runs is left and named in `waits`.
- **`buyListing` and `rentListing`** refuse a listing whose NFT is gone, in words, before anything is signed. Sent
  all the same, the take would now only close the listing.
- **`listing(asset)`** flags such a listing `gone` (one more read). **`listings()`** flags it from one read of all the
  listed NFTs: a Core asset held by another or burned, a Token Metadata NFT whose token left the project's account.
  A compressed NFT is not read there (an indexer's answer for each): `listing(asset)` says it for one.
- **The deposit guard clears what an earlier owner left, then deposits.** `hold`, `stakeNft` in escrow, `borrow`,
  `enter` with an NFT, `bid` with NFTs, `listForSale`, `listForRent`, a ticket paid with an NFT, a box or a mission
  that rolls on one: each used to refuse while an earlier owner's hold or listing of the NFT was open, unless told
  `acceptLeftover: true`. Now each leftover hold is closed by `release` and a leftover listing by `take_listing`, on
  the proof that the player holds the NFT, in front of the deposit: in the same transaction when both fit one, in a
  transaction of their own before it when they do not, after a dry run. The closes cost the player their transaction
  fee only; each record's rent goes to whoever that record names, never to the player. Only what can't be closed
  still refuses, with the same words: a listing whose rental still runs (the program keeps it until the rental has
  run). `acceptLeftover: true` still goes ahead. NFTs of the project's own collections are not read, as before.
- **`collect`** of an order one of whose NFTs is gone settles without it and says so: `gone` lists those NFTs, and a
  stash's NFT won that was not given is null in `assets` (read `PrizeForgone` as not given). **`refund`** of an order
  whose NFT is gone pays back all the same.
- **A farm's walk** carries 400 ends a transaction (`WALK_PER_TX`, 500 before, which was measured with light seats
  only) and a move walks up to 300 first (`MOVE_WALK_ROOM`, 400 before): what fits 1,400,000 compute units at the
  dearest farm, with 100,000 and 400,000 units to spare. `walkFarm` and `claims()` count their transactions by it.

The client and the rest:

- `piece` takes `tokenMetadata.evidence` (the token account that holds a Token Metadata NFT now, or its mint once
  burned), which goes in the receiver's token account's place on every builder that moves an NFT out of the project;
  a Core asset and a compressed NFT need nothing new (the same accounts, a compressed one proven again).
  `takeListingIx` passes it for a rental too. `compressedFromDas` reads a burned NFT (`burnt`) as its empty leaf, so
  `proveLeafIx` proves it burned.
- `loot.receipts` decodes `NftGone` like any receipt. `docs/program.md` has the new section, "An NFT gone from the
  project", a line under each instruction it touches and the receipt; `docs/nfts.md`, the checker's warning of a
  collection the project does not control, the guide and the skill say the new rule.
- `scripts/devnet-e2e.mjs` has a scenario `gone`: a collection whose controller takes an NFT back out of a hold, and a
  third wallet's close of that hold.

## 0.26.4: a live token's name, ticker or link can be changed (loot 0.26.1, unchanged)

The JavaScript alone: the program, its IDL and every account are 0.26.1's.

- **A change to a live token's name, ticker or link is written to its record at the next approve** (Token Metadata's
  UpdateMetadataAccountV2, signed by the owner, the record's update authority; `updateFungibleMetadataIx`). It costs
  a transaction: no rent, no fee to Token Metadata, no project fee. This is how a token that went live with no
  picture gets one. A fixed supply's record changes the same way: turning minting off does not freeze its name.
- **Which tokens have a record to write is read from the chain as the change is approved** (`readRenames`), never
  taken from the file: a file from any earlier release works as it is. A record is written again only when the spec
  gives a name, ticker or link otherwise than it was published with, the record says something else, and it is still
  the project owner's to change. The same names spelled out (a ticker the spec used to leave to its key) send nothing.
- **A name the chain can't take is said, and never recorded as published.** A token that went live before setups
  named tokens (0.26.1 and earlier) has no record and can't be given one. A record its owner handed to another
  wallet, made unchangeable, or gave a royalty, creators, a collection or uses outside these tools is left as it is
  (writing its words from here would take those away, or be refused). Nothing is sent for such a token, the rest of
  the change goes through, and the file keeps the name the token was published with: the approval page says why at
  each approve, also when the name is the only change (it then says nothing was sent, not that it landed), until the
  spec gives the old name back. `xsolana_publish` and `xsolana_cost`, which do not read the chain, list the change
  as one sent only if the record can be written, and say that approving reads it first.
- **A name edited while a setup or a change was cut short is written when it is gone on with**, also when the
  transaction before it landed unseen: a transaction found landed from an earlier run is recorded, the chain is read
  for the names, and only then is the file recorded as live. A name that landed is not sent twice, and one changed
  again since is: a name put back to what was published, after its change was written and before the change was
  finished, is written back. A name the record already carries (written by another tool) sends nothing and becomes
  the published one in the file, so no tool keeps announcing it.
- **A change cut short goes on as what the file says changed now.** A part added to the spec since is published
  with the rest, never recorded as live unsent. A change of which nothing was sent that could land (the node refused
  it) leaves the file as it was, not marked as under way. A file an earlier build left marked as under way with
  nothing to do is recorded as live once a wallet connects; until then the page does not call it done.
- **A setup cut short after the project's own step makes the rest when it is gone on with**: the accounts the
  economy pays into and the project's lookup table (added to at its own address, of the slot it was made at). Before,
  those were planned only while the project was not there, the file was recorded as live in the middle of the batch
  and then left marked as under way for good. A transaction still looked for that made the lookup table no longer
  makes the file fail its own schema (`live.pending[].made.tables`). A table an earlier release found made without
  keeping its address is left as it is, and the setup finishes (every approve failed on it otherwise). With no
  recent slot to make a table at (the chain's slot hashes do not read), a setup that needs none is recorded as live
  without it. Steps a transaction found landed has done are not shown as left under a refusal.
- The byte limits and the blank-name refusal apply to a live token whose name, ticker or link is changed, since the
  new words are written to a record; what it went live with stays a label, held to nothing.
- `parseRecord` (`chain/metadata.js`) reads a Token Metadata record: its update authority, mint, name, ticker, link,
  royalty, how many creators, whether it names a collection or uses, and whether it can still be changed. A record's
  own words are shown in quotes, with nothing in them that closes one, turns the text around or takes no room.

## 0.26.3: a token made elsewhere is read from the chain, and one place to choose a token (loot 0.26.1, unchanged)

The JavaScript alone: the program, its IDL and every account are 0.26.1's.

- **`xsolana token <mint>` (`xsolana_token`)** reads a token made elsewhere and gives its ready `tokens` entry: name,
  ticker, decimals, token program, and `powers` filled in (who can mint more, a freeze authority, a transfer fee and
  whether it can be raised, a transfer hook, a permanent delegate, a close authority, a pause, accounts that start
  frozen, a token that can't be transferred, confidential transfers), with each in words. Before, the person looked the
  mint up and typed them. It reads the mint and its name record only, never the link the record names; the hosted
  server offers it too. In code: `powersOf` (`js/chain/token2022.js`) and `tokenEntry` (`js/chain/mint.js`).
- **Going live holds a named mint's powers against the chain.** A power the spec denies and the mint has (`"freeze":
false` on a mint with a freeze authority, `"mintAuthority": "none"` on one somebody can mint, a transfer fee lower
  than the mint's) is refused before anything is sent: the checker's warnings were worked out from the spec. A power
  the spec says nothing of is not refused: the approval page says it, in the block the owner ticks before approving.
  So are a mint the spec calls the project's whose authority is not the project's yet, a mint paused now, and one
  whose amounts wallets show scaled. **No batch is handed out until the page has shown those lines**: the wallet's
  own state must be on the page, a line that appears after the box was ticked clears it, and the server refuses a
  batch asked for without the lines it read (`read`, from the state).
- **A transfer fee is read as it is now.** A mint holds the fee in force and the one to follow from an epoch on: with
  the chain's epoch (the tool and the approval ask for it) a fee since lowered reads at its new rate; without it, the
  higher of the two.
- **A coin's own name is a label.** `xsolana_token` gives the name and ticker as the entry has them: on one line, cut
  to a spec's lengths, in quotes, as the token's own words and never the tool's. It also says a mint paused now, and
  amounts that wallets show scaled (`mintState`), and takes a `project` to read a mint the project is to mint.
- **One place to choose a token** (the skill, "When they ask for a token"; the guide's `tokens`): points the project
  mints, a fixed supply kept and handed out, a coin that trades (outside loot: launched elsewhere, then named), or a
  coin that exists. The guide says what a coin launched on a market gives up: usually nobody can mint it, so the
  economy pays out only what its owner puts into its pools.
- **A presale is flagged for the law** (`W-TOKEN-SALE`): a one-sided contest paid in SOL or a coin made elsewhere,
  whose backers split another token by what each put in, sells a share of that token (the prize's own token is read:
  a pool's is what the pool holds). Said once, like the other legal flags, and shown on the approval page.
- **A prize split among a contest's winners from a pool** is warned of as it is: set aside whole when the winner is
  named, the naming refused while the pool holds less. Before, it was said to go to whoever claimed first.
- New example: `community-coin` (a fixed supply of 100 million: a presale with refunds, sealed team vesting, a pool
  that drips to stakers).
- The checker's fixes for an existing token point at `xsolana token` instead of an explorer.

## 0.26.2: a token the setup makes is named on chain (loot 0.26.1, unchanged)

The JavaScript alone: the program, its IDL and every account are 0.26.1's.

- **A token the setup makes gets its name on chain.** Its Token Metadata record (the `name`, `symbol` and `uri` of its
  `tokens` entry) is written in the token's own step, while the owner is still its mint authority, before minting is
  handed to the project or turned off for good (a fixed supply). Wallets and explorers show the token by its name and
  ticker, and by its picture when `uri` links a JSON file that names one; before, every such token showed as an unknown
  one. The owner's wallet is the record's update authority: only it can change the three later. The record says a
  fungible token whatever its decimals, 0 included (`js/chain/metadata.js`: `createFungibleMetadataIx`,
  `metadataAddress`, `metadataUpdateAuthority`).
- **A token already live keeps what it has.** Token Metadata takes a record only from a mint's own authority, so a
  token whose minting was handed on or turned off without one can't be given one. Changing a live record through the
  spec is not built yet.
- **The cost says it**: the record's rent (607 bytes) and the 0.01 SOL Token Metadata keeps for each, apart from rent
  (`metadataFeesSol`): about 0.014 SOL a token.
- **Refused before anything is signed**: a name over 32 bytes, a ticker over 10 or a link over 200, counted in bytes
  as the record counts them, and a name or ticker left blank (`E-TOKEN`). A token that is live already is not named
  again, so its words stay labels and none of this applies to it.
- `xsolana explain` lists the tokens going live makes and says when one will show with no picture; the approval page's
  step names the record, its link, its fee and who can change it.
- The tests' world loads Token Metadata as mainnet runs it, and the evals' test wallet signs the one instruction of
  it a setup sends.

## 0.26.1: loot 0.26.1 (on devnet since 2026-11-10, slot 520,911,720)

The program, 0.26.1: nine small fixes, no layout changed (0.26.0's accounts and this client's builders work unchanged).

- **A farm's carry is freed when a walk empties the farm or finds it empty** (`walk_farm`, and the authority's
  take-back of free tokens, which walks the farm too): before, the first stake after every seat had stopped earning
  was credited all of it (at most the farm's weight divided by 10^12 reward units). A farm 0.26.0 already left with no
  weight and a carry frees it at its next move, before any weight comes in.
- **What a box's write and purchase accept, the oracle's answer can finish**: a draw of an entry that gives nothing is
  counted at its cost (a pack of such draws is written up to 116 draws, a purchase takes 109 opens of one; 230 and 203
  were sold and never answered); the answer counts the lists the next draw may outgrow, so a roll of a box sold by
  `buy` stops for room and lands, its undrawn draws given back; and the write counts finding each pool's and stash's
  address, as the purchase does, so a box written at its edge is not refused at every purchase. A box written under
  0.26.0 past these counts is not rewritten: each purchase of it counts as any other, and any edit of it, even one that
  only switches it off or changes its price, is refused (`PackTooLarge`) until its draws are cut.
- **A pool never opened is out of stock, whatever the amount**: a prize of 0 tokens from one beside another prize
  made every open of that box give the other prize and the whole price back.
- **A wrong account in a profile's or a Sheet's place reads as nothing**, and an account that is not a tree, passed as
  a compressed NFT's tree, is refused (`NotTheNft`).
- **A count no transaction could carry is refused before any loop over it**: `open_box` of more than 300 draws in all,
  a `buy` of more than 25,454 sales (`PackTooLarge`).
- Said in the spec, left as they are: a farm that mints does not keep its unpaid rewards' room in the mint against
  other things that mint it; a box naming an item never written is refused at the purchase, not at the write.

What the tools do with them:

- **The box cost check follows the program's** (`drawsFit`, `opensAnOrder`; new: `boxFits`, `searchTries`,
  `MOST_DRAWS_A_PURCHASE`, `MOST_SALES_A_BUY`, `ASSUMED_TRIES`): a draw of nothing at its cost, the reading of each
  prize after an entry's first (the 0.26.0 client left it out), a named NFT's stash at one row, and each pool's and stash's search at 1,500 units a try, exact from the
  project's address (`drawsFit`'s and `boxFits`' `project`, a box read from the chain names it) or at 2 tries an address
  before a wallet is named. `drawsFit` with `purchase` counts as `open_box` does. A test holds the client's verdict
  against the program's at every edge the program's changelog and spec name.
- **The checker counts with the project once it is known** (`check`'s `project`, passed by the plan for a real setup,
  or the live section's), says when it assumed the searches, and holds a box of one draw to the same count.
- **A box's write asks for all the compute a transaction has**: the plan's transaction carrying one names a compute
  limit of 1,400,000 first (a box of sixteen stashes whose addresses take 80 tries needs more than 200,000).
- **A raffle's pull of several NFTs out of the round's own stash asks for the largest heap** in js/play, as a run of
  rolls does: a pull of 8 Core NFTs in a round of some 125 places or more ran out of memory.
- **A raffle's winner of many places pulls them through `claims()`**: a pull of the round's own stash's NFTs takes as
  many of the entry's places as one transaction carries (`pullIx`'s `prize.most`, sized by a dry run on the largest
  heap), and the next pull carries on while the round still owes the entry; only the last carries the close.
- js/play refuses a `buy` of more than 25,454 sales in words.
- The docs, the guide and the skill say the new numbers; the IDL is 0.26.1's (`PackTooLarge`'s sentence, a farm's carry).

## 0.26.0: loot 0.26.0 (on devnet since 2026-11-10, slot 520,815,761)

The program, 0.26.0: the fixes of its audit of 0.25.0, and limits only where the chain sets them (`docs/program.md`).
What the tools do with them:

**Both sides of an exchange move together**

- **`endAuctionIx` takes `ending`**: `Deliver` (the lot to the winner and the money to the seller in one instruction),
  `LotFirst` then `Deliver` for an end too wide for one transaction, and `CallOff`. A sold lot is never made a hold.
  `app.endAuction` sends them in that order, says a sale is waiting when its lot can't move right now, and calls a sale
  off with the evidence when the lot is gone; `app.callOffSale` is the project's keys' way out of a lot that never moves.
- **`repayIx` brings the NFT home** (`home`, true by default) in the same instruction as the money; `home: false` sends
  the money alone for an NFT that can't move right now. `app.repay` refuses, before signing, a loan whose NFT is gone.
- **A roll's odds at its first ask**: `askRollIx` passes the player's profile, and an NFT they hold for a roll on no
  NFT (`askReads`, `firstAsk`, `bestShown`); `app.askRoll` picks the collectible that raises the odds most.
- A Token Metadata NFT's move always names two different token accounts (`twoAccounts`).
- **A record an earlier owner left on an NFT stops a deposit, in words**: before a player hands an NFT of another
  collection to the project (a stake in escrow, a loan, a hold, an NFT bid, ticket or stake), the player module reads
  the listing and the holds that name it; one left by another wallet refuses the deposit and says what it could do,
  and `acceptLeftover: true` goes ahead.
- An auction's end, a bid, a loan and a repayment read their coin's token program and its transfer hook's accounts
  from the mint.

**Boxes, recipes, settles**

- `openBoxIx` builds its accounts from what the box's rules read: the profile first, then the NFT shown.
- `craftIx`: each roll a recipe gives is at `nonce + k` (`craftRollNonces`); a payment line nobody can take goes to the
  treasury.
- `settleIx` takes `giveUp`: the order's own player gives up a prize they can't receive (tokens stay in the project's
  vault). `app.collect` says which prizes and takes `giveUp`.
- `makeIx` passes the Sheet of a compressed NFT made with attributes. `stashBatches` splits a long stock into calls by
  kind.
- `drawsFit` and `boxBytes` count as the program does: a box of one draw is held to one answer of the oracle's.

**Lotteries**

- New settings: `closesBefore` (sales close before the draw), `timeWeighted` (a no-loss lottery's tickets weigh by the
  time they are held), a place's `whenShort` (`inOrder`, `inProportion`, `nothing`), and a box's
  `whenOut: "giveNothing"`. `decodeRound` reads the 128-bit weight and draw point; an entry has its slice of the draw
  (`start`, `end`) and its `tickets`. `app.lotteries()` and `app.ticketWeight()` show what a purchase would weigh.
- A raffle's NFTs come out at most 64 a pull, a run of places that each give a roll is pulled in parts, a closing pull
  by someone other than the owner names the lottery, and a place's minted prize the project can't mint yet waits.
- `Lottery.last`: "end this lottery" is one edit (`every` 0).

**Farms**: a tier up to x100 and boosts up to +100,000%; `unstakeNftIx` takes `needPrize` (true by default), and
`app.unstakeNft` offers leaving without a prize that can't be given; `app.staked()` returns each seat's weight.

**The checker says what the program does**

- What 0.26 no longer refuses is no longer refused here, and each is a warning in plain words: a time far out (with
  the date in words, and a hint when it looks like milliseconds), a token whose accounts can start frozen, a price or a
  prize of 0, a mission tier with no lock, a farm that mints a token the project can't mint yet, a player's auction of
  any NFT, a collection the project only has delegate access to, and a sealed schedule's payee.
- The bounds the program keeps are refused before anything is signed: 256 raffle places from a lottery's own stash,
  170 texts in an NFT ticket's rule, 255 prizes an entry, the farm caps, and what one answer of the oracle's holds.
  A contest that splits a prize of 0 is refused: the program opens it but can never name its winner.
- The simulator: boosted weights in whole numbers up to the largest weight, a box that gives nothing for a miss, a
  stash with nothing that weighs, a round weighed by time, a short pool by `whenShort`.
- The guide, the explainer, the review, the approval page, the skill and `docs/program.md` follow.

**Also**

- The errors' sentences in the IDL say what 0.26 does (34 were out of date).
- `scripts/devnet-e2e.mjs` has two more scenarios: `weighted` (a no-loss lottery weighed by time, drawn by the real
  oracle) and `exchanges` (a player's auction ended in one step; a loan repaid with the NFT home).

## 0.25.4: a README for people (the documentation only; the program is still loot 0.25.0)

- **The README reads from the top**: what it is in plain words, what you can build as examples, how it works in three
  steps, three ways to start, a short "good to know", the questions, and links to learn more.
- **`docs/before-you-use.md`** holds the whole of what was the README's "Before you use it", unchanged.
- **`CONTRIBUTING.md`** has the setup's variables (their table had a broken row) and the repository's layout.

## 0.25.3: the hosted server in the MCP Registry (the JavaScript only; the program is still loot 0.25.0)

- **`https://xgames.fun/mcp`**, the MCP server over HTTP that xgames.fun hosts, is in `server.json` under `remotes`,
  so the MCP Registry lists it beside the npm package; the README names it for chat apps (claude.ai, ChatGPT, Claude
  Desktop).
- **The website is `https://xgames.fun/solana`** in `server.json`, `package.json` and both plugin manifests.

## 0.25.2: easier to find and to reach, and sponsored fees (the JavaScript only; the program is still loot 0.25.0)

- **The MCP server over HTTP** (`js/mcp/http.mjs`, exported as `@xgamesfun/solana/mcp/http`; `xsolana mcp --http`):
  MCP's Streamable HTTP transport for a hosted endpoint that chat apps add by URL. It offers only the tools that read
  nothing but their arguments and the chain (`REMOTE_TOOLS`), takes every spec whole, reads no file, refuses
  `xsolana_save` and `xsolana_publish`, and its instructions hand the person the spec and the `approve` command.
  Locally it listens on 127.0.0.1 and answers only pages on localhost.
- **`xsolana_status` takes a spec** as well as a file.
- **A sponsor pays players' fees** (`js/play/sponsor.js`, `@xgamesfun/solana/sponsor`; `solanaApp({ sponsor })`): a
  plain key on the project's own server is each step's fee payer and lends the player SOL for it, the player giving
  back in the same transaction all but its fees and rent (the player fee, the oracle's, the rent of what the program
  opens or mints); never the price. `checkSponsored` reads and dry-runs every transaction before the server signs:
  the sponsor named nowhere but its loan and the give-back, this project's instruction in it, no priority fee past
  its limit, the player keeping no more than the step's fees and rent, at most `maxLamports` a transaction, and the
  project's `budget`. Sponsored, a roll settles by the player's wallet (a second, sponsored prompt) rather than a
  funded settle key.
- **`toKitInstruction` and `fromKitInstruction`** (`@xgamesfun/solana/client`): a builder's instruction in
  `@solana/kit`'s shape and back.
- **The skill as one zip** on every GitHub release (`scripts/skill-zip.mjs`), for apps that take a skill as an upload;
  `npx skills add XGamesFun/solana-kit` installs it in any agent that reads skills.
- **Easier to find:** the README's title, opening and "Questions people ask", the npm description and keywords, the
  plugin keywords, a loot box tutorial (`docs/tutorial-loot-box.md`) and `glama.json` for Glama's MCP directory.

## 0.25.1: a security review (the JavaScript only; the program is still loot 0.25.0)

- **Patch releases for the JavaScript alone.** The package's major.minor is its program's; a patch above it (0.25.1 on
  loot 0.25.0) ships the review, the checker, the skill or the client without a new program. `release.json` keeps
  naming the program's version (a keeper pins it), and `scripts/release-manifest.mjs --check` accepts the higher patch.
- **A security review, `xsolana review` and the `xsolana_review` tool** (`review`, `describeReview` in
  `js/economy/review.mjs`): an economy read the way a cheater reads it, not a validity check. For every route that
  pays or gives value (grants, the shop, boxes, payments, recipes, farms, lotteries, contests, auctions, schedules,
  holds, decisions) it says who can trigger it, what the program enforces, what it trusts off the chain, the declared
  `trust`, the most one cheater gets (per person, per wallet, with free wallets, a day, in all, and what the prize then
  earns in a farm) and what it feeds. Findings carry stable ids and a severity: `R-TRUST-UNSAID`, `R-CLAIM-COMPOUNDS`,
  `R-CLAIM-UNCAPPED`, `R-STAKES-PAID`, `R-GRANT-PERSON`, `R-GRANT-OPEN`, `R-GRANT-TOTAL`, `R-CODES`, `R-FREE`,
  `R-STOCK-STEER`, `R-FARM-ENDLESS`, `R-FARM-WATCH`, `R-FARM-SWITCH`, `R-LOTTERY-LATE`, `R-CONTEST-RESULT`,
  `R-AUCTION-SHILL`, `R-AUTHORITY-ON-SERVER`, `R-DECISION-SERVER`, `R-VOUCHER-KEY`, `R-AUTHORITY`, `R-MINT-POWERS`
  (the checker's exploit notes, `W-GRANT-OPEN`, `W-GRANT-TOTAL`, `W-FARM-MINT`, `W-VOUCHERS`, `W-FREE` and others, are
  folded in). `tradeoffs` is short markdown for the person: the three levels, which route uses which, what a cheater
  gets and what moving up costs. The answer is `{ ok, routes, findings, tradeoffs }`; the command exits 1 on a high
  finding.
- **A grant's `trust`** (`"decides"`, `"replays"` or `"bounds"`): what the server holding its voucher key checks
  before it signs. The spec's own note: the setup plan and the approval ignore it, and adding or changing it on a live
  economy publishes nothing. Refused on a grant no voucher key or code signs for (`E-GRANT-TRUST`); `xsolana_explain`
  says it in words; the review reads a voucher grant without it as `"bounds"`.
- **The skill**: a new reference, `trust-and-cheating.md` (what a server decides, replays or bounds and what each costs;
  who gets paid; what the program guarantees, from a devnet attack audit of 0.25.0, and the exploit checklist that is
  still the project's); rules 9 and 10 say a signer is not the end of the story; rule 12 and step 8 of the loop run
  `xsolana_review` before the owner approves, and tell the person what a cheater gets so they choose the trade-off.
- The five examples 0.25.0 added from the rated economies (`stride-sneakers`, `holder-den`, `pack-league`,
  `match-predictions`, `holders-drop`) are taken out again; fuller examples come later. The tests cover each part they
  used on their own.
- Comments and the changelog name no local folder or internal note.

## 0.25.0: a prize never shifts to a later round (the program on devnet since 2026-11-08, slot 519,994,814)

For the program's 0.25.0: the IDL, the client, the spec and the docs follow it, and no account of 0.24 carries over:
make economies again. `js/test/fixtures/pinned.txt` and `release.json` pin devnet's build (sha256 ea19d15d…, 1,741,840
bytes, slot 519,994,814). `scripts/devnet-e2e.mjs` sends each fresh wallet's SOL back to the funder at the end of a run.

- **Where a lottery's places are paid from, never a default.** The spec's lottery takes exactly one of `"pot"` (a number 0
  to 15: a pot kept from round to round, `PaysFrom::Pot`) or `"rest"` (a destination: each round pays from its own ticket
  money and sends what its places leave there, `PaysFrom::Round`). Neither, or both, is refused in words
  (`E-LOTTERY-PAYS`); the schema says it too (`oneOf`, which `validate.mjs` now reads beside an object's other keywords).
  A `rest` that is a pool, `"chosen"` or the lottery itself, a no-loss lottery without a pot, a `seed` without one, and a
  share or a schedule paying a lottery that keeps no pot are refused (`E-LOTTERY`); tickets that bring no money to a
  round paid from its own money are warned of. The plan writes `pays_from` and opens a pot only for a lottery that keeps
  one (so `cost` counts a pot's rent only then); `"lottery:<key>"` resolves to that lottery's pot
  (`@pot:<lottery>:<pot>`). `simulate`, `explain`, the guide, the approval page (`Places paid from: …`), `xsolana_status` (each pot and what it holds) and the skill say
  which: a round's own money can't be changed from outside; a pot counts gifts and yield and what earlier rounds left,
  and the next round always sees what the round before left. Every example with a lottery names one (`nft-raffle` and
  `partner-vault` pay from each round with `"rest": "treasury"`; the others keep pot 0).
- **The client.** `pda.lotteryPot(lottery, id)` (`["pot", lottery, id]`; `pda.pot` stays a contest's), `MAX_POTS`,
  `potIdOf(terms)`, `leftoverTo(lottery, terms)`, `lotteryPots(lottery)`. `withDefaults` refuses a lottery without
  `pays_from`. `upsertIx` passes the pot the terms pay from (pot 0's address for a lottery paid from its rounds);
  `closeRecordIx` passes, for a lottery that opened pots, the mint, where they go, both token programs and each pot by
  id. `drawLotteryIx` passes no pot for a round paid from its own money; paid from a pot, the pot, its mint and the
  round's account, then, with `lottery.owing` set, that round, its account of the mint and its pot (`owing`: that
  round's record, whose terms name its pot). `pullIx` and `commonOwed` send what the places leave to the pot or to
  `rest`, and owe none when `rest` burns. js/play reads the `owing` round for each draw it sends (and says in words that a draw waits while that round
  waits for the oracle, `NotDue`), its raffles pay from
  the round (`rest` the treasury), and a payment to a lottery that keeps no pot is refused in words.
- **Contests.** `Contest.pot_won` and `prize_won`, written at the decision; `contestWinnings(contest, amount)` gives a
  winning entry's claim, which adds up exactly whatever the order, and js/play's `claims()` carries it (`potUnits`,
  `prizeUnits`). The simulation, the explainer, the guide and the skill
  say a gift after the decision goes to nobody, and a forgone split-prize part goes back to its pool.
- **Boxes.** A box that stops selling and lists a stash's NFT at random beside one of its NFTs by name in another outcome
  is refused (`E-ODDS`, `BadEntries`). The simulation's stock walk covers by the most any outcome takes of an item, a stash
  or an NFT in one draw, times the draws; the words say so, and that a free roll never loses draws to what it emptied
  itself.
- **Recipes.** `craftIx` takes a token seat's booster as `{ asset, farm, booster: true }` on a kept `Use` or a `Show`
  line: the player's token seat and the farm follow it; a `Staked` line refuses it. js/play finds a booster's farm.

### From games built on 0.24 (the tools)

- **Designing against farming and cheating**, from what games built on 0.24 ran into:
  - `check`: `W-GRANT-TOTAL` for a voucher, key or open grant that limits each wallet (person, key) but nothing a day
    or in all (codes that each pay a set number of times are a total already); `W-GRANT-OPEN` says when an open grant's
    prize can be sold or is a roll, and how to make farming it cost something; `W-FARM-MINT` for a farm that mints its
    rewards for good with no end, term or upkeep, into a token that buys what earns it (or is staked for more of
    itself); `W-FARM-SWITCH` when an NFT a farm watches can be staked in one that escrows it (the watched seat stops and
    its unharvested rewards are lost). `W-GRANT-FUNDS` gives how many claims a fund covers in `simulate`'s own figure.
  - `simulate`: each grant says what one wallet may claim and what 100 wallets could, with its cap; the oracle line says
    anyone may send a draw (not "the game's keeper").
  - `@xgamesfun/solana/results` (`server.js`, browser-safe): `collectiblesOf` and `holds` (the game's Core collectibles a
    wallet holds, read from the chain), `proofRequest` / `verifyProof` / `readProof` / `proofText` (a wallet's signed
    proof: game, purpose, a nonce taken once, an expiry), and `makeCodes` (80 bits by default, 64 at least) /
    `normalizeCode` / `codeKey` / `codeAddresses` / `codeVoucher` for promo codes.
  - The guide: "Designing against farming and cheating" (wallets aren't people, the page can't be trusted, bots play
    well, the attributes only the program writes); a pity counter that resets and never trades (a soulbound charm the
    box rolls on). The skill: rule 10, "Design for many wallets and bots", and the same in `after-launch.md` and
    `sentence-to-spec.md`.
- **A lottery's or farm's seed in a token the project mints** is minted into the pot or the rewards vault at go-live,
  as a pool's seed is minted into the pool. It was paid from the owner's wallet, which holds none, so the setup never
  finished. Test: `minted-seeds.test.mjs`.
- **Legal flags, once.** The skill (rule 6, `telling-the-person.md`) says each legal flag once, in a plain sentence, the
  first time the checker raises it, and again only when the person asks or a flag of a new kind appears; no legal notes
  in pages and apps unless asked. `xsolana_publish` passes the flags on for the agent to say if it hasn't yet, and no
  longer asks it to repeat that the program is unaudited: the approval page shows that, and its tick box is the one
  acknowledgment. The checker's warnings and the approval page are unchanged.
- **`{serial}` in a name:** the schema no longer says a fresh item's name takes `{serial}`. The program fills `{serial}`
  in links only and ends every name with " #<serial>"; `{attribute}` works in both.
- Tests: the go-live test buys only from a box with no gate (one gated on a collection waits for a holder).

## 0.24.0: the rules are strict (the program on devnet since 2026-11-07, slot 519,723,738)

For the program's 0.24.0, "the rules are strict": the IDL, the client, the spec and the docs follow it, and no account
of 0.23 carries over: make economies again. `js/test/fixtures/pinned.txt` and `release.json` pin the build devnet runs.

- **A seat past its end is paid exactly.** `Farm.marks`, `Seat.credited_at` and the time split are gone. A farm whose seats
  can stop earning and that pays keeps `["ends", farm]` (`pda.ends`, `decodeEnds`, `farmKeepsEnds`, `Farm.keeps_ends`): every
  builder of a farm's moves names it when the decoded farm says so, `openFarmIx` when its args do, and `moveTokensIx` takes
  `farm` for `farm_ends`. New: `walkFarmIx`, `endsToWalk`, `farmNeedsWalk`, `walkFarmParts`; in `js/play`, `app.farmWalk`,
  `app.walkFarm`, a `walk` claim, and moves that ask for all a transaction's compute when they have ends to walk and refuse
  in words (`FarmNeedsWalk`) past what they can. `cost` and `explain` say a new end time costs its writer 44 bytes of rent,
  spare rent first, not refunded on leaving; the record's first bytes are the owner's at setup. Nothing says to refresh at
  the end of a term any more.
- **A prize is a fixed amount.** `Prize::Tokens.amount` is a plain number on every route (`Amount` stays for `move_tokens`
  and schedules). The share prize is gone from the schema, the plan, the checker, the simulation, the explainer, the
  guide, the skill, `examples/starforce.json` and `examples/merge-2048.json`. A spec that asks for one is refused in words
  (`E-SHARE-PRIZE`), with a fixed amount or a lottery's pot as the way; the keyword `jackpot` finds lotteries, and the guide
  names the limit. A share still fills a schedule, a decision and a split.
- **Written odds.** A draw is on the box's written weights: an entry drawn that can't be given makes no draw and gives back
  its slot's worth; with no draw made a paid order fails and a free one waits. `simulate`, `explain`, the warnings
  (`W-OUT-OF-STOCK`, `W-PRIZE-SEED`) and the skill say so (`STOCK_WORDS`). An outcome that names a pool twice, a stash's random
  NFT beside anything else of that stash, or one NFT twice is refused before writing, as the program would (`BadEntries`);
  two of an item more than its supply is warned of.
- **Edits.** An edit fails only an order holding a payment; other rolls waiting roll on the box as edited. `W-LIVE-ROLLS`,
  `explain` and the skill no longer say a roll won elsewhere is lost.
- **Time, not slots.** `STALE_SECONDS` and `LOTTERY_TIMEOUT_SECONDS` replace the slots' constants, from `asked_at` and
  `first_asked_at`. `orderRefundSlot` gives way to `orderRefundAt` and `orderRefundable(order, slot, now)`, which knows an `Asked`
  order holding a payment or an NFT refunds after 7 days; `rollAskable(order, slot, now)`, `lotteryDrawStuck(round, now)`,
  `lotteryCancellable(round, now)`.
- **A run missed is missed.** Only a sealed fixed amount pays every run due (`scheduleCatchesUp`); any other pays once and
  `upto` has no effect on it. The explainers, the guide, `after-launch.md` and `app.runSchedule` say so.
- **An owed seller.** An auction of a player's NFT whose seller's account can't take the money delivers the lot and stays
  open with `proceeds_owed`: `endAuctionIx` then names no lot or share, `app.auctions()` says `delivered` and `proceedsOwed`,
  `app.endAuction` pays and closes it, and `claims()` offers it to the seller, not the winner.
- **Lotteries.** At most 64 runs (`E-LOTTERY`). A `payout` claim leaves out a named stash NFT that is gone, which a stranger's
  pull can't pass over.
- **Smaller.** A tier with a prize needs a lock (`E-FARM`). `W-ROLL-CUSTODY` covers a number-moving roll on an NFT a recipe
  shows (`NeedsCustody`). A raise with no `upTo` has no cap and works: the warning is gone, and the plan writes `most: 0`.
- **Caps.** `LIMITS` holds the program's caps (`constants.rs`, not in the IDL), and `check` refuses a spec over one in words;
  a contest's sides and side names go to 1,024.
- A farm whose boost reads what its own growth writes gets a note in `explain` and the guide: a page or a keeper should
  refresh seats, since a level counts from when it is written.
- Tests: `js/test/farm-ends.test.mjs`, `js/test/strict-rules.test.mjs`.

### After the fresh audit of c34abc4

- **When an outcome runs out, the project chooses** (`when_out`, `WhenOut`; the spec's box `whenOut`). `"stopSales"`, the
  default: a purchase is refused (`SoldOut`) unless every outcome covers its draws and those of purchases still waiting
  for their answer (`LootBox.in_flight`, `Order.reserved`), so every roll is on the odds written. `"drawLeft"`: it keeps
  selling and draws among what is left, so a player can empty a common outcome to make a rare one likelier. The schema,
  the plan (`when_out`, `StopSales` when left out, also in `withDefaults`), the checker (`W-WHEN-OUT`: the rare's chance
  before and after the likeliest outcome that runs out, or a box of one step it changes nothing for; `W-OUT-OF-STOCK`,
  `W-STASH` and `W-PRIZE-SEED` say a box that stops selling isn't sold at all then; `W-LIVE-ROLLS` counts a change of it),
  `explain` (`whenOutWords`, replacing `STOCK_WORDS` for a box that sells), the guide, the skill and `app.boxes()`
  (`whenOut`) follow it. `simulate` walks each box's items with a supply, stashes and named NFTs (`stock`): the day a box
  that stops selling stops, or the day each outcome of one that draws among what is left runs out and the chances after.
- **The answer writes the box; a refund names it.** `callbackRollIx` marks the box writable. `refundIx` passes the box
  (`loot_box`) while the order counts draws in it (`reserved` above 0, or not read), so `app.refund` and a `refund`
  claim do too; the program refuses a refund without it (`ItemMismatch`).
- **A compressed NFT's Sheet closes against its tree.** `closeSheetIx` takes `tree`: the record proven empty goes as
  `tree` (`pda.leaf(nft)` by default) and the tree in the edition's place.
- **Box capacity.** `drawsFit` counts the heap the program now measures (`tests/roll_heap.rs`) and the box's own bytes
  (`boxBytes`: odds, gate, shares, subject, slots, fates) and its fates' compute. `buyFits` mirrors `catalog::buy_fits`:
  a box that doesn't roll and that one `buy` can't carry sells through the oracle, its heap counted, and can't give a roll
  (`PackTooLarge`, refused by `check` before signing). `opensAnOrder` counts the same: twelve 5-card opens of a two-entry
  box an order, 20 draws of pool tokens through the oracle, 64 of one item (past 14, no `buy` carries them).
- **Caps.** An item draws at most 64 traits, each name at most 64 bytes (`MAX_ITEM_TRAITS`, `MAX_TRAIT_KEY`,
  `LIMITS.itemTraits`, `LIMITS.traitKeyBytes`): `check` refuses a spec over them and `upsertIx` a record (`BadItem`).
- **Words.** A rule on a collection doesn't count a Token Metadata print (`W-RULE-PRINTS` once a spec, and `explain`); a
  forfeit writes no growth (`docs/program.md`); a table never written reads as out of stock.
- Tests: `js/test/when-out.test.mjs`; `strict-rules.test.mjs` empties an entry by another route after the purchase.

## 0.23.0 (not released on npm)

For loot 0.23.0. The IDL, the client, the spec and the docs follow it; no account of 0.22.0 carries over.

### Pinned to devnet

- loot 0.23.0 is on devnet since slot 519,323,615 (2026-11-06). `release.json` and `js/test/fixtures/pinned.txt` pin
  its build: 1,673,976 bytes, sha256 `d18c4c19…`, read back from devnet byte for byte. The package, the plugin
  manifests, `server.json`, the npx commands and the README say 0.23.0. npm still serves 0.20.1.
- `scripts/devnet-e2e.mjs`: `--only` takes several scenarios (`--only packs,lottery,farm,auction`), each project of
  the one owner its own `projectNumber`, and two scenarios of 0.23: `lottery` (two players, a draw by the real oracle,
  the pot paid out and the round closed) and `farm` (stake SOL, harvest a minted rate, unstake). The `farms`
  scenario's spec says what 0.23's checker asks (rewards name a token; a staked recipe line names its farm).

### The program, as the tools see it

- **Lists of records** (tag 26, `decodeList`): a wallet's counts (`["counts", project, wallet]`) replace the receipts
  of boxes, recipes and lotteries; a grant keeps its limit records and the rounds it paid in `2^shard_bits` shards
  (`["claims" | "rounds", grant, incarnation, shard]`), closed by anyone once the grant is gone (`close_shard`).
- **Vouchers** sign `"loot-grant-v5" | sha256(body)` and name several rounds, each paid once (`voucherBytes` with
  `rounds`, `claimGrantIx` with `rounds`/`proofs`/`paidRounds`); a claim may need 400,000 compute units.
  **Verdicts** sign `"loot-verdict-v4" | sha256(body)`, a side a `u16` (65,535 calls it off).
- **A lottery round is its own record** (`["round", lottery, incarnation, round]`, `decodeRound`), holding its money in
  accounts of its own: `pull` pays one part (`partsOwed`, `commonOwed`), the last closes it. Places are runs (`times`); `Prize::Raffled` draws an NFT of the lottery's own
  stash at random. `finish_lottery_contribution` is gone. A lottery's terms are one `LotteryTerms` (`LotteryArgs {
terms, every, gate, per_wallet }`), which the round copies (`round.terms`, `paymentMint(terms)`); `buy_tickets`
  names no incarnation (its round's address does); `LotteryPulled` carries the `amount` settled, and `LotteryPaid` is
  gone. A grant's tag is 27, a profile's 24.
  A Token Metadata NFT's Sheet closes naming its edition (`closeSheetIx({ tokenMetadata })`).
- **A contest's entries are one list** (`decodeEntries`); `claim(entry, nonce, forgo, end, nfts)`; winners
  share the losers' NFTs (`cap`), losers send nothing.
- **The tail**: every route's extra accounts (hook accounts, Core's checks) come from the Memo program's account on
  (`tailOf`).
- **Several a call**: `stake_nft`, `unstake_nft`, `harvest`, `stash` (`weights`), `hold`, `release` and `Make { item,
tree, attributes }` (`makeIx`) take several NFTs, seats or owners (`more`).
- **Smaller**: u16 pool indexes; a hold names `payer` and `rent_to`; a burn names the holder, who gets its rent; anyone
  closes a burned NFT's Sheet (`closeSheetIx`); `run_schedule(upto)` catches up in one call, sealed schedules up to
  100,000 runs; a token exit that would lose its seat's growth refreshes first (`refreshFirst`); a watched farm refuses
  an NFT it can't read (`NotProven`).
- **Leaner (the optimization batches A and B)**: instructions take 1-byte tags (the oracle's three callbacks keep 8;
  `instructionOf`), and the program logs an error's name, not its sentence (`lootError` gives the IDL's). Every open
  asks the oracle; a box with nothing random sells with `buy`, which takes a `count` (a fixed pack: `buyGives`). A
  write or a route naming a box to roll passes the box alone (`boxesAccounts`); the roll is read when it is asked, a
  fresh item's tables only while they fit the box's table budget (`tableBudget`). One out-of-stock rule: a prize
  the roll can't move or pay (a hooked, confidential or non-transferable mint, a pool short of a fixed amount, an empty
  or unsealed table, a fresh item past the budget) never comes up; `ask_roll` refuses a box with nothing in stock
  (SoldOut) unless the order's own player asks in a later slot. No order reserve: whoever settles pays what the settle
  opens or mints (`settleRent`, what js/play funds its settle key with). settle's `upto`: 0 the split alone, past the
  end (`SETTLE_LAST`) the last part; no `rows`. No committed tables. A box burns its price with a `Burn` share (no
  entry `burns`), gives a roll only when it doesn't roll (`Won::Roll` and `Won::Fresh` are gone: `Won::Item { drawn
}`), and a roll lot's winning bid stays in the vault as its order's payment (`Auction.pin`). An item's life is its
  recipes' needs and raises (`Need { test }`, `Raise { place, shift }`, `rules::Test::Older`; no `Item.life`, no
  `Renew`). Grants count with `Limits.all` and `Grant.counted` (`OverDay` is gone; codes after it moved). `Debt.paid` is
  gone (a repaid loan is a plain hold that is over). `Fate.then` is `Option<Spend>`. A seat earns until a time
  (`Seat.earns_until`, a tier's `earns_for`). An order of a box that gives items has room for its draws' rows.
- **Leaner (batches C and D: lotteries, contests, holds, farms)**: tags are dense 0–54 (`pull` 20). A lottery round's
  first ask (`draw_lottery(skip_hooked)`) fixes its money and moves the lottery on; then every part is pulled, in any
  order (`pull(entry, part, nonce)`: `Own`, `Pot(run)`, `Prize(run)`, `Common(i)`; `commonOwed`); `settle_round` and
  `cancel_lottery` are gone (an unanswered draw is cancelled by its next ask after the timeout). A share the buyer
  chooses is paid at purchase; the lottery's own stash's NFTs are taken out by the pulls in place order (`stashNfts`);
  SOL sent to the lottery pays its rounds' rent. An owed NFT is moved by its piece or made a hold by its hold's address
  (`claim` without `give_up`, `end_auction` without `hold`, `bid` taking the outbid NFTs' holds). A contest closes by
  its claims (`decide` names no opener or entries). A compressed NFT's record closes when its payer signs
  (`close_leaf`). Farms: no `unbond`, toll or rewards pool: rewards land in the farm's own vault (`["rewards", farm]`),
  `Rate { per_day, mints, shared, halve_every }`, `Sink::Rewards`, a 184-byte seat (its player at offset 1), end marks,
  `TokenSource::Farm` for what a farm holds free; an early exit keeps its rewards; no refresh at a seat's end. Sealed
  schedules pay a wallet, the treasury or a burn.
- **Batch E**: a take or a bid signs the hash of the record's bytes as read, but what a take changes
  (`auctionTerms(auction)`, `offerTerms(offer)`, `listingTerms(listing)`, each the decoded record or its bytes;
  `auctionArgsOf` is gone); an auction's bid and an offer's `left` sit last. An auction of NFT bids is made with room
  for 3 NFTs (the seller's rent): bidders pay none. The order's player's own ask on an empty box ends the roll there,
  with no oracle; a free roll whose answer finds nothing at all in stock waits again. `draw_lottery` takes the lottery
  for its current round only. `move_tokens` credits a farm it takes from (`farm` writable). A top-up or compound of a
  seat with a booster on refreshes it first (`stakeRefreshFirst`). A shown NFT frozen on a seat passes its seat and
  farm when a raise lowers a number on it (`craftIx`'s `farm`). A contest's side is named only once entries close, by
  the authority too; `BelowMinPot` is gone (codes after it moved). End marks on a 15-minute × 4^k grid.
- **The final fixes** (8938ee0): an order is sized by what it holds (`orderBytes(box, shares, opens, items)`, the
  program's `Order::sized`: a draw at its dearest entry's prizes as the `Won` they become, an item 14 bytes, tokens or
  an NFT 41, and rows only for its fresh items' tables now; a roll made in another call keeps the whole table budget,
  `orderBytes` without `items`). A pack's draws must fit one oracle answer (`drawsFit`; `PackTooLarge` at a box's
  upsert, and at `open_box` for several opens); a box whose slots leave an entry undrawn is refused (`BadEntries`);
  `open_box` is refused when its first slot's entries are all out of stock (`SoldOut`). An ask comes a slot after the
  last (`SameSlot`, `rollAskable`). A run of places given one by one holds at most `MAX_RUN_PLACES` (4,096). A round's
  header has `lent`: in a round the lottery opened, its spare SOL pays each entry's bytes, back to it at the close.
  `pay` refuses a share into the project's own vault (`BadMove`). A part owed to a pot made again in another mint goes
  to the treasury. A locked seat moves only to a tier with no early exit or one at least as dear (`ExitWhileLocked`).
  A percentage pool prize moves nothing for an unwon place. A lapsed seat of a halving farm is paid by what the rate
  paid.

### The tools

- The spec: a lottery place's `times`, a lottery's `nfts` and a `raffled` prize, a contest's `losersEach`, a grant's
  `wallets` and `rounds` (its shard bits). The plan puts several stash NFTs in a call; the cost and the simulation
  count entries' bytes that never come back and what a settle key is lent. An item's `life` is written into each
  recipe that takes it (`lifeLines`). An outcome no longer burns the payment (`"gives": "burn"`, `burns`: refused in
  words). The checker warns of a prize out of stock (W-OUT-OF-STOCK) and refuses a roll in a box that rolls.
- js/play: lotteries read their rounds; `claims()` lists `reveal` (or `cancel-draw`, an older round's ask after the
  timeout), `pull` and `payout` (the parts owed in common too); a place's roll is asked in the pull's own transaction
  and a key settles it; a contest's claim picks a winner's share; grant claims read the shards. Every send appends
  `close_leaf` for a compressed NFT's record (`withLeafCloses`).
- The spec (batches C and D): a farm's `rewards` names a token, `seed` funds its vault, and "farm:<key>" sends it
  rewards (a split, a recipe, a schedule that pays or mints into it); `rate.shared`, `rate.halveEvery`, a tier's
  `earnsFor`, `exitFeeTo: "rewards"`; no `unbond`, `toll` or `rewardsIndex` (W-FARM-DRY for a farm nothing funds). A
  sealed schedule pays a wallet, the treasury or a burn. A lottery's `roundRent`.
- js/play keys: a step after the wallet's prompt is a throwaway key's job (funded in that transaction for what it pays,
  the rent minimum read from the cluster and a spare fee; simulated, sent, or else sent by the wallet; emptied back).
  A craft, a bundle bought, a mission left, a grant's or contest's roll prize and a roll lot the winner ends ask for
  their roll in the same transaction and a key settles it: one prompt (`rolled`, `rolls`); on a box with nothing in
  stock the whole transaction is refused (SoldOut) and nothing is sent. A box's open funds its settle key with what
  the settle mints (`settleRent`); the key's last settle sends back the rest in the same transaction. `repay(asset, due)` repays alone and a key
  sends the NFT home. `claimAll()` signs independent claims in one prompt with a wallet that signs several
  (`signTransactions`).
- Final fixes, the tools: a box's order is cut into orders of `opensAnOrder(box)` opens (what one answer draws, an
  order's rent and fee within 0.01 SOL; `CARDS_AN_ORDER` is gone), each funded with its own settle key. The checker
  refuses an undrawn outcome, a pack one answer can't draw (about 28 draws of tokens from a pool, 61 of items) and a run
  of over 4,096 places. A lottery's `roundRent` is on by default, sized from `expect: { rounds, entries }` (2 rounds of
  a repeating lottery, 1 of one that draws once; entries from the scenario, else 100) and covering entries too, so
  buyers pay no program rent for a ticket; a spec's `roundRent` wins, 0 turns it off. Going live always makes the
  standing lookup table, and is refused (`E-NO-TABLE`) without one when a part needs it.
- js/play, final fixes: settle keys a closed page can find again (`recover()`): made from one wallet signature a
  session over a fixed text (`walletStandardSigner`'s `signMessage`), or, for a wallet that signs no messages, kept in
  the page's storage encrypted with a non-extractable device key (`keyStore`, `browserStore()`). A draw that cancels a
  round pulls the sender's own refund in the same transaction (a refund is two transactions); a purchase in a round
  whose draw is due sends the draw first. A loan's pNFT or compressed release, and the releases after an auction end
  too big for one transaction, go by a throwaway key. A booster in a farm whose growth writes the profile refreshes the
  seat first (`boosterRefreshFirst`). `claims()` lists a lender's overdue loan, a seller's ended auction and proof
  records left open (`close-leaf`). `runSchedule` sets a compute limit.
- The checker warns that a fresh item (traits drawn per unit) as a lottery, contest or mission prize is never given,
  and refuses it as an auction lot (`LotRefused`). A contest claim that closes the contest needs `projectState` (its
  treasury).
- Every write naming a box to roll passes the box alone (`boxesAccounts`, `defRolls`); a roll's accounts are its
  ask's (`rollAccounts`, `askRollIx({ items })`). The plan writes a box before what names it.
- A collectible's upsert names its collection (`Item.compressed`: whether it carries Bubblegum's plugin). A split pool
  prize's `open_contest` names its pool. A hold owed to the treasury (player: the project's address) is released to the
  project's treasury (`releaseIx({ treasury })`), and `claims()` lists those for the treasury's wallet. `unstakeNft`
  refuses to leave while the NFT's last mission roll is unfinished, saying what to do. A Sheet or profile that shrinks
  refunds nobody.
- A settle splits the payment with its first call (`upto` 0 alone when no prize fits beside the shares); js/play
  sends it so. `stashIx({ drop })` leaves an NFT in its hold, owed to the
  treasury; the project's address is refused. A compressed prize of a collection without Bubblegum's plugin shifts the
  next one's Sheet (`unminted`; `parseCoreCollection` reads the plugin).
- `repay` names the debt its payer was shown (`repayIx({ repay })`); js/play's `loan()` reads it and `repay(asset, due,
{ repay })` passes it. js/play reads a hooked mint's accounts (`resolveTransfers`) for ticket purchases, a round's
  ask and its pulls: a hooked lottery runs from the page. A box's order size counts its stored shares.
- An NFT lot and a bid's winning NFTs can become holds released after (`endAuctionIx({ hold })`, true or a list of
  assets; js/play's `endAuction` does so when the end doesn't fit). A claim of a split pool prize names its pool (`prize_pool`).
  A settle part before the last gives prizes only (no shares, a stand-in piece); js/play splits a settle that passes
  64 accounts or 1,232 bytes into such parts. The checker refuses a box whose order passes 10,240 bytes
  (`MAX_ORDER_BYTES`); `MAX_PROVEN_BYTES` and `provenRowBytes` size committed tables' rows.
- A split kept to be paid later holds at most 8 shares (`MAX_SHARES`): the checker and the builders refuse a ninth.
  A craft's roll on a collectible and a mission's roll are at `namedRollNonce` (the NFT's own nonce on a box that holds
  it, else `prizeRollNonce` of the one named); `unstakeNftIx` takes `boxes`. A fresh item on a paid route is
  `PrizeNotCovered` (`NeedsRoll` is gone).
- An NFT bid holds at most 3 NFTs (`MAX_BID_NFTS`): `leastBid` is null past it, `auctions()` names `maxNfts`, and
  `bid` refuses more. `craft` takes `extra`, the tail a Core collection's plugins need.
- The checker refuses a lottery run whose token prize in all passes a u64; the approval page warns when a change
  makes a closed grant again with the same list (its rounds would pay again).
- Going live opens the project's token accounts and its share wallets' and makes a standing lookup table
  (`live.tables`), which play's sends and keys use; the authority's steps come last.

## 0.22.0 (not released on npm; on devnet from slot 518,850,971 until 0.23.0)

For loot 0.22.0, the release that launches. The IDL, the client, the spec and the docs follow it; no account of 0.20.1
carries over.

### The program, as the tools see it

- **Only the chain's limits.** The program caps no count or size of its own: box entries, prizes an entry, odds,
  shares, lottery places, farm boosts, gates, growths and level steps, recipe lines, gate wallets, list depth,
  contest deciders, NFTs a bid, collections a project, grant receipt rounds and the lengths of names, keys, texts and
  URIs are bounded only by the transaction, the heap, an account's 10 MiB and the oracle's answer (21 accounts). Farm
  tiers go up to 256 and collectibles a craft to 255 (a byte names each). Kept: a tier's ×11 and a boost's ×101, the
  platform's fee cap, the time guards, three named voucher keys, and Bubblegum's 32-byte names and 200-byte URIs for
  compressed NFTs.
- **Packs**: `open_box` takes `count` (several opens in one purchase, one oracle answer, never shared between
  players), and a box's `slots` say what one open draws (`{ count, only, distinct }`). Orders are sized to their box.
- **Settle in parts**: `settle(upto, prize_accounts, rows)`; receipts `OrderPartSettled` and `OrderSettled.from` (no
  `assets`). One settle mints about 14 Core cards, 10 compressed or 8 fresh compressed (a 64-call instruction trace).
- **Tables** (`["table", project, id]`, tag 25): weighted rows of labels or numbers with stock, written in batches and
  sealed; a committed table keeps only a Merkle root, proven at the settle (`rows`).
- **Fresh items** (`Item.traits`): each unit's traits drawn from a table or a range, its name and URI taking the
  values (`{key}`); given only by a box's roll (`NeedsRoll`).
- **Compressed items as box prizes** (`Prize::Compressed` in an entry), minted at the settle.
- **Stashes are tables of NFTs**, each with a weight (`stash`'s `weight`), drawn by weight; the `Stash` account (tag 21) is gone.
- **Player profiles** (`["profile", project, wallet]`, tag 24): `Of::Profile` rules, `Change::Profile`, growth on the
  profile, a recipe's need or raise at `PROFILE_PLACE`.
- New errors `WrongProfile`, `WrongTable`, `BadTable`, `BadItem`, `NeedsRoll`, `WrongRow`; `ReceiptFull` and
  `StringTooLong` are gone.

### The tools

- **Client**: `openBoxIx` takes `count` and `items` (a fresh item's tables); `settleIx` takes `upto`, `rows` and the
  tree a compressed prize is minted into; `settlePartEnd`, `settleParts`, `prizeCalls` and `TRACE_LIMIT` size a
  settle's parts; `stashIx` takes `weight`; `upsertIx` writes `Def::Table`; `decodeTable`, `decodeProfile`,
  `tableRowAt`, `placeBit`, `pda.table`, `pda.profile`; `orderBytes` and `contributionBytes` size orders and lottery
  purchases to their record; `random`, a mirror of the program's rolling module held to its vectors, shows what each
  draw of an answer gave. `MAX_RECEIPT_ROUNDS` is gone.
- **Player module**: `openBox(key, { listing, count })` opens several packs with one wallet prompt; a pack too big for
  one transaction is settled in parts by the throwaway key the purchase funds (`parts` in what it returns).
- **Spec**: a box's `slots`, an item's `drawn` traits, top-level `tables` (rows on chain; the tools write no committed
  table), and a stash NFT's `weight`. Every `maxItems` and `maxLength` that stated a removed cap is gone, and so are
  the checker's refusals of them; the checker refuses what the chain can't carry (`E-TX-SIZE`, `E-ODDS` past the
  oracle's 21 accounts) and checks tables (`E-TABLE`, `W-TABLE`) and fresh items (`E-ITEM`).
- **Guide**: packs are a way (slots), no longer a limit with a workaround (a bundle whose third prize is a roll).
- **Docs and skill**: `docs/program.md` describes 0.22 (numbers not measured again on 0.22 are marked as 0.20's); the
  skill maps packs, a guaranteed rare, multi-opens, random traits and large decks to the new fields, and says what
  stays the project's job (files behind every link, a committed table's proofs, a table's rent, a pack's held rent).

## 0.20.1

The first public release of the tools, for loot 0.20.1 on devnet (program
`9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`).

### What is in it

- **Client** (`@xgamesfun/solana/client`, `/chain/*`): every PDA, one builder per instruction (58), account and receipt
  decoders and grant vouchers, with no Solana SDK. Runs in browsers and Node.
- **Player module** (`/play`): `solanaApp` for a browser app on a live economy: buy, open, craft, stake, enter, bid,
  claim, list and rent, with every transaction sized before it is signed (legacy when it fits, else v0 with an
  address lookup table the payer makes and closes), refusals in words, and `claims()` offering every step a player
  can finish. A purchase is made only on the terms the page showed (`{ listing }` or `{ maxPrice }`): a price that
  moved since is refused in words, never paid unseen. An option a method doesn't take is refused, never ignored, and
  a payment can pay a share to a referrer the payer names (`chosenRecipient`). `staked(farmKey)` reads a player's seats and what each is owed now, by the program's own sum.
- **Results client** (`/results`): results and vouchers a game's server signs, for grants by rank and contests.
- **Economy tools** (`@xgamesfun/solana`): the spec (version 2) with its JSON schema, the checker, the quick simulation,
  the setup plan, costs and a plain-words explainer.
- **CLI and MCP server**: ten `xsolana_*` tools (`guide`, `examples`, `check`, `simulate`, `cost`, `explain`, `client`,
  `save`, `publish`, `status`), the same from `xsolana <command>` and over MCP (stdio, protocol up to 2025-11-25).
- **`xsolana approve`**: a page on 127.0.0.1 where the owner connects a devnet wallet (any detected wallet) and approves
  each transaction. Requests must carry the session's token and a local Host; the page is served with a strict
  Content-Security-Policy. A notice (the program is unaudited and comes as is; the owner uses it at their own risk
  and answers for its legality: `DISCLAIMER.md`) and the legal flags the checker raises are shown in a block of their
  own, and Approve stays off until the owner ticks that they read them.
- **`xsolana connect`**: registers the MCP server and the skill with Claude Code and Codex, per user or per project,
  and only ever replaces or removes its own skill folder.
- **Skill and plugin**: the `xsolana-economy` skill and one plugin folder for Claude Code and Codex.
- **Examples**: whole economies that check and go live in the tests, and 112 real economies rated against 0.20.1.
- **TypeScript declarations** for every entry point, generated from the JavaScript when the package is packed.
- **MCP Registry** entry (`server.json`, `io.github.XGamesFun/solana-kit`).

### Tests

The tests run every instruction the client builds, and every example's whole setup, against the real program in
LiteSVM, with the programs it calls (SPL Token, Token-2022, Associated Token, Memo, Metaplex Core, Token Metadata,
Bubblegum, MagicBlock VRF) as the clusters run them and their feature sets and rent. `npm run fixtures` downloads them
and checks each against its pinned hash; no program checkout is needed.
