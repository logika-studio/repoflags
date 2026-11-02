// Review WR-09: G6 of the real-repo panel was fail-open when the netlog was missing or empty, and a
// truncated netlog line made the cli throw. Fake spawn only: no network, no real child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cli } from '../scripts/e2e/run-panel.mjs';

const REPORT = JSON.stringify({ outcome: 'no_signals_found_by_these_rules', signals: [], target: { sha: 'a'.repeat(40) } });
const ARGV = (dir) => ['node', 'run-panel', '--confirm', '--out-dir', dir, '--only', 'octocat/Hello-World'];

async function runWith(netlogText) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-panel-g6-'));
  let out = '';
  try {
    const spawn = async (cmd, args, opts) => {
      if (netlogText !== null) fs.writeFileSync(opts.env.REPOFLAGS_NETLOG, netlogText);
      return { code: 0, stdout: REPORT, stderr: '' };
    };
    const code = await cli({ argv: ARGV(dir), spawn, write: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    return { code, out };
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

test('WR-09: a remote report without a netlog is G6 not measured, exit 1', async () => {
  const r = await runWith(null);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /G6 not measured/);
});

test('WR-09: a netlog without connect, lookup or undici events is G6 not measured, exit 1', async () => {
  const r = await runWith(`${JSON.stringify({ t: 'exec', file: 'gh', args: ['auth', 'token'] })}\n`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /G6 not measured/);
});

test('WR-09: a truncated netlog line is counted, never thrown, and the run is not passed as measured', async () => {
  const good = JSON.stringify({ t: 'connect', host: 'api.github.com', port: 443 });
  const r = await runWith(`${good}\n{"t":"conn`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1 truncated netlog line/);
  assert.match(r.out, /api\.github\.com/);
});

test('WR-09: a netlog with network events on the allowlist still passes', async () => {
  const r = await runWith(`${JSON.stringify({ t: 'connect', host: 'api.github.com', port: 443 })}\n`);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /G6 not measured|truncated/);
});
