import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLocal } from '../skills/repoflags/scripts/lib/acquire/local.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';

const MIB = 1024 * 1024;
const deps = () => ({ now: () => new Date('2026-11-01T00:00:00Z'), env: {} });

async function fixture(t, map) {
  const { dir, cleanup } = await materialize(map);
  t.after(cleanup);
  return dir;
}

function ctxWith(limits, signal) {
  return { limits: createLimits({ limits }), signal };
}

test('single file above maxFileBytes is not read and is declared', async (t) => {
  const dir = await fixture(t, { 'tailwind.config.js': 'a'.repeat(MIB + 1), 'package.json': '{}' });
  const ctx = ctxWith({});
  const acq = await acquireLocal(dir, ctx);
  assert.ok(!acq.files.has('tailwind.config.js'));
  assert.ok(acq.files.has('package.json'));
  assert.ok(acq.notVerified.some((n) => n.check === 'limits' && n.reason.includes('tailwind.config.js')));
  assert.ok(ctx.limits.snapshot().reached.includes('maxFileBytes'));
});

test('lockfile of 2 MiB is read thanks to the separate lockfile cap', async (t) => {
  const dir = await fixture(t, { 'package-lock.json': 'a'.repeat(2 * MIB) });
  const ctx = ctxWith({});
  const acq = await acquireLocal(dir, ctx);
  assert.ok(acq.files.has('package-lock.json'));
  assert.deepEqual(ctx.limits.snapshot().reached, []);
});

test('lockfile above maxLockfileBytes is not read, maxLockfileBytes reached', async (t) => {
  const dir = await fixture(t, { 'package-lock.json': 'a'.repeat(MIB + 1) });
  const ctx = ctxWith({ maxLockfileBytes: MIB });
  const acq = await acquireLocal(dir, ctx);
  assert.ok(!acq.files.has('package-lock.json'));
  assert.ok(ctx.limits.snapshot().reached.includes('maxLockfileBytes'));
  assert.ok(acq.notVerified.some((n) => n.reason.includes('package-lock.json')));
});

test('maxFiles keeps the highest priority files and names the rest', async (t) => {
  const dir = await fixture(t, {
    'package.json': '{}',
    '.npmrc': 'a=b',
    'package-lock.json': '{}',
    'sub/package.json': '{}',
    'sub/vite.config.js': 'x',
  });
  const ctx = ctxWith({ maxFiles: 3 });
  const acq = await acquireLocal(dir, ctx);
  assert.deepEqual([...acq.files.keys()].sort(), ['.npmrc', 'package-lock.json', 'package.json']);
  assert.ok(ctx.limits.snapshot().reached.includes('maxFiles'));
  const nv = acq.notVerified.find((n) => n.check === 'limits' && n.reason.includes('maxFiles') === false && n.reason.includes('sub/'));
  assert.ok(nv);
  assert.ok(nv.reason.includes('sub/package.json') && nv.reason.includes('sub/vite.config.js'));
});

test('long lists of unread paths are truncated to 20 names plus a count', async (t) => {
  const map = {};
  for (let i = 0; i < 30; i += 1) map[`d${String(i).padStart(2, '0')}/package.json`] = '{}';
  const dir = await fixture(t, map);
  const acq = await acquireLocal(dir, ctxWith({ maxFiles: 1 }));
  const nv = acq.notVerified.find((n) => n.check === 'limits');
  assert.ok(nv);
  assert.match(nv.reason, /and 9 more/);
  assert.equal((nv.reason.match(/package\.json/g) || []).length, 20);
});

test('maxTotalBytes exceeded is reached and declared', async (t) => {
  const dir = await fixture(t, { 'package.json': 'a'.repeat(60), '.npmrc': 'b'.repeat(60) });
  const ctx = ctxWith({ maxTotalBytes: 100 });
  const acq = await acquireLocal(dir, ctx);
  assert.equal(acq.files.size, 1);
  assert.ok(ctx.limits.snapshot().reached.includes('maxTotalBytes'));
  assert.ok(acq.notVerified.some((n) => n.check === 'limits'));
});

test('already aborted signal: nothing read, global timeout declared', async (t) => {
  const dir = await fixture(t, { 'package.json': '{}' });
  const ac = new AbortController();
  ac.abort();
  const acq = await acquireLocal(dir, ctxWith({}, ac.signal));
  assert.equal(acq.files.size, 0);
  assert.ok(acq.notVerified.some((n) => /global timeout reached/.test(n.reason)));
});

test('options.limits given to analyze are applied by the local walk', async (t) => {
  const dir = await fixture(t, { 'package.json': '{"name":"x"}', '.npmrc': 'a=b' });
  const report = await analyze(dir, { offline: true, limits: { maxFiles: 1 } }, offlineDeps(t, deps()));
  assert.ok(report.limits.reached.includes('maxFiles'));
  assert.equal(report.limits.maxFiles, 1);
  assert.ok(report.notVerified.some((n) => n.check === 'limits'));
});

test('global timeout is also recorded in limits.reached (local walk)', async (t) => {
  const dir = await fixture(t, { 'package.json': '{}' });
  const ac = new AbortController();
  ac.abort();
  const ctx = ctxWith({}, ac.signal);
  await acquireLocal(dir, ctx);
  assert.ok(ctx.limits.snapshot().reached.includes('globalTimeoutMs'));
});

test('markReached records a limit once', () => {
  const l = createLimits({});
  l.markReached('globalTimeoutMs');
  l.markReached('globalTimeoutMs');
  assert.deepEqual(l.snapshot().reached, ['globalTimeoutMs']);
});
