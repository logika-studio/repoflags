import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, HttpError } from '../skills/repoflags/scripts/lib/util/http.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';
import { makeFakeFetch } from './helpers/fake-fetch.mjs';

const TOKEN = 'FAKE_GH_TOKEN_FOR_TESTS_ONLY';

function makeCtx(fetch, extra = {}) {
  const secrets = new Set();
  return {
    fetch,
    env: { GH_TOKEN: TOKEN },
    execGh: async () => {
      throw new Error('gh must not be needed');
    },
    signal: new AbortController().signal,
    network: { hosts: {} },
    rate: { remaining: null, reset: null },
    secrets,
    addSecret: (v) => secrets.add(String(v)),
    limits: createLimits({ requestTimeoutMs: 50, ...(extra.limits ?? {}) }),
    ...extra,
  };
}

async function rejects(promise, kind) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof HttpError, `HttpError expected, got ${e && e.name}`);
    assert.equal(e.kind, kind);
    return true;
  });
}

test('hosts outside the allowlist are refused without calling fetch', async () => {
  const log = [];
  const http = createHttp(makeCtx(makeFakeFetch({}, log)));
  for (const url of [
    'https://codeload.github.com/x',
    'http://api.github.com/x',
    'https://evil.test/x',
    'https://api.github.com.evil.test/x',
    'https://user:pw@api.github.com/x',
    'https://api.github.com:8443/x',
    'not a url',
  ]) {
    await rejects(http.json(url), 'not-allowed');
  }
  assert.equal(log.length, 0);
});

test('requests use redirect manual, User-Agent and Authorization only on api.github.com', async () => {
  const seen = [];
  const routes = {
    'GET https://api.github.com/a': { json: { ok: 1 } },
    'GET https://api.osv.dev/b': { json: { ok: 2 } },
    'GET https://registry.npmjs.org/c': { json: { ok: 3 } },
  };
  const base = makeFakeFetch(routes);
  const spy = async (url, init) => {
    seen.push({ url: String(url), init });
    return base(url, init);
  };
  const ctx = makeCtx(spy);
  const http = createHttp(ctx);
  await http.json('https://api.github.com/a');
  await http.json('https://api.osv.dev/b');
  await http.json('https://registry.npmjs.org/c');
  for (const s of seen) {
    assert.equal(s.init.redirect, 'manual');
    assert.equal(new Headers(s.init.headers).get('user-agent'), 'repoflags/1.0.0');
    assert.ok(new Headers(s.init.headers).get('accept'));
  }
  assert.deepEqual(base.log.map((l) => [l.host, l.auth]), [
    ['api.github.com', `Bearer ${TOKEN}`],
    ['api.osv.dev', null],
    ['registry.npmjs.org', null],
  ]);
  assert.equal(ctx.network.hosts['api.github.com'], 1);
  assert.equal(ctx.network.hosts['api.osv.dev'], 1);
});

test('a 3xx answer is never followed and a throwing fetch is a handled network error', async () => {
  const log = [];
  const fetch = makeFakeFetch(
    { 'GET https://api.github.com/r': { status: 302, headers: { location: 'https://evil.test/x' } } },
    log,
  );
  const http = createHttp(makeCtx(fetch));
  await assert.rejects(http.json('https://api.github.com/r'), (e) => {
    assert.equal(e.kind, 'redirect');
    assert.equal(e.location, 'https://evil.test/x');
    assert.ok(!e.message.includes('evil.test'));
    return true;
  });
  assert.equal(log.length, 1);

  const throwing = createHttp(makeCtx(async () => { throw new TypeError('redirect mode is set to manual'); }));
  await rejects(throwing.json('https://api.github.com/r'), 'network');
});

test('rate limit: 403/429 with remaining 0, and rate state is updated from GitHub answers', async () => {
  const routes = {
    'GET https://api.github.com/ok': { json: {}, headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1800000000' } },
    'GET https://api.github.com/limited': { status: 403, json: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000100' } },
    'GET https://api.github.com/limited429': { status: 429, json: {}, headers: { 'x-ratelimit-remaining': '0' } },
    'GET https://api.github.com/forbidden': { status: 403, json: {}, headers: { 'x-ratelimit-remaining': '10' } },
    'GET https://api.osv.dev/other': { json: {}, headers: { 'x-ratelimit-remaining': '1' } },
  };
  const ctx = makeCtx(makeFakeFetch(routes));
  const http = createHttp(ctx);
  await http.json('https://api.github.com/ok');
  assert.equal(ctx.rate.remaining, 42);
  assert.equal(ctx.rate.reset, 1800000000);
  await rejects(http.json('https://api.github.com/limited'), 'rate-limit');
  assert.equal(ctx.rate.remaining, 0);
  assert.equal(ctx.rate.reset, 1800000100);
  await rejects(http.json('https://api.github.com/limited429'), 'rate-limit');
  const plain = await http.json('https://api.github.com/forbidden');
  assert.equal(plain.status, 403);
  await http.json('https://api.osv.dev/other');
  assert.equal(ctx.rate.remaining, 10);
});

test('a body above maxBytes is too-large, by content-length or by stream length', async () => {
  const routes = {
    'GET https://api.github.com/big-header': { text: 'x', headers: { 'content-length': '999999' } },
    'GET https://api.github.com/big-stream': { text: 'x'.repeat(5000) },
    'GET https://api.github.com/small': { text: 'hello' },
  };
  const http = createHttp(makeCtx(makeFakeFetch(routes)));
  await rejects(http.text('https://api.github.com/big-header', undefined, 1000), 'too-large');
  await rejects(http.text('https://api.github.com/big-stream', undefined, 1000), 'too-large');
  const ok = await http.text('https://api.github.com/small', undefined, 1000);
  assert.equal(ok.body, 'hello');
});

test('per-request timeout and aborted global signal', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await rejects(createHttp(makeCtx(hang)).json('https://api.github.com/slow'), 'timeout');
  // A fetch that ignores the abort signal must still time out.
  await rejects(createHttp(makeCtx(() => new Promise(() => {}))).json('https://api.github.com/slow'), 'timeout');

  const log = [];
  const controller = new AbortController();
  controller.abort();
  const ctx = makeCtx(makeFakeFetch({}, log), { signal: controller.signal });
  await rejects(createHttp(ctx).json('https://api.github.com/x'), 'timeout');
  assert.equal(log.length, 0);
});

test('invalid JSON is a status error and error messages never carry the token', async () => {
  const bad = createHttp(makeCtx(makeFakeFetch({ 'GET https://api.github.com/j': { text: '{nope' } })));
  await rejects(bad.json('https://api.github.com/j'), 'status');

  const ctx = makeCtx(async () => {
    throw new Error(`boom ${TOKEN}`);
  });
  await assert.rejects(createHttp(ctx).json('https://api.github.com/x'), (e) => {
    assert.equal(e.kind, 'network');
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!String(e.stack ?? '').includes(TOKEN));
    return true;
  });
});

test('IN-02: secondary rate limit (403 or 429 with retry-after) is a rate limit, not "not found"', async () => {
  const fetch = makeFakeFetch({
    'GET https://api.github.com/secondary': { status: 403, json: { message: 'secondary rate limit' }, headers: { 'x-ratelimit-remaining': '4000', 'retry-after': '60' } },
    'GET https://api.github.com/too-many': { status: 429, json: {}, headers: {} },
  });
  const http = createHttp(makeCtx(fetch));
  await rejects(http.json('https://api.github.com/secondary'), 'rate-limit');
  await rejects(http.json('https://api.github.com/too-many'), 'rate-limit');
});
