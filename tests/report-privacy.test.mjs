import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { buildReport } from '../skills/repoflags/scripts/lib/report/build.mjs';
import { renderText } from '../skills/repoflags/scripts/lib/report/text.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { assertValidReport } from './helpers/report-assert.mjs';
import { files } from './fixtures/real-case.mjs';

const deps = { env: {}, now: () => new Date('2026-11-01T00:00:00Z') };

function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allStrings(x, out); }
  return out;
}

/**
 * Needles found in any key or string value of the parsed report, with either separator (WR-08: the old check
 * searched the JSON blob, where Windows backslashes are doubled, so a leak never matched).
 */
function leakedNeedles(report, needles) {
  const strings = allStrings(JSON.parse(JSON.stringify(report))).map((s) => s.split('\\').join('/'));
  return needles.filter((n) => { const v = n.split('\\').join('/'); return strings.some((s) => s.includes(v)); });
}

// Review tests WR-08: a needle is a Windows path, the JSON blob escapes it, the check never saw it.
test('WR-08: the leak check finds a Windows or POSIX path inside a JSON report', () => {
  const win = 'C:\\Users\\someone\\AppData\\Local\\Temp';
  assert.deepEqual(leakedNeedles({ target: { name: `${win}\\repoflags-fx-1` } }, [win]), [win]);
  assert.deepEqual(leakedNeedles({ notVerified: [{ reason: 'cannot read C:/Users/someone/AppData/Local/Temp/x' }] }, [win]), [win]);
  assert.deepEqual(leakedNeedles({ signals: [{ evidence: '/home/someone/x' }] }, ['/home/someone']), ['/home/someone']);
  assert.deepEqual(leakedNeedles({ target: { name: 'repoflags-fx-1' } }, [win, '/home/someone']), []);
});

test('no absolute path, home or username; target.name is the basename', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const report = await analyze(dir, { offline: true }, offlineDeps(t, deps));
  assertValidReport(report);
  assert.equal(report.target.name, path.basename(dir));
  const needles = [os.tmpdir(), os.homedir(), dir];
  let username = '';
  try { username = os.userInfo().username; } catch { username = ''; } // no passwd entry in some containers
  // A short user name (root, ci) can appear legitimately in a report: only names of 4+ characters are needles.
  if (username.length >= 4) needles.push(username);
  assert.deepEqual(leakedNeedles(report, needles).map((n) => `${n.length} char value`), []);
  for (const needle of needles) assert.ok(!renderText(report).includes(needle), `text report leaks ${needle.length} char value`);
});

test('no person-identifying keys', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const report = await analyze(dir, { offline: true }, offlineDeps(t, deps));
  const keys = allKeys(report);
  for (const k of ['author', 'email', 'login', 'committer']) assert.ok(!keys.has(k), k);
});

test('local analysis performs no write or temp-dir creation', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const spies = [
    t.mock.method(fs, 'writeFileSync'),
    t.mock.method(fs.promises, 'writeFile'),
    t.mock.method(fs.promises, 'appendFile'),
    t.mock.method(fs.promises, 'mkdtemp'),
  ];
  await analyze(dir, { offline: true }, offlineDeps(t, deps));
  for (const s of spies) assert.equal(s.mock.callCount(), 0);
});

test('bidi override and ANSI in evidence never reach the report', () => {
  const r = buildReport({
    acquired: { target: { type: 'local', name: 'dir‮\u001b[31m' } },
    signals: [{ rule: 'r', severity: 'high', title: 't‮', file: 'a\u001b[31m.js', line: 1, evidence: 'x‮y\u001b[31mz', refs: [] }],
    notVerified: [{ check: 'c', reason: 'r‮' }],
    ctx: { now: () => new Date('2026-11-01T00:00:00Z'), mode: 'offline', limits: createLimits({}), network: { hosts: {} } },
  });
  const blob = JSON.stringify(r);
  assert.doesNotMatch(blob, /\\u202e|\\u001b|‮/i);
  assert.doesNotMatch(renderText(r), /‮|\u001b/);
  assertValidReport(r);
});

// Review rules CR-01: a credential value is chosen by the repository author. Redacting it everywhere in the
// serialized output let `_auth=high` erase every "high" and short values break the JSON keys.
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';

const LONG_TOKEN = 'FAKE_TOKEN_FOR_TESTS_ONLY_0042';
const CHOSEN = {
  '.npmrc': `_auth=high\n_password=e\n//a.example.invalid/:_authToken=signals_found\n//b.example.invalid/:_authToken=npmrc-auth-token\n//c.example.invalid/:_authToken=${LONG_TOKEN}\n`,
  'tailwind.config.js': `module.exports = { plugins: [require('fixture-kit')] }; // ${LONG_TOKEN}\n`,
};

test('CR-01: credential values chosen by the repo never rewrite the report structure', async (t) => {
  const { dir, cleanup } = await materialize(CHOSEN);
  t.after(cleanup);
  const { io, stdout } = makeIo();
  const code = await main([dir, '--offline', '--format', 'json'], io, offlineDeps(t, { now: deps.now, env: {} }));
  const out = stdout();
  const report = JSON.parse(out);
  assertValidReport(report);
  assert.equal(code, 1);
  assert.equal(report.outcome, 'signals_found');
  const tokens = report.signals.filter((s) => s.rule === 'npmrc-auth-token');
  assert.equal(tokens.length, 5);
  assert.ok(tokens.every((s) => s.severity === 'high'), JSON.stringify(tokens.map((s) => s.severity)));
  for (const key of ['schemaVersion', 'signals', 'outcome', 'notVerified', 'severity', 'evidence', 'name']) assert.ok(out.includes(`"${key}"`), key);
  assert.ok(!out.includes(LONG_TOKEN), 'the long token is still masked wherever it appears');
});
