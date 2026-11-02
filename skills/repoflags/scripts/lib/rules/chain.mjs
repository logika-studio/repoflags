// Composite signal for the real-case attack chain (D-22): committed registry token + scoped dependency that the
// public registry cannot resolve + a package loaded by a config file. Components stay in the report.
// Discretion (declared): offline the scope cannot be checked, so the chain also fires on "direct scoped dependency
// + registry check not performed" and says so in the evidence. Pure function, no I/O.
const RULE = 'chain-private-dependency';
const TITLE = 'Private dependency chain: committed registry token + unresolvable scoped dependency + package loaded by config';

const first = (signals, rule) => signals.find((s) => s.rule === rule);

function scopedPart(signals, deps, notVerified) {
  const unresolved = signals.find((s) => s.rule === 'dep-unresolvable' && String(s.evidence ?? '').startsWith('@'));
  if (unresolved) return { rule: 'dep-unresolvable', file: unresolved.file, text: `dep-unresolvable in ${unresolved.file ?? 'package.json'}` };
  // Not performed = the whole check was skipped or failed (entry without `names`), or this very package is among
  // the names the registry check could not verify (review WR-02).
  const entries = (notVerified ?? []).filter((n) => n.check === 'npm-registry');
  const whole = entries.some((n) => !Array.isArray(n.names));
  const unverified = new Set(entries.flatMap((n) => (Array.isArray(n.names) ? n.names : [])));
  const dep = entries.length
    ? (deps ?? []).find((d) => d.direct && typeof d.name === 'string' && d.name.startsWith('@') && (whole || unverified.has(d.name)))
    : null;
  if (!dep) return null;
  return { rule: 'dep-unresolvable', file: dep.file, text: `scoped dependency ${dep.name} (registry check not performed)` };
}

/** Composite signals are added to the existing ones, never replacing them. */
export function applyChains(signals, { deps, notVerified }) {
  const token = first(signals, 'npmrc-auth-token');
  const loaded = first(signals, 'config-require-nonstandard');
  if (!token || !loaded) return { signals: [], notVerified: [] };
  const scoped = scopedPart(signals, deps, notVerified);
  if (!scoped) return { signals: [], notVerified: [] };
  const evidence = [
    `npmrc-auth-token in ${token.file}`,
    `config-require-nonstandard in ${loaded.file}`,
    scoped.text,
  ].join('; ');
  return {
    signals: [{ rule: RULE, severity: 'high', title: TITLE, file: token.file, line: token.line ?? null, evidence, refs: [] }],
    notVerified: [],
  };
}
