// Shared constants. No string here may claim a verdict of absence of risk (G7).

export const TOOL_NAME = 'repoflags';
export const TOOL_VERSION = '1.0.0';
export const RULES_VERSION = '1.0.0';
export const SCHEMA_VERSION = '1.1.0';

export const OUTCOME_TEXT = { found: 'signals found', none: 'no signals found by these rules' };
export const OUTCOME_JSON = { found: 'signals_found', none: 'no_signals_found_by_these_rules' };

const MIB = 1024 * 1024;
export const DEFAULT_LIMITS = {
  maxFileBytes: 1 * MIB,
  maxLockfileBytes: 10 * MIB,
  maxFiles: 2000,
  maxTotalBytes: 50 * MIB,
  requestTimeoutMs: 15000,
  globalTimeoutMs: 120000,
  maxLineLength: 10000,
  maxPackumentBytes: 5 * MIB,
  regexTimeoutMs: 200,
  evidenceMaxLength: 160,
};

// Largest delay a Node timer accepts: above it Node silently uses 1 ms (review WR-03).
export const MAX_TIMER_MS = 2147483647;

export const ALLOWED_HOSTS = ['api.github.com', 'api.osv.dev', 'registry.npmjs.org'];

export const FIXED_NOT_VERIFIED = [
  { check: 'private-packages', reason: 'content of private or unpublished packages cannot be read' },
  { check: 'runtime-downloads', reason: 'code downloaded at runtime by scripts or dependencies is not analyzed' },
  { check: 'other-commits', reason: 'other branches or commits than the analyzed SHA were not checked' },
  { check: 'binary-files', reason: 'binary files are not inspected' },
  { check: 'node-modules', reason: 'node_modules content is not inspected' },
];

export const DISCLAIMER =
  'Static analysis only: nothing from the repository was executed. These rules may miss new techniques.';
