import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc, findKeyLine } from '../skills/repoflags/scripts/lib/util/jsonc.mjs';

test('comments and trailing commas are accepted', () => {
  const r = parseJsonc('{ // c\n "a": 1, /* b */ "b": [1,2,], }');
  assert.deepEqual(r, { ok: true, value: { a: 1, b: [1, 2] } });
});

test('comment markers and escaped quotes inside strings stay intact', () => {
  const r = parseJsonc('{"u": "http://x//y", "b": "/* no */", "q": "a\\"//b", "c": "a,}"}');
  assert.equal(r.ok, true);
  assert.equal(r.value.u, 'http://x//y');
  assert.equal(r.value.b, '/* no */');
  assert.equal(r.value.q, 'a"//b');
  assert.equal(r.value.c, 'a,}');
});

test('trailing comma separated by whitespace, comments and newlines is removed', () => {
  const r = parseJsonc('[1,\n  // x\n  /* y */ \n]');
  assert.deepEqual(r, { ok: true, value: [1] });
});

test('malformed input never throws', () => {
  for (const t of ['{ /* open', '{"a": "open', '', '   ', '[' .repeat(100000), '{"a":}']) {
    const r = parseJsonc(t);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  }
});

test('__proto__ becomes an own property and pollutes nothing', () => {
  const r = parseJsonc('{"__proto__": {"polluted": true}}');
  assert.equal(r.ok, true);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(r.value, '__proto__'), true);
});

test('findKeyLine returns the 1-based line of a key, null when absent', () => {
  const t = '{\n  "a": "runOn",\n  "runOn" : 1,\n  "runOn": 2\n}';
  assert.equal(findKeyLine(t, 'runOn'), 3);
  assert.equal(findKeyLine(t, 'missing'), null);
  assert.equal(findKeyLine(t, 'runOn', 4), 4);
});

test('1 MiB without newline is fast', () => {
  const t = '[' + '1,'.repeat(524000) + '1]';
  const t0 = Date.now();
  const r = parseJsonc(t);
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
});
