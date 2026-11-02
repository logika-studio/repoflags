// Source policy of scripts/redteam (03-05): the construction rules of the red team runners, watched by tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'scripts', 'redteam');
const FILES = fs.readdirSync(DIR).filter((n) => n.endsWith('.mjs')).sort();
const read = (n) => fs.readFileSync(path.join(DIR, n), 'utf8');
const DISCOVERY = /^(test-.*|.*\.test\.[^.]+|.*-test\.[^.]+|.*_test\.[^.]+|test\.[^.]+)$/;

// Every spawn call (one line each) must carry `shell: false`; works for nodeSpawn( and spawn( alike.
// `spawn(` counts only in a file that imports child_process: elsewhere it is the injected, already checked spawner.
const spawnsWithoutShellFalse = (src) => src.split(/child_process/.test(src) ? /\b(?:nodeSpawn|spawn)\(/ : /\bnodeSpawn\(/).slice(1).map((s) => s.split('\n')[0]).filter((call) => !call.includes('shell: false'));
// A wildcard inside a Bash( or PowerShell( rule would approve more than the one exact command.
const wildcardRules = (src) => [...src.matchAll(/\b(?:Bash|PowerShell)\([^)\n]*\*[^)\n]*\)/g)].map((m) => m[0]);

test('the policy sees something to check', () => {
  assert.ok(FILES.length >= 8, FILES.join(', '));
});

test('self-check: the detectors catch a mutated sample', () => {
  assert.equal(spawnsWithoutShellFalse("import 'node:child_process';\nnodeSpawn(cmd, args, { shell: false });\nspawn('x', [], { shell: true });\n").length, 1);
  assert.equal(spawnsWithoutShellFalse("nodeSpawn(cmd, args, { shell: true });\n").length, 1);
  assert.equal(wildcardRules('`Bash(node "x" *)`').length, 1);
  assert.equal(wildcardRules('`Bash(node "x" \'t\' --format json)`').length, 0);
  assert.ok(DISCOVERY.test('redteam.test.mjs'));
});

for (const name of FILES) {
  test(`${name}: no user name, no re-run loop, no shell: true, no settings file, spawn with shell: false`, () => {
    const src = read(name);
    assert.doesNotMatch(src, /luigi/i);
    assert.doesNotMatch(src, /\bretr(y|ies)\b|attempt/i);
    assert.doesNotMatch(src, /shell:\s*true/);
    assert.doesNotMatch(src, /\.claude[\\/]settings/);
    assert.deepEqual(spawnsWithoutShellFalse(src), []);
    assert.deepEqual(wildcardRules(src), []);
    if (name !== 'claude-residue.mjs') assert.doesNotMatch(src, /homedir/);
    assert.ok(!DISCOVERY.test(name), 'would be collected by node --test');
  });
}

test('run-redteam.mjs exits at once under the test runner (NODE_TEST_CONTEXT)', () => {
  assert.match(read('run-redteam.mjs'), /NODE_TEST_CONTEXT/);
});

test('no file in scripts/redteam exceeds 300 lines', () => {
  for (const name of FILES) assert.ok(read(name).split('\n').length <= 300, name);
});
