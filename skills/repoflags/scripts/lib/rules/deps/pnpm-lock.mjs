// Minimal pnpm-lock.yaml reader. ASSUMED formats (RESEARCH A6, low confidence): v5 `/name/1.0.0:`,
// v6 `/name@1.0.0:`, v9 `name@1.0.0:` under a top-level `packages:`. Line-based, linear, no YAML engine.
const NAME = '(@[^/@\\s]+\\/[^/@\\s]+|[^/@\\s]+)';
const AT_FORM = new RegExp(`^${NAME}@(\\d[^_@\\s]*)(?:_.*)?$`);
const SLASH_FORM = new RegExp(`^${NAME}\\/(\\d[^_/@\\s]*)(?:_.*)?$`);

function unquote(s) {
  const t = s.trim();
  return t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/** Drops the trailing `:` (and an empty `{}` value) of a key line without a regex (review CR-05: quadratic). */
function keyText(raw) {
  let k = raw.trimEnd();
  if (k.endsWith('{}')) k = k.slice(0, -2).trimEnd();
  if (k.endsWith(':')) k = k.slice(0, -1);
  return k;
}

/** Parses a package key into {name, version} or null. */
function parseKey(raw) {
  let k = unquote(keyText(raw));
  if (k.startsWith('/')) k = k.slice(1);
  const paren = k.indexOf('(');
  if (paren >= 0) k = k.slice(0, paren);
  const m = AT_FORM.exec(k) ?? SLASH_FORM.exec(k);
  if (m) return { name: m[1], version: m[2] };
  // `name@<git or tarball URL>`: no registry version, but the name and the `resolution:` that follows still
  // say where the code comes from (review WR-12).
  const at = k.indexOf('@', 1);
  const name = at > 0 ? k.slice(0, at) : '';
  const rest = at > 0 ? k.slice(at + 1) : '';
  if (!name || name.includes(':') || !rest.includes(':')) return null;
  return { name, version: null };
}

/** @returns {{entries: object[], notVerified: {check:string, reason:string}[]}} */
export function parsePnpmLock(text, file) {
  const entries = [];
  let unknown = 0;
  let major = null;
  let sawRequiresBuild = false;
  let section = null;
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const v = /^lockfileVersion:\s*['"]?(\d+)/.exec(line);
      if (v) major = Number(v[1]);
      section = line.trim() === 'packages:' ? 'packages' : 'other';
      current = null;
      continue;
    }
    if (section !== 'packages') continue;
    if (indent <= 2) {
      const parsed = parseKey(line);
      if (parsed) {
        current = { name: parsed.name, version: parsed.version, spec: null, file, direct: false, resolved: null, hasInstallScript: false };
        entries.push(current);
      } else {
        current = null;
        unknown++;
      }
      continue;
    }
    if (!current) continue;
    const t = line.trim();
    if (t.startsWith('requiresBuild:')) {
      sawRequiresBuild = true;
      current.hasInstallScript = /true/.test(t);
    }
    else if (t.startsWith('resolution:')) {
      const m = /(?:tarball|repo):\s*['"]?([^,}\s'"]+)/.exec(t);
      if (m) current.resolved = m[1];
    }
  }
  const notVerified = [];
  if (!entries.length && String(text).trim()) notVerified.push({ check: 'lockfile', reason: `unrecognized lockfile format, no packages extracted: ${file}` });
  else if (unknown) notVerified.push({ check: 'lockfile', reason: `${unknown} unrecognized pnpm package entries skipped: ${file}` });
  // Assumption (review WR-12, not verified on a real v9 lockfile): pnpm 9 may no longer write requiresBuild. When a
  // v9+ lockfile carries none, the absence of dep-install-script proves nothing and is declared.
  if (major !== null && major >= 9 && entries.length && !sawRequiresBuild) {
    notVerified.push({ check: 'lockfile', reason: `install scripts of dependencies are not recorded in pnpm lockfile v${major}: ${file}` });
  }
  return { entries, notVerified };
}
