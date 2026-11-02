// Text fallback for editor files that the strict JSONC parser refuses (core review WR-11). VS Code and the dev
// container CLI use error-tolerant parsers, so a file broken on purpose can still run: the keys that matter are
// looked for in the raw text. Linear regexes only (a literal, `\s*`, a literal; string values whose two
// alternatives never start with the same character), applied to text of bounded size.
import { sanitizeEvidence } from '../util/sanitize.mjs';

const MAX_VALUE = 2000;
const MAX_HITS = 10; // per key and file: a repeated key must not flood the report
const STRING_VALUE = `"((?:[^"\\\\\\n]|\\\\.){0,${MAX_VALUE}})"`;
const NOTE = '(file is not valid JSONC: found by a text scan)';

function lineAt(text, index) {
  let line = 1;
  for (let p = text.indexOf('\n'); p !== -1 && p < index; p = text.indexOf('\n', p + 1)) line++;
  return line;
}

function unescapeJson(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/** Every `"key": "string"` in the text: [{line, value}]. */
export function stringValues(text, key) {
  const re = new RegExp(`"${key.replace(/[.]/g, '\\.')}"\\s*:\\s*${STRING_VALUE}`, 'g');
  const out = [];
  for (const m of String(text).matchAll(re)) {
    out.push({ line: lineAt(text, m.index), value: unescapeJson(m[1]) });
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/** Signals for a tasks file: one high per `"runOn": "folderOpen"`. */
export function tasksFallback(file, text, rule) {
  const out = [];
  for (const m of String(text).matchAll(/"runOn"\s*:\s*"folderOpen"/g)) {
    out.push({
      rule, severity: 'high', title: 'Task runs automatically when the folder is opened',
      file, line: lineAt(text, m.index), evidence: sanitizeEvidence(`runOn: folderOpen ${NOTE}`), refs: [],
    });
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/** Signal for a settings file that allows automatic tasks. */
export function settingsFallback(file, text, rule) {
  return stringValues(text, 'task.allowAutomaticTasks')
    .filter((v) => v.value === 'on')
    .map((v) => ({
      rule, severity: 'medium', title: 'Workspace allows automatic tasks without prompt',
      file, line: v.line, evidence: sanitizeEvidence(`task.allowAutomaticTasks: on ${NOTE}`), refs: [],
    }));
}

/** Signals for a dev container file: string commands of the given keys. */
export function devcontainerFallback(file, text, rule, keys) {
  const out = [];
  const value = new RegExp(STRING_VALUE, 'y');
  for (const key of keys) {
    let hits = 0;
    for (const m of String(text).matchAll(new RegExp(`"${key}"\\s*:\\s*`, 'g'))) {
      if (++hits > MAX_HITS) break;
      value.lastIndex = m.index + m[0].length;
      const v = value.exec(text);
      const host = key === 'initializeCommand';
      out.push({
        rule, severity: host ? 'high' : 'medium',
        title: host ? 'Dev container command runs on the host before the container starts' : 'Dev container lifecycle command',
        file, line: lineAt(text, m.index), evidence: sanitizeEvidence(`${key}: ${v ? unescapeJson(v[1]) : '(not a plain string)'} ${NOTE}`), refs: [],
      });
    }
  }
  return out;
}
