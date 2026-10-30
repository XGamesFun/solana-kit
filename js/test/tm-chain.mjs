// Token Metadata NFTs on the local chain, for the client's tests: the real Token Metadata program as mainnet runs it
// (`js/test/fixtures/token_metadata.so`, pinned), a maker's sized collection, and legacy NFTs verified in it.
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import { SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit, meta } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { newAddress } from '../sim/chain.mjs';
import { pinned, world } from './world.mjs';

const TM = loot.TOKEN_METADATA_PROGRAM;
const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
const some = (bytes) => concat(Uint8Array.of(1), bytes);
const NONE = Uint8Array.of(0);

/** Token Metadata's CreateV1 (42, 0) of a NonFungible: `collection` an unverified one it names, or a sized collection. */
function createV1({ mint, maker, name, collection = null, sized = false }) {
  const data = concat(
    Uint8Array.of(42, 0),
    str(name), str('OUT'), str('https://example.invalid/nft.json'), uintLE(500, 2),
    some(concat(uintLE(1, 4), addressBytes(maker), Uint8Array.of(1, 100))), // one creator, verified (the maker signs)
    Uint8Array.of(0, 1), // primary sale not happened, mutable
    Uint8Array.of(0), // TokenStandard::NonFungible
    collection ? some(concat(Uint8Array.of(0), addressBytes(collection))) : NONE,
    NONE, // uses
    sized ? some(concat(Uint8Array.of(0), uintLE(0, 8))) : NONE, // CollectionDetails::V1 { size: 0 }
    NONE, // rule set
    NONE, // decimals
    some(Uint8Array.of(0)), // PrintSupply::Zero
  );
  return {
    programId: TM,
    keys: [
      meta(loot.tokenMetadata.metadata(mint), false, true), meta(loot.tokenMetadata.edition(mint), false, true), meta(mint, true, true),
      meta(maker, true, false), meta(maker, true, true), meta(maker, true, false),
      meta(SYSTEM_PROGRAM, false, false), meta(SYSVAR_INSTRUCTIONS, false, false), meta(TOKEN_PROGRAM, false, false),
    ],
    data,
  };
}

/** Token Metadata's MintV1 (43, 0): the one token of `mint` into `owner`'s associated account. */
function mintV1({ mint, maker, owner }) {
  return {
    programId: TM,
    keys: [
      meta(loot.ata(owner, mint), false, true), meta(owner, false, false), meta(loot.tokenMetadata.metadata(mint), false, true),
      meta(loot.tokenMetadata.edition(mint), false, true), meta(TM, false, false), meta(mint, false, true), meta(maker, true, false),
      meta(TM, false, false), meta(maker, true, true), meta(SYSTEM_PROGRAM, false, false), meta(SYSVAR_INSTRUCTIONS, false, false),
      meta(TOKEN_PROGRAM, false, false), meta(loot.ASSOCIATED_TOKEN_PROGRAM, false, false), meta(TM, false, false), meta(TM, false, false),
    ],
    data: concat(Uint8Array.of(43, 0), uintLE(1, 8), NONE),
  };
}

/** Token Metadata's Verify (52) CollectionV1 (1): the maker verifies `mint` in the sized collection `collection`. */
function verifyCollectionV1({ mint, maker, collection }) {
  return {
    programId: TM,
    keys: [
      meta(maker, true, false), meta(TM, false, false), meta(loot.tokenMetadata.metadata(mint), false, true), meta(collection, false, false),
      meta(loot.tokenMetadata.metadata(collection), false, true), meta(loot.tokenMetadata.edition(collection), false, false),
      meta(SYSTEM_PROGRAM, false, false), meta(SYSVAR_INSTRUCTIONS, false, false),
    ],
    data: Uint8Array.of(52, 1),
  };
}

/** A legacy NFT of `maker`'s sized collection `collection`, verified in it, minted to `owner`. */
export function nftOf(w, maker, owner, collection) {
  const mint = newAddress(w.random);
  w.chain.send(maker, [computeUnitLimit(1_400_000), createV1({ mint, maker, name: 'Outside #7', collection }), mintV1({ mint, maker, owner }), verifyCollectionV1({ mint, maker, collection })]);
  return mint;
}

/** The owner field of a classic token account. */
export const ownerOf = (w, account) => encodeBase58(w.chain.get(account).data.subarray(32, 64));

/** A world with Token Metadata loaded, a maker, and the maker's sized collection `club`. */
export function setup(seed) {
  const w = world({ seed });
  w.chain.svm.addProgram(TM, pinned('token_metadata.so'));
  const maker = w.who();
  const club = newAddress(w.random);
  w.chain.send(maker, [computeUnitLimit(1_400_000), createV1({ mint: club, maker, name: 'Outside Club', sized: true }), mintV1({ mint: club, maker, owner: maker })]);
  return { w, maker, club };
}

