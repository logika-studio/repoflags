// Verification 01/11: a package loaded by an executable config file is `info` only when the public npm registry
// resolves it, it is installed from the public registry and OSV lists no MAL-* entry; every other case stays medium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { assertValidReport, assertNoForbiddenWords } from './helpers/report-assert.mjs';
import { osvRoutes, registryRoutes, composeFetch } from './helpers/intel-routes.mjs';
import { resolveConfigLoads } from '../skills/repoflags/scripts/lib/rules/config-resolution.mjs';
import { CLEAN_REPOS, declaredPackages } from './fixtures/clean-repos.mjs';
import { files as REAL_CASE } from './fixtures/real-case.mjs';

const noGh = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
const now = () => new Date('2026-11-01T00:00:00Z');
const NEXT_INTL = CLEAN_REPOS['clean-next-intl'];
const cleanRegistry = (files) => Object.fromEntries(declaredPackages(files).map((n) => [n, { latest: '1.0.0' }]));
const configSignals = (r) => r.signals.filter((s) => s.rule === 'config-require-nonstandard');

async function run(t, files, fetch, extra = []) {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const { io, stdout, stderr } = makeIo();
  const code = await main([dir, '--format', 'json', ...extra], io, { fetch, now, execGh: noGh, env: {} });
  const out = stdout();
  const report = JSON.parse(out);
  assertValidReport(report);
  assertNoForbiddenWords(out);
  assertNoForbiddenWords(stderr());
  return { code, report };
}

function onlyConfig(report, severity) {
  const s = configSignals(report);
  assert.equal(s.length, 1, JSON.stringify(report.signals));
  assert.equal(s[0].severity, severity, JSON.stringify(s[0]));
  return s[0];
}

test('next-intl resolvable on the public registry, no OSV entry: info, nothing found', async (t) => {
  const fetch = composeFetch([osvRoutes({}), registryRoutes(cleanRegistry(NEXT_INTL))]);
  const { code, report } = await run(t, NEXT_INTL, fetch);
  const s = onlyConfig(report, 'info');
  assert.match(s.evidence, /resolvable on public npm registry/);
  assert.match(s.evidence, /next-intl\/plugin/);
  assert.equal(report.outcome, 'no_signals_found_by_these_rules');
  assert.equal(code, 0);
});

test('registry 404 for the loaded package: medium', async (t) => {
  const registry = { ...cleanRegistry(NEXT_INTL), 'next-intl': { status: 404 } };
  const { code, report } = await run(t, NEXT_INTL, composeFetch([osvRoutes({}), registryRoutes(registry)]));
  const s = onlyConfig(report, 'medium');
  assert.match(s.evidence, /not resolvable on public npm registry/);
  assert.equal(report.outcome, 'signals_found');
  assert.equal(code, 1);
});

test('registry error for the loaded package: medium, registry check not performed, declared in notVerified', async (t) => {
  const registry = { ...cleanRegistry(NEXT_INTL), 'next-intl': { throws: true } };
  const { report } = await run(t, NEXT_INTL, composeFetch([osvRoutes({}), registryRoutes(registry)]));
  const s = onlyConfig(report, 'medium');
  assert.match(s.evidence, /registry check not performed/);
  assert.ok(report.notVerified.some((n) => n.check === 'npm-registry'), JSON.stringify(report.notVerified));
});

test('offline: medium with the registry check not performed note', async (t) => {
  const fetch = makeForbiddenFetch();
  const { report } = await run(t, NEXT_INTL, fetch, ['--offline']);
  assert.equal(fetch.log.length, 0);
  const s = onlyConfig(report, 'medium');
  assert.match(s.evidence, /registry check not performed/);
});

test('OSV lists the locked version as malicious: medium', async (t) => {
  const fetch = composeFetch([osvRoutes({ 'next-intl@3.25.1': ['MAL-2026-0001'] }), registryRoutes(cleanRegistry(NEXT_INTL))]);
  const { report } = await run(t, NEXT_INTL, fetch);
  assert.match(onlyConfig(report, 'medium').evidence, /malicious/);
});

test('OSV check failed: medium, the MAL-* lookup was not performed', async (t) => {
  const fetch = composeFetch([osvRoutes({}, { status: 503 }), registryRoutes(cleanRegistry(NEXT_INTL))]);
  const { report } = await run(t, NEXT_INTL, fetch);
  assert.match(onlyConfig(report, 'medium').evidence, /OSV check not performed/);
});

test('npm security placeholder for the loaded package: medium', async (t) => {
  const registry = { ...cleanRegistry(NEXT_INTL), 'next-intl': { latest: '0.0.1-security' } };
  const { report } = await run(t, NEXT_INTL, composeFetch([osvRoutes({}), registryRoutes(registry)]));
  onlyConfig(report, 'medium');
});

test('non-registry source (git) for the loaded package: medium even if the name exists on npm', async (t) => {
  const files = { ...NEXT_INTL, 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { next: '15.0.3', 'next-intl': 'github:fixture-owner/next-intl' } }) };
  const { report } = await run(t, files, composeFetch([osvRoutes({}), registryRoutes({ next: {}, 'next-intl': {} })]));
  assert.match(onlyConfig(report, 'medium').evidence, /not installed from the public registry/);
});

test('lockfile resolves the loaded package from a private registry URL: medium', async (t) => {
  const lock = {
    name: 'x', version: '1.0.0', lockfileVersion: 3,
    packages: { 'node_modules/next-intl': { version: '3.25.1', resolved: 'https://npm.fixture-private.example/next-intl/-/next-intl-3.25.1.tgz' } },
  };
  const files = { ...NEXT_INTL, 'package-lock.json': JSON.stringify(lock) };
  const { report } = await run(t, files, composeFetch([osvRoutes({}), registryRoutes(cleanRegistry(NEXT_INTL))]));
  assert.match(onlyConfig(report, 'medium').evidence, /not installed from the public registry/);
});

test('scope redirected by the repository .npmrc: medium even if the public registry has the name', async (t) => {
  const files = {
    '.npmrc': '@fixture-private:registry=https://npm.fixture-private.example/\n',
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { next: '15.0.3', '@fixture-private/next-plugin': '1.0.0' } }),
    'next.config.js': "const plugin = require('@fixture-private/next-plugin');\nmodule.exports = plugin({});\n",
  };
  const registry = { next: {}, '@fixture-private/next-plugin': {} };
  const { report } = await run(t, files, composeFetch([osvRoutes({}), registryRoutes(registry)]));
  assert.match(onlyConfig(report, 'medium').evidence, /registry configured by the repository/);
});

// Live run 01/11 (private Next.js repo, 236 dependencies): next-intl/plugin stayed medium "beyond the limit" because
// the 200-name cap was applied in declaration order. The config-loaded package is looked up first.
test('250 dependencies, config-loaded package declared last: looked up before the cap, info; cap still declared', async (t) => {
  const deps = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`fixture-pkg-${String(i).padStart(3, '0')}`, '1.0.0']));
  const files = { ...NEXT_INTL, 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { ...deps, next: '15.0.3', 'next-intl': '3.25.1' } }) };
  const registry = Object.fromEntries([...Object.keys(deps), 'next', 'next-intl'].map((n) => [n, {}]));
  const { report } = await run(t, files, composeFetch([osvRoutes({}), registryRoutes(registry)]));
  assert.match(onlyConfig(report, 'info').evidence, /resolvable on public npm registry/);
  assert.ok(report.notVerified.some((n) => n.check === 'npm-registry' && /limit of 200 names/.test(n.reason)), JSON.stringify(report.notVerified));
});

test('a config-loaded package that the cap still leaves out keeps medium with the limit note (pure)', () => {
  const signal = { rule: 'config-require-nonstandard', severity: 'medium', package: 'next-intl', evidence: 'next.config.js loads next-intl/plugin' };
  const [s] = resolveConfigLoads([signal], {
    deps: [{ name: 'next-intl', spec: '3.25.1', resolved: null }],
    notVerified: [{ check: 'npm-registry', reason: '1 packages not checked: limit of 200 names', names: ['next-intl'], cap: true }],
    resolved: new Set(), files: new Map(), mode: 'online',
  });
  assert.equal(s.severity, 'medium');
  assert.match(s.evidence, /registry check not performed: beyond the limit of names per analysis/);
});

test('real case: the config-loaded package stays medium and the chain is still high', async (t) => {
  const fetch = composeFetch([
    osvRoutes({ 'tailwind-animate-kit@2.0.8': ['MAL-2026-18078'] }),
    registryRoutes({ next: { latest: '14.2.3' }, react: { latest: '18.3.1' }, 'tailwind-animate-kit': { latest: '0.0.1-security' } }),
  ]);
  const { code, report } = await run(t, REAL_CASE, fetch);
  assert.equal(code, 1);
  assert.equal(onlyConfig(report, 'medium').file, 'web/tailwind.config.js');
  assert.equal(report.signals.find((s) => s.rule === 'chain-private-dependency').severity, 'high');
});
