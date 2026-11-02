// Where does a package.json dependency spec install code from? One classification shared by the static rule
// (dep-specs) and the registry check, so that the two can never disagree (review CR-06).
// Linear regexes only: anchored, no nested quantifiers.

// Protocols that fetch or build outside the npm registry (npm, Yarn v1/Berry, pnpm).
const NON_REGISTRY_PREFIX = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|ssh:|portal:|patch:)/i;
// Yarn Berry `exec:` runs a script of the repository at install time.
const EXEC_PREFIX = /^exec:/i;
// GitHub shorthand `user/repo` (optionally `#ref`).
const SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#\S*)?$/;
// scp-like git remote accepted by npm: `user@host:path`.
const SCP = /^[^@\s/:]+@[^:\s/]+:/;
// Local folder or tarball: relative, absolute, home or Windows drive path (`~1.2.3` is a range, `~/x` a path).
const LOCAL_PATH = /^(\.{1,2}[\\/]|\/|~[\\/]|[A-Za-z]:[\\/])/;

/** @returns {'registry'|'workspace'|'alias'|'exec'|'non-registry'} */
export function specKind(spec) {
  const s = String(spec).trim();
  if (/^workspace:/i.test(s)) return 'workspace';
  if (/^npm:/i.test(s)) return 'alias';
  if (EXEC_PREFIX.test(s)) return 'exec';
  if (NON_REGISTRY_PREFIX.test(s) || SCP.test(s) || LOCAL_PATH.test(s)) return 'non-registry';
  if (!s.startsWith('@') && !s.includes(':') && SHORTHAND.test(s)) return 'non-registry';
  return 'registry';
}

/** True when the spec installs code from outside the npm registry (exec included). */
export function specIsNonRegistry(spec) {
  const k = specKind(spec);
  return k === 'non-registry' || k === 'exec';
}

/** `npm:<name>@<range>` → {name, range}; null when the alias is malformed. */
export function aliasTarget(spec) {
  const rest = String(spec).trim().slice(4);
  const at = rest.indexOf('@', 1);
  const name = at === -1 ? rest : rest.slice(0, at);
  const range = at === -1 ? '' : rest.slice(at + 1);
  return name ? { name, range: range || '*' } : null;
}
