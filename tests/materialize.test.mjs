// Review tests IN-04: a write failing half way left the temp folder (with fixture files in it) in os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { materialize } from './helpers/materialize.mjs';

const leftovers = async (prefix) => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith(prefix));

test('IN-04: a fixture write that fails removes the partial temp folder and rethrows', async () => {
  const prefix = `repoflags-in04-${crypto.randomBytes(6).toString('hex')}-`;
  const bad = { 'package.json': '{}', [`a${String.fromCharCode(0)}b.txt`]: 'x' }; // NUL: the write is refused
  await assert.rejects(materialize(bad, { prefix }));
  assert.deepEqual(await leftovers(prefix), []);
});

test('IN-04: cleanup removes the folder', async () => {
  const prefix = `repoflags-in04-${crypto.randomBytes(6).toString('hex')}-`;
  const { dir, cleanup } = await materialize({ 'a/b.txt': 'x' }, { prefix });
  assert.equal((await leftovers(prefix)).length, 1);
  await cleanup();
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});
