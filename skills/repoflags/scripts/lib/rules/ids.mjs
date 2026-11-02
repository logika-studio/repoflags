// Rule ids the tool can emit. RULE_IDS may be switched off in the user configuration; INTEGRITY_RULE_IDS may not
// (they tell the reader the scan was partial or a rule crashed: hiding them would turn a gap into a clean report, D-66).
// tests/config-validate.test.mjs compares both lists with the ids found in the sources: add a rule, add its id here.

export const RULE_IDS = Object.freeze([
  'ai-agent-config',
  'ai-instructions',
  'chain-private-dependency',
  'config-obfuscation',
  'config-require-nonstandard',
  'dep-install-script',
  'dep-nonregistry-source',
  'dep-unresolvable',
  'devcontainer-command',
  'editor-autorun',
  'envrc',
  'lifecycle-script',
  'npm-security-placeholder',
  'npmrc-auth-token',
  'osv-advisory',
  'osv-malicious',
  'pm-config-exec',
  'repo-metadata',
]);

export const INTEGRITY_RULE_IDS = Object.freeze(['limits-skipped-critical', 'rule-failed', 'scan-incomplete']);
