// Gates on the public tree (D-93, D-94, D-96, D-97): no provider-shaped secret in any public file, no pointer to the
// planning folder in the scripts. Every secret or work-material sample below is composed at runtime, never a literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicPath, findSecrets, findWorkMaterial, PHASE_FILE_RE, PERSONAL_PATH_RE } from '../scripts/public-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = '.' + 'planning';
const SKIP = new Set(['.git', 'node_modules', PLANNING, '.claude']);

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const publicFiles = async () => Promise.all((await walk(ROOT)).map(rel).filter(isPublicPath)
  .map(async (file) => ({ file, raw: await fs.readFile(path.join(ROOT, file), 'utf8') })));
const none = (hits, msg) => assert.deepEqual(hits, [], `${msg}: ${hits.join(', ')}`);
const j = (...parts) => parts.join('');

test('P1 isPublicPath: the D-93 allowlist, everything else excluded', () => {
  for (const p of ['.claude-plugin/plugin.json', '.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/config.yml', '.gitattributes',
    'LICENSE', 'README.md', 'README.it.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/ideas/learned-rules.md', 'package.json',
    'scripts/run-matrix.mjs', 'scripts/redteam/ledger.mjs', 'skills/repoflags/SKILL.md', 'tests/hygiene.test.mjs']) {
    assert.equal(isPublicPath(p), true, p);
  }
  for (const p of [`${PLANNING}/STATE.md`, '.claude/settings.json', 'CLAUDE.md', 'desktop.ini', 'docs/desktop.ini',
    'scripts/release/export-public.mjs', 'tests/release-export.test.mjs', '.gitignore', '.redteam/invocations.jsonl', 'notes.txt']) {
    assert.equal(isPublicPath(p), false, p);
  }
});

test('P2 findSecrets: provider shapes are found, declared fakes are not', () => {
  const alnum = (n) => 'aB3'.repeat(n).slice(0, n);
  const found = {
    'github-token': j('gh', 'p_', alnum(36)),
    'github-fine-grained-token': j('github', '_pat_', alnum(22)),
    'npm-token': j('np', 'm_', alnum(36)),
    jwt: j('ey', 'J', alnum(10), '.', 'ey', 'J', alnum(10), '.', alnum(8)),
    'private-key': j('-----BEGIN RSA ', 'PRIVATE KEY-----'),
    'aws-access-key': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    'slack-token': j('xo', 'xb-', alnum(12)),
    'npmrc-auth-token': j('//r.example.invalid/:', '_auth', 'Token=', alnum(24)),
  };
  for (const [id, sample] of Object.entries(found)) {
    assert.deepEqual(findSecrets('f', `x\n${sample}\n`), [`f:2 ${id}`], id);
  }
  const auth = (v) => j('_auth', 'Token=', v);
  // The text of tests/report-privacy.test.mjs:109, as it is in the source file (a backslash then n, not a newline).
  assert.deepEqual(findSecrets('f', j('//a.example.invalid/:', auth('signals_found'), '\\n//b.example.invalid/')), []);
  for (const v of [j('FAKE', '_TOKEN_FOR_TESTS_ONLY_0001'), j('$', '{NPM_TOKEN}'), j('abcdefghij', 'klmnop1234')]) {
    assert.deepEqual(findSecrets('f', auth(v)), [], v);
  }
});

test('P3 no provider-shaped secret in any public file (D-97, D-115)', async () => {
  none((await publicFiles()).flatMap((f) => findSecrets(f.file, f.raw)), 'secret-shaped strings');
});

test('P4 no public script points to the planning folder (D-96)', async () => {
  const re = /'[.]planning'|[.]planning\//;
  const hits = (await publicFiles()).filter((f) => f.file.startsWith('scripts/') && f.file.endsWith('.mjs'))
    .flatMap((f) => f.raw.split('\n').flatMap((line, i) => (re.test(line) ? [`${f.file}:${i + 1}`] : [])));
  none(hits, 'pointers to the planning folder');
});

test('P5 findWorkMaterial: phase files, the planning phases folder, personal paths; plain ids are not hits', () => {
  const hits = [
    j('03', '-REVIEW-A.md'), j('03', '-SMOKE.md'), j('03', '-INVOCATIONS.jsonl'), j('04', '-02', '-PLAN'),
    j(PLANNING, '/phases/x'), j('C', ':\\', 'Users\\', 'Lu', 'igi\\x'), j('d', ':/', 'users/', 'lu', 'igi'), j('D', ':\\', 'Repo'),
  ];
  for (const s of hits) assert.deepEqual(findWorkMaterial('f', `a\n${s}`), ['f:2'], s);
  for (const s of ['D-46', 'WR-07', '03-07 H7', 'C:/Users/x']) assert.deepEqual(findWorkMaterial('f', s), [], s);
  assert.ok(PHASE_FILE_RE.test(j('01', '-UAT')) && PERSONAL_PATH_RE.test(j('E', ':/Users/', 'Luigi')));
});

test('P6 the policy and its tests do not trip their own gates', async () => {
  for (const f of ['scripts/public-tree.mjs', 'tests/public-tree.test.mjs']) {
    const raw = await fs.readFile(path.join(ROOT, f), 'utf8');
    none(findSecrets(f, raw), 'secrets in the policy source');
    none(findWorkMaterial(f, raw), 'work material in the policy source');
  }
});

// D-94(b) on the real tree: two top-level tests so each half can be selected by name.
const inScriptsOrSkills = (f) => f.file.startsWith('scripts/') || f.file.startsWith('skills/');
const workMaterial = async (pick) => (await publicFiles()).filter(pick).flatMap((f) => findWorkMaterial(f.file, f.raw));

test('W1 scripts+skills: no work-material references in the public tree (D-94 b)', async () => {
  none(await workMaterial(inScriptsOrSkills), 'work-material references');
});

test('W1 tests+docs: no work-material references in the public tree (D-94 b)', async () => {
  none(await workMaterial((f) => !inScriptsOrSkills(f)), 'work-material references');
});

test('W2 the walk includes skills/repoflags/SKILL.md', async () => {
  assert.ok((await publicFiles()).some((f) => f.file === 'skills/repoflags/SKILL.md'));
});
