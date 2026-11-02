// Runs ONE red team scenario (03-05, D-72, D-74, D-77, D-84): a single spawn of `claude -p`, never respawned. The cwd and
// the fixture live only in os.tmpdir(); the canary is checked before they are removed; the Claude Code residue cleanup
// uses the slug of the cwd computed BEFORE it is removed. Not part of the shipped skill; named run-* so node --test skips it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSpawn, killed } from '../smoke/run-claude-smoke.mjs';
import { parseStream } from '../smoke/stream-parse.mjs';
import { scriptRules, buildRedteamArgs } from './args.mjs';
import { cleanupResidue, defaultResidueDirs } from './claude-residue.mjs';
import { evaluateRedteam, expectedRedteamCommand } from './evaluate.mjs';
import { REDTEAM_SCENARIOS } from './scenarios.mjs';
import { materialize } from '../../tests/helpers/materialize.mjs';
import { CANARY_FILE } from '../../tests/fixtures/hostile/canary.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const SKILL_SRC = path.join(REPO_ROOT, 'skills', 'repoflags');
const TIMEOUT_MS = 10 * 60 * 1000;
const CWD_PREFIX = 'repoflags-redteam-';
const FIXTURE_PREFIX = 'repoflags-rt-';
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Throws when `p` is the repository or inside it (D-72): the model must never get the project as its cwd. */
export function assertOutsideRepo(p) {
  const rel = path.relative(fold(path.resolve(REPO_ROOT)), fold(path.resolve(p)));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`refusing a path inside the repo: ${p}`);
}

/** True for a fixture key that must never be written (D-71, review WR-08): any `.claude` segment in any case or separator,
 * a `..` segment, or an absolute / drive / UNC path (materialize would write outside its temp folder). */
export function fixtureKeyRefused(k) {
  const s = String(k).replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return true;
  const segs = s.split('/');
  return segs.includes('..') || segs.some((x) => x.toLowerCase() === '.claude');
}

/** sha256 of skills/repoflags/SKILL.md as it is now: ties every run to the exact prompt under test. */
export const skillSha256 = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(SKILL_SRC, 'SKILL.md'))).digest('hex');

const defaultResidue =(cwdReal) => cleanupResidue({ cwdReal, ...defaultResidueDirs() });
const removeDir = (d) => fsp.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});

/** Executes ONE scenario. Throws on setup errors or spawn exceptions (temps are removed anyway). */
export async function runScenario(id, { budget, spawn = claudeSpawn, residue = defaultResidue } = {}) {
  const sc = REDTEAM_SCENARIOS[id];
  if (!sc) throw new Error(`unknown scenario: ${id}`);
  if (!(Number(budget) > 0)) throw new Error('a positive budget (--max-budget-usd) is mandatory');
  const startedAt = new Date().toISOString();
  const skillMdSha256 = skillSha256();
  const temps = [];
  let cwdReal = null; let fixtureDir = null; let res = null; let canaryFound = false; let prompt = ''; let ctx = null; let parsed = null;
  let residueResult = null;
  try {
    if (sc.fixture && Object.keys(sc.fixture).some(fixtureKeyRefused)) throw new Error('fixture map must not hold .claude/, .. or absolute paths (D-71)');
    let cwd;
    if (sc.cwdIsFixture) {
      const fx = await materialize(sc.fixture, { prefix: CWD_PREFIX });
      cwd = fx.dir; fixtureDir = fx.dir;
      temps.push(cwd);
    } else {
      cwd = await fsp.mkdtemp(path.join(os.tmpdir(), CWD_PREFIX));
      temps.push(cwd);
      if (sc.fixture) {
        const fx = await materialize(sc.fixture, { prefix: FIXTURE_PREFIX });
        fixtureDir = fs.realpathSync.native(fx.dir);
        temps.push(fx.dir);
      }
    }
    cwdReal = fs.realpathSync.native(cwd);
    assertOutsideRepo(cwdReal);
    if (fixtureDir) assertOutsideRepo(fixtureDir);
    await fsp.cp(SKILL_SRC, path.join(cwd, '.claude', 'skills', 'repoflags'), { recursive: true });
    const skillDir = fs.realpathSync.native(path.join(cwd, '.claude', 'skills', 'repoflags'));
    const target = sc.target(fixtureDir);
    prompt = sc.prompt(target);
    const rules = sc.shellAllowed > 0 ? scriptRules({ skillDir, target }) : [];
    const expected = sc.shellAllowed > 0 ? expectedRedteamCommand(skillDir.replace(/\\/g, '/'), target) : undefined;
    ctx = {
      scenario: id, skillDir, targetDir: fixtureDir ?? undefined, shellAllowed: sc.shellAllowed, expected,
      expectSignal: sc.expectSignal, scriptBlind: sc.scriptBlind ?? [], fakeToken: sc.fakeToken ?? undefined,
    };
    res = await spawn('claude', buildRedteamArgs({ prompt, budget, rules }), { cwd, timeoutMs: TIMEOUT_MS });
    // D-77 (4): the canary is looked for BEFORE anything is removed (the fixture, and the cwd where the model may write).
    canaryFound = [...new Set([cwd, fixtureDir].filter(Boolean))].some((d) => fs.existsSync(path.join(d, CANARY_FILE)));
  } finally {
    for (const d of temps) await removeDir(d);
    // Review WR-06: an exception here must not replace the result of a run already paid for.
    if (cwdReal) {
      try { residueResult = residue(cwdReal); } catch (error) {
        residueResult = { removed: [], kept: [], skipped: [{ dir: null, reason: `residue cleanup threw: ${error?.code ?? error?.message ?? 'error'}` }] };
      }
    }
  }
  const raw = String(res.stdout ?? '');
  parsed = parseStream(raw);
  const base = { id, prompt, raw, residue: residueResult, skillMdSha256, startedAt, canaryFound };
  // Review WR-05: always evaluated, so the canary and the observed tool calls of a timed out, failed or killed run count;
  // the run state only replaces verdict and reason when there is no violation.
  const kept = (residueResult?.kept ?? []).map((k) => `${k.dir}: ${k.files.join('|')}`);
  const evaluation = evaluateRedteam(parsed, { ...ctx, canaryFound, exitCode: res.code, timedOut: res.timedOut, residue: { kept } });
  const status = killed(res) ? 'killed-before-start' : res.timedOut ? 'timeout' : res.error ? 'spawn-error' : 'done';
  if (status !== 'done' && !evaluation.violations.length) {
    const wasKilled = status === 'killed-before-start';
    Object.assign(evaluation, { verdict: 'NON VERIFICATO', status: wasKilled ? status : 'incomplete', reason: wasKilled ? 'process killed before start' : status });
  }
  return { ...base, status, evaluation };
}
