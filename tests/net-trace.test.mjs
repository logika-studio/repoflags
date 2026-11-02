// 03-02 Task 1 (D-81): the socket-level G6 trace preload must be proven non-vacuous. A child runs a probe against a local
// http server; the preload has to see fetch and http.get, dns lookups and child processes, and never headers or env.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readNetLog, hostsOf, assertHostsAllowed, execCalls } from './helpers/net-trace.mjs';
import { ALLOWED_HOSTS } from '../skills/repoflags/scripts/lib/constants.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'helpers', 'net-trace-preload.mjs');

const PROBE = `
import http from 'node:http';
import dns from 'node:dns';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const base = process.env.PROBE_URL;
await fetch(base + '/f?secret=QUERYVALUE', { headers: { 'x-probe': 'HEADERVALUE' } }).then((r) => r.text());
await new Promise((res, rej) => http.get(base + '/g', (r) => { r.resume(); r.on('end', res); }).on('error', rej));
await new Promise((res) => dns.lookup('localhost', () => res()));
await dns.promises.lookup('localhost');
await new Promise((res) => execFile(process.execPath, ['-e', '0'], () => res()));
await new Promise((res) => spawn(process.execPath, ['-e', '0']).on('close', res));
execFileSync(process.execPath, ['-e', '0']);
const pr = await promisify(execFile)(process.execPath, ['-e', '0']);
if (!pr || typeof pr !== 'object' || !('stdout' in pr)) process.exit(3);
`;

async function runProbe({ netlog }) {
  const server = http.createServer((_q, s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-nettrace-'));
  const probe = path.join(dir, 'probe.mjs');
  await fsp.writeFile(probe, PROBE);
  const env = { ...process.env, PROBE_URL: `http://127.0.0.1:${server.address().port}`, SECRET_ENV_VALUE: 'ENVVALUE123' };
  delete env.NODE_TEST_CONTEXT;
  delete env.REPOFLAGS_NETLOG;
  const log = path.join(dir, 'net.jsonl');
  if (netlog) env.REPOFLAGS_NETLOG = log;
  const code = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, probe], { env, shell: false, stdio: 'ignore' });
    c.on('error', reject);
    c.on('close', resolve);
  });
  server.close();
  const events = fs.existsSync(log) ? readNetLog(log) : null;
  const raw = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  await fsp.rm(dir, { recursive: true, force: true });
  return { code, events, raw, port: Number(env.PROBE_URL.split(':').pop()) };
}

test('preload sees fetch and http.get connections to the local server (non vacuous)', async () => {
  const { code, events, port } = await runProbe({ netlog: true });
  assert.equal(code, 0);
  const connects = events.filter((e) => e.t === 'connect' && e.host === '127.0.0.1' && e.port === port);
  assert.ok(connects.length >= 2, `expected a connect for fetch and one for http.get, got ${connects.length}`);
  assert.ok(events.some((e) => e.t === 'undici' && e.host === '127.0.0.1'), 'fetch seen on the undici channel');
});

test('promisify(execFile) still resolves to {stdout, stderr} under the preload (03-06: token.mjs saw no stdout)', async () => {
  const { code } = await runProbe({ netlog: true });
  assert.notEqual(code, 3, 'the execFile wrapper lost util.promisify.custom: promisify resolves to a string');
  assert.equal(code, 0);
});

test('preload sees dns.lookup and dns.promises.lookup', async () => {
  const { events } = await runProbe({ netlog: true });
  assert.ok(events.filter((e) => e.t === 'lookup' && e.host === 'localhost').length >= 2);
});

test('preload records child processes with file and args, never env', async () => {
  const { events, raw } = await runProbe({ netlog: true });
  const calls = execCalls(events);
  assert.ok(calls.length >= 4, `execFile, spawn, execFileSync and promisify(execFile) expected, got ${calls.length}`);
  assert.ok(calls.every((c) => c.file === process.execPath && Array.isArray(c.args) && c.args.join(' ') === '-e 0'));
  assert.doesNotMatch(raw, /ENVVALUE123|SECRET_ENV_VALUE/);
});

test('preload writes nothing without REPOFLAGS_NETLOG', async () => {
  const { code, events } = await runProbe({ netlog: false });
  assert.equal(code, 0);
  assert.equal(events, null);
});

test('events carry no header, query string or Authorization', async () => {
  const { raw } = await runProbe({ netlog: true });
  assert.ok(raw.length > 0);
  assert.doesNotMatch(raw, /HEADERVALUE|QUERYVALUE|x-probe|authorization|secret=/i);
});

test('assertHostsAllowed passes on allowed hosts and throws on 127.0.0.1 and example.invalid', () => {
  const ok = [{ t: 'connect', host: 'api.github.com', port: 443 }, { t: 'lookup', host: 'api.osv.dev' }, { t: 'undici', host: 'registry.npmjs.org' }];
  assert.deepEqual([...hostsOf(ok)].sort(), ['api.github.com', 'api.osv.dev', 'registry.npmjs.org']);
  assert.doesNotThrow(() => assertHostsAllowed(ok, ALLOWED_HOSTS));
  assert.throws(() => assertHostsAllowed([{ t: 'connect', host: '127.0.0.1', port: 80 }], ALLOWED_HOSTS), /127\.0\.0\.1/);
  assert.throws(() => assertHostsAllowed([{ t: 'lookup', host: 'example.invalid' }], ALLOWED_HOSTS), /example\.invalid/);
});

// Review WR-09: a connection the trace cannot attribute to a host is a violation, never counted as allowed.
test('03-review WR-09: a connect event without a host is outside the allowlist', () => {
  for (const ev of [{ t: 'connect', host: null, port: 443 }, { t: 'connect', host: '', port: null }]) {
    assert.ok(hostsOf([ev]).size > 0, JSON.stringify(ev));
    assert.throws(() => assertHostsAllowed([ev], ALLOWED_HOSTS), /unknown/);
  }
});

test('hostsOf strips a port and ignores exec events', () => {
  const ev = [{ t: 'connect', host: 'api.osv.dev:443', port: 443 }, { t: 'exec', file: 'gh', args: ['auth', 'token'] }];
  assert.deepEqual([...hostsOf(ev)], ['api.osv.dev']);
  assert.deepEqual(execCalls(ev), [{ t: 'exec', file: 'gh', args: ['auth', 'token'] }]);
});

test('a preload that records nothing would fail the non-vacuity assertion (self-check)', () => {
  const events = [];
  assert.equal(events.filter((e) => e.t === 'connect' && e.host === '127.0.0.1').length >= 2, false);
});
