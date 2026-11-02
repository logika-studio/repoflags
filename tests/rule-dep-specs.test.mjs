import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, RULE } from '../skills/repoflags/scripts/lib/rules/dep-specs.mjs';
import { files as realCase } from './fixtures/real-case.mjs';
import * as fx from './fixtures/lockfile-cases.mjs';

function run(map) {
  const files = new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }]));
  return detect(files, { options: {}, addSecret() {} });
}
const byRule = (r, rule) => r.signals.filter((s) => s.rule === rule);

test('RULE id', () => assert.equal(RULE, 'dep-nonregistry-source'));

test('non-registry specs in package.json: one medium signal each, evidence name: spec', () => {
  const r = run({ 'package.json': fx.pkgJson(fx.NON_REGISTRY_SPECS) });
  const sigs = byRule(r, 'dep-nonregistry-source');
  assert.equal(sigs.length, 5);
  for (const s of sigs) {
    assert.equal(s.severity, 'medium');
    assert.equal(s.title, 'Dependency installed from outside the public npm registry');
    assert.equal(s.file, 'package.json');
    assert.ok(s.line >= 1);
  }
  assert.ok(sigs.some((s) => s.evidence === 'x: git+https://example.invalid/x.git'));
  assert.ok(sigs.some((s) => s.evidence === 'w: someuser/somerepo'));
});

test('workspace, npm alias, ranges and tags raise nothing', () => {
  const r = run({ 'package.json': fx.pkgJson(fx.IGNORED_SPECS) });
  assert.deepEqual(r.signals, []);
});

test('lockfile resolved outside public registries is medium; public hosts are quiet', () => {
  const bad = run({ 'package-lock.json': fx.npmV3 });
  const sigs = byRule(bad, 'dep-nonregistry-source');
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].file, 'package-lock.json');
  assert.match(sigs[0].evidence, /gitdep/);
  const good = run({ 'yarn.lock': fx.yarnV1.replace('example.invalid', 'registry.yarnpkg.com') });
  assert.deepEqual(byRule(good, 'dep-nonregistry-source'), []);
});

test('custom registry in npm/yarn config is medium; the public one is quiet', () => {
  for (const [file, text] of [
    ['.npmrc', 'registry=https://npm.example.invalid/\n'],
    ['web/.npmrc', '@s:registry=https://npm.example.invalid/\n'],
    ['.yarnrc', 'registry "https://npm.example.invalid/"\n'],
    ['.yarnrc.yml', 'npmRegistryServer: "https://npm.example.invalid/"\n'],
  ]) {
    const s = run({ [file]: text }).signals;
    assert.equal(s.length, 1, file);
    assert.equal(s[0].severity, 'medium');
    assert.equal(s[0].title, 'Custom registry configured in npm config');
    assert.equal(s[0].line, 1);
  }
  assert.deepEqual(run({ '.npmrc': 'registry=https://registry.npmjs.org/\n' }).signals, []);
  assert.deepEqual(run({ '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' }).signals, []);
});

test('install scripts: one info signal per lockfile with count and names', () => {
  const r = run({ 'package-lock.json': fx.npmV3 });
  const info = byRule(r, 'dep-install-script');
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, 'info');
  assert.equal(info[0].title, 'Dependencies with install scripts in lockfile');
  assert.match(info[0].evidence, /^1 package.*@s\/b/);
  const many = JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0', hasInstallScript: true }])) });
  const m = byRule(run({ 'package-lock.json': many }), 'dep-install-script');
  assert.equal(m.length, 1);
  assert.match(m[0].evidence, /^15 packages/);
  assert.ok(!m[0].evidence.includes('p14'));
});

test('credentials in URLs never reach the evidence', () => {
  const r = run({ 'package.json': fx.pkgJson({ x: 'git+https://user:SECRETPASS@example.invalid/x.git?token=abc' }) });
  assert.ok(!JSON.stringify(r).includes('SECRETPASS'));
  assert.ok(!JSON.stringify(r).includes('token=abc'));
  assert.equal(r.signals.length, 1);
});

test('real-case produces no dep-nonregistry-source', () => {
  const r = run(realCase);
  assert.deepEqual(byRule(r, 'dep-nonregistry-source'), []);
});

test('no "not implemented" self-declaration', () => {
  assert.ok(!run({}).notVerified.some((n) => /not implemented/.test(n.reason)));
});

// ---- review rules CR-06: every spec form that installs code from outside the registry ----
import { collectDependencies } from '../skills/repoflags/scripts/lib/rules/deps/collect.mjs';
import { applyChains } from '../skills/repoflags/scripts/lib/rules/chain.mjs';

test('CR-06: scp-style git, ssh, local tarball, portal and patch specs are medium; exec is high', () => {
  const specs = {
    a: 'git@example.invalid:u/r.git', e: 'ssh://git@example.invalid/u/r.git', b: './vendor/b.tgz', h: '~/x.tgz',
    d: 'portal:../d', p: 'patch:left-pad@npm:1.3.0#./patches/lp.patch', c: 'exec:./gen.js',
  };
  const r = run({ 'package.json': fx.pkgJson(specs) });
  const sigs = byRule(r, 'dep-nonregistry-source');
  assert.equal(sigs.length, 7, JSON.stringify(sigs));
  const exec = sigs.find((s) => s.evidence.startsWith('c: '));
  assert.equal(exec.severity, 'high');
  assert.ok(sigs.filter((s) => s !== exec).every((s) => s.severity === 'medium'));
});

test('CR-06: an npm: alias is collected under the real package name, and its range is counted', () => {
  const files = new Map([['package.json', { text: fx.pkgJson({ 'tw-helper': 'npm:@fixture-private/tw@^1.0.0' }), size: 1 }]]);
  const { deps, notVerified } = collectDependencies(files);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].name, '@fixture-private/tw');
  assert.equal(deps[0].spec, '^1.0.0');
  assert.ok(notVerified.some((n) => n.check === 'osv' && /1 deps/.test(n.reason)), JSON.stringify(notVerified));
});

test('CR-06: offline, the alias of a private scoped package closes the chain', () => {
  const files = new Map([['package.json', { text: fx.pkgJson({ 'tw-helper': 'npm:@fixture-private/tw@^1.0.0' }), size: 1 }]]);
  const { deps } = collectDependencies(files);
  const sig = (rule) => ({ rule, severity: 'high', title: rule, file: 'x', line: 1, evidence: 'x', refs: [] });
  const res = applyChains([sig('npmrc-auth-token'), sig('config-require-nonstandard')], { deps, notVerified: [{ check: 'npm-registry', reason: 'skipped: offline mode' }] });
  assert.equal(res.signals.length, 1);
  assert.match(res.signals[0].evidence, /@fixture-private\/tw/);
});

test('CR-06 class: a yarn.lock (Berry) resolution through exec:, portal: or ssh is a non-registry source', () => {
  const lock = `__metadata:\n  version: 6\n\n"gen@exec:./gen.js":\n  version: 0.0.0-exec\n  resolution: "gen@exec:./gen.js#./gen.js::hash=1"\n\n"d@portal:../d":\n  version: 0.0.0-use.local\n  resolution: "d@portal:../d::locator=x"\n\n"s@ssh://git@example.invalid/u/s.git":\n  version: 1.0.0\n  resolution: "s@ssh://git@example.invalid/u/s.git#commit=abc"\n`;
  const sigs = byRule(run({ 'yarn.lock': lock }), 'dep-nonregistry-source');
  assert.equal(sigs.length, 3, JSON.stringify(sigs));
});

// ---- review rules WR-11: custom registries in every config syntax ----
const REGISTRY_FORMS = {
  'yarnrc v1 scoped quoted': ['.yarnrc', '"@fixture:registry" "https://npm.example.invalid/"\n'],
  'npmrc quoted key': ['.npmrc', '"@fixture:registry"=https://npm.example.invalid/\n'],
  'yarnrc.yml flow mapping': ['.yarnrc.yml', 'npmScopes: {fixture: {npmRegistryServer: "https://npm.example.invalid"}}\n'],
  'yarnrc.yml npmRegistries key': ['.yarnrc.yml', 'npmRegistries:\n  "https://npm.example.invalid":\n    npmAlwaysAuth: true\n'],
};
for (const [label, [file, text]] of Object.entries(REGISTRY_FORMS)) {
  test(`WR-11: ${label} is a custom registry signal`, () => {
    const sigs = run({ [file]: text }).signals.filter((s) => s.title === 'Custom registry configured in npm config');
    assert.equal(sigs.length, 1, JSON.stringify(sigs));
    assert.match(sigs[0].evidence, /npm\.example\.invalid/);
  });
}

test('WR-11: public registries in the same syntaxes stay quiet', () => {
  const r = run({
    '.yarnrc': '"@fixture:registry" "https://registry.yarnpkg.com"\n',
    '.yarnrc.yml': 'npmRegistries:\n  "//registry.npmjs.org":\n    npmAlwaysAuth: true\n',
  });
  assert.deepEqual(r.signals, []);
});
