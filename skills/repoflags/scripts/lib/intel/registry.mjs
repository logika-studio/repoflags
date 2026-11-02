// DET-02 (network part): is a direct or scoped dependency resolvable on the public npm registry? (D-16)
// Only 404/401/403 mean "not resolvable"; any other failure is "not verified" (T-01-50, Pitfall 10).
import { createHttp } from '../util/http.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { specKind } from '../rules/deps/spec-kind.mjs';
import { RULE as CONFIG_RULE } from '../rules/config-files.mjs';

export const CHECK = 'npm-registry';

const MAX_NAMES = 200;
const CONCURRENCY = 4;
const PLACEHOLDER = '0.0.1-security';
const TITLE_UNRESOLVABLE = 'Dependency not resolvable on the public npm registry';
const TITLE_PLACEHOLDER = 'Package replaced by npm security placeholder';
const PUBLIC_RESOLVED = /^https?:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com)\//i;

function queryable(d) {
  if (!d.direct && !d.name.startsWith('@')) return false;
  // Same classification as the static rule (review CR-06); aliases are already resolved to their target name.
  if (typeof d.spec === 'string' && specKind(d.spec) !== 'registry') return false;
  // A scoped name resolved from a private registry URL is exactly what D-16 asks to verify (review CR-07);
  // other non-public resolutions (git, file, ...) are not registry packages.
  if (typeof d.resolved === 'string' && d.resolved && !PUBLIC_RESOLVED.test(d.resolved)) {
    return d.name.startsWith('@') && /^https?:\/\//i.test(d.resolved);
  }
  return true;
}

const urlOf = (name) => `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, '@')}`;

async function inspect(http, dep, maxBytes) {
  try {
    const res = await http.json(urlOf(dep.name), { headers: { Accept: 'application/vnd.npm.install-v1+json' } }, maxBytes);
    if (res.status === 401 || res.status === 403 || res.status === 404) return { kind: 'unresolvable', status: res.status };
    if (res.status !== 200) return { kind: 'unknown' };
    const body = res.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'unknown' };
    const tags = Object.hasOwn(body, 'dist-tags') ? body['dist-tags'] : null;
    const latest = tags && typeof tags === 'object' && Object.hasOwn(tags, 'latest') ? tags.latest : null;
    const versions = Object.hasOwn(body, 'versions') && body.versions && typeof body.versions === 'object' ? body.versions : {};
    return { kind: 'ok', latest, hasVersion: dep.version ? Object.hasOwn(versions, dep.version) : null };
  } catch {
    // A non-JSON body (http.json throws) comes from a proxy or WAF, not from the registry, which answers JSON:
    // not verified, never "unresolvable" (review WR-06, D-18).
    return { kind: 'unknown' };
  }
}

export async function run(input, ctx) {
  const byName = new Map();
  for (const d of input.deps ?? []) {
    if (!queryable(d)) continue;
    const prev = byName.get(d.name);
    if (!prev || (prev.version === null && d.version !== null)) byName.set(d.name, d);
  }
  // The cap keeps the lookups that matter (live run 01/11, 236 deps): packages loaded by executable config files,
  // then scoped / privately resolved names (D-16), then direct deps. Stable sort: declaration order within a tier.
  const loaded = new Set((input.signals ?? []).filter((s) => s.rule === CONFIG_RULE && typeof s.package === 'string').map((s) => s.package));
  const tier = (d) => {
    if (loaded.has(d.name)) return 0;
    if (d.name.startsWith('@') || (typeof d.resolved === 'string' && d.resolved && !PUBLIC_RESOLVED.test(d.resolved))) return 1;
    return d.direct ? 2 : 3;
  };
  const all = [...byName.values()].sort((a, b) => tier(a) - tier(b));
  if (all.length === 0) return { signals: [], notVerified: [] };
  const batch = all.slice(0, MAX_NAMES);

  const http = createHttp(ctx);
  const maxBytes = ctx.limits.values.maxPackumentBytes;
  const outcomes = new Array(batch.length);
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const i = next++;
      outcomes[i] = await inspect(http, batch[i], maxBytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));

  const signals = [];
  const notVerified = [];
  const unknown = [];
  batch.forEach((d, i) => {
    const o = outcomes[i];
    if (o.kind === 'unknown') { unknown.push(d.name); return; }
    if (o.kind === 'unresolvable') {
      signals.push({
        rule: 'dep-unresolvable', severity: 'medium', title: TITLE_UNRESOLVABLE, file: d.file, line: null,
        evidence: sanitizeEvidence(`${d.name}: registry answered ${o.status}`), refs: [],
      });
      return;
    }
    if (o.latest === PLACEHOLDER) {
      const missing = d.version && o.hasVersion === false ? `; locked version ${d.version} is not among the published versions` : '';
      signals.push({
        rule: 'npm-security-placeholder', severity: 'medium', title: TITLE_PLACEHOLDER, file: d.file, line: null,
        evidence: sanitizeEvidence(`${d.name}: latest is ${PLACEHOLDER}${missing}`), refs: [],
      });
      return;
    }
    // Packument served, real latest: config-resolution may lower a config-loaded package to info (01/11).
    ctx.registryResolved?.add(d.name);
  });
  // `names` (not part of the report: build keeps only check and reason) tells the chain WHICH packages were not
  // verified, so a partial failure never stands in for a package that was verified (review WR-02).
  if (unknown.length) notVerified.push({ check: CHECK, reason: `registry lookup failed or malformed for ${unknown.length} packages`, names: unknown });
  if (all.length > batch.length) {
    notVerified.push({ check: CHECK, reason: `${all.length - batch.length} packages not checked: limit of ${MAX_NAMES} names`, names: all.slice(MAX_NAMES).map((d) => d.name), cap: true });
  }
  return { signals, notVerified };
}
