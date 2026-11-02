// Line scanning with a hard timeout. `node:vm` is used ONLY as a timer: no repository code enters the context.
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';

export function splitLines(text, maxLineLength) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => (l.length > maxLineLength ? l.slice(0, maxLineLength) : l));
}

// Constant script: patterns and lines enter as context variables, never interpolated into code.
// `out` lives in the context so that the matches found before a timeout survive it (review CR-03).
const SCRIPT = new vm.Script(`
(function () {
  const compiled = patterns.map((p) => ({ id: p.id, re: new RegExp(p.source, p.flags) }));
  for (let i = 0; i < lines.length; i++) {
    for (const c of compiled) {
      const m = c.re.exec(lines[i]);
      if (m) out.push({ id: c.id, line: i + 1, column: m.index + 1, text: lines[i], groups: Array.from(m) });
    }
  }
})()
`);

// Every findLines run inside withScanBudget is counted when it times out, without each rule having to know
// about it: the pipeline turns any stopped scan into a signal (review CR-03).
const scope = new AsyncLocalStorage();

/**
 * Runs `fn` (synchronous) with a scan deadline (epoch ms).
 * @returns {{result: any, timeouts: number, exhausted: boolean}} timeouts = scans stopped by a time limit
 */
export function withScanBudget(deadline, fn) {
  const state = { deadline, timeouts: 0, exhausted: false };
  const result = scope.run(state, fn);
  return { result, timeouts: state.timeouts, exhausted: state.exhausted };
}

const copy = (out) => out.map((m) => ({
  id: String(m.id), line: m.line, column: m.column, text: String(m.text), groups: Array.from(m.groups, String),
}));

/**
 * @param {string[]} lines
 * @param {{id: string, source: string, flags?: string}[]} patterns
 * @returns {{matches: {id:string,line:number,column:number,text:string,groups:string[]}[], timedOut: boolean}}
 *   on timeout, `matches` holds what was found before the timer fired
 */
export function findLines(lines, patterns, timeoutMs) {
  const budget = scope.getStore();
  let limit = timeoutMs;
  if (budget) {
    // Cumulative budget of the rules phase (review WR-08): clamp to the deadline, stop at once past it.
    const left = Math.floor(budget.deadline - Date.now());
    if (left <= 0) {
      budget.timeouts += 1;
      budget.exhausted = true;
      return { matches: [], timedOut: true };
    }
    limit = Math.min(timeoutMs, left);
  }
  const out = [];
  const ctx = vm.createContext({
    lines: lines.slice(),
    patterns: patterns.map((p) => ({ id: p.id, source: p.source, flags: (p.flags ?? '').replace(/[gy]/g, '') })),
    out,
  });
  try {
    SCRIPT.runInContext(ctx, { timeout: limit });
    // Copy into main-realm objects (vm results belong to another realm).
    return { matches: copy(out), timedOut: false };
  } catch (e) {
    if (!e || e.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
    if (budget) {
      budget.timeouts += 1;
      if (limit < timeoutMs) budget.exhausted = true;
    }
    // Partial result: matches up to the line being scanned when the timer fired.
    return { matches: copy(out), timedOut: true };
  }
}
