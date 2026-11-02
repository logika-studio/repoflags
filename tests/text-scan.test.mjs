import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, findLines } from '../skills/repoflags/scripts/lib/util/text-scan.mjs';
import { maskSecret, sanitizeEvidence, redactAll } from '../skills/repoflags/scripts/lib/util/sanitize.mjs';

test('splitLines truncates each line to maxLineLength', () => {
  const lines = splitLines(`${'a'.repeat(50)}\r\nb\nc`, 10);
  assert.deepEqual(lines, ['a'.repeat(10), 'b', 'c']);
});

test('findLines reports matches with 1-based line and column', () => {
  const { matches, timedOut } = findLines(['x', 'foo=bar'], [{ id: 'p', source: '^foo=(.*)$', flags: '' }], 200);
  assert.equal(timedOut, false);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 2);
  assert.equal(matches[0].groups[1], 'bar');
});

test('findLines times out on catastrophic backtracking', () => {
  const t0 = Date.now();
  const r = findLines(['a'.repeat(40) + '!'], [{ id: 'bad', source: '^(a+)+$', flags: '' }], 200);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 3000);
});

test('maskSecret hides short values completely', () => {
  assert.equal(maskSecret('FAKE_TOKEN_FOR_TESTS_ONLY_0001'), 'FAKE…[30 chars]');
  assert.equal(maskSecret('12345678'), '…[8 chars]');
});

test('sanitizeEvidence strips ANSI, controls, bidi, zero-width and truncates', () => {
  const dirty = '\u001b[31mred\u001b[0m\u0007 a‮b⁦c​d‏e';
  const clean = sanitizeEvidence(dirty);
  assert.ok(!/[\u001b\u0007‮⁦​‏]/.test(clean));
  assert.ok(clean.startsWith('red'));
  assert.equal(sanitizeEvidence('x'.repeat(500)).length, 160);
});

test('redactAll masks every occurrence of every secret', () => {
  const out = redactAll('t=SECRET_VALUE_12345 again SECRET_VALUE_12345', new Set(['SECRET_VALUE_12345']));
  assert.ok(!out.includes('SECRET_VALUE_12345'));
  assert.equal(out.split('SECR…[18 chars]').length, 3);
});
