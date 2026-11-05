# loot 0.23 in the client: progress

Working note for the `loot-0.23` branch, so the work can resume if interrupted. Delete it once the branch merges.

Program: `gamesfun-loot` `loot-0.23`, plan `docs/plan-0.23.md`. Built against the review 1 build (program commit
545cce0, `XSOLANA_PROGRAM_DIR=/tmp/claude-1000/-home-potatoe-Documents-gamesfun-loot/a14430d7-cb8c-462d-a7fb-816dd602a6fa/scratchpad/loot-r1-build`,
`loot.so` sha256 0032534c…); before it, the clean-up build (3f530f80…) and the phase 6 build (032b0666…). The pins (`js/test/fixtures/pinned.txt`, `release.json`) stay on devnet's 0.22 until the
0.23 upgrade.

## Wire changes (phases 1–6)

- [x] pda: u16 pools; counts, claims, rounds, round, round-tokens, entries; receipts, contributions, lottery funds and
      contest entries' own accounts gone
- [x] accounts: tags (a list is 26, a round 16, a grant 24), lists (M1), counts, round header and entries, contest
      entries; receipts gone
- [x] ix: tail from the Memo program; Make through `prize::give`; stash weights; hold/release payer and rent_to;
      close_leaf with a project; run_schedule upto; escrow units; counts on buy/open/craft/refund; lottery round
      (buy, draw, callback, cancel, settle_round, pull, upsert, close); contest entries (open, enter, decide, claim);
      groups of several NFTs (stake/unstake/harvest/stash/hold/release/Make)
- [x] grant: voucher v5 (`prefix || sha256(body)`), rounds list, shards, close_shard, 400k compute on claims
- [x] verdict v4, u16 sides
- [x] economy: schema, checker, plan, simulate, cost, explain (places as runs, Raffled, contest cap, shard bits)
- [x] play: lottery, contest, grant, farm, hold flows
- [x] mcp, cli, skill text, docs/program.md, CHANGELOG
- [x] tests green
- [x] clean-up build: `LotteryTerms` (Lottery, LotteryArgs and the round hold `terms`), buy_tickets without
      incarnation, `LotteryPulled.amount`, no `LotteryPaid`
- [x] review 1 build: close_leaf `edition`, grant tag 27, pulls of at most 300 places (`placesPulled`), the checker's
      u64 run refusal, the re-made grant list warning (approval page)

## Client-only items (plan "The client, with no program change")

- [x] 1 key job rule (`keyFor`/`keyRun` in js/play; a box's open funds its key the same way; `repay` then a key's release)
- [x] 2 rolls in one prompt (`sendRolling`: craft, mission, grant, contest prize, a roll lot its winner ends; a lottery place's roll is settle_round's, not a player's step)
- [x] 3 standing lookup tables (the project's, made at go-live, used by play's sends and keys; loot's frozen cluster table not made: needs the loot team's key)
- [~] 4 packing rule: `claimAll` signs independent claims in one prompt (`signTransactions`, else one by one); a loan's repay alone, a key's release. Not done here: the keeper's pack (in games.fun), new chained flows (buy then craft, prove_traits then the action)
- [x] 5 owner flows (authority steps last, approvals counted per signer, stash NFTs a group a call)
- [x] 6 go-live accounts
- [x] AGENTS.md key rule

## Notes

- Commit 1: the wire (452 tests green against the phase 6 build). Next: tests of the new mechanics (batches, rounds of
  runs, raffles, shards, contest picks), then skill/docs text, then the client-only items.

- program: a lottery's per-wallet count keeps a u32 total of every round's tickets; 2^32 in all refuses that wallet's next purchase (Overflow). The 0.22 receipt kept no total.
- program (fixed in review 1): a grant's tag was a profile's (24); now 27.

- check: `npm run check` with the review 1 build: fixtures, skills, lint and 466 tests pass; `release-manifest --check`
  fails only because release.json pins devnet's 0.22 IDL and client (left as is until the 0.23 upgrade).
- program: the IDL's metadata version is still 0.22.0 (the package's too).
