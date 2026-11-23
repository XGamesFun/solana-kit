// Where a file keeps its economy spec: a spec file is the spec itself, and a game file keeps the spec under `economy`,
// beside keys of its own. Every reader and writer of a file finds the spec here, so a file is read and written back
// in one shape. Pure.

const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The spec in a file's JSON: what it holds under `economy` when that is an object, else the JSON itself. */
export const economyOf = value => (plainObject(value) && plainObject(value.economy) ? value.economy : value);

/**
 * A file's JSON with `spec` put where its own spec was read from (`economyOf`): under `economy`, every key beside it
 * as it was, or as the whole of it.
 */
export const withEconomy = (value, spec) =>
  plainObject(value) && plainObject(value.economy) ? { ...value, economy: spec } : spec;

/**
 * A file's text as JSON. A byte-order mark at its start is let go (editors on Windows write one, and JSON itself
 * takes none); anything else that is not JSON throws, as JSON.parse does.
 */
export const parseFile = text => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
