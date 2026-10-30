// The checker's legal flags in plain words: what the person must hear before an economy goes live. xsolana_publish leads
// its answer with them, and the approval page shows them in a block of their own, whatever the agent said, and enables
// Approve only once the owner ticks that they read them. Pure.

/** Each legal flag's sentence, for the person who approves, by the checker's warning code. */
export const LEGAL = Object.freeze({
  'W-CHANCE-PRIZE': 'Players pay for a chance at money (a box or a lottery that pays a prize, a bet on an outcome). That is gambling in many places: before real money, get a lawyer, and gate it by age and region.',
  'W-CHANCE-ITEMS': 'Players pay for random items they can resell (a loot box). Some places treat that as gambling and many require the odds shown: show them on the page, and get a lawyer before real money.',
  'W-AUCTION-SHILL': 'Anyone, the seller included, can bid to push an auction’s price up (shill bidding): a reserve is the honest way to set a floor.',
  'W-REVENUE-SHARE': 'Stakers are paid from what players spend, which regulators look at when they decide whether a token is a security: before real money, get a lawyer, or pay rewards from emissions instead.',
});

/** The legal flags a checker verdict raises, each once, in the order the checker raised them: [{ code, says }]. */
export const legalFlags = (verdict) =>
  [...new Set((verdict?.warnings ?? []).map((w) => w.code))].filter((code) => Object.hasOwn(LEGAL, code)).map((code) => ({ code, says: LEGAL[code] }));
