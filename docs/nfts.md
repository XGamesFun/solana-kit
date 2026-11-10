# NFTs and tokens: with authority or without

loot works with NFTs and tokens. What it can do with one depends on one thing: whether the project has authority over
it.

## NFTs

The project has authority over the NFTs of its collection: the Core collection named at `create_project`, where the
project is the collection's update authority, or one of its update delegates. A project that is only a delegate trusts
its partner: anyone who can write to that collection (its owner, and every other delegate they named) can mint an NFT
there that reads as any of the project's items, passing the project's gates, boosts and odds for that item and taking
its missions' prizes, and can take the project's access away at any time. Two projects that name one shared collection
read each other's items of the same number as their own. Name only a collection whose every writer the project trusts. It mints them (an item's units) and writes their attributes on them. Every other
NFT, a Core asset of any other collection, a Token Metadata NFT or a compressed NFT, it can read but not write.

| NFT                                         | Shown to a rule as                                                            | Read                                              | Staked, held or auctioned                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A Core asset the project has authority over | the asset                                                                     | its attributes                                    | yes                                                                                                                                 |
| Any other Core asset                        | the asset, then its Sheet's address                                           | its attributes, then its Sheet's over them        | yes, by Core's own transfer and freeze                                                                                              |
| A Token Metadata NFT (legacy or pNFT)       | its mint, its metadata, the holder's token account of it, its Sheet's address | the collection it is verified in, and its Sheet   | yes, by Token Metadata: locked in the wallet (the project its delegate), or moved to the project's token account under its rule set |
| A compressed NFT (Bubblegum v2)             | its asset id, its record (`prove_leaf`), its tree, its Sheet's address        | the Core collection its leaf names, and its Sheet | yes, by Bubblegum: frozen with the project its delegate, or transferred to the project                                              |

A route that stakes, holds or auctions an NFT takes its accounts as a `Piece`; the client builds one for any kind (`loot.piece`). A compressed NFT's leaf comes from an indexer (DAS `getAsset` and
`getAssetProof`, read into shape by `loot.compressedFromDas`) and is proven in the same transaction
(`loot.proveLeafIx`): a record reads as nothing proven once its tree has changed since, and anyone may then close it,
its rent back to whoever paid it. Compressed NFTs of v1 trees are refused.

A rule names what it is about (`Of`): any NFT of a collection (`Collection`), or the NFTs of an item the project mints
(`Item`, only in the collection it has authority over, since only there does the program write `item_id`).

**What is written on an NFT counts as it is.** Whoever its collection lets write its attributes (its maker, or even
its holder) decides what a gate or a boost reads. That is the project's choice of collection, not the program's.

**What the project writes about an NFT it has no authority over is in its Sheet**, `["sheet", project, nft]`: the
attributes the authority wrote with `collectible` `Set` (a level, a use). The authority pays its rent; it stays with
the NFT whoever holds it, and never closes. It holds no owner: who holds the NFT is read from the NFT each time. An
NFT shown without its own Sheet passes nothing, and a farm seat's refresh without it is refused, so leaving it out
never reads better. A farm's growth writes there too, and so does anyone proving the off-chain traits the project vouched
for (`set_traits` once, then `prove_traits` per NFT: a background a boost reads).

**Custody: locked, held, or watched.** A farm keeps an NFT locked in its wallet (`Freeze`), handed to the project
(`Escrow`), or left free and watched (`Watch`: it earns only while its staker holds it). A frozen or watched NFT can
sit in several farms at once: a guild it stays in, and missions beside it.

**A roll on an NFT** (an enchant, a mission's result, a risky forge) works on every kind: its numbers move where the
project may write them (on the NFT, or in its Sheet). A roll that can lose the NFT holds it from the roll to the settle,
then sends it back, gives it away, or burns it: a Core asset by Core, any other kind sent to the incinerator's address
(`1nc1nerator11111111111111111111111111111111`), where nobody can ever move it. A soulbound NFT can't be lost: it is
rolled where it is. A recipe's roll that can lose the NFT takes only a Core asset of the project's collection.

**Custody follows the NFT's own rules.** Staked, held or auctioned, an NFT moves or locks by its own program (Core,
Token Metadata, Bubblegum), and its collection's controls (royalty rules, a pNFT's rule set, oracles, permanent
delegates) still apply to it, whoever controls them. The creator of an NFT with a permanent delegate can pull it back
out of a hold, a stake, a loan or a listing, and a record it leaves behind can later take the next owner's deposit of
the same NFT: before a deposit, an app looks for this project's records that name the NFT (a listing at
`["listing", project, asset]`, holds by the asset's address) and warns when one is left from an earlier owner.

**Any NFT can be auctioned**, a player's too. The seller is paid only when the lot reaches the winner: while the lot
can't move (its collection froze it) the winning bid waits in the project's vault, until it can or until the project's
keys call the sale off, and a lot taken back or burned sends the bid back. So a bidder's money can be tied up, not
lost: tell every bidder, before a bid, when the lot is outside the project's collections.

**A loan's NFT that is gone** (taken back or burned by whoever controls its collection while the project held it) can't
be repaid: the borrower keeps what they borrowed, the lender's release at the due date fails, and the loan's record
stays open with the borrower's rent in it. A hold can outlive its NFT the same way (a lottery place's NFT, a contest's,
an outbid NFT bid, a loan's): its receipt says the NFT is held for the player when it is not, and nothing was paid
against it. The results server and the kit read the NFT's owner and flag such a hold.

## Tokens

The project has authority over a mint when it is the mint's authority: it mints new tokens and burns them
(`move_tokens` and schedules from `Mint`, a recipe's minted output). A spec's `source: "project"` token starts that way;
one with a fixed `supply` gives the authority up once it is minted.

Every other token (SOL, an existing coin, a project token whose minting is off) the project only moves out of the accounts
it holds: its pools, its vaults for open orders and bids, a farm's or a lottery's vaults. Players move theirs by
signing. Whatever the mint's own authorities can do (freeze, pause, a transfer hook, a fee) still applies to it.
