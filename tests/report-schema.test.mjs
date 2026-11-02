import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { validate } from '../skills/repoflags/scripts/lib/report/schema-check.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { assertValidReport, assertNoForbiddenWords, schema } from './helpers/report-assert.mjs';
import { files } from './fixtures/real-case.mjs';

async function realReport(t) {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  return analyze(dir, { offline: true }, offlineDeps(t, { now: () => new Date('2026-11-01T00:00:00Z'), env: {} }));
}

test('real case report validates against the schema', async (t) => {
  const report = await realReport(t);
  assert.deepEqual(validate(schema, report), []);
  assertValidReport(report);
  assertNoForbiddenWords(JSON.stringify(report));
  assertNoForbiddenWords(JSON.stringify(schema));
});

test('undeclared keys are rejected at root and in signals', async (t) => {
  const report = await realReport(t);
  const root = structuredClone(report);
  root.extra = 1;
  assert.ok(validate(schema, root).some((e) => e.includes('$.extra')));
  const sig = structuredClone(report);
  sig.signals[0].extra = 1;
  assert.ok(validate(schema, sig).some((e) => e.includes('$.signals[0].extra')));
});

test('enum, pattern, length and minimum violations are reported', async (t) => {
  const report = await realReport(t);
  const mutate = (fn) => {
    const r = structuredClone(report);
    fn(r);
    return validate(schema, r);
  };
  assert.ok(mutate((r) => { r.signals[0].severity = 'critical'; }).some((e) => e.includes('enum')));
  assert.ok(mutate((r) => { r.schemaVersion = '1.0'; }).some((e) => e.includes('pattern')));
  assert.ok(mutate((r) => { r.signals[0].id = 'X1'; }).some((e) => e.includes('pattern')));
  assert.ok(mutate((r) => { r.signals[0].evidence = 'a'.repeat(161); }).some((e) => e.includes('maxLength')));
  assert.ok(mutate((r) => { r.signals[0].line = 0; }).some((e) => e.includes('minimum')));
  assert.ok(mutate((r) => { r.notVerified = r.notVerified.slice(0, 4); }).some((e) => e.includes('minItems')));
});

test('null file and line are valid', async (t) => {
  const report = await realReport(t);
  const r = structuredClone(report);
  r.signals[0].file = null;
  r.signals[0].line = null;
  assert.deepEqual(validate(schema, r), []);
});

test('validator never throws on arbitrary input', () => {
  for (const v of [null, 1, 'x', [], [[[1]]], { a: { b: [] } }, undefined]) {
    assert.ok(Array.isArray(validate(schema, v)));
  }
  assert.ok(validate(schema, null).length > 0);
});
