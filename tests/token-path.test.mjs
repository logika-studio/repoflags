// T-01-42 (G1): `gh` is resolved to an absolute path from the absolute PATH entries only, never from the current
// folder. The planted program is a copy of node that runs an innocuous script; nothing real is ever executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToken, findGh } from '../skills/repoflags/scripts/lib/acquire/token.mjs';

const WIN = process.platform === 'win32';
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repoflags-gh-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
};

function plant(dir) {
  if (WIN) {
    const exe = path.join(dir, 'gh.exe');
    // A copy, not a hard link: a link to the running node.exe cannot be deleted while the test runs.
    fs.copyFileSync(process.execPath, exe);
    // node.exe renamed gh.exe runs its first argument, `auth`, as a script from the current folder.
    fs.writeFileSync(path.join(dir, 'auth'), "require('fs').writeFileSync(require('path').join(__dirname, 'planted-ran'), 'x');\nconsole.log('PLANTED-GH-RAN');\n");
  } else {
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\ntouch "$(dirname "$0")/planted-ran"\necho PLANTED-GH-RAN\n', { mode: 0o755 });
  }
}

test('T-01-42: a gh planted in the current folder is never run when PATH has no gh', async (t) => {
  const cwd = tmp(t);
  const empty = tmp(t);
  plant(cwd);
  const before = { cwd: process.cwd(), PATH: process.env.PATH };
  const secrets = [];
  let token;
  process.chdir(cwd);
  process.env.PATH = empty; // also the inherited PATH: whatever happens, no real gh can be reached
  try {
    token = await resolveToken({ env: { PATH: empty }, addSecret: (v) => secrets.push(v) });
  } finally {
    process.chdir(before.cwd);
    process.env.PATH = before.PATH;
  }
  assert.equal(fs.existsSync(path.join(cwd, 'planted-ran')), false, 'the planted program ran');
  assert.equal(token, null);
  assert.deepEqual(secrets, []);
});

// Real files on the platform the test runs on (01/11: the previous version injected win32 on Linux, where a POSIX
// tmp folder is correctly not a drive-absolute entry, so the test asserted a lookup win32 would never perform).
test('findGh on the host platform: only absolute PATH entries, never empty, ".", relative or the current folder', (t) => {
  const bin = tmp(t);
  const cwd = tmp(t);
  const name = WIN ? 'gh.exe' : 'gh';
  fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  fs.writeFileSync(path.join(cwd, name), '', { mode: 0o755 });
  const env = (entries) => (WIN ? { Path: entries.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : { PATH: entries.join(':') });
  const rel = path.join('relative', 'dir');
  assert.equal(findGh(env(['', '.', rel, cwd]), { cwd }), null);
  assert.equal(findGh(env(['.', cwd, WIN ? `"${bin}"` : bin]), { cwd }), path.join(bin, name));
  assert.equal(findGh({}, { cwd }), null);
  if (!WIN) {
    // POSIX: a gh without the executable bit is not a program (execFile would fail on it anyway).
    const plain = tmp(t);
    fs.writeFileSync(path.join(plain, 'gh'), '', { mode: 0o644 });
    assert.equal(findGh(env([plain]), { cwd }), null);
  }
});

// win32 lookup rules on ANY host: synthetic drive-absolute paths and an injected file probe, no real files.
test('findGh win32 rules: drive-absolute entries only, only .exe/.com from PATHEXT, never .cmd/.bat', () => {
  // Every hostile entry below holds a gh.exe: only the drive-absolute, non-cwd entries may ever be returned.
  const files = new Set(['C:\\bin\\gh.cmd', 'C:\\bin\\gh.bat', 'C:\\Work\\gh.exe', 'c:\\WORK\\gh.exe', 'rel\\gh.exe', '\\rel\\gh.exe',
    '\\\\server\\share\\gh.exe', 'C:rel\\gh.exe', 'gh.exe', '.\\gh.exe']);
  const opts = { platform: 'win32', cwd: 'C:\\Work', isProgram: (f) => files.has(f) };
  assert.equal(findGh({ PATH: 'C:\\bin', PATHEXT: '.CMD;.BAT' }, opts), null);
  // `\rel` depends on the current drive, UNC on a share, `C:rel` on the drive's cwd; the current folder (any case) never.
  const hostile = ['', '.', 'rel', '\\rel', '\\\\server\\share', 'c:\\WORK', 'C:\\Work\\', 'C:rel'].join(';');
  assert.equal(findGh({ PATH: hostile, PATHEXT: '.EXE' }, opts), null);
  files.add('C:\\bin\\gh.com');
  assert.equal(findGh({ PATH: 'C:\\bin', PATHEXT: '.CMD;.COM' }, opts), 'C:\\bin\\gh.com');
  assert.equal(findGh({ Path: `${hostile};"C:\\bin"` }, opts), 'C:\\bin\\gh.com');
});
