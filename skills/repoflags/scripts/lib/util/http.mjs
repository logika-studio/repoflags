// The single network exit of the tool (D-14): allowlist, manual redirects, timeouts, size cap, rate-limit tracking.
// Error messages carry only kind/status/host: never fetch error text, never headers (the token must not leak).
import { ALLOWED_HOSTS, TOOL_VERSION } from '../constants.mjs';
import { resolveToken } from '../acquire/token.mjs';

export class HttpError extends Error {
  constructor(kind, { status = null, host = null, location = null } = {}) {
    super(`HTTP ${kind}${status ? ` (status ${status})` : ''}${host ? ` for ${host}` : ''}`);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.host = host;
    this.location = location;
  }
}

const GITHUB_HOST = 'api.github.com';

/**
 * Body size of a JSON answer carrying `bytes` of base64 content: 4/3 for base64, plus the newline GitHub puts
 * every 60 characters, serialized as two bytes (review WR-05), plus room for the other fields.
 */
export function base64BodyCap(bytes) {
  return Math.ceil(((bytes * 4) / 3) * (62 / 60)) + 4096;
}

function checkUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new HttpError('not-allowed');
  }
  const ok = u.protocol === 'https:' && !u.username && !u.password && !u.port && ALLOWED_HOSTS.includes(u.hostname);
  if (!ok) throw new HttpError('not-allowed', { host: u.hostname });
  return u;
}

async function readCapped(response, maxBytes, host) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError('too-large', { host });
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new HttpError('too-large', { host });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError('too-large', { host });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttp(ctx) {
  const timeoutMs = ctx.limits.values.requestTimeoutMs;
  const defaultCap = Math.max(ctx.limits.values.maxPackumentBytes, base64BodyCap(ctx.limits.values.maxLockfileBytes));

  async function request(url, init, maxBytes, accept) {
    const u = checkUrl(url);
    const host = u.hostname;
    if (ctx.signal && ctx.signal.aborted) throw new HttpError('timeout', { host });

    const headers = { 'User-Agent': `repoflags/${TOOL_VERSION}`, Accept: accept, ...(init?.headers ?? {}) };
    if (host === GITHUB_HOST) {
      const token = await resolveToken(ctx);
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    let timer;
    let onGlobalAbort;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HttpError('timeout', { host }));
      }, timeoutMs);
      if (ctx.signal) {
        onGlobalAbort = () => {
          controller.abort();
          reject(new HttpError('timeout', { host }));
        };
        ctx.signal.addEventListener('abort', onGlobalAbort, { once: true });
      }
    });
    guard.catch(() => {});

    ctx.network.hosts[host] = (ctx.network.hosts[host] ?? 0) + 1;
    try {
      const work = (async () => {
        let response;
        try {
          response = await ctx.fetch(u.href, { ...init, method: init?.method ?? 'GET', headers, redirect: 'manual', signal: controller.signal });
        } catch {
          throw new HttpError('network', { host });
        }
        if (host === GITHUB_HOST) {
          const rem = Number(response.headers.get('x-ratelimit-remaining'));
          const reset = Number(response.headers.get('x-ratelimit-reset'));
          if (response.headers.get('x-ratelimit-remaining') !== null && Number.isFinite(rem)) ctx.rate.remaining = rem;
          if (response.headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset)) ctx.rate.reset = reset;
        }
        const status = response.status;
        if (status >= 300 && status < 400) {
          throw new HttpError('redirect', { status, host, location: response.headers.get('location') });
        }
        // Primary limit (remaining 0) and secondary limit (403 with retry-after, or any 429): never "not found" (IN-02).
        const exhausted = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null;
        const limited = status === 429 || (status === 403 && exhausted);
        if (limited) throw new HttpError('rate-limit', { status, host });
        const body = await readCapped(response, maxBytes, host);
        return { status, headers: response.headers, body };
      })();
      return await Promise.race([work, guard]);
    } finally {
      clearTimeout(timer);
      if (ctx.signal && onGlobalAbort) ctx.signal.removeEventListener('abort', onGlobalAbort);
    }
  }

  return {
    async json(url, init, maxBytes = defaultCap) {
      const res = await request(url, init, maxBytes, 'application/vnd.github+json');
      let body;
      try {
        body = JSON.parse(res.body);
      } catch {
        throw new HttpError('status', { status: res.status, host: new URL(String(url)).hostname });
      }
      return { status: res.status, headers: res.headers, body };
    },
    text(url, init, maxBytes = defaultCap) {
      return request(url, init, maxBytes, 'text/plain');
    },
  };
}
