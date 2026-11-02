// Remote acquisition without clone (D-06): repo -> commit -> tree -> blobs of the selected files only.
// Everything stays in memory (D-08). Every id received from the API is validated before it enters a URL.
import { AnalyzeError } from '../errors.mjs';
import { createHttp, HttpError, base64BodyCap } from '../util/http.mjs';
import { resolveToken } from './token.mjs';
import { selectKind, orderByPriority, binaryByFormat } from './select.mjs';
import { validGitRef } from './target.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { decodeText } from '../util/decode.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const API = 'https://api.github.com';
const MAX_TREE_REQUESTS = 50;
const CONCURRENCY = 4;
const RATE_RESERVE = 3; // requests kept for repository metadata (plan 01-09)
const MAX_NAMED = 20;
const NOT_FOUND = 'repository not found or no access (private repositories need gh auth login or GH_TOKEN)';
const LOGIN_HINT = 'run gh auth login or set GH_TOKEN for a higher limit';

const enc = encodeURIComponent;
const names = (paths) => {
  const named = paths.slice(0, MAX_NAMED).map((p) => sanitizeEvidence(p)).join(', ');
  return paths.length > MAX_NAMED ? `${named} and ${paths.length - MAX_NAMED} more` : named;
};

async function call(http, url, what, { redirectOk = false } = {}) {
  let res;
  try {
    res = await http.json(url);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    if (e.kind === 'redirect' && redirectOk) throw e;
    if (e.kind === 'rate-limit') throw new AnalyzeError(`GitHub API rate limit reached at ${what}: ${LOGIN_HINT}`);
    throw new AnalyzeError(`GitHub request failed at ${what}: ${e.kind}${e.status ? ` (status ${e.status})` : ''}`);
  }
  if (res.status === 404 || res.status === 403) throw new AnalyzeError(NOT_FOUND);
  if (res.status === 401) throw new AnalyzeError('GitHub rejected the credentials (status 401): check GH_TOKEN or run gh auth login');
  if (res.status !== 200) throw new AnalyzeError(`GitHub answered status ${res.status} at ${what}`);
  return res.body;
}

async function fetchRepo(http, base) {
  try {
    return { info: await call(http, base, 'repository', { redirectOk: true }), base };
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    let url;
    try { url = new URL(e.location ?? '', API); } catch { url = null; }
    const id = url && url.origin === API ? /^\/repositories\/(\d+)$/.exec(url.pathname) : null;
    if (!id || e.status !== 301) throw new AnalyzeError('repository moved to a location that is not followed');
    const moved = `${API}/repositories/${id[1]}`;
    return { info: await call(http, moved, 'repository (moved)'), base: moved };
  }
}

/** Lists all tree entries; with a truncated answer, walks the sub-trees one request at a time (capped). */
async function listTree(http, base, treeSha, notVerified) {
  const first = await call(http, `${base}/git/trees/${treeSha}?recursive=1`, 'tree');
  if (!Array.isArray(first.tree)) throw new AnalyzeError('GitHub returned an unreadable tree');
  if (first.truncated !== true) return first.tree;

  const all = new Map();
  let requests = 0;
  let unvisited = 0;
  const queue = [{ path: '', sha: treeSha }];
  while (queue.length) {
    if (requests >= MAX_TREE_REQUESTS || (http.aborted && http.aborted())) {
      unvisited += queue.length;
      break;
    }
    const dir = queue.shift();
    requests += 1;
    const body = await call(http, `${base}/git/trees/${dir.sha}`, 'tree');
    for (const c of Array.isArray(body.tree) ? body.tree : []) {
      if (!c || typeof c.path !== 'string') continue;
      const path = dir.path ? `${dir.path}/${c.path}` : c.path;
      all.set(path, { ...c, path });
      if (c.type === 'tree' && c.path !== 'node_modules' && c.path !== '.git') {
        if (SHA_RE.test(String(c.sha))) queue.push({ path, sha: c.sha });
        else notVerified.push({ check: 'github-tree', reason: `invalid object id in tree, directory not visited: ${sanitizeEvidence(path)}` });
      }
    }
  }
  if (unvisited) {
    notVerified.push({ check: 'github-tree', reason: `tree too large for one answer: ${unvisited} directories not visited (limit ${MAX_TREE_REQUESTS} tree requests)` });
  }
  return [...all.values()];
}

/** Sorts tree entries into downloadable candidates and declared gaps. */
function classify(entries, ctx, notVerified) {
  const candidates = [];
  const gaps = { symlink: [], submodule: [], badSha: [] };
  const refused = new Map();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string') continue;
    if (e.mode === '160000' || e.type === 'commit') { gaps.submodule.push(e.path); continue; }
    if (e.type !== 'blob') continue;
    const kind = selectKind(e.path);
    if (!kind) continue;
    if (e.mode === '120000') { gaps.symlink.push(e.path); continue; }
    if (!SHA_RE.test(String(e.sha))) { gaps.badSha.push(e.path); continue; }
    candidates.push({ path: e.path, sha: e.sha, size: Number.isFinite(e.size) ? e.size : 0, kind });
  }
  const admitted = [];
  const skipped = []; // NP-01: selected files left out by a limit, {path, kind}
  for (const c of orderByPriority(candidates, (x) => x.path)) {
    const verdict = ctx.limits.admit(c.path, c.size, c.kind);
    if (verdict.ok) { admitted.push(c); continue; }
    if (!refused.has(verdict.reason)) refused.set(verdict.reason, []);
    refused.get(verdict.reason).push(c.path);
    skipped.push({ path: c.path, kind: c.kind });
  }
  for (const [reason, paths] of refused) notVerified.push({ check: 'limits', reason: `${reason}: ${paths.length} files not read: ${names(paths)}` });
  const label = { symlink: 'symlink not followed', submodule: 'submodule not analyzed', badSha: 'invalid object id, not downloaded' };
  for (const [key, paths] of Object.entries(gaps)) {
    if (paths.length) notVerified.push({ check: 'github-tree', reason: `${label[key]} (${paths.length} files): ${names(paths)}` });
  }
  return { admitted, skipped, refused: [...refused.values()].reduce((n, p) => n + p.length, 0) };
}

async function downloadAll(http, base, admitted, ctx, files, notVerified) {
  const lim = ctx.limits.values;
  const state = new Map(); // path -> 'done' | 'rate'
  let next = 0;
  let stop = null;
  let failed = 0;

  async function worker() {
    while (!stop) {
      if (ctx.signal && ctx.signal.aborted) { stop = 'timeout'; return; }
      if (ctx.rate.remaining !== null && ctx.rate.remaining < RATE_RESERVE) { stop = 'rate'; return; }
      const c = admitted[next++];
      if (!c) return;
      const cap = base64BodyCap(c.kind === 'lockfile' ? lim.maxLockfileBytes : lim.maxFileBytes);
      try {
        const res = await http.json(`${base}/git/blobs/${c.sha}`, undefined, cap);
        state.set(c.path, 'done');
        if (res.status !== 200 || res.body.encoding !== 'base64' || typeof res.body.content !== 'string') {
          failed += 1;
          notVerified.push({ check: 'github-blob', reason: `cannot read ${sanitizeEvidence(c.path)}: status ${res.status}` });
          continue;
        }
        const buf = Buffer.from(res.body.content, 'base64');
        if (buf.includes(0) && binaryByFormat(c.path)) {
          notVerified.push({ check: 'binary-files', reason: `${sanitizeEvidence(c.path)} looks binary, not inspected` });
          continue;
        }
        if (buf.includes(0)) notVerified.push({ check: 'binary-files', reason: `${sanitizeEvidence(c.path)} contains NUL bytes: scanned as text anyway` });
        files.set(c.path, { text: decodeText(buf), size: buf.length });
      } catch (e) {
        if (e instanceof HttpError && e.kind === 'rate-limit') { state.set(c.path, 'rate'); stop = 'rate'; return; }
        state.set(c.path, 'done');
        failed += 1;
        const why = e instanceof HttpError ? e.kind : 'error';
        notVerified.push({ check: 'github-blob', reason: `cannot read ${sanitizeEvidence(c.path)}: ${why}` });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, admitted.length) }, worker));

  const left = admitted.filter((c) => state.get(c.path) !== 'done');
  const unread = left.map((c) => c.path);
  if (unread.length) {
    if (stop === 'timeout') ctx.limits.markReached('globalTimeoutMs');
    const why = stop === 'timeout' ? 'global timeout reached' : `GitHub API rate limit reached (${ctx.rate.remaining ?? 'unknown'} requests left)`;
    const hint = stop === 'timeout' ? '' : `; ${LOGIN_HINT}`;
    notVerified.push({ check: stop === 'timeout' ? 'github-timeout' : 'github-rate-limit', reason: `${why}${hint}: ${unread.length} files not read: ${names(unread)}` });
  }
  return { failed: failed + unread.length, left: left.map((c) => ({ path: c.path, kind: c.kind })) };
}

/** @returns {Promise<{target: object, files: Map<string, object>, notVerified: object[], unread: number, github: {repo: object, commit: object}}>} */
export async function acquireGithub({ owner, repo, ref }, ctx) {
  const http = createHttp(ctx);
  http.aborted = () => Boolean(ctx.signal && ctx.signal.aborted);
  const notVerified = [];
  const files = new Map();

  if (!(await resolveToken(ctx))) {
    notVerified.push({ check: 'github-auth', reason: 'anonymous GitHub API access: 60 requests/hour, private repositories not readable' });
  }

  const { info, base } = await fetchRepo(http, `${API}/repos/${enc(owner)}/${enc(repo)}`);
  const wanted = ref ?? info.default_branch;
  if (typeof wanted !== 'string' || !wanted) throw new AnalyzeError('GitHub did not report a default branch');
  if (!validGitRef(wanted)) throw new AnalyzeError('GitHub reported a default branch with an invalid name');
  const commit = await call(http, `${base}/commits/${wanted.split('/').map(enc).join('/')}`, 'commit');

  if (!SHA_RE.test(String(commit.sha))) throw new AnalyzeError('GitHub returned an invalid commit id');
  const treeSha = commit.commit && commit.commit.tree && commit.commit.tree.sha;
  if (!SHA_RE.test(String(treeSha))) throw new AnalyzeError('GitHub returned an invalid tree id');

  const entries = await listTree(http, base, treeSha, notVerified);
  const { admitted, skipped, refused } = classify(entries, ctx, notVerified);
  const { failed, left } = await downloadAll(http, base, admitted, ctx, files, notVerified);

  return {
    target: { type: 'github', name: `${owner}/${repo}`, owner, repo, ref: wanted, sha: commit.sha },
    files,
    notVerified,
    unread: refused + failed,
    skipped: [...skipped, ...left], // timeout and rate limit count too: the file was selected and not read
    github: { repo: info, commit },
  };
}
