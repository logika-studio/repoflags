// Not part of the shipped skill: policy of the public tree, shared by the tests and the release export.
// Every pattern is written so that its own source text does not match it (self-check in tests/public-tree.test.mjs).
// Anything outside the allowlist is excluded: the planning folder and the local agent folder are never listed.

const PUBLIC_FILES = new Set([
  '.gitattributes', 'LICENSE', 'README.md', 'README.it.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json',
]);
const PUBLIC_PREFIXES = ['.claude-plugin/', '.github/', 'docs/', 'scripts/', 'skills/', 'tests/'];

/** True when the repo-relative path (forward slashes) belongs to the public tree (D-93). */
export function isPublicPath(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = p.split('/');
  if (segments.some((s) => s.toLowerCase() === 'desktop.ini')) return false;
  if (p.startsWith('scripts/release/')) return false;
  if (p.startsWith('tests/release-')) return false;
  if (PUBLIC_FILES.has(p)) return true;
  return PUBLIC_PREFIXES.some((pre) => p.startsWith(pre) && p.length > pre.length);
}

/** Provider-shaped secrets (D-94c). The value classes follow the providers' formats. */
export const SECRET_RES = [
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { id: 'github-fine-grained-token', re: /github_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'npm-token', re: /npm_[A-Za-z0-9]{36}/ },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\./ },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]+/ },
  { id: 'npmrc-auth-token', re: /_authToken=([A-Za-z0-9._-]{20,})/ },
];

/** Values of `_authToken=` declared fake by the tests; values starting with FAKE or with `${` are fake too. */
export const FAKE_SECRET_VALUES = ['abcdefghijklmnop1234'];

const isFakeValue = (v) => FAKE_SECRET_VALUES.includes(v) || v.startsWith('FAKE') || v.startsWith('${');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function hitLines(text, re, keep = () => true) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const lines = [];
  for (const m of text.matchAll(g)) {
    if (!keep(m)) continue;
    const line = lineOf(text, m.index);
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/** "file:line id" for every provider-shaped secret in `text`. */
export function findSecrets(file, text) {
  const src = String(text);
  return SECRET_RES.flatMap(({ id, re }) => {
    const keep = id === 'npmrc-auth-token' ? (m) => !isFakeValue(m[1]) : () => true;
    return hitLines(src, re, keep).map((l) => `${file}:${l} ${id}`);
  });
}

const PHASE_WORDS = [
  'PLAN', 'SUMMARY', 'CONTEXT', 'RESEARCH', 'PATTERNS', 'VALIDATION', 'VERIFICATION', 'SECURITY', 'REVIEW-FIX', 'REVIEW',
  'SMOKE', 'E2E', 'REDTEAM', 'INVOCATIONS', 'DISCUSSION-LOG', 'UAT', 'RELEASE',
];

/** Names of phase files: two digit phase, optional two digit plan, then an upper-case kind (e.g. a review or a plan). */
export const PHASE_FILE_RE = new RegExp(`\\b0[1-9]-(?:0[1-9]-)?(?:${PHASE_WORDS.join('|')})\\b`);

/** A personal home folder on a drive letter, or any path on the work drive. */
export const PERSONAL_PATH_RE = /[A-Za-z]:[\\/]+users[\\/]+luigi\b|\b[D]:[\\/]/i;

const PLANNING_PHASES_RE = /[.]planning[/\\]phases/;

/** "file:line" for every line that names work material (phase files, the planning folder, personal paths). */
export function findWorkMaterial(file, text) {
  const src = String(text);
  const lines = [...new Set([PHASE_FILE_RE, PERSONAL_PATH_RE, PLANNING_PHASES_RE].flatMap((re) => hitLines(src, re)))];
  return lines.sort((a, b) => a - b).map((l) => `${file}:${l}`);
}
