// Runs every rule module; a failing rule becomes a notVerified entry and never aborts the report.
import * as npmrc from './npmrc.mjs';
import * as configFiles from './config-files.mjs';
import * as editor from './editor.mjs';
import * as lifecycle from './lifecycle.mjs';
import * as agents from './agents.mjs';
import * as depSpecs from './dep-specs.mjs';
import * as pmConfig from './pm-config.mjs';
import * as installExtras from './install-extras.mjs';
import * as aiConfig from './ai-config.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

export const RULE_MODULES = [npmrc, configFiles, editor, lifecycle, agents, depSpecs, pmConfig, installExtras, aiConfig];

export function runRules(files, ctx, modules = RULE_MODULES) {
  const signals = [];
  const notVerified = [];
  for (const mod of modules) {
    try {
      const res = mod.detect(files, ctx);
      signals.push(...res.signals);
      notVerified.push(...res.notVerified);
    } catch (e) {
      const msg = sanitizeEvidence(e && e.message ? e.message : e);
      notVerified.push({ check: mod.RULE, reason: `rule failed: ${msg}` });
      // The input that made a rule throw is chosen by the repository author: it must never end in
      // "no signals found" (fail-open class, REP-02).
      signals.push({
        rule: 'rule-failed', severity: 'medium', title: 'A check could not complete on this repository content',
        file: null, line: null, evidence: sanitizeEvidence(`${mod.RULE}: ${msg}`), refs: [],
      });
    }
  }
  return { signals, notVerified };
}
