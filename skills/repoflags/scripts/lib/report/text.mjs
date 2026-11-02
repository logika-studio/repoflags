// Console rendering of the report. Colors only when the caller says so (TTY / NO_COLOR decided by the CLI).
import { DISCLAIMER, OUTCOME_TEXT, OUTCOME_JSON } from '../constants.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

const COLORS = { high: '\u001b[31m', medium: '\u001b[33m', info: '\u001b[36m', bold: '\u001b[1m', reset: '\u001b[0m' };

export function renderText(report, { color = false } = {}) {
  const paint = (code, text) => (color ? `${COLORS[code]}${text}${COLORS.reset}` : text);
  const t = report.target;
  const lines = [];
  lines.push(paint('bold', `repoflags ${report.tool.version} - ${sanitizeEvidence(t.name)}`));
  lines.push(DISCLAIMER);
  lines.push(`Target: ${t.type}  SHA: ${t.sha ?? 'n/a'}  Mode: ${report.mode}  Rules: ${report.rulesVersion}  At: ${report.analyzedAt}`);
  if (report.config) {
    const c = report.config;
    const off = c.disabledRules.length ? c.disabledRules.join(', ') : 'none';
    const changed = Object.entries(c.thresholds).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
    lines.push(`Config: user config loaded; disabled rules: ${off}; changed thresholds: ${changed}`);
  }
  lines.push('');
  lines.push(`Outcome: ${report.outcome === OUTCOME_JSON.found ? OUTCOME_TEXT.found : OUTCOME_TEXT.none}`);

  for (const sev of ['high', 'medium', 'info']) {
    const group = report.signals.filter((s) => s.severity === sev);
    if (!group.length) continue;
    lines.push('');
    lines.push(paint(sev, sev.toUpperCase()));
    for (const s of group) {
      const where = s.file ? `${s.file}${s.line ? `:${s.line}` : ''}` : '-';
      lines.push(`  [${s.id}] ${s.rule}  ${where}  ${s.title}`);
      lines.push(`      ${s.evidence}`);
    }
  }

  lines.push('');
  lines.push('Not verified');
  for (const n of report.notVerified) lines.push(`  - ${n.check}: ${n.reason}`);
  if (report.limits.reached.length) lines.push('', `limits reached: ${report.limits.reached.join(', ')}`);
  const hosts = Object.entries(report.network.hosts).map(([h, n]) => `${h}=${n}`);
  lines.push(report.limits.reached.length ? `network: ${hosts.join(', ') || 'none'}` : `\nnetwork: ${hosts.join(', ') || 'none'}`);
  return `${lines.join('\n')}\n`;
}
