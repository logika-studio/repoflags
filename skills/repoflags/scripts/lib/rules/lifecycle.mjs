// DET-05: npm lifecycle scripts that run on `npm install`. Scripts are only ever read as text, never run.
import { selectKind } from '../acquire/select.mjs';
import { splitLines, findLines } from '../util/text-scan.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { DEFAULT_LIMITS } from '../constants.mjs';

export const RULE = 'lifecycle-script';
const TITLE_SUSPICIOUS = 'Install-time script with suspicious command';
const TITLE_TOOLING = 'Install-time script (common tooling)';
const TITLE_USER = 'Install-time script (allowlisted by user config)';
const USER_NOTE = 'allowlisted by user config';
const TITLE_DEFAULT = 'Install-time script runs on npm install';
const TITLE_UNPARSEABLE = 'package.json could not be parsed: install scripts not fully checked';
const MAX_COMMAND = 10000;

// prepublish is an extension: npm install still runs it.
// `dependencies` runs after node_modules changes (npm), `pnpm:devPreinstall` on a local pnpm install (review WR-04).
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish', 'dependencies', 'pnpm:devPreinstall'];

// Linear patterns only. Ids are plain kebab-case (no parentheses).
export const SUSPICIOUS_PATTERNS = [
  { id: 'curl-wget', source: '\\b(curl|wget)\\b', flags: 'i' },
  { id: 'pipe-to-shell', source: '\\|\\s*(sh|bash|zsh)\\b', flags: 'i' },
  { id: 'node-eval', source: '\\bnode\\s+(-e|--eval|-p|--print)\\b', flags: 'i' },
  { id: 'base64', source: '\\bbase64\\b', flags: 'i' },
  { id: 'powershell-encoded', source: '\\bpowershell(\\.exe)?\\b[^\\n]{0,200}\\s-(e|enc|encodedcommand)\\b', flags: 'i' },
  { id: 'web-request-cmdlet', source: '\\b(Invoke-WebRequest|iwr|Invoke-Expression|iex)\\b', flags: 'i' },
  { id: 'node-nonjs-file', source: '\\bnode\\s+[^\\s|;&]+\\.(woff2?|ttf|otf|png|jpe?g|gif|svg|ico|txt|json|css)\\b', flags: 'i' },
];

// Exact commands after trim and whitespace compression. node-gyp rebuild left the list (review WR-03): it builds
// binding.gyp, whose command expansions run shell commands.
export const LIFECYCLE_ALLOWLIST = new Set([
  'husky', 'husky install', 'is-ci || husky install', 'is-ci || husky',
  'patch-package', 'npx patch-package',
]);

/** 1-based line of the `"<hook>"` key in the manifest text; 1 when not found. */
function keyLine(lines, hook) {
  const needle = `"${hook}"`;
  // From the "scripts" key on: `"dependencies"` is also a section name (review WR-04, IN-03).
  const from = Math.max(0, lines.findIndex((l) => l.includes('"scripts"')));
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : 1;
}


// A hook key with a JSON string value, for a manifest that JSON.parse refuses (review CR-04): the author can break
// the JSON on purpose. Linear: the two alternatives of the value never start with the same character.
const TEXT_HOOK = {
  id: 'hook',
  source: `"(${LIFECYCLE_HOOKS.join('|')})"\\s*:\\s*"((?:[^"\\\\\\n]|\\\\.){0,${MAX_COMMAND}})"`,
  flags: '',
};

function unescapeJson(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

const squash = (c) => c.trim().replace(/\s+/g, ' ');

/**
 * Built-in allowlist, then the user's `lifecycleCommands`, compared after the same trim and space compression.
 * @returns {'builtin'|'user'|null} who listed it: a user entry is attributed in the signal (D-57, review WR-A-02)
 */
function knownBy(command, userAllow) {
  const c = squash(command);
  if (LIFECYCLE_ALLOWLIST.has(c)) return 'builtin';
  return userAllow.has(c) ? 'user' : null;
}

/** One signal for one hook command, or null when the scan found nothing because it was stopped. */
function hookSignal(file, hook, rawCommand, line, timeout, notVerified, userAllow) {
  const command = rawCommand.slice(0, MAX_COMMAND);
  const { matches, timedOut } = findLines(splitLines(command, MAX_COMMAND), SUSPICIOUS_PATTERNS, timeout);
  // On a timeout the matches found so far are kept (core CR-03 handover); the stop itself is declared.
  if (timedOut) notVerified.push({ check: RULE, reason: `regex budget exceeded on ${sanitizeEvidence(file)} (${hook})` });
  if (timedOut && !matches.length) return null;
  const ids = [...new Set(matches.map((m) => m.id))];
  let severity = 'medium';
  let title = TITLE_DEFAULT;
  let evidence = `${hook}: ${command}`;
  if (ids.length) {
    severity = 'high';
    title = TITLE_SUSPICIOUS;
    evidence = `indicator: ${ids.join(', ')} | ${hook}: ${command}`;
  } else {
    // Indicators were checked first (D-58): the allowlist can only lower a script with none of them.
    const by = knownBy(command, userAllow);
    if (by) severity = 'info';
    if (by === 'builtin') title = TITLE_TOOLING;
    if (by === 'user') {
      title = TITLE_USER;
      evidence = `${USER_NOTE} | ${evidence}`;
    }
  }
  return { rule: RULE, severity, title, file, line, evidence: sanitizeEvidence(evidence), refs: [] };
}

function unparseable(file, text, maxLine, timeout, signals, notVerified, userAllow) {
  notVerified.push({ check: RULE, reason: `unparseable package.json: ${sanitizeEvidence(file)}` });
  signals.push({
    rule: RULE, severity: 'medium', title: TITLE_UNPARSEABLE, file, line: 1,
    evidence: 'not valid JSON: hooks found by a text scan are listed separately', refs: [],
  });
  const { matches } = findLines(splitLines(text, maxLine), [TEXT_HOOK], timeout);
  for (const m of matches) {
    const s = hookSignal(file, m.groups[1], unescapeJson(m.groups[2]), m.line, timeout, notVerified, userAllow);
    if (s) signals.push(s);
  }
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx) {
  const signals = [];
  const notVerified = [];
  const maxLine = ctx.options?.limits?.maxLineLength ?? DEFAULT_LIMITS.maxLineLength;
  const timeout = ctx.options?.regexTimeoutMs ?? ctx.options?.limits?.regexTimeoutMs ?? DEFAULT_LIMITS.regexTimeoutMs;
  const userAllow = new Set((ctx.options?.lifecycleAllowlist ?? []).map((c) => squash(String(c))));

  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'manifest') continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      unparseable(file, String(text), maxLine, timeout, signals, notVerified, userAllow);
      continue;
    }
    const scripts = data && typeof data === 'object' ? data.scripts : null;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) continue;
    const manifestLines = String(text).split(/\r?\n/);

    for (const hook of LIFECYCLE_HOOKS) {
      if (!Object.hasOwn(scripts, hook) || typeof scripts[hook] !== 'string') continue;
      const s = hookSignal(file, hook, scripts[hook], keyLine(manifestLines, hook), timeout, notVerified, userAllow);
      if (s) signals.push(s);
    }
  }
  return { signals, notVerified };
}
