// Every address the loot program derives, with the seeds the program uses. Each takes base58
// addresses and numbers and returns a base58 address. Browser-safe.
import { addressBytes } from '../chain/base58.js';
import { intLE, utf8, uintLE } from '../chain/bytes.js';
import { associatedTokenAddress, findProgramAddress, MPL_CORE_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import IDL from './idl/loot.js';

export const LOOT_PROGRAM = IDL.address;
/** MagicBlock's VRF program and its default queue, the only queue the program accepts. */
export const VRF_PROGRAM = 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
export const VRF_QUEUE = 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
export { MPL_CORE_PROGRAM };
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** Compressed NFTs: Bubblegum, and the account compression program and noop of its v2 trees. */
export const BUBBLEGUM_PROGRAM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
export const COMPRESSION_PROGRAM = 'mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW';
export const NOOP_PROGRAM = 'mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3';

const seed = (s) => utf8(s);
const key = (a) => addressBytes(a);
const u8 = (n) => uintLE(n, 1);
const u16 = (n) => uintLE(n, 2);
const u32 = (n) => uintLE(n, 4);
const u64 = (n) => uintLE(n, 8);
const i64 = (n) => intLE(n, 8);

/** The PDA of these seeds under the loot program, with its bump. */
export const lootAddress = (seeds, program = LOOT_PROGRAM) => findProgramAddress(seeds, program);
const at = (...seeds) => lootAddress(seeds)[0];
const keyReceipt = (grant, incarnation, voucherKey) => at(seed('code'), key(grant), u64(incarnation), key(voucherKey));

export const pda = {
  platform: () => at(seed('platform')),
  /** A project: any wallet (its creator) opens as many as it likes, each with a number of its own (`id`, a u64). A
   * new owner keeps the address. */
  project: (creator, id = 0) => at(seed('project'), key(creator), u64(id)),
  /** The project's fee box: where the platform's fees on its transactions wait. */
  fees: (project) => at(seed('fees'), key(project)),
  pool: (project, index) => at(seed('pool'), key(project), u8(index)),
  item: (project, id) => at(seed('item'), key(project), u32(id)),
  box: (project, id) => at(seed('box'), key(project), u32(id)),
  /** NFTs the project holds to give away as prizes: a box entry of a stash gives one of them at random. */
  stash: (project, id) => at(seed('stash'), key(project), u32(id)),
  schedule: (project, id) => at(seed('schedule'), key(project), u32(id)),
  lottery: (project, id) => at(seed('lottery'), key(project), u32(id)),
  recipe: (project, id) => at(seed('recipe'), key(project), u32(id)),
  contest: (project, id) => at(seed('contest'), key(project), u32(id)),
  /** An auction: an id is its seller's own. Its bids wait in the project's vault for its mint (`vault`). */
  auction: (project, seller, id) => at(seed('auction'), key(project), key(seller), u32(id)),
  farm: (project, id) => at(seed('farm'), key(project), u32(id)),
  grant: (project, id) => at(seed('grant'), key(project), u16(id)),
  order: (project, player, nonce) => at(seed('order'), key(project), key(player), u64(nonce)),
  /** Every collectible the program mints of its own accord (an order's, a prize's, an auction's lot): its address
   * names its item and its serial, minted once at most. */
  itemAsset: (item, serial) => at(seed('asset'), key(item), u32(serial)),
  /** A contest's pot, or a lottery's: `["pot", contest or lottery]`. */
  pot: (record) => at(seed('pot'), key(record)),
  lotteryFunds: (lottery) => at(seed('lottery_funds'), key(lottery)),
  lotteryReceipt: (lottery, incarnation, wallet) => at(seed('receipt'), key(lottery), u64(incarnation), key(wallet)),
  /** One purchase of a lottery's tickets, at a nonce of its buyer's. */
  contribution: (lottery, player, nonce) => at(seed('contribution'), key(lottery), key(player), u64(nonce)),
  /** A wallet's entry in a contest: one, on one side (another side is `OtherSide`). */
  entry: (contest, player) => at(seed('entry'), key(contest), key(player)),
  /** A hold names its NFT and its end (Unix seconds): a release sent late never finds a later hold of the NFT. */
  hold: (asset, freeAt) => at(seed('hold'), key(asset), i64(freeAt)),
  /** An offer: an id is its maker's own. Its money waits in the project's vault for its mint (`vault`). */
  offer: (project, maker, id) => at(seed('offer'), key(project), key(maker), u32(id)),
  /** A lottery's own stash: the NFTs its places promise (`Prize::Held`), which leave only as its prizes. */
  lotteryStash: (lottery) => at(seed('lottery_stash'), key(lottery)),
  /** A contest's prize split by stake, set aside when it is decided: `["prize", contest]`. */
  prizeVault: (contest) => at(seed('prize'), key(contest)),
  /** A sealed schedule's own vault, which only its runs pay out of: `["vest", schedule]`. */
  vest: (schedule) => at(seed('vest'), key(schedule)),
  /** A listing of an NFT for sale or for rent: one per NFT a project holds, so its address names the NFT. */
  listing: (project, asset) => at(seed('listing'), key(project), key(asset)),
  staked: (farm) => at(seed('staked'), key(farm)),
  rewards: (farm) => at(seed('rewards'), key(farm)),
  /** A seat: a player's in a farm of tokens, a collectible's (its asset) in a farm of collectibles. */
  seat: (farm, by) => at(seed('seat'), key(farm), key(by)),
  /** What the project writes about an NFT it has no authority over (its Sheet): `nft` is a Core asset, a Token Metadata mint or a compressed NFT's asset id. */
  sheet: (project, nft) => at(seed('sheet'), key(project), key(nft)),
  /** A compressed NFT as last proven (`prove_leaf`), read while the leaf is unchanged and its root is still in the tree's change log. */
  leaf: (asset) => at(seed('leaf'), key(asset)),
  /** The root of the traits the project vouches for, under its own `key` (a collection's address, by convention). */
  traits: (project, key_) => at(seed('traits'), key(project), key(key_)),
  /** Bubblegum's config of a tree: `[tree]`. */
  treeConfig: (tree) => findProgramAddress([key(tree)], BUBBLEGUM_PROGRAM)[0],
  /** A compressed NFT's asset id: Bubblegum's `["asset", tree, nonce]`, `nonce` the count minted before it. */
  compressedAsset: (tree, nonce) => findProgramAddress([seed('asset'), key(tree), u64(nonce)], BUBBLEGUM_PROGRAM)[0],
  /** A wallet's counter on a box or recipe. Grants and lotteries also name their incarnation. */
  receipt: (record, wallet) => at(seed('receipt'), key(record), key(wallet)),
  grantReceipt: (grant, incarnation, wallet) => at(seed('receipt'), key(grant), u64(incarnation), key(wallet)),
  person: (grant, incarnation, personHash) => at(seed('person'), key(grant), u64(incarnation), Uint8Array.from(personHash)),
  /** How many times an NFT shown claimed an open grant its gate asks for one of: an address of its own, never a person's. */
  badge: (grant, incarnation, nft) => at(seed('badge'), key(grant), u64(incarnation), key(nft)),
  /** A voucher key's counter on a grant (a promo code's). */
  code: keyReceipt,
  /** The program's identity, which signs its requests to the oracle. */
  identity: () => at(seed('identity')),
  /** The identity the oracle signs callbacks with: the VRF program's PDA for this program. */
  oracleIdentity: () => findProgramAddress([seed('identity'), key(LOOT_PROGRAM)], VRF_PROGRAM)[0],
  /** The program's ProgramData account (its upgrade authority signs `init_platform`). */
  programData: () => findProgramAddress([key(LOOT_PROGRAM)], BPF_LOADER_UPGRADEABLE)[0],
};

/** `owner`'s associated token account of `mint` (owner may be a PDA: a project's vault, a pool is not one). */
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => associatedTokenAddress(owner, mint, tokenProgram);

/** A project's vault for `mint`: its associated token account, where every open order's payment is held. */
export const vault = (project, mint, tokenProgram = TOKEN_PROGRAM) => ata(project, mint, tokenProgram);
