import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as npmrc from '../skills/repoflags/scripts/lib/rules/npmrc.mjs';
import * as configFiles from '../skills/repoflags/scripts/lib/rules/config-files.mjs';
import * as editor from '../skills/repoflags/scripts/lib/rules/editor.mjs';
import * as lifecycle from '../skills/repoflags/scripts/lib/rules/lifecycle.mjs';
import * as agents from '../skills/repoflags/scripts/lib/rules/agents.mjs';
import * as depSpecs from '../skills/repoflags/scripts/lib/rules/dep-specs.mjs';
import * as pmConfig from '../skills/repoflags/scripts/lib/rules/pm-config.mjs';
import * as installExtras from '../skills/repoflags/scripts/lib/rules/install-extras.mjs';
import * as aiConfig from '../skills/repoflags/scripts/lib/rules/ai-config.mjs';
import { parseJsonc } from '../skills/repoflags/scripts/lib/util/jsonc.mjs';
import { THRESHOLD_RANGES } from '../skills/repoflags/scripts/lib/config/validate.mjs';
import { parseNpmLock } from '../skills/repoflags/scripts/lib/rules/deps/npm-lock.mjs';
import { parsePnpmLock } from '../skills/repoflags/scripts/lib/rules/deps/pnpm-lock.mjs';
import { parseYarnLock } from '../skills/repoflags/scripts/lib/rules/deps/yarn-lock.mjs';

const BUDGET_MS = 500;
const BS = String.fromCharCode(92);

// Pathological inputs (research: ReDoS section). Each is also embedded in a JSON string where the file type is JSON.
const INPUTS = {
  'a x50000': 'a'.repeat(50000),
  'spaces then x': ' '.repeat(50000) + 'x',
  '_0x x20000': '_0x'.repeat(20000),
  'backslash-u x20000': (BS + 'u').repeat(20000),
  'npm install x5000': 'npm install '.repeat(5000),
  '"a": x20000': '"a":'.repeat(20000),
  '{ x100000': '{'.repeat(100000),
};

const asJsonString = (s) => JSON.stringify(s);
const ctx = () => ({ options: {}, addSecret: () => {}, secrets: new Set() });
const mapOf = (file, text) => new Map([[file, { text, size: text.length }]]);

// rule module -> [file path, builder(payload) -> file text]
const RULES = {
  npmrc: [npmrc, '.npmrc', (p) => `//registry.npmjs.org/:_authToken=${p}\n${p}\n`],
  'config-files': [configFiles, 'tailwind.config.js', (p) => `module.exports = {};\n${p}\n`],
  'editor tasks': [editor, '.vscode/tasks.json', (p) => `{ "tasks": [ { "command": ${asJsonString(p)}, "runOptions": { "runOn": "folderOpen" } } ] }`],
  'editor tasks raw': [editor, '.vscode/tasks.json', (p) => p],
  'editor envrc': [editor, '.envrc', (p) => `${p}\n`],
  lifecycle: [lifecycle, 'package.json', (p) => `{ "scripts": { "postinstall": ${asJsonString(p)} } }`],
  'lifecycle raw': [lifecycle, 'package.json', (p) => p],
  agents: [agents, 'AGENTS.md', (p) => `${p}\n${p} ignore security warnings\n`],
  'dep-specs': [depSpecs, 'package.json', (p) => `{ "dependencies": { "x": ${asJsonString(p)} } }`],
  'dep-specs raw': [depSpecs, 'package.json', (p) => p],
  'pm-config npmrc': [pmConfig, '.npmrc', (p) => `node-options=${p}\n${p}\n`],
  'pm-config yarnrc.yml': [pmConfig, '.yarnrc.yml', (p) => `plugins:\n  - ${p}\n${p}\n`],
  'install-extras husky': [installExtras, '.husky/pre-commit', (p) => `${p}\n${p} curl x | sh\n`],
  'install-extras gyp': [installExtras, 'binding.gyp', (p) => `${p}<!(${p})`],
  'ai-config mcp': [aiConfig, '.mcp.json', (p) => `{ "mcpServers": { "a": { "command": ${asJsonString(p)} } } }`],
  'ai-config raw': [aiConfig, '.claude/settings.json', (p) => p],
  'editor workspace': [editor, 'a.code-workspace', (p) => `{ "tasks": { "tasks": [ { "command": ${asJsonString(p)}, "runOptions": { "runOn": "folderOpen" } } ] }, "settings": { "python.pythonPath": ${asJsonString(p)} } }`],
};

for (const [name, [mod, file, build]] of Object.entries(RULES)) {
  for (const [label, payload] of Object.entries(INPUTS)) {
    test(`redos: rule ${name} on ${label}`, () => {
      const t0 = performance.now();
      const res = mod.detect(mapOf(file, build(payload)), ctx());
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS, `${ms.toFixed(0)} ms`);
      const budget = res.notVerified.filter((n) => /regex budget exceeded/.test(n.reason));
      assert.deepEqual(budget, [], 'regex budget exceeded');
    });
  }
}

const PARSERS = {
  jsonc: (t) => parseJsonc(t),
  'npm lockfile': (t) => parseNpmLock(t, 'package-lock.json'),
  'pnpm lockfile': (t) => parsePnpmLock(t, 'pnpm-lock.yaml'),
  'yarn lockfile': (t) => parseYarnLock(t, 'yarn.lock'),
};

for (const [name, parse] of Object.entries(PARSERS)) {
  for (const [label, payload] of Object.entries(INPUTS)) {
    test(`redos: parser ${name} on ${label}`, () => {
      const t0 = performance.now();
      assert.doesNotThrow(() => parse(payload));
      assert.doesNotThrow(() => parse(`${payload}\n${payload}`));
      assert.ok(performance.now() - t0 < BUDGET_MS * 2, 'parser too slow');
    });
  }
}

// User thresholds at both ends of their validated bands (02-04, review IN-A-08: taken from THRESHOLD_RANGES), plus
// two out-of-band rows: the rule stays linear on adversarial 200 KiB input.
const bandEnd = (i) => Object.fromEntries(Object.entries(THRESHOLD_RANGES).map(([k, r]) => [k, r[i]]));
const EXTREMES = [
  bandEnd(0),
  bandEnd(1),
  { escapeRun: 5, maxCodeColumn: 100, whitespaceRun: 5 },
  { escapeRun: 100, maxCodeColumn: 2000, whitespaceRun: 1000 },
];
const BIG = {
  'escapes x50000': (BS + 'x41').repeat(50000),
  'escapes with gaps': `${BS}x41ab`.repeat(40000),
  'spaces and code': 'a' + ' '.repeat(100000) + 'b' + ' '.repeat(100000) + 'c',
};
for (const th of EXTREMES) {
  for (const [label, payload] of Object.entries(BIG)) {
    test(`redos: config-files thresholds ${JSON.stringify(th)} on ${label}`, () => {
      const t0 = performance.now();
      const res = configFiles.detect(mapOf('tailwind.config.js', `module.exports = {};\n${payload}\n`), { ...ctx(), options: { thresholds: th } });
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS * 2, `${ms.toFixed(0)} ms`);
      assert.deepEqual(res.notVerified.filter((n) => /regex budget exceeded/.test(n.reason)), []);
    });
  }
}
