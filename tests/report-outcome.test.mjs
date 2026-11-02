import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../skills/repoflags/scripts/lib/report/build.mjs';
import { renderText } from '../skills/repoflags/scripts/lib/report/text.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';
import { DISCLAIMER } from '../skills/repoflags/scripts/lib/constants.mjs';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { makeIo } from './helpers/io.mjs';
import { assertValidReport, assertNoForbiddenWords } from './helpers/report-assert.mjs';
import { files } from './fixtures/real-case.mjs';

const ANSI = /\u001b\[/;
const FIXED = ['private-packages', 'runtime-downloads', 'other-commits', 'binary-files', 'node-modules'];

function sig(severity, extra = {}) {
  return { rule: 'r', severity, title: 't', file: 'a.js', line: 1, evidence: 'e', refs: [], ...extra };
}

function build(signals, notVerified = [], hosts = {}) {
  return buildReport({
    acquired: { target: { type: 'local', name: 'dir' } },
    signals,
    notVerified,
    ctx: { now: () => new Date('2026-11-01T00:00:00Z'), mode: 'offline', limits: createLimits({}), network: { hosts } },
  });
}

test('outcome: only info or no signals -> no_signals_found_by_these_rules', () => {
  for (const signals of [[], [sig('info')]]) {
    const r = build(signals);
    assert.equal(r.outcome, 'no_signals_found_by_these_rules');
    assert.match(renderText(r), /^Outcome: no signals found by these rules$/m);
    assertValidReport(r);
  }
});

test('outcome: a medium signal -> signals_found', () => {
  const r = build([sig('medium')]);
  assert.equal(r.outcome, 'signals_found');
  assert.match(renderText(r), /^Outcome: signals found$/m);
  assertValidReport(r);
});

test('notVerified always has the five fixed entries, deduplicated', () => {
  const r = build([], [{ check: 'x', reason: 'y' }, { check: 'x', reason: 'y' }]);
  const checks = r.notVerified.map((n) => n.check);
  for (const c of FIXED) assert.equal(checks.filter((k) => k === c).length, 1, c);
  assert.equal(checks.filter((k) => k === 'x').length, 1);
  assert.deepEqual(build([]).notVerified.map((n) => n.check), FIXED);
});

test('no output contains safe/unsafe', () => {
  const r = build([sig('high'), sig('info')]);
  assertNoForbiddenWords(JSON.stringify(r));
  assertNoForbiddenWords(renderText(r));
  assertNoForbiddenWords(renderText(r, { color: true }));
});

test('text: colors only when requested; disclaimer is the second line', () => {
  const r = build([sig('high'), sig('medium'), sig('info')]);
  const plain = renderText(r, { color: false });
  assert.doesNotMatch(plain, ANSI);
  const colored = renderText(r, { color: true });
  assert.match(colored, /\u001b\[31mHIGH/);
  assert.match(colored, /\u001b\[33mMEDIUM/);
  assert.equal(plain.split('\n')[1], DISCLAIMER);
});

test('text: limits reached and network lines', () => {
  const none = renderText(build([]));
  assert.doesNotMatch(none, /limits reached:/);
  const r = build([]);
  r.limits.reached = ['maxFiles'];
  r.network.hosts = { 'api.osv.dev': 2 };
  const text = renderText(r);
  assert.match(text, /^limits reached: maxFiles$/m);
  assert.match(text, /^network: api\.osv\.dev=2$/m);
});

test('refs are limited to known https prefixes', () => {
  const r = build([sig('info', { refs: ['https://osv.dev/x', 'https://evil.example/x', 'javascript:1', 'https://github.com/a', 'https://www.npmjs.com/p'] })]);
  assert.deepEqual(r.signals[0].refs, ['https://osv.dev/x', 'https://github.com/a', 'https://www.npmjs.com/p']);
});

async function cli(t, argv, io, env) {
  const c = makeIo();
  c.io.isTTY = io.isTTY;
  const code = await main(argv, c.io, offlineDeps(t, { env, now: () => new Date('2026-11-01T00:00:00Z') }));
  return { code, out: c.stdout() };
}

test('CLI color: TTY colors, NO_COLOR and non-TTY do not, json is pure', async (t) => {
  const { dir, cleanup } = await materialize(files);
  t.after(cleanup);
  const tty = await cli(t, [dir, '--offline'], { isTTY: true }, {});
  assert.match(tty.out, ANSI);
  const noColor = await cli(t, [dir, '--offline'], { isTTY: true }, { NO_COLOR: '1' });
  assert.doesNotMatch(noColor.out, ANSI);
  const pipe = await cli(t, [dir, '--offline'], { isTTY: false }, {});
  assert.doesNotMatch(pipe.out, ANSI);
  const json = await cli(t, [dir, '--offline', '--format', 'json'], { isTTY: true }, {});
  assertValidReport(JSON.parse(json.out));
});
