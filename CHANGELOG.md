# Changelog

The version of `@xgamesfun/solana` is the version of the loot program it is built for; `release.json` pins that
program's exact build, its IDL and this client. Changes to the program itself are summarised here only where the
tools see them.

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
