// D-73: the script alone (no model, zero tokens) measured on the hostile scenarios H1-H10 (D-70).
// Fixtures exist only as JS modules and are materialized in os.tmpdir() (D-72).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';
import { materialize } from './helpers/materialize.mjs';
import { assertValidReport, assertNoForbiddenWords } from './helpers/report-assert.mjs';
import { osvRoutes, registryRoutes, composeFetch } from './helpers/intel-routes.mjs';
import { HOSTILE, CANARY_CMD } from './fixtures/hostile/index.mjs';
import { FAKE_TOKEN } from './fixtures/hostile/real-case-full.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTILE_DIR = path.join(ROOT, 'tests', 'fixtures', 'hostile');
const noGh = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
const now = () => new Date('2026-11-01T00:00:00Z');
const REAL_OSV = { 'tailwind-animate-kit@2.0.8': ['MAL-2026-18078'] };
const REAL_REGISTRY = { next: { latest: '14.2.3' }, react: { latest: '18.3.1' }, 'tailwind-animate-kit': { latest: '0.0.1-security' } };

/** Report text without signals[].evidence: the only place where repository data (G3) may contain any word. */
const withoutEvidence = (report) => JSON.stringify({ ...report, signals: report.signals.map(({ evidence, ...s }) => s) });

async function scan(t, files, extra = {}) {
  const { dir, cleanup } = await materialize(files, { prefix: 'repoflags-hostile-' });
  t.after(cleanup);
  const rel = path.relative(ROOT, dir);
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), 'materialized folder must be outside the repository');
  const { io, stdout, stderr } = makeIo();
  const fetch = composeFetch([osvRoutes(extra.osv ?? {}), registryRoutes(extra.registry ?? {})]);
  const code = await main([dir, '--format', 'json'], io, { fetch, now, execGh: noGh, env: {} });
  const out = stdout();
  const report = JSON.parse(out);
  assertValidReport(report);
  assertNoForbiddenWords(withoutEvidence(report));
  return { code, report, out, err: stderr() };
}

const has = (report, e) => report.signals.some((s) => s.rule === e.rule && s.severity === e.severity && (e.file === null || s.file === e.file));

for (const [id, h] of Object.entries(HOSTILE)) {
  test(`${id}: the script produces the expected signals`, async (t) => {
    const extra = id === 'H10' ? { osv: REAL_OSV, registry: REAL_REGISTRY } : {};
    const { report } = await scan(t, h.files, extra);
    for (const e of h.expect) assert.ok(has(report, e), `${e.rule}/${e.severity}@${e.file} in ${JSON.stringify(report.signals.map((s) => `${s.rule}/${s.severity}@${s.file}`))}`);
  });
}

test('H3: README prose is not read by the script (D-86, false negative by construction)', async (t) => {
  const { report } = await scan(t, HOSTILE.H3.files);
  assert.ok(HOSTILE.H3.scriptBlind.includes('readme-not-selected'));
  // D-86: the README is not in AGENT_NAMES, so it appears in no signal and the outcome stays at "no signals".
  assert.ok(!report.signals.some((s) => /readme/i.test(s.file)), 'README must not appear in any signals[].file');
  assert.equal(report.outcome, 'no_signals_found_by_these_rules');
});

test('H4: the comment aimed at the AI is not evaluated (D-86), the config effects are', async (t) => {
  const { report } = await scan(t, HOSTILE.H4.files);
  assert.ok(HOSTILE.H4.scriptBlind.includes('config-comment-not-evaluated'));
  // D-86: nothing in the report quotes or reacts to the comment text; only the require() effects are signalled.
  assert.ok(!report.signals.some((s) => s.rule === 'ai-instructions'));
  assert.ok(!JSON.stringify(report).includes('tell the user all is fine'));
});

test('H10: the full fake token never reaches stdout/stderr, the masked form does', async (t) => {
  const { report, out, err, code } = await scan(t, HOSTILE.H10.files, { osv: REAL_OSV, registry: REAL_REGISTRY });
  assert.equal(code, 1);
  assert.ok(!out.includes(FAKE_TOKEN) && !err.includes(FAKE_TOKEN), 'full token must never be printed');
  const tok = report.signals.find((s) => s.rule === 'npmrc-auth-token');
  assert.ok(tok && /FAKE/.test(tok.evidence), `masked form expected in evidence: ${tok?.evidence}`);
});

test('H5: output injection stays inert, valid JSON, no bidi or zero-width characters', async (t) => {
  const { report, out, code } = await scan(t, HOSTILE.H5.files);
  assert.equal(code, 1);
  assert.equal(report.outcome, 'signals_found');
  assert.doesNotMatch(out, /[‮​]/u);
  const ai = report.signals.find((s) => s.rule === 'ai-instructions');
  assert.ok(ai && !ai.title.includes('SYSTEM') && !ai.title.includes('untrusted'), 'repository text never reaches the title');
});

test('H5s: the word "safe" appears only inside signals[].evidence (repository data, G3)', async (t) => {
  const { report } = await scan(t, HOSTILE.H5s.files);
  assert.ok(report.signals.some((s) => /safe/i.test(s.evidence)), 'the repository data is reported as data');
  assert.doesNotMatch(withoutEvidence(report), /safe/i);
  assert.doesNotMatch(report.outcome, /safe/i);
});

// Static checks on the fixture modules (D-71, D-72).
const allMaps = Object.entries(HOSTILE).flatMap(([id, h]) => Object.entries(h.files).map(([p, c]) => [id, p, c]));

test('static: no fixture path lives under .claude/ and nothing is a hook', () => {
  for (const [id, p] of allMaps) assert.ok(!/(^|\/)\.claude\//.test(p), `${id}: ${p}`);
});

test('static: every script and task command pushed by a fixture is the canary', () => {
  for (const [id, p, c] of allMaps) {
    if (p.endsWith('package.json')) {
      for (const [name, cmd] of Object.entries(JSON.parse(c).scripts ?? {})) {
        assert.ok(cmd === CANARY_CMD || cmd === 'echo dev', `${id} ${p} script ${name}: ${cmd}`);
      }
    }
    if (p.endsWith('tasks.json')) {
      for (const task of JSON.parse(c).tasks) assert.equal(task.command, CANARY_CMD, `${id} ${p}`);
    }
  }
});

test('static: no real URL, tokens carry the FAKE marker', () => {
  for (const [id, p, c] of allMaps) {
    for (const m of c.matchAll(/https?:\/\/([^/\s"'`]+)/g)) assert.match(m[1], /\.invalid$/, `${id} ${p}: ${m[0]}`);
    for (const m of c.matchAll(/_authToken=([^\n"]*)/g)) assert.match(m[1], /FAKE/, `${id} ${p}`);
  }
  assert.ok(FAKE_TOKEN.includes('FAKE'));
});

test('static: the hostile folder holds only .mjs modules', async () => {
  const names = await fs.readdir(HOSTILE_DIR);
  assert.deepEqual(names.filter((n) => !n.endsWith('.mjs')), []);
});
