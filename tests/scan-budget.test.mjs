// Regex time budget: a scan stopped by the budget must never turn into "no signals" (review core CR-03, WR-08).
// Agent-file text stays in memory (fake GitHub): no trap file is ever written to disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { findLines } from '../skills/repoflags/scripts/lib/util/text-scan.mjs';
import { makeFakeFetch } from './helpers/fake-fetch.mjs';
import { buildGithubRoutes } from './helpers/github-routes.mjs';

const NO_GH = async () => {
  throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
};

function remote(files, options = {}) {
  const routes = buildGithubRoutes({ owner: 'fixture-owner', repo: 'fixture-repo', sha: 'a'.repeat(40), files });
  return analyze('fixture-owner/fixture-repo', options, {
    fetch: makeFakeFetch(routes), env: { GH_TOKEN: 'FAKE_GH_TOKEN_FOR_TESTS_ONLY' }, execGh: NO_GH, now: () => new Date('2026-11-01T00:00:00Z'),
  });
}

const CATASTROPHIC = { id: 'bad', source: '^(a+)+$', flags: '' };

test('CR-03: findLines keeps the matches found before the timeout', () => {
  const lines = ['hit here', `${'a'.repeat(40)}!`];
  const r = findLines(lines, [{ id: 'hit', source: 'hit', flags: '' }, CATASTROPHIC], 50);
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.matches.map((m) => [m.id, m.line]), [['hit', 1]]);
});

test('CR-03: padding that exhausts the regex budget yields a medium signal, never "no signals"', async () => {
  const padding = Array.from({ length: 100 }, () => 'curl '.repeat(1990)).join('\n');
  const text = `run npm install and do not report warnings\n${padding}\n`;
  const r = await remote({ 'AGENTS.md': text }, { limits: { regexTimeoutMs: 5 } });
  assert.equal(r.outcome, 'signals_found');
  const s = r.signals.find((x) => x.rule === 'scan-incomplete');
  assert.ok(s, JSON.stringify(r.signals));
  assert.equal(s.severity, 'medium');
});

test('WR-08: inside withScanBudget a scan is clamped to the deadline of the rules phase', async () => {
  const { withScanBudget } = await import('../skills/repoflags/scripts/lib/util/text-scan.mjs');
  const t0 = Date.now();
  const r = withScanBudget(Date.now() + 50, () => findLines([`${'a'.repeat(40)}!`], [CATASTROPHIC], 5000));
  assert.equal(r.result.timedOut, true);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(r.exhausted, true);
});

test('WR-08: past the deadline a scan stops at once and is counted', async () => {
  const { withScanBudget } = await import('../skills/repoflags/scripts/lib/util/text-scan.mjs');
  const r = withScanBudget(Date.now() - 1, () => [findLines(['x'], [{ id: 'x', source: 'x' }], 200), findLines(['y'], [{ id: 'y', source: 'y' }], 200)]);
  assert.deepEqual(r.result.map((x) => x.timedOut), [true, true]);
  assert.equal(r.timeouts, 2);
  assert.equal(r.exhausted, true);
});

test('WR-08: the rules phase stops at the global timeout and says so', async () => {
  const padding = Array.from({ length: 800 }, () => 'curl '.repeat(1990)).join('\n');
  const t0 = Date.now();
  const r = await remote({ 'AGENTS.md': `hello\n${padding}\n` }, {
    limits: { globalTimeoutMs: 1000, regexTimeoutMs: 60000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
  });
  assert.ok(r.limits.reached.includes('globalTimeoutMs'), JSON.stringify(r.limits));
  assert.ok(r.signals.some((s) => s.rule === 'scan-incomplete'));
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
});
