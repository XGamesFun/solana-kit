// The checks of the tokens and the game's currency. A spec with no currency stops the check here: nothing after it
// can be read without one. It also makes the checks the later parts reuse (a token, pool or item named, a prize, a
// rule, a time, a split of a price, a fee's note…), added to the context once it has run.
import { gateList } from '../../client/grant.js';
import { MAX_SHARES } from '../../client/ix.js';
import { vault } from '../../client/pda.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../chain/pda.js';
import { utf8 } from '../../chain/bytes.js';
import { METADATA_LIMITS } from '../../chain/metadata.js';
import {
  feesOf,
  LIMITS,
  RESERVED_ATTRIBUTES,
  fromUnits,
  isAddress,
  keepsPot,
  lotterySplit,
  prizeLine,
  prizePool,
  stashNfts,
  sharesOf,
  toBy,
  utf8Bytes,
  tokenLabels,
} from '../model.mjs';
import { label } from '../format.mjs';
import { isCollectible } from '../sizes.mjs';

/** Checks the tokens and the currency; true when the check stops here. Adds the shared checks to `c`. */
export function checkTokens(c) {
  const { economy, refusals, refuse, warn, m, units, seconds, fourByteSeconds, percent, boostPercent, quietUnits } = c;
  // ---- tokens and the game's currency
  const sols = (economy.tokens ?? []).filter(t => t.source === 'sol');
  if (sols.length > 1)
    refuse('E-TOKEN', 'economy.tokens', 'SOL is listed more than once.', 'Keep one token with source "sol".');
  for (const [i, t] of (economy.tokens ?? []).entries()) {
    const where = `economy.tokens[${i}]`;
    const tok = m.tokens.get(t.key);
    // The source as the model reads it: "project", and "game", its older spelling, are both "game" there.
    const source = tok.source;
    if (source === 'sol' && t.mint && !tok.wsol)
      refuse(
        'E-TOKEN',
        `${where}.mint`,
        `“${t.key}” is SOL, but names another mint.`,
        'Remove the mint: SOL needs none.',
      );
    if (source === 'existing' && (!t.mint || t.decimals === undefined))
      refuse(
        'E-TOKEN',
        where,
        `“${t.key}” is an existing token, so the economy needs its mint address and its decimals.`,
        'Add "mint" (the token’s address) and "decimals": `xsolana token <mint>` (xsolana_token) reads the mint and gives the whole entry. `xsolana approve` reads the mint too and refuses decimals that differ.',
      );
    if (source === 'game' && t.program === 'token-2022')
      refuse(
        'E-NOT-YET',
        `${where}.program`,
        `“${t.key}” is a token the project makes itself, and the setup makes those as classic SPL tokens.`,
        'Remove "program", or use an existing Token-2022 mint (source "existing").',
      );
    // A token the project makes gets its mint when the setup makes it (kept in "live.mints"): one it names already
    // would be minted from without ever being made.
    if (source === 'game' && t.mint)
      refuse(
        'E-TOKEN',
        `${where}.mint`,
        `“${t.key}” is a token the project makes when the economy goes live, but it names the mint ${t.mint}: the setup would never make it, and would mint from an address the project has no say over.`,
        'Remove "mint" for a token the setup makes, or make it an existing token (source "existing", with its "decimals").',
      );
    // A token the setup makes is named on chain as it is made (its Token Metadata record), and the record takes so
    // many bytes of each, not characters: a longer one would be refused on chain, in the middle of going live. One
    // with no name or ticker at all would be written blank, and show as an unknown token for the record's price. A
    // token that is live keeps its words as labels, held to nothing, until they are changed: a change is written to
    // its record, so the new words are held to what a record takes.
    const liveAs = economy.live?.mints?.[t.key]
      ? (economy.live.published?.tokens ?? []).find(x => x.key === t.key)
      : null;
    const written =
      !economy.live?.mints?.[t.key] ||
      (liveAs && JSON.stringify(tokenLabels(liveAs)) !== JSON.stringify(tokenLabels(t)));
    if (source === 'game' && written)
      for (const [field, what] of [
        ['name', 'name'],
        ['symbol', 'ticker'],
        ['uri', 'link'],
      ]) {
        const value = String(tok[field] ?? '');
        const bytes = utf8(value).length;
        if (bytes > METADATA_LIMITS[field])
          refuse(
            'E-TOKEN',
            `${where}.${field}`,
            `The ${what} of “${t.key}” is ${bytes} bytes, and a token’s ${what} on chain is at most ${METADATA_LIMITS[field]} (a letter outside plain English takes two or more).`,
            `Shorten it to ${METADATA_LIMITS[field]} bytes${field === 'uri' ? ', for instance with a shorter path or host' : ''}.`,
          );
        else if (field !== 'uri' && !value.trim())
          refuse(
            'E-TOKEN',
            `${where}.${field}`,
            `“${t.key}” has an empty ${what}: going live writes it on chain as it is, and wallets would show a token with no ${what}.`,
            `Give it a ${what}, or leave "${field}" out (${field === 'symbol' ? 'its key in capitals is used' : 'its ticker is used'}).`,
          );
      }
    if (t.supply !== undefined && source !== 'game')
      refuse(
        'E-TOKEN',
        `${where}.supply`,
        `“${t.key}” is not made by the project, so its supply is whatever its mint says.`,
        'Remove "supply", or make it a token the project makes (source "project").',
      );
    if (source === 'game' && t.supply !== undefined) {
      const supply = units(t.supply, tok, `${where}.supply`, `“${t.key}”’s supply`);
      if (supply === 0n)
        refuse(
          'E-TOKEN',
          `${where}.supply`,
          `“${t.key}” has a supply of 0.`,
          'Give it a supply above 0, or leave "supply" out for a token the game mints.',
        );
      // Everything going live puts in from the owner's own account, which holds the whole supply and nothing more:
      // the pools' seeds, a lottery's, a farm's, and a sealed schedule's funds from the wallet (cost.mjs counts the
      // same four). More than the supply stops the setup at the transfer that runs short, after what came before it
      // has landed. (An amount that is not one is refused with its own part, below.)
      const of = key => (key ?? m.currencyKey) === t.key;
      const puts = [
        ...m.pools.filter(p => of(p.currency)).map(p => p.seed),
        ...m.lotteries.filter(l => of(l.currency)).map(l => l.seed),
        ...m.farms.filter(f => of(f.rewardsToken)).map(f => f.seed),
        ...m.schedules
          .filter(sc => sc.sealed && (sc.fundFrom ?? 'wallet') === 'wallet' && of(sc.currency))
          .map(sc => sc.fund),
      ];
      const seeded = puts.reduce((n, amount) => n + (quietUnits(amount, tok) ?? 0n), 0n);
      if (supply !== null && seeded > supply)
        refuse(
          'E-TOKEN',
          `${where}.supply`,
          `Going live puts in more of “${t.key}” than its whole supply of ${t.supply}: the seeds of its pools, lotteries and farms and the funds of its sealed schedules come to ${Number(seeded) / 10 ** (tok?.decimals ?? 0)}.`,
          'Put in less, or raise the supply.',
        );
    }
    const p = t.powers ?? {};
    percent(p.transferFeePercent, `${where}.powers.transferFeePercent`);
    // A token that can't be transferred moves only by a mint or a burn: nothing can be paid in it, staked, lent or
    // sealed in a vault, and a prize of it given from a pool never arrives. The program takes it; the project hears it.
    if (p.nonTransferable)
      warn(
        'W-MINT-POWERS',
        `${where}.powers`,
        `“${t.key}” cannot be transferred: nothing can be paid in it, staked in a farm, lent, bid or sealed in a vault, and a prize of it can only be minted to its winner. A share of it, a refund or a payout that has to move it never arrives, and a split prize of it minted to a contest's winners must be given up by each one.`,
        'Use it only as points the project mints to players, or use another token.',
      );
    // What each power lets its holder do to a farm's stakes, a vest's vault, a box's payments or a prize.
    const powers = [
      p.freeze &&
        'freeze any account holding it, including the game’s pools and the vault that holds open orders and bids (a frozen vault holds them until it thaws), and so block a repayment or a refund',
      p.permanentDelegate &&
        'move or burn it out of any account, the game’s pools, a farm’s stakes and a sealed vest’s vault included',
      p.closeAuthority && 'close the mint and make it again with other powers',
      p.transferHook &&
        'run its own program on every transfer, which can refuse one and so block a repayment or a refund (a settle that pays a price or its shares in it waits until the hook allows it; a box that rolls, or that a recipe, a mission or a prize rolls, can’t give it as a prize)',
      p.transferFeePercent > 0 &&
        `keep ${p.transferFeePercent}% of every transfer (pools and prizes receive that much less)`,
      p.feeChangeable &&
        'raise its transfer fee, up to 100%, and so take every stake, payment or prize as it leaves a vault',
      p.pausable && 'pause every transfer of it, and so block a repayment, a refund or an unstake',
      p.defaultFrozen && 'start every new account frozen',
      !p.defaultFrozen && p.defaultState && p.freeze && 'switch every new account to start frozen',
      p.mintAuthority === 'someone else' && 'mint more of it whenever its owner wants',
    ].filter(Boolean);
    if (powers.length)
      warn(
        'W-MINT-POWERS',
        `${where}.powers`,
        `Whoever controls the mint of “${t.key}” can ${powers.join('; ')}. The program takes any token: a farm, a vest, a box or a prize in it is only as safe as the token, and players should know.`,
        'Use a mint without those powers, or say so where players buy, stake or are paid.',
      );
    if (source === 'existing' && !t.powers)
      warn(
        'W-MINT-POWERS',
        where,
        `The checker cannot read the mint of “${t.key}” from here, so it does not know what its owner can do (freeze, a permanent delegate, a transfer hook, which no rolled box can give a prize in, or fee).`,
        `Run \`xsolana token ${t.mint ?? '<mint>'}\` (xsolana_token): it reads the mint and gives this entry with "powers" filled in.`,
      );
  }
  if (!m.currency) {
    if (m.currencyKey)
      refuse(
        'E-REF',
        'economy.currency',
        `The game’s currency “${m.currencyKey}” is not in the tokens.`,
        'Add it to "tokens", or name one that is there.',
      );
    else
      refuse(
        'E-CURRENCY',
        'economy.currency',
        'The economy has no currency: the program needs one for the shop’s prices and the treasury.',
        'Add a token (for example { "key": "sol", "source": "sol" }) and name it in "currency".',
      );
    return true;
  }
  const game = m.currency;
  if (economy?.treasury !== undefined && (!m.treasuryWallet || !isAddress(m.treasuryWallet)))
    refuse(
      'E-REF',
      'economy.treasury',
      `The treasury “${economy.treasury}” is not "wallet:<address>".`,
      'Write "wallet:<the wallet’s public address>", or leave it out for the owner’s own wallet.',
    );

  const token = (key, where) => {
    const t = m.tokens.get(key ?? m.currencyKey);
    if (!t) refuse('E-REF', where, `There is no token “${key}”.`, 'Add it to "tokens", or name one that is there.');
    return t;
  };
  const pool = (key, where) => {
    const p = m.pool.get(key);
    if (!p) refuse('E-REF', where, `There is no pool “${key}”.`, 'Add it to "pools", or name one that is there.');
    return p;
  };
  const item = (key, where) => {
    const it = m.item.get(key);
    if (!it) refuse('E-REF', where, `There is no item “${key}”.`, 'Add it to "items", or name one that is there.');
    return it;
  };
  /** A box a prize rolls (`order::prize_roll`): one of this spec's. On chain a lottery's, a contest's or an auction's roll of no box rolls nothing, and a grant's is refused. */
  const prizeBox = (key, where, what, code) => {
    const b = m.box.get(key);
    if (!b)
      refuse(
        code,
        where,
        `${what} gives a roll of “${key}”, which is no box: on chain ${code === 'E-GRANT' ? 'every claim would be refused' : code === 'E-AUCTION' ? 'the auction could not open (LotRefused)' : 'its winner would get no roll'}.`,
        'Name a box of this spec.',
      );
    return b;
  };
  /**
   * A compressed NFT of an item (prize.rs `give_compressed`): a collectible, not soulbound, whose link fits Bubblegum's
   * 200 bytes with its serial in, in a collection that takes compressed NFTs. The setup's own does when it is made
   * with a compressed prize in the spec; one made before never can.
   */
  const compressedCheck = (it, at, what, code) => {
    // The item records whether its collection carries the plugin (`Item::compressed`): without it, a box's open is
    // refused (SoldOut), a sale, a claim or a craft too (PrizeNotCovered), and a finishing route gives nothing.
    const never =
      code === 'E-GRANT' || code === 'E-RECIPE'
        ? 'every claim or craft would be refused (PrizeNotCovered)'
        : code === 'E-ODDS'
          ? 'opening the box would be refused (SoldOut), and buying it (PrizeNotCovered)'
          : 'its winner would get nothing';
    if (!isCollectible(it))
      return refuse(
        code,
        `${at}.compressed`,
        `${what} gives ${label(it)} compressed, but it is a normal item: only a collectible is an NFT.`,
        'Make it a collectible, or leave "compressed" out.',
      );
    if (it.soulbound)
      return refuse(
        code,
        `${at}.compressed`,
        `${what} gives ${label(it)} compressed, but it is soulbound: a compressed NFT can’t be kept from moving, so the program never gives one (${never}).`,
        'Give it as a Core collectible (leave "compressed" out), or make the item tradable.',
      );
    // Its serial at its longest, and each drawn trait's value at its longest (32 bytes) wherever its `{attribute}` is:
    // ten digits for the serial whatever the supply, as the program counts it (prize.rs `longest_uri`), so a link that
    // fits only with a short serial is never given.
    const longest = (it.drawn ?? []).reduce(
      (uri, d) => uri.replaceAll(`{${d.attribute}}`, 'x'.repeat(32)),
      (it.uri ?? '').replaceAll('{serial}', '9'.repeat(10)),
    );
    if (utf8Bytes(longest) > LIMITS.compressedUriBytes)
      refuse(
        code,
        `${at}.compressed`,
        `${label(it)}’s link, its serial written in, is longer than Bubblegum’s ${LIMITS.compressedUriBytes} bytes: ${never}.`,
        'Use a shorter link.',
      );
    if (it.collection)
      warn(
        'W-COMPRESSED',
        `${at}.compressed`,
        `${label(it)} is minted into ${it.collection}: a compressed one is given only if that collection was made with Bubblegum’s plugin (BubblegumV2), which a collection can’t add later; otherwise ${never}.`,
        'Use the setup’s collection, or one made with the plugin.',
      );
    // A new setup still landing made its collection with the plugin, and opens the tree after the project.
    else if (m.live.project && !m.live.tree && !(m.live.partial && !m.live.published))
      refuse(
        code,
        `${at}.compressed`,
        `${what} gives ${label(it)} compressed, but the project’s collection went live without Bubblegum’s plugin, which a collection can’t add later: ${never}.`,
        'Give it as a Core collectible (leave "compressed" out), or mint it into another collection made with the plugin ("collection" on the item).',
      );
  };
  /**
   * A prize (prize.rs, `model.prizeLine`): what it names is this spec's, and it gives something. `code` is the route's
   * refusal code. Returns the prize line, or null.
   */
  const prizeCheck = (given, at, what, code) => {
    const line = prizeLine(given);
    // "held" is a lottery place's NFT, waiting in the lottery's own stash: on a prize that is no NFT it changes nothing
    // (on an NFT outside a lottery's place it is refused, below).
    if (given?.held && line?.gives !== 'nft')
      warn(
        'W-PRIZE',
        `${at}.held`,
        `${what} says "held", which only an NFT a lottery’s place gives uses: here it changes nothing.`,
        'Leave "held" out.',
      );
    if (!line) {
      refuse(
        code,
        at,
        `${what} gives a prize this spec can’t read.`,
        'Write a prize line: { "gives": "item", "item": key }, { "gives": "tokens", "amount": n, "from": "mint" or "pool:<key>" }, { "gives": "nft", "stash": key, "nft": address } or { "gives": "roll", "box": key }.',
      );
      return null;
    }
    if (line.gives === 'ticket') {
      const l = (economy.lotteries ?? []).find(x => x.key === line.lottery);
      if (code !== 'E-GRANT')
        refuse(
          code,
          at,
          `${what} gives tickets in a lottery: only a grant gives tickets (a claim puts them in the round).`,
          'Give tickets from a grant, or give something else here.',
        );
      else if (!l)
        refuse(
          code,
          `${at}.lottery`,
          `${what} gives tickets in “${line.lottery}”, which is no lottery here.`,
          'Name one of "lotteries".',
        );
      else if (l.ticketNft)
        refuse(
          code,
          `${at}.lottery`,
          `${what} gives tickets in ${label(l)}, whose ticket is an NFT: a grant's tickets go only into a lottery that sells for tokens (BadTicket).`,
          'Give tickets in a lottery priced in a token.',
        );
    }
    if (line.split && (code !== 'E-CONTEST' || line.gives !== 'tokens'))
      refuse(
        code,
        `${at}.split`,
        `${what} splits its prize by stake: only a contest's prize of tokens can be split (BadContest).`,
        'Leave "split" out.',
      );
    if (line.gives === 'item') {
      const it = line.item
        ? item(line.item, `${at}.item`)
        : refuse(code, at, `${what} gives an item but does not say which.`, 'Add "item".');
      if (it && it.active === false)
        warn(
          'W-PRIZE',
          `${at}.item`,
          `${what} gives ${label(it)}, which is switched off: no prize gives an item switched off, so ${code === 'E-GRANT' || code === 'E-RECIPE' ? 'the claim or craft is refused' : 'its winner gets nothing'} until it is switched on.`,
          `Switch ${label(it)} on.`,
        );
      if (it && line.compressed) compressedCheck(it, at, what, code);
    } else if (line.compressed) {
      refuse(
        code,
        `${at}.compressed`,
        `${what} gives ${line.gives} compressed: only an item’s collectible can be given as a compressed NFT.`,
        'Leave "compressed" out.',
      );
    } else if (line.gives === 'tokens') {
      const minted = line.from === 'mint';
      const poolKey = prizePool(line);
      if (!minted && !poolKey)
        refuse(
          code,
          `${at}.from`,
          `${what} gives tokens but does not say where from.`,
          'Add "from": "mint" (the game mints them) or "pool:<key>".',
        );
      const p = poolKey ? pool(poolKey, `${at}.from`) : null;
      const t = minted ? token(line.currency, `${at}.currency`) : p ? m.tokens.get(p.currency) : null;
      // A lottery's place passes over a prize it can't mint: taken, and said. Elsewhere the claim or craft fails.
      if (minted && t && !t.gameMints && code === 'E-LOTTERY')
        warn(
          'W-MINT-NOT-OURS',
          `${at}.currency`,
          `${what} mints ${t.symbol}, which the project cannot mint: until the project is the mint’s authority, a pull by anyone but the place’s winner or the project’s keys fails, and the winner or the keys can pass it over for nothing.`,
          'Make the project the mint’s authority before the draw, pay it from a pool ("from": "pool:<key>"), or use a token with source "project".',
        );
      else if (minted && t && !t.gameMints)
        refuse(
          'E-MINT-NOT-OURS',
          `${at}.currency`,
          `${what} mints ${t.symbol}, which the project cannot mint.`,
          'Pay it from a pool ("from": "pool:<key>"), or use a token with source "project".',
        );
      if (p && line.currency && line.currency !== p.currency)
        refuse(
          'E-POOL-MINT',
          `${at}.from`,
          `${what} gives ${m.tokens.get(line.currency)?.symbol ?? line.currency} from “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol}.`,
          `Leave "currency" out: a pool’s prize is in what it holds.`,
        );
      // A prize of 0 tokens is given with nothing moved, on every route.
      if (t && units(line.amount, t, `${at}.amount`, `What ${what[0].toLowerCase()}${what.slice(1)} gives`) === 0n)
        warn(
          'W-ZERO',
          `${at}.amount`,
          `${what} gives 0 ${t.symbol ?? 'tokens'}: the prize is given, and its winner gets nothing.`,
          'Give it an amount above 0, or leave the prize out.',
        );
    } else if (line.gives === 'nft' && line.held) {
      // An NFT a lottery's place holds in the lottery's own stash: a lottery's place only (prize.rs Prize::Held).
      if (code !== 'E-LOTTERY')
        refuse(
          code,
          `${at}.held`,
          `${what} gives a held NFT: only a lottery's place holds one, in its own stash (BadPrize).`,
          'Put it in a stash and give it with "stash", or raffle it in a lottery.',
        );
      if (line.stash)
        refuse(
          code,
          `${at}.stash`,
          `${what} holds its NFT in the lottery's own stash, not in “${line.stash}”.`,
          'Leave "stash" out.',
        );
      if (!isAddress(line.nft))
        refuse(
          code,
          `${at}.nft`,
          `${what} gives the NFT “${line.nft}”, which is not an address.`,
          'Write the NFT’s address (a Core asset).',
        );
    } else if (line.gives === 'nft') {
      const st = line.stash ? m.stash.get(line.stash) : null;
      if (!line.stash)
        refuse(
          code,
          at,
          `${what} gives an NFT but does not say which stash holds it.`,
          'Add "stash": the stash that lists it.',
        );
      else if (!st)
        refuse(
          'E-REF',
          `${at}.stash`,
          `There is no stash “${line.stash}”.`,
          'Add it to "stashes", or name one that is there.',
        );
      if (!isAddress(line.nft))
        refuse(
          code,
          `${at}.nft`,
          `${what} gives the NFT “${line.nft}”, which is not an address.`,
          'Write the NFT’s address (a Core asset, or a Token Metadata NFT’s mint).',
        );
      else if (st && !stashNfts(st).some(n => n.asset === line.nft))
        refuse(
          code,
          `${at}.nft`,
          `${what} gives the NFT ${line.nft}, which ${label(st)} does not list: a prize gives only an NFT a stash of the game holds, so it would never be given.`,
          `List it in ${label(st)}'s "nfts", which puts it in when the economy goes live.`,
        );
    } else if (line.gives === 'roll') prizeBox(line.box, `${at}.box`, what, code);
    else if (line.gives === 'raffled') {
      if (code !== 'E-LOTTERY')
        refuse(
          code,
          `${at}.gives`,
          `${what} gives an NFT drawn from a lottery's own stash: only a lottery's place does (BadPrize).`,
          'Give an NFT of a stash through a box\'s roll ("gives": "stash"), or raffle them in a lottery.',
        );
    } else if (line.gives !== 'ticket')
      refuse(
        code,
        `${at}.gives`,
        `${what} gives “${line.gives}”, which no prize is.`,
        'Use "item", "tokens", "nft", "roll" or, in a lottery\'s place, "raffled".',
      );
    return line;
  };
  /**
   * A token a player can hold up a payment in: its new accounts start frozen or can be switched to, its
   * holders can turn plain transfers away (confidential transfers), or it can't be transferred at all. The program
   * takes it in an auction, an offer, a loan, a lottery and a contest; this says what a player can then do, by `kind`.
   * Only when the spec says so (`powers`).
   */
  const holdsUp = (t, where, what, kind) => {
    const p = t?.powers ?? {};
    const frozen = p.defaultFrozen || (p.defaultState && p.freeze);
    if (!frozen && !p.confidentialTransfers && !p.nonTransferable) return;
    const how = [
      p.defaultFrozen && 'its new accounts start frozen',
      !p.defaultFrozen && frozen && 'its new accounts can be switched to start frozen',
      p.confidentialTransfers && 'its holders can turn plain transfers away (confidential transfers)',
      p.nonTransferable && 'it cannot be transferred at all',
    ].filter(Boolean);
    const does = {
      auction: `the highest bidder can ${[frozen && 'close their own account of it', p.confidentialTransfers && 'turn plain transfers into their own account of it off', !frozen && !p.confidentialTransfers && 'refuse it'].filter(Boolean).join(', or ')} so that every higher bid fails (a topped bid is sent back to that account in the same step as the higher bid), and win at their price. Tell the seller and every bidder.`,
      lottery:
        'a player who turns plain transfers into their own account off (or closes it) holds up only their own part, but the round cannot close meanwhile and its rent waits: keep spare SOL in the lottery ("roundRent") so no buyer fronts it. A pot or pool in a token that could not reach the round gives that round nothing.',
      contest:
        'a winner who closes their own account of it holds up their own claim and the contest’s close; a split prize minted in a token that cannot be transferred must be given up by each winner.',
    }[kind];
    warn(
      'W-HOLD-UP',
      where,
      `${what} is in ${t.symbol ?? t.key}, and ${how.join('; ')}: ${p.nonTransferable ? 'nothing can be paid in, so nobody can take part. ' : ''}${does}`,
      'Use a token with none of those powers, or tell players before they take part.',
    );
  };
  /** Whether `address` is the game's own vault for `t` (where open orders, prizes set aside and bids wait), when both are known. */
  const gameVault = (address, t) =>
    Boolean(
      m.live.project &&
      t?.mint &&
      !t.mint.startsWith('@') &&
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].some(program => vault(m.live.project, t.mint, program) === address),
    );
  /** Whether anything puts money into lottery `l`'s pot: its seed, a place's prize, or a share or schedule that names "lottery:<key>". */
  const lotteryPotFilled = l => {
    const to = `lottery:${l.key}`;
    if (Number(l.seed ?? 0) > 0 || (l.places ?? []).some(p => typeof p === 'object' && p.prize)) return true;
    const splits = [
      ...m.allBoxes,
      ...m.payments,
      ...m.lotteries.map(x => ({ split: lotterySplit(x) })),
      ...m.contests,
      ...m.auctions,
    ].map(x => x.split ?? []);
    if (splits.some(sp => sp.some(share => share.to === to))) return true;
    if (m.schedules.some(sc => sc.to === to)) return true;
    return m.recipes.some(r => (r.in ?? []).some(i => i.to === to));
  };
  /**
   * A route between players the project's keys have no say over (an auction's bids of NFTs, an offer's rule) reads an
   * NFT outside the project's collections without its Sheet: a Core NFT by its own attributes, a Token Metadata or
   * compressed NFT with none, so an attribute test never passes for those there (rules.rs `read_unwritten`).
   */
  const outsideAttribute = (r, where, what) => {
    if (!r?.collection || !r.attribute || m.collections.includes(r.collection)) return;
    warn(
      'W-RULE-OUTSIDE',
      where,
      `${what} test “${r.attribute}” of NFTs of ${r.collection}, outside the project’s collections: there it reads a Core NFT’s own attributes, never what the project wrote in its Sheet, so the test fails for an NFT that doesn’t carry “${r.attribute}” itself (every Token Metadata or compressed NFT).`,
      'Test only the collection, or use Core NFTs that carry the attribute themselves.',
    );
  };
  /** Whether the words on a Token Metadata print were said (once a spec). */
  let printsSaid = false;
  /** Whether the words on NFTs of a collection the project doesn't control were said (once a spec). */
  let outsideSaid = false;
  /** A rule on what an NFT says (rules.rs): an item of the game's must be a collectible; or a collection is named. */
  const rule = (r, where, what) => {
    if (!r) return;
    // A print of a Token Metadata master carries its master's collection, but its master's holder makes it without the
    // collection's authority: the program reads it as in no collection (metadata.rs).
    if (r.collection && isAddress(r.collection) && !m.collections.includes(r.collection) && !printsSaid) {
      printsSaid = true;
      warn(
        'W-RULE-PRINTS',
        `${where}.collection`,
        `${what} names the collection ${r.collection}: if it is a Token Metadata collection, a print of one of its NFTs (an edition of a master) doesn’t count, since whoever holds the master makes prints without the collection’s authority; the program reads a print as in no collection. This holds for every rule on a collection in the spec.`,
        'Nothing to change: tell holders of prints that only the original NFTs count.',
      );
    }
    // An NFT whose creator kept a permanent delegate can be pulled back out of what the project holds.
    if (r.collection && isAddress(r.collection) && !m.collections.includes(r.collection) && !outsideSaid) {
      outsideSaid = true;
      warn(
        'W-OUTSIDE-NFT',
        `${where}.collection`,
        `${what} takes NFTs of ${r.collection}, a collection the project does not control. The creator of an NFT with a permanent delegate can pull it back out of a hold, a stake, a loan or a listing, or burn it there: the record then closes without it (anyone may close it, and nothing is paid: a lender is out the loan). A record nobody closed can still take the next owner’s deposit of the same NFT. This holds for every rule on such a collection in the spec.`,
        'Before a player deposits one, the app closes this project’s records an earlier owner left of the NFT (a listing, a hold), in the same transaction; prefer collections without a permanent delegate.',
      );
    }
    // A gate may list wallets instead (rules.rs Gate::Wallets): a duel's two players, a tournament's entrants.
    // Or a list of any size (rules.rs Gate::List): its root on chain, each player's proof passed as accounts.
    if (r.list !== undefined) {
      r.list.forEach(
        (w, i) =>
          isAddress(w) ||
          refuse(
            'E-REF',
            `${where}.list[${i}]`,
            `${what} lists “${w}”, which is not an address.`,
            'Write the wallet’s public address.',
          ),
      );
      if (!refusals.some(x => x.where.startsWith(`${where}.list`))) {
        const { depth } = gateList(r.list);
        if (depth > 12)
          warn(
            'W-LIST',
            `${where}.list`,
            `${what}’s list is ${depth} levels deep: each player passes ${depth} proof nodes as accounts, ${depth * 32} bytes of their transaction.`,
            'A shorter list, or gate by an NFT they hold.',
          );
        warn(
          'W-LIST',
          `${where}.list`,
          `${what} lets in ${r.list.length} listed wallet${r.list.length === 1 ? '' : 's'}: the program keeps only the list’s root, so the app (or xsolana_play) passes each player’s proof, and the list itself must stay where the app can read it (this spec keeps it).`,
        );
      }
      return;
    }
    // Or a stake (rules.rs Gate::Staked): the wallet's token seat in a farm of tokens holds at least `atLeast`.
    if (r.staked !== undefined) {
      const f = m.farm.get(r.staked.farm);
      if (!f)
        refuse(
          'E-REF',
          `${where}.staked.farm`,
          `${what} asks for a stake in the farm “${r.staked.farm}”, which is not in this economy.`,
          'Name one of "farms" by its key.',
        );
      else if (f.stakes === 'collectibles')
        refuse(
          'E-RULE',
          `${where}.staked.farm`,
          `${what} asks for a stake in ${label(f)}, a farm of collectibles: a stake gate reads a wallet’s seat of tokens.`,
          'Name a farm that stakes a token, or gate by a collectible they hold.',
        );
      else {
        const t = m.tokens.get(f.stakes);
        const least = units(r.staked.atLeast, t, `${where}.staked.atLeast`, `${what}’s stake`);
        if (least === 0n)
          refuse(
            'E-RULE',
            `${where}.staked.atLeast`,
            `${what} asks for a stake of 0, which every wallet has: the program refuses it (BadRule).`,
            'Ask for more than 0, or leave the gate out.',
          );
        // A stake counts only while its tier's lock runs: one with no lock could move to another wallet and count again.
        const tiers = f.tiers ?? [{ lock: 0 }];
        // A tier with no lock, or one a stake can leave early for a fee, never counts (rules.rs Gate::Staked).
        const unlocked = tiers
          .map((x, i) => [x, i])
          .filter(([x]) => seconds(x.lock ?? 0, `${where}.staked.farm`) <= 0 || Number(x.exitFee ?? 0) > 0)
          .map(([, i]) => i + 1);
        if (unlocked.length === tiers.length)
          warn(
            'W-STAKED',
            `${where}.staked.farm`,
            `${what} asks for a stake in ${label(f)}, which has no tier that counts: a stake counts only while it is locked with no early exit (so one stake can’t be unstaked, moved to another wallet and count again), and a stake there never passes (GateNotMet).`,
            `Give ${label(f)} a tier with a "lock" (like "7d") and no "exitFee", or gate by something else.`,
          );
        else if (unlocked.length)
          warn(
            'W-STAKED',
            `${where}.staked.farm`,
            `${label(f)}’s tier${unlocked.length === 1 ? '' : 's'} ${unlocked.join(', ')} ${unlocked.length === 1 ? 'has' : 'have'} no lock, so a stake in ${unlocked.length === 1 ? 'it' : 'them'} never passes ${what}’s gate: only a locked stake counts.`,
            'Tell players to stake in a locked tier, or give every tier a lock.',
          );
        if (least !== null && least !== 0n && unlocked.length < tiers.length)
          warn(
            'W-STAKED',
            `${where}.staked`,
            `${what} lets in a wallet with at least ${r.staked.atLeast} ${t?.symbol ?? f.stakes} staked in ${label(f)} while its lock runs, staked before the second it is used (so it can’t be staked, used and unstaked in one transaction, and one stake counts for one wallet a lock). The app (or xsolana_play) passes the wallet’s seat and the farm; staking more counts at once, and the gate shuts once the lock ends (staking again starts a new lock).`,
          );
      }
      return;
    }
    if (r.wallets !== undefined) {
      if (!r.wallets.length)
        warn(
          'W-GATE',
          `${where}.wallets`,
          `${what} lists no wallets: nobody passes it.`,
          'List the wallets it lets in, or leave the gate out.',
        );
      r.wallets.forEach(
        (w, i) =>
          isAddress(w) ||
          refuse(
            'E-REF',
            `${where}.wallets[${i}]`,
            `${what} lists “${w}”, which is not an address.`,
            'Write the wallet’s public address.',
          ),
      );
      return;
    }
    if (r.items !== undefined) {
      if (r.item || r.collection || r.attribute)
        refuse(
          'E-RULE',
          where,
          `${what} names "items" and an item, a collection or an attribute: "items" alone means any of those items.`,
          'Keep "items", or the other form.',
        );
      if (!Array.isArray(r.items) || !r.items.length)
        refuse('E-RULE', `${where}.items`, `${what} names no items.`, 'Name at least one item.');
      for (const [i, k] of (r.items ?? []).entries()) {
        const it = item(k, `${where}.items[${i}]`);
        if (it && !isCollectible(it))
          refuse(
            'E-RULE',
            `${where}.items[${i}]`,
            `${what} asks for ${label(it)}, a normal item: only collectibles can be shown.`,
            `Make ${label(it)} a collectible.`,
          );
      }
      return;
    }
    // "One of" takes as many texts as the record that holds the rule fits (rules.rs): bounded where it is read, a
    // lottery's NFT ticket and a box's gate and odds.
    if (r.oneOf !== undefined && (!Array.isArray(r.oneOf) || !r.oneOf.length))
      refuse('E-RULE', `${where}.oneOf`, `${what} lists no texts in "oneOf".`, 'List at least one text.');
    if (r.oneOf !== undefined && (r.equals !== undefined || r.atLeast !== undefined || r.time !== undefined))
      refuse(
        'E-RULE',
        where,
        `${what} asks for "oneOf" and another test at once.`,
        'Keep one of "atLeast", "equals", "oneOf" and "time".',
      );
    if (
      (r.atLeast !== undefined || r.equals !== undefined || r.oneOf !== undefined || r.time !== undefined) &&
      !r.attribute
    )
      refuse(
        'E-RULE',
        where,
        `${what} tests a number, a text or a time but names no attribute.`,
        'Add "attribute", or leave the test out to ask only for the item.',
      );
    if (r.time !== undefined && (r.atLeast !== undefined || r.equals !== undefined))
      refuse(
        'E-RULE',
        where,
        `${what} asks for a time and for a number or a text at once.`,
        'Keep one of "time", "atLeast" and "equals".',
      );
    if (!r.item && !r.collection && !r.attribute)
      refuse(
        'E-RULE',
        where,
        `${what} asks for nothing: no item, no collection and no attribute.`,
        'Name the item or the collection players must hold, an attribute, or both.',
      );
    if (r.item && r.collection)
      refuse(
        'E-RULE',
        where,
        `${what} names both an item and a collection: a rule is about one.`,
        'Keep "item" for an item the game mints, or "collection" for any NFT of a collection.',
      );
    if (r.collection && !isAddress(r.collection))
      refuse(
        'E-REF',
        `${where}.collection`,
        `${what} names the collection “${r.collection}”, which is not an address.`,
        'Write the Core collection’s address, or the Token Metadata collection mint.',
      );
    if (r.atLeast !== undefined && r.equals !== undefined)
      refuse(
        'E-RULE',
        where,
        `${what} asks for an attribute that is both at least a number and equal to a text.`,
        'Keep one of "atLeast" and "equals".',
      );
    if (r.item) {
      const it = item(r.item, `${where}.item`);
      if (it && !isCollectible(it))
        refuse(
          'E-RULE',
          `${where}.item`,
          `${what} asks players to show ${label(it)}, a normal item: only collectibles can be shown.`,
          `Make ${label(it)} a collectible.`,
        );
    }
    if (RESERVED_ATTRIBUTES.includes(r.attribute) && !['rarity', 'serial', 'made', 'used'].includes(r.attribute))
      warn('W-RULE', `${where}.attribute`, `${what} reads “${r.attribute}”, which only the program writes.`);
  };
  /** A raise or a shift that may move a time (`fromNow`): durations only with it, and a key a farm keeps a time under moved only with it. */
  const timed = (x, where, what, code) => {
    const durations = typeof x.by === 'string' || typeof x.upTo === 'string';
    const key = x.key ?? x.attribute;
    const kept = m.farms.find(f => f.lockAttribute === key || f.upkeepAttribute === key);
    if (durations && !x.fromNow && !kept)
      refuse(
        code,
        where,
        `${what} by a duration, but it is not a time.`,
        'Add "fromNow": true to move a time from now, or write plain numbers.',
      );
    if (typeof x.upTo === 'string' && !x.fromNow)
      refuse(
        code,
        `${where}.upTo`,
        `${what} up to ${x.upTo}, a time from now, but it does not count from now.`,
        'Add "fromNow": true, or leave "upTo" out.',
      );
    if (kept && !x.fromNow && !durations)
      warn(
        'W-TIME',
        where,
        `${what}, which ${label(kept)} keeps as a time (Unix seconds), by a plain number: ${toBy(x.by)} seconds.`,
        'Write "by" as a duration ("1d"), with "fromNow": true to count from now.',
      );
  };
  const effect = (e, where, what) => {
    if (!e) return;
    if (e.addPercent === undefined && e.perPointPercent === undefined)
      refuse('E-RULE', where, `${what} adds nothing.`, 'Give it "addPercent", or "perPointPercent" (with "upTo").');
    if (e.addPercent !== undefined && e.perPointPercent !== undefined)
      refuse('E-RULE', where, `${what} has both a flat boost and a boost per point.`, 'Keep one.');
    boostPercent(e.addPercent, `${where}.addPercent`);
    boostPercent(e.perPointPercent, `${where}.perPointPercent`);
    // With no "upTo" a boost per point counts every point there could be (4,294,967,295, model.mjs `effectOf`), and any
    // percent a point times that is past what a boost may add (rules.rs `Boost::check`): the program refuses it.
    if (e.perPointPercent > 0 && e.upTo === undefined)
      refuse(
        'E-RULE',
        `${where}.upTo`,
        `${what} adds ${e.perPointPercent}% a point with no "upTo": it would count up to 4,294,967,295 points, past the +${(LIMITS.maxBoostBps / 100).toLocaleString('en-US')}% a boost may add (BadFarm, BadBox).`,
        'Give it "upTo": the most points it counts (a level cap, say).',
      );
  };
  /** Where an NFT a box rolls on (or takes as its price) goes: an address to give it to, or one of the spec's stashes. */
  const thenCheck = (then, where, what) => {
    if (then?.giveTo && !isAddress(then.giveTo))
      refuse(
        'E-ROLL',
        `${where}.giveTo`,
        `${what} gives the NFT to “${then.giveTo}”, which is not an address.`,
        'Write a wallet address.',
      );
    if (then?.stash && !m.stash.get(then.stash))
      refuse(
        'E-REF',
        `${where}.stash`,
        `There is no stash “${then.stash}” for ${what} to put the NFT in.`,
        'Add it to "stashes", or name one that is there.',
      );
  };
  for (const p of m.pools)
    if (!m.tokens.has(p.currency))
      refuse(
        'E-REF',
        `economy.pools.${p.key}.currency`,
        `The pool “${p.key}” holds “${p.currency}”, which is not in the tokens.`,
        'Add the token, or name one that is there.',
      );

  /**
   * A split carried out in `tok`: percents, at most 8 shares (any number in a payment's) and 100% at most (state.rs check_later_shares), pools of the same
   * token, and no share that burns in wrapped SOL (the program refuses it). What the shares leave goes to the
   * treasury wallet's account of `tok`, whatever token it is. `chosen`: the buyer may name one share ("chosen",
   * "chosen:<item>"): a box's or a lottery's split; 'wallet': only "chosen", a wallet (a payment's split).
   */
  let holderSaid = false;
  const split = (list, tok, where, { what, chosen = false, single = false }) => {
    // Where share `i` is: one destination given alone (`single`) is the field itself.
    const to = i => (single ? where : `${where}[${i}].to`);
    const shares = sharesOf(list);
    shares.forEach((s, i) => percent(s.percent, `${where}[${i}].percent`));
    const total = shares.reduce((n, s) => n + (s.bps ?? 0), 0);
    if (total > 10_000)
      refuse(
        'E-SPLIT',
        where,
        `${what}’s shares add up to ${total / 100}%, more than the whole payment.`,
        'Make them add up to 100% or less; the treasury gets what they leave.',
      );
    if (shares.filter(s => s.kind === 'chosen').length > 1)
      refuse('E-CHOSEN', where, `${what} lets the buyer choose more than one share.`, 'Let them choose one.');
    // A split kept to be paid later (a box's, a lottery's, a contest's, an auction's) holds at most 8 shares; a
    // payment's is paid at once and has no such cap.
    if (chosen !== 'wallet' && shares.length > MAX_SHARES)
      refuse(
        'E-SPLIT',
        where,
        `${what}’s split has ${shares.length} shares; the program keeps at most ${MAX_SHARES} (BadShares).`,
        `Merge some, to ${MAX_SHARES} or fewer.`,
      );
    for (const [i, s] of shares.entries()) {
      if (s.kind === 'pool') {
        const p = pool(s.key, to(i));
        if (p && tok && p.currency !== tok.key)
          refuse(
            'E-POOL-MINT',
            to(i),
            `${what} is paid in ${tok.symbol}, but the pool “${p.key}” holds ${m.tokens.get(p.currency)?.symbol ?? p.currency}.`,
            `Send it to a pool of ${tok.symbol}.`,
          );
      }
      // A lottery's pot of this spec, in the token the share is paid in.
      if (s.kind === 'lottery') {
        const l = m.lottery.get(s.key);
        const potKey = l?.currency ?? m.currencyKey;
        if (!l) refuse('E-REF', to(i), `There is no lottery “${s.key}”.`, 'Name one of "lotteries" by its key.');
        else if (!keepsPot(l))
          refuse(
            'E-LOTTERY',
            to(i),
            `${what} sends a share to ${label(l)}, which pays each round from that round's own ticket money ("rest"): it keeps no pot for the share to land in.`,
            `Give ${label(l)} a pot ("pot": 0) to take gifts and shares, or send the share elsewhere.`,
          );
        else if (tok && potKey !== tok.key)
          refuse(
            'E-POOL-MINT',
            to(i),
            `${what} is paid in ${tok.symbol}, but the pot of ${label(l)} is in ${m.tokens.get(potKey)?.symbol ?? potKey}.`,
            `Send it to a lottery whose pot is in ${tok.symbol}.`,
          );
      }
      // A farm's rewards vault of this spec, in the token the share is paid in.
      if (s.kind === 'farm') {
        const f = m.farm.get(s.key);
        if (!f) refuse('E-REF', to(i), `There is no farm “${s.key}”.`, 'Name one of "farms" by its key.');
        else if (tok && f.rewardsToken !== tok.key)
          refuse(
            'E-POOL-MINT',
            to(i),
            `${what} is paid in ${tok.symbol}, but ${label(f)}’s rewards are ${m.tokens.get(f.rewardsToken)?.symbol ?? f.rewardsToken}.`,
            `Send it to a farm whose rewards are ${tok.symbol}.`,
          );
      }
      // A holder's share names the holder when it is paid.
      if ((s.kind === 'holder' || (s.kind === 'chosen' && s.key)) && !holderSaid) {
        holderSaid = true;
        warn(
          'W-HOLDER-SHARE',
          to(i),
          `${what} pays a share to whoever holds a collectible: the settle names the holder at that moment, and if the holder moves the collectible first, the settle fails and is sent again with the holder read afresh.`,
        );
      }
      if (['account', 'holder', 'wallet'].includes(s.kind) && !isAddress(s.key))
        refuse(
          'E-REF',
          to(i),
          `${what} sends a share to “${s.to}”, which is not an address.`,
          `Write "${s.kind}:<address>".`,
        );
      // A token account named as it is can't be opened for anyone: while none is there, its share goes to the treasury.
      if (s.kind === 'account' && isAddress(s.key) && gameVault(s.key, tok))
        refuse(
          'E-SPLIT',
          to(i),
          `${what} sends a share to the game’s own vault for ${tok.symbol}, where open orders, prizes set aside and bids wait: the program refuses it (it would mix into what those records hold).`,
          'Send it to a pool ("pool:<key>") or the treasury instead.',
        );
      else if (s.kind === 'account' && isAddress(s.key))
        warn(
          'W-PAYEE',
          to(i),
          `${what} pays a share to the token account ${s.key.slice(0, 4)}…: while no ${tok?.symbol ?? 'such'} account is there, that share goes to the treasury instead.`,
          `For a person's wallet, write "wallet:${s.key}": the program pays their own ${tok?.symbol ?? ''} account, and opens it when it is not there.`,
        );
      if (s.kind === 'chosen' && !chosen)
        refuse(
          'E-CHOSEN',
          to(i),
          `${what} can’t let anyone choose where a share goes: only a buyer chooses, when they pay (a box, a shop item, a lottery’s tickets, a payment).`,
          'Name the destination, or sell it as a box with one outcome that gives nothing (or the item): a box can carry the "chosen" share, a gate and opens/closes.',
        );
      // `pay` takes its shares from the payer as they are and checks no collectible against an item: a holder's share
      // the payer picks could name any collectible at all.
      else if (s.kind === 'chosen' && s.key && chosen === 'wallet')
        refuse(
          'E-CHOSEN',
          to(i),
          `${what} lets the payer pick a “${s.key}” whose holder is paid, but a payment can’t check that the collectible they name is one: only a box’s (or shop item’s) and a lottery’s buyer picks a collectible of an item.`,
          'Write "chosen" for a wallet the payer names (a referrer), or sell it as a box with one outcome that gives nothing: a box’s split can carry "chosen:<item>".',
        );
      if (s.kind === 'chosen' && s.key && !m.item.has(s.key))
        refuse(
          'E-REF',
          to(i),
          `${what} lets the buyer pick a “${s.key}”, which is not an item.`,
          'Name an item of the game ("chosen:<item key>"), or write "chosen" for a wallet.',
        );
      if (tok?.wsol && s.kind === 'burn')
        refuse(
          'E-WSOL-BURN',
          to(i),
          `${what} is paid in SOL, and wrapped SOL cannot be burned.`,
          'Send that share to a pool or a wallet instead.',
        );
    }
    return total;
  };

  const feeNote = (price, tok, where, what) => {
    if (!tok?.wsol || price === null) return;
    if (price === 0n) return;
    const ratio = Number(feesOf(economy).player) / Number(price);
    if (ratio >= 0.01)
      warn(
        'W-FEE',
        where,
        `Every ${what} also pays the platform’s player fee of ${fromUnits(feesOf(economy).player, 9)} SOL: ${(ratio * 100).toFixed(1)}% on top of its ${fromUnits(price, 9)} SOL price.`,
        'Fine for a game; a higher price makes the fee a smaller part of it.',
      );
  };
  /** A part's "perWalletEach": its window (a day when it names none) in 4 bytes. */
  const perWalletWindow = (part, where) => {
    if (part.perWalletEach) fourByteSeconds(part.perWalletEach.every ?? '1d', `${where}.perWalletEach.every`);
  };
  const prices = (part, tok, where) => {
    if (part.rise) {
      units(part.rise.step, tok, `${where}.rise.step`, `${label(part)}’s rise`);
      percent(part.rise.growthPercent, `${where}.rise.growthPercent`);
    }
    if (part.fall) {
      const step = units(part.fall.step, tok, `${where}.fall.step`, `${label(part)}’s fall`);
      if (fourByteSeconds(part.fall.every, `${where}.fall.every`) === 0)
        refuse(
          'E-PRICE',
          `${where}.fall.every`,
          `${label(part)}’s price falls every 0 seconds: the program refuses it.`,
          'Give the fall a time above 0.',
        );
      else if (step === 0n)
        warn(
          'W-PRICE',
          `${where}.fall.step`,
          `${label(part)}’s price falls by 0: it never falls.`,
          'Give the fall a step above 0, or leave "fall" out.',
        );
      const floor = units(part.fall.floor, tok, `${where}.fall.floor`, `${label(part)}’s floor`);
      if (floor === 0n)
        warn(
          'W-PRICE',
          `${where}.fall.floor`,
          `${label(part)}’s price can fall to 0: once it gets there, it is free until a rise lifts it.`,
          'Give the fall a floor above 0 if it should never be free.',
        );
    }
  };
  Object.assign(c, {
    game,
    token,
    pool,
    item,
    prizeBox,
    compressedCheck,
    prizeCheck,
    holdsUp,
    gameVault,
    lotteryPotFilled,
    outsideAttribute,
    rule,
    timed,
    effect,
    thenCheck,
    split,
    feeNote,
    perWalletWindow,
    prices,
  });
}
