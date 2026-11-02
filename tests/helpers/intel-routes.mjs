// Fake OSV / npm registry handlers with the response shapes observed live (RESEARCH, 2026-11-01).
// Each handler is `(url, init) => Response | null` (null = not mine). `composeFetch` chains them.
import { makeFakeFetch } from './fake-fetch.mjs';
import { createLimits } from '../../skills/repoflags/scripts/lib/acquire/limits.mjs';

export const OSV_URL = 'https://api.osv.dev/v1/querybatch';
const REGISTRY = 'https://registry.npmjs.org/';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * @param {Record<string, string[]>} map  'name@version' -> vuln ids (absent = `{}`, the real "no vulns" shape)
 * @param {{ pages?: Record<string, string[]>, tokens?: Record<string, string>, status?: number, raw?: any, bodies?: any[] }} [opts]
 *   tokens: 'name@version' -> next_page_token of the first page; pages: token -> ids of the following page.
 *   raw: replaces the whole answer body (malformed shapes); bodies: records every parsed request body.
 */
export function osvRoutes(map, opts = {}) {
  const handler = async (url, init = {}) => {
    if (String(url) !== OSV_URL || (init.method ?? 'GET').toUpperCase() !== 'POST') return null;
    const body = JSON.parse(init.body);
    opts.bodies?.push(body);
    if (opts.status && opts.status !== 200) return jsonResponse({}, opts.status);
    if (opts.raw !== undefined) return jsonResponse(opts.raw);
    const results = body.queries.map((q) => {
      if (q.page_token) return { vulns: (opts.pages?.[q.page_token] ?? []).map((id) => ({ id, modified: '2026-10-01T00:00:00Z' })) };
      const key = `${q.package.name}@${q.version}`;
      const ids = map[key];
      if (!ids) return {};
      const out = { vulns: ids.map((id) => ({ id, modified: '2026-10-01T00:00:00Z' })) };
      if (opts.tokens?.[key]) out.next_page_token = opts.tokens[key];
      return out;
    });
    return jsonResponse({ results });
  };
  return handler;
}

/**
 * @param {Record<string, {status?: number, latest?: string, versions?: string[], throws?: boolean, bytes?: number}>} map
 *   package name -> answer. Absent names answer 404 `{"error":"Not found"}` (observed for missing scopes).
 * @param {{ requests?: Array<{url: string, accept: string|null}> }} [opts]
 */
export function registryRoutes(map, opts = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(REGISTRY)) return null;
    const name = decodeURIComponent(u.slice(REGISTRY.length));
    opts.requests?.push({ url: u, accept: new Headers(init.headers ?? {}).get('accept') });
    const spec = Object.hasOwn(map, name) ? map[name] : { status: 404 };
    if (spec.throws) throw new Error('connection reset');
    const status = spec.status ?? 200;
    if (status !== 200) return jsonResponse({ error: 'Not found' }, status);
    if (spec.bytes) return new Response('x'.repeat(spec.bytes), { status: 200, headers: { 'content-length': String(spec.bytes) } });
    const versions = {};
    for (const v of spec.versions ?? [spec.latest ?? '1.0.0']) versions[v] = { name, version: v };
    return jsonResponse({ name, 'dist-tags': { latest: spec.latest ?? '1.0.0' }, versions, modified: '2026-10-01T00:00:00Z' });
  };
}

/** Minimal ctx for intel modules; `now` is fixed so day counts are deterministic. */
export function makeIntelCtx(fetch, extra = {}) {
  const secrets = new Set();
  return {
    fetch,
    env: {},
    execGh: async () => { throw new Error('gh must not be needed'); },
    now: () => new Date('2026-11-01T00:00:00Z'),
    mode: 'online',
    signal: new AbortController().signal,
    network: { hosts: {} },
    rate: { remaining: null, reset: null },
    secrets,
    addSecret: (v) => secrets.add(String(v)),
    limits: createLimits({ requestTimeoutMs: 200, ...(extra.limits ?? {}) }),
    ...extra,
  };
}

/** Chains handlers, then an optional map of plain routes (e.g. buildGithubRoutes); unmatched requests throw. */
export function composeFetch(handlers, routes = {}, log = []) {
  const plain = makeFakeFetch(routes, []);
  const fn = async (url, init = {}) => {
    log.push({ key: `${(init.method ?? 'GET').toUpperCase()} ${String(url)}` });
    for (const h of handlers) {
      const res = await h(url, init);
      if (res) return res;
    }
    return plain(url, init);
  };
  fn.log = log;
  return fn;
}
