// What every builder stands on: `lootIx`, which builds any loot instruction from its IDL entry, an instruction's tail
// (`tailOf`), the IDL entry of an instruction's data (`instructionOf`) and `reference`.
import { addressBytes } from '../../chain/base58.js';
import { encodeInstruction } from '../../chain/borsh.js';
import { uintLE, utf8 } from '../../chain/bytes.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  findProgramAddress,
  METAPLEX_METADATA_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  SYSVAR_SLOT_HASHES,
  TOKEN_2022_PROGRAM,
} from '../../chain/pda.js';
import { meta } from '../../chain/programs.js';
import { sha256 } from '../../chain/sha256.js';
import { MEMO_PROGRAM } from '../../chain/token2022.js';
import IDL from '../idl/loot.js';
import {
  BUBBLEGUM_PROGRAM,
  COMPRESSION_PROGRAM,
  lootProgram,
  MPL_CORE_PROGRAM,
  NOOP_PROGRAM,
  pda,
  VRF_QUEUE,
} from '../pda.js';
import { instructionDef, leaves } from './defs.js';

export { IDL, ASSOCIATED_TOKEN_PROGRAM };

/** Token Metadata: a legacy NFT's or a pNFT's metadata lives at an address of its (`METAPLEX_METADATA_PROGRAM`). */
export const TOKEN_METADATA_PROGRAM = METAPLEX_METADATA_PROGRAM;

const ZERO_REFERENCE = new Uint8Array(32);

/** 32 bytes a project names a call by (a match id, a payout's reason). Zeros when not given. */
export function reference(value) {
  if (value == null) return ZERO_REFERENCE;
  if (typeof value === 'string') return sha256(utf8(value));
  const bytes = Uint8Array.from(value);
  if (bytes.length !== 32) throw new Error('A reference is 32 bytes, or a string that is hashed to 32.');
  return bytes;
}

// ---------------------------------------------------------------- any instruction

/** The IDL's instructions, the longest tags first: the oracle's three callbacks keep 8-byte tags, every other
 * instruction has a 1-byte one, which the first byte of an 8-byte tag may equal. */
const BY_TAG = [...IDL.instructions].sort((a, b) => b.discriminator.length - a.discriminator.length);

/** The IDL entry of the loot instruction whose data is `data` (its tag first), or null. */
export const instructionOf = data =>
  BY_TAG.find(i => i.discriminator.length <= data.length && i.discriminator.every((b, j) => data[j] === b)) ?? null;

/**
 * An instruction's tail (`tokens::tail`): the accounts every NFT move hands Core (what a check its collection carries
 * reads, an oracle's account) and every token transfer hands a transfer hook, after the route's own. It starts at the
 * Memo program's account, which serves a transfer into an account that requires a memo; with none, it is empty. So
 * `extra` (hook accounts, Core's adapters) goes after the Memo program, which this puts first.
 */
export function tailOf(extra = []) {
  if (!extra.length) return [];
  return [meta(MEMO_PROGRAM, false, false), ...extra.filter(m => m.pubkey !== MEMO_PROGRAM)];
}

/** Accounts that are the same wherever an instruction names them. The program checks each by address, which the
 * IDL doesn't carry. */
const DEFAULTS = {
  platform: () => pda.platform(),
  fees: known => known.project && pda.fees(known.project),
  program_identity: () => pda.identity(),
  vrf_program_identity: () => pda.oracleIdentity(),
  oracle_queue: () => VRF_QUEUE,
  slot_hashes: () => SYSVAR_SLOT_HASHES,
  instructions: () => SYSVAR_INSTRUCTIONS,
  program_data: () => pda.programData(),
  token_2022_program: () => TOKEN_2022_PROGRAM,
  mpl_core_program: () => MPL_CORE_PROGRAM,
  item_core_program: () => MPL_CORE_PROGRAM,
  token_metadata_program: () => TOKEN_METADATA_PROGRAM,
  bubblegum_program: () => BUBBLEGUM_PROGRAM,
  compression_program: () => COMPRESSION_PROGRAM,
  log_wrapper: () => NOOP_PROGRAM,
};

const SEED_SIZES = { u8: 1, u16: 2, u32: 4, u64: 8 };

/** The bytes of one IDL seed, or null when it can't be had from what is known (it reads an account's data). */
function seedBytes(seed, known, args, def) {
  if (seed.kind === 'const') return Uint8Array.from(seed.value);
  if (seed.kind === 'arg') {
    const arg = def.args.find(a => a.name === seed.path);
    if (!arg || !(seed.path in args)) return null;
    if (arg.type === 'pubkey') return addressBytes(args[seed.path]);
    if (SEED_SIZES[arg.type]) return uintLE(args[seed.path], SEED_SIZES[arg.type]);
    return null;
  }
  if (seed.kind === 'account') {
    // "side.farm" names the account `farm` of the group `side`; a path into an account's data ("order.requested_slot")
    // can't be resolved here.
    const parts = seed.path.split('.');
    const groups = new Set(def.accounts.filter(a => a.accounts).map(a => a.name));
    const name = parts.length === 1 ? parts[0] : groups.has(parts[0]) && parts.length === 2 ? parts[1] : null;
    return name && known[name] ? addressBytes(known[name]) : null;
  }
  return null;
}

/**
 * Any loot instruction. `accounts` names accounts by their IDL leaf name; `null` for an optional one passes "None".
 * Options: `remaining` (metas after the instruction's own), `writable` and `signer` (leaf names whose flag is set
 * on, beyond the IDL's), `readonly` (leaf names whose writable flag is set off).
 */
export function lootIx(
  name,
  args = {},
  accounts = {},
  { remaining = [], writable = [], signer = [], readonly = [] } = {},
) {
  const def = instructionDef(name);
  const list = leaves(def.accounts);
  const known = {};
  for (const a of list) {
    if (accounts[a.name] !== undefined) known[a.name] = accounts[a.name];
    else if (a.address) known[a.name] = a.address;
  }
  // Defaults and PDAs, until nothing more resolves (a PDA's seeds may name an account derived the same way).
  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    for (const a of list) {
      if (a.name in known) continue;
      const fallback = DEFAULTS[a.name]?.(known);
      if (fallback) {
        known[a.name] = fallback;
        progress = true;
        continue;
      }
      if (a.pda && !a.pda.program) {
        const seeds = a.pda.seeds.map(s => seedBytes(s, known, args, def));
        if (seeds.every(Boolean)) {
          known[a.name] = findProgramAddress(seeds, lootProgram())[0];
          progress = true;
        }
      }
    }
    if (!progress) break;
  }
  const keys = list.map(a => {
    const key = known[a.name];
    if (key === null || (key === undefined && a.optional)) {
      if (!a.optional) throw new Error(`${name}: ${a.name} is not optional`);
      return meta(lootProgram(), false, false);
    }
    if (key === undefined) throw new Error(`${name}: missing account ${a.group ? `${a.group}.` : ''}${a.name}`);
    const isWritable = (a.writable === true || writable.includes(a.name)) && !readonly.includes(a.name);
    return meta(key, a.signer === true || signer.includes(a.name), isWritable);
  });
  return { programId: lootProgram(), keys: [...keys, ...remaining], data: encodeInstruction(IDL, name, args) };
}
