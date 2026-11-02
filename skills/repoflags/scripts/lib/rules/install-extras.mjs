// DET-05, beyond package.json scripts (review WR-03, WR-04): code that runs on install or on the first commit
// without a lifecycle script naming it. Same rule family and id as lifecycle. Files are only read as text.
import { selectKind } from '../acquire/select.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { splitLines, findLines } from '../util/text-scan.mjs';
import { DEFAULT_LIMITS } from '../constants.mjs';
import { SUSPICIOUS_PATTERNS } from './lifecycle.mjs';

export const RULE = 'lifecycle-script';
const MAX_LINE = 10000;

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

function manifestIn(files, dir) {
  const entry = files.get(dir ? `${dir}/package.json` : 'package.json');
  if (!entry) return null;
  try {
    const data = JSON.parse(entry.text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** binding.gyp: npm runs `node-gyp rebuild` when install/preinstall are absent and gypfile is not false. */
function gypSignal(file, text, files) {
  const pkg = manifestIn(files, dirOf(file));
  const scripts = pkg && own(pkg, 'scripts') && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  if (pkg && own(pkg, 'gypfile') && pkg.gypfile === false) return null;
  if (own(scripts, 'install') || own(scripts, 'preinstall')) return null; // the script itself is reported by lifecycle
  // `<!(cmd)` and `<!@(cmd)` are GYP command expansions: they run a shell command while the build is configured.
  const found = [String(text).indexOf('<!('), String(text).indexOf('<!@(')].filter((i) => i >= 0);
  const expansion = found.length > 0;
  const at = expansion ? Math.min(...found) : 0;
  const line = expansion ? String(text).slice(0, at).split('\n').length : 1;
  return {
    rule: RULE, severity: expansion ? 'high' : 'medium',
    title: expansion ? 'Native build file runs a shell command on install' : 'Native build file: npm runs node-gyp rebuild on install',
    file, line, evidence: sanitizeEvidence(expansion ? `command expansion: ${String(text).slice(at, at + 120)}` : 'binding.gyp without install script: node-gyp rebuild runs on npm install'),
    refs: [],
  };
}

/** A git hook under .husky/ runs on the user's first commit: suspicious commands in it are high (review WR-03). */
function huskySignal(file, text, timeout, notVerified) {
  const { matches, timedOut } = findLines(splitLines(text, MAX_LINE), SUSPICIOUS_PATTERNS, timeout);
  if (timedOut) notVerified.push({ check: RULE, reason: `regex budget exceeded on ${sanitizeEvidence(file)}` });
  if (!matches.length) return null;
  const ids = [...new Set(matches.map((m) => m.id))];
  return {
    rule: RULE, severity: 'high', title: 'Git hook with suspicious command (runs on commit)', file, line: matches[0].line,
    evidence: sanitizeEvidence(`indicator: ${ids.join(', ')} | ${matches[0].text.trim()}`), refs: [],
  };
}

/** patch-package rewrites node_modules from the repository's patches/ (review WR-03): the patched packages. */
function patchSignals(files) {
  const byDir = new Map();
  for (const file of files.keys()) {
    if (selectKind(file) !== 'patch') continue;
    const dir = dirOf(dirOf(file));
    const name = file.slice(file.lastIndexOf('/') + 1).replace(/\.patch$/i, '');
    const parts = name.split('+');
    const pkg = parts[0].startsWith('@') && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    byDir.set(dir, [...(byDir.get(dir) ?? []), pkg]);
  }
  const out = [];
  for (const [dir, pkgs] of byDir) {
    const manifest = manifestIn(files, dir);
    const scripts = manifest && own(manifest, 'scripts') && manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    const hook = Object.keys(scripts).find((k) => typeof scripts[k] === 'string' && scripts[k].includes('patch-package'));
    if (!hook) continue;
    const shown = [...new Set(pkgs)];
    out.push({
      rule: RULE, severity: 'medium', title: 'patch-package modifies installed packages with patches from the repository',
      file: dir ? `${dir}/package.json` : 'package.json', line: 1,
      evidence: sanitizeEvidence(`${hook}: patch-package | ${shown.length} patched: ${shown.slice(0, 10).join(', ')}`), refs: [],
    });
  }
  return out;
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx = {}) {
  const signals = [];
  const notVerified = [];
  const timeout = ctx.options?.regexTimeoutMs ?? ctx.options?.limits?.regexTimeoutMs ?? DEFAULT_LIMITS.regexTimeoutMs;
  for (const [file, { text }] of files) {
    const kind = selectKind(file);
    const s = kind === 'gyp' ? gypSignal(file, text, files) : kind === 'husky' ? huskySignal(file, text, timeout, notVerified) : null;
    if (s) signals.push(s);
  }
  const patched = patchSignals(files);
  signals.push(...patched);
  if (patched.length) {
    notVerified.push({ check: RULE, reason: 'content of patches/*.patch applied by patch-package was not analyzed' });
  }
  return { signals, notVerified };
}
