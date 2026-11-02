import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../skills/repoflags/scripts/lib/rules/config-files.mjs';
import { IMPORT_CASES } from './fixtures/config-cases.mjs';

export function run(map, options = {}) {
  const files = new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }]));
  return detect(files, { options, addSecret() {} });
}

const nonstd = (r) => r.signals.filter((s) => s.rule === 'config-require-nonstandard');

test('real case: require of an unknown plugin is medium with file and line', () => {
  const r = run(IMPORT_CASES.realCase);
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.rule, 'config-require-nonstandard');
  assert.equal(s.severity, 'medium');
  assert.equal(s.file, 'web/tailwind.config.js');
  assert.equal(s.line, 1);
  assert.ok(s.evidence.includes('tailwind-animate-kit'));
});

test('import forms and subpaths normalize to the package name', () => {
  const r = run(IMPORT_CASES.scoped);
  const ev = nonstd(r).map((s) => [s.line, s.evidence]);
  assert.equal(ev.length, 3);
  assert.ok(ev[0][1].includes('@scope/x'));
  assert.deepEqual(nonstd(r).map((s) => s.line), [1, 2, 3]);
});

test('dynamic require is medium with a dedicated title', () => {
  for (const key of ['dynamicVar', 'dynamicConcat']) {
    const r = run(IMPORT_CASES[key]);
    assert.equal(r.signals.length, 1, key);
    assert.equal(r.signals[0].severity, 'medium');
    assert.equal(r.signals[0].title, 'Dynamic require in executable config file');
  }
});

test('builtins and relative imports are silent', () => {
  assert.equal(run(IMPORT_CASES.builtinsAndRelative).signals.length, 0);
});

test('known tooling plugins produce no signal', () => {
  const r = run(IMPORT_CASES.tooling);
  assert.deepEqual(r.signals, []);
});

test('options.configAllowlist silences a custom package', () => {
  assert.equal(run(IMPORT_CASES.custom).signals.length, 1);
  assert.equal(run(IMPORT_CASES.custom, { configAllowlist: ['my-plugin'] }).signals.length, 0);
});

test('non-config files are ignored', () => {
  assert.equal(run(IMPORT_CASES.notConfig).signals.length, 0);
});

test('config file names at any depth and case are analyzed', () => {
  assert.equal(run(IMPORT_CASES.names).signals.length, 4);
});

test('an allowlisted require does not hide a second one on the same line', () => {
  const r = run(IMPORT_CASES.sameLineEvasion);
  assert.equal(r.signals.length, 1);
  assert.ok(r.signals[0].evidence.includes('evil-second'));
});

test('no leftover "not implemented" entry', () => {
  assert.deepEqual(run(IMPORT_CASES.realCase).notVerified, []);
});

// ---- Task 2: obfuscation ----
import { performance } from 'node:perf_hooks';
import {
  INDICATOR_LINES, ESCAPES_20, LONG_LINE_400, WHITESPACE_HIDDEN, WHITESPACE_TRAILING, WHITESPACE_INDENT,
  MULTI_INDICATOR, BLOB_B64, BLOB_PLAIN,
} from './fixtures/config-cases.mjs';
import { IMPORT_PATTERNS, OBFUSCATION_PATTERNS } from '../skills/repoflags/scripts/lib/rules/config-patterns.mjs';
import { splitLines, findLines } from '../skills/repoflags/scripts/lib/util/text-scan.mjs';

const obf = (r) => r.signals.filter((s) => s.rule === 'config-obfuscation');

for (const [id, line] of Object.entries(INDICATOR_LINES)) {
  test(`obfuscation indicator ${id} is high`, () => {
    const r = run({ 'x.config.js': `module.exports = {};\n${line}\n` });
    const s = obf(r);
    assert.equal(s.length, 1);
    assert.equal(s[0].severity, 'high');
    assert.equal(s[0].line, 2);
    assert.equal(s[0].title, 'Obfuscated or hidden code in executable config file');
    assert.ok(s[0].evidence.includes(`indicator: ${id.replace('-v', '')}`));
    assert.ok(!/indicator: [^|]*[()]/.test(s[0].evidence));
  });
}

test('20 escape sequences on a line are high', () => {
  const s = obf(run({ 'x.config.js': ESCAPES_20 }));
  assert.equal(s.length, 1);
  assert.ok(s[0].evidence.includes('escape-run'));
});

test('code beyond column 300 is high', () => {
  assert.ok(LONG_LINE_400.length > 300);
  const s = obf(run({ 'x.config.js': LONG_LINE_400 }));
  assert.equal(s.length, 1);
  assert.ok(s[0].evidence.includes('code beyond column 300'));
});

test('code after a long whitespace run is high; trailing or leading whitespace is not', () => {
  const hidden = obf(run({ 'x.config.js': WHITESPACE_HIDDEN }));
  assert.equal(hidden.length, 1);
  assert.ok(hidden[0].evidence.includes('code after long whitespace run'));
  assert.equal(obf(run({ 'x.config.js': WHITESPACE_TRAILING })).length, 0);
  assert.equal(obf(run({ 'x.config.js': WHITESPACE_INDENT })).length, 0);
});

test('fixture blob decodes to a harmless string', () => {
  assert.equal(Buffer.from(BLOB_B64, 'base64').toString(), BLOB_PLAIN);
});

test('several indicators on one line give one signal listing all', () => {
  const s = obf(run({ 'x.config.js': MULTI_INDICATOR }));
  assert.equal(s.length, 1);
  for (const id of ['eval-call', 'atob-call', 'hex-identifier']) assert.ok(s[0].evidence.includes(id), id);
});

test('plain config has no obfuscation signal', () => {
  assert.equal(obf(run({ 'x.config.js': 'module.exports = { a: 1 };\n' })).length, 0);
});

test('ReDoS: every pattern stays within budget on pathological input', () => {
  const inputs = [
    'a'.repeat(50000), `${' '.repeat(50000)}x`, '_0x'.repeat(20000), '\\u'.repeat(20000),
    'require('.repeat(10000), 'import '.repeat(10000), '\\x41'.repeat(20000), "Buffer.from(".repeat(5000),
  ];
  let max = 0;
  for (const p of [...IMPORT_PATTERNS, ...OBFUSCATION_PATTERNS]) {
    for (const input of inputs) {
      const t0 = performance.now();
      const r = findLines(splitLines(input, 10000), [p], 200);
      const dt = performance.now() - t0;
      max = Math.max(max, dt);
      assert.equal(r.timedOut, false, `${p.id} timed out`);
      assert.ok(dt < 200, `${p.id} took ${dt.toFixed(1)} ms`);
    }
  }
  console.log(`# redos max ms: ${max.toFixed(1)}`);
});

// ---- review rules CR-02, CR-03 ----
test('CR-02: a require between two allowlisted imports on one line is not skipped', () => {
  const r = run({ 'tailwind.config.js': "require('vite');require('@fixture-evil/pkg');import 'vite';\n" });
  assert.ok(nonstd(r).some((s) => s.evidence.includes('@fixture-evil/pkg')), JSON.stringify(r));
});

test('CR-02: more allowlisted imports on one line than scan rounds never hide the last one silently', () => {
  const line = `${"require('vite');".repeat(150)}require('@fixture-evil/pkg');\n`;
  const r = run({ 'tailwind.config.js': line });
  assert.ok(nonstd(r).length >= 1, JSON.stringify(r));
});

const EVASIONS = {
  'space before paren': "module.exports = require ('@fixture-evil/pkg');\n",
  'argument on next line': "const p = require(\n  '@fixture-evil/pkg'\n);\n",
  'import without spaces': "import{x}from'@fixture-evil/pkg';\n",
  'export star from': "export * from '@fixture-evil/pkg';\n",
  'export named from': 'export { default } from "@fixture-evil/pkg";\n',
  'multi-line import list': "import {\n  a,\n  b,\n} from '@fixture-evil/pkg';\n",
  'dynamic import with space': "const m = await import ('@fixture-evil/pkg');\n",
  'require.resolve': "module.exports = { plugins: [require.resolve('@fixture-evil/pkg')] };\n",
};

for (const [label, text] of Object.entries(EVASIONS)) {
  test(`CR-03: ${label} is detected with the package name`, () => {
    const r = run({ 'vite.config.mjs': text });
    assert.ok(nonstd(r).some((s) => s.evidence.includes('@fixture-evil/pkg')), JSON.stringify(r.signals));
  });
}

test('CR-03: an alias of require or createRequire is a dynamic require', () => {
  for (const text of ["const r = require; r('@fixture-evil/pkg');\n", "import { createRequire } from 'node:module';\nconst q = createRequire(import.meta.url);\n"]) {
    const r = run({ 'tailwind.config.js': text });
    assert.ok(nonstd(r).some((s) => s.title === 'Dynamic require in executable config file'), text);
  }
});

// ---- review rules WR-07: the tooling allowlist must not be a way around the rule ----
test('WR-07: a ./.. segment leaves the allowlisted package and is flagged', () => {
  const r = run({ 'tailwind.config.js': "require('tailwindcss/../@fixture-evil/pkg');\n" });
  assert.ok(nonstd(r).some((s) => s.evidence.includes('@fixture-evil/pkg')), JSON.stringify(r.signals));
});

test('WR-07: an allowlisted scope redirected to another registry is not known tooling any more', () => {
  const r = run({ '.npmrc': '@babel:registry=https://npm.example.invalid/\n', 'babel.config.js': "require('@babel/fixture-evil');\n" });
  assert.ok(nonstd(r).some((s) => s.evidence.includes('@babel/fixture-evil')), JSON.stringify(r.signals));
});

test('WR-07: with a non-public default registry, unscoped allowlisted names are flagged too', () => {
  const r = run({ '.npmrc': 'registry=https://npm.example.invalid/\n', 'eslint.config.js': "require('eslint-plugin-fixture');\n" });
  assert.ok(nonstd(r).some((s) => s.evidence.includes('eslint-plugin-fixture')), JSON.stringify(r.signals));
});

test('WR-07: a scope redirected to the public registry keeps the allowlist', () => {
  const r = run({ '.npmrc': '@babel:registry=https://registry.npmjs.org/\n', 'babel.config.js': "require('@babel/preset-env');\n" });
  assert.deepEqual(nonstd(r), []);
});

test('WR-07: a scope redirected in .yarnrc.yml (block or flow mapping) is not known tooling', () => {
  for (const yml of ['npmScopes:\n  babel:\n    npmRegistryServer: "https://npm.example.invalid"\n', 'npmScopes: {babel: {npmRegistryServer: "https://npm.example.invalid"}}\n']) {
    const r = run({ '.yarnrc.yml': yml, 'babel.config.js': "require('@babel/fixture-evil');\n" });
    assert.ok(nonstd(r).some((s) => s.evidence.includes('@babel/fixture-evil')), yml);
  }
});

test('03-06 panel (jest eslint.config.mjs): "export"/"from" inside a rule name string is not an import', () => {
  const r = run({ 'eslint.config.mjs': "export default [{ rules: {\n  'unicorn/prefer-export-from': 'off',\n  'x/no-import-from': 'warn',\n} }];\n" });
  assert.deepEqual(nonstd(r), []);
  const real = run({ 'eslint.config.mjs': "export { default } from 'evil-pkg';\nimport x from'other-evil';\n" });
  assert.deepEqual(nonstd(real).map((s) => s.evidence.includes('evil-pkg') || s.evidence.includes('other-evil')), [true, true]);
});

// Review CR-01: the lookbehind must not exclude `/`: a block comment glued to `import`/`from` hid the import.
test('03-review CR-01: a block comment glued to import/export/from does not hide the import', () => {
  for (const src of ["/* x */import x from 'evil-pkg';", "import x/**/from 'evil-pkg';", "/**/export * from 'evil-pkg';"]) {
    assert.ok(nonstd(run({ 'eslint.config.mjs': src })).some((s) => s.evidence.includes('evil-pkg')), src);
  }
});
