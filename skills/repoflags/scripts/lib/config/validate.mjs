// Strict validation of the user configuration (D-53, D-55, D-56, D-66, D-68). Closed key sets at every level, checked
// with Object.hasOwn; an unknown key, a prototype key or an out-of-range value is an AnalyzeError (exit 2). There is
// deliberately no key for the product guardrails (D-56). Messages name the key, never the file path.
import { MAX_TIMER_MS } from '../constants.mjs';
import { AnalyzeError } from '../errors.mjs';
import { RULE_IDS, INTEGRITY_RULE_IDS } from '../rules/ids.mjs';
import { clip } from './clip.mjs';
import { validatePackages, validateCommands } from './validate-allowlist.mjs';

/** Positive integer from a flag string (or a file number rendered as a string), scaled by `mult`. `label` names the source. */
export function parseLimitValue(raw, label, mult) {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 9e15) throw new AnalyzeError(`${label} needs a positive integer`);
  if (n * mult > MAX_TIMER_MS) throw new AnalyzeError(`${label} must be at most ${Math.floor(MAX_TIMER_MS / mult)}`);
  return n * mult;
}

// file key -> [limits key, multiplier]
const FILE_LIMITS = {
  maxFileBytes: ['maxFileBytes', 1],
  maxLockfileBytes: ['maxLockfileBytes', 1],
  maxFiles: ['maxFiles', 1],
  maxTotalBytes: ['maxTotalBytes', 1],
  timeoutSeconds: ['globalTimeoutMs', 1000],
  requestTimeoutSeconds: ['requestTimeoutMs', 1000],
};

export const THRESHOLD_RANGES = { maxCodeColumn: [100, 1000], whitespaceRun: [10, 200], escapeRun: [5, 100] };
// Equal to MAX_CODE_COLUMN / WHITESPACE_RUN / the escape-run count in rules/config-patterns.mjs (a test compares them).
export const THRESHOLD_DEFAULTS = { maxCodeColumn: 300, whitespaceRun: 40, escapeRun: 20 };

/** The keys the file may contain, nested. Documentation and the closed set in one place. */
export const CONFIG_KEYS = {
  language: 'string',
  limits: Object.fromEntries(Object.keys(FILE_LIMITS).map((k) => [k, 'positive integer'])),
  thresholds: Object.fromEntries(Object.entries(THRESHOLD_RANGES).map(([k, r]) => [k, `integer ${r[0]}-${r[1]}`])),
  rules: 'object: <rule-id>: false',
  allowlist: { configPackages: 'string[]', lifecycleCommands: 'string[]' },
};

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AnalyzeError(`${label} must be an object`);
  for (const k of Object.keys(value)) {
    if (PROTO_KEYS.includes(k)) throw new AnalyzeError(`forbidden config key: ${k}`);
  }
  return value;
}

function section(root, name) {
  return Object.hasOwn(root, name) ? plain(root[name], name) : {};
}

function checkKeys(obj, allowed, prefix) {
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(allowed, k)) throw new AnalyzeError(`unknown config key: ${prefix}${clip(k)}`);
  }
}

function validateLimits(obj) {
  checkKeys(obj, FILE_LIMITS, 'limits.');
  const limits = {};
  for (const [k, v] of Object.entries(obj)) {
    const [key, mult] = FILE_LIMITS[k];
    limits[key] = parseLimitValue(typeof v === 'number' ? String(v) : '', `limits.${k}`, mult);
  }
  return limits;
}

function validateThresholds(obj) {
  checkKeys(obj, THRESHOLD_RANGES, 'thresholds.');
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const [lo, hi] = THRESHOLD_RANGES[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new AnalyzeError(`thresholds.${k} must be an integer between ${lo} and ${hi}`);
    out[k] = v;
  }
  return out;
}

function validateRules(obj) {
  const disabled = [];
  for (const [id, v] of Object.entries(obj)) {
    if (INTEGRITY_RULE_IDS.includes(id)) throw new AnalyzeError(`rules.${id} cannot be disabled: it reports that the scan was incomplete`);
    if (!RULE_IDS.includes(id)) throw new AnalyzeError(`unknown rule id: ${clip(id)}`);
    if (v !== false) throw new AnalyzeError(`rules.${id}: only false is accepted (rules are on by default)`);
    disabled.push(id);
  }
  return disabled.sort();
}

function validateLanguage(value) {
  if (typeof value !== 'string' || value.length > 35 || !LANGUAGE.test(value)) throw new AnalyzeError('language must be a language tag such as "it" or "pt-BR"');
  return value;
}

/** @returns {{options: object, facts: object}} the contract consumed by analyze and the report (see plan 02-02). */
export function validateConfig(json) {
  const root = plain(json, 'config root');
  checkKeys(root, CONFIG_KEYS, '');
  const allow = section(root, 'allowlist');
  checkKeys(allow, CONFIG_KEYS.allowlist, 'allowlist.');
  const thresholds = validateThresholds(section(root, 'thresholds'));
  const disabledRules = validateRules(section(root, 'rules'));
  const configPackages = Object.hasOwn(allow, 'configPackages') ? validatePackages(allow.configPackages) : [];
  const lifecycleCommands = Object.hasOwn(allow, 'lifecycleCommands') ? validateCommands(allow.lifecycleCommands) : [];
  const language = Object.hasOwn(root, 'language') ? validateLanguage(root.language) : null;
  const nonDefault = Object.fromEntries(Object.entries(thresholds).filter(([k, v]) => v !== THRESHOLD_DEFAULTS[k]));
  return {
    options: {
      limits: validateLimits(section(root, 'limits')),
      disabledRules,
      thresholds,
      userConfigAllowlist: configPackages,
      lifecycleAllowlist: lifecycleCommands,
      language,
    },
    facts: {
      disabledRules: [...disabledRules],
      thresholds: nonDefault,
      allowlist: { configPackages: configPackages.length, lifecycleCommands: lifecycleCommands.length },
      language,
    },
  };
}
