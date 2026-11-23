// A small JSON Schema validator for the keywords schema.json uses, so the kit needs no schema library: type, const,
// enum, pattern, minimum, maximum, exclusiveMinimum, minLength, maxLength, minItems, maxItems, uniqueItems, items,
// required, properties, additionalProperties, propertyNames, anyOf, oneOf, not and local $ref. It reads schema.json
// from beside it when it is loaded, and changes nothing.
import { readFileSync } from 'node:fs';
import { findSecrets } from './secrets.mjs';

export const SCHEMA = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number' && Number.isFinite(v));
/** The longest string a message reads back whole: an address, 44 characters. A longer one is read back by its first
 * `HEAD` characters, too few to be worth anything were it a key the patterns of secrets.mjs do not know. */
const WHOLE = 44;
const HEAD = 8;
/** The most characters a value read back takes in a message. */
const SHOWN = 60;
/**
 * A value as a message reads it back, so its author finds it at the path given. One that may be a secret (a key, a
 * seed phrase, a keypair file's bytes, a keyed link: `findSecrets`) is never read back, alone or inside what holds it:
 * a spec is public, and so is a message about it. A long string is read back by its first characters, and a value
 * cut short ends with "…".
 */
const show = v => {
  if (findSecrets(v).length) return 'the value (not read back: it may be a secret)';
  const text = JSON.stringify(v, (_, x) => (typeof x === 'string' && x.length > WHOLE ? `${x.slice(0, HEAD)}…` : x));
  return text === undefined || text.length <= SHOWN ? text : `${text.slice(0, SHOWN)}…`;
};
/** "a" or "an", as the word after it takes: "an object", "an array", "a string". */
const article = word => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);
/** A value as text with its objects' keys in order, so two equal values read the same (for uniqueItems). */
const canonical = v =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref is supported: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node?.[key], root);
}

/** Every way `value` breaks `schema`, as { path, message }. An empty list means it is valid. */
export function validate(value, schema = SCHEMA, root = schema, path = 'economy') {
  const errors = [];
  const add = message => errors.push({ path, message });
  if (schema.$ref) return validate(value, resolve(root, schema.$ref), root, path);
  if (schema.anyOf) {
    const results = schema.anyOf.map(s => validate(value, s, root, path));
    if (!results.some(r => r.length === 0)) {
      const wanted =
        schema.description ??
        results
          .flat()
          .map(e => e.message)
          .join('; or ');
      add(`${show(value)} is not allowed here (${wanted})`);
    }
    return errors;
  }
  // Exactly one of the shapes: none is not allowed, and two at once would be read two ways. Shapes that only name a
  // field each (`required`) are one choice among fields of an object, whose other keywords still apply.
  if (schema.oneOf) {
    const fields = schema.oneOf.every(s => Object.keys(s).length === 1 && s.required?.length === 1)
      ? schema.oneOf.map(s => s.required[0])
      : null;
    const results = schema.oneOf.map(s => validate(value, s, root, path));
    const fits = results.filter(r => r.length === 0).length;
    if (fields && typeOf(value) === 'object') {
      if (fits !== 1) add(`needs exactly one of ${fields.map(f => `"${f}"`).join(' or ')}${fits ? ', not both' : ''}`);
    } else {
      if (fits !== 1) {
        const wanted =
          schema.description ??
          results
            .flat()
            .map(e => e.message)
            .join('; or ');
        add(`${show(value)} is not allowed here (${fits ? 'it fits more than one of its forms: ' : ''}${wanted})`);
      }
      return errors;
    }
  }
  if (schema.not && validate(value, schema.not, root, path).length === 0) add(`${show(value)} is not allowed here`);
  if ('const' in schema && value !== schema.const) add(`must be ${show(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) add(`must be one of ${schema.enum.map(show).join(', ')}`);
  if (schema.type && !isType(value, schema.type)) {
    add(`must be ${schema.type === 'integer' ? 'a whole number' : article(schema.type)}`);
    return errors;
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(`${show(value)} is not in the expected form`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      add(`must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      add(`must have at most ${schema.maxLength} characters`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      add(`must be more than ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`needs at least ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`can have at most ${schema.maxItems}`);
    if (schema.uniqueItems) {
      const seen = new Map();
      value.forEach((v, i) => {
        const text = canonical(v);
        if (seen.has(text))
          errors.push({
            path: `${path}[${i}]`,
            message: `is the same as ${path}[${seen.get(text)}]: each is listed once`,
          });
        else seen.set(text, i);
      });
    }
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    // Own keys only, here and below: `in` also answers for what every object inherits ("constructor", "__proto__"),
    // which would pass a name the schema never listed and count an inherited one as given.
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) add(`needs "${key}"`);
    for (const [key, v] of Object.entries(value)) {
      const where = `${path}.${key}`;
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(key))
        errors.push({ path: where, message: 'is not a name this place takes' });
      if (schema.properties && Object.hasOwn(schema.properties, key))
        errors.push(...validate(v, schema.properties[key], root, where));
      else if (schema.additionalProperties === false)
        errors.push({ path: where, message: 'is not a field this place takes' });
      else if (typeOf(schema.additionalProperties) === 'object')
        errors.push(...validate(v, schema.additionalProperties, root, where));
    }
  }
  return errors;
}

/** A schema node with its local $ref followed: { node, name (the $defs name it came by, if any) }. */
function follow(node, root) {
  let name = null;
  while (node?.$ref) {
    name = node.$ref.split('/').pop();
    node = resolve(root, node.$ref);
  }
  return { node, name };
}

/** The place one step below `node` (a field's name, or a list's index), or null when the schema has none. */
function child(node, step, root) {
  const { node: n } = follow(node, root);
  if (!n) return null;
  for (const branch of n.anyOf ?? n.oneOf ?? []) {
    const found = child(branch, step, root);
    if (found) return found;
  }
  if (/^\d+$/.test(step) && n.items) return n.items;
  if (n.properties && Object.hasOwn(n.properties, step)) return n.properties[step];
  if (n.additionalProperties && typeof n.additionalProperties === 'object') return n.additionalProperties;
  return null;
}

/** The fields a place takes, read through its forms: [name, …]. */
export function fieldsAt(node, root = SCHEMA) {
  const { node: n } = follow(node, root);
  if (!n) return [];
  const own = Object.keys(n.properties ?? {});
  const forms = (n.anyOf ?? n.oneOf ?? []).flatMap(b => fieldsAt(b, root));
  return [...new Set([...own, ...forms])];
}

/**
 * Where a validator path ("economy.boxes[0].price", "arguments.nope") leads in the schema: { node (the deepest place it
 * reaches), whole (whether it reached the end), steps (the path's steps after its first), reached (how many of them it
 * followed) }. A field the schema doesn't
 * have stops it at the place that holds it.
 */
export function schemaAt(path, schema = SCHEMA, root = schema) {
  const steps = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .slice(1);
  let node = schema;
  let reached = 0;
  for (const step of steps) {
    const next = child(node, step, root);
    if (!next) break;
    node = next;
    reached++;
  }
  return { node, whole: reached === steps.length, steps, reached };
}

/** A schema node's shape in a line: `{ key, price?, … }`, `a list of box`, `"a" | "b"`, `a number 0..100`. */
export function shapeOf(node, root = SCHEMA, depth = 0) {
  const { node: n, name } = follow(node, root);
  if (!n) return 'anything';
  if (name && depth > 0) return name;
  if (n.const !== undefined) return JSON.stringify(n.const);
  if (n.enum) return n.enum.map(v => JSON.stringify(v)).join(' | ');
  if (n.anyOf ?? n.oneOf) {
    const forms = (n.anyOf ?? n.oneOf).map(b => shapeOf(b, root, depth + 1));
    return [...new Set(forms)].join(' | ');
  }
  const type = Array.isArray(n.type) ? n.type.join(' | ') : n.type;
  if (type === 'array') {
    const most = n.maxItems ? ` (at most ${n.maxItems})` : '';
    // (a list at the top shows what each of its entries takes)
    if (depth === 0) return `a list${most}, each ${shapeOf(n.items, root, 0)}`;
    return `a list of ${shapeOf(n.items, root, depth + 1)}${most}`;
  }
  if (n.properties) {
    if (depth > 1) return name ?? 'an object';
    const required = new Set(n.required ?? []);
    return `{ ${Object.keys(n.properties)
      .map(k => (required.has(k) ? k : `${k}?`))
      .join(', ')} }`;
  }
  if (type === 'integer' || type === 'number') {
    const range =
      n.minimum !== undefined && n.maximum !== undefined
        ? ` from ${n.minimum} to ${n.maximum}`
        : n.minimum !== undefined
          ? ` of at least ${n.minimum}`
          : n.maximum !== undefined
            ? ` of at most ${n.maximum}`
            : '';
    return `${type === 'integer' ? 'a whole number' : 'a number'}${range}`;
  }
  if (type === 'string')
    return n.pattern ? `a string (${n.description ?? `matching ${n.pattern}`})`.slice(0, 160) : 'a string';
  return type ? article(type) : 'an object';
}
