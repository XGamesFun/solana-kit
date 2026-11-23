// The checks of auctions (auction.rs), and that the setup hands each NFT it names over once: to a stash, a lottery
// or an auction's lot.
import { MAX_BID_NFTS } from '../../client/ix.js';
import { prizeLine, stashNfts, sharesOf } from '../model.mjs';
import { label } from '../format.mjs';
import { FAR_SECONDS } from './dates.mjs';

/** Checks the auctions, and that each NFT is handed over once. */
export function checkAuctions(c) {
  const {
    economy,
    now,
    refuse,
    warn,
    m,
    units,
    fourByteSeconds,
    fromNowSeconds,
    timeAt,
    farTime,
    percent,
    token,
    item,
    prizeBox,
    holdsUp,
    outsideAttribute,
    rule,
    split,
  } = c;
  // ---- auctions (auction.rs)
  for (const a of m.auctions) {
    const where = `economy.auctions.${a.key}`;
    const tok = token(a.currency, `${where}.currency`);
    holdsUp(tok, `${where}.currency`, label(a), 'auction');
    const reserve = a.bidNfts
      ? BigInt(Number.isInteger(a.reserve) ? a.reserve : 1)
      : units(a.reserve, tok, `${where}.reserve`, `${label(a)}’s reserve`);
    if (a.bidNfts) {
      // Bids of NFT bundles (auction.rs): no split, and a reserve a bid of up to three can reach.
      if (a.reserve !== undefined && !(Number.isInteger(a.reserve) && a.reserve >= 1 && a.reserve <= MAX_BID_NFTS))
        refuse(
          'E-AUCTION',
          `${where}.reserve`,
          `${label(a)}’s bids are bundles of NFTs: its reserve counts NFTs, from 1 to ${MAX_BID_NFTS}, the most one bid holds (BadAuction).`,
          `Write a reserve of 1 to ${MAX_BID_NFTS}.`,
        );
      if (sharesOf(a.split).length)
        refuse(
          'E-AUCTION',
          `${where}.split`,
          `${label(a)}’s bids are NFTs: there is no money to take shares of (BadAuction).`,
          'Remove the split.',
        );
      rule(a.bidNfts, `${where}.bidNfts`, `${label(a)}’s bids`);
      outsideAttribute(a.bidNfts, `${where}.bidNfts`, `${label(a)}’s bids`);
      warn(
        'W-NFT-PRICE',
        `${where}.bidNfts`,
        `${label(a)}’s bids are bundles of up to three Core or Token Metadata NFTs (never compressed ones): the bundle with the most wins, a topped bundle goes back to its bidder at once, and the winning NFTs go to ${a.lot?.asset ? 'the seller' : 'the treasury'}. The least raise is in NFTs too (always at least one more).`,
      );
    }
    percent(a.minRaise, `${where}.minRaise`);
    // Its start and its end are times the program keeps in 8 bytes, the push of its end by a late bid in 4.
    const start = timeAt(a.start, `${where}.start`);
    const runs = fromNowSeconds(a.runs, `${where}.runs`, start);
    const extend = fourByteSeconds(a.extendBy ?? '10m', `${where}.extendBy`);
    if (runs === 0)
      refuse(
        'E-AUCTION',
        `${where}.runs`,
        `${label(a)} runs for no time at all: its end must come after its start (BadAuction).`,
        'Give it a time to run, such as "24h".',
      );
    else if (start + runs <= now)
      refuse(
        'E-AUCTION',
        `${where}.start`,
        `${label(a)} would be over before it goes live (BadAuction).`,
        'Start it at "publish", or later.',
      );
    // Nothing but a higher bid hands a high bid back before the end: an end, or a push of it, far off holds the bid and
    // the lot that long. The program takes it; the date is said in words.
    if (runs > 0)
      farTime(
        start + runs,
        `${where}.${start - now > FAR_SECONDS ? 'start' : 'runs'}`,
        `${label(a)}’s end`,
        start - now > FAR_SECONDS ? a.start : a.runs,
        'the high bid and the lot are held',
      );
    farTime(
      now + extend,
      `${where}.extendBy`,
      `${label(a)}’s end, pushed by one bid,`,
      a.extendBy,
      'that bid and the lot are held',
    );
    // No extension or no least raise: two wallets topping each other by a unit in the last seconds keep every other bid
    // out.
    const raise = Number(a.minRaise ?? 5);
    if (!a.bidNfts && (extend < 60 || raise < 1))
      warn(
        'W-AUCTION',
        `${where}.${extend < 60 ? 'extendBy' : 'minRaise'}`,
        `${label(a)} ${extend < 60 ? `moves its end by ${extend ? `only ${extend} seconds` : 'nothing'} after a late bid` : `takes a bid that tops the last by ${raise ? `only ${raise}%` : 'a single unit'}`}: ${extend === 0 && raise === 0 ? 'with both at zero, ' : ''}two wallets topping each other in the last seconds keep every other bid out.`,
        'Give it an extension of 60 seconds or more ("extendBy": "1m") and a least raise of 1% or more ("minRaise": 1).',
      );
    if (a.lot?.item) {
      const it = item(a.lot.item, `${where}.lot.item`);
      if (it?.kind === 'normal')
        warn(
          'W-AUCTION',
          `${where}.lot.item`,
          `${label(a)} sells ${label(it)}, a normal item: the program names the winner, and the game’s backend must deliver it from the receipt.`,
        );
    } else if (a.lot?.roll) {
      // A mystery lot: open_auction refuses one whose box is not written (LotRefused).
      prizeBox(a.lot.roll, `${where}.lot.roll`, label(a), 'E-AUCTION');
      warn(
        'W-AUCTION',
        `${where}.lot.roll`,
        `${label(a)} sells a roll of a box: the winner pays for whatever it rolls, and gets nothing more if what it gives has run out by the end (an empty stash, a sold-out item).`,
        'Keep a stash or item for this auction alone, and say on the page what the box can give, with its odds.',
      );
      c.randomItems = true;
    } else if (a.lot?.asset) {
      // An NFT outside the project's collections: whoever controls its collection can stop it moving or take it
      // back while the project holds it.
      if (a.lot.collection && !m.collections.includes(a.lot.collection))
        warn(
          'W-AUCTION-OUTSIDE',
          `${where}.lot.collection`,
          `${label(a)} sells an NFT of ${a.lot.collection}, outside the project’s collections: whoever controls that collection can stop the NFT moving or take it back while the project holds it. The seller is paid only when the lot reaches the winner; while it cannot move, the winning bid waits in the project’s vault until it can or until the project’s keys call the sale off, and a lot taken back or burned sends the bid back. A bidder’s money can be tied up, not lost. Tell every bidder before a bid.`,
          'Check the NFT and its collection for a permanent freeze, transfer or burn delegate (Core), a rule set (a programmable Token Metadata NFT), or such delegates on a compressed NFT’s collection, before it opens.',
        );
      if (!a.lot.collection && !m.live.project)
        refuse(
          'E-AUCTION',
          `${where}.lot.asset`,
          `${label(a)} sells a collectible of the game’s own collection, which is only made when the economy goes live: there is none to sell yet.`,
          'Sell a new unit of an item ({ "item": key }) now, or add this auction once the economy is live and your wallet holds the collectible.',
        );
    }
    split(a.split, tok, `${where}.split`, { what: label(a) });
    rule(a.gate, `${where}.gate`, label(a));
    if (extend > 0 && extend >= runs && runs > 0)
      warn(
        'W-AUCTION',
        `${where}.extendBy`,
        `${label(a)} moves its end by ${a.extendBy ?? '10m'} after every bid, as long as it runs at all: every bid restarts the clock.`,
        'Use an extension much shorter than the run, such as "10m" for a day.',
      );
    if (reserve === 0n && !a.bidNfts)
      warn(
        'W-AUCTION',
        `${where}.reserve`,
        `${label(a)} has no reserve: one bid of the smallest unit wins it if nobody else bids.`,
        'Set "reserve" to the least you would sell it for.',
      );
    const sameItem = m.auctions.filter(x => a.lot?.item && x.lot?.item === a.lot.item);
    const it = a.lot?.item && m.item.get(a.lot.item);
    if (it?.supply && sameItem.length > it.supply && sameItem[0] === a)
      refuse(
        'E-AUCTION',
        `${where}.lot.item`,
        `${sameItem.length} auctions sell ${label(it)}, and only ${it.supply} can ever be made: each auction keeps its unit from the moment it opens (LotRefused).`,
        `Raise ${label(it)}’s supply, or auction fewer.`,
      );
    warn(
      'W-AUCTION-SHILL',
      where,
      `Anyone can bid on ${label(a)}, the seller and the project included, to push the price up (shill bidding); the program cannot tell them apart.`,
      'Set an honest reserve instead, and say so where players bid.',
    );
  }

  // ---- one NFT is handed over once: the setup moves each NFT it names from the owner's wallet into the place that
  // holds it (a stash, a lottery's own stash, an auction's lot), so a second move of the same NFT fails, the owner no
  // longer holding it (and a lottery's own list refuses one twice, OutOfOrder). Two stashes are said where the
  // stashes are checked (check/pools.mjs).
  {
    const handed = new Map();
    const hand = (nft, where, by) => {
      if (!nft) return;
      handed.set(nft, [...(handed.get(nft) ?? []), { where, by }]);
    };
    for (const s of m.stashes)
      for (const n of stashNfts(s)) hand(n.asset, `economy.stashes.${s.key}.nfts`, `the stash ${label(s)}`);
    for (const l of economy.lotteries ?? []) {
      const at = `economy.lotteries.${l.key}`;
      const nftOf = x => (typeof x === 'string' ? x : x?.nft);
      if (l.raffle) hand(nftOf(l.raffle), `${at}.raffle`, `${label(l)}’s raffle`);
      for (const [i, n] of (l.nfts ?? []).entries()) hand(nftOf(n), `${at}.nfts[${i}]`, `${label(l)}’s own NFTs`);
      for (const [i, p] of (l.places ?? []).entries()) {
        const line = typeof p === 'object' ? prizeLine(p?.prize) : null;
        if (line?.gives === 'nft' && line.held)
          hand(line.nft, `${at}.places[${i}].prize`, `${label(l)}’s place ${i + 1}`);
      }
    }
    for (const a of economy.auctions ?? [])
      if (a.lot?.asset) hand(a.lot.asset, `economy.auctions.${a.key}.lot.asset`, `${label(a)}’s lot`);
    for (const [nft, uses] of handed) {
      if (uses.length < 2 || uses.every(u => u.by.startsWith('the stash '))) continue;
      refuse(
        'E-NFT-TWICE',
        uses[1].where,
        `The NFT ${nft} is handed over ${uses.length} times (${uses.map(u => u.by).join(', ')}): the setup moves it out of your wallet once, and the next move fails because you no longer hold it.`,
        'Name each NFT in one place only: a stash, a lottery or an auction.',
      );
    }
  }
}
