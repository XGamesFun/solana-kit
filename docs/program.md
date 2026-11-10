# The loot program: how it behaves

**Version 0.26.0**, program ID `9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`. **Not on devnet yet**: devnet runs
0.25.0 (since slot 519,994,814, 2026-11-08) until this build is deployed. Nothing runs on mainnet. **Not independently
audited** (`SECURITY.md`). No accounts carry over from older versions: make fresh economies for this one.

This page describes 0.26.0, the build its IDL comes from. Its rule: **the program restricts a project only where it
must**; a project's own risky setup gets a warning from `xsolana_check`, in plain words, not a refusal. The limits that
only guarded a project against itself are out (token screens, time limits, caps on lists, values of 0), each bounded by
what the chain allows ([Limits](#limits)). **Both sides of an exchange move in one instruction**: an auction's seller is
paid only with the lot (`end_auction`'s three endings), and a loan's repayment brings its NFT home (`repay(home)`). A
box may give nothing on a miss (`GiveNothing`); a lottery may close its sales before the draw (`closes_before`), weigh a
no-loss lottery's tickets by the time they are held (`time_weighted`), and say what a short pool pays (`when_short`);
a roll's odds are read at its first ask, from its player's profile and an NFT they show.

0.25.0's rule: **a prize never shifts to a later round**. A
lottery names where its places are paid from (`PaysFrom`): each round's own ticket money, what the places leave going
where the project says, or a pot kept from round to round (16 at most a lottery, `["pot", lottery, id]`), whose next
ask always moves in what the round before left it (`Lottery::owing`); a contest's winners share what the decision wrote
(`pot_won`, `prize_won`), whatever reaches its accounts later; a box that stops selling covers each purchase by the most
any entry sharing an account takes in one draw; a free roll never loses draws to what it emptied itself; and a token
seat's booster can be a recipe's kept `Use`.

0.24.0's rules are strict (the program's CHANGELOG): **a seat past its end is paid exactly** (`["ends", farm]`, `walk_farm`), **a prize is a fixed amount** on every route, **a draw is on the written weights** and one that can't be given gives back its worth, **an edit never loses what was spent**, **deadlines count in seconds**, **a run missed is missed**, and **a seller who can't be paid is owed**.

What 0.23 changed, in short: who claimed what is kept in **lists of records** (a wallet's counts, a grant's claims and
rounds in shards), so one claim pays **several rounds**; a **lottery round is a record of its own**, its money fixed at
its draw's ask and each part pulled by itself, in any order (`pull`), with **places as runs** and a **raffle of many
NFTs**; a **contest's entries are one list**, its winners sharing the losers' NFTs and its losers sending nothing; a
route's extra accounts are its **tail**, from the Memo program on; **several NFTs a call** on stakes, harvests,
stashes, holds, releases and makes; a farm seat **earns until** its tier's term
or its NFT's fuel; **every box opened asks the oracle**, and a box with nothing random sells with `buy`, a `count` at a
time; **whoever settles an order pays what the settle opens or mints**; an item's life is lines of the recipes that
take it. 0.22 made packs, tables, fresh and compressed items, stashes drawn by weight and profiles. Measured costs below
that were not measured again are marked as 0.20's.

This page says what the program does, who signs what, what it holds and what it costs, for anyone building on it
with `js/client` or the `xsolana_*` tools. **The IDL in `js/client/idl/loot.json` is the authority for every account
layout, argument and error code**; where this page and the IDL differ, the IDL is right. Client builder names are
given in `code` where they help (`openBoxIx`). To build an economy, start with the `xsolana-economy` skill and
`xsolana_guide`, not here.

## The whole program in one screen

loot is one Solana program every project shares. A **project** is one record owned by any wallet, numbered among
that wallet's own (`["project", creator, id]`; a wallet may have any number). It has no token or collection of its
own: each mechanic names the mint it takes, each item the Core collection it is minted into, and the project names
the Core collections it has authority over (any number). 59 instructions, each general enough for many uses.

A signature proves only what the chain can't see. Whoever sets something up signs once (the owner a mechanic, a
seller an auction, a player a purchase); after that, what the chain can check (a roll, a time, a stake, a bid) runs
with nobody's signature. Only an event off the chain (who won a match) needs a key to vouch for it.

Value moves five ways, and every move of a project's economy leaves a public receipt in the log:

| Verb                                           | Instructions                                | Who signs                                                                      |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| **In**: money or an NFT comes in               | `pay`, `pay_nft`, `buy`, `open_box`         | the player; anyone for `pay` (a sponsor, the owner funding a pool)             |
| **Out**: the project's tokens move             | `move_tokens`                               | the authority                                                                  |
| **Make**: collectibles made, rewritten, burned | `collectible`                               | the authority                                                                  |
| **Decide**: the project names an outcome       | `release`, `open_contest`, `decide`, `roll` | the authority; a contest's deciders sign verdicts anyone sends                 |
| **Grant**: a voucher names a winner            | `claim_grant`                               | the winning wallet, with a voucher, a list proof, or nothing for an open grant |

The owner writes a mechanic once (`upsert`, or `open_farm`); players and anyone then carry it out:

| Mechanic         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Box** and shop | a weighted roll of entries, each any number of prizes, or nothing (a `Burn` share burns the payment); a **pack**: several draws an open (`slots`) and several opens a purchase (`count`), all from one oracle answer; a box of one entry with nothing random is a shop item, a bundle or a fixed pack, sold in one instruction (`buy`, a `count` at a time). A box can roll **on an NFT** (an enchant, an upgrade, a trade-in) |
| **Table**        | weighted rows (labels or numbers) with stock, written in batches and sealed: what a fresh item's traits are drawn from                                                                                                                                                                                                                                                                                                         |
| **Schedule**     | a move of the project's tokens on a timer; sealed, from a vault only its runs pay out of (vesting)                                                                                                                                                                                                                                                                                                                             |
| **Lottery**      | ticket money held apart, a draw, any number of places; raffles, a least sale, free tickets, NFT tickets, no-loss rounds                                                                                                                                                                                                                                                                                                        |
| **Farm**         | tokens or NFTs of any kind staked with lock tiers and boosts; a shared rewards pool or a fixed rate; points and levels; mission prizes and rolls; a time each seat earns until (its tier's term, its NFT's fuel)                                                                                                                                                                                                               |
| **Recipe**       | collectibles, NFTs and tokens in; prizes out; numbers raised on what is kept                                                                                                                                                                                                                                                                                                                                                   |
| **Hold**         | a player hands an NFT to the project until a time they choose                                                                                                                                                                                                                                                                                                                                                                  |
| **Offer**        | any wallet's money for any NFT that passes a rule: a bid, or a loan against it                                                                                                                                                                                                                                                                                                                                                 |
| **Listing**      | any wallet's NFT for sale, or for rent by the period                                                                                                                                                                                                                                                                                                                                                                           |
| **Contest**      | players back a side with tokens or one NFT each; the named side shares the pot                                                                                                                                                                                                                                                                                                                                                 |
| **Auction**      | the highest bid at the end wins a lot: a new item, a roll of a box, or an NFT                                                                                                                                                                                                                                                                                                                                                  |
| **Grant**        | a reward others hand out, within limits the program keeps                                                                                                                                                                                                                                                                                                                                                                      |
| **Stash**        | NFTs of any kind the project holds to give away as prizes, each with a weight in the draws                                                                                                                                                                                                                                                                                                                                     |
| **Profile**      | numbers the project keeps about a wallet (XP, level, rank), read by rules as an NFT's attributes are                                                                                                                                                                                                                                                                                                                           |

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

| Role                                                           | Signs                                                                                                                                                                                                                                          | Cannot                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Player**                                                     | what they pay, and the most they will pay                                                                                                                                                                                                      | be charged more than they signed for                                                                                                                                                                    |
| **Authority**                                                  | what leaves a pool or is made on the project's say-so (`move_tokens`, `collectible`, `roll`); opens and decides contests; releases a hold while it runs. No caps                                                                               | pay out of the vaults holding orders, prizes set aside, bids, offers, farms, contest or lottery pots; move a held NFT after its hold; touch a loan's NFT, a listed NFT, or an auction it did not put up |
| **Owner**                                                      | the project's settings (`update_project`: keys, treasury, pause, collections); every mechanic (`upsert`, `open_farm`, `open_pool`)                                                                                                             | the same: money that belongs to a record                                                                                                                                                                |
| **Owner or authority**                                         | `stash`, `open_tree`, `set_traits`                                                                                                                                                                                                             | take a raffle's promised NFT out of its lottery's stash                                                                                                                                                 |
| **Platform**                                                   | its two fees, `collect_fees`, the suspend switch                                                                                                                                                                                               | stop a payout, settle, refund or unstake (two exceptions: [the switches](#the-switches))                                                                                                                |
| **Voucher keys**                                               | who earned a grant: up to 3 named, or any number under a key root                                                                                                                                                                              | give more than the grant's limits                                                                                                                                                                       |
| **Grant winner**                                               | its own claim, always                                                                                                                                                                                                                          | — anyone may pay its fees                                                                                                                                                                               |
| **Deciders**                                                   | a contest verdict (any number, named at open), sent by anyone                                                                                                                                                                                  | name a side before entries close                                                                                                                                                                        |
| **Offer or listing maker**                                     | their own offer or listing, alone                                                                                                                                                                                                              | — the project's keys have no say over it                                                                                                                                                                |
| **Auction seller**                                             | `open_auction`, and calling off one with no bid                                                                                                                                                                                                | stop it once a bid is in                                                                                                                                                                                |
| **Anyone**                                                     | refund, draw and finish a lottery, release an ended hold, claim a called-off contest's entry or a loser's NFT once no winner has picks left, end an auction, repay a loan, refresh a seat, run a sealed burn, prove a compressed NFT or traits | —                                                                                                                                                                                                       |
| **Its player or the project's keys**                           | `ask_roll` (only its player, on a box with no entry in stock)                                                                                                                                                                                  | —                                                                                                                                                                                                       |
| **Its player, the project's keys or the key its player named** | settle (`settler`, named at `openBoxIx` or the player's own `askRollIx`)                                                                                                                                                                       | —                                                                                                                                                                                                       |
| **The winner or the project's keys**                           | a winner's first contest claim, for 30 days from the decision (`CLAIM_GRACE_SECONDS`); then anyone                                                                                                                                             | —                                                                                                                                                                                                       |
| **The project's keys or who it pays**                          | run a schedule                                                                                                                                                                                                                                 | —                                                                                                                                                                                                       |

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

The hosted keeper is optional: any client can send refunds, draws and cleanups, and settles with a key the player or project gave it, and none can substitute a
winner or bypass the program's checks.

## Accounts and addresses

Every address is a PDA of the program (`pda.*` in `js/client/pda.js`). Seed integers are little endian: a project's
`id` and an order's `nonce` u64, a pool's `index` u16, a grant's `id` u16, a hold's `free_at` i64, a shard and a page
u8, every other id u32.
Each loot account starts with a one-byte tag (`TAGS`, `decodeAny`). A record that must be new (farm, contest, auction,
order, offer) is created, never written over.

| Tag | Account                      | Address                                                                                                                                                                                                                  | Bytes                                                                                                                                               | Rent paid by                                                                                                                                 |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Platform`                   | `["platform"]`                                                                                                                                                                                                           | 73                                                                                                                                                  | the platform, once                                                                                                                           |
| 2   | `Project`                    | `["project", creator, id]`; fee box `["fees", project]`                                                                                                                                                                  | 153 + 32 a collection                                                                                                                               | owner; never closed                                                                                                                          |
| 3   | `Item`                       | `["item", project, id]`                                                                                                                                                                                                  | varies (`name` at offset 86, right after `collection`; a fresh item's traits after its URI)                                                         | owner, back on close                                                                                                                         |
| 4   | `LootBox`                    | `["box", project, id]`                                                                                                                                                                                                   | varies                                                                                                                                              | owner; never closed                                                                                                                          |
| 5   | `Order`                      | `["order", project, player, nonce]`                                                                                                                                                                                      | sized to its box at the purchase (`orderBytes`)                                                                                                     | player (or a prize's maker), back at settle or refund; whoever settles pays what the settle opens or mints                                   |
| 6   | `Schedule`                   | `["schedule", project, id]`; sealed vault `["vest", schedule]`                                                                                                                                                           | varies                                                                                                                                              | owner                                                                                                                                        |
| 7   | `Lottery`                    | `["lottery", project, id]`; pots `["pot", lottery, id]` (`pda.lotteryPot`, `id` below `MAX_POTS`, 16); own stash `["lottery_stash", lottery]`                                                                            | varies                                                                                                                                              | owner; stash growth by whoever puts an NFT in                                                                                                |
| 8   | `Recipe`                     | `["recipe", project, id]`                                                                                                                                                                                                | varies                                                                                                                                              | owner; never closed                                                                                                                          |
| 9   | `Hold`                       | `["hold", asset, free_at]`                                                                                                                                                                                               | 170 (a loan's 243)                                                                                                                                  | player or borrower (`payer`), back on release                                                                                                |
| 10  | `Contest`                    | `["contest", project, id]`; pot `["pot", contest]`; split prize `["prize", contest]`                                                                                                                                     | varies                                                                                                                                              | the opening authority, back on close                                                                                                         |
| 12  | `Sheet`                      | `["sheet", project, nft]`                                                                                                                                                                                                | 69 + attributes                                                                                                                                     | whoever's write grows it (a write that shrinks it refunds nobody); anyone closes it once its NFT is burned (rent to the treasury)            |
| 13  | `Traits`                     | `["traits", project, key]`                                                                                                                                                                                               | 97                                                                                                                                                  | owner or authority; never closed                                                                                                             |
| 16  | `LotteryRound`               | `["round", lottery, incarnation, round]`; its token accounts `["round-tokens", round, mint]`                                                                                                                             | a header sized once at its first purchase, then an entry a purchase (`entryWidth`: 40 + 8 for a fee mint + 32 a recipient share + 32 an NFT ticket) | first buyer the header (back at the close), each buyer its entry (to the treasury at the close)                                              |
| 17  | `Farm`                       | `["farm", project, id]`; vaults `["staked", farm]`, `["rewards", farm]`                                                                                                                                                  | varies                                                                                                                                              | owner; never closed                                                                                                                          |
| 18  | `Seat`                       | `["seat", farm, player]` (tokens), `["seat", farm, asset]` (an NFT)                                                                                                                                                      | 176                                                                                                                                                 | player, back on last exit                                                                                                                    |
| 19  | `Proven`                     | `["leaf", asset]`                                                                                                                                                                                                        | 299 (331 with asset data)                                                                                                                           | first prover, back via `close_leaf`                                                                                                          |
| 20  | `Auction`                    | `["auction", project, seller, id]`                                                                                                                                                                                       | varies, + 32 an NFT bid                                                                                                                             | seller, back at the end                                                                                                                      |
| 22  | `Offer`                      | `["offer", project, maker, id]`                                                                                                                                                                                          | varies                                                                                                                                              | maker, back on close                                                                                                                         |
| 23  | `Listing`                    | `["listing", project, asset]`                                                                                                                                                                                            | 183 sale / 189 rental, + 3–35 a share                                                                                                               | maker, back on close                                                                                                                         |
| 24  | `Profile`                    | `["profile", project, wallet]`                                                                                                                                                                                           | 69 + attributes                                                                                                                                     | whoever's write grows it (a write that shrinks it refunds nobody); never closed                                                              |
| 25  | `Table`                      | `["table", project, id]`                                                                                                                                                                                                 | 51 + 8 a row of numbers / 40 a row of labels                                                                                                        | owner, as it writes rows; never closed                                                                                                       |
| 25  | `Table` (a stash)            | `["stash", project, id]`; a lottery's own `["lottery_stash", lottery]`                                                                                                                                                   | 103 with one NFT, + 36 an NFT                                                                                                                       | whoever puts an NFT in; never closed                                                                                                         |
| 26  | a list (`decodeList`)        | a wallet's counts `["counts", project, wallet]`; a grant's claims `["claims", grant, incarnation, shard]` and rounds `["rounds", grant, incarnation, shard]`; a contest's entries `["entries", contest, incarnation, 0]` | 7, + 28 a limit record, 16 a round paid, 43 or 83 an entry                                                                                          | the one counted (a grant's funds for a claim), never closed; a grant's shards close once it is gone (rent to the owner); a contest's with it |
| 27  | `Grant`                      | `["grant", project, id]`                                                                                                                                                                                                 | varies                                                                                                                                              | owner, back with funds on close                                                                                                              |
| 29  | a farm's ends (`decodeEnds`) | `["ends", farm]`, for a farm that keeps one (`Farm.keeps_ends`)                                                                                                                                                          | 7, + 44 a time waiting                                                                                                                              | the owner its first bytes, each time's sender its record; never closed                                                                       |

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

Arguments are in the IDL. Each instruction's data starts with a 1-byte tag, the IDL's `discriminator`; the oracle's
three callbacks keep 8-byte tags (`instructionOf` finds an instruction by its tag). The program logs no instruction's
name. An instruction's own accounts come first, then remaining accounts in the order the builders
produce, then its **tail**: from the Memo program's account on, the accounts a transfer hook or a Core collection's
check reads (`tailOf`); with no Memo account, the tail is empty. An optional account left out is passed as the program's own address. A
player passes a **gate** with the first remaining accounts (after a box's prize accounts): a collectible shown
(`Gate::Holds`), the list proof's nodes as accounts (`Gate::List`), or the wallet's seat then the farm
(`Gate::Staked`). Fees: **P** player fee, **J** project fee, **free**.

| Subject        | Instruction (builder)                                                      | Signs                                                                                                                                                                              | Fee                                           | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform       | `init_platform` (`initPlatformIx`)                                         | the program's upgrade authority, once                                                                                                                                              | —                                             | makes the platform and its two fees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                | `set_platform` (`setPlatformIx`)                                           | admin (and a next admin)                                                                                                                                                           | —                                             | changes fees (a raise waits 7 days) or hands the role on                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                | `collect_fees` (`collectFeesIx`)                                           | admin                                                                                                                                                                              | —                                             | sweeps projects' fee boxes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                | `set_suspended` (`setSuspendedIx`)                                         | admin                                                                                                                                                                              | —                                             | suspends or restores a project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Project        | `create_project` (`createProjectIx`)                                       | owner                                                                                                                                                                              | J                                             | `id`, `authority`, `treasury`, `collections` (Core, update authority the owner or the project, none twice, `BadCollection`)                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `update_project` (`updateProjectIx`)                                       | owner, and a new owner if named                                                                                                                                                    | J                                             | keys, treasury, `paused`, collections                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                | `open_pool` (`openPoolIx`)                                                 | owner                                                                                                                                                                              | J                                             | a pool `index` in a mint, for good                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                | `upsert` (`upsertIx`, `closeRecordIx`)                                     | owner                                                                                                                                                                              | J                                             | writes an `Item`, `Box`, `Schedule`, `Lottery`, `Recipe`, `Grant` or `Table` (a table's rows in batches, then sealed); `None` closes one. A box, recipe, grant or lottery that names a box to roll passes each such box once, the box alone (`boxesAccounts`, `defRolls`): `WrongRecord` for a box not written; what the box can give is read when its roll is asked and answered. A box's own roll accounts must fit the oracle's answer (`TooManyAccounts`). A box is written before what names it (it may name itself) |
|                | `open_farm` (`openFarmIx`)                                                 | owner                                                                                                                                                                              | J                                             | a farm, never edited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                | `open_tree` (`openTreeIx`)                                                 | owner or authority                                                                                                                                                                 | J                                             | a Bubblegum v2 tree for compressed prizes (the sender makes the empty tree account first, `treeSize`)                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                | `set_traits` (`setTraitsIx`)                                               | owner or authority                                                                                                                                                                 | J                                             | the root of off-chain traits the project vouches for                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| In             | `pay` (`payIx`)                                                            | anyone                                                                                                                                                                             | P, or J for the project's keys                | `amount` split by any number of shares, each its own transfer                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                | `pay_nft` (`payNftIx`)                                                     | the holder                                                                                                                                                                         | P, or J                                       | any NFT, given to a wallet or burned (never to a loot account, `ToTheProject`)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Boxes          | `buy` (`buyIx`)                                                            | player                                                                                                                                                                             | P                                             | a box of one entry with nothing random, no subject (`Rolls`): `count` sales (at least 1) at the price each leaves, one `max_price` for all, each counted against `per_wallet`; price split, the entry's prizes given `draws × count` times (`buyGives`: a fixed amount of tokens once with the whole amount, any other prize once a draw, its rolls at `nonce`, `nonce + 1`, …), one instruction                                                                                                                          |
|                | `open_box` (`openBoxIx`)                                                   | player                                                                                                                                                                             | P, held in the order                          | `count` opens in one purchase (more than 1 only for a box with no `subject`, `BadEntries`), each at the price the one before left: the price into the vault, an order made, the oracle asked (its accounts required: every box opened asks, one with nothing random too)                                                                                                                                                                                                                                                  |
|                | `callback_roll`                                                            | the oracle                                                                                                                                                                         | —                                             | draws every card of every open from one answer, sets aside what it won (at most 21 accounts; a fresh item's tables only while they fit the box's table budget)                                                                                                                                                                                                                                                                                                                                                            |
|                | `settle` (`settleIx`)                                                      | its player, the project's keys or the key its player named; pays what it opens or mints                                                                                            | free                                          | a part: delivers what was won from where the last part stopped up to `upto` (`settlePartEnd`; past the end, `SETTLE_LAST`, is the last part; 0 only splits the payment), `prize_accounts` of its accounts the prizes'. The last part pays the split, does the NFT's fate and closes the order                                                                                                                                                                                                                             |
|                | `refund` (`refundIx`)                                                      | anyone                                                                                                                                                                             | free                                          | a failed order from the next slot, a pending one after 10 minutes, an asked one holding a payment or an NFT 7 days after its first ask (its box named while the order counts draws in its `in_flight`, `Order.reserved`; `orderRefundable`); never a rolled or waiting one                                                                                                                                                                                                                                                |
|                | `ask_roll` (`askRollIx`)                                                   | its player or the project's keys, paying the oracle                                                                                                                                | free                                          | asks for a waiting roll; its first ask reads the odds from the player's profile and an NFT they show ([Rules](#rules-gates-odds-and-boosts)); again after `STALE_SECONDS` (10 minutes, `rollAskable`). On a box with no entry in stock only the order's player asks, in a later slot than the order's `requested_slot` (`SoldOut` otherwise)                                                                                                                                                                              |
| Project moves  | `move_tokens` (`moveTokensIx`)                                             | authority                                                                                                                                                                          | J                                             | from a pool or minted, to any `To`, fixed or a share of a pool                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `collectible` (`collectibleIx`, `makeIx`)                                  | authority                                                                                                                                                                          | J                                             | `Make { item, tree, attributes }` for several owners at the item's next serials (or compressed into `tree`), `Set` (or a Sheet), `Burn` (rent to its holder), `Profile` (a wallet's profile)                                                                                                                                                                                                                                                                                                                              |
|                | `roll` / `callback_random` (`rollIx`, `callbackRandomIx`)                  | authority / oracle                                                                                                                                                                 | J / —                                         | a random number for the project's own use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                | `stash` (`stashIx`)                                                        | owner or authority                                                                                                                                                                 | J                                             | NFTs into a stash (or a lottery's own), each with its weight in the draws (above 0), or out to a wallet                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                | `run_schedule` (`runScheduleIx`)                                           | the project's keys or who it pays (a sealed burn: anyone)                                                                                                                          | free                                          | a run pays once, for the latest run due, and those before it lapse; a sealed fixed amount pays every due run up to `upto` (`runsDue`, `scheduleCatchesUp`), one transfer                                                                                                                                                                                                                                                                                                                                                  |
| Lotteries      | `buy_tickets` (`buyTicketsIx`)                                             | player                                                                                                                                                                             | P                                             | an entry in the current round (its first purchase opens it; its address names the incarnation), naming the round's `revision` (`TermsChanged`)                                                                                                                                                                                                                                                                                                                                                                            |
|                | `draw_lottery` / `callback_lottery` (`drawLotteryIx`, `callbackLotteryIx`) | anyone / oracle                                                                                                                                                                    | free                                          | the first ask of a due round fixes its money and moves the lottery on (paid from a pot, it first moves in what the round before left it: `owing`; refused `NotDue` while that round waits for the oracle); asks again after `STALE_SECONDS`; after 7 days unanswered (`lotteryCancellable`) the next ask cancels the round; `skip_hooked` (the authority) leaves hooked sources out                                                                                                                                       |
|                | `pull` (`pullIx`, `pullRolls`)                                             | anyone; its payer opens accounts                                                                                                                                                   | free                                          | one part (`partsOwed`, `commonOwed`): an entry's own, its places' parts or prizes in a run, a part owed in common (a share, what the places leave: to the pot or to `rest`, `leftoverTo`); the last closes the round                                                                                                                                                                                                                                                                                                      |
| Farms          | `stake_tokens` / `unstake_tokens` (`stakeTokensIx`, `unstakeTokensIx`)     | player                                                                                                                                                                             | P                                             | stake into a tier / take out (0 only harvests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `stake_nft` / `unstake_nft` (`stakeNftIx`, `unstakeNftIx`)                 | player                                                                                                                                                                             | P                                             | an NFT on its own seat or as a booster / out after the lock, with a mission's prize or roll                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `harvest` (`harvestIx`)                                                    | player                                                                                                                                                                             | P                                             | rewards out, or `compound`ed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                | `refresh_seat` (`refreshSeatIx`)                                           | anyone (pays what growth adds, and a new end time)                                                                                                                                 | free                                          | re-reads boosts, the NFT, upkeep, the player's profile; writes growth                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                | `walk_farm` (`walkFarmIx`, `walkFarmParts`)                                | anyone                                                                                                                                                                             | free                                          | credits a farm up to at most `most` of the times its seats stopped earning, for one that has passed more than a transaction can walk (`farmNeedsWalk`)                                                                                                                                                                                                                                                                                                                                                                    |
| Recipes, holds | `craft` (`craftIx`)                                                        | player alone                                                                                                                                                                       | P                                             | all lines in and out, or nothing (`profile`, the player's, when a need or a raise names it)                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `hold` (`holdIx`)                                                          | player                                                                                                                                                                             | P                                             | NFTs handed to the project until `free_at`, a hold each                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                | `release` (`releaseIx`)                                                    | authority while it runs (J); anyone after (free); loans below                                                                                                                      | J / free                                      | sends held NFTs on, one `to`, each hold named by its address (`address` when its `free_at` changed since: a repaid loan's); a hold whose `player` is the project's own address is owed to the treasury, sent to `project.treasury` as it is then (`releaseIx`'s `treasury`; `Released.player` the wallet it went to)                                                                                                                                                                                                      |
| Contests       | `open_contest` (`openContestIx`)                                           | authority                                                                                                                                                                          | J                                             | terms fixed for good                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                | `enter` (`enterIx`)                                                        | player                                                                                                                                                                             | P                                             | a record in the contest's list, one side a wallet (`OtherSide`)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                | `decide` (`decideIx`)                                                      | authority, or anyone with a verdict; anyone for an overdue contest                                                                                                                 | J; free when overdue                          | names a side, or `None` calls it off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                | `claim` (`claimIx`)                                                        | the winner or the project's keys when it gives a prize or picks, otherwise anyone (only the winner picks losers' NFTs for 30 days, then the project's keys may too, `WinnerPicks`) | free                                          | an entry's part of what the decision wrote (`contestWinnings`: of `pot_won`, and of `prize_won` for a split prize), its prize and the NFTs it names                                                                                                                                                                                                                                                                                                                                                                       |
| Auctions       | `open_auction` (`openAuctionIx`)                                           | seller alone                                                                                                                                                                       | P for a player's NFT, J for the project's lot | an auction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                | `bid` (`bidIx`)                                                            | player                                                                                                                                                                             | P                                             | tops the high bid; the topped one goes back at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                | `end_auction` (`endAuctionIx`)                                             | anyone once over; seller to call off one with no bid; `CallOff` anyone on proof the lot or a winning NFT is gone, else the project's keys                                          | free (J for the project calling off its own)  | `ending`: `Deliver` pays out and hands the lot over in one instruction (an NFT lot that can't move fails it, and it waits); `LotFirst` the lot now and the bid owed to the next `Deliver`; `CallOff` the bid back and the lot home ([Auctions](#auctions)). A roll lot sold pays out nothing: the bid stays in the vault as its order's payment. A sold lot is never made a hold                                                                                                                                          |
| Offers         | `open_offer` (`openOfferIx`)                                               | maker                                                                                                                                                                              | P, or J                                       | a bid or a loan, all its money in the vault                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `close_offer` (`closeOfferIx`)                                             | maker                                                                                                                                                                              | free                                          | what is left back to the maker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `sell_to_offer` (`sellToOfferIx`)                                          | the NFT's holder                                                                                                                                                                   | P, or J                                       | NFT to the maker, price to the seller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                | `borrow` (`borrowIx`)                                                      | the NFT's holder                                                                                                                                                                   | P, or J                                       | NFT held against a debt, money to the borrower                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `repay` (`repayIx`)                                                        | anyone, before `due`                                                                                                                                                               | free                                          | repayment to the lender, the NFT shown still held (`NotTheNft`, `NotProven`); with `home` the NFT goes to its borrower in the same call and the hold closes, else the hold becomes a plain one that is over and anyone `release`s the NFT later; names the debt its payer was shown (`repay`, `TermsChanged` otherwise; js/play `loan()` then `repay(asset, due, { repay })`)                                                                                                                                             |
| Listings       | `open_listing` (`openListingIx`)                                           | the NFT's holder                                                                                                                                                                   | P, or J                                       | for sale or for rent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                | `take_listing` (`takeListingIx`)                                           | taker                                                                                                                                                                              | P, or J                                       | buys, or rents for 1 to `max_periods` periods; a Token Metadata NFT passes the project's token account of it (`project_token`), read to see the project still holds it                                                                                                                                                                                                                                                                                                                                                    |
|                | `close_listing` (`closeListingIx`)                                         | maker                                                                                                                                                                              | free                                          | NFT home; during a rental only stops it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Proofs         | `prove_leaf` (`proveLeafIx`)                                               | anyone (pays the record's rent once)                                                                                                                                               | free                                          | records a compressed NFT proven against its tree                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                | `close_leaf` (`closeLeafIx`, `closeSheetIx`, `withLeafCloses`)             | its payer, signing, at any time; anyone once it no longer reads (`StillProven` otherwise)                                                                                          | free                                          | closes a compressed NFT's record (the client appends it to the transaction that used it), or a burned NFT's Sheet (`NotBurned` otherwise; a Token Metadata NFT's names its edition, `edition`, and closes once its mint holds none, its mint authority is none or its edition, and its edition account is closed; a compressed NFT's passes its record proven empty as `tree` and its tree as `edition`, and closes while the record still reads against that tree or the tree is gone: `closeSheetIx` with `tree`)       |
|                | `prove_traits` (`proveTraitsIx`)                                           | anyone (pays the Sheet's growth)                                                                                                                                                   | free                                          | writes vouched traits into a Sheet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Grants         | `claim_grant` (`claimGrantIx`, `js/client/grant.js`)                       | the wallet always, plus a `signer` who pays (may be the wallet)                                                                                                                    | P, from the signer                            | gives the grant's prize for each round not paid yet; a voucher is an Ed25519 instruction right before (`ed25519Ix`)                                                                                                                                                                                                                                                                                                                                                                                                       |
|                | `close_shard` (`closeShardIx`)                                             | anyone                                                                                                                                                                             | free                                          | a shard of a grant gone or made again, rent to the owner (`GrantLive` before)                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Money in, and where it goes

### The split

A split is a list of shares, each basis points with a destination (`To`): a stored split (a box's, order's, lottery's,
contest's, auction's, offer's, listing's) holds at most 8 (`MAX_SHARES`, not in the IDL; a ninth is `BadShares`), a
`pay`'s as many as its transaction can carry. A step that pays many shares into accounts not open yet (an end, a
settle) stays under the 64-instruction trace limit when some of those accounts are opened first. What the shares leave goes to the split's owner: the treasury for a sale, the seller for an
auction, listing or offer.

| `To`                       | Paid to                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Burn`                     | burned                                                                                                                                                                                                                                                                                                                       |
| `Pool(index)`              | one of the project's pools                                                                                                                                                                                                                                                                                                   |
| `Account(key)`             | a named token account                                                                                                                                                                                                                                                                                                        |
| `Wallet(key)` / `Treasury` | the wallet's (or treasury's) associated account of the mint                                                                                                                                                                                                                                                                  |
| `Holder(asset)`            | whoever holds that collectible at that moment (a plot's owner, an arena)                                                                                                                                                                                                                                                     |
| `Chosen(item)`             | chosen by the buyer at `open_box`, `buy` or `buy_tickets` (`chosen_recipient`): a wallet not the buyer's, or with an item, a collectible of it whose holder is paid. With no choice a wallet share goes to the treasury; a collectible share needs one a player holds (`BadChoice`). In a contest, the wallet `decide` names |

**Every part is rounded down** (a share, a schedule's or `move_tokens`' share of a pool, a place's share of a pot, a contest claim, a price rise);
what rounding leaves goes with the rest, or stays in the pool or pot; a contest's claims add up to exactly what the
decision wrote.

**Where money goes.** Money owed to a person goes to their associated token account, which the sender opens (paying
its rent) when it isn't there, so a payment never waits. In a stored split, a share that finds nobody (a collectible
nobody or the project holds, a loot account as payee, an account that can't take the mint) joins what the split
leaves. The **split owner's** account failing fails `pay`, `buy`, `take_listing`, `sell_to_offer` and `settle` (the
money stays the payer's). Only `end_auction` of a seller's NFT (`Lot::Asset`) doesn't wait on a seller's account that
can't take the mint: the lot goes to its winner, the auction stays open with what it owes (`Auction.proceeds_owed`), and
the next `end_auction` (anyone's) pays it and closes it, failing while the account still can't take it. A
new item's or a roll's lot whose treasury account is frozen waits (`AccountFrozen`) until it is thawed. `move_tokens` and schedules fail
on a pool never opened or on the project's vault (`BadMove`), and so does `pay` with a share into the project's own
vault for its mint (`To::Account`, `BadMove`): nothing would ever pay it out. A farm's rewards vault is not that vault,
and `pay` funds one. `pay`'s shares are separate transfers, so a transfer
fee comes out of each.

### The fee

Two flat SOL fees, set by the platform, each capped at **0.01 SOL**, a raise waiting **7 days**. They land only in the
project's own fee box (`["fees", project]`); only the platform takes them out.

| Fee         | Default     | When                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Player**  | 0.002 SOL   | a player signs for something of their own: `pay`, `pay_nft`, `buy`, `open_box` (held in the order; back on refund), `craft`, `buy_tickets`, stake, unstake, harvest, `hold`, `enter`, `bid`, `open_auction` of their NFT, `open_offer`, `sell_to_offer`, `borrow`, `open_listing`, `take_listing`, a grant claim (from the signer, never the grant's funds)                       |
| **Project** | 0.00001 SOL | the owner or authority acts as the project: `create_project`, `update_project`, `open_pool`, `upsert`, `open_farm`, `open_tree`, `set_traits`, `stash`, `move_tokens`, `collectible`, `roll`, a running hold's `release`, `open_contest`, `decide` (a verdict too), the project's `open_auction` or its call-off, and `pay`, `pay_nft`, offers and listings by the project's keys |
| **Free**    | —           | what follows from a paid step (claims, a round's pulls, auction ends, settles, refunds, repayments, closes), rolls other steps make, and the cranks: callbacks, `ask_roll`, `draw_lottery`, `run_schedule`, `prove_leaf`, `prove_traits`, writing down an overdue contest                                                                                                         |

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

An order holds its rent and the player fee, nothing more: whoever settles it pays what the settle opens or mints (Core
assets, token accounts, Sheets, stash rows, the NFT's fate), and the player settling their own order pays for their
own prizes. js/play funds the throwaway key that settles with what the settle may open or mint (`settleRent`,
`SETTLE_RENT_UNIT` a prize, a client's own figure) and takes back what it didn't spend. Each order has its own key,
named by the order, that a page which closed before the settle finds again (`recover()`): made from one signature of
the wallet's a session over a fixed text naming the project and the wallet (seed = sha256("loot settle key" |
signature | order); ed25519 signatures are deterministic), or, for a wallet that signs no messages or signs that text
differently in a later session, a random key kept in the page's storage, encrypted with a device key the page can use
but never read out (`keyStore`, `browserStore()`). A grant holds its funds, lent
to the claim's signer for what the prize opens or makes, so a grant claimant needs only the fee. The treasury is a
wallet; if its owner closes its account of a mint, the next sale reopens it.

Pass a mint writable only when its supply changes (a burn or a mint), so transactions in one token don't queue: `pay`,
`buy`, `settle` and a sale's `end_auction` when something burns; `move_tokens`, `run_schedule` when minting or
burning; `decide` when a share burns or it calls off an empty contest; `claim` when it leaves nothing owed; a minted
token prize's `pull`, and a round's close (its mints with the accounts it closes); a recipe's `Pay` lines always. The
builders do this.

### Token-2022

Every token can be SPL Token or Token-2022, in any role. Every transfer is `TransferChecked`; transfer hooks get their
accounts (never a loot signature); required memos are sent; withheld fees are swept before a close. Where loot
records an amount (a payment, a stake, a bid) it records what **arrived**; a payout receipt names what was **sent**.

Any mint is the project's (or the player's) choice, its issuer's powers with it: the program refuses only what it
could never carry out, and `xsolana_check` says what each power lets its holder do (W1, W13, W14).

| Mint feature                                                | Refused for                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confidential transfers                                      | a prize a box's roll moves (out of stock); taken in a lottery, a contest, an auction or an offer, where a holder can turn a payout or a refund away                                                                                                                |
| Non-transferable                                            | a prize from a pool or won in a box's roll (minted straight to a winner elsewhere, it is given); taken elsewhere, where nothing can be paid in                                                                                                                     |
| Default frozen, or a freeze authority that can switch it on | nothing: a lottery, a contest, an auction, an offer and a sealed schedule take it, and a player who closes their own account holds up their own part                                                                                                               |
| A permanent burn authority (and wrapped SOL)                | wherever loot would later burn from an account it holds, refused before money comes in (`BurnLocked`): a box that burns, a burned ticket or burning lottery share, burning auction and contest shares, a farm whose early exit burns, a sealed schedule that burns |
| A transfer hook                                             | prizes of a box's roll: out of stock (the oracle's answer carries no hook accounts)                                                                                                                                                                                |

In a box's roll, a prize in a mint with a transfer hook, confidential transfers or none transferable is out of stock
(its entry weighs 0), never an error.

Tokens include wrapped SOL, which a client wraps and unwraps in the same transaction; there is no other SOL path.

## Prizes

One `Prize` is what every route gives: a grant (`gives`), a lottery place, a contest's winning entries, a mission's
tier, a recipe output, a box entry (any number).

| `Prize`                     | Gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Tokens { from, amount }`   | `amount` (a number) minted (the project the mint authority) or from a pool, all of it or none: never what an account holds at the time. A jackpot that grows is a lottery's pot                                                                                                                                                                                                                                                                                            | every route                                                                                                |
| `Item(id)`                  | one collectible at `["asset", item, serial]`, or a normal item the project's backend delivers from the receipt                                                                                                                                                                                                                                                                                                                                                             | every route                                                                                                |
| `Nft { stash, nft }`        | a named NFT the project holds in a stash                                                                                                                                                                                                                                                                                                                                                                                                                                   | every route                                                                                                |
| `Roll(box_id)`              | a roll of one of the project's boxes: a waiting order for the winner                                                                                                                                                                                                                                                                                                                                                                                                       | every route; in a box only one that doesn't roll (`BadEntries`), given by `buy` (out of stock in an order) |
| `Compressed { item, tree }` | a new compressed NFT of a collectible item, minted into the project's tree (`open_tree`) in the item's collection (which carries Bubblegum's `BubblegumV2` plugin), named "<name> #<serial>", counted against supply. No rent, only Bubblegum's fee; no attributes of its own (a fresh one's traits go in the project's Sheet of it). In a box, its serial is set aside at the roll and it is minted at the settle into whichever of the project's trees the settle passes | every route                                                                                                |
| `Stash(id)`                 | an NFT of a stash, drawn by weight                                                                                                                                                                                                                                                                                                                                                                                                                                         | a box entry only                                                                                           |
| `Held(nft)`                 | an NFT in the lottery's own stash (a raffle)                                                                                                                                                                                                                                                                                                                                                                                                                               | a lottery place only                                                                                       |

Each prize given leaves `PrizeGiven`. Its accounts follow the instruction's own (`prizeAccounts`): tokens the mint,
the pool if any, the winner's account; an item, and for a collectible its collection, new address and Core; an NFT its
stash, the NFT's accounts and proof; a roll the box and the order.

**A prize that can't be given** (an item sold out, off or closed; an NFT no longer in its stash; a pool short of its
amount, a prize being all of it or none, or never opened; a mint the project can no longer mint; a compressed URI too long; a box nobody wrote):

- a route that **finishes what was decided** (a lottery place, a contest claim, a mission's end) goes on without it;
- a route a **player pays or asks for** (`buy`, `craft`, `claim_grant`) refuses (`PrizeNotCovered`); a refused grant claim keeps its round;
- an account at the wrong address for its kind is refused, never read as a missing prize;
- an NFT whose collection refuses the move fails the instruction while it refuses; the owner can take it out of the
  stash to let a lottery place or contest claim go on (not a raffle's promised NFT).

A stash shared by several routes can be emptied by one before another gives its prize. A scarce contest prize goes to
the first winning claim.

**Where a roll prize waits**: at `["order", project, winner, prizeRollNonce(n)]`, the first 8 bytes (little endian)
of `sha256("prize" | n as u64 LE)`, `n` the route's `nonce` argument plus the place or index where the route says so
(a `buy`'s `k`th roll given at `nonce + k`, `buyGives`). The sender pays the order's rent (a grant's funds, for a
grant); the winner gets it back at settle. Its player or the project's keys ask it (on a box with nothing in stock, only its player, in a later
slot, which ends it with nothing) and its player, the project's keys or the key its player named settle it, paying what the settle opens or mints.

## Boxes and the shop

**Items** (`ItemArgs`): `kind` (`Normal` or `Collectible`), `rarity`, `soulbound`, `burnable`, `name`, `uri`
(`{serial}` is replaced by each unit's serial), `max_supply`, `active`, `traits`, and for a collectible its
`collection` (one of the project's; fixed once a unit is out, `KindLocked`), which a collectible's upsert passes as its
first extra account (`BadCollection` without it): the item records whether it carries Bubblegum's plugin
(`Item.compressed`), and without it a compressed prize of the item is never there (`open_box` `SoldOut`; `buy`, a grant,
a craft `PrizeNotCovered`; a mission, a lottery or a contest gives nothing). The program keeps names and URIs of any
length; Metaplex Core and, for a compressed NFT, Bubblegum (32-byte names, 200-byte URIs) bound them. Items have no
price; boxes sell them. How long a collectible lives and how often it can be used are lines of the recipes that take
it ([Recipes](#recipes)). Lowering `max_supply` below what is out reads as sold out. Switched off, an item isn't sold,
dropped, crafted or given (the authority's `Make` still works). A **normal** item is delivered by the project's
backend from `PrizeGiven` or `OrderSettled` in a finalized transaction with `meta.err` null, once per order or
reference.

**Fresh items** (`Item.traits`): a collectible whose units differ. Each trait is a key and where its value comes
from: a table (`Values::Table`), a row drawn by weight among those in stock at the roll, kept in the order
(`Order.drawn`, its place in `Won::Item`'s `drawn`); or a range (`Values::Range { min, max }`), every number as
likely, drawn at the mint. Whoever settles, whenever, the same answer
gives the same unit. Its name and URI take the values (`{key}`, beside `{serial}`), and the traits are written on the
collectible. A key is the project's own, each once, at most 64 bytes (`MAX_TRAIT_KEY`), and an item has at most 64
traits (`MAX_ITEM_TRAITS`: each is written as its unit is minted, which one transaction must hold), else `BadItem`; the
traits lock with the rest once a unit is out. A
fresh item is given only by a box's roll (`PrizeNotCovered`: not by `Make`, `buy`, a grant or a recipe's output; a lottery
place, a contest's prize or a mission's end gives nothing in its place; an auction refuses it as a lot, `LotRefused`),
so a box that gives one is opened, never bought. It is out of stock while one of its tables is unsealed, empty or never
written (an id nothing wrote reads as out of stock, not an error, so a waiting roll isn't locked), or
while its tables don't fit what is left of the box's **table budget** (`tableBudget`: the oracle's 21 accounts less the
box's own, `callbackAccounts`, taken by its fresh items in entry order). A compressed prize is given only into the project's own tree
(`open_tree`): any other gives nothing (`PrizeNotCovered` on a strict route).

**Tables** (`upsert` `Def::Table`, `["table", project, id]`): rows of a weight, a stock (`NO_LIMIT`, 4,294,967,295,
for none) and a payload (a number, the row's own; or a label of up to 32 bytes), posted in batches and sealed. From the
seal its weights never change and its stock only goes down, so an order that drew from it, or a page that shows its
odds, can't be changed under; only a sealed table is drawn from. Rows are bounded by an account's 10 MiB (some
250,000 labels or 1.3 million numbers).

**The shop.** A box of one entry with nothing random in it and no subject (a shop item, a bundle or a fixed pack of
any number of draws) sells in one `buy`, `count` of it at once: each sale at the price the one before it left (after
`fall`), all within one `max_price`, each counted against the wallet's limit; the price split at once (a `Burn` share
burning its part); the entry's prizes given once for each draw of each sale, a fixed amount of tokens in one payment
of all of it (`buyGives`); no order, no oracle. Its `Bought` receipt is logged before the prizes' `PrizeGiven`s. The
box's gate, window and limits apply. The same box can still be opened with `open_box`, which asks the oracle as for
any box and waits for its answer (and pays its fee): sell such a box with `buy`.

**Entries** (`DropEntry { prizes, weight }`): any number of prizes. No prize is "nothing" (the payment still
splits). A box burns its payment, or part of it, with a `Burn` share. An entry can be given while it can give every
prize it names, all together (an item in supply, two of it needing two left; for a fresh one its tables sealed, not empty
and within the box's table budget; a stash that holds an NFT; a pool that holds all of its amount; tokens in a mint the
roll can move and settle can pay). It names a pool once, a stash's random NFT beside nothing else of that stash, and a
named NFT once (`BadEntries` at its write). A draw is on the written weights; only `stock_odds` scales a weight, by the
share of its first item's supply left.

**When an entry runs out** (`LootBox.when_out`, `WhenOut`, written with the box; an edit of it bumps the version), the
project chooses, and players see which:

- `StopSales` (the default): `open_box` is refused (`SoldOut`) unless every entry can be given as many times as this
  purchase could draw it plus every draw of purchases still waiting for their answer (`LootBox.in_flight`; each order
  counts its draws in `Order.reserved` until its answer or its refund). Entries are grouped by the account they take
  from (an item, a pool whatever amount each takes, a stash's random NFTs, a named NFT): each group must hold the most
  any entry of it takes in one draw, times the draws (an item its units left, a pool its tokens, a stash its NFTs, a
  named NFT once). Such a box can't list a stash's NFT at random beside one of that stash's NFTs by name (`BadEntries`:
  a random draw could take the named one); that box is `DrawLeft`. An entry whose weight follows its item's stock
  (`stock_odds`) needs no cover, nor one weighing nothing now. So every roll of a purchase is on the odds written, and
  nobody can buy a refund on every miss once a common entry is gone. An entry emptied all the same by another route
  (another box or a prize roll sharing its pool, item or stash; the project's keys) makes no draw and gives back its
  worth. The project restocks or edits the box to sell again. A roll made elsewhere (a prize, a mission) isn't counted
  and isn't stopped. In practice: a named NFT can be in one waiting purchase at a time; a slot that can draw a named NFT
  more than once (not `distinct`) never sells; a pool holds its prize for every draw waiting.
- `DrawLeft`: the box sells while its first slot has an entry in stock, and a roll draws among the entries still there,
  by their written weights: the others' odds rise as one runs out, so a player can empty a common entry to make a rare
  one likelier. A box selling a rare prize keeps `StopSales`.

The answer (`callback_roll`) takes the order's draws out of `in_flight`, so its box is written (the request marks it
writable); a `refund` of an order whose `reserved` is above 0 names the box (`refundIx` passes it), and an edit that
bumps the version puts `in_flight` back to 0.
Every box opened asks the oracle. A box rolls (`boxRolls`) when it has more than one entry or a `Stash` prize; one
that doesn't also sells with `buy` (but a box with a fresh item is only opened, `boxFresh`). A `Prize::Roll` is
refused in a box that rolls (`BadEntries`: one oracle answer can't serve a second roll). Entries are named in two
bytes; a box holds at most 128, each at most 14 prizes, and is bounded before that by what its oracle answer reads (21
accounts: [Limits](#limits)).

**Packs** (`LootBox.slots`, `open_box`'s `count`): what one open draws is its slots, each `Slot { count, only,
distinct }` drawing `count` entries among those `only` names (all, when it names none), no entry twice with
`distinct`; no slots is one draw among every entry. A pack of 5, a guaranteed rare (four draws among all, one among
the rares), a hand of different cards. A purchase of `count` opens is paid together, counted against a wallet's limit
once each, and drawn from one oracle answer, each draw at its own path in the answer, weighted by the odds the
purchase fixed and reading the stock the draws before it left. Answers are never shared between players. A draw that
lands on an entry that can't be given then (under `DrawLeft` it has no weight; under `StopSales`, emptied by another
route) isn't made: no other entry takes its place, and it is given back at the settle for what its slot is worth
(`Order::back`, `Slot.share`). A free roll (paid 0: a prize, a recipe's output, a mission's chest) never loses draws to
what it emptied itself: an entry the roll's own draws took the last of weighs 0 for its later draws, under either
`when_out`; one already gone before the answer keeps its weight (a draw on it misses, and a roll that drew nothing
waits to be asked again), so emptying a shared source before asking can't steer a roll. A box of one entry packs too, through the
oracle as any other (one with nothing random in it also sells in one step with `buy`). A pack has no NFT rolled on
(`BadEntries`). Measured
on 0.22: a card costs the oracle's callback 2,600 to 3,700 compute units at 2 to 16 entries, so one answer draws
about 66 to 106 cards.

**Stashes.** The owner or authority puts NFTs of any kind in, each with a weight (`stash`'s `weight`; soulbound ones
can't move), and takes them out to any wallet, never to a loot account (`ToTheProject`); "out" to the project's own
address only drops it from the table. A `Stash` prize draws by weight from the oracle's answer and takes the NFT out at
once (the last row takes its place), so two winners never get the same one. A draw that lands on an empty stash isn't made, and gives back its worth; a box of
only empty stashes sells nothing (`SoldOut`). Rarity tiers are weights in one stash, or several stashes with their
entries' weights; a stash of one NFT raffles it. A stash's draw costs the callback about 25,000 compute units at ten
NFTs and 33,000 at 290,000 (0.22).

**Prizes are set aside at the roll.** A prize the roll couldn't give is **out of stock**, at the
purchase, the ask and the answer alike, never an error: a fixed amount its pool doesn't cover, a minted source the
project no longer mints, tokens in a mint with a transfer hook, confidential transfers or that nobody can transfer,
a mint whose mint and vault aren't passed, an unsealed or empty table, a fresh item whose tables don't fit the table
budget, a `Prize::Roll`. A box with no entry in
stock sells nothing (`SoldOut`). The roll sets each prize of each drawn entry aside in the order (`Order.won`:
`Won::Item { item, serial, drawn }`, `drawn` the place of the rows a fresh item's table traits drew; tokens moved into
the vault; an NFT out of its stash with its weight; a compressed item's serial). Two winners rolled before either
settles are both paid. **A draw is on the written weights** (with `DrawLeft`, among the entries still in stock), so the
buyer of a box that stops selling rolls on the odds they saw. An entry drawn that can't be given then (its item's last
unit gone, its pool short of its amount, its stash's NFT taken, by another route) makes no draw: no other entry takes its place, and that draw is given back at the settle for what its slot is
worth (`Order::back`). With no draw made at all, an order paid for (a purchase, an auction's roll lot) is `Failed` and
refunded, and a free one goes back to `Waiting`, to be asked again or ended by its player's ask when nothing is left.
Tokens sent into a pool change nothing about a roll: an entry needs its whole amount there. `settle` hands each over. If a won NFT's collection starts refusing
the move, the player settling their own order may pass its stash instead: it goes back, with its weight, while the
rest settles.

**Compressed items in a box** (`Prize::Compressed` in an entry): a plain one costs no rent; a fresh one's traits go
in the project's Sheet of it, whoever settles paying that rent. A soulbound item, or
one whose URI could outgrow Bubblegum's 200 bytes with its values in it, is out of the box's table. The collection
must carry Bubblegum's plugin: a settle into one without it fails, and a rolled order waits until it has it.

**Roll accounts.** Every write that names a box to roll later (`upsert` of a box, a recipe, a grant or a lottery;
`open_auction` of a roll lot; `open_contest` with a roll prize; `open_farm` for its tiers' rolls and roll prizes) and
every route that makes a roll (a craft's `Prize::Roll` or `RollOn`, a `buy` bundle's roll, a grant claim) passes only
the box, one account each (`boxesAccounts`), and the order a route makes. What the box can give is read when the roll
is asked and answered. The purchase, the ask and the answer pass the box's roll accounts (`rollAccounts`, `askRollIx`
with `items`): each entry's prizes' (an item, then a fresh item's trait tables while they fit the box's table budget;
a pool; a stash), then each distinct mint first named and the project's vault for it (a pool's mint read from the
pool; a pool not opened adds nothing). A route that makes a roll and asks it in the same transaction (js/play's
rolling routes do) fails whole on a box with nothing in stock (`SoldOut`), so the player keeps what the route would
take.

**Settling in parts.** An order is made at its smallest and grown at the purchase to all its box can set aside
(`Order::space_for`, `orderBytes`), and for a box that gives items 4 bytes more for each table row a draw may carry
(the box's table budget, for each draw of each open), so it settles, in as many parts as the chain needs,
paying what each part opens or mints: each `settle` carries out the prizes from where the last part stopped
(`Order.settled`) up to `upto`, and writes its receipt (`OrderPartSettled`) before it mints, so a log Solana cuts at
10 KB keeps it. The first call splits the payment, its shares' accounts and their hook tail with it (`upto` 0 splits
and gives no prize, accepted only before the split: sent first when a prize can't land yet, a winner's account its
issuer froze, so the shares are paid); the last part (`upto` past the end, `SETTLE_LAST` = u32::MAX: `OrderSettled`)
carries out the NFT rolled on that the project holds, pays the undrawn draws' share back, gives whatever prizes are left
(maybe none) and closes the order. An NFT rolled on that the project doesn't hold has its numbers moved by the first
call, its accounts (and its Sheet) with it. A part before the last (`upto` at most the end) gives prizes with a
stand-in piece. The order's own player may give up tokens or a collectible they can't receive (`settleIx`'s `giveUp`:
the project's vault, or the item, in the receiver's place): tokens given up stay in the vault, and `PrizeForgone` says
which.
`OrderPartSettled` carries `amount` and `treasury_remainder` when it split; in a settle of several parts the last's
`OrderSettled` has them 0. A compressed prize's item account is written; one of an item whose collection lacks
Bubblegum's plugin mints nothing, so the next one's Sheet is at the tree's count one less (`wonAccounts`' `unminted`). A transaction's instruction trace (64 calls) binds
first: measured on 0.22, one settle mints about 14 Core cards, 10 compressed or 8 fresh compressed (`settlePartEnd`,
`settleParts`); then 64 accounts and 1,232 bytes: js/play's `openBox` sends prizes in parts, each shrunk until it fits,
then the last part, from a throwaway key the open's one prompt funded with each settle's fee and what it may open or
mint (`settleRent`); the key settles only once a dry run says it lands (else the wallet settles), and its last settle
sends back all it holds.

**An order's size** is what it can hold (`orderBytes`): at `open_box`, each draw at its dearest entry's prizes as the
`Won` they become (an item 14 bytes, tokens or an NFT 41, a roll none) and 4 bytes for each table row its fresh items
draw now (`entryRows`, `orderBytes(box, shares, opens, items)`; `Order::sized`): a plain 3-entry box is 252 bytes, a
5-card pack of a 10-item box 308. A roll made inside another call (a craft, a grant's claim, a mission, a roll lot)
reads no item, so it keeps the box's whole table budget a draw (`orderBytes` without `items`; `Order::space_for`), as
does the write's check against 10,240 bytes (`MAX_ORDER_BYTES`, `BadEntries`). An item given more table traits after a
purchase (possible while none of it is issued) is out of stock for that order. **A pack's draws must fit one oracle
answer** (`drawsFit`, the program's `draws_fit`: each draw at the least it could cost, with the pairs of entries a roll
of several draws compares first): a box whose one open doesn't is refused at its upsert, and a purchase of several opens
that don't at `open_box` (`PackTooLarge`). The answer's heap counts the box's own bytes too (its odds, gate, shares,
subject, slots and fates: `boxBytes`, the program's `box_bytes`). A box that doesn't roll sells by `buy` when one
transaction carries the whole purchase (`buyFits`, the program's `buy_fits`: 64 accounts, 64 instructions, 1,400,000
compute units), else through the oracle with its heap counted; such a box can't give a roll (`PackTooLarge` at its
write). On loot 0.24: 31 draws of tokens from a pool by `buy`, 20 through the oracle; 64 of one item (past 14 no `buy`
carries them); 60 of a three-entry box of items, twelve 5-card opens of a two-entry one. js/play cuts a purchase into orders of `opensAnOrder(box)` opens (that, and an order's rent and fee within
0.01 SOL), all in its one transaction. Every entry must be one some slot draws (`BadEntries`), and `open_box` is
refused when none of the first slot's entries is in stock (`SoldOut`): the roll could only refund.

**Prices** are in the box's `currency`. `rise { step, growth_bps }` lifts the price after each sale (rounded down: a
10% rise on a price of 9 base units adds nothing). `fall { step, every, floor, since, shared }` lowers it with time
to a floor (0 can reach free). `max_price` protects the buyer; `version` covers only what the roll reads, so a moving
price never breaks a purchase. A price of 0 is a free box: the player still pays the fee (and an opened box's order
rent, which comes back when it closes).

**Window and limits**: `window { opens_at, closes_at }` (0 is no bound; `NotOpenYet`, `WindowClosed`) and
`per_wallet { total, per_window, window }` in the buyer's counts; a refund gives its count back. `active` stops sales.
**Odds**: entries raised for a player who shows a collectible (or whose profile says so), fixed in the order at
purchase.

**Edits.** An edit of entries, slots, odds, `stock_odds`, `when_out`, `subject` or `fates` bumps the version, and fails an order that
holds a payment (a waiting purchase, an auction's roll lot, whose order holds the winning bid), which refunds what it
paid at once. Any other roll (a lottery place, a chest, a recipe, a grant) holds nothing to refund, since what it was won
or bought with is spent: it rolls on the box as it is now, so an edit never loses it, its asker paying for the room the
edited box needs. Other edits (price, shares, switch, window, gate) leave orders alone. A refund keeps the price rise its
purchase applied until the owner's next edit.

**Order lifecycle** (`OrderStatus`): `Pending` (opened, roll asked), `Rolled`, `Failed`, `Waiting` (made by another
route, not yet asked), `Asked`. Every order receipt carries `requested_slot`, naming the purchase at a reusable
address. An order never settles or closes in its opening slot (`SameSlot`), and once asked, a roll is asked again only
in a later slot than its last ask (`SameSlot`: never the same seed twice; `rollAskable`). A failed roll refunds from the next slot; a purchase whose roll
never arrives refunds after 10 minutes (`STALE_SECONDS`, from `Order.asked_at`); an `Asked` order holding a payment or an NFT
refunds 7 days after its first ask (`LOTTERY_TIMEOUT_SECONDS`, from `Order.first_asked_at`), the oracle silent all that time.
A rolled order is settled by its player, the project's keys or the key its player named, never refunded
(`BadOrderState`). A free roll with no draw made goes back to `Waiting`.

## A roll on an NFT

A box with a `subject` (a rule) rolls on an NFT that passes it: one a player brings to `open_box`, one leaving a
mission (a tier's `roll`), or one a recipe keeps (`Output::RollOn`). Its `fates` (`Fate { entry, shifts, then }`, one
an entry) say what each entry does:

- `shifts`: numbers moved (`Shift { key, by, most, from_now }`), never below 0 nor above `most` when raising;
  with `from_now` a time moved from now, at most `most` seconds ahead (a day in jail). Written on the NFT where the
  project may, otherwise its Sheet.
- `then` (`Option<Spend>`): `None` back to its player; `Some(Burn)` (Core by Core, rent to the settler; others to the
  incinerator); `Some(Give(wallet))`; `Some(Stash(id))` (a trade-in becomes another player's prize).

A box whose every entry burns, gives or stashes the NFT takes it as its price.

- **Custody follows the fates.** A box that can burn, give or move the numbers of an NFT that can move takes it into
  the project's hands when the roll is made, so nobody sells it after seeing a bad roll; a refund sends it home. A
  soulbound NFT is rolled where it is.
- **One roll at a time on an NFT.** Such a roll is at the NFT's own nonce (`nonceOn`: the first 8 bytes of its address,
  little endian; `SubjectNonce` otherwise), so a second waits for the first, and rules read what the last roll wrote.
  An NFT frozen on a farm seat is refused. A craft's `RollOn` and a mission's roll name a nonce and are made at
  `namedRollNonce`: the NFT's own on a box that holds it, whatever was named; otherwise `prizeRollNonce` of the named
  one (a mission of several names seat `i`'s roll `nonce + 2i`, its prize's `nonce + 2i + 1`). A roll already at that
  address makes `unstake_nft` fail (the System program's "already in use"), so the last one is asked (its player or the project's keys, while its
  box has something in stock; its player always, in a later slot), answered and settled first, in transactions of
  their own (js/play's `unstakeNft` says so; `claims()` lists the step).
- **What was rolled stays rolled**: the fate is copied into the order at the roll.
- `settle`, `refund` and `end_auction` pass their remaining accounts to the NFT's move, so a Core collection's transfer
  checks find what they read.

**Rolls that wait.** Missions, recipes and prizes make a `Waiting` order (the player's rent, or a prize maker's, back
at settle). Its player or the project's keys ask (`ask_roll`, paying the oracle) while its box has an entry in stock; on a box with nothing in
stock only the order's player asks, in a later slot than its `requested_slot` (`SoldOut` otherwise), so nobody else
can land a winner's roll on an empty box; the player's own ask there ends the roll at once, with no oracle: rolled
with nothing (settle sends an NFT it holds home as it was), or failed for its refund when its winner paid for it (an
auction's roll lot). Its player, the key the player named (`settler`) or the project's keys settle. A waiting roll is never refunded, nor an asked one that holds nothing; one unanswered within `STALE_SECONDS` is
asked again by them, and the first answer to any request rolls it. A free roll whose answer makes no draw goes back to
`Waiting` (not rolled): they ask it again, or its player ends it so on an empty box. It fails at its ask, giving back what
it holds, if its answer can't carry the box's own accounts, or if it holds a payment and its box was edited since. A
box only missions, recipes or prizes roll is left switched off; such orders ignore the switch and window.

- **A mission's roll** needs an NFT farm and a tier with a lock (`BadFarm`). Leaving after the lock, an NFT that fits
  the subject is rolled; one that doesn't goes home unrolled. Growth stops at the lock's end.
- **A recipe's roll** on a kept NFT needs a Core asset where the box takes custody or moves numbers on it (`NeedsCustody`:
  a Token Metadata or compressed NFT can't be held until it settles, and could leave before the roll lands). A box with a subject rolled on nothing
  gives its entries without fates.

A `pay`'s `reference` is only a label, and `roll` keeps no per-request record: apps deduplicate their own effects, or
use orders, contests, lotteries or grants when the program must enforce one payout.

## The owner's records

`upsert(Some(def))` writes one record; `upsert(None)` closes the one at `target`. `Def` names the kind and id, and the
address follows, so no kind or project is ever written over another. **An edit is the whole record** (a gate or odds
left out is gone) and keeps what the record has done (units out, runs, rounds, counts). Writes leave `RecordWritten`,
closes `RecordClosed`. A record closes only when nothing pending depends on it, rent to the owner, and counts from 0 if
written again.

| Record      | Closes                                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Item        | only while none was ever handed out                                                                                                                                                                                                                                                  |
| Schedule    | any time; a sealed one never                                                                                                                                                                                                                                                         |
| Lottery     | with nothing sold and nothing pending: every pot it opened (`Lottery::pots`) swept where the owner says and closed (`closeRecordIx` passes the mint, where they go, both token programs and each pot by id; none for a lottery that opened none). Mints are fixed for an incarnation |
| Grant       | any time, unused SOL to the owner; written again it is a new campaign that refuses old vouchers                                                                                                                                                                                      |
| Box, Recipe | never: a version must never come back at the same address                                                                                                                                                                                                                            |
| Table       | never; sealed, its weights never change and its stock only goes down                                                                                                                                                                                                                 |

## Schedules

Every `every` seconds, one run of its `action` (`{ from, to, amount, halve_every }`): the move `move_tokens` makes,
from a pool or a mint the project controls, fixed or a share of the pool, halving every N runs if asked. It starts no
earlier than now. **A run missed is missed**: a `run_schedule` pays once, for the latest run due, its amount or its share of
what is held then, and the runs before it lapse; `upto` has no effect on it. So sending it on time is the project's to see
to, and no amount nobody meant goes out later. Only a sealed schedule's fixed amount (`scheduleCatchesUp`) pays every run due,
up to `upto` runs made (the client passes the runs it has plus those due, `runsDue`) and a step cap a call, in one transfer and
one `ScheduleRan` (`from`, `run`). It stops after `max_runs`. A move that can't
be made fails the call. A schedule that moves a pool into itself is refused when written.

**Sealed** (`TokenSource::Vest(mint)`): it pays from its own vault `["vest", schedule]`, opened when written and funded
by anyone at any time. Nothing else pays out of it, and it is written once (`Sealed`). It must be on, have a last run
(`max_runs` above 0) whose time fits a date (any number of runs, however far: its last run pays all the vault holds in
the call it is due), no share above the whole vault, and a destination every run can always pay: a burn (not wrapped
SOL), a wallet this program doesn't own (a person's key, a multisig's vault; `upsert` passes the wallet itself after
the vault's four accounts, `BadMove` when this program owns it), or the treasury; never a pool, a token account (a pot,
a farm's vault), a collectible's holder or a chosen share (`BadMove`). A stream into a pool, a pot or a farm is an
ordinary schedule. Its mint is the project's choice, its issuer's powers with it (a permanent delegate, a fee raised
to 100%, a freeze: a vest is only as safe as its token, W1); only a schedule that burns refuses a mint whose issuer
keeps a burn authority (`BurnLocked`). A payee at an address of this program that has no record yet is warned of: a
record made there later would make every run pass it over (W21). A run never pays more than the vault holds; the last pays all, and later deposits go to
the same place. Pause and suspend stop none of it. A cliff is a first run in the future; a timelock is one run.

## Lotteries

`LotteryArgs { terms, every, gate, per_wallet }`, its `terms` a `LotteryTerms { price, mint, pays_from, shares, places,
ticket_mint, draws_at, nft_ticket, returns, min_sold, closes_before, time_weighted }` (`withDefaults` takes them beside
`every` too, fills `closes_before` 0, `time_weighted` false and each place's `when_short` `InOrder`, and refuses terms
without `pays_from`: it has no default). Tickets are paid in `ticket_mint` (burned) when it is set, else in `mint`
(`paymentMint(terms)`).

**Where the places are paid from** (`pays_from`, `PaysFrom`):

- `{ Round: { rest } }`: each place takes its `bps` of this round's own ticket money only (its part after the shares,
  `to_pot`), which nothing from outside can change; what the places leave (and the part of places nobody won) goes to
  `rest`: `Treasury`, a `Wallet`, a `Holder`, another program's `Account`, or `Burn` (it then stays in the round's account
  for its close to burn, and is no part owed). Never a `Chosen` share (`BadLottery`) or one of the lottery's pots
  (`SameAccount`); a pool or another lottery's pot named there fills when the leftover is pulled. Such a lottery opens
  no pot. A no-loss one may be one: its places then take no money and give their prizes.
- `{ Pot: [id] }`: a pot kept from round to round at `["pot", lottery, id]` (`pda.lotteryPot`, `id` below `MAX_POTS`,
  16). Each place takes its `bps` of what the pot holds at the ask with the round's part, so a seed, a sponsor, yield
  and what earlier rounds left all count; what the places leave goes back into it. The ask that needs it first moves in
  what the round before left that pot (`Lottery::owing`, the last round paid from a pot that may still owe it), from
  that round's own account, so a prize never depends on who pulled the round before or when: `drawLotteryIx` takes that
  round's record as `owing` (its terms name its pot; gone, any account stands in). While that round waits for the
  oracle, the next ask from a pot is refused (`NotDue`).

A lottery may move to another pot between rounds by an edit: `upsert` opens the pot the terms name when it isn't open
(`upsertIx` passes it; for a lottery paid from its rounds, pot 0's address stands in), and `Lottery::pots` keeps a bit
for each pot opened (`lotteryPots`). No share pays into any of them (`SameAccount`).
The lottery keeps its terms, its incarnation and its round number; each **round is a record of its own**,
`["round", lottery, incarnation, round]` (`decodeRound`), opened by its first purchase, which copies the terms (its
`terms` and `revision`; later purchases name the round's `revision`; the gate and `per_wallet` are read live). The round holds its money in token accounts of its own, `["round-tokens", round, mint]`, so a cancel
moves nothing and a pot holds only what nobody is owed. A draw may be as far off as a date holds (a time written in
milliseconds holds its buyers' money until then: `xsolana_check` says a far date in words); a repeating lottery whose
next date would be past what a date holds makes that round its last. **Sales close** `closes_before` seconds before
the draw (the round's copy of the term; 0: until the draw), so every ticket is held at least that long; a purchase
inside the window fails (`SalesClosed`); below 0, or as long as a repeating lottery's `every`, is refused
(`BadLottery`). **Ending a lottery** is one edit: `every = 0` on a running lottery draws the round it is at
(`Lottery.last`) and then ends; switching back to repeating waits until that round is drawn (`RoundRunning`). The
round a close, a re-make or a lottery-stash move waits on is `last`.
SOL sent to the lottery account beyond its rent (`roundRent` in a spec, on by default) pays each round's header and
token accounts, lent to the round and back to the lottery at its close (`LotteryRound.opener` and each `Opened.by` then
name the lottery; a close passes the lottery, or the project's owner once it is closed: `pullIx`'s `lotteryClosed`);
with too little, the round's first buyer (or its asker) fronts them, back to them at the close. In a round the lottery
opened, its spare SOL pays each entry's bytes too while it covers them (`LotteryRound.lent`, back to the lottery with
the header's rent), so a buyer pays only the fee and the price; the tools size `roundRent` from the spec's
`expect: { rounds, entries }`.

**A purchase** appends an entry (`entryWidth(fee, nft, weighted)`): its buyer, where its tickets end, what arrived (a fee
mint, a share the buyer chooses, or always in a weighted round of paid tickets), where its weight ends (16 bytes, a
weighted round only), its NFT ticket. **Tickets weighed by time** (`time_weighted`, off by default; only a lottery that
`returns` its tickets, `BadLottery` otherwise; an NFT ticket's too): a purchase of `count` tickets at `now` weighs
`count × (draws_at − closes_before − now)` seconds, by the round's own copy of the terms, so the last ticket sold weighs
1 and none weighs 0. The round's `weight` (an `Option<u128>`, after `sold`) is their sum; its header is 10 bytes longer
than before, a weighted one 26, and `first` is a `u128`. Place `k` sits at `first + k × (total / winners)`, `total` the
weight in a weighted round, and its winner is the entry whose slice holds that point, so a buyer holding long may win
more than one place; `winners`, `min_sold` and `per_wallet` still count tickets. An entry's tickets are its word's end
less the entry before's (or `TicketsBought.count`), never its slice; `TicketsBought.weight` says what a purchase
weighed, and a client shows a buyer what theirs would weigh, and their share of the round's weight, before they buy. A share the buyer chooses (`To::Chosen`: a referrer, a collectible's
holder; the treasury with no choice) is paid at once from the buyer's own account, its destination's accounts after the
gate's (`buyTicketsIx` takes `holders` and `treasury`); every other share is split at the purchase and paid in common
after the draw. Unless the lottery's spare SOL pays them (above), the buyer pays its bytes (not refunded: they go to
the treasury at the close). A round holds about
70,000 to 260,000 purchases, by its entries' width.

**Draw.** Anyone sends `draw_lottery` once due. Places are runs: `{ bps, prize, when_short, times }`, `times` places
alike (a named NFT is one place's; a run of rolls gives each place its own roll; at most 64 runs, `MAX_LOTTERY_RUNS`,
`BadLottery`), drawn by evenly spaced points with rejection sampling (in a weighted round, points of its weight). A round
nobody bought into has no record: a repeating one moves its date, one that draws once ends. **The first ask fixes the
round's money** before anyone knows who won: paid from a pot, what the round before left it moves in, then what its
places take of the pot moves into the round's own account (or what the round's ticket money leaves over is owed to the
pot, `pot_owed`); paid from its own money, what its places leave is owed to `rest`; each run of pool prizes moves in (a
minted run is minted at its pull; while the project is not that mint's authority, only the place's winner or the
project's keys pass it over, for nothing, and anyone else's pull waits, `PrizeNotCovered`). **A pool is read once**,
when the draw is asked, and the project can spend it until then: when it holds less than all its places with a winner
win, each place gets what its run's `when_short` says (the same for every run of one pool, `BadLottery` otherwise):
`InOrder` (the default) fills places first to last, whole prizes only, the rest getting nothing; `InProportion` gives
every place its prize times what the pool held over what its places win, rounded down; `Nothing` pays no place of it.
Prizes of 1,000, 500 and 500 from a pool holding 1,700 give 1,000, 500 and 0 in order, 850, 425 and 425 in proportion,
or nothing. The lottery moves on, its next round selling at once (`drawLotteryIx` passes,
for a round paid from a pot, the pot, its mint and the round's account of it, then with `lottery.owing` set that round,
its account of the mint and its pot; then each token run's mint, and for a pool the pool and the round's account;
a source that is frozen, paused, closed, or with `skip_hooked` hooked gives this round nothing). The lottery's own
account goes with its current round only. An unanswered draw is asked again after `STALE_SECONDS`, naming the waiting
round by its address (`roundAddress`) and no lottery (so a lottery closed since never strands it); the next ask after **7 days
from its first ask** cancels it (`lotteryCancellable`), every entry refunded and what the ask moved in owed back. A
short round (`min_sold`) is cancelled at its first ask. The program takes the cancelling ask and a pull in one
transaction: js/play's claim of such an ask pulls the sender's own refund right after it (the close too, when that is
all the round owes), so a refund is two transactions, the ticket and the cancel. A purchase in a round whose draw is
due sends the draw first, in the same transaction, and buys into the next round.

**Then each part is pulled** (`pull(entry, part, nonce)`, anyone, in any order): an entry's own (`Own`: a refund, a
no-loss ticket's price, its NFT ticket back or where its price sends it), all of its places in a run at once
(`Pot(run)`: their part of the pot; `Prize(run)`: their prize), or a part owed in common (`Common(i)`: share `i` once
drawn, past the shares what the places leave, to the pot or to `rest` (`leftoverTo`; never owed when `rest` burns),
past that after a cancel each pool's prize back to its pool; `commonOwed`). A place's prize is given at its pull: tokens into the buyer's account; an item, a compressed NFT, a project stash's NFT while it holds it (a named one gone from its stash refuses a stranger's pull, `PrizeNotCovered`: the winner or a project key passes it over); a roll at `prizeRollNonce(nonce + place)` (`pullRolls`; js/play asks for it in
the pull's own transaction); the lottery's own stash's NFTs are taken out for every place up to the entry's last, in
place order, whoever pulls first (`LotteryRound::assign`, `stashNfts` says which NFT each place gets; a pull with the
stash alone only takes them out). An owed NFT passed as its hold's address `["hold", nft, 0]` in place of its piece
becomes a hold for its winner (`pullIx`'s `hold`). A part owed in common that nobody can take (a pool never opened, the
pot closed since or made again in another mint, a collectible nobody holds) goes to the treasury (`toTreasury`). Each part waits under its own bit,
holding up nobody else; the pull that leaves nothing owed closes the round when it carries the close's accounts,
burning what nobody is owed and returning each account's rent to whoever fronted it; a round that owes nothing is
closed by any pull.

**Variants:**

- **Raffle**: draws once; a place gives `Prize::Held(nft)` from the lottery's own stash, or `Prize::Raffled` (a run of
  places, each an NFT drawn at random from it), never both. The stash is filled with `stash` (`StashOf::Lottery`, several
  NFTs a call, `stashBatches` splits a long list); the write refuses an NFT not there or fewer NFTs than raffled places
  (`NotInStash`), and more than 256 places of its own stash, raffled or named (`BadLottery`: the oracle's answer loads
  the round on the default 32 KiB heap, where the list of their NFTs fits up to 256). A pull takes out at most 64 of
  their NFTs (`pullAssigns`) and stops at a place whose NFT is not out yet: pull again until every place has its own. An
  NFT ticket's rule holds at most 170 "one of" texts (`BadLottery`): the oracle's answer reads it. A run of places given
  one by one (an NFT, a compressed NFT, a raffled one, a roll: anything but tokens) holds at most `MAX_RUN_PLACES`
  (4,096; `BadLottery`): more is several runs; a run of rolls takes two accounts a place, as many as a pull carries
  (`prize.most`). Nothing comes out but a place's prize while the lottery runs, nor once it has ended while its last
  round (`Lottery.last`) still owes NFTs of it (`Promised`): its close, write again and stash moves name that round
  then (`idleRound`).
- **Least sale** (`min_sold`): a due round that sold fewer is cancelled at its draw, no oracle, everyone refunded.
- **Free tickets** (`price` 0): only the player fee; `per_wallet` keeps one wallet from most tickets.
- **NFT ticket** (`nft_ticket: { rule, then }`): one ticket for one NFT (`OneTicket`), held until the draw, then
  burned, given or stashed by its pull; home if cancelled. No price, shares or ticket mint.
- **No-loss** (`returns`): after the draw every ticket is owed back whole; winners take only what was paid into the pot,
  and their prizes. Paid from its rounds' own money, its places take no money: they give their prizes. Give it a sales
  close (`closes_before`): otherwise tickets bought seconds before the draw have the same chance as tickets held all
  period, and their price comes back. Or weigh its tickets by time.
- **Sales close** (`closes_before`): sales close that many seconds before the draw (`SalesClosed`, `salesCloseAt`).
- **Weighed by time** (`time_weighted`, a no-loss lottery only): a purchase of `count` tickets weighs `count` times the
  seconds from it to the close of sales (`TicketsBought.weight`, `ticketWeight`, `purchaseOdds`), and a place is won by
  weight: an entry's slice of the draw is its weight's (`decodeRound`'s `start`, `end`), its tickets `tickets`.

Pot and payment mints may be any token (one with confidential transfers, one whose new accounts start frozen or can be
made to, one nobody can transfer, whose first paid ticket fails): a player who turns plain transfers into their own
account off holds up only their own part, but the round can't close meanwhile and its rent waits (keep spare SOL in
the lottery), and a pot or pool in a token that can't reach the round gives that round nothing. At
most 8 shares (`MAX_SHARES`, as every split kept to be paid later) and 8 mints. Edits apply to the next round (the gate and `per_wallet` at once); closing or making a
draw-once lottery again, an edit of an ended one, or one making it repeat, waits while its current round has a record,
or once ended while its last round still owes NFTs of its own stash (`RoundRunning`). Writing `every` 0 on a running
lottery ends it after its current round (`Lottery.last`). `per_wallet` counts tickets per
round in the wallet's counts.

## Recipes

`RecipeArgs { active, inputs, outputs, needs, keeps, raises, window, per_wallet }`: any number of lines in and out,
as many as one transaction carries, all or nothing; up to 255 collectibles a craft (a byte names each one's place).
Recipes that give only fixed token amounts can be crafted many `times` at once.

| `Input`                      | Takes                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Burn { item, count }`       | collectibles of an item, burned                                                                                                                                                                                                  |
| `Use(item)`                  | one collectible, kept (its life and uses are the recipe's needs and raises); one boosting the player's token seat passes that seat `["seat", farm, player]` and the farm after it (`craftIx`'s `{ asset, farm, booster: true }`) |
| `Pay { mint, amount, to }`   | tokens burned or sent                                                                                                                                                                                                            |
| `Show { collection }`        | any NFT of a collection the player holds, kept                                                                                                                                                                                   |
| `Staked { item, farm }`      | a collectible on its own seat in that farm (`NotFarmed` elsewhere, and for a token seat's booster)                                                                                                                               |
| `Trade { collection, then }` | any NFT of a collection: burned, given or stashed                                                                                                                                                                                |

Outputs: `Output::Prize`, all of each or refused (`PrizeNotCovered`); or `Output::RollOn` (a roll on a kept
collectible). `needs` (`Need { place, key, test }`: the attribute under `key` on a collectible handed in, or on the
player's profile, passes `test`, a rule's `Test` ([below](#rules-gates-odds-and-boosts)); `NeedNotMet`), `keeps`
(attributes passed to a new collectible), `raises` (`Raise { place, shift: Shift { key, by, most, from_now } }`: up to
`most`, `MaxedOut` when there; `by` below 0 lowers it, never below 0; with `from_now` a time, fuel for a day more). A
raise on a `Staked` collectible must move its farm's lock key (`BadRecipe`). A `Show`n NFT the project locks in the
player's wallet on a seat of a farm that freezes (not a soulbound Core asset), with a raise lowering a number on it,
passes its seat and farm after its accounts (`craftIx`'s `farm` on it), and the raise may not lower what that farm reads.

An item's **life** is lines of the recipes that take it (the economy tools write them into each such recipe), read
and written on the collectible (`made` is written at its mint; `used`, `next_use` and the like are the project's own
keys, which a `Set` may write or remove):

| Life                    | Lines                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| ready after `x` seconds | `Need { key: "made", test: Older(x) }`                                                                   |
| lasts `x`               | `Need { key: "made", test: Within(x) }`                                                                  |
| `n` uses                | `Raise { key: "used", by: 1, most: n }` (`MaxedOut` past it)                                             |
| a cooldown of `x`       | `Need { key: "next_use", test: Passed }` and `Raise { key: "next_use", by: x, most: x, from_now: true }` |
| renewed                 | `Raise { key: "used", by: -i32::MAX }` (stops at 0)                                                      |

A life can change with the recipe, units out or not. A collectible on its own escrow seat can be used in place (refuel
a ship on a mission) but not burned or rolled away (`AlreadyStaked`). A need or a raise at `PROFILE_PLACE` (255) reads or
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
fixed at `open_contest` for good. `result_by` may be any time (after `closes_at` when there are deciders; a far one
holds the stakes until then: `xsolana_check` says its date in words). Whoever names the winner can also enter it; the
pot is paid only by a claim. A prize to each winning entry with no fixed stake and no gate pays one person with many
wallets once a wallet (W2).
Entries and decisions name the incarnation (`TermsChanged`). Sides are `u16`.

- **One list of entries** (`["entries", contest, incarnation, 0]`, `decodeEntries`): a record a player, one side a
  wallet (`OtherSide`), its bytes the player's (not refunded). With `stake`, every entry exactly that, once (`BadStake`):
  a wager. With `min_pot`, a contest short of it when entries close is off (`ResultOverdue` for a side named then):
  a crowdfund.
- **Verdicts**: a decider signs `"loot-verdict-v4" | sha256(program | contest | incarnation (u64 LE) | side (u16 LE,
65,535 is off) | expires (i64 LE))`, the body ending `| recipient` for a contest with a chosen share (`verdictBytes`),
  checked by the Ed25519 precompile right before `decide`. A side is taken only once entries close (`EntriesOpen`),
  from the authority too; a call-off any time.
- **Payout**: `decide` takes the shares and writes what the winners won: `pot_won`, what the pot then holds, and
  `prize_won`, what a split prize's vault received. Each winning entry's claim pays
  `floor(won × (claimed + entry) ÷ total) − floor(won × claimed ÷ total)`, `total` what its side put in and `claimed` what
  the entries claimed before it put in (`contestWinnings`), so the parts add up exactly whatever the order. Gifts before
  the decision count; tokens sent to the pot or the vault after it are nobody's, burned at the close (wrapped SOL closes
  with its account). A loser of a contest of tokens sends nothing. The one chosen share pays the `recipient` `decide`
  names.
- **A prize per winning entry** (`prize`), given with its first claim (a roll at the claim's `nonce`); the player may
  `forgo` it (a split prize's part forgone stays in the vault, back to its pool at the close, not to later winners).
- **A prize split by stake** (`prize_split`, tokens only): its vault `["prize", contest]` opens with the contest;
  `decide` sets the whole prize aside or is refused (`PrizeNotCovered`); each winner takes its share by stake. A hooked
  prize mint's leftover is burned at the close, not moved back (no hook accounts for it). From a
  pool, a claim that may close the contest names that pool (`prize_pool`), where what the vault still holds goes back
  (`WrongPool` without it; `claimIx` passes it).
- **A contest of NFTs** (`nft`, a rule): each entry stakes one NFT of any kind, compressed too; sides count NFTs and the
  NFTs are the pot. At the decision each winner's share of the losers' NFTs is fixed, `min(cap, losers ÷ winners)` (a
  `cap` of 0 sends every loser's NFT to whoever opened it), the first
  winners to enter taking one more when they don't divide evenly. A claim names the entries whose NFTs it moves by
  their place in the list: its own back, losers' picked by the winner (`WinnerPicks`), and once no
  winner has picks left, what they left to the opener (anyone). `end` leaves the rest of a winner's share to the
  opener; an NFT passed as its hold's address `["hold", nft, 0]` in place of its piece (`claimIx`'s `hold`) becomes a
  hold for whoever it goes to.
- **Off**: `decide(None)` calls it off before its result is due (the authority or a decider); a contest past
  `result_by` undecided is off by the clock (`contestOff`), needs no decision (`ResultOverdue`), and every entry takes
  its own back. A decision never closes a contest: the claim that leaves nothing owed does, and a contest that owes
  nothing (nobody entered, every part claimed) is closed by any claim, entry 0, naming the treasury (`claimIx` takes
  `projectState`).
- The claim that leaves nothing owed closes the contest, its list (its bytes to the treasury) and its pot and prize
  vault, burning what is left (wrapped SOL to the opener); an account the issuer froze, or a burn authority blocks, is
  left behind and that id can't open again. Any mint: a winner who closes their own account of one whose new accounts
  start frozen (or can be made to) holds up their own claim and the contest's close, and a split prize minted in a
  token that can't be transferred must be given up by each winner (W14).

## Auctions

At `["auction", project, seller, id]`, so an id is its seller's own; the seller is its only signer.

- **Lots** (`Lot`): `Item(id)` (a new unit, its serial reserved at open; project keys only; an item switched off in
  the shop may be sold, within its stock); `Roll(box_id)` (a mystery lot made into the winner's roll at the end; project
  keys only, the box alone, already written, `WrongRecord` otherwise; for bids in tokens only, no `nft_bids`; refused,
  `LotRefused`, for a box whose order with the auction's shares passes what one call can grow an account by; the box's
  own shares, a burn among them, are never read for it); `Auction.pin` (and `AuctionOpened.pin`) keeps an item lot's
  serial or a roll lot's box version; `Asset(address)` (an NFT its seller holds, of any kind and collection, handed to
  the project until the end).
- **Bids** sign `terms` (`auctionTerms`: sha256 of the auction's bytes as read, all but the bid: `high_bidder`,
  `high`, `last_bid_at` and `held`, which sit last, with the room after them). At least the reserve and 1, and
  above the high bid by `min_raise_bps` rounded up (at least 1), counted on what arrived. The topped bid goes back in
  the same instruction; there is no record per bidder. A bid in the last `extend` seconds pushes the end to `extend`
  after it. `ends_at` and `extend` are the seller's, however far: once a bid is in, only a higher bid hands it back
  before the end, so a time written in milliseconds holds the bid and the lot that long (`xsolana_check` says a far
  date in words, W-FAR-TIME). With no extension or no least raise, two wallets topping each other in the last seconds
  keep every other bid out: keep `extend` a minute or more and the raise 1% or more.
- **Bids of NFTs** (`nft_bids`, a rule): 1 to 3 NFTs a bid (`MAX_BID_NFTS`, not in the IDL: more is `BidTooLow`, and a
  high bid of 3 can't be topped), not compressed (`CompressedBid`); reserve (1 to 3, `BadAuction`) and raise count NFTs;
  the topped bundle goes back at once. The record is made with room for 3 NFTs (96 bytes, 487,680 lamports, the
  seller's, back at the close): a bid writes its NFTs in place, and no bidder pays rent. No shares.
- **The end** (`end_auction(reference, nonce, ending)`): anyone, once it is over. Both sides move in one instruction:
  the seller and the shares are paid only with the lot going to the winner, and a sold lot is never made a hold
  (`LotRefused`). `ending` is one of three; with no bid each sends the lot home (an item's serial is voided):
  - `Deliver` (0): the shares take their parts, the rest to the lot's owner (the seller, or the treasury for an item),
    the lot to the winner. An NFT lot that can't move now (its collection froze it) fails the end, which waits, the
    winning bid in the project's vault: send it again later. After a lot first, it pays what the bid still owes and
    closes the auction.
  - `LotFirst` (1): NFT lots only, for an end too wide for one transaction (a compressed lot at a 17-node proof with 8
    shares to holders and a hooked coin locks 69 accounts). The lot goes to the winner now, the whole bid written as
    owed (`Auction.proceeds_owed`); the next `Deliver` pays the shares and the seller. No share accounts, no `order`.
  - `CallOff` (2): NFT lots only, before the lot has moved (`CantCallOff` after). The winning bid goes back to its
    bidder (tokens, or its NFTs, each moved or made a hold for them) and the lot goes home to its seller (moved, or a
    hold for them, `order`). **Anyone**, when the lot or an NFT of the winning bid is proven gone (its collection took
    it back or burned it: `piece::held` reads a Core asset, a token account holding a Token Metadata NFT or its mint, a
    compressed NFT's record; `NotProven` otherwise); otherwise **only the project's owner or authority**, for the
    project fee (`NotAuthority`): the fail-safe for a lot that never thaws. `proceeds` and its account are the winner's.
    An end with no bid reads the same evidence: a compressed lot's record must be current (`prove_leaf` first), and a lot
    proven gone stays where it is while the auction closes. A roll lot sold splits nothing at the end: the winning bid
    stays in the vault as the payment of the winner's order (`paid` the high bid, the auction's `shares`, its `pin` as the
    box version, no fee), which settle splits by those shares, the rest to the treasury; a roll that fails (the box edited
    since the auction opened, or nothing in stock) refunds the bid. The seller may call off one with no bid; once a bid
    is in it runs to its end, with no deadline to be ended. `SaleCalledOff { auction, bidder, back, lot, home, gone, by }`
    is written for a sale called off (never `AuctionEnded`); for a lot sent first `AuctionEnded.remainder` is 0 and the
    auction stays open. A client sends `Deliver`; when it doesn't fit, `LotFirst` then `Deliver`; shows a sale whose lot
    can't move as waiting; sends `CallOff` with the evidence when the lot is gone.
- **Any mint**: in one whose new accounts start frozen (or can be switched to it), or that allows confidential
  transfers, the high bidder can close their own account so that every higher bid fails (the topped bid can't go
  back), and win at their price; `xsolana_check` warns (W-HOLD-UP). A seller's account that turns the payment away is
  owed it (`proceeds_owed`).
- **A lot outside the project's collections**: whoever controls its collection can stop it moving or take it back
  while the project holds it. The seller is paid only when the lot reaches the winner; while it can't move, the winning
  bid waits in the project's vault until it can, or until the project's keys call the sale off; a lot taken back or
  burned sends the bid back. A bidder's money can be tied up, not lost (W-AUCTION-OUTSIDE).

## Offers and loans

Any wallet opens one at `["offer", project, maker, id]`, alone: a rule, a deal, how many NFTs (`left`), and for a bid
its shares. All its money goes into the project's vault at open and must arrive whole (`BadOffer`). It is never
edited; every take signs `terms` (`offerTerms`: sha256 of its bytes as read, all but `left`, its last 2). The rule is
read as the NFT comes in. The last take closes it. The terms are the maker's: a bid's price may be 0 (it goes to the
first taker), a loan's `repay` less than its `amount` (its lender loses the difference), and `lasts` any `u32` of
seconds (`amount` and `lasts` above 0, `BadOffer`).

- **Bid** (`Buy { price }`): `sell_to_offer` sends the NFT straight to the maker and the price through the shares to
  the seller.
- **Loan** (`Lend { amount, repay, lasts }`, no shares): `borrow` puts the NFT in a hold at `["hold", asset, due]` with a
  debt, `due` the borrower's (at most `lasts` away), and pays `amount`. Before `due` anyone may `repay(home, repay)`
  (the borrower, a friend, a guild), naming the amount it saw. With `home` (the default a client sends), the NFT goes to
  its borrower in the same call and the hold closes, its rent to the borrower (`Repaid` with `home`, and `Released`);
  an NFT that can't move fails the whole call, and nobody pays. Without, only the money moves: the hold becomes a plain
  one that is over (no debt, `free_at` 0, still at the address its loan named), and anyone `release`s the NFT home
  later, free (for an NFT frozen for now, or a compressed one whose proof doesn't fit beside the repayment). Two
  accounts follow `system_program`: `borrower` (writable, the hold's player) and the NFT's `piece`; going home, a
  compressed NFT's proof first among the remaining accounts. Either way the NFT's evidence must show the project still
  holds it (`NotTheNft` when it is proven gone, `NotProven` when nothing shows it): nobody repays for an NFT its
  collection took back or burned. One case gives: the money alone for a compressed NFT goes through when its record
  shows nothing (out of date), since anyone with a leaf in its tree can keep a record out of date; prove the leaf in
  the same transaction when it fits. Sizes (measured): a compressed NFT at a 17-node proof going home needs v0 with a
  lookup table (479 bytes with its `prove_leaf`); the money alone for it fits legacy when its record is current (862
  bytes); a programmable Token Metadata NFT going home fits legacy (958 bytes). From `due` it can't be repaid
  (`LoanDue`) and anyone releases it to the lender (`OwedToLender`; `releaseIx`'s `to`; js/play's `claims()` lists it
  for the lender). No grace, extension, partial repayment or liquidation; the authority has no say.
- **A loan whose NFT is gone**: an NFT taken back or burned by whoever controls its collection while the project held
  it can't be repaid, so its borrower keeps what they borrowed; the lender's release at the due date fails; the loan's
  record stays open with the borrower's rent in it (about 0.0026 SOL). Check the NFT's collection before lending
  against it.
- **Any mint**: in one whose new accounts start frozen (or can be switched to it), or that allows confidential
  transfers, a lender can close their own account so that the repayment can't arrive, and take the NFT when the loan
  falls due; a token that can't be transferred can't be paid in. A mint's issuer (freeze, pause, hook, permanent
  delegate) can also block a repayment. The borrower checks the mint (the client warns).
- An offer trusts its rule's collection. Switches refuse `open_offer`, `sell_to_offer`, `borrow`; never `close_offer`,
  `repay` or a default's release.

## Listings

Any wallet lists an NFT of any kind at `["listing", project, asset]`, alone; the project holds it meanwhile, so an NFT
is in one listing of a project at most, and a game finds its renter with one read (`renterOf`; `user` and `until` sit
at offsets 129 and 161). It names a mint, a deal and its shares (no `Chosen`), is never edited, and every take
signs `terms` (`listingTerms`: sha256 of its bytes as read, all but `user`, `until` and `stopped`, bytes 129 to 170).

- **Sale** (`Sell { price }`): `take_listing` pays from the taker through the shares to the maker and hands the NFT
  over; the listing closes.
- **Rental** (`Rent { price, lasts, max_periods }`): the taker pays for 1 to `max_periods` periods and is the `user`
  until `until`; the NFT stays with the project. Nobody ends it early (`Rented`). `close_listing` during a rental only
  stops new renters (`ListingStopped`); after `until` it sends the NFT home.
- A take of a Token Metadata NFT, a rental's too, passes the project's token account of it (`project_token`), which the
  program reads to see the project still holds it.
- Rules don't read rentals: a rented NFT passes no gate and boosts nothing as its renter's; a game reads `user`.
- Any price, 0 too (a sale at 0 goes to its first taker, a free rental to anyone for its full run), and any length
  (`lasts` and `max_periods` above 0, `BadListing`). A payee's account that can't take its part is
  passed over to the maker; the maker's own failing fails the take.

## Making collectibles

`collectible` `Make { item, tree, attributes }` mints one of an item to each owner the instruction names, in serial
order, at `["asset", item, serial]` (`makeIx`, `madeAssets`), or with `tree` a compressed NFT into that tree of the
project's; a sold-out item refuses the whole call (`PrizeNotCovered`), a switched-off one still makes. `Set` rewrites
attributes but never `item_id`, `rarity` or `serial`, and keeps `made` (the program's only key of its own) unless
named; on an NFT the
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
  transaction (`RefreshFirst`); so does any top-up or compound of a seat with a booster on, whose boost is read again
  there (`stakeRefreshFirst`), and a booster put on a token seat of a farm whose growth writes the profile
  (`boosterRefreshFirst`; js/play sends the refresh first). No streak on a profile (`BadFarm`).

## Rules, gates, odds and boosts

A **rule** (`{ of, key, test }`) asks for an NFT the player holds: `Of::Collection(address)`, or `Of::Item(id)` (by the
`item_id` only loot writes), or reads the player's own profile (`Of::Profile`, passed where the NFT would be), and
tests its attribute under `key`:

| `Test`                     | Passes when the value                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `Any`                      | — always                                                                                |
| `AtLeast(n)` / `AtMost(n)` | is at least / at most n                                                                 |
| `Equals(text)`             | equals the text                                                                         |
| `Ahead`                    | is a time (Unix seconds, 64 bits) still to come: fuel left                              |
| `Passed`                   | is a time past, or missing: out of jail                                                 |
| `Within(s)`                | is a time less than s seconds ago and not ahead; missing is long ago                    |
| `Older(s)`                 | is a time at least s seconds ago (an egg `made` a day ago hatches); missing is long ago |

A missing number, or text, reads as 0. What is written on an NFT counts as it is: that is its collection's business.
`Of::Collection` of a Token Metadata collection doesn't count a **print** (token standard `NonFungibleEdition` or
`ProgrammableNonFungibleEdition`): it carries its master's collection, but whoever holds the master makes it without the
collection's authority, so the program reads a print as in no collection.

**Showing an NFT** (`shownAccounts`): a Core asset of the project's collections alone; another Core asset, then its
Sheet's address; a Token Metadata NFT as mint, metadata, the holder's token account and Sheet address; a compressed NFT
as asset id, its `Proven` record, tree and Sheet address. For an NFT the project has no authority over, the Sheet is
read over its own attributes, and one shown without its Sheet passes nothing.

**Gates** guard boxes, lotteries, grants, contests, auctions and farms:

| `Gate`                      | Passes                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Holds(rule)`               | an NFT shown passes the rule                                                                                                                                                                                                                                                                          |
| `Wallets(list)`             | the wallet is one of the list                                                                                                                                                                                                                                                                         |
| `List { root, depth }`      | a Merkle proof of `sha256("loot-list-v1" \| wallet)` (`gateListLeaf`, `gateList`): pairs hashed smaller first, an odd last node sent up, exactly `depth` nodes, each an account of the transaction                                                                                                    |
| `Staked { farm, at_least }` | the wallet's token seat in `farm` holds at least `at_least` (above 0), staked before this second, its tier's lock running (a tier with no lock or with an early exit never passes). What counts is what it held when its lock last started (`Seat.locked`), so one stake counts for one wallet a lock |

A farm's gates are rules one NFT (or the player's profile) must all pass. A grant's gate reads the receiving wallet. A
box's gate changes with an edit, a lottery's between rounds, others never.

A rule's `OneOf` texts have no count of their own (one at least): the record that holds it bounds them. But a
lottery's NFT ticket's rule holds at most 170, and a box's gate about 340 (`xsolana_check`, W22): the oracle's answer
reads them.

**Odds** (a box, `Odds { entry, boost }`, any number) and **boosts** (a farm, `Boost { rule, effect }`, within
`max_boost_bps`): `Effect::Flat(bps)` or `Effect::PerPoint { bps, most }`, in basis points of the weight. A farm's boost
alone (`Flat`, or `PerPoint`'s `bps × most`) and its `max_boost_bps` go up to 10,000,000 (+100,000%, ×1,001; one more
is `BadFarm`). A box's odds have no such cap: a boosted weight is `min(4,294,967,295, weight × (10,000 + bps) /
10,000)` (`boostedWeight` in the kit, in BigInt: the product passes 2^53), boosts on one entry add up and stop at the
largest `u32`, and two entries boosted past the largest weight are equally likely. A box's rules may read the player's
profile and an NFT shown together. `open_box` reads the profile first (after a list's proof, or a stake gate's seat and
farm), then the NFT shown when a rule reads one (a box that rolls on an NFT reads that NFT as its piece), and fixes the
odds they raise in the order (`OddsRaised`, with `profile` and `asset`). **A roll another route makes** (a recipe, a
grant, a mission, a lottery's place, an auction's lot) reads them at its **first ask** (`ask_roll`, by its player or the
project's keys only, `NotAuthority`), after the accounts it took before: the order's player's profile
`["profile", project, player]` when any odds rule reads a profile, and an NFT the player holds, with the accounts
`open_box` takes for one shown, when any rule reads an NFT and the roll is on no NFT. Each must be the order's
player's own, whoever asks; anything else reads as nothing, and odds never stop a roll. Their boosts add to what the
NFT the roll is on raised when it was made. A later ask reads nothing; after an edit of the box, the next ask reads
them afresh. So a player may level up before asking, a profile rule can only add (a player may leave the profile out),
and a roll asked without them stays at the odds it was made with (W29).

## Farms

```
weight = staked × tier.bps / 10,000 × (10,000 + boost) / 10,000
staked = tokens, or NFT_UNIT (1,000,000) for one NFT
```

`FarmArgs { custody, tiers, boosts, max_boost_bps, gates, rate, growth, ends_at, lock_key, upkeep_key, exit_to }`. A
farm takes a token (`staked_mint`) or NFTs of any kind its gates name. It is never edited and never closes; a new
mission is a new id. Its rewards (`rewards_mint`) land in a vault of its own, `["rewards", farm]` (`pda.rewards`): a
split's or a schedule's `To::Account(vault)`, or a plain transfer, funds it. The farm keeps what it owes its seats as a
number (`Farm.owed`, ×10¹²); what the vault holds beyond it is free (`vault − owed / 10¹²`), and only what is free is
released, paid at a rate, or taken back by the authority (`move_tokens` from `TokenSource::Farm(id)`, a fixed amount,
the vault as `pool`, the farm as `farm`, writable: it is credited first, and `mint` its rewards mint, `WrongMint`
otherwise). No tokens move to credit a seat: only a payout moves them.

**Tiers** (1 to 256, a byte names one; `{ lock, bps, prize, roll, exit_bps, earns_for }`): a lock in seconds, a
multiplier above ×0 up to ×100 (`bps` up to 1,000,000, `BadFarm` past it; a seat's weight stays a million times inside
128 bits, and near a quarter of 128 bits a seat weighs only what is left: read a seat's weight from the seat or its
receipt, never from the formula alone), and a term (`earns_for`, below). A mission (a tier's `prize` or `roll`) may
have no lock: then one NFT can stake and leave again and again and take it each time (W17). A
token seat moves only to a tier that locks as long or longer; every stake and every booster put on restarts the lock.

**Custody** (NFT farms):

| `Custody` | The NFT                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Escrow`  | handed to the project (Core transfer, Token Metadata `TransferV1`, Bubblegum `TransferV2`); soulbound refused (`SoulboundEscrow`). The default in economy specs                                                                                                                                                                                                                          |
| `Freeze`  | stays in the wallet, locked with the project as the only lock holder (Core freeze; legacy approve and freeze; pNFT `StakingV1` delegate and lock; compressed delegate and freeze). Needed for soulbound NFTs. A lock that isn't the project's, or is off, reads as the NFT gone                                                                                                          |
| `Watch`   | stays free and can be sold; earns only while its staker holds it. Whoever finds it gone (a refresh, harvest or unstake showing where it is) returns what the seat was owed to the farm, and its next holder takes the seat over (`stake_nft` with `previous`, repaying the seat's rent). Not for token farms. Handing it to the project (a hold, listing, loan) counts as not holding it |

A frozen or held NFT is in one farm at a time; a soulbound or watched one can sit in several (`AlreadyStaked` for the
same farm twice). What a farm grows on a Token Metadata or compressed NFT is in its Sheet (`WrongSheet` when left out).
`stake_nft` puts an NFT on its own seat, or on a token seat as its **booster** (one at a time). Boosts are read on
staking and by `refresh_seat`, which also drops a seat's weight if its NFT left or no longer passes; nothing refreshes
by itself.

**Sharing rewards** (no rate): what is free in the vault is released over the farm's span (its longest lock, a day at
least), along a straight line, and credited by weight as released. New funding is counted at the next move and moves
the line's end by its share. So no seat is credited at once what landed before it (a stake and harvest in one
transaction take nothing). The clock pauses while nobody weighs anything. Rounding fractions are kept, so frequent
refreshes lose nothing.

**A fixed rate** (`Rate { per_day, mints, shared, halve_every }`): `per_day` base units for each `NFT_UNIT` of weight,
by the second; with `shared`, `per_day` is the whole farm's, shared by weight while anything weighs (an emission
budget). It halves every `halve_every` seconds from the farm's opening (`Farm.opened_at`; 0: never), paid in closed
form by what the rate paid a unit between two times (`farm::paid`), a lapsed seat's share too. Minted when a seat
is paid (the project the mint authority; the mint written only on a paying move) as far as the supply has room, or
paid from what the vault holds free as far as it goes; what can't be covered isn't owed later. A rate of 0 pays
nothing (a farm for growth or prizes only).

**Given back** (a forfeit, a watched NFT gone): its whole tokens are free again at once, released again like anything
that lands (a farm that mints simply never mints them); never credited at once to the seats there.

**Growth** (up to 32 of `{ key, per_day, level, steps, streak, profile, at_least }`, up to 128 steps each): an NFT on a seat earns
`per_day` points a day times its tier and boost under `key`, and the level reached (of its rising `steps`) under
`level`; with no steps the points are the level. Written by `refresh_seat` and on the way out, on the NFT where the
project may write, otherwise its Sheet, or with `profile` on the seat's player's profile, at the signer's cost. Points
add to what is there (two farms on one key add up); a level never drops, except with `streak`, which resets points and
level when the NFT leaves. An `unstake_nft` with `forfeit` writes no growth (and gives up the rewards and prize): it is
the way out for an NFT that can't be written, one whose attributes reached what its program can rewrite or whose
collection took back the project's right to write. A boost that reads a level the farm's own growth writes counts each level from when it is
written, which is `refresh_seat`, so a project that boosts by a growing level has its page or a keeper refresh seats.

**An end** (`ends_at`): no new seat at or after it, nor one whose lock runs past it (`FarmOver`); rate, growth and
release stop. What isn't released by then stays free in the vault. Fund a farm a span ahead of its end.

**The lock on the NFT** (`lock_key`, NFT farms): staking writes the lock's end under that key (never sooner than one
already there); the NFT leaves once that time comes. A recipe that lowers it is a paid early exit; a roll that raises
it is jail; two farms on one key share a lock. A watched NFT that can't be read on the way out is treated as gone: the
seat closes on its tier's own lock, giving up rewards, prize and roll.

**Earns until** (`Seat.earns_until`, `i64::MAX` for no end): the time a seat stops earning and growing, the sooner
of two:

- **Its tier's term** (`Tier.earns_for`, seconds after its lock started, `Seat.since`; 0 for no end). Every stake, and
  a booster put on, starts it again with the lock, so a token seat renews its term with `stake_tokens` of nothing at
  its tier (with a growth, or a booster on, `refresh_seat` first in the same transaction, `RefreshFirst`); a compound
  starts neither.
  One term on every tier is a farm-wide end of earning for each seat; tiers of different terms are terms or missions
  of different lengths.
- **Its NFT's fuel** (`upkeep_key`, NFT farms): a time until which the NFT earns (fuel, food, a license), bought with
  a recipe raise `from_now`. Read at stake and refresh, so send `refresh_seat` with the refuel. A recipe never lowers
  a number the farm reads on an NFT on a seat (its upkeep, a key its boosts or gates read; `BadRecipe`), and an NFT on
  a Freeze or Escrow seat passes its seat and farm after it in every craft line (`craftIx`'s `{ asset, farm }`; a
  `Show` line's only when a raise lowers a number on it).

What a seat earned up to `earns_until` is exact, however late it is touched, and nobody has to act at that time. A farm
whose tiers have a term or that has an upkeep, and that pays anything, keeps a **record of ends** (`["ends", farm]`,
`Farm.keeps_ends`, `decodeEnds`; a rate of 0 has nothing to credit and keeps none, and any other farm passes no record:
`WrongEnds`): a list sorted by time, 44 bytes for each different time waiting, holding the weight that stops then,
`reward_per_weight` at that second once walked, and the seats that still need it. A seat joining a time that has no record
pays what its rent lacks, spare rent in the account first; the record goes when its last seat leaves, and its rent stays
with the account for the next time written. Whatever moves the farm walks every time it has passed, in order: it credits
up to that second by the weight then in, writes `reward_per_weight` there, and takes that weight out of the total. So
nothing released after a seat's end reaches it, nothing earned before it is lost, and the seats that stay earn by the weight
really there. A farm that has passed more times than a transaction can walk (about 2,300 compute units each at most) is
walked in parts by `walk_farm`, anyone's and free; every move then walks the rest. The record holds 238,312 different
times at most (what an account holds); the first staker on a new second pays about 0.0003 SOL for it, and when it is
full a stake at a new end time fails until older seats are touched (an insert took 145,279 compute units at the full
list: ask for more than the default compute on a stake in a large farm, W23). Growth counts only up to the end. A mission's prize needs the fuel to last the tier's lock or its term, whichever is shorter: a lapse before then
marks the seat `dry` for that stay. A tier whose term is shorter than its lock still gives its prize once the lock has
run.

**Missions** (`Tier.prize`, NFT farms): an NFT leaving its own seat after its tier's lock, never dry, takes the prize:
tokens (a fixed amount grown by its boosts), a collectible, a stash NFT, or a chest (its order at the unstake's `nonce`
plus 1). `forfeit` gives it up; one that can't be given is passed over. A tier with a prize needs a lock above 0 (`BadFarm`).

**Leaving a token farm early.** Fees go to a `Sink`: burned (not wrapped SOL), a pool in that mint, or `Rewards`, the
farm's own vault (a farm whose staked mint is its rewards mint, else `WrongMint` at `open_farm`), free there for the
seats that stay.

- **Early exit** (`Tier.exit_bps`, `exit_to`): leave before the lock by leaving that share, rounded up; 0 can't
  (`StillLocked`). It keeps the rewards it was credited (a tier's weight can be bought for its exit fee). While locked,
  a seat moves only to a tier with no early exit or one whose early exit costs at least as much as its own
  (`ExitWhileLocked`): never to a way out it didn't have, or a cheaper one. What is taken out leaves at once: there is
  no unbonding.
- **Compound** (`harvest` with `compound`, rewards in the staked token, else `NotCompoundable`): rewards join the stake
  without restarting the lock. Refused while paused or suspended.

Stakes and rewards stay in separate vaults even in one mint. Pause and suspend never block unstake, early exit or
harvest; `forfeit` skips rewards that would block a withdrawal. Farm builders take `extra` remaining
accounts for hooks and Core escrow adapters (`transfers` for dynamic hooks).

## An NFT as the price

Every route that takes money can take an NFT instead. Where it goes is a `Spend`: `Burn`, `Give(wallet)` or
`Stash(id)`; an `NftPrice` is a rule and a `Spend`. A burned or given NFT moves straight from its holder; a stashed one
is handed to the project, the stash growing 36 bytes (its row: weight 1 and the NFT) at the holder's cost.

| Route      | NFT price                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pay_nft`  | any NFT, burned or given to a wallet; the `PaidNft` receipt is the record. A semi-fungible Token Metadata unit passes here, so an app admitting on `PaidNft` checks the mint's supply. Never into a stash |
| a box      | the NFT it rolls on (`subject`); each fate says where it goes; home on refund                                                                                                                             |
| a recipe   | `Input::Trade { collection, then }`                                                                                                                                                                       |
| a lottery  | `nft_ticket`: one NFT a ticket, held until the draw                                                                                                                                                       |
| a contest  | `nft`: one NFT an entry, of any kind; winners take the losers'                                                                                                                                            |
| an auction | `nft_bids`: NFTs a bid, not compressed                                                                                                                                                                    |

## Every kind of NFT

Every route that takes an NFT takes its accounts as a `Piece` and moves it the same few ways whatever its kind: read
it, lock it in its wallet, hand it to the project and on, or pass it straight on from its holder. The client's `piece`
builder makes one for any kind with only the accounts a route uses; collections, trees and leaf records are writable
only where a call writes them, so a hold never write-locks a collection or tree.

| Kind                          | The `Piece`                                                                                                                                                                                                                           | Lock                                                                              | Hand to the project             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| Core                          | the asset, its collection (left out for none), Core, its Sheet when the project has no authority                                                                                                                                      | a freeze delegate                                                                 | Core `TransferV1`               |
| Token Metadata (legacy, pNFT) | mint, `metadata`, `edition`, the wallet's `token` and `token_record`, the project's `project_token` and `project_record`, `rule_set`, `rules_program`, Token Metadata, the instructions sysvar, SPL Token, the ATA program, its Sheet | legacy `Approve` + `FreezeDelegatedAccount`; pNFT `Delegate` (StakingV1) + `Lock` | `TransferV1` under its rule set |
| Compressed (Bubblegum v2)     | asset id, its Core collection, its `leaf` record, `tree`, `tree_config`, the leaf's delegate if any, Bubblegum, mpl-account-compression, mpl-noop, its Sheet; the proof's nodes first among the remaining accounts                    | `DelegateAndFreezeV2`                                                             | `TransferV2`                    |

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

**Limits** (`{ all, wallet, per_person, per_key, window }`): by all wallets together (`all`, a `PerWallet`: in all and
per window, 86,400 seconds a UTC day), per wallet (`wallet`, the same), per person, per key, and a time window
(`OverTotal`, `OverWindow`, `OverWallet`, `OverPerson`, `OverKey`). What the grant has given is `Grant.counted`
(`{ count, window, in_window }`). Each limit record (28 bytes) is keyed `sha256(kind | subject)[..16]` (`limitKey`: a wallet, a person, a
badge, a key) in the grant's claims, `["claims", grant, incarnation, shard]`; one claim touches at most four shards.

**Rounds.** A claim names its rounds (a voucher or a list proof each); each pays a wallet once per incarnation, its
record `sha256(round | wallet)[..16]` (`roundKey`, 16 bytes) in the wallet's shard of the grant's rounds, `["rounds",
grant, incarnation, shard]`: replays, re-signs, other keys and clocks set back are all refused, a round named twice is
paid once, and the same voucher sent again later pays the rounds a full limit held back. A grant's records are in
`2^shard_bits` shards (0 to 8, fixed for its incarnation, `ShardsFixed`): a record's shard is its key's top bits
(`shardOf`), the fewest that keep each under ~100,000 records (`shardBitsFor`). Once the grant is closed or made again,
anyone closes its shards (`close_shard`), their rent to the owner. A claim may need 400,000 compute units
(`CLAIM_COMPUTE_UNITS`).

**A claim's own amount**: a voucher or list leaf may name `amount` for a prize of `Tokens { amount: most }`: at
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
still carry the receipts. Take a receipt only when its `data.project` is yours: `receipts` reads every project's, and
anyone can make a project. Another program can log the same bytes, so a backend that needs more also checks that loot
was the program logging it. A truncated log stays truncated when read again: go by the account instead (a settled
order's `settled` count, or its closing).

| Receipt                                                                                                                                                                                                                                                                                           | When                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `Paid`, `PaidNft`                                                                                                                                                                                                                                                                                 | `pay`, `pay_nft`                                                |
| `Bought` (`count`), then `PrizeGiven` per prize given                                                                                                                                                                                                                                             | `buy`                                                           |
| `OrderRolled` (`entries`, `won`), `OddsRaised`, `OrderFailed`, `OrderPartSettled` (`from`, `upto`: a settle part's prizes), `OrderSettled` (`from`, `won`: the last part; a collectible minted is at `["asset", item, serial]`, a compressed one's id is the tree's count), `OrderRefunded`       | an order's life                                                 |
| `RollMade`                                                                                                                                                                                                                                                                                        | a mission's, recipe's or prize's waiting roll                   |
| `Stashed` (`weight`), `Moved`, `Changed`, `ProfileWritten`, `Held`, `Released`                                                                                                                                                                                                                    | `stash`, `move_tokens`, `collectible`, a profile written, holds |
| `Listed`, `ListingSold`, `ListingRented`, `Unlisted`                                                                                                                                                                                                                                              | listings                                                        |
| `OfferOpened`, `OfferClosed`, `SoldToOffer`, `Borrowed`, `Repaid`                                                                                                                                                                                                                                 | offers and loans                                                |
| `Entered`, `Decided` (`side: None` when off), `Claimed`                                                                                                                                                                                                                                           | contests                                                        |
| `AuctionOpened` (`pin`: an item lot's serial, a roll lot's box version), `BidPlaced` (`ends_at` after extension), `BidRefunded`, `AuctionEnded` (`winner: None` unsold, `remainder`)                                                                                                              | auctions                                                        |
| `ScheduleRan` (`from`, `run`: a range of runs), `TicketsBought` (`entry`), `LotteryDrawn`, `LotteryCancelled` (`short`), `LotteryPulled` (`entry`, `buyer`: the winner of a `Pot` or `Prize` part, its run in `part`; `amount`: tokens settled, 0 for an NFT), `RoundClosed`, `Crafted`, `Rolled` | mechanics                                                       |
| `Seated`, `Unseated` (`fee`), `Harvested` (`compounded`), `Reweighed`, `Grown`                                                                                                                                                                                                                    | farms                                                           |
| `PrizeGiven` (`winner`, `prize`, `asset`, `serial`, `amount`, `order`)                                                                                                                                                                                                                            | every prize given at once                                       |
| `TraitsSet`, `TraitsProven`, `GrantClaimed`, `RecordWritten`, `RecordClosed`, `TreeOpened`                                                                                                                                                                                                        | traits, grants, `upsert`, `open_tree`                           |
| `FeeChanged`, `ProjectSuspended`                                                                                                                                                                                                                                                                  | the platform                                                    |

**Errors**: `AnchorError occurred. Error Code: <name>. Error Number: <n>. Error Message: <name>.` (or `AnchorError
caused by account: <account>. …`): the program's build leaves the sentences out, so its log names the error twice and
never says it in words. The IDL keeps every error's sentence (`msg`) by code; `lootError` and `ERRORS` give it. Read
codes from the IDL, never from a list of your own: they shift when the program deletes an error.

## Limits

The program bounds a project only where the chain does, and `xsolana_check` says each bound in words before anything is
signed. **A box's lists have no cap of their own**: a box is written only when one answer of the oracle's holds a draw
of it (`PackTooLarge`, or `TooManyAccounts` past the answer's 21 accounts), a box of one draw included, so a box too
long is refused when it is written, before anyone pays. Measured: 128 outcomes that give nothing, 29 of token amounts,
18 each of its own item; 41 slots; 72 odds rules; 64 fates; 16 token prizes or 18 collectibles in one outcome (an
outcome holds at most 255 prizes, `BadEntries`); 340 texts in a box's gate. A box that mixes them fits less (W22). A
one-outcome box of 15 to 18 collectibles sells only through the oracle, and 19 or more can be written but never sold. A
box written from a wallet carries about 960 bytes; a longer one needs a program call (a multisig). A long weighted list
goes in a table or a stash, drawn by one outcome. **A recipe's lines have no cap**: one craft is one transaction that
fails whole; measured, 60 payments in one coin, 26 in different coins, 59 outputs from a pool, 108 raises or needs, and
past that it is written but never crafts. It may give several rolls (each its own order, at `nonce + k`, counting the
rolls in the recipe's order from 0); past 15 its receipts run past what a transaction's log holds (10,000 bytes), and
`Crafted` is cut (W32). **A rule's "one of" texts have no cap**: the record that holds it bounds them; a lottery's NFT
ticket's rule holds at most 170 (`BadLottery`), since the oracle's answer reads it. **A raffle** has at most 256 places
from its own stash (`BadLottery`). **Times have no cap**: a contest's result, an auction's end and extension, a
lottery's draw, a loan or a rental, a sealed schedule's last run may be as far off as a date holds; `xsolana_check`
says a far one's date in words (W12). **Values of 0 are the project's**: a price, a prize, a loan repaid for less, a
contest of NFTs whose winners take none, a stash NFT or a table row of weight 0. The other lists a record holds keep a
cap, set where its whole flow still fits a transaction, and `xsolana_check` refuses a spec over one in words (`LIMITS`):
an item's traits 64, each name 64 bytes; a farm's boosts, gates and growths 32 each and a growth's steps 128; a
contest's sides 1,024 and deciders 32; a project's collections 32; a lottery's runs 64. What stays is not a size: a
farm's tier's ×100 and boost's +100,000%, the platform's fee cap, and counts a later call must carry or walk: a stored
split's 8 shares, an auction bid's 3 NFTs, a lottery run of places given one by one (4,096, `MAX_RUN_PLACES`), one
`run_schedule`'s steps (4,000).

| What bounds it                                               | Value                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| A transaction                                                | 1,232 bytes legacy; 64 accounts (with a lookup table); a 64-call instruction trace; 1.4 million compute units            |
| The heap                                                     | 32 KiB, 256 KiB when a transaction asks (`RequestHeapFrame`)                                                             |
| An account                                                   | 10 MiB: a table of some 250,000 labels or 1.3 million numbers, a stash of some 290,000 NFTs                              |
| A roll's oracle callback                                     | 21 accounts (a box's items, pools, stashes, mints and vaults, and a fresh item's tables) and about 400,000 compute units |
| A compressed NFT (Bubblegum)                                 | a 32-byte name, a 200-byte URI with its values written in                                                                |
| A table's label                                              | 32 bytes                                                                                                                 |
| Farm tiers / collectibles a craft                            | 256 / 255 (a byte names each)                                                                                            |
| Named voucher keys / under a key root                        | 3 / 2^16 (2^13 when another signer pays: a key's proof is instruction data)                                              |
| Tier multiplier / farm boost / box odds                      | up to ×100 / +100,000% / any (a boosted weight stops at 4,294,967,295)                                                   |
| Each flat fee                                                | 0.01 SOL; a raise waits 7 days                                                                                           |
| Contest result, auction end and extend, lottery draw, rental | any time a date holds (the checker warns past 3 years)                                                                   |
| Sealed schedule                                              | any number of runs, its last within what a date holds                                                                    |
| Stale roll or draw                                           | 600 seconds (`STALE_SECONDS`)                                                                                            |
| Lottery cancel, and an asked order's refund                  | 7 days after the first ask (`LOTTERY_TIMEOUT_SECONDS`)                                                                   |
| `Chosen` shares in a split / NFTs a ticket / a contest entry | 1 / 1 / 1                                                                                                                |
| A fate's shift                                               | `by` and `most` 32 bits; NFT numbers 64 bits                                                                             |

Measured on 0.22 (the program's `tests/limits.rs`, `fresh.rs`, `compressed_packs.rs`): a card costs the oracle's
callback 2,600 to 3,700 compute units at 2 to 16 entries, so one answer draws about 66 to 106 cards; a stash's draw
about 25,000 at ten NFTs and 33,000 at 290,000; a table's about 49,000 at a million rows. One settle transaction mints
about 14 Core cards (the trace binds first), 10 compressed or 8 fresh compressed. A purchase is about 80,000 compute
units and 5 calls. Measured on 0.24 (`tests/roll_heap.rs`, `tests/fresh_review.rs`): the heap an answer leaves used, the
box's own bytes included (`boxBytes`), and what one `buy` carries (`buyFits`).

## Known limits

Kept by design; each is bounded, and no stranger profits from it.

**Boxes and rolls**

- **A pool's last prize.** Once a pool holds less than an entry's amount, or an item is gone, whatever emptied it, an order
  still waiting that draws that entry gets that draw's worth back. It never lands on another entry instead, so draining
  a box's common entry can't turn its rare one into a certainty. With no draw made a paid order fails and is refunded, and
  a free one goes back to waiting.
- **A pool opened mid-roll** is out of stock at the answer unless the roll carried its mint and vault. Open a box's
  pools before it sells.
- **A mission's chest at a fixed address**: a tier that rolls on the NFT and gives a chest puts the chest at a nonce
  from the NFT; an unsettled earlier chest (or a stranger's roll at that nonce) blocks later exits with the prize. The
  player can harvest and `forfeit`, losing that chest.
- **A refund before a late roll**: past 10 minutes a buyer who sees the oracle's late answer in flight can refund
  instead.
- **A refund keeps the price rise**; **a rolled box's prize in a hooked mint is out of stock** (the answer carries no
  hook accounts).
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

- Dead weight (a sold watched NFT, a seat past its `earns_until`) found near or after the end leaves its rewards in
  the pool, the project's. Refresh suspect seats a span before the end.
- Dust in the last span pushes the release's end past the farm's, keeping a little in the pool.
- A fee mint's rounding loses up to a unit per forced move (watched NFTs moved back and forth, a rate paid from a pool):
  use enough decimals, or no fee.
- A last forfeit after the end, in a mint that can refuse it, leaves that amount in the vault for good.
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
contest's side; lots other than an item, a roll or an NFT;
SOL in lamports (use wrapped SOL); list gates on farms; minting Token Metadata NFTs; conditions on chain balances;
sealed-bid or second-price auctions; v1 compressed trees; forced sales; bonding curves; decaying stakes; exit fees on
NFT farms; unbonding waits; harvest tolls; receipt tokens for stakes; slashing; per-tier gates; boosts from several NFTs; taking anything
from a wallet without its signature.

## Transaction sizes

A legacy transaction carries at most 1,232 bytes and 64 accounts. Measured with a compute budget's limit and price;
the first three rows on this build, the rest on 0.20 (box and recipe shapes then at 0.20's largest; 0.22 takes larger
ones, which the senders size the same way), each instruction's data 7 bytes longer then than its 1-byte tag makes it
now:

| Transaction                                                                                                                                 |      Legacy | v0, one lookup table |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------: | -------------------: |
| `open_box`, the largest box a roll carries (5 item entries, 3 token entries from 3 pools in 3 mints, 21 callback accounts, 4 holder shares) |       1,230 |                  367 |
| `buy`, the largest bundle (3 collectibles, 4 holder shares)                                                                                 |       1,082 |                  343 |
| `settle` of that bundle when rolled                                                                                                         |       1,094 |                  355 |
| `decide` with a split prize (a verdict, 4 holder shares, a pool, a hooked mint)                                                             |       1,483 |                  620 |
| a compressed stake with a 4-node proof                                                                                                      |       1,166 |                    — |
| `craft`: 8 burned for 1 new / 4 burned and 4 used for 2 new and tokens                                                                      | 966 / 1,172 |                    — |

Going live always makes the project's standing lookup table of its fixed accounts (a 56-byte header and 32 bytes an
address: about 0.00093 SOL plus 0.00016 SOL an address), and is refused without one (`E-NO-TABLE`) when a part's widest
transaction passes legacy size (the largest open, a settle, NFT bids, another collection's pNFTs in a farm): js/play
sends those as v0 from it, one prompt. A transaction its table doesn't cover goes as v0 with a lookup table the payer
makes first, then deactivates and closes, getting its rent back. A compressed proof longer than 4 nodes
needs a table.

## Costs

**Rent** is `(bytes + 128) × 5,080` lamports on devnet and mainnet; query `getMinimumBalanceForRentExemption` for the
real allocation. Rent is separate from token amounts, loot's fees, the oracle's fee and network fees.

| Account                                                             |                                                                                                                                          Bytes |                    Rent, lamports | Back                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------: | --------------------------------: | ------------------------------------------------------------------------------------------------------- |
| Platform                                                            |                                                                                                                                             73 |                         1,021,080 | never                                                                                                   |
| Project, no collection / one                                        |                                                                                                                                      153 / 185 |             1,427,480 / 1,590,040 | never (+162,560 a collection)                                                                           |
| Order                                                               | sized to its box (`orderBytes`): up to 41 bytes a prize its draws can set aside, and for a box that gives items 4 a table row a draw may carry |                      by its bytes | player, at settle or refund                                                                             |
| Stash, one NFT / four                                               |                                                                                                                                      103 / 211 |             1,173,480 / 1,722,120 | +182,880 an NFT (36 bytes); to whoever takes NFTs out by hand                                           |
| Table: header / a row of numbers / a row of labels                  |                                                                                                                                    51 / 8 / 40 |      909,320 / +40,640 / +203,200 | never (the owner, as it writes rows)                                                                    |
| Profile, `xp` and `level`                                           |                                                                                                                                             98 |                         1,148,080 | never; 69 bytes empty, an attribute 8 bytes plus key and value                                          |
| Seat                                                                |                                                                                                                                            176 |                         1,544,320 | player, last exit                                                                                       |
| A farm's record of ends: its first bytes / a new end time           |                                                                                                                                         7 / 44 |                 685,800 / 223,520 | never: the owner its first bytes, whoever writes each new time its record, spare rent first             |
| Hold (a loan's 243)                                                 |                                                                                                                                            170 |                         1,513,840 | whoever made it, at release                                                                             |
| Sheet, empty / one attribute                                        |                                                                                                                                        69 / 83 |             1,000,760 / 1,071,880 | never; an attribute is 8 bytes plus key and value                                                       |
| `Proven`                                                            |                                                                                                                                            299 |                         2,169,160 | prover, via `close_leaf`                                                                                |
| Traits root                                                         |                                                                                                                                             97 |                         1,143,000 | never                                                                                                   |
| Contest entry (in its list): tokens / an NFT                        |                                                                                                                                  43 / 83 bytes |                 218,440 / 421,640 | never: to the treasury at the contest's close                                                           |
| Lottery entry (in its round): plain, + a recipient, + an NFT ticket |                                                                                                                             40, +32, +32 bytes |               203,200 a plain one | never: to the treasury at the round's close; the round's header is its first buyer's, back at the close |
| Listing, sale / rental (no shares)                                  |                                                                                                                                      183 / 189 |             1,579,880 / 1,610,360 | maker, close                                                                                            |
| A wallet's counts: header / a record                                |                                                                                                                                         7 / 28 |                685,840 / +142,240 | never                                                                                                   |
| A grant's shard: header / a wallet's record / a round paid          |                                                                                                                                    7 / 28 / 16 |      685,840 / +142,240 / +81,280 | to the owner when the shards close after the grant                                                      |
| Token account / Token-2022 ATA / with transfer fee                  |                                                                                                                                165 / 170 / 182 | 1,488,440 / 1,513,840 / 1,574,800 | on close                                                                                                |

Variable records (items, boxes, lotteries, grants, farms, contests, auctions, offers) are sized to their fields;
`accountBytes` and `xsolana_cost` price a given one. A farm with both vaults is about 0.0045 SOL and never closes; a
project's vault for a mint never closes either.

**Other costs:**

- **Fees**: 0.002 SOL player, 0.00001 SOL project (defaults).
- **An order** holds its rent and the player fee, nothing more. Whoever settles pays what the settle opens or mints
  (a collectible's Core asset, a token account, a Sheet, a stash's row, the fate's writes); the player gets the
  order's rent back when it closes (and the fee too, on a refund). js/play funds the throwaway key that settles with
  `settleRent`: `SETTLE_RENT_UNIT` (0.006 SOL, a client's own figure) for each prize that may open an account, for each
  draw of each open, and once an order for each source of tokens and the NFT it rolls on; the key gives back what it
  doesn't spend. Every open, and asking a waiting roll, costs the oracle's fee.
- **A `buy`** costs the price, the fee and what its prizes open or make; no order, no oracle.
- **Prizes** cost what they make, paid by the sender (a grant's funds for a grant): the winner's token account if
  missing (1,488,440 lamports), a new Core asset (about 0.004 SOL), a roll's order (sized to its box, back at
  settle). Putting an NFT in a stash: the project fee and 182,880 lamports (the first also opens the stash); a
  Token Metadata NFT also opens the project's token account of it, returned when it leaves.
- **Tables**: the owner pays each row's rent as it writes it, never back: about 0.2 SOL for 1,000 labels, 4.1 SOL
  for 100,000 numbers, 53 SOL for a full 10 MiB account.
- **Compressed NFTs**: a tree is paid once, about 0.23 SOL for 16,384 NFTs and 0.42 SOL for 1,048,576, plus its
  Bubblegum config; each Bubblegum move costs its fee (about 6,000 lamports).
- **Growth and locks on NFTs**: about 0.0004 SOL a new key, 0.0002 SOL for a lock key, the first time.

**Compute units** (a selection, measured on 0.20 with the test environment's token programs; 0.22's draws are in
[Limits](#limits); devnet and mainnet run p-token,
where token moves cost less: `pay` with 4 shares 41,065, a collectible's settle with 4 shares 93,862, `open_box`
58,088, `refund` 22,004):

| Instruction                                                                                                                              |                                    CU |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------: |
| `pay`: all to the treasury / 4 shares                                                                                                    |                       23,540 / 69,563 |
| `open_box` / 8 entries                                                                                                                   |                       64,056 / 73,759 |
| `open_box` with a collectible shown for odds                                                                                             |                                76,869 |
| `callback_roll` (8 entries)                                                                                                              |                                26,861 |
| `settle`: a collectible, a pool, a burn / 4 shares                                                                                       |                      96,949 / 122,713 |
| `refund`                                                                                                                                 |                                28,072 |
| `roll` / `callback_random`                                                                                                               |                        24,292 / 3,313 |
| `draw_lottery` / `callback_lottery` (3 places, 60 contributions)                                                                         |                       25,763 / 11,503 |
| `buy_tickets` / `finish_lottery_contribution` / a winner's place (0.20's; 0.23 has `draw_lottery` and `pull` instead, not measured here) |        43,079 / 45,819 / about 38,500 |
| `open_farm`: tokens / NFTs                                                                                                               |                       58,817 / 48,293 |
| `stake_tokens` / `stake_nft` frozen / escrowed                                                                                           | about 51,500–54,400 / 74,846 / 68,765 |
| `open_contest` / `decide` (2 shares)                                                                                                     |                       54,098 / 43,869 |
| `open_auction` / `bid` / `end_auction`                                                                                                   |              50,919 / 45,646 / 67,113 |
| `hold` / `release`                                                                                                                       |                       32,663 / 28,677 |
| `craft`: 1 burned for 1                                                                                                                  |                                75,043 |
| `claim_grant`: voucher, an item / open, a stash NFT                                                                                      |                       76,390 / 64,580 |
| `stash` in or out                                                                                                                        |                   about 31,500–36,100 |

A pNFT stake takes about 191,000 CU and a compressed proof and stake about 162,000, past the 200,000 default only
narrowly: set a higher limit. A grant claim whose receipt held 256 rounds used 142,439 (0.20). Third-party transfer hooks can
need more, or refuse.
