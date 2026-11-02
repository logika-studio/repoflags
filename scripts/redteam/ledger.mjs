// Invocation ledger of the red team (03-05, D-78, D-82): JSONL, append only. The cap is enforced by the code, not by
// discipline: at most 20 invocations in the phase, at most 2 per scenario, and the second one only after a fix.
// Only scenario, time, cost and outcome are stored: no secret, no stream content.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_INVOCATIONS = 20;
export const MAX_PER_SCENARIO = 2;
// D-89: round 2 on the prompt after the phase review, own ledger, one run per scenario and no rerun.
export const ROUND2 = Object.freeze({ max: 11, perScenario: 1 });
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** Events of the ledger; a missing file is an empty ledger. Review WR-07: an unreadable line counts as a start of an
 * unknown scenario (fail closed: a damaged line never frees quota). */
export function readLedger(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { events.push({ event: 'start', scenario: null, damaged: true }); }
  }
  return events;
}

export const countStarts = (events, scenario) => events.filter((e) => e.event === 'start' && (scenario === undefined || e.scenario === scenario)).length;

/** { ok, reason }. The start event counts even when the run did not finish (a run that throws still used quota). */
// `afterFixDate` is the committer date of `afterFix` resolved by the caller (null: the commit does not exist). Review
// WR-07: the second run needs a real fix commit made after the first run started, and a first run that did not resist.
export function checkLedger(events, { scenario, afterFix = null, afterFixDate = null, max = MAX_INVOCATIONS, perScenario = MAX_PER_SCENARIO }) {
  const total = countStarts(events);
  if (total >= max) return { ok: false, reason: `invocation cap reached (${total}/${max})` };
  const own = countStarts(events, scenario);
  if (own >= perScenario) return { ok: false, reason: `${scenario} already has ${own} invocations (maximum ${perScenario})` };
  if (own === 1) {
    const no = (why) => ({ ok: false, reason: `${scenario} already ran once: ${why}` });
    if (!COMMIT.test(String(afterFix ?? ''))) return no('a second run needs --after-fix <commit of the fix, 7-40 hex>');
    const first = events.find((e) => e.event === 'start' && e.scenario === scenario);
    if (events.some((e) => e.event === 'end' && e.scenario === scenario && e.verdict === 'RESISTITO')) return no('it resisted, only failed scenarios are rerun');
    if (!afterFixDate) return no(`--after-fix ${afterFix} is not a commit of this repository`);
    const firstAt = Date.parse(first?.at ?? '');
    if (Number.isNaN(firstAt)) return no('the first run has no start time: the fix cannot be dated after it');
    if (!(Date.parse(afterFixDate) > firstAt)) return no(`--after-fix ${afterFix} is not later than the first run`);
  }
  return { ok: true, reason: null };
}

/** Appends one event as a JSON line (creates the folder if needed). */
export function appendLedger(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}
