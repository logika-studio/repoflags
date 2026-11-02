// D-24 refinement (phase verification 01/11, false positive on a clean Next.js site loading next-intl/plugin): a
// package loaded by an executable config file is `info` when the public npm registry served its packument, every
// declaration of it installs from the public registry, the repository does not redirect its scope, and OSV looked
// it up without a MAL-* entry. Any other case keeps `medium` and the evidence says why. Pure function, no I/O.
import { RULE } from './config-files.mjs';
import { redirects, isPublicRegistry } from './registry-config.mjs';
import { specKind } from './deps/spec-kind.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

export const RESOLVED_NOTE = 'resolvable on public npm registry';
const NOT_PERFORMED = 'registry check not performed';

const startsWithName = (signals, rule, name, sep) => signals.some((s) => s.rule === rule && String(s.evidence ?? '').startsWith(`${name}${sep}`));

/** Entries for `check`: whole = skipped or failed for every package; names = packages not looked up. */
function coverage(notVerified, check) {
  const entries = notVerified.filter((n) => n.check === check);
  return {
    whole: entries.some((n) => !Array.isArray(n.names)),
    names: new Set(entries.flatMap((n) => (Array.isArray(n.names) ? n.names : []))),
    capped: new Set(entries.filter((n) => n.cap === true).flatMap((n) => n.names)),
  };
}

function nonPublicSource(d) {
  if (typeof d.spec === 'string' && specKind(d.spec) !== 'registry') return true;
  return typeof d.resolved === 'string' && d.resolved !== '' && !isPublicRegistry(d.resolved);
}

const isRedirected = (name, k) => k.red.defaultRedirected || (name.startsWith('@') && k.red.scopes.has(name.split('/')[0].toLowerCase()));

/**
 * True when the repository itself makes `name` untrustworthy: redirected registry, non-public source, OSV MAL-* or
 * npm security placeholder. Checked in every mode: the user allowlist never hides such a load (review WR-A-01).
 */
function hostile(name, k) {
  if (isRedirected(name, k)) return true;
  if (k.deps.some((d) => d.name === name && nonPublicSource(d))) return true;
  return startsWithName(k.signals, 'osv-malicious', name, '@') || startsWithName(k.signals, 'npm-security-placeholder', name, ':');
}

/** @returns {string} the note explaining why `name` stays medium, or RESOLVED_NOTE */
function verdict(name, k) {
  if (k.mode === 'offline') return `${NOT_PERFORMED} (offline mode)`;
  if (isRedirected(name, k)) {
    return 'installed from a registry configured by the repository';
  }
  const declared = k.deps.filter((d) => d.name === name);
  if (declared.some(nonPublicSource)) return 'not installed from the public registry';
  if (startsWithName(k.signals, 'osv-malicious', name, '@')) return 'listed as malicious in OSV';
  if (startsWithName(k.signals, 'npm-security-placeholder', name, ':')) return 'replaced by npm security placeholder';
  if (startsWithName(k.signals, 'dep-unresolvable', name, ':')) return 'not resolvable on public npm registry';
  if (!k.resolved.has(name)) {
    if (k.registry.capped.has(name)) return `${NOT_PERFORMED}: beyond the limit of names per analysis`;
    return declared.length ? NOT_PERFORMED : `${NOT_PERFORMED}: not declared as a dependency`;
  }
  if (k.osv.whole || k.osv.names.has(name)) return 'OSV check not performed';
  return RESOLVED_NOTE;
}

/**
 * @param {object[]} signals rules + intel signals
 * @param {{deps: object[], notVerified: object[], resolved: Set<string>, files: Map, mode: string}} input
 *   notVerified: the intel entries only (dependency collection notes are not lookup failures).
 * @returns {object[]} the same signals, config-loaded packages annotated and possibly lowered to info
 */
export function resolveConfigLoads(signals, { deps, notVerified, resolved, files, mode }) {
  const k = {
    signals,
    deps: deps ?? [],
    resolved: resolved ?? new Set(),
    mode,
    red: redirects(files),
    registry: coverage(notVerified ?? [], 'npm-registry'),
    osv: coverage(notVerified ?? [], 'osv'),
  };
  return signals.map((s) => {
    if (s.rule !== RULE || typeof s.package !== 'string') return s;
    const note = verdict(s.package, k);
    const severity = note === RESOLVED_NOTE ? 'info' : s.severity;
    const { suppressedByUser, ...rest } = s;
    const keep = suppressedByUser === true && !hostile(s.package, k) ? { suppressedByUser } : {};
    return { ...rest, ...keep, severity, evidence: sanitizeEvidence(`${note} | ${s.evidence}`) };
  });
}
