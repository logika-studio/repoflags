// Shared report checks (reused by 01-10 on every fixture).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validate } from '../../skills/repoflags/scripts/lib/report/schema-check.mjs';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../skills/repoflags/scripts/report.schema.json',
);

export const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

export function assertValidReport(report) {
  const errors = validate(schema, report);
  assert.deepEqual(errors, [], `report does not match report.schema.json:\n${errors.join('\n')}`);
}

export function assertNoForbiddenWords(text) {
  assert.doesNotMatch(String(text), /safe/i, 'output must never contain the word safe/unsafe (G7)');
}
