// Real-repo panel runner (03-02, D-80a): runs the repoflags script on the pinned public repos, one at a time, with the
// socket-level G6 trace preload. Dry-run by default: without --confirm nothing is started. Reports and netlogs go to
// --out-dir, which must be outside this repository. Never prints the environment or a token. Named run-* so
// `node --test` skips it. Not part of the shipped skill.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REAL_PANEL } from '../../tests/fixtures/real-panel.mjs';
import { hostsOf, execCalls } from '../../tests/helpers/net-trace.mjs';
import { ALLOWED_HOSTS } from '../../skills/repoflags/scripts/lib/constants.mjs';
import { isMainModule } from '../smoke/run-claude-smoke.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'skills', 'repoflags', 'scripts', 'repoflags.mjs');
const PRELOAD = path.join(REPO_ROOT, 'tests', 'helpers', 'net-trace-preload.mjs');
const TIMEOUT_MS = 15 * 60 * 1000;
const KILL_CODES = new Set([3221225794, -1073741502]); // 0xC0000142 unsigned / signed
const SHA = /^[0-9a-f]{40}$/;

/** Argument array for node: preload, script, target pinned to its sha. Throws on an unpinned entry. */
export function panelArgs(entry, { script = SCRIPT, preload = PRELOAD } = {}) {
  if (!SHA.test(String(entry.sha ?? ''))) throw new Error(`${entry.repo}: sha not pinned (40 hex required)`);
  return ['--import', pathToFileURL(preload).href, script, entry.repo, '--ref', entry.sha, '--format', 'json'];
}

const isGhToken = (e) => path.basename(e.file).replace(/\.exe$/i, '') === 'gh' && e.args[0] === 'auth' && e.args[1] === 'token';

/** Digest of one run: finding counts, high/medium rules with file, hosts, off-allowlist hosts, child processes. */
export function summarizeReport(report, events, code, entry = {}) {
  const signals = report?.signals ?? [];
  const count = (s) => signals.filter((x) => x.severity === s).length;
  const hosts = [...hostsOf(events)];
  const execs = execCalls(events);
  return {
    repo: entry.repo ?? null,
    sha: entry.sha ?? report?.target?.sha ?? null,
    outcome: report?.outcome ?? null,
    counts: { high: count('high'), medium: count('medium'), info: count('info') },
    rules: signals.filter((x) => x.severity === 'high' || x.severity === 'medium').map((x) => ({ severity: x.severity, rule: x.rule, file: x.file })),
    hosts,
    offAllowlist: hosts.filter((h) => !ALLOWED_HOSTS.includes(h)),
    execs,
    unexpectedExecs: execs.filter((e) => !isGhToken(e)),
    killed: KILL_CODES.has(code),
    exitCode: code,
  };
}

/** Default spawn: argument array, shell: false, capped output, hard timeout. Never rejects. */
export function panelSpawn(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut, ...r }); } };
    let child;
    try { child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { resolve({ code: null, stdout, stderr, error }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); setTimeout(() => done({ code: null }), 5000); }, opts.timeoutMs ?? TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < 5e7) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    child.on('error', (error) => done({ code: null, error }));
    child.on('close', (code) => done({ code }));
  });
}

/** Netlog events; a line that is not JSON (a write cut by the timeout kill) is counted, never thrown (review WR-09). */
function readNetLogCounted(file) {
  if (!fs.existsSync(file)) return { events: [], bad: 0, present: false };
  const events = []; let bad = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { events.push(JSON.parse(l)); } catch { bad += 1; }
  }
  return { events, bad, present: true };
}

/** G6 is measured only when the netlog exists, holds network events (every panel entry is remote) and is whole. */
function g6Note(net) {
  const network = net.events.some((e) => ['connect', 'lookup', 'undici'].includes(e.t));
  const notes = [];
  if (!net.present || !network) notes.push(`G6 not measured (${net.present ? 'no network event in the netlog' : 'no netlog'})`);
  if (net.bad) notes.push(`${net.bad} truncated netlog line${net.bad > 1 ? 's' : ''}`);
  return notes.join('; ');
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const slug = (repo) => repo.replace('/', '-');
const insideRepo = (dir) => { const rel = path.relative(REPO_ROOT, dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const cell = (s) => String(s).replace(/\|/g, '/');

function row(s) {
  const base = s.killed ? 'killed before start' : s.outcome ?? `no report (exit ${s.exitCode})`;
  const status = s.g6Note ? `${base}; ${s.g6Note}` : base;
  const rules = s.rules.map((r) => `${r.severity}:${r.rule}@${r.file}`).join(', ') || '-';
  return `| ${s.repo} | ${(s.sha ?? '').slice(0, 7)} | ${cell(status)} | ${s.counts.high}/${s.counts.medium}/${s.counts.info} | ${cell(rules)} | ${s.hosts.join(', ') || '-'} | ${s.offAllowlist.join(', ') || '-'} | ${s.execs.length} |`;
}

const HEADER = '| repo | sha | outcome | high/medium/info | high+medium rules | hosts | off allowlist | child processes |\n|---|---|---|---|---|---|---|---|';

/** Exit code: 0 all executed entries inside the G6 allowlist, 1 a violation or a run without result, 2 bad usage. */
export async function cli({
  argv = process.argv, spawn = panelSpawn, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s),
} = {}) {
  const only = flag(argv, '--only');
  const entries = only ? REAL_PANEL.filter((e) => e.repo === only) : REAL_PANEL;
  if (!entries.length) { writeErr(`panel: --only ${only} is not in the panel\n`); return 2; }
  if (!argv.includes('--confirm')) {
    write('dry-run (nothing started, no network). Add --confirm and --out-dir <dir outside the repo> to run for real.\n');
    for (const e of entries) {
      const a = panelArgs({ ...e, sha: e.sha ?? '0'.repeat(40) }).map((x) => (x === '0'.repeat(40) ? e.tag : x));
      write(`node ${a.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}${e.sha ? '' : '  # sha not pinned: skipped with --confirm'}
`);
    }
    return 0;
  }
  const outDir = flag(argv, '--out-dir');
  if (!outDir || !path.isAbsolute(outDir) || insideRepo(outDir)) { writeErr('panel: --out-dir <absolute dir outside the repository> is mandatory with --confirm\n'); return 2; }
  await fsp.mkdir(outDir, { recursive: true });
  const lines = [HEADER]; let ok = true;
  for (const e of entries) {
    if (!e.sha) { lines.push(`| ${e.repo} | - | skipped: sha not pinned (tag ${e.tag}) | - | - | - | - | - |`); continue; }
    const netlog = path.join(outDir, `${slug(e.repo)}.netlog.jsonl`);
    await fsp.rm(netlog, { force: true });
    const env = { ...process.env, REPOFLAGS_NETLOG: netlog };
    delete env.NODE_TEST_CONTEXT;
    const res = await spawn(process.execPath, panelArgs(e), { cwd: outDir, env, timeoutMs: TIMEOUT_MS });
    let report = null;
    try { report = JSON.parse(res.stdout); } catch { /* no JSON: reported as a run without result */ }
    if (report) await fsp.writeFile(path.join(outDir, `${slug(e.repo)}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const net = readNetLogCounted(netlog);
    const s = { ...summarizeReport(report, net.events, res.code, e), g6Note: report ? g6Note(net) : '' };
    lines.push(row(s));
    if (s.killed || !report || s.g6Note || s.offAllowlist.length || s.unexpectedExecs.length) ok = false;
  }
  const table = `${lines.join('\n')}\n`;
  write(table);
  const out = flag(argv, '--out');
  if (out) fs.appendFileSync(out, `${table}\n`);
  return ok ? 0 : 1;
}

if (isMainModule(process.argv[1], SELF)) {
  if (process.env.NODE_TEST_CONTEXT) {
    process.stderr.write('panel: skipped under the test runner (NODE_TEST_CONTEXT is set)\n');
    process.exit(0);
  }
  cli().then((code) => { process.exitCode = code; });
}
