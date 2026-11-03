import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { DEFAULT_LIMITS } from '../skills/repoflags/scripts/lib/constants.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { makeIo } from './helpers/io.mjs';

const deps = () => ({ fetch: makeForbiddenFetch(), now: () => new Date('2026-11-01T00:00:00Z'), env: {} });
async function run(argv) {
  const c = makeIo();
  const code = await main(argv, c.io, deps());
  return { code, out: c.stdout(), err: c.stderr() };
}
const KEYS = ['maxFileBytes', 'maxLockfileBytes', 'maxFiles', 'maxTotalBytes', 'requestTimeoutMs', 'globalTimeoutMs', 'maxLineLength'];

test('limit flags reach report.limits (seconds converted to ms)', async (t) => {
  const { dir, cleanup } = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(cleanup);
  const r = await run([dir, '--offline', '--format', 'json', '--max-file-bytes', '1234', '--max-lockfile-bytes', '5678',
    '--max-files', '7', '--max-total-bytes', '9999', '--timeout', '30', '--request-timeout', '5']);
  assert.equal(r.code, 0);
  const l = JSON.parse(r.out).limits;
  assert.equal(l.maxFileBytes, 1234);
  assert.equal(l.maxLockfileBytes, 5678);
  assert.equal(l.maxFiles, 7);
  assert.equal(l.maxTotalBytes, 9999);
  assert.equal(l.globalTimeoutMs, 30000);
  assert.equal(l.requestTimeoutMs, 5000);
});

test('without flags limits equal DEFAULT_LIMITS', async (t) => {
  const { dir, cleanup } = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(cleanup);
  const l = JSON.parse((await run([dir, '--offline', '--format', 'json'])).out).limits;
  for (const k of KEYS) assert.equal(l[k], DEFAULT_LIMITS[k], k);
  assert.deepEqual(l.reached, []);
});

test('invalid limit values give exit 2 with usage and no stack', async (t) => {
  const { dir, cleanup } = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(cleanup);
  for (const bad of [['--max-files', 'abc'], ['--max-files', '0'], ['--max-files', '-3'], ['--timeout', '1.5x']]) {
    const r = await run([dir, '--offline', ...bad]);
    assert.equal(r.code, 2, bad.join(' '));
    assert.match(r.err, /Usage:/);
    assert.doesNotMatch(r.err, /\n\s+at /);
  }
});

test('unknown flag and missing target give exit 2', async () => {
  assert.equal((await run(['--nope'])).code, 2);
  assert.equal((await run([])).code, 2);
});

test('a limit flag really restricts acquisition', async (t) => {
  // package.json ({} = 2 bytes) stays under the limit: with nothing read at all the analysis is an error (CR-04).
  const { dir, cleanup } = await materialize({ 'web/.npmrc': '//registry.npmjs.org/:_authToken=FAKE_TOKEN_FOR_TESTS_ONLY_0001\n', 'package.json': '{}' });
  t.after(cleanup);
  const r = await run([dir, '--offline', '--format', 'json', '--max-file-bytes', '10']);
  const report = JSON.parse(r.out);
  assert.ok(report.limits.reached.includes('maxFileBytes'));
  assert.ok(!report.signals.some((s) => s.rule === 'npmrc-auth-token'));
});

test('WR-03: a timeout above the Node timer range is refused (exit 2), never silently set to 1 ms', async (t) => {
  const { dir, cleanup } = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(cleanup);
  for (const flag of ['--timeout', '--request-timeout']) {
    const r = await run([dir, '--offline', flag, '3000000']);
    assert.equal(r.code, 2, `${flag}: ${r.out}`);
    assert.match(r.err, new RegExp(`${flag} `));
  }
});

test('WR-03: createLimits keeps every millisecond value inside the Node timer range', async () => {
  const { createLimits } = await import('../skills/repoflags/scripts/lib/acquire/limits.mjs');
  const v = createLimits({ globalTimeoutMs: 3e9, requestTimeoutMs: 3e9, regexTimeoutMs: 3e9 }).values;
  for (const k of ['globalTimeoutMs', 'requestTimeoutMs', 'regexTimeoutMs']) assert.equal(v[k], 2147483647, k);
});

test('WR-04: no parseArgs option relies on `default` (added in Node 18.11; engines was >=18.3, now >=18.20)', async () => {
  const { OPTIONS } = await import('../skills/repoflags/scripts/repoflags.mjs');
  assert.ok(OPTIONS && typeof OPTIONS === 'object', 'OPTIONS must be exported for this check');
  for (const [name, spec] of Object.entries(OPTIONS)) assert.ok(!Object.hasOwn(spec, 'default'), name);
});
