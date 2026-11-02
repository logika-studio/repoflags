// Install domain (D-43, D-65): plugin and marketplace manifests are consistent with the package and the skill.
// Manifests are validated statically here; nothing is installed into any real Claude Code configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readSkill } from './helpers/skill-md.mjs';
import { TOOL_VERSION } from '../skills/repoflags/scripts/lib/constants.mjs';

const rawText = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const readJson = (...p) => JSON.parse(rawText(...p));
const plugin = () => readJson('.claude-plugin', 'plugin.json');
const market = () => readJson('.claude-plugin', 'marketplace.json');

test('plugin and marketplace manifests are valid JSON with the expected names', () => {
  assert.equal(plugin().name, 'repoflags');
  assert.equal(market().name, 'logika-studio');
  assert.equal(market().plugins.length, 1);
  assert.equal(market().plugins[0].name, plugin().name);
  assert.equal(market().plugins[0].source, './');
});

test('manifests do not replicate the default skills location', () => {
  assert.equal('skills' in plugin(), false);
  assert.equal('skills' in market().plugins[0], false);
});

test('marketplace name is not a reserved prefix', () => {
  assert.doesNotMatch(market().name, /^(claude-|anthropic-|official-)/i);
});

test('versions agree: plugin.json = package.json = TOOL_VERSION = SKILL.md metadata.version', () => {
  const pkg = readJson('package.json').version;
  const skillVersion = readSkill().fields.metadata.version;
  assert.equal(plugin().version, pkg);
  assert.equal(plugin().version, TOOL_VERSION);
  assert.equal(plugin().version, skillVersion);
});

test('D-110: release 1.0.0, no version in the marketplace entry, package stays private', () => {
  assert.equal(plugin().version, '1.0.0');
  assert.equal('version' in market().plugins[0], false);
  assert.equal(readJson('package.json').private, true);
});

test('author and owner are Logika.studio with the team email', () => {
  for (const who of [plugin().author, market().owner]) {
    assert.equal(who.name, 'Logika.studio');
    assert.equal(who.email, 'tech-area@logikastudio.it');
  }
});

test('manifests never contain the word "safe" (G7)', () => {
  assert.doesNotMatch(rawText('.claude-plugin', 'plugin.json'), /safe/i);
  assert.doesNotMatch(rawText('.claude-plugin', 'marketplace.json'), /safe/i);
});

test('SKILL.md has an Install section after Step 3 with both install modes (D-43)', () => {
  const { body, codeBlocks } = readSkill();
  const step3 = body.indexOf('## Step 3');
  const install = body.indexOf('## Install');
  assert.ok(step3 >= 0 && install > step3, 'Install section must follow Step 3');
  const lines = codeBlocks.flatMap((b) => b.lines.map((l) => l.text.trim()));
  assert.ok(lines.includes('/plugin marketplace add logika-studio/repoflags'));
  assert.ok(lines.includes('/plugin install repoflags@logika-studio'));
  const section = body.slice(install);
  assert.match(section, /~\/\.claude\/skills\/repoflags\//);
  assert.match(section, /not yet verified/i);
  assert.ok(section.trimEnd().split('\n').length <= 25, 'Install section must stay within 25 lines');
});
