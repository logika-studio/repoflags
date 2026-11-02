// Cleanup of the folders Claude Code leaves behind for the red team cwd (03-03, UF-02, D-84). Measured (red-team research, §2):
// <config>/projects/<slug> and <tmp>/claude/<slug> hold empty memory/ and tasks/ folders only. Guards: exact folder
// name from the slug of OUR cwd, no pattern matching, no listing of the parent folders, symlinks refused, and a folder
// holding any file is never removed (only the file names are reported, never the content).
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SLUG = 150; // A3 (assumed): longer slugs are shortened by Claude Code in a way not reproduced here -> fail closed

/** Slug of an already resolved cwd (realpathSync.native, computed by the caller BEFORE the cwd is removed). */
export const projectSlug = (cwdReal) => String(cwdReal).replace(/[^A-Za-z0-9]/g, '-');

/** The two exact folders for a cwd; { dirs: [], reason } when the slug is too long. */
export function residueDirs({ cwdReal, configDir, tmpDir }) {
  const slug = projectSlug(cwdReal);
  if (slug.length > MAX_SLUG) return { dirs: [], reason: `slug longer than ${MAX_SLUG} characters: not reproduced, nothing removed` };
  return { dirs: [path.join(configDir, 'projects', slug), path.join(tmpDir, 'claude', slug)] };
}

/** Relative names of files and symlinks under dir, recursively. Empty folders contribute nothing. */
export function listFiles(dir, fs = nodeFs, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...listFiles(path.join(dir, e.name), fs, r));
    else out.push(r);
  }
  return out;
}

export const countFiles = (dir, fs = nodeFs) => listFiles(dir, fs).length;

/** Defaults for the real run. A3 (assumed): Claude Code keeps its projects folder under CLAUDE_CONFIG_DIR, else ~/.claude. */
export function defaultResidueDirs() {
  return { configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), tmpDir: os.tmpdir() };
}

const OWN_CWD_NAME = /^repoflags-redteam-[A-Za-z0-9]{6}$/;
const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/** Review WR-10 (D-84): only the cwd the runner created (mkdtemp name, directly in tmpDir) has residue to clean. */
export function isOwnTempCwd(cwdReal, tmpDir, fs = nodeFs) {
  if (typeof cwdReal !== 'string' || !tmpDir || !OWN_CWD_NAME.test(path.basename(cwdReal))) return false;
  let tmpReal = tmpDir;
  try { tmpReal = fs.realpathSync?.native ? fs.realpathSync.native(tmpDir) : tmpDir; } catch { /* compare the given form */ }
  return fold(path.dirname(cwdReal)) === fold(tmpReal);
}

/** Removes the residue folders that hold no file. Returns { removed, kept: [{ dir, files }], skipped: [{ dir, reason }] }. */
export function cleanupResidue({ cwdReal, configDir, tmpDir, fs = nodeFs }) {
  const result = { removed: [], kept: [], skipped: [] };
  if (!isOwnTempCwd(cwdReal, tmpDir, fs)) {
    result.skipped.push({ dir: null, reason: 'not our temp cwd (D-84): nothing removed' });
    return result;
  }
  const { dirs, reason } = residueDirs({ cwdReal, configDir, tmpDir });
  if (reason) { result.skipped.push({ dir: null, reason }); return result; }
  for (const dir of dirs) {
    let st;
    try { st = fs.lstatSync(dir); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      result.skipped.push({ dir, reason: `cannot inspect: ${error?.code ?? 'error'}` });
      continue;
    }
    if (st.isSymbolicLink()) { result.skipped.push({ dir, reason: 'symlink: refused' }); continue; }
    if (!st.isDirectory()) { result.skipped.push({ dir, reason: 'not a directory: refused' }); continue; }
    let files;
    try { files = listFiles(dir, fs); } catch (error) {
      result.skipped.push({ dir, reason: `cannot list: ${error?.code ?? 'error'}` });
      continue;
    }
    if (files.length > 0) { result.kept.push({ dir, files }); continue; }
    try { fs.rmSync(dir, { recursive: true }); result.removed.push(dir); } catch (error) {
      result.skipped.push({ dir, reason: `removal failed: ${error?.code ?? 'error'}` });
    }
  }
  return result;
}
