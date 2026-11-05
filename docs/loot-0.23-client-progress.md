# loot 0.23 in the client: progress

Working note for the `loot-0.23` branch, so the work can resume if interrupted. Delete it once the branch merges.

Program: `gamesfun-loot` `loot-0.23`, plan `docs/plan-0.23.md`. Built against the frozen phase 6 build
(`XSOLANA_PROGRAM_DIR=/tmp/claude-1000/-home-potatoe-Documents-gamesfun-loot/a14430d7-cb8c-462d-a7fb-816dd602a6fa/scratchpad/loot-p6-build`,
`loot.so` sha256 032b0666…). The pins (`js/test/fixtures/pinned.txt`, `release.json`) stay on devnet's 0.22 until the
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
- [~] economy: schema, checker, plan, simulate, cost, explain (places as runs, Raffled, contest cap, shard bits)
- [x] play: lottery, contest, grant, farm, hold flows
- [~] mcp, cli, skill text (mcp tool text done; skill, docs/program.md, CHANGELOG to do)
- [x] tests green

## Client-only items (plan "The client, with no program change")

- [ ] 1 key job rule
- [ ] 2 rolls in one prompt
- [ ] 3 standing lookup tables
- [ ] 4 packing rule
- [ ] 5 owner flows
- [ ] 6 go-live accounts
- [ ] AGENTS.md key rule

## Notes

- Commit 1: the wire (452 tests green against the phase 6 build). Next: tests of the new mechanics (batches, rounds of
  runs, raffles, shards, contest picks), then skill/docs text, then the client-only items.

- program: a lottery's per-wallet count keeps a u32 total of every round's tickets; 2^32 in all refuses that wallet's next purchase (Overflow). The 0.22 receipt kept no total.
- program: a grant's tag (24) is a profile's tag too (sheet.rs PROFILE); decodeAny tells them apart by a profile's shape. A profile of project P passed where a grant is read (Account<Grant>) starts with P as a grant does.
