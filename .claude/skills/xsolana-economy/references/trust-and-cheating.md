# Trust and cheating

The program enforces its own rules: a cheater can't take more than a route's limits, move a voucher to another
wallet, harvest someone else's seat or mint into the project's collection. What a cheater can still take is what the
economy's design and its servers leave open: a result the server never really checked, a person counted as many
wallets, a reward that keeps earning for good. This page is how to read an economy for that, and how to tell the
person what they are choosing. `xsolana_review` does the reading for a spec; this page says why.

## How far a result can be trusted

A result is worth paying only as far as the server that signs the voucher can tell it happened. Strongest first:

- **The server decides it.** A turn game played on the server, or a room whose server runs the match: the page sends
  inputs, never results. The result is what the server saw.
- **The server replays it.** A deterministic game (a fixed time step, seeded randomness): the page sends its inputs,
  and the server runs them again and reads the result itself. Mind CPU limits: replay short runs, or a long one in
  pieces as it is played. Never hand the page the whole run's randomness up front: with the seed and the rules, a
  script searches for the best run offline and sends only that. Reveal randomness as the run goes, or keep the seed on
  the server; one open run per player, and count abandoned runs toward the day's.
- **The server bounds it.** Any game the browser simulates: the server starts each run (an id and its own clock),
  takes each checkpoint in order, refuses what is faster than the game allows, caps what one player earns a day, and
  can ban. A script that plays at human speed still gets through: this limits what a cheater earns, it does not stop
  one.

| Level | What it costs to build | CPU and latency | What a cheater gets | Fits |
|---|---|---|---|---|
| decides | the most: the game's rules run on the server (or in a room that runs the match) | every move waits on the server | what a bot that plays well earns; nothing forged | turn games, card and board games, matches in a room, anything with hidden information |
| replays | a deterministic game (fixed step, seeded randomness the server keeps) and a replayer | a replay per run, after the fact; short runs or in pieces | what a bot that plays well earns; with the seed up front, the best run found | puzzles, runners, arcade games with short runs |
| bounds | the least: a run id, the server's clock, checkpoints in order, daily caps, a ban list | almost none | every reward a script claims at human speed, up to the limits | anything the browser simulates; prizes that are cosmetic, small or capped |

Even a result the server decided is worth what a good bot can earn. Pay a bounded or replayed result only what you would
accept losing to a patient script (small amounts, capped a day), and keep entry fees and prize pools for results the
server decided and for chance (the oracle). Tell players which one your game is.

**Say it in the spec.** Every grant paid on vouchers says what its server checks: `"trust": "decides"`, `"replays"` or
`"bounds"`. It is the spec's own note (it never goes on chain, and changing it publishes nothing), and it must be
honest: a server that takes the page's word within a pace is `bounds`, whatever else it does. `xsolana_review` reads a
voucher grant that says nothing as `bounds`, the weakest.

## Who gets paid: wallets are not people

- **A wallet is free.** Any limit per wallet (`perWallet`, a gate's one claim per collectible shown) limits wallets,
  never a person. What bounds a reward is its totals: `perDay` and `total` are the most it can ever pay, whatever
  happens to a key or how many wallets come.
- **Count people through vouchers.** `perPerson` counts the person the voucher names (a person hash), which only the
  server chooses: the player can't pick or change it, and an open grant has none. So it is exactly as good as the
  server's choice: a real outside identity (an X account) counts people; a wallet, or a voucher with no person, counts
  nobody. For rewards worth farming, pay only players signed in with X.
- **Make farming cost something.** Gate on holding a collectible the game sells or a locked stake (`gate`), pay only
  wallets a player proved (`proofRequest` / `verifyProof`), and keep prizes for results small.
- **Bots play well.** Even a verified result pays a bot what it pays a good player.

## What the program guarantees

These were attacked on devnet and refused by the program; there is nothing to build for them:

- **A voucher is bound to its claim.** It signs the program, the grant, the grant's incarnation, the wallet, the person,
  an expiry and its rounds. It can't be moved to another wallet, or replayed on another grant or a re-made one. A key
  not among the grant's voucher keys is refused, and so is a claim with no voucher on a grant that isn't open.
- **The winning wallet signs its own claim.** Anyone may pay its fees; nobody claims for it.
- **A round pays a wallet once** per grant incarnation, whoever signs it again and whenever; `perWallet`,
  `perPerson`, `perKey`, `perDay` and `total` are kept by the program. Once for that wallet: the chain keeps a paid
  round with its wallet, so the same round signed for a second wallet pays again, and a voucher that ran out may have
  been collected before it did. A server that signs a win again (a player's other wallet, a new voucher after the
  first ran out) first reads the chain for the first wallet (`winPaid` from `@xgamesfun/solana/results`), or keeps each
  win on the first wallet it signed for.
- **A farm's gate can't be forged.** It checks the project's collection and the item number the program writes at mint
  and never lets change: an NFT of another collection, one in no collection, an attribute written by hand, or a mint
  into the project's collection by anyone but the project are refused. Boosts read the staked NFT's own item number.
- **One seat per NFT, ever.** In escrow, an NFT can't leave before its lock or be staked twice. Watched, an NFT sold
  while staked earns its old staker nothing more, and its new holder takes the seat over. Nobody harvests or unstakes
  someone else's seat.
- **The project's keys.** A token the project mints has the project as its only minter and no freeze authority. Only
  the authority mints or moves pool funds; only the owner changes mechanics or closes records. Money held for a
  record (a farm's stakes and rewards, a pot, an order, a bid) leaves only by that record's rules.
- **Chance is the oracle's.** Nobody, the project included, steers a roll or a draw.

## What is still yours to get right: the checklist

Run `xsolana_review` and go through what it reports; these are the points behind its findings.

1. **The signer decides who is paid.** The program checks a voucher's signature, wallet and limits, never what
   happened in the game. Declare `trust` honestly on every voucher grant, and make the server's checks match it.
2. **Person counting.** `perPerson` holds only when the server names a real person (an X account) in every voucher,
   never a wallet. Without it, each free wallet claims again: set `perDay` and `total` as if every claim were a new
   wallet.
3. **Sybil wallets.** Open grants (no voucher, code or list) pay any wallet that asks: gate them on something a sybil
   must pay for, keep their prizes small or soulbound, and set `perDay`.
4. **Voucher key custody.** The key's secret lives only on the server: never in a page, a repository, a spec or a
   chat. Anyone holding it pays anyone, up to the grant's limits, which is why `perDay` and `total` matter. To rotate
   it, put the new public key in the grant's `vouchers` and publish. Use a different key on each cluster: a voucher's
   bytes don't name the cluster.
5. **Re-made grants pay again.** Closing and making a grant again starts a new incarnation: a new campaign whose
   limits start from zero, and whose list pays every listed round again. Give a re-made grant fresh rounds.
6. **Emission without an end.** A farm whose rate is minted, with no `runs`, no term on every tier (`earnsFor`), no
   upkeep and no halving, mints for as long as anything is staked. Every way to get what it takes is then worth that
   stream: a cheatable claim of a staked NFT compounds into tokens for good. Give it an end, or pay its rate from its
   vault.
7. **Prizes worth farming.** A tradeable prize (tokens, an NFT that can be sold, a roll) on a route a script can reach
   is what a cheater farms. Keep such prizes for results the server decides, or small and capped.
8. **Entry fees and prize pools.** Players' money (a payment, a box's or a lottery's share into a pool) paid out on a
   bounded or replayed result goes to whoever scripts it. Keep those for decided results and chance.
9. **NFT farm custody.** Escrow moves the NFT to the project while staked; freeze locks it in the wallet; watch leaves
   it free, so it can be sold while staked and its buyer takes the seat. The issuer's own controls still apply to
   NFTs of other collections.
10. **The gate.** A farm or a route gated on the project's items (`items`, `item_id`, `rarity`) is as strong as the
    ways those items are had. A gate on another collection's attributes trusts whoever can write them.
11. **The authority and the treasury.** The owner's wallet alone changes every price, rate, grant, limit and voucher
    key; the authority mints, moves pool funds, decides contests and releases holds, with no caps. On devnet the
    owner's key is the key file the setup was signed with: readable by its user alone, outside any repository, never
    pasted anywhere. With real money (an economy on mainnet) those keys belong in a hardware wallet or a multisig; a
    server that signs gets an authority key of its own, never the owner's.
12. **The page is untrusted.** A page builds the player's transactions, and a cheater builds their own: the program's
    checks are what count, never the page's. Anything the page decides (a score, a reward amount, who won) is only as
    good as the server that checks it.
13. **Ordering.** A lottery's tickets count one each unless it weighs them by time (`timeWeighted`, no-loss
    lotteries only): then one buyer can't take most of a round right before the draw for the fees alone, and the buy
    screen shows what a purchase weighs. A no-loss lottery should close its sales a while before the draw
    (`closesBefore`). Anyone, the seller included, can bid an auction up; an auction with no extension or no least
    raise lets two wallets topping each other in the last seconds keep every other bid out. A box that keeps selling
    when an outcome runs out (`drawLeft`) lets someone watching the stock empty a common outcome to make a rare
    likelier; one that gives nothing for a miss (`giveNothing`) lets anyone emptying a shared source make its rolls
    miss.
14. **Contests.** Players' stakes go to the side the authority or a decider key names, and whoever names it can also
    enter: keep contests for results the server decides, or that anyone can check outside the game. A prize to each
    winning entry with no stake and no gate pays one person with many wallets once a wallet.
15. **NFTs the project doesn't control.** The creator of an NFT with a permanent delegate can pull it back out of a
    hold, a stake, a loan or a listing, or burn it there. Its record then closes without it (anyone may, and nothing
    is paid: a lender is out what they lent), and `js/play` closes what an earlier owner left before the next owner's
    deposit. A collection the project is only an update delegate of lets its owner and every other delegate mint NFTs
    that read as the project's own items. Name only collections whose every writer the project trusts.

## Telling the person

After `xsolana_review`, before the owner approves, say in plain words:

- for each signed route, which level its server uses and what a cheater gets ("A script that waits long enough gets
  a Legendary per wallet, up to 100 a day, and each earns 50 tokens a day for good");
- what the next level would cost to build ("replaying runs needs the game to be deterministic and a server that re-runs
  each run");
- every high finding, and its fix, or that they accept it.

They choose the trade-off, not you.
