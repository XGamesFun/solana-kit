// What an economy can be made of, read from the schema, and what loot cannot do: the guide an agent reads first.
// Pure.
import { FEES, LAMPORTS_PER_SOL, ORACLE_FEE } from './model.mjs';
import { SCHEMA } from './validate.mjs';
import { IDL } from '../client/ix.js';

const sol = lamports => Number(lamports) / Number(LAMPORTS_PER_SOL);

/** Each part: what it is for, who acts at play time and its fee, and the nested shapes worth showing. */
export const PARTS = {
  tokens: {
    def: 'token',
    says: 'The currencies: SOL, any existing mint by address (classic or Token-2022, coins from a token launchpad or an AMM included), or a token the game makes when it goes live: one the game mints as its rules say (points, tickets, shards, an emission), or one with a fixed `supply` minted once to the owner with minting turned off for good (a community token you keep). loot does not put a token on a market: for trading, launch it on a token launchpad or an AMM, then name the mint.',
    acts: 'nobody: a token is a fact',
  },
  currency: {
    says: 'The key of the token that is the game’s own currency: what the shop is priced in and what the treasury holds. Fixed once live.',
  },
  collection: {
    def: 'collection',
    says: 'The Metaplex Core collection the project’s collectibles are minted into, made at setup; `false` makes none (a project of tokens only). `collections` adds Core collections your wallet already controls (as many as the project’s setup transaction carries, about 25 in all): an NFT of any of them is the project’s own, and an item can be minted into one with its `collection` (once you add the project as an update delegate of it). `projectNumber` numbers the project among your wallet’s (its address is ["project", owner, number]), so one wallet can run several economies.',
  },
  items: {
    def: 'item',
    nested: ['rule'],
    says: 'What the game sells, drops or makes: collectibles (minted to the player, with attributes), and normal items (kept by the project’s backend). A price puts an item in the shop, sold in one step (`buy`: no order, nothing to settle). `{serial}` in its `uri` is each unit’s serial, so each can have its own art.',
    acts: `the player buys (${sol(FEES.player)} SOL player fee), and gets it in the same transaction (a normal item: the project’s backend delivers it from the receipt)`,
  },
  pools: {
    def: 'pool',
    says: 'Vaults the game’s parts pay from (a prize pool, a buyback reserve), which no player can take from. The authority can also move what a pool holds (`move_tokens`, a payout decision), so players trust it with what is in them; a lottery’s pot and what a farm owes its stakers are vaults it can’t touch (a farm’s rewards land in a vault of the farm’s own). `seed` is what the owner puts in at the start.',
    acts: 'nobody directly: other parts fill and drain them',
  },
  stashes: {
    def: 'stash',
    says: 'NFTs the game holds to give away as prizes, of any collection and any kind (Core with or without the game’s authority, Token Metadata legacy and pNFT, compressed): a partner’s NFTs, a treasury’s rare pieces, one artwork to raffle. Your wallet puts in each NFT it lists when the economy goes live (it must hold them then; a compressed one goes in after, with `loot.proveLeafIx` and `loot.stashIx`). A prize { "gives": "nft", "stash": key, "nft": address } gives that one NFT at once (once: the first winner takes it); a box outcome { "gives": "stash", "stash": key } gives one of them at random, taken out at the roll, so two winners never get the same one; a draw that lands on an empty stash isn’t made, and gives back that draw’s worth. Several stashes with weights are rarity tiers. Give each route its own stash when a shop and a raffle must not empty it for each other.',
    acts: `the owner or the authority puts an NFT in or takes one out (${sol(FEES.project)} SOL); anyone settles a roll that won one`,
  },
  boxes: {
    def: 'box',
    nested: ['outcome', 'odds', 'gate', 'rule', 'effect', 'rise', 'fall', 'split', 'perWalletEach'],
    says: 'A paid (or free) roll on chain with MagicBlock’s verifiable randomness, optionally on an NFT (`rollsOn`: an enchant, a mission’s result, a risky forge), whose outcomes then move its numbers (`shifts`) and send it back, burn it or give it away (`then`; a box that can burn or give it away holds it until the roll settles): each outcome gives an item, a fixed prize from a pool, tokens minted (`tokens`), an NFT of a stash (picked at random, or a named one: `nft`), a roll of another box (`roll`), several of these together (`bundle`: { "gives": "bundle", "prizes": [...] }, a pack; it gives all it names or isn’t given, so it names a pool once, a stash’s random NFT beside nothing else of that stash, and two of an item need two left), or nothing. A box of one outcome with nothing random and no NFT it rolls on is bought in one step (`buy`): the price split and what it gives handed over at once, with no order and no oracle. A box takes an NFT as its price through `rollsOn` (which NFTs) and `then` (where the one paid goes: burned, given, or into a stash, a trade-in that becomes another player’s prize). A box is also the prize any route gives: a grant (`gives: { "roll": box }`), a lottery’s place (`{ "percent", "roll" }`), a contest’s winners (`roll`), an auction’s lot (`{ "roll": box }`), a mission’s tier and a recipe roll it for a winner, who gets whatever it gives; such a box is left `active: false`. How long a box can be is what one answer of the oracle’s holds (measured: 128 outcomes that give nothing, 29 of token amounts, 18 each of its own item; 41 slots; 72 odds rules; 16 token prizes or 18 collectibles in one outcome; 340 texts in a gate; fewer where its outcomes name pools or stashes, each search for one’s address counted: sixteen stashes fit 9 draws an open where finding them takes 36 tries): a longer weighted list goes in a table or a stash, drawn by one outcome. A roll is on its written odds whatever is in stock, and `whenOut` says what a draw on an outcome that is out does: "stopSales" (the default) stops selling while one couldn’t be covered, a paid miss gives that draw’s worth back at the settle (with no draw made a paid open fails and is refunded), and a free roll goes back to waiting and is asked again until it hits; "drawLeft" draws among what is left; "giveNothing" keeps selling and a miss gives nothing, paid or free. Odds rules (`odds`) add any percent (99,900 makes an outcome a thousand times likelier; a weight stops at the largest, 4,294,967,295) and count on every route, read when a roll is first asked. A sale in one step sells only while its pools hold every fixed prize. A prize won is set aside for its winner at once. An edit of a box’s roll fails only a purchase still waiting (for its refund); any other roll waiting rolls on the box as edited. A gate (a collectible shown, a few wallets, or a list of any size: `{ "list": [address, …] }`, an allowlist whose proof each player passes) and odds can read what a player shows; `opens`/`closes` time a drop; `perWallet`/`perWalletEach` limit each wallet (one ticket per wallet). A split share "chosen" lets the buyer name a referrer; "chosen:<item>" the holder of a collectible they name (plot rent).',
    acts: `the player opens (${sol(FEES.player)} SOL + ${sol(ORACLE_FEE)} SOL to the oracle); its player, a key they named or the project’s keys settle. Chance that pays money is flagged`,
  },
  payments: {
    def: 'payment',
    nested: ['split'],
    says: 'A player pays for something given off chain (an attempt, an entry, a tip), split up to four ways at once. With `any`, the player chooses the amount, at least `amount` (tips, donations). Its split may name one `"chosen"` share, a wallet the payer names each time they pay (a referrer: `app.pay(key, { chosenRecipient })`), their own too (so a chosen share is at most a rebate the payer controls: price it so); not `"chosen:<item>"`.',
    acts: `the player pays (${sol(FEES.player)} SOL)`,
  },
  recipes: {
    def: 'recipe',
    nested: ['input', 'output'],
    says: 'Collectibles and tokens in, collectibles and tokens out, all or nothing: merges, upgrades, salvage, breeding, exchanges, repairs, a daily claim. Any number of lines; one craft carries what is measured (60 payments in one coin, 26 in different coins, 59 outputs from a pool, 108 raises or needs), and past that a recipe is written but never crafts. Several rolls a craft are taken, each its own order; past 15 the receipts outrun a transaction’s log. `raises` buy a level or a stat on a collectible kept (+1 level for 100 DUST, up to 10), or with `fromNow` move a time (a day of fuel, a day off a lock); a `staked` line takes a collectible only while it is staked in the farm it names (`farm`; a set bound into a badge, its raises moving that farm’s `lockAttribute`), a `show` line takes any NFT of a collection, the project’s or not (its stats live in the project’s Sheet of it), so players can train an NFT the project didn’t make, and a `trade` line takes one and keeps it: burned, given on, or into a stash (`then`), a trade-in. Each `out` line is a prize (the same prize line every route takes: an item, tokens minted or from a pool, a share of a pool, an NFT of a stash, a roll of a box), given in the craft; `{ "gives": "roll", "box": key, "on": place }` rolls on a collectible it keeps (a risky upgrade).',
    acts: `the player crafts (${sol(FEES.player)} SOL)`,
  },
  schedules: {
    def: 'schedule',
    says: 'On a timer: mint a game token into a pool, burn from a pool, move between pools, or pay a wallet, an account, a collectible’s holder, a lottery’s pot ("lottery:<key>") or a farm’s rewards ("farm:<key>"). `start` sets the first run (a cliff), `maxRuns` the last (a vesting of 12 monthly runs), `halveEvery` halves it every N runs; halving with `maxRuns` caps the total for good (an emission with a fixed most). A run missed is missed: one sent late pays once, for the latest run due, and the runs before it lapse; only a sealed schedule’s fixed amount pays every run due. `sealed` (with `fund`): it pays a wallet, the treasury or a burn from a vault of its own that nobody, the owner included, can change, stop or take back; its last run pays what is left. Any number of runs and any end is taken (the checker says a far last run’s date in words); a sealed vault is only as safe as its token (a permanent delegate, a fee its issuer can raise, a freeze), and a payee nobody signs for (a program’s address) is warned of: a multisig vault is fine, an address of the loot program never gets paid.',
    acts: 'the project’s keys, or who it pays, run it when it is due (a sealed one needs nobody else)',
  },
  lotteries: {
    def: 'lottery',
    nested: ['gate', 'rule', 'split'],
    says: 'Tickets sold in rounds, a draw on a timer by the oracle, up to 64 runs of places (a place with `times` is a run of places alike: { "percent": 1, "times": 100 } is a hundred). It names where its places are paid from, exactly one of two, never a default: `"pot": 0` (a number 0 to 15) keeps a pot of its own from round to round (nothing but its winners’ payouts takes from it): each place takes its percent of what the pot holds when the draw is asked, with the round’s ticket money, so `seed`, a sponsor, a share of other sales ("lottery:<key>"), yield and what earlier rounds’ places left all count, and the next round always starts with what the round before left; or `"rest": "<destination>"` pays each round from its own ticket money alone, which nothing from outside can change (no seed, no gifts, no carry-over), and sends what its places leave there ("treasury", "burn", "wallet:<address>", "holder:<collectible>", "account:<token account>", a pool, a farm or another lottery; never "chosen"; a pool, farm or lottery named here counts the leftover only once someone pulls it). `split` sends part of ticket money elsewhere first (a charity, a referrer the buyer names with "chosen", the treasury). Leave out `every` for a raffle that draws once and ends. `perWallet` caps each wallet’s tickets in a round. A place can win a prize instead of (or as well as) its percent: `{ "percent": 0, "prize": { "gives": "nft", "stash": key, "nft": address } }` raffles one NFT, which its winner pulls after the draw (if that NFT is gone from its stash, a stranger’s pull is refused: the winner or a project key passes it over); a lottery that draws once with `nfts` (put in its own stash at go-live) and places { "prize": { "gives": "raffled" }, "times": n } raffles many, each winner drawing one at random; `{ "gives": "roll", "box": key }` makes it a random prize. `ticketNft` ({ "rule", "then" }) makes a ticket cost one NFT instead of tokens: held until the draw, then burned, given on or stashed (back to its buyer if the draw is cancelled; no price, no split). The draw’s ask fixes the round’s money and opens the next round at once; then anyone pulls each part (a refund, a place, a share) in any order, and the last pull closes the round. The owner puts SOL in the lottery at go-live for its rounds’ records and every ticket’s entry (`roundRent`, on by default and sized from `expect`: rounds at once and purchases a round; back at each close), so buyers pay no program rent; 0 turns it off, and then a round’s first buyer fronts its record and each buyer pays their entry’s bytes. `noLoss: true` is a no-loss lottery: every ticket (tokens or an NFT) goes back to its buyer once the round is drawn, and the winners take only the pot, what is paid into it (`seed`, a sponsor, a share of other sales to "lottery:<key>"), or with `rest` only its places’ prizes; no split, no cut, no `ticketCurrency`. `closesBefore` closes sales that long before each draw (less than `every`), and `timeWeighted: true` (no-loss lotteries only) weighs each purchase by its tickets times the seconds from it to the close of sales, so a ticket held longer has a better chance and a late buyer can’t take most of the pot for the fees alone; a buyer is shown what their purchase weighs before they buy. A place of tokens from a pool reads the pool once, when the draw is asked: `whenShort` says what each gets when it holds less than they win ("inOrder", the default: whole prizes, first place first; "inProportion": each the same share; "nothing"); prizes of 1,000, 500 and 500 from a pool holding 1,700 give 1,000, 500 and 0, or 850, 425 and 425, or nothing. Every place paid from one pool says the same. A raffle takes at most 256 places from its own stash, and an NFT ticket’s rule at most 170 "one of" texts.',
    acts: `players buy tickets (${sol(FEES.player)} SOL); anyone draws and pays (free). Flagged as chance`,
  },
  farms: {
    def: 'farm',
    nested: ['tier', 'rule', 'effect', 'growth'],
    says: 'Staking: players stake a token or NFTs of any kind (the game’s, or any collection its gate names: Core, Token Metadata legacy and pNFT, compressed) and share what lands in the farm’s own rewards vault by weight (`rewards` names its token; fund it with `seed`, a share "farm:<key>" or a schedule that pays it; what lands is released to the seats over the farm’s longest lock, a day at least, so a stake earns only while it stays and nobody takes what was funded before them at once), or earn a fixed `rate` a day each (minted, or from the vault while it lasts, as most NFT staking pays; `shared` makes it the whole farm’s a day, shared by weight, and `halveEvery` halves it), with lock tiers (above x0, up to x100) and up to 32 boosts from what a collectible says (each, and all together, up to +100,000%). `growth` writes points (and a level, from `levels`) on a staked collectible for each day in, at its tier and boosts, with nobody’s signature: on the NFT when the game has authority over it, in its Sheet otherwise; a boost per level, a gate, box odds, a recipe’s need or a grant then read that level. A boost counts a level from when it is written, by a seat’s refresh, so a farm whose boost reads what its own growth writes should have its page or a keeper refresh seats (anyone may, for free). A tier’s `prize` (a prize line, as everywhere; give it a `lock`, or one NFT can come and go and take it each time) makes it a mission: a collectible that stays its lock (topped up, not forfeited) leaves with it, given as it leaves: tokens (minted or from a pool, grown by its boosts), an item, an NFT of a stash, or a chest (`{ "gives": "roll", "box": key }`, settled after the oracle). A tier’s `roll` of a box with `rollsOn` is a roll on the NFT leaving it (success, a stat lost, the NFT lost). A collectible can also boost a token seat. `growth` takes up to 32 (+1 "level" and +2 "affection" a day; without `levels` the points are the level; up to 128 levels each), `gate` up to 32 rules an NFT must all pass, and `runs` ends a farm that long after it goes live (a mission open for a week): it takes no stake at its end or after it, nor one whose lock would run past it, and in a farm that shares what lands, what is not released by the end stays in its vault, as does what a seat forfeits after it, so fund it at least its release span before the end. A tier’s `earnsFor` is a term: a seat earns and grows that long after its lock started, and what it earned by then is exact however late it is next touched: nobody has to act at its end. A farm with a term or an upkeep that pays keeps a record of those times: each new one costs whoever writes it 44 bytes of rent (about 0.00022 SOL), not refunded on leaving, 238,312 at most (when it is full, a stake at a new end time waits until older seats are touched), and a farm idle past very many of them is walked in parts first (`app.walkFarm`, anyone’s, free). A farm that mints pays nothing while the project is not the rewards mint’s authority, and what it would have paid then is not owed later. A `rate` of 0 pays nothing: a mission that only grows or gives prizes. Escrow is the default (the game holds the NFT); Freeze locks it in the wallet, with release dependent on Core handling later issuer metadata changes; Watch leaves it free, earning only while its staker holds it, so one NFT can sit in a farm and its missions at once. Soulbound collectibles require Freeze. A farm of collectibles can keep two times on the NFT, as numbers recipes and rolls move: `lockAttribute` (its lock, written as the time it ends: a recipe that raises it by "-1d" `fromNow` for a price is a way out early, a roll that adds "1d" is jail) and `upkeepAttribute` (fuel: it earns and grows only until that time; a recipe sells it "+1d" `fromNow`, up to `upTo` ahead, and it runs out by itself). A recipe reaches a collectible staked in escrow on its seat. Never edited once open: a new mission is a new farm, added to the spec and published.',
    acts: `the player stakes, unstakes and harvests (${sol(FEES.player)} SOL each); pause and suspend do not stop an unstake; external custody controls still apply`,
  },
  contests: {
    def: 'contest',
    nested: ['split', 'gate', 'rule'],
    says: 'Players back a side; the side that wins shares the pot by stake, after the rake, as the pot stands when the side is named: each winner’s part is written then, whatever order they claim in, and anything sent to the pot after it goes to nobody (burned at the close). The authority names it, or a `deciders` key (a results server) signs it, so the authority’s key never sits on a server. One side and a `minPot` is an all-or-nothing crowdfund (short of it, everyone takes their money back); a wallet gate and a `stake` is a 1v1 wager. A contest whose result is overdue is off and pays everyone back. `prize` gives every winning entry a prize too, when it is claimed (a collectible, tokens, an NFT, a roll of a box); one scarce prize goes to the entry claimed first. `stakeNft` (a rule) makes each entry stake one NFT of any kind, compressed ones too, instead of tokens: the NFTs are the pot, each winner takes its own back and picks its share of the losers’ (`losersEach` caps it: 1 for “winner takes one”; 0 sends every loser’s NFT to the opener), and the opener gets what the winners leave. Whoever names the winner can also enter; the pot is paid only by each entry’s claim. A prize to each winning entry with no stake and no gate pays one person with many wallets once a wallet.',
    acts: `the authority opens and decides (${sol(FEES.project)} SOL each); players enter (${sol(FEES.player)} SOL). Flagged as betting`,
  },
  auctions: {
    def: 'auction',
    nested: ['split', 'rule'],
    says: 'An English auction, opened when the economy goes live: the highest bid when the time runs out wins one new unit of an item, any Core NFT the owner holds (give its `collection` when it isn’t the game’s), or a roll of one of the game’s boxes (`{ "roll": box }`, a mystery lot; its price goes to the treasury). Bids in any token, SOL included; each reaches the reserve and tops the last by the least raise; the bid it tops goes back to its bidder at once. A late bid moves the end (`extendBy`, 10 minutes by default; keep it a minute or more, and the least raise `minRaise` 1% or more, or two wallets topping each other in the last seconds keep every other bid out). With no bid the lot goes home; an auction nobody ends waits, and still sells to its high bidder whenever someone ends it. An end pays the seller and gives the lot in one step; an NFT lot that can’t move yet makes the end wait, its winning bid in the project’s vault, until it can or the project’s keys call the sale off (a lot its collection took back or burned sends the bid back). Any time is taken: the checker says a far end’s date in words. `bidNfts` (a rule) makes a bid a bundle of up to three Core or Token Metadata NFTs instead of tokens (never compressed ones: a bid hands the one it tops back at once, and a compressed NFT’s tree can be changed under it): the most NFTs wins, and the reserve counts NFTs.',
    acts: `players bid (${sol(FEES.player)} SOL each); anyone ends it once it is over (free)`,
  },
  holds: {
    def: 'hold',
    says: 'A player hands a collectible to the project for a time they choose (`for`), or until a set time (`until`: a raid at 18:00); until it is up the authority says where it goes, after it anyone sends it home. A hold’s address names its end, so a late award never lands on a later hold of the NFT.',
    acts: `the player hands it in (${sol(FEES.player)} SOL); the authority releases it (${sol(FEES.project)} SOL)`,
  },
  grants: {
    def: 'grant',
    nested: ['gate', 'rule', 'perWalletEach'],
    says: 'Rewards handed out to whoever earned them: a `prize` given in the claim itself (a collectible, tokens minted or from a pool, one NFT of a stash), or a roll of a box (`{ "gives": "roll", "box": key }`: a quest chest, a daily spin, the grant’s funds paying its order). A claim of a prize it can’t give is refused, and keeps its round. Only the winning wallet claims: it signs every claim, whatever proves it won (a voucher, a list, an open grant); anyone may pay its fees, nobody claims for it. A voucher key (a results server: the results server, or one you run) signs who earned it, or one of `keys` (one per promo code: the page signs with the code’s key, and `perKey: 1` pays each code once), or the wallet is on a list. With none of them it is open: any wallet claims within its limits (with a gate, each collectible shown claims once too). The program keeps every claim within its limits per wallet (in all and per window), per person, per key, per day and in total. A grant of a fixed amount of tokens paid by a voucher or a list pays each claim the amount the voucher (or the list’s leaf) names, up to the grant’s own: one grant for rewards by rank or share (1st 500, 2nd 300, …), with the grant’s amount as the most any claim takes; 0 or none named pays the grant’s amount.',
    acts: `anyone sends a claim and pays the ${sol(FEES.player)} SOL player fee; the grant’s funds pay its rent, and the sender what they can’t`,
  },
  decisions: {
    def: 'decision',
    says: 'The authority’s rules in words: what only the game knows (who cleared the level, who won) and what the program then does (a payout, a burn, a mint, a collectible made, rewritten or burned, a held collectible released, a roll).',
    acts: `the authority signs each one (${sol(FEES.project)} SOL)`,
  },
  keys: {
    says: '`authority`: "owner" (the owner’s wallet is both keys) or another wallet’s public address (a server’s). Never a private key.',
  },
  scenario: {
    def: 'scenario',
    says: 'What the quick simulation assumes: how many of each thing a day ("box:flip": 1000), days, how much is staked in each farm.',
  },
};

export const CONVENTIONS = [
  'The file is xsolana.json: { "version": 2, "network": "devnet", … }.',
  'Amounts are whole units of their currency: 0.1 is 0.1 SOL. Write "0.1" as text when it must be exact.',
  'Shares are percents with at most two decimals: 2.5 is 2.5%.',
  'Times are durations ("45s", "30m", "6h", "7d", "2w", or seconds, never milliseconds); a start is "publish", "publish+7d" or a date like "2026-11-01T18:00:00Z". The program takes any time: one that lands more than three years out is warned of with its date in words, so check the unit before signing.',
  'Every part has a `key` (lower case, digits, dashes) that other parts name: a box pays from "pool": "house"; a split sends to "pool:house".',
  `A split is any number of shares of a payment, each { "to": "burn" | "treasury" | "pool:<key>" | "lottery:<key>" | "wallet:<address>" | "account:<token account>" | "holder:<collectible address>" | "chosen" | "chosen:<item>", "percent": n }; what they leave goes to the treasury, and so does a share that can’t be paid (a wallet with no account, a collectible nobody holds): a sale never fails over it.`,
  'The treasury, where what a split leaves goes (and a lottery’s cut), is the owner’s own wallet: the program pays its account of whatever currency was paid, and opens it when it is not there. `"treasury": "wallet:<address>"` makes it another wallet instead (a charity, a team’s multisig vault).',
  'A box’s outcomes each have a `chance` (percents adding up to 100) or each a `weight` (whole numbers). An outcome gives one thing, or a bundle of any number ({ "gives": "bundle", "prizes": [{ "gives": "item", … }, { "gives": "pay", … }] }).',
  'An NFT can be the price: a box’s `rollsOn` and `then`, a recipe’s `trade` line, a lottery’s `ticketNft`, a contest’s `stakeNft`, an auction’s `bidNfts`. Where an NFT paid goes (`then`): "burn", "treasury", { "giveTo": address } or { "stash": key }. A payment with an NFT is a runtime call (`loot.payNftIx`), not a part of the spec.',
  'A prize is one line, the same on every route that gives one (a grant’s `prize`, a lottery place’s `prize`, a contest’s `prize`, a mission tier’s `prize`, a recipe’s `out` lines): { "gives": "item", "item": key } (with `"compressed": true`, a compressed NFT of it: no rent each, minted into a tree the setup opens, `compressedTree`), { "gives": "tokens", "amount": n, "from": "mint" (with "currency") or "pool:<key>": a fixed amount, all of it or none }, { "gives": "nft", "stash": key, "nft": address } or { "gives": "roll", "box": key }. All but a roll are given in the transaction that wins them; use a roll only for chance.',
  'A rule (a gate, odds, a boost) is { "item": key (or left out for any), "attribute": "level", "atLeast": 3 } or { …, "equals": "gold" }, or { …, "time": "ahead" } (a time still to come: fuel left) or "passed" (out of jail), or just an attribute for anything. "oneOf" takes any number of texts (a lottery’s NFT ticket at most 170). A gate may instead list wallets: { "wallets": [address, …] } (at most 16), or { "list": [address, …] } (any size: the program keeps its root, and each player passes their proof), or a stake: { "staked": { "farm": key, "atLeast": n } } (the wallet has at least n of a farm of tokens’ token staked in it and still locked, staked before the second it is used: launchpad tiers, stake to enter. A stake counts only while its tier’s lock runs, so one stake can’t be unstaked, moved to another wallet and count again; a tier with no lock never passes. The app passes the wallet’s seat and the farm).',
  'A box, a shop item and a recipe take `opens` and `closes` (times), and `perWallet` (in all) and `perWalletEach` ({ "count": 1, "every": "1d" }) to limit each wallet.',
  'Leave out `id`, `index`, `shopBox` and `live`: they are written when the economy goes live.',
  'Public data only. A spec never holds a private key or a seed phrase (the checker refuses one, E-SECRET).',
  'Devnet only: "network": "devnet".',
];

/**
 * What no part of loot does, and the combinations that come closest: { what, words (to match a person's own words),
 * why, nearest: [the version, and what it gives up] }. A limit is never the end of the answer: say what is missing,
 * then offer the nearest versions with their numbers, best first, and build the one the person picks. A feature that
 * ships later moves its entry to HOW.
 */
/**
 * What no code removes, only makes smaller: a wallet is not a person, the page can't be trusted, and bots play well.
 * Said once in the guide, so every design starts from it.
 */
export const SAFETY = [
  'A wallet is not a person: wallets are free, so a limit per wallet never limits a person. What bounds a reward is its totals ("perDay", "total": the most it can ever pay), and what makes farming cost something: a gate on holding a collectible the game sells or a locked stake, or vouchers from your server that count people ("perPerson": the voucher signer names a person hash, which needs an outside sign-in such as X; a wallet-only player has none).',
  'Open grants (no voucher, keys or list) pay any wallet: keep their prizes small or soulbound, gate them, and set "perDay". `xsolana_simulate` says what a crowd of wallets could take next to one.',
  'The page can’t be trusted: a game runs in the player’s browser, so a result worth paying is decided or checked by your server, which signs the voucher. A server checks what a wallet holds with `collectiblesOf` / `holds`, pays only wallets a player proved (`proofRequest` / `verifyProof`), and makes promo codes with `makeCodes` (80 bits: a code’s key is public, so a short code can be guessed offline) and `codeAddresses` for the grant’s `keys` (all from `@xgamesfun/solana/results`). How far a signed result can be trusted is what the server checks: it decides the result (runs the game or match; the page sends only inputs), replays it (re-runs the page’s inputs from randomness it keeps), or only bounds it (pace, order, caps: a script at human speed gets through). Say which on each voucher grant (`"trust"`), and run xsolana_review before going live: it says what a cheater gets on every route.',
  'Bots play well: even a verified result pays a bot what it pays a good player. Keep token rewards for results small and capped (a grant’s limits), give SOL prizes only by chance (the oracle) or by what your server decides, and don’t let a minted farm rate run without end into what its token buys (it compounds: give it an end, a term or an upkeep).',
  'A gate costs a sybil most when it asks for something the game sells: a rule takes any of several items (`{ "items": ["oak", "pine"] }`, up to 16), and can read the attributes only the program writes on every minted collectible, `item_id`, `rarity`, `serial` and `made` (`{ "attribute": "rarity", "atLeast": 2 }`: any of the game’s Rare or better).',
];

export const CANNOT = [
  {
    what: 'a prize that is a share of what a pool holds (a jackpot paying a tenth of itself)',
    words: 'jackpot grows growing share percent of the pool tenth prize progressive pot winner takes share of pool',
    why: 'a prize is what its record says, all of it or none, on every route: never what an account holds at the time',
    nearest: [
      'a lottery with a pot ("pot": 0): its pot is what its tickets fill, it grows round by round with what its places leave, and its places take percents of it; gives up a win at any time for a draw on a timer',
      'a fixed prize from a pool a share of each sale fills (`{ "gives": "pay", "pool": key, "amount": n }`); gives up a prize that grows, and a draw that lands on it while the pool is short gives back its worth',
      "a voucher grant that names each claim's own amount, up to the grant's, worked out by the project's server from what the pool holds; gives up the rule living on chain",
    ],
  },
  {
    what: 'put a token on a market (a bonding curve with selling back, trading fees for a creator)',
    words: 'bonding curve market trading fees launch pump.fun meteora swap liquidity sell back creator coin',
    why: 'loot runs no market: it moves and sells what the game owns, it doesn’t trade between strangers',
    nearest: [
      'launch the coin on a token launchpad or an AMM (a launchpad’s creator fees pay on trades), then name its mint as an existing token: loot’s shops, boxes, farms and gates use it; gives up nothing on loot’s side',
      'a shop listing whose price rises after each sale (`rise`), and a recipe that buys the token back at a fixed price from a reserve pool a share of each sale fills (`in`: a `pay` line burned; `out`: tokens from the pool): a one-way curve with a floor; gives up a market price, and the reserve is the authority’s to spend',
      'a game token with a fixed `supply` minted once to the owner, minting off for good: a community token the owner keeps and hands out; gives up a public market',
    ],
  },
  {
    what: 'an order book, an AMM, or a swap two players agree on live',
    words: 'order book amm swap trade trading marketplace market escrow p2p player trades sell to each other offer bid',
    why: 'loot has no order book or matching: a player’s money meets another player’s NFT only through an offer or a listing one of them made first',
    nearest: [
      'a bid any wallet makes for any NFT that passes a rule (“2 SOL for any NFT of another collection”, “50 gold for any level-10 sword”), escrowed in the project’s vault the authority can’t pay from: `openOfferIx` with `deal: { Buy: { price } }` and `left` (how many), `shares` (a royalty, a cut); a holder sells into it with `sellToOfferIx`, the NFT straight to the bidder, the price to the seller; the bidder takes back what is left with `closeOfferIx`. Made from the game’s page at run time, not in xsolana.json',
      'a listing: a holder puts an NFT of any kind up at a fixed price (`openListingIx` with `deal: { Sell: { price } }`, `app.listForSale`); a buyer pays and takes it in one instruction (`takeListingIx`, `app.buyListing`); the maker takes it home with `closeListingIx`. Made from the game’s page at run time',
      'players trade the game’s collectibles on NFT marketplaces that list Metaplex Core assets, with the collection’s royalty to the owner',
      'an auction a player opens for any NFT they hold, signing alone (`openAuctionIx` with an asset lot): escrowed bids, the outbid refunded at once, and at the end the lot to the winner and the price (less any shares) to the seller in one step, so the seller is paid only when the lot arrives; for an NFT of a collection the project does not control, whoever controls that collection can stop it moving or take it back, and the winning bid then waits in the project’s vault until the lot can move or the project’s keys call the sale off (a lot taken back or burned sends the bid back); `bidNfts` makes the bids NFTs (an NFT-for-NFT swap by auction)',
      'a swap against the game: a recipe whose `trade` line takes the player’s NFT into a stash and whose `out` gives a named NFT of a stash (`{ "gives": "nft" }`), or a fixed bundle for another (3 iron → 1 steel); the owner can take stash NFTs out',
    ],
  },
  {
    what: 'a sealed-bid auction (nobody sees the bids until the end), a second-price (Vickrey) auction, or one decided by a random draw per block',
    words: 'sealed blind vickrey second-price hidden',
    why: 'every bid is a public transaction',
    nearest: [
      'an open English auction (`auctions`: every bid public, the highest wins, the outbid refunded at once)',
      'a shop listing whose price falls with time to a floor (a Dutch-style sale)',
    ],
  },
  {
    what: 'lending against tokens, liquidation by price, leverage, perpetuals, options or yield vaults',
    words: 'lend lending borrow loan leverage perp perpetual options vault yield strategy collateral liquidation',
    why: 'there are no price oracles or liquidations in loot: its only loan is a fixed-term loan against an NFT',
    nearest: [
      'a fixed-term loan against an NFT between players, with no trust in the game: a lender opens an offer with `deal: { Lend: { amount, repay, lasts } }` for any NFT that passes a rule; a holder borrows (`borrowIx`: the NFT held by the project, `amount` to them); anyone repays `repay` before it is due (`repayIx`: the money to the lender and the NFT home to the borrower in the same step; with `home: false` the money alone, for an NFT that can’t move right now, and anyone sends it home later with `releaseIx`); no repayment is taken for an NFT its collection took back or burned; unpaid once due, anyone sends it to the lender (`releaseIx` with `to` the lender). No grace period, no partial repayment, no cut of the interest; the lender trusts the NFT’s collection not to block or pull back the NFT. The borrower trusts the loan’s token: whoever holds its freeze authority, a pause, a transfer hook or a permanent delegate can make repaying fail, and a lender who holds one can take the NFT when it is due (the program takes such tokens; `app.loanOffer` names each power and its holder, and `app.borrow` needs `acceptRisks`): lend in SOL or a plain token. Made from the game’s page at run time, not in xsolana.json',
      'a farm whose rewards the game sends into its vault (staking rewards, not interest)',
      'otherwise nothing in loot: say so plainly (leverage, perps and options need a protocol built for them)',
    ],
  },
  {
    what: 'liquid staking receipts or transferable share tokens of a vault',
    words: 'liquid lst xtoken transferable-stake',
    why: 'a token farm’s seat belongs to a wallet and isn’t transferable while staked',
    nearest: [
      'for NFTs, a farm with `custody: "watch"`: the NFT stays free in the wallet, earns while held, can be sold, and its next holder takes the seat over',
      'a token farm with lock tiers and boosts (the stake stays with its wallet)',
    ],
  },
  {
    what: 'paying every holder of a collection without any step by the holder',
    words: 'every-holder dividend dividends snapshot all-holders airdrop-holders',
    why: 'the program pays accounts it is given; it can’t list a collection’s holders by itself',
    nearest: [
      'a farm of the collection with `custody: "watch"` at a fixed `rate`: the NFT never leaves the wallet, earns only while held; holders opt in once',
      'a voucher grant a script signs from a snapshot, each claim its own amount (in proportion to what each holds); a new round each payout',
      'a split share to the holder of one named collectible (`holder:<address>`)',
    ],
  },
  {
    what: 'recurring pulls from a wallet (subscriptions that charge by themselves)',
    words: 'subscription recurring monthly auto-renew auto renew charge every month automatically',
    why: 'nothing takes from a wallet without its signature',
    nearest: [
      'a pass that carries a time (`paid_until`), a renew recipe that raises it 30 days `fromNow` for the price, and gates that read `{ "attribute": "paid_until", "time": "ahead" }`: the member renews in one step, the page reminds them; gives up the automatic charge only',
      'a pass sold again each season as a new item',
    ],
  },
  {
    what: 'a treasury that needs several people to sign (a multisig)',
    words: 'multisig multi-sig 3 of 5 several signers officers council squads dao treasury approval',
    why: 'loot isn’t a multisig, but any wallet can receive and any key can be the spending key',
    nearest: [
      'payments and sales go to a multisig vault: `"treasury": "wallet:<vault>"` or a `wallet:<vault>` share; spending from it needs the vault’s approvals in the multisig’s own app',
      'the multisig vault as `keys.authority`, so moving the game’s pools needs its approvals (sent from the multisig’s own app, not the approve page)',
    ],
  },
  {
    what: 'a ranking the chain works out by itself (the week’s top tipper, a leaderboard)',
    words: 'top-tipper tipper leaderboard top-spender ranking highest-total most-tips biggest-supporter',
    why: 'the program keeps each payment’s receipt and per-NFT numbers, not a ranking of players',
    nearest: [
      'one voucher grant that a script signs from the public receipts, each rank its own amount (1st 500, 2nd 300…)',
      'a running total on chain: a soulbound supporter badge that each tip (a recipe with a `pay` line) `raises`, which gates and odds read with `atLeast` (tiers, not a ranking)',
      'a lottery among the week’s buyers instead of a ranking',
    ],
  },
  {
    what: 'taking anything from a wallet without its owner signing',
    words: 'auto pull charge automatically debit take dues automatically',
    why: 'every move from a player is signed by that player',
    nearest: ['a page where each member pays (a payment per week), and a list of who paid from its receipts'],
  },
  {
    what: 'mainnet',
    words: 'mainnet real money production',
    why: 'the program isn’t audited yet',
    nearest: ['devnet now; mainnet after the audit'],
  },
];

/**
 * Asks that look impossible but are one field or a short combination: { what, words, how }. Shown by xsolana_examples when a
 * person's words match.
 */
export const HOW = [
  {
    what: 'a pity counter that resets on a rare and can’t be traded (gacha pity, a guaranteed legendary by the 90th pull)',
    words: 'pity counter guaranteed hard pity soft pity gacha resets non-transferable soulbound charm',
    how: 'a soulbound collectible each player holds (a charm: `"soulbound": true`, free or cheap, `perWallet` 1) that the pull box rolls on (`"rollsOn": { "item": "charm" }, "then": "back"`): each miss shifts its "pity" attribute by +1 (`shifts`, `upTo` the cap), the rare shifts it by -1000000 (a number never goes below 0, so it resets), and the rare’s `odds` add a percent per point of "pity". It counts per charm, never trades, and resets on a rare; a pity token (a token minted on each miss, spent in a recipe) can be sold and never resets. One pull at a time per charm (the box holds it until the roll settles)',
  },
  {
    what: 'an NFT raffle (a seller raffles one NFT; the winner gets it, the seller the ticket money)',
    words: 'raffle nft raffle sell tickets winner gets nft one-of-one',
    how: 'a lottery with `"raffle": "<NFT address>"` and `"rest": "wallet:<seller>"` (the ticket money, less any cut, to the seller) (or a first place `{ "prize": { "gives": "nft", "nft": "<address>", "held": true } }`): the NFT waits in the lottery’s own stash, which nothing but the draw can empty; the winner pulls it after the draw; `minSold` cancels and refunds a round that sold fewer. A seller runs it as the owner of a project of their own (`app.raffle`)',
  },
  {
    what: 'rent an NFT out (a cabin, a club, a hero for a scholar)',
    words: 'rent rental renter lease borrow use scholarship cabin club hero lend for a week',
    how: 'a listing for rent: `openListingIx` with `deal: { Rent: { price, lasts, max_periods } }` (`app.listForRent`); a renter pays by the period (`app.rentListing`) and is its user until the end; nobody ends it early; the game reads the renter with one account read (`app.rentedTo(asset)`). On-chain gates don’t read rentals: the game checks them',
  },
  {
    what: 'a presale or fair launch: a token split by what each put in',
    words: 'presale fair launch pro rata proportional raise contribute allocation by amount crowdsale ido',
    how: 'a contest with one side, a `minPot`, a split of 100% to the treasury, and a token `prize` with `"split": true`: the whole prize is set aside when it is decided, and each backer claims their part in proportion to what they put in; short of `minPot`, everyone is refunded',
  },
  {
    what: 'vesting nobody can take back (a team’s, an investor’s unlock, a sponsor’s prize stream)',
    words: 'vesting vest unlock cliff team allocation investor locked tokens sealed escrow stream streamflow',
    how: 'a schedule with `"sealed": true`, `"does": "pay"`, `fund`, `start` (the cliff), `every` and `maxRuns`: it pays from a vault of its own that nobody, the owner included, can change, stop or empty; the recipient runs it whenever they like and catches up; its last run pays what is left',
  },
  {
    what: 'leave a stake early for a fee, compounding',
    words: 'early exit unstake penalty exit fee paper hands compound auto-compound',
    how: 'a farm of tokens: a tier’s `exitFee` (percent left to `exitFeeTo`: a burn, a pool, or "rewards", its own vault, shared by the stakers who stay; leaving early keeps the rewards it was credited), and `app.compound(farm)` when rewards are the staked token (the lock keeps running). A farm of collectibles leaves early by a recipe that lowers its `lockAttribute`. loot has no unbonding wait and no harvest tax',
  },
  {
    what: 'different amounts per wallet from a list (points to tokens, monthly vesting by list)',
    words:
      'different amounts points-to-tokens conversion allocation weighted-airdrop pro-rata proportional list amounts monthly',
    how: 'a grant’s `list` entries `{ "wallet", "amount", "round" }`: each claims its own amount (up to the grant’s); the same wallet under another `round` claims again',
  },
  {
    what: 'stake only to qualify (launchpad tiers, stake to enter)',
    words: 'stake to qualify launchpad tier tiers stake gate no rewards stake-to-enter staked qualify allocation',
    how: 'a farm of tokens that nothing funds (no `seed`, no share or schedule sends it anything) and a locked tier, and a gate `{ "staked": { "farm": key, "atLeast": n } }` on a box, item, lottery, contest, auction or grant (counted while its lock runs)',
  },
  {
    what: 'a referral link: a different referrer paid on each sale',
    words: 'referral referrer refer affiliate invite link commission streamer creator-pick',
    how: 'a box’s, shop item’s or lottery’s split share `{ "to": "chosen", "percent": 10 }`: the buyer’s page passes the referrer from the link (`app.buy(key, { listing, chosenRecipient: referrer })`), paid in the same transaction; no server (with none named the share goes to the treasury, so the page makes the choice required). A payment’s split takes a `chosen` share too (`app.pay(key, { chosenRecipient: referrer })`), a wallet only',
  },
  {
    what: 'a share to whoever holds the collectible the buyer picks (rent to the plot built on, a stud fee to the stallion’s owner)',
    words: 'plot land rent landlord stud stallion owner whichever holder per sale',
    how: 'a split share `{ "to": "chosen:<item key>", "percent": 10 }`: the buyer names a collectible of that item and whoever holds it then is paid, in the same transaction, after any resale (the sender opens their account if it is missing). The buyer must name one a player holds: a purchase naming none, or one burned or held by the project (staked in escrow, held, up for auction), is refused (BadChoice), so the page offers only collectibles players hold. Its part goes to the treasury only when the holder can’t take it by the time an order settles (staked in escrow since, or their account frozen)',
  },
  {
    what: 'an all-or-nothing crowdfund with refunds',
    words: 'crowdfund crowdfunding goal kickstarter all-or-nothing pledge backers refund',
    how: 'a contest with one side, a `minPot` (the goal) and a split of 100% to whoever it funds: short of the goal when entries close, every backer claims their pledge back; a contest `prize` gives each backer a badge',
  },
  {
    what: 'money held until someone approves, refunded if nobody does by a deadline (a bounty paid when the work is accepted, a paid DM held until it is answered, a deposit)',
    words: 'escrow held until approve approved accepted refund deadline bounty deposit answered released',
    how: 'a contest with one side, opened for each case, whose split sends the pot to the receiver (`wallet:<address>`, less any fee), decided by the approver (the authority, or a `deciders` key); `resultDue` is the deadline: after it the contest is off by itself and every entry takes its money back (anyone claims it). The receiver is fixed when it opens',
  },
  {
    what: 'limits per wallet: one each, or N a day each',
    words: 'one-per-wallet per-wallet once-a-day daily-limit max-per-wallet one each',
    how: '`perWallet` (in all) and `perWalletEach` (`{ "count": 1, "every": "1d" }`) on items, boxes, recipes and grants (a grant’s list pays each listed entry once: list a wallet again under another `round` to pay it again)',
  },
  {
    what: 'a falling price on its own clock, however many sell (a Dutch drop)',
    words: 'dutch falling price drop every minute goes down fixed clock',
    how: 'a listing’s `fall` (`step`, `every`, `floor`) with `"clock": "shared"`',
  },
  {
    what: 'promo codes and QR claims without a server',
    words: 'promo code coupon redeem qr secret code flyer',
    how: 'a grant with `keys` (one keypair per code, made offline; only public keys go in the spec) and `limits.perKey: 1`: the page derives the key from the typed code and signs for the player’s own wallet. A code used at every visit (one QR at the register) needs a rotating code or a results server',
  },
  {
    what: 'renewing or extending a pass',
    words: 'renew renewal extend membership monthly pass valid until expires',
    how: 'a time attribute on the pass raised by a recipe (`raises`: `{ "key": "paid_until", "by": "30d", "fromNow": true }` with a `pay` line), read by gates with `"time": "ahead"`. An item’s `life.lasts` is read only by recipes, never by gates',
  },
  {
    what: 'a limited number of uses for something a box rolls on (breed a mare 3 times)',
    words: 'breed limit times uses breeding-count three times',
    how: 'a recipe that `use`s the NFT (`life.uses`, `cooldown`: the kit writes them into each recipe that takes the item, as raises of a count of uses and of a time of next use written on the NFT) and gives a permit item; the box `rollsOn` the permit (`then: "burn"`). A box never counts `uses` itself',
  },
  {
    what: 'rewards by rank or by points from one grant',
    words: 'rank ranks top-10 first-second-third leaderboard-payout points-to-tokens',
    how: 'a grant of a fixed amount of tokens paid by vouchers: each voucher names its claim’s amount, up to the grant’s',
  },
  {
    what: 'NFT badges or an airdrop for thousands of wallets without rent for each one (POAPs, attendance, cNFTs)',
    words: 'compressed cnft cnfts bubblegum poap attendance badge badges airdrop thousands cheap mint rent-free',
    how: 'a prize `{ "gives": "item", "item": key, "compressed": true }` (on a grant, a lottery place, a contest, a mission or a recipe): a compressed NFT of the collectible, minted into the project’s tree (`compressedTree.holds`, 16,384 by default; its rent, about 0.23 SOL, paid once at the setup). The setup’s collection takes them when the spec has one before it goes live; not soulbound, not in a box',
  },
  {
    what: 'a no-loss prize draw',
    words: 'no-loss lossless prize-savings never-lose',
    how: 'a lottery with `"noLoss": true` and `"pot": 0`: tickets come back after the draw; the pot is the seed plus what is paid into it (`lottery:<key>` in a split, or a schedule that pays it)',
  },
  {
    what: 'a pack of cards from one purchase (a booster of five, a guaranteed rare, a hand of different cards)',
    words:
      'pack packs booster five cards ten cards guaranteed rare hand deck several items one open gacha pull multi-pull',
    how: 'a box with `"slots"`: each slot so many draws among the outcomes it names (all, when it names none), `"distinct": true` for no outcome twice: `[{ "count": 4, "share": 60 }, { "count": 1, "from": [8, 9, 10], "share": 40 }]` is four cards and a rare. Slots that name outcomes each say what they are worth (`share`, 100 together): a draw that can’t be made gives that much back. All its cards come from one purchase and one oracle answer, and the player may open several packs at once: one wallet prompt. Its order holds a collectible’s rent for each card until it settles; the player or a key they named settles it, in parts when the cards don’t fit one transaction (14 Core cards a part).',
  },
];

function typeOf(node) {
  if (!node) return 'any';
  if (node.$ref) return node.$ref.split('/').pop();
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map(v => JSON.stringify(v)).join(' | ');
  if (node.anyOf ?? node.oneOf) return (node.anyOf ?? node.oneOf).map(typeOf).join(' | ');
  if (node.type === 'object' && node.properties)
    return `{ ${Object.keys(node.properties)
      .map(k => (node.required?.includes(k) ? k : `${k}?`))
      .join(', ')} }`;
  if (node.type === 'array')
    return `list of ${typeOf(node.items)}${node.maxItems ? ` (at most ${node.maxItems})` : ''}`;
  if (node.type === 'integer' || node.type === 'number')
    return `${node.type}${node.minimum !== undefined || node.maximum !== undefined ? ` ${node.minimum ?? ''}..${node.maximum ?? ''}` : ''}`;
  return node.type ?? 'object';
}

function fieldsOf(def) {
  const required = new Set(def.required ?? []);
  return Object.entries(def.properties ?? {}).map(([name, p]) => ({
    name,
    type: typeOf(p),
    ...(required.has(name) ? { required: true } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.description ? { says: p.description } : {}),
  }));
}
const fieldLine = f =>
  `    ${f.name}${f.required ? '*' : ''}: ${f.type}${f.default !== undefined ? ` (default ${JSON.stringify(f.default)})` : ''}${f.says ? ` — ${f.says}` : ''}`;

/** The parts (one, or all) with their fields from the schema. */
export function catalog(only) {
  const defs = SCHEMA.$defs;
  return Object.entries(PARTS)
    .filter(([name]) => !only || name === only)
    .map(([name, p]) => {
      const node = SCHEMA.properties[name];
      const def = p.def ? defs[p.def] : node;
      const nested = (only ? (p.nested ?? []) : []).map(n => ({
        name: n,
        says: defs[n].description ?? '',
        fields: defs[n].type === 'array' ? [{ name: '(list)', type: typeOf(defs[n]) }] : fieldsOf(defs[n]),
      }));
      return {
        part: name,
        type: typeOf(node),
        says: p.says,
        ...(p.acts ? { atPlayTime: p.acts } : {}),
        fields: def?.properties ? fieldsOf(def) : [],
        ...(nested.length ? { nested } : {}),
      };
    });
}

/** The guide in words: every part (or one, with its nested shapes), the conventions and what loot cannot do. */
export function guideText(only) {
  const parts = catalog(only);
  return [
    only
      ? `The part “${only}” of a loot economy (* = required):`
      : `A loot economy is one JSON spec (xsolana.json) on the shared loot program ${IDL.metadata.version}, devnet only. Nobody writes a contract: the spec is checked, simulated, and put live by the owner approving in their own wallet. Its parts (* = required field):`,
    ...parts.flatMap(p => [
      `\n${p.part} (${p.type}): ${p.says}${p.atPlayTime ? `\n  At play time: ${p.atPlayTime}.` : ''}`,
      ...p.fields.map(fieldLine),
      ...(p.nested ?? []).flatMap(n => [`  ${n.name}: ${n.says}`, ...n.fields.map(f => `  ${fieldLine(f)}`)]),
    ]),
    ...(only
      ? []
      : [
          '\nWriting it:',
          ...CONVENTIONS.map(c => `- ${c}`),
          '\nDesigning against farming and cheating (no code removes these; a design makes them small):',
          ...SAFETY.map(x => `- ${x}`),
          '\nAsks that look impossible but are one field or a short combination:',
          ...HOW.map(h => `- ${h.what}: ${h.how}.`),
          '\nWhat no part of loot does (before saying so, try combining the parts above: most ideas are several parts together). Say what is missing, then offer the nearest versions, best first, and build the one the person picks; never end on "it can’t":',
          ...CANNOT.map(c => `- ${c.what} (${c.why}). Nearest: ${c.nearest.join('; or ')}.`),
          `\nFees: ${sol(FEES.player)} SOL once when a player signs for something of their own (a grant's claim too), never again for what follows from it; ${sol(FEES.project)} SOL each time the owner or the authority calls loot, setting up included; ${sol(ORACLE_FEE)} SOL to MagicBlock’s oracle per random roll.`,
          '\nNext: xsolana_examples to find the nearest example, then write the spec and run xsolana_check.',
        ]),
  ].join('\n');
}
