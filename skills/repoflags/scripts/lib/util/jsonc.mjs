// Defensive JSONC parser: strips comments and trailing commas, then JSON.parse. Never throws.
// JSON.parse defines "__proto__" as an own property (no setter call), so no prototype pollution;
// consumers must still read values with Object.hasOwn.

/** Pass 1: removes // and block comments outside strings (comments become a single space). */
function stripComments(text) {
  let out = '';
  let from = 0;
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 2;
      else { if (c === '"') inString = false; i++; }
      continue;
    }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      out += text.slice(from, i) + ' ';
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      from = i;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('unterminated block comment');
      out += text.slice(from, i) + ' ';
      i = end + 2;
      from = i;
      continue;
    }
    i++;
  }
  if (inString) throw new SyntaxError('unterminated string');
  return out + text.slice(from);
}

/** Pass 2: drops a comma followed only by whitespace and then } or ] (linear, string-aware). */
function stripTrailingCommas(text) {
  const parts = [];
  let from = 0;
  let pending = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if ((c === '}' || c === ']') && pending !== -1) {
      parts.push(text.slice(from, pending));
      from = pending + 1;
    }
    pending = c === ',' ? i : -1;
    if (c === '"') inString = true;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

import { stripBom } from './decode.mjs';

/** @returns {{ok: true, value: any} | {ok: false, error: string}} */
export function parseJsonc(text) {
  try {
    const src = stripBom(text);
    if (src.trim() === '') return { ok: false, error: 'empty input' };
    return { ok: true, value: JSON.parse(stripTrailingCommas(stripComments(src))) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

/** 1-based line of the first `"key"` followed by `:` (from `fromLine`), or null. No regex from input. */
export function findKeyLine(text, key, fromLine = 1) {
  const needle = `"${key}"`;
  const lines = String(text).split('\n');
  for (let i = Math.max(0, fromLine - 1); i < lines.length; i++) {
    let at = lines[i].indexOf(needle);
    while (at !== -1) {
      let j = at + needle.length;
      while (lines[i][j] === ' ' || lines[i][j] === '\t') j++;
      if (lines[i][j] === ':') return i + 1;
      at = lines[i].indexOf(needle, at + 1);
    }
  }
  return null;
}
