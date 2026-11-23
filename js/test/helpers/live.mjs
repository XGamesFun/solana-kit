// Going live as an owner does, for the tests that play a live economy: the approval's own session (`createApproval`,
// what `xsolana approve` runs) on a world's local chain, each batch signed by the owner's key. It is beside world.mjs,
// not in it, so the tests of the client alone do not load the approval.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApproval } from '../../approve/server.mjs';
import { fromBase64, toBase64 } from '../../chain/bytes.js';
import { approvalChain, signWire } from './world.mjs';

/**
 * Puts `spec` live on world `w`, every batch approved by `owner` (a keypair with SOL there), and returns the economy's
 * file as the approval left it, with its `live` section. The approval reads the time the world's clock shows now.
 */
export async function goLive(w, owner, spec) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-live-')), 'xsolana.json');
  writeFileSync(file, JSON.stringify(spec));
  const now = w.chain.now();
  const session = await createApproval({ file, chain: approvalChain(w), now: () => now });
  for (let i = 0; i < 6 && !session.state().done; i++) {
    const batch = await session.prepare(owner.address);
    const signed = batch.transactions.map(b64 => toBase64(signWire(owner, fromBase64(b64))));
    await session.complete(owner.address, batch.id, signed);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
