# NFTs and tokens: with authority or without

loot works with NFTs and tokens. What it can do with one depends on one thing: whether the project has authority over
it.

## NFTs

The project has authority over the NFTs of its collection: the Core collection named at `create_project`, where the
project is the collection's update delegate. It mints them (an item's units) and writes their attributes on them. Every other
NFT, a Core asset of any other collection, a Token Metadata NFT or a compressed NFT, it can read but not write.

| NFT | Shown to a rule as | Read | Staked, held or auctioned |
| --- | --- | --- | --- |
| A Core asset the project has authority over | the asset | its attributes | yes |
| Any other Core asset | the asset, then its Sheet's address | its attributes, then its Sheet's over them | yes, by Core's own transfer and freeze |
| A Token Metadata NFT (legacy or pNFT) | its mint, its metadata, the holder's token account of it, its Sheet's address | the collection it is verified in, and its Sheet | yes, by Token Metadata: locked in the wallet (the project its delegate), or moved to the project's token account under its rule set |
| A compressed NFT (Bubblegum v2) | its asset id, its record (`prove_leaf`), its tree, its Sheet's address | the Core collection its leaf names, and its Sheet | yes, by Bubblegum: frozen with the project its delegate, or transferred to the project |

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
delegates) still apply to it, whoever controls them. So a player auctions only an NFT of the project's own collection: a
seller who controlled the lot's collection could make it refuse to move once bids were in, and keep the winning bid
locked. The project's owner or authority may auction an NFT of any kind.

## Tokens

The project has authority over a mint when it is the mint's authority: it mints new tokens and burns them
(`move_tokens` and schedules from `Mint`, a recipe's minted output). A spec's `source: "project"` token starts that way;
one with a fixed `supply` gives the authority up once it is minted.

Every other token (SOL, an existing coin, a project token whose minting is off) the project only moves out of the accounts
it holds: its pools, its vaults for open orders and bids, a farm's or a lottery's vaults. Players move theirs by
signing. Whatever the mint's own authorities can do (freeze, pause, a transfer hook, a fee) still applies to it.
