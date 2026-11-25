// What the tools say of trust stays true of the program as it is: a roll nobody steers holds for this version, which
// its upgrade authority can replace, and loot is never said to remove audit risk, since it has not been audited.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { INSTRUCTIONS, REMOTE_INSTRUCTIONS, runTool } from '../mcp/server.mjs';

test('a roll nobody steers is said of the current program version', async () => {
  const r = await runTool('xsolana_review', { example: 'blind-forge' });
  assert.match(
    r.text,
    /can steer the roll \(under the current program version, which its upgrade authority can replace\)/,
  );
  assert.match(
    r.text,
    /Nobody, you included, can break them while they stand\. That holds for the current program version/,
  );
});

test('no text an agent or a reader gets says loot removes the risk of unaudited code', () => {
  const root = new URL('../../', import.meta.url);
  const texts = {
    'the MCP instructions': INSTRUCTIONS,
    'the hosted MCP instructions': REMOTE_INSTRUCTIONS,
    ...Object.fromEntries(
      ['README.md', 'skills/xsolana-economy/SKILL.md', 'docs/tutorial-loot-box.md'].map(f => [
        f,
        readFileSync(new URL(f, root), 'utf8'),
      ]),
    ),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(
      text,
      /risk loot (exists to )?remove|no Anchor or Rust to\s+write, deploy or audit|or auditing an Anchor/i,
      name,
    );
    assert.match(text, /not (yet )?(been )?independently audited/, name);
  }
});
