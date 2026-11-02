import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';
import { materialize } from './helpers/materialize.mjs';
import { assertValidReport, assertNoForbiddenWords } from './helpers/report-assert.mjs';
import { buildGithubRoutes } from './helpers/github-routes.mjs';
import { osvRoutes, registryRoutes, composeFetch } from './helpers/intel-routes.mjs';
import { CLEAN_REPOS, declaredPackages } from './fixtures/clean-repos.mjs';
import { SCENARIOS, REAL_CASE_REMOTE, REAL_CASE_EXPECTED } from './fixtures/scenarios.mjs';
import { FAKE_TOKEN } from './fixtures/real-case.mjs';

const SHA = 'a'.repeat(40);
const noGh = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
const now = () => new Date('2026-11-01T00:00:00Z');
const cleanRegistry = (files) => Object.fromEntries(declaredPackages(files).map((n) => [n, { latest: '1.0.0' }]));

async function run(target, fetch, extra = []) {
  const { io, stdout, stderr } = makeIo();
  const code = await main([target, '--format', 'json', ...extra], io, { fetch, now, execGh: noGh, env: {} });
  const out = stdout();
  const report = JSON.parse(out);
  assertValidReport(report);
  assertNoForbiddenWords(out);
  assertNoForbiddenWords(stderr());
  return { code, report, out, err: stderr() };
}

function remoteFetch(files, gh = {}, osv = {}, registry = cleanRegistry(files)) {
  const routes = buildGithubRoutes({ owner: 'fixture-owner', repo: 'fixture-repo', sha: SHA, files, ...gh });
  return composeFetch([osvRoutes(osv), registryRoutes(registry)], routes);
}

const REAL_OSV = { 'tailwind-animate-kit@2.0.8': ['MAL-2026-18078'] };
const REAL_REGISTRY = { next: { latest: '14.2.3' }, react: { latest: '18.3.1' }, 'tailwind-animate-kit': { latest: '0.0.1-security' } };
const rulesOf = (r) => r.signals.map((s) => s.rule);

test('real case, local folder, fake network: every component plus the chain, token masked', async (t) => {
  const { dir, cleanup } = await materialize(REAL_CASE_REMOTE.files);
  t.after(cleanup);
  const fetch = composeFetch([osvRoutes(REAL_OSV), registryRoutes(REAL_REGISTRY)]);
  const { code, report, out, err } = await run(dir, fetch);
  assert.equal(code, 1);
  for (const rule of REAL_CASE_EXPECTED) assert.ok(rulesOf(report).includes(rule), rule);
  assert.equal(report.signals.find((s) => s.rule === 'chain-private-dependency').severity, 'high');
  assert.ok(!out.includes(FAKE_TOKEN) && !err.includes(FAKE_TOKEN), 'full token must never be printed');
});

test('real case, remote repository: same signals plus repo-metadata, target.sha present', async () => {
  const { code, report, out, err } = await run('fixture-owner/fixture-repo', remoteFetch(REAL_CASE_REMOTE.files, {}, REAL_OSV, REAL_REGISTRY));
  assert.equal(code, 1);
  for (const rule of [...REAL_CASE_EXPECTED, 'repo-metadata']) assert.ok(rulesOf(report).includes(rule), rule);
  assert.equal(report.signals.find((s) => s.rule === 'repo-metadata').severity, 'info');
  assert.equal(report.target.sha, SHA);
  assert.ok(!out.includes(FAKE_TOKEN) && !err.includes(FAKE_TOKEN));
});

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`scenario ${name}`, async () => {
    const { report } = await run('fixture-owner/fixture-repo', remoteFetch(sc.files, sc.gh));
    for (const e of sc.expect) {
      assert.ok(report.signals.some((s) => s.rule === e.rule && s.severity === e.severity), `${e.rule}/${e.severity} in ${JSON.stringify(rulesOf(report))}`);
    }
  });
}

for (const [name, files] of Object.entries(CLEAN_REPOS)) {
  test(`${name}: zero high, zero medium, nothing found`, async (t) => {
    const { dir, cleanup } = await materialize(files);
    t.after(cleanup);
    const fetch = composeFetch([osvRoutes({}), registryRoutes(cleanRegistry(files))]);
    const { code, report } = await run(dir, fetch);
    assert.deepEqual(report.signals.filter((s) => s.severity !== 'info'), []);
    assert.equal(code, 0);
    assert.equal(report.outcome, 'no_signals_found_by_these_rules');
  });
}
