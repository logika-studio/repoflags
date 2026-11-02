import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, CHECK } from '../skills/repoflags/scripts/lib/intel/registry.mjs';
import { registryRoutes, composeFetch, makeIntelCtx } from './helpers/intel-routes.mjs';

const dep = (name, o = {}) => ({ name, version: '1.0.0', spec: '^1.0.0', file: 'web/package.json', direct: true, resolved: null, hasInstallScript: false, ...o });
const input = (deps) => ({ acquired: { target: { type: 'local' }, files: new Map(), github: null }, deps, signals: [] });

function setup(map, ctxExtra = {}) {
  const requests = [];
  const fetch = composeFetch([registryRoutes(map, { requests })]);
  return { requests, fetch, ctx: makeIntelCtx(fetch, ctxExtra) };
}

test('CHECK id', () => assert.equal(CHECK, 'npm-registry'));

test('real case: scope missing on the public registry is dep-unresolvable', async () => {
  const { ctx, requests } = setup({});
  const res = await run(input([dep('@fixture-private/motion-helpers')]), ctx);
  assert.equal(requests[0].url, 'https://registry.npmjs.org/@fixture-private%2Fmotion-helpers');
  assert.equal(requests[0].accept, 'application/vnd.npm.install-v1+json');
  assert.equal(res.signals.length, 1);
  const s = res.signals[0];
  assert.equal(s.rule, 'dep-unresolvable');
  assert.equal(s.severity, 'medium');
  assert.equal(s.title, 'Dependency not resolvable on the public npm registry');
  assert.equal(s.file, 'web/package.json');
  assert.match(s.evidence, /@fixture-private\/motion-helpers/);
  assert.deepEqual(res.notVerified, []);
});

test('401 and 403 are also unresolvable', async () => {
  const { ctx } = setup({ a: { status: 401 }, b: { status: 403 } });
  const res = await run(input([dep('a'), dep('b')]), ctx);
  assert.deepEqual(res.signals.map((s) => s.rule), ['dep-unresolvable', 'dep-unresolvable']);
});

test('5xx, network error and oversized packument are notVerified, never a signal', async () => {
  const { ctx } = setup({ a: { status: 503 }, b: { throws: true }, c: { bytes: 6 * 1024 * 1024 } });
  const res = await run(input([dep('a'), dep('b'), dep('c')]), ctx);
  assert.deepEqual(res.signals, []);
  assert.ok(res.notVerified.length >= 1);
  assert.ok(res.notVerified.every((n) => n.check === 'npm-registry'));
  assert.match(res.notVerified.map((n) => n.reason).join(' '), /3 packages/);
});

test('security placeholder is a medium signal; locked version missing is stated', async () => {
  const { ctx } = setup({ 'tailwind-animate-kit': { latest: '0.0.1-security', versions: ['0.0.1-security'] } });
  const res = await run(input([dep('tailwind-animate-kit', { version: '2.0.8', spec: '2.0.8' })]), ctx);
  assert.equal(res.signals.length, 1);
  const s = res.signals[0];
  assert.equal(s.rule, 'npm-security-placeholder');
  assert.equal(s.severity, 'medium');
  assert.equal(s.title, 'Package replaced by npm security placeholder');
  assert.match(s.evidence, /0\.0\.1-security/);
  assert.match(s.evidence, /2\.0\.8/);
  assert.match(s.evidence, /not (in|among)/);
});

test('an existing package yields no signal', async () => {
  const { ctx } = setup({ '@tailwindcss/forms': { latest: '0.5.9', versions: ['0.5.9'] } });
  const res = await run(input([dep('@tailwindcss/forms')]), ctx);
  assert.deepEqual(res, { signals: [], notVerified: [] });
});

test('only direct deps and scoped names are queried; non-registry specs are skipped; names deduplicated', async () => {
  const { ctx, requests } = setup({ d: {}, '@s/t': {} });
  await run(input([
    dep('d'),
    dep('d', { file: 'web/package-lock.json' }),
    dep('transitive', { direct: false }),
    dep('@s/t', { direct: false, spec: null }),
    dep('g', { spec: 'git+https://example.test/x.git' }),
    dep('f', { spec: 'file:../x' }),
    dep('w', { spec: 'workspace:*' }),
  ]), ctx);
  const names = requests.map((r) => decodeURIComponent(r.url.slice('https://registry.npmjs.org/'.length))).sort();
  assert.deepEqual(names, ['@s/t', 'd']);
});

test('more than 200 names: 200 queried, remainder declared; concurrency <= 4', async () => {
  let inflight = 0;
  let peak = 0;
  const base = registryRoutes({});
  const handler = async (u, i) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 1));
    inflight--;
    return base(u, i);
  };
  const fetch = composeFetch([handler]);
  const ctx = makeIntelCtx(fetch);
  const deps = Array.from({ length: 230 }, (_, i) => dep(`pkg${i}`));
  const res = await run(input(deps), ctx);
  assert.equal(fetch.log.length, 200);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(res.signals.length, 200);
  assert.match(res.notVerified.map((n) => n.reason).join(' '), /30 packages not checked/);
});

test('01/11 cap order: config-loaded packages first, then scoped, then direct; the cap stays 200 and is declared', async () => {
  const { ctx, requests } = setup({});
  const deps = [
    ...Array.from({ length: 250 }, (_, i) => dep(`pkg${String(i).padStart(3, '0')}`)),
    dep('@s/late', { direct: false, spec: null }),
    dep('loaded-late'),
  ];
  const signals = [{ rule: 'config-require-nonstandard', severity: 'medium', package: 'loaded-late', evidence: 'loaded-late' }];
  const res = await run({ ...input(deps), signals }, ctx);
  const names = requests.map((r) => decodeURIComponent(r.url.slice('https://registry.npmjs.org/'.length)));
  assert.equal(names.length, 200);
  assert.ok(names.includes('loaded-late'), 'config-loaded package beyond the cap was not looked up');
  assert.ok(names.includes('@s/late'), 'scoped package beyond the cap was not looked up');
  const cap = res.notVerified.find((n) => n.cap === true);
  assert.match(cap.reason, /52 packages not checked: limit of 200 names/);
  assert.equal(cap.names.length, 52);
  assert.ok(!cap.names.includes('loaded-late') && !cap.names.includes('@s/late'));
  // Within a tier the declaration order is kept: the last direct names are the ones beyond the cap.
  assert.deepEqual(cap.names.slice(0, 2), ['pkg198', 'pkg199']);
});

test('hostile packument keys do not reach prototypes', async () => {
  const fetch = composeFetch([async () => new Response('{"__proto__":{"dist-tags":{"latest":"0.0.1-security"}}}', { status: 200 })]);
  const res = await run(input([dep('a')]), makeIntelCtx(fetch));
  assert.deepEqual(res.signals, []);
});

test('no dependencies means no request', async () => {
  const { ctx, fetch } = setup({});
  const res = await run(input([]), ctx);
  assert.deepEqual(res, { signals: [], notVerified: [] });
  assert.equal(fetch.log.length, 0);
});

test('WR-06: a 401/403/404 whose body is not JSON (proxy, WAF page) is not verified, never unresolvable', async () => {
  for (const status of [401, 403, 404]) {
    const fetch = composeFetch([async () => new Response('<html>blocked</html>', { status })]);
    const res = await run(input([dep('@tailwindcss/forms')]), makeIntelCtx(fetch));
    assert.deepEqual(res.signals, [], `status ${status}`);
    assert.ok(res.notVerified.some((n) => n.check === CHECK), `status ${status}`);
  }
});
