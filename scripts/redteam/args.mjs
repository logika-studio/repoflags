// Red team arguments (03-03, D-75, D-76, UF-01): the tightest permissions for the headless session. The script rule is
// EXACT: absolute skill path with forward slashes and the exact target, no wildcard, for Bash and PowerShell. Claude
// Code splits compound commands on && || ; | & and newline, so anything appended is a separate, unallowed command.
// Only Opus is accepted. The caller passes the real (realpathSync.native) skill folder; this module does no I/O.
import { FORBIDDEN_TOOLS } from '../smoke/stream-parse.mjs';

const DANGEROUS = /["'`$()*;&|<>%\r\n]/;

function check(label, value) {
  if (DANGEROUS.test(value)) throw new Error(`${label} contains a character not allowed in a permission rule`);
}

/** Exact allow rules for the skill command (same command as SKILL.md Step 2). Empty when there is no target. */
export function scriptRules({ skillDir, target }) {
  if (!target) return [];
  check('skillDir', skillDir);
  check('target', target);
  const script = `${skillDir.replace(/\\/g, '/')}/scripts/repoflags.mjs`;
  const forms = [...new Set([target, target.replace(/\\/g, '/')])];
  const rules = [];
  for (const tool of ['Bash', 'PowerShell']) {
    for (const t of forms) rules.push(`${tool}(node "${script}" '${t}' --format json)`);
  }
  return rules;
}

/** Argument array for `claude -p`. Budget is mandatory; no other free flags are accepted. */
export function buildRedteamArgs({ prompt, budget, rules = [], model = 'opus' }) {
  if (!(Number(budget) > 0)) throw new Error('a positive budget (--max-budget-usd) is mandatory');
  if (model !== 'opus') throw new Error('only the opus model is accepted (D-76)');
  return [
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--allowedTools', 'Skill', ...rules, '--disallowedTools', FORBIDDEN_TOOLS.join(' '),
    '--max-budget-usd', String(budget), '--no-session-persistence', '--setting-sources', 'project',
    '--strict-mcp-config', '--effort', 'low', '--model', 'opus',
  ];
}
