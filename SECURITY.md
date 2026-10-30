# Security

## Status

| Piece | Version | Where | Review |
| --- | --- | --- | --- |
| The loot program | 0.20.1, program ID `9cwqM1TXytPnFZsLfmUyv2dg4uW6Ch9C6UJVPns7NFQ` | devnet only | Internal reviews only. **Not independently audited** |
| These tools (`@xgamesfun/solana`) | 0.20.1 | npm | Internal reviews only |

`release.json` pins the exact program binary, IDL and client this package is built for. Nothing runs on mainnet.
Mainnet waits for an independent audit of the exact code to be deployed.

The program and these tools are provided as is, without warranty: see [DISCLAIMER.md](DISCLAIMER.md).

## What the program protects, and what it does not

A project has two trusted keys, its **owner** and its **authority**. The program keeps players safe from each other,
from the platform and from mistakes. It does not protect them from the project they chose to play. The whole model is
in [`docs/program.md`](docs/program.md) ("Who signs").

Promises a report should test against:

- A player pays no more than the most they signed for.
- Nothing the platform signs stops a payout, a settle, a refund or an unstake.
- The authority cannot pay out of the vaults that hold open orders and auctions' bids, a farm's vaults, a contest's
  pot or a lottery's.
- No payment waits on a token account: the program opens the account it pays into, and whoever sends the instruction
  can't send a share elsewhere.
- A bid that is topped goes back to its bidder in the same instruction; nobody can block a new bid or an auction's
  end; an auction with a bid in runs to its end, and one nobody ends still sells to its high bidder whenever it is
  ended.
- A voucher key can never give more than its grant's limits.
- Anyone can finish what is already decided: refunds, settles, draws, timers and returns.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting (the **Security** tab of this repository,
then "Report a vulnerability"). This covers both the tools here and the deployed program. Don't open a public issue
for a vulnerability.

Include the version, what an attacker can do, and a failing test if you can: the tests here run the real program in
LiteSVM (`js/test/world.mjs` sets up a chain; `npm run fixtures` downloads the program and the programs it calls).

## The tools

The JavaScript tools, the MCP server and the plugin never sign a transaction and never ask for or hold a private key.
Going live and every decision are approved in the person's own wallet. A tool that asks for a key or a seed phrase is
a bug: please report it.
