import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeFakeFetch } from './helpers/fake-fetch.mjs';
import { buildGithubRoutes, blobSha } from './helpers/github-routes.mjs';
import { makeIo } from './helpers/io.mjs';
import { files as realCase } from './fixtures/real-case.mjs';

const TOKEN = 'FAKE_GH_TOKEN_FOR_TESTS_ONLY';
const SHA = 'a'.repeat(40);
const NO_GH = async () => {
  throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
};
const BASE = 'https://api.github.com/repos/fixture-owner/fixture-repo';

function spec(extra = {}) {
  return { owner: 'fixture-owner', repo: 'fixture-repo', sha: SHA, files: { ...realCase, 'README.md': 'hello\n', 'src/index.js': 'x\n' }, ...extra };
}

async function run(argv, { routes, env = { GH_TOKEN: TOKEN }, fetch } = {}) {
  const log = [];
  const f = fetch ?? makeFakeFetch(routes, log);
  const c = makeIo();
  const code = await main(argv, c.io, { fetch: f, env, execGh: NO_GH, now: () => new Date('2026-11-01T00:00:00Z') });
  const keys = (fetch ? [] : log).map((l) => l.key);
  return { code, out: c.stdout(), err: c.stderr(), log, keys, report: code === 2 ? null : JSON.parse(c.stdout()) };
}
const TARGET = ['fixture-owner/fixture-repo', '--format', 'json'];
const blobKeys = (keys) => keys.filter((k) => k.includes('/git/blobs/'));

test('real case on GitHub: sha in the report, only selected blobs downloaded', async () => {
  const r = await run(TARGET, { routes: buildGithubRoutes(spec()) });
  assert.equal(r.code, 1);
  assert.equal(r.report.target.type, 'github');
  assert.equal(r.report.target.sha, SHA);
  assert.equal(r.report.target.name, 'fixture-owner/fixture-repo');
  assert.equal(r.report.target.owner, 'fixture-owner');
  assert.ok(r.report.signals.some((s) => s.rule === 'npmrc-auth-token'));
  const allowed = [`GET ${BASE}`, `GET ${BASE}/commits/main`, `GET ${BASE}/git/trees/`, `GET ${BASE}/git/blobs/`];
  // Intel requests (plan 01-09) are made after acquisition; this test is about what acquisition downloads.
  allowed.push('POST https://api.osv.dev/', 'GET https://registry.npmjs.org/', 'GET https://api.github.com/users/', `GET ${BASE}/commits?`);
  for (const k of r.keys) assert.ok(allowed.some((a) => k.startsWith(a)), `unexpected route ${k}`);
  assert.ok(r.keys.some((k) => k.endsWith('?recursive=1')));
  const expected = ['web/.npmrc', 'web/package.json', 'web/tailwind.config.js', 'web/package-lock.json'].map((p) => `GET ${BASE}/git/blobs/${blobSha(realCase[p])}`);
  assert.deepEqual(blobKeys(r.keys).sort(), expected.sort());
  assert.ok(!r.keys.includes(`GET ${BASE}/git/blobs/${blobSha('hello\n')}`));
});

test('--ref is used for the commit, default branch otherwise, tree comes from the commit', async () => {
  const withRef = await run([...TARGET, '--ref', 'v1.0.0'], { routes: buildGithubRoutes(spec({ ref: 'v1.0.0', defaultBranch: 'trunk' })) });
  assert.ok(withRef.keys.includes(`GET ${BASE}/commits/v1.0.0`));
  assert.equal(withRef.report.target.ref, 'v1.0.0');
  const noRef = await run(TARGET, { routes: buildGithubRoutes(spec({ ref: 'trunk', defaultBranch: 'trunk', treeSha: 'b'.repeat(40) })) });
  assert.ok(noRef.keys.includes(`GET ${BASE}/commits/trunk`));
  assert.equal(noRef.report.target.ref, 'trunk');
  assert.ok(noRef.keys.includes(`GET ${BASE}/git/trees/${'b'.repeat(40)}?recursive=1`));
});

test('404 is a clean exit 2 with login hint, no stack', async () => {
  const routes = buildGithubRoutes(spec());
  routes[`GET ${BASE}`] = { status: 404, json: { message: 'Not Found' } };
  const r = await run(TARGET, { routes });
  assert.equal(r.code, 2);
  assert.match(r.err, /not found or no access/);
  assert.match(r.err, /gh auth login/);
  assert.doesNotMatch(r.err, /\n\s+at /);
  assert.ok(!r.err.includes(TOKEN));
});

test('a renamed repo (301) is followed once, only to api.github.com', async () => {
  const routes = buildGithubRoutes(spec());
  const original = routes[`GET ${BASE}`];
  routes[`GET ${BASE}`] = { status: 301, headers: { location: 'https://api.github.com/repositories/123' } };
  for (const [k, v] of Object.entries(buildGithubRoutes(spec()))) {
    if (k.startsWith('GET ' + BASE + '/')) routes[k.replace(BASE, 'https://api.github.com/repositories/123')] = v;
  }
  routes['GET https://api.github.com/repositories/123'] = original;
  const ok = await run(TARGET, { routes });
  assert.equal(ok.code, 1);
  assert.ok(ok.keys.includes('GET https://api.github.com/repositories/123'));

  const bad = buildGithubRoutes(spec());
  bad[`GET ${BASE}`] = { status: 301, headers: { location: 'https://evil.test/repositories/123' } };
  const r = await run(TARGET, { routes: bad });
  assert.equal(r.code, 2);
  assert.ok(!r.keys.some((k) => k.includes('evil.test')));
});

test('truncated tree: BFS over sub-trees, node_modules skipped, capped at 50 requests', async () => {
  const many = { 'node_modules/x/package.json': '{}' };
  for (let i = 0; i < 60; i += 1) many[`d${String(i).padStart(2, '0')}/package.json`] = `{"name":"d${i}"}`;
  const routes = buildGithubRoutes(spec({ files: { 'package.json': '{"name":"root"}', ...many }, truncated: true }));
  const r = await run(TARGET, { routes });
  const subtrees = r.keys.filter((k) => k.includes('/git/trees/') && !k.endsWith('?recursive=1'));
  assert.equal(subtrees.length, 50);
  assert.ok(!r.keys.some((k) => k.includes('/git/trees/') && k.includes(blobSha('tree:node_modules'))));
  const nv = r.report.notVerified.find((n) => n.check === 'github-tree');
  assert.ok(nv, 'github-tree entry expected');
  assert.match(nv.reason, /11 director/);
});

test('truncated tree fully visited within the cap yields the nested files', async () => {
  const routes = buildGithubRoutes(spec({ files: { 'a/b/.npmrc': '//registry.npmjs.org/:_authToken=FAKE_TOKEN_FOR_TESTS_ONLY_0002\n' }, truncated: true }));
  const r = await run(TARGET, { routes });
  assert.ok(r.report.signals.some((s) => s.file === 'a/b/.npmrc'));
});

test('symlinks and submodules are not downloaded and are reported', async () => {
  const entries = [
    { path: '.npmrc', mode: '120000', type: 'blob', sha: 'c'.repeat(40), size: 12 },
    { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'd'.repeat(40) },
  ];
  const r = await run(TARGET, { routes: buildGithubRoutes(spec({ entries })) });
  assert.ok(!r.keys.some((k) => k.includes('c'.repeat(40)) || k.includes('d'.repeat(40))));
  const text = r.report.notVerified.map((n) => n.reason).join('\n');
  assert.match(text, /\.npmrc/);
  assert.match(text, /vendor\/lib/);
});

test('invalid SHAs never reach a URL', async () => {
  for (const bad of ['../../users/x', 'a'.repeat(39), 'A'.repeat(40)]) {
    const r = await run(TARGET, { routes: buildGithubRoutes(spec({ sha: bad })) });
    assert.equal(r.code, 2, `commit sha ${bad}`);
    assert.equal(r.keys.length, 2);
  }
  const badTree = await run(TARGET, { routes: buildGithubRoutes(spec({ treeSha: '../x' })) });
  assert.equal(badTree.code, 2);
  assert.equal(badTree.keys.length, 2);

  const entries = [{ path: 'evil/package.json', mode: '100644', type: 'blob', sha: '../../x', size: 5 }];
  const r = await run(TARGET, { routes: buildGithubRoutes(spec({ entries })) });
  assert.ok(!r.keys.some((k) => k.includes('..')));
  assert.match(r.report.notVerified.map((n) => n.reason).join('\n'), /evil\/package\.json/);
});

test('oversized files are not requested and the limit is recorded', async () => {
  const routes = buildGithubRoutes(spec({ sizes: { 'web/package.json': 500 } }));
  const r = await run([...TARGET, '--max-file-bytes', '100'], { routes });
  assert.ok(!r.keys.includes(`GET ${BASE}/git/blobs/${blobSha(realCase['web/package.json'])}`));
  assert.ok(r.report.limits.reached.includes('maxFileBytes'));
  assert.match(r.report.notVerified.map((n) => n.reason).join('\n'), /web\/package\.json/);
});

test('blobs with NUL bytes are reported as binary', async () => {
  const routes = buildGithubRoutes(spec({ files: { 'package.json': 'ab\u0000cd' } }));
  const r = await run(TARGET, { routes });
  assert.ok(r.report.notVerified.some((n) => n.check === 'binary-files' && /package\.json/.test(n.reason)));
});

test('rate limit mid-run: partial result, unread files listed, hint to log in, never exit 2', async () => {
  const f = {
    'package.json': '{"name":"a"}',
    '.npmrc': 'registry=https://registry.npmjs.org/\n',
    '.vscode/tasks.json': '{"version":"2.0.0"}',
    'webpack.config.js': 'module.exports={}',
    'package-lock.json': '{"lockfileVersion":3}',
    'AGENTS.md': 'hi',
  };
  const routes = buildGithubRoutes(spec({ files: f }));
  for (const p of ['webpack.config.js', 'package-lock.json', 'AGENTS.md']) {
    routes[`GET ${BASE}/git/blobs/${blobSha(f[p])}`] = { status: 403, json: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0' } };
  }
  const r = await run(TARGET, { routes });
  assert.notEqual(r.code, 2);
  const nv = r.report.notVerified.find((n) => n.check === 'github-rate-limit');
  assert.ok(nv, 'github-rate-limit entry expected');
  assert.match(nv.reason, /gh auth login/);
  for (const p of ['webpack.config.js', 'package-lock.json', 'AGENTS.md']) assert.ok(nv.reason.includes(p), p);
  for (const p of ['package.json', '.vscode/tasks.json']) assert.ok(!nv.reason.includes(p), p);
});

test('anonymous access is declared in notVerified, authenticated access is not', async () => {
  const anon = await run(TARGET, { routes: buildGithubRoutes(spec()), env: {} });
  const entry = anon.report.notVerified.find((n) => n.check === 'github-auth');
  assert.deepEqual(entry, { check: 'github-auth', reason: 'anonymous GitHub API access: 60 requests/hour, private repositories not readable' });
  assert.deepEqual(anon.log.map((l) => l.auth).filter(Boolean), []);
  const authed = await run(TARGET, { routes: buildGithubRoutes(spec()) });
  assert.ok(!authed.report.notVerified.some((n) => n.check === 'github-auth'));
});

test('blobs go out in priority order with at most 4 requests in flight', async () => {
  const f = { 'AGENTS.md': 'a', 'package-lock.json': '{"lockfileVersion":3}', 'webpack.config.js': 'm', '.vscode/tasks.json': '{"version":"2.0.0"}', '.npmrc': 'r=1\n', 'package.json': '{}' };
  const base = makeFakeFetch(buildGithubRoutes(spec({ files: f })));
  let inflight = 0;
  let max = 0;
  const order = [];
  const fetch = async (url, init) => {
    if (String(url).includes('/git/blobs/')) order.push(String(url).split('/').pop());
    inflight += 1;
    max = Math.max(max, inflight);
    await new Promise((res) => setTimeout(res, 5));
    try { return await base(url, init); } finally { inflight -= 1; }
  };
  await run(TARGET, { fetch });
  const expected = ['package.json', '.npmrc', '.vscode/tasks.json', 'webpack.config.js', 'package-lock.json', 'AGENTS.md'].map((p) => blobSha(f[p]));
  assert.deepEqual(order, expected);
  assert.ok(max <= 4 && max >= 2, `max in flight ${max}`);
});

test('remote analysis writes nothing to disk and the token appears nowhere', async (t) => {
  const spies = [
    t.mock.method(fs, 'writeFileSync'),
    t.mock.method(fs.promises, 'writeFile'),
    t.mock.method(fs.promises, 'mkdtemp'),
    t.mock.method(fs, 'mkdtempSync'),
  ];
  const r = await run(TARGET, { routes: buildGithubRoutes(spec()) });
  for (const s of spies) assert.equal(s.mock.callCount(), 0);
  for (const l of r.log) assert.equal(l.auth, l.host === 'api.github.com' ? `Bearer ${TOKEN}` : null);
  assert.ok(r.log.length > 0);
  assert.ok(!r.out.includes(TOKEN));
  assert.ok(!r.err.includes(TOKEN));
});

test('offline remote target is refused before any request', async () => {
  const log = [];
  const c = makeIo();
  const code = await main(['fixture-owner/fixture-repo', '--offline'], c.io, { fetch: makeFakeFetch({}, log), env: {}, execGh: NO_GH });
  assert.equal(code, 2);
  assert.equal(log.length, 0);
});
