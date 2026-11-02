import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The declared minimum must be a version the local matrix actually runs (lowest: 18.20.8).
test('engines.node declares the lowest Node version the test matrix runs', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=18.20');
});
