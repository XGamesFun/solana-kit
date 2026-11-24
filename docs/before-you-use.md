# Before you use it

Read this before you build on loot and before you ask players to trust what you build. The README has a short
version.

- **Not independently audited, and mainnet is real money.** An economy is on devnet, where nothing has value, unless
  its file says `"network": "mainnet"`. Try it on devnet first.
- **The key that goes live owns the project.** By default that is a key file on your computer: `xsolana keygen`
  creates it, and `xsolana approve --keypair` signs the go-live transactions with it, after it shows everything it
  will send. Whoever can read that file controls the project, and the file signs every later change until it hands
  the project to another key. Keep the file where it is, outside any repository. Never paste it anywhere. Back it up
  yourself, because nothing restores a lost key file. Unless your spec names a `treasury`, what the economy earns for
  you is paid to that key's address. For real money, a browser wallet is safer: see [The owner's key](#the-owners-key).
- **The program can be upgraded, and an upgrade can mean starting again.** The program's upgrade authority can replace
  its code, which is power over every economy on the program. On mainnet, that key is to be a multisig. Most versions so
  far have not carried accounts over from the version before. For example, 0.29 can't read the accounts that 0.28
  made, so an economy made on 0.28 has to be made again for 0.29. Pin the package version (each version names the
  program build it is for in `release.json`). Expect to set an economy up again after an upgrade. The program
  reference's [Upgrades](program.md#upgrades) section says what is known, and what is not, about funds left in an
  older version's accounts.
- **Players trust the project.** The project's owner and authority are trusted keys with no caps. The authority mints,
  moves the project's pool funds, decides contests and writes the project's NFTs. The program protects players from
  each other, from the platform and from mistakes. It does not protect them from the project they chose to play. Money
  held for a record (an order, a bid, a farm's stakes, a contest's or lottery's pot) leaves only by that record's
  rules.
- **Players also trust the token and the collection.** A mint's issuer can stop or move what loot holds through a
  freeze authority, a pause, a transfer hook, a permanent delegate, or a transfer fee it can still raise. A
  collection's controller can do the same. A farm, a vest or a box is only as safe as its token. USDC has a freeze
  authority. The program accepts any token in any role. With a token whose new accounts start frozen, or one with
  confidential transfers, a player can hold up their own part. For example, an auction's high bidder can block every
  higher bid, and a lender can block a repayment. `xsolana check` warns about this.
- **The program restricts a project only where it must.** The program accepts a price or a prize of 0, a mission with
  no lock, a time years in the future, a sealed schedule that pays any address, and a farm that mints a token the
  project can't mint yet. `xsolana check` warns about each of these in plain words. Read every warning before you
  sign. The checker shows a time far in the future with its date.
- **The chain can't see a game.** A key the project trusts, a results server or deciders, vouches for the results a
  game reports (a win, a score, a clear). Checking that a player really did it is the project's job, on its own server.
  A server that decides the result, one that replays it, and one that only bounds what the page reports leave a
  cheater very different amounts. A grant states which one in `trust`, and `xsolana review` says what a cheater gets
  on every route ([trust and cheating](../skills/xsolana-economy/references/trust-and-cheating.md)).
- **The hosted results server is optional.** `https://play.xgames.fun/xsolana` is the default of
  `@xgamesfun/solana/results`. It signs vouchers for games without a server of their own. It can pay only what a grant
  allows, and only for a grant whose owner named its key in `vouchers`. It sends nothing on chain. It is offered as is:
  it can be down, and it lags behind for a while after each program upgrade. A game with its own server signs its own
  vouchers (`signVoucher`), which is the better choice once the game has a server.
- **Nothing runs by itself.** Someone sends every step:
  - settles: the player, the project's keys, or a key the player named;
  - lottery draws and auction ends;
  - refunds: anyone;
  - contest results: the authority or its deciders;
  - schedule runs: the project's keys.

  A run that nobody sends on time is missed, except a sealed schedule's fixed amount. Apps built with
  `@xgamesfun/solana/play` send the steps a player needs. Don't count on a hosted keeper.

- **The rules are strict.** A prize is a fixed amount. A jackpot that grows is a lottery's pot. A lottery states where
  its places are paid from. It is either a pot that carries over (gifts and what earlier rounds left count toward it),
  or each round's own ticket money, which nothing from outside can change. A prize never moves to a later round. A
  draw uses the odds as written. When an outcome runs out, a box does one of three things:
  - `stopSales` (the default): it stops selling, and a paid miss is refunded.
  - `drawLeft`: it keeps selling and draws among the outcomes that are left. A player can then empty a common outcome
    to make a rare one likelier.
  - `giveNothing`: it keeps selling and gives nothing for a miss, which is never refunded.

  Both sides of an exchange move together. An auction's seller is paid only when the lot reaches the winner, and a
  loan's repayment brings its NFT home.

- **Chance comes from an oracle.** MagicBlock's VRF answers every random roll and draw. If it stops answering, rolls
  wait. A purchase whose roll has not been answered 10 minutes after it was asked can be refunded. A buyer who sees a
  late answer coming can therefore take the refund instead. A roll won another way holds no payment and is asked
  again. A roll that holds a payment or an NFT (an auction's mystery lot) can be refunded 7 days after its first ask.
- **Fees and rent.** The platform sets two flat fees. The player fee is 0.002 SOL on devnet and 0.0005 SOL on mainnet
  (the default is 0.002 SOL). The project fee is 0.00001 SOL on both. Each fee is capped at 0.01 SOL. A raise waits 7
  days before it applies, and a cut applies at once. Devnet is play money, and devnet's player fee is four times
  mainnet's. A percentage that `xsolana check` or `xsolana cost` shows on a devnet spec therefore overstates what the
  same action costs on mainnet. Both commands also state the mainnet figure. Accounts cost rent when the economy goes
  live and at each settle that opens or mints something. `xsolana cost` gives the totals. The platform can suspend
  purchases. It never stops payouts, refunds or unstakes, with one exception: a recipe that charges.
- **Some things aren't built,** and some limits are kept by design. Read [Known limits](program.md#known-limits)
  before you promise players something unusual.
- **The law is yours to check.** The checker's legal flags (chance at money, resellable random items, revenue sharing)
  are reminders, not legal advice. A spec with no flag is not necessarily legal.

## The owner's key

The key that signs going live becomes the project's owner. The owner changes the project's settings and every
mechanic. Unless the spec names others, it is also the authority (which mints, moves pools and decides results) and
the treasury (where sales land).

| Way to go live                                   | Where the owner key lives                  | Trade-off                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `xsolana approve --keypair <file>` (the default) | a plain file on your computer              | No browser, and the signed transactions are exactly what was printed. Anything on the machine that can read the file can sign as the project. |
| `xsolana approve --browser`                      | your browser wallet (Phantom, Solflare, …) | The key stays in the wallet. A wallet that keeps its key on a hardware device (a Ledger, for example) never exposes it to the computer.       |

**For mainnet, prefer the browser wallet, backed by a hardware wallet if you have one.** Use the key file for devnet
and for trying things out. These tools have not been tested with a hardware wallet, so try the whole flow on devnet
with the same wallet first. A project a browser wallet owns is changed again with `approve --browser`; a project a
key file owns is changed only by that file (or the key it was handed to).

Whichever you choose, you can name a separate `treasury` (a wallet you hold, such as a hardware wallet or a
multisig) and a separate authority (`keys.authority`) in the spec before going live. A server that signs by itself
gets an authority key of its own, never the owner's.

### Handing the project to another key

The program can give a project a new owner: `update_project` with a new owner, signed by both the current owner and
the new one. The project keeps its address. The authority and the treasury stay as they are unless the same
instruction changes them too. After the hand-over, `xsolana approve` with the new owner's key changes the project.

These tools have no command for a hand-over yet. It takes a short script with `@xgamesfun/solana/client`. With two
key files (the tests do exactly this):

```js
import { readKeyFile } from '@xgamesfun/solana/keyfile';
import * as loot from '@xgamesfun/solana/client';
import { rpcClient } from '@xgamesfun/solana/chain/rpc';
import { compileMessage, wireTransaction } from '@xgamesfun/solana/chain/tx';

const was = await readKeyFile('~/.config/xsolana/my-game.json'); // the current owner
const now = await readKeyFile('~/.config/xsolana/new-owner.json'); // the new owner: it signs too
const project = '<the project address from the live section of xsolana.json>';
const ix = loot.updateProjectIx({ owner: was.address, project, newOwner: now.address });
const rpc = rpcClient('https://api.devnet.solana.com');
const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
const wire = wireTransaction(compileMessage({ payer: was.address, blockhash, instructions: [ix] }));
const signature = await rpc.send(await now.signTransaction(await was.signTransaction(wire)));
await rpc.confirm(signature, { lastValidBlockHeight });
```

A new owner that is a browser or hardware wallet must sign the same transaction in that wallet, through a page you
build; these tools don't build that page. A multisig can hold the treasury or the authority role. These tools have
not been tried with a multisig as the owner.

See also [SECURITY.md](../SECURITY.md) (the trust model, and how to report a vulnerability) and
[DISCLAIMER.md](../DISCLAIMER.md).
