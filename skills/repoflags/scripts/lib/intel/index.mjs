// Runs the network-backed checks. Offline mode never calls them; failures degrade to notVerified (D-18).
import * as osv from './osv.mjs';
import * as registry from './registry.mjs';
import * as githubMeta from './github-meta.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

export const INTEL_MODULES = [osv, registry, githubMeta];

export async function runIntel(input, ctx, modules = INTEL_MODULES) {
  const signals = [];
  const notVerified = [];
  const isLocal = input.acquired.target.type === 'local';
  for (const mod of modules) {
    if (ctx.mode === 'offline') {
      notVerified.push({ check: mod.CHECK, reason: 'skipped: offline mode' });
      continue;
    }
    if (isLocal && mod.CHECK === 'repo-metadata') {
      notVerified.push({ check: mod.CHECK, reason: 'local folder: rerun on owner/repo for repository metadata' });
      continue;
    }
    try {
      const res = await mod.run(input, ctx);
      signals.push(...res.signals);
      notVerified.push(...res.notVerified);
    } catch (e) {
      notVerified.push({ check: mod.CHECK, reason: `check failed: ${sanitizeEvidence(e && e.message ? e.message : e)}` });
    }
  }
  return { signals, notVerified };
}
