// Tests of the red team arguments (03-03, D-75, D-76, UF-01). `claude` is NEVER started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptRules, buildRedteamArgs } from '../scripts/redteam/args.mjs';
import { FORBIDDEN_TOOLS } from '../scripts/smoke/stream-parse.mjs';

const SKILL = 'C:\\Users\\x\\Temp\\rt\\.claude\\skills\\repoflags';
const SKILL_FWD = 'C:/Users/x/Temp/rt/.claude/skills/repoflags';
const cmd = (target) => `node "${SKILL_FWD}/scripts/repoflags.mjs" '${target}' --format json`;

test('scriptRules: remote target -> exactly Bash and PowerShell, exact command', () => {
  assert.deepEqual(scriptRules({ skillDir: SKILL, target: 'shadcn-ui/taxonomy' }), [
    `Bash(${cmd('shadcn-ui/taxonomy')})`,
    `PowerShell(${cmd('shadcn-ui/taxonomy')})`,
  ]);
});

test('scriptRules: local Windows target -> 4 rules (back and forward slashes)', () => {
  const rules = scriptRules({ skillDir: SKILL, target: 'C:\\x\\y' });
  assert.equal(rules.length, 4);
  for (const t of ['C:\\x\\y', 'C:/x/y']) {
    assert.ok(rules.includes(`Bash(${cmd(t)})`));
    assert.ok(rules.includes(`PowerShell(${cmd(t)})`));
  }
});

test('scriptRules: a target without backslashes is not duplicated', () => {
  assert.equal(scriptRules({ skillDir: SKILL, target: '/tmp/x/y' }).length, 2);
});

test('scriptRules: no target -> no rules (H8, H9)', () => {
  assert.deepEqual(scriptRules({ skillDir: SKILL, target: null }), []);
  assert.deepEqual(scriptRules({ skillDir: SKILL, target: '' }), []);
});

test('scriptRules: no wildcard, absolute forward-slash path', () => {
  for (const r of scriptRules({ skillDir: SKILL, target: 'C:\\x\\y' })) {
    assert.ok(!r.includes('*'));
    assert.ok(r.includes(`"${SKILL_FWD}/scripts/repoflags.mjs"`));
  }
});

test('scriptRules: dangerous characters in skillDir or target throw', () => {
  const NL = String.fromCharCode(10);
  for (const ch of ['"', "'", '`', '$', '(', ')', '*', ';', '&', '|', '<', '>', '%', NL]) {
    assert.throws(() => scriptRules({ skillDir: SKILL, target: `a${ch}b` }), /./, `target ${JSON.stringify(ch)}`);
    assert.throws(() => scriptRules({ skillDir: `C:/a${ch}b`, target: 'o/r' }), /./, `skillDir ${JSON.stringify(ch)}`);
  }
});

test('buildRedteamArgs: required flags, one --allowedTools with Skill then the rules', () => {
  const rules = scriptRules({ skillDir: SKILL, target: 'o/r' });
  const a = buildRedteamArgs({ prompt: 'hi', budget: 2, rules });
  for (const f of ['-p', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--max-budget-usd', '2', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config',
    '--effort', 'low', '--model', 'opus']) assert.ok(a.includes(f), `missing ${f}`);
  assert.equal(a[a.indexOf('--disallowedTools') + 1], FORBIDDEN_TOOLS.join(' '));
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a.filter((x) => x === '--allowedTools').length, 1);
  const at = a.indexOf('--allowedTools');
  assert.deepEqual(a.slice(at + 1, at + 2 + rules.length), ['Skill', ...rules]);
  for (const f of ['--bare', '--safe-mode', '--max-turns', '--dangerously-skip-permissions']) assert.ok(!a.includes(f));
});

test('buildRedteamArgs: no rules -> only Skill; non-positive budget throws; only opus', () => {
  const a = buildRedteamArgs({ prompt: 'hi', budget: 1, rules: [] });
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Skill');
  assert.throws(() => buildRedteamArgs({ prompt: 'hi', rules: [] }), /budget/i);
  assert.throws(() => buildRedteamArgs({ prompt: 'hi', budget: 0, rules: [] }), /budget/i);
  assert.throws(() => buildRedteamArgs({ prompt: 'hi', budget: 1, rules: [], model: 'sonnet' }), /opus/i);
  assert.doesNotThrow(() => buildRedteamArgs({ prompt: 'hi', budget: 1, rules: [], model: 'opus' }));
});
