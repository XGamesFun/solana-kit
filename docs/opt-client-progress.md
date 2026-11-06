# The program's optimization batches in the client: progress

Working note for the `loot-0.23` branch, so the work can resume if interrupted, and so the next batches (lottery,
farm, structural) know what is left. Delete it once the branch merges.

Program: `gamesfun-loot` worktree `opt-orders` (batches A and B, from 339a281; `docs/opt-a-progress.md`,
`docs/opt-b-progress.md` there). Built against `XSOLANA_PROGRAM_DIR=/home/potatoe/Documents/gamesfun-loot-worktrees/opt-orders`
(`loot.so` 1,671,488 bytes). The pins (`js/test/fixtures/pinned.txt`, `release.json`) stay on devnet's 0.22, so
`release-manifest --check` fails, as before; everything else in `npm run check` passes.

## Batches A and B (done)

- [x] IDL synced; 1-byte instruction tags (`instructionOf`, longest tag first: the oracle's callbacks keep 8 bytes),
      used by the approval page, the local chain (`lootName`) and `evals/live/wallet.mjs`
- [x] error text out of the program: `lootError`, the local chain and js/play's `inWords` give the IDL's sentence by
      code; `programError` says a bare name once; codes after `OverDay` come from the IDL
- [x] shapes: `Fate.then` Option<Spend>, `Won::Item { drawn }` (no `Fresh`, no `Roll`), `Limits.all` /
      `Grant.counted`, `Raise { place, shift }`, `Need { test }` (`Older`), `Debt` without `paid`, `Auction.pin`, no
      entry/order/receipt `burns`, no `Item.life`, no `Input::Renew`, no committed tables (`decodeTable`), `Tier.earns_for`
      and `Seat.earns_until` (from f7ce19c, just before batch A)
- [x] settle `upto`: 0 the split alone, past the end (`SETTLE_LAST`) the last part; no `rows`
- [x] open_box always asks the oracle (its four oracle accounts always); `buy(count)` (`buyGives`)
- [x] writes and routes naming a box to roll pass the box alone (`boxesAccounts`); roll accounts with the table budget
      (`callbackAccounts`, `tableBudget`, `entryAccounts`); `askRollIx({ items })`
- [x] `orderBytes` with the rows' room; `MAX_ORDER_BYTES` doc (91 draws of a one-item box)
- [x] Catalog P1 (client only): `sendRolling` asks for a route's rolls in its own transaction (craft, bundle buy,
      mission, grant claim, contest claim, auction end); `SoldOut` from the dry run refuses in words and sends nothing
- [x] no order reserve: `settleRent` / `SETTLE_RENT_UNIT` (6,000,000 lamports a unit, the old escrow's figure, a client
      estimate); the open's and `sendRolling`'s one prompt funds the key with it; the key settles after a dry run and
      sends back what it holds in its last settle's transaction (the dry run's balance), else empties itself after;
      the wallet settles only when the key's dry run fails (a fresh token account, a proof, too big). One prompt kept.
- [x] fixed packs: js/play buys a box that doesn't roll with `count` (any draws), opening it instead when it doesn't fit
      a legacy transaction or its dry run fails; the checker sizes such a pack as an open
- [x] item life and cooldown as recipe needs and raises: `lifeLines` (model), written by `recipeArgs`; renew is a `Use`
      with a raise of `used` by −i32::MAX; a staked line's life raise must move its farm's lock (checker)
- [x] committed tables: client support removed (`committed`, `ProvenRow`, `MAX_PROVEN_BYTES`, `provenRowBytes`)
- [x] out-of-stock rule in the checker: W-OUT-OF-STOCK for a hooked or confidential prize in a rolled box (was the
      E-BOX refusal), W-PRIZE-SEED reworded for a short pool, a roll in a box that rolls refused, a roll in a box an
      order rolls warned; an outcome burning the payment (`"gives": "burn"`, `burns`) refused in words
- [x] auction roll lot: no split at the end, the bid split at the settle; NFT-bid tests moved to item lots
- [x] repay: a repaid loan is a plain hold that is over; `releaseIx({ address })`
- [x] `boxHeapFrame` removed (opens no longer roll in the transaction; 240 token draws and 91 item draws open and roll
      with the default heap, tested)
- [x] skill, MCP text, guide, AGENTS.md key rule, CHANGELOG; `docs/program.md`

Tests: 487 pass (was 482 at e204414; new `item-life`, `fixed-packs`, the rewritten `roll-mints` and `roll-chains`).

## Batches C and D (done)

Program: the merged A–D snapshot `build-6760561` (the gamesfun-loot session's scratchpad; `docs/opt-c-progress.md`,
`docs/opt-d-progress.md`, `docs/opt-merge-progress.md` there; `loot.so` 1,659,296 bytes). Tags dense 0–54 (`pull` 20).
Built against `XSOLANA_PROGRAM_DIR=<that snapshot>`; the pins stay on 0.22, so only `release-manifest --check` fails.

- [x] client wire (874734d): IDL; the round's layout (`owns`, `pot_owed`, `nfts`, `assigned`; no cursor, no entry
      wallets; `entryWidth(fee, nft)`), `drawLotteryIx({ round, roundAddress, skipHooked, poolMints })` with the ask's
      accounts (pot, its mint, the round's account; each token run), `pullIx` for `Own` / `Pot` / `Prize` / `Common`
      (`commonOwed`, `toTreasury`, `lotteryClosed`), `stashNfts` (which stash NFT each place gets, as the pulls take
      them out), `pullRolls`, `buyTicketsIx` paying a chosen share at purchase (`treasury`), `idleRound` for an ended
      draw-once lottery (upsert, close, stash); holds by address (`claimIx`/`bidIx`/`endAuctionIx` `hold`: true or a
      list); `decideIx` with no opener/entries, a contest owing nothing closed by any claim; `closeLeafIx` with the
      payer signing + `withLeafCloses`; farms (no rewards_pool/toll/unbond; `Rate` shared/halve_every; `Sink::Rewards`;
      the mint written only when a minting farm pays; 184-byte seat; `moveTokensIx` from `{ Farm: [id] }`); sealed
      schedules name no account they pay
- [x] economy tools (c83f23c): a farm's `rewards` is a token (a pool is refused in words), `seed` into its vault,
      "farm:<key>" destination (`@rewards:<id>`) for splits, recipes and pay/issue schedules; `rate.shared`,
      `rate.halveEvery`; a tier's `earnsFor` (closes the "spec field for a tier's term" item); `exitFeeTo: "rewards"`;
      no `unbond`/`toll`/`rewardsIndex` or empty pools; W-FARM-DRY; the farm's bytes count its end marks; the
      simulation counts each farm's vault as a pool; sealed schedules wallet/treasury/burn only; a lottery's
      `roundRent` (a plan step sending SOL to the lottery, counted in the cost); the raffle cap (`assign_fits`); the
      approval page names a farm's vault; examples moved off reward pools
- [x] js/play (6395089): `roundOf` reads the two rounds before the current one; claims `reveal` / `cancel-draw` by the
      waiting round's address, `pull`, `payout` (common parts too), no `settle-round`; a place's roll asked in the
      pull's own transaction (catalog P1: `sendRolling` for the winner's own, an inline ask for someone else's when the
      dry run passes); the close rides on the last pull; farms without HarvestFirst/RewardsLocked/withdraw, no
      `refresh-seat` claim (no refresh needed at a seat's end), `staked()` finds seats by player at offset 1 and says
      `earnsUntil`; every send appends `close_leaf` (`withLeafCloses`); live-eval wallet allows `roundRent`
- [x] docs, skill, changelog

Tests: 491 pass (was 487; new: a lottery roll prize in one prompt, `withLeafCloses`, `roundRent`, the ask's accounts,
a part owed in common to the treasury; tests of removed behaviour rewritten: unbonding, tolls, HarvestFirst, the
sweep, the cursor, `cancel_lottery`).

Found in the program while doing this (not changed here; the program is read-only to this branch):
- `pull` of `Common(n)` (what the round owes the pot) has no status check: while the round is `Drawing` anyone can
  move `pot_owed` (ticket money the places don't take) into the pot; a later timeout cancel then sets
  `pot_owed = pot_arrived − to_pot` (0 in that case) and owes every entry its refund out of a round account short by
  that amount, so the last refunds fail. Batch C's notes say the pot's excess must stay in the round until the
  answer. The client pulls it only once the round is Drawn or Cancelled (`commonOwed`).

## Left for the next batches

- **Batch E (program, coming)**: auction layout changes (the client's `Auction` decode, `auctionArgsOf`,
  `auctionTerms`, `leastBid`, `endAuctionIx` / `bidIx` accounts, the plan's auction size, js/play's auction reads);
  a fix to `ask_roll` on empty boxes (the `SoldOut` rule `askRollIx` and `sendRolling` follow, the asks js/play adds
  to a pull or a claim, and the eligible-asker wording in the skill). Re-sync the IDL, follow `docs/opt-e-progress.md`
  there, and run the suite against its build.
- **Structural batch**: nothing started.
- **Keeper (games.fun `launchpad/loot`)**, at its re-pin: match tags by the IDL's length (`codec.mjs`, events stay 8
  bytes; dense 0–54 now); settle `upto` (0 split, `u32::MAX` last); its sweep pays what each settle opens or mints
  itself (no order loan); the claim vectors' grant JSON has `limits.all` and `counted`. From C and D: no
  `settle_round` / `cancel_lottery` (ask with the pot and token runs' accounts, re-ask and timeout-cancel a waiting
  round by its address; pull every part, `Common` included; the close on the last pull), no seat refresh at a seat's
  end, seats found by player at offset 1, `close_leaf` after a compressed NFT is used.
- `SETTLE_RENT_UNIT` is an estimate per prize (a Core asset with plugins about 0.004 SOL); a measured per-kind figure
  would lend the key less. The cost table and simulation still treat a fixed pack too big to buy as bought.
- `roundRent` has no estimate in the checker (a round's header grows with its places and shares); the guide says
  about 0.004 SOL and up a round.
- The program's IDL metadata version is still 0.22.0 (as is the package's).
