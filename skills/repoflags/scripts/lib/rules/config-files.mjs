// DET-03: executable config files (*.config.*, .*rc.js). The file is only ever read as text, never loaded.
import { builtinModules } from 'node:module';
import { selectKind } from '../acquire/select.mjs';
import { splitLines, findLines } from '../util/text-scan.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { DEFAULT_LIMITS } from '../constants.mjs';
import { redirects } from './registry-config.mjs';
import { IMPORT_PATTERNS, OBFUSCATION_PATTERNS, buildObfuscationPatterns, MAX_CODE_COLUMN, WHITESPACE_RUN, DYNAMIC_IDS, isAllowlisted, isCanonicalSpecifier } from './config-patterns.mjs';

export const RULE = 'config-require-nonstandard';
const TITLE = 'Non-standard package loaded by executable config file';
const OBF_RULE = 'config-obfuscation';
const TITLE_OBF = 'Obfuscated or hidden code in executable config file';
const TITLE_DYNAMIC = 'Dynamic require in executable config file';
const BUILTINS = new Set(builtinModules);
const MAX_ROUNDS = 64; // scan rounds per file, bounded; lines still pending after them are reported

/** Package name without subpath; null when the specifier is relative, absolute or a builtin. */
export function packageName(spec) {
  let s = String(spec).trim();
  if (s.startsWith('node:')) return null;
  if (s.startsWith('.') || s.startsWith('/')) return null;
  const parts = s.split('/');
  // A `.`/`..` segment, a backslash or a percent sign can leave the allowlisted package (review WR-07, CR-A-03):
  // the whole specifier is the name, and isAllowlisted never matches it.
  if (!isCanonicalSpecifier(s)) return s;
  const name = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (BUILTINS.has(s) || BUILTINS.has(name)) return null;
  return name;
}

/**
 * findLines reports one match per pattern per line. To avoid a first match hiding a later one on the same
 * line, the text after the EARLIEST-ending match is scanned again (review CR-02: cutting after the last one
 * skipped everything in between). Rounds are bounded; `exhausted` lists the lines left unscanned.
 */
export function scanAll(lines, patterns, timeoutMs) {
  const out = [];
  const seen = new Set();
  let pending = lines.map((text, i) => ({ text, line: i + 1, offset: 0 }));
  for (let round = 0; round < MAX_ROUNDS && pending.length; round++) {
    const { matches, timedOut } = findLines(pending.map((p) => p.text), patterns, timeoutMs);
    const next = new Map();
    for (const m of matches) {
      const src = pending[m.line - 1];
      const column = m.column + src.offset;
      const key = `${m.id}\u0000${src.line}\u0000${column}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ ...m, line: src.line, column, full: lines[src.line - 1] });
      }
      const cut = m.column - 1 + Math.max(1, m.groups[0].length);
      const prev = next.get(src.line);
      if (!prev) next.set(src.line, { text: src.text, line: src.line, offset: src.offset, cut });
      else if (cut < prev.cut) prev.cut = cut;
    }
    if (timedOut) return { matches: out, timedOut, exhausted: [] };
    pending = [...next.values()]
      .map((p) => ({ text: p.text.slice(p.cut), line: p.line, offset: p.offset + p.cut }))
      .filter((p) => p.text.length > 0);
  }
  return { matches: out, timedOut: false, exhausted: pending.map((p) => p.line) };
}

const isWs = (c) => c === ' ' || c === '\t';
const isWord = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * A line that ends with `(` or `from` continues on the next lines (Prettier writes `require(\n  'x'\n)`): it is
 * scanned joined with the next two, keeping its own line number (review CR-03). No regex on the whole line.
 */
export function joinContinuations(lines) {
  return lines.map((l, i) => {
    const t = l.trimEnd();
    const open = t.endsWith('(') || (t.endsWith('from') && !isWord(t[t.length - 5]));
    return open ? `${l} ${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}` : l;
  });
}

/** Single linear pass: first non-space char index after column MAX_CODE_COLUMN, or -1. */
function beyondColumn(line, max) {
  if (line.length <= max) return -1;
  for (let i = max; i < line.length; i++) if (!isWs(line[i]) && line[i] !== '\r') return i;
  return -1;
}

/** True when code follows a run of >= `minRun` blanks that itself follows code (indentation excluded). */
function hiddenAfterWhitespace(line, minRun) {
  let run = 0;
  let seenCode = false;
  for (let i = 0; i < line.length; i++) {
    if (isWs(line[i])) { run++; continue; }
    if (seenCode && run >= minRun) return true;
    seenCode = true;
    run = 0;
  }
  return false;
}

function obfuscation(file, lines, timeout, signals, th) {
  // On a timeout the matches found so far are kept and the column checks (no regex) still run (review IN-01).
  const { matches, timedOut } = findLines(lines, th.patterns, timeout);
  const byLine = new Map();
  const add = (line, id, excerpt) => {
    const e = byLine.get(line) ?? { ids: [], excerpt };
    if (!e.ids.includes(id)) e.ids.push(id);
    byLine.set(line, e);
  };
  for (const m of matches) add(m.line, m.id, m.text.trim());
  lines.forEach((l, i) => {
    const col = beyondColumn(l, th.maxColumn);
    if (col >= 0) add(i + 1, `code beyond column ${th.maxColumn}`, l.slice(col, col + 60));
    if (hiddenAfterWhitespace(l, th.whitespaceRun)) add(i + 1, 'code after long whitespace run', l.trim());
  });
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const { ids, excerpt } = byLine.get(line);
    signals.push({
      rule: OBF_RULE, severity: 'high', title: TITLE_OBF, file, line,
      evidence: sanitizeEvidence(`indicator: ${ids.join(', ')} | ${excerpt}`), refs: [],
    });
  }
  return !timedOut;
}

/** Thresholds of this analysis (user config, defaults otherwise); patterns built once per analysis, not per file. */
function thresholdsOf(options) {
  const t = options?.thresholds ?? {};
  const pick = (v, d) => (Number.isInteger(v) ? v : d);
  const escapeRun = pick(t.escapeRun, 20);
  return {
    maxColumn: pick(t.maxCodeColumn, MAX_CODE_COLUMN),
    whitespaceRun: pick(t.whitespaceRun, WHITESPACE_RUN),
    patterns: escapeRun === 20 ? OBFUSCATION_PATTERNS : buildObfuscationPatterns(escapeRun),
  };
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx) {
  const signals = [];
  const th = thresholdsOf(ctx.options);
  const notVerified = [];
  const maxLine = ctx.options?.limits?.maxLineLength ?? DEFAULT_LIMITS.maxLineLength;
  const timeout = ctx.options?.regexTimeoutMs ?? ctx.options?.limits?.regexTimeoutMs ?? DEFAULT_LIMITS.regexTimeoutMs;
  const extra = ctx.options?.configAllowlist ?? [];
  const userList = ctx.options?.userConfigAllowlist ?? [];
  // Names served by a registry the repository redirected are not "known tooling" (review WR-07).
  const red = redirects(files);
  const redirected = (n) => red.defaultRedirected || (n.startsWith('@') && red.scopes.has(n.split('/')[0].toLowerCase()));

  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'config') continue;
    const lines = splitLines(text, maxLine);
    const joined = joinContinuations(lines);
    const imports = scanAll(joined, IMPORT_PATTERNS, timeout);
    // On a timeout the imports found so far are kept and obfuscation still runs (core CR-03 handover, IN-01).
    if (imports.timedOut) notVerified.push({ check: RULE, reason: `regex budget exceeded on ${sanitizeEvidence(file)}` });
    if (!obfuscation(file, lines, timeout, signals, th)) {
      notVerified.push({ check: OBF_RULE, reason: `regex budget exceeded on ${sanitizeEvidence(file)}` });
    }
    if (imports.exhausted.length) {
      // More module loads on one line than scan rounds: something a person never writes (review CR-02).
      notVerified.push({ check: RULE, reason: `too many module loads on one line, rest of the line not scanned: ${sanitizeEvidence(file)}` });
      signals.push({
        rule: RULE, severity: 'medium', title: 'Too many module loads on one line of an executable config file',
        file, line: imports.exhausted[0], evidence: sanitizeEvidence(joined[imports.exhausted[0] - 1].trim()), refs: [],
      });
    }
    const seen = new Set();
    for (const m of imports.matches) {
      const dynamic = DYNAMIC_IDS.has(m.id);
      const name = dynamic ? `dynamic:${m.line}` : packageName(m.groups[1]);
      if (!name || (!dynamic && isAllowlisted(name, extra, { tooling: !redirected(name) })) || seen.has(name)) continue;
      seen.add(name);
      // User allowlist (D-58/D-68): the signal is emitted so chains still see it; applyUserConfig drops it later.
      // A name served by a registry the repository redirected is never suppressed (review WR-A-01).
      const byUser = !dynamic && userList.length > 0 && !redirected(name) && isAllowlisted(name, userList, { tooling: false });
      signals.push({
        ...(byUser ? { suppressedByUser: true } : {}),
        rule: RULE,
        severity: 'medium',
        title: dynamic ? TITLE_DYNAMIC : TITLE,
        file,
        line: m.line,
        evidence: sanitizeEvidence(m.full.trim()),
        refs: [],
        // Not part of the report (build drops it): config-resolution looks the name up in the intel results.
        package: dynamic ? null : name,
      });
    }
  }
  return { signals, notVerified };
}
