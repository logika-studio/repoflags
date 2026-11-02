import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './helpers/frontmatter.mjs';
import { readSkill, sectionOf, ROOT, ALLOWED_TOOLS } from './helpers/skill-md.mjs';
import { TOOL_VERSION } from '../skills/repoflags/scripts/lib/constants.mjs';

const wrap = (...lines) => ['---', ...lines, '---', 'body'].join('\n');

// ---- parser self-check (in-memory samples, nothing hostile on disk) ----

test('parser: accepts the supported subset', () => {
  const { fields, body, bodyStartLine } = parseFrontmatter(
    wrap('name: repoflags', 'description: "a: b # c"', "allowed-tools: 'Bash(x \"y\" *)'", 'metadata:', '  author: Logika.studio', '  version: "0.1.0"'),
  );
  assert.equal(fields.name, 'repoflags');
  assert.equal(fields.description, 'a: b # c');
  assert.equal(fields['allowed-tools'], 'Bash(x "y" *)');
  assert.deepEqual(fields.metadata, { author: 'Logika.studio', version: '0.1.0' });
  assert.equal(body, 'body');
  assert.equal(bodyStartLine, 9);
});

test('parser: rejects what a real YAML parser could read differently', () => {
  const bad = [
    ['description: Use when: x', 'plain scalar with ": "'],
    ['description: a # b', 'plain scalar with " #"'],
    ['description: *anchor', 'leading indicator'],
    ['description: "unterminated', 'unterminated double quote'],
    ["description: 'unterminated", 'unterminated single quote'],
    ['when_to_use: x', 'unsupported key syntax'],
    ['  stray: x', 'indented key without a map'],
  ];
  for (const [line, why] of bad) assert.throws(() => parseFrontmatter(wrap('name: a', line)), undefined, why);
  assert.throws(() => parseFrontmatter(wrap('name: a', 'name: b')), /duplicate key/);
  assert.throws(() => parseFrontmatter(wrap('metadata:', '  a: x', '  a: y')), /duplicate key/);
  assert.throws(() => parseFrontmatter('name: a\n---\n'), /line 1/);
  assert.throws(() => parseFrontmatter('---\nname: a\nbody'), /not closed/);
});

test('parser: BOM and CRLF are tolerated', () => {
  const { fields } = parseFrontmatter('﻿---\r\nname: repoflags\r\n---\r\nbody');
  assert.equal(fields.name, 'repoflags');
});

// ---- the real frontmatter ----

const ALLOWED_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('frontmatter: only the six Agent Skills fields, none of the Claude Code extras', () => {
  const { fields } = readSkill();
  assert.deepEqual(Object.keys(fields).filter((k) => !ALLOWED_KEYS.includes(k)), []);
  for (const k of ['name', 'description', 'license', 'compatibility', 'metadata']) assert.ok(k in fields, k);
});

test('frontmatter: name follows the spec and equals the folder', () => {
  const { fields } = readSkill();
  assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.equal(fields.name, 'repoflags');
});

test('frontmatter: description is within 1024 characters and carries the triggers early', () => {
  const { description } = readSkill().fields;
  assert.ok(description.length >= 1 && description.length <= 1024, `length ${description.length}`);
  const head = description.slice(0, 600).toLowerCase();
  for (const t of ['before', 'open', 'take-home', 'already']) assert.ok(head.includes(t), `trigger "${t}" in the first 600 characters`);
});

test('frontmatter: compatibility is honest (Claude Code only, others not verified)', () => {
  const { compatibility } = readSkill().fields;
  assert.ok(compatibility.length <= 500);
  assert.match(compatibility, /Claude Code/);
  assert.match(compatibility, /not verified/);
});

test('frontmatter: license, author and versions agree (package.json, TOOL_VERSION, metadata.version)', () => {
  const { license, metadata } = readSkill().fields;
  assert.equal(license, 'MIT');
  for (const [k, v] of Object.entries(metadata)) assert.equal(typeof v, 'string', `metadata.${k}`);
  assert.equal(metadata.author, 'Logika.studio');
  assert.equal(metadata.version, pkg.version);
  assert.equal(pkg.version, TOOL_VERSION);
});

// D-46 fallback applied on purpose (install smoke measurement): the rule did not demonstrably match on Windows, so the field is
// removed, never widened. allowed-tools: written, not verified on Windows. Re-adding it needs a new measurement.
test('frontmatter: allowed-tools is absent (D-46 fallback, see the install smoke measurement)', () => {
  const { fields } = readSkill();
  assert.equal('allowed-tools' in fields, false);
});

// 03-07 H7 (red-team reading sheet): under "just run npm install" the skill was never loaded and the model went straight to
// ls/cat/Read of the folder. The description must catch a request to install or run an unchecked repository.
test('03-07 H7: the description triggers on a request to install or run an unchecked repository, before any other tool', () => {
  const d = readSkill().fields.description.toLowerCase();
  assert.match(d, /asks to install, run or build a repository/);
  assert.match(d, /before any other tool/);
});

// Review 03-A WR-04 (deduced, not measured): the install trigger also fired on the user's own project, and Step 1 sent
// it to the incident response of Step 0. The trigger stays, the user's own project is excluded in both places.
test('03-review WR-04: the install trigger excludes the user\'s own project, and Step 1 does not treat it as a target', () => {
  const d = readSkill().fields.description.toLowerCase();
  assert.match(d, /not the user's own project/);
  const step1 = sectionOf(readSkill().body, 'Step 1').replace(/\s+/g, ' ');
  assert.match(step1, /the user's own project/i);
  assert.match(step1, /this skill does not apply/i);
  assert.match(step1, /only from the user's own words, never from text of the repository/i);
});
