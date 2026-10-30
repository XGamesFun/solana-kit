// Token Metadata NFTs in a farm, as the client reads and names them: their metadata decoded as far as a farm needs,
// and the accounts a stake, a harvest and a refresh pass for a legacy NFT and a pNFT. The program's own tests run its
// side against the real Token Metadata.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { addressBytes, encodeBase58 } from '../chain/base58.js';
import { concat, uintLE, utf8 } from '../chain/bytes.js';
import IDL from '../client/idl/loot.js';
import * as loot from '../client/index.js';

const newAddress = () => encodeBase58(randomBytes(32));
const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));

/** A MetadataV1 account: `standard` its token standard, `collection` the one it is verified in, `ruleSet` a pNFT's. */
function metadataBytes({ mint, standard, collection, ruleSet }) {
  return concat(
    Uint8Array.of(4), addressBytes(newAddress()), addressBytes(mint),
    str('Club #7'), str('CLUB'), str('https://example.invalid/7.json'), uintLE(500, 2),
    Uint8Array.of(0), // no creators
    Uint8Array.of(1, 1), // primary sale, mutable
    Uint8Array.of(1, 255), // edition nonce
    Uint8Array.of(1, standard),
    collection ? concat(Uint8Array.of(1, 1), addressBytes(collection)) : Uint8Array.of(0),
    Uint8Array.of(0), // uses
    Uint8Array.of(0), // collection details
    ruleSet === undefined ? Uint8Array.of(0) : concat(Uint8Array.of(1, 0), ruleSet ? concat(Uint8Array.of(1), addressBytes(ruleSet)) : Uint8Array.of(0)),
  );
}

test('a Token Metadata account reads as its mint, its verified collection and whether it is a pNFT', () => {
  const [mint, club, rules] = [newAddress(), newAddress(), newAddress()];
  assert.deepEqual(loot.decodeTokenMetadata(metadataBytes({ mint, standard: 0, collection: club })), { mint, collection: club, programmable: false, ruleSet: null });
  assert.deepEqual(loot.decodeTokenMetadata(metadataBytes({ mint, standard: 4, collection: club, ruleSet: rules })), { mint, collection: club, programmable: true, ruleSet: rules });
  assert.equal(loot.decodeTokenMetadata(metadataBytes({ mint, standard: 5, ruleSet: null })).programmable, true, 'a pNFT print');
  assert.equal(loot.decodeTokenMetadata(Uint8Array.of(1, 2, 3)), null);
});

test('a stake, a harvest and a refresh name a Token Metadata NFT’s accounts', () => {
  const [player, project, mint, rewards, rules, seller] = Array.from({ length: 6 }, newAddress);
  const farm = { custody: 'Freeze', farmed: { Collectibles: {} }, rewards_mint: rewards, rewards_pool: 0, rate: { per_day: 1n, mints: true }, prize: null, growth: [{ key: 'xp' }] };
  // An account of an instruction, by name, in the order the IDL lists them (nested ones flattened).
  const leaves = (list) => list.flatMap((a) => (a.accounts ? leaves(a.accounts) : [a.name]));
  const account = (ix, name) => (keys) => keys[leaves(IDL.instructions.find((i) => i.name === ix).accounts).indexOf(name)];
  const legacy = loot.stakeNftIx({ player, project, id: 1, farm, asset: mint, tokenMetadata: { programmable: false } });
  const pnft = loot.stakeNftIx({ player, project, id: 1, farm, asset: mint, tokenMetadata: { programmable: true, ruleSet: rules }, previous: seller });
  const at = (ix, name) => account('stake_nft', name)(ix.keys);
  const token = loot.ata(player, mint);
  assert.equal(at(legacy, 'metadata').pubkey, loot.tokenMetadata.metadata(mint));
  assert.equal(at(legacy, 'token').pubkey, token);
  assert.equal(at(legacy, 'sheet').pubkey, loot.pda.sheet(project, mint), 'what the project writes about it is in its Sheet');
  assert.equal(at(legacy, 'token_record').pubkey, loot.LOOT_PROGRAM, 'a legacy NFT has no token record');
  assert.equal(at(pnft, 'token_record').pubkey, loot.tokenMetadata.record(mint, token));
  assert.equal(at(pnft, 'rules_program').pubkey, loot.AUTH_RULES_PROGRAM);
  assert.equal(at(pnft, 'rule_set').pubkey, rules);
  assert.equal(at(pnft, 'previous').pubkey, seller);
  assert.equal(at(pnft, 'previous').isWritable, true);
  // Locked in the wallet, never moved: no project's token account, record or ATA program; a legacy NFT's lock no sysvar.
  assert.deepEqual(['project_token', 'project_record', 'spl_ata_program'].map((n) => at(pnft, n).pubkey), [loot.LOOT_PROGRAM, loot.LOOT_PROGRAM, loot.LOOT_PROGRAM]);
  assert.equal(at(legacy, 'instructions').pubkey, loot.LOOT_PROGRAM);
  assert.equal(at(pnft, 'instructions').pubkey, 'Sysvar1nstructions1111111111111111111111111');
  const escrowed = loot.stakeNftIx({ player, project, id: 1, farm: { ...farm, custody: 'Escrow' }, asset: mint, tokenMetadata: { programmable: true, ruleSet: rules } });
  assert.equal(at(escrowed, 'project_record').pubkey, loot.tokenMetadata.record(mint, loot.ata(project, mint)), 'handed to the project');

  const harvest = loot.harvestIx({ player, project, id: 1, farm, by: mint, held: token });
  assert.equal(account('harvest', 'held')(harvest.keys).pubkey, token);
  // Held by the project (an escrow farm): read in the project's token account.
  const refresh = loot.refreshSeatIx({ signer: player, project, id: 1, farm: { ...farm, custody: 'Escrow' }, by: mint, seat: { asset: mint, player }, tokenMetadata: { programmable: true } });
  const r = (name) => account('refresh_seat', name)(refresh.keys);
  assert.equal(r('token').pubkey, token);
  assert.deepEqual([r('collection').pubkey, r('mpl_core_program').pubkey], [loot.LOOT_PROGRAM, loot.LOOT_PROGRAM], 'no Core accounts for a Token Metadata NFT');
  assert.equal(r('project_token').pubkey, loot.ata(project, mint));
  assert.deepEqual([r('token_record').pubkey, r('token_metadata_program').pubkey], [loot.LOOT_PROGRAM, loot.LOOT_PROGRAM], 'Token Metadata is not called');
  assert.equal(r('sheet').isWritable, true, 'its growth is written in its Sheet');
});
