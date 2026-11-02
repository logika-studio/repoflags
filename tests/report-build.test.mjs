// Report building details from review core WR-07 and IN-01.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../skills/repoflags/scripts/lib/report/build.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { makeFakeFetch } from './helpers/fake-fetch.mjs';
import { buildGithubRoutes, blobSha } from './helpers/github-routes.mjs';

const ctx = () => ({ now: () => new Date('2026-11-01T00:00:00Z'), mode: 'offline', limits: createLimits({}), network: { hosts: {} } });
const acquired = { target: { type: 'local', name: 'x', owner: null, repo: null, ref: null, sha: null } };
const build = (signals, notVerified) => buildReport({ acquired, signals, notVerified, ctx: ctx() });

test('WR-07: a long notVerified reason keeps its tail (how many files, the hint)', () => {
  const paths = Array.from({ length: 20 }, (_, i) => `packages/some-long-package-name-${i}/package.json`).join(', ');
  const reason = `GitHub API rate limit reached: not read: ${paths} and 312 more; run gh auth login or set GH_TOKEN for a higher limit`;
  const r = build([], [{ check: 'github-rate-limit', reason }]);
  const out = r.notVerified.find((n) => n.check === 'github-rate-limit').reason;
  assert.match(out, /and 312 more/);
  assert.match(out, /gh auth login/);
});

test('WR-07: two reasons that differ only after 160 characters are both kept', () => {
  const head = 'x'.repeat(170);
  const r = build([], [{ check: 'limits', reason: `${head} A` }, { check: 'limits', reason: `${head} B` }]);
  assert.equal(r.notVerified.filter((n) => n.check === 'limits').length, 2);
});

test('WR-07: the count of unread remote files comes first in the reason', async () => {
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pkg${String(i).padStart(2, '0')}/package.json`, `{"name":"p${i}"}`]));
  files['package.json'] = '{"name":"root"}';
  const owner = 'fixture-owner';
  const repo = 'fixture-repo';
  const routes = buildGithubRoutes({ owner, repo, sha: 'a'.repeat(40), files });
  for (const [p, content] of Object.entries(files)) {
    if (p === 'package.json') continue;
    routes[`GET https://api.github.com/repos/${owner}/${repo}/git/blobs/${blobSha(content)}`] = { status: 403, json: {}, headers: { 'x-ratelimit-remaining': '0' } };
  }
  const r = await analyze(`${owner}/${repo}`, {}, {
    fetch: makeFakeFetch(routes), env: { GH_TOKEN: 'FAKE_GH_TOKEN_FOR_TESTS_ONLY' }, now: () => new Date('2026-11-01T00:00:00Z'),
  });
  const nv = r.notVerified.find((n) => n.check === 'github-rate-limit');
  assert.ok(nv, JSON.stringify(r.notVerified));
  assert.match(nv.reason.slice(0, 160), /30 files not read/);
});

test('IN-01: signal order compares code units, not the ICU locale', () => {
  const s = (file) => ({ rule: 'r', severity: 'medium', title: 't', file, line: 1, evidence: 'e', refs: [] });
  const r = build([s('a.js'), s('B.js')], []);
  assert.deepEqual(r.signals.map((x) => x.file), ['B.js', 'a.js']);
});
