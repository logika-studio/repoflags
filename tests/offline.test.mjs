import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { assertValidReport, assertNoForbiddenWords } from './helpers/report-assert.mjs';
import { files as realCase } from './fixtures/real-case.mjs';

const noGh = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
const now = () => new Date('2026-11-01T00:00:00Z');

async function localReal(t) {
  const { dir, cleanup } = await materialize(realCase);
  t.after(cleanup);
  return dir;
}

test('--offline on a local folder: no fetch call, skipped checks declared, static signals present', async (t) => {
  const fetch = makeForbiddenFetch();
  const { io, stdout } = makeIo();
  const code = await main([await localReal(t), '--offline', '--format', 'json'], io, { fetch, now, execGh: noGh, env: {} });
  const out = stdout();
  const report = JSON.parse(out);
  assertValidReport(report);
  assertNoForbiddenWords(out);
  assert.equal(code, 1);
  assert.equal(fetch.log.length, 0);
  assert.equal(report.mode, 'offline');
  for (const check of ['osv', 'npm-registry', 'repo-metadata']) {
    assert.ok(report.notVerified.some((n) => n.check === check && n.reason === 'skipped: offline mode'), check);
  }
  for (const rule of ['npmrc-auth-token', 'config-require-nonstandard', 'chain-private-dependency']) {
    assert.ok(report.signals.some((s) => s.rule === rule), rule);
  }
  assert.deepEqual(report.network.hosts, {});
});

test('--offline with a remote target exits 2 and explains why', async () => {
  const fetch = makeForbiddenFetch();
  const { io, stdout, stderr } = makeIo();
  const code = await main(['fixture-owner/fixture-repo', '--offline'], io, { fetch, now, execGh: noGh, env: {} });
  assert.equal(code, 2);
  assert.equal(fetch.log.length, 0);
  assert.match(stdout() + stderr(), /remote target cannot be analyzed with --offline/);
});

test('network down on a local folder: still exit 1, no exception, failed checks declared', async (t) => {
  const fetch = makeForbiddenFetch();
  const { io, stdout } = makeIo();
  const code = await main([await localReal(t), '--format', 'json'], io, { fetch, now, execGh: noGh, env: {} });
  const report = JSON.parse(stdout());
  assertValidReport(report);
  assert.equal(code, 1);
  assert.equal(report.mode, 'online');
  assert.ok(report.notVerified.some((n) => n.check === 'osv'));
  assert.ok(report.notVerified.some((n) => n.check === 'npm-registry'));
  assert.ok(report.signals.some((s) => s.rule === 'chain-private-dependency'), 'registry not performed -> chain by discretion rule');
});
