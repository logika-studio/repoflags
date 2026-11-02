// Review CR-A-03 (Phase 2): a specifier with `.`/`..`/empty segments, a backslash or a percent sign can make Node
// load a package outside the allowlisted prefix. Such a name is never "known tooling", built-in list or user list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as configFiles from '../skills/repoflags/scripts/lib/rules/config-files.mjs';
import { isAllowlisted } from '../skills/repoflags/scripts/lib/rules/config-patterns.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { files as realCase } from './fixtures/real-case.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';

const mapOf = (file, text) => new Map([[file, { text, size: text.length }]]);
const ctx = (options = {}) => ({ options, addSecret: () => {}, secrets: new Set() });
const loads = (spec, options) => configFiles
  .detect(mapOf('tailwind.config.js', `module.exports = { plugins: [require('${spec}')] };\n`), ctx(options))
  .signals.filter((s) => s.rule === 'config-require-nonstandard');

const BUILT_IN_ESCAPES = [
  'babel-x/../evil',
  '@tailwindcss/a/../../@evil/p',
  'eslint-config-x\\\\..\\\\evil', // JS source text: two backslashes in the file, one in the string
  'webpack-x/./../evil',
  'babel-x//../evil',
  '@babel/x/%2e%2e/evil',
];

test('CR-A-03: non-canonical names never match a prefix of the built-in list', () => {
  for (const name of ['babel-x/../evil', '@tailwindcss/a/../../@evil/p', 'eslint-config-x\\..\\evil', 'webpack-x/./x', '@babel/%2e%2e']) {
    assert.equal(isAllowlisted(name), false, name);
  }
  // Canonical names keep matching.
  assert.equal(isAllowlisted('babel-plugin-x'), true);
  assert.equal(isAllowlisted('@tailwindcss/forms'), true);
});

test('CR-A-03: canonical specifiers keep their behaviour (subpath, trailing slash of a builtin shim)', () => {
  assert.equal(loads('babel-plugin-x/lib/index').length, 0);
  assert.equal(loads('@tailwindcss/forms').length, 0);
  assert.equal(loads('buffer/').length, 0);
  assert.equal(configFiles.packageName('@babel/preset-env/lib'), '@babel/preset-env');
});

test('CR-A-03: non-canonical names never match a user entry (prefix, scope or exact)', () => {
  assert.equal(isAllowlisted('@mycorp/x/../../evil', ['@mycorp/*'], { tooling: false }), false);
  assert.equal(isAllowlisted('mycorp-x\\..\\evil', ['mycorp-*'], { tooling: false }), false);
  assert.equal(isAllowlisted('mycorp-x/../evil', ['mycorp-x/../evil'], { tooling: false }), false);
  assert.equal(isAllowlisted('@mycorp/ui', ['@mycorp/*'], { tooling: false }), true);
});

test('CR-A-03: a config file loading an escaping specifier still produces config-require-nonstandard', () => {
  for (const spec of BUILT_IN_ESCAPES) assert.equal(loads(spec).length, 1, spec);
});

test('CR-A-03: an escaping specifier under a user scope entry is not marked suppressedByUser', () => {
  const s = loads('@mycorp/x/../../evil', { userConfigAllowlist: ['@mycorp/*'] });
  assert.equal(s.length, 1);
  assert.notEqual(s[0].suppressedByUser, true);
  const back = loads('mycorp-x\\\\..\\\\evil', { userConfigAllowlist: ['mycorp-*'] });
  assert.equal(back.length, 1);
  assert.notEqual(back[0].suppressedByUser, true);
});

test('CR-A-03: the real case with the private package hidden behind @tailwindcss/a/../../ still fires the chain', async (t) => {
  const files = {
    ...realCase,
    'web/tailwind.config.js': "module.exports = { plugins: [require('@tailwindcss/a/../../tailwind-animate-kit')] };\n",
  };
  const m = await materialize(files);
  t.after(m.cleanup);
  const res = await analyze(m.dir, { offline: true }, offlineDeps(t, { now: () => new Date('2026-11-01T00:00:00Z'), env: {} }));
  const rules = res.signals.map((s) => s.rule);
  assert.ok(rules.includes('config-require-nonstandard'));
  assert.ok(rules.includes('chain-private-dependency'));
});
