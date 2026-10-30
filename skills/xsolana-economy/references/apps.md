# Building the app for a live economy

Once `xsolana.json` has a `live` section, players use the economy through a page (a game screen, a site, a mint page)
with their own wallet. Use the package's player module, `@xgamesfun/solana/play`: it reads the economy, builds every
transaction, has the player's wallet sign it, sends it and waits for the result. Don't hand-write instructions,
account lists or program addresses.

```bash
npm install @xgamesfun/solana
```

```js
import { solanaApp, walletStandardSigner } from '@xgamesfun/solana/play';

const spec = await (await fetch('./xsolana.json')).json();        // the live spec, served with the page

// Connect a wallet (Phantom, Solflare, Backpack all register through the Wallet Standard).
const wallets = [];
const api = { register: (...w) => { wallets.push(...w); return () => {}; } };
window.addEventListener('wallet-standard:register-wallet', ({ detail }) => detail(api));
window.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: api }));
const wallet = wallets.find((w) => w.chains.some((c) => c.startsWith('solana:')));
const { accounts: [account] } = await wallet.features['standard:connect'].connect();

const app = solanaApp({ spec, rpcUrl: 'https://api.devnet.solana.com', wallet: walletStandardSigner(wallet, account) });

const shop = await app.shop();            // [{ key, name, price, priceUnits, currency, active, left }]
await app.buy('badge', { listing: shop.find((l) => l.key === 'badge') });  // the price shown is the most it pays
const boxes = await app.boxes();          // each box's price and outcome chances
await app.openBox('chest', { listing: boxes.find((l) => l.key === 'chest') }); // pays, waits for the roll, settles
await app.pay('entry');                   // a payment of the spec
const lotteries = await app.lotteries(); // [{ key, name, price, currency, status, round, sold, drawsAt, nftTicket, … }]
await app.buyTickets('weekly', 2, { listing: lotteries.find((l) => l.key === 'weekly') }); // an NFT ticket: { nft: asset, listing }
await app.payNft(asset, { to, reference }); // pay with an NFT (burned, or given to `to`): admit the player by the receipt
await app.stake('farm', '10', 0);         // tokens, at lock tier 0;  app.stakeNft('farm', asset) for a collectible
await app.harvest('farm');                // rewards;  app.unstake('farm', '10') once the lock has run
await app.staked('farm');                 // the player's seats: [{ asset, amount, freeAt, boostPercent, waiting, rewards }]
await app.refresh('guild', asset);        // a farm with growth: writes the NFT's points and level now (anyone may)
const recipes = await app.recipes();      // [{ key, name, active, version }]
await app.craft('merge', [assetA, assetB], 1, { listing: recipes.find((r) => r.key === 'merge') });  // a changed recipe is refused
await app.auctions();                     // each auction: high, nextBid, leading, secondsLeft, open, over, waiting (SOL)
await app.bid('comet', '0.6');           // the bid it tops goes back to its bidder in the same transaction
await app.endAuction('comet');           // once it is over, anyone: the lot to the winner { winner, asset? }
await app.unwrap();                       // SOL back from a bid that was topped, from wrapped SOL to plain SOL
await app.claimGrant('welcome');          // a wallet on the grant's list (or { voucher } from your server)
await app.claimWins({ server, token });   // every prize a results server vouched for or listed, claimed by the winner; [{ round, signature | error }]
                                          // (`token`: the player's sign-in with that server, when it asks for one: a stash drop's NFT is given only at a signed-in claim)
const loan = await app.loanOffer(lender, 1); // a lender's offer: { amount, repay, lasts, risks }: show every risk's `says`
await app.borrow(lender, 1, asset, { acceptRisks: true }); // only once the player saw the risks (refused without it)
for (const c of await app.claims()) await app.claim(c);   // what this player can finish: a roll to collect, a refund,
                                          // a contest payout, a due draw, an auction to end
await app.runSchedule('drip');            // a schedule that is due (anyone may run it); null when not yet
await app.collectibles();                 // what the player owns: [{ asset, item, name, uri, attributes }] (`item`: its key)
await app.balances();                     // what they hold of each of the economy's tokens
```

- **Serving it**: a plain `index.html` with a `<script type="module">` can't import a bare `@xgamesfun/solana/play` by
  itself. Either use a bundler (Vite: `npm create vite@latest`, then `npm install @xgamesfun/solana`), or put this import
  map before the module script and serve the folder (`npx serve .`):
  ```html
  <script type="importmap">{ "imports": {
    "@xgamesfun/solana/play": "./node_modules/@xgamesfun/solana/js/play/index.js",
    "@xgamesfun/solana/client": "./node_modules/@xgamesfun/solana/js/client/index.js"
  } }</script>
  ```
  Tell the person the one command that starts it, and that it serves on devnet.
- **What a roll looks like**: a box of several outcomes is rolled by the oracle a few seconds after the open; `openBox`
  waits for it. Show the player that it is rolling.
- **What an auction looks like**: show the high bid, the least next bid (`nextBid`) and a countdown (`secondsLeft`;
  a late bid moves the end, so read `auctions()` again after every bid). A player who was outbid has their bid back
  already, nothing to claim: in SOL it waits in their wrapped-SOL account (`waiting`), so say "You were outbid:
  0.5 SOL is back in your wallet" and offer `unwrap()` to turn it into plain SOL (any later purchase does it too).
  When `over` is true, show an "End the auction" button to everyone (the winner usually presses it; it mints or
  hands over the lot). There is no deadline: however late it is ended, the lot goes to the highest bidder.
- **NFTs the project has no authority over**: a gate or odds that name a collection find the player's Core NFTs of it
  themselves; for a Token Metadata NFT pass `shown: { mint, owner }`, for a compressed one `shown: { compressed:
  assetId, tree }` after a `loot.proveLeafIx` in the same transaction. `app.stakeNft`, `app.unstakeNft`, `app.refresh`,
  `app.harvest`, `app.hold` and `app.endAuction` take any NFT: a Core asset, a Token Metadata mint (legacy or pNFT),
  or a compressed NFT's asset id; the page finds its kind itself, and proves a compressed one first (its RPC must
  offer DAS: `getAsset`, `getAssetProof`). In a farm that watches, `app.harvest` shows the NFT is still the player's,
  and `app.stakeNft` of an NFT someone else staked and sold takes their seat over. What the project wrote about one is in
  its Sheet (`loot.decodeSheet`).
- **Off-chain traits** (the spec's `traits`): the project builds the tree with `loot.traitsTree([{ nft, attributes
  }])` from its NFTs' metadata and publishes each NFT's `attributes` and `proof` with the page; a player (or the page,
  before a stake) calls `app.proveTraits(nft, attributes, proof)` once per NFT, and its boosts and gates read them.
- **Rolls on an NFT**: `app.openBox(boxKey, { on: asset })` for a box that rolls on one (an enchant). Leaving a
  mission that rolls, `app.unstakeNft` returns `{ signature, roll }`; a recipe that rolls, `app.craft` returns `roll`.
  `app.collect(roll)` asks the oracle when nobody has yet (`app.askRoll`), waits and settles it: show what it gave
  (`won`, each prize the roll set aside, and `order.fate`: the numbers moved and where the NFT went). A page should offer to collect any
  roll of the player's still waiting.
- **What a staking page shows**: `app.staked(farmKey)` lists the player's seats in a farm, each with what it is owed
  now (`waiting`, in `rewards`), the program's own sum from a dry run of the seat (nothing signed or sent), and
  when its lock is over (`freeAt`). Show that; don't work out rewards from the rate yourself (a sharing farm splits
  its pool by weight, and an upkeep or the farm's end stops a seat). Read it when the page opens and after a stake
  or a harvest.
- **Getting out of a farm**: after the farm lock ends, `app.unstakeNft(farmKey, asset)` releases the collectible;
  `app.unstake(farmKey, amount)` returns tokens. If reward transfers are blocked, offer an explicit choice to give
  up rewards with `{ forfeit: true }` as the last argument. Remove a token seat's booster before withdrawing all
  its tokens. Forfeiting does not bypass the lock or the token's or NFT issuer's own controls: say which custody
  the farm uses and never promise an unconditional exit (`telling-the-person.md`, NFT custody).
- **Farm token hooks and Core adapters**: `stake`, `unstake`, `stakeNft`, `unstakeNft`, and `harvest` accept
  `extra` account metas or `transfers` keyed by mint in their options. Static Token-2022 hooks and required memos
  resolve automatically. For dynamic hooks, provide every actual `{ source, destination, authority, amount }`
  transfer: reward pool to vault, then vault to player when the action pays; token principal too when it moves.
  Incoming transfer fees reduce reward credit before calculating the payout. Do not guess amounts from the gross
  pool balance. Without that plan the app fails before signing; refresh the plan if balances or fee terms change.
  Explicit `extra` replaces automatic resolution and must include all hook, memo and Core adapter accounts.
  For example, `app.unstakeNft('heroes', asset, { transfers: { [rewardsMint]: rewardTransfers } })`, or
  `app.unstakeNft('heroes', asset, { extra: adapterAndTokenAccounts })`. Harvest takes options third:
  `app.harvest('heroes', asset, { transfers: { [rewardsMint]: rewardTransfers } })`.
  A forfeit exit skips reward-mint reads and reward ATA creation; principal transfers still need their own mint.
- **Lottery steps**: `claims()` lists a due draw, the completion of its recorded tickets, each place's prize, and,
  for a draw the oracle never answered, the cancel-and-refund (`after-launch.md` says how the money moves). Show each
  as a button and read the list again after each one: a drawn round's tickets must be completed before its winners
  collect.
- **Gates**: a gated buy, ticket, stake, entry, bid or claim finds the player's collectible that passes the gate by
  itself ("You need a Guild Pass to buy this" when there is none). Use `collectibles()` and its `item` key to show
  what a player holds; never match NFTs by name. A list gate (`{ "list": [...] }`) takes the player's proof: the
  page makes it from the wallets xsolana.json lists (`loot.gateList(list).proofOf(wallet)`, which fills the list to a
  power of two as the plan's root does), or takes it from a server that keeps a long list. A stake gate
  (`{ "staked": … }`) needs nothing from the page: js/play passes the player's seat and the farm, and says plainly when
  the stake is too small or its lock is over (show the farm's locked tiers next to the gate).
- **A no-loss lottery** (`noLoss`): completing the draw sends every ticket back to its buyer (anyone may complete
  it, so say "your tickets come back after the draw"), and the winners then collect the pot.
- **A grant that pays by rank**: a voucher with an `amount` (base units of the grant's token) pays that much, up to
  the grant's; `app.claimGrant(key, { voucher })` passes it, and `{ proof, round, personHash, amount }` for a list.
- **The price the player saw is the most they pay**: `app.buy` and `app.openBox` need the listing `shop()` or
  `boxes()` showed (`{ listing }`, or `{ maxPrice }` in base units), `app.craft` the recipe's listing from `recipes()`
  (or its `version`), `app.buyTickets` the lottery's listing from `lotteries()` (or `{ maxPrice }` a ticket), and
  `app.buyListing` and `app.rentListing` the `listing` that `app.listing(asset)` or `app.listings()` showed. Without
  one they refuse; a price (or recipe) that moved since is refused with the new one in words, never paid unseen. Show
  the new price and let the player click again.
- **Loans against an NFT** (a lender's offer with `deal: { Lend }`): show `app.loanOffer(maker, id)` first: what is
  lent, what repays it, by when, and every `risks[i].says`. A loan's token may have a freeze authority, a pause or a
  transfer hook (or a permanent delegate): whoever holds one can make every repayment fail, and a lender who holds one
  can take the NFT when it is due. The program takes such tokens, so `app.borrow` refuses one unless the player
  accepted it (`{ acceptRisks: true }`). Lend in a plain token (SOL, or a mint with no freeze authority) to avoid it.
- **An NFT as the price** (a recipe's `trade` line, a box's `rollsOn` with `then`, a lottery's `ticketNft`): say on the
  page which NFT is spent and where it goes before the player signs; it is spent at once and never refunded.
- **The owner's own wallet on the page**: by default the project's treasury is the owner's wallet. The owner may buy, play
  and unwrap like anyone: a sale whose treasury account was closed opens it again.
- **A buyer's choice**: a share the box, lottery or payment lets the buyer name (`"chosen"`, a referrer; `"chosen:<item>"`, the
  workshop they craft at, not in a payment) comes from the page: `app.buy(key, { listing, chosenRecipient: referrer })`, `app.openBox(key, { listing, chosenRecipient })`,
  `app.buyTickets(key, n, { listing, chosenRecipient })`, `app.pay(key, { chosenRecipient })`. Take a referrer from the link (`?ref=<wallet>`); never let a buyer name
  themselves (the program refuses it, and `app.pay` does). Each method refuses an option it doesn't take (`{ choice }` is
  not `chosenRecipient`). A `"chosen:<item>"` share needs its collectible: offer only ones players hold
  (the program refuses none, one burned, and one the project holds: staked in escrow, held, up for auction).
- **A "Claim" or "Collect" area** built on `claims()` is how players finish what is theirs, and how a due draw gets
  sent. Show it. Read it when the page opens and on a Refresh button, not after every action: it searches the chain
  several times, and devnet's free RPC turns away bursts. After an action, read only what it changed (a balance,
  `collectibles()`), one read at a time, and keep what is on screen when one read fails.
- **Errors** come back as plain sentences (a sold-out item, a gate not met, a price above the most they agreed to):
  show them.
- **Never in a page**: a private key, a keyed RPC link, or anything the authority signs (payouts, minting, rewriting
  a collectible). Those are the owner's or the authority's to sign in their own wallet, or on a server they run.
- **Lower level**: `@xgamesfun/solana/client` has one builder per instruction and the account decoders, for what the
  player module doesn't cover.
