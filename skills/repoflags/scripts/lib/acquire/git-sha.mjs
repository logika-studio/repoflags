// Reads the commit SHA of a local clone as plain text. Never runs git: .git/config may define
// core.fsmonitor or hooks, so .git/config is deliberately never read and no process is started (D-11).
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const none = (reason) => ({ sha: null, ref: null, reason });

async function readText(file) {
  const st = await fs.lstat(file);
  if (st.isSymbolicLink() || !st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'NOTREG' });
  if (st.size > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'TOOBIG' });
  return fs.readFile(file, 'utf8');
}

/**
 * T-01-18 (review core IN-04): every folder between .git and the file is lstat-ed too, so a junction or symlink at
 * .git/refs or .git/refs/heads cannot make the read land outside .git.
 */
async function readInGit(gitDir, segments) {
  let dir = gitDir;
  for (const seg of segments.slice(0, -1)) {
    dir = path.join(dir, seg);
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error('link or non-folder inside .git'), { code: 'NOTREG' });
  }
  return readText(path.join(dir, segments[segments.length - 1]));
}

function validRef(ref) {
  return REF_RE.test(ref) && !ref.split('/').some((s) => s === '..' || s === '.' || s === '') && ref.startsWith('refs/');
}

/** @returns {Promise<{sha: string|null, ref: string|null, reason: string|null}>} */
export async function readLocalSha(dirPath) {
  const gitDir = path.join(path.resolve(dirPath), '.git');
  let st;
  try {
    st = await fs.lstat(gitDir);
  } catch {
    return none('no .git directory (zip or copy): commit SHA not available');
  }
  if (st.isSymbolicLink() || st.isFile()) return none('worktree or submodule .git file not followed');
  if (!st.isDirectory()) return none('.git is not a directory: commit SHA not available');

  let head;
  try {
    head = (await readText(path.join(gitDir, 'HEAD'))).trim();
  } catch (e) {
    return none(`.git/HEAD not readable as a regular file: ${e.code ?? 'error'}`);
  }
  if (SHA_RE.test(head)) return { sha: head, ref: null, reason: null };

  const m = head.match(/^ref:\s*(\S+)$/);
  if (!m || !validRef(m[1])) return none('.git/HEAD is malformed or names an invalid ref');
  const full = m[1];
  const short = full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : full;

  try {
    const loose = (await readInGit(gitDir, full.split('/'))).trim();
    if (SHA_RE.test(loose)) return { sha: loose, ref: short, reason: null };
    return none('ref file does not contain a valid commit SHA');
  } catch (e) {
    if (e.code !== 'ENOENT') return none(`ref file not readable: ${e.code ?? 'error'}`);
  }

  try {
    const packed = await readText(path.join(gitDir, 'packed-refs'));
    for (const line of packed.split(/\r?\n/)) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const [sha, name] = line.split(' ');
      if (name === full && SHA_RE.test(sha)) return { sha, ref: short, reason: null };
    }
  } catch {
    // fall through to the generic reason
  }
  return none('commit SHA of the current ref not found in refs/ or packed-refs');
}
