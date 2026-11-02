// Fingerprint of the published prompt (D-111, D-113). The prompt-injection red team (round 2) measured one exact
// SKILL.md. The release changes only the metadata.version line of the frontmatter: these tests prove that putting the
// old version back gives the measured bytes again, and pin the bytes that are published. Bytes are hashed as read,
// with no encoding and no end-of-line normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './helpers/skill-md.mjs';

const MEASURED_ROUND2_SHA256 = '78a7397a764e7bd3acad74e40644330be13102a46189e2aaf37f72b98bf6c2d4';
const PUBLISHED_SHA256 = '2991dac9142a48ba82285971edffbe870b28dcb9c595da69056c19b1066fc062';
const RELEASE_LINE = '  version: "1.0.0"';
const MEASURED_LINE = '  version: "0.1.0"';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const skillBytes = () => fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'));
const count = (s, needle) => s.split(needle).length - 1;

test('the release version line appears exactly once in SKILL.md', () => {
  const s = skillBytes().toString('latin1');
  assert.equal(count(s, RELEASE_LINE), 1);
  assert.equal(count(s, MEASURED_LINE), 0);
});

test('SKILL.md with the measured version line restored is the prompt measured in red team round 2', () => {
  const s = skillBytes().toString('latin1');
  assert.equal(count(s, RELEASE_LINE), 1);
  const restored = Buffer.from(s.replace(RELEASE_LINE, MEASURED_LINE), 'latin1');
  assert.equal(sha256(restored), MEASURED_ROUND2_SHA256);
});

test('SKILL.md bytes are the published prompt', () => {
  assert.match(PUBLISHED_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(sha256(skillBytes()), PUBLISHED_SHA256);
});
