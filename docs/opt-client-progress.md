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

## Left for the next batches

- **Lottery batch**: catalog P1 for a lottery pull (a place's roll asked in the pull's own transaction, as
  `sendRolling` does for the other routes); `pullIx` / `settleRoundIx` unchanged here.
- **Farm batch**: a spec field for a tier's term (`Tier.earns_for` is written 0 by `farmArgs`); `claims()` lists a
  seat's refresh only for farms with an upkeep (`earns_until` < i64::MAX), not yet for tier terms; js/play's
  `staked()` doesn't show `earns_until`.
- **Structural batch**: nothing started.
- **Keeper (games.fun `launchpad/loot`)**, at its re-pin: match tags by the IDL's length (`codec.mjs`, events stay 8
  bytes); settle `upto` (0 split, `u32::MAX` last); its sweep pays what each settle opens or mints itself (no order
  loan); the claim vectors' grant JSON has `limits.all` and `counted`.
- `SETTLE_RENT_UNIT` is an estimate per prize (a Core asset with plugins about 0.004 SOL); a measured per-kind figure
  would lend the key less. The cost table and simulation still treat a fixed pack too big to buy as bought.
- The program's IDL metadata version is still 0.22.0 (as is the package's).
