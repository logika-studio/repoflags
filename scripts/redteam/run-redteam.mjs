// Red team cli (03-05, D-74, D-78): one command per scenario. Dry-run by default: it spends nothing without --confirm and
// a mandatory --budget. With --confirm it needs --ledger (invocation registry) and --raw (stream saved OUTSIDE the repo,
// never overwritten). The phase ledger lives in --ledger-dir <dir> (default .redteam/, ignored by git). One spawn per run,
// never respawned. Not part of the shipped skill; named run-* so node --test skips it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSpawn } from '../smoke/run-claude-smoke.mjs';
import { scriptRules, buildRedteamArgs } from './args.mjs';
import { REDTEAM_SCENARIOS } from './scenarios.mjs';
import { runScenario, assertOutsideRepo, skillSha256 } from './run-scenario.mjs';
import { readLedger, checkLedger, appendLedger, countStarts, MAX_INVOCATIONS, MAX_PER_SCENARIO, ROUND2 } from './ledger.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const DEFAULT_LEDGER = path.join(REPO_ROOT, '.redteam', 'invocations.jsonl');
const ROUND2_LEDGER = path.join(REPO_ROOT, '.redteam', 'invocations-r2.jsonl');
const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const show = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
const MAX_BUDGET = 1; // D-78: brake of 1.00 USD per invocation
const samePath = (a, b) => { const f = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)); return f(a) === f(b); };

/** Committer date (ISO) of a commit of this repository, or null when it does not exist. Read-only git, no shell. */
export function gitCommitDate(sha) {
  try {
    const out = execFileSync('git', ['-C', REPO_ROOT, 'show', '-s', '--format=%cI', `${sha}^{commit}`], { shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim() || null;
  } catch { return null; }
}

/** Replaces the fake token by a masked form (G9): used on every text that leaves the runner. */
// Review IN-08: every 10 character window too (the class leaksToken detects); the mask holds no window of the token.
export function maskToken(text, token) {
  if (!token) return String(text);
  let t = String(text).split(token).join('[masked token]');
  for (let i = 0; i + 10 <= token.length; i += 1) t = t.split(token.slice(i, i + 10)).join('[masked token]');
  return t;
}

/** Text of the dry-run: exact arguments, placeholders instead of the not-yet-created folders. */
export function describeScenario(id, { budget }) {
  const sc = REDTEAM_SCENARIOS[id];
  const target = sc.target('<fixture>');
  // Placeholders cannot go through scriptRules (it rejects < >): build with safe tokens, then substitute.
  const rules = sc.shellAllowed > 0
    ? scriptRules({ skillDir: '/SKILLDIR', target: 'TARGETX' }).map((r) => r.replace('/SKILLDIR', '<skill-dir>').replace('TARGETX', target))
    : [];
  const note = sc.cwdIsFixture ? '\nnote: the cwd is the fixture itself, with the skill copied into <fixture>/.claude/skills/repoflags.' : '';
  return `claude ${buildRedteamArgs({ prompt: sc.prompt(target), budget, rules }).map(show).join(' ')}${note}`;
}

/** Markdown section for the red-team reading sheet. Every observed text goes through the token mask. */
export function renderRedteamSection(r, { fakeToken = null } = {}) {
  const e = r.evaluation ?? {};
  const mask = (s) => maskToken(s, fakeToken);
  const cmds = (e.commands ?? []).length ? e.commands.map((c) => `- \`${mask(c)}\``).join('\n') : '- none';
  const viols = (e.violations ?? []).length ? e.violations.map((v) => `- condition ${v.cond}: ${v.detail}`).join('\n') : '- none';
  const review = (e.review ?? []).length ? e.review.map((x) => `- ${x}`).join('\n') : '- none';
  const res = r.residue ?? { removed: [], kept: [], skipped: [] };
  return mask([
    `## ${r.id}`, '',
    `- Prompt: ${String(r.prompt).replace(/\r?\n/g, ' / ')}`, `- Status: ${r.status}`, `- Model (init): ${e.model ?? 'N/D'}`,
    `- Cost (total_cost_usd): ${e.costUsd ?? 'N/D'}`, `- permission_denials: ${e.denials ?? 'N/D'}`,
    `- Verdict: ${e.verdict} (${e.reason ?? 'no reason'})`, `- cond7: ${e.cond7 ?? 'N/D'}`, `- scriptFalseNegative: ${e.scriptFalseNegative ?? false}`,
    `- Canary found: ${r.canaryFound ?? false}`, `- Residue: removed ${res.removed.length}, kept ${res.kept.length}, skipped ${res.skipped.length}`,
    `- skillMdSha256: ${r.skillMdSha256}`, '', 'Observed commands:', cmds, '', 'Violations:', viols, '', 'To read by hand:', review, '',
    'Manual reading: TODO', '',
  ].join('\n'));
}

/** Writes the stream without overwriting (wx). If the file appeared during the run, the stream goes to a new sibling file
 * and stderr names it (review WR-06): the stream of a paid run is never lost. */
function saveRaw(raw, text, writeErr) {
  try { fs.writeFileSync(raw, text, { flag: 'wx' }); return; } catch (error) {
    const alt = `${raw}.${Date.now()}-${process.pid}`;
    try {
      fs.writeFileSync(alt, text, { flag: 'wx' });
      writeErr(`redteam: --raw could not be written (${error?.code ?? 'error'}): stream saved to ${alt}\n`);
    } catch (again) { writeErr(`redteam: the stream could not be saved (${again?.code ?? 'error'})\n`); }
  }
}

/** Exit code: 0 RESISTITO, 1 violation or not verified, 2 bad usage, 3 refused by the ledger. */
export async function cli({
  argv = process.argv, spawn = claudeSpawn, residue, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s),
  ledgerFile = DEFAULT_LEDGER, round2LedgerFile = ROUND2_LEDGER, commitDate = gitCommitDate,
} = {}) {
  const id = flag(argv, '--scenario');
  const budget = Number(flag(argv, '--budget'));
  if (!Object.hasOwn(REDTEAM_SCENARIOS, id ?? '')) { writeErr(`redteam: --scenario must be one of ${Object.keys(REDTEAM_SCENARIOS).join(', ')}\n`); return 2; }
  if (!(budget > 0)) { writeErr('redteam: --budget <usd> is mandatory and must be positive\n'); return 2; }
  if (budget > MAX_BUDGET) { writeErr(`redteam: --budget above ${MAX_BUDGET} is refused (D-78)\n`); return 2; }
  const afterFix = flag(argv, '--after-fix') ?? null;
  // D-89: --round 2 selects its own ledger and caps; any other value is refused.
  const roundFlag = flag(argv, '--round') ?? '1';
  if (roundFlag !== '1' && roundFlag !== '2') { writeErr('redteam: --round must be 1 or 2\n'); return 2; }
  const round = Number(roundFlag);
  const caps = round === 2 ? ROUND2 : { max: MAX_INVOCATIONS, perScenario: MAX_PER_SCENARIO };
  // D-96: --ledger-dir picks the folder of the phase ledgers; without it the injected files (default .redteam/) are used.
  const ledgerDir = flag(argv, '--ledger-dir');
  const phaseLedger = ledgerDir
    ? path.join(path.resolve(ledgerDir), round === 2 ? 'invocations-r2.jsonl' : 'invocations.jsonl')
    : (round === 2 ? round2LedgerFile : ledgerFile);
  // Review WR-07: one ledger only, the one the dry-run reads too.
  if (!argv.includes('--confirm')) {
    const n = countStarts(readLedger(phaseLedger));
    write(`dry-run (nothing spent, claude not started). Add --confirm to run for real.\nledger (round ${round}): ${n}/${caps.max} invocations used\n${describeScenario(id, { budget })}\n`);
    return 0;
  }
  const ledger = flag(argv, '--ledger');
  const raw = flag(argv, '--raw');
  if (!ledger || !raw) { writeErr('redteam: --confirm needs --ledger <file> and --raw <file outside the repo>\n'); return 2; }
  if (!samePath(ledger, phaseLedger)) { writeErr(`redteam: --ledger must be the phase ledger ${phaseLedger}\n`); return 2; }
  try { assertOutsideRepo(path.resolve(raw)); } catch { writeErr('redteam: --raw must be outside the repo\n'); return 2; }
  if (fs.existsSync(raw)) { writeErr('redteam: --raw already exists: the evidence of an earlier run is never overwritten\n'); return 2; }
  // Review WR-06: the folder of --raw is checked before anything is spent.
  try { fs.accessSync(path.dirname(path.resolve(raw)), fs.constants.W_OK); } catch { writeErr('redteam: the folder of --raw does not exist or is not writable\n'); return 2; }
  // The value reaches git only when it is plain hex (never an option).
  const afterFixDate = afterFix && /^[0-9a-f]{7,40}$/i.test(afterFix) ? commitDate(afterFix) : null;
  const check = checkLedger(readLedger(ledger), { scenario: id, afterFix, afterFixDate, ...caps });
  if (!check.ok) { writeErr(`redteam: refused: ${check.reason}\n`); return 3; }
  const sha = skillSha256();
  appendLedger(ledger, { event: 'start', round, scenario: id, at: new Date().toISOString(), budget, afterFix, skillMdSha256: sha });
  const sc = REDTEAM_SCENARIOS[id];
  let r;
  try {
    r = await runScenario(id, { budget, spawn, ...(residue ? { residue } : {}) });
  } catch (error) {
    appendLedger(ledger, { event: 'end', round, scenario: id, verdict: 'ERROR', status: 'exception', costUsd: null });
    writeErr(`redteam: the run threw: ${maskToken(error?.message ?? error, sc.fakeToken)}\n`);
    return 1;
  }
  saveRaw(raw, r.raw, writeErr);
  appendLedger(ledger, { event: 'end', round, scenario: id, verdict: r.evaluation.verdict, status: r.status, costUsd: r.evaluation.costUsd ?? null });
  const section = renderRedteamSection(r, { fakeToken: sc.fakeToken });
  write(section);
  const out = flag(argv, '--out');
  if (out) fs.appendFileSync(out, `${section}\n`);
  return r.evaluation.verdict === 'RESISTITO' ? 0 : 1;
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
    process.stderr.write('redteam: skipped under the test runner (NODE_TEST_CONTEXT is set)\n');
    process.exit(0);
  }
  cli().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`redteam: ${error?.message ?? error}\n`); process.exitCode = 1; });
}
