// GitHub acquisition edge cases from review core WR-05, WR-06, WR-12. In-memory fakes only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { AnalyzeError } from '../skills/repoflags/scripts/lib/errors.mjs';
import { makeFakeFetch } from './helpers/fake-fetch.mjs';
import { buildGithubRoutes, blobSha } from './helpers/github-routes.mjs';

const NO_GH = async () => {
  throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
};
const OWNER = 'fixture-owner';
const REPO = 'fixture-repo';
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const deps = (fetch) => ({ fetch, env: { GH_TOKEN: 'FAKE_GH_TOKEN_FOR_TESTS_ONLY' }, execGh: NO_GH, now: () => new Date('2026-11-01T00:00:00Z') });

/** Base64 as the GitHub blob API returns it: a newline every 60 characters. */
const wrapped = (buf) => buf.toString('base64').replace(/.{60}/g, '$&\n');

test('WR-05: a file just under maxFileBytes is downloaded although its base64 carries newlines', async () => {
  const limit = 200000;
  const content = `module.exports = {};\n//${'x'.repeat(limit - 100)}\n`;
  const routes = buildGithubRoutes({ owner: OWNER, repo: REPO, sha: 'a'.repeat(40), files: { 'vite.config.js': content, 'package.json': '{}' } });
  routes[`GET ${BASE}/git/blobs/${blobSha(content)}`] = {
    json: { sha: blobSha(content), size: Buffer.byteLength(content), encoding: 'base64', content: wrapped(Buffer.from(content)) },
  };
  const r = await analyze(`${OWNER}/${REPO}`, { limits: { maxFileBytes: limit } }, deps(makeFakeFetch(routes)));
  const blobErrors = r.notVerified.filter((n) => n.check === 'github-blob');
  assert.deepEqual(blobErrors, []);
});

test('WR-06: a ref with .. or other invalid ref syntax is refused before any request', async () => {
  const { resolveTarget } = await import('../skills/repoflags/scripts/lib/acquire/target.mjs');
  assert.throws(() => resolveTarget('https://github.com/o/r/tree/../../../../user'), AnalyzeError);
  for (const ref of ['../../user', 'a/../b', 'a//b', '/a', 'a/', 'a@{1}', 'a b', 'a\\b', 'a~1', 'a^', 'a:b', 'x.lock', '.hidden', 'a\u0001']) {
    assert.throws(() => resolveTarget('o/r', { ref }), AnalyzeError, JSON.stringify(ref));
  }
  for (const ref of ['main', 'feature/x', 'v1.0.0', 'release-2026.11', 'a'.repeat(40)]) {
    assert.equal(resolveTarget('o/r', { ref }).ref, ref);
  }
});

test('WR-06: a default_branch with .. from the API is refused and never reaches a URL', async () => {
  const routes = buildGithubRoutes({ owner: OWNER, repo: REPO, sha: 'a'.repeat(40), files: { 'package.json': '{}' }, defaultBranch: '../../../../user' });
  const log = [];
  await assert.rejects(analyze(`${OWNER}/${REPO}`, {}, deps(makeFakeFetch(routes, log))), AnalyzeError);
  assert.deepEqual(log.map((l) => l.key).filter((k) => !k.startsWith(`GET ${BASE}`) || k.includes('..')), []);
  assert.ok(!log.some((l) => l.key.endsWith('/user')));
});

test('WR-12: target.ref chosen by the repository author is sanitized, and the schema marks it untrusted', async () => {
  const branch = 'main\u202Eevil\u{E0041}';
  const routes = buildGithubRoutes({ owner: OWNER, repo: REPO, sha: 'a'.repeat(40), files: { 'package.json': '{}' }, ref: branch });
  routes[`GET ${BASE}/commits/${encodeURIComponent('main\u202Eevil\u{E0041}')}`] = routes[`GET ${BASE}/commits/${branch}`];
  const r = await analyze(`${OWNER}/${REPO}`, {}, deps(makeFakeFetch(routes)));
  assert.ok(r.target.ref && !/[\u202E]|\u{E0041}/u.test(r.target.ref), JSON.stringify(r.target.ref));
  const { schema } = await import('./helpers/report-assert.mjs');
  for (const k of ['ref', 'owner', 'repo']) assert.match(schema.properties.target.properties[k].description ?? '', /Untrusted/, k);
});
