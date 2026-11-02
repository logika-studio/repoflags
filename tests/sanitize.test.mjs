// Invisible characters must never reach the report (G3): review core WR-01 and IN-03.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidence } from '../skills/repoflags/scripts/lib/util/sanitize.mjs';

const INVISIBLE = {
  'tag A (U+E0041)': '\u{E0041}',
  'tag cancel (U+E007F)': '\u{E007F}',
  'tag space (U+E0020)': '\u{E0020}',
  'variation selector 16 (U+FE0F)': '️',
  'variation selector 1 (U+FE00)': '︀',
  'variation selector 17 (U+E0100)': '\u{E0100}',
  'variation selector 256 (U+E01EF)': '\u{E01EF}',
  'arabic letter mark (U+061C)': '؜',
  'soft hyphen (U+00AD)': '­',
  'mongolian vowel separator (U+180E)': '᠎',
  'line separator (U+2028)': ' ',
  'paragraph separator (U+2029)': ' ',
};

for (const [name, ch] of Object.entries(INVISIBLE)) {
  test(`WR-01: sanitizeEvidence removes ${name}`, () => {
    const out = sanitizeEvidence(`a${ch}${ch}b`);
    assert.ok(!out.includes(ch), JSON.stringify(out));
    assert.ok(out.startsWith('a') && out.endsWith('b'));
  });
}

test('IN-03: truncation never leaves a lone surrogate', () => {
  const out = sanitizeEvidence('\u{1F600}'.repeat(100));
  assert.ok(out.length <= 160);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), JSON.stringify(out.slice(-4)));
  assert.ok(out.endsWith('…'));
});
