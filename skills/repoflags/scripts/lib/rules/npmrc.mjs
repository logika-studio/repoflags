// DET-01: registry credentials committed in .npmrc / .yarnrc / .yarnrc.yml.
import { selectKind } from '../acquire/select.mjs';
import { splitLines, findLines } from '../util/text-scan.mjs';
import { maskSecret, sanitizeEvidence } from '../util/sanitize.mjs';
import { DEFAULT_LIMITS } from '../constants.mjs';

export const RULE = 'npmrc-auth-token';
const TITLE = 'Registry credential committed in npm/yarn config';

// Linear patterns only: no nested quantifiers. The value is trimmed in JS, not in the regex. One set per file
// format (review CR-08): `.npmrc` (ini, key may be quoted), `.yarnrc` v1 (`key "value"`, key may be quoted),
// `.yarnrc.yml` (key anywhere on the line, quoted or in a flow mapping).
const NPM_KEY = '"?(?:\\/\\/[^\\s="]*:)?(_authToken|_auth|_password)"?';
const PATTERNS_BY_FILE = {
  '.npmrc': [{ id: 'npm', source: `^\\s*${NPM_KEY}\\s*=(.*)$`, flags: 'i' }],
  '.yarnrc': [{ id: 'yarn1', source: `^\\s*${NPM_KEY}(?:\\s*=|\\s)(.*)$`, flags: 'i' }],
  '.yarnrc.yml': [{ id: 'yarn', source: '(?:^|[\\s{,])["\']?(npmAuthToken|npmAuthIdent)["\']?\\s*:(.*)$', flags: 'i' }],
};
const SEPARATOR = { npm: '=', yarn1: ' ', yarn: ': ' };
// Only a whole `${VAR}` is an interpolation; a literal prefix before it is committed (review IN-07).
const ONLY_ENV = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function cleanValue(raw) {
  let v = String(raw).trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
  return v;
}

/** YAML scalar after `key:`: quoted, plain (ends at `,`, `}` or ` #` in a flow mapping) or a block scalar. */
function yamlValue(raw, lines, lineNo) {
  const t = String(raw).trim();
  if (/^[|>][+-]?$/.test(t)) {
    for (let i = lineNo; i < lines.length; i++) if (lines[i].trim()) return cleanValue(lines[i]);
    return '';
  }
  if (t[0] === '"' || t[0] === "'") {
    const end = t.indexOf(t[0], 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  let end = t.length;
  for (const stop of [',', '}', ' #']) {
    const i = t.indexOf(stop);
    if (i !== -1 && i < end) end = i;
  }
  return t.slice(0, end).trim();
}

// The value is chosen by the repository author (review CR-01): it is registered for masking only when it can be a
// credential (no whitespace, at least MIN_SECRET characters) and as a REPOSITORY secret, which is masked inside
// repository text fields only. Its own signal always shows it masked, whatever its length.
const MIN_SECRET = 8;
function registerSecret(ctx, value) {
  if (value.length < MIN_SECRET || /\s/.test(value)) return;
  (ctx.addRepoSecret ?? ctx.addSecret)(value);
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx) {
  const signals = [];
  const notVerified = [];
  const maxLine = ctx.options?.limits?.maxLineLength ?? DEFAULT_LIMITS.maxLineLength;
  const timeout = ctx.options?.limits?.regexTimeoutMs ?? DEFAULT_LIMITS.regexTimeoutMs;

  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'npmrc') continue;
    const patterns = PATTERNS_BY_FILE[file.slice(file.lastIndexOf('/') + 1).toLowerCase()];
    if (!patterns) continue;
    const lines = splitLines(text, maxLine);
    const { matches, timedOut } = findLines(lines, patterns, timeout);
    // On a timeout the matches found so far are kept (core CR-03 handover); the stop itself is declared.
    if (timedOut) notVerified.push({ check: RULE, reason: `scan of ${sanitizeEvidence(file)} timed out` });
    for (const m of matches) {
      const key = m.groups[1];
      const value = m.id === 'yarn' ? yamlValue(m.groups[2], lines, m.line) : cleanValue(m.groups[2]);
      if (!value || ONLY_ENV.test(value)) continue; // empty or only an environment variable: not a literal secret
      registerSecret(ctx, value);
      signals.push({
        rule: RULE,
        severity: 'high',
        title: TITLE,
        file,
        line: m.line,
        evidence: sanitizeEvidence(`${key}${SEPARATOR[m.id]}${maskSecret(value)}`),
        refs: [],
      });
    }
  }
  return { signals, notVerified };
}
