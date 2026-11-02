// Builds fake GitHub REST routes for makeFakeFetch. Content only lives in memory (never on disk).
import { createHash } from 'node:crypto';

const API = 'https://api.github.com';

export function blobSha(content) {
  return createHash('sha1').update(String(content)).digest('hex');
}
function treeShaOf(dirPath) {
  return createHash('sha1').update(`tree:${dirPath}`).digest('hex');
}

/**
 * @param {object} spec
 * @param {string} spec.owner
 * @param {string} spec.repo
 * @param {string} [spec.ref]            ref used in /commits/{ref}; default 'main'
 * @param {string} [spec.defaultBranch]  default_branch of /repos; default = ref
 * @param {string} spec.sha              commit sha (may be invalid on purpose)
 * @param {string} [spec.treeSha]        root tree sha (may be invalid on purpose)
 * @param {Record<string,string>} spec.files path -> content
 * @param {Array<object>} [spec.entries] extra raw tree entries (symlinks, submodules, bad shas)
 * @param {Record<string,number>} [spec.sizes] path -> size override
 * @param {boolean} [spec.truncated]     recursive answer carries only the root level, with truncated: true
 * @param {number} [spec.rateStart]      starting x-ratelimit-remaining (default 5000)
 */
export function buildGithubRoutes(spec) {
  const {
    owner, repo, sha, files = {}, entries = [], sizes = {}, truncated = false,
    createdAt = '2020-01-01T00:00:00Z', pushedAt = '2026-10-01T00:00:00Z',
    ownerType = 'User', ownerCreatedAt = '2019-01-01T00:00:00Z', commitCount = 1,
    headAuthorDate = '2026-10-01T00:00:00Z', headCommitterDate = '2026-10-01T00:00:00Z',
    oldestAuthorDate = '2020-01-01T00:00:00Z', oldestCommitterDate = '2020-01-01T00:00:00Z',
  } = spec;
  const ref = spec.ref ?? 'main';
  const base = `${API}/repos/${owner}/${repo}`;
  const rootTreeSha = spec.treeSha ?? treeShaOf('');
  let remaining = spec.rateStart ?? 5000;
  const rate = () => ({ 'x-ratelimit-remaining': String(--remaining), 'x-ratelimit-reset': '1900000000' });
  const withRate = (route) => Object.defineProperty(route, 'headers', { get: rate, enumerable: true });

  // nested structure: dir path -> { blobs: [name], dirs: [name] }
  const dirs = new Map([['', { blobs: [], dirs: new Set() }]]);
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
      const parent = parts.slice(0, i).join('/');
      const here = parts.slice(0, i + 1).join('/');
      if (!dirs.has(here)) dirs.set(here, { blobs: [], dirs: new Set() });
      dirs.get(parent).dirs.add(parts[i]);
    }
    dirs.get(parts.slice(0, -1).join('/')).blobs.push(parts[parts.length - 1]);
  }
  const blobEntry = (p) => ({ path: p, mode: '100644', type: 'blob', sha: blobSha(files[p]), size: sizes[p] ?? Buffer.byteLength(files[p]) });
  const dirEntry = (p) => ({ path: p, mode: '040000', type: 'tree', sha: treeShaOf(p) });

  const routes = {};
  routes[`GET ${base}`] = withRate({
    json: { full_name: `${owner}/${repo}`, private: false, default_branch: spec.defaultBranch ?? ref, created_at: createdAt, pushed_at: pushedAt, owner: { login: owner, type: ownerType } },
  });
  routes[`GET ${base}/commits/${ref}`] = withRate({
    json: { sha, commit: { tree: { sha: rootTreeSha }, author: { date: headAuthorDate }, committer: { date: headCommitterDate } } },
  });

  const flat = [...Object.keys(files).map(blobEntry), ...[...dirs.keys()].filter(Boolean).map(dirEntry), ...entries];
  const rootLevel = [...dirs.get('').blobs.map((n) => blobEntry(n)), ...[...dirs.get('').dirs].map((n) => dirEntry(n)), ...entries.filter((e) => !e.path.includes('/'))];
  routes[`GET ${base}/git/trees/${rootTreeSha}?recursive=1`] = withRate({ json: { sha: rootTreeSha, truncated, tree: truncated ? rootLevel : flat } });
  routes[`GET ${base}/git/trees/${rootTreeSha}`] = withRate({ json: { sha: rootTreeSha, truncated: false, tree: rootLevel } });
  for (const [dirPath, node] of dirs) {
    if (!dirPath) continue;
    const children = [
      ...node.blobs.map((n) => ({ ...blobEntry(`${dirPath}/${n}`), path: n })),
      ...[...node.dirs].map((n) => ({ ...dirEntry(`${dirPath}/${n}`), path: n })),
    ];
    routes[`GET ${base}/git/trees/${treeShaOf(dirPath)}`] = withRate({ json: { sha: treeShaOf(dirPath), truncated: false, tree: children } });
  }
  for (const [p, content] of Object.entries(files)) {
    routes[`GET ${base}/git/blobs/${blobSha(content)}`] = withRate({
      json: { sha: blobSha(content), size: Buffer.byteLength(content), encoding: 'base64', content: Buffer.from(content).toString('base64') },
    });
  }

  // Used by plan 01-09 (repository metadata).
  routes[`GET ${API}/users/${owner}`] = withRate({ json: { login: owner, type: ownerType, created_at: ownerCreatedAt } });
  const headList = [{ sha, commit: { author: { date: headAuthorDate }, committer: { date: headCommitterDate } } }];
  const pageBase = `${base}/commits?per_page=1&sha=${sha}`;
  const link = commitCount > 1 ? { link: `<${pageBase}&page=${commitCount}>; rel="last"` } : {};
  routes[`GET ${pageBase}`] = { json: headList, headers: link };
  if (commitCount > 1) {
    routes[`GET ${pageBase}&page=${commitCount}`] = withRate({
      json: [{ sha: blobSha('oldest'), commit: { author: { date: oldestAuthorDate }, committer: { date: oldestCommitterDate } } }],
    });
  }
  return routes;
}
