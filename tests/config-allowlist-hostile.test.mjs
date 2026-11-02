// Review WR-A-01 (Phase 2): the user allowlist (configPackages) must not hide a package the repository itself
// redirected to another registry, installs from a non-public source, or that OSV / npm list as malicious.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as configFiles from '../skills/repoflags/scripts/lib/rules/config-files.mjs';
import { resolveConfigLoads } from '../skills/repoflags/scripts/lib/rules/config-resolution.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';

const ctx = (options = {}) => ({ options, addSecret: () => {}, secrets: new Set() });
const fileMap = (obj) => new Map(Object.entries(obj).map(([k, text]) => [k, { text, size: text.length }]));
const TAILWIND = "module.exports = { plugins: [require('@mycorp/ui')] };\n";
const loads = (files, options) => configFiles.detect(fileMap(files), ctx(options)).signals
  .filter((s) => s.rule === 'config-require-nonstandard');

test('WR-A-01: a scope redirected by the repository .npmrc is not suppressed by a user scope entry', () => {
  const files = { '.npmrc': '@mycorp:registry=https://evil.example/\n', 'tailwind.config.js': TAILWIND };
  const s = loads(files, { userConfigAllowlist: ['@mycorp/*'] });
  assert.equal(s.length, 1);
  assert.notEqual(s[0].suppressedByUser, true);
  // Without the redirect the user entry still applies.
  assert.equal(loads({ 'tailwind.config.js': TAILWIND }, { userConfigAllowlist: ['@mycorp/*'] })[0].suppressedByUser, true);
});

test('WR-A-01: a default registry redirected by the repository is not suppressed by an exact user entry', () => {
  const files = { '.npmrc': 'registry=https://evil.example/\n', 'tailwind.config.js': TAILWIND };
  assert.notEqual(loads(files, { userConfigAllowlist: ['@mycorp/ui'] })[0].suppressedByUser, true);
});

const signal = { rule: 'config-require-nonstandard', severity: 'medium', title: 't', file: 'tailwind.config.js', line: 1, evidence: 'x', refs: [], package: '@mycorp/ui', suppressedByUser: true };
const resolve = (over) => resolveConfigLoads([signal, ...(over.signals ?? [])], {
  deps: over.deps ?? [], notVerified: [], resolved: new Set(over.resolved ?? []), files: fileMap(over.files ?? {}), mode: over.mode ?? 'online',
})[0];

test('WR-A-01: resolveConfigLoads drops the user suppression on a hostile verdict', () => {
  const cases = {
    osv: { resolved: ['@mycorp/ui'], signals: [{ rule: 'osv-malicious', evidence: '@mycorp/ui@1.0.0: MAL-2026-1' }] },
    placeholder: { resolved: ['@mycorp/ui'], signals: [{ rule: 'npm-security-placeholder', evidence: '@mycorp/ui: 0.0.1-security' }] },
    nonPublic: { deps: [{ name: '@mycorp/ui', spec: 'git+https://evil.example/ui.git', direct: true }] },
    redirectOffline: { mode: 'offline', files: { '.npmrc': '@mycorp:registry=https://evil.example/\n' } },
  };
  for (const [name, over] of Object.entries(cases)) {
    const out = resolve(over);
    assert.ok(!('suppressedByUser' in out), `${name}: ${JSON.stringify(out)}`);
  }
});

test('WR-A-01: a non-hostile verdict keeps the user suppression (private package not on the public registry)', () => {
  assert.equal(resolve({ signals: [{ rule: 'dep-unresolvable', evidence: '@mycorp/ui: not found' }] }).suppressedByUser, true);
  assert.equal(resolve({ mode: 'offline' }).suppressedByUser, true);
});

test('WR-A-01: end to end, the redirected allowlisted package stays in the report', async (t) => {
  const m = await materialize({
    'package.json': '{"name":"x","dependencies":{"@mycorp/ui":"1.0.0"}}',
    '.npmrc': '@mycorp:registry=https://evil.example/\n',
    'tailwind.config.js': TAILWIND,
  });
  t.after(m.cleanup);
  const res = await analyze(m.dir, { offline: true, userConfigAllowlist: ['@mycorp/*'] }, offlineDeps(t, { now: () => new Date('2026-11-01T00:00:00Z'), env: {} }));
  assert.ok(res.signals.some((s) => s.rule === 'config-require-nonstandard'), JSON.stringify(res.signals.map((s) => s.rule)));
});
