#!/usr/bin/env node
// repoflags CLI: static pre-open check for an unknown repository. Nothing from the target is executed.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { analyze } from './lib/analyze.mjs';
import { renderText } from './lib/report/text.mjs';
import { redactAll, sanitizeEvidence } from './lib/util/sanitize.mjs';
import { OUTCOME_JSON } from './lib/constants.mjs';
import { AnalyzeError } from './lib/errors.mjs';
import { loadUserConfig } from './lib/config/locate.mjs';
import { parseLimitValue } from './lib/config/validate.mjs';

const USAGE = `Usage: repoflags <folder | owner/repo | github-url> [options]

Options:
  --ref <ref>                  branch, tag or SHA (remote targets)
  --format <text|json>         output format (default: text)
  --offline                    no network (local folders only)
  --config <path>              user configuration file (JSON); default ~/.config/repoflags/config.json
  --max-file-bytes <n>         per-file size limit
  --max-lockfile-bytes <n>     lockfile size limit
  --max-files <n>              maximum number of files read
  --max-total-bytes <n>        maximum total bytes read
  --timeout <seconds>          global timeout
  --request-timeout <seconds>  per-request timeout
  --help                       show this help

Exit codes: 0 no signals found by these rules, 1 signals found, 2 error.
`;

// No `default` here: parseArgs supports it only from Node 18.11, engines says >=18.3 (review WR-04).
export const OPTIONS = {
  ref: { type: 'string' },
  format: { type: 'string' },
  offline: { type: 'boolean' },
  config: { type: 'string' },
  'max-file-bytes': { type: 'string' },
  'max-lockfile-bytes': { type: 'string' },
  'max-files': { type: 'string' },
  'max-total-bytes': { type: 'string' },
  timeout: { type: 'string' },
  'request-timeout': { type: 'string' },
  help: { type: 'boolean' },
};

// flag -> [limits key, multiplier]
const LIMIT_FLAGS = {
  'max-file-bytes': ['maxFileBytes', 1],
  'max-lockfile-bytes': ['maxLockfileBytes', 1],
  'max-files': ['maxFiles', 1],
  'max-total-bytes': ['maxTotalBytes', 1],
  timeout: ['globalTimeoutMs', 1000],
  'request-timeout': ['requestTimeoutMs', 1000],
};

function parseLimits(values) {
  const limits = {};
  for (const [flag, [key, mult]] of Object.entries(LIMIT_FLAGS)) {
    const raw = values[flag];
    if (raw === undefined) continue;
    limits[key] = parseLimitValue(raw, `--${flag}`, mult);
  }
  return limits;
}

function useColor(io, deps) {
  const tty = io.isTTY === true || Boolean(io.stdout && io.stdout.isTTY);
  return tty && !(deps.env ?? process.env).NO_COLOR;
}

/** @returns {Promise<number>} exit code */
export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }, deps = {}) {
  const secrets = new Set();
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
    } catch (e) {
      throw new AnalyzeError(sanitizeEvidence(e.message));
    }
    const { values, positionals } = parsed;
    const format = values.format ?? 'text';
    if (values.help === true) {
      io.stdout.write(USAGE);
      return 0;
    }
    if (positionals.length !== 1) throw new AnalyzeError('exactly one target is required');
    if (format !== 'text' && format !== 'json') throw new AnalyzeError('--format must be text or json');

    const flagLimits = parseLimits(values);
    // Flag > env > home; never the analyzed folder (D-54). The flags win over the `limits` of the file (D-55).
    const cfg = loadUserConfig({ flag: values.config, target: positionals[0] }, deps);
    const options = {
      ...(cfg ? cfg.options : {}),
      ref: values.ref ?? null,
      offline: values.offline === true,
      limits: { ...(cfg ? cfg.options.limits : {}), ...flagLimits },
      configFacts: cfg ? cfg.facts : null,
    };
    const report = await analyze(positionals[0], options, { ...deps, secrets });
    const output =
      format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderText(report, { color: useColor(io, deps) });
    io.stdout.write(redactAll(output, secrets));
    return report.outcome === OUTCOME_JSON.found ? 1 : 0;
  } catch (e) {
    const known = e instanceof AnalyzeError;
    const msg = sanitizeEvidence(e && e.message ? e.message : String(e));
    const text = known ? `repoflags: ${msg}\n\n${USAGE}` : `repoflags: unexpected error: ${msg}\n`;
    io.stderr.write(redactAll(text, secrets));
    return 2;
  }
}

/** Real path of `p` (symlinks and junctions resolved), or the plain resolved path when it cannot be read. */
function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Both sides are compared as real paths: reached through a symlink or a junction (typical skill install),
// argv[1] differs from import.meta.url, and a plain comparison would exit 0 without output (review CR-01).
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  // realUser: only the real entry point reads REPOFLAGS_CONFIG and the home config (review WR-A-03).
  main(process.argv.slice(2), undefined, { realUser: true }).then((code) => {
    process.exitCode = code;
  });
}
