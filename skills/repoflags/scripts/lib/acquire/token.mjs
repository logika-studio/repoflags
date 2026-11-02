// GitHub token resolution (D-09): GH_TOKEN -> GITHUB_TOKEN -> `gh auth token` -> anonymous.
// The only module of lib/ allowed to import child_process. Fixed argv, no shell. The token is never logged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);
const memo = new WeakMap();
// Programs CreateProcess runs without a shell: a .cmd/.bat would need one (T-01-42).
const WIN_EXTS = new Set(['.exe', '.com']);

const envVar = (env, name) => {
  const key = Object.keys(env ?? {}).find((k) => k.toUpperCase() === name);
  return key ? String(env[key]) : '';
};

function isProgram(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * T-01-42 (G1): absolute path of `gh` from the ABSOLUTE PATH entries only. Empty, `.`, relative entries and the
 * current folder are skipped: Node 18/20 on Windows would otherwise run a gh.exe planted in the analyzed repository.
 * `platform` and `probe` are injected only by tests, to check the win32 rules on any host with synthetic paths.
 * @returns {string|null}
 */
export function findGh(env, { platform = process.platform, cwd = process.cwd(), isProgram: probe = isProgram } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const here = p.resolve(cwd);
  const exts = platform === 'win32'
    ? (envVar(env, 'PATHEXT') || '.COM;.EXE').split(';').map((e) => e.trim().toLowerCase()).filter((e) => WIN_EXTS.has(e))
    : [''];
  for (let dir of envVar(env, 'PATH').split(platform === 'win32' ? ';' : ':')) {
    dir = dir.trim();
    if (platform === 'win32') dir = dir.replace(/^"(.*)"$/, '$1');
    // On win32 only drive-absolute entries (`C:\…`): `\dir` depends on the current drive, UNC on a share.
    const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(dir) : p.isAbsolute(dir);
    if (!absolute || same(p.resolve(dir), here)) continue;
    for (const ext of exts) {
      const file = p.join(dir, `gh${ext}`);
      if (probe(file, platform)) return file;
    }
  }
  return null;
}

async function defaultExecGh(args, env) {
  const gh = findGh(env);
  if (!gh) throw new Error('gh not found on the absolute PATH entries');
  const { stdout } = await execFileP(gh, args, { timeout: 5000, windowsHide: true, shell: false });
  return stdout;
}

function clean(value) {
  const s = typeof value === 'string' ? value : value && typeof value.stdout === 'string' ? value.stdout : '';
  return s.trim() || null;
}

/** @returns {Promise<string|null>} the token, or null for anonymous access */
export function resolveToken(ctx) {
  if (!memo.has(ctx)) {
    memo.set(
      ctx,
      (async () => {
        const env = ctx.env ?? {};
        let token = clean(env.GH_TOKEN) ?? clean(env.GITHUB_TOKEN);
        if (!token) {
          try {
            // --hostname: without it gh answers for GH_HOST or its default host, whose token must not reach api.github.com (WR-02).
            token = clean(await (ctx.execGh ?? defaultExecGh)(['auth', 'token', '--hostname', 'github.com'], env));
          } catch {
            token = null;
          }
        }
        if (token) ctx.addSecret(token);
        return token;
      })(),
    );
  }
  return memo.get(ctx);
}
