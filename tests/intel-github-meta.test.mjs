import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, CHECK } from '../skills/repoflags/scripts/lib/intel/github-meta.mjs';
import { buildGithubRoutes } from './helpers/github-routes.mjs';
import { composeFetch, makeIntelCtx } from './helpers/intel-routes.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-01T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const OWNER = 'fixture-owner-login';

/** Builds the `acquired.github` the real acquisition would give, plus the route table. */
function scene(over = {}) {
  const spec = {
    owner: OWNER, repo: 'proj', sha: SHA, files: {},
    createdAt: daysAgo(3), ownerType: 'User', ownerCreatedAt: daysAgo(5), commitCount: 2,
    headAuthorDate: daysAgo(1), headCommitterDate: daysAgo(1),
    oldestAuthorDate: daysAgo(2), oldestCommitterDate: daysAgo(2),
    ...over,
  };
  const routes = buildGithubRoutes(spec);
  const repo = routes[`GET https://api.github.com/repos/${OWNER}/proj`].json;
  const commit = routes[`GET https://api.github.com/repos/${OWNER}/proj/commits/main`].json;
  const acquired = { target: { type: 'github', name: `${OWNER}/proj`, owner: OWNER, repo: 'proj', ref: 'main', sha: SHA }, files: new Map(), github: { repo, commit } };
  return { acquired, routes };
}

async function go(over, mutate) {
  const { acquired, routes } = scene(over);
  mutate?.(routes, acquired);
  const fetch = composeFetch([], routes);
  const ctx = makeIntelCtx(fetch);
  const res = await run({ acquired, deps: [], signals: [] }, ctx);
  return { res, fetch, ctx };
}

const texts = (res) => res.signals.map((s) => s.evidence);

test('CHECK id', () => assert.equal(CHECK, 'repo-metadata'));

test('factual signals: repo age, owner account, commit count', async () => {
  const { res } = await go();
  assert.ok(res.signals.every((s) => s.rule === 'repo-metadata' && s.severity === 'info'));
  const t = texts(res);
  assert.ok(t.includes('repository created 3 days before analysis'));
  assert.ok(t.includes('owner account (type User) created 5 days before analysis'));
  assert.ok(t.includes('2 commits reachable from the analyzed commit'));
  assert.equal(t.filter((x) => x.startsWith('commit dated before')).length, 0);
  assert.deepEqual(res.notVerified, []);
});

test('only the oldest commit author date earlier than repo creation: one signal', async () => {
  const { res } = await go({ oldestAuthorDate: daysAgo(400) });
  const t = texts(res).filter((x) => x.startsWith('commit dated before'));
  assert.equal(t.length, 1);
  assert.match(t[0], /^commit dated before repository creation \(oldest commit, author date /);
});

test('only the oldest committer date earlier: one signal', async () => {
  const { res } = await go({ oldestCommitterDate: daysAgo(400) });
  const t = texts(res).filter((x) => x.startsWith('commit dated before'));
  assert.equal(t.length, 1);
  assert.match(t[0], /\(oldest commit, committer date /);
});

test('head author and committer both earlier: two signals', async () => {
  const { res } = await go({ headAuthorDate: daysAgo(400), headCommitterDate: daysAgo(401) });
  const t = texts(res).filter((x) => x.startsWith('commit dated before'));
  assert.equal(t.length, 2);
  assert.ok(t.every((x) => x.includes('(head commit,')));
});

test('single commit: compared on HEAD only, no extra request, no duplicate', async () => {
  const { res, fetch } = await go({ commitCount: 1, headAuthorDate: daysAgo(400), headCommitterDate: daysAgo(1) });
  const t = texts(res);
  assert.ok(t.includes('1 commit reachable from the analyzed commit'));
  assert.equal(t.filter((x) => x.startsWith('commit dated before')).length, 1);
  assert.equal(fetch.log.filter((l) => l.key.includes('&page=')).length, 0);
});

test('missing or unparseable date is notVerified for that comparison, no exception', async () => {
  const { res } = await go({ oldestAuthorDate: 'not a date' });
  assert.ok(res.notVerified.some((n) => n.check === 'repo-metadata' && /date/.test(n.reason)));
});

test('owner lookup 404 keeps the other signals', async () => {
  const { res } = await go({}, (routes) => {
    routes[`GET https://api.github.com/users/${OWNER}`] = { status: 404, json: { message: 'Not Found' } };
  });
  const t = texts(res);
  assert.ok(t.includes('repository created 3 days before analysis'));
  assert.ok(!t.some((x) => x.startsWith('owner account')));
  assert.ok(res.notVerified.some((n) => n.check === 'repo-metadata'));
});

test('organization owner type is reported as a type, not a judgment', async () => {
  const { res } = await go({ ownerType: 'Organization' });
  assert.ok(texts(res).includes('owner account (type Organization) created 5 days before analysis'));
});

test('no person identifier or judgment wording anywhere in the signals (G8)', async () => {
  const { res } = await go({ oldestAuthorDate: daysAgo(400) });
  const json = JSON.stringify(res);
  assert.ok(!json.includes(OWNER));
  assert.ok(!/suspicious|scam|fake|fraud|malicious/i.test(json));
  assert.ok(!/@/.test(json));
});

test('network failure on every call degrades to notVerified', async () => {
  const { acquired } = scene();
  const ctx = makeIntelCtx(async () => { throw new Error('down'); });
  const res = await run({ acquired, deps: [], signals: [] }, ctx);
  assert.ok(res.signals.every((s) => s.rule === 'repo-metadata'));
  assert.ok(res.notVerified.length >= 1);
});

test('null github acquisition is notVerified', async () => {
  const ctx = makeIntelCtx(async () => { throw new Error('must not be called'); });
  const res = await run({ acquired: { target: { type: 'local' }, files: new Map(), github: null }, deps: [], signals: [] }, ctx);
  assert.deepEqual(res.signals, []);
  assert.equal(res.notVerified[0].check, 'repo-metadata');
});
