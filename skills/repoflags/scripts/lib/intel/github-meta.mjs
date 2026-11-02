// DET-08: repository metadata, reported as plain facts about the repository and the commit (D-17).
// Never about people (G8): no login, name or email is written into a signal; only dates, account type and counts.
import { createHttp } from '../util/http.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

export const CHECK = 'repo-metadata';

const API = 'https://api.github.com';
const TITLE = 'Repository metadata (informational)';
const DAY_MS = 86400000;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TYPE_RE = /^[A-Za-z]{1,20}$/;
const LAST_RE = /<([^>]+)>\s*;\s*rel="last"/;

const info = (evidence) => ({ rule: 'repo-metadata', severity: 'info', title: TITLE, file: null, line: null, evidence: sanitizeEvidence(evidence), refs: [] });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const days = (from, to) => Math.floor((to - from) / DAY_MS);

function lastPage(link) {
  const m = typeof link === 'string' ? LAST_RE.exec(link) : null;
  if (!m) return null;
  let u;
  try { u = new URL(m[1]); } catch { return null; }
  const page = Number(u.searchParams.get('page'));
  return Number.isInteger(page) && page >= 1 ? { url: u.href, count: page } : null;
}

/** Compares author/committer dates of one commit with the repository creation time. */
function compare(which, commit, createdMs, signals, notVerified) {
  for (const kind of ['author', 'committer']) {
    const raw = commit && commit.commit && commit.commit[kind] ? commit.commit[kind].date : undefined;
    const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (Number.isNaN(ms)) {
      notVerified.push({ check: CHECK, reason: `${which} commit ${kind} date missing or unparseable` });
      continue;
    }
    if (ms < createdMs) {
      signals.push(info(`commit dated before repository creation (${which} commit, ${kind} date ${new Date(ms).toISOString()}, repository created ${new Date(createdMs).toISOString()})`));
    }
  }
}

export async function run(input, ctx) {
  const gh = input.acquired && input.acquired.github;
  if (!gh || !gh.repo) return { signals: [], notVerified: [{ check: CHECK, reason: 'no GitHub metadata available for this target' }] };

  const signals = [];
  const notVerified = [];
  const http = createHttp(ctx);
  const nowMs = ctx.now().getTime();
  const { target } = input.acquired;

  const createdMs = typeof gh.repo.created_at === 'string' ? Date.parse(gh.repo.created_at) : NaN;
  if (Number.isNaN(createdMs)) {
    notVerified.push({ check: CHECK, reason: 'repository creation date missing or unparseable' });
  } else {
    signals.push(info(`repository created ${plural(days(createdMs, nowMs), 'day')} before analysis`));
  }

  const login = gh.repo.owner && typeof gh.repo.owner.login === 'string' ? gh.repo.owner.login : target.owner;
  if (LOGIN_RE.test(String(login))) {
    try {
      const res = await http.json(`${API}/users/${encodeURIComponent(login)}`);
      const ownerMs = res.status === 200 && res.body && typeof res.body.created_at === 'string' ? Date.parse(res.body.created_at) : NaN;
      const type = res.body && typeof res.body.type === 'string' && TYPE_RE.test(res.body.type) ? res.body.type : null;
      if (Number.isNaN(ownerMs) || !type) notVerified.push({ check: CHECK, reason: 'owner account data unavailable' });
      else signals.push(info(`owner account (type ${type}) created ${plural(days(ownerMs, nowMs), 'day')} before analysis`));
    } catch {
      notVerified.push({ check: CHECK, reason: 'owner account data unavailable' });
    }
  } else {
    notVerified.push({ check: CHECK, reason: 'owner account data unavailable' });
  }

  let count = null;
  let oldest = null;
  try {
    const o = encodeURIComponent(target.owner);
    const r = encodeURIComponent(target.repo);
    const res = await http.json(`${API}/repos/${o}/${r}/commits?per_page=1&sha=${encodeURIComponent(target.sha)}`);
    if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) throw new Error('shape');
    const last = lastPage(res.headers.get('link'));
    count = last ? last.count : 1;
    oldest = last ? null : gh.commit;
    if (last) {
      try {
        const lastRes = await http.json(last.url);
        if (lastRes.status === 200 && Array.isArray(lastRes.body) && lastRes.body.length > 0) oldest = lastRes.body[lastRes.body.length - 1];
        else notVerified.push({ check: CHECK, reason: 'oldest commit unavailable' });
      } catch {
        notVerified.push({ check: CHECK, reason: 'oldest commit unavailable' });
      }
    }
  } catch {
    notVerified.push({ check: CHECK, reason: 'commit count unavailable' });
  }
  if (count !== null) signals.push(info(`${plural(count, 'commit')} reachable from the analyzed commit`));

  if (!Number.isNaN(createdMs)) {
    compare('head', gh.commit, createdMs, signals, notVerified);
    if (oldest && oldest !== gh.commit) compare('oldest', oldest, createdMs, signals, notVerified);
  }
  return { signals, notVerified };
}
