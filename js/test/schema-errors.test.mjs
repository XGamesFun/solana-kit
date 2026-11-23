// A schema refusal names the fix: the shape the field takes, from the schema, and the guide's part with every field;
// an argument a tool doesn't take lists the ones it does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../economy/check.mjs';
import { runTool } from '../mcp/server.mjs';

const base = { version: 2, currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }] };
const fixOf = economy => check(economy).refusals.find(r => r.code === 'E-SCHEMA');

test('E-SCHEMA shows the shape the schema expects, and the part of the guide to fetch', () => {
  const list = fixOf({ ...base, boxes: {} });
  assert.match(list.fix, /^It takes a list, each \{ key, .*outcomes.* \}\./);
  assert.match(list.fix, /xsolana_guide \{"part": "boxes"\}/);
  const field = fixOf({ ...base, items: [{ key: 'a', name: 'A', price: 1, nope: 2 }] });
  assert.match(field.message, /economy\.items\[0\]\.nope is not a field this place takes/);
  assert.match(field.fix, /^economy\.items\[0\] takes key, id, name, .*price/);
  assert.match(field.fix, /xsolana_guide \{"part": "items"\}/);
  const top = fixOf({ ...base, wat: 1 });
  assert.match(top.fix, /^economy takes version, network, name/);
});

test('a refused value is read back so it can be found, never one that may be a secret, and a long one only by its start', () => {
  const said = economy =>
    check(economy)
      .refusals.map(r => `${r.code} ${r.message}`)
      .join('\n');
  // A short value is read back whole.
  assert.match(
    said({ ...base, keys: { authority: 'me' } }),
    /E-SCHEMA economy\.keys\.authority "me" is not allowed here/,
  );
  // A key where an address goes (88 characters of base58), as a keypair file's bytes, and as a seed phrase: refused
  // as a secret, and no message of the check carries any of it.
  const key = 'fgwH71jKVEwPwpNGRz3ozAMKA27RMwf1gN7F9wFTApLURJa9BEkBpohTN8oQ7Zc1Wq3dXy5uRtYhJk2LmNpQ4sVw';
  const bytes = Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  for (const [secret, parts] of [
    [key, [key.slice(0, 12), key.slice(40, 52)]],
    [bytes, [bytes.slice(0, 6).join(','), bytes.slice(30, 36).join(',')]],
    [phrase, ['abandon ability', 'absurd abuse']],
  ])
    for (const economy of [
      { ...base, keys: { authority: secret } },
      { ...base, network: secret },
      { ...base, items: [{ key: 'a', name: 'A', price: { wallet: secret } }] },
    ]) {
      const text = said(economy);
      assert.match(text, /E-SECRET/);
      assert.match(text, /E-SCHEMA|E-NETWORK/);
      for (const part of parts) assert.ok(!text.includes(part), `read back: ${part}`);
    }
  assert.match(
    said({ ...base, keys: { authority: key } }),
    /economy\.keys\.authority the value \(not read back: it may be a secret\) is not allowed here/,
  );
  // A long string no pattern knows for a secret is read back by its first 8 characters, alone or inside an object;
  // a value cut short says so.
  const long = `${'Zq'.repeat(4)}${'-'.repeat(60)}`;
  assert.match(
    said({ ...base, keys: { authority: long } }),
    /economy\.keys\.authority "ZqZqZqZq…" is not allowed here/,
  );
  const inside = said({ ...base, items: [{ key: 'a', name: 'A', price: { note: long, more: 'x'.repeat(40) } }] });
  assert.match(inside, /economy\.items\[0\]\.price \{"note":"ZqZqZqZq…","more":"x{30,}… is not allowed here/);
  assert.ok(!inside.includes('-'.repeat(12)));
});

test('an argument a tool does not take lists the ones it does', async () => {
  const r = await runTool('xsolana_check', { nope: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'arguments.nope is not a field this place takes (it takes spec, file, example)');
  const none = await runTool('xsolana_client', { x: 1 });
  assert.match(none.text, /\(it takes none\)/);
});
