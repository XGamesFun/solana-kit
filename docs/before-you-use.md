# Before you use it

What to know before you build on loot, and before you ask players to trust what you built. The README has the short
version; this is the whole of it.

- **Devnet only, and not independently audited.** Nothing here is for real money yet.
- **A key file on your computer owns the project, for good.** `xsolana keygen` makes it and `xsolana approve
--keypair` signs going live with it, after showing everything it sends. Whoever can read that file controls the
  project, and every later change is signed by it: these tools can't hand a project to another owner. Keep it where
  it is (outside any repository), never paste it anywhere, and back it up yourself: nothing restores a lost one.
  Unless your spec names a `treasury`, what the economy earns for you lands at that key's address. To sign in a
  browser wallet instead, go live in one: `xsolana approve --browser`.
- **The program can be upgraded, and an upgrade can mean starting again.** Its upgrade authority can replace the
  program's code, which is power over every economy on it (on mainnet that key is to be a multisig). Most versions
  so far have not carried accounts over from the one before: an economy made on 0.25 is made again for 0.26 (0.27
  changed no stored record, so an economy made on 0.26 runs on as it is). Pin the package
  version (each one names the program build it is for in `release.json`) and expect to set an economy up again after an
  upgrade.
- **Players trust the project.** Its owner and authority are trusted keys with no caps: the authority mints, moves the
  project's pool funds, decides contests and writes its NFTs. The program protects players from each other, from the
  platform and from mistakes, not from the project they chose to play. Money held for a record (an order, a bid, a
  farm's stakes, a contest's or lottery's pot) leaves only by that record's rules.
- **Players also trust the token and the collection.** A mint's issuer (a freeze authority, a pause, a transfer hook, a
  permanent delegate, a transfer fee it can still raise) or a collection's controller can stop or move what loot holds:
  a farm, a vest or a box is only as safe as its token. USDC has a freeze authority. The program takes any token in any
  role; in one whose new accounts start frozen, or with confidential transfers, a player can hold up their own part (an
  auction's high bidder can block every higher bid, a lender can block a repayment), and `xsolana check` says so.
- **The program restricts a project only where it must.** A price or a prize of 0, a mission with no lock, a time years
  out, a sealed schedule paying any address, a farm that mints a token the project can't mint yet: the program takes
  them, and `xsolana check` warns of each in plain words. Read every warning before you sign; a time far off is shown
  with its date.
- **The chain can't see a game.** Results a game reports (a win, a score, a clear) are vouched for by a key the project
  trusts, a results server or deciders. Checking that a player really did it is the project's job, on its own server:
  a server that decides the result, replays it, or only bounds what the page reports leaves a cheater very different
  amounts. A grant says which in `trust`, and `xsolana review` says what a cheater gets on every route
  ([trust and cheating](../skills/xsolana-economy/references/trust-and-cheating.md)).
- **The hosted results server is optional.** `https://play.xgames.fun/xsolana` (`@xgamesfun/solana/results`'s
  default) signs vouchers for games without a server of their own. It can only pay what a grant allows, and only for a
  grant whose owner named its key in `vouchers`. It sends nothing on chain, and it is offered as is: it can be down, and
  it is behind for a while after each program upgrade. A game with its own server signs its own vouchers
  (`signVoucher`), which is the better choice once it has one.
- **Nothing runs by itself.** Someone sends every step: settles (the player, the project's keys, or a key the player
  named), lottery draws, auction ends, refunds (anyone), contest results (the authority or its deciders) and schedule
  runs (the project's keys). A run nobody sends on time is missed, except a sealed schedule's fixed amount. Apps built
  with `@xgamesfun/solana/play` send the steps a player needs. Don't count on a hosted keeper.
- **The rules are strict.** A prize is a fixed amount: a jackpot that grows is a lottery's pot. A lottery says where its
  places are paid from: a pot that carries over (gifts and what earlier rounds left count), or each round's own ticket
  money, which nothing from outside can change. A prize never shifts to a later round. A draw uses the odds
  as written. When an outcome runs out, a box stops selling (`stopSales`, the default, a paid miss refunded), keeps
  selling and draws among what's left (`drawLeft`, which lets a player empty a common outcome to make a rare one
  likelier), or keeps selling and gives nothing for a miss (`giveNothing`, never refunded). Both sides of an exchange
  move together: an auction's seller is paid only when the lot reaches the winner, and a loan's repayment brings its NFT
  home.
- **Chance comes from an oracle.** MagicBlock's VRF answers every random roll and draw. If it stops answering, rolls wait. An
  order still unanswered after 7 days can be refunded. Once a roll has waited 10 minutes, a buyer who sees a late
  answer coming can take a refund instead.
- **Fees and rent.** The platform sets two flat fees: by default 0.002 SOL a player action and 0.00001 SOL a project
  action. Each is capped at 0.01 SOL, and a raise waits 7 days. Accounts cost rent: going live, and each settle that
  opens or mints something. `xsolana cost` gives the totals. The platform can suspend purchases, but it never stops
  payouts, refunds or unstakes (the one exception is a recipe that charges).
- **Some things aren't built,** and some limits are kept by design. Read
  [Known limits](program.md#known-limits) before promising players something unusual.
- **The law is yours to check.** The checker's legal flags (chance at money, resellable random items, revenue
  sharing) are reminders, not advice. A spec with no flag isn't therefore legal.

See also [SECURITY.md](../SECURITY.md) (the trust model, and how to report a vulnerability) and
[DISCLAIMER.md](../DISCLAIMER.md).
