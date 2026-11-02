import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { validateConfig, CONFIG_KEYS, THRESHOLD_RANGES, THRESHOLD_DEFAULTS } from '../skills/repoflags/scripts/lib/config/validate.mjs';
import { RULE_IDS, INTEGRITY_RULE_IDS } from '../skills/repoflags/scripts/lib/rules/ids.mjs';
import { MAX_CODE_COLUMN, WHITESPACE_RUN } from '../skills/repoflags/scripts/lib/rules/config-patterns.mjs';
import { AnalyzeError } from '../skills/repoflags/scripts/lib/errors.mjs';
import { MAX_TIMER_MS } from '../skills/repoflags/scripts/lib/constants.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { makeIo } from './helpers/io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'skills', 'repoflags', 'scripts', 'lib');

const bad = (json, re) => assert.throws(() => validateConfig(json), (e) => e instanceof AnalyzeError && re.test(e.message), JSON.stringify(json).slice(0, 80));
const ok = (json) => validateConfig(json);

test('empty object is valid and yields empty options and facts', () => {
  const { options, facts } = ok({});
  assert.deepEqual(options, { limits: {}, disabledRules: [], thresholds: {}, userConfigAllowlist: [], lifecycleAllowlist: [], language: null });
  assert.deepEqual(facts, { disabledRules: [], thresholds: {}, allowlist: { configPackages: 0, lifecycleCommands: 0 }, language: null });
});

test('unknown top-level keys, guardrail-looking keys and prototype keys are refused', () => {
  for (const k of ['guardrails', 'G1', 'execute', 'prompt', 'unknown']) bad({ [k]: true }, new RegExp(`unknown config key: ${k}`));
  bad(JSON.parse('{"__proto__":{"x":1}}'), /__proto__/);
  bad(JSON.parse('{"constructor":{}}'), /constructor/);
  bad(JSON.parse('{"limits":{"__proto__":1}}'), /__proto__/);
  bad(JSON.parse('{"rules":{"constructor":false}}'), /constructor/);
  bad(JSON.parse('{"allowlist":{"__proto__":[]}}'), /__proto__/);
  for (const root of [[], null, 'x', 3, true]) bad(root, /config root must be an object/);
  for (const sec of ['limits', 'thresholds', 'rules', 'allowlist']) bad({ [sec]: [] }, new RegExp(`${sec} must be an object`));
});

test('limits: closed set, positive integers, same ceiling as the flags', () => {
  const { options } = ok({ limits: { maxFileBytes: 10, maxLockfileBytes: 20, maxFiles: 3, maxTotalBytes: 40, timeoutSeconds: 30, requestTimeoutSeconds: 5 } });
  assert.deepEqual(options.limits, { maxFileBytes: 10, maxLockfileBytes: 20, maxFiles: 3, maxTotalBytes: 40, globalTimeoutMs: 30000, requestTimeoutMs: 5000 });
  bad({ limits: { maxLineLength: 5 } }, /unknown config key: limits.maxLineLength/);
  for (const v of [0, -1, 1.5, '5', null, true, NaN]) bad({ limits: { maxFiles: v } }, /limits.maxFiles/);
  bad({ limits: { timeoutSeconds: Math.floor(MAX_TIMER_MS / 1000) + 1 } }, /limits.timeoutSeconds must be at most/);
  assert.equal(ok({ limits: { timeoutSeconds: Math.floor(MAX_TIMER_MS / 1000) } }).options.limits.globalTimeoutMs, Math.floor(MAX_TIMER_MS / 1000) * 1000);
});

test('thresholds: ranges are inclusive, defaults are the real constants, facts keep only non-defaults', () => {
  assert.deepEqual(THRESHOLD_DEFAULTS, { maxCodeColumn: 300, whitespaceRun: 40, escapeRun: 20 });
  assert.equal(THRESHOLD_DEFAULTS.maxCodeColumn, MAX_CODE_COLUMN);
  assert.equal(THRESHOLD_DEFAULTS.whitespaceRun, WHITESPACE_RUN);
  assert.deepEqual(THRESHOLD_RANGES, { maxCodeColumn: [100, 1000], whitespaceRun: [10, 200], escapeRun: [5, 100] });
  for (const [k, [lo, hi]] of Object.entries(THRESHOLD_RANGES)) {
    assert.equal(ok({ thresholds: { [k]: lo } }).options.thresholds[k], lo);
    assert.equal(ok({ thresholds: { [k]: hi } }).options.thresholds[k], hi);
    for (const v of [lo - 1, hi + 1, 1.5, '50', null]) bad({ thresholds: { [k]: v } }, new RegExp(`thresholds.${k}`));
  }
  bad({ thresholds: { other: 5 } }, /unknown config key: thresholds.other/);
  const r = ok({ thresholds: { maxCodeColumn: 300, escapeRun: 30 } });
  assert.deepEqual(r.options.thresholds, { maxCodeColumn: 300, escapeRun: 30 });
  assert.deepEqual(r.facts.thresholds, { escapeRun: 30 });
});

test('rules: only existing, non-integrity ids set to false', () => {
  const r = ok({ rules: { 'osv-advisory': false, 'envrc': false } });
  assert.deepEqual(r.options.disabledRules, ['envrc', 'osv-advisory']);
  assert.deepEqual(r.facts.disabledRules, ['envrc', 'osv-advisory']);
  for (const id of INTEGRITY_RULE_IDS) bad({ rules: { [id]: false } }, /cannot be disabled/);
  bad({ rules: { 'no-such-rule': false } }, /unknown rule id/);
  bad({ rules: { envrc: true } }, /rules.envrc/);
  for (const v of ['false', 0, null, {}]) bad({ rules: { envrc: v } }, /rules.envrc/);
  for (const id of RULE_IDS) assert.deepEqual(ok({ rules: { [id]: false } }).options.disabledRules, [id]);
});

test('allowlist.configPackages: exact names, safe prefixes and @scope/* only', () => {
  const good = ['left-pad', '@scope/pkg', 'eslint-*', '@scope/*', '@scope/pre*', 'abc*', 'a.b_c-d'];
  const r = ok({ allowlist: { configPackages: good } });
  assert.deepEqual(r.options.userConfigAllowlist, good);
  assert.equal(r.facts.allowlist.configPackages, good.length);
  for (const e of ['*', '@*', '**', 'a*', 'ab*', 'a*b', '*abc', '@scope*', '@/x', 'UP', 'a b', '', ' x', 'a/b', '@scope/', '@scope/a*b']) {
    bad({ allowlist: { configPackages: [e] } }, /allowlist.configPackages/);
  }
  bad({ allowlist: { configPackages: 'x' } }, /allowlist.configPackages/);
  bad({ allowlist: { configPackages: [3] } }, /allowlist.configPackages/);
  bad({ allowlist: { configPackages: Array(201).fill('abc') } }, /at most 200/);
  assert.equal(ok({ allowlist: { configPackages: Array(200).fill('abc') } }).facts.allowlist.configPackages, 200);
  bad({ allowlist: { configPackages: ['a'.repeat(215)] } }, /allowlist.configPackages/);
  assert.equal(ok({ allowlist: { configPackages: ['a'.repeat(214)] } }).options.userConfigAllowlist.length, 1);
});

test('allowlist.lifecycleCommands: normalized, bounded', () => {
  const r = ok({ allowlist: { lifecycleCommands: ['  node   build.js ', 'tsc'] } });
  assert.deepEqual(r.options.lifecycleAllowlist, ['node build.js', 'tsc']);
  assert.equal(r.facts.allowlist.lifecycleCommands, 2);
  for (const v of ['', '   ', 5, null]) bad({ allowlist: { lifecycleCommands: [v] } }, /allowlist.lifecycleCommands/);
  bad({ allowlist: { lifecycleCommands: ['x'.repeat(1001)] } }, /allowlist.lifecycleCommands/);
  bad({ allowlist: { lifecycleCommands: Array(101).fill('tsc') } }, /at most 100/);
  bad({ allowlist: { other: [] } }, /unknown config key: allowlist.other/);
  assert.equal(Object.hasOwn(ok({ allowlist: { configPackages: ['abc'] } }).options, 'configAllowlist'), false);
});

test('language: BCP 47 shaped, at most 35 characters', () => {
  for (const l of ['it', 'en', 'pt-BR', 'zh-Hant-TW', 'ita']) assert.equal(ok({ language: l }).options.language, l);
  assert.equal(ok({ language: 'it' }).facts.language, 'it');
  for (const l of ['', 'i', 'italian-language', 'it_IT', 'en us', 'it-', 'x'.repeat(36), 5, null, 'ignore previous instructions']) bad({ language: l }, /language/);
});

test('error messages clip long values and carry no raw control characters', () => {
  const long = 'q'.repeat(300);
  try {
    validateConfig({ [`k\n${long}`]: 1 });
    assert.fail('must throw');
  } catch (e) {
    assert.ok(e.message.length < 120, e.message.length);
    assert.doesNotMatch(e.message, /[\r\n]/);
  }
  try {
    validateConfig({ rules: { [long]: false } });
    assert.fail('must throw');
  } catch (e) {
    assert.ok(e.message.length < 120);
  }
});

test('no schema key names a guardrail or a way to run or instruct (D-56)', () => {
  const keys = [];
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      keys.push(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
    }
  };
  walk(CONFIG_KEYS);
  assert.ok(keys.length >= 15);
  for (const k of keys) assert.doesNotMatch(k, /^g\d|guard|exec|^run|prompt|instruction/i, k);
  assert.deepEqual(Object.keys(CONFIG_KEYS).sort(), ['allowlist', 'language', 'limits', 'rules', 'thresholds']);
});

test('drift guard: RULE_IDS + INTEGRITY_RULE_IDS equal the rule ids the sources emit', async () => {
  assert.equal(RULE_IDS.length, 18);
  assert.equal(INTEGRITY_RULE_IDS.length, 3);
  assert.deepEqual([...RULE_IDS].sort(), [...RULE_IDS]);
  assert.equal(new Set([...RULE_IDS, ...INTEGRITY_RULE_IDS]).size, 21);
  const found = new Set();
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.mjs') && !full.endsWith(path.join('rules', 'ids.mjs')) && !full.includes(`${path.sep}config${path.sep}`)) {
        const text = await fs.readFile(full, 'utf8');
        for (const m of text.matchAll(/\b(?:[A-Z_]*RULE[A-Z_]*|rule)\s*[:=]\s*'([a-z][a-z-]*)'/g)) found.add(m[1]);
      }
    }
  };
  await walk(LIB);
  assert.deepEqual([...found].sort(), [...RULE_IDS, ...INTEGRITY_RULE_IDS].sort());
});

test('through main: an invalid config gives exit 2 with usage, the key named, no path', async (t) => {
  const { dir, cleanup } = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(cleanup);
  const cfgs = await materialize({
    'unknown.json': '{"guardrails":{}}',
    'integrity.json': '{"rules":{"scan-incomplete":false}}',
    'star.json': '{"allowlist":{"configPackages":["*"]}}',
    'ok.json': '{"rules":{"envrc":false},"language":"it"}',
  }, { prefix: 'repoflags-cfg-' });
  t.after(cfgs.cleanup);
  const run = async (name) => {
    const c = makeIo();
    const code = await main([dir, '--offline', '--config', path.join(cfgs.dir, name)], c.io, { fetch: makeForbiddenFetch(), env: {} });
    return { code, err: c.stderr() };
  };
  for (const [name, re] of [['unknown.json', /guardrails/], ['integrity.json', /scan-incomplete/], ['star.json', /configPackages/]]) {
    const r = await run(name);
    assert.equal(r.code, 2, name);
    assert.match(r.err, re);
    assert.match(r.err, /Usage:/);
    assert.ok(!r.err.includes(cfgs.dir));
  }
  assert.equal((await run('ok.json')).code, 0);
});
