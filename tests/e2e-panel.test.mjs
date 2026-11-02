// 03-02 Task 2 (D-80a): the real-repo panel registry and its runner. No network, no real child: the spawn is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_PANEL } from './fixtures/real-panel.mjs';
import { cli, summarizeReport, panelArgs } from '../scripts/e2e/run-panel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNNER = path.join(ROOT, 'scripts', 'e2e', 'run-panel.mjs');
const SHA = /^[0-9a-f]{40}$/;
const OPTS = { script: path.join(ROOT, 'skills', 'repoflags', 'scripts', 'repoflags.mjs'), preload: path.join(HERE, 'helpers', 'net-trace-preload.mjs') };

const sink = () => { const o = { out: '', err: '' }; o.write = (s) => { o.out += s; }; o.writeErr = (s) => { o.err += s; }; return o; };
const report = (signals = [], outcome = 'no_signals_found_by_these_rules') => ({ outcome, signals, target: { sha: 'a'.repeat(40) } });
const sig = (severity, rule, file) => ({ id: 'S1', rule, severity, title: 't', file, line: 1, evidence: 'e', refs: [] });

/** Fake spawn: records order and concurrency, writes a fake netlog, returns a JSON report. */
function fakeSpawn({ events, code = 0, rep = report(), calls = [] } = {}) {
  let inFlight = 0;
  const spawn = async (cmd, args, opts) => {
    inFlight += 1;
    calls.push({ cmd, args, inFlight, cwd: opts.cwd });
    await new Promise((r) => setImmediate(r));
    const ev = events ?? [{ t: 'connect', host: 'api.github.com', port: 443 }, { t: 'exec', file: 'gh', args: ['auth', 'token'] }];
    fs.writeFileSync(opts.env.REPOFLAGS_NETLOG, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    inFlight -= 1;
    return { code, stdout: JSON.stringify(rep), stderr: '' };
  };
  return { spawn, calls };
}

test('REAL_PANEL has 7 entries, all pinned to 40-hex SHAs; webpack and jest keep their release tag', () => {
  assert.equal(REAL_PANEL.length, 7);
  for (const e of REAL_PANEL) assert.ok(e.repo && e.exercises, e.repo);
  for (const e of REAL_PANEL) assert.match(e.sha, SHA, e.repo);
  const tagged = REAL_PANEL.filter((e) => e.tag !== null).map((e) => e.repo).sort();
  assert.deepEqual(tagged, ['jestjs/jest', 'webpack/webpack']);
  for (const e of REAL_PANEL.filter((x) => x.tag !== null)) assert.match(e.tag, /^v\d/);
  assert.equal(REAL_PANEL.find((e) => e.repo === 'octocat/Hello-World').sha, '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d');
});

test('panelArgs builds the --import command and refuses an unpinned sha', () => {
  const e = REAL_PANEL.find((x) => x.repo === 'lodash/lodash');
  const a = panelArgs(e, OPTS);
  assert.equal(a[0], '--import');
  assert.match(a[1], /^file:\/\/\/.*net-trace-preload\.mjs$/);
  assert.deepEqual(a.slice(2), [OPTS.script, 'lodash/lodash', '--ref', e.sha, '--format', 'json']);
  assert.throws(() => panelArgs({ repo: 'a/b', sha: null, tag: 'v1' }, OPTS), /sha/);
  assert.throws(() => panelArgs({ repo: 'a/b', sha: 'abc' }, OPTS), /sha/);
});

test('dry-run (no --confirm): prints 7 exact commands, exits 0, never spawns', async () => {
  const s = sink(); const { spawn, calls } = fakeSpawn();
  const code = await cli({ argv: ['node', 'run-panel'], spawn, write: s.write, writeErr: s.writeErr });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.match(s.out, /dry-run/);
  assert.equal(s.out.split('\n').filter((l) => l.startsWith('node ')).length, 7);
});

test('--confirm without --out-dir, or with --out-dir inside the repo: exit 2, no spawn', async () => {
  for (const extra of [[], ['--out-dir', path.join(ROOT, 'tmp-out')], ['--out-dir', ROOT], ['--out-dir', 'relative-dir']]) {
    const s = sink(); const { spawn, calls } = fakeSpawn();
    const code = await cli({ argv: ['node', 'run-panel', '--confirm', ...extra], spawn, write: s.write, writeErr: s.writeErr });
    assert.equal(code, 2, extra.join(' '));
    assert.equal(calls.length, 0);
  }
});

test('--confirm: sequential, all 7 pinned entries run, report and netlog written outside the repo', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-panel-'));
  try {
    const s = sink(); const { spawn, calls } = fakeSpawn();
    const code = await cli({ argv: ['node', 'run-panel', '--confirm', '--out-dir', dir], spawn, write: s.write, writeErr: s.writeErr });
    assert.equal(code, 0, s.out + s.err);
    assert.equal(calls.length, 7, 'every pinned entry runs');
    assert.ok(calls.every((c) => c.inFlight === 1), 'never two in flight');
    assert.deepEqual(calls.map((c) => c.args[3]), REAL_PANEL.filter((e) => e.sha).map((e) => e.repo));
    assert.equal((s.out.match(/sha not pinned/g) ?? []).length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'lodash-lodash.json')));
    assert.ok(fs.existsSync(path.join(dir, 'lodash-lodash.netlog.jsonl')));
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('--only limits to one entry; an unknown repo is exit 2', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-panel-'));
  try {
    const s = sink(); const { spawn, calls } = fakeSpawn();
    const code = await cli({ argv: ['node', 'run-panel', '--confirm', '--out-dir', dir, '--only', 'octocat/Hello-World'], spawn, write: s.write, writeErr: s.writeErr });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    const s2 = sink();
    assert.equal(await cli({ argv: ['node', 'run-panel', '--confirm', '--out-dir', dir, '--only', 'x/y'], spawn, write: s2.write, writeErr: s2.writeErr }), 2);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a host outside the allowlist or an unexpected exec makes the exit code 1', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-panel-'));
  try {
    for (const events of [[{ t: 'connect', host: '127.0.0.1', port: 80 }], [{ t: 'exec', file: 'curl', args: ['x'] }]]) {
      const s = sink(); const { spawn } = fakeSpawn({ events });
      const code = await cli({ argv: ['node', 'run-panel', '--confirm', '--out-dir', dir, '--only', 'octocat/Hello-World'], spawn, write: s.write, writeErr: s.writeErr });
      assert.equal(code, 1);
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('output never contains env values or a token value', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-panel-'));
  process.env.REPOFLAGS_TEST_ENV_SENTINEL = 'SENTINEL-ENV-VALUE-9931';
  process.env.GH_TOKEN = ['gh', 'p_', 'FAKETOKENVALUE', '0'.repeat(22)].join('');
  const outFile = path.join(dir, 'table.md');
  try {
    const s = sink(); const { spawn } = fakeSpawn();
    await cli({ argv: ['node', 'run-panel', '--confirm', '--out-dir', dir, '--only', 'octocat/Hello-World', '--out', outFile], spawn, write: s.write, writeErr: s.writeErr });
    const all = s.out + s.err + fs.readFileSync(outFile, 'utf8');
    assert.doesNotMatch(all, /SENTINEL-ENV-VALUE-9931|FAKETOKENVALUE/);
    assert.match(fs.readFileSync(outFile, 'utf8'), /octocat\/Hello-World/);
  } finally {
    delete process.env.REPOFLAGS_TEST_ENV_SENTINEL; delete process.env.GH_TOKEN;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('summarizeReport: counts, rules with files, hosts, execs, off-allowlist, killed', () => {
  const rep = report([sig('high', 'lifecycle-script', 'package.json'), sig('medium', 'ai-instructions', 'AGENTS.md'), sig('info', 'x', 'y')], 'signals_found');
  const events = [{ t: 'connect', host: 'api.github.com', port: 443 }, { t: 'lookup', host: 'evil.invalid' }, { t: 'exec', file: 'gh', args: ['auth', 'token'] }];
  const s = summarizeReport(rep, events, 1, { repo: 'a/b', sha: 'c'.repeat(40) });
  assert.deepEqual(s.counts, { high: 1, medium: 1, info: 1 });
  assert.deepEqual(s.rules, [{ severity: 'high', rule: 'lifecycle-script', file: 'package.json' }, { severity: 'medium', rule: 'ai-instructions', file: 'AGENTS.md' }]);
  assert.deepEqual(s.hosts.sort(), ['api.github.com', 'evil.invalid']);
  assert.deepEqual(s.offAllowlist, ['evil.invalid']);
  assert.equal(s.execs.length, 1);
  assert.equal(s.killed, false);
  assert.equal(s.repo, 'a/b');
  for (const code of [3221225794, -1073741502]) assert.equal(summarizeReport(null, [], code, { repo: 'a/b', sha: null }).killed, true);
});

test('a killed child is reported and never rerun', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-panel-'));
  try {
    const s = sink(); const calls = [];
    const spawn = async (c, a) => { calls.push(a); return { code: 3221225794, stdout: '', stderr: '' }; };
    const code = await cli({ argv: ['node', 'run-panel', '--confirm', '--out-dir', dir, '--only', 'octocat/Hello-World'], spawn, write: s.write, writeErr: s.writeErr });
    assert.equal(calls.length, 1);
    assert.equal(code, 1);
    assert.match(s.out, /killed/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

const spawnsWithoutShellFalse = (src) => src.split(/\bnodeSpawn\(/).slice(1).map((s) => s.split('\n')[0]).filter((call) => !call.includes('shell: false'));

test('source: shell:false on every spawn, NODE_TEST_CONTEXT guard, no user names, no retry loop', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.ok(src.split(/\bnodeSpawn\(/).length - 1 >= 1);
  assert.deepEqual(spawnsWithoutShellFalse(src), []);
  assert.doesNotMatch(src, /shell:\s*true/);
  assert.match(src, /NODE_TEST_CONTEXT/);
  assert.doesNotMatch(src, /luigi/i);
  assert.doesNotMatch(src, /\bretr(y|ies)\b|attempt/i);
  assert.ok(src.split('\n').length <= 200);
});
