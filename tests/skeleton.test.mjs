import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { makeIo } from './helpers/io.mjs';
import { hermeticEnv } from './helpers/child-env.mjs';
import { files, FAKE_TOKEN } from './fixtures/real-case.mjs';

const execFileP = promisify(execFile);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/repoflags/scripts/repoflags.mjs');
const NOW = () => new Date('2026-11-01T00:00:00Z');

function run(t, argv) {
  const c = makeIo();
  const deps = offlineDeps(t, { now: NOW, env: {} });
  return main(argv, c.io, deps).then((code) => ({ code, out: c.stdout(), err: c.stderr(), fetchLog: deps.fetch.log }));
}

test('real case: exit 1, JSON report with the masked npmrc token', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const r = await run(t, [dir, '--offline', '--format', 'json']);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.out);
  assert.equal(report.schemaVersion, '1.1.0');
  assert.equal(report.outcome, 'signals_found');
  assert.equal(report.mode, 'offline');
  assert.equal(report.target.type, 'local');
  assert.equal(report.target.name, path.basename(dir));
  assert.ok(report.notVerified.length > 0);
  const sig = report.signals.find((s) => s.rule === 'npmrc-auth-token');
  assert.ok(sig, 'npmrc-auth-token signal expected');
  assert.equal(sig.severity, 'high');
  assert.equal(sig.file, 'web/.npmrc');
  assert.equal(sig.line, 1);
  assert.ok(sig.evidence.includes('FAKE…['));
  assert.ok(!sig.evidence.includes(FAKE_TOKEN));
  assert.ok(!r.out.includes(FAKE_TOKEN));
  assert.ok(!r.err.includes(FAKE_TOKEN));
  assert.equal(r.fetchLog.length, 0);
});

test('real case: text format has outcome and Not verified, never the word safe', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const r = await run(t, [dir, '--offline', '--format', 'text']);
  assert.equal(r.code, 1);
  assert.match(r.out, /signals found/);
  assert.match(r.out, /Not verified/);
  assert.doesNotMatch(r.out, /safe/i);
  assert.ok(!r.out.includes(FAKE_TOKEN));
  assert.ok(!r.err.includes(FAKE_TOKEN));
  assert.ok(r.out.includes('FAKE…['));
});

test('clean folder: exit 0, no_signals outcome, notVerified non empty', async (t) => {
  const { dir, cleanup } = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(cleanup);
  const r = await run(t, [dir, '--offline', '--format', 'json']);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.out);
  assert.equal(report.outcome, 'no_signals_found_by_these_rules');
  assert.ok(report.notVerified.length > 0);
});

test('remote target with --offline: exit 2', async (t) => {
  const r = await run(t, ['owner/repo', '--offline']);
  assert.equal(r.code, 2);
  assert.ok(r.err.length > 0);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

test('invalid target: exit 2 without stack trace', async (t) => {
  const r = await run(t, ['a/b/c/d', '--offline']);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

test('real entry point as child process exits 1', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  await assert.rejects(
    execFileP(process.execPath, [SCRIPT, dir, '--offline', '--format', 'json'], { env: hermeticEnv() }),
    (e) => {
      assert.equal(e.code, 1);
      const report = JSON.parse(e.stdout);
      assert.equal(report.schemaVersion, '1.1.0');
      return true;
    },
  );
});
