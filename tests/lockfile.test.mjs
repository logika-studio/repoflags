import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDependencies } from '../skills/repoflags/scripts/lib/rules/deps/collect.mjs';
import { parseNpmLock } from '../skills/repoflags/scripts/lib/rules/deps/npm-lock.mjs';
import { parsePnpmLock } from '../skills/repoflags/scripts/lib/rules/deps/pnpm-lock.mjs';
import { parseYarnLock } from '../skills/repoflags/scripts/lib/rules/deps/yarn-lock.mjs';
import { files as realCase } from './fixtures/real-case.mjs';
import * as fx from './fixtures/lockfile-cases.mjs';

const toMap = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, { text: v, size: v.length }]));
const pairs = (deps) => deps.map((d) => `${d.name}@${d.version}`).sort();
const find = (deps, name, version) => deps.find((d) => d.name === name && d.version === version);

test('npm v3: names from path, name field wins, link skipped, direct flag', () => {
  const { entries } = parseNpmLock(fx.npmV3, 'package-lock.json');
  assert.deepEqual(pairs(entries), ['@s/b@2.0.0', '@s/b@2.0.1', 'a@1.0.2', 'gitdep@1.0.0', 'real-name@3.0.0']);
  assert.equal(find(entries, 'a', '1.0.2').direct, true);
  assert.equal(find(entries, '@s/b', '2.0.1').direct, false);
  assert.equal(find(entries, '@s/b', '2.0.1').hasInstallScript, true);
  assert.equal(find(entries, 'a', '1.0.2').resolved, 'https://registry.npmjs.org/a/-/a-1.0.2.tgz');
});

test('npm v1: nested dependencies are all extracted; URL version becomes resolved', () => {
  const { entries } = parseNpmLock(fx.npmV1, 'package-lock.json');
  assert.ok(find(entries, 'a', '1.0.0'));
  assert.ok(find(entries, 'c', '1.1.0'));
  const d = entries.find((e) => e.name === 'd');
  assert.equal(d.version, null);
  assert.match(d.resolved, /^git\+https:/);
});

test('npm v2: packages used without duplicates', () => {
  const { entries } = parseNpmLock(fx.npmV2, 'package-lock.json');
  assert.deepEqual(pairs(entries), ['a@1.0.0']);
});

test('real-case lockfile yields the camouflaged and the private-scope package', () => {
  const { deps } = collectDependencies(toMap(realCase));
  assert.ok(find(deps, 'tailwind-animate-kit', '2.0.8'));
  assert.ok(find(deps, '@fixture-private/motion-helpers', '1.0.0'));
  assert.ok(find(deps, 'next', '14.2.3'));
});

for (const [label, text] of [['v5', fx.pnpmV5], ['v6', fx.pnpmV6], ['v9', fx.pnpmV9]]) {
  test(`pnpm ${label}: scoped names, peer suffix removed`, () => {
    const { entries, notVerified } = parsePnpmLock(text, 'pnpm-lock.yaml');
    assert.deepEqual(pairs(entries), ['@s/b@2.0.0', 'a@1.0.0']);
    assert.deepEqual(notVerified, []);
  });
}

test('pnpm: requiresBuild and tarball resolution', () => {
  assert.equal(find(parsePnpmLock(fx.pnpmV5, 'f').entries, '@s/b', '2.0.0').hasInstallScript, true);
  assert.equal(find(parsePnpmLock(fx.pnpmV6, 'f').entries, '@s/b', '2.0.0').resolved, 'https://example.invalid/b-2.0.0.tgz');
});

test('yarn v1: multi-descriptor header, scoped, resolved', () => {
  const { entries } = parseYarnLock(fx.yarnV1, 'yarn.lock');
  assert.deepEqual(pairs(entries), ['@s/b@2.0.1', 'a@1.0.2']);
  assert.equal(find(entries, 'a', '1.0.2').resolved, 'https://registry.yarnpkg.com/a/-/a-1.0.2.tgz#abcdef');
});

test('yarn Berry: npm protocol accepted, workspace skipped, other protocols keep resolution', () => {
  const { entries } = parseYarnLock(fx.yarnBerry, 'yarn.lock');
  assert.deepEqual(pairs(entries).filter((p) => !p.startsWith('gitpkg')), ['@s/b@2.0.1', 'a@1.0.2']);
  assert.ok(!entries.some((e) => e.name === 'app'));
  const g = entries.find((e) => e.name === 'gitpkg');
  assert.match(g.resolved, /example\.invalid/);
});

test('package.json without lockfile: exact version kept, ranges reported not verified', () => {
  const r = collectDependencies(toMap({ 'package.json': fx.pkgJson({ x: '1.2.3', y: '^1.2.3', z: '~2.0.0' }) }));
  assert.ok(find(r.deps, 'x', '1.2.3'));
  assert.equal(find(r.deps, 'x', '1.2.3').direct, true);
  const range = r.notVerified.find((n) => n.check === 'osv');
  assert.match(range.reason, /^version ranges without lockfile not resolved: package.json \(2 deps\)$/);
});

test('ranges with a lockfile in the same folder do not raise the notice', () => {
  // The range must be IN the lockfile: a stale lockfile that lacks it raises a notice since review WR-05.
  const r = collectDependencies(toMap({ 'package.json': fx.pkgJson({ a: '^1.0.0' }), 'package-lock.json': fx.npmV2 }));
  assert.ok(!r.notVerified.some((n) => n.check === 'osv'));
});

test('bun.lockb, malformed and empty lockfiles are declared, never thrown', () => {
  const r = collectDependencies(toMap({
    'bun.lockb': '\u0000bun',
    'a/package-lock.json': '{ not json',
    'b/pnpm-lock.yaml': '',
    'c/yarn.lock': 'this is not a lockfile\nat all\n',
    'd/pnpm-lock.yaml': 'weird: [\n  nope\n',
  }));
  assert.ok(r.notVerified.some((n) => n.check === 'lockfile' && n.reason === 'binary bun.lockb not parsed'));
  for (const f of ['a/package-lock.json', 'b/pnpm-lock.yaml', 'c/yarn.lock', 'd/pnpm-lock.yaml']) {
    assert.ok(r.notVerified.some((n) => n.check === 'lockfile' && n.reason.includes(f)), f);
  }
  assert.deepEqual(r.deps, []);
});

test('invalid package names are dropped and counted', () => {
  const r = collectDependencies(toMap({ 'package.json': fx.pkgJson(fx.HOSTILE_NAMES[''].dependencies) }));
  assert.deepEqual(r.deps.map((d) => d.name), ['good']);
  const n = r.notVerified.find((x) => /invalid package names/.test(x.reason));
  assert.match(n.reason, /4 invalid package names/);
});

test('prototype-pollution keys in the lockfile do not touch Object.prototype', () => {
  const evil = '{"lockfileVersion":3,"packages":{"":{},"node_modules/__proto__":{"version":"1.0.0"},"__proto__":{"polluted":true}}}';
  parseNpmLock(evil, 'package-lock.json');
  assert.equal({}.polluted, undefined);
});

test('dedupe by name@version prefers the direct entry', () => {
  const r = collectDependencies(toMap({
    'package.json': fx.pkgJson({ a: '1.0.0' }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }),
  }));
  const as = r.deps.filter((d) => d.name === 'a' && d.version === '1.0.0');
  assert.equal(as.length, 1);
  assert.equal(as[0].direct, true);
});

test('20,000-entry lockfile parses in under 1 second', () => {
  const text = fx.bigNpmLock(20000);
  const t0 = Date.now();
  const r = collectDependencies(toMap({ 'package-lock.json': text }));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.deps.length, 20000);
});

test('no leftover "not implemented" entry', () => {
  assert.ok(!collectDependencies(new Map()).notVerified.some((n) => /not implemented/.test(n.reason)));
});

test('CR-05 review rules: a pnpm key followed by a long run of spaces is parsed in linear time', () => {
  const line = `  a@1.0.0:${' '.repeat(40000)}x`;
  const t0 = performance.now();
  parsePnpmLock(`lockfileVersion: '9.0'\npackages:\n${line}\n`, 'pnpm-lock.yaml');
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `${ms.toFixed(0)} ms`);
});

test('CR-05 review rules: a 1 MiB run of spaces after every kind of lockfile key stays fast', () => {
  const pad = ' '.repeat(1024 * 1024);
  const t0 = performance.now();
  parsePnpmLock(`packages:\n  a@1.0.0:${pad}x\n  /b/1.0.0: {}${pad}\n  'c@1.0.0':${pad}\n`, 'pnpm-lock.yaml');
  parseYarnLock(`a@^1:\n  version${pad}x\n  resolved:${pad}"y"\n`, 'yarn.lock');
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});

// ---- review rules WR-05: a lockfile that does not cover the manifest must not hide unchecked dependencies ----
test('WR-05: direct ranges missing from an empty or stale lockfile are declared as not resolved', () => {
  const files = toMap({
    'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.0', 'fixture-evil': '^1.0.0', present: '^2.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/present': { version: '2.1.0' } } }),
  });
  const { notVerified } = collectDependencies(files);
  const n = notVerified.find((x) => x.check === 'osv' && /not in the lockfile/.test(x.reason));
  assert.ok(n, JSON.stringify(notVerified));
  assert.match(n.reason, /2 deps/);
});

test('WR-05: yarn.lock entries without a version are counted, not dropped silently', () => {
  const lock = 'a@^1.0.0:\n  version "1.0.0"\n\nb@^2.0.0:\n  resolved "https://registry.yarnpkg.com/b/-/b-2.0.0.tgz"\n';
  const res = parseYarnLock(lock, 'yarn.lock');
  assert.equal(res.entries.length, 1);
  assert.ok(res.notVerified.some((n) => /1 .*without a version/.test(n.reason)), JSON.stringify(res.notVerified));
});

test('WR-05: a v1 package-lock deeper than the walk limit is declared', () => {
  let deps = { leaf: { version: '1.0.0' } };
  for (let i = 0; i < 70; i++) deps = { [`d${i}`]: { version: '1.0.0', dependencies: deps } };
  const res = parseNpmLock(JSON.stringify({ lockfileVersion: 1, dependencies: deps }), 'package-lock.json');
  assert.ok(res.notVerified.some((n) => /deeper than 64 not read/.test(n.reason)), JSON.stringify(res.notVerified));
});

// ---- review rules WR-12: pnpm entries that are not registry versions, and v9 without requiresBuild ----
const PNPM_V9_GIT = `lockfileVersion: '9.0'\n\npackages:\n\n  evil-git@https://codeload.example.invalid/u/evil/tar.gz/abc:\n    resolution: {tarball: https://codeload.example.invalid/u/evil/tar.gz/abc}\n    version: 1.0.0\n\n  ok@1.0.0:\n    resolution: {integrity: sha512-AAAA}\n`;

test('WR-12: a pnpm git/tarball key keeps its name and resolution instead of being "unrecognized"', () => {
  const res = parsePnpmLock(PNPM_V9_GIT, 'pnpm-lock.yaml');
  const git = res.entries.find((e) => e.name === 'evil-git');
  assert.ok(git, JSON.stringify(res.entries));
  assert.equal(git.resolved, 'https://codeload.example.invalid/u/evil/tar.gz/abc');
  assert.ok(!res.notVerified.some((n) => /unrecognized/.test(n.reason)), JSON.stringify(res.notVerified));
});

test('WR-12: pnpm v9 lockfiles declare that install scripts of dependencies are not recorded', () => {
  const res = parsePnpmLock(PNPM_V9_GIT, 'pnpm-lock.yaml');
  assert.ok(res.notVerified.some((n) => /install scripts/.test(n.reason)), JSON.stringify(res.notVerified));
});

test('03-06 panel: an npm alias resolves to the real package name (yarn v1 and Berry)', () => {
  assert.deepEqual(pairs(parseYarnLock(fx.yarnV1Alias, 'yarn.lock').entries), ['react-is@18.3.1']);
  assert.deepEqual(pairs(parseYarnLock(fx.yarnBerryAlias, 'yarn.lock').entries), ['@babel/core@8.0.5', 'c@3.1.0']);
});

test('03-06 panel: a Berry lockfile with only workspace entries is recognized, not "unrecognized format"', () => {
  const res = parseYarnLock(fx.yarnBerryWorkspaceOnly, 'yarn.lock');
  assert.deepEqual(res.entries, []);
  assert.ok(!res.notVerified.some((n) => /unrecognized/.test(n.reason)), JSON.stringify(res.notVerified));
});

// Review CR-02: a nested npm alias key chosen by the repository author must not blow the stack and drop the
// whole yarn.lock (fail-open); a lockfile that still cannot be parsed is a signal, never only a notVerified line.
const DEEP_ALIAS = `"${'a@npm:'.repeat(20000)}z@^1":\n  version "1.0.0"\n\nevil-fixture@^1:\n  version "6.6.6"\n`;
test('03-review CR-02: a 20k-deep nested alias key does not throw and the rest of yarn.lock is still read', () => {
  const res = parseYarnLock(DEEP_ALIAS, 'yarn.lock');
  assert.ok(find(res.entries, 'evil-fixture', '6.6.6'), JSON.stringify(res.entries).slice(0, 300));
  const { deps } = collectDependencies(toMap({ 'yarn.lock': DEEP_ALIAS }));
  assert.ok(find(deps, 'evil-fixture', '6.6.6'));
});

test('03-review CR-02: a lockfile whose parser throws produces a medium rule-failed signal', () => {
  const throwing = () => () => { throw new RangeError('Maximum call stack size exceeded'); };
  const res = collectDependencies(toMap({ 'yarn.lock': 'x@^1:\n  version "1.0.0"\n' }), { parserFor: throwing });
  assert.ok(Array.isArray(res.signals), 'collectDependencies returns signals');
  const s = res.signals.find((x) => x.rule === 'rule-failed');
  assert.ok(s, JSON.stringify(res.signals));
  assert.equal(s.severity, 'medium');
  assert.ok(res.notVerified.some((n) => /could not be parsed/.test(n.reason)));
});

test('03-review CR-02: analyze() carries the signals of the dependency collection into the report', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../skills/repoflags/scripts/lib/analyze.mjs', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.collected\.signals/);
});

// Review WR-08: an alias without a range (yarn v1) names the real package, not the alias the author chose.
test('03-review WR-08: an npm alias without a range resolves to the real package name, scoped or not', () => {
  const v1 = (key) => pairs(parseYarnLock(`# yarn lockfile v1\n\n"${key}":\n  version "1.0.0"\n`, 'yarn.lock').entries);
  assert.deepEqual(v1('x@npm:real'), ['real@1.0.0']);
  assert.deepEqual(v1('x@npm:@s/real'), ['@s/real@1.0.0']);
});
