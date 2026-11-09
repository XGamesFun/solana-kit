// How far a result a voucher's server signs can be trusted: the levels a grant declares in `trust`, and each in
// words. The spec's own note about its server: never sent on chain. Pure.

/** The trust levels a voucher grant declares, strongest first. */
export const TRUST_LEVELS = Object.freeze(['decides', 'replays', 'bounds']);

/** Each trust level in words: what the server does, and what a cheater still gets. */
export const TRUST_WORDS = Object.freeze({
  decides:
    'the server decides the result itself (it runs the game or the match; the page sends only inputs): nothing the page says can forge one, though a bot that plays well still earns what a good player does',
  replays:
    'the server runs the page’s inputs again and reads the result itself: a forged result fails, though a bot that plays well still earns, and one that knows the run’s randomness up front can search for the best run offline',
  bounds:
    'the page runs the game and reports the result, and the server checks only its pace, order and daily caps: a script that waits as long as a person would gets every reward, up to the limits',
});
