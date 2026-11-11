// Every address the loot program derives, with the seeds the program uses. Each takes base58
// addresses and numbers and returns a base58 address. Browser-safe.
import { addressBytes } from '../chain/base58.js';
import { intLE, utf8, uintLE } from '../chain/bytes.js';
import { associatedTokenAddress, findProgramAddress, MPL_CORE_PROGRAM, TOKEN_PROGRAM } from '../chain/pda.js';
import { lootProgram } from './cluster.js';

// loot's program on this process's cluster (`cluster.js`): devnet unless the process names mainnet.
export {
  checkOnCluster,
  CLUSTERS,
  cluster,
  clusterRpcUrl,
  LOOT_PROGRAM,
  lootProgram,
  networkOf,
  realMoney,
  scopeClusters,
  useCluster,
  walletChain,
} from './cluster.js';
/** MagicBlock's VRF program and its default queue, the only queue the program accepts. */
export const VRF_PROGRAM = 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
export const VRF_QUEUE = 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
export { MPL_CORE_PROGRAM };
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** Compressed NFTs: Bubblegum, and the account compression program and noop of its v2 trees. */
export const BUBBLEGUM_PROGRAM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
export const COMPRESSION_PROGRAM = 'mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW';
export const NOOP_PROGRAM = 'mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3';

const seed = s => utf8(s);
const key = a => addressBytes(a);
const u8 = n => uintLE(n, 1);
const u16 = n => uintLE(n, 2);
const u32 = n => uintLE(n, 4);
const u64 = n => uintLE(n, 8);
const i64 = n => intLE(n, 8);

/** The PDA of these seeds under the loot program, with its bump. */
export const lootAddress = (seeds, program = lootProgram()) => findProgramAddress(seeds, program);
const at = (...seeds) => lootAddress(seeds)[0];

export const pda = {
  platform: () => at(seed('platform')),
  /** A project: any wallet (its creator) opens as many as it likes, each with a number of its own (`id`, a u64). A
   * new owner keeps the address. */
  project: (creator, id = 0) => at(seed('project'), key(creator), u64(id)),
  /** The project's fee box: where the platform's fees on its transactions wait. */
  fees: project => at(seed('fees'), key(project)),
  pool: (project, index) => at(seed('pool'), key(project), u16(index)),
  item: (project, id) => at(seed('item'), key(project), u32(id)),
  box: (project, id) => at(seed('box'), key(project), u32(id)),
  /** NFTs the project holds to give away as prizes: a box entry of a stash gives one of them at random. */
  stash: (project, id) => at(seed('stash'), key(project), u32(id)),
  /** A table of weighted rows the project writes and seals (a card among thousands, a trait's values), or commits by a Merkle root. */
  table: (project, id) => at(seed('table'), key(project), u32(id)),
  /** What the project keeps about a wallet (its player's profile: XP, level, rank). */
  profile: (project, wallet) => at(seed('profile'), key(project), key(wallet)),
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
  /** A contest's pot: `["pot", contest]`. */
  pot: record => at(seed('pot'), key(record)),
  /** A lottery's pot `id` (below `MAX_POTS`), kept from round to round: `["pot", lottery, id]`. */
  lotteryPot: (lottery, id) => at(seed('pot'), key(lottery), u8(id)),
  /** One round of a lottery: its record, opened by the round's first purchase (`["round", lottery, incarnation, round]`). */
  round: (lottery, incarnation, round) => at(seed('round'), key(lottery), u64(incarnation), u32(round)),
  /** A lottery round's own token account of `mint`, which the round's record owns. */
  roundTokens: (round, mint) => at(seed('round-tokens'), key(round), key(mint)),
  /** A contest's list of entries, one record a player (page 0). */
  entries: (contest, incarnation, page = 0) => at(seed('entries'), key(contest), u64(incarnation), u8(page)),
  /** A hold names its NFT and its end (Unix seconds): a release sent late never finds a later hold of the NFT. */
  hold: (asset, freeAt) => at(seed('hold'), key(asset), i64(freeAt)),
  /** An offer: an id is its maker's own. Its money waits in the project's vault for its mint (`vault`). */
  offer: (project, maker, id) => at(seed('offer'), key(project), key(maker), u32(id)),
  /** A lottery's own stash: the NFTs its places promise (`Prize::Held`), which leave only as its prizes. */
  lotteryStash: lottery => at(seed('lottery_stash'), key(lottery)),
  /** A contest's prize split by stake, set aside when it is decided: `["prize", contest]`. */
  prizeVault: contest => at(seed('prize'), key(contest)),
  /** A sealed schedule's own vault, which only its runs pay out of: `["vest", schedule]`. */
  vest: schedule => at(seed('vest'), key(schedule)),
  /** A listing of an NFT for sale or for rent: one per NFT a project holds, so its address names the NFT. */
  listing: (project, asset) => at(seed('listing'), key(project), key(asset)),
  staked: farm => at(seed('staked'), key(farm)),
  rewards: farm => at(seed('rewards'), key(farm)),
  /** A farm's record of when its seats stop earning, for a farm that keeps one (`Farm.keeps_ends`). */
  ends: farm => at(seed('ends'), key(farm)),
  /** A seat: a player's in a farm of tokens, a collectible's (its asset) in a farm of collectibles. */
  seat: (farm, by) => at(seed('seat'), key(farm), key(by)),
  /** What the project writes about an NFT it has no authority over (its Sheet): `nft` is a Core asset, a Token Metadata mint or a compressed NFT's asset id. */
  sheet: (project, nft) => at(seed('sheet'), key(project), key(nft)),
  /** A compressed NFT as last proven (`prove_leaf`), read while the leaf is unchanged and its root is still in the tree's change log. */
  leaf: asset => at(seed('leaf'), key(asset)),
  /** The root of the traits the project vouches for, under its own `key` (a collection's address, by convention). */
  traits: (project, key_) => at(seed('traits'), key(project), key(key_)),
  /** Bubblegum's config of a tree: `[tree]`. */
  treeConfig: tree => findProgramAddress([key(tree)], BUBBLEGUM_PROGRAM)[0],
  /** A compressed NFT's asset id: Bubblegum's `["asset", tree, nonce]`, `nonce` the count minted before it. */
  compressedAsset: (tree, nonce) => findProgramAddress([seed('asset'), key(tree), u64(nonce)], BUBBLEGUM_PROGRAM)[0],
  /** A wallet's counts in a project: how many times it bought from each box, crafted each recipe or held tickets in
   * a lottery's round that limits it (`decodeCounts`). */
  counts: (project, wallet) => at(seed('counts'), key(project), key(wallet)),
  /** Shard `shard` of a grant's limit records: what each wallet, person, badge and voucher key claimed. */
  claims: (grant, incarnation, shard) => at(seed('claims'), key(grant), u64(incarnation), u8(shard)),
  /** Shard `shard` of the rounds a grant paid. */
  rounds: (grant, incarnation, shard) => at(seed('rounds'), key(grant), u64(incarnation), u8(shard)),
  /** The program's identity, which signs its requests to the oracle. */
  identity: () => at(seed('identity')),
  /** The identity the oracle signs callbacks with: the VRF program's PDA for this program. */
  oracleIdentity: () => findProgramAddress([seed('identity'), key(lootProgram())], VRF_PROGRAM)[0],
  /** The program's ProgramData account (its upgrade authority signs `init_platform`). */
  programData: () => findProgramAddress([key(lootProgram())], BPF_LOADER_UPGRADEABLE)[0],
};

/** `owner`'s associated token account of `mint` (owner may be a PDA: a project's vault, a pool is not one). */
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => associatedTokenAddress(owner, mint, tokenProgram);

/** A project's vault for `mint`: its associated token account, where every open order's payment is held. */
export const vault = (project, mint, tokenProgram = TOKEN_PROGRAM) => ata(project, mint, tokenProgram);
