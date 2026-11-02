import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToken } from '../skills/repoflags/scripts/lib/acquire/token.mjs';

function makeCtx(env, execGh) {
  const secrets = new Set();
  return { env, execGh, secrets, addSecret: (v) => secrets.add(String(v)) };
}

test('GH_TOKEN wins over GITHUB_TOKEN, which wins over gh', async () => {
  let calls = 0;
  const execGh = async () => {
    calls += 1;
    return 'FROM_GH';
  };
  assert.equal(await resolveToken(makeCtx({ GH_TOKEN: 'A_TOKEN', GITHUB_TOKEN: 'B_TOKEN' }, execGh)), 'A_TOKEN');
  assert.equal(await resolveToken(makeCtx({ GITHUB_TOKEN: 'B_TOKEN' }, execGh)), 'B_TOKEN');
  assert.equal(calls, 0);
  assert.equal(await resolveToken(makeCtx({ GH_TOKEN: '   ' }, execGh)), 'FROM_GH');
  assert.equal(calls, 1);
});

test('gh output is trimmed, called with fixed argv and at most once per ctx', async () => {
  const argvSeen = [];
  const execGh = async (args) => {
    argvSeen.push(args);
    return { stdout: '  FAKE_GH_TOKEN_FOR_TESTS_ONLY \r\n' };
  };
  const ctx = makeCtx({}, execGh);
  assert.equal(await resolveToken(ctx), 'FAKE_GH_TOKEN_FOR_TESTS_ONLY');
  assert.equal(await resolveToken(ctx), 'FAKE_GH_TOKEN_FOR_TESTS_ONLY');
  assert.deepEqual(argvSeen, [['auth', 'token', '--hostname', 'github.com']]);
});

test('missing gh (ENOENT) or empty output means anonymous, and the token is registered as secret', async () => {
  const enoent = async () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  const ctx = makeCtx({}, enoent);
  assert.equal(await resolveToken(ctx), null);
  assert.equal(await resolveToken(ctx), null);
  assert.equal(await resolveToken(makeCtx({}, async () => '\n')), null);

  const withToken = makeCtx({ GITHUB_TOKEN: 'FAKE_GH_TOKEN_FOR_TESTS_ONLY' }, enoent);
  await resolveToken(withToken);
  assert.ok(withToken.secrets.has('FAKE_GH_TOKEN_FOR_TESTS_ONLY'));
});

test('WR-02: gh is asked for the github.com token only, never for the default host', async () => {
  const argvSeen = [];
  const execGh = async (args) => {
    argvSeen.push(args);
    return 'FAKE_GH_TOKEN_FOR_TESTS_ONLY';
  };
  await resolveToken(makeCtx({}, execGh));
  assert.deepEqual(argvSeen, [['auth', 'token', '--hostname', 'github.com']]);
});
