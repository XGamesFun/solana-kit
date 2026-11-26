// The package's own examples, as a TypeScript project writes them: the README's, and the ones at the head of
// js/play/index.js and js/results/index.js, line for line, then the calls those modules' own comments describe.
// js/test/types.test.mjs compiles this file under `strict` against the declarations the package ships, and holds
// every example line to its source. Nothing here runs.
import { compileMessage } from '@xgamesfun/solana/chain/tx';
import * as loot from '@xgamesfun/solana/client';
import { solanaApp, walletStandardSigner } from '@xgamesfun/solana/play';
import { giveaways, hostCertText, newKey, newRound, report, signVoucher } from '@xgamesfun/solana/results';

// What a page or a server has at hand before it calls the package.
declare const spec: { version: 2; network: 'devnet' | 'mainnet'; live: { project: string } };
declare const wallet: { name: string; features: Record<string, any> };
declare const account: { address: string };
/** A wallet's address, or a mint's. */
type Address = string;

/** README.md, "Use it in your game". */
export async function readme(rpcUrl: string) {
  const chain = spec.network === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';
  const app = solanaApp({ spec, rpcUrl, wallet: walletStandardSigner(wallet, account, chain) });
  await app.recover(); // finish earlier purchases when the wallet reconnects
  const items = (await app.shop()).map(item => ({ item, buy: () => app.buy(item.key, { listing: item }) }));
  const boxes = (await app.boxes()).map(box => ({ box, open: () => app.openBox(box.key, { listing: box }) }));
  return { items, boxes };
}

/** js/play/index.js. */
export async function page(listing: { key: string; priceUnits: bigint }, server: string, token: string) {
  const app = solanaApp({
    spec,
    rpcUrl: 'https://api.devnet.solana.com',
    wallet: walletStandardSigner(wallet, account),
  });
  const items = await app.shop();
  const bought = await app.buy('sword', { listing: items[0] });
  const opened = await app.openBox('chest', { listing });
  for (const c of await app.claims()) await app.claim(c);
  await app.claimWins({ server, token });
  return [bought, opened];
}

/** js/results/index.js: a host server. */
export async function hostServer(
  server: string,
  cert: { text: string; signature: string },
  game: Address,
  until: number,
  endedAt: number,
  winner: { wallet: Address; place: number; grant: number },
) {
  const { wallet, place, grant } = winner;
  const key = await newKey();
  hostCertText({ game, host: key.address, until });
  await report({ server, cert, signer: key, game, round: newRound(), endedAt, winners: [{ wallet, place, grant }] });
}

/** js/results/index.js: a host server that pays its winners itself, then the winner's page. */
export async function ownVouchers(
  app: ReturnType<typeof solanaApp>,
  game: Address,
  incarnation: bigint,
  wallet: Address,
  round: string,
  clusterNow: number,
) {
  const key = await newKey();
  const voucher = await signVoucher({ signer: key, game, grant: 1, incarnation, wallet, round, now: clusterNow });
  await app.claimGrant('prize', { voucher });
  // a voucher for a grant that counts by person names the person
  return signVoucher({
    signer: key,
    game,
    grant: 1,
    incarnation,
    wallet,
    round,
    now: clusterNow,
    personHash: 'ab'.repeat(32),
  });
}

/** js/results/index.js: a giveaway host. */
export async function giveawayHost(
  server: string,
  game: Address,
  appointment: { text: string; signature: string },
  token: string,
  endsBy: number,
  endedAt: number,
  giveaway: string,
  winner: { wallet: Address; place: number },
  grant: number,
) {
  const { wallet, place } = winner;
  const session = await newKey();
  await giveaways.open({ server, game, cert: appointment, token, giveaway: newRound(), winners: 3, endsBy, session });
  await giveaways.report({ server, game, giveaway, session, endedAt, winners: [{ wallet, place }], grant });
}

/** The client's builders, with the options their own comments describe (js/client/ix/money.js, js/chain/tx.js). */
export function builders(
  player: Address,
  project: Address,
  mint: Address,
  treasury: Address,
  box: any,
  blockhash: string,
) {
  // a payment with what the JavaScript needs and no more, then one split by shares
  const pay = loot.payIx({ player, project, mint, treasury, amount: 1n });
  const split = loot.payIx({ player, project, mint, treasury, amount: 1n, shares: [{ to: 'Burn', bps: 500 }] });
  // a box whose share the buyer names
  const open = loot.openBoxIx({ player, project, box, nonce: 1n, chosenRecipient: treasury });
  // a v0 message with a lookup table, and a legacy one
  const table = { address: project, addresses: [mint, treasury] };
  const v0 = compileMessage({
    payer: player,
    blockhash,
    instructions: [pay, split, open],
    version: 0,
    lookupTables: [table],
  });
  const legacy = compileMessage({ payer: player, blockhash, instructions: [pay] });
  return [v0, legacy, loot.toKitInstruction(pay)];
}
