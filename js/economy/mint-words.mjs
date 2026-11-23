// What a mint's own powers let whoever holds them do, in words: the one list for every tool that reads a mint from the
// chain (xsolana_token, and going live's check of the mints a spec names). What each power means for an economy's parts
// is the checker's to say, in its own warning (check/tokens.mjs, W-MINT-POWERS). Pure.

/** What each power of a mint's own keys lets its holder do: `powers` as token2022.js `powersOf` names them. */
export const POWER_SAYS = Object.freeze({
  freeze: 'freeze any account holding it, an economy’s pools and vaults included',
  permanentDelegate: 'move or burn it out of any account',
  transferHook: 'run a program of their own on every transfer, which can refuse one',
  feeChangeable: 'raise its transfer fee, up to all of a transfer',
  closeAuthority: 'close the mint and make it again with other powers',
  pausable: 'pause every transfer of it',
  defaultFrozen: 'have every new account of it start frozen',
  defaultState: 'switch every new account of it to start frozen',
});

/** What the mint itself does, whoever controls it: each a sentence of its own. */
export const MINT_SAYS = Object.freeze({
  nonTransferable: 'It cannot be transferred at all: nothing can be paid, staked or given as a prize in it.',
  confidentialTransfers: 'Its holders can turn plain transfers away from their own accounts (confidential transfers).',
});

/**
 * Whether a power the mint has is one somebody can use. A default account state only matters while accounts don't
 * already start frozen and someone can freeze: with no freeze authority nobody can switch it.
 */
export const powerCounts = (power, powers) =>
  Boolean(powers[power]) && (power !== 'defaultState' || (!powers.defaultFrozen && Boolean(powers.freeze)));
