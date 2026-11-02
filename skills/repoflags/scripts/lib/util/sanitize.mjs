// Secret masking and untrusted-text sanitizing (G9, Trojan Source, ANSI injection).
import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_LIMITS } from '../constants.mjs';

const MIN_VISIBLE = 12;

/** Masks a secret: first 4 chars only when the value is long enough, plus its length. */
export function maskSecret(value) {
  const s = String(value);
  const head = s.length >= MIN_VISIBLE ? s.slice(0, 4) : '';
  return `${head}…[${s.length} chars]`;
}

// C0/C1 controls (except space), soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// bidi marks/overrides/isolates, line/paragraph separators, invisible operators, variation selectors, BOM,
// Unicode tag characters (invisible to a person, readable by a model: review WR-01) and lone surrogates.
const STRIPPED_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\ud800-\udfff]/gu;

export function sanitizeEvidence(text, max = DEFAULT_LIMITS.evidenceMaxLength) {
  const cleaned = stripVTControlCharacters(String(text)).replace(STRIPPED_CHARS, '·');
  if (cleaned.length <= max) return cleaned;
  let cut = cleaned.slice(0, max - 1);
  // Never end on the first half of a surrogate pair (review IN-03).
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Masks secrets chosen by the analyzed repository (e.g. an `.npmrc` value) ONLY inside the report fields that carry
 * repository text: evidence, file, notVerified reason, target. Keys, rule ids, severities and the outcome are the
 * tool's vocabulary and are never touched, so a value like `high` cannot rewrite the report (review rules CR-01).
 */
export function redactReport(report, secrets) {
  const list = [...secrets].filter(Boolean);
  if (!list.length) return report;
  const r = (v) => (typeof v === 'string' ? redactAll(v, list) : v);
  return {
    ...report,
    target: { ...report.target, name: r(report.target.name), owner: r(report.target.owner), repo: r(report.target.repo), ref: r(report.target.ref) },
    signals: report.signals.map((s) => ({ ...s, file: r(s.file), evidence: r(s.evidence) })),
    notVerified: report.notVerified.map((n) => ({ ...n, reason: r(n.reason) })),
  };
}

/** Replaces every literal occurrence of each known secret with its masked form. */
export function redactAll(output, secrets) {
  let out = String(output);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(maskSecret(secret));
  }
  return out;
}
