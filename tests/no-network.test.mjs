// Review tests IN-05: an offline test that did not inject fetch/gh would use the real globalThis.fetch and the real
// `gh auth token` after a regression, and still pass. offlineDeps makes any such call fail the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbidNetwork, offlineDeps } from './helpers/no-network.mjs';

test('IN-05: forbidNetwork records every fetch and gh call and both always fail', async () => {
  const { deps, used } = forbidNetwork({ env: {} });
  assert.deepEqual(used(), []);
  await assert.rejects(deps.fetch('https://api.osv.dev/v1/querybatch', { method: 'POST' }));
  await assert.rejects(deps.execGh(['auth', 'token']));
  assert.deepEqual(used(), ['POST https://api.osv.dev/v1/querybatch', 'gh']);
  assert.deepEqual(deps.env, {});
});

test('IN-05: offlineDeps keeps the base deps and replaces fetch and gh', (t) => {
  const now = () => new Date(0);
  const deps = offlineDeps(t, { now, env: { A: '1' }, fetch: globalThis.fetch });
  assert.equal(deps.now, now);
  assert.deepEqual(deps.env, { A: '1' });
  assert.notEqual(deps.fetch, globalThis.fetch);
  assert.equal(typeof deps.execGh, 'function');
});
