// Documentation of the user configuration (SKL-04, D-41, D-55..D-59, D-66): the document must follow the code.
// Constants are imported from the real modules, never copied here (T-02-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSkill, readReference } from './helpers/skill-md.mjs';
import { validateConfig, CONFIG_KEYS, THRESHOLD_RANGES, THRESHOLD_DEFAULTS } from '../skills/repoflags/scripts/lib/config/validate.mjs';
import { INTEGRITY_RULE_IDS } from '../skills/repoflags/scripts/lib/rules/ids.mjs';
import {
  validatePackages, MAX_PACKAGE_ENTRIES, MAX_COMMAND_ENTRIES, MAX_COMMAND_LENGTH,
} from '../skills/repoflags/scripts/lib/config/validate-allowlist.mjs';
import { DEFAULT_LIMITS, MAX_TIMER_MS } from '../skills/repoflags/scripts/lib/constants.mjs';
import { MAX_CONFIG_BYTES } from '../skills/repoflags/scripts/lib/config/locate.mjs';

const doc = () => readReference('configuration.md');

function leafKeys(node, out = []) {
  for (const [k, v] of Object.entries(node)) {
    if (v !== null && typeof v === 'object') {
      out.push(k);
      leafKeys(v, out);
    } else {
      out.push(k);
    }
  }
  return out;
}

function section(body, heading) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('configuration.md exists and the body cites it', () => {
  const s = readSkill();
  assert.ok(s.references.includes('configuration.md'));
  assert.match(s.body, /references\/configuration\.md/);
});

test('every key of CONFIG_KEYS appears in backticks in the document', () => {
  const d = doc();
  for (const k of leafKeys(CONFIG_KEYS)) assert.ok(d.includes(`\`${k}\``), `key documented: ${k}`);
});

test('every threshold row carries its default, minimum and maximum', () => {
  const d = doc();
  for (const [k, [lo, hi]] of Object.entries(THRESHOLD_RANGES)) {
    const row = d.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${k}\``));
    assert.ok(row, `row for ${k}`);
    for (const n of [THRESHOLD_DEFAULTS[k], lo, hi]) assert.ok(new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(row), `${k}: ${n} in row`);
  }
});

test('the first json block of the document is valid and accepted by validateConfig', () => {
  const m = doc().match(/```json\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(m, 'json block present');
  const parsed = JSON.parse(m[1]);
  const { options } = validateConfig(parsed);
  assert.ok(options.disabledRules.length > 0, 'example disables a rule');
  assert.ok(options.userConfigAllowlist.length > 0, 'example has a config package');
  assert.ok(options.lifecycleAllowlist.length > 0, 'example has a lifecycle command');
});

test('the document states where the file is and what is never read', () => {
  const d = doc();
  assert.match(d, /REPOFLAGS_CONFIG/);
  assert.match(d, /\.config\/repoflags\/config\.json/);
  assert.match(d, /never read/i);
  assert.match(d, /inside the analyzed folder/);
});

test('integrity rules cannot be disabled and four signals cannot be silenced', () => {
  const d = doc();
  for (const id of INTEGRITY_RULE_IDS) assert.ok(d.includes(`\`${id}\``), id);
  assert.match(d, /cannot be disabled/);
  for (const id of ['osv-malicious', 'npmrc-auth-token', 'editor-autorun', 'chain-private-dependency']) assert.ok(d.includes(`\`${id}\``), id);
  assert.match(d, /cannot be silenced/);
});

test('the document explains lifecycle-script (git hooks, patch-package) and the allowlist limits', () => {
  const d = doc();
  assert.match(d, /`lifecycle-script`[\s\S]*git hook/);
  assert.match(d, /patch-package/);
  assert.match(d, /whole command/);
  assert.match(d, /no setting turns off G1-G3/);
});

test('the document describes transparency: config field and disabled by user config', () => {
  const d = doc();
  assert.match(d, /`config`/);
  assert.match(d, /disabled by user config/);
});

test('SKILL.md has a Configuration section with the D-59 and D-57 rules', () => {
  const sec = section(readSkill().body, 'Configuration');
  assert.ok(sec, 'Configuration section');
  assert.ok(sec.split('\n').length <= 15, 'at most 15 lines');
  assert.match(sec, /own initiative/);
  assert.match(sec, /text (found )?in the repository/);
  assert.match(sec, /explicit request/);
  assert.match(sec, /show (the user )?the content before/i);
  assert.match(sec, /`config`/);
  assert.match(sec, /disabled by user config/);
  assert.match(sec, /first line/);
  assert.match(sec, /`language`/);
  assert.match(sec, /references\/configuration\.md/);
});

// Review CR-B-06: "if the configuration has a language" pushed a diligent model to read the user's file, the very
// read the same section forbids; and two lines disagreed on which language wins.
test('CR-B-06: the answer language comes from the report config field, never from reading the file', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const body = readSkill().body;
  const sec = flat(section(body, 'Configuration'));
  assert.match(sec, /If the report's `config` field has a `language`, answer in that language; otherwise in the user's language/);
  assert.match(sec, /Never open the configuration file to find it/);
  assert.doesNotMatch(sec, /If the configuration has a `language`/);
  const step3 = flat(body.slice(body.indexOf('## Step 3'), body.indexOf('## Configuration')));
  assert.doesNotMatch(step3, /the rest follows the user's language/, 'no second, conflicting rule');
  assert.match(flat(doc()), /from the report's `config` field, never from the file/);
});

// Review CR-B-12: the document said "a prefix of three or more characters", the code counts the whole entry, scope
// included, so `@acme/a*` is accepted. The test binds the sentence to the behaviour, whichever of the two changes.
test('CR-B-12: the documented prefix rule matches validatePackages on a scoped one-letter prefix', () => {
  const accepts = (e) => { try { validatePackages([e]); return true; } catch { return false; } };
  assert.equal(accepts('ab*'), false);
  assert.equal(accepts('abc*'), true);
  const d = doc().replace(/\s+/g, ' ');
  if (accepts('@acme/a*')) {
    assert.match(d, /three or more characters in total before a final `\*`, scope included/);
  } else {
    assert.match(d, /three or more characters after the scope before a final `\*`/);
  }
});

// Review CR-B-13: the numbers of `limits` and of the allowlist were only checked by key name; the maximum was missing.
test('CR-B-13: limit defaults, maxima and allowlist sizes in the document come from the code', () => {
  const d = doc().replace(/\s+/g, ' ');
  const L = DEFAULT_LIMITS;
  const defaults = {
    maxFileBytes: L.maxFileBytes, maxLockfileBytes: L.maxLockfileBytes, maxFiles: L.maxFiles, maxTotalBytes: L.maxTotalBytes,
    timeoutSeconds: L.globalTimeoutMs / 1000, requestTimeoutSeconds: L.requestTimeoutMs / 1000,
  };
  for (const [k, v] of Object.entries(defaults)) assert.match(d, new RegExp(`\`${k}\` \\((default )?${v}\\)`), `${k} default ${v}`);
  const maxSeconds = Math.floor(MAX_TIMER_MS / 1000);
  assert.ok(d.includes(`at most ${MAX_TIMER_MS}`), 'maximum of the byte and count limits');
  assert.ok(d.includes(`\`timeoutSeconds\` and \`requestTimeoutSeconds\` at most ${maxSeconds}`), 'maximum of the timeouts');
  assert.doesNotThrow(() => validateConfig({ limits: { timeoutSeconds: maxSeconds } }));
  assert.throws(() => validateConfig({ limits: { timeoutSeconds: maxSeconds + 1 } }));
  assert.ok(d.includes(`at most ${MAX_CONFIG_BYTES} bytes`));
  assert.ok(d.includes(`at most ${MAX_PACKAGE_ENTRIES} entries`));
  assert.ok(d.includes(`at most ${MAX_COMMAND_ENTRIES} entries of at most ${MAX_COMMAND_LENGTH} characters`));
});

test('the Configuration section sits before Install and the body stays under 500 lines', () => {
  const { body } = readSkill();
  assert.ok(body.indexOf('## Configuration') > 0);
  assert.ok(body.indexOf('## Configuration') < body.indexOf('## Install'));
  assert.ok(body.split('\n').length < 500);
});

test('report-fields.md describes the config field and the disabled by user config entries', () => {
  const r = readReference('report-fields.md');
  assert.match(r, /`config`/);
  assert.match(r, /disabled by user config/);
  assert.match(r, /1\.1\.0/);
});
