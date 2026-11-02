import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChains } from '../skills/repoflags/scripts/lib/rules/chain.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { files as realCase, PRIVATE_SCOPE_DEP } from './fixtures/real-case.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { osvRoutes, registryRoutes, composeFetch } from './helpers/intel-routes.mjs';

const sig = (rule, file, line = 1, evidence = 'x') => ({ rule, severity: 'high', title: rule, file, line, evidence, refs: [] });
const TOKEN = sig('npmrc-auth-token', 'web/.npmrc');
const REQUIRE = sig('config-require-nonstandard', 'web/tailwind.config.js', 1);
const UNRES = { ...sig('dep-unresolvable', 'web/package.json', null, '@fixture-private/motion-helpers: registry answered 404'), severity: 'medium' };
const scoped = { name: '@fixture-private/motion-helpers', version: null, spec: '^1.0.0', file: 'web/package.json', direct: true, resolved: null, hasInstallScript: false };
const skipped = [{ check: 'npm-registry', reason: 'skipped: offline mode' }];

test('token + require + unresolvable scoped dependency -> one high chain, components kept', () => {
  const res = applyChains([TOKEN, REQUIRE, UNRES], { deps: [scoped], notVerified: [] });
  assert.equal(res.signals.length, 1);
  const c = res.signals[0];
  assert.equal(c.rule, 'chain-private-dependency');
  assert.equal(c.severity, 'high');
  assert.equal(c.title, 'Private dependency chain: committed registry token + unresolvable scoped dependency + package loaded by config');
  assert.equal(c.file, 'web/.npmrc');
  assert.equal(c.line, 1);
  assert.deepEqual(c.refs, []);
  for (const r of ['npmrc-auth-token', 'config-require-nonstandard', 'dep-unresolvable']) assert.ok(c.evidence.includes(r), r);
  assert.ok(c.evidence.includes('web/tailwind.config.js'));
});

test('offline: scoped direct dependency + registry check not performed -> chain', () => {
  const res = applyChains([TOKEN, REQUIRE], { deps: [scoped], notVerified: skipped });
  assert.equal(res.signals.length, 1);
  assert.match(res.signals[0].evidence, /scoped dependency @fixture-private\/motion-helpers \(registry check not performed\)/);
});

test('scoped dependency resolvable (registry ran, no dep-unresolvable) -> no chain', () => {
  assert.deepEqual(applyChains([TOKEN, REQUIRE], { deps: [scoped], notVerified: [] }).signals, []);
});

test('missing token or missing require -> no chain', () => {
  assert.deepEqual(applyChains([REQUIRE, UNRES], { deps: [scoped], notVerified: skipped }).signals, []);
  assert.deepEqual(applyChains([TOKEN, UNRES], { deps: [scoped], notVerified: skipped }).signals, []);
});

test('offline without any scoped direct dependency -> no chain', () => {
  const plain = { ...scoped, name: 'left-pad' };
  assert.deepEqual(applyChains([TOKEN, REQUIRE], { deps: [plain], notVerified: skipped }).signals, []);
});

test('chain appears once even with several tokens and configs', () => {
  const res = applyChains([TOKEN, sig('npmrc-auth-token', 'a/.npmrc'), REQUIRE, sig('config-require-nonstandard', 'b/x.js'), UNRES], { deps: [scoped], notVerified: [] });
  assert.equal(res.signals.length, 1);
});

test('unresolvable non-scoped dependency alone does not complete the chain', () => {
  const plain = { ...UNRES, evidence: 'left-padd: registry answered 404' };
  assert.deepEqual(applyChains([TOKEN, REQUIRE, plain], { deps: [], notVerified: [] }).signals, []);
});

test('contract marker is gone: no notVerified entry about chains', () => {
  assert.deepEqual(applyChains([], { deps: [], notVerified: [] }).notVerified, []);
});

async function dirOf(t) {
  const { dir, cleanup } = await materialize(realCase);
  t.after(cleanup);
  return dir;
}
const base = { now: () => new Date('2026-11-01T00:00:00Z'), env: {} };

test('real case offline: chain present', async (t) => {
  const report = await analyze(await dirOf(t), { offline: true }, offlineDeps(t, base));
  assert.ok(report.signals.some((s) => s.rule === 'chain-private-dependency' && s.severity === 'high'));
  assert.ok(report.signals.some((s) => s.rule === 'npmrc-auth-token'));
});

test('real case online with fake network (404 on the private scope): chain present', async (t) => {
  const fetch = composeFetch([
    osvRoutes({}),
    registryRoutes({ next: { latest: '14.2.3' }, react: { latest: '18.3.1' }, 'tailwind-animate-kit': { latest: '2.0.8' } }),
  ]);
  const report = await analyze(await dirOf(t), {}, { ...base, fetch });
  assert.ok(report.signals.some((s) => s.rule === 'dep-unresolvable' && s.evidence.includes(PRIVATE_SCOPE_DEP)));
  assert.equal(report.signals.filter((s) => s.rule === 'chain-private-dependency').length, 1);
});

// Review rules CR-07: the most natural form of the real case (exact version + lockfile resolved on the private
// registry) must close the chain online too.
test('CR-07: online, a pinned scoped dependency resolved from a private registry in the lockfile closes the chain', async (t) => {
  const pinned = {
    ...realCase,
    'web/package.json': JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { 'tailwind-animate-kit': '2.0.8', [PRIVATE_SCOPE_DEP]: '1.0.0' } }),
    'web/package-lock.json': JSON.stringify({
      name: 'web', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'tailwind-animate-kit': '2.0.8', [PRIVATE_SCOPE_DEP]: '1.0.0' } },
        'node_modules/tailwind-animate-kit': { version: '2.0.8', resolved: 'https://registry.npmjs.org/tailwind-animate-kit/-/tailwind-animate-kit-2.0.8.tgz' },
        [`node_modules/${PRIVATE_SCOPE_DEP}`]: { version: '1.0.0', resolved: 'https://npm.example.invalid/@fixture-private/motion-helpers/-/motion-helpers-1.0.0.tgz' },
      },
    }),
  };
  const { dir, cleanup } = await materialize(pinned);
  t.after(cleanup);
  const fetch = composeFetch([osvRoutes({}), registryRoutes({ 'tailwind-animate-kit': { latest: '2.0.8' } })]);
  const report = await analyze(dir, {}, { ...base, fetch });
  assert.ok(report.signals.some((s) => s.rule === 'dep-unresolvable' && s.evidence.includes(PRIVATE_SCOPE_DEP)), JSON.stringify(report.signals.map((s) => s.rule)));
  assert.equal(report.signals.filter((s) => s.rule === 'chain-private-dependency').length, 1);
});

// Review rules WR-02: a partial registry failure must not complete the chain with a dependency that WAS verified.
import { run as registryRun } from '../skills/repoflags/scripts/lib/intel/registry.mjs';
import { makeIntelCtx } from './helpers/intel-routes.mjs';

const direct = (name) => ({ name, version: null, spec: '^1.0.0', file: 'web/package.json', direct: true, resolved: null, hasInstallScript: false });

test('WR-02: a lookup failure on another package does not turn a verified scoped dependency into a chain', async () => {
  const fetch = composeFetch([registryRoutes({ '@types/node': { latest: '22.0.0' }, 'left-pad': { throws: true } })]);
  const deps = [direct('@types/node'), direct('left-pad')];
  const reg = await registryRun({ deps }, makeIntelCtx(fetch));
  assert.ok(reg.notVerified.length >= 1);
  assert.deepEqual(applyChains([TOKEN, REQUIRE], { deps, notVerified: reg.notVerified }).signals, []);
});

test('WR-02: a lookup failure on the scoped dependency itself still completes the chain', async () => {
  const fetch = composeFetch([registryRoutes({ '@fixture-private/motion-helpers': { throws: true } })]);
  const deps = [direct('@fixture-private/motion-helpers')];
  const reg = await registryRun({ deps }, makeIntelCtx(fetch));
  const res = applyChains([TOKEN, REQUIRE], { deps, notVerified: reg.notVerified });
  assert.equal(res.signals.length, 1);
  assert.match(res.signals[0].evidence, /registry check not performed/);
});
