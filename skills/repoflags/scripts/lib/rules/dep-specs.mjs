// DET-02 (static part) and DET-05 (dependency install scripts): where do dependencies come from?
// Reads the output of collectDependencies and the npm/yarn config files. No network access in this rule.
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { collectDependencies } from './deps/collect.mjs';
import { specKind, specIsNonRegistry } from './deps/spec-kind.mjs';
import { registryEntries, isPublicRegistry } from './registry-config.mjs';

export const RULE = 'dep-nonregistry-source';
const RULE_SCRIPTS = 'dep-install-script';
const TITLE_SOURCE = 'Dependency installed from outside the public npm registry';
const TITLE_EXEC = 'Dependency produced by running a repository script at install (exec: protocol)';
const TITLE_REGISTRY = 'Custom registry configured in npm config';
const TITLE_SCRIPTS = 'Dependencies with install scripts in lockfile';

/** Drops credentials and query strings: a URL in evidence must never carry a secret (G9). */
function cleanUrl(url) {
  return sanitizeEvidence(String(url).replace(/\/\/[^/@\s]*@/, '//').replace(/\?[^#\s]*/, '?…'));
}

function lineOf(text, needle) {
  const i = needle ? text.indexOf(needle) : -1;
  if (i < 0) return 1;
  let line = 1;
  for (let p = text.indexOf('\n'); p >= 0 && p < i; p = text.indexOf('\n', p + 1)) line++;
  return line;
}

const isPublic = isPublicRegistry;

/** @returns {string|null} grouping key when `resolved` points outside the public registries. */
function resolvedOrigin(resolved) {
  if (/^https?:/i.test(resolved)) {
    if (isPublic(resolved)) return null;
    try { return new URL(resolved).host || 'unknown host'; } catch { return 'unparseable URL'; }
  }
  if (/^(git|github:|gitlab:|bitbucket:|gist:|file:|link:|ssh:|exec:|portal:)/i.test(resolved)) return resolved.split(':')[0].toLowerCase();
  return null; // workspace:, patch:, relative lockfile paths
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx) {
  const signals = [];
  const { deps } = collectDependencies(files);
  const groups = new Map();
  const scripts = new Map();

  for (const d of deps) {
    const text = files.get(d.file)?.text ?? '';
    if (d.spec !== null && specIsNonRegistry(d.spec)) {
      const exec = specKind(d.spec) === 'exec';
      const key = d.alias ?? d.name;
      signals.push({
        rule: RULE, severity: exec ? 'high' : 'medium', title: exec ? TITLE_EXEC : TITLE_SOURCE, file: d.file,
        line: lineOf(text, `"${key}"`), evidence: sanitizeEvidence(`${key}: ${cleanUrl(d.spec)}`), refs: [],
      });
    }
    const origin = d.resolved ? resolvedOrigin(d.resolved) : null;
    if (origin) {
      const key = `${d.file}\u0000${origin}`;
      const g = groups.get(key) ?? { file: d.file, text, count: 0, first: d };
      g.count++;
      groups.set(key, g);
    }
    if (d.hasInstallScript) {
      const s = scripts.get(d.file) ?? [];
      s.push(d.name);
      scripts.set(d.file, s);
    }
  }

  for (const g of groups.values()) {
    const more = g.count > 1 ? ` (+${g.count - 1} more)` : '';
    signals.push({ rule: RULE, severity: 'medium', title: TITLE_SOURCE, file: g.file, line: lineOf(g.text, g.first.resolved), evidence: sanitizeEvidence(`${g.first.name} resolved from ${cleanUrl(g.first.resolved)}${more}`), refs: [] });
  }

  for (const [file, names] of scripts) {
    const shown = [...new Set(names)].slice(0, 10).join(', ');
    const n = names.length;
    signals.push({ rule: RULE_SCRIPTS, severity: 'info', title: TITLE_SCRIPTS, file, line: 1, evidence: sanitizeEvidence(`${n} package${n === 1 ? '' : 's'}: ${shown}${n > 10 ? ', …' : ''}`), refs: [] });
  }

  // Every registry syntax, scoped or not (review WR-11), read by the shared module (review WR-07).
  for (const r of registryEntries(files)) {
    if (isPublic(r.url)) continue;
    signals.push({ rule: RULE, severity: 'medium', title: TITLE_REGISTRY, file: r.file, line: r.line, evidence: sanitizeEvidence(`registry: ${cleanUrl(r.url)}`), refs: [] });
  }

  return { signals, notVerified: [] }; // collection gaps are reported once by analyze()
}
