// Pipeline: acquire -> rules -> dependencies -> intel -> chains -> report. Never writes to disk, no telemetry.
import fs from 'node:fs';
import { resolveTarget } from './acquire/target.mjs';
import { createLimits } from './acquire/limits.mjs';
import { acquireLocal } from './acquire/local.mjs';
import { acquireGithub } from './acquire/github.mjs';
import { runRules } from './rules/index.mjs';
import { collectDependencies } from './rules/deps/collect.mjs';
import { applyChains } from './rules/chain.mjs';
import { applyUserConfig } from './config/apply.mjs';
import { resolveConfigLoads } from './rules/config-resolution.mjs';
import { runIntel } from './intel/index.mjs';
import { buildReport } from './report/build.mjs';
import { withScanBudget } from './util/text-scan.mjs';
import { redactReport } from './util/sanitize.mjs';
import { AnalyzeError } from './errors.mjs';

// A scan stopped by the regex time budget is something the file author can provoke on purpose (padding):
// it is a signal, so that it can never end in "no signals found" (review CR-03).
function scanIncomplete(count) {
  return {
    rule: 'scan-incomplete', severity: 'medium', title: 'Some content could not be fully scanned within the time budget',
    file: null, line: null, evidence: `${count} scan(s) stopped by the regex time budget; files are listed under not verified`, refs: [],
  };
}

// NP-01: limits the repository author can reach on purpose (padding a file past maxFileBytes, flooding maxFiles)
// leave selected files unread. Those files are what the rules read, so this is a signal and never "no signals".
export function skippedFiles(skipped) {
  const byKind = new Map();
  for (const s of skipped) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const kinds = [...byKind].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ');
  return {
    rule: 'limits-skipped-critical', severity: 'medium', title: 'Files the rules inspect were not read because of a limit',
    file: skipped[0].path, line: null, evidence: `${skipped.length} selected file(s) not read, by kind: ${kinds}; listed under not verified`, refs: [],
  };
}

function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} target folder path, owner/repo or GitHub URL
 * @param {{ref?: string|null, offline?: boolean, limits?: object}} options
 * @param {{fetch?: Function, env?: object, execGh?: Function, now?: () => Date, exists?: (p: string) => boolean, secrets?: Set<string>}} deps
 */
export async function analyze(target, options = {}, deps = {}) {
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const resolved = resolveTarget(target, { ref: options.ref ?? null, exists });
  if (resolved.type === 'local' && !isFolder(resolved.path)) {
    throw new AnalyzeError('target is not a folder: extract an archive first, then pass the folder');
  }
  const mode = options.offline ? 'offline' : 'online';
  if (resolved.type === 'github' && mode === 'offline') {
    throw new AnalyzeError('a remote target cannot be analyzed with --offline');
  }

  const limits = createLimits(options.limits ?? {});
  const secrets = deps.secrets ?? new Set();
  // Values the analyzed repository chose (e.g. a committed token): masked only inside repository text fields of the
  // report, never across the whole output, where they could rewrite keys and enums (review rules CR-01).
  const repoSecrets = new Set();
  const ctx = {
    options: { ...options, limits: limits.values },
    mode,
    fetch: deps.fetch ?? globalThis.fetch,
    env: deps.env ?? process.env,
    execGh: deps.execGh,
    now: deps.now ?? (() => new Date()),
    signal: AbortSignal.timeout(limits.values.globalTimeoutMs),
    network: { hosts: {} },
    rate: { remaining: null, reset: null },
    registryResolved: new Set(), // names whose packument the public registry served (intel/registry)
    secrets,
    addSecret: (value) => secrets.add(String(value)),
    addRepoSecret: (value) => repoSecrets.add(String(value)),
    limits,
  };

  const acquired =
    resolved.type === 'local'
      ? await acquireLocal(resolved.path, ctx)
      : await acquireGithub({ owner: resolved.owner, repo: resolved.repo, ref: resolved.ref }, ctx);

  // Nothing read although files were selected: no analysis happened, so no outcome either (review CR-04).
  if (acquired.files.size === 0 && acquired.unread > 0) {
    throw new AnalyzeError(`none of the ${acquired.unread} selected files could be read (limits, read errors, rate limit or timeout): nothing was analyzed`);
  }
  if (acquired.files.size === 0 && acquired.timedOut === true) {
    throw new AnalyzeError('the global timeout stopped the folder walk before any file was read: nothing was analyzed');
  }

  // The rules phase has its own cumulative budget equal to the global timeout (review WR-08): acquisition may
  // already have used the global one, and the rules must still run on what was read.
  const scan = withScanBudget(Date.now() + limits.values.globalTimeoutMs, () => runRules(acquired.files, ctx));
  const rules = scan.result;
  if (scan.timeouts) rules.signals.push(scanIncomplete(scan.timeouts));
  if (acquired.skipped?.length) rules.signals.push(skippedFiles(acquired.skipped));
  if (scan.exhausted) {
    limits.markReached('globalTimeoutMs');
    rules.notVerified.push({ check: 'rules', reason: 'global timeout reached while scanning: later files only partly scanned or not scanned' });
  }
  const collected = collectDependencies(acquired.files);
  const intel = await runIntel({ acquired, deps: collected.deps, signals: rules.signals }, ctx);

  const base = resolveConfigLoads([...rules.signals, ...collected.signals, ...intel.signals], {
    deps: collected.deps, notVerified: intel.notVerified, resolved: ctx.registryResolved, files: acquired.files, mode,
  });
  const checked = [...acquired.notVerified, ...rules.notVerified, ...collected.notVerified, ...intel.notVerified];
  const chains = applyChains(base, { deps: collected.deps, notVerified: checked });

  // Late filter (D-58): after the chains, so a switched-off component rule cannot dissolve a chain.
  const filtered = applyUserConfig([...base, ...chains.signals], { disabledRules: options.disabledRules ?? [] });

  const report = buildReport({
    acquired,
    signals: filtered.signals,
    notVerified: [
      ...acquired.notVerified,
      ...rules.notVerified,
      ...collected.notVerified,
      ...intel.notVerified,
      ...chains.notVerified,
      ...filtered.notVerified,
    ],
    ctx,
  });
  return redactReport(report, repoSecrets);
}
