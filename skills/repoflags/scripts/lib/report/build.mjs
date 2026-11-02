// Builds the versioned report (exact keys, D-29). Assigns signal ids after sorting.
import {
  TOOL_NAME, TOOL_VERSION, RULES_VERSION, SCHEMA_VERSION, OUTCOME_JSON, FIXED_NOT_VERIFIED,
} from '../constants.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 };
// A notVerified reason says how much was not checked: it gets more room than an evidence excerpt (WR-07).
// 20 paths of at most 160 characters plus the text around them stay under it.
const REASON_MAX = 4096;
// Code-unit order: the same on every machine, whatever the ICU locale (IN-01).
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function outcomeOf(signals) {
  return signals.some((s) => s.severity === 'high' || s.severity === 'medium') ? OUTCOME_JSON.found : OUTCOME_JSON.none;
}

function compareSignals(a, b) {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    byCodeUnit(String(a.file ?? ''), String(b.file ?? '')) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    byCodeUnit(a.rule, b.rule)
  );
}

const MAX_REF = 255; // longest git ref accepted by validGitRef
const untrusted = (v, max) => (v == null ? null : sanitizeEvidence(v, max));

const REF_PREFIXES = ['https://osv.dev/', 'https://github.com/', 'https://www.npmjs.com/'];

function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = `${String(e.check)}\u0000${String(e.reason)}`; // dedupe on the full text, not the cut one
    const check = sanitizeEvidence(e.check);
    const reason = sanitizeEvidence(e.reason, REASON_MAX);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ check, reason });
  }
  return out;
}

function allowedRefs(refs) {
  return (refs ?? []).filter((r) => typeof r === 'string' && REF_PREFIXES.some((p) => r.startsWith(p)));
}

// D-67: only facts about the configuration, copied key by key (never a spread, never a path).
function configField(facts) {
  if (!facts) return null;
  const th = facts.thresholds ?? {};
  const thresholds = {};
  for (const k of ['maxCodeColumn', 'whitespaceRun', 'escapeRun']) if (Number.isInteger(th[k])) thresholds[k] = th[k];
  return {
    disabledRules: [...(facts.disabledRules ?? [])].map((r) => sanitizeEvidence(r)),
    thresholds,
    allowlist: {
      configPackages: facts.allowlist?.configPackages ?? 0,
      lifecycleCommands: facts.allowlist?.lifecycleCommands ?? 0,
    },
    language: facts.language ?? null,
  };
}

export function buildReport({ acquired, signals, notVerified, ctx }) {
  const config = configField(ctx.options?.configFacts);
  const sorted = [...signals].sort(compareSignals).map((s, i) => ({
    id: `S${i + 1}`,
    rule: s.rule,
    severity: s.severity,
    title: sanitizeEvidence(s.title),
    file: s.file == null ? null : sanitizeEvidence(s.file),
    line: s.line ?? null,
    evidence: sanitizeEvidence(s.evidence),
    refs: allowedRefs(s.refs),
  }));
  const t = acquired.target;
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    rulesVersion: RULES_VERSION,
    // owner, repo and ref can be chosen by the repository author (ref from default_branch): sanitized (WR-12).
    target: { type: t.type, name: sanitizeEvidence(t.name), owner: untrusted(t.owner), repo: untrusted(t.repo), ref: untrusted(t.ref, MAX_REF), sha: t.sha ?? null },
    analyzedAt: ctx.now().toISOString(),
    mode: ctx.mode,
    outcome: outcomeOf(sorted),
    signals: sorted,
    notVerified: dedupe([...FIXED_NOT_VERIFIED, ...notVerified]),
    limits: ctx.limits.snapshot(),
    network: { hosts: { ...ctx.network.hosts } },
    ...(config ? { config } : {}),
  };
}
