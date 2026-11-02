// Smoke runner (02-07, D-64): runs `claude -p` on up to 3 fixed prompts with the skill installed as a project skill in
// an empty temp folder OUTSIDE the repo. Dry-run by default: it spends nothing without --confirm and a mandatory
// --budget. One spawn per run, never respawned. Not part of the shipped skill; named run-* so `node --test` skips it.
// It is not an isolated session: the global CLAUDE.md and personal skills still load (install smoke measurement, A3).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStream, evaluateRun, expectedCommand, renderSmokeSection, FORBIDDEN_TOOLS } from './stream-parse.mjs';
import { scriptRules } from '../redteam/args.mjs';
import { materialize } from '../../tests/helpers/materialize.mjs';
import { CLEAN_REPOS } from '../../tests/fixtures/clean-repos.mjs';

export { parseStream, evaluateRun, expectedCommand, renderSmokeSection };

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const TIMEOUT_MS = 10 * 60 * 1000;
const KILL_CODES = new Set([3221225794, -1073741502]); // 0xC0000142 unsigned / signed
const KILL_SIGNATURE = /Win32 error 299|cygheap|0xC0000142/;
const PROMPTS = {
  1: 'check this repo before I open it: octocat/Hello-World',
  2: (dir) => `check this repo before I open it: ${dir}`,
  // The Run 3 evaluator reads English; the user configuration can impose another language (install smoke measurement, A3).
  3: 'I already ran npm install on a repo a client sent me. Answer in English.',
};

// Pre-approval of the skill command only, added by --allow-script-rule and never by default (review CR-B-07). The
// rules are exact (UF-01): real skill path and target, no wildcard, computed by scriptRules() in runSmoke.

/** Argument array for `claude`. Budget is mandatory; --bare, --safe-mode and --max-turns are never used. */
export function buildClaudeArgs({ prompt, budget, model, allowScriptRule = false, rules = [] }) {
  if (!(Number(budget) > 0)) throw new Error('a positive budget (--max-budget-usd) is mandatory');
  const allowed = allowScriptRule ? ['Skill', ...rules] : ['Skill'];
  const args = [
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--allowedTools', ...allowed, '--disallowedTools', FORBIDDEN_TOOLS.join(' '),
    '--max-budget-usd', String(budget), '--no-session-persistence', '--setting-sources', 'project',
    '--strict-mcp-config', '--effort', 'low',
  ];
  if (model) args.push('--model', model);
  return args;
}

/** Default spawn: argument array, shell: false, capped output, hard timeout on the whole tree. Never rejects, and
 * always settles: a second deadline (graceMs) resolves even if the kill did not close the child (review CR-B-16). */
export function claudeSpawn(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const posix = process.platform !== 'win32';
    let stdout = ''; let stderr = ''; let timedOut = false; let child; let grace; let settled = false;
    try {
      child = nodeSpawn(cmd, args, { cwd: opts.cwd, env, shell: false, windowsHide: true, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve({ code: null, stdout, stderr, error }); return; }
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ stdout, stderr, timedOut, ...r });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (!posix && child.pid) nodeSpawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      grace = setTimeout(() => finish({ code: null }), opts.graceMs ?? 30000);
    }, opts.timeoutMs ?? TIMEOUT_MS);
    // Decoded as a stream: a multibyte character split across two chunks stays one character.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < 2e7) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code) => finish({ code }));
  });
}

export const killed = (r) => KILL_CODES.has(r.code) || KILL_SIGNATURE.test(String(r.stderr ?? ''));

/** Text shown by the dry-run: exact arguments, with a placeholder instead of the not-yet-created Run 2 folder. */
export function describeRun(run, { budget, model, allowScriptRule = false }) {
  const prompt = run === 2 ? PROMPTS[2]('<fixture-folder>') : PROMPTS[run];
  // Placeholders cannot go through scriptRules (it rejects < >): build with safe tokens, then substitute.
  const rules = run === 3 ? [] : scriptRules({ skillDir: '/SKILLDIR', target: 'TARGETX' }).map((r) => r.replace('/SKILLDIR', '<skill-dir>').replace('TARGETX', run === 2 ? '<target>' : 'octocat/Hello-World'));
  const line = `claude ${buildClaudeArgs({ prompt, budget, model, allowScriptRule, rules }).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (run === 3 || allowScriptRule) return line;
  return `${line}\nnote: without --allow-script-rule, Runs 1 and 2 cannot be VERIFICATO (dontAsk denies every Bash call).`;
}

/** Executes ONE run: a single spawn, temp folders always removed. Throws only on setup errors or spawn exceptions. */
export async function runSmoke(run, { budget, model, allowScriptRule = false, spawn = claudeSpawn }) {
  const temps = [];
  try {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoflags-smoke-'));
    temps.push(cwd);
    await fsp.cp(path.join(REPO_ROOT, 'skills', 'repoflags'), path.join(cwd, '.claude', 'skills', 'repoflags'), { recursive: true });
    let prompt = PROMPTS[run];
    let expected = run === 2 ? null : expectedCommand(run);
    let targetDir;
    if (run === 2) {
      const fx = await materialize(CLEAN_REPOS[Object.keys(CLEAN_REPOS)[0]]);
      temps.push(fx.dir);
      prompt = PROMPTS[2](fx.dir);
      expected = expectedCommand(2, fx.dir);
      targetDir = fx.dir;
    }
    let rules = [];
    if (allowScriptRule && run !== 3) {
      const skillDir = fs.realpathSync.native(path.join(cwd, '.claude', 'skills', 'repoflags'));
      rules = scriptRules({ skillDir, target: run === 2 ? targetDir : 'octocat/Hello-World' });
    }
    const res = await spawn('claude', buildClaudeArgs({ prompt, budget, model, allowScriptRule, rules }), { cwd, timeoutMs: TIMEOUT_MS });
    const parsed = parseStream(res.stdout);
    if (killed(res)) return { run, prompt, parsed, raw: res.stdout, status: 'killed-before-start', verdict: 'NON VERIFICATO', reason: 'process killed before start' };
    const status = res.timedOut ? 'timeout' : res.error ? 'spawn-error' : 'done';
    const evaluation = status === 'done' ? evaluateRun(run, parsed, { expected, exitCode: res.code, targetDir }) : { verdict: 'NON VERIFICATO', reason: status };
    return { run, prompt, parsed, raw: res.stdout, status, ...evaluation, model: model ?? null };
  } finally {
    for (const d of temps) await fsp.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** Exit code: 0 ok, 1 run not verified, 2 bad usage. */
export async function cli({
  argv = process.argv, spawn = claudeSpawn, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s),
} = {}) {
  const run = Number(flag(argv, '--run'));
  const budget = Number(flag(argv, '--budget'));
  const model = flag(argv, '--model');
  const allowScriptRule = argv.includes('--allow-script-rule');
  if (![1, 2, 3].includes(run)) { writeErr('smoke: --run must be 1, 2 or 3\n'); return 2; }
  if (!(budget > 0)) { writeErr('smoke: --budget <usd> is mandatory and must be positive\n'); return 2; }
  if (!argv.includes('--confirm')) {
    write(`dry-run (nothing spent, claude not started). Add --confirm to run for real.\n${describeRun(run, { budget, model, allowScriptRule })}\n`);
    return 0;
  }
  const r = await runSmoke(run, { budget, model, allowScriptRule, spawn });
  const section = renderSmokeSection(run, { prompt: r.prompt, parsed: r.parsed, evaluation: r, model: r.model, status: r.status });
  write(section);
  const rawFile = flag(argv, '--raw');
  if (rawFile) fs.writeFileSync(rawFile, String(r.raw ?? ''));
  const out = flag(argv, '--out');
  if (out) fs.appendFileSync(out, `${section}\n`);
  return r.verdict === 'VERIFICATO' ? 0 : 1;
}

/** True when argv1 is this file, compared by realpath. */
export function isMainModule(argv1, self = SELF) {
  if (!argv1) return false;
  try {
    const a = fs.realpathSync.native(path.resolve(argv1));
    const b = fs.realpathSync.native(self);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

if (isMainModule(process.argv[1])) {
  if (process.env.NODE_TEST_CONTEXT) {
    process.stderr.write('smoke: skipped under the test runner (NODE_TEST_CONTEXT is set)\n');
    process.exit(0);
  }
  cli().then((code) => { process.exitCode = code; });
}
