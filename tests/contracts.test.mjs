import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_MODULES, runRules } from '../skills/repoflags/scripts/lib/rules/index.mjs';
import { INTEL_MODULES, runIntel } from '../skills/repoflags/scripts/lib/intel/index.mjs';
import { collectDependencies } from '../skills/repoflags/scripts/lib/rules/deps/collect.mjs';
import { applyChains } from '../skills/repoflags/scripts/lib/rules/chain.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';

const ctx = (extra = {}) => ({ options: {}, addSecret() {}, mode: 'online', ...extra });
const shape = (r) => Array.isArray(r.signals) && Array.isArray(r.notVerified);

test('every rule module has a kebab-case RULE and a detect() with the right shape', () => {
  for (const m of RULE_MODULES) {
    assert.match(m.RULE, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(shape(m.detect(new Map(), ctx())), m.RULE);
  }
});

test('every intel module exports CHECK and an async run()', async () => {
  for (const m of INTEL_MODULES) {
    assert.equal(typeof m.CHECK, 'string');
    assert.equal(m.run.constructor.name, 'AsyncFunction');
  }
});

test('dependency collection and chains keep their shapes', () => {
  const c = collectDependencies(new Map());
  assert.ok(Array.isArray(c.deps) && Array.isArray(c.notVerified));
  assert.ok(shape(applyChains([], { deps: [], notVerified: [] })));
});

// Contract changed by the core handover (fail-open class, REP-02): a rule that throws on crafted input must not
// leave "no signals found". The notVerified entry is unchanged; a medium `rule-failed` signal is added.
test('a rule that throws becomes notVerified with a clean reason and a medium signal', () => {
  const bad = { RULE: 'broken-rule', detect() { throw new Error('boom\u001b[31m\nsecond line'); } };
  const r = runRules(new Map(), ctx(), [bad]);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].rule, 'rule-failed');
  assert.equal(r.signals[0].severity, 'medium');
  assert.ok(r.signals[0].evidence.startsWith('broken-rule: '), r.signals[0].evidence);
  assert.doesNotMatch(r.signals[0].evidence, /[\u0000-\u001f]/);
  assert.equal(r.notVerified.length, 1);
  assert.equal(r.notVerified[0].check, 'broken-rule');
  assert.ok(r.notVerified[0].reason.startsWith('rule failed:'));
  assert.doesNotMatch(r.notVerified[0].reason, /[\u0000-\u001f]/);
});

test('offline intel makes no network call and declares what was skipped', async () => {
  const log = [];
  const c = ctx({ mode: 'offline', fetch: makeForbiddenFetch(log) });
  const acquired = { target: { type: 'github' }, files: new Map() };
  const r = await runIntel({ acquired, deps: [], signals: [] }, c);
  assert.equal(log.length, 0);
  for (const check of ['osv', 'npm-registry', 'repo-metadata']) {
    const e = r.notVerified.find((n) => n.check === check);
    assert.ok(e, check);
    assert.equal(e.reason, 'skipped: offline mode');
  }
});

test('local target online skips repo-metadata with the D-12 reason', async () => {
  const acquired = { target: { type: 'local' }, files: new Map() };
  const stub = [{ CHECK: 'osv', run: async () => ({ signals: [], notVerified: [] }) },
    { CHECK: 'repo-metadata', run: async () => { throw new Error('must not run'); } }];
  const r = await runIntel({ acquired, deps: [], signals: [] }, ctx(), stub);
  const e = r.notVerified.find((n) => n.check === 'repo-metadata');
  assert.equal(e.reason, 'local folder: rerun on owner/repo for repository metadata');
});

test('an intel module that throws degrades to notVerified', async () => {
  const acquired = { target: { type: 'github' }, files: new Map() };
  const bad = [{ CHECK: 'osv', run: async () => { throw new Error('network down'); } }];
  const r = await runIntel({ acquired, deps: [], signals: [] }, ctx(), bad);
  assert.equal(r.notVerified[0].check, 'osv');
  assert.match(r.notVerified[0].reason, /network down/);
});
