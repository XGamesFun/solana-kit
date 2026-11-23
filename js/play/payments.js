// Payments, for the page client (solanaApp): a payment of tokens, or of an NFT.
import { withSolWrap } from '../chain/programs.js';
import * as loot from '../client/index.js';
import { NO_OPTIONS, only, units } from './common.js';

/**
 * The payment methods.
 * @param {import('./common.js').Ctx} ctx
 */
export function paymentMethods(ctx) {
  const { spec, wallet, programs, client, project, mintOf, decimalsOf, part, nftOf, projectNow, send, holdersOf } = ctx;

  return {
    /**
     * Pays a payment of the economy (an entry, an attempt, a tip). `amount`: what the player chose, in whole units, for
     * a payment with `any` (at least its `amount`). `chosenRecipient`: the wallet the player names for a share the
     * payment lets them choose (a referrer; their own wallet too, which then pays them back their share). `holders`: asset → holder, for a holder's share (read
     * now when not given).
     */
    async pay(paymentKey, { amount: chosen, holders, chosenRecipient = null, ...others } = NO_OPTIONS) {
      only(others, ['amount', 'holders', 'chosenRecipient'], 'pay');
      const p = part('payments', paymentKey);
      const g = await projectNow();
      const mint = mintOf(p.currency);
      const least = units(p.amount, decimalsOf(p.currency));
      if (chosen !== undefined && !p.any) throw new Error(`“${p.name}” has a set amount: ${p.amount}.`);
      const amount = chosen === undefined ? least : units(chosen, decimalsOf(p.currency));
      if (amount < least || amount <= 0n) throw new Error(`“${p.name}” takes at least ${p.amount}.`);
      const pools = new Map((spec.pools ?? []).map(x => [x.key, x.index]));
      // `pay` takes its shares from the payer each time: a "chosen" share pays the wallet they name, and with none named
      // it is left out, so what it would pay goes to the treasury with the rest (as a purchase's does).
      const shares = (p.split ?? []).flatMap(s => {
        const [kind, key] = s.to.split(':');
        const bps = Math.round(s.percent * 100);
        if (kind === 'chosen' && key)
          throw new Error(
            `“${p.name}” pays the holder of a “${key}” the payer names: a payment can’t check the collectible, so its split takes a chosen wallet only.`,
          );
        if (kind === 'chosen') return chosenRecipient ? [{ to: { Wallet: [chosenRecipient] }, bps }] : [];
        const pot = lotteryKey => {
          const l = part('lotteries', lotteryKey);
          if (!Number.isInteger(l.pot))
            throw new Error(
              `“${l.name ?? lotteryKey}” pays each round from its own ticket money: it keeps no pot to pay into.`,
            );
          return loot.pda.lotteryPot(loot.pda.lottery(project, l.id), l.pot);
        };
        const to =
          kind === 'burn'
            ? 'Burn'
            : kind === 'pool'
              ? { Pool: [pools.get(key)] }
              : kind === 'account'
                ? { Account: [key] }
                : kind === 'wallet'
                  ? { Wallet: [key] }
                  : kind === 'treasury'
                    ? 'Treasury'
                    : kind === 'lottery'
                      ? { Account: [pot(key)] }
                      : { Holder: [key] };
        return [{ to, bps }];
      });
      holders ??= shares.some(x => x.to.Holder) ? await holdersOf(shares) : undefined;
      const ix = loot.payIx({
        player: wallet.address,
        project,
        mint,
        treasury: g.treasury,
        amount,
        shares,
        holders,
        programs,
      });
      return send(withSolWrap(wallet.address, mint, amount, [ix]));
    },

    /**
     * Pays with one of the player's NFTs, any kind (`pay_nft`): burned (`to` null), or given to the wallet `to` (the
     * treasury, a partner), straight from the player. The receipt (`PaidNft`) is the record an app admits the player
     * by, with `reference` (32 bytes, or text the client hashes). Returns the signature.
     */
    async payNft(asset, { to = null, reference, ...others } = NO_OPTIONS) {
      only(others, ['to', 'reference'], 'payNft');
      // An NFT paid goes to a wallet: never the project's address or an account of the program (ToTheProject).
      if (to && (to === project || (await client.account(to))?.owner === loot.lootProgram()))
        throw new Error('An NFT paid can’t go to the project or an account of the program: name a wallet, or burn it.');
      const { before, ...nft } = await nftOf(asset);
      return send([...before, loot.payNftIx({ player: wallet.address, project, asset, to, ...nft, reference })]);
    },
  };
}
