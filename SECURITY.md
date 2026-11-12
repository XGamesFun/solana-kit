# Security

## Status

| Piece                             | Version                                                                                                                   | Where                                                                           | Review                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The loot program                  | 0.28.0: `xgamesVsZBpCVgJuatfYAFJRmQoccfQf5qtUFNp2Eet` on devnet, `xgames8C758PyweWB9sDw8evvwsTVwyA2fGRUeAXVPy` on mainnet | devnet since slot 521,074,836, mainnet since slot 468,156,581 (both 2026-11-11) | Internal reviews only. **Not independently audited** |
| These tools (`@xgamesfun/solana`) | 0.28.13                                                                                                                   | npm                                                                             | Internal reviews only                                |

`release.json` pins the exact program binary, IDL and client this package is built for. Nothing runs on mainnet.
Mainnet waits for an independent audit of the exact code to be deployed.

The program is upgradeable. Its upgrade authority only upgrades the program (and makes the first platform admin); the
platform admin signs only the platform's fees and its suspend switch. On mainnet the upgrade authority is to be a
multisig. On devnet an upgrade has so far meant a new account layout: no account carries over from an older version,
so an economy made on one version is made again on the next.

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
- What is already decided can always be finished: anyone can send refunds, draws and returns; a settle is sent by its
  player, the project's keys or the key its player named.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting (the **Security** tab of this repository,
then "Report a vulnerability"). This covers both the tools here and the deployed program. Don't open a public issue
for a vulnerability.

Include the version, what an attacker can do, and a failing test if you can: the tests here run the real program in
LiteSVM (`js/test/world.mjs` sets up a chain; `npm run fixtures` downloads the program and the programs it calls).

## The tools

The JavaScript tools, the MCP server and the plugin never ask for a seed phrase or for the key of a wallet a person
already has, and never print a key or send one off the machine. Going live is signed on the person's own machine: by
a key file `xsolana keygen` makes for the project; or, when they ask for it, in their browser wallet on a page served
on 127.0.0.1 (`--browser`). The page sends a transaction as it prepared and showed it, or as the wallet signed it when
the wallet added only its own to a transaction it alone signs: instructions of the Lighthouse program (a wallet's own
checks, which Phantom adds), or a heap size. Everything prepared must be in it untouched, in order, with no account of
it made writable or a signer that was not; nothing of any other program may ride with it, and no fee of the wallet's
own (`js/approve/wallet-adds.mjs`). Anything else is refused and nothing is sent. What an instruction of the
Lighthouse program does is that program's to say: this package takes it as the wallet's own, as the wallet's user
already does. The key file is read
only through the tools: `xsolana approve --keypair`, and
`readKeyFile` in a script for what the authority signs later. `approve --keypair` first prints everything it would
send and sends nothing; it sends only when run again with the code of that printout. An agent is told to do that only
after the person's yes: the tool binds what is sent to what was shown, and cannot check who said yes. A key file is
the project's owner: whoever can read it controls the project. It is made readable by its user alone (on Windows that
rests on the user folder's own permissions), a path inside a git repository is refused unless git ignores it there,
and it is never written over. A tool that asks
for a seed phrase, prints a key or sends one anywhere is a bug: please report it.
