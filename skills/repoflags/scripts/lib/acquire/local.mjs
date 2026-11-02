// Reads a local folder into memory. Only readdir/lstat/open('r'): nothing from the folder is run or loaded as code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { selectKind, orderByPriority, binaryByFormat } from './select.mjs';
import { readLocalSha } from './git-sha.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { decodeText } from '../util/decode.mjs';
import { AnalyzeError } from '../errors.mjs';

const MAX_NAMED = 20;

async function isDirectory(p) {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** @returns {Promise<{target: object, files: Map<string, object>, notVerified: object[], unread: number, timedOut: boolean, github: null}>} */
export async function acquireLocal(dirPath, ctx) {
  const root = path.resolve(dirPath);
  const files = new Map();
  const notVerified = [];
  const candidates = [];
  let timedOut = false;
  let unread = 0; // selected files not read (limits, errors, timeout)
  const skipped = []; // NP-01: selected files left out by a limit or the timeout, {path, kind}

  const aborted = () => {
    if (ctx.signal && ctx.signal.aborted) timedOut = true;
    return timedOut;
  };

  async function readLimited(full, size) {
    const fh = await fs.open(full, 'r');
    try {
      const buf = Buffer.alloc(size + 1);
      const { bytesRead } = await fh.read(buf, 0, size + 1, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  // Phase 1: list candidates without reading content. Links are never followed.
  async function walk(rel) {
    if (aborted()) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, ...(rel ? rel.split('/') : [])), { withFileTypes: true });
    } catch (e) {
      // The root itself unreadable means nothing can be analyzed: an error, never "no signals" (review CR-04).
      if (!rel) throw new AnalyzeError(`cannot read the target folder: ${e.code ?? 'error'}`);
      notVerified.push({ check: 'walk', reason: `cannot read folder ${sanitizeEvidence(rel)}: ${e.code ?? 'error'}` });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(root, ...r.split('/'));
      let st;
      try {
        st = await fs.lstat(full);
      } catch {
        notVerified.push({ check: 'walk', reason: `cannot stat ${sanitizeEvidence(r)}` });
        continue;
      }
      // On Windows a junction is reported as a symbolic link by lstat (assumption A4).
      if (st.isSymbolicLink()) {
        notVerified.push({ check: 'walk', reason: `symlink not followed: ${sanitizeEvidence(r)}` });
        continue;
      }
      if (st.isDirectory()) {
        await walk(r);
        if (timedOut) return;
        continue;
      }
      if (!st.isFile()) continue;
      const kind = selectKind(r);
      if (kind) candidates.push({ rel: r, full, size: st.size, kind });
    }
  }

  await walk('');

  // Phase 2: admit in priority order so that, under maxFiles, the most important files survive.
  const ordered = orderByPriority(candidates, (c) => c.rel);
  const refused = new Map();
  for (const [i, c] of ordered.entries()) {
    if (aborted()) {
      unread += ordered.length - i;
      for (const s of ordered.slice(i)) skipped.push({ path: s.rel, kind: s.kind });
      break;
    }
    const verdict = ctx.limits.admit(c.rel, c.size, c.kind);
    if (!verdict.ok) {
      if (!refused.has(verdict.reason)) refused.set(verdict.reason, []);
      refused.get(verdict.reason).push(c.rel);
      skipped.push({ path: c.rel, kind: c.kind });
      unread += 1;
      continue;
    }
    try {
      const buf = await readLimited(c.full, c.size);
      if (buf.includes(0)) {
        if (binaryByFormat(c.rel)) {
          notVerified.push({ check: 'binary-files', reason: `${sanitizeEvidence(c.rel)} looks binary, not inspected` });
          continue;
        }
        notVerified.push({ check: 'binary-files', reason: `${sanitizeEvidence(c.rel)} contains NUL bytes: scanned as text anyway` });
      }
      files.set(c.rel, { text: decodeText(buf), size: buf.length });
    } catch (err) {
      unread += 1;
      notVerified.push({ check: 'walk', reason: `cannot read ${sanitizeEvidence(c.rel)}: ${err.code ?? 'error'}` });
    }
  }

  for (const [reason, paths] of refused) {
    const named = paths.slice(0, MAX_NAMED).map((p) => sanitizeEvidence(p)).join(', ');
    const more = paths.length > MAX_NAMED ? ` and ${paths.length - MAX_NAMED} more` : '';
    notVerified.push({ check: 'limits', reason: `${reason}: ${paths.length} files not read: ${named}${more}` });
  }
  if (timedOut) ctx.limits.markReached('globalTimeoutMs');
  if (timedOut) notVerified.push({ check: 'walk', reason: 'global timeout reached: folder only partly read' });

  const gitInfo = await readLocalSha(root);
  if (gitInfo.reason) notVerified.push({ check: 'commit-sha', reason: gitInfo.reason });
  // .git/config (core.fsmonitor, hooksPath, filters...) and .git/hooks can run commands in any git-aware editor:
  // they are not inspected, and the report must say so (review WR-10).
  if (await isDirectory(path.join(root, '.git'))) {
    notVerified.push({ check: 'git-config', reason: '.git/config and .git/hooks were not inspected: commands defined there run with git and git-aware editors' });
  }

  return {
    target: { type: 'local', name: path.basename(root), owner: null, repo: null, ref: gitInfo.ref, sha: gitInfo.sha },
    files,
    notVerified,
    unread,
    skipped,
    timedOut,
    github: null,
  };
}
