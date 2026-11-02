// Dependency collection: direct deps of every package.json plus every lockfile entry (transitive included).
// Pure text parsing; pnpm and yarn formats are assumed (RESEARCH A6). Anything unreadable goes to notVerified.
import { selectKind } from '../../acquire/select.mjs';
import { sanitizeEvidence } from '../../util/sanitize.mjs';
import { parseNpmLock } from './npm-lock.mjs';
import { parsePnpmLock } from './pnpm-lock.mjs';
import { parseYarnLock } from './yarn-lock.mjs';
import { specKind, aliasTarget } from './spec-kind.mjs';

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const NAME = /^(@[a-z0-9._~-]{1,100}\/)?[a-z0-9._~-]{1,214}$/i;
const DIRECT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

function validName(n) {
  return typeof n === 'string' && n.length <= 214 && NAME.test(n) && !/^(@[^/]*\/)?\.+$/.test(n);
}

function parseManifest(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { entries: [], ranges: 0, notVerified: [{ check: 'dependencies', reason: `unparseable package.json: ${sanitizeEvidence(file)}` }] };
  }
  const entries = [];
  let ranges = 0;
  for (const section of DIRECT_SECTIONS) {
    const block = data && typeof data === 'object' ? data[section] : null;
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [key, raw] of Object.entries(block)) {
      if (typeof raw !== 'string') continue;
      // `npm:<name>@<range>` installs <name>: that is the package to check, not the alias (review CR-06).
      const target = specKind(raw) === 'alias' ? aliasTarget(raw) : null;
      const name = target ? target.name : key;
      const spec = target ? target.range : raw;
      const version = EXACT.test(spec) ? spec : null;
      if (version === null && !spec.includes(':') && !spec.includes('/')) ranges++;
      const entry = { name, version, spec, file, direct: true, resolved: null, hasInstallScript: false };
      if (target) entry.alias = key;
      entries.push(entry);
    }
  }
  return { entries, ranges, notVerified: [] };
}

function lockParser(base) {
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return parseNpmLock;
  if (base === 'pnpm-lock.yaml') return parsePnpmLock;
  if (base === 'yarn.lock') return parseYarnLock;
  return null;
}

/** Same name@version: merge fields; two different non-null `resolved` stay separate. */
function dedupe(all) {
  const byKey = new Map();
  const out = [];
  for (const d of all) {
    if (d.version === null) { out.push(d); continue; }
    const key = `${d.name}@${d.version}`;
    const variants = byKey.get(key) ?? [];
    const same = variants.find((v) => v.resolved === null || d.resolved === null || v.resolved === d.resolved);
    if (!same) { variants.push(d); byKey.set(key, variants); out.push(d); continue; }
    if (same.spec !== null && d.spec === null) same.file = d.file; // lockfile origin wins for location
    same.direct = same.direct || d.direct;
    same.spec = same.spec ?? d.spec;
    same.resolved = same.resolved ?? d.resolved;
    same.hasInstallScript = same.hasInstallScript || d.hasInstallScript;
  }
  return out;
}

/**
 * @param {Map<string,{text:string,size:number}>} files
 * @param {{parserFor?: (base: string) => Function|null}} [opts] parserFor: test seam, defaults to the real parsers
 */
export function collectDependencies(files, { parserFor = lockParser } = {}) {
  const notVerified = [];
  const signals = [];
  const all = [];
  const lockDirs = [];
  const lockNames = new Map(); // lockfile folder -> names it lists
  const manifests = [];

  for (const [file, { text }] of files) {
    const kind = selectKind(file);
    if (kind === 'manifest') { manifests.push([file, text]); continue; }
    if (kind !== 'lockfile') continue;
    const base = baseOf(file);
    lockDirs.push(dirOf(file));
    const parser = parserFor(base);
    if (!parser) {
      notVerified.push({ check: 'lockfile', reason: `binary ${base} not parsed` });
      continue;
    }
    if (!String(text).trim()) {
      notVerified.push({ check: 'lockfile', reason: `empty lockfile: ${sanitizeEvidence(file)}` });
      continue;
    }
    let res;
    try {
      res = parser(text, sanitizeEvidence(file));
    } catch (e) {
      res = { entries: [], notVerified: [{ check: 'lockfile', reason: `lockfile could not be parsed: ${sanitizeEvidence(file)}` }] };
      // The input that made the parser throw is chosen by the repository author: a signal, never only a
      // notVerified line, so that it cannot end in "no signals found" (review 03-A CR-02, class REP-02).
      signals.push({
        rule: 'rule-failed', severity: 'medium', title: 'A check could not complete on this repository content',
        file: sanitizeEvidence(file), line: null, evidence: sanitizeEvidence(`lockfile: ${e && e.message ? e.message : e}`), refs: [],
      });
    }
    all.push(...res.entries);
    notVerified.push(...res.notVerified);
    const names = lockNames.get(dirOf(file)) ?? new Set();
    for (const e of res.entries) names.add(e.name);
    lockNames.set(dirOf(file), names);
  }

  const coveringLocks = (dir) => lockDirs.filter((l) => l === '' || l === dir || dir.startsWith(`${l}/`));
  for (const [file, text] of manifests) {
    const res = parseManifest(text, file);
    all.push(...res.entries);
    notVerified.push(...res.notVerified);
    const locks = coveringLocks(dirOf(file));
    if (res.ranges > 0 && !locks.length) {
      notVerified.push({ check: 'osv', reason: `version ranges without lockfile not resolved: ${sanitizeEvidence(file)} (${res.ranges} deps)` });
      continue;
    }
    // A lockfile that exists but does not list a ranged direct dependency (empty or stale) resolves nothing for
    // it: npm install would pick a version the report never checked (review WR-05).
    const missing = res.entries.filter((e) => e.version === null && specKind(e.spec) === 'registry'
      && !locks.some((l) => lockNames.get(l)?.has(e.name))).length;
    if (missing > 0) {
      notVerified.push({ check: 'osv', reason: `version ranges not in the lockfile, not resolved: ${sanitizeEvidence(file)} (${missing} deps)` });
    }
  }

  const valid = all.filter((d) => validName(d.name));
  if (valid.length !== all.length) {
    notVerified.push({ check: 'dependencies', reason: `${all.length - valid.length} invalid package names discarded` });
  }
  return { deps: dedupe(valid), notVerified, signals };
}
