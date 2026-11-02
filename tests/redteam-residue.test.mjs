// Tests of the Claude Code residue cleanup (03-03, UF-02, D-84). Only temp fixture folders: the real config folder
// and the real temp area are never touched (configDir and tmpDir are always passed in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug, countFiles, residueDirs, cleanupResidue } from '../scripts/redteam/claude-residue.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'redteam', 'claude-residue.mjs');
const CWD = 'C:\\Users\\x\\AppData\\Local\\Temp\\repoflags-redteam-AbC1';
const SLUG = 'C--Users-x-AppData-Local-Temp-repoflags-redteam-AbC1';

// Review WR-10: the cleanup acts only for OUR temp cwd, so the sandbox cwd lives directly in the sandbox tmpDir with the
// runner's name shape (prefix + 6 characters, like mkdtemp).
function sandbox() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-residue-test-')));
  const tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const cwd = path.join(tmpDir, 'repoflags-redteam-AbC123');
  return { root, configDir: path.join(root, 'cfg'), tmpDir, cwd, slug: projectSlug(cwd), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true });

test('projectSlug: every non alphanumeric character becomes a dash', () => {
  assert.equal(projectSlug(CWD), SLUG);
  assert.equal(projectSlug("a.b'c d"), 'a-b-c-d');
});

test('residueDirs: the two exact folders; a slug over 150 characters -> none, with a reason', () => {
  const r = residueDirs({ cwdReal: CWD, configDir: '/c', tmpDir: '/t' });
  assert.deepEqual(r.dirs, [path.join('/c', 'projects', SLUG), path.join('/t', 'claude', SLUG)]);
  const long = residueDirs({ cwdReal: `C:\\${'a'.repeat(200)}`, configDir: '/c', tmpDir: '/t' });
  assert.deepEqual(long.dirs, []);
  assert.match(long.reason, /150/);
});

test('countFiles: files count, empty folders do not', () => {
  const s = sandbox();
  try {
    mk(s.root, 'a', 'memory'); mk(s.root, 'a', 'b', 'c');
    assert.equal(countFiles(path.join(s.root, 'a')), 0);
    fs.writeFileSync(path.join(s.root, 'a', 'memory', 'x.md'), 'x');
    fs.writeFileSync(path.join(s.root, 'a', 'y.txt'), 'y');
    assert.equal(countFiles(path.join(s.root, 'a')), 2);
  } finally { s.done(); }
});

test('cleanupResidue: empty folders removed, folder with a file kept (names only), sibling intact', () => {
  const s = sandbox();
  try {
    const cfg = path.join(s.configDir, 'projects', s.slug);
    const twin = path.join(s.tmpDir, 'claude', s.slug);
    const sibling = path.join(s.configDir, 'projects', `${s.slug}-other`);
    mk(cfg, 'memory'); mk(twin, 'uuid', 'tasks'); mk(sibling, 'memory');
    const r = cleanupResidue({ cwdReal: s.cwd, configDir: s.configDir, tmpDir: s.tmpDir });
    assert.deepEqual(r.removed.sort(), [cfg, twin].sort());
    assert.deepEqual(r.kept, []);
    assert.equal(fs.existsSync(cfg), false);
    assert.equal(fs.existsSync(twin), false);
    assert.equal(fs.existsSync(sibling), true);

    mk(cfg, 'memory'); fs.writeFileSync(path.join(cfg, 'memory', 'x.md'), 'SECRET-CONTENT');
    const r2 = cleanupResidue({ cwdReal: s.cwd, configDir: s.configDir, tmpDir: s.tmpDir });
    assert.deepEqual(r2.removed, []);
    assert.deepEqual(r2.kept, [{ dir: cfg, files: [path.join('memory', 'x.md')] }]);
    assert.ok(!JSON.stringify(r2).includes('SECRET-CONTENT'));
    assert.equal(fs.existsSync(path.join(cfg, 'memory', 'x.md')), true);
  } finally { s.done(); }
});

test('cleanupResidue: missing folders -> nothing, no error', () => {
  const s = sandbox();
  try {
    assert.deepEqual(cleanupResidue({ cwdReal: s.cwd, configDir: s.configDir, tmpDir: s.tmpDir }), { removed: [], kept: [], skipped: [] });
  } finally { s.done(); }
});

test('cleanupResidue: a symlink in place of the folder is skipped and nothing is removed (injected fs)', () => {
  const removed = [];
  const fakeFs = {
    lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false }),
    readdirSync: () => assert.fail('must not read a symlink'),
    rmSync: (p) => removed.push(p),
  };
  const tmpDir = path.resolve('/t');
  const r = cleanupResidue({ cwdReal: path.join(tmpDir, 'repoflags-redteam-AbC123'), configDir: '/c', tmpDir, fs: fakeFs });
  assert.deepEqual(removed, []);
  assert.equal(r.skipped.length, 2);
  assert.ok(r.skipped.every((x) => /symlink/.test(x.reason)));
});

// Review WR-10 (D-84): cleanupResidue removed <config>/projects/<slug> for ANY cwdReal; called with the real project cwd
// it would delete Claude Code's folder of a real project holding only empty memory/ and tasks/.
test('WR-10: a cwd that is not our temp cwd is refused, even when its residue folders are empty', () => {
  const s = sandbox();
  try {
    const realProject = path.join(s.root, 'work', 'my-project');
    const outside = path.join(s.root, 'repoflags-redteam-AbC123');
    const wrongName = path.join(s.tmpDir, 'repoflags-redteam-AbC1');
    const nested = path.join(s.tmpDir, 'x', 'repoflags-redteam-AbC123');
    for (const cwdReal of [realProject, outside, wrongName, nested, path.join(s.tmpDir, 'repoflags-rt-AbC123')]) {
      const cfg = path.join(s.configDir, 'projects', projectSlug(cwdReal));
      mk(cfg, 'memory'); mk(cfg, 'tasks');
      const r = cleanupResidue({ cwdReal, configDir: s.configDir, tmpDir: s.tmpDir });
      assert.deepEqual(r.removed, [], cwdReal);
      assert.equal(r.skipped.length, 1, cwdReal);
      assert.match(r.skipped[0].reason, /not our temp cwd/, cwdReal);
      assert.equal(fs.existsSync(cfg), true, cwdReal);
    }
  } finally { s.done(); }
});

// Review WR-06: listFiles was outside the try; an EPERM in the finally of runScenario lost the stream of a paid run.
test('WR-06: a folder that cannot be listed is skipped, never thrown', () => {
  const removed = [];
  const fakeFs = {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    readdirSync: () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; },
    rmSync: (p) => removed.push(p),
  };
  const tmpDir = path.resolve('/t');
  const r = cleanupResidue({ cwdReal: path.join(tmpDir, 'repoflags-redteam-AbC123'), configDir: '/c', tmpDir, fs: fakeFs });
  assert.deepEqual(removed, []);
  assert.equal(r.skipped.length, 2);
  assert.ok(r.skipped.every((x) => /cannot list: EPERM/.test(x.reason)), JSON.stringify(r.skipped));
});

test('cleanupResidue: an over-long slug removes nothing and says why', () => {
  const r = cleanupResidue({ cwdReal: `C:\\${'a'.repeat(200)}`, configDir: '/c', tmpDir: '/t', fs: { lstatSync: () => assert.fail('no access') } });
  assert.equal(r.removed.length, 0);
  assert.equal(r.skipped.length, 1);
});

// Review WR-10: the source check used to forbid the guard itself (no "repoflags-" at all). Tightened: the guard MUST be
// there, as the one exact anchored name pattern; still no glob, no settings, no prefix comparison, no retry, and
// readdirSync only once (listFiles, inside the exact folder).
test('source: exact-name guard present; no pattern matching, no listing of projects/, no settings, no prefix comparison, no retry loop', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /glob|settings/i);
  assert.equal((src.match(/repoflags-/g) ?? []).length, 1, 'one occurrence only: the guard');
  assert.ok(src.includes('/^repoflags-redteam-[A-Za-z0-9]{6}$/'), 'the anchored guard on the basename of our cwd');
  assert.doesNotMatch(src, /retry|attempt/i);
  assert.doesNotMatch(src, /startsWith|endsWith/);
  assert.equal((src.match(/readdirSync\(/g) ?? []).length, 1);
});
