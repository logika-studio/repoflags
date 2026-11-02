// Review tests WR-09: the symlink tests are the only proof that links are not followed; a skip must not hide a
// regression. Skip only on Windows without symlink privilege (EPERM) and never in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSkipReason, nameSkipReason } from './helpers/fixture-errors.mjs';

const err = (code) => Object.assign(new Error('x'), code === undefined ? {} : { code });

test('WR-09: a symlink EPERM on a local Windows machine is the only skip', () => {
  assert.match(linkSkipReason(err('EPERM'), { platform: 'win32', env: {} }), /EPERM/);
});

test('WR-09: every other symlink failure fails the test', () => {
  const cases = [
    [err('EPERM'), 'linux', {}], [err('EPERM'), 'darwin', {}], [err('EACCES'), 'win32', {}], [err('ENOENT'), 'win32', {}],
    [err(undefined), 'win32', {}], [err('EPERM'), 'win32', { CI: 'true' }], [err('EPERM'), 'linux', { CI: 'true' }],
    [err('EPERM'), 'darwin', { CI: 'true' }], [new TypeError('bug in materialize'), 'win32', {}],
  ];
  for (const [e, platform, env] of cases) assert.equal(linkSkipReason(e, { platform, env }), null, `${e.code} ${platform} ${JSON.stringify(env)}`);
});

test('WR-09: a refused file name skips only for EILSEQ/EINVAL outside CI', () => {
  assert.match(nameSkipReason(err('EILSEQ'), { platform: 'linux', env: {} }), /EILSEQ/);
  assert.match(nameSkipReason(err('EINVAL'), { platform: 'win32', env: {} }), /EINVAL/);
  for (const [e, env] of [[err('ENOENT'), {}], [err('EACCES'), {}], [err(undefined), {}], [new TypeError('bug'), {}], [err('EILSEQ'), { CI: 'true' }]]) {
    assert.equal(nameSkipReason(e, { platform: 'linux', env }), null, `${e.code} ${JSON.stringify(env)}`);
  }
});
