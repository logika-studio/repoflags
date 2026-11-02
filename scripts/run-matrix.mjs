// Local test matrix: runs `node --test` on Windows Node 18/20/22 and on Linux (WSL + nvm) Node 18/20/22/24.
// Not part of the shipped skill. Zero dependencies, shell:false, writes no files. Named run-matrix (not test-*) so
// `node --test` never discovers it; it also exits at once when started by the test runner (T-01-60).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 10 * 60 * 1000;
const KILL_CODES = new Set([3221225794, -1073741502]); // 0xC0000142 unsigned / signed
const KILL_SIGNATURE = /Win32 error 299|fork: retry|0xC0000142/;
const TEST_ARGS = ['--test', '--test-reporter=tap'];
export const WSL_PATH_OK = /^[A-Za-z0-9_@%+=:,./ -]+$/;
const SELF = fileURLToPath(import.meta.url);

/** Reads the TAP trailer (`# tests N`, `# pass N`, `# fail N`, `# skipped N`): the LAST occurrence of each line. */
export function parseTapSummary(text) {
  const lines = String(text).split(String.fromCharCode(10)).map((l) => l.trim()).reverse();
  const pick = (name) => {
    const line = lines.find((l) => l.startsWith(`# ${name} `));
    const v = line ? Number(line.slice(`# ${name} `.length)) : NaN;
    return Number.isInteger(v) ? v : null;
  };
  const tests = pick('tests');
  if (tests === null) return null;
  return { tests, pass: pick('pass') ?? 0, fail: pick('fail') ?? 0, skipped: pick('skipped') ?? 0 };
}

/**
 * The `not ok` lines of a TAP stream, each with the head of its YAML diagnostic block (`---` .. `...`), at most
 * `max` lines in all. Each failing test gets its line first and a share of the budget, so a long stack never
 * hides the next name; the excess is announced, never dropped silently (D-118).
 */
export function failureExcerpt(text, max = 20) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  lines.forEach((l, i) => {
    if (!/^\s*not ok\b/.test(l)) return;
    const yaml = [];
    if (/^\s*---\s*$/.test(lines[i + 1] ?? '')) {
      for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j += 1) yaml.push(lines[j]);
    }
    blocks.push({ head: l, yaml });
  });
  if (blocks.length === 0) return [];
  const per = Math.max(0, Math.floor((max - Math.min(blocks.length, max)) / Math.max(1, blocks.length)));
  const clip = (l) => (l.length > 300 ? `${l.slice(0, 300)} (${l.length - 300} more characters)` : l);
  const out = [];
  let cut = 0;
  for (const b of blocks) {
    if (out.length >= max) { cut += 1 + b.yaml.length; continue; }
    out.push(clip(b.head), ...b.yaml.slice(0, per).map(clip));
    cut += Math.max(0, b.yaml.length - per);
  }
  return cut > 0 ? [...out, `  (${cut} more lines not shown)`] : out;
}

// wsl.exe writes its own messages in UTF-16: drop the NUL bytes before looking for the signature.
const killed = (r) => KILL_CODES.has(r.code) || KILL_SIGNATURE.test(String(r.stderr ?? '').split('\u0000').join(''));

function stopTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      nodeSpawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      return;
    } catch { /* fall through */ }
  }
  child.kill('SIGKILL');
}

/** Default spawn: argument array, shell:false, capped output, hard timeout (whole process tree). Never rejects. */
export function realSpawn(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = nodeSpawn(cmd, args, { cwd: opts.cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; stopTree(child); }, opts.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < 2e7) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/**
 * @param {Array<{id: string, cmd: string, versionArgs: string[], testArgs: string[], cwd?: string}>} runtimes
 * @param {{spawn?: Function}} [deps]
 * A runtime whose process dies before starting is reported as `killed-before-start` and is never rerun here.
 */
export async function runMatrix(runtimes, { spawn = realSpawn } = {}) {
  const rows = [];
  for (const rt of runtimes) {
    const row = { runtime: rt.id, version: 'N/D', tests: null, pass: null, fail: null, skipped: null, status: 'not-available' };
    rows.push(row);
    const probe = await spawn(rt.cmd, rt.versionArgs, { cwd: rt.cwd });
    if (killed(probe)) { row.status = 'killed-before-start'; continue; }
    if (probe.error || probe.code !== 0) continue;
    row.version = String(probe.stdout).trim().split(/\r?\n/).pop();
    const res = await spawn(rt.cmd, rt.testArgs, { cwd: rt.cwd, timeoutMs: TIMEOUT_MS });
    const summary = parseTapSummary(res.stdout);
    if (summary) Object.assign(row, summary);
    if (res.timedOut) { row.status = 'timeout'; continue; }
    if (!summary && killed(res)) { row.status = 'killed-before-start'; continue; }
    if (res.error) { row.status = 'not-available'; continue; }
    if (!summary) { row.status = 'no-summary'; continue; }
    if (summary.tests === 0) { row.status = 'no-tests'; continue; }
    row.status = res.code === 0 && summary.fail === 0 ? 'pass' : 'fail';
    if (row.status === 'fail') { const f = failureExcerpt(res.stdout); if (f.length > 0) row.failures = f; }
  }
  return rows;
}

/**
 * Fixed runtime list. Paths come from the environment, never hard-coded user names. The suite runs from tests/
 * (like `npm test` and CI), so .claude/worktrees and .planning are never collected (review tests WR-10).
 */
export function buildRuntimes({ repoRoot, wslRoot, userProfile }) {
  const portable = (v) => path.join(userProfile ?? '', '.local', 'node-versions', `node-v${v}-win-x64`, 'node.exe');
  const win = [
    { id: 'windows-node-22 (PATH)', cmd: 'node' },
    { id: 'windows-node-18.20.8', cmd: portable('18.20.8') },
    { id: 'windows-node-20.20.2', cmd: portable('20.20.2') },
  ].map((r) => ({ ...r, versionArgs: ['--version'], testArgs: TEST_ARGS, cwd: path.join(repoRoot, 'tests') }));
  const linux = [18, 20, 22, 24].map((v) => ({
    id: `linux-wsl-node-${v}`,
    cmd: 'wsl.exe',
    versionArgs: ['-e', 'bash', '-lc', `. ~/.nvm/nvm.sh && nvm exec ${v} node --version`],
    testArgs: ['-e', 'bash', '-lc', `. ~/.nvm/nvm.sh && cd "${wslRoot}/tests" && nvm exec ${v} node ${TEST_ARGS.join(' ')}`],
  }));
  return [...win, ...linux];
}

export function toMarkdown(rows) {
  const head = '| runtime | version | tests | pass | fail | skipped | status |\n|---|---|---|---|---|---|---|';
  const cell = (v) => (v === null ? 'N/D' : String(v));
  const body = rows.map((r) => `| ${r.runtime} | ${r.version} | ${cell(r.tests)} | ${cell(r.pass)} | ${cell(r.fail)} | ${cell(r.skipped)} | ${r.status} |`);
  return [head, ...body].join('\n');
}

/** Runs the matrix and prints the table. Returns the exit code: 0 all pass, 1 otherwise, 2 unusable repository path. */
export async function cli({
  spawn = realSpawn, env = process.env, argv = process.argv, repoRoot = path.resolve(path.dirname(SELF), '..'),
  write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s),
} = {}) {
  const conv = await spawn('wsl.exe', ['-e', 'wslpath', '-a', repoRoot]);
  const wslRoot = conv.code === 0 ? String(conv.stdout).trim() : '';
  if (wslRoot && !WSL_PATH_OK.test(wslRoot)) {
    writeErr('run-matrix: unsupported characters in the repository path for WSL\n');
    return 2;
  }
  const all = buildRuntimes({ repoRoot, wslRoot, userProfile: env.USERPROFILE });
  const runtimes = wslRoot ? all : all.filter((r) => !r.id.startsWith('linux-'));
  const rows = await runMatrix(runtimes, { spawn });
  // A wslpath that died before starting is a missing outcome, not a missing WSL (review A WR-09); never rerun here.
  const pad = killed(conv) ? 'killed-before-start' : 'not-available';
  if (!wslRoot) for (const r of all.filter((x) => x.id.startsWith('linux-'))) rows.push({ runtime: r.id, version: 'N/D', tests: null, pass: null, fail: null, skipped: null, status: pad });
  for (const r of rows) if (r.failures) writeErr(`--- ${r.runtime}: failing tests\n${r.failures.join('\n')}\n`);
  write(argv.includes('--json') ? `${JSON.stringify(rows, null, 2)}\n` : `${toMarkdown(rows)}\n`);
  return rows.length === 7 && rows.every((r) => r.status === 'pass') ? 0 : 1;
}

/** True when `argv1` is this file, compared by realpath (symlinks, drive letter case and 8.3 names on Windows). */
export function isMainModule(argv1, self = SELF) {
  if (!argv1) return false;
  try {
    const a = fs.realpathSync.native(path.resolve(argv1));
    const b = fs.realpathSync.native(self);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

const isMain = isMainModule(process.argv[1]);
if (!isMain && /^run-matrix\.mjs$/i.test(path.basename(process.argv[1] ?? ''))) {
  // Started by name but not recognized as this file: say so instead of exiting 0 with nothing done (WR-05).
  process.stderr.write('run-matrix: could not recognize the script path as this file; nothing was run\n');
  process.exit(2);
}
if (isMain && process.env.NODE_TEST_CONTEXT) {
  // Started as a script by the test runner (discovery or recursion): do nothing, but say so (WR-04, WR-05).
  process.stderr.write('run-matrix: skipped under the test runner (NODE_TEST_CONTEXT is set)\n');
  process.exit(0);
}
if (isMain) cli().then((code) => { process.exitCode = code; });
