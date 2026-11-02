// Validation of the two allowlists. Entries that would match (nearly) everything are refused (D-68): an allowlist
// is an exception for named things, not a switch that silences a rule.
import { AnalyzeError } from '../errors.mjs';
import { clip } from './clip.mjs';

export const MAX_PACKAGE_ENTRIES = 200;
export const MAX_PACKAGE_LENGTH = 214;
export const MAX_COMMAND_ENTRIES = 100;
export const MAX_COMMAND_LENGTH = 1000;

const NAME = '[a-z0-9][a-z0-9._-]*';
const EXACT = new RegExp(`^(@${NAME}/)?${NAME}$`);
const PREFIX = new RegExp(`^(@${NAME}/)?${NAME}\\*$`);
const SCOPE_ALL = new RegExp(`^@${NAME}/\\*$`);
const MIN_PREFIX = 3;

function isAcceptablePackage(entry) {
  if (typeof entry !== 'string' || entry.length > MAX_PACKAGE_LENGTH) return false;
  if (EXACT.test(entry) || SCOPE_ALL.test(entry)) return true;
  // A bare prefix needs at least three characters before the star ("ab*" would match thousands of names).
  return PREFIX.test(entry) && entry.length - 1 >= MIN_PREFIX;
}

function list(value, label, max) {
  if (!Array.isArray(value)) throw new AnalyzeError(`${label} must be an array`);
  if (value.length > max) throw new AnalyzeError(`${label} has at most ${max} entries`);
  return value;
}

export function validatePackages(value) {
  const label = 'allowlist.configPackages';
  const out = [];
  for (const entry of list(value, label, MAX_PACKAGE_ENTRIES)) {
    if (!isAcceptablePackage(entry)) throw new AnalyzeError(`${label}: entry not accepted (${clip(entry)}): use an exact name, a prefix of 3+ characters before a final *, or @scope/*`);
    out.push(entry);
  }
  return out;
}

export function validateCommands(value) {
  const label = 'allowlist.lifecycleCommands';
  const out = [];
  for (const entry of list(value, label, MAX_COMMAND_ENTRIES)) {
    const norm = typeof entry === 'string' ? entry.trim().replace(/\s+/g, ' ') : '';
    if (norm === '' || norm.length > MAX_COMMAND_LENGTH) throw new AnalyzeError(`${label}: entries must be non-empty strings of at most ${MAX_COMMAND_LENGTH} characters`);
    out.push(norm);
  }
  return out;
}
