# The loot program: how it behaves

loot is one shared Solana program that runs game and community economies, built on with `js/client` or the
`xsolana_*` tools.

**Version 0.29.0** runs on two clusters:

- On **devnet**: program ID `xgamesVsZBpCVgJuatfYAFJRmQoccfQf5qtUFNp2Eet`, since slot 524,113,825 (2026-11-19).
- On **mainnet**: program ID `xgames8C758PyweWB9sDw8evvwsTVwyA2fGRUeAXVPy`, since slot 471,855,650 (2026-11-20). It is
  the same source built for that address.

loot has a separate address on each cluster. Nothing signed for one cluster (a voucher, a verdict, a link) counts on
the other. Where this reference refers to the program's address, it means devnet's, the address loot keeps there.

Records written under 0.28.0 don't load under 0.29.0's layouts, so make fresh economies. See [Upgrades](#upgrades).

loot is **not independently audited**.

This reference describes 0.29.0, the build its IDL comes from. **The IDL in `js/client/idl/loot.json` is the authority
for every account layout, argument and error code.** Where this page and the IDL differ, the IDL is right. Client
builder names appear in `code` where they help (`openBoxIx`). A cost measured on an earlier build names that build.
What each version changed is in the [changelog](../CHANGELOG.md). To build an economy, start with the
`xsolana-economy` skill and `xsolana_guide`, not here.

## The rules it keeps

- **It restricts a project only where it must.** `xsolana_check` warns about a project's own risky setup in plain
  words. It does not refuse it. The program keeps no limit that only guards a project against itself, such as a screen
  on tokens, a limit on times, a cap on a list, or a refusal of a value of 0. Each value is bounded only by what the
  chain allows ([Limits](#limits)).
- **Both sides of an exchange move in one instruction.** An auction's seller is paid only together with the lot, in
  all three endings of `end_auction`. A loan's repayment returns its NFT to the borrower (`repay(home)`).
- **A prize never shifts to a later round.** A lottery names where its places are paid from (`PaysFrom`). There are
  two options:
  - Each round's own ticket money. What the places leave goes where the project says.
  - A pot kept from round to round (at most 16 per lottery, `["pot", lottery, id]`). The pot's next ask always first
    moves in what the previous round left it (`Lottery::owing`).

  A contest's winners share the amounts the decision wrote (`pot_won`, `prize_won`), whatever reaches the contest's
  accounts later. A box that stops selling when out of stock covers each purchase: each account that entries share must
  hold the most any of those entries takes in one draw. A free roll never loses draws because its own earlier draws
  emptied an entry.

- **A prize is a fixed amount** on every route. **A draw uses the written weights.** A draw that can't be given
  returns its worth. A roll's odds are read at its first ask, from its player's profile and an NFT the player shows.
- **An edit never loses what was spent.** **Deadlines count in seconds.** **A run missed is missed**: a schedule does
  not pay a missed run later. **A seat past its end is paid exactly** up to that end (`["ends", farm]`, `walk_farm`).
  **A seller who can't be paid is owed** the payment.
- **Whoever settles an order pays for what the settle opens or mints.** Every box open asks the oracle. A box with
  nothing random sells with `buy` instead.

## The whole program in one screen

loot is one Solana program that every project shares. A **project** is one record owned by a wallet. Each wallet
numbers its own projects (`["project", creator, id]`) and may have any number of them. A project has no token or
collection of its own. Each mechanic names the mint it takes, and each item names the Core collection it is minted
into. The project names the Core collections it has authority over (any number). The program has 60 instructions,
each general enough for many uses.

A signature proves only what the chain can't see. Whoever sets something up signs once: the owner signs a mechanic, a
seller an auction, a player a purchase. After that, anything the chain can check (a roll, a time, a stake, a bid) runs
without anyone's signature. Only an event off the chain, such as who won a match, needs a key to vouch for it.

Value moves in five ways. Every move in a project's economy leaves a public receipt in the log.

| Verb                                                 | Instructions                                | Who signs                                                                               |
| ---------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| **In**: money or an NFT comes in                     | `pay`, `pay_nft`, `buy`, `open_box`         | The player. Anyone can sign `pay` (for example a sponsor, or the owner funding a pool). |
| **Out**: the project's tokens move                   | `move_tokens`                               | The authority.                                                                          |
| **Make**: collectibles are made, rewritten or burned | `collectible`                               | The authority.                                                                          |
| **Decide**: the project names an outcome             | `release`, `open_contest`, `decide`, `roll` | The authority. A contest's deciders sign verdicts, and anyone can send them.            |
| **Grant**: a voucher names a winner                  | `claim_grant`                               | The winning wallet, with a voucher, a list proof, or nothing for an open grant.         |

The owner writes each mechanic once (`upsert`, or `open_farm`). After that, players and anyone else carry it out.

| Mechanic         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Box** and shop | A weighted roll of entries. Each entry is any number of prizes, or nothing (a `Burn` share burns the payment). A **pack** makes several draws per open (`slots`) and several opens per purchase (`count`), all from one oracle answer. A box of one entry with nothing random is a shop item, a bundle or a fixed pack, sold in one instruction (`buy`, a `count` at a time). A box can roll **on an NFT** (an enchant, an upgrade, a trade-in). |
| **Table**        | Weighted rows (labels or numbers) with stock, written in batches and then sealed. A fresh item's traits are drawn from it.                                                                                                                                                                                                                                                                                                                       |
| **Schedule**     | Moves the project's tokens on a timer (vesting). A sealed schedule pays from a vault that only its runs pay out of.                                                                                                                                                                                                                                                                                                                              |
| **Lottery**      | Ticket money held apart, a draw, and any number of places. Covers raffles, a minimum sale, free tickets, NFT tickets and no-loss rounds.                                                                                                                                                                                                                                                                                                         |
| **Farm**         | Stakes tokens or NFTs of any kind, with lock tiers and boosts. Pays from a shared rewards pool or at a fixed rate. Keeps points and levels. Gives mission prizes and rolls. Each seat earns until a set time (its tier's term, or its NFT's fuel).                                                                                                                                                                                               |
| **Recipe**       | Takes collectibles, NFTs and tokens in and gives prizes out. Can raise numbers on what the player keeps.                                                                                                                                                                                                                                                                                                                                         |
| **Hold**         | A player hands an NFT to the project until a time they choose.                                                                                                                                                                                                                                                                                                                                                                                   |
| **Offer**        | Any wallet's money for any NFT that passes a rule: a bid, or a loan against the NFT.                                                                                                                                                                                                                                                                                                                                                             |
| **Listing**      | Any wallet's NFT for sale, or for rent by the period.                                                                                                                                                                                                                                                                                                                                                                                            |
| **Contest**      | Players back a side with tokens, or with one NFT each. The named side shares the pot.                                                                                                                                                                                                                                                                                                                                                            |
| **Auction**      | The highest bid at the end wins a lot: a new item, a roll of a box, or an NFT.                                                                                                                                                                                                                                                                                                                                                                   |
| **Grant**        | A reward that others hand out, within limits the program keeps.                                                                                                                                                                                                                                                                                                                                                                                  |
| **Stash**        | NFTs of any kind that the project holds to give away as prizes. Each NFT has a weight in the draws.                                                                                                                                                                                                                                                                                                                                              |
| **Profile**      | Numbers the project keeps about a wallet (XP, level, rank). Rules read them the same way they read an NFT's attributes.                                                                                                                                                                                                                                                                                                                          |

**Chance** comes from MagicBlock's VRF oracle. It drives box rolls, lottery draws, and `roll` for the project's own use.

**Incarnations.** A project numbers its contests, grants and lotteries with incarnations that only increase. A record
written again at an old address is a new identity. Entries, verdicts and vouchers name the incarnation they were signed
for. A grant's records and a lottery's rounds carry the incarnation in their addresses. A box purchase names the box's
`version`. A ticket purchase names the lottery's incarnation and `revision`.

**The project's vault for a mint** is the project's associated token account for that mint. It holds open orders'
payments, prizes set aside, and the money of bids and offers. Only the record that an amount belongs to can pay it out.
The vault never closes and nothing sweeps it, so a purchase never write-locks the project. Pools never close either,
so a pool index always keeps its mint.

## Who signs

A project has two keys: its **owner** and its **authority**. Both are trusted, and so is whoever controls the
project's Core collections. The program keeps players safe from each other, from the platform and from mistakes. It
does not keep them safe from the project they chose to play.

| Role                                                           | Signs                                                                                                                                                                                                                                            | Cannot                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Player**                                                     | What they pay, and the most they will pay.                                                                                                                                                                                                       | Be charged more than they signed for.                                                                                                                                                                              |
| **Authority**                                                  | Anything that leaves a pool or is made on the project's say-so (`move_tokens`, `collectible`, `roll`). Opens and decides contests. Releases a hold while it runs. No caps.                                                                       | Pay out of the vaults that hold orders, prizes set aside, bids, offers, farms, or contest or lottery pots. Move a held NFT after its hold ends. Touch a loan's NFT, a listed NFT, or an auction it did not put up. |
| **Owner**                                                      | The project's settings (`update_project`: keys, treasury, pause, collections). Every mechanic (`upsert`, `open_farm`, `open_pool`).                                                                                                              | The same as the authority: pay out money that belongs to a record.                                                                                                                                                 |
| **Owner or authority**                                         | `stash`, `open_tree`, `set_traits`.                                                                                                                                                                                                              | Take a raffle's promised NFT out of its lottery's stash.                                                                                                                                                           |
| **Platform**                                                   | Its two fees, `collect_fees`, and the suspend switch.                                                                                                                                                                                            | Stop a payout, settle, refund or unstake. There are two exceptions: see [the switches](#the-switches).                                                                                                             |
| **Voucher keys**                                               | Who earned a grant. Up to 3 keys named, or any number under a key root.                                                                                                                                                                          | Give more than the grant's limits.                                                                                                                                                                                 |
| **Grant winner**                                               | Its own claim, always.                                                                                                                                                                                                                           | — (anyone may pay its fees)                                                                                                                                                                                        |
| **Deciders**                                                   | A contest verdict. There can be any number of deciders, named when the contest opens. Anyone can send the verdict.                                                                                                                               | Name a side before entries close.                                                                                                                                                                                  |
| **Offer or listing maker**                                     | Their own offer or listing, alone.                                                                                                                                                                                                               | — (the project's keys have no say over it)                                                                                                                                                                         |
| **Auction seller**                                             | `open_auction`, and calling off an auction with no bid.                                                                                                                                                                                          | Stop the auction once a bid is in.                                                                                                                                                                                 |
| **Anyone**                                                     | Refund. Draw and finish a lottery. Release an ended hold. Claim a called-off contest's entry, or a loser's NFT once no winner has picks left. End an auction. Repay a loan. Refresh a seat. Run a sealed burn. Prove a compressed NFT or traits. | —                                                                                                                                                                                                                  |
| **Its player or the project's keys**                           | `ask_roll` (only its player, on a box with no entry in stock).                                                                                                                                                                                   | —                                                                                                                                                                                                                  |
| **Its player, the project's keys or the key its player named** | Settle (`settler`, named at `openBoxIx` or in the player's own `askRollIx`).                                                                                                                                                                     | —                                                                                                                                                                                                                  |
| **The winner or the project's keys**                           | A winner's first contest claim, for 30 days from the decision (`CLAIM_GRACE_SECONDS`). After that, anyone.                                                                                                                                       | —                                                                                                                                                                                                                  |
| **The project's keys or who it pays**                          | Run a schedule.                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                  |

Only the owner signs to set a new authority or treasury; the new key does not sign. So a multisig vault, a server key
or any wallet can take a role.

The program refuses a key that it can tell nobody signs for (`BadKey`). Such keys are a loot account, a token account
or mint pasted as a wallet, and a program. A typo that nobody holds looks the same as a real wallet, so the owner must
check the key.

## What the program protects, and what it does not

**It promises:**

- A player pays no more than they signed for. They pay the player fee once for what they ask for, never for the steps
  that follow.
- Money held for a record leaves only by that record's rules. These records are an order, a prize set aside, a bid,
  an offer, a farm's stakes and rewards, a contest's pot, a lottery's pot and tickets, and a sealed schedule's vault.
  Neither project key can pay this money out.
- No payment waits on a token account. The program opens the account it pays into. The sender can't steer a share
  elsewhere: the program refuses a wrong account in a share's place.
- Nothing the platform signs stops a payout, settle, refund or unstake. The one exception is a recipe with a paid line.
- A bid that is topped goes back in the same instruction. An auction with a bid runs to its end, and sells whenever it
  is ended.
- A voucher key never gives more than its grant's limits. A grant round pays a wallet once per incarnation.
- An order rolls only on the box version it paid for, and what was rolled stays rolled.
- Anyone can finish whatever is decided, with no deadline.

**It does not protect against:**

- **The project.** The owner and the authority are trusted. The authority mints, moves pool funds, writes the
  project's NFTs, decides contests and releases running holds.
- **A collection's controller.** A freeze, a transfer rule, a permanent transfer or burn delegate, or a pNFT rule set
  can make an NFT refuse to move, or can move it, even while the project holds it. Routes that need the NFT to move
  then wait. Offers, raffles, players' auctions and listings trust the collection they name.
- **A mint's issuer.** A freeze authority, a pause, a transfer hook or a permanent delegate can stop that mint's
  transfers or take its tokens. For lottery pots and tickets, contests, auctions, offers and sealed schedules, loot
  refuses mints that could hold waiting money hostage. It can't remove an issuer's power, though. USDC has a freeze
  authority.
- **Off-chain truth.** Voucher keys, deciders and result servers are trusted to report truthfully. The program checks
  their signatures, limits and replays, not what happened.
- **A typo** in a wallet the owner names.
- **Chosen shares as referrals.** A buyer-chosen share is a rebate that the buyer directs, and it can come back to
  them. A grant's vouchers can prove a referral. A chosen share can't.

The hosted keeper is optional. Any client can send refunds, draws and cleanups. A client can also send settles with a
key the player or project gave it. No client can substitute a winner or bypass the program's checks.

## Accounts and addresses

Every address is a PDA of the program (`pda.*` in `js/client/pda.js`). Seed integers are little endian, with these
widths:

- u64: a project's `id` and an order's `nonce`.
- u16: a pool's `index` and a grant's `id`.
- i64: a hold's `free_at`.
- u8: a shard and a page.
- u32: every other id.

Each loot account starts with a one-byte tag (`TAGS`, `decodeAny`). A record that must be new (farm, contest,
auction, order, offer) is always created, never written over.

| Tag | Account                      | Address                                                                                                                                                                                                                  | Bytes                                                                                                                                                             | Rent paid by                                                                                                                                                   |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Platform`                   | `["platform"]`                                                                                                                                                                                                           | 73                                                                                                                                                                | The platform, once.                                                                                                                                            |
| 2   | `Project`                    | `["project", creator, id]`; fee box `["fees", project]`                                                                                                                                                                  | 153, + 32 per collection                                                                                                                                          | The owner. Never closed.                                                                                                                                       |
| 3   | `Item`                       | `["item", project, id]`                                                                                                                                                                                                  | Varies (`name` at offset 86, right after `collection`; a fresh item's traits come after its URI)                                                                  | The owner, refunded on close.                                                                                                                                  |
| 4   | `LootBox`                    | `["box", project, id]`                                                                                                                                                                                                   | Varies                                                                                                                                                            | The owner. Never closed.                                                                                                                                       |
| 5   | `Order`                      | `["order", project, player, nonce]`                                                                                                                                                                                      | Sized to its box at purchase (`orderBytes`)                                                                                                                       | The player (or a prize's maker), refunded at settle or refund. Whoever settles pays for what the settle opens or mints.                                        |
| 6   | `Schedule`                   | `["schedule", project, id]`; sealed vault `["vest", schedule]`                                                                                                                                                           | Varies                                                                                                                                                            | The owner.                                                                                                                                                     |
| 7   | `Lottery`                    | `["lottery", project, id]`; pots `["pot", lottery, id]` (`pda.lotteryPot`, `id` below `MAX_POTS`, 16); own stash `["lottery_stash", lottery]`                                                                            | Varies                                                                                                                                                            | The owner. Whoever puts an NFT in the stash pays for its growth.                                                                                               |
| 8   | `Recipe`                     | `["recipe", project, id]`                                                                                                                                                                                                | Varies                                                                                                                                                            | The owner. Never closed.                                                                                                                                       |
| 9   | `Hold`                       | `["hold", asset, free_at]`                                                                                                                                                                                               | 170 (a loan's: 243)                                                                                                                                               | The player or borrower (`payer`), refunded on release.                                                                                                         |
| 10  | `Contest`                    | `["contest", project, id]`; pot `["pot", contest]`; split prize `["prize", contest]`                                                                                                                                     | Varies                                                                                                                                                            | The opening authority, refunded on close.                                                                                                                      |
| 12  | `Sheet`                      | `["sheet", project, nft]`                                                                                                                                                                                                | 69, + attributes                                                                                                                                                  | Whoever's write grows it (a write that shrinks it refunds nobody). Anyone can close it once its NFT is burned; the rent goes to the treasury.                  |
| 13  | `Traits`                     | `["traits", project, key]`                                                                                                                                                                                               | 97                                                                                                                                                                | The owner or authority. Never closed.                                                                                                                          |
| 16  | `LotteryRound`               | `["round", lottery, incarnation, round]`; its token accounts `["round-tokens", round, mint]`                                                                                                                             | A header sized once at its first purchase, then one entry per purchase (`entryWidth`: 40, + 8 for a fee mint, + 32 for a recipient share, + 32 for an NFT ticket) | The first buyer pays for the header (refunded at the close). Each buyer pays for their entry (the rent goes to the treasury at the close).                     |
| 17  | `Farm`                       | `["farm", project, id]`; vaults `["staked", farm]`, `["rewards", farm]`                                                                                                                                                  | Varies                                                                                                                                                            | The owner. Never closed.                                                                                                                                       |
| 18  | `Seat`                       | `["seat", farm, player]` (tokens), `["seat", farm, asset]` (an NFT)                                                                                                                                                      | 176                                                                                                                                                               | The player, refunded on the last exit.                                                                                                                         |
| 19  | `Proven`                     | `["leaf", asset]`                                                                                                                                                                                                        | 299 (331 with asset data)                                                                                                                                         | The first prover, refunded via `close_leaf`.                                                                                                                   |
| 20  | `Auction`                    | `["auction", project, seller, id]`                                                                                                                                                                                       | Varies, + 32 for an NFT bid                                                                                                                                       | The seller, refunded at the end.                                                                                                                               |
| 22  | `Offer`                      | `["offer", project, maker, id]`                                                                                                                                                                                          | Varies                                                                                                                                                            | The maker, refunded on close.                                                                                                                                  |
| 23  | `Listing`                    | `["listing", project, asset]`                                                                                                                                                                                            | 183 for a sale / 189 for a rental, + 3–35 for a share                                                                                                             | The maker, refunded on close.                                                                                                                                  |
| 24  | `Profile`                    | `["profile", project, wallet]`                                                                                                                                                                                           | 69, + attributes                                                                                                                                                  | Whoever's write grows it (a write that shrinks it refunds nobody). Never closed.                                                                               |
| 25  | `Table`                      | `["table", project, id]`                                                                                                                                                                                                 | 51, + 8 per row of numbers / 40 per row of labels                                                                                                                 | The owner, as it writes rows. Never closed.                                                                                                                    |
| 25  | `Table` (a stash)            | `["stash", project, id]`; a lottery's own `["lottery_stash", lottery]`                                                                                                                                                   | 103 with one NFT, + 36 per NFT                                                                                                                                    | Whoever puts an NFT in. Never closed.                                                                                                                          |
| 26  | a list (`decodeList`)        | a wallet's counts `["counts", project, wallet]`; a grant's claims `["claims", grant, incarnation, shard]` and rounds `["rounds", grant, incarnation, shard]`; a contest's entries `["entries", contest, incarnation, 0]` | 7, + 28 per limit record, 16 per round paid, 43 or 83 per entry                                                                                                   | The one counted (a grant's funds pay for a claim); never closed. A grant's shards close once the grant is gone (rent to the owner). A contest's close with it. |
| 27  | `Grant`                      | `["grant", project, id]`                                                                                                                                                                                                 | Varies                                                                                                                                                            | The owner, refunded with the funds on close.                                                                                                                   |
| 29  | a farm's ends (`decodeEnds`) | `["ends", farm]`, for a farm that keeps one (`Farm.keeps_ends`)                                                                                                                                                          | 7, + 44 per waiting time                                                                                                                                          | The owner pays for its first bytes, and each time's sender for that time's record. Never closed.                                                               |

Other addresses:

- A **pool** is a plain token account at `["pool", project, index]` that only the project spends from. The owner opens
  it (`open_pool`), and it is never closed.
- Every collectible that loot mints on its own (an order's, a prize's, a craft's, an auction lot's) is at
  `["asset", item, serial]` (`pda.itemAsset`). Each serial is handed out once, so the address is always new and the
  sender signs alone.

A `Project` resizes only when `update_project` changes its collections. The owner pays for the growth and gets the
shrink back. Tag 21 is unused. A stash is a table of NFTs, each row holding its weight and its address (36 bytes), so
an account's 10 MiB holds some 290,000 NFTs.

**Tables** are read in place, never loaded whole. Rows are kept in blocks of 64, each block led by its weight in
stock. Blocks are kept in groups of 64, each group led by its own weight. These totals stay current as rows are added
and stock runs out. Writing and sealing a table of any size costs only the transactions that write its rows. A draw
reads a few hundred numbers, even at a million rows.

## Every instruction

The IDL lists each instruction's arguments.

- **Data.** Each instruction's data starts with a 1-byte tag, the IDL's `discriminator`. The oracle's three callbacks
  keep 8-byte tags. `instructionOf` finds an instruction by its tag. The program does not log instruction names.
- **Account order.** An instruction's own accounts come first. The remaining accounts follow, in the order the builders
  produce them. The **tail** comes last.
- **The tail.** The tail starts at the Memo program's account. It holds the accounts that a transfer hook or a Core
  collection's check reads (`tailOf`). With no Memo account, the tail is empty.
- **Optional accounts.** An optional account that is left out is passed as the program's own address.
- **Gates.** A player passes a **gate** in the first remaining accounts, after a box's prize accounts. A gate is one of
  these: a collectible the player shows (`Gate::Holds`); the list proof's nodes, passed as accounts (`Gate::List`); or
  the wallet's seat followed by the farm (`Gate::Staked`).
- **Fees.** In the Fee column, **P** is the player fee, **J** is the project fee, and **free** means no fee.

| Subject        | Instruction (builder)                                                      | Signs                                                                                                                                                                                                 | Fee                                           | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform       | `init_platform` (`initPlatformIx`)                                         | The program's upgrade authority, once.                                                                                                                                                                | —                                             | Creates the platform and its two fees.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                | `set_platform` (`setPlatformIx`)                                           | The admin (and a next admin).                                                                                                                                                                         | —                                             | Changes the fees or hands the admin role on. A fee raise waits 7 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                | `collect_fees` (`collectFeesIx`)                                           | The admin.                                                                                                                                                                                            | —                                             | Sweeps the projects' fee boxes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                | `set_suspended` (`setSuspendedIx`)                                         | The admin.                                                                                                                                                                                            | —                                             | Suspends or restores a project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Project        | `create_project` (`createProjectIx`)                                       | The owner.                                                                                                                                                                                            | J                                             | Sets `id`, `authority`, `treasury` and `collections`. Each collection is a Core collection whose update authority is the owner or the project. No collection may appear twice (`BadCollection`).                                                                                                                                                                                                                                                                                                                                                                                                                |
|                | `update_project` (`updateProjectIx`)                                       | The owner, and the new owner if one is named.                                                                                                                                                         | J                                             | Changes the keys, the treasury, `paused` and the collections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                | `open_pool` (`openPoolIx`)                                                 | The owner.                                                                                                                                                                                            | J                                             | Opens pool `index` in a mint. The pool is permanent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `upsert` (`upsertIx`, `closeRecordIx`)                                     | The owner.                                                                                                                                                                                            | J                                             | Writes an `Item`, `Box`, `Schedule`, `Lottery`, `Recipe`, `Grant` or `Table`. A table's rows are written in batches, then the table is sealed. `None` closes a record. When a box, recipe, grant or lottery names a box to roll, the instruction passes each such box once, and only the box (`boxesAccounts`, `defRolls`). A box that has not been written fails with `WrongRecord`. What the box can give is read later, when its roll is asked and answered. A box's own roll accounts must fit the oracle's answer (`TooManyAccounts`). Write a box before any record that names it. A box may name itself. |
|                | `open_farm` (`openFarmIx`)                                                 | The owner.                                                                                                                                                                                            | J                                             | Opens a farm. A farm is never edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                | `open_tree` (`openTreeIx`)                                                 | The owner or the authority.                                                                                                                                                                           | J                                             | Opens a Bubblegum v2 tree for compressed prizes. The sender first creates the empty tree account (`treeSize`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                | `set_traits` (`setTraitsIx`)                                               | The owner or the authority.                                                                                                                                                                           | J                                             | Sets the root of the off-chain traits the project vouches for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| In             | `pay` (`payIx`)                                                            | Anyone.                                                                                                                                                                                               | P, or J for the project's keys                | Splits `amount` among any number of shares. Each share is its own transfer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                | `pay_nft` (`payNftIx`)                                                     | The holder.                                                                                                                                                                                           | P, or J                                       | Gives any NFT to a wallet, or burns it. The NFT never goes to a loot account (`ToTheProject`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Boxes          | `buy` (`buyIx`)                                                            | The player.                                                                                                                                                                                           | P                                             | Buys from a box with one entry, nothing random and no subject (`Rolls`). Makes `count` sales: at least 1, at most 25,454, the most one transaction can price (`PackTooLarge`, `MOST_SALES_A_BUY`). Each sale is at the price the sale before it left. One `max_price` covers all sales. Each sale counts against `per_wallet`. The price is split. The entry's prizes are given `draws × count` times (`buyGives`). A fixed amount of tokens is given once, as the whole amount. Any other prize is given once per draw, with its rolls at `nonce`, `nonce + 1`, …. All of this happens in one instruction.     |
|                | `open_box` (`openBoxIx`)                                                   | The player.                                                                                                                                                                                           | P, held in the order                          | Makes `count` opens in one purchase. A `count` above 1 works only for a box with no `subject` (`BadEntries`). More than 300 draws in all, the most one answer could weigh, is refused before any price is added up (`PackTooLarge`, `MOST_DRAWS_A_PURCHASE`). Each open is at the price the one before it left. The price goes into the vault, an order is made, and the oracle is asked. The oracle's accounts are required, because every box opened asks the oracle, even one with nothing random.                                                                                                           |
|                | `callback_roll`                                                            | The oracle.                                                                                                                                                                                           | —                                             | Draws every card of every open from one answer and sets aside what each open won. It takes at most 21 accounts. It sets aside a fresh item's tables only while they fit the box's table budget.                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                | `settle` (`settleIx`)                                                      | The order's player, the project's keys, or the key the player named. The signer pays for what the settle opens or mints.                                                                              | free                                          | Settles one part of an order. It delivers what was won from where the last part stopped, up to `upto` (`settlePartEnd`). An `upto` past the end (`SETTLE_LAST`) makes this the last part. An `upto` of 0 only splits the payment. `prize_accounts` is how many of its accounts are the prizes' accounts. The last part pays the split, carries out the NFT's fate and closes the order. An NFT of the order that is proven gone is skipped (`NftGone`). The NFT rolled on is then not sent back, burned, given or stashed. A won stash NFT that is gone is not given (`PrizeForgone`).                          |
|                | `refund` (`refundIx`)                                                      | Anyone.                                                                                                                                                                                               | free                                          | Refunds an order (`orderRefundable`): a failed order, from the next slot; a pending order, after 10 minutes; an asked order that holds a payment or an NFT, 7 days after its first ask. The refund names the order's box while the order counts draws in the box's `in_flight` (`Order.reserved`). It never refunds a rolled or waiting order. If an NFT the order holds is proven gone, the refund does not look for it and still returns the whole payment (`NftGone`).                                                                                                                                       |
|                | `ask_roll` (`askRollIx`)                                                   | The order's player or the project's keys. The signer pays the oracle.                                                                                                                                 | free                                          | Asks for a waiting roll. The first ask reads the odds from the player's profile and from an NFT the player shows ([Rules](#rules-gates-odds-and-boosts)). It can ask again after `STALE_SECONDS` (10 minutes, `rollAskable`). On a box with no entry in stock, only the order's player can ask, and only in a later slot than the order's `requested_slot` (`SoldOut` otherwise).                                                                                                                                                                                                                               |
| Project moves  | `move_tokens` (`moveTokensIx`)                                             | The authority.                                                                                                                                                                                        | J                                             | Moves tokens from a pool, or mints them, to any `To`. The amount is fixed or a share of a pool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                | `collectible` (`collectibleIx`, `makeIx`)                                  | The authority.                                                                                                                                                                                        | J                                             | `Make { item, tree, attributes }` mints for several owners at the item's next serials, or compressed into `tree`. `Set` rewrites attributes (or a Sheet). `Burn` burns one and gives the rent to its holder. `Profile` writes a wallet's profile.                                                                                                                                                                                                                                                                                                                                                               |
|                | `roll` / `callback_random` (`rollIx`, `callbackRandomIx`)                  | The authority / the oracle.                                                                                                                                                                           | J / —                                         | Gets a random number for the project's own use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                | `stash` (`stashIx`)                                                        | The owner or the authority. Anyone, for the row of an NFT that is gone.                                                                                                                               | J                                             | Puts NFTs into a stash (or a lottery's own stash), each with its weight in the draws (above 0). Or takes NFTs out to a wallet. Anyone can remove the row of an NFT proven gone from a project's stash, for free. Nothing moves and no hold is made (`NftGone`, no `Stashed`). The rent the stash no longer needs goes to the signer only when the signer is the project's keys. A lottery's own stash stays with the project's keys, whether its NFT is gone or not.                                                                                                                                            |
|                | `run_schedule` (`runScheduleIx`)                                           | The project's keys or the wallet the schedule pays. For a sealed burn, anyone.                                                                                                                        | free                                          | A run pays once, for the latest run due. The runs before it lapse. A sealed fixed amount instead pays every due run up to `upto`, in one transfer (`runsDue`, `scheduleCatchesUp`).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Lotteries      | `buy_tickets` (`buyTicketsIx`)                                             | The player.                                                                                                                                                                                           | P                                             | Buys an entry in the current round. The round's first purchase opens it. The round's address names the incarnation. The purchase names the round's `revision` (`TermsChanged`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                | `draw_lottery` / `callback_lottery` (`drawLotteryIx`, `callbackLotteryIx`) | Anyone / the oracle.                                                                                                                                                                                  | free                                          | The first ask of a due round fixes the round's money and moves the lottery on. A round paid from a pot first moves in what the round before left it (`owing`). While that earlier round waits for the oracle, the ask is refused with `NotDue`. It can ask again after `STALE_SECONDS`. After 7 days with no answer (`lotteryCancellable`), the next ask cancels the round. `skip_hooked` (the authority) leaves hooked sources out.                                                                                                                                                                            |
|                | `pull` (`pullIx`, `pullRolls`)                                             | Anyone. The payer pays for the accounts it opens.                                                                                                                                                     | free                                          | Pays out one part (`partsOwed`, `commonOwed`). A part is an entry's own part, its places' parts or prizes in a run, or a part owed in common. A part owed in common is a share, or what the places leave, which goes to the pot or to `rest` (`leftoverTo`). The last part closes the round. An NFT ticket proven gone goes nowhere. Its part settles with no stash row, no burn and no gift (`NftGone`).                                                                                                                                                                                                       |
| Farms          | `stake_tokens` / `unstake_tokens` (`stakeTokensIx`, `unstakeTokensIx`)     | The player.                                                                                                                                                                                           | P                                             | Stakes tokens into a tier / takes them out. Unstaking 0 only harvests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                | `stake_nft` / `unstake_nft` (`stakeNftIx`, `unstakeNftIx`)                 | The player.                                                                                                                                                                                           | P                                             | Stakes an NFT on its own seat or as a booster / takes it out after the lock, with a mission's prize or roll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                | `harvest` (`harvestIx`)                                                    | The player.                                                                                                                                                                                           | P                                             | Takes the rewards out, or adds them to the stake (`compound`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                | `refresh_seat` (`refreshSeatIx`)                                           | Anyone. The signer pays what growth adds, and a new end time.                                                                                                                                         | free                                          | Re-reads the boosts, the NFT, upkeep and the player's profile. Writes growth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                | `walk_farm` (`walkFarmIx`, `walkFarmParts`)                                | Anyone.                                                                                                                                                                                               | free                                          | Credits a farm through at most `most` of the times its seats stopped earning. It is for a farm that has passed more of these times than one transaction can walk (`farmNeedsWalk`).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Recipes, holds | `craft` (`craftIx`)                                                        | The player alone.                                                                                                                                                                                     | P                                             | Moves all lines in and out, or nothing. Pass the player's `profile` when a need or a raise names it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `hold` (`holdIx`)                                                          | The player.                                                                                                                                                                                           | P                                             | Hands NFTs to the project until `free_at`, one hold each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                | `release` (`releaseIx`)                                                    | The authority while the hold runs (J). Anyone after it ends (free). For loans, see below. Anyone at any time for an NFT that is gone (free).                                                          | J / free                                      | Sends held NFTs on to one `to`. Each hold is named by its address. Pass `address` when the hold's `free_at` has changed since, as with a repaid loan's hold. A hold whose `player` is the project's own address is owed to the treasury. It goes to `project.treasury` as it is at that time (`releaseIx`'s `treasury`). `Released.player` is the wallet it went to. A hold whose NFT is proven gone closes instead. `to` is not read, the rent goes to the hold's payer, and a loan's debt stays unpaid (`NftGone`, no `Released`).                                                                            |
| Contests       | `open_contest` (`openContestIx`)                                           | The authority.                                                                                                                                                                                        | J                                             | Opens a contest. Its terms are fixed for good.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                | `enter` (`enterIx`)                                                        | The player.                                                                                                                                                                                           | P                                             | Adds a record to the contest's list. A wallet enters on one side only (`OtherSide`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `decide` (`decideIx`)                                                      | The authority, or anyone with a verdict. Anyone, for an overdue contest.                                                                                                                              | J; free when overdue                          | Names a side, or `None` calls the contest off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                | `claim` (`claimIx`)                                                        | The winner or the project's keys, when the claim gives a prize or picks. Otherwise anyone. For 30 days only the winner picks the losers' NFTs; after that the project's keys may too (`WinnerPicks`). | free                                          | Gives an entry its part of what the decision wrote (`contestWinnings`): of `pot_won`, and of `prize_won` for a split prize. Also gives its prize and the NFTs it names.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Auctions       | `open_auction` (`openAuctionIx`)                                           | The seller alone.                                                                                                                                                                                     | P for a player's NFT, J for the project's lot | Opens an auction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `bid` (`bidIx`)                                                            | The player.                                                                                                                                                                                           | P                                             | Tops the high bid. The topped bid goes back at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                | `end_auction` (`endAuctionIx`)                                             | Anyone, once the auction is over. The seller, to call off an auction with no bid. For `CallOff`: anyone, on proof that the lot or a winning NFT is gone; otherwise the project's keys.                | free (J for the project calling off its own)  | `ending` picks one of three endings ([Auctions](#auctions)):<br>`Deliver` pays out and hands the lot over in one instruction. If an NFT lot can't move, the instruction fails and the auction waits.<br>`LotFirst` hands the lot over now and leaves the bid owed to the next `Deliver`.<br>`CallOff` returns the bid and sends the lot home.<br>A sold roll lot pays out nothing: the bid stays in the vault as its order's payment. A sold lot is never made a hold.                                                                                                                                          |
| Offers         | `open_offer` (`openOfferIx`)                                               | The maker.                                                                                                                                                                                            | P, or J                                       | Opens a bid or a loan, with all its money in the vault.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                | `close_offer` (`closeOfferIx`)                                             | The maker.                                                                                                                                                                                            | free                                          | Returns what is left to the maker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                | `sell_to_offer` (`sellToOfferIx`)                                          | The NFT's holder.                                                                                                                                                                                     | P, or J                                       | Sends the NFT to the maker and the price to the seller.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                | `borrow` (`borrowIx`)                                                      | The NFT's holder.                                                                                                                                                                                     | P, or J                                       | Holds the NFT against a debt and sends the money to the borrower.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `repay` (`repayIx`)                                                        | Anyone, before `due`.                                                                                                                                                                                 | free                                          | Pays the repayment to the lender. The NFT must be shown to be still held (`NotTheNft`, `NotProven`). With `home`, the NFT goes to its borrower in the same call and the hold closes. Without it, the hold becomes a plain hold that is over, and anyone can `release` the NFT later. The call names the debt its payer was shown (`repay`; `TermsChanged` otherwise). In js/play: `loan()`, then `repay(asset, due, { repay })`.                                                                                                                                                                                |
| Listings       | `open_listing` (`openListingIx`)                                           | The NFT's holder.                                                                                                                                                                                     | P, or J                                       | Lists the NFT for sale or for rent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                | `take_listing` (`takeListingIx`)                                           | The taker. Anyone, for an NFT that is gone.                                                                                                                                                           | P, or J                                       | Buys the NFT, or rents it for 1 to `max_periods` periods. For a Token Metadata NFT, the call passes the project's token account for it (`project_token`). The program reads it to check that the project still holds the NFT. A listing whose NFT is proven gone closes instead, and its rent goes to its maker (`NftGone`). Anyone can send this close. It costs nothing and charges no fee, paused or not. It is refused while a rental runs (`Rented`).                                                                                                                                                      |
|                | `close_listing` (`closeListingIx`)                                         | The maker.                                                                                                                                                                                            | free                                          | Sends the NFT home. During a rental it only stops the listing. If the NFT is proven gone, a close sent once no rental runs closes the listing without the NFT (`NftGone`).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Proofs         | `prove_leaf` (`proveLeafIx`)                                               | Anyone. The signer pays the record's rent once.                                                                                                                                                       | free                                          | Records a compressed NFT proven against its tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                | `close_leaf` (`closeLeafIx`, `closeSheetIx`, `withLeafCloses`)             | Its payer, signing, at any time. Anyone, once the record no longer reads (`StillProven` otherwise).                                                                                                   | free                                          | Closes a compressed NFT's record. The client appends this close to the transaction that used the record.<br>Or closes a burned NFT's Sheet (`NotBurned` otherwise). For a Token Metadata NFT, the call names its edition (`edition`). The Sheet closes once the mint holds none, the mint authority is none or the edition, and the edition account is closed.<br>For a compressed NFT, the call passes its record proven empty as `tree` and its tree as `edition` (`closeSheetIx` with `tree`). The Sheet closes while the record still reads against that tree, or once the tree is gone.                    |
|                | `prove_traits` (`proveTraitsIx`)                                           | Anyone. The signer pays for the Sheet's growth.                                                                                                                                                       | free                                          | Writes vouched traits into a Sheet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Grants         | `claim_grant` (`claimGrantIx`, `js/client/grant.js`)                       | Always the wallet, plus a `signer` who pays. The `signer` may be the wallet.                                                                                                                          | P, from the signer                            | Gives the grant's prize for each round not yet paid. A voucher is an Ed25519 instruction right before it (`ed25519Ix`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                | `close_shard` (`closeShardIx`)                                             | Anyone.                                                                                                                                                                                               | free                                          | Closes a shard of a grant that is gone or made again. The rent goes to the owner. Before that, it fails with `GrantLive`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Persons        | `link_wallet` (`linkWalletIx`, `js/client/grant.js`)                       | The wallet, which pays the link's rent.                                                                                                                                                               | free                                          | Links the wallet to a person until `expires` ([Persons and links](#persons-and-links)). The issuer's signature of `linkBytes` is an Ed25519 instruction right before it (`ed25519Ix`).                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Money in, and where it goes

### The split

A split is a list of shares. Each share is a number of basis points and a destination (`To`).

- A stored split (on a box, order, lottery, contest, auction, offer or listing) holds at most 8 shares (`MAX_SHARES`,
  not in the IDL). A ninth share fails with `BadShares`.
- A `pay` split holds as many shares as its transaction can carry.

A step that pays many shares into accounts that are not open yet (an end or a settle) stays under the 64-instruction
trace limit when some of those accounts are opened first. Whatever the shares leave goes to the split's owner: the
treasury for a sale, and the seller for an auction, listing or offer.

| `To`                       | Paid to                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Burn`                     | Burned.                                                                                                                                                                                                                                                                                                                                                                                  |
| `Pool(index)`              | One of the project's pools.                                                                                                                                                                                                                                                                                                                                                              |
| `Account(key)`             | A named token account.                                                                                                                                                                                                                                                                                                                                                                   |
| `Wallet(key)` / `Treasury` | The wallet's (or the treasury's) associated token account for the mint.                                                                                                                                                                                                                                                                                                                  |
| `Holder(asset)`            | Whoever holds that collectible at that moment (for example, a plot's owner or an arena).                                                                                                                                                                                                                                                                                                 |
| `Chosen(item)`             | The buyer chooses the recipient at `open_box`, `buy` or `buy_tickets` (`chosen_recipient`). It is a wallet other than the buyer's or, with an item, a collectible of that item whose holder is paid. With no choice, a wallet share goes to the treasury. A collectible share needs a collectible that a player holds (`BadChoice`). In a contest, it is the wallet that `decide` names. |

**Every part is rounded down.** This covers a share, a schedule's or `move_tokens`' share of a pool, a place's share of
a pot, a contest claim and a price rise. The remainder from rounding goes with the rest of the money, or stays in the
pool or pot. A contest's claims add up to exactly what the decision wrote.

**Where money goes.** Money owed to a person goes to their associated token account. If that account does not exist,
the sender opens it and pays its rent, so a payment never waits.

In a stored split, a share that finds no recipient joins what the split leaves for its owner. Examples are a
collectible that nobody holds or that the project holds, a loot account as payee, and an account that can't take the
mint.

If the **split owner's** account fails, `pay`, `buy`, `take_listing`, `sell_to_offer` and `settle` fail, and the money
stays with the payer. The one exception is `end_auction` of a seller's NFT (`Lot::Asset`), which does not wait on a
seller's account that can't take the mint:

- The lot goes to its winner.
- The auction stays open with what it owes (`Auction.proceeds_owed`).
- The next `end_auction`, which anyone can call, pays that amount and closes the auction. It fails while the account
  still can't take the mint.

An auction lot that is a new item or a roll waits (`AccountFrozen`) while its treasury account is frozen, until the
account is thawed.

`move_tokens` and schedules fail with `BadMove` on a pool that was never opened or on the project's vault. `pay` also
fails with `BadMove` when a share goes into the project's own vault for its mint (`To::Account`), because nothing would
ever pay it out. A farm's rewards vault is not that vault, and `pay` can fund one. `pay`'s shares are separate
transfers, so a transfer fee comes out of each share.

### The fee

The platform sets two flat SOL fees in its platform account (`Platform.fees`), one account on each cluster. Each is
capped at **0.01 SOL** (`MAX_FEE_LAMPORTS`). A raise waits **7 days** before it applies (`NOTICE_SECONDS`); a cut
applies at once. The fees land only in the project's own fee box (`["fees", project]`). Only the platform takes them
out. The tools quote the fees each cluster's platform account holds (`FEES_ON` in `js/economy/model.mjs`); the
program charges what the account holds when the transaction runs.

| Fee         | Devnet      | Mainnet     |
| ----------- | ----------- | ----------- |
| **Player**  | 0.002 SOL   | 0.0005 SOL  |
| **Project** | 0.00001 SOL | 0.00001 SOL |

Devnet's player fee is the program's default and four times mainnet's. Devnet SOL is play money, so a fee as a share
of a devnet price overstates what the same action costs on mainnet.

| Fee         | Default     | When                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Player**  | 0.002 SOL   | A player signs for something of their own: `pay`, `pay_nft`, `buy`, `open_box` (held in the order and returned on refund), `craft`, `buy_tickets`, stake, unstake, harvest, `hold`, `enter`, `bid`, `open_auction` of their NFT, `open_offer`, `sell_to_offer`, `borrow`, `open_listing`, `take_listing`, and a grant claim (paid by the signer, never from the grant's funds).    |
| **Project** | 0.00001 SOL | The owner or authority acts as the project: `create_project`, `update_project`, `open_pool`, `upsert`, `open_farm`, `open_tree`, `set_traits`, `stash`, `move_tokens`, `collectible`, `roll`, a running hold's `release`, `open_contest`, `decide` (a verdict too), the project's `open_auction` or its call-off, and `pay`, `pay_nft`, offers and listings by the project's keys. |
| **Free**    | —           | Steps that follow from a paid step (claims, a round's pulls, auction ends, settles, refunds, repayments, closes), rolls that other steps make, and the cranks: callbacks, `ask_roll`, `draw_lottery`, `run_schedule`, `prove_leaf`, `prove_traits`, and writing down an overdue contest.                                                                                           |

When the project's keys sign on a route that asks for a player's signature, they pay the player fee. A signer with too
little SOL is refused (`NoSolForFee`).

### The switches

The owner's **pause** and the platform's **suspend** stop money and NFTs coming in from players. They stop:

- purchases, payments, tickets, entries, stakes and compounds, and holds;
- opening an auction, and bids on the project's own auctions;
- opening or taking offers and listings.

They never stop what is owed or given out:

- grant claims, settles, refunds, unstakes and harvests;
- lottery draws and payouts, contest claims, repayments and closes;
- auction ends and bids going back;
- recipes that take only NFTs.

A `pay` by the project's keys still goes through, so a paused project can fund its pools. A **player's** auction takes
bids whatever the switches say. Which auctions are the project's is fixed when the auction opens (`Auction.ours`).

A recipe with a `Pay` line waits on both switches. This has two effects:

- An **unbind** that charges keeps a bound set's pieces locked in their farms while the switch is on.
- A **refuel** that charges can't be bought while upkeep runs out. A suspension longer than a staked NFT's fuel marks
  its seat dry, and its mission prize is lost.

To avoid this, give unbinds and refuels no `Pay` line, or let players buy a whole mission's fuel ahead.

### Token accounts, SOL a record holds, writable mints

The program opens every token account it pays into. It opens the account in the instruction that pays, at the
signer's cost. This covers:

- the project's vault for a mint, at the first purchase or bid in that mint;
- the treasury's and payees' accounts;
- the receiver of a refund or a prize;
- an outbid bidder's account.

**Never a pool**: a `pay` or move into a pool that was never opened fails. The project's own accounts (pools, farm
vaults, pots) open with their record.

An order holds its rent and the player fee, nothing more. Whoever settles the order pays for what the settle opens or
mints: Core assets, token accounts, Sheets, stash rows and the NFT's fate. A player who settles their own order pays
for their own prizes.

js/play funds a throwaway key that settles, with what the settle may open or mint (`settleRent`; `SETTLE_RENT_UNIT` a
prize, a client's own figure). It takes back what the key didn't spend. Each order has its own key, named by the order.
A page that closed before the settle finds the key again (`recover()`). The key comes from one of two sources:

- One signature by the wallet per session, over a fixed text naming the project and the wallet. The seed is
  sha256("loot settle key" | signature | order). This works because ed25519 signatures are deterministic.
- For a wallet that signs no messages, or signs that text differently in a later session: a random key kept in the
  page's storage. The key is encrypted with a device key that the page can use but never read out (`keyStore`,
  `browserStore()`).

A grant holds its own funds. It lends them to the claim's signer for what the prize opens or makes, so a grant claimant
needs only the fee. The treasury is a wallet. If its owner closes its account for a mint, the next sale reopens it.

Pass a mint as writable only when its supply changes (a burn or a mint), so that transactions in one token don't queue.
A mint is writable for:

- `pay`, `buy`, `settle` and a sale's `end_auction`, when something burns;
- `move_tokens` and `run_schedule`, when minting or burning;
- `decide`, when a share burns or it calls off an empty contest;
- `claim`, when it leaves nothing owed;
- a minted token prize's `pull`, and a round's close (its mints, with the accounts it closes);
- a recipe's `Pay` lines, always.

The builders do this.

### Token-2022

Every token can be SPL Token or Token-2022, in any role.

- Every transfer is `TransferChecked`.
- Transfer hooks get their accounts (never a loot signature).
- Required memos are sent.
- Withheld fees are swept before a close.

Where loot records an amount (a payment, a stake, a bid), it records what **arrived**. A payout receipt names what was
**sent**.

The project (or the player) chooses any mint, and takes its issuer's powers with it. The program refuses only what it
could never carry out. `xsolana_check` says what each power lets its holder do.

| Mint feature                                                | Refused for                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confidential transfers                                      | A prize that a box's roll moves (out of stock). Taken in a lottery, a contest, an auction or an offer, where a holder can turn a payout or a refund away.                                                                                                                     |
| Non-transferable                                            | A prize from a pool or won in a box's roll. (Minted straight to a winner elsewhere, it is given.) Taken anywhere else, where nothing can be paid in.                                                                                                                          |
| Default frozen, or a freeze authority that can switch it on | Nothing. A lottery, a contest, an auction, an offer and a sealed schedule take it. A player who closes their own account holds up their own part.                                                                                                                             |
| A permanent burn authority (and wrapped SOL)                | Wherever loot would later burn from an account it holds. It is refused before money comes in (`BurnLocked`): a box that burns, a burned ticket or burning lottery share, burning auction and contest shares, a farm whose early exit burns, and a sealed schedule that burns. |
| A transfer hook                                             | Prizes of a box's roll: out of stock (the oracle's answer carries no hook accounts).                                                                                                                                                                                          |

In a box's roll, a prize whose mint has a transfer hook, confidential transfers or no transferable tokens is out of
stock (its entry weighs 0). It is never an error.

Tokens include wrapped SOL, which a client wraps and unwraps in the same transaction. There is no other SOL path.

## Prizes

One `Prize` type describes what every route gives: a grant (`gives`), a lottery place, a contest's winning entries, a
mission's tier, a recipe output and a box entry (any number of prizes).

| `Prize`                     | Gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Tokens { from, amount }`   | `amount` (a number), minted (when the project is the mint authority) or taken from a pool. All of it is given or none. It is never what an account holds at the time. A jackpot that grows is a lottery's pot.                                                                                                                                                                                                                                                                                              | Every route.                                                                                                   |
| `Item(id)`                  | One collectible at `["asset", item, serial]`, or a normal item that the project's backend delivers from the receipt.                                                                                                                                                                                                                                                                                                                                                                                        | Every route.                                                                                                   |
| `Nft { stash, nft }`        | A named NFT that the project holds in a stash.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Every route.                                                                                                   |
| `Roll(box_id)`              | A roll of one of the project's boxes: a waiting order for the winner.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Every route. In a box, only a box that doesn't roll (`BadEntries`), given by `buy` (out of stock in an order). |
| `Compressed { item, tree }` | A new compressed NFT of a collectible item. It is minted into the project's tree (`open_tree`), in the item's collection (which carries Bubblegum's `BubblegumV2` plugin). It is named "<name> #<serial>" and counted against supply. It costs no rent, only Bubblegum's fee. It has no attributes of its own: a fresh one's traits go in the project's Sheet of it. In a box, its serial is set aside at the roll, and it is minted at the settle into whichever of the project's trees the settle passes. | Every route.                                                                                                   |
| `Stash(id)`                 | An NFT of a stash, drawn by weight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A box entry only.                                                                                              |
| `Held(nft)`                 | An NFT in the lottery's own stash (a raffle).                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A lottery place only.                                                                                          |

Each prize given logs `PrizeGiven`. Its accounts follow the instruction's own accounts (`prizeAccounts`):

- tokens: the mint, the pool if any, and the winner's account;
- an item: the item, and for a collectible also its collection, its new address and Core;
- an NFT: its stash, the NFT's accounts and its proof;
- a roll: the box and the order.

**A prize that can't be given** is one of these:

- an item that is sold out, switched off or closed;
- an NFT no longer in its stash;
- a pool short of its amount (a prize is all of it or none), or a pool never opened (whatever the amount, 0 too);
- a mint the project can no longer mint;
- a compressed URI that is too long;
- a box nobody wrote.

What happens next depends on the route:

- A route that **finishes what was decided** (a lottery place, a contest claim, a mission's end) goes on without the
  prize.
- A route that a **player pays or asks for** (`buy`, `craft`, `claim_grant`) is refused (`PrizeNotCovered`). A refused
  grant claim keeps its round.
- An account at the wrong address for its kind is refused. It is never read as a missing prize.
- An NFT whose collection refuses the move fails the instruction for as long as the collection refuses. The owner can
  take the NFT out of the stash to let a lottery place or contest claim go on. This does not apply to a raffle's
  promised NFT.

A stash shared by several routes can be emptied by one route before another gives its prize. A scarce contest prize
goes to the first winning claim.

**Where a roll prize waits**: at `["order", project, winner, prizeRollNonce(n)]`. The nonce is the first 8 bytes
(little endian) of `sha256("prize" | n as u64 LE)`. `n` is the route's `nonce` argument, plus the place or index where
the route says so. For example, a `buy`'s `k`th roll is given at `nonce + k` (`buyGives`).

The sender pays the order's rent (for a grant, the grant's funds pay). The winner gets the rent back at settle.

- **Asking the roll**: its player or the project's keys ask it. On a box with nothing in stock, only its player can ask,
  in a later slot, and that ask ends the order with nothing.
- **Settling**: its player, the project's keys or the key its player named settle it, paying what the settle opens or
  mints.

## Boxes and the shop

**Items** (`ItemArgs`) have these fields: `kind` (`Normal` or `Collectible`), `rarity`, `soulbound`, `burnable`, `name`,
`uri`, `max_supply`, `active`, `traits`, and for a collectible its `collection`.

- In `uri`, `{serial}` is replaced by each unit's serial.
- `collection` is one of the project's collections. It is fixed once a unit is out (`KindLocked`). A collectible's
  upsert passes it as its first extra account (`BadCollection` without it).
- The item records whether its collection carries Bubblegum's plugin (`Item.compressed`). Without the plugin, a
  compressed prize of the item is never there: `open_box` fails with `SoldOut`; `buy`, a grant or a craft fails with
  `PrizeNotCovered`; a mission, a lottery or a contest gives nothing.

The program keeps names and URIs of any length. Metaplex Core and, for a compressed NFT, Bubblegum (32-byte names,
200-byte URIs) bound them.

Items have no price; boxes sell them. How long a collectible lives and how often it can be used are lines of the recipes
that take it ([Recipes](#recipes)). Lowering `max_supply` below the number already out reads as sold out. A
switched-off item isn't sold, dropped, crafted or given (the authority's `Make` still works).

The project's backend delivers a **normal** item from `PrizeGiven` or `OrderSettled`. It does so once per order or
reference, from a finalized transaction with `meta.err` null.

**Fresh items** (`Item.traits`) are collectibles whose units differ. Each trait is a key plus a source for its value:

- A table (`Values::Table`): a row drawn by weight among the rows in stock at the roll. The row is kept in the order
  (`Order.drawn`, its place in `Won::Item`'s `drawn`).
- A range (`Values::Range { min, max }`): every number equally likely, drawn at the mint.

The same answer gives the same unit, whoever settles and whenever. The unit's name and URI take the values (`{key}`,
beside `{serial}`), and the traits are written on the collectible.

A key is the project's own and appears once. It is at most 64 bytes (`MAX_TRAIT_KEY`). An item has at most 64 traits
(`MAX_ITEM_TRAITS`), because each trait is written as its unit is minted, and one transaction must hold them all.
Breaking either limit fails with `BadItem`. The traits lock with the rest of the item once a unit is out.

Only a box's roll gives a fresh item:

- `Make`, `buy`, a grant and a recipe's output refuse it (`PrizeNotCovered`).
- A lottery place, a contest's prize or a mission's end gives nothing in its place.
- An auction refuses it as a lot (`LotRefused`).

So a box that gives a fresh item is opened, never bought. A fresh item is out of stock while:

- one of its tables is unsealed, empty or never written. An id that nothing wrote reads as out of stock, not an error,
  so a waiting roll isn't locked.
- its tables don't fit what is left of the box's **table budget** (`tableBudget`). The budget is the oracle's 21
  accounts less the box's own (`callbackAccounts`). The box's fresh items take from it in entry order.

A compressed prize is given only into the project's own tree (`open_tree`). Any other tree gives nothing
(`PrizeNotCovered` on a strict route).

**Tables** (`upsert` `Def::Table`, `["table", project, id]`) hold rows. Each row has:

- a weight;
- a stock (`NO_LIMIT`, 4,294,967,295, for no limit);
- a payload: a number (the row's own) or a label of up to 32 bytes.

Rows are posted in batches, and then the table is sealed. After the seal, its weights never change and its stock only
goes down. So an order that drew from it, or a page that shows its odds, can't be changed underneath. Only a sealed
table is drawn from. Rows are bounded by an account's 10 MiB (some 250,000 labels or 1.3 million numbers).

**The shop.** A box with one entry, nothing random in it and no subject sells in one `buy`. Such a box can be a shop
item, a bundle or a fixed pack of any number of draws. One `buy` sells `count` of it at once:

- Each sale is at the price the sale before it left (after `fall`). All sales fall within one `max_price`.
- Each sale counts against the wallet's limit.
- The price is split at once (a `Burn` share burns its part).
- The entry's prizes are given once for each draw of each sale. A fixed amount of tokens is paid as one payment of all
  of it (`buyGives`).
- There is no order and no oracle.

Its `Bought` receipt is logged before the prizes' `PrizeGiven`s. The box's gate, window and limits apply. The same box
can still be opened with `open_box`, which asks the oracle as for any box, waits for its answer and pays its fee. Sell
such a box with `buy`.

**Entries** (`DropEntry { prizes, weight }`) hold any number of prizes. An entry with no prize is "nothing" (the payment
still splits). A box burns its payment, or part of it, with a `Burn` share.

An entry can be given while it can give every prize it names, all together. For example:

- an item in supply (two of the item need two left);
- for a fresh item, its tables sealed, not empty and within the box's table budget;
- a stash that holds an NFT;
- a pool that holds all of its amount;
- tokens in a mint that the roll can move and the settle can pay.

An entry names a pool once, a stash's random NFT beside nothing else of that stash, and a named NFT once (`BadEntries`
at its write). A draw is on the written weights. Only `stock_odds` scales a weight, by the share of its first item's
supply left.

**When an entry runs out**, the project chooses what happens, and players see which choice it made. The choice is
`LootBox.when_out` (`WhenOut`), written with the box. An edit of it bumps the version.

- `StopSales` (the default): `open_box` is refused (`SoldOut`) unless every entry can be given as many times as this
  purchase could draw it, plus every draw of purchases still waiting for their answer (`LootBox.in_flight`). Each order
  counts its draws in `Order.reserved` until its answer or its refund.
  - Entries are grouped by the account they take from: an item, a pool (whatever amount each takes), a stash's random
    NFTs, or a named NFT. Each group must hold the most that any of its entries takes in one draw, times the draws (an
    item its units left, a pool its tokens, a stash its NFTs, a named NFT once).
  - Such a box can't list a stash's NFT at random beside one of that stash's NFTs by name (`BadEntries`), because a
    random draw could take the named one. That box is `DrawLeft`.
  - An entry whose weight follows its item's stock (`stock_odds`) needs no cover, and neither does one weighing nothing
    now.
  - So every roll of a purchase is on the odds written, and nobody can buy a refund on every miss once a common entry is
    gone.
  - Another route can still empty an entry (another box or a prize roll sharing its pool, item or stash; the project's
    keys). That entry makes no draw and gives back its worth. The project restocks or edits the box to sell again.
  - A roll made elsewhere (a prize, a mission) isn't counted and isn't stopped.
  - In practice, a named NFT can be in one waiting purchase at a time. A slot that can draw a named NFT more than once
    (not `distinct`) never sells. A pool holds its prize for every draw waiting.
- `DrawLeft`: the box sells while its first slot has an entry in stock. A roll draws among the entries still there, by
  their written weights. The other entries' odds rise as one runs out, so a player can empty a common entry to make a
  rare one likelier. A box selling a rare prize keeps `StopSales`.

The answer (`callback_roll`) takes the order's draws out of `in_flight`, so it writes the box (the request marks the
box writable). A `refund` of an order whose `reserved` is above 0 names the box (`refundIx` passes it). An edit that
bumps the version puts `in_flight` back to 0.

Every box opened asks the oracle. A box rolls (`boxRolls`) when it has more than one entry or a `Stash` prize. A box
that doesn't roll also sells with `buy`, but a box with a fresh item is only opened (`boxFresh`). A `Prize::Roll` is
refused in a box that rolls (`BadEntries`), because one oracle answer can't serve a second roll. Entries are named in
two bytes. A box holds at most 128 entries, each with at most 14 prizes. Before that, a box is bounded by what its
oracle answer reads (21 accounts: [Limits](#limits)).

**Packs** (`LootBox.slots`, `open_box`'s `count`). One open draws the box's slots. Each `Slot { count, only,
distinct }` draws `count` entries among those that `only` names (all entries, when it names none). With `distinct`, no
entry is drawn twice. A box with no slots makes one draw among every entry. Examples are a pack of 5, a guaranteed rare
(four draws among all entries, one among the rares) and a hand of different cards.

A purchase of `count` opens is paid together and counted against a wallet's limit once for each open. It is drawn from
one oracle answer. Each draw is at its own path in the answer, weighted by the odds the purchase fixed, and reads the
stock that the draws before it left. Answers are never shared between players.

A draw can land on an entry that can't be given at that moment: under `DrawLeft` it has no weight, and under
`StopSales` another route emptied it. That draw isn't made. No other entry takes its place, and the draw is given back
at the settle for what its slot is worth (`Order::back`, `Slot.share`).

A free roll (paid 0: a prize, a recipe's output, a mission's chest) never loses draws to what it emptied itself. Under
either `when_out`, an entry whose last unit the roll's own draws took weighs 0 for its later draws. An entry already
gone before the answer keeps its weight. A draw on it misses, and a roll that drew nothing waits to be asked again. So
emptying a shared source before asking can't steer a roll.

A box of one entry packs too, through the oracle like any other box. (One with nothing random in it also sells in one
step with `buy`.) A pack has no NFT rolled on (`BadEntries`). Measured on 0.22, a card costs the oracle's callback
2,600 to 3,700 compute units at 2 to 16 entries, so one answer draws about 66 to 106 cards.

**Stashes.** The owner or authority puts NFTs of any kind in a stash, each with a weight (`stash`'s `weight`).
Soulbound NFTs can't move. The owner or authority takes NFTs out to any wallet, never to a loot account
(`ToTheProject`). Taking one "out" to the project's own address only drops it from the table.

A `Stash` prize draws by weight from the oracle's answer and takes the NFT out at once (the last row takes its place),
so two winners never get the same NFT. A draw that lands on an empty stash isn't made, and it gives back its worth. A
box of only empty stashes sells nothing (`SoldOut`).

Rarity tiers are weights in one stash, or several stashes with their entries' weights. A stash of one NFT raffles it. A
stash's draw costs the callback about 25,000 compute units at ten NFTs and 33,000 at 290,000 (0.22).

**Prizes are set aside at the roll.** A prize that the roll couldn't give is **out of stock**, never an error. This
holds at the purchase, the ask and the answer alike. A prize is out of stock when it is:

- a fixed amount that its pool doesn't cover;
- a minted source that the project no longer mints;
- tokens in a mint with a transfer hook, confidential transfers or that nobody can transfer;
- a mint whose mint and vault aren't passed;
- an unsealed or empty table;
- a fresh item whose tables don't fit the table budget;
- a `Prize::Roll`.

A box with no entry in stock sells nothing (`SoldOut`). The roll sets aside each prize of each drawn entry in the order
(`Order.won`):

- an item as `Won::Item { item, serial, drawn }`, where `drawn` is the place of the rows that a fresh item's table
  traits drew;
- tokens, moved into the vault;
- an NFT, taken out of its stash with its weight;
- a compressed item's serial.

Two winners rolled before either settles are both paid. **A draw is on the written weights** (with `DrawLeft`, among
the entries still in stock), so the buyer of a box that stops selling rolls on the odds they saw.

Another route can make a drawn entry impossible to give: its item's last unit is gone, its pool is short of its amount,
or its stash's NFT is taken. That entry makes no draw. No other entry takes its place, and that draw is given back at
the settle for what its slot is worth (`Order::back`). If no draw is made at all:

- an order that was paid for (a purchase, an auction's roll lot) is `Failed` and refunded;
- a free order goes back to `Waiting`, to be asked again, or ended by its player's ask when nothing is left.

Tokens sent into a pool change nothing about a roll: an entry needs its whole amount there. `settle` hands each prize
over. If a won NFT's collection starts refusing the move, the player settling their own order may pass its stash
instead. The NFT goes back to the stash, with its weight, while the rest settles.

**Compressed items in a box** (`Prize::Compressed` in an entry). A plain one costs no rent. A fresh one's traits go in
the project's Sheet of it, and whoever settles pays that rent. A soulbound item, or one whose URI could outgrow
Bubblegum's 200 bytes with its values in it, is out of the box's table. The collection must carry Bubblegum's plugin. A
settle into a collection without it fails, and a rolled order waits until the collection has it.

**Roll accounts.** Some writes name a box to roll later: `upsert` of a box, a recipe, a grant or a lottery;
`open_auction` of a roll lot; `open_contest` with a roll prize; and `open_farm` for its tiers' rolls and roll prizes.
Some routes make a roll: a craft's `Prize::Roll` or `RollOn`, a `buy` bundle's roll, and a grant claim. Each of these
passes only the box, one account each (`boxesAccounts`), and the order that a route makes. What the box can give is read
when the roll is asked and answered.

The purchase, the ask and the answer pass the box's roll accounts (`rollAccounts`, `askRollIx` with `items`):

1. Each entry's prizes' accounts: an item, then a fresh item's trait tables while they fit the box's table budget; a
   pool; a stash.
2. Each distinct mint first named, and the project's vault for it. A pool's mint is read from the pool. A pool not
   opened adds nothing.

A route that makes a roll and asks it in the same transaction (js/play's rolling routes do) fails whole on a box with
nothing in stock (`SoldOut`). So the player keeps what the route would take.

**Settling in parts.** An order is made at its smallest size. At the purchase it grows to hold all that its box can set
aside (`Order::space_for`, `orderBytes`). For a box that gives items, it grows by 4 more bytes for each table row a draw
may carry (the box's table budget, for each draw of each open). So the order settles in as many parts as the chain
needs, and each part pays for what it opens or mints.

Each `settle` carries out the prizes from where the last part stopped (`Order.settled`) up to `upto`. It writes its
receipt (`OrderPartSettled`) before it mints, so a log that Solana cuts at 10 KB keeps the receipt.

- **The first call** splits the payment, and passes its shares' accounts and their hook tail with it. `upto` 0 splits
  and gives no prize, and is accepted only before the split. It is sent first when a prize can't land yet (a winner's
  account that its issuer froze), so that the shares are paid.
- **The last part** (`upto` past the end, `SETTLE_LAST` = u32::MAX) logs `OrderSettled`. It carries out the NFT rolled
  on that the project holds, pays the undrawn draws' share back, gives whatever prizes are left (maybe none) and closes
  the order.
- An NFT rolled on that the project doesn't hold has its numbers moved by the first call, with its accounts (and its
  Sheet).
- A part before the last (`upto` at most the end) gives prizes with a stand-in piece.

The order's own player may give up tokens or a collectible they can't receive (`settleIx`'s `giveUp`: the project's
vault, or the item, in the receiver's place). Tokens given up stay in the vault, and `PrizeForgone` says which. A
stash's NFT that the roll won and that is proven gone from the project is not given either, whoever settles
(`PrizeForgone` for it beside `NftGone`). The NFT rolled on, if proven gone, is not sent back, burned, given or stashed
([An NFT gone from the project](#an-nft-gone-from-the-project)).

`OrderPartSettled` carries `amount` and `treasury_remainder` when it split. In a settle of several parts, the last
part's `OrderSettled` has them at 0. A compressed prize's item account is written. A compressed prize of an item whose
collection lacks Bubblegum's plugin mints nothing, so the next one's Sheet is at the tree's count one less
(`wonAccounts`' `unminted`).

A transaction's instruction trace (64 calls) is the first limit. Measured on 0.22, one settle mints about 14 Core
cards, 10 compressed or 8 fresh compressed (`settlePartEnd`, `settleParts`). The next limits are 64 accounts and 1,232
bytes. js/play's `openBox` sends prizes in parts, each shrunk until it fits, then the last part. It sends them from a
throwaway key that the open's one prompt funded with each settle's fee and what it may open or mint (`settleRent`). The
key settles only once a dry run says the transaction lands (otherwise the wallet settles), and its last settle sends
back all it holds.

**An order's size** is what it can hold (`orderBytes`). At `open_box`, each draw counts at its dearest entry's prizes,
as the `Won` they become: an item 14 bytes, tokens or an NFT 41, a roll none. Each draw also counts 4 bytes for each
table row its fresh items draw now (`entryRows`, `orderBytes(box, shares, opens, items)`; `Order::sized`). A plain
3-entry box is 252 bytes, and a 5-card pack of a 10-item box is 308.

A roll made inside another call (a craft, a grant's claim, a mission, a roll lot) reads no item. So it keeps the box's
whole table budget for each draw (`orderBytes` without `items`; `Order::space_for`). The write's check against 10,240
bytes (`MAX_ORDER_BYTES`, `BadEntries`) does the same. An item given more table traits after a purchase (possible while
none of it is issued) is out of stock for that order.

**A pack's draws must fit one oracle answer** (`drawsFit`, the program's `draws_fit`). Each draw counts at the least it
could cost, with the pairs of entries that a roll of several draws compares first. A box whose single open doesn't fit
is refused at its upsert. A purchase of several opens that don't fit is refused at `open_box` (`PackTooLarge`). The
answer's heap counts the box's own bytes too: its odds, gate, shares, subject, slots and fates (`boxBytes`, the
program's `box_bytes`).

A draw of an entry that gives nothing (or can't be given) costs some 1,100 units beyond its weighing. A pack of entries
that give nothing can be written with up to 116 draws, and one purchase takes 109 opens of a box of one such draw.

The write counts finding each pool's and stash's address, as the purchase does: 1,500 units a try (`256 - bump` tries,
known from the project's address and the id; `searchTries`). It counts this for each prize that names a pool or stash,
and for a named NFT's stash at one row at least. So thirteen entries of one pool fit 8 draws (5 where finding the pool
takes 4 tries), and sixteen stashes fit 9 (36 tries to find them all). `drawsFit` and `boxFits` take the project for
that (`project`). The checker counts each search exactly once a wallet is named (the plan for a real setup passes it),
and at 2 tries an address before that (`ASSUMED_TRIES`).

A purchase also reads what the accounts hold, which the write can't know: a stash's rows past 4,096, a named NFT's
stash's rows, a fresh item's tables, and an item not written. `drawsFit` with `purchase` counts what the box alone
tells. The answer still stops before a draw that might not fit. It judges from what it has spent, the heap it has
really used and the lists that draw may outgrow. What it doesn't draw is `undrawn`, and its worth is given back when it
was paid for.

A box written under 0.26.0 past what 0.26.1's write counts is not rewritten. Each purchase of it counts like any other
(a pack of draws that give nothing, which no answer could finish, is refused at its purchase). Any edit of it, even one
that only switches it off or changes its price, is refused (`PackTooLarge`) until its draws are cut.

Where a box's addresses take many tries, its write takes more than the 200,000 units an instruction has by default. The
plan's transaction that carries such a write asks for 1,400,000.

A box that doesn't roll sells by `buy` when one transaction carries the whole purchase (`buyFits`, the program's
`buy_fits`: 64 accounts, 64 instructions, 1,400,000 compute units). Otherwise it sells through the oracle, with its
heap counted. Such a box can't give a roll (`PackTooLarge` at its write). For example:

- 31 draws of tokens from a pool by `buy`, 20 through the oracle;
- 64 of one item (past 14, no `buy` carries them);
- 60 of a three-entry box of items;
- twelve 5-card opens of a two-entry box.

js/play cuts a purchase into orders of `opensAnOrder(box)` opens (that many, with an order's rent and fee within 0.01
SOL), all in its one transaction. Every entry must be one that some slot draws (`BadEntries`). `open_box` is refused
when none of the first slot's entries is in stock (`SoldOut`), because the roll could only refund.

**Prices** are in the box's `currency`.

- `rise { step, growth_bps }` lifts the price after each sale, rounded down (a 10% rise on a price of 9 base units adds
  nothing).
- `fall { step, every, floor, since, shared }` lowers it over time to a floor (0 can reach free).
- `max_price` protects the buyer. `version` covers only what the roll reads, so a moving price never breaks a purchase.

A price of 0 is a free box. The player still pays the fee, and for an opened box the order rent, which comes back when
the order closes.

**Window and limits**: `window { opens_at, closes_at }` (0 is no bound; `NotOpenYet`, `WindowClosed`) and
`per_wallet { total, per_window, window }`, kept in the buyer's counts. A refund gives its count back. `active` stops
sales.

**Odds**: entries are raised for a player who shows a collectible (or whose profile says so). The raise is fixed in the
order at purchase.

**Edits.** An edit of entries, slots, odds, `stock_odds`, `when_out`, `subject` or `fates` bumps the version. It fails
any order that holds a payment, and that order refunds what it paid at once. Such orders are a waiting purchase and an
auction's roll lot, whose order holds the winning bid.

Any other roll (a lottery place, a chest, a recipe, a grant) holds nothing to refund, since what it was won or bought
with is spent. It rolls on the box as it is now, so an edit never loses it. Its asker pays for the room the edited box
needs.

Other edits (price, shares, switch, window, gate) leave orders alone. A refund keeps the price rise its purchase applied
until the owner's next edit.

**Order lifecycle** (`OrderStatus`):

- `Pending`: opened, roll asked.
- `Rolled`.
- `Failed`.
- `Waiting`: made by another route, not yet asked.
- `Asked`.

Every order receipt carries `requested_slot`, which names the purchase at a reusable address. An order never settles or
closes in its opening slot (`SameSlot`). Once asked, a roll is asked again only in a slot later than its last ask
(`SameSlot`: never the same seed twice; `rollAskable`).

- A failed roll refunds from the next slot.
- If the roll never arrives, the purchase refunds after 10 minutes (`STALE_SECONDS`, from `Order.asked_at`).
- An `Asked` order holding a payment or an NFT refunds 7 days after its first ask (`LOTTERY_TIMEOUT_SECONDS`, from
  `Order.first_asked_at`), when the oracle has been silent all that time.

A rolled order is settled by its player, the project's keys or the key its player named. It is never refunded
(`BadOrderState`). A free roll with no draw made goes back to `Waiting`.

## A roll on an NFT

A box with a `subject` (a rule) rolls on an NFT that passes that rule. The NFT can be:

- an NFT a player brings to `open_box`;
- an NFT leaving a mission (a tier's `roll`);
- an NFT a recipe keeps (`Output::RollOn`).

The box's `fates` (`Fate { entry, shifts, then }`, one per entry) say what each entry does to the NFT:

- `shifts`: numbers to move (`Shift { key, by, most, from_now }`). A shift never takes a number below 0, and a raise
  never takes it above `most`. With `from_now`, the value is a time moved from now, at most `most` seconds ahead (a day
  in jail, for example). Shifts are written on the NFT where the project may write to it, and otherwise on its Sheet.
- `then` (`Option<Spend>`): what happens to the NFT afterwards.
  - `None`: it goes back to its player.
  - `Some(Burn)`: it is burned. A Core NFT is burned by Core, with its rent to the settler; other NFTs go to the
    incinerator.
  - `Some(Give(wallet))`: it goes to that wallet.
  - `Some(Stash(id))`: it goes into that stash, so a trade-in becomes another player's prize.

If every entry of a box burns, gives or stashes the NFT, the box takes the NFT as its price.

- **Custody follows the fates.** If a box can burn, give, or move the numbers of an NFT that can move, it takes the NFT
  into the project's hands when the roll is made. Nobody can then sell the NFT after seeing a bad roll. A refund sends
  the NFT home. A soulbound NFT is rolled where it is.
- **One roll at a time on an NFT.** Such a roll is made at the NFT's own nonce (`nonceOn`): the first 8 bytes of its
  address, read little endian (`SubjectNonce` otherwise). A second roll therefore waits for the first, and rules read
  what the last roll wrote. An NFT frozen on a farm seat is refused.
- **Named nonces.** A craft's `RollOn` and a mission's roll name a nonce, and the roll is made at `namedRollNonce`:
  - on a box that holds the NFT, at the NFT's own nonce, whatever nonce was named;
  - otherwise at `prizeRollNonce` of the named nonce. A mission of several seats names seat `i`'s roll `nonce + 2i`
    and its prize's roll `nonce + 2i + 1`.

  If a roll already exists at that address, `unstake_nft` fails with the System program's "already in use" error. The
  previous roll must first be asked, answered and settled, in transactions of their own. Its player or the project's
  keys can ask it while its box has something in stock. Its player can always ask it, in a later slot. js/play's
  `unstakeNft` says so, and `claims()` lists the step.

- **What was rolled stays rolled.** The fate is copied into the order when the roll is made.
- `settle`, `refund` and `end_auction` pass their remaining accounts to the NFT's move, so a Core collection's
  transfer checks find the accounts they read.

**Rolls that wait.** Missions, recipes and prizes make an order in the `Waiting` state. The player, or a prize maker,
pays its rent and gets it back at settle. Asking for the roll (`ask_roll`) pays the oracle.

- While the box has an entry in stock, the order's player or the project's keys can ask.
- On a box with nothing in stock, only the order's player can ask, and only in a later slot than the order's
  `requested_slot` (`SoldOut` otherwise). Nobody else can then land a winner's roll on an empty box. The player's own
  ask on an empty box ends the roll at once, with no oracle. The order is either rolled with nothing (settle sends an
  NFT it holds home as it was), or failed for its refund when its winner paid for it (an auction's roll lot).

The order's player, the key the player named (`settler`), or the project's keys settle it. A waiting roll is never
refunded, and neither is an asked roll that holds nothing. A roll unanswered within `STALE_SECONDS` is asked again by
them, and the first answer to any request rolls it. A free roll whose answer makes no draw goes back to `Waiting` and
is not rolled. They ask it again, or, on an empty box, its player ends it with an ask and no oracle.

A roll fails at its ask, and gives back what it holds, in two cases:

- its answer can't carry the box's own accounts;
- it holds a payment and its box was edited since.

A box that only missions, recipes or prizes roll is left switched off. Their orders ignore the box's switch and window.

- **A mission's roll** needs an NFT farm and a tier with a lock (`BadFarm` otherwise). When an NFT leaves after the
  lock, it is rolled if it fits the subject; otherwise it goes home unrolled. Growth stops at the end of the lock.
- **A recipe's roll** on a kept NFT needs a Core asset when the box takes custody of the NFT or moves numbers on it
  (`NeedsCustody`). A Token Metadata or compressed NFT can't be held until the roll settles, and could leave before the
  roll lands. A box with a subject that is rolled on no NFT gives its entries without fates.

A `pay`'s `reference` is only a label, and `roll` keeps no per-request record. Apps deduplicate their own effects. When
the program must enforce a single payout, use orders, contests, lotteries or grants.

## The owner's records

`upsert(Some(def))` writes one record, and `upsert(None)` closes the record at `target`. `Def` names the record's kind
and id, and the address follows from them. One kind or project is therefore never written over another.

**An edit is the whole record.** A gate or odds left out of an edit are gone. An edit keeps what the record has done:
units out, runs, rounds and counts.

A write emits `RecordWritten`, and a close emits `RecordClosed`. A record closes only when nothing pending depends on
it. Its rent goes to the owner. If the record is written again, its counts start from 0.

| Record      | Closes                                                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item        | Only while none was ever handed out.                                                                                                                                                                                                                                                          |
| Schedule    | Any time. A sealed schedule never closes.                                                                                                                                                                                                                                                     |
| Lottery     | With nothing sold and nothing pending. Every pot it opened (`Lottery::pots`) is swept to where the owner says and closed. `closeRecordIx` passes the mint, the destination, both token programs and each pot by id (none for a lottery that opened none). Mints are fixed for an incarnation. |
| Grant       | Any time, with unused SOL to the owner. Written again, it is a new campaign that refuses old vouchers.                                                                                                                                                                                        |
| Box, Recipe | Never: a version must never come back at the same address.                                                                                                                                                                                                                                    |
| Table       | Never. A table is sealed: its weights never change and its stock only goes down.                                                                                                                                                                                                              |

## Schedules

A schedule makes one run of its `action` (`{ from, to, amount, halve_every }`) every `every` seconds. A run is the
move that `move_tokens` makes: from a pool or from a mint the project controls, of a fixed amount or a share of the
pool. The amount can halve every N runs, if asked. A schedule starts no earlier than now.

**A run missed is missed.** A `run_schedule` pays once, for the latest run due: its amount, or its share of what is
held then. The runs before it lapse, and `upto` has no effect on it. Sending runs on time is therefore the project's
job, and no amount that nobody meant goes out later.

The one exception is the fixed amount of a sealed schedule (`scheduleCatchesUp`). It pays every run due, in one
transfer and one `ScheduleRan` (`from`, `run`). A call pays up to `upto` runs made and up to a step cap. The client
passes the runs already made plus those due (`runsDue`).

A schedule stops after `max_runs`. A move that can't be made fails the call. A schedule that moves a pool into itself
is refused when written.

**Sealed** (`TokenSource::Vest(mint)`). A sealed schedule pays from its own vault, `["vest", schedule]`. The vault
opens when the schedule is written, and anyone can fund it at any time. Nothing else pays out of the vault, and the
schedule can be written only once (`Sealed`). A sealed schedule must meet these conditions:

- It is on.
- It has a last run (`max_runs` above 0) whose time fits a date. It may have any number of runs, however far off. Its
  last run pays all the vault holds, in the call in which that run is due.
- No share is above the whole vault.
- Its destination is one that every run can always pay:
  - a burn (not wrapped SOL);
  - a wallet this program doesn't own, such as a person's key or a multisig's vault. `upsert` passes the wallet itself
    after the vault's four accounts. A wallet this program owns fails with `BadMove`.
  - the treasury.

  It is never a pool, a token account (a pot, a farm's vault), a collectible's holder or a chosen share (`BadMove`).

To stream into a pool, a pot or a farm, use an ordinary schedule.

The project chooses the mint, and with it the powers of the mint's issuer: a permanent delegate, a fee raised to 100%,
a freeze. A vest is only as safe as its token. Only a schedule that burns refuses a mint whose issuer keeps a burn
authority (`BurnLocked`).

A payee at an address of this program that has no record yet gets a warning. A record made there later would make
every run pass that payee over.

A run never pays more than the vault holds. The last run pays all of it, and later deposits go to the same place. Pause
and suspend stop none of this. A cliff is a first run in the future. A timelock is one run.

## Lotteries

A lottery is written with `LotteryArgs { terms, every, gate, per_wallet }`. Its `terms` are a `LotteryTerms { price,
mint, pays_from, shares, places, ticket_mint, draws_at, nft_ticket, returns, min_sold, closes_before, time_weighted }`.

`withDefaults` also takes the terms beside `every`. It fills `closes_before` with 0, `time_weighted` with false, and
each place's `when_short` with `InOrder`. It refuses terms without `pays_from`, which has no default.

Tickets are paid in `ticket_mint` (burned) when it is set, and otherwise in `mint` (`paymentMint(terms)`).

### Where the places are paid from

`pays_from` (`PaysFrom`) is one of two values.

- `{ Round: { rest } }`: each place takes its `bps` of this round's own ticket money only, the part left after the
  shares (`to_pot`). Nothing from outside can change that amount. What the places leave, including the part of places
  nobody won, goes to `rest`, which is one of:
  - `Treasury`, a `Wallet`, a `Holder`, or another program's `Account`;
  - `Burn`: the money then stays in the round's account for the round's close to burn, and is no part owed.

  `rest` is never a `Chosen` share (`BadLottery`) or one of the lottery's pots (`SameAccount`). A pool or another
  lottery's pot named there fills when the leftover is pulled. A lottery paid this way opens no pot. A no-loss lottery
  may be paid this way; its places then take no money and give their prizes.

- `{ Pot: [id] }`: a pot kept from round to round at `["pot", lottery, id]` (`pda.lotteryPot`; `id` is below
  `MAX_POTS`, 16). Each place takes its `bps` of what the pot holds at the ask, together with the round's part. A seed,
  a sponsor, yield and what earlier rounds left therefore all count. What the places leave goes back into the pot.

  The ask that needs the pot first moves in what the previous round left that pot, from that round's own account.
  `Lottery::owing` is the last round paid from a pot that may still owe it. A prize therefore never depends on who
  pulled the previous round, or when. `drawLotteryIx` takes that round's record as `owing`; its terms name its pot,
  and if the record is gone, any account stands in. While that round waits for the oracle, the next ask from a pot is
  refused (`NotDue`).

An edit can move a lottery to another pot between rounds. `upsert` opens the pot the terms name if it isn't open.
`upsertIx` passes it; for a lottery paid from its rounds, pot 0's address stands in. `Lottery::pots` keeps a bit for
each pot opened (`lotteryPots`). No share pays into any of these pots (`SameAccount`).

### Rounds

The lottery keeps its terms, its incarnation and its round number. Each **round is a record of its own**, at
`["round", lottery, incarnation, round]` (`decodeRound`). The round's first purchase opens it and copies the terms into
it (its `terms` and `revision`). Later purchases name the round's `revision`. The gate and `per_wallet` are read live.

The round holds its money in token accounts of its own, `["round-tokens", round, mint]`. A cancel therefore moves
nothing, and a pot holds only what nobody is owed.

A draw may be as far off as a date can hold. A time written in milliseconds holds its buyers' money until then
(`xsolana_check` says a far date in words). If a repeating lottery's next date would be past what a date can hold, the
current round is its last.

**Sales close** `closes_before` seconds before the draw, by the round's copy of that term. With 0, sales run until the
draw. Every ticket is therefore held at least that long. A purchase inside the window fails (`SalesClosed`). A
`closes_before` below 0, or as long as a repeating lottery's `every`, is refused (`BadLottery`).

**Ending a lottery** takes one edit. Setting `every = 0` on a running lottery draws the round it is at
(`Lottery.last`), and then the lottery ends. Switching back to repeating waits until that round is drawn
(`RoundRunning`). A close, a re-make or a lottery-stash move waits on round `last`.

SOL sent to the lottery account beyond its rent (`roundRent` in a spec, on by default) pays for each round's header and
token accounts. This SOL is lent to the round and goes back to the lottery at the round's close. `LotteryRound.opener`
and each `Opened.by` then name the lottery. A close passes the lottery, or the project's owner once the lottery is
closed (`pullIx`'s `lotteryClosed`). If the lottery has too little SOL, the round's first buyer (or its asker) fronts
the rent and gets it back at the close.

In a round the lottery opened, the lottery's spare SOL also pays for each entry's bytes while it covers them
(`LotteryRound.lent`, back to the lottery with the header's rent). A buyer then pays only the fee and the price. The
tools size `roundRent` from the spec's `expect: { rounds, entries }`.

### Purchases

**A purchase** appends an entry (`entryWidth(fee, nft, weighted)`). An entry holds:

- its buyer;
- where its tickets end;
- what arrived (with a fee mint, with a share the buyer chooses, and always in a weighted round of paid tickets);
- where its weight ends (16 bytes, a weighted round only);
- its NFT ticket.

**Tickets weighed by time** (`time_weighted`) are off by default. Only a lottery that `returns` its tickets may weigh
them (`BadLottery` otherwise), and NFT tickets are weighed too. A purchase of `count` tickets at `now` weighs
`count × (draws_at − closes_before − now)` seconds, by the round's own copy of the terms. The last ticket sold weighs 1,
and no ticket weighs 0.

The round's `weight` (an `Option<u128>`, after `sold`) is the sum of these weights. The round's header is 10 bytes
longer than before, a weighted round's 26, and `first` is a `u128`. Place `k` sits at `first + k × (total / winners)`,
where `total` is the weight in a weighted round. Its winner is the entry whose slice holds that point, so a buyer who
holds long may win more than one place. `winners`, `min_sold` and `per_wallet` still count tickets.

An entry's tickets are its word's end minus the previous entry's (or `TicketsBought.count`), never its slice.
`TicketsBought.weight` says what a purchase weighed. Before a buyer buys, a client shows what their purchase would
weigh and their share of the round's weight.

A share the buyer chooses (`To::Chosen`) goes, for example, to a referrer or a collectible's holder, and to the
treasury when no choice is made. It is paid at once from the buyer's own account. Its destination's accounts come after
the gate's (`buyTicketsIx` takes `holders` and `treasury`). Every other share is split at the purchase and paid in
common after the draw.

Unless the lottery's spare SOL pays for them, the buyer pays for the entry's bytes. They are not refunded; they go to
the treasury at the close. A round holds about 70,000 to 260,000 purchases, depending on its entries' width.

### Draw

Anyone sends `draw_lottery` once the draw is due. Places are written as runs: `{ bps, prize, when_short, times }` is
`times` places alike. A named NFT is one place's, and a run of rolls gives each place its own roll. A lottery has at
most 64 runs (`MAX_LOTTERY_RUNS`, `BadLottery`). Places are drawn by evenly spaced points with rejection sampling; in a
weighted round, the points are points of its weight.

A round nobody bought into has no record. A repeating lottery then moves its date, and a lottery that draws once ends.

**The first ask fixes the round's money** before anyone knows who won:

- Paid from a pot: what the previous round left the pot moves in. Then what the round's places take of the pot moves
  into the round's own account, or what the round's ticket money leaves over is owed to the pot (`pot_owed`).
- Paid from its own money: what the places leave is owed to `rest`.
- Each run of pool prizes moves in. A minted run is minted at its pull. While the project is not that mint's authority,
  only the place's winner or the project's keys pass the prize over, for nothing, and anyone else's pull waits
  (`PrizeNotCovered`).

**A pool is read once**, when the draw is asked, and the project can spend from it until then. When the pool holds
less than all its places with a winner win, each place gets what its run's `when_short` says. `when_short` must be the
same for every run of one pool (`BadLottery` otherwise).

- `InOrder` (the default) fills places first to last, with whole prizes only; the remaining places get nothing.
- `InProportion` gives every place its prize times what the pool held over what its places win, rounded down.
- `Nothing` pays no place from that pool.

For example, prizes of 1,000, 500 and 500 from a pool holding 1,700 give 1,000, 500 and 0 in order, 850, 425 and 425
in proportion, or nothing.

The lottery then moves on, and its next round sells at once. `drawLotteryIx` passes these accounts:

1. for a round paid from a pot: the pot, its mint, and the round's account of it;
2. then, with `lottery.owing` set: that round, its account of the mint, and its pot;
3. then each token run's mint, and for a pool, the pool and the round's account.

A source that is frozen, paused or closed, or hooked with `skip_hooked`, gives this round nothing. The lottery's own
account goes with its current round only.

An unanswered draw is asked again after `STALE_SECONDS`. That ask names the waiting round by its address
(`roundAddress`) and names no lottery, so a lottery closed since never strands the round. The next ask after **7 days
from its first ask** cancels the round (`lotteryCancellable`). Every entry is refunded, and what the ask moved in is
owed back.

A short round (`min_sold`) is cancelled at its first ask. The program takes the cancelling ask and a pull in one
transaction. js/play's claim of such an ask pulls the sender's own refund right after it, and the close too when that
is all the round owes. A refund is therefore two transactions: the ticket and the cancel.

A purchase in a round whose draw is due sends the draw first, in the same transaction, and buys into the next round.

### Pulls

**Then each part is pulled** with `pull(entry, part, nonce)`, by anyone, in any order. A part is one of:

- `Own`: the entry's own part. This is a refund, a no-loss ticket's price, or its NFT ticket, sent back or to where
  its price sends it.
- All of the entry's places in one run at once: `Pot(run)` is their part of the pot, and `Prize(run)` is their prize.
- `Common(i)`: a part owed in common (`commonOwed`). Index `i` is share `i` once drawn. Past the shares, it is what the
  places leave, to the pot or to `rest` (`leftoverTo`; never owed when `rest` burns). Past that, after a cancel, it is
  each pool's prize back to its pool.

A place's prize is given at its pull:

- Tokens go into the buyer's account.
- An item, a compressed NFT, or a project stash's NFT while the stash holds it. If a named NFT is gone from its stash,
  a stranger's pull is refused (`PrizeNotCovered`); the winner or a project key passes it over.
- A roll is made at `prizeRollNonce(nonce + place)` (`pullRolls`). js/play asks for it in the pull's own transaction.
- The lottery's own stash's NFTs are taken out for every place up to the entry's last, in place order, by whoever
  pulls first (`LotteryRound::assign`). `stashNfts` says which NFT each place gets. A pull with the stash alone only
  takes them out.

An owed NFT passed as its hold's address `["hold", nft, 0]` in place of its piece becomes a hold for its winner
(`pullIx`'s `hold`).

A part owed in common that nobody can take goes to the treasury (`toTreasury`). Examples are a pool never opened, a
pot closed since or made again in another mint, and a collectible nobody holds.

Each part waits under its own bit and holds up nobody else. The pull that leaves nothing owed closes the round when it
carries the close's accounts. The close burns what nobody is owed and returns each account's rent to whoever fronted
it. Any pull closes a round that owes nothing.

### Variants

- **Raffle**: draws once. A place gives either `Prize::Held(nft)` from the lottery's own stash, or `Prize::Raffled` (a
  run of places, each an NFT drawn at random from the stash), never both.
  - The stash is filled with `stash` (`StashOf::Lottery`), several NFTs per call. `stashBatches` splits a long list.
  - The write refuses an NFT not in the stash, or fewer NFTs than raffled places (`NotInStash`).
  - It also refuses more than 256 places of its own stash, raffled or named (`BadLottery`). The oracle's answer loads
    the round on the default 32 KiB heap, where the list of their NFTs fits up to 256.
  - A pull takes out at most 64 of their NFTs (`pullAssigns`) and stops at a place whose NFT is not out yet. Pull
    again until every place has its own.
  - An NFT ticket's rule holds at most 170 "one of" texts (`BadLottery`), because the oracle's answer reads it.
  - A run of places given one by one holds at most `MAX_RUN_PLACES` (4,096; `BadLottery`). This covers anything but
    tokens: an NFT, a compressed NFT, a raffled one, a roll. For more, use several runs. A run of rolls takes two
    accounts per place, as many as a pull carries (`prize.most`).
  - While the lottery runs, nothing comes out of the stash but a place's prize (`Promised`). The same holds once the
    lottery has ended, while its last round (`Lottery.last`) still owes NFTs from the stash. Its close, a write again
    and stash moves then name that round (`idleRound`).
- **Least sale** (`min_sold`): a due round that sold fewer is cancelled at its draw, with no oracle, and everyone is
  refunded.
- **Free tickets** (`price` 0): a ticket costs only the player fee. `per_wallet` keeps one wallet from taking most
  tickets.
- **NFT ticket** (`nft_ticket: { rule, then }`): one ticket for one NFT (`OneTicket`). The NFT is held until the draw,
  then burned, given or stashed by its pull. It goes home if the round is cancelled. There is no price, shares or
  ticket mint.
- **No-loss** (`returns`): after the draw, every ticket is owed back whole. Winners take only what was paid into the
  pot, and their prizes. When it is paid from its rounds' own money, its places take no money and give their prizes.
  Give it a sales close (`closes_before`). Otherwise tickets bought seconds before the draw have the same chance as
  tickets held all period, and their price comes back. Or weigh its tickets by time.
- **Sales close** (`closes_before`): sales close that many seconds before the draw (`SalesClosed`, `salesCloseAt`).
- **Weighed by time** (`time_weighted`, a no-loss lottery only): a purchase of `count` tickets weighs `count` times the
  seconds from the purchase to the close of sales (`TicketsBought.weight`, `ticketWeight`, `purchaseOdds`). A place is
  won by weight. An entry's slice of the draw is its weight's (`decodeRound`'s `start`, `end`), and its ticket count is
  `tickets`.

### Mints, limits and edits

Pot and payment mints may be any token. This includes a token with confidential transfers, one whose new accounts
start frozen or can be made to, and one nobody can transfer (its first paid ticket fails). A player who turns off plain
transfers into their own account holds up only their own part. But the round can't close meanwhile and its rent waits,
so keep spare SOL in the lottery. A pot or pool in a token that can't reach the round gives that round nothing.

A lottery has at most 8 shares (`MAX_SHARES`, as for every split kept to be paid later) and 8 mints.

Edits apply to the next round, except the gate and `per_wallet`, which apply at once. These wait while the current
round has a record (`RoundRunning`):

- closing or making a draw-once lottery again;
- an edit of an ended lottery;
- an edit that makes it repeat.

They also wait once the lottery has ended, while its last round still owes NFTs of its own stash (`RoundRunning`).

Writing `every` 0 on a running lottery ends it after its current round (`Lottery.last`). `per_wallet` counts tickets
per round, in the wallet's counts.

## Recipes

A recipe is written with `RecipeArgs { active, inputs, outputs, needs, keeps, raises, window, per_wallet }`. It has any
number of lines in and out, as many as one transaction carries, and a craft is all or nothing. A craft takes up to 255
collectibles, because a byte names each one's place. Recipes that give only fixed token amounts can be crafted many
`times` at once.

| `Input`                      | Takes                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Burn { item, count }`       | Collectibles of an item, burned.                                                                                                                                                                                                       |
| `Use(item)`                  | One collectible, kept. Its life and uses are the recipe's needs and raises. A collectible boosting the player's token seat passes that seat `["seat", farm, player]` and then the farm (`craftIx`'s `{ asset, farm, booster: true }`). |
| `Pay { mint, amount, to }`   | Tokens, burned or sent.                                                                                                                                                                                                                |
| `Show { collection }`        | Any NFT of a collection the player holds, kept.                                                                                                                                                                                        |
| `Staked { item, farm }`      | A collectible on its own seat in that farm (`NotFarmed` elsewhere, and for a token seat's booster).                                                                                                                                    |
| `Trade { collection, then }` | Any NFT of a collection, then burned, given or stashed.                                                                                                                                                                                |

Outputs are `Output::Prize`, all of each or refused (`PrizeNotCovered`), or `Output::RollOn`, a roll on a kept
collectible.

- `needs` (`Need { place, key, test }`): the attribute under `key`, on a collectible handed in or on the player's
  profile, must pass `test`, a rule's `Test` ([below](#rules-gates-odds-and-boosts)). Otherwise the craft fails with
  `NeedNotMet`.
- `keeps`: attributes passed to a new collectible.
- `raises` (`Raise { place, shift: Shift { key, by, most, from_now } }`): a raise goes up to `most` (`MaxedOut` when
  already there). A `by` below 0 lowers the value, never below 0. With `from_now`, the value is a time (fuel for a day
  more, for example).

A raise on a `Staked` collectible must move its farm's lock key (`BadRecipe`).

A `Show` NFT may be locked by the project in the player's wallet on a seat of a farm that freezes (not a soulbound Core
asset). If a raise lowers a number on such an NFT, the craft passes its seat and farm after its accounts (`craftIx`'s
`farm` on it). The raise may not lower what that farm reads.

An item's **life** is a set of lines in the recipes that take it. The economy tools write these lines into each such
recipe. The lines are read and written on the collectible. `made` is written at its mint. `used`, `next_use` and the
like are the project's own keys, which a `Set` may write or remove.

| Life                    | Lines                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| ready after `x` seconds | `Need { key: "made", test: Older(x) }`                                                                   |
| lasts `x`               | `Need { key: "made", test: Within(x) }`                                                                  |
| `n` uses                | `Raise { key: "used", by: 1, most: n }` (`MaxedOut` past it)                                             |
| a cooldown of `x`       | `Need { key: "next_use", test: Passed }` and `Raise { key: "next_use", by: x, most: x, from_now: true }` |
| renewed                 | `Raise { key: "used", by: -i32::MAX }` (stops at 0)                                                      |

A life can change with the recipe, whether or not units are out. A collectible on its own escrow seat can be used in
place (to refuel a ship on a mission, for example), but not burned or rolled away (`AlreadyStaked`). A need or a raise
at `PROFILE_PLACE` (255) reads or moves the player's profile instead (a level bought, for example). Such a recipe is
crafted one at a time (`OnceAtATime`).

**A set bound into a badge** is a recipe of `Staked` pieces that makes a badge. On each piece it raises a `bound` count
and its farm lock far ahead, so the pieces stay staked while the badge exists. Unbinding burns the badge and moves them
back. Give the unbind no `Pay` line.

## Holds

`hold(free_at)` hands NFTs to the project, each at `["hold", asset, free_at]`. One call can make several holds for one
fee. Until `free_at`, the authority may `release` them to any wallet, but never to a loot account (`ToTheProject`).
After `free_at`, anyone can release them home.

A release names its holds by address, so a release signed for an earlier hold never lands on a later one. Holds of one
player with one end go together.

A hold names its `player`, who made it (`payer`, who gets its rent back), and who paid for its NFT's account
(`rent_to`). A Token Metadata NFT waits in the project's token account, which is closed on the way out. A compressed
NFT becomes the project's leaf.

A hold whose NFT is proven gone from the project ([An NFT gone from the project](#an-nft-gone-from-the-project)) has
nowhere to send it. Its `release` closes the hold instead:

- anyone can send it, at any time, also while the hold runs and for a loan before it is due;
- it is free, and `to` is not read;
- the hold's rent goes to its payer;
- it emits `NftGone`, not `Released`.

When several holds are released together, the one whose NFT is gone closes and the rest go home. In js/play,
`claims()` lists such a hold of the wallet's (and a loan it made or took), flagged `gone`, and `claim` closes it.

## Contests

A contest's `ContestArgs { sides, closes_at, result_by, shares, gate, deciders, min_pot, stake, prize, nft,
prize_split, cap }` are fixed for good at `open_contest`. `result_by` may be any time, but after `closes_at` when there
are deciders. A far `result_by` holds the stakes until then (`xsolana_check` says its date in words).

Whoever names the winner can also enter the contest. The pot is paid only by a claim. With a prize to each winning
entry, no fixed stake and no gate, one person with many wallets is paid once per wallet. Entries and decisions name the
incarnation (`TermsChanged`). Sides are `u16`.

- **One list of entries** (`["entries", contest, incarnation, 0]`, `decodeEntries`) holds one record per player. A
  wallet takes one side only (`OtherSide`). The player pays for the record's bytes, which are not refunded.
  - With `stake`, every entry is exactly that amount, entered once (`BadStake`). This makes a wager.
  - With `min_pot`, a contest short of it when entries close is off (`ResultOverdue` for a side named then). This
    makes a crowdfund.
- **Verdicts**: a decider signs the message below (`verdictBytes`). For a contest with a chosen share, the body ends
  with `| recipient`. The Ed25519 precompile checks the signature right before `decide`.

  `"loot-verdict-v4" | sha256(program | contest | incarnation (u64 LE) | side (u16 LE, 65,535 is off) | expires (i64 LE))`

  A side can be named only once entries close (`EntriesOpen`), by the authority too. A call-off can come at any time.

- **Payout**: `decide` takes the shares and writes what the winners won: `pot_won`, what the pot then holds, and
  `prize_won`, what a split prize's vault received. Each winning entry's claim pays
  `floor(won × (claimed + entry) ÷ total) − floor(won × claimed ÷ total)`. Here `total` is what its side put in, and
  `claimed` is what the entries that claimed before it put in (`contestWinnings`). The parts therefore add up exactly,
  whatever the order of claims.
  - Gifts before the decision count. Tokens sent to the pot or the vault after the decision are nobody's and are
    burned at the close (wrapped SOL closes with its account).
  - A loser of a contest of tokens sends nothing.
  - The one chosen share pays the `recipient` that `decide` names.
- **A prize per winning entry** (`prize`) is given with the entry's first claim (a roll at the claim's `nonce`). The
  player may `forgo` it. A forgone part of a split prize stays in the vault and goes back to its pool at the close,
  not to later winners.
- **A prize split by stake** (`prize_split`, tokens only): its vault `["prize", contest]` opens with the contest.
  `decide` sets the whole prize aside or is refused (`PrizeNotCovered`). Each winner takes its share by stake. A hooked
  prize mint's leftover is burned at the close, not moved back, because there are no hook accounts for it. When the
  prize comes from a pool, a claim that may close the contest names that pool (`prize_pool`), and what the vault still
  holds goes back there (`WrongPool` without it; `claimIx` passes it).
- **A contest of NFTs** (`nft`, a rule): each entry stakes one NFT of any kind, compressed too. Sides count NFTs, and
  the NFTs are the pot. At the decision, each winner's share of the losers' NFTs is fixed at `min(cap, losers ÷ winners)`.
  A `cap` of 0 sends every loser's NFT to whoever opened the contest. When the NFTs don't divide evenly, the first
  winners to enter take one more each. A claim names the entries whose NFTs it moves by their place in the list:
  - its own NFT, back;
  - losers' NFTs picked by the winner (`WinnerPicks`);
  - once no winner has picks left, what they left to the opener (anyone can claim these).

  `end` leaves the rest of a winner's share to the opener. An NFT passed as its hold's address `["hold", nft, 0]` in
  place of its piece (`claimIx`'s `hold`) becomes a hold for whoever it goes to.

- **Off**: `decide(None)` calls the contest off before its result is due; the authority or a decider sends it. A
  contest still undecided past `result_by` is off by the clock (`contestOff`) and needs no decision (`ResultOverdue`).
  Every entry then takes its own back. A decision never closes a contest; the claim that leaves nothing owed does. Any
  claim closes a contest that owes nothing (nobody entered, or every part claimed), with entry 0, naming the treasury
  (`claimIx` takes `projectState`).
- **The close**: the claim that leaves nothing owed closes the contest, its list (its bytes go to the treasury), its
  pot and its prize vault. It burns what is left (wrapped SOL goes to the opener). An account the issuer froze, or that
  a burn authority blocks, is left behind, and that id can't open again.
- **Any mint**: with a mint whose new accounts start frozen (or can be made to), a winner who closes their own account
  holds up their own claim and the contest's close. A split prize minted in a token that can't be transferred must be
  given up by each winner.

## Auctions

An auction lives at `["auction", project, seller, id]`, so each id is its seller's own. The seller is its only signer.

- **Lots** (`Lot`) are one of three kinds:
  - `Item(id)`: a new unit, its serial reserved at open. Project keys only. An item switched off in the shop may be
    sold, within its stock.
  - `Roll(box_id)`: a mystery lot, made into the winner's roll at the end. Project keys only, the box alone, already
    written (`WrongRecord` otherwise). Bids are in tokens only, with no `nft_bids`. The lot is refused (`LotRefused`)
    for a box whose order with the auction's shares passes what one call can grow an account by. The box's own shares,
    a burn among them, are never read for it.
  - `Asset(address)`: an NFT its seller holds, of any kind and collection, handed to the project until the end.

  `Auction.pin` (and `AuctionOpened.pin`) keeps an item lot's serial or a roll lot's box version.

- **Bids** sign `terms` (`auctionTerms`): sha256 of the auction's bytes as read, all but the bid. The bid is
  `high_bidder`, `high`, `last_bid_at` and `held`, which sit last, with the room after them.
  - A bid is at least the reserve and at least 1. It is above the high bid by `min_raise_bps`, rounded up (at least 1),
    counted on what arrived.
  - The topped bid goes back in the same instruction. There is no record per bidder.
  - A bid in the last `extend` seconds pushes the end to `extend` after it.
  - `ends_at` and `extend` are the seller's, however far. Once a bid is in, only a higher bid hands it back before the
    end. A time written in milliseconds therefore holds the bid and the lot that long (`xsolana_check` says a far date
    in words, W-FAR-TIME).
  - With no extension or no least raise, two wallets topping each other in the last seconds keep every other bid out.
    Keep `extend` at a minute or more and the raise at 1% or more.
- **Bids of NFTs** (`nft_bids`, a rule): 1 to 3 NFTs per bid (`MAX_BID_NFTS`, not in the IDL). More is `BidTooLow`,
  and a high bid of 3 can't be topped. Compressed NFTs are refused (`CompressedBid`). The reserve (1 to 3,
  `BadAuction`) and the raise count NFTs. The topped bundle goes back at once. The record is made with room for 3 NFTs
  (96 bytes, 487,680 lamports, paid by the seller and returned at the close). A bid writes its NFTs in place, and no
  bidder pays rent. There are no shares.
- **The end** (`end_auction(reference, nonce, ending)`): anyone sends it once the auction is over. Both sides move in
  one instruction. The seller and the shares are paid only with the lot going to the winner, and a sold lot is never
  made a hold (`LotRefused`). `ending` is one of three values. With no bid, each one sends the lot home (an item's
  serial is voided).
  - `Deliver` (0): the shares take their parts, the rest goes to the lot's owner (the seller, or the treasury for an
    item), and the lot goes to the winner. If an NFT lot can't move now (its collection froze it), the end fails and
    waits, with the winning bid in the project's vault. Send it again later. After a lot sent first, `Deliver` pays
    what the bid still owes and closes the auction.
  - `LotFirst` (1): NFT lots only, for an end too wide for one transaction. For example, a compressed lot at a 17-node
    proof with 8 shares to holders and a hooked coin locks 69 accounts. The lot goes to the winner now, and the whole
    bid is written as owed (`Auction.proceeds_owed`). The next `Deliver` pays the shares and the seller. It takes no
    share accounts and no `order`.
  - `CallOff` (2): NFT lots only, before the lot has moved (`CantCallOff` after). The winning bid goes back to its
    bidder: tokens, or its NFTs, each moved or made a hold for them. The lot goes home to its seller, moved or made a
    hold for them (`order`). Who may send it:
    - **Anyone**, when the lot or an NFT of the winning bid is proven gone (its collection took it back or burned it).
      `piece::held` reads a Core asset, a token account holding a Token Metadata NFT or its mint, or a compressed NFT's
      record (`NotProven` otherwise).
    - Otherwise **only the project's owner or authority**, for the project fee (`NotAuthority`). This is the fail-safe
      for a lot that never thaws.

    `proceeds` and its account are the winner's.

  An end with no bid reads the same evidence. A compressed lot's record must be current (`prove_leaf` first), and a lot
  proven gone stays where it is while the auction closes.

  A sold roll lot splits nothing at the end. The winning bid stays in the vault as the payment of the winner's order:
  `paid` is the high bid, with the auction's `shares`, its `pin` as the box version, and no fee. Settle splits it by
  those shares, with the rest to the treasury. A roll that fails (the box was edited since the auction opened, or
  nothing is in stock) refunds the bid.

  The seller may call off an auction with no bid. Once a bid is in, the auction runs to its end, and there is no
  deadline for ending it. A sale called off emits `SaleCalledOff { auction, bidder, back, lot, home, gone, by }`, never
  `AuctionEnded`. For a lot sent first, `AuctionEnded.remainder` is 0 and the auction stays open.

  A client sends `Deliver`, or `LotFirst` then `Deliver` when `Deliver` doesn't fit. It shows a sale whose lot can't
  move as waiting, and sends `CallOff` with the evidence when the lot is gone.

- **Any mint**: with a mint whose new accounts start frozen (or can be switched to that), or that allows confidential
  transfers, the high bidder can close their own account. Every higher bid then fails, because the topped bid can't go
  back, and the high bidder wins at their price. `xsolana_check` warns (W-HOLD-UP). If the seller's account turns the
  payment away, the seller is owed it (`proceeds_owed`).
- **A lot outside the project's collections**: whoever controls its collection can stop it moving, or take it back,
  while the project holds it. The seller is paid only when the lot reaches the winner. While the lot can't move, the
  winning bid waits in the project's vault until it can, or until the project's keys call the sale off. A lot taken
  back or burned sends the bid back. A bidder's money can be tied up, but not lost (W-AUCTION-OUTSIDE).

## Offers and loans

Any wallet can open an offer at `["offer", project, maker, id]`, signing alone. An offer holds a rule, a deal, how many
NFTs it takes (`left`), and, for a bid, its shares. All its money goes into the project's vault at open and must arrive
whole (`BadOffer`). An offer is never edited. Every take signs `terms` (`offerTerms`: sha256 of the offer's bytes as
read, all but `left`, its last 2 bytes). The rule is read as the NFT comes in. The last take closes the offer.

The terms are the maker's:

- A bid's price may be 0; the bid then goes to the first taker.
- A loan's `repay` may be less than its `amount`; its lender loses the difference.
- `lasts` may be any `u32` of seconds.

`amount` and `lasts` must be above 0 (`BadOffer`).

- **Bid** (`Buy { price }`): `sell_to_offer` sends the NFT straight to the maker, and the price through the shares to
  the seller.
- **Loan** (`Lend { amount, repay, lasts }`, no shares): `borrow` puts the NFT in a hold at `["hold", asset, due]` with
  a debt, and pays out `amount`. The borrower picks `due`, at most `lasts` away.

  Before `due`, anyone may `repay(home, repay)`: the borrower, a friend, a guild. The call names the amount it saw.
  - With `home` (the default a client sends), the NFT goes to its borrower in the same call and the hold closes, with
    its rent to the borrower (`Repaid` with `home`, and `Released`). If the NFT can't move, the whole call fails and
    nobody pays.
  - Without `home`, only the money moves. The hold becomes a plain hold that is over (no debt, `free_at` 0, still at
    the address its loan named), and anyone can `release` the NFT home later, free. This is for an NFT frozen for now,
    or a compressed NFT whose proof doesn't fit beside the repayment.

  Two accounts follow `system_program`: `borrower` (writable, the hold's player) and the NFT's `piece`. When the NFT
  goes home, a compressed NFT's proof comes first among the remaining accounts.

  Either way, the NFT's evidence must show the project still holds it: `NotTheNft` when it is proven gone, `NotProven`
  when nothing shows it. Nobody repays for an NFT its collection took back or burned. There is one exception: repaying
  the money alone for a compressed NFT goes through when its record shows nothing (out of date). This is because anyone
  with a leaf in its tree can keep a record out of date. Prove the leaf in the same transaction when it fits.

  Measured sizes:
  - a compressed NFT at a 17-node proof going home needs v0 with a lookup table (479 bytes with its `prove_leaf`);
  - the money alone for that NFT fits legacy when its record is current (862 bytes);
  - a programmable Token Metadata NFT going home fits legacy (958 bytes).

  From `due`, the loan can't be repaid (`LoanDue`), and anyone can release the NFT to the lender (`OwedToLender`;
  `releaseIx`'s `to`). js/play's `claims()` lists it for the lender. There is no grace period, extension, partial
  repayment or liquidation, and the authority has no say.

- **A loan whose NFT is gone**: an NFT taken back or burned by whoever controls its collection while the project held
  it can't be repaid (`NotTheNft`). Its borrower keeps what they borrowed, and the lender gets neither the NFT nor the
  money. Anyone can then close its hold with `release`, at once, also before it is due. The debt ends unpaid, and the
  hold's rent (about 0.0026 SOL) goes back to the borrower who paid it (`NftGone`, no `Repaid`, no `Released`).
  js/play's `repay` says so before anything is signed, and `claims()` lists the loan for both sides. Check the NFT's
  collection before lending against it.
- **Any mint**: with a mint whose new accounts start frozen (or can be switched to that), or that allows confidential
  transfers, a lender can close their own account so that the repayment can't arrive. The lender then takes the NFT
  when the loan falls due. A token that can't be transferred can't be paid in. A mint's issuer (freeze, pause, hook,
  permanent delegate) can also block a repayment. The borrower checks the mint (the client warns).
- An offer trusts its rule's collection. The switches refuse `open_offer`, `sell_to_offer` and `borrow`, but never
  `close_offer`, `repay` or a default's release.

## Listings

Any wallet can list an NFT of any kind at `["listing", project, asset]`, signing alone. The project holds the NFT
meanwhile, so an NFT is in at most one listing of a project. A game finds its renter with one read (`renterOf`; `user`
and `until` sit at offsets 129 and 161).

A listing names a mint, a deal and its shares (no `Chosen`). It is never edited. Every take signs `terms`
(`listingTerms`: sha256 of the listing's bytes as read, all but `user`, `until` and `stopped`, bytes 129 to 170).

- **Sale** (`Sell { price }`): `take_listing` pays from the taker through the shares to the maker and hands the NFT
  over. The listing closes.
- **Rental** (`Rent { price, lasts, max_periods }`): the taker pays for 1 to `max_periods` periods and is the `user`
  until `until`. The NFT stays with the project. Nobody can end a rental early (`Rented`). During a rental,
  `close_listing` only stops new renters (`ListingStopped`). After `until`, it sends the NFT home.
- A take of a Token Metadata NFT, a rental's too, passes the project's token account of it (`project_token`). The
  program reads it to see that the project still holds the NFT.
- **A listing whose NFT is proven gone** ([An NFT gone from the project](#an-nft-gone-from-the-project)) closes without
  the NFT, with its rent to its maker. Its maker closes it with `close_listing`. Anyone closes it with `take_listing`:
  the taker pays nothing and no fee, whatever the switches say, but the terms signed must still be the listing's.
  - A rental that runs is kept. A stranger's take is refused (`Rented`), and its maker's close only stops the listing.
    The listing closes once the rental has run, and what the renter paid stays with the maker.
  - In js/play, `unlist` is for the maker and `closeGone` is for anyone. `buyListing` and `rentListing` refuse such a
    listing in words; sent all the same, the take would only close it.
- Rules don't read rentals. A rented NFT passes no gate and boosts nothing as its renter's; a game reads `user`.
- Any price is allowed, 0 too: a sale at 0 goes to its first taker, and a free rental to anyone for its full run. Any
  length is allowed (`lasts` and `max_periods` above 0, `BadListing`). A payee's account that can't take its part is
  passed over, and the part goes to the maker. If the maker's own account fails, the take fails.

## Making collectibles

The `collectible` instruction has these actions:

- `Make { item, tree, attributes }` mints one of an item to each owner the instruction names, in serial order, at
  `["asset", item, serial]` (`makeIx`, `madeAssets`). With `tree`, it mints a compressed NFT into that tree of the
  project's instead. A sold-out item refuses the whole call (`PrizeNotCovered`); a switched-off item still makes.
- `Set` rewrites attributes, but never `item_id`, `rarity` or `serial`. It keeps `made` (the program's only key of its
  own) unless `made` is named. On an NFT the project has no authority over, it writes the Sheet.
- `Burn` burns a burnable collectible the project doesn't hold. It names the holder, who gets its rent.
- `Profile` writes a wallet's profile (below).

## Profiles

What the project writes about a wallet lives in the wallet's **profile**, at `["profile", project, wallet]`
(`{ project, wallet, attributes }`, sized to fit, `pda.profile`). Examples are a player's XP, level, rank, or a jail
time. The profile belongs to the wallet, so it can't be sold or lent.

Three things write a profile:

- the authority (`collectible` `Profile`), for what only the game knows;
- a farm's growth (`Growth { profile: true, at_least }`), for time staked;
- a recipe the player crafts (a need or a raise at `PROFILE_PLACE`), for a level bought.

Nothing else writes it, the player included. Every write emits `ProfileWritten`, and whoever writes pays for what it
adds. A profile never closes: a missing number reads as 0, and a missing time as long past. Its seed and discriminator
are its own, never a Sheet's (`WrongProfile`).

- **Read by rules** (`Of::Profile`): profiles are read by a gate on every route that takes one, by a farm's gates and
  boosts (from the seat's player's profile, beside the NFT's), and by a box's odds. A box's gate and odds read either
  all from an NFT or all from the profile (`BadRule`). A rule that says which NFT something takes never reads a
  profile.
- **Farms**: a farm that uses profiles takes the seat's player's profile on `stake_tokens`, `stake_nft`, `unstake_nft`,
  `unstake_tokens` and `refresh_seat`. A seat's boost is its NFT's and its profile's together. A token seat with no
  booster has its profile's boost. Growth on the profile adds up across a player's seats. A token seat grows it only
  while it stakes `at_least`. These need the seat refreshed first, in the same transaction:
  - a top-up, a tier change or a booster put on (`RefreshFirst`);
  - any top-up or compound of a seat with a booster on, whose boost is read again there (`stakeRefreshFirst`);
  - a booster put on a token seat of a farm whose growth writes the profile (`boosterRefreshFirst`; js/play sends the
    refresh first).

  There is no streak on a profile (`BadFarm`).

## Rules, gates, odds and boosts

A **rule** (`{ of, key, test }`) tests one attribute, named by `key`, of something the player holds. `of` says what the
rule reads:

- `Of::Collection(address)`: an NFT the player holds from that collection.
- `Of::Item(id)`: an NFT the player holds with that `item_id`. Only loot writes `item_id`.
- `Of::Profile`: the player's own profile, passed in the place where the NFT would be.

`test` is one of these:

| `Test`                     | Passes when the value                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Any`                      | — always passes                                                                                                |
| `AtLeast(n)` / `AtMost(n)` | is at least / at most n                                                                                        |
| `Equals(text)`             | equals the text                                                                                                |
| `Ahead`                    | is a time (Unix seconds, 64 bits) still to come. Example: fuel left                                            |
| `Passed`                   | is a time in the past, or is missing. Example: out of jail                                                     |
| `Within(s)`                | is a time less than s seconds ago and not in the future. A missing value counts as long ago                    |
| `Older(s)`                 | is a time at least s seconds ago. A missing value counts as long ago. Example: an egg `made` a day ago hatches |

A missing number, or text, reads as 0. The program takes what is written on an NFT as it is. Its accuracy is the
business of the NFT's collection.

`Of::Collection` of a Token Metadata collection doesn't count a **print** (token standard `NonFungibleEdition` or
`ProgrammableNonFungibleEdition`). A print carries its master's collection. But whoever holds the master can make prints
without the collection's authority, so the program reads a print as being in no collection.

**Showing an NFT** (`shownAccounts`). The accounts to pass depend on the NFT's kind:

- A Core asset of one of the project's collections: the asset alone.
- Any other Core asset: the asset, then its Sheet's address.
- A Token Metadata NFT: the mint, the metadata, the holder's token account and the Sheet address.
- A compressed NFT: the asset id, its `Proven` record, the tree and the Sheet address.

For an NFT the project has no authority over, the program reads the Sheet over the NFT's own attributes. Such an NFT
shown without its Sheet passes nothing.

**Gates** guard boxes, lotteries, grants, contests, auctions and farms:

| `Gate`                      | Passes when                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Holds(rule)`               | an NFT the player shows passes the rule                                                                                                                                                                                                                                                                                        |
| `Wallets(list)`             | the wallet is in the list                                                                                                                                                                                                                                                                                                      |
| `List { root, depth }`      | the player gives a Merkle proof of `sha256("loot-list-v1" \| wallet)` (`gateListLeaf`, `gateList`). Pairs are hashed smaller first, and an odd last node is sent up. The proof has exactly `depth` nodes, each passed as an account of the transaction                                                                         |
| `Staked { farm, at_least }` | the wallet's token seat in `farm` holds at least `at_least` (above 0), was staked before the current second, and its tier's lock is running. A tier with no lock or with an early exit never passes. What counts is what the seat held when its lock last started (`Seat.locked`), so one stake counts for one wallet per lock |

A farm's gates are rules that one NFT (or the player's profile) must all pass. A grant's gate reads the receiving
wallet. A box's gate can change with an edit of the box, and a lottery's gate between rounds. Other gates never change.

A rule's `OneOf` texts (at least one) have no count limit of their own. The size of the record that holds the rule
bounds them. Two places have a lower limit, because the oracle's answer reads the texts: a lottery's NFT ticket's rule
holds at most 170, and a box's gate about 340 (`xsolana_check`).

### Odds and boosts

**Odds** belong to a box (`Odds { entry, boost }`, any number of them). **Boosts** belong to a farm
(`Boost { rule, effect }`, within `max_boost_bps`). Both use an effect, in basis points of the weight:
`Effect::Flat(bps)` or `Effect::PerPoint { bps, most }`.

In a farm, one boost alone (`Flat`, or `PerPoint`'s `bps × most`) and the farm's `max_boost_bps` can each go up to
10,000,000 (+100,000%, ×1,001). One more fails with `BadFarm`.

A box's odds have no such cap. A boosted weight is `min(4,294,967,295, weight × (10,000 + bps) / 10,000)`. The kit
computes it with `boostedWeight` in BigInt, because the product can pass 2^53. Boosts on one entry add up and stop at
the largest `u32`. Two entries boosted past the largest weight are equally likely.

A box's rules may read the player's profile and a shown NFT together. `open_box` reads them in this order:

1. The profile. Its account comes after a list's proof, or after a stake gate's seat and farm.
2. The shown NFT, when a rule reads one. A box that rolls on an NFT reads that NFT as its piece.

`open_box` then fixes the odds they raise in the order (`OddsRaised`, with `profile` and `asset`).

**A roll another route makes** (a recipe, a grant, a mission, a lottery's place, an auction's lot) reads them at its
**first ask**. The ask is `ask_roll`, which only the order's player or the project's keys can send (`NotAuthority`). It
takes these accounts after the accounts it took before:

- the order's player's profile `["profile", project, player]`, when any odds rule reads a profile;
- an NFT the player holds, with the accounts `open_box` takes for a shown NFT, when any rule reads an NFT and the roll
  is not on an NFT.

Each account must be the order's player's own, whoever sends the ask. Anything else reads as nothing. This includes an
account of another kind in a profile's or a Sheet's place: the program checks its tag, project and key before it reads
it. Odds never stop a roll.

Their boosts add to what the NFT the roll is on raised when the roll was made. A later ask reads nothing. After an edit
of the box, the next ask reads them afresh. As a result:

- a player may level up before asking;
- a profile rule can only add, because a player may leave the profile out;
- a roll asked without them stays at the odds it was made with.

## Farms

```
weight = staked × tier.bps / 10,000 × (10,000 + boost) / 10,000
staked = tokens, or NFT_UNIT (1,000,000) for one NFT
```

`FarmArgs { custody, tiers, boosts, max_boost_bps, gates, rate, growth, ends_at, lock_key, upkeep_key, exit_to }`. A
farm takes a token (`staked_mint`) or NFTs of any kind that its gates name. A farm is never edited and never closes. A
new mission is a new id.

The farm's rewards (`rewards_mint`) go to a vault of its own, `["rewards", farm]` (`pda.rewards`). A split's or a
schedule's `To::Account(vault)`, or a plain transfer, funds it.

The farm keeps what it owes its seats as a number (`Farm.owed`, ×10¹²). What the vault holds beyond that is free
(`vault − owed / 10¹²`). Only free tokens are released, paid at a rate, or taken back by the authority. To take them
back, the authority sends `move_tokens` from `TokenSource::Farm(id)` with:

- a fixed amount;
- the vault as `pool`;
- the farm as `farm`, writable, because the farm is credited first;
- `mint` set to its rewards mint (`WrongMint` otherwise).

Crediting a seat moves no tokens. Only a payout moves them.

### Tiers

A farm has **tiers**: 1 to 256, and a byte names one. A tier is `{ lock, bps, prize, roll, exit_bps, earns_for }`:

- a lock, in seconds;
- a multiplier above ×0 and up to ×100 (`bps` up to 1,000,000, `BadFarm` past it);
- a term (`earns_for`, below).

A seat's weight stays a million times inside 128 bits. Near a quarter of 128 bits, a seat weighs only what is left.
Read a seat's weight from the seat or its receipt, never from the formula alone.

A mission (a tier's `prize` or `roll`) may have no lock. Then one NFT can stake and leave again and again and take the
mission each time.

A token seat can move only to a tier that locks as long or longer. Every stake, and every booster put on, restarts the
lock.

### Custody

**Custody** applies to NFT farms:

| `Custody` | The NFT                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Escrow`  | is handed to the project (Core transfer, Token Metadata `TransferV1`, Bubblegum `TransferV2`). A soulbound NFT is refused (`SoulboundEscrow`). The default in economy specs                                                                                                                                                                                                                     |
| `Freeze`  | stays in the wallet, locked with the project as the only lock holder (Core freeze; legacy approve and freeze; pNFT `StakingV1` delegate and lock; compressed delegate and freeze). Soulbound NFTs need this mode. A lock that isn't the project's, or is off, reads as the NFT gone                                                                                                             |
| `Watch`   | stays free and can be sold. It earns only while its staker holds it. Whoever finds it gone (a refresh, harvest or unstake that shows where it is) returns what the seat was owed to the farm. Its next holder takes the seat over (`stake_nft` with `previous`, repaying the seat's rent). Not for token farms. Handing the NFT to the project (a hold, listing, loan) counts as not holding it |

A frozen or held NFT is in one farm at a time. A soulbound or watched NFT can sit in several farms, but not twice in the
same farm (`AlreadyStaked`).

What a farm grows on a Token Metadata or compressed NFT goes in its Sheet (`WrongSheet` when the Sheet is left out).

`stake_nft` puts an NFT on its own seat, or on a token seat as that seat's **booster** (one at a time). Boosts are read
on staking and by `refresh_seat`. `refresh_seat` also drops a seat's weight if its NFT left or no longer passes. Nothing
refreshes by itself.

### Rewards

**Sharing rewards** applies when the farm has no rate. The free tokens in the vault are released along a straight line
over the farm's span. The span is the farm's longest lock, and at least a day. Released tokens are credited to seats by
weight.

New funding is counted at the next move, and it moves the line's end by its share. So no seat is credited at once with
what landed before it. A stake and a harvest in one transaction take nothing. The clock pauses while nobody weighs
anything.

Rounding fractions are kept, so frequent refreshes lose nothing. The farm's **carry** is that rounding. It is credited
to whoever is in once it adds up to a share. When no weight is left, the carry's whole tokens are free again. This
happens:

- at the end of a move that leaves no weight;
- where a walk of the record of ends takes the last weight out, or begins with none. This includes `walk_farm`'s walk
  and the authority's take-back of free tokens (`TokenSource::Farm`). It happens before any weight that the move
  brings comes in.

**Weight that leaves the farm frees its share of the carry's whole tokens, and the weight that stays keeps its own**
(`Farm::free_share`). The rounding that a leaving weight leaves goes back to the project. Weight leaves:

- when a seat goes out (an exit, a forfeit, a watched NFT found gone);
- when a seat weighs less over the whole of its move (a part taken out, a booster off, a lighter tier, a refresh that
  finds it weighs less);
- when the walk of the record of ends passes a seat's end and takes its weight out, once.

Only the drop in the farm's total across the move counts. A top-up, a refresh that changes nothing, a tier move or a
booster put on frees nothing. A seat that weighs as much or more loses none of its rounding.

The share is the carry's whole tokens times the leaving weight over the total before it, rounded down. Both weights are
cut by one shift to their top 40 bits (the total rounded up). The share fits 128 bits for any farm and is never more
than the exact share. No way out of a farm fails on it.

The share is worked out at every end a walk passes, so it is kept cheap. A carry under one token works nothing out. A
carry under 2^24 whole tokens is worked out in 64 bits, with the same result. What rounding leaves stays in the carry,
with the seats that stay.

Before this, the seats that stayed were credited all of the carry, the leaver's part too. That part was at most the
leaving weight times 10⁻¹² tokens, all of it to a wallet of 1 unit when it was the only one left.

"Free again" means what it means for anything a seat gives back:

- with a rate paid from the vault: free in the vault, and the authority's to take back;
- with a rate that mints: never minted;
- in a sharing farm: released again over the span to the seats there.

A stranger can stake and leave in one transaction. That frees its own weight's share of the carry to the project, never
to itself, and costs two player fees. A player's own numbers do not change in any way a client shows. What a farm holds
free can be a few whole reward units higher after a large seat leaves.

**A fixed rate** (`Rate { per_day, mints, shared, halve_every }`) pays `per_day` base units for each `NFT_UNIT` of
weight, by the second. With `shared`, `per_day` is the whole farm's, shared by weight while anything weighs (an emission
budget).

The rate halves every `halve_every` seconds from the farm's opening (`Farm.opened_at`). A value of 0 means it never
halves. Payment is worked out in closed form from what the rate paid a unit between two times (`farm::paid`). A lapsed
seat's share is worked out the same way.

When a seat is paid, the rewards are minted as far as the supply has room. The project must be the mint authority, and
the mint is written only on a move that pays. Otherwise they are paid from what the vault holds free, as far as it
goes. What can't be covered isn't owed later.

**The room a farm that mints counts on is not kept for it.** What the farm owes is counted against the mint's room only
in that farm. Anything else that mints the same mint can take that room: a mission's prize, a second farm, a box's
minted prize, or the project's own mints. Then, while the mint holds within what the farm owes of `u64::MAX`, a seat's
harvest fails in the token program, and so does its unstake with its rewards. `forfeit` still takes the stake or the NFT
out, giving its rewards up. Once anyone burns enough of the mint, paying works again. This matters only for a mint near
its largest supply.

A rate of 0 pays nothing (a farm for growth or prizes only).

**Given back** rewards (from a forfeit, or a watched NFT gone) have their whole tokens free again at once. They are
released again like anything that lands; a farm that mints simply never mints them. They are never credited at once to
the seats there.

### Growth, ends and locks

**Growth** is up to 32 entries of `{ key, per_day, level, steps, streak, profile, at_least }`, with up to 128 steps
each. An NFT on a seat earns `per_day` points a day, times its tier and boost, under `key`. The level it reached (among
its rising `steps`) goes under `level`. With no steps, the points are the level.

Growth is written by `refresh_seat` and on the way out, at the signer's cost. It goes on the NFT where the project may
write, otherwise in its Sheet. With `profile`, it goes on the seat's player's profile.

Points add to what is there, so two farms on one key add up. A level never drops, except with `streak`, which resets
points and level when the NFT leaves.

An `unstake_nft` with `forfeit` writes no growth, and it gives up the rewards and the prize. It is the way out for an
NFT that can't be written: one whose attributes reached what its program can rewrite, or whose collection took back the
project's right to write.

A boost that reads a level the farm's own growth writes counts each level from when it is written, which is
`refresh_seat`. So a project that boosts by a growing level has its page or a keeper refresh seats.

**An end** (`ends_at`): no new seat can start at or after it, and no seat whose lock runs past it (`FarmOver`). Rate,
growth and release stop at the end. What isn't released by then stays free in the vault. Fund a farm a span ahead of
its end.

**The lock on the NFT** (`lock_key`, NFT farms): staking writes the lock's end under that key, never sooner than an end
already there. The NFT leaves once that time comes. A recipe that lowers it is a paid early exit. A roll that raises it
is jail. Two farms on one key share a lock.

A watched NFT that can't be read on the way out is treated as gone. The seat closes on its tier's own lock, giving up
rewards, prize and roll.

### Earns until

**Earns until** (`Seat.earns_until`, `i64::MAX` for no end) is the time a seat stops earning and growing. It is the
sooner of two times:

- **Its tier's term** (`Tier.earns_for`, in seconds after its lock started, `Seat.since`; 0 for no end). Every stake,
  and a booster put on, starts the term again with the lock. So a token seat renews its term with a `stake_tokens` of
  nothing at its tier. With a growth, or a booster on, send `refresh_seat` first in the same transaction
  (`RefreshFirst`). A compound starts neither. One term on every tier is a farm-wide end of earning for each seat.
  Tiers of different terms are terms or missions of different lengths.
- **Its NFT's fuel** (`upkeep_key`, NFT farms): a time until which the NFT earns (fuel, food, a license). It is bought
  with a recipe raise `from_now`. The farm reads it at stake and refresh, so send `refresh_seat` with the refuel. A
  recipe never lowers a number the farm reads on an NFT on a seat (its upkeep, or a key its boosts or gates read;
  `BadRecipe`). An NFT on a Freeze or Escrow seat passes its seat and farm after it in every craft line (`craftIx`'s
  `{ asset, farm }`). In a `Show` line it does so only when a raise lowers a number on it.

What a seat earned up to `earns_until` is exact, however late the seat is touched. Nobody has to act at that time.

### The record of ends

A farm keeps a **record of ends** (`["ends", farm]`, `Farm.keeps_ends`, `decodeEnds`) when its tiers have a term or it
has an upkeep, and it pays anything. A farm with a rate of 0 has nothing to credit and keeps none. Any other farm passes
no record (`WrongEnds`).

The record is a list sorted by time, 44 bytes for each different time waiting. Each entry holds the weight that stops
then, `reward_per_weight` at that second once walked, and the seats that still need it.

A seat joining a time that has no entry pays what its rent lacks, using spare rent in the account first. The entry goes
when its last seat leaves, and its rent stays with the account for the next time written.

Whatever moves the farm walks every time it has passed, in order. At each time, it credits up to that second by the
weight then in, writes `reward_per_weight` there, and takes that weight out of the total. As a result:

- nothing released after a seat's end reaches it;
- nothing earned before its end is lost;
- the seats that stay earn by the weight really there.

A walk costs up to about 3,150 compute units for each time, at the dearest farm: a halving rate and very heavy seats,
with each time also freeing the leaving weight's share of the carry. With light seats it costs about 2,270. A farm that
has passed more times than a transaction can walk is walked in parts by `walk_farm`, which is anyone's and free. Every
move then walks the rest. The client walks 400 times a `walk_farm` (`WALK_PER_TX`) and lets a move walk 300 first
(`MOVE_WALK_ROOM`).

The record holds 238,312 different times at most (what an account holds). The first staker on a new second pays about
0.0003 SOL for its entry. When the record is full, a stake at a new end time fails until older seats are touched. An
insert took 145,279 compute units at the full list, so ask for more than the default compute on a stake in a large
farm.

Growth counts only up to the end. A mission's prize needs the fuel to last the tier's lock or its term, whichever is
shorter. A lapse before then marks the seat `dry` for that stay. A tier whose term is shorter than its lock still gives
its prize once the lock has run.

### Missions

**Missions** (`Tier.prize`, NFT farms): an NFT that leaves its own seat after its tier's lock, and was never dry, takes
the prize. The prize is one of:

- tokens (a fixed amount, grown by its boosts);
- a collectible;
- a stash NFT;
- a chest (its order at the unstake's `nonce` plus 1).

`forfeit` gives the prize up. A prize that can't be given is passed over. A tier with a prize needs a lock above 0
(`BadFarm`).

### Leaving a token farm early

Fees for leaving a token farm early go to a `Sink`:

- burned (not for wrapped SOL);
- a pool in that mint;
- `Rewards`, the farm's own vault, where the fees are free for the seats that stay. Only a farm whose staked mint is its
  rewards mint can use it, else `WrongMint` at `open_farm`.

There are two ways to leave early or take rewards into the stake:

- **Early exit** (`Tier.exit_bps`, `exit_to`): a seat leaves before the lock ends by leaving that share of its stake,
  rounded up. With 0 it can't (`StillLocked`). It keeps the rewards it was credited, so a tier's weight can be bought
  for its exit fee. While locked, a seat moves only to a tier with no early exit, or to one whose early exit costs at
  least as much as its own (`ExitWhileLocked`). It never moves to a way out it didn't have, or a cheaper one. What is
  taken out leaves at once: there is no unbonding.
- **Compound** (`harvest` with `compound`, for rewards in the staked token, else `NotCompoundable`): rewards join the
  stake without restarting the lock. A compound is refused while the farm is paused or suspended.

Stakes and rewards stay in separate vaults, even in one mint. Pause and suspend never block unstake, early exit or
harvest. `forfeit` skips rewards that would block a withdrawal. Farm builders take `extra` remaining accounts for hooks
and Core escrow adapters (`transfers` for dynamic hooks).

## An NFT as the price

Every route that takes money can take an NFT instead. A `Spend` says where the NFT goes: `Burn`, `Give(wallet)` or
`Stash(id)`. An `NftPrice` is a rule and a `Spend`. A burned or given NFT moves straight from its holder. A stashed NFT
is handed to the project, and the stash grows by 36 bytes (its row: weight 1 and the NFT) at the holder's cost.

| Route      | NFT price                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pay_nft`  | any NFT, burned or given to a wallet. The `PaidNft` receipt is the record. A semi-fungible Token Metadata unit passes here, so an app that admits players on `PaidNft` checks the mint's supply. Never into a stash |
| a box      | the NFT it rolls on (`subject`). Each fate says where it goes. It goes home on a refund                                                                                                                             |
| a recipe   | `Input::Trade { collection, then }`                                                                                                                                                                                 |
| a lottery  | `nft_ticket`: one NFT per ticket, held until the draw                                                                                                                                                               |
| a contest  | `nft`: one NFT per entry, of any kind. Winners take the losers' NFTs                                                                                                                                                |
| an auction | `nft_bids`: NFTs as a bid, not compressed                                                                                                                                                                           |

## Every kind of NFT

Every route that takes an NFT takes its accounts as a `Piece`. Whatever the NFT's kind, the route moves it in the same
few ways: read it, lock it in its wallet, hand it to the project and on, or pass it straight on from its holder.

The client's `piece` builder makes a `Piece` for any kind, with only the accounts a route uses. Collections, trees and
leaf records are writable only where a call writes them, so a hold never write-locks a collection or tree.

| Kind                          | The `Piece`                                                                                                                                                                                                                           | Lock                                                                              | Hand to the project             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| Core                          | the asset, its collection (left out for none), Core, its Sheet when the project has no authority                                                                                                                                      | a freeze delegate                                                                 | Core `TransferV1`               |
| Token Metadata (legacy, pNFT) | mint, `metadata`, `edition`, the wallet's `token` and `token_record`, the project's `project_token` and `project_record`, `rule_set`, `rules_program`, Token Metadata, the instructions sysvar, SPL Token, the ATA program, its Sheet | legacy `Approve` + `FreezeDelegatedAccount`; pNFT `Delegate` (StakingV1) + `Lock` | `TransferV1` under its rule set |
| Compressed (Bubblegum v2)     | asset id, its Core collection, its `leaf` record, `tree`, `tree_config`, the leaf's delegate if any, Bubblegum, mpl-account-compression, mpl-noop, its Sheet; the proof's nodes first among the remaining accounts                    | `DelegateAndFreezeV2`                                                             | `TransferV2`                    |

- **Only an NFT goes into the project's hands.** A Token Metadata mint must be one token that can never be minted again
  (`NotAnNft`). The project's token account for it closes only when empty, so a token sent beside it never blocks it.
- **Token Metadata receivers.** The NFT goes out to the token account the sender passes as the receiver's. That can be
  any account of the mint that the receiver owns. If the receiver's associated account belongs to another key or is
  frozen, the sender makes a fresh one (`freshNftAccount`). For a pNFT, the token record is then the record of that
  account. The client does this in every js/play hand-out, through `nftOf(asset, signer, { to })`: an outbid bidder's
  NFTs handed back, an auction's end, a listing, a settle, a release and the rest.
- **pNFT token records.** The rent goes to whoever pays the move out. On a listing's sale, the maker doesn't get the
  record's rent back (about 0.00145 SOL).
- Compressed NFTs of v1 trees are refused.

**A compressed NFT is proven first.** Its leaf comes from an indexer (DAS `getAsset`, `getAssetProof`;
`compressedFromDas`). `prove_leaf` checks the leaf against a tree whose authority is Bubblegum's own `TreeConfig`. The
proof must be at the current root, or at a root still in the tree's change log with no change since at that leaf
(`StaleProof` otherwise). `prove_leaf` then records owner, delegate, collection, hashes, flags and root at
`["leaf", asset]`.

An empty leaf at or past the tree's `num_minted` is no NFT (`NotTheNft`). Neither is an account that is not a tree but
is passed as one.

Routes read the record only while its leaf is unchanged and its root is still in the log. Otherwise they fail with
`NotProven`, and never read it as the NFT gone. Other leaves moving never spoil the record, so two compressed NFTs of
one tree can move in one instruction. Anyone may re-prove at an older root, so **prove in the same transaction as the
move** (v0 with a lookup table if needed; the client does).

A data hash of all zeros means burned. A wrong proof on a route fails inside Bubblegum and uses the whole compute
budget. The error is poor, but the move is never wrong.

**What a rule reads.** A rule reads a Core NFT's own attributes and, for an NFT the project has no authority over, its
Sheet. A route **between players** (an offer's bid or loan, an auction's NFT bid) reads an outside NFT **without** its
Sheet. It reads a Core NFT by its own attributes and other NFTs with none. So only `Any` passes on a key the NFT doesn't
carry, and the project can't make a cheap NFT pass a stranger's offer by writing its Sheet.

## An NFT gone from the project

Whoever controls an NFT's collection can take the NFT out of the project's hands, or burn it, while a record holds it.
That control is a Core collection's permanent transfer or burn delegate, or the same on a compressed NFT's collection.
The record can't send the NFT anywhere then.

When the NFT is **proven gone**, the instruction that would have moved it, sent with its usual accounts, finishes
without it. It writes `NftGone` with the record, the NFT and who sent it. No receipt says the NFT moved.

**Proven gone** is read only on evidence, never from an account left out:

- a Core asset: the asset itself, held by another or burned;
- a Token Metadata NFT: its one token in another owner's account, passed in the place of the receiver's token account
  (the builders' `tokenMetadata.evidence`), or its mint holding none (burned);
- a compressed NFT: its record (`prove_leaf`), still current with its tree, naming another owner or burned
  (`compressedFromDas` reads a burned one as its empty leaf).

Anything else shows nothing, and the instruction goes its usual way: it moves the NFT or fails as before. A frozen or
locked NFT that the project still holds is held, not gone. A compressed NFT's record proven before its leaf changed
reads as nothing.

**Who sends it:** anyone, at any time, for no fee, because nothing is chosen. An instruction with a signer of its own
keeps that signer: `settle` (the player, the key they named, the project's keys) and `close_listing` (its maker; anyone
else uses `take_listing`). `refund` keeps its timing.

**Where things go:**

- A hold closes at once, even while it runs, and its rent goes to its payer. A loan's debt ends unpaid. No repayment is
  taken for an NFT gone, so the borrower keeps what they borrowed and the lender gets nothing.
- A listing closes once no rental runs, and its rent goes to its maker. A running rental is kept; the listing only
  stops. What a renter paid stays with the maker.
- An order ends without the NFT. A refund pays the whole payment back. A settle splits the payment and gives the other
  prizes as rolled. The NFT rolled on is not sent back, burned, given or stashed (no stash row). A stash's NFT that the
  roll won is not given (`PrizeForgone` for it, beside `NftGone`) and not put back on the list. Read that
  `PrizeForgone` as a prize not given, whoever settled.
- A project's stash's row comes off the list, and anyone can send this. The stash keeps the rent it no longer needs,
  unless the project's keys send it. A lottery's own stash is the project's keys' alone, as before. Its rows are what
  its raffle draws from, and `promised` keeps them while a round draws from them. The project's keys take a gone NFT's
  row out on the proof the same way.
- A lottery NFT ticket passed as itself goes nowhere. Its part settles (`LotteryPulled` with amount 0, beside
  `NftGone`).
- An auction already did this (`end_auction`: `CallOff`, and a lot going home), and so does a farm's escrow seat
  (`unstake_nft`).

**What still stays:**

- A record still takes its NFT if the NFT came back into the project's hands under another record before the first
  record was closed. The NFT is held, not gone. A client clears an NFT's old records (`release`, `take_listing` on the
  proof) before it hands the NFT in. js/play does this in front of every deposit, in the same transaction when it fits.
- An NFT that its controller sends back to the project after its records closed sits there under no record. That
  controller can take it again.
- A taken Token Metadata NFT leaves the project's token account empty, with its rent.
- A route that turns an NFT it owes into a hold (an auction's bid, a contest's NFT, a lottery's place or ticket) reads
  nothing first, so it can make a hold of an NFT gone. That hold then closes on the proof, by a `release` after the
  instruction that made it. These are two instructions, which js/play sends in one transaction when they fit.
- A stash's NFT that its winner gives back in a settle goes back on the list, gone or not. Anyone then takes the row
  off.

**In js/play:**

- `claims()` lists the wallet's holds, and the loans it made or took, whose NFT is gone (`gone`). `claim` closes one.
- `unlist` closes the maker's listing.
- `closeGone(asset)` closes an NFT's holds and listing and takes its row off each of the project's stashes, for anyone
  (`unstashed`). A lottery's own stash that lists the NFT is left, and named in `waits`.
- `unraffle` takes the NFT's row out of a lottery's own stash, for the project's keys.
- `collect` says which NFTs a settle passed over (`gone`). A prize among them is not in `assets`.

The routes that hand out an NFT a record owes finish without it when it is gone, for every kind of NFT. `claims()` flags
each such claim `gone`, with what it does in words (`says`) and the NFTs (`assets`):

- **A lottery's part** (`pull`, `payout`, and the pull a cancelling draw carries). A ticket whose price sends it on
  settles on the proof. A ticket going back to its buyer, and a place's NFT, are passed as their hold, and a `release`
  on the proof follows the pull. A pull makes holds of all its prize NFTs or of none. So when one of them is gone, the
  others are made holds too and released on to their winner in the same transaction.
- **A contest's claim.** The entry's own NFT, or a loser's NFT the winner picks, is passed as its hold and closed the
  same way. A winner's picks go first to the losers' NFTs the project still holds.
- **An auction** (`endAuction`, and the end `claim` sends):
  - With no bid, a lot gone stays where it is and the auction closes.
  - A sale whose lot, or an NFT of whose winning bid, is gone is called off on the evidence.
  - The project's own lot, and a lot that went first, are ended with that NFT passed over.

  The result says which (`gone`, `says`). A bid over a high bid with an NFT gone makes that NFT a hold for its bidder,
  and closes the hold in the bid's own transaction.

Where the program makes a hold, it writes that hold's receipts (`Held`, and `PrizeGiven` for a place's prize) before
the release's `NftGone`. Read `NftGone` for that hold as the NFT not given: no `Released` follows it.

## Sheets and off-chain traits

The project writes attributes on an NFT only where it has authority: its collections' NFTs, and a Core NFT whose
Attributes plugin names the project. For any other NFT, it writes in the NFT's **Sheet**, `["sheet", project, nft]`
(`{ project, nft, attributes }`, `decodeSheet`). A Sheet is written by:

- the authority, with `collectible` `Set`;
- a farm's growth;
- `prove_traits`, which anyone can send.

The sender pays the growth. A Sheet stays with its NFT, never closes, and never says who holds the NFT. Rules, odds and
boosts read it over the NFT's own attributes. A seat refresh without it is refused (`WrongSheet`).

**Off-chain traits.** `set_traits(key, root)` writes the root of a Merkle tree of `(nft, attributes)` at
`["traits", project, key]`. By convention `key` is a collection's address. A new root replaces the last one. Anyone
proves an NFT's traits into its Sheet with `prove_traits`. The tree (`traitsTree`) uses:

- leaf `sha256(0x00 | nft | Borsh(attributes))`;
- node `sha256(0x01 | min(a, b) | max(a, b))`;
- an odd last node sent up.

A proof writes only keys the Sheet lacks. It never writes empty values, and never a key a Core NFT carries itself. To
retire a trait, set a new root or write over it.

## Grants

`GrantArgs { gives, vouchers, list_root, key_root, open, limits, active, gate, shard_bits }`. A grant gives its `Prize`
to a wallet in three cases:

- A **voucher key** signs for the wallet. Up to 3 keys can be in `vouchers`, or any number under `key_root`. A key under
  `key_root` is proven with a Merkle proof of `sha256("loot-key-v1" | key)` and limited by `per_key` (a promo code).
- The wallet is on the **list** (`list_root`).
- The wallet comes to an **open** grant.

A claim with no voucher goes by the list when there is one. Otherwise only an open grant takes it. With none of these,
the grant pays nobody. An open grant gated on a collectible counts the collectible too (a badge), so moving it claims
nothing more.

**Every claim is signed by its wallet** (`WalletMustSign`), so only the winner chooses when it lands. A results server
hands out the voucher, and the winner's page sends the claim. A grant therefore pays only wallets that can sign: a
person, or a program that signs by CPI such as a Squads vault. It can't pay an exchange deposit address.

**Limits** (`{ all, wallet, per_key, tokens, window }`):

- `all`: all wallets together. It is a `PerWallet`: a limit in all and per window (86,400 seconds is a UTC day).
- `wallet`: per wallet, the same shape. With `wallet.by_person` it limits per person instead. The person is the one a
  voucher of the project's issuer or the list names, else the wallet's link. A claim naming nobody is refused
  (`NotLinked`).
- `per_key`: per key.
- `tokens`: the tokens the grant gives in all (a grant of tokens only), counted in `Grant.given`.
- `window`: a time window.

A claim past a limit fails with `OverTotal`, `OverWindow`, `OverWallet`, `OverPerson` or `OverKey`. What the grant has
given is `Grant.counted` (`{ count, window, in_window }`).

Each limit record is 28 bytes, keyed `sha256(kind | subject)[..16]` (`limitKey`). The subject is a wallet, a person, a
badge or a key. The records are in the grant's claims, `["claims", grant, incarnation, shard]`. One claim touches at
most four shards.

**Rounds.** A claim names its rounds, each with a voucher or a list proof. Each round pays a wallet once per
incarnation. Its record, `sha256(round | wallet)[..16]` (`roundKey`, 16 bytes), is in the wallet's shard of the grant's
rounds, `["rounds", grant, incarnation, shard]`. As a result:

- replays, re-signs, other keys and clocks set back are all refused;
- a round named twice is paid once;
- the same voucher sent again later pays the rounds that a full limit held back.

A grant's records are in `2^shard_bits` shards. `shard_bits` is 0 to 8, fixed for the grant's incarnation
(`ShardsFixed`). A record's shard is its key's top bits (`shardOf`). `shardBitsFor` gives the fewest bits that keep each
shard under ~100,000 records. Once the grant is closed or made again, anyone can close its shards (`close_shard`), and
their rent goes to the owner. A claim may need 400,000 compute units (`CLAIM_COMPUTE_UNITS`).

**A claim's own amount.** A voucher or list leaf may name `amount` for a prize of `Tokens { amount: most }`. The amount
is at most `most` (rewards by rank). An amount of 0 gives the prize as written. Anything else nonzero is refused
(`OverPrize`).

**Funds** are the SOL a grant holds beyond its rent. Anyone can add funds with a plain transfer. Funds pay for the
grant's records and for what a prize opens or makes. They are lent to the claim's `signer`, who covers any shortfall.
The signer pays the player fee and a roll's order from its own SOL, never from the funds. Closing the grant returns the
rest to the owner. A prize that can't be given refuses the claim, keeping its rounds.

**The voucher** is 45 bytes, signed with Ed25519. The Ed25519 precompile checks it right before `claim_grant`, or before
the instruction that calls loot. The signed bytes are:
`"loot-grant-v5" | sha256(program id | grant | incarnation (u64 LE) | wallet | person_hash (32) |
expires (i64 LE) | count (u32 LE) | (round (16) | amount (u64 LE)) × count)` (`voucherBytes`, `voucherBody`,
`readVoucher`). So a voucher of many rounds is as short to check as a voucher of one. The bytes don't name the
cluster, so use a different voucher key on each cluster. `js/test/client.test.mjs` holds a test vector.

**The list** uses leaf `sha256("loot-list-v3" | wallet | person_hash | round (16) | amount (u64 LE))` (`listLeaf`) and
node `sha256(min(a, b) | max(a, b))`. An odd last node is sent up, and leaves are in the order given (`merkleRoot`,
`merkleProof`). Leaves don't name the program.

Test vector: wallets of 32 × `0x33`, `0x34` and `0x35`, with person, round and amount zero.

- Root: `7e7139369d9451ae178d9bdcb87322669db7533a0482e197fbcffc96c5b357cf`.
- Proof of `0x34`: `34e6a712750308f305caefb024224476bc30acf6c7587f9bb1870b1101ce806d`,
  `3628454bf3ef6e1031831ffec880b7c2a2bb7aef6c452e80ee08f019b2fb7d44`.

A key's proof is instruction data, which a lookup table can't shrink. So a key root holds at most 2^16 keys when the
wallet pays its own claim, and 2^13 when another signer pays.

## Counts

A wallet's counts are one list, `["counts", project, wallet]` (`decodeList`, `readLimit`, `countKey`). It holds a
28-byte limit record for each box, recipe or lottery that limits the wallet. Each record is keyed
`sha256(record | incarnation)[..16]`; a box's and a recipe's incarnation is 0. A record holds `count` in all, the window
it counts in, and `in_window`.

Boxes, recipes and grants use `PerWallet { total, per_window, window }`. `window` is in seconds from the Unix epoch:
86,400 is a UTC day, and 0 is off. A `per_window` with no `window` is a limit in all. Lotteries use `per_wallet` tickets
a round, and the round is the window.

The list is an optional account. Past a limit, the instruction is refused (`countAllows` says so first). The wallet
counted pays for its record's bytes once, and the record is kept for good, so an edit can't reset limits. A refunded
order gives its count back. `Window { opens_at, closes_at }` bounds boxes, recipes and grants (`NotOpenYet`,
`WindowClosed`).

## Receipts and errors

Receipts are Anchor events written to the transaction log (`receipts` in `js/client/accounts.js`). They cost no rent,
and they are the public record of the economy. `reference` is the project's own label; the program never reads it.

**Delivering from a receipt**: deliver only from a **finalized** transaction whose `meta.err` is null, and deliver once
per order or reference.

- A transaction can fail after every instruction has logged success, at the runtime's rent check at the end of the
  transaction. Such a transaction still carries the receipts.
- Accept a receipt only when its `data.project` is your project. `receipts` reads the receipts of every project, and
  anyone can create a project.
- Another program can log the same bytes. A backend that needs more assurance also checks that loot was the program
  that logged them.
- A truncated log stays truncated when you read it again. In that case, go by the account instead: a settled order's
  `settled` count, or the order's closing.

| Receipt                                                                                                                                                                                                                                                                                                                              | When                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `Paid`, `PaidNft`                                                                                                                                                                                                                                                                                                                    | `pay`, `pay_nft`                                                               |
| `Bought` (`count`), then one `PrizeGiven` per prize given                                                                                                                                                                                                                                                                            | `buy`                                                                          |
| `OrderRolled` (`entries`, `won`), `OddsRaised`, `OrderFailed`, `OrderPartSettled` (`from`, `upto`: the prizes of one settle part), `OrderSettled` (`from`, `won`: the last part; a minted collectible is at `["asset", item, serial]`, and a compressed one's id is the tree's count), `PrizeForgone` (`at`, `won`), `OrderRefunded` | the life of an order                                                           |
| `RollMade`                                                                                                                                                                                                                                                                                                                           | the waiting roll of a mission, a recipe or a prize                             |
| `Stashed` (`weight`), `Moved`, `Changed`, `ProfileWritten`, `Held`, `Released`                                                                                                                                                                                                                                                       | `stash`, `move_tokens`, `collectible`, a profile write, holds                  |
| `Listed`, `ListingSold`, `ListingRented`, `Unlisted`                                                                                                                                                                                                                                                                                 | listings                                                                       |
| `NftGone` (`record`: the hold, listing, order, stash or lottery round; `asset`; `by`)                                                                                                                                                                                                                                                | a record let go of an NFT that was proven gone from the project; nothing moved |
| `OfferOpened`, `OfferClosed`, `SoldToOffer`, `Borrowed`, `Repaid`                                                                                                                                                                                                                                                                    | offers and loans                                                               |
| `Entered`, `Decided` (`side: None` when the contest is called off), `Claimed`                                                                                                                                                                                                                                                        | contests                                                                       |
| `AuctionOpened` (`pin`: the serial of an item lot, or the box version of a roll lot), `BidPlaced` (`ends_at` after any extension), `BidRefunded`, `AuctionEnded` (`winner: None` when unsold; `remainder`)                                                                                                                           | auctions                                                                       |
| `ScheduleRan` (`from`, `run`: a range of runs), `TicketsBought` (`entry`), `LotteryDrawn`, `LotteryCancelled` (`short`), `LotteryPulled` (`entry`, `buyer`: the winner of a `Pot` or `Prize` part, with its run in `part`; `amount`: the tokens settled, 0 for an NFT), `RoundClosed`, `Crafted`, `Rolled`                           | mechanics                                                                      |
| `Seated`, `Unseated` (`fee`), `Harvested` (`compounded`), `Reweighed`, `Grown`                                                                                                                                                                                                                                                       | farms                                                                          |
| `PrizeGiven` (`winner`, `prize`, `asset`, `serial`, `amount`, `order`)                                                                                                                                                                                                                                                               | every prize given at once                                                      |
| `TraitsSet`, `TraitsProven`, `GrantClaimed`, `RecordWritten`, `RecordClosed`, `TreeOpened`                                                                                                                                                                                                                                           | traits, grants, `upsert`, `open_tree`                                          |
| `FeeChanged`, `ProjectSuspended`                                                                                                                                                                                                                                                                                                     | the platform                                                                   |

**Errors**: the log reads `AnchorError occurred. Error Code: <name>. Error Number: <n>. Error Message: <name>.` (or
`AnchorError caused by account: <account>. …`). The program's build leaves out the error sentences, so the log names
the error twice and never describes it in words. The IDL keeps each error's sentence (`msg`) by code, and `lootError`
and `ERRORS` return it. Read codes from the IDL, never from a list of your own: the codes shift when the program
deletes an error.

## Limits

The program bounds a project only where the chain itself sets a bound. `xsolana_check` states each bound in words
before anything is signed.

### Boxes

**A box's lists have no cap of their own.** The program writes a box only when one oracle answer can hold one draw of
it. A box that is too long is refused with `PackTooLarge`, or with `TooManyAccounts` past the answer's 21 accounts. This
includes a box of one draw. So a box that is too long is refused when it is written, before anyone pays.

Measured maximums, one kind at a time:

- 128 outcomes that give nothing
- 29 outcomes of token amounts
- 18 outcomes that each give their own item
- 41 slots
- 72 odds rules
- 64 fates
- 16 token prizes or 18 collectibles in one outcome (an outcome holds at most 255 prizes, `BadEntries`)
- 340 texts in a box's gate

A box that mixes these fits less. So does a box that names pools or stashes: for each prize that names one, the program
must find its address, at 1,500 compute units per try. For example, sixteen stashes fit 9 draws per open when finding
them takes 36 tries.

A one-outcome box of 15 to 18 collectibles sells only through the oracle. A box of 19 or more can be written but never
sold.

A box written from a wallet carries about 960 bytes. A longer box needs a program call (a multisig). Put a long
weighted list in a table or a stash, drawn by one outcome.

### Recipes

**A recipe's lines have no cap.** One craft is one transaction, and it fails as a whole. Measured maximums: 60 payments
in one coin, 26 in different coins, 59 outputs from a pool, and 108 raises or needs. Past these, a recipe can be
written but never crafts.

A recipe may give several rolls. Each roll is its own order, at `nonce + k`, where the rolls are counted in the
recipe's order from 0. Past 15 rolls, the receipts exceed what a transaction's log holds (10,000 bytes), and `Crafted`
is cut.

### Rules, raffles and purchases

**A rule's "one of" texts have no cap.** The record that holds the rule bounds them. The rule of a lottery's NFT ticket
holds at most 170 (`BadLottery`), because the oracle's answer reads it.

**A raffle** has at most 256 places from its own stash (`BadLottery`). A pull that hands out several of its NFTs
requests the largest heap (js/play does this).

**A purchase's count**: one `open_box` takes at most 300 draws in total. One `buy` takes at most 25,454 sales
(`PackTooLarge`, before any price is added up).

### Times and zero values

**Times have no cap.** The following may be as far off as a date can hold: a contest's result, an auction's end and
extension, a lottery's draw, a loan or a rental, and a sealed schedule's last run. `xsolana_check` states a far date in
words.

**Values of 0 are the project's choice**: a price, a prize, a loan repaid for less, a contest of NFTs whose winners take
none, and a stash NFT or a table row of weight 0.

### Capped lists

The other lists a record holds keep a cap. Each cap is set where the record's whole flow still fits in a transaction.
`xsolana_check` refuses a spec that is over a cap, and says why in words (`LIMITS`):

- an item's traits: 64, each name 64 bytes
- a farm's boosts, gates and growths: 32 each; a growth's steps: 128
- a contest's sides: 1,024; its deciders: 32
- a project's collections: 32
- a lottery's runs: 64

The limits that remain are not sizes:

- a farm tier's ×100 and a boost's +100,000%
- the platform's fee cap
- counts that a later call must carry or walk: a stored split's 8 shares, an auction bid's 3 NFTs, a lottery run of
  places given one by one (4,096, `MAX_RUN_PLACES`), and the steps of one `run_schedule` (4,000)

### Bounds from the chain

| What bounds it                                                        | Value                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A transaction                                                         | 1,232 bytes legacy; 64 accounts (with a lookup table); an instruction trace of 64 calls; 1.4 million compute units       |
| The heap                                                              | 32 KiB, or 256 KiB when a transaction requests it (`RequestHeapFrame`)                                                   |
| An account                                                            | 10 MiB: a table of about 250,000 labels or 1.3 million numbers, or a stash of about 290,000 NFTs                         |
| A roll's oracle callback                                              | 21 accounts (a box's items, pools, stashes, mints and vaults, and a fresh item's tables) and about 400,000 compute units |
| A compressed NFT (Bubblegum)                                          | a 32-byte name, and a 200-byte URI with its values written in                                                            |
| A table's label                                                       | 32 bytes                                                                                                                 |
| Farm tiers / collectibles per craft                                   | 256 / 255 (a byte names each)                                                                                            |
| Named voucher keys / keys under a key root                            | 3 / 2^16 (2^13 when another signer pays, because a key's proof is instruction data)                                      |
| Tier multiplier / farm boost / box odds                               | up to ×100 / +100,000% / any (a boosted weight stops at 4,294,967,295)                                                   |
| Each flat fee                                                         | 0.01 SOL; a raise waits 7 days                                                                                           |
| Contest result, auction end and extend, lottery draw, rental          | any time a date holds (the checker warns past 3 years)                                                                   |
| Sealed schedule                                                       | any number of runs, the last within what a date holds                                                                    |
| Stale roll or draw                                                    | 600 seconds (`STALE_SECONDS`)                                                                                            |
| Lottery cancel, and the refund of an asked order                      | 7 days after the first ask (`LOTTERY_TIMEOUT_SECONDS`)                                                                   |
| `Chosen` shares in a split / NFTs per ticket / NFTs per contest entry | 1 / 1 / 1                                                                                                                |
| A fate's shift                                                        | `by` and `most`: 32 bits; NFT numbers: 64 bits                                                                           |

### Measurements

Measured on 0.22 (the program's `tests/limits.rs`, `fresh.rs`, `compressed_packs.rs`):

- A card costs the oracle's callback 2,600 to 3,700 compute units at 2 to 16 entries, so one answer draws about 66 to
  106 cards.
- A stash's draw costs about 25,000 at ten NFTs and 33,000 at 290,000.
- A table's draw costs about 49,000 at a million rows.
- One settle transaction mints about 14 Core cards (the trace limit binds first), 10 compressed cards or 8 fresh
  compressed cards.
- A purchase costs about 80,000 compute units and 5 calls.

Measured on 0.24 (`tests/roll_heap.rs`, `tests/fresh_review.rs`): the heap an answer leaves used, including the box's
own bytes (`boxBytes`), and what one `buy` carries (`buyFits`).

## Known limits

These limits are kept by design. Each one is bounded, and no stranger can profit from it.

**Boxes and rolls**

- **A pool's last prize.** A pool may come to hold less than an entry's amount, or an item may be gone, for whatever
  reason. An order still waiting that draws that entry then gets that draw's worth back. The draw never lands on
  another entry instead, so draining a box's common entry can't turn its rare entry into a certainty. If no draw is
  made, a paid order fails and is refunded, and a free order goes back to waiting.
- **A pool opened mid-roll** is out of stock at the answer unless the roll carried its mint and vault. Open a box's
  pools before the box goes on sale.
- **A mission's chest at a fixed address.** A tier that rolls on the NFT and gives a chest puts the chest at a nonce
  derived from the NFT. An unsettled earlier chest (or a stranger's roll at that nonce) blocks later exits with the
  prize. The player can harvest and `forfeit`, which loses that chest.
- **A refund before a late roll.** Past 10 minutes, a buyer who sees the oracle's late answer in flight can refund
  instead.
- **A refund keeps the price rise.**
- **A rolled box's prize in a hooked mint is out of stock**, because the answer carries no hook accounts.
- **Named stash NFTs are found by reading the table**, at about 52 compute units for each NFT ahead (measured on
  0.20). Keep stashes that prizes name under about 1,000 NFTs. Draws by weight cost about the same at any size.
- **Settles at the account limit.** A box whose settle passes 64 accounts can't settle. A payee who turns on required
  memos can tip a settle over the limit. The player then settles by putting won NFTs back. `xsolana_check` warns
  (`W-BOX-ACCOUNTS`).
- **Large settles need a bigger heap.** Several NFT moves, holder shares and a hooked coin can outgrow the default
  32 KiB. A 256 KiB heap frame (`RequestHeapFrame`, `settleHeapFrame`) lets anyone land the settle. `xsolana_check`
  warns (`W-BOX-HEAP`).

**Lotteries**

- A place's token prize may be in a mint whose accounts start frozen (or can be frozen). A winner with no thawed
  account then holds up the round until the issuer thaws the account or the authority empties the pool.
- An NFT ticket or a raffled NFT whose collection refuses to move it holds up the round, including its money.
- If the oracle refuses every request, an open round with tickets can't be drawn or cancelled. Rounds that need no
  oracle still end.

**Farms**

- Dead weight found near or after the end leaves its rewards in the pool, which is the project's. Dead weight is a sold
  watched NFT, or a seat past its `earns_until`. Refresh suspect seats a span before the end.
- Dust in the last span pushes the end of the release past the farm's end, which keeps a little in the pool.
- A fee mint's rounding loses up to one unit per forced move (watched NFTs moved back and forth, or a rate paid from a
  pool). Use enough decimals, or no fee.
- A last forfeit after the end, in a mint that can refuse it, leaves that amount in the vault for good.
- A paid refuel during a suspension (see [the switches](#the-switches)).
- A Freeze farm's compressed mission exit, when the box holds the NFT, needs the NFT's subtree unchanged between the
  proof and the landing. A compressed exit with a compressed prize needs 68 accounts and can't land (harvest, then
  `forfeit`).

**NFTs**

- loot can't write a Core NFT whose Attributes plugin someone else manages. Choose collections the project writes.
- An NFT that a collection's permanent delegate moved out, and that came back by another route, reads as belonging to
  the record that held it.
- Small rents go to whoever sends or closes. An emptied Token Metadata prize account's rent goes to the sender. A
  loser's rent in a contest of NFTs goes to the winner. An NFT auction's growth goes to the seller.

**Not built**: rules that read rentals; a cut of loan interest; offers paid from a pool; one random winner among a
contest's side; lots other than an item, a roll or an NFT; SOL in lamports (use wrapped SOL); list gates on farms;
minting Token Metadata NFTs; conditions on chain balances; sealed-bid or second-price auctions; v1 compressed trees;
forced sales; bonding curves; decaying stakes; exit fees on NFT farms; unbonding waits; harvest tolls; receipt tokens
for stakes; slashing; per-tier gates; boosts from several NFTs; taking anything from a wallet without its signature.

## Transaction sizes

A legacy transaction carries at most 1,232 bytes and 64 accounts.

The sizes below include a compute budget's limit and price. The first three rows were measured on this build, and the
rest on 0.20. In 0.20, the box and recipe shapes were 0.20's largest. 0.22 takes larger ones, and the senders size them
the same way. In 0.20, each instruction's data was also 7 bytes longer than it is now with its 1-byte tag.

| Transaction                                                                                                                                 |      Legacy | v0, one lookup table |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------: | -------------------: |
| `open_box`, the largest box a roll carries (5 item entries, 3 token entries from 3 pools in 3 mints, 21 callback accounts, 4 holder shares) |       1,230 |                  367 |
| `buy`, the largest bundle (3 collectibles, 4 holder shares)                                                                                 |       1,082 |                  343 |
| `settle` of that bundle when rolled                                                                                                         |       1,094 |                  355 |
| `decide` with a split prize (a verdict, 4 holder shares, a pool, a hooked mint)                                                             |       1,483 |                  620 |
| a compressed stake with a 4-node proof                                                                                                      |       1,166 |                    — |
| `craft`: 8 burned for 1 new / 4 burned and 4 used for 2 new and tokens                                                                      | 966 / 1,172 |                    — |

### Lookup tables

Going live always creates the project's standing lookup table of its fixed accounts. The table has a 56-byte header
and 32 bytes per address, which costs about 0.00093 SOL plus 0.00016 SOL per address.

Going live is refused without the table (`E-NO-TABLE`) when a part's widest transaction passes legacy size. Such
transactions are the largest open, a settle, NFT bids, and another collection's pNFTs in a farm. js/play sends them as
v0 from the table, with one prompt.

A transaction that the table doesn't cover goes as v0 with a lookup table that the payer creates first. The payer then
deactivates and closes that table and gets its rent back. A compressed proof longer than 4 nodes needs a table.

### Room for the wallet

A player's wallet may add to a transaction before it signs it. Phantom adds a compute unit limit and price and checks
of its own: 306 and 333 bytes in two transactions measured on mainnet. When these additions do not fit, Phantom shows
its user a warning in place of what the transaction does.

So js/play leaves 400 bytes free in each step that the player's wallet signs, where the standing table allows. A step
that fits a legacy transaction with less to spare goes as v0 from the table when that is smaller. It is still one
prompt, and it gains the room the table saves for the accounts it holds.

Two steps that a page puts into one transaction itself get no more help than that. Past about 830 bytes, with few of
their accounts in the table, send them separately.

## Costs

**Rent** is `(bytes + 128) × 5,080` lamports on devnet and mainnet. Query `getMinimumBalanceForRentExemption` for the
real allocation. Rent is separate from token amounts, loot's fees, the oracle's fee and network fees.

| Account                                                             |                                                                                                                                                          Bytes |                    Rent, lamports | Rent back to                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------: | --------------------------------: | ---------------------------------------------------------------------------------------------------------------------------- |
| Platform                                                            |                                                                                                                                                             73 |                         1,021,080 | never                                                                                                                        |
| Project, no collection / one                                        |                                                                                                                                                      153 / 185 |             1,427,480 / 1,590,040 | never (+162,560 per collection)                                                                                              |
| Order                                                               | sized to its box (`orderBytes`): up to 41 bytes for each prize its draws can set aside, and, for a box that gives items, 4 for each table row a draw may carry |                      by its bytes | the player, at settle or refund                                                                                              |
| Stash, one NFT / four                                               |                                                                                                                                                      103 / 211 |             1,173,480 / 1,722,120 | +182,880 per NFT (36 bytes); to whoever takes NFTs out by hand                                                               |
| Table: header / a row of numbers / a row of labels                  |                                                                                                                                                    51 / 8 / 40 |      909,320 / +40,640 / +203,200 | never (the owner pays as it writes rows)                                                                                     |
| Profile, `xp` and `level`                                           |                                                                                                                                                             98 |                         1,148,080 | never; 69 bytes empty, and an attribute is 8 bytes plus key and value                                                        |
| Seat                                                                |                                                                                                                                                            176 |                         1,544,320 | the player, at the last exit                                                                                                 |
| A farm's record of ends: its first bytes / a new end time           |                                                                                                                                                         7 / 44 |                 685,800 / 223,520 | never. The owner pays for its first bytes; whoever writes each new end time pays for that time's record, spare rent first    |
| Hold (a loan's 243)                                                 |                                                                                                                                                            170 |                         1,513,840 | whoever made it, at release                                                                                                  |
| Sheet, empty / one attribute                                        |                                                                                                                                                        69 / 83 |             1,000,760 / 1,071,880 | never; an attribute is 8 bytes plus key and value                                                                            |
| `Proven`                                                            |                                                                                                                                                            299 |                         2,169,160 | the prover, via `close_leaf`                                                                                                 |
| Traits root                                                         |                                                                                                                                                             97 |                         1,143,000 | never                                                                                                                        |
| Contest entry (in its list): tokens / an NFT                        |                                                                                                                                                  43 / 83 bytes |                 218,440 / 421,640 | never; it goes to the treasury at the contest's close                                                                        |
| Lottery entry (in its round): plain, + a recipient, + an NFT ticket |                                                                                                                                             40, +32, +32 bytes |               203,200 a plain one | never; it goes to the treasury at the round's close. The round's header is paid by its first buyer and returned at the close |
| Listing, sale / rental (no shares)                                  |                                                                                                                                                      183 / 189 |             1,579,880 / 1,610,360 | the maker, at close                                                                                                          |
| A wallet's counts: header / a record                                |                                                                                                                                                         7 / 28 |                685,840 / +142,240 | never                                                                                                                        |
| A grant's shard: header / a wallet's record / a round paid          |                                                                                                                                                    7 / 28 / 16 |      685,840 / +142,240 / +81,280 | the owner, when the shards close after the grant                                                                             |
| Token account / Token-2022 ATA / with transfer fee                  |                                                                                                                                                165 / 170 / 182 | 1,488,440 / 1,513,840 / 1,574,800 | on close                                                                                                                     |

Variable records (items, boxes, lotteries, grants, farms, contests, auctions, offers) are sized to their fields.
`accountBytes` and `xsolana_cost` price a given one. A farm with both vaults costs about 0.0045 SOL and never closes. A
project's vault for a mint never closes either.

**Other costs:**

- **Fees**: the player fee is 0.002 SOL on devnet (the default) and 0.0005 SOL on mainnet; the project fee is
  0.00001 SOL on both ([The fee](#the-fee)).
- **An order** holds its rent and the player fee, nothing more.
  - Whoever settles pays for what the settle opens or mints: a collectible's Core asset, a token account, a Sheet, a
    stash's row, and the fate's writes.
  - The player gets the order's rent back when the order closes, and the fee too on a refund.
  - js/play funds the throwaway key that settles with `settleRent`. It gives `SETTLE_RENT_UNIT` (0.006 SOL, a
    client's own figure) for each prize that may open an account, for each draw of each open. It also gives one unit
    per order for each source of tokens and for the NFT the order rolls on. The key gives back what it doesn't spend.
  - Every open, and every request for a waiting roll, costs the oracle's fee.
- **A `buy`** costs the price, the fee and what its prizes open or make. It has no order and uses no oracle.
- **Prizes** cost what they make, and the sender pays (for a grant, the grant's funds pay). This covers the winner's
  token account if it is missing (1,488,440 lamports), a new Core asset (about 0.004 SOL), and a roll's order (sized to
  its box, returned at settle).
- **Putting an NFT in a stash** costs the project fee and 182,880 lamports. The first NFT also opens the stash. A
  Token Metadata NFT also opens the project's token account for it, which is returned when the NFT leaves.
- **Tables**: the owner pays each row's rent as it writes the row, and never gets it back. This is about 0.2 SOL for
  1,000 labels, 4.1 SOL for 100,000 numbers, and 53 SOL for a full 10 MiB account.
- **Compressed NFTs**: a tree is paid once. It costs about 0.23 SOL for 16,384 NFTs and 0.42 SOL for 1,048,576,
  plus its Bubblegum config. Each Bubblegum move costs its fee (about 6,000 lamports).
- **Growth and locks on NFTs**: about 0.0004 SOL for a new key and 0.0002 SOL for a lock key, the first time.

**Compute units**: a selection, measured on 0.20 with the test environment's token programs. 0.22's draws are in
[Limits](#limits). Devnet and mainnet run p-token, where token moves cost less: `pay` with 4 shares takes 41,065, a
collectible's settle with 4 shares 93,862, `open_box` 58,088, and `refund` 22,004.

| Instruction                                                      |                                    CU |
| ---------------------------------------------------------------- | ------------------------------------: |
| `pay`: all to the treasury / 4 shares                            |                       23,540 / 69,563 |
| `open_box` / 8 entries                                           |                       64,056 / 73,759 |
| `open_box` with a collectible shown for odds                     |                                76,869 |
| `callback_roll` (8 entries)                                      |                                26,861 |
| `settle`: a collectible, a pool, a burn / 4 shares               |                      96,949 / 122,713 |
| `refund`                                                         |                                28,072 |
| `roll` / `callback_random`                                       |                        24,292 / 3,313 |
| `draw_lottery` / `callback_lottery` (3 places, 60 contributions) |                       25,763 / 11,503 |
| `buy_tickets`                                                    |                                43,079 |
| `open_farm`: tokens / NFTs                                       |                       58,817 / 48,293 |
| `stake_tokens` / `stake_nft` frozen / escrowed                   | about 51,500–54,400 / 74,846 / 68,765 |
| `open_contest` / `decide` (2 shares)                             |                       54,098 / 43,869 |
| `open_auction` / `bid` / `end_auction`                           |              50,919 / 45,646 / 67,113 |
| `hold` / `release`                                               |                       32,663 / 28,677 |
| `craft`: 1 burned for 1                                          |                                75,043 |
| `claim_grant`: voucher, an item / open, a stash NFT              |                       76,390 / 64,580 |
| `stash` in or out                                                |                   about 31,500–36,100 |

A pNFT stake takes about 191,000 CU, and a compressed proof and stake about 162,000, past the 200,000 default only
narrowly: set a higher limit. A grant claim whose receipt held 256 rounds used 142,439 (0.20). Third-party transfer
hooks can need more, or refuse.

## Persons and links

A project names an **issuer** (`Project.issuer`, the `issuer` of `update_project`). The issuer is a server key that
says which person a wallet belongs to. A person is a 32-byte hash that the server makes of an account it knows, such as
an X id.

A wallet's **link** is the account `["link", project, wallet]` (`pda.link`, 41 bytes). It holds the person and the time
when the voucher that wrote it expires. A link is written in one of two ways:

- by a claim of a voucher that the issuer signed and that names a person (the claim passes the link);
- by `link_wallet`, after the issuer's Ed25519 check of
  `"loot-link-v1" | sha256(program | project | wallet | person | expires)` (`linkBytes`, `linkWalletIx`). The server
  signs it with `signLink`, and the page sends it with its next step through js/play's `link`.

Only a voucher that expires later moves a link (`StaleLink`).

Any limit (`PerWallet`) can count by person (`by_person`): a box's, a recipe's, a lottery's (where window 0 is its
round) and a grant's. The instruction then takes the wallet's link and the person's counts,
`["persons", project, person]` (`pda.persons`). It refuses a wallet with no link (`NotLinked`). Persons are public.

## Tickets a grant gives

`Prize::Ticket { lottery, count }` is a prize only a grant can give. A claim puts `count` free tickets, for each round
the claim pays, into the lottery's current round, in one entry. The claim opens the round when nobody has bought into
it yet. The prize's accounts are the lottery and its current round. A free entry counts in the sale and the draw, and a
cancel gives nothing back for it.

## Upgrades

The program is upgradeable. Its upgrade authority can replace the program's code, on devnet and on mainnet (on mainnet
a single key today, not yet a multisig: see [SECURITY.md](../SECURITY.md)).

What is known:

- Most program versions so far have not carried accounts over. The [changelog](../CHANGELOG.md) marks each such
  release as breaking: 0.24.0 ("No account of 0.20.1 carries over"), 0.25.0 ("No account of 0.24 carries over"),
  0.26.0 ("No account of an earlier build carries over") and 0.29.0 ("loot 0.29.0 reads no project, grant, lottery or
  order that 0.28 made"). 0.28.0 moved the program to its official address, so nothing set up under the old address
  exists under the new one.
- Two versions kept every layout: 0.26.1 ("no layout changed") and 0.27.0 ("0.26 accounts read as before").
- After a breaking upgrade, an economy is set up again: a new project, new pools and new records.
- The IDL has no migration instruction: none of the program's 60 instructions reads an older version's layout.
- `release.json` names the program build each package version is for. Pin the package version.

What is not documented, and should be treated as unknown until it is:

- Whether tokens, SOL and NFTs held in an older version's accounts (pools, vaults, stashes, stakes, orders, holds,
  listings) can still be withdrawn or closed after an upgrade. The current program cannot read those accounts, and
  only the program can sign for its addresses.
- Whether a future version will carry accounts over, or ship a way to recover what older accounts hold.
- How much notice an upgrade gets.

Before an upgrade you know of, move what you can out of the economy's accounts while the program that wrote them is
still live: end or settle open rounds, let players unstake and claim, and withdraw pools with the authority.
