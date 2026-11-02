// Package-manager settings that run code on every install or script (review CR-09, gap of D-21 closed by decision
// recorded in the review fix report): yarnPath / plugins (.yarnrc.yml), yarn-path (.yarnrc), script-shell,
// node-options, onload-script, node-gyp, git (.npmrc). Read as text only; the referenced files are never loaded.
// Severity (D-21 scale): `medium` for forms common in legitimate repositories (a committed Yarn release or plugin,
// a system shell); `high` when repository code is injected into every install script (node-options loading a
// module, onload-script, a shell/git/node-gyp that is a file of the repository).
import { selectKind } from '../acquire/select.mjs';
import { splitLines, findLines } from '../util/text-scan.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { DEFAULT_LIMITS } from '../constants.mjs';

export const RULE = 'pm-config-exec';
const TITLE_HIGH = 'Package manager setting runs repository code on every install';
const TITLE_MEDIUM = 'Package manager setting runs code that was not inspected';

// Linear, anchored patterns; values are cleaned in JS.
const PATTERNS_BY_FILE = {
  '.npmrc': [{ id: 'npm', source: '^\\s*"?(script-shell|node-options|onload-script|node-gyp|git)"?\\s*=(.*)$', flags: 'i' }],
  '.yarnrc': [{ id: 'yarn1', source: '^\\s*"?(yarn-path|--install\\.script-shell)"?(?:\\s*=|\\s)(.*)$', flags: 'i' }],
  '.yarnrc.yml': [{ id: 'yarn', source: '^\\s*["\']?(yarnPath|plugins)["\']?\\s*:(.*)$', flags: '' }],
};
const LOADS_CODE = /(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader)(?:[=\s]|$)/;
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/|~)/;
const LOOKS_LIKE_FILE = /[\\/]|\.(?:c|m)?js$|\.sh$|\.cmd$|\.bat$|\.exe$/i;

const clean = (v) => {
  const t = String(v).trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1).trim() : t;
};

function severityOf(key, value) {
  const k = key.toLowerCase();
  if (k === 'yarnpath' || k === 'plugins' || k === 'yarn-path') return 'medium';
  if (k === 'onload-script') return 'high';
  if (k === 'node-options') return LOADS_CODE.test(value) ? 'high' : 'medium';
  return !ABSOLUTE.test(value) && LOOKS_LIKE_FILE.test(value) ? 'high' : 'medium';
}

/** Value of a YAML key; for `plugins:` with an empty value, the next indented lines (up to 3). */
function yamlValue(key, raw, lines, lineNo) {
  const v = clean(raw);
  if (v || key !== 'plugins') return v;
  const items = [];
  for (let i = lineNo; i < lines.length && items.length < 3; i++) {
    const l = lines[i];
    if (l.trim() && !/^\s/.test(l)) break;
    if (l.trim()) items.push(l.trim());
  }
  return items.join(' ');
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx) {
  const signals = [];
  const notVerified = [];
  const maxLine = ctx.options?.limits?.maxLineLength ?? DEFAULT_LIMITS.maxLineLength;
  const timeout = ctx.options?.regexTimeoutMs ?? ctx.options?.limits?.regexTimeoutMs ?? DEFAULT_LIMITS.regexTimeoutMs;

  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'npmrc') continue;
    const patterns = PATTERNS_BY_FILE[file.slice(file.lastIndexOf('/') + 1).toLowerCase()];
    if (!patterns) continue;
    const lines = splitLines(text, maxLine);
    const { matches, timedOut } = findLines(lines, patterns, timeout);
    if (timedOut) notVerified.push({ check: RULE, reason: `regex budget exceeded on ${sanitizeEvidence(file)}` });
    for (const m of matches) {
      const key = m.groups[1];
      const value = m.id === 'yarn' ? yamlValue(key, m.groups[2], lines, m.line) : clean(m.groups[2]);
      if (!value) continue;
      const severity = severityOf(key, value);
      signals.push({
        rule: RULE, severity, title: severity === 'high' ? TITLE_HIGH : TITLE_MEDIUM, file, line: m.line,
        evidence: sanitizeEvidence(`${key}: ${value}`), refs: [],
      });
    }
  }
  if (signals.length) notVerified.push({ check: RULE, reason: 'files run by package manager settings (yarnPath, plugins, script-shell, ...) were not inspected' });
  return { signals, notVerified };
}
