# The loot program: how it behaves

**Version 0.23.0**, program ID `9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`. **Devnet only**, and not deployed
yet: devnet runs 0.22.0 until it is. Nothing runs on mainnet. **Not independently audited** (`SECURITY.md`). No
accounts carry over from older versions: make fresh economies for this one.

What 0.23 changed, in short: who claimed what is kept in **lists of records** (a wallet's counts, a grant's claims and
rounds in shards), so one claim pays **several rounds**; a **lottery round is a record of its own** that moves on in a
few steps whatever its size (`settle_round`, then a `pull` a part), with **places as runs** and a **raffle of many
NFTs**; a **contest's entries are one list**, its winners sharing the losers' NFTs and its losers sending nothing; a
route's extra accounts are its **tail**, from the Memo program on; **several NFTs a call** on stakes, harvests,
stashes, holds, releases and makes; a **schedule catches up in one call**; an order's reserve covers everything its
settle may open. 0.22 made packs, tables, fresh and compressed items, stashes drawn by weight and profiles. Measured
costs below that were not measured again are marked as 0.20's.

This page says what the program does, who signs what, what it holds and what it costs, for anyone building on it
with `js/client` or the `xsolana_*` tools. **The IDL in `js/client/idl/loot.json` is the authority for every account
layout, argument and error code**; where this page and the IDL differ, the IDL is right. Client builder names are
given in `code` where they help (`openBoxIx`). To build an economy, start with the `xsolana-economy` skill and
`xsolana_guide`, not here.

## The whole program in one screen

loot is one Solana program every project shares. A **project** is one record owned by any wallet, numbered among
that wallet's own (`["project", creator, id]`; a wallet may have any number). It has no token or collection of its
own: each mechanic names the mint it takes, each item the Core collection it is minted into, and the project names
the Core collections it has authority over (any number). 58 instructions, each general enough for many uses.

A signature proves only what the chain can't see. Whoever sets something up signs once (the owner a mechanic, a
seller an auction, a player a purchase); after that, what the chain can check (a roll, a time, a stake, a bid) runs
with nobody's signature. Only an event off the chain (who won a match) needs a key to vouch for it.

Value moves five ways, and every move of a project's economy leaves a public receipt in the log:

| Verb | Instructions | Who signs |
| --- | --- | --- |
| **In**: money or an NFT comes in | `pay`, `pay_nft`, `buy`, `open_box` | the player; anyone for `pay` (a sponsor, the owner funding a pool) |
| **Out**: the project's tokens move | `move_tokens` | the authority |
| **Make**: collectibles made, rewritten, burned | `collectible` | the authority |
| **Decide**: the project names an outcome | `release`, `open_contest`, `decide`, `roll` | the authority; a contest's deciders sign verdicts anyone sends |
| **Grant**: a voucher names a winner | `claim_grant` | the winning wallet, with a voucher, a list proof, or nothing for an open grant |

The owner writes a mechanic once (`upsert`, or `open_farm`); players and anyone then carry it out:

| Mechanic | What it does |
| --- | --- |
| **Box** and shop | a weighted roll of entries, each any number of prizes, a burn of the payment, or nothing; a **pack**: several draws an open (`slots`) and several opens a purchase (`count`), all from one oracle answer; a box of one fixed entry is a shop item sold in one instruction (`buy`). A box can roll **on an NFT** (an enchant, an upgrade, a trade-in) |
| **Table** | weighted rows (labels or numbers) with stock, written in batches and sealed: what a fresh item's traits are drawn from |
| **Schedule** | a move of the project's tokens on a timer; sealed, from a vault only its runs pay out of (vesting) |
| **Lottery** | ticket money held apart, a draw, any number of places; raffles, a least sale, free tickets, NFT tickets, no-loss rounds |
| **Farm** | tokens or NFTs of any kind staked with lock tiers and boosts; a shared rewards pool or a fixed rate; points and levels; mission prizes and rolls |
| **Recipe** | collectibles, NFTs and tokens in; prizes out; numbers raised on what is kept |
| **Hold** | a player hands an NFT to the project until a time they choose |
| **Offer** | any wallet's money for any NFT that passes a rule: a bid, or a loan against it |
| **Listing** | any wallet's NFT for sale, or for rent by the period |
| **Contest** | players back a side with tokens or one NFT each; the named side shares the pot |
| **Auction** | the highest bid at the end wins a lot: a new item, a roll of a box, or an NFT |
| **Grant** | a reward others hand out, within limits the program keeps |
| **Stash** | NFTs of any kind the project holds to give away as prizes, each with a weight in the draws |
| **Profile** | numbers the project keeps about a wallet (XP, level, rank), read by rules as an NFT's attributes are |

**Chance** comes from MagicBlock's VRF oracle: box rolls, lottery draws, and `roll` for the project's own use.

**Incarnations.** A project numbers its contests, grants and lotteries with ever-increasing incarnations. A record
written again at an old address is a new identity: entries, verdicts and vouchers name the incarnation they were
signed for, and a grant's records and a lottery's rounds carry it in their addresses. A box purchase names the box's `version`; a
ticket purchase names the lottery's incarnation and `revision`.

**The project's vault for a mint** (its associated token account of the mint) holds open orders' payments, prizes set
aside, bids and offers' money, each paid out only by the record it belongs to. It never closes and nothing sweeps it,
so a purchase never write-locks the project. Pools never close either: a pool index always keeps its mint.

## Who signs

A project has two keys, its **owner** and its **authority**. Both are trusted, as is whoever controls its Core
collections. The program keeps players safe from each other, from the platform and from mistakes, not from the
project they chose to play.

| Role | Signs | Cannot |
| --- | --- | --- |
| **Player** | what they pay, and the most they will pay | be charged more than they signed for |
| **Authority** | what leaves a pool or is made on the project's say-so (`move_tokens`, `collectible`, `roll`); opens and decides contests; releases a hold while it runs. No caps | pay out of the vaults holding orders, prizes set aside, bids, offers, farms, contest or lottery pots; move a held NFT after its hold; touch a loan's NFT, a listed NFT, or an auction it did not put up |
| **Owner** | the project's settings (`update_project`: keys, treasury, pause, collections); every mechanic (`upsert`, `open_farm`, `open_pool`) | the same: money that belongs to a record |
| **Owner or authority** | `stash`, `open_tree`, `set_traits` | take a raffle's promised NFT out of its lottery's stash |
| **Platform** | its two fees, `collect_fees`, the suspend switch | stop a payout, settle, refund or unstake (two exceptions: [the switches](#the-switches)) |
| **Voucher keys** | who earned a grant: up to 3 named, or any number under a key root | give more than the grant's limits |
| **Grant winner** | its own claim, always | — anyone may pay its fees |
| **Deciders** | a contest verdict (any number, named at open), sent by anyone | name a side before entries close |
| **Offer or listing maker** | their own offer or listing, alone | — the project's keys have no say over it |
| **Auction seller** | `open_auction`, and calling off one with no bid | stop it once a bid is in |
| **Anyone** | settle, refund, `ask_roll`, run a schedule, draw and finish a lottery, release an ended hold, claim a contest entry, end an auction, repay a loan, refresh a seat, prove a compressed NFT or traits | — |

The owner alone signs for a new authority or treasury, so a multisig vault, a server key or any wallet can take a role.
The program refuses a key it can tell nobody signs for: a loot account, a token account or mint pasted as a wallet, or
a program (`BadKey`). A typo nobody holds can't be told from a real wallet: the owner checks the key.

## What the program protects, and what it does not

**It promises:**

- A player pays no more than they signed for, and pays the player fee once for what they ask for, never for the steps
  that follow.
- Money held for a record (an order, a prize set aside, a bid, an offer, a farm's stakes and rewards, a contest's pot,
  a lottery's pot and tickets, a sealed schedule's vault) leaves only by that record's rules. Neither project key can
  pay it out.
- No payment waits on a token account: the program opens the account it pays into, and the sender can't steer a share
  elsewhere (a wrong account in a share's place is refused).
- Nothing the platform signs stops a payout, settle, refund or unstake, except a recipe with a paid line.
- A topped bid goes back in the same instruction; an auction with a bid runs to its end and sells whenever it is ended.
- A voucher key never gives more than its grant's limits, and a grant round pays a wallet once per incarnation.
- An order rolls only on the box version it paid for, and what was rolled stays rolled.
- Whatever is decided can be finished by anyone, with no deadline.

**It does not protect against:**

- **The project.** Owner and authority are trusted: the authority mints, moves pool funds, writes the project's NFTs,
  decides contests and releases running holds.
- **A collection's controller.** A freeze, transfer rule, permanent transfer or burn delegate, or pNFT rule set can make
  an NFT refuse to move, or move it, even while the project holds it. Routes that need it to move wait. Offers, raffles,
  players' auctions and listings trust the collection they name.
- **A mint's issuer.** A freeze authority, pause, transfer hook or permanent delegate can stop or take that mint's
  transfers. loot refuses mints that could hold waiting money hostage (lottery pots and tickets, contests, auctions,
  offers, sealed schedules) but can't remove an issuer's power; USDC has a freeze authority.
- **Off-chain truth.** Voucher keys, deciders and result servers are trusted to report truthfully; the program checks
  their signatures, limits and replays, not what happened.
- **A typo** in a wallet the owner names.
- **Chosen shares as referrals.** A buyer-chosen share is a rebate the buyer directs and can come back to them; a
  grant's vouchers can prove a referral, a chosen share can't.

The hosted keeper is optional: any client can send settles, refunds, draws and cleanups, and none can substitute a
winner or bypass the program's checks.

## Accounts and addresses

Every address is a PDA of the program (`pda.*` in `js/client/pda.js`). Seed integers are little endian: a project's
`id` and an order's `nonce` u64, a pool's `index` u16, a grant's `id` u16, a hold's `free_at` i64, a shard and a page
u8, every other id u32.
Each loot account starts with a one-byte tag (`TAGS`, `decodeAny`). A record that must be new (farm, contest, auction,
order, offer) is created, never written over.

| Tag | Account | Address | Bytes | Rent paid by |
| --- | --- | --- | --- | --- |
| 1 | `Platform` | `["platform"]` | 73 | the platform, once |
| 2 | `Project` | `["project", creator, id]`; fee box `["fees", project]` | 153 + 32 a collection | owner; never closed |
| 3 | `Item` | `["item", project, id]` | varies (a fresh item's traits after its URI) | owner, back on close |
| 4 | `LootBox` | `["box", project, id]` | varies | owner; never closed |
| 5 | `Order` | `["order", project, player, nonce]` | sized to its box at the purchase (`orderBytes`) | player (or a prize's maker), back at settle or refund |
| 6 | `Schedule` | `["schedule", project, id]`; sealed vault `["vest", schedule]` | varies | owner |
| 7 | `Lottery` | `["lottery", project, id]`; pot `["pot", lottery]`; own stash `["lottery_stash", lottery]` | varies | owner; stash growth by whoever puts an NFT in |
| 8 | `Recipe` | `["recipe", project, id]` | varies | owner; never closed |
| 9 | `Hold` | `["hold", asset, free_at]` | 170 (a loan's 243) | player or borrower (`payer`), back on release |
| 10 | `Contest` | `["contest", project, id]`; pot `["pot", contest]`; split prize `["prize", contest]` | varies | the opening authority, back on close |
| 12 | `Sheet` | `["sheet", project, nft]` | 69 + attributes | whoever's write grows it (a write that shrinks it refunds nobody); anyone closes it once its NFT is burned (rent to the treasury) |
| 13 | `Traits` | `["traits", project, key]` | 97 | owner or authority; never closed |
| 16 | `LotteryRound` | `["round", lottery, incarnation, round]`; its token accounts `["round-tokens", round, mint]` | a header sized once at its first purchase, then an entry a purchase (`entryWidth`: 40 + 8 for a fee mint + 32 a recipient share + 32 an NFT ticket) | first buyer the header (back at the close), each buyer its entry (to the treasury at the close) |
| 17 | `Farm` | `["farm", project, id]`; vaults `["staked", farm]`, `["rewards", farm]` | varies | owner; never closed |
| 18 | `Seat` | `["seat", farm, player]` (tokens), `["seat", farm, asset]` (an NFT) | 232 | player, back on last exit |
| 19 | `Proven` | `["leaf", asset]` | 299 (331 with asset data) | first prover, back via `close_leaf` |
| 20 | `Auction` | `["auction", project, seller, id]` | varies, + 32 an NFT bid | seller, back at the end |
| 22 | `Offer` | `["offer", project, maker, id]` | varies | maker, back on close |
| 23 | `Listing` | `["listing", project, asset]` | 183 sale / 189 rental, + 3–35 a share | maker, back on close |
| 24 | `Profile` | `["profile", project, wallet]` | 69 + attributes | whoever's write grows it (a write that shrinks it refunds nobody); never closed |
| 25 | `Table` | `["table", project, id]` | 51 + 8 a row of numbers / 40 a row of labels; a committed table 1,107 | owner, as it writes rows; never closed |
| 25 | `Table` (a stash) | `["stash", project, id]`; a lottery's own `["lottery_stash", lottery]` | 103 with one NFT, + 36 an NFT | whoever puts an NFT in; never closed |
| 26 | a list (`decodeList`) | a wallet's counts `["counts", project, wallet]`; a grant's claims `["claims", grant, incarnation, shard]` and rounds `["rounds", grant, incarnation, shard]`; a contest's entries `["entries", contest, incarnation, 0]` | 7, + 28 a limit record, 16 a round paid, 43 or 83 an entry | the one counted (a grant's funds for a claim), never closed; a grant's shards close once it is gone (rent to the owner); a contest's with it |
| 27 | `Grant` | `["grant", project, id]` | varies | owner, back with funds on close |

Also: a **pool** is a plain token account at `["pool", project, index]` that only the project spends, opened by the
owner (`open_pool`), never closed. Every collectible loot mints of its own accord (an order's, a prize's, a craft's,
an auction lot's) is at `["asset", item, serial]` (`pda.itemAsset`): a serial is handed out once, so the address is
always new and the sender signs alone. A `Project` resizes only when `update_project` changes its collections (the
owner pays the growth and gets the shrink back). Tag 21, a stash's own account before 0.22, is no longer used: a
stash is a table of NFTs, each row its weight and its address (36 bytes), so an account's 10 MiB holds some 290,000.

**Tables** are read in place, never loaded whole: rows in blocks of 64 led by their weight in stock, blocks in groups
of 64 led by theirs, kept as rows are added and stock runs out. Writing and sealing a table of any size costs only its
rows' transactions, and a draw reads a few hundred numbers even at a million rows.

## Every instruction

Arguments are in the IDL. An instruction's own accounts come first, then remaining accounts in the order the builders
produce, then its **tail**: from the Memo program's account on, the accounts a transfer hook or a Core collection's
check reads (`tailOf`); with no Memo account, the tail is empty. An optional account left out is passed as the program's own address. A
player passes a **gate** with the first remaining accounts (after a box's prize accounts): a collectible shown
(`Gate::Holds`), the list proof's nodes as accounts (`Gate::List`), or the wallet's seat then the farm
(`Gate::Staked`). Fees: **P** player fee, **J** project fee, **free**.

| Subject | Instruction (builder) | Signs | Fee | Does |
| --- | --- | --- | --- | --- |
| Platform | `init_platform` (`initPlatformIx`) | the program's upgrade authority, once | — | makes the platform and its two fees |
| | `set_platform` (`setPlatformIx`) | admin (and a next admin) | — | changes fees (a raise waits 7 days) or hands the role on |
| | `collect_fees` (`collectFeesIx`) | admin | — | sweeps projects' fee boxes |
| | `set_suspended` (`setSuspendedIx`) | admin | — | suspends or restores a project |
| Project | `create_project` (`createProjectIx`) | owner | J | `id`, `authority`, `treasury`, `collections` (Core, update authority the owner or the project, none twice, `BadCollection`) |
| | `update_project` (`updateProjectIx`) | owner, and a new owner if named | J | keys, treasury, `paused`, collections |
| | `open_pool` (`openPoolIx`) | owner | J | a pool `index` in a mint, for good |
| | `upsert` (`upsertIx`, `closeRecordIx`) | owner | J | writes an `Item`, `Box`, `Schedule`, `Lottery`, `Recipe`, `Grant` or `Table` (a table's rows in batches, then sealed); `None` closes one |
| | `open_farm` (`openFarmIx`) | owner | J | a farm, never edited |
| | `open_tree` (`openTreeIx`) | owner or authority | J | a Bubblegum v2 tree for compressed prizes (the sender makes the empty tree account first, `treeSize`) |
| | `set_traits` (`setTraitsIx`) | owner or authority | J | the root of off-chain traits the project vouches for |
| In | `pay` (`payIx`) | anyone | P, or J for the project's keys | `amount` split by any number of shares, each its own transfer |
| | `pay_nft` (`payNftIx`) | the holder | P, or J | any NFT, given to a wallet or burned (never to a loot account, `ToTheProject`) |
| Boxes | `buy` (`buyIx`) | player | P | a box of one fixed entry, no roll, no subject (`Rolls`): price split, every prize given, one instruction |
| | `open_box` (`openBoxIx`) | player | P, held in the order | `count` opens in one purchase (more than 1 only for a box that packs, `BadEntries`), each at the price the one before left: the price into the vault, an order made, the oracle asked (or rolled at once if the box doesn't roll) |
| | `callback_roll` | the oracle | — | draws every card of every open from one answer, sets aside what it won (at most 21 accounts, a fresh item's tables counted, `TooManyAccounts`) |
| | `settle` (`settleIx`) | anyone | free | a part: delivers what was won from where the last part stopped up to `upto` (0, all that is left; `settlePartEnd`), `prize_accounts` of its accounts the prizes', `rows` the committed tables' rows its fresh units drew, proven. The last part pays the split, does the NFT's fate and closes the order |
| | `refund` (`refundIx`) | anyone | free | a failed order at once, a pending one after 1,500 slots (`orderRefundSlot`); never a rolled or waiting one |
| | `ask_roll` (`askRollIx`) | anyone, paying the oracle | free | asks for a waiting roll; again after `STALE_SLOTS` (`rollAskable`) |
| Project moves | `move_tokens` (`moveTokensIx`) | authority | J | from a pool or minted, to any `To`, fixed or a share of a pool |
| | `collectible` (`collectibleIx`, `makeIx`) | authority | J | `Make { item, tree, attributes }` for several owners at the item's next serials (or compressed into `tree`), `Set` (or a Sheet), `Burn` (rent to its holder), `Profile` (a wallet's profile) |
| | `roll` / `callback_random` (`rollIx`, `callbackRandomIx`) | authority / oracle | J / — | a random number for the project's own use |
| | `stash` (`stashIx`) | owner or authority | J | NFTs into a stash (or a lottery's own), each with its weight in the draws (above 0), or out to a wallet |
| | `run_schedule` (`runScheduleIx`) | anyone | free | every due run up to `upto` (`runsDue`), one transfer |
| Lotteries | `buy_tickets` (`buyTicketsIx`) | player | P | an entry in the current round (its first purchase opens it; its address names the incarnation), naming the round's `revision` (`TermsChanged`) |
| | `draw_lottery` / `callback_lottery` (`drawLotteryIx`, `callbackLotteryIx`) | anyone / oracle | free | asks for a due draw (again after `STALE_SLOTS`), lands it on the round's record |
| | `cancel_lottery` (`cancelLotteryIx`) | anyone | free | a draw unanswered 7 days after its first ask (`lotteryCancellable`) |
| | `settle_round` (`settleRoundIx`) | anyone; its payer opens accounts | free | a drawn round's places' prizes by a cursor, then its sweep; closes a finished round |
| | `pull` (`pullIx`) | anyone; its payer opens accounts | free | one part of one entry (`partsOwed`): its own, a recipient's, a run's places |
| Farms | `stake_tokens` / `unstake_tokens` (`stakeTokensIx`, `unstakeTokensIx`) | player | P | stake into a tier / take out (0 harvests and withdraws what unbonded) |
| | `stake_nft` / `unstake_nft` (`stakeNftIx`, `unstakeNftIx`) | player | P | an NFT on its own seat or as a booster / out after the lock, with a mission's prize or roll |
| | `harvest` (`harvestIx`) | player | P | rewards out, or `compound`ed |
| | `refresh_seat` (`refreshSeatIx`) | anyone (pays what growth adds) | free | re-reads boosts, the NFT, upkeep, the player's profile; writes growth |
| Recipes, holds | `craft` (`craftIx`) | player alone | P | all lines in and out, or nothing (`profile`, the player's, when a need or a raise names it) |
| | `hold` (`holdIx`) | player | P | NFTs handed to the project until `free_at`, a hold each |
| | `release` (`releaseIx`) | authority while it runs (J); anyone after (free); loans below | J / free | sends held NFTs on, one `to`; a hold whose `player` is the project's own address is owed to the treasury, sent to `project.treasury` as it is then (`releaseIx`'s `treasury`; `Released.player` the wallet it went to) |
| Contests | `open_contest` (`openContestIx`) | authority | J | terms fixed for good |
| | `enter` (`enterIx`) | player | P | a record in the contest's list, one side a wallet (`OtherSide`) |
| | `decide` (`decideIx`) | authority, or anyone with a verdict; anyone for an overdue contest | J; free when overdue | names a side, or `None` calls it off |
| | `claim` (`claimIx`) | anyone (only the winner picks losers' NFTs, `WinnerPicks`) | free | an entry's part of the pot, prize and the NFTs it names |
| Auctions | `open_auction` (`openAuctionIx`) | seller alone | P for a player's NFT, J for the project's lot | an auction |
| | `bid` (`bidIx`) | player | P | tops the high bid; the topped one goes back at once |
| | `end_auction` (`endAuctionIx`) | anyone once over; seller to call off one with no bid | free (J for the project calling off its own) | pays out, hands the lot over, closes; with `hold` (anyone), an NFT lot (its address alone, no proof) and a bid's winning NFTs become holds for whoever they go to, released after by anyone, the rent back to the ender |
| Offers | `open_offer` (`openOfferIx`) | maker | P, or J | a bid or a loan, all its money in the vault |
| | `close_offer` (`closeOfferIx`) | maker | free | what is left back to the maker |
| | `sell_to_offer` (`sellToOfferIx`) | the NFT's holder | P, or J | NFT to the maker, price to the seller |
| | `borrow` (`borrowIx`) | the NFT's holder | P, or J | NFT held against a debt, money to the borrower |
| | `repay` (`repayIx`) | anyone, before `due` | free | repayment to the lender; then anyone `release`s the NFT; names the debt its payer was shown (`repay`, `TermsChanged` otherwise; js/play `loan()` then `repay(asset, due, { repay })`) |
| Listings | `open_listing` (`openListingIx`) | the NFT's holder | P, or J | for sale or for rent |
| | `take_listing` (`takeListingIx`) | taker | P, or J | buys, or rents for 1 to `max_periods` periods |
| | `close_listing` (`closeListingIx`) | maker | free | NFT home; during a rental only stops it |
| Proofs | `prove_leaf` (`proveLeafIx`) | anyone (pays the record's rent once) | free | records a compressed NFT proven against its tree |
| | `close_leaf` (`closeLeafIx`, `closeSheetIx`) | anyone | free | closes a record that no longer reads (`StillProven` otherwise), or a burned NFT's Sheet (`NotBurned` otherwise; a Token Metadata NFT's names its edition, `edition`, and closes once its mint holds none, its mint authority is none or its edition, and its edition account is closed) |
| | `prove_traits` (`proveTraitsIx`) | anyone (pays the Sheet's growth) | free | writes vouched traits into a Sheet |
| Grants | `claim_grant` (`claimGrantIx`, `js/client/grant.js`) | the wallet always, plus a `signer` who pays (may be the wallet) | P, from the signer | gives the grant's prize for each round not paid yet; a voucher is an Ed25519 instruction right before (`ed25519Ix`) |
| | `close_shard` (`closeShardIx`) | anyone | free | a shard of a grant gone or made again, rent to the owner (`GrantLive` before) |

## Money in, and where it goes

### The split

A split is a list of shares, each basis points with a destination (`To`): a stored split (a box's, order's, lottery's,
contest's, auction's, offer's, listing's) holds at most 8 (`MAX_SHARES`, not in the IDL; a ninth is `BadShares`), a
`pay`'s as many as its transaction can carry. A step that pays many shares into accounts not open yet (an end, a
settle) stays under the 64-instruction trace limit when some of those accounts are opened first. What the shares leave goes to the split's owner: the treasury for a sale, the seller for an
auction, listing or offer.

| `To` | Paid to |
| --- | --- |
| `Burn` | burned |
| `Pool(index)` | one of the project's pools |
| `Account(key)` | a named token account |
| `Wallet(key)` / `Treasury` | the wallet's (or treasury's) associated account of the mint |
| `Holder(asset)` | whoever holds that collectible at that moment (a plot's owner, an arena) |
| `Chosen(item)` | chosen by the buyer at `open_box`, `buy` or `buy_tickets` (`chosen_recipient`): a wallet not the buyer's, or with an item, a collectible of it whose holder is paid. With no choice a wallet share goes to the treasury; a collectible share needs one a player holds (`BadChoice`). In a contest, the wallet `decide` names |

**Every part is rounded down** (a share, a share of a pool, a place's share of a pot, a contest claim, a price rise);
what rounding leaves goes with the rest, or stays in the pool or pot, and a contest's last claim takes the remainder.

**Where money goes.** Money owed to a person goes to their associated token account, which the sender opens (paying
its rent) when it isn't there, so a payment never waits. In a stored split, a share that finds nobody (a collectible
nobody or the project holds, a loot account as payee, an account that can't take the mint) joins what the split
leaves. The **split owner's** account failing fails `pay`, `buy`, `take_listing`, `sell_to_offer` and `settle` (the
money stays the payer's). Only `end_auction` of a seller's NFT (`Lot::Asset`), which nothing else could finish, passes
over a seller's account that can't take the mint: the lot still goes, and that money stays in the vault for good. A
new item's or a roll's lot whose treasury account is frozen waits (`AccountFrozen`) until it is thawed. `move_tokens` and schedules fail
on a pool never opened or on the project's vault (`BadMove`). `pay`'s shares are separate transfers, so a transfer
fee comes out of each.

### The fee

Two flat SOL fees, set by the platform, each capped at **0.01 SOL**, a raise waiting **7 days**. They land only in the
project's own fee box (`["fees", project]`); only the platform takes them out.

| Fee | Default | When |
| --- | --- | --- |
| **Player** | 0.002 SOL | a player signs for something of their own: `pay`, `pay_nft`, `buy`, `open_box` (held in the order; back on refund), `craft`, `buy_tickets`, stake, unstake, harvest, `hold`, `enter`, `bid`, `open_auction` of their NFT, `open_offer`, `sell_to_offer`, `borrow`, `open_listing`, `take_listing`, a grant claim (from the signer, never the grant's funds) |
| **Project** | 0.00001 SOL | the owner or authority acts as the project: `create_project`, `update_project`, `open_pool`, `upsert`, `open_farm`, `open_tree`, `set_traits`, `stash`, `move_tokens`, `collectible`, `roll`, a running hold's `release`, `open_contest`, `decide` (a verdict too), the project's `open_auction` or its call-off, and `pay`, `pay_nft`, offers and listings by the project's keys |
| **Free** | — | what follows from a paid step (claims, a round's `settle_round` and pulls, auction ends, settles, refunds, repayments, closes), rolls other steps make, and the cranks: callbacks, `ask_roll`, `draw_lottery`, `run_schedule`, `prove_leaf`, `prove_traits`, writing down an overdue contest |

On routes a player's signature asks for, the project's keys pay the player fee when they sign. A signer with too
little SOL is refused (`NoSolForFee`).

### The switches

The owner's **pause** and the platform's **suspend** stop money and NFTs coming in from players: purchases, payments,
tickets, entries, stakes and compounds, holds, opening an auction, bids on the project's own auctions, opening or
taking offers and listings. They never stop what is owed or given out: grant claims, settles, refunds, unstakes,
harvests, lottery draws and payouts, contest claims, repayments, closes, auction ends, bids going back, and recipes
that take only NFTs. A `pay` by the project's keys still goes through, so a paused project can fund its pools. A
**player's** auction takes bids whatever the switches say; which auctions are the project's is fixed at open
(`Auction.ours`).

A recipe with a `Pay` line waits on both switches, which has two effects: an **unbind** that charges keeps a bound
set's pieces locked in their farms while the switch is on, and a **refuel** that charges can't be bought while upkeep
runs out, so a suspension longer than a staked NFT's fuel marks its seat dry and loses its mission prize. Give unbinds
and refuels no `Pay` line, or let players buy a whole mission's fuel ahead.

### Token accounts, SOL a record holds, writable mints

The program opens every token account it pays into, in the instruction that pays, at the signer's cost: the project's
vault for a mint at the first purchase or bid in it, the treasury's and payees' accounts, a refund's or prize's
receiver, an outbid bidder's. **Never a pool**: a `pay` or move into a pool never opened fails. The project's own
accounts (pools, farm vaults, pots) open with their record.

An order holds 0.006 SOL toward each collectible (or fresh compressed item) its box's richest entry gives, for each
draw of each open (`ESCROW_LAMPORTS`), and the fee; a grant holds its funds. The record lends this to the signer for rent and takes back what wasn't spent, so whoever
settles needs no SOL, and a grant claimant only the fee. The treasury is a wallet; if its owner closes its account of
a mint, the next sale reopens it.

Pass a mint writable only when its supply changes (a burn or a mint), so transactions in one token don't queue: `pay`,
`buy`, `settle` and a sale's `end_auction` when something burns; `move_tokens`, `run_schedule` when minting or
burning; `decide` when a share burns or it calls off an empty contest; `claim` when it leaves nothing owed; a minted
token prize's `pull`, and a round's close (its mints with the accounts it closes); a recipe's `Pay` lines always. The
builders do this.

### Token-2022

Every token can be SPL Token or Token-2022, in any role. Every transfer is `TransferChecked`; transfer hooks get their
accounts (never a loot signature); required memos are sent; withheld fees are swept before a close. Where loot
records an amount (a payment, a stake, a bid) it records what **arrived**; a payout receipt names what was **sent**.

| Mint feature | Refused for |
| --- | --- |
| Confidential transfers | prizes on every route; lottery, contest, auction and offer mints |
| Non-transferable | prizes from a pool or won in a box's roll (minted straight to a winner elsewhere, it is given); lottery mints; sealed schedules |
| Default frozen, or a freeze authority that can switch it on | lottery pots and tickets, contests, auctions, offers, sealed schedules |
| A permanent burn authority (and wrapped SOL) | wherever loot would later burn from an account it holds, refused before money comes in (`BurnLocked`): a box that burns, a burned ticket or burning lottery share, burning auction and contest shares, a farm whose rate mints or whose toll or early exit burns, a sealed schedule that burns |
| A transfer hook | prizes of a box that rolls (`PrizeHasHook`) |

Tokens include wrapped SOL, which a client wraps and unwraps in the same transaction; there is no other SOL path.

## Prizes

One `Prize` is what every route gives: a grant (`gives`), a lottery place, a contest's winning entries, a mission's
tier, a recipe output, a box entry (any number).

| `Prize` | Gives | Where |
| --- | --- | --- |
| `Tokens { from, amount }` | minted (the project the mint authority) or from a pool; `Fixed` or `Bps` of the pool then (a jackpot) | every route |
| `Item(id)` | one collectible at `["asset", item, serial]`, or a normal item the project's backend delivers from the receipt | every route |
| `Nft { stash, nft }` | a named NFT the project holds in a stash | every route |
| `Roll(box_id)` | a roll of one of the project's boxes: a waiting order for the winner | every route |
| `Compressed { item, tree }` | a new compressed NFT of a collectible item, minted into the project's tree (`open_tree`) in the item's collection (which carries Bubblegum's `BubblegumV2` plugin), named "<name> #<serial>", counted against supply. No rent, only Bubblegum's fee; no attributes of its own (a fresh one's traits go in the project's Sheet of it). In a box, its serial is set aside at the roll and it is minted at the settle into whichever of the project's trees the settle passes | every route |
| `Stash(id)` | an NFT of a stash, drawn by weight | a box entry only |
| `Held(nft)` | an NFT in the lottery's own stash (a raffle) | a lottery place only |

Each prize given leaves `PrizeGiven`. Its accounts follow the instruction's own (`prizeAccounts`): tokens the mint,
the pool if any, the winner's account; an item, and for a collectible its collection, new address and Core; an NFT its
stash, the NFT's accounts and proof; a roll the box and the order.

**A prize that can't be given** (an item sold out, off or closed; an NFT no longer in its stash; a pool short of a
fixed amount or never opened; a mint the project can no longer mint; a compressed URI too long; a box nobody wrote):

- a route that **finishes what was decided** (a lottery place, a contest claim, a mission's end) goes on without it;
- a route a **player pays or asks for** (`buy`, `craft`, `claim_grant`) refuses (`PrizeNotCovered`), including a pool
  share that comes to nothing; a refused grant claim keeps its round;
- an account at the wrong address for its kind is refused, never read as a missing prize;
- an NFT whose collection refuses the move fails the instruction while it refuses; the owner can take it out of the
  stash to let a lottery place or contest claim go on (not a raffle's promised NFT).

A stash shared by several routes can be emptied by one before another gives its prize. A scarce contest prize goes to
the first winning claim.

**Where a roll prize waits**: at `["order", project, winner, prizeRollNonce(n)]`, the first 8 bytes (little endian)
of `sha256("prize" | n as u64 LE)`, `n` the route's `nonce` argument plus the place or index where the route says so.
The sender pays the order's rent and escrow (a grant's funds, for a grant); the winner gets both back at settle.
Anyone asks and settles it. A roll an order won is made at settle at `rollNonce(order, requested_slot, k)`:
`sha256("roll" | order | slot u64 LE | k u8)`, out of reach of any chosen nonce.

## Boxes and the shop

**Items** (`ItemArgs`): `kind` (`Normal` or `Collectible`), `rarity`, `soulbound`, `burnable`, `name`, `uri`
(`{serial}` is replaced by each unit's serial), `max_supply`, `life`, `active`, `traits`, and for a collectible its
`collection` (one of the project's; fixed once a unit is out, `KindLocked`), which a collectible's upsert passes as its
first extra account (`BadCollection` without it): the item records whether it carries Bubblegum's plugin
(`Item.compressed`), and without it a compressed prize of the item is never there (`open_box` `SoldOut`; `buy`, a grant,
a craft `PrizeNotCovered`; a mission, a lottery or a contest gives nothing). The program keeps names and URIs of any
length; Metaplex Core and, for a compressed NFT, Bubblegum (32-byte names, 200-byte URIs) bound them. Items have no
price; boxes sell them. Lowering `max_supply` below what is out reads as sold out. Switched off, an item isn't sold,
dropped, crafted or given (the authority's `Make` still works). A **normal** item is delivered by the project's
backend from `PrizeGiven` or `OrderSettled` in a finalized transaction with `meta.err` null, once per order or
reference.

**Fresh items** (`Item.traits`): a collectible whose units differ. Each trait is a key and where its value comes
from: a table (`Values::Table`), a row drawn by weight among those in stock at the roll, kept in the order
(`Order.drawn`); a committed table, a row drawn at the mint and proven by the settle (`rows`, `WrongRow`); or a range
(`Values::Range { min, max }`), every number as likely, drawn at the mint. Whoever settles, whenever, the same answer
gives the same unit. Its name and URI take the values (`{key}`, beside `{serial}`), and the traits are written on the
collectible. A key is the project's own, each once (`BadItem`); the traits lock with the rest once a unit is out. A
fresh item is given only by a box's roll (`PrizeNotCovered`: not by `Make`, `buy`, a grant or a recipe's output; a lottery
place, a contest's prize or a mission's end gives nothing in its place; an auction refuses it as a lot, `LotRefused`):
one in a box asks the oracle even as its only entry. A compressed prize is given only into the project's own tree
(`open_tree`): any other gives nothing (`PrizeNotCovered` on a strict route).

**Tables** (`upsert` `Def::Table`, `["table", project, id]`): rows of a weight, a stock (`NO_LIMIT`, 4,294,967,295,
for none) and a payload (a number, the row's own; or a label of up to 32 bytes), posted in batches and sealed. From the
seal its weights never change and its stock only goes down, so an order that drew from it, or a page that shows its
odds, can't be changed under; only a sealed table is drawn from. Rows on chain are bounded by an account's 10 MiB
(some 250,000 labels or 1.3 million numbers). A **committed** table (`committed`) keeps only the Merkle root of its
rows (1,107 bytes; a leaf is `sha256("loot-row-v1" | index | from | weight | payload)`, `from` counted by the program
as it folds each in): any number of rows, no stock. Its rows stay in the transactions that posted them, so whoever
serves proofs keeps them. A million rows: a proof of 20 nodes (692 bytes), one such card a settle part. The tools
write tables of rows on chain only.

**The shop.** A box of one entry, nothing random, no subject, sells in one `buy`: the price (after `fall`, within
`max_price`) split at once or burned, every prize given, no order, no oracle. The box's gate, window and limits apply.
The same box can still be opened with `open_box`.

**Entries** (`DropEntry { prizes, burns, weight }`): any number of prizes, and whether the payment burns instead of
splitting. No prize is "nothing" (the payment still splits). An entry is in the roll's table while it can give every
prize it names (an item in supply, a fresh item's tables not empty, a stash that holds an NFT, a pool that covers it);
`stock_odds` scales its weight by the share of its first item's supply left. A box rolls on the oracle when it has
more than one entry, a `Stash` prize or a fresh item (`boxRolls`, `boxFresh`). Entries are named in two bytes; how
many a box holds is bounded by what its oracle answer reads (21 accounts: [Limits](#limits)).

**Packs** (`LootBox.slots`, `open_box`'s `count`): what one open draws is its slots, each `Slot { count, only,
distinct }` drawing `count` entries among those `only` names (all, when it names none), no entry twice with
`distinct`; no slots is one draw among every entry. A pack of 5, a guaranteed rare (four draws among all, one among
the rares), a hand of different cards. A purchase of `count` opens is paid together, counted against a wallet's limit
once each, and drawn from one oracle answer, each draw at its own path in the answer, weighted by the odds the
purchase fixed and reading the stock the draws before it left. Answers are never shared between players. A slot that
finds nothing more in stock draws nothing more; the order keeps what it has. A box of one entry of items packs too:
that many of it, set aside at the purchase with no oracle (refused unless all of it is given, `PrizeNotCovered`), or,
with a fresh item, rolled. A pack has no entry that burns the payment and no NFT rolled on (`BadEntries`). Measured
on 0.22: a card costs the oracle's callback 2,600 to 3,700 compute units at 2 to 16 entries, so one answer draws
about 66 to 106 cards.

**Stashes.** The owner or authority puts NFTs of any kind in, each with a weight (`stash`'s `weight`; soulbound ones
can't move), and takes them out to any wallet, never to a loot account (`ToTheProject`); "out" to the project's own
address only drops it from the table. A `Stash` prize draws by weight from the oracle's answer and takes the NFT out at
once (the last row takes its place), so two winners never get the same one. An empty stash can't be won; a box of
only empty stashes sells nothing (`SoldOut`). Rarity tiers are weights in one stash, or several stashes with their
entries' weights; a stash of one NFT raffles it. A stash's draw costs the callback about 25,000 compute units at ten
NFTs and 33,000 at 290,000 (0.22).

**Prizes are set aside at the roll.** `open_box` refuses while a fixed amount isn't covered by its pool or a minted
prize's mint isn't the project's (`PrizeNotCovered`; a jackpot share never blocks a sale). The roll sets each prize of
each drawn entry aside in the order (`Order.won`: an item's serial, tokens moved into the vault, an NFT out of its
stash with its weight, a roll to make, a fresh item's serial with the rows its table traits drew, a compressed item's
serial). Two winners rolled before either settles are both paid. A prize left short by an earlier prize of the same
entry is left out; the order is rolled either way. `settle` hands each over. If a won NFT's collection starts refusing
the move, the player settling their own order may pass its stash instead: it goes back, with its weight, while the
rest settles.

**Compressed items in a box** (`Prize::Compressed` in an entry): a plain one costs its player no rent and its order
holds none; a fresh one's traits go in the project's Sheet of it, the order holding that rent. A soulbound item, or
one whose URI could outgrow Bubblegum's 200 bytes with its values in it, is out of the box's table. The collection
must carry Bubblegum's plugin: a settle into one without it fails, and a rolled order waits until it has it.

**Settling in parts.** An order is made at its smallest and grown at the purchase to all its box can set aside
(`Order::space_for`, `orderBytes`), holding a collectible's rent for every card it may mint, so anyone settles it, in
as many parts as the chain needs: each `settle` carries out the prizes from where the last part stopped
(`Order.settled`) up to `upto`, and writes its receipt (`OrderPartSettled`) before it mints, so a log Solana cuts at
10 KB keeps it. The first call splits the payment, its shares' accounts and their hook tail with it (`upto` =
`SETTLE_SPLIT`, u32::MAX, splits and gives no prize, accepted only before the split: sent first when a prize can't land
yet, a winner's account its issuer froze, so the shares are paid); the last part (`upto` 0, or past the end:
`OrderSettled`) carries out the NFT rolled on, pays the undrawn draws' share back, gives whatever prizes are left
(maybe none) and closes the order. A part before it (`upto` at most the end) gives prizes with a stand-in piece.
`OrderPartSettled` carries `amount` and `treasury_remainder` when it split; in a settle of several parts the last's
`OrderSettled` has them 0. A compressed prize's item account is written; one of an item whose collection lacks
Bubblegum's plugin mints nothing, so the next one's Sheet is at the tree's count one less (`wonAccounts`' `unminted`). A transaction's instruction trace (64 calls) binds
first: measured on 0.22, one settle mints about 14 Core cards, 10 compressed or 8 fresh compressed (`settlePartEnd`,
`settleParts`); then 64 accounts and 1,232 bytes: js/play's `openBox` sends prizes in parts, each shrunk until it fits,
then the last part, all from the throwaway key. Rows of committed tables a fresh unit drew are proven in the data
(`52 + 32 × depth` bytes a row, `MAX_PROVEN_BYTES` 800 a unit: an item past it is out of stock); the tables the economy
tools write are never committed. An open's order is at most 10,240 bytes (`MAX_ORDER_BYTES`, about 243 one-prize
draws, its stored shares counted): a box past it is refused at its upsert (`BadEntries`). An open of a box of one entry
and more than 100 draws (and a call giving a roll of one as a prize) asks for a 256 KiB heap (`boxHeapFrame`): 120
draws fit the 32 KiB a transaction has, 150 don't.

**Prices** are in the box's `currency`. `rise { step, growth_bps }` lifts the price after each sale (rounded down: a
10% rise on a price of 9 base units adds nothing). `fall { step, every, floor, since, shared }` lowers it with time
to a floor (0 can reach free). `max_price` protects the buyer; `version` covers only what the roll reads, so a moving
price never breaks a purchase. A price of 0 is a free box: the player still pays the fee (and an opened box's escrow,
whose change comes back).

**Window and limits**: `window { opens_at, closes_at }` (0 is no bound; `NotOpenYet`, `WindowClosed`) and
`per_wallet { total, per_window, window }` in the buyer's counts; a refund gives its count back. `active` stops sales.
**Odds**: entries raised for a player who shows a collectible (or whose profile says so), fixed in the order at
purchase.

**Edits.** An edit of entries, odds, `stock_odds`, `subject` or `fates` bumps the version: a waiting purchase fails and
refunds what it paid. A roll won on another route (a lottery place, an auction lot, a chest, a recipe, a grant) paid
nothing into its order, so its refund returns nothing but an NFT it held: **edit a box's roll only while no roll of it
waits**. Other edits (price, shares, switch, window, gate) leave orders alone. A refund keeps the price rise its
purchase applied until the owner's next edit.

**Order lifecycle** (`OrderStatus`): `Pending` (opened, roll asked), `Rolled`, `Failed`, `Waiting` (made by another
route, not yet asked), `Asked`. Every order receipt carries `requested_slot`, naming the purchase at a reusable
address. An order never settles or closes in its opening slot (`SameSlot`). A failed roll refunds at once; one that
never arrives refunds after 1,500 slots (about 10 minutes). A rolled order is settled by anyone, never refunded
(`BadOrderState`).

## A roll on an NFT

A box with a `subject` (a rule) rolls on an NFT that passes it: one a player brings to `open_box`, one leaving a
mission (a tier's `roll`), or one a recipe keeps (`Output::RollOn`). Its `fates` (`Fate { entry, shifts, then }`, one
an entry) say what each entry does:

- `shifts`: numbers moved (`Shift { key, by, most, from_now }`), never below 0 nor above `most` when raising;
  with `from_now` a time moved from now, at most `most` seconds ahead (a day in jail). Written on the NFT where the
  project may, otherwise its Sheet.
- `then`: `Back` to its player; `Burn` (Core by Core, rent to the settler; others to the incinerator); `Give(wallet)`;
  `Stash(id)` (a trade-in becomes another player's prize).

A box whose every entry burns, gives or stashes the NFT takes it as its price.

- **Custody follows the fates.** A box that can burn, give or move the numbers of an NFT that can move takes it into
  the project's hands when the roll is made, so nobody sells it after seeing a bad roll; a refund sends it home. A
  soulbound NFT is rolled where it is.
- **One roll at a time on an NFT.** Such a roll is at the NFT's own nonce (`nonceOn`: the first 8 bytes of its address,
  little endian; `SubjectNonce` otherwise), so a second waits for the first, and rules read what the last roll wrote.
  An NFT frozen on a farm seat is refused. A craft's `RollOn` and a mission's roll name a nonce and are made at
  `namedRollNonce`: the NFT's own on a box that holds it, whatever was named; otherwise `prizeRollNonce` of the named
  one (a mission of several names seat `i`'s roll `nonce + 2i`, its prize's `nonce + 2i + 1`). Only a mission roll
  asked and come back empty (`Waiting`, `asked_first` set) stands in for the next: any other at that address makes
  `unstake_nft` fail (the System program's "already in use"), so the last one is asked, answered and settled first, in
  transactions of their own (js/play's `unstakeNft` says so; `claims()` lists the step).
- **What was rolled stays rolled**: the fate is copied into the order at the roll.
- `settle`, `refund` and `end_auction` pass their remaining accounts to the NFT's move, so a Core collection's transfer
  checks find what they read.

**Rolls that wait.** Missions, recipes and prizes make a `Waiting` order (the player's rent, or a prize maker's, back
at settle). Anyone asks (`ask_roll`, paying the oracle) and anyone settles. A waiting or asked roll is never refunded;
one unanswered within `STALE_SLOTS` is asked again by anyone, and the first answer to any request rolls it. One whose
box can give nothing when the answer comes goes back to `Waiting` until the owner restocks. It fails at its ask, giving
back only what it holds, if its box was edited or pays a prize in a hooked mint; routes a player pays for (craft, `buy`
bundle, grant claim) check the hook first and refuse (`PrizeHasHook`). A box only missions, recipes or prizes roll is
left switched off; such orders ignore the switch and window.

- **A mission's roll** needs an NFT farm and a tier with a lock (`BadFarm`). Leaving after the lock, an NFT that fits
  the subject is rolled; one that doesn't goes home unrolled. Growth stops at the lock's end.
- **A recipe's roll** on a kept NFT needs a Core asset where the box takes custody (`NeedsCustody`); a Token Metadata or
  compressed NFT isn't held, so a cap its rules keep holds a wallet, not the NFT. A box with a subject rolled on nothing
  gives its entries without fates.

A `pay`'s `reference` is only a label, and `roll` keeps no per-request record: apps deduplicate their own effects, or
use orders, contests, lotteries or grants when the program must enforce one payout.

## The owner's records

`upsert(Some(def))` writes one record; `upsert(None)` closes the one at `target`. `Def` names the kind and id, and the
address follows, so no kind or project is ever written over another. **An edit is the whole record** (a gate or odds
left out is gone) and keeps what the record has done (units out, runs, rounds, counters). Writes leave `RecordWritten`,
closes `RecordClosed`. A record closes only when nothing pending depends on it, rent to the owner, and counts from 0 if
written again.

| Record | Closes |
| --- | --- |
| Item | only while none was ever handed out |
| Schedule | any time; a sealed one never |
| Lottery | with nothing sold and nothing pending: both vaults swept where the owner says and closed. Mints are fixed for an incarnation |
| Grant | any time, unused SOL to the owner; written again it is a new campaign that refuses old vouchers |
| Box, Recipe | never: a version must never come back at the same address |
| Table | never; sealed, its weights never change and its stock only goes down |

## Schedules

Every `every` seconds, one run of its `action` (`{ from, to, amount, halve_every }`): the move `move_tokens` makes,
from a pool or a mint the project controls, fixed or a share of the pool, halving every N runs if asked. It starts no
earlier than now. One `run_schedule` makes every run due, up to `upto` runs made (the client passes the runs it has
plus those due, `runsDue`) and a step cap a call, each run paying what it would alone, in one transfer and one
`ScheduleRan` (`from`, `run`); a backlog of 35,040 runs takes a few calls. It stops after `max_runs`. A move that can't
be made fails the call. A schedule that moves a pool into itself is refused when written.

**Sealed** (`TokenSource::Vest(mint)`): it pays from its own vault `["vest", schedule]`, opened when written and funded
by anyone at any time. Nothing else pays out of it, and it is written once (`Sealed`). It must be on, have 1 to 100,000
runs ending within 10 years, no share above the whole vault, and a destination every run can always pay: a burn (not
wrapped SOL), a wallet someone holds (on the curve), a pool or associated token account of the vault's mint, a
lottery's pot (passed with its lottery), or the treasury; never a collectible's holder or a chosen share. Its mint
can't be default-frozen, non-transferable, confidential, or have a permanent delegate or a close authority
(`BadSchedule`, `BadMove`). A run never pays more than the vault holds; the last pays all, and later deposits go to
the same place. Pause and suspend stop none of it. A cliff is a first run in the future; a timelock is one run. It is
as safe as where it pays: into a pool, tokens are the authority's once they land.

## Lotteries

`LotteryArgs { terms, every, gate, per_wallet }`, its `terms` a `LotteryTerms { price, mint, shares, places,
ticket_mint, draws_at, nft_ticket, returns, min_sold }` (`withDefaults` takes them beside `every` too). Tickets are paid
in `ticket_mint` (burned) when it is set, else in `mint` (`paymentMint(terms)`). The prize pot is `["pot", lottery]`.
The lottery keeps its terms, its incarnation and its round number; each **round is a record of its own**,
`["round", lottery, incarnation, round]` (`decodeRound`), opened by its first purchase, which copies the terms (its
`terms` and `revision`; later purchases name the round's `revision`; the gate and `per_wallet` are read live). The round holds its money in token accounts of its own, `["round-tokens", round, mint]`, so a cancel
moves nothing and the pot holds only what nobody is owed. A draw more than 5 years off sells nothing (`SalesClosed`).

**A purchase** appends an entry (`entryWidth`): its buyer, where its tickets end, what arrived (a fee mint), a wallet for
each buyer-chosen or holder share (fixed now; one nobody can pay joins the pot's part), its NFT ticket. The buyer pays
its bytes (not refunded: they go to the treasury at the close); the round's first buyer fronts its header, back at the
close. A round holds about 70,000 to 260,000 purchases, by its entries' width.

**Draw.** Anyone sends `draw_lottery` once due, with the round's record, the oracle request's only account. Places are
runs: `{ bps, prize, times }`, `times` places alike (a named NFT, a roll or a share of a pool is one place's), drawn by
evenly spaced tickets with rejection sampling. A round nobody bought into has no record: a repeating one moves its
date, one that draws once ends. An unanswered draw is asked again after `STALE_SLOTS`; only a draw unanswered **7 days
after its first ask** lets anyone cancel the round. A short round (`min_sold`) is cancelled at its draw.

**A drawn round moves on in a few steps** (`settle_round`, anyone): a cursor gives the places' prizes in place order
(a call stops at the first token run whose accounts it doesn't carry, and succeeds: `settleRoundIx`'s `runs` keeps a
call of hooked runs under 64 accounts, the next call going on from the cursor, and such a call asks for a 256 KiB heap),
an NFT or a collectible to its winner, a run of token prizes in one step into the round's account (minted ones at the
pull); its last part **sweeps**: the common shares paid, the pot and the places' parts of it netted into one transfer,
and the lottery moves to its next round. A stuck NFT prize holds the cursor until anyone turns it into a hold for its
winner (`hold`; its rent, and a Token Metadata NFT's account's, back to whoever sent it, `rent_to`, at the release; the
authority's mark of a pool's run is the 10 named accounts, then that run's mint and pool and the hook tail alone: a call
carrying the round's token account, the sweep's or the close's moves the run instead); the project's authority may mark a transfer that can be seen to be stuck (`NotStuck` otherwise; a pot
mark also when the places take nothing of it). In a payment mint with a transfer hook the sweep goes a step a call:
each common share above 0 that isn't a burn, then the pot, with the same accounts each time; the round stays Drawn
(its cursor past its places) until the pot's step sweeps it, so whoever moves it on (a keeper, the page's
`settle-round` claim, listed again while it is Drawn) calls again. The authority's mark covers only the step at hand.
With no place sharing the pot, a marked pot step fails with the token's error until the pot can take the part. A mint
with no hook sweeps in one call.

**Then each part is pulled** (`pull`, anyone, `partsOwed`): an entry's own (a refund, a no-loss ticket's price, its NFT
ticket back or where its price sends it), each recipient's share, its places' pot parts and token prizes in one run:
at most 300 places a pull (`MOST_A_PULL`, not in the IDL), lowest first, the next pull paying the next ones; such a pull
closes the round only when the places of those 300 that take something are the last parts owed (`placesPulled`).
Each part waits under its own bit, holding up nobody else; the pull (or step) that leaves nothing owed closes the round,
burning what nobody is owed and returning each account's rent to its opener.

**Variants:**

- **Raffle**: draws once; a place gives `Prize::Held(nft)` from the lottery's own stash, or `Prize::Raffled` (a run of
  places, each an NFT drawn at random from it), never both. The stash is filled with `stash` (`StashOf::Lottery`, several
  NFTs a call); the write refuses an NFT not there or fewer NFTs than raffled places (`NotInStash`). Nothing comes out
  but a place's prize while the lottery runs (`Promised`).
- **Least sale** (`min_sold`): a due round that sold fewer is cancelled at its draw, no oracle, everyone refunded.
- **Free tickets** (`price` 0): only the player fee; `per_wallet` keeps one wallet from most tickets.
- **NFT ticket** (`nft_ticket: { rule, then }`): one ticket for one NFT (`OneTicket`), held until the draw, then
  burned, given or stashed by its pull; home if cancelled. No price, shares or ticket mint.
- **No-loss** (`returns`): after the draw every ticket is owed back whole; winners take only what was paid into the pot.

Pot and payment mints can't be non-transferable, default-frozen or switchable to it, or confidential (`BadLottery`); at
most 8 shares (`MAX_SHARES`, as every split kept to be paid later) and 8 mints. Edits apply to the next round (the gate and `per_wallet` at once); closing or making a
draw-once lottery again waits while its current round has a record (`RoundRunning`). `per_wallet` counts tickets per
round in the wallet's counts.

## Recipes

`RecipeArgs { active, inputs, outputs, needs, keeps, raises, window, per_wallet }`: any number of lines in and out,
as many as one transaction carries, all or nothing; up to 255 collectibles a craft (a byte names each one's place).
Recipes that give only fixed token amounts can be crafted many `times` at once.

| `Input` | Takes |
| --- | --- |
| `Burn { item, count }` | collectibles of an item, burned |
| `Use(item)` / `Renew(item)` | one collectible, used (by its `life`) or renewed, and kept |
| `Pay { mint, amount, to }` | tokens burned or sent |
| `Show { collection }` | any NFT of a collection the player holds, kept |
| `Staked { item, farm }` | a collectible on its own seat in that farm (`NotFarmed` elsewhere) |
| `Trade { collection, then }` | any NFT of a collection: burned, given or stashed |

Outputs: `Output::Prize`, all of each or refused (`PrizeNotCovered`); or `Output::RollOn` (a roll on a kept
collectible). `needs` (`{ place, key, at_least }`, `NeedNotMet`), `keeps` (attributes passed to a new collectible),
`raises` (`{ place, key, by, most, from_now }`: up to `most`, `MaxedOut` when there; `by` below 0 lowers it; with
`from_now` a time, fuel for a day more). A raise on a `Staked` collectible must move its farm's lock key (`BadRecipe`).
An item's `life` (`{ ready_after, lasts, uses, cooldown }`) is written on the collectible as `made`, `used`, `used_at`
(`NotReady`, `Expired`, `UsedUp`). A collectible on its own escrow seat can be used or renewed in place (refuel a ship
on a mission) but not burned or rolled away (`AlreadyStaked`). A need or a raise at `PROFILE_PLACE` (255) reads or
moves the player's profile instead (a level bought); such a recipe is crafted once at a time (`OnceAtATime`).

**A set bound into a badge**: a recipe of `Staked` pieces that makes a badge and raises, on each piece, a `bound` count
and its farm lock far ahead, so the pieces stay staked while the badge exists. Unbinding burns the badge and moves
them back. Give the unbind no `Pay` line.

## Holds

`hold(free_at)` hands NFTs to the project, each at `["hold", asset, free_at]` (several a call, one fee). Until then the
authority may `release` them to any wallet (never a loot account, `ToTheProject`); after, anyone releases them home. A
release names its holds by address, so one signed for an earlier hold never lands on a later one; holds of one player
with one end go together. A hold names its `player`, who made it (`payer`, back its rent) and who paid its NFT's
account (`rent_to`). A Token Metadata NFT waits in the project's token account (closed on the way out); a compressed one
becomes the project's leaf.

## Contests

`ContestArgs { sides, closes_at, result_by, shares, gate, deciders, min_pot, stake, prize, nft, prize_split, cap }`,
fixed at `open_contest` for good. `result_by` is at most 5 years out (after `closes_at` when there are deciders).
Entries and decisions name the incarnation (`TermsChanged`). Sides are `u16`.

- **One list of entries** (`["entries", contest, incarnation, 0]`, `decodeEntries`): a record a player, one side a
  wallet (`OtherSide`), its bytes the player's (not refunded). With `stake`, every entry exactly that, once (`BadStake`):
  a wager. With `min_pot`, no side wins below it (`BelowMinPot`) and a contest short of it when entries close is off: a
  crowdfund.
- **Verdicts**: a decider signs `"loot-verdict-v4" | sha256(program | contest | incarnation (u64 LE) | side (u16 LE,
  65,535 is off) | expires (i64 LE))`, the body ending `| recipient` for a contest with a chosen share (`verdictBytes`),
  checked by the Ed25519 precompile right before `decide`. A side is taken only once entries close (`EntriesOpen`); a
  call-off any time.
- **Payout**: `decide` takes the shares; winners split the rest by stake, the last claim taking the remainder. A loser
  of a contest of tokens sends nothing. The one chosen share pays the `recipient` `decide` names.
- **A prize per winning entry** (`prize`), given with its first claim (a roll at the claim's `nonce`); the player may
  `forgo` it.
- **A prize split by stake** (`prize_split`, tokens only): its vault `["prize", contest]` opens with the contest;
  `decide` sets the whole prize aside or is refused (`PrizeNotCovered`); each winner takes its share by stake. A hooked
  prize mint's leftover is burned at the close, not moved back (no hook accounts for it). From a
  pool, a claim that may close the contest (and a `decide` that calls off one nobody entered) names that pool
  (`prize_pool`), where what the vault still holds goes back (`WrongPool` without it; `claimIx` and `decideIx` pass it).
- **A contest of NFTs** (`nft`, a rule): each entry stakes one NFT (not compressed); sides count NFTs and the NFTs are
  the pot. At the decision each winner's share of the losers' NFTs is fixed, `min(cap, losers ÷ winners)`, the first
  winners to enter taking one more when they don't divide evenly. A claim names the entries whose NFTs it moves by
  their place in the list: its own back (anyone sends it), losers' picked by the winner (`WinnerPicks`), and once no
  winner has picks left, what they left to the opener (anyone). `end` leaves the rest of a winner's share to the
  opener; `give_up` turns an NFT that can't move into a hold for whoever it goes to.
- **Off**: `decide(None)` calls it off; a contest past `result_by` undecided is off by the clock (`contestOff`), and
  every entry takes its own back. `decide(None)` closes the contest only when nobody entered; else the last claim does,
  naming the treasury (`claimIx` takes `projectState`).
- The claim that leaves nothing owed closes the contest, its list (its bytes to the treasury) and its pot and prize
  vault, burning what is left (wrapped SOL to the opener); an account the issuer froze, or a burn authority blocks, is
  left behind and that id can't open again. Mints can't be confidential or start frozen (`BadContest`).

## Auctions

At `["auction", project, seller, id]`, so an id is its seller's own; the seller is its only signer.

- **Lots** (`Lot`): `Item(id)` (a new unit, its serial reserved at open; project keys only); `Roll(box_id)` (a mystery
  lot made into the winner's roll at the end; project keys only, a box already written, `LotRefused`); `Asset(address)`
  (an NFT handed to the project until the end; a player's must be a Core NFT of one of the project's collections, the
  project's keys may put up any).
- **Bids** sign `terms` (`auctionTerms`: sha256 of the mint and Borsh `AuctionArgs`). At least the reserve and 1, and
  above the high bid by `min_raise_bps` rounded up (at least 1), counted on what arrived. The topped bid goes back in
  the same instruction; there is no record per bidder. A bid in the last `extend` seconds pushes the end to `extend`
  after it. `ends_at` within 5 years, `extend` at most that (`BadAuction`).
- **Bids of NFTs** (`nft_bids`, a rule): 1 to 3 NFTs a bid (`MAX_BID_NFTS`, not in the IDL: more is `BidTooLow`, and a
  high bid of 3 can't be topped), not compressed (`CompressedBid`); reserve (1 to 3, `BadAuction`) and raise count NFTs; the topped bundle goes back at once. The record grows 32 bytes per
  NFT of the high bid at the bidder's cost (162,560 lamports each), which goes to the seller at the end. No shares.
- **The end**: anyone, once it is over. Shares take their parts, the rest to the lot's owner (the seller, or the
  treasury for an item or roll), the lot to the winner. With no bid the lot goes home (an item's serial is voided). The
  seller may call off one with no bid; once a bid is in it runs to its end, with no deadline to be ended.
- Mints can't start frozen, be switchable to frozen, or be confidential (`BadAuction`).

## Offers and loans

Any wallet opens one at `["offer", project, maker, id]`, alone: a rule, a deal, how many NFTs (`left`), and for a bid
its shares. All its money goes into the project's vault at open and must arrive whole (`BadOffer`). It is never
edited; every take signs `terms` (`offerTerms`). The rule is read as the NFT comes in. The last take closes it.

- **Bid** (`Buy { price }`): `sell_to_offer` sends the NFT straight to the maker and the price through the shares to
  the seller.
- **Loan** (`Lend { amount, repay, lasts }`, no shares): `borrow` puts the NFT in a hold at `["hold", asset, due]` with a
  debt, `due` the borrower's (at most `lasts` away), and pays `amount`. Before `due` anyone may `repay` (money only);
  then anyone `release`s the NFT home. From `due` it can't be repaid (`LoanDue`) and anyone releases it to the lender
  (`OwedToLender`). No grace, extension, partial repayment or liquidation; the authority has no say.
- Mints can't start frozen, be switchable to it, or be confidential (`BadOffer`). A mint's issuer (freeze, pause, hook,
  permanent delegate) can still block a repayment and let the lender take the NFT: the borrower checks the mint (the
  client warns).
- An offer trusts its rule's collection. Switches refuse `open_offer`, `sell_to_offer`, `borrow`; never `close_offer`,
  `repay` or a default's release.

## Listings

Any wallet lists an NFT of any kind at `["listing", project, asset]`, alone; the project holds it meanwhile, so an NFT
is in one listing of a project at most, and a game finds its renter with one read (`renterOf`; `user` and `until` sit
at offsets 129 and 161). It names a mint, a deal and its shares (no `Chosen`), is never edited, and every take
signs `terms` (`listingTerms`).

- **Sale** (`Sell { price }`): `take_listing` pays from the taker through the shares to the maker and hands the NFT
  over; the listing closes.
- **Rental** (`Rent { price, lasts, max_periods }`): the taker pays for 1 to `max_periods` periods and is the `user`
  until `until`; the NFT stays with the project. Nobody ends it early (`Rented`). `close_listing` during a rental only
  stops new renters (`ListingStopped`); after `until` it sends the NFT home.
- Rules don't read rentals: a rented NFT passes no gate and boosts nothing as its renter's; a game reads `user`.
- A price above 0, a rental's longest within 5 years (`BadListing`). A payee's account that can't take its part is
  passed over to the maker; the maker's own failing fails the take.

## Making collectibles

`collectible` `Make { item, tree, attributes }` mints one of an item to each owner the instruction names, in serial
order, at `["asset", item, serial]` (`makeIx`, `madeAssets`), or with `tree` a compressed NFT into that tree of the
project's; a sold-out item refuses the whole call (`PrizeNotCovered`), a switched-off one still makes. `Set` rewrites
attributes but never `item_id`, `rarity` or `serial`, and keeps `made`, `used`, `used_at` unless named; on an NFT the
project has no authority over it writes the Sheet. `Burn` burns a burnable one the project doesn't hold, naming its
holder, who gets its rent. `Profile` writes a wallet's profile (below).

## Profiles

What the project writes about a wallet lives in its **profile**, `["profile", project, wallet]` (`{ project, wallet,
attributes }`, sized to fit, `pda.profile`): a player's XP, level, rank, a jail time. It belongs to the wallet, so it
can't be sold or lent. Three things write it: the authority (`collectible` `Profile`), for what only the game knows; a
farm's growth (`Growth { profile: true, at_least }`), for time staked; and a recipe the player crafts (a need or a
raise at `PROFILE_PLACE`), a level bought. Nothing else does, the player included. Every write leaves
`ProfileWritten`; whoever writes pays what it adds. It never closes: a missing number reads as 0 and a missing time as
long past. Its seed and discriminator are its own, never a Sheet's (`WrongProfile`).

- **Read by rules** (`Of::Profile`): a gate on every route that takes one, a farm's gates and boosts (from the seat's
  player's profile, beside the NFT's), a box's odds. A box's gate and odds read all an NFT or all the profile
  (`BadRule`); a rule that says which NFT something takes never reads a profile.
- **Farms**: a farm that uses profiles takes the seat's player's on `stake_tokens`, `stake_nft`, `unstake_nft`,
  `unstake_tokens` and `refresh_seat`. A seat's boost is its NFT's and its profile's together; a token seat with no
  booster has its profile's. Growth on the profile adds up across a player's seats; a token seat grows it only while it
  stakes `at_least`, and a top-up, a tier change or a booster put on needs the seat refreshed first in the same
  transaction (`RefreshFirst`). No streak on a profile (`BadFarm`).

## Rules, gates, odds and boosts

A **rule** (`{ of, key, test }`) asks for an NFT the player holds: `Of::Collection(address)`, or `Of::Item(id)` (by the
`item_id` only loot writes), or reads the player's own profile (`Of::Profile`, passed where the NFT would be), and
tests its attribute under `key`:

| `Test` | Passes when the value |
| --- | --- |
| `Any` | — always |
| `AtLeast(n)` / `AtMost(n)` | is at least / at most n |
| `Equals(text)` | equals the text |
| `Ahead` | is a time (Unix seconds, 64 bits) still to come: fuel left |
| `Passed` | is a time past, or missing: out of jail |
| `Within(s)` | is a time less than s seconds ago and not ahead; missing is long ago |

A missing number, or text, reads as 0. What is written on an NFT counts as it is: that is its collection's business.

**Showing an NFT** (`shownAccounts`): a Core asset of the project's collections alone; another Core asset, then its
Sheet's address; a Token Metadata NFT as mint, metadata, the holder's token account and Sheet address; a compressed NFT
as asset id, its `Proven` record, tree and Sheet address. For an NFT the project has no authority over, the Sheet is
read over its own attributes, and one shown without its Sheet passes nothing.

**Gates** guard boxes, lotteries, grants, contests, auctions and farms:

| `Gate` | Passes |
| --- | --- |
| `Holds(rule)` | an NFT shown passes the rule |
| `Wallets(list)` | the wallet is one of the list |
| `List { root, depth }` | a Merkle proof of `sha256("loot-list-v1" \| wallet)` (`gateListLeaf`, `gateList`): pairs hashed smaller first, an odd last node sent up, exactly `depth` nodes, each an account of the transaction |
| `Staked { farm, at_least }` | the wallet's token seat in `farm` holds at least `at_least` (above 0), staked before this second, its tier's lock running (a tier with no lock or with an early exit never passes). What counts is what it held when its lock last started (`Seat.locked`), so one stake counts for one wallet a lock |

A farm's gates are rules one NFT (or the player's profile) must all pass. A grant's gate reads the receiving wallet. A
box's gate changes with an edit, a lottery's between rounds, others never.

**Odds** (a box, `Odds { entry, boost }`) and **boosts** (a farm, `Boost { rule, effect }`, within
`max_boost_bps`): `Effect::Flat(bps)` or `Effect::PerPoint { bps, most }`, in basis points of the weight, up to +10,000%
(×101). Odds read at `open_box` are fixed in the order; one that doesn't check out raises nothing and never stops the
roll.

## Farms

```
weight = staked × tier.bps / 10,000 × (10,000 + boost) / 10,000
staked = tokens, or NFT_UNIT (1,000,000) for one NFT
```

`FarmArgs { custody, rewards_pool, tiers, boosts, max_boost_bps, gates, rate, growth, ends_at, lock_key, upkeep_key,
exit_to, unbond, toll }`. A farm takes a token (`staked_mint`) or NFTs of any kind its gates name. It is never edited
and never closes; a new mission is a new id. Give it a rewards pool of its own: it releases all the pool holds.

**Tiers** (1 to 256, a byte names one; `{ lock, bps, prize, roll, exit_bps }`): a lock in seconds and a multiplier
above ×0 up to ×11 (a seat's weight stays inside 128 bits). A
token seat moves only to a tier that locks as long or longer; every stake and every booster put on restarts the lock.

**Custody** (NFT farms):

| `Custody` | The NFT |
| --- | --- |
| `Escrow` | handed to the project (Core transfer, Token Metadata `TransferV1`, Bubblegum `TransferV2`); soulbound refused (`SoulboundEscrow`). The default in economy specs |
| `Freeze` | stays in the wallet, locked with the project as the only lock holder (Core freeze; legacy approve and freeze; pNFT `StakingV1` delegate and lock; compressed delegate and freeze). Needed for soulbound NFTs. A lock that isn't the project's, or is off, reads as the NFT gone |
| `Watch` | stays free and can be sold; earns only while its staker holds it. Whoever finds it gone (a refresh, harvest or unstake showing where it is) returns what the seat was owed to the farm, and its next holder takes the seat over (`stake_nft` with `previous`, repaying the seat's rent). Not for token farms. Handing it to the project (a hold, listing, loan) counts as not holding it |

A frozen or held NFT is in one farm at a time; a soulbound or watched one can sit in several (`AlreadyStaked` for the
same farm twice). What a farm grows on a Token Metadata or compressed NFT is in its Sheet (`WrongSheet` when left out).
`stake_nft` puts an NFT on its own seat, or on a token seat as its **booster** (one at a time). Boosts are read on
staking and by `refresh_seat`, which also drops a seat's weight if its NFT left or no longer passes; nothing refreshes
by itself.

**Sharing rewards** (no rate): what lands in the rewards pool is released over the farm's span (its longest lock, a day
at least), along a straight line, and credited by weight as released. New funding is counted at the next move and
moves the line's end by its share. So no seat is credited at once what landed before it (a stake and harvest in one
transaction take nothing). The clock pauses while nobody weighs anything. The authority can still pay out of the pool;
the farm then releases only what is left. Rounding fractions are kept, so frequent refreshes lose nothing. Send
`refresh_seat` after a deposit.

**A fixed rate** (`Rate { per_day, mints }`): `per_day` base units for each `NFT_UNIT` of weight, by the second.
Minted (the project the mint authority) as far as the supply has room, or paid from the pool as far as it holds; what
can't be covered isn't owed later. A rate of 0 pays nothing (a farm for growth or prizes only).

**Given back** (a forfeit, an early exit's waiting rewards, a watched NFT gone, a lapsed upkeep): returned to the pool
at the end of the move (released again before the end), or burned by a rate that mints; never credited at once to the
seats there.

**Growth** (any number of `{ key, per_day, level, steps, streak, profile, at_least }`): an NFT on a seat earns
`per_day` points a day times its tier and boost under `key`, and the level reached (of its rising `steps`) under
`level`; with no steps the points are the level. Written by `refresh_seat` and on the way out, on the NFT where the
project may write, otherwise its Sheet, or with `profile` on the seat's player's profile, at the signer's cost. Points
add to what is there (two farms on one key add up); a level never drops, except with `streak`, which resets points and
level when the NFT leaves.

**An end** (`ends_at`): no new seat at or after it, nor one whose lock runs past it (`FarmOver`); rate, growth and
release stop. What isn't released by then stays in the pool. Fund a farm a span ahead of its end.

**The lock on the NFT** (`lock_key`, NFT farms): staking writes the lock's end under that key (never sooner than one
already there); the NFT leaves once that time comes. A recipe that lowers it is a paid early exit; a roll that raises
it is jail; two farms on one key share a lock. A watched NFT that can't be read on the way out is treated as gone: the
seat closes on its tier's own lock, giving up rewards, prize and roll.

**An upkeep** (`upkeep_key`, NFT farms): a time until which the NFT earns (fuel), bought with a recipe raise
`from_now`. Read at stake and refresh, so send `refresh_seat` with the refuel. Once it passes, the seat keeps what was
credited until then, gives back the rest and weighs nothing until refuelled. A lapse before the tier's lock ends marks
the seat `dry` for that stay: no mission prize.

**Missions** (`Tier.prize`, NFT farms): an NFT leaving its own seat after its tier's lock, never dry, takes the prize:
tokens (a fixed amount grown by its boosts), a collectible, a stash NFT, or a chest (its order at the unstake's `nonce`
plus 1). `forfeit` gives it up; one that can't be given is passed over. A prize on a tier with no lock is given on
every unstake.

**Leaving a token farm early or slowly.** Fees go to a `Sink`: burned (not wrapped SOL) or a pool in that mint.

- **Early exit** (`Tier.exit_bps`, `exit_to`): leave before the lock by leaving that share, rounded up; 0 can't
  (`StillLocked`). On such a tier rewards wait for the lock (`RewardsLocked`) and an early exit gives them back. A seat
  can't move to a larger exit fee while locked (`ExitWhileLocked`), and claimable rewards must be harvested before a
  move that would make them wait (`HarvestFirst`; the client harvests in the same transaction).
- **Unbonding** (`unbond`, seconds): what is taken out waits in `leaving`, weightless, until `leaving_at`; any later
  `unstake_tokens` sends it (`Withdrawn`). A second unbond adds and restarts the wait.
- **Compound** (`harvest` with `compound`, rewards in the staked token, else `NotCompoundable`): rewards less the toll
  join the stake without restarting the lock. Refused while paused or suspended.
- **Toll** (`{ bps, to }`): a share of every reward payout, rounded up; not a mission prize, not with `forfeit`.

Stakes and rewards stay in separate vaults even in one mint. Pause and suspend never block unstake, early exit,
withdrawal or harvest; `forfeit` skips rewards that would block a withdrawal. Farm builders take `extra` remaining
accounts for hooks and Core escrow adapters (`transfers` for dynamic hooks).

## An NFT as the price

Every route that takes money can take an NFT instead. Where it goes is a `Spend`: `Burn`, `Give(wallet)` or
`Stash(id)`; an `NftPrice` is a rule and a `Spend`. A burned or given NFT moves straight from its holder; a stashed one
is handed to the project, the stash growing 36 bytes (its row: weight 1 and the NFT) at the holder's cost.

| Route | NFT price |
| --- | --- |
| `pay_nft` | any NFT, burned or given to a wallet; the `PaidNft` receipt is the record. A semi-fungible Token Metadata unit passes here, so an app admitting on `PaidNft` checks the mint's supply. Never into a stash |
| a box | the NFT it rolls on (`subject`); each fate says where it goes; home on refund |
| a recipe | `Input::Trade { collection, then }` |
| a lottery | `nft_ticket`: one NFT a ticket, held until the draw |
| a contest | `nft`: one NFT an entry; winners take the losers' |
| an auction | `nft_bids`: NFTs a bid, not compressed |

## Every kind of NFT

Every route that takes an NFT takes its accounts as a `Piece` and moves it the same few ways whatever its kind: read
it, lock it in its wallet, hand it to the project and on, or pass it straight on from its holder. The client's `piece`
builder makes one for any kind with only the accounts a route uses; collections, trees and leaf records are writable
only where a call writes them, so a hold never write-locks a collection or tree.

| Kind | The `Piece` | Lock | Hand to the project |
| --- | --- | --- | --- |
| Core | the asset, its collection (left out for none), Core, its Sheet when the project has no authority | a freeze delegate | Core `TransferV1` |
| Token Metadata (legacy, pNFT) | mint, `metadata`, `edition`, the wallet's `token` and `token_record`, the project's `project_token` and `project_record`, `rule_set`, `rules_program`, Token Metadata, the instructions sysvar, SPL Token, the ATA program, its Sheet | legacy `Approve` + `FreezeDelegatedAccount`; pNFT `Delegate` (StakingV1) + `Lock` | `TransferV1` under its rule set |
| Compressed (Bubblegum v2) | asset id, its Core collection, its `leaf` record, `tree`, `tree_config`, the leaf's delegate if any, Bubblegum, mpl-account-compression, mpl-noop, its Sheet; the proof's nodes first among the remaining accounts | `DelegateAndFreezeV2` | `TransferV2` |

- **Only an NFT goes into the project's hands**: a Token Metadata mint must be one token that can never be minted again
  (`NotAnNft`). The project's token account of it closes only when empty, so a token sent beside it never blocks it.
- **Token Metadata receivers**: it goes out to the token account the sender passes as the receiver's (any account of
  the mint the receiver owns). If the receiver's associated account belongs to another key or is frozen, the sender
  makes a fresh one (`freshNftAccount`, a pNFT's token record then the record of that account; the client does, in
  js/play's every hand-out: an outbid bidder's NFTs handed back, an auction's end, a listing, a settle, a release and
  the rest, through `nftOf(asset, signer, { to })`).
- **pNFT token records**: the rent goes to whoever pays the move out; on a listing's sale the maker doesn't get the
  record's rent back (about 0.00145 SOL).
- Compressed NFTs of v1 trees are refused.

**A compressed NFT is proven first.** Its leaf comes from an indexer (DAS `getAsset`, `getAssetProof`;
`compressedFromDas`). `prove_leaf` checks it against a tree whose authority is Bubblegum's own `TreeConfig`, at the
current root or one still in the tree's change log with no change since at that leaf (`StaleProof` otherwise), and
records owner, delegate, collection, hashes, flags and root at `["leaf", asset]`. An empty leaf at or past the tree's
`num_minted` is no NFT (`NotTheNft`). Routes read the record only while its
leaf is unchanged and its root is still in the log (`NotProven` otherwise, never read as the NFT gone). Other leaves
moving never spoil it, so two compressed NFTs of one tree move in one instruction. Anyone may re-prove at an older
root, so **prove in the same transaction as the move** (v0 with a lookup table if needed; the client does). A data
hash of all zeros means burned. A wrong proof on a route fails inside Bubblegum, using the whole compute budget: a poor
error, never a wrong move.

**What a rule reads.** A Core NFT's own attributes, and for an NFT the project has no authority over, its Sheet. A
route **between players** (an offer's bid or loan, an auction's NFT bid) reads an outside NFT **without** its Sheet: a
Core NFT by its own attributes, others with none, so only `Any` passes on a key the NFT doesn't carry, and the project
can't make a cheap NFT pass a stranger's offer by writing its Sheet.

## Sheets and off-chain traits

The project writes attributes on an NFT only where it has authority: its collections' NFTs, and a Core NFT whose
Attributes plugin names the project. For any other NFT it writes in its **Sheet** `["sheet", project, nft]`
(`{ project, nft, attributes }`, `decodeSheet`): the authority with `collectible` `Set`, a farm's growth, anyone's
`prove_traits`; the sender pays the growth. It stays with the NFT, never closes, and never says who holds it. Rules,
odds and boosts read it over the NFT's own attributes; a seat refresh without it is refused (`WrongSheet`).

**Off-chain traits**: `set_traits(key, root)` writes the root of a Merkle tree of `(nft, attributes)` at
`["traits", project, key]` (`key` a collection's address by convention; a new root replaces the last). Anyone proves
an NFT's traits into its Sheet with `prove_traits`. Leaf `sha256(0x00 | nft | Borsh(attributes))`, node
`sha256(0x01 | min(a, b) | max(a, b))`, odd last node sent up (`traitsTree`). A proof writes only keys the Sheet lacks,
never empty values, never a key a Core NFT carries itself. To retire a trait, set a new root or write over it.

## Grants

`GrantArgs { gives, vouchers, list_root, key_root, open, limits, active, gate, shard_bits }`. A grant gives its `Prize` to a wallet
that a **voucher key** signs for (up to 3 in `vouchers`, or any number under `key_root`, proven with a Merkle proof of
`sha256("loot-key-v1" | key)` and limited by `per_key`: a promo code), that is on
the **list** (`list_root`), or that comes to an **open** grant. A claim with no voucher goes by the list when there is
one, otherwise only an open grant takes it; with none of these the grant pays nobody. An open grant gated on a
collectible counts the collectible too (a badge), so moving it claims nothing more.

**Every claim is signed by its wallet** (`WalletMustSign`): only the winner chooses when it lands. A results server
hands out the voucher; the winner's page sends the claim. So a grant pays only wallets that can sign (a person, or a
program that signs by CPI such as a Squads vault), not an exchange deposit address.

**Limits** (`{ wallet, per_person, per_key, per_day, total, window }`): per wallet in all and per window, per person,
per key, per UTC day, in all, and a time window (`OverWallet`, `OverWindow`, `OverPerson`, `OverKey`, `OverDay`,
`OverTotal`). Each limit record (28 bytes) is keyed `sha256(kind | subject)[..16]` (`limitKey`: a wallet, a person, a
badge, a key) in the grant's claims, `["claims", grant, incarnation, shard]`; one claim touches at most four shards.

**Rounds.** A claim names its rounds (a voucher or a list proof each); each pays a wallet once per incarnation, its
record `sha256(round | wallet)[..16]` (`roundKey`, 16 bytes) in the wallet's shard of the grant's rounds, `["rounds",
grant, incarnation, shard]`: replays, re-signs, other keys and clocks set back are all refused, a round named twice is
paid once, and the same voucher sent again later pays the rounds a full limit held back. A grant's records are in
`2^shard_bits` shards (0 to 8, fixed for its incarnation, `ShardsFixed`): a record's shard is its key's top bits
(`shardOf`), the fewest that keep each under ~100,000 records (`shardBitsFor`). Once the grant is closed or made again,
anyone closes its shards (`close_shard`), their rent to the owner. A claim may need 400,000 compute units
(`CLAIM_COMPUTE_UNITS`).

**A claim's own amount**: a voucher or list leaf may name `amount` for a prize of `Tokens { amount: Fixed(most) }`: at
most `most` (rewards by rank). 0 gives the prize as written. Anything else nonzero is refused (`OverPrize`).

**Funds**: the SOL a grant holds beyond its rent; anyone adds with a plain transfer. They pay its records and what a
prize opens or makes, lent to the claim's `signer`, who covers any shortfall. The signer pays the player fee and a
roll's order from its own SOL, never the funds. Closing returns the rest to the owner. A prize that can't be given
refuses the claim, keeping its rounds.

**The voucher** (45 bytes, Ed25519, checked by the precompile right before `claim_grant`, or before the instruction
that calls loot): `"loot-grant-v5" | sha256(program id | grant | incarnation (u64 LE) | wallet | person_hash (32) |
expires (i64 LE) | count (u32 LE) | (round (16) | amount (u64 LE)) × count)` (`voucherBytes`, `voucherBody`,
`readVoucher`), so a voucher of many rounds is as short to check as one of one. Use a different voucher key on each
cluster: the bytes don't name the cluster. `js/test/client.test.mjs` holds a vector.

**The list**: leaf `sha256("loot-list-v3" | wallet | person_hash | round (16) | amount (u64 LE))` (`listLeaf`), node
`sha256(min(a, b) | max(a, b))`, odd last node sent up, leaves in the order given (`merkleRoot`, `merkleProof`).
Leaves don't name the program. Vector: wallets 32 × `0x33`, `0x34`, `0x35`, person, round and amount zero: root
`7e7139369d9451ae178d9bdcb87322669db7533a0482e197fbcffc96c5b357cf`; proof of `0x34`:
`34e6a712750308f305caefb024224476bc30acf6c7587f9bb1870b1101ce806d`,
`3628454bf3ef6e1031831ffec880b7c2a2bb7aef6c452e80ee08f019b2fb7d44`.

A key's proof is instruction data a lookup table can't shrink, so a key root holds at most 2^16 keys when the wallet
pays its own claim, 2^13 when another signer pays.

## Counts

A wallet's counts are one list, `["counts", project, wallet]` (`decodeList`, `readLimit`, `countKey`): a 28-byte limit
record for each box, recipe or lottery that limits it, keyed `sha256(record | incarnation)[..16]` (a box's and a
recipe's incarnation is 0): `count` in all, the window it counts in and `in_window`. Boxes, recipes and grants use
`PerWallet { total, per_window, window }` (`window` in seconds from the Unix epoch, 86,400 a UTC day; 0 off; a
`per_window` with no `window` is a limit in all); lotteries `per_wallet` tickets a round (its window the round). The
list is an optional account; past a limit the instruction is refused (`countAllows` says so first). The one counted
pays its record's bytes once and it is kept for good, so an edit can't reset limits. A refunded order gives its count
back. `Window { opens_at, closes_at }` bounds boxes, recipes and grants (`NotOpenYet`, `WindowClosed`).

## Receipts and errors

Receipts are Anchor events in the log (`receipts` in `js/client/accounts.js`): no rent, the public record of the
economy. `reference` is the project's own label, never read.

**Delivering from a receipt**: only from a **finalized** transaction whose `meta.err` is null, once per order or
reference. A transaction can fail after every instruction logged success (at the runtime's rent check at its end) and
still carry the receipts. If a log is truncated, read the transaction again.

| Receipt | When |
| --- | --- |
| `Paid`, `PaidNft` | `pay`, `pay_nft` |
| `Bought`, then `PrizeGiven` per prize | `buy` |
| `OrderRolled` (`entries`, `won`, `burns`), `OddsRaised`, `OrderFailed`, `OrderPartSettled` (`from`, `upto`: a settle part's prizes), `OrderSettled` (`from`, `won`: the last part; a collectible minted is at `["asset", item, serial]`, a compressed one's id is the tree's count), `OrderRefunded` | an order's life |
| `RollMade` | a mission's, recipe's or prize's waiting roll |
| `Stashed` (`weight`), `Moved`, `Changed`, `ProfileWritten`, `Held`, `Released` | `stash`, `move_tokens`, `collectible`, a profile written, holds |
| `Listed`, `ListingSold`, `ListingRented`, `Unlisted` | listings |
| `OfferOpened`, `OfferClosed`, `SoldToOffer`, `Borrowed`, `Repaid` | offers and loans |
| `Entered`, `Decided` (`side: None` when off), `Claimed` | contests |
| `AuctionOpened`, `BidPlaced` (`ends_at` after extension), `BidRefunded`, `AuctionEnded` (`winner: None` unsold, `remainder`) | auctions |
| `ScheduleRan` (`from`, `run`: a range of runs), `TicketsBought` (`entry`), `LotteryDrawn`, `LotteryCancelled` (`short`), `LotteryPulled` (`entry`, `buyer`: the winner of a `Pot` or `Prize` part, its run in `part`; `amount`: tokens settled, 0 for an NFT), `RoundClosed`, `Crafted`, `Rolled` | mechanics |
| `Seated`, `Unseated` (`fee`, `leaving`, `toll`), `Harvested` (`toll`, `compounded`), `Withdrawn`, `Reweighed`, `Grown` | farms |
| `PrizeGiven` (`winner`, `prize`, `asset`, `serial`, `amount`, `order`) | every prize given at once |
| `TraitsSet`, `TraitsProven`, `GrantClaimed`, `RecordWritten`, `RecordClosed`, `TreeOpened` | traits, grants, `upsert`, `open_tree` |
| `FeeChanged`, `ProjectSuspended` | the platform |

**Errors**: `AnchorError occurred. Error Code: <name>. Error Number: <n>. Error Message: <text>.` (or `AnchorError
caused by account: <account>. …`). The IDL lists all of them; `lootError` and `ERRORS` name them.

## Limits

Since 0.22 the program caps no count and no size of its own: no most entries, prizes, odds or draws in a box, shares
in a split, lottery places, farm boosts, gates or growths, level steps, recipe lines, gate wallets, list depth,
contest deciders, NFTs a bid, collections a project, grant rounds a wallet, or bytes in a name, key, text or URI. What
a record holds is bounded by the chain: the transaction that writes or uses it, the heap, an account's 10 MiB, the
oracle's callback, and Metaplex Core's and Bubblegum's names and URIs. A client sends what doesn't fit one transaction
as several (a settle in parts, a table's rows in batches); `xsolana_check` refuses or warns where the chain would.

| What bounds it | Value |
| --- | --- |
| A transaction | 1,232 bytes legacy; 64 accounts (with a lookup table); a 64-call instruction trace; 1.4 million compute units |
| The heap | 32 KiB, 256 KiB when a transaction asks (`RequestHeapFrame`) |
| An account | 10 MiB: a table of some 250,000 labels or 1.3 million numbers, a stash of some 290,000 NFTs |
| A roll's oracle callback | 21 accounts (a box's items, pools, stashes, mints and vaults, and a fresh item's tables) and about 300,000 compute units |
| A compressed NFT (Bubblegum) | a 32-byte name, a 200-byte URI with its values written in |
| A table's label | 32 bytes |
| Farm tiers / collectibles a craft | 256 / 255 (a byte names each) |
| Named voucher keys / under a key root | 3 / 2^16 (2^13 when another signer pays: a key's proof is instruction data) |
| Tier multiplier / boost | up to ×11 / +10,000% (a seat's weight stays inside 128 bits) |
| Each flat fee | 0.01 SOL; a raise waits 7 days |
| Contest result, auction end and extend, lottery draw, rental | 5 years |
| Sealed schedule | 10,000 runs, ending within 10 years |
| Stale roll or draw | 1,500 slots (about 10 minutes) |
| Lottery cancel | 1,512,000 slots (7 days) after the first ask |
| `Chosen` shares in a split / NFTs a ticket / a contest entry | 1 / 1 / 1 |
| A fate's shift | `by` and `most` 32 bits; NFT numbers 64 bits |

Measured on 0.22 (the program's `tests/limits.rs`, `fresh.rs`, `compressed_packs.rs`, `committed.rs`): a card costs
the oracle's callback 2,600 to 3,700 compute units at 2 to 16 entries, so one answer draws about 66 to 106 cards; a
stash's draw about 25,000 at ten NFTs and 33,000 at 290,000; a table's about 49,000 at a million rows. One settle
transaction mints about 14 Core cards (the trace binds first), 10 compressed or 8 fresh compressed; a committed table's
row proven at a million rows is 692 bytes, one such card a part. A purchase is about 80,000 compute units and 5 calls.

## Known limits

Kept by design; each is bounded, and no stranger profits from it.

**Boxes and rolls**

- **A pool's last prize.** Each order is covered alone when it opens; once a roll leaves a pool short of a fixed
  entry, that entry leaves the table, so waiting orders land on others (a rare one, certainly, once the common one is
  gone) or fail and refund. Anything that drains the pool between ask and answer does the same.
- **Dust on a dry pool's share**: a few base units sent into an empty pool put its share entry back in the table, so a
  waiting roll can land on it for the dust. Give a jackpot as a fixed amount, or keep its pool funded.
- **A pool opened mid-roll** can be landed on with nothing to move. Open a box's pools before it sells.
- **One pool or item twice in an entry** pays the second short. Give an entry one prize per pool and item.
- **A mission's chest at a fixed address**: a tier that rolls on the NFT and gives a chest puts the chest at a nonce
  from the NFT; an unsettled earlier chest (or a stranger's roll at that nonce) blocks later exits with the prize. The
  player can harvest and `forfeit`, losing that chest.
- **A refund before a late roll**: past 1,500 slots a buyer who sees the oracle's late answer in flight can refund
  instead.
- **A refund keeps the price rise**; **a rolled box can't pay a hooked mint**.
- **Named stash NFTs are found by reading the table** (about 52 compute units per NFT ahead, measured on 0.20): keep
  stashes that prizes name under about 1,000 NFTs; draws by weight cost about the same at any size.
- **Settles at the account limit**: a box whose settle passes 64 accounts can't settle (a payee turning on required
  memos can tip one over); the player settles by putting won NFTs back. `xsolana_check` warns (`W-BOX-ACCOUNTS`).
- **Large settles need a bigger heap**: several NFT moves, holder shares and a hooked coin can outgrow the default
  32 KiB; a 256 KiB heap frame (`RequestHeapFrame`, `settleHeapFrame`) lands it for anyone. `xsolana_check` warns
  (`W-BOX-HEAP`).

**Lotteries**

- A place's token prize in a mint that starts frozen (or can): a winner with no thawed account holds the round until
  the issuer thaws it or the authority empties the pool.
- An NFT ticket or raffled NFT whose collection refuses to move holds the round, money and all.
- If the oracle refuses every request, an open round with tickets can't be drawn or cancelled; rounds that need no
  oracle still end.

**Farms**

- Dead weight (a sold watched NFT, a lapsed upkeep) found near or after the end leaves its rewards in the pool, the
  project's. Refresh suspect seats a span before the end.
- Dust in the last span pushes the release's end past the farm's, keeping a little in the pool.
- A fee mint's rounding loses up to a unit per forced move (watched NFTs moved back and forth, a rate paid from a pool):
  use enough decimals, or no fee.
- A last forfeit after the end, in a mint that can refuse the give-back, leaves that amount in the vault for good.
- A paid refuel during a suspension (see [the switches](#the-switches)).
- A Freeze farm's compressed mission exit whose box holds the NFT needs its subtree unchanged between proof and landing;
  a compressed exit with a compressed prize needs 68 accounts and can't land (harvest, then `forfeit`).

**NFTs**

- A Core NFT whose Attributes plugin someone else manages can't be written by loot: choose collections the project
  writes.
- An NFT a collection's permanent delegate moved out and that came back by another route reads as the record's that
  held it.
- Small rents follow whoever sends or closes: an emptied Token Metadata prize account to the sender, a loser's in a
  contest of NFTs to the winner, an NFT auction's growth to the seller.

**Not built**: rules reading rentals; a cut of loan interest; offers paid from a pool; one random winner among a
contest's side; a cache of a committed table's top levels on chain (so proofs carry fewer nodes); lots other than an item, a roll or an NFT;
SOL in lamports (use wrapped SOL); list gates on farms; minting Token Metadata NFTs; conditions on chain balances;
sealed-bid or second-price auctions; v1 compressed trees; forced sales; bonding curves; decaying stakes; exit fees or
unbonding on NFT farms; receipt tokens for stakes; slashing; per-tier gates; boosts from several NFTs; taking anything
from a wallet without its signature.

## Transaction sizes

A legacy transaction carries at most 1,232 bytes and 64 accounts. Measured on 0.20 with a compute budget's limit and
price (box and recipe shapes then at 0.20's largest; 0.22 takes larger ones, which the senders size the same way):

| Transaction | Legacy | v0, one lookup table |
| --- | ---: | ---: |
| `open_box`, the largest box a roll carries (5 item entries, 3 token entries from 3 pools in 3 mints, 21 callback accounts, 4 holder shares) | 1,233 (one over) | 370 |
| `buy`, the largest bundle (3 collectibles, 4 holder shares) | 1,089 | 350 |
| `settle` of that bundle when rolled | 1,090 | 351 |
| `decide` with a split prize (a verdict, 4 holder shares, a pool, a hooked mint) | 1,483 | 620 |
| a compressed stake with a 4-node proof | 1,166 | — |
| `craft`: 8 burned for 1 new / 4 burned and 4 used for 2 new and tokens | 966 / 1,172 | — |

xsolana's senders (`js/play`, the keeper) send anything too big as v0 with a lookup table the payer makes first, then
deactivate and close it, getting its rent back. A project can instead keep one table of its fixed accounts (a 56-byte
header and 32 bytes an address: about 0.00093 SOL plus 0.00016 SOL an address). A compressed proof longer than 4 nodes
needs a table.

## Costs

**Rent** is `(bytes + 128) × 5,080` lamports on devnet and mainnet; query `getMinimumBalanceForRentExemption` for the
real allocation. Rent is separate from token amounts, loot's fees, the oracle's fee and network fees.

| Account | Bytes | Rent, lamports | Back |
| --- | ---: | ---: | --- |
| Platform | 73 | 1,021,080 | never |
| Project, no collection / one | 153 / 185 | 1,427,480 / 1,590,040 | never (+162,560 a collection) |
| Order, a box of one draw and two entries | 373 | 2,545,080 | player, at settle or refund; up to 41 bytes more a prize its draws can set aside (`orderBytes`) |
| Stash, one NFT / four | 103 / 211 | 1,173,480 / 1,722,120 | +182,880 an NFT (36 bytes); to whoever takes NFTs out by hand |
| Table: header / a row of numbers / a row of labels | 51 / 8 / 40 | 909,320 / +40,640 / +203,200 | never (the owner, as it writes rows) |
| Committed table, sealed | 83 | 1,072,120 | never, whatever its rows (its root only, once sealed) |
| Profile, `xp` and `level` | 98 | 1,148,080 | never; 69 bytes empty, an attribute 8 bytes plus key and value |
| Seat | 232 | 1,828,800 | player, last exit |
| Hold (a loan's 243) | 170 | 1,513,840 | whoever made it, at release |
| Sheet, empty / one attribute | 69 / 83 | 1,000,760 / 1,071,880 | never; an attribute is 8 bytes plus key and value |
| `Proven` | 299 | 2,169,160 | prover, via `close_leaf` |
| Traits root | 97 | 1,143,000 | never |
| Contest entry (in its list): tokens / an NFT | 43 / 83 bytes | 218,440 / 421,640 | never: to the treasury at the contest's close |
| Lottery entry (in its round): plain, + a recipient, + an NFT ticket | 40, +32, +32 bytes | 203,200 a plain one | never: to the treasury at the round's close; the round's header is its first buyer's, back at the close |
| Listing, sale / rental (no shares) | 183 / 189 | 1,579,880 / 1,610,360 | maker, close |
| A wallet's counts: header / a record | 7 / 28 | 685,840 / +142,240 | never |
| A grant's shard: header / a wallet's record / a round paid | 7 / 28 / 16 | 685,840 / +142,240 / +81,280 | to the owner when the shards close after the grant |
| Token account / Token-2022 ATA / with transfer fee | 165 / 170 / 182 | 1,488,440 / 1,513,840 / 1,574,800 | on close |

Variable records (items, boxes, lotteries, grants, farms, contests, auctions, offers) are sized to their fields;
`accountBytes` and `xsolana_cost` price a given one. A farm with both vaults is about 0.0045 SOL and never closes; a
project's vault for a mint never closes either.

**Other costs:**

- **Fees**: 0.002 SOL player, 0.00001 SOL project (defaults).
- **An order** holds its rent, the player fee and 0.006 SOL a unit (`orderEscrow`): each collectible, fresh compressed
  item or stash NFT of the box's richest entry, for each draw of each open; once an order, each source of tokens it may
  pay and the NFT it rolls on. A pack of five Core cards holds 0.03 SOL until it is settled. Each settle part lends it
  to whoever settles for what the player's own outcome opens (about 0.0031 SOL a Core card, which stays in the card),
  less what later parts need; the signer is never left richer, and the player gets the rest back. Asking a waiting
  roll costs the oracle's fee.
- **A `buy`** costs the price, the fee and what its prizes open or make; no order.
- **Prizes** cost what they make, paid by the sender (a grant's funds for a grant): the winner's token account if
  missing (1,488,440 lamports), a new Core asset (about 0.004 SOL), a roll's order (sized to its box, plus escrow,
  back at settle). Putting an NFT in a stash: the project fee and 182,880 lamports (the first also opens the stash); a
  Token Metadata NFT also opens the project's token account of it, returned when it leaves.
- **Tables**: the owner pays each row's rent as it writes it, never back: about 0.2 SOL for 1,000 labels, 4.1 SOL
  for 100,000 numbers, 53 SOL for a full 10 MiB account. A committed table costs 1,107 bytes whatever its rows, and
  the transactions that post them.
- **Compressed NFTs**: a tree is paid once, about 0.23 SOL for 16,384 NFTs and 0.42 SOL for 1,048,576, plus its
  Bubblegum config; each Bubblegum move costs its fee (about 6,000 lamports).
- **Growth and locks on NFTs**: about 0.0004 SOL a new key, 0.0002 SOL for a lock key, the first time.

**Compute units** (a selection, measured on 0.20 with the test environment's token programs; 0.22's draws are in
[Limits](#limits); devnet and mainnet run p-token,
where token moves cost less: `pay` with 4 shares 41,065, a collectible's settle with 4 shares 93,862, `open_box`
58,088, `refund` 22,004):

| Instruction | CU |
| --- | ---: |
| `pay`: all to the treasury / 4 shares | 23,540 / 69,563 |
| `open_box` / shop shape (one collectible, no roll) / 8 entries | 64,056 / 48,113 / 73,759 |
| `open_box` with a collectible shown for odds | 76,869 |
| `callback_roll` (8 entries) | 26,861 |
| `settle`: a collectible, a pool, a burn / 4 shares | 96,949 / 122,713 |
| `refund` | 28,072 |
| `roll` / `callback_random` | 24,292 / 3,313 |
| `draw_lottery` / `callback_lottery` (3 places, 60 contributions) | 25,763 / 11,503 |
| `buy_tickets` / `finish_lottery_contribution` / a winner's place (0.20's; 0.23 has `settle_round` and `pull` instead, not measured here) | 43,079 / 45,819 / about 38,500 |
| `open_farm`: tokens / NFTs | 58,817 / 48,293 |
| `stake_tokens` / `stake_nft` frozen / escrowed | about 51,500–54,400 / 74,846 / 68,765 |
| `open_contest` / `decide` (2 shares) | 54,098 / 43,869 |
| `open_auction` / `bid` / `end_auction` | 50,919 / 45,646 / 67,113 |
| `hold` / `release` | 32,663 / 28,677 |
| `craft`: 1 burned for 1 / 4 burned and 4 used for 2 and tokens | 75,043 / 389,352 |
| `claim_grant`: voucher, an item / open, a stash NFT | 76,390 / 64,580 |
| `stash` in or out | about 31,500–36,100 |

A pNFT stake takes about 191,000 CU and a compressed proof and stake about 162,000, past the 200,000 default only
narrowly: set a higher limit. A grant claim whose receipt held 256 rounds used 142,439 (0.20). Third-party transfer hooks can
need more, or refuse.
