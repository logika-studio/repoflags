import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, CHECK } from '../skills/repoflags/scripts/lib/intel/osv.mjs';
import { osvRoutes, composeFetch, makeIntelCtx } from './helpers/intel-routes.mjs';

const dep = (name, version, file = 'web/package-lock.json') => ({ name, version, spec: version, file, direct: false, resolved: null, hasInstallScript: false });
const input = (deps) => ({ acquired: { target: { type: 'local' }, files: new Map(), github: null }, deps, signals: [] });

function setup(map, opts = {}, ctxExtra = {}) {
  const bodies = [];
  const fetch = composeFetch([osvRoutes(map, { bodies, ...opts })]);
  return { bodies, fetch, ctx: makeIntelCtx(fetch, ctxExtra) };
}

test('CHECK id', () => assert.equal(CHECK, 'osv'));

test('real case: MAL id becomes a high signal with osv.dev link', async () => {
  const { ctx } = setup({ 'tailwind-animate-kit@2.0.8': ['MAL-2026-18078'] });
  const res = await run(input([dep('tailwind-animate-kit', '2.0.8'), dep('clsx', '2.1.1')]), ctx);
  assert.equal(res.signals.length, 1);
  const s = res.signals[0];
  assert.equal(s.rule, 'osv-malicious');
  assert.equal(s.severity, 'high');
  assert.equal(s.title, 'Dependency version listed as malicious in OSV');
  assert.equal(s.evidence, 'tailwind-animate-kit@2.0.8: MAL-2026-18078');
  assert.deepEqual(s.refs, ['https://osv.dev/vulnerability/MAL-2026-18078']);
  assert.equal(s.file, 'web/package-lock.json');
  assert.equal(s.line, null);
  assert.deepEqual(res.notVerified, []);
});

test('advisories are aggregated in a single info signal with count and ids', async () => {
  const { ctx } = setup({ 'lodash@4.17.21': ['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff', 'CVE-2021-23337'] });
  const res = await run(input([dep('lodash', '4.17.21')]), ctx);
  assert.equal(res.signals.length, 1);
  const s = res.signals[0];
  assert.equal(s.rule, 'osv-advisory');
  assert.equal(s.severity, 'info');
  assert.match(s.evidence, /^3 advisories/);
  assert.match(s.evidence, /lodash@4\.17\.21/);
  assert.match(s.evidence, /GHSA-aaaa-bbbb-cccc/);
});

test('advisory evidence lists at most 10 ids', async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}-xxxx-yyyy`);
  const { ctx } = setup({ 'a@1.0.0': ids });
  const res = await run(input([dep('a', '1.0.0')]), ctx);
  assert.match(res.signals[0].evidence, /^15 advisories/);
  assert.equal((res.signals[0].evidence.match(/GHSA-/g) ?? []).length, 10);
});

test('empty result {} produces no signal', async () => {
  const { ctx } = setup({});
  const res = await run(input([dep('clsx', '2.1.1')]), ctx);
  assert.deepEqual(res, { signals: [], notVerified: [] });
});

test('request body carries only package name/ecosystem and version, scoped names as text', async () => {
  const { ctx, bodies } = setup({});
  await run(input([dep('@s/b', '1.0.0'), dep('x', '2.0.0'), dep('x', '2.0.0')]), ctx);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { queries: [
    { package: { name: '@s/b', ecosystem: 'npm' }, version: '1.0.0' },
    { package: { name: 'x', ecosystem: 'npm' }, version: '2.0.0' },
  ] });
  assert.ok(!JSON.stringify(bodies[0]).includes('purl'));
});

test('2500 dependencies are sent in 3 batches of 1000/1000/500', async () => {
  const { ctx, bodies } = setup({});
  const deps = Array.from({ length: 2500 }, (_, i) => dep(`p${i}`, '1.0.0'));
  const res = await run(input(deps), ctx);
  assert.deepEqual(bodies.map((b) => b.queries.length), [1000, 1000, 500]);
  assert.equal(ctx.network.hosts['api.osv.dev'], 3);
  assert.deepEqual(res.notVerified, []);
});

test('more than 50 batches: only 50 are sent and the remainder is declared', async () => {
  const { ctx, bodies } = setup({});
  const deps = Array.from({ length: 51000 }, (_, i) => dep(`p${i}`, '1.0.0'));
  const res = await run(input(deps), ctx);
  assert.equal(bodies.length, 50);
  assert.equal(res.notVerified.length, 1);
  assert.equal(res.notVerified[0].check, 'osv');
  assert.match(res.notVerified[0].reason, /1000 dependencies not checked/);
});

test('next_page_token triggers a follow-up request only for that query', async () => {
  const { ctx, bodies } = setup(
    { 'a@1.0.0': ['GHSA-1111-aaaa-bbbb'], 'b@1.0.0': [] },
    { tokens: { 'a@1.0.0': 'tok1' }, pages: { tok1: ['MAL-2026-1'] } },
  );
  const res = await run(input([dep('a', '1.0.0'), dep('b', '1.0.0')]), ctx);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].queries, [{ package: { name: 'a', ecosystem: 'npm' }, version: '1.0.0', page_token: 'tok1' }]);
  const rules = res.signals.map((s) => s.rule).sort();
  assert.deepEqual(rules, ['osv-advisory', 'osv-malicious']);
});

test('malformed shapes degrade to notVerified without inventing signals', async () => {
  for (const raw of [{ results: 'nope' }, { results: [] }, { results: [{}, {}, {}] }, null, 'x']) {
    const { ctx } = setup({}, { raw });
    const res = await run(input([dep('a', '1.0.0')]), ctx);
    assert.deepEqual(res.signals, []);
    assert.equal(res.notVerified.length, 1);
    assert.equal(res.notVerified[0].check, 'osv');
    assert.match(res.notVerified[0].reason, /unexpected response shape/);
  }
});

test('hostile ids are ignored, never composed into links', async () => {
  const { ctx } = setup({ 'a@1.0.0': ['MAL-1/../../x', 'MAL-2026-5'] });
  const res = await run(input([dep('a', '1.0.0')]), ctx);
  assert.equal(res.signals.length, 1);
  assert.deepEqual(res.signals[0].refs, ['https://osv.dev/vulnerability/MAL-2026-5']);
});

test('network failure and 5xx degrade to notVerified, no exception', async () => {
  const failing = makeIntelCtx(async () => { throw new Error('boom'); });
  const r1 = await run(input([dep('a', '1.0.0')]), failing);
  assert.deepEqual(r1.signals, []);
  assert.equal(r1.notVerified[0].check, 'osv');
  const { ctx } = setup({}, { status: 503 });
  const r2 = await run(input([dep('a', '1.0.0')]), ctx);
  assert.deepEqual(r2.signals, []);
  assert.equal(r2.notVerified[0].check, 'osv');
});

test('no versioned dependency means no request', async () => {
  const { ctx, fetch } = setup({});
  const res = await run(input([dep('a', null), dep('b', null)]), ctx);
  assert.deepEqual(res.signals, []);
  assert.equal(fetch.log.length, 0);
  assert.equal(ctx.network.hosts['api.osv.dev'], undefined);
});

test('the same advisory id on several dependency versions is listed once (verification 01/11)', async () => {
  const id = 'GHSA-g3hv-75wg-m249';
  const { ctx } = setup({ 'a@1.0.0': [id], 'a@1.0.1': [id], 'b@2.0.0': [id, 'GHSA-aaaa-bbbb-cccc'] });
  const res = await run(input([dep('a', '1.0.0'), dep('a', '1.0.1'), dep('b', '2.0.0')]), ctx);
  const s = res.signals.find((x) => x.rule === 'osv-advisory');
  assert.equal(s.evidence.split(id).length - 1, 1, s.evidence);
  assert.match(s.evidence, /GHSA-aaaa-bbbb-cccc/);
  assert.match(s.evidence, /^2 advisories in 3 dependency versions/);
});
