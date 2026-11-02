// Review rules CR-09: package-manager settings that run repository code on every install (in memory only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_MODULES, runRules } from '../skills/repoflags/scripts/lib/rules/index.mjs';

const run = (map) => runRules(new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }])), { options: {}, addSecret() {} });
const pm = (r) => r.signals.filter((s) => s.rule === 'pm-config-exec');

const CASES = {
  'yarnPath': ['.yarnrc.yml', 'yarnPath: .yarn/releases/evil.cjs\n', 'medium', 'yarnPath'],
  'plugins block': ['.yarnrc.yml', 'plugins:\n  - path: .yarn/plugins/evil.cjs\n    spec: x\n', 'medium', '.yarn/plugins/evil.cjs'],
  'yarn-path (v1)': ['.yarnrc', 'yarn-path "./tools/yarn.js"\n', 'medium', 'yarn-path'],
  'script-shell to a repo file': ['.npmrc', 'script-shell=./tools/sh.js\n', 'high', 'script-shell'],
  'node-options --require': ['.npmrc', 'node-options=--require ./x.js\n', 'high', 'node-options'],
  'node-options without loading code': ['.npmrc', 'node-options=--max-old-space-size=4096\n', 'medium', 'node-options'],
  'onload-script': ['.npmrc', 'onload-script=./hook.js\n', 'high', 'onload-script'],
  'git to a repo file': ['.npmrc', 'git=./bin/git.js\n', 'high', 'git'],
};

for (const [label, [file, text, severity, needle]] of Object.entries(CASES)) {
  test(`CR-09: ${label} is a ${severity} pm-config-exec signal`, () => {
    const s = pm(run({ [file]: text }));
    assert.equal(s.length, 1, JSON.stringify(s));
    assert.equal(s[0].severity, severity);
    assert.ok(s[0].evidence.includes(needle), s[0].evidence);
    assert.equal(s[0].line, 1);
  });
}

test('CR-09: ordinary settings are quiet', () => {
  const r = run({ '.npmrc': 'save-exact=true\nengine-strict=true\n', '.yarnrc.yml': 'nodeLinker: node-modules\nenableTelemetry: false\n' });
  assert.deepEqual(pm(r), []);
});

test('CR-09: the rule is registered', () => {
  assert.ok(RULE_MODULES.some((m) => m.RULE === 'pm-config-exec'));
});
