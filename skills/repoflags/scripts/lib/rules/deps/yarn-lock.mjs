// Minimal yarn.lock reader: v1 (`version "1.0.2"`) and Berry (`__metadata:`, `version: 1.0.2`, `resolution:`).
// ASSUMED formats (RESEARCH A6, low confidence). Line-based, linear.
function unquote(s) {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/**
 * Package name of a descriptor such as `a@^1.0.0` or `@s/b@npm:^2.0.0`; an npm alias `x@npm:real@^1` gives `real` (03-06).
 * One alias level only, no recursion: yarn never nests `npm:` inside `npm:`, and a nested key chosen by the
 * repository author must not exhaust the stack (review 03-A CR-02).
 */
function descriptorName(desc) {
  const i = desc.indexOf('@', 1);
  if (i <= 0) return null;
  const rest = desc.slice(i + 1);
  if (!rest.startsWith('npm:')) return desc.slice(0, i);
  const real = rest.slice(4);
  const j = real.indexOf('@', 1);
  if (j > 0) return real.slice(0, j);
  // `x@npm:real` with no range is `real` (03-A WR-08); `x@npm:^2.0.0` is a range of `x`. Linear patterns.
  return NAME_ONLY.test(real) && !RANGE_START.test(real) ? real : desc.slice(0, i);
}

const NAME_ONLY = /^(@[a-z0-9._~-]{1,100}\/)?[a-z0-9._~-]{1,214}$/i;
const RANGE_START = /^(v?\d+(\.|$)|[xX*]$)/;

function field(line) {
  const m = /^(\w+):?\s+(.*)$/.exec(line.trim());
  return m ? [m[1], unquote(m[2])] : [null, null];
}

/** @returns {{entries: object[], notVerified: {check:string, reason:string}[]}} */
export function parseYarnLock(text, file) {
  const src = String(text);
  const berry = /^__metadata:/m.test(src);
  const entries = [];
  let cur = null;
  let dropped = 0; // entries without a name or version: counted, never dropped silently (review WR-05)
  let workspaces = 0; // workspace entries: a lockfile made only of them is recognized, with nothing to extract (03-06)
  const flush = () => {
    if (cur && cur.name && cur.version && !cur.skip) entries.push(cur.dep());
    else if (cur && !cur.skip) dropped++;
    cur = null;
  };
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line[0] !== ' ' && line[0] !== '\t') {
      flush();
      if (!line.trimEnd().endsWith(':') || line.startsWith('__metadata')) continue;
      const first = line.trimEnd().slice(0, -1).split(',')[0];
      const name = descriptorName(unquote(first));
      cur = { name, version: null, resolved: null, skip: false, dep() { return { name: this.name, version: this.version, spec: null, file, direct: false, resolved: this.resolved, hasInstallScript: false }; } };
      continue;
    }
    if (!cur || /^\s{3,}/.test(line)) continue; // only first-level fields
    const [key, value] = field(line);
    if (key === 'version') cur.version = value;
    else if (key === 'resolved') cur.resolved = value;
    else if (berry && key === 'resolution') {
      const at = value.indexOf('@', 1);
      const rest = at > 0 ? value.slice(at + 1) : '';
      if (rest.startsWith('workspace:')) { cur.skip = true; workspaces++; }
      else if (!rest.startsWith('npm:')) cur.resolved = rest;
    }
  }
  flush();
  const notVerified = [];
  if (!entries.length && !workspaces && src.trim()) notVerified.push({ check: 'lockfile', reason: `unrecognized lockfile format, no packages extracted: ${file}` });
  else if (dropped) notVerified.push({ check: 'lockfile', reason: `${dropped} yarn.lock entries without a version or name skipped: ${file}` });
  return { entries, notVerified };
}
