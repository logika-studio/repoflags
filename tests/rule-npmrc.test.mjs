import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, RULE } from '../skills/repoflags/scripts/lib/rules/npmrc.mjs';

function run(map) {
  const secrets = [];
  const files = new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }]));
  const res = detect(files, { options: {}, addSecret: (s) => secrets.push(s) });
  return { ...res, secrets };
}

test('literal _authToken is high, masked, line 1', () => {
  const token = 'FAKE_TOKEN_FOR_TESTS_ONLY_0001';
  const r = run({ 'web/.npmrc': `//registry.npmjs.org/:_authToken=${token}\n` });
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.rule, RULE);
  assert.equal(s.severity, 'high');
  assert.equal(s.file, 'web/.npmrc');
  assert.equal(s.line, 1);
  assert.ok(s.evidence.includes('FAKE…[30 chars]'));
  assert.ok(!s.evidence.includes(token));
  assert.deepEqual(r.secrets, [token]);
});

test('environment interpolation is not a signal', () => {
  const r = run({ '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' });
  assert.equal(r.signals.length, 0);
});

test('_auth and _password literals are high', () => {
  const r = run({ '.npmrc': '_auth=dXNlcjpwYXNzd29yZDEyMw==\n_password=hunter2hunter2\n' });
  assert.equal(r.signals.length, 2);
  assert.deepEqual(r.signals.map((s) => s.line), [1, 2]);
});

test('yarnrc.yml npmAuthToken literal is high', () => {
  const r = run({ '.yarnrc.yml': 'npmAuthToken: "abcdefghijklmnop1234"\n' });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].severity, 'high');
  assert.ok(!r.signals[0].evidence.includes('abcdefghijklmnop1234'));
});

test('uppercase path is detected', () => {
  const r = run({ 'WEB/.NPMRC': '_authToken=abcdefghijklmnop1234\n' });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].file, 'WEB/.NPMRC');
});

test('pathological input completes quickly without throwing', () => {
  const t0 = Date.now();
  const r = run({ '.npmrc': '_authToken='.repeat(20000), 'a/.npmrc': `${' '.repeat(50000)}x` });
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(Array.isArray(r.signals));
});

// ---- review rules CR-08: native .yarnrc format, quoted keys, YAML flow mappings and block scalars ----
const T = 'FAKE_TOKEN_FOR_TESTS_ONLY_0008';
const FORMS = {
  'yarnrc v1 native': ['.yarnrc', `"//npm.pkg.github.com/:_authToken" "${T}"\n`],
  'yarnrc v1 unquoted': ['.yarnrc', `//npm.pkg.github.com/:_authToken ${T}\n`],
  'npmrc quoted key': ['.npmrc', `"//npm.pkg.github.com/:_authToken"=${T}\n`],
  'yarnrc.yml flow mapping': ['.yarnrc.yml', `npmScopes: {fixture: {npmAuthToken: ${T}}}\n`],
  'yarnrc.yml quoted key': ['.yarnrc.yml', `npmScopes:\n  fixture:\n    "npmAuthToken": "${T}"\n`],
  'yarnrc.yml block scalar': ['.yarnrc.yml', `npmAuthToken: >-\n  ${T}\n`],
};

for (const [label, [file, text]] of Object.entries(FORMS)) {
  test(`CR-08: ${label} is a high signal, value masked and registered`, () => {
    const r = run({ [file]: text });
    assert.equal(r.signals.length, 1, JSON.stringify(r.signals));
    assert.equal(r.signals[0].severity, 'high');
    assert.ok(!r.signals[0].evidence.includes(T));
    assert.deepEqual(r.secrets, [T]);
  });
}

test('IN-07: a literal prefix followed by ${VAR} is still a committed credential; ${VAR} alone is not', () => {
  const r = run({ '.npmrc': '//a.example.invalid/:_authToken=FAKE_PREFIX_FOR_TESTS_0007${SUFFIX}\n//b.example.invalid/:_authToken=${NPM_TOKEN}\n' });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].line, 1);
});
