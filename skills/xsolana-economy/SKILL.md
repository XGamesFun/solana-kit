---
name: xsolana-economy
description: Build a web3, token or NFT economy on Solana without writing a smart contract, on loot, one shared program every project uses. Covers shops, loot boxes and gacha, packs, random NFT and token prizes from a stash of NFTs the project holds, coin flips and prize pools, lotteries and raffles, auctions where the highest bid wins and the outbid get their money back, staking farms with lock tiers and NFT boosts, crafting and merging, seasons and emissions, prediction pools and contests, quests, airdrops and capped rewards, holder-gated drops, and perks or staking for any NFT, whether the project minted it or not. Turns a person's idea into a JSON spec, then checks, simulates and prices it, explains it in plain words, and hands the person the command that puts it live in their own wallet. Use whenever someone asks for anything onchain that players or members pay, earn, stake, open, craft or win, for a game, a community, a creator or a brand, and before writing any Anchor, Rust or Solidity for it.
---

# Build an economy on loot

An economy is one JSON spec (`xsolana.json` in the project) on **loot**, a Solana program every project shares. Nobody
writes or deploys a contract: the spec is checked, simulated and priced by the `xsolana_*` tools, and the project's
owner puts it live by approving in their own wallet. It runs on **devnet** until the program is audited.

The tools are the `xsolana_*` MCP tools. Without MCP, the same from a terminal: `npx -y @xgamesfun/solana@0.20.1 <guide|examples|check|simulate|cost|explain|publish|status> [xsolana.json]`,
or `npx -y @xgamesfun/solana@0.20.1 tool <name> '<json>'` for any tool (always with the exact version).

## Rules (always)

1. **Never write, build or deploy a program.** No Anchor, Rust, Solidity or custom program, and no deploy: not by you,
   not by a command or page you give the person, not even "just on devnet". Unaudited code holding people's money is
   the risk loot exists to remove. If the idea needs something loot can't do, follow rule 9.
2. **You never sign, and you never ask for or handle a key.** No private key, seed phrase or keypair file: not in
   chat, not in a spec, not in a file. Going live is the person running `xsolana approve` and approving in their own
   wallet. If they paste a key, tell them to treat it as exposed and move its funds; write it nowhere.
3. **Devnet only.** Nothing here is real money yet; say so.
4. **The checker decides.** Never save or publish a spec with refusals. Fix each refusal the way its `fix` says.
5. **Numbers come from the tools.** What a box gives back, how long a pool lasts, what going live costs: quote
   `xsolana_simulate`, `xsolana_cost` and `xsolana_explain`, never your own arithmetic. What a player pays is the tools'
   "in all" number for that action (price, fee, oracle, network and rent that never comes back): quote it as is.
6. **Flag the law.** When the checker raises `W-CHANCE-PRIZE` (paid chance at money: boxes with prizes, lotteries,
   contests), `W-CHANCE-ITEMS` (paid random collectibles a player can resell: loot boxes, gacha) or `W-REVENUE-SHARE` (stakers paid from sales), tell the person in plain words, every time, and never
   call anything an investment, a return or passive income. For an auction, always say `W-AUCTION-SHILL`: anyone,
   the seller included, can bid to push the price up. Before they go live, say as well that the program is not
   independently audited and comes as is, with no warranty: they use it at their own risk, and making sure the
   economy is legal where it is offered is theirs. Never promise it is safe, and never give legal advice.
7. **Take addresses from the tools, never from memory**: the program, its accounts, the IDL. Every answer names them.
8. **Public data only in a spec**: names, prices, percents, public addresses. Leave out `id`, `index`, `shopBox`,
   `rewardsIndex` and `live`: they are written when it goes live.
9. **Compose before you say no.** Most ideas are several parts working together, not one part. Before calling
   anything a limit, break the idea into its pieces (what players pay, what they get, what is random, what the chain
   can't see, what is held and for how long, who is paid) and find the part for each (`references/sentence-to-spec.md`).
   What the chain can't see (a match, a score, something done offline) is vouched for by a signer: a results server's voucher, a
   decider's key, a list. Build the combination and say which part does which piece. When the tools' words and the
   checker disagree (a field the schema takes that a sentence somewhere calls impossible), the checker and
   `xsolana_guide`'s parts decide: try it in a spec and run `xsolana_check`.
   A piece is a limit only when no part or combination does it. Then:
   - say in one line what is missing and why;
   - offer the nearest versions (`xsolana_examples` with the words of that piece returns them), best first, each with
     what it gives up and its "in all" cost; recommend one, and build it;
   - if they push back, offer the next version or a change that brings back what they miss (a price, a bundle, a
     second step). Don't withdraw a draft that checks, and don't send them elsewhere while a version on loot is on the
     table.

10. **People finish what follows; build the button, not a server.** Every step after a player's ask (settle a roll,
   draw a lottery, complete its tickets and pay its places, refund a draw the oracle never answered, claim a win, end
   an auction, take unbonded tokens out, run a sealed schedule, take a rental's NFT home) can be sent by anyone, and
   the person who gains from it sends it from the page (`app.claims()` lists them, `app.claim(c)` sends one). A
   grant's claim is the winner's alone: the winning wallet signs it, whatever proves it won; anyone may pay its fees,
   nobody claims for a player. loot needs no server to finish anything. Never make a key in a page or a server for
   the owner to fund: whoever signs pays.

## The loop

1. **Read what an economy can be made of**: `xsolana_guide` (every part and field, who acts and what it costs, what
   loot cannot do). `{"part": "farms"}` for one part's nested shapes.
2. **Start from the nearest example**: `xsolana_examples {"query": "<the person's own words>"}`, then
   `xsolana_examples {"name": "<example>"}` for a whole spec to copy. The rated economies say how each real economy
   fits (great, some, a-lot, cannot) and what carries it.
3. **Write the spec** from their sentence: `references/sentence-to-spec.md` maps their words to parts. Keep their
   sentence in `prompt`. Add a `scenario` with the counts they expect (how many opens a day).
4. **Check it**: `xsolana_check {"spec": …}`. Fix every refusal; every warning is something to tell the person, in a
   sentence of its own.
5. **Simulate and explain it**: `xsolana_simulate`, then `xsolana_explain`. Tell the person, in a few short lines, what each
   play costs and is worth, where the money goes, how the pools fill and drain, what going live costs, what the
   authority must sign while it runs, and the flags: `references/telling-the-person.md`. Before they approve, say who
   sends each step while it runs (a draw, a payout, a contest's result) and what happens if nobody does:
   `references/after-launch.md`.
   Prizes: give a known prize directly on whatever route wins it (a grant, a lottery place, a contest, a mission, a
   recipe): one step, no oracle. Use a roll of a box only for chance. Every other shape (bundles, an NFT as the price,
   stashes, gates, no-loss lotteries, amounts by rank) is in `references/sentence-to-spec.md` and `xsolana_guide`.
6. **Iterate on what they say.** "Make legendaries 0.5%", "a bigger seed": change, check, simulate, explain again.
7. **Save it**: `xsolana_save {"spec": …}` writes `xsolana.json`, only if it checks. A live file keeps its program numbers.
8. **When they say "put it live"**: `xsolana_publish` lists every step and its cost and gives the command. Tell them to
   run it themselves in the project folder, exactly as `xsolana_publish` gives it (it names the exact version:
   `npx -y @xgamesfun/solana@0.20.1 approve xsolana.json`; never drop the version). It opens a page on their computer where
   they connect a devnet wallet and approve; what lands is written back into `xsolana.json`. You publish nothing.
9. **After it is live**: `xsolana_status` shows each part on chain; read it before acting on what the person says
   happened. A later change is the same loop: save, publish, and the approval sends only what changed. What only the
   owner signs (open or decide a contest, pay out) goes on an owner page they approve in their own wallet:
   `references/after-launch.md`.

## Building the app around it

A game, a site or a bot calls the live economy with the player's own wallet, through the package's player module
(`@xgamesfun/solana/play`: buy, open a box and collect the roll, pay, stake, compound and withdraw, craft, bid and end an
auction, list an NFT for sale or for rent and read who rents it, raffle an NFT, claim what a player is owed, run what
is due, list what a player owns). Pages call `claims()` when they open and show each as a button.
`references/apps.md` shows a whole page; `xsolana_client` gives the program and the calls. Never invent account layouts,
instruction data or addresses, and never put a key or the authority's actions in a page players load.
For staking an NFT of another collection, show what custody means and get explicit acceptance before sending.

## More

- From a sentence to a spec, with a worked example: `references/sentence-to-spec.md`
- Telling the person what they get: `references/telling-the-person.md`
- Building the app for a live economy: `references/apps.md`
- After it goes live (who sends each step, owner pages, results from a game, a results server): `references/after-launch.md`
