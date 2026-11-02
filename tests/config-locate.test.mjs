import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { loadUserConfig } from '../skills/repoflags/scripts/lib/config/locate.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { makeIo } from './helpers/io.mjs';
import { importViolations } from './helpers/source-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = { 'package.json': '{"name":"x"}' };
const CFG_REL = '.config/repoflags/config.json';

// Every config file lives in an OS temp dir created and removed by the test; the real home is never read.
async function run(argv, { env = {}, homedir } = {}) {
  const c = makeIo();
  const deps = { fetch: makeForbiddenFetch(), now: () => new Date('2026-11-01T00:00:00Z'), env };
  if (homedir) deps.homedir = homedir;
  const code = await main(argv, c.io, deps);
  return { code, out: c.stdout(), err: c.stderr() };
}
const limitsOf = (r) => JSON.parse(r.out).limits;

// The cwd is restored before the temp folder is removed: on Windows a folder that is the cwd cannot be deleted.
async function inCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

async function fx(t, files) {
  const m = await materialize(files);
  t.after(m.cleanup);
  return m.dir;
}

test('limits of the file in the home apply; the flags win over the file', async (t) => {
  const dir = await fx(t, PKG);
  const home = await fx(t, { [CFG_REL]: '{"limits":{"maxFiles":3}}' });
  const base = [dir, '--offline', '--format', 'json'];
  const a = await run(base, { homedir: () => home });
  assert.equal(a.code, 0, a.err);
  assert.equal(limitsOf(a).maxFiles, 3);
  const b = await run([...base, '--max-files', '5'], { homedir: () => home });
  assert.equal(limitsOf(b).maxFiles, 5);
});

test('--config wins over REPOFLAGS_CONFIG, which wins over the file in the home', async (t) => {
  const dir = await fx(t, PKG);
  const cfgs = await fx(t, { 'flag.json': '{"limits":{"maxFiles":11}}', 'env.json': '{"limits":{"maxFiles":22}}' });
  const home = await fx(t, { [CFG_REL]: '{"limits":{"maxFiles":33}}' });
  const base = [dir, '--offline', '--format', 'json'];
  const env = { REPOFLAGS_CONFIG: path.join(cfgs, 'env.json') };
  assert.equal(limitsOf(await run([...base, '--config', path.join(cfgs, 'flag.json')], { env, homedir: () => home })).maxFiles, 11);
  assert.equal(limitsOf(await run(base, { env, homedir: () => home })).maxFiles, 22);
  assert.equal(limitsOf(await run(base, { homedir: () => home })).maxFiles, 33);
});

test('a home without a config file leaves the report identical', async (t) => {
  const dir = await fx(t, PKG);
  const empty = await fx(t, { 'other.txt': 'x' });
  const base = [dir, '--offline', '--format', 'json'];
  const a = await run(base);
  const b = await run(base, { homedir: () => empty });
  assert.equal(a.code, 0);
  assert.equal(a.out, b.out);
  assert.equal(JSON.parse(a.out).config, undefined);
});

test('--config / REPOFLAGS_CONFIG to a missing file, a folder: exit 2, usage, no stack, no path echoed', async (t) => {
  const dir = await fx(t, PKG);
  const cfgs = await fx(t, { 'sub/.keep': '' });
  const base = [dir, '--offline'];
  const missing = path.join(cfgs, 'nope-secret-name.json');
  const folder = path.join(cfgs, 'sub');
  for (const r of [
    await run([...base, '--config', missing]),
    await run([...base, '--config', folder]),
    await run(base, { env: { REPOFLAGS_CONFIG: missing } }),
    await run(base, { env: { REPOFLAGS_CONFIG: folder } }),
  ]) {
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /^repoflags: /);
    assert.match(r.err, /Usage:/);
    assert.doesNotMatch(r.err, /\n\s+at /);
    assert.ok(!r.err.includes(cfgs), 'the path must not be echoed');
  }
});

test('repoflags.config.json and .repoflagsrc in the target and in the cwd are never read', async (t) => {
  const evil = '{"limits":{"maxFiles":1},"rules":{"npmrc-auth-token":false}}';
  const dir = await fx(t, { ...PKG, 'repoflags.config.json': evil, '.repoflagsrc': evil });
  const empty = await fx(t, { 'other.txt': 'x' });
  const base = [dir, '--offline', '--format', 'json'];
  const baseline = await run(base, { homedir: () => empty });
  const r = await inCwd(dir, () => run(base, { homedir: () => empty }));
  assert.equal(r.code, baseline.code);
  assert.equal(limitsOf(r).maxFiles, limitsOf(baseline).maxFiles);
  assert.notEqual(limitsOf(r).maxFiles, 1);
});

test('a config file inside the analyzed folder is refused (flag and env, also via a relative path)', async (t) => {
  const dir = await fx(t, { ...PKG, 'x.json': '{"limits":{"maxFiles":3}}' });
  const inside = path.join(dir, 'x.json');
  const base = [dir, '--offline'];
  const a = await run([...base, '--config', inside]);
  assert.equal(a.code, 2);
  assert.match(a.err, /inside the analyzed folder/);
  const b = await run(base, { env: { REPOFLAGS_CONFIG: inside } });
  assert.equal(b.code, 2);
  const c = await inCwd(dir, () => run(['.', '--offline', '--config', 'x.json']));
  assert.equal(c.code, 2);
  assert.match(c.err, /inside the analyzed folder/);
  // A file in a sibling folder is fine.
  const outside = await fx(t, { 'ok.json': '{"limits":{"maxFiles":3}}' });
  const d = await run([...base, '--config', path.join(outside, 'ok.json')]);
  assert.equal(d.code, 0, d.err);
});

test('a UTF-8 BOM is accepted; a file over 64 KiB is refused', async (t) => {
  const dir = await fx(t, PKG);
  const cfgs = await fx(t, {
    // Escaped on purpose (review IN-A-07): an invisible literal U+FEFF could be dropped by an editor unnoticed.
    'bom.json': '\uFEFF{"limits":{"maxFiles":4}}',
    'utf16le.json': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"limits":{"maxFiles":8}}', 'utf16le')]),
    'big.json': `{"language":"it"${' '.repeat(65600)}}`,
    'bad.json': '{"limits":',
  });
  const base = [dir, '--offline', '--format', 'json'];
  assert.equal(limitsOf(await run([...base, '--config', path.join(cfgs, 'bom.json')])).maxFiles, 4);
  assert.equal(limitsOf(await run([...base, '--config', path.join(cfgs, 'utf16le.json')])).maxFiles, 8);
  const big = await run([...base, '--config', path.join(cfgs, 'big.json')]);
  assert.equal(big.code, 2);
  assert.match(big.err, /larger than/);
  const bad = await run([...base, '--config', path.join(cfgs, 'bad.json')]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not valid JSON/);
  assert.ok(!bad.err.includes(cfgs));
});

test('an injected env without USERPROFILE/HOME and without homedir searches no user file', async (t) => {
  const seen = [];
  const deps = {
    env: {},
    stat: (p) => { seen.push(p); throw new Error('stat must not be called'); },
    readFile: (p) => { seen.push(p); throw new Error('readFile must not be called'); },
  };
  assert.equal(loadUserConfig({ flag: undefined, target: '/nonexistent-target' }, deps), null);
  assert.deepEqual(seen, []);
});

test('the home comes from the injected env (USERPROFILE on win32, HOME elsewhere)', async (t) => {
  const home = await fx(t, { [CFG_REL]: '{"limits":{"maxFiles":6}}' });
  const win = loadUserConfig({ target: 'x' }, { env: { USERPROFILE: home }, platform: 'win32' });
  assert.equal(win.options.limits.maxFiles, 6);
  const nix = loadUserConfig({ target: 'x' }, { env: { HOME: home }, platform: 'linux' });
  assert.equal(nix.options.limits.maxFiles, 6);
});

test('with realUser (the CLI entry point) and without deps.env the real REPOFLAGS_CONFIG variable is respected', async (t) => {
  const cfgs = await fx(t, { 'c.json': '{"limits":{"maxFiles":3}}' });
  const empty = await fx(t, { 'other.txt': 'x' });
  const had = Object.hasOwn(process.env, 'REPOFLAGS_CONFIG');
  const prev = process.env.REPOFLAGS_CONFIG;
  t.after(() => {
    if (had) process.env.REPOFLAGS_CONFIG = prev;
    else delete process.env.REPOFLAGS_CONFIG;
  });
  process.env.REPOFLAGS_CONFIG = path.join(cfgs, 'c.json');
  const cfg = loadUserConfig({ flag: undefined, target: path.join(empty, 'no-such-target') }, { homedir: () => empty, realUser: true });
  assert.equal(cfg.options.limits.maxFiles, 3);
});

test('class guard: every test file that calls main( injects env or homedir', async () => {
  const bad = [];
  for (const name of await fs.readdir(HERE)) {
    if (!name.endsWith('.test.mjs')) continue;
    const text = await fs.readFile(path.join(HERE, name), 'utf8');
    if (!/\bmain\(/.test(text)) continue;
    if (!/\benv\s*[:,}]|\bhomedir\b/.test(text)) bad.push(name);
  }
  assert.deepEqual(bad, []);
});

test('class guard: spawned CLI processes in tests get a hermetic home', async () => {
  const bad = [];
  for (const name of ['cli-entry.test.mjs', 'skeleton.test.mjs']) {
    const text = await fs.readFile(path.join(HERE, name), 'utf8');
    if (!/hermeticEnv/.test(text)) bad.push(name);
  }
  assert.deepEqual(bad, []);
});

test('policy: node:os is allowed only in lib/config/locate.mjs', () => {
  const src = "import os from 'node:os';";
  assert.deepEqual(importViolations('skills/repoflags/scripts/lib/config/locate.mjs', src), []);
  assert.notDeepEqual(importViolations('skills/repoflags/scripts/lib/analyze.mjs', src), []);
});
