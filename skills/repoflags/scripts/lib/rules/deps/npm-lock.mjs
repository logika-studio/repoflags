// package-lock.json / npm-shrinkwrap.json (lockfileVersion 1, 2, 3). Pure text parsing, no execution.
const SEMVER_LIKE = /^[0-9A-Za-z.+-]{1,100}$/;
const MAX_DEPTH = 64;
const DIRECT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function entry(name, version, file, extra = {}) {
  let resolved = typeof extra.resolved === 'string' && extra.resolved ? extra.resolved : null;
  let v = typeof version === 'string' ? version : null;
  if (v !== null && !SEMVER_LIKE.test(v)) {
    resolved = resolved ?? v; // v1 lockfiles store git/tarball URLs in `version`
    v = null;
  }
  return { name, version: v, spec: null, file, direct: !!extra.direct, resolved, hasInstallScript: extra.hasInstallScript === true };
}

/** v2/v3: the `packages` map. */
function fromPackages(packages, file) {
  const root = own(packages, '') && isObj(packages['']) ? packages[''] : {};
  const rootNames = new Set();
  for (const s of DIRECT_SECTIONS) if (isObj(root[s])) for (const n of Object.keys(root[s])) rootNames.add(n);
  const entries = [];
  for (const [key, data] of Object.entries(packages)) {
    if (key === '' || !isObj(data) || data.link === true) continue;
    const marker = 'node_modules/';
    const at = key.lastIndexOf(marker);
    if (at < 0) continue; // workspace folders carry no installed package
    const pathName = key.slice(at + marker.length);
    const name = typeof data.name === 'string' && data.name ? data.name : pathName;
    const top = key === `${marker}${pathName}`;
    entries.push(entry(name, data.version, file, { resolved: data.resolved, hasInstallScript: data.hasInstallScript, direct: top && rootNames.has(pathName) }));
  }
  return entries;
}

/** v1: nested `dependencies`, walked iteratively with a depth cap. */
function fromDependencies(dependencies, file) {
  const entries = [];
  const stack = [[dependencies, 0]];
  let tooDeep = 0;
  while (stack.length) {
    const [map, depth] = stack.pop();
    if (!isObj(map)) continue;
    if (depth > MAX_DEPTH) { tooDeep++; continue; }
    for (const [name, data] of Object.entries(map)) {
      if (!isObj(data)) continue;
      entries.push(entry(name, data.version, file, { resolved: data.resolved, hasInstallScript: data.hasInstallScript }));
      if (isObj(data.dependencies)) stack.push([data.dependencies, depth + 1]);
    }
  }
  // Declared, not silent (review WR-05).
  const notVerified = tooDeep ? [{ check: 'lockfile', reason: `${tooDeep} dependency levels deeper than ${MAX_DEPTH} not read: ${file}` }] : [];
  return { entries, notVerified };
}

/** @returns {{entries: object[], notVerified: {check:string, reason:string}[]}} */
export function parseNpmLock(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { entries: [], notVerified: [{ check: 'lockfile', reason: `unparseable lockfile: ${file}` }] };
  }
  if (!isObj(data)) return { entries: [], notVerified: [{ check: 'lockfile', reason: `unrecognized lockfile structure: ${file}` }] };
  if (own(data, 'packages') && isObj(data.packages)) return { entries: fromPackages(data.packages, file), notVerified: [] };
  if (own(data, 'dependencies') && isObj(data.dependencies)) return fromDependencies(data.dependencies, file);
  return { entries: [], notVerified: [{ check: 'lockfile', reason: `unrecognized lockfile structure: ${file}` }] };
}
