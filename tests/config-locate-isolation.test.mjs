// Review WR-A-03 (Phase 2): only the real CLI entry point reads the real user environment (REPOFLAGS_CONFIG, home).
// Any other caller (tests, embedders) that injects neither env nor homedir gets no user configuration, so a real
// config file on the runner's machine can never change the outcome of the suite. fs is spied: nothing is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { loadUserConfig } from '../skills/repoflags/scripts/lib/config/locate.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { makeIo } from './helpers/io.mjs';
import { hermeticEnv } from './helpers/child-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'skills', 'repoflags', 'scripts', 'repoflags.mjs');

function spies() {
  const calls = [];
  const spy = (name) => (p) => {
    calls.push([name, String(p)]);
    throw Object.assign(new Error('spied'), { code: 'ENOENT' });
  };
  return { calls, deps: { stat: spy('stat'), readFile: spy('readFile'), realpath: spy('realpath') } };
}

/** Sets process.env.REPOFLAGS_CONFIG for one test and restores it afterwards. */
function withRealVar(t, value) {
  const had = Object.hasOwn(process.env, 'REPOFLAGS_CONFIG');
  const prev = process.env.REPOFLAGS_CONFIG;
  t.after(() => {
    if (had) process.env.REPOFLAGS_CONFIG = prev;
    else delete process.env.REPOFLAGS_CONFIG;
  });
  process.env.REPOFLAGS_CONFIG = value;
}

test('WR-A-03: without env, homedir or realUser loadUserConfig reads neither the real variable nor the real home', (t) => {
  withRealVar(t, path.resolve('repoflags-wr-a-03-not-a-file.json'));
  const { calls, deps } = spies();
  assert.equal(loadUserConfig({ target: path.resolve('x') }, deps), null);
  assert.deepEqual(calls, []);
});

test('WR-A-03: main without env/homedir does not read the real user configuration either', async (t) => {
  withRealVar(t, path.resolve('repoflags-wr-a-03-not-a-file.json'));
  const { calls, deps } = spies();
  const m = await materialize({ 'package.json': '{"name":"x"}' });
  t.after(m.cleanup);
  const c = makeIo();
  const code = await main([m.dir, '--offline'], c.io, { ...deps, fetch: makeForbiddenFetch(), env: undefined });
  assert.equal(code, 0, c.stderr());
  assert.deepEqual(calls, []);
});

test('WR-A-03: the real CLI entry point still reads the file in the (child) home', async (t) => {
  const dir = await materialize({ 'package.json': '{"name":"x"}' });
  const home = await materialize({ '.config/repoflags/config.json': '{"limits":{"maxFiles":3}}' });
  t.after(dir.cleanup);
  t.after(home.cleanup);
  const env = { ...hermeticEnv(), HOME: home.dir, USERPROFILE: home.dir };
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, dir.dir, '--offline', '--format', 'json'], { windowsHide: true, timeout: 60000, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).limits.maxFiles, 3);
});

test('IN-A-05: a home config that exists but cannot be read is an error, not a silent skip; a missing one is skipped', () => {
  const home = path.resolve('repoflags-virtual-home');
  const statWith = (code) => () => { throw Object.assign(new Error(code), { code }); };
  for (const code of ['EACCES', 'EPERM']) {
    assert.throws(() => loadUserConfig({}, { env: {}, homedir: () => home, stat: statWith(code) }), /config file in the home could not be read/, code);
  }
  for (const code of ['ENOENT', 'ENOTDIR']) {
    assert.equal(loadUserConfig({}, { env: {}, homedir: () => home, stat: statWith(code) }), null, code);
  }
});

test('class guard: every test file that spawns the CLI gives the child a hermetic home', async () => {
  const bad = [];
  for (const name of await fs.readdir(HERE)) {
    if (!name.endsWith('.test.mjs')) continue;
    const text = await fs.readFile(path.join(HERE, name), 'utf8');
    const spawns = /from 'node:child_process'/.test(text) && /repoflags\.mjs/.test(text);
    if (spawns && !/hermeticEnv\(\)/.test(text)) bad.push(name);
  }
  assert.deepEqual(bad, []);
});
