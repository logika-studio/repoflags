// T-01-07: owner/repo and GitHub URLs that would leave the intended API path are refused (exit 2), before any
// network call. No folder exists for these names (exists is injected), so only the remote parsing is exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';

const noGh = async () => { throw new Error('gh must not be called'); };
const HOSTILE = [
  'o/..', 'o/.', '../x', './x', '../..', 'own er/repo', 'o%2e%2e/r', 'o/r%2f..', 'o_x/r', 'o/r?x=1', 'o/r#x',
  'https://github.com/a/..', 'https://github.com/a/.', 'https://github.com/../a', 'https://github.com/a b/r',
  'https://github.com/a/r%2f..', 'https://github.com/a/b/c',
];

for (const target of HOSTILE) {
  test(`T-01-07: target ${JSON.stringify(target)} is refused with exit 2 and no request`, async () => {
    const fetch = makeForbiddenFetch();
    const { io, stderr } = makeIo();
    const code = await main([target, '--format', 'json'], io, { fetch, execGh: noGh, env: {}, exists: () => false });
    assert.equal(code, 2, stderr());
    assert.equal(fetch.log.length, 0);
    assert.doesNotMatch(stderr(), /\n\s+at /);
  });
}
