# Changelog

The major and minor version of `@xgamesfun/solana` are those of the loot program it is built for (0.29.x is for loot
0.29); `release.json` pins that program's exact build, its IDL and this client. Changes to the program itself are
summarised here only where the tools see them.

## 0.29.11 — 2026-11-23 (loot 0.29.0)

Fixes from a read of the whole kit: places where a tool said Ready, ok or a number it could not stand behind, text
that taught forms `check` refuses, and printed output nobody had read as a reader. Two changes can refuse what 0.29.10
took; they are marked.

**Check, design and status**

- **Changed: `xsolana check` no longer says Ready for a spec that `cost`, `explain` or going live cannot build.** Every
  duration, window and time a part writes is held to what the program keeps (an auction's `extendBy` and `runs`, a
  lottery's rhythm, close of sales and window per wallet, a contest's deadlines, every `perPersonEach`, `opens`,
  `closes`, `until` and `start`). Anything else that still cannot be built is refused as `E-BUILD`. A changed live spec
  whose steps could not be built was published without the parts that read what changed; it is now refused.
- `xsolana_design` gives the spec's own refusals, each with its code, place and fix, when no design checks because of
  them. Its sentence for the person says where ticket money goes (winners, a pot, a pool, a split, a burn), as
  `explain` says it, where it always said "your treasury". It takes a route as `lottery:weekly` or `weekly`.
- `xsolana_status` checks the spec first, and says when the project a file names is not on chain. It answered
  `ok: true` and "publish again", which could not add it.
- `xsolana cost` counts each pool a box pays from and each token it mints in what an open lends its settle key, as the
  client funds it (a box paying from two pools was quoted 0.006 SOL short).
- A refused value that may be a secret is never read back, and a long value only by its first characters.

**Printed output**

- Numbers print grouped and rounded to six significant digits (percents to four), and a price as it was written.
- A box or item whose price rises or falls is quoted at its listed price, with how it moves, so the "in all" figure is
  the same at any number of sales a day. A return counted against the scenario's average price says so.
- Every command answers `--help` and `-h`, and `xsolana help <command>`; `xsolana tool <name> --help` lists a tool's
  arguments; `xsolana client` is a command; a word a command does not take is refused.
- In a terminal, the tools name the commands you type (`xsolana guide boxes`), not the MCP calls.
- `xsolana examples <name>` prints the example's spec, and `--save <file>` starts a new file from it, so the README's
  terminal quick start works from an empty folder.
- Clearer failures: the folder itself, a folder, an unreadable file and a UTF-16 file are each named; a byte-order mark
  is accepted; a finding repeated for many parts is listed ten times and the rest counted (60,000 items answered in
  12 MB). `review` shows the server trust table only when a reward is paid on a server's voucher.
- `XSOLANA_CLUSTER` that disagrees with the economy is refused by every command alike, `xsolana tool` included.

**Going live**

- `xsolana approve` writes a spec kept under `economy` back there, with every key beside it as it was; it wrote the
  bare spec and lost them. A wrapped spec that says mainnet is worked on mainnet.
- The approval page's local server answers a malformed request with 400 instead of stopping.

**The guide, the skill and the examples**

- The guide and the skill teach only forms `check` takes, and a test runs each one through it. A lottery place's or a
  contest's roll is the prize `{ "gives": "roll", "box": key }`; nothing offers a share of a pool as a prize; a box's
  outcome takes `"compressed": true`. A split takes at most 8 shares in a box, shop item, lottery, contest or auction,
  and has no cap of its own in a payment. Mainnet is listed with what loot does, not with what it cannot.
- `xsolana guide <part>` shows every shape the part's fields name (`life`, `oddsEffect`, `nftPrice` and others were
  named and shown nowhere).
- Every bundled example passes `check` and `review` and simulates to numbers a person can read, held by a test:
  `partner-vault`'s daily chest is for pass holders (it was an open grant), `community-coin` says who holds the coin,
  and `blind-forge` and `falling-drop` simulate at sales their rising prices can meet (they printed values of 10^13).
  Each does what its description says, and they write `"source": "project"`, as the skill teaches.
- `xsolana examples` names the loot version its rated ideas were rated against (0.20.1); two that cited a field loot
  no longer has, and four that read "Same as 70.", are corrected.
- The deadlines for a roll the oracle never answers are the client's everywhere: a purchase can be refunded after 10
  minutes, a roll holding a payment or an NFT after 7 days. The tutorial said 7 days for a purchase.
- `docs/program.md` opens with what the program does and lists all 60 instructions (`link_wallet` was missing).
- `xsolana_token` says it reads the economy's own cluster.

**The library**

- **Changed: `units(amount, decimals)` refuses decimals that are left out or are not a whole number from 0 to 255.**
  `units('1.5')` returned `15n`; decimals given as text (`'6'`) are refused too.
- A refusal of an RPC on the wrong cluster names its host alone, never the path or query where a paid RPC's key is.
- `@xgamesfun/solana/results`: `draws.open`, `draws.get` and `giveaways.open` take `cluster` and send it, as the calls
  beside them do.
- The TypeScript declarations take the package's own examples under `strict` (`solanaApp({ rpcUrl })`, `payIx` and
  `openBoxIx` with only what they need, `compileMessage({ version: 0, lookupTables })`). Options elsewhere that
  default to `null` or `[]` are still typed as only that.
- `plan()` leaves the context it is given as it was.

**For contributors**

- `npm test` removes the temp folders it makes, stops with one message when the tests of the real program can't run
  (`XSOLANA_SKIP_CHAIN_TESTS=1` runs the rest on purpose), and takes a file (`npm test -- js/test/cli.test.mjs`).
- Lint refuses `import 'fs'`, `import('node:fs')`, `globalThis.process` and `__dirname` in the browser-safe folders.

## 0.29.10 — 2026-11-23 (loot 0.29.0)

No behaviour changed: the page client (`js/play`) and the instruction builders are split into one module a part.

- Every entry point exports the same names, and `solanaApp()` returns the same 59 methods with the same types.
- A game's copy of the page client (`gf/loot/`) has more, smaller files (65, was 29, about the same size); a first
  load finds them in one more round of requests.

## 0.29.9 — 2026-11-23 (loot 0.29.0)

No behaviour changed: `check()` is split into one module a part. It gives the same refusals and warnings in the same
order, and every export of `js/economy/check.mjs` is still there.

## 0.29.8 — 2026-11-22 (loot 0.29.0)

No behaviour changed: code and docs tidied, and shared helpers have one copy each.

- The entry points gain three exports: `SYSVAR_CLOCK` (`chain/pda`), `sleep` (`chain/rpc`) and `SIGNATURE_LAMPORTS`
  (`chain/tx`, the same value `sponsor` exports).

## 0.29.7 — 2026-11-22 (loot 0.29.0)

Changes to a live economy are published whole, and numbers are simulated as the program pays them.

**Breaking**

- `check` refuses a change to what the program never changes once live (a farm, an auction, a pool's token, a table,
  a sealed schedule, a lottery's currency). It was left out of the approval while the file said otherwise.
- `check` refuses a lottery that limits each buyer both by round and by a window: the program keeps only one.

**Fixed**

- A part added to a live economy could take the id of one removed from it, and the program kept the old record's
  counts under the new part's name. A live economy's ids are never given again.
- A player couldn't take a booster off a token farm through `js/play`, and the stake then couldn't leave.
- A table added while live was never written, and an item taken out of the shop went on selling. Times said from
  going live ("publish+7d", a falling price with no start) were counted again from each later change; they are now
  written into the file as the dates the approval sent (a file from before is warned of).
- Numbers: a slot that keeps each outcome once is drawn without putting back, as the program draws it (a pack's
  return could be shown at 60% and pay over 1000%); a farm's rate is quoted per 1,000,000 base units staked, as the
  program keeps it, with a warning for a staked token of more than 6 decimals; a pot that draws again pays its seed at
  its first draw.
- A contest's NFT picked for its winner by the project's keys after the grace period goes to the winner. The approval
  says "Change" for a live lottery and "Take … out of the shop" for a listing switched off.

## 0.29.6 — 2026-11-22 (loot 0.29.0)

A coin made elsewhere is read as the chain has it.

- The approval no longer refuses a coin made elsewhere whose `decimals` or `program` the spec gets wrong. It uses the
  chain's (the spec's amounts are whole tokens), says what it changed, and writes the chain's values into the file
  once the step lands. Wrapped SOL is read with its 9 decimals. A token the setup made that the chain disagrees with
  is still refused.

## 0.29.5 — 2026-11-22 (loot 0.29.0)

An NFT is moved with the collection the chain says.

- The approval no longer refuses a Core NFT a stash or a lottery takes when the spec names another collection for it:
  it moves the NFT with the chain's collection and writes that into the file once the step lands. An NFT that is not
  there is still refused.

## 0.29.4 — 2026-11-22 (loot 0.29.0)

The tools held to what loot 0.29.0 does. Every shipped example plans the same go-live transactions as before.

**Breaking**

- `check` refuses what the program refuses: a compressed item's link at a ten-digit serial; more than 8 token
  accounts in a lottery's rounds; a round too wide for one instruction; a lottery's share into its own pot; a boost per
  point with no `upTo`; one NFT handed over twice; a recipe that keeps attributes onto a compressed output; two traits
  drawn from one table; a farm rate past 8 bytes; `free` with a price.

**Fixed**

- A shop item limited per person went live with no limit: `perPerson` and `perPersonEach` were dropped from its
  listing.
- A change to a live economy left the parts that read the changed one as they were (a lottery's `pot`, an item's
  `life`). A change now publishes every part whose instructions it changes.
- A live grant whose `wallets` or `rounds` changed could not be edited again (`ShardsFixed`).
- Free lottery tickets a grant gave were read as paid: their holder was offered a refund that always failed, and the
  round could not close.
- A bid on an auction gated on the player's profile always failed.
- Numbers: a box with several draws an open was valued as one; a run of lottery places was counted once; a schedule
  paying into a farm never reached it; halving was left out of a farm's or a schedule's daily pay; a rising price grew
  without the program's rounding; `explain` read places written as plain numbers (`[60, 40]`) as 0%.
- Words: per-person limits read as no limit in several warnings; a duration in seconds is said as "1d", not "86400".

**Added**

- `check` takes a contest's share to `"chosen"` (a bounty's worker, named by its verdict).
- Warnings: a live item whose kind, soulbound, burnable, collection or drawn traits change (fixed once issued); `fund`
  on a schedule that is not sealed; `on` on an output that is not a roll; `held` outside a lottery's place.
- The approval reads a live item's issued count before a change to what it is, and each Core NFT a stash or a lottery
  takes (0.29.5 moves one in another collection than the spec names).

## 0.29.3 — 2026-11-21 (loot 0.29.0)

Mainnet's player fee is quoted as mainnet charges it.

- Fixed: the tools quoted devnet's player fee (0.002 SOL) for every economy. Mainnet charges 0.0005 SOL, so `cost`,
  `simulate`, `check` and `explain` quoted each mainnet player action 0.0015 SOL high. Each now quotes the fees of the
  economy's own network (`FEES_ON`, `feesOf`); the guide gives both. Only the quotes were wrong: the program always
  charged what its platform account holds.
- The hosted server's tool descriptions say only what each tool does and returns; the advice they carried is in the
  hosted server's instructions. The local server's descriptions are unchanged.

## 0.29.2 — 2026-11-21 (loot 0.29.0)

The skill's description parses again, and a plugin edition for Anthropic's directory.

- Fixed: 0.29.1's skill `description` had a `: ` in it, which strict YAML reads as a mapping, so the `skills`
  installer and other strict readers skipped the skill. `npm run check` now refuses such a description unless quoted.
- `claude-directory/`: the plugin as Anthropic's directory lists it, with the same skill and a connection to the
  hosted server (`https://xgames.fun/mcp`) in place of the local one. `plugin/` is unchanged.
- The plugin's listing has an icon, links, the hosts it reaches (`network.hosts`) and a one-line install.

## 0.29.1 — 2026-11-21 (loot 0.29.0)

Listings and wording: a toolkit for building game economies, and every tool has a title.

- Every listing (the MCP Registry, npm, the plugin manifests, the marketplace, the skill) leads with one line saying
  what this is. The registry no longer says the server will "launch" an economy: no tool signs or sends.
- Every tool has a title a person can read; no tool is renamed.
- `simulate` and `explain` say "the game keeps 38% of each price" where they said "the house keeps", and the guide uses
  the game's words. Every warning about the law is as it was, and phrases people type ("coin flip", "bet on a side")
  still find their part.
- `plugin/README.md` says what the plugin installs, runs, fetches, sends and writes.

## 0.29.0 — 2026-11-20 (loot 0.29.0)

Built for loot 0.29.0, on devnet since slot 524,113,825 and on mainnet since slot 471,855,650: limits per person,
tickets a grant gives, and a cap on a grant's tokens. Includes 0.28.32, which was not published.

**Breaking**

- loot 0.29.0 reads no project, grant, lottery or order that 0.28 made: an economy live before goes live again. A
  project is 185 bytes (`issuer`), an order 33 bytes larger (the person it counted for).
- `check` refuses a limit per person without `keys.issuer`, and a part that names both a per-person and a per-wallet
  limit (`E-PERSON`).
- `check` refuses three specs that passed and then stopped part way through going live: a recipe that rolls a box no
  longer in the spec; an item's cooldown past what a raise holds (a signed 4-byte number); a fixed supply smaller than
  everything going live puts in (pools' seeds, a lottery's seed, a farm's and a sealed schedule's funds).
- The schema refuses `"constructor"` and `"__proto__"` as fields, like any other unknown field.
- `xsolana version` and the MCP server's `serverInfo` give the package's version, not the program's (0.28.0 for every
  release before).
- `xsolana_save` saves a spec whose check has open questions under a state of its own (`saved-questions-open`), and
  says to put them to the person first.

**Added**

- Persons: `keys.issuer` names the server key that says which person a wallet belongs to (the grants' voucher key may
  be it); the setup sets it on the project. Items, boxes, recipes, lotteries and grants take `perPerson` (in all) and
  `perPersonEach` (`{ count, every }`) in place of a wallet limit: every wallet linked to one person counts together,
  and a wallet linked to nobody is refused. A daily login bonus is an open grant with
  `"perPersonEach": { "count": 1, "every": "1d" }`.
- Links: a server signs who a wallet is with `signLink` (`@xgamesfun/solana/results`; ten minutes by default, a day at
  most), and the page passes it to `js/play`'s `link`. The client builds `link_wallet` (`linkWalletIx`, `linkBytes`)
  and reads `pda.persons` and `pda.link`; every builder that counts takes `person`.
- Tickets a grant gives: `{ "gives": "ticket", "lottery": key, "count": n }`. A lottery limits each wallet's or
  person's tickets per round with `perWallet`, or per window of time with `perWalletEach`.
- `limits.tokens`: a cap on what a grant of tokens gives.
- `W-SIMULATION` says when the check's simulation stopped and what was therefore not looked at; before, an error in it
  read as "nothing to report".
- A draw that settles the round before it asks for the largest heap (`RequestHeapFrame`, 256 KiB).

**Fixed**

- `xsolana_design` answered a bare `TypeError` for a requirement missing what its kind needs; it now names it.
- Seed phrases are found by their BIP-39 words however they are written, and a 64-byte key in hex is found too.
- `W-HOLD-UP` and `W-SHARED-SOURCE` say in plain words what the bidder or buyer can do.
- `SECURITY.md` and `docs/program.md` no longer say nothing runs on mainnet, and say the mainnet upgrade authority is a
  single key today. A live economy on mainnet is no longer told its owner needs "devnet SOL".

## 0.28.31 — 2026-11-14 (loot 0.28.0)

A player's step leaves room for what their wallet adds, so Phantom can check it.

- Phantom adds a compute budget and its own checks (Lighthouse instructions) before it signs; with no room for them it
  shows "This dApp could be malicious". `js/play` now sends a step with less than 400 bytes to spare
  (`WALLET_ADDS_BYTES`) as a v0 transaction with the project's standing lookup table, when that is smaller. A wallet
  that signs no v0 transaction (`supportedTransactionVersions`, carried on the signer as `versions`) gets a legacy
  one. The tables are read again just before such a step is sent.
- `compileFitting` and `sendFitting` take `room` (and `sendFitting` `fresh`); with none they do what they did.
- Not known yet: whether Phantom adds its checks to a v0 transaction that loads from a table. A page that joins two
  steps into one transaction should send them apart past about 830 bytes when the table holds few of their accounts.

## 0.28.30 — 2026-11-13 (loot 0.28.0)

The approval no longer builds on a file's word where the chain can't back it.

**Breaking**

- A collection the file names from before its project was made is used only by the session that made it; another run
  makes a new one.
- Before the project is made, a mint the file names must be as a setup leaves it: none of it minted (or, for a fixed
  supply, all of it in the owner's own account), with its name record plain and the owner's to change.
- A Token-2022 mint is refused wherever the file calls it one the setup made.

**Fixed**

- A setup cut short right after a stash step with several NFTs left a step name longer than the file took (80
  characters); the live section's step names now take 400.

Not closed: on a live project, a file that names another classic mint for a token (its minter the project, a supply
already out elsewhere) is still taken for the token's own when a later change adds a part that uses it.

## 0.28.29 — 2026-11-13 (loot 0.28.0)

A token's new mint at an address the owner chose.

- `xsolana approve --keypair … --mint-key <token key>=<key file>` makes the mint of a token the setup makes at that
  key's address, for a new setup or a token added to a live project; give it once for each such token. The file is
  read as the owner's key file is, never printed or copied, and signs only the transaction that makes the mint. The
  printed code covers the address.
- Refused before anything is built: a token the spec does not have or whose mint the setup does not make; a mint live
  at another address; an address the chain already has an account at; one key for two tokens; the approval's own key,
  a key of the project, or an address the file names for anything else.

## 0.28.28 — 2026-11-13 (loot 0.28.0)

A project handed to a new owner is the new owner's to change, and the project's keys are read from the chain.

- Fixed: every change to a project handed on was refused ("which is not project number 0 of its owner"). The
  project's address is now taken from the creator the Project account stores.
- The treasury and authority are read from the chain, not the file. The approval says where the file differed, and the
  file takes the chain's once a step lands. A file that names another treasury or authority is no longer refused.
- A spec whose `keys.authority` is not the chain's is refused in words before anything is built, with how to set it.
- A live section's treasury and authority count only beside the project's address: a planted
  `"live": { "treasury": … }` no longer reaches a new project.
- The project's collection must be one the Project account lists, not any collection whose update authority is the
  owner.

## 0.28.27 — 2026-11-13 (loot 0.28.0)

Saving a draft counts as building, and a server must stop where the chain stops paying.

- Wherever a choice or question is left to the person, the tools say a spec saved before they answer is already built
  on. `xsolana_design`'s `askFirst` carries it as `before`.
- For every server-signed reward with a cap or a prize that can run out, the check's lines say the chain refuses those
  claims and nothing more, so the server must stop counting and signing there and the page must tell players.

## 0.28.26 — 2026-11-13 (loot 0.28.0)

A server's own rules can be declared, and `xsolana_design`'s questions are in its JSON.

- `"offchain"` holds a rule on what a grant pays for something on no chain:
  `{ "key": "boost-code", "takes": "a code", "gives": "grant:<key>", "rate": 2 }`. `takes` may be plain words. The
  check says what it means for the grant's amounts and caps.
- `xsolana_design`'s JSON carries each design's `needs` and `removes`, and `askFirst`.
- A burn counts as wanted only if the person asked for it in their own words; one the builder added is a question.
- A read that gates a payout fails closed: the server signs nothing until it knows the win was not paid.

## 0.28.25 — 2026-11-13 (loot 0.28.0)

Every server-signed reward gets its questions, and unclaimed earnings are asked case by case.

- `xsolana_design` ends with an "Also in this spec" list: the questions for each server-signed reward the request was
  not about.
- The question about unclaimed earnings is three: past the day's cap, past the cap in all or once the prize runs out,
  and a voucher that runs out.

## 0.28.24 — 2026-11-13 (loot 0.28.0)

One question a cap, and the design that keeps a way out listed first.

- `xsolana_design`'s "Needs from you" for a server-signed reward is four questions: the most claims one player makes a
  day, everyone together a day, in all, and what happens to what a player earned and can't claim.
- Where a design removes a way out (a burned payment can't be given back), the best design that keeps it is listed
  just before it, and the other says "Removes a way out". When both keep every want, the tool says the choice is the
  person's.
- "Who runs the results server" offers its two answers; the question about what a server does with holdings is a yes
  or no.

## 0.28.23 — 2026-11-13 (loot 0.28.0)

The person's numbers are asked with the design, and questions come heaviest first.

- For a server-signed reward, `xsolana_design` lists its caps (each with the builder's pick) and what happens to
  unclaimed earnings under "Needs from you".
- "Ask the person" is ordered by the weight of each question's finding. A choice the builder made is still told to the
  person in one sentence, so they can overrule it.

## 0.28.22 — 2026-11-13 (loot 0.28.0)

Every way a grant's claim ends, and caps asked in the person's numbers.

- A grant has its endings, as a lottery and a contest have: past a window's limit (refused, and paid once the window
  turns), past a limit in all (refused for good), a prize that can't be given, a voucher that runs out, what was
  earned and never claimed, and its end date. `xsolana_check` lists them, and `xsolana_explain` in the grant's table.
- One question for every server-signed grant: is what a player earned and did not claim kept for them, or lost?
- Every cap of a signed grant is asked once, in claims and in what they give.
- The question for a payment burned on entry says the burn can wait for the outcome (held, burned at the draw, given
  back by a cancel).
- Fixed: "mints 1000 undefined a day into undefined" for a schedule that mints into a farm's rewards.

## 0.28.21 — 2026-11-13 (loot 0.28.0)

A win signed twice, and a craft the purchase carries.

- The chain keeps a paid round with its wallet, so the same win signed for a second wallet pays again. The tools say
  so, and `winPaid({ rpc, game, grant, wallet, round })` in `@xgamesfun/solana/results` reads whether a wallet was
  paid a win, for a server to ask before it signs that win again.
- A draw entered with a crafted token is one approval with `buyTickets`' `make`, so `W-STEPS` no longer reports 3
  prompts for a page that does that.
- "Ask the person" lines are put as questions, with the builder's pick as the recommendation.
- Fixed: a grant paid from a pool printed its unit as "[object Object]".

## 0.28.20 — 2026-11-12 (loot 0.28.0)

A grant's caps are counted in claims, against what its server counts.

- `serverLimit.claims`: the most claims the server signs in its window. With none, and a chain cap that counts
  claims, the check asks how many times a day a regular player claims.
- New findings: a server that signs more claims than the chain's window takes (medium); a lifetime cap on a grant with
  no end (low past the scenario's days, medium within them); a shared day's cap the audience uses up (medium).

## 0.28.19 — 2026-11-12 (loot 0.28.0)

Who sends what each ending owes, and every grant cap against an honest player's pace.

- For a lottery or a contest, the check says for each refund, payout and draw a round still owes who may send it, what
  it costs them and what happens if nobody does. A refund returns the price, not the player fee.
- A grant with a known pace (`serverLimit` or `perWalletEach`) has each cap checked against it: a lifetime cap an
  honest player reaches within the scenario's days, a `perDay` used up within a day or a `total` used up within its
  days is a finding with a question.

## 0.28.18 — 2026-11-12 (loot 0.28.0)

A short first call and a short skill: `xsolana_guide {}` is an index of 3,759 characters (was 80,555), and `SKILL.md`
is about half its size.

**Breaking**

- `xsolana_guide` with no `part` gives the loop and an index of parts and topics; fetch each part or topic
  (`writing`, `cheating`, `asks`, `cannot`) by name. `guideText()` still gives the whole guide.
- An MCP result's `structuredContent` is the data alone, not the text again; `xsolana_review`'s drops `tradeoffs`,
  which its text holds.

**Changed**

- A refund in another asset than what was paid, where that payment is burned, is at least a medium finding with a
  question.
- `E-SCHEMA` gives the shape the schema takes where it failed, and the guide part to fetch; an argument a tool doesn't
  take lists the ones it does.
- `xsolana_check` puts the law's lines under "The law", said once when first raised and again before mainnet.
- The MCP instructions name every tool. The skill's per-case lines moved into the tool outputs that fire them.

## 0.28.17 — 2026-11-12 (loot 0.28.0)

Every line of `xsolana_check`'s "Ask the person" list ends as a question, with its context first.

## 0.28.16 — 2026-11-12 (loot 0.28.0)

More of what the check asks and tells.

- Every way a ranked payout ends: fewer tickets than places (an unwon place's share goes where the round's leftover
  goes); a contest's tie, a result nobody can call, and nobody on the side named (`NoWinner`: the contest is called
  off).
- A grant's funds against its audience: when the SOL for each claim's rent runs out, or a question how many will claim.
- Questions on who holds the most supply besides the owner, and on how a server sets each amount (anything it
  converts goes in `"offchain"`).
- "Tell the person" adds up a returning player's approvals for a day and says what folds them (`claimAll`, `make`).

## 0.28.15 — 2026-11-12 (loot 0.28.0)

A grant may declare what its voucher server signs at most.

- `"serverLimit": { "per": "person" | "wallet" | "all", "amount", "every", "total" }`, `amount` in the prize's units.
  The program never sees it; the chain keeps only `"limits"`, which is what a leaked voucher key could take. The tools
  count net flow, daily pay and a free thing's worth at the server's rate, and the grant's line says what the server
  really pays before what a leaked key allows.
- New questions: a voucher grant that takes the page's word or a replayed result and declares no server limit; an
  `"offchain"` conversion with no `"rate"` (counted one for one).

## 0.28.14 — 2026-11-12 (loot 0.28.0)

Fewer warnings, where an analysis already covers them.

**Breaking**

- Removed: the lottery warning "needs N tickets sold, at most M a wallet" (`W-ASSUMPTION` covers it), `W-FARM-MINT`
  (`W-VALUE` computes it), and the review's `R-FARM-ENDLESS` (now in `R-VALUE`) and `R-CONTEST-RESULT` (now in
  `R-ENFORCED`).

**Changed**

- `W-VALUE` prices every path to the same item or token at the spec's own rates and flags one far cheaper.
- "Tell the person" adds every way each draw and contest ends, that a missed schedule run lapses, that a box's odds
  move as stock runs out and on every edit, and that several at once is one approval (`count`, `claimAll`).
- The walk-through adds "Who controls what": what the chain keeps as written, what is decided off chain, and what the
  owner's key can still change (every cap can be raised by an edit; a farm and a contest can't be edited once open).
- Fixed: settling a box's roll no longer counts as a wallet prompt; the page's own settle key does it.

## 0.28.13 — 2026-11-12 (loot 0.28.0)

`xsolana_design` covers sales, rewards, staking and contests as well as draws.

- A requirement names its route (the key of a lottery, item, grant, farm or contest). New requirements: for a sale
  `pay-in`, `fixed-price`, `instant`, `fair-scarce`, `one-approval`; for a grant `per-person`, `no-server`,
  `bot-proof`, `bounded`, `first-reward-no-sol`; for a farm `emission-cap`, `predictable`, `no-lock`, `whale-fair`;
  for a contest `no-owner-trust`, `equal-stakes`, `refund-if-no-result`. Several routes are designed in one call.
- A route no family covers (an auction, a schedule, a hold) is said, to draft by hand.

## 0.28.12 — 2026-11-12 (loot 0.28.0)

A new MCP tool, `xsolana_design`: from what a person wants to the specs that do it, for a draw and how it is paid.

- Wants are written as requirements (`pay-in`, `burn`, `refund-as-paid`, `free-entry`, `one-approval`, `one-draw`,
  `one-token`, `first-reward-no-sol`). Every combination of the known ways to build them is checked, and ranked by the
  requirements it keeps, then how it plays, how clean it is and its findings.
- The answer lists the designs best first, with each requirement kept, kept in part or given up, the steps someone
  must send after the draw, and a sentence for the person. When nothing keeps every want, the choice is the person's.
- A value finding a deciding voucher server already bounds is one level lower; an on-chain cap is suggested only where
  it costs real players nothing; "Tell the person" opens with what a first-time player needs.

## 0.28.11 — 2026-11-12 (loot 0.28.0)

The checker, `explain` and the review read one model of the spec, and four analyses challenge it.

- `W-VALUE` (follow the value), `W-STEPS` (one intent, one step), `W-ASSUMPTION` (every number that rests on who takes
  part, checked against the scenario or asked) and `W-ENFORCED` (where each rule is kept, replacing `W-CONTEST`'s note
  on who names the winner). The walk-through gives every route who sends what and every way it ends.
- `xsolana_check` ends with three lists: "Ask the person", "Tell the person, as written" and "When it goes wrong".
- A spec may declare what a server or page does off chain (`"offchain"`), and an outside token's holders in
  `"scenario.holders"`.

## 0.28.10 — 2026-11-11 (loot 0.28.0)

Four errors fixed.

- The worked example in `sentence-to-spec.md` now checks (it named no pot, and its Perch was switched off).
- An NFT spent on a lottery ticket is handed back if the round is cancelled; two pages said it was never refunded.
- `W-VALUE`'s cancelled round covers every lottery, including one the oracle hasn't answered 7 days after its ask.
- `explain` puts every legal flag under the law, `W-CHANCE-ITEMS` included.

## 0.28.9 — 2026-11-11 (loot 0.28.0)

Three analyses replace 0.28.8's six warnings.

**Breaking**

- The six codes of 0.28.8 are gone. Their cases are findings of `W-VALUE` (medium in the review), `W-STEPS` (low) and
  `W-ASSUMPTION` (medium), with the case in the message. `W-POOL-RUNS-DRY` is now one of `W-ASSUMPTION`'s findings.

## 0.28.8 — 2026-11-11 (loot 0.28.0)

The tools challenge a request before building it.

- Six warnings, each also a review finding: `W-REFUND-NOT-PAID`, `W-SWAP-BACK-OPEN`, `W-FREE-IS-PAID`,
  `W-MINSOLD-VS-SCENARIO` (medium), `W-TWO-PROMPTS` and `W-AFTER-THE-END` (low).
- `xsolana explain` and the review's trade-offs end with a walk-through of each route, state by state, as a player, the
  owner and a cheater see it, and what can change only before a first sale or claim.
- The skill's rule 9 is "Challenge before you build": name the simplest version, what it gives up and what the
  asked-for one costs, and recommend one.

## 0.28.7 — 2026-11-11 (loot 0.28.0)

Tickets and the entry they cost, in one approval.

- `buyTickets(key, count, { listing, make: { recipe, times, listing } })` crafts the recipe in the purchase's own
  transaction; if either fails, neither happens. `craft(..., { build: true })` returns its instructions unsent; a
  recipe that rolls is refused there.

## 0.28.6 — 2026-11-11 (loot 0.28.0)

Going live on mainnet is said, and typed, as mainnet.

- `xsolana approve --keypair` on mainnet opens its printout saying everything below moves real SOL and real tokens,
  cannot be undone, and that loot is not independently audited. Its code starts with `mainnet-`
  (`--yes mainnet-1a2b3c4d`). Devnet is as before.

## 0.28.5 — 2026-11-11 (loot 0.28.0)

`walletAdded` is exported.

- `@xgamesfun/solana/wallet-adds` exports `walletAdded(ours, theirs, wallet)`, the approval page's rule for taking a
  transaction a wallet signed with only its own checks added, so a server can take exactly what the page takes.

## 0.28.4 — 2026-11-11 (loot 0.28.0)

`claims()` works behind xgames.fun's relay.

- Fixed: `claims()` threw for every player behind the relay, so a player's page listed no refund. It now scans proof
  records by their payer, which the relay passes; if that scan is refused anyway, it lists the rest.

## 0.28.3 — 2026-11-11 (loot 0.28.0)

A request to a results server names its cluster.

- A mainnet request adds `cluster=mainnet` (from `report`, `fetchVouchers`, the draws and giveaways calls and
  `claimWins`); on devnet nothing is added. A page on mainnet reading through a relay names it the same way
  (`rpcUrl: '/loot/v1/rpc?cluster=mainnet'`).

## 0.28.2 — 2026-11-11 (loot 0.28.0)

loot on mainnet, and a cluster for each economy. Mainnet's program is `xgames8C758PyweWB9sDw8evvwsTVwyA2fGRUeAXVPy`;
devnet's stays `xgamesVsZBpCVgJuatfYAFJRmQoccfQf5qtUFNp2Eet`. The program is not independently audited, and mainnet is
real money. Nothing changes for an economy on devnet.

- An economy names its cluster: `"network": "devnet"` or `"mainnet"`, devnet when it names none. The CLI, the MCP
  server and `solanaApp` take the cluster from the economy. One of another cluster than the work at hand is refused
  (`E-NETWORK`), and so is a `live` section that names another cluster's program.
- A process is on one cluster, devnet unless it names mainnet (`XSOLANA_CLUSTER`, or `useCluster`). A server that
  answers for both runs each piece of work with `withCluster(cluster, fn)` (`@xgamesfun/solana/with-cluster`).
  `LOOT_PROGRAM` is the process's own cluster's program.
- The RPC must be on that cluster: a URL or a chain of another is refused (`rightCluster`, `checkCluster`). Mainnet
  has no default RPC: name one (`XSOLANA_RPC_URL` or `rpcUrl`). A wallet is asked to sign for `solana:devnet` or
  `solana:mainnet`.
- A voucher and a verdict are signed over the program's address, so one signed for devnet never counts on mainnet.
- Fixed: `decodeEvents` read receipts only at the IDL's (devnet's) address.

## 0.28.1 — 2026-11-11 (loot 0.28.0)

A wallet that adds its own checks can approve on the page.

- `xsolana approve --browser` now sends what the wallet signed when the wallet only added Lighthouse instructions
  (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`) or a Compute Budget heap or loaded-data limit, and the wallet is the
  only signer and fee payer, every prepared instruction is there unchanged and in order, no account's privileges
  changed, and both messages are legacy. An added unit limit or unit price is never taken. Anything else is refused,
  saying what the wallet did. The page says what was added once the transaction lands.
- `LIGHTHOUSE_PROGRAM` is exported from `@xgamesfun/solana/chain/pda`.
- An instruction of the Lighthouse program is taken as the wallet's own, whatever it does. Not tried with a real
  Phantom or the real Lighthouse program.
- Going live with a key file is as it was.

## 0.28.0 — 2026-11-11 (loot 0.28.0)

loot at its official address, `xgamesVsZBpCVgJuatfYAFJRmQoccfQf5qtUFNp2Eet`, on devnet since slot 521,074,836. It is
0.27.0 built for that address: no instruction, account or record changed.

**Breaking**

- Every address derives from the program's, so nothing set up under the old address
  (`9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`) exists under this one. Set the economy up again (`xsolana keygen`,
  then `xsolana approve`) from the spec without its old live record.
- An app that wrote the old address out as text must take `LOOT_PROGRAM` from the package.
- A voucher or verdict signed for the old address is refused; a results server must be on this release.
- 0.27.2 and earlier keep speaking to the old address. Do not mix the two.

## 0.27.2 — 2026-11-11 (loot 0.27.0)

Going live is signed by a key file on the owner's own machine; the page opens only when asked for.

**Breaking**

- Plain `xsolana approve [file]` opens nothing: it says the two ways and exits 1. A script or note that ran it needs
  `--keypair <keyfile>` or `--browser`.

**Added**

- `xsolana keygen <file>` makes a new key in the Solana CLI's format and prints its address, never the key. The file is
  readable by its user alone, never written over, and refused inside a git repository unless git ignores it.
- `xsolana approve [file] --keypair <keyfile>` prints everything the page shows and a code, and sends nothing. With
  `--yes <code>` it sends exactly that: any change to the file, a step landing or a new fact from the chain gives
  another code. It never prompts. A key file other users can read, one inside a repository, or one that is not a
  whole key is refused. A key that holds less than a new setup takes sends nothing, and a key that does not own a live
  project is refused.
- `xsolana_publish` gives `command` (`… approve <file> --keypair <key file>`), `keygen`, `keyFile`
  (`~/.config/xsolana/<name>.json`) and `browserCommand`.
- `@xgamesfun/solana/keyfile` exports `readKeyFile` and `makeKeyFile`. `readKeyFile(file)` is also a wallet
  `@xgamesfun/solana/play` takes, for an owner's script.
- A key file is the project's owner for good, and unless the spec says otherwise its treasury and authority: name a
  wallet the person holds as `"treasury": "wallet:<address>"` before going live.

**Fixed**

- `xsolana approve` from 0.26.0 to 0.27.1 refused Phantom's approvals after a setup's first transaction. Every setup
  transaction now leads with its own compute unit limit and price (1 micro-lamport a unit, 2 lamports a transaction).
- A transaction the cluster took, whose answer was lost, could be sent again (a setup's seeds paid in twice). The
  approval now asks the chain before it forgets a transaction, which can mean a wait of a minute or two.
- A send refused for a blockhash the node has not seen yet is sent again.
- A sponsored step leads with a unit limit and a unit price of 0, so a wallet that adds its own price no longer turns
  it into a second prompt.

## 0.27.1 — 2026-11-11 (loot 0.27.0)

Every route that hands out an NFT finishes when the NFT is gone, for Core, Token Metadata and compressed NFTs, taken or
burned.

- `claims()` flags a `pull`, `contest` or `auction` claim whose NFT is gone, with `gone`, `assets` and `says`.
- A lottery's pulls, a contest's claims, an auction's end (`endAuction`, `callOffSale`), a `bid` over a bid holding a
  gone NFT, and `unraffle` finish instead of failing; nothing says the NFT moved. Read `NftGone` for a hold as the NFT
  not given.
- `closeGone(asset)` also takes the NFT off each project stash that lists it, returned in `unstashed`; a lottery's own
  stash is named in `waits` (`kind: 'lottery-stash'`) for the project's keys to `unraffle`.

## 0.27.0 — 2026-11-11 (loot 0.27.0)

loot 0.27.0, on devnet since slot 521,001,695: a record whose NFT is gone can be closed. No record changed shape and no
instruction's arguments or accounts changed: 0.26 accounts read as before. The IDL gains the receipt `NftGone`.

- A hold, loan, listing or order whose NFT was taken or burned by whoever controls its collection closes: `release` by
  anyone at any time for no fee (a loan's debt ends unpaid); `refund` and `settle` go on without moving the NFT
  (`PrizeForgone`); `close_listing` and `take_listing` close a listing, but not while a rental runs. Gone is proven,
  never guessed.
- A farm's leaving weight gives its share of the rounding back to the project.
- `js/play`: `claims()` lists a hold or loan whose NFT is gone, and `claim(c)` closes it; `unlist(asset)` closes a
  gone listing; `closeGone(asset)`, new, closes an NFT's holds and listing for anyone; `buyListing` and `rentListing`
  refuse a gone listing in words; `listing()` and `listings()` flag it `gone`.
- A deposit clears an earlier owner's leftover hold or listing first, instead of refusing; the player pays only the
  transaction fee. A listing whose rental still runs still refuses.
- `collect` of an order with a gone NFT settles without it (`gone`); `refund` pays back.
- A farm walk carries 400 ends a transaction (`WALK_PER_TX`, was 500), and a move walks up to 300 first (was 400).
- `piece` takes `tokenMetadata.evidence`.

## 0.26.4 — 2026-11-11 (loot 0.26.1)

A live token's name, ticker or link can be changed.

- A change in the spec is written to the token's Token Metadata record at the next approve, signed by the owner; it
  costs a transaction fee only. Which tokens have a record to write is read from the chain, not the file.
- A token that went live before setups named tokens (0.26.1 and earlier), or whose record was handed on, made
  unchangeable or given a royalty, creators or a collection elsewhere, is left as it is and said; the rest of the
  change goes on.
- A setup or change cut short finishes when it is gone on with: a name edited meanwhile is written, and a setup cut
  short after the project's own step makes its token accounts and lookup table.
- The byte limits and the blank-name refusal apply to a renamed live token.
- `parseRecord` (`chain/metadata.js`) reads a Token Metadata record.

## 0.26.3 — 2026-11-11 (loot 0.26.1)

A token made elsewhere is read from the chain.

- `xsolana token <mint>` (`xsolana_token`) gives a ready `tokens` entry: name, ticker, decimals, token program, and
  its `powers` (minting, freeze, transfer fee, hook, permanent delegate, close authority, pause, frozen accounts,
  non-transferable, confidential transfers), each in words. In code: `powersOf` and `tokenEntry`.
- Going live refuses a mint with a power the spec denies (`"freeze": false` on a mint with a freeze authority,
  `"mintAuthority": "none"` on one somebody can mint, a lower transfer fee). A power the spec doesn't mention is shown
  on the approval page, and no batch is handed out until the page has shown it.
- `W-TOKEN-SALE`: a presale (a one-sided contest whose backers split another token by what each put in) is flagged
  for the law.
- A prize split among a contest's winners from a pool is set aside when the winner is named; naming is refused while
  the pool holds less.
- New example: `community-coin`.

## 0.26.2 — 2026-11-11 (loot 0.26.1)

A token the setup makes is named on chain.

- Its Token Metadata record (`name`, `symbol`, `uri`) is written in the token's own step, so wallets show it by name.
  The owner's wallet is the record's update authority. A token already live keeps what it has.
- The cost counts it: about 0.014 SOL a token (607 bytes of rent and Token Metadata's 0.01 SOL).
- Refused before anything is signed (`E-TOKEN`): a name over 32 bytes, a ticker over 10, a link over 200, or a blank
  name or ticker.

## 0.26.1 — 2026-11-10 (loot 0.26.1)

loot 0.26.1, on devnet since slot 520,911,720: nine small fixes, no layout changed.

**Breaking**

- A box written under 0.26.0 past the new counts can't be edited (`PackTooLarge`), even to switch it off or change its
  price, until its draws are cut. A pack of draws that give nothing is written up to 116 draws; a purchase takes 109
  opens of one.
- `open_box` of more than 300 draws in all and a `buy` of more than 25,454 sales are refused (`PackTooLarge`).

**Fixed**

- A farm's carry is freed when a walk empties the farm, not credited to the next stake.
- A pool never opened is out of stock, whatever the amount.
- A wrong account in a profile's or a Sheet's place reads as nothing; an account that is not a tree is refused.
- The box cost check follows the program's (`drawsFit`, `boxFits`, `opensAnOrder`), with the project once known. A
  box's write asks for 1,400,000 compute units. A raffle pull of several NFTs asks for the largest heap, and a winner
  of many places pulls them over several transactions through `claims()`.
- Left as they are: a farm that mints does not hold room in the mint for its unpaid rewards against other things that
  mint it; a box naming an item never written is refused at the purchase, not at the write.

## 0.26.0 — 2026-11-10 (loot 0.26.0)

loot 0.26.0, on devnet since slot 520,815,761: the fixes of its audit of 0.25.0, and limits only where the chain sets
them.

**Breaking**

- No account of an earlier build carries over: an economy that went live before goes live again.
- `endAuctionIx` takes `ending` (`Deliver`, `LotFirst` then `Deliver`, `CallOff`); a sold lot is never made a hold.
- `repayIx` brings the NFT home in the same instruction (`home`, true by default).
- A deposit of an NFT of another collection with an earlier owner's record on it is refused in words;
  `acceptLeftover: true` goes ahead.

**Added**

- `app.endAuction` delivers and pays in one step, says when a sale is waiting, and calls a sale off when the lot is
  gone; `app.callOffSale` is the project's keys' way out of a lot that never moves.
- A roll's odds at its first ask (`askRollIx` passes the profile and a held NFT); `app.askRoll` picks the collectible
  that raises the odds most.
- `settleIx` takes `giveUp`; `app.collect` says which prizes and takes it.
- Lotteries: `closesBefore`, `timeWeighted`, a place's `whenShort` (`inOrder`, `inProportion`, `nothing`),
  `Lottery.last`; `app.lotteries()` and `app.ticketWeight()`. A box's `whenOut: "giveNothing"`.
- Farms: tiers up to ×100 and boosts up to +100,000%; `unstakeNftIx` takes `needPrize`; `app.staked()` returns each
  seat's weight.

**Changed**

- What 0.26 no longer refuses is a warning in plain words: a far-off time, a token whose accounts can start frozen, a
  price or prize of 0, a mission tier with no lock, a farm minting a token the project can't mint yet, a player's
  auction of any NFT, delegate access to a collection, a sealed schedule's payee.
- The bounds the program keeps are refused before signing: 256 raffle places from a lottery's own stash, 170 texts in
  an NFT ticket's rule, 255 prizes an entry, the farm caps, one oracle answer. A contest that splits a prize of 0 is
  refused.
- `craftIx`: each roll a recipe gives is at `nonce + k`; a payment line nobody can take goes to the treasury.

## 0.25.4 — 2026-11-10 (loot 0.25.0)

Documentation only: the README reads from the top, and its "Before you use it" moved whole to
`docs/before-you-use.md`.

## 0.25.3 — 2026-11-10 (loot 0.25.0)

The hosted MCP server, `https://xgames.fun/mcp`, is in the MCP Registry beside the npm package. The website is
`https://xgames.fun/solana`.

## 0.25.2 — 2026-11-10 (loot 0.25.0)

An MCP server over HTTP, sponsored fees, and conversion to `@solana/kit` instructions.

- `xsolana mcp --http` (`@xgamesfun/solana/mcp/http`): MCP's Streamable HTTP transport, offering only the tools that
  read their arguments and the chain. It refuses `xsolana_save` and `xsolana_publish` and reads no file. Locally it
  listens on 127.0.0.1.
- `xsolana_status` takes a spec as well as a file.
- A sponsor pays players' fees (`@xgamesfun/solana/sponsor`; `solanaApp({ sponsor })`): a key on the project's server
  is the fee payer and lends the player SOL for fees and rent, never the price. `checkSponsored` reads and dry-runs
  every transaction before the server signs, within `maxLamports` and `budget`.
- `toKitInstruction` and `fromKitInstruction` (`@xgamesfun/solana/client`).
- The skill as a zip on every GitHub release; `npx skills add XGamesFun/solana-kit` installs it.
- A loot box tutorial (`docs/tutorial-loot-box.md`).

## 0.25.1 — 2026-11-09 (loot 0.25.0)

A security review of an economy, and patch releases for the JavaScript alone: the package's major.minor is its
program's, and a patch above it (0.25.1 on loot 0.25.0) ships tools without a new program.

- `xsolana review` and `xsolana_review`: an economy read the way a cheater reads it. For every route that pays or gives
  value it says who can trigger it, what the program enforces, what it trusts off chain and the most one cheater gets.
  Findings carry stable `R-*` ids and a severity; the answer is `{ ok, routes, findings, tradeoffs }`, and the command
  exits 1 on a high finding.
- A grant's `trust` (`"decides"`, `"replays"` or `"bounds"`): what the server holding its voucher key checks before it
  signs. Refused on a grant no voucher key or code signs for (`E-GRANT-TRUST`); read as `"bounds"` when left out.
- The skill: `trust-and-cheating.md`, and `xsolana_review` before the owner approves.
- Removed: the examples `stride-sneakers`, `holder-den`, `pack-league`, `match-predictions` and `holders-drop`.

## 0.25.0 — 2026-11-08 (loot 0.25.0)

loot 0.25.0, on devnet since slot 519,994,814: a prize never shifts to a later round.

**Breaking**

- No account of 0.24 carries over: make economies again.
- A lottery takes exactly one of `"pot"` (a number 0 to 15: a pot kept from round to round) or `"rest"` (each round
  pays from its own ticket money and sends what its places leave there). Neither or both is refused
  (`E-LOTTERY-PAYS`). A `rest` that is a pool, `"chosen"` or the lottery itself, a no-loss lottery or a `seed` without
  a pot, and a share or schedule paying a lottery that keeps no pot are refused (`E-LOTTERY`).
- `withDefaults` refuses a lottery without `pays_from`. `pda.lotteryPot(lottery, id)` is a lottery's pot; `pda.pot`
  stays a contest's.
- A box that stops selling and lists a stash's random NFT beside one of its NFTs by name is refused (`E-ODDS`).
- The schema no longer says a fresh item's name takes `{serial}`: the program fills it in links only and ends every
  name with " #<serial>".

**Added**

- Client: `MAX_POTS`, `potIdOf`, `leftoverTo`, `lotteryPots`, `contestWinnings(contest, amount)`; `craftIx` takes a
  token seat's booster on a kept `Use` or a `Show` line (a `Staked` line refuses it).
- Warnings against farming: `W-GRANT-TOTAL`, `W-GRANT-OPEN`, `W-FARM-MINT`, `W-FARM-SWITCH`, `W-GRANT-FUNDS`.
  `simulate` says what one wallet and 100 wallets may claim from each grant.
- `@xgamesfun/solana/results`: `collectiblesOf`, `holds`, a wallet's signed proof (`proofRequest`, `verifyProof`,
  `readProof`, `proofText`) and promo codes (`makeCodes`, `normalizeCode`, `codeKey`, `codeAddresses`,
  `codeVoucher`).

**Fixed**

- A lottery's or farm's seed in a token the project mints is minted at go-live; the setup never finished before.

## 0.24.0 — 2026-11-07 (loot 0.24.0)

loot 0.24.0, "the rules are strict", on devnet since slot 519,723,738. It carries loot 0.22.0 and 0.23.0, whose tools
were not published: packs, tables, profiles, rounds as records, and a leaner program. No account of 0.20.1 carries
over: make economies again.

**Breaking**

- A prize is a fixed amount: the share prize is gone, and a spec asking for one is refused (`E-SHARE-PRIZE`). A share
  still fills a schedule, a decision and a split.
- An outcome no longer burns the payment (`"gives": "burn"`, `burns`): refused in words. A box burns its price with a
  `Burn` share.
- Farms: no `unbond`, `toll` or `rewardsIndex`; a farm's `rewards` names a token and lands in the farm's own vault. A
  tier with a prize needs a lock (`E-FARM`).
- A missed schedule run is missed: only a sealed fixed amount catches up.
- Vouchers sign `"loot-grant-v5"` and verdicts `"loot-verdict-v4"`.
- Client: `orderRefundSlot` gives way to `orderRefundAt` and `orderRefundable(order, slot, now)`; time constants
  replace slot ones (`STALE_SECONDS`, `LOTTERY_TIMEOUT_SECONDS`). Gone: `MAX_RECEIPT_ROUNDS`, `CARDS_AN_ORDER`,
  `auctionArgsOf`, `Farm.marks`, `Seat.credited_at`, the `Stash` account, the `LotteryPaid` receipt, and the
  instructions `settle_round`, `cancel_lottery` and `finish_lottery_contribution`. `refundIx` passes the box while
  the order counts draws in it, and the program refuses a refund without it (`ItemMismatch`). Many builders take new
  arguments.
- Errors: `OverDay`, `BelowMinPot`, `NeedsRoll`, `ReceiptFull` and `StringTooLong` are gone, and the codes after them
  moved: read an error by its name (`lootError`).
- The program caps no count or size of its own beyond what the chain sets; `LIMITS` holds the caps it keeps, and
  `check` refuses a spec over one. Every schema `maxItems` and `maxLength` that stated a removed cap is gone.
- New refusals, by `check`, the builders or the program: an outcome that names a pool twice, a stash's random NFT
  beside anything else of that stash, or one NFT twice (`BadEntries`); a box whose slots leave an entry undrawn; a
  pack one oracle answer can't draw (`PackTooLarge`); a box whose order passes 10,240 bytes; `open_box` when its first
  slot's entries are all out of stock (`SoldOut`); more than 64 runs in a lottery or a run of over 4,096 places; a
  lottery run whose token prize in all passes a u64; a ninth share in a split kept to be paid later (`MAX_SHARES`, 8);
  more than 3 NFTs in a bid (`MAX_BID_NFTS`); an item with more than 64 traits or a trait name over 64 bytes; a share
  into the project's own vault (`BadMove`); a fresh item as an auction lot (`LotRefused`); an NFT a watched farm can't
  read (`NotProven`); leaving a farm while the NFT's last mission roll is unfinished; a farm move past the ends it can
  walk (`FarmNeedsWalk`: walk first with `app.walkFarm`).
- A raise with no `upTo` has no cap and works; its warning is gone.

**Added**

- Packs: `open_box` takes `count`, and a box's `slots` say what one open draws. `openBox(key, { listing, count })`
  opens several with one prompt.
- Tables of weighted rows (top-level `tables`), fresh items with drawn traits (`drawn`), compressed prizes, stash NFTs
  with a `weight`, and player profiles.
- A lottery round is its own record; places are runs (`times`), a `raffled` prize draws an NFT of the lottery's own
  stash, and `roundRent` (on by default) pays buyers' rent.
- A contest's `losersEach`; a grant's `wallets` and `rounds`; a farm's `seed`, `rate.shared`, `rate.halveEvery`, a
  tier's `earnsFor`, `exitFeeTo: "rewards"`.
- A box's `whenOut`: `"stopSales"` (the default: a purchase is refused unless every outcome covers its draws) or
  `"drawLeft"` (it keeps selling and draws among what is left).
- `js/play`: a step after the wallet's prompt is a throwaway key's job, so a craft, a bundle, a roll prize and more ask
  and settle in one prompt; `recover()` finds settle keys a closed page left; `claimAll()` signs independent claims in
  one prompt; `claims()` lists reveals, pulls, payouts, overdue loans and ended auctions.
- Going live always makes the project's standing lookup table (`E-NO-TABLE` without one when a part needs it).

**Changed**

- A draw is on the box's written weights: an entry that can't be given makes no draw and gives back its slot's worth.
- An edit fails only an order holding a payment; other waiting rolls roll on the box as edited.
- An auction whose seller can't take the money delivers the lot and stays open with `proceeds_owed`.
- An order asked of the oracle and holding a payment or an NFT can be refunded after 7 days.

## 0.20.1 — 2026-10-30 (loot 0.20.1)

The first public release of the tools, for loot 0.20.1 on devnet (program
`9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ`).

- Client (`@xgamesfun/solana/client`, `/chain/*`): every PDA, one builder per instruction (58), account and receipt
  decoders and grant vouchers, with no Solana SDK. Runs in browsers and Node.
- Player module (`/play`): `solanaApp` for a browser app on a live economy, with every transaction sized before it is
  signed, refusals in words, and `claims()` offering every step a player can finish. A purchase is made only on the
  terms the page showed (`{ listing }` or `{ maxPrice }`); an option a method doesn't take is refused.
- Results client (`/results`): results and vouchers a game's server signs.
- Economy tools: the spec (version 2) with its JSON schema, the checker, the simulation, the setup plan, costs and a
  plain-words explainer.
- CLI and MCP server: ten `xsolana_*` tools, the same from `xsolana <command>`.
- `xsolana approve`: a page on 127.0.0.1 where the owner connects a devnet wallet and approves each transaction, after
  ticking that they read the notice (the program is unaudited) and the legal flags.
- `xsolana connect` registers the MCP server and the skill with Claude Code and Codex.
- The `xsolana-economy` skill and plugin, examples, TypeScript declarations, and an MCP Registry entry.
- The tests run every instruction and every example's setup against the real program in LiteSVM.
