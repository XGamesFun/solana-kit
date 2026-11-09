// The skill as one zip, for apps that take a skill as an upload (the Claude and ChatGPT apps' custom skills): the
// folder `xsolana-economy/` with SKILL.md at its top, as those uploaders look for it. A GitHub release carries it
// (.github/workflows/publish.yml).
//
//   node scripts/skill-zip.mjs [out]    writes xsolana-economy.zip (or `out`)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = 'xsolana-economy';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file under `dir`, as paths relative to it, sorted so the zip is the same each time. */
function filesIn(dir, rel = '') {
  return readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? filesIn(dir, path.join(rel, e.name)) : e.isFile() ? [path.join(rel, e.name)] : []))
    .sort();
}

/** A zip of `entries` ({ name, data }), deflated, with a fixed date so the same files make the same bytes. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 1 January 2026, 00:00, in DOS time.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The skill's files as zip entries, under `xsolana-economy/`. */
export function skillEntries() {
  const dir = path.join(root, 'skills', SKILL);
  return filesIn(dir).map(rel => ({
    name: `${SKILL}/${rel.split(path.sep).join('/')}`,
    data: readFileSync(path.join(dir, rel)),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? `${SKILL}.zip`);
  const entries = skillEntries();
  writeFileSync(out, zip(entries));
  console.log(`${path.relative(process.cwd(), out)}: ${entries.length} files (${entries.map(e => e.name).join(', ')})`);
}
