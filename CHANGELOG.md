# Changelog

The version of `@xgamesfun/solana` is the version of the loot program it is built for; `release.json` pins that
program's exact build, its IDL and this client. Changes to the program itself are summarised here only where the
tools see them.

## 0.22.0 (not released; the program is not deployed yet)

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
- **Stashes are tables of NFTs**, each with a weight (`stash`'s `weight`), drawn by weight; the `Stash` account (tag
  21) is gone.
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
