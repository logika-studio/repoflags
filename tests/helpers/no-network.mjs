// Test helper: deps for offline tests. fetch and gh always fail, every call is recorded, and offlineDeps makes the
// test fail at the end if anything was called (review tests IN-05). No real network, no real gh.
import assert from 'node:assert/strict';
import { makeForbiddenFetch } from './fake-fetch.mjs';

export function forbidNetwork(base = {}) {
  const log = [];
  const fetch = makeForbiddenFetch(log);
  const execGh = async () => {
    log.push({ key: 'gh' });
    throw Object.assign(new Error('gh forbidden in this test'), { code: 'ENOENT' });
  };
  return { deps: { ...base, fetch, execGh }, used: () => log.map((l) => l.key) };
}

/** `base` with forbidden fetch and gh; the test fails after it ends if either was called. */
export function offlineDeps(t, base = {}) {
  const { deps, used } = forbidNetwork(base);
  t.after(() => assert.deepEqual(used(), [], 'an offline test reached fetch or gh'));
  return deps;
}
