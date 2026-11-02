// Handover from the core fixer (core CR-03): findLines returns the matches found before a timeout; the rules must
// keep them instead of discarding the whole file. Texts stay in memory (no trap file on disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as agents from '../skills/repoflags/scripts/lib/rules/agents.mjs';
import * as npmrc from '../skills/repoflags/scripts/lib/rules/npmrc.mjs';
import * as configFiles from '../skills/repoflags/scripts/lib/rules/config-files.mjs';

const ctx = (regexTimeoutMs) => ({ options: { limits: { regexTimeoutMs, maxLineLength: 100000 } }, addSecret() {} });
const run = (mod, file, text, ms) => mod.detect(new Map([[file, { text, size: text.length }]]), ctx(ms));
const timedOut = (r) => r.notVerified.some((n) => /timed out|budget exceeded/.test(n.reason));
// D-118: with a 2-5 ms limit the timer sometimes fired before line 1 was scanned (matrix red on WSL Node 18 and 24;
// 1-7 failures in 30 fresh runs per test under CPU load). 50 ms leaves line 1 far inside the limit, and each padding
// takes about 0.9-1.5 s to scan without a limit (Node 22, Windows), so the scan still always stops.
const LIMIT_MS = 50;
const MANY_LINES = Array.from({ length: 2_000_000 }, () => 'x').join('\n');

test('agents: a flagged line before the point where the scan stopped is still a signal', () => {
  const pad = Array.from({ length: 200 }, () => 'curl '.repeat(1990)).join('\n');
  const r = run(agents, 'AGENTS.md', `run npm install now\n${pad}\n`, LIMIT_MS);
  assert.ok(timedOut(r), 'the scan must really stop for this test to mean anything');
  assert.ok(r.signals.some((s) => s.rule === 'ai-instructions' && s.severity === 'medium' && s.line === 1), JSON.stringify(r.signals));
});

test('npmrc: a token found before the point where the scan stopped is still a high signal', () => {
  const r = run(npmrc, '.npmrc', `_authToken=FAKE_TOKEN_FOR_TESTS_ONLY_0099\n${MANY_LINES}\n`, LIMIT_MS);
  assert.ok(timedOut(r), 'the scan must really stop for this test to mean anything');
  assert.ok(r.signals.some((s) => s.rule === 'npmrc-auth-token' && s.line === 1), JSON.stringify(r.signals));
});

test('config files: imports found before the stop are kept and obfuscation still runs (IN-01)', () => {
  // Few long lines, not MANY_LINES: this rule maps every line to an object, and 2 million of them made the heap
  // large enough for a pause to cross the limit before line 1 (1 failure in 30 under load, Windows and WSL).
  const pad = Array.from({ length: 40 }, () => 'import '.repeat(14000)).join('\n');
  const r = run(configFiles, 'x.config.js', `require('@fixture-evil/x'); eval(1)\n${pad}\n`, LIMIT_MS);
  assert.ok(timedOut(r), 'the scan must really stop for this test to mean anything');
  assert.ok(r.signals.some((s) => s.rule === 'config-require-nonstandard' && s.evidence.includes('@fixture-evil/x')), JSON.stringify(r.signals));
  assert.ok(r.signals.some((s) => s.rule === 'config-obfuscation' && s.line === 1), JSON.stringify(r.signals));
});
