// Test helper (not tool code): strict parser for the YAML subset allowed in SKILL.md frontmatter.
// Accepts top-level scalar keys and one level of nested map (`metadata`). It REJECTS everything a real YAML parser
// could read differently (": " or " #" in plain scalars, leading indicators, unterminated quotes, duplicate keys),
// because Claude Code loads a skill with no fields at all, silently, when the frontmatter does not parse.
const KEY = /^([a-z][a-z0-9-]*):[ ]*(.*)$/;
const NESTED = /^ {2}([a-z][a-z0-9_-]*):[ ]*(.*)$/;

function scalar(raw, where) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    // YAML double-quoted is read as a JSON string in this subset.
    if (v.length < 2 || !v.endsWith('"')) throw new Error(`${where}: unterminated double quote`);
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`${where}: invalid double-quoted string`);
    }
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) throw new Error(`${where}: unterminated single quote`);
    return v.slice(1, -1).replaceAll("''", "'");
  }
  // Plain scalar: refuse what YAML would read differently.
  if (/(^|[ ])#|:[ ]|:$|^[[\]{}&*!|>%@`'",]/.test(v)) throw new Error(`${where}: quote this value`);
  return v;
}

export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('frontmatter must start on line 1');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('frontmatter not closed');
  const fields = {};
  let map = null;
  for (const [i, raw] of lines.slice(1, end).entries()) {
    const where = `line ${i + 2}`;
    if (raw.trim() === '') continue;
    const nested = map && NESTED.exec(raw);
    if (nested) {
      if (Object.hasOwn(map, nested[1])) throw new Error(`${where}: duplicate key`);
      map[nested[1]] = scalar(nested[2], where);
      continue;
    }
    const top = KEY.exec(raw);
    if (!top) throw new Error(`${where}: unsupported frontmatter syntax`);
    if (Object.hasOwn(fields, top[1])) throw new Error(`${where}: duplicate key`);
    if (top[2] === '') {
      fields[top[1]] = map = {};
      continue;
    }
    fields[top[1]] = scalar(top[2], where);
    map = null;
  }
  return { fields, body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2 };
}
