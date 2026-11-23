// Grants, for the page client (solanaApp): a grant claimed with the project's voucher, and the prizes a results server
// vouched for (`claimWins`).
import { decodeBase58 } from '../chain/base58.js';
import { COMPUTE_BUDGET_PROGRAM } from '../chain/pda.js';
import { computeUnitLimit } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { NO_OPTIONS, only, units } from './common.js';

/**
 * The grant methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function grantMethods(ctx) {
  const {
    spec,
    wallet,
    programs,
    client,
    project,
    part,
    read,
    personFor,
    prizeInputs,
    projectNow,
    passing,
    listProofOf,
    send,
    sendRolling,
  } = ctx;

  return {
    /**
     * Claims a grant for the connected wallet: from the approved list (the proof comes from xsolana.json, or is given:
     * `proof`, `personHash` and the `round` the list pays, as a results server's list answers them), or with a voucher
     * a server signed ({ publicKey, signature, incarnation, round and amount, or rounds: [{ id, amount }], expires, personHash }). A list in xsolana.json names
     * no round (zeros). `amount` (a voucher's, or `options.amount` for a list's leaf): the tokens this claim gives, in
     * base units, up to the grant's own, for a grant of a fixed amount of tokens (a reward by rank); absent or 0 gives
     * the grant's prize as it is. A grant that gives a roll of a box makes the wallet's roll, which `claims()` then
     * lists and `collect` asks for and settles.
     */
    async claimGrant(grantKey, options = {}) {
      only(options, ['voucher', 'proof', 'personHash', 'round', 'amount', 'shown', 'listProof'], 'claimGrant');
      let {
        voucher = null,
        proof: given = null,
        personHash: listPerson = null,
        round: listRound = null,
        amount: listAmount = 0n,
        shown,
      } = options;
      const gspec = part('grants', grantKey);
      const address = loot.pda.grant(project, gspec.id);
      const grant = await read('Grant', address);
      shown ??= await passing(grant.gate, 'claim this');
      const gateProof = listProofOf(grant.gate, gspec.gate?.list, options.listProof);
      // What the grant has paid this wallet: its count of claims (an open claim's roll is named by it), and the rounds
      // paid (one paid already is skipped).
      const bits = grant.shard_bits;
      const [claimsShard, roundsShard] = await client.accounts([
        loot.pda.claims(address, grant.incarnation, loot.shardOf(loot.limitKey('wallet', wallet.address), bits)),
        loot.pda.rounds(address, grant.incarnation, loot.walletShard(grant, wallet.address)),
      ]);
      const count = loot.readLimit(loot.readListAccount(claimsShard), loot.limitKey('wallet', wallet.address)).count;
      const paidRounds = loot.readListAccount(roundsShard);
      // What its prize needs: a pool's mint, the item, an NFT's kind (a compressed one proven first).
      const prized = await prizeInputs([grant.gives]);
      // Tickets a grant gives go into its lottery's current round, read now.
      const lotteries = grant.gives.Ticket
        ? {
            [grant.gives.Ticket.lottery]: await read('Lottery', loot.pda.lottery(project, grant.gives.Ticket.lottery)),
          }
        : {};
      // A grant counted by person: the person the voucher names, else the wallet's link (sent first when the server
      // gave one), else none (refused).
      const { issuer } = await projectNow();
      const byPerson = Boolean(grant.limits.wallet.by_person);
      // Who is who is the issuer's word: the person a voucher of the issuer's names, or the list's; else the link's.
      const some = p => Boolean(p) && !/^0+$/.test(typeof p === 'string' ? p : Array.from(p).join(''));
      const named = voucher ? voucher.publicKey === issuer && some(voucher.personHash) : some(listPerson);
      const linked =
        byPerson && !named ? await personFor({ ...grant.limits.wallet, total: 1 }) : { person: null, ixs: [] };
      const pool = grant.gives.Tokens?.from.Pool?.[0];
      const poolMint = pool !== undefined ? prized.poolMints[pool] : null;
      const item = prized.items[grant.gives.Item?.[0] ?? grant.gives.Compressed?.item] ?? null;
      const instructions = [...prized.before, ...linked.ixs];
      let proof = [];
      const keys = gspec.keys ?? [];
      if (voucher) {
        if (voucher.incarnation == null || BigInt(voucher.incarnation) !== grant.incarnation)
          throw new Error('This voucher belongs to a different grant incarnation.');
        const message = loot.voucherBytes({
          grant: address,
          incarnation: grant.incarnation,
          wallet: wallet.address,
          personHash: voucher.personHash,
          rounds: voucher.rounds,
          round: voucher.round,
          expires: voucher.expires,
          amount: BigInt(voucher.amount ?? 0),
        });
        const signature = typeof voucher.signature === 'string' ? decodeBase58(voucher.signature) : voucher.signature;
        instructions.push(loot.ed25519Ix({ publicKey: voucher.publicKey, signature, message }));
        // A key under the grant's key root (a promo code's) proves it is one of them.
        const at = keys.indexOf(voucher.publicKey);
        proof =
          given ??
          (at >= 0
            ? loot.merkleProof(
                keys.map(k => loot.keyLeaf(k)),
                at,
              )
            : []);
      } else if (given) {
        proof = given;
      } else if ((gspec.list ?? []).length) {
        // An entry is an address (the grant's amount, round 0), or { wallet, amount, round } (whole units of the grant's
        // token): a wallet listed under several rounds claims each once (`options.round`, a number; the first by default).
        const list = gspec.list.map(e => (typeof e === 'string' ? { wallet: e } : e));
        const mint = grant.gives.Tokens?.from.Mint?.[0] ?? poolMint;
        const decimals =
          mint && list.some(e => e.amount !== undefined) ? ((await client.account(mint))?.data?.[44] ?? 0) : 0;
        const leaves = list.map(e =>
          loot.listLeaf(
            e.wallet,
            null,
            loot.listRound(e.round ?? 0),
            e.amount !== undefined ? units(e.amount, decimals) : 0n,
          ),
        );
        const at = list.findIndex(
          e => e.wallet === wallet.address && (typeof listRound !== 'number' || (e.round ?? 0) === listRound),
        );
        if (at < 0) throw new Error('This wallet is not on the list for this grant.');
        proof = loot.merkleProof(leaves, at);
        listRound = loot.listRound(list[at].round ?? 0);
        if (list[at].amount !== undefined) listAmount = units(list[at].amount, decimals);
      } else if ((gspec.vouchers ?? []).length || keys.length) {
        throw new Error('This grant pays a wallet a voucher key signs for: pass the voucher.');
      }
      // What this claim gives: the amount the voucher or the list's leaf names (0: the grant's prize as it is).
      const amount = BigInt((voucher ? voucher.amount : listAmount) ?? 0);
      const most = grant.gives.Tokens?.amount;
      if (amount > 0n && (most === undefined || amount > BigInt(most)))
        throw new Error(
          `This claim names ${amount} tokens, more than this grant gives${most === undefined ? ' (it gives no fixed amount of tokens)' : ` (${most})`}.`,
        );
      instructions.push(
        loot.claimGrantIx({
          project,
          id: gspec.id,
          grant,
          wallet: wallet.address,
          signer: wallet.address,
          count,
          rounds: voucher?.rounds,
          round: voucher?.round ?? listRound,
          expires: voucher?.expires,
          personHash: voucher?.personHash ?? listPerson,
          amount,
          proof,
          paidRounds,
          poolMint,
          item,
          nft: prized.nft,
          shown,
          listProof: gateProof,
          programs,
          voucherKey: voucher?.publicKey,
          lotteries,
          issuer,
          linkedPerson: linked.person,
        }),
      );
      // A claim's records and prizes can pass the 200,000 compute units a transaction has by default.
      const all = [
        computeUnitLimit(grant.gives.Roll ? 1_400_000 : loot.CLAIM_COMPUTE_UNITS),
        ...instructions.filter(x => x.programId !== COMPUTE_BUDGET_PROGRAM),
      ];
      if (!grant.gives.Roll) return send(all);
      // A roll's orders are asked for in the claim's own transaction and settled by a key after: one prompt.
      const { signature, rolls } = await sendRolling(all);
      return rolls.length ? { signature, rolls } : signature;
    },

    /**
     * Takes every prize a results server vouched for this wallet's wins, or put on a list (`server`: its URL;
     * a results server), page by page. Each pays only this wallet, within the grant's limits. Returns [{ round, grant,
     * signature }] for each claim made, and [{ round, grant, error }] for one that failed, without stopping the rest;
     * wins already claimed are skipped (the program pays a wallet each round once per grant incarnation).
     *
     * `token`: the player's play-host sign-in for this game. A drop that gives NFTs from a stash gives one only at a
     * signed-in claim, first come first served (the server answers `R-SIGN-IN` to a voucher request with no sign-in, so
     * a stranger can't hand them out): with the token such a win is claimed through `POST /v1/claims`; without it, it is
     * [{ round, grant, error }].
     */
    async claimWins({ server, token = null, fetchImpl = globalThis.fetch, ...others } = NO_OPTIONS) {
      only(others, ['server', 'token', 'fetchImpl'], 'claimWins');
      const base = server.replace(/\/$/, '');
      const ask = async (path, init) => {
        // (one server answers for both clusters: a request for mainnet says so, one for devnet names none, as before)
        const at = path.startsWith('http') ? path : `${base}${path}`;
        const on = loot.cluster();
        const url =
          on === 'devnet' || /[?&]cluster=/.test(at) ? at : `${at}${at.includes('?') ? '&' : '?'}cluster=${on}`;
        const r = await fetchImpl(url, init);
        // The status first: a proxy's error page is no JSON, and says nothing a player can act on but its status.
        const body = await r.json().catch(() => null);
        if (!r.ok)
          throw Object.assign(new Error(body?.error?.why ?? `The results server answered ${r.status}.`), {
            code: body?.error?.code,
            status: r.status,
          });
        if (body === null || typeof body !== 'object')
          throw new Error(`The results server answered ${r.status} with no JSON.`);
        return body;
      };
      const get = path => ask(path);
      // Where a list's proof is, as the server named it: a path on the server itself, or a whole URL on the server's own
      // origin. Any other place is refused before anything is fetched, so a server's answer can't send the page to
      // another host. A server given as a path (such as "/results") is on the page's own origin.
      const proofAt = proof => {
        const said = String(proof ?? '');
        let origin = null;
        let url = null;
        try {
          const home = new URL(`${base}/`, globalThis.location?.href);
          origin = home.origin;
          url = new URL(
            said.startsWith('/') && !said.startsWith('//') ? `${home.href.replace(/\/$/, '')}${said}` : said,
            home,
          );
        } catch {
          // not a URL at all: refused below
        }
        if (!url || origin === null || origin === 'null' || url.origin !== origin)
          throw new Error(
            `The results server named a list's proof at “${said}”, which is not on the server itself (${origin ?? base}): it was not fetched.`,
          );
        return url.href;
      };
      // Each value in a query is encoded: a round or a page the server named can't change the request's path.
      const q = value => encodeURIComponent(String(value));
      // A win's vouchers; a stash drop's NFT not given yet: the signed-in claim's, those for this wallet
      const vouchersOf = async round => {
        try {
          return (await get(`/v1/vouchers?game=${q(project)}&round=${q(round)}&wallet=${q(wallet.address)}`)).vouchers;
        } catch (e) {
          if (e.code !== 'R-SIGN-IN' || !token) throw e;
          const { vouchers } = await ask('/v1/claims', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ game: project, round, token }),
          });
          return vouchers.filter(v => v.wallet === wallet.address);
        }
      };
      const claimed = async (grantId, incarnation, round) => {
        const address = loot.pda.grant(project, grantId);
        const grant = await read('Grant', address);
        if (incarnation != null && BigInt(incarnation) !== BigInt(grant.incarnation)) return false;
        const shard = await client.account(
          loot.pda.rounds(address, grant.incarnation, loot.walletShard(grant, wallet.address)),
        );
        return loot.roundPaid(loot.readListAccount(shard), wallet.address, round);
      };
      const out = [];
      const take = async (round, grant, claim) => {
        try {
          const r = await claim();
          out.push({ round, grant, ...(typeof r === 'string' ? { signature: r } : r) });
        } catch (e) {
          out.push({ round, grant, error: e.message });
        }
      };
      // Page by page, until a page names no next one (null, or left out) or one already read: a server that leaves it
      // out, or names the same page again, must not have it read again and again.
      let page = { next: '' };
      const pagesRead = new Set();
      for (let first = true; first || (page.next && !pagesRead.has(page.next)); first = false) {
        pagesRead.add(page.next);
        page = await get(
          `/v1/wins?game=${q(project)}&wallet=${q(wallet.address)}${page.next ? `&before=${q(page.next)}` : ''}`,
        );
        for (const win of page.wins.filter(x => x.grant !== null && x.grant !== undefined)) {
          // one win that fails (its vouchers refused, a sign-in run out, a list not there) is its own error line, and
          // the rest go on (a refused POST /v1/claims must not stop every later win)
          try {
            for (const v of await vouchersOf(win.round)) {
              const grantKey = (spec.grants ?? []).find(x => x.id === v.grant)?.key;
              if (!grantKey) continue;
              if (v.list) {
                // Paid by a list the owner wrote from the draw: its proof names the round.
                const list = await get(proofAt(v.proof));
                const mine = list.winners.find(w => w.wallet === wallet.address);
                if (!mine || (await claimed(v.grant, null, list.round))) continue;
                await take(win.round, v.grant, () =>
                  this.claimGrant(grantKey, {
                    proof: mine.proof,
                    personHash: mine.personHash,
                    round: list.round,
                    amount: mine.amount ?? 0,
                  }),
                );
              } else if (v.signature && !(await claimed(v.grant, v.incarnation, v.round))) {
                await take(win.round, v.grant, () => this.claimGrant(grantKey, { voucher: v }));
              }
            }
          } catch (e) {
            out.push({ round: win.round, grant: win.grant, error: e.message });
          }
        }
      }
      return out;
    },
  };
}
