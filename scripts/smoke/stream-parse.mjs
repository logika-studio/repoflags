// Parsing and evaluation of a `claude -p --output-format stream-json` stream (smoke, 02-07).
// Field names follow the smoke research (assumption A1): confirm them on the first real stream.
// Also the tools that delegate (a subagent can run Bash) or edit in bulk (review CR-B-10).
import path from 'node:path';

export const FORBIDDEN_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];
const FORBIDDEN = new Set(FORBIDDEN_TOOLS);
const READERS = new Set(['Read', 'Grep', 'Glob']);

/** One normal form for every path comparison (review CR-03, IN-06): forward slashes, no long-path or device prefix,
 * `.` and `..` resolved, lower case, no trailing slash. */
export const normPath = (p) => path.posix.normalize(String(p).replace(/\\/g, '/').replace(/^\/\/[?.]\//, ''))
  .toLowerCase().replace(/\/+$/, '');
/** True when `p` is `dir` or below it, after normPath on both. */
export const insidePath = (p, dir) => typeof p === 'string' && Boolean(dir)
  && (normPath(p) === normPath(dir) || normPath(p).startsWith(`${normPath(dir)}/`));
/** True when a path holds a `..` segment before normalization (a way around a lexical inside check). */
export const hasDotDot = (p) => typeof p === 'string' && p.split(/[\\/]/).includes('..');

/** Read/Grep/Glob calls whose path points inside `dir` (a manual read of the analyzed repository, G5). */
export function manualReads(parsed, dir) {
  if (!dir) return [];
  return parsed.toolUses.filter((t) => READERS.has(t.name) && [t.input?.file_path, t.input?.path, t.input?.pattern].some((p) => insidePath(p, dir)));
}
export const SHELLS = new Set(['Bash', 'PowerShell']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Never throws: lines that are not JSON are counted and skipped. */
export function parseStream(text) {
  const out = {
    init: null, toolUses: [], toolResults: {}, permissionDenials: [], deniedEvents: [], sawResult: false,
    resultSubtype: null, isError: false, costUsd: null, resultText: '', badLines: 0,
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { out.badLines += 1; continue; }
    if (!ev || typeof ev !== 'object') { out.badLines += 1; continue; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.init = { model: ev.model ?? null, tools: ev.tools ?? [], skills: ev.skills ?? null, plugins: ev.plugins ?? null };
    } else if (ev.type === 'system' && ev.subtype === 'permission_denied') {
      out.deniedEvents.push({ tool_name: ev.tool_name ?? null, tool_use_id: ev.tool_use_id ?? null });
    } else if (ev.type === 'assistant') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of content) if (b && b.type === 'tool_use') out.toolUses.push({ id: b.id ?? null, name: b.name, input: b.input ?? {} });
    } else if (ev.type === 'user') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of content) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          out.toolResults[b.tool_use_id] = { text: resultText(b.content), isError: b.is_error === true };
        }
      }
    } else if (ev.type === 'result') {
      out.sawResult = true;
      out.resultSubtype = typeof ev.subtype === 'string' ? ev.subtype : null;
      out.isError = ev.is_error === true;
      out.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
      out.permissionDenials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
      out.resultText = typeof ev.result === 'string' ? ev.result : '';
    }
  }
  return out;
}

/** Text of a tool_result content: a string, or an array of { type: 'text', text } blocks. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
  return '';
}

const OUTCOMES = new Set(['signals_found', 'no_signals_found_by_these_rules']);

/** True when `text` holds one JSON object (possibly after a tool prefix) whose `outcome` is a real outcome. */
export function hasReport(text) {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to < from) return false;
  try {
    const obj = JSON.parse(text.slice(from, to + 1));
    return Boolean(obj) && OUTCOMES.has(obj.outcome);
  } catch { return false; }
}

/** Expected single command: Run 1 remote slug, Run 2 the materialized folder (either path separator). The target is
 * single-quoted exactly as in SKILL.md (review CR-B-01). */
export function expectedCommand(run, dir) {
  // No `$` in the path: an unexpanded ${CLAUDE_SKILL_DIR} is a script that never started (review CR-B-08).
  const head = 'node "[^"$]*repoflags\\.mjs" ';
  if (run === 1) return new RegExp(`^${head}'octocat/Hello-World' --format json$`);
  if (run === 2) {
    const p = escapeRe(dir).replace(/\\\\|\//g, '[\\\\/]');
    return new RegExp(`^${head}'${p}' --format json$`);
  }
  return null;
}

const no = (reason) => ({ verdict: 'NON VERIFICATO', reason });

/** One entry per denied call (result.permission_denials and system/permission_denied, deduplicated by tool_use_id):
 * the denied shell command, or null when the call was not a shell command. */
export function deniedCommands(parsed) {
  const byId = new Map(parsed.toolUses.map((t) => [t.id, t]));
  const seen = new Set();
  const out = [];
  const add = (id, name, input) => {
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    out.push(SHELLS.has(name) && typeof input?.command === 'string' ? input.command : null);
  };
  for (const d of parsed.permissionDenials) add(d?.tool_use_id ?? null, d?.tool_name, d?.tool_input ?? byId.get(d?.tool_use_id)?.input);
  for (const d of parsed.deniedEvents) add(d.tool_use_id, d.tool_name, byId.get(d.tool_use_id)?.input);
  return out;
}

// Run 3 (English answer, the prompt asks for it). A destructive step counts only when it is not negated (review CR-B-09).
const DESTROY = '(?:format|wipe|reinstall)';
const NEGATED = new RegExp(`\\b(?:do not|don't|never)\\s+${DESTROY}(?:\\s*(?:,|or|and)\\s*${DESTROY})*\\b`, 'g');
// Smoke 2 Run 3: «Wipe and reinstall the machine only after this» defers the step; same clause only (no , ; . ! ?).
const DEFERRED = new RegExp(`\\b${DESTROY}(?:\\s*(?:,|or|and)\\s*${DESTROY})*\\b[^.!?,;\\n]{0,30}\\bonly after\\b`, 'g');

function firstSteps(text) {
  const t = String(text).toLowerCase();
  if (new RegExp(`\\b${DESTROY}\\b`).test(t.replace(NEGATED, ' ').replace(DEFERRED, ' '))) return no('answer suggests format, wipe or reinstall without a negation');
  const miss = [
    [/\b(?:disconnect|network|offline)\b/, 'isolation'],
    [/\b(?:do not|don't|never)\s+(?:format|wipe)\b/, 'do not format'],
    [/\b(?:different|another|other|separate|uncompromised)\b[\w ,-]{0,30}\bdevice\b/, 'different device'],
  ].filter(([re]) => !re.test(t)).map(([, n]) => n);
  return miss.length ? no(`answer lacks: ${miss.join(', ')}`) : { verdict: 'VERIFICATO', reason: 'skill activated, no shell tool; first steps present' };
}

export function evaluateRun(run, parsed, { expected, exitCode, targetDir } = {}) {
  if (!parsed.sawResult) return no('no result event: stream truncated or claude ended early');
  if (parsed.resultSubtype !== 'success' || parsed.isError) return no(`result not successful (${parsed.resultSubtype ?? 'no subtype'})`);
  if (exitCode !== undefined && exitCode !== 0) return no(`claude exit code ${exitCode}`);
  const shell = parsed.toolUses.filter((t) => SHELLS.has(t.name));
  const denials = deniedCommands(parsed);
  if (denials.length) {
    const matched = run !== 3 && denials.every((c) => c !== null && expected?.test(c));
    // Review CR-B-07: the expected command denied by `dontAsk` is not the same failure as a wrong command.
    if (matched) return no('denied by design, command matched (pre-approve it with --allow-script-rule)');
    return no(`${denials.length} permission denial(s)`);
  }
  const bad = parsed.toolUses.filter((t) => FORBIDDEN.has(t.name));
  if (bad.length) return no(`forbidden tool used: ${bad.map((t) => t.name).join(', ')}`);
  const reads = manualReads(parsed, targetDir);
  if (reads.length) return no(`G5: ${reads.length} manual read(s) of the target folder (${reads.map((t) => t.name).join(', ')})`);
  // The Skill input field is `skill` (A1, confirmed on the real stream); a mention elsewhere is not an activation.
  const skill = parsed.toolUses.some((t) => t.name === 'Skill' && t.input?.skill === 'repoflags');
  if (!skill) return no('no skill activation with skill "repoflags"');
  if (run === 3) {
    if (shell.length) return no(`${shell.length} shell tool call(s), expected none`);
    return firstSteps(parsed.resultText);
  }
  if (shell.length !== 1) return no(`${shell.length} shell tool call(s), expected exactly 1`);
  // Policy (review CR-B-20): one Bash OR one PowerShell call, with exactly the expected command.
  if (!expected?.test(String(shell[0].input.command ?? ''))) return no('command does not match the expected single command');
  const out = parsed.toolResults[shell[0].id];
  if (!out || !hasReport(out.text)) return no('the command produced no JSON report with a valid outcome');
  return { verdict: 'VERIFICATO', reason: 'skill activated, one matching Bash, no denials, JSON report with outcome' };
}

/** Markdown section for the install smoke measurement. */
export function renderSmokeSection(run, { prompt, parsed, evaluation, model, status }) {
  const cmds = parsed.toolUses.length ? parsed.toolUses.map((t) => `- ${t.name}: \`${t.input.command ?? JSON.stringify(t.input)}\``).join('\n') : '- none';
  return [
    `## Run ${run}`, '',
    '- Session: not an isolated session (global CLAUDE.md and personal skills may be loaded)',
    `- Prompt: ${prompt}`, `- Status: ${status}`, `- Model: ${model ?? parsed.init?.model ?? 'N/D'}`,
    `- Cost (total_cost_usd): ${parsed.costUsd ?? 'N/D'}`,
    `- permission_denials: ${parsed.permissionDenials.length} ${JSON.stringify(parsed.permissionDenials)}`,
    `- Init (skills/plugins): ${JSON.stringify({ skills: parsed.init?.skills ?? null, plugins: parsed.init?.plugins ?? null })}`,
    `- Outcome: ${evaluation.verdict} (${evaluation.reason})`, '', 'Observed tool calls:', cmds, '',
  ].join('\n');
}
