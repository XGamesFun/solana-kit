// A key file: one Solana key on this machine, in the Solana CLI's own format (a JSON array of 64 numbers: the 32-byte
// seed, then the public key). `xsolana keygen` makes one for a project and `xsolana approve --keypair` signs that
// project's setup with it, so going live needs no browser wallet and no page. The key is the project's owner:
// whoever can read the file controls the project. So a key file is only ever made new (never written over), readable
// by its user alone, kept outside any git repository, and never printed: these functions hand back its address and a
// way to sign, not its bytes.
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { encodeBase58 } from '../chain/base58.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** The most a key file holds: 64 numbers of up to three digits, with room for however it was spaced. */
const MOST_BYTES = 4096;

/** A refusal about a key file: said in one line, and it never quotes what the file holds. */
export class KeyFileError extends Error {}

/** `file` as a whole path: a leading `~` is the home folder, whether or not a shell expanded it. */
export function keyFilePath(file) {
  const text = String(file ?? '');
  if (!text) throw new KeyFileError('Say which key file: a path outside any repository.');
  if (text === '~') return homedir();
  return path.resolve(text.startsWith('~/') || text.startsWith('~\\') ? path.join(homedir(), text.slice(2)) : text);
}

/** The key a 32-byte seed makes: { address, publicKey, sign(message), drop() }. The private key stays in here. */
function keyOf(seed) {
  let key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const publicKey = new Uint8Array(Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url'));
  return {
    address: encodeBase58(publicKey),
    publicKey,
    sign(message) {
      if (!key) throw new Error('This key was dropped.');
      return new Uint8Array(sign(null, Buffer.from(message), key));
    },
    /** The key signs nothing more. */
    drop() {
      key = null;
    },
  };
}

const exists = p =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The nearest folder at or above `dir` that holds a `.git` (a repository's work tree, as far as a look can tell). */
async function gitFolderAbove(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    if (await exists(path.join(at, '.git'))) return at;
    if (path.dirname(at) === at) return null;
  }
}

/** git run in `root`: { code, stderr }, `code` 0 when it succeeded, its exit code otherwise, 'ENOENT' with no git. */
const git = (root, args, run = execFile) =>
  new Promise(resolve => {
    const done = (error, _stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stderr: String(stderr ?? '') });
    try {
      run('git', ['-C', root, ...args], { timeout: 10_000, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } }, done);
    } catch (e) {
      done(e);
    }
  });

/**
 * What git says of `file` in the folder `root`, which holds a `.git`: 'ignored' (never committed), 'kept' (it would
 * be), 'none' (that `.git` is no repository: an empty folder of that name), or 'unknown' (git could not be asked).
 */
async function gitSays(root, file, run) {
  const asked = await git(root, ['check-ignore', '-q', '--', file], run);
  if (asked.code === 0) return 'ignored';
  if (asked.code === 1) return 'kept';
  if (asked.code === 'ENOENT') return 'unknown';
  const repository = await git(root, ['rev-parse', '--git-dir'], run);
  return repository.code !== 0 && /not a git repository/i.test(repository.stderr) ? 'none' : 'unknown';
}

/** The nearest folder at or above `dir` that exists. */
async function nearest(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    if ((await exists(at)) || path.dirname(at) === at) return at;
  }
}

/**
 * Refuses a key file inside a git repository's work tree, unless git ignores it there: a key in a repository is
 * committed sooner or later, and a commit is for good. `from` is a folder that exists, at or above the file's own;
 * `real` is the file's whole path with every link followed (the file itself need not exist yet). When git can't be
 * asked, a `.git` above the file is taken at its word.
 */
async function outsideRepositories(shown, from, real, { run } = {}) {
  for (let root = await gitFolderAbove(from); root;) {
    const says = await gitSays(root, real, run);
    if (says === 'ignored') return;
    if (says !== 'none')
      throw new KeyFileError(
        `${shown} is inside the git repository at ${root}: a key there is committed sooner or later, and whoever reads it controls the project. Keep it outside any repository, for example ~/.config/xsolana/<name>.json.`,
      );
    // (a `.git` that is no repository: the folders above it are still asked)
    root = path.dirname(root) === root ? null : await gitFolderAbove(path.dirname(root));
  }
}

/** What the bytes of a key file hold: its key, or a refusal that quotes none of it. */
function parseKey(file, text) {
  const not = () =>
    new KeyFileError(
      `${file} is not a Solana key file (a JSON array of 64 numbers, as \`xsolana keygen\` and \`solana-keygen\` write).`,
    );
  let bytes;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw not();
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255))
    throw not();
  const key = keyOf(Uint8Array.from(bytes.slice(0, 32)));
  if (!key.publicKey.every((b, i) => b === bytes[32 + i])) {
    key.drop();
    throw new KeyFileError(
      `${file} is damaged: its second half is not the public key of its first. Nothing was signed with it.`,
    );
  }
  return key;
}

/**
 * Makes a new key and writes it to `file`, which must not exist: the folder is made if need be (for its user alone),
 * the file is readable and writable by its user alone, and a path inside a git repository is refused. Returns
 * { file, address }: the whole path and the key's address, never the key.
 */
export async function makeKeyFile(file, { run } = {}) {
  const target = keyFilePath(file);
  const dir = path.dirname(target);
  // (asked before a folder is made: nothing is left behind in a repository that is refused)
  const base = await nearest(dir);
  const from = await realpath(base);
  await outsideRepositories(target, from, path.join(from, path.relative(base, target)), { run });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  let handle;
  try {
    // (`wx`: made new or not at all, so a key already there is never written over)
    handle = await open(target, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const address = await readKeyFile(target, { run }).then(
      k => {
        k.drop();
        return k.address;
      },
      () => null,
    );
    throw new KeyFileError(
      address
        ? `${target} is already there: a key file whose address is ${address}. Nothing was written. Use it, or name another file.`
        : `${target} is already there, and nothing is ever written over: name another file.`,
    );
  }
  try {
    await handle.writeFile(`${JSON.stringify([...seed, ...pub])}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o600);
  seed.fill(0);
  return { file: target, address: encodeBase58(new Uint8Array(pub)) };
}

/**
 * Reads the key in `file` to sign with: { file, address, sign(message), drop() }. Refused: a file other users of the
 * machine can read, one inside a git repository, and anything that is not a whole key. No refusal quotes the file.
 */
export async function readKeyFile(file, { run, platform = process.platform } = {}) {
  const target = keyFilePath(file);
  let info;
  try {
    info = await stat(target);
  } catch (e) {
    if (e.code === 'ENOENT')
      throw new KeyFileError(`${target} does not exist. \`xsolana keygen ${file}\` makes a new key there.`);
    throw e;
  }
  if (!info.isFile()) throw new KeyFileError(`${target} is not a file.`);
  if (info.size > MOST_BYTES) throw new KeyFileError(`${target} is too big to be a Solana key file.`);
  if (platform !== 'win32' && info.mode & 0o077)
    throw new KeyFileError(
      `${target} can be read by other users of this machine (its mode is ${(info.mode & 0o777).toString(8)}). Run: chmod 600 ${target}`,
    );
  const real = await realpath(target);
  await outsideRepositories(target, path.dirname(real), real, { run });
  const key = parseKey(target, await readFile(target, 'utf8'));
  return { file: target, address: key.address, sign: key.sign, drop: key.drop };
}
