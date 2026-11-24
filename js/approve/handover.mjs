// `xsolana handover [file] --keypair <owner key file> --to <new owner key file>`: hands a live project to a new owner,
// as the program's `update_project` does it, signed by both keys (the program asks for the new owner's signature too,
// so a project is never handed to a key nobody holds). It works as `approve --keypair` does: it reads the project from
// the chain and prints what would change, with a code, and sends nothing; run again with `--yes <code>`, it sends
// exactly that, and reads the project back. The authority, the treasury and the project's address stay as they are.
// Neither key is printed; both are read as `readKeyFile` reads a key file (its user alone, outside any repository).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileMessage, wireTransaction } from '../chain/tx.js';
import { decode } from '../client/accounts.js';
import { cluster, lootProgram, realMoney } from '../client/cluster.js';
import { updateProjectIx } from '../client/ix.js';
import { economyOf, parseFile } from '../economy/spec-file.mjs';
import { readKeyFile } from './keyfile.mjs';
import { clusterChain } from './server.mjs';

/** A refusal said in one line, with nothing sent. */
export class HandoverError extends Error {}

/** The project as the chain holds it now: { owner, authority, treasury }, read and checked to be loot's. */
async function projectNow(chain, project) {
  const account = await chain.account(project);
  if (!account) throw new HandoverError(`Nothing was sent: there is no account at ${project} on ${cluster()}.`);
  if (account.owner !== lootProgram())
    throw new HandoverError(`Nothing was sent: ${project} is not a loot project on ${cluster()}.`);
  const p = decode('Project', account.data);
  return { owner: p.owner, authority: p.authority, treasury: p.treasury };
}

/** The code that stands for one printout: the cluster, the program, the project as it is now and the new owner. */
export const handoverCode = ({ project, now, to }) => {
  const hex = createHash('sha256')
    .update(JSON.stringify(['xsolana handover', cluster(), lootProgram(), project, now, to]))
    .digest('hex')
    .slice(0, 8);
  return realMoney() ? `mainnet-${hex}` : hex;
};

/**
 * Hands the live project in `file` from the key in `keyFile` (its owner) to the key in `toFile`. `yes`: null shows
 * what would change and sends nothing; a code sends when it is the code of what is shown now, and is refused
 * otherwise. Returns { ok, sent, code }.
 */
export async function handover({
  file = 'xsolana.json',
  keyFile,
  toFile,
  yes = null,
  chain = clusterChain(),
  out = line => console.log(line),
  keyReader = readKeyFile,
}) {
  let text;
  try {
    text = await readFile(path.resolve(file), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new HandoverError(`${file} does not exist.`);
    throw e;
  }
  const spec = economyOf(parseFile(text));
  const project = spec?.live?.project;
  if (!project)
    throw new HandoverError(
      `Nothing was sent: ${file} is not live (no "live" section naming its project), so there is no project to hand over.`,
    );
  const key = await keyReader(keyFile);
  let to;
  try {
    to = await keyReader(toFile);
  } catch (e) {
    key.drop();
    throw e;
  }
  try {
    if (to.address === key.address)
      throw new HandoverError('Nothing was sent: --keypair and --to are the same key, which owns the project already.');
    const now = await projectNow(chain, project);
    if (now.owner !== key.address)
      throw new HandoverError(
        `Nothing was sent: the project's owner is ${now.owner}, not ${key.address} (the key in ${keyFile}). Only its owner's key hands it over.`,
      );
    const code = handoverCode({ project, now, to: to.address });
    const lines = [
      ...(realMoney()
        ? ['MAINNET: this hands over a project that holds real money, and it cannot be undone by the old key.']
        : []),
      `Hand the project ${project} to a new owner, on ${cluster()}:`,
      `- Owner now: ${now.owner} (the key in ${keyFile})`,
      `- New owner: ${to.address} (the key in ${toFile}), which signs too`,
      `- Stay as they are: the authority ${now.authority}, the treasury ${now.treasury}, the project's address, and every record and balance.`,
      `After this, only the new owner's key changes the project: xsolana approve ${file} --keypair ${toFile}. The old key can change nothing more; the authority and the treasury, if they are the old key, stay with it until the new owner changes them.`,
      'It is one transaction, update_project, signed by both keys; the current owner pays its fees (the project fee and the network fee).',
    ];
    if (yes === null) {
      for (const l of lines) out(l);
      out(`Nothing was sent. Once both owners have read this and agreed, run the same command with --yes ${code}`);
      return { ok: true, sent: 0, code };
    }
    if (yes !== code)
      throw new HandoverError(
        `Nothing was sent: "${yes}" is not the code of what the project is now. Run the command without --yes to see it again, with its code.`,
      );
    const ix = updateProjectIx({ owner: key.address, project, newOwner: to.address });
    const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
    const wire = wireTransaction(compileMessage({ payer: key.address, blockhash, instructions: [ix] }));
    const signature = await chain.send(await to.signTransaction(await key.signTransaction(wire)));
    await chain.confirm(signature, { lastValidBlockHeight });
    const after = await projectNow(chain, project);
    if (after.owner !== to.address)
      throw new HandoverError(
        `The transaction ${signature} was sent, but the project's owner reads as ${after.owner}: check it on chain before anything else.`,
      );
    out(`Done: the project ${project} is owned by ${to.address} (transaction ${signature}).`);
    return { ok: true, sent: 1, code, signature };
  } finally {
    key.drop();
    to.drop();
  }
}
