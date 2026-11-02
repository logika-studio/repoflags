import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalSha } from '../skills/repoflags/scripts/lib/acquire/git-sha.mjs';
import { analyze } from '../skills/repoflags/scripts/lib/analyze.mjs';
import { materialize } from './helpers/materialize.mjs';
import { offlineDeps } from './helpers/no-network.mjs';
import { linkSkipReason, nameSkipReason } from './helpers/fixture-errors.mjs';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const deps = () => ({ now: () => new Date('2026-11-01T00:00:00Z'), env: {} });

async function fixture(t, map) {
  const { dir, cleanup } = await materialize(map);
  t.after(cleanup);
  return dir;
}

test('sha: loose ref under refs/heads', async (t) => {
  const dir = await fixture(t, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${SHA}\n` });
  assert.deepEqual(await readLocalSha(dir), { sha: SHA, ref: 'main', reason: null });
});

test('sha: packed-refs fallback ignores comments and peeled lines', async (t) => {
  const dir = await fixture(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/packed-refs': `# pack-refs with: peeled\n${SHA2} refs/heads/other\n${SHA} refs/heads/main\n^${SHA2}\n`,
  });
  assert.deepEqual(await readLocalSha(dir), { sha: SHA, ref: 'main', reason: null });
});

test('sha: detached HEAD', async (t) => {
  const dir = await fixture(t, { '.git/HEAD': `${SHA}\n` });
  assert.deepEqual(await readLocalSha(dir), { sha: SHA, ref: null, reason: null });
});

test('sha: .git as a file (gitdir:) is not followed', async (t) => {
  const dir = await fixture(t, { '.git': 'gitdir: ../elsewhere\n' });
  const r = await readLocalSha(dir);
  assert.equal(r.sha, null);
  assert.equal(r.reason, 'worktree or submodule .git file not followed');
});

test('sha: no .git directory', async (t) => {
  const dir = await fixture(t, { 'package.json': '{}' });
  const r = await readLocalSha(dir);
  assert.equal(r.sha, null);
  assert.equal(r.reason, 'no .git directory (zip or copy): commit SHA not available');
});

test('sha: hostile or malformed HEAD gives null with a reason, never throws', async (t) => {
  const heads = [
    'ref: refs/heads/../../../etc/passwd\n',
    'ref: refs/heads/a b;c\n',
    'ref: ../../outside\n',
    'garbage\n',
    '',
    `${'a'.repeat(39)}\n`,
  ];
  for (const head of heads) {
    const dir = await fixture(t, { '.git/HEAD': head, '.git/refs/heads/main': `${SHA}\n` });
    const r = await readLocalSha(dir);
    assert.equal(r.sha, null, JSON.stringify(head));
    assert.equal(typeof r.reason, 'string');
  }
});

test('sha: ref file with non-hex content gives null', async (t) => {
  const dir = await fixture(t, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': 'not a sha\n' });
  const r = await readLocalSha(dir);
  assert.equal(r.sha, null);
  assert.ok(r.reason);
});

test('sha: HEAD symlink is not followed', async (t) => {
  const dir = await fixture(t, { 'outside/HEAD': `${SHA}\n`, '.git/keep': 'x' });
  try {
    await fs.symlink(path.join(dir, 'outside', 'HEAD'), path.join(dir, '.git', 'HEAD'));
  } catch (e) {
    const reason = linkSkipReason(e);
    if (reason) return t.skip(reason);
    throw e;
  }
  const r = await readLocalSha(dir);
  assert.equal(r.sha, null);
  assert.ok(r.reason);
});

test('sha: never spawns a process, even with core.fsmonitor in .git/config', async (t) => {
  const calls = [];
  for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync', 'fork']) {
    t.mock.method(childProcess, name, (...a) => {
      calls.push(name);
      throw new Error(`unexpected ${name}`);
    });
  }
  const dir = await fixture(t, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/refs/heads/main': `${SHA}\n`,
    '.git/config': '[core]\n\tfsmonitor = echo fixture\n',
  });
  const r = await readLocalSha(dir);
  assert.equal(r.sha, SHA);
  const report = await analyze(dir, { offline: true }, offlineDeps(t, deps()));
  assert.equal(report.target.sha, SHA);
  assert.deepEqual(calls, []);
});

test('analyze: cloned folder reports sha and ref, no provisional commit-sha entry', async (t) => {
  const dir = await fixture(t, {
    'package.json': '{"name":"x"}',
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/refs/heads/main': `${SHA}\n`,
  });
  const report = await analyze(dir, { offline: true }, offlineDeps(t, deps()));
  assert.equal(report.target.sha, SHA);
  assert.equal(report.target.ref, 'main');
  assert.ok(!report.notVerified.some((n) => /read in plan 01-03/.test(n.reason)));
  assert.ok(!report.notVerified.some((n) => n.check === 'commit-sha'));
});

test('analyze: zip-like folder has sha null and a commit-sha not-verified entry', async (t) => {
  const dir = await fixture(t, { 'package.json': '{"name":"x"}' });
  const report = await analyze(dir, { offline: true }, offlineDeps(t, deps()));
  assert.equal(report.target.sha, null);
  const nv = report.notVerified.find((n) => n.check === 'commit-sha');
  assert.ok(nv);
  assert.match(nv.reason, /no \.git directory/);
});

// ---- walk safety: links, excluded folders, case and separators ----
import { acquireLocal } from '../skills/repoflags/scripts/lib/acquire/local.mjs';
import { createLimits } from '../skills/repoflags/scripts/lib/acquire/limits.mjs';

const newCtx = (limits = {}) => ({ limits: createLimits({ limits }) });

async function tryLink(t, target, link, type) {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (e) {
    const reason = linkSkipReason(e);
    if (reason) {
      t.skip(reason);
      return false;
    }
    throw e;
  }
}

test('walk: symlinks to a file and to a folder are not followed', async (t) => {
  const outside = await fixture(t, { 'package.json': '{"outside":true}', 'evil/.npmrc': 'x=y' });
  const dir = await fixture(t, { 'package.json': '{}' });
  if (!(await tryLink(t, path.join(outside, 'package.json'), path.join(dir, '.npmrc'), 'file'))) return;
  if (!(await tryLink(t, path.join(outside, 'evil'), path.join(dir, 'linked'), 'dir'))) return;
  const acq = await acquireLocal(dir, newCtx());
  assert.deepEqual([...acq.files.keys()], ['package.json']);
  assert.equal(acq.notVerified.filter((n) => /symlink not followed/.test(n.reason)).length, 2);
});

test('walk: a junction is treated like a symlink', async (t) => {
  const outside = await fixture(t, { 'package.json': '{"outside":true}' });
  const dir = await fixture(t, { 'package.json': '{}' });
  if (!(await tryLink(t, outside, path.join(dir, 'junc'), 'junction'))) return;
  const acq = await acquireLocal(dir, newCtx());
  assert.deepEqual([...acq.files.keys()], ['package.json']);
  assert.ok(acq.notVerified.some((n) => /not followed: junc/.test(n.reason)));
});

test('walk: node_modules and .git content are not visited', async (t) => {
  const dir = await fixture(t, {
    'package.json': '{}',
    'node_modules/evil/package.json': '{"scripts":{"postinstall":"x"}}',
    '.git/hooks/post-checkout': 'echo hi',
    '.git/HEAD': `${SHA}\n`,
  });
  const acq = await acquireLocal(dir, newCtx());
  assert.deepEqual([...acq.files.keys()], ['package.json']);
});

test('walk: selection is case-insensitive and keys use forward slashes', async (t) => {
  const dir = await fixture(t, { '.VSCODE/Tasks.JSON': '{}', 'Sub/Dir/PACKAGE.JSON': '{}' });
  const acq = await acquireLocal(dir, newCtx());
  assert.deepEqual([...acq.files.keys()].sort(), ['.VSCODE/Tasks.JSON', 'Sub/Dir/PACKAGE.JSON']);
  for (const k of acq.files.keys()) assert.ok(!k.includes('\\'));
});

test('walk: a bidi character in a file name only appears sanitized', async (t) => {
  const name = 'a‮b.config.js';
  let dir;
  try {
    // package.json ({} = 2 bytes) stays under the limit: with nothing read at all the analysis is an error (CR-04).
    dir = await fixture(t, { [name]: 'a'.repeat(50), 'package.json': '{}' });
  } catch (e) {
    const reason = nameSkipReason(e);
    if (reason) return t.skip(reason);
    throw e;
  }
  const report = await analyze(dir, { offline: true, limits: { maxFileBytes: 10 } }, offlineDeps(t, deps()));
  const text = JSON.stringify(report);
  assert.ok(!text.includes('‮') && !/\u202e/i.test(text));
  assert.ok(report.notVerified.some((n) => n.check === 'limits' && n.reason.includes('config.js')));
});

for (const linked of ['refs', 'refs/heads']) {
  test(`T-01-18: sha: a junction at .git/${linked} is not followed out of .git`, async (t) => {
    const outside = await fixture(t, { 'heads/main': `${SHA}\n`, main: `${SHA}\n` });
    const dir = await fixture(t, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/keep': 'x' });
    const target = linked === 'refs' ? outside : path.join(outside, 'heads');
    if (linked === 'refs') await fs.rm(path.join(dir, '.git', 'refs'), { recursive: true });
    if (!(await tryLink(t, target, path.join(dir, '.git', ...linked.split('/')), 'junction'))) return;
    const r = await readLocalSha(dir);
    assert.equal(r.sha, null, 'SHA read from outside .git');
    assert.ok(r.reason);
  });
}
