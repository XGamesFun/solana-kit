// The forms the agent is taught are forms the checker takes: every JSON fragment in xsolana_guide's parts and topics,
// in SKILL.md and its references, in the tutorial and in the rated ideas is written into a spec that checks, and the
// spec must still check.
//
// Finding a form. A form is a `{ … }` (or a list of them, `[{ … }, …]`) whose first field's name is in double quotes,
// as JSON writes it; a JavaScript call's `{ listing, count }` is not one. It may wrap inside its paragraph. A ```json
// block is one form, or a whole spec when it has a "version"; a block in any other language is skipped. A form that
// follows a tool's name and writes only that tool's arguments (`xsolana_guide {"part": …}`) is that call, not a spec.
// JSON of something else is listed in OTHER_JSON, by its text.
//
// Reading a form. The texts write a value as JSON ("1d", 5, true), as a bare word for the person's own value (key, n,
// address), as a quoted placeholder ("<address>", "wallet:<address>"), or leave it out ({ "rule", "then" }); `…` is
// the rest the sentence leaves out; `a | b` (or `a or b`) is one form a choice, each tried. Anything else inside the
// braces (a note in brackets, words after a value) cannot be read, and fails: a note goes after the form.
//
// Trying a form. Its hosts are the bundled examples (whole economies that check, with every part in use) and EXTRA,
// which has what no example shows. A form is tried at every place in a host whose schema takes each field it writes:
// laid over the object the host has there, then alone, with only what the schema requires kept from the host. A
// value the form leaves open is the host's own there, or one the schema takes; a name of another part ("item":
// "pass", "pool:<key>") is one of the host's. The form passes when at one place the host still checks. So the test
// holds what a form writes, not what it leaves out, and that it is taken somewhere, not that it is taken where its
// sentence says.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { encodeBase58 } from '../chain/base58.js';
import { utf8 } from '../chain/bytes.js';
import { sha256 } from '../chain/sha256.js';
import { check } from '../economy/check.mjs';
import { examples, ideas } from '../economy/examples.mjs';
import { guideText, PARTS, TOPICS } from '../economy/guide.mjs';
import { fieldsAt, schemaAt, SCHEMA } from '../economy/validate.mjs';
import { tools } from '../mcp/tools.mjs';

const NOW = 1_790_000_000;
const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const skill = 'skills/xsolana-economy/';
/** Every text that teaches forms, by name. */
const TEXTS = {
  ...Object.fromEntries(
    [...Object.keys(PARTS), ...Object.keys(TOPICS)].map(part => [`xsolana_guide {"part": "${part}"}`, guideText(part)]),
  ),
  [`${skill}SKILL.md`]: read(`${skill}SKILL.md`),
  ...Object.fromEntries(
    readdirSync(new URL(`${skill}references/`, root)).map(f => [
      `${skill}references/${f}`,
      read(`${skill}references/${f}`),
    ]),
  ),
  'docs/tutorial-loot-box.md': read('docs/tutorial-loot-box.md'),
  'docs/cheatsheet.md': read('docs/cheatsheet.md'),
  // (each idea a paragraph of its own)
  'examples/ideas.json': ideas()
    .map(i => `#${i.n} ${i.name}: ${i.how}`)
    .join('\n\n'),
};
/** JSON the texts show that is no part of a spec: its text, and what it is. */
const OTHER_JSON = {
  '{ "name", "symbol", "image": "https://…" }': 'the file a token’s `uri` links to',
};

// ---------------------------------------------------------------- finding the forms

const OPENS = /^(?:\{\s*(?:(?:…|\.\.\.)\s*,\s*)?"|\[\s*\{\s*")/;
/** Where the bracket opened at `from` closes, or -1 when its paragraph ends first. */
function closeOf(text, from) {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < text.length && !(text[i] === '\n' && text[i + 1] === '\n'); i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (c === '{' || c === '[') depth++;
    if ((c === '}' || c === ']') && --depth === 0) return i;
  }
  return -1;
}
/** The forms a text shows: [{ text, tool? (the tool named last before it in its paragraph), whole? (a ```json block) }]. */
function formsIn(text) {
  const found = [];
  const plain = text.replace(/```(\w*)\n([\s\S]*?)```/g, (block, lang, body) => {
    if (lang === 'json') found.push({ text: body.trim(), whole: true });
    return block.replace(/[^\n]/g, ' ');
  });
  for (let i = 0; i < plain.length; i++) {
    if ((plain[i] !== '{' && plain[i] !== '[') || !OPENS.test(plain.slice(i, i + 40))) continue;
    const end = closeOf(plain, i);
    if (end < 0) {
      found.push({ text: plain.slice(i, i + 80), open: true });
      continue;
    }
    const before = plain.slice(Math.max(plain.lastIndexOf('\n\n', i), 0), i);
    const tool = [...before.matchAll(/\bxsolana_[a-z]+\b/g)].at(-1)?.[0];
    found.push({ text: plain.slice(i, end + 1), ...(tool ? { tool } : {}) });
    i = end;
  }
  return found;
}

// ---------------------------------------------------------------- reading a form

const written = v => ({ kind: 'written', v });
/** A value the form leaves to the person: `prefix` is what a quoted placeholder says before it ("wallet:"). */
const open = (prefix = '') => ({ kind: 'open', prefix });

/**
 * A form as a tree: { kind: 'fields', fields: [{ name, value }] }, { kind: 'list', items }, { kind: 'written', v },
 * { kind: 'open', prefix } or { kind: 'choice', of }. Throws, in words, on what the texts' way of writing has no
 * reading for.
 */
function readForm(text) {
  // (a Markdown table writes a choice's bar as \|)
  const s = text.replace(/\\\|/g, '|');
  let i = 0;
  const here = () => `“${s.slice(i, i + 24)}”`;
  const space = () => {
    while (/\s/.test(s[i] ?? '')) i++;
  };
  const dots = () => {
    space();
    if (s[i] === '…') return (i++, true);
    if (s.startsWith('...', i)) return ((i += 3), true);
    return false;
  };
  const quoted = () => {
    let j = i + 1;
    while (j < s.length && (s[j] !== '"' || s[j - 1] === '\\')) j++;
    if (j >= s.length) throw new Error('a double quote never closes');
    const v = s.slice(i + 1, j);
    i = j + 1;
    return v;
  };
  const value = () => {
    space();
    if (s[i] === '{') return fields();
    if (s[i] === '[') return list();
    if (s[i] === '"') {
      const v = quoted();
      const at = v.search(/<[^>]*>|…/);
      return at < 0 ? written(v) : open(v.slice(0, at));
    }
    let j = i;
    while (j < s.length && !',}]|'.includes(s[j]) && !/^ or [{"[]/.test(s.slice(j, j + 5))) j++;
    const word = s.slice(i, j).trim();
    if (!word) throw new Error(`a value is missing at ${here()}`);
    if (/[(:"]/.test(word)) throw new Error(`“${word}” is a note inside the form: write it after the form`);
    i = j;
    if (/^-?\d+(\.\d+)?$/.test(word)) return written(Number(word));
    if (word === 'true' || word === 'false') return written(word === 'true');
    return open();
  };
  const choice = () => {
    const of = [value()];
    for (;;) {
      space();
      if (s[i] === '|') i++;
      else if (/^or [{"[]/.test(s.slice(i, i + 4))) i += 2;
      else break;
      of.push(value());
    }
    return of.length === 1 ? of[0] : { kind: 'choice', of };
  };
  function fields() {
    i++;
    const all = [];
    for (;;) {
      if (!dots()) {
        space();
        if (s[i] !== '"') throw new Error(`a field’s name in double quotes is expected at ${here()}`);
        const name = quoted();
        space();
        if (s[i] === ':') {
          i++;
          all.push({ name, value: choice() });
        } else all.push({ name, value: open() });
      }
      space();
      if (s[i] === ',') i++;
      else if (s[i] === '}') return (i++, { kind: 'fields', fields: all });
      else throw new Error(`a comma or the closing brace is expected at ${here()}`);
    }
  }
  function list() {
    i++;
    const items = [];
    let more = false;
    for (;;) {
      space();
      // (a list of `…` alone is left to the person whole)
      if (s[i] === ']') return (i++, more && !items.length ? open() : { kind: 'list', items });
      if (dots()) more = true;
      else items.push(choice());
      space();
      if (s[i] === ',') i++;
      else if (s[i] !== ']') throw new Error(`a comma or the closing bracket is expected at ${here()}`);
    }
  }
  const tree = value();
  space();
  if (i < s.length) throw new Error(`text after the form’s end: ${here()}`);
  return tree;
}

/** A form that offers choices, as one form a choice. */
function choicesOf(tree) {
  if (tree.kind === 'choice') return tree.of.flatMap(choicesOf);
  if (tree.kind === 'fields')
    return tree.fields.reduce(
      (all, f) =>
        all.flatMap(o =>
          choicesOf(f.value).map(value => ({ kind: 'fields', fields: [...o.fields, { name: f.name, value }] })),
        ),
      [{ kind: 'fields', fields: [] }],
    );
  if (tree.kind === 'list')
    return tree.items.reduce(
      (all, item) => all.flatMap(l => choicesOf(item).map(v => ({ kind: 'list', items: [...l.items, v] }))),
      [{ kind: 'list', items: [] }],
    );
  return [tree];
}

// ---------------------------------------------------------------- the schema's places

/** A schema node with its `$ref` followed, and the name of the shape it came by. */
function follow(node) {
  let name = null;
  while (node?.$ref) {
    name = node.$ref.split('/').pop();
    node = SCHEMA.$defs[name];
  }
  return { node, name };
}
/** The schema's node at a checker path ("economy.boxes[0].outcomes[1]"), or null when it has none. */
const nodeAt = path => {
  const at = schemaAt(path);
  return at.whole ? at.node : null;
};
/** A node and every form it may take (`anyOf`, `oneOf`), each followed. */
function branches(node) {
  const { node: n } = follow(node);
  return n ? [n, ...(n.anyOf ?? n.oneOf ?? []).flatMap(branches)] : [];
}
/** What a list at this place holds, when the place can be a list. */
const itemsOf = node => branches(node).find(b => b.type === 'array' && b.items)?.items ?? null;
const nests = value => value.kind === 'fields' || value.kind === 'list';
/** Whether a place takes every field the form writes, all the way down. A map of the spec's own names takes none. */
function takes(node, form) {
  if (!node) return false;
  if (form.kind === 'list') {
    const items = itemsOf(node);
    return Boolean(items) && form.items.every(item => !nests(item) || takes(items, item));
  }
  const named = new Set(fieldsAt(node));
  return form.fields.every(f => {
    if (!named.has(f.name)) return false;
    const child = branches(node)
      .map(b => b.properties?.[f.name])
      .find(Boolean);
    return !nests(f.value) || takes(child, f.value);
  });
}

// ---------------------------------------------------------------- a form's values in a host

/** A place the form cannot be tried at, in words. */
class NoValue extends Error {}
const address = name => encodeBase58(sha256(utf8(`doc-forms:${name}`)));
/** The kind of part a field names, by the field's own name or a destination's first word. */
const NAMES = {
  item: 'items',
  items: 'items',
  chosen: 'items',
  box: 'boxes',
  pool: 'pools',
  stash: 'stashes',
  lottery: 'lotteries',
  farm: 'farms',
  table: 'tables',
  grant: 'grants',
  currency: 'tokens',
};
const ADDRESSED = ['wallet', 'account', 'holder'];
const NAMED = new RegExp(`^(${[...Object.keys(NAMES), ...ADDRESSED].join('|')}):`);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The host's part of a kind: the `turn`-th, counted round. */
function hostKey(host, kind, turn) {
  const keys = (host[kind] ?? []).map(p => p.key).filter(Boolean);
  if (!keys.length) throw new NoValue(`it has no ${kind}`);
  return keys[turn % keys.length];
}
/** A value the schema takes at a place, for one the form leaves open. */
function standIn(node, name, host, turn) {
  const { node: n, name: shape } = follow(node);
  if (!n) throw new NoValue(`the schema has no “${name}” there`);
  if (shape === 'key') {
    if (!NAMES[name]) throw new NoValue(`“${name}” names a part, and NAMES has no kind for it`);
    return hostKey(host, NAMES[name], turn);
  }
  if (shape === 'address') return address(name);
  if (shape === 'amount') return 1;
  if (shape === 'percent') return 10;
  if (shape === 'duration') return '1d';
  if (shape === 'time') return 'publish+1d';
  if (shape === 'link') return 'https://example.com/a.json';
  if (n.const !== undefined) return n.const;
  if (n.enum) return n.enum[0];
  for (const branch of n.anyOf ?? n.oneOf ?? []) {
    try {
      return standIn(branch, name, host, turn);
    } catch (e) {
      if (!(e instanceof NoValue)) throw e;
    }
  }
  if (n.type === 'integer' || n.type === 'number') return Math.max(n.minimum ?? 1, 1);
  if (n.type === 'boolean') return true;
  if (n.type === 'string' && !n.pattern) return 'x';
  if (n.type === 'array' && n.items) return [standIn(n.items, name, host, turn)];
  if (n.type === 'object')
    return Object.fromEntries((n.required ?? []).map(r => [r, standIn(n.properties[r], r, host, turn)]));
  throw new NoValue(`nothing stands in for “${name}”`);
}
/** A destination or a name with a first word ("pool:<key>", "wallet:<address>") as the host has it, or null. */
function namedIn(host, text, had, turn) {
  const word = NAMED.exec(text)?.[1];
  if (!word) return null;
  if (typeof had === 'string' && had.startsWith(`${word}:`)) return had;
  return `${word}:${ADDRESSED.includes(word) ? address(word) : hostKey(host, NAMES[word], turn)}`;
}
/**
 * The form's value for a place: what it writes, with the host's own values (`had`) where it leaves one open and the
 * host's own names where it names a part. `over`: the host's other fields stay; else only those the schema requires.
 */
function valueOf(form, had, path, name, host, { over, turn }) {
  const node = nodeAt(path);
  if (form.kind === 'fields') {
    const out = over && isObject(had) ? { ...had } : {};
    for (const f of form.fields)
      out[f.name] = valueOf(f.value, isObject(had) ? had[f.name] : undefined, `${path}.${f.name}`, f.name, host, {
        over,
        turn,
      });
    if (isObject(had))
      for (const branch of branches(node))
        for (const r of branch.required ?? []) if (!Object.hasOwn(out, r) && Object.hasOwn(had, r)) out[r] = had[r];
    return out;
  }
  if (form.kind === 'list')
    return form.items.map((item, n) =>
      valueOf(item, Array.isArray(had) ? had[n] : undefined, `${path}[${n}]`, name, host, { over, turn: turn + n }),
    );
  if (form.kind === 'written') {
    if (typeof form.v !== 'string') return form.v;
    const named = namedIn(host, form.v, had, turn);
    if (named) return named;
    if (follow(node).name !== 'key') return form.v;
    if (typeof had === 'string') return had;
    return NAMES[name] ? hostKey(host, NAMES[name], turn) : form.v;
  }
  const named = namedIn(host, form.prefix, had, turn);
  if (named) return named;
  if (had !== undefined) return had;
  return standIn(node, name, host, turn);
}

// ---------------------------------------------------------------- the hosts and their places

const card = n => ({ key: `card-${n}`, name: `Card ${n}` });
/** What the texts teach and no bundled example shows: drawn traits and their table, a pack whose slots name outcomes,
 * odds on a long box, a run of places, a raffle of many NFTs, a lot the owner holds, an off-chain rule, a coin's holders. */
const EXTRA = {
  version: 2,
  network: 'devnet',
  name: 'Forms',
  currency: 'sol',
  tokens: [
    { key: 'sol', source: 'sol' },
    {
      key: 'coin',
      source: 'existing',
      mint: address('coin'),
      name: 'Coin',
      symbol: 'COIN',
      decimals: 6,
      powers: { mintAuthority: 'none', freeze: false },
    },
  ],
  collection: { name: 'Forms' },
  tables: [
    {
      key: 'colors',
      kind: 'labels',
      rows: [
        { label: 'red', weight: 3 },
        { label: 'gold', weight: 1, stock: 100 },
      ],
    },
  ],
  items: [
    ...Array.from({ length: 10 }, (_, n) => card(n)),
    {
      key: 'fresh',
      name: 'Fresh {color}',
      drawn: [
        { attribute: 'color', table: 'colors' },
        { attribute: 'power', min: 1, max: 100 },
      ],
    },
  ],
  boxes: [
    {
      key: 'pack',
      name: 'Pack',
      price: 0.1,
      outcomes: [
        ...Array.from({ length: 10 }, (_, n) => ({ gives: 'item', item: `card-${n}`, weight: n < 8 ? 10 : 1 })),
        { gives: 'item', item: 'fresh', weight: 1 },
      ],
      slots: [
        { count: 4, share: 60 },
        { count: 1, from: [8, 9, 10], share: 40 },
      ],
      odds: [{ outcome: 3, when: { attribute: 'charm' }, add: { perPointPercent: 10, upTo: 9 } }],
    },
  ],
  lotteries: [
    {
      key: 'runners',
      name: 'Runners-up',
      price: 0.01,
      rest: 'treasury',
      firstDraw: 'publish+7d',
      places: [{ percent: 1, times: 100 }],
    },
    {
      key: 'many',
      name: 'Many',
      price: 0.01,
      rest: 'treasury',
      firstDraw: 'publish+7d',
      nfts: Array.from({ length: 200 }, (_, n) => address(`nft ${n}`)),
      places: [{ prize: { gives: 'raffled' }, times: 200 }],
    },
  ],
  auctions: [
    {
      key: 'piece',
      name: 'Piece',
      lot: { asset: address('asset'), collection: address('collection') },
      reserve: 1,
      runs: '1d',
    },
  ],
  grants: [
    {
      key: 'pops',
      name: 'Pops',
      prize: { gives: 'item', item: 'card-0' },
      vouchers: [address('server')],
      trust: 'bounds',
      limits: { perWallet: 1, perDay: 100, total: 1000 },
    },
  ],
  offchain: [{ key: 'boost-code', takes: 'a code', gives: 'grant:pops', rate: 2 }],
  scenario: { holders: { coin: { supply: 1_000_000, owner: 100_000, largest: 50_000 } } },
};
const HOSTS = [...examples(), { name: 'the test’s own host (EXTRA)', spec: EXTRA }];

const stepsOf = path =>
  path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .slice(1);
const at = (spec, path) => stepsOf(path).reduce((v, step) => v?.[step], spec);
/** A copy of the spec with `value` at `path`. */
function put(spec, path, value) {
  const steps = stepsOf(path);
  if (!steps.length) return value;
  const copy = structuredClone(spec);
  let v = copy;
  steps.slice(0, -1).forEach((step, n) => {
    v[step] ??= /^\d+$/.test(steps[n + 1]) ? [] : {};
    v = v[step];
  });
  v[steps.at(-1)] = value;
  return copy;
}
/**
 * Every place a form may go in a host: each object it has, each field of one that could hold an object and holds
 * none, each list (`list`: a list form's place), and the end of each list that is there. Its `live` section is left
 * out: only going live writes one.
 */
function placesIn(spec) {
  const places = [];
  (function walk(v, path) {
    if (Array.isArray(v)) v.forEach((x, n) => walk(x, `${path}[${n}]`));
    if (!isObject(v)) return;
    places.push({ path, has: true });
    const node = nodeAt(path);
    for (const field of node ? fieldsAt(node) : []) {
      const child = nodeAt(`${path}.${field}`);
      if (!child) continue;
      const items = itemsOf(child);
      if (items) places.push({ path: `${path}.${field}`, has: Object.hasOwn(v, field), list: true });
      if (items && Array.isArray(v[field]) && fieldsAt(items).length)
        places.push({ path: `${path}.${field}[${v[field].length}]`, has: false });
      if (!Object.hasOwn(v, field) && fieldsAt(child).length) places.push({ path: `${path}.${field}`, has: false });
    }
    for (const [key, x] of Object.entries(v)) if (key !== 'live') walk(x, `${path}.${key}`);
  })(spec, 'economy');
  return places;
}
const PLACES = HOSTS.map(host => ({ host, places: placesIn(host.spec) }));

/**
 * Where a form is taken: { ok: true, where } at the first place a host still checks with it written there, else
 * { ok: false, fits (how many places take its fields), near: [why each of those places refused it] }.
 */
function placeOf(form) {
  const near = [];
  let fits = 0;
  for (const { host, places } of PLACES)
    for (const place of places) {
      if (Boolean(place.list) !== (form.kind === 'list') || !takes(nodeAt(place.path), form)) continue;
      fits++;
      const had = at(host.spec, place.path);
      const name = stepsOf(place.path).findLast(step => !/^\d+$/.test(step));
      // (`turn`: which of the host's parts a name the form leaves open takes; a value tried once is not tried again)
      const done = new Set();
      for (const over of place.has ? [true, false] : [false])
        for (const turn of [0, 1, 2]) {
          let value;
          try {
            value = valueOf(form, had, place.path, name, host.spec, { over, turn });
          } catch (e) {
            if (!(e instanceof NoValue)) throw e;
            near.push(`${host.name}, ${place.path}: ${e.message}`);
            break;
          }
          const text = JSON.stringify(value);
          if (done.has(text)) continue;
          done.add(text);
          const verdict = check(put(host.spec, place.path, value), { now: NOW });
          if (verdict.ok) return { ok: true, where: `${host.name}, ${place.path}` };
          near.push(`${host.name}, ${place.path}: ${verdict.refusals[0].code} ${verdict.refusals[0].message}`);
        }
    }
  return { ok: false, fits, near: [...new Set(near)] };
}

/** Why the checker would refuse a form as written, in words, or null when it is taken. */
function refusalOf({ text, tool, whole, open: unclosed }) {
  if (Object.hasOwn(OTHER_JSON, text)) return null;
  if (unclosed) return 'its braces do not close in its paragraph';
  if (whole) {
    let spec = null;
    try {
      spec = JSON.parse(text);
    } catch {
      // (read below as a form, in the texts' own writing)
    }
    if (isObject(spec) && spec.version !== undefined) {
      const verdict = check(spec, { now: NOW });
      return verdict.ok
        ? null
        : `the spec does not check: ${verdict.refusals.map(r => `${r.code} ${r.message}`).join(' ')}`;
    }
  }
  let tree;
  try {
    tree = readForm(text);
  } catch (e) {
    return `it cannot be read: ${e.message}`;
  }
  const args = tools.find(t => t.name === tool)?.inputSchema.properties ?? {};
  if (tool && tree.kind === 'fields' && tree.fields.every(f => Object.hasOwn(args, f.name))) return null;
  if (!nests(tree)) return 'it is not a form';
  for (const form of choicesOf(tree)) {
    const place = placeOf(form);
    if (place.ok) continue;
    if (!place.fits) return 'no place in a spec takes these fields together';
    // (a refusal of the form's own fields says more than one of the place's kind)
    const first = [...place.near.filter(n => !n.includes('E-SCHEMA')), ...place.near].slice(0, 5);
    return `the checker refuses it at each of the ${place.fits} places that take its fields, in the examples and in this test’s EXTRA. The nearest:\n    ${first.join('\n    ')}`;
  }
  return null;
}
const answers = new Map();
/** (each form is tried once, however many texts show it) */
const refusal = form => {
  const key = JSON.stringify([form.text, form.tool ?? null, Boolean(form.whole)]);
  if (!answers.has(key)) answers.set(key, refusalOf(form));
  return answers.get(key);
};

// ---------------------------------------------------------------- the tests

test('every example and the test’s own host check, so a form is all that can make one stop checking', () => {
  for (const { name, spec } of HOSTS) {
    const verdict = check(spec, { now: NOW });
    assert.ok(verdict.ok, `${name}: ${verdict.refusals.map(r => `${r.code} ${r.message}`).join(' ')}`);
  }
});

test('the test fails a form the checker refuses, and passes one it takes', () => {
  const says = text => refusalOf({ text });
  // a prize that is a share of a pool; two fields no one place takes; a value no form has
  assert.match(says('{ "gives": "share", "pool": key, "percent": p }'), /no place in a spec takes/);
  assert.match(says('{ "percent", "roll" }'), /no place in a spec takes/);
  assert.match(says('{ "gives": "jackpot", "item": key }'), /the checker refuses it/);
  assert.match(says('{ "item": key (or none), "attribute": "level" }'), /cannot be read/);
  assert.equal(says('{ "gives": "pay", "pool": key, "amount": n }'), null);
  assert.equal(says('{ "to": "burn" | "pool:<key>" | "wallet:<address>", "percent": n }'), null);
  assert.equal(says('{ "rule": { "item": key } or { "collection": address }, "then": "burn" }'), null);
  assert.equal(refusalOf({ text: '{"part": "boxes"}', tool: 'xsolana_guide' }), null);
  assert.match(refusalOf({ text: '{"part": "boxes"}', tool: 'xsolana_check' }), /no place in a spec takes/);
});

describe('every form the agent is taught is one the checker takes', () => {
  for (const [name, text] of Object.entries(TEXTS))
    test(name, () => {
      const refused = formsIn(text)
        .map(form => [form.text, refusal(form)])
        .filter(([, why]) => why);
      assert.ok(
        !refused.length,
        refused.map(([form, why]) => `\n${name} teaches ${form.replace(/\s+/g, ' ')}\n  ${why}`).join('\n'),
      );
    });
});

test('what is listed as JSON of something else is still in a text', () => {
  const all = Object.values(TEXTS).join('\n');
  for (const form of Object.keys(OTHER_JSON))
    assert.ok(all.includes(form), `no text shows ${form}: take it off OTHER_JSON`);
});
