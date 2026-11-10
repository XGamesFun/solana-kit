// scripts/skill-zip.mjs: the skill as one zip for apps that take an upload. Every file of the skill, under
// xsolana-economy/ with SKILL.md at its top, read back byte for byte, and the same bytes each time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { crc32, skillEntries, zip } from '../../scripts/skill-zip.mjs';

/** The entries of a zip, read from its central directory. */
function unzip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'end record');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50, 'central header');
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = inflateRawSync(bytes.subarray(start, start + size));
    assert.equal(crc32(data), bytes.readUInt32LE(at + 16), `${name} crc`);
    out.push({ name, data });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return out;
}

test('the skill zip holds every file of the skill under xsolana-economy/, SKILL.md at its top', () => {
  const entries = skillEntries();
  assert.ok(entries.some(e => e.name === 'xsolana-economy/SKILL.md'));
  assert.ok(entries.every(e => e.name.startsWith('xsolana-economy/')));
  const bytes = zip(entries);
  assert.deepEqual(
    unzip(bytes).map(e => [e.name, Buffer.from(e.data).toString('base64')]),
    entries.map(e => [e.name, Buffer.from(e.data).toString('base64')]),
  );
  assert.ok(zip(skillEntries()).equals(bytes), 'the same files make the same bytes');
});

test('crc32 is the zip format’s', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
