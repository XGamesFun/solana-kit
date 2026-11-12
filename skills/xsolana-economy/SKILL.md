---
name: xsolana-economy
description: Build a web3, token or NFT economy on Solana without writing a smart contract, on loot, one shared program every project uses. Covers shops, loot boxes and gacha, packs, random NFT and token prizes from a stash of NFTs the project holds, coin flips and prize pools, lotteries and raffles, auctions where the highest bid wins and the outbid get their money back, staking farms with lock tiers and NFT boosts, crafting and merging, seasons and emissions, prediction pools and contests, quests, airdrops and capped rewards, holder-gated drops, and perks or staking for any NFT, whether the project minted it or not. Turns a person's idea into a JSON spec, then checks, simulates and prices it, explains it in plain words, and puts it live with a key file on their own machine, after their yes. Use whenever someone asks for anything onchain that players or members pay, earn, stake, open, craft or win, for a game, a community, a creator or a brand, and before writing any Anchor, Rust or Solidity for it.
---

# Build an economy on loot

An economy is one JSON spec (`xsolana.json` in the project) on **loot**, a Solana program every project shares. Nobody
writes or deploys a contract: the `xsolana_*` tools check, simulate and price the spec, and it goes live signed by a
key file on the owner's own machine, once they have read what will be sent and said yes. It runs on **devnet**, where
nothing is real money, and on **mainnet**, where everything is: an economy is on devnet unless its file says
`"network": "mainnet"`.

The tools: `xsolana_guide`, `xsolana_examples`, `xsolana_check`, `xsolana_design`, `xsolana_simulate`, `xsolana_cost`,
`xsolana_explain`, `xsolana_review`, `xsolana_save`, `xsolana_publish`, `xsolana_status`, `xsolana_token`,
`xsolana_client`. From a terminal, always with the exact version:
`npx -y @xgamesfun/solana@0.28.20 <guide|examples|check|simulate|cost|explain|review|publish|status> [xsolana.json]`,
`npx -y @xgamesfun/solana@0.28.20 token <mint>`, or `npx -y @xgamesfun/solana@0.28.20 tool <name> '<json>'` for any
tool (`xsolana_design` too).

The tools' outputs say how to put each result to the person at the moment you need it: read them and follow them.

## Rules (always)

1. **Never write, build or deploy a program.** No Anchor, Rust, Solidity or custom program, and no deploy: not by you,
   not by a command or page you give the person, not even "just on devnet". Unaudited code holding people's money is
   the risk loot exists to remove. If the idea needs something loot can't do, follow rule 9.
2. **Going live is signed by a key file on the person's own machine, after their yes; you never ask for, read or
   print a key, and you open no signing page.** Whoever holds a key controls what it owns, so a key that passes
   through a chat, a spec or a page is lost. `xsolana keygen <file>` makes the project's key file (outside any
   repository, unless git ignores it there; it prints the address, never the key). Only the tools read it:
   `xsolana approve <spec> --keypair <file>` prints everything it would send and sends nothing until it is run again
   with the code it printed, which you do only after the person has read that printout and said yes; and, for what
   only the authority signs later, `readKeyFile` in a script (`references/after-launch.md`). A key file is the safer
   way to set up: a new key that has held nothing, so the wallet holding what the person owns never signs; but
   anything on the machine that can read the file can sign as the project. Never open,
   copy or print it, and never put it in a chat, a spec, a repository or a page. Never ask for a seed phrase or the
   key of a wallet the person already has; if they paste one, tell them to treat it as exposed and move its funds,
   and write it nowhere. The browser-wallet page (`xsolana approve <spec> --browser`) is only for a person who asks
   for it, and they run it themselves.
3. **Devnet first; mainnet only on the person's own word.** Build, check and try every economy on devnet, and say
   that nothing there is real money. Write `"network": "mainnet"` only when the person asks for mainnet in their own
   words, because there every mistake costs real money. Tell them then, before anything is sent: it is real money,
   loot has not been independently audited, what is sent can be lost, what the review found, and the legal flags
   again.
4. **The checker decides.** Save or publish no spec with refusals; fix each refusal the way its `fix` says.
5. **Numbers come from the tools.** What a box gives back, how long a pool lasts, what going live costs, what a player
   pays "in all", every count of approvals: quote `xsolana_check`, `xsolana_simulate`, `xsolana_cost` and
   `xsolana_explain`, not your own arithmetic.
6. **Each warning reaches the person once.** Every warning the checker gives goes to the person, once, with its fix
   and your pick. Legal and trust facts go as written, because other words could claim more or less than is true: the
   law's lines (`xsolana_check` prints them under "The law"), once when the checker first raises each and again before
   mainnet, and not in pages or apps unless asked; what a cheater gets and what a leaked key can take. Every other
   line you put in your own words, keeping every number and dropping none. On the law, answer what you know and leave
   the rest to their lawyer: you are not one. Don't call anything an investment, a return or passive income, or
   promise it is safe: that is the claim that turns a game into a security or a scam. What `xsolana approve` prints
   shows the flags and that the program is not audited and comes as is; the person reads it before their yes.
7. **Take addresses from the tools**: the program, its accounts, the IDL. An address from memory can send money to
   the wrong place.
8. **Public data only in a spec**: names, prices, percents, public addresses. Leave out `id`, `index`, `shopBox` and
   `live`: they are written when it goes live.
9. **Challenge before you build.** For every request, name the simplest version that delivers most of it. Say what
   it gives up and what the asked-for version costs: wallet prompts, moving parts, failure states, who must act
   later. Recommend one, and build the asked-for version only after the person has seen that trade and still wants
   it. Better means, in this order: plays best (fewest approvals, waits and tokens to learn, nothing a new player
   needs before the first reward), then cleanest, then most secure. Use an on-chain guard when it is clear and costs
   the player nothing; otherwise keep the rule on the server, say so plainly and name the trade. Walk it as a
   first-time player on a phone: from the link to the first reward, what they need first, every wait, every prompt,
   what they see when something fails or ends. Challenge economy, flow and irreversible choices (a burn, a token
   that can't move, a payment taken before the outcome); don't challenge taste.
   The tools do the analysis: `xsolana_check` follows the value (`W-VALUE`), a player's loop (`W-STEPS`), what rests
   on who takes part (`W-ASSUMPTION`, with the questions to ask) and who decides what (`W-ENFORCED`);
   `xsolana_explain` walks each route state by state. Read both before you answer.
   Composing parts is how you find the versions: break the idea into what players pay, what they get, what is
   random, what the chain can't see, what is held and for how long, and who is paid, and find the part for each
   (`references/sentence-to-spec.md`). What the chain can't see (a match, a score) is vouched for by a signer: the
   program checks the signature and limits, not what happened (rule 12). When a sentence and the checker disagree,
   try it in a spec: the checker decides. A piece is a limit only when no part or combination does it:
   say in one line what is missing and why, and offer the nearest versions (`xsolana_examples` with that piece's
   words), best first, each with what it gives up and its "in all" cost. Don't promise a report, a follow-up or a
   channel you don't have.
10. **Design for many wallets and bots.** Wallets are free and bots play well: bound every reward with totals where
    the bound costs real players nothing (`perDay`, `total`; a tighter one belongs on the server), gate open rewards
    on holding something or count people by vouchers (`perPerson`, the server naming an X account, not a wallet),
    keep token rewards for results small, and have a server decide or replay a result worth paying
    (`@xgamesfun/solana/results`). Keep entry fees and prize pools for results the server decides and for chance, and
    give a minted farm an end. Price each measure by what a failed attempt costs a script. A short secret (a code, a PIN) stored as a plain hash is reversed by trying every value: hash it with a key, or
    keep it in the server's secret store. `references/trust-and-cheating.md` says why.
11. **Say who finishes each step, and let the person choose.** Every step after a player's ask (settle a roll, draw
    a lottery, refund, claim a win, end an auction, run a schedule) waits until someone sends it; `xsolana_explain`
    names who may, who pays and what happens if nobody does. Either **a button on the page** for whoever gains from it
    (`app.claims()`: no server or key, but it waits for a visitor) or **a key on a server** that sends on time
    (whoever breaks in can use it, and the owner funds its fees: keep it small and capped). Put both when timing
    matters, and build what they choose.
12. **Review before going live, and let the person choose the trade-off.** Run `xsolana_review` before the owner
    approves, and again after every change to a route that pays. Fix every high finding, or have the person accept it
    in plain words. Declare `"trust"` honestly on every voucher grant: `"decides"` (the server runs the game),
    `"replays"` (it re-runs the page's inputs) or `"bounds"` (it takes the page's word within caps). Then tell the person, for each signed route, its level, what a cheater
    gets (the review's ceiling) and what the stronger level would cost. They choose; leaving it out chooses for them.
    `references/trust-and-cheating.md` has the levels and the checklist.

## The loop

1. **`xsolana_guide`** returns a short index: the loop, every part and topic and when to fetch it. Fetch the part you
   need (`{"part": "lotteries"}`), and `{"part": "writing"}` before your first spec.
2. **`xsolana_examples {"query": "<the person's own words>"}`**, then `{"name": "<example>"}` for a whole spec to
   copy. The rated economies say how each real economy fits (great, some, a-lot, cannot) and what carries it.
3. **`xsolana_design`** when no single part does what they ask, or their wants pull against each other (a draw, a
   sale, a reward, staking or a contest): write each want as a requirement on its route. It builds and checks every
   known way and says what each keeps and gives up. When nothing keeps everything, the choice is the person's: put
   every option with its "Say" sentence as written and your pick, and end your turn there. Run it again when a want,
   a route or the odds of an ending change. Routes it doesn't cover (an auction, a schedule, a hold) you draft.
4. **Write the spec** from their sentence (`references/sentence-to-spec.md`). Keep their sentence in `prompt`; add a
   `scenario` with the counts they expect.
5. **`xsolana_check`** after every change. **Check before you describe**: before you tell the person how value moves
   (a burn, a free token, a swap, a refund, a payment held or not), check one draft with it once and read its lines.
   One draft, checked once: not every variant, and not at the cost of the conversation. An idea of your own is
   offered only once a draft with it checks.
6. **`xsolana_simulate`, `xsolana_explain`, `xsolana_cost`**, then tell the person what each play costs and is worth,
   where the money goes and what going live costs (`references/telling-the-person.md`), and who sends each step while
   it runs (`references/after-launch.md`).
7. **Iterate** on what they say: change, check, simulate, explain again.
8. **`xsolana_save`** writes `xsolana.json`, only if it checks. A live file keeps its program numbers.
9. **`xsolana_review`** before they approve (rule 12).
10. **When they say "put it live"**: `xsolana_publish` lists every step and its cost and gives the commands, with
    what to tell the person about the key file, its treasury and what must be at its address first. Run them in the
    project folder exactly as given, with their exact version: `keygen` for a new economy's key file (give the person
    the address it prints), then `approve … --keypair <file>`, which prints everything and sends nothing. Give the
    person that printout as it is, not a summary, and ask; only on their yes, the same command with `--yes <code>`.
    A change to a live economy is signed by the key that owns it, since loot lets only the owner change it: never
    make a new key for it, and never remove the file's live section because a key was refused; ask how it went live.
    The browser-wallet page only when they ask for one, or a browser wallet owns the project: they run it themselves.
11. **After it is live**: `xsolana_status` shows each part on chain; read it before acting on what the person says
    happened. A later change is the same loop, and `approve` sends only what changed. What only the authority signs
    while it runs is signed where its key is (`references/after-launch.md`).

## When they ask for a token

"A token for my game" is one of four things (points the game mints, a fixed supply the owner hands out, a coin on a
market, a coin that exists): find out which from what it is for, before writing anything, with
`references/sentence-to-spec.md` ("When they ask for a token"). A coin that exists is read with `xsolana_token`,
never typed by hand: a wrong mint or decimals moves the wrong money.

## Building the app around it

A page uses the live economy with the player's own wallet through `@xgamesfun/solana/play` and shows `claims()` as
buttons (`references/apps.md`; `xsolana_client` gives the program and the calls). Keep every key and the authority's
actions out of a page players load: anyone can read a page. Before staking an NFT of another collection, show what
custody means and get explicit acceptance.

## More

- From a sentence to a spec, with a worked example: `references/sentence-to-spec.md`
- Telling the person what they get, and what stays the project's job: `references/telling-the-person.md`
- Building the app for a live economy: `references/apps.md`
- After it goes live (who sends each step, owner pages, results from a game): `references/after-launch.md`
- What a server decides, replays or bounds, who gets paid, and the exploit checklist: `references/trust-and-cheating.md`
