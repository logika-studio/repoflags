import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { applyUserConfig } from '../skills/repoflags/scripts/lib/config/apply.mjs';
import { validate } from '../skills/repoflags/scripts/lib/report/schema-check.mjs';
import { files as realCase } from './fixtures/real-case.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { makeIo } from './helpers/io.mjs';
import { schema, assertValidReport, assertNoForbiddenWords } from './helpers/report-assert.mjs';

const CFG_REL = '.config/repoflags/config.json';
const NOW = () => new Date('2026-11-01T00:00:00Z');
const sig = (rule, extra = {}) => ({ rule, severity: 'high', title: rule, file: 'f', line: 1, evidence: 'x', refs: [], ...extra });

async function fx(t, files) {
  const m = await materialize(files);
  t.after(m.cleanup);
  return m.dir;
}

// Config files live in an OS temp dir created and removed by the test; the real home is never read.
async function run(t, argv, cfgText) {
  const out = { home: null };
  const files = cfgText === undefined ? { 'other.txt': 'x' } : { [CFG_REL]: cfgText };
  out.home = await fx(t, files);
  const c = makeIo();
  const deps = offlineDeps(t, { now: NOW, env: {}, homedir: () => out.home });
  const code = await main([...argv, '--offline'], c.io, deps);
  return { code, stdout: c.stdout(), stderr: c.stderr(), home: out.home };
}

const ENVRC = { '.envrc': 'export FOO=bar\n' };

test('applyUserConfig: drops disabled rules and suppressedByUser, strips the flag, notes what is off', () => {
  const kept = sig('npmrc-auth-token');
  const res = applyUserConfig([sig('envrc'), kept, sig('x', { suppressedByUser: true })], { disabledRules: ['envrc'] });
  assert.deepEqual(res.signals, [kept]);
  assert.ok(res.signals.every((s) => !('suppressedByUser' in s)));
  assert.deepEqual(res.notVerified, [{ check: 'envrc', reason: 'disabled by user config' }]);
});

test('applyUserConfig: the flag is removed from kept signals too, and notVerified is sorted', () => {
  const res = applyUserConfig([{ ...sig('a'), suppressedByUser: false }], { disabledRules: ['zeta', 'alpha'] });
  assert.ok(!('suppressedByUser' in res.signals[0]));
  assert.deepEqual(res.notVerified.map((n) => n.check), ['alpha', 'zeta']);
});

test('applyUserConfig: nothing off, nothing flagged -> same signals, empty notVerified', () => {
  const input = [sig('a'), sig('b')];
  const res = applyUserConfig(input, { disabledRules: [] });
  assert.deepEqual(res.signals, input);
  assert.deepEqual(res.notVerified, []);
});

test('a switched-off rule vanishes, is declared as not verified, and the exit code follows the rest', async (t) => {
  const dir = await fx(t, { ...ENVRC });
  const off = await run(t, [dir, '--format', 'json'], '{"rules":{"envrc":false}}');
  assert.equal(off.code, 0, off.stderr);
  const report = JSON.parse(off.stdout);
  assert.equal(report.outcome, 'no_signals_found_by_these_rules');
  assert.ok(!report.signals.some((s) => s.rule === 'envrc'));
  assert.ok(report.notVerified.some((n) => n.check === 'envrc' && n.reason === 'disabled by user config'));
  assert.deepEqual(report.config.disabledRules, ['envrc']);
  assertValidReport(report);

  const on = await run(t, [dir, '--format', 'json']);
  assert.equal(on.code, 1);
  assert.ok(JSON.parse(on.stdout).signals.some((s) => s.rule === 'envrc'));
});

test('without a config file: no config field, schemaVersion 1.1.0', async (t) => {
  const dir = await fx(t, { 'package.json': '{"name":"x"}' });
  const r = await run(t, [dir, '--format', 'json']);
  const report = JSON.parse(r.stdout);
  assert.equal(report.schemaVersion, '1.1.0');
  assert.ok(!('config' in report));
  assertValidReport(report);
});

test('an empty config file still yields a config field with empty facts', async (t) => {
  const dir = await fx(t, { 'package.json': '{"name":"x"}' });
  const r = await run(t, [dir, '--format', 'json'], '{}');
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.config, {
    disabledRules: [], thresholds: {}, allowlist: { configPackages: 0, lifecycleCommands: 0 }, language: null,
  });
  assertValidReport(report);
});

test('the report never carries the config path or the temp folder name', async (t) => {
  const dir = await fx(t, { ...ENVRC });
  for (const format of ['json', 'text']) {
    const r = await run(t, [dir, '--format', format], '{"rules":{"envrc":false}}');
    const unique = r.home.split(/[\\/]/).pop();
    assert.ok(unique.length >= 6);
    assert.ok(!r.stdout.includes(unique), `${format} output leaked the home folder name`);
    assert.ok(!r.stdout.includes('config.json'), `${format} output leaked the config file name`);
  }
});

test('text output has a Config: line only when a file was loaded, listing off rules and changed thresholds', async (t) => {
  const dir = await fx(t, { 'package.json': '{"name":"x"}' });
  const none = await run(t, [dir, '--format', 'text']);
  assert.doesNotMatch(none.stdout, /^Config:/m);
  const some = await run(t, [dir, '--format', 'text'], '{"rules":{"envrc":false},"thresholds":{"maxCodeColumn":400}}');
  const line = some.stdout.split('\n').find((l) => l.startsWith('Config:'));
  assert.ok(line, some.stdout);
  assert.match(line, /envrc/);
  assert.match(line, /maxCodeColumn/);
  assertNoForbiddenWords(some.stdout);
});

test('schema: config is optional, strict at every level, and typed', () => {
  assert.equal(schema.required.includes('config'), false);
  assert.ok(schema.properties.config);
  const base = {
    schemaVersion: '1.1.0', tool: { name: 'repoflags', version: '1.0.0' }, rulesVersion: '1.0.0',
    target: { type: 'local', name: 'x', owner: null, repo: null, ref: null, sha: null },
    analyzedAt: 'now', mode: 'offline', outcome: 'no_signals_found_by_these_rules', signals: [],
    notVerified: Array.from({ length: 5 }, (_, i) => ({ check: `c${i}`, reason: 'r' })),
    limits: { maxFileBytes: 1, maxLockfileBytes: 1, maxFiles: 1, maxTotalBytes: 1, requestTimeoutMs: 1, globalTimeoutMs: 1, maxLineLength: 1, reached: [] },
    network: { hosts: {} },
  };
  const cfg = { disabledRules: ['envrc'], thresholds: { maxCodeColumn: 300 }, allowlist: { configPackages: 1, lifecycleCommands: 0 }, language: 'it' };
  assert.deepEqual(validate(schema, base), []);
  assert.deepEqual(validate(schema, { ...base, config: cfg }), []);
  assert.notDeepEqual(validate(schema, { ...base, config: { ...cfg, path: '/x' } }), []);
  assert.notDeepEqual(validate(schema, { ...base, config: { ...cfg, allowlist: { ...cfg.allowlist, extra: 1 } } }), []);
  assert.notDeepEqual(validate(schema, { ...base, config: { ...cfg, thresholds: { maxCodeColumn: 'x' } } }), []);
  assert.notDeepEqual(validate(schema, { ...base, config: { ...cfg, thresholds: { other: 1 } } }), []);
});

test('late filter: switching off config-require-nonstandard does not dissolve the chain', async (t) => {
  const dir = await fx(t, realCase);
  const r = await run(t, [dir, '--format', 'json'], '{"rules":{"config-require-nonstandard":false}}');
  const report = JSON.parse(r.stdout);
  assert.ok(report.signals.some((s) => s.rule === 'chain-private-dependency'), JSON.stringify(report.signals.map((s) => s.rule)));
  assert.ok(!report.signals.some((s) => s.rule === 'config-require-nonstandard'));
  assert.equal(r.code, 1);
});
