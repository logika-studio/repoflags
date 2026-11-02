// Review tests IN-07: the fake fetch could not express a 204/304 route and ignored init.signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeFetch } from './helpers/fake-fetch.mjs';

const U = 'https://api.github.com/x';

test('IN-07: 204 and 304 routes answer with a null body', async () => {
  for (const status of [204, 304]) {
    const res = await makeFakeFetch({ [`GET ${U}`]: { status } })(U);
    assert.equal(res.status, status);
    assert.equal(await res.text(), '');
  }
});

test('IN-07: an already aborted signal rejects with AbortError; a live signal does not', async () => {
  const f = makeFakeFetch({ [`GET ${U}`]: { json: {} } });
  const before = new AbortController();
  before.abort();
  await assert.rejects(f(U, { signal: before.signal }), { name: 'AbortError' });
  assert.equal(f.log.length, 1);
  const res = await f(U, { signal: new AbortController().signal });
  assert.equal(res.status, 200);
});
